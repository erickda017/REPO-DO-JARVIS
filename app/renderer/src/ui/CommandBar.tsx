import { useState } from 'react'
import { ArrowUp, Lock, Volume2, Wallet } from 'lucide-react'
import { useApp } from '../store.ts'

const HINTS = ['como estão as IAs?', 'minhas tarefas', 'timer de 5 min', 'criar tarefa: revisar o roteador']

export function CommandBar({ large = false }: { large?: boolean }) {
  const [text, setText] = useState('')
  const { send, busy, sensitive, spend, speak, toggle } = useApp()
  const submit = () => {
    if (!text.trim()) return
    void send(text)
    setText('')
  }
  return (
    <div className={`command ${large ? 'large' : ''}`}>
      <div className="command-chips" role="group" aria-label="Opções do pedido">
        <button className="chip" aria-pressed={sensitive} onClick={() => toggle('sensitive')} title="O pedido nunca sai deste PC">
          <Lock size={13} /> Sensível
        </button>
        <button className="chip" aria-pressed={spend} onClick={() => toggle('spend')} title="Permite provedores pagos">
          <Wallet size={13} /> Autorizo gasto
        </button>
        <button className="chip" aria-pressed={speak} onClick={() => toggle('speak')} title="Fala a resposta em voz alta">
          <Volume2 size={13} /> Falar
        </button>
      </div>
      <div className="command-row">
        <textarea
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
      {!large && (
        <div className="hints">
          {HINTS.map((h) => (
            <button key={h} className="hint" onClick={() => void send(h)} disabled={busy}>{h}</button>
          ))}
        </div>
      )}
    </div>
  )
}
