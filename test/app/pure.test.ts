import test from 'node:test'
import assert from 'node:assert/strict'
import { Activity, buildCloud, entityForAudit, layoutEntities, mulberry32, providerTone } from '../../app/renderer/src/neural/graph.ts'
import { mediaUrls, parseIntent } from '../../app/renderer/src/intents.ts'

test('cloud is deterministic, hollow at the core, and every neuron is linked', () => {
  const a = buildCloud(320, 7)
  const b = buildCloud(320, 7)
  assert.deepEqual(a.points[5], b.points[5])
  assert.equal(a.points.length, 320)
  assert.ok(a.points.every((p) => Math.hypot(p.x, p.y, p.z) > 1.1))
  assert.ok(a.neighbors.every((n) => n.length >= 1), 'no isolated neuron')
  const long = a.edges.filter(([i, j]) => Math.hypot(a.points[i].x - a.points[j].x, a.points[i].y - a.points[j].y, a.points[i].z - a.points[j].z) > 1.25)
  assert.ok(long.length < a.edges.length * 0.1, 'synapses stay short')
})

test('activity spreads to neighbours, weakens, and dies out', () => {
  const cloud = buildCloud(120, 3)
  const act = new Activity(cloud)
  const rand = mulberry32(1)
  act.fire(0, 1, 0)
  let now = 0
  for (let i = 0; i < 20; i++) act.step(0.05, (now += 0.05), rand)
  const lit = [...act.a].filter((v) => v > 0.05).length
  assert.ok(lit > 1, 'activation should spread beyond the first neuron')
  assert.ok(Math.max(...act.a) <= 1)
  for (let i = 0; i < 200; i++) act.step(0.05, (now += 0.05), rand)
  assert.ok(Math.max(...act.a) < 0.01, 'activation decays to rest')
})

const provider = (over = {}) => ({ id: 'p', label: 'P', type: 't', enabled: true, external: false, paid: false, model: 'm', capabilities: [], recentErrors: [], status: null, ...over })
const ok = { state: 'ok' }
test('provider tone follows the four-level health, not just reachability', () => {
  assert.equal(providerTone(provider({ enabled: false })), 'off')
  assert.equal(providerTone(provider()), 'unknown')
  assert.equal(providerTone(provider({ status: { endpoint: { state: 'fail' }, auth: ok, model: ok, inference: ok } })), 'bad')
  assert.equal(providerTone(provider({ status: { endpoint: ok, auth: { state: 'fail' }, model: ok, inference: ok } })), 'warn')
  assert.equal(providerTone(provider({ status: { endpoint: ok, auth: { state: 'unknown' }, model: ok, inference: { state: 'skipped' } } })), 'ok')
})

test('layout has one stable node per real entity and maps audit events to nodes', () => {
  const ov = { providers: [provider({ id: 'a' })], services: [{ id: 's', name: 'S', status: 'up', lastLatencyMs: 4 }], projects: [], tasks: [], timer: { status: 'idle' } }
  const ids = layoutEntities(ov).map((n) => n.id)
  assert.deepEqual(ids, ['core', 'ai:a', 'svc:s', 'tasks', 'timer', 'voice'])
  assert.equal(entityForAudit({ action: 'ai.infer', provider: 'a' }), 'ai:a')
  assert.equal(entityForAudit({ action: 'timer.start' }), 'timer')
  assert.equal(entityForAudit({ action: 'unknown.thing' }), null)
})

test('intents: predictable commands, everything else is chat', () => {
  assert.deepEqual(parseIntent('timer de 5 min'), { kind: 'timer', seconds: 300 })
  assert.deepEqual(parseIntent('cronômetro 30 segundos'), { kind: 'timer', seconds: 30 })
  assert.deepEqual(parseIntent('criar tarefa: comprar cabo'), { kind: 'createTask', title: 'comprar cabo' })
  assert.deepEqual(parseIntent('como estão as IAs?'), { kind: 'status' })
  assert.deepEqual(parseIntent('minhas tarefas'), { kind: 'tasks' })
  assert.deepEqual(parseIntent('mostre https://x.test/a.png'), { kind: 'media', url: 'https://x.test/a.png', mediaType: 'image' })
  assert.equal(parseIntent('qual a capital da França?').kind, 'chat')
  assert.equal(parseIntent('timer de 9999 horas').kind, 'chat')
  assert.deepEqual(mediaUrls('veja https://a.test/v.mp4, e https://a.test/p.JPG.'), [{ url: 'https://a.test/v.mp4', mediaType: 'video' }, { url: 'https://a.test/p.JPG', mediaType: 'image' }])
})
