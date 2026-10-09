import test from 'node:test'
import assert from 'node:assert/strict'
import http from 'node:http'
import { mkdtemp, readFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { fakeFetch } from './helpers.mjs'
import { createServiceMonitor } from '../../bridge/command/services.mjs'
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
    const local = { messages: [{ role: 'user', content: 'oi' }, { role: 'assistant', content: 'olá' }, { role: 'user', content: 'tudo bem?' }], confirm: true }
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
