import { mkdir, readFile, rename, writeFile } from 'node:fs/promises'
import { dirname } from 'node:path'
import { AgentError } from './access.mjs'
import { CONNECTORS } from './conectores.catalog.mjs'

/**
 * Connectors: external services the agent can read from and, only when the owner allows it, change.
 *
 * Each catalogue entry (conectores.catalog.mjs) becomes ordinary agent tools named <connector>_<tool>, registered ONLY while
 * the connector is switched on and has its credentials, so the model's prompt never lists services nobody connected.
 * Rules that hold for every connector:
 *  - credentials live in the encrypted settings vault (secret fields) or data/connectors.json (plain fields); never in a result, error or log
 *  - off until the owner switches it on; "allow changes" is a second, separate switch: without it only read tools exist
 *  - every call that changes something asks for confirmation and shows the method, host, path and the data that will be sent
 *  - the request only ever goes to the catalogue's own hosts (or the address the owner typed for self-hosted services);
 *    redirects are never followed (they would carry the credential to another host); responses are size-capped; calls are rate-limited
 *  - what a service returns is data, never instructions (the agent loop already treats tool results that way)
 */
const MAX_BYTES = 1_500_000
const TIMEOUT_MS = 20_000
const RATE = { windowMs: 60_000, max: 40 }
const UA = 'JARVIS-connector/1.0 (personal assistant)'
const SLUG = /^[\w.-]{1,120}$/
const secretName = (id, field) => `CONN_${id.replace(/-/g, '_')}_${field}`.toUpperCase()
const clip = (s, n) => (String(s).length > n ? String(s).slice(0, n) + `… [cortado, ${String(s).length} caracteres]` : String(s))
const hostOk = (host, allowed) => allowed.some((h) => (h.startsWith('.') ? host.endsWith(h) : host === h))

/** Fills {name} (one encoded segment) and {+name} (a path whose "/" stay). */
function fillPath(tpl, vals) {
  return tpl.replace(/\{(\+?)(\w+)\}/g, (_, plus, name) => {
    const v = vals[name]
    if (v === undefined || v === null || v === '') throw new AgentError('args', `falta o parâmetro "${name}"`)
    const s = String(v)
    if (plus) {
      const segs = s.replace(/^\/+/, '').split('/')
      if (segs.some((x) => x === '..' || x === '.')) throw new AgentError('args', `caminho inválido em "${name}"`)
      return '/' + segs.map(encodeURIComponent).join('/')
    }
    if (s === '.' || s === '..') throw new AgentError('args', `valor inválido em "${name}"`)
    return encodeURIComponent(s)
  })
}

const asJson = (v) => {
  if (typeof v !== 'string') return v
  try { return JSON.parse(v) } catch { return v }
}

export function createConnectors({ file = null, settings, fetch: fetchImpl = fetch, audit = null, clock = Date.now, catalog = CONNECTORS } = {}) {
  const byId = new Map(catalog.map((c) => [c.id, c]))
  let state = { enabled: {}, write: {}, values: {} } // values: plain (non-secret) field values per connector
  let loaded = !file
  let chain = Promise.resolve()
  const registered = new Map() // connector id -> tool names currently in the agent's table
  const calls = new Map() // connector id -> timestamps (rate limit)
  let toolsTable = null

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
  const need = (id) => {
    const c = byId.get(id)
    if (!c) throw new AgentError('unknown', `conector desconhecido: ${id}`)
    return c
  }

  // ---------------------------------------------------------------- credentials and fields
  const secretsOf = (c) => c.fields.filter((f) => f.secret)
  const secretValue = (c, f) => settings.env()[secretName(c.id, f.name)] || ''
  const fieldValues = (c) => Object.fromEntries(c.fields.map((f) => [f.name, f.secret ? secretValue(c, f) : (state.values[c.id]?.[f.name] ?? f.default ?? '')]))
  const missing = (c) => c.fields.filter((f) => f.required && !fieldValues(c)[f.name]).map((f) => f.label)
  const ready = (c) => missing(c).length === 0
  const allSecrets = (c) => secretsOf(c).map((f) => secretValue(c, f)).filter((v) => v.length >= 8)
  const redactFor = (c, text) => {
    let s = String(text)
    for (const v of allSecrets(c)) s = s.split(v).join('***').split(encodeURIComponent(v)).join('***')
    return s
  }

  // ---------------------------------------------------------------- request building (pure: tested without a network)
  function resolveArgs(tool, raw = {}) {
    const a = { ...(tool.defaults ?? {}) }
    for (const [k, v] of Object.entries(raw ?? {})) if (v !== undefined && v !== null && v !== '') a[k] = v
    for (const k of tool.req ?? []) if (a[k] === undefined) throw new AgentError('args', `falta o parâmetro "${k}"`)
    for (const [k, m] of Object.entries(tool.max ?? {})) if (a[k] !== undefined) a[k] = Math.min(Math.max(Number(a[k]) || 1, 1), m)
    for (const k of tool.json ?? []) if (a[k] !== undefined) a[k] = asJson(a[k])
    return a
  }

  function buildRequest(c, tool, rawArgs) {
    const fv = fieldValues(c)
    const a = resolveArgs(tool, rawArgs)
    const vals = { ...fv, ...a }
    // base: catalogue base with the owner's fields filled in
    let base = (tool.base ?? c.base).replace(/\{(\w+)\}/g, (_, n) => {
      if (fv[n] === undefined || fv[n] === '') throw new AgentError('config', `falta configurar "${n}" neste conector`)
      return fv[n]
    }).replace(/\/+$/, '')
    if (c.baseCheck && !c.baseCheck.test(base)) throw new AgentError('config', 'o endereço configurado não tem o formato esperado para este serviço')
    const method = tool.methodArg ? String(a[tool.methodArg] ?? '').toUpperCase() : tool.method
    if (tool.methodArg && !(tool.methods ?? []).includes(method)) throw new AgentError('args', `método deve ser um destes: ${tool.methods.join(', ')}`)
    const path = tool.path ? fillPath(tool.path, vals) : ''
    if (tool.raw && !String(a.path ?? '').startsWith('/')) throw new AgentError('args', 'o caminho deve começar com /')
    const url = new URL(base + path)
    // Where the request may go. A public service only ever talks to its own hosts, over https.
    if (url.username || url.password) throw new AgentError('config', 'o endereço não pode conter usuário e senha')
    if (!/^https?:$/.test(url.protocol)) throw new AgentError('config', 'só http(s)')
    if (!c.allowPrivate) {
      if (url.protocol !== 'https:') throw new AgentError('config', 'este serviço só é acessado por https')
      if (!hostOk(url.hostname, c.hosts ?? [])) throw new AgentError('config', `endereço fora dos servidores deste serviço: ${url.hostname}`)
    } else if (/^(169\.254\.|0\.|22[4-9]\.|2[3-5]\d\.|\[?fe80)/i.test(url.hostname)) {
      throw new AgentError('config', 'endereço não permitido') // link-local/cloud-metadata/multicast stay out even for self-hosted services
    }
    // query string
    for (const [argName, key] of Object.entries(tool.query ?? {})) if (a[argName] !== undefined) url.searchParams.set(key, String(a[argName]))
    for (const [k, v] of Object.entries(tool.fixedQuery ?? {})) url.searchParams.set(k, v)
    for (const [field, key] of Object.entries(c.queryFields ?? {})) if (fv[field]) url.searchParams.set(key, fv[field])
    if (c.auth.type === 'query') for (const [key, field] of Object.entries(c.auth.params)) url.searchParams.set(key, fv[field])
    if (tool.rawQuery && a[tool.rawQuery]) {
      const raw = String(a[tool.rawQuery]).replace(/^\?/, '')
      if (raw.length > 600 || /[\r\n]/.test(raw)) throw new AgentError('args', 'filtro inválido')
      for (const [k, v] of new URLSearchParams(raw)) url.searchParams.append(k, v)
    }
    // headers
    const headers = { 'User-Agent': UA, Accept: 'application/json', ...(c.headers ?? {}), ...(tool.headers ?? {}) }
    const auth = c.auth
    const token = auth.field ? fv[auth.field] : ''
    if (auth.type === 'bearer' && token) headers.Authorization = `Bearer ${token}`
    else if (auth.type === 'header' && token) headers[auth.nameField ? fv[auth.nameField] || 'Authorization' : auth.name] = `${auth.prefixField ? fv[auth.prefixField] ?? '' : auth.prefix ?? ''}${token}`
    else if (auth.type === 'basic') headers.Authorization = `Basic ${Buffer.from(`${fv[auth.user]}:${fv[auth.pass]}`).toString('base64')}`
    for (const [k, field] of Object.entries(auth.also ?? {})) headers[k] = fv[field]
    for (const [argName, h] of Object.entries(tool.headerArgs ?? {})) if (a[argName] !== undefined && !/[\r\n]/.test(String(a[argName]))) headers[h] = String(a[argName]).slice(0, 200)
    // body
    let body
    if (tool.graphql) {
      const variables = {}
      for (const v of tool.graphql.vars ?? []) if (a[v] !== undefined) variables[v] = a[v]
      for (const [argName, v] of Object.entries(tool.graphql.ints ?? {})) if (a[argName] !== undefined) variables[v] = Number(a[argName])
      body = { query: tool.graphql.query, variables }
    } else if (tool.bodyFn) body = tool.bodyFn(a, fv)
    else if (tool.body || tool.fixedBody) {
      body = { ...(tool.fixedBody ?? {}) }
      for (const [argName, key] of Object.entries(tool.body ?? {})) if (a[argName] !== undefined) body[key] = a[argName]
    }
    let payload
    if (tool.bodyRaw) { payload = String(a[tool.bodyRaw] ?? ''); headers['Content-Type'] = 'text/plain; charset=utf-8' }
    else if (body !== undefined && method !== 'GET' && method !== 'HEAD') { payload = JSON.stringify(body); headers['Content-Type'] = 'application/json' }
    return { url: url.toString(), init: { method, headers, body: payload, redirect: 'manual' }, args: a, fields: fv }
  }

  /** What the owner is asked to approve: method, host + path, and the data that will be sent. */
  function describe(c, tool, rawArgs) {
    let where = ''
    try { const u = new URL(buildRequest(c, tool, rawArgs).url); where = `${u.hostname}${u.pathname}` } catch { where = c.label }
    const shown = Object.entries(rawArgs ?? {}).filter(([, v]) => v !== undefined && v !== '').map(([k, v]) => `${k}=${clip(typeof v === 'string' ? v : JSON.stringify(v), 160)}`).join('; ')
    const head = tool.risk === 'danger' ? `${c.label}: AÇÃO QUE PODE NÃO TER VOLTA — ` : `${c.label}: `
    return `${head}${tool.desc} (${tool.methodArg ? String(rawArgs?.[tool.methodArg]).toUpperCase() : tool.method} ${where}). Dados: ${clip(shown, 500) || '(nenhum)'}`
  }

  // ---------------------------------------------------------------- execution
  const rateOk = (id) => {
    const now = clock()
    const list = (calls.get(id) ?? []).filter((t) => now - t < RATE.windowMs)
    if (list.length >= RATE.max) { calls.set(id, list); return false }
    list.push(now)
    calls.set(id, list)
    return true
  }

  async function http(c, req) {
    let res
    try {
      res = await fetchImpl(req.url, { ...req.init, signal: AbortSignal.timeout(TIMEOUT_MS) })
    } catch (e) {
      throw new AgentError('network', `${c.label}: não consegui falar com o serviço (${redactFor(c, e?.cause?.code ?? e?.message ?? e).slice(0, 120)})`)
    }
    if (res.status >= 300 && res.status < 400) throw new AgentError('redirect', `${c.label}: o serviço tentou redirecionar (HTTP ${res.status}); recusado por segurança`)
    const text = await res.text()
    if (text.length > MAX_BYTES) throw new AgentError('size', `${c.label}: resposta grande demais (${Math.round(text.length / 1024)} KB)`)
    let json
    try { json = text ? JSON.parse(text) : null } catch { json = undefined }
    return { status: res.status, text, json }
  }

  const errorText = (c, r) => {
    const j = r.json
    const m = j?.message ?? j?.error?.message ?? (typeof j?.error === 'string' ? j.error : null) ?? j?.errors?.[0]?.message ?? j?.detail ?? j?.description ?? (typeof j === 'string' ? j : null) ?? r.text.slice(0, 200)
    return redactFor(c, `${c.label}: HTTP ${r.status} — ${clip(typeof m === 'string' ? m : JSON.stringify(m), 240)}`)
  }

  async function execute(c, tool, rawArgs) {
    if (!rateOk(c.id)) throw new AgentError('rate', `${c.label}: muitas chamadas em um minuto; espere um pouco`)
    if (tool.custom) {
      const a = resolveArgs(tool, rawArgs)
      const base = c.base.replace(/\/+$/, '')
      const get = async (p) => {
        const req = { url: base + p, init: { method: 'GET', headers: { 'User-Agent': UA, Accept: 'application/json' }, redirect: 'manual' } }
        if (!hostOk(new URL(req.url).hostname, c.hosts ?? [])) throw new AgentError('config', 'endereço fora dos servidores deste serviço')
        const r = await http(c, req)
        if (r.status >= 400) throw new AgentError('http', errorText(c, r))
        return r.json
      }
      const data = await tool.custom({ get, args: a })
      audit?.record('connector.call', { id: c.id, tool: tool.name, ok: true })
      return { data }
    }
    const req = buildRequest(c, tool, rawArgs)
    const r = await http(c, req)
    const ok = r.status < 400
    audit?.record('connector.call', { id: c.id, tool: tool.name, ok, status: r.status }) // never the arguments
    if (!ok) throw new AgentError('http', errorText(c, r))
    const bad = c.failIf?.(r.json)
    if (bad) throw new AgentError('service', redactFor(c, `${c.label}: ${clip(bad, 240)}`))
    let data = r.json === undefined ? r.text : r.json
    if (!tool.raw && tool.pick) {
      try { data = tool.pick(data, req.args) } catch { throw new AgentError('shape', `${c.label}: a resposta veio em um formato inesperado (a API pode ter mudado)`) }
    }
    data = JSON.parse(redactFor(c, JSON.stringify(data ?? null))) // a secret that an API echoes back never reaches the model
    const size = JSON.stringify(data ?? null).length
    if (size > 24_000) data = { truncated: true, note: `resposta cortada (${size} caracteres); peça menos itens`, text: JSON.stringify(data).slice(0, 24_000) }
    const change = tool.risk !== 'read'
    return change
      ? { data, verified: true, evidence: `o serviço respondeu HTTP ${r.status} (${c.label}, ${tool.name})` }
      : { data, evidence: `${c.label}: HTTP ${r.status}` }
  }

  // ---------------------------------------------------------------- tools in the agent's table
  function toolDefs(c) {
    const write = state.write[c.id] === true
    const out = {}
    for (const t of c.tools) {
      if (t.risk !== 'read' && !write) continue
      const name = `${c.id.replace(/-/g, '_')}_${t.name}`
      out[name] = {
        name, group: 'connectors', risk: t.risk, connector: c.id, external: true, // external: what it returns counts as outside content for the injection guard
        desc: `[${c.label}] ${t.desc}`,
        params: t.params ?? {},
        run: (args) => execute(c, t, args ?? {}),
        ...(t.risk !== 'read' ? { confirm: async (args) => describe(c, t, args ?? {}) } : {}),
      }
    }
    return out
  }

  function sync() {
    if (!toolsTable) return
    for (const names of registered.values()) for (const n of names) delete toolsTable[n]
    registered.clear()
    for (const c of catalog) {
      if (!state.enabled[c.id] || !ready(c)) continue
      const defs = toolDefs(c)
      Object.assign(toolsTable, defs)
      registered.set(c.id, Object.keys(defs))
    }
  }

  const view = (c) => ({
    id: c.id, label: c.label, category: c.category, desc: c.desc, help: c.help, selfHosted: Boolean(c.allowPrivate), hasTest: Boolean(c.test),
    fields: c.fields.map((f) => ({ name: f.name, label: f.label, secret: Boolean(f.secret), required: Boolean(f.required), kind: f.kind ?? 'text', placeholder: f.placeholder ?? '', configured: Boolean(f.secret ? secretValue(c, f) : (state.values[c.id]?.[f.name] ?? f.default)), ...(f.secret ? {} : { value: state.values[c.id]?.[f.name] ?? f.default ?? '' }) })),
    ready: ready(c), missing: missing(c), enabled: state.enabled[c.id] === true && ready(c), write: state.write[c.id] === true,
    tools: c.tools.map((t) => ({ name: `${c.id.replace(/-/g, '_')}_${t.name}`, desc: t.desc, risk: t.risk })),
  })

  return {
    async ready() {
      if (loaded) return
      loaded = true
      try {
        const j = JSON.parse(await readFile(file, 'utf8'))
        state = { enabled: j.enabled ?? {}, write: j.write ?? {}, values: j.values ?? {} }
      } catch { /* first run */ }
      sync()
    },
    /** The agent's tool table: connector tools are added to / removed from it as the owner switches connectors. */
    attach(table) { toolsTable = table; sync() },
    /** Secret names this module may store through the settings vault (so settings.setKey accepts them). */
    secretNames: () => catalog.flatMap((c) => secretsOf(c).map((f) => secretName(c.id, f.name))),
    list: () => catalog.map(view),
    get: (id) => view(need(id)),

    /** Save field values. A secret is only sent to the vault when a new value is typed; an empty string clears the field. */
    async configure(id, values = {}) {
      const c = need(id)
      for (const [name, raw] of Object.entries(values)) {
        const f = c.fields.find((x) => x.name === name)
        if (!f) throw new Error(`campo desconhecido: ${name}`)
        const v = String(raw ?? '').trim()
        if (f.secret) {
          if (v) await settings.setKey(secretName(c.id, f.name), v)
          else await settings.clearKey(secretName(c.id, f.name))
          continue
        }
        if (v && (f.kind === 'slug' || f.name === 'topic') && !SLUG.test(v)) throw new Error(`"${f.label}": use só letras, números, ponto, hífen e sublinhado`)
        if (v && f.kind === 'url') {
          let u
          try { u = new URL(v) } catch { throw new Error(`"${f.label}": endereço inválido`) }
          if (!/^https?:$/.test(u.protocol) || u.username || u.password) throw new Error(`"${f.label}": use http(s) sem usuário e senha`)
        }
        if (v.length > 300 || /[\r\n]/.test(v)) throw new Error(`"${f.label}": valor inválido`)
        state.values[c.id] = { ...(state.values[c.id] ?? {}), [f.name]: v }
      }
      if (!ready(c)) state.enabled[c.id] = false
      await persist()
      audit?.record('connector.config', { id, fields: Object.keys(values) })
      sync()
      return view(c)
    },

    /** Forget every credential and value of a connector and switch it off. */
    async clear(id) {
      const c = need(id)
      for (const f of secretsOf(c)) await settings.clearKey(secretName(c.id, f.name)).catch(() => {})
      delete state.values[c.id]
      state.enabled[c.id] = false
      state.write[c.id] = false
      await persist()
      audit?.record('connector.clear', { id })
      sync()
      return view(c)
    },

    async setEnabled(id, on) {
      const c = need(id)
      if (on && !ready(c)) throw new Error(`faltam dados para ligar: ${missing(c).join(', ')}`)
      state.enabled[c.id] = Boolean(on)
      if (!on) state.write[c.id] = false
      await persist()
      audit?.record('connector.enable', { id, on: Boolean(on) })
      sync()
      return view(c)
    },

    async setWrite(id, on) {
      const c = need(id)
      if (on && !state.enabled[c.id]) throw new Error('ligue o conector antes de permitir alterações')
      state.write[c.id] = Boolean(on)
      await persist()
      audit?.record('connector.write', { id, on: Boolean(on) })
      sync()
      return view(c)
    },

    /** Runs the connector's read-only check with the saved credentials, switched on or not. */
    async test(id) {
      const c = need(id)
      if (!ready(c)) return { ok: false, message: `faltam dados: ${missing(c).join(', ')}` }
      const t = c.tools.find((x) => x.name === c.test)
      if (!t) return { ok: true, message: 'configurado (este conector não tem uma chamada de teste sem efeito: use-o pela primeira vez com cuidado)' }
      try {
        await execute(c, t, c.testArgs ?? {})
        return { ok: true, message: `${c.label} respondeu` }
      } catch (e) {
        const ok = (c.testOkStatuses ?? []).some((s) => String(e.message).includes(`HTTP ${s}`))
        return ok ? { ok: true, message: `${c.label} aceitou a chave` } : { ok: false, message: String(e.message).slice(0, 300) }
      }
    },

    // for tests and for the discovery tool
    buildRequest: (id, toolName, args) => { const c = need(id); return buildRequest(c, c.tools.find((t) => t.name === toolName) ?? (() => { throw new Error('unknown tool') })(), args) },
    describe: (id, toolName, args) => { const c = need(id); return describe(c, c.tools.find((t) => t.name === toolName), args) },
    catalog,
  }
}
