import { ProviderError } from '../errors.mjs'

/**
 * Placeholder for integrations whose contract has not been confirmed yet — the
 * Jev AI service and the user's local LLM app. It makes NO network calls and
 * never pretends to answer: every check reports `unknown` and `infer` throws
 * `unverified`. Replace it with a real adapter once the endpoint, auth scheme
 * and request/response format have been read from the actual code or docs.
 */
export function unverifiedProvider(cfg) {
  const note = cfg.note ?? 'integration contract not verified yet'
  return {
    id: cfg.id,
    type: 'unverified',
    async probe() {
      return {
        endpoint: { state: 'unknown', detail: note },
        auth: { state: 'unknown', detail: note },
        models: null,
      }
    },
    async infer() {
      throw new ProviderError('unverified', `${cfg.id}: ${note}`, { provider: cfg.id })
    },
  }
}
