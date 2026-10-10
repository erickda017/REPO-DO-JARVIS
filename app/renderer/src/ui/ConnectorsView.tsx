import { useEffect, useMemo, useState } from 'react'
import { ChevronDown, ChevronRight } from 'lucide-react'
import { api, ApiError, type ConnectorView, type GoogleStatus } from '../api.ts'

const RISK: Record<string, string> = { read: 'leitura', write: 'altera', danger: 'sem volta' }
const errText = (e: unknown) => (e instanceof ApiError ? e.message : String(e))
const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms))

const GOOGLE_STEPS = [
  'Abra console.cloud.google.com e crie um projeto (pode ser "JARVIS").',
  'APIs e serviços › Biblioteca: ative só as que for usar (Gmail, Drive, Agenda, Planilhas, Docs, Tarefas, People).',
  'Tela de consentimento OAuth: tipo "Externo", com o seu e-mail. Publique o app ("Em produção"): em modo de teste o Google derruba o acesso a cada 7 dias. O aviso "app não verificado" é normal (o app é o seu): Avançado › Continuar.',
  'Credenciais › Criar credenciais › ID do cliente OAuth › tipo "App para computador". Copie o ID do cliente e a chave secreta e cole abaixo.',
]

/** Sign in with Google in the SYSTEM browser (OAuth + PKCE, loopback). The client id/secret are the owner's own; tokens never reach this window. */
function GoogleAccount({ onSigned }: { onSigned: () => void }) {
  const [st, setSt] = useState<GoogleStatus | null>(null)
  const [id, setId] = useState('')
  const [secret, setSecret] = useState('')
  const [help, setHelp] = useState(false)
  const [msg, setMsg] = useState('')
  const [busy, setBusy] = useState(false)
  const load = () => void api.googleStatus().then(setSt).catch(() => {})
  useEffect(() => {
    // the bridge may still be starting: keep asking until it answers
    let alive = true
    let timer = 0
    const first = () => void api.googleStatus().then((s) => { if (alive) setSt(s) }).catch(() => { if (alive) timer = window.setTimeout(first, 3000) })
    first()
    return () => { alive = false; clearTimeout(timer) }
  }, [])
  useEffect(() => {
    if (!st?.pending) return
    const t = setInterval(() => void api.googleStatus().then((s) => { setSt(s); if (!s.pending) { onSigned(); if (s.lastError) setMsg(s.lastError) } }).catch(() => {}), 1500)
    return () => clearInterval(t)
  }, [st?.pending, onSigned])
  const act = (fn: () => Promise<GoogleStatus | { authUrl: string }>) => {
    setBusy(true); setMsg('')
    void fn()
      .then((r) => { if ('authUrl' in r) { window.open(r.authUrl, '_blank'); setMsg('Abri o navegador. Entre na sua conta Google e autorize; volte aqui depois.'); load() } else { setSt(r); onSigned() } })
      .catch((e) => setMsg(errText(e)))
      .finally(() => setBusy(false))
  }
  if (!st) return null
  return (
    <section className="panel conn google" data-on={st.connected}>
      <div className="row-panel">
        <span className="dot big" data-tone={st.connected ? 'ok' : st.configured ? 'warn' : 'unknown'} aria-hidden />
        <div className="grow">
          <h2>Conta Google</h2>
          <p className="dim small">{st.connected ? `Conectada como ${st.email || 'sua conta'}. Cada serviço Google abaixo pede só a permissão dele, quando você o liga.` : 'Entra pelo navegador do sistema (a senha e a verificação em duas etapas nunca passam por aqui). Um login serve a Gmail, Drive, Agenda, Planilhas, Docs, Tarefas e Contatos.'}</p>
        </div>
      </div>
      {!st.configured && (
        <>
          <button className="conn-toggle" onClick={() => setHelp(!help)} aria-expanded={help}>{help ? '▾' : '▸'} Como criar o seu acesso no Google (uma vez, 5 minutos)</button>
          {help && <ol className="conn-steps">{GOOGLE_STEPS.map((s) => <li key={s}>{s}</li>)}</ol>}
          <div className="conn-fields">
            <label className="conn-field"><span>ID do cliente *</span><input value={id} onChange={(e) => setId(e.target.value)} placeholder="123456-abc.apps.googleusercontent.com" autoComplete="off" aria-label="ID do cliente Google" /></label>
            <label className="conn-field"><span>Chave secreta do cliente *</span><input type="password" value={secret} onChange={(e) => setSecret(e.target.value)} placeholder="GOCSPX-…" autoComplete="off" aria-label="Chave secreta do cliente Google" /></label>
            <div className="actions"><button className="btn primary" disabled={busy || !id || !secret} onClick={() => act(() => api.googleClient(id.trim(), secret.trim()).then((s) => { setSecret(''); return s }))}>Salvar</button></div>
          </div>
        </>
      )}
      {st.configured && !st.connected && (
        <div className="actions">
          <button className="btn primary" disabled={busy || st.pending} onClick={() => act(() => api.googleSignin())}>{st.pending ? 'Aguardando você no navegador…' : 'Entrar com Google'}</button>
          {st.pending && <button className="btn" onClick={() => act(() => api.googleCancel())}>Cancelar</button>}
          <button className="btn" disabled={busy} onClick={() => confirm('Esquecer o ID e a chave secreta do Google neste PC?') && act(() => api.googleForget())}>Trocar credenciais</button>
        </div>
      )}
      {st.connected && (
        <div className="actions">
          <button className="btn" disabled={busy} onClick={() => confirm('Sair do Google? O acesso é revogado no Google e todos os serviços Google são desligados.') && act(() => api.googleSignout())}>Sair e revogar o acesso</button>
          <span className="dim small">{st.scopes.filter((s) => s.includes('/auth/')).length} permissões concedidas</span>
        </div>
      )}
      {msg && <p className={/revog|expir|negou|esgot|recus|falh/i.test(msg) ? 'err small' : 'dim small'} role="status">{msg}</p>}
      {st.lastError && !msg && <p className="err small" role="status">{st.lastError}</p>}
    </section>
  )
}

function Card({ c, onChange }: { c: ConnectorView; onChange: (c: ConnectorView) => void }) {
  const [draft, setDraft] = useState<Record<string, string>>({})
  const [open, setOpen] = useState(false)
  const [busy, setBusy] = useState(false)
  const [msg, setMsg] = useState<{ ok: boolean; text: string } | null>(null)
  // Google asks for consent in the browser; wait (up to 5 min) until the switch the owner flipped is really applied.
  const awaitConsent = async (want: 'enabled' | 'write') => {
    for (let i = 0; i < 100; i++) {
      await sleep(3000)
      const now = (await api.connectors().catch(() => [])).find((x) => x.id === c.id)
      if (now?.[want]) { onChange(now); setMsg({ ok: true, text: want === 'write' ? 'Alterações permitidas.' : 'Conector ligado.' }); return }
    }
    setMsg({ ok: false, text: 'Não vi a autorização terminar. Tente de novo.' })
  }
  const run = (fn: () => Promise<ConnectorView | { ok: boolean; message: string }>, want?: 'enabled' | 'write') => {
    setBusy(true)
    void fn()
      .then(async (r) => {
        if ('message' in r) { setMsg({ ok: r.ok, text: r.message }); return }
        if (r.consent?.authUrl) {
          window.open(r.consent.authUrl, '_blank')
          setMsg({ ok: true, text: 'Abri o navegador: autorize no Google e volte aqui. O interruptor liga sozinho quando terminar.' })
          if (want) await awaitConsent(want)
          return
        }
        onChange(r); setMsg(null)
      })
      .catch((e) => setMsg({ ok: false, text: errText(e) }))
      .finally(() => setBusy(false))
  }
  const dirty = Object.keys(draft).length > 0
  const state = c.enabled ? (c.write ? 'ligado · pode alterar' : 'ligado · só leitura') : c.ready ? (c.google ? 'conta Google conectada · desligado' : 'configurado · desligado') : c.google ? 'entre com a conta Google acima' : c.fields.length ? 'falta configurar' : 'desligado'
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
        <label className="switch" title={c.ready ? 'Liga os recursos de leitura deste serviço para o agente' : c.google ? 'Entre com a conta Google primeiro' : 'Preencha os campos primeiro'}>
          <input type="checkbox" checked={c.enabled} disabled={busy || !c.ready} onChange={(e) => run(() => api.connectorEnable(c.id, e.target.checked), e.target.checked ? 'enabled' : undefined)} /> Ligado
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
          <input type="checkbox" checked={c.write} disabled={busy} onChange={(e) => run(() => api.connectorWrite(c.id, e.target.checked), e.target.checked ? 'write' : undefined)} /> Permitir alterações (cada uma pede a sua confirmação{c.google?.needsWrite ? '; o Google pede uma segunda autorização' : ''})
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
  const reload = () => void api.connectors().then(setList).catch(() => {}) // signing in/out of Google changes every Google card
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
      <GoogleAccount onSigned={reload} />
      {groups.map(([cat, items]) => (
        <section key={cat}>
          <h3 className="conn-cat">{cat}</h3>
          <ul className="stack">{items.map((c) => <Card key={c.id} c={c} onChange={put} />)}</ul>
        </section>
      ))}
    </div>
  )
}
