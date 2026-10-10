import { ProviderError } from '../errors.mjs'
import { raiseForStatus, request, sse } from '../http.mjs'

/**
 * Google Gemini (Generative Language API, v1beta). Contract checked against Google's public
 * discovery document: `GET /v1beta/models`, `POST /v1beta/{model}:generateContent` with
 * `contents[{role, parts[{text}]}]`, `systemInstruction`, `generationConfig`; usage in
 * `usageMetadata`. The key goes in the `x-goog-api-key` header, never in the URL, so it cannot
 * end up in logs or error messages.
 */
/**
 * "Thinking" models spend seconds reasoning before the first word. The agent only needs a JSON action, so the
 * thinking is turned down: budget 0 on 2.5 Flash/Flash-Lite, level "low" on the 3.x family. Models that refuse the field
 * (HTTP 400 naming it) are remembered and retried without it, so a wrong guess costs one request, once.
 */
const noThinking = new Set()
export function thinkingFor(model) {
  const m = String(model).replace(/^models\//, '')
  if (noThinking.has(m)) return null
  if (/^gemini-2\.5-flash/.test(m)) return { thinkingBudget: 0 }
  if (/^gemini-([3-9]|\d{2,})/.test(m)) return { thinkingLevel: 'low' }
  return null
}
const refusedThinking = (e) => e instanceof ProviderError && e.kind === 'bad_request' && /think/i.test(e.message)

export function geminiProvider(cfg, { fetch: fetchImpl = fetch, env = process.env } = {}) {
  const baseUrl = (cfg.baseUrl ?? 'https://generativelanguage.googleapis.com/v1beta').replace(/\/+$/, '')
  const keyName = cfg.apiKeyEnv ?? 'GEMINI_API_KEY'
  const key = () => env[keyName] || ''
  const headers = () => ({ 'x-goog-api-key': key(), 'content-type': 'application/json' })
  const bare = (name) => String(name).replace(/^models\//, '')
  const bodyFor = ({ model, prompt, messages, system, maxTokens }) => {
    const turns = messages ?? [{ role: 'user', content: prompt }]
    const generationConfig = { maxOutputTokens: maxTokens }
    const thinking = thinkingFor(model)
    if (thinking) generationConfig.thinkingConfig = thinking
    const body = { contents: turns.map((m) => ({ role: m.role === 'assistant' ? 'model' : 'user', parts: [{ text: m.content }] })), generationConfig }
    if (system) body.systemInstruction = { parts: [{ text: system }] }
    return body
  }

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

    async *stream(req) {
      if (!key()) throw new ProviderError('auth', `${keyName} is not set`, { provider: cfg.id })
      const { model, maxTokens = 512, signal } = req
      for (let attempt = 0; ; attempt++) {
        let started = false
        try {
          for await (const ev of sse(fetchImpl, `${baseUrl}/models/${encodeURIComponent(bare(model))}:streamGenerateContent?alt=sse`, { headers: headers(), body: JSON.stringify(bodyFor({ ...req, maxTokens })), idleTimeoutMs: cfg.inferTimeoutMs ?? 60000, provider: cfg.id, signal })) {
            const t = (ev.candidates?.[0]?.content?.parts ?? []).filter((p) => !p.thought).map((p) => p.text ?? '').join('')
            if (t) { started = true; yield { delta: t } }
            if (ev.usageMetadata?.candidatesTokenCount) yield { usage: { inputTokens: ev.usageMetadata.promptTokenCount, outputTokens: ev.usageMetadata.candidatesTokenCount } }
          }
          return
        } catch (err) {
          if (!started && attempt === 0 && thinkingFor(model) && refusedThinking(err)) { noThinking.add(bare(model)); continue }
          throw err
        }
      }
    },

    async infer(req) {
      if (!key()) throw new ProviderError('auth', `${keyName} is not set`, { provider: cfg.id })
      const { model, maxTokens = 512 } = req
      let res
      for (let attempt = 0; ; attempt++) {
        res = await request(fetchImpl, `${baseUrl}/models/${encodeURIComponent(bare(model))}:generateContent`, {
          method: 'POST',
          headers: headers(),
          body: JSON.stringify(bodyFor({ ...req, maxTokens })),
          timeoutMs: cfg.inferTimeoutMs ?? 60000,
          provider: cfg.id,
        })
        try {
          raiseForStatus(res, cfg.id)
          break
        } catch (err) {
          if (attempt === 0 && thinkingFor(model) && refusedThinking(err)) { noThinking.add(bare(model)); continue }
          throw err
        }
      }
      const cand = res.json?.candidates?.[0]
      const text = (cand?.content?.parts ?? []).filter((p) => !p.thought).map((p) => p.text ?? '').join('')
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
