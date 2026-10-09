import test from 'node:test'
import assert from 'node:assert/strict'
import { fakeFetch } from './helpers.mjs'
import { jevProvider } from '../../bridge/command/providers/jev.mjs'
import { createRegistry } from '../../bridge/command/providers/registry.mjs'
import { createHealth } from '../../bridge/command/health.mjs'
import { createRouter } from '../../bridge/command/router.mjs'
import { RouteError } from '../../bridge/command/errors.mjs'

const KEY = 'ts-JEVSECRET0123456789'
const env = { TYPESAFE_API_KEY: KEY }
const Q = { billing: { type: 'noul', instructions: 'Is this about billing?' } }

test('jev probe: /v1/models with Bearer; catalogue parsed from {models:[{name}]}', async () => {
  const f = fakeFetch(() => ({ body: { models: [{ name: 'jev-latest', description: 'd', release_date: '2026-09-15' }] } }))
  const r = await jevProvider({ id: 'jev' }, { fetch: f, env }).probe()
  assert.deepEqual(r.models, ['jev-latest'])
  assert.equal(r.auth.state, 'ok')
  assert.equal(f.calls[0].url, 'https://api.typesafe.ai/v1/models')
  assert.equal(f.calls[0].headers.authorization, `Bearer ${KEY}`)
})

test('jev probe: no key -> auth fail without sending an Authorization header', async () => {
  const f = fakeFetch(() => ({ status: 401, body: {} }))
  const r = await jevProvider({ id: 'jev' }, { fetch: f, env: {} }).probe()
  assert.equal(r.endpoint.state, 'ok')
  assert.equal(r.auth.state, 'fail')
  assert.equal(f.calls[0].headers.authorization, undefined)
})

test('jev decide: sends {state, model, questions} to /v1/systemone and validates answers', async () => {
  const f = fakeFetch(() => ({ body: { model: 'jev-x', answers: { billing: { type: 'noul', noul: 0.98 } }, usage: { input_tokens: 120, output_tokens: 12 } } }))
  const out = await jevProvider({ id: 'jev' }, { fetch: f, env }).decide({ model: 'jev-latest', state: 'charged twice', questions: Q })
  assert.equal(out.answers.billing.noul, 0.98)
  assert.equal(out.model, 'jev-x')
  assert.equal(out.usage.inputTokens, 120)
  const sent = JSON.parse(f.calls[0].body)
  assert.deepEqual(Object.keys(sent).sort(), ['model', 'questions', 'state'])
  assert.equal(f.calls[0].url, 'https://api.typesafe.ai/v1/systemone')
})

test('jev decide: rejects malformed or out-of-range answers instead of trusting them', async () => {
  const run = (answers) =>
    jevProvider({ id: 'jev' }, { fetch: fakeFetch(() => ({ body: { model: 'm', answers, usage: {} } })), env }).decide({ model: 'm', state: 's', questions: Q })
  await assert.rejects(run({}), (e) => e.kind === 'bad_response')
  await assert.rejects(run({ billing: { type: 'score', score: 1, confidence: 1 } }), (e) => e.kind === 'bad_response')
  await assert.rejects(run({ billing: { type: 'noul', noul: 1.7 } }), (e) => e.kind === 'bad_response')
  const choiceQ = { t: { type: 'choice', criteria: { a: 'x', b: 'y' } } }
  const p = jevProvider({ id: 'jev' }, { fetch: fakeFetch(() => ({ body: { model: 'm', answers: { t: { type: 'choice', choice: 'zzz', confidence: 0.9, probabilities: {} } }, usage: {} } })), env })
  await assert.rejects(p.decide({ model: 'm', state: 's', questions: choiceQ }), /not one of the requested/)
})

test('jev decide: 422 becomes bad_request; it cannot generate text', async () => {
  const p = jevProvider({ id: 'jev' }, { fetch: fakeFetch(() => ({ status: 422, body: { detail: [{ loc: ['body', 'state'], msg: 'Field required', type: 'missing' }] } })), env })
  await assert.rejects(p.decide({ model: 'm', state: '', questions: Q }), (e) => e.kind === 'bad_request' && /Field required/.test(e.message))
  await assert.rejects(p.infer(), (e) => e.kind === 'bad_request')
})

const cfgs = [
  { id: 'jev', type: 'typesafe-jev', models: ['jev-latest'], capabilities: ['decision'], priority: 1 },
  { id: 'claude', type: 'anthropic', models: ['c'], capabilities: ['chat'], priority: 2 },
  { id: 'coder', type: 'openai-compat', baseUrl: 'http://127.0.0.1:9/v1', models: ['q'], capabilities: ['coding'], priority: 3, paid: false },
]

function stack(routes, { sensitiveJev = false } = {}) {
  const f = fakeFetch(routes)
  const list = sensitiveJev ? cfgs.map((c) => (c.id === 'jev' ? { ...c, allowSensitive: true } : c)) : cfgs
  const registry = createRegistry(list, { fetch: f, env: { ...env, ANTHROPIC_API_KEY: 'x' } })
  const router = createRouter({ registry, health: createHealth({ registry }), cooldownMs: 1000 })
  return { f, router }
}
const jevSays = (choice, confidence) => ({ body: { model: 'jev-latest', answers: { task: { type: 'choice', choice, confidence, probabilities: { [choice]: confidence } } }, usage: { input_tokens: 5, output_tokens: 1 } } })
const routes = (decision) => (url) =>
  url.includes('/v1/systemone') ? decision
  : url.includes('/v1/messages') ? { body: { content: [{ type: 'text', text: 'claude answer' }] } }
  : { body: { choices: [{ message: { content: 'coder answer' } }] } }

test('decide: needs confirmSpend, and a decision provider is never used for generation', async () => {
  const { router, f } = stack(routes(jevSays('chat', 0.9)))
  await assert.rejects(router.decide({ state: 's', questions: Q }), (e) => e instanceof RouteError && /not confirmed/.test(e.message))
  assert.equal(f.calls.length, 0)
  const out = await router.run({ prompt: 'hi', confirmSpend: true }) // chat -> claude, never jev
  assert.equal(out.provider, 'claude')
})

test('smartRun: Jev picks the coding provider when confident', async () => {
  const { router } = stack(routes(jevSays('coding', 0.93)), { sensitiveJev: true })
  const out = await router.smartRun({ prompt: 'fix this bug in my function', confirmSpend: true })
  assert.equal(out.provider, 'coder')
  assert.equal(out.routing.decider, 'jev')
  assert.equal(out.routing.choice, 'coding')
})

test('smartRun: low confidence uses the default capability and says why', async () => {
  const { router } = stack(routes(jevSays('coding', 0.4)))
  const out = await router.smartRun({ prompt: 'hmm', confirmSpend: true })
  assert.equal(out.provider, 'claude')
  assert.match(out.routing.skipped, /below/)
})

test('smartRun: Jev down -> still answers via default routing, failure reported', async () => {
  const { router } = stack(routes({ status: 503, body: {} }))
  const out = await router.smartRun({ prompt: 'hello', confirmSpend: true })
  assert.equal(out.provider, 'claude')
  assert.match(out.routing.skipped, /decision unavailable/)
})

test('smartRun: sensitive prompt is never sent to Jev (external), only local generators', async () => {
  const { router, f } = stack(routes(jevSays('chat', 0.9)))
  const out = await router.smartRun({ prompt: 'my password manager export', sensitive: true, confirmSpend: true })
  assert.equal(out.provider, 'coder') // the only local provider
  assert.ok(!f.calls.some((c) => c.url.includes('typesafe.ai')))
  assert.ok(!f.calls.some((c) => c.url.includes('anthropic.com')))
})

test('smartRun: no spend confirmation -> no Jev call, and generation is still blocked', async () => {
  const { router, f } = stack(routes(jevSays('chat', 0.9)))
  await assert.rejects(router.smartRun({ prompt: 'hi' }), (e) => e instanceof RouteError)
  assert.equal(f.calls.length, 0)
})
