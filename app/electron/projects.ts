import { readdirSync, readFileSync, realpathSync, statSync, existsSync } from 'node:fs'
import { basename, dirname, extname, join, relative, resolve, sep } from 'node:path'

/**
 * Read-only scan of a folder the owner explicitly granted: files, folders, relative-import
 * links between source files and the "general" files (README, manifests, CI, git remote).
 * Bounded on purpose (node count, file size, depth) so a huge repo cannot freeze the app.
 */
export interface ProjectNode { id: number; path: string; kind: 'dir' | 'file' | 'key'; ext: string; size: number; depth: number }
export interface ProjectGraph {
  root: string
  name: string
  nodes: ProjectNode[]
  edges: [number, number, 'tree' | 'import'][]
  git: { branch: string | null; remote: string | null } | null
  truncated: boolean
  scannedAt: string
}

const SKIP_DIRS = new Set(['ia-local', '.impeccable', 'node_modules', '.git', 'dist', 'dist-app', 'dist-electron', 'build', 'release', '.next', '.venv', 'venv', '__pycache__', 'target', 'coverage', '.cache', '.idea', '.vscode'])
const KEY_FILES = /^(readme(\.\w+)?|package\.json|tsconfig\.json|pyproject\.toml|requirements\.txt|cargo\.toml|go\.mod|dockerfile|docker-compose\.ya?ml|license|claude\.md|\.env\.example|vite\.config\.\w+|makefile)$/i
const SOURCE_EXT = new Set(['.ts', '.tsx', '.js', '.jsx', '.mjs', '.cjs', '.py', '.css'])
const RESOLVE_EXT = ['', '.ts', '.tsx', '.js', '.jsx', '.mjs', '.cjs', '.py', '.css', '/index.ts', '/index.tsx', '/index.js', '/index.mjs']
const MAX_NODES = 700
const MAX_PARSE = 200_000
const IMPORT_RE = /(?:import|export)\s[^'"`;]*?from\s*['"]([^'"]+)['"]|import\s*['"]([^'"]+)['"]|require\(\s*['"]([^'"]+)['"]\s*\)|import\(\s*['"]([^'"]+)['"]\s*\)|^\s*from\s+(\.[\w.]*)\s+import/gm

function gitInfo(root: string): ProjectGraph['git'] {
  const gitDir = join(root, '.git')
  if (!existsSync(gitDir)) return null
  let branch: string | null = null
  let remote: string | null = null
  try {
    const head = readFileSync(join(gitDir, 'HEAD'), 'utf8').trim()
    branch = head.startsWith('ref:') ? head.replace(/^ref:\s*refs\/heads\//, '') : head.slice(0, 8)
  } catch { /* detached or unreadable */ }
  try {
    const cfg = readFileSync(join(gitDir, 'config'), 'utf8')
    remote = /\[remote "origin"\][^[]*?url\s*=\s*(\S+)/.exec(cfg)?.[1]?.replace(/\/\/[^@/]+@/, '//') ?? null // never keep credentials in a URL
  } catch { /* no config */ }
  return { branch, remote }
}

export function scanProject(rootInput: string): ProjectGraph {
  const root = realpathSync(resolve(rootInput))
  if (!statSync(root).isDirectory()) throw new Error('not a directory')
  const nodes: ProjectNode[] = []
  const edges: ProjectGraph['edges'] = []
  const byPath = new Map<string, number>()
  let truncated = false

  const add = (path: string, kind: ProjectNode['kind'], size: number, depth: number) => {
    const id = nodes.length
    nodes.push({ id, path, kind, ext: extname(path).toLowerCase(), size, depth })
    byPath.set(path, id)
    return id
  }
  add('', 'dir', 0, 0)

  // Breadth-first so the top of the tree always survives truncation.
  const queue: { abs: string; id: number; depth: number }[] = [{ abs: root, id: 0, depth: 0 }]
  while (queue.length) {
    const { abs, id: parent, depth } = queue.shift()!
    let entries: import('node:fs').Dirent[]
    try { entries = readdirSync(abs, { withFileTypes: true }) } catch { continue }
    entries.sort((a, b) => Number(b.isDirectory()) - Number(a.isDirectory()) || a.name.localeCompare(b.name))
    for (const e of entries) {
      if (nodes.length >= MAX_NODES) { truncated = true; break }
      if (e.isSymbolicLink()) continue // never follow links out of the granted folder
      const p = join(abs, e.name)
      if (e.isDirectory()) {
        if (SKIP_DIRS.has(e.name) || (e.name.startsWith('.') && e.name !== '.github')) continue
        const id = add(relative(root, p).split(sep).join('/'), 'dir', 0, depth + 1)
        edges.push([parent, id, 'tree'])
        queue.push({ abs: p, id, depth: depth + 1 })
      } else if (e.isFile()) {
        let size = 0
        try { size = statSync(p).size } catch { continue }
        const rel = relative(root, p).split(sep).join('/')
        const id = add(rel, KEY_FILES.test(e.name) || /^\.github\/workflows\//.test(rel) ? 'key' : 'file', size, depth + 1)
        edges.push([parent, id, 'tree'])
      }
    }
    if (truncated) break
  }

  // Import links between source files (relative specifiers only, resolved inside the folder).
  for (const n of nodes) {
    if (n.kind === 'dir' || !SOURCE_EXT.has(n.ext) || n.size > MAX_PARSE) continue
    let text: string
    try { text = readFileSync(join(root, n.path), 'utf8') } catch { continue }
    const dir = dirname(n.path)
    for (const m of text.matchAll(IMPORT_RE)) {
      const spec = m[1] ?? m[2] ?? m[3] ?? m[4] ?? m[5]
      if (!spec || !spec.startsWith('.')) continue
      const base = spec.startsWith('..') || spec.startsWith('./') ? join(dir, spec) : join(dir, spec.replace(/\./g, '/'))
      const cand = base.split(sep).join('/').replace(/^\.\//, '')
      for (const ext of RESOLVE_EXT) {
        const hit = byPath.get(cand + ext) ?? byPath.get(cand.replace(/\.(m?js|jsx)$/, '.ts') + (ext === '' ? '' : ext))
        if (hit !== undefined && hit !== n.id) { edges.push([n.id, hit, 'import']); break }
      }
    }
  }
  return { root, name: basename(root), nodes, edges, git: gitInfo(root), truncated, scannedAt: new Date().toISOString() }
}

/** True when `candidate` is inside `root` (after resolving links) — used before any file is ever read for the UI. */
export function insideRoot(root: string, candidate: string): boolean {
  try {
    const r = realpathSync(root)
    const c = realpathSync(candidate)
    return c === r || c.startsWith(r + sep)
  } catch {
    return false
  }
}
