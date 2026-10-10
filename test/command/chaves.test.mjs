import test from 'node:test'
import assert from 'node:assert/strict'
import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { fakeFetch } from './helpers.mjs'
import { createRegistry } from '../../bridge/command/providers/registry.mjs'
import { createRouter } from '../../bridge/command/router.mjs'
import { createSettings } from '../../bridge/command/settings.mjs'
import { createHealth } from '../../bridge/command/health.mjs'

const cfgs = () => [
  { id: 'local', type: 'openai-compat', baseUrl: 'http://127.0.0.1:9/v1', models: ['q'], priority: 50, capabilities: ['chat'] },
  { id: 'openrouter', type: 'openai-compat', baseUrl: 'https://openrouter.test/v1', apiKeyEnv: 'OPENROUTER_API_KEY', priority: 10, capabilities: ['chat'], enabled: true, paid: false },
]
const ok = (text) => ({ body: { choices: [{ message: { content: text } }], model: 'x', usage: { prompt_tokens: 1, completion_tokens: 1 } } })
const bearer = (init) => String(init.headers?.authorization ?? init.headers?.Authorization ?? '')

async function stack(routes, file = null) {
  const f = fakeFetch(routes)
  let registry
  const settings = createSettings({ file, getRegistry: () => registry, baseEnv: {} })
  registry = createRegistry(cfgs(), { fetch: f, env: settings.env() })
  await settings.ready()
  return { f, registry, settings, router: createRouter({ registry }), health: createHealth({ registry }) }
}

test('extra key: becomes its own provider with its own key name, starts as a copy of the first one, and the key is accepted', async () => {
  const { registry, settings } = await stack(() => ok('x'))
  await settings.setKey('OPENROUTER_API_KEY', 'sk-or-aaaaaaaaaa')
  await settings.setProvider('openrouter', { model: 'meta/llama:free', allowedModels: ['meta/llama:free', 'google/gemma:free'], free: true })
  const id = await settings.addKey('openrouter')
  assert.equal(id, 'openrouter-2')
  const p = registry.get(id)
  assert.equal(p.extraOf, 'openrouter')
  assert.equal(p.keyEnv, 'OPENROUTER_API_KEY_2')
  assert.equal(p.priority, 10)
  assert.equal(p.defaultModel, 'meta/llama:free')
  assert.deepEqual(p.allowedModels, ['meta/llama:free', 'google/gemma:free'])
  assert.equal(p.paid, false)
  assert.match(p.label, /chave 2/)
  await settings.setKey('OPENROUTER_API_KEY_2', 'sk-or-bbbbbbbbbb')
  assert.deepEqual(settings.keys().filter((k) => k.configured).map((k) => k.name).sort(), ['OPENROUTER_API_KEY', 'OPENROUTER_API_KEY_2'])
  assert.equal(await settings.addKey('openrouter'), 'openrouter-3')
  await assert.rejects(() => settings.addKey('local'), /one key only/)
  await assert.rejects(() => settings.addKey('openrouter-2'), /one key only/, 'an added key cannot be duplicated itself')
})

test('extra key: when the first key runs out of quota the second key (its own Authorization) answers, and the first is left alone for a while', async () => {
  const { settings, router, f } = await stack((url, init) => {
    if (!url.includes('openrouter')) return ok('local')
    return bearer(init).includes('aaaa') ? { status: 402, body: { error: { message: 'no credit' } } } : ok('segunda chave')
  })
  await settings.setKey('OPENROUTER_API_KEY', 'sk-or-aaaaaaaaaa')
  await settings.setProvider('openrouter', { model: 'm1' })
  await settings.addKey('openrouter')
  await settings.setKey('OPENROUTER_API_KEY_2', 'sk-or-bbbbbbbbbb')
  const r = await router.run({ prompt: 'oi' })
  assert.equal(r.provider, 'openrouter-2')
  assert.match(r.text, /segunda/)
  const auth = f.calls.filter((c) => c.url.includes('openrouter')).map((c) => bearer({ headers: c.headers }))
  assert.ok(auth[0].includes('aaaa') && auth[1].includes('bbbb'), 'each key only ever sent as its own')
  f.calls.length = 0
  await router.run({ prompt: 'de novo' })
  assert.ok(f.calls.every((c) => bearer({ headers: c.headers }).includes('bbbb')), 'exhausted key skipped on the next request')
})

test('extra key: survives a restart with its settings, and removing it deletes the entry and its saved key', async () => {
  const dir = await mkdtemp(join(tmpdir(), 'jarvis-keys-'))
  try {
    const file = join(dir, 'settings.json')
    const a = await stack(() => ok('x'), file)
    await a.settings.setKey('OPENROUTER_API_KEY', 'sk-or-aaaaaaaaaa')
    const id = await a.settings.addKey('openrouter')
    await a.settings.setKey('OPENROUTER_API_KEY_2', 'sk-or-bbbbbbbbbb')
    await a.settings.setProvider(id, { model: 'solo:free' })
    const b = await stack(() => ok('x'), file) // fresh process: nothing in memory
    const p = b.registry.get(id)
    assert.ok(p, 'extra provider rebuilt from settings.json')
    assert.equal(p.defaultModel, 'solo:free')
    assert.equal(b.settings.keys().find((k) => k.name === 'OPENROUTER_API_KEY_2').configured, true)
    assert.equal(b.health.snapshot().find((x) => x.id === id).extraOf, 'openrouter')
    await b.settings.removeKey(id)
    assert.equal(b.registry.get(id), null)
    assert.ok(!b.settings.keys().some((k) => k.name === 'OPENROUTER_API_KEY_2'), 'its key name is no longer accepted')
    await assert.rejects(() => b.settings.removeKey('openrouter'), /only an added key/)
    const c = await stack(() => ok('x'), file)
    assert.equal(c.registry.get(id), null, 'removal persisted')
    assert.equal(c.settings.keys().find((k) => k.name === 'OPENROUTER_API_KEY').configured, true, 'the first key is untouched')
  } finally {
    await rm(dir, { recursive: true, force: true })
  }
})

test('NVIDIA NIM: in the built-in catalogue, OpenAI-compatible against integrate.api.nvidia.com, its own key, and extra keys work like any service', async () => {
  const { withCatalog } = await import('../../bridge/command/catalog.mjs')
  const cfg = withCatalog([]).find((p) => p.id === 'nvidia')
  assert.deepEqual([cfg.type, cfg.baseUrl, cfg.apiKeyEnv, cfg.enabled], ['openai-compat', 'https://integrate.api.nvidia.com/v1', 'NVIDIA_API_KEY', false])
  const f = fakeFetch((url, init) => {
    if (url.endsWith('/models')) return { body: { data: [{ id: 'meta/llama-3.1-8b-instruct' }, { id: 'nvidia/nv-embed-v1' }] } }
    return bearer(init).includes('nvapi-bbbb') ? ok('resposta NIM') : { status: 429, body: { error: { message: 'rate' } } }
  })
  let registry
  const settings = createSettings({ file: null, getRegistry: () => registry, baseEnv: {} })
  registry = createRegistry([{ ...cfg, enabled: true, paid: false, models: ['meta/llama-3.1-8b-instruct'] }], { fetch: f, env: settings.env() })
  const router = createRouter({ registry })
  await settings.setKey('NVIDIA_API_KEY', 'nvapi-aaaaaaaaaa')
  const id = await settings.addKey('nvidia')
  await settings.setKey('NVIDIA_API_KEY_2', 'nvapi-bbbbbbbbbb')
  const r = await router.run({ prompt: 'oi' })
  assert.equal(r.provider, 'nvidia-2', 'first key rate limited, second one answers')
  assert.match(f.calls.at(-1).url, /^https:\/\/integrate\.api\.nvidia\.com\/v1\/chat\/completions$/)
  assert.equal(JSON.parse(f.calls.at(-1).body).model, 'meta/llama-3.1-8b-instruct')
  const probe = await registry.get('nvidia').adapter.probe()
  assert.deepEqual(probe.models, ['meta/llama-3.1-8b-instruct', 'nvidia/nv-embed-v1'])
  assert.equal(id, 'nvidia-2')
})