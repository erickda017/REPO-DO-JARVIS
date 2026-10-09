import { probePort } from './services.mjs'

/**
 * Local project monitor. A project is whatever the config says it is; status
 * comes from checks that really happen:
 *
 *   - `port`      — something is listening on 127.0.0.1:<port>
 *   - `serviceId` — the linked entry in the service monitor (HTTP health)
 *
 * There is no process control and no deploy integration here: the bridge does
 * not start, stop or publish anything. A project with neither check reports
 * `unknown` and says why.
 */
export function createProjectMonitor({ projects = [], services }) {
  async function statusOf(p) {
    const checks = []
    if (p.port) checks.push({ type: 'port', ok: await probePort(p.port), detail: `127.0.0.1:${p.port}` })
    if (p.serviceId && services.has(p.serviceId)) {
      const svc = services.list().find((s) => s.id === p.serviceId)
      checks.push({
        type: 'http',
        ok: svc?.status === 'up',
        detail: svc ? `${svc.status}${svc.lastError ? ` — ${svc.lastError}` : ''}` : 'not yet checked',
        unknown: svc?.status === 'unknown',
      })
    }
    const state =
      checks.length === 0 ? 'unknown'
      : checks.every((c) => c.unknown) ? 'unknown'
      : checks.every((c) => c.ok) ? 'running'
      : checks.some((c) => c.ok) ? 'degraded'
      : 'stopped'
    return {
      id: p.id,
      name: p.name ?? p.id,
      note: p.note ?? null,
      state,
      checks,
      detail: checks.length === 0 ? 'no port or serviceId configured' : null,
    }
  }
  return {
    list: () => Promise.all(projects.map(statusOf)),
  }
}
