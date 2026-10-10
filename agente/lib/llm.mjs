// Client for the JARVIS router (OpenAI-compatible, native tool calling) at http://127.0.0.1:8787/v1.
// The agent never holds an API key: the app's router owns them, rotates models and fails over between providers.
import { readFileSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..', '..')

export class LlmError extends Error {
  constructor(message, { status, retryable = false } = {}) { super(message); this.status = status; this.retryable = retryable }
}

/** Where the JARVIS app keeps the router key (installed app, dev copy). The env var wins. */
export function tokenFiles(env = process.env) {
  const f = []
  if (env.JARVIS_DATA_DIR) f.push(join(env.JARVIS_DATA_DIR, 'router-token.txt'))
  if (env.APPDATA) f.push(join(env.APPDATA, 'J.A.R.V.I.S', 'data', 'router-token.txt'))
  f.push(join(ROOT, 'data', 'router-token.txt'))
  return f
}
export function readToken(env = process.env, files = tokenFiles(env)) {
  if (env.JARVIS_ROUTER_TOKEN && env.JARVIS_ROUTER_TOKEN.trim().length >= 16) return env.JARVIS_ROUTER_TOKEN.trim()
  for (const f of files) { try { const t = readFileSync(f, 'utf8').trim(); if (t.length >= 32) return t } catch { /* next */ } }
  return null
}

export function createLlm({ port = Number(process.env.JARVIS_BRIDGE_PORT) || 8787, token = readToken(), model = 'auto', host = '127.0.0.1' } = {}) {
  const base = `http://${host}:${port}/v1`

  async function* once({ messages, tools, signal, maxTokens, toolChoice }) {
      token ??= readToken()
      let res
      try {
        res = await fetch(`${base}/chat/completions`, {
          method: 'POST', signal,
          headers: { 'content-type': 'application/json', authorization: `Bearer ${token}` },
          body: JSON.stringify({ model, messages, stream: true, max_tokens: maxTokens, ...(tools?.length ? { tools, tool_choice: toolChoice ?? 'auto' } : {}) }),
        })
      } catch (e) {
        if (signal?.aborted) throw new LlmError('cancelado')
        throw new LlmError(`não consegui falar com o JARVIS (${e.cause?.code ?? e.message})`, { retryable: true })
      }
      if (!res.ok) {
        const t = await res.text().catch(() => '')
        let msg = t.slice(0, 400)
        try { msg = JSON.parse(t).error?.message ?? msg } catch { /* plain text */ }
        throw new LlmError(msg || `HTTP ${res.status}`, { status: res.status, retryable: res.status >= 500 && res.status !== 501 || res.status === 429 })
      }
      let text = '', finishReason = null, usage = null, used = null
      const calls = []
      const dec = new TextDecoder()
      let buf = ''
      let started = false
      for await (const chunk of res.body) {
        buf += dec.decode(chunk, { stream: true })
        let i
        while ((i = buf.search(/\r?\n\r?\n/)) !== -1) {
          const block = buf.slice(0, i); buf = buf.slice(i).replace(/^\r?\n\r?\n/, '')
          const data = block.split(/\r?\n/).filter((l) => l.startsWith('data:')).map((l) => l.slice(5).trimStart()).join('\n')
          if (!data || data === '[DONE]') continue
          let ev
          try { ev = JSON.parse(data) } catch { continue }
          if (ev.error) { const err = new LlmError(String(ev.error.message ?? 'erro do provedor').slice(0, 400), { retryable: !started }); err.started = started; throw err }
          used = ev.model ?? used
          const ch = ev.choices?.[0]
          const d = ch?.delta ?? {}
          if (typeof d.content === 'string' && d.content) { started = true; text += d.content; yield { delta: d.content } }
          for (const tc of d.tool_calls ?? []) { started = true; const k = tc.index ?? calls.length; calls[k] = { id: tc.id, type: 'function', function: { name: tc.function.name, arguments: tc.function.arguments }, ...(tc.thoughtSignature ? { thoughtSignature: tc.thoughtSignature } : {}) } }
          if (ch?.finish_reason) finishReason = ch.finish_reason
          if (ev.usage) usage = ev.usage
        }
      }
      const tool_calls = calls.filter(Boolean)
      yield { done: true, finishReason: finishReason ?? 'stop', usage, model: used, message: { role: 'assistant', content: text || (tool_calls.length ? null : ''), ...(tool_calls.length ? { tool_calls } : {}) } }
  }
  return {
    base,
    get model() { return model },
    setModel(m) { model = m },
    async ready() {
      token ??= readToken()
      if (!token) return { ok: false, error: 'Não achei a chave do roteador do JARVIS. Abra o app J.A.R.V.I.S. ao menos uma vez (ele a cria) ou defina JARVIS_ROUTER_TOKEN.' }
      try {
        const r = await fetch(`${base}/models`, { headers: { authorization: `Bearer ${token}` }, signal: AbortSignal.timeout(3000) })
        if (r.status === 401) return { ok: false, error: 'O JARVIS recusou a chave do roteador. Abra a tela IAs do app e confira.' }
        if (!r.ok) return { ok: false, error: `O JARVIS respondeu ${r.status}.` }
        const j = await r.json()
        return { ok: true, models: (j.data ?? []).map((m) => m.id) }
      } catch { return { ok: false, error: `O app J.A.R.V.I.S. não está aberto (porta ${port}). Abra-o e ligue ao menos uma API na tela IAs.` } }
    },

    /**
     * Streams one assistant turn. Yields { delta } as text arrives and, last, { done, message, finishReason, usage, model }.
     * `message` is the OpenAI assistant message (content + tool_calls) ready to append to the history.
     */
    async *chat({ messages, tools, signal, maxTokens = 8192, toolChoice }) {
      let lastErr
      for (let attempt = 0; attempt < 3; attempt++) {
        if (signal?.aborted) throw new LlmError('cancelado')
        try {
          yield* once({ messages, tools, signal, maxTokens, toolChoice })
          return
        } catch (e) {
          lastErr = e
          if (signal?.aborted || !(e instanceof LlmError) || !e.retryable || e.started) throw e
          await new Promise((r) => setTimeout(r, 1500 * (attempt + 1)))
        }
      }
      throw lastErr
    },

  }
}
