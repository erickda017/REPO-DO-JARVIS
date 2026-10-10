import test from 'node:test'
import assert from 'node:assert/strict'
import http from 'node:http'
import { fakeFetch } from './helpers.mjs'
import { createCommand } from '../../bridge/command/index.mjs'
import { createAccess } from '../../bridge/agent/access.mjs'
import { createAgent } from '../../bridge/agent/agent.mjs'
import { buildTools } from '../../bridge/agent/tools.mjs'

const ok = (text, model = 'x') => ({ body: { choices: [{ message: { content: text } }], model, usage: { prompt_tokens: 1, completion_tokens: 1 } } })

async function withCommand(fn, providers) {
  const f = fakeFetch((url, init) => {
    if (url.includes('127.0.0.1:9')) return ok('resposta LOCAL')
    return ok('resposta da API', JSON.parse(init.body ?? '{}').model)
  })
  const cmd = createCommand({ persist: false, fetch: f, env: { OR_KEY: 'sk-or-0123456789' }, config: { providers, services: [], projects: [], dataDir: '/nonexistent' } })
  const server = http.createServer((req, res) => cmd.api.handle(req, res, {}).then((h) => h || res.writeHead(404).end()))
  await new Promise((r) => server.listen(0, '127.0.0.1', r))
  const base = `http://127.0.0.1:${server.address().port}`
  const call = async (method, path, body) => {
    const r = await fetch(base + path, { method, headers: { origin: 'http://localhost:5173', 'content-type': 'application/json' }, body: body === undefined ? undefined : JSON.stringify(body) })
    const t = await r.text()
    return { status: r.status, json: t ? JSON.parse(t) : null }
  }
  try { await fn({ cmd, call, f }) } finally { server.close() }
}
const PROVIDERS = [
  { id: 'local', type: 'openai-compat', baseUrl: 'http://127.0.0.1:9/v1', models: ['q'], priority: 10, capabilities: ['chat'] },
  { id: 'or', type: 'openai-compat', baseUrl: 'https://openrouter.test/v1', apiKeyEnv: 'OR_KEY', models: ['m:free'], priority: 20, capabilities: ['chat'], paid: false },
]

test('APIs-only: the switch comes through the API, the local model is skipped (never called) and the API answers', () =>
  withCommand(async ({ cmd, call, f }) => {
    assert.equal((await call('GET', '/api/command/overview')).json.apisOnly, false)
    assert.equal((await cmd.router.run({ prompt: 'oi' })).provider, 'local', 'normal: the local model has the priority')
    const on = await call('POST', '/api/command/ai/apisonly', { on: true })
    assert.deepEqual(on.json, { apisOnly: true })
    assert.equal((await call('GET', '/api/command/overview')).json.apisOnly, true)
    f.calls.length = 0
    const r = await cmd.router.run({ prompt: 'oi' })
    assert.equal(r.provider, 'or')
    assert.ok(!f.calls.some((c) => c.url.includes('127.0.0.1:9')), 'the local server was not even contacted')
    const streamed = []
    for await (const ev of cmd.router.runStream({ prompt: 'oi' })) if (ev.start) streamed.push(ev.provider)
    assert.deepEqual(streamed, ['or'], 'streaming too (the agent and the chat use it)')
    await call('POST', '/api/command/ai/apisonly', { on: false })
    assert.equal((await cmd.router.run({ prompt: 'oi' })).provider, 'local', 'switched off again')
  }, PROVIDERS))

test('APIs-only: with no usable API the error says what is missing (and that sensitive requests cannot work); the agent keeps answering through the API', () =>
  withCommand(async ({ cmd, call }) => {
    await call('POST', '/api/command/ai/apisonly', { on: true })
    await assert.rejects(() => cmd.router.run({ prompt: 'oi' }), /só APIs.*nenhuma API está pronta/)
    await assert.rejects(() => cmd.router.run({ prompt: 'segredo', sensitive: true }), /sensível não pode sair/)
    // the agent loop works without the local model whenever an API is available
    await cmd.settings.setProvider('or', { enabled: true })
    const access = createAccess({ env: { USERPROFILE: process.cwd() }, systemFolders: false })
    const agent = createAgent({ router: cmd.router, tools: buildTools({ access, monitor: {}, profiles: {} }), access })
    const id = agent.run({ text: 'oi', audit: false })
    const v = await (async () => { for (let i = 0; i < 200; i++) { const x = agent.view(id); if (x.status === 'done') return x; await new Promise((r) => setTimeout(r, 15)) } throw new Error('timeout') })()
    assert.equal(v.provider, 'or')
  }, [PROVIDERS[0], { ...PROVIDERS[1], enabled: false }]))

// ---------------------------------------------------------------------------------------------- which model answered, and web answers
const router = (script, provider = 'gemini', model = 'gemini-2.5-flash') => ({ run: async () => ({ text: script.shift(), provider, model, latencyMs: 1 }) })
const done = async (agent, id) => { for (let i = 0; i < 300; i++) { const v = agent.view(id); if (v.status === 'done') return v; await new Promise((r) => setTimeout(r, 15)) } throw new Error('timeout') }

test('the job reports which provider/model answered (every distinct one, in order, when one takes over from another)', async () => {
  const access = createAccess({ env: { USERPROFILE: process.cwd() }, systemFolders: false })
  const tools = { ...buildTools({ access, monitor: {}, profiles: {} }) }
  const calls = [['groq', 'llama-70b', JSON.stringify({ action: 'tool', tool: 'sys_summary', args: {} })], ['gemini', 'gemini-2.5-flash', '{"action":"final","text":"pronto"}']]
  const r = { run: async () => { const [provider, model, text] = calls.shift(); return { text, provider, model, latencyMs: 1 } } }
  tools.sys_summary = { name: 'sys_summary', group: 'system', risk: 'read', desc: 'x', params: {}, run: async () => ({ data: { ok: 1 } }) }
  const agent = createAgent({ router: r, tools, access })
  const v = await done(agent, agent.run({ text: 'como está o pc?', audit: false }))
  assert.equal(v.model, 'gemini-2.5-flash')
  assert.deepEqual(v.models, ['groq/llama-70b', 'gemini/gemini-2.5-flash'])
  assert.equal(v.provider, 'gemini')
})

test('web answers: introduced as what was found and closed with the real sources; no extra approval is asked to read the web', async () => {
  const access = createAccess({ env: { USERPROFILE: process.cwd() }, systemFolders: false })
  const tools = buildTools({ access, monitor: {}, profiles: {} })
  tools.web_search = { name: 'web_search', group: 'web', risk: 'read', desc: 'x', params: {}, run: async () => ({ data: { results: [{ title: 'A', url: 'https://a.example/1', snippet: 's' }, { title: 'B', url: 'https://b.example/2', snippet: 's' }, { title: 'x', url: 'javascript:alert(1)' }] } }) }
  tools.web_fetch = { name: 'web_fetch', group: 'web', risk: 'read', desc: 'x', params: {}, run: async () => ({ data: { url: 'https://a.example/1', text: 'conteúdo' } }) }
  const script = [
    JSON.stringify({ action: 'tool', tool: 'web_search', args: { query: 'clima' } }),
    JSON.stringify({ action: 'tool', tool: 'web_fetch', args: { url: 'https://a.example/1' } }),
    '{"action":"final","text":"Em Curitiba faz 22 graus."}',
  ]
  const agent = createAgent({ router: router(script), tools, access })
  const id = agent.run({ text: 'pesquise o clima de Curitiba', audit: false })
  let asked = false
  const v = await (async () => { for (let i = 0; i < 300; i++) { const x = agent.view(id); if (x.pending) { asked = true; agent.confirm(x.pending.id, true) } if (x.status === 'done') return x; await new Promise((r) => setTimeout(r, 15)) } throw new Error('timeout') })()
  assert.equal(asked, false, 'reading the web never asks')
  assert.match(v.result.text, /^Isto foi o que consegui encontrar:\n\nEm Curitiba faz 22 graus\./)
  assert.match(v.result.text, /\n\nFontes: https:\/\/a\.example\/1  ·  https:\/\/b\.example\/2$/)
  assert.ok(!v.result.text.includes('javascript:'), 'only http(s) pages are listed as sources')

  // an answer that already says it does not get the sentence twice; without a search there is no framing at all
  const again = createAgent({ router: router([JSON.stringify({ action: 'tool', tool: 'web_search', args: { query: 'x' } }), '{"action":"final","text":"Isto foi o que encontrei: nada demais."}']), tools, access })
  const v2 = await done(again, again.run({ text: 'pesquise x', audit: false }))
  assert.equal((v2.result.text.match(/Isto foi o que/g) ?? []).length, 1)
  const plain = createAgent({ router: router(['{"action":"final","text":"Oi!"}']), tools, access })
  assert.equal((await done(plain, plain.run({ text: 'oi', audit: false }))).result.text, 'Oi!')
})
