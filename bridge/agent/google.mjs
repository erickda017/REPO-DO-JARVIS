import { createHash, randomBytes } from 'node:crypto'
import { createServer } from 'node:http'
import { mkdir, readFile, rename, writeFile } from 'node:fs/promises'
import { dirname } from 'node:path'
import { AgentError } from './access.mjs'

/**
 * Sign in with Google (OAuth 2.0 for desktop apps), done the careful way:
 *
 *  - The owner brings his OWN OAuth client (Google Cloud Console, type "Desktop app"): JARVIS ships no shared client id,
 *    so nothing here depends on, or is reviewed by, anyone else.
 *  - Authorization Code + PKCE (S256) + a random `state`, redirected to a loopback listener (127.0.0.1, random port) that
 *    lives only while the sign-in is open (5 min), serves one path, checks the Host header and the state, and shuts down.
 *  - The browser is the system one: the Google password and 2-step prompts never touch this app.
 *  - Least privilege, asked incrementally: sign-in itself asks only for identity (openid email). Each connector asks for its
 *    own READ scopes when it is switched on, and for WRITE scopes only when "allow changes" is switched on.
 *    The scopes come from the catalogue on this side; the UI can only name a connector and a level, never a scope.
 *  - Only the refresh token and the client secret are stored, in the encrypted vault (DPAPI). Access tokens live in memory
 *    and are renewed a minute before they expire (one refresh at a time). Nothing secret ever goes to the screen or a log.
 *  - Signing out revokes the token at Google and wipes everything local. If Google revokes it first (or an app still in
 *    "Testing" lets it lapse after 7 days) the account just shows as disconnected, with the reason.
 */
const AUTH_URL = 'https://accounts.google.com/o/oauth2/v2/auth'
const TOKEN_URL = 'https://oauth2.googleapis.com/token'
const REVOKE_URL = 'https://oauth2.googleapis.com/revoke'
export const BASE_SCOPES = ['openid', 'email']
const SIGNIN_TIMEOUT_MS = 5 * 60_000
const CLIENT_ID_RE = /^[\w.-]{10,200}\.apps\.googleusercontent\.com$/
const SECRET_NAMES = { secret: 'GOOGLE_CLIENT_SECRET', refresh: 'GOOGLE_REFRESH_TOKEN' }

const b64url = (buf) => Buffer.from(buf).toString('base64url')
const sha256 = (s) => createHash('sha256').update(s).digest()
const page = (title, text) => `<!doctype html><meta charset="utf-8"><title>${title}</title><body style="font:16px system-ui;background:#02060a;color:#cfefff;display:grid;place-items:center;height:100vh;margin:0"><div style="max-width:30em;text-align:center"><h1 style="font-size:20px">${title}</h1><p>${text}</p></div>`

export function createGoogleAuth({ file = null, settings, fetch: fetchImpl = fetch, audit = null, clock = Date.now, endpoints = {}, timeoutMs = SIGNIN_TIMEOUT_MS } = {}) {
  const urls = { auth: AUTH_URL, token: TOKEN_URL, revoke: REVOKE_URL, ...endpoints }
  let state = { clientId: '', email: '', scopes: [], connectedAt: null, lastError: null }
  let loaded = !file
  let chain = Promise.resolve()
  let access = null // { token, exp }  (memory only)
  let refreshing = null
  let pending = null // the sign-in in progress: { server, state, verifier, redirect, scopes, timer, then, done }
  const listeners = new Set()

  const persist = () => {
    if (!file) return Promise.resolve()
    const run = chain.then(async () => {
      await mkdir(dirname(file), { recursive: true })
      const tmp = `${file}.tmp`
      await writeFile(tmp, JSON.stringify(state, null, 2), 'utf8')
      await rename(tmp, file)
    })
    chain = run.catch(() => {})
    return run
  }
  const env = () => settings.env()
  const secret = () => env()[SECRET_NAMES.secret] || ''
  const refreshToken = () => env()[SECRET_NAMES.refresh] || ''
  const changed = () => { for (const l of listeners) { try { l() } catch { /* a listener must not break auth */ } } }
  const connected = () => Boolean(refreshToken() && state.scopes.length)

  async function form(url, params) {
    let res
    try {
      res = await fetchImpl(url, { method: 'POST', headers: { 'content-type': 'application/x-www-form-urlencoded', accept: 'application/json' }, body: new URLSearchParams(params).toString(), redirect: 'manual', signal: AbortSignal.timeout(20_000) })
    } catch {
      throw new AgentError('network', 'não consegui falar com o Google')
    }
    const text = await res.text()
    let json = null
    try { json = text ? JSON.parse(text) : null } catch { /* not JSON */ }
    return { status: res.status, json }
  }

  const status = () => ({
    configured: Boolean(state.clientId && secret()),
    clientId: state.clientId,
    connected: connected(),
    email: connected() ? state.email : '',
    scopes: connected() ? [...state.scopes] : [],
    pending: Boolean(pending),
    lastError: state.lastError,
  })

  async function disconnectLocal(reason) {
    await settings.clearKey(SECRET_NAMES.refresh).catch(() => {})
    access = null
    state = { ...state, email: '', scopes: [], connectedAt: null, lastError: reason ?? null }
    await persist()
    changed()
  }

  function closePending(reason) {
    if (!pending) return
    const p = pending
    pending = null
    clearTimeout(p.timer)
    p.server.close()
    p.server.closeAllConnections?.()
    p.done?.({ ok: false, reason })
  }

  /** A fresh access token carrying (at least) these scopes. Throws a plain, user-facing AgentError when it cannot. */
  async function accessToken(needed = []) {
    if (!connected()) throw new AgentError('google', 'a conta Google não está conectada: entre pela tela Conectores')
    const missing = needed.filter((s) => !state.scopes.includes(s))
    if (missing.length) throw new AgentError('google', 'falta permissão no Google para isto: autorize de novo pela tela Conectores')
    if (access && access.exp - clock() > 60_000) return access.token
    refreshing ??= (async () => {
      const r = await form(urls.token, { client_id: state.clientId, client_secret: secret(), refresh_token: refreshToken(), grant_type: 'refresh_token' })
      if (r.status === 400 && r.json?.error === 'invalid_grant') {
        audit?.record('google.expired', {})
        await disconnectLocal('O Google encerrou a sessão (revogada, ou expirou: apps em modo de teste perdem o acesso em 7 dias). Entre de novo.')
        throw new AgentError('google', 'a sessão do Google expirou: entre de novo pela tela Conectores')
      }
      if (r.status !== 200 || !r.json?.access_token) throw new AgentError('google', `o Google recusou renovar o acesso (HTTP ${r.status})`)
      access = { token: r.json.access_token, exp: clock() + Number(r.json.expires_in ?? 3600) * 1000 }
      return access.token
    })().finally(() => { refreshing = null })
    return refreshing
  }

  return {
    async ready() {
      if (loaded) return
      loaded = true
      try { state = { ...state, ...JSON.parse(await readFile(file, 'utf8')) } } catch { /* first run */ }
    },
    secretNames: () => Object.values(SECRET_NAMES),
    onChange: (fn) => { listeners.add(fn); return () => listeners.delete(fn) },
    status,
    accessToken,
    peekAccess: () => access?.token ?? '', // only so connectors can scrub it from results; never returned to the UI
    has: (scopes) => connected() && scopes.every((s) => state.scopes.includes(s)),
    scopes: () => [...state.scopes],

    /** The owner's own OAuth client. Replacing it signs the account out (tokens belong to one client). */
    async setClient(clientId, clientSecret) {
      const id = String(clientId ?? '').trim()
      const sec = String(clientSecret ?? '').trim()
      if (!CLIENT_ID_RE.test(id)) throw new Error('o Client ID deve terminar em .apps.googleusercontent.com')
      if (sec && !/^[\w-]{8,200}$/.test(sec)) throw new Error('Client Secret com formato estranho (sem espaços)')
      if (!sec && !secret()) throw new Error('informe também o Client Secret')
      closePending('cliente trocado')
      if (id !== state.clientId && refreshToken()) await this.signOut()
      state = { ...state, clientId: id }
      if (sec) await settings.setKey(SECRET_NAMES.secret, sec)
      await persist()
      audit?.record('google.client', {})
      changed()
      return status()
    },

    /**
     * Opens a sign-in. Resolves with the URL to open in the system browser; `done` settles when the owner finishes (or it times out).
     * `scopes` are added to what is already granted (incremental authorization). `then` runs after success.
     */
    async begin(scopes = [], then = null) {
      if (!state.clientId || !secret()) throw new Error('cadastre o Client ID e o Client Secret do Google antes')
      closePending('substituída por um novo pedido')
      const want = [...new Set([...BASE_SCOPES, ...state.scopes, ...scopes])]
      const verifier = b64url(randomBytes(48))
      const st = b64url(randomBytes(24))
      const done = new Promise((resolve) => { pending = { done: resolve } })
      const p = pending
      Object.assign(p, { state: st, verifier, scopes: want, then })
      const server = createServer(async (req, res) => {
        const send = (code, html) => { res.writeHead(code, { 'content-type': 'text/html; charset=utf-8', 'cache-control': 'no-store', 'x-content-type-options': 'nosniff' }); res.end(html) }
        try {
          const u = new URL(req.url ?? '/', 'http://127.0.0.1')
          // Only the exact redirect, only for the host we bound (a DNS-rebinding page would send another Host).
          if (req.method !== 'GET' || u.pathname !== '/oauth2callback' || req.headers.host !== `127.0.0.1:${server.address().port}`) return send(404, page('Não encontrado', ''))
          if (pending !== p) return send(410, page('Pedido encerrado', 'Este pedido de login não está mais ativo.'))
          if (u.searchParams.get('state') !== p.state) { send(400, page('Pedido inválido', 'O estado não confere. Nada foi conectado.')); return } // keep waiting: a stray request must not cancel the real one
          const err = u.searchParams.get('error')
          const code = u.searchParams.get('code')
          if (err || !code) { send(200, page('Login cancelado', 'Você pode fechar esta aba e voltar ao JARVIS.')); closePending(err === 'access_denied' ? 'você negou o acesso' : `o Google respondeu: ${String(err).slice(0, 80)}`); return }
          const r = await form(urls.token, { code, client_id: state.clientId, client_secret: secret(), redirect_uri: p.redirect, grant_type: 'authorization_code', code_verifier: p.verifier })
          if (r.status !== 200 || !r.json?.access_token) {
            send(200, page('Não consegui concluir', 'O Google recusou a troca do código. Volte ao JARVIS e tente de novo.'))
            closePending(`o Google recusou a troca do código${r.json?.error ? ` (${String(r.json.error).slice(0, 60)})` : ''}`)
            return
          }
          const granted = String(r.json.scope ?? '').split(/\s+/).filter(Boolean)
          let email = state.email
          try { const claims = JSON.parse(Buffer.from(String(r.json.id_token).split('.')[1], 'base64url').toString('utf8')); if (claims.email && claims.email_verified !== false) email = String(claims.email).slice(0, 200) } catch { /* display only */ }
          const rt = r.json.refresh_token || refreshToken()
          if (!rt) { send(200, page('Faltou a permissão offline', 'O Google não devolveu a credencial de renovação.')); closePending('o Google não devolveu a credencial de renovação'); return }
          await settings.setKey(SECRET_NAMES.refresh, rt)
          access = { token: r.json.access_token, exp: clock() + Number(r.json.expires_in ?? 3600) * 1000 }
          state = { ...state, email, scopes: [...new Set(granted)], connectedAt: new Date(clock()).toISOString(), lastError: null }
          await persist()
          audit?.record('google.connected', { scopes: granted.length })
          send(200, page('Pronto', 'Conectado ao JARVIS. Pode fechar esta aba.'))
          pending = null
          clearTimeout(p.timer)
          server.close()
          server.closeAllConnections?.()
          changed()
          let applied = null
          try { applied = await p.then?.() } catch (e) { applied = { error: String(e?.message ?? e) } }
          if (applied?.error) { state = { ...state, lastError: applied.error }; await persist() } // shown on the account card
          p.done({ ok: true, email, scopes: state.scopes, applied })
        } catch {
          send(500, page('Erro', 'Algo deu errado. Volte ao JARVIS e tente de novo.'))
          closePending('erro interno no login')
        }
      })
      p.server = server
      await new Promise((resolve, reject) => { server.once('error', reject); server.listen(0, '127.0.0.1', resolve) })
      p.redirect = `http://127.0.0.1:${server.address().port}/oauth2callback`
      p.timer = setTimeout(() => closePending('tempo esgotado (5 minutos)'), timeoutMs)
      p.timer.unref?.()
      const q = new URLSearchParams({
        client_id: state.clientId, redirect_uri: p.redirect, response_type: 'code', scope: want.join(' '), state: st,
        code_challenge: b64url(sha256(verifier)), code_challenge_method: 'S256', access_type: 'offline', prompt: 'consent', include_granted_scopes: 'true',
      })
      audit?.record('google.begin', { scopes: want.length })
      return { authUrl: `${urls.auth}?${q}`, done }
    },
    cancel: () => closePending('cancelado por você'),

    /** Revokes at Google, then forgets everything local (the client id and secret stay, so signing in again is one click). */
    async signOut() {
      const rt = refreshToken()
      closePending('saída')
      if (rt) await form(urls.revoke, { token: rt }).catch(() => {}) // best effort: local wipe happens either way
      await disconnectLocal(null)
      audit?.record('google.signout', {})
      return status()
    },
    /** Also forgets the client id and secret. */
    async forgetClient() {
      await this.signOut()
      await settings.clearKey(SECRET_NAMES.secret).catch(() => {})
      state = { ...state, clientId: '' }
      await persist()
      changed()
      return status()
    },
  }
}
