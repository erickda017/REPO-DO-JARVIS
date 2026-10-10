import test from 'node:test'
import assert from 'node:assert/strict'
import { fakeFetch } from './helpers.mjs'
import { createRegistry } from '../../bridge/command/providers/registry.mjs'
import { createHealth } from '../../bridge/command/health.mjs'
import { createRouter } from '../../bridge/command/router.mjs'
import { createAudit } from '../../bridge/command/audit.mjs'

const KEY = 'sk-ant-api03-SEGREDOSEGREDOSEGREDO1234567890'
const cfgs = [
  { id: 'local', type: 'openai-compat', baseUrl: 'http://127.0.0.1:9/v1', models: ['q'], priority: 20, capabilities: ['chat'] },
  { id: 'coder', type: 'openai-compat', baseUrl: 'http://127.0.0.1:10/v1', models: ['c'], priority: 5, capabilities: ['coding'] },
  { id: 'cloud', type: 'anthropic', models: ['big'], priority: 10, capabilities: ['chat', 'coding'], price: { in: 3, out: 15 } },
]
const reply = (text, usage = { prompt_tokens: 100, completion_tokens: 50 }) => ({ body: { choices: [{ message: { content: text } }], model: 'x', usage } })

function stack(routes) {
  const f = fakeFetch(routes)
  const registry = createRegistry(cfgs, { fetch: f, env: { ANTHROPIC_API_KEY: KEY } })
  const audit = createAudit({ file: null })
  const health = createHealth({ registry, audit })
  const router = createRouter({ registry, health, audit })
  return { f, registry, router, audit, health }
}
const ROUTES = (url) => (url.includes('127.0.0.1') ? reply('local') : { body: { content: [{ type: 'text', text: 'cloud' }], usage: { input_tokens: 100, output_tokens: 50 } } })

test('model selection: capability is respected (a coding-only provider never answers chat) and tier preference reorders without breaking the spend gate', async () => {
  const { router, f } = stack(ROUTES)
  const chat = await router.run({ prompt: 'oi' })
  assert.equal(chat.provider, 'local', 'chat: coder lacks the capability, cloud is paid and not confirmed')
  const strongNoSpend = await router.run({ prompt: 'oi', tier: 'strong' })
  assert.equal(strongNoSpend.provider, 'local', 'strong preferred, but paid needs "autorizo gasto": falls back to the free one')
  const strong = await router.run({ prompt: 'oi', tier: 'strong', confirmSpend: true })
  assert.equal(strong.provider, 'cloud')
  const cheap = await router.run({ prompt: 'oi', tier: 'cheap', confirmSpend: true })
  assert.equal(cheap.provider, 'local', 'cheap preferred even though the cloud has the better priority')
  const coding = await router.run({ prompt: 'refatore', capability: 'coding' })
  assert.equal(coding.provider, 'coder')
  assert.ok(!f.calls.some((c) => c.url.includes('127.0.0.1:10') && /oi/.test(c.body ?? '')), 'coder never saw a chat prompt')
})

test('model selection: sensitive requests never reach an external provider, even when tier=strong and spending is authorised', async () => {
  const { router, f } = stack(ROUTES)
  const r = await router.run({ prompt: 'meus dados', tier: 'strong', confirmSpend: true, sensitive: true })
  assert.equal(r.provider, 'local')
  assert.ok(!f.calls.some((c) => c.url.includes('anthropic')))
})

test('router stats: calls, success rate, latency, tokens and estimated spend per provider', async () => {
  const { router } = stack(ROUTES)
  await router.run({ prompt: 'a', tier: 'strong', confirmSpend: true })
  await router.run({ prompt: 'b', tier: 'strong', confirmSpend: true })
  await router.run({ prompt: 'c' })
  const s = Object.fromEntries(router.stats().map((x) => [x.provider, x]))
  assert.equal(s.cloud.calls, 2)
  assert.equal(s.cloud.successRate, 1)
  assert.equal(s.cloud.inputTokens, 200)
  assert.ok(s.cloud.estUSD > 0, 'priced provider gets an estimate')
  assert.equal(s.local.estUSD, 0)
  assert.equal(s.local.calls, 1)
})

test('a provider failure never exposes the API key: not in the thrown error, the health snapshot or the audit log', async () => {
  const { router, audit, health } = stack((url) => (url.includes('anthropic') ? { status: 401, body: { error: { message: `invalid x-api-key ${KEY}` } } } : { status: 500, body: `boom ${KEY}` }))
  let err
  try { await router.run({ prompt: 'oi', tier: 'strong', confirmSpend: true }) } catch (e) { err = e }
  assert.ok(err, 'all providers failed')
  const dump = JSON.stringify({ err: err.toJSON?.() ?? String(err), msg: err.message, attempts: err.attempts, health: health.snapshot(), audit: audit.recent(50) })
  assert.ok(!dump.includes('SEGREDOSEGREDO'), 'key must not leak: ' + dump.slice(0, 300))
})
