/**
 * Bindings for generative UI specs, shared by the bridge (resolving action arguments, validating) and the renderer
 * (resolving what to draw). Pure functions, no I/O, no eval: a spec is DATA, and a binding can only read a value out of a
 * plain object by a dotted path. It can never call a function, reach the prototype chain or run code.
 *
 *   {ref: "data.rows"}            read a value        {ref: "row.path"}  (inside a table row action)
 *   "Total: {{data.total}}"       interpolate into text
 *   {ref: "data.rows.length", gt: 0}   a condition (eq / ne / gt / lt / truthy)
 */
export const ROOTS = ['data', 'state', 'row', 'form']
export const REF_RE = /^(data|state|row|form)((\.[A-Za-z_][\w-]{0,39}|\[\d{1,4}\]){0,10})$/
const BAD = new Set(['__proto__', 'prototype', 'constructor'])

/** Parse "data.items[0].name" into ["data","items",0,"name"], or null when it is not an allowed reference. */
export function parseRef(ref) {
  if (typeof ref !== 'string' || ref.length > 100 || !REF_RE.test(ref)) return null
  const parts = []
  for (const m of ref.matchAll(/([A-Za-z_][\w-]*)|\[(\d+)\]/g)) parts.push(m[2] !== undefined ? Number(m[2]) : m[1])
  return parts.some((p) => typeof p === 'string' && BAD.has(p)) ? null : parts
}

/** Read a reference out of a scope ({data, state, row, form}); undefined when anything on the way is missing. */
export function getRef(scope, ref) {
  const parts = parseRef(ref)
  if (!parts) return undefined
  let cur = scope
  for (const p of parts) {
    if (cur === null || cur === undefined) return undefined
    if (typeof p === 'string' && !Object.hasOwn(Object(cur), p)) {
      // arrays and strings expose a harmless length
      if (p === 'length' && (Array.isArray(cur) || typeof cur === 'string')) { cur = cur.length; continue }
      return undefined
    }
    cur = cur[p]
  }
  return cur
}

export const isRef = (v) => v !== null && typeof v === 'object' && !Array.isArray(v) && typeof v.ref === 'string'

/** Resolve a value that may be a literal or a {ref} binding (one level; objects/arrays are returned as they are). */
export function resolve(v, scope) {
  return isRef(v) ? getRef(scope, v.ref) : v
}

const fmt = (x) => (x === null || x === undefined ? '' : typeof x === 'object' ? JSON.stringify(x) : String(x))

/** "Olá {{state.nome}}" -> "Olá Erick". Unknown references become an empty string. */
export function interpolate(text, scope) {
  if (typeof text !== 'string' || !text.includes('{{')) return text
  return text.replace(/\{\{\s*([^{}]{1,100}?)\s*\}\}/g, (_, ref) => fmt(getRef(scope, ref)))
}

/** Evaluate a visibility condition: {ref, eq|ne|gt|lt|truthy}. No condition = true. */
export function evalCond(cond, scope) {
  if (cond === undefined || cond === null) return true
  if (typeof cond === 'boolean') return cond
  if (!isRef(cond)) return false
  const v = getRef(scope, cond.ref)
  if ('eq' in cond) return v === cond.eq
  if ('ne' in cond) return v !== cond.ne
  if ('gt' in cond) return typeof v === 'number' && v > cond.gt
  if ('lt' in cond) return typeof v === 'number' && v < cond.lt
  return Boolean(v) && !(Array.isArray(v) && v.length === 0)
}

/**
 * Resolve an action's argument template against a scope. Strings are interpolated; {ref} is replaced by the value;
 * arrays/objects are walked. Only JSON-safe scalars (and arrays/objects of them) come out, and sizes are bounded, so a
 * hostile data source cannot smuggle a huge value or a function into a tool call.
 */
export function resolveArgs(tpl, scope, depth = 0) {
  if (depth > 5) return undefined
  if (isRef(tpl)) return sanitize(getRef(scope, tpl.ref))
  if (typeof tpl === 'string') return interpolate(tpl, scope).slice(0, 2000)
  if (Array.isArray(tpl)) return tpl.slice(0, 50).map((x) => resolveArgs(x, scope, depth + 1))
  if (tpl && typeof tpl === 'object') {
    const out = {}
    for (const [k, v] of Object.entries(tpl).slice(0, 30)) if (!BAD.has(k)) out[k] = resolveArgs(v, scope, depth + 1)
    return out
  }
  return typeof tpl === 'number' || typeof tpl === 'boolean' || tpl === null ? tpl : undefined
}

function sanitize(v, depth = 0) {
  if (v === null || typeof v === 'number' || typeof v === 'boolean') return v
  if (typeof v === 'string') return v.slice(0, 2000)
  if (depth > 4) return undefined
  if (Array.isArray(v)) return v.slice(0, 50).map((x) => sanitize(x, depth + 1))
  if (typeof v === 'object') {
    const out = {}
    for (const [k, x] of Object.entries(v).slice(0, 30)) if (!BAD.has(k)) out[k] = sanitize(x, depth + 1)
    return out
  }
  return undefined
}

/** Write a value into data at "data.name" / "data.name.sub" (never anywhere else, never through the prototype chain). */
export function setData(data, target, value, { append = false } = {}) {
  const parts = parseRef(target)
  if (!parts || parts[0] !== 'data' || parts.length < 2 || parts.some((p) => typeof p !== 'string')) return false
  let cur = data
  for (const p of parts.slice(1, -1)) {
    if (!Object.hasOwn(cur, p) || cur[p] === null || typeof cur[p] !== 'object') cur[p] = {}
    cur = cur[p]
  }
  const last = parts.at(-1)
  if (append) cur[last] = [...(Array.isArray(cur[last]) ? cur[last] : []), ...[].concat(value)]
  else cur[last] = value
  return true
}

/** Pick a sub-value of a tool result by a path relative to the result ("data.items"); the whole result when absent. */
export function pick(obj, path) {
  if (!path) return obj
  const parts = String(path).split('.').filter(Boolean)
  let cur = obj
  for (const p of parts) {
    if (BAD.has(p) || cur === null || typeof cur !== 'object' || !Object.hasOwn(cur, p)) return undefined
    cur = cur[p]
  }
  return cur
}
