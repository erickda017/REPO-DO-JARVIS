// What the agent may ask the INTERFACE to do (change the colour theme, open a screen, flip a switch, show a card), and the small
// queue that carries it to the app window. The window polls it; the agent never touches the page directly.
//
// The theme and view ids here must match app/renderer/src/theme.ts and the View type of the store.

export const THEMES = [
  { id: 'azul', label: 'Azul (padrão)', words: ['azul', 'ciano', 'padrão', 'padrao', 'original', 'blue', 'cyan', 'clássico', 'classico'] },
  { id: 'vermelho', label: 'Vermelho', words: ['vermelho', 'vermelha', 'red', 'carmim', 'rubro', 'sangue'] },
  { id: 'laranja', label: 'Laranja', words: ['laranja', 'orange'] },
  { id: 'ambar', label: 'Âmbar / dourado', words: ['âmbar', 'ambar', 'amarelo', 'amarela', 'dourado', 'dourada', 'ouro', 'yellow', 'gold'] },
  { id: 'verde', label: 'Verde', words: ['verde', 'green', 'matrix', 'esmeralda'] },
  { id: 'turquesa', label: 'Turquesa', words: ['turquesa', 'água', 'agua', 'teal', 'aqua'] },
  { id: 'roxo', label: 'Roxo', words: ['roxo', 'roxa', 'violeta', 'purple', 'púrpura', 'purpura'] },
  { id: 'lilas', label: 'Lilás', words: ['lilás', 'lilas', 'lavanda', 'lilac'] },
  { id: 'magenta', label: 'Magenta', words: ['magenta', 'fúcsia', 'fucsia', 'fuchsia'] },
  { id: 'rosa', label: 'Rosa', words: ['rosa', 'pink', 'rosado', 'rosinha'] },
  { id: 'gelo', label: 'Gelo / prata', words: ['gelo', 'prata', 'branco', 'branca', 'cinza', 'monocromático', 'monocromatico', 'white', 'silver'] },
]

export const VIEWS = [
  { id: 'home', label: 'Rede neural', words: ['início', 'inicio', 'home', 'rede neural', 'neural', 'principal', 'tela inicial'] },
  { id: 'chat', label: 'Conversa', words: ['conversa', 'chat', 'histórico', 'historico'] },
  { id: 'code', label: 'Programar', words: ['programar', 'programação', 'programacao', 'código', 'codigo', 'terminal', 'agente de código', 'jarvis code'] },
  { id: 'projects', label: 'Projetos', words: ['projetos', 'projeto'] },
  { id: 'agent', label: 'Agente', words: ['agente', 'permissões', 'permissoes', 'permissão', 'permissao'] },
  { id: 'missions', label: 'Missões', words: ['missões', 'missoes', 'missão', 'missao'] },
  { id: 'panels', label: 'Painéis', words: ['painéis', 'paineis', 'painel'] },
  { id: 'connectors', label: 'Conectores', words: ['conectores', 'conector', 'integrações', 'integracoes', 'contas', 'google'] },
  { id: 'mcp', label: 'Servidores MCP', words: ['mcp', 'servidores mcp', 'servidor mcp'] },
  { id: 'ia', label: 'IA local', words: ['ia local', 'modelo local', 'ias locais'] },
  { id: 'ais', label: 'IAs', words: ['ias', 'apis', 'provedores', 'modelos', 'minhas ias', 'minhas apis', 'chaves'] },
  { id: 'system', label: 'Sistema', words: ['sistema', 'tarefas', 'timer', 'cronômetro', 'cronometro', 'temporizador', 'monitor'] },
  { id: 'voice', label: 'Voz', words: ['voz', 'microfone', 'áudio', 'audio', 'som'] },
]

/** Switches the interface owns (the first three live in the window, apisOnly lives in the bridge). */
export const TOGGLES = {
  speak: { label: 'Falar as respostas em voz alta', words: ['voz', 'fala', 'falar', 'responder em voz alta', 'respostas em voz', 'som das respostas', 'narração', 'narracao'] },
  spend: { label: 'Autorizo gasto (permite IAs pagas)', words: ['autorizo gasto', 'gasto', 'ias pagas', 'api paga', 'apis pagas', 'permitir gasto', 'autorizar gasto'] },
  sensitive: { label: 'Pedido sensível (nada sai do PC)', words: ['sensível', 'sensivel', 'modo sensível', 'modo sensivel', 'privado', 'modo privado'] },
  apisOnly: { label: 'Usar só as APIs (ignorar a IA local)', words: ['só apis', 'so apis', 'somente apis', 'apenas apis', 'só as apis', 'so as apis', 'ignorar a ia local', 'sem ia local'] },
}

const norm = (s) => String(s ?? '').toLowerCase().normalize('NFD').replace(/[̀-ͯ]/g, '').trim()
const find = (list, word) => {
  const w = norm(word)
  return list.find((x) => x.id === w || x.words.some((k) => norm(k) === w)) ?? null
}
export const findTheme = (word) => find(THEMES, word)
export const findView = (word) => find(VIEWS, word)
export const findToggle = (word) => { const w = norm(word); return Object.entries(TOGGLES).find(([id, t]) => id.toLowerCase() === w || t.words.some((k) => norm(k) === w))?.[0] ?? null }
/** First theme word found anywhere in a sentence ("deixa tudo vermelho"), longest words first. */
export function themeInText(text) {
  const t = ` ${norm(text)} `
  for (const th of THEMES) for (const w of [...th.words].sort((a, b) => b.length - a.length)) if (new RegExp(`(?<![a-z])${norm(w)}(?![a-z])`).test(t)) return th
  return null
}

/** The window polls `pull(since)`; actions are kept briefly so a window that was busy still catches them. */
export function createUiBus({ max = 60, clock = Date.now } = {}) {
  let seq = 0
  const queue = []
  let state = { view: 'home', theme: 'azul', speak: false, spend: false, sensitive: false, at: 0 }
  return {
    push(action) { queue.push({ seq: ++seq, at: clock(), ...action }); if (queue.length > max) queue.shift(); return seq },
    pull(since = 0) { return { seq, actions: queue.filter((a) => a.seq > since) } },
    /** The window reports what it is showing, so the agent can answer "which theme am I using?". */
    report(s) { state = { ...state, ...s, at: clock() } },
    get state() { return { ...state } },
  }
}
