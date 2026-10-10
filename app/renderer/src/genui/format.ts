/** Display formatters for generative panels. Pure, locale pt-BR, never throw on odd input. */
export type Format = 'text' | 'number' | 'bytes' | 'percent' | 'date' | 'duration' | 'mb' | 'gb'

const nf = new Intl.NumberFormat('pt-BR', { maximumFractionDigits: 2 })

export function fmtNumber(n: number): string {
  if (!Number.isFinite(n)) return '—'
  return nf.format(n)
}

export function fmtBytes(n: number): string {
  if (!Number.isFinite(n)) return '—'
  const u = ['B', 'KB', 'MB', 'GB', 'TB']
  let i = 0
  let v = Math.abs(n)
  while (v >= 1024 && i < u.length - 1) { v /= 1024; i++ }
  return `${n < 0 ? '-' : ''}${nf.format(v)} ${u[i]}`
}

export function fmtDuration(sec: number): string {
  if (!Number.isFinite(sec)) return '—'
  const s = Math.round(sec)
  if (s < 60) return `${s} s`
  if (s < 3600) return `${Math.floor(s / 60)} min ${s % 60 ? `${s % 60} s` : ''}`.trim()
  return `${Math.floor(s / 3600)} h ${Math.floor((s % 3600) / 60)} min`
}

export function fmtDate(v: unknown): string {
  const d = new Date(typeof v === 'number' || typeof v === 'string' ? v : NaN)
  return Number.isNaN(d.getTime()) ? String(v ?? '—') : d.toLocaleString('pt-BR', { dateStyle: 'short', timeStyle: 'short' })
}

export function fmt(v: unknown, format: Format = 'text', unit?: string): string {
  if (v === null || v === undefined || v === '') return '—'
  const n = typeof v === 'number' ? v : typeof v === 'string' && v.trim() !== '' && Number.isFinite(Number(v)) ? Number(v) : NaN
  switch (format) {
    case 'number': return Number.isNaN(n) ? String(v) : fmtNumber(n) + (unit ? ` ${unit}` : '')
    case 'bytes': return Number.isNaN(n) ? String(v) : fmtBytes(n)
    case 'mb': return Number.isNaN(n) ? String(v) : `${fmtNumber(n)} MB`
    case 'gb': return Number.isNaN(n) ? String(v) : `${fmtNumber(n)} GB`
    case 'percent': return Number.isNaN(n) ? String(v) : `${fmtNumber(n)}%`
    case 'duration': return Number.isNaN(n) ? String(v) : fmtDuration(n)
    case 'date': return fmtDate(v)
    default: return typeof v === 'object' ? JSON.stringify(v) : String(v)
  }
}

/** "Nice" axis ticks for a [0, max] range: returns {max, ticks}. */
export function niceScale(max: number, count = 4): { max: number; ticks: number[] } {
  if (!Number.isFinite(max) || max <= 0) return { max: 1, ticks: [0, 1] }
  const raw = max / count
  const mag = 10 ** Math.floor(Math.log10(raw))
  const step = [1, 2, 2.5, 5, 10].map((m) => m * mag).find((s) => s >= raw) ?? 10 * mag
  const top = Math.ceil(max / step) * step
  const ticks: number[] = []
  for (let v = 0; v <= top + step / 2; v += step) ticks.push(+v.toFixed(6))
  return { max: top, ticks }
}
