import { useEffect, useMemo, useState } from 'react'
import { ChevronDown, ChevronRight } from 'lucide-react'
import { api, ApiError, type ConnectorView } from '../api.ts'

const RISK: Record<string, string> = { read: 'leitura', write: 'altera', danger: 'sem volta' }

function Card({ c, onChange }: { c: ConnectorView; onChange: (c: ConnectorView) => void }) {
  const [draft, setDraft] = useState<Record<string, string>>({})
  const [open, setOpen] = useState(false)
  const [busy, setBusy] = useState(false)
  const [msg, setMsg] = useState<{ ok: boolean; text: string } | null>(null)
  const run = (fn: () => Promise<ConnectorView | { ok: boolean; message: string }>) => {
    setBusy(true)
    void fn()
      .then((r) => { if ('message' in r) setMsg({ ok: r.ok, text: r.message }); else { onChange(r); setMsg(null) } })
      .catch((e) => setMsg({ ok: false, text: e instanceof ApiError ? e.message : String(e) }))
      .finally(() => setBusy(false))
  }
  const dirty = Object.keys(draft).length > 0
  const state = c.enabled ? (c.write ? 'ligado · pode alterar' : 'ligado · só leitura') : c.ready ? 'configurado · desligado' : c.fields.length ? 'falta configurar' : 'desligado'
  const reads = c.tools.filter((t) => t.risk === 'read').length
  return (
    <li className="panel conn" data-on={c.enabled}>
      <div className="row-panel">
        <span className="dot big" data-tone={c.enabled ? 'ok' : c.ready ? 'warn' : 'unknown'} aria-hidden />
        <div className="grow">
          <h2>{c.label}</h2>
          <p className="dim small">{c.desc}</p>
          <p className="dim small">{state} · {reads} de leitura{c.tools.length > reads ? ` · ${c.tools.length - reads} que alteram` : ''}{c.selfHosted ? ' · endereço seu' : ''}</p>
        </div>
        <label className="switch" title={c.ready ? 'Liga os recursos de leitura deste serviço para o agente' : 'Preencha os campos primeiro'}>
          <input type="checkbox" checked={c.enabled} disabled={busy || !c.ready} onChange={(e) => run(() => api.connectorEnable(c.id, e.target.checked))} /> Ligado
        </label>
      </div>
      {c.fields.length > 0 && (
        <div className="conn-fields">
          {c.fields.map((f) => (
            <label key={f.name} className="conn-field">
              <span>{f.label}{f.required ? ' *' : ''}</span>
              <input
                type={f.secret ? 'password' : 'text'}
                autoComplete="off"
                value={draft[f.name] ?? (f.secret ? '' : f.value ?? '')}
                placeholder={f.secret ? (f.configured ? 'salvo (cole outro para trocar)' : f.placeholder || 'cole aqui') : f.placeholder}
                onChange={(e) => setDraft({ ...draft, [f.name]: e.target.value })}
                aria-label={`${c.label}: ${f.label}`}
              />
            </label>
          ))}
          <div className="actions">
            <button className="btn primary" disabled={busy || !dirty} onClick={() => run(() => api.connectorConfig(c.id, draft).then((r) => { setDraft({}); return r }))}>Salvar</button>
            {c.hasTest && <button className="btn" disabled={busy || !c.ready} onClick={() => run(() => api.connectorTest(c.id))}>Testar</button>}
            {c.fields.some((f) => f.configured) && <button className="btn" disabled={busy} onClick={() => confirm(`Apagar as chaves e os dados de ${c.label} deste PC?`) && run(() => api.connectorClear(c.id))}>Apagar dados</button>}
          </div>
        </div>
      )}
      {c.fields.length === 0 && c.hasTest && <div className="actions"><button className="btn" disabled={busy} onClick={() => run(() => api.connectorTest(c.id))}>Testar</button></div>}
      {c.enabled && c.tools.length > reads && (
        <label className="switch conn-write" title="Sem isto o agente só consegue ler. Com isto ele pode propor alterações, e cada uma pede a sua confirmação mostrando o que será enviado.">
          <input type="checkbox" checked={c.write} disabled={busy} onChange={(e) => run(() => api.connectorWrite(c.id, e.target.checked))} /> Permitir alterações (cada uma pede a sua confirmação)
        </label>
      )}
      {msg && <p className={msg.ok ? 'ok-text small' : 'err small'} role="status">{msg.ok ? '✔ ' : ''}{msg.text}</p>}
      <button className="conn-toggle" onClick={() => setOpen(!open)} aria-expanded={open}>{open ? <ChevronDown size={14} /> : <ChevronRight size={14} />} O que o agente poderá fazer{c.help ? ' · onde achar a chave' : ''}</button>
      {open && (
        <div className="conn-detail">
          {c.help && <p className="dim small">{c.help}</p>}
          <ul className="conn-tools">
            {c.tools.map((t) => <li key={t.name}><code>{t.name}</code> <em data-risk={t.risk}>{RISK[t.risk]}</em> <span className="dim">{t.desc}</span></li>)}
          </ul>
        </div>
      )}
    </li>
  )
}

/** CONECTORES: external services the agent may use. Off until configured and switched on; changing anything is a separate permission and every change is confirmed. */
export function ConnectorsView() {
  const [list, setList] = useState<ConnectorView[]>([])
  const [err, setErr] = useState('')
  const [q, setQ] = useState('')
  useEffect(() => {
    let alive = true
    let timer = 0
    const load = () => void api.connectors().then((l) => { if (alive) { setList(l); setErr('') } }).catch((e) => { if (alive) { setErr(e instanceof ApiError ? e.message : String(e)); timer = window.setTimeout(load, 3000) } }) // the bridge may still be starting
    load()
    return () => { alive = false; clearTimeout(timer) }
  }, [])
  const put = (c: ConnectorView) => setList((l) => l.map((x) => (x.id === c.id ? c : x)))
  const groups = useMemo(() => {
    const m = new Map<string, ConnectorView[]>()
    for (const c of list.filter((x) => !q || `${x.label} ${x.desc} ${x.category}`.toLowerCase().includes(q.toLowerCase()))) m.set(c.category, [...(m.get(c.category) ?? []), c])
    return [...m.entries()]
  }, [list, q])
  const on = list.filter((c) => c.enabled).length
  return (
    <div className="page">
      <h1>Conectores</h1>
      <p className="dim lead">Serviços de fora que o seu JARVIS pode consultar e usar. Tudo começa desligado: você cola a chave (ela fica cifrada neste PC e só vai para o próprio serviço), liga o conector e, se quiser, permite alterações. Cada alteração pede a sua confirmação mostrando o que será enviado. Pedidos marcados como sensíveis nunca usam conectores.</p>
      <div className="actions">
        <input value={q} onChange={(e) => setQ(e.target.value)} placeholder={`Buscar em ${list.length} conectores…`} aria-label="Buscar conectores" style={{ width: 360, maxWidth: '100%' }} />
        <span className="dim small">{on} ligado{on === 1 ? '' : 's'}</span>
      </div>
      {err && <p className="err small" role="alert">{err}</p>}
      {groups.map(([cat, items]) => (
        <section key={cat}>
          <h3 className="conn-cat">{cat}</h3>
          <ul className="stack">{items.map((c) => <Card key={c.id} c={c} onChange={put} />)}</ul>
        </section>
      ))}
    </div>
  )
}
