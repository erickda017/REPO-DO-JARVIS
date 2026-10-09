import net from 'node:net'
import { request } from './http.mjs'
import { ProviderError } from './errors.mjs'

const MIN_INTERVAL_SEC = 15
const HISTORY = 50

/**
 * Availability monitor for services the user listed in the config — and only
 * those. There is no discovery, no port scanning and no crawling: every check
 * is one bounded request to an entry somebody wrote down on purpose.
 *
 * A check reports `up | degraded | down`. `degraded` means it answered but
 * slower than `slowMs` or with an unexpected status. History is a ring so a
 * flapping service cannot grow memory without limit.
 */
export function createServiceMonitor({ services = [], fetch: fetchImpl = fetch, clock = Date.now, audit } = {}) {
  const state = new Map()
  const timers = new Set()

  for (const s of services) {
    if (!/^[a-z0-9_-]+$/i.test(s.id)) throw new Error(`service id "${s.id}" must be [a-z0-9_-]`)
    let url
    try {
      url = new URL(s.url)
    } catch {
      throw new Error(`service ${s.id}: invalid url`)
    }
    if (!/^https?:$/.test(url.protocol)) throw new Error(`service ${s.id}: only http(s) is allowed`)
    if (url.username || url.password) throw new Error(`service ${s.id}: credentials in a url are not allowed`)
    state.set(s.id, {
      cfg: {
        id: s.id,
        name: s.name ?? s.id,
        url: s.url,
        method: s.method === 'HEAD' ? 'HEAD' : 'GET',
        timeoutMs: Math.min(s.timeoutMs ?? 5000, 15000),
        slowMs: s.slowMs ?? 2000,
        expectStatus: s.expectStatus ?? null, // null = any 2xx
        intervalSec: Math.max(s.intervalSec ?? 60, MIN_INTERVAL_SEC),
      },
      status: 'unknown',
      lastChecked: null,
      lastLatencyMs: null,
      lastError: null,
      consecutiveFailures: 0,
      history: [],
      checking: null,
    })
  }

  async function checkOne(id) {
    const s = state.get(id)
    if (!s) throw new ProviderError('unconfigured', `no such service "${id}"`)
    if (s.checking) return s.checking // one in flight per service
    const { cfg } = s
    s.checking = (async () => {
      let status
      let error = null
      let latencyMs = null
      let httpStatus = null
      try {
        const res = await request(fetchImpl, cfg.url, { method: cfg.method, timeoutMs: cfg.timeoutMs, maxBytes: 256_000 })
        latencyMs = res.latencyMs
        httpStatus = res.status
        const okStatus = cfg.expectStatus ? res.status === cfg.expectStatus : res.ok
        if (!okStatus) {
          status = 'degraded'
          error = `unexpected HTTP ${res.status}`
        } else status = latencyMs > cfg.slowMs ? 'degraded' : 'up'
        if (status === 'degraded' && !error) error = `slow response (${latencyMs} ms)`
      } catch (err) {
        status = 'down'
        error = err?.message ?? String(err)
      }
      s.status = status
      s.lastChecked = new Date(clock()).toISOString()
      s.lastLatencyMs = latencyMs
      s.lastError = error
      s.consecutiveFailures = status === 'up' ? 0 : s.consecutiveFailures + 1
      s.history.unshift({ at: s.lastChecked, status, httpStatus, latencyMs, error })
      s.history.length = Math.min(s.history.length, HISTORY)
      if (status === 'down') audit?.record('service.down', { id, error })
      return view(s)
    })().finally(() => {
      s.checking = null
    })
    return s.checking
  }

  const view = (s) => ({
    id: s.cfg.id,
    name: s.cfg.name,
    url: s.cfg.url,
    status: s.status,
    lastChecked: s.lastChecked,
    lastLatencyMs: s.lastLatencyMs,
    lastError: s.lastError,
    consecutiveFailures: s.consecutiveFailures,
    intervalSec: s.cfg.intervalSec,
    recentFailures: s.history.filter((h) => h.status !== 'up').slice(0, 10),
  })

  return {
    checkOne,
    checkAll: () => Promise.all([...state.keys()].map(checkOne)),
    list: () => [...state.values()].map(view),
    has: (id) => state.has(id),
    /** Start periodic checks. Opt-in: the bridge never polls until told to. */
    start() {
      for (const [id, s] of state) {
        const t = setInterval(() => void checkOne(id).catch(() => {}), s.cfg.intervalSec * 1000)
        t.unref?.()
        timers.add(t)
        void checkOne(id).catch(() => {})
      }
    },
    stop() {
      for (const t of timers) clearInterval(t)
      timers.clear()
    },
  }
}

/** TCP connect probe to loopback only — "is something listening on this port". */
export function probePort(port, { timeoutMs = 1000 } = {}) {
  return new Promise((resolve) => {
    const sock = net.connect({ host: '127.0.0.1', port })
    const done = (ok) => {
      sock.destroy()
      resolve(ok)
    }
    sock.setTimeout(timeoutMs, () => done(false))
    sock.once('connect', () => done(true))
    sock.once('error', () => done(false))
  })
}
