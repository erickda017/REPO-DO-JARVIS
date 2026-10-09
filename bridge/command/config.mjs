import { readFileSync } from 'node:fs'
import { resolve } from 'node:path'

/**
 * Loads `command.config.json` from the repo root (path override:
 * JARVIS_COMMAND_CONFIG). The file holds *names* of environment variables for
 * API keys, never the keys themselves, so it is safe to read and to show.
 * A missing file is fine: the command centre starts empty.
 */
export function loadConfig({ root = process.cwd(), env = process.env } = {}) {
  const path = resolve(root, env.JARVIS_COMMAND_CONFIG ?? 'command.config.json')
  let raw = {}
  try {
    raw = JSON.parse(readFileSync(path, 'utf8'))
  } catch (err) {
    if (err?.code !== 'ENOENT') throw new Error(`command config ${path} is not valid JSON: ${err.message}`)
  }
  for (const [name, value] of Object.entries(raw)) {
    if (name.startsWith('//')) continue
    if (!['providers', 'services', 'projects', 'autoStartMonitors'].includes(name)) {
      throw new Error(`command config: unknown key "${name}"`)
    }
    if (name !== 'autoStartMonitors' && !Array.isArray(value)) throw new Error(`command config: "${name}" must be an array`)
  }
  return {
    path,
    providers: raw.providers ?? [],
    services: raw.services ?? [],
    projects: raw.projects ?? [],
    autoStartMonitors: raw.autoStartMonitors === true,
    dataDir: resolve(root, env.JARVIS_DATA_DIR ?? 'data'),
  }
}
