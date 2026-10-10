import { isRef, parseRef } from './resolve.mjs'

/**
 * Generative UI spec, version 1: a declarative description of a panel (layout, components, data bindings, actions).
 * The model never produces code or markup: only this JSON, validated here and rendered by a FIXED set of components.
 * Validation is strict about structure (unknown component types and malformed actions are errors), tolerant about
 * decoration (unknown properties are dropped with a warning), and bounded (size, depth, node count).
 *
 * validateSpec(spec) -> { ok, errors: [{path, msg}], warnings: [{path, msg}], spec }   (spec = the sanitised copy)
 */
export const LIMITS = { nodes: 200, depth: 8, str: 2000, label: 120, dataBytes: 300_000, rows: 500, actions: 40, sources: 12, fields: 24, columns: 16, tabs: 8, items: 200 }
export const TONES = ['neutral', 'ok', 'warn', 'bad', 'info', 'accent']
const FORMATS = ['text', 'number', 'bytes', 'percent', 'date', 'duration', 'mb', 'gb']
const KEY = /^[\w.-]{1,40}$/
const BANNED_TOOLS = new Set(['run_command', 'proc_close', 'profile_apply', 'memory_remember'])

const isObj = (v) => v !== null && typeof v === 'object' && !Array.isArray(v)

export const NODE_TYPES = ['stack', 'grid', 'split', 'tabs', 'card', 'text', 'stat', 'kv', 'alert', 'progress', 'steps', 'empty', 'table', 'list', 'chart', 'log', 'files', 'results', 'form', 'control', 'button']

export function validateSpec(input) {
  const errors = []
  const warnings = []
  const err = (path, msg) => errors.push({ path, msg })
  const warn = (path, msg) => warnings.push({ path, msg })
  if (!isObj(input)) return { ok: false, errors: [{ path: '', msg: 'a especificação precisa ser um objeto' }], warnings, spec: null }
  let bytes = 0
  try { bytes = JSON.stringify(input).length } catch { return { ok: false, errors: [{ path: '', msg: 'a especificação não é JSON' }], warnings, spec: null } }
  if (bytes > LIMITS.dataBytes * 1.2) return { ok: false, errors: [{ path: '', msg: `especificação grande demais (${bytes} bytes)` }], warnings, spec: null }

  const spec = { v: 1 }
  if (input.v !== undefined && input.v !== 1) err('v', 'versão não suportada (use 1)')
  const str = (v, path, max = LIMITS.label, { required = false } = {}) => {
    if (v === undefined || v === null) { if (required) err(path, 'obrigatório'); return undefined }
    if (typeof v !== 'string') { err(path, 'precisa ser texto'); return undefined }
    if (v.length > max) { warn(path, `texto cortado em ${max} caracteres`); return v.slice(0, max) }
    return v
  }
  const refOk = (v, path) => {
    if (!parseRef(v.ref)) { err(path, `referência inválida: ${String(v.ref).slice(0, 60)} (use data.x, state.x, row.x ou form.x)`); return false }
    return true
  }
  /** A value that may be a literal (checked by `check`) or a {ref}. */
  const bindable = (v, path, check) => {
    if (v === undefined) return undefined
    if (isRef(v)) return refOk(v, path) ? { ref: v.ref } : undefined
    return check(v, path)
  }
  const num = (v, path) => (typeof v === 'number' && Number.isFinite(v) ? v : (err(path, 'precisa ser número'), undefined))
  const text = (v, path) => (typeof v === 'string' ? v.slice(0, LIMITS.str) : typeof v === 'number' || typeof v === 'boolean' ? String(v) : (err(path, 'precisa ser texto'), undefined))
  const label = (v, path) => (typeof v === 'string' ? v.slice(0, LIMITS.label) : typeof v === 'number' ? String(v) : (err(path, 'precisa ser texto'), undefined))
  const enumOf = (list) => (v, path) => (list.includes(v) ? v : (err(path, `valor inválido (${list.join(' | ')})`), undefined))
  const tone = enumOf(TONES)
  const bool = (v, path) => (typeof v === 'boolean' ? v : (err(path, 'precisa ser verdadeiro/falso'), undefined))
  const arrayOrRef = (v, path, max = LIMITS.rows) => {
    if (v === undefined) return undefined
    if (isRef(v)) return refOk(v, path) ? { ref: v.ref } : undefined
    if (!Array.isArray(v)) { err(path, 'precisa ser uma lista ou {ref}'); return undefined }
    if (v.length > max) warn(path, `lista cortada em ${max} itens`)
    return v.slice(0, max)
  }

  /** Keep only the ref and one scalar comparison: a condition can never carry anything else. */
  const cond = (c) => { const o = { ref: c.ref }; for (const k of ['eq', 'ne']) if (k in c && ['string', 'number', 'boolean'].includes(typeof c[k])) o[k] = c[k]; for (const k of ['gt', 'lt']) if (k in c && typeof c[k] === 'number') o[k] = c[k]; return o }

  let nodeCount = 0
  const ids = new Set()
  const actionIds = new Set()

  // ---- actions first (nodes reference them)
  const actions = {}
  if (input.actions !== undefined) {
    if (!isObj(input.actions)) err('actions', 'precisa ser um objeto')
    else for (const [id, a] of Object.entries(input.actions).slice(0, LIMITS.actions)) {
      const p = `actions.${id}`
      if (!KEY.test(id)) { err(p, 'id de ação inválido'); continue }
      if (!isObj(a)) { err(p, 'ação inválida'); continue }
      const out = { type: a.type }
      if (a.type === 'tool') {
        out.tool = str(a.tool, `${p}.tool`, 40, { required: true })
        if (out.tool && BANNED_TOOLS.has(out.tool)) err(`${p}.tool`, `a ferramenta ${out.tool} não pode ser usada por botões`)
        if (a.args !== undefined) out.args = isObj(a.args) ? a.args : (err(`${p}.args`, 'precisa ser um objeto'), undefined)
        if (a.into !== undefined) { const t = typeof a.into === 'string' ? a.into.replace(/\+$/, '') : ''; if (parseRef(t)?.[0] === 'data' && t.split('.').length >= 2) out.into = a.into; else err(`${p}.into`, 'use data.nome (ou data.nome+ para acrescentar)') }
        if (a.pick !== undefined) out.pick = str(a.pick, `${p}.pick`, 80)
        if (a.refresh !== undefined) out.refresh = [].concat(a.refresh).filter((x) => typeof x === 'string' && KEY.test(x)).slice(0, 8)
        if (a.setState !== undefined) out.setState = isObj(a.setState) ? a.setState : undefined
        if (a.messages !== undefined && isObj(a.messages)) out.messages = { loading: str(a.messages.loading, `${p}.messages.loading`, 120), ok: str(a.messages.ok, `${p}.messages.ok`, 200), error: str(a.messages.error, `${p}.messages.error`, 200) }
      } else if (a.type === 'state') {
        if (!isObj(a.set)) err(`${p}.set`, 'precisa ser um objeto')
        else out.set = a.set
      } else if (a.type === 'ask') out.text = str(a.text, `${p}.text`, LIMITS.str, { required: true })
      else if (a.type === 'mission') out.goal = str(a.goal, `${p}.goal`, LIMITS.str, { required: true })
      else if (a.type === 'missionop') { out.op = enumOf(['cancel', 'confirm', 'resume'])(a.op, `.op`); out.approve = a.approve === true }
      else if (a.type === 'refresh') out.sources = [].concat(a.sources ?? []).filter((x) => typeof x === 'string' && KEY.test(x)).slice(0, 8)
      else if (a.type === 'close') { /* nothing */ } else { err(`${p}.type`, 'tipo de ação desconhecido (tool | state | ask | mission | missionop | refresh | close)'); continue }
      if (a.confirm !== undefined) out.confirm = str(a.confirm, `${p}.confirm`, 300)
      actions[id] = out
      actionIds.add(id)
    }
  }
  const act = (v, path) => {
    if (v === undefined) return undefined
    if (typeof v !== 'string' || !actionIds.has(v)) { err(path, `ação desconhecida: ${String(v).slice(0, 40)} (declare em "actions")`); return undefined }
    return v
  }
  const params = (v, path) => (v === undefined ? undefined : isObj(v) ? v : (err(path, 'precisa ser um objeto'), undefined))
  const rowActions = (v, path) => {
    if (v === undefined) return undefined
    if (!Array.isArray(v)) { err(path, 'precisa ser uma lista'); return undefined }
    return v.slice(0, 6).map((a, i) => (isObj(a) ? { label: label(a.label, `${path}[${i}].label`), action: act(a.action, `${path}[${i}].action`), params: params(a.params, `${path}[${i}].params`), tone: a.tone === undefined ? undefined : tone(a.tone, `${path}[${i}].tone`), confirm: str(a.confirm, `${path}[${i}].confirm`, 300) } : (err(`${path}[${i}]`, 'ação de linha inválida'), null))).filter((a) => a && a.action)
  }
  const field = (f, path) => {
    if (!isObj(f)) { err(path, 'campo inválido'); return null }
    if (!KEY.test(String(f.name ?? ''))) { err(`${path}.name`, 'nome de campo inválido (letras, números, _ . -)'); return null }
    const kind = enumOf(['text', 'number', 'select', 'toggle', 'slider', 'textarea', 'path'])(f.kind ?? 'text', `${path}.kind`)
    const out = { name: f.name, kind, label: label(f.label ?? f.name, `${path}.label`), required: f.required === true, placeholder: str(f.placeholder, `${path}.placeholder`, 120), hint: str(f.hint, `${path}.hint`, 200) }
    if (f.default !== undefined) out.default = ['string', 'number', 'boolean'].includes(typeof f.default) ? f.default : undefined
    if (kind === 'select') out.options = Array.isArray(f.options) ? f.options.slice(0, 50).map((o) => (isObj(o) ? { value: String(o.value ?? o.label ?? ''), label: label(o.label ?? o.value, `${path}.options`) } : { value: String(o), label: String(o).slice(0, LIMITS.label) })) : (err(`${path}.options`, 'select precisa de options'), [])
    if (kind === 'number' || kind === 'slider') { for (const k of ['min', 'max', 'step']) if (f[k] !== undefined) out[k] = num(f[k], `${path}.${k}`) }
    if (f.pattern !== undefined) { const pat = str(f.pattern, `${path}.pattern`, 100); try { if (pat) { new RegExp(pat); out.pattern = pat } } catch { err(`${path}.pattern`, 'expressão regular inválida') } }
    return out
  }

  // ---- nodes
  const children = (list, path, depth) => {
    if (!Array.isArray(list)) { err(path, 'precisa ser uma lista de componentes'); return [] }
    return list.slice(0, LIMITS.items).map((c, i) => node(c, `${path}[${i}]`, depth + 1)).filter(Boolean)
  }
  const node = (n, path, depth) => {
    if (!isObj(n)) { err(path, 'componente inválido'); return null }
    if (depth > LIMITS.depth) { err(path, `aninhamento acima de ${LIMITS.depth} níveis`); return null }
    if (++nodeCount > LIMITS.nodes) { if (nodeCount === LIMITS.nodes + 1) err(path, `mais de ${LIMITS.nodes} componentes`); return null }
    const type = n.type
    if (!NODE_TYPES.includes(type)) { err(`${path}.type`, `componente desconhecido: ${String(type).slice(0, 30)} (use: ${NODE_TYPES.join(', ')})`); return null }
    let id = n.id
    if (id !== undefined) { if (typeof id !== 'string' || !KEY.test(id)) { err(`${path}.id`, 'id inválido'); id = undefined } else if (ids.has(id)) { err(`${path}.id`, `id repetido: ${id}`); id = undefined } }
    if (!id) { id = `n${nodeCount}`; while (ids.has(id)) id += '_' }
    ids.add(id)
    const out = { type, id }
    if (n.show !== undefined) out.show = isRef(n.show) ? (refOk(n.show, `${path}.show`) ? cond(n.show) : undefined) : bool(n.show, `${path}.show`)
    if (n.loading !== undefined) out.loading = bindable(n.loading, `${path}.loading`, bool)
    if (n.error !== undefined) out.error = bindable(n.error, `${path}.error`, text)
    const known = new Set(['type', 'id', 'show', 'loading', 'error'])
    const take = (key, fn) => { known.add(key); if (n[key] !== undefined) { const v = fn(n[key], `${path}.${key}`); if (v !== undefined) out[key] = v } }
    switch (type) {
      case 'stack': take('gap', enumOf(['sm', 'md', 'lg'])); take('dir', enumOf(['v', 'h'])); known.add('children'); out.children = children(n.children ?? [], `${path}.children`, depth); break
      case 'grid': take('cols', (v, p) => (Number.isInteger(v) && v >= 1 && v <= 6 ? v : (err(p, 'cols entre 1 e 6'), undefined))); take('gap', enumOf(['sm', 'md', 'lg'])); known.add('children'); out.children = children(n.children ?? [], `${path}.children`, depth); break
      case 'split': take('ratio', (v, p) => (typeof v === 'number' && v > 0.1 && v < 0.9 ? v : (err(p, 'ratio entre 0.1 e 0.9'), undefined))); known.add('children'); out.children = children(n.children ?? [], `${path}.children`, depth).slice(0, 2); break
      case 'card': take('title', (v, p) => bindable(v, p, label)); take('subtitle', (v, p) => bindable(v, p, label)); take('tone', tone); known.add('children'); out.children = children(n.children ?? [], `${path}.children`, depth); break
      case 'tabs': {
        known.add('tabs'); take('stateKey', (v, p) => (KEY.test(String(v)) ? v : (err(p, 'chave inválida'), undefined)))
        if (!Array.isArray(n.tabs) || !n.tabs.length) { err(`${path}.tabs`, 'tabs precisa de ao menos uma aba'); out.tabs = [] } else {
          out.tabs = n.tabs.slice(0, LIMITS.tabs).map((t, i) => (isObj(t) && KEY.test(String(t.id ?? '')) ? { id: t.id, label: label(t.label ?? t.id, `${path}.tabs[${i}].label`), children: children(t.children ?? [], `${path}.tabs[${i}].children`, depth + 1) } : (err(`${path}.tabs[${i}]`, 'aba inválida (id e label)'), null))).filter(Boolean)
        }
        break
      }
      case 'text': take('text', (v, p) => bindable(v, p, text)); take('variant', enumOf(['body', 'title', 'caption', 'code'])); take('tone', tone); if (out.text === undefined) err(`${path}.text`, 'obrigatório'); break
      case 'stat': take('label', (v, p) => bindable(v, p, label)); take('value', (v, p) => bindable(v, p, (x, q) => (['string', 'number'].includes(typeof x) ? x : (err(q, 'precisa ser texto ou número'), undefined)))); take('unit', (v, p) => str(v, p, 20)); take('delta', (v, p) => bindable(v, p, label)); take('tone', tone); take('hint', (v, p) => bindable(v, p, label)); if (out.value === undefined) err(`${path}.value`, 'obrigatório'); break
      case 'kv': take('items', (v, p) => arrayOrRef(v, p, 60)); break
      case 'alert': take('tone', tone); take('title', (v, p) => bindable(v, p, label)); take('text', (v, p) => bindable(v, p, text)); break
      case 'progress': take('value', (v, p) => bindable(v, p, num)); take('max', (v, p) => bindable(v, p, num)); take('label', (v, p) => bindable(v, p, label)); take('tone', tone); if (out.value === undefined) err(`${path}.value`, 'obrigatório'); break
      case 'steps': take('items', (v, p) => arrayOrRef(v, p, 60)); break
      case 'empty': take('text', (v, p) => bindable(v, p, text)); break
      case 'table': {
        take('rows', (v, p) => arrayOrRef(v, p))
        known.add('columns')
        if (!Array.isArray(n.columns) || !n.columns.length) err(`${path}.columns`, 'table precisa de columns')
        else out.columns = n.columns.slice(0, LIMITS.columns).map((c, i) => (isObj(c) && KEY.test(String(c.key ?? '')) ? { key: c.key, label: label(c.label ?? c.key, `${path}.columns[${i}].label`), align: ['left', 'right', 'center'].includes(c.align) ? c.align : undefined, format: c.format === undefined ? undefined : enumOf(FORMATS)(c.format, `${path}.columns[${i}].format`) } : (err(`${path}.columns[${i}]`, 'coluna inválida (key)'), null))).filter(Boolean)
        take('sortable', bool); take('filter', bool); take('pageSize', (v, p) => (Number.isInteger(v) && v >= 5 && v <= 100 ? v : (err(p, 'pageSize entre 5 e 100'), undefined))); take('rowKey', (v, p) => str(v, p, 40)); take('rowActions', rowActions); take('selectable', bool); take('bulkActions', rowActions); take('empty', (v, p) => str(v, p, 160)); break
      }
      case 'list': take('items', (v, p) => arrayOrRef(v, p)); take('titleKey', (v, p) => str(v, p, 40)); take('subtitleKey', (v, p) => str(v, p, 40)); take('badgeKey', (v, p) => str(v, p, 40)); take('itemActions', rowActions); take('empty', (v, p) => str(v, p, 160)); break
      case 'chart': {
        take('kind', enumOf(['bar', 'hbar', 'line', 'area', 'pie', 'donut', 'spark'])); take('data', (v, p) => arrayOrRef(v, p, 300)); take('x', (v, p) => str(v, p, 40)); take('unit', (v, p) => str(v, p, 20)); take('title', (v, p) => str(v, p, 80)); take('stacked', bool); take('height', (v, p) => (Number.isInteger(v) && v >= 80 && v <= 480 ? v : (err(p, 'height entre 80 e 480'), undefined)))
        known.add('series')
        if (n.series !== undefined) out.series = Array.isArray(n.series) ? n.series.slice(0, 8).map((s, i) => (isObj(s) && KEY.test(String(s.key ?? '')) ? { key: s.key, label: label(s.label ?? s.key, `${path}.series[${i}].label`), tone: s.tone === undefined ? undefined : tone(s.tone, `${path}.series[${i}].tone`) } : (err(`${path}.series[${i}]`, 'série inválida (key)'), null))).filter(Boolean) : (err(`${path}.series`, 'precisa ser uma lista'), undefined)
        if (out.kind === undefined) out.kind = 'bar'
        if (out.data === undefined) err(`${path}.data`, 'obrigatório')
        if (!out.series?.length) err(`${path}.series`, 'chart precisa de ao menos uma série')
        break
      }
      case 'log': take('lines', (v, p) => arrayOrRef(v, p, 1000)); take('follow', bool); take('maxLines', (v, p) => (Number.isInteger(v) && v >= 10 && v <= 1000 ? v : (err(p, 'maxLines entre 10 e 1000'), undefined))); take('height', (v, p) => (Number.isInteger(v) && v >= 80 && v <= 600 ? v : undefined)); break
      case 'files': take('items', (v, p) => arrayOrRef(v, p)); take('itemActions', rowActions); take('empty', (v, p) => str(v, p, 160)); take('filter', bool); break
      case 'results': take('items', (v, p) => arrayOrRef(v, p, 60)); take('itemActions', rowActions); take('empty', (v, p) => str(v, p, 160)); break
      case 'form': {
        known.add('fields'); known.add('submit')
        out.fields = Array.isArray(n.fields) ? n.fields.slice(0, LIMITS.fields).map((f, i) => field(f, `${path}.fields[${i}]`)).filter(Boolean) : (err(`${path}.fields`, 'form precisa de fields'), [])
        if (!isObj(n.submit)) err(`${path}.submit`, 'form precisa de submit {label, action}')
        else out.submit = { label: label(n.submit.label ?? 'Enviar', `${path}.submit.label`), action: act(n.submit.action, `${path}.submit.action`), tone: n.submit.tone === undefined ? undefined : tone(n.submit.tone, `${path}.submit.tone`), confirm: str(n.submit.confirm, `${path}.submit.confirm`, 300) }
        break
      }
      case 'control': {
        known.add('field'); known.add('onChange')
        out.field = field(n.field, `${path}.field`)
        if (n.onChange !== undefined) out.onChange = act(n.onChange, `${path}.onChange`)
        break
      }
      case 'button': take('label', label); take('action', act); take('params', params); take('tone', tone); take('confirm', (v, p) => str(v, p, 300)); take('disabled', (v, p) => bindable(v, p, bool)); if (out.label === undefined) err(`${path}.label`, 'obrigatório'); if (out.action === undefined) err(`${path}.action`, 'botão precisa de uma ação declarada'); break
    }
    for (const k of Object.keys(n)) if (!known.has(k)) warn(`${path}.${k}`, 'propriedade desconhecida ignorada')
    return out
  }

  // ---- top level
  spec.title = str(input.title, 'title', 80, { required: true }) ?? 'Painel'
  if (input.purpose !== undefined) spec.purpose = str(input.purpose, 'purpose', 200)
  if (input.status !== undefined) spec.status = enumOf(['loading', 'ready', 'error', 'done'])(input.status, 'status')
  if (input.state !== undefined) {
    if (!isObj(input.state)) err('state', 'precisa ser um objeto')
    else { spec.state = {}; for (const [k, v] of Object.entries(input.state).slice(0, 40)) { if (!KEY.test(k)) { err(`state.${k}`, 'nome inválido'); continue } if (['string', 'number', 'boolean'].includes(typeof v) || Array.isArray(v)) spec.state[k] = v; else err(`state.${k}`, 'valor precisa ser texto, número, booleano ou lista') } }
  }
  if (input.data !== undefined) {
    if (!isObj(input.data)) err('data', 'precisa ser um objeto')
    else { spec.data = {}; for (const [k, v] of Object.entries(input.data).slice(0, 40)) { if (!KEY.test(k)) { err(`data.${k}`, 'nome inválido'); continue } spec.data[k] = v } if (JSON.stringify(spec.data).length > LIMITS.dataBytes) err('data', `dados maiores que ${LIMITS.dataBytes} bytes`) }
  }
  if (input.sources !== undefined) {
    if (!isObj(input.sources)) err('sources', 'precisa ser um objeto')
    else {
      spec.sources = {}
      for (const [k, s] of Object.entries(input.sources).slice(0, LIMITS.sources)) {
        const p = `sources.${k}`
        if (!KEY.test(k) || !isObj(s)) { err(p, 'fonte inválida'); continue }
        if (s.kind === 'tool') spec.sources[k] = { kind: 'tool', tool: str(s.tool, `${p}.tool`, 40, { required: true }), args: isObj(s.args) ? s.args : undefined, everySec: s.everySec === undefined ? undefined : (Number.isFinite(s.everySec) && s.everySec >= 3 && s.everySec <= 3600 ? s.everySec : (err(`${p}.everySec`, 'entre 3 e 3600 segundos'), undefined)), pick: str(s.pick, `${p}.pick`, 80) }
        else if (s.kind === 'mission') spec.sources[k] = { kind: 'mission', id: str(s.id, `${p}.id`, 60, { required: true }) }
        else if (s.kind === 'monitor') spec.sources[k] = { kind: 'monitor' }
        else err(`${p}.kind`, 'tipo de fonte desconhecido (tool | mission | monitor)')
      }
    }
  }
  if (Object.keys(actions).length) spec.actions = actions
  if (input.root === undefined) err('root', 'obrigatório')
  else spec.root = node(input.root, 'root', 0)
  // an action may only name a source/state/data target that exists or is declarable: checked lightly
  for (const [id, a] of Object.entries(actions)) if (a.refresh) for (const s of a.refresh) if (!spec.sources?.[s]) warn(`actions.${id}.refresh`, `fonte ${s} não declarada`)
  return { ok: errors.length === 0 && spec.root !== null && spec.root !== undefined, errors, warnings, spec }
}

/** Human-readable list for a model that must repair its spec. */
export const explain = (errors) => errors.slice(0, 12).map((e) => `${e.path || '(raiz)'}: ${e.msg}`).join('\n')
export { BANNED_TOOLS }
