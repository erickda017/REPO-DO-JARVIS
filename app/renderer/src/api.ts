export const BASE: string = import.meta.env.VITE_BRIDGE_URL ?? 'http://127.0.0.1:8787'

export type CheckState = 'ok' | 'fail' | 'unknown' | 'skipped'
export interface Check { state: CheckState; detail?: string; latencyMs?: number }

export interface ProviderView {
  id: string
  label: string
  type: string
  enabled: boolean
  external: boolean
  paid: boolean
  keyEnv: string | null
  warning: string | null
  priority: number
  model: string | null
  capabilities: string[]
  status: null | { endpoint: Check; auth: Check; model: Check; inference: Check; checkedAt: string; models?: string[] | null }
  recentErrors: { kind: string; message: string; at: string }[]
}
export interface KeyStatus { name: string; configured: boolean; source: string | null; last4: string | null }
export interface ServiceView {
  id: string
  name: string
  url: string
  status: 'up' | 'degraded' | 'down' | 'unknown'
  lastChecked: string | null
  lastLatencyMs: number | null
  lastError: string | null
  consecutiveFailures: number
}
export interface ProjectView {
  id: string
  name: string
  state: 'running' | 'degraded' | 'stopped' | 'unknown'
  checks: { type: string; ok: boolean; detail: string; unknown?: boolean }[]
  detail: string | null
}
export type TaskState = 'todo' | 'doing' | 'blocked' | 'done' | 'cancelled'
export type Priority = 'low' | 'normal' | 'high' | 'urgent'
export interface Task { id: string; title: string; notes: string; priority: Priority; state: TaskState; result: string | null; createdAt: string; updatedAt: string }
export interface TimerView { status: 'idle' | 'running' | 'paused' | 'finished'; label: string; durationMs: number; remainingMs: number }
export interface Overview { providers: ProviderView[]; services: ServiceView[]; projects: ProjectView[]; tasks: Task[]; timer: TimerView }
export interface AuditEntry { at: string; action: string; provider?: string; id?: string; [k: string]: unknown }
export interface ChatTurn { role: 'user' | 'assistant'; content: string }
export interface ChatReply { text: string; model: string; provider: string; latencyMs: number; routing?: { choice: string | null; skipped: string | null } }
export interface VoiceStatus { configured: boolean; source: string | null; last4: string | null; voiceId: string }
export interface VoiceTest { ok: boolean; latencyMs: number; voices: { id: string; name: string }[] }

export class ApiError extends Error {}

async function call<T>(method: 'GET' | 'POST', path: string, body?: unknown): Promise<T> {
  let res: Response
  try {
    res = await fetch(`${BASE}/api/command/${path}`, {
      method,
      headers: method === 'POST' ? { 'content-type': 'application/json' } : undefined,
      body: method === 'POST' ? JSON.stringify(body ?? {}) : undefined,
    })
  } catch {
    throw new ApiError('Bridge inacessível. Ele está rodando em ' + BASE + '?')
  }
  const json = (await res.json().catch(() => ({}))) as { error?: string; message?: string }
  if (!res.ok) throw new ApiError(json.error ?? json.message ?? `HTTP ${res.status}`)
  return json as T
}

export const api = {
  overview: () => call<Overview>('GET', 'overview'),
  audit: () => call<AuditEntry[]>('GET', 'audit'),
  check: (providerId: string) => call<unknown>('POST', 'ai/check', { providerId }),
  chat: (messages: ChatTurn[], sensitive: boolean, confirm: boolean) => call<ChatReply>('POST', 'ai/chat', { messages, sensitive, confirm }),
  checkService: (id: string) => call<unknown>('POST', 'services/check', { id }),
  createTask: (title: string, priority: Priority = 'normal') => call<Task>('POST', 'tasks', { title, priority }),
  updateTask: (id: string, patch: Partial<Pick<Task, 'state' | 'priority'>>) => call<Task>('POST', 'tasks/update', { id, ...patch }),
  deleteTask: (id: string) => call<unknown>('POST', 'tasks/delete', { id, confirm: true }),
  timer: (action: 'start' | 'pause' | 'resume' | 'cancel', seconds?: number, label?: string) => call<TimerView>('POST', `timer/${action}`, action === 'start' ? { seconds, label } : {}),
  keys: () => call<KeyStatus[]>('GET', 'keys'),
  setKey: (name: string, value: string) => call<KeyStatus[]>('POST', 'keys', { name, value }),
  clearKey: (name: string) => call<KeyStatus[]>('POST', 'keys/clear', { name }),
  providerUpdate: (id: string, patch: { enabled?: boolean; model?: string; priority?: number }) => call<ProviderView[]>('POST', 'providers/update', { id, ...patch }),
  voice: () => call<VoiceStatus>('GET', 'voice'),
  voiceSet: (apiKey?: string, voiceId?: string) => call<VoiceStatus>('POST', 'voice', { apiKey, voiceId }),
  voiceTest: () => call<VoiceTest>('POST', 'voice/test'),
  voiceClear: () => call<VoiceStatus>('POST', 'voice/clear'),
}

/** Speak text with the bridge's ElevenLabs endpoint; resolves false when it is not available. */
export async function speakViaBridge(text: string): Promise<boolean> {
  try {
    const r = await fetch(`${BASE}/tts`, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ text }) })
    if (!r.ok) return false
    void new Audio(URL.createObjectURL(await r.blob())).play()
    return true
  } catch {
    return false
  }
}
