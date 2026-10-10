// Minimal port of Python's difflib.SequenceMatcher (no junk heuristics): matching blocks, opcodes and ratio().
// Needed by the fuzzy edit matcher, which was written against it. Strings only.

function longestMatch(a, b2j, alo, ahi, blo, bhi) {
  let besti = alo, bestj = blo, bestsize = 0
  let j2len = new Map()
  for (let i = alo; i < ahi; i++) {
    const next = new Map()
    for (const j of b2j.get(a[i]) ?? []) {
      if (j < blo) continue
      if (j >= bhi) break
      const k = (j2len.get(j - 1) ?? 0) + 1
      next.set(j, k)
      if (k > bestsize) { besti = i - k + 1; bestj = j - k + 1; bestsize = k }
    }
    j2len = next
  }
  return [besti, bestj, bestsize]
}

/** [[i, j, size], ...] in order, ending with the (len(a), len(b), 0) sentinel, like difflib. */
export function matchingBlocks(a, b) {
  const b2j = new Map()
  for (let j = 0; j < b.length; j++) { const l = b2j.get(b[j]); l ? l.push(j) : b2j.set(b[j], [j]) }
  const out = []
  const queue = [[0, a.length, 0, b.length]]
  while (queue.length) {
    const [alo, ahi, blo, bhi] = queue.pop()
    const [i, j, k] = longestMatch(a, b2j, alo, ahi, blo, bhi)
    if (!k) continue
    out.push([i, j, k])
    if (alo < i && blo < j) queue.push([alo, i, blo, j])
    if (i + k < ahi && j + k < bhi) queue.push([i + k, ahi, j + k, bhi])
  }
  out.sort((x, y) => x[0] - y[0] || x[1] - y[1])
  // merge adjacent blocks
  const merged = []
  for (const blk of out) {
    const last = merged.at(-1)
    if (last && last[0] + last[2] === blk[0] && last[1] + last[2] === blk[1]) last[2] += blk[2]
    else merged.push([...blk])
  }
  merged.push([a.length, b.length, 0])
  return merged
}

export function ratio(a, b) {
  const total = a.length + b.length
  if (!total) return 1
  let matches = 0
  for (const [, , k] of matchingBlocks(a, b)) matches += k
  return (2 * matches) / total
}

/** [[tag, i1, i2, j1, j2], ...] with tag in equal | replace | delete | insert. */
export function opcodes(a, b) {
  const ops = []
  let i = 0, j = 0
  for (const [ai, bj, size] of matchingBlocks(a, b)) {
    let tag = ''
    if (i < ai && j < bj) tag = 'replace'
    else if (i < ai) tag = 'delete'
    else if (j < bj) tag = 'insert'
    if (tag) ops.push([tag, i, ai, j, bj])
    i = ai + size
    j = bj + size
    if (size) ops.push(['equal', ai, i, bj, j])
  }
  return ops
}
