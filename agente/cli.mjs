#!/usr/bin/env node
// J.A.R.V.I.S. Code — terminal agent. Usage:
//   node agente/cli.mjs [--pasta=<dir>] [--modelo=<id>] [--yolo] [-p "pedido"]
// It talks to the router of the running J.A.R.V.I.S. app (your configured APIs, with failover); it needs no API key of its own.
import { createInterface, emitKeypressEvents } from 'node:readline'
import { existsSync, statSync } from 'node:fs'
import { resolve } from 'node:path'
import { createAgent } from './lib/agent.mjs'
import { createLlm } from './lib/llm.mjs'

const args = process.argv.slice(2)
const opt = (k) => args.find((a) => a.startsWith(`--${k}=`))?.slice(k.length + 3)
const flag = (k) => args.includes(`--${k}`)
const oneShot = (() => { const i = args.findIndex((a) => a === '-p' || a === '--prompt'); return i >= 0 ? args.slice(i + 1).join(' ') : null })()

const useColor = process.stdout.isTTY && !process.env.NO_COLOR
const c = (n) => (s) => (useColor ? `\x1b[${n}m${s}\x1b[0m` : String(s))
const dim = c(90), bold = c(1), cyan = c(36), green = c(32), red = c(31), yellow = c(33), blue = c(34)

let cwd = resolve(opt('pasta') ?? process.cwd())
if (!existsSync(cwd) || !statSync(cwd).isDirectory()) { console.error(red(`A pasta não existe: ${cwd}`)); process.exit(1) }

const llm = createLlm({ model: opt('modelo') ?? 'auto' })
const interactive = process.stdin.isTTY && process.stdout.isTTY && oneShot == null
const rl = createInterface({ input: process.stdin, output: process.stdout, terminal: Boolean(process.stdin.isTTY), historySize: 200 })
if (process.stdin.isTTY) emitKeypressEvents(process.stdin)

// ── input plumbing: one reader for the main prompt and for questions the agent asks ────────────────────────────────────
const queue = []
let waiter = null
let closed = false
rl.on('line', (l) => { if (waiter) { const w = waiter; waiter = null; w(l) } else queue.push(l) })
rl.on('close', () => { closed = true; if (waiter) { const w = waiter; waiter = null; w(null) } })
const nextLine = (promptText) => new Promise((res) => {
  if (queue.length) return res(queue.shift())
  if (closed) return res(null)
  rl.setPrompt(promptText ?? ''); if (promptText) rl.prompt()
  waiter = res
})
/** Main prompt; pasted multi-line text arrives as several lines within a few ms and is joined into one message. */
async function readMessage() {
  const first = await nextLine(bold(cyan('› ')))
  if (first == null) return null
  let text = first
  await new Promise((r) => setTimeout(r, 35))
  while (queue.length) text += '\n' + queue.shift()
  return text
}

// ── rendering ───────────────────────────────────────────────────────────────────────────────────────────────────────────
let spinner = null, spinStart = 0, midText = false, spinLabel = 'pensando'
const startSpin = (label) => {
  if (!useColor || spinner) return
  spinLabel = label ?? spinLabel; spinStart = Date.now()
  const frames = '⠋⠙⠹⠸⠼⠴⠦⠧⠇⠏'; let i = 0
  spinner = setInterval(() => process.stdout.write(`\r${dim(frames[i++ % frames.length] + ' ' + spinLabel + ' ' + Math.round((Date.now() - spinStart) / 1000) + 's  (Esc interrompe)')}\x1b[K`), 120)
}
const stopSpin = () => { if (spinner) { clearInterval(spinner); spinner = null; process.stdout.write('\r\x1b[K') } }

const short = (s, n = 90) => { s = String(s ?? '').replace(/\s+/g, ' ').trim(); return s.length > n ? s.slice(0, n - 1) + '…' : s }
function describe(name, a = {}) {
  const k = a.path ?? a.command ?? a.pattern ?? a.url ?? a.query ?? a.goal ?? a.name ?? a.action ?? ''
  return `${name}${k ? ' ' + dim(short(k)) : ''}`
}
function summarize(name, r) {
  if (r?.error) return red('✗ ' + short(r.error, 160)) + (r.warning ? '\n    ' + yellow(short(r.warning, 160)) : '')
  const lines = []
  switch (name) {
    case 'read_file': lines.push(green('✓ ') + dim(`${r.total_lines} linhas (${r.shown})${r.next_offset ? `, continua em ${r.next_offset}` : ''}`)); break
    case 'write_file': lines.push(green('✓ ') + dim(`${r.created ? 'criado' : 'reescrito'} ${r.bytes} bytes${r.verified ? ', verificado' : ''}`) + (r.lint_error ? '\n    ' + yellow('lint: ' + short(r.lint_error, 160)) : '')); break
    case 'patch': lines.push(green('✓ ') + dim(`${r.replacements} troca(s) [${r.strategy ?? 'já aplicado'}]`) + (r.lint_error ? '\n    ' + yellow('lint: ' + short(r.lint_error, 160)) : '')); if (r.diff) lines.push(...r.diff.split('\n').slice(2, 26).map((l) => '    ' + (l.startsWith('+') ? green(l) : l.startsWith('-') ? red(l) : dim(l)))); break
    case 'terminal': { const out = String(r.output ?? '').trim().split('\n'); lines.push((r.exit_code === 0 || r.running ? green('✓ ') : red(`✗ exit ${r.exit_code} `)) + dim(r.session_id ? `em segundo plano (${r.session_id})` : `cwd ${short(r.cwd, 60)}`)); lines.push(...out.slice(0, 8).map((l) => '    ' + dim(short(l, 140)))); if (out.length > 8) lines.push('    ' + dim(`… +${out.length - 8} linhas`)); break }
    case 'search_files': lines.push(green('✓ ') + dim(`${r.total ?? r.total_matches ?? 0} resultado(s)`)); break
    case 'todo_list': lines.push(...(r.todos ?? []).map((t) => `    ${t.status === 'completed' ? green('[x]') : t.status === 'in_progress' ? yellow('[>]') : t.status === 'cancelled' ? dim('[~]') : '[ ]'} ${t.parent ? '  ' : ''}${t.content}`)); break
    case 'web_search': lines.push(green('✓ ') + dim((r.results ?? []).map((x) => short(x.title, 50)).slice(0, 3).join(' · '))); break
    case 'delegate_task': lines.push(green('✓ ') + dim(`subagente: ${short(r.summary, 140)}`)); break
    default: lines.push(green('✓ '))
  }
  return lines.join('\n')
}

const state = { turnStart: 0, steps: 0, model: null, running: false, printedHeader: false }
function onEvent(e) {
  if (e.type === 'text') { stopSpin(); if (!midText) { process.stdout.write('\n'); midText = true } process.stdout.write(e.text) }
  else if (e.type === 'tool_start') { stopSpin(); if (midText) { process.stdout.write('\n'); midText = false } state.steps++; process.stdout.write(`\n  ${blue('◆')} ${describe(e.name, e.args)}\n`); startSpin('executando') }
  else if (e.type === 'tool_end') { stopSpin(); process.stdout.write(`    ${summarize(e.name, e.result)} ${dim(`${e.ms}ms`)}\n`); startSpin('pensando') }
  else if (e.type === 'notice') { stopSpin(); process.stdout.write(`\n  ${yellow('•')} ${dim(e.text)}\n`); startSpin() }
  else if (e.type === 'child_tool') { stopSpin(); process.stdout.write(`    ${dim('↳ subagente: ' + e.name)}\n`); startSpin('subagente') }
  else if (e.type === 'usage') { if (e.model) state.model = e.model; midText = false; stopSpin(); startSpin('pensando') }
}

// ── questions to the user (permissions, clarify) ─────────────────────────────────────────────────────────────────────────
async function confirm(message) {
  stopSpin(); if (midText) { process.stdout.write('\n'); midText = false }
  process.stdout.write(`\n${yellow('⚠ ')}${message}\n`)
  const a = (await nextLine(`${bold('[s]im uma vez · [t]odos desta categoria · [n]ão › ')}`) ?? 'n').trim().toLowerCase()
  startSpin('executando')
  return a.startsWith('t') ? 'session' : a.startsWith('s') || a === 'y' || a === 'yes' ? 'once' : 'deny'
}
async function ask(question, choices) {
  stopSpin(); process.stdout.write(`\n${cyan('? ')}${question}\n${choices ? choices.map((x, i) => `  ${i + 1}. ${x}`).join('\n') + '\n' : ''}`)
  const a = (await nextLine(bold('› '))) ?? ''
  startSpin()
  const n = Number(a); return choices && n >= 1 && n <= choices.length ? choices[n - 1] : a
}

const agent = createAgent({ llm, cwd, ask, confirm, on: onEvent, yolo: flag('yolo') })

// ── arrow-key menu ───────────────────────────────────────────────────────────────────────────────────────────────────────
async function menu(title, items, current) {
  if (!interactive) return null
  let pos = Math.max(0, items.indexOf(current))
  const draw = (first) => {
    if (!first) process.stdout.write(`\x1b[${items.length + 1}A`)
    process.stdout.write(`\x1b[K${bold(title)} ${dim('(↑↓ move · Enter escolhe · Esc cancela)')}\n` + items.map((it, i) => `\x1b[K ${i === pos ? cyan('❯ ' + it) : '  ' + it}${it === current ? dim('  (atual)') : ''}`).join('\n') + '\n')
  }
  rl.pause(); process.stdin.setRawMode?.(true); process.stdin.resume()
  draw(true)
  return await new Promise((res) => {
    const onKey = (_s, k) => {
      if (!k) return
      if (k.name === 'up') { pos = (pos + items.length - 1) % items.length; draw(false) }
      else if (k.name === 'down') { pos = (pos + 1) % items.length; draw(false) }
      else if (k.name === 'return') done(items[pos])
      else if (k.name === 'escape' || (k.ctrl && k.name === 'c')) done(null)
    }
    const done = (v) => { process.stdin.off('keypress', onKey); rl.resume(); res(v) }
    process.stdin.on('keypress', onKey)
  })
}

// ── slash commands ───────────────────────────────────────────────────────────────────────────────────────────────────────
const HELP = `${bold('Comandos')}
  /modelo            escolhe a IA (auto = o JARVIS escolhe e troca sozinho se uma acabar)
  /compactar [foco]  resume o contexto agora      /limpar   começa uma conversa nova
  /todo              mostra a lista de tarefas     /yolo     liga/desliga a aprovação de comandos perigosos
  /skills            lista as receitas (skills)    /memoria  mostra o que o agente lembra
  /pasta <caminho>   troca a pasta de trabalho     /tokens   uso de contexto    /sair
  ${dim('Esc interrompe o passo atual. Comandos destrutivos pedem confirmação; os irremediáveis (apagar o disco, desligar o PC) são sempre bloqueados.')}`

async function slash(line) {
  const [cmd, ...rest] = line.slice(1).split(/\s+/)
  const arg = rest.join(' ')
  switch (cmd) {
    case 'ajuda': case 'help': case '?': console.log(HELP); break
    case 'sair': case 'exit': case 'quit': return 'exit'
    case 'modelo': case 'model': {
      const r = await llm.ready()
      if (!r.ok) { console.log(red(r.error)); break }
      const pick = arg || await menu('Escolha a IA', r.models, llm.model)
      if (pick) { llm.setModel(pick); console.log(green(`Usando ${pick}.`)) }
      break
    }
    case 'limpar': case 'clear': case 'novo': agent.clear(); console.log(dim('Conversa nova.')); break
    case 'compactar': case 'compress': { startSpin('compactando'); try { const r = await agent.compressNow(arg || undefined); stopSpin(); console.log(r.mode === 'none' ? dim('Nada para compactar ainda.') : green(`Compactado (${r.mode}): ~${Math.round(r.before / 1000)}k → ~${Math.round(r.after / 1000)}k tokens.`)) } catch (e) { stopSpin(); console.log(red(e.message)) } break }
    case 'todo': { const t = agent.todo.read(); console.log(t.length ? t.map((x) => `  ${x.status === 'completed' ? '[x]' : x.status === 'in_progress' ? '[>]' : '[ ]'} ${x.content}`).join('\n') : dim('Lista vazia.')); break }
    case 'yolo': agent.setYolo(!agent.approver.yolo); console.log(agent.approver.yolo ? yellow('Aprovação desligada: comandos perigosos rodam sem perguntar (os irremediáveis seguem bloqueados).') : green('Aprovação ligada.')); break
    case 'skills': console.log([...agent.skills.values()].map((s) => `  ${bold(s.name)} ${dim('— ' + s.description)}`).join('\n') || dim('Nenhuma skill.')); break
    case 'memoria': case 'memory': console.log(agent.memory.snapshot() || dim('Memória vazia.')); break
    case 'tokens': console.log(dim(`Contexto atual: ~${(agent.tokens() / 1000).toFixed(1)}k tokens estimados em ${agent.messages.length} mensagens.`)); break
    case 'pasta': case 'cd': { if (!arg) { console.log(agent.cwd); break } const p = resolve(agent.cwd, arg); if (existsSync(p) && statSync(p).isDirectory()) { agent.state.cwd = p; console.log(green(p)) } else console.log(red('Pasta não encontrada.')); break }
    default: console.log(red(`Comando desconhecido: /${cmd}. Digite /ajuda.`))
  }
  return null
}

// ── turns ────────────────────────────────────────────────────────────────────────────────────────────────────────────────
async function turn(text) {
  state.turnStart = Date.now(); state.steps = 0; state.running = true; midText = false
  startSpin('pensando')
  let result
  try { result = await agent.send(text) } catch (e) { stopSpin(); console.log('\n' + red(`✗ ${e.message}`)); state.running = false; return }
  stopSpin(); state.running = false
  if (!midText && result.text && result.text !== '') { /* answer already streamed */ }
  process.stdout.write('\n')
  const secs = ((Date.now() - state.turnStart) / 1000).toFixed(1)
  const tk = result.usage?.prompt ? ` · ${Math.round((result.usage.prompt + result.usage.completion) / 1000)}k tokens` : ''
  console.log(dim(`─ ${result.iterations} chamada(s) · ${state.steps} ferramenta(s) · ${secs}s${state.model ? ` · via ${state.model}` : ''}${tk}${result.interrupted ? ' · interrompido' : ''}${result.limit ? ' · limite de passos' : ''}`))
}

process.stdin.on('keypress', (_s, k) => { if (k?.name === 'escape' && state.running) { agent.interrupt(); stopSpin(); process.stdout.write(`\n${yellow('Interrompendo…')}\n`) } })
let sigints = 0
rl.on('SIGINT', () => { if (state.running) { agent.interrupt(); return } if (++sigints >= 2) { cleanup(); process.exit(0) } console.log(dim('\nCtrl+C de novo (ou /sair) para sair.')); rl.prompt() })
const cleanup = () => { stopSpin(); agent.dispose(); rl.close() }
process.on('exit', () => agent.dispose())

async function main() {
  const ready = await llm.ready()
  if (!ready.ok) { console.error(red(ready.error)); process.exit(2) }
  if (oneShot != null) { await turn(oneShot); cleanup(); return }
  console.log(`${bold(cyan('J.A.R.V.I.S. Code'))} ${dim('· agente de programação · baseado nas técnicas do Hermes Agent (MIT)')}`)
  console.log(dim(`pasta: ${agent.cwd}\nIA: ${llm.model} (${ready.models.length - 1} disponível(is)) · /ajuda · Esc interrompe`))
  if (agent.skills.size) console.log(dim(`skills: ${[...agent.skills.keys()].join(', ')}`))
  for (;;) {
    sigints = 0
    const line = await readMessage()
    if (line == null) break
    const text = line.trim()
    if (!text) continue
    if (text.startsWith('/') && !text.includes('\n')) { if ((await slash(text)) === 'exit') break; continue }
    await turn(text)
  }
  cleanup()
}
main().catch((e) => { stopSpin(); console.error(red(e.stack ?? e.message)); process.exit(1) })
