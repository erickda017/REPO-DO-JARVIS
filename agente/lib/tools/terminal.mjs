// terminal + process tools. Behaviour and descriptions follow tools/terminal_tool.py and tools/process_registry.py from
// Hermes Agent (c) 2025 Nous Research, MIT License; the shell here is PowerShell on Windows and bash elsewhere.
import { spawn, execFile } from 'node:child_process'
import { mkdirSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { resolvePath } from './files.mjs'

const WIN = process.platform === 'win32'
const MAX_OUTPUT = 50_000
const DEFAULT_TIMEOUT = 180
const MAX_TIMEOUT = 3600
const MARK = '__JVX__'

const killTree = (child) => {
  if (!child?.pid) return
  if (WIN) execFile('taskkill', ['/pid', String(child.pid), '/t', '/f'], { windowsHide: true }, () => {})
  else { try { process.kill(-child.pid, 'SIGKILL') } catch { try { child.kill('SIGKILL') } catch { /* gone */ } } }
}

/** Builds the argv + stdin script for one command, ending with a trailer that reports the exit code and the final cwd. */
function shellFor(command, cwd, trailer) {
  if (WIN) {
    const q = (s) => `'${String(s).replace(/'/g, "''")}'`
    const script = [
      "[Console]::OutputEncoding=[Text.Encoding]::UTF8; $OutputEncoding=[Text.Encoding]::UTF8; $ProgressPreference='SilentlyContinue'",
      `Set-Location -LiteralPath ${q(cwd)}`,
      command,
      '$__ok = $?; $__ec = if ($LASTEXITCODE -is [int] -and $LASTEXITCODE -ne 0) { $LASTEXITCODE } elseif ($__ok) { 0 } else { 1 }',
      trailer ? `[Console]::Out.Write("\`n${MARK}" + $__ec + "${MARK}" + (Get-Location).Path + "${MARK}")` : '',
      'exit $__ec',
    ].join('\n')
    return { file: 'powershell.exe', args: ['-NoLogo', '-NoProfile', '-NonInteractive', '-ExecutionPolicy', 'Bypass', '-EncodedCommand', Buffer.from(script, 'utf16le').toString('base64')] }
  }
  const script = `cd ${JSON.stringify(cwd)} || exit 1\n${command}\n__ec=$?\n${trailer ? `printf '\\n${MARK}%s${MARK}%s${MARK}' "$__ec" "$PWD"` : ''}\nexit $__ec`
  return { file: 'bash', args: ['-c', script] }
}

export class ProcessRegistry {
  constructor() { this.procs = new Map(); this.n = 0 }
  start({ command, cwd, pty = false }) {
    const id = `proc_${++this.n}`
    const sh = shellFor(command, cwd, false)
    const child = spawn(sh.file, sh.args, { cwd, windowsHide: true, detached: !WIN, stdio: ['pipe', 'pipe', 'pipe'] })
    const rec = { id, command, cwd, pid: child.pid, started: Date.now(), buf: '', total: 0, exitCode: null, child, pty }
    const add = (d) => { const s = d.toString('utf8'); rec.total += s.length; rec.buf = (rec.buf + s).slice(-200_000) }
    child.stdout.on('data', add); child.stderr.on('data', add)
    child.on('exit', (code) => { rec.exitCode = code ?? -1; rec.ended = Date.now() })
    child.on('error', (e) => { rec.exitCode = -1; rec.buf += `\n[erro ao iniciar: ${e.message}]`; rec.ended = Date.now() })
    this.procs.set(id, rec)
    return rec
  }
  get(id) { return this.procs.get(id) }
  view(r, tail = 4000) {
    return { session_id: r.id, command: r.command.slice(0, 200), pid: r.pid, running: r.exitCode === null, exit_code: r.exitCode, runtime_s: Math.round(((r.ended ?? Date.now()) - r.started) / 1000), output_tail: r.buf.slice(-tail) }
  }
  killAll() { for (const r of this.procs.values()) if (r.exitCode === null) killTree(r.child) }
}

/** Head + tail of a long output, with the whole thing saved to a file the model can read_file. */
export function capOutput(text) {
  if (text.length <= MAX_OUTPUT) return { text }
  const dir = join(tmpdir(), 'jarvis-agente'); mkdirSync(dir, { recursive: true })
  const file = join(dir, `out-${Date.now()}.txt`)
  writeFileSync(file, text)
  const head = text.slice(0, 15_000), tail = text.slice(-30_000)
  return { text: `${head}\n\n… [${text.length - 45_000} caracteres omitidos; saída completa em ${file} — use read_file com offset/limit ou search_files] …\n\n${tail}`, file }
}

export function terminalTools({ getCwd, setCwd, approver, registry, signal }) {
  const terminal = {
    name: 'terminal', readOnly: false,
    description: `Execute shell commands. The host is ${WIN ? 'Windows and the shell is PowerShell 5.1 (use PowerShell syntax; ";" not "&&")' : 'a POSIX system with bash'} — write commands for THAT platform. The current working directory persists between calls (use the "cwd" field of the result instead of prefixing "cd"); exported environment variables do not.\n\nDo NOT use cat/head/tail/type (use read_file), grep/rg/find/ls/dir (use search_files), sed/awk (use patch), or echo/heredoc file creation (use write_file). Reserve terminal for: builds, installs, git, processes, scripts, network, package managers — anything that needs a shell. Output is auto-truncated with the full text saved to a file — never pipe through tail/head to shorten it.\n\nForeground (default): returns when the command finishes, even with a high timeout — set timeout generously for long builds.\nBackground: set background=true (returns a session_id) only for commands that must keep running after this call returns (servers, watchers). Do not start sleeps or polling loops with background=true. After starting a server, verify readiness with a health check in a separate call; manage with process(action="poll"/"wait"/"log"/"kill").\nWorking directory: use 'workdir' for a per-command cwd.\nInteractive programs that wait for input will hang: use non-interactive flags (-y, --yes, --non-interactive).`,
    parameters: { type: 'object', properties: { command: { type: 'string', description: 'The command to execute' }, background: { type: 'boolean', description: 'Run in the background and return a session_id (servers/watchers only)' }, timeout: { type: 'integer', description: `Max seconds to wait (default ${DEFAULT_TIMEOUT}, max ${MAX_TIMEOUT})` }, workdir: { type: 'string', description: 'Working directory for this command only' } }, required: ['command'] },
    async run({ command, background = false, timeout = DEFAULT_TIMEOUT, workdir }) {
      if (typeof command !== 'string' || !command.trim()) return { error: 'terminal: command is required (a non-empty string).' }
      const verdict = await approver.check(command)
      if (!verdict.allowed) return { error: verdict.reason, blocked: true }
      const cwd = workdir ? resolvePath(getCwd(), workdir) : getCwd()
      if (background) {
        const r = registry.start({ command, cwd })
        await new Promise((res) => setTimeout(res, 1200))
        return { ...registry.view(r), note: 'Em segundo plano. Use process(action="poll", session_id=…) para ver a saída e confirmar que subiu.' }
      }
      const secs = Math.min(Math.max(Number(timeout) || DEFAULT_TIMEOUT, 1), MAX_TIMEOUT)
      const sh = shellFor(command, cwd, true)
      return await new Promise((resolve) => {
        const child = spawn(sh.file, sh.args, { cwd, windowsHide: true, detached: !WIN, stdio: ['ignore', 'pipe', 'pipe'] })
        let out = '', err = '', timedOut = false
        const t = setTimeout(() => { timedOut = true; killTree(child) }, secs * 1000)
        const onAbort = () => killTree(child)
        signal?.addEventListener('abort', onAbort, { once: true })
        child.stdout.on('data', (d) => { out += d.toString('utf8'); if (out.length > 5_000_000) out = out.slice(-2_000_000) })
        child.stderr.on('data', (d) => { err += d.toString('utf8'); if (err.length > 1_000_000) err = err.slice(-500_000) })
        child.on('error', (e) => { clearTimeout(t); resolve({ error: `não consegui iniciar o shell: ${e.message}` }) })
        child.on('close', (code) => {
          clearTimeout(t)
          signal?.removeEventListener('abort', onAbort)
          let exit = code ?? -1, newCwd = cwd
          const i = out.lastIndexOf(MARK)
          const m = new RegExp(`\\n?${MARK}(-?\\d+)${MARK}([\\s\\S]*?)${MARK}\\s*$`).exec(out)
          if (m) { exit = Number(m[1]); newCwd = m[2].trim() || cwd; out = out.slice(0, m.index) } else if (i >= 0) out = out.slice(0, i)
          if (!workdir && newCwd !== cwd) setCwd(newCwd)
          const body = capOutput([out.trimEnd(), err.trim() ? `${out.trim() ? '\n' : ''}[stderr]\n${err.trimEnd()}` : ''].join(''))
          resolve({ output: body.text, exit_code: timedOut ? -1 : exit, cwd: workdir ? cwd : newCwd, ...(timedOut ? { timed_out: true, error: `Tempo esgotado após ${secs}s; o comando foi encerrado. Use um timeout maior, ou background=true se for um servidor.` } : {}), ...(body.file ? { full_output_file: body.file } : {}) })
        })
      })
    },
  }

  const proc = {
    name: 'process', readOnly: false,
    description: 'Manage background processes started with terminal(background=true). Actions: list, poll (new output + status), log (last N chars), wait (until it exits or timeout), write (send text to stdin), kill.',
    parameters: { type: 'object', properties: { action: { type: 'string', enum: ['list', 'poll', 'log', 'wait', 'write', 'kill'] }, session_id: { type: 'string' }, data: { type: 'string', description: 'Text for action=write' }, timeout: { type: 'integer', description: 'Seconds for action=wait (default 60)' }, chars: { type: 'integer', description: 'How many trailing characters for log (default 4000)' } }, required: ['action'] },
    async run({ action, session_id, data, timeout = 60, chars = 4000 }) {
      if (action === 'list') return { processes: [...registry.procs.values()].map((r) => registry.view(r, 200)) }
      const r = registry.get(String(session_id))
      if (!r) return { error: `No such session_id: ${session_id}. Use process(action="list").` }
      if (action === 'poll' || action === 'log') return registry.view(r, Math.min(Number(chars) || 4000, 50_000))
      if (action === 'wait') {
        const end = Date.now() + Math.min(Number(timeout) || 60, 600) * 1000
        while (r.exitCode === null && Date.now() < end && !signal?.aborted) await new Promise((res) => setTimeout(res, 300))
        return registry.view(r)
      }
      if (action === 'write') { if (r.exitCode !== null) return { error: 'The process has already exited.' }; r.child.stdin.write(String(data ?? '')); return { ok: true } }
      if (action === 'kill') { killTree(r.child); await new Promise((res) => setTimeout(res, 400)); return { ...registry.view(r, 500), killed: true } }
      return { error: `unknown action ${action}` }
    },
  }
  return [terminal, proc]
}
