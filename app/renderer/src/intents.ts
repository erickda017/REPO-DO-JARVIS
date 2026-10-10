export type Intent =
  | { kind: 'status' }
  | { kind: 'tasks' }
  | { kind: 'createTask'; title: string }
  | { kind: 'timer'; seconds: number }
  | { kind: 'media'; url: string; mediaType: 'image' | 'video' }
  | { kind: 'listen' }
  | { kind: 'mission'; goal: string }
  | { kind: 'chat' }

const URL_RE = /https?:\/\/[^\s)"'<>]+/gi
const IMAGE_RE = /\.(png|jpe?g|gif|webp|avif)(\?[^\s]*)?$/i
const VIDEO_RE = /\.(mp4|webm|ogv)(\?[^\s]*)?$/i

type Media = { url: string; mediaType: 'image' | 'video' }

export function mediaUrls(text: string): Media[] {
  return (text.match(URL_RE) ?? []).flatMap((u): Media[] => {
    const url = u.replace(/[.,;]+$/, '')
    return IMAGE_RE.test(url) ? [{ url, mediaType: 'image' }] : VIDEO_RE.test(url) ? [{ url, mediaType: 'video' }] : []
  })
}

/**
 * Plain-rule commands handled inside the app, no AI involved: they open the
 * floating panels. Anything else goes to the router as chat. Deliberately
 * simple so the owner can predict exactly what a phrase will do.
 */
export function parseIntent(raw: string): Intent {
  const text = raw.trim()
  const low = text.toLowerCase()

  const media = mediaUrls(text)[0]
  if (media && /\b(mostre|mostrar|abra|abrir|exiba|exibir|veja)\b/.test(low)) return { kind: 'media', ...media }

  const timer = low.match(/\b(?:timer|temporizador|cron[oô]metro)\b.*?(\d+)\s*(min|minutos?|m|seg|segundos?|s|h|horas?)\b/)
  if (timer) {
    const n = Number(timer[1])
    const unit = timer[2]
    const seconds = /^h/.test(unit) ? n * 3600 : /^(min|m$|minuto)/.test(unit) ? n * 60 : n
    if (seconds > 0 && seconds <= 86400) return { kind: 'timer', seconds }
  }

  // The listening command: after it the next thing said is turned into text and sent like any typed message.
  if (/^(?:jarvis[,!\s]+)?(?:ouv(?:ir|e|a)|ou[cç]a|escut(?:ar|e|a)|modo (?:de )?(?:escuta|voz)|ativar (?:o )?microfone|me (?:ou[cç]a|escute))[\s!.]*$/i.test(text)) return { kind: 'listen' }

  // "missão: <objetivo>" starts a planned, verified, multi-agent job (the Missões screen follows it).
  const mission = text.match(/^miss[aã]o\s*[:\-]\s*([\s\S]{5,})$/i)
  if (mission) return { kind: 'mission', goal: mission[1].trim() }

  const create = text.match(/^(?:criar|crie|nova|adicionar|adicione)\s+tarefa\s*[:\-]?\s*(.+)$/i)
  if (create) return { kind: 'createTask', title: create[1].trim() }

  if (/\b(status|sa[uú]de|como est[aã]o|o que (est[aá]|caiu))\b/.test(low)) return { kind: 'status' }
  if (/^(mostre|mostrar|liste|listar|ver|quais)?\s*(minhas\s+)?tarefas\??$/.test(low)) return { kind: 'tasks' }
  return { kind: 'chat' }
}
