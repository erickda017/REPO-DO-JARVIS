import * as THREE from 'three'
import { sceneColors } from '../theme.ts'

/**
 * The colours the 3D scene and the particles read every frame. The objects are shared and mutated in place, so a theme change
 * reaches the scene without rebuilding anything that holds a reference (Scene.tsx keeps BASE/HOT for its whole life).
 */
export const palette = {
  base: new THREE.Color(0.025, 0.11, 0.16),
  hot: new THREE.Color(0.5, 0.95, 1.0),
  tree: [0.025, 0.09, 0.13] as [number, number, number],
  link: [0.07, 0.26, 0.32] as [number, number, number],
  ringA: [0.6, 2, 2.4] as [number, number, number],
  ringB: [0.3, 1, 1.3] as [number, number, number],
  bg: '#02060a',
  acc: '79,216,255', // r,g,b of the accent, for 2D canvas strokes
  mote: '120,225,255',
}

export function setPalette(id: string): void {
  const c = sceneColors(id)
  palette.base.setRGB(...c.base)
  palette.hot.setRGB(...c.hot)
  palette.tree = c.tree
  palette.bg = c.bg
  if (id === 'azul') {
    palette.link = [0.07, 0.26, 0.32]; palette.ringA = [0.6, 2, 2.4]; palette.ringB = [0.3, 1, 1.3]; palette.acc = '79,216,255'; palette.mote = '120,225,255'
    return
  }
  const [r, g, b] = c.hot
  const mx = Math.max(r, g, b) || 1
  palette.ringA = [(r / mx) * 2.4, (g / mx) * 2.4, (b / mx) * 2.4]
  palette.ringB = [(r / mx) * 1.3, (g / mx) * 1.3, (b / mx) * 1.3]
  palette.link = [c.hot[0] * 0.18, c.hot[1] * 0.28, c.hot[2] * 0.3]
  palette.acc = c.hot.map((x) => Math.round(x * 255)).join(',')
  palette.mote = c.hot.map((x) => Math.round(Math.min(1, x + 0.1) * 255)).join(',')
}
