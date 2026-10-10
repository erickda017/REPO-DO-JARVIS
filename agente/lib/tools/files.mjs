// File tools: read_file, write_file, patch, search_files. Behaviour and wording follow tools/file_tools.py and
// tools/file_operations*.py from Hermes Agent (c) 2025 Nous Research, MIT License.
import { createHash } from 'node:crypto'
import { execFile } from 'node:child_process'
import { existsSync, readdirSync, statSync } from 'node:fs'
import { mkdir, readFile, stat, writeFile } from 'node:fs/promises'
import { homedir } from 'node:os'
import { basename, dirname, isAbsolute, join, relative, resolve } from 'node:path'
import { fuzzyFindAndReplace, isAlreadyApplied, noMatchHint } from '../fuzzy.mjs'
import { matchingBlocks } from '../difflib.mjs'

const DEFAULT_READ_LIMIT = 2000
const MAX_READ_CHARS = 100_000
const MAX_LINE_CHARS = 2000
const SKIP_DIRS = new Set(['.git', 'node_modules', '.venv', 'venv', '__pycache__', 'dist', 'build', '.next', 'target', '.cache', 'coverage', '.idea', '.vscode'])

const sha = (b) => createHash('sha1').update(b).digest('hex')
const rel = (cwd, p) => { const r = relative(cwd, p); return r && !r.startsWith('..') && !isAbsolute(r) ? r : p }

export function resolvePath(cwd, p) {
  let s = String(p ?? '').trim()
  if (!s) throw new Error('path is required')
  if (s === '~' || s.startsWith('~/') || s.startsWith('~\\')) s = join(homedir(), s.slice(1))
  return resolve(cwd, s)
}

/** Paths a model must never overwrite on its own: the OS, program folders and credential stores. */
const PROTECTED = [/^[a-z]:\\windows(\\|$)/i, /^[a-z]:\\program files( \(x86\))?(\\|$)/i, /[\\/]\.ssh([\\/]|$)/i, /[\\/]\.gnupg([\\/]|$)/i, /[\\/]appdata[\\/]roaming[\\/]microsoft[\\/]credentials/i, /[\\/]\.aws[\\/]credentials$/i, /^\/(etc|usr|bin|sbin|boot|sys|proc)(\/|$)/]
export const isProtectedPath = (abs) => !/^[a-z]:\\windows\\temp(\\|$)/i.test(abs) && PROTECTED.some((re) => re.test(abs))

const isBinary = (buf) => { const n = Math.min(buf.length, 8000); for (let i = 0; i < n; i++) if (buf[i] === 0) return true; return false }

function similarNames(abs) {
  const dir = dirname(abs)
  try {
    const want = basename(abs).toLowerCase()
    return readdirSync(dir).filter((n) => { const l = n.toLowerCase(); return l.includes(want) || want.includes(l) || (l.slice(0, 4) === want.slice(0, 4) && Math.abs(l.length - want.length) < 6) }).slice(0, 5).map((n) => join(dir, n))
  } catch { return [] }
}

/** Tracks what the model has seen of each file, so a write cannot clobber changes it never read. */
export class ReadTracker {
  constructor() { this.seen = new Map() }
  noteRead(abs, st, full) { const prev = this.seen.get(abs); this.seen.set(abs, { mtimeMs: st.mtimeMs, size: st.size, full: full || (prev?.full === true && prev.mtimeMs === st.mtimeMs) }) }
  noteWrite(abs, st) { this.seen.set(abs, { mtimeMs: st.mtimeMs, size: st.size, full: true }) }
  check(abs, st) {
    const s = this.seen.get(abs)
    if (!s || !s.full) return 'não leu o arquivo inteiro nesta tarefa'
    if (s.mtimeMs !== st.mtimeMs || s.size !== st.size) return 'o arquivo mudou no disco desde a última leitura'
    return null
  }
}

async function lint(abs, text) {
  const ext = abs.slice(abs.lastIndexOf('.')).toLowerCase()
  if (ext === '.json') { try { JSON.parse(text) } catch (e) { return `JSON inválido: ${e.message}` } return null }
  if (['.js', '.mjs', '.cjs'].includes(ext)) {
    return await new Promise((res) => execFile(process.execPath, ['--check', abs], { timeout: 15000, windowsHide: true, env: { ...process.env, ELECTRON_RUN_AS_NODE: '1' } }, (err, _o, stderr) => res(err ? String(stderr).split('\n').slice(0, 6).join('\n').trim() || 'erro de sintaxe' : null)))
  }
  return null
}

/** A compact unified diff built from line-level matching blocks. */
export function unifiedDiff(path, a, b, context = 3) {
  if (a === b) return ''
  const al = a.split('\n'), bl = b.split('\n')
  const blocks = matchingBlocks(al, bl)
  const hunks = []
  let ai = 0, bi = 0
  for (const [i, j, k] of blocks) {
    if (ai < i || bi < j) hunks.push({ a0: ai, a1: i, b0: bi, b1: j })
    ai = i + k; bi = j + k
  }
  const out = [`--- a/${path}`, `+++ b/${path}`]
  let lastEnd = -1
  const groups = []
  for (const h of hunks) {
    const g = groups.at(-1)
    if (g && h.a0 - g.a1 <= context * 2) { g.a1 = h.a1; g.b1 = h.b1; g.parts.push(h) } else groups.push({ a0: h.a0, a1: h.a1, b0: h.b0, b1: h.b1, parts: [h] })
  }
  for (const g of groups) {
    const s = Math.max(0, g.a0 - context), e = Math.min(al.length, g.a1 + context)
    const bs = g.b0 - (g.a0 - s), be = g.b1 + (e - g.a1)
    out.push(`@@ -${s + 1},${e - s} +${bs + 1},${be - bs} @@`)
    let cur = s
    for (const h of g.parts) {
      for (; cur < h.a0; cur++) out.push(' ' + al[cur])
      for (let x = h.a0; x < h.a1; x++) out.push('-' + al[x])
      for (let x = h.b0; x < h.b1; x++) out.push('+' + bl[x])
      cur = h.a1
    }
    for (; cur < e; cur++) out.push(' ' + al[cur])
    lastEnd = e
  }
  void lastEnd
  const text = out.join('\n')
  return text.length > 12_000 ? text.slice(0, 12_000) + '\n… [diff cortado]' : text
}

export function fileTools({ getCwd, tracker, approveWrite }) {
  const check = (abs, write) => { if (write && isProtectedPath(abs)) throw new Error(`Recusado: ${abs} é uma área protegida do sistema ou de credenciais. Peça ao usuário para fazer isso manualmente.`) }

  const read_file = {
    name: 'read_file', readOnly: true,
    description: "Read a text file with line numbers and pagination. Use this instead of cat/head/tail in terminal. Output format: 'LINE_NUM|CONTENT'. Suggests similar filenames if not found. Use offset and limit for large files. Reads exceeding ~100K characters are truncated on a line boundary and return a next_offset; continue with offset to read the rest. Cannot read images/binary.",
    parameters: { type: 'object', properties: { path: { type: 'string', description: 'Path to the file to read (absolute, relative, or ~/path)' }, offset: { type: 'integer', description: 'Line number to start reading from (1-indexed, default: 1)', minimum: 1 }, limit: { type: 'integer', description: 'Maximum number of lines to read (default: 2000, max: 2000).', maximum: 2000 } }, required: ['path'] },
    async run({ path, offset = 1, limit = DEFAULT_READ_LIMIT }) {
      const abs = resolvePath(getCwd(), path)
      let st
      try { st = await stat(abs) } catch {
        const s = similarNames(abs)
        return { error: `File not found: ${abs}`, ...(s.length ? { similar_files: s } : {}) }
      }
      if (st.isDirectory()) return { error: `${abs} is a directory. Use search_files (target='files') or list it with terminal.` }
      if (st.size > 50_000_000) return { error: `File too large (${Math.round(st.size / 1e6)} MB). Use search_files or terminal to inspect parts of it.` }
      const buf = await readFile(abs)
      if (isBinary(buf)) return { error: `${abs} looks binary (${st.size} bytes); read_file reads text only.` }
      const lines = buf.toString('utf8').replace(/\r\n/g, '\n').split('\n')
      if (lines.at(-1) === '') lines.pop()
      const start = Math.max(1, Number(offset) || 1), lim = Math.min(Number(limit) || DEFAULT_READ_LIMIT, DEFAULT_READ_LIMIT)
      const out = []
      let chars = 0, i = start - 1
      for (; i < lines.length && out.length < lim; i++) {
        let l = lines[i]
        if (l.length > MAX_LINE_CHARS) l = l.slice(0, MAX_LINE_CHARS) + ` … [linha cortada, ${l.length} caracteres]`
        if (chars + l.length > MAX_READ_CHARS && out.length) break
        out.push(`${String(i + 1).padStart(6)}|${l}`)
        chars += l.length + 8
      }
      const full = start === 1 && i >= lines.length
      tracker.noteRead(abs, st, full)
      const res = { path: abs, total_lines: lines.length, shown: `${start}-${start + out.length - 1}`, content: out.join('\n') }
      if (i < lines.length) res.next_offset = i + 1
      if (!lines.length) res.note = 'O arquivo está vazio.'
      return res
    },
  }

  const write_file = {
    name: 'write_file', readOnly: false,
    description: "Write content to a file, completely replacing existing content. Use this instead of echo/cat heredoc in terminal. Creates parent directories automatically. OVERWRITES the entire file — use 'patch' for targeted edits. For an EXISTING file, call read_file first: write_file refuses (file untouched) when this task has no current full read/write of the file or the file changed on disk since; on refusal, read_file, merge, then retry. Auto-runs syntax checks on .json/.js/.mjs. The result's verified:true means the on-disk content hash was confirmed — do NOT re-read the file to check the write landed.",
    parameters: { type: 'object', properties: { path: { type: 'string', description: "Path to the file to write (will be created if it doesn't exist, overwritten if it does)" }, content: { type: 'string', description: 'Complete content to write to the file' } }, required: ['path', 'content'] },
    async run(args) {
      if (!args.path || typeof args.path !== 'string') return { error: "write_file: missing required field 'path'. Re-emit the tool call with both 'path' and 'content' set." }
      if (!('content' in args)) return { error: "write_file: missing required field 'content'. The tool call included a path but no content argument — this is almost always a dropped-arg bug under context pressure. Re-emit the tool call with the full content payload." }
      if (typeof args.content !== 'string') return { error: `write_file: 'content' must be a string, got ${typeof args.content}.` }
      const abs = resolvePath(getCwd(), args.path)
      check(abs, true)
      let existed = false
      try {
        const st = await stat(abs)
        existed = true
        if (st.isDirectory()) return { error: `${abs} is a directory.` }
        const why = tracker.check(abs, st)
        if (why) return { error: `write_file recusado (arquivo intacto): ${why}. Use read_file no arquivo inteiro, junte a sua mudança e tente de novo — ou use patch para uma mudança pontual.` }
      } catch { /* new file */ }
      await approveWrite?.(abs, existed)
      await mkdir(dirname(abs), { recursive: true })
      const before = existed ? await readFile(abs, 'utf8').catch(() => '') : ''
      await writeFile(abs, args.content, 'utf8')
      const back = await readFile(abs)
      const ok = sha(back) === sha(Buffer.from(args.content, 'utf8'))
      tracker.noteWrite(abs, await stat(abs))
      const lintErr = await lint(abs, args.content)
      return { success: ok, path: abs, bytes: back.length, created: !existed, verified: ok, ...(lintErr ? { lint_error: lintErr } : {}), ...(existed && before !== args.content ? { diff: unifiedDiff(rel(getCwd(), abs), before, args.content) } : {}) }
    },
  }

  const patch = {
    name: 'patch', readOnly: false,
    description: 'Targeted find-and-replace edits in files. Use this instead of sed/awk in terminal. Uses fuzzy matching (9 strategies) so minor whitespace/indentation differences won\'t break it. Returns a unified diff. Auto-runs syntax checks after editing. Finds a unique string and replaces it.',
    parameters: { type: 'object', properties: { path: { type: 'string', description: 'File path to edit.' }, old_string: { type: 'string', description: 'Exact text to find and replace. Must be unique in the file unless replace_all=true. Include surrounding context lines to ensure uniqueness.' }, new_string: { type: 'string', description: "Changed replacement text; it must differ from old_string. Pass empty string '' to delete the matched text." }, replace_all: { type: 'boolean', description: 'Replace all occurrences instead of requiring a unique match (default: false)' } }, required: ['path', 'old_string', 'new_string'] },
    async run({ path, old_string, new_string, replace_all = false }) {
      if (typeof path !== 'string' || typeof old_string !== 'string' || typeof new_string !== 'string') return { error: 'patch: path, old_string and new_string must all be strings. Re-emit the call with all three.' }
      const abs = resolvePath(getCwd(), path)
      check(abs, true)
      let st
      try { st = await stat(abs) } catch { return { error: `File not found: ${abs}`, ...(similarNames(abs).length ? { similar_files: similarNames(abs) } : {}) } }
      const raw = await readFile(abs, 'utf8')
      const crlf = raw.includes('\r\n')
      const content = raw.replace(/\r\n/g, '\n')
      if (isAlreadyApplied(content, old_string, new_string)) return { success: true, path: abs, replacements: 0, note: 'A edição já estava aplicada; nada a fazer.' }
      const r = fuzzyFindAndReplace(content, old_string.replace(/\r\n/g, '\n'), new_string.replace(/\r\n/g, '\n'), replace_all)
      if (r.error) return { error: r.error + noMatchHint(r.error, r.count, old_string, content) }
      await approveWrite?.(abs, true)
      const out = crlf ? r.content.replace(/\n/g, '\r\n') : r.content
      await writeFile(abs, out, 'utf8')
      const nst = await stat(abs)
      tracker.noteWrite(abs, nst)
      const lintErr = await lint(abs, out)
      void st
      return { success: true, path: abs, replacements: r.count, strategy: r.strategy, diff: unifiedDiff(rel(getCwd(), abs), content, r.content), ...(lintErr ? { lint_error: lintErr } : {}) }
    },
  }

  const search_files = {
    name: 'search_files', readOnly: true,
    description: "Search file contents or find files by name. Use this instead of grep/rg/find/ls in terminal. Content search (target='content'): regex search inside files; output modes: full matches with line numbers, file paths only, or match counts. File search (target='files'): find files by glob pattern (e.g. '*.py', '*config*'); also use this instead of ls.",
    parameters: { type: 'object', properties: { pattern: { type: 'string', description: "Regex pattern for content search, or glob pattern (e.g., '*.py') for file search" }, target: { type: 'string', enum: ['content', 'files'], description: "'content' searches inside file contents, 'files' searches for files by name" }, path: { type: 'string', description: 'Directory or file to search in (default: current working directory)' }, file_glob: { type: 'string', description: "Filter files by pattern in grep mode (e.g., '*.py' to only search Python files)" }, limit: { type: 'integer', description: 'Maximum number of results to return (default: 50)' }, offset: { type: 'integer', description: 'Skip first N results for pagination (default: 0)' }, output_mode: { type: 'string', enum: ['content', 'files_only', 'count'], description: "Output format for grep mode: 'content' shows matching lines with line numbers, 'files_only' lists file paths, 'count' shows match counts per file" }, context: { type: 'integer', description: 'Number of context lines before and after each match (grep mode only)' } }, required: ['pattern'] },
    async run({ pattern, target = 'content', path = '.', file_glob, limit = 50, offset = 0, output_mode = 'content', context = 0 }) {
      const root = resolvePath(getCwd(), path)
      if (!existsSync(root)) return { error: `Path not found: ${root}` }
      const globRe = (g) => new RegExp('^' + String(g).replace(/[.+^${}()|[\]\\]/g, '\\$&').replace(/\*\*/g, '\u0000').replace(/\*/g, '[^\\\\/]*').replace(/\u0000/g, '.*').replace(/\?/g, '[^\\\\/]') + '$', 'i')
      const files = []
      const walk = (dir, budget = { n: 0 }) => {
        let entries
        try { entries = readdirSync(dir, { withFileTypes: true }) } catch { return }
        for (const e of entries) {
          if (budget.n++ > 200_000) return
          const full = join(dir, e.name)
          if (e.isDirectory()) { if (!SKIP_DIRS.has(e.name)) walk(full, budget) } else if (e.isFile()) files.push(full)
        }
      }
      const rootStat = statSync(root)
      if (rootStat.isFile()) files.push(root); else walk(root)
      const lim = Math.max(1, Math.min(Number(limit) || 50, 500)), off = Math.max(0, Number(offset) || 0)
      if (target === 'files') {
        const re = globRe(pattern.includes('*') || pattern.includes('?') ? pattern : `*${pattern}*`)
        const hits = files.filter((f) => re.test(basename(f))).map((f) => ({ f, m: statSync(f).mtimeMs })).sort((a, b) => b.m - a.m).map((x) => x.f)
        return { target: 'files', total: hits.length, files: hits.slice(off, off + lim).map((f) => rel(getCwd(), f)), ...(hits.length > off + lim ? { next_offset: off + lim } : {}) }
      }
      let re
      try { re = new RegExp(pattern, 'i') } catch (e) { return { error: `Invalid regex: ${e.message}` } }
      const fre = file_glob ? globRe(file_glob) : null
      const matches = []
      const counts = new Map()
      for (const f of files) {
        if (fre && !fre.test(basename(f))) continue
        let st
        try { st = statSync(f) } catch { continue }
        if (st.size > 5_000_000) continue
        let buf
        try { buf = await readFile(f) } catch { continue }
        if (isBinary(buf)) continue
        const lines = buf.toString('utf8').split(/\r?\n/)
        for (let i = 0; i < lines.length; i++) {
          if (!re.test(lines[i])) continue
          counts.set(f, (counts.get(f) ?? 0) + 1)
          if (output_mode === 'content') {
            const c = Math.max(0, Math.min(Number(context) || 0, 10))
            for (let j = Math.max(0, i - c); j <= Math.min(lines.length - 1, i + c); j++) matches.push(`${rel(getCwd(), f)}${j === i ? ':' : '-'}${j + 1}${j === i ? ':' : '-'}${lines[j].slice(0, 300)}`)
            if (c) matches.push('--')
          }
        }
        if (output_mode === 'content' && matches.length > off + lim * 3) break
      }
      if (output_mode === 'files_only') { const all = [...counts.keys()].map((f) => rel(getCwd(), f)); return { total: all.length, files: all.slice(off, off + lim), ...(all.length > off + lim ? { next_offset: off + lim } : {}) } }
      if (output_mode === 'count') return { total_matches: [...counts.values()].reduce((a, b) => a + b, 0), counts: [...counts].slice(off, off + lim).map(([f, n]) => `${rel(getCwd(), f)}: ${n}`) }
      return { total_matches: [...counts.values()].reduce((a, b) => a + b, 0), matches: matches.slice(off, off + lim), ...(matches.length > off + lim ? { next_offset: off + lim } : {}) }
    },
  }

  return [read_file, write_file, patch, search_files]
}
