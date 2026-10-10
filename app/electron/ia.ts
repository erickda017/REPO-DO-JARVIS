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

const PORTS = { chat: 8080, pesado: 8081, leve: 8082 } as const
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

export async function iaStatus(root: string | null): Promise<IaStatus> {
  const [chat, pesado, leve] = await Promise.all([portOpen(PORTS.chat), portOpen(PORTS.pesado), portOpen(PORTS.leve)])
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

/** Uses the project's own PARAR_IA.bat (it matches llama-server by command line and the C.R.I.S node process). */
export async function iaStop(root: string | null): Promise<IaStatus> {
  if (!iaValid(root)) return { ...(await iaStatus(root)), error: 'Pasta da IA local não encontrada.' }
  await new Promise<void>((resolve) => execFile('cmd.exe', ['/c', 'PARAR_IA.bat', 'silencioso'], { cwd: root, windowsHide: true, timeout: 20000 }, () => resolve()))
  await new Promise((r) => setTimeout(r, 1500))
  return iaStatus(root)
}
