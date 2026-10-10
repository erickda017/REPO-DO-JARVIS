import { ProviderError, RouteError } from './errors.mjs'

const BODY_LIMIT = 64 * 1024

class HttpError extends Error {
  constructor(status, message) {
    super(message)
    this.status = status
  }
}

async function readJson(req) {
  if (!/^application\/json\b/i.test(req.headers['content-type'] ?? '')) {
    throw new HttpError(415, 'content-type must be application/json')
  }
  let size = 0
  const chunks = []
  for await (const chunk of req) {
    size += chunk.length
    if (size > BODY_LIMIT) throw new HttpError(413, 'body too large')
    chunks.push(chunk)
  }
  if (size === 0) return {}
  try {
    const body = JSON.parse(Buffer.concat(chunks).toString('utf8'))
    if (body === null || typeof body !== 'object' || Array.isArray(body)) throw new Error('not an object')
    return body
  } catch {
    throw new HttpError(400, 'body must be a JSON object')
  }
}

/**
 * HTTP surface for the command centre, mounted by the bridge under
 * /api/command/. The bridge has already rejected unknown browser origins before
 * this runs; on top of that, state-changing requests need a JSON content type
 * (forcing a CORS preflight from any page) and — if they carry no Origin at all
 * — JARVIS_ALLOW_NO_ORIGIN, the same rule the WebSocket follows.
 *
 * Only GET and POST are used so the bridge's CORS headers need no changes.
 * Nothing here returns a key: the config exposes env-var *names* and provider
 * status never includes request headers.
 */
import { personaText } from '../agent/perfil.mjs'
const PERSONA = personaText() + '\n\n' +
  'Responda em português do Brasil, de forma direta e curta ' +
  '(no máximo duas ou três frases, a menos que peçam mais). Não invente fatos nem ações que não executou.'

export function createApi({ openai, health, router, services, projects, tasks, timer, audit, voice, settings, access, monitor, profiles, agent, alerts, missions, memory, genui, connectors, google, allowNoOrigin }) {
  const PREFIX = '/api/command/'

  const routes = {
    'GET overview': async () => ({
      providers: health.snapshot(),
      services: services.list(),
      projects: await projects.list(),
      tasks: await tasks.list(),
      timer: await timer.get(),
    }),
    'GET ai/providers': async () => health.snapshot(),
    'GET ai/stats': async () => router.stats(),
    'POST ai/check': async (b) => {
      if (typeof b.providerId !== 'string') throw new HttpError(400, 'providerId is required')
      return health.check(b.providerId, { inference: b.inference === true, confirm: b.confirm === true })
    },
    'POST ai/infer': async (b) =>
      router.run({
        prompt: b.prompt,
        system: typeof b.system === 'string' ? b.system : undefined,
        capability: typeof b.capability === 'string' ? b.capability : 'chat',
        providerId: typeof b.providerId === 'string' ? b.providerId : undefined,
        model: typeof b.model === 'string' ? b.model : undefined,
        sensitive: b.sensitive === true,
        confirmSpend: b.confirm === true,
        maxTokens: Number.isInteger(b.maxTokens) ? Math.min(b.maxTokens, 4096) : undefined,
      }),
    'POST ai/decide': async (b) =>
      router.decide({
        state: b.state,
        questions: b.questions,
        providerId: typeof b.providerId === 'string' ? b.providerId : undefined,
        model: typeof b.model === 'string' ? b.model : undefined,
        sensitive: b.sensitive === true,
        confirmSpend: b.confirm === true,
      }),
    'POST ai/ask': async (b) =>
      router.smartRun({
        prompt: b.prompt,
        system: typeof b.system === 'string' ? b.system : undefined,
        sensitive: b.sensitive === true,
        confirmSpend: b.confirm === true,
        maxTokens: Number.isInteger(b.maxTokens) ? Math.min(b.maxTokens, 4096) : undefined,
      }),
    // Chat with history, no Claude involved: whichever eligible provider the router picks.
    'POST ai/chat': async (b) =>
      router.smartRun({
        messages: b.messages,
        system: PERSONA,
        sensitive: b.sensitive === true,
        confirmSpend: b.confirm === true,
        maxTokens: Number.isInteger(b.maxTokens) ? Math.min(b.maxTokens, 2048) : 512,
      }),
    // Provider API keys and per-provider switches, managed from the app. Keys are never returned.
    // The token of the OpenAI-compatible door; POST so that only an allowed browser origin (the app) can read it.
    'POST router/info': async () => ({ endpoint: 'http://127.0.0.1:8787/v1', token: await openai.token(), spend: settings.flags.get('routerSpend') === true }),
    'POST router/spend': async (b) => {
      await settings.setFlag('routerSpend', b.on === true)
      return { spend: settings.flags.get('routerSpend') === true }
    },
    'GET keys': async () => settings.keys(),
    'POST keys': async (b) => settings.setKey(String(b.name ?? ''), b.value),
    'POST keys/clear': async (b) => settings.clearKey(String(b.name ?? '')),
    'POST providers/update': async (b) => {
      await settings.setProvider(String(b.id ?? ''), { enabled: b.enabled, model: b.model, priority: b.priority, free: b.free, allowedModels: b.allowedModels })
      return health.snapshot()
    },
    // Connectors (external services the agent may use): credentials, on/off, permission to change things, a read-only test
    'GET connectors': async () => connectors.list(),
    'POST connectors/config': async (b) => connectors.configure(String(b.id ?? ''), b.values && typeof b.values === 'object' ? b.values : {}),
    'POST connectors/enable': async (b) => connectors.setEnabled(String(b.id ?? ''), b.on === true),
    'POST connectors/write': async (b) => connectors.setWrite(String(b.id ?? ''), b.on === true),
    'POST connectors/clear': async (b) => connectors.clear(String(b.id ?? '')),
    'POST connectors/test': async (b) => connectors.test(String(b.id ?? '')),
    // Google account (OAuth in the system browser): the client id/secret are the owner's own; tokens never leave the bridge
    'GET google/status': async () => google.status(),
    'POST google/client': async (b) => google.setClient(b.clientId, b.clientSecret),
    'POST google/signin': async () => ({ authUrl: (await google.begin([])).authUrl }),
    'POST google/cancel': async () => (google.cancel(), google.status()),
    'POST google/signout': async () => google.signOut(),
    'POST google/forget': async () => google.forgetClient(),
    'POST providers/addkey': async (b) => {
      await settings.addKey(String(b.base ?? ''))
      return health.snapshot()
    },
    'POST providers/removekey': async (b) => {
      await settings.removeKey(String(b.id ?? ''))
      return health.snapshot()
    },
    // Desktop agent
    'POST agent/run': async (b) => ({ jobId: agent.run({ text: b.text, history: Array.isArray(b.history) ? b.history : [], sensitive: b.sensitive === true, confirmSpend: b.confirm === true }) }),
    'GET agent/job': async (q) => agent.view(String(q.id ?? '')) ?? Promise.reject(new HttpError(404, 'unknown job')),
    'POST agent/confirm': async (b) => ({ ok: agent.confirm(String(b.id ?? ''), b.approve === true) }),
    'GET agent/access': async () => ({ ...access.snapshot(), autoDev: settings.flags.get('autoDev') === true }),
    // Autonomy: let tests/servers of granted projects run without a confirmation each time.
    'POST agent/autonomy': async (b) => {
      await settings.setFlag('autoDev', b.autoDev === true)
      audit.record('agent.autonomy', { autoDev: b.autoDev === true })
      return { autoDev: settings.flags.get('autoDev') === true }
    },
    'POST agent/access': async (b) => {
      if (typeof b.tool === 'string') await access.setTool(b.tool, b.on === true)
      if (typeof b.addRoot === 'string') await access.addRoot(b.addRoot, typeof b.label === 'string' ? b.label : undefined)
      if (typeof b.removeRoot === 'string') await access.removeRoot(b.removeRoot)
      audit.record('agent.access', { tool: b.tool, on: b.on, addRoot: Boolean(b.addRoot), removeRoot: Boolean(b.removeRoot) })
      return access.snapshot()
    },
    // Run one tool directly (used by the app's own screens). Anything dangerous needs confirmed:true, i.e. the owner already clicked OK.
    'POST agent/tool': async (b) => {
      const name = String(b.tool ?? '')
      const t = Object.hasOwn(agent.tools, name) ? agent.tools[name] : undefined
      if (!t) throw new HttpError(404, 'unknown tool')
      if (!access.allows(t.group)) throw new HttpError(403, 'o grupo "' + t.group + '" está desligado na tela Agente')
      const args = b.args && typeof b.args === 'object' ? b.args : {}
      // Same rule as the agent loop: dangerous tools, and any tool whose own check asks for a confirmation for these args.
      const needs = t.risk === 'danger' || (t.confirm ? (await t.confirm(args)) !== null : false)
      if (needs && b.confirmed !== true) throw new HttpError(409, 'esta ação precisa de confirmação')
      try {
        const r = await t.run(args)
        audit.record('agent.tool', { tool: t.name, ok: true, verified: r.verified })
        return { ok: true, ...r }
      } catch (e) {
        audit.record('agent.tool', { tool: t.name, ok: false })
        return { ok: false, error: String(e?.message ?? e).slice(0, 300) }
      }
    },
    // Missions: a goal in, a planned/verified result out (see agent/orquestrador.mjs)
    'POST mission/start': async (b) => missions.start({ goal: b.goal, sensitive: b.sensitive === true, confirmSpend: b.confirm === true, limits: b.limits && typeof b.limits === 'object' ? b.limits : {} }),
    'GET mission/view': async (q) => (await missions.view(String(q.id ?? ''))) ?? Promise.reject(new HttpError(404, 'unknown mission')),
    'GET mission/list': async () => missions.list(),
    'GET mission/roles': async () => Object.entries(missions.ROLES).map(([id, r]) => ({ id, label: r.label, tier: r.tier ?? null, readOnly: r.readOnly, tools: r.tools })),
    'POST mission/cancel': async (b) => ({ ok: await missions.cancel(String(b.id ?? '')) }),
    'POST mission/confirm': async (b) => ({ confirmed: missions.confirm(String(b.id ?? ''), b.approve === true) }),
    'POST mission/answer': async (b) => ({ ok: await missions.answer(String(b.id ?? ''), String(b.text ?? '')) }),
    'POST mission/resume': async (b) => ({ ok: await missions.resume(String(b.id ?? '')) }),
    'GET memory': async () => memory.list({ limit: 50 }),
    'POST memory/forget': async (b) => ({ ok: await memory.forget(String(b.id ?? '')) }),
    // Generative panels (see command/genui.mjs): declarative specs, live data, actions through the normal tools and confirmations
    'GET ui/catalog': async () => ({ catalog: genui.CATALOG }),
    'GET ui/list': async () => genui.list(),
    'GET ui/panel': async (q) => {
      const data = {}
      for (const part of String(q.d ?? '').split(',').filter(Boolean)) { const [n, r] = part.split(':'); if (n) data[n] = Number(r) || 0 }
      return (await genui.view(String(q.id ?? ''), { specRev: Number(q.specRev) || 0, stateRev: Number(q.stateRev) || 0, data }, { force: q.force === '1' })) ?? Promise.reject(new HttpError(404, 'unknown panel'))
    },
    'POST ui/create': async (b) => genui.create(b.spec, { owner: { kind: 'user' } }),
    'POST ui/template': async (b) => genui.template(String(b.name ?? '')),
    'POST ui/quick': async (b) => genui.quick(b, { owner: { kind: 'user' } }),
    'POST ui/generate': async (b) => genui.generate({ prompt: String(b.prompt ?? ''), data: b.data, hint: typeof b.hint === 'string' ? b.hint : undefined, title: typeof b.title === 'string' ? b.title : undefined, sensitive: b.sensitive === true, confirmSpend: b.confirm === true, owner: { kind: 'user' } }),
    'POST ui/update': async (b) => genui.update(String(b.id ?? ''), b.ops),
    'POST ui/action': async (b) => genui.action(String(b.id ?? ''), String(b.action ?? ''), { state: b.state, row: b.row, form: b.form, confirmed: b.confirmed === true }),
    'POST ui/close': async (b) => ({ ok: await genui.close(String(b.id ?? '')) }),
    'POST ui/pin': async (b) => ({ ok: await genui.pin(String(b.id ?? ''), typeof b.name === 'string' ? b.name : undefined) }),
    'POST ui/unpin': async (b) => ({ ok: await genui.unpin(String(b.id ?? '')) }),
    'POST ui/state': async (b) => ({ ok: await genui.saveState(String(b.id ?? ''), b.state) }),    'GET agent/alerts': async () => alerts.slice(-10),
    'GET agent/profile': async () => profiles.status(),
    'GET monitor/summary': async () => ({ summary: monitor.summary(), report: monitor.report(30), history: monitor.history().slice(-60), disks: await monitor.disks().catch(() => []) }),
    'POST monitor/report': async (b) => monitor.report(Math.min(Math.max(Number(b.minutes) || 30, 1), 60)),
    'GET voice': async () => voice.status(),
    'POST voice': async (b) => voice.set({ apiKey: b.apiKey, voiceId: b.voiceId }),
    'POST voice/test': async () => voice.test(),
    'POST voice/clear': async () => voice.clear(),
    'GET services': async () => services.list(),
    'POST services/check': async (b) => {
      if (typeof b.id !== 'string' || !services.has(b.id)) throw new HttpError(404, 'unknown service')
      return services.checkOne(b.id)
    },
    'GET projects': async () => projects.list(),
    'GET tasks': async () => tasks.list({ includeClosed: true }),
    'POST tasks': async (b) => tasks.create(b),
    'POST tasks/update': async (b) => tasks.update(b.id, b),
    'POST tasks/delete': async (b) => {
      if (b.confirm !== true) throw new HttpError(409, 'deleting a task needs confirm: true')
      await tasks.remove(b.id)
      return { deleted: b.id }
    },
    'GET timer': async () => timer.get(),
    'POST timer/start': async (b) => timer.start(b),
    'POST timer/pause': async () => timer.pause(),
    'POST timer/resume': async () => timer.resume(),
    'POST timer/cancel': async () => timer.cancel(),
    'GET audit': async () => audit.recent(100),
  }

  /** @returns {Promise<boolean>} true when the request belonged to this API */
  async function handle(req, res, cors) {
    const url = new URL(req.url ?? '/', 'http://x')
    if (!url.pathname.startsWith(PREFIX)) return false
    const send = (status, body) => {
      res.writeHead(status, { ...cors, 'content-type': 'application/json', 'cache-control': 'no-store' })
      res.end(JSON.stringify(body))
    }
    try {
      const mutating = req.method === 'POST'
      if (req.method !== 'GET' && !mutating) throw new HttpError(405, 'method not allowed')
      if (mutating && !req.headers.origin && !allowNoOrigin) {
        throw new HttpError(403, 'requests without an Origin header are refused (JARVIS_ALLOW_NO_ORIGIN=1 to permit)')
      }
      const handler = routes[`${req.method} ${url.pathname.slice(PREFIX.length).replace(/\/+$/, '')}`]
      if (!handler) throw new HttpError(404, 'unknown command endpoint')
      const body = mutating ? await readJson(req) : Object.fromEntries(url.searchParams)
      send(200, await handler(body))
    } catch (err) {
      if (err instanceof HttpError) return send(err.status, { error: err.message }), true
      if (err instanceof RouteError) return send(err.message.startsWith('blocked') ? 409 : 502, err.toJSON()), true
      if (err instanceof ProviderError) return send(err.kind === 'bad_request' ? 400 : 502, err.toJSON()), true
      // Task and timer validation errors are plain Errors with user-safe text.
      send(400, { error: String(err?.message ?? err).slice(0, 200) })
    }
    return true
  }

  return { handle }
}
