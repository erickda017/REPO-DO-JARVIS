import { appendFile, mkdir } from 'node:fs/promises'
import { dirname } from 'node:path'
import { redact } from './redact.mjs'

/**
 * Append-only audit trail of what the command centre did: provider calls,
 * spend confirmations, task and timer changes, refusals. Entries are redacted
 * before they are stored and never contain prompt text — only its length.
 *
 * Kept in a ring in memory for the UI, and mirrored to a JSONL file when a
 * path is given. A failing disk never breaks the caller.
 */
export function createAudit({ file = null, limit = 200, clock = Date.now } = {}) {
  const ring = []
  let ready = null

  const write = async (line) => {
    if (!file) return
    try {
      ready ??= mkdir(dirname(file), { recursive: true })
      await ready
      await appendFile(file, line + '\n', 'utf8')
    } catch (err) {
      console.warn('[command] audit write failed:', err?.code ?? err?.message)
    }
  }

  return {
    /** @param {string} action @param {Record<string, unknown>} [detail] */
    record(action, detail = {}) {
      const entry = { at: new Date(clock()).toISOString(), action, ...redact(detail) }
      ring.push(entry)
      if (ring.length > limit) ring.shift()
      void write(JSON.stringify(entry))
      return entry
    },
    recent(n = 50) {
      return ring.slice(-n).reverse()
    },
  }
}
