import { ProviderError } from '../errors.mjs'
import { request, raiseForStatus, sse } from '../http.mjs'

/**
 * Anthropic Messages API adapter (https://api.anthropic.com by default).
 *
 * This key is separate from the Claude Code login the bridge's own brain uses.
 * It only matters when you want Claude to be one *provider* among several in
 * the router. With no key the provider reports `auth: missing` and is skipped.
 */
export function anthropicProvider(cfg, { fetch: fetchImpl = fetch, env = process.env } = {}) {
  const baseUrl = (cfg.baseUrl ?? 'https://api.anthropic.com').replace(/\/+$/, '')
  const keyName = cfg.apiKeyEnv ?? 'ANTHROPIC_API_KEY'
  const timeoutMs = cfg.timeoutMs ?? 8000
  const key = () => env[keyName] || ''
  const headers = () => ({
    'x-api-key': key(),
    'anthropic-version': '2023-06-01',
    'content-type': 'application/json',
  })

  return {
    id: cfg.id,
    type: 'anthropic',

    /**
     * One request answers three questions. Any HTTP reply proves the endpoint;
     * a 200 with a key proves auth; the model list answers availability.
     * Without a key we still probe, unauthenticated, so "unreachable" and
     * "reachable but no key" stay distinguishable.
     */
    async probe() {
      const res = await request(fetchImpl, `${baseUrl}/v1/models?limit=100`, {
        headers: key() ? headers() : { 'anthropic-version': '2023-06-01' },
        timeoutMs,
        provider: cfg.id,
      })
      const endpoint = { state: 'ok', latencyMs: res.latencyMs }
      if (!key()) return { endpoint, auth: { state: 'fail', detail: `${keyName} is not set` }, models: null }
      if (res.status === 401 || res.status === 403) {
        return { endpoint, auth: { state: 'fail', detail: `rejected (HTTP ${res.status})` }, models: null }
      }
      raiseForStatus(res, cfg.id)
      const models = (res.json?.data ?? []).map((m) => m.id).filter(Boolean)
      return { endpoint, auth: { state: 'ok' }, models }
    },

    async *stream({ model, prompt, messages, system, maxTokens = 512, signal }) {
      if (!key()) throw new ProviderError('auth', `${keyName} is not set`, { provider: cfg.id })
      const body = { model, max_tokens: maxTokens, stream: true, messages: messages ?? [{ role: 'user', content: prompt }] }
      if (system) body.system = system
      let inputTokens
      for await (const ev of sse(fetchImpl, `${baseUrl}/v1/messages`, { headers: headers(), body: JSON.stringify(body), idleTimeoutMs: cfg.inferTimeoutMs ?? 60000, provider: cfg.id, signal })) {
        if (ev.type === 'error') throw new ProviderError(/overloaded/i.test(ev.error?.type) ? 'server' : 'bad_response', String(ev.error?.message ?? 'stream error').slice(0, 160), { provider: cfg.id })
        if (ev.type === 'message_start') inputTokens = ev.message?.usage?.input_tokens
        if (ev.type === 'content_block_delta' && ev.delta?.type === 'text_delta' && ev.delta.text) yield { delta: ev.delta.text }
        if (ev.type === 'message_delta' && ev.usage) yield { usage: { inputTokens, outputTokens: ev.usage.output_tokens } }
      }
    },

    async infer({ model, prompt, messages, system, maxTokens = 512 }) {
      if (!key()) throw new ProviderError('auth', `${keyName} is not set`, { provider: cfg.id })
      const body = { model, max_tokens: maxTokens, messages: messages ?? [{ role: 'user', content: prompt }] }
      if (system) body.system = system
      const res = await request(fetchImpl, `${baseUrl}/v1/messages`, {
        method: 'POST',
        headers: headers(),
        body: JSON.stringify(body),
        timeoutMs: cfg.inferTimeoutMs ?? 60000,
        provider: cfg.id,
      })
      raiseForStatus(res, cfg.id)
      const text = (res.json?.content ?? [])
        .filter((b) => b?.type === 'text')
        .map((b) => b.text)
        .join('')
      if (!text) throw new ProviderError('bad_response', 'no text content in reply', { provider: cfg.id })
      return {
        text,
        model: res.json?.model ?? model,
        provider: cfg.id,
        latencyMs: res.latencyMs,
        usage: { inputTokens: res.json?.usage?.input_tokens, outputTokens: res.json?.usage?.output_tokens },
      }
    },
  }
}
