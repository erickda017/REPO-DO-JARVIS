import type { Overview, ProviderView } from '../api.ts'

export interface Vec3 { x: number; y: number; z: number }

/** Small seeded PRNG so the decorative cloud has the same shape on every launch. */
export function mulberry32(seed: number): () => number {
  let a = seed >>> 0
  return () => {
    a = (a + 0x6d2b79f5) >>> 0
    let t = a
    t = Math.imul(t ^ (t >>> 15), t | 1)
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61)
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296
  }
}

export interface Cloud { points: Vec3[]; edges: [number, number][]; neighbors: number[][] }

/**
 * The decorative neuron cloud: points inside an ellipsoid with a hollow centre
 * (where the core sits), each linked to its nearest few. It carries no data —
 * the UI says so — it only gives the real nodes something to fire through.
 */
export function buildCloud(count = 320, seed = 7, links = 3, maxLen = 1.25): Cloud {
  const rand = mulberry32(seed)
  const points: Vec3[] = []
  while (points.length < count) {
    const p = { x: (rand() * 2 - 1) * 5.4, y: (rand() * 2 - 1) * 3.2, z: (rand() * 2 - 1) * 3.4 }
    const inside = (p.x / 5.4) ** 2 + (p.y / 3.2) ** 2 + (p.z / 3.4) ** 2 <= 1
    if (inside && Math.hypot(p.x, p.y, p.z) > 1.1) points.push(p)
  }
  const d2 = (a: Vec3, b: Vec3) => (a.x - b.x) ** 2 + (a.y - b.y) ** 2 + (a.z - b.z) ** 2
  const neighbors: number[][] = points.map(() => [])
  const seen = new Set<string>()
  const edges: [number, number][] = []
  points.forEach((p, i) => {
    const near = points
      .map((q, j) => ({ j, d: i === j ? Infinity : d2(p, q) }))
      .sort((a, b) => a.d - b.d)
      .slice(0, links)
    // Short synapses only (the nearest one is always kept so no neuron is isolated): long edges read as a hairball.
    for (const [rank, { j, d }] of near.entries()) {
      if (rank > 0 && d > maxLen * maxLen) continue
      const key = i < j ? `${i}-${j}` : `${j}-${i}`
      if (seen.has(key)) continue
      seen.add(key)
      edges.push([Math.min(i, j), Math.max(i, j)])
      neighbors[i].push(j)
      neighbors[j].push(i)
    }
  })
  return { points, edges, neighbors }
}

/** Index of the cloud neurons closest to a position — the ones a real node "fires through". */
export function nearestNeurons(cloud: Cloud, at: Vec3, n = 3): number[] {
  return cloud.points
    .map((p, i) => ({ i, d: (p.x - at.x) ** 2 + (p.y - at.y) ** 2 + (p.z - at.z) ** 2 }))
    .sort((a, b) => a.d - b.d)
    .slice(0, n)
    .map((x) => x.i)
}

/** Activation spreading through the cloud: each firing excites neighbours a little later and a little weaker. */
export class Activity {
  a: Float32Array
  private queue: { n: number; at: number; s: number }[] = []
  private cloud: Cloud
  constructor(cloud: Cloud) {
    this.cloud = cloud
    this.a = new Float32Array(cloud.points.length)
  }
  fire(n: number, strength = 1, at = 0) {
    this.queue.push({ n, at, s: strength })
  }
  step(dt: number, now: number, rand: () => number) {
    const decay = Math.exp(-dt * 1.8)
    for (let i = 0; i < this.a.length; i++) this.a[i] *= decay
    const keep: { n: number; at: number; s: number }[] = []
    for (const e of this.queue) {
      if (e.at > now) {
        keep.push(e)
        continue
      }
      if (e.s > 0.12 && this.a[e.n] < e.s) {
        this.a[e.n] = e.s
        for (const m of this.cloud.neighbors[e.n]) if (rand() < 0.55) keep.push({ n: m, at: now + 0.05 + rand() * 0.1, s: e.s * 0.78 })
      }
    }
    this.queue = keep.length > 400 ? keep.slice(-400) : keep
  }
}

export type NodeKind = 'core' | 'ai' | 'service' | 'project' | 'tasks' | 'timer' | 'voice'
export type Tone = 'ok' | 'warn' | 'bad' | 'unknown' | 'off'
export interface EntityNode { id: string; kind: NodeKind; label: string; tone: Tone; pos: Vec3; detail: string }

/** Provider tone follows the four-level health, never a bare "reachable". */
export function providerTone(p: ProviderView): Tone {
  if (!p.enabled) return 'off'
  const s = p.status
  if (!s) return 'unknown'
  if (s.endpoint.state === 'fail') return 'bad'
  if (s.auth.state === 'fail' || s.model.state === 'fail' || s.inference.state === 'fail') return 'warn'
  if (s.endpoint.state === 'ok' && s.model.state === 'ok') return 'ok'
  return 'unknown'
}

const ring = (i: number, n: number, r: number, offset: number, y: number): Vec3 => {
  const t = (i / Math.max(n, 1)) * Math.PI * 2 + offset
  return { x: Math.cos(t) * r, y, z: Math.sin(t) * r * 0.4 }
}

const SHELL: Record<NodeKind, number> = { core: 0, ai: 3.3, project: 4.1, service: 4.9, tasks: 5.1, timer: 5.1, voice: 5.1 }
const gcd = (a: number, b: number): number => (b === 0 ? a : gcd(b, a % b))

/**
 * Spread the non-core nodes evenly over a flattened sphere (Fibonacci lattice) so labels do not pile
 * up; the kind decides the shell radius. A coprime stride interleaves kinds around the sphere instead of
 * banding them by latitude. Stable for a given set of entities.
 */
function spread(nodes: EntityNode[]): EntityNode[] {
  const rest = nodes.filter((n) => n.kind !== 'core')
  const m = rest.length
  let stride = 5
  while (m > 1 && gcd(stride, m) !== 1) stride++
  const golden = Math.PI * (3 - Math.sqrt(5))
  const placed = rest.map((n, i) => {
    const k = (i * stride) % Math.max(m, 1)
    const y = 1 - (2 * (k + 0.5)) / m
    const rr = Math.sqrt(Math.max(0, 1 - y * y))
    const R = SHELL[n.kind]
    let x = Math.cos(k * golden) * rr * R
    let yy = y * R * 0.5
    // Keep every node out of the column in front of/behind the core, so none projects over it.
    const flat = Math.hypot(x, yy)
    if (flat < 2.6) {
      const s = flat === 0 ? 0 : 2.6 / flat
      x = flat === 0 ? 2.6 : x * s
      yy *= s
    }
    return { ...n, pos: { x, y: yy, z: Math.sin(k * golden) * rr * R * 0.3 } }
  })
  return [nodes[0], ...placed]
}

/** Real entities as graph nodes. Positions are deterministic so nodes do not jump between refreshes. */
export function layoutEntities(ov: Overview | null): EntityNode[] {
  const nodes: EntityNode[] = [{ id: 'core', kind: 'core', label: 'NÚCLEO', tone: ov ? 'ok' : 'unknown', pos: { x: 0, y: 0, z: 0 }, detail: 'Roteador de IAs' }]
  if (!ov) return nodes
  ov.providers.forEach((p, i) =>
    nodes.push({ id: `ai:${p.id}`, kind: 'ai', label: p.label.split('(')[0].trim(), tone: providerTone(p), pos: ring(i, ov.providers.length, 3.1, 1.2, 0.9 - (i % 2) * 1.8), detail: p.model ?? p.type }),
  )
  ov.services.forEach((s, i) =>
    nodes.push({
      id: `svc:${s.id}`, kind: 'service', label: s.name,
      tone: s.status === 'up' ? 'ok' : s.status === 'degraded' ? 'warn' : s.status === 'down' ? 'bad' : 'unknown',
      pos: ring(i, ov.services.length, 4.9, 0.55, -1.9 + (i % 2) * 3.0), detail: s.lastLatencyMs != null ? `${s.lastLatencyMs} ms` : 'não checado',
    }),
  )
  ov.projects.forEach((p, i) =>
    nodes.push({
      id: `prj:${p.id}`, kind: 'project', label: p.name,
      tone: p.state === 'running' ? 'ok' : p.state === 'degraded' ? 'warn' : p.state === 'stopped' ? 'bad' : 'unknown',
      pos: ring(i, ov.projects.length, 3.7, 2.7, 0.2 + (i % 2) * 0.6), detail: p.state,
    }),
  )
  const open = ov.tasks.filter((t) => t.state !== 'done' && t.state !== 'cancelled').length
  nodes.push({ id: 'tasks', kind: 'tasks', label: 'TAREFAS', tone: open > 0 ? 'ok' : 'off', pos: { x: -5.1, y: 1.3, z: 0.4 }, detail: `${open} abertas` })
  nodes.push({ id: 'timer', kind: 'timer', label: 'TIMER', tone: ov.timer.status === 'running' ? 'ok' : ov.timer.status === 'finished' ? 'warn' : 'off', pos: { x: 5.1, y: 1.4, z: 0.2 }, detail: ov.timer.status })
  nodes.push({ id: 'voice', kind: 'voice', label: 'VOZ', tone: 'unknown', pos: { x: 0, y: 0, z: 0 }, detail: 'ElevenLabs' })
  return spread(nodes)
}

export const TONE_COLOR: Record<Tone, string> = { ok: '#3ff0b0', warn: '#ffb938', bad: '#ff5d78', unknown: '#5aa7c4', off: '#2c4654' }

/** Which node a bridge audit entry should light up. */
export function entityForAudit(e: { action: string; provider?: unknown; id?: unknown }): string | null {
  if (e.action.startsWith('ai.') && typeof e.provider === 'string') return `ai:${e.provider}`
  if (e.action.startsWith('service.') && typeof e.id === 'string') return `svc:${e.id}`
  if (e.action.startsWith('task.')) return 'tasks'
  if (e.action.startsWith('timer.')) return 'timer'
  if (e.action.startsWith('voice.')) return 'voice'
  return null
}
