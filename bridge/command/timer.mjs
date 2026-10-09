import { mkdir, readFile, rename, writeFile } from 'node:fs/promises'
import { dirname } from 'node:path'

const MAX_MS = 24 * 60 * 60 * 1000

/**
 * One countdown timer: idle -> running <-> paused -> (finished | idle).
 *
 * State is stored as facts, not as a ticking counter: `elapsedMs` banked so far
 * plus `startedAt` while running. Remaining time is always computed from the
 * clock, so the UI, the API and a restart all agree. The timer persists to a
 * file; after a restart a running timer keeps counting in wall-clock time (it
 * does not freeze while the app was off) and reports `finished` if it ran out.
 */
export function createTimer({ file, clock = Date.now, audit } = {}) {
  let s = { status: 'idle', label: '', durationMs: 0, elapsedMs: 0, startedAt: null }
  let loaded = !file
  let chain = Promise.resolve()

  const load = async () => {
    if (loaded) return
    loaded = true
    try {
      const parsed = JSON.parse(await readFile(file, 'utf8'))
      if (parsed && ['idle', 'running', 'paused'].includes(parsed.status)) s = parsed
    } catch {
      /* no saved timer */
    }
  }

  const persist = () => {
    if (!file) return Promise.resolve()
    chain = chain.then(async () => {
      await mkdir(dirname(file), { recursive: true })
      const tmp = `${file}.tmp`
      await writeFile(tmp, JSON.stringify(s), 'utf8')
      await rename(tmp, file)
    })
    return chain
  }

  const elapsed = () => s.elapsedMs + (s.status === 'running' ? clock() - s.startedAt : 0)

  const view = () => {
    const remainingMs = Math.max(0, s.durationMs - elapsed())
    const status = s.status === 'running' && remainingMs === 0 ? 'finished' : s.status
    return { status, label: s.label, durationMs: s.durationMs, remainingMs: s.status === 'idle' ? 0 : remainingMs }
  }

  const fail = (msg) => {
    throw new Error(msg)
  }

  return {
    async get() {
      await load()
      return view()
    },
    async start({ seconds, label = '' }) {
      await load()
      const ms = Math.round(Number(seconds) * 1000)
      if (!Number.isFinite(ms) || ms <= 0 || ms > MAX_MS) fail('seconds must be between 1 and 86400')
      if (s.status === 'running' || s.status === 'paused') fail('a timer is already active; cancel it first')
      s = { status: 'running', label: String(label).slice(0, 80), durationMs: ms, elapsedMs: 0, startedAt: clock() }
      await persist()
      audit?.record('timer.start', { seconds: ms / 1000 })
      return view()
    },
    async pause() {
      await load()
      if (view().status !== 'running') fail('timer is not running')
      s = { ...s, status: 'paused', elapsedMs: elapsed(), startedAt: null }
      await persist()
      audit?.record('timer.pause')
      return view()
    },
    async resume() {
      await load()
      if (s.status !== 'paused') fail('timer is not paused')
      s = { ...s, status: 'running', startedAt: clock() }
      await persist()
      audit?.record('timer.resume')
      return view()
    },
    async cancel() {
      await load()
      s = { status: 'idle', label: '', durationMs: 0, elapsedMs: 0, startedAt: null }
      await persist()
      audit?.record('timer.cancel')
      return view()
    },
  }
}
