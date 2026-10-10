export interface SpecIssue { path: string; msg: string }
export interface Validation { ok: boolean; errors: SpecIssue[]; warnings: SpecIssue[]; spec: any }
export const LIMITS: Record<string, number>
export const TONES: string[]
export const NODE_TYPES: string[]
export const BANNED_TOOLS: Set<string>
export function validateSpec(input: unknown): Validation
export function explain(errors: SpecIssue[]): string
