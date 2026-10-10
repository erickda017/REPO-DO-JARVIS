import { lstatSync, realpathSync } from 'node:fs'
import { mkdir, readFile, rename, writeFile } from 'node:fs/promises'
import { homedir } from 'node:os'
import { dirname, isAbsolute, join, parse, resolve, sep } from 'node:path'
import { isWindows, psJson } from './winps.mjs'

export class AgentError extends Error {
  constructor(code, message) {
    super(message)
    this.name = 'AgentError'
    this.code = code
  }
}

export const GROUPS = {
  files: 'Arquivos e pastas (dentro das pastas liberadas)',
  web: 'Internet: pesquisar, ler páginas, abrir sites',
  system: 'Monitoramento: CPU, RAM, disco, temperatura, processos (só leitura)',
  apps: 'Abrir aplicativos instalados',
  processes: 'Encerrar processos e aplicativos (sempre com confirmação)',
  commands: 'Executar comandos/scripts do PowerShell (sempre com confirmação)',
  dev: 'Desenvolvimento: rodar testes/builds do projeto e servidores locais (executa código do projeto, sempre com confirmação)',
  screen: 'Capturar a tela (o arquivo pode mostrar dados privados)',
}
const DEFAULT_TOOLS = { files: true, web: true, system: true, apps: false, processes: false, commands: false, dev: false, screen: false }

/**
 * What the owner has allowed the agent to touch, saved in data/agent-access.json:
 *   - tool GROUPS that are switched on (apps, processes and commands start OFF), and
 *   - ROOT folders the file tools may read and change. No roots = the agent cannot touch any file.
 * Every path a tool receives is resolved (links followed) and must sit inside a root; otherwise the call is refused.
 */
export function createAccess({ file, env = process.env, systemFolders = true, deny = [] } = {}) {
  // Never grantable/readable by file tools: JARVIS' own data (API keys, tokens), Windows itself and the Start Menu/Startup folders.
  const denied = [...deny, systemFolders && env.SystemRoot, systemFolders && env.APPDATA && join(env.APPDATA, 'Microsoft', 'Windows', 'Start Menu')].filter(Boolean).map((d) => resolve(d))
  let data = { tools: { ...DEFAULT_TOOLS }, roots: [] }
  let loaded = !file
  let chain = Promise.resolve()
  let known = null

  const persist = () => {
    if (!file) return Promise.resolve()
    chain = chain.then(async () => {
      await mkdir(dirname(file), { recursive: true })
      const tmp = `${file}.tmp`
      await writeFile(tmp, JSON.stringify(data, null, 2), 'utf8')
      await rename(tmp, file)
    })
    return chain
  }

  /** Real locations of the user's special folders (the Desktop is often redirected into OneDrive). */
  async function knownFolders() {
    if (known) return known
    const home = env.USERPROFILE || homedir()
    known = { '%HOME%': home, '%DESKTOP%': join(home, 'Desktop'), '%DOCUMENTS%': join(home, 'Documents'), '%DOWNLOADS%': join(home, 'Downloads'), '%APPDATA%': env.APPDATA ?? join(home, 'AppData', 'Roaming'), '%LOCALAPPDATA%': env.LOCALAPPDATA ?? join(home, 'AppData', 'Local'), '%TEMP%': env.TEMP ?? join(home, 'AppData', 'Local', 'Temp') }
    if (isWindows && systemFolders) {
      try {
        const r = await psJson("[pscustomobject]@{d=[Environment]::GetFolderPath('Desktop');m=[Environment]::GetFolderPath('MyDocuments')} | ConvertTo-Json -Compress", { timeoutMs: 8000 })
        if (r?.d) known['%DESKTOP%'] = r.d
        if (r?.m) known['%DOCUMENTS%'] = r.m
      } catch { /* keep the defaults */ }
    }
    return known
  }

  const expand = async (p) => {
    let s = String(p ?? '').trim().replace(/^["']|["']$/g, '')
    // UNC / device paths (\\server\share, \\?\) would make Windows authenticate to a remote host just by being probed.
    if (/^[\\/]{2}/.test(s)) throw new AgentError('unc', 'caminhos de rede/UNC não são aceitos')
    const kf = await knownFolders()
    for (const [k, v] of Object.entries(kf)) if (s.toUpperCase().startsWith(k)) s = v + s.slice(k.length)
    // friendly names the model tends to write
    const alias = { 'área de trabalho': '%DESKTOP%', 'area de trabalho': '%DESKTOP%', desktop: '%DESKTOP%', documentos: '%DOCUMENTS%', documents: '%DOCUMENTS%', downloads: '%DOWNLOADS%', transferências: '%DOWNLOADS%' }
    const first = s.split(/[\\/]/)[0].toLowerCase()
    if (alias[first] && !isAbsolute(s)) s = kf[alias[first]] + s.slice(first.length)
    return s
  }

  const inside = (root, p) => {
    const r = root.toLowerCase().replace(/[\\/]+$/, '')
    const c = p.toLowerCase()
    return c === r || c.startsWith(r + sep)
  }

  // lstat, not stat: a dangling link must count as existing so it can never be treated as a free, new path
  const exists = (p) => { try { lstatSync(p); return true } catch { return false } }

  const real = (p) => {
    // realpath of the deepest existing ancestor + the not-yet-existing remainder
    let cur = resolve(p)
    const rest = []
    while (!exists(cur)) {
      const up = dirname(cur)
      if (up === cur) break
      rest.unshift(cur.slice(up.length).replace(/^[\\/]+/, ''))
      cur = up
    }
    let base
    try {
      base = realpathSync(cur)
    } catch {
      throw new AgentError('forbidden', 'caminho com link quebrado ou inacessível: ' + cur)
    }
    return join(base, ...rest)
  }

  return {
    async ready() {
      if (loaded) return
      loaded = true
      try {
        const j = JSON.parse((await readFile(file, 'utf8')).replace(/^﻿/, ''))
        data = { tools: { ...DEFAULT_TOOLS, ...(j.tools ?? {}) }, roots: Array.isArray(j.roots) ? j.roots : [] }
      } catch { /* first run */ }
    },
    snapshot: () => ({ tools: { ...data.tools }, roots: data.roots.map((r) => ({ ...r })), groups: GROUPS }),
    allows: (group) => Boolean(data.tools[group]),
    async setTool(group, on) {
      if (!(group in GROUPS)) throw new Error('unknown tool group')
      data.tools[group] = Boolean(on)
      await persist()
    },
    async addRoot(path, label) {
      const abs = real(await expand(path))
      if (denied.some((d) => inside(d, abs))) throw new Error('esta pasta contém dados protegidos do JARVIS/Windows e não pode ser liberada')
      if (!exists(abs)) throw new Error('folder does not exist')
      const { root } = parse(abs)
      if (abs.replace(/[\\/]+$/, '').toLowerCase() === root.replace(/[\\/]+$/, '').toLowerCase()) throw new Error('a whole drive cannot be granted; pick a folder')
      if (!data.roots.some((r) => r.path.toLowerCase() === abs.toLowerCase())) data.roots.push({ path: abs, label: label ?? abs })
      await persist()
    },
    async removeRoot(path) {
      data.roots = data.roots.filter((r) => r.path.toLowerCase() !== String(path).toLowerCase())
      await persist()
    },
    /** Resolve a path the model gave us and prove it is inside a granted root. */
    async resolveInside(input) {
      const expanded = await expand(input)
      if (!isAbsolute(expanded)) throw new AgentError('path', `caminho relativo não aceito: ${String(input).slice(0, 80)} (use um caminho completo ou %DESKTOP%\\arquivo.txt)`)
      const abs = real(expanded)
      if (denied.some((d) => inside(d, abs))) throw new AgentError('forbidden', `pasta protegida (dados do JARVIS/Windows): ${abs}`)
      if (!data.roots.some((r) => inside(r.path, abs))) {
        throw new AgentError('forbidden', `fora das pastas liberadas: ${abs}. Libere a pasta na tela Agente.`)
      }
      return abs
    },
    /** Like resolveInside, for read-only discovery tools that may look anywhere (never used by write tools). */
    async resolveAny(input) {
      const abs = real(await expand(input))
      return abs
    },
    knownFolders,
  }
}
