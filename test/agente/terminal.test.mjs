import test from 'node:test'
import assert from 'node:assert/strict'
import { mkdtempSync, mkdirSync, realpathSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { terminalTools, ProcessRegistry } from '../../agente/lib/tools/terminal.mjs'
import { createApprover } from '../../agente/lib/approval.mjs'

const make = () => {
  const root = realpathSync(mkdtempSync(join(tmpdir(), 'ag-term-')))
  mkdirSync(join(root, 'sub'))
  let cwd = root
  const registry = new ProcessRegistry()
  const [terminal, proc] = terminalTools({ getCwd: () => cwd, setCwd: (c) => { cwd = c }, approver: createApprover({}), registry })
  return { root, terminal, proc, registry, cwd: () => cwd }
}

test('terminal: runs a command, reports exit code, and the working directory persists between calls', async () => {
  const { root, terminal, cwd } = make()
  const a = await terminal.run({ command: 'Write-Output olá' })
  assert.equal(a.exit_code, 0)
  assert.match(a.output, /olá/)
  const b = await terminal.run({ command: 'Set-Location sub' })
  assert.equal(b.cwd, join(root, 'sub'))
  assert.equal(cwd(), join(root, 'sub'))
  const c = await terminal.run({ command: 'exit 3' })
  assert.equal(c.exit_code, 3)
  const d = await terminal.run({ command: 'Get-Location | Select-Object -ExpandProperty Path' })
  assert.match(d.output, /sub/)
})

test('terminal: a failing native command, stderr, timeouts and blocked commands', async () => {
  const { terminal } = make()
  const e = await terminal.run({ command: 'node -e "console.error(\'boom\'); process.exit(2)"' })
  assert.equal(e.exit_code, 2)
  assert.match(e.output, /boom/)
  const t = await terminal.run({ command: 'Start-Sleep 20', timeout: 1 })
  assert.equal(t.timed_out, true)
  const h = await terminal.run({ command: 'format d:' })
  assert.equal(h.blocked, true)
  const d = await terminal.run({ command: 'rm -rf build' })
  assert.equal(d.blocked, true, 'dangerous without any way to ask is refused')
})

test('terminal: background process can be polled and killed', async () => {
  const { terminal, proc, registry } = make()
  const s = await terminal.run({ command: 'node -e "console.log(\'up\'); setInterval(()=>{},1000)"', background: true })
  assert.equal(s.running, true)
  const p = await proc.run({ action: 'poll', session_id: s.session_id })
  assert.match(p.output_tail, /up/)
  const k = await proc.run({ action: 'kill', session_id: s.session_id })
  assert.equal(k.killed, true)
  registry.killAll()
})
