import test from 'node:test'
import assert from 'node:assert/strict'
import http from 'node:http'
import { mkdtemp, readFile, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { fakeFetch } from './helpers.mjs'
import { createServiceMonitor } from '../../bridge/command/services.mjs'
import { createRouter } from '../../bridge/command/router.mjs'
import { createTaskStore } from '../../bridge/command/tasks.mjs'
import { createTimer } from '../../bridge/command/timer.mjs'
import { createCommand } from '../../bridge/command/index.mjs'

test('services: up / degraded (slow, wrong status) / down are real results', async () => {
  const routes = {
    'http://ok.test/': { status: 200 },
    'http://bad.test/': { status: 500 },
    'http://dead.test/': new Error('ECONNREFUSED'),
  }
  const mon = createServiceMonitor({
    services: [
      { id: 'ok', url: 'http://ok.test/' },
      { id: 'bad', url: 'http://bad.test/' },
      { id: 'dead', url: 'http://dead.test/' },
    ],
    fetch: fakeFetch((u) => routes[u]),
  })
  await mon.checkAll()
  const by = Object.fromEntries(mon.list().map((s) => [s.id, s]))
  assert.equal(by.ok.status, 'up')
  assert.equal(by.bad.status, 'degraded')
  assert.equal(by.dead.status, 'down')
  assert.equal(by.dead.consecutiveFailures, 1)
  assert.equal(by.dead.recentFailures.length, 1)
})

test('services: unchecked is unknown; config rejects non-http and url credentials', () => {
  const mon = createServiceMonitor({ services: [{ id: 'a', url: 'http://a.test' }], fetch: fakeFetch(() => ({})) })
  assert.equal(mon.list()[0].status, 'unknown')
  assert.throws(() => createServiceMonitor({ services: [{ id: 'x', url: 'file:///etc/passwd' }] }), /http/)
  assert.throws(() => createServiceMonitor({ services: [{ id: 'x', url: 'http://u:p@a.test' }] }), /credentials/)
  assert.equal(createServiceMonitor({ services: [{ id: 'x', url: 'http://a.test', intervalSec: 1 }] }).list()[0].intervalSec, 15)
})

test('tasks: priority order, state changes, persistence, confirmed delete', async () => {
  const dir = await mkdtemp(join(tmpdir(), 'jv-'))
  const file = join(dir, 'tasks.json')
  const s = createTaskStore({ file })
  const low = await s.create({ title: 'low', priority: 'low' })
  const urgent = await s.create({ title: 'urgent', priority: 'urgent' })
  assert.deepEqual((await s.list()).map((t) => t.title), ['urgent', 'low'])
  await s.update(urgent.id, { state: 'done', result: 'shipped' })
  assert.deepEqual((await s.list()).map((t) => t.title), ['low'])
  await assert.rejects(s.update(low.id, { state: 'nope' }), /state must be/)
  await assert.rejects(s.create({ title: '  ' }), /title is required/)
  const reloaded = createTaskStore({ file })
  assert.equal((await reloaded.list({ includeClosed: true })).length, 2)
  await reloaded.remove(low.id)
  assert.equal(JSON.parse(await readFile(file, 'utf8')).length, 1)
})

test('timer: start/pause/resume/cancel/finish are consistent and persisted', async () => {
  const dir = await mkdtemp(join(tmpdir(), 'jv-'))
  const file = join(dir, 'timer.json')
  let now = 1_000_000
  const clock = () => now
  const t = createTimer({ file, clock })
  assert.equal((await t.get()).status, 'idle')
  await t.start({ seconds: 60, label: 'x' })
  now += 20_000
  assert.equal((await t.get()).remainingMs, 40_000)
  await t.pause()
  now += 500_000
  assert.equal((await t.get()).remainingMs, 40_000) // frozen while paused
  await assert.rejects(t.start({ seconds: 5 }), /already active/)
  await t.resume()
  const restarted = createTimer({ file, clock }) // simulated restart
  now += 10_000
  assert.equal((await restarted.get()).remainingMs, 30_000)
  now += 100_000
  assert.equal((await restarted.get()).status, 'finished')
  assert.equal((await restarted.cancel()).status, 'idle')
  await assert.rejects(restarted.pause(), /not running/)
  await assert.rejects(t.start({ seconds: 0 }), /between/)
})

async function withApi(fn, env = {}) {
  const SECRET = 'sk-ant-LEAKCHECK0123456789'
  const f = fakeFetch((u) => (u.includes('/v1/messages') ? { body: { content: [{ type: 'text', text: 'pong' }] } } : { body: { data: [{ id: 'm' }] } }))
  const cmd = createCommand({
    persist: false,
    fetch: f,
    env: { ANTHROPIC_API_KEY: SECRET, ...env },
    config: {
      providers: [{ id: 'cloud', type: 'anthropic', models: ['m'] }],
      services: [{ id: 'svc', url: 'http://svc.test/' }],
      projects: [{ id: 'proj', serviceId: 'svc' }],
      dataDir: '/nonexistent',
    },
  })
  const server = http.createServer((req, res) => cmd.api.handle(req, res, {}).then((h) => h || res.writeHead(404).end()))
  await new Promise((r) => server.listen(0, '127.0.0.1', r))
  const base = `http://127.0.0.1:${server.address().port}`
  const call = async (method, path, body, headers = {}) => {
    const r = await fetch(base + path, { method, headers: { origin: 'http://localhost:5173', 'content-type': 'application/json', ...headers }, body: body === undefined ? undefined : JSON.stringify(body) })
    const text = await r.text()
    return { status: r.status, text, json: text ? JSON.parse(text) : null }
  }
  try {
    await fn({ call, f, SECRET, cmd })
  } finally {
    server.close()
  }
}

test('api: full flow, spend gate, content-type and origin rules, no secrets in any reply', () =>
  withApi(async ({ call, f, SECRET }) => {
    const bodies = []
    const seen = (r) => (bodies.push(r.text), r)

    assert.equal(seen(await call('GET', '/api/command/overview')).status, 200)
    assert.equal(seen(await call('POST', '/api/command/ai/check', { providerId: 'cloud' })).json.auth.state, 'ok')

    const blocked = seen(await call('POST', '/api/command/ai/infer', { prompt: 'ping' }))
    assert.equal(blocked.status, 409)
    assert.ok(!f.calls.some((c) => c.url.includes('/v1/messages')))
    const done = seen(await call('POST', '/api/command/ai/infer', { prompt: 'ping', confirm: true }))
    assert.equal(done.json.text, 'pong')

    assert.equal(seen(await call('POST', '/api/command/ai/infer', { prompt: 'x', confirm: true, sensitive: true })).status, 502)
    assert.equal((await call('POST', '/api/command/ai/infer', 'x', { 'content-type': 'text/plain' })).status, 415)
    assert.equal((await call('POST', '/api/command/tasks', { title: 't' }, { origin: '' })).status, 403) // no Origin
    assert.equal((await call('PUT', '/api/command/tasks', {})).status, 405)
    assert.equal((await call('GET', '/api/command/nope')).status, 404)

    const t = seen(await call('POST', '/api/command/tasks', { title: 'write docs', priority: 'high' })).json
    assert.equal((await call('POST', '/api/command/tasks/delete', { id: t.id })).status, 409)
    assert.equal((await call('POST', '/api/command/tasks/delete', { id: t.id, confirm: true })).status, 200)

    assert.equal((await call('POST', '/api/command/timer/start', { seconds: 30 })).json.status, 'running')
    assert.equal((await call('POST', '/api/command/timer/cancel')).json.status, 'idle')

    const audit = seen(await call('GET', '/api/command/audit'))
    assert.ok(audit.json.some((e) => e.action === 'ai.infer'))
    assert.ok(!audit.text.includes('ping'), 'audit must not hold prompt text')
    for (const b of bodies) assert.ok(!b.includes(SECRET), 'api reply leaked the key')
  }))

import { createVoice } from '../../bridge/command/voice.mjs'

test('voice: panel key wins, never returned, validated, persisted, cleared', async () => {
  const dir = await mkdtemp(join(tmpdir(), 'jv-'))
  const file = join(dir, 'voice.json')
  const KEY = 'xi-PANELSECRET123456'
  const v = createVoice({ file, env: { ELEVENLABS_API_KEY: 'env-key-ABCDEFGH' }, envKey: () => 'mcp-key-ABCDEFGH' })
  assert.equal((await v.status()).source, 'env')
  await assert.rejects(v.set({ apiKey: 'short' }), /8-200/)
  await assert.rejects(v.set({ voiceId: 'bad id!' }), /voiceId/)
  const st = await v.set({ apiKey: KEY, voiceId: 'AbCdEfGhIjKlMn' })
  assert.deepEqual([st.source, st.last4, st.voiceId], ['panel', '3456', 'AbCdEfGhIjKlMn'])
  assert.ok(!JSON.stringify(st).includes('PANELSECRET'))
  assert.equal(v.key(), KEY)
  const again = createVoice({ file, env: {} })
  await again.ready()
  assert.equal(again.key(), KEY) // survived a restart
  await v.clear()
  assert.equal(v.key(), 'env-key-ABCDEFGH')
})

test('voice test: lists voices with the xi-api-key header; no key -> auth error', async () => {
  const f = fakeFetch(() => ({ body: { voices: [{ voice_id: 'v1', name: 'George' }] } }))
  const v = createVoice({ env: { ELEVENLABS_API_KEY: 'env-key-ABCDEFGH' }, fetch: f })
  const out = await v.test()
  assert.deepEqual(out.voices, [{ id: 'v1', name: 'George' }])
  assert.equal(f.calls[0].url, 'https://api.elevenlabs.io/v1/voices')
  assert.equal(f.calls[0].headers['xi-api-key'], 'env-key-ABCDEFGH')
  await assert.rejects(createVoice({ env: {} }).test(), (e) => e.kind === 'auth')
  const rejected = createVoice({ env: { ELEVENLABS_API_KEY: 'env-key-ABCDEFGH' }, fetch: fakeFetch(() => ({ status: 401, body: {} })) })
  await assert.rejects(rejected.test(), (e) => e.kind === 'auth')
})

test('api: chat keeps history (no Claude), validates turns; voice endpoints never leak the key', () =>
  withApi(async ({ call, f }) => {
    const local = { messages: [{ role: 'user', content: 'oi' }, { role: 'assistant', content: 'olÃ¡' }, { role: 'user', content: 'tudo bem?' }], confirm: true }
    const ok = await call('POST', '/api/command/ai/chat', local)
    assert.equal(ok.status, 200)
    const sent = JSON.parse(f.calls.find((c) => c.url.includes('/v1/messages')).body)
    assert.equal(sent.messages.length, 3)
    assert.match(sent.system, /JARVIS/)
    assert.equal((await call('POST', '/api/command/ai/chat', { messages: [{ role: 'assistant', content: 'x' }], confirm: true })).status, 400)
    assert.equal((await call('POST', '/api/command/ai/chat', { messages: [{ role: 'system', content: 'x' }], confirm: true })).status, 400)

    const secret = 'xi-NEVERLEAKME123456'
    const set = await call('POST', '/api/command/voice', { apiKey: secret, voiceId: 'AbCdEfGhIjKlMn' })
    assert.equal(set.status, 200)
    assert.ok(!set.text.includes('NEVERLEAKME'))
    const got = await call('GET', '/api/command/voice')
    assert.ok(!got.text.includes('NEVERLEAKME'))
    assert.equal(got.json.last4, '3456')
    assert.equal((await call('POST', '/api/command/voice', { apiKey: 'x y' })).status, 400)
    const audit = await call('GET', '/api/command/audit')
    assert.ok(!audit.text.includes('NEVERLEAKME'))
    assert.equal((await call('POST', '/api/command/voice/clear')).json.source, null)
  }))

import { geminiProvider } from '../../bridge/command/providers/gemini.mjs'
import { createSettings } from '../../bridge/command/settings.mjs'
import { createRegistry } from '../../bridge/command/providers/registry.mjs'

test('gemini: key in header only, history mapped to user/model turns, usage parsed', async () => {
  const KEY = 'AIzaSECRETSECRETSECRET1234'
  const f = fakeFetch((url) =>
    url.endsWith('/models?pageSize=200')
      ? { body: { models: [{ name: 'models/gemini-x' }] } }
      : { body: { modelVersion: 'gemini-x', candidates: [{ content: { parts: [{ text: 'oi' }] } }], usageMetadata: { promptTokenCount: 5, candidatesTokenCount: 2 } } })
  const p = geminiProvider({ id: 'g' }, { fetch: f, env: { GEMINI_API_KEY: KEY } })
  assert.deepEqual((await p.probe()).models, ['gemini-x'])
  const out = await p.infer({ model: 'models/gemini-x', messages: [{ role: 'user', content: 'a' }, { role: 'assistant', content: 'b' }, { role: 'user', content: 'c' }], system: 'sys' })
  assert.equal(out.text, 'oi')
  assert.deepEqual([out.usage.inputTokens, out.usage.outputTokens], [5, 2])
  const call = f.calls.find((c) => c.url.includes(':generateContent'))
  assert.ok(call.url.includes('/models/gemini-x:generateContent'))
  assert.ok(!call.url.includes(KEY), 'key must not be in the URL')
  assert.equal(call.headers['x-goog-api-key'], KEY)
  const body = JSON.parse(call.body)
  assert.deepEqual(body.contents.map((c) => c.role), ['user', 'model', 'user'])
  assert.equal(body.systemInstruction.parts[0].text, 'sys')
  const blocked = geminiProvider({ id: 'g' }, { fetch: fakeFetch(() => ({ body: { promptFeedback: { blockReason: 'SAFETY' } } })), env: { GEMINI_API_KEY: KEY } })
  await assert.rejects(blocked.infer({ model: 'm', prompt: 'x' }), (e) => e.kind === 'bad_response' && /SAFETY/.test(e.message))
})

test('quota exhaustion: 429-with-quota and 402 are "quota", fail over, and stay out for 10 minutes', async () => {
  let now = 0
  const calls = []
  const f = fakeFetch((url) => {
    calls.push(url)
    return url.includes('openai.test') ? { status: 429, body: { error: { message: 'You exceeded your current quota' } } } : { body: { choices: [{ message: { content: 'from backup' } }], model: 'b' } }
  })
  const registry = createRegistry(
    [
      { id: 'openai', type: 'openai-compat', baseUrl: 'http://openai.test/v1', apiKeyEnv: 'OPENAI_API_KEY', models: ['m'], priority: 1 },
      { id: 'backup', type: 'openai-compat', baseUrl: 'http://127.0.0.1:1/v1', models: ['b'], priority: 2, paid: false },
    ],
    { fetch: f, env: { OPENAI_API_KEY: 'sk-testtesttest' } },
  )
  const router = createRouter({ registry, clock: () => now, cooldownMs: 1000 })
  const first = await router.run({ prompt: 'hi', confirmSpend: true })
  assert.equal(first.provider, 'backup')
  assert.equal(first.attempts[0].error.kind, 'quota')
  const before = calls.length
  now += 60_000 // a normal rate-limit cooldown would be over; a quota one is not
  await router.run({ prompt: 'hi', confirmSpend: true })
  assert.ok(!calls.slice(before).some((u) => u.includes('openai.test')), 'exhausted provider must be skipped')
  now += 11 * 60_000
  await router.run({ prompt: 'hi', confirmSpend: true })
  assert.ok(calls.slice(before).some((u) => u.includes('openai.test')), 'comes back after 10 minutes')
})

test('settings: keys only for declared names, never returned, saved key wins, overrides apply', async () => {
  const dir = await mkdtemp(join(tmpdir(), 'jv-'))
  const file = join(dir, 'settings.json')
  let registry
  const s = createSettings({ file, getRegistry: () => registry, baseEnv: { OPENROUTER_API_KEY: 'env-key-12345678' } })
  registry = createRegistry([{ id: 'or', type: 'openai-compat', baseUrl: 'https://openrouter.ai/api/v1', apiKeyEnv: 'OPENROUTER_API_KEY', models: ['x'], enabled: false }], { env: s.env() })
  await assert.rejects(s.setKey('PATH', 'C:\\evil;C:\\more'), /unknown key name/)
  await assert.rejects(s.setKey('OPENROUTER_API_KEY', 'short'), /8-400/)
  assert.equal(s.keys()[0].source, 'env')
  const list = await s.setKey('OPENROUTER_API_KEY', 'panel-key-ABCDEFGH')
  assert.deepEqual([list[0].source, list[0].last4], ['panel', 'EFGH'])
  assert.ok(!JSON.stringify(list).includes('panel-key'))
  assert.equal(s.env().OPENROUTER_API_KEY, 'panel-key-ABCDEFGH')
  await s.setProvider('or', { enabled: true, model: 'openai/gpt-4o-mini', priority: 7 })
  assert.deepEqual([registry.get('or').enabled, registry.get('or').defaultModel, registry.get('or').priority], [true, 'openai/gpt-4o-mini', 7])
  await assert.rejects(s.setProvider('or', { model: 'bad model!' }), /invalid model/)
  const s2 = createSettings({ file, getRegistry: () => registry, baseEnv: {} }) // restart
  registry.update('or', { enabled: false, priority: 1 })
  await s2.ready()
  assert.deepEqual([registry.get('or').enabled, registry.get('or').priority, s2.env().OPENROUTER_API_KEY], [true, 7, 'panel-key-ABCDEFGH'])
})

test('config: a real key pasted into apiKeyEnv is dropped, never echoed, and flagged on the provider', async () => {
  const { loadConfig } = await import('../../bridge/command/config.mjs')
  const dir = await mkdtemp(join(tmpdir(), 'jv-'))
  const SECRET = 'apikey_0123456789abcdef0123456789abcdef'
  await writeFile(join(dir, 'command.config.json'), JSON.stringify({ providers: [{ id: 'jev', type: 'typesafe-jev', apiKeyEnv: SECRET }, { id: 'ok', type: 'anthropic', apiKeyEnv: 'ANTHROPIC_API_KEY' }] }))
  const cfg = loadConfig({ root: dir, env: {} })
  assert.equal(cfg.providers[0].apiKeyEnv, undefined)
  assert.match(cfg.providers[0].configWarning, /NOME da vari/)
  assert.ok(!JSON.stringify(cfg).includes('0123456789abcdef'), 'the key must not survive in the loaded config')
  assert.equal(cfg.providers[1].apiKeyEnv, 'ANTHROPIC_API_KEY')
  const registry = createRegistry(cfg.providers, { env: {} })
  assert.equal(registry.get('jev').keyEnv, 'TYPESAFE_API_KEY')
  assert.ok(registry.get('jev').warning)
})

test('spend gate: without authorisation a paid provider is skipped and the free local one answers; catalogue adds all vendors', async () => {
  const f = fakeFetch((u) => (u.includes('openai.test') ? { body: { choices: [{ message: { content: 'PAID' } }] } } : { body: { choices: [{ message: { content: 'local ok' } }], model: 'q' } }))
  const registry = createRegistry(
    [
      { id: 'paid', type: 'openai-compat', baseUrl: 'http://openai.test/v1', models: ['m'], priority: 1 },
      { id: 'local', type: 'openai-compat', baseUrl: 'http://127.0.0.1:8082/v1', models: ['q'], priority: 9 }, // no "paid" flag: loopback is free by default
    ],
    { fetch: f, env: {} },
  )
  assert.equal(registry.get('local').paid, false)
  assert.equal(createRegistry([{ id: 'x', type: 'openai-compat', baseUrl: 'http://127.0.0.1:1/v1', paid: true }], { env: {} }).get('x').paid, false, 'loopback is never paid even if the config says so')
  assert.equal(registry.get('paid').paid, true)
  const router = createRouter({ registry })
  const out = await router.run({ prompt: 'oi' }) // confirmSpend NOT given
  assert.equal(out.text, 'local ok')
  assert.ok(!f.calls.some((c) => c.url.includes('openai.test')), 'the paid provider must not be called')
  const { withCatalog } = await import('../../bridge/command/catalog.mjs')
  const ids = withCatalog([{ id: 'local', type: 'openai-compat' }]).map((p) => p.id)
  for (const want of ['claude-api', 'gemini', 'openai', 'deepseek', 'openrouter', 'groq', 'mistral']) assert.ok(ids.includes(want), want)
  assert.ok(withCatalog([]).every((p) => p.enabled === false && p.models.length === 0))
})

test('OpenAI-compatible door: token required, models listed, quota failover continues the work, paid use needs the switch', async () => {
  const f = fakeFetch((u) => (u.includes('paid.test') ? { status: 429, body: { error: { message: 'You exceeded your current quota' } } } : { body: { choices: [{ message: { content: 'resposta do backup' } }], model: 'q', usage: { prompt_tokens: 3, completion_tokens: 2 } } }))
  const cmd = createCommand({
    persist: false,
    fetch: f,
    env: { PAID_KEY: 'sk-testtesttest' },
    config: {
      providers: [
        { id: 'paid', type: 'openai-compat', baseUrl: 'http://paid.test/v1', apiKeyEnv: 'PAID_KEY', models: ['m'], capabilities: ['chat', 'coding'], priority: 1 },
        { id: 'local', type: 'openai-compat', baseUrl: 'http://127.0.0.1:8082/v1', models: ['q'], capabilities: ['chat', 'coding'], priority: 9 },
      ],
      services: [], projects: [], dataDir: '/nonexistent',
    },
  })
  const server = http.createServer((req, res) => cmd.openai.handle(req, res).then((h) => h || res.writeHead(404).end()))
  await new Promise((r) => server.listen(0, '127.0.0.1', r))
  const base = `http://127.0.0.1:${server.address().port}`
  const token = await cmd.openai.token()
  const call = (path, init = {}) => fetch(base + path, { ...init, headers: { 'content-type': 'application/json', ...(init.headers ?? {}) } })
  const auth = { authorization: `Bearer ${token}` }
  try {
    assert.equal((await call('/v1/models')).status, 401)
    assert.equal((await call('/v1/models', { headers: { authorization: 'Bearer wrong' } })).status, 401)
    const models = await (await call('/v1/models', { headers: auth })).json()
    assert.deepEqual(models.data.map((m) => m.id), ['auto', 'paid', 'local'])
    const body = JSON.stringify({ model: 'auto', messages: [{ role: 'system', content: 'sys' }, { role: 'user', content: [{ type: 'text', text: 'oi' }] }] })
    // paid use is OFF by default: the free local provider answers and the paid one is never called
    let r = await call('/v1/chat/completions', { method: 'POST', headers: auth, body })
    assert.equal(r.status, 200)
    assert.equal((await r.json()).choices[0].message.content, 'resposta do backup')
    assert.ok(!f.calls.some((c) => c.url.includes('paid.test')))
    // switch paid use on: the paid account is out of quota, the router moves on to local and the work continues
    await cmd.settings.setFlag('routerSpend', true)
    r = await call('/v1/chat/completions', { method: 'POST', headers: auth, body })
    const j = await r.json()
    assert.equal(r.status, 200)
    assert.equal(j.model.split('/')[0], 'local')
    assert.ok(f.calls.some((c) => c.url.includes('paid.test')), 'the paid provider was tried first')
    // stream:true gets a valid one-chunk SSE stream
    const s = await (await call('/v1/chat/completions', { method: 'POST', headers: auth, body: JSON.stringify({ messages: [{ role: 'user', content: 'x' }], stream: true }) })).text()
    assert.match(s, /data: \{.*resposta do backup.*\}\n\n.*data: \[DONE\]/s)
  } finally {
    server.close()
  }
})
