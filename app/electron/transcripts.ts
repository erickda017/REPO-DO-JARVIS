import { closeSync, existsSync, openSync, readdirSync, readSync, statSync } from 'node:fs'
import { homedir } from 'node:os'
import { join } from 'node:path'

/**
 * Live metrics for a Claude Code session, read from the transcript files Claude Code itself writes
 * (~/.claude/projects/<project>/<session>.jsonl). Read-only and incremental: only newly appended
 * bytes are parsed. Nothing is installed into Claude's settings (no hooks), and prompt text is
 * never forwarded, only tool names, file paths, counts and token usage.
 */
export interface AgentEvent { at: string; kind: 'tool' | 'text' | 'todo' | 'subagent'; tool?: string; target?: string; sidechain: boolean }
export interface Metrics {
  session: string | null
  inputTokens: number
  outputTokens: number
  cacheRead: number
  cacheCreate: number
  turns: number
  tools: Record<string, number>
  files: string[]
  subagentCalls: number
  todos: { text: string; status: string }[]
  model: string | null
}
export const emptyMetrics = (): Metrics => ({ session: null, inputTokens: 0, outputTokens: 0, cacheRead: 0, cacheCreate: 0, turns: 0, tools: {}, files: [], subagentCalls: 0, todos: [], model: null })

/** Claude Code names a project folder after its absolute path with every non-alphanumeric turned into "-". */
export const projectDirName = (cwd: string) => cwd.replace(/[^a-zA-Z0-9]/g, '-')

/** `since`: ignore transcripts last written before this moment, so a fresh terminal never shows an old session's numbers. */
export function newestTranscript(cwd: string, since = 0): string | null {
  const dir = join(homedir(), '.claude', 'projects', projectDirName(cwd))
  if (!existsSync(dir)) return null
  let best: { f: string; t: number } | null = null
  for (const name of readdirSync(dir)) {
    if (!name.endsWith('.jsonl')) continue
    const f = join(dir, name)
    const t = statSync(f).mtimeMs
    if (t < since) continue
    if (!best || t > best.t) best = { f, t }
  }
  return best?.f ?? null
}

const FILE_TOOLS = new Set(['Read', 'Edit', 'Write', 'MultiEdit', 'NotebookEdit'])
const seenUsage = new Set<string>()
const seenTools = new Set<string>()

/** Apply one transcript line to the running metrics; returns the events it produced. */
export function applyLine(line: string, m: Metrics): AgentEvent[] {
  let o: any
  try { o = JSON.parse(line) } catch { return [] }
  const events: AgentEvent[] = []
  const at = typeof o.timestamp === 'string' ? o.timestamp : new Date().toISOString()
  const side = o.isSidechain === true
  if (o.sessionId) m.session = o.sessionId
  if (o.type !== 'assistant' || !o.message) return events
  const msg = o.message
  if (msg.model) m.model = msg.model
  // Streaming writes the same response several times: count each message id's usage once.
  const uid = msg.id ?? o.uuid
  if (msg.usage && uid && !seenUsage.has(uid)) {
    seenUsage.add(uid)
    m.inputTokens += msg.usage.input_tokens ?? 0
    m.outputTokens += msg.usage.output_tokens ?? 0
    m.cacheRead += msg.usage.cache_read_input_tokens ?? 0
    m.cacheCreate += msg.usage.cache_creation_input_tokens ?? 0
    m.turns += 1
  }
  for (const b of Array.isArray(msg.content) ? msg.content : []) {
    if (b.type === 'tool_use') {
      // The same tool call can be written again as the response streams: count it once.
      if (b.id) { if (seenTools.has(b.id)) continue; seenTools.add(b.id) }
      m.tools[b.name] = (m.tools[b.name] ?? 0) + 1
      const input = b.input ?? {}
      const target = typeof input.file_path === 'string' ? input.file_path : typeof input.command === 'string' ? String(input.command).slice(0, 80) : typeof input.pattern === 'string' ? input.pattern : undefined
      if (FILE_TOOLS.has(b.name) && typeof input.file_path === 'string' && !m.files.includes(input.file_path)) m.files.push(input.file_path)
      if (b.name === 'Task' || b.name === 'Agent') { m.subagentCalls += 1; events.push({ at, kind: 'subagent', tool: b.name, target: input.description ?? input.subagent_type, sidechain: side }) }
      else if (b.name === 'TodoWrite' && Array.isArray(input.todos)) {
        m.todos = input.todos.map((t: any) => ({ text: String(t.content ?? t.subject ?? '').slice(0, 120), status: String(t.status ?? '') }))
        events.push({ at, kind: 'todo', tool: b.name, sidechain: side })
      } else events.push({ at, kind: 'tool', tool: b.name, target, sidechain: side })
    }
  }
  return events
}

/** Polls one transcript for appended lines. `onEvents` gets new events plus the updated metrics. */
export function watchSession(cwd: string, onUpdate: (m: Metrics, ev: AgentEvent[]) => void, since = Date.now() - 2000): () => void {
  let file: string | null = null
  let offset = 0
  let tail = ''
  let m = emptyMetrics()
  const tick = () => {
    const newest = newestTranscript(cwd, since)
    if (!newest) return
    if (newest !== file) { file = newest; offset = 0; tail = ''; m = emptyMetrics(); seenUsage.clear(); seenTools.clear() }
    const size = statSync(file).size
    if (size <= offset) return
    const fd = openSync(file, 'r')
    try {
      const buf = Buffer.alloc(Math.min(size - offset, 4_000_000))
      const n = readSync(fd, buf, 0, buf.length, offset)
      offset += n
      const lines = (tail + buf.subarray(0, n).toString('utf8')).split('\n')
      tail = lines.pop() ?? ''
      const ev = lines.flatMap((l) => (l.trim() ? applyLine(l, m) : []))
      onUpdate({ ...m, tools: { ...m.tools }, files: [...m.files], todos: [...m.todos] }, ev)
    } finally {
      closeSync(fd)
    }
  }
  const t = setInterval(() => { try { tick() } catch { /* file rotated mid-read: next tick recovers */ } }, 1000)
  tick()
  return () => clearInterval(t)
}
