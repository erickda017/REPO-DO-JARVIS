import { useEffect, useRef } from 'react'

/**
 * Ambient motes drifting across the whole interface, with faint links between close ones. Pure canvas 2D,
 * capped (~70 motes, no per-frame allocation), paused when the window is hidden, and absent with
 * prefers-reduced-motion. It sits behind the content and never takes pointer events.
 */
export function Particles() {
  const ref = useRef<HTMLCanvasElement>(null)
  useEffect(() => {
    const cv = ref.current!
    const ctx = cv.getContext('2d')!
    if (matchMedia('(prefers-reduced-motion: reduce)').matches) return
    let w = 0, h = 0, raf = 0, last = performance.now()
    const N = 70
    const px = new Float32Array(N), py = new Float32Array(N), vx = new Float32Array(N), vy = new Float32Array(N), ph = new Float32Array(N)
    const fit = () => {
      const dpr = Math.min(devicePixelRatio || 1, 1.5)
      w = cv.clientWidth; h = cv.clientHeight
      cv.width = w * dpr; cv.height = h * dpr
      ctx.setTransform(dpr, 0, 0, dpr, 0, 0)
    }
    fit()
    for (let i = 0; i < N; i++) {
      px[i] = Math.random() * w; py[i] = Math.random() * h
      const a = Math.random() * Math.PI * 2, s = 6 + Math.random() * 14
      vx[i] = Math.cos(a) * s; vy[i] = Math.sin(a) * s; ph[i] = Math.random() * 6.28
    }
    const frame = (now: number) => {
      const dt = Math.min((now - last) / 1000, 0.05)
      last = now
      ctx.clearRect(0, 0, w, h)
      for (let i = 0; i < N; i++) {
        px[i] += vx[i] * dt; py[i] += vy[i] * dt
        if (px[i] < -10) px[i] = w + 10; else if (px[i] > w + 10) px[i] = -10
        if (py[i] < -10) py[i] = h + 10; else if (py[i] > h + 10) py[i] = -10
        const tw = 0.35 + 0.35 * Math.sin(now / 1400 + ph[i])
        ctx.fillStyle = `rgba(120,225,255,${tw * 0.55})`
        ctx.fillRect(px[i] - 1, py[i] - 1, 2, 2)
        for (let j = i + 1; j < N; j++) {
          const dx = px[i] - px[j], dy = py[i] - py[j], d2 = dx * dx + dy * dy
          if (d2 < 130 * 130) {
            ctx.strokeStyle = `rgba(79,216,255,${(1 - Math.sqrt(d2) / 130) * 0.16})`
            ctx.beginPath(); ctx.moveTo(px[i], py[i]); ctx.lineTo(px[j], py[j]); ctx.stroke()
          }
        }
      }
      raf = requestAnimationFrame(frame)
    }
    const vis = () => { cancelAnimationFrame(raf); if (!document.hidden) { last = performance.now(); raf = requestAnimationFrame(frame) } }
    document.addEventListener('visibilitychange', vis)
    addEventListener('resize', fit)
    raf = requestAnimationFrame(frame)
    return () => { cancelAnimationFrame(raf); document.removeEventListener('visibilitychange', vis); removeEventListener('resize', fit) }
  }, [])
  return <canvas ref={ref} className="particles" aria-hidden />
}
