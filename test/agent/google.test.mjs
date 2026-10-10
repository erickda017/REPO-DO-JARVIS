import test from 'node:test'
import assert from 'node:assert/strict'
import http from 'node:http'
import { createHash } from 'node:crypto'
import { createConnectors } from '../../bridge/agent/conectores.mjs'
import { createGoogleAuth } from '../../bridge/agent/google.mjs'
import { createRegistry } from '../../bridge/command/providers/registry.mjs'
import { createSettings } from '../../bridge/command/settings.mjs'
import { createAudit } from '../../bridge/command/audit.mjs'
import { fakeFetch } from '../command/helpers.mjs'

const CLIENT_ID = 'meu-app-123456789.apps.googleusercontent.com'
const CLIENT_SECRET = 'GOCSPX-segredo-do-cliente-1234'
const REFRESH = '1//refresh-token-secreto-9876543210'
const jwt = (claims) => `h.${Buffer.from(JSON.stringify(claims)).toString('base64url')}.s`
const form = (body) => Object.fromEntries(new URLSearchParams(String(body)))

/** A fake Google: token endpoint, revoke, and a Gmail API. Records every call. */
function fakeGoogle() {
  const g = { tokens: 0, issued: [], refreshes: 0, revoked: [], authCodes: [], grantedScope: '', invalidGrant: false, mail: [] }
  g.fetch = fakeFetch((url, init) => {
    if (url === 'https://oauth2.googleapis.com/token') {
      const f = form(init.body)
      if (f.grant_type === 'authorization_code') {
        g.authCodes.push(f)
        return { body: { access_token: `ya29.first-${++g.tokens}`, refresh_token: REFRESH, expires_in: 3600, scope: g.grantedScope, id_token: jwt({ email: 'eu@gmail.test', email_verified: true }) } }
      }
      g.refreshes++
      if (g.invalidGrant) return { status: 400, body: { error: 'invalid_grant' } }
      return { body: { access_token: `ya29.refreshed-${++g.tokens}`, expires_in: 3600 } }
    }
    if (url === 'https://oauth2.googleapis.com/revoke') { g.revoked.push(form(init.body).token); return { body: {} } }
    if (url.startsWith('https://gmail.googleapis.com/gmail/v1/users/me/messages?')) return { body: { messages: [{ id: 'm1' }] } }
    if (url.includes('/messages/m1?format=metadata')) return { body: { id: 'm1', threadId: 't1', snippet: 'oi &amp; tudo', labelIds: ['UNREAD'], payload: { headers: [{ name: 'From', value: 'Ana <ana@x.test>' }, { name: 'Subject', value: 'Reunião' }, { name: 'Date', value: 'Fri, 10 Oct 2026' }] } } }
    if (url.endsWith('/messages/send')) { g.mail.push(JSON.parse(init.body)); return { body: { id: 'sent1', threadId: 't2' } } }
    if (url.endsWith('/drafts')) { g.mail.push(JSON.parse(init.body)); return { body: { id: 'd1' } } }
    return { status: 404, body: { error: { message: 'rota inesperada ' + url } } }
  })
  return g
}

function stack({ timeoutMs, withConnectors = false } = {}) {
  const g = fakeGoogle()
  let registry
  let google
  let connectors
  const audit = createAudit({ file: null })
  const settings = createSettings({ file: null, getRegistry: () => registry, baseEnv: {}, getExtraNames: () => [...(google?.secretNames() ?? []), ...(connectors?.secretNames() ?? [])] })
  registry = createRegistry([])
  let now = 1_000_000
  google = createGoogleAuth({ file: null, settings, fetch: g.fetch, audit, clock: () => now, timeoutMs })
  if (withConnectors) { connectors = createConnectors({ file: null, settings, fetch: g.fetch, audit, google }); connectors.attach({}) }
  return { g, google, settings, audit, connectors, advance: (ms) => (now += ms), table: {} }
}
const stackWithTable = () => {
  const s = stack({ withConnectors: true })
  const table = {}
  s.connectors.attach(table)
  return { ...s, table }
}

/** The "browser": opens the redirect Google would send the user back to. */
async function approve(g, authUrl, { state, host, error, granted } = {}) {
  const u = new URL(authUrl)
  g.grantedScope = granted ?? u.searchParams.get('scope')
  const redirect = new URL(u.searchParams.get('redirect_uri'))
  redirect.searchParams.set('state', state ?? u.searchParams.get('state'))
  if (error) redirect.searchParams.set('error', error)
  else redirect.searchParams.set('code', 'codigo-de-autorizacao')
  return new Promise((resolve, reject) => {
    const req = http.request({ host: '127.0.0.1', port: redirect.port, path: redirect.pathname + redirect.search, headers: host ? { Host: host } : {} }, (res) => { let b = ''; res.on('data', (d) => (b += d)); res.on('end', () => resolve({ status: res.statusCode, body: b })) })
    req.on('error', reject)
    req.end()
  })
}
const portOpen = (url) => new Promise((resolve) => { const s = new URL(url); const r = http.get({ host: '127.0.0.1', port: s.port, path: '/' }, () => { r.destroy(); resolve(true) }); r.on('error', () => resolve(false)) })

// ---------------------------------------------------------------------------------------------------------------------
test('client: only a real-looking Google client id is accepted, and the secret goes to the vault (never to the status)', async () => {
  const { google, settings } = stack()
  await assert.rejects(google.setClient('abc', CLIENT_SECRET), /apps\.googleusercontent\.com/)
  await assert.rejects(google.setClient(CLIENT_ID, ''), /Client Secret/)
  await assert.rejects(google.begin([]), /cadastre o Client ID/)
  const s = await google.setClient(CLIENT_ID, CLIENT_SECRET)
  assert.equal(s.configured, true)
  assert.ok(!JSON.stringify(s).includes(CLIENT_SECRET))
  assert.equal(settings.keys().find((k) => k.name === 'GOOGLE_CLIENT_SECRET').configured, true)
})

test('sign-in: PKCE S256, random state, offline access, loopback redirect; a wrong state or Host is ignored; the real redirect completes it and the listener closes', async () => {
  const { google, g, settings } = stack()
  await google.setClient(CLIENT_ID, CLIENT_SECRET)
  const { authUrl, done } = await google.begin([])
  const u = new URL(authUrl)
  assert.equal(u.origin + u.pathname, 'https://accounts.google.com/o/oauth2/v2/auth')
  assert.equal(u.searchParams.get('client_id'), CLIENT_ID)
  assert.equal(u.searchParams.get('response_type'), 'code')
  assert.equal(u.searchParams.get('code_challenge_method'), 'S256')
  assert.equal(u.searchParams.get('access_type'), 'offline')
  assert.equal(u.searchParams.get('scope'), 'openid email', 'sign-in alone asks for identity only')
  assert.match(u.searchParams.get('redirect_uri'), /^http:\/\/127\.0\.0\.1:\d+\/oauth2callback$/)
  assert.ok(u.searchParams.get('state').length >= 30)
  assert.equal(google.status().pending, true)

  assert.equal((await approve(g, authUrl, { state: 'forjado' })).status, 400, 'wrong state')
  assert.equal((await approve(g, authUrl, { host: 'evil.test' })).status, 404, 'rebinding page: wrong Host')
  assert.equal(google.status().pending, true, 'stray requests do not cancel the real sign-in')
  assert.equal(g.authCodes.length, 0, 'no code was exchanged for the forged ones')

  const r = await approve(g, authUrl)
  assert.equal(r.status, 200)
  assert.match(r.body, /Conectado/)
  const res = await done
  assert.equal(res.ok, true)
  assert.equal(res.email, 'eu@gmail.test')
  // the code exchange carried the verifier that matches the challenge, plus the client credentials and the same redirect
  const x = g.authCodes[0]
  assert.equal(createHash('sha256').update(x.code_verifier).digest('base64url'), u.searchParams.get('code_challenge'))
  assert.deepEqual([x.client_id, x.client_secret, x.grant_type, x.redirect_uri], [CLIENT_ID, CLIENT_SECRET, 'authorization_code', u.searchParams.get('redirect_uri')])
  const s = google.status()
  assert.deepEqual([s.connected, s.email, s.pending], [true, 'eu@gmail.test', false])
  assert.equal(settings.keys().find((k) => k.name === 'GOOGLE_REFRESH_TOKEN').configured, true)
  assert.ok(!JSON.stringify(s).includes(REFRESH) && !JSON.stringify(s).includes('ya29'), 'no token in the status')
  assert.equal(await portOpen(authUrl.replace(/^.*redirect_uri=([^&]+).*$/, (_, r2) => decodeURIComponent(r2))), false, 'the listener is gone')
})

test('sign-in: denying access, and timing out, end cleanly with a reason and nothing connected', async () => {
  const a = stack()
  await a.google.setClient(CLIENT_ID, CLIENT_SECRET)
  const { authUrl, done } = await a.google.begin([])
  await approve(a.g, authUrl, { error: 'access_denied' })
  const r = await done
  assert.equal(r.ok, false)
  assert.match(r.reason, /negou/)
  assert.equal(a.google.status().connected, false)

  const b = stack({ timeoutMs: 40 })
  await b.google.setClient(CLIENT_ID, CLIENT_SECRET)
  const t = await b.google.begin([])
  assert.match((await t.done).reason, /tempo esgotado/)
  assert.equal(await portOpen(new URL(t.authUrl).searchParams.get('redirect_uri')), false)
})

test('tokens: refreshed once for concurrent calls, cached, renewed after expiry; missing scopes are refused before any request', async () => {
  const { google, g, advance } = stack()
  await google.setClient(CLIENT_ID, CLIENT_SECRET)
  const { authUrl, done } = await google.begin(['https://www.googleapis.com/auth/gmail.readonly'])
  await approve(g, authUrl)
  await done
  const [a, b, c] = await Promise.all([1, 2, 3].map(() => google.accessToken(['https://www.googleapis.com/auth/gmail.readonly'])))
  assert.equal(a, b); assert.equal(b, c)
  assert.equal(await google.accessToken([]), a, 'cached')
  assert.ok(g.refreshes <= 1, `the first token from the code is reused (refreshes: ${g.refreshes})`)
  advance(3_600_000)
  const fresh = await google.accessToken([])
  assert.notEqual(fresh, a)
  assert.equal(g.refreshes <= 2, true)
  await assert.rejects(google.accessToken(['https://www.googleapis.com/auth/drive.readonly']), /falta permissão/)
})

test('tokens: when Google revokes the session (invalid_grant) the account is disconnected locally, with the reason, and the secret is wiped', async () => {
  const { google, g, advance, settings } = stack()
  await google.setClient(CLIENT_ID, CLIENT_SECRET)
  const { authUrl, done } = await google.begin([])
  await approve(g, authUrl)
  await done
  g.invalidGrant = true
  advance(3_600_000)
  await assert.rejects(google.accessToken([]), /sessão do Google expirou/)
  const s = google.status()
  assert.equal(s.connected, false)
  assert.match(s.lastError, /7 dias/)
  assert.equal(settings.keys().find((k) => k.name === 'GOOGLE_REFRESH_TOKEN').configured, false)
  assert.equal(s.configured, true, 'the client stays: signing in again is one click')
})

test('sign-out: revokes the token at Google, wipes it locally, keeps the client; forgetting the client removes the secret too', async () => {
  const { google, g, settings } = stack()
  await google.setClient(CLIENT_ID, CLIENT_SECRET)
  const { authUrl, done } = await google.begin([])
  await approve(g, authUrl)
  await done
  const after = await google.signOut()
  assert.deepEqual(g.revoked, [REFRESH])
  assert.deepEqual([after.connected, after.configured], [false, true])
  await google.forgetClient()
  assert.equal(google.status().configured, false)
  assert.equal(settings.keys().find((k) => k.name === 'GOOGLE_CLIENT_SECRET').configured, false)
})

test('incremental consent: a later request keeps what was already granted and adds only the new scope', async () => {
  const { google, g } = stack()
  await google.setClient(CLIENT_ID, CLIENT_SECRET)
  const first = await google.begin(['https://www.googleapis.com/auth/gmail.readonly'])
  await approve(g, first.authUrl); await first.done
  const second = await google.begin(['https://www.googleapis.com/auth/gmail.compose'])
  assert.deepEqual(new URL(second.authUrl).searchParams.get('scope').split(' ').sort(), ['email', 'https://www.googleapis.com/auth/gmail.compose', 'https://www.googleapis.com/auth/gmail.readonly', 'openid'])
  google.cancel()
  assert.match((await second.done).reason, /cancelado/)
  assert.equal(google.status().connected, true, 'cancelling an extra consent does not sign the account out')
})

// ---------------------------------------------------------------------------------------------------------------------
test('connectors: switching Gmail on starts READ consent and applies itself once approved; writes need a second consent; requests carry the access token', async () => {
  const { google, g, connectors, table } = stackWithTable()
  await google.setClient(CLIENT_ID, CLIENT_SECRET)
  assert.match((await connectors.test('gmail')).message, /faltam dados/, 'not signed in yet')
  const si = await google.begin([]); await approve(g, si.authUrl); await si.done
  assert.deepEqual(Object.keys(table), [], 'signed in is not the same as any service being on')

  const on = await connectors.setEnabled('gmail', true)
  assert.ok(on.consent?.authUrl, 'asks for consent instead of switching on')
  assert.equal(new URL(on.consent.authUrl).searchParams.get('scope').includes('gmail.readonly'), true)
  assert.ok(!new URL(on.consent.authUrl).searchParams.get('scope').includes('compose'), 'read consent asks for no write scope')
  assert.deepEqual(Object.keys(table), [])
  const ok = await approve(g, on.consent.authUrl)
  assert.equal(ok.status, 200)
  await new Promise((r) => setTimeout(r, 30))
  assert.ok(table.gmail_search && table.gmail_message && !table.gmail_send, 'on after approval, read tools only')

  const found = await table.gmail_search.run({ q: 'is:unread', limit: 5 })
  assert.deepEqual(found.data, [{ id: 'm1', threadId: 't1', from: 'Ana <ana@x.test>', subject: 'Reunião', date: 'Fri, 10 Oct 2026', snippet: 'oi & tudo', unread: true }])
  const gmailCalls = g.fetch.calls.filter((c) => c.url.startsWith('https://gmail.googleapis.com'))
  assert.ok(gmailCalls.length >= 2 && gmailCalls.every((c) => /^Bearer ya29\./.test(c.headers.Authorization)))
  assert.match(gmailCalls[0].url, /q=is%3Aunread/)

  const w = await connectors.setWrite('gmail', true)
  assert.ok(w.consent?.authUrl && new URL(w.consent.authUrl).searchParams.get('scope').includes('gmail.compose'), 'write is its own consent')
  assert.ok(!table.gmail_send)
  await approve(g, w.consent.authUrl)
  await new Promise((r) => setTimeout(r, 30))
  assert.ok(table.gmail_send && table.gmail_draft)

  const msg = await table.gmail_send.confirm({ to: 'chefe@empresa.test', subject: 'Relatório', text: 'segue' })
  assert.match(msg, /NÃO TER VOLTA/)
  assert.match(msg, /gmail\.googleapis\.com\/gmail\/v1\/users\/me\/messages\/send/)
  assert.match(msg, /chefe@empresa\.test/)
  const sent = await table.gmail_send.run({ to: 'chefe@empresa.test', subject: 'Relatório ção', text: 'segue em anexo' })
  assert.equal(sent.verified, true)
  const raw = Buffer.from(g.mail.at(-1).raw, 'base64url').toString('utf8')
  assert.match(raw, /^To: chefe@empresa\.test\r\n/)
  assert.match(raw, /Subject: =\?UTF-8\?B\?/)
  assert.equal(Buffer.from(/Subject: =\?UTF-8\?B\?(.+?)\?=/.exec(raw)[1], 'base64').toString('utf8'), 'Relatório ção')
  await assert.rejects(table.gmail_send.run({ to: 'a@b.test', subject: 'x\r\nBcc: espiao@x.test', text: 'y' }), /assunto inválido/)
  await assert.rejects(table.gmail_send.run({ to: 'a@b.test, <script>@x', subject: 'x', text: 'y' }), /e-mail simples/)

  await google.signOut()
  assert.deepEqual(Object.keys(table), [], 'signing out removes every Google tool at once')
})

test('connectors: the catalogue declares read/write scopes for every Google service, signing in turns nothing on by itself, and no access token reaches the list', async () => {
  const { connectors, google, g } = stackWithTable()
  const gs = connectors.catalog.filter((c) => c.auth.type === 'google')
  assert.equal(gs.length, 7)
  for (const c of gs) {
    assert.ok(c.scopes.read.every((s) => s.startsWith('https://www.googleapis.com/auth/')), c.id)
    assert.ok(c.tools.every((t) => t.risk === 'read' || c.scopes.write.length > 0), `${c.id}: write tools need a write scope`)
    assert.equal(c.fields.length, 0)
  }
  await google.setClient(CLIENT_ID, CLIENT_SECRET)
  const si = await google.begin([]); await approve(g, si.authUrl); await si.done
  const v = connectors.list().find((c) => c.id === 'gmail')
  assert.ok(v.google.needsRead && v.google.needsWrite && v.google.account === 'eu@gmail.test')
  assert.ok(!JSON.stringify(connectors.list()).includes('ya29'))
})

test('granular consent: if the owner unticks a permission, the switch is NOT applied, nothing loops, and the account card says why', async () => {
  const { google, g, connectors, table } = stackWithTable()
  await google.setClient(CLIENT_ID, CLIENT_SECRET)
  const si = await google.begin([]); await approve(g, si.authUrl); await si.done
  const on = await connectors.setEnabled('gmail', true)
  await approve(g, on.consent.authUrl, { granted: 'openid https://www.googleapis.com/auth/userinfo.email' }) // gmail.readonly unticked
  await new Promise((r) => setTimeout(r, 30))
  assert.deepEqual(Object.keys(table), [])
  assert.match(google.status().lastError, /não concedeu a permissão pedida/)
  assert.equal(google.status().pending, false, 'no new sign-in was opened behind his back')
  assert.equal(connectors.list().find((c) => c.id === 'gmail').enabled, false)
})