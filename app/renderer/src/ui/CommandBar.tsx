import { useState } from 'react'
import { ArrowUp, Lock, Volume2, Wallet } from 'lucide-react'
import { useApp } from '../store.ts'

const HINTS = ['como estão as IAs?', 'minhas tarefas', 'timer de 5 min']

/** One rounded pill: the three options sit inside as quiet icon toggles; suggestions appear only while it is empty and focused. */
export function CommandBar({ large = false }: { large?: boolean }) {
  const [text, setText] = useState('')
  const { send, busy, sensitive, spend, speak, toggle } = useApp()
  const submit = () => {
    if (!text.trim()) return
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
        </div>
        <textarea
          rows={large ? 2 : 3}
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
