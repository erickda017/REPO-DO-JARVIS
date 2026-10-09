/**
 * Secret scrubbing for anything that is about to be logged, audited or sent to
 * the browser. Two layers: keys whose *name* looks sensitive lose their value
 * wholesale, and free text is scanned for token-shaped strings.
 */
const SENSITIVE_KEY = /(api[-_]?key|token|secret|authorization|password|passwd|cookie|credential|bearer)/i

const TOKEN_SHAPES = [
  /\bsk-[A-Za-z0-9_-]{8,}/g, // OpenAI / Anthropic style
  /\bBearer\s+[A-Za-z0-9._~+/=-]{8,}/gi,
  /\bgh[pousr]_[A-Za-z0-9]{20,}/g, // GitHub
  /\bAIza[0-9A-Za-z_-]{20,}/g, // Google
  /\bxox[abprs]-[A-Za-z0-9-]{10,}/g, // Slack
]

export function redactString(text) {
  let out = String(text)
  for (const re of TOKEN_SHAPES) out = out.replace(re, '[redacted]')
  return out
}

export function redact(value, depth = 0) {
  if (value == null) return value
  if (typeof value === 'string') return redactString(value)
  if (typeof value !== 'object') return value
  if (depth > 6) return '[truncated]'
  if (Array.isArray(value)) return value.map((v) => redact(v, depth + 1))
  const out = {}
  for (const [k, v] of Object.entries(value)) {
    out[k] = SENSITIVE_KEY.test(k) ? '[redacted]' : redact(v, depth + 1)
  }
  return out
}
