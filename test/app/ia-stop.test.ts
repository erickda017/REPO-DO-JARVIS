import test from 'node:test'
import assert from 'node:assert/strict'
import { spawn, type ChildProcess } from 'node:child_process'
import { copyFileSync, mkdirSync, mkdtempSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { iaStatus, iaStop } from '../../app/electron/ia.ts'

// A fake "local AI" folder whose PARAR_IA.bat does NOTHING (the failing case the owner hit), with real processes listening on spare ports.
const PORTS = { chat: 18080, pesado: 18081, leve: 18082 }
function fakeRoot() {
  const root = mkdtempSync(join(tmpdir(), 'jv-ia-'))
  mkdirSync(join(root, 'llama'))
  copyFileSync(process.execPath, join(root, 'llama', 'llama-server.exe')) // same name as the real one, so the safety filter treats it as the AI
  writeFileSync(join(root, 'modos.ini'), '')
  writeFileSync(join(root, '_iniciar.bat'), '@echo off\r\nset MODELO_LEVE=modelos\\x.gguf\r\n')
  writeFileSync(join(root, 'PARAR_IA.bat'), '@echo off\r\nexit /b\r\n')
  return root
}
const listenScript = (port: number) => `require('net').createServer().listen(${port},'127.0.0.1');setInterval(()=>{},1000)`
const startLlama = (root: string, port: number) => spawn(join(root, 'llama', 'llama-server.exe'), ['-e', listenScript(port)], { stdio: 'ignore', windowsHide: true })
const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms))
const until = async (fn: () => Promise<boolean>, ms = 8000) => { const t = Date.now(); while (!(await fn())) { if (Date.now() - t > ms) throw new Error('timeout'); await sleep(100) } }
const alive = (p: ChildProcess) => p.exitCode === null && p.signalCode === null
const killAll = (...ps: (ChildProcess | undefined)[]) => { for (const p of ps) { try { if (p?.pid) spawn('taskkill', ['/pid', String(p.pid), '/T', '/F'], { stdio: 'ignore' }) } catch { /* gone */ } } }

test('stop: when PARAR_IA.bat misses, the ports are checked and the AI processes are force-killed', async () => {
  const root = fakeRoot()
  const leve = startLlama(root, PORTS.leve)
  const chat = startLlama(root, PORTS.chat)
  try {
    await until(async () => (await iaStatus(root, PORTS)).ports.leve && (await iaStatus(root, PORTS)).ports.chat)
    const st = await iaStop(root, { ports: PORTS, settleMs: 400 })
    assert.equal(st.error, undefined, 'no error: it really is off')
    assert.deepEqual(st.ports, { chat: false, pesado: false, leve: false })
    await until(async () => !alive(leve) && !alive(chat), 3000)
  } finally {
    killAll(leve, chat)
  }
})

test('stop: a program that is NOT the local AI is never killed; the error names it', async () => {
  const root = fakeRoot()
  const stranger = spawn(process.execPath, ['-e', listenScript(PORTS.chat)], { stdio: 'ignore', windowsHide: true }) // plain node, not under the AI folder
  try {
    await until(async () => (await iaStatus(root, PORTS)).ports.chat)
    const st = await iaStop(root, { ports: PORTS, settleMs: 300 })
    assert.match(st.error ?? '', /porta 18080/)
    assert.match(st.error ?? '', /não é da IA local/)
    assert.ok(alive(stranger), 'an unrelated process on the same port survives')
    assert.equal(st.ports.chat, true)
  } finally {
    killAll(stranger)
  }
})

test('stop: something that brings the model back is reported instead of claiming success', async () => {
  const root = fakeRoot()
  // A supervisor living under the AI folder that restarts the model whenever it dies (the case where "it stays up").
  const supervisor = spawn(process.execPath, ['-e', `
    const { spawn } = require('child_process'); let c;
    const up = () => { c = spawn(${JSON.stringify(join(root, 'llama', 'llama-server.exe'))}, ['-e', ${JSON.stringify(listenScript(PORTS.leve))}], { stdio: 'ignore', windowsHide: true }); c.on('exit', () => setTimeout(up, 200)) };
    up(); setInterval(() => {}, 1000)`, join(root, 'supervisor-marker')], { stdio: 'ignore', windowsHide: true })
  try {
    await until(async () => (await iaStatus(root, PORTS)).ports.leve)
    const st = await iaStop(root, { ports: PORTS, settleMs: 350 })
    assert.match(st.error ?? '', /religou sozinho|Não consegui desligar/)
    assert.match(st.error ?? '', /porta 18082/)
  } finally {
    killAll(supervisor)
    await sleep(500)
    killAll(supervisor)
  }
})
