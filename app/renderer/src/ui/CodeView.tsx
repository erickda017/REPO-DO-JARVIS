import { useEffect, useMemo, useRef, useState } from 'react'
import { Terminal } from '@xterm/xterm'
import { FitAddon } from '@xterm/addon-fit'
import '@xterm/xterm/css/xterm.css'
import { FolderPlus, Play, Square } from 'lucide-react'
import { useApp } from '../store.ts'
import type { Engine } from '../global.d.ts'

const fmt = (n: number) => (n >= 1e6 ? `${(n / 1e6).toFixed(2)} M` : n >= 1e3 ? `${(n / 1e3).toFixed(1)} k` : String(n))
/** Leave alternate screen and switch off mouse/paste/focus modes a full-screen program may have left on. */
const LEAVE_TUI = '\x1b[?1049l\x1b[?1000l\x1b[?1002l\x1b[?1003l\x1b[?1006l\x1b[?2004l\x1b[?1004l\x1b[?25h\x1b[0m'
const base = (p: string) => p.split(/[\\/]/).slice(-2).join('/')

/**
 * PROGRAMAR: a real terminal (xterm.js on a ConPTY) running Claude Code, the owner's own agent, or a shell,
 * with live metrics beside it. Metrics come from Claude Code's own transcript files; the owner's agent and the
 * plain shell have none, and the panel says so instead of showing zeros.
 */
export function CodeView() {
  const { projects, metrics, events, addProject, loadProjects } = useApp()
  const [engines, setEngines] = useState<{ claude: boolean; agent: string | null } | null>(null)
  const [engine, setEngine] = useState<Engine>('claude')
  const [root, setRoot] = useState('')
  const [running, setRunning] = useState(false)
  const [err, setErr] = useState('')
  const host = useRef<HTMLDivElement>(null)
  const term = useRef<Terminal | null>(null)
  const fit = useRef<FitAddon | null>(null)
  const jv = window.jarvis

  useEffect(() => { void loadProjects(); void jv?.code.engines().then(setEngines) }, [loadProjects, jv])
  useEffect(() => { if (!root && projects[0]) setRoot(projects[0].root) }, [projects, root])

  useEffect(() => {
    if (!jv || !host.current) return
    const t = new Terminal({
      fontFamily: "'Cascadia Mono', Consolas, monospace", fontSize: 14, cursorBlink: true, allowProposedApi: true, scrollback: 5000,
      theme: { background: '#030a10', foreground: '#d7f3ff', cursor: '#4fd8ff', selectionBackground: 'rgba(79,216,255,.3)', black: '#0b1b26', brightBlack: '#4b6a78' },
    })
    const f = new FitAddon()
    t.loadAddon(f)
    t.open(host.current)
    f.fit()
    term.current = t
    fit.current = f
    const off = [
      jv.code.onData((d) => t.write(d)),
      jv.code.onExit((c) => { t.write(LEAVE_TUI + `\r\n\x1b[90m[processo encerrado, código ${c}]\x1b[0m\r\n`); setRunning(false) }),
    ]
    const dispose = t.onData((d) => jv.code.write(d))
    const ro = new ResizeObserver(() => { try { f.fit(); jv.code.resize(t.cols, t.rows) } catch { /* hidden */ } })
    ro.observe(host.current)
    const metricsOff = jv.code.onMetrics((m, ev) => useApp.getState().agentUpdate(m, ev))
    return () => { off.forEach((o) => o()); metricsOff(); dispose.dispose(); ro.disconnect(); t.dispose() }
  }, [jv])

  if (!jv) return <div className="page"><h1>Programar</h1><p className="dim">O terminal só existe no aplicativo desktop (npm run app).</p></div>

  const start = async () => {
    setErr('')
    const t = term.current!
    t.reset() // not clear(): a TUI (Claude Code) leaves the alternate screen, mouse and paste modes on, and they would leak into the next terminal
    fit.current?.fit()
    const r = await jv.code.start({ engine, cwd: root, cols: t.cols, rows: t.rows })
    if (r.ok) { setRunning(true); t.focus() } else setErr(r.error ?? 'Não foi possível iniciar.')
  }
  const stop = () => { jv.code.stop(); setRunning(false); term.current?.write(LEAVE_TUI) }
  const usable = engine === 'shell' || (engine === 'claude' && engines?.claude) || (engine === 'agent' && engines?.agent)
  const hasMetrics = engine === 'claude'
  const toolList = metrics ? Object.entries(metrics.tools).sort((a, b) => b[1] - a[1]) : []
  const maxTool = toolList[0]?.[1] ?? 1

  return (
    <div className="code">
      <div className="code-main">
        <div className="code-bar">
          <div className="seg" role="radiogroup" aria-label="Motor">
            {([['claude', 'Claude Code'], ['agent', 'Meu agente'], ['shell', 'Terminal']] as const).map(([id, label]) => (
              <button key={id} role="radio" aria-checked={engine === id} onClick={() => setEngine(id)} disabled={running}>{label}</button>
            ))}
          </div>
          <select value={root} onChange={(e) => setRoot(e.target.value)} disabled={running} aria-label="Pasta do projeto">
            {projects.length === 0 && <option value="">nenhuma pasta autorizada</option>}
            {projects.map((p) => <option key={p.root} value={p.root}>{p.name} — {p.root}</option>)}
          </select>
          <button className="btn" onClick={() => void addProject()} disabled={running}><FolderPlus size={14} /> Pasta</button>
          {engine === 'agent' && <button className="btn" onClick={() => void jv.code.setAgentPath().then((p) => setEngines((e) => (e ? { ...e, agent: p } : e)))} disabled={running}>{engines?.agent ? 'Trocar agente' : 'Definir agente'}</button>}
          {running ? <button className="btn danger" onClick={stop}><Square size={14} /> Parar</button> : <button className="btn primary" onClick={() => void start()} disabled={!usable || !root}><Play size={14} /> Iniciar</button>}
        </div>
        {!usable && <p className="dim small">{engine === 'claude' ? 'O comando "claude" não está no PATH desta máquina.' : 'Defina o arquivo que inicia o seu agente.'}</p>}
        {engine === 'agent' && engines?.agent && <p className="dim small">Agente: <code>{engines.agent}</code></p>}
        {err && <p className="err small" role="alert">{err}</p>}
        <div className="term" ref={host} />
      </div>

      <aside className="code-side" aria-label="Métricas e ações do agente">
        {!hasMetrics ? (
          <p className="dim">Sem métricas para este motor: elas vêm dos arquivos de sessão do Claude Code.</p>
        ) : !metrics ? (
          <p className="dim">Aguardando a primeira atividade do Claude Code nesta pasta…</p>
        ) : (
          <>
            <section>
              <h3>Uso da sessão</h3>
              <dl className="kv">
                <div><dt>Entrada</dt><dd>{fmt(metrics.inputTokens)}</dd></div>
                <div><dt>Saída</dt><dd>{fmt(metrics.outputTokens)}</dd></div>
                <div><dt>Cache lido</dt><dd>{fmt(metrics.cacheRead)}</dd></div>
                <div><dt>Respostas</dt><dd>{metrics.turns}</dd></div>
              </dl>
              {metrics.model && <p className="dim small">{metrics.model}</p>}
            </section>
            <section>
              <h3>Ferramentas</h3>
              <ul className="bars">
                {toolList.slice(0, 8).map(([name, n]) => (
                  <li key={name}><span>{name}</span><i style={{ width: `${(n / maxTool) * 100}%` }} /><b>{n}</b></li>
                ))}
              </ul>
              {metrics.subagentCalls > 0 && <p className="dim small">{metrics.subagentCalls} chamada(s) a subagentes</p>}
            </section>
            {metrics.todos.length > 0 && (
              <section>
                <h3>Plano</h3>
                <ul className="todos">{metrics.todos.map((t, i) => <li key={i} data-status={t.status}>{t.text}</li>)}</ul>
              </section>
            )}
            <section>
              <h3>Arquivos tocados</h3>
              <ul className="files">{metrics.files.slice(-8).reverse().map((f) => <li key={f} title={f}>{base(f)}</li>)}</ul>
            </section>
            <section>
              <h3>Ações recentes</h3>
              <ol className="timeline">
                {events.slice(-14).reverse().map((e, i) => (
                  <li key={i} data-kind={e.kind}><b>{e.tool}</b><span>{e.target ? base(e.target) : e.kind}</span></li>
                ))}
              </ol>
            </section>
          </>
        )}
      </aside>
    </div>
  )
}
