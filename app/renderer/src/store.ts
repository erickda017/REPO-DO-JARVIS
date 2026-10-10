import { create } from 'zustand'
import { api, ApiError, speakViaBridge, type AgentJob, type AuditEntry, type ChatTurn, type Overview, type VoiceStatus } from './api.ts'
import { entityForAudit } from './neural/graph.ts'
import { mediaUrls, parseIntent } from './intents.ts'

import type { ProjectGraph } from '../../electron/projects.ts'
import type { AgentEvent, Metrics } from '../../electron/transcripts.ts'

export type View = 'home' | 'chat' | 'code' | 'projects' | 'ia' | 'agent' | 'ais' | 'system' | 'voice'
export interface Touch { id: number; path: string; at: number }

export type CardBody =
  | { type: 'text'; text: string; meta?: string }
  | { type: 'status'; rows: { label: string; value: string; tone: 'ok' | 'warn' | 'bad' | 'unknown' | 'off' }[] }
  | { type: 'tasks'; items: { title: string; state: string; priority: string }[] }
  | { type: 'timer'; remainingMs: number; label: string }
  | { type: 'media'; url: string; mediaType: 'image' | 'video'; autoload: boolean }
export interface Card { id: number; title: string; body: CardBody; at: number }
export interface Pulse { id: number; entityId: string; at: number }
export interface Message { role: 'user' | 'assistant' | 'error'; text: string; meta?: string }

interface State {
  view: View
  overview: Overview | null
  bridgeOk: boolean
  /** Set when the bridge answered but refused (token/origin/500), so the UI does not call it 'disconnected'. */
  bridgeErr: string | null
  voice: VoiceStatus | null
  messages: Message[]
  busy: boolean
  cards: Card[]
  pulses: Pulse[]
  selected: string | null
  sensitive: boolean
  spend: boolean
  speak: boolean
  caption: { id: number; text: string } | null
  job: AgentJob | null
  dismissJob: () => void
  confirmJob: (approve: boolean) => Promise<void>
  cancelJob: () => Promise<void>
  collapsed: boolean
  toggleSidebar: () => void
  projects: ProjectGraph[]
  touches: Touch[]
  metrics: Metrics | null
  events: AgentEvent[]
  loadProjects: () => Promise<void>
  addProject: () => Promise<void>
  removeProject: (root: string) => Promise<void>
  rescanProject: (root: string) => Promise<void>
  agentUpdate: (m: Metrics, ev: AgentEvent[]) => void
  setView: (v: View) => void
  select: (id: string | null) => void
  toggle: (k: 'sensitive' | 'spend' | 'speak') => void
  refresh: () => Promise<void>
  probe: () => Promise<void>
  pollAudit: () => Promise<void>
  pulse: (entityId: string) => void
  addCard: (title: string, body: CardBody) => void
  closeCard: (id: number) => void
  send: (text: string) => Promise<void>
}

/**
 * Every free-text request goes to the desktop agent (it answers plain chat directly and uses tools when a task or a
 * measurement is asked). Falls back to the plain chat endpoint only when the bridge is an older one without the agent.
 */
async function askAgent(history: ChatTurn[], sensitive: boolean, spend: boolean, onJob: (j: AgentJob) => void) {
  const last = history.at(-1)?.content ?? ''
  let jobId: string
  try {
    ;({ jobId } = await api.agentRun(last, history.slice(0, -1), sensitive, spend))
  } catch (e) {
    if (!(e instanceof ApiError) || !/unknown command endpoint/.test(e.message)) throw e
    const r = await api.chat(history, sensitive, spend)
    return { text: r.text, provider: r.provider, meta: `${r.provider} · ${r.model} · ${r.latencyMs} ms`, steps: 0, jobId: '' }
  }
  const t0 = Date.now()
  for (;;) {
    await new Promise((r) => setTimeout(r, 600))
    const j = await api.agentJob(jobId)
    onJob(j)
    if (j.status === 'done' && j.result) {
      const label = { concluido: 'Concluído', parcial: 'Parcialmente concluído', nao_concluido: 'Não concluído', pergunta: 'Pergunta' }[j.result.status]
      const tools = j.steps.length ? ` · ${j.steps.map((s) => s.tool).join(', ')}` : ''
      return { text: j.result.text, provider: j.provider ?? 'agente', meta: `${label}${tools} · ${((Date.now() - t0) / 1000).toFixed(1)} s`, steps: j.steps.length, jobId }
    }
    if (Date.now() - t0 > 15 * 60_000) throw new ApiError('O agente demorou demais.')
  }
}

const seenAlerts = new Set<string>()
let refreshing = false, polling = false, probing = false, dismissedJob = ''
let seq = 0
const MAX_CARDS = 7
const seen = new Set<string>()
let auditPrimed = false

export const useApp = create<State>((set, get) => ({
  view: 'home',
  overview: null,
  bridgeOk: false,
  bridgeErr: null,
  voice: null,
  messages: [],
  busy: false,
  cards: [],
  pulses: [],
  selected: null,
  sensitive: false,
  spend: false,
  speak: false,
  caption: null,
  job: null,
  dismissJob: () => { dismissedJob = get().job?.id ?? ''; set({ job: null }) },
  confirmJob: async (approve) => {
    const p = get().job?.pending
    if (p) await api.agentConfirm(p.id, approve).catch((e) => get().addCard('Não consegui enviar sua resposta', { type: 'text', text: String(e?.message ?? e) }))
  },
  cancelJob: async () => {
    const j = get().job
    if (j) await api.agentCancel(j.id).catch((e) => get().addCard('Não consegui parar o agente', { type: 'text', text: String(e?.message ?? e) }))
  },
  collapsed: (() => { try { return localStorage.getItem('jarvis.sidebar') === 'collapsed' } catch { return false } })(),
  toggleSidebar: () =>
    set((s) => {
      try { localStorage.setItem('jarvis.sidebar', s.collapsed ? 'open' : 'collapsed') } catch { /* private mode */ }
      return { collapsed: !s.collapsed }
    }),
  projects: [],
  touches: [],
  metrics: null,
  events: [],

  loadProjects: async () => set({ projects: (await window.jarvis?.projects.list()) ?? [] }),
  addProject: async () => {
    const g = await window.jarvis?.projects.add()
    if (g) set((s) => ({ projects: [...s.projects.filter((p) => p.root !== g.root), g] }))
  },
  removeProject: async (root) => {
    await window.jarvis?.projects.remove(root)
    set((s) => ({ projects: s.projects.filter((p) => p.root !== root) }))
  },
  rescanProject: async (root) => {
    const g = await window.jarvis?.projects.rescan(root)
    if (g) set((s) => ({ projects: s.projects.map((p) => (p.root === root ? g : p)) }))
  },
  /** Metrics from the Claude Code transcript; every file the agent touched lights its node in the project network. */
  agentUpdate: (metrics, ev) =>
    set((s) => {
      const fresh = ev.filter((e) => e.kind === 'tool' && e.target && /^[A-Za-z]:[\\/]|^\//.test(e.target))
      return {
        metrics,
        events: [...s.events, ...ev].slice(-80),
        touches: [...s.touches, ...fresh.map((e) => ({ id: ++seq, path: e.target!, at: performance.now() }))].slice(-40),
      }
    }),

  setView: (view) => set({ view }),
  select: (selected) => set({ selected }),
  toggle: (k) => set((s) => ({ [k]: !s[k] }) as Partial<State>),

  refresh: async () => {
    if (refreshing) return
    refreshing = true
    try {
      const [overview, voice] = await Promise.all([api.overview(), api.voice().catch(() => null)])
      set({ overview, voice, bridgeOk: true, bridgeErr: null })
      void api.alerts().then((list) => {
        for (const a of list) {
          if (seenAlerts.has(a.id + a.at)) continue
          seenAlerts.add(a.id + a.at)
          get().addCard(a.level === 'critical' ? 'Alerta: pouco espaço' : 'Aviso de armazenamento', { type: 'text', text: a.text, meta: new Date(a.at).toLocaleTimeString('pt-BR') })
        }
      }).catch(() => {})
    } catch (e) {
      set({ bridgeOk: false, bridgeErr: e instanceof ApiError && e.status ? `Bridge recusou (HTTP ${e.status}): ${e.message}` : null })
    } finally {
      refreshing = false
    }
  },

  /** Free health checks (no inference, no spend) so the screen shows measured state, not "never checked". */
  probe: async () => {
    const ov = get().overview ?? (await api.overview().catch(() => null))
    if (!ov || probing) return
    probing = true
    for (const p of ov.providers.filter((x) => x.enabled)) {
      await api.check(p.id).then(() => get().pulse(`ai:${p.id}`)).catch(() => {})
    }
    for (const s of ov.services) await api.checkService(s.id).then(() => get().pulse(`svc:${s.id}`)).catch(() => {})
    probing = false
    await get().refresh()
  },

  /** New bridge audit entries become pulses on the node that did the work. The first poll only primes the set. */
  pollAudit: async () => {
    if (polling) return
    polling = true
    let entries: AuditEntry[]
    try {
      entries = await api.audit()
    } catch {
      return
    } finally {
      polling = false
    }
    for (const e of [...entries].reverse()) {
      const key = `${e.at}|${e.action}|${String(e.provider ?? e.id ?? '')}`
      if (seen.has(key)) continue
      seen.add(key)
      if (!auditPrimed) continue
      const id = entityForAudit(e)
      if (id) get().pulse(id)
    }
    auditPrimed = true
    if (seen.size > 600) [...seen].slice(0, 300).forEach((k) => seen.delete(k))
  },

  pulse: (entityId) => set((s) => ({ pulses: [...s.pulses.slice(-12), { id: ++seq, entityId, at: performance.now() }] })),

  addCard: (title, body) =>
    set((s) => ({ cards: [...s.cards.slice(-(MAX_CARDS - 1)), { id: ++seq, title, body, at: Date.now() }] })),
  closeCard: (id) => set((s) => ({ cards: s.cards.filter((c) => c.id !== id) })),

  send: async (raw) => {
    const text = raw.trim()
    const st = get()
    if (!text || st.busy) return
    const say = (m: Message) => set((s) => ({ messages: [...s.messages, m] }))
    say({ role: 'user', text })
    const intent = parseIntent(text)
    set({ busy: true })
    try {
      switch (intent.kind) {
        case 'status': {
          const ov = st.overview ?? (await api.overview())
          get().addCard('Estado das IAs', {
            type: 'status',
            rows: ov.providers.map((p) => ({
              label: p.label.split('(')[0].trim(),
              value: !p.enabled ? 'desligada' : !p.status ? 'não checada' : p.status.endpoint.state === 'fail' ? 'inacessível' : `${p.status.model.state === 'ok' ? 'modelo ok' : 'modelo ?'} · auth ${p.status.auth.state}`,
              tone: !p.enabled ? 'off' : !p.status ? 'unknown' : p.status.endpoint.state === 'fail' ? 'bad' : p.status.model.state === 'ok' ? 'ok' : 'warn',
            })),
          })
          get().addCard('Serviços', {
            type: 'status',
            rows: ov.services.map((v) => ({ label: v.name, value: v.status === 'up' ? `ok · ${v.lastLatencyMs} ms` : v.lastError ?? v.status, tone: v.status === 'up' ? 'ok' : v.status === 'unknown' ? 'unknown' : v.status === 'degraded' ? 'warn' : 'bad' })),
          })
          say({ role: 'assistant', text: 'Abri o estado das IAs e dos serviços.' })
          break
        }
        case 'tasks': {
          const open = (st.overview?.tasks ?? (await api.overview()).tasks).filter((t) => t.state !== 'done' && t.state !== 'cancelled')
          get().addCard('Tarefas abertas', { type: 'tasks', items: open.map((t) => ({ title: t.title, state: t.state, priority: t.priority })) })
          get().pulse('tasks')
          say({ role: 'assistant', text: open.length ? `${open.length} tarefa(s) aberta(s).` : 'Nenhuma tarefa aberta.' })
          break
        }
        case 'createTask': {
          const t = await api.createTask(intent.title)
          say({ role: 'assistant', text: `Tarefa criada: ${t.title}` })
          break
        }
        case 'timer': {
          const t = await api.timer('start', intent.seconds)
          get().addCard('Temporizador', { type: 'timer', remainingMs: t.remainingMs, label: t.label })
          say({ role: 'assistant', text: `Temporizador de ${Math.round(intent.seconds / 60 * 10) / 10} min iniciado.` })
          break
        }
        case 'media': {
          get().addCard(intent.mediaType === 'image' ? 'Imagem' : 'Vídeo', { type: 'media', url: intent.url, mediaType: intent.mediaType, autoload: true })
          say({ role: 'assistant', text: 'Aberto.' })
          break
        }
        case 'chat': {
          const history: ChatTurn[] = get()
            .messages.filter((m): m is Message & { role: 'user' | 'assistant' } => m.role !== 'error')
            .slice(-20) // the whole session is not re-sent on every request
            .map((m) => ({ role: m.role, content: m.text }))
          const r = await askAgent(history, st.sensitive, st.spend, (job) => set({ job: job.id !== dismissedJob && (job.steps.length || job.pending) ? job : null }))
          get().pulse('core')
          get().pulse(`ai:${r.provider}`)
          say({ role: 'assistant', text: r.text, meta: r.meta })
          if (r.steps > 0) setTimeout(() => set((x) => (x.job && x.job.status === 'done' && x.job.id === r.jobId ? { job: null } : {})), 14000)
          // The answer shows as a subtitle, not a card, and goes away when the voice stops (or after a reading time).
          const capId = ++seq
          set({ caption: { id: capId, text: r.text } })
          const spoken = st.speak
            ? speakViaBridge(r.text).then(
                (ok): Promise<void> =>
                  ok
                    ? Promise.resolve()
                    : new Promise<void>((done) => {
                        const u = new SpeechSynthesisUtterance(r.text)
                        u.lang = 'pt-BR'
                        u.onend = u.onerror = () => done()
                        speechSynthesis.cancel()
                        speechSynthesis.speak(u)
                        setTimeout(done, Math.min(Math.max(6000, r.text.length * 120), 60000)) // no installed voice = no onend
                      }),
              )
            : new Promise<void>((done) => setTimeout(done, Math.min(Math.max(4000, r.text.length * 65), 25000)))
          void spoken.then(() => setTimeout(() => set((s) => (s.caption?.id === capId ? { caption: null } : {})), 600))
          // Media links written by a model are not fetched until the owner clicks: loading them would tell that host this PC's address.
          for (const m of mediaUrls(r.text).slice(0, 2)) get().addCard(m.mediaType === 'image' ? 'Imagem sugerida' : 'Vídeo sugerido', { type: 'media', url: m.url, mediaType: m.mediaType, autoload: false })
          break
        }
      }
    } catch (e) {
      say({ role: 'error', text: e instanceof ApiError ? e.message : String(e) })
      set({ job: null }) // never leave a spinner behind after a failure
    } finally {
      set({ busy: false })
      void get().refresh()
    }
  },
}))
