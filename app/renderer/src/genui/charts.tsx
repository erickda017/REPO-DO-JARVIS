import { fmtNumber, niceScale } from './format.ts'

/**
 * Charts for generative panels: plain SVG, no library. Every mark has a <title> (tooltip and screen-reader text), colours
 * come from the fixed tone palette (never from the spec), and the chart is still readable with animations off.
 */
export const TONE_COLOR: Record<string, string> = {
  neutral: 'var(--dim)', ok: 'var(--ok)', warn: 'var(--warn)', bad: 'var(--bad)', info: '#7aa7ff', accent: 'var(--cyan)',
}
const CYCLE = ['accent', 'info', 'ok', 'warn', 'bad', 'neutral']

export interface Series { key: string; label?: string; tone?: string }
export interface ChartProps { kind: string; rows: Record<string, unknown>[]; x: string; series: Series[]; unit?: string; stacked?: boolean; height?: number; title?: string }

const num = (v: unknown) => (typeof v === 'number' && Number.isFinite(v) ? v : typeof v === 'string' && v.trim() !== '' && Number.isFinite(Number(v)) ? Number(v) : 0)
const short = (s: string, n = 12) => (s.length > n ? s.slice(0, n - 1) + '…' : s)
const color = (s: Series, i: number) => TONE_COLOR[s.tone ?? CYCLE[i % CYCLE.length]] ?? TONE_COLOR.accent
const W = 640

function Legend({ series }: { series: Series[] }) {
  return (
    <ul className="gu-legend" aria-label="Legenda">
      {series.map((s, i) => <li key={s.key}><i style={{ background: color(s, i) }} />{s.label ?? s.key}</li>)}
    </ul>
  )
}

export function Chart({ kind, rows, x, series, unit, stacked, height = 240, title }: ChartProps) {
  const data = rows.slice(0, 300)
  if (!data.length || !series.length) return <p className="gu-empty">Sem dados para o gráfico.</p>
  const cats = data.map((r, i) => String(r[x] ?? i + 1))
  const label = (s: Series) => s.label ?? s.key
  const u = unit ? ` ${unit}` : ''

  if (kind === 'pie' || kind === 'donut') {
    const s = series[0]
    const vals = data.map((r) => Math.max(0, num(r[s.key])))
    const total = vals.reduce((a, b) => a + b, 0)
    if (total <= 0) return <p className="gu-empty">Todos os valores são zero.</p>
    const R = Math.min(height / 2 - 8, 110), cx = R + 12, cy = height / 2
    let a0 = -Math.PI / 2
    const slices = vals.map((v, i) => {
      const a1 = a0 + (v / total) * Math.PI * 2
      const large = a1 - a0 > Math.PI ? 1 : 0
      const p = (a: number, r: number) => `${(cx + r * Math.cos(a)).toFixed(2)} ${(cy + r * Math.sin(a)).toFixed(2)}`
      const r2 = kind === 'donut' ? R * 0.58 : 0
      const d = v >= total - 1e-9
        ? `M ${p(0, R)} A ${R} ${R} 0 1 1 ${p(Math.PI, R)} A ${R} ${R} 0 1 1 ${p(0, R)}`
        : `M ${p(a0, R)} A ${R} ${R} 0 ${large} 1 ${p(a1, R)} ${r2 ? `L ${p(a1, r2)} A ${r2} ${r2} 0 ${large} 0 ${p(a0, r2)}` : `L ${cx} ${cy}`} Z`
      a0 = a1
      return { d, v, i }
    })
    return (
      <figure className="gu-chart">
        {title && <figcaption>{title}</figcaption>}
        <div className="gu-pie">
          <svg viewBox={`0 0 ${R * 2 + 24} ${height}`} role="img" aria-label={`${title ?? 'Distribuição'}: ${cats.map((c, i) => `${c} ${fmtNumber(vals[i])}${u}`).join(', ')}`}>
            {slices.map((sl) => <path key={sl.i} d={sl.d} fill={TONE_COLOR[CYCLE[sl.i % CYCLE.length]]} fillOpacity={0.85} stroke="var(--bg)" strokeWidth={1.5}><title>{`${cats[sl.i]}: ${fmtNumber(sl.v)}${u} (${((sl.v / total) * 100).toFixed(1)}%)`}</title></path>)}
            {kind === 'donut' && <text x={cx} y={cy + 5} textAnchor="middle" className="gu-donut-total">{fmtNumber(total)}{u}</text>}
          </svg>
          <ul className="gu-legend vertical">
            {cats.map((c, i) => <li key={i}><i style={{ background: TONE_COLOR[CYCLE[i % CYCLE.length]] }} />{short(c, 22)} <b>{fmtNumber(vals[i])}</b></li>)}
          </ul>
        </div>
      </figure>
    )
  }

  const stackedTotals = data.map((r) => series.reduce((a, s) => a + num(r[s.key]), 0))
  const maxV = Math.max(...(stacked ? stackedTotals : data.flatMap((r) => series.map((s) => num(r[s.key])))), 0)
  const { max, ticks } = niceScale(maxV)

  if (kind === 'spark') {
    const s = series[0]
    const vals = data.map((r) => num(r[s.key]))
    const lo = Math.min(...vals), hi = Math.max(...vals), span = hi - lo || 1
    const pts = vals.map((v, i) => `${(i / Math.max(vals.length - 1, 1)) * 100},${100 - ((v - lo) / span) * 90 - 5}`).join(' ')
    return <svg className="gu-spark" viewBox="0 0 100 100" preserveAspectRatio="none" role="img" aria-label={`${label(s)}: último ${fmtNumber(vals.at(-1) ?? 0)}${u}`}><polyline points={pts} fill="none" stroke={color(s, 0)} strokeWidth={2} vectorEffect="non-scaling-stroke" /></svg>
  }

  if (kind === 'hbar') {
    const L = 118, T = 6, B = 24, Rm = 20
    const rowH = Math.max(18, Math.min(34, (height - T - B) / cats.length))
    const H = T + rowH * cats.length + B
    const sx = (v: number) => (v / max) * (W - L - Rm)
    const bh = (rowH * 0.7) / (stacked ? 1 : series.length)
    return (
      <figure className="gu-chart">
        {title && <figcaption>{title}</figcaption>}
        <svg viewBox={`0 0 ${W} ${H}`} role="img" aria-label={`${title ?? 'Gráfico de barras'}: ${series.map(label).join(', ')} por ${x}`}>
          {ticks.map((t) => <g key={t}><line x1={L + sx(t)} x2={L + sx(t)} y1={T} y2={H - B} className="gu-grid" /><text x={L + sx(t)} y={H - 8} textAnchor="middle" className="gu-tick">{fmtNumber(t)}</text></g>)}
          {cats.map((c, ci) => {
            let acc = 0
            return (
              <g key={ci}>
                <text x={L - 8} y={T + ci * rowH + rowH / 2 + 4} textAnchor="end" className="gu-tick">{short(c, 16)}</text>
                {series.map((s, si) => {
                  const v = num(data[ci][s.key])
                  const x0 = stacked ? acc : 0
                  if (stacked) acc += v
                  return <rect key={s.key} className="gu-bar" x={L + sx(x0)} y={T + ci * rowH + (rowH - bh * (stacked ? 1 : series.length)) / 2 + (stacked ? 0 : si * bh)} width={Math.max(sx(v), v > 0 ? 1 : 0)} height={bh - 1} rx={2} fill={color(s, si)} fillOpacity={0.88}><title>{`${c} · ${label(s)}: ${fmtNumber(v)}${u}`}</title></rect>
                })}
              </g>
            )
          })}
        </svg>
        {series.length > 1 && <Legend series={series} />}
      </figure>
    )
  }

  // vertical bar / line / area share the same axes
  const L = 46, T = 10, B = 30, Rm = 12
  const H = height
  const iw = W - L - Rm, ih = H - T - B
  const gx = (i: number) => L + (cats.length === 1 ? iw / 2 : (iw * (i + 0.5)) / cats.length)
  const sy = (v: number) => T + ih - (v / max) * ih
  const step = Math.max(1, Math.ceil(cats.length / 10))
  const axis = (
    <>
      {ticks.map((t) => <g key={t}><line x1={L} x2={W - Rm} y1={sy(t)} y2={sy(t)} className="gu-grid" /><text x={L - 6} y={sy(t) + 4} textAnchor="end" className="gu-tick">{fmtNumber(t)}</text></g>)}
      {cats.map((c, i) => (i % step === 0 ? <text key={i} x={gx(i)} y={H - 10} textAnchor="middle" className="gu-tick">{short(c, 10)}</text> : null))}
    </>
  )
  if (kind === 'line' || kind === 'area') {
    return (
      <figure className="gu-chart">
        {title && <figcaption>{title}</figcaption>}
        <svg viewBox={`0 0 ${W} ${H}`} role="img" aria-label={`${title ?? 'Gráfico de linha'}: ${series.map(label).join(', ')} por ${x}`}>
          {axis}
          {series.map((s, si) => {
            const pts = data.map((r, i) => `${gx(i).toFixed(1)},${sy(num(r[s.key])).toFixed(1)}`)
            return (
              <g key={s.key}>
                {kind === 'area' && <polygon points={`${gx(0)},${sy(0)} ${pts.join(' ')} ${gx(data.length - 1)},${sy(0)}`} fill={color(s, si)} fillOpacity={0.14} />}
                <polyline points={pts.join(' ')} fill="none" stroke={color(s, si)} strokeWidth={2} strokeLinejoin="round" />
                {data.map((r, i) => <circle key={i} cx={gx(i)} cy={sy(num(r[s.key]))} r={data.length > 40 ? 0 : 3} fill={color(s, si)}><title>{`${cats[i]} · ${label(s)}: ${fmtNumber(num(r[s.key]))}${u}`}</title></circle>)}
              </g>
            )
          })}
        </svg>
        {series.length > 1 && <Legend series={series} />}
      </figure>
    )
  }
  const slot = iw / cats.length
  const bw = Math.max(3, (slot * 0.7) / (stacked ? 1 : series.length))
  return (
    <figure className="gu-chart">
      {title && <figcaption>{title}</figcaption>}
      <svg viewBox={`0 0 ${W} ${H}`} role="img" aria-label={`${title ?? 'Gráfico de barras'}: ${series.map(label).join(', ')} por ${x}`}>
        {axis}
        {data.map((r, i) => {
          let acc = 0
          return series.map((s, si) => {
            const v = num(r[s.key])
            const y0 = stacked ? acc : 0
            if (stacked) acc += v
            const bx = gx(i) - (bw * (stacked ? 1 : series.length)) / 2 + (stacked ? 0 : si * bw)
            return <rect key={`${i}-${s.key}`} className="gu-bar" x={bx} y={sy(y0 + v)} width={bw - 1} height={Math.max(sy(y0) - sy(y0 + v), v > 0 ? 1 : 0)} rx={2} fill={color(s, si)} fillOpacity={0.88}><title>{`${cats[i]} · ${label(s)}: ${fmtNumber(v)}${u}`}</title></rect>
          })
        })}
      </svg>
      {series.length > 1 && <Legend series={series} />}
    </figure>
  )
}
