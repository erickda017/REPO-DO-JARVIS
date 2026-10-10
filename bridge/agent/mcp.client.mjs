import { spawn as nodeSpawn } from 'node:child_process'
import { AgentError } from './access.mjs'

/**
 * A small, strict MCP (Model Context Protocol) client: JSON-RPC 2.0 over stdio or Streamable HTTP, tools only.
 *
 * What it deliberately does NOT do (so a server can never reach further than the tools the owner switched on):
 *  - it advertises NO client capabilities, and refuses every request a server sends (sampling = driving our model,
 *    roots = listing our folders, elicitation = prompting the owner): the answer is always "method not found"
 *  - it never follows HTTP redirects, never sends secrets anywhere but the server the owner typed
 *  - it never passes JARVIS's own environment (keys, tokens) to a child process: only a short allowlist plus what the owner set
 *  - it caps message sizes and request time
 */
export const PROTOCOL_VERSION = '2025-06-18'
const MAX_LINE = 4 * 1024 * 1024 // one JSON-RPC message
const MAX_BODY = 8 * 1024 * 1024 // one HTTP response
const BASE_ENV = ['PATH', 'PATHEXT', 'SystemRoot', 'SYSTEMROOT', 'windir', 'ComSpec', 'COMSPEC', 'USERPROFILE', 'HOME', 'HOMEDRIVE', 'HOMEPATH', 'APPDATA', 'LOCALAPPDATA', 'TEMP', 'TMP', 'ProgramFiles', 'ProgramFiles(x86)', 'ProgramData', 'ProgramW6432', 'NUMBER_OF_PROCESSORS', 'PROCESSOR_ARCHITECTURE', 'OS', 'LANG', 'TZ']

export const childEnv = (extra = {}, base = process.env) => {
  const env = {}
  for (const k of BASE_ENV) if (base[k] !== undefined) env[k] = base[k]
  return { ...env, ...extra }
}

const q = (a) => (/[\s]/.test(a) ? `"${a}"` : a)
/** Windows: .cmd/.bat shims (npx, npm, uvx wrappers) need cmd.exe; every token is checked so nothing can break out of the line. */
export function windowsLaunch(command, args) {
  if (/\.exe$/i.test(command)) return { file: command, args, opts: {} }
  for (const t of [command, ...args]) if (/[&|<>^%"`\r\n]/.test(t)) throw new AgentError('mcp', `caractere não permitido em "${String(t).slice(0, 40)}" (& | < > ^ % " e crase)`)
  return { file: process.env.ComSpec || 'cmd.exe', args: ['/d', '/s', '/c', `"${[command, ...args].map(q).join(' ')}"`], opts: { windowsVerbatimArguments: true } }
}

function killTree(child, spawnFn) {
  try {
    if (process.platform === 'win32' && child.pid) spawnFn('taskkill', ['/pid', String(child.pid), '/T', '/F'], { windowsHide: true, stdio: 'ignore' }).on('error', () => {})
    else child.kill('SIGKILL')
  } catch { /* already gone */ }
}

/** Reads `data:` payloads out of a Server-Sent-Events byte stream. */
async function* sseMessages(res, maxBytes = MAX_BODY) {
  const reader = res.body.getReader()
  const dec = new TextDecoder()
  let buf = ''
  let total = 0
  for (;;) {
    const { done, value } = await reader.read()
    if (done) break
    total += value.length
    if (total > maxBytes) { reader.cancel().catch(() => {}); throw new AgentError('mcp', 'resposta grande demais') }
    buf += dec.decode(value, { stream: true })
    let i
    while ((i = buf.search(/\r?\n\r?\n/)) >= 0) {
      const raw = buf.slice(0, i)
      buf = buf.slice(i).replace(/^\r?\n\r?\n/, '')
      const data = raw.split(/\r?\n/).filter((l) => l.startsWith('data:')).map((l) => l.slice(5).replace(/^ /, '')).join('\n')
      if (data) yield data
    }
  }
}

/**
 * @param {{transport:'stdio', command:string, args?:string[], env?:Record<string,string>, cwd?:string} | {transport:'http', url:string, headers?:Record<string,string>}} spec
 * @param {{ spawn?: Function, fetch?: Function, onLog?: (line:string)=>void, onClose?: (why:string)=>void, onToolsChanged?: ()=>void, requestTimeoutMs?: number, checkUrl?: (url:string)=>void }} deps
 */
export function createMcpClient(spec, { spawn = nodeSpawn, fetch: fetchImpl = fetch, onLog = () => {}, onClose = () => {}, onToolsChanged = () => {}, requestTimeoutMs = 60_000, checkUrl = () => {} } = {}) {
  let nextId = 1
  const pending = new Map() // id -> { resolve, reject, timer }
  let child = null
  let sessionId = null
  let version = PROTOCOL_VERSION
  let closed = false
  let ready = false
  const abortHttp = new AbortController()

  const failAll = (err) => { for (const [id, p] of pending) { clearTimeout(p.timer); p.reject(err); pending.delete(id) } }
  const close = (why) => {
    if (closed) return
    closed = true
    ready = false
    failAll(new AgentError('mcp', `servidor MCP encerrado (${why})`))
    onClose(why)
  }

  // Everything that arrives (from a pipe or an HTTP body) goes through here.
  function dispatch(msg) {
    if (Array.isArray(msg)) return msg.forEach(dispatch)
    if (!msg || typeof msg !== 'object') return
    if (msg.id !== undefined && msg.method) {
      // A request FROM the server. We offered no capabilities, so only ping is answered.
      void send({ jsonrpc: '2.0', id: msg.id, ...(msg.method === 'ping' ? { result: {} } : { error: { code: -32601, message: 'Method not found' } }) }).catch(() => {})
      if (msg.method !== 'ping') onLog(`[jarvis] pedido do servidor recusado: ${String(msg.method).slice(0, 60)}`)
      return
    }
    if (msg.method) {
      if (msg.method === 'notifications/tools/list_changed') onToolsChanged()
      else if (msg.method === 'notifications/message') onLog(`[servidor] ${String(msg.params?.data ?? '').slice(0, 300)}`)
      return
    }
    const p = pending.get(msg.id)
    if (!p) return
    pending.delete(msg.id)
    clearTimeout(p.timer)
    if (msg.error) p.reject(new AgentError('mcp', `${String(msg.error.message ?? 'erro').slice(0, 300)}${msg.error.code !== undefined ? ` (código ${msg.error.code})` : ''}`))
    else p.resolve(msg.result ?? {})
  }

  // ------------------------------------------------------------------ transports
  async function send(msg) {
    if (closed) throw new AgentError('mcp', 'servidor MCP não está rodando')
    if (spec.transport === 'stdio') {
      if (!child?.stdin?.writable) throw new AgentError('mcp', 'servidor MCP não está rodando')
      child.stdin.write(JSON.stringify(msg) + '\n')
      return
    }
    // http: one POST per message; the answer (JSON or an SSE stream) carries the response(s)
    checkUrl(spec.url)
    const headers = { 'content-type': 'application/json', accept: 'application/json, text/event-stream', 'mcp-protocol-version': version, ...(spec.headers ?? {}), ...(sessionId ? { 'mcp-session-id': sessionId } : {}) }
    let res
    try {
      res = await fetchImpl(spec.url, { method: 'POST', headers, body: JSON.stringify(msg), redirect: 'manual', signal: AbortSignal.any([abortHttp.signal, AbortSignal.timeout(requestTimeoutMs + 5000)]) })
    } catch (e) {
      throw new AgentError('mcp', `não consegui falar com o servidor MCP (${String(e?.cause?.code ?? e?.message ?? e).slice(0, 100)})`)
    }
    if (res.status >= 300 && res.status < 400) throw new AgentError('mcp', 'o servidor tentou redirecionar; recusado por segurança')
    const sid = res.headers.get('mcp-session-id')
    if (sid) sessionId = sid
    if (res.status === 202 || res.status === 204) return
    if (res.status === 404 && sessionId) throw new AgentError('mcp', 'a sessão com o servidor expirou: religue o servidor')
    if (res.status >= 400) {
      const t = (await res.text().catch(() => '')).slice(0, 200)
      throw new AgentError('mcp', `servidor MCP respondeu HTTP ${res.status}${t ? `: ${t.replace(/\s+/g, ' ')}` : ''}`)
    }
    const type = res.headers.get('content-type') ?? ''
    if (/text\/event-stream/i.test(type)) {
      for await (const data of sseMessages(res)) { try { dispatch(JSON.parse(data)) } catch { onLog('[jarvis] mensagem SSE ilegível ignorada') } }
    } else {
      const text = await res.text()
      if (text.length > MAX_BODY) throw new AgentError('mcp', 'resposta grande demais')
      if (text.trim()) { try { dispatch(JSON.parse(text)) } catch { throw new AgentError('mcp', 'resposta do servidor não é JSON') } }
    }
  }

  function startStdio() {
    const run = process.platform === 'win32' ? windowsLaunch(spec.command, spec.args ?? []) : { file: spec.command, args: spec.args ?? [], opts: {} }
    child = spawn(run.file, run.args, { cwd: spec.cwd, env: childEnv(spec.env), shell: false, windowsHide: true, stdio: ['pipe', 'pipe', 'pipe'], ...run.opts })
    let buf = ''
    child.stdout.setEncoding('utf8')
    child.stdout.on('data', (d) => {
      buf += d
      if (buf.length > MAX_LINE * 2) { onLog('[jarvis] mensagem grande demais: servidor derrubado'); killTree(child, spawn); return }
      let i
      while ((i = buf.indexOf('\n')) >= 0) {
        const line = buf.slice(0, i).replace(/\r$/, '')
        buf = buf.slice(i + 1)
        if (!line.trim()) continue
        if (line.length > MAX_LINE) { onLog('[jarvis] linha grande demais ignorada'); continue }
        try { dispatch(JSON.parse(line)) } catch { onLog(`[stdout] ${line.slice(0, 200)}`) } // servers that print logs on stdout must not break us
      }
    })
    child.stderr.setEncoding('utf8')
    let errBuf = ''
    child.stderr.on('data', (d) => {
      errBuf += d
      let i
      while ((i = errBuf.indexOf('\n')) >= 0) { onLog(errBuf.slice(0, i).replace(/\r$/, '').slice(0, 300)); errBuf = errBuf.slice(i + 1) }
      if (errBuf.length > 2000) errBuf = errBuf.slice(-500)
    })
    child.on('error', (e) => close(`não consegui iniciar: ${String(e.code === 'ENOENT' ? 'comando não encontrado' : e.message).slice(0, 120)}`))
    child.on('exit', (code, sig) => close(`saiu${code !== null ? ` com código ${code}` : ''}${sig ? ` (${sig})` : ''}`))
    child.stdin.on('error', () => {}) // EPIPE after exit is handled by 'exit'
  }

  // ------------------------------------------------------------------ requests
  function request(method, params, timeoutMs = requestTimeoutMs) {
    const id = nextId++
    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => {
        pending.delete(id)
        send({ jsonrpc: '2.0', method: 'notifications/cancelled', params: { requestId: id, reason: 'timeout' } }).catch(() => {})
        reject(new AgentError('mcp', `o servidor MCP não respondeu em ${Math.round(timeoutMs / 1000)} s (${method})`))
      }, timeoutMs)
      timer.unref?.()
      pending.set(id, { resolve, reject, timer })
      send({ jsonrpc: '2.0', id, method, params }).catch((e) => { if (pending.delete(id)) { clearTimeout(timer); reject(e) } })
    })
  }
  const notify = (method, params) => send({ jsonrpc: '2.0', method, ...(params ? { params } : {}) })

  return {
    get ready() { return ready },
    get version() { return version },
    get pid() { return child?.pid ?? null },

    async start() {
      if (spec.transport === 'stdio') startStdio()
      const r = await request('initialize', { protocolVersion: PROTOCOL_VERSION, capabilities: {}, clientInfo: { name: 'jarvis', version: '0.9' } }, 45_000)
      if (typeof r.protocolVersion === 'string') version = r.protocolVersion
      await notify('notifications/initialized')
      ready = true
      return { serverInfo: { name: String(r.serverInfo?.name ?? '').slice(0, 80), version: String(r.serverInfo?.version ?? '').slice(0, 40) }, protocolVersion: version }
    },

    /** Every tool the server lists (follows pagination, capped). */
    async listTools() {
      const out = []
      let cursor
      for (let page = 0; page < 10; page++) {
        const r = await request('tools/list', cursor ? { cursor } : {}, 30_000)
        for (const t of r.tools ?? []) if (t && typeof t.name === 'string') out.push(t)
        cursor = r.nextCursor
        if (!cursor || out.length >= 300) break
      }
      return out.slice(0, 300)
    },

    callTool: (name, args, timeoutMs) => request('tools/call', { name, arguments: args ?? {} }, timeoutMs),

    /** now: kill the process tree immediately (used when JARVIS itself is exiting and timers will not run). */
    stop({ now = false } = {}) {
      if (closed) return
      closed = true
      ready = false
      failAll(new AgentError('mcp', 'servidor MCP desligado'))
      abortHttp.abort()
      if (spec.transport === 'stdio' && child) {
        try { child.stdin.end() } catch { /* gone */ }
        const c = child
        if (now) killTree(c, spawn)
        else setTimeout(() => { if (c.exitCode === null && c.signalCode === null) killTree(c, spawn) }, 1500).unref?.() // polite first (stdin closed), then the whole process tree if it is still alive
      } else if (spec.transport === 'http' && sessionId) {
        fetchImpl(spec.url, { method: 'DELETE', headers: { 'mcp-session-id': sessionId, ...(spec.headers ?? {}) }, redirect: 'manual', signal: AbortSignal.timeout(3000) }).catch(() => {})
      }
    },
  }
}
