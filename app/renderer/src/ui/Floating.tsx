import { useEffect, useRef, useState } from 'react'
import { AnimatePresence, motion } from 'framer-motion'
import { X } from 'lucide-react'
import { Check, Loader2, ShieldAlert } from 'lucide-react'
import { useApp, type Card } from '../store.ts'

function hostOf(url: string) {
  try {
    return new URL(url).host
  } catch {
    return url
  }
}

function Media({ url, mediaType, autoload }: { url: string; mediaType: 'image' | 'video'; autoload: boolean }) {
  const [on, setOn] = useState(autoload)
  const [failed, setFailed] = useState(false)
  if (!/^https?:\/\//i.test(url)) return <p className="dim">Endereço de mídia inválido.</p>
  if (!on) {
    return (
      <div className="media-gate">
        <p className="dim">Este endereço veio da resposta de uma IA. Carregá-lo mostra seu IP para <b>{hostOf(url)}</b>.</p>
        <button className="btn" onClick={() => setOn(true)}>Carregar mídia</button>
      </div>
    )
  }
  if (failed) return <p className="dim">Não foi possível carregar {hostOf(url)}.</p>
  return mediaType === 'image' ? (
    <img className="media" src={url} alt="" referrerPolicy="no-referrer" onError={() => setFailed(true)} />
  ) : (
    <video className="media" src={url} controls preload="metadata" onError={() => setFailed(true)} />
  )
}

function Countdown({ remainingMs, label }: { remainingMs: number; label: string }) {
  const [left, setLeft] = useState(remainingMs)
  useEffect(() => {
    const end = Date.now() + remainingMs
    const t = setInterval(() => setLeft(Math.max(0, end - Date.now())), 250)
    return () => clearInterval(t)
  }, [remainingMs])
  const s = Math.ceil(left / 1000)
  return (
    <div>
      <div className="big-time">{Math.floor(s / 60)}:{String(s % 60).padStart(2, '0')}</div>
      {label && <p className="dim">{label}</p>}
    </div>
  )
}

function Body({ card }: { card: Card }) {
  const b = card.body
  switch (b.type) {
    case 'text':
      return (
        <>
          <p className="card-text">{b.text}</p>
          {b.meta && <p className="dim small">{b.meta}</p>}
        </>
      )
    case 'status':
      return (
        <ul className="rows">
          {b.rows.map((r, i) => (
            <li key={i}>
              <span className="dot" data-tone={r.tone} aria-hidden />
              <span className="grow">
                <span className="row-label">{r.label}</span>
                <span className="dim small row-value">{r.value}</span>
              </span>
            </li>
          ))}
        </ul>
      )
    case 'tasks':
      return b.items.length ? (
        <ul className="rows">
          {b.items.map((t, i) => (
            <li key={i}>
              <span className="grow">{t.title}</span>
              <span className="dim small">{t.priority} · {t.state}</span>
            </li>
          ))}
        </ul>
      ) : (
        <p className="dim">Nenhuma tarefa aberta.</p>
      )
    case 'timer':
      return <Countdown remainingMs={b.remainingMs} label={b.label} />
    case 'media':
      return <Media url={b.url} mediaType={b.mediaType} autoload={b.autoload} />
  }
}

function FloatCard({ card, bounds }: { card: Card; bounds: React.RefObject<HTMLDivElement | null> }) {
  const close = useApp((s) => s.closeCard)
  const wide = card.body.type === 'media'
  return (
    <motion.section
      layout
      className="float-card"
      data-kind={card.body.type}
      style={{ width: wide ? 340 : 300 }}
      initial={{ opacity: 0, scale: 0.92, filter: 'blur(8px)' }}
      animate={{ opacity: 1, scale: 1, filter: 'blur(0px)' }}
      exit={{ opacity: 0, scale: 0.94, filter: 'blur(6px)', transition: { duration: 0.18 } }}
      transition={{ duration: 0.42, ease: [0.16, 1, 0.3, 1] }}
      drag
      dragMomentum={false}
      dragConstraints={bounds}
      aria-label={card.title}
    >
      <header>
        <h3>{card.title}</h3>
        <button className="icon-btn" onClick={() => close(card.id)} aria-label={`Fechar ${card.title}`}>
          <X size={14} />
        </button>
      </header>
      <Body card={card} />
    </motion.section>
  )
}

/** Live view of what the agent is doing: each step with its verified result, and the approval prompt for risky ones. */
function JobCard() {
  const job = useApp((s) => s.job)
  const confirmJob = useApp((s) => s.confirmJob)
  const dismiss = useApp((s) => s.dismissJob)
  const cancel = useApp((s) => s.cancelJob)
  if (!job) return null
  const res = job.result
  const label = res ? { concluido: 'Concluído', parcial: 'Parcial', nao_concluido: 'Não concluído', pergunta: 'Pergunta' }[res.status] : job.status === 'awaiting' ? 'Aguardando você' : 'Trabalhando…'
  return (
    <motion.section layout className="float-card job" data-state={res?.status ?? job.status} style={{ width: 340 }} initial={{ opacity: 0, scale: 0.94 }} animate={{ opacity: 1, scale: 1 }} exit={{ opacity: 0 }} transition={{ duration: 0.35, ease: [0.16, 1, 0.3, 1] }} aria-live="polite">
      <header>
        <h3>Agente · {label}</h3>
        <button className="icon-btn" onClick={dismiss} aria-label="Fechar o painel do agente"><X size={14} /></button>
      </header>
      <ol className="steps">
        {job.steps.map((s) => (
          <li key={s.id} data-ok={s.ok === undefined ? 'run' : s.ok ? (s.verified === false ? 'warn' : 'ok') : 'bad'}>
            <span className="step-ico" aria-hidden>{s.ok === undefined ? <Loader2 size={13} className="spin" /> : s.ok ? <Check size={13} /> : <X size={13} />}</span>
            <span className="grow"><b>{s.tool}</b>{s.why ? <span className="dim small"> — {s.why}</span> : null}
              {(s.evidence || s.error) && <span className="dim small block">{s.error ?? s.evidence}{s.denied ? ' (não autorizado)' : ''}</span>}</span>
          </li>
        ))}
      </ol>
      {job.pending && (
        <div className="confirm" role="alertdialog" aria-label="Confirmação necessária">
          <p><ShieldAlert size={15} style={{ verticalAlign: '-3px' }} /> {job.pending.message}</p>
          <div className="actions"><button className="btn primary" onClick={() => void confirmJob(true)}>Autorizar</button><button className="btn" onClick={() => void confirmJob(false)}>Negar</button></div>
        </div>
      )}
      {!res && <div className="actions"><button className="btn" onClick={() => void cancel()}>Parar</button></div>}
      {res?.audit && <p className="dim small">Auditoria independente: {res.audit.verdict} — {res.audit.reason}</p>}
      {res && res.notes.length > 0 && <ul className="notes">{res.notes.map((n, i) => <li key={i} className="small">{n}</li>)}</ul>}
    </motion.section>
  )
}

/** The dynamic layer: whatever JARVIS surfaces floats here, draggable, over the neural scene. */
export function FloatingLayer() {
  const cards = useApp((s) => s.cards)
  const bounds = useRef<HTMLDivElement>(null)
  return (
    <div className="float-layer" ref={bounds}>
      <AnimatePresence>
        <JobCard key="job" />
        {cards.map((c) => (
          <FloatCard key={c.id} card={c} bounds={bounds} />
        ))}
      </AnimatePresence>
    </div>
  )
}
