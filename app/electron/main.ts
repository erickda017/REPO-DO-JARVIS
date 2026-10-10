import { app, BrowserWindow, dialog, globalShortcut, ipcMain, Menu, nativeImage, session, shell, Tray } from 'electron'
import * as pty from '@lydell/node-pty'
import { execFileSync } from 'node:child_process'
import { readFileSync } from 'node:fs'
import { scanProject, type ProjectGraph } from './projects.ts'
import { watchSession } from './transcripts.ts'
import { iaStart, iaStatus, iaStop, iaValid, type IaMode } from './ia.ts'
import { execFile, spawn, type ChildProcess } from 'node:child_process'
import { randomBytes } from 'node:crypto'
import { appendFileSync, copyFileSync, createReadStream, existsSync, mkdirSync, realpathSync, statSync, writeFileSync } from 'node:fs'
import http from 'node:http'
import net from 'node:net'
import { extname, join, normalize, sep } from 'node:path'

const ROOT = app.getAppPath()
let uiPort = Number(process.env.APP_UI_PORT ?? 5174) // must stay inside 5173-5199, the range the bridge accepts as an origin
const BRIDGE_PORT = Number(process.env.JARVIS_BRIDGE_PORT ?? 8787)
const DIST = join(ROOT, 'dist-app')
const DEV_URL = process.env.APP_DEV_URL // set by `npm run app:dev` (Vite dev server)

const MIME: Record<string, string> = {
  '.html': 'text/html; charset=utf-8', '.js': 'text/javascript', '.css': 'text/css', '.json': 'application/json',
  '.woff2': 'font/woff2', '.svg': 'image/svg+xml', '.png': 'image/png', '.ico': 'image/x-icon',
}

// Per-launch secret shared only with the bridge this app starts and with its own page (through the preload).
const APP_TOKEN = randomBytes(24).toString('hex')
let bridge: ChildProcess | null = null
let quitting = false
let mainWin: BrowserWindow | null = null
let tray: Tray | null = null
// Started by Windows at login: stay in the tray, do not pop a window in the owner's face.
const HIDDEN = process.argv.includes('--hidden')
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

/** A bridge left over from an earlier run answers 401 to our new token and would block the app forever: stop exactly that process. */
async function clearOrphanBridge() {
  const r = await fetch(`http://127.0.0.1:${BRIDGE_PORT}/api/command/overview`, { headers: { 'x-jarvis-token': APP_TOKEN }, signal: AbortSignal.timeout(2500) }).catch(() => null)
  if (!r || r.status !== 401) return // not ours to touch: a hand-started bridge without a token answers 200
  const ps = `Get-NetTCPConnection -LocalPort ${BRIDGE_PORT} -State Listen -ErrorAction SilentlyContinue | ForEach-Object { $p = Get-CimInstance Win32_Process -Filter ('ProcessId=' + $_.OwningProcess); if ($p.CommandLine -match 'server\.mjs' -and -not (Get-Process -Id $p.ParentProcessId -ErrorAction SilentlyContinue)) { Stop-Process -Id $p.ProcessId -Force } }`
  await new Promise<void>((done) => execFile('powershell.exe', ['-NoProfile', '-NonInteractive', '-Command', ps], { windowsHide: true, timeout: 15000 }, () => done()))
  await new Promise((done) => setTimeout(done, 800))
}

let restarts: number[] = []
const launchBridge = () => {
  bridge = spawn(process.execPath, [join(ROOT, 'bridge', 'server.mjs')], {
    cwd: ROOT,
    env: { ...process.env, ...userPaths(), ELECTRON_RUN_AS_NODE: '1', JARVIS_APP_TOKEN: APP_TOKEN },
    stdio: 'ignore',
    windowsHide: true,
  })
  const me = bridge
  me.on('error', () => {})
  // Supervisor: if the bridge dies while the app is open, bring it back (at most 5 times a minute, so a crash loop cannot spin).
  me.on('exit', () => {
    if (quitting || bridge !== me) return
    const now = Date.now()
    restarts = restarts.filter((t) => now - t < 60_000)
    if (restarts.length >= 5) return
    restarts.push(now)
    setTimeout(launchBridge, 1000)
  })
}

/** Start the bridge as a child unless one is already listening (e.g. started by hand). */
async function startBridge() {
  if (await portBusy(BRIDGE_PORT)) await clearOrphanBridge()
  if (await portBusy(BRIDGE_PORT)) return
  launchBridge()
}

/** Serve the built renderer from loopback so its origin is one the bridge allows. */
function startUi(): Promise<void> {
  const handler: http.RequestListener = (req, res) => {
    let path: string
    try { path = normalize(decodeURIComponent((req.url ?? '/').split('?')[0])) } catch { return void res.writeHead(400).end() }
    let file = join(DIST, path === sep || path === '/' ? 'index.html' : path)
    if (file !== DIST && !file.startsWith(DIST + sep)) return void res.writeHead(403).end() // path traversal guard (sibling folders with the same prefix included)
    if (!existsSync(file) || statSync(file).isDirectory()) file = join(DIST, 'index.html')
    res.writeHead(200, { 'content-type': MIME[extname(file)] ?? 'application/octet-stream' })
    createReadStream(file).on('error', () => res.destroy()).pipe(res)
  }
  // If the port is taken (another copy of the app, a dev server), move to the next free one in the allowed range.
  return new Promise((resolve, reject) => {
    const tryPort = (port: number) => {
      const srv = http.createServer(handler)
      srv.once('error', (e: NodeJS.ErrnoException) => (e.code === 'EADDRINUSE' && port < 5199 ? tryPort(port + 1) : reject(e)))
      srv.listen(port, '127.0.0.1', () => { ui = srv; uiPort = port; resolve() })
    }
    tryPort(uiPort)
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

/** Granted folders, always as real paths (a junction or a renamed link resolves to its target), de-duplicated. */
const projectRoots = () => {
  const saved = readJson<string[]>(userFile('projects.json'), [])
  const real = [...new Set(saved.map((r) => { try { return realpathSync(r) } catch { return r } }))]
  if (real.length !== saved.length || real.some((r, i) => r !== saved[i])) writeJson(userFile('projects.json'), real)
  return real
}
const scans = new Map<string, ProjectGraph>()
const scanSafe = (root: string) => { try { const g = scanProject(root); scans.set(root, g); return g } catch { return null } }

let term: pty.IPty | null = null
let stopWatch: (() => void) | null = null
const stopTerm = () => {
  stopWatch?.()
  stopWatch = null
  if (term) {
    // Kill the whole process tree (the agent or Claude Code is a child of the shell host); a plain pty kill can
    // leave the window of the app waiting for it on exit.
    try { execFileSync('taskkill', ['/pid', String(term.pid), '/t', '/f'], { stdio: 'ignore', timeout: 4000 }) } catch { /* already gone */ }
    try { term.kill() } catch { /* already gone */ }
  }
  term = null
}

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

/** Where the local AI lives: the owner's saved choice, else the copy inside this repo, else the old default location. */
const iaRoot = (): string | null => {
  const saved = readJson<{ root?: string }>(userFile('ia.json'), {}).root
  for (const c of [saved, join(ROOT, 'ia-local'), 'G:/JARIVS/ia-local']) if (c && iaValid(c)) return c
  return null
}
const IA_MODES = new Set<IaMode>(['leve', 'so-ia', 'so-cris', 'completo'])

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

  ipcMain.on('app:token', (e) => { e.returnValue = APP_TOKEN })
  ipcMain.handle('app:getSettings', () => ({ ...appSettings(), packaged: app.isPackaged, hotkeyActive: hotkeyOn }))
  ipcMain.handle('app:setSettings', (_e, p: Partial<AppSettings>) => {
    const cur = appSettings()
    const next: AppSettings = { autostart: typeof p.autostart === 'boolean' ? p.autostart : cur.autostart, closeToTray: typeof p.closeToTray === 'boolean' ? p.closeToTray : cur.closeToTray, hotkey: typeof p.hotkey === 'string' && /^[\w+]{1,40}$/.test(p.hotkey) ? p.hotkey : cur.hotkey }
    writeJson(userFile('app.json'), next)
    applyAutostart(next.autostart)
    if (next.hotkey !== cur.hotkey) applyHotkey(next.hotkey)
    return { ...next, packaged: app.isPackaged, hotkeyActive: hotkeyOn }
  })
  ipcMain.handle('access:pick', async () => {
    const r = await dialog.showOpenDialog(getWin()!, { properties: ['openDirectory'], title: 'Escolha uma pasta que o agente poderá ler e alterar' })
    return r.canceled ? null : (r.filePaths[0] ?? null)
  })
  ipcMain.handle('ia:status', () => iaStatus(iaRoot()))
  ipcMain.handle('ia:start', (_e, mode: IaMode) => (IA_MODES.has(mode) ? iaStart(iaRoot(), mode, join(app.getPath('userData'), 'ia-logs')) : iaStatus(iaRoot())))
  ipcMain.handle('ia:stop', () => iaStop(iaRoot()))
  ipcMain.handle('ia:setRoot', async () => {
    const r = await dialog.showOpenDialog(getWin()!, { properties: ['openDirectory'], title: 'Escolha a pasta da IA local (a que tem llama/llama-server.exe)' })
    if (!r.canceled && r.filePaths[0] && iaValid(r.filePaths[0])) writeJson(userFile('ia.json'), { root: r.filePaths[0] })
    return iaStatus(iaRoot())
  })
  ipcMain.handle('code:engines', () => ({ claude: claudeFound(), agent: agentPath(), shell: true }))
  ipcMain.handle('code:setAgentPath', async () => {
    const r = await dialog.showOpenDialog(getWin()!, { properties: ['openFile'], filters: [{ name: 'Agente (.js, .bat, .cmd)', extensions: ['js', 'bat', 'cmd'] }], title: 'Escolha o arquivo que inicia o seu agente' })
    if (r.canceled || !r.filePaths[0]) return agentPath()
    writeJson(userFile('code.json'), { ...readJson(userFile('code.json'), {}), agent: r.filePaths[0] })
    return r.filePaths[0]
  })
  ipcMain.handle('code:start', async (_e, o: { engine: 'claude' | 'agent' | 'shell'; cwd: string; cols: number; rows: number }) => {
    try { o.cwd = realpathSync(o.cwd) } catch { /* the check below rejects it */ }
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
      if (/\.js$/i.test(p)) {
        // Pre-answer the agent's two start-up questions (folder and model) so the session opens clean: the heavy
        // model when its server is up, otherwise the light one. (--key=value is the only form its parser reads.)
        const modo = (await portBusy(8081)) ? 'programacao' : (await portBusy(8082)) ? 'leve' : null
        if (!modo) return { ok: false, error: 'Nenhuma IA local está ligada. Ligue uma na tela "IA local" (o modo leve basta).' }
        file = nodeBin()
        args = [p, `--pasta=${o.cwd}`, `--modo=${modo}`]
      } else { file = 'cmd.exe'; args = ['/c', p] }
    }
    const t = pty.spawn(file, args, { name: 'xterm-256color', cols: o.cols || 100, rows: o.rows || 30, cwd: o.cwd, env: process.env as Record<string, string> })
    term = t
    t.onData((d) => { if (term === t) send('code:data', d) })
    // An older terminal exiting after a restart must not clear the NEW one (that left it orphaned and unreachable).
    t.onExit(({ exitCode }) => { if (term !== t) return; send('code:exit', exitCode); stopWatch?.(); stopWatch = null; term = null })
    // Metrics exist for Claude Code only: it writes the transcripts we read.
    if (o.engine === 'claude') stopWatch = watchSession(o.cwd, (m, ev) => send('code:metrics', m, ev))
    return { ok: true }
  })
  ipcMain.on('code:write', (_e, d: string) => { if (typeof d === 'string' && d.length < 100_000) term?.write(d) })
  ipcMain.on('code:resize', (_e, c: number, r: number) => { if (c > 0 && r > 0 && c < 1000 && r < 400) { try { term?.resize(c, r) } catch { /* terminal closing */ } } })
  ipcMain.on('code:stop', stopTerm)
}

// ---------------------------------------------------------------------------------------------
// Background life: start with Windows, live in the tray, global hotkey to listen.
// ---------------------------------------------------------------------------------------------
interface AppSettings { autostart: boolean; closeToTray: boolean; hotkey: string }
const SETTINGS_DEFAULT: AppSettings = { autostart: true, closeToTray: true, hotkey: 'Control+Alt+J' }
const appSettings = (): AppSettings => ({ ...SETTINGS_DEFAULT, ...readJson<Partial<AppSettings>>(userFile('app.json'), {}) })

/** Registers (or removes) the Windows login item. Only for the installed build: a dev run must not register electron.exe. */
function applyAutostart(on: boolean) {
  if (!app.isPackaged) return
  try { app.setLoginItemSettings({ openAtLogin: on, path: process.execPath, args: ['--hidden'] }) } catch { /* policy-restricted: the toggle simply has no effect */ }
}

function showWindow() {
  if (!mainWin) return
  if (mainWin.isMinimized()) mainWin.restore()
  mainWin.show()
  mainWin.focus()
}

/** Tells the page to start listening (hotkey, tray). The window is shown without stealing focus so the owner sees it is listening. */
function triggerListen() {
  if (!mainWin) return
  if (!mainWin.isVisible()) mainWin.showInactive()
  mainWin.webContents.send('voice:listen')
}

let hotkeyOn = ''
function applyHotkey(accel: string) {
  if (hotkeyOn) { try { globalShortcut.unregister(hotkeyOn) } catch { /* not registered */ } hotkeyOn = '' }
  if (!accel) return
  try { if (globalShortcut.register(accel, triggerListen)) hotkeyOn = accel } catch { /* invalid accelerator or taken by another program */ }
}

function createTray() {
  const icon = [join(ROOT, 'icon.png'), join(ROOT, 'build', 'icon.png')].find((p) => existsSync(p))
  tray = new Tray(icon ? nativeImage.createFromPath(icon).resize({ width: 16, height: 16 }) : nativeImage.createEmpty())
  tray.setToolTip('J.A.R.V.I.S')
  const menu = () => Menu.buildFromTemplate([
    { label: 'Abrir JARVIS', click: showWindow },
    { label: `Ouvir (${appSettings().hotkey.replace('Control', 'Ctrl')})`, click: triggerListen },
    { type: 'separator' },
    { label: 'Iniciar com o Windows', type: 'checkbox', checked: appSettings().autostart, click: (i) => { writeJson(userFile('app.json'), { ...appSettings(), autostart: i.checked }); applyAutostart(i.checked) } },
    { label: 'Fechar a janela mantém em segundo plano', type: 'checkbox', checked: appSettings().closeToTray, click: (i) => writeJson(userFile('app.json'), { ...appSettings(), closeToTray: i.checked }) },
    { type: 'separator' },
    { label: 'Sair do JARVIS', click: () => { quitting = true; app.quit() } },
  ])
  tray.on('click', () => (mainWin?.isVisible() ? mainWin.hide() : showWindow()))
  tray.on('right-click', () => tray?.popUpContextMenu(menu()))
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
  mainWin = win
  registerIpc(() => win)
  win.once('ready-to-show', () => { if (!HIDDEN) win.show() })
  // Closing the window hides it to the tray (the hidden-icons area) unless the owner turned that off or is quitting.
  win.on('close', (e) => { if (!quitting && appSettings().closeToTray) { e.preventDefault(); win.hide() } })
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
    let ok = false
    try { ok = new URL(url).origin === `http://127.0.0.1:${uiPort}` } catch { /* malformed */ }
    if (!ok) e.preventDefault()
  })
  await win.loadURL(DEV_URL ?? `http://127.0.0.1:${uiPort}`)

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
  app.on('second-instance', () => showWindow())
  app.on('before-quit', () => { quitting = true })
  app.whenReady().then(async () => {
    Menu.setApplicationMenu(null)
    // The microphone is granted only to this app's own page.
    const own = (url: string) => { try { return new URL(url).origin === (DEV_URL ? new URL(DEV_URL).origin : `http://127.0.0.1:${uiPort}`) } catch { return false } }
    session.defaultSession.setPermissionRequestHandler((wc, perm, cb) => cb(perm === 'media' && own(wc.getURL())))
    session.defaultSession.setPermissionCheckHandler((wc, perm) => perm === 'media' && Boolean(wc && own(wc.getURL())))
    applyAutostart(appSettings().autostart)
    await startBridge()
    if (!DEV_URL) await startUi()
    await createWindow()
    createTray()
    applyHotkey(appSettings().hotkey)
  })
  app.on('window-all-closed', () => app.quit())
  app.on('will-quit', () => {
    quitting = true
    globalShortcut.unregisterAll()
    setTimeout(() => app.exit(0), 3000).unref() // never let a child that will not die keep the app open
    stopTerm()
    bridge?.kill()
    ui?.close()
  })
}
