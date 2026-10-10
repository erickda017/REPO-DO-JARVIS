// Colour themes. The whole interface reads a handful of CSS variables (see :root in styles.css); a theme is just a hue and
// two tuning numbers, turned into those variables here. The 3D scene reads the same numbers through sceneColors().
// The ids must match bridge/agent/interface.mjs (the agent changes the theme by id).

export interface Theme { id: string; label: string; hue: number; sat: number; light: number; swatch: string }

export const THEMES: Theme[] = [
  { id: 'azul', label: 'Azul', hue: 193, sat: 100, light: 65, swatch: '#4fd8ff' },
  { id: 'vermelho', label: 'Vermelho', hue: 356, sat: 100, light: 71, swatch: '#ff6b7c' },
  { id: 'laranja', label: 'Laranja', hue: 24, sat: 100, light: 62, swatch: '#ff8f45' },
  { id: 'ambar', label: 'Âmbar', hue: 45, sat: 100, light: 62, swatch: '#ffc447' },
  { id: 'verde', label: 'Verde', hue: 146, sat: 85, light: 58, swatch: '#3fe78e' },
  { id: 'turquesa', label: 'Turquesa', hue: 172, sat: 85, light: 56, swatch: '#2fe0c4' },
  { id: 'roxo', label: 'Roxo', hue: 264, sat: 100, light: 77, swatch: '#b88cff' },
  { id: 'lilas', label: 'Lilás', hue: 282, sat: 80, light: 78, swatch: '#cf9cf5' },
  { id: 'magenta', label: 'Magenta', hue: 312, sat: 100, light: 66, swatch: '#ff55d8' },
  { id: 'rosa', label: 'Rosa', hue: 338, sat: 100, light: 74, swatch: '#ff8fb8' },
  { id: 'gelo', label: 'Gelo', hue: 205, sat: 22, light: 80, swatch: '#cfdde6' },
]

const KEY = 'jarvis.theme'
export const DEFAULT_THEME = 'azul'
export const themeById = (id: string): Theme => THEMES.find((t) => t.id === id) ?? THEMES[0]
export function savedTheme(): string {
  try { const v = localStorage.getItem(KEY); if (v && THEMES.some((t) => t.id === v)) return v } catch { /* private mode */ }
  return DEFAULT_THEME
}

/** HSL (h 0-360, s/l 0-100) to [r, g, b] 0-255. */
function hsl(h: number, s: number, l: number): [number, number, number] {
  const S = s / 100, L = l / 100
  const k = (n: number) => (n + h / 30) % 12
  const a = S * Math.min(L, 1 - L)
  const f = (n: number) => L - a * Math.max(-1, Math.min(k(n) - 3, Math.min(9 - k(n), 1)))
  return [Math.round(f(0) * 255), Math.round(f(8) * 255), Math.round(f(4) * 255)]
}
const hex = ([r, g, b]: number[]) => '#' + [r, g, b].map((x) => x.toString(16).padStart(2, '0')).join('')
const tri = (c: number[]) => c.join(', ')

/** Every CSS variable of a theme. The blue theme is the original palette, kept exactly. */
export function tokens(id: string): Record<string, string> {
  const t = themeById(id)
  if (t.id === 'azul') {
    return { '--bg': '#02060a', '--bg-2': '#05101a', '--bg-deep': '#02121b', '--bg-term': '#030a10', '--bg-mid': '#07202f', '--panel': 'rgba(7, 22, 34, 0.78)', '--panel-solid': '#08182a', '--line': 'rgba(92, 214, 255, 0.2)', '--line-strong': 'rgba(92, 214, 255, 0.55)', '--cyan': '#4fd8ff', '--cyan-hi': '#bff4ff', '--text': '#d7f3ff', '--dim': '#8fb2c1', '--acc': '79, 216, 255', '--d1-rgb': '3, 10, 16', '--d2-rgb': '5, 16, 26', '--d3-rgb': '10, 30, 46' }
  }
  const { hue: h, sat: s } = t
  const mute = s < 40 ? 0.45 : 1 // the "gelo" theme is nearly neutral
  const acc = hsl(h, s, t.light)
  const d2 = hsl(h, 62 * mute, 7.5)
  return {
    '--bg': hex(hsl(h, 66 * mute, 2.6)), '--bg-2': hex(hsl(h, 66 * mute, 5.4)), '--bg-deep': hex(hsl(h, 70 * mute, 5.5)), '--bg-term': hex(hsl(h, 66 * mute, 3.6)), '--bg-mid': hex(hsl(h, 60 * mute, 9.5)),
    '--panel': `rgba(${tri(hsl(h, 58 * mute, 8.2))}, 0.78)`, '--panel-solid': hex(hsl(h, 58 * mute, 9.2)),
    '--line': `rgba(${tri(acc)}, 0.2)`, '--line-strong': `rgba(${tri(acc)}, 0.55)`,
    '--cyan': hex(acc), '--cyan-hi': hex(hsl(h, Math.min(s, 100), 89)), '--text': hex(hsl(h, 80 * mute, 93)), '--dim': hex(hsl(h, 22 * mute, 67)),
    '--acc': tri(acc), '--d1-rgb': tri(hsl(h, 60 * mute, 4.5)), '--d2-rgb': tri(d2), '--d3-rgb': tri(hsl(h, 55 * mute, 12)),
  }
}

/** Colours the 3D scene needs, as 0-1 floats [r, g, b]. */
export function sceneColors(id: string): { base: [number, number, number]; hot: [number, number, number]; bg: string; tree: [number, number, number] } {
  const t = themeById(id)
  const f = (c: number[]) => c.map((x) => x / 255) as [number, number, number]
  if (t.id === 'azul') return { base: [0.025, 0.11, 0.16], hot: [0.5, 0.95, 1.0], bg: '#02060a', tree: [0.025, 0.09, 0.13] }
  const mute = t.sat < 40 ? 0.45 : 1
  return { base: f(hsl(t.hue, 75 * mute, 9)), hot: f(hsl(t.hue, 100 * mute, 78)), bg: hex(hsl(t.hue, 66 * mute, 2.6)), tree: f(hsl(t.hue, 72 * mute, 7.5)) }
}

export function applyTheme(id: string): void {
  const root = document.documentElement
  const tk = tokens(id)
  for (const [k, v] of Object.entries(tk)) root.style.setProperty(k, v)
  root.dataset.theme = themeById(id).id
  try { localStorage.setItem(KEY, themeById(id).id) } catch { /* private mode */ }
}
