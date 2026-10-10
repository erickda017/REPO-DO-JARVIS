import test from 'node:test'
import assert from 'node:assert/strict'
import { mkdtempSync, readFileSync, realpathSync, writeFileSync, existsSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { createAgent } from '../../agente/lib/agent.mjs'
import { compress, estimateTokens, tailStartFor, pruneToolResults } from '../../agente/lib/compress.mjs'
import { parseArguments } from '../../agente/lib/loop.mjs'
import { buildSystemPrompt } from '../../agente/lib/prompt.mjs'

const call = (name, args, id = `c${Math.random().toString(36).slice(2, 7)}`) => ({ id, type: 'function', function: { name, arguments: typeof args === 'string' ? args : JSON.stringify(args) } })
const reply = (content, ...tool_calls) => ({ content, tool_calls })

/** A model that plays a fixed script, one reply per request, and remembers what it was asked. */
function scripted(replies) {
  const seen = []
  return {
    seen, model: 'fake',
    async *chat({ messages, tools }) {
      seen.push({ messages: structuredClone(messages), tools })
      const r = replies.shift() ?? reply('fim')
      if (r.content) yield { delta: r.content }
      yield { done: true, finishReason: r.tool_calls?.length ? 'tool_calls' : 'stop', usage: { prompt_tokens: 100, completion_tokens: 10 }, model: 'fake/m', message: { role: 'assistant', content: r.content || (r.tool_calls?.length ? null : ''), ...(r.tool_calls?.length ? { tool_calls: r.tool_calls } : {}) } }
    },
  }
}
const workspace = () => realpathSync(mkdtempSync(join(tmpdir(), 'ag-loop-')))
const mk = (llm, cwd, extra = {}) => createAgent({ llm, cwd, dataDir: join(cwd, '.data'), ...extra })

test('loop: write_file → patch → final answer; the diff and verified flag come back to the model, the history stays valid', async () => {
  const cwd = workspace()
  const llm = scripted([
    reply('Criando.', call('write_file', { path: 'a.js', content: 'const x = 1\nconsole.log(x)\n' }, 'w1')),
    reply(null, call('patch', { path: 'a.js', old_string: 'const x = 1', new_string: 'const x = 2' }, 'p1')),
    reply('Pronto: x agora vale 2.'),
  ])
  const events = []
  const agent = mk(llm, cwd, { on: (e) => events.push(e.type) })
  const r = await agent.send('crie a.js')
  assert.equal(r.text, 'Pronto: x agora vale 2.')
  assert.equal(readFileSync(join(cwd, 'a.js'), 'utf8'), 'const x = 2\nconsole.log(x)\n')
  const toolMsgs = agent.messages.filter((m) => m.role === 'tool')
  assert.equal(JSON.parse(toolMsgs[0].content).verified, true)
  assert.match(JSON.parse(toolMsgs[1].content).diff, /\+const x = 2/)
  // every tool_call has exactly one result, in order
  const ids = agent.messages.flatMap((m) => m.tool_calls?.map((c) => c.id) ?? [])
  assert.deepEqual(toolMsgs.map((m) => m.tool_call_id), ids)
  assert.ok(events.includes('tool_start') && events.includes('tool_end') && events.includes('text'))
  assert.equal(llm.seen[0].messages[0].role, 'system')
  assert.ok(llm.seen[0].tools.length >= 8)
})

test('loop: write_file refuses to clobber an existing file that was not read, and accepts it after read_file', async () => {
  const cwd = workspace()
  writeFileSync(join(cwd, 'b.txt'), 'original')
  const llm = scripted([
    reply(null, call('write_file', { path: 'b.txt', content: 'novo' }, 'w1')),
    reply(null, call('read_file', { path: 'b.txt' }, 'r1')),
    reply(null, call('write_file', { path: 'b.txt', content: 'novo' }, 'w2')),
    reply('ok'),
  ])
  const agent = mk(llm, cwd)
  await agent.send('troque o b.txt')
  const res = agent.messages.filter((m) => m.role === 'tool').map((m) => JSON.parse(m.content))
  assert.match(res[0].error, /recusado/)
  assert.equal(res[1].total_lines, 1)
  assert.equal(res[2].success, true)
  assert.equal(readFileSync(join(cwd, 'b.txt'), 'utf8'), 'novo')
})

test('loop: independent read-only calls in one turn run together; unknown tools, bad JSON and missing args become results, not crashes', async () => {
  const cwd = workspace()
  writeFileSync(join(cwd, 'one.txt'), '1'); writeFileSync(join(cwd, 'two.txt'), '2')
  const llm = scripted([
    reply(null, call('read_file', { path: 'one.txt' }, 'a'), call('read_file', { path: 'two.txt' }, 'b'), call('nao_existe', {}, 'c'), call('read_file', '{"path": ', 'd'), call('patch', { path: 'one.txt' }, 'e')),
    reply('feito'),
  ])
  const agent = mk(llm, cwd)
  await agent.send('leia')
  const res = agent.messages.filter((m) => m.role === 'tool').map((m) => m.content)
  assert.match(res[0], /1/); assert.match(res[1], /2/)
  assert.match(res[2], /Unknown tool/)
  assert.match(res[3], /not valid JSON/)
  assert.match(res[4], /missing required/)
})

test('loop: dangerous commands ask the owner; hardline never runs; a denied command comes back as an error result', async () => {
  const cwd = workspace()
  const asked = []
  const llm = scripted([
    reply(null, call('terminal', { command: 'git reset --hard' }, 't1'), call('terminal', { command: 'format d:' }, 't2')),
    reply('ok'),
  ])
  const agent = mk(llm, cwd, { confirm: async (m) => { asked.push(m); return 'deny' } })
  await agent.send('limpe')
  const res = agent.messages.filter((m) => m.role === 'tool').map((m) => JSON.parse(m.content))
  assert.equal(asked.length, 1)
  assert.match(res[0].error, /NÃO autorizou/)
  assert.match(res[1].error, /BLOQUEADO/)
})

test('loop: a text-only promise to act is pushed back once; an empty reply is retried; the final answer ends the turn', async () => {
  const cwd = workspace()
  const llm = scripted([reply('Vou criar o arquivo agora:'), reply(''), reply(null, call('write_file', { path: 'c.txt', content: 'x' }, 'w')), reply('Arquivo criado.')])
  const agent = mk(llm, cwd)
  const r = await agent.send('crie c.txt')
  assert.equal(r.text, 'Arquivo criado.')
  assert.ok(existsSync(join(cwd, 'c.txt')))
  const users = agent.messages.filter((m) => m.role === 'user').map((m) => m.content)
  assert.ok(users.some((u) => /não chamou nenhuma ferramenta/.test(u)))
  assert.ok(users.some((u) => /veio vazia/.test(u)))
})

test('loop: todo_list works and the iteration budget ends with a grace call that has no tools', async () => {
  const cwd = workspace()
  const replies = Array.from({ length: 5 }, (_, i) => reply(null, call('todo_list', { todos: [{ id: '1', content: 'passo', status: 'in_progress' }] }, `t${i}`)))
  const llm = scripted([...replies, reply('Resumo: parei no limite.')])
  const agent = mk(llm, cwd, { maxIterations: 4 })
  const r = await agent.send('faça muita coisa')
  assert.equal(r.limit, true)
  assert.equal(llm.seen.at(-1).tools, undefined, 'last call has no tools')
  assert.equal(agent.todo.read().length, 1)
})

test('interrupt: aborting mid-tool leaves a result for every call so the history can continue', async () => {
  const cwd = workspace()
  const llm = scripted([reply(null, call('terminal', { command: 'Start-Sleep 30' }, 's'), call('read_file', { path: 'x' }, 'r')), reply('depois')])
  const agent = mk(llm, cwd)
  const p = agent.send('durma')
  setTimeout(() => agent.interrupt(), 1500)
  const r = await p
  assert.equal(r.interrupted, true)
  const calls = agent.messages.flatMap((m) => m.tool_calls?.map((c) => c.id) ?? [])
  assert.deepEqual(agent.messages.filter((m) => m.role === 'tool').map((m) => m.tool_call_id), calls)
  agent.dispose()
})

test('parseArguments repairs fences and trailing commas; rejects non-objects', () => {
  assert.deepEqual(parseArguments('```json\n{"a":1}\n```').value, { a: 1 })
  assert.deepEqual(parseArguments('{"a":1,}').value, { a: 1 })
  assert.equal(parseArguments('[1]').ok, false)
  assert.deepEqual(parseArguments('').value, {})
})

test('compression: old tool results are pruned first; a long conversation is summarised keeping the first task and the tail; pairs are never split', async () => {
  const big = 'x'.repeat(5000)
  const messages = [{ role: 'user', content: 'TAREFA ORIGINAL' }]
  for (let i = 0; i < 30; i++) {
    messages.push({ role: 'assistant', content: null, tool_calls: [call('read_file', { path: `f${i}` }, `id${i}`)] })
    messages.push({ role: 'tool', tool_call_id: `id${i}`, content: big })
  }
  messages.push({ role: 'assistant', content: 'quase lá' }, { role: 'user', content: 'continue' })
  const end = tailStartFor(messages, 2000)
  assert.notEqual(messages[end].role, 'tool')
  const pr = pruneToolResults(messages, end)
  assert.ok(pr.pruned > 10)
  assert.ok(estimateTokens(pr.messages) < estimateTokens(messages) / 3)
  const llm = { async *chat() { yield { delta: '## Active Task\ncontinuar\n\n## Goal\n' + 'resumo '.repeat(30) } } }
  const r = await compress({ messages, llm, todoText: '[Your active task list was preserved across context compression]\n- [>] 1. passo (in_progress)', tailTokens: 2000, force: true })
  assert.equal(r.mode, 'summarized')
  assert.match(r.messages[0].content, /TAREFA ORIGINAL/)
  assert.match(r.messages[0].content, /CONTEXT COMPACTION/)
  assert.match(r.messages[0].content, /active task list was preserved/)
  assert.equal(r.messages.at(-1).content, 'continue')
  assert.ok(r.after < r.before)
  const ids = new Set(r.messages.flatMap((m) => m.tool_calls?.map((c) => c.id) ?? []))
  for (const m of r.messages.filter((x) => x.role === 'tool')) assert.ok(ids.has(m.tool_call_id), 'no orphan tool result')
  const failing = { async *chat() { throw new Error('modelo fora') } }
  const f = await compress({ messages, llm: failing, tailTokens: 2000, force: true })
  assert.equal(f.mode, 'fallback')
  assert.match(f.messages[0].content, /Completed Actions/)
})

test('system prompt: stable, carries the Hermes guidance blocks, the environment and the project instructions', () => {
  const cwd = workspace()
  writeFileSync(join(cwd, 'AGENTS.md'), 'Use tabs.')
  const a = buildSystemPrompt({ cwd, toolNames: ['terminal', 'read_file'], skills: [{ name: 'x', description: 'y' }], memory: '- nota' })
  for (const s of ['Tool-use enforcement', 'Execution discipline', 'Finishing the job', 'Parallel tool calls', 'Use tabs.', '- x: y', '- nota', cwd]) assert.ok(a.includes(s), s)
  assert.equal(a, buildSystemPrompt({ cwd, toolNames: ['terminal', 'read_file'], skills: [{ name: 'x', description: 'y' }], memory: '- nota' }).replace(/x/g, 'x'))
})
