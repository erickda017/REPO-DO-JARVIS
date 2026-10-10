// todo_list, clarify, memory, skills and delegate_task. Concepts from tools/todo_tool.py, tools/memory_tool*.py,
// tools/skills_tool.py and tools/delegate_tool.py of Hermes Agent (c) 2025 Nous Research, MIT License.
import { existsSync, mkdirSync, readFileSync, readdirSync, statSync, writeFileSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { TODO_TOOL, runTodo } from '../todo.mjs'

const HERE = dirname(fileURLToPath(import.meta.url))
export const BUILTIN_SKILLS = join(HERE, '..', '..', 'skills')

// ── memory ─────────────────────────────────────────────────────────────────────────────────────────────────────────
const LIMITS = { memory: 4000, user: 2000 }
export function createMemory(dir) {
  mkdirSync(dir, { recursive: true })
  const file = (t) => join(dir, t === 'user' ? 'USER.md' : 'MEMORY.md')
  const read = (t) => { try { return readFileSync(file(t), 'utf8') } catch { return '' } }
  return {
    read,
    /** Frozen at session start, so the system prompt stays byte-stable for the whole conversation. */
    snapshot() {
      const m = read('memory').trim(), u = read('user').trim()
      return [m && `## Notas do agente (MEMORY.md)\n${m}`, u && `## Sobre o usuário (USER.md)\n${u}`].filter(Boolean).join('\n\n')
    },
    write(t, text) { writeFileSync(file(t), text.trim() + '\n', 'utf8') },
  }
}

// ── skills ─────────────────────────────────────────────────────────────────────────────────────────────────────────
function parseSkill(path) {
  const raw = readFileSync(path, 'utf8')
  const m = /^---\r?\n([\s\S]*?)\r?\n---\r?\n?([\s\S]*)$/.exec(raw)
  const meta = {}
  for (const line of (m?.[1] ?? '').split(/\r?\n/)) { const kv = /^([\w-]+):\s*(.*)$/.exec(line); if (kv) meta[kv[1]] = kv[2].replace(/^["']|["']$/g, '').trim() }
  return { meta, body: (m?.[2] ?? raw).trim() }
}
export function loadSkills(dirs) {
  const out = new Map()
  for (const d of dirs) {
    if (!existsSync(d)) continue
    for (const name of readdirSync(d)) {
      const p = join(d, name, 'SKILL.md')
      try { if (statSync(join(d, name)).isDirectory() && existsSync(p)) { const s = parseSkill(p); out.set(s.meta.name || name, { name: s.meta.name || name, description: s.meta.description || '', body: s.body, dir: join(d, name) }) } } catch { /* unreadable skill */ }
    }
  }
  return out
}

export function miscTools({ todo, memory, skills, ask, runChild }) {
  const list = [
    { ...TODO_TOOL, readOnly: false, run: (a) => runTodo(todo, a) },
    {
      name: 'clarify', readOnly: false,
      description: 'Ask the user a question when you are blocked by missing information that you cannot find with tools, or when a choice changes what you would do. Do not ask what you can discover yourself. Returns the answer.',
      parameters: { type: 'object', properties: { question: { type: 'string' }, choices: { type: 'array', items: { type: 'string' }, description: 'Optional fixed options (up to 4)' } }, required: ['question'] },
      async run({ question, choices }) {
        if (!ask) return { error: 'No user is available to answer; make a reasonable assumption, state it, and continue.' }
        return { answer: await ask(String(question), Array.isArray(choices) ? choices.slice(0, 4).map(String) : undefined) }
      },
    },
    {
      name: 'memory', readOnly: false,
      description: 'Persist short notes that must survive across sessions. target="memory": facts about this machine, projects and lessons learned (≤4000 chars total). target="user": the user\'s preferences and profile (≤2000). actions: read, add (append one line), replace (old→new text), remove (a line containing the text). Save only what is durable and non-obvious — never secrets, never task progress.',
      parameters: { type: 'object', properties: { action: { type: 'string', enum: ['read', 'add', 'replace', 'remove'] }, target: { type: 'string', enum: ['memory', 'user'] }, text: { type: 'string' }, old_text: { type: 'string' } }, required: ['action', 'target'] },
      async run({ action, target, text, old_text }) {
        if (!memory) return { error: 'memory is not available' }
        if (target !== 'memory' && target !== 'user') return { error: 'target must be "memory" or "user"' }
        let cur = memory.read(target)
        if (action === 'read') return { target, content: cur }
        if (/(?:sk-|AIza|ghp_|xox[bp]-|-----BEGIN)/.test(String(text ?? ''))) return { error: 'Recusado: isto parece um segredo. Nunca guarde chaves ou senhas na memória.' }
        if (action === 'add') cur = `${cur.trimEnd()}\n- ${String(text ?? '').trim()}`.trim()
        else if (action === 'replace') { if (!cur.includes(String(old_text))) return { error: 'old_text not found in memory' }; cur = cur.replace(String(old_text), String(text ?? '')) }
        else if (action === 'remove') cur = cur.split('\n').filter((l) => !l.includes(String(text ?? '\u0000'))).join('\n')
        else return { error: `unknown action ${action}` }
        if (cur.length > LIMITS[target]) return { error: `Memória cheia (${cur.length}/${LIMITS[target]} caracteres). Remova ou condense algo antes de adicionar.` }
        memory.write(target, cur)
        return { ok: true, target, chars: cur.length, note: 'Vale a partir da próxima sessão (o prompt desta já está fixo).' }
      },
    },
  ]
  if (skills?.size) {
    list.push(
      { name: 'skills_list', readOnly: true, description: 'List the available skills (name + one-line description).', parameters: { type: 'object', properties: {}, required: [] }, run: () => ({ skills: [...skills.values()].map((s) => ({ name: s.name, description: s.description })) }) },
      { name: 'skill_view', readOnly: true, description: 'Load the full instructions of a skill by name. Do this BEFORE starting a task a skill covers.', parameters: { type: 'object', properties: { name: { type: 'string' } }, required: ['name'] }, run: ({ name }) => { const s = skills.get(String(name)); return s ? { name: s.name, instructions: s.body, directory: s.dir } : { error: `No skill named "${name}". Use skills_list.` } } },
    )
  }
  if (runChild) {
    list.push({
      name: 'delegate_task', readOnly: false,
      description: 'Spawn a subagent with a fresh context to work on a self-contained subtask (research a library, investigate a bug in one module, review a diff). It has the file, search, terminal and web tools but cannot ask the user, use memory or delegate. It returns a summary of what it did and found — you never see its intermediate steps. Give it the goal and ALL the context it needs (it knows nothing of this conversation).',
      parameters: { type: 'object', properties: { goal: { type: 'string', description: 'What the subagent must accomplish and what to report back' }, context: { type: 'string', description: 'Everything relevant: file paths, constraints, what you already tried' } }, required: ['goal'] },
      async run({ goal, context = '' }) {
        if (typeof goal !== 'string' || !goal.trim()) return { error: 'delegate_task: goal is required.' }
        return await runChild({ goal, context })
      },
    })
  }
  return list
}
