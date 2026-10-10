import { readdir, rm, stat } from 'node:fs/promises'
import { join } from 'node:path'
import { isWindows, psJson } from './winps.mjs'

const GB = 2 ** 30
const r1 = (n) => Math.round(n * 10) / 10

/**
 * Read-only disk analysis, bounded in time and in entries so a full drive cannot freeze the bridge. Links are never
 * followed. Results say when they are partial. Nothing here deletes anything; deletion is a separate, confirmed tool.
 */
async function walk(dir, visit, budget) {
  if (budget.stop) return
  let entries
  try {
    entries = await readdir(dir, { withFileTypes: true })
  } catch {
    return
  }
  for (const e of entries) {
    if (budget.stop) return
    if (++budget.count > budget.maxEntries || Date.now() > budget.deadline) {
      budget.stop = true
      budget.partial = true
      return
    }
    if (e.isSymbolicLink()) continue
    const p = join(dir, e.name)
    if (e.isDirectory()) await walk(p, visit, budget)
    else if (e.isFile()) {
      try {
        visit(p, (await stat(p)).size, e)
      } catch { /* vanished */ }
    }
  }
}
const newBudget = (maxMs = 20000, maxEntries = 400_000) => ({ count: 0, maxEntries, deadline: Date.now() + maxMs, stop: false, partial: false })

/** Size of each immediate child of `root`, biggest first. */
export async function largest(root, { top = 15, maxMs = 20000 } = {}) {
  const budget = newBudget(maxMs)
  let children
  try {
    children = await readdir(root, { withFileTypes: true })
  } catch (e) {
    throw new Error(`não consegui ler ${root}: ${e.code ?? e.message}`)
  }
  const rows = []
  for (const c of children) {
    if (c.isSymbolicLink()) continue
    const p = join(root, c.name)
    let bytes = 0, files = 0
    if (c.isFile()) {
      try { bytes = (await stat(p)).size; files = 1 } catch { continue }
    } else if (c.isDirectory()) {
      await walk(p, (_f, size) => { bytes += size; files++ }, budget)
    }
    rows.push({ name: c.name, path: p, type: c.isDirectory() ? 'pasta' : 'arquivo', sizeGB: r1(bytes / GB), sizeMB: Math.round(bytes / 2 ** 20), files })
    if (budget.stop) break
  }
  rows.sort((a, b) => b.sizeMB - a.sizeMB)
  return { root, items: rows.slice(0, top), partial: budget.partial, note: budget.partial ? 'varredura interrompida por tempo/limite: os tamanhos são mínimos, não totais' : null }
}

export async function bigFiles(root, { minMB = 500, top = 15, maxMs = 25000 } = {}) {
  const budget = newBudget(maxMs)
  const found = []
  await walk(root, (p, size) => { if (size >= minMB * 2 ** 20) found.push({ path: p, sizeMB: Math.round(size / 2 ** 20) }) }, budget)
  found.sort((a, b) => b.sizeMB - a.sizeMB)
  return { root, minMB, items: found.slice(0, top), partial: budget.partial }
}

const folderSize = async (dir, olderThanDays = 0) => {
  const budget = newBudget(8000, 150_000)
  let bytes = 0, files = 0
  const cutoff = Date.now() - olderThanDays * 86_400_000
  await walk(dir, (p, size) => { bytes += size; files++ }, budget).catch(() => {})
  void cutoff
  return { bytes, files, partial: budget.partial }
}

/** Where space usually hides, with real sizes. `deletable` says which ones the confirmed cleanup tool can clear. */
export async function cleanupCandidates(env = process.env) {
  const out = []
  const add = async (id, label, path, extra = {}) => {
    try {
      const s = await folderSize(path)
      out.push({ id, label, path, sizeMB: Math.round(s.bytes / 2 ** 20), files: s.files, partial: s.partial, ...extra })
    } catch { /* missing */ }
  }
  await add('temp', 'Arquivos temporários do usuário', env.TEMP ?? '', { deletable: 'temp_clean', note: 'seguro: o Windows recria; arquivos em uso são pulados' })
  if (env.LOCALAPPDATA) await add('npm-cache', 'Cache do npm', join(env.LOCALAPPDATA, 'npm-cache'), { deletable: 'manual', note: 'pode ser refeito com npm cache clean --force' })
  if (env.USERPROFILE) {
    // Old, big files in Downloads: only listed, the owner decides.
    const dl = join(env.USERPROFILE, 'Downloads')
    const budget = newBudget(8000, 100_000)
    const old = []
    const cutoff = Date.now() - 90 * 86_400_000
    await walk(dl, (p, size) => { if (size >= 100 * 2 ** 20) old.push({ p, size }) }, budget).catch(() => {})
    const olds = []
    for (const o of old) {
      try { if ((await stat(o.p)).mtimeMs < cutoff) olds.push(o) } catch { /* gone */ }
    }
    olds.sort((a, b) => b.size - a.size)
    out.push({ id: 'downloads-old', label: 'Downloads com mais de 90 dias e mais de 100 MB', path: dl, sizeMB: Math.round(olds.reduce((a, b) => a + b.size, 0) / 2 ** 20), files: olds.length, deletable: 'manual', examples: olds.slice(0, 5).map((o) => ({ path: o.p, sizeMB: Math.round(o.size / 2 ** 20) })), note: 'só você sabe o que ainda precisa; cada arquivo só é apagado com a sua confirmação' })
  }
  if (isWindows) {
    try {
      const rb = await psJson("$s=(New-Object -ComObject Shell.Application).NameSpace(0xA); $i=@($s.Items()); [pscustomobject]@{n=$i.Count; b=[double](($i | ForEach-Object { $_.Size } | Measure-Object -Sum).Sum)} | ConvertTo-Json -Compress", { timeoutMs: 15000 })
      out.push({ id: 'recycle', label: 'Lixeira', sizeMB: Math.round((rb?.b ?? 0) / 2 ** 20), files: rb?.n ?? 0, deletable: 'manual', note: 'esvazie pela própria Lixeira, depois de conferir' })
    } catch { /* not available */ }
  }
  out.sort((a, b) => b.sizeMB - a.sizeMB)
  return out
}

/** Deletes files in the user TEMP folder that are older than `days`. Locked or vanished files are skipped and counted. */
export async function cleanTemp(tempDir, days = 3) {
  const cutoff = Date.now() - days * 86_400_000
  let freed = 0, removed = 0, skipped = 0
  let entries = []
  try { entries = await readdir(tempDir, { withFileTypes: true }) } catch { return { freedMB: 0, removed: 0, skipped: 0 } }
  for (const e of entries) {
    const p = join(tempDir, e.name)
    try {
      const st = await stat(p)
      if (st.mtimeMs > cutoff) continue
      const size = e.isDirectory() ? (await folderSize(p)).bytes : st.size
      await rm(p, { recursive: true, force: true, maxRetries: 0 })
      freed += size; removed++
    } catch {
      skipped++
    }
  }
  return { freedMB: Math.round(freed / 2 ** 20), removed, skipped }
}

export const folderSizeOf = folderSize
