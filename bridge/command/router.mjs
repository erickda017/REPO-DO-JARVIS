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
    return { list: out.sort((a, b) => a.priority - b.priority), skipped }
  }

  async function run(request) {
    const req = { capability: 'chat', sensitive: false, confirmSpend: false, ...request }
    if (!req.prompt || typeof req.prompt !== 'string') {
      throw new ProviderError('bad_request', 'prompt must be a non-empty string')
    }
    const { list, skipped } = eligible(req)
    const attempts = [...skipped]
    if (list.length === 0) {
      audit?.record('ai.route.none', { capability: req.capability, sensitive: req.sensitive, skipped })
      throw new RouteError('no eligible provider for this request', attempts)
    }

    for (const p of list) {
      if (p.paid && !req.confirmSpend) {
        attempts.push({ provider: p.id, skipped: 'paid provider: confirmSpend required' })
        audit?.record('ai.route.blocked', { provider: p.id, reason: 'spend-not-confirmed' })
        throw new RouteError('blocked: this call spends tokens and was not confirmed', attempts)
      }
      const model = req.model ?? p.defaultModel
      if (!model) {
        attempts.push({ provider: p.id, skipped: 'no model configured' })
        continue
      }
      try {
        const out = await p.adapter.infer({ model, prompt: req.prompt, system: req.system, maxTokens: req.maxTokens })
        audit?.record('ai.infer', { provider: p.id, model, ok: true, promptChars: req.prompt.length, latencyMs: out.latencyMs })
        attempts.push({ provider: p.id, ok: true })
        return { ...out, attempts }
      } catch (err) {
        const e = err instanceof ProviderError ? err : new ProviderError('network', String(err?.message ?? err), { provider: p.id })
        health?.pushError(p.id, e)
        if (e.retryable) cooldown.set(p.id, clock() + cooldownMs)
        attempts.push({ provider: p.id, error: e.toJSON() })
        audit?.record('ai.infer', { provider: p.id, model, ok: false, kind: e.kind, promptChars: req.prompt.length })
        if (!e.retryable || !p.allowFallback) throw new RouteError(`${p.id} failed: ${e.message}`, attempts)
      }
    }
    throw new RouteError('all eligible providers failed', attempts)
  }

  return { run, eligible }
}
