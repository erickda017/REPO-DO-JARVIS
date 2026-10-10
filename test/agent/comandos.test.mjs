import test from 'node:test'
import assert from 'node:assert/strict'
import { mkdtempSync, mkdirSync, realpathSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { quickAction as q, extractPath } from '../../bridge/agent/comandos.mjs'
import { themeInText, findView, findToggle, createUiBus } from '../../bridge/agent/interface.mjs'

const is = (text, tool, args) => { const r = q(text); assert.ok(r, `sem comando: ${text}`); assert.equal(r.tool, tool, text); if (args) assert.deepEqual(r.args, args, text) }
const no = (text) => assert.equal(q(text), null, `devia ir para a IA: ${text}`)

test('temas: cores em português, vários jeitos de pedir', () => {
  is('mude o tema para vermelho', 'interface_theme', { theme: 'vermelho' })
  is('Jarvis, coloca o visual em roxo', 'interface_theme', { theme: 'roxo' })
  is('deixa tudo rosa', 'interface_theme', { theme: 'rosa' })
  is('tema lilás', 'interface_theme', { theme: 'lilas' })
  is('troque a cor para magenta por favor', 'interface_theme', { theme: 'magenta' })
  is('quero a interface dourada', 'interface_theme', { theme: 'ambar' })
  is('volte para o azul padrão, mude o tema', 'interface_theme', { theme: 'azul' })
  is('quais temas existem?', 'interface_state')
  assert.equal(themeInText('fica verde')?.id, 'verde')
  no('o céu é azul por causa de quê?') // sem verbo de mudança nem "tema"
  no('crie um relatório sobre a cor vermelha em marketing e depois envie')
})

test('telas e chaves da interface', () => {
  is('abra a tela de conectores', 'interface_view', { view: 'connectors' })
  is('vá para missões', 'interface_view', { view: 'missions' })
  is('mostre as ias', 'ia_card')
  is('abre o sistema', 'interface_view', { view: 'system' })
  is('ligue só apis', 'interface_set', { key: 'apisOnly', value: true })
  is('desligue a voz', 'interface_set', { key: 'speak', value: false })
  is('ative o autorizo gasto', 'interface_set', { key: 'spend', value: true })
  assert.equal(findView('IA local').id, 'ia')
  assert.equal(findToggle('só as apis'), 'apisOnly')
  is('abra o discord', 'app_open') // não é uma tela: continua sendo abrir app
})

test('informações sem IA: hora, sistema, processos, rede', () => {
  is('que horas são?', 'clock_now')
  is('que dia é hoje', 'clock_now')
  is('como está o meu pc', 'system_card')
  is('quanta ram eu estou usando', 'system_card')
  is('o que está consumindo mais memória?', 'sys_top')
  is('qual a temperatura', 'sys_temperature')
  is('qual é o meu ip', 'network_info')
  const t = q('que horas são').say({ data: { hora: '18:42', data: 'sábado, 10 de outubro de 2026' } })
  assert.match(t, /18:42/)
})

test('ações do PC: volume, mídia, print, bloqueio, lixeira, energia, pastas', () => {
  is('volume 40', 'volume_control', { action: 'set', level: 40 })
  is('coloca o volume no máximo', 'volume_control', { action: 'set', level: 100 })
  is('aumenta o volume', 'volume_control', { action: 'up' })
  is('abaixa o volume', 'volume_control', { action: 'down' })
  is('muta o som', 'volume_control', { action: 'mute' })
  is('pausa a música', 'media_key', { key: 'play_pause' })
  is('próxima música', 'media_key', { key: 'next' })
  is('tire um print da tela', 'screenshot')
  is('bloqueie o computador', 'lock_pc')
  is('esvazie a lixeira', 'recycle_empty')
  is('limpe os arquivos temporários', 'temp_clean')
  is('desligue o pc em 10 minutos', 'power_action', { action: 'shutdown', delaySec: 600 })
  is('reinicie o computador', 'power_action', { action: 'restart' })
  is('cancele o desligamento', 'power_action', { action: 'cancel' })
  is('abra a pasta downloads', 'folder_open', { where: 'downloads' })
  is('abra o yt music', 'url_open')
  is('procure gatos engraçados no youtube', 'url_open')
  assert.match(q('procure gatos engraçados no youtube').args.url, /results\?search_query=gatos/)
})

test('analisar pasta: o caminho com espaços é achado e a frase vai para a ferramenta, sem IA', () => {
  const root = realpathSync(mkdtempSync(join(tmpdir(), 'cmd-')))
  const dir = join(root, 'A protecao', 'SessionGuard')
  mkdirSync(dir, { recursive: true })
  assert.equal(extractPath(`Analisa a pasta em ${dir} e me diga do que se trata`), dir)
  const r = q(`Analisa a pasta em ${dir} e me diga do que se trata`)
  assert.equal(r?.tool, 'project_overview')
  assert.equal(r.args.path, dir)
  assert.match(r.say({ data: { resumo: 'SessionGuard: projeto Node.js', maioresArquivos: [{ arquivo: 'src/a.js' }] } }), /SessionGuard/)
  assert.equal(q('analise a pasta de downloads e depois apague tudo'), null, 'duas partes: vai para a IA')
})

test('o que não é comando vai para a IA', () => {
  no('explique como funciona o protocolo TCP')
  no('escreva uma função que ordena uma lista')
  no('abra o chrome e pesquise gatos')
  no('')
})

test('ponte da interface: ações vão para uma fila que a janela lê por número de sequência', () => {
  const bus = createUiBus()
  const a = bus.push({ type: 'theme', id: 'roxo' })
  bus.push({ type: 'view', id: 'ais' })
  assert.deepEqual(bus.pull(0).actions.map((x) => x.type), ['theme', 'view'])
  assert.deepEqual(bus.pull(a).actions.map((x) => x.type), ['view'])
  bus.report({ theme: 'roxo', view: 'ais' })
  assert.equal(bus.state.theme, 'roxo')
})
