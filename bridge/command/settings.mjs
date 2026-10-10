import { chmod, mkdir, readFile, rename, writeFile } from 'node:fs/promises'
import { dirname } from 'node:path'

const NAME_RE = /^[A-Z][A-Z0-9_]{2,60}$/
const VALUE_RE = /^[^\s]{8,400}$/
const MODEL_RE = /^[\w.:/-]{1,120}$/

/**
 * Per-user settings the owner changes from the app instead of editing files or environment
 * variables: provider API keys, and per-provider overrides (on/off, model, priority).
 *
 * Keys are only accepted for names a configured provider declares in `apiKeyEnv`, so this store can
 * never be used to plant arbitrary environment variables (PATH, NODE_OPTIONS...). They live in
 * `data/settings.json` (gitignored), are never returned, and only `configured / source / last4` is
 * ever shown. Precedence for a key: saved here > real environment variable.
 */
export function createSettings({ file, getRegistry, baseEnv = process.env, audit, vault = null } = {}) {
  // The registry is built with this store's env, so it is looked up lazily.
  const registry = { list: () => getRegistry().list(), get: (id) => getRegistry().get(id), update: (id, o) => getRegistry().update(id, o) }
  let data = { secrets: {}, overrides: {}, flags: {} }
  let loaded = !file
  let chain = Promise.resolve()

  const allowed = () => new Set(registry.list().map((p) => p.keyEnv).filter(Boolean))

  const persist = () => {
    if (!file) return Promise.resolve()
    // A failed write (antivirus holding the file, EPERM on rename) must reject THIS call only, never poison later saves.
    const run = chain.then(async () => {
      await mkdir(dirname(file), { recursive: true })
      const tmp = `${file}.tmp`
      // With a vault the keys never touch the disk in the clear.
      const out = vault ? { enc: Object.keys(data.secrets).length ? await vault.seal(JSON.stringify(data.secrets)) : '', overrides: data.overrides, flags: data.flags } : data
      await writeFile(tmp, JSON.stringify(out), { encoding: 'utf8', mode: 0o600 })
      await rename(tmp, file)
      await chmod(file, 0o600).catch(() => {})
    })
    chain = run.catch(() => {})
    return run
  }

  const apply = () => {
    for (const [id, o] of Object.entries(data.overrides)) registry.update(id, o)
  }

  return {
    /** Environment as the provider adapters see it: saved keys win over real env vars. */
    env: () =>
      new Proxy(baseEnv, {
        get: (t, k) => (typeof k === 'string' && data.secrets[k] ? data.secrets[k] : t[k]),
      }),

    async ready() {
      if (loaded) return
      loaded = true
      try {
        const j = JSON.parse(await readFile(file, 'utf8'))
        const sealed = typeof j.enc === 'string' && j.enc ? JSON.parse(await vault.open(j.enc)) : null
        data = { secrets: sealed ?? j.secrets ?? {}, overrides: j.overrides ?? {}, flags: j.flags ?? {} }
        // Old plaintext file: seal it now (nothing is lost if this fails; the next save retries).
        if (vault && !sealed && Object.keys(data.secrets).length) await persist().catch(() => {})
      } catch {
        /* first run */
      }
      apply()
    },

    /** Plain on/off switches the owner sets from the app (e.g. routerSpend: let outside programs use paid providers). */
    flags: { get: (k) => data.flags[k], all: () => ({ ...data.flags }) },
    async setFlag(k, v) {
      if (!/^[a-zA-Z]{2,30}$/.test(k)) throw new Error('bad flag name')
      data.flags[k] = Boolean(v)
      await persist()
      audit?.record('settings.flag', { k, v: Boolean(v) })
    },

    keys() {
      return [...allowed()].map((name) => {
        const saved = data.secrets[name]
        const v = saved || baseEnv[name] || ''
        return { name, configured: Boolean(v), source: saved ? 'panel' : baseEnv[name] ? 'env' : null, last4: v ? v.slice(-4) : null }
      })
    },

    async setKey(name, value) {
      if (!NAME_RE.test(name) || !allowed().has(name)) throw new Error('unknown key name')
      if (typeof value !== 'string' || !VALUE_RE.test(value)) throw new Error('key must be 8-400 characters without spaces')
      data.secrets[name] = value
      await persist()
      audit?.record('settings.key.set', { name })
      return this.keys()
    },

    async clearKey(name) {
      if (!NAME_RE.test(name) || !allowed().has(name)) throw new Error('unknown key name')
      delete data.secrets[name]
      await persist()
      audit?.record('settings.key.clear', { name })
      return this.keys()
    },

    async setProvider(id, { enabled, model, priority, free, allowedModels }) {
      if (!registry.get(id)) throw new Error('unknown provider')
      const o = { ...(data.overrides[id] ?? {}) }
      if (enabled !== undefined) o.enabled = Boolean(enabled)
      if (free !== undefined) o.free = Boolean(free)
      if (allowedModels !== undefined) {
        if (!Array.isArray(allowedModels) || allowedModels.length > 20 || !allowedModels.every((m) => typeof m === 'string' && MODEL_RE.test(m))) throw new Error('allowedModels must be up to 20 valid model ids')
        o.allowedModels = [...new Set(allowedModels)]
      }
      if (model !== undefined) {
        if (typeof model !== 'string' || !MODEL_RE.test(model)) throw new Error('invalid model id')
        o.model = model
      }
      if (priority !== undefined) {
        if (!Number.isInteger(priority) || priority < 0 || priority > 1000) throw new Error('priority must be an integer 0-1000')
        o.priority = priority
      }
      data.overrides[id] = o
      registry.update(id, o)
      await persist()
      audit?.record('settings.provider', { id, ...o })
    },
  }
}
