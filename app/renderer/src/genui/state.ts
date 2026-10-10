/**
 * Control state of a panel (values of filters, tabs, form fields). Kept on the client and NEVER thrown away when the spec
 * or the data change: a spec update only fills in keys that do not exist yet, and a server "setState" overrides only the
 * keys it names. Pure functions so the behaviour is testable without a browser.
 */
export type StateValue = string | number | boolean | (string | number)[]
export type PanelState = Record<string, StateValue>

/** Defaults from a (new) spec fill the gaps; whatever the user already set wins. */
export function mergeDefaults(current: PanelState, defaults: PanelState | undefined): PanelState {
  if (!defaults) return current
  let changed = false
  const next: PanelState = { ...current }
  for (const [k, v] of Object.entries(defaults)) if (!(k in next)) { next[k] = v; changed = true }
  return changed ? next : current
}

/** Server-side overrides (ui_update setState): explicit, named keys only. */
export function applyOps(current: PanelState, ops: PanelState | undefined): PanelState {
  if (!ops || !Object.keys(ops).length) return current
  return { ...current, ...ops }
}

export interface FieldDef { name: string; kind: string; label?: string; required?: boolean; min?: number; max?: number; step?: number; pattern?: string; default?: string | number | boolean; options?: { value: string; label: string }[] }

/** Validation message for one field value, or null when it is fine. */
export function validateField(f: FieldDef, value: unknown): string | null {
  const empty = value === undefined || value === null || value === ''
  if (f.required && (empty || value === false && f.kind !== 'toggle')) return 'Obrigatório'
  if (empty) return null
  if (f.kind === 'number' || f.kind === 'slider') {
    const n = Number(value)
    if (!Number.isFinite(n)) return 'Digite um número'
    if (f.min !== undefined && n < f.min) return `Mínimo ${f.min}`
    if (f.max !== undefined && n > f.max) return `Máximo ${f.max}`
  }
  if (f.pattern && typeof value === 'string') { try { if (!new RegExp(f.pattern).test(value)) return 'Formato inválido' } catch { /* the server already rejected bad patterns */ } }
  if (f.kind === 'select' && f.options && !f.options.some((o) => o.value === String(value))) return 'Escolha uma opção da lista'
  return null
}

export function initialFieldValue(f: FieldDef, state: PanelState): StateValue {
  if (f.name in state) return state[f.name]
  if (f.default !== undefined) return f.default
  return f.kind === 'toggle' ? false : f.kind === 'number' || f.kind === 'slider' ? (f.min ?? 0) : ''
}

/** Convert a form field's raw input to the type its kind promises. */
export function coerce(f: FieldDef, raw: unknown): StateValue {
  if (f.kind === 'number' || f.kind === 'slider') return raw === '' ? '' : Number(raw)
  if (f.kind === 'toggle') return Boolean(raw)
  return String(raw ?? '')
}

export type SortDir = 'asc' | 'desc'
/** Stable, type-aware sort used by tables (numbers numerically, text with pt-BR collation). */
export function sortRows<T extends Record<string, unknown>>(rows: T[], key: string, dir: SortDir): T[] {
  const mul = dir === 'asc' ? 1 : -1
  const col = new Intl.Collator('pt-BR', { numeric: true, sensitivity: 'base' })
  return rows.map((r, i) => ({ r, i })).sort((a, b) => {
    const x = a.r[key], y = b.r[key]
    if (x === y) return a.i - b.i
    if (x === undefined || x === null) return 1
    if (y === undefined || y === null) return -1
    const c = typeof x === 'number' && typeof y === 'number' ? x - y : col.compare(String(x), String(y))
    return c === 0 ? a.i - b.i : c * mul
  }).map((x) => x.r)
}

export function filterRows<T extends Record<string, unknown>>(rows: T[], q: string, keys?: string[]): T[] {
  const needle = q.trim().toLowerCase()
  if (!needle) return rows
  return rows.filter((r) => (keys ?? Object.keys(r)).some((k) => String(r[k] ?? '').toLowerCase().includes(needle)))
}
