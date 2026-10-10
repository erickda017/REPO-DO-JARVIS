import { mkdir, readFile, rename, writeFile } from 'node:fs/promises'
import { dirname } from 'node:path'
import { classify, closeProcess, listProcesses } from './procs.mjs'

/**
 * Performance profiles. "game" never touches antivirus, Windows services or anything the classifier marks protected.
 * It only proposes optional/caution apps, closes the ones the owner approves (graceful close first), remembers what it
 * closed so the owner can reopen them, and measures RAM before and after. Profiles are plain objects so "work",
 * "economy" or "maximum" can be added later by registering another entry in PROFILES.
 */
export const PROFILES = {
  game: { label: 'Modo game', minMemMB: 150, closable: ['optional', 'caution'] },
}

export function createProfiles({ file, monitor, clock = Date.now } = {}) {
  let state = { active: null }
  let loaded = !file
  let chain = Promise.resolve()
  let lastPrepared = new Set() // pids offered by the latest analysis: only those can be closed
  const save = () => {
    if (!file) return Promise.resolve()
    chain = chain.then(async () => {
      await mkdir(dirname(file), { recursive: true })
      await writeFile(`${file}.tmp`, JSON.stringify(state, null, 2))
      await rename(`${file}.tmp`, file)
    })
    return chain
  }
  const load = async () => {
    if (loaded) return
    loaded = true
    try { state = JSON.parse((await readFile(file, 'utf8')).replace(/^﻿/, '')) } catch { /* none */ }
  }
  const memFree = () => monitor.summary().memory.freeGB

  return {
    async status() {
      await load()
      if (!state.active) return { active: null }
      const free = memFree()
      return { ...state, since: new Date(state.startedAt).toISOString(), freeGBNow: free, freedGBSoFar: Math.round((free - state.freeGBBefore) * 10) / 10, closedCount: state.closed.length }
    },

    /** Read-only: what could be closed, why, and how much RAM it holds. Nothing happens here. */
    async prepare({ profile = 'game', game } = {}) {
      await load()
      const p = PROFILES[profile]
      if (!p) throw new Error('perfil desconhecido')
      const procs = await listProcesses({ top: 80 })
      const candidates = procs.filter((x) => p.closable.includes(x.class) && x.MemMB >= p.minMemMB && !(game && x.Name.toLowerCase().includes(String(game).toLowerCase())))
      lastPrepared = new Set(candidates.map((c) => c.Id))
      return {
        profile,
        game: game ?? null,
        freeGBBefore: memFree(),
        candidates: candidates.map((c) => ({ pid: c.Id, name: c.Name, memMB: c.MemMB, class: c.class, why: c.why, window: c.Title || null })),
        reclaimableMB: candidates.reduce((a, c) => a + c.MemMB, 0),
        note: 'Aplicativos marcados "caution" podem ter trabalho não salvo. Nada é encerrado até você aprovar.',
      }
    },

    /** Closes exactly the approved pids (re-classified at the moment of closing) and records them. */
    async apply({ profile = 'game', pids = [], game } = {}) {
      await load()
      const before = memFree()
      if (!state.active) state = { active: profile, game: game ?? null, startedAt: clock(), freeGBBefore: before, closed: [] }
      const results = []
      for (const pid of pids) {
        if (!lastPrepared.has(pid)) { results.push({ pid, ok: false, reason: 'recusado: não estava na última análise (profile_prepare)' }); continue }
        const info = await listProcesses({ top: 200 }).then((a) => a.find((x) => x.Id === pid))
        if (!info) { results.push({ pid, ok: false, reason: 'o processo não existe mais' }); continue }
        if (info.class === 'protected' || info.class === 'unknown') { results.push({ pid, name: info.Name, ok: false, reason: `recusado (${info.why})` }); continue }
        const r = await closeProcess(pid)
        if (r.exited) state.closed.push({ name: info.Name, path: info.Path ?? null, memMB: info.MemMB })
        results.push({ pid, name: info.Name, ok: r.exited, reason: r.exited ? null : 'não fechou com o pedido normal (pode ter um diálogo de salvar aberto); nada foi forçado' })
      }
      await save()
      await new Promise((r) => setTimeout(r, 1500))
      return { results, freeGBBefore: before, freeGBAfter: memFree(), freedGB: Math.round((memFree() - before) * 10) / 10 }
    },

    /** Ends the profile and lists what was closed, so the owner (or the agent, with the apps permission) can reopen it. */
    async stop() {
      await load()
      const was = state
      state = { active: null }
      await save()
      return { wasActive: was.active, closed: was.closed ?? [], minutes: was.startedAt ? Math.round((clock() - was.startedAt) / 60000) : 0, note: 'Nada do Windows foi alterado: só aplicativos foram fechados. Reabra o que precisar.' }
    },
  }
}

export { classify }
