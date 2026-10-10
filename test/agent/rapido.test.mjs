import test from 'node:test'
import assert from 'node:assert/strict'
import { quickAction } from '../../bridge/agent/rapido.mjs'

test('quickAction: direct "open X" becomes a tool call; anything compound, vague or about files goes to the model', () => {
  assert.deepEqual(quickAction('abra o navegador'), { tool: 'app_open', args: { name: 'Google Chrome|Microsoft Edge|Firefox|Brave|Opera' }, then: 'Abri o navegador.' })
  assert.equal(quickAction('Jarvis, abre o Discord por favor').args.name, 'Discord')
  assert.equal(quickAction('abrir o bloco de notas.').args.name, 'bloco de notas')
  assert.deepEqual(quickAction('abra o youtube'), { tool: 'url_open', args: { url: 'https://www.youtube.com' }, then: 'Abri o youtube.' })
  assert.equal(quickAction('abre github.com/foo').args.url, 'https://github.com/foo')
  for (const no of ['abra o chrome e pesquise gatos', 'abra a pasta downloads', 'abra o arquivo notas.txt', 'liste meus arquivos', 'o que é abrir uma conta?', 'abra', 'abra o chrome, depois o discord', '']) assert.equal(quickAction(no), null, no)
})
