import { chmod, mkdir, readFile, rename, writeFile } from 'node:fs/promises'
import { dirname } from 'node:path'
import { ProviderError } from './errors.mjs'
import { raiseForStatus, request } from './http.mjs'

const KEY_RE = /^[^\s]{8,200}$/
const VOICE_RE = /^[A-Za-z0-9]{10,40}$/
export const DEFAULT_VOICE_ID = 'JBFqnCBsd6RMkjVDRZzb' // base JARVIS default (ElevenLabs "George")

/**
 * ElevenLabs credentials that can be set from the panel.
 *
 * Precedence for the key is: saved here > ELEVENLABS_API_KEY env var > the
 * base project's lookup in ~/.claude.json (`envKey`, injected). The key lives
 * only in `data/voice.json` on this machine (gitignored); no endpoint ever
 * returns it, only whether one is set and its last four characters.
 */
export function createVoice({ file, env = process.env, envKey = () => null, fetch: fetchImpl = fetch, audit } = {}) {
  let saved = { apiKey: '', voiceId: '' }
  let loaded = !file
  let chain = Promise.resolve()

  const load = async () => {
    if (loaded) return
    loaded = true
    try {
      const j = JSON.parse(await readFile(file, 'utf8'))
      saved = { apiKey: String(j.apiKey ?? ''), voiceId: String(j.voiceId ?? '') }
    } catch {
      /* nothing saved yet */
    }
  }
  const persist = () => {
    if (!file) return Promise.resolve()
    // A failed write (antivirus holding the file, EPERM on rename) must reject THIS call only, never poison later saves.
    const run = chain.then(async () => {
      await mkdir(dirname(file), { recursive: true })
      const tmp = `${file}.tmp`
      await writeFile(tmp, JSON.stringify(saved), { encoding: 'utf8', mode: 0o600 })
      await rename(tmp, file)
      await chmod(file, 0o600).catch(() => {}) // best effort; Windows ignores POSIX modes
    })
    chain = run.catch(() => {})
    return run
  }

  const source = () => (saved.apiKey ? 'panel' : env.ELEVENLABS_API_KEY ? 'env' : envKey() ? 'claude-mcp-config' : null)
  const currentKey = () => saved.apiKey || env.ELEVENLABS_API_KEY || envKey() || ''
  const currentVoice = () => saved.voiceId || env.JARVIS_VOICE_ID || DEFAULT_VOICE_ID

  return {
    /** Synchronous accessors for the bridge's /tts and /stt. Call `ready()` once at startup. */
    ready: load,
    key: () => currentKey() || null,
    voiceId: currentVoice,

    async status() {
      await load()
      const k = currentKey()
      return { configured: Boolean(k), source: source(), last4: k ? k.slice(-4) : null, voiceId: currentVoice() }
    },

    async set({ apiKey, voiceId }) {
      await load()
      if (apiKey !== undefined && apiKey !== '') {
        if (typeof apiKey !== 'string' || !KEY_RE.test(apiKey)) throw new Error('apiKey must be 8-200 characters without spaces')
        saved.apiKey = apiKey
      }
      if (voiceId !== undefined && voiceId !== '') {
        if (typeof voiceId !== 'string' || !VOICE_RE.test(voiceId)) throw new Error('voiceId must be 10-40 letters/digits')
        saved.voiceId = voiceId
      }
      await persist()
      audit?.record('voice.set', { key: apiKey ? 'updated' : 'unchanged', voiceId: saved.voiceId || 'default' })
      return this.status()
    },

    async clear() {
      await load()
      saved = { apiKey: '', voiceId: '' }
      await persist()
      audit?.record('voice.clear')
      return this.status()
    },

    /** Free check: lists the account's voices. Proves the key and lets the UI offer a choice. */
    async test() {
      await load()
      const k = currentKey()
      if (!k) throw new ProviderError('auth', 'no ElevenLabs key configured', { provider: 'elevenlabs' })
      const res = await request(fetchImpl, 'https://api.elevenlabs.io/v1/voices', {
        headers: { 'xi-api-key': k },
        timeoutMs: 8000,
        provider: 'elevenlabs',
      })
      raiseForStatus(res, 'elevenlabs')
      if (!Array.isArray(res.json?.voices)) throw new ProviderError('bad_response', 'GET /v1/voices did not return {voices: [...]}', { provider: 'elevenlabs' })
      audit?.record('voice.test', { ok: true, voices: res.json.voices.length })
      return {
        ok: true,
        latencyMs: res.latencyMs,
        voices: res.json.voices.slice(0, 100).map((v) => ({ id: v.voice_id, name: v.name })),
      }
    },
  }
}
