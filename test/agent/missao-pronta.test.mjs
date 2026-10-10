import test from 'node:test'
import assert from 'node:assert/strict'
import { createAccess } from '../../bridge/agent/access.mjs'
import { buildTools } from '../../bridge/agent/tools.mjs'
import { createAgent } from '../../bridge/agent/agent.mjs'
import { createOrchestrator } from '../../bridge/agent/orquestrador.mjs'
import { createUiBus } from '../../bridge/agent/interface.mjs'
import { RouteError } from '../../bridge/command/errors.mjs'

const monitor = { summary: () => ({}), disks: async () => [], history: () => [], topProcesses: async () => [] }
function stack(router) {
  const access = createAccess({ file: null, systemFolders: false })
  const uiBus = createUiBus()
  const tools = buildTools({ access, monitor, profiles: { status: async () => ({}) }, env: {}, uiBus })
  const agent = createAgent({ router, tools, access, audit: null })
  const missions = createOrchestrator({ router, agent, access, dir: null })
  return { missions, uiBus, agent }
}
const done = async (missions, id) => { for (let i = 0; i < 100; i++) { const v = await missions.view(id); if (['concluido', 'parcial', 'nao_concluido', 'cancelled'].includes(v.status)) return v; await new Promise((r) => setTimeout(r, 50)) } throw new Error('a missão não terminou') }

test('missão que é um comando pronto: sem plano, sem modelo, concluída com o resultado real', async () => {
  const router = { run: async () => { throw new Error('a IA não devia ser chamada') }, runStream: () => { throw new Error('a IA não devia ser chamada') }, decide: async () => { throw new Error('nem o Jev') } }
  const { missions, uiBus } = stack(router)
  const id = (await missions.start({ goal: 'mude o tema para vermelho' })).id ?? (await missions.list())[0].id
  const v = await done(missions, id)
  assert.equal(v.status, 'concluido')
  assert.equal(uiBus.pull(0).actions[0].id, 'vermelho')
})

test('missão sem nenhuma IA disponível: falha de uma vez, sem repetir nem replanejar, e diz por quê', async () => {
  let calls = 0
  const why = new RouteError('all eligible providers failed — nenhuma IA respondeu. gemini: cota esgotada (volta em ~9 min); groq: paga', [{ provider: 'gemini', error: { kind: 'quota', message: 'x' } }])
  const router = { run: async () => { calls++; throw why }, runStream: () => { calls++; throw why }, decide: async () => { throw why } }
  const { missions } = stack(router)
  const started = await missions.start({ goal: 'compare as três pastas do projeto e escreva um relatório detalhado com sugestões de melhoria para cada uma' })
  const v = await done(missions, started.id ?? (await missions.list())[0].id)
  assert.equal(v.status, 'nao_concluido')
  assert.ok(calls <= 3, `tentativas demais: ${calls}`)
  assert.match(JSON.stringify(v), /nenhuma IA respondeu/)
})
