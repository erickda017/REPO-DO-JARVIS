import { useLayoutEffect, useRef, useState } from 'react'
import { ArrowUp, Lock, Mic, MicOff, Volume2, Wallet } from 'lucide-react'
import { useApp } from '../store.ts'

const HINTS = ['como estão as IAs?', 'minhas tarefas', 'timer de 5 min']

/** One rounded pill: the three options sit inside as quiet icon toggles; suggestions appear only while it is empty and focused. */
export function CommandBar({ large = false }: { large?: boolean }) {
  const [text, setText] = useState('')
  const box = useRef<HTMLTextAreaElement>(null)
  // One line like a search bar; it only grows while the text needs more room.
  useLayoutEffect(() => {
    const el = box.current
    if (!el) return
    el.style.height = 'auto'
    el.style.height = `${Math.min(el.scrollHeight, 140)}px`
  }, [text])
  const { send, busy, sensitive, spend, speak, toggle, listen, listenLevel, startListen, stopListen } = useApp()
  const submit = () => {
    if (busy || !text.trim()) return // keep what was typed while an agent task is running
    void send(text)
    setText('')
  }
  const opt = (on: boolean, key: 'sensitive' | 'spend' | 'speak', label: string, Icon: typeof Lock) => (
    <button className="opt" aria-pressed={on} onClick={() => toggle(key)} title={label} aria-label={label}>
      <Icon size={15} />
    </button>
  )
  return (
    <div className={`command ${large ? 'large' : ''}`}>
      <div className="command-row">
        <div className="opts" role="group" aria-label="Opções do pedido">
          {opt(sensitive, 'sensitive', 'Sensível: o pedido nunca sai deste PC', Lock)}
          {opt(spend, 'spend', 'Autorizo gasto: permite provedores pagos', Wallet)}
          {opt(speak, 'speak', 'Falar a resposta em voz alta', Volume2)}
          <button className="opt mic" data-state={listen} style={{ '--lvl': Math.min(1, listenLevel * 14) } as React.CSSProperties} onClick={() => (listen === 'idle' ? void startListen() : stopListen())} disabled={busy && listen === 'idle'} aria-pressed={listen !== 'idle'} title={listen === 'idle' ? 'Falar (Ctrl+Alt+J)' : 'Parar de ouvir'} aria-label={listen === 'idle' ? 'Falar com o JARVIS' : 'Parar de ouvir'}>
            {listen === 'idle' ? <Mic size={15} /> : <MicOff size={15} />}
          </button>
        </div>
        <textarea
          ref={box}
          rows={1}
          value={text}
          placeholder="Fale com o JARVIS…"
          aria-label="Mensagem para o JARVIS"
          onChange={(e) => setText(e.target.value)}
          onKeyDown={(e) => {
            if (e.key === 'Enter' && !e.shiftKey) {
              e.preventDefault()
              submit()
            }
          }}
        />
        <button className="send" onClick={submit} disabled={busy || !text.trim()} aria-label="Enviar">
          {busy ? <span className="spinner" aria-hidden /> : <ArrowUp size={18} />}
        </button>
      </div>
      {!large && !text && (
        <div className="hints">
          {HINTS.map((h) => <button key={h} className="hint" onClick={() => void send(h)} disabled={busy}>{h}</button>)}
        </div>
      )}
    </div>
  )
}
