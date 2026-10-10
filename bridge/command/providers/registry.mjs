import { ProviderError } from '../errors.mjs'
import { anthropicProvider } from './anthropic.mjs'
import { openaiCompatProvider } from './openaiCompat.mjs'
import { unverifiedProvider } from './unverified.mjs'
import { jevProvider } from './jev.mjs'
import { geminiProvider } from './gemini.mjs'

const FACTORIES = {
  anthropic: anthropicProvider,
  'openai-compat': openaiCompatProvider,
  unverified: unverifiedProvider,
  'typesafe-jev': jevProvider,
  gemini: geminiProvider,
}

const LOOPBACK = new Set(['localhost', '127.0.0.1', '[::1]', '::1'])

function isExternal(cfg) {
  if (typeof cfg.external === 'boolean') return cfg.external
  if (!cfg.baseUrl) return cfg.type !== 'unverified'
  try {
    return !LOOPBACK.has(new URL(cfg.baseUrl).hostname)
  } catch {
    return true
  }
}

/**
 * Turns the `providers` section of the config into live adapters plus the
 * metadata the router needs. Adding or removing a model provider is a config
 * change, or one new file in this folder and one line in FACTORIES — the core
 * never learns vendor names.
 *
 * Metadata defaults are deliberately conservative: a provider is `external`
 * unless it is loopback, and `paid` unless the config says otherwise, so a
 * forgotten flag makes the router ask for confirmation rather than spend or
 * leak silently.
 */
export function createRegistry(providerConfigs = [], deps = {}) {
  const entries = new Map()
  for (const cfg of providerConfigs) {
    const factory = FACTORIES[cfg.type]
    if (!factory) throw new ProviderError('unconfigured', `provider ${cfg.id}: unknown type "${cfg.type}"`)
    if (entries.has(cfg.id)) throw new ProviderError('unconfigured', `duplicate provider id "${cfg.id}"`)
    entries.set(cfg.id, {
      id: cfg.id,
      type: cfg.type,
      label: cfg.label ?? cfg.id,
      enabled: cfg.enabled !== false,
      priority: cfg.priority ?? 100,
      models: cfg.models ?? [],
      defaultModel: cfg.defaultModel ?? cfg.models?.[0] ?? null,
      capabilities: cfg.capabilities ?? ['chat'],
      external: isExternal(cfg),
      allowSensitive: cfg.allowSensitive === true,
      // Anything that leaves this machine is paid until the config says otherwise; loopback servers (the local model) are free.
      // A server on this very machine cannot bill anyone, so it is never "paid", whatever an old config says.
      paid: isExternal(cfg) ? (typeof cfg.paid === 'boolean' ? cfg.paid : true) : false,
      allowFallback: cfg.allowFallback !== false,
      warning: cfg.configWarning ?? null,
      keyEnv: cfg.apiKeyEnv ?? (cfg.type === 'anthropic' ? 'ANTHROPIC_API_KEY' : cfg.type === 'gemini' ? 'GEMINI_API_KEY' : cfg.type === 'typesafe-jev' ? 'TYPESAFE_API_KEY' : null),
      adapter: factory(cfg, deps),
    })
  }
  return {
    list: () => [...entries.values()],
    get: (id) => entries.get(id) ?? null,
    /** Runtime overrides from the owner's settings: on/off, model, priority. */
    update(id, { enabled, model, priority }) {
      const p = entries.get(id)
      if (!p) return
      if (enabled !== undefined) p.enabled = enabled
      if (model !== undefined) p.defaultModel = model
      if (priority !== undefined) p.priority = priority
    },
  }
}
