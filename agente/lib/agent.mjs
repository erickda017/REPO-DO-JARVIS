// Wires the pieces into one agent session: tools, system prompt (built once), the conversation, subagents, persistence.
import { mkdirSync, writeFileSync } from 'node:fs'
import { homedir } from 'node:os'
import { join } from 'node:path'
import { randomBytes } from 'node:crypto'
import { createApprover } from './approval.mjs'
import { compress, estimateTokens } from './compress.mjs'
import { runLoop } from './loop.mjs'
import { buildSystemPrompt } from './prompt.mjs'
import { TodoStore } from './todo.mjs'
import { fileTools, ReadTracker } from './tools/files.mjs'
import { BUILTIN_SKILLS, createMemory, loadSkills, miscTools } from './tools/misc.mjs'
import { ProcessRegistry, terminalTools } from './tools/terminal.mjs'
import { webTools } from './tools/web.mjs'

export const defaultDataDir = () => process.env.JARVIS_AGENT_DIR || join(process.env.APPDATA || join(homedir(), '.config'), 'J.A.R.V.I.S', 'agente')

/**
 * @param {object} o
 * @param {any} o.llm
 * @param {string} o.cwd
 * @param {string} [o.dataDir]
 * @param {(msg: string, choices?: string[]) => Promise<string>} [o.ask]        free-form question to the user
 * @param {(msg: string) => Promise<'once'|'session'|'deny'>} [o.confirm]       permission prompt
 * @param {(e: object) => void} [o.on]
 */
export function createAgent({ llm, cwd, dataDir = defaultDataDir(), ask, confirm, on = () => {}, yolo = false, compressAt = 90_000, maxIterations = 120 }) {
  const state = { cwd, summary: null }
  const tracker = new ReadTracker()
  const registry = new ProcessRegistry()
  const todo = new TodoStore()
  const memory = createMemory(dataDir)
  const skills = loadSkills([BUILTIN_SKILLS, join(dataDir, 'skills')])
  const approver = createApprover({ ask: confirm, yolo })
  const getCwd = () => state.cwd
  const setCwd = (c) => { state.cwd = c }
  let controller = null

  const baseTools = (signal) => [...fileTools({ getCwd, tracker }), ...terminalTools({ getCwd, setCwd, approver, registry, signal }), ...webTools()]

  async function runChild({ goal, context }) {
    const childTools = new Map(baseTools(controller?.signal).map((t) => [t.name, t]))
    const system = buildSystemPrompt({ cwd: state.cwd, toolNames: [...childTools.keys()], skills: [] }) + '\n\n# Subagente\nVocê é um subagente: faça só a subtarefa pedida, com os dados que recebeu, e termine com um resumo objetivo do que fez, do que encontrou (caminhos e linhas exatos) e do que ficou pendente.'
    const messages = [{ role: 'user', content: `${goal}${context ? `\n\n# Contexto\n${context}` : ''}` }]
    const r = await runLoop({ llm, tools: childTools, system, messages, signal: controller?.signal, maxIterations: 60, compressAt, on: (e) => { if (e.type === 'tool_start') on({ type: 'child_tool', name: e.name }) } })
    return { summary: r.text || '(o subagente não devolveu texto)', steps: r.iterations, ...(r.limit ? { note: 'O subagente atingiu o limite de passos.' } : {}) }
  }

  const tools = new Map()
  const addTools = () => {
    tools.clear()
    for (const t of baseTools(controller?.signal)) tools.set(t.name, t)
    for (const t of miscTools({ todo, memory, skills, ask, runChild })) tools.set(t.name, t)
  }
  addTools()

  const id = `${new Date().toISOString().replace(/[:.]/g, '-').slice(0, 19)}-${randomBytes(2).toString('hex')}`
  const messages = []
  let system = null

  const save = () => {
    try {
      const dir = join(dataDir, 'sessions'); mkdirSync(dir, { recursive: true })
      writeFileSync(join(dir, `${id}.json`), JSON.stringify({ id, cwd: state.cwd, savedAt: new Date().toISOString(), messages }, null, 1))
    } catch { /* a read-only disk must not stop the work */ }
  }

  return {
    id, messages, state, todo, tools, registry, approver, skills, memory,
    get system() { return system },
    get cwd() { return state.cwd },
    tokens: () => estimateTokens(messages),
    setYolo: (v) => approver.setYolo(v),
    interrupt() { controller?.abort() },

    /** One user turn: runs tools until the model answers with text. */
    async send(text) {
      if (!system) system = buildSystemPrompt({ cwd: state.cwd, toolNames: [...tools.keys()], memory: memory.snapshot(), skills: [...skills.values()].map(({ name, description }) => ({ name, description })) })
      controller = new AbortController()
      addTools() // rebinds the abort signal of the terminal
      messages.push({ role: 'user', content: text })
      try {
        return await runLoop({ llm, tools, system, messages, on, signal: controller.signal, maxIterations, compressAt, todoText: () => todo.formatForInjection(), state })
      } finally { controller = null; save() }
    },

    async compressNow(focus) {
      const r = await compress({ messages, llm, todoText: todo.formatForInjection(), focus, force: true, previousSummary: state.summary })
      if (r.mode !== 'none') { messages.splice(0, messages.length, ...r.messages); if (r.summary) state.summary = r.summary; save() }
      return r
    },

    clear() { messages.length = 0; todo.write([]); state.summary = null; tracker.seen.clear() },
    dispose() { registry.killAll() },
  }
}
