import { useCallback, useEffect, useRef, useState } from 'react'
import { LayoutDashboard, Pin, Sparkles } from 'lucide-react'
import { api, ApiError, type PanelRow } from '../api.ts'
import { useApp } from '../store.ts'
import { PanelHost } from '../genui/PanelHost.tsx'

/**
 * PAINÉIS: interfaces que o JARVIS monta para a tarefa (comparações, arquivos, progresso, monitoramento…). Cada painel é
 * uma especificação declarativa desenhada com componentes fixos; botões e formulários executam ferramentas reais, com as
 * permissões e confirmações do Agente.
 */
export function PanelsView() {
  const { sensitive, spend, panelFocus, setPanelFocus } = useApp()
  const [list, setList] = useState<PanelRow[]>([])
  const [sel, setSel] = useState<string | null>(null)
  const [prompt, setPrompt] = useState('')
  const [busy, setBusy] = useState(false)
  const [msg, setMsg] = useState('')
  const selRef = useRef<string | null>(null)
  selRef.current = sel

  const load = useCallback(() => void api.uiList().then((l) => {
    setList(l)
    setSel((cur) => (cur && l.some((p) => p.id === cur) ? cur : l[0]?.id ?? null))
  }).catch(() => {}), [])
  useEffect(() => { load(); const t = setInterval(load, 2000); return () => clearInterval(t) }, [load])
  useEffect(() => { if (panelFocus) { setSel(panelFocus); setPanelFocus(null); load() } }, [panelFocus, setPanelFocus, load])

  const fail = (e: unknown) => setMsg(e instanceof ApiError ? e.message : String(e))
  const open = (id?: string) => { if (id) { setSel(id); load() } }
  const generate = () => {
    if (!prompt.trim() || busy) return
    setBusy(true); setMsg('')
    api.uiGenerate(prompt.trim(), sensitive, spend)
      .then((r) => { if (r.ok) { setPrompt(''); open(r.id) } else setMsg(r.errors?.map((e) => e.msg).join('; ') ?? 'Não consegui gerar o painel.') })
      .catch(fail).finally(() => setBusy(false))
  }
  const template = (name: string) => api.uiTemplate(name).then((r) => (r.ok ? open(r.id) : setMsg(r.message ?? 'Não consegui criar o painel.'))).catch(fail)

  return (
    <div className="page">
      <h1>Painéis</h1>
      <p className="dim lead">Quando uma interface ajuda mais que texto, o JARVIS monta uma aqui: gráficos, tabelas, arquivos, progresso, formulários. Peça no chat (“compare…”, “mostre meus arquivos…”) ou crie um abaixo. Os botões usam as ferramentas reais e respeitam as permissões do Agente.</p>
      {msg && <p className="err small" role="alert">{msg}</p>}

      <div className="panel form">
        <label>Descreva o painel que você quer
          <textarea rows={2} value={prompt} onChange={(e) => setPrompt(e.target.value)} placeholder="Ex.: Painel para acompanhar o uso de CPU e memória, com os discos." aria-label="Descrição do painel"
            onKeyDown={(e) => { if (e.key === 'Enter' && !e.shiftKey) { e.preventDefault(); generate() } }} />
        </label>
        <div className="actions">
          <button className="btn primary" onClick={generate} disabled={!prompt.trim() || busy}><Sparkles size={14} /> {busy ? 'Gerando…' : 'Gerar painel'}</button>
          <button className="btn" onClick={() => void template('sistema')}>Sistema ao vivo</button>
          <button className="btn" onClick={() => void template('arquivos')}>Procurar arquivos</button>
          <span className="dim small">{spend ? 'IAs pagas autorizadas.' : 'Usa IA local/gratuita (ligue "autorizo gasto" na caixa de comando para as pagas).'}</span>
        </div>
      </div>

      {list.length === 0 ? (
        <p className="gu-empty" style={{ marginTop: 24 }}><LayoutDashboard size={16} style={{ verticalAlign: '-3px' }} /> Nenhum painel aberto. Peça ao JARVIS uma comparação, uma lista de arquivos ou o acompanhamento de uma tarefa.</p>
      ) : (
        <>
          <div className="gu-tablist" role="tablist" aria-label="Painéis abertos">
            {list.map((p) => (
              <button key={p.id} role="tab" aria-selected={sel === p.id} className="gu-tab" onClick={() => setSel(p.id)}>
                {p.pinned && <Pin size={11} aria-label="fixado" />} {p.title.length > 28 ? p.title.slice(0, 27) + '…' : p.title}
                <span className="gu-dot" data-status={p.status} aria-hidden />
              </button>
            ))}
          </div>
          {sel && <PanelHost key={sel} id={sel} onClose={() => void api.uiClose(sel).then(load)} />}
        </>
      )}
    </div>
  )
}
