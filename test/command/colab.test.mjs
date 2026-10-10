import test from 'node:test'
import assert from 'node:assert/strict'
import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { fakeFetch } from './helpers.mjs'
import { withCatalog } from '../../bridge/command/catalog.mjs'
import { createRegistry } from '../../bridge/command/providers/registry.mjs'
import { createRouter } from '../../bridge/command/router.mjs'
import { createSettings, normalizeTunnelUrl } from '../../bridge/command/settings.mjs'
import { createHealth } from '../../bridge/command/health.mjs'

const ok = (text) => ({ body: { choices: [{ message: { content: text } }], model: 'qwen2.5-coder-14b', usage: { prompt_tokens: 1, completion_tokens: 1 } } })

async function stack(routes, file = null) {
  const f = fakeFetch(routes)
  let registry
  const settings = createSettings({ file, getRegistry: () => registry, baseEnv: {} })
  registry = createRegistry(withCatalog([]), { fetch: f, env: settings.env() })
  await settings.ready()
  return { f, registry, settings, router: createRouter({ registry }), health: createHealth({ registry }) }
}

test('normalizeTunnelUrl: https only, adds /v1, rejects IPs, credentials, paths; empty clears', () => {
  assert.equal(normalizeTunnelUrl(' https://abc-def.trycloudflare.com/ '), 'https://abc-def.trycloudflare.com/v1')
  assert.equal(normalizeTunnelUrl('https://abc.trycloudflare.com/v1/'), 'https://abc.trycloudflare.com/v1')
  assert.equal(normalizeTunnelUrl(''), '')
  for (const bad of ['http://abc.trycloudflare.com', 'abc.trycloudflare.com', 'https://127.0.0.1/v1', 'https://localhost', 'https://u:p@abc.trycloudflare.com', 'https://abc.trycloudflare.com/x', 'https://abc.trycloudflare.com/?k=1']) {
    assert.throws(() => normalizeTunnelUrl(bad), undefined, bad)
  }
})

test('colab: starts off and without address; the router skips it. After pasting a URL it answers there; a new URL takes effect with no restart', async () => {
  const hosts = []
  const { registry, settings, router } = await stack((url) => { hosts.push(new URL(url).host); return ok('oi do colab') })
  const p = registry.get('colab')
  assert.equal(p.enabled, false)
  assert.equal(p.paid, false)
  assert.equal(p.external, true, 'it leaves this PC, so sensitive requests never reach it')
  assert.equal(p.defaultModel, 'qwen2.5-coder-14b')
  assert.equal(p.keyEnv, null)
  await settings.setProvider('colab', { enabled: true, baseUrl: 'https://um.trycloudflare.com' })
  const r = await router.run({ prompt: 'oi' })
  assert.equal(r.provider, 'colab')
  assert.equal(hosts.at(-1), 'um.trycloudflare.com')
  await settings.setProvider('colab', { baseUrl: 'https://dois.trycloudflare.com/v1' })
  await router.run({ prompt: 'oi' })
  assert.equal(hosts.at(-1), 'dois.trycloudflare.com')
  await assert.rejects(() => settings.setProvider('colab', { baseUrl: 'http://x.trycloudflare.com' }), /https/)
  await assert.rejects(() => settings.setProvider('gemini', { baseUrl: 'https://x.example.com' }), /fixed address/)
})

test('colab: without an address nothing is called (unconfigured, no network); a dead address shows up in the health check', async () => {
  const { settings, health, router, f } = await stack((url) => (url.includes('morto') ? { status: 530, body: 'tunnel gone' } : ok('x')))
  await settings.setProvider('colab', { enabled: true })
  const none = await health.check('colab')
  assert.notEqual(none.endpoint.state, 'fail')
  assert.equal(none.models, null)
  await assert.rejects(() => router.run({ prompt: 'oi' }), Error)
  assert.equal(f.calls?.length ?? 0, 0, 'no address, no request')
  await settings.setProvider('colab', { baseUrl: 'https://morto.trycloudflare.com' })
  const dead = await health.check('colab')
  assert.equal(dead.models, null, 'no catalogue from a dead tunnel')
})

test('colab: the server names its model by file path (long): it is adopted by the health check, accepted by settings, sent as is', async () => {
  const path = '/root/.cache/huggingface/hub/models--mradermacher--Qwen2.5-Coder-14B-Instruct-abliterated-GGUF/snapshots/6a5dcca31ef7dd0888c29fa5fe8591284853050a/Qwen2.5-Coder-14B-Instruct-abliterated.Q4_K_M.gguf'
  assert.ok(path.length > 120)
  const bodies = []
  const { registry, settings, health, router } = await stack((url, init) => {
    if (url.endsWith('/models')) return { body: { data: [{ id: path }] } }
    bodies.push(JSON.parse(init.body).model)
    return ok('oi')
  })
  await settings.setProvider('colab', { enabled: true, baseUrl: 'https://quatro.trycloudflare.com' })
  const r = await health.check('colab')
  assert.equal(r.model.state, 'ok')
  assert.equal(registry.get('colab').defaultModel, path)
  await settings.setProvider('colab', { allowedModels: [path] }) // pasted by hand: no length error
  await router.run({ prompt: 'oi' })
  assert.equal(bodies.at(-1), path)
})

test('colab: the address survives a restart (saved in the overrides)', async () => {
  const dir = await mkdtemp(join(tmpdir(), 'colab-'))
  try {
    const file = join(dir, 'settings.json')
    const a = await stack(() => ok('x'), file)
    await a.settings.setProvider('colab', { enabled: true, baseUrl: 'https://tres.trycloudflare.com' })
    const b = await stack(() => ok('x'), file)
    assert.equal(b.registry.get('colab').cfg.baseUrl, 'https://tres.trycloudflare.com/v1')
    assert.equal(b.registry.get('colab').enabled, true)
    assert.equal(b.health.snapshot().find((x) => x.id === 'colab').baseUrl, 'https://tres.trycloudflare.com/v1')
  } finally {
    await rm(dir, { recursive: true, force: true })
  }
})
