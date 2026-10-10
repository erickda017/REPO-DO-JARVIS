/**
 * Pedidos simples que o JARVIS resolve SEM modelo: a frase vira uma chamada de ferramenta pronta, que passa pelo mesmo caminho de
 * permissões, confirmações e verificação do resto do agente. Só a ida à IA (segundos, e quota) é pulada. Frases com mais de uma
 * parte ou ambíguas devolvem null e vão para a IA.
 *
 * Cada comando devolve { tool, args, say?(resultado) | then }: `say` monta a resposta com os dados reais da ferramenta.
 */
import { existsSync, statSync } from 'node:fs'
import { THEMES, TOGGLES, VIEWS, findToggle, findView, themeInText } from './interface.mjs'
import { quickAction as openAction } from './rapido.mjs'

const norm = (s) => String(s ?? '').toLowerCase().normalize('NFD').replace(/[\u0300-\u036f]/g, '').replace(/\s+/g, ' ').trim()
const PREFIX = /^(?:(?:ei |oi |ola )?jarvis[,:!]?\s+)?(?:por favor[,]?\s+)?(?:(?:voce )?(?:pode|poderia|consegue)\s+)?(?:me\s+)?/
const GB = (n) => String(n).replace('.', ',')

/** C:\a b\c  (with spaces) taken from a sentence: the longest prefix that really is a folder. */
export function extractPath(text) {
  const quoted = /["'“”]([A-Za-z]:[\\/][^"'“”]+)["'“”]/.exec(text)
  const raw = quoted ? quoted[1] : /([A-Za-z]:[\\/][^\n"<>|?*]*)/.exec(text)?.[1]
  if (!raw) return null
  let cand = raw.replace(/\s+(?:e|and)\s+(?:me|diga|fale|conte|resuma|explique|mostre|veja|analise|liste)\b[\s\S]*$/i, '').replace(/[\s.,;:!?]+$/, '')
  const parts = cand.split(' ')
  for (let n = parts.length; n >= 1; n--) {
    const p = parts.slice(0, n).join(' ').replace(/[\s.,;:!?]+$/, '')
    try { if (existsSync(p) && statSync(p).isDirectory()) return p } catch { /* next */ }
  }
  return cand // may not exist: the tool says so
}

const MAIS_UM = /\b(?:e depois|depois|entao|em seguida)\b/
const secs = (n, unit) => (/^h/.test(unit) ? n * 3600 : /^min|^m$/.test(unit) ? n * 60 : n)

/** @returns {{tool: string, args: object, then?: string, say?: (r: any) => string}|null} */
export function quickAction(raw) {
  const text = String(raw ?? '').trim()
  if (!text || text.length > 600) return null
  const n = norm(text).replace(PREFIX, '').replace(/[.!?]+$/, '')
  if (!n || MAIS_UM.test(n)) return openAction(text)

  // ── cores / tema ───────────────────────────────────────────────────────────────
  if (/\btemas?\b.*\b(dispon|existem|tem\b|ha\b|quais)|\bquais (sao )?(os )?(temas|cores)\b|\blist[ae]r? (os )?temas\b/.test(n)) return { tool: 'interface_state', args: {}, say: () => `Temas de cores: ${THEMES.map((t) => t.label).join(', ')}. Diga, por exemplo, "mude o tema para roxo".` }
  const theme = themeInText(n)
  if (theme && (/^(?:tema|cor|modo|visual)\b/.test(n) || (/\b(tema|cor|cores|visual|interface|jarvis|tudo|fundo|rede|luz)\b/.test(n) && /\b(mud\w+|tro[cq]\w*|colo\w+|pon\w+|poe|deix\w+|fiqu\w+|ativ\w+|us\w+|quer\w+|bot\w+|seja|fica|vira|virar)\b/.test(n))) && n.length < 90) {
    return { tool: 'interface_theme', args: { theme: theme.id }, then: `Tema ${theme.label.split(' ')[0].toLowerCase()} aplicado.` }
  }

  // ── IAs ────────────────────────────────────────────────────────────────────────
  if (/\b(quais|como estao|estado|status|situacao|mostre|mostrar)\b.*\b(ias|apis|modelos|provedores)\b/.test(n) && n.length < 80) return { tool: 'ia_card', args: {}, say: (r) => { const on = r.data.ias.filter((i) => i.ligada && !(r.data.apisOnly && !i.externa)); return `${on.length} IA(s) em uso${r.data.apisOnly ? ' (modo só APIs: a local é ignorada)' : ''}: ${on.map((i) => `${i.nome}${i.paga ? ' (paga: só com "Autorizo gasto")' : ''}${i.endpoint === 'fail' ? ' — inacessível' : ''}`).join(', ') || 'nenhuma'}.` } }

  // ── telas do app ───────────────────────────────────────────────────────────────
  const nav = /^(?:abr\w+|v[ae]\w*|ir|me leve|leve-me|mostr\w+|mude|troque|entre|acesse|acessar|va)\s+(?:para\s+|pra\s+|em\s+|na\s+|no\s+)?(?:a\s+|o\s+|as\s+|os\s+)?(?:tela|aba|pagina|janela|secao|menu)?\s*(?:de\s+|do\s+|da\s+|dos\s+|das\s+)?(.{2,30})$/.exec(n)
  if (nav) { const v = findView(nav[1]); if (v) return { tool: 'interface_view', args: { view: v.id }, then: `Abri ${v.label}.` } }

  // ── chaves da interface ────────────────────────────────────────────────────────
  const tog = /^(lig\w+|ativ\w+|habilit\w+|deslig\w+|desativ\w+|desabilit\w+)\s+(?:a\s+|o\s+|as\s+|os\s+|modo\s+|o modo\s+)?(.{2,40})$/.exec(n)
  if (tog) {
    const key = findToggle(tog[2].replace(/^(modo|a|o)\s+/, ''))
    if (key) { const on = /^(lig|ativ|habilit)/.test(tog[1]); return { tool: 'interface_set', args: { key, value: on }, then: `${TOGGLES[key].label}: ${on ? 'ligado' : 'desligado'}.` } }
  }

  // ── hora e data ────────────────────────────────────────────────────────────────
  if (/\bque horas?\b|\bhoras?\s*\??$|\bque dia (e|eh|sera|seria)\b|\bdata de hoje\b|\bqual (e )?a data\b|\bdia da semana\b|\bhora certa\b/.test(n)) return { tool: 'clock_now', args: {}, say: (r) => `Agora são ${r.data.hora}, ${r.data.data}.` }

  // ── sistema ────────────────────────────────────────────────────────────────────
  if (/\b(painel|cartao|resumo)\b.*\b(sistema|pc|computador|maquina)\b|\b(status|estado|situacao|como (esta|anda|vai))\b.*\b(pc|computador|maquina|sistema|notebook)\b|\b(quanta?|qual)\b.*\b(ram|memoria|cpu|processador|disco|espaco)\b|\b(uso|consumo)\b.*\b(cpu|ram|memoria|disco)\b/.test(n)) {
    return { tool: 'system_card', args: {}, say: (r) => { const d = r.data; return `CPU ${d.cpu.usagePct == null ? 'sem amostra ainda' : `em ${d.cpu.usagePct}%`}, RAM ${GB(d.memory.usedGB)} de ${GB(d.memory.totalGB)} GB (${d.memory.usedPct}%)${d.disks?.length ? `. ${d.disks.map((k) => `${k.drive} ${GB(k.freeGB)} GB livres`).join(', ')}` : ''}. Ligado há ${GB(d.uptimeHours)} h.` } }
  }
  if (/\b(o que|quais?|que)\b.*\b(programas?|processos?|apps?|aplicativos?)\b.*\b(consum\w+|pesad\w+|usando|gastando|travando|comendo)\b|\bprocessos?\b.*\bmais\b.*\b(memoria|ram|cpu)\b|\b(o que|qual|quem)\b.*\b(consum\w+|pesad\w+|gastando|comendo)\b.*\b(memoria|ram|cpu|processador)\b/.test(n)) return { tool: 'sys_top', args: { by: /cpu|processador/.test(n) ? 'cpu' : 'memory', n: 6 }, say: (r) => `Os que mais pesam (${r.data.by === 'cpu' ? 'CPU' : 'memória'}): ${r.data.processes.slice(0, 6).map((p) => `${p.Name} ${p.MemMB != null ? p.MemMB + ' MB' : p.CpuPct != null ? p.CpuPct + '%' : ''}`.trim()).join(', ')}.` }
  if (/\btemperatura\b/.test(n)) return { tool: 'sys_temperature', args: {}, say: (r) => { const t = [['CPU', r.data?.cpu], ['GPU', r.data?.gpu]].filter(([, x]) => x?.available).map(([k, x]) => `${k} ${x.celsius} °C`); return t.length ? `Temperatura: ${t.join(', ')}.` : 'Este PC não expõe a temperatura da CPU nem da GPU (a placa-mãe não publica o sensor). Um app como HWiNFO ou LibreHardwareMonitor lê isso.' } }
  if (/\bbateria\b/.test(n)) return { tool: 'battery_info', args: {}, say: (r) => (r.data.disponivel ? `Bateria em ${r.data.cargaPct}%${r.data.naTomada ? ', na tomada' : ', no modo bateria'}.` : r.data.note) }
  if (/\b(meu )?(ip|endereco de rede)\b/.test(n) && !/\bchip\b/.test(n)) return { tool: 'network_info', args: {}, say: (r) => (r.data.enderecos.length ? `Seu IP na rede: ${r.data.enderecos.map((e) => `${e.ip} (${e.adaptador})`).join(', ')}.` : 'Não achei uma rede conectada.') }


  // ── som e mídia ────────────────────────────────────────────────────────────────
  const vol = /\bvolume\b.*?\b(\d{1,3})\s*%?/.exec(n) ?? (/\bvolume\b.*\b(maximo|no maximo|total)\b/.test(n) ? [0, 100] : /\bvolume\b.*\b(minimo|no minimo|zero)\b/.test(n) ? [0, 0] : null)
  if (vol && n.length < 80) return { tool: 'volume_control', args: { action: 'set', level: Number(vol[1]) }, then: `Volume em ${Math.min(Number(vol[1]), 100)}%.` }
  if (/\b(aument\w+|sub\w+|suba)\b.*\bvolume\b|\bvolume\b.*\b(mais alto|maior)\b|\bmais alto\b/.test(n) && n.length < 60) return { tool: 'volume_control', args: { action: 'up' }, then: 'Aumentei o volume.' }
  if (/\b(abaix\w+|diminu\w+|baix\w+|reduz\w+)\b.*\bvolume\b|\bvolume\b.*\b(mais baixo|menor)\b|\bmais baixo\b/.test(n) && n.length < 60) return { tool: 'volume_control', args: { action: 'down' }, then: 'Baixei o volume.' }
  if (/^(mute|mudo|silenci\w+|tire o som|tira o som|sem som|volta o som|tire do mudo|tira do mudo|desmut\w+|mut\w+)\b/.test(n)) return { tool: 'volume_control', args: { action: 'mute' }, then: 'Alternei o mudo.' }
  if (/^(paus\w+|pause|despaus\w+|continu\w+|retom\w+|play)\b/.test(n) || /\b(paus\w+|pause)\b.*\b(musica|video|player|spotify|youtube|som)\b|\b(toc\w+|reproduz\w+)\b.*\b(musica|video)\b\s*$/.test(n) && !/\b(no|na) (youtube|spotify)\b/.test(n)) return { tool: 'media_key', args: { key: 'play_pause' }, then: 'Pausei/retomei a mídia.' }
  if (/\b(proxima|pula\w*|pular|passa\w*|next)\b.*\b(musica|faixa|video)\b|^(proxima|next)\b/.test(n)) return { tool: 'media_key', args: { key: 'next' }, then: 'Próxima faixa.' }
  if (/\b(anterior|volt\w+)\b.*\b(musica|faixa|video)\b|^(anterior|previous)\b/.test(n)) return { tool: 'media_key', args: { key: 'prev' }, then: 'Faixa anterior.' }

  // ── tela, sessão, lixeira, energia, pastas ───────────────────────────────────────
  if (/\b(print|printscreen|screenshot|captur\w+ (a )?tela|tire (um )?print|tira (um )?print|foto da tela)\b/.test(n)) return { tool: 'screenshot', args: {}, say: (r) => `Print salvo em ${r.data.arquivo}.` }
  if (/\b(bloque\w+|trave|trava|travar)\b.*\b(pc|computador|tela|sessao|windows)\b/.test(n)) return { tool: 'lock_pc', args: {}, then: 'Bloqueando o PC.' }
  if (/\b(esvaz\w+|limp\w+)\b.*\blixeira\b/.test(n)) return { tool: 'recycle_empty', args: {}, then: 'Lixeira esvaziada.' }
  if (/\b(limp\w+)\b.*\btemporari\w+/.test(n)) return { tool: 'temp_clean', args: {}, say: (r) => `Temporários limpos: ${r.data.removed ?? 0} arquivo(s) removido(s), ${r.data.freedMB ?? 0} MB liberados.` }
  const cancel = /\bcancel\w+\b.*\b(desligamento|reinicio|desligar|reiniciar)\b/.test(n)
  const power = /\b(deslig\w+|reinici\w+|suspend\w+|hibern\w+)\b.*\b(pc|computador|maquina|notebook|windows)\b|^(desligar|reiniciar|suspender|hibernar)$/.exec(n)
  if (cancel) return { tool: 'power_action', args: { action: 'cancel' }, then: 'Cancelei o desligamento agendado.' }
  if (power) {
    const w = /deslig/.test(n) ? 'shutdown' : /reinici/.test(n) ? 'restart' : 'sleep'
    const d = /\b(\d+)\s*(h|horas?|min\w*|m|seg\w*|s)\b/.exec(n)
    return { tool: 'power_action', args: { action: w, ...(d ? { delaySec: secs(Number(d[1]), d[2]) } : {}) }, then: w === 'sleep' ? 'Suspendendo o PC.' : `${w === 'shutdown' ? 'Desligamento' : 'Reinício'} agendado${d ? ` para daqui a ${d[1]} ${d[2]}` : ' em 30 s'}. Diga "cancele o desligamento" para desfazer.` }
  }
  const folder = /\babr\w+\b.*\bpasta\b\s*(?:de\s+|do\s+|da\s+)?(downloads|documentos|desktop|area de trabalho|imagens|fotos|musicas?|videos|transferencias)\b/.exec(n)
  if (folder) return { tool: 'folder_open', args: { where: folder[1] }, then: `Abri a pasta ${folder[1]}.` }

  // ── analisar uma pasta/projeto (sem IA) ─────────────────────────────────────────
  if (/\b(analis\w+|inspecion\w+|examin\w+|resum\w+|descrev\w+|explic\w+|(me )?(fale|diga|conte|mostre)( sobre| o que)?|o que (e|tem|ha))\b.*\b(pasta|projeto|diretorio|repositorio|codigo)\b|\b(pasta|projeto)\b.*\b(do que se trata|o que (e|faz))\b/.test(n)) {
    const path = extractPath(text)
    if (path) return { tool: 'project_overview', args: { path }, say: (r) => `${r.data.resumo}\n\nQuer que eu abra algum arquivo em detalhe (por exemplo ${r.data.maioresArquivos?.[0]?.arquivo ?? 'o README'})?` }
  }

  // ── buscas explícitas num site ───────────────────────────────────────────────────
  const search = /^(?:pesquis\w+|procur\w+|busc\w+|toc\w+|coloc\w+|poe|bota)\s+(?:por\s+|sobre\s+)?(.+?)\s+(?:no|na|em)\s+(google|youtube|yt|bing|duckduckgo)$/.exec(n)
  if (search) {
    const q = encodeURIComponent(search[1].replace(/^(a |o )/, '').trim())
    const site = { google: `https://www.google.com/search?q=${q}`, youtube: `https://www.youtube.com/results?search_query=${q}`, yt: `https://www.youtube.com/results?search_query=${q}`, bing: `https://www.bing.com/search?q=${q}`, duckduckgo: `https://duckduckgo.com/?q=${q}` }[search[2]]
    return { tool: 'url_open', args: { url: site }, then: `Abri a busca por "${search[1]}" no ${search[2] === 'yt' ? 'YouTube' : search[2]}.` }
  }

  return openAction(text)
}

export { THEMES, VIEWS }
