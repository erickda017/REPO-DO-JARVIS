import { mkdirSync, writeFileSync } from 'node:fs'
import { deflateSync } from 'node:zlib'

// Draws the app icon (a glowing cyan core inside two rings on a dark tile) with no image tooling:
// build/icon.png (512) and build/icon.ico (PNG-compressed 256 + 64), so electron-builder's own
// icon converter, which ran out of memory on this PC, is never needed.
const mix = (a, b, t) => a + (b - a) * Math.max(0, Math.min(1, t))
const crcTable = Array.from({ length: 256 }, (_, n) => { let c = n; for (let k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1; return c >>> 0 })
const crc = (buf) => { let c = 0xffffffff; for (const v of buf) c = crcTable[(c ^ v) & 0xff] ^ (c >>> 8); return (c ^ 0xffffffff) >>> 0 }
const chunk = (type, data) => {
  const len = Buffer.alloc(4); len.writeUInt32BE(data.length)
  const td = Buffer.concat([Buffer.from(type), data])
  const c = Buffer.alloc(4); c.writeUInt32BE(crc(td))
  return Buffer.concat([len, td, c])
}

function png(N) {
  const s = N / 512 // everything below is authored on a 512 grid
  const px = Buffer.alloc(N * N * 4)
  for (let y = 0; y < N; y++) {
    for (let x = 0; x < N; x++) {
      const dx = (x - N / 2 + 0.5) / s, dy = (y - N / 2 + 0.5) / s
      const d = Math.hypot(dx, dy)
      const rx = Math.max(Math.abs(dx) - (256 - 70), 0), ry = Math.max(Math.abs(dy) - (256 - 70), 0)
      let r = 3, g = 10, b = 16
      const a = Math.hypot(rx, ry) <= 70 ? 255 : 0
      const glow = Math.exp(-((d / 120) ** 2))
      r = mix(r, 40, glow); g = mix(g, 190, glow * 0.9); b = mix(b, 230, glow * 0.9)
      const ring = (rad, w, k) => { const e = Math.abs(d - rad); if (e < w) { const t = 1 - e / w; r = mix(r, 130, t * k); g = mix(g, 235, t * k); b = mix(b, 255, t * k) } }
      ring(165, 5 + 3 / s, 0.9)
      ring(118, 3 + 2 / s, 0.55)
      if (d < 58) { const t = 1 - d / 58; r = mix(r, 200, 0.6 + t * 0.4); g = mix(g, 250, 0.6 + t * 0.4); b = mix(b, 255, 0.6 + t * 0.4) }
      const o = (y * N + x) * 4
      px[o] = r; px[o + 1] = g; px[o + 2] = b; px[o + 3] = a
    }
  }
  const ihdr = Buffer.alloc(13); ihdr.writeUInt32BE(N, 0); ihdr.writeUInt32BE(N, 4); ihdr[8] = 8; ihdr[9] = 6
  const raw = Buffer.alloc((N * 4 + 1) * N)
  for (let y = 0; y < N; y++) px.copy(raw, y * (N * 4 + 1) + 1, y * N * 4, (y + 1) * N * 4)
  return Buffer.concat([Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]), chunk('IHDR', ihdr), chunk('IDAT', deflateSync(raw)), chunk('IEND', Buffer.alloc(0))])
}

function ico(sizes) {
  const images = sizes.map((n) => ({ n, data: png(n) }))
  const head = Buffer.alloc(6); head.writeUInt16LE(1, 2); head.writeUInt16LE(images.length, 4)
  let offset = 6 + images.length * 16
  const dir = images.map(({ n, data }) => {
    const e = Buffer.alloc(16)
    e[0] = n >= 256 ? 0 : n; e[1] = n >= 256 ? 0 : n; e.writeUInt16LE(1, 4); e.writeUInt16LE(32, 6)
    e.writeUInt32LE(data.length, 8); e.writeUInt32LE(offset, 12)
    offset += data.length
    return e
  })
  return Buffer.concat([head, ...dir, ...images.map((i) => i.data)])
}

mkdirSync('build', { recursive: true })
writeFileSync('build/icon.png', png(512))
writeFileSync('build/icon.ico', ico([256, 64, 32]))
console.log('[app] icons written to build/icon.png and build/icon.ico')
