import { appendFile, mkdir, readFile, rename, writeFile } from 'node:fs/promises'
import { randomUUID } from 'node:crypto'
import { dirname } from 'node:path'
import { redactString } from '../command/redact.mjs'

/**
 * Operational memory: what the agents learned while working (facts, hypotheses, decisions, errors and the fixes
 * that worked), kept apart from chat history. Every entry says where it came from, when, and how sure we are:
 * a hypothesis is never stored as a fact. Secrets are scrubbed before anything is written, long texts are cut,
 * and the file is capped so it never becomes a log dump.
 */
export const KINDS = ['fact', 'hypothesis', 'decision', 'error', 'solution']
export const CONFIDENCE = ['confirmed', 'probable', 'unverified']
const MAX_ENTRIES = 1500
const MAX_TEXT = 600

const tokens = (s) => String(s).toLowerCase().normalize('NFD').replace(/[̀-ͯ]/g, '').match(/[a-z0-9_]{3,}/g) ?? []

export function createMemory({ file, clock = Date.now } = {}) {
  let items = []
  let loaded = !file
  let chain = Promise.resolve()

  const ready = async () => {
    if (loaded) return
    loaded = true
    try {
      items = (await readFile(file, 'utf8')).split('\n').filter(Boolean).map((l) => { try { return JSON.parse(l) } catch { return null } }).filter(Boolean)
    } catch { /* first run */ }
  }

  const rewrite = () => {
    chain = chain.then(async () => {
      await mkdir(dirname(file), { recursive: true })
      const tmp = `${file}.tmp`
      await writeFile(tmp, items.map((i) => JSON.stringify(i)).join('\n') + '\n', 'utf8')
      await rename(tmp, file)
    }).catch(() => {})
    return chain
  }

  return {
    ready,
    /** @returns the stored entry, or the existing duplicate */
    async remember({ kind = 'fact', text, source = 'agente', confidence, tags = [], mission } = {}) {
      await ready()
      if (!KINDS.includes(kind)) throw new Error(`kind inválido (${KINDS.join(', ')})`)
      const clean = redactString(String(text ?? '')).replace(/\s+/g, ' ').trim().slice(0, MAX_TEXT)
      if (clean.length < 8) throw new Error('texto curto demais para valer a pena guardar')
      // A hypothesis can never be recorded as confirmed.
      const conf = kind === 'hypothesis' ? 'unverified' : CONFIDENCE.includes(confidence) ? confidence : 'probable'
      const dup = items.find((i) => i.kind === kind && i.text === clean)
      if (dup) return dup
      const entry = { id: randomUUID().slice(0, 8), at: new Date(clock()).toISOString(), kind, text: clean, source: String(source).slice(0, 60), confidence: conf, tags: tags.slice(0, 6).map((t) => String(t).slice(0, 24)), ...(mission ? { mission } : {}) }
      items.push(entry)
      if (items.length > MAX_ENTRIES) items = items.slice(-MAX_ENTRIES)
      if (file) {
        if (items.length === MAX_ENTRIES) await rewrite()
        else chain = chain.then(async () => { await mkdir(dirname(file), { recursive: true }); await appendFile(file, JSON.stringify(entry) + '\n') }).catch(() => {})
      }
      return entry
    },
    /** Keyword overlap, newest first on ties. Hypotheses are returned but labelled. */
    async recall(query, { limit = 6, kinds } = {}) {
      await ready()
      const q = new Set(tokens(query))
      if (!q.size) return []
      return items
        .filter((i) => !kinds || kinds.includes(i.kind))
        .map((i) => ({ i, score: tokens(`${i.text} ${i.tags.join(' ')}`).filter((t) => q.has(t)).length }))
        .filter((x) => x.score > 0)
        .sort((a, b) => b.score - a.score || (a.i.at < b.i.at ? 1 : -1))
        .slice(0, Math.min(limit, 20))
        .map((x) => x.i)
    },
    async list({ limit = 30 } = {}) { await ready(); return items.slice(-limit).reverse() },
    async forget(id) {
      await ready()
      const n = items.length
      items = items.filter((i) => i.id !== id)
      if (items.length !== n && file) await rewrite()
      return items.length !== n
    },
    size: () => items.length,
  }
}
