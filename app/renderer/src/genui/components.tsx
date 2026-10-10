import { Component, useEffect, useMemo, useRef, useState, type ErrorInfo, type ReactNode } from 'react'
import { AlertTriangle, Check, CircleDashed, ExternalLink, FileText, Folder, Info, Loader2, Search, SkipForward, X, ChevronDown, ChevronUp } from 'lucide-react'
import { evalCond, interpolate, resolve, resolveArgs, type Scope } from '../../../../shared/genui/resolve.mjs'
import { Chart, TONE_COLOR } from './charts.tsx'
import { fmt, fmtNumber, type Format } from './format.ts'
import { coerce, filterRows, initialFieldValue, sortRows, validateField, type FieldDef, type PanelState, type SortDir, type StateValue } from './state.ts'

/**
 * The fixed component library of generative panels. A spec can only NAME these components; it can never bring its own
 * markup or code. Every string is rendered as text (React escapes it), links must be http(s), colours come from tones.
 */
type Row = Record<string, unknown>
// eslint-disable-next-line @typescript-eslint/no-explicit-any
type N = any

export interface RunOpts { row?: Row; form?: Row; confirm?: string }
export interface Ctx {
  scope: Scope
  state: PanelState
  setState: (k: string, v: StateValue) => void
  run: (action: string, o?: RunOpts) => void
  busy: string | null
  loading: boolean
}

const asRows = (v: unknown): Row[] => (Array.isArray(v) ? (v.filter((x) => x && typeof x === 'object') as Row[]) : [])
const txt = (v: unknown, scope: Scope): string => {
  const r = resolve(v, scope)
  return typeof r === 'string' ? interpolate(r, scope) : r === null || r === undefined ? '' : typeof r === 'object' ? JSON.stringify(r) : String(r)
}
const tone = (t: unknown) => (typeof t === 'string' && t in TONE_COLOR ? t : 'neutral')

class NodeBoundary extends Component<{ type: string; children: ReactNode }, { err: string | null }> {
  state = { err: null as string | null }
  static getDerivedStateFromError(e: Error) { return { err: e.message } }
  componentDidCatch(_e: Error, _i: ErrorInfo) { /* shown inline, the rest of the panel keeps working */ }
  render() { return this.state.err ? <div className="gu-node-error" role="alert"><AlertTriangle size={14} /> O componente “{this.props.type}” falhou: {this.state.err}</div> : this.props.children }
}

export function Render({ node, ctx }: { node: N; ctx: Ctx }) {
  if (!node || typeof node !== 'object') return null
  if (!evalCond(node.show, ctx.scope)) return null
  const err = node.error !== undefined ? txt(node.error, ctx.scope) : ''
  if (err) return <div className="gu-alert" data-tone="bad" role="alert"><AlertTriangle size={15} /><div><b>Erro</b><p>{err}</p></div></div>
  const C = REGISTRY[node.type as string]
  if (!C) return <div className="gu-node-error">Componente desconhecido: {String(node.type)}</div>
  const loading = node.loading !== undefined ? Boolean(resolve(node.loading, ctx.scope)) : false
  return <NodeBoundary type={String(node.type)}><C node={node} ctx={ctx} loading={loading} /></NodeBoundary>
}
const Kids = ({ nodes, ctx }: { nodes?: N[]; ctx: Ctx }) => <>{(nodes ?? []).map((c, i) => <Render key={c.id ?? i} node={c} ctx={ctx} />)}</>

type P = { node: N; ctx: Ctx; loading: boolean }
const Skeleton = ({ lines = 3 }: { lines?: number }) => <div className="gu-skeleton" aria-busy="true" aria-label="Carregando">{Array.from({ length: lines }, (_, i) => <i key={i} style={{ width: `${90 - i * 14}%` }} />)}</div>

// ------------------------------------------------------------------------------------------------ layout
const Stack = ({ node, ctx }: P) => <div className="gu-stack" data-dir={node.dir ?? 'v'} data-gap={node.gap ?? 'md'}><Kids nodes={node.children} ctx={ctx} /></div>
const Grid = ({ node, ctx }: P) => <div className="gu-grid-layout" data-gap={node.gap ?? 'md'} style={{ ['--cols' as string]: node.cols ?? 2 }}><Kids nodes={node.children} ctx={ctx} /></div>
const Split = ({ node, ctx }: P) => <div className="gu-split" style={{ ['--ratio' as string]: `${(node.ratio ?? 0.5) * 100}fr ${(1 - (node.ratio ?? 0.5)) * 100}fr` }}><Kids nodes={node.children} ctx={ctx} /></div>
const Card = ({ node, ctx }: P) => (
  <section className="gu-card" data-tone={tone(node.tone)}>
    {(node.title !== undefined || node.subtitle !== undefined) && <header><h3>{txt(node.title, ctx.scope)}</h3>{node.subtitle !== undefined && <p>{txt(node.subtitle, ctx.scope)}</p>}</header>}
    <div className="gu-stack" data-gap="sm"><Kids nodes={node.children} ctx={ctx} /></div>
  </section>
)
function Tabs({ node, ctx }: P) {
  const key = node.stateKey ?? `tab:${node.id}`
  const tabs = (node.tabs ?? []) as { id: string; label: string; children: N[] }[]
  const cur = typeof ctx.state[key] === 'string' && tabs.some((t) => t.id === ctx.state[key]) ? (ctx.state[key] as string) : tabs[0]?.id
  const active = tabs.find((t) => t.id === cur)
  return (
    <div className="gu-tabs">
      <div role="tablist" aria-label="Abas do painel">
        {tabs.map((t) => <button key={t.id} role="tab" id={`tab-${node.id}-${t.id}`} aria-selected={t.id === cur} aria-controls={`tabp-${node.id}`} onClick={() => ctx.setState(key, t.id)}>{t.label}</button>)}
      </div>
      <div role="tabpanel" id={`tabp-${node.id}`} aria-labelledby={`tab-${node.id}-${cur}`} className="gu-stack" data-gap="md"><Kids nodes={active?.children} ctx={ctx} /></div>
    </div>
  )
}

// ------------------------------------------------------------------------------------------------ display
const Text = ({ node, ctx }: P) => <p className="gu-text" data-variant={node.variant ?? 'body'} data-tone={tone(node.tone)}>{txt(node.text, ctx.scope)}</p>
function Stat({ node, ctx, loading }: P) {
  const v = resolve(node.value, ctx.scope)
  return (
    <div className="gu-stat" data-tone={tone(node.tone)}>
      <span className="gu-stat-label">{txt(node.label, ctx.scope)}</span>
      {loading ? <Skeleton lines={1} /> : <b className="gu-stat-value">{typeof v === 'number' ? fmtNumber(v) : String(v ?? '—')}{node.unit && <small> {node.unit}</small>}</b>}
      {node.delta !== undefined && <span className="gu-stat-delta">{txt(node.delta, ctx.scope)}</span>}
      {node.hint !== undefined && <span className="gu-stat-hint">{txt(node.hint, ctx.scope)}</span>}
    </div>
  )
}
function Kv({ node, ctx }: P) {
  const items = asRows(resolve(node.items, ctx.scope))
  return <dl className="gu-kv">{items.map((it, i) => <div key={i}><dt>{String(it.k ?? it.key ?? it.label ?? '')}</dt><dd>{typeof it.v === 'object' ? JSON.stringify(it.v) : String(it.v ?? it.value ?? '')}</dd></div>)}</dl>
}
const AlertC = ({ node, ctx }: P) => (
  <div className="gu-alert" data-tone={tone(node.tone ?? 'info')} role={node.tone === 'bad' || node.tone === 'warn' ? 'alert' : 'status'}>
    {node.tone === 'bad' || node.tone === 'warn' ? <AlertTriangle size={15} /> : node.tone === 'ok' ? <Check size={15} /> : <Info size={15} />}
    <div>{node.title !== undefined && <b>{txt(node.title, ctx.scope)}</b>}{node.text !== undefined && <p>{txt(node.text, ctx.scope)}</p>}</div>
  </div>
)
function ProgressC({ node, ctx }: P) {
  const v = Number(resolve(node.value, ctx.scope)) || 0
  const max = Number(resolve(node.max, ctx.scope)) || 100
  const pct = Math.max(0, Math.min(100, (v / max) * 100))
  return (
    <div className="gu-progress" data-tone={tone(node.tone)}>
      <div className="gu-progress-head"><span>{node.label !== undefined ? txt(node.label, ctx.scope) : 'Progresso'}</span><b>{max === 100 ? `${Math.round(pct)}%` : `${fmtNumber(v)} / ${fmtNumber(max)}`}</b></div>
      <div className="gu-progress-bar" role="progressbar" aria-valuenow={Math.round(pct)} aria-valuemin={0} aria-valuemax={100} aria-label={node.label !== undefined ? txt(node.label, ctx.scope) : 'Progresso'}><i style={{ width: `${pct}%` }} /></div>
    </div>
  )
}
const STEP_ICON = (s: string) => (s === 'done' || s === 'ok' ? <Check size={14} /> : s === 'running' ? <Loader2 size={14} className="spin" /> : s === 'failed' || s === 'error' ? <X size={14} /> : s === 'skipped' || s === 'replaced' ? <SkipForward size={14} /> : <CircleDashed size={14} />)
function Steps({ node, ctx, loading }: P) {
  const items = asRows(resolve(node.items, ctx.scope))
  if (loading) return <Skeleton />
  if (!items.length) return <p className="gu-empty">Nenhuma etapa ainda.</p>
  return (
    <ol className="gu-steps">
      {items.map((s, i) => {
        const st = String(s.status ?? 'pending')
        return <li key={String(s.id ?? i)} data-status={st}><span className="gu-step-ico" aria-hidden>{STEP_ICON(st)}</span><span className="grow"><b>{String(s.title ?? s.name ?? `Etapa ${i + 1}`)}</b>{s.role ? <small className="gu-chip">{String(s.role)}</small> : null}{s.detail || s.summary ? <small className="gu-step-detail">{String(s.detail ?? s.summary)}</small> : null}</span><span className="gu-sr">{st}</span></li>
      })}
    </ol>
  )
}
const Empty = ({ node, ctx }: P) => <p className="gu-empty">{node.text !== undefined ? txt(node.text, ctx.scope) : 'Nada por aqui.'}</p>

// ------------------------------------------------------------------------------------------------ actions on rows
function RowActions({ actions, row, ctx }: { actions?: N[]; row: Row; ctx: Ctx }) {
  if (!actions?.length) return null
  return (
    <span className="gu-row-actions">
      {actions.map((a, i) => (
        <button key={i} className="gu-btn small" data-tone={tone(a.tone)} disabled={ctx.busy === a.action}
          onClick={() => ctx.run(a.action, { row, form: a.params ? (resolveArgs(a.params, { ...ctx.scope, row }) as Row) : undefined, confirm: a.confirm })}>{a.label}</button>
      ))}
    </span>
  )
}

// ------------------------------------------------------------------------------------------------ data
function Table({ node, ctx, loading }: P) {
  const all = asRows(resolve(node.rows, ctx.scope))
  const cols = (node.columns ?? []) as { key: string; label: string; align?: string; format?: Format }[]
  const [q, setQ] = useState('')
  const [sort, setSort] = useState<{ key: string; dir: SortDir } | null>(null)
  const [page, setPage] = useState(0)
  const pageSize = node.pageSize ?? 25
  const view = useMemo(() => {
    let r = node.filter ? filterRows(all, q, cols.map((c) => c.key)) : all
    if (sort && node.sortable !== false) r = sortRows(r, sort.key, sort.dir)
    return r
  }, [all, q, sort, node.filter, node.sortable, cols])
  const pages = Math.max(1, Math.ceil(view.length / pageSize))
  const cur = Math.min(page, pages - 1)
  const rows = view.slice(cur * pageSize, cur * pageSize + pageSize)
  if (loading && !all.length) return <Skeleton lines={4} />
  return (
    <div className="gu-table-wrap">
      {node.filter && <label className="gu-search"><Search size={14} /><input value={q} onChange={(e) => { setQ(e.target.value); setPage(0) }} placeholder="Filtrar…" aria-label="Filtrar linhas" /></label>}
      <div className="gu-table-scroll">
        <table className="gu-table">
          <thead>
            <tr>
              {cols.map((c) => (
                <th key={c.key} data-align={c.align ?? 'left'} aria-sort={sort?.key === c.key ? (sort.dir === 'asc' ? 'ascending' : 'descending') : 'none'}>
                  {node.sortable === false ? c.label : <button onClick={() => setSort((s) => (s?.key === c.key ? (s.dir === 'asc' ? { key: c.key, dir: 'desc' } : null) : { key: c.key, dir: 'asc' }))}>{c.label}{sort?.key === c.key && (sort.dir === 'asc' ? <ChevronUp size={12} /> : <ChevronDown size={12} />)}</button>}
                </th>
              ))}
              {node.rowActions?.length ? <th aria-label="Ações" /> : null}
            </tr>
          </thead>
          <tbody>
            {rows.map((r, i) => (
              <tr key={String(r[node.rowKey ?? ''] ?? cur * pageSize + i)}>
                {cols.map((c) => <td key={c.key} data-align={c.align ?? (typeof r[c.key] === 'number' ? 'right' : 'left')}>{fmt(r[c.key], c.format)}</td>)}
                {node.rowActions?.length ? <td><RowActions actions={node.rowActions} row={r} ctx={ctx} /></td> : null}
              </tr>
            ))}
          </tbody>
        </table>
        {!rows.length && <p className="gu-empty">{node.empty ?? (q ? 'Nenhuma linha corresponde ao filtro.' : 'Sem dados.')}</p>}
      </div>
      {pages > 1 && <div className="gu-pager"><button className="gu-btn small" disabled={cur === 0} onClick={() => setPage(cur - 1)}>‹</button><span>{cur + 1} / {pages} · {view.length} linhas</span><button className="gu-btn small" disabled={cur >= pages - 1} onClick={() => setPage(cur + 1)}>›</button></div>}
    </div>
  )
}
function ListC({ node, ctx, loading }: P) {
  const items = asRows(resolve(node.items, ctx.scope))
  if (loading && !items.length) return <Skeleton />
  if (!items.length) return <p className="gu-empty">{node.empty ?? 'Lista vazia.'}</p>
  return (
    <ul className="gu-list">
      {items.map((it, i) => (
        <li key={i}><span className="grow"><b>{String(it[node.titleKey ?? 'title'] ?? it.name ?? '')}</b>{node.subtitleKey && it[node.subtitleKey] !== undefined ? <small>{String(it[node.subtitleKey])}</small> : null}</span>{node.badgeKey && it[node.badgeKey] !== undefined ? <span className="gu-chip">{String(it[node.badgeKey])}</span> : null}<RowActions actions={node.itemActions} row={it} ctx={ctx} /></li>
      ))}
    </ul>
  )
}
function ChartC({ node, ctx, loading }: P) {
  const rows = asRows(resolve(node.data, ctx.scope))
  if (loading && !rows.length) return <Skeleton lines={5} />
  return <Chart kind={node.kind} rows={rows} x={node.x ?? Object.keys(rows[0] ?? {})[0] ?? 'x'} series={node.series ?? []} unit={node.unit} stacked={node.stacked} height={node.height} title={node.title} />
}
function Log({ node, ctx }: P) {
  const raw = resolve(node.lines, ctx.scope)
  const lines = (Array.isArray(raw) ? raw : []).slice(-(node.maxLines ?? 500)).map((l): { t?: string; level?: string; text: string } => (l && typeof l === 'object' ? { t: (l as Row).t as string | undefined, level: (l as Row).level as string | undefined, text: String((l as Row).text ?? '') } : { text: String(l) }))
  const box = useRef<HTMLDivElement>(null)
  const stick = useRef(true)
  useEffect(() => { const el = box.current; if (el && node.follow !== false && stick.current) el.scrollTop = el.scrollHeight }, [lines.length, node.follow])
  return (
    <div className="gu-log" ref={box} style={{ maxHeight: node.height ?? 260 }} role="log" aria-live="off" tabIndex={0} onScroll={(e) => { const el = e.currentTarget; stick.current = el.scrollHeight - el.scrollTop - el.clientHeight < 24 }}>
      {lines.length === 0 ? <span className="gu-empty">Sem saída ainda.</span> : lines.map((l, i) => <div key={i} data-level={l.level ?? 'info'}>{l.t ? <time>{l.t.length > 12 ? new Date(l.t).toLocaleTimeString('pt-BR') : l.t}</time> : null}<span>{l.text}</span></div>)}
    </div>
  )
}
function Files({ node, ctx, loading }: P) {
  const all = asRows(resolve(node.items, ctx.scope))
  const [q, setQ] = useState('')
  const items = node.filter ? filterRows(all, q, ['name', 'path']) : all
  if (loading && !all.length) return <Skeleton />
  return (
    <div className="gu-files">
      {node.filter && <label className="gu-search"><Search size={14} /><input value={q} onChange={(e) => setQ(e.target.value)} placeholder="Filtrar arquivos…" aria-label="Filtrar arquivos" /></label>}
      {!items.length ? <p className="gu-empty">{node.empty ?? 'Nenhum arquivo.'}</p> : (
        <ul className="gu-list">
          {items.map((f, i) => {
            const isDir = f.type === 'pasta'
            const name = String(f.name ?? String(f.path ?? '').split(/[\\/]/).pop() ?? '')
            return (
              <li key={String(f.path ?? i)}>
                <span className="gu-file-ico" aria-hidden>{isDir ? <Folder size={15} /> : <FileText size={15} />}</span>
                <span className="grow"><b>{name}</b><small title={String(f.path ?? '')}>{String(f.path ?? '')}</small></span>
                {f.sizeKB !== undefined && <span className="gu-meta">{fmt(Number(f.sizeKB) * 1024, 'bytes')}</span>}
                {f.modified !== undefined && <span className="gu-meta">{String(f.modified)}</span>}
                <RowActions actions={node.itemActions} row={f} ctx={ctx} />
              </li>
            )
          })}
        </ul>
      )}
    </div>
  )
}
function Results({ node, ctx }: P) {
  const items = asRows(resolve(node.items, ctx.scope))
  if (!items.length) return <p className="gu-empty">{node.empty ?? 'Sem resultados.'}</p>
  return (
    <ul className="gu-results">
      {items.map((r, i) => {
        const url = String(r.url ?? '')
        const safe = /^https?:\/\//i.test(url)
        return <li key={i}><b>{safe ? <a href={url} target="_blank" rel="noopener noreferrer">{String(r.title ?? url)} <ExternalLink size={11} /></a> : String(r.title ?? '')}</b><small>{safe ? new URL(url).host : ''}</small><p>{String(r.snippet ?? '')}</p><RowActions actions={node.itemActions} row={r} ctx={ctx} /></li>
      })}
    </ul>
  )
}

// ------------------------------------------------------------------------------------------------ controls
function FieldInput({ f, value, onChange, onCommit, error }: { f: FieldDef; value: StateValue; onChange: (v: StateValue) => void; onCommit?: () => void; error?: string | null }) {
  const id = `f-${f.name}`
  const common = { id, 'aria-invalid': Boolean(error), 'aria-describedby': error ? `${id}-err` : undefined }
  let input: ReactNode
  switch (f.kind) {
    case 'select': input = <select {...common} value={String(value)} onChange={(e) => { onChange(e.target.value); onCommit?.() }}><option value="">—</option>{f.options?.map((o) => <option key={o.value} value={o.value}>{o.label}</option>)}</select>; break
    case 'toggle': input = <input {...common} type="checkbox" checked={Boolean(value)} onChange={(e) => { onChange(e.target.checked); onCommit?.() }} />; break
    case 'slider': input = <span className="gu-slider"><input {...common} type="range" min={f.min ?? 0} max={f.max ?? 100} step={f.step ?? 1} value={Number(value)} onChange={(e) => onChange(Number(e.target.value))} onMouseUp={onCommit} onKeyUp={onCommit} /><b>{String(value)}</b></span>; break
    case 'number': input = <input {...common} type="number" min={f.min} max={f.max} step={f.step} value={String(value)} onChange={(e) => onChange(coerce(f, e.target.value))} onBlur={onCommit} />; break
    case 'textarea': input = <textarea {...common} rows={3} value={String(value)} placeholder={undefined} onChange={(e) => onChange(e.target.value)} onBlur={onCommit} />; break
    default: input = <input {...common} type="text" value={String(value)} onChange={(e) => onChange(e.target.value)} onBlur={onCommit} onKeyDown={(e) => { if (e.key === 'Enter') onCommit?.() }} />
  }
  return (
    <label className="gu-field" data-kind={f.kind} htmlFor={id}>
      <span>{f.label ?? f.name}{f.required && <em aria-label="obrigatório"> *</em>}</span>
      {input}
      {error && <small id={`${id}-err`} className="gu-field-error">{error}</small>}
    </label>
  )
}
function FormC({ node, ctx }: P) {
  const fields = (node.fields ?? []) as FieldDef[]
  const [vals, setVals] = useState<Record<string, StateValue>>(() => Object.fromEntries(fields.map((f) => [f.name, initialFieldValue(f, ctx.state)])))
  const [touched, setTouched] = useState(false)
  // a field added by a later spec update gets its initial value; existing values are kept
  useEffect(() => { setVals((v) => { const n = { ...v }; let ch = false; for (const f of fields) if (!(f.name in n)) { n[f.name] = initialFieldValue(f, ctx.state); ch = true } return ch ? n : v }) }, [fields, ctx.state])
  const errors = Object.fromEntries(fields.map((f) => [f.name, validateField(f, vals[f.name])]))
  const invalid = Object.values(errors).some(Boolean)
  const submit = () => {
    setTouched(true)
    if (invalid) return
    for (const f of fields) ctx.setState(f.name, vals[f.name])
    ctx.run(node.submit.action, { form: vals, confirm: node.submit.confirm })
  }
  return (
    <form className="gu-form" noValidate onSubmit={(e) => { e.preventDefault(); submit() }}>
      <div className="gu-form-fields">{fields.map((f) => <FieldInput key={f.name} f={f} value={vals[f.name]} error={touched ? errors[f.name] : null} onChange={(v) => setVals((s) => ({ ...s, [f.name]: v }))} />)}</div>
      <button type="submit" className="gu-btn" data-tone={tone(node.submit.tone ?? 'accent')} disabled={ctx.busy === node.submit.action}>{ctx.busy === node.submit.action ? <Loader2 size={13} className="spin" /> : null} {node.submit.label}</button>
      {touched && invalid && <p className="gu-field-error" role="alert">Corrija os campos marcados.</p>}
    </form>
  )
}
function Control({ node, ctx }: P) {
  const f = node.field as FieldDef
  const [local, setLocal] = useState<StateValue>(initialFieldValue(f, ctx.state))
  useEffect(() => { if (f.name in ctx.state) setLocal(ctx.state[f.name]) }, [ctx.state, f.name])
  const err = validateField(f, local)
  return <FieldInput f={f} value={local} error={err} onChange={(v) => { setLocal(v); if (!validateField(f, v)) ctx.setState(f.name, v) }} onCommit={() => { if (!err && node.onChange) { ctx.setState(f.name, local); ctx.run(node.onChange, { form: { [f.name]: local } }) } }} />
}
const ButtonC = ({ node, ctx }: P) => {
  const off = node.disabled !== undefined && Boolean(resolve(node.disabled, ctx.scope))
  return <button className="gu-btn" data-tone={tone(node.tone)} disabled={off || ctx.busy === node.action} onClick={() => ctx.run(node.action, { form: node.params ? (resolveArgs(node.params, ctx.scope) as Row) : undefined, confirm: node.confirm })}>{ctx.busy === node.action ? <Loader2 size={13} className="spin" /> : null} {node.label}</button>
}

const REGISTRY: Record<string, (p: P) => ReactNode> = {
  stack: Stack, grid: Grid, split: Split, card: Card, tabs: Tabs, text: Text, stat: Stat, kv: Kv, alert: AlertC, progress: ProgressC, steps: Steps, empty: Empty,
  table: Table, list: ListC, chart: ChartC, log: Log, files: Files, results: Results, form: FormC, control: Control, button: ButtonC,
}
export const COMPONENT_TYPES = Object.keys(REGISTRY)
