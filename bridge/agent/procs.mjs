import { isWindows, ps, psJson } from './winps.mjs'

/**
 * Process safety rules, in code (not in a prompt). A process is:
 *   protected  never closable by the agent (Windows core, security software, this app and the local AI servers)
 *   caution    can hold unsaved work or is part of the desktop: needs the owner's confirmation
 *   optional   a well-known background/chat/launcher app that is safe to close gracefully
 *   unknown    purpose unclear: needs confirmation
 */
const PROTECTED = new Set(['system', 'idle', 'registry', 'smss', 'csrss', 'wininit', 'winlogon', 'services', 'lsass', 'lsaiso', 'svchost', 'dwm', 'fontdrvhost', 'memory compression', 'securityhealthservice', 'securityhealthsystray', 'msmpeng', 'nissrv', 'mpdefendercoreservice', 'sgrmbroker', 'wudfhost', 'audiodg', 'spoolsv', 'taskhostw', 'sihost', 'ctfmon', 'runtimebroker', 'searchhost', 'startmenuexperiencehost', 'shellexperiencehost', 'textinputhost', 'dllhost', 'conhost', 'wmiprvse', 'trustedinstaller', 'tiworker', 'msiexec', 'powershell', 'pwsh', 'cmd', 'node', 'j.a.r.v.i.s', 'jarvis', 'llama-server', 'electron', 'taskmgr', 'logonui', 'userinit', 'lsm', 'sppsvc', 'ollama', 'llama-cli'])
const SECURITY = /(avast|avg|kaspersky|kav|mcafee|mfe|norton|bitdefender|bdagent|eset|ekrn|sophos|malwarebytes|mbam|crowdstrike|windefend|antimalware)/i
const CAUTION = new Set(['explorer', 'chrome', 'msedge', 'firefox', 'brave', 'opera', 'winword', 'excel', 'powerpnt', 'code', 'devenv', 'notepad', 'notepad++', 'obs64', 'obs', 'vlc', 'photoshop', 'premiere pro', 'blender', 'javaw', 'java', 'minecraft', 'steam', 'epicgameslauncher', 'battle.net', 'eadesktop', 'origin', 'upc'])
const OPTIONAL = new Set(['discord', 'spotify', 'teams', 'ms-teams', 'slack', 'skype', 'telegram', 'whatsapp', 'onedrive', 'dropbox', 'googledrivefs', 'steamwebhelper', 'epicwebhelper', 'galaxyclient', 'adobeupdateservice', 'ccxprocess', 'creative cloud', 'cefsharp.browsersubprocess', 'msedgewebview2', 'widgets', 'phoneexperiencehost', 'yourphone', 'gamebar', 'gamebarftserver', 'lghub', 'lghub_agent', 'razer synapse', 'icue', 'nvidia share', 'nvcontainer'])

export function classify(name) {
  const n = String(name ?? '').toLowerCase().replace(/\.exe$/, '')
  if (PROTECTED.has(n) || SECURITY.test(n)) return { class: 'protected', why: SECURITY.test(n) ? 'software de segurança' : 'sistema Windows, este app ou a IA local' }
  if (OPTIONAL.has(n)) return { class: 'optional', why: 'aplicativo de segundo plano conhecido' }
  if (CAUTION.has(n)) return { class: 'caution', why: 'pode ter trabalho não salvo ou ser parte da área de trabalho' }
  return { class: 'unknown', why: 'finalidade não identificada' }
}

export async function listProcesses({ filter, top = 60 } = {}) {
  if (!isWindows) return []
  const f = filter ? `| Where-Object { $_.ProcessName -like '*${String(filter).replace(/[^\w .-]/g, '')}*' }` : ''
  const rows = [].concat((await psJson(`Get-Process ${f} | Sort-Object WorkingSet64 -Descending | Select-Object -First ${Math.min(top, 200)} | ForEach-Object { [pscustomobject]@{Name=$_.ProcessName;Id=$_.Id;MemMB=[math]::Round($_.WorkingSet64/1MB);Title=$_.MainWindowTitle;Path=$_.Path} } | ConvertTo-Json -Compress`, { timeoutMs: 20000 })) ?? [])
  return rows.map((r) => ({ ...r, ...classify(r.Name) }))
}

export async function processInfo(pid) {
  const id = Number(pid)
  if (!Number.isInteger(id) || id <= 4) throw new Error('pid inválido')
  if (id === process.pid || id === process.ppid) throw new Error('este processo é o próprio JARVIS; recusado')
  const r = await psJson(`$p=Get-Process -Id ${id}; [pscustomobject]@{Name=$p.ProcessName;Id=$p.Id;MemMB=[math]::Round($p.WorkingSet64/1MB);Title=$p.MainWindowTitle;Path=$p.Path} | ConvertTo-Json -Compress`, { timeoutMs: 10000 })
  return { ...r, ...classify(r.Name) }
}

const alive = async (id) => (await ps(`if (Get-Process -Id ${id} -ErrorAction SilentlyContinue) {'1'} else {'0'}`, { timeoutMs: 8000 })) === '1'

/** Asks the app to close (like clicking X); only with `force` does it kill. Always re-checks and reports what is true. */
export async function closeProcess(pid, { force = false } = {}) {
  const id = Number(pid)
  if (force) await ps(`Stop-Process -Id ${id} -Force -ErrorAction SilentlyContinue`, { timeoutMs: 10000 })
  else await ps(`$p=Get-Process -Id ${id} -ErrorAction SilentlyContinue; if ($p) { [void]$p.CloseMainWindow(); [void]$p.WaitForExit(6000) }`, { timeoutMs: 15000 })
  const still = await alive(id)
  return { exited: !still, method: force ? 'forçado' : 'fechamento normal da janela' }
}
