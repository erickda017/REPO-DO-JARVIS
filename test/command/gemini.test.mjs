import test from 'node:test'
import assert from 'node:assert/strict'
import { fakeFetch } from './helpers.mjs'
import { geminiProvider, thinkingFor } from '../../bridge/command/providers/gemini.mjs'

test('gemini: thinking is turned down per model family, and a model that refuses the field is retried without it once, then remembered', async () => {
  assert.deepEqual(thinkingFor('gemini-2.5-flash'), { thinkingBudget: 0 })
  assert.deepEqual(thinkingFor('models/gemini-3.8-flash'), { thinkingLevel: 'low' })
  assert.equal(thinkingFor('gemini-2.5-pro'), null)
  const bodies = []
  const f = fakeFetch((url, init) => {
    bodies.push(JSON.parse(init.body).generationConfig)
    return bodies.length === 1 ? { status: 400, body: { error: { message: 'Unknown name "thinkingLevel": Cannot find field.' } } } : { body: { candidates: [{ content: { parts: [{ text: 'ok' }] } }] } }
  })
  const p = geminiProvider({ id: 'gemini', apiKeyEnv: 'K' }, { fetch: f, env: { K: 'x'.repeat(12) } })
  assert.equal((await p.infer({ model: 'gemini-9.1-lite', prompt: 'oi' })).text, 'ok')
  assert.ok(bodies[0].thinkingConfig && !bodies[1].thinkingConfig, 'second attempt has no thinking field')
  await p.infer({ model: 'gemini-9.1-lite', prompt: 'oi' })
  assert.equal(bodies.length, 3)
  assert.ok(!bodies[2].thinkingConfig, 'remembered: no more failed first attempts')
})
