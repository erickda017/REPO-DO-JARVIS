import { useEffect, useRef, useState } from 'react'
import { AnimatePresence, motion } from 'framer-motion'
import { X } from 'lucide-react'
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

/** The dynamic layer: whatever JARVIS surfaces floats here, draggable, over the neural scene. */
export function FloatingLayer() {
  const cards = useApp((s) => s.cards)
  const bounds = useRef<HTMLDivElement>(null)
  return (
    <div className="float-layer" ref={bounds}>
      <AnimatePresence>
        {cards.map((c) => (
          <FloatCard key={c.id} card={c} bounds={bounds} />
        ))}
      </AnimatePresence>
    </div>
  )
}
