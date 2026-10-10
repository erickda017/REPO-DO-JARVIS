import test from 'node:test'
import assert from 'node:assert/strict'
import http from 'node:http'
import { mkdtempSync, readFileSync, existsSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { createAccess } from '../../bridge/agent/access.mjs'
import { createAgent } from '../../bridge/agent/agent.mjs'
import { buildTools } from '../../bridge/agent/tools.mjs'
import { createMcp } from '../../bridge/agent/mcp.mjs'
import { createMcpClient, childEnv, windowsLaunch } from '../../bridge/agent/mcp.client.mjs'
import { createRegistry } from '../../bridge/command/providers/registry.mjs'
import { createSettings } from '../../bridge/command/settings.mjs'
import { createAudit } from '../../bridge/command/audit.mjs'

const FIX = fileURLToPath(new URL('../fixtures/mcp-fake-server.mjs', import.meta.url))
const TOKEN = 'TOKEN-secreto-1234567890'
const sleep = (ms) => new Promise((r) => setTimeout(r, ms))
const until = async (fn, ms = 8000) => { const t = Date.now(); for (;;) { const v = await fn(); if (v) return v; if (Date.now() - t > ms) throw new Error('timeout'); await sleep(25) } }
const alive = (pid) => { try { process.kill(pid, 0); return true } catch { return false } }

function stack({ file = null, requestTimeoutMs } = {}) {
  let registry
  let mcp
  const audit = createAudit({ file: null })
  const settings = createSettings({ file: null, getRegistry: () => registry, baseEnv: {}, getExtraNames: () => mcp?.secretNames() ?? [] })
  registry = createRegistry([])
  mcp = createMcp({ file, settings, audit, requestTimeoutMs })
  const table = {}
  mcp.attach(table)
  return { mcp, settings, audit, table }
}
const logFile = () => join(mkdtempSync(join(tmpdir(), 'jv-mcp-')), 'side-effects.log')
const fake = (log, extra = {}) => ({ label: 'Servidor Fake', transport: 'stdio', command: process.execPath, args: [FIX], env: [{ key: 'FAKE_LOG', value: log }, { key: 'FAKE_TOKEN', secret: true, value: TOKEN }], ...extra })
const toolNames = (v) => v.tools.map((t) => t.name)

// ------------------------------------------------------------------------------------------------- protocol client
test('client (stdio): handshake, paginated tools/list, calls, noise on stdout ignored, server requests refused, process gone after stop', async () => {
  const logs = []
  const c = createMcpClient({ transport: 'stdio', command: process.execPath, args: [FIX], env: { FAKE_TOKEN: TOKEN } }, { onLog: (l) => logs.push(l) })
  const info = await c.start()
  assert.deepEqual([info.serverInfo.name, info.serverInfo.version, info.protocolVersion], ['fake-server', '1.2.3', '2025-06-18'])
  const tools = await c.listTools()
  assert.equal(tools.length, 11, 'both pages were read')
  assert.deepEqual((await c.callTool('echo', { text: 'oi' })).content[0].text, 'eco: oi')
  assert.ok(logs.some((l) => /not JSON/.test(l)), 'stdout noise is logged, not fatal')
  const sampling = await c.callTool('ask_sampling', {})
  assert.match(sampling.content[0].text, /-32601/, 'a server asking to use our model is refused')
  assert.ok(logs.some((l) => /sampling\/createMessage/.test(l)))
  const pid = c.pid
  assert.ok(alive(pid))
  c.stop()
  await until(() => !alive(pid), 6000)
  await assert.rejects(c.callTool('echo', { text: 'x' }), /não está rodando|desligado/)
})

test('client: the child gets a minimal environment, never JARVIS secrets', async () => {
  process.env.JARVIS_SECRET_FOR_TEST = 'nao-pode-vazar'
  try {
    const c = createMcpClient({ transport: 'stdio', command: process.execPath, args: [FIX], env: { MINHA_VAR: '1' } })
    await c.start()
    const keys = JSON.parse((await c.callTool('env_keys', {})).content[0].text)
    c.stop()
    assert.ok(!keys.includes('JARVIS_SECRET_FOR_TEST'), 'parent secrets are not inherited')
    assert.ok(keys.includes('MINHA_VAR') && keys.includes('PATH'), 'what the owner set, plus a short allowlist')
  } finally {
    delete process.env.JARVIS_SECRET_FOR_TEST
  }
  assert.ok(!('JARVIS_SECRET_FOR_TEST' in childEnv({}, { JARVIS_SECRET_FOR_TEST: 'x', PATH: 'p' })))
})

test('client: a call that never answers times out and says so; Windows .cmd launches reject shell metacharacters', async () => {
  const c = createMcpClient({ transport: 'stdio', command: process.execPath, args: [FIX] }, { requestTimeoutMs: 400 })
  await c.start()
  await assert.rejects(c.callTool('slow', {}, 400), /não respondeu em/)
  c.stop()
  assert.throws(() => windowsLaunch('npx', ['-y', 'pacote & calc']), /não permitido/)
  assert.throws(() => windowsLaunch('npx', ['%PATH%']), /não permitido/)
  assert.deepEqual(windowsLaunch('C:\\Program Files\\nodejs\\node.exe', ['a b']).file, 'C:\\Program Files\\nodejs\\node.exe')
  assert.match(windowsLaunch('npx', ['-y', 'pkg', 'minha pasta']).args.at(-1), /^"npx -y pkg "minha pasta""$/)
})

test('client: a command that does not exist fails cleanly with a readable reason', async () => {
  const c = createMcpClient({ transport: 'stdio', command: 'comando-que-nao-existe-xyz', args: [] }, {})
  await assert.rejects(c.start(), /encerrado|não encontrado|iniciar/)
})

// ------------------------------------------------------------------------------------------------- manager: trust model
test('manager: adding a program needs confirmation; every tool starts OFF; the server hints are suggestions only', async () => {
  const log = logFile()
  const { mcp, table } = stack()
  await assert.rejects(mcp.save(fake(log)), /confirmação necessária/)
  const v = await mcp.save(fake(log), { confirm: true })
  assert.equal(v.id, 'servidor-fake')
  assert.equal(v.enabled, false)
  await assert.rejects(mcp.setEnabled(v.id, true), /confirmação necessária/)
  const on = await mcp.setEnabled(v.id, true, { confirm: true })
  assert.equal(on.status, 'ready')
  assert.equal(on.server.name, 'fake-server')
  assert.equal(on.tools.length, 11)
  assert.ok(on.tools.every((t) => t.mode === 'off'), 'nothing is exposed by default')
  assert.deepEqual(Object.keys(table), [], 'the agent sees no MCP tool yet')
  const echo = on.tools.find((t) => t.name === 'echo')
  assert.equal(echo.hints.readOnly, true)
  assert.equal(on.tools.find((t) => t.name === 'lying').hints.destructive, true)
  await mcp.setEnabled(v.id, false)
})

test('manager: per-tool modes decide risk and confirmation; params are flattened; descriptions are marked as the server\'s text; string arguments are coerced by schema', async () => {
  const log = logFile()
  const { mcp, table, audit } = stack()
  const v = await mcp.save(fake(log), { confirm: true })
  await mcp.setEnabled(v.id, true, { confirm: true })
  await mcp.setToolMode(v.id, 'echo', 'auto')
  await mcp.setToolMode(v.id, 'add', 'auto')
  await mcp.setToolMode(v.id, 'write_note', 'confirm')
  assert.deepEqual(Object.keys(table).sort(), ['mcp_servidor_fake_add', 'mcp_servidor_fake_echo', 'mcp_servidor_fake_write_note'])
  const echo = table.mcp_servidor_fake_echo
  assert.deepEqual([echo.group, echo.risk, echo.external, typeof echo.confirm], ['mcp', 'read', true, 'undefined'])
  assert.deepEqual(echo.params, { text: 'string — texto (obrigatório)' })
  assert.match(echo.desc, /texto do servidor/)
  const wn = table.mcp_servidor_fake_write_note
  assert.equal(wn.risk, 'write')
  const msg = await wn.confirm({ text: 'segredo' })
  assert.match(msg, /programa rodando no seu PC/)
  assert.match(msg, /write_note/)
  assert.match(msg, /segredo/)

  const sum = await table.mcp_servidor_fake_add.run({ a: '2', b: '40' })
  assert.equal(sum.data.text, '42')
  assert.deepEqual(sum.data.structured.types, ['number', 'number'], 'strings converted by the declared type')
  assert.ok(!('verified' in sum))
  const w = await wn.run({ text: 'olá' })
  assert.equal(w.verified, null, 'a write cannot be verified from here and says so')
  assert.match(readFileSync(log, 'utf8'), /write_note olá/)
  assert.match(JSON.stringify(audit.recent(20)), /mcp\.call/)
  assert.ok(!JSON.stringify(audit.recent(50)).includes('olá'), 'audit never holds arguments or output')
  await mcp.setEnabled(v.id, false)
})

test('manager: "trust read-only hints" is an explicit owner action and only touches tools that are still off', async () => {
  const { mcp, table } = stack()
  const v = await mcp.save(fake(logFile()), { confirm: true })
  await mcp.setEnabled(v.id, true, { confirm: true })
  await mcp.setToolMode(v.id, 'slow', 'confirm')
  const t = await mcp.trustReadOnly(v.id)
  const modes = Object.fromEntries(t.tools.map((x) => [x.name, x.mode]))
  assert.deepEqual([modes.echo, modes.add, modes.env_keys, modes.big, modes.slow, modes.write_note, modes.boom], ['auto', 'auto', 'auto', 'auto', 'confirm', 'off', 'off'])
  assert.equal(modes.lying, 'auto', 'a lying server is exactly why this is an opt-in click, and each tool stays switchable')
  assert.ok(table.mcp_servidor_fake_echo && !table.mcp_servidor_fake_write_note)
  await mcp.setEnabled(v.id, false)
})

test('manager: rug-pull guard — a tool whose description changes after approval is switched off and flagged', async () => {
  const { mcp, table } = stack()
  const v = await mcp.save(fake(logFile()), { confirm: true })
  await mcp.setEnabled(v.id, true, { confirm: true })
  await mcp.setToolMode(v.id, 'echo', 'auto')
  await mcp.setToolMode(v.id, 'mutate', 'confirm')
  assert.ok(table.mcp_servidor_fake_echo)
  await table.mcp_servidor_fake_mutate.run({})
  await until(() => !table.mcp_servidor_fake_echo)
  const after = mcp.get(v.id)
  const echo = after.tools.find((t) => t.name === 'echo')
  assert.deepEqual([echo.mode, echo.changed], ['off', true])
  assert.match(echo.description, /ENVIA TUDO/)
  assert.match(mcp.log(v.id).join('\n'), /mudou de descrição/)
  await mcp.setToolMode(v.id, 'echo', 'confirm') // the owner looked at it and decided
  assert.equal(mcp.get(v.id).tools.find((t) => t.name === 'echo').changed, false)
  await mcp.setEnabled(v.id, false)
})

test('manager: server output is size-capped, errors and logs never show the stored secret, calls are rate-limited', async () => {
  const log = logFile()
  const { mcp, table } = stack()
  const v = await mcp.save(fake(log), { confirm: true })
  await mcp.setEnabled(v.id, true, { confirm: true })
  for (const t of ['big', 'boom', 'echo']) await mcp.setToolMode(v.id, t, 'auto')
  const big = await table.mcp_servidor_fake_big.run({})
  assert.ok(big.data.text.length < 25_000 && /cortado/.test(big.data.text))
  await assert.rejects(table.mcp_servidor_fake_boom.run({}), (e) => /falhou/.test(e.message) && !e.message.includes(TOKEN) && /\*\*\*/.test(e.message))
  assert.ok(!JSON.stringify(mcp.get(v.id)).includes(TOKEN), 'the view never carries a secret')
  let refused = 0
  for (let i = 0; i < 70; i++) { try { await table.mcp_servidor_fake_echo.run({ text: 'x' }) } catch (e) { if (/muitas chamadas/.test(e.message)) refused++ } }
  assert.ok(refused >= 8, `rate limit engaged (${refused})`)
  await mcp.setEnabled(v.id, false)
})

test('manager: a crash is noticed, reported, and the server is restarted by itself (once the owner switched it on)', async () => {
  const { mcp, table } = stack()
  const v = await mcp.save(fake(logFile()), { confirm: true })
  await mcp.setEnabled(v.id, true, { confirm: true })
  await mcp.setToolMode(v.id, 'echo', 'auto')
  await mcp.setToolMode(v.id, 'die', 'confirm')
  await assert.rejects(table.mcp_servidor_fake_die.run({}), /encerrado|desligado/)
  await until(() => mcp.get(v.id).status === 'error')
  assert.match(mcp.get(v.id).error, /saiu com código 1/)
  assert.ok(!table.mcp_servidor_fake_echo, 'tools vanish while it is down')
  await until(() => mcp.get(v.id).status === 'ready', 10_000)
  assert.ok(table.mcp_servidor_fake_echo, 'and come back with it')
  assert.match(mcp.log(v.id).join('\n'), /reiniciando/)
  await mcp.setEnabled(v.id, false)
  const pid = mcp.get(v.id).pid
  assert.equal(pid, null)
})

test('manager: configuration and tool choices survive a restart; secrets stay in the vault; remove wipes everything', async () => {
  const log = logFile()
  const file = join(mkdtempSync(join(tmpdir(), 'jv-mcpcfg-')), 'mcp.json')
  let registry
  let mcp
  const settings = createSettings({ file: null, getRegistry: () => registry, baseEnv: {}, getExtraNames: () => mcp?.secretNames() ?? [] })
  registry = createRegistry([])
  mcp = createMcp({ file, settings })
  const table = {}
  mcp.attach(table)
  const v = await mcp.save(fake(log), { confirm: true })
  await mcp.setEnabled(v.id, true, { confirm: true })
  await mcp.setToolMode(v.id, 'echo', 'auto')
  mcp.stopAll()
  assert.ok(!readFileSync(file, 'utf8').includes(TOKEN), 'the secret is not in mcp.json')
  assert.equal(settings.keys().find((k) => k.name === 'MCP_SERVIDOR_FAKE_S0').configured, true)

  const mcp2 = createMcp({ file, settings })
  mcp = mcp2
  const table2 = {}
  mcp2.attach(table2)
  await mcp2.ready()
  await mcp2.startEnabled()
  assert.equal(mcp2.get('servidor-fake').status, 'ready')
  assert.ok(table2.mcp_servidor_fake_echo, 'the approved tool is back without asking again')
  assert.equal((await table2.mcp_servidor_fake_echo.run({ text: 'x' })).data.text, 'eco: x')

  // editing keeps a secret that was not retyped
  const edited = await mcp2.save({ ...fake(log), id: 'servidor-fake', label: 'Renomeado', env: [{ key: 'FAKE_LOG', value: log }, { key: 'FAKE_TOKEN', secret: true }] }, { confirm: true })
  assert.equal(edited.env.find((e) => e.key === 'FAKE_TOKEN').configured, true)
  await until(() => mcp2.get('servidor-fake').status === 'ready')
  await assert.rejects(table2.mcp_servidor_fake_boom?.run?.({}) ?? Promise.reject(new Error('off')), /off/) // boom is still off
  await mcp2.remove('servidor-fake')
  assert.ok(!settings.keys().some((k) => k.name === 'MCP_SERVIDOR_FAKE_S0'), 'the secret name is gone with the server')
  assert.deepEqual(mcp2.list(), [])
  assert.ok(!table2.mcp_servidor_fake_echo, 'and so are its tools')
})

test('manager: configuration is validated (command shape, placeholders, env names, forbidden headers, plain http to the internet)', async () => {
  const { mcp } = stack()
  const ok = { label: 'X', transport: 'stdio', command: process.execPath, args: [] }
  await assert.rejects(mcp.save({ ...ok, command: 'node --eval "x"' }, { confirm: true }), /comando inválido/)
  await assert.rejects(mcp.save({ ...ok, command: 'cmd & calc' }, { confirm: true }), /comando inválido/)
  await assert.rejects(mcp.save({ ...ok, args: ['<PASTA>'] }, { confirm: true }), /<PASTA>/)
  await assert.rejects(mcp.save({ ...ok, env: [{ key: 'bad name', value: '1' }] }, { confirm: true }), /nome de variável/)
  await assert.rejects(mcp.save({ label: 'R', transport: 'http', url: 'http://exemplo.com/mcp' }), /https/)
  await assert.rejects(mcp.save({ label: 'R', transport: 'http', url: 'https://u:p@exemplo.com/mcp' }), /sem usuário/)
  await assert.rejects(mcp.save({ label: 'R', transport: 'http', url: 'http://169.254.169.254/' }), /não permitido/)
  await assert.rejects(mcp.save({ label: 'R', transport: 'http', url: 'https://exemplo.com/mcp', headers: [{ name: 'Host', value: 'x' }] }), /cabeçalho não permitido/)
  await assert.rejects(mcp.save({ label: '', transport: 'stdio', command: 'node' }, { confirm: true }), /nome/)
  const preset = mcp.PRESETS.find((p) => p.id === 'filesystem')
  assert.ok(preset.args.includes('<PASTA>'), 'presets that need a folder cannot be saved as is')
  assert.ok(mcp.PRESETS.length >= 8)
})

// ------------------------------------------------------------------------------------------------- HTTP transport (real HTTP server)
async function mcpHttpServer({ token = 'Bearer ' + TOKEN } = {}) {
  const seen = []
  const srv = http.createServer((req, res) => {
    let body = ''
    req.on('data', (d) => (body += d))
    req.on('end', () => {
      seen.push({ method: req.method, headers: req.headers, body })
      if (req.method === 'DELETE') { res.writeHead(200); return res.end() }
      if (req.headers.authorization !== token) { res.writeHead(401, { 'content-type': 'application/json' }); return res.end('{"error":"no"}') }
      if (req.url === '/redir') { res.writeHead(302, { location: 'http://evil.test/' }); return res.end() }
      const m = JSON.parse(body)
      const json = (r) => { res.writeHead(200, { 'content-type': 'application/json' }); res.end(JSON.stringify({ jsonrpc: '2.0', id: m.id, result: r })) }
      if (m.method === 'initialize') { res.setHeader('mcp-session-id', 'sess-42'); return json({ protocolVersion: '2025-06-18', capabilities: {}, serverInfo: { name: 'remoto', version: '9' } }) }
      if (req.headers['mcp-session-id'] !== 'sess-42') { res.writeHead(400); return res.end('no session') }
      if (m.method === 'notifications/initialized') { res.writeHead(202); return res.end() }
      if (m.method === 'tools/list') { // answered as a Server-Sent-Events stream, with a notification in front
        res.writeHead(200, { 'content-type': 'text/event-stream' })
        res.write(`data: ${JSON.stringify({ jsonrpc: '2.0', method: 'notifications/message', params: { data: 'olá do servidor' } })}\n\n`)
        return res.end(`event: message\ndata: ${JSON.stringify({ jsonrpc: '2.0', id: m.id, result: { tools: [{ name: 'hora', description: 'Hora', inputSchema: { type: 'object', properties: {} }, annotations: { readOnlyHint: true } }] } })}\n\n`)
      }
      if (m.method === 'tools/call') return json({ content: [{ type: 'text', text: 'são 12h' }] })
      res.writeHead(404); res.end()
    })
  })
  await new Promise((r) => srv.listen(0, '127.0.0.1', r))
  return { seen, url: `http://127.0.0.1:${srv.address().port}/mcp`, close: () => new Promise((r) => { srv.closeAllConnections?.(); srv.close(r) }) }
}

test('HTTP transport: session id, bearer header from the vault, JSON and SSE answers, DELETE on stop; wrong token and redirects are refused', async () => {
  const srv = await mcpHttpServer()
  try {
    const { mcp, table } = stack()
    const v = await mcp.save({ label: 'Remoto', transport: 'http', url: srv.url, headers: [{ name: 'Authorization', prefix: 'Bearer ', value: TOKEN }] })
    const on = await mcp.setEnabled(v.id, true) // http servers are not local programs: no confirmation needed to start
    assert.equal(on.status, 'ready')
    assert.equal(on.server.name, 'remoto')
    assert.deepEqual(toolNames(on), ['hora'])
    await mcp.setToolMode(v.id, 'hora', 'auto')
    const r = await table.mcp_remoto_hora.run({})
    assert.equal(r.data.text, 'são 12h')
    const calls = srv.seen.filter((x) => x.method === 'POST')
    assert.equal(calls[0].headers.authorization, `Bearer ${TOKEN}`)
    assert.equal(calls.at(-1).headers['mcp-session-id'], 'sess-42')
    assert.match(calls.at(-1).headers.accept, /text\/event-stream/)
    assert.match(mcp.log(v.id).join('\n'), /olá do servidor/, 'notifications that arrive in the stream are handled')
    assert.ok(!JSON.stringify(mcp.get(v.id)).includes(TOKEN))
    await mcp.setEnabled(v.id, false)
    await until(() => srv.seen.some((x) => x.method === 'DELETE'))

    const bad = await mcp.save({ label: 'Token errado', transport: 'http', url: srv.url, headers: [{ name: 'Authorization', prefix: 'Bearer ', value: 'outro-token-qualquer' }] })
    const off = await mcp.setEnabled(bad.id, true)
    assert.equal(off.status, 'error')
    assert.match(off.error, /HTTP 401/)
    const redir = await mcp.save({ label: 'Redireciona', transport: 'http', url: srv.url.replace('/mcp', '/redir'), headers: [{ name: 'Authorization', prefix: 'Bearer ', value: TOKEN }] })
    assert.match((await mcp.setEnabled(redir.id, true)).error, /redirecionar/)
    assert.ok(!srv.seen.some((x) => /evil/.test(JSON.stringify(x.headers))))
  } finally {
    await srv.close()
  }
})

// ------------------------------------------------------------------------------------------------- inside the agent loop
const fakeRouter = (script) => ({ run: async () => ({ text: script.shift(), provider: 'fake', model: 'm', latencyMs: 1 }) })
const waitFor = async (fn, ms = 4000) => { const t = Date.now(); for (;;) { const v = fn(); if (v) return v; if (Date.now() - t > ms) throw new Error('timeout'); await sleep(10) } }
const finished = (agent, id) => waitFor(() => { const x = agent.view(id); return x.status === 'done' && x })

test('agent: a "confirm" MCP tool waits for approval (denied = the server never runs it); sensitive requests cannot use MCP; the prompt lists only what is on', async () => {
  const log = logFile()
  const { mcp, table } = stack()
  const v = await mcp.save(fake(log), { confirm: true })
  await mcp.setEnabled(v.id, true, { confirm: true })
  await mcp.setToolMode(v.id, 'write_note', 'confirm')
  const access = createAccess({ env: { USERPROFILE: process.cwd() }, systemFolders: false })
  const tools = Object.assign(buildTools({ access, monitor: {}, profiles: {} }), table)
  const catalogHas = []
  const spyRouter = { run: async (req) => { catalogHas.push(req.system); return { text: spyRouter.script.shift(), provider: 'fake', model: 'm', latencyMs: 1 } }, script: [] }

  for (const approve of [false, true]) {
    const before = existsSync(log) ? readFileSync(log, 'utf8') : ''
    const call = JSON.stringify({ action: 'tool', tool: 'mcp_servidor_fake_write_note', args: { text: approve ? 'sim' : 'nao' } })
    const a = createAgent({ router: fakeRouter([call, '{"action":"final","text":"ok"}']), tools, access })
    const id = a.run({ text: 'grave uma nota', audit: false })
    const pending = await waitFor(() => a.view(id).pending)
    assert.match(pending.message, /Servidor MCP "Servidor Fake"/)
    assert.equal(existsSync(log) ? readFileSync(log, 'utf8') : '', before, 'nothing ran before approval')
    a.confirm(pending.id, approve)
    await finished(a, id)
    const after = existsSync(log) ? readFileSync(log, 'utf8') : ''
    assert.equal(after.includes('write_note sim'), approve)
    assert.equal(after.includes('write_note nao'), false)
  }

  const call = JSON.stringify({ action: 'tool', tool: 'mcp_servidor_fake_write_note', args: { text: 'privado' } })
  const s = createAgent({ router: fakeRouter([call, '{"action":"final","text":"não deu"}']), tools, access })
  const sv = await finished(s, s.run({ text: 'grave', sensitive: true, audit: false }))
  assert.match(sv.steps[0].error, /sens/)
  assert.ok(!readFileSync(log, 'utf8').includes('privado'))

  spyRouter.script = ['{"action":"final","text":"oi"}']
  const p = createAgent({ router: spyRouter, tools, access })
  await finished(p, p.run({ text: 'oi', audit: false }))
  assert.match(catalogHas[0], /mcp_servidor_fake_write_note/)
  assert.ok(!/mcp_servidor_fake_echo/.test(catalogHas[0]), 'tools that are off are not in the prompt')
  assert.match(catalogHas[0], /texto de terceiros/)
  await mcp.setEnabled(v.id, false)
})
