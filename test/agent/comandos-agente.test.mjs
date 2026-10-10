import test from 'node:test'
import assert from 'node:assert/strict'
import { createAccess } from '../../bridge/agent/access.mjs'
import { buildTools } from '../../bridge/agent/tools.mjs'
import { createAgent } from '../../bridge/agent/agent.mjs'
import { createUiBus } from '../../bridge/agent/interface.mjs'

const monitor = { summary: () => ({ cpu: { usagePct: 12 }, memory: { usedGB: 8, totalGB: 16, freeGB: 8, usedPct: 50 }, uptimeHours: 3.5 }), disks: async () => [{ drive: 'C:', totalGB: 500, freeGB: 120, usedGB: 380, freePct: 24 }], history: () => [], topProcesses: async () => [] }
const settings = { flags: { get: () => false }, setFlag: async () => {}, setProvider: async () => {} }
const health = { snapshot: () => [{ id: 'gemini', label: 'Google Gemini', enabled: true, paid: false, external: true, model: 'm', status: { endpoint: { state: 'ok' }, model: { state: 'ok' } }, recentErrors: [] }, { id: 'groq', label: 'Groq', enabled: false, paid: true, external: true, model: null, status: null, recentErrors: [] }] }

function setup(confirm) {
  const access = createAccess({ file: null, systemFolders: false })
  const uiBus = createUiBus()
  const tools = buildTools({ access, monitor, profiles: { status: async () => ({}) }, env: { USERPROFILE: 'C:\\Users\\x' }, uiBus, getIa: () => ({ health, settings }) })
  const router = { runStream: () => { throw new Error('a IA não devia ser chamada') }, run: async () => { throw new Error('a IA não devia ser chamada') } }
  const agent = createAgent({ router, tools, access, audit: null, clock: () => Date.now() })
  return { agent, uiBus, tools, access, confirm }
}
const finish = async (agent, id) => { const v = await agent.wait(id); return v }

test('comando pronto: "que horas são" responde sem chamar a IA, com dados reais da ferramenta', async () => {
  const { agent } = setup()
  const v = await finish(agent, agent.run({ text: 'que horas são?' }))
  assert.equal(v.result.status, 'concluido')
  assert.match(v.result.text, /Agora são \d{1,2}:\d{2}/)
  assert.equal(v.usage.calls, 0, 'nenhuma chamada de modelo')
  assert.equal(v.models[0], 'atalho/sem modelo')
})

test('comando pronto: mudar o tema vai para a fila da interface; telas e chaves também; cartão do sistema sai dos números medidos', async () => {
  const { agent, uiBus } = setup()
  for (const text of ['mude o tema para roxo', 'abra a tela de conectores', 'desligue a voz', 'como está o meu pc']) {
    const v = await finish(agent, agent.run({ text }))
    assert.equal(v.result.status, 'concluido', text)
  }
  const acts = uiBus.pull(0).actions
  assert.deepEqual(acts.filter((a) => a.type !== 'card').map((a) => [a.type, a.id ?? a.key]), [['theme', 'roxo'], ['view', 'connectors'], ['set', 'speak']])
  const card = acts.find((a) => a.type === 'card')
  assert.equal(card.title, 'Sistema agora')
  assert.ok(card.body.rows.some((r) => r.label === 'Disco C:' && /120 GB/.test(r.value)))
})

test('comando pronto: a lista de IAs não gasta IA; um tema inexistente cai para a IA (e a ferramenta recusa com os nomes)', async () => {
  const { agent, tools } = setup()
  const v = await finish(agent, agent.run({ text: 'quais são as minhas ias' }))
  assert.match(v.result.text, /1 IA\(s\) em uso/)
  await assert.rejects(tools.interface_theme.run({ theme: 'xablau' }), /tema desconhecido/)
})

test('ferramentas de risco pedem confirmação mesmo sendo comando pronto (desligar o PC)', async () => {
  const { agent } = setup()
  const id = agent.run({ text: 'desligue o pc em 5 minutos' })
  await new Promise((r) => setTimeout(r, 150))
  const view = agent.view(id)
  assert.equal(view.status, 'awaiting')
  assert.match(view.pending.message, /DESLIGAR/)
  agent.confirm(view.pending.id, false)
  const v = await finish(agent, id)
  assert.notEqual(v.result.status, 'concluido')
})
