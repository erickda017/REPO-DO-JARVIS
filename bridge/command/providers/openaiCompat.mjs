import { ProviderError } from '../errors.mjs'
import { request, raiseForStatus, sse } from '../http.mjs'

/**
 * Adapter for any server that *actually* speaks `GET {base}/models` and
 * `POST {base}/chat/completions` in the OpenAI wire format.
 *
 * Nothing is assumed about which services do: you opt a provider into this type
 * in the config only after confirming its docs, and `probe()` will say so
 * plainly if the answers do not look like that format. The key is optional so
 * keyless local servers work.
 */
export function openaiCompatProvider(cfg, { fetch: fetchImpl = fetch, env = process.env } = {}) {
  if (!cfg.baseUrl && !cfg.editableUrl) throw new ProviderError('unconfigured', `provider ${cfg.id}: baseUrl is required`)
  // Read on every call: an editableUrl provider (a Colab tunnel) gets a new address while the bridge keeps running.
  const base = () => {
    if (!cfg.baseUrl) throw new ProviderError('unconfigured', `${cfg.id}: cole o endereço (URL) atual na tela IAs`, { provider: cfg.id })
    return cfg.baseUrl.replace(/\/+$/, '')
  }
  const keyName = cfg.apiKeyEnv
  const timeoutMs = cfg.timeoutMs ?? 8000
  const key = () => (keyName ? env[keyName] || '' : '')
  const headers = () => ({
    'content-type': 'application/json',
    ...(key() ? { authorization: `Bearer ${key()}` } : {}),
  })

  return {
    id: cfg.id,
    type: 'openai-compat',

    async probe() {
      const res = await request(fetchImpl, `${base()}/models`, { headers: headers(), timeoutMs, provider: cfg.id })
      const endpoint = { state: 'ok', latencyMs: res.latencyMs }
      if (keyName && !key()) {
        return { endpoint, auth: { state: 'fail', detail: `${keyName} is not set` }, models: null }
      }
      if (res.status === 401 || res.status === 403) {
        return { endpoint, auth: { state: 'fail', detail: `rejected (HTTP ${res.status})` }, models: null }
      }
      raiseForStatus(res, cfg.id)
      if (!Array.isArray(res.json?.data)) {
        throw new ProviderError('bad_response', 'GET /models did not return {data: [...]}; not OpenAI-compatible?', {
          provider: cfg.id,
        })
      }
      const auth = keyName ? { state: 'ok' } : { state: 'unknown', detail: 'no key configured; server accepted anonymous request' }
      return { endpoint, auth, models: res.json.data.map((m) => m.id).filter(Boolean) }
    },

    /** Token by token: yields { delta } and, when the server reports it, a final { usage }. */
    async *stream({ model, prompt, messages: history, system, maxTokens = 512, signal }) {
      const messages = [...(system ? [{ role: 'system', content: system }] : []), ...(history ?? [{ role: 'user', content: prompt }])]
      for await (const ev of sse(fetchImpl, `${base()}/chat/completions`, { headers: headers(), body: JSON.stringify({ model, messages, stream: true, [cfg.tokenParam ?? 'max_tokens']: maxTokens }), idleTimeoutMs: cfg.inferTimeoutMs ?? 120000, provider: cfg.id, signal })) {
        if (ev.error) throw new ProviderError('bad_response', String(ev.error.message ?? 'stream error').slice(0, 160), { provider: cfg.id })
        const d = ev.choices?.[0]?.delta?.content ?? ev.choices?.[0]?.message?.content
        if (typeof d === 'string' && d) yield { delta: d }
        if (ev.usage) yield { usage: { inputTokens: ev.usage.prompt_tokens, outputTokens: ev.usage.completion_tokens } }
      }
    },

    /**
     * Native tool calling (OpenAI format). `messages` are sent as they are (system / user / assistant with tool_calls /
     * tool); yields { delta } for text, { tick } for any other sign of life, { usage }, and at the end
     * { done, toolCalls: [{ id, type, function: { name, arguments } }], finishReason }.
     */
    async *chat({ model, messages, tools, toolChoice, maxTokens = 4096, signal }) {
      const clean = messages.map((m) => (m.tool_calls ? { ...m, tool_calls: m.tool_calls.map(({ id, type, function: fn }) => ({ id, type: type ?? 'function', function: fn })) } : m))
      const body = { model, messages: clean, stream: true, [cfg.tokenParam ?? 'max_tokens']: maxTokens }
      if (tools?.length) { body.tools = tools; if (toolChoice) body.tool_choice = toolChoice }
      const calls = []
      let finishReason = null
      for await (const ev of sse(fetchImpl, `${base()}/chat/completions`, { headers: headers(), body: JSON.stringify(body), idleTimeoutMs: cfg.inferTimeoutMs ?? 120000, provider: cfg.id, signal })) {
        if (ev.error) throw new ProviderError('bad_response', String(ev.error.message ?? 'stream error').slice(0, 160), { provider: cfg.id })
        const ch = ev.choices?.[0]
        const d = ch?.delta ?? ch?.message ?? {}
        if (typeof d.content === 'string' && d.content) yield { delta: d.content }
        for (const tc of d.tool_calls ?? []) {
          const i = tc.index ?? calls.length
          const c = (calls[i] ??= { id: '', type: 'function', function: { name: '', arguments: '' } })
          if (tc.id) c.id = tc.id
          if (tc.function?.name) c.function.name += tc.function.name
          if (tc.function?.arguments) c.function.arguments += typeof tc.function.arguments === 'string' ? tc.function.arguments : JSON.stringify(tc.function.arguments)
          yield { tick: true }
        }
        if (ch?.finish_reason) finishReason = ch.finish_reason
        if (ev.usage) yield { usage: { inputTokens: ev.usage.prompt_tokens, outputTokens: ev.usage.completion_tokens } }
      }
      const toolCalls = calls.filter((c) => c?.function?.name).map((c, i) => ({ ...c, id: c.id || `call_${i}_${Math.random().toString(36).slice(2, 10)}`, function: { name: c.function.name, arguments: c.function.arguments || '{}' } }))
      yield { done: true, toolCalls, finishReason: toolCalls.length ? 'tool_calls' : (finishReason ?? 'stop') }
    },

    async infer({ model, prompt, messages: history, system, maxTokens = 512 }) {
      const messages = [...(system ? [{ role: 'system', content: system }] : []), ...(history ?? [{ role: 'user', content: prompt }])]
      const res = await request(fetchImpl, `${base()}/chat/completions`, {
        method: 'POST',
        headers: headers(),
        // OpenAI's newer models reject `max_tokens`; local servers and OpenRouter still take it.
        body: JSON.stringify({ model, messages, [cfg.tokenParam ?? 'max_tokens']: maxTokens }),
        timeoutMs: cfg.inferTimeoutMs ?? 120000,
        provider: cfg.id,
      })
      raiseForStatus(res, cfg.id)
      const text = res.json?.choices?.[0]?.message?.content
      if (typeof text !== 'string' || !text) {
        throw new ProviderError('bad_response', 'no choices[0].message.content in reply', { provider: cfg.id })
      }
      return {
        text,
        model: res.json?.model ?? model,
        provider: cfg.id,
        latencyMs: res.latencyMs,
        usage: { inputTokens: res.json?.usage?.prompt_tokens, outputTokens: res.json?.usage?.completion_tokens },
      }
    },
  }
}
