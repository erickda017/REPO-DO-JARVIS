import test from 'node:test'
import assert from 'node:assert/strict'
import { createRegistry } from '../../bridge/command/providers/registry.mjs'
import { createHealth } from '../../bridge/command/health.mjs'
import { createRouter } from '../../bridge/command/router.mjs'
import { sse } from '../../bridge/command/http.mjs'
import { openaiCompatProvider } from '../../bridge/command/providers/openaiCompat.mjs'
import { anthropicProvider } from '../../bridge/command/providers/anthropic.mjs'
import { geminiProvider } from '../../bridge/command/providers/gemini.mjs'
import { partialAnswer } from '../../bridge/agent/agent.mjs'

/** A fetch whose body arrives in the given pieces, like a real SSE answer (pieces may cut events in half). */
const sseFetch = (pieces, { status = 200, onCall } = {}) => async (url, init) => {
  onCall?.(url, init)
  const enc = new TextEncoder()
  const body = new ReadableStream({
    start(c) {
      for (const p of pieces) c.enqueue(enc.encode(p))
      c.close()
    },
  })
  return new Response(status === 200 ? body : pieces.join(''), { status, headers: { 'content-type': status === 200 ? 'text/event-stream' : 'application/json' } })
}
const collect = async (gen) => {
  const out = []
  for await (const x of gen) out.push(x)
  return out
}

test('sse: events split across chunks and CRLF are reassembled; [DONE] and garbage are skipped', async () => {
  const f = sseFetch(['data: {"a":1}\n\nda', 'ta: {"a":2}\r\n\r\n: keep-alive\n\ndata: not json\n\n', 'data: [DONE]\n\n'])
  assert.deepEqual(await collect(sse(f, 'http://x/y', { provider: 'p' })), [{ a: 1 }, { a: 2 }])
})

test('sse: a non-2xx answer is raised as the normalised error, quota included', async () => {
  const f = sseFetch(['{"error":{"message":"credit balance is too low"}}'], { status: 400 })
  await assert.rejects(collect(sse(f, 'http://x/y', { provider: 'p' })), (e) => e.kind === 'quota')
  const f401 = sseFetch(['{}'], { status: 401 })
  await assert.rejects(collect(sse(f401, 'http://x/y', { provider: 'p' })), (e) => e.kind === 'auth')
})

test('sse: aborting the signal ends the call as a cancellation, not a hang', async () => {
  const ctrl = new AbortController()
  const f = (url, init) =>
    new Promise((_, rej) => init.signal.addEventListener('abort', () => rej(Object.assign(new Error('aborted'), { name: 'AbortError' }))))
  const p = collect(sse(f, 'http://x/y', { provider: 'p', signal: ctrl.signal }))
  ctrl.abort()
  await assert.rejects(p, /cancelled/)
})

test('openai-compat stream: deltas in order, usage at the end, stream:true on the wire', async () => {
  let sent
  const f = sseFetch(
    ['data: {"choices":[{"delta":{"role":"assistant"}}]}\n\n', 'data: {"choices":[{"delta":{"content":"Ol"}}]}\n\ndata: {"choices":[{"delta":{"content":"á"}}]}\n\n', 'data: {"choices":[],"usage":{"prompt_tokens":3,"completion_tokens":2}}\n\ndata: [DONE]\n\n'],
    { onCall: (u, i) => (sent = JSON.parse(i.body)) },
  )
  const p = openaiCompatProvider({ id: 'l', baseUrl: 'http://127.0.0.1:9/v1' }, { fetch: f, env: {} })
  const ev = await collect(p.stream({ model: 'q', prompt: 'oi' }))
  assert.deepEqual(ev.filter((e) => e.delta).map((e) => e.delta).join(''), 'Olá')
  assert.deepEqual(ev.at(-1), { usage: { inputTokens: 3, outputTokens: 2 } })
  assert.equal(sent.stream, true)
})

test('anthropic stream: text deltas and usage; an overloaded error event is a server error', async () => {
  const ok = sseFetch([
    'event: message_start\ndata: {"type":"message_start","message":{"usage":{"input_tokens":7}}}\n\n',
    'event: content_block_delta\ndata: {"type":"content_block_delta","delta":{"type":"text_delta","text":"Oi"}}\n\n',
    'event: message_delta\ndata: {"type":"message_delta","usage":{"output_tokens":1}}\n\n',
  ])
  const ev = await collect(anthropicProvider({ id: 'a' }, { fetch: ok, env: { ANTHROPIC_API_KEY: 'k-12345678' } }).stream({ model: 'm', prompt: 'x' }))
  assert.deepEqual(ev, [{ delta: 'Oi' }, { usage: { inputTokens: 7, outputTokens: 1 } }])
  const bad = sseFetch(['data: {"type":"error","error":{"type":"overloaded_error","message":"Overloaded"}}\n\n'])
  await assert.rejects(collect(anthropicProvider({ id: 'a' }, { fetch: bad, env: { ANTHROPIC_API_KEY: 'k-12345678' } }).stream({ model: 'm', prompt: 'x' })), (e) => e.kind === 'server')
})

test('gemini stream: uses streamGenerateContent?alt=sse and joins the parts', async () => {
  let url
  const f = sseFetch(['data: {"candidates":[{"content":{"parts":[{"text":"A"}]}}]}\n\n', 'data: {"candidates":[{"content":{"parts":[{"text":"B"}]}}],"usageMetadata":{"promptTokenCount":2,"candidatesTokenCount":2}}\n\n'], { onCall: (u) => (url = u) })
  const ev = await collect(geminiProvider({ id: 'g' }, { fetch: f, env: { GEMINI_API_KEY: 'k-12345678' } }).stream({ model: 'models/gem', prompt: 'x' }))
  assert.equal(ev.filter((e) => e.delta).map((e) => e.delta).join(''), 'AB')
  assert.match(url, /\/models\/gem:streamGenerateContent\?alt=sse$/)
})

const routerWith = (adapters) => {
  const cfgs = adapters.map((a, i) => ({ id: a.id, type: 'openai-compat', baseUrl: `http://127.0.0.1:${9 + i}/v1`, models: ['m'], priority: i + 1, paid: false }))
  const registry = createRegistry(cfgs, { fetch: async () => { throw new Error('unused') }, env: {} })
  for (const a of adapters) {
    const ad = registry.get(a.id).adapter
    if (a.stream) ad.stream = a.stream
    else { delete ad.stream; ad.infer = a.infer }
  }
  return createRouter({ registry, health: createHealth({ registry }) })
}
const gen = (events, fail) => async function* () {
  for (const e of events) yield e
  if (fail) throw fail
}

test('router stream: before the first token a failing provider hands over to the next one', async () => {
  const router = routerWith([
    { id: 'a', stream: gen([], Object.assign(new Error('x'), { __p: 1 })) },
    { id: 'b', stream: gen([{ delta: 'o' }, { delta: 'k' }]) },
  ])
  // provider "a" throws a plain Error -> normalised as a retryable network error -> "b" answers
  const ev = await collect(router.runStream({ prompt: 'oi' }))
  assert.equal(ev[0].start, true)
  assert.equal(ev[0].provider, 'b')
  assert.equal(ev.filter((e) => e.delta).map((e) => e.delta).join(''), 'ok')
  assert.equal(ev.at(-1).done, true)
  assert.ok(ev.at(-1).attempts.some((a) => a.provider === 'a' && a.error))
})

test('router stream: after the first token a failure is reported as partial, never continued by another model', async () => {
  let secondCalled = false
  const router = routerWith([
    { id: 'a', stream: gen([{ delta: 'meio' }], new Error('connection reset')) },
    { id: 'b', stream: async function* () { secondCalled = true; yield { delta: 'NAO' } } },
  ])
  const ev = await collect(router.runStream({ prompt: 'oi' }))
  assert.deepEqual(ev.filter((e) => e.delta).map((e) => e.delta), ['meio'])
  assert.equal(ev.at(-1).partial, true)
  assert.equal(secondCalled, false)
})

test('router stream: a cancelled request never starts another provider', async () => {
  const ctrl = new AbortController()
  let secondCalled = false
  const router = routerWith([
    { id: 'a', stream: async function* () { ctrl.abort(); throw new Error('cancelled') } },
    { id: 'b', stream: async function* () { secondCalled = true; yield { delta: 'x' } } },
  ])
  await assert.rejects(collect(router.runStream({ prompt: 'oi', signal: ctrl.signal })), /cancelled/)
  assert.equal(secondCalled, false)
})

test('router stream: a provider without stream answers in one piece', async () => {
  const router = routerWith([{ id: 'a', infer: async () => ({ text: 'inteiro', model: 'm', usage: { inputTokens: 1, outputTokens: 1 } }) }])
  const ev = await collect(router.runStream({ prompt: 'oi' }))
  assert.deepEqual(ev.filter((e) => e.delta).map((e) => e.delta), ['inteiro'])
  assert.equal(ev.at(-1).done, true)
})
test('partialAnswer: only a final action text is visible, escapes are decoded, tool calls show nothing', () => {
  assert.equal(partialAnswer('{"action":"final","text":"Olá, \\"mun'), 'Olá, "mun')
  assert.equal(partialAnswer('{"action":"final","text":"linha1\\nlinha2 \\u00e7'), 'linha1\nlinha2 ç')
  assert.equal(partialAnswer('{"action":"final","text":"a\\'), 'a')
  assert.equal(partialAnswer('{"action":"tool","tool":"fs_list","args":{"text":"x'), '')
  assert.equal(partialAnswer('{"action":"fin'), '')
  assert.equal(partialAnswer('Resposta em texto puro'), 'Resposta em texto puro')
})
