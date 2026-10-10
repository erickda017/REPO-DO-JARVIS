import test from 'node:test'
import assert from 'node:assert/strict'
import http from 'node:http'
import { createAccess } from '../../bridge/agent/access.mjs'
import { createAgent } from '../../bridge/agent/agent.mjs'
import { createConnectors } from '../../bridge/agent/conectores.mjs'
import { CONNECTORS } from '../../bridge/agent/conectores.catalog.mjs'
import { buildTools } from '../../bridge/agent/tools.mjs'
import { createRegistry } from '../../bridge/command/providers/registry.mjs'
import { createSettings } from '../../bridge/command/settings.mjs'
import { createAudit } from '../../bridge/command/audit.mjs'

const SECRET = 'SEGREDO-do-teste-1234567890'

/** A real HTTP server standing in for "the service": records every request and answers from a table. */
async function server(handler) {
  const seen = []
  const srv = http.createServer((req, res) => {
    let body = ''
    req.on('data', (d) => (body += d))
    req.on('end', () => {
      seen.push({ method: req.method, url: req.url, headers: req.headers, body })
      const r = handler({ method: req.method, url: new URL(req.url, 'http://x'), headers: req.headers, body }) ?? { json: {} }
      res.writeHead(r.status ?? 200, { 'content-type': 'application/json', ...(r.headers ?? {}) })
      res.end(r.raw ?? JSON.stringify(r.json ?? {}))
    })
  })
  await new Promise((r) => srv.listen(0, '127.0.0.1', r))
  return { seen, base: `http://127.0.0.1:${srv.address().port}`, close: () => new Promise((r) => srv.close(r)) }
}

function stack({ fetch: f = fetch } = {}) {
  let connectors
  let registry
  const audit = createAudit({ file: null })
  const settings = createSettings({ file: null, getRegistry: () => registry, baseEnv: {}, getExtraNames: () => connectors?.secretNames() ?? [] })
  registry = createRegistry([])
  connectors = createConnectors({ file: null, settings, fetch: f, audit })
  const table = {}
  connectors.attach(table)
  return { connectors, settings, table, audit }
}

// ------------------------------------------------------------------------------------------------- the catalogue itself
test('catalogue: unique ids/tool names, valid risks, every {placeholder} is a declared parameter, writes are never GET', () => {
  const ids = new Set()
  for (const c of CONNECTORS) {
    assert.ok(!ids.has(c.id), `duplicate connector ${c.id}`)
    ids.add(c.id)
    assert.ok(c.label && c.category && c.desc && c.base, `${c.id}: label/category/desc/base`)
    assert.ok(c.allowPrivate || (Array.isArray(c.hosts) && c.hosts.length), `${c.id}: needs hosts or allowPrivate`)
    const fieldNames = new Set(c.fields.map((f) => f.name))
    for (const m of c.base.matchAll(/\{(\w+)\}/g)) assert.ok(fieldNames.has(m[1]), `${c.id}: base uses unknown field ${m[1]}`)
    if (c.auth.field) assert.ok(fieldNames.has(c.auth.field), `${c.id}: auth field`)
    if (c.test) assert.ok(c.tools.some((t) => t.name === c.test && t.risk === 'read'), `${c.id}: test must be a read tool`)
    const names = new Set()
    for (const t of c.tools) {
      assert.ok(!names.has(t.name), `${c.id}: duplicate tool ${t.name}`)
      names.add(t.name)
      assert.ok(['read', 'write', 'danger'].includes(t.risk), `${c.id}.${t.name}: risk`)
      if (t.custom) { assert.equal(t.risk, 'read'); continue }
      const method = t.method ?? 'POST'
      if (t.risk !== 'read') assert.ok(method !== 'GET', `${c.id}.${t.name}: a write must not be a GET`)
      if (t.risk === 'read' && method !== 'GET') assert.ok(/search|query|graphql/.test(t.path ?? '') || t.graphql, `${c.id}.${t.name}: read tool with ${method} must be a query`)
      for (const m of (t.path ?? '').matchAll(/\{\+?(\w+)\}/g)) assert.ok(t.params?.[m[1]] || fieldNames.has(m[1]), `${c.id}.${t.name}: path uses undeclared {${m[1]}}`)
      for (const r of t.req ?? []) assert.ok(t.params?.[r] || t.params === undefined, `${c.id}.${t.name}: required "${r}" not in params`)
      for (const k of Object.keys(t.query ?? {})) assert.ok(t.params?.[k], `${c.id}.${t.name}: query arg "${k}" not in params`)
      for (const k of Object.keys(t.body ?? {})) assert.ok(t.params?.[k], `${c.id}.${t.name}: body arg "${k}" not in params`)
    }
  }
  assert.ok(CONNECTORS.length >= 25, 'an extensive catalogue')
})

function sampleValue(c, f) {
  if (f.secret) return c.id === 'discord-webhook' ? 'https://discord.com/api/webhooks/123456/abc-DEF_ghi' : SECRET
  if (f.name === 'lang') return 'pt'
  if (f.kind === 'url') return 'https://svc.example.test/base'
  if (f.name === 'email') return 'eu@exemplo.test'
  if (f.name === 'from') return 'JARVIS <jarvis@exemplo.test>'
  if (f.kind === 'slug' || f.name === 'topic') return 'abc123'
  return f.default ?? 'valor'
}
const sampleArgs = (t) => Object.fromEntries((t.req ?? []).map((k) => [k, t.json?.includes(k) ? '{"a":1}' : k === 'method' ? 'POST' : k === 'path' ? '/x/y' : k === 'filter' ? 'id=eq.1' : k === 'to' ? 'a@b.test' : 'abc']))

test('catalogue: every tool of every connector builds a valid request to an allowed host, with its credential in the right place and nothing undefined', async () => {
  const { connectors } = stack()
  let n = 0
  for (const c of CONNECTORS) {
    const values = Object.fromEntries(c.fields.map((f) => [f.name, sampleValue(c, f)]))
    await connectors.configure(c.id, values)
    for (const t of c.tools) {
      if (t.custom) continue
      const { url, init } = connectors.buildRequest(c.id, t.name, sampleArgs(t))
      const u = new URL(url)
      n++
      assert.ok(!/undefined|null|\[object/.test(url), `${c.id}.${t.name}: bad url ${url}`)
      assert.equal(init.redirect, 'manual')
      if (!c.allowPrivate) {
        assert.equal(u.protocol, 'https:', `${c.id}.${t.name}`)
        assert.ok((c.hosts ?? []).some((h) => (h.startsWith('.') ? u.hostname.endsWith(h) : u.hostname === h)), `${c.id}.${t.name}: host ${u.hostname}`)
      }
      if (c.auth.type === 'bearer') assert.equal(init.headers.Authorization, `Bearer ${SECRET}`, `${c.id}.${t.name}`)
      if (c.auth.type === 'basic') assert.match(init.headers.Authorization, /^Basic /)
      if (init.body !== undefined && !t.bodyRaw) { JSON.parse(init.body); assert.notEqual(init.method, 'GET') }
      if (init.method === 'GET') assert.equal(init.body, undefined)
      // a secret never rides in the URL unless the service's own scheme puts it there (Trello query, Telegram path, Discord webhook)
      if (!['trello', 'telegram', 'discord-webhook'].includes(c.id)) assert.ok(!url.includes(SECRET), `${c.id}.${t.name}: secret in URL`)
    }
  }
  assert.ok(n >= 90, `built ${n} requests`)
})

test('catalogue: path parameters cannot climb out of the API (.. / encoded slashes) and a filter cannot smuggle a header', async () => {
  const { connectors } = stack()
  await connectors.configure('github', { token: SECRET })
  assert.throws(() => connectors.buildRequest('github', 'issues', { owner: '..', repo: 'r' }), /inválido/)
  const { url } = connectors.buildRequest('github', 'issues', { owner: 'a/b', repo: 'r x' })
  assert.match(url, /\/repos\/a%2Fb\/r%20x\/issues/)
  assert.throws(() => connectors.buildRequest('github', 'file', { owner: 'o', repo: 'r', path: '../../etc/passwd' }), /inválido/)
  await connectors.configure('supabase', { project: 'abc123', token: SECRET })
  assert.throws(() => connectors.buildRequest('supabase', 'select', { table: 't', filter: 'a=1\r\nX: y' }), /filtro/)
  await assert.rejects(connectors.configure('wikipedia', { lang: 'evil.com/x#' }), /use só letras/)
})

// ------------------------------------------------------------------------------------------------- lifecycle and permissions
test('lifecycle: nothing is exposed until configured AND switched on; changes need their own permission; clearing wipes everything', async () => {
  const { connectors, table, settings } = stack()
  assert.deepEqual(Object.keys(table), [], 'no connector tool exists by default')
  await assert.rejects(connectors.setEnabled('github', true), /faltam dados/)
  await connectors.configure('github', { token: SECRET })
  assert.deepEqual(Object.keys(table), [], 'configured but still off')
  await connectors.setEnabled('github', true)
  const readOnly = Object.keys(table)
  assert.ok(readOnly.includes('github_repos') && !readOnly.includes('github_issue_create'), 'read tools only')
  assert.ok(Object.values(table).every((t) => t.group === 'connectors' && t.external))
  await connectors.setWrite('github', true)
  assert.ok(table.github_issue_create && table.github_issue_create.risk === 'write' && typeof table.github_issue_create.confirm === 'function')
  await connectors.setWrite('github', false)
  assert.ok(!table.github_issue_create, 'taking the permission back removes the write tools')
  await assert.rejects(connectors.setWrite('notion', true), /ligue o conector/)
  // the secret went to the vault under a name only a connector may use, and never comes back out
  assert.equal(settings.keys().find((k) => k.name === 'CONN_GITHUB_TOKEN').configured, true)
  assert.ok(!JSON.stringify(connectors.list()).includes(SECRET), 'list() never returns a secret')
  await connectors.clear('github')
  assert.deepEqual(Object.keys(table), [])
  assert.equal(settings.keys().find((k) => k.name === 'CONN_GITHUB_TOKEN').configured, false)
  await assert.rejects(settings.setKey('CONN_NOT_A_CONNECTOR_X', 'abcdefghijk'), /unknown key name/)
})

test('confirmation text names the service, the method, the host+path and the data that will be sent (and flags irreversible actions)', async () => {
  const { connectors, table } = stack()
  await connectors.configure('resend', { token: SECRET, from: 'x@y.test' })
  await connectors.setEnabled('resend', true)
  await connectors.setWrite('resend', true)
  const msg = await table.resend_send.confirm({ to: 'chefe@empresa.test', subject: 'Oi', text: 'corpo' })
  assert.match(msg, /Resend/)
  assert.match(msg, /NÃO TER VOLTA/)
  assert.match(msg, /POST api\.resend\.com\/emails/)
  assert.match(msg, /chefe@empresa\.test/)
  assert.ok(!msg.includes(SECRET))
})

// ------------------------------------------------------------------------------------------------- real HTTP against a local server
test('real HTTP: auth header, query, JSON body, the service answer and verified evidence (REST connector + Home Assistant)', async () => {
  const srv = await server(({ method, url }) => {
    if (url.pathname === '/api/states') return { json: [{ entity_id: 'light.sala', state: 'on', attributes: { friendly_name: 'Sala' } }, { entity_id: 'sensor.temp', state: '21', attributes: {} }] }
    if (url.pathname.startsWith('/api/services/light/turn_on')) return { json: [{ entity_id: 'light.sala', state: 'on' }] }
    if (url.pathname === '/items' && method === 'GET') return { json: { items: [1, 2, 3], q: url.searchParams.get('q') } }
    if (url.pathname === '/items' && method === 'POST') return { status: 201, json: { id: 7 } }
    return { status: 404, json: { message: 'não achei' } }
  })
  try {
    const { connectors, table } = stack()
    await connectors.configure('home-assistant', { url: srv.base, token: SECRET })
    await connectors.configure('rest', { url: srv.base, token: SECRET })
    for (const id of ['home-assistant', 'rest']) { await connectors.setEnabled(id, true); await connectors.setWrite(id, true) }

    const states = await table.home_assistant_states.run({ domain: 'light' })
    assert.deepEqual(states.data, [{ id: 'light.sala', state: 'on', name: 'Sala' }], 'the domain filter ran on the real answer')
    assert.equal(srv.seen[0].headers.authorization, `Bearer ${SECRET}`)
    assert.ok(!('verified' in states), 'a read has nothing to verify')

    const got = await table.rest_get.run({ path: '/items', query: 'q=jarvis&n=2' })
    assert.deepEqual(got.data.items, [1, 2, 3])
    assert.equal(got.data.q, 'jarvis')

    const sent = await table.rest_send.run({ method: 'post', path: '/items', body: '{"nome":"x"}' })
    assert.equal(sent.verified, true)
    assert.match(sent.evidence, /HTTP 201/)
    const post = srv.seen.at(-1)
    assert.equal(post.method, 'POST')
    assert.equal(post.headers['content-type'], 'application/json')
    assert.deepEqual(JSON.parse(post.body), { nome: 'x' })

    const call = await table.home_assistant_call_service.run({ domain: 'light', service: 'turn_on', entity_id: 'light.sala', data: '{"brightness":120}' })
    assert.equal(call.verified, true)
    assert.deepEqual(JSON.parse(srv.seen.at(-1).body), { brightness: 120, entity_id: 'light.sala' })

    await assert.rejects(table.rest_get.run({ path: '/nada' }), /HTTP 404.*não achei/)
    await assert.rejects(table.rest_get.run({ path: 'sem-barra' }), /começar com/)
    await assert.rejects(table.rest_send.run({ method: 'TRACE', path: '/x' }), /método deve ser/)
    const t = await connectors.test('home-assistant')
    assert.equal(t.ok, false, 'no /api/ route on this fake server: the test reports it instead of pretending')
  } finally {
    await srv.close()
  }
})

test('security: redirects are never followed, oversized answers are refused, and a secret an API echoes (or puts in an error) never reaches the result', async () => {
  const srv = await server(({ url }) => {
    if (url.pathname === '/moved') return { status: 302, headers: { location: 'http://evil.test/steal' }, json: {} }
    if (url.pathname === '/big') return { raw: JSON.stringify({ x: 'a'.repeat(1_600_000) }) }
    if (url.pathname === '/echo') return { json: { yourToken: SECRET, ok: true } }
    if (url.pathname === '/err') return { status: 401, json: { message: `bad token ${SECRET}` } }
    return { json: {} }
  })
  try {
    const { connectors, table } = stack()
    await connectors.configure('rest', { url: srv.base, token: SECRET })
    await connectors.setEnabled('rest', true)
    await assert.rejects(table.rest_get.run({ path: '/moved' }), /redirecionar.*recusado/)
    assert.ok(!srv.seen.some((r) => r.url.includes('steal')), 'the credential never followed the redirect')
    await assert.rejects(table.rest_get.run({ path: '/big' }), /grande demais/)
    const echo = await table.rest_get.run({ path: '/echo' })
    assert.ok(!JSON.stringify(echo).includes(SECRET), 'echoed secret redacted')
    await assert.rejects(table.rest_get.run({ path: '/err' }), (e) => /401/.test(e.message) && !e.message.includes(SECRET))
  } finally {
    await srv.close()
  }
})

test('security: self-hosted addresses cannot point at cloud metadata or carry credentials; public services cannot be redirected to other hosts', async () => {
  const { connectors } = stack()
  await connectors.configure('rest', { url: 'http://169.254.169.254', token: SECRET })
  assert.throws(() => connectors.buildRequest('rest', 'get', { path: '/latest/meta-data' }), /não permitido/)
  await assert.rejects(connectors.configure('rest', { url: 'http://user:pw@host.test' }), /sem usuário e senha/)
  await assert.rejects(connectors.configure('rest', { url: 'ftp://host.test' }), /http\(s\)/)
  await connectors.configure('discord-webhook', { url: 'https://evil.test/api/webhooks/1/a' })
  assert.throws(() => connectors.buildRequest('discord-webhook', 'send', { content: 'x' }), /formato esperado/)
  await connectors.configure('jira', { site: 'abc', email: 'a@b.test', token: SECRET })
  assert.match(connectors.buildRequest('jira', 'me', {}).url, /^https:\/\/abc\.atlassian\.net\/rest\/api\/3\/myself/)
})

test('rate limit: a looping model cannot hammer a service', async () => {
  const srv = await server(() => ({ json: {} }))
  try {
    const { connectors, table } = stack()
    await connectors.configure('rest', { url: srv.base })
    await connectors.setEnabled('rest', true)
    let refused = 0
    for (let i = 0; i < 45; i++) { try { await table.rest_get.run({ path: '/a' }) } catch (e) { if (/muitas chamadas/.test(e.message)) refused++ } }
    assert.equal(refused, 5)
    assert.equal(srv.seen.length, 40)
  } finally {
    await srv.close()
  }
})

test('secrets and calls: the audit log records the call but never the arguments or the credential', async () => {
  const srv = await server(() => ({ json: { ok: 1 } }))
  try {
    const { connectors, table, audit } = stack()
    await connectors.configure('rest', { url: srv.base, token: SECRET })
    await connectors.setEnabled('rest', true)
    await connectors.setWrite('rest', true)
    await table.rest_send.run({ method: 'POST', path: '/x', body: '{"senha":"hunter2hunter2"}' })
    const dump = JSON.stringify(audit.recent(50))
    assert.match(dump, /connector\.call/)
    assert.ok(!dump.includes(SECRET) && !dump.includes('hunter2'))
  } finally {
    await srv.close()
  }
})

// ------------------------------------------------------------------------------------------------- inside the agent loop
const fakeRouter = (script) => ({ run: async () => ({ text: script.shift(), provider: 'fake', model: 'm', latencyMs: 1 }) })
const waitFor = async (fn, ms = 3000) => { const t = Date.now(); for (;;) { const v = fn(); if (v) return v; if (Date.now() - t > ms) throw new Error('timeout'); await new Promise((r) => setTimeout(r, 10)) } }
const finished = (agent, id) => waitFor(() => { const x = agent.view(id); return x.status === 'done' && x })

test('agent: reads a connected service, asks before a change (denied = the server is never touched, approved = it happens), and a sensitive request cannot use connectors', async () => {
  const srv = await server(({ method }) => (method === 'POST' ? { status: 201, json: { id: 9 } } : { json: { items: ['a'] } }))
  try {
    const { connectors, table } = stack()
    await connectors.configure('rest', { url: srv.base })
    await connectors.setEnabled('rest', true)
    await connectors.setWrite('rest', true)
    const access = createAccess({ env: { USERPROFILE: process.cwd() }, systemFolders: false })
    const tools = Object.assign(buildTools({ access, monitor: {}, profiles: {}, getConnectors: () => connectors }), table)
    assert.ok(tools.conector_lista && tools.rest_get, 'discovery tool and the connected service are both in the agent table')

    const read = JSON.stringify({ action: 'tool', tool: 'rest_get', args: { path: '/items' } })
    const a = createAgent({ router: fakeRouter([read, '{"action":"final","text":"lido"}']), tools, access })
    const v = await finished(a, a.run({ text: 'veja os itens', audit: false }))
    assert.equal(v.steps[0].ok, true)

    for (const approve of [false, true]) {
      const before = srv.seen.length
      const send = JSON.stringify({ action: 'tool', tool: 'rest_send', args: { method: 'POST', path: '/items', body: '{"n":1}' } })
      const b = createAgent({ router: fakeRouter([send, '{"action":"final","text":"feito"}']), tools, access })
      const id = b.run({ text: 'crie um item', audit: false })
      const pending = await waitFor(() => b.view(id).pending)
      assert.match(pending.message, /POST 127\.0\.0\.1\/items/)
      assert.equal(srv.seen.length, before, 'nothing is sent before approval')
      b.confirm(pending.id, approve)
      await finished(b, id)
      assert.equal(srv.seen.length, before + (approve ? 1 : 0))
    }

    const before = srv.seen.length
    const c = createAgent({ router: fakeRouter([read, '{"action":"final","text":"não deu"}']), tools, access })
    const sv = await finished(c, c.run({ text: 'veja os itens', sensitive: true, audit: false }))
    assert.match(sv.steps[0].error, /sens/)
    assert.equal(srv.seen.length, before, 'no request for the sensitive job')
  } finally {
    await srv.close()
  }
})
