/**
 * Pedidos diretos que não precisam de modelo nenhum: "abra o navegador", "abrir o youtube", "abre o discord".
 * O resultado é uma chamada de ferramenta pronta, que passa pelo MESMO caminho de permissões, confirmações e verificação
 * do resto do agente; só a ida ao modelo (segundos) é pulada. Se a ferramenta falhar, o agente segue normalmente com o modelo.
 * Qualquer coisa com mais de uma parte ("abra o chrome e pesquise gatos") devolve null e vai para o modelo.
 */
// Keys are the name without spaces, dots or dashes ("yt music" -> "ytmusic").
const SITES = {
  youtube: 'https://www.youtube.com', yt: 'https://www.youtube.com', ytmusic: 'https://music.youtube.com', youtubemusic: 'https://music.youtube.com', musicayoutube: 'https://music.youtube.com',
  google: 'https://www.google.com', gmail: 'https://mail.google.com', drive: 'https://drive.google.com', googledrive: 'https://drive.google.com', agenda: 'https://calendar.google.com',
  googlecalendar: 'https://calendar.google.com', maps: 'https://maps.google.com', googlemaps: 'https://maps.google.com', tradutor: 'https://translate.google.com',
  github: 'https://github.com', chatgpt: 'https://chatgpt.com', gemini: 'https://gemini.google.com', claude: 'https://claude.ai', netflix: 'https://www.netflix.com',
  twitch: 'https://www.twitch.tv', reddit: 'https://www.reddit.com', twitter: 'https://x.com', x: 'https://x.com', instagram: 'https://www.instagram.com',
  facebook: 'https://www.facebook.com', linkedin: 'https://www.linkedin.com', whatsappweb: 'https://web.whatsapp.com', primevideo: 'https://www.primevideo.com',
}
const BROWSERS = 'Google Chrome|Microsoft Edge|Firefox|Brave|Opera'
const OPEN = /^\s*(?:(?:jarvis|j\.a\.r\.v\.i\.s)[,:]?\s+)?(?:por favor[,]?\s+)?(?:(?:você\s+)?pode\s+)?abr(?:a|e|ir)\s+(?:o|a|os|as)?\s*(.{2,40}?)\s*[.!?]*\s*(?:por favor)?\s*[.!?]*\s*$/i
const MORE_THAN_ONE = /[,;:]|\s(?:e|depois|então|entao|para|pra|com|que|onde|quando|se|no|na|em)\s/i
const NOT_AN_APP = /^(?:pasta|arquivo|diret[óo]rio|documento|projeto|p[áa]gina|site|link|imagem|foto|v[ií]deo|[úu]ltim[oa]|configura|painel|tela|aba|janela)/i
const ONLY_WORDS = /^[\p{L}\p{N} .+-]{2,40}$/u

export function quickAction(text) {
  const m = OPEN.exec(String(text ?? ''))
  if (!m) return null
  const target = m[1].trim().replace(/^(?:o|a|os|as)\s+/i, '')
  if (!target || MORE_THAN_ONE.test(` ${target} `) || NOT_AN_APP.test(target)) return null
  // an address
  const url = /^(?:https?:\/\/)?((?:[\w-]+\.)+[a-z]{2,}(?::\d+)?)(\/\S*)?$/i.exec(target)
  if (url) return { tool: 'url_open', args: { url: /^https?:\/\//i.test(target) ? target : `https://${target}` }, then: `Abri ${url[1]}.` }
  const key = target.toLowerCase().replace(/[\s.-]+/g, '')
  if (SITES[key]) return { tool: 'url_open', args: { url: SITES[key] }, then: `Abri o ${target}.` }
  if (/^(?:navegador|browser|internet)(?: padr[aã]o)?$/i.test(target)) return { tool: 'app_open', args: { name: BROWSERS }, then: 'Abri o navegador.' }
  if (!ONLY_WORDS.test(target)) return null
  return { tool: 'app_open', args: { name: target }, then: `Abri o ${target}.` }
}
