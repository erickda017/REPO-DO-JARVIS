import { useCallback, useEffect, useMemo, useRef, useState } from 'react'
import { Pin, PinOff, RefreshCw, ShieldAlert, X } from 'lucide-react'
import { resolveArgs } from '../../../../shared/genui/resolve.mjs'
import { validateSpec } from '../../../../shared/genui/spec.mjs'
import { api, ApiError, type PanelView } from '../api.ts'
import { useApp } from '../store.ts'
import { Render, type Ctx, type RunOpts } from './components.tsx'
import { applyOps, mergeDefaults, type PanelState, type StateValue } from './state.ts'

/** Control state survives tab switches (and spec/data updates); the bridge also keeps it for pinned panels. */
const STATE = new Map<string, PanelState>()

interface Dialog { message: string; tool?: string; args?: unknown; onOk: () => void }
interface Note { kind: 'ok' | 'err'; text: string }

const STATUS_LABEL: Record<string, string> = { loading: 'Carregando', ready: 'Pronto', error: 'Erro', done: 'Concluído' }

/**
 * Renders ONE panel: polls the bridge for what changed (spec revision, data revisions, state overrides), keeps the control
 * state locally, runs actions through the bridge (which applies permissions and asks for confirmations) and shows the real
 * outcome. A failing component is contained by its own boundary; the rest of the panel keeps working.
 */
export function PanelHost({ id, onClose }: { id: string; onClose: () => void }) {
  const [meta, setMeta] = useState<PanelView | null>(null)
  const [spec, setSpec] = useState<any>(null)
  const [data, setData] = useState<Record<string, unknown>>({})
  const [state, setStateRaw] = useState<PanelState>(() => STATE.get(id) ?? {})
  const [busy, setBusy] = useState<string | null>(null)
  const [dialog, setDialog] = useState<Dialog | null>(null)
  const [note, setNote] = useState<Note | null>(null)
  const [loadErr, setLoadErr] = useState('')
  const [specErr, setSpecErr] = useState<string[]>([])
  const revs = useRef({ specRev: 0, stateRev: 0, data: {} as Record<string, number> })
  const inflight = useRef(false)
  const stateRef = useRef(state)
  const specRef = useRef<any>(null)
  const dataRef = useRef(data)
  stateRef.current = state
  specRef.current = spec
  dataRef.current = data

  const setState = useCallback((k: string, v: StateValue) => setStateRaw((s) => (s[k] === v ? s : { ...s, [k]: v })), [])
  useEffect(() => { STATE.set(id, state) }, [id, state])

  // persist control state for pinned panels (debounced)
  useEffect(() => {
    if (!meta?.pinned) return
    const t = setTimeout(() => void api.uiState(id, state).catch(() => {}), 800)
    return () => clearTimeout(t)
  }, [id, state, meta?.pinned])

  const poll = useCallback(async (force = false) => {
    if (inflight.current) return
    inflight.current = true
    try {
      const pv = await api.uiPanel(id, { specRev: revs.current.specRev, stateRev: revs.current.stateRev, data: revs.current.data }, force)
      setLoadErr('')
      if (pv.spec) {
        // the renderer validates again: a spec that does not pass is never drawn
        const v = validateSpec(pv.spec)
        if (v.ok) { setSpec(v.spec); setSpecErr([]); setStateRaw((s) => mergeDefaults(s, v.spec.state)) } else setSpecErr(v.errors.slice(0, 5).map((e) => `${e.path}: ${e.msg}`))
        revs.current.specRev = pv.specRev
      }
      const names = Object.keys(pv.data)
      if (names.length) {
        for (const n of names) revs.current.data[n] = pv.data[n].rev
        setData((d) => ({ ...d, ...Object.fromEntries(names.map((n) => [n, pv.data[n].value])) }))
      }
      if (pv.stateOps) { revs.current.stateRev = pv.stateOps.rev; setStateRaw((s) => applyOps(s, pv.stateOps!.values)) } else revs.current.stateRev = Math.max(revs.current.stateRev, pv.stateRev)
      setMeta(pv)
    } catch (e) {
      setLoadErr(e instanceof ApiError ? e.message : String(e))
    } finally { inflight.current = false }
  }, [id])

  useEffect(() => {
    revs.current = { specRev: 0, stateRev: 0, data: {} }
    setSpec(null); setData({}); setMeta(null)
    void poll()
    const t = setInterval(() => { if (!document.hidden) void poll() }, 1000)
    return () => clearInterval(t)
  }, [id, poll])

  const notify = (kind: Note['kind'], text: string) => { setNote({ kind, text }); window.setTimeout(() => setNote((n) => (n?.text === text ? null : n)), 6000) }

  const run = useCallback((actionId: string, o: RunOpts = {}) => {
    const a = specRef.current?.actions?.[actionId]
    if (!a) return notify('err', 'Ação não declarada no painel.')
    const scope = { data: dataRef.current, state: stateRef.current, row: o.row, form: o.form }
    if (a.type === 'state') {
      const set = resolveArgs(a.set, scope) as Record<string, StateValue>
      setStateRaw((s) => ({ ...s, ...set }))
      return
    }
    if (a.type === 'close') return onClose()
    const exec = async (confirmed: boolean) => {
      setBusy(actionId)
      if (a.messages?.loading) notify('ok', a.messages.loading)
      try {
        const r = await api.uiAction(id, actionId, { state: stateRef.current, row: o.row, form: o.form, confirmed })
        if (r.needsConfirm) {
          setBusy(null)
          setDialog({ message: r.message ?? 'Confirmar esta ação?', tool: r.tool, args: r.args, onOk: () => { setDialog(null); void exec(true) } })
          return
        }
        if (r.ask) { useApp.getState().setView('home'); void useApp.getState().send(r.ask); return }
        if (r.ok) {
          notify('ok', (r.verified === false ? 'Executado, mas a verificação falhou: ' : '') + (a.messages?.ok ?? r.evidence ?? 'Feito.'))
          if (r.setState) setStateRaw((s) => ({ ...s, ...(r.setState as Record<string, StateValue>) }))
        } else notify('err', r.error ?? a.messages?.error ?? 'A ação falhou.')
        await poll(true)
      } catch (e) {
        notify('err', e instanceof ApiError ? e.message : String(e))
      } finally { setBusy(null) }
    }
    const pre = o.confirm ?? a.confirm
    if (pre) setDialog({ message: pre, onOk: () => { setDialog(null); void exec(false) } })
    else void exec(false)
  }, [id, onClose, poll])

  const scope = useMemo(() => ({ data, state }), [data, state])
  const ctx: Ctx = useMemo(() => ({ scope, state, setState, run, busy, loading: meta?.status === 'loading' }), [scope, state, setState, run, busy, meta?.status])

  const badSources = Object.entries(meta?.sources ?? {}).filter(([, s]) => s.ok === false)
  return (
    <article className="gu-panel" aria-label={meta?.name ?? 'Painel'} data-status={meta?.status ?? 'loading'}>
      <header className="gu-panel-head">
        <div className="grow">
          <h2>{spec?.title ?? meta?.name ?? 'Painel'}</h2>
          {spec?.purpose && <p className="dim small">{spec.purpose}</p>}
        </div>
        {meta && <span className="gu-chip" data-tone={meta.status === 'error' ? 'bad' : meta.status === 'done' ? 'ok' : meta.status === 'loading' ? 'run' : 'off'} title={meta.statusText}>{STATUS_LABEL[meta.status] ?? meta.status}{meta.statusText ? ` · ${meta.statusText}` : ''}</span>}
        <button className="icon-btn" onClick={() => void poll(true)} aria-label="Atualizar painel" title="Atualizar"><RefreshCw size={15} /></button>
        {meta && <button className="icon-btn" onClick={() => void (meta.pinned ? api.uiUnpin(id) : api.uiPin(id)).then(() => poll(true))} aria-label={meta.pinned ? 'Desafixar' : 'Fixar este painel'} title={meta.pinned ? 'Desafixar (some ao reiniciar)' : 'Fixar (mantém ao reiniciar)'}>{meta.pinned ? <PinOff size={15} /> : <Pin size={15} />}</button>}
        <button className="icon-btn" onClick={onClose} aria-label="Fechar painel" title="Fechar"><X size={15} /></button>
      </header>
      {meta?.status === 'loading' && <div className="gu-loadbar" aria-hidden />}
      {loadErr && <p className="err small" role="alert">Não consegui atualizar o painel: {loadErr}</p>}
      {badSources.map(([n, s]) => <p key={n} className="gu-source-error small" role="alert">Fonte “{n}”: {s.error}</p>)}
      {specErr.length > 0 && <div className="gu-alert" data-tone="bad" role="alert"><div><b>A especificação do painel é inválida e não foi desenhada.</b>{specErr.map((e, i) => <p key={i} className="small">{e}</p>)}</div></div>}
      {note && <p className={note.kind === 'ok' ? 'ok-text small' : 'err small'} role="status">{note.text}</p>}
      <div className="gu-body">{spec ? <Render node={spec.root} ctx={ctx} /> : !loadErr && !specErr.length && <p className="dim">Carregando painel…</p>}</div>
      {dialog && <ConfirmDialog d={dialog} onCancel={() => setDialog(null)} />}
    </article>
  )
}

function ConfirmDialog({ d, onCancel }: { d: Dialog; onCancel: () => void }) {
  const cancel = useRef<HTMLButtonElement>(null)
  useEffect(() => { cancel.current?.focus() }, [])
  return (
    <div className="gu-modal" role="alertdialog" aria-modal="true" aria-label="Confirmação necessária" onKeyDown={(e) => { if (e.key === 'Escape') onCancel() }}>
      <div className="gu-modal-box">
        <p><ShieldAlert size={16} style={{ verticalAlign: '-3px' }} /> {d.message}</p>
        {d.tool && <p className="dim small">Ferramenta <code>{d.tool}</code>{d.args ? <> com <code>{JSON.stringify(d.args).slice(0, 300)}</code></> : null}. O texto do botão não conta: é isto que vai rodar.</p>}
        <div className="actions"><button ref={cancel} className="btn" onClick={onCancel}>Cancelar</button><button className="btn primary" onClick={d.onOk}>Autorizar</button></div>
      </div>
    </div>
  )
}
