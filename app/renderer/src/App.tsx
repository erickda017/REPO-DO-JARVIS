import { useEffect } from 'react'
import { Activity, Cpu, MessageSquare, Mic, Network } from 'lucide-react'
import { useApp, type View } from './store.ts'
import { NeuralScene } from './neural/Scene.tsx'
import { FloatingLayer } from './ui/Floating.tsx'
import { CommandBar } from './ui/CommandBar.tsx'
import { AisView, ChatView, SystemView, VoiceView } from './ui/Views.tsx'

const NAV: { id: View; label: string; icon: typeof Network }[] = [
  { id: 'home', label: 'Rede neural', icon: Network },
  { id: 'chat', label: 'Conversa', icon: MessageSquare },
  { id: 'ais', label: 'IAs', icon: Cpu },
  { id: 'system', label: 'Sistema', icon: Activity },
  { id: 'voice', label: 'Voz', icon: Mic },
]

function Telemetry() {
  const ov = useApp((s) => s.overview)
  if (!ov) return null
  const ais = ov.providers.filter((p) => p.enabled)
  const aisOk = ais.filter((p) => p.status?.endpoint.state === 'ok' && p.status.model.state === 'ok').length
  const svcUp = ov.services.filter((s) => s.status === 'up').length
  const open = ov.tasks.filter((t) => t.state !== 'done' && t.state !== 'cancelled').length
  return (
    <dl className="telemetry" aria-label="Resumo do sistema">
      <div><dt>IAs prontas</dt><dd>{aisOk}<small>/{ais.length}</small></dd></div>
      <div><dt>Serviços no ar</dt><dd>{svcUp}<small>/{ov.services.length}</small></dd></div>
      <div><dt>Tarefas abertas</dt><dd>{open}</dd></div>
    </dl>
  )
}

function Home() {
  return (
    <div className="home">
      <div className="scene"><NeuralScene /></div>
      <FloatingLayer />
      <Telemetry />
      <p className="legend">Nós grandes = entidades reais, com pulso a cada pedido · a nuvem de neurônios é só metáfora visual</p>
      <div className="home-command"><CommandBar /></div>
    </div>
  )
}

export function App() {
  const { view, setView, bridgeOk, refresh, pollAudit, probe } = useApp()
  useEffect(() => {
    void refresh().then(probe)
    void pollAudit()
    const a = setInterval(() => void refresh(), 4000)
    const b = setInterval(() => void pollAudit(), 1500)
    const c = setInterval(() => void probe(), 60000)
    return () => (clearInterval(a), clearInterval(b), clearInterval(c))
  }, [refresh, pollAudit, probe])

  return (
    <div className="app">
      <header className="topbar">
        <div className="wordmark"><span className="core-dot" aria-hidden />J.A.R.V.I.S</div>
        <div className="conn" data-ok={bridgeOk}><span className="dot" data-tone={bridgeOk ? 'ok' : 'bad'} aria-hidden />{bridgeOk ? 'Bridge conectado' : 'Bridge desconectado'}</div>
      </header>
      <nav className="sidebar" aria-label="Navegação">
        {NAV.map(({ id, label, icon: Icon }) => (
          <button key={id} className="nav-item" aria-current={view === id ? 'page' : undefined} onClick={() => setView(id)}>
            <Icon size={18} strokeWidth={1.6} /> <span>{label}</span>
          </button>
        ))}
      </nav>
      <main className="main">
        {view === 'home' && <Home />}
        {view === 'chat' && <ChatView />}
        {view === 'ais' && <AisView />}
        {view === 'system' && <SystemView />}
        {view === 'voice' && <VoiceView />}
        {!bridgeOk && view !== 'home' && <p className="banner" role="status">Bridge desconectado — os dados abaixo podem estar desatualizados.</p>}
      </main>
    </div>
  )
}
