/**
 * One error type for everything the command centre does over the network.
 *
 * Adapters throw ProviderError and nothing else, so the router, the health
 * monitor and the UI can reason about a failure without knowing which vendor
 * produced it. `kind` is the contract; `message` is for humans and is already
 * redacted, so it is safe to log and to send to the browser.
 */
export const ERROR_KINDS = Object.freeze([
  'network', // DNS, refused, reset — nothing answered
  'timeout', // we gave up waiting
  'auth', // 401/403, or no key configured
  'rate_limit', // 429
  'server', // 5xx from the provider
  'bad_request', // 4xx other than the above
  'model_not_found',
  'bad_response', // answered, but not in a shape we can use
  'unconfigured', // disabled or missing required settings
  'unverified', // integration contract not confirmed yet — never called
  'blocked', // refused locally by policy (spend, sensitive data, ...)
])

const RETRYABLE = new Set(['network', 'timeout', 'rate_limit', 'server'])

export class ProviderError extends Error {
  /**
   * @param {typeof ERROR_KINDS[number]} kind
   * @param {string} message already free of secrets
   * @param {{status?: number, provider?: string}} [extra]
   */
  constructor(kind, message, extra = {}) {
    super(message)
    this.name = 'ProviderError'
    this.kind = kind
    this.status = extra.status
    this.provider = extra.provider
    this.retryable = RETRYABLE.has(kind)
  }

  toJSON() {
    return {
      kind: this.kind,
      message: this.message,
      status: this.status,
      provider: this.provider,
      retryable: this.retryable,
    }
  }
}

/** Every provider the router tried failed (or none was eligible). */
export class RouteError extends Error {
  constructor(message, attempts) {
    super(message)
    this.name = 'RouteError'
    this.attempts = attempts
  }

  toJSON() {
    return { message: this.message, attempts: this.attempts }
  }
}

export function classifyStatus(status, provider) {
  if (status === 401 || status === 403) {
    return new ProviderError('auth', `authentication rejected (HTTP ${status})`, { status, provider })
  }
  if (status === 404) {
    return new ProviderError('model_not_found', 'endpoint or model not found (HTTP 404)', { status, provider })
  }
  if (status === 429) {
    return new ProviderError('rate_limit', 'rate limited (HTTP 429)', { status, provider })
  }
  if (status >= 500) {
    return new ProviderError('server', `provider error (HTTP ${status})`, { status, provider })
  }
  return new ProviderError('bad_request', `request rejected (HTTP ${status})`, { status, provider })
}
