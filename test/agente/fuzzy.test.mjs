import test from 'node:test'
import assert from 'node:assert/strict'
import { fuzzyFindAndReplace as f, noMatchHint } from '../../agente/lib/fuzzy.mjs'
import { ratio, opcodes } from '../../agente/lib/difflib.mjs'

test('difflib port: ratio and opcodes agree with Python on known cases', () => {
  assert.equal(ratio('abcd', 'bcde'), 0.75)
  assert.equal(ratio('', ''), 1)
  assert.deepEqual(opcodes('qabxcd', 'abycdf'), [['delete', 0, 1, 0, 0], ['equal', 1, 3, 0, 2], ['replace', 3, 4, 2, 3], ['equal', 4, 6, 3, 5], ['insert', 6, 6, 5, 6]])
})

test('fuzzy edit: exact match, unique requirement, replace_all, identical/empty guards', () => {
  const src = 'a = 1\nb = 2\nb = 2\n'
  assert.deepEqual([f(src, 'a = 1', 'a = 9').content, f(src, 'a = 1', 'a = 9').strategy], ['a = 9\nb = 2\nb = 2\n', 'exact'])
  assert.match(f(src, 'b = 2', 'b = 3').error, /Found 2 matches/)
  assert.equal(f(src, 'b = 2', 'b = 3', true).content, 'a = 1\nb = 3\nb = 3\n')
  assert.match(f(src, 'a = 1', 'a = 1').error, /identical/)
  assert.match(f(src, '', 'x').error, /empty/)
  assert.match(f(src, '   ', 'x').error, /whitespace/)
})

test('fuzzy edit: indentation and whitespace drift still land, and the replacement is re-indented to the file', () => {
  const src = 'function f() {\n    if (x) {\n        run()\n    }\n}\n'
  const r = f(src, 'if (x) {\n  run()\n}', 'if (x) {\n  run()\n  log()\n}')
  assert.equal(r.error, null)
  assert.match(r.strategy, /line_trimmed|indentation_flexible/)
  assert.equal(r.content, 'function f() {\n    if (x) {\n      run()\n      log()\n    }\n}\n') // like Hermes: only the BASE indent is re-anchored, relative nesting is the model's
  const ws = f('const  a  =   1;\n', 'const a = 1;', 'const a = 2;')
  assert.equal(ws.strategy, 'whitespace_normalized')
  assert.equal(ws.content, 'const a = 2;\n')
})

test('fuzzy edit: typographic quotes in the file are matched and kept; block anchors tolerate a changed middle', () => {
  const src = 'say(“oi”)\nnext()\n'
  const r = f(src, 'say("oi")', 'say("tchau")')
  assert.equal(r.strategy, 'unicode_normalized')
  assert.equal(r.content.startsWith('say('), true)
  const code = 'start()\n  middle one two three\nend()\n'
  const b = f(code, 'start()\n  middle one two thre\nend()', 'start()\nend()')
  assert.equal(b.error, null)
  assert.equal(b.content, 'start()\nend()\n')
})

test('fuzzy edit: no match gives a "did you mean" with the closest lines and whitespace hint; escape drift is refused', () => {
  const src = 'def alpha():\n\treturn 1\n'
  const r = f(src, 'def gamma_total():\n    return 99', 'x')
  assert.match(r.error, /Could not find/)
  assert.match(noMatchHint(r.error, r.count, 'def gamma_total():\n    return 99', src), /Did you mean/)
  const lit = f('line one\nline two\n', 'line one\\nline two', 'line one\\nline 2')
  assert.match(lit.error ?? '', /Escape-drift|^$/)
})
