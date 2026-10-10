import { useEffect, useState } from 'react'
import { ChevronDown, ChevronRight } from 'lucide-react'
import { api, ApiError, type McpInput, type McpPreset, type McpServer, type McpTool } from '../api.ts'

const errText = (e: unknown) => (e instanceof ApiError ? e.message : String(e))
const MODE_LABEL: Record<McpTool['mode'], string> = { off: 'Desligada', confirm: 'Pedir confirmação', auto: 'Sem confirmação (leitura)' }
const STATUS: Record<McpServer['status'], [string, string]> = { stopped: ['parado', 'unknown'], starting: ['iniciando…', 'warn'], ready: ['rodando', 'ok'], error: ['com erro', 'bad'] }
const cmdline = (s: Pick<McpInput, 'command' | 'args'>) => [s.command, ...(s.args ?? [])].join(' ')

type Draft = { id?: string; label: string; transport: 'stdio' | 'http'; command: string; args: string; url: string; env: { key: string; value: string; secret: boolean; had?: boolean }[]; headers: { name: string; prefix: string; value: string; had?: boolean }[] }
const EMPTY: Draft = { label: '', transport: 'stdio', command: '', args: '', url: '', env: [], headers: [] }

const toInput = (d: Draft): McpInput => ({
  ...(d.id ? { id: d.id } : {}), label: d.label, transport: d.transport,
  ...(d.transport === 'stdio' ? { command: d.command.trim(), args: d.args.split('\n').map((a) => a.trim()).filter(Boolean), env: d.env.filter((e) => e.key.trim()).map((e) => ({ key: e.key.trim(), value: e.value, secret: e.secret })) } : { url: d.url.trim(), headers: d.headers.filter((h) => h.name.trim()).map((h) => ({ name: h.name.trim(), prefix: h.prefix, value: h.value })) }),
})

function AddForm({ presets, draft, setDraft, onSaved, onCancel }: { presets: McpPreset[]; draft: Draft; setDraft: (d: Draft) => void; onSaved: () => void; onCancel: () => void }) {
  const [msg, setMsg] = useState<{ err: boolean; text: string } | null>(null)
  const [busy, setBusy] = useState(false)
  const editing = Boolean(draft.id)
  const applyPreset = (id: string) => {
    const p = presets.find((x) => x.id === id)
    if (!p) return
    setDraft({ ...EMPTY, label: p.label.replace(/ \(.*\)$/, ''), transport: p.transport, command: p.command ?? '', args: (p.args ?? []).join('\n'), url: p.url ?? '', headers: (p.headers ?? []).map((h) => ({ name: h.name, prefix: h.prefix ?? '', value: '' })) })
    setMsg({ err: false, text: p.note })
  }
  const save = () => {
    const input = toInput(draft)
    if (draft.transport === 'stdio' && !window.confirm(`Este servidor é um PROGRAMA que vai rodar no seu PC com as suas permissões:\n\n${cmdline(input)}\n\nSó continue se você confia nele. Executar?`)) return
    setBusy(true); setMsg(null)
    api.mcpSave(input, draft.transport === 'stdio').then(() => { setDraft(EMPTY); onSaved() }).catch((e) => setMsg({ err: true, text: errText(e) })).finally(() => setBusy(false))
  }
  const set = (p: Partial<Draft>) => setDraft({ ...draft, ...p })
  return (
    <section className="panel conn mcp-form">
      <h2>{editing ? 'Editar servidor' : 'Adicionar servidor MCP'}</h2>
      {!editing && (
        <label className="conn-field"><span>Começar por uma sugestão (confira o comando antes de salvar)</span>
          <select value="" onChange={(e) => applyPreset(e.target.value)} aria-label="Sugestões de servidores"><option value="">escolha…</option>{presets.map((p) => <option key={p.id} value={p.id}>{p.label}</option>)}</select>
        </label>
      )}
      <div className="conn-fields">
        <label className="conn-field"><span>Nome *</span><input value={draft.label} onChange={(e) => set({ label: e.target.value })} aria-label="Nome do servidor" /></label>
        <label className="conn-field"><span>Tipo</span>
          <select value={draft.transport} disabled={editing} onChange={(e) => set({ transport: e.target.value as 'stdio' | 'http' })} aria-label="Tipo de servidor"><option value="stdio">Programa local (stdio)</option><option value="http">Servidor remoto (HTTP)</option></select>
        </label>
        {draft.transport === 'stdio' ? (
          <>
            <label className="conn-field"><span>Comando * (só o programa: npx, uvx, node, caminho…)</span><input value={draft.command} onChange={(e) => set({ command: e.target.value })} placeholder="npx" aria-label="Comando" /></label>
            <label className="conn-field wide"><span>Argumentos (um por linha)</span><textarea rows={3} value={draft.args} onChange={(e) => set({ args: e.target.value })} placeholder={'-y\n@modelcontextprotocol/server-memory'} aria-label="Argumentos" /></label>
            <div className="conn-field wide"><span>Variáveis de ambiente (o servidor NÃO recebe as chaves do JARVIS, só estas)</span>
              {draft.env.map((e, i) => (
                <div className="ctl" key={i}>
                  <input value={e.key} onChange={(x) => set({ env: draft.env.map((v, j) => (j === i ? { ...v, key: x.target.value } : v)) })} placeholder="NOME" aria-label="Nome da variável" style={{ maxWidth: 200 }} />
                  <input type={e.secret ? 'password' : 'text'} value={e.value} onChange={(x) => set({ env: draft.env.map((v, j) => (j === i ? { ...v, value: x.target.value } : v)) })} placeholder={e.secret && e.had ? 'salvo (deixe vazio para manter)' : 'valor'} aria-label="Valor da variável" />
                  <label className="switch"><input type="checkbox" checked={e.secret} onChange={(x) => set({ env: draft.env.map((v, j) => (j === i ? { ...v, secret: x.target.checked } : v)) })} /> segredo</label>
                  <button className="btn" onClick={() => set({ env: draft.env.filter((_, j) => j !== i) })}>Tirar</button>
                </div>
              ))}
              <div className="actions"><button className="btn" onClick={() => set({ env: [...draft.env, { key: '', value: '', secret: true }] })}>+ Variável</button></div>
            </div>
          </>
        ) : (
          <>
            <label className="conn-field wide"><span>Endereço * (https; http só para este PC ou a rede local)</span><input value={draft.url} onChange={(e) => set({ url: e.target.value })} placeholder="https://servidor.exemplo.com/mcp" aria-label="Endereço do servidor" /></label>
            <div className="conn-field wide"><span>Cabeçalhos de autenticação (o valor é guardado cifrado)</span>
              {draft.headers.map((h, i) => (
                <div className="ctl" key={i}>
                  <input value={h.name} onChange={(x) => set({ headers: draft.headers.map((v, j) => (j === i ? { ...v, name: x.target.value } : v)) })} placeholder="Authorization" aria-label="Nome do cabeçalho" style={{ maxWidth: 200 }} />
                  <input value={h.prefix} onChange={(x) => set({ headers: draft.headers.map((v, j) => (j === i ? { ...v, prefix: x.target.value } : v)) })} placeholder="Bearer " aria-label="Prefixo" style={{ maxWidth: 110 }} />
                  <input type="password" value={h.value} onChange={(x) => set({ headers: draft.headers.map((v, j) => (j === i ? { ...v, value: x.target.value } : v)) })} placeholder={h.had ? 'salvo (deixe vazio para manter)' : 'token / chave'} aria-label="Valor do cabeçalho" />
                  <button className="btn" onClick={() => set({ headers: draft.headers.filter((_, j) => j !== i) })}>Tirar</button>
                </div>
              ))}
              <div className="actions"><button className="btn" onClick={() => set({ headers: [...draft.headers, { name: 'Authorization', prefix: 'Bearer ', value: '' }] })}>+ Cabeçalho</button></div>
            </div>
          </>
        )}
      </div>
      <div className="actions">
        <button className="btn primary" disabled={busy || !draft.label.trim() || (draft.transport === 'stdio' ? !draft.command.trim() : !draft.url.trim())} onClick={save}>{editing ? 'Salvar alterações' : 'Adicionar'}</button>
        <button className="btn" onClick={onCancel}>Cancelar</button>
      </div>
      {msg && <p className={msg.err ? 'err small' : 'dim small'} role="status">{msg.text}</p>}
    </section>
  )
}

function ServerCard({ s, onChange, onEdit, onRemoved }: { s: McpServer; onChange: (s: McpServer) => void; onEdit: (s: McpServer) => void; onRemoved: () => void }) {
  const [busy, setBusy] = useState(false)
  const [msg, setMsg] = useState('')
  const [open, setOpen] = useState(false)
  const [logs, setLogs] = useState<string[] | null>(null)
  const run = (fn: () => Promise<McpServer>) => { setBusy(true); setMsg(''); void fn().then(onChange).catch((e) => setMsg(errText(e))).finally(() => setBusy(false)) }
  const [label, tone] = STATUS[s.status]
  const on = s.tools.filter((t) => t.mode !== 'off').length
  const hintsRo = s.tools.some((t) => t.hints.readOnly && t.mode === 'off')
  const toggle = (checked: boolean) => {
    if (checked && s.transport === 'stdio' && !window.confirm(`Iniciar este programa no seu PC, com as suas permissões?\n\n${cmdline(s)}`)) return
    run(() => api.mcpEnable(s.id, checked, s.transport === 'stdio'))
  }
  return (
    <li className="panel conn" data-on={s.status === 'ready'}>
      <div className="row-panel">
        <span className="dot big" data-tone={tone} aria-hidden />
        <div className="grow">
          <h2>{s.label}</h2>
          <p className="dim small">{s.transport === 'stdio' ? <code>{cmdline(s)}</code> : <code>{s.url}</code>}</p>
          <p className="dim small">{label}{s.server ? ` · ${s.server.name} ${s.server.version}` : ''}{s.status === 'ready' ? ` · ${s.tools.length} ferramentas, ${on} ligadas` : ''}</p>
        </div>
        <label className="switch"><input type="checkbox" checked={s.enabled} disabled={busy} onChange={(e) => toggle(e.target.checked)} /> Ligado</label>
      </div>
      {s.error && <p className="err small" role="alert">{s.error}</p>}
      {msg && <p className="err small" role="alert">{msg}</p>}
      <div className="actions">
        <button className="btn" disabled={busy || s.status !== 'ready'} onClick={() => run(() => api.mcpRefresh(s.id))}>Atualizar ferramentas</button>
        <button className="btn" disabled={busy} onClick={() => onEdit(s)}>Editar</button>
        <button className="btn" onClick={() => { setOpen(!open); if (!open) void api.mcpLog(s.id).then((r) => setLogs(r.lines)).catch(() => {}) }}>{open ? 'Esconder registro' : 'Registro'}</button>
        <button className="btn" disabled={busy} onClick={() => window.confirm(`Remover ${s.label}? Os segredos guardados dele também são apagados.`) && void api.mcpRemove(s.id).then(onRemoved).catch((e) => setMsg(errText(e)))}>Remover</button>
      </div>
      {open && <pre className="envbox mcp-log">{logs?.length ? logs.join('\n') : '(sem registro ainda)'}</pre>}
      {s.status === 'ready' && s.tools.length > 0 && (
        <div className="mcp-tools">
          <p className="dim small">Tudo começa <b>desligado</b>. Para cada ferramenta você escolhe: desligada, pedir confirmação a cada uso, ou sem confirmação (só para leituras em que você confia). As dicas do servidor ("só leitura", "destrutiva") são <b>sugestões dele</b>, não garantias.</p>
          {hintsRo && <div className="actions"><button className="btn" disabled={busy} onClick={() => window.confirm('Ligar SEM confirmação as ferramentas que o servidor diz serem só leitura? Você está confiando na palavra dele.') && run(() => api.mcpTrust(s.id))}>Liberar as marcadas como "só leitura"</button></div>}
          <ul className="conn-tools mcp-toollist">
            {s.tools.map((t) => (
              <li key={t.name} data-mode={t.mode}>
                <div className="mcp-toolhead">
                  <code>{t.name}</code>
                  {t.hints.readOnly && <em data-risk="read">dica: só leitura</em>}
                  {t.hints.destructive && <em data-risk="danger">dica: destrutiva</em>}
                  {t.hints.openWorld && <em data-risk="write">acessa o mundo externo</em>}
                  {t.changed && <em data-risk="danger">mudou desde que você aprovou: desligada</em>}
                  <select value={t.mode} disabled={busy} onChange={(e) => run(() => api.mcpTool(s.id, t.name, e.target.value as McpTool['mode']))} aria-label={`Modo de ${t.name}`}>
                    {(Object.keys(MODE_LABEL) as McpTool['mode'][]).map((m) => <option key={m} value={m}>{MODE_LABEL[m]}</option>)}
                  </select>
                </div>
                {t.description && <span className="dim small">{t.description}</span>}
                {Object.keys(t.params).length > 0 && <span className="dim small">parâmetros: {Object.entries(t.params).map(([k, v]) => `${k} (${v.split(' — ')[0]})`).join(', ')}</span>}
              </li>
            ))}
          </ul>
        </div>
      )}
    </li>
  )
}

/** SERVIDORES MCP: the open Model Context Protocol ecosystem. A server is code or a service from someone else: the owner adds it, and every tool is off until he switches it on. */
export function McpView() {
  const [servers, setServers] = useState<McpServer[]>([])
  const [presets, setPresets] = useState<McpPreset[]>([])
  const [err, setErr] = useState('')
  const [draft, setDraft] = useState<Draft | null>(null)
  const [help, setHelp] = useState(false)
  useEffect(() => {
    let alive = true
    let timer = 0
    const load = () => void api.mcp().then((r) => { if (alive) { setServers(r.servers); setPresets(r.presets); setErr('') } }).catch((e) => { if (alive) { setErr(errText(e)); timer = window.setTimeout(load, 3000) } })
    load()
    // a server that is starting, or restarting after a crash, updates by itself
    const poll = setInterval(() => void api.mcp().then((r) => { if (alive) setServers(r.servers) }).catch(() => {}), 4000)
    return () => { alive = false; clearTimeout(timer); clearInterval(poll) }
  }, [])
  const reload = () => void api.mcp().then((r) => { setServers(r.servers); setPresets(r.presets) }).catch(() => {})
  const put = (s: McpServer) => setServers((l) => l.map((x) => (x.id === s.id ? s : x)))
  const edit = (s: McpServer) => setDraft({ id: s.id, label: s.label, transport: s.transport, command: s.command, args: s.args.join('\n'), url: s.url, env: s.env.map((e) => ({ key: e.key, value: e.secret ? '' : e.value ?? '', secret: e.secret, had: e.configured })), headers: s.headers.map((h) => ({ name: h.name, prefix: h.prefix, value: '', had: h.configured })) })
  return (
    <div className="page">
      <h1>Servidores MCP</h1>
      <p className="dim lead">O MCP (Model Context Protocol) é um padrão aberto: centenas de servidores prontos dão ferramentas à IA (arquivos, navegador, bancos de dados, documentação, GitHub…). Aqui você os adiciona e escolhe, ferramenta por ferramenta, o que o agente pode usar. <b>Nada vem ligado.</b></p>
      <div className="panel conn mcp-warn">
        <button className="conn-toggle" onClick={() => setHelp(!help)} aria-expanded={help}>{help ? <ChevronDown size={14} /> : <ChevronRight size={14} />} Leia antes: o que muda em segurança</button>
        {help && (
          <ul className="conn-tools">
            <li>Um servidor <b>local (stdio)</b> é um programa que roda no seu PC com as suas permissões. Só adicione de fonte em que você confia. Ele recebe só as variáveis que você configurar aqui, nunca as chaves do JARVIS.</li>
            <li>O <b>agente nunca adiciona, edita nem liga</b> um servidor: só você, por esta tela.</li>
            <li>Se um servidor mudar a descrição ou os parâmetros de uma ferramenta que você aprovou, ela <b>volta a desligada</b> e fica marcada. Ferramentas novas também chegam desligadas.</li>
            <li>Descrições e resultados são <b>texto de terceiros</b>: o agente os trata como dado, e uma alteração depois de ler conteúdo externo pede confirmação extra. Pedidos marcados como sensíveis nunca usam MCP.</li>
            <li>O servidor não consegue usar o modelo de IA, as pastas nem a tela do JARVIS: o JARVIS não oferece essas capacidades.</li>
          </ul>
        )}
      </div>
      {err && <p className="err small" role="alert">{err}</p>}
      <div className="actions"><button className="btn primary" onClick={() => setDraft({ ...EMPTY })}>+ Adicionar servidor</button></div>
      {draft && <AddForm presets={presets} draft={draft} setDraft={setDraft} onSaved={() => { setDraft(null); reload() }} onCancel={() => setDraft(null)} />}
      <ul className="stack">{servers.map((s) => <ServerCard key={s.id} s={s} onChange={put} onEdit={edit} onRemoved={reload} />)}</ul>
      {servers.length === 0 && !draft && <p className="dim">Nenhum servidor ainda. Comece por uma sugestão: o servidor oficial de memória é um bom primeiro teste.</p>}
    </div>
  )
}
