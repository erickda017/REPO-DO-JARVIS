import { execFile } from 'node:child_process'
import { existsSync, readdirSync, readFileSync, statSync } from 'node:fs'
import { homedir, networkInterfaces } from 'node:os'
import { basename, extname, join } from 'node:path'
import { AgentError } from './access.mjs'
import { isWindows, ps, psJson } from './winps.mjs'
import { THEMES, TOGGLES, VIEWS, findTheme, findToggle, findView } from './interface.mjs'

const yes = (v) => v === true || v === 'true' || v === 1 || v === '1'
const clamp = (n, lo, hi) => Math.min(Math.max(Number(n) || 0, lo), hi)
const MB = (n) => Math.round((n / 2 ** 20) * 10) / 10

const FOLDERS = { downloads: 'Downloads', transferencias: 'Downloads', documentos: 'Documents', documents: 'Documents', desktop: 'Desktop', 'area de trabalho': 'Desktop', imagens: 'Pictures', fotos: 'Pictures', pictures: 'Pictures', musicas: 'Music', musica: 'Music', videos: 'Videos' }
const KEY_FILES = ['README.md', 'README', 'readme.md', 'package.json', 'pyproject.toml', 'requirements.txt', 'setup.py', 'Cargo.toml', 'go.mod', 'pom.xml', 'build.gradle', 'Gemfile', 'composer.json', 'Dockerfile', 'docker-compose.yml', 'Makefile', 'tsconfig.json', 'vite.config.ts', '.env.example', 'LICENSE', 'CONTRIBUTING.md', '.gitignore']
const SKIP = new Set(['node_modules', '.git', '.venv', 'venv', '__pycache__', 'dist', 'build', 'target', '.next', 'coverage', '.cache', '.idea', '.vscode', 'bin', 'obj'])
const LANG = { '.js': 'JavaScript', '.mjs': 'JavaScript', '.cjs': 'JavaScript', '.jsx': 'JavaScript (React)', '.ts': 'TypeScript', '.tsx': 'TypeScript (React)', '.py': 'Python', '.java': 'Java', '.cs': 'C#', '.cpp': 'C++', '.c': 'C', '.h': 'C/C++', '.go': 'Go', '.rs': 'Rust', '.php': 'PHP', '.rb': 'Ruby', '.kt': 'Kotlin', '.swift': 'Swift', '.html': 'HTML', '.css': 'CSS', '.scss': 'CSS', '.json': 'JSON', '.md': 'Markdown', '.ps1': 'PowerShell', '.bat': 'Batch', '.sh': 'Shell', '.sql': 'SQL', '.yml': 'YAML', '.yaml': 'YAML', '.lua': 'Lua', '.dart': 'Dart', '.vue': 'Vue' }

/** Ready-made commands as tools: simple, fast, no AI needed to compose them. The risky ones always confirm. */
export function buildControlTools({ access, monitor = null, env = process.env, uiBus, getIa, clock = Date.now }) {
  const T = {}
  const def = (name, group, risk, desc, params, run, confirm) => (T[name] = { name, group, risk, desc, params, run, confirm })
  const home = env.USERPROFILE || homedir()
  const sendKeys = (codes) => ps(`$w = New-Object -ComObject WScript.Shell; ${codes.map((c) => `$w.SendKeys([char]${c})`).join('; ')}`, { timeoutMs: 15000 })

  def('clock_now', 'system', 'read', 'Data e hora atuais do computador (fuso local).', {}, async () => {
    const d = new Date(clock())
    return { data: { iso: d.toISOString(), hora: d.toLocaleTimeString('pt-BR', { hour: '2-digit', minute: '2-digit' }), data: d.toLocaleDateString('pt-BR', { weekday: 'long', day: 'numeric', month: 'long', year: 'numeric' }) } }
  })

  def('network_info', 'system', 'read', 'Endereços de rede do computador (IPv4 local) e nome da máquina.', {}, async () => {
    const out = []
    for (const [name, list] of Object.entries(networkInterfaces())) for (const a of list ?? []) if (a.family === 'IPv4' && !a.internal) out.push({ adaptador: name, ip: a.address })
    return { data: { host: env.COMPUTERNAME ?? null, enderecos: out } }
  })

  def('battery_info', 'system', 'read', 'Bateria: carga e se está na tomada (só em notebooks).', {}, async () => {
    if (!isWindows) throw new AgentError('platform', 'só no Windows')
    const b = await psJson('Get-CimInstance Win32_Battery | Select-Object EstimatedChargeRemaining,BatteryStatus | ConvertTo-Json -Compress', { timeoutMs: 10000 })
    if (!b) return { data: { disponivel: false, note: 'Este computador não tem bateria (ou ela não é exposta ao Windows).' } }
    const x = [].concat(b)[0]
    return { data: { disponivel: true, cargaPct: x.EstimatedChargeRemaining, naTomada: [2, 3, 6, 7, 8, 9, 11].includes(x.BatteryStatus) } }
  })

  // ------------------------------------------------------------------------- sound, media, screen, lock, folders
  def('volume_control', 'control', 'write', 'Volume do Windows: action = set (com level 0-100), up, down, mute (liga/desliga o mudo).', { action: 'set | up | down | mute', level: 'porcentagem para set', steps: 'quantos passos de 2% para up/down (padrão 5 = 10%)' }, async ({ action, level, steps = 5 }) => {
    if (!isWindows) throw new AgentError('platform', 'só no Windows')
    const a = String(action ?? '').toLowerCase()
    if (a === 'mute') await sendKeys([173])
    else if (a === 'up' || a === 'down') await sendKeys(Array(clamp(steps, 1, 50)).fill(a === 'up' ? 175 : 174))
    else if (a === 'set') { const n = clamp(level, 0, 100); await sendKeys([...Array(50).fill(174), ...Array(Math.round(n / 2)).fill(175)]) }
    else throw new AgentError('args', 'action deve ser set, up, down ou mute')
    return { data: { action: a, ...(a === 'set' ? { level: clamp(level, 0, 100) } : {}) }, verified: null, evidence: 'teclas de volume enviadas ao Windows; o nível exato não pode ser lido daqui' }
  })

  const MEDIA = { play_pause: 179, pause: 179, play: 179, next: 176, prev: 177, previous: 177, stop: 178 }
  def('media_key', 'control', 'write', 'Tecla de mídia (vale para Spotify, YouTube, qualquer player): key = play_pause | next | prev | stop.', { key: 'play_pause | next | prev | stop' }, async ({ key }) => {
    if (!isWindows) throw new AgentError('platform', 'só no Windows')
    const code = MEDIA[String(key ?? '').toLowerCase()]
    if (!code) throw new AgentError('args', 'key deve ser play_pause, next, prev ou stop')
    await sendKeys([code])
    return { data: { key }, verified: null, evidence: 'tecla de mídia enviada; o player precisa estar aberto' }
  })

  def('screenshot', 'control', 'write', 'Tira um print de todas as telas e salva em Imagens\\JARVIS. Devolve o caminho do arquivo.', {}, async () => {
    if (!isWindows) throw new AgentError('platform', 'só no Windows')
    const file = await ps("Add-Type -AssemblyName System.Windows.Forms,System.Drawing; $b=[System.Windows.Forms.SystemInformation]::VirtualScreen; $bmp=New-Object System.Drawing.Bitmap $b.Width,$b.Height; $g=[System.Drawing.Graphics]::FromImage($bmp); $g.CopyFromScreen($b.Left,$b.Top,0,0,$bmp.Size); $dir=Join-Path ([Environment]::GetFolderPath('MyPictures')) 'JARVIS'; New-Item -ItemType Directory -Force $dir | Out-Null; $f=Join-Path $dir ('print-' + (Get-Date -Format 'yyyyMMdd-HHmmss') + '.png'); $bmp.Save($f,[System.Drawing.Imaging.ImageFormat]::Png); $g.Dispose(); $bmp.Dispose(); $f", { timeoutMs: 20000 })
    const ok = existsSync(file) && statSync(file).size > 0
    return { data: { arquivo: file, sizeKB: ok ? Math.round(statSync(file).size / 1024) : 0 }, verified: ok, evidence: ok ? `arquivo criado: ${file}` : 'o arquivo não foi criado' }
  })

  def('lock_pc', 'control', 'write', 'Bloqueia a sessão do Windows (tela de login).', {}, async () => {
    if (!isWindows) throw new AgentError('platform', 'só no Windows')
    await new Promise((res, rej) => execFile('rundll32.exe', ['user32.dll,LockWorkStation'], { windowsHide: true, timeout: 8000 }, (e) => (e ? rej(new AgentError('lock', 'o Windows não bloqueou a sessão')) : res())))
    return { data: { locked: true }, verified: null, evidence: 'pedido de bloqueio enviado ao Windows' }
  })

  def('folder_open', 'control', 'write', 'Abre uma pasta no Explorer: where = downloads | documentos | desktop | imagens | musicas | videos, ou um caminho completo existente.', { where: 'nome da pasta conhecida ou caminho' }, async ({ where }) => {
    if (!isWindows) throw new AgentError('platform', 'só no Windows')
    const key = String(where ?? '').toLowerCase().normalize('NFD').replace(/[̀-ͯ]/g, '').trim()
    let target = FOLDERS[key] ? join(home, FOLDERS[key]) : String(where ?? '').trim().replace(/^["']|["']$/g, '')
    if (/^[\\/]{2}/.test(target)) throw new AgentError('unc', 'caminhos de rede/UNC não são aceitos')
    if (FOLDERS[key] && !existsSync(target)) for (const alt of [join(home, 'OneDrive', FOLDERS[key]), join(home, 'OneDrive', { Documents: 'Documentos', Pictures: 'Imagens', Music: 'Músicas', Videos: 'Vídeos' }[FOLDERS[key]] ?? FOLDERS[key])]) if (existsSync(alt)) { target = alt; break }
    if (!existsSync(target) || !statSync(target).isDirectory()) throw new AgentError('missing', `a pasta "${where}" não existe`)
    await new Promise((res) => execFile('explorer.exe', [target], { windowsHide: false }, () => res())) // explorer exits non-zero even on success
    return { data: { pasta: target }, verified: null, evidence: 'Explorer aberto na pasta' }
  })

  def('recycle_empty', 'control', 'danger', 'Esvazia a Lixeira do Windows (não dá para desfazer).', {}, async () => {
    if (!isWindows) throw new AgentError('platform', 'só no Windows')
    await ps('Clear-RecycleBin -Force -ErrorAction SilentlyContinue', { timeoutMs: 60000 })
    return { data: { emptied: true }, verified: null, evidence: 'comando de esvaziar a Lixeira executado' }
  }, async () => 'Esvaziar a Lixeira? Os arquivos nela serão apagados de vez, sem como recuperar.')

  def('power_action', 'control', 'danger', 'Desliga, reinicia, suspende o computador ou cancela um desligamento agendado: action = shutdown | restart | sleep | cancel; delaySec = atraso em segundos (padrão 30).', { action: 'shutdown | restart | sleep | cancel', delaySec: 'segundos até executar (padrão 30)' }, async ({ action, delaySec = 30 }) => {
    if (!isWindows) throw new AgentError('platform', 'só no Windows')
    const a = String(action ?? '').toLowerCase()
    const t = clamp(delaySec, 0, 3600)
    const run = (file, args) => new Promise((res, rej) => execFile(file, args, { windowsHide: true, timeout: 10000 }, (e) => (e ? rej(new AgentError('power', 'o Windows recusou o comando')) : res())))
    if (a === 'shutdown') await run('shutdown.exe', ['/s', '/t', String(t), '/c', 'Desligamento pedido ao JARVIS. Para cancelar: shutdown /a'])
    else if (a === 'restart') await run('shutdown.exe', ['/r', '/t', String(t), '/c', 'Reinício pedido ao JARVIS. Para cancelar: shutdown /a'])
    else if (a === 'sleep') await run('rundll32.exe', ['powrprof.dll,SetSuspendState', '0,1,0'])
    else if (a === 'cancel') await run('shutdown.exe', ['/a'])
    else throw new AgentError('args', 'action deve ser shutdown, restart, sleep ou cancel')
    return { data: { action: a, delaySec: a === 'shutdown' || a === 'restart' ? t : 0 }, verified: null, evidence: a === 'cancel' ? 'pedido de cancelamento enviado' : 'pedido enviado ao Windows' }
  }, async ({ action, delaySec = 30 }) => {
    const a = String(action ?? '').toLowerCase()
    return a === 'cancel' ? null : `${{ shutdown: 'DESLIGAR', restart: 'REINICIAR', sleep: 'SUSPENDER' }[a] ?? a} o computador${a === 'sleep' ? ' agora' : ` em ${clamp(delaySec, 0, 3600)} s`}? Trabalho não salvo pode ser perdido.`
  })

  // ------------------------------------------------------------------------- folder analysis, no AI
  def('project_overview', 'files', 'read', 'Analisa uma pasta/projeto SEM usar IA: tamanho, tipos de arquivo, linguagens, arquivos-chave, descrição do package.json, início do README, maiores arquivos. Se a pasta ainda não estiver liberada, pede ao dono para liberar.', { path: 'caminho da pasta', maxFiles: 'limite de arquivos varridos (padrão 6000)' }, async ({ path, maxFiles = 6000 }) => {
    let root
    try { root = await access.resolveInside(path) } catch (e) {
      if (e?.code !== 'forbidden' && !/liberad|fora d/i.test(String(e?.message))) throw e
      await access.addRoot(path)
      root = await access.resolveInside(path)
    }
    if (!statSync(root).isDirectory()) throw new AgentError('type', 'não é uma pasta')
    const limit = clamp(maxFiles, 100, 20000)
    const byExt = new Map(), top = [], big = []
    let files = 0, bytes = 0, dirs = 0, newest = 0, truncated = false
    const entries = []
    const walk = (dir, depth) => {
      let list
      try { list = readdirSync(dir, { withFileTypes: true }) } catch { return }
      for (const e of list) {
        if (files >= limit) { truncated = true; return }
        const full = join(dir, e.name)
        if (e.isDirectory()) { dirs++; if (depth === 0) entries.push({ nome: e.name, tipo: 'pasta', ignorada: SKIP.has(e.name) }); if (!SKIP.has(e.name) && depth < 6) walk(full, depth + 1); continue }
        if (!e.isFile()) continue
        let st; try { st = statSync(full) } catch { continue }
        files++; bytes += st.size; newest = Math.max(newest, st.mtimeMs)
        const ext = extname(e.name).toLowerCase() || '(sem extensão)'
        byExt.set(ext, (byExt.get(ext) ?? 0) + 1)
        if (depth === 0) entries.push({ nome: e.name, tipo: 'arquivo', kb: Math.round(st.size / 1024) })
        big.push([st.size, full]); if (big.length > 40) { big.sort((a, b) => b[0] - a[0]); big.length = 8 }
      }
    }
    walk(root, 0)
    big.sort((a, b) => b[0] - a[0])
    const langs = new Map()
    for (const [ext, n] of byExt) if (LANG[ext] && !['JSON', 'Markdown', 'YAML'].includes(LANG[ext])) langs.set(LANG[ext], (langs.get(LANG[ext]) ?? 0) + n)
    const langTotal = [...langs.values()].reduce((a, b) => a + b, 0) || 1
    const languages = [...langs].sort((a, b) => b[1] - a[1]).slice(0, 6).map(([l, n]) => ({ linguagem: l, arquivos: n, pct: Math.round((n / langTotal) * 100) }))
    const keyFiles = KEY_FILES.filter((f) => existsSync(join(root, f)))
    let pkg = null, readme = null, branch = null
    try { const j = JSON.parse(readFileSync(join(root, 'package.json'), 'utf8').replace(/^﻿/, '')); pkg = { nome: j.name, versao: j.version, descricao: j.description, scripts: Object.keys(j.scripts ?? {}).slice(0, 12), dependencias: Object.keys(j.dependencies ?? {}).slice(0, 15), devDependencias: Object.keys(j.devDependencies ?? {}).slice(0, 10) } } catch { /* no package.json */ }
    for (const n of ['README.md', 'README', 'readme.md']) { try { readme = readFileSync(join(root, n), 'utf8').replace(/^﻿/, '').slice(0, 1500); break } catch { /* next */ } }
    try { const h = readFileSync(join(root, '.git', 'HEAD'), 'utf8').trim(); branch = h.startsWith('ref:') ? h.slice(16) : h.slice(0, 8) } catch { /* not a repo */ }
    const name = basename(root)
    const kind = pkg ? 'projeto Node.js' : keyFiles.includes('pyproject.toml') || keyFiles.includes('requirements.txt') ? 'projeto Python' : keyFiles.includes('Cargo.toml') ? 'projeto Rust' : keyFiles.includes('go.mod') ? 'projeto Go' : keyFiles.includes('pom.xml') || keyFiles.includes('build.gradle') ? 'projeto Java' : 'pasta'
    const lines = [
      `${name}: ${kind} com ${files} arquivo(s) em ${dirs} pasta(s), ${MB(bytes)} MB${truncated ? ' (varredura parcial)' : ''}.`,
      languages.length ? `Linguagens: ${languages.map((l) => `${l.linguagem} ${l.pct}%`).join(', ')}.` : 'Não achei código-fonte reconhecível.',
      pkg ? `package.json: ${pkg.nome ?? name}${pkg.versao ? ` v${pkg.versao}` : ''}${pkg.descricao ? ` — ${pkg.descricao}` : ''}. Scripts: ${pkg.scripts.join(', ') || 'nenhum'}. Dependências: ${pkg.dependencias.join(', ') || 'nenhuma'}.` : null,
      keyFiles.length ? `Arquivos-chave: ${keyFiles.join(', ')}.` : null,
      branch ? `Git: ${branch}.` : null,
      newest ? `Última alteração: ${new Date(newest).toLocaleDateString('pt-BR')}.` : null,
      readme ? `README: «${readme.replace(/\s+/g, ' ').slice(0, 280)}…»` : 'Sem README.',
    ].filter(Boolean)
    return { data: { pasta: root, nome: name, tipo: kind, arquivos: files, pastas: dirs, tamanhoMB: MB(bytes), varreduraParcial: truncated, linguagens: languages, arquivosChave: keyFiles, pacote: pkg, readme, git: branch, maioresArquivos: big.slice(0, 5).map(([s, f]) => ({ arquivo: f.slice(root.length + 1), kb: Math.round(s / 1024) })), topo: entries.slice(0, 40), resumo: lines.join('\n') }, evidence: `${files} arquivos lidos em ${root}` }
  }, async ({ path }) => {
    try { await access.resolveInside(path); return null } catch (e) {
      if (/forbidden|liberad|fora d/i.test(`${e?.code} ${e?.message}`) || e?.code === 'forbidden') return `A pasta ${path} ainda não está liberada para o JARVIS. Liberar a pasta (só leitura de nomes e do README/package.json) e analisar?`
      return null
    }
  })

  // ------------------------------------------------------------------------- AIs (read + owner-approved changes)
  def('ia_status', 'system', 'read', 'Estado das IAs configuradas: ligadas, grátis/pagas, modelo, se responderam na última checagem e o modo só APIs.', {}, async () => {
    const ia = getIa?.()
    if (!ia) throw new AgentError('unavailable', 'IAs indisponíveis')
    return { data: { apisOnly: ia.settings.flags.get('apisOnly') === true, ias: ia.health.snapshot().map((p) => ({ id: p.id, nome: p.label.split('(')[0].trim(), ligada: p.enabled, paga: p.paid, externa: p.external, modelo: p.model, endpoint: p.status?.endpoint.state ?? 'não checada', ultimoErro: p.recentErrors?.[0]?.kind ?? null })) } }
  })
  def('ia_set', 'control', 'write', 'Muda uma IA configurada: enabled (liga/desliga), free (marcar como grátis) e/ou model. Nunca mexe em chaves.', { provider: 'id da IA (veja ia_status)', enabled: 'true/false', free: 'true/false', model: 'id do modelo' }, async ({ provider, enabled, free, model }) => {
    const ia = getIa?.()
    if (!ia) throw new AgentError('unavailable', 'IAs indisponíveis')
    const patch = {}
    if (enabled !== undefined) patch.enabled = yes(enabled)
    if (free !== undefined) patch.free = yes(free)
    if (model !== undefined) patch.model = String(model)
    if (!Object.keys(patch).length) throw new AgentError('args', 'informe enabled, free ou model')
    await ia.settings.setProvider(String(provider), patch)
    return { data: { provider, ...patch }, verified: true, evidence: 'configuração salva' }
  }, async ({ provider, enabled, free, model }) => `Alterar a IA "${provider}"${enabled !== undefined ? ` · ${yes(enabled) ? 'ligar' : 'desligar'}` : ''}${free !== undefined ? ` · ${yes(free) ? 'marcar como grátis' : 'marcar como paga'}` : ''}${model !== undefined ? ` · modelo ${model}` : ''}?`)

  // ------------------------------------------------------------------------- the interface itself
  if (uiBus) {
    def('interface_state', 'interface', 'read', 'O que a janela do JARVIS mostra agora: tela aberta, tema de cores e as chaves (voz, gasto, sensível), mais os temas e telas que existem.', {}, async () => ({ data: { agora: uiBus.state, temas: THEMES.map((t) => t.id), telas: VIEWS.map((v) => v.id), chaves: Object.keys(TOGGLES) } }))
    def('interface_theme', 'interface', 'write', `Muda as cores do JARVIS. theme = ${THEMES.map((t) => t.id).join(' | ')} (aceita também o nome da cor em português: vermelho, roxo, lilás, magenta, rosa, azul, verde, laranja, dourado...).`, { theme: 'id ou nome da cor' }, async ({ theme }) => {
      const t = findTheme(theme)
      if (!t) throw new AgentError('args', `tema desconhecido "${theme}". Temas: ${THEMES.map((x) => x.label).join(', ')}`)
      uiBus.push({ type: 'theme', id: t.id })
      return { data: { tema: t.id, nome: t.label }, verified: null, evidence: 'pedido enviado à janela; o tema muda na hora' }
    })
    def('interface_view', 'interface', 'write', `Abre uma tela do app: view = ${VIEWS.map((v) => v.id).join(' | ')}.`, { view: 'id ou nome da tela' }, async ({ view }) => {
      const v = findView(view)
      if (!v) throw new AgentError('args', `tela desconhecida "${view}". Telas: ${VIEWS.map((x) => x.label).join(', ')}`)
      uiBus.push({ type: 'view', id: v.id })
      return { data: { tela: v.id, nome: v.label }, verified: null, evidence: 'pedido enviado à janela' }
    })
    def('interface_set', 'interface', 'write', 'Liga ou desliga uma chave da interface: key = speak (falar as respostas) | spend (autorizo gasto) | sensitive (pedido sensível) | apisOnly (só APIs, ignora a IA local); value = true/false.', { key: 'speak | spend | sensitive | apisOnly', value: 'true ou false' }, async ({ key, value }) => {
      const k = findToggle(key)
      if (!k) throw new AgentError('args', `chave desconhecida "${key}". Chaves: ${Object.keys(TOGGLES).join(', ')}`)
      const on = yes(value)
      if (k === 'apisOnly') {
        const ia = getIa?.()
        if (!ia) throw new AgentError('unavailable', 'configurações indisponíveis')
        await ia.settings.setFlag('apisOnly', on)
      } else uiBus.push({ type: 'set', key: k, value: on })
      return { data: { chave: k, valor: on }, verified: k === 'apisOnly' ? true : null, evidence: k === 'apisOnly' ? 'salvo nas configurações' : 'pedido enviado à janela' }
    })

    const tone = (pct, warn = 70, bad = 90) => (pct >= bad ? 'bad' : pct >= warn ? 'warn' : 'ok')
    def('system_card', 'interface', 'write', 'Mostra na tela inicial um cartão com CPU, RAM e discos medidos agora (sem usar IA) e devolve os mesmos números.', {}, async () => {
      if (!monitor) throw new AgentError('unavailable', 'monitor indisponível')
      const s = monitor.summary()
      const disks = await monitor.disks().catch(() => [])
      const rows = [
        { label: 'CPU', value: s.cpu.usagePct == null ? 'sem amostra' : `${s.cpu.usagePct}%`, tone: s.cpu.usagePct == null ? 'unknown' : tone(s.cpu.usagePct) },
        { label: 'RAM', value: `${s.memory.usedGB} de ${s.memory.totalGB} GB (${s.memory.usedPct}%)`, tone: tone(s.memory.usedPct, 75, 90) },
        ...disks.slice(0, 6).map((d) => ({ label: `Disco ${d.drive}`, value: `${d.freeGB} GB livres de ${d.totalGB} (${d.freePct}%)`, tone: d.freePct < 10 ? 'bad' : d.freePct < 20 ? 'warn' : 'ok' })),
        { label: 'Ligado há', value: `${s.uptimeHours} h`, tone: 'unknown' },
      ]
      uiBus.push({ type: 'card', title: 'Sistema agora', body: { type: 'status', rows } })
      return { data: { cpu: s.cpu, memory: s.memory, uptimeHours: s.uptimeHours, disks }, verified: null, evidence: 'cartão enviado à janela' }
    })
    def('ia_card', 'interface', 'write', 'Mostra na tela inicial um cartão com o estado das IAs configuradas (sem usar IA) e devolve a lista.', {}, async () => {
      const ia = getIa?.()
      if (!ia) throw new AgentError('unavailable', 'IAs indisponíveis')
      const list = ia.health.snapshot()
      const rows = list.map((p) => ({ label: p.label.split('(')[0].trim(), value: !p.enabled ? 'desligada' : `${p.paid ? 'paga' : 'sem custo'} · ${p.status ? (p.status.endpoint.state === 'fail' ? 'inacessível' : p.status.model.state === 'ok' ? 'modelo ok' : 'modelo ?') : 'não checada'}`, tone: !p.enabled ? 'off' : !p.status ? 'unknown' : p.status.endpoint.state === 'fail' ? 'bad' : p.status.model.state === 'ok' ? 'ok' : 'warn' }))
      uiBus.push({ type: 'card', title: `IAs${ia.settings.flags.get('apisOnly') === true ? ' (só APIs)' : ''}`, body: { type: 'status', rows } })
      return { data: { apisOnly: ia.settings.flags.get('apisOnly') === true, ias: list.map((p) => ({ id: p.id, nome: p.label.split('(')[0].trim(), ligada: p.enabled, paga: p.paid, externa: p.external, modelo: p.model, endpoint: p.status?.endpoint.state ?? 'não checada' })) }, verified: null, evidence: 'cartão enviado à janela' }
    })
    def('interface_card', 'interface', 'write', 'Mostra um cartão flutuante na tela inicial do JARVIS (informação para o usuário ver): title; rows = [{label, value, tone: ok|warn|bad|unknown|off}] OU text.', { title: 'título', rows: 'linhas do cartão', text: 'texto simples (alternativa a rows)' }, async ({ title, rows, text }) => {
      const list = Array.isArray(rows) ? rows.slice(0, 14).map((r) => ({ label: String(r?.label ?? '').slice(0, 60), value: String(r?.value ?? '').slice(0, 120), tone: ['ok', 'warn', 'bad', 'unknown', 'off'].includes(r?.tone) ? r.tone : 'unknown' })) : null
      if (!list?.length && !text) throw new AgentError('args', 'informe rows ou text')
      uiBus.push({ type: 'card', title: String(title ?? 'JARVIS').slice(0, 80), body: list?.length ? { type: 'status', rows: list } : { type: 'text', text: String(text).slice(0, 1500) } })
      return { data: { shown: true }, verified: null, evidence: 'cartão enviado à janela' }
    })
  }
  return T
}
