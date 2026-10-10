// The agent loop. Structure follows agent/conversation_loop.py and agent/tool_executor.py of Hermes Agent
// (c) 2025 Nous Research, MIT License: native tool calling in OpenAI message format, independent read-only calls run concurrently,
// every tool error goes back to the model as a result, an iteration budget with one grace call, empty-response and "promised but did
// nothing" recovery, repeat-failure detection, interrupts that leave the history valid, and context compression when the prompt grows.
import { compress, estimateTokens } from './compress.mjs'

const PROMISE = /(?:\b(?:vou|irei|vamos|agora vou|em seguida|a seguir|primeiro vou|deixe-me|deixa eu)\b|\b(?:let me|i will|i'll|i am going to|next,? i)\b)[^.!?\n]{0,240}[:.]?\s*$/i
const MAX_RESULT_CHARS = 100_000

const serialize = (v) => {
  const s = typeof v === 'string' ? v : JSON.stringify(v, null, 0)
  return s.length > MAX_RESULT_CHARS ? s.slice(0, MAX_RESULT_CHARS) + `… [resultado cortado, ${s.length} caracteres]` : s
}

/** Best-effort repair of tool-call arguments that models emit slightly broken (fences, trailing commas, single quotes). */
export function parseArguments(raw) {
  const s = String(raw ?? '').trim()
  if (!s) return { ok: true, value: {} }
  const tries = [s, s.replace(/^```(?:json)?\s*|\s*```$/g, ''), s.replace(/,\s*([}\]])/g, '$1')]
  for (const t of tries) { try { const v = JSON.parse(t); if (v && typeof v === 'object' && !Array.isArray(v)) return { ok: true, value: v } } catch { /* next */ } }
  return { ok: false }
}

const missingRequired = (tool, args) => (tool.parameters?.required ?? []).filter((k) => args[k] === undefined || args[k] === null)

/**
 * @param {object} o
 * @param {any} o.llm            createLlm()
 * @param {Map<string, any>} o.tools  name -> { name, description, parameters, readOnly, run(args) }
 * @param {string} o.system
 * @param {object[]} o.messages  conversation WITHOUT the system message; mutated in place
 * @param {(e: object) => void} [o.on]  events: text, tool_start, tool_end, notice, usage
 * @param {AbortSignal} [o.signal]
 * @param {number} [o.maxIterations]
 * @param {number} [o.compressAt]  prompt size (tokens) that triggers compression
 * @param {() => string|null} [o.todoText]
 */
export async function runLoop({ llm, tools, system, messages, on = () => {}, signal, maxIterations = 120, compressAt = 90_000, todoText = () => null, state = {} }) {
  const schemas = [...tools.values()].map((t) => ({ type: 'function', function: { name: t.name, description: t.description, parameters: t.parameters } }))
  const failures = new Map()
  let nudges = 0, empties = 0, finalText = '', iterations = 0
  const usage = { prompt: 0, completion: 0, calls: 0 }

  const maybeCompress = async () => {
    const est = estimateTokens(messages) + Math.ceil(system.length / 3.5)
    const known = state.lastPromptTokens ? state.lastPromptTokens + Math.ceil((est - (state.lastEstimate ?? est)) ) : est
    if (Math.max(est, known) < compressAt) return
    on({ type: 'notice', text: `Compactando o contexto (~${Math.round(est / 1000)}k tokens)…` })
    const r = await compress({ messages, llm, todoText: todoText(), signal, target: Math.floor(compressAt * 0.6), previousSummary: state.summary })
    if (r.mode !== 'none') {
      messages.splice(0, messages.length, ...r.messages)
      if (r.summary) state.summary = r.summary
      state.lastPromptTokens = 0
      on({ type: 'notice', text: `Contexto compactado (${r.mode}): ~${Math.round(r.before / 1000)}k → ~${Math.round(r.after / 1000)}k tokens.` })
    }
  }

  const execute = async (tc) => {
    const name = tc.function?.name
    const tool = tools.get(name)
    const t0 = Date.now()
    let out
    if (!tool) out = { error: `Unknown tool "${name}". Available tools: ${[...tools.keys()].join(', ')}.` }
    else {
      const parsed = parseArguments(tc.function.arguments)
      if (!parsed.ok) out = { error: `The arguments of ${name} are not valid JSON (${String(tc.function.arguments).slice(0, 120)}…). Re-emit the call with a JSON object. For big file content prefer write_file with the full content in "content".` }
      else {
        const miss = missingRequired(tool, parsed.value)
        if (miss.length) out = { error: `${name}: missing required argument(s): ${miss.join(', ')}. Re-emit the call with all required arguments.` }
        else {
          on({ type: 'tool_start', name, args: parsed.value, id: tc.id })
          try { out = await tool.run(parsed.value) } catch (e) { out = { error: `${name} failed: ${e?.message ?? e}` } }
          const key = `${name}:${tc.function.arguments}`
          if (out?.error) {
            const n = (failures.get(key) ?? 0) + 1
            failures.set(key, n)
            if (n >= 3) out = { ...out, warning: `Esta mesma chamada já falhou ${n} vezes. Mude de abordagem (leia o arquivo de novo, use outra ferramenta, ou explique o bloqueio ao usuário).` }
          }
        }
      }
    }
    on({ type: 'tool_end', name, id: tc.id, ms: Date.now() - t0, ok: !out?.error, result: out })
    return { role: 'tool', tool_call_id: tc.id, content: serialize(out) }
  }

  const runCalls = async (calls) => {
    const results = new Array(calls.length)
    let i = 0
    while (i < calls.length) {
      if (signal?.aborted) { for (; i < calls.length; i++) results[i] = { role: 'tool', tool_call_id: calls[i].id, content: serialize({ error: 'Interrompido pelo usuário antes de executar.' }) }; break }
      const ro = (c) => tools.get(c.function?.name)?.readOnly === true
      if (ro(calls[i])) {
        let j = i
        while (j < calls.length && ro(calls[j])) j++
        const batch = await Promise.all(calls.slice(i, j).map(execute))
        batch.forEach((r, k) => { results[i + k] = r })
        i = j
      } else { results[i] = await execute(calls[i]); i++ }
    }
    return results
  }

  for (; iterations < maxIterations; iterations++) {
    if (signal?.aborted) return { text: finalText, interrupted: true, iterations, usage }
    const lastChance = iterations === maxIterations - 1
    await maybeCompress()
    let reply
    try {
      for await (const ev of llm.chat({ messages: [{ role: 'system', content: system }, ...messages], tools: lastChance ? undefined : schemas, signal })) {
        if (ev.delta) on({ type: 'text', text: ev.delta })
        else if (ev.done) reply = ev
      }
    } catch (e) {
      if (signal?.aborted) return { text: finalText, interrupted: true, iterations, usage }
      throw e
    }
    if (reply.usage) { usage.prompt += reply.usage.prompt_tokens ?? 0; usage.completion += reply.usage.completion_tokens ?? 0; state.lastPromptTokens = reply.usage.prompt_tokens; state.lastEstimate = estimateTokens(messages) + Math.ceil(system.length / 3.5) }
    usage.calls++
    on({ type: 'usage', model: reply.model, usage: reply.usage })
    const msg = reply.message
    const calls = msg.tool_calls ?? []

    if (!calls.length) {
      const text = (msg.content ?? '').trim()
      if (!text) {
        if (empties++ < 2) { messages.push({ role: 'user', content: 'Sua resposta veio vazia. Continue a tarefa chamando a ferramenta apropriada, ou dê o resultado final.' }); continue }
        return { text: finalText || '(o modelo respondeu vazio)', iterations: iterations + 1, usage, empty: true }
      }
      if (!lastChance && nudges < 2 && tools.size && PROMISE.test(text.slice(-300)) && !/\?\s*$/.test(text)) {
        nudges++
        messages.push({ role: 'assistant', content: text })
        messages.push({ role: 'user', content: 'Você disse que ia agir, mas não chamou nenhuma ferramenta. Chame a ferramenta agora; se a tarefa já terminou, entregue o resultado final verificado.' })
        on({ type: 'notice', text: 'O modelo prometeu agir sem chamar ferramenta; pedi que execute.' })
        continue
      }
      messages.push({ role: 'assistant', content: text })
      finalText = text
      return { text, iterations: iterations + 1, usage }
    }

    messages.push(msg)
    if (msg.content) finalText = msg.content
    const results = await runCalls(calls)
    messages.push(...results)
    if (signal?.aborted) return { text: finalText, interrupted: true, iterations: iterations + 1, usage }
    if (iterations === maxIterations - 2) messages.push({ role: 'user', content: 'Atenção: este é o último passo disponível. Na próxima resposta você não terá ferramentas: resuma o que foi feito, o que falta e o estado atual.' })
  }
  return { text: finalText || 'Atingi o limite de passos desta tarefa.', limit: true, iterations, usage }
}
