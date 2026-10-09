import { ProviderError } from '../errors.mjs'
import { request, raiseForStatus } from '../http.mjs'

/**
 * TypeSafe "Jev" (System One) adapter.
 *
 * Contract taken from the public OpenAPI document at
 * https://api.typesafe.ai/openapi.json (v0.2.0):
 *   GET  /v1/models      Bearer auth -> { models: [{name, description, release_date}] }
 *   POST /v1/systemone   { state, model, questions: { name: Question } }
 *                        -> { model, answers: { name: Answer }, usage }
 * Question types: noul (yes/no probability), choice, score.
 *
 * This is a *decision* model, not a text generator: it answers structured
 * questions about some content with probabilities. It therefore exposes
 * `decide()` and no `infer()`, and carries the `decision` capability only.
 */
const bad = (id, msg) => new ProviderError('bad_response', msg, { provider: id })
const inUnit = (n) => typeof n === 'number' && Number.isFinite(n) && n >= -1e-9 && n <= 1 + 1e-9

/** Check one answer against the question that produced it. Throws bad_response. */
function validateAnswer(id, name, q, a) {
  if (!a || typeof a !== 'object' || a.type !== q.type) throw bad(id, `answer "${name}" is missing or has the wrong type`)
  if (q.type === 'noul') {
    if (!inUnit(a.noul)) throw bad(id, `answer "${name}": noul must be a number in [0,1]`)
  } else if (q.type === 'choice') {
    if (!Object.hasOwn(q.criteria ?? {}, a.choice)) throw bad(id, `answer "${name}": choice is not one of the requested options`)
    if (!inUnit(a.confidence)) throw bad(id, `answer "${name}": confidence must be in [0,1]`)
  } else if (q.type === 'score') {
    const top = (q.criteria?.length ?? 1) - 1
    if (typeof a.score !== 'number' || !Number.isFinite(a.score) || a.score < -1e-9 || a.score > top + 1e-9) {
      throw bad(id, `answer "${name}": score is outside the rubric`)
    }
    if (!inUnit(a.confidence)) throw bad(id, `answer "${name}": confidence must be in [0,1]`)
  }
}

export function jevProvider(cfg, { fetch: fetchImpl = fetch, env = process.env } = {}) {
  const baseUrl = (cfg.baseUrl ?? 'https://api.typesafe.ai').replace(/\/+$/, '')
  const keyName = cfg.apiKeyEnv ?? 'TYPESAFE_API_KEY'
  const timeoutMs = cfg.timeoutMs ?? 8000
  const key = () => env[keyName] || ''
  const headers = () => ({ authorization: `Bearer ${key()}`, 'content-type': 'application/json' })

  return {
    id: cfg.id,
    type: 'typesafe-jev',

    async probe() {
      // Without a key we can still tell "reachable" from "down": /v1/models
      // answers 401/403 to an anonymous caller.
      const res = await request(fetchImpl, `${baseUrl}/v1/models`, {
        headers: key() ? headers() : {},
        timeoutMs,
        provider: cfg.id,
      })
      const endpoint = { state: 'ok', latencyMs: res.latencyMs }
      if (!key()) return { endpoint, auth: { state: 'fail', detail: `${keyName} is not set` }, models: null }
      if (res.status === 401 || res.status === 403) {
        return { endpoint, auth: { state: 'fail', detail: `rejected (HTTP ${res.status})` }, models: null }
      }
      raiseForStatus(res, cfg.id)
      if (!Array.isArray(res.json?.models)) throw bad(cfg.id, 'GET /v1/models did not return {models: [...]}')
      return { endpoint, auth: { state: 'ok' }, models: res.json.models.map((m) => m.name).filter(Boolean) }
    },

    async infer() {
      throw new ProviderError('bad_request', `${cfg.id} is a decision model; it cannot generate text`, { provider: cfg.id })
    },

    /**
     * @param {{model: string, state: unknown, questions: Record<string, object>}} input
     * @returns the validated answers, keyed by question name
     */
    async decide({ model, state, questions }) {
      if (!key()) throw new ProviderError('auth', `${keyName} is not set`, { provider: cfg.id })
      const res = await request(fetchImpl, `${baseUrl}/v1/systemone`, {
        method: 'POST',
        headers: headers(),
        body: JSON.stringify({ model, state, questions }),
        timeoutMs: cfg.inferTimeoutMs ?? 20000,
        provider: cfg.id,
      })
      if (res.status === 422) {
        const first = res.json?.detail?.[0]
        throw new ProviderError('bad_request', `request rejected: ${first?.msg ?? 'validation error'}`, { status: 422, provider: cfg.id })
      }
      raiseForStatus(res, cfg.id)
      const answers = res.json?.answers
      if (!answers || typeof answers !== 'object') throw bad(cfg.id, 'reply has no answers object')
      for (const [name, q] of Object.entries(questions)) validateAnswer(cfg.id, name, q, answers[name])
      return {
        answers,
        model: res.json.model ?? model,
        provider: cfg.id,
        latencyMs: res.latencyMs,
        usage: { inputTokens: res.json.usage?.input_tokens, outputTokens: res.json.usage?.output_tokens },
      }
    },
  }
}
