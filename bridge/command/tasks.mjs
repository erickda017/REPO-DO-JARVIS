import { randomUUID } from 'node:crypto'
import { mkdir, readFile, rename, writeFile } from 'node:fs/promises'
import { dirname } from 'node:path'

export const PRIORITIES = ['low', 'normal', 'high', 'urgent']
export const STATES = ['todo', 'doing', 'blocked', 'done', 'cancelled']
const PRIORITY_RANK = Object.fromEntries(PRIORITIES.map((p, i) => [p, i]))

const clean = (s, max) => String(s ?? '').trim().slice(0, max)

/**
 * Small JSON-file task store. One file, written atomically (temp file then
 * rename) so a crash mid-write cannot leave half a list. Writes are serialised
 * through a promise chain so two quick updates cannot interleave.
 */
export function createTaskStore({ file, clock = Date.now, audit } = {}) {
  let tasks = []
  let loaded = !file
  let chain = Promise.resolve()

  const load = async () => {
    if (loaded) return
    loaded = true
    try {
      const parsed = JSON.parse(await readFile(file, 'utf8'))
      if (Array.isArray(parsed)) tasks = parsed
    } catch (err) {
      if (err?.code !== 'ENOENT') console.warn('[command] tasks file unreadable, starting empty:', err?.message)
    }
  }

  const persist = () => {
    if (!file) return Promise.resolve()
    chain = chain.then(async () => {
      await mkdir(dirname(file), { recursive: true })
      const tmp = `${file}.tmp`
      await writeFile(tmp, JSON.stringify(tasks, null, 2), 'utf8')
      await rename(tmp, file)
    })
    return chain
  }

  const now = () => new Date(clock()).toISOString()

  return {
    async list({ state, includeClosed = false } = {}) {
      await load()
      return tasks
        .filter((t) => (state ? t.state === state : includeClosed || (t.state !== 'done' && t.state !== 'cancelled')))
        .sort((a, b) => PRIORITY_RANK[b.priority] - PRIORITY_RANK[a.priority] || a.createdAt.localeCompare(b.createdAt))
    },

    async create({ title, notes = '', priority = 'normal' }) {
      await load()
      const t = clean(title, 200)
      if (!t) throw new Error('title is required')
      if (!PRIORITIES.includes(priority)) throw new Error(`priority must be one of ${PRIORITIES.join(', ')}`)
      const task = { id: randomUUID(), title: t, notes: clean(notes, 2000), priority, state: 'todo', result: null, createdAt: now(), updatedAt: now() }
      tasks.push(task)
      await persist()
      audit?.record('task.create', { id: task.id, priority })
      return task
    },

    async update(id, patch = {}) {
      await load()
      const task = tasks.find((x) => x.id === id)
      if (!task) throw new Error('task not found')
      if (patch.state !== undefined) {
        if (!STATES.includes(patch.state)) throw new Error(`state must be one of ${STATES.join(', ')}`)
        task.state = patch.state
      }
      if (patch.priority !== undefined) {
        if (!PRIORITIES.includes(patch.priority)) throw new Error(`priority must be one of ${PRIORITIES.join(', ')}`)
        task.priority = patch.priority
      }
      if (patch.title !== undefined) task.title = clean(patch.title, 200) || task.title
      if (patch.notes !== undefined) task.notes = clean(patch.notes, 2000)
      if (patch.result !== undefined) task.result = patch.result === null ? null : clean(patch.result, 2000)
      task.updatedAt = now()
      await persist()
      audit?.record('task.update', { id, state: task.state, priority: task.priority })
      return task
    },

    async remove(id) {
      await load()
      const i = tasks.findIndex((x) => x.id === id)
      if (i < 0) throw new Error('task not found')
      tasks.splice(i, 1)
      await persist()
      audit?.record('task.delete', { id })
    },
  }
}
