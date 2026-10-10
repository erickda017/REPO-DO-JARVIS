import { ps } from '../agent/winps.mjs'

/**
 * Windows DPAPI (current user): what is sealed here can only be opened by this Windows account on this PC.
 * The text travels as base64 so no quoting can alter it. A failure rejects; callers never fall back to plaintext on their own.
 * ponytail: PowerShell per call (~0.3 s, only on load/save); the base64 is briefly visible in this process's command line.
 */
const run = (b64, fn) => ps(`Add-Type -AssemblyName System.Security; [Convert]::ToBase64String([Security.Cryptography.ProtectedData]::${fn}([Convert]::FromBase64String('${b64}'),$null,'CurrentUser'))`)

export const dpapi = {
  seal: (text) => run(Buffer.from(text, 'utf8').toString('base64'), 'Protect'),
  open: async (sealed) => Buffer.from(await run(sealed, 'Unprotect'), 'base64').toString('utf8'),
}
