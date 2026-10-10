import { ProviderError } from '../errors.mjs'
import { raiseForStatus, request } from '../http.mjs'

/**
 * Google Gemini (Generative Language API, v1beta). Contract checked against Google's public
 * discovery document: `GET /v1beta/models`, `POST /v1beta/{model}:generateContent` with
 * `contents[{role, parts[{text}]}]`, `systemInstruction`, `generationConfig`; usage in
 * `usageMetadata`. The key goes in the `x-goog-api-key` header, never in the URL, so it cannot
 * end up in logs or error messages.
 */
export function geminiProvider(cfg, { fetch: fetchImpl = fetch, env = process.env } = {}) {
  const baseUrl = (cfg.baseUrl ?? 'https://generativelanguage.googleapis.com/v1beta').replace(/\/+$/, '')
  const keyName = cfg.apiKeyEnv ?? 'GEMINI_API_KEY'
  const key = () => env[keyName] || ''
  const headers = () => ({ 'x-goog-api-key': key(), 'content-type': 'application/json' })
  const bare = (name) => String(name).replace(/^models\//, '')

  return {
    id: cfg.id,
    type: 'gemini',

    async probe() {
      const res = await request(fetchImpl, `${baseUrl}/models?pageSize=200`, {
        headers: key() ? headers() : {},
        timeoutMs: cfg.timeoutMs ?? 8000,
        provider: cfg.id,
      })
      const endpoint = { state: 'ok', latencyMs: res.latencyMs }
      if (!key()) return { endpoint, auth: { state: 'fail', detail: `${keyName} is not set` }, models: null }
      if ([400, 401, 403].includes(res.status)) return { endpoint, auth: { state: 'fail', detail: `rejected (HTTP ${res.status})` }, models: null }
      raiseForStatus(res, cfg.id)
      if (!Array.isArray(res.json?.models)) throw new ProviderError('bad_response', 'GET /models did not return {models: [...]}', { provider: cfg.id })
      return { endpoint, auth: { state: 'ok' }, models: res.json.models.map((m) => bare(m.name)) }
    },

    async infer({ model, prompt, messages, system, maxTokens = 512 }) {
      if (!key()) throw new ProviderError('auth', `${keyName} is not set`, { provider: cfg.id })
      const turns = messages ?? [{ role: 'user', content: prompt }]
      const body = {
        contents: turns.map((m) => ({ role: m.role === 'assistant' ? 'model' : 'user', parts: [{ text: m.content }] })),
        generationConfig: { maxOutputTokens: maxTokens },
      }
      if (system) body.systemInstruction = { parts: [{ text: system }] }
      const res = await request(fetchImpl, `${baseUrl}/models/${encodeURIComponent(bare(model))}:generateContent`, {
        method: 'POST',
        headers: headers(),
        body: JSON.stringify(body),
        timeoutMs: cfg.inferTimeoutMs ?? 60000,
        provider: cfg.id,
      })
      raiseForStatus(res, cfg.id)
      const cand = res.json?.candidates?.[0]
      const text = (cand?.content?.parts ?? []).map((p) => p.text ?? '').join('')
      if (!text) {
        const why = res.json?.promptFeedback?.blockReason ?? cand?.finishReason
        throw new ProviderError('bad_response', `no text in reply${why ? ` (${why})` : ''}`, { provider: cfg.id })
      }
      return {
        text,
        model: res.json?.modelVersion ?? model,
        provider: cfg.id,
        latencyMs: res.latencyMs,
        usage: { inputTokens: res.json?.usageMetadata?.promptTokenCount, outputTokens: res.json?.usageMetadata?.candidatesTokenCount },
      }
    },
  }
}
