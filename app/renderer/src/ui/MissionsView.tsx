import { useCallback, useEffect, useRef, useState } from 'react'
import { Check, CircleDashed, Loader2, ShieldAlert, SkipForward, Square, X } from 'lucide-react'
import { api, ApiError, type MemoryItem, type MissionRow, type MissionStatus, type MissionStep, type MissionView } from '../api.ts'
import { useApp } from '../store.ts'

const STATUS: Record<MissionStatus, [string, string]> = {
  planning: ['Planejando', 'run'], running: ['Executando', 'run'], awaiting: ['Aguardando você', 'warn'], verifying: ['Verificando', 'run'],
  concluido: ['Concluída', 'ok'], parcial: ['Parcial', 'warn'], nao_concluido: ['Não concluída', 'bad'], cancelled: ['Cancelada', 'off'], interrupted: ['Interrompida', 'warn'],
}
const ROLE: Record<string, string> = { engenheiro: 'Engenharia', diagnostico: 'Diagnóstico', auditor: 'Auditoria', pesquisador: 'Pesquisa', windows: 'Windows', seguranca: 'Segurança', geral: 'Geral' }
const ACTIVE = new Set<MissionStatus>(['planning', 'running', 'verifying', 'awaiting'])

function StepIcon({ s }: { s: MissionStep['status'] }) {
  if (s === 'done') return <Check size={14} />
  if (s === 'running') return <Loader2 size={14} className="spin" />
  if (s === 'failed') return <X size={14} />
  if (s === 'skipped' || s === 'replaced') return <SkipForward size={14} />
  if (s === 'asking') return <ShieldAlert size={14} />
  return <CircleDashed size={14} />
}

const fmtTokens = (n: number) => (n >= 1000 ? `${(n / 1000).toFixed(1)} k` : String(n))

/**
 * MISSÕES: a goal becomes a plan with steps, each run by a specialised agent, verified independently at the end.
 * Everything shown comes from the bridge (plan, step status, tools in flight, confirmations, budget); nothing here
 * is a guess, and the final badge is the verified status, not what a model claimed.
 */
export function MissionsView() {
  const { sensitive, spend } = useApp()
  const [goal, setGoal] = useState('')
  const [list, setList] = useState<MissionRow[]>([])
  const [sel, setSel] = useState<string | null>(null)
  const [mv, setMv] = useState<MissionView | null>(null)
  const [mem, setMem] = useState<MemoryItem[]>([])
  const [autoDev, setAutoDev] = useState<boolean | null>(null)
  const [answer, setAnswer] = useState('')
  const [err, setErr] = useState('')
  const [busy, setBusy] = useState(false)
  const selRef = useRef<string | null>(null)
  selRef.current = sel

  const fail = (e: unknown) => setErr(e instanceof ApiError ? e.message : String(e))
  const loadList = useCallback(() => void api.missionList().then((l) => { setList(l); setErr(''); if (!selRef.current && l[0]) setSel(l[0].id) }).catch(fail), [])
  const loadMem = () => void api.memory().then(setMem).catch(() => {})
  useEffect(() => {
    loadList(); loadMem()
    void api.agentAccess().then((a) => setAutoDev(a.autoDev === true)).catch(() => {})
    const t = setInterval(() => {
      loadList()
      if (selRef.current) void api.missionView(selRef.current).then(setMv).catch(() => {})
    }, 1200)
    return () => clearInterval(t)
  }, [loadList])
  useEffect(() => { if (sel) void api.missionView(sel).then(setMv).catch(fail) }, [sel])

  const start = () => {
    if (!goal.trim() || busy) return
    setBusy(true); setErr('')
    api.missionStart(goal.trim(), sensitive, spend).then((r) => { setGoal(''); setSel(r.id); loadList() }).catch(fail).finally(() => setBusy(false))
  }
  const active = mv && ACTIVE.has(mv.status)

  return (
    <div className="page">
      <h1>Missões</h1>
      <p className="dim lead">Descreva um trabalho completo. O JARVIS monta um plano, entrega cada etapa a um agente especializado, corrige o que falhar (com limites), e só chama de concluído depois de uma verificação independente. Confirmações de risco aparecem aqui.</p>
      {err && <p className="err small" role="alert">{err}</p>}

      <div className="panel form">
        <label>Objetivo
          <textarea rows={3} value={goal} onChange={(e) => setGoal(e.target.value)} placeholder="Ex.: Analise o projeto em C:\meu-app, ache por que os testes falham, corrija e rode os testes de novo." aria-label="Objetivo da missão" />
        </label>
        <div className="actions">
          <button className="btn primary" onClick={start} disabled={!goal.trim() || busy}>Iniciar missão</button>
          <span className="dim small">{sensitive ? 'Modo sensível: nada sai deste PC. ' : ''}{spend ? 'Provedores pagos autorizados.' : 'Só IAs gratuitas/locais (ligue "autorizo gasto" na caixa de comando para usar as pagas).'}</span>
        </div>
        {autoDev !== null && (
          <label className="check"><input type="checkbox" checked={autoDev} onChange={(e) => void api.agentAutonomy(e.target.checked).then((r) => setAutoDev(r.autoDev)).catch(fail)} /> Autonomia de desenvolvimento: rodar testes, builds e servidores das pastas liberadas sem pedir confirmação a cada comando (precisa do grupo "Desenvolvimento" ligado na tela Agente; continua pedindo para tudo que apaga ou sobrescreve).</label>
        )}
      </div>

      <div className="grid2" style={{ marginTop: 16 }}>
        <section>
          <h3>Missões</h3>
          <ul className="stack">
            {list.length === 0 && <li className="dim small">Nenhuma missão ainda.</li>}
            {list.map((m) => (
              <li key={m.id}>
                <button className="panel row-panel mission-row" aria-current={sel === m.id} onClick={() => setSel(m.id)}>
                  <span className="grow"><b>{m.goal}</b><br /><small className="dim">{m.done}/{m.steps} etapas · {new Date(m.createdAt).toLocaleTimeString('pt-BR')}</small></span>
                  <span className="chip" data-tone={STATUS[m.status][1]}>{STATUS[m.status][0]}</span>
                </button>
              </li>
            ))}
          </ul>
          <h3 className="mt">Memória operacional</h3>
          <p className="dim small">O que os agentes aprenderam (hipóteses aparecem como tal).</p>
          <ul className="stack">
            {mem.length === 0 && <li className="dim small">Vazia.</li>}
            {mem.slice(0, 8).map((i) => (
              <li key={i.id} className="panel row-panel">
                <span className="grow small"><b>{i.kind}</b>{i.confidence === 'unverified' ? ' · não confirmado' : ''} — {i.text}</span>
                <button className="icon-btn" aria-label="Esquecer" onClick={() => void api.memoryForget(i.id).then(loadMem)}><X size={14} /></button>
              </li>
            ))}
          </ul>
        </section>

        <section aria-live="polite">
          {!mv ? <p className="dim">Selecione ou inicie uma missão.</p> : (
            <>
              <div className="row-panel" style={{ padding: 0 }}>
                <h3 className="grow" style={{ margin: 0 }}>{mv.goal.length > 90 ? mv.goal.slice(0, 90) + '…' : mv.goal}</h3>
                <span className="chip" data-tone={STATUS[mv.status][1]}>{STATUS[mv.status][0]}</span>
              </div>
              <p className="dim small">Fase: {mv.phase} · {fmtTokens(mv.usage.inputTokens + mv.usage.outputTokens)} tokens de {fmtTokens(mv.limits.maxTokens)} · {mv.usage.calls} chamadas a modelos · replanejamentos {mv.replans}/{mv.limits.maxReplans}</p>
              {mv.criteria.length > 0 && <><h3>Critérios de sucesso</h3><ul className="notes">{mv.criteria.map((c, i) => <li key={i} className="small">{c}</li>)}</ul></>}
              <h3>Plano</h3>
              <ol className="steps mission-steps">
                {mv.steps.map((s) => (
                  <li key={s.id} data-ok={s.status === 'done' ? 'ok' : s.status === 'failed' ? 'bad' : s.status === 'running' ? 'run' : s.status === 'asking' ? 'warn' : ''}>
                    <span className="step-ico" aria-hidden><StepIcon s={s.status} /></span>
                    <span className="grow"><b>{s.title}</b> <span className="chip small" data-tone="off">{ROLE[s.role] ?? s.role}</span>{s.attempts > 1 ? <span className="dim small"> · tentativa {s.attempts}</span> : null}{s.depends.length ? <span className="dim small"> · depende de {s.depends.join(', ')}</span> : null}
                      {s.summary && <span className="dim small block">{s.summary}</span>}
                      {s.notes?.length ? <span className="dim small block">{s.notes.join(' · ')}</span> : null}
                      {s.status === 'asking' && (
                        <span className="block">
                          <span className="small">{s.question}</span>
                          <span className="inline-form"><input value={answer} onChange={(e) => setAnswer(e.target.value)} aria-label="Sua resposta" /><button className="btn primary" onClick={() => void api.missionAnswer(mv.id, answer).then(() => setAnswer('')).catch(fail)}>Responder</button></span>
                        </span>
                      )}
                    </span>
                  </li>
                ))}
              </ol>
              {mv.active.length > 0 && <p className="small dim">Agora: {mv.active.map((a) => `${a.step} (${ROLE[a.role ?? ''] ?? a.role}${a.provider ? `, ${a.provider}` : ''}) ${a.tools.join(' ')}`).join(' · ')}</p>}
              {mv.pending.map((p) => (
                <div key={p.id} className="confirm" role="alertdialog" aria-label="Confirmação necessária">
                  <p><ShieldAlert size={15} style={{ verticalAlign: '-3px' }} /> {p.message}</p>
                  <div className="actions"><button className="btn primary" onClick={() => void api.missionConfirm(mv.id, true)}>Autorizar</button><button className="btn" onClick={() => void api.missionConfirm(mv.id, false)}>Negar</button></div>
                </div>
              ))}
              {mv.verification?.verdict && <p className="small"><b>Verificação independente:</b> {mv.verification.verdict}. <span className="dim">{mv.verification.text}</span></p>}
              {mv.final && <p className="small" data-tone={STATUS[mv.status][1]}><b>Resultado:</b> {mv.final.text}</p>}
              <div className="actions">
                {active && <button className="btn danger" onClick={() => void api.missionCancel(mv.id)}><Square size={14} /> Cancelar</button>}
                {(mv.status === 'interrupted' || mv.status === 'awaiting') && <button className="btn primary" onClick={() => void api.missionResume(mv.id).catch(fail)}>Retomar</button>}
              </div>
              <details><summary className="small dim">Registro da missão</summary>
                <ul className="notes">{mv.log.map((l, i) => <li key={i} className="small" data-kind={l.kind}><span className="dim">{new Date(l.at).toLocaleTimeString('pt-BR')}</span> {l.text}</li>)}</ul>
              </details>
            </>
          )}
        </section>
      </div>
    </div>
  )
}
