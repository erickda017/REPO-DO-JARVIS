import { randomUUID } from 'node:crypto'
import { mkdir, readdir, readFile, rename, writeFile } from 'node:fs/promises'
import { join } from 'node:path'
import { extractJson } from './agent.mjs'
import { redactString } from '../command/redact.mjs'

/**
 * Mission orchestrator: a goal in, a verified result out.
 *
 *   ENTENDER -> PLANEJAR (criteria + steps with dependencies) -> EXECUTAR (specialised agents, one job each)
 *   -> OBSERVAR/AVALIAR (status comes from tool evidence) -> CORRIGIR (retry once, then replan, bounded)
 *   -> VERIFICAR (an independent auditor job) -> FINALIZAR (report with evidence and limits)
 *
 * It reuses the existing agent loop for every step (one job per step, with a role = instructions + a narrower tool
 * set + a model tier) and the existing router. It adds: a plan, dependencies, bounded retries and replans, a token/time
 * budget, no-progress detection, persisted state (a mission survives a restart and can be resumed without redoing
 * finished steps) and operational memory. Steps pass each other short summaries plus file references, not their whole
 * context. Only read-only roles run in parallel, so two agents never edit the same files at once.
 */

const READ = ['fs_list', 'fs_read', 'fs_search', 'git_status', 'git_diff', 'git_log', 'memory_recall', 'jarvis_perfil']
const SYS = ['sys_summary', 'sys_top', 'sys_temperature', 'monitor_report', 'disk_report', 'disk_largest', 'disk_big_files', 'mem_snapshot', 'mc_locate', 'proc_list']

export const ROLES = {
  engenheiro: {
    label: 'Engenharia', tier: 'strong', maxSteps: 16, readOnly: false,
    tools: [...READ, 'fs_write', 'fs_mkdir', 'fs_move', 'git_checkpoint', 'project_run', 'server_start', 'server_status', 'server_stop', 'http_local', 'memory_remember'],
    prompt: 'PAPEL: engenheiro de software. Antes de editar um projeto versionado rode git_status e, para mudança grande, git_checkpoint. Edite com fs_write (overwrite=true só no arquivo certo), depois confira com git_diff e rode os testes relevantes com project_run. Corrija a causa com evidência, não por tentativa aleatória. Preserve alterações que o usuário já tinha.',
  },
  diagnostico: {
    label: 'Diagnóstico', tier: 'cheap', maxSteps: 12, readOnly: true,
    tools: [...READ, 'project_run', 'server_status', 'http_local', 'memory_remember'],
    prompt: 'PAPEL: diagnóstico. Leia logs e código, reproduza o erro (project_run) e termine com a CAUSA PROVÁVEL apoiada em evidências observadas (cite o arquivo, a linha ou a saída). Hipótese sem prova deve ser dita como hipótese. Não altere arquivos.',
  },
  auditor: {
    label: 'Auditoria', tier: 'cheap', maxSteps: 10, readOnly: true,
    tools: [...READ, 'project_run', 'server_status', 'http_local'],
    prompt: 'PAPEL: auditor independente. Você NÃO confia no relato dos outros: confira o estado real (arquivos, git_diff, saída dos testes). Não altere nada.',
  },
  pesquisador: {
    label: 'Pesquisa', tier: 'cheap', maxSteps: 8, readOnly: true,
    tools: ['web_search', 'web_fetch', 'fs_read', 'fs_list', 'memory_recall', 'memory_remember'],
    prompt: 'PAPEL: pesquisador técnico. Busque em fontes oficiais, cite a URL de cada afirmação e separe o que está na fonte do que é sua inferência.',
  },
  windows: {
    label: 'Automação do Windows', tier: 'cheap', maxSteps: 12, readOnly: false,
    tools: [...SYS, ...READ, 'fs_write', 'fs_mkdir', 'fs_move', 'fs_delete', 'temp_clean', 'app_list', 'app_open', 'url_open', 'proc_close', 'profile_prepare', 'profile_apply', 'profile_status', 'profile_stop', 'run_command', 'screen_capture', 'memory_remember'],
    prompt: 'PAPEL: automação do Windows. Use a ferramenta específica antes de run_command. Ações destrutivas passam pela confirmação do usuário; nunca tente contorná-la.',
  },
  seguranca: {
    label: 'Segurança', tier: 'strong', maxSteps: 8, readOnly: true,
    tools: [...READ, 'memory_recall'],
    prompt: 'PAPEL: revisão de segurança das alterações. Procure segredos expostos, caminhos/ comandos perigosos, validação ausente e efeitos colaterais; classifique cada achado (baixa/média/alta) com arquivo e evidência. Não altere arquivos.',
  },
  geral: { label: 'Geral', tier: undefined, maxSteps: 12, readOnly: false, tools: null, prompt: '' },
}
const ROLE_NAMES = Object.keys(ROLES)

export const DEFAULT_LIMITS = { maxMs: 30 * 60_000, maxSteps: 8, maxReplans: 2, maxTokens: 400_000, maxStepRetries: 1, maxParallel: 2 }

const clip = (s, n) => (String(s ?? '').length > n ? String(s).slice(0, n) + '…' : String(s ?? ''))
const nowIso = (clock) => new Date(clock()).toISOString()

/** Validate a plan coming from a model: bounded, known roles, dependencies that exist, no cycles. */
export function validatePlan(raw, { maxSteps = DEFAULT_LIMITS.maxSteps, idOffset = 0 } = {}) {
  const j = typeof raw === 'string' ? extractJson(raw) : raw
  if (!j || !Array.isArray(j.steps) || j.steps.length === 0) return null
  const steps = j.steps.slice(0, maxSteps).map((s, i) => ({
    id: `e${idOffset + i + 1}`,
    title: clip(s.title ?? s.goal ?? `Etapa ${i + 1}`, 80),
    role: ROLE_NAMES.includes(s.role) ? s.role : 'geral',
    goal: clip(s.goal ?? s.title ?? '', 500),
    depends: [].concat(s.depends ?? []).map(String),
  })).filter((s) => s.goal)
  if (!steps.length) return null
  const ids = new Set(steps.map((s) => s.id))
  // The model numbers steps from 1; accept both "1" and "e1" and drop references to anything that does not exist.
  for (const s of steps) s.depends = [...new Set(s.depends.map((d) => (/^e\d+$/.test(d) ? d : `e${idOffset + Number(d)}`)).filter((d) => ids.has(d) && d !== s.id))]
  // cycle check (Kahn)
  const indeg = new Map(steps.map((s) => [s.id, s.depends.length]))
  const queue = steps.filter((s) => s.depends.length === 0).map((s) => s.id)
  let seen = 0
  while (queue.length) {
    const id = queue.shift()
    seen++
    for (const s of steps) if (s.depends.includes(id) && indeg.set(s.id, indeg.get(s.id) - 1).get(s.id) === 0) queue.push(s.id)
  }
  if (seen !== steps.length) return null
  const criteria = [].concat(j.criteria ?? j.success ?? []).map((c) => clip(c, 200)).filter(Boolean).slice(0, 8)
  return { criteria, steps }
}

const PLANNER_SYSTEM = (roles, groupsOn, groupsOff) => `Você é o orquestrador do JARVIS. Transforme o OBJETIVO em um plano executável. Responda SOMENTE com um JSON:
{"criteria":["condição objetiva e verificável de sucesso", ...],
 "steps":[{"title":"curto","role":"<papel>","goal":"o que esta etapa deve fazer e entregar","depends":["1"]}]}
Regras: no máximo 8 etapas, o mínimo necessário (uma etapa basta se o pedido for simples). "depends" lista números das etapas que precisam terminar antes. Etapas independentes de leitura podem ficar sem dependência entre si; etapas que EDITAM arquivos nunca rodam em paralelo. Inclua uma etapa final de verificação (papel auditor) quando algo for alterado.
Papéis (use só estes): ${roles}.
Ferramentas ligadas agora: ${groupsOn || 'nenhuma'}. Desligadas (não dependa delas, ou diga no plano que o usuário precisa ligá-las): ${groupsOff || 'nenhuma'}.`

/**
 * @param {object} deps
 * @param {object} deps.router  needs run()
 * @param {object} deps.agent   createAgent() result: run/wait/cancel/view/confirm
 * @param {object} deps.access  for the plan prompt (which groups are on)
 * @param {string|null} deps.dir  data/missions (null = memory only)
 */
export function createOrchestrator({ router, agent, access, memory = null, audit = null, dir = null, clock = Date.now, limits = {} }) {
  const defaults = { ...DEFAULT_LIMITS, ...limits }
  const missions = new Map()
  const running = new Map() // id -> { cancelled, jobs:Set<jobId> }
  let loaded = !dir
  let chain = Promise.resolve()

  const persist = (m) => {
    if (!dir) return Promise.resolve()
    m.updatedAt = nowIso(clock)
    chain = chain.then(async () => {
      await mkdir(dir, { recursive: true })
      const file = join(dir, `${m.id}.json`)
      await writeFile(`${file}.tmp`, JSON.stringify(m, null, 2), 'utf8')
      await rename(`${file}.tmp`, file)
    }).catch(() => {})
    return chain
  }
  const note = (m, text, kind = 'info') => {
    m.log.push({ at: nowIso(clock), kind, text: clip(redactString(text), 300) })
    if (m.log.length > 120) m.log.splice(0, m.log.length - 120)
  }

  async function ready() {
    if (loaded) return
    loaded = true
    try {
      for (const f of (await readdir(dir)).filter((n) => n.endsWith('.json'))) {
        try {
          const m = JSON.parse((await readFile(join(dir, f), 'utf8')).replace(/^﻿/, ''))
          // Anything that was in flight when the bridge stopped is "interrupted": its jobs are gone.
          if (['planning', 'running', 'verifying', 'awaiting'].includes(m.status)) { m.status = 'interrupted'; note(m, 'o JARVIS foi reiniciado durante a missão', 'warn') }
          missions.set(m.id, m)
        } catch { /* corrupt file: skipped */ }
      }
    } catch { /* first run */ }
  }

  // Router wrapper for the planner / verifier calls: counts tokens against the mission budget.
  async function think(m, { system, prompt, tier, maxTokens = 900 }) {
    const r = await router.run({ system, messages: [{ role: 'user', content: prompt }], capability: 'chat', sensitive: m.options.sensitive, confirmSpend: m.options.confirmSpend, maxTokens, ...(tier ? { tier } : {}) })
    const i = r.usage?.inputTokens ?? Math.round((system.length + prompt.length) / 3.5), o = r.usage?.outputTokens ?? Math.round(r.text.length / 3.5)
    m.usage.inputTokens += i; m.usage.outputTokens += o; m.usage.calls++
    return r
  }

  const groups = () => {
    const snap = access?.snapshot?.()
    const on = [], off = []
    for (const [g, v] of Object.entries(snap?.tools ?? {})) (v ? on : off).push(g)
    return { on: on.join(', '), off: off.join(', ') }
  }

  async function makePlan(m, { feedback = '' } = {}) {
    const g = groups()
    const mem = memory ? await memory.recall(m.goal, { limit: 5 }).catch(() => []) : []
    const memText = mem.length ? `\nMEMÓRIA RELEVANTE (hipóteses estão marcadas):\n${mem.map((i) => `- [${i.kind}${i.confidence === 'unverified' ? ', NÃO confirmado' : ''}] ${i.text}`).join('\n')}` : ''
    const prompt = `OBJETIVO: ${m.goal}${memText}${feedback ? `\n\nSITUAÇÃO ATUAL (replanejar o que falta):\n${feedback}` : ''}`
    const r = await think(m, { system: PLANNER_SYSTEM(ROLE_NAMES.map((n) => `${n} (${ROLES[n].label})`).join(', '), g.on, g.off), prompt, tier: 'strong', maxTokens: 1200 })
    return validatePlan(r.text, { maxSteps: m.limits.maxSteps, idOffset: feedback ? m.steps.length : 0 })
  }

  const doneSummary = (m, s) => `- ${s.id} ${s.title} (${s.role}, ${s.status}): ${clip(s.result?.summary ?? '', 350)}${s.result?.file ? ` [detalhes: ${s.result.file}]` : ''}`

  function stepPrompt(m, s, { retryNote = '', answer = '' } = {}) {
    const before = m.steps.filter((x) => s.depends.includes(x.id) && x.status === 'done')
    return [
      `MISSÃO: ${m.goal}`,
      m.criteria.length ? `CRITÉRIOS DE SUCESSO DA MISSÃO:\n${m.criteria.map((c) => `- ${c}`).join('\n')}` : '',
      `SUA ETAPA ${s.id} (${s.role}): ${s.goal}`,
      before.length ? `RESULTADOS DAS ETAPAS ANTERIORES (resumo; leia o arquivo de detalhes só se precisar):\n${before.map((x) => doneSummary(m, x)).join('\n')}` : '',
      retryNote ? `A TENTATIVA ANTERIOR FALHOU: ${retryNote}\nUse uma abordagem DIFERENTE; não repita o que não funcionou.` : '',
      answer ? `RESPOSTA DO USUÁRIO À SUA PERGUNTA: ${answer}` : '',
      'Ao terminar, responda com "final": o que foi feito, as EVIDÊNCIAS observadas (saídas, arquivos, testes) e o que ficou pendente. Não declare sucesso sem evidência.',
    ].filter(Boolean).join('\n\n')
  }

  const budgetLeft = (m) => m.limits.maxTokens - (m.usage.inputTokens + m.usage.outputTokens)
  const stopReason = (m) => {
    const st = running.get(m.id)
    if (st?.cancelled) return 'cancelled'
    if (clock() - m.startedAt > m.limits.maxMs) return 'a missão passou do tempo máximo configurado'
    if (budgetLeft(m) <= 0) return 'o limite de tokens da missão foi atingido'
    return null
  }

  /** Runs one step as an agent job and folds the outcome into the step. */
  async function runStep(m, s, opts = {}) {
    const role = ROLES[s.role] ?? ROLES.geral
    s.status = 'running'; s.attempts = (s.attempts ?? 0) + 1; s.startedAt = nowIso(clock)
    note(m, `${s.id} ${s.title} → ${s.role} (tentativa ${s.attempts})`)
    await persist(m)
    const jobId = agent.run({
      text: stepPrompt(m, s, opts), sensitive: m.options.sensitive, confirmSpend: m.options.confirmSpend, audit: false,
      role: { name: s.role, tools: role.tools, tier: role.tier, prompt: role.prompt }, meta: { mission: m.id, step: s.id },
      // The mission text and earlier results contain action verbs that would trip the \"needs a tool\" guard: judge only this step's goal (auditors must always look at the real state first).
      guardText: role.readOnly && s.role === 'auditor' ? 'leia e confira o estado real' : s.goal,
      maxSteps: role.maxSteps, maxTokens: Math.max(2000, Math.min(budgetLeft(m), Math.floor(m.limits.maxTokens / 2))),
    })
    s.jobId = jobId
    running.get(m.id)?.jobs.add(jobId)
    const view = await agent.wait(jobId)
    running.get(m.id)?.jobs.delete(jobId)
    m.usage.inputTokens += view.usage?.inputTokens ?? 0; m.usage.outputTokens += view.usage?.outputTokens ?? 0; m.usage.calls += view.usage?.calls ?? 0
    const r = view.result
    const trail = view.steps.map((x) => ({ tool: x.tool, ok: x.ok ?? null, verified: x.verified ?? null, evidence: x.evidence, error: x.error, denied: x.denied || undefined }))
    // Detail goes to a file; the plan only keeps a short summary (agents share references, not whole contexts).
    const file = dir ? join(dir, m.id, `${s.id}-${s.attempts}.json`) : null
    if (file) { await mkdir(join(dir, m.id), { recursive: true }).catch(() => {}); await writeFile(file, JSON.stringify({ step: s.id, role: s.role, result: r, trail }, null, 2)).catch(() => {}) }
    s.result = { status: r?.status ?? 'nao_concluido', summary: clip(r?.text ?? '', 600), notes: r?.notes ?? [], evidence: r?.evidence ?? [], toolCalls: trail.length, file }
    s.usage = view.usage
    s.endedAt = nowIso(clock)
    return { view, trail }
  }

  const failureSignature = (trail, r) => JSON.stringify([...trail.filter((t) => t.ok === false).map((t) => [t.tool, clip(t.error ?? '', 80)]), r?.status])

  /** Retry a step once with feedback; stop early when the same failure repeats (no progress). */
  async function runStepWithRetries(m, s) {
    let retryNote = '', lastSig = null, answer = s.answer ?? ''
    for (;;) {
      const { view, trail } = await runStep(m, s, { retryNote, answer })
      const r = view.result
      if (stopReason(m)) { s.status = 'failed'; s.result.summary = `interrompida: ${stopReason(m)}`; return }
      if (r?.status === 'pergunta') { s.status = 'asking'; s.question = r.text; return }
      if (r?.status === 'concluido') {
        s.status = 'done'
        if (s.attempts > 1 && memory) await memory.remember({ kind: 'solution', text: `${clip(s.goal, 140)} — falhou antes (${clip(retryNote, 160)}) e foi resolvido assim: ${clip(r.text, 220)}`, confidence: 'probable', source: `missão ${m.id.slice(0, 8)}`, mission: m.id }).catch(() => {})
        return
      }
      const sig = failureSignature(trail, r)
      const reason = clip([...(r?.notes ?? []), r?.text ?? ''].filter(Boolean).join(' | '), 400)
      if (sig === lastSig) { s.status = 'failed'; s.noProgress = true; note(m, `${s.id}: mesma falha repetida, sem progresso`, 'warn'); return }
      lastSig = sig
      if (s.attempts > m.limits.maxStepRetries) { s.status = 'failed'; return }
      retryNote = reason
      if (memory) await memory.remember({ kind: 'error', text: `${clip(s.goal, 140)} — falhou: ${clip(reason, 260)}`, confidence: 'probable', source: `missão ${m.id.slice(0, 8)}`, mission: m.id }).catch(() => {})
    }
  }

  async function verify(m) {
    m.status = 'verifying'; m.phase = 'verificação'
    note(m, 'verificação independente')
    await persist(m)
    const lines = m.steps.map((s) => doneSummary(m, s)).join('\n')
    const verifier = { id: 'v', title: 'Verificação independente', role: 'auditor', depends: m.steps.filter((s) => s.status === 'done').map((s) => s.id), goal: `Confirme, observando o estado REAL, se cada critério de sucesso foi atendido. Para cada critério diga confere / não confere e a evidência que você viu. Termine com uma linha exata: VEREDITO: confere | divergente | inconclusivo — motivo.\nRelato das etapas (não confie nele, confira):\n${lines}` }
    const tmp = { ...verifier, status: 'pending', attempts: 0, result: null }
    const { view } = await runStep(m, tmp)
    m.verification = { ...(m.verification ?? {}), file: tmp.result?.file, text: clip(view.result?.text ?? '', 700) }
    const t = view.result?.text ?? ''
    const v = /VEREDITO:\s*(confere|divergente|inconclusivo)/i.exec(t)?.[1]?.toLowerCase() ?? 'inconclusivo'
    m.verification.verdict = v
    return v
  }

  async function finish(m, status, text) {
    m.status = status; m.phase = 'fim'; m.finishedAt = nowIso(clock)
    const done = m.steps.filter((s) => s.status === 'done').length
    m.final = { status, text: clip(text, 1200), stepsDone: done, stepsTotal: m.steps.length, verdict: m.verification?.verdict ?? null }
    note(m, `fim: ${status} — ${done}/${m.steps.length} etapas`, status === 'concluido' ? 'ok' : 'warn')
    audit?.record('mission.end', { id: m.id.slice(0, 8), status, steps: `${done}/${m.steps.length}`, tokens: m.usage.inputTokens + m.usage.outputTokens })
    running.delete(m.id)
    await persist(m)
  }

  /** The loop. Safe to call again on an interrupted mission: finished steps are never redone. */
  async function execute(m) {
    try {
      if (!m.steps.length) {
        m.status = 'planning'; m.phase = 'plano'
        await persist(m)
        let plan = null
        try { plan = await makePlan(m) } catch (e) { note(m, `planejamento falhou: ${e.message}`, 'warn') }
        if (running.get(m.id)?.cancelled) return finish(m, 'cancelled', 'cancelada durante o planejamento')
        // A plan the model could not produce (or got wrong) never blocks the user: one general step does the whole job.
        if (!plan) { plan = { criteria: [], steps: [{ id: 'e1', title: 'Executar o pedido', role: 'geral', goal: m.goal, depends: [] }] }; note(m, 'plano inválido: usando uma etapa única', 'warn') }
        m.criteria = plan.criteria
        m.steps = plan.steps.map((s) => ({ ...s, status: 'pending', attempts: 0, result: null }))
        note(m, `plano: ${m.steps.map((s) => `${s.id}:${s.role}`).join(' → ')}`)
      }
      m.status = 'running'; m.phase = 'execução'
      for (const s of m.steps) if (s.status === 'running') s.status = 'pending' // resumed after an interruption
      await persist(m)

      for (;;) {
        const why = stopReason(m)
        if (why === 'cancelled') return finish(m, 'cancelled', 'cancelada pelo usuário')
        if (why) return finish(m, m.steps.some((s) => s.status === 'done') ? 'parcial' : 'nao_concluido', why)

        // block steps whose dependencies failed
        for (const s of m.steps) if (s.status === 'pending' && s.depends.some((d) => ['failed', 'skipped'].includes(m.steps.find((x) => x.id === d)?.status))) { s.status = 'skipped'; note(m, `${s.id} pulada: depende de etapa que falhou`, 'warn') }
        const pending = m.steps.filter((s) => s.status === 'pending')
        if (m.steps.some((s) => s.status === 'asking')) { m.status = 'awaiting'; running.delete(m.id); await persist(m); return }
        if (!pending.length) break
        const ready = pending.filter((s) => s.depends.every((d) => m.steps.find((x) => x.id === d)?.status === 'done'))
        if (!ready.length) { for (const s of pending) s.status = 'skipped'; break }
        // Only read-only roles share a batch; anything that can edit runs alone.
        const batch = ready[0] && ROLES[ready[0].role]?.readOnly ? ready.filter((s) => ROLES[s.role]?.readOnly).slice(0, m.limits.maxParallel) : [ready[0]]
        await Promise.all(batch.map((s) => runStepWithRetries(m, s)))
        await persist(m)
        if (m.steps.some((s) => s.status === 'asking')) { m.status = 'awaiting'; running.delete(m.id); await persist(m); return }

        // A failed step (after its retries): replan what is left, a bounded number of times.
        const failed = m.steps.find((s) => s.status === 'failed' && !s.replanned)
        if (failed && !stopReason(m)) {
          failed.replanned = true
          if (m.replans >= m.limits.maxReplans || failed.noProgress) { note(m, `${failed.id} falhou e não há mais replanejamentos`, 'warn'); continue }
          m.replans++
          note(m, `replanejando após falha em ${failed.id} (${m.replans}/${m.limits.maxReplans})`, 'warn')
          const feedback = m.steps.map((s) => doneSummary(m, s)).join('\n') + `\nFALHOU: ${failed.id} — ${clip((failed.result?.notes ?? []).join(' | ') || failed.result?.summary, 300)}\nProponha etapas novas só para o que FALTA, por um caminho diferente.`
          let plan = null
          try { plan = await makePlan(m, { feedback }) } catch { /* keep going without a new plan */ }
          if (plan) {
            failed.status = 'replaced'
            for (const s of m.steps) if (s.status === 'pending') s.status = 'replaced'
            m.steps.push(...plan.steps.map((s) => ({ ...s, depends: s.depends.filter((d) => m.steps.find((x) => x.id === d && x.status === 'done') || plan.steps.some((p) => p.id === d)), status: 'pending', attempts: 0, result: null })))
            note(m, `novo plano: ${plan.steps.map((s) => `${s.id}:${s.role}`).join(' → ')}`)
          }
        }
      }

      const doneAll = m.steps.length > 0 && m.steps.every((s) => ['done', 'replaced'].includes(s.status)) && m.steps.some((s) => s.status === 'done')
      const anyFailed = m.steps.some((s) => ['failed', 'skipped'].includes(s.status))
      // (a step that was replaced by a successful new plan is not a failure of the mission)
      if (!m.steps.some((s) => s.status === 'done')) return finish(m, 'nao_concluido', clip(m.steps.map((s) => `${s.id}: ${s.result?.summary ?? s.status}`).join(' | '), 600))
      let verdict = 'inconclusivo'
      if (doneAll && !anyFailed && !stopReason(m)) {
        verdict = await verify(m)
        if (verdict === 'divergente' && m.replans < m.limits.maxReplans && !stopReason(m)) {
          // The auditor disagrees with the agents: one corrective round with its findings.
          m.replans++
          note(m, 'o auditor discorda; rodada de correção', 'warn')
          const plan = await makePlan(m, { feedback: m.steps.map((s) => doneSummary(m, s)).join('\n') + `\nAUDITORIA INDEPENDENTE: ${m.verification.text}\nCorrija o que o auditor apontou.` }).catch(() => null)
          if (plan) {
            m.steps.push(...plan.steps.map((s) => ({ ...s, depends: [], status: 'pending', attempts: 0, result: null })))
            return execute(m)
          }
        }
      }
      const text = `${m.steps.filter((s) => s.status === 'done').map((s) => `${s.id}: ${clip(s.result?.summary, 160)}`).join(' | ')}${m.verification?.text ? `\nVerificação: ${clip(m.verification.text, 300)}` : ''}`
      if (doneAll && !anyFailed && verdict === 'confere') return finish(m, 'concluido', text)
      return finish(m, 'parcial', `${anyFailed ? 'Parte das etapas falhou ou foi pulada. ' : ''}${verdict === 'confere' ? '' : `Verificação independente: ${verdict}. `}${text}`)
    } catch (e) {
      note(m, `erro interno: ${e.message}`, 'error')
      return finish(m, 'nao_concluido', `falha interna: ${e.message}`)
    }
  }

  const view = (m) => ({
    id: m.id, goal: m.goal, status: m.status, phase: m.phase, criteria: m.criteria, replans: m.replans, limits: m.limits, usage: m.usage,
    steps: m.steps.map((s) => ({ id: s.id, title: s.title, role: s.role, depends: s.depends, status: s.status, attempts: s.attempts, summary: s.result?.summary, notes: s.result?.notes, question: s.question, toolCalls: s.result?.toolCalls })),
    pending: [...(running.get(m.id)?.jobs ?? [])].map((jid) => agent.view(jid)).filter((v) => v?.pending).map((v) => ({ jobId: v.id, step: v.meta?.step, ...v.pending })),
    active: [...(running.get(m.id)?.jobs ?? [])].map((jid) => agent.view(jid)).filter(Boolean).map((v) => ({ step: v.meta?.step, role: v.role, tools: v.steps.slice(-3).map((x) => `${x.tool}${x.ok === false ? ' ✗' : x.ok ? ' ✓' : ' …'}`), provider: v.provider })),
    verification: m.verification ?? null, final: m.final ?? null, log: m.log.slice(-25), startedAt: m.createdAt, updatedAt: m.updatedAt,
  })

  const launch = (m) => {
    running.set(m.id, { cancelled: false, jobs: new Set() })
    m.startedAt = clock()
    void execute(m)
  }

  return {
    ROLES,
    async start({ goal, sensitive = false, confirmSpend = false, limits: custom = {} } = {}) {
      await ready()
      const text = String(goal ?? '').trim()
      if (text.length < 5) throw new Error('descreva a missão (pelo menos uma frase)')
      if ([...running.keys()].length >= 2) throw new Error('já há 2 missões em andamento; espere uma terminar ou cancele')
      const lim = { ...defaults }
      for (const k of Object.keys(DEFAULT_LIMITS)) if (Number.isFinite(custom[k]) && custom[k] > 0) lim[k] = Math.min(custom[k], DEFAULT_LIMITS[k] * 4)
      const m = { id: randomUUID(), goal: text.slice(0, 2000), status: 'planning', phase: 'plano', criteria: [], steps: [], replans: 0, limits: lim, usage: { inputTokens: 0, outputTokens: 0, calls: 0 }, options: { sensitive: Boolean(sensitive), confirmSpend: Boolean(confirmSpend) }, createdAt: nowIso(clock), log: [], startedAt: clock() }
      missions.set(m.id, m)
      note(m, 'missão criada')
      audit?.record('mission.start', { id: m.id.slice(0, 8), goalChars: text.length })
      launch(m)
      return { id: m.id }
    },
    async view(id) { await ready(); const m = missions.get(id); return m ? view(m) : null },
    async list() { await ready(); return [...missions.values()].sort((a, b) => (a.createdAt < b.createdAt ? 1 : -1)).slice(0, 30).map((m) => ({ id: m.id, goal: clip(m.goal, 120), status: m.status, phase: m.phase, steps: m.steps.length, done: m.steps.filter((s) => s.status === 'done').length, createdAt: m.createdAt })) },
    async cancel(id) {
      const st = running.get(id)
      if (!st) return false
      st.cancelled = true
      for (const j of st.jobs) agent.cancel(j)
      return true
    },
    /** Approve/deny the pending confirmation(s) of the mission's active jobs. */
    confirm(id, approve) {
      let n = 0
      for (const jid of running.get(id)?.jobs ?? []) { const v = agent.view(jid); if (v?.pending && agent.confirm(v.pending.id, approve)) n++ }
      return n
    },
    /** Answer a step's question and continue. */
    async answer(id, text) {
      await ready()
      const m = missions.get(id)
      const s = m?.steps.find((x) => x.status === 'asking')
      if (!m || !s) throw new Error('nenhuma pergunta pendente')
      s.status = 'pending'; s.answer = clip(text, 800); s.question = undefined
      launch(m)
      return true
    },
    /** Continue an interrupted mission: finished steps stay finished. */
    async resume(id) {
      await ready()
      const m = missions.get(id)
      if (!m || !['interrupted', 'awaiting'].includes(m.status)) throw new Error('só missões interrompidas podem ser retomadas')
      if (running.has(id)) throw new Error('a missão já está em execução')
      note(m, 'retomada', 'info')
      launch(m)
      return true
    },
    /** Wait until a mission leaves the active states (tests, scripts). */
    async wait(id, ms = 60_000) {
      const t0 = Date.now()
      for (;;) {
        const m = missions.get(id)
        if (m && !running.has(id)) return view(m)
        if (Date.now() - t0 > ms) throw new Error('timeout')
        await new Promise((r) => setTimeout(r, 25))
      }
    },
    ready,
  }
}
