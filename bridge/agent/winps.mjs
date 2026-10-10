import { execFile } from 'node:child_process'

/**
 * Runs a PowerShell snippet and returns its stdout, or throws with a short, redacted reason.
 * The script travels as -EncodedCommand (UTF-16LE base64), so no quoting rule of any shell can alter it,
 * and output is forced to UTF-8. Hard timeout; never a long-lived process.
 */
export function ps(script, { timeoutMs = 20000, maxBuffer = 8 * 1024 * 1024 } = {}) {
  const body = `[Console]::OutputEncoding=[Text.Encoding]::UTF8; $ProgressPreference='SilentlyContinue'; $ErrorActionPreference='Stop'; ${script}`
  const encoded = Buffer.from(body, 'utf16le').toString('base64')
  return new Promise((resolve, reject) => {
    execFile('powershell.exe', ['-NoProfile', '-NonInteractive', '-ExecutionPolicy', 'Bypass', '-EncodedCommand', encoded], { timeout: timeoutMs, maxBuffer, windowsHide: true }, (err, stdout, stderr) => {
      if (err) {
        return reject(new Error(cleanError(stderr || err.message)))
      }
      resolve(String(stdout).trim())
    })
  })
}

/** PowerShell reports errors as CLIXML when run non-interactively; turn that into one readable line. */
export function cleanError(raw) {
  let t = String(raw || 'powershell failed')
  if (t.startsWith('#< CLIXML')) t = [...t.matchAll(/<S S="Error">([\s\S]*?)<\/S>/g)].map((m) => m[1]).join(' ') || 'erro do PowerShell'
  t = t.replace(/_x000D__x000A_/g, ' ').replace(/&lt;/g, '<').replace(/&gt;/g, '>').replace(/&amp;/g, '&').replace(/\s+/g, ' ').trim()
  return t.slice(0, 240)
}

/** Runs a snippet that prints JSON and parses it. */
export async function psJson(script, opts) {
  const out = await ps(script, opts)
  if (!out) return null
  try {
    return JSON.parse(out)
  } catch {
    throw new Error('powershell returned something that is not JSON')
  }
}

/** Single-quote a string for safe use inside a PowerShell snippet. */
export const q = (s) => `'${String(s).replace(/'/g, "''")}'`

export const isWindows = process.platform === 'win32'
