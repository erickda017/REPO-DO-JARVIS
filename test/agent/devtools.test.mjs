import test from 'node:test'
import assert from 'node:assert/strict'
import { execFileSync } from 'node:child_process'
import { existsSync, mkdirSync, mkdtempSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { createAccess } from '../../bridge/agent/access.mjs'
import { buildTools } from '../../bridge/agent/tools.mjs'
import { createMonitor } from '../../bridge/agent/monitor.mjs'
import { createMemory } from '../../bridge/agent/memoria.mjs'
import { buildProfile, personaText } from '../../bridge/agent/perfil.mjs'

async function setup() {
  const home = mkdtempSync(join(tmpdir(), 'jv-dev-'))
  const proj = join(home, 'proj')
  mkdirSync(proj)
  const env = { USERPROFILE: home, TEMP: join(home, 'Temp'), APPDATA: join(home, 'AppData'), LOCALAPPDATA: join(home, 'Local') }
  mkdirSync(env.TEMP)
  const access = createAccess({ env, systemFolders: false })
  await access.addRoot(proj)
  const memory = createMemory({ file: join(home, 'memory.jsonl') })
  const tools = buildTools({ access, monitor: createMonitor({ run: async () => null, runText: async () => '' }), profiles: {}, env, dataDir: join(home, 'data'), memory })
  return { home, proj, access, tools, memory }
}
const git = (cwd, ...a) => execFileSync('git', ['-C', cwd, '-c', 'user.name=t', '-c', 'user.email=t@t', ...a], { encoding: 'utf8' })

test('git tools: status, diff, log and a checkpoint that does not touch the working tree', async () => {
  const { proj, tools } = await setup()
  git(proj, 'init', '-q')
  writeFileSync(join(proj, 'a.txt'), 'um\n')
  git(proj, 'add', '.')
  git(proj, 'commit', '-qm', 'primeiro')
  writeFileSync(join(proj, 'a.txt'), 'um\ndois\n')
  writeFileSync(join(proj, 'novo.txt'), 'x')
  const st = (await tools.git_status.run({ path: proj })).data
  assert.equal(st.clean, false)
  assert.deepEqual(st.files.map((f) => f.path).sort(), ['a.txt', 'novo.txt'])
  const d = (await tools.git_diff.run({ path: proj })).data
  assert.match(d.diff, /\+dois/)
  const log = (await tools.git_log.run({ path: proj })).data
  assert.equal(log.commits[0].subject, 'primeiro')
  const cp = await tools.git_checkpoint.run({ path: proj, label: 'antes' })
  assert.equal(cp.verified, true)
  assert.match(git(proj, 'for-each-ref', 'refs/jarvis/checkpoints'), /checkpoints/)
  assert.equal(git(proj, 'status', '--porcelain').includes('a.txt'), true, 'working tree untouched')
})

test('project_run: runs a real command, reports the exit code honestly, refuses programs and arguments outside the allow-list', async () => {
  const { proj, tools } = await setup()
  writeFileSync(join(proj, 'ok.mjs'), 'console.log("hello-from-project")')
  writeFileSync(join(proj, 'bad.mjs'), 'console.error("boom"); process.exit(3)')
  const ok = await tools.project_run.run({ program: 'node', args: 'ok.mjs', cwd: proj })
  assert.equal(ok.data.exitCode, 0)
  assert.match(ok.data.output, /hello-from-project/)
  assert.equal(ok.verified, null, 'an exit code is not a verdict')
  const bad = await tools.project_run.run({ program: 'node', args: 'bad.mjs', cwd: proj })
  assert.equal(bad.data.exitCode, 3)
  assert.match(bad.data.output, /boom/)
  await assert.rejects(tools.project_run.run({ program: 'powershell', args: '-c calc', cwd: proj }), /programa não permitido/)
  await assert.rejects(tools.project_run.run({ program: 'node', args: ['-e', 'process.exit(0) & calc'], cwd: proj }), /argumento recusado/)
  await assert.rejects(tools.project_run.run({ program: 'npm', args: 'publish', cwd: proj }), /não é permitido/)
  await assert.rejects(tools.project_run.run({ program: 'node', args: 'ok.mjs', cwd: tmpdir() }), /fora das pastas liberadas/)
  assert.match(await tools.project_run.confirm({ program: 'node', args: 'ok.mjs', cwd: proj }), /node ok\.mjs/, 'the confirmation shows the exact command')
})

test('project_run: timeout kills a hanging process', async () => {
  const { proj, tools } = await setup()
  writeFileSync(join(proj, 'hang.mjs'), 'setInterval(() => {}, 1000)')
  const r = await tools.project_run.run({ program: 'node', args: 'hang.mjs', cwd: proj, timeoutSec: 5 })
  assert.equal(r.data.timedOut, true)
})

test('local server: start, probe over HTTP, stop; non-local URLs are refused', async () => {
  const { proj, tools } = await setup()
  const port = 20000 + Math.floor(Math.random() * 20000)
  writeFileSync(join(proj, 'srv.mjs'), `import http from 'node:http'; http.createServer((q, r) => r.end('pong')).listen(${port}, '127.0.0.1', () => console.log('listening'))`)
  const s = await tools.server_start.run({ program: 'node', args: 'srv.mjs', cwd: proj, url: `http://127.0.0.1:${port}/`, readySec: 15 })
  assert.equal(s.verified, true, s.evidence)
  const probe = (await tools.http_local.run({ url: `http://127.0.0.1:${port}/` })).data
  assert.equal(probe.status, 200)
  assert.equal(probe.body, 'pong')
  const status = (await tools.server_status.run({ id: s.data.id })).data.servers[0]
  assert.equal(status.alive, true)
  const stop = await tools.server_stop.run({ id: s.data.id })
  assert.equal(stop.verified, true, stop.evidence)
  await assert.rejects(tools.http_local.run({ url: `http://127.0.0.1:${port}/` }), /sem resposta/)
  await assert.rejects(tools.http_local.run({ url: 'http://example.com/' }), /este PC/)
  await assert.rejects(tools.server_stop.run({ id: 'srv999' }), /desconhecido/)
})

test('server_start reports a process that dies before it is ready, instead of claiming success', async () => {
  const { proj, tools } = await setup()
  writeFileSync(join(proj, 'die.mjs'), 'console.error("falhou ao subir"); process.exit(1)')
  const r = await tools.server_start.run({ program: 'node', args: 'die.mjs', cwd: proj, url: 'http://127.0.0.1:1/', readySec: 8 })
  assert.equal(r.verified, false)
  assert.match(r.data.logTail, /falhou ao subir/)
})

test('screen_capture writes a real PNG (Windows desktop session)', { skip: process.platform !== 'win32' }, async (t) => {
  const { tools } = await setup()
  let r
  try { r = await tools.screen_capture.run({}) } catch (e) { return t.skip(`sem sessão de área de trabalho: ${e.message}`) }
  assert.equal(existsSync(r.data.path), true)
  assert.ok(r.data.bytes > 5000)
  assert.equal(r.verified, true)
})

test('memory: secrets are scrubbed, a hypothesis never counts as confirmed, duplicates collapse, recall ranks by overlap, file survives a restart', async () => {
  const { home, tools, memory } = await setup()
  const secret = 'sk-ant-api03-ABCDEFGHIJKLMNOPQRSTUVWXYZ0123456789'
  const a = await memory.remember({ kind: 'error', text: `o servidor falha com EADDRINUSE quando a porta 8080 já está em uso; chave ${secret}`, tags: ['porta'] })
  assert.ok(!a.text.includes('ABCDEFGHIJ'), 'secret scrubbed')
  const h = await memory.remember({ kind: 'hypothesis', text: 'talvez o antivírus esteja bloqueando o build', confidence: 'confirmed' })
  assert.equal(h.confidence, 'unverified')
  const again = await memory.remember({ kind: 'hypothesis', text: 'talvez o antivírus esteja bloqueando o build' })
  assert.equal(again.id, h.id)
  assert.equal((await memory.recall('porta EADDRINUSE servidor'))[0].id, a.id)
  assert.deepEqual(await memory.recall('assunto totalmente diferente'), [])
  await assert.rejects(memory.remember({ kind: 'fact', text: 'curto' }), /curto demais/)
  await new Promise((r) => setTimeout(r, 100))
  const again2 = createMemory({ file: join(home, 'memory.jsonl') })
  assert.equal((await again2.recall('antivírus build')).length, 1)
  const viaTool = await tools.memory_remember.run({ kind: 'fact', text: 'o projeto usa node:test para os testes', confidence: 'confirmed', tags: ['testes'] })
  assert.equal(viaTool.verified, true)
  assert.equal((await tools.memory_recall.run({ query: 'node:test testes' })).data.items.length, 1)
})

test('profile: persona comes from the file, the live table lists every registered tool and the group state', async () => {
  const { tools, access } = await setup()
  assert.match(personaText(), /Honestidade/)
  const md = buildProfile({ tools, access })
  for (const name of Object.keys(tools)) assert.ok(md.includes(`\`${name}\``), `${name} must be listed`)
  assert.match(md, /dev — .*desligado/)
  assert.match(md, /Pastas liberadas agora: .*proj/)
  const viaTool = (await tools.jarvis_perfil.run({})).data.profile
  assert.match(viaTool, /Ferramentas AO VIVO/)
})

test('no tool can change the owner-set policy (permissions, roots, keys): the agent has no handle on them', async () => {
  const { tools } = await setup()
  const src = Object.values(tools).map((t) => `${t.name} ${t.desc}`).join(' ').toLowerCase()
  for (const forbidden of ['setTool', 'addRoot', 'setKey', 'settings']) assert.ok(!Object.keys(tools).some((n) => n.toLowerCase().includes(forbidden.toLowerCase())), forbidden)
  assert.ok(!/liberar pasta|ligar o grupo|alterar permiss/.test(src))
})
