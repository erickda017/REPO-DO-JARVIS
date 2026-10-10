import { useEffect, useRef, useState } from 'react'
import { Check, Pause, Play, RefreshCw, Trash2, Square } from 'lucide-react'
import type { AppSettings } from '../global.d.ts'
import { api, ApiError, type Check as CheckT, type KeyStatus, type Priority, type ProviderView, type TaskState, type VoiceTest } from '../api.ts'
import { useApp } from '../store.ts'
import { CommandBar } from './CommandBar.tsx'
import { getMicId, getMicSounds, listMics, meterPct, openMeter, setMicId, setMicSounds, type MicDevice, type Meter } from '../voice/mic.ts'
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

function ProviderControls({ p, keys, reload }: { p: ProviderView; keys: KeyStatus[]; reload: () => void }) {
  const [secret, setSecret] = useState('')
  const [model, setModel] = useState(p.model ?? '')
  const [err, setErr] = useState('')
  const [url, setUrl] = useState((p.baseUrl ?? '').replace(/\/v1$/, ''))
  const [allowed, setAllowed] = useState((p.allowedModels ?? []).join('\n'))
  const allowedList = [...new Set(allowed.split(/\s*[\n,]\s*/).map((m) => m.trim()).filter(Boolean))]
  const key = keys.find((k) => k.name === p.keyEnv)
  const models = p.status?.models ?? []
  const act = (fn: () => Promise<unknown>) => () => void fn().then(() => setErr('')).catch((e) => setErr(e instanceof ApiError ? e.message : String(e))).finally(reload)
  const down = p.editableUrl && p.enabled && p.status != null && (p.status.endpoint.state === 'fail' || p.status.models == null)
  return (
    <div className="controls">
      {p.editableUrl && (
        <div className="ctl">
          <input value={url} onChange={(e) => setUrl(e.target.value)} placeholder="cole a URL do túnel (https://algo.trycloudflare.com)" aria-label={`Endereço de ${p.label}`} spellCheck={false} />
          <button className="btn" disabled={url.trim() === (p.baseUrl ?? '').replace(/\/v1$/, '')} onClick={act(() => api.providerUpdate(p.id, { baseUrl: url.trim() }))}>Salvar endereço</button>
        </div>
      )}
      {down && <p className="warn-text small" role="alert">Sem resposta neste endereço. A URL do túnel muda a cada sessão do Colab: gere uma nova, cole acima e salve.</p>}
      {p.keyEnv && (
        <div className="ctl">
          <input type="password" autoComplete="off" value={secret} onChange={(e) => setSecret(e.target.value)} placeholder={key?.configured ? `chave salva (…${key.last4}, ${key.source})` : `cole a chave (${p.keyEnv})`} aria-label={`Chave de ${p.label}`} />
          <button className="btn" disabled={!secret} onClick={act(() => api.setKey(p.keyEnv!, secret).then(() => setSecret('')))}>Salvar chave</button>
          {key?.source === 'panel' && !p.extraOf && <button className="btn" onClick={act(() => api.clearKey(p.keyEnv!))}>Remover</button>}
          {p.extraOf
            ? <button className="btn" title="Apaga esta chave e esta entrada da lista" onClick={() => confirm(`Remover ${p.label} e a chave salva?`) && act(() => api.removeKeyProvider(p.id))()}>Remover esta chave</button>
            : <button className="btn" title="Cria outra entrada deste serviço com uma chave própria: se a cota de uma acabar, o JARVIS usa a próxima" onClick={act(() => api.addKeyProvider(p.id))}>+ Outra chave</button>}
        </div>
      )}
      <div className="ctl">
        {models.length > 0 ? (
          <select value={model} onChange={(e) => setModel(e.target.value)} aria-label="Modelo">
            <option value="">escolha o modelo…</option>
            {models.slice(0, 300).map((m) => <option key={m}>{m}</option>)}
          </select>
        ) : (
          <input value={model} onChange={(e) => setModel(e.target.value)} placeholder="modelo (cole o id, ou salve a chave e clique em Checar)" aria-label="Modelo" />
        )}
        <button className="btn" disabled={!model || model === p.model} onClick={act(() => api.providerUpdate(p.id, { model }))}>Usar modelo</button>
        <label className="switch"><input type="checkbox" checked={p.enabled} onChange={(e) => act(() => api.providerUpdate(p.id, { enabled: e.target.checked }))()} /> Ligada</label>
        {p.external && (
          <label className="switch" title="Marque só se os modelos usados aqui não cobram (ex.: sufixo :free). Sem isso o JARVIS só usa esta IA com “autorizo gasto”.">
            <input type="checkbox" checked={!p.paid} onChange={(e) => act(() => api.providerUpdate(p.id, { free: e.target.checked }))()} /> Grátis
          </label>
        )}
      </div>
      {p.external && (
        <div className="ctl">
          <textarea rows={3} value={allowed} onChange={(e) => setAllowed(e.target.value)} placeholder="Modelos permitidos, um por linha, na ordem de uso (vazio = só o modelo escolhido acima). Se a cota de um acabar, vai para o próximo da lista." aria-label={`Modelos permitidos de ${p.label}`} />
          <button className="btn" disabled={!model || allowedList.includes(model)} onClick={() => setAllowed([...allowedList, model].join('\n'))}>Adicionar o escolhido</button>
          <button className="btn" disabled={allowedList.join('\n') === (p.allowedModels ?? []).join('\n')} onClick={act(() => api.providerUpdate(p.id, { allowedModels: allowedList }))}>Salvar lista</button>
        </div>
      )}
      {err && <p className="err small" role="alert">{err}</p>}
    </div>
  )
}

/** The OpenAI-compatible door of the router: lets the owner's own agent (or any program) get quota failover. */
function RouterDoor() {
  const [info, setInfo] = useState<{ endpoint: string; token: string; spend: boolean } | null>(null)
  const [copied, setCopied] = useState('')
  const copy = (label: string, text: string) => void navigator.clipboard.writeText(text).then(() => { setCopied(label); setTimeout(() => setCopied(''), 1500) })
  const env = info ? `LOCAL_AI_ENDPOINT=${info.endpoint}\nLOCAL_AI_API_KEY=${info.token}\nLOCAL_AI_MODEL=auto\nAI_PROVIDER_PRIORITY=local` : ''
  return (
    <section className="panel form" style={{ marginTop: 22 }}>
      <h3>Roteador para outros programas (o seu agente inclusive)</h3>
      <p className="dim small">Qualquer programa que fale o formato OpenAI pode usar este endereço: se a cota de uma IA acabar, o JARVIS passa para a próxima e o trabalho continua. Só aceita conexões deste PC e exige a chave abaixo.</p>
      {!info ? (
        <div className="actions"><button className="btn" onClick={() => void api.routerInfo().then(setInfo).catch(() => {})}>Mostrar endereço e chave</button></div>
      ) : (
        <>
          <pre className="envbox">{env}</pre>
          <div className="actions">
            <button className="btn" onClick={() => copy('env', env)}>{copied === 'env' ? 'Copiado' : 'Copiar as 4 linhas'}</button>
            <button className="btn" onClick={() => copy('key', info.token)}>{copied === 'key' ? 'Copiado' : 'Copiar só a chave'}</button>
            <label className="switch"><input type="checkbox" checked={info.spend} onChange={(e) => void api.routerSpend(e.target.checked).then((r) => setInfo({ ...info, spend: r.spend }))} /> Permitir provedores pagos por aqui</label>
          </div>
          <p className="dim small">No seu agente: cole as linhas em <code>agente-codigo\.env</code> (ou nas variáveis dele) e use o modo externo (<code>/externo</code>). Sem a opção de pagos ligada, só a IA local responde. Chamadas de ferramentas (function calling) não são traduzidas: só texto.</p>
        </>
      )}
    </section>
  )
}

/** One switch: answers, the agent, missions and panels use only the APIs and never the local model (it can also be shut down to free the RAM). */
export function ApisOnlyToggle() {
  const on = useApp((s) => s.overview?.apisOnly === true)
  const refresh = useApp((s) => s.refresh)
  const [err, setErr] = useState('')
  const flip = async (v: boolean) => {
    setErr('')
    try {
      await api.apisOnly(v)
      const jv = window.jarvis
      if (v && jv?.ia && window.confirm('Modo só APIs ligado. Desligar também a IA local agora, para liberar a RAM?')) {
        const s = await jv.ia.stop()
        if (s.error) setErr(s.error)
      }
    } catch (e) {
      setErr(e instanceof ApiError ? e.message : String(e))
    } finally {
      void refresh()
    }
  }
  return (
    <section className="panel form" style={{ marginBottom: 14 }}>
      <label className="switch"><input type="checkbox" checked={on} onChange={(e) => void flip(e.target.checked)} /> <b>Usar só as APIs</b> (ignorar a IA local)</label>
      <p className="dim small">Ligado: nenhuma resposta, agente, missão ou painel usa a IA local; só as APIs que você ligou abaixo (com chave e modelo). Provedores pagos só entram com “Autorizo gasto” no pedido, ou se você marcar a IA como <b>Grátis</b>. Pedidos marcados como <b>Sensíveis</b> não funcionam nesse modo, porque nunca saem deste PC.</p>
      {err && <p className="err small" role="alert">{err}</p>}
    </section>
  )
}

export function AisView() {
  const ov = useApp((s) => s.overview)
  const refresh = useApp((s) => s.refresh)
  const pulse = useApp((s) => s.pulse)
  const [keys, setKeys] = useState<KeyStatus[]>([])
  const loadKeys = () => void api.keys().then(setKeys).catch(() => {})
  useEffect(loadKeys, [])
  const reload = () => { loadKeys(); void refresh() }
  return (
    <div className="page">
      <h1>IAs</h1>
      <p className="dim lead">Cada IA responde a quatro perguntas separadas: alguém responde? aceita a autenticação? o modelo existe? uma inferência funcionou? Se a cota de uma acabar, o roteador passa para a próxima da lista, por prioridade, e deixa a esgotada de fora por 10 minutos.</p>
      <ApisOnlyToggle />
      <ul className="stack">
        {ov?.providers.filter((p) => !p.extraOf).flatMap((p) => [p, ...ov.providers.filter((x) => x.extraOf === p.id)]).map((p) => (
          <li key={p.id} className="panel prov">
            <div className="row-panel">
              <span className="dot big" style={{ background: TONE_COLOR[providerTone(p)] }} aria-hidden />
              <div className="grow">
                <h2>{p.label}</h2>
                <p className="dim small">{p.type} · {p.external ? 'externa' : ov?.apisOnly ? 'local · ignorada (modo só APIs)' : 'local'} · {p.paid ? 'paga' : 'sem custo'} · prioridade {p.priority}{p.enabled ? '' : ' · desligada'}{p.allowedModels?.length ? ` · ${p.allowedModels.length} modelos permitidos` : p.model ? ` · ${p.model}` : ' · sem modelo'}</p>
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
                {p.warning && <p className="warn-text small" role="alert">{p.warning}</p>}
                {p.recentErrors[0] && <p className="err small">Último erro: {p.recentErrors[0].kind} — {p.recentErrors[0].message}</p>}
              </div>
              <button className="btn" disabled={!p.enabled} onClick={run(() => api.check(p.id), () => (pulse(`ai:${p.id}`), reload()))}>
                <RefreshCw size={14} /> Checar
              </button>
            </div>
            {(p.keyEnv || p.external) && <ProviderControls p={p} keys={keys} reload={reload} />}
          </li>
        ))}
      </ul>
      <RouterDoor />
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
      <MicAndBackground />
    </div>
  )
}

/** Pick the microphone and watch a live level bar: proves the voice really arrives, before anything is transcribed or sent. */
function MicTest() {
  const [mics, setMics] = useState<MicDevice[]>([])
  const [id, setId] = useState(getMicId())
  const [sounds, setSounds] = useState(getMicSounds())
  const [testing, setTesting] = useState(false)
  const [lvl, setLvl] = useState(0)
  const [peak, setPeak] = useState(0)
  const [heard, setHeard] = useState(false)
  const [info, setInfo] = useState('')
  const [err, setErr] = useState('')
  const meter = useRef<Meter | null>(null)
  const timer = useRef(0)
  const load = () => void listMics().then((l) => { setMics(l); if (id && !l.some((m) => m.id === id)) { setId(''); setMicId('') } }).catch((e) => setErr(`Sem acesso ao microfone (${(e as Error).name}). Libere em Configurações do Windows › Privacidade › Microfone.`))
  useEffect(() => {
    load()
    navigator.mediaDevices?.addEventListener('devicechange', load) // plugging a headset in shows up by itself
    return () => navigator.mediaDevices?.removeEventListener('devicechange', load)
  // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [])
  const stop = () => { clearTimeout(timer.current); meter.current?.stop(); meter.current = null; setTesting(false); setLvl(0) }
  useEffect(() => stop, [])
  const start = async (deviceId: string) => {
    stop(); setErr(''); setPeak(0); setHeard(false)
    try {
      let hold = 0
      meter.current = await openMeter(deviceId, (rms) => {
        const p = meterPct(rms)
        setLvl(p)
        hold = Math.max(hold * 0.995, p)
        setPeak(hold)
        if (p > 0.55) setHeard(true) // about -27 dB: clearly above room noise
      })
      setInfo(`${meter.current.label || 'microfone padrão'} · ${Math.round(meter.current.rate / 1000)} kHz`)
      setTesting(true)
      timer.current = window.setTimeout(stop, 30_000) // never leave the mic open by accident
    } catch (e) {
      setErr(`Não consegui abrir o microfone (${(e as Error).name}). Confira a permissão do Windows e se ele está conectado.`)
    }
  }
  const pick = (v: string) => { setId(v); setMicId(v); if (testing) void start(v) }
  return (
    <div className="mictest">
      <div className="ctl">
        <select value={id} onChange={(e) => pick(e.target.value)} aria-label="Microfone">
          <option value="">Microfone padrão do Windows</option>
          {mics.map((m) => <option key={m.id} value={m.id}>{m.label}</option>)}
        </select>
        <button className="btn" onClick={load}>Atualizar lista</button>
        <button className="btn primary" onClick={() => (testing ? stop() : void start(id))}>{testing ? 'Parar teste' : 'Testar microfone'}</button>
      </div>
      <div className="meter" role="meter" aria-label="Volume captado pelo microfone" aria-valuemin={0} aria-valuemax={100} aria-valuenow={Math.round(lvl * 100)} data-on={testing}>
        <i style={{ width: `${lvl * 100}%` }} data-hot={lvl > 0.85} />
        <b style={{ left: `${peak * 100}%` }} />
      </div>
      <p className="small" data-tone={!testing ? 'dim' : heard ? 'ok' : 'warn'}>
        {!testing ? 'Clique em “Testar microfone” e fale: a barra acompanha a sua voz. Nada é gravado nem enviado neste teste.' : heard ? `✔ Sua voz está sendo captada · ${info}` : `Fale algo… ainda não captei nada acima do ruído · ${info}`}
      </p>
      <label className="check"><input type="checkbox" checked={sounds} onChange={(e) => { setSounds(e.target.checked); setMicSounds(e.target.checked) }} /> Sons do microfone: bipe subindo ao começar a ouvir, descendo ao parar, grave se não ouvi nada</label>
      {err && <p className="err small" role="alert">{err}</p>}
    </div>
  )
}

/** Microphone (listening command) and background behaviour of the installed app: start with Windows, live in the tray. */
function MicAndBackground() {
  const jv = window.jarvis
  const listen = useApp((s) => s.listen)
  const startListen = useApp((s) => s.startListen)
  const stopListen = useApp((s) => s.stopListen)
  const voice = useApp((s) => s.voice)
  const [cfg, setCfg] = useState<AppSettings | null>(null)
  useEffect(() => { void jv?.app?.getSettings().then(setCfg) }, [jv])
  if (!jv?.app) return null
  const set = (p: Parameters<typeof jv.app.setSettings>[0]) => void jv.app.setSettings(p).then(setCfg)
  return (
    <div className="panel form" style={{ marginTop: 16 }}>
      <h2>Microfone e segundo plano</h2>
      <p className="dim small">Diga `ouvir` na caixa de comando, clique no microfone ou use <b>{cfg?.hotkey.replace('Control', 'Ctrl') ?? 'Ctrl+Alt+J'}</b> (funciona com a janela escondida). O que você falar vira texto e é enviado como qualquer mensagem. O microfone só liga durante a escuta e desliga sozinho depois de uma pausa. A transcrição usa a chave do ElevenLabs acima: o áudio dessa frase sai deste PC para lá.</p>
      <MicTest />
      <div className="actions">
        <button className="btn" onClick={() => (listen === 'idle' ? void startListen() : stopListen())}>{listen === 'idle' ? 'Escuta completa (fala, transcreve e envia)' : 'Parar'}</button>
        <span className="dim small">{voice?.configured ? 'Transcrição pronta.' : 'Falta a chave do ElevenLabs para transcrever.'}</span>
      </div>
      {cfg && (
        <>
          <label className="check"><input type="checkbox" checked={cfg.autostart} disabled={!cfg.packaged} onChange={(e) => set({ autostart: e.target.checked })} /> Iniciar junto com o Windows (começa escondido na bandeja){!cfg.packaged && <span className="dim small"> — só no app instalado</span>}</label>
          <label className="check"><input type="checkbox" checked={cfg.closeToTray} onChange={(e) => set({ closeToTray: e.target.checked })} /> Ao fechar a janela, continuar em segundo plano (ícones ocultos). Para sair de verdade: bandeja › Sair.</label>
          {cfg.hotkey && !cfg.hotkeyActive && <p className="err small">O atalho {cfg.hotkey} não pôde ser registrado (outro programa o usa). Mude em app.json ou use o microfone.</p>}
        </>
      )}
    </div>
  )
}
