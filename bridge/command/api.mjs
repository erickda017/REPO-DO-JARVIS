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
export function createApi({ health, router, services, projects, tasks, timer, audit, allowNoOrigin }) {
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
      const body = mutating ? await readJson(req) : {}
      send(200, await handler(body))
    } catch (err) {
      if (err instanceof HttpError) return send(err.status, { error: err.message }), true
      if (err instanceof RouteError) return send(err.message.startsWith('blocked') ? 409 : 502, err.toJSON()), true
      if (err instanceof ProviderError) return send(502, err.toJSON()), true
      // Task and timer validation errors are plain Errors with user-safe text.
      send(400, { error: String(err?.message ?? err).slice(0, 200) })
    }
    return true
  }

  return { handle }
}
