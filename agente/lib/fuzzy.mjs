// Fuzzy find-and-replace for model-written edits. Port of tools/fuzzy_match.py from Hermes Agent
// (c) 2025 Nous Research, MIT License: https://github.com/NousResearch/hermes-agent
//
// An ordered chain of increasingly permissive strategies lets whitespace, indentation, escaping and Unicode drift in
// tool-call arguments still land on the intended region. Spans are [start, end) offsets in the ORIGINAL content.
import { opcodes, ratio } from './difflib.mjs'

export const IDENTICAL_STRINGS_ERROR =
  'No edit was applied because old_string and new_string are identical. Provide the existing text to replace in old_string and the changed replacement text in new_string.'

const UNICODE_MAP = {
  '“': '"', '”': '"', '‘': "'", '’': "'", '—': '--', '–': '-', '…': '...', ' ': ' ', '−': '-',
  ' ': ' ', ' ': ' ', ' ': ' ', ' ': ' ', ' ': ' ', ' ': ' ', ' ': ' ', ' ': ' ', ' ': ' ', ' ': ' ',
  ' ': ' ', ' ': ' ', ' ': ' ', '　': ' ',
}
const unicodeNormalize = (t) => { let o = ''; for (const c of t) o += UNICODE_MAP[c] ?? c; return o }
const lstrip = (s) => s.replace(/^[ \t\n\r\f\v]+/, '')
const strip = (s) => s.trim()

// ── position helpers ────────────────────────────────────────────────────────
function linePositions(lines, startLine, endLine, contentLength) {
  let s = 0, e = 0
  for (let i = 0; i < startLine; i++) s += lines[i].length + 1
  for (let i = 0; i < endLine; i++) e += lines[i].length + 1
  return [s, Math.min(contentLength, e - 1)]
}
function windowSpans(content, lines, n, accept) {
  const out = []
  for (let i = 0; i + n <= lines.length; i++) if (accept(i)) out.push(linePositions(lines, i, i + n, content.length))
  return out
}
const sameLines = (a, b) => a.length === b.length && a.every((x, i) => x === b[i])
function matchTransformedLines(content, pattern, transform) {
  const lines = content.split('\n')
  const norm = transform(pattern.split('\n'))
  const n = norm.length
  return windowSpans(content, lines, n, (i) => sameLines(transform(lines.slice(i, i + n)), norm))
}
function stripBoundary(lines) {
  const l = [...lines]
  l[0] = l[0].trim()
  if (l.length > 1) l[l.length - 1] = l.at(-1).trim()
  return l
}

function buildOrigToNormMap(original) {
  const result = []
  let normPos = 0
  for (let i = 0; i < original.length; i++) { // UTF-16 units: every key of UNICODE_MAP is a single unit, so offsets stay aligned
    result.push(normPos)
    normPos += (UNICODE_MAP[original[i]] ?? original[i]).length
  }
  result.push(normPos)
  return result
}
function invertNormMap(o2n) {
  const inv = new Map()
  for (let o = 0; o < o2n.length - 1; o++) if (!inv.has(o2n[o])) inv.set(o2n[o], o)
  return inv
}
function normEndToOrig(o2n, origStart, normEnd) {
  const len = o2n.length - 1
  let e = origStart
  while (e < len && o2n[e] < normEnd) e++
  return e
}
function mapNormToOrig(o2n, normMatches) {
  const inv = invertNormMap(o2n)
  const out = []
  for (const [ns, ne] of normMatches) if (inv.has(ns)) { const os = inv.get(ns); out.push([os, normEndToOrig(o2n, os, ne)]) }
  return out
}

function mapNormalizedPositions(original, normalized, normalizedMatches) {
  const o2n = []
  let oi = 0, ni = 0
  while (oi < original.length && ni < normalized.length) {
    if (original[oi] === normalized[ni]) { o2n.push(ni); oi++; ni++ }
    else if ((original[oi] === ' ' || original[oi] === '\t') && normalized[ni] === ' ') {
      o2n.push(ni); oi++
      if (oi < original.length && original[oi] !== ' ' && original[oi] !== '\t') ni++
    } else { o2n.push(ni); oi++ }
  }
  while (o2n.length < original.length) o2n.push(normalized.length)
  const start = new Map(), end = new Map()
  o2n.forEach((np, op) => { if (!start.has(np)) start.set(np, op); end.set(np, op) })
  return normalizedMatches.map(([ns, ne]) => {
    let os = start.has(ns) ? start.get(ns) : o2n.findIndex((n) => n >= ns)
    if (os < 0) os = original.length
    let oe = end.has(ne - 1) ? end.get(ne - 1) + 1 : os + (ne - ns)
    if (ne < normalized.length && normalized[ne - 1] === ' ') while (oe < original.length && (original[oe] === ' ' || original[oe] === '\t')) oe++
    return [os, Math.min(oe, original.length)]
  })
}

// ── strategies ──────────────────────────────────────────────────────────────
function strategyExact(content, pattern) {
  const out = []
  if (!pattern) return out
  let i = 0
  for (;;) {
    const at = content.indexOf(pattern, i)
    if (at < 0) break
    out.push([at, at + pattern.length])
    i = at + pattern.length // non-overlapping, like str.replace
  }
  return out
}
const strategyLineTrimmed = (c, p) => matchTransformedLines(c, p, (ls) => ls.map(strip))
function strategyWhitespaceNormalized(content, pattern) {
  const norm = (s) => s.replace(/[ \t]+/g, ' ')
  const cn = norm(content)
  const m = strategyExact(cn, norm(pattern))
  return m.length ? mapNormalizedPositions(content, cn, m) : []
}
const strategyIndentationFlexible = (c, p) => matchTransformedLines(c, p, (ls) => ls.map(lstrip))
function strategyEscapeNormalized(content, pattern) {
  const un = pattern.replaceAll('\\n', '\n').replaceAll('\\t', '\t').replaceAll('\\r', '\r')
  return un === pattern ? [] : strategyExact(content, un)
}
const strategyTrimmedBoundary = (c, p) => matchTransformedLines(c, p, stripBoundary)
function strategyUnicodeNormalized(content, pattern) {
  const np = unicodeNormalize(pattern), nc = unicodeNormalize(content)
  if (nc === content && np === pattern) return []
  const m = strategyExact(nc, np)
  const matches = m.length ? m : strategyLineTrimmed(nc, np)
  return matches.length ? mapNormToOrig(buildOrigToNormMap(content), matches) : []
}
function strategyBlockAnchor(content, pattern) {
  const pl = unicodeNormalize(pattern).split('\n')
  if (pl.length < 2) return []
  const first = pl[0].trim(), last = pl.at(-1).trim(), n = pl.length
  const ncl = unicodeNormalize(content).split('\n')
  const potential = new Set()
  for (let i = 0; i + n <= ncl.length; i++) if (ncl[i].trim() === first && ncl[i + n - 1].trim() === last) potential.add(i)
  const threshold = potential.size === 1 ? 0.5 : 0.7
  const patternMiddle = pl.slice(1, -1).join('\n')
  return windowSpans(content, content.split('\n'), n, (i) => {
    if (!potential.has(i)) return false
    if (n <= 2) return true
    return ratio(ncl.slice(i + 1, i + n - 1).join('\n'), patternMiddle) >= threshold
  })
}
function strategyContextAware(content, pattern) {
  const pl = pattern.split('\n'), cl = content.split('\n'), n = pl.length
  if (n > cl.length) return []
  const firstPat = pl[0].trim(), lastPat = pl.at(-1).trim()
  const sim = (a, b) => (a === b ? 1 : ratio(a, b))
  return windowSpans(content, cl, n, (i) => {
    const block = cl.slice(i, i + n)
    if (sim(firstPat, block[0].trim()) < 0.8) return false
    if (sim(lastPat, block.at(-1).trim()) < 0.8) return false
    return pl.every((p, k) => !p.trim() || sim(p.trim(), block[k].trim()) >= 0.8)
  })
}

const STRATEGIES = [
  ['exact', strategyExact], ['line_trimmed', strategyLineTrimmed], ['whitespace_normalized', strategyWhitespaceNormalized],
  ['indentation_flexible', strategyIndentationFlexible], ['escape_normalized', strategyEscapeNormalized], ['trimmed_boundary', strategyTrimmedBoundary],
  ['unicode_normalized', strategyUnicodeNormalized], ['block_anchor', strategyBlockAnchor], ['context_aware', strategyContextAware],
]
const SIMILARITY = new Set(['block_anchor', 'context_aware'])

export function isAlreadyApplied(content, oldString, newString) {
  if (!newString || newString.trim().length < 8 || !content.includes(newString)) return false
  return oldString === newString || !content.includes(oldString)
}

const matchedRegions = (content, matches) => matches.map(([s, e]) => content.slice(s, e)).join('')

function formatMatchLocations(content, matches, cap = 5) {
  const rows = matches.slice(0, cap).map(([start]) => {
    const lineNo = content.slice(0, start).split('\n').length
    const ls = content.lastIndexOf('\n', start - 1) + 1
    let le = content.indexOf('\n', ls)
    if (le < 0) le = content.length
    let snip = content.slice(ls, le).trim()
    if (snip.length > 80) snip = snip.slice(0, 77) + '...'
    return `  L${lineNo}: ${snip}`
  })
  if (matches.length > cap) rows.push(`  ... and ${matches.length - cap} more`)
  return rows.join('\n')
}

// ── escape-drift guards ─────────────────────────────────────────────────────
const count = (s, sub) => s.split(sub).length - 1
function detectNewlineLiteralDrift(content, matches, oldString, newString) {
  if (!newString.includes('\\n')) return null
  const oldLiterals = count(oldString, '\\n')
  for (const [s, e] of matches) {
    const region = content.slice(s, e)
    if (region.includes('\n') && oldLiterals > count(region, '\\n')) {
      return "Escape-drift detected: old_string contains more literal '\\\\n' sequences than the matched region of the file, which has real line breaks there instead. This is almost always a tool-call serialization artifact where a line break got escaped one extra time; new_string would write it as backslash + n. Re-read the file with read_file and pass old_string/new_string with actual line breaks, keeping only the '\\\\n' sequences that appear literally in the file."
    }
  }
  return null
}
const backslashRuns = (s) => (s.match(/\\+/g) ?? []).map((r) => r.length)
function detectBackslashDoubling(region, oldString, newString) {
  const o = backslashRuns(oldString), f = backslashRuns(region)
  if (!o.length || !f.length || o.length !== f.length || sameLines(o, f) || o.some((x, i) => x !== f[i] * 2) || !(f.some((x) => x >= 2) || f.length >= 2) || sameLines(backslashRuns(newString), f)) return null
  return 'Escape-drift detected: every backslash run in old_string is exactly twice as long as in the matched region of the file. The tool-call arguments were JSON-escaped one extra time; applying new_string verbatim would double every backslash in the file. Re-read the file with read_file and resend old_string/new_string with the backslash counts exactly as they appear in the file.'
}
function detectEscapeDrift(content, matches, oldString, newString) {
  const suspects = newString.includes("\\'") || newString.includes('\\"')
  if (!suspects && !oldString.includes('\\')) return null
  const region = matchedRegions(content, matches)
  if (suspects) {
    for (const sus of ["\\'", '\\"']) {
      if (newString.includes(sus) && oldString.includes(sus) && !region.includes(sus)) {
        return `Escape-drift detected: old_string and new_string contain the literal sequence ${sus} but the matched region of the file does not. This is almost always a tool-call serialization artifact where an apostrophe or quote got prefixed with a spurious backslash. Re-read the file with read_file and pass old_string/new_string without backslash-escaping ${sus[1]} characters.`
      }
    }
  }
  return detectNewlineLiteralDrift(content, matches, oldString, newString) ?? detectBackslashDoubling(region, oldString, newString)
}
function maybeUnescapeNew(newString, content, matches) {
  if (!newString.includes('\\t') && !newString.includes('\\r')) return newString
  const region = matchedRegions(content, matches)
  for (const [lit, ctl] of [['\\t', '\t'], ['\\r', '\r']]) if (newString.includes(lit) && region.includes(ctl)) newString = newString.replaceAll(lit, ctl)
  return newString
}

// ── replacement shaping ─────────────────────────────────────────────────────
const leadingWs = (l) => l.slice(0, l.length - l.replace(/^[ \t]+/, '').length)
const firstMeaningful = (t) => t.split('\n').find((l) => l.trim()) ?? null
function reindentReplacement(fileRegion, oldString, newString) {
  if (!newString) return newString
  const of = firstMeaningful(oldString), ff = firstMeaningful(fileRegion)
  if (of == null || ff == null) return newString
  const oi = leadingWs(of), fi = leadingWs(ff)
  if (oi === fi) return newString
  return newString.split('\n').map((l) => (!l.trim() ? l : leadingWs(l).startsWith(oi) ? fi + l.slice(oi.length) : fi + l.replace(/^[ \t]+/, ''))).join('\n')
}
function preserveUnicode(fileRegion, newString, [normOld, ops]) {
  if (normOld !== unicodeNormalize(fileRegion)) return newString
  const o2n = buildOrigToNormMap(fileRegion)
  const parts = []
  for (const [tag, i1, i2, j1, j2] of ops) {
    if (tag === 'equal') {
      let os = 0
      for (let k = 0; k < o2n.length; k++) { if (o2n[k] <= i1) os = k; else break }
      parts.push(fileRegion.slice(os, normEndToOrig(o2n, os, i2)))
    } else if (tag !== 'delete') parts.push(newString.slice(j1, j2))
  }
  return parts.join('')
}
function applyReplacements(content, matches, newString, oldString = null, plan = null) {
  let result = content
  for (const [start, end] of [...matches].sort((a, b) => b[0] - a[0])) {
    let adjusted = newString
    if (oldString !== null) {
      const region = content.slice(start, end)
      if (plan) adjusted = preserveUnicode(region, adjusted, plan)
      adjusted = reindentReplacement(region, oldString, adjusted)
    }
    result = result.slice(0, start) + adjusted + result.slice(end)
  }
  return result
}

/** @returns {{content: string, count: number, strategy: string|null, error: string|null}} */
export function fuzzyFindAndReplace(content, oldString, newString, replaceAll = false) {
  const fail = (error) => ({ content, count: 0, strategy: null, error })
  if (!oldString) return fail('old_string is empty — nothing to match. Set old_string to the exact existing text the replacement should replace (read the file first if unsure). To create a new file or fully rewrite one, use write_file instead. Do not re-send this call unchanged.')
  if (!oldString.trim()) return fail('old_string is only whitespace — provide non-blank text to match. Set it to the exact existing text the replacement should replace (read the file first if unsure). Do not re-send this call unchanged.')
  if (oldString === newString) return fail(IDENTICAL_STRINGS_ERROR)
  for (const [name, fn] of STRATEGIES) {
    const matches = fn(content, oldString)
    if (!matches.length) continue
    if (matches.length > 1 && !replaceAll) return fail(`Found ${matches.length} matches for old_string. Provide more context to make it unique, or use replace_all=true. Matches:\n${formatMatchLocations(content, matches)}`)
    if (replaceAll && matches.length > 1 && SIMILARITY.has(name)) return fail(`Found ${matches.length} approximate matches via the '${name}' strategy; replace_all only applies to exact matches. Provide the precise text (whitespace included) so an exact/line-trimmed match can be made.`)
    if (name !== 'exact') { const drift = detectEscapeDrift(content, matches, oldString, newString); if (drift) return fail(drift) }
    const effectiveNew = maybeUnescapeNew(newString, content, matches)
    const plan = name === 'unicode_normalized' ? [unicodeNormalize(oldString), opcodes(unicodeNormalize(oldString), effectiveNew)] : null
    return { content: applyReplacements(content, matches, effectiveNew, name !== 'exact' ? oldString : null, plan), count: matches.length, strategy: name, error: null }
  }
  return fail('Could not find a match for old_string in the file')
}

// ── "did you mean?" diagnostics ─────────────────────────────────────────────
const visualizeWs = (line) => { const s = lstrip(line); return line.slice(0, line.length - s.length).replaceAll('\t', '→').replaceAll(' ', '·') + s }
export function findClosestLines(oldString, content, contextLines = 2, maxResults = 3) {
  if (!oldString || !content) return ''
  const ol = oldString.split(/\r?\n/), cl = content.split(/\r?\n/)
  const anchor = ol[0].trim() || (ol.find((l) => l.trim()) ?? '').trim()
  if (!anchor) return ''
  const scored = cl.map((l, i) => [ratio(anchor, l.trim()), i, l]).filter(([, , l]) => l.trim()).sort((a, b) => b[0] - a[0])
  const top = scored.filter((s) => s[0] > 0.3).slice(0, maxResults)
  if (!top.length) return ''
  const parts = [], seen = new Set()
  for (const [, idx] of top) {
    const start = Math.max(0, idx - contextLines), end = Math.min(cl.length, idx + ol.length + contextLines)
    const key = `${start}:${end}`
    if (seen.has(key)) continue
    seen.add(key)
    parts.push(Array.from({ length: end - start }, (_, j) => `${String(start + j + 1).padStart(4)}| ${cl[start + j]}`).join('\n'))
  }
  let result = parts.join('\n---\n')
  const best = cl[top[0][1]]
  if (best.trim() === anchor && best !== ol[0]) result += `\n\nWhitespace difference detected (→ = tab, · = space):\n  file has: ${visualizeWs(best)}\n  you sent: ${visualizeWs(ol[0])}\nUse the exact whitespace shown in 'file has'.`
  return result
}
export function noMatchHint(error, count, oldString, content) {
  if (count !== 0 || !error || !error.startsWith('Could not find')) return ''
  const hint = findClosestLines(oldString, content)
  return hint ? '\n\nDid you mean one of these sections?\n' + hint : ''
}
