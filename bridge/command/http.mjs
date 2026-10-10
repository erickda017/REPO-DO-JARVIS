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
  if ((err.kind === 'rate_limit' || err.kind === 'bad_request') && /quota|billing|insufficient|credit|exhaust/i.test(`${hint ?? ''} ${res.text.slice(0, 400)}`)) {
    err = new ProviderError('quota', 'quota or credit exhausted (HTTP 429)', { status: res.status, provider })
  }
  if (typeof hint === 'string') err.message += `: ${redactString(hint).slice(0, 160)}`
  throw err
}

/**
 * Server-sent events from a streaming completion, one parsed JSON object per `data:` line (`[DONE]` is skipped).
 * Same bounds as `request`: connect timeout, an idle timeout between chunks, a size cap, no redirects. A non-2xx
 * answer is read whole and raised as the same normalised error. Closing the generator (or aborting `signal`)
 * cancels the HTTP call.
 */
export async function* sse(fetchImpl, url, { method = 'POST', headers = {}, body, connectTimeoutMs = 30_000, idleTimeoutMs = 60_000, maxBytes = 8_000_000, provider, signal } = {}) {
  const ctrl = new AbortController()
  const onAbort = () => ctrl.abort()
  signal?.addEventListener('abort', onAbort, { once: true })
  let timer = setTimeout(() => ctrl.abort(), connectTimeoutMs)
  const fail = (err) => {
    if (err instanceof ProviderError) return err
    if (signal?.aborted) return new ProviderError('network', 'cancelled', { provider })
    if (err?.name === 'AbortError') return new ProviderError('timeout', 'stream stalled or timed out', { provider })
    return new ProviderError('network', redactString(`could not reach host (${err?.cause?.code ?? err?.code ?? err?.message ?? 'unknown'})`), { provider })
  }
  try {
    let res
    try {
      res = await fetchImpl(url, { method, headers, body, signal: ctrl.signal, redirect: 'manual' })
    } catch (err) {
      throw fail(err)
    }
    if (!(res.status >= 200 && res.status < 300)) {
      const text = await res.text().catch(() => '')
      let json
      try { json = JSON.parse(text) } catch { json = undefined }
      raiseForStatus({ status: res.status, ok: false, json, text }, provider)
    }
    if (!res.body || /application\/json/i.test(res.headers?.get?.('content-type') ?? '')) {
      // A server that ignores stream:true answers with one plain JSON document: hand it over as a single event.
      const text = await res.text()
      try {
        yield JSON.parse(text)
      } catch {
        throw new ProviderError('bad_response', 'the server did not answer with a stream or with JSON', { provider })
      }
      return
    }
    const reader = res.body.getReader()
    const dec = new TextDecoder()
    let buf = ''
    let total = 0
    for (;;) {
      clearTimeout(timer)
      timer = setTimeout(() => ctrl.abort(), idleTimeoutMs)
      let r
      try {
        r = await reader.read()
      } catch (err) {
        throw fail(err)
      }
      if (r.done) break
      total += r.value.length
      if (total > maxBytes) throw new ProviderError('bad_response', `stream larger than ${maxBytes} bytes`, { provider })
      buf += dec.decode(r.value, { stream: true })
      let i
      while ((i = buf.search(/\r?\n\r?\n/)) !== -1) {
        const block = buf.slice(0, i)
        buf = buf.slice(i).replace(/^\r?\n\r?\n/, '')
        const data = block.split(/\r?\n/).filter((l) => l.startsWith('data:')).map((l) => l.slice(5).trimStart()).join('\n')
        if (!data || data === '[DONE]') continue
        let ev
        try { ev = JSON.parse(data) } catch { continue } // keep-alives and comments
        yield ev
      }
    }
  } finally {
    clearTimeout(timer)
    signal?.removeEventListener('abort', onAbort)
    ctrl.abort()
  }
}