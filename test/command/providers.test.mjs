import test from 'node:test'
import assert from 'node:assert/strict'
import { fakeFetch } from './helpers.mjs'
import { redact, redactString } from '../../bridge/command/redact.mjs'
import { ProviderError, RouteError } from '../../bridge/command/errors.mjs'
import { anthropicProvider } from '../../bridge/command/providers/anthropic.mjs'
import { openaiCompatProvider } from '../../bridge/command/providers/openaiCompat.mjs'
import { createRegistry } from '../../bridge/command/providers/registry.mjs'
import { createHealth } from '../../bridge/command/health.mjs'
import { createRouter } from '../../bridge/command/router.mjs'

const SECRET = 'sk-ant-SECRETSECRET123456'
const env = { ANTHROPIC_API_KEY: SECRET }

test('redact scrubs sensitive keys and token shapes', () => {
  assert.equal(redact({ apiKey: 'x', nested: { Authorization: 'Bearer abcdefghijkl' }, ok: 1 }).apiKey, '[redacted]')
  assert.equal(redact({ nested: { Authorization: 'y' } }).nested.Authorization, '[redacted]')
  assert.ok(!redactString(`failed with ${SECRET}`).includes('SECRET'))
})

test('anthropic probe: no key -> endpoint ok, auth fail, never sends x-api-key', async () => {
  const f = fakeFetch(() => ({ status: 401, body: { error: { message: 'no key' } } }))
  const p = anthropicProvider({ id: 'a' }, { fetch: f, env: {} })
  const r = await p.probe()
  assert.equal(r.endpoint.state, 'ok')
  assert.equal(r.auth.state, 'fail')
  assert.equal(f.calls[0].headers['x-api-key'], undefined)
})

test('anthropic probe: 200 gives auth ok and model catalogue', async () => {
  const f = fakeFetch(() => ({ body: { data: [{ id: 'm1' }, { id: 'm2' }] } }))
  const r = await anthropicProvider({ id: 'a' }, { fetch: f, env }).probe()
  assert.equal(r.auth.state, 'ok')
  assert.deepEqual(r.models, ['m1', 'm2'])
})

test('anthropic probe: network failure and timeout are distinct normalised errors', async () => {
  const net = anthropicProvider({ id: 'a' }, { fetch: fakeFetch(() => new Error('ECONNREFUSED')), env })
  await assert.rejects(net.probe(), (e) => e instanceof ProviderError && e.kind === 'network' && e.retryable)
  const slow = anthropicProvider({ id: 'a', timeoutMs: 30 }, { fetch: fakeFetch(() => 'hang'), env })
  await assert.rejects(slow.probe(), (e) => e.kind === 'timeout')
})

test('anthropic infer: parses text, rejects empty/invalid replies, error text has no key', async () => {
  const ok = anthropicProvider({ id: 'a' }, { fetch: fakeFetch(() => ({ body: { model: 'm1', content: [{ type: 'text', text: 'hi' }], usage: { input_tokens: 3, output_tokens: 1 } } })), env })
  const out = await ok.infer({ model: 'm1', prompt: 'x' })
  assert.equal(out.text, 'hi')
  assert.equal(out.usage.inputTokens, 3)
  const empty = anthropicProvider({ id: 'a' }, { fetch: fakeFetch(() => ({ body: { content: [] } })), env })
  await assert.rejects(empty.infer({ model: 'm1', prompt: 'x' }), (e) => e.kind === 'bad_response')
  const leaky = anthropicProvider({ id: 'a' }, { fetch: fakeFetch(() => ({ status: 400, body: { error: { message: `bad ${SECRET}` } } })), env })
  await assert.rejects(leaky.infer({ model: 'm1', prompt: 'x' }), (e) => e.kind === 'bad_request' && !e.message.includes('SECRET'))
})

test('openai-compat: refuses a /models reply that is not OpenAI-shaped', async () => {
  const p = openaiCompatProvider({ id: 'l', baseUrl: 'http://127.0.0.1:1234/v1' }, { fetch: fakeFetch(() => ({ body: { hello: 'world' } })), env: {} })
  await assert.rejects(p.probe(), (e) => e.kind === 'bad_response')
})

const cfgs = [
  { id: 'cloud', type: 'anthropic', models: ['m'], priority: 1 },
  { id: 'local', type: 'openai-compat', baseUrl: 'http://127.0.0.1:9/v1', models: ['q'], priority: 2, paid: false },
  { id: 'jev', type: 'unverified', priority: 0, models: ['x'] },
]

function stack(routes, over = {}) {
  const f = fakeFetch(routes)
  const registry = createRegistry(over.cfgs ?? cfgs, { fetch: f, env })
  const health = createHealth({ registry })
  const router = createRouter({ registry, health, cooldownMs: 1000 })
  return { f, registry, health, router }
}

test('health keeps the four levels separate and never infers without confirm', async () => {
  const { health, f } = stack((url) => (url.includes('/v1/models') ? { body: { data: [{ id: 'other' }] } } : { body: {} }))
  const r = await health.check('cloud', { inference: true })
  assert.equal(r.endpoint.state, 'ok')
  assert.equal(r.auth.state, 'ok')
  assert.equal(r.model.state, 'fail')
  assert.equal(r.inference.state, 'skipped')
  assert.ok(!f.calls.some((c) => c.url.endsWith('/v1/messages')))
})

test('health: unreachable endpoint is fail, not ok', async () => {
  const { health } = stack(() => new Error('ECONNREFUSED'))
  const r = await health.check('cloud')
  assert.equal(r.endpoint.state, 'fail')
  assert.equal(r.auth.state, 'unknown')
  assert.equal(health.recentErrors('cloud')[0].kind, 'network')
})

test('health: unverified provider reports unknown and makes no calls', async () => {
  const { health, f } = stack(() => ({}))
  const r = await health.check('jev', { inference: true, confirm: true })
  assert.equal(r.endpoint.state, 'unknown')
  assert.equal(r.inference.state, 'fail')
  assert.equal(f.calls.length, 0)
})

test('router: paid call blocked until confirmSpend, nothing sent', async () => {
  const { router, f } = stack(() => ({}), { cfgs: [cfgs[0]] })
  await assert.rejects(router.run({ prompt: 'hi' }), (e) => e instanceof RouteError && /not confirmed/.test(e.message))
  assert.equal(f.calls.length, 0)
})

test('router: sensitive request never goes to an external provider', async () => {
  const { router, f } = stack(() => ({}), { cfgs: [cfgs[0]] })
  await assert.rejects(router.run({ prompt: 'secret', sensitive: true, confirmSpend: true }), (e) => /no eligible/.test(e.message))
  assert.equal(f.calls.length, 0)
})

test('router: falls back after a retryable failure, skips unverified, reports attempts', async () => {
  const { router } = stack((url) =>
    url.includes('anthropic') ? { status: 503, body: {} } : { body: { choices: [{ message: { content: 'from local' } }], model: 'q' } },
  )
  const out = await router.run({ prompt: 'hi', confirmSpend: true })
  assert.equal(out.text, 'from local')
  assert.equal(out.provider, 'local')
  assert.ok(out.attempts.some((a) => a.provider === 'cloud' && a.error.kind === 'server'))
  assert.ok(out.attempts.some((a) => a.provider === 'jev' && /not verified/.test(a.skipped)))
})

test('router: auth error moves on to the next provider and is still surfaced when all fail', async () => {
  const { router, f } = stack(() => ({ status: 401, body: {} }))
  await assert.rejects(router.run({ prompt: 'hi', confirmSpend: true }), (e) => e instanceof RouteError && e.attempts.some((a) => a.error?.kind === 'auth'))
  assert.ok(f.calls.length >= 1)
})

test('router: all providers down -> RouteError, never a fake answer', async () => {
  const { router } = stack(() => new Error('ECONNREFUSED'))
  await assert.rejects(router.run({ prompt: 'hi', confirmSpend: true }), (e) => e instanceof RouteError && /all eligible providers failed/.test(e.message))
})

test('openai-compat: keyless llama-server style reply is accepted, auth reported as unknown not ok', async () => {
  const f = fakeFetch(() => ({ body: { object: 'list', data: [{ id: 'qwen-local', object: 'model' }] } }))
  const r = await openaiCompatProvider({ id: 'local', baseUrl: 'http://127.0.0.1:8080/v1' }, { fetch: f, env: {} }).probe()
  assert.deepEqual(r.models, ['qwen-local'])
  assert.equal(r.auth.state, 'unknown')
  assert.equal(f.calls[0].headers.authorization, undefined)
  const out = await openaiCompatProvider({ id: 'local', baseUrl: 'http://127.0.0.1:8080/v1' }, { fetch: fakeFetch(() => ({ body: { model: 'qwen-local', choices: [{ message: { content: 'oi' } }] } })), env: {} }).infer({ model: 'qwen-local', prompt: 'x' })
  assert.equal(out.text, 'oi')
})

test('router: a rejected key (401) or an empty-credit 400 on the first provider still lets the next one answer', async () => {
  for (const first of [{ status: 401, body: {} }, { status: 400, body: { error: { message: 'Your credit balance is too low' } } }]) {
    const { router } = stack((url) => (url.includes('anthropic') ? first : { body: { choices: [{ message: { content: 'from local' } }], model: 'q' } }))
    const out = await router.run({ prompt: 'hi', confirmSpend: true })
    assert.equal(out.provider, 'local')
    assert.ok(out.attempts.some((a) => a.provider === 'cloud' && a.error))
  }
})
