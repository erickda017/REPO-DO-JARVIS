import { ProviderError, classifyStatus } from './errors.mjs'
// (ProviderError is also used below to build the quota variant)
import { redactString } from './redact.mjs'

/**
 * The single place the command centre touches the network on behalf of a
 * provider or monitored service. Always bounded: a timeout, a response-size
 * cap, and no redirect following — a redirect would carry an Authorization
 * header to a host the user never configured.
 */
export async function request(
  fetchImpl,
  url,
  { method = 'GET', headers = {}, body, timeoutMs = 8000, maxBytes = 1_000_000, provider } = {},
) {
  const ctrl = new AbortController()
  const timer = setTimeout(() => ctrl.abort(), timeoutMs)
  const started = Date.now()
  try {
    const res = await fetchImpl(url, {
      method,
      headers,
      body,
      signal: ctrl.signal,
      redirect: 'manual',
    })
    const text = await res.text()
    if (text.length > maxBytes) {
      throw new ProviderError('bad_response', `response larger than ${maxBytes} bytes`, { provider })
    }
    let json
    try {
      json = text ? JSON.parse(text) : undefined
    } catch {
      json = undefined
    }
    return { status: res.status, ok: res.status >= 200 && res.status < 300, json, text, latencyMs: Date.now() - started }
  } catch (err) {
    if (err instanceof ProviderError) throw err
    if (err?.name === 'AbortError') {
      throw new ProviderError('timeout', `no response within ${timeoutMs} ms`, { provider })
    }
    const why = err?.cause?.code ?? err?.code ?? err?.message ?? 'unknown'
    throw new ProviderError('network', redactString(`could not reach host (${why})`), { provider })
  } finally {
    clearTimeout(timer)
  }
}

/** Throw the normalised error for a non-2xx answer, with a short redacted hint. */
export function raiseForStatus(res, provider) {
  if (res.ok) return
  let err = classifyStatus(res.status, provider)
  const hint = res.json?.error?.message ?? res.json?.message
  // A 429 that talks about quota or billing is not "try again in a minute": it is "this account is empty".
  if (err.kind === 'rate_limit' && /quota|billing|insufficient|credit|exhaust/i.test(`${hint ?? ''} ${res.text.slice(0, 400)}`)) {
    err = new ProviderError('quota', 'quota or credit exhausted (HTTP 429)', { status: res.status, provider })
  }
  if (typeof hint === 'string') err.message += `: ${redactString(hint).slice(0, 160)}`
  throw err
}
