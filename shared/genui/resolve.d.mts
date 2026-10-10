export const ROOTS: string[]
export const REF_RE: RegExp
export interface Scope { data?: Record<string, unknown>; state?: Record<string, unknown>; row?: Record<string, unknown>; form?: Record<string, unknown> }
export function parseRef(ref: unknown): (string | number)[] | null
export function getRef(scope: Scope, ref: string): unknown
export function isRef(v: unknown): v is { ref: string; eq?: unknown; ne?: unknown; gt?: number; lt?: number }
export function resolve(v: unknown, scope: Scope): unknown
export function interpolate(text: string, scope: Scope): string
export function evalCond(cond: unknown, scope: Scope): boolean
export function resolveArgs(tpl: unknown, scope: Scope, depth?: number): unknown
export function setData(data: Record<string, unknown>, target: string, value: unknown, opts?: { append?: boolean }): boolean
export function pick(obj: unknown, path?: string): unknown
