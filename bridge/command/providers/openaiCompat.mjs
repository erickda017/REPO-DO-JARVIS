import { ProviderError } from '../errors.mjs'
import { request, raiseForStatus } from '../http.mjs'

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
  if (!cfg.baseUrl) throw new ProviderError('unconfigured', `provider ${cfg.id}: baseUrl is required`)
  const baseUrl = cfg.baseUrl.replace(/\/+$/, '')
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
      const res = await request(fetchImpl, `${baseUrl}/models`, { headers: headers(), timeoutMs, provider: cfg.id })
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

    async infer({ model, prompt, messages: history, system, maxTokens = 512 }) {
      const messages = [...(system ? [{ role: 'system', content: system }] : []), ...(history ?? [{ role: 'user', content: prompt }])]
      const res = await request(fetchImpl, `${baseUrl}/chat/completions`, {
        method: 'POST',
        headers: headers(),
        body: JSON.stringify({ model, messages, max_tokens: maxTokens }),
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
