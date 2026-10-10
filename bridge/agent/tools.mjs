import { createHash } from 'node:crypto'
import { copyFile, mkdir, open, readdir, readFile, rename, rm, stat, writeFile } from 'node:fs/promises'
import { existsSync } from 'node:fs'
import { basename, dirname, join } from 'node:path'
import { fetchText } from '../net.mjs'
import { AgentError } from './access.mjs'
import { bigFiles, cleanupCandidates, folderSizeOf, largest } from './diskscan.mjs'
import { cleanTempFiles } from './cleantemp.mjs'
import { classify, closeProcess, listProcesses, processInfo } from './procs.mjs'
import { isWindows, ps, psJson, q } from './winps.mjs'
import { buildDevTools } from './devtools.mjs'
import { buildProfile } from './perfil.mjs'

/**
 * The agent's tools. Each one declares its permission group, its risk and, for risky ones, the sentence the owner is
 * asked to approve. A tool that changes something verifies the result itself and returns `verified: true | false | null`
 * (null = cannot be checked from here); the agent loop never takes the model's word for it.
 *   risk: 'read'   nothing changes
 *         'write'  creates/opens something, nothing is lost
 *         'danger' deletes, overwrites, closes or executes: always confirmed, or refused by a hard rule
 */
const sha1 = (b) => createHash('sha1').update(b).digest('hex')
const mb = (n) => Math.round(n / 2 ** 20)
const clip = (s, n) => (String(s).length > n ? String(s).slice(0, n) + `… [cortado, ${String(s).length} caracteres]` : String(s))

const htmlToText = (html) =>
  html
    .replace(/<(script|style|noscript|svg)[\s\S]*?<\/\1>/gi, ' ')
    .replace(/<br\s*\/?>|<\/(p|div|li|h\d|tr)>/gi, '\n')
    .replace(/<[^>]+>/g, ' ')
    .replace(/&nbsp;/g, ' ').replace(/&amp;/g, '&').replace(/&lt;/g, '<').replace(/&gt;/g, '>').replace(/&quot;/g, '"').replace(/&#39;/g, "'")
    .replace(/[ \t]+/g, ' ').replace(/\n\s*\n+/g, '\n').trim()

const DENY_COMMAND = /(format-volume|\bformat\s+[a-z]:|diskpart|bcdedit|cipher\s+\/w|vssadmin|wbadmin|reg\s+(delete|add)\s+hk(lm|cr)|set-mppreference|add-mppreference|disable-windowsoptionalfeature|remove-item[^|;]*-recurse[^|;]*\s[a-z]:\\?\s*$|stop-service|sc\s+(stop|delete|config)|net\s+user|schtasks\s+\/(delete|create)|invoke-expression|iex\b|downloadstring|invoke-webrequest[^|;]*\|\s*iex|netsh\s+(advfirewall|firewall)|takeown|icacls[^|;]*\/grant|shutdown|restart-computer|stop-computer)/i

/** @returns {Record<string, any>} the tool table, closed over the shared services */
export function buildTools({ access, monitor, profiles, env = process.env, dataDir, memory = null, profileFile, getGenUi = null, getConnectors = null }) {
  const T = {}
  const def = (name, group, risk, desc, params, run, confirm) => (T[name] = { name, group, risk, desc, params, run, confirm })

  // ------------------------------------------------------------------------- files
  def('fs_list', 'files', 'read', 'Lista o conteúdo de uma pasta liberada.', { path: 'caminho da pasta' }, async ({ path }) => {
    const p = await access.resolveInside(path)
    const out = []
    for (const e of (await readdir(p, { withFileTypes: true })).slice(0, 200)) {
      let st = null
      try { st = await stat(join(p, e.name)) } catch { /* locked */ }
      out.push({ name: e.name, type: e.isDirectory() ? 'pasta' : 'arquivo', sizeKB: st ? Math.round(st.size / 1024) : null, modified: st?.mtime.toISOString().slice(0, 16) ?? null })
    }
    return { data: { path: p, count: out.length, items: out } }
  })

  def('fs_read', 'files', 'read', 'Lê um arquivo de texto (use tail=true para o fim de um log).', { path: 'caminho do arquivo', maxKB: 'limite em KB (padrão 48)', tail: 'true para ler o final' }, async ({ path, maxKB = 48, tail = false }) => {
    const p = await access.resolveInside(path)
    const st = await stat(p)
    if (!st.isFile()) throw new AgentError('type', 'não é um arquivo')
    const cap = Math.min(Math.max(Number(maxKB) || 48, 1), 256) * 1024
    // Read only the slice that is needed, so a multi-GB file cannot exhaust memory.
    const fh = await open(p, 'r')
    try {
      const start = yes(tail) ? Math.max(0, st.size - cap) : 0
      const buf = Buffer.alloc(Math.min(cap, st.size - start))
      await fh.read(buf, 0, buf.length, start)
      if (buf.subarray(0, 4096).includes(0)) throw new AgentError('binary', 'arquivo binário: não lido como texto')
      return { data: { path: p, sizeKB: Math.round(st.size / 1024), truncated: st.size > cap, text: buf.toString('utf8') } }
    } finally {
      await fh.close()
    }
  })

  def('fs_search', 'files', 'read', 'Procura arquivos por nome (parte do nome, extensão e/ou modificados recentemente) dentro de uma pasta liberada.', { root: 'pasta onde procurar', name: 'parte do nome (opcional)', ext: 'extensão sem ponto (opcional)', modifiedWithinDays: 'só arquivos mexidos nos últimos N dias (opcional)', max: 'máximo de resultados (padrão 50)' }, async ({ root, name, ext, modifiedWithinDays, max = 50 }) => {
    const base = await access.resolveInside(root)
    const nameQ = name ? String(name).toLowerCase() : null
    const extQ = ext ? String(ext).toLowerCase().replace(/^\./, '') : null
    const since = modifiedWithinDays ? Date.now() - Number(modifiedWithinDays) * 86_400_000 : 0
    const found = []
    let seen = 0
    const deadline = Date.now() + 20_000
    const cap = Math.min(Number(max) || 50, 200)
    async function walk(dir, depth) {
      if (depth > 10 || found.length >= cap || Date.now() > deadline || seen > 300_000) return
      let entries
      try { entries = await readdir(dir, { withFileTypes: true }) } catch { return }
      for (const e of entries) {
        if (e.isSymbolicLink()) continue
        const p = join(dir, e.name)
        seen++
        if (e.isDirectory()) { await walk(p, depth + 1); continue }
        const low = e.name.toLowerCase()
        if (nameQ && !low.includes(nameQ)) continue
        if (extQ && !low.endsWith('.' + extQ)) continue
        let st
        try { st = await stat(p) } catch { continue }
        if (since && st.mtimeMs < since) continue
        found.push({ path: p, sizeKB: Math.round(st.size / 1024), modified: st.mtime.toISOString().slice(0, 16) })
        if (found.length >= cap) return
      }
    }
    await walk(base, 0)
    return { data: { root: base, results: found, searchedEntries: seen, complete: found.length < cap && Date.now() <= deadline } }
  })

  const yes = (v) => v === true || v === 'true' // "false" (a string) must not count as true
  def('fs_write', 'files', 'write', 'Cria um arquivo de texto. Sobrescrever um existente exige overwrite=true e confirmação.', { path: 'caminho completo do arquivo', content: 'texto', overwrite: 'true para sobrescrever' }, async ({ path, content = '', overwrite = false }) => {
    const p = await access.resolveInside(path)
    if (existsSync(p) && !yes(overwrite)) throw new AgentError('exists', 'o arquivo já existe (use overwrite=true para sobrescrever)')
    await mkdir(dirname(p), { recursive: true })
    const data = Buffer.from(String(content), 'utf8')
    await writeFile(p, data, { flag: yes(overwrite) ? 'w' : 'wx' }) // wx: never overwrite a file that appeared after the check
    const back = await readFile(p)
    return { data: { path: p, bytes: data.length }, verified: sha1(back) === sha1(data) && existsSync(p), evidence: `existe=${existsSync(p)}, ${back.length} bytes, sha1 confere` }
  }, async ({ path, overwrite }) => {
    const p = await access.resolveInside(path)
    if (yes(overwrite) && existsSync(p)) return `Sobrescrever o arquivo existente ${path}? O conteúdo atual será perdido (não vai para a Lixeira).`
    // A new script/shortcut can run later (Startup folders, double-click): always ask.
    if (/\.(bat|cmd|ps1|psm1|vbs|vbe|js|jse|wsf|lnk|exe|scr|msi|reg|hta)$/i.test(p)) return `Criar o arquivo executável ${p}? Ele pode rodar código se for aberto.`
    return null
  })

  def('fs_mkdir', 'files', 'write', 'Cria uma pasta.', { path: 'caminho da pasta' }, async ({ path }) => {
    const p = await access.resolveInside(path)
    await mkdir(p, { recursive: true })
    return { data: { path: p }, verified: existsSync(p), evidence: `existe=${existsSync(p)}` }
  })

  def('fs_move', 'files', 'write', 'Move ou renomeia um arquivo/pasta. O destino não pode existir.', { from: 'origem', to: 'destino completo' }, async ({ from, to }) => {
    const a = await access.resolveInside(from)
    const b = await access.resolveInside(to)
    if (!existsSync(a)) throw new AgentError('missing', 'a origem não existe')
    if (existsSync(b)) throw new AgentError('exists', 'o destino já existe; nada foi alterado')
    await mkdir(dirname(b), { recursive: true })
    try {
      await rename(a, b)
    } catch (e) {
      if (e.code !== 'EXDEV' || (await stat(a)).isDirectory()) throw e
      await copyFile(a, b)
      await rm(a)
    }
    return { data: { from: a, to: b }, verified: existsSync(b) && !existsSync(a), evidence: `destino existe=${existsSync(b)}, origem some=${!existsSync(a)}` }
  })

  def('fs_delete', 'files', 'danger', 'Apaga um arquivo ou pasta liberada. Por padrão vai para a Lixeira (reversível); permanent=true apaga de vez.', { path: 'caminho', permanent: 'true para apagar definitivamente' }, async ({ path, permanent: perm = false }) => {
    const permanent = yes(perm)
    const p = await access.resolveInside(path)
    if (!existsSync(p)) throw new AgentError('missing', 'não existe')
    const isDir = (await stat(p)).isDirectory()
    if (permanent) await rm(p, { recursive: true, force: false })
    else if (isWindows) await ps(`Add-Type -AssemblyName Microsoft.VisualBasic; $p=${q(p)}; if (Test-Path -LiteralPath $p -PathType Container) { [Microsoft.VisualBasic.FileIO.FileSystem]::DeleteDirectory($p,'OnlyErrorDialogs','SendToRecycleBin') } else { [Microsoft.VisualBasic.FileIO.FileSystem]::DeleteFile($p,'OnlyErrorDialogs','SendToRecycleBin') }`, { timeoutMs: 30000 })
    else await rm(p, { recursive: true })
    return { data: { path: p, to: permanent ? 'apagado definitivamente' : 'Lixeira' }, verified: !existsSync(p), evidence: `não existe mais=${!existsSync(p)}`, wasDir: isDir }
  }, async ({ path, permanent: perm }) => {
    const permanent = yes(perm)
    const p = await access.resolveInside(path)
    let what = p
    try {
      const st = await stat(p)
      const fz = st.isDirectory() ? await folderSizeOf(p) : null
      what = fz ? `a pasta ${p} (${fz.partial ? 'pelo menos ' : ''}${fz.files} arquivos, ${fz.partial ? 'pelo menos ' : ''}${mb(fz.bytes)} MB)` : `o arquivo ${p} (${mb(st.size)} MB)`
    } catch { /* missing: run() will say so */ }
    return `Apagar ${what}? ${permanent ? 'DEFINITIVAMENTE, sem passar pela Lixeira.' : 'Vai para a Lixeira (dá para restaurar).'}`
  })

  def('temp_clean', 'files', 'danger', 'Apaga arquivos temporários do usuário (pasta TEMP) com mais de N dias. Arquivos em uso são pulados.', { days: 'idade mínima em dias (padrão 3)' }, async ({ days = 3 }) => {
    const r = await cleanTempFiles(env.TEMP, Math.max(Number(days) || 3, 1))
    // "verified" only when something was really removed; with nothing removed there is nothing to claim.
    return { data: r, verified: r.removed > 0 ? true : null, evidence: `${r.removed} arquivos removidos, ${r.skipped} pulados (em uso ou protegidos), ${r.freedMB} MB liberados` }
  }, async ({ days = 3 }) => `Apagar arquivos temporários com mais de ${days} dia(s) em ${env.TEMP}? (o Windows recria o que precisar; o que estiver em uso é pulado)`)

  // ------------------------------------------------------------------------- web
  def('web_search', 'web', 'read', 'Pesquisa na internet (DuckDuckGo) e devolve títulos, links e trechos.', { query: 'o que pesquisar', max: 'resultados (padrão 6)' }, async ({ query, max = 6 }) => {
    const { text } = await fetchText(`https://lite.duckduckgo.com/lite/?q=${encodeURIComponent(String(query).slice(0, 200))}`, { maxBytes: 400_000, timeoutMs: 12_000 })
    const results = []
    const re = /<a[^>]+class=['"]result-link['"][^>]*href=['"]([^'"]+)['"][^>]*>([\s\S]*?)<\/a>|<a[^>]+href=['"]([^'"]+)['"][^>]*class=['"]result-link['"][^>]*>([\s\S]*?)<\/a>/gi
    const snippets = [...text.matchAll(/class=['"]result-snippet['"][^>]*>([\s\S]*?)<\/td>/gi)].map((m) => htmlToText(m[1]))
    let m, i = 0
    while ((m = re.exec(text)) && results.length < Math.min(Number(max) || 6, 10)) {
      const raw = (m[1] ?? m[3]).replace(/&amp;/g, '&')
      const u = /uddg=([^&]+)/.exec(raw)
      results.push({ title: htmlToText(m[2] ?? m[4]), url: u ? decodeURIComponent(u[1]) : raw.replace(/^\/\//, 'https://'), snippet: snippets[i++] ?? '' })
    }
    if (!results.length) throw new AgentError('search', 'a busca não devolveu resultados legíveis (pode ser bloqueio do site ou mudança no formato)')
    return { data: { query, results, source: 'lite.duckduckgo.com (HTML), não é uma API oficial e pode falhar' } }
  })

  def('web_fetch', 'web', 'read', 'Baixa uma página web pública e devolve o texto (sem scripts). Endereços internos/privados são bloqueados.', { url: 'endereço http(s)', maxChars: 'limite de caracteres (padrão 6000)' }, async ({ url, maxChars = 6000 }) => {
    const r = await fetchText(url, { maxBytes: 1_500_000, timeoutMs: 12_000 })
    return { data: { url: r.url, text: clip(/html/i.test(r.type) ? htmlToText(r.text) : r.text, Math.min(Number(maxChars) || 6000, 20000)) } }
  })

  def('url_open', 'web', 'write', 'Abre um endereço http(s) no navegador padrão.', { url: 'endereço http(s)' }, async ({ url }) => {
    const u = new URL(String(url))
    if (!/^https?:$/.test(u.protocol)) throw new AgentError('url', 'só http(s)')
    if (!isWindows) throw new AgentError('platform', 'só no Windows')
    await ps(`Start-Process ${q(u.href)}`, { timeoutMs: 10000 })
    return { data: { url: u.href }, verified: null, evidence: 'o pedido de abertura foi enviado ao Windows; não há como confirmar a janela a partir daqui' }
  })

  // ------------------------------------------------------------------------- apps
  def('app_list', 'apps', 'read', 'Lista aplicativos instalados (menu Iniciar), opcionalmente filtrando pelo nome.', { filter: 'parte do nome' }, async ({ filter = '' }) => {
    const f = String(filter).replace(/[^\w .+-]/g, '')
    const rows = [].concat((await psJson(`Get-StartApps | Where-Object { $_.Name -like '*${f}*' } | Select-Object -First 40 Name,AppID | ConvertTo-Json -Compress`, { timeoutMs: 20000 })) ?? [])
    return { data: { apps: rows } }
  })

  def('app_open', 'apps', 'write', 'Abre um aplicativo instalado pelo nome (ex.: Discord) ou por um caminho .exe/.lnk existente.', { name: 'nome do aplicativo', path: 'ou caminho do executável' }, async ({ name, path }) => {
    if (!isWindows) throw new AgentError('platform', 'só no Windows')
    if (path) {
      if (/^[\\/]{2}/.test(String(path))) throw new AgentError('unc', 'caminhos de rede/UNC não são aceitos')
      if (!/\.(exe|lnk)$/i.test(path) || !existsSync(path)) throw new AgentError('path', 'o caminho precisa ser um .exe/.lnk existente')
      await ps(`Start-Process -FilePath ${q(path)}`, { timeoutMs: 15000 })
      return { data: { opened: path }, verified: null, evidence: 'iniciado por caminho; sem como identificar a janela' }
    }
    const n = String(name ?? '').trim()
    if (!n) throw new AgentError('args', 'informe name ou path')
    const apps = [].concat((await psJson(`Get-StartApps | Where-Object { $_.Name -like ${q('*' + n + '*')} } | Select-Object Name,AppID | ConvertTo-Json -Compress`, { timeoutMs: 20000 })) ?? [])
    if (!apps.length) throw new AgentError('missing', `nenhum aplicativo instalado parece "${n}"`)
    const best = apps.find((a) => a.Name.toLowerCase() === n.toLowerCase()) ?? apps[0]
    await ps(`Start-Process explorer.exe ${q('shell:AppsFolder\\' + best.AppID)}`, { timeoutMs: 15000 })
    // Verify: a window or process that matches the name must show up.
    const key = best.Name.split(/[\s.]/)[0].replace(/[^\w]/g, '')
    let seen = false
    for (let i = 0; i < 8 && !seen; i++) {
      await new Promise((r) => setTimeout(r, 1000))
      seen = (await ps(`if (Get-Process | Where-Object { $_.ProcessName -like '*${key}*' -or $_.MainWindowTitle -like '*${key}*' }) {'1'} else {'0'}`, { timeoutMs: 8000 }).catch(() => '0')) === '1'
    }
    return { data: { app: best.Name, otherMatches: apps.slice(0, 5).map((a) => a.Name) }, verified: seen, evidence: seen ? `processo/janela "${key}" encontrado` : `não vi nenhum processo ou janela "${key}" em 8 s (pode ter aberto sob outro nome)` }
  }, async ({ path }) => (path ? `Executar o programa ${path}? (aberto por caminho, fora da lista de aplicativos instalados)` : null))

  // ------------------------------------------------------------------------- system (read only)
  def('sys_summary', 'system', 'read', 'Resumo do computador: CPU, RAM, tempo ligado e discos (valores medidos agora).', {}, async () => ({ data: { ...monitor.summary(), disks: await monitor.disks().catch((e) => ({ error: e.message })), diskActivity: await monitor.diskActivity() } }))
  def('sys_top', 'system', 'read', 'Processos que mais consomem memória (by=memory) ou CPU (by=cpu, mede 1 s).', { by: 'memory | cpu', n: 'quantos (padrão 10)' }, async ({ by = 'memory', n = 10 }) => ({ data: { by, processes: (await monitor.topProcesses(by === 'cpu' ? 'cpu' : 'memory', n)).map((p) => ({ ...p, ...classify(p.Name) })) } }))
  def('sys_temperature', 'system', 'read', 'Temperatura da CPU/GPU, só se o PC expuser o sensor; senão diz que não está disponível.', {}, async () => ({ data: await monitor.temperature() }))
  def('monitor_report', 'system', 'read', 'Relatório de uso de CPU e RAM nos últimos N minutos (média, máximo, mínimo) a partir das amostras reais.', { minutes: 'janela em minutos (padrão 30)' }, async ({ minutes = 30 }) => ({ data: monitor.report(Math.min(Math.max(Number(minutes) || 30, 1), 60)) }))
  def('disk_report', 'system', 'read', 'Espaço dos discos (total/usado/livre) e candidatos reais a limpeza com tamanhos.', {}, async () => ({ data: { disks: await monitor.disks(), cleanupCandidates: await cleanupCandidates(env) } }))
  def('disk_largest', 'system', 'read', 'Quais itens de uma pasta ocupam mais espaço (só leitura de tamanhos).', { path: 'pasta a analisar', top: 'quantos (padrão 15)' }, async ({ path, top = 15 }) => ({ data: await largest(await access.resolveAny(path), { top: Math.min(Number(top) || 15, 40) }) }))
  def('disk_big_files', 'system', 'read', 'Arquivos grandes dentro de uma pasta (só leitura).', { path: 'pasta', minMB: 'tamanho mínimo em MB (padrão 500)' }, async ({ path, minMB = 500 }) => ({ data: await bigFiles(await access.resolveAny(path), { minMB: Math.max(Number(minMB) || 500, 50) }) }))
  def('mem_snapshot', 'system', 'read', 'Foto da memória agora (use antes e depois de uma otimização para comparar).', {}, async () => ({ data: { ...monitor.summary().memory, top: (await monitor.topProcesses('memory', 5)).map((p) => `${p.Name} ${p.MemMB} MB`) } }))
  def('mc_locate', 'system', 'read', 'Procura instalações/instâncias do Minecraft (launcher oficial, CurseForge, Prism, MultiMC, ATLauncher, Modrinth) e diz se têm mods e crash-reports.', {}, async () => {
    const kf = await access.knownFolders()
    const home = kf['%HOME%'], roaming = kf['%APPDATA%']
    const bases = [[join(roaming, '.minecraft'), 'Launcher oficial'], [join(home, 'curseforge', 'minecraft', 'Instances'), 'CurseForge', true], [join(home, 'Documents', 'curseforge', 'minecraft', 'Instances'), 'CurseForge', true], [join(roaming, 'PrismLauncher', 'instances'), 'Prism', true], [join(roaming, 'MultiMC', 'instances'), 'MultiMC', true], [join(roaming, 'ATLauncher', 'instances'), 'ATLauncher', true], [join(roaming, 'ModrinthApp', 'profiles'), 'Modrinth', true]]
    const found = []
    for (const [dir, launcher, many] of bases) {
      if (!existsSync(dir)) continue
      const roots = many ? (await readdir(dir, { withFileTypes: true })).filter((e) => e.isDirectory()).map((e) => join(dir, e.name)) : [dir]
      for (const r of roots) {
        const inner = existsSync(join(r, 'minecraft')) ? join(r, 'minecraft') : existsSync(join(r, '.minecraft')) ? join(r, '.minecraft') : r
        found.push({ launcher, name: basename(r), path: inner, mods: existsSync(join(inner, 'mods')), crashReports: existsSync(join(inner, 'crash-reports')), latestLog: existsSync(join(inner, 'logs', 'latest.log')) })
      }
    }
    return { data: { found, hint: 'Para ler ou alterar uma instância, libere a pasta dela na tela Agente (a descoberta acima é só leitura de nomes).' } }
  })

  // ------------------------------------------------------------------------- processes
  def('proc_list', 'processes', 'read', 'Lista processos com a classificação de segurança (protected/caution/optional/unknown).', { filter: 'parte do nome (opcional)' }, async ({ filter }) => ({ data: { processes: (await listProcesses({ filter, top: 60 })).map((p) => ({ pid: p.Id, name: p.Name, memMB: p.MemMB, window: p.Title || null, class: p.class, why: p.why })) } }))
  def('proc_close', 'processes', 'danger', 'Fecha um aplicativo pelo pid (primeiro o pedido normal de fechar; force=true só se ele não fechar e com nova confirmação). Processos protegidos são recusados.', { pid: 'número do processo', force: 'true para forçar' }, async ({ pid, force = false }) => {
    const info = await processInfo(pid)
    if (info.class === 'protected') throw new AgentError('protected', `${info.Name} é protegido (${info.why}); recusado`)
    const r = await closeProcess(pid, { force: yes(force) })
    return { data: { name: info.Name, ...r }, verified: r.exited, evidence: r.exited ? `${info.Name} (pid ${pid}) não existe mais` : `${info.Name} continua aberto` }
  }, async ({ pid, force: f0 }) => {
    const force = yes(f0)
    const info = await processInfo(pid)
    if (info.class === 'protected') return null // run() refuses it with a clear error; no point asking
    return `${force ? 'FORÇAR o encerramento de' : 'Fechar'} ${info.Name} (pid ${pid}, ${info.MemMB} MB${info.Title ? `, janela "${info.Title}"` : ''}; ${info.why})? ${info.class === 'optional' && !force ? '' : 'Pode haver trabalho não salvo.'}`
  })

  // ------------------------------------------------------------------------- commands
  def('run_command', 'commands', 'danger', 'Executa um comando do PowerShell (60 s). Sempre com confirmação; comandos destrutivos do sistema são recusados.', { command: 'comando PowerShell' }, async ({ command }) => {
    const c = String(command ?? '')
    if (!c.trim() || c.length > 600) throw new AgentError('args', 'comando vazio ou longo demais (máximo 600 caracteres, para que a confirmação mostre tudo)')
    if (DENY_COMMAND.test(c)) throw new AgentError('denied', 'comando recusado pela regra de segurança (altera disco, serviços, segurança ou rede do Windows)')
    const out = await ps(c, { timeoutMs: 60_000 })
    return { data: { output: clip(out, 4000) }, verified: null, evidence: 'executado; confira a saída' }
  }, async ({ command }) => `Executar no PowerShell exatamente isto: ${String(command)}`)

  // ------------------------------------------------------------------------- profiles
  def('profile_prepare', 'processes', 'read', 'Modo game, passo 1 (leitura): lista o que poderia ser fechado e quanta RAM libera. Nada é fechado.', { game: 'nome do jogo (opcional, nunca é listado para fechar)' }, async ({ game }) => ({ data: await profiles.prepare({ profile: 'game', game }) }))
  def('profile_apply', 'processes', 'danger', 'Modo game, passo 2: fecha (pedido normal) exatamente os pids aprovados e registra para reabrir depois.', { pids: 'lista de pids vindos de profile_prepare', game: 'nome do jogo' }, async ({ pids = [], game }) => {
    const list = [].concat(pids).map(Number).filter(Number.isInteger).slice(0, 25)
    const r = await profiles.apply({ profile: 'game', pids: list, game })
    return { data: r, verified: r.results.length > 0 && r.results.every((x) => x.ok || /recusado|não existe/.test(x.reason ?? '')), evidence: `${r.results.filter((x) => x.ok).length} fechado(s); RAM livre ${r.freeGBBefore} → ${r.freeGBAfter} GB` }
  }, async ({ pids = [] }) => {
    const ids = [].concat(pids).map(Number).filter(Number.isInteger)
    const names = (await listProcesses({ top: 200 }).catch(() => [])).filter((p) => ids.includes(p.Id)).map((p) => `${p.Name} (${p.MemMB} MB)`)
    return `Fechar para o modo game: ${names.join(', ') || ids.join(', ')}? Cada um é fechado do jeito normal, nada é forçado, e trabalho não salvo neles pode ser perdido.`
  })
  def('profile_status', 'system', 'read', 'Estado do modo game e RAM liberada até agora.', {}, async () => ({ data: await profiles.status() }))
  def('profile_stop', 'processes', 'write', 'Encerra o modo game e lista o que foi fechado para reabrir.', {}, async () => ({ data: await profiles.stop(), verified: null, evidence: 'o modo foi encerrado; reabrir os programas listados é com o usuário' }))

  // ------------------------------------------------------------------------- development + screen (devtools.mjs)
  Object.assign(T, buildDevTools({ access, env, dataDir }))

  // ------------------------------------------------------------------------- generative panels (command/genui.mjs)
  // A panel is declarative data, never code. These tools only register/update it; what its buttons do goes through the normal tools and confirmations.
  if (getGenUi) {
    const ui = () => { const g = getGenUi(); if (!g) throw new AgentError('unavailable', 'painéis indisponíveis'); return g }
    const created = (r) => {
      if (!r.ok) throw new AgentError('spec', `especificação inválida: ${r.message ?? r.errors?.map((e) => `${e.path}: ${e.msg}`).join('; ')}`)
      return { data: { panelId: r.id, warnings: (r.warnings ?? []).slice(0, 5).map((w) => `${w.path}: ${w.msg}`), note: 'painel criado; o usuário o vê na tela Painéis' }, verified: true, evidence: `painel ${r.id} registrado` }
    }
    def('ui_catalog', 'ui', 'read', 'Lista os componentes e o formato da especificação de painéis (use antes de ui_show).', {}, async () => ({ data: { catalog: ui().CATALOG } }))
    def('ui_quick', 'ui', 'read', 'Cria um painel pronto a partir de DADOS reais que você já tem: kind = table | bar | hbar | line | area | pie | donut | compare | stats | files | steps | log. Prefira este a ui_show.', { kind: 'tipo do painel', title: 'título', data: 'lista de objetos (linhas) ou de textos (log)', columns: 'colunas opcionais', x: 'chave do eixo X/categoria', series: 'chaves numéricas', unit: 'unidade', purpose: 'para que serve', note: 'aviso opcional' }, async (a) => created(await ui().quick(a, { owner: { kind: 'agent' } })))
    def('ui_show', 'ui', 'read', 'Cria um painel a partir de uma especificação JSON completa (veja ui_catalog). Para interfaces que ui_quick não cobre: formulários, abas, painéis com fontes de dados vivas e botões.', { spec: 'objeto JSON da especificação' }, async ({ spec }) => created(await ui().create(typeof spec === 'string' ? JSON.parse(spec) : spec, { owner: { kind: 'agent' } })))
    def('ui_update', 'ui', 'read', 'Atualiza um painel existente sem recriá-lo: ops = [{op:"setData",name,value} | {op:"appendData",name,value} | {op:"setStatus",status:"loading|ready|error|done",text} | {op:"patchNode",id,props} | {op:"addNode",parent,node} | {op:"removeNode",id} | {op:"setState",values}].', { id: 'id do painel', ops: 'lista de operações' }, async ({ id, ops }) => {
      const r = await ui().update(String(id), typeof ops === 'string' ? JSON.parse(ops) : ops)
      if (!r.ok) throw new AgentError('spec', `atualização recusada: ${r.message ?? r.errors?.map((e) => `${e.path}: ${e.msg}`).join('; ')}`)
      return { data: r, verified: true, evidence: `painel ${id} na revisão ${r.specRev}` }
    })
    def('ui_close', 'ui', 'read', 'Fecha um painel que não é mais necessário.', { id: 'id do painel' }, async ({ id }) => ({ data: { closed: await ui().close(String(id)) } }))
  }
  // ------------------------------------------------------------------------- connectors (conectores.mjs adds each connected service's own tools)
  if (getConnectors) {
    def('conector_lista', 'connectors', 'read', 'Lista os conectores (serviços externos como GitHub, Notion, Slack): quais estão ligados, se podem alterar algo e o que falta configurar. Use quando o usuário pedir algo de um serviço externo que não aparece nas ferramentas.', {}, async () => {
      const c = getConnectors()
      if (!c) throw new AgentError('unavailable', 'conectores indisponíveis')
      return { data: { note: 'quem liga e configura os conectores é o usuário, na tela Conectores', connectors: c.list().map((x) => ({ id: x.id, name: x.label, category: x.category, state: x.enabled ? (x.write ? 'ligado, pode alterar (com confirmação)' : 'ligado, só leitura') : x.ready ? 'configurado, desligado' : `precisa de configuração: ${x.missing.join(', ')}`, tools: x.enabled ? x.tools.filter((t) => x.write || t.risk === 'read').map((t) => t.name) : undefined })) } }
    })
  }
  // ------------------------------------------------------------------------- memory + self-profile
  if (memory) {
    def('memory_remember', 'system', 'write', 'Guarda na memória operacional algo aprendido: kind = fact (confirmado), hypothesis (NÃO confirmado), decision, error ou solution. Nunca guarde senhas ou chaves.', { kind: 'fact|hypothesis|decision|error|solution', text: 'o que lembrar (curto)', confidence: 'confirmed|probable|unverified', tags: 'lista de palavras-chave' }, async ({ kind, text, confidence, tags }) => {
      const e = await memory.remember({ kind, text, confidence, tags: [].concat(tags ?? []), source: 'agente' })
      return { data: e, verified: true, evidence: `guardado  (, )` }
    })
    def('memory_recall', 'system', 'read', 'Consulta a memória operacional por palavras-chave (erros já vistos, soluções, decisões).', { query: 'palavras-chave', limit: 'máx. resultados (padrão 6)' }, async ({ query, limit = 6 }) => ({ data: { items: await memory.recall(String(query ?? ''), { limit: Number(limit) || 6 }) } }))
  }
  def('jarvis_perfil', 'system', 'read', 'Perfil completo do JARVIS: personalidade e TODAS as capacidades (texto) mais a tabela ao vivo de ferramentas e o que está ligado. Use quando perguntarem o que você sabe/pode fazer.', {}, async () => ({ data: { profile: buildProfile({ tools: T, access, file: profileFile }) } }))

  return T
}
