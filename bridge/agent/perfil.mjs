import { readFileSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { GROUPS } from './access.mjs'

/**
 * The JARVIS personality and self-profile. The text lives in personalidade/JARVIS.md (editable by the owner); this
 * module reads it and joins it with a LIVE table built from the real tool registry, so the profile can never list a
 * tool that does not exist or hide one that does.
 */
const DEFAULT_FILE = join(dirname(fileURLToPath(import.meta.url)), '..', '..', 'personalidade', 'JARVIS.md')

const FALLBACK_PERSONA = 'Sou o JARVIS, assistente pessoal do Erick no Windows. Falo português do Brasil, direto e curto, e nunca afirmo ter feito algo que uma ferramenta não fez e eu não conferi.'

const read = (file) => { try { return readFileSync(file, 'utf8').replace(/^﻿/, '') } catch { return null } }

/** The block between the persona markers (what goes into every conversation). */
export function personaText(file = DEFAULT_FILE) {
  const m = /<!--\s*persona:start\s*-->([\s\S]*?)<!--\s*persona:end\s*-->/.exec(read(file) ?? '')
  return (m?.[1] ?? '').replace(/^## Personalidade\s*/m, '').trim() || FALLBACK_PERSONA
}

/** Whole profile as markdown: the owner-editable text plus the live tool table. */
export function buildProfile({ tools, access, file = DEFAULT_FILE } = {}) {
  const base = read(file) ?? `# J.A.R.V.I.S\n\n${FALLBACK_PERSONA}\n`
  const snap = access?.snapshot?.()
  const list = Object.values(tools ?? {})
  const byGroup = new Map()
  for (const t of list) byGroup.set(t.group, [...(byGroup.get(t.group) ?? []), t])
  const out = [base.trimEnd(), '', '---', '', '## Ferramentas AO VIVO (geradas do registro real)', '']
  for (const [group, items] of byGroup) {
    const on = snap ? snap.tools?.[group] : undefined
    out.push(`### ${group} — ${GROUPS[group] ?? group} · ${on === undefined ? 'estado desconhecido' : on ? 'LIGADO' : 'desligado (ligue na tela Agente)'}`)
    for (const t of items) {
      const params = Object.keys(t.params ?? {}).join(', ')
      out.push(`- \`${t.name}\` [${t.risk}${t.confirm || t.risk === 'danger' ? ', pede confirmação' : ''}] ${t.desc}${params ? ` Parâmetros: ${params}.` : ''}`)
    }
    out.push('')
  }
  if (snap?.roots) out.push(`Pastas liberadas agora: ${snap.roots.length ? snap.roots.map((r) => r.path).join('; ') : 'nenhuma (sem pasta liberada eu não toco em arquivos)'}.`)
  out.push(`Total: ${list.length} ferramentas em ${byGroup.size} grupos.`)
  return out.join('\n')
}
