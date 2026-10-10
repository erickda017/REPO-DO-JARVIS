import type { ProjectGraph } from '../../../electron/projects.ts'
import { mulberry32 } from './graph.ts'

export interface ProjectLayout { positions: Float32Array; radius: number }

/**
 * Force-directed 3D layout of a scanned folder: tree edges are short springs, import edges a bit longer,
 * everything repels. Deterministic (seeded by the folder name) and bounded in cost, so it can run on the
 * UI thread: ~700 nodes x 120 iterations is a few tens of ms.
 */
export function layoutProject(g: ProjectGraph, iterations = 120): ProjectLayout {
  const n = g.nodes.length
  let seed = 7
  for (const c of g.name) seed = (seed * 31 + c.charCodeAt(0)) >>> 0
  const rand = mulberry32(seed)
  const p = new Float32Array(n * 3)
  for (let i = 0; i < n; i++) {
    // start on a sphere whose radius grows with depth, so the root begins in the middle
    const r = 0.4 + g.nodes[i].depth * 0.45
    const u = rand() * 2 - 1, t = rand() * Math.PI * 2, s = Math.sqrt(1 - u * u)
    p.set([r * s * Math.cos(t), r * u, r * s * Math.sin(t)], i * 3)
  }
  const f = new Float32Array(n * 3)
  for (let it = 0; it < iterations; it++) {
    f.fill(0)
    const cool = 1 - it / iterations
    for (let i = 0; i < n; i++) {
      for (let j = i + 1; j < n; j++) {
        const dx = p[i * 3] - p[j * 3], dy = p[i * 3 + 1] - p[j * 3 + 1], dz = p[i * 3 + 2] - p[j * 3 + 2]
        const d2 = dx * dx + dy * dy + dz * dz + 0.01
        if (d2 > 9) continue // far apart: no repulsion needed
        const k = 0.04 / d2
        f[i * 3] += dx * k; f[i * 3 + 1] += dy * k; f[i * 3 + 2] += dz * k
        f[j * 3] -= dx * k; f[j * 3 + 1] -= dy * k; f[j * 3 + 2] -= dz * k
      }
    }
    for (const [a, b, kind] of g.edges) {
      const rest = kind === 'tree' ? 0.45 : 0.9
      const dx = p[b * 3] - p[a * 3], dy = p[b * 3 + 1] - p[a * 3 + 1], dz = p[b * 3 + 2] - p[a * 3 + 2]
      const d = Math.sqrt(dx * dx + dy * dy + dz * dz) + 1e-4
      const k = ((d - rest) / d) * (kind === 'tree' ? 0.18 : 0.05)
      f[a * 3] += dx * k; f[a * 3 + 1] += dy * k; f[a * 3 + 2] += dz * k
      f[b * 3] -= dx * k; f[b * 3 + 1] -= dy * k; f[b * 3 + 2] -= dz * k
    }
    for (let i = 0; i < n; i++) {
      // a light pull to the centre keeps disconnected pieces from drifting away
      // cap each step: without it a few nodes get flung far away and squash everything else when the layout is fitted
      let dx = (f[i * 3] - p[i * 3] * 0.012) * cool * 0.9, dy = (f[i * 3 + 1] - p[i * 3 + 1] * 0.012) * cool * 0.9, dz = (f[i * 3 + 2] - p[i * 3 + 2] * 0.012) * cool * 0.9
      const len = Math.hypot(dx, dy, dz)
      if (len > 0.3) { const k = 0.3 / len; dx *= k; dy *= k; dz *= k }
      p[i * 3] += dx; p[i * 3 + 1] += dy; p[i * 3 + 2] += dz
    }
  }
  // fit into a ball of radius ~2.2 so every project is a similar-sized satellite
  let max = 0
  for (let i = 0; i < n; i++) max = Math.max(max, Math.hypot(p[i * 3], p[i * 3 + 1], p[i * 3 + 2]))
  const s = max > 0 ? 2.2 / max : 1
  for (let i = 0; i < p.length; i++) p[i] *= s
  return { positions: p, radius: 2.2 }
}

/** Where a project's cluster sits around the core: spread on a wide ring so clusters never overlap. */
export function projectCenter(index: number, total: number): { x: number; y: number; z: number } {
  const a = (index / Math.max(total, 1)) * Math.PI * 2 + 0.6
  return { x: Math.cos(a) * 7, y: Math.sin(a * 2) * 1.1, z: Math.sin(a) * 3.2 }
}

export const EXT_COLOR: Record<string, string> = {
  '.ts': '#4fd8ff', '.tsx': '#4fd8ff', '.js': '#ffd166', '.mjs': '#ffd166', '.cjs': '#ffd166', '.jsx': '#ffd166',
  '.py': '#7be28f', '.css': '#d58bff', '.json': '#8aa4b3', '.md': '#b9c6cf', '.html': '#ff9f6b',
}

/** Index of the node a (possibly absolute) file path refers to, or -1. Windows paths compare case-insensitively. */
export function findNode(g: ProjectGraph, filePath: string): number {
  const norm = (s: string) => s.replace(/\\/g, '/').toLowerCase()
  const root = norm(g.root).replace(/\/$/, '') + '/'
  const f = norm(filePath)
  if (!f.startsWith(root)) return -1
  const rel = f.slice(root.length)
  return g.nodes.findIndex((n) => n.path.toLowerCase() === rel)
}
