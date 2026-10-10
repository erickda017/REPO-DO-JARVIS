import { execFile, spawn } from 'node:child_process'
import { closeSync, existsSync, mkdirSync, openSync, readFileSync } from 'node:fs'
import net from 'node:net'
import { freemem, totalmem } from 'node:os'
import { join } from 'node:path'

/**
 * Starts and stops the owner's local AI (llama.cpp servers + the C.R.I.S Node server) from the app.
 *
 * Nothing here replaces the AI project's own logic: the launch commands are the ones its `_iniciar.bat` uses
 * (the light model's file name is even read from that script), and stopping goes through its own `PARAR_IA.bat`,
 * so C.R.I.S, `modos.ini`, the Umbra bridge and the desktop shortcuts keep behaving exactly as before.
 */
export type IaMode = 'leve' | 'so-ia' | 'so-cris' | 'completo'
export interface IaStatus {
  root: string | null
  valid: boolean
  ports: { chat: boolean; pesado: boolean; leve: boolean }
  freeGB: number
  totalGB: number
  error?: string
}

const PORTS = { chat: 8080, pesado: 8081, leve: 8082 }
const HEAVY_NEEDS_GB = 12

const portOpen = (port: number) =>
  new Promise<boolean>((resolve) => {
    const s = net.connect({ host: '127.0.0.1', port })
    s.setTimeout(800, () => (s.destroy(), resolve(false)))
    s.once('connect', () => (s.destroy(), resolve(true)))
    s.once('error', () => resolve(false))
  })

export const iaValid = (root: string | null): root is string =>
  Boolean(root && existsSync(join(root, 'llama', 'llama-server.exe')) && existsSync(join(root, 'modos.ini')) && existsSync(join(root, '_iniciar.bat')))

export async function iaStatus(root: string | null, ports: typeof PORTS = PORTS): Promise<IaStatus> {
  const [chat, pesado, leve] = await Promise.all([portOpen(ports.chat), portOpen(ports.pesado), portOpen(ports.leve)])
  return { root, valid: iaValid(root), ports: { chat, pesado, leve }, freeGB: +(freemem() / 2 ** 30).toFixed(1), totalGB: +(totalmem() / 2 ** 30).toFixed(1) }
}

/** `set MODELO_LEVE=...` out of the project's own launcher, so a renamed model keeps working. */
function lightModel(root: string): string | null {
  try {
    const m = /^\s*set\s+MODELO_LEVE=(.+)$/im.exec(readFileSync(join(root, '_iniciar.bat'), 'utf8'))
    const rel = m?.[1].trim().replace(/"/g, '')
    return rel && existsSync(join(root, rel)) ? rel : null
  } catch {
    return null
  }
}

function launch(root: string, logDir: string, name: string, file: string, args: string[]) {
  mkdirSync(logDir, { recursive: true })
  const fd = openSync(join(logDir, `${name}.log`), 'a')
  const child = spawn(file, args, { cwd: root, detached: true, stdio: ['ignore', fd, fd], windowsHide: true })
  child.on('error', () => { /* ENOENT etc.: the port check below reports that nothing came up */ })
  child.unref()
  closeSync(fd)
  return child.pid
}

export async function iaStart(root: string | null, mode: IaMode, logDir: string): Promise<IaStatus> {
  if (!iaValid(root)) return { ...(await iaStatus(root)), error: 'Pasta da IA local não encontrada. Escolha a pasta que contém llama\\llama-server.exe e _iniciar.bat.' }
  const st = await iaStatus(root)
  const wantHeavy = mode === 'so-ia' || mode === 'completo'
  const wantChat = mode !== 'leve'
  if (wantHeavy && !st.ports.pesado && st.freeGB < HEAVY_NEEDS_GB) {
    return { ...st, error: `A IA pesada precisa de uns ${HEAVY_NEEDS_GB} GB de RAM livre e só há ${st.freeGB} GB. Feche programas pesados ou use o modo leve.` }
  }
  const exe = join(root, 'llama', 'llama-server.exe')
  if (wantHeavy && !st.ports.pesado) {
    launch(root, logDir, 'pesado', exe, ['--models-preset', 'modos.ini', '--models-max', '1', '--host', '127.0.0.1', '--port', String(PORTS.pesado), '--cors-origins', `http://127.0.0.1:${PORTS.chat}`, '--log-verbosity', '1'])
  }
  if (!st.ports.leve) {
    const model = lightModel(root)
    if (!model) return { ...st, error: 'Não achei o modelo leve (MODELO_LEVE no _iniciar.bat).' }
    launch(root, logDir, 'leve', exe, ['-m', model, '-ngl', '99', '-t', '4', '-c', '16384', '-np', '1', '--load-mode', 'none', '--host', '127.0.0.1', '--port', String(PORTS.leve), '--alias', '0-leve-conversa', '--reasoning', 'off', '--temp', '0.8', '--top-p', '0.9', '--top-k', '20', '--log-verbosity', '1'])
  }
  if (wantChat && !st.ports.chat) {
    launch(root, logDir, 'cris', 'node', [join('cris', 'servidor.js'), ...(mode === 'so-ia' ? ['--sem-cris'] : [])])
  }
  // Give the servers a moment to open their sockets, then report what is actually listening.
  await new Promise((r) => setTimeout(r, 2500))
  return iaStatus(root)
}

interface PortOwner { pid: number; port: number; name: string; cmd: string }

/** Who is LISTENING on these ports right now (name and command line included). */
export function portOwners(ports: number[]): Promise<PortOwner[]> {
  const script = `Get-NetTCPConnection -State Listen -LocalPort ${ports.join(',')} -ErrorAction SilentlyContinue | ForEach-Object { $p = Get-CimInstance Win32_Process -Filter ("ProcessId=" + $_.OwningProcess); [pscustomobject]@{ pid = [int]$_.OwningProcess; port = [int]$_.LocalPort; name = [string]$p.Name; cmd = [string]$p.CommandLine } } | ConvertTo-Json -Compress`
  return new Promise((resolve) =>
    execFile('powershell.exe', ['-NoProfile', '-NonInteractive', '-Command', script], { windowsHide: true, timeout: 15000 }, (_e, out) => {
      try {
        const j = JSON.parse(String(out).trim() || '[]')
        resolve((Array.isArray(j) ? j : [j]).filter((x) => x && Number.isInteger(x.pid)))
      } catch {
        resolve([])
      }
    }),
  )
}

/** Only processes that belong to the local AI may be force-killed: the llama servers, and the C.R.I.S node server. */
const isLocalAi = (o: PortOwner, root: string) =>
  /^llama-server(\.exe)?$/i.test(o.name) || (/^node(\.exe)?$/i.test(o.name) && (/cris[\\/]servidor\.js/i.test(o.cmd) || o.cmd.toLowerCase().includes(root.toLowerCase())))

const killTree = (pid: number) => new Promise<void>((resolve) => execFile('taskkill', ['/pid', String(pid), '/T', '/F'], { windowsHide: true, timeout: 10000 }, () => resolve()))
const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms))

/**
 * Stops the local AI. First the project's own PARAR_IA.bat (it matches llama-server by command line and the C.R.I.S node
 * process). That is not enough when the match misses (a server started another way) or something starts it again, so the
 * result is then CHECKED: whatever still listens on the AI's ports is looked up and, when it is part of the local AI,
 * force-killed (with its children); a second look catches anything that came back. If a port is still taken afterwards the
 * error names the process, so the button never reports success it did not achieve.
 */
export async function iaStop(root: string | null, opts: { ports?: Partial<typeof PORTS>; settleMs?: number } = {}): Promise<IaStatus> {
  if (!iaValid(root)) return { ...(await iaStatus(root)), error: 'Pasta da IA local não encontrada.' }
  const ports = { ...PORTS, ...(opts.ports ?? {}) }
  const settle = opts.settleMs ?? 1500
  // Absolute path, quoted for cmd (the current directory is not searched for scripts, and the folder may contain spaces).
  const bat = join(root, 'PARAR_IA.bat')
  await new Promise<void>((resolve) => execFile('cmd.exe', ['/d', '/s', '/c', `"${bat}" silencioso`], { cwd: root, windowsHide: true, timeout: 20000, windowsVerbatimArguments: true }, () => resolve()))
  await sleep(settle)
  let left: PortOwner[] = []
  for (let attempt = 0; attempt < 3; attempt++) {
    left = await portOwners(Object.values(ports))
    if (!left.length) {
      await sleep(settle) // something may start it again right after: look once more before declaring victory
      left = await portOwners(Object.values(ports))
      if (!left.length) break
    }
    for (const o of left) if (isLocalAi(o, root)) await killTree(o.pid)
    await sleep(settle)
  }
  const st = await iaStatus(root, ports)
  if (left.length) {
    const still = await portOwners(Object.values(ports))
    if (still.length) {
      const what = still.map((o) => `porta ${o.port}: ${o.name || '?'} (PID ${o.pid})${isLocalAi(o, root) ? ' — religou sozinho' : ' — não é da IA local, feche-o você'}`).join('; ')
      return { ...st, error: `Não consegui desligar tudo: ${what}.` }
    }
  }
  return st
}