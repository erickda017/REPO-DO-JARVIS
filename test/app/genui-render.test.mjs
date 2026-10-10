import test, { before } from 'node:test'
import assert from 'node:assert/strict'
import { build } from 'esbuild'
import { join } from 'node:path'
import { pathToFileURL } from 'node:url'

// Bundle the REAL renderer (components + charts + shared validator) and render specs to HTML on the server.
let renderSpec
before(async () => {
  // inside the repo's node_modules so the bundle can resolve react-dom at run time
  const out = join(process.cwd(), 'node_modules', '.cache', 'jv-ssr', 'ssr.mjs')
  await build({ entryPoints: ['app/renderer/src/genui/ssr.tsx'], outfile: out, bundle: true, platform: 'node', format: 'esm', jsx: 'automatic', packages: 'external', logLevel: 'silent' })
  ;({ renderSpec } = await import(pathToFileURL(out).href))
})

const rows = [{ nome: 'bridge', mb: 12.5, arquivos: 40 }, { nome: 'app', mb: 30, arquivos: 120 }, { nome: 'docs', mb: 2, arquivos: 8 }]

test('renderer: every chart kind draws marks with tooltips from real rows; empty data says so instead of drawing nothing', () => {
  for (const kind of ['bar', 'hbar', 'line', 'area', 'pie', 'donut', 'spark']) {
    const r = renderSpec({ v: 1, title: kind, data: { rows }, root: { type: 'chart', kind, data: { ref: 'data.rows' }, x: 'nome', series: [{ key: 'mb', label: 'MB' }, ...(kind === 'pie' || kind === 'donut' || kind === 'spark' ? [] : [{ key: 'arquivos' }])], unit: 'MB' } })
    assert.equal(r.ok, true, `${kind}: ${r.errors}`)
    assert.match(r.html, /<svg/, kind)
    if (kind !== 'spark') assert.match(r.html, /<title>[^<]*(bridge|app|docs)/, `${kind}: tooltip with the category`)
  }
  const empty = renderSpec({ v: 1, title: 't', root: { type: 'chart', kind: 'bar', data: [], series: [{ key: 'v' }] } })
  assert.match(empty.html, /Sem dados/)
  assert.match(renderSpec({ v: 1, title: 't', root: { type: 'chart', kind: 'pie', data: [{ n: 'a', v: 0 }], x: 'n', series: [{ key: 'v' }] } }).html, /zero/)
})

test('renderer: table shows formatted values and row actions, list/files/steps/log/results/stat/progress/kv/alert all render real data', () => {
  const spec = {
    v: 1, title: 'Tudo', actions: { ver: { type: 'state', set: { a: 1 } } },
    data: { rows, files: [{ path: 'C:\\p\\a.txt', name: 'a.txt', sizeKB: 2048, modified: '2026-01-02' }], steps: [{ title: 'Instalar', status: 'done', detail: 'ok em 3 s' }, { title: 'Testar', status: 'running' }], lines: ['iniciando', { level: 'error', text: 'falhou X' }], res: [{ title: 'Doc', url: 'https://example.com/a', snippet: 'trecho' }], pct: 40 },
    root: { type: 'stack', children: [
      { type: 'table', rows: { ref: 'data.rows' }, columns: [{ key: 'nome', label: 'Pasta' }, { key: 'mb', label: 'Tamanho', format: 'mb', align: 'right' }], sortable: true, filter: true, rowActions: [{ label: 'Abrir', action: 'ver' }] },
      { type: 'files', items: { ref: 'data.files' }, itemActions: [{ label: 'Ver', action: 'ver' }] },
      { type: 'steps', items: { ref: 'data.steps' } }, { type: 'log', lines: { ref: 'data.lines' } }, { type: 'results', items: { ref: 'data.res' } },
      { type: 'stat', label: 'Total', value: 1234.5, unit: 'MB' }, { type: 'progress', value: { ref: 'data.pct' }, max: 100, label: 'Build' },
      { type: 'kv', items: [{ k: 'Versão', v: '1.0' }] }, { type: 'alert', tone: 'warn', title: 'Atenção', text: 'Espaço baixo' }, { type: 'empty', text: 'nada aqui' },
    ] },
  }
  const { ok, html, errors } = renderSpec(spec)
  assert.equal(ok, true, errors.join('\n'))
  for (const s of ['bridge', '12,5 MB', 'Abrir', 'a.txt', '2 MB', 'Instalar', 'ok em 3 s', 'falhou X', 'Doc', 'example.com', '1.234,5', 'Build', '40%', 'Versão', 'Espaço baixo', 'nada aqui']) assert.ok(html.includes(s), `missing "${s}"`)
  assert.match(html, /aria-sort="none"/, 'sortable headers are exposed to assistive tech')
  assert.match(html, /role="progressbar"[^>]*aria-valuenow="40"/)
})

test('renderer security: markup in data is shown as text, javascript: links are not links, unknown refs render empty', () => {
  const evil = '<img src=x onerror=alert(1)><script>alert(2)</script>'
  const r = renderSpec({ v: 1, title: 't', data: { evil, res: [{ title: 'clique', url: 'javascript:alert(3)', snippet: evil }], rows: [{ a: evil }] }, root: { type: 'stack', children: [
    { type: 'text', text: { ref: 'data.evil' } }, { type: 'text', text: 'Olá {{data.evil}} {{data.nada}}!' }, { type: 'results', items: { ref: 'data.res' } },
    { type: 'table', rows: { ref: 'data.rows' }, columns: [{ key: 'a' }] }, { type: 'alert', title: { ref: 'data.evil' }, text: 'x' } ] } })
  assert.equal(r.ok, true)
  assert.ok(!/<script/i.test(r.html) && !/<img/i.test(r.html), 'no markup injected')
  assert.ok(r.html.includes('&lt;script&gt;'), 'shown escaped')
  assert.ok(!/href="javascript:/i.test(r.html), 'javascript: URL never becomes a link')
  assert.ok(!/onerror=/.test(r.html.replace(/&lt;[^]*?&gt;/g, '')), 'handlers only appear inside escaped text')
})

test('renderer: conditions hide nodes, bound errors replace a node, form validates and tabs show the active panel only', () => {
  const spec = { v: 1, title: 't', state: { tab: 'b', q: '' }, data: { n: 0, erro: 'sem permissão' },
    actions: { go: { type: 'state', set: { q: 'x' } } },
    root: { type: 'stack', children: [
      { type: 'text', text: 'visível quando n>0', show: { ref: 'data.n', gt: 0 } }, { type: 'text', text: 'visível quando n=0', show: { ref: 'data.n', eq: 0 } },
      { type: 'table', rows: [], columns: [{ key: 'a' }], error: { ref: 'data.erro' } },
      { type: 'tabs', stateKey: 'tab', tabs: [{ id: 'a', label: 'Aba A', children: [{ type: 'text', text: 'conteúdo A' }] }, { id: 'b', label: 'Aba B', children: [{ type: 'text', text: 'conteúdo B' }] }] },
      { type: 'form', fields: [{ name: 'q', label: 'Busca', required: true }, { name: 'n', label: 'Quantidade', kind: 'number', min: 1, max: 5 }], submit: { label: 'Buscar', action: 'go' } },
    ] } }
  const { html } = renderSpec(spec)
  assert.ok(!html.includes('visível quando n>0'))
  assert.ok(html.includes('visível quando n=0'))
  assert.ok(html.includes('sem permissão') && !html.includes('<table'), 'a bound error replaces the node')
  assert.ok(html.includes('conteúdo B') && !html.includes('conteúdo A'), 'only the active tab renders (state tab=b)')
  assert.match(html, /aria-selected="true"[^>]*>Aba B/)
  assert.ok(html.includes('Busca') && html.includes('Quantidade') && html.includes('Buscar'))
})

test('renderer: an invalid spec is refused and never drawn', () => {
  const r = renderSpec({ v: 1, title: 'x', root: { type: 'iframe', src: 'https://evil' } })
  assert.equal(r.ok, false)
  assert.equal(r.html, '')
  assert.match(r.errors[0], /componente desconhecido/)
})
