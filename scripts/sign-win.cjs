// Custom signer for electron-builder (win.sign). Runs the Windows SDK's signtool on each file electron-builder hands over.
// Certificate, in order of preference: JARVIS_SIGN_PFX (+ JARVIS_SIGN_PASSWORD), or JARVIS_SIGN_SHA1 = thumbprint of a
// certificate in the current user's store (the private key never has to leave the store).
// A timestamp keeps the signature valid after the certificate expires; it sends only the file's digest to the server.
const { execFileSync } = require('node:child_process')
const { existsSync, readdirSync } = require('node:fs')
const { join } = require('node:path')

function signtool() {
  const root = join(process.env['ProgramFiles(x86)'] ?? 'C:\\Program Files (x86)', 'Windows Kits', '10', 'bin')
  const versions = existsSync(root) ? readdirSync(root).filter((v) => /^10\./.test(v)).sort().reverse() : []
  for (const v of versions) {
    const p = join(root, v, 'x64', 'signtool.exe')
    if (existsSync(p)) return p
  }
  throw new Error('signtool.exe not found (install the Windows SDK "Signing Tools")')
}

exports.default = async function sign(config) {
  // Only our own files. Third-party binaries bundled in the app (Claude Code's claude.exe, Windows Terminal's OpenConsole.exe)
  // keep their vendors' signatures: signing would replace them.
  if (/[\\/]node_modules[\\/]/.test(config.path)) return
  const cert = process.env.JARVIS_SIGN_PFX
    ? ['/f', process.env.JARVIS_SIGN_PFX, ...(process.env.JARVIS_SIGN_PASSWORD ? ['/p', process.env.JARVIS_SIGN_PASSWORD] : [])]
    : process.env.JARVIS_SIGN_SHA1 ? ['/sha1', process.env.JARVIS_SIGN_SHA1] : null
  if (!cert) throw new Error('set JARVIS_SIGN_SHA1 (store thumbprint) or JARVIS_SIGN_PFX to sign')
  const base = ['sign', '/fd', 'sha256', ...cert, '/d', 'J.A.R.V.I.S']
  const stamp = ['/tr', process.env.JARVIS_SIGN_TIMESTAMP ?? 'http://timestamp.digicert.com', '/td', 'sha256']
  try {
    execFileSync(signtool(), [...base, ...stamp, config.path], { stdio: 'pipe' })
  } catch {
    // Timestamp server unreachable: still sign (it will need re-signing before the certificate expires).
    execFileSync(signtool(), [...base, config.path], { stdio: 'pipe' })
  }
}
