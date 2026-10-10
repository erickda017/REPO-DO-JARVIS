import { trackAudio } from './voice/level.ts'

export const BASE: string = import.meta.env.VITE_BRIDGE_URL ?? 'http://127.0.0.1:8787'

export type CheckState = 'ok' | 'fail' | 'unknown' | 'skipped'
export interface Check { state: CheckState; detail?: string; latencyMs?: number }

/** What the agent asks of the interface; the window applies it (see store.applyUi). */
export interface UiAction { seq: number; type: 'theme' | 'view' | 'set' | 'card'; id?: string; key?: string; value?: boolean; title?: string; body?: { type: string; [k: string]: unknown } }

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
  allowedModels: string[]
  extraOf: string | null
  editableUrl?: boolean // the address is pasted by the owner (Colab tunnel)
  baseUrl?: string
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
export interface Overview { apisOnly?: boolean; providers: ProviderView[]; services: ServiceView[]; projects: ProjectView[]; tasks: Task[]; timer: TimerView }
export interface AuditEntry { at: string; action: string; provider?: string; id?: string; [k: string]: unknown }
export interface ChatTurn { role: 'user' | 'assistant'; content: string }
export interface ChatReply { text: string; model: string; provider: string; latencyMs: number; routing?: { choice: string | null; skipped: string | null } }
export interface VoiceStatus { configured: boolean; source: string | null; last4: string | null; voiceId: string }
export interface VoiceTest { ok: boolean; latencyMs: number; voices: { id: string; name: string }[] }

export interface AgentStep { id: number; tool: string; why: string | null; risk: string; ok?: boolean; verified?: boolean | null; evidence?: string; error?: string; denied?: boolean; skipped?: boolean; summary?: string }
export interface AgentResult { status: 'concluido' | 'parcial' | 'nao_concluido' | 'pergunta'; kind: string; text: string; notes: string[]; evidence: unknown[]; audit?: { verdict: string; reason: string } }
export interface AgentJob { id: string; status: 'running' | 'awaiting' | 'done'; partial?: string | null; steps: AgentStep[]; pending: { id: string; tool: string; message: string } | null; result: AgentResult | null; provider: string | null; model?: string | null; models?: string[] }
export interface AgentAccess { tools: Record<string, boolean>; roots: { path: string; label: string }[]; groups: Record<string, string>; autoDev?: boolean }
export type MissionStatus = 'planning' | 'running' | 'awaiting' | 'verifying' | 'concluido' | 'parcial' | 'nao_concluido' | 'cancelled' | 'interrupted'
export interface MissionStep { id: string; title: string; role: string; depends: string[]; status: 'pending' | 'running' | 'done' | 'failed' | 'skipped' | 'asking' | 'replaced'; attempts: number; summary?: string; notes?: string[]; question?: string; toolCalls?: number }
export interface MissionView {
  id: string; goal: string; status: MissionStatus; phase: string; criteria: string[]; replans: number
  limits: { maxMs: number; maxSteps: number; maxReplans: number; maxTokens: number }; usage: { inputTokens: number; outputTokens: number; calls: number }
  steps: MissionStep[]; pending: { jobId: string; step?: string; id: string; tool: string; message: string }[]
  active: { step?: string; role?: string; tools: string[]; provider?: string }[]
  verification: { verdict?: string; text?: string } | null; final: { status: string; text: string; stepsDone: number; stepsTotal: number; verdict: string | null } | null
  log: { at: string; kind: string; text: string }[]; startedAt?: string; updatedAt?: string
}
export interface MissionRow { id: string; goal: string; status: MissionStatus; phase: string; steps: number; done: number; createdAt: string }
export interface PanelRow { id: string; title: string; purpose: string | null; status: string; pinned: boolean; owner: { kind: string; id?: string }; createdAt: string; updatedAt: string; specRev: number }
export interface PanelView {
  id: string; name: string; status: 'loading' | 'ready' | 'error' | 'done'; statusText: string; pinned: boolean; owner: { kind: string }; trusted: boolean; updatedAt: string
  specRev: number; spec?: any; data: Record<string, { rev: number; value: unknown }>; sources: Record<string, { ok: boolean | null; error: string | null }>
  stateOps?: { rev: number; values: Record<string, string | number | boolean | (string | number)[]> }; stateRev: number
}
export interface PanelActionResult { ok: boolean; needsConfirm?: boolean; message?: string; tool?: string; args?: unknown; error?: string; code?: string; ask?: string; client?: boolean; result?: unknown; verified?: boolean | null; evidence?: string | null; summary?: string; setState?: Record<string, any>; stored?: boolean }
export interface MemoryItem { id: string; at: string; kind: string; text: string; source: string; confidence: string; tags: string[] }
export interface DiskInfo { drive: string; label: string; totalGB: number; freeGB: number; usedGB: number; freePct: number | null }
export interface MonitorView {
  summary: { cpu: { model?: string; logicalCores: number; usagePct: number | null }; memory: { totalGB: number; usedGB: number; freeGB: number; usedPct: number }; uptimeHours: number }
  report: { available: boolean; reason?: string; coveredMinutes?: number; note?: string | null; cpu?: { avgPct: number; maxPct: number; minPct: number }; memory?: { avgUsedPct: number; maxUsedPct: number } }
  history: { t: number; cpu: number | null; memUsedPct: number }[]
  disks: DiskInfo[]
}
export interface AgentAlert { id: string; level: 'warning' | 'critical'; at: number; text: string }
export interface ToolRun { ok: boolean; error?: string; data?: any; verified?: boolean | null; evidence?: string }

export class ApiError extends Error {
  /** HTTP status when the bridge answered (401 token, 403 origin, 5xx...); undefined when it could not be reached. */
  constructor(message: string, public status?: number) { super(message) }
}

async function call<T>(method: 'GET' | 'POST', path: string, body?: unknown): Promise<T> {
  let res: Response
  try {
    res = await fetch(`${BASE}/api/command/${path}`, {
      method,
      headers: { ...(method === 'POST' ? { 'content-type': 'application/json' } : {}), ...(window.jarvis?.token ? { 'x-jarvis-token': window.jarvis.token } : {}) },
      body: method === 'POST' ? JSON.stringify(body ?? {}) : undefined,
      signal: AbortSignal.timeout(path.startsWith('ai/') || path.startsWith('check') ? 150_000 : 30_000), // a hung bridge must not pile up requests
    })
  } catch {
    throw new ApiError('Bridge inacessível. Ele está rodando em ' + BASE + '?')
  }
  const json = (await res.json().catch(() => ({}))) as { error?: string; message?: string }
  if (!res.ok) throw new ApiError(json.error ?? json.message ?? `HTTP ${res.status}`, res.status)
  return json as T
}

export interface ConnectorField { name: string; label: string; secret: boolean; required: boolean; kind: string; placeholder: string; configured: boolean; value?: string }
export interface ConnectorView {
  id: string; label: string; category: string; desc: string; help: string; selfHosted: boolean; hasTest: boolean
  fields: ConnectorField[]; ready: boolean; missing: string[]; enabled: boolean; write: boolean
  tools: { name: string; desc: string; risk: 'read' | 'write' | 'danger' }[]
  google?: { account: string; needsRead: boolean; needsWrite: boolean }
  consent?: { authUrl: string }
}

export interface McpTool { name: string; description: string; params: Record<string, string>; mode: 'off' | 'confirm' | 'auto'; changed: boolean; hints: { readOnly: boolean; destructive: boolean; openWorld: boolean }; listed: boolean }
export interface McpServer {
  id: string; label: string; transport: 'stdio' | 'http'; command: string; args: string[]; url: string
  env: { key: string; secret: boolean; value?: string; configured: boolean }[]
  headers: { name: string; prefix: string; configured: boolean }[]
  enabled: boolean; status: 'stopped' | 'starting' | 'ready' | 'error'; error: string | null; pid: number | null
  server: { name: string; version: string; protocol: string } | null; logLines: number; tools: McpTool[]
}
export interface McpPreset { id: string; label: string; transport: 'stdio' | 'http'; command?: string; args?: string[]; url?: string; headers?: { name: string; prefix?: string }[]; note: string }
export interface McpInput {
  id?: string; label: string; transport: 'stdio' | 'http'; command?: string; args?: string[]; url?: string
  env?: { key: string; value?: string; secret: boolean }[]; headers?: { name: string; prefix?: string; value?: string }[]
}
export interface GoogleStatus { configured: boolean; clientId: string; connected: boolean; email: string; scopes: string[]; pending: boolean; lastError: string | null }

export const api = {
  apisOnly: (on: boolean) => call<{ apisOnly: boolean }>('POST', 'ai/apisonly', { on }),
  mcp: () => call<{ servers: McpServer[]; presets: McpPreset[] }>('GET', 'mcp'),
  mcpSave: (server: McpInput, confirm: boolean) => call<McpServer>('POST', 'mcp/save', { server, confirm }),
  mcpEnable: (id: string, on: boolean, confirm: boolean) => call<McpServer>('POST', 'mcp/enable', { id, on, confirm }),
  mcpRefresh: (id: string) => call<McpServer>('POST', 'mcp/refresh', { id }),
  mcpTool: (id: string, tool: string, mode: McpTool['mode']) => call<McpServer>('POST', 'mcp/tool', { id, tool, mode }),
  mcpTrust: (id: string) => call<McpServer>('POST', 'mcp/trust', { id }),
  mcpRemove: (id: string) => call<{ ok: boolean }>('POST', 'mcp/remove', { id }),
  mcpLog: (id: string) => call<{ lines: string[] }>('GET', `mcp/log?id=${encodeURIComponent(id)}`),
  googleStatus: () => call<GoogleStatus>('GET', 'google/status'),
  googleClient: (clientId: string, clientSecret: string) => call<GoogleStatus>('POST', 'google/client', { clientId, clientSecret }),
  googleSignin: () => call<{ authUrl: string }>('POST', 'google/signin'),
  googleCancel: () => call<GoogleStatus>('POST', 'google/cancel'),
  googleSignout: () => call<GoogleStatus>('POST', 'google/signout'),
  googleForget: () => call<GoogleStatus>('POST', 'google/forget'),
  connectors: () => call<ConnectorView[]>('GET', 'connectors'),
  connectorConfig: (id: string, values: Record<string, string>) => call<ConnectorView>('POST', 'connectors/config', { id, values }),
  connectorEnable: (id: string, on: boolean) => call<ConnectorView>('POST', 'connectors/enable', { id, on }),
  connectorWrite: (id: string, on: boolean) => call<ConnectorView>('POST', 'connectors/write', { id, on }),
  connectorClear: (id: string) => call<ConnectorView>('POST', 'connectors/clear', { id }),
  connectorTest: (id: string) => call<{ ok: boolean; message: string }>('POST', 'connectors/test', { id }),
  overview: () => call<Overview>('GET', 'overview'),
  audit: () => call<AuditEntry[]>('GET', 'audit'),
  check: (providerId: string) => call<unknown>('POST', 'ai/check', { providerId }),
  chat: (messages: ChatTurn[], sensitive: boolean, confirm: boolean) => call<ChatReply>('POST', 'ai/chat', { messages, sensitive, confirm }),
  checkService: (id: string) => call<unknown>('POST', 'services/check', { id }),
  createTask: (title: string, priority: Priority = 'normal') => call<Task>('POST', 'tasks', { title, priority }),
  updateTask: (id: string, patch: Partial<Pick<Task, 'state' | 'priority'>>) => call<Task>('POST', 'tasks/update', { id, ...patch }),
  deleteTask: (id: string) => call<unknown>('POST', 'tasks/delete', { id, confirm: true }),
  timer: (action: 'start' | 'pause' | 'resume' | 'cancel', seconds?: number, label?: string) => call<TimerView>('POST', `timer/${action}`, action === 'start' ? { seconds, label } : {}),
  agentRun: (text: string, history: ChatTurn[], sensitive: boolean, confirm: boolean) => call<{ jobId: string }>('POST', 'agent/run', { text, history, sensitive, confirm }),
  agentJob: (id: string) => call<AgentJob>('GET', `agent/job?id=${encodeURIComponent(id)}`),
  agentAutonomy: (autoDev: boolean) => call<{ autoDev: boolean }>('POST', 'agent/autonomy', { autoDev }),
  missionStart: (goal: string, sensitive: boolean, confirm: boolean) => call<{ id: string }>('POST', 'mission/start', { goal, sensitive, confirm }),
  missionView: (id: string) => call<MissionView>('GET', `mission/view?id=${encodeURIComponent(id)}`),
  missionList: () => call<MissionRow[]>('GET', 'mission/list'),
  missionCancel: (id: string) => call<{ ok: boolean }>('POST', 'mission/cancel', { id }),
  missionConfirm: (id: string, approve: boolean) => call<{ confirmed: number }>('POST', 'mission/confirm', { id, approve }),
  missionAnswer: (id: string, text: string) => call<{ ok: boolean }>('POST', 'mission/answer', { id, text }),
  missionResume: (id: string) => call<{ ok: boolean }>('POST', 'mission/resume', { id }),
  uiList: () => call<PanelRow[]>('GET', 'ui/list'),
  uiPanel: (id: string, since: { specRev: number; stateRev: number; data: Record<string, number> }, force = false) => call<PanelView>('GET', `ui/panel?id=${encodeURIComponent(id)}&specRev=${since.specRev}&stateRev=${since.stateRev}&d=${encodeURIComponent(Object.entries(since.data).map(([k, v]) => `${k}:${v}`).join(','))}${force ? '&force=1' : ''}`),
  uiAction: (id: string, action: string, body: { state?: object; row?: object; form?: object; confirmed?: boolean }) => call<PanelActionResult>('POST', 'ui/action', { id, action, ...body }),
  uiClose: (id: string) => call<{ ok: boolean }>('POST', 'ui/close', { id }),
  uiPin: (id: string, name?: string) => call<{ ok: boolean }>('POST', 'ui/pin', { id, name }),
  uiUnpin: (id: string) => call<{ ok: boolean }>('POST', 'ui/unpin', { id }),
  uiState: (id: string, state: object) => call<{ ok: boolean }>('POST', 'ui/state', { id, state }),
  uiGenerate: (prompt: string, sensitive: boolean, confirm: boolean) => call<{ ok: boolean; id?: string; via?: string; errors?: { path: string; msg: string }[] }>('POST', 'ui/generate', { prompt, sensitive, confirm }),
  uiTemplate: (name: string) => call<{ ok: boolean; id?: string; message?: string }>('POST', 'ui/template', { name }),
  memory: () => call<MemoryItem[]>('GET', 'memory'),
  memoryForget: (id: string) => call<{ ok: boolean }>('POST', 'memory/forget', { id }),
  agentCancel: (id: string) => call<{ ok: boolean }>('POST', 'agent/cancel', { id }),
  agentConfirm: (id: string, approve: boolean) => call<{ ok: boolean }>('POST', 'agent/confirm', { id, approve }),
  agentAccess: () => call<AgentAccess>('GET', 'agent/access'),
  agentAccessSet: (body: { tool?: string; on?: boolean; addRoot?: string; label?: string; removeRoot?: string }) => call<AgentAccess>('POST', 'agent/access', body),
  alerts: () => call<AgentAlert[]>('GET', 'agent/alerts'),
  uiActions: (since: number) => call<{ seq: number; actions: UiAction[] }>('GET', `agent/ui-actions?since=${since}`),
  uiReport: (s: { view: string; theme: string; speak: boolean; spend: boolean; sensitive: boolean }) => call<{ ok: boolean }>('POST', 'agent/ui-report', s),
  monitor: () => call<MonitorView>('GET', 'monitor/summary'),
  agentTool: (tool: string, args: object = {}, confirmed = false) => call<ToolRun>('POST', 'agent/tool', { tool, args, confirmed }),
  routerInfo: () => call<{ endpoint: string; token: string; spend: boolean }>('POST', 'router/info'),
  routerSpend: (on: boolean) => call<{ spend: boolean }>('POST', 'router/spend', { on }),
  keys: () => call<KeyStatus[]>('GET', 'keys'),
  setKey: (name: string, value: string) => call<KeyStatus[]>('POST', 'keys', { name, value }),
  clearKey: (name: string) => call<KeyStatus[]>('POST', 'keys/clear', { name }),
  addKeyProvider: (base: string) => call<ProviderView[]>('POST', 'providers/addkey', { base }),
  removeKeyProvider: (id: string) => call<ProviderView[]>('POST', 'providers/removekey', { id }),
  providerUpdate:(id: string, patch: { enabled?: boolean; model?: string; priority?: number; free?: boolean; allowedModels?: string[]; baseUrl?: string }) => call<ProviderView[]>('POST', 'providers/update', { id, ...patch }),
  voice: () => call<VoiceStatus>('GET', 'voice'),
  voiceSet: (apiKey?: string, voiceId?: string) => call<VoiceStatus>('POST', 'voice', { apiKey, voiceId }),
  voiceTest: () => call<VoiceTest>('POST', 'voice/test'),
  voiceClear: () => call<VoiceStatus>('POST', 'voice/clear'),
}

/** Speak text with the bridge's ElevenLabs endpoint; resolves false when it is not available. */
export async function speakViaBridge(text: string): Promise<boolean> {
  try {
    const r = await fetch(`${BASE}/tts`, { method: 'POST', headers: { 'content-type': 'application/json', ...(window.jarvis?.token ? { 'x-jarvis-token': window.jarvis.token } : {}) }, body: JSON.stringify({ text }) })
    if (!r.ok) return false
    const audio = new Audio(URL.createObjectURL(await r.blob()))
    const stop = await trackAudio(audio) // the neural network and the whole interface follow this voice
    // Resolves when the voice has FINISHED, so the caption can disappear exactly then.
    return await new Promise<boolean>((resolve) => {
      audio.onended = () => (stop(), resolve(true))
      audio.onerror = () => (stop(), resolve(false))
      audio.play().catch(() => (stop(), resolve(false)))
    })
  } catch {
    return false
  }
}
