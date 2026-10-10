// In-memory, revisioned task list. Port of tools/todo_tool.py from Hermes Agent (c) 2025 Nous Research, MIT License.
// Re-injected after context compression so a long task keeps its plan.
const VALID = new Set(['pending', 'in_progress', 'completed', 'cancelled'])
const ACTIVE = new Set(['pending', 'in_progress'])
const MARK = { completed: '[x]', in_progress: '[>]', pending: '[ ]', cancelled: '[~]' }
const MAX_CONTENT = 4000
const MAX_ITEMS = 256
export const TODO_INJECTION_HEADER = '[Your active task list was preserved across context compression]'

const cap = (s) => (s.length > MAX_CONTENT ? s.slice(0, MAX_CONTENT - 13) + '… [truncated]' : s)

export class TodoStore {
  constructor() { this.items = []; this.revision = 0 }

  #validate(t) {
    if (!t || typeof t !== 'object') return { id: '?', content: '(invalid item)', status: 'pending' }
    const id = String(t.id ?? '').trim() || '?'
    const content = String(t.content ?? '').trim()
    if (!content) throw new Error(`Todo item '${id}' has empty or missing content. Each item must have a non-empty description.`)
    const status = String(t.status ?? 'pending').trim().toLowerCase()
    const out = { id, content: cap(content), status: VALID.has(status) ? status : 'pending' }
    const parent = String(t.parent ?? '').trim()
    if (parent && parent !== id) out.parent = parent
    return out
  }

  #dedupe(todos) {
    const last = new Map()
    todos.forEach((t, i) => last.set(t && typeof t === 'object' ? String(t.id ?? '').trim() || '?' : `__invalid_${i}`, i))
    return [...last.values()].sort((a, b) => a - b).map((i) => todos[i])
  }

  #order(items) {
    const st = items.map((i) => i.status)
    if (items.some((i) => i.parent) || !st.includes('in_progress')) return items
    const active = st.indexOf('in_progress')
    if (!st.slice(0, active).includes('pending')) return items
    const out = [...items]
    out.splice(st.indexOf('pending'), 0, out.splice(active, 1)[0])
    return out
  }

  #sanitizeParents() {
    const byId = new Map(this.items.map((i) => [i.id, i]))
    for (const i of this.items) if (i.parent && !byId.has(i.parent)) delete i.parent
    for (const i of this.items) {
      const seen = new Set([i.id])
      let node = i
      while (node.parent) {
        if (seen.has(node.parent)) { delete i.parent; break }
        seen.add(node.parent)
        node = byId.get(node.parent)
      }
    }
  }

  write(todos, merge = false) {
    const before = this.read()
    try {
      if (merge) {
        const existing = new Map(this.items.map((i) => [i.id, i]))
        for (const t of this.#dedupe(todos)) {
          const id = String(t?.id ?? '').trim()
          if (!id) continue
          const cur = existing.get(id)
          if (!cur) { const v = this.#validate(t); existing.set(v.id, v); this.items.push(v); continue }
          if (t.content) cur.content = cap(String(t.content).trim())
          if (t.status && VALID.has(String(t.status).trim().toLowerCase())) cur.status = String(t.status).trim().toLowerCase()
          if ('parent' in t) { const p = String(t.parent ?? '').trim(); if (p) cur.parent = p; else delete cur.parent }
        }
        this.items = this.#order(this.items.map((i) => existing.get(i.id) ?? i))
      } else this.items = this.#order(this.#dedupe(todos).map((t) => this.#validate(t)))
    } catch (e) { this.items = before; throw e }
    this.items.length = Math.min(this.items.length, MAX_ITEMS)
    this.#sanitizeParents()
    if (JSON.stringify(this.items) !== JSON.stringify(before)) this.revision++
    return this.read()
  }

  read() { return this.items.map((i) => ({ ...i })) }

  /** Only pending / in-progress items (and parents of such), so finished work is not redone after compression. */
  formatForInjection() {
    if (!this.items.length) return null
    const kids = new Map()
    for (const i of this.items) if (i.parent) kids.set(i.parent, [...(kids.get(i.parent) ?? []), i])
    const render = (item, depth, out) => {
      const lines = []
      let activeKid = false
      for (const k of kids.get(item.id) ?? []) activeKid = render(k, depth + 1, lines) || activeKid
      const keep = ACTIVE.has(item.status) || activeKid
      if (keep) { out.push(`${'  '.repeat(depth)}- ${MARK[item.status] ?? '[?]'} ${item.id}. ${item.content} (${item.status})`); out.push(...lines) }
      return keep
    }
    const lines = [TODO_INJECTION_HEADER]
    for (const i of this.items) if (!i.parent) render(i, 0, lines)
    return lines.length > 1 ? lines.join('\n') : null
  }
}

export const TODO_TOOL = {
  name: 'todo_list',
  description: 'Track a task list for multi-step work (3+ steps). Use for complex tasks with 3+ steps or when the user provides multiple tasks. For "all N items" tasks, enumerate every instance as its own checklist item so none are silently dropped. Call with no parameters to read the current list.\nList order is priority. Only ONE item in_progress at a time. Break large phases into subtasks via parent. Mark an item completed only after the work is verified done, never based on intent. If something fails, cancel it and add a revised item. Always returns the full current list.',
  parameters: {
    type: 'object',
    properties: {
      todos: { type: 'array', description: 'Task items to write.', items: { type: 'object', properties: { id: { type: 'string' }, content: { type: 'string', description: 'Task description' }, status: { type: 'string', enum: ['pending', 'in_progress', 'completed', 'cancelled'] }, parent: { type: 'string', description: 'Optional id of another item, making this a nested subtask. Omit for top-level.' } }, required: ['id', 'content', 'status'] } },
      merge: { type: 'boolean', description: 'true: update existing items by id, add new ones. false (default): replace the entire list with a fresh plan.' },
    },
    required: [],
  },
}

export function runTodo(store, { todos, merge = false }) {
  let items
  if (todos == null) items = store.read()
  else {
    if (!Array.isArray(todos)) return { error: `todos must be a list, got ${typeof todos}` }
    try { items = store.write(todos, merge) } catch (e) { return { error: e.message } }
  }
  const summary = { total: items.length }
  for (const s of ['pending', 'in_progress', 'completed', 'cancelled']) summary[s] = items.filter((i) => i.status === s).length
  return { todos: items, revision: store.revision, summary }
}
