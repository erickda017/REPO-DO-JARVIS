import { useEffect, useRef, useState } from 'react'
import { Check, Pause, Play, RefreshCw, Trash2, Square } from 'lucide-react'
import { api, ApiError, type Check as CheckT, type Priority, type TaskState, type VoiceTest } from '../api.ts'
import { useApp } from '../store.ts'
import { CommandBar } from './CommandBar.tsx'
import { providerTone, TONE_COLOR } from '../neural/graph.ts'

const run = (fn: () => Promise<unknown>, after: () => void) => () => void fn().catch(() => {}).finally(after)

export function ChatView() {
  const messages = useApp((s) => s.messages)
  const scroller = useRef<HTMLDivElement>(null)
  // Scroll the message list itself; scrollIntoView would also scroll ancestors and shove the whole shell around.
  useEffect(() => {
    const el = scroller.current
    if (el) el.scrollTop = el.scrollHeight
  }, [messages])
  return (
    <div className="page chat">
      <div className="chat-scroll" ref={scroller}>
        {messages.length === 0 && <p className="dim empty">Conversa sem Claude: as respostas vêm da IA elegível pelo roteador (local por padrão).</p>}
        {messages.map((m, i) => (
          <div key={i} className="msg" data-role={m.role}>
            <div className="msg-who">{m.role === 'user' ? 'Você' : m.role === 'error' ? 'Erro' : 'JARVIS'}</div>
            <div className="msg-text">{m.text}</div>
            {m.meta && <div className="dim small">{m.meta}</div>}
          </div>
        ))}
      </div>
      <CommandBar large />
    </div>
  )
}

function Level({ name, c }: { name: string; c: CheckT }) {
  return (
    <span className="level" data-state={c.state} title={c.detail}>
      <i aria-hidden /> {name} <b>{c.state === 'ok' ? 'ok' : c.state === 'fail' ? 'falha' : c.state === 'skipped' ? 'pulado' : '?'}</b>
    </span>
  )
}

export function AisView() {
  const ov = useApp((s) => s.overview)
  const refresh = useApp((s) => s.refresh)
  const pulse = useApp((s) => s.pulse)
  return (
    <div className="page">
      <h1>IAs</h1>
      <p className="dim lead">Quatro perguntas separadas por IA: alguém responde? aceita a autenticação? o modelo existe? uma inferência de verdade funcionou?</p>
      <ul className="stack">
        {ov?.providers.map((p) => (
          <li key={p.id} className="panel row-panel">
            <span className="dot big" style={{ background: TONE_COLOR[providerTone(p)] }} aria-hidden />
            <div className="grow">
              <h2>{p.label}</h2>
              <p className="dim small">{p.type} · {p.external ? 'externa' : 'local'} · {p.paid ? 'paga' : 'sem custo'}{p.enabled ? '' : ' · desligada'}{p.model ? ` · ${p.model}` : ''}</p>
              {p.status ? (
                <div className="levels">
                  <Level name="endpoint" c={p.status.endpoint} />
                  <Level name="auth" c={p.status.auth} />
                  <Level name="modelo" c={p.status.model} />
                  <Level name="inferência" c={p.status.inference} />
                </div>
              ) : (
                <p className="dim small">Ainda não checada.</p>
              )}
              {p.recentErrors[0] && <p className="err small">Último erro: {p.recentErrors[0].kind} — {p.recentErrors[0].message}</p>}
            </div>
            <button className="btn" disabled={!p.enabled} onClick={run(() => api.check(p.id), () => (pulse(`ai:${p.id}`), void refresh()))}>
              <RefreshCw size={14} /> Checar
            </button>
          </li>
        ))}
      </ul>
    </div>
  )
}

const PRIORITIES: Priority[] = ['low', 'normal', 'high', 'urgent']
const STATES: TaskState[] = ['todo', 'doing', 'blocked', 'done', 'cancelled']

export function SystemView() {
  const ov = useApp((s) => s.overview)
  const refresh = useApp((s) => s.refresh)
  const [title, setTitle] = useState('')
  const [prio, setPrio] = useState<Priority>('normal')
  const [secs, setSecs] = useState('300')
  const [err, setErr] = useState('')
  const guard = (fn: () => Promise<unknown>) => () => void fn().then(() => setErr('')).catch((e) => setErr(e instanceof ApiError ? e.message : String(e))).finally(() => void refresh())
  if (!ov) return <div className="page"><p className="dim">Aguardando o bridge…</p></div>
  return (
    <div className="page grid2">
      <section>
        <h1>Serviços e projetos</h1>
        <ul className="stack">
          {ov.services.map((s) => (
            <li key={s.id} className="panel row-panel">
              <span className="dot big" data-tone={s.status === 'up' ? 'ok' : s.status === 'down' ? 'bad' : s.status === 'degraded' ? 'warn' : 'unknown'} aria-hidden />
              <div className="grow">
                <h2>{s.name}</h2>
                <p className="dim small">{s.status === 'up' ? `no ar · ${s.lastLatencyMs} ms` : s.lastError ?? 'não checado'}</p>
              </div>
              <button className="icon-btn" onClick={guard(() => api.checkService(s.id))} aria-label={`Checar ${s.name}`}><RefreshCw size={15} /></button>
            </li>
          ))}
          {ov.projects.map((p) => (
            <li key={p.id} className="panel row-panel">
              <span className="dot big" data-tone={p.state === 'running' ? 'ok' : p.state === 'stopped' ? 'bad' : p.state === 'degraded' ? 'warn' : 'unknown'} aria-hidden />
              <div className="grow">
                <h2>{p.name}</h2>
                <p className="dim small">{p.state} · {p.checks.map((c) => `${c.type}:${c.ok ? 'ok' : c.unknown ? '?' : 'falha'}`).join(' ') || p.detail}</p>
              </div>
            </li>
          ))}
        </ul>
      </section>
      <section>
        <h1>Tarefas</h1>
        <div className="inline-form">
          <input value={title} onChange={(e) => setTitle(e.target.value)} placeholder="Nova tarefa" aria-label="Título da nova tarefa" onKeyDown={(e) => e.key === 'Enter' && title.trim() && (guard(() => api.createTask(title, prio))(), setTitle(''))} />
          <select value={prio} onChange={(e) => setPrio(e.target.value as Priority)} aria-label="Prioridade">{PRIORITIES.map((p) => <option key={p}>{p}</option>)}</select>
          <button className="btn" disabled={!title.trim()} onClick={() => (guard(() => api.createTask(title, prio))(), setTitle(''))}>Adicionar</button>
        </div>
        <ul className="stack">
          {ov.tasks.length === 0 && <li className="dim">Nenhuma tarefa.</li>}
          {ov.tasks.map((t) => (
            <li key={t.id} className="panel row-panel">
              <div className="grow"><h2>{t.title}</h2><p className="dim small">{t.priority}</p></div>
              <select value={t.state} onChange={(e) => guard(() => api.updateTask(t.id, { state: e.target.value as TaskState }))()} aria-label={`Estado de ${t.title}`}>{STATES.map((s) => <option key={s}>{s}</option>)}</select>
              <button className="icon-btn" aria-label={`Apagar ${t.title}`} onClick={() => confirm(`Apagar "${t.title}"?`) && guard(() => api.deleteTask(t.id))()}><Trash2 size={15} /></button>
            </li>
          ))}
        </ul>
        <h1 className="mt">Temporizador</h1>
        <div className="panel row-panel">
          <div className="grow">
            <div className="big-time">{Math.floor(Math.ceil(ov.timer.remainingMs / 1000) / 60)}:{String(Math.ceil(ov.timer.remainingMs / 1000) % 60).padStart(2, '0')}</div>
            <p className="dim small">{ov.timer.status}</p>
          </div>
          <input className="narrow" value={secs} onChange={(e) => setSecs(e.target.value)} aria-label="Segundos" inputMode="numeric" />
          <button className="icon-btn" aria-label="Iniciar" onClick={guard(() => api.timer('start', Number(secs)))}><Play size={15} /></button>
          <button className="icon-btn" aria-label="Pausar" onClick={guard(() => api.timer('pause'))}><Pause size={15} /></button>
          <button className="icon-btn" aria-label="Retomar" onClick={guard(() => api.timer('resume'))}><Check size={15} /></button>
          <button className="icon-btn" aria-label="Cancelar" onClick={guard(() => api.timer('cancel'))}><Square size={15} /></button>
        </div>
        {err && <p className="err small" role="alert">{err}</p>}
      </section>
    </div>
  )
}

export function VoiceView() {
  const voice = useApp((s) => s.voice)
  const refresh = useApp((s) => s.refresh)
  const [key, setKey] = useState('')
  const [voiceId, setVoiceId] = useState('')
  const [test, setTest] = useState<VoiceTest | null>(null)
  const [msg, setMsg] = useState('')
  const act = (fn: () => Promise<unknown>) => () => void fn().then(() => setMsg('')).catch((e) => setMsg(e instanceof ApiError ? e.message : String(e))).finally(() => void refresh())
  return (
    <div className="page narrow-page">
      <h1>Voz · ElevenLabs</h1>
      <p className="dim lead">A chave fica só neste PC (<code>data/voice.json</code>) e nunca volta para a tela. Sem chave, o JARVIS fala com a voz do sistema.</p>
      <div className="panel form">
        <p>{voice?.configured ? <>Configurada — origem <b>{voice.source}</b>, final <b>…{voice.last4}</b></> : 'Nenhuma chave configurada.'}</p>
        <label>Chave da API<input type="password" autoComplete="off" value={key} onChange={(e) => setKey(e.target.value)} placeholder="cole aqui; não será exibida de volta" /></label>
        <label>Voz
          <select value={voiceId} onChange={(e) => setVoiceId(e.target.value)}>
            <option value="">padrão do JARVIS</option>
            {test?.voices.map((v) => <option key={v.id} value={v.id}>{v.name}</option>)}
          </select>
        </label>
        <div className="actions">
          <button className="btn primary" onClick={act(() => api.voiceSet(key || undefined, voiceId || undefined).then(() => setKey('')))}>Salvar</button>
          <button className="btn" onClick={act(() => api.voiceTest().then(setTest))}>Testar e listar vozes</button>
          <button className="btn" onClick={() => confirm('Remover a chave salva neste PC?') && act(() => api.voiceClear())()}>Remover</button>
        </div>
        {test && <p className="ok-text small">Chave válida · {test.voices.length} vozes · {test.latencyMs} ms</p>}
        {msg && <p className="err small" role="alert">{msg}</p>}
      </div>
    </div>
  )
}
