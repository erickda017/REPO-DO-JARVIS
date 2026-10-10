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
  // `apiKeyEnv` must be the NAME of an environment variable. A real key pasted there would be shown in the UI
  // and copied into builds, so it is dropped (never echoed) and the provider carries a warning instead.
  for (const p of raw.providers ?? []) {
    if (typeof p.apiKeyEnv === 'string' && !/^[A-Z][A-Z0-9_]{1,60}$/.test(p.apiKeyEnv)) {
      delete p.apiKeyEnv
      p.configWarning = 'apiKeyEnv parecia conter a própria chave. Ele foi ignorado: o campo deve ter o NOME da variável (ex.: TYPESAFE_API_KEY). Cole a chave no campo da tela IAs e, por segurança, troque-a no serviço, pois ela esteve escrita neste arquivo.'
    }
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
