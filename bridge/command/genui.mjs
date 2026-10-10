import { randomUUID } from 'node:crypto'
import { mkdir, readdir, readFile, rename, rm, writeFile } from 'node:fs/promises'
import { join } from 'node:path'
import { BANNED_TOOLS, LIMITS, NODE_TYPES, TONES, explain, validateSpec } from '../../shared/genui/spec.mjs'
import { getRef, pick, resolveArgs, setData } from '../../shared/genui/resolve.mjs'
import { extractJson } from '../agent/agent.mjs'
import { redactString } from './redact.mjs'

/**
 * Generative UI: panels described by a declarative spec (see shared/genui/spec.mjs), kept apart from their data and from
 * the actions they can trigger, so each can be updated and tested on its own.
 *
 *   spec     what to draw           validated, versioned (specRev), updated by incremental ops
 *   data     what to show           per-source revisions; static, or live from tools/missions/the monitor
 *   actions  what the buttons do    executed HERE through the same tools, permissions and confirmations as the agent
 *
 * A model-authored panel can never run code: it can only name registered components and registered TOOLS. Any action that
 * is not a harmless read needs the owner's confirmation showing the real tool and arguments, whatever the button says.
 */
const MAX_PANELS = 12
const MAX_DATA_BYTES = LIMITS.dataBytes
const clip = (s, n) => (String(s ?? '').length > n ? String(s).slice(0, n) + '…' : String(s ?? ''))
const now = (clock) => new Date(clock()).toISOString()
const bytes = (v) => { try { return JSON.stringify(v).length } catch { return Infinity } }

// ---------------------------------------------------------------------------------------------- quick builders
const numKeys = (rows) => { const r = rows.find((x) => x && typeof x === 'object') ?? {}; return Object.keys(r).filter((k) => rows.some((x) => typeof x?.[k] === 'number')) }
const strKey = (rows) => { const r = rows.find((x) => x && typeof x === 'object') ?? {}; return Object.keys(r).find((k) => typeof r[k] === 'string') ?? Object.keys(r)[0] }
const label = (k) => String(k).replace(/[_-]/g, ' ').replace(/^./, (c) => c.toUpperCase())
const TONE_CYCLE = ['accent', 'info', 'ok', 'warn', 'bad', 'neutral']

/**
 * Deterministic panels for the common cases, so a small/cheap model only has to pick a kind and hand over data.
 * kind: table | bar | hbar | line | area | pie | donut | compare | stats | files | steps | log
 */
export function quickSpec({ kind = 'table', title = 'Painel', purpose, data, columns, x, series, unit, note } = {}) {
  const rows = Array.isArray(data) ? data.slice(0, LIMITS.rows) : []
  const spec = { v: 1, title: clip(title, 80), purpose: purpose ? clip(purpose, 200) : undefined, data: {}, state: {}, actions: {} }
  const lead = []
  if (note) lead.push({ type: 'alert', tone: 'info', text: clip(note, 400) })
  const asTable = () => {
    const keys = columns?.length ? columns.map((c) => (typeof c === 'string' ? c : c.key)) : Object.keys(rows.find((r) => r && typeof r === 'object') ?? {}).slice(0, 8)
    return { type: 'table', rows: { ref: 'data.rows' }, columns: keys.map((k) => { const c = columns?.find((x) => x?.key === k); return { key: k, label: c?.label ?? label(k), align: rows.some((r) => typeof r?.[k] === 'number') ? 'right' : 'left', format: c?.format } }), sortable: true, filter: rows.length > 8, pageSize: 25 }
  }
  const chart = (ckind) => {
    const xk = x ?? strKey(rows)
    const sk = (series?.length ? series.map((s) => (typeof s === 'string' ? s : s.key)) : numKeys(rows).filter((k) => k !== xk)).slice(0, 6)
    return { type: 'chart', kind: ckind, data: { ref: 'data.rows' }, x: xk, series: sk.map((k, i) => ({ key: k, label: label(k), tone: TONE_CYCLE[i % TONE_CYCLE.length] })), unit, stacked: false, height: 260 }
  }
  switch (kind) {
    case 'bar': case 'hbar': case 'line': case 'area': case 'pie': case 'donut':
      spec.data.rows = rows
      spec.root = { type: 'stack', children: [...lead, { type: 'tabs', stateKey: 'tab', tabs: [{ id: 'chart', label: 'Gráfico', children: [chart(kind)] }, { id: 'data', label: 'Dados', children: [asTable()] }] }] }
      break
    case 'compare': {
      // Several things measured on the same metrics: headline numbers (best per metric), a grouped chart and the table.
      const xk = x ?? strKey(rows)
      const ms = (series?.length ? series.map((s) => (typeof s === 'string' ? s : s.key)) : numKeys(rows).filter((k) => k !== xk)).slice(0, 6)
      spec.data.rows = rows
      // the unit belongs to the first metric (the one the axis is drawn in); other metrics may measure something else
      const best = ms.map((m, i) => { const top = rows.reduce((a, b) => ((b?.[m] ?? -Infinity) > (a?.[m] ?? -Infinity) ? b : a), rows[0]); return { label: `Maior ${label(m)}`, value: String(top?.[xk] ?? '—'), hint: `${top?.[m] ?? ''}${unit && i === 0 ? ' ' + unit : ''}` } })
      spec.data.best = best
      spec.root = { type: 'stack', children: [...lead, { type: 'grid', cols: Math.min(3, Math.max(1, best.length)), children: best.map((b, i) => ({ type: 'stat', label: { ref: `data.best[${i}].label` }, value: { ref: `data.best[${i}].value` }, hint: undefined, delta: { ref: `data.best[${i}].hint` }, tone: TONE_CYCLE[i % TONE_CYCLE.length] === 'accent' ? 'accent' : 'info' })) }, { type: 'tabs', stateKey: 'tab', tabs: [{ id: 'chart', label: 'Comparação', children: [chart('bar')] }, { id: 'data', label: 'Dados', children: [asTable()] }] }] }
      break
    }
    case 'stats': {
      const items = rows.slice(0, 12)
      spec.data.items = items
      spec.root = { type: 'stack', children: [...lead, { type: 'grid', cols: Math.min(4, Math.max(1, items.length)), children: items.map((it, i) => ({ type: 'stat', label: { ref: `data.items[${i}].label` }, value: { ref: `data.items[${i}].value` }, unit: typeof it?.unit === 'string' ? it.unit : undefined, tone: TONES.includes(it?.tone) ? it.tone : 'neutral' })) }] }
      break
    }
    case 'files': {
      spec.data.files = rows
      spec.data.preview = null
      spec.state = { filter: '' }
      spec.actions = {
        preview: { type: 'tool', tool: 'fs_read', args: { path: { ref: 'row.path' }, maxKB: 24 }, into: 'data.preview', pick: 'data', messages: { loading: 'Lendo…', error: 'Não consegui ler' } },
        remove: { type: 'tool', tool: 'fs_delete', args: { path: { ref: 'row.path' } }, refresh: [], messages: { ok: 'Enviado para a Lixeira' }, setState: {} },
      }
      spec.root = { type: 'stack', children: [...lead, { type: 'files', items: { ref: 'data.files' }, filter: true, itemActions: [{ label: 'Ver', action: 'preview' }, { label: 'Apagar', action: 'remove', tone: 'bad' }], empty: 'Nenhum arquivo encontrado.' }, { type: 'card', title: 'Pré-visualização', show: { ref: 'data.preview' }, children: [{ type: 'text', text: { ref: 'data.preview.text' }, variant: 'code' }] }] }
      break
    }
    case 'steps':
      spec.data.items = rows
      spec.root = { type: 'stack', children: [...lead, { type: 'steps', items: { ref: 'data.items' } }] }
      break
    case 'log':
      spec.data.lines = Array.isArray(data) ? data.slice(-1000) : []
      spec.root = { type: 'stack', children: [...lead, { type: 'log', lines: { ref: 'data.lines' }, follow: true }] }
      break
    default: // table
      spec.data.rows = rows
      spec.root = { type: 'stack', children: [...lead, asTable()] }
  }
  if (!Object.keys(spec.actions).length) delete spec.actions
  if (!Object.keys(spec.state).length) delete spec.state
  return spec
}

/** Template for a mission: bound to the LIVE mission view, so it updates as the mission runs. */
export function missionSpec(missionId, goal) {
  return {
    v: 1, title: `Missão: ${clip(goal, 60)}`, purpose: 'Acompanhamento ao vivo: plano, etapas, agentes, consumo e confirmações.',
    sources: { mission: { kind: 'mission', id: missionId, everySec: 3 } },
    actions: { cancel: { type: 'missionop', op: 'cancel' }, approve: { type: 'missionop', op: 'confirm', approve: true }, deny: { type: 'missionop', op: 'confirm', approve: false }, resume: { type: 'missionop', op: 'resume' } },
    root: { type: 'stack', gap: 'md', children: [
      { type: 'grid', cols: 4, children: [
        { type: 'stat', label: 'Estado', value: { ref: 'data.mission.status' }, hint: { ref: 'data.mission.phase' }, tone: 'accent' },
        { type: 'stat', label: 'Tokens', value: { ref: 'data.mission.usageTotal' }, hint: 'entrada + saída' },
        { type: 'stat', label: 'Chamadas a modelos', value: { ref: 'data.mission.usage.calls' } },
        { type: 'stat', label: 'Replanejamentos', value: { ref: 'data.mission.replans' } },
      ] },
      { type: 'progress', label: 'Etapas concluídas', value: { ref: 'data.mission.doneCount' }, max: { ref: 'data.mission.stepCount' }, tone: 'ok' },
      { type: 'alert', tone: 'warn', title: 'Aguardando você', text: { ref: 'data.mission.pending[0].message' }, show: { ref: 'data.mission.pending[0].message' } },
      { type: 'stack', dir: 'h', show: { ref: 'data.mission.pending[0].message' }, children: [{ type: 'button', label: 'Autorizar', action: 'approve', tone: 'ok' }, { type: 'button', label: 'Negar', action: 'deny', tone: 'bad' }] },
      { type: 'tabs', stateKey: 'tab', tabs: [
        { id: 'plan', label: 'Plano', children: [{ type: 'steps', items: { ref: 'data.mission.steps' } }] },
        { id: 'log', label: 'Registro', children: [{ type: 'log', lines: { ref: 'data.mission.logLines' }, follow: true }] },
        { id: 'result', label: 'Resultado', children: [{ type: 'alert', tone: 'info', title: 'Verificação independente', text: { ref: 'data.mission.verification.text' }, show: { ref: 'data.mission.verification.text' } }, { type: 'text', text: { ref: 'data.mission.final.text' } }, { type: 'empty', text: 'A missão ainda não terminou.', show: { ref: 'data.mission.running' } }] },
      ] },
      { type: 'stack', dir: 'h', children: [{ type: 'button', label: 'Cancelar missão', action: 'cancel', tone: 'bad', show: { ref: 'data.mission.running' } }, { type: 'button', label: 'Retomar', action: 'resume', show: { ref: 'data.mission.canResume' } }] },
    ] },
  }
}

/** Flatten a mission view into what the template binds to (counts, log lines, flags). */
function missionData(v) {
  const steps = (v.steps ?? []).map((s) => ({ ...s, detail: s.summary ?? s.notes?.join(' · ') ?? '' }))
  return {
    ...v, steps,
    usageTotal: (v.usage?.inputTokens ?? 0) + (v.usage?.outputTokens ?? 0),
    doneCount: steps.filter((s) => s.status === 'done' || s.status === 'replaced').length, stepCount: steps.length,
    logLines: (v.log ?? []).map((l) => ({ t: l.at, level: l.kind, text: l.text })),
    running: ['planning', 'running', 'verifying', 'awaiting'].includes(v.status), canResume: ['interrupted', 'awaiting'].includes(v.status),
  }
}

/** Live system dashboard: bound to the monitor (CPU/RAM history and disks measured by the bridge). */
export function systemSpec() {
  return {
    v: 1, title: 'Sistema ao vivo', purpose: 'CPU, memória e discos medidos agora pelo JARVIS; atualiza sozinho.',
    sources: { m: { kind: 'monitor', everySec: 5 } },
    root: { type: 'stack', gap: 'md', children: [
      { type: 'grid', cols: 4, children: [
        { type: 'stat', label: 'CPU', value: { ref: 'data.m.summary.cpu.usagePct' }, unit: '%', tone: 'accent', hint: { ref: 'data.m.summary.cpu.model' } },
        { type: 'stat', label: 'Memória', value: { ref: 'data.m.summary.memory.usedPct' }, unit: '%', tone: 'info', hint: '{{data.m.summary.memory.usedGB}} de {{data.m.summary.memory.totalGB}} GB' },
        { type: 'stat', label: 'RAM livre', value: { ref: 'data.m.summary.memory.freeGB' }, unit: 'GB', tone: 'ok' },
        { type: 'stat', label: 'Ligado há', value: { ref: 'data.m.summary.uptimeHours' }, unit: 'h' },
      ] },
      { type: 'tabs', stateKey: 'tab', tabs: [
        { id: 'hist', label: 'Histórico', children: [{ type: 'chart', kind: 'area', data: { ref: 'data.m.history' }, x: 'hora', series: [{ key: 'cpu', label: 'CPU %', tone: 'accent' }, { key: 'ram', label: 'RAM %', tone: 'info' }], unit: '%', height: 260 }] },
        { id: 'disks', label: 'Discos', children: [
          { type: 'chart', kind: 'hbar', data: { ref: 'data.m.disks' }, x: 'drive', series: [{ key: 'usedGB', label: 'Usado (GB)', tone: 'warn' }, { key: 'freeGB', label: 'Livre (GB)', tone: 'ok' }], stacked: true, unit: 'GB' },
          { type: 'table', rows: { ref: 'data.m.disks' }, columns: [{ key: 'drive', label: 'Unidade' }, { key: 'label', label: 'Nome' }, { key: 'totalGB', label: 'Total', format: 'gb', align: 'right' }, { key: 'freeGB', label: 'Livre', format: 'gb', align: 'right' }, { key: 'freePct', label: 'Livre %', format: 'percent', align: 'right' }], sortable: true },
        ] },
      ] },
      { type: 'stack', dir: 'h', children: [{ type: 'button', label: 'Atualizar agora', action: 'refresh' }, { type: 'button', label: 'Pedir análise de espaço ao JARVIS', action: 'analisar' }] },
    ] },
    actions: { refresh: { type: 'refresh' }, analisar: { type: 'ask', text: 'Analise o espaço em disco, me diga o que ocupa mais e sugira o que posso apagar, com tamanhos.' } },
  }
}

/** File finder: a search form wired to fs_search; rows can be previewed or sent to the Recycle Bin (with confirmation). */
export function filesSpec(root = '') {
  return {
    v: 1, title: 'Arquivos', purpose: 'Procure arquivos nas pastas liberadas e aja sobre eles. Tudo passa pelas permissões do Agente.',
    state: { root, q: '' }, data: { found: [], preview: null },
    actions: {
      search: { type: 'tool', tool: 'fs_search', args: { root: { ref: 'state.root' }, name: { ref: 'state.q' }, max: 100 }, into: 'data.found', pick: 'data.results', messages: { loading: 'Procurando…', error: 'A busca falhou' } },
      preview: { type: 'tool', tool: 'fs_read', args: { path: { ref: 'row.path' }, maxKB: 24 }, into: 'data.preview', pick: 'data', messages: { error: 'Não consegui ler' } },
      remove: { type: 'tool', tool: 'fs_delete', args: { path: { ref: 'row.path' } }, messages: { ok: 'Enviado para a Lixeira' } },
    },
    root: { type: 'stack', gap: 'md', children: [
      { type: 'form', fields: [{ name: 'root', label: 'Pasta', kind: 'path', required: true, placeholder: 'C:\\pasta\\liberada' }, { name: 'q', label: 'Nome contém', kind: 'text', required: true }], submit: { label: 'Procurar', action: 'search', tone: 'accent' } },
      { type: 'files', items: { ref: 'data.found' }, filter: true, itemActions: [{ label: 'Ver', action: 'preview' }, { label: 'Apagar', action: 'remove', tone: 'bad' }], empty: 'Nada encontrado ainda: preencha a pasta e o nome.' },
      { type: 'card', title: 'Pré-visualização', show: { ref: 'data.preview' }, children: [{ type: 'text', text: { ref: 'data.preview.text' }, variant: 'code' }] },
    ] },
  }
}
// ------------------------------------------------------------------------------------------------ component catalog
/** Compact catalogue for models (also returned by the ui_catalog tool). */
export const CATALOG = `Painéis são JSON declarativo (v:1). Estrutura: {"v":1,"title","purpose","state":{},"data":{},"sources":{},"actions":{},"root":<nó>}.
Valores podem ser literais ou ligações {"ref":"data.x"} / {"ref":"state.x"} / {"ref":"row.x"}; em textos use {{data.x}}.
Nós (type): layout stack{children,dir:h|v,gap}, grid{cols 1-6,children}, split{children[2],ratio}, tabs{tabs:[{id,label,children}],stateKey}, card{title,subtitle,children,tone};
exibição text{text,variant:body|title|caption|code,tone}, stat{label,value,unit,delta,tone,hint}, kv{items:[{k,v}]}, alert{tone,title,text}, progress{value,max,label,tone}, steps{items:[{title,status:pending|running|done|failed,detail}]}, empty{text};
dados table{columns:[{key,label,format:number|bytes|percent|date|duration|mb|gb,align}],rows,sortable,filter,pageSize,rowActions:[{label,action,params,tone}]}, list{items,titleKey,subtitleKey,badgeKey,itemActions}, chart{kind:bar|hbar|line|area|pie|donut|spark,data,x,series:[{key,label,tone}],unit,stacked,height}, log{lines,follow}, files{items:[{path,name,sizeKB,modified,type}],itemActions,filter}, results{items:[{title,url,snippet}]};
controles form{fields:[{name,label,kind:text|number|select|toggle|slider|textarea|path,options,min,max,step,required,pattern,default}],submit:{label,action}}, control{field,onChange}, button{label,action,params,tone,confirm}.
Qualquer nó aceita show:{ref,eq|ne|gt|lt} (condição) e loading/error. tone: ${TONES.join('|')}.
sources (dados vivos, só ferramentas de LEITURA): {"disks":{"kind":"tool","tool":"disk_report","everySec":10,"pick":"data.disks"}} | {"kind":"monitor"} | {"kind":"mission","id":"…"}.
actions: {"id":{"type":"tool","tool":"fs_search","args":{"root":{"ref":"state.root"},"name":{"ref":"state.q"}},"into":"data.found","pick":"data.results"}} | {"type":"state","set":{"tab":"x"}} | {"type":"ask","text":"…"} | {"type":"mission","goal":"…"} | {"type":"refresh","sources":["disks"]} | {"type":"close"}.
Ações com ferramentas passam pelas permissões e confirmações do JARVIS; nunca invente ferramentas. Prefira ui_quick para tabelas, gráficos, comparações e listas de arquivos simples.`

const GENERATE_SYSTEM = () => `Você projeta painéis para o JARVIS. Responda SOMENTE com um JSON de especificação (sem texto fora dele).\n${CATALOG}\nRegras: use só os tipos acima; dados reais vão em "data" (ou em "sources"); cada botão/formulário precisa de uma ação em "actions"; poucos componentes bem organizados (máx. 40); inclua alert/empty para estados de erro e ausência de dados quando fizer sentido; não use HTML nem código.`

// ------------------------------------------------------------------------------------------------ the store
export function createGenUi({ tools, access, flags = null, router = null, missions = null, monitor = null, audit = null, dir = null, clock = Date.now } = {}) {
  const panels = new Map()
  let loaded = !dir
  let chain = Promise.resolve()
  const inflight = new Set()

  const toolOk = (name, { readOnly = false } = {}) => {
    const t = Object.hasOwn(tools, name) ? tools[name] : null
    if (!t) return `ferramenta desconhecida: ${name}`
    if (BANNED_TOOLS.has(name)) return `a ferramenta ${name} não pode ser usada por painéis`
    if (name.startsWith('ui_')) return 'painéis não podem criar painéis'
    if (readOnly && t.risk !== 'read') return `fontes de dados só podem usar ferramentas de leitura (${name} é ${t.risk})`
    return null
  }

  /** Beyond structure: every tool a spec names must exist, be allowed, and sources must be read-only. */
  function checkTools(spec) {
    const errs = []
    for (const [k, s] of Object.entries(spec.sources ?? {})) if (s.kind === 'tool') { const e = toolOk(s.tool, { readOnly: true }); if (e) errs.push({ path: `sources.${k}.tool`, msg: e }) }
    for (const [k, a] of Object.entries(spec.actions ?? {})) if (a.type === 'tool') { const e = toolOk(a.tool); if (e) errs.push({ path: `actions.${k}.tool`, msg: e }) }
    return errs
  }

  const persistFile = (p) => join(dir, `${p.id}.json`)
  const save = (p) => {
    if (!dir || !p.pinned) return Promise.resolve()
    chain = chain.then(async () => {
      await mkdir(dir, { recursive: true })
      const f = persistFile(p)
      await writeFile(`${f}.tmp`, JSON.stringify({ id: p.id, name: p.name, spec: p.spec, state: p.state ?? {}, pinnedAt: p.pinnedAt, owner: p.owner }, null, 2), 'utf8')
      await rename(`${f}.tmp`, f)
    }).catch(() => {})
    return chain
  }
  async function ready() {
    if (loaded) return
    loaded = true
    try {
      for (const f of (await readdir(dir)).filter((n) => n.endsWith('.json'))) {
        try {
          const j = JSON.parse((await readFile(join(dir, f), 'utf8')).replace(/^﻿/, ''))
          const v = validateSpec(j.spec)
          if (!v.ok || checkTools(v.spec).length) continue // a saved panel that no longer validates is skipped, never rendered half-broken
          panels.set(j.id, newPanel(v.spec, { id: j.id, owner: j.owner ?? { kind: 'user' }, pinned: true, name: j.name, pinnedAt: j.pinnedAt }))
        } catch { /* corrupt file */ }
      }
    } catch { /* no saved panels yet */ }
  }

  function newPanel(spec, { id = randomUUID().slice(0, 12), owner = { kind: 'agent' }, pinned = false, name, pinnedAt, trusted = false } = {}) {
    const t = now(clock)
    return { id, name: name ?? spec.title, spec, specRev: 1, data: structuredClone(spec.data ?? {}), dataRev: Object.fromEntries(Object.keys(spec.data ?? {}).map((k) => [k, 1])), status: spec.status ?? 'ready', statusText: '', state: structuredClone(spec.state ?? {}), stateRev: 1, pinned, pinnedAt, owner, trusted, createdAt: t, updatedAt: t, srcMeta: {}, rate: [], busy: 0 }
  }
  const touch = (p) => { p.updatedAt = now(clock) }
  const bump = (p, name) => { p.dataRev[name] = (p.dataRev[name] ?? 0) + 1; touch(p) }

  function evict() {
    if (panels.size < MAX_PANELS) return
    const victim = [...panels.values()].filter((p) => !p.pinned).sort((a, b) => (a.updatedAt < b.updatedAt ? -1 : 1))[0]
    if (victim) panels.delete(victim.id)
  }

  const api = {
    CATALOG,
    ready,
    /** Validate and register a panel. Returns {ok, id, errors, warnings}. */
    async create(input, opts = {}) {
      await ready()
      const v = validateSpec(input)
      const extra = v.ok ? checkTools(v.spec) : []
      if (!v.ok || extra.length) return { ok: false, errors: [...v.errors, ...extra], warnings: v.warnings, message: explain([...v.errors, ...extra]) }
      evict()
      if (panels.size >= MAX_PANELS) return { ok: false, errors: [{ path: '', msg: `limite de ${MAX_PANELS} painéis abertos` }], warnings: [] }
      const p = newPanel(v.spec, opts)
      panels.set(p.id, p)
      audit?.record('ui.create', { id: p.id, title: clip(p.spec.title, 60), owner: p.owner.kind })
      return { ok: true, id: p.id, warnings: v.warnings }
    },
    quick(args, opts) { return api.create(quickSpec(args), opts) },
    /** Ready-made panels bound to real data: 'sistema' (live monitor) and 'arquivos' (finder over the granted folders). */
    async template(name, opts = { owner: { kind: 'user' } }) {
      if (name === 'sistema') return api.create(systemSpec(), { ...opts, trusted: true })
      if (name === 'arquivos') return api.create(filesSpec(access.snapshot().roots[0]?.path ?? ''), opts)
      return { ok: false, errors: [{ path: 'name', msg: 'modelo desconhecido (sistema | arquivos)' }] }
    },
    /** Mission panel: bound to the live mission view, trusted (its buttons drive that mission only). */
    forMission(missionId, goal) { return api.create(missionSpec(missionId, goal), { owner: { kind: 'mission', id: missionId }, trusted: true }) },

    /** Incremental updates: data, status, nodes, state. The spec is re-validated after structural ops, so a bad patch changes nothing. */
    async update(id, ops) {
      await ready()
      const p = panels.get(id)
      if (!p) return { ok: false, errors: [{ path: '', msg: 'painel não existe' }] }
      if (!Array.isArray(ops) || !ops.length || ops.length > 50) return { ok: false, errors: [{ path: 'ops', msg: 'envie de 1 a 50 operações' }] }
      const errors = []
      const draft = { spec: structuredClone(p.spec), data: p.data, specChanged: false, dataChanged: new Set(), stateOps: {}, status: null }
      const findNode = (n, nid, parent = null) => {
        if (!n || typeof n !== 'object') return null
        if (n.id === nid) return { node: n, parent }
        for (const c of [...(n.children ?? []), ...(n.tabs ?? []).flatMap((t) => t.children ?? [])]) { const r = findNode(c, nid, n); if (r) return r }
        return null
      }
      const listOf = (par) => par.children ?? null
      for (const [i, op] of ops.entries()) {
        const at = `ops[${i}]`
        try {
          switch (op?.op) {
            case 'setData': { const name = String(op.name); if (!setData(draft.data, `data.${name}`, op.value)) throw new Error('nome de dado inválido'); draft.dataChanged.add(name.split('.')[0]); break }
            case 'appendData': { const name = String(op.name); if (!setData(draft.data, `data.${name}`, op.value, { append: true })) throw new Error('nome de dado inválido'); const top = name.split('.')[0]; if (Array.isArray(draft.data[top]) && draft.data[top].length > 1000) draft.data[top] = draft.data[top].slice(-1000); draft.dataChanged.add(top); break }
            case 'setStatus': { if (!['loading', 'ready', 'error', 'done'].includes(op.status)) throw new Error('status inválido'); draft.status = { status: op.status, text: clip(op.text ?? '', 200) }; break }
            case 'setState': { if (!op.values || typeof op.values !== 'object') throw new Error('values inválido'); Object.assign(draft.stateOps, Object.fromEntries(Object.entries(op.values).filter(([k, v]) => /^[\w.-]{1,40}$/.test(k) && ['string', 'number', 'boolean'].includes(typeof v) || Array.isArray(v)))); break }
            case 'setTitle': { draft.spec.title = clip(op.title, 80); draft.specChanged = true; break }
            case 'patchNode': { const r = findNode(draft.spec.root, op.id); if (!r) throw new Error(`nó não encontrado: ${op.id}`); const { type: _t, id: _i, children: _c, tabs: _tb, ...props } = op.props ?? {}; Object.assign(r.node, props); draft.specChanged = true; break }
            case 'addNode': {
              const r = findNode(draft.spec.root, op.parent)
              const list = r && listOf(r.node)
              if (!list) throw new Error(`pai inválido: ${op.parent} (precisa ter filhos)`)
              list.splice(Number.isInteger(op.index) ? Math.max(0, Math.min(op.index, list.length)) : list.length, 0, op.node)
              draft.specChanged = true
              break
            }
            case 'removeNode': { const r = findNode(draft.spec.root, op.id); if (!r?.parent) throw new Error(`nó não removível: ${op.id}`); const list = listOf(r.parent); if (!list) throw new Error('nó dentro de abas: use patchNode'); list.splice(list.indexOf(r.node), 1); draft.specChanged = true; break }
            case 'addAction': { if (!/^[\w.-]{1,40}$/.test(String(op.id))) throw new Error('id de ação inválido'); draft.spec.actions = { ...(draft.spec.actions ?? {}), [op.id]: op.action }; draft.specChanged = true; break }
            case 'addSource': { if (!/^[\w.-]{1,40}$/.test(String(op.name))) throw new Error('nome de fonte inválido'); draft.spec.sources = { ...(draft.spec.sources ?? {}), [op.name]: op.source }; draft.specChanged = true; break }
            default: throw new Error(`operação desconhecida: ${String(op?.op).slice(0, 20)}`)
          }
        } catch (e) { errors.push({ path: at, msg: e.message }) }
      }
      if (errors.length) return { ok: false, errors }
      if (bytes(draft.data) > MAX_DATA_BYTES) return { ok: false, errors: [{ path: 'data', msg: `dados maiores que ${MAX_DATA_BYTES} bytes` }] }
      if (draft.specChanged) {
        const v = validateSpec(draft.spec)
        const extra = v.ok ? checkTools(v.spec) : []
        if (!v.ok || extra.length) return { ok: false, errors: [...v.errors, ...extra], message: explain([...v.errors, ...extra]) }
        p.spec = v.spec
        p.specRev++
      }
      for (const name of draft.dataChanged) bump(p, name)
      if (Object.keys(draft.stateOps).length) { p.stateOps = { ...(p.stateOps ?? {}), ...draft.stateOps }; p.stateRev++ }
      if (draft.status) { p.status = draft.status.status; p.statusText = draft.status.text }
      touch(p)
      return { ok: true, specRev: p.specRev, changedData: [...draft.dataChanged] }
    },

    /** What the renderer polls: only what changed since the revisions it already has. Refreshes stale live sources first. */
    async view(id, since = {}, { force = false } = {}) {
      await ready()
      const p = panels.get(id)
      if (!p) return null
      await refreshSources(p, force)
      const dataChanged = {}
      for (const [name, rev] of Object.entries(p.dataRev)) if ((since.data?.[name] ?? 0) < rev && name in p.data) dataChanged[name] = { rev, value: p.data[name] }
      return {
        id: p.id, name: p.name, status: p.status, statusText: p.statusText, pinned: p.pinned, owner: p.owner, trusted: p.trusted, updatedAt: p.updatedAt,
        specRev: p.specRev, spec: (since.specRev ?? 0) < p.specRev ? p.spec : undefined,
        data: dataChanged, sources: p.srcMeta,
        stateOps: (since.stateRev ?? 0) < p.stateRev && p.stateOps ? { rev: p.stateRev, values: p.stateOps } : undefined,
        stateRev: p.stateRev,
      }
    },
    async list() {
      await ready()
      const cutoff = clock() - 24 * 3600_000
      for (const [id, p] of panels) if (!p.pinned && Date.parse(p.updatedAt) < cutoff) panels.delete(id)
      return [...panels.values()].sort((a, b) => (a.updatedAt < b.updatedAt ? 1 : -1)).map((p) => ({ id: p.id, title: p.spec.title, purpose: p.spec.purpose ?? null, status: p.status, pinned: p.pinned, owner: p.owner, createdAt: p.createdAt, updatedAt: p.updatedAt, specRev: p.specRev }))
    },
    async close(id) {
      await ready()
      const p = panels.get(id)
      if (!p) return false
      panels.delete(id)
      if (dir && p.pinned) await rm(persistFile(p), { force: true }).catch(() => {})
      audit?.record('ui.close', { id })
      return true
    },
    /** Pin: keep this panel across restarts (spec + control state; data is fetched fresh from its sources). */
    async pin(id, name) {
      await ready()
      const p = panels.get(id)
      if (!p) return false
      p.pinned = true; p.pinnedAt = now(clock); if (name) p.name = clip(name, 80)
      await save(p)
      return true
    },
    async unpin(id) {
      const p = panels.get(id)
      if (!p) return false
      p.pinned = false
      if (dir) await rm(persistFile(p), { force: true }).catch(() => {})
      return true
    },
    /** The renderer reports control state so a pinned panel reopens as the owner left it. */
    async saveState(id, state) {
      const p = panels.get(id)
      if (!p || !state || typeof state !== 'object' || bytes(state) > 20_000) return false
      p.state = Object.fromEntries(Object.entries(state).filter(([k, v]) => /^[\w.-]{1,40}$/.test(k) && (['string', 'number', 'boolean'].includes(typeof v) || Array.isArray(v))))
      if (p.pinned) await save(p)
      return true
    },

    /**
     * Run an action declared in the spec. Tool actions go through the SAME rules as the agent: tool must exist, its group
     * must be on, anything that changes something asks for confirmation showing the real tool and arguments (the button
     * label is never trusted), and the tool validates its own parameters and paths.
     */
    async action(id, actionId, { state = {}, row = null, form = null, confirmed = false } = {}) {
      await ready()
      const p = panels.get(id)
      if (!p) return { ok: false, code: 'no_panel', error: 'o painel não existe mais' }
      const a = p.spec.actions?.[actionId]
      if (!a) return { ok: false, code: 'no_action', error: `ação desconhecida: ${String(actionId).slice(0, 40)}` }
      const t = clock()
      p.rate = p.rate.filter((x) => t - x < 1000)
      if (p.rate.length >= 5 || p.busy >= 3) return { ok: false, code: 'rate', error: 'muitas ações seguidas; espere um instante' }
      p.rate.push(t)
      const scope = { data: p.data, state: { ...p.state, ...(state && typeof state === 'object' ? state : {}) }, row: row && typeof row === 'object' ? row : undefined, form: form && typeof form === 'object' ? form : undefined }

      if (a.type === 'state' || a.type === 'close') return { ok: true, client: true }
      if (a.type === 'ask') return { ok: true, ask: resolveArgs(a.text, scope) }
      if (a.type === 'refresh') { for (const s of a.sources?.length ? a.sources : Object.keys(p.spec.sources ?? {})) await refreshSource(p, s, { force: true }); return { ok: true, refreshed: true } }
      if (a.type === 'missionop') {
        const mid = p.owner.kind === 'mission' ? p.owner.id : null
        if (!mid || !missions) return { ok: false, code: 'forbidden', error: 'este painel não controla uma missão' }
        if (a.op === 'confirm' && !p.trusted) return { ok: false, code: 'forbidden', error: 'só o painel da própria missão pode autorizar confirmações' }
        if (a.op === 'cancel') return { ok: true, result: { ok: await missions.cancel(mid) } }
        if (a.op === 'resume') { await missions.resume(mid); return { ok: true } }
        if (a.op === 'confirm') return { ok: true, result: { confirmed: missions.confirm(mid, a.approve === true) } }
        return { ok: false, code: 'bad_op', error: 'operação desconhecida' }
      }
      if (a.type === 'mission') {
        const goal = String(resolveArgs(a.goal, scope) ?? '')
        if (!confirmed) return { ok: false, needsConfirm: true, message: `Iniciar uma missão com este objetivo? "${clip(goal, 300)}"`, tool: 'mission' }
        if (!missions) return { ok: false, code: 'unavailable', error: 'missões indisponíveis' }
        const r = await missions.start({ goal })
        audit?.record('ui.action', { panel: p.id, action: actionId, type: 'mission' })
        return { ok: true, result: r }
      }
      if (a.type !== 'tool') return { ok: false, code: 'bad_action', error: 'tipo de ação não executável' }

      const bad = toolOk(a.tool)
      if (bad) return { ok: false, code: 'forbidden', error: bad }
      const tool = tools[a.tool]
      if (!access.allows(tool.group)) return { ok: false, code: 'group_off', error: `o grupo "${tool.group}" está desligado na tela Agente` }
      const args = resolveArgs(a.args ?? {}, scope) ?? {}
      let message = null
      try { message = tool.confirm ? await tool.confirm(args) : null } catch (e) { return { ok: false, code: 'invalid', error: String(e?.message ?? e).slice(0, 300) } }
      // model-authored panels: anything that is not a plain read always asks, even when the tool itself would not
      const needs = tool.risk === 'danger' || message !== null || (tool.risk !== 'read' && !p.trusted)
      if (needs && !confirmed) return { ok: false, needsConfirm: true, tool: a.tool, args, message: message ?? `Executar ${a.tool} com ${clip(JSON.stringify(args), 300)}?` }
      p.busy++
      try {
        const r = await tool.run(args)
        let stored = false
        if (a.into) {
          const append = a.into.endsWith('+')
          const target = a.into.replace(/\+$/, '')
          const value = pick({ data: r.data, evidence: r.evidence, verified: r.verified }, a.pick) ?? r.data
          if (setData(p.data, target, value, { append }) && bytes(p.data) <= MAX_DATA_BYTES) { bump(p, target.split('.')[1]); stored = true } else return { ok: false, code: 'too_big', error: 'o resultado não cabe nos dados do painel' }
        }
        for (const s of a.refresh ?? []) await refreshSource(p, s, { force: true })
        audit?.record('ui.action', { panel: p.id, action: actionId, tool: a.tool, ok: true, verified: r.verified ?? null })
        return { ok: true, stored, verified: r.verified ?? null, evidence: r.evidence ?? null, summary: clip(JSON.stringify(r.data ?? {}), 300), setState: a.setState ? resolveArgs(a.setState, scope) : undefined, message: a.messages?.ok }
      } catch (e) {
        audit?.record('ui.action', { panel: p.id, action: actionId, tool: a.tool, ok: false })
        return { ok: false, code: 'tool_error', error: redactString(String(e?.message ?? e)).slice(0, 300) }
      } finally { p.busy-- }
    },

    /**
     * Ask the router for a panel. Cheap deterministic path first when the data is already tabular and the kind is
     * obvious; otherwise a model writes the spec (cheap tier unless spending is allowed), with ONE repair round that
     * shows it the validation errors, and a last-resort deterministic panel so the user never gets nothing.
     */
    async generate({ prompt, data, hint, title, sensitive = false, confirmSpend = false, owner } = {}) {
      await ready()
      const kinds = ['table', 'bar', 'hbar', 'line', 'area', 'pie', 'donut', 'compare', 'stats', 'files', 'steps', 'log']
      if (Array.isArray(data) && data.length && kinds.includes(hint)) {
        const r = await api.quick({ kind: hint, title: title ?? clip(prompt, 60), data, purpose: clip(prompt, 200) }, { owner })
        if (r.ok) return { ...r, via: 'rules' }
      }
      if (!router) return { ok: false, errors: [{ path: '', msg: 'sem roteador de IA para gerar o painel' }] }
      const userMsg = `PEDIDO: ${clip(prompt, 1500)}${data !== undefined ? `\nDADOS (use em "data"):\n${clip(JSON.stringify(data), 6000)}` : ''}${hint ? `\nTIPO SUGERIDO: ${hint}` : ''}`
      let spec = null
      let msgs = [{ role: 'user', content: userMsg }]
      for (let attempt = 0; attempt < 2; attempt++) {
        let r
        try {
          r = await router.run({ system: GENERATE_SYSTEM(), messages: msgs, capability: 'chat', fast: true, sensitive, confirmSpend, maxTokens: 2500, tier: confirmSpend ? 'strong' : 'cheap' })
        } catch (e) {
          // No AI could answer (quota, paused, paid without permission): with data in hand the owner still gets a table; otherwise the reason, in words.
          if (Array.isArray(data) && data.length) { const q = await api.quick({ kind: 'table', title: title ?? clip(prompt, 60), data, note: 'Painel simplificado: nenhuma IA estava disponível para montar uma interface melhor.' }, { owner }); if (q.ok) return { ...q, via: 'fallback' } }
          return { ok: false, errors: [{ path: '', msg: String(e?.message ?? e).slice(0, 600) }] }
        }
        spec = extractJson(r.text)
        const v = spec ? validateSpec(spec) : { ok: false, errors: [{ path: '', msg: 'a resposta não foi um JSON' }] }
        const extra = v.ok ? checkTools(v.spec) : []
        if (v.ok && !extra.length) { const c = await api.create(v.spec, { owner }); return { ...c, via: attempt ? 'model-repaired' : 'model', provider: r.provider } }
        msgs = [...msgs, { role: 'assistant', content: clip(r.text, 3000) }, { role: 'user', content: `A especificação é inválida. Corrija e responda SOMENTE com o JSON completo.\n${explain([...(v.errors ?? []), ...extra])}` }]
      }
      if (Array.isArray(data) && data.length) { const r = await api.quick({ kind: 'table', title: title ?? clip(prompt, 60), data, note: 'Painel simplificado: o modelo não conseguiu montar a interface pedida.' }, { owner }); if (r.ok) return { ...r, via: 'fallback' } }
      return { ok: false, errors: [{ path: '', msg: 'não consegui gerar um painel válido para este pedido' }] }
    },
  }

  // ------------------------------------------------------------------------------------------ live data sources
  async function refreshSource(p, name, { force = false } = {}) {
    const s = p.spec.sources?.[name]
    if (!s) return
    const key = `${p.id}:${name}`
    const meta = (p.srcMeta[name] ??= { ok: null, at: null, error: null })
    const every = (s.everySec ?? (s.kind === 'mission' ? 3 : 10)) * 1000
    if (!force && meta.at && clock() - meta.at < every) return
    if (inflight.has(key)) return
    inflight.add(key)
    try {
      let value
      if (s.kind === 'tool') {
        const bad = toolOk(s.tool, { readOnly: true })
        if (bad) throw new Error(bad)
        const tool = tools[s.tool]
        if (!access.allows(tool.group)) throw new Error(`o grupo "${tool.group}" está desligado na tela Agente`)
        const r = await Promise.race([tool.run(resolveArgs(s.args ?? {}, { data: p.data, state: p.state }) ?? {}), new Promise((_, rej) => setTimeout(() => rej(new Error('a fonte demorou demais')), 15_000))])
        value = pick({ data: r.data }, s.pick) ?? r.data
      } else if (s.kind === 'mission') {
        if (!missions) throw new Error('missões indisponíveis')
        const v = await missions.view(s.id)
        if (!v) throw new Error('missão não encontrada')
        value = missionData(v)
      } else if (s.kind === 'monitor') {
        if (!monitor) throw new Error('monitor indisponível')
        // history as {hora, cpu, ram} so a chart can use it directly (epoch milliseconds make poor axis labels)
        value = { summary: monitor.summary(), history: monitor.history().slice(-60).map((h) => ({ hora: new Date(h.t).toLocaleTimeString('pt-BR'), cpu: h.cpu ?? 0, ram: h.memUsedPct })), disks: await monitor.disks().catch(() => []) }
      }
      if (JSON.stringify(value) !== JSON.stringify(p.data[name])) { p.data[name] = value; bump(p, name) }
      meta.ok = true; meta.error = null
    } catch (e) {
      meta.ok = false; meta.error = redactString(String(e?.message ?? e)).slice(0, 200)
    } finally {
      meta.at = clock()
      inflight.delete(key)
    }
  }
  async function refreshSources(p, force = false) { await Promise.all(Object.keys(p.spec.sources ?? {}).map((n) => refreshSource(p, n, { force }))) }

  return api
}

export { NODE_TYPES, getRef }
