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

import { mkdtempSync, mkdirSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { scanProject, insideRoot } from '../../app/electron/projects.ts'
import { applyLine, emptyMetrics, projectDirName } from '../../app/electron/transcripts.ts'
import { findNode, layoutProject } from '../../app/renderer/src/neural/projectGraph.ts'

test('project scan: tree, relative imports, key files, git remote without credentials, skips node_modules', () => {
  const d = mkdtempSync(join(tmpdir(), 'proj-'))
  mkdirSync(join(d, 'src', 'lib'), { recursive: true })
  mkdirSync(join(d, 'node_modules', 'x'), { recursive: true })
  mkdirSync(join(d, '.git'))
  writeFileSync(join(d, 'README.md'), '# x')
  writeFileSync(join(d, 'package.json'), '{}')
  writeFileSync(join(d, 'src', 'main.ts'), "import { a } from './lib/util'\nimport React from 'react'\n")
  writeFileSync(join(d, 'src', 'lib', 'util.ts'), 'export const a = 1')
  writeFileSync(join(d, 'node_modules', 'x', 'i.js'), '1')
  writeFileSync(join(d, '.git', 'HEAD'), 'ref: refs/heads/dev\n')
  writeFileSync(join(d, '.git', 'config'), '[remote "origin"]\n\turl = https://user:tok@github.com/o/r.git\n')
  const g = scanProject(d)
  const paths = g.nodes.map((n) => n.path)
  assert.ok(paths.includes('src/lib/util.ts') && !paths.some((p) => p.includes('node_modules')))
  assert.equal(g.nodes.find((n) => n.path === 'README.md')?.kind, 'key')
  const main = g.nodes.findIndex((n) => n.path === 'src/main.ts'), util = g.nodes.findIndex((n) => n.path === 'src/lib/util.ts')
  assert.ok(g.edges.some(([a, b, k]) => a === main && b === util && k === 'import'))
  assert.deepEqual([g.git?.branch, g.git?.remote], ['dev', 'https://github.com/o/r.git'])
  assert.equal(findNode(g, join(d, 'SRC', 'main.ts')), main)
  assert.ok(insideRoot(d, join(d, 'src')) && !insideRoot(d, tmpdir()))
  const lay = layoutProject(g)
  assert.equal(lay.positions.length, g.nodes.length * 3)
  assert.ok([...lay.positions].every(Number.isFinite))
})

test('transcript metrics: usage counted once per message id, tools, files, todos, subagents', () => {
  const m = emptyMetrics()
  const line = (o: object) => JSON.stringify(o)
  const a = { type: 'assistant', sessionId: 's1', timestamp: 't', isSidechain: false, message: { id: 'm1', model: 'x', usage: { input_tokens: 10, output_tokens: 5, cache_read_input_tokens: 100 }, content: [{ type: 'tool_use', id: 't1', name: 'Read', input: { file_path: String.raw`C:\p\a.ts` } }] } }
  applyLine(line(a), m)
  applyLine(line(a), m) // same message streamed twice
  const ev = applyLine(line({ type: 'assistant', message: { id: 'm2', usage: { output_tokens: 2 }, content: [{ type: 'tool_use', name: 'Task', input: { description: 'explore' } }, { type: 'tool_use', name: 'TodoWrite', input: { todos: [{ content: 'a', status: 'pending' }] } }] } }), m)
  assert.deepEqual([m.inputTokens, m.outputTokens, m.cacheRead, m.turns], [10, 7, 100, 2])
  assert.deepEqual([m.tools.Read, m.tools.Task, m.files[0], m.subagentCalls, m.todos[0].text], [1, 1, String.raw`C:\p\a.ts`, 1, 'a'])
  assert.deepEqual(ev.map((e) => e.kind), ['subagent', 'todo'])
  assert.equal(applyLine('not json', m).length, 0)
  assert.equal(projectDirName(String.raw`G:\JARIVS`), 'G--JARIVS')
})

test('listen and mission commands are recognised, ordinary chat is not hijacked', () => {
  for (const t of ['ouvir', 'Jarvis, ouça', 'escute', 'modo escuta', 'ativar microfone', 'me escute!']) assert.deepEqual(parseIntent(t), { kind: 'listen' }, t)
  assert.deepEqual(parseIntent('missão: corrija os testes do meu projeto'), { kind: 'mission', goal: 'corrija os testes do meu projeto' })
  assert.equal(parseIntent('missão: x').kind, 'chat', 'too short to be a goal')
  for (const t of ['quero ouvir música', 'você ouviu o que eu disse?', 'o que é um microfone?']) assert.equal(parseIntent(t).kind, 'chat', t)
})
