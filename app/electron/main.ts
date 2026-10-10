import { app, BrowserWindow, Menu, shell } from 'electron'
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
    webPreferences: { contextIsolation: true, nodeIntegration: false, sandbox: true },
  })
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
    bridge?.kill()
    ui?.close()
  })
}
