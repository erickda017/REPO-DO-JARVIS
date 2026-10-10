import test from 'node:test'
import assert from 'node:assert/strict'
import http from 'node:http'
import { fakeFetch } from './helpers.mjs'
import { openaiCompatProvider } from '../../bridge/command/providers/openaiCompat.mjs'
import { geminiProvider, geminiSchema, toGeminiRequest } from '../../bridge/command/providers/gemini.mjs'
import { createRouter } from '../../bridge/command/router.mjs'
import { createOpenAiApi } from '../../bridge/command/openaiApi.mjs'

const TOOLS = [{ type: 'function', function: { name: 'read_file', description: 'Lê um arquivo', parameters: { type: 'object', properties: { path: { type: 'string', default: 'x' }, n: { type: ['integer', 'null'] } }, required: ['path'], additionalProperties: false } } }]
const collect = async (it) => { const out = { text: '', done: null }; for await (const ev of it) { if (ev.delta) out.text += ev.delta; if (ev.done) out.done = ev }; return out }

test('openai-compat chat: tool calls come back assembled, with the arguments as a string', async () => {
  const f = fakeFetch(() => ({ body: { choices: [{ message: { role: 'assistant', content: null, tool_calls: [{ id: 'c1', type: 'function', function: { name: 'read_file', arguments: '{"path":"a.txt"}' } }] }, finish_reason: 'tool_calls' }] } }))
  const p = openaiCompatProvider({ id: 'x', baseUrl: 'https://x.test/v1', apiKeyEnv: 'K' }, { fetch: f, env: { K: 'k'.repeat(12) } })
  const r = await collect(p.chat({ model: 'm', messages: [{ role: 'user', content: 'oi' }], tools: TOOLS }))
  assert.deepEqual(r.done.toolCalls, [{ id: 'c1', type: 'function', function: { name: 'read_file', arguments: '{"path":"a.txt"}' } }])
  assert.equal(r.done.finishReason, 'tool_calls')
  const sent = JSON.parse(f.calls[0].body)
  assert.deepEqual(sent.tools, TOOLS)
  assert.equal(sent.stream, true)
})

test('openai-compat chat: a custom field on a tool call (thoughtSignature) is never sent to the provider', async () => {
  const f = fakeFetch(() => ({ body: { choices: [{ message: { content: 'ok' }, finish_reason: 'stop' }] } }))
  const p = openaiCompatProvider({ id: 'x', baseUrl: 'https://x.test/v1' }, { fetch: f })
  await collect(p.chat({ model: 'm', messages: [{ role: 'user', content: 'a' }, { role: 'assistant', content: null, tool_calls: [{ id: 'c', type: 'function', function: { name: 't', arguments: '{}' }, thoughtSignature: 'SECRET' }] }, { role: 'tool', tool_call_id: 'c', content: 'r' }] }))
  assert.ok(!f.calls[0].body.includes('SECRET'))
})

test('gemini: JSON schema is reduced to what Gemini accepts; messages, tool calls and tool results are translated both ways', () => {
  assert.deepEqual(geminiSchema(TOOLS[0].function.parameters), { type: 'object', properties: { path: { type: 'string' }, n: { type: 'integer', nullable: true } }, required: ['path'] })
  const body = toGeminiRequest({
    messages: [
      { role: 'system', content: 'regras' }, { role: 'user', content: 'leia' },
      { role: 'assistant', content: null, tool_calls: [{ id: 'c1', type: 'function', function: { name: 'read_file', arguments: '{"path":"a"}' }, thoughtSignature: 'SIG' }] },
      { role: 'tool', tool_call_id: 'c1', content: 'conteúdo' },
    ], tools: TOOLS, maxTokens: 100,
  }, 'gemini-2.0-flash')
  assert.equal(body.systemInstruction.parts[0].text, 'regras')
  assert.deepEqual(body.contents.map((c) => c.role), ['user', 'model', 'user'])
  assert.deepEqual(body.contents[1].parts[0], { functionCall: { name: 'read_file', args: { path: 'a' } }, thoughtSignature: 'SIG' })
  assert.deepEqual(body.contents[2].parts[0], { functionResponse: { name: 'read_file', response: { content: 'conteúdo' } } })
  assert.equal(body.tools[0].functionDeclarations[0].name, 'read_file')
  assert.equal(body.toolConfig.functionCallingConfig.mode, 'AUTO')
})

test('gemini chat: functionCall parts become tool_calls (keeping the thought signature); text parts stream as deltas', async () => {
  const f = fakeFetch(() => ({ body: { candidates: [{ content: { parts: [{ text: 'vou ler' }, { functionCall: { name: 'read_file', args: { path: 'a' } }, thoughtSignature: 'SIG' }] }, finishReason: 'STOP' }], usageMetadata: { promptTokenCount: 5, candidatesTokenCount: 3 } } }))
  const p = geminiProvider({ id: 'g', apiKeyEnv: 'K' }, { fetch: f, env: { K: 'k'.repeat(12) } })
  const r = await collect(p.chat({ model: 'gemini-2.5-flash', messages: [{ role: 'user', content: 'oi' }], tools: TOOLS }))
  assert.equal(r.text, 'vou ler')
  assert.equal(r.done.toolCalls[0].function.name, 'read_file')
  assert.equal(r.done.toolCalls[0].function.arguments, '{"path":"a"}')
  assert.equal(r.done.toolCalls[0].thoughtSignature, 'SIG')
  assert.equal(r.done.finishReason, 'tool_calls')
})

const prov = (id, priority, adapter, extra = {}) => ({ id, enabled: true, type: 'openai-compat', external: true, paid: false, priority, tier: 'strong', capabilities: ['chat'], allowSensitive: false, allowFallback: true, allowedModels: [], defaultModel: 'm', adapter, ...extra })

test('router chatStream: providers without native tool calling are skipped, a failing one hands over to the next, a hung one is dropped', async () => {
  const noTools = { async *stream() { yield { delta: 'x' } } }
  const hang = { async *chat({ signal }) { await new Promise((_, rej) => signal.addEventListener('abort', () => rej(new Error('aborted')), { once: true })) } }
  const ok = { async *chat() { yield { delta: 'oi' }; yield { done: true, toolCalls: [{ id: 'a', type: 'function', function: { name: 't', arguments: '{}' } }], finishReason: 'tool_calls' } } }
  const router = createRouter({ registry: { list: () => [prov('semtools', 1, noTools), prov('lenta', 2, hang), prov('boa', 3, ok)] } })
  const r = await collect(router.chatStream({ messages: [{ role: 'user', content: 'x' }], tools: TOOLS, fast: true, firstTokenMs: 60 }))
  assert.equal(r.done.provider, 'boa')
  assert.equal(r.done.toolCalls.length, 1)
  assert.ok(r.done.attempts.some((a) => a.provider === 'semtools' && /tool calling/.test(a.skipped)))
  const none = createRouter({ registry: { list: () => [prov('semtools', 1, noTools)] } })
  await assert.rejects(() => collect(none.chatStream({ messages: [{ role: 'user', content: 'x' }], tools: TOOLS })), /tool calling/)
})

test('/v1/chat/completions with tools: tool calls pass through (plain and streamed) behind the bearer token', async () => {
  const call = { id: 'c9', type: 'function', function: { name: 'read_file', arguments: '{"path":"z"}' } }
  const adapter = { async *chat({ messages, tools }) { assert.equal(tools.length, 1); assert.equal(messages.at(-1).role, 'tool'); yield { delta: 'ok' }; yield { usage: { inputTokens: 4, outputTokens: 2 } }; yield { done: true, toolCalls: [call], finishReason: 'tool_calls' } } }
  const router = createRouter({ registry: { list: () => [prov('boa', 1, adapter)] } })
  const registry = { get: () => null, list: () => [] }
  const api = createOpenAiApi({ router, registry, file: null, flags: { get: () => false }, audit: null })
  const token = await api.token()
  const srv = http.createServer((req, res) => { api.handle(req, res).then((h) => { if (!h) { res.writeHead(404); res.end() } }) })
  await new Promise((r) => srv.listen(0, '127.0.0.1', r))
  const url = `http://127.0.0.1:${srv.address().port}/v1/chat/completions`
  const body = { messages: [{ role: 'user', content: 'leia' }, { role: 'assistant', content: null, tool_calls: [call] }, { role: 'tool', tool_call_id: 'c9', content: 'dados' }], tools: TOOLS }
  try {
    assert.equal((await fetch(url, { method: 'POST', body: JSON.stringify(body) })).status, 401)
    const h = { authorization: `Bearer ${token}`, 'content-type': 'application/json' }
    const plain = await (await fetch(url, { method: 'POST', headers: h, body: JSON.stringify(body) })).json()
    assert.equal(plain.choices[0].finish_reason, 'tool_calls')
    assert.deepEqual(plain.choices[0].message.tool_calls, [call])
    assert.equal(plain.usage.total_tokens, 6)
    const sse = await (await fetch(url, { method: 'POST', headers: h, body: JSON.stringify({ ...body, stream: true }) })).text()
    const chunks = sse.split('\n\n').filter((l) => l.startsWith('data: {')).map((l) => JSON.parse(l.slice(6)))
    assert.ok(chunks.some((c) => c.choices[0].delta.tool_calls?.[0].function.name === 'read_file'))
    assert.equal(chunks.at(-1).choices[0].finish_reason, 'tool_calls')
    assert.ok(sse.trimEnd().endsWith('[DONE]'))
  } finally { srv.close(); srv.closeAllConnections?.() }
})
