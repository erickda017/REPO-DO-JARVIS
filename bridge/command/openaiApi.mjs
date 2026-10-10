import { randomBytes, timingSafeEqual } from 'node:crypto'
import { mkdir, readFile, writeFile } from 'node:fs/promises'
import { dirname } from 'node:path'
import { RouteError } from './errors.mjs'

const BODY_LIMIT = 2 * 1024 * 1024

/**
 * An OpenAI-compatible door into the JARVIS router, so ANY program that can talk to an OpenAI-style endpoint (the
 * owner's own coding agent, scripts, editors) gets the same provider failover: when one account runs out of quota the
 * next one answers and the work continues.
 *
 *   POST /v1/chat/completions   (plain, or stream:true = real token-by-token SSE)
 *   GET  /v1/models
 *
 * Loopback only (the bridge is never exposed), a bearer token is required, and paid providers are used only when the
 * owner switched "routerSpend" on. Function calling (tools) is not translated: plain text completions only.
 */
export function createOpenAiApi({ router, registry, file, flags, audit }) {
  let token = null
  let pending = null
  const loadToken = () => (pending ??= readToken())
  const readToken = async () => {
    if (token) return token
    try {
      token = (await readFile(file, 'utf8')).trim()
    } catch { /* first use */ }
    if (!token || token.length < 32) {
      token = 'jv-' + randomBytes(24).toString('hex')
      if (file) {
        await mkdir(dirname(file), { recursive: true })
        await writeFile(file, token, { mode: 0o600 })
      }
    }
    return token
  }

  const send = (res, status, body, extra = {}) => {
    res.writeHead(status, { 'content-type': 'application/json', 'cache-control': 'no-store', ...extra })
    res.end(JSON.stringify(body))
  }
  const err = (res, status, message, type = 'invalid_request_error') => send(res, status, { error: { message, type } })

  async function readBody(req) {
    let size = 0
    const chunks = []
    for await (const c of req) {
      size += c.length
      if (size > BODY_LIMIT) throw Object.assign(new Error('body too large'), { status: 413 })
      chunks.push(c)
    }
    try {
      return JSON.parse(Buffer.concat(chunks).toString('utf8'))
    } catch {
      throw Object.assign(new Error('body must be JSON'), { status: 400 })
    }
  }

  const authorised = async (req) => {
    const m = /^Bearer\s+(.+)$/i.exec(req.headers.authorization ?? '')
    if (!m) return false
    const a = Buffer.from(m[1].trim()), b = Buffer.from(await loadToken())
    return a.length === b.length && timingSafeEqual(a, b)
  }

  /** Flatten any message content into text (clients may send [{type:'text',text}] parts). */
  const text = (c) => (typeof c === 'string' ? c : Array.isArray(c) ? c.map((p) => (typeof p === 'string' ? p : p?.text ?? '')).join('') : '')

  async function toolChat(b, msgs, req, res) {
    const ctrl = new AbortController()
    res.on('close', () => ctrl.abort())
    const request = {
      messages: msgs, tools: Array.isArray(b.tools) ? b.tools.slice(0, 128) : undefined, toolChoice: b.tool_choice,
      maxTokens: Math.min(Number(b.max_tokens ?? b.max_completion_tokens) || 4096, 16384), confirmSpend: flags.get('routerSpend') === true,
      providerId: registry.get(String(b.model)) ? String(b.model) : undefined, fast: true, signal: ctrl.signal,
    }
    const id = 'chatcmpl-' + randomBytes(8).toString('hex')
    const created = Math.floor(Date.now() / 1000)
    const it = router.chatStream(request)[Symbol.asyncIterator]()
    let first = await it.next() // a failure before any output becomes a normal HTTP error
    let model = 'jarvis/auto'
    const tail = (ev) => {
      const u = ev.usage ?? {}
      return { usage: { prompt_tokens: u.inputTokens ?? 0, completion_tokens: u.outputTokens ?? 0, total_tokens: (u.inputTokens ?? 0) + (u.outputTokens ?? 0) } }
    }
    try {
      if (b.stream === true) {
        res.writeHead(200, { 'content-type': 'text/event-stream', 'cache-control': 'no-store', 'x-accel-buffering': 'no' })
        const chunk = (delta, finish = null, extra = {}) => res.write(`data: ${JSON.stringify({ id, object: 'chat.completion.chunk', created, model, choices: [{ index: 0, delta, finish_reason: finish }], ...extra })}\n\n`)
        for (let ev = first; !ev.done; ev = await it.next()) {
          const v = ev.value
          if (v.start) { model = `${v.provider}/${v.model}`; chunk({ role: 'assistant', content: '' }) }
          else if (v.delta) chunk({ content: v.delta })
          else if (v.error) { res.write(`data: ${JSON.stringify({ error: { message: v.error.message, type: 'provider_error' } })}\n\n`); chunk({}, 'error') }
          else if (v.done) {
            if (v.toolCalls.length) chunk({ tool_calls: v.toolCalls.map((c, index) => ({ index, ...c })) })
            chunk({}, v.finishReason, tail(v))
            audit?.record('router.openai', { provider: v.provider, model: v.model, ok: true, stream: true, tools: true })
          }
        }
        res.end('data: [DONE]\n\n')
        return
      }
      let text = '', done = null
      for (let ev = first; !ev.done; ev = await it.next()) {
        const v = ev.value
        if (v.start) model = `${v.provider}/${v.model}`
        else if (v.delta) text += v.delta
        else if (v.error) throw Object.assign(new Error(v.error.message), { status: 502 })
        else if (v.done) done = v
      }
      audit?.record('router.openai', { provider: done.provider, model: done.model, ok: true, tools: true })
      send(res, 200, { id, object: 'chat.completion', created, model, choices: [{ index: 0, message: { role: 'assistant', content: text || null, ...(done.toolCalls.length ? { tool_calls: done.toolCalls } : {}) }, finish_reason: done.finishReason }], ...tail(done) }, { 'x-jarvis-provider': done.provider })
    } catch (e) {
      if (res.headersSent) { if (!ctrl.signal.aborted) res.write(`data: ${JSON.stringify({ error: { message: String(e?.message ?? e).slice(0, 300), type: 'provider_error' } })}\n\n`); res.end('data: [DONE]\n\n') }
      else throw e
    } finally {
      await it.return?.()
    }
  }

  return {
    token: loadToken,
    async handle(req, res) {
      const path = (req.url ?? '').split('?')[0]
      if (!path.startsWith('/v1/')) return false
      if (!(await authorised(req))) {
        err(res, 401, 'invalid or missing bearer token (see the IAs screen of the JARVIS app)', 'authentication_error')
        return true
      }
      try {
        if (req.method === 'GET' && path === '/v1/models') {
          const data = [{ id: 'auto', object: 'model', owned_by: 'jarvis-router' }, ...registry.list().filter((p) => p.enabled && p.type !== 'unverified' && !p.capabilities.includes('decision') && !(!p.external && flags.get('apisOnly') === true)).map((p) => ({ id: p.id, object: 'model', owned_by: p.id, jarvis: { local: !p.external, paid: p.paid } }))] // "APIs only" hides the local model here too
          send(res, 200, { object: 'list', data })
          return true
        }
        if (req.method === 'POST' && path === '/v1/chat/completions') {
          const b = await readBody(req)
          const msgs = Array.isArray(b.messages) ? b.messages : []
          if (!msgs.length) return err(res, 400, 'messages is required'), true
          // Native function calling (tools / tool_calls / tool messages): passed through, with the same failover and spend gate.
          if ((Array.isArray(b.tools) && b.tools.length) || msgs.some((m) => m.role === 'tool' || m.tool_calls)) {
            await toolChat(b, msgs, req, res)
            return true
          }
          const system = msgs.filter((m) => m.role === 'system').map((m) => text(m.content)).join('\n\n') || undefined
          let turns = msgs.filter((m) => m.role !== 'system').map((m) => ({ role: m.role === 'assistant' ? 'assistant' : 'user', content: text(m.content) || '(vazio)' }))
          if (turns.at(-1)?.role !== 'user') turns = [...turns, { role: 'user', content: 'Continue.' }]
          turns = turns.slice(-40)
          while (turns.length > 1 && turns[0].role !== 'user') turns.shift() // some APIs reject a conversation that starts with the assistant
          const req0 = { messages: turns, messageLimit: 200_000, system: system?.slice(0, 200_000), maxTokens: Math.min(Number(b.max_tokens ?? b.max_completion_tokens) || 1024, 8192), confirmSpend: flags.get('routerSpend') === true, providerId: registry.get(String(b.model)) ? String(b.model) : undefined }
          const id = 'chatcmpl-' + randomBytes(8).toString('hex')
          const created = Math.floor(Date.now() / 1000)
          if (b.stream === true) {
            // Real streaming: tokens go out as the provider produces them. Failover still works until the first token.
            const ctrl = new AbortController()
            res.on('close', () => ctrl.abort()) // the client left: cancel the upstream call too
            const open = async (capability) => {
              const it = router.runStream({ ...req0, capability, signal: ctrl.signal })[Symbol.asyncIterator]()
              return { it, first: await it.next() }
            }
            let s
            try {
              s = await open('coding')
            } catch (e) {
              if (!(e instanceof RouteError) || e.attempts.some((a) => a.error)) {
                if (e instanceof RouteError && !/no eligible/.test(e.message)) throw e
              }
              s = await open('chat')
            }
            res.writeHead(200, { 'content-type': 'text/event-stream', 'cache-control': 'no-store', 'x-accel-buffering': 'no' })
            const chunk = (delta, finish = null, extra = {}) => res.write(`data: ${JSON.stringify({ id, object: 'chat.completion.chunk', created, model, choices: [{ index: 0, delta, finish_reason: finish }], ...extra })}\n\n`)
            let model = 'jarvis/auto'
            let ev = s.first
            try {
              while (!ev.done) {
                const v = ev.value
                if (v.start) { model = `${v.provider}/${v.model}`; chunk({ role: 'assistant', content: '' }) }
                else if (v.delta) chunk({ content: v.delta })
                else if (v.error) { res.write(`data: ${JSON.stringify({ error: { message: v.error.message, type: 'provider_error' } })}\n\n`); chunk({}, 'error') }
                else if (v.done) {
                  const u = v.usage ?? {}
                  chunk({}, 'stop', { usage: { prompt_tokens: u.inputTokens ?? 0, completion_tokens: u.outputTokens ?? 0, total_tokens: (u.inputTokens ?? 0) + (u.outputTokens ?? 0) } })
                  audit?.record('router.openai', { provider: v.provider, model: v.model, ok: true, stream: true })
                }
                ev = await s.it.next()
              }
            } catch (e) {
              if (!ctrl.signal.aborted) res.write(`data: ${JSON.stringify({ error: { message: String(e?.message ?? e).slice(0, 300), type: 'provider_error' } })}\n\n`)
            } finally {
              await s.it.return?.()
            }
            res.end('data: [DONE]\n\n')
            return true
          }
          let out
          try {
            out = await router.run({ ...req0, capability: 'coding' })
          } catch (e) {
            // No coding-capable provider eligible (or all failed): fall back to general chat providers.
            if (!(e instanceof RouteError) || e.attempts.some((a) => a.error)) {
              if (e instanceof RouteError && !/no eligible/.test(e.message)) throw e
            }
            out = await router.run({ ...req0, capability: 'chat' })
          }
          audit?.record('router.openai', { provider: out.provider, model: out.model, ok: true })
          const usage = { prompt_tokens: out.usage?.inputTokens ?? 0, completion_tokens: out.usage?.outputTokens ?? 0, total_tokens: (out.usage?.inputTokens ?? 0) + (out.usage?.outputTokens ?? 0) }
          const model = `${out.provider}/${out.model}`
          send(res, 200, { id, object: 'chat.completion', created, model, choices: [{ index: 0, message: { role: 'assistant', content: out.text }, finish_reason: 'stop' }], usage }, { 'x-jarvis-provider': out.provider })
          return true
        }
        err(res, 404, 'unsupported endpoint', 'not_found_error')
        return true
      } catch (e) {
        const status = e.status ?? (e.kind === 'bad_request' ? 400 : e instanceof RouteError ? (/blocked/.test(e.message) ? 402 : 502) : 500)
        err(res, status, String(e?.message ?? e).slice(0, 300), e instanceof RouteError ? 'provider_error' : 'server_error')
        return true
      }
    },
  }
}
