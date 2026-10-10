import { execSync } from 'node:child_process'
import { cpSync, existsSync, mkdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { build, Platform } from 'electron-builder'

// Builds the Windows installer: release/out/JARVIS-Setup-<version>.exe
// The packaged app only needs the bridge's three runtime packages, so a small staging project
// is assembled (instead of shipping every dependency of the original browser HUD).
// The parent `npm run` leaks its allow-scripts setting into child installs, which npm 12 rejects: drop it.
const env = Object.fromEntries(Object.entries(process.env).filter(([k]) => !/^npm_config_allow[-_]scripts$/i.test(k)))
const sh = (cmd, cwd) => execSync(cmd, { stdio: 'inherit', cwd, env })
const root = process.cwd()
const pkg = JSON.parse(readFileSync('package.json', 'utf8'))
const electronVersion = JSON.parse(readFileSync('node_modules/electron/package.json', 'utf8')).version
const VERSION = '0.1.0'

sh('npm run app:build')
sh('node scripts/make-icon.mjs')

const stage = 'release/stage'
rmSync('release', { recursive: true, force: true })
mkdirSync(stage, { recursive: true })
for (const d of ['dist-app', 'dist-electron', 'bridge']) cpSync(d, `${stage}/${d}`, { recursive: true })
// Default config for first run: the owner's local config if present, otherwise the all-disabled example.
cpSync(existsSync('command.config.json') ? 'command.config.json' : 'command.config.example.json', `${stage}/default-command.config.json`)
writeFileSync(`${stage}/package.json`, JSON.stringify({
  name: 'jarvis-command-center',
  productName: 'J.A.R.V.I.S',
  version: VERSION,
  description: 'Personal multi-AI command center',
  author: 'Erick',
  main: 'dist-electron/main.cjs',
  type: 'module',
  dependencies: Object.fromEntries(['@anthropic-ai/claude-agent-sdk', 'ws', 'zod'].map((n) => [n, pkg.dependencies[n]])),
}, null, 2))
sh('npm install --omit=dev --ignore-scripts --no-audit --no-fund', stage)

await build({
  projectDir: root,
  targets: Platform.WINDOWS.createTarget(['nsis', 'portable']),
  publish: 'never',
  config: {
    appId: 'app.jarvis.command-center',
    productName: 'J.A.R.V.I.S',
    electronVersion,
    // Reuse the Electron already installed in node_modules: skips extracting a second copy, whose
    // final rename was blocked (EPERM, likely the antivirus scanning the fresh files) on this PC.
    electronDist: 'node_modules/electron/dist',
    asar: false, // the bridge runs as a separate Node process and the Agent SDK ships a native binary
    npmRebuild: false,
    directories: { app: stage, output: 'release/out', buildResources: 'build' },
    win: { target: ['nsis', 'portable'], icon: 'build/icon.ico' },
    portable: { artifactName: 'JARVIS-Portable-${version}.exe' },
    nsis: {
      oneClick: false,
      perMachine: false, // per-user install: no admin rights, and %APPDATA% is writable
      allowToChangeInstallationDirectory: true,
      createDesktopShortcut: true,
      shortcutName: 'J.A.R.V.I.S',
      artifactName: 'JARVIS-Setup-${version}.exe',
    },
  },
})
console.log('[app] installer ready in release/out')
