import test from 'node:test'
import assert from 'node:assert/strict'
import { fakeFetch } from './helpers.mjs'
import { createRegistry } from '../../bridge/command/providers/registry.mjs'
import { createRouter } from '../../bridge/command/router.mjs'
import { createSettings } from '../../bridge/command/settings.mjs'

const cfgs = [
  { id: 'local', type: 'openai-compat', baseUrl: 'http://127.0.0.1:9/v1', models: ['q'], priority: 50, capabilities: ['chat'] },
  { id: 'or', type: 'openai-compat', baseUrl: 'https://openrouter.test/v1', apiKeyEnv: 'OR_KEY', models: ['pago/caro'], priority: 10, capabilities: ['chat'] },
]
const ok = (text) => ({ body: { choices: [{ message: { content: text } }], model: 'x', usage: { prompt_tokens: 1, completion_tokens: 1 } } })
// `bodyModel` reads which model the request asked for, so the fake can fail only some of them.
const bodyModel = (init) => JSON.parse(init.body).model

function stack(routes) {
  const f = fakeFetch(routes)
  const registry = createRegistry(cfgs, { fetch: f, env: { OR_KEY: 'sk-or-0123456789' } })
  const router = createRouter({ registry })
  return { f, registry, router }
}

test('free flag: an external provider is skipped until the owner marks it free, then answers without "autorizo gasto"', async () => {
  const { registry, router } = stack((url) => ok(url.includes('openrouter') ? 'nuvem' : 'local'))
  assert.equal((await router.run({ prompt: 'oi' })).provider, 'local', 'external = paid by default')
  registry.update('or', { free: true })
  assert.equal((await router.run({ prompt: 'oi' })).provider, 'or')
  registry.update('or', { free: false })
  assert.equal((await router.run({ prompt: 'oi' })).provider, 'local', 'unmarking puts the gate back')
  registry.update('local', { free: false })
  assert.equal(registry.get('local').paid, false, 'a loopback provider can never become paid')
})

test('allowlist: only listed models are used, in order; a quota/429 on one moves to the next MODEL before leaving the provider', async () => {
  const { registry, router, f } = stack((url, init) => {
    if (!url.includes('openrouter')) return ok('local')
    const m = bodyModel(init)
    if (m === 'a:free') return { status: 429, body: { error: { message: 'limit' } } }
    if (m === 'b:free') return { status: 402, body: { error: { message: 'no credit' } } }
    return ok(`resposta de ${m}`)
  })
  registry.update('or', { free: true, allowedModels: ['a:free', 'b:free', 'c:free'] })
  const r = await router.run({ prompt: 'oi' })
  assert.equal(r.provider, 'or')
  assert.match(r.text, /c:free/)
  assert.deepEqual(f.calls.filter((c) => c.url.includes('openrouter')).map((c) => bodyModel(c)), ['a:free', 'b:free', 'c:free'])
  assert.ok(!f.calls.some((c) => c.body?.includes('pago/caro')), 'the paid default model was never called')
  // Next request: the two exhausted models are cooling, so it goes straight to the one that works.
  f.calls.length = 0
  await router.run({ prompt: 'oi de novo' })
  assert.deepEqual(f.calls.map((c) => bodyModel(c)), ['c:free'])
})

test('allowlist: a model named by the caller outside the list is ignored; all listed models exhausted falls to the next provider', async () => {
  const { registry, router, f } = stack((url, init) => (url.includes('openrouter') ? { status: 429, body: {} } : ok('local')))
  registry.update('or', { free: true, allowedModels: ['a:free'] })
  const r = await router.run({ prompt: 'oi', model: 'pago/caro' })
  assert.equal(r.provider, 'local')
  assert.ok(!f.calls.some((c) => c.url.includes('openrouter') && c.body?.includes('pago/caro')), 'caller cannot bypass the allowlist')
  // Provider is now cooling as a whole; the local one keeps answering.
  assert.equal((await router.run({ prompt: 'de novo' })).provider, 'local')
})

test('allowlist streaming: same model rotation before the first token', async () => {
  const { registry, router } = stack((url, init) => (url.includes('openrouter') ? (bodyModel(init) === 'a:free' ? { status: 429, body: {} } : ok('livre')) : ok('local')))
  registry.update('or', { free: true, allowedModels: ['a:free', 'b:free'] })
  const seen = []
  for await (const ev of router.runStream({ prompt: 'oi' })) if (ev.start || ev.done) seen.push(ev.provider + '/' + ev.model)
  assert.deepEqual(seen, ['or/b:free', 'or/b:free'])
})

test('settings: free + allowedModels are validated, persisted as overrides and applied', async () => {
  const f = fakeFetch(() => ok('x'))
  let registry
  const settings = createSettings({ file: null, getRegistry: () => registry })
  registry = createRegistry(cfgs, { fetch: f, env: settings.env() })
  await settings.setProvider('or', { free: true, allowedModels: ['m1:free', 'm1:free', 'm2:free'] })
  assert.equal(registry.get('or').paid, false)
  assert.deepEqual(registry.get('or').allowedModels, ['m1:free', 'm2:free'], 'duplicates dropped')
  await assert.rejects(() => settings.setProvider('or', { allowedModels: ['ok', 'bad model with spaces'] }), /allowedModels/)
  await assert.rejects(() => settings.setProvider('or', { allowedModels: 'nope' }), /allowedModels/)
  await assert.rejects(() => settings.setProvider('or', { allowedModels: Array.from({ length: 21 }, (_, i) => `m${i}`) }), /allowedModels/)
  assert.deepEqual(registry.get('or').allowedModels, ['m1:free', 'm2:free'], 'a rejected update changes nothing')
})
