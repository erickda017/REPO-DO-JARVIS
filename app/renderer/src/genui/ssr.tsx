import { renderToStaticMarkup } from 'react-dom/server'
import { Render, type Ctx } from './components.tsx'
import { validateSpec } from '../../../../shared/genui/spec.mjs'

/** Server-side rendering of a spec with the REAL component library: used by tests (no browser needed) to check what a spec draws. */
export function renderSpec(input: unknown, data: Record<string, unknown> = {}, state: Record<string, string | number | boolean | (string | number)[]> = {}): { ok: boolean; html: string; errors: string[] } {
  const v = validateSpec(input)
  if (!v.ok) return { ok: false, html: '', errors: v.errors.map((e) => `${e.path}: ${e.msg}`) }
  const ctx: Ctx = { scope: { data: { ...(v.spec.data ?? {}), ...data }, state: { ...(v.spec.state ?? {}), ...state } }, state: { ...(v.spec.state ?? {}), ...state }, setState: () => {}, run: () => {}, busy: null, loading: false }
  return { ok: true, html: renderToStaticMarkup(<Render node={v.spec.root} ctx={ctx} />), errors: [] }
}
