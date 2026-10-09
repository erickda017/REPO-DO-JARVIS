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

/**
 * Wires the command centre together. Every dependency that touches the world
 * (fetch, clock, files, env) can be injected, which is how the tests run it
 * without a network or a disk.
 */
export function createCommand({ config = loadConfig(), fetch: fetchImpl = fetch, env = process.env, clock = Date.now, allowNoOrigin = false, persist = true, envKey = () => null } = {}) {
  const audit = createAudit({ file: persist ? join(config.dataDir, 'audit.jsonl') : null, clock })
  const registry = createRegistry(config.providers, { fetch: fetchImpl, env })
  const health = createHealth({ registry, audit, clock })
  const router = createRouter({ registry, health, audit, clock })
  const services = createServiceMonitor({ services: config.services, fetch: fetchImpl, clock, audit })
  const projects = createProjectMonitor({ projects: config.projects, services })
  const tasks = createTaskStore({ file: persist ? join(config.dataDir, 'tasks.json') : null, clock, audit })
  const timer = createTimer({ file: persist ? join(config.dataDir, 'timer.json') : null, clock, audit })
  const voice = createVoice({ file: persist ? join(config.dataDir, 'voice.json') : null, env, envKey, fetch: fetchImpl, audit })
  const parts = { config, registry, health, router, services, projects, tasks, timer, audit, voice }
  const api = createApi({ ...parts, allowNoOrigin })
  if (config.autoStartMonitors) services.start()
  return { ...parts, api }
}
