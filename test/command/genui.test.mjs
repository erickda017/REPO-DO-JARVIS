import test from 'node:test'
import assert from 'node:assert/strict'
import { existsSync, mkdirSync, mkdtempSync, readFileSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { validateSpec, NODE_TYPES } from '../../shared/genui/spec.mjs'
import { evalCond, getRef, interpolate, parseRef, resolveArgs, setData } from '../../shared/genui/resolve.mjs'
import { createGenUi, quickSpec } from '../../bridge/command/genui.mjs'
import { createAccess } from '../../bridge/agent/access.mjs'
import { buildTools } from '../../bridge/agent/tools.mjs'
import { createMonitor, } from '../../bridge/agent/monitor.mjs'

async function world({ dir = null, router = null, monitor = createMonitor({ run: async () => null, runText: async () => '' }) } = {}) {
  const home = mkdtempSync(join(tmpdir(), 'jv-gui-'))
  const proj = join(home, 'proj')
  mkdirSync(proj)
  const env = { USERPROFILE: home, TEMP: join(home, 'Temp'), APPDATA: join(home, 'AppData'), LOCALAPPDATA: join(home, 'Local') }
  mkdirSync(env.TEMP)
  const access = createAccess({ env, systemFolders: false })
  await access.addRoot(proj)
  let genui = null
  const tools = buildTools({ access, monitor, profiles: {}, env, dataDir: join(home, 'data'), getGenUi: () => genui })
  genui = createGenUi({ tools, access, router, monitor, dir })
  return { home, proj, access, tools, genui }
}
const view = async (g, id, since) => g.view(id, since)

// ------------------------------------------------------------------------------------------------ validation
test('spec validation: every component type renders from a minimal valid node, unknown types are errors, unknown props are dropped with a warning', () => {
  const minimal = {
    stack: { children: [] }, grid: { cols: 2, children: [] }, split: { children: [] }, card: { title: 'x', children: [] }, tabs: { tabs: [{ id: 'a', label: 'A', children: [] }] },
    text: { text: 'oi' }, stat: { label: 'L', value: 1 }, kv: { items: [] }, alert: { tone: 'warn', text: 't' }, progress: { value: 1 }, steps: { items: [] }, empty: { text: 'nada' },
    table: { columns: [{ key: 'a' }], rows: [] }, list: { items: [] }, chart: { kind: 'bar', data: [], series: [{ key: 'v' }] }, log: { lines: [] }, files: { items: [] }, results: { items: [] },
    form: { fields: [{ name: 'q' }], submit: { label: 'Ir', action: 'go' } }, control: { field: { name: 'q' } }, button: { label: 'B', action: 'go' },
  }
  assert.deepEqual(Object.keys(minimal).sort(), [...NODE_TYPES].sort(), 'the test covers the whole catalogue')
  for (const [type, props] of Object.entries(minimal)) {
    const r = validateSpec({ v: 1, title: type, actions: { go: { type: 'state', set: { a: 1 } } }, root: { type, ...props, enfeite: 'ignorado' } })
    assert.equal(r.ok, true, `${type}: ${JSON.stringify(r.errors)}`)
    assert.ok(r.warnings.some((w) => /desconhecida/.test(w.msg)), `${type}: unknown prop warned`)
    assert.equal(r.spec.root.enfeite, undefined, 'and dropped')
  }
  const bad = validateSpec({ v: 1, title: 't', root: { type: 'script', src: 'x' } })
  assert.equal(bad.ok, false)
  assert.match(bad.errors[0].msg, /componente desconhecido/)
})

test('spec validation: structure errors are reported with paths (missing required props, bad refs, undeclared actions, cycles of ids, limits)', () => {
  const r = validateSpec({ v: 1, title: 't', root: { type: 'stack', children: [
    { type: 'button', label: 'x', action: 'nao_existe' },
    { type: 'text' },
    { type: 'table', columns: [], rows: { ref: 'window.alert' } },
    { type: 'chart', kind: 'bar', data: [], series: [] },
    { type: 'stat', label: 'a', value: { ref: 'data.__proto__.x' } },
    { type: 'text', text: 'ok', id: 'dup' }, { type: 'text', text: 'ok', id: 'dup' },
  ] } })
  const paths = r.errors.map((e) => e.path)
  assert.ok(paths.includes('root.children[0].action'))
  assert.ok(paths.includes('root.children[1].text'))
  assert.ok(paths.some((p) => p.endsWith('.columns')))
  assert.ok(paths.some((p) => p.endsWith('.rows')), 'a ref outside data/state/row/form')
  assert.ok(paths.some((p) => p.endsWith('.series')))
  assert.ok(paths.some((p) => p.endsWith('.value')), 'prototype segment refused')
  assert.ok(paths.some((p) => p.endsWith('.id')), 'duplicate id')
  assert.equal(r.ok, false)
  const deep = (n) => (n === 0 ? { type: 'text', text: 'x' } : { type: 'stack', children: [deep(n - 1)] })
  assert.equal(validateSpec({ v: 1, title: 't', root: deep(12) }).ok, false, 'depth limit')
  const wide = { type: 'stack', children: Array.from({ length: 150 }, () => ({ type: 'stack', children: [{ type: 'text', text: 'x' }, { type: 'text', text: 'y' }] })) }
  assert.equal(validateSpec({ v: 1, title: 't', root: wide }).ok, false, 'node count limit')
  assert.equal(validateSpec('texto').ok, false)
  assert.equal(validateSpec({ v: 2, title: 't', root: { type: 'text', text: 'a' } }).ok, false)
})

test('bindings are data, not code: only data/state/row/form paths resolve, prototype chain and functions are unreachable', () => {
  const scope = { data: { rows: [{ n: 'a' }, { n: 'b' }], total: 3 }, state: { q: 'x' }, row: { path: 'C:\\a.txt' } }
  assert.equal(getRef(scope, 'data.rows[1].n'), 'b')
  assert.equal(getRef(scope, 'data.rows.length'), 2)
  assert.equal(getRef(scope, 'data.nope.deep'), undefined)
  for (const bad of ['data.__proto__', 'data.constructor.name', 'window.location', 'data.rows.map', 'state.toString', 'process.env']) assert.equal(getRef(scope, bad), undefined, bad)
  assert.equal(parseRef('data.__proto__.x'), null)
  assert.equal(interpolate('Total {{data.total}} de {{state.q}} {{data.zzz}}!', scope), 'Total 3 de x !')
  assert.equal(evalCond({ ref: 'data.total', gt: 2 }, scope), true)
  assert.equal(evalCond({ ref: 'data.rows' }, scope), true)
  assert.equal(evalCond({ ref: 'data.rows.length', eq: 0 }, scope), false)
  assert.deepEqual(resolveArgs({ path: { ref: 'row.path' }, q: 'busca {{state.q}}', n: 3, deep: [{ ref: 'data.total' }] }, scope), { path: 'C:\\a.txt', q: 'busca x', n: 3, deep: [3] })
  const hostile = { data: { x: { __proto__: { polluted: 1 }, ok: 1 } } }
  assert.equal(resolveArgs({ k: { ref: 'data.x' } }, hostile).k.polluted, undefined)
  const d = {}
  assert.equal(setData(d, 'data.__proto__.polluted', 1), false)
  assert.equal(setData(d, 'state.x', 1), false, 'actions can only write into data')
  assert.equal(setData(d, 'data.found', [1]), true)
  assert.equal({}.polluted, undefined)
})

test('security at validation: sources must be read-only tools, buttons cannot name run_command/ui tools, nothing creates panels from panels', async () => {
  const { genui } = await world()
  const mk = (extra) => ({ v: 1, title: 't', root: { type: 'text', text: 'x' }, ...extra })
  const w = await genui.create(mk({ sources: { s: { kind: 'tool', tool: 'fs_write', args: {} } } }))
  assert.equal(w.ok, false)
  assert.match(w.message, /só podem usar ferramentas de leitura/)
  const cmd = await genui.create(mk({ actions: { a: { type: 'tool', tool: 'run_command', args: { command: 'calc' } } } }))
  assert.equal(cmd.ok, false)
  const nested = await genui.create(mk({ actions: { a: { type: 'tool', tool: 'ui_show', args: {} } } }))
  assert.equal(nested.ok, false)
  const ghost = await genui.create(mk({ actions: { a: { type: 'tool', tool: 'apagar_tudo', args: {} } } }))
  assert.equal(ghost.ok, false)
  assert.match(ghost.message, /desconhecida/)
})

// ------------------------------------------------------------------------------------------------ quick builders
test('quick builders: every kind yields a VALID spec from plain data', () => {
  const rows = [{ nome: 'A', cpu: 10, ram: 20 }, { nome: 'B', cpu: 30, ram: 15 }]
  for (const kind of ['table', 'bar', 'hbar', 'line', 'area', 'pie', 'donut', 'compare']) {
    const r = validateSpec(quickSpec({ kind, title: kind, data: rows }))
    assert.equal(r.ok, true, `${kind}: ${JSON.stringify(r.errors)}`)
  }
  assert.equal(validateSpec(quickSpec({ kind: 'stats', data: [{ label: 'CPU', value: 12, unit: '%' }] })).ok, true)
  assert.equal(validateSpec(quickSpec({ kind: 'files', data: [{ path: 'C:\\a.txt', name: 'a.txt', sizeKB: 1 }] })).ok, true)
  assert.equal(validateSpec(quickSpec({ kind: 'steps', data: [{ title: 'a', status: 'done' }] })).ok, true)
  assert.equal(validateSpec(quickSpec({ kind: 'log', data: ['linha 1', 'linha 2'] })).ok, true)
  const cmp = quickSpec({ kind: 'compare', data: rows })
  assert.equal(cmp.data.best[0].value, 'B', 'best-per-metric headline is computed from the data')
})

// ------------------------------------------------------------------------------------------------ case 1: comparison with charts, real data
test('CASE 1 (real data): a comparison panel with chart + table built from the real size of this project\'s folders, and a live source bound to a real tool', async () => {
  const { genui, tools, access } = await world()
  await access.addRoot('G:/JARIVS')
  const big = await tools.disk_largest.run({ path: 'G:/JARIVS/bridge', top: 6 })
  assert.ok(big.data.items?.length || big.data.largest?.length || Object.keys(big.data).length, 'the real tool answered')
  const items = (big.data.items ?? big.data.largest ?? big.data.entries ?? []).slice(0, 6)
  assert.ok(items.length >= 2, `real folder data: ${JSON.stringify(big.data).slice(0, 200)}`)
  const rows = items.map((i) => ({ pasta: String(i.name ?? i.path).split(/[\\/]/).pop(), mb: Number(i.sizeMB ?? i.mb ?? (i.bytes ? i.bytes / 2 ** 20 : 0)) || 0, arquivos: Number(i.files ?? i.count ?? 0) }))
  const r = await genui.quick({ kind: 'compare', title: 'Tamanho das pastas do bridge', data: rows, x: 'pasta', series: ['mb', 'arquivos'], unit: 'MB' }, { owner: { kind: 'agent' } })
  assert.equal(r.ok, true, r.message)
  const v = await view(genui, r.id)
  assert.equal(v.spec.root.type, 'stack')
  assert.deepEqual(v.data.rows.value, rows, 'the panel holds exactly the data measured by the tool')
  // live: a panel whose data comes from a real read-only tool, refreshed by the bridge, not by the model
  const live = await genui.create({ v: 1, title: 'Pasta ao vivo', sources: { listing: { kind: 'tool', tool: 'fs_list', args: { path: 'G:/JARIVS/bridge/agent' }, everySec: 3, pick: 'data.items' } }, root: { type: 'table', columns: [{ key: 'name', label: 'Arquivo' }, { key: 'sizeKB', label: 'KB', format: 'number' }], rows: { ref: 'data.listing' }, sortable: true } })
  assert.equal(live.ok, true, live.message)
  const lv = await view(genui, live.id)
  assert.equal(lv.sources.listing.ok, true, lv.sources.listing.error)
  assert.ok(lv.data.listing.value.some((f) => f.name === 'orquestrador.mjs'), 'real file names from the real folder')
  const again = await view(genui, live.id, { data: { listing: lv.data.listing.rev } })
  assert.deepEqual(again.data, {}, 'nothing re-sent while nothing changed')
})

test('a source whose group is switched off reports it instead of failing silently', async () => {
  const { genui, access } = await world()
  await access.setTool('files', false)
  const r = await genui.create({ v: 1, title: 't', sources: { l: { kind: 'tool', tool: 'fs_list', args: { path: 'G:/' } } }, root: { type: 'text', text: 'x' } })
  const v = await view(genui, r.id)
  assert.equal(v.sources.l.ok, false)
  assert.match(v.sources.l.error, /desligado/)
})

// ------------------------------------------------------------------------------------------------ case 2: progress panel with incremental updates
test('CASE 2: execution panel receives incremental updates (data, status, node patches) and the renderer only gets what changed', async () => {
  const { genui } = await world()
  const r = await genui.create({ v: 1, title: 'Build', purpose: 'Acompanhar a execução', status: 'loading',
    data: { steps: [{ title: 'Instalar', status: 'running' }, { title: 'Testar', status: 'pending' }], lines: ['iniciando…'], pct: 5 },
    root: { type: 'stack', children: [{ type: 'progress', id: 'bar', value: { ref: 'data.pct' }, max: 100, label: 'Progresso' }, { type: 'steps', items: { ref: 'data.steps' } }, { type: 'log', lines: { ref: 'data.lines' }, follow: true }, { type: 'alert', id: 'msg', tone: 'info', text: 'Rodando', show: true }] } })
  assert.equal(r.ok, true)
  const v1 = await view(genui, r.id)
  assert.equal(v1.status, 'loading')
  const since = { specRev: v1.specRev, data: Object.fromEntries(Object.entries(v1.data).map(([k, x]) => [k, x.rev])) }
  const u = await genui.update(r.id, [
    { op: 'appendData', name: 'lines', value: ['npm install… ok', 'rodando testes…'] },
    { op: 'setData', name: 'pct', value: 60 },
    { op: 'setData', name: 'steps', value: [{ title: 'Instalar', status: 'done' }, { title: 'Testar', status: 'running' }] },
  ])
  assert.equal(u.ok, true)
  const v2 = await view(genui, r.id, since)
  assert.deepEqual(Object.keys(v2.data).sort(), ['lines', 'pct', 'steps'])
  assert.equal(v2.spec, undefined, 'the spec was NOT re-sent for a data-only update')
  assert.deepEqual(v2.data.lines.value, ['iniciando…', 'npm install… ok', 'rodando testes…'])
  // structural change: only the spec revision moves, data untouched
  const since2 = { specRev: v2.specRev, data: Object.fromEntries(Object.entries({ ...v1.data, ...v2.data }).map(([k, x]) => [k, x.rev])) }
  const p = await genui.update(r.id, [{ op: 'patchNode', id: 'msg', props: { tone: 'ok', text: 'Concluído' } }, { op: 'setStatus', status: 'done', text: '2 de 2 etapas' }, { op: 'addNode', parent: v2.spec?.root?.id ?? v1.spec.root.id, node: { type: 'text', text: 'Fim', variant: 'caption' } }])
  assert.equal(p.ok, true, JSON.stringify(p))
  const v3 = await view(genui, r.id, since2)
  assert.equal(v3.status, 'done')
  assert.equal(v3.statusText, '2 de 2 etapas')
  assert.deepEqual(v3.data, {}, 'data untouched')
  assert.equal(v3.spec.root.children.find((c) => c.id === 'msg').text, 'Concluído')
  assert.equal(v3.spec.root.children.at(-1).text, 'Fim')
  // a bad patch changes NOTHING
  const bad = await genui.update(r.id, [{ op: 'patchNode', id: 'msg', props: { tone: 'explosivo' } }])
  assert.equal(bad.ok, false)
  assert.equal((await view(genui, r.id, { specRev: v3.specRev, data: {} })).spec, undefined)
  const unknown = await genui.update(r.id, [{ op: 'eval', code: 'alert(1)' }])
  assert.equal(unknown.ok, false)
  assert.equal((await genui.update('naoexiste', [{ op: 'setData', name: 'a', value: 1 }])).ok, false)
})

test('CASE 2 (real mission): the mission panel is bound to the live mission view and follows it to the end', async () => {
  const { createOrchestrator } = await import('../../bridge/agent/orquestrador.mjs')
  const { createAgent } = await import('../../bridge/agent/agent.mjs')
  const { home, proj, access, tools } = await world()
  let genui
  const fake = { calls: 0, run: async (req) => {
    const sys = req.system ?? ''
    if (sys.includes('orquestrador do JARVIS')) return { text: JSON.stringify({ criteria: ['pasta listada'], steps: [{ title: 'Listar', role: 'geral', goal: 'liste a pasta', depends: [] }] }), provider: 'f', model: 'm' }
    const n = req.messages.filter((m) => m.content.startsWith('RESULTADO')).length
    if (/SUA ETAPA v /.test(req.messages[0].content)) return { text: n === 0 ? JSON.stringify({ action: 'tool', tool: 'fs_list', args: { path: proj } }) : JSON.stringify({ action: 'final', text: 'Critério atendido.\nVEREDITO: confere — ok' }), provider: 'f', model: 'm' }
    if (/SUA ETAPA/.test(req.messages[0].content)) return { text: n === 0 ? JSON.stringify({ action: 'tool', tool: 'fs_list', args: { path: proj } }) : JSON.stringify({ action: 'final', text: 'A pasta tem 1 arquivo (fs_list).' }), provider: 'f', model: 'm', usage: { inputTokens: 50, outputTokens: 10 } }
    return { text: JSON.stringify({ action: n === 0 ? 'tool' : 'final', tool: 'fs_list', args: { path: proj }, text: 'VEREDITO: confere — ok' }), provider: 'f', model: 'm' }
  } }
  writeFileSync(join(proj, 'a.txt'), 'x')
  const agent = createAgent({ router: fake, tools, access, jobDeadlineMs: 60_000 })
  const missions = createOrchestrator({ router: fake, agent, access, hooks: { created: (id, goal) => genui.forMission(id, goal) } })
  genui = createGenUi({ tools, access, missions })
  const { id } = await missions.start({ goal: 'Liste a pasta do projeto' })
  const list = await genui.list()
  const panel = list.find((p) => p.owner.kind === 'mission')
  assert.ok(panel, 'a panel was created for the mission')
  await missions.wait(id, 30_000)
  const v = await view(genui, panel.id)
  assert.equal(v.data.mission.value.status, 'concluido', JSON.stringify(v.sources))
  assert.equal(v.data.mission.value.doneCount, 1)
  assert.ok(v.data.mission.value.usageTotal > 0)
  assert.ok(v.data.mission.value.logLines.length > 2)
  // the panel's own buttons drive that mission only (trusted), and a user-made panel cannot approve confirmations
  const cancel = await genui.action(panel.id, 'cancel')
  assert.equal(cancel.ok, true)
  const stranger = await genui.create({ v: 1, title: 'x', actions: { a: { type: 'missionop', op: 'confirm', approve: true } }, root: { type: 'button', label: 'Autorizar tudo', action: 'a' } }, { owner: { kind: 'agent' } })
  assert.equal((await genui.action(stranger.id, 'a')).ok, false)
})

// ------------------------------------------------------------------------------------------------ case 3: file management with real actions and permissions
test('CASE 3 (real files): search form -> results -> preview / delete, executed through the real tools with permissions and confirmations', async () => {
  const { genui, proj, home, access } = await world()
  writeFileSync(join(proj, 'relatorio.txt'), 'linha 1\nlinha 2\n')
  writeFileSync(join(proj, 'notas.txt'), 'comprar leite')
  mkdirSync(join(proj, 'sub'))
  writeFileSync(join(proj, 'sub', 'relatorio-2.txt'), 'outro')
  const outside = join(home, 'fora.txt')
  writeFileSync(outside, 'segredo')
  const r = await genui.create({ v: 1, title: 'Arquivos', state: { root: proj, q: 'relatorio' }, data: { found: [], preview: null },
    actions: {
      search: { type: 'tool', tool: 'fs_search', args: { root: { ref: 'state.root' }, name: { ref: 'state.q' } }, into: 'data.found', pick: 'data.results' },
      preview: { type: 'tool', tool: 'fs_read', args: { path: { ref: 'row.path' } }, into: 'data.preview', pick: 'data' },
      remove: { type: 'tool', tool: 'fs_delete', args: { path: { ref: 'row.path' }, permanent: true }, messages: { ok: 'Apagado' } },
      move: { type: 'tool', tool: 'fs_move', args: { from: { ref: 'row.path' }, to: '{{state.root}}\\arquivo-movido.txt' } },
    },
    root: { type: 'stack', children: [
      { type: 'form', fields: [{ name: 'q', label: 'Nome contém', required: true }], submit: { label: 'Buscar', action: 'search' } },
      { type: 'files', items: { ref: 'data.found' }, itemActions: [{ label: 'Ver', action: 'preview' }, { label: 'Apagar', action: 'remove', tone: 'bad' }, { label: 'Mover', action: 'move' }] },
    ] } }, { owner: { kind: 'agent' } })
  assert.equal(r.ok, true, r.message)
  // 1) the search runs the REAL fs_search with arguments resolved from the form/state
  const s = await genui.action(r.id, 'search', { state: { root: proj, q: 'relatorio' } })
  assert.equal(s.ok, true, JSON.stringify(s))
  let v = await view(genui, r.id)
  const found = v.data.found.value
  assert.deepEqual(found.map((f) => f.path.split(/[\\/]/).pop()).sort(), ['relatorio-2.txt', 'relatorio.txt'])
  // 2) preview a result row (read: runs without asking)
  const row = found.find((f) => f.path.endsWith('relatorio.txt') && !f.path.includes('sub'))
  const pv = await genui.action(r.id, 'preview', { row })
  assert.equal(pv.ok, true, JSON.stringify(pv))
  v = await view(genui, r.id, { data: {} })
  assert.match(v.data.preview.value.text, /linha 2/)
  // 3) permissions: a row pointing OUTSIDE the granted folders is refused by the tool itself
  const out = await genui.action(r.id, 'preview', { row: { path: outside } })
  assert.equal(out.ok, false)
  assert.match(out.error, /fora das pastas liberadas/)
  // 4) a model-authored button that deletes ALWAYS asks first, showing the real tool and path, whatever it is labelled
  const ask = await genui.action(r.id, 'remove', { row })
  assert.equal(ask.needsConfirm, true)
  assert.equal(ask.tool, 'fs_delete')
  assert.match(ask.message, /relatorio\.txt/)
  assert.equal(existsSync(row.path), true, 'nothing happened before the confirmation')
  // 5) after the owner confirms, it really deletes (and the tool verifies)
  const done = await genui.action(r.id, 'remove', { row, confirmed: true })
  assert.equal(done.ok, true, JSON.stringify(done))
  assert.equal(done.verified, true)
  assert.equal(existsSync(row.path), false)
  await new Promise((r) => setTimeout(r, 1100)) // the per-panel rate limit (5 actions/s) is for runaway loops, not for this pace
  // 6) a non-read tool without its own confirmation (fs_move) STILL asks when the panel is model-authored
  const mv = await genui.action(r.id, 'move', { row: { path: join(proj, 'notas.txt') }, state: { root: proj } })
  assert.equal(mv.needsConfirm, true)
  const mv2 = await genui.action(r.id, 'move', { row: { path: join(proj, 'notas.txt') }, state: { root: proj }, confirmed: true })
  assert.equal(mv2.ok, true, JSON.stringify(mv2))
  assert.equal(readFileSync(join(proj, 'arquivo-movido.txt'), 'utf8'), 'comprar leite')
  await new Promise((r) => setTimeout(r, 1100))
  // 7) group switched off -> refused with the reason
  await access.setTool('files', false)
  const off = await genui.action(r.id, 'search', { state: { root: proj, q: 'x' } })
  assert.equal(off.ok, false)
  assert.equal(off.code, 'group_off')
  await access.setTool('files', true)
  await new Promise((r) => setTimeout(r, 1100))
  // 8) unknown action / path traversal style args / rate limit
  assert.equal((await genui.action(r.id, 'inexistente')).code, 'no_action')
  const trav = await genui.action(r.id, 'preview', { row: { path: join(proj, '..', 'fora.txt') } })
  assert.equal(trav.ok, false)
  let limited = null
  for (let i = 0; i < 8; i++) limited = await genui.action(r.id, 'preview', { row: { path: 'x' } })
  assert.equal(limited.code, 'rate')
})

test('the quick "files" panel works end to end on real files (Ver / Apagar to the Recycle Bin)', { skip: process.platform !== 'win32' }, async () => {
  const { genui, proj } = await world()
  const f = join(proj, 'qualquer.log')
  writeFileSync(f, 'conteúdo de teste')
  const r = await genui.quick({ kind: 'files', title: 'Logs', data: [{ path: f, name: 'qualquer.log', sizeKB: 1, type: 'arquivo' }] }, { owner: { kind: 'agent' } })
  assert.equal(r.ok, true, r.message)
  const row = { path: f }
  const pv = await genui.action(r.id, 'preview', { row })
  assert.equal(pv.ok, true, JSON.stringify(pv))
  assert.equal((await genui.action(r.id, 'remove', { row })).needsConfirm, true)
  const rm = await genui.action(r.id, 'remove', { row, confirmed: true })
  assert.equal(rm.ok, true, JSON.stringify(rm))
  assert.equal(existsSync(f), false)
})

// ------------------------------------------------------------------------------------------------ lifecycle, persistence, generation
test('lifecycle: pin survives a restart (spec + control state), unpinned panels do not, closing removes the saved file, a corrupt or invalid saved panel is skipped', async () => {
  const dir = join(mkdtempSync(join(tmpdir(), 'jv-ui-')), 'ui')
  const a = await world({ dir })
  const keep = await a.genui.quick({ kind: 'table', title: 'Fixo', data: [{ a: 1 }] })
  const temp = await a.genui.quick({ kind: 'table', title: 'Temporário', data: [{ a: 2 }] })
  assert.equal(await a.genui.pin(keep.id, 'Meu painel'), true)
  await a.genui.saveState(keep.id, { tab: 'data', q: 'x' })
  await new Promise((r) => setTimeout(r, 100))
  writeFileSync(join(dir, 'lixo.json'), '{ nao e json')
  writeFileSync(join(dir, 'invalido.json'), JSON.stringify({ id: 'invalido', spec: { v: 1, title: 'x', root: { type: 'malware' } } }))
  const b = createGenUi({ tools: a.tools, access: a.access, dir })
  const list = await b.list()
  assert.deepEqual(list.map((p) => p.id), [keep.id], 'only the valid pinned panel came back')
  const v = await b.view(keep.id)
  assert.equal(v.name, 'Meu painel')
  assert.equal(v.pinned, true)
  assert.ok(temp.id && !list.some((p) => p.id === temp.id))
  assert.equal(await b.close(keep.id), true)
  assert.equal(existsSync(join(dir, `${keep.id}.json`)), false)
})

test('generation through the router: valid spec accepted; invalid spec gets ONE repair round with the errors; hopeless output falls back to a table of the data', async () => {
  const seen = []
  const router = { run: async (req) => { seen.push(req); return seen.length === 1
    ? { text: '```json\n{"v":1,"title":"x","root":{"type":"hologram"}}\n```', provider: 'f', model: 'm' }
    : { text: JSON.stringify({ v: 1, title: 'Comparação', data: { r: [{ n: 'a', v: 1 }] }, root: { type: 'chart', kind: 'bar', data: { ref: 'data.r' }, x: 'n', series: [{ key: 'v' }] } }), provider: 'f', model: 'm' } } }
  const { genui } = await world({ router })
  const ok = await genui.generate({ prompt: 'compare a e b' })
  assert.equal(ok.ok, true)
  assert.equal(ok.via, 'model-repaired')
  assert.match(seen[1].messages.at(-1).content, /componente desconhecido/, 'the repair round shows the validation errors')
  assert.equal(seen[0].tier, 'cheap', 'cheap model first unless spending is authorised')
  const hopeless = createGenUi({ tools: (await world()).tools, access: (await world()).access, router: { run: async () => ({ text: 'desculpe, não sei', provider: 'f', model: 'm' }) } })
  const fb = await hopeless.generate({ prompt: 'mostre', data: [{ a: 1 }, { a: 2 }] })
  assert.equal(fb.ok, true)
  assert.equal(fb.via, 'fallback')
  const none = await hopeless.generate({ prompt: 'mostre' })
  assert.equal(none.ok, false)
  // tabular data with an obvious kind never needs a model at all
  const rules = await genui.generate({ prompt: 'mostre', data: [{ n: 'a', v: 1 }], hint: 'bar' })
  assert.equal(rules.via, 'rules')
  const spendy = await genui.generate({ prompt: 'projete algo complexo', confirmSpend: true }).catch(() => null)
  assert.ok(seen.some((s) => s.tier === 'strong') || spendy !== null)
})

test('agent tools: ui_quick / ui_show / ui_update create and change panels, invalid specs come back as a usable error, and a button cannot smuggle in a forbidden tool', async () => {
  const { genui, tools } = await world()
  const q = await tools.ui_quick.run({ kind: 'bar', title: 'Vendas', data: [{ mes: 'jan', v: 3 }, { mes: 'fev', v: 5 }], x: 'mes', series: ['v'] })
  assert.equal(q.verified, true)
  assert.ok((await genui.list()).some((p) => p.id === q.data.panelId))
  await assert.rejects(tools.ui_show.run({ spec: { v: 1, title: 'x', root: { type: 'exec' } } }), /componente desconhecido/)
  await assert.rejects(tools.ui_show.run({ spec: { v: 1, title: 'x', actions: { a: { type: 'tool', tool: 'run_command', args: {} } }, root: { type: 'button', label: 'Limpar', action: 'a' } } }), /não pode ser usada/)
  const up = await tools.ui_update.run({ id: q.data.panelId, ops: [{ op: 'setStatus', status: 'done', text: 'pronto' }] })
  assert.equal(up.verified, true)
  assert.match((await tools.ui_catalog.run({})).data.catalog, /chart\{kind/)
  assert.equal((await tools.ui_close.run({ id: q.data.panelId })).data.closed, true)
})
