import { readdir, rmdir, stat, unlink } from 'node:fs/promises'
import { join } from 'node:path'

/**
 * Deletes FILES in the user TEMP folder whose own modification time is older than `days`, then removes folders that
 * ended up empty. Deciding per file (not by the age of a top-level folder, which does not change when something deeper
 * is written) keeps recent data of running programs safe. Links are never followed; locked or vanished files are
 * skipped and counted.
 */
export async function cleanTempFiles(tempDir, days = 3) {
  const cutoff = Date.now() - days * 86_400_000
  const out = { freedMB: 0, removed: 0, skipped: 0 }
  let bytes = 0
  const deadline = Date.now() + 60_000
  async function walk(dir, depth) {
    let entries
    try { entries = await readdir(dir, { withFileTypes: true }) } catch { out.skipped++; return true }
    let empty = true
    for (const e of entries) {
      if (Date.now() > deadline) { empty = false; continue }
      const p = join(dir, e.name)
      if (e.isSymbolicLink()) { empty = false; continue }
      if (e.isDirectory()) {
        if (depth >= 12) { empty = false; continue }
        const sub = await walk(p, depth + 1)
        if (sub) {
          try { await rmdir(p) } catch { empty = false }
        } else empty = false
        continue
      }
      try {
        const st = await stat(p)
        if (st.mtimeMs > cutoff) { empty = false; continue }
        await unlink(p)
        bytes += st.size
        out.removed++
      } catch {
        out.skipped++
        empty = false
      }
    }
    return empty
  }
  await walk(tempDir, 0)
  out.freedMB = Math.round(bytes / 2 ** 20)
  return out
}
