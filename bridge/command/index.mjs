import { join } from 'node:path'
import { createAudit } from './audit.mjs'
import { loadConfig } from './config.mjs'
import { createHealth } from './health.mjs'
import { createProjectMonitor } from './projects.mjs'
import { createRegistry } from './providers/registry.mjs'
import { createRouter } from './router.mjs'
import { createServiceMonitor } from './services.mjs'
import { createTaskStore } from './tasks.mjs'
import { createTimer } from './timer.mjs'
import { createApi } from './api.mjs'
import { createVoice } from './voice.mjs'
import { createSettings } from './settings.mjs'
import { createOpenAiApi } from './openaiApi.mjs'
import { createAccess } from '../agent/access.mjs'
import { createMonitor } from '../agent/monitor.mjs'
import { createProfiles } from '../agent/profiles.mjs'
import { buildTools } from '../agent/tools.mjs'
import { createAgent } from '../agent/agent.mjs'

/**
 * Wires the command centre together. Every dependency that touches the world
 * (fetch, clock, files, env) can be injected, which is how the tests run it
 * without a network or a disk.
 */
export function createCommand({ config = loadConfig(), fetch: fetchImpl = fetch, env = process.env, clock = Date.now, allowNoOrigin = false, persist = true, envKey = () => null } = {}) {
  const audit = createAudit({ file: persist ? join(config.dataDir, 'audit.jsonl') : null, clock })
  let registry
  const settings = createSettings({ file: persist ? join(config.dataDir, 'settings.json') : null, getRegistry: () => registry, baseEnv: env, audit })
  registry = createRegistry(config.providers, { fetch: fetchImpl, env: settings.env() })
  const health = createHealth({ registry, audit, clock })
  const router = createRouter({ registry, health, audit, clock })
  const services = createServiceMonitor({ services: config.services, fetch: fetchImpl, clock, audit })
  const projects = createProjectMonitor({ projects: config.projects, services })
  const tasks = createTaskStore({ file: persist ? join(config.dataDir, 'tasks.json') : null, clock, audit })
  const timer = createTimer({ file: persist ? join(config.dataDir, 'timer.json') : null, clock, audit })
  const voice = createVoice({ file: persist ? join(config.dataDir, 'voice.json') : null, env, envKey, fetch: fetchImpl, audit })
  // Desktop agent: permissions, real-metrics monitor, profiles, tools and the loop that drives them through the router.
  const access = createAccess({ file: persist ? join(config.dataDir, 'agent-access.json') : null, env, deny: persist ? [config.dataDir] : [] })
  const monitor = createMonitor({ clock })
  const profiles = createProfiles({ file: persist ? join(config.dataDir, 'profile-state.json') : null, monitor, clock })
  const tools = buildTools({ access, monitor, profiles, env })
  const agent = createAgent({ router, tools, access, audit, clock })
  const alerts = []
  /** Low-space warnings: one per drive per 12 h, only when a drive is under 10 % or 15 GB free. */
  const checkDisks = async () => {
    for (const d of await monitor.disks().catch(() => [])) {
      if (!(d.freePct < 10 || d.freeGB < 15)) continue
      const id = 'disk-' + d.drive
      if (alerts.some((a) => a.id === id && clock() - a.at < 12 * 3600_000)) continue
      alerts.push({ id, level: d.freePct < 5 ? 'critical' : 'warning', at: clock(), text: `O disco ${d.drive} está com ${d.freeGB} GB livres (${d.freePct}%). Quer que eu analise o que ocupa espaço e sugira o que apagar?` })
    }
    if (alerts.length > 20) alerts.splice(0, alerts.length - 20)
  }
  if (persist) {
    monitor.start()
    setTimeout(checkDisks, 20_000).unref?.()
    setInterval(checkDisks, 5 * 60_000).unref?.()
  }
  const openai = createOpenAiApi({ router, registry, file: persist ? join(config.dataDir, 'router-token.txt') : null, flags: settings.flags, audit })
  const parts = { openai, config, registry, health, router, services, projects, tasks, timer, audit, voice, settings, access, monitor, profiles, agent, alerts }
  const api = createApi({ ...parts, allowNoOrigin })
  if (config.autoStartMonitors) services.start()
  return { ...parts, api }
}
