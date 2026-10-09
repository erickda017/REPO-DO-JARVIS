import { ProviderError } from './errors.mjs'

/**
 * Four separate questions, never collapsed into one green light:
 *
 *   endpoint  — did anything answer over HTTP at all?
 *   auth      — did the provider accept our credentials?
 *   model     — is the configured model in the provider's catalogue?
 *   inference — did a real completion succeed?  (opt-in: it costs tokens)
 *
 * Each is `ok | fail | unknown | skipped`. `unknown` means "cannot be told from
 * here", not "fine". Inference is only attempted when the caller asks for it
 * *and* confirms spend; otherwise it stays `skipped`.
 */
export function createHealth({ registry, audit, clock = Date.now }) {
  const last = new Map() // id -> latest result
  const errors = new Map() // id -> recent errors (newest first)

  const pushError = (id, err) => {
    const list = errors.get(id) ?? []
    list.unshift({ at: new Date(clock()).toISOString(), ...(err instanceof ProviderError ? err.toJSON() : { kind: 'unknown', message: String(err?.message ?? err) }) })
    errors.set(id, list.slice(0, 10))
  }

  async function check(id, { inference = false, confirm = false, prompt = 'Reply with the single word: ok' } = {}) {
    const p = registry.get(id)
    if (!p) throw new ProviderError('unconfigured', `no such provider "${id}"`)

    const result = {
      providerId: id,
      checkedAt: new Date(clock()).toISOString(),
      endpoint: { state: 'unknown' },
      auth: { state: 'unknown' },
      model: { state: 'unknown' },
      inference: { state: 'skipped', detail: 'not requested' },
      models: null,
    }

    if (!p.enabled) {
      for (const k of ['endpoint', 'auth', 'model']) result[k] = { state: 'skipped', detail: 'provider disabled' }
      result.inference = { state: 'skipped', detail: 'provider disabled' }
      last.set(id, result)
      return result
    }

    try {
      const probe = await p.adapter.probe()
      result.endpoint = probe.endpoint
      result.auth = probe.auth
      result.models = probe.models
      const want = p.defaultModel
      if (!want) result.model = { state: 'unknown', detail: 'no model configured' }
      else if (probe.models == null) result.model = { state: 'unknown', detail: 'catalogue unavailable' }
      else result.model = probe.models.includes(want) ? { state: 'ok', detail: want } : { state: 'fail', detail: `${want} not in catalogue` }
    } catch (err) {
      pushError(id, err)
      const e = err instanceof ProviderError ? err : new ProviderError('network', String(err?.message ?? err))
      result.endpoint = { state: e.kind === 'network' || e.kind === 'timeout' ? 'fail' : 'ok', detail: e.message }
      if (e.kind === 'auth') result.auth = { state: 'fail', detail: e.message }
      else if (result.endpoint.state === 'fail') result.auth = { state: 'unknown', detail: 'endpoint unreachable' }
      else result.auth = { state: 'unknown', detail: e.message }
    }

    if (inference) {
      if (!confirm) {
        result.inference = { state: 'skipped', detail: 'needs explicit confirm: this spends tokens' }
      } else if (!p.defaultModel) {
        result.inference = { state: 'skipped', detail: 'no model configured' }
      } else {
        try {
          const out = await p.adapter.infer({ model: p.defaultModel, prompt, maxTokens: 16 })
          result.inference = { state: 'ok', latencyMs: out.latencyMs }
          audit?.record('ai.check.inference', { provider: id, model: p.defaultModel, ok: true })
        } catch (err) {
          pushError(id, err)
          result.inference = { state: 'fail', detail: err?.message ?? String(err) }
          audit?.record('ai.check.inference', { provider: id, model: p.defaultModel, ok: false, kind: err?.kind })
        }
      }
    }

    last.set(id, result)
    return result
  }

  return {
    check,
    last: (id) => last.get(id) ?? null,
    recentErrors: (id) => errors.get(id) ?? [],
    pushError,
    snapshot: () =>
      registry.list().map((p) => ({
        id: p.id,
        label: p.label,
        type: p.type,
        enabled: p.enabled,
        external: p.external,
        paid: p.paid,
        model: p.defaultModel,
        capabilities: p.capabilities,
        status: last.get(p.id) ?? null,
        recentErrors: errors.get(p.id) ?? [],
      })),
  }
}
