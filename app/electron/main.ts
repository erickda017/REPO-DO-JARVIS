import { app, BrowserWindow, dialog, ipcMain, Menu, shell } from 'electron'
import * as pty from '@lydell/node-pty'
import { execFileSync } from 'node:child_process'
import { readFileSync } from 'node:fs'
import { scanProject, type ProjectGraph } from './projects.ts'
import { watchSession } from './transcripts.ts'
import { spawn, type ChildProcess } from 'node:child_process'
import { appendFileSync, copyFileSync, createReadStream, existsSync, mkdirSync, statSync, writeFileSync } from 'node:fs'
import http from 'node:http'
import net from 'node:net'
import { extname, join, normalize, sep } from 'node:path'

const ROOT = app.getAppPath()
const UI_PORT = 5174 // inside the range the bridge accepts as an origin
const BRIDGE_PORT = Number(process.env.JARVIS_BRIDGE_PORT ?? 8787)
const DIST = join(ROOT, 'dist-app')
const DEV_URL = process.env.APP_DEV_URL // set by `npm run app:dev` (Vite dev server)

const MIME: Record<string, string> = {
  '.html': 'text/html; charset=utf-8', '.js': 'text/javascript', '.css': 'text/css', '.json': 'application/json',
  '.woff2': 'font/woff2', '.svg': 'image/svg+xml', '.png': 'image/png', '.ico': 'image/x-icon',
}

let bridge: ChildProcess | null = null
let ui: http.Server | null = null

const portBusy = (port: number) =>
  new Promise<boolean>((resolve) => {
    const s = net.connect({ host: '127.0.0.1', port })
    s.once('connect', () => (s.destroy(), resolve(true)))
    s.once('error', () => resolve(false))
  })

/**
 * Installed builds keep their config and data (tasks, audit log, voice key) per user in
 * %APPDATA%, never next to the executable. On first run the bundled default config is copied
 * there, and from then on that copy is the owner's to edit. Dev runs keep using the repo files.
 */
function userPaths(): Record<string, string> {
  if (!app.isPackaged) return {}
  const dir = app.getPath('userData')
  const config = join(dir, 'command.config.json')
  mkdirSync(dir, { recursive: true })
  const bundled = join(ROOT, 'default-command.config.json')
  if (!existsSync(config) && existsSync(bundled)) copyFileSync(bundled, config)
  return { JARVIS_COMMAND_CONFIG: config, JARVIS_DATA_DIR: join(dir, 'data') }
}

/** Start the bridge as a child unless one is already listening (e.g. started by hand). */
async function startBridge() {
  if (await portBusy(BRIDGE_PORT)) return
  bridge = spawn(process.execPath, [join(ROOT, 'bridge', 'server.mjs')], {
    cwd: ROOT,
    env: { ...process.env, ...userPaths(), ELECTRON_RUN_AS_NODE: '1' },
    stdio: 'ignore',
    windowsHide: true,
  })
}

/** Serve the built renderer from loopback so its origin is one the bridge allows. */
function startUi(): Promise<void> {
  return new Promise((resolve, reject) => {
    ui = http.createServer((req, res) => {
      const path = normalize(decodeURIComponent((req.url ?? '/').split('?')[0]))
      let file = join(DIST, path === sep || path === '/' ? 'index.html' : path)
      if (!file.startsWith(DIST)) return void res.writeHead(403).end() // path traversal guard
      if (!existsSync(file) || statSync(file).isDirectory()) file = join(DIST, 'index.html')
      res.writeHead(200, { 'content-type': MIME[extname(file)] ?? 'application/octet-stream' })
      createReadStream(file).pipe(res)
    })
    ui.once('error', reject)
    ui.listen(UI_PORT, '127.0.0.1', () => resolve())
  })
}

// ---------------------------------------------------------------------------------------------
// Granted project folders + the PROGRAMAR terminal. Both are reachable only through the preload's
// fixed channels, and a terminal can only start inside a folder the owner granted.
// ---------------------------------------------------------------------------------------------
const userFile = (name: string) => join(app.getPath('userData'), name)
const readJson = <T>(file: string, fallback: T): T => {
  // strip a UTF-8 BOM: Windows tools (and PowerShell 5) like to write one
  try { return JSON.parse(readFileSync(file, 'utf8').replace(/^﻿/, '')) as T } catch { return fallback }
}
const writeJson = (file: string, v: unknown) => { mkdirSync(app.getPath('userData'), { recursive: true }); writeFileSync(file, JSON.stringify(v, null, 2)) }

const projectRoots = () => readJson<string[]>(userFile('projects.json'), [])
const scans = new Map<string, ProjectGraph>()
const scanSafe = (root: string) => { try { const g = scanProject(root); scans.set(root, g); return g } catch { return null } }

let term: pty.IPty | null = null
let stopWatch: (() => void) | null = null
const stopTerm = () => { stopWatch?.(); stopWatch = null; try { term?.kill() } catch { /* already gone */ } term = null }

/** Where the owner's own agent lives: saved choice, else the known default location if it exists. */
const agentPath = (): string | null => {
  const saved = readJson<{ agent?: string }>(userFile('code.json'), {}).agent
  if (saved && existsSync(saved)) return saved
  const guess = 'G:\\NOVA IA DO UMBRA\\agente-codigo\\agente.js'
  return existsSync(guess) ? guess : null
}
/** The owner's own Node (agents may use native modules built for it); falls back to the one inside Electron. */
const nodeBin = () => { try { return execFileSync('where.exe', ['node'], { encoding: 'utf8' }).split(/\r?\n/)[0].trim() || process.execPath } catch { return process.execPath } }
const claudeFound = () => { try { execFileSync('where.exe', ['claude'], { stdio: 'ignore' }); return true } catch { return false } }

function registerIpc(getWin: () => BrowserWindow | null) {
  const send = (ch: string, ...a: unknown[]) => getWin()?.webContents.send(ch, ...a)

  ipcMain.handle('projects:list', () => projectRoots().map((r) => scans.get(r) ?? scanSafe(r)).filter(Boolean))
  ipcMain.handle('projects:add', async () => {
    const r = await dialog.showOpenDialog(getWin()!, { properties: ['openDirectory'], title: 'Escolha a pasta do projeto que o JARVIS poderá ler' })
    if (r.canceled || !r.filePaths[0]) return null
    const g = scanSafe(r.filePaths[0])
    if (g && !projectRoots().includes(g.root)) writeJson(userFile('projects.json'), [...projectRoots(), g.root])
    return g
  })
  ipcMain.handle('projects:remove', (_e, root: string) => { writeJson(userFile('projects.json'), projectRoots().filter((r) => r !== root)); scans.delete(root); return true })
  ipcMain.handle('projects:rescan', (_e, root: string) => (projectRoots().includes(root) ? scanSafe(root) : null))

  ipcMain.handle('code:engines', () => ({ claude: claudeFound(), agent: agentPath(), shell: true }))
  ipcMain.handle('code:setAgentPath', async () => {
    const r = await dialog.showOpenDialog(getWin()!, { properties: ['openFile'], filters: [{ name: 'Agente (.js, .bat, .cmd)', extensions: ['js', 'bat', 'cmd'] }], title: 'Escolha o arquivo que inicia o seu agente' })
    if (r.canceled || !r.filePaths[0]) return agentPath()
    writeJson(userFile('code.json'), { ...readJson(userFile('code.json'), {}), agent: r.filePaths[0] })
    return r.filePaths[0]
  })
  ipcMain.handle('code:start', (_e, o: { engine: 'claude' | 'agent' | 'shell'; cwd: string; cols: number; rows: number }) => {
    if (!projectRoots().includes(o.cwd)) return { ok: false, error: 'Escolha uma pasta de projeto autorizada.' }
    stopTerm()
    let file = 'powershell.exe'
    let args: string[] = ['-NoLogo']
    if (o.engine === 'claude') {
      if (!claudeFound()) return { ok: false, error: 'O comando "claude" não foi encontrado no PATH.' }
      file = 'cmd.exe'; args = ['/c', 'claude']
    } else if (o.engine === 'agent') {
      const p = agentPath()
      if (!p) return { ok: false, error: 'Defina onde está o seu agente.' }
      // Arguments go in separately: node-pty quotes paths with spaces itself, and quotes we add would be doubled.
      if (/\.js$/i.test(p)) { file = nodeBin(); args = [p] } else { file = 'cmd.exe'; args = ['/c', p] }
    }
    term = pty.spawn(file, args, { name: 'xterm-256color', cols: o.cols || 100, rows: o.rows || 30, cwd: o.cwd, env: process.env as Record<string, string> })
    term.onData((d) => send('code:data', d))
    term.onExit(({ exitCode }) => { send('code:exit', exitCode); stopWatch?.(); stopWatch = null; term = null })
    // Metrics exist for Claude Code only: it writes the transcripts we read.
    if (o.engine === 'claude') stopWatch = watchSession(o.cwd, (m, ev) => send('code:metrics', m, ev))
    return { ok: true }
  })
  ipcMain.on('code:write', (_e, d: string) => { if (typeof d === 'string' && d.length < 100_000) term?.write(d) })
  ipcMain.on('code:resize', (_e, c: number, r: number) => { if (c > 0 && r > 0 && c < 1000 && r < 400) { try { term?.resize(c, r) } catch { /* terminal closing */ } } })
  ipcMain.on('code:stop', stopTerm)
}

async function createWindow() {
  const win = new BrowserWindow({
    width: 1480,
    height: 920,
    minWidth: 1100,
    minHeight: 700,
    backgroundColor: '#02060a',
    title: 'J.A.R.V.I.S',
    show: false,
    titleBarStyle: 'hidden',
    titleBarOverlay: { color: '#02060a', symbolColor: '#7fe8ff', height: 40 },
    webPreferences: { contextIsolation: true, nodeIntegration: false, sandbox: true, preload: join(__dirname, 'preload.cjs') },
  })
  registerIpc(() => win)
  win.once('ready-to-show', () => win.show())
  // APP_LOG=<file> mirrors the page's console (errors included) to a file, for headless verification runs.
  if (process.env.APP_LOG) {
    const log = process.env.APP_LOG
    win.webContents.on('console-message', (e) => appendFileSync(log, `[${e.level}] ${e.message}\n`))
  }
  // Nothing in the app navigates away; links open in the system browser, never in this window.
  win.webContents.setWindowOpenHandler(({ url }) => {
    if (/^https?:\/\//.test(url)) void shell.openExternal(url)
    return { action: 'deny' }
  })
  win.webContents.on('will-navigate', (e, url) => {
    if (!url.startsWith(`http://127.0.0.1:${UI_PORT}`)) e.preventDefault()
  })
  await win.loadURL(DEV_URL ?? `http://127.0.0.1:${UI_PORT}`)

  // Verification hooks: APP_EXEC runs a script in the page (e.g. to click through the UI), then
  // APP_SHOT=<file.png> saves a screenshot after the scene settles and quits.
  const shot = process.env.APP_SHOT
  if (process.env.APP_EXEC) void win.webContents.executeJavaScript(process.env.APP_EXEC).catch(() => {})
  if (shot) {
    setTimeout(async () => {
      writeFileSync(shot, (await win.webContents.capturePage()).toPNG())
      app.quit()
    }, Number(process.env.APP_SHOT_DELAY ?? 7000))
  }
}

if (!app.requestSingleInstanceLock()) app.quit()
else {
  app.whenReady().then(async () => {
    Menu.setApplicationMenu(null)
    await startBridge()
    if (!DEV_URL) await startUi()
    await createWindow()
  })
  app.on('window-all-closed', () => app.quit())
  app.on('will-quit', () => {
    stopTerm()
    bridge?.kill()
    ui?.close()
  })
}
