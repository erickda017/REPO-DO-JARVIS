import { execFile, spawn } from 'node:child_process'
import { existsSync, mkdirSync, statSync } from 'node:fs'
import { join } from 'node:path'
import http from 'node:http'
import { AgentError } from './access.mjs'
import { isWindows, ps } from './winps.mjs'

/**
 * Development tools: git (read + a non-destructive checkpoint), running a project's own commands (tests, linters,
 * builds), local dev servers, a local-only HTTP probe and a screen capture. Same contract as tools.mjs: each tool
 * declares group + risk, paths go through access.resolveInside, anything that runs project code is `danger` and
 * therefore confirmed with the exact command line, and results are honest (an exit code is reported, never turned
 * into "it worked").
 */
const clip = (s, n) => (String(s).length > n ? '… [início cortado]\n' + String(s).slice(-n) : String(s))
const yes = (v) => v === true || v === 'true'

// Programs a project may run. No shell interpreter, no downloaders, no package publishers.
const PROGRAMS = new Set(['node', 'npm', 'npx', 'pnpm', 'yarn', 'python', 'python3', 'py', 'pytest', 'dotnet', 'cargo', 'go', 'tsc', 'deno', 'bun'])
// Arguments cannot carry shell metacharacters (Windows .cmd shims go through cmd.exe).
const SAFE_ARG = /^[\w@.:=,+/\\ \-]{1,300}$/
const BLOCKED_NPM = /^(publish|login|logout|adduser|token|owner|access|deprecate|unpublish)$/i

function parseArgs(args) {
  const list = Array.isArray(args) ? args.map(String) : String(args ?? '').trim().split(/\s+/).filter(Boolean)
  if (list.length > 24) throw new AgentError('args', 'argumentos demais (máximo 24)')
  for (const a of list) if (!SAFE_ARG.test(a)) throw new AgentError('args', `argumento recusado (caracteres não permitidos): ${a.slice(0, 60)}`)
  return list
}

function validateRun(program, args) {
  const p = String(program ?? '').toLowerCase().replace(/\.(cmd|exe)$/, '')
  if (!PROGRAMS.has(p)) throw new AgentError('program', `programa não permitido: ${program}. Permitidos: ${[...PROGRAMS].join(', ')}`)
  const a = parseArgs(args)
  if (['npm', 'pnpm', 'yarn'].includes(p) && BLOCKED_NPM.test(a[0] ?? '')) throw new AgentError('program', `${p} ${a[0]} não é permitido (publicar/autenticar não é trabalho do agente)`)
  return { p, a }
}

/** Runs a program in cwd; resolves with the exit code and the tail of its output (never rejects on a non-zero exit). */
function runProgram(p, a, cwd, timeoutMs) {
  return new Promise((resolve) => {
    // On Windows npm/npx/yarn/pnpm/tsc are .cmd shims: go through cmd.exe (arguments are already restricted to a safe alphabet).
    const useCmd = isWindows && ['npm', 'npx', 'pnpm', 'yarn', 'tsc', 'pytest'].includes(p)
    const file = useCmd ? 'cmd.exe' : p
    const argv = useCmd ? ['/d', '/s', '/c', [`${p}.cmd`, ...a].join(' ')] : a
    const child = spawn(file, argv, { cwd, windowsHide: true, env: { ...process.env, CI: '1', FORCE_COLOR: '0', GIT_TERMINAL_PROMPT: '0' } })
    let out = ''
    const add = (d) => { out += d; if (out.length > 200_000) out = out.slice(-100_000) }
    child.stdout.on('data', add)
    child.stderr.on('data', add)
    let timedOut = false
    const timer = setTimeout(() => { timedOut = true; killTree(child.pid) }, timeoutMs)
    child.on('error', (e) => { clearTimeout(timer); resolve({ exitCode: null, output: `não consegui iniciar ${p}: ${e.message}`, timedOut: false }) })
    child.on('close', (code) => { clearTimeout(timer); resolve({ exitCode: code, output: out, timedOut }) })
  })
}

function killTree(pid) {
  if (!pid) return
  if (isWindows) execFile('taskkill', ['/pid', String(pid), '/t', '/f'], { windowsHide: true }, () => {})
  else try { process.kill(-pid, 'SIGKILL') } catch { /* gone */ }
}

const alive = (pid) => { try { process.kill(pid, 0); return true } catch { return false } }

function git(cwd, args, { timeoutMs = 20_000, maxBuffer = 4 * 1024 * 1024 } = {}) {
  return new Promise((resolve, reject) => {
    execFile('git', ['-c', 'core.quotepath=false', '--no-pager', '-C', cwd, ...args], { timeout: timeoutMs, maxBuffer, windowsHide: true, env: { ...process.env, GIT_TERMINAL_PROMPT: '0', GIT_OPTIONAL_LOCKS: '0' } }, (err, stdout, stderr) => {
      if (err) return reject(new AgentError('git', String(stderr || err.message).trim().slice(0, 300)))
      resolve(String(stdout))
    })
  })
}

/** GET restricted to this machine: used to check a local dev server. */
function localGet(url, timeoutMs = 10_000) {
  return new Promise((resolve, reject) => {
    let u
    try { u = new URL(String(url)) } catch { return reject(new AgentError('url', 'url inválida')) }
    if (u.protocol !== 'http:' || !['127.0.0.1', 'localhost', '[::1]'].includes(u.hostname)) return reject(new AgentError('url', 'só http://127.0.0.1, localhost ou [::1] (este PC)'))
    const req = http.get(u, { timeout: timeoutMs, headers: { accept: '*/*', 'user-agent': 'jarvis-agent' } }, (res) => {
      const chunks = []
      let size = 0
      res.on('data', (c) => { size += c.length; if (size < 200_000) chunks.push(c) })
      res.on('end', () => resolve({ status: res.statusCode, type: res.headers['content-type'] ?? null, bytes: size, body: Buffer.concat(chunks).toString('utf8') }))
    })
    req.on('timeout', () => req.destroy(new Error('tempo esgotado')))
    req.on('error', (e) => reject(new AgentError('http', `sem resposta: ${e.code ?? e.message}`)))
  })
}

/** @returns {Record<string, any>} dev tools, closed over the shared access object */
export function buildDevTools({ access, env = process.env, dataDir }) {
  const T = {}
  const def = (name, group, risk, desc, params, run, confirm) => (T[name] = { name, group, risk, desc, params, run, confirm })
  const servers = new Map() // id -> { id, pid, child, cmd, cwd, url, log, startedAt, exit }
  let seq = 0
  process.once('exit', () => { for (const s of servers.values()) killTree(s.pid) })

  // ------------------------------------------------------------------------- git
  const repo = async (path) => {
    const dir = await access.resolveInside(path)
    return dir
  }
  def('git_status', 'files', 'read', 'Estado do Git de um projeto: branch, arquivos alterados/novos, à frente/atrás. Use ANTES de editar um projeto versionado.', { path: 'pasta do projeto' }, async ({ path }) => {
    const dir = await repo(path)
    const out = await git(dir, ['status', '--porcelain=v1', '-b'])
    const lines = out.split('\n').filter(Boolean)
    const branch = (lines[0] ?? '').replace(/^## /, '')
    const files = lines.slice(1).map((l) => ({ state: l.slice(0, 2).trim() || '?', path: l.slice(3) }))
    return { data: { path: dir, branch, clean: files.length === 0, changed: files.length, files: files.slice(0, 100) } }
  })
  def('git_diff', 'files', 'read', 'Mostra o diff de um projeto (não commitado). staged=true para o que está no índice; file para um arquivo.', { path: 'pasta do projeto', file: 'arquivo (opcional)', staged: 'true para o índice' }, async ({ path, file, staged = false }) => {
    const dir = await repo(path)
    const args = ['diff', '--no-color', '--stat', '--patch', ...(yes(staged) ? ['--staged'] : [])]
    if (file) args.push('--', String(file).replace(/^[\\/]+/, ''))
    const out = await git(dir, args)
    return { data: { path: dir, diff: clip(out, 12_000), empty: out.trim() === '' } }
  })
  def('git_log', 'files', 'read', 'Últimos commits de um projeto.', { path: 'pasta do projeto', n: 'quantos (padrão 10)' }, async ({ path, n = 10 }) => {
    const dir = await repo(path)
    const out = await git(dir, ['log', `-n${Math.min(Math.max(Number(n) || 10, 1), 50)}`, '--date=short', '--pretty=format:%h|%ad|%an|%s'])
    return { data: { path: dir, commits: out.split('\n').filter(Boolean).map((l) => { const [hash, date, author, ...s] = l.split('|'); return { hash, date, author, subject: s.join('|') } }) } }
  })
  def('git_checkpoint', 'files', 'write', 'Ponto de recuperação SEM mexer nos arquivos: grava o estado atual (rastreado) numa referência refs/jarvis/checkpoints/*. Use antes de uma mudança grande num projeto versionado.', { path: 'pasta do projeto', label: 'nome curto' }, async ({ path, label = 'checkpoint' }) => {
    const dir = await repo(path)
    const sha = (await git(dir, ['stash', 'create', `jarvis: ${String(label).slice(0, 60)}`])).trim()
    if (!sha) return { data: { path: dir, created: false, note: 'nada a guardar: o projeto não tem alterações rastreadas' }, verified: null, evidence: 'sem alterações' }
    const ref = `refs/jarvis/checkpoints/${new Date().toISOString().replace(/[-:T]/g, '').slice(0, 14)}`
    await git(dir, ['update-ref', ref, sha])
    const back = (await git(dir, ['rev-parse', ref])).trim()
    return { data: { path: dir, ref, sha: sha.slice(0, 10), restore: `git stash apply ${sha.slice(0, 10)}` }, verified: back === sha, evidence: `${ref} -> ${sha.slice(0, 10)}` }
  })

  // ------------------------------------------------------------------------- run project commands
  def('project_run', 'dev', 'danger', `Executa um comando do projeto SEM shell (testes, lint, build, scripts): programas permitidos ${[...PROGRAMS].join(', ')}. Mostra o código de saída e o fim da saída. Timeout máx. 300 s.`, { program: 'ex.: npm', args: 'ex.: test  (lista ou texto)', cwd: 'pasta do projeto', timeoutSec: 'padrão 120' }, async ({ program, args, cwd, timeoutSec = 120 }) => {
    const dir = await access.resolveInside(cwd)
    const { p, a } = validateRun(program, args)
    const r = await runProgram(p, a, dir, Math.min(Math.max(Number(timeoutSec) || 120, 5), 300) * 1000)
    // The exit code is a fact about the process, not a verdict about the task: verified stays null, the agent must read the output.
    return { data: { command: `${p} ${a.join(' ')}`, cwd: dir, exitCode: r.exitCode, timedOut: r.timedOut, output: clip(r.output, 6000) }, verified: null, evidence: r.timedOut ? 'tempo esgotado e processo encerrado' : `saiu com código ${r.exitCode}` }
  }, async ({ program, args, cwd }) => {
    const dir = await access.resolveInside(cwd)
    const { p, a } = validateRun(program, args)
    return `Executar em ${dir}: ${p} ${a.join(' ')}  (roda código do projeto; sem shell)`
  })

  // ------------------------------------------------------------------------- local dev servers
  def('server_start', 'dev', 'danger', 'Inicia um servidor de desenvolvimento em segundo plano (mesmos programas do project_run) e espera responder na url indicada. Devolve um id para consultar/encerrar.', { program: 'ex.: node', args: 'ex.: server.js', cwd: 'pasta do projeto', url: 'http://127.0.0.1:PORTA/ para esperar ficar pronto', readySec: 'padrão 30' }, async ({ program, args, cwd, url, readySec = 30 }) => {
    const dir = await access.resolveInside(cwd)
    const { p, a } = validateRun(program, args)
    if (servers.size >= 4) throw new AgentError('limit', 'já há 4 servidores em execução; encerre um antes')
    const useCmd = isWindows && ['npm', 'npx', 'pnpm', 'yarn', 'tsc'].includes(p)
    const child = spawn(useCmd ? 'cmd.exe' : p, useCmd ? ['/d', '/s', '/c', [`${p}.cmd`, ...a].join(' ')] : a, { cwd: dir, windowsHide: true, env: { ...process.env, CI: '1', FORCE_COLOR: '0' } })
    const s = { id: `srv${++seq}`, pid: child.pid, child, cmd: `${p} ${a.join(' ')}`, cwd: dir, url: url ?? null, log: '', startedAt: Date.now(), exit: null }
    const add = (d) => { s.log += d; if (s.log.length > 100_000) s.log = s.log.slice(-50_000) }
    child.stdout.on('data', add)
    child.stderr.on('data', add)
    child.on('error', (e) => { s.exit = `erro: ${e.message}` })
    child.on('close', (code) => { s.exit = code })
    servers.set(s.id, s)
    let ready = false
    let probe = null
    if (url) {
      const until = Date.now() + Math.min(Math.max(Number(readySec) || 30, 3), 120) * 1000
      while (Date.now() < until && s.exit === null && !ready) {
        try { probe = await localGet(url, 2000); ready = true } catch { await new Promise((r) => setTimeout(r, 400)) }
      }
    } else {
      await new Promise((r) => setTimeout(r, 1500))
      ready = s.exit === null
    }
    return { data: { id: s.id, pid: s.pid, command: s.cmd, url: s.url, ready, status: probe?.status ?? null, exited: s.exit, logTail: clip(s.log, 1500) }, verified: ready, evidence: ready ? (probe ? `respondeu HTTP ${probe.status}` : 'processo está rodando') : s.exit !== null ? `o processo saiu (${s.exit}) antes de ficar pronto` : 'não respondeu a tempo' }
  }, async ({ program, args, cwd }) => {
    const dir = await access.resolveInside(cwd)
    const { p, a } = validateRun(program, args)
    return `Iniciar em segundo plano em ${dir}: ${p} ${a.join(' ')}  (fica rodando até você ou o agente encerrar)`
  })
  def('server_status', 'dev', 'read', 'Estado de um servidor iniciado pelo agente (id) ou de todos: vivo, código de saída, fim do log.', { id: 'id (opcional)' }, async ({ id }) => {
    const list = [...servers.values()].filter((s) => !id || s.id === id)
    if (id && !list.length) throw new AgentError('missing', 'servidor desconhecido')
    return { data: { servers: list.map((s) => ({ id: s.id, pid: s.pid, command: s.cmd, url: s.url, alive: s.exit === null && alive(s.pid), exit: s.exit, upSec: Math.round((Date.now() - s.startedAt) / 1000), logTail: clip(s.log, 1500) })) } }
  })
  def('server_stop', 'dev', 'write', 'Encerra um servidor iniciado pelo agente (e os processos filhos).', { id: 'id do servidor' }, async ({ id }) => {
    const s = servers.get(String(id))
    if (!s) throw new AgentError('missing', 'servidor desconhecido (só encerro os que eu mesmo iniciei)')
    killTree(s.pid)
    for (let i = 0; i < 20 && alive(s.pid); i++) await new Promise((r) => setTimeout(r, 150))
    const gone = !alive(s.pid)
    if (gone) servers.delete(s.id)
    return { data: { id: s.id }, verified: gone, evidence: gone ? `pid ${s.pid} não existe mais` : `pid ${s.pid} ainda existe` }
  })
  def('http_local', 'dev', 'read', 'GET numa URL deste PC (127.0.0.1/localhost): confere a resposta de um servidor local. Qualquer outro host é recusado.', { url: 'http://127.0.0.1:PORTA/caminho' }, async ({ url }) => {
    const r = await localGet(url)
    return { data: { url, status: r.status, type: r.type, bytes: r.bytes, body: clip(r.body, 4000) } }
  })

  // ------------------------------------------------------------------------- screen
  def('screen_capture', 'screen', 'write', 'Captura a tela inteira (todos os monitores) e salva um PNG na pasta de capturas do JARVIS. Devolve o caminho; o arquivo pode mostrar dados privados.', {}, async () => {
    if (!isWindows) throw new AgentError('platform', 'só no Windows')
    const dir = join(dataDir ?? join(process.cwd(), 'data'), 'captures')
    mkdirSync(dir, { recursive: true })
    const file = join(dir, `tela-${new Date().toISOString().replace(/[-:T]/g, '').slice(0, 14)}.png`)
    const out = await ps(`Add-Type -AssemblyName System.Windows.Forms,System.Drawing; $b=[System.Windows.Forms.SystemInformation]::VirtualScreen; $bmp=New-Object System.Drawing.Bitmap $b.Width,$b.Height; $g=[System.Drawing.Graphics]::FromImage($bmp); $g.CopyFromScreen($b.Left,$b.Top,0,0,$bmp.Size); $bmp.Save('${file.replace(/'/g, "''")}',[System.Drawing.Imaging.ImageFormat]::Png); "$($b.Width)x$($b.Height)"`, { timeoutMs: 20_000 })
    const size = existsSync(file) ? statSync(file).size : 0
    return { data: { path: file, resolution: out.trim(), bytes: size }, verified: size > 5000, evidence: `arquivo ${size} bytes, ${out.trim()}` }
  })

  return T
}
