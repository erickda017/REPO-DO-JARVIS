import { useEffect, useState } from 'react'
import { Activity, Bot, Cpu, FolderGit2, Power, MessageSquare, Mic, Network, PanelLeftClose, PanelLeftOpen, Terminal } from 'lucide-react'
import { useApp, type View } from './store.ts'
import { NeuralScene } from './neural/Scene.tsx'
import { FloatingLayer } from './ui/Floating.tsx'
import { CommandBar } from './ui/CommandBar.tsx'
import { Particles } from './ui/Particles.tsx'
import { Caption } from './ui/Caption.tsx'
import { CodeView } from './ui/CodeView.tsx'
import { ProjectsView } from './ui/ProjectsView.tsx'
import { IaView } from './ui/IaView.tsx'
import { AgentView } from './ui/AgentView.tsx'
import { AisView, ChatView, SystemView, VoiceView } from './ui/Views.tsx'

const NAV: { id: View; label: string; icon: typeof Network }[] = [
  { id: 'home', label: 'Rede neural', icon: Network },
  { id: 'chat', label: 'Conversa', icon: MessageSquare },
  { id: 'code', label: 'Programar', icon: Terminal },
  { id: 'projects', label: 'Projetos', icon: FolderGit2 },
  { id: 'agent', label: 'Agente', icon: Bot },
  { id: 'ia', label: 'IA local', icon: Power },
  { id: 'ais', label: 'IAs', icon: Cpu },
  { id: 'system', label: 'Sistema', icon: Activity },
  { id: 'voice', label: 'Voz', icon: Mic },
]

/** The at-a-glance numbers live in the title bar, out of the way of the command box. */
function Stats() {
  const ov = useApp((s) => s.overview)
  if (!ov) return null
  const ais = ov.providers.filter((p) => p.enabled)
  const aisOk = ais.filter((p) => p.status?.endpoint.state === 'ok' && p.status.model.state === 'ok').length
  const svcUp = ov.services.filter((s) => s.status === 'up').length
  const open = ov.tasks.filter((t) => t.state !== 'done' && t.state !== 'cancelled').length
  return (
    <dl className="stats" aria-label="Resumo do sistema">
      <div><dt>IAs</dt><dd>{aisOk}<small>/{ais.length}</small></dd></div>
      <div><dt>Serviços</dt><dd>{svcUp}<small>/{ov.services.length}</small></dd></div>
      <div><dt>Tarefas</dt><dd>{open}</dd></div>
    </dl>
  )
}

function Home() {
  return (
    <div className="home">
      <div className="scene"><NeuralScene /></div>
      <FloatingLayer />
      <Caption />
      <p className="legend">Nós grandes = entidades reais, com pulso a cada pedido · a nuvem de neurônios é só metáfora visual · cada pasta autorizada forma a sua própria rede</p>
      <div className="home-command"><CommandBar /></div>
    </div>
  )
}

export function App() {
  const { view, setView, bridgeOk, bridgeErr, refresh, pollAudit, probe, loadProjects, collapsed, toggleSidebar } = useApp()
  // The terminal keeps its session on screen: once opened it stays mounted (hidden) when you switch views.
  const [codeOpened, setCodeOpened] = useState(false)
  useEffect(() => { if (view === 'code') setCodeOpened(true) }, [view])
  useEffect(() => {
    void refresh().then(probe)
    void pollAudit()
    void loadProjects()
    const a = setInterval(() => void refresh(), 4000)
    const b = setInterval(() => void pollAudit(), 1500)
    const c = setInterval(() => void probe(), 60000)
    return () => (clearInterval(a), clearInterval(b), clearInterval(c))
  }, [refresh, pollAudit, probe, loadProjects])

  return (
    <div className="app" data-collapsed={collapsed}>
      <Particles />
      <header className="topbar">
        <div className="topbar-left">
          <button className="icon-btn nodrag" onClick={toggleSidebar} aria-label={collapsed ? 'Abrir menu lateral' : 'Fechar menu lateral'} aria-expanded={!collapsed} title={collapsed ? 'Abrir menu' : 'Fechar menu'}>
            {collapsed ? <PanelLeftOpen size={17} /> : <PanelLeftClose size={17} />}
          </button>
          <div className="wordmark"><span className="core-dot" aria-hidden />J.A.R.V.I.S</div>
        </div>
        <div className="topbar-right">
          <Stats />
          <div className="conn" data-ok={bridgeOk}><span className="dot" data-tone={bridgeOk ? 'ok' : 'bad'} aria-hidden />{bridgeOk ? 'Bridge conectado' : bridgeErr ? 'Bridge recusou' : 'Bridge desconectado'}</div>
        </div>
      </header>
      <nav className="sidebar" aria-label="Navegação">
        {NAV.map(({ id, label, icon: Icon }) => (
          <button key={id} className="nav-item" title={label} aria-label={label} aria-current={view === id ? 'page' : undefined} onClick={() => setView(id)}>
            <Icon size={18} strokeWidth={1.6} /> <span>{label}</span>
          </button>
        ))}
      </nav>
      <main className="main">
        {view === 'home' && <Home />}
        {view === 'chat' && <ChatView />}
        {codeOpened && <div className="keep" hidden={view !== 'code'}><CodeView /></div>}
        {view === 'projects' && <ProjectsView />}
        {view === 'agent' && <AgentView />}
        {view === 'ia' && <IaView />}
        {view === 'ais' && <AisView />}
        {view === 'system' && <SystemView />}
        {view === 'voice' && <VoiceView />}
        {!bridgeOk && view !== 'home' && <p className="banner" role="status">{bridgeErr ?? 'Bridge desconectado'} — os dados abaixo podem estar desatualizados.</p>}
      </main>
    </div>
  )
}
