import test from 'node:test'
import assert from 'node:assert/strict'
import { createRouter } from '../../bridge/command/router.mjs'

const prov = (id, priority, adapter, external = true) => ({ id, enabled: true, type: 'openai-compat', external, paid: false, priority, tier: 'strong', capabilities: ['chat'], allowSensitive: false, allowFallback: true, allowedModels: [], defaultModel: 'm', adapter })

test('fast request: an external API that sends no text in time is dropped and the next one answers (a local model is never hurried)', async () => {
  const hang = { async *stream({ signal }) { await new Promise((_, rej) => signal.addEventListener('abort', () => rej(new Error('aborted')), { once: true })) } }
  const good = { async *stream() { yield { delta: 'oi' } } }
  const registry = { list: () => [prov('lenta', 1, hang), prov('boa', 2, good)] }
  const router = createRouter({ registry })
  const t0 = Date.now()
  let text = '', provider
  for await (const ev of router.runStream({ prompt: 'x', fast: true, firstTokenMs: 60 })) { if (ev.start) provider = ev.provider; if (ev.delta) text += ev.delta }
  assert.deepEqual([provider, text], ['boa', 'oi'])
  assert.ok(Date.now() - t0 < 1500)
  // a local provider is allowed to be slow even for fast requests
  const slowLocal = { async *stream() { await new Promise((r) => setTimeout(r, 150)); yield { delta: 'devagar' } } }
  const r2 = createRouter({ registry: { list: () => [prov('local', 1, slowLocal, false)] } })
  let out = ''
  for await (const ev of r2.runStream({ prompt: 'x', fast: true, firstTokenMs: 40 })) if (ev.delta) out += ev.delta
  assert.equal(out, 'devagar')
})
