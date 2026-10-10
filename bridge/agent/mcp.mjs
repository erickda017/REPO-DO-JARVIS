import { createHash } from 'node:crypto'
import { mkdir, readFile, rename, writeFile } from 'node:fs/promises'
import { dirname } from 'node:path'
import { isIP } from 'node:net'
import { blockedAddress } from '../net.mjs'
import { AgentError } from './access.mjs'
import { createMcpClient } from './mcp.client.mjs'

/**
 * MCP servers: tools from the open Model Context Protocol ecosystem, added by the owner and gated tool by tool.
 *
 * Trust model (a server is third-party code or a third-party service; nothing it says is believed):
 *  - Only the owner adds a server (UI + explicit confirmation of the exact command). The agent has no tool that can add,
 *    edit or enable one, and the model never spawns anything.
 *  - Every tool starts OFF. The owner picks, per tool: off | ask each time | no confirmation (treated as a read).
 *    The server's own hints (readOnlyHint...) are only shown as suggestions: a server could lie, so a hint never skips a confirmation by itself.
 *  - "Rug pull" guard: the approved description+schema of each tool is hashed. If a server later changes them, the tool is
 *    switched off again and flagged until the owner looks at it. New tools appear OFF.
 *  - Tool descriptions are third-party text that ends up in the agent's prompt: flattened, clipped and marked as such.
 *    Results are external content (the agent's prompt-injection guard applies) and are size-capped.
 *  - Child processes get a minimal environment (never JARVIS's keys) plus what the owner set; secrets live in the vault.
 *  - The client offers no capabilities, so a server cannot ask to use our model, folders or screen (see mcp.client.mjs).
 */
const MAX_SERVERS = 12
const MAX_TOOLS_EXPOSED = 40
const RATE = { windowMs: 60_000, max: 60 }
const CALL_TIMEOUT_MS = 60_000
const RESTART_DELAYS = [2_000, 5_000, 15_000]
const ID_RE = /^[a-z][a-z0-9-]{1,19}$/
const ENV_KEY_RE = /^[A-Za-z_][A-Za-z0-9_]{0,40}$/
const HDR_RE = /^[A-Za-z0-9-]{1,40}$/
const FORBIDDEN_HDR = new Set(['host', 'content-length', 'content-type', 'accept', 'mcp-session-id', 'mcp-protocol-version', 'transfer-encoding', 'connection'])
const MODES = new Set(['off', 'confirm', 'auto'])
const clip = (s, n) => (String(s).length > n ? String(s).slice(0, n) + '…' : String(s))
const flat = (s, n) => clip(String(s ?? '').replace(/[\u0000-\u001f\u007f]+/g, ' ').replace(/\s+/g, ' ').trim(), n)
const sha = (x) => createHash('sha1').update(JSON.stringify(x)).digest('hex')
const slug = (s) => String(s).toLowerCase().normalize('NFD').replace(/[̀-ͯ]/g, '').replace(/[^a-z0-9]+/g, '-').replace(/^-+|-+$/g, '').slice(0, 20)

/** Suggestions for the "add" form. Package names change: the owner reviews the command before anything runs. */
export const PRESETS = [
  { id: 'filesystem', label: 'Arquivos (servidor oficial)', transport: 'stdio', command: 'npx', args: ['-y', '@modelcontextprotocol/server-filesystem', '<PASTA>'], note: 'Dá ao servidor acesso a UMA pasta, independente das pastas liberadas ao agente do JARVIS. Troque <PASTA> pelo caminho.' },
  { id: 'memory', label: 'Memória em grafo (servidor oficial)', transport: 'stdio', command: 'npx', args: ['-y', '@modelcontextprotocol/server-memory'], note: 'Guarda entidades e relações entre conversas.' },
  { id: 'thinking', label: 'Raciocínio em etapas (servidor oficial)', transport: 'stdio', command: 'npx', args: ['-y', '@modelcontextprotocol/server-sequential-thinking'], note: 'Ajuda a decompor problemas.' },
  { id: 'context7', label: 'Context7 (documentação de bibliotecas)', transport: 'stdio', command: 'npx', args: ['-y', '@upstash/context7-mcp'], note: 'Busca documentação atual de bibliotecas na internet.' },
  { id: 'playwright', label: 'Navegador (Playwright)', transport: 'stdio', command: 'npx', args: ['-y', '@playwright/mcp@latest'], note: 'Controla um navegador de verdade: pode abrir páginas e clicar. Deixe tudo em "pedir confirmação".' },
  { id: 'fetch', label: 'Fetch (uvx)', transport: 'stdio', command: 'uvx', args: ['mcp-server-fetch'], note: 'Baixa páginas web como texto. Precisa do uv instalado.' },
  { id: 'git', label: 'Git (uvx)', transport: 'stdio', command: 'uvx', args: ['mcp-server-git', '--repository', '<PASTA>'], note: 'Operações git em um repositório. Precisa do uv instalado.' },
  { id: 'time', label: 'Hora e fusos (uvx)', transport: 'stdio', command: 'uvx', args: ['mcp-server-time'], note: 'Hora atual e conversão de fusos. Precisa do uv instalado.' },
  { id: 'github', label: 'GitHub (servidor remoto oficial)', transport: 'http', url: 'https://api.githubcopilot.com/mcp/', headers: [{ name: 'Authorization', prefix: 'Bearer ' }], note: 'Cole um token de acesso pessoal do GitHub como valor do cabeçalho.' },
]

/** Private/loopback servers are allowed when the owner typed them; cloud-metadata and link-local never. */
const hostIsMetadata = (h) => /^(169\.254\.|0\.|\[?fe80)/i.test(h)
const privateHost = (h) => { const bare = h.replace(/^\[|\]$/g, ''); return isIP(bare) ? blockedAddress(bare) : h === 'localhost' || /\.(localhost|local|lan|internal|home\.arpa)$/.test(h) }
function checkUrl(raw) {
  let u
  try { u = new URL(raw) } catch { throw new AgentError('mcp', 'endereço inválido') }
  if (!/^https?:$/.test(u.protocol) || u.username || u.password) throw new AgentError('mcp', 'use http(s) sem usuário e senha no endereço')
  if (hostIsMetadata(u.hostname)) throw new AgentError('mcp', 'endereço não permitido')
  if (u.protocol === 'http:' && !privateHost(u.hostname)) throw new AgentError('mcp', 'servidores remotos precisam de https (http só para o próprio PC ou a rede local)')
}

/** The tool's inputSchema as {param: "type — description (obrigatório)"} for the agent prompt. */
function flattenParams(schema) {
  const props = schema?.properties && typeof schema.properties === 'object' ? schema.properties : {}
  const req = new Set(Array.isArray(schema?.required) ? schema.required : [])
  const out = {}
  for (const [k, v] of Object.entries(props).slice(0, 12)) {
    const type = Array.isArray(v?.type) ? v.type.join('|') : v?.type ?? (v?.enum ? 'enum' : 'valor')
    const en = Array.isArray(v?.enum) ? ` [${v.enum.slice(0, 8).join('|')}]` : ''
    out[flat(k, 40)] = flat(`${type}${en}${v?.description ? ` — ${v.description}` : ''}${req.has(k) ? ' (obrigatório)' : ''}`, 140)
  }
  return out
}

/** Small models send everything as strings: convert by the declared type when that is unambiguous. */
function coerce(args, schema) {
  const props = schema?.properties ?? {}
  const a = { ...(args ?? {}) }
  for (const [k, v] of Object.entries(a)) {
    const t = props[k]?.type
    if (typeof v !== 'string' || !t) continue
    if ((t === 'number' || t === 'integer') && v.trim() !== '' && Number.isFinite(Number(v))) a[k] = Number(v)
    else if (t === 'boolean' && /^(true|false)$/i.test(v)) a[k] = v.toLowerCase() === 'true'
    else if (t === 'array' || t === 'object') { try { const j = JSON.parse(v); if (typeof j === 'object' && j !== null) a[k] = j } catch { /* leave it */ } }
  }
  return a
}

/** MCP result -> what the agent sees. Binary content is described, never inlined. */
function convert(result) {
  const parts = []
  for (const c of result.content ?? []) {
    if (c.type === 'text') parts.push(String(c.text ?? ''))
    else if (c.type === 'image' || c.type === 'audio') parts.push(`[${c.type}: ${c.mimeType ?? '?'}, ${Math.round(String(c.data ?? '').length * 0.75)} bytes — não exibido]`)
    else if (c.type === 'resource') parts.push(c.resource?.text !== undefined ? `[recurso ${c.resource?.uri ?? ''}]\n${c.resource.text}` : `[recurso ${c.resource?.uri ?? ''}: ${c.resource?.mimeType ?? 'binário'} — não exibido]`)
    else if (c.type === 'resource_link') parts.push(`[link de recurso: ${c.uri ?? c.name ?? ''}]`)
  }
  return { text: parts.join('\n').trim(), structured: result.structuredContent, isError: result.isError === true }
}

export function createMcp({ file = null, settings, audit = null, clock = Date.now, spawn, fetch: fetchImpl = fetch, cwd = null, requestTimeoutMs } = {}) {
  let state = { servers: [] } // persisted: servers[] = { id,label,transport,command,args,url,env:[{key,secret,value?}],headers:[{name,prefix,secret:true}],enabled,tools:{name:{mode,hash,changed}} }
  let loaded = !file
  let chain = Promise.resolve()
  let table = null
  const rt = new Map() // id -> { status, error, client, tools (raw), log[], info, restarts, intentional, restartTimer, calls[] }
  const registered = new Map()

  const persist = () => {
    if (!file) return Promise.resolve()
    const run = chain.then(async () => {
      await mkdir(dirname(file), { recursive: true })
      const tmp = `${file}.tmp`
      await writeFile(tmp, JSON.stringify(state, null, 2), 'utf8')
      await rename(tmp, file)
    })
    chain = run.catch(() => {})
    return run
  }
  const get = (id) => state.servers.find((s) => s.id === id)
  const need = (id) => get(id) ?? (() => { throw new Error('servidor MCP desconhecido') })()
  const R = (id) => { let r = rt.get(id); if (!r) { r = { status: 'stopped', error: null, client: null, tools: [], log: [], info: null, restarts: 0, intentional: false, restartTimer: null, calls: [], started: 0 }; rt.set(id, r) } return r }

  // ---------------------------------------------------------------- secrets (vault names: MCP_<ID>_S<n>)
  const idUp = (id) => id.replace(/-/g, '_').toUpperCase()
  const secretList = (s) => [...s.env.filter((e) => e.secret).map((e) => ({ kind: 'env', key: e.key })), ...s.headers.map((h) => ({ kind: 'header', key: h.name }))]
  const secretNameAt = (s, n) => `MCP_${idUp(s.id)}_S${n}`
  const secretValue = (s, kind, key) => { const n = secretList(s).findIndex((x) => x.kind === kind && x.key === key); return n < 0 ? '' : settings.env()[secretNameAt(s, n)] || '' }
  const secretsOf = (s) => secretList(s).map((x) => secretValue(s, x.kind, x.key)).filter((v) => v.length >= 8)
  const redact = (s, text) => { let t = String(text); for (const v of secretsOf(s)) t = t.split(v).join('***'); return t }
  const log = (s, line) => { const r = R(s.id); r.log.push(`${new Date(clock()).toISOString().slice(11, 19)} ${redact(s, line)}`); if (r.log.length > 200) r.log.splice(0, r.log.length - 200) }

  const specOf = (s) => s.transport === 'stdio'
    ? { transport: 'stdio', command: s.command, args: s.args, cwd: cwd ?? undefined, env: Object.fromEntries(s.env.map((e) => [e.key, e.secret ? secretValue(s, 'env', e.key) : e.value ?? ''])) }
    : { transport: 'http', url: s.url, headers: Object.fromEntries(s.headers.map((h) => [h.name, `${h.prefix ?? ''}${secretValue(s, 'header', h.name)}`]).filter(([, v]) => v.length > 0)) }

  // ---------------------------------------------------------------- tools
  const toolHash = (t) => sha([t.description ?? '', t.inputSchema ?? {}])
  const safeName = (s, name, used) => {
    let n = `mcp_${s.id.replace(/-/g, '_')}_${String(name).toLowerCase().replace(/[^a-z0-9_]+/g, '_')}`.replace(/_+/g, '_').replace(/_$/, '')
    if (n.length > 60) n = n.slice(0, 51) + '_' + sha(name).slice(0, 8)
    let k = n, i = 2
    while (used.has(k)) k = `${n}_${i++}`
    used.add(k)
    return k
  }

  function applyTools(s, list) {
    const r = R(s.id)
    r.tools = list
    for (const [name, cfg] of Object.entries(s.tools)) {
      const t = list.find((x) => x.name === name)
      if (!t || cfg.mode === 'off') continue
      if (toolHash(t) !== cfg.hash) { cfg.mode = 'off'; cfg.changed = true; log(s, `[jarvis] a ferramenta "${name}" mudou de descrição/parâmetros desde que você a aprovou: desligada`) } // rug-pull guard
    }
  }

  function toolDefs(s) {
    const r = R(s.id)
    const out = {}
    const used = new Set()
    let n = 0
    for (const t of r.tools) {
      const cfg = s.tools[t.name]
      if (!cfg || cfg.mode === 'off' || n >= MAX_TOOLS_EXPOSED) continue
      n++
      const name = safeName(s, t.name, used)
      const auto = cfg.mode === 'auto'
      const label = s.label
      out[name] = {
        name, group: 'mcp', risk: auto ? 'read' : 'write', external: true, mcp: s.id,
        desc: `[MCP ${flat(label, 30)} · texto do servidor: ${flat(t.description || t.title || t.name, 160)}]`,
        params: flattenParams(t.inputSchema),
        run: async (args) => call(s, t, args ?? {}, auto),
        ...(auto ? {} : { confirm: async (args) => `Servidor MCP "${label}" (${s.transport === 'stdio' ? 'programa rodando no seu PC com as suas permissões' : s.url}): executar a ferramenta "${t.name}" com ${clip(JSON.stringify(args ?? {}), 400)}? Descrição do servidor: ${flat(t.description || '', 200)}` }),
      }
    }
    return out
  }

  function sync() {
    if (!table) return
    for (const names of registered.values()) for (const k of names) delete table[k]
    registered.clear()
    for (const s of state.servers) {
      const r = R(s.id)
      if (!s.enabled || r.status !== 'ready') continue
      const defs = toolDefs(s)
      Object.assign(table, defs)
      registered.set(s.id, Object.keys(defs))
    }
  }

  async function call(s, t, args, auto) {
    const r = R(s.id)
    if (r.status !== 'ready' || !r.client) throw new AgentError('mcp', `o servidor MCP "${s.label}" não está rodando`)
    const now = clock()
    r.calls = r.calls.filter((x) => now - x < RATE.windowMs)
    if (r.calls.length >= RATE.max) throw new AgentError('rate', `${s.label}: muitas chamadas em um minuto; espere um pouco`)
    r.calls.push(now)
    let res
    try {
      res = await r.client.callTool(t.name, coerce(args, t.inputSchema), CALL_TIMEOUT_MS)
    } catch (e) {
      audit?.record('mcp.call', { id: s.id, tool: t.name, ok: false })
      throw new AgentError('mcp', redact(s, e.message))
    }
    const c = convert(res)
    audit?.record('mcp.call', { id: s.id, tool: t.name, ok: !c.isError }) // never the arguments or the output
    const text = redact(s, c.text)
    if (c.isError) throw new AgentError('mcp', `${s.label}: ${clip(text || 'o servidor devolveu um erro', 400)}`)
    const body = text.length > 24_000 ? `${text.slice(0, 24_000)}… [cortado, ${text.length} caracteres]` : text
    const structuredText = c.structured === undefined ? '' : JSON.stringify(c.structured)
    const data = { text: body, ...(structuredText && structuredText.length <= 12_000 ? { structured: JSON.parse(redact(s, structuredText)) } : {}) } // too big = the text part has to do
    return auto ? { data, evidence: `servidor MCP ${s.label}: ${t.name}` } : { data, verified: null, evidence: `o servidor MCP respondeu sem erro (${s.label}: ${t.name}); o efeito não pode ser conferido daqui` }
  }

  // ---------------------------------------------------------------- process lifecycle
  async function start(s) {
    const r = R(s.id)
    if (r.client) { r.intentional = true; r.client.stop() }
    r.intentional = false
    r.status = 'starting'
    r.error = null
    r.readyAt = 0
    if (cwd) await mkdir(cwd, { recursive: true }).catch(() => {}) // a neutral working folder: never the JARVIS project
    const client = createMcpClient(specOf(s), {
      spawn, fetch: fetchImpl, requestTimeoutMs, checkUrl,
      onLog: (line) => log(s, line),
      onToolsChanged: () => { void refresh(s.id).catch(() => {}) },
      onClose: (why) => {
        if (r.client !== client || r.intentional) return
        r.status = 'error'
        r.error = redact(s, `o servidor ${why}`)
        r.client = null
        sync()
        if (r.readyAt && clock() - r.readyAt > 5 * 60_000) r.restarts = 0 // it had been healthy for a while: a fresh budget of restarts
        if (s.enabled && r.restarts < RESTART_DELAYS.length) {
          const delay = RESTART_DELAYS[r.restarts++]
          log(s, `[jarvis] reiniciando em ${delay / 1000} s (tentativa ${r.restarts})`)
          r.restartTimer = setTimeout(() => { if (s.enabled && !r.intentional) void start(s) }, delay)
          r.restartTimer.unref?.()
        }
      },
    })
    r.client = client
    try {
      r.info = await client.start()
      const tools = await client.listTools()
      applyTools(s, tools)
      r.status = 'ready'
      r.readyAt = clock()
      audit?.record('mcp.start', { id: s.id, tools: tools.length })
      await persist()
    } catch (e) {
      r.status = 'error'
      r.error = redact(s, e.message)
      if (r.client === client) { r.intentional = true; client.stop(); r.client = null }
    }
    sync()
  }

  function stop(s) {
    const r = R(s.id)
    clearTimeout(r.restartTimer)
    r.intentional = true
    r.client?.stop()
    r.client = null
    r.status = 'stopped'
    r.error = null
    r.restarts = 0
    r.tools = []
    sync()
  }

  async function refresh(id) {
    const s = need(id)
    const r = R(id)
    if (r.status !== 'ready' || !r.client) throw new Error('o servidor não está rodando')
    applyTools(s, await r.client.listTools())
    await persist()
    sync()
    return view(s)
  }

  // ---------------------------------------------------------------- views
  const view = (s) => {
    const r = R(s.id)
    const raw = r.tools.length ? r.tools : Object.keys(s.tools).map((name) => ({ name }))
    return {
      id: s.id, label: s.label, transport: s.transport, command: s.command, args: s.args, url: s.url,
      env: s.env.map((e) => ({ key: e.key, secret: e.secret, value: e.secret ? undefined : e.value, configured: e.secret ? secretValue(s, 'env', e.key).length > 0 : true })),
      headers: s.headers.map((h) => ({ name: h.name, prefix: h.prefix ?? '', configured: secretValue(s, 'header', h.name).length > 0 })),
      enabled: s.enabled, status: s.enabled ? r.status : 'stopped', error: r.error, pid: r.client?.pid ?? null,
      server: r.info ? { name: r.info.serverInfo.name, version: r.info.serverInfo.version, protocol: r.info.protocolVersion } : null, logLines: r.log.length,
      tools: raw.map((t) => {
        const cfg = s.tools[t.name]
        const a = t.annotations ?? {}
        return { name: t.name, description: flat(t.description || t.title || '', 300), params: flattenParams(t.inputSchema), mode: cfg?.mode ?? 'off', changed: cfg?.changed === true, hints: { readOnly: a.readOnlyHint === true, destructive: a.destructiveHint === true, openWorld: a.openWorldHint === true }, listed: r.tools.some((x) => x.name === t.name) }
      }),
    }
  }

  // ---------------------------------------------------------------- validation
  function cleanConfig(input, existing) {
    const label = flat(input.label, 60)
    if (!label) throw new Error('dê um nome ao servidor')
    const transport = input.transport === 'http' ? 'http' : 'stdio'
    const s = { id: existing?.id ?? '', label, transport, command: '', args: [], url: '', env: [], headers: [], enabled: existing?.enabled ?? false, tools: existing?.tools ?? {} }
    if (transport === 'stdio') {
      s.command = String(input.command ?? '').trim()
      if (!s.command || s.command.length > 260 || !/^[\w.\\/:~ @+-]+$/.test(s.command)) throw new Error('comando inválido (use o nome do programa ou o caminho dele, sem argumentos: eles vão no campo de argumentos)')
      s.args = (Array.isArray(input.args) ? input.args : []).map(String).filter((a) => a !== '')
      if (s.args.length > 30 || s.args.some((a) => a.length > 500 || /[\u0000\r\n]/.test(a))) throw new Error('argumentos inválidos')
      if (s.args.some((a) => a.includes('<PASTA>'))) throw new Error('troque <PASTA> pelo caminho de uma pasta')
      const envIn = Array.isArray(input.env) ? input.env : []
      if (envIn.length > 20) throw new Error('variáveis demais')
      s.env = envIn.map((e) => {
        const key = String(e.key ?? '').trim()
        if (!ENV_KEY_RE.test(key)) throw new Error(`nome de variável inválido: ${key.slice(0, 30)}`)
        return { key, secret: e.secret === true, ...(e.secret === true ? {} : { value: String(e.value ?? '').slice(0, 300) }), _new: e.secret === true && typeof e.value === 'string' && e.value !== '' ? e.value : undefined }
      })
    } else {
      s.url = String(input.url ?? '').trim()
      checkUrl(s.url)
      const hIn = Array.isArray(input.headers) ? input.headers : []
      if (hIn.length > 5) throw new Error('cabeçalhos demais')
      s.headers = hIn.map((h) => {
        const name = String(h.name ?? '').trim()
        if (!HDR_RE.test(name) || FORBIDDEN_HDR.has(name.toLowerCase())) throw new Error(`cabeçalho não permitido: ${name.slice(0, 30)}`)
        return { name, prefix: String(h.prefix ?? '').slice(0, 20), _new: typeof h.value === 'string' && h.value !== '' ? h.value : undefined }
      })
    }
    return s
  }

  // ---------------------------------------------------------------- public API
  return {
    PRESETS,
    async ready() {
      if (loaded) return
      loaded = true
      try {
        const j = JSON.parse(await readFile(file, 'utf8'))
        state = { servers: Array.isArray(j.servers) ? j.servers.filter((s) => s && ID_RE.test(s.id)) : [] }
      } catch { /* first run */ }
    },
    /** Starts every server the owner had switched on (called once the vault is loaded). */
    async startEnabled() { await Promise.all(state.servers.filter((s) => s.enabled).map((s) => start(s))) },
    attach(t) { table = t; sync() },
    secretNames: () => state.servers.flatMap((s) => secretList(s).map((_, n) => secretNameAt(s, n))),
    list: () => state.servers.map(view),
    get: (id) => view(need(id)),
    log: (id) => [...R(need(id).id).log],
    stopAll() { for (const s of state.servers) { const r = R(s.id); clearTimeout(r.restartTimer); r.intentional = true; r.client?.stop({ now: true }) } },

    /**
     * Create (no id) or replace a server's configuration. A secret value is only written when a new one is typed;
     * an existing one is kept by (kind, key). Changing the command of a running server restarts it.
     */
    async save(input, { confirm = false } = {}) {
      const existing = input.id ? need(input.id) : null
      if (!existing && state.servers.length >= MAX_SERVERS) throw new Error(`no máximo ${MAX_SERVERS} servidores`)
      const s = cleanConfig(input, existing)
      if (s.transport === 'stdio' && !confirm) throw new Error('confirmação necessária: este servidor é um programa que vai rodar no seu PC com as suas permissões')
      if (existing) s.id = existing.id
      else {
        const base = ID_RE.test(String(input.id ?? '')) ? input.id : slug(s.label) || 'servidor'
        let id = ID_RE.test(base) ? base : `s-${base}`.slice(0, 20)
        for (let i = 2; get(id); i++) id = `${base.slice(0, 16)}-${i}`
        s.id = id
      }
      // secrets: carry over what was already stored, write what is new, drop what is gone
      const oldValues = existing ? Object.fromEntries(secretList(existing).map((x) => [`${x.kind}:${x.key}`, secretValue(existing, x.kind, x.key)])) : {}
      if (existing) for (let n = 0; n < secretList(existing).length; n++) await settings.clearKey(secretNameAt(existing, n)).catch(() => {})
      const keep = { ...s, env: s.env.map(({ _new, ...e }) => e), headers: s.headers.map(({ _new, ...h }) => h) }
      const list = secretList(keep)
      const fresh = { ...Object.fromEntries(s.env.filter((e) => e._new).map((e) => [`env:${e.key}`, e._new])), ...Object.fromEntries(s.headers.filter((h) => h._new).map((h) => [`header:${h.name}`, h._new])) }
      const idx = state.servers.findIndex((x) => x.id === keep.id)
      if (idx >= 0) state.servers[idx] = keep
      else state.servers.push(keep) // first: the vault only accepts names of servers that exist
      for (let n = 0; n < list.length; n++) {
        const v = fresh[`${list[n].kind}:${list[n].key}`] ?? oldValues[`${list[n].kind}:${list[n].key}`]
        if (v) await settings.setKey(secretNameAt(keep, n), v)
      }
      await persist()
      audit?.record('mcp.save', { id: keep.id, transport: keep.transport })
      if (keep.enabled) await start(keep) // the configuration changed under a running server
      return view(keep)
    },

    async setEnabled(id, on, { confirm = false } = {}) {
      const s = need(id)
      if (on && s.transport === 'stdio' && !confirm) throw new Error('confirmação necessária: este servidor é um programa que vai rodar no seu PC com as suas permissões')
      s.enabled = Boolean(on)
      await persist()
      audit?.record('mcp.enable', { id, on: s.enabled })
      if (on) await start(s)
      else stop(s)
      return view(s)
    },

    refresh,

    /** off | confirm | auto. Approving a tool pins its current description+schema (rug-pull guard). */
    async setToolMode(id, toolName, mode) {
      const s = need(id)
      if (!MODES.has(mode)) throw new Error('modo inválido')
      const t = R(id).tools.find((x) => x.name === toolName)
      if (mode !== 'off' && !t) throw new Error('ferramenta não encontrada (ligue e atualize o servidor primeiro)')
      if (mode === 'off') s.tools[toolName] = { ...(s.tools[toolName] ?? {}), mode: 'off', hash: s.tools[toolName]?.hash ?? '', changed: s.tools[toolName]?.changed === true }
      else s.tools[toolName] = { mode, hash: toolHash(t), changed: false }
      await persist()
      audit?.record('mcp.tool', { id, tool: toolName, mode })
      sync()
      return view(s)
    },

    /** The owner explicitly accepts the server's "read-only" hints: those tools run without asking. */
    async trustReadOnly(id) {
      const s = need(id)
      let n = 0
      for (const t of R(id).tools) if (t.annotations?.readOnlyHint === true && (s.tools[t.name]?.mode ?? 'off') === 'off') { s.tools[t.name] = { mode: 'auto', hash: toolHash(t), changed: false }; n++ }
      await persist()
      audit?.record('mcp.trust', { id, n })
      sync()
      return view(s)
    },

    async remove(id) {
      const s = need(id)
      stop(s)
      for (let n = 0; n < secretList(s).length; n++) await settings.clearKey(secretNameAt(s, n)).catch(() => {})
      state.servers = state.servers.filter((x) => x.id !== id)
      rt.delete(id)
      await persist()
      audit?.record('mcp.remove', { id })
    },
  }
}
