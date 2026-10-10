import { ProviderError, RouteError } from './errors.mjs'

/**
 * Picks a provider for a request and runs it, honouring the user's rules.
 *
 * Eligibility, in order:
 *   - provider is enabled and not an unverified placeholder
 *   - it lists the requested capability
 *   - sensitive requests only go to local providers (or ones the user marked
 *     `allowSensitive`) — never silently to an external service
 *   - paid providers need `confirmSpend: true` on the request
 *   - providers in cooldown after a retryable failure are skipped
 *
 * Fallback only happens between providers that are both eligible and have not
 * opted out with `allowFallback: false`, and only after a *retryable* failure.
 * An auth or bad-request error is the user's to fix, so it is returned as-is.
 * If nothing succeeds the real attempts are reported; a result is never
 * invented.
 */
export function createRouter({ registry, health, audit, clock = Date.now, cooldownMs = 30_000 }) {
  const cooldown = new Map() // id -> until (ms)
  // In-memory metrics per provider: calls, successes, latency, tokens and (when the config has a price) estimated spend.
  const stats = new Map()
  const note = (p, ok, latencyMs, usage) => {
    const s = stats.get(p.id) ?? { provider: p.id, calls: 0, ok: 0, failed: 0, latencyMs: 0, inputTokens: 0, outputTokens: 0, estUSD: 0 }
    s.calls++
    if (ok) { s.ok++; s.latencyMs += latencyMs ?? 0 } else s.failed++
    s.inputTokens += usage?.inputTokens ?? 0
    s.outputTokens += usage?.outputTokens ?? 0
    if (p.price) s.estUSD += ((usage?.inputTokens ?? 0) * p.price.in + (usage?.outputTokens ?? 0) * p.price.out) / 1e6
    stats.set(p.id, s)
  }
  const snapshotStats = () => [...stats.values()].map((s) => ({ ...s, avgLatencyMs: s.ok ? Math.round(s.latencyMs / s.ok) : null, successRate: s.calls ? +(s.ok / s.calls).toFixed(2) : null, estUSD: +s.estUSD.toFixed(4) }))
  // An empty account will not refill in a minute: keep it out of rotation for 10 min, so traffic flows to the next provider.
  const SKIPPABLE = new Set(['auth', 'model_not_found', 'bad_response', 'unconfigured'])
  const coolFor = (e) => (e.kind === 'quota' ? 10 * 60_000 : e.kind === 'auth' ? 5 * 60_000 : cooldownMs)

  /**
   * Paid providers are simply left out of a request the owner has not authorised to spend money on, so a local model
   * keeps answering for free. Only when NOTHING free is left does the call stop with the "not confirmed" error.
   */
  const spendFilter = (list, req, attempts) => {
    if (req.confirmSpend) return list
    const free = list.filter((p) => !p.paid)
    for (const p of list.filter((x) => x.paid)) attempts.push({ provider: p.id, skipped: 'paid provider: needs "autorizo gasto"' })
    if (free.length === 0) {
      audit?.record('ai.route.blocked', { providers: list.map((p) => p.id), reason: 'spend-not-confirmed' })
      throw new RouteError('blocked: this call spends tokens and was not confirmed', attempts)
    }
    return free
  }

  const eligible = (req) => {
    const out = []
    const skipped = []
    for (const p of registry.list()) {
      const why =
        !p.enabled ? 'disabled'
        : p.type === 'unverified' ? 'integration not verified'
        : !p.capabilities.includes(req.capability) ? `no ${req.capability} capability`
        : req.sensitive && p.external && !p.allowSensitive ? 'sensitive data not allowed to leave this machine'
        : (cooldown.get(p.id) ?? 0) > clock() ? 'cooling down after a failure'
        : null
      if (why) skipped.push({ provider: p.id, skipped: why })
      else out.push(p)
    }
    if (req.providerId) {
      const only = out.filter((p) => p.id === req.providerId)
      return { list: only, skipped }
    }
    // req.tier prefers cheap or strong providers first; the others stay behind them as fallback.
    const rank = (p) => (req.tier && p.tier !== req.tier ? 1 : 0)
    return { list: out.sort((a, b) => rank(a) - rank(b) || a.priority - b.priority), skipped }
  }

  /** Validation + provider selection shared by run and runStream. */
  function prepare(request) {
    const req = { capability: 'chat', sensitive: false, confirmSpend: false, ...request }
    if (req.messages !== undefined) {
      const m = req.messages
      const limit = req.messageLimit ?? 8000
      const valid =
        Array.isArray(m) && m.length > 0 && m.length <= 40 && m.at(-1).role === 'user' &&
        m.every((x) => (x?.role === 'user' || x?.role === 'assistant') && typeof x.content === 'string' && x.content.length > 0 && x.content.length <= limit)
      if (!valid) throw new ProviderError('bad_request', 'messages must be 1-40 user/assistant turns ending with a user turn (<= limit chars each)')
      req.prompt = m.at(-1).content // used for triage and audit length only
    }
    if (!req.prompt || typeof req.prompt !== 'string') {
      throw new ProviderError('bad_request', 'prompt must be a non-empty string')
    }
    const { list, skipped } = eligible(req)
    const attempts = [...skipped]
    if (list.length === 0) {
      audit?.record('ai.route.none', { capability: req.capability, sensitive: req.sensitive, skipped })
      throw new RouteError('no eligible provider for this request', attempts)
    }
    const usable = spendFilter(list, req, attempts)
    return { req, usable, attempts }
  }

  async function run(request) {
    const { req, usable, attempts } = prepare(request)

    for (const p of usable) {
      const model = req.model ?? p.defaultModel
      if (!model) {
        attempts.push({ provider: p.id, skipped: 'no model configured' })
        continue
      }
      try {
        const out = await p.adapter.infer({ model, prompt: req.prompt, messages: req.messages, system: req.system, maxTokens: req.maxTokens })
        audit?.record('ai.infer', { provider: p.id, model, ok: true, promptChars: req.prompt.length, latencyMs: out.latencyMs })
        note(p, true, out.latencyMs, out.usage)
        attempts.push({ provider: p.id, ok: true })
        return { ...out, attempts }
      } catch (err) {
        const e = err instanceof ProviderError ? err : new ProviderError('network', String(err?.message ?? err), { provider: p.id })
        health?.pushError(p.id, e)
        note(p, false)
        if (e.retryable || SKIPPABLE.has(e.kind)) cooldown.set(p.id, clock() + coolFor(e))
        attempts.push({ provider: p.id, error: e.toJSON() })
        audit?.record('ai.infer', { provider: p.id, model, ok: false, kind: e.kind, promptChars: req.prompt.length })
        // A missing/expired key, a wrong model or an empty answer is THIS provider's problem: the next one still answers.
        if ((!e.retryable && !SKIPPABLE.has(e.kind)) || !p.allowFallback) throw new RouteError(`${p.id} failed: ${e.message}`, attempts)
      }
    }
    const last = [...attempts].reverse().find((a) => a.error)?.error
    throw new RouteError(last && attempts.filter((a) => a.error).length === 1 ? `${last.provider} failed: ${last.message}` : 'all eligible providers failed', attempts)
  }

  /**
   * Same selection and failover as `run`, but tokens are handed over as they arrive:
   *   { start, provider, model }  once, with the first text  ->  { delta } ...  ->  { done, usage, attempts, provider, model }
   * Failover only happens BEFORE the first token (nothing was shown yet). If a provider dies mid-answer the caller gets
   * { error, partial: true } and keeps what it already has; a different model never silently continues a sentence.
   * Providers without a `stream` method answer in one piece. Breaking out of the loop (or aborting req.signal) cancels the HTTP call.
   */
  async function* runStream(request) {
    const { req, usable, attempts } = prepare(request)
    const t0 = clock()
    for (const p of usable) {
      const model = req.model ?? p.defaultModel
      if (!model) {
        attempts.push({ provider: p.id, skipped: 'no model configured' })
        continue
      }
      if (attempts.some((a) => a.error) && clock() - t0 > (req.deadlineMs ?? 240_000)) {
        attempts.push({ provider: p.id, skipped: 'tempo total esgotado' })
        break
      }
      let started = false
      let usage
      const call = { model, prompt: req.prompt, messages: req.messages, system: req.system, maxTokens: req.maxTokens, signal: req.signal }
      try {
        if (typeof p.adapter.stream === 'function') {
          for await (const ev of p.adapter.stream(call)) {
            if (ev.delta) {
              if (!started) { started = true; yield { start: true, provider: p.id, model } }
              yield { delta: ev.delta }
            } else if (ev.usage) usage = ev.usage
          }
          if (!started) throw new ProviderError('bad_response', 'stream ended without any text', { provider: p.id })
        } else {
          const out = await p.adapter.infer(call)
          started = true
          usage = out.usage
          yield { start: true, provider: p.id, model: out.model ?? model }
          yield { delta: out.text }
        }
        audit?.record('ai.infer', { provider: p.id, model, ok: true, stream: true, promptChars: req.prompt.length })
        note(p, true, clock() - t0, usage)
        attempts.push({ provider: p.id, ok: true })
        yield { done: true, usage, attempts, provider: p.id, model }
        return
      } catch (err) {
        if (req.signal?.aborted) throw new RouteError('cancelled', attempts) // the caller left: never start another provider
        const e = err instanceof ProviderError ? err : new ProviderError('network', String(err?.message ?? err), { provider: p.id })
        health?.pushError(p.id, e)
        note(p, false)
        if (e.retryable || SKIPPABLE.has(e.kind)) cooldown.set(p.id, clock() + coolFor(e))
        attempts.push({ provider: p.id, error: e.toJSON() })
        audit?.record('ai.infer', { provider: p.id, model, ok: false, stream: true, kind: e.kind, promptChars: req.prompt.length })
        if (started) { yield { error: e.toJSON(), partial: true, attempts }; return }
        if ((!e.retryable && !SKIPPABLE.has(e.kind)) || !p.allowFallback) throw new RouteError(`${p.id} failed: ${e.message}`, attempts)
      }
    }
    const last = [...attempts].reverse().find((a) => a.error)?.error
    throw new RouteError(last && attempts.filter((a) => a.error).length === 1 ? `${last.provider} failed: ${last.message}` : 'all eligible providers failed', attempts)
  }
  /**
   * Ask a decision provider (capability "decision", e.g. Jev) structured
   * questions about some content. Same gates as `run`; never falls back to a
   * text generator, because a probability is not a sentence.
   */
  async function decide(request) {
    const req = { sensitive: false, confirmSpend: false, ...request, capability: 'decision' }
    if (req.state == null || !req.questions || Object.keys(req.questions).length === 0) {
      throw new ProviderError('bad_request', 'state and at least one question are required')
    }
    const { list, skipped } = eligible(req)
    const attempts = [...skipped]
    if (list.length === 0) throw new RouteError('no eligible decision provider', attempts)
    const usable = spendFilter(list, req, attempts)
    for (const p of usable) {
      const model = req.model ?? p.defaultModel
      if (!model || typeof p.adapter.decide !== 'function') {
        attempts.push({ provider: p.id, skipped: model ? 'adapter cannot decide' : 'no model configured' })
        continue
      }
      try {
        const out = await p.adapter.decide({ model, state: req.state, questions: req.questions })
        audit?.record('ai.decide', { provider: p.id, model, ok: true, questions: Object.keys(req.questions).length, latencyMs: out.latencyMs })
        return { ...out, attempts: [...attempts, { provider: p.id, ok: true }] }
      } catch (err) {
        const e = err instanceof ProviderError ? err : new ProviderError('network', String(err?.message ?? err), { provider: p.id })
        health?.pushError(p.id, e)
        if (e.retryable || SKIPPABLE.has(e.kind)) cooldown.set(p.id, clock() + coolFor(e))
        attempts.push({ provider: p.id, error: e.toJSON() })
        audit?.record('ai.decide', { provider: p.id, model, ok: false, kind: e.kind })
        // A missing/expired key, a wrong model or an empty answer is THIS provider's problem: the next one still answers.
        if ((!e.retryable && !SKIPPABLE.has(e.kind)) || !p.allowFallback) throw new RouteError(`${p.id} failed: ${e.message}`, attempts)
      }
    }
    throw new RouteError('all eligible decision providers failed', attempts)
  }

  const CAPABILITY_HELP = {
    chat: 'General conversation, questions, explanations, summaries, writing.',
    coding: 'Writing, reading, debugging or reviewing source code.',
    reasoning: 'Multi-step analysis, planning or maths that needs careful thinking.',
  }

  /**
   * Generation with an optional decision step in front. If a decision provider
   * is eligible and more than one generator capability exists, it classifies
   * the prompt and the request is routed to the winning capability. The
   * decision is advisory: if it is unavailable, fails, or is not confident
   * enough, routing falls back to the plain `run` default and says so in
   * `routing`. The prompt is sent to the decision provider only when it passes
   * the same sensitivity and spend gates as any other external call.
   */
  async function smartRun(request, { minConfidence = 0.6 } = {}) {
    const req = { sensitive: false, ...request }
    if (Array.isArray(req.messages) && !req.prompt) req.prompt = req.messages.at(-1)?.content
    const caps = new Set()
    for (const p of registry.list()) {
      const ok = p.enabled && p.type !== 'unverified' && !p.capabilities.includes('decision') && !(req.sensitive && p.external && !p.allowSensitive)
      if (ok) for (const c of p.capabilities) caps.add(c)
    }
    // Unpinned requests default to chat, or to the only capability available.
    if (!req.capability) req.capability = caps.has('chat') || caps.size === 0 ? 'chat' : [...caps][0]
    const routing = { decider: null, choice: null, confidence: null, skipped: null }
    if (caps.size < 2) routing.skipped = 'fewer than two generator capabilities'
    else if (!req.confirmSpend) routing.skipped = 'spend not confirmed'
    else {
      const criteria = Object.fromEntries([...caps].map((c) => [c, CAPABILITY_HELP[c] ?? c]))
      try {
        const d = await decide({
          state: req.prompt,
          sensitive: req.sensitive,
          confirmSpend: true,
          questions: { task: { type: 'choice', instructions: 'Which kind of work does this request need?', criteria } },
        })
        const a = d.answers.task
        routing.decider = d.provider
        routing.choice = a.choice
        routing.confidence = a.confidence
        if (a.confidence >= minConfidence) req.capability = a.choice
        else routing.skipped = `confidence ${a.confidence.toFixed(2)} below ${minConfidence}; used default`
      } catch (err) {
        routing.skipped = `decision unavailable: ${err?.message ?? err}`
      }
    }
    const out = await run(req)
    return { ...out, routing }
  }

  return { run, runStream, decide, smartRun, eligible, stats: snapshotStats }
}
