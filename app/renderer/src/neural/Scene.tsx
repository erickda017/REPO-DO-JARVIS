import { useEffect, useLayoutEffect, useMemo, useRef, useState } from 'react'
import { Canvas, useFrame } from '@react-three/fiber'
import { Html, OrbitControls } from '@react-three/drei'
import { Bloom, EffectComposer } from '@react-three/postprocessing'
import * as THREE from 'three'
import { useApp } from '../store.ts'
import { voice } from '../voice/level.ts'
import { Activity, buildCloud, layoutEntities, mulberry32, nearestNeurons, TONE_COLOR, type EntityNode } from './graph.ts'
import { EXT_COLOR, findNode, layoutProject, projectCenter } from './projectGraph.ts'
import type { ProjectGraph } from '../../../electron/projects.ts'

const reduced = () => typeof matchMedia === 'function' && matchMedia('(prefers-reduced-motion: reduce)').matches
const BASE = new THREE.Color(0.025, 0.11, 0.16)
const HOT = new THREE.Color(0.5, 0.95, 1.0)

const RADIUS: Record<string, number> = { core: 0.42, ai: 0.27, service: 0.19, project: 0.21, tasks: 0.19, timer: 0.19, voice: 0.19 }

/** One granted project folder as its own satellite network: dirs, files, imports. Agent file touches light nodes up. */
function ProjectCloud({ g, index, total }: { g: ProjectGraph; index: number; total: number }) {
  const { positions } = useMemo(() => layoutProject(g), [g])
  const c = useMemo(() => projectCenter(index, total), [index, total])
  const n = g.nodes.length
  const inst = useRef<THREE.InstancedMesh>(null)
  const flash = useRef(new Float32Array(n))
  const lastTouch = useRef(0)
  const col = useMemo(() => new THREE.Color(), [])
  const base = useMemo(() => g.nodes.map((nd) => new THREE.Color(nd.kind === 'key' ? '#fff1b8' : nd.kind === 'dir' ? '#2d7fa3' : (EXT_COLOR[nd.ext] ?? '#6f8c9b')).multiplyScalar(nd.kind === 'dir' ? 0.8 : 0.95)), [g])
  const lineGeo = useMemo(() => {
    const pos = new Float32Array(g.edges.length * 6)
    g.edges.forEach(([a, b], k) => pos.set([positions[a * 3], positions[a * 3 + 1], positions[a * 3 + 2], positions[b * 3], positions[b * 3 + 1], positions[b * 3 + 2]], k * 6))
    const geo = new THREE.BufferGeometry()
    geo.setAttribute('position', new THREE.BufferAttribute(pos, 3))
    geo.setAttribute('color', new THREE.BufferAttribute(new Float32Array(g.edges.length * 6), 3))
    return geo
  }, [g, positions])
  useLayoutEffect(() => {
    const m = inst.current
    if (!m) return
    const d = new THREE.Object3D()
    g.nodes.forEach((nd, i) => {
      d.position.set(positions[i * 3], positions[i * 3 + 1], positions[i * 3 + 2])
      d.scale.setScalar(nd.kind === 'key' ? 2.2 : nd.kind === 'dir' ? 1.5 : 0.8 + Math.min(Math.log10(nd.size + 10) * 0.22, 1))
      d.updateMatrix()
      m.setMatrixAt(i, d.matrix)
      m.setColorAt(i, base[i])
    })
    m.instanceMatrix.needsUpdate = true
  }, [g, positions, base])
  useFrame((_, dt) => {
    for (const t of useApp.getState().touches) {
      if (t.id <= lastTouch.current) continue
      lastTouch.current = t.id
      const i = findNode(g, t.path)
      if (i >= 0) flash.current[i] = 1
    }
    const f = flash.current
    for (let i = 0; i < n; i++) f[i] = Math.max(0, f[i] - dt * 0.7)
    const m = inst.current
    if (m) {
      for (let i = 0; i < n; i++) m.setColorAt(i, col.copy(base[i]).lerp(HOT, Math.min(f[i], 1)).multiplyScalar(1 + f[i] * 2.5 + voice.level * 0.7))
      if (m.instanceColor) m.instanceColor.needsUpdate = true
    }
    const cc = lineGeo.getAttribute('color') as THREE.BufferAttribute
    g.edges.forEach(([a, b, kind], k) => {
      const v = Math.max(f[a], f[b])
      if (kind === 'tree') col.setRGB(0.025, 0.09, 0.13)
      else col.setRGB(0.07, 0.26, 0.32)
      col.multiplyScalar(1 + v * 3 + voice.level * 1.2)
      cc.setXYZ(k * 2, col.r, col.g, col.b)
      cc.setXYZ(k * 2 + 1, col.r, col.g, col.b)
    })
    cc.needsUpdate = true
  })
  return (
    <group position={[c.x, c.y, c.z]}>
      <instancedMesh ref={inst} args={[undefined, undefined, n]}>
        <sphereGeometry args={[0.05, 8, 6]} />
        <meshBasicMaterial toneMapped={false} />
      </instancedMesh>
      <lineSegments geometry={lineGeo}>
        <lineBasicMaterial vertexColors toneMapped={false} transparent opacity={0.5} />
      </lineSegments>
      <Html center position={[0, 2.7, 0]} style={{ pointerEvents: 'none' }} zIndexRange={[10, 0]}>
        <div className="node-label"><span>{g.name.toUpperCase()}</span><small>{g.git?.branch ? ` · ${g.git.branch}` : ''}{` · ${n} itens`}{g.truncated ? '+' : ''}</small></div>
      </Html>
    </group>
  )
}

function Projects() {
  const projects = useApp((s) => s.projects)
  const links = useMemo(() => {
    const pts: number[] = []
    projects.forEach((_, i) => { const c = projectCenter(i, projects.length); pts.push(0, 0, 0, c.x, c.y, c.z) })
    const geo = new THREE.BufferGeometry()
    geo.setAttribute('position', new THREE.Float32BufferAttribute(pts, 3))
    return geo
  }, [projects])
  return (
    <>
      <lineSegments geometry={links}><lineBasicMaterial color={[0.03, 0.14, 0.2]} toneMapped={false} transparent opacity={0.4} /></lineSegments>
      {projects.map((g, i) => <ProjectCloud key={g.root} g={g} index={i} total={projects.length} />)}
    </>
  )
}

function World() {
  const overview = useApp((s) => s.overview)
  const nodes = useMemo(() => layoutEntities(overview), [overview])
  const cloud = useMemo(() => buildCloud(), [])
  const activity = useMemo(() => new Activity(cloud), [cloud])
  const rand = useMemo(() => mulberry32(99), [])
  const links = useMemo(() => new Map(nodes.map((n) => [n.id, nearestNeurons(cloud, n.pos, 3)])), [nodes, cloud])
  const group = useRef<THREE.Group>(null)
  const flash = useRef(new Map<string, number>())
  const lastPulse = useRef(0)
  const travelers = useRef<{ to: EntityNode; t0: number }[]>([])
  const sprites = useRef<(THREE.Mesh | null)[]>([])
  const nextIdle = useRef(0)
  const speechAcc = useRef(0)
  const still = useMemo(reduced, [])

  // Cloud instances
  const inst = useRef<THREE.InstancedMesh>(null)
  const lines = useRef<THREE.LineSegments>(null)
  const color = useMemo(() => new THREE.Color(), [])
  const lineGeo = useMemo(() => {
    const g = new THREE.BufferGeometry()
    const pos = new Float32Array(cloud.edges.length * 6)
    cloud.edges.forEach(([i, j], k) => {
      const a = cloud.points[i], b = cloud.points[j]
      pos.set([a.x, a.y, a.z, b.x, b.y, b.z], k * 6)
    })
    g.setAttribute('position', new THREE.BufferAttribute(pos, 3))
    g.setAttribute('color', new THREE.BufferAttribute(new Float32Array(cloud.edges.length * 6), 3))
    return g
  }, [cloud])

  useLayoutEffect(() => {
    const m = inst.current
    if (!m) return
    const d = new THREE.Object3D()
    cloud.points.forEach((p, i) => {
      d.position.set(p.x, p.y, p.z)
      d.updateMatrix()
      m.setMatrixAt(i, d.matrix)
      m.setColorAt(i, BASE)
    })
    m.instanceMatrix.needsUpdate = true
  }, [cloud])

  // Real links: core to every entity, and each entity to the neurons it fires through.
  const linkGeo = useMemo(() => {
    const pts: number[] = []
    const colors: number[] = []
    const c = new THREE.Color()
    for (const n of nodes) {
      if (n.id === 'core') continue
      c.set(TONE_COLOR[n.tone]).multiplyScalar(n.tone === 'off' ? 0.18 : 0.5)
      pts.push(0, 0, 0, n.pos.x, n.pos.y, n.pos.z)
      colors.push(c.r, c.g, c.b, c.r, c.g, c.b)
      for (const i of links.get(n.id) ?? []) {
        const p = cloud.points[i]
        pts.push(n.pos.x, n.pos.y, n.pos.z, p.x, p.y, p.z)
        colors.push(c.r * 0.22, c.g * 0.22, c.b * 0.22, c.r * 0.22, c.g * 0.22, c.b * 0.22)
      }
    }
    const g = new THREE.BufferGeometry()
    g.setAttribute('position', new THREE.Float32BufferAttribute(pts, 3))
    g.setAttribute('color', new THREE.Float32BufferAttribute(colors, 3))
    return g
  }, [nodes, links, cloud])

  useFrame((state, dt) => {
    const now = state.clock.elapsedTime
    if (group.current && !still) group.current.rotation.y += dt * 0.035

    // Real pulses from the store become travellers from the core to the node.
    for (const p of useApp.getState().pulses) {
      if (p.id <= lastPulse.current) continue
      lastPulse.current = p.id
      const to = nodes.find((n) => n.id === p.entityId)
      if (!to) continue
      if (to.id === 'core') flash.current.set('core', 1)
      else travelers.current.push({ to, t0: now })
    }
    travelers.current = travelers.current.filter((t) => {
      const k = (now - t.t0) / 0.9
      if (k >= 1) {
        flash.current.set(t.to.id, 1)
        for (const i of links.get(t.to.id) ?? []) activity.fire(i, 1, now)
        return false
      }
      return true
    })
    sprites.current.forEach((m, i) => {
      const t = travelers.current[i]
      if (!m) return
      m.visible = Boolean(t)
      if (t) {
        const k = 1 - (1 - (now - t.t0) / 0.9) ** 3
        m.position.set(t.to.pos.x * k, t.to.pos.y * k, t.to.pos.z * k)
      }
    })
    for (const [id, v] of flash.current) flash.current.set(id, Math.max(0, v - dt * 1.6))

    // Ambient firing: decorative, labelled as such in the UI.
    if (!still && now > nextIdle.current) {
      activity.fire(Math.floor(rand() * cloud.points.length), 0.55, now)
      nextIdle.current = now + 0.5 + rand() * 0.9
    }
    // While JARVIS speaks, the network is driven by his voice: more neurons fire, the core beats and everything brightens with the loudness.
    const lv = voice.level
    if (lv > 0.02) {
      speechAcc.current += dt * (8 + lv * 70)
      for (; speechAcc.current >= 1; speechAcc.current--) activity.fire(Math.floor(rand() * cloud.points.length), 0.5 + lv * 0.8, now)
      flash.current.set('core', Math.max(flash.current.get('core') ?? 0, lv))
    }
    activity.step(dt, now, rand)

    const m = inst.current
    if (m) {
      for (let i = 0; i < cloud.points.length; i++) {
        const a = activity.a[i]
        color.copy(BASE).lerp(HOT, Math.min(a + lv * 0.12, 1)).multiplyScalar(1 + a * 1.4 + lv * 0.9)
        m.setColorAt(i, color)
      }
      if (m.instanceColor) m.instanceColor.needsUpdate = true
    }
    const col = lineGeo.getAttribute('color') as THREE.BufferAttribute
    cloud.edges.forEach(([i, j], k) => {
      const v = Math.max(activity.a[i], activity.a[j])
      color.copy(BASE).multiplyScalar(0.2).lerp(HOT, Math.min(v + lv * 0.1, 1)).multiplyScalar(1 + v * 1.4 + lv * 1.2)
      col.setXYZ(k * 2, color.r, color.g, color.b)
      col.setXYZ(k * 2 + 1, color.r, color.g, color.b)
    })
    col.needsUpdate = true
  })

  const addCard = useApp((s) => s.addCard)
  const onPick = (n: EntityNode) => {
    useApp.getState().select(n.id)
    if (!useApp.getState().cards.some((c) => c.title === n.label)) addCard(n.label, { type: 'text', text: n.detail, meta: n.kind })
  }

  return (
    <>
    <Projects />
    <group ref={group} scale={0.78}>
      <instancedMesh ref={inst} args={[undefined, undefined, cloud.points.length]}>
        <sphereGeometry args={[0.045, 8, 6]} />
        <meshBasicMaterial toneMapped={false} />
      </instancedMesh>
      <lineSegments ref={lines} geometry={lineGeo}>
        <lineBasicMaterial vertexColors toneMapped={false} transparent opacity={0.45} />
      </lineSegments>
      <lineSegments geometry={linkGeo}>
        <lineBasicMaterial vertexColors toneMapped={false} transparent opacity={0.6} />
      </lineSegments>

      {nodes.map((n) => (
        <EntityMesh key={n.id} node={n} flash={flash} onPick={onPick} />
      ))}
      {Array.from({ length: 8 }, (_, i) => (
        <mesh key={i} ref={(el) => void (sprites.current[i] = el)} visible={false}>
          <sphereGeometry args={[0.07, 10, 8]} />
          <meshBasicMaterial color={[2.2, 3.2, 3.6]} toneMapped={false} />
        </mesh>
      ))}
    </group>
    </>
  )
}

function EntityMesh({ node, flash, onPick }: { node: EntityNode; flash: React.RefObject<Map<string, number>>; onPick: (n: EntityNode) => void }) {
  const mesh = useRef<THREE.Mesh>(null)
  const mat = useRef<THREE.MeshBasicMaterial>(null)
  const ring = useRef<THREE.Mesh>(null)
  const r = RADIUS[node.kind]
  // Fixed labels only for the core, AIs and services; everything else (projects, tasks, timer...) names itself on hover, so labels never pile up.
  const [hover, setHover] = useState(false)
  const showLabel = hover || node.kind === 'core' || node.kind === 'ai' || node.kind === 'service'
  const base = useMemo(() => new THREE.Color(TONE_COLOR[node.tone]), [node.tone])
  useFrame((_, dt) => {
    const f = flash.current.get(node.id) ?? 0
    if (mesh.current) mesh.current.scale.setScalar(1 + f * 0.55)
    if (mat.current) mat.current.color.copy(base).multiplyScalar((node.tone === 'off' ? 0.8 : 1.15) + f * 2.4)
    if (ring.current) ring.current.rotation.z += dt * 0.5
  })
  return (
    <group position={[node.pos.x, node.pos.y, node.pos.z]}>
      <mesh ref={mesh} onClick={(e) => (e.stopPropagation(), onPick(node))} onPointerOver={() => (document.body.style.cursor = 'pointer', setHover(true))} onPointerOut={() => (document.body.style.cursor = '', setHover(false))}>
        <sphereGeometry args={[r, 20, 16]} />
        <meshBasicMaterial ref={mat} toneMapped={false} />
      </mesh>
      {node.kind === 'core' && (
        <>
          <mesh ref={ring}>
            <torusGeometry args={[0.72, 0.012, 8, 64]} />
            <meshBasicMaterial color={[0.6, 2, 2.4]} toneMapped={false} />
          </mesh>
          <mesh rotation={[Math.PI / 2.4, 0, 0]}>
            <torusGeometry args={[0.95, 0.008, 8, 64]} />
            <meshBasicMaterial color={[0.3, 1, 1.3]} toneMapped={false} />
          </mesh>
        </>
      )}
      {showLabel && (
        <Html center position={[0, -(r + 0.3), 0]} style={{ pointerEvents: 'none' }} zIndexRange={[10, 0]}>
          <div className="node-label" data-tone={node.tone}>
            <span>{node.label}</span>
          </div>
        </Html>
      )}
    </group>
  )
}

export function NeuralScene() {
  useEffect(() => () => void (document.body.style.cursor = ''), [])
  return (
    <Canvas camera={{ position: [0, 0.8, 15.5], fov: 48 }} dpr={[1, 1.5]} gl={{ antialias: false, powerPreference: 'high-performance' }} aria-label="Rede neural: nós grandes são entidades reais, a nuvem é uma metáfora visual">
      <color attach="background" args={['#02060a']} />
      <World />
      <OrbitControls enablePan={false} enableDamping minDistance={6} maxDistance={26} maxPolarAngle={Math.PI * 0.72} minPolarAngle={Math.PI * 0.28} rotateSpeed={0.5} />
      <EffectComposer>
        <Bloom intensity={0.85} luminanceThreshold={0.35} luminanceSmoothing={0.3} mipmapBlur />
      </EffectComposer>
    </Canvas>
  )
}
