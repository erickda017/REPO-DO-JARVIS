import test from 'node:test'
import assert from 'node:assert/strict'
import { THEMES, tokens, sceneColors, themeById } from '../../app/renderer/src/theme.ts'

const rgb = (c: string): [number, number, number] => {
  if (c.startsWith('#')) return [parseInt(c.slice(1, 3), 16), parseInt(c.slice(3, 5), 16), parseInt(c.slice(5, 7), 16)]
  const m = /(\d+),\s*(\d+),\s*(\d+)/.exec(c)!
  return [Number(m[1]), Number(m[2]), Number(m[3])]
}
const lum = ([r, g, b]: number[]) => { const f = (x: number) => { const s = x / 255; return s <= 0.03928 ? s / 12.92 : ((s + 0.055) / 1.055) ** 2.4 }; return 0.2126 * f(r) + 0.7152 * f(g) + 0.0722 * f(b) }
const contrast = (a: string, b: string) => { const [x, y] = [lum(rgb(a)), lum(rgb(b))].sort((p, q) => q - p); return (x + 0.05) / (y + 0.05) }

test('every theme defines every variable the stylesheet reads, and the blue theme is the original palette', () => {
  const need = ['--bg', '--bg-2', '--bg-deep', '--bg-term', '--bg-mid', '--panel', '--panel-solid', '--line', '--line-strong', '--cyan', '--cyan-hi', '--text', '--dim', '--acc', '--d1-rgb', '--d2-rgb', '--d3-rgb']
  for (const t of THEMES) for (const k of need) assert.ok(tokens(t.id)[k], `${t.id} ${k}`)
  assert.equal(tokens('azul')['--cyan'], '#4fd8ff')
  assert.equal(tokens('azul')['--acc'], '79, 216, 255')
  assert.equal(themeById('inexistente').id, 'azul')
  assert.equal(new Set(THEMES.map((t) => t.id)).size, THEMES.length)
})

test('legibility: text, dim text and the accent keep their contrast against the background in every theme', () => {
  for (const t of THEMES) {
    const k = tokens(t.id)
    assert.ok(contrast(k['--text'], k['--bg']) >= 10, `${t.id} text/bg ${contrast(k['--text'], k['--bg']).toFixed(1)}`)
    assert.ok(contrast(k['--dim'], k['--bg']) >= 5, `${t.id} dim/bg ${contrast(k['--dim'], k['--bg']).toFixed(1)}`)
    assert.ok(contrast(k['--cyan'], k['--bg']) >= 7, `${t.id} accent/bg ${contrast(k['--cyan'], k['--bg']).toFixed(1)}`)
    assert.ok(contrast(k['--cyan'], k['--panel-solid']) >= 6, `${t.id} accent/panel`)
  }
})

test('the themes are really different colours (hue of the accent differs by theme)', () => {
  const accents = THEMES.map((t) => tokens(t.id)['--cyan'])
  assert.equal(new Set(accents).size, THEMES.length)
  const c = sceneColors('vermelho')
  assert.ok(c.hot[0] > c.hot[2] && c.hot[0] > c.hot[1], 'the red theme glows red')
  const v = sceneColors('verde')
  assert.ok(v.hot[1] > v.hot[0] && v.hot[1] > v.hot[2], 'the green theme glows green')
})
