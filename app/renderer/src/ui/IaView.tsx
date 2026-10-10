import { useEffect, useState } from 'react'
import { FolderOpen, Power, Square } from 'lucide-react'
import type { IaMode, IaStatus } from '../../../electron/ia.ts'
import { useApp } from '../store.ts'
import { ApisOnlyToggle } from './Views.tsx'

const MODES: { id: IaMode; title: string; text: string; heavy?: boolean }[] = [
  { id: 'leve', title: 'Só modelo leve', text: 'Qwen 4B na porta 8082. Basta para conversar pelo JARVIS e usa ~3 GB de RAM.' },
  { id: 'so-cris', title: 'Leve + C.R.I.S', text: 'Modelo leve, chat/painel na porta 8080 e a C.R.I.S atendendo os jogadores do Umbra.' },
  { id: 'so-ia', title: 'IA completa (sem C.R.I.S)', text: 'Modelo leve + modelo pesado (35B, vários modos de esforço) e o chat local.', heavy: true },
  { id: 'completo', title: 'IA + C.R.I.S', text: 'Tudo ligado: pesado, leve, chat e C.R.I.S. É o que o atalho "IA + C.R.I.S" faz.', heavy: true },
]

const dot = (on: boolean) => <span className="dot big" data-tone={on ? 'ok' : 'off'} aria-hidden />

/** Starts and stops the owner's local AI. The launch/stop logic is the AI project's own; see electron/ia.ts. */
export function IaView() {
  const jv = window.jarvis
  const refresh = useApp((s) => s.refresh)
  const [st, setSt] = useState<IaStatus | null>(null)
  const [busy, setBusy] = useState('')
  const [err, setErr] = useState('')

  const load = () => void jv?.ia.status().then(setSt)
  useEffect(() => {
    load()
    const t = setInterval(load, 3000)
    return () => clearInterval(t)
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [])

  if (!jv) return <div className="page"><h1>IA local</h1><p className="dim">Disponível só no aplicativo desktop.</p></div>

  const act = (label: string, fn: () => Promise<IaStatus>) => async () => {
    setBusy(label)
    setErr('')
    try {
      const s = await fn()
      setSt(s)
      if (s.error) setErr(s.error)
    } finally {
      setBusy('')
      void refresh()
    }
  }
  const running = st && (st.ports.leve || st.ports.pesado || st.ports.chat)

  return (
    <div className="page">
      <h1>IA local</h1>
      <ApisOnlyToggle />
      <p className="dim lead">Liga e desliga a IA do projeto <code>ia-local</code> sem abrir janelas. É o mesmo comando dos seus atalhos, e o desligar usa o <code>PARAR_IA.bat</code> dela; a C.R.I.S e a ponte com o Umbra continuam funcionando como antes.</p>

      {!st?.valid ? (
        <div className="panel form">
          <p className="warn-text">Não achei a pasta da IA local{st?.root ? ` (${st.root})` : ''}.</p>
          <button className="btn primary" onClick={act('root', () => jv.ia.setRoot())}><FolderOpen size={14} /> Escolher a pasta</button>
        </div>
      ) : (
        <>
          <ul className="stack">
            <li className="panel row-panel">{dot(!!st.ports.leve)}<div className="grow"><h2>Modelo leve · porta 8082</h2><p className="dim small">{st.ports.leve ? 'respondendo' : 'desligado'}</p></div></li>
            <li className="panel row-panel">{dot(!!st.ports.pesado)}<div className="grow"><h2>Modelo pesado · porta 8081</h2><p className="dim small">{st.ports.pesado ? 'respondendo' : 'desligado'} · usa cerca de 12–14 GB de RAM</p></div></li>
            <li className="panel row-panel">{dot(!!st.ports.chat)}<div className="grow"><h2>Chat e C.R.I.S · porta 8080</h2><p className="dim small">{st.ports.chat ? 'respondendo' : 'desligado'}</p></div></li>
          </ul>
          <p className="dim small">RAM livre agora: <b>{st.freeGB} GB</b> de {st.totalGB} GB · pasta: <code>{st.root}</code></p>

          <h3 className="mt">Ligar</h3>
          <div className="modes">
            {MODES.map((m) => (
              <button key={m.id} className="mode" disabled={!!busy} onClick={act(m.id, () => jv.ia.start(m.id))}>
                <b><Power size={14} /> {m.title}{busy === m.id ? '…' : ''}</b>
                <span>{m.text}</span>
                {m.heavy && st.freeGB < 12 && <i className="warn-text">RAM livre baixa para o modelo pesado</i>}
              </button>
            ))}
          </div>
          <div className="actions mt">
            <button className="btn danger" disabled={!!busy || !running} onClick={act('stop', () => jv.ia.stop())}><Square size={14} /> Desligar tudo{busy === 'stop' ? '…' : ''}</button>
            <button className="btn" onClick={act('root', () => jv.ia.setRoot())}><FolderOpen size={14} /> Trocar a pasta</button>
          </div>
        </>
      )}
      {err && <p className="err small" role="alert">{err}</p>}
    </div>
  )
}
