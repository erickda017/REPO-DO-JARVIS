import { useEffect, useState } from 'react'
import { FolderPlus, Gamepad2, HardDrive, Thermometer, X } from 'lucide-react'
import { api, ApiError, type AgentAccess, type MonitorView, type ToolRun } from '../api.ts'
import { useApp } from '../store.ts'

const QUICK_ROOTS: [string, string][] = [['%DESKTOP%', 'Área de Trabalho'], ['%DOCUMENTS%', 'Documentos'], ['%DOWNLOADS%', 'Downloads'], ['%APPDATA%\\.minecraft', 'Minecraft']]

function Spark({ values, label, max = 100 }: { values: number[]; label: string; max?: number }) {
  if (values.length < 2) return <div className="spark empty dim small">{label}: coletando…</div>
  const pts = values.map((v, i) => `${(i / (values.length - 1)) * 100},${100 - Math.min(v / max, 1) * 100}`).join(' ')
  return (
    <div className="spark" role="img" aria-label={`${label}: ${values.at(-1)}%`}>
      <svg viewBox="0 0 100 100" preserveAspectRatio="none"><polyline points={pts} fill="none" vectorEffect="non-scaling-stroke" /></svg>
      <span className="small dim">{label}</span><b>{values.at(-1)?.toFixed(0)}%</b>
    </div>
  )
}

interface Candidate { pid: number; name: string; memMB: number; class: string; why: string; window: string | null }

/** Permissions, real monitoring, disk space and the game profile. Everything shown here is measured by the bridge. */
export function AgentView() {
  const jv = window.jarvis
  const send = useApp((s) => s.send)
  const setView = useApp((s) => s.setView)
  const [acc, setAcc] = useState<AgentAccess | null>(null)
  const [mon, setMon] = useState<MonitorView | null>(null)
  const [msg, setMsg] = useState('')
  const [temp, setTemp] = useState<ToolRun | null>(null)
  const [cands, setCands] = useState<Candidate[] | null>(null)
  const [pick, setPick] = useState<Set<number>>(new Set())
  const [game, setGame] = useState('')
  const [applied, setApplied] = useState<ToolRun | null>(null)
  const [profile, setProfile] = useState<any>(null)

  const err = (e: unknown) => setMsg(e instanceof ApiError ? e.message : String(e))
  const loadAcc = () => void api.agentAccess().then(setAcc).catch(err)
  const loadMon = () => void api.monitor().then(setMon).catch(() => {})
  const loadProfile = () => void api.agentTool('profile_status').then((r) => setProfile(r.data)).catch(() => {})
  useEffect(() => {
    loadAcc(); loadMon(); loadProfile()
    const t = setInterval(loadMon, 5000)
    return () => clearInterval(t)
  }, [])

  const ask = (text: string) => { setView('home'); void send(text) }
  const setTool = (tool: string, on: boolean) => void api.agentAccessSet({ tool, on }).then(setAcc).catch(err)
  const addRoot = (p: string, label?: string) => void api.agentAccessSet({ addRoot: p, label }).then((a) => { setAcc(a); setMsg('') }).catch(err)

  const prepare = async () => {
    setApplied(null)
    const r = await api.agentTool('profile_prepare', { game: game || undefined }).catch((e) => ({ ok: false, error: String(e) }) as ToolRun)
    if (!r.ok) return setMsg(r.error ?? 'falhou')
    const list = r.data.candidates as Candidate[]
    setCands(list)
    setPick(new Set(list.filter((c) => c.class === 'optional').map((c) => c.pid)))
    setMsg(list.length ? '' : 'Nada elegível para fechar agora.')
  }
  const apply = async () => {
    const pids = [...pick]
    if (!pids.length || !confirm(`Fechar ${pids.length} aplicativo(s) para o modo game? Cada um recebe o pedido normal de fechar; nada é forçado e trabalho não salvo pode ser perdido.`)) return
    const r = await api.agentTool('profile_apply', { pids, game: game || undefined }, true)
    setApplied(r)
    setCands(null)
    loadProfile()
  }

  const memHist = mon?.history.map((h) => h.memUsedPct) ?? []
  const cpuHist = (mon?.history.map((h) => h.cpu).filter((x): x is number => x != null)) ?? []

  return (
    <div className="page">
      <h1>Agente</h1>
      <p className="dim lead">O JARVIS entende pedidos em linguagem natural e executa no seu PC só o que você liberar aqui. Ações que apagam, fecham ou executam sempre pedem a sua confirmação, e cada resultado é verificado antes de ser dado como concluído.</p>
      {msg && <p className="err small" role="alert">{msg}</p>}

      <div className="grid2">
        <section>
          <h3>Acessos</h3>
          <ul className="stack">
            {acc && Object.entries(acc.groups).map(([k, label]) => (
              <li key={k} className="panel row-panel">
                <div className="grow"><h2>{label}</h2></div>
                <label className="switch"><input type="checkbox" checked={!!acc.tools[k]} onChange={(e) => setTool(k, e.target.checked)} /> {acc.tools[k] ? 'Ligado' : 'Desligado'}</label>
              </li>
            ))}
          </ul>
          <h3 className="mt">Pastas liberadas</h3>
          <p className="dim small">Os arquivos só podem ser lidos e alterados dentro destas pastas.</p>
          <ul className="stack">
            {acc?.roots.length === 0 && <li className="dim small">Nenhuma pasta liberada: o agente não toca em arquivos.</li>}
            {acc?.roots.map((r) => (
              <li key={r.path} className="panel row-panel">
                <div className="grow small">{r.path}</div>
                <button className="icon-btn" aria-label={`Remover ${r.path}`} onClick={() => void api.agentAccessSet({ removeRoot: r.path }).then(setAcc)}><X size={15} /></button>
              </li>
            ))}
          </ul>
          <div className="actions">
            {QUICK_ROOTS.map(([p, l]) => <button key={p} className="btn" onClick={() => addRoot(p, l)}><FolderPlus size={14} /> {l}</button>)}
            {jv && <button className="btn" onClick={() => void jv.access.pick().then((p) => p && addRoot(p))}><FolderPlus size={14} /> Outra pasta…</button>}
          </div>
        </section>

        <section>
          <h3>Monitor do computador</h3>
          {mon ? (
            <>
              <div className="sparks">
                <Spark values={cpuHist} label="CPU" />
                <Spark values={memHist} label="RAM" />
              </div>
              <p className="dim small">{mon.summary.cpu.model} · {mon.summary.cpu.logicalCores} threads · RAM {mon.summary.memory.usedGB}/{mon.summary.memory.totalGB} GB · ligado há {mon.summary.uptimeHours} h</p>
              {mon.report.available ? (
                <p className="small">Últimos {mon.report.coveredMinutes} min medidos: CPU média <b>{mon.report.cpu?.avgPct}%</b> (máx {mon.report.cpu?.maxPct}%), RAM média <b>{mon.report.memory?.avgUsedPct}%</b>.{mon.report.note ? <span className="dim"> {mon.report.note}</span> : null}</p>
              ) : <p className="dim small">{mon.report.reason}</p>}
              <h3 className="mt">Discos</h3>
              <ul className="stack">
                {mon.disks.map((d) => (
                  <li key={d.drive} className="panel disk" data-low={(d.freePct ?? 100) < 10}>
                    <div className="row-panel" style={{ padding: 0 }}><HardDrive size={16} /><b>{d.drive}</b><span className="dim small grow">{d.freeGB} GB livres de {d.totalGB} GB</span><span className="small">{d.freePct == null ? "n/d" : `${d.freePct}%`}</span></div>
                    <div className="bar"><i style={{ width: d.freePct == null ? "0%" : `${100 - d.freePct}%` }} /></div>
                  </li>
                ))}
              </ul>
              <div className="actions">
                <button className="btn" onClick={() => ask('Analise o espaço em disco, me diga o que ocupa mais e sugira o que posso apagar, com tamanhos.')}>Analisar o espaço e sugerir limpeza</button>
                <button className="btn" onClick={() => ask('Gere um relatório do uso médio de CPU e RAM nos últimos 30 minutos.')}>Relatório de CPU/RAM</button>
                <button className="btn" onClick={() => void api.agentTool('sys_temperature').then(setTemp)}><Thermometer size={14} /> Temperatura</button>
              </div>
              {temp?.ok && (
                <p className="small">CPU: {temp.data.cpu.available ? `${temp.data.cpu.celsius} °C (${temp.data.cpu.source})` : <span className="dim">indisponível — {temp.data.cpu.reason}</span>}<br />GPU: {temp.data.gpu.available ? `${temp.data.gpu.celsius} °C` : <span className="dim">indisponível — {temp.data.gpu.reason}</span>}</p>
              )}
            </>
          ) : <p className="dim">Aguardando o bridge…</p>}
        </section>
      </div>

      <h3 className="mt"><Gamepad2 size={15} style={{ verticalAlign: '-2px' }} /> Modo game</h3>
      <p className="dim small lead">Fecha, com o seu aval, aplicativos opcionais que consomem RAM (chat, launchers, navegadores). Nunca mexe em antivírus, serviços ou no Windows, e mostra a RAM antes e depois. O jogo informado nunca é listado para fechar.</p>
      {profile?.active && <p className="small ok-text">Modo game ativo desde {new Date(profile.since).toLocaleTimeString('pt-BR')} · {profile.closedCount} app(s) fechado(s) · RAM livre {profile.freeGBNow} GB ({profile.freedGBSoFar >= 0 ? '+' : ''}{profile.freedGBSoFar} GB)</p>}
      <div className="inline-form">
        <input value={game} onChange={(e) => setGame(e.target.value)} placeholder="Qual jogo vai abrir? (opcional)" aria-label="Jogo" />
        <button className="btn primary" onClick={() => void prepare()}>Analisar o que dá para fechar</button>
        {profile?.active && <button className="btn" onClick={() => void api.agentTool('profile_stop').then((r) => { setApplied(r); loadProfile() })}>Encerrar modo game</button>}
      </div>
      {cands && cands.length > 0 && (
        <div className="panel form">
          <ul className="rows">
            {cands.map((c) => (
              <li key={c.pid}>
                <label className="switch"><input type="checkbox" checked={pick.has(c.pid)} onChange={(e) => setPick((p) => { const n = new Set(p); if (e.target.checked) n.add(c.pid); else n.delete(c.pid); return n })} />
                  <span className="grow"><b>{c.name}</b> <span className="dim small">{c.memMB} MB · {c.why}{c.class === 'caution' ? ' · pode ter trabalho não salvo' : ''}</span></span></label>
              </li>
            ))}
          </ul>
          <div className="actions"><button className="btn primary" onClick={() => void apply()}>Fechar os marcados ({pick.size})</button></div>
        </div>
      )}
      {applied?.ok && applied.data?.results && (
        <p className="small">{applied.data.results.filter((r: any) => r.ok).length} fechado(s). RAM livre {applied.data.freeGBBefore} → {applied.data.freeGBAfter} GB ({applied.data.freedGB >= 0 ? '+' : ''}{applied.data.freedGB} GB). {applied.data.results.filter((r: any) => !r.ok).map((r: any) => `${r.name ?? r.pid}: ${r.reason}`).join(' · ')}</p>
      )}
      {applied?.ok && applied.data?.closed && <p className="small">Modo game encerrado. Fechados nesta sessão: {applied.data.closed.map((c: any) => c.name).join(', ') || 'nenhum'}. Reabra o que precisar.</p>}
    </div>
  )
}
