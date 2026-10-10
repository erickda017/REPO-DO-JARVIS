// Dangerous-command detection. Adapted from tools/approval_detection.py of Hermes Agent (c) 2025 Nous Research, MIT License,
// with the Windows / PowerShell tier first (this agent runs on Windows) and the POSIX rules kept for Git Bash and WSL.
//
//   hardline   never allowed, not even in --yolo mode (wiping the disk, root/home/drive, shutdown, fork bomb)
//   dangerous  allowed only after the owner says yes (deletes, force pushes, remote scripts piped to a shell, ...)

const SHELLS = 'bash|sh|zsh|ksh|dash|pwsh|powershell'
// A command word: start of the line or after a separator / subshell, so quoted prose such as `echo "mkfs?"` does not trip it.
const CMDPOS = String.raw`(?:^|[;&|\n(\`]|\$\(|\bthen\b|\bdo\b)\s*(?:sudo\s+(?:-\S+\s+)*)?`

export const HARDLINE = [
  [String.raw`\brm\s+(?:-[^\s]*\s+)*(?:/|/\*|~|~/|~/\*|\$home|\$\{home\})(?:\s|$)`, 'recursive delete of the root or home directory'],
  [String.raw`\brm\s+(?:-[^\s]*\s+)*/(?:bin|boot|dev|etc|lib|lib64|proc|sbin|sys|usr|var)(?:/\*?)?(?:\s|$)`, 'delete of a system directory'],
  [String.raw`\bremove-item\b(?=[^\n;|&]*-recurse)[^\n;|&]*\s['"]?[a-z]:[\\/]?\*?['"]?(?:\s|$)`, 'recursive delete of a whole drive'],
  [String.raw`\bremove-item\b(?=[^\n;|&]*-recurse)[^\n;|&]*\s['"]?(?:[a-z]:[\\/](?:windows|program files(?: \(x86\))?|users)|\$env:(?:windir|systemroot|userprofile|programfiles))['"]?[\\/]?\*?['"]?(?:\s|$)`, 'recursive delete of a system or profile directory'],
  [String.raw`\b(?:rd|rmdir)\s+(?:/[sq]\s+)+['"]?[a-z]:[\\/]?['"]?(?:\s|$)`, 'recursive delete of a whole drive'],
  [String.raw`\b(?:del|erase)\s+(?:/[a-z]\s+)*['"]?[a-z]:[\\/]\*`, 'delete of a whole drive'],
  [String.raw`\bformat(?:\.com)?\s+[a-z]:`, 'format drive'],
  [String.raw`\bformat-volume\b|\bclear-disk\b|\bdiskpart\b`, 'format or wipe disk'],
  [CMDPOS + String.raw`mkfs(?:\.[a-z0-9]+)?\b`, 'format filesystem (mkfs)'],
  [CMDPOS + String.raw`dd\b[^\n]*\bof=/dev/(?:sd|nvme|hd|mmcblk|vd|xvd)[a-z0-9]*`, 'dd to raw block device'],
  [String.raw`>\s*/dev/(?:sd|nvme|hd|mmcblk|vd|xvd)[a-z0-9]*\b`, 'redirect to raw block device'],
  [String.raw`:\(\)\s*\{\s*:\s*\|\s*:\s*&\s*\}\s*;\s*:`, 'fork bomb'],
  [CMDPOS + String.raw`(?:shutdown|reboot|halt|poweroff)\b|\b(?:stop-computer|restart-computer)\b`, 'system shutdown/reboot'],
  [String.raw`\bbcdedit\b[^\n]*\s/(?:set|delete)\b`, 'modify boot configuration'],
  [String.raw`\bvssadmin\b[^\n]*\bdelete\s+shadows\b|\bwbadmin\b[^\n]*\bdelete\b`, 'delete backups / shadow copies'],
]

export const DANGEROUS = [
  [String.raw`\brm\s+-[^\s]*r`, 'recursive delete'],
  [String.raw`\brm\s+--recursive\b`, 'recursive delete (long flag)'],
  [String.raw`\brm\s+(?!--(?:\s|$))(?:(?!\s--(?:\s|$))[^\n"';|&])*\s(?:-[a-z]*r[a-z]*\b|--recursive\b)`, 'recursive delete (flags after operands)'],
  [String.raw`\bremove-item\b[^\n;|&]*\s-(?:recurse|force)\b`, 'PowerShell destructive delete (Remove-Item)'],
  [String.raw`\b(?:ri|rm|rmdir|rd|del|erase)\b[^\n;|&]*\s-(?:recurse|force)\b`, 'PowerShell destructive delete (alias)'],
  [String.raw`\b(?:del|erase|rd|rmdir)\s+(?:/[a-z]\s+)*/[sq]\b`, 'Windows destructive delete (recursive/quiet switch)'],
  [String.raw`\bcmd(?:\.exe)?\s+/(?:c|k)\s+.*\b(?:del|erase|rd|rmdir)\b`, 'Windows cmd destructive delete'],
  [String.raw`\b(?:powershell|pwsh)(?:\.exe)?\b.*\s-(?:encodedcommand|enc|e)\b`, 'PowerShell encoded command execution'],
  [String.raw`\b(?:iwr|invoke-webrequest|invoke-restmethod|irm|curl|wget)\b[^\n]*\|\s*(?:iex|invoke-expression)\b`, 'pipe remote content to PowerShell (iwr | iex)'],
  [String.raw`\b(?:iex|invoke-expression)\s*\(\s*(?:iwr|invoke-webrequest|invoke-restmethod|irm)\b`, 'execute remote content via Invoke-Expression'],
  [String.raw`\btaskkill\b[^\n]*\s/f\b`, 'force kill processes (taskkill /F)'],
  [String.raw`\bstop-process\b[^\n]*\s-force\b`, 'force kill processes (Stop-Process -Force)'],
  [String.raw`\bcipher\s+/w\b`, 'wipe free space (cipher /w)'],
  [String.raw`\bicacls\b[^\n]*\s/(?:grant\b[^\n]*\b(?:everyone|todos)\b|reset\b)`, 'change ACLs broadly (icacls)'],
  [String.raw`\breg(?:\.exe)?\s+delete\b|\bremove-itemproperty\b[^\n]*\s-force\b`, 'registry delete'],
  [String.raw`\bstop-service\b[^\n]*\s-force\b|\bsc(?:\.exe)?\s+(?:stop|delete)\b`, 'stop/delete a Windows service'],
  [String.raw`\bset-mppreference\b|\badd-mppreference\b|\bdisable-windowsoptionalfeature\b`, 'change Windows Defender / system features'],
  [String.raw`\b(?:net\s+user|schtasks\s+/(?:create|delete))\b`, 'change users or scheduled tasks'],
  [String.raw`\bnetsh\s+(?:advfirewall|firewall)\b`, 'change firewall rules'],
  [String.raw`\b(?:users|documents and settings)[\\/][^\\/\s]+[\\/]\.ssh\b|\bappdata[\\/](?:local|roaming)[\\/]jarvis[^\n]*\b(?:settings|router-token)`, 'access to SSH keys or JARVIS secrets'],
  [String.raw`\bchmod\s+(?:-[^\s]*\s+)*(?:777|666|o\+[rwx]*w|a\+[rwx]*w)\b`, 'world-writable permissions'],
  [String.raw`\bchown\s+(?:-[^\s]*)?R\s+root`, 'recursive chown to root'],
  [CMDPOS + String.raw`dd\s+.*if=`, 'disk copy'],
  [String.raw`\bDROP\s+(?:TABLE|DATABASE)\b`, 'SQL DROP'],
  [String.raw`\bDELETE\s+FROM\b(?![^\n]*\bWHERE\b)`, 'SQL DELETE without WHERE'],
  [String.raw`\bTRUNCATE\s+(?:TABLE)?\s*\w`, 'SQL TRUNCATE'],
  [String.raw`\b(?:pkill|killall)\s+(?:-[^\s]*\s+)*-(?:9|KILL|SIGKILL)\b|\bkill\s+-9\s+-1\b`, 'force kill processes'],
  [String.raw`\b(?:curl|wget)\b.*\|\s*(?:[/\w]*/)?(?:${SHELLS})(?:\s|$|-c)`.replace('${SHELLS}', SHELLS), 'pipe remote content to a shell'],
  [String.raw`\b(?:${SHELLS})\s+<\s*<?\s*\(\s*(?:curl|wget)\b`.replace('${SHELLS}', SHELLS), 'execute a remote script via process substitution'],
  [String.raw`\b(?:base64|base32)\s+(?:-d|--decode)\b.*\|\s*\b(?:${SHELLS})\b`.replace('${SHELLS}', SHELLS), 'pipe decoded content to a shell (possible obfuscation)'],
  [String.raw`(?<![\d.])(?:169\.254\.169\.254|100\.100\.100\.200)(?![\d.])|metadata\.google\.internal`, 'cloud metadata endpoint access (instance credentials)'],
  [String.raw`[​‌‎‏‪-‮⁠-⁤⁦-⁩﻿]`, 'invisible or bidirectional Unicode control character (possible obfuscation)'],
  [String.raw`\bxargs\s+.*\brm\b|\bfind\b.*-exec(?:dir)?\s+(?:/\S*/)?rm\b|\bfind\b.*-delete\b`, 'bulk delete via find/xargs'],
  [String.raw`\bgit\s+reset\s+--h(?:a(?:r(?:d)?)?)?\b`, 'git reset --hard (destroys uncommitted changes)'],
  [String.raw`\bgit\s+push\b.*(?:--forc[a-z]*|\s-f)\b`, 'git force push (rewrites remote history)'],
  [String.raw`\bgit\s+clean\s+-[^\s]*f`, 'git clean with force (deletes untracked files)'],
  [String.raw`\bgit\s+(?:checkout|restore)\s+(?:--\s+)?\.(?:\s|$)`, 'discard all working-tree changes'],
  [String.raw`\bgit\s+branch\s+-D\b`, 'git branch force delete'],
  [String.raw`\bchmod\s+\+x\b.*[;&|]+\s*\./`, 'chmod +x followed by immediate execution'],
  [String.raw`\bsudo\b[^;|&\n]*?\s+(?:-s\b|--st[a-z]*\b|-a\b)`, 'sudo with privilege flag'],
  [String.raw`${CMDPOS}(?:npm|pnpm|yarn)\s+(?:-[^\s]+\s+)*(?:uninstall|unlink|remove|rm)\b|${CMDPOS}pip3?\s+(?:-[^\s]+\s+)*uninstall\b`.replaceAll('${CMDPOS}', CMDPOS), 'package manager uninstall'],
  [String.raw`>>?\s*['"]?(?:~|\$home|\$env:userprofile|[a-z]:[\\/]users[\\/][^\\/\s]+)?[\\/]?(?:\.ssh[\\/]|\.bashrc|\.zshrc|\.profile|\.npmrc|\.netrc|\.git-credentials)`, 'overwrite credential or shell startup file'],
]

const compile = (list) => list.map(([p, d]) => [new RegExp(p, 'is'), d])
const HARD = compile(HARDLINE)
const DANGER = compile(DANGEROUS)

/** Lower-cased variants to test: the command itself plus the payload of `sh -c "..."` / `powershell -Command "..."`. */
function variants(command) {
  const base = String(command ?? '').normalize('NFKC')
  const out = [base]
  for (const m of base.matchAll(/(?:-c|-command)\s+(["'])([\s\S]*?)\1/gi)) out.push(m[2])
  return out
}

/** @returns {{level: 'hardline'|'dangerous'|null, reason: string|null}} */
export function classifyCommand(command) {
  const vs = variants(command)
  for (const v of vs) for (const [re, d] of HARD) if (re.test(v)) return { level: 'hardline', reason: d }
  for (const v of vs) for (const [re, d] of DANGER) if (re.test(v)) return { level: 'dangerous', reason: d }
  return { level: null, reason: null }
}

/**
 * Decides whether a command may run. `ask(message)` returns 'once' | 'session' | 'deny'.
 * `yolo` skips the dangerous tier only; a hardline command is refused whatever the mode.
 */
export function createApprover({ ask, yolo = false } = {}) {
  const allowedForSession = new Set()
  return {
    yolo,
    setYolo(v) { this.yolo = Boolean(v) },
    async check(command) {
      const c = classifyCommand(command)
      if (c.level === 'hardline') return { allowed: false, reason: `BLOQUEADO (nunca é permitido): ${c.reason}. Se o usuário realmente precisa disso, ele deve executar manualmente fora do agente.` }
      if (c.level === null || this.yolo || allowedForSession.has(c.reason)) return { allowed: true }
      if (!ask) return { allowed: false, reason: `Comando perigoso (${c.reason}) e não há como pedir confirmação.` }
      const answer = await ask(`Comando perigoso (${c.reason}):\n  ${String(command).split('\n')[0].slice(0, 200)}\nPermitir?`)
      if (answer === 'session') { allowedForSession.add(c.reason); return { allowed: true } }
      if (answer === 'once') return { allowed: true }
      return { allowed: false, reason: `O usuário NÃO autorizou este comando (${c.reason}). Não tente contornar; proponha outra abordagem ou explique.` }
    },
  }
}
