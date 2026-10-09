import { create } from 'zustand'
import { api, ApiError, speakViaBridge, type AuditEntry, type ChatTurn, type Overview, type VoiceStatus } from './api.ts'
import { entityForAudit } from './neural/graph.ts'
import { mediaUrls, parseIntent } from './intents.ts'

export type View = 'home' | 'chat' | 'ais' | 'system' | 'voice'

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
  voice: VoiceStatus | null
  messages: Message[]
  busy: boolean
  cards: Card[]
  pulses: Pulse[]
  selected: string | null
  sensitive: boolean
  spend: boolean
  speak: boolean
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

let seq = 0
const MAX_CARDS = 7
const seen = new Set<string>()
let auditPrimed = false

export const useApp = create<State>((set, get) => ({
  view: 'home',
  overview: null,
  bridgeOk: false,
  voice: null,
  messages: [],
  busy: false,
  cards: [],
  pulses: [],
  selected: null,
  sensitive: false,
  spend: false,
  speak: false,

  setView: (view) => set({ view }),
  select: (selected) => set({ selected }),
  toggle: (k) => set((s) => ({ [k]: !s[k] }) as Partial<State>),

  refresh: async () => {
    try {
      const [overview, voice] = await Promise.all([api.overview(), api.voice().catch(() => null)])
      set({ overview, voice, bridgeOk: true })
    } catch {
      set({ bridgeOk: false })
    }
  },

  /** Free health checks (no inference, no spend) so the screen shows measured state, not "never checked". */
  probe: async () => {
    const ov = get().overview ?? (await api.overview().catch(() => null))
    if (!ov) return
    for (const p of ov.providers.filter((x) => x.enabled)) {
      await api.check(p.id).then(() => get().pulse(`ai:${p.id}`)).catch(() => {})
    }
    for (const s of ov.services) await api.checkService(s.id).then(() => get().pulse(`svc:${s.id}`)).catch(() => {})
    await get().refresh()
  },

  /** New bridge audit entries become pulses on the node that did the work. The first poll only primes the set. */
  pollAudit: async () => {
    let entries: AuditEntry[]
    try {
      entries = await api.audit()
    } catch {
      return
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
            .map((m) => ({ role: m.role, content: m.text }))
          const r = await api.chat(history, st.sensitive, st.spend)
          get().pulse('core')
          get().pulse(`ai:${r.provider}`)
          say({ role: 'assistant', text: r.text, meta: `${r.provider} · ${r.model} · ${r.latencyMs} ms` })
          get().addCard('JARVIS', { type: 'text', text: r.text, meta: `${r.provider} · ${r.latencyMs} ms` })
          // Media links written by a model are not fetched until the owner clicks: loading them would tell that host this PC's address.
          for (const m of mediaUrls(r.text).slice(0, 2)) get().addCard(m.mediaType === 'image' ? 'Imagem sugerida' : 'Vídeo sugerido', { type: 'media', url: m.url, mediaType: m.mediaType, autoload: false })
          if (st.speak && !(await speakViaBridge(r.text))) {
            const u = new SpeechSynthesisUtterance(r.text)
            u.lang = 'pt-BR'
            speechSynthesis.speak(u)
          }
          break
        }
      }
    } catch (e) {
      say({ role: 'error', text: e instanceof ApiError ? e.message : String(e) })
    } finally {
      set({ busy: false })
      void get().refresh()
    }
  },
}))
