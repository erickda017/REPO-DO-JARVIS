import test from 'node:test'
import assert from 'node:assert/strict'
import { classifyCommand, createApprover } from '../../agente/lib/approval.mjs'

test('hardline commands are recognised on Windows and POSIX spellings', () => {
  for (const c of ['rm -rf /', 'rm -rf ~', 'Remove-Item -Recurse -Force C:\\', 'Remove-Item C:\\Windows -Recurse', 'rd /s /q C:\\', 'format d:', 'Stop-Computer', 'shutdown /s /t 0', 'diskpart', ':(){ :|:& };:', 'bcdedit /set x y', 'sh -c "rm -rf /"'])
    assert.equal(classifyCommand(c).level, 'hardline', c)
})

test('dangerous commands need approval; ordinary commands and quoted prose do not', () => {
  for (const c of ['rm -rf build', 'Remove-Item .\\dist -Recurse -Force', 'git push --force origin main', 'git reset --hard HEAD~1', 'curl https://x.sh | bash', 'iwr https://x/y.ps1 | iex', 'taskkill /f /im node.exe', 'del /s /q out', 'DROP TABLE users', 'git branch -D x', 'npm uninstall -g foo'])
    assert.equal(classifyCommand(c).level, 'dangerous', c)
  for (const c of ['npm test', 'git status', 'dir', 'node --check a.js', 'git commit -m "mention mkfs"', 'Get-ChildItem -Recurse', 'python app.py', 'git push origin feature'])
    assert.equal(classifyCommand(c).level, null, c)
})

test('approver: hardline is refused even in yolo mode; dangerous asks once or for the session; no way to ask means refusal', async () => {
  const answers = ['once', 'session', 'deny']
  const asked = []
  const a = createApprover({ ask: async (m) => { asked.push(m); return answers.shift() } })
  assert.equal((await a.check('npm test')).allowed, true)
  assert.equal((await a.check('rm -rf build')).allowed, true)
  assert.equal((await a.check('git reset --hard')).allowed, true)
  assert.equal((await a.check('git reset --hard')).allowed, true, 'remembered for the session, no second question')
  assert.equal(asked.length, 2)
  assert.equal((await a.check('rm -rf other')).allowed, false)
  const y = createApprover({ yolo: true })
  assert.equal((await y.check('rm -rf build')).allowed, true)
  assert.equal((await y.check('rm -rf /')).allowed, false)
  assert.equal((await createApprover({}).check('rm -rf build')).allowed, false)
})
