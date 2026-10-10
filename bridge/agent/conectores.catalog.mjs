/**
 * Connector catalogue: services JARVIS can read from and (with the owner's permission) change.
 * Declarative on purpose: the engine in conectores.mjs turns each tool into a real HTTP request, so adding a service
 * is data, not a new code path with its own security story.
 *
 * Connector:  { id, label, category, desc, help, base, hosts?, allowPrivate?, fields[], auth, headers?, queryFields?, test, testArgs?, tools[] }
 *   base        URL template; {field} placeholders are filled from the connector's fields
 *   hosts       hostnames the final URL may have (a leading "." = any subdomain). Required unless allowPrivate
 *   allowPrivate  the owner points it at his own server (Home Assistant, self-hosted GitLab...): any http(s) host
 *   fields      { name, label, secret?, required?, kind: text|url|slug, default?, placeholder? }   secrets go to the encrypted vault
 *   auth        { type: none|bearer|header|basic|query, ... }
 * Tool:       { name, desc, risk: read|write|danger, method, path, params:{name:desc}, req[], query:{arg:'key'}, body:{arg:'key'},
 *               json[] (args that are JSON), fixedQuery, fixedBody, defaults, max, headers, rawQuery, bodyFn, bodyRaw, graphql, pick, failIf, custom }
 *   path        {name} = one URL-encoded segment, {+name} = a path whose "/" are kept
 * Everything here is verified against a local server in test/agent/conectores.test.mjs; services themselves are not called by the tests.
 */

const clip = (s, n = 300) => (s == null ? s : String(s).length > n ? String(s).slice(0, n) + '…' : s)
const plain = (html) => String(html ?? '').replace(/<[^>]+>/g, '').replace(/&quot;/g, '"').replace(/&amp;/g, '&').replace(/&#039;/g, "'")
const adf = (t) => ({ type: 'doc', version: 1, content: String(t).split(/\n+/).map((line) => ({ type: 'paragraph', content: [{ type: 'text', text: line || ' ' }] })) })
const notionText = (rt) => (rt ?? []).map((x) => x.plain_text).join('')
const notionTitle = (o) => notionText(o?.properties ? Object.values(o.properties).find((p) => p.type === 'title')?.title : o?.title)
const notionProps = (props) => Object.fromEntries(Object.entries(props ?? {}).map(([k, p]) => [k, p.type === 'title' ? notionText(p.title) : p.type === 'rich_text' ? notionText(p.rich_text) : p.type === 'select' ? p.select?.name : p.type === 'status' ? p.status?.name : p.type === 'number' ? p.number : p.type === 'checkbox' ? p.checkbox : p.type === 'date' ? p.date?.start : p.type === 'url' ? p.url : `(${p.type})`]))
const blocksOf = (text) => String(text).split(/\n+/).filter(Boolean).slice(0, 50).map((line) => ({ object: 'block', type: 'paragraph', paragraph: { rich_text: [{ type: 'text', text: { content: line.slice(0, 1900) } }] } }))
// ---- Google helpers
const gs = (s) => `https://www.googleapis.com/auth/${s}`
const addr = (v, name) => {
  const list = String(v).split(',').map((x) => x.trim()).filter(Boolean)
  if (!list.length || list.length > 10 || list.some((x) => !/^[^\s<>,;"()]+@[^\s<>,;"()]+\.[^\s<>,;"()]+$/.test(x))) throw new Error(`${name}: use endereços de e-mail simples, separados por vírgula (até 10)`)
  return list.join(', ')
}
const noCrlf = (v, name) => { if (/[\r\n]/.test(String(v))) throw new Error(`${name} inválido`); return String(v) }
const mime = (a) => {
  const lines = [`To: ${addr(a.to, 'destinatário')}`, ...(a.cc ? [`Cc: ${addr(a.cc, 'cc')}`] : []), `Subject: =?UTF-8?B?${Buffer.from(noCrlf(a.subject, 'assunto')).toString('base64')}?=`, 'MIME-Version: 1.0', 'Content-Type: text/plain; charset="UTF-8"', 'Content-Transfer-Encoding: base64', '', Buffer.from(String(a.text)).toString('base64').replace(/(.{76})/g, '$1\r\n')]
  return Buffer.from(lines.join('\r\n')).toString('base64url')
}
const hdr = (m, n) => m.payload?.headers?.find((h) => h.name.toLowerCase() === n)?.value
const bodyText = (p) => {
  const walk = (x, mimeType) => (!x ? '' : x.mimeType === mimeType && x.body?.data ? Buffer.from(x.body.data, 'base64url').toString('utf8') : (x.parts ?? []).map((y) => walk(y, mimeType)).join('\n'))
  return walk(p, 'text/plain').trim() || plain(walk(p, 'text/html').replace(/<(script|style)[\s\S]*?<\/\1>/gi, '')).replace(/\s+\n/g, '\n').trim()
}
const attachments = (p) => (!p ? [] : [...(p.filename && p.body?.attachmentId ? [{ name: p.filename, size: p.body.size }] : []), ...(p.parts ?? []).flatMap(attachments)])
const iso = (v, name) => { if (!/^\d{4}-\d{2}-\d{2}(T\d{2}:\d{2}(:\d{2})?(\.\d+)?(Z|[+-]\d{2}:\d{2})?)?$/.test(String(v))) throw new Error(`${name}: use AAAA-MM-DD ou AAAA-MM-DDTHH:MM:SS-03:00`); return String(v) }
const when = (v, tz, name) => (/^\d{4}-\d{2}-\d{2}$/.test(iso(v, name)) ? { date: v } : { dateTime: v, ...(tz ? { timeZone: tz } : {}) })
const rows = (v) => (Array.isArray(v) && v.length && v.every(Array.isArray) ? v : Array.isArray(v) ? [v] : [[v]])
const docText = (d) => (d.body?.content ?? []).flatMap((e) => e.paragraph?.elements ?? []).map((x) => x.textRun?.content ?? '').join('')
const GOOGLE_NOTE = 'Antes: na tela Conectores, cadastre a sua conta Google (Client ID e Client Secret) e entre. Ao ligar este conector o Google pede só as permissões dele, de leitura; alterar pede uma segunda autorização.'
const googleBase = { category: 'Google', fields: [], auth: { type: 'google' }, help: GOOGLE_NOTE }

function googleConnectors() {
  return [
    {
      ...googleBase, id: 'gmail', label: 'Gmail', desc: 'Ler e buscar e-mails; criar rascunhos e enviar (o envio é sempre confirmado).',
      base: 'https://gmail.googleapis.com/gmail/v1/users/me', hosts: ['gmail.googleapis.com'], scopes: { read: [gs('gmail.readonly')], write: [gs('gmail.compose')] }, test: 'profile',
      tools: [
        { name: 'profile', desc: 'Minha caixa de e-mail (endereço e totais).', risk: 'read', method: 'GET', path: '/profile', pick: (j) => ({ email: j.emailAddress, messages: j.messagesTotal, threads: j.threadsTotal }) },
        { name: 'labels', desc: 'Marcadores (inclui INBOX, UNREAD, STARRED).', risk: 'read', method: 'GET', path: '/labels', pick: (j) => (j.labels ?? []).map((l) => ({ id: l.id, name: l.name })) },
        { name: 'search', desc: 'Busca e-mails com a sintaxe do Gmail (ex.: "is:unread newer_than:2d", "from:fulano subject:nota"). Devolve remetente, assunto, data e trecho.', risk: 'read', params: { q: 'consulta do Gmail', limit: 'quantos (padrão 10)' }, defaults: { limit: 10 }, max: { limit: 20 }, custom: async ({ get, args }) => { const l = await get(`/messages?maxResults=${args.limit}${args.q ? `&q=${encodeURIComponent(args.q)}` : ''}`); const ids = (l?.messages ?? []).map((m) => m.id); const items = await Promise.all(ids.map((id) => get(`/messages/${encodeURIComponent(id)}?format=metadata&metadataHeaders=From&metadataHeaders=Subject&metadataHeaders=Date`))); return items.map((m) => ({ id: m.id, threadId: m.threadId, from: hdr(m, 'from'), subject: hdr(m, 'subject'), date: hdr(m, 'date'), snippet: clip(plain(m.snippet), 160), unread: m.labelIds?.includes('UNREAD') })) } },
        { name: 'message', desc: 'Lê um e-mail inteiro pelo id (texto e nomes dos anexos).', risk: 'read', method: 'GET', path: '/messages/{id}', params: { id: 'id do e-mail' }, req: ['id'], fixedQuery: { format: 'full' }, pick: (m) => ({ id: m.id, from: hdr(m, 'from'), to: hdr(m, 'to'), cc: hdr(m, 'cc'), subject: hdr(m, 'subject'), date: hdr(m, 'date'), text: clip(bodyText(m.payload), 6000), attachments: attachments(m.payload) }) },
        { name: 'draft', desc: 'Cria um RASCUNHO (não envia).', risk: 'write', method: 'POST', path: '/drafts', params: { to: 'destinatário(s), separados por vírgula', subject: 'assunto', text: 'corpo em texto', cc: 'cópia (opcional)' }, req: ['to', 'subject', 'text'], bodyFn: (a) => ({ message: { raw: mime(a) } }), pick: (d) => ({ draftId: d.id }) },
        { name: 'send', desc: 'ENVIA um e-mail agora (não dá para desfazer).', risk: 'danger', method: 'POST', path: '/messages/send', params: { to: 'destinatário(s), separados por vírgula', subject: 'assunto', text: 'corpo em texto', cc: 'cópia (opcional)' }, req: ['to', 'subject', 'text'], bodyFn: (a) => ({ raw: mime(a) }), pick: (m) => ({ id: m.id, threadId: m.threadId }) },
      ],
    },
    {
      ...googleBase, id: 'google-drive', label: 'Google Drive', desc: 'Buscar e ler arquivos; criar documentos, planilhas e pastas (só ele mexe nos arquivos que criou).',
      base: 'https://www.googleapis.com/drive/v3', hosts: ['www.googleapis.com'], scopes: { read: [gs('drive.readonly')], write: [gs('drive.file')] }, test: 'about',
      tools: [
        { name: 'about', desc: 'Minha conta e espaço usado.', risk: 'read', method: 'GET', path: '/about', fixedQuery: { fields: 'user(displayName,emailAddress),storageQuota(limit,usage)' }, pick: (j) => ({ user: j.user?.displayName, email: j.user?.emailAddress, usedGB: Math.round(Number(j.storageQuota?.usage ?? 0) / 2 ** 30 * 10) / 10, limitGB: j.storageQuota?.limit ? Math.round(Number(j.storageQuota.limit) / 2 ** 30) : null }) },
        { name: 'files', desc: 'Busca arquivos (sintaxe do Drive, ex.: "name contains \'nota\'", "mimeType=\'application/pdf\'"; vazio = mais recentes).', risk: 'read', method: 'GET', path: '/files', params: { q: 'consulta (opcional)', limit: 'quantos' }, query: { q: 'q', limit: 'pageSize' }, fixedQuery: { orderBy: 'modifiedTime desc', fields: 'files(id,name,mimeType,modifiedTime,size,webViewLink)' }, defaults: { limit: 20, q: 'trashed=false' }, max: { limit: 100 }, pick: (j) => (j.files ?? []).map((f) => ({ id: f.id, name: f.name, type: f.mimeType, modified: f.modifiedTime, sizeKB: f.size ? Math.round(f.size / 1024) : undefined, url: f.webViewLink })) },
        { name: 'read', desc: 'Lê o TEXTO de um arquivo (Docs, Planilhas e Apresentações do Google, texto, JSON, CSV).', risk: 'read', params: { id: 'id do arquivo' }, req: ['id'], custom: async ({ get, args }) => { const id = encodeURIComponent(args.id); const meta = await get(`/files/${id}?fields=id,name,mimeType,size`); const mt = String(meta.mimeType); const text = mt === 'application/vnd.google-apps.document' || mt === 'application/vnd.google-apps.presentation' ? await get(`/files/${id}/export?mimeType=text/plain`) : mt === 'application/vnd.google-apps.spreadsheet' ? await get(`/files/${id}/export?mimeType=text/csv`) : /^(text\/|application\/json)/.test(mt) && Number(meta.size ?? 0) < 1_000_000 ? await get(`/files/${id}?alt=media`) : null; if (text === null) throw new Error(`tipo de arquivo sem leitura de texto: ${mt}`); return { name: meta.name, type: mt, text: clip(typeof text === 'string' ? text : JSON.stringify(text), 12000) } } },
        { name: 'create', desc: 'Cria um documento, uma planilha ou uma pasta vazia (kind = document | spreadsheet | folder).', risk: 'write', method: 'POST', path: '/files', params: { kind: 'document|spreadsheet|folder', name: 'nome', parent: 'id da pasta (opcional)' }, req: ['kind', 'name'], bodyFn: (a) => { const kinds = { document: 'application/vnd.google-apps.document', spreadsheet: 'application/vnd.google-apps.spreadsheet', folder: 'application/vnd.google-apps.folder' }; if (!kinds[a.kind]) throw new Error('kind deve ser document, spreadsheet ou folder'); return { name: a.name, mimeType: kinds[a.kind], ...(a.parent ? { parents: [a.parent] } : {}) } }, fixedQuery: { fields: 'id,name,webViewLink' }, pick: (f) => ({ id: f.id, name: f.name, url: f.webViewLink }) },
      ],
    },
    {
      ...googleBase, id: 'google-calendar', label: 'Google Agenda', desc: 'Ver a agenda e criar ou apagar eventos (convites a outras pessoas não são enviados).',
      base: 'https://www.googleapis.com/calendar/v3', hosts: ['www.googleapis.com'], scopes: { read: [gs('calendar.readonly')], write: [gs('calendar.events')] }, test: 'calendars',
      tools: [
        { name: 'calendars', desc: 'Minhas agendas.', risk: 'read', method: 'GET', path: '/users/me/calendarList', pick: (j) => (j.items ?? []).map((c) => ({ id: c.id, name: c.summary, primary: c.primary, timeZone: c.timeZone })) },
        { name: 'events', desc: 'Próximos eventos de uma agenda (padrão: a principal, a partir de agora).', risk: 'read', method: 'GET', path: '/calendars/{calendar}/events', params: { calendar: 'id da agenda (padrão primary)', from: 'início ISO (padrão agora)', to: 'fim ISO (opcional)', limit: 'quantos' }, query: { from: 'timeMin', to: 'timeMax', limit: 'maxResults' }, fixedQuery: { singleEvents: 'true', orderBy: 'startTime' }, defaults: { calendar: 'primary', from: () => new Date().toISOString(), limit: 15 }, max: { limit: 50 }, pick: (j) => (j.items ?? []).map((e) => ({ id: e.id, title: e.summary, start: e.start?.dateTime ?? e.start?.date, end: e.end?.dateTime ?? e.end?.date, where: e.location, url: e.htmlLink })) },
        { name: 'event_create', desc: 'Cria um evento. start/end em AAAA-MM-DDTHH:MM:SS-03:00 (ou só a data para o dia todo).', risk: 'write', method: 'POST', path: '/calendars/{calendar}/events', params: { calendar: 'id da agenda (padrão primary)', title: 'título', start: 'início', end: 'fim', description: 'texto (opcional)', where: 'local (opcional)', timeZone: 'fuso, ex.: America/Sao_Paulo (opcional)' }, req: ['title', 'start', 'end'], defaults: { calendar: 'primary' }, fixedQuery: { sendUpdates: 'none' }, bodyFn: (a) => ({ summary: a.title, ...(a.description ? { description: a.description } : {}), ...(a.where ? { location: a.where } : {}), start: when(a.start, a.timeZone, 'start'), end: when(a.end, a.timeZone, 'end') }), pick: (e) => ({ id: e.id, url: e.htmlLink }) },
        { name: 'quick_add', desc: 'Cria um evento a partir de uma frase ("Dentista sexta 15h").', risk: 'write', method: 'POST', path: '/calendars/{calendar}/events/quickAdd', params: { calendar: 'id da agenda (padrão primary)', text: 'frase' }, req: ['text'], defaults: { calendar: 'primary' }, query: { text: 'text' }, fixedQuery: { sendUpdates: 'none' }, pick: (e) => ({ id: e.id, title: e.summary, start: e.start?.dateTime ?? e.start?.date, url: e.htmlLink }) },
        { name: 'event_delete', desc: 'Apaga um evento (não volta).', risk: 'danger', method: 'DELETE', path: '/calendars/{calendar}/events/{event_id}', params: { calendar: 'id da agenda (padrão primary)', event_id: 'id do evento' }, req: ['event_id'], defaults: { calendar: 'primary' }, fixedQuery: { sendUpdates: 'none' } },
      ],
    },
    {
      ...googleBase, id: 'google-sheets', label: 'Google Planilhas', desc: 'Ler e escrever células e linhas.',
      base: 'https://sheets.googleapis.com/v4/spreadsheets', hosts: ['sheets.googleapis.com'], scopes: { read: [gs('spreadsheets.readonly')], write: [gs('spreadsheets')] }, test: null,
      tools: [
        { name: 'info', desc: 'Título e abas de uma planilha.', risk: 'read', method: 'GET', path: '/{id}', params: { id: 'id da planilha' }, req: ['id'], fixedQuery: { fields: 'properties.title,sheets.properties(title,gridProperties)' }, pick: (j) => ({ title: j.properties?.title, tabs: (j.sheets ?? []).map((s) => ({ name: s.properties?.title, rows: s.properties?.gridProperties?.rowCount, cols: s.properties?.gridProperties?.columnCount })) }) },
        { name: 'read', desc: 'Lê um intervalo (ex.: Página1!A1:D20).', risk: 'read', method: 'GET', path: '/{id}/values/{range}', params: { id: 'id da planilha', range: 'intervalo A1' }, req: ['id', 'range'], pick: (j) => ({ range: j.range, values: j.values ?? [] }) },
        { name: 'append', desc: 'Acrescenta uma linha (ou várias) ao fim da tabela do intervalo. values = lista de valores, ou lista de listas.', risk: 'write', method: 'POST', path: '/{id}/values/{range}:append', params: { id: 'id da planilha', range: 'aba ou intervalo, ex.: Página1!A:D', values: 'JSON: ["a",1] ou [["a",1],["b",2]]' }, req: ['id', 'range', 'values'], json: ['values'], fixedQuery: { valueInputOption: 'USER_ENTERED', insertDataOption: 'INSERT_ROWS' }, bodyFn: (a) => ({ values: rows(a.values) }), pick: (j) => ({ range: j.updates?.updatedRange, rows: j.updates?.updatedRows }) },
        { name: 'update', desc: 'Substitui o conteúdo de um intervalo (sobrescreve as células).', risk: 'write', method: 'PUT', path: '/{id}/values/{range}', params: { id: 'id da planilha', range: 'intervalo A1', values: 'JSON: lista de listas' }, req: ['id', 'range', 'values'], json: ['values'], fixedQuery: { valueInputOption: 'USER_ENTERED' }, bodyFn: (a) => ({ values: rows(a.values) }), pick: (j) => ({ range: j.updatedRange, cells: j.updatedCells }) },
      ],
    },
    {
      ...googleBase, id: 'google-docs', label: 'Google Docs', desc: 'Ler documentos e acrescentar texto ao fim.',
      base: 'https://docs.googleapis.com/v1/documents', hosts: ['docs.googleapis.com'], scopes: { read: [gs('documents.readonly')], write: [gs('documents')] }, test: null,
      tools: [
        { name: 'read', desc: 'Lê o texto de um documento.', risk: 'read', method: 'GET', path: '/{id}', params: { id: 'id do documento' }, req: ['id'], pick: (d) => ({ title: d.title, text: clip(docText(d), 12000) }) },
        { name: 'append', desc: 'Acrescenta texto ao fim do documento.', risk: 'write', method: 'POST', path: '/{id}:batchUpdate', params: { id: 'id do documento', text: 'texto' }, req: ['id', 'text'], bodyFn: (a) => ({ requests: [{ insertText: { endOfSegmentLocation: {}, text: `${String(a.text)}\n` } }] }), pick: (j) => ({ documentId: j.documentId }) },
      ],
    },
    {
      ...googleBase, id: 'google-tasks', label: 'Google Tarefas', desc: 'Listas e tarefas.',
      base: 'https://tasks.googleapis.com/tasks/v1', hosts: ['tasks.googleapis.com'], scopes: { read: [gs('tasks.readonly')], write: [gs('tasks')] }, test: 'lists',
      tools: [
        { name: 'lists', desc: 'Minhas listas de tarefas.', risk: 'read', method: 'GET', path: '/users/@me/lists', pick: (j) => (j.items ?? []).map((l) => ({ id: l.id, title: l.title })) },
        { name: 'tasks', desc: 'Tarefas de uma lista (padrão: a principal; só as pendentes).', risk: 'read', method: 'GET', path: '/lists/{list}/tasks', params: { list: 'id da lista (padrão @default)' }, defaults: { list: '@default' }, fixedQuery: { showCompleted: 'false', maxResults: '50' }, pick: (j) => (j.items ?? []).map((t) => ({ id: t.id, title: t.title, due: t.due, notes: clip(t.notes, 200), status: t.status })) },
        { name: 'task_create', desc: 'Cria uma tarefa (due em AAAA-MM-DD, opcional).', risk: 'write', method: 'POST', path: '/lists/{list}/tasks', params: { list: 'id da lista (padrão @default)', title: 'título', notes: 'notas (opcional)', due: 'data AAAA-MM-DD (opcional)' }, req: ['title'], defaults: { list: '@default' }, bodyFn: (a) => ({ title: a.title, ...(a.notes ? { notes: a.notes } : {}), ...(a.due ? { due: `${iso(a.due, 'due').slice(0, 10)}T00:00:00.000Z` } : {}) }), pick: (t) => ({ id: t.id, title: t.title }) },
        { name: 'task_complete', desc: 'Conclui uma tarefa.', risk: 'write', method: 'PATCH', path: '/lists/{list}/tasks/{task_id}', params: { list: 'id da lista (padrão @default)', task_id: 'id da tarefa' }, req: ['task_id'], defaults: { list: '@default' }, fixedBody: { status: 'completed' }, pick: (t) => ({ id: t.id, status: t.status }) },
      ],
    },
    {
      ...googleBase, id: 'google-contacts', label: 'Google Contatos', desc: 'Buscar contatos (nome, e-mail e telefone). Só leitura.',
      base: 'https://people.googleapis.com/v1', hosts: ['people.googleapis.com'], scopes: { read: [gs('contacts.readonly')], write: [] }, test: 'list', testArgs: { limit: '1' },
      tools: [
        { name: 'search', desc: 'Busca contatos por nome, e-mail ou telefone.', risk: 'read', method: 'GET', path: '/people:searchContacts', params: { query: 'texto', limit: 'quantos' }, req: ['query'], query: { query: 'query', limit: 'pageSize' }, fixedQuery: { readMask: 'names,emailAddresses,phoneNumbers' }, defaults: { limit: 10 }, max: { limit: 30 }, pick: (j) => (j.results ?? []).map((r) => ({ name: r.person?.names?.[0]?.displayName, emails: r.person?.emailAddresses?.map((e) => e.value), phones: r.person?.phoneNumbers?.map((p) => p.value) })) },
        { name: 'list', desc: 'Meus contatos (ordem alfabética).', risk: 'read', method: 'GET', path: '/people/me/connections', params: { limit: 'quantos' }, query: { limit: 'pageSize' }, fixedQuery: { personFields: 'names,emailAddresses,phoneNumbers', sortOrder: 'FIRST_NAME_ASCENDING' }, defaults: { limit: 30 }, max: { limit: 100 }, pick: (j) => (j.connections ?? []).map((p) => ({ name: p.names?.[0]?.displayName, emails: p.emailAddresses?.map((e) => e.value), phones: p.phoneNumbers?.map((x) => x.value) })) },
      ],
    },
  ]
}

const token = (label, help) =>({ name: 'token', label, secret: true, required: true, placeholder: help })

export const CONNECTORS = [
  // ---------------------------------------------------------------------------------------------------- código
  {
    id: 'github', label: 'GitHub', category: 'Código', desc: 'Repositórios, issues, pull requests, arquivos e busca de código.',
    help: 'github.com/settings/tokens (token clássico ou fine-grained; dê só as permissões que quer usar)',
    base: 'https://api.github.com', hosts: ['api.github.com'], headers: { Accept: 'application/vnd.github+json', 'X-GitHub-Api-Version': '2022-11-28' },
    fields: [token('Token de acesso pessoal', 'ghp_… ou github_pat_…')], auth: { type: 'bearer', field: 'token' }, test: 'me',
    tools: [
      { name: 'me', desc: 'Quem sou eu no GitHub (confere o token).', risk: 'read', method: 'GET', path: '/user', pick: (u) => ({ login: u.login, name: u.name, email: u.email, publicRepos: u.public_repos }) },
      { name: 'repos', desc: 'Meus repositórios, os mais recentes primeiro.', risk: 'read', method: 'GET', path: '/user/repos', params: { limit: 'quantos (padrão 30)' }, query: { limit: 'per_page' }, fixedQuery: { sort: 'pushed' }, defaults: { limit: 30 }, max: { limit: 100 }, pick: (j) => j.map((r) => ({ repo: r.full_name, private: r.private, description: clip(r.description, 120), pushed: r.pushed_at, url: r.html_url })) },
      { name: 'issues', desc: 'Issues de um repositório.', risk: 'read', method: 'GET', path: '/repos/{owner}/{repo}/issues', params: { owner: 'dono', repo: 'repositório', state: 'open|closed|all', limit: 'quantas' }, req: ['owner', 'repo'], query: { state: 'state', limit: 'per_page' }, defaults: { state: 'open', limit: 20 }, max: { limit: 100 }, pick: (j) => j.filter((i) => !i.pull_request).map((i) => ({ number: i.number, title: i.title, state: i.state, by: i.user?.login, labels: i.labels?.map((l) => l.name), url: i.html_url })) },
      { name: 'issue_get', desc: 'Uma issue com o texto.', risk: 'read', method: 'GET', path: '/repos/{owner}/{repo}/issues/{number}', params: { owner: 'dono', repo: 'repositório', number: 'número' }, req: ['owner', 'repo', 'number'], pick: (i) => ({ number: i.number, title: i.title, state: i.state, by: i.user?.login, body: clip(i.body, 3000), comments: i.comments, url: i.html_url }) },
      { name: 'pulls', desc: 'Pull requests de um repositório.', risk: 'read', method: 'GET', path: '/repos/{owner}/{repo}/pulls', params: { owner: 'dono', repo: 'repositório', state: 'open|closed|all', limit: 'quantos' }, req: ['owner', 'repo'], query: { state: 'state', limit: 'per_page' }, defaults: { state: 'open', limit: 20 }, max: { limit: 100 }, pick: (j) => j.map((x) => ({ number: x.number, title: x.title, by: x.user?.login, draft: x.draft, head: x.head?.ref, url: x.html_url })) },
      { name: 'file', desc: 'Lê um arquivo (ou lista uma pasta) do repositório.', risk: 'read', method: 'GET', path: '/repos/{owner}/{repo}/contents/{+path}', params: { owner: 'dono', repo: 'repositório', path: 'caminho no repositório', ref: 'branch/tag (opcional)' }, req: ['owner', 'repo', 'path'], query: { ref: 'ref' }, pick: (j) => (Array.isArray(j) ? j.map((f) => ({ name: f.name, type: f.type, size: f.size })) : { path: j.path, size: j.size, text: clip(Buffer.from(j.content ?? '', 'base64').toString('utf8'), 8000) }) },
      { name: 'search_code', desc: 'Busca código (sintaxe do GitHub, ex.: "repo:dono/nome função").', risk: 'read', method: 'GET', path: '/search/code', params: { q: 'consulta', limit: 'quantos' }, req: ['q'], query: { q: 'q', limit: 'per_page' }, defaults: { limit: 10 }, max: { limit: 30 }, pick: (j) => ({ total: j.total_count, items: j.items.map((i) => ({ repo: i.repository.full_name, path: i.path, url: i.html_url })) }) },
      { name: 'issue_create', desc: 'Cria uma issue.', risk: 'write', method: 'POST', path: '/repos/{owner}/{repo}/issues', params: { owner: 'dono', repo: 'repositório', title: 'título', body: 'texto', labels: 'lista de rótulos (JSON)' }, req: ['owner', 'repo', 'title'], body: { title: 'title', body: 'body', labels: 'labels' }, json: ['labels'], pick: (i) => ({ number: i.number, url: i.html_url }) },
      { name: 'issue_comment', desc: 'Comenta em uma issue ou PR.', risk: 'write', method: 'POST', path: '/repos/{owner}/{repo}/issues/{number}/comments', params: { owner: 'dono', repo: 'repositório', number: 'número', body: 'comentário' }, req: ['owner', 'repo', 'number', 'body'], body: { body: 'body' }, pick: (c) => ({ id: c.id, url: c.html_url }) },
      { name: 'issue_close', desc: 'Fecha uma issue.', risk: 'write', method: 'PATCH', path: '/repos/{owner}/{repo}/issues/{number}', params: { owner: 'dono', repo: 'repositório', number: 'número' }, req: ['owner', 'repo', 'number'], fixedBody: { state: 'closed' }, pick: (i) => ({ number: i.number, state: i.state }) },
    ],
  },
  {
    id: 'gitlab', label: 'GitLab', category: 'Código', desc: 'Projetos, issues e merge requests (gitlab.com ou o seu servidor).',
    help: 'Preferências › Tokens de acesso (escopo read_api, e api para escrever)',
    base: '{host}/api/v4', allowPrivate: true,
    fields: [{ name: 'host', label: 'Endereço do GitLab', kind: 'url', default: 'https://gitlab.com', placeholder: 'https://gitlab.com' }, token('Token de acesso', 'glpat-…')],
    auth: { type: 'header', name: 'PRIVATE-TOKEN', field: 'token' }, test: 'me',
    tools: [
      { name: 'me', desc: 'Quem sou eu no GitLab.', risk: 'read', method: 'GET', path: '/user', pick: (u) => ({ username: u.username, name: u.name, email: u.email }) },
      { name: 'projects', desc: 'Meus projetos.', risk: 'read', method: 'GET', path: '/projects', params: { search: 'nome (opcional)', limit: 'quantos' }, query: { search: 'search', limit: 'per_page' }, fixedQuery: { membership: 'true', order_by: 'last_activity_at' }, defaults: { limit: 20 }, max: { limit: 100 }, pick: (j) => j.map((x) => ({ id: x.id, path: x.path_with_namespace, url: x.web_url, activity: x.last_activity_at })) },
      { name: 'issues', desc: 'Issues de um projeto.', risk: 'read', method: 'GET', path: '/projects/{id}/issues', params: { id: 'id ou caminho do projeto', state: 'opened|closed|all', limit: 'quantas' }, req: ['id'], query: { state: 'state', limit: 'per_page' }, defaults: { state: 'opened', limit: 20 }, max: { limit: 100 }, pick: (j) => j.map((i) => ({ iid: i.iid, title: i.title, state: i.state, author: i.author?.username, url: i.web_url })) },
      { name: 'merge_requests', desc: 'Merge requests de um projeto.', risk: 'read', method: 'GET', path: '/projects/{id}/merge_requests', params: { id: 'id ou caminho do projeto', state: 'opened|merged|closed|all' }, req: ['id'], query: { state: 'state' }, defaults: { state: 'opened' }, pick: (j) => j.map((m) => ({ iid: m.iid, title: m.title, author: m.author?.username, source: m.source_branch, url: m.web_url })) },
      { name: 'file', desc: 'Lê um arquivo do repositório.', risk: 'read', method: 'GET', path: '/projects/{id}/repository/files/{path}/raw', params: { id: 'id ou caminho do projeto', path: 'caminho do arquivo', ref: 'branch (padrão main)' }, req: ['id', 'path'], query: { ref: 'ref' }, defaults: { ref: 'main' }, pick: (t) => ({ text: clip(typeof t === 'string' ? t : JSON.stringify(t), 8000) }) },
      { name: 'issue_create', desc: 'Cria uma issue.', risk: 'write', method: 'POST', path: '/projects/{id}/issues', params: { id: 'id ou caminho do projeto', title: 'título', description: 'texto' }, req: ['id', 'title'], body: { title: 'title', description: 'description' }, pick: (i) => ({ iid: i.iid, url: i.web_url }) },
    ],
  },
  {
    id: 'vercel', label: 'Vercel', category: 'Nuvem e hospedagem', desc: 'Projetos e deploys.',
    help: 'vercel.com/account/tokens', base: 'https://api.vercel.com', hosts: ['api.vercel.com'],
    fields: [token('Token', 'cole o token'), { name: 'teamId', label: 'Team ID (opcional)', kind: 'slug', placeholder: 'team_…' }], queryFields: { teamId: 'teamId' },
    auth: { type: 'bearer', field: 'token' }, test: 'me',
    tools: [
      { name: 'me', desc: 'Minha conta Vercel.', risk: 'read', method: 'GET', path: '/v2/user', pick: (j) => ({ username: j.user?.username, email: j.user?.email }) },
      { name: 'projects', desc: 'Projetos.', risk: 'read', method: 'GET', path: '/v9/projects', params: { limit: 'quantos' }, query: { limit: 'limit' }, defaults: { limit: 20 }, max: { limit: 100 }, pick: (j) => (j.projects ?? []).map((x) => ({ id: x.id, name: x.name, framework: x.framework, updated: x.updatedAt })) },
      { name: 'deployments', desc: 'Deploys recentes (de um projeto, se informado).', risk: 'read', method: 'GET', path: '/v6/deployments', params: { projectId: 'id do projeto (opcional)', limit: 'quantos' }, query: { projectId: 'projectId', limit: 'limit' }, defaults: { limit: 10 }, max: { limit: 50 }, pick: (j) => (j.deployments ?? []).map((d) => ({ id: d.uid, name: d.name, state: d.state ?? d.readyState, url: d.url, created: d.created })) },
    ],
  },
  {
    id: 'netlify', label: 'Netlify', category: 'Nuvem e hospedagem', desc: 'Sites e deploys.',
    help: 'app.netlify.com/user/applications (Personal access tokens)', base: 'https://api.netlify.com/api/v1', hosts: ['api.netlify.com'],
    fields: [token('Token de acesso pessoal', 'cole o token')], auth: { type: 'bearer', field: 'token' }, test: 'sites',
    tools: [
      { name: 'sites', desc: 'Meus sites.', risk: 'read', method: 'GET', path: '/sites', params: { limit: 'quantos' }, query: { limit: 'per_page' }, defaults: { limit: 20 }, max: { limit: 100 }, pick: (j) => j.map((s) => ({ id: s.id, name: s.name, url: s.ssl_url ?? s.url, updated: s.updated_at })) },
      { name: 'deploys', desc: 'Deploys de um site.', risk: 'read', method: 'GET', path: '/sites/{site_id}/deploys', params: { site_id: 'id do site', limit: 'quantos' }, req: ['site_id'], query: { limit: 'per_page' }, defaults: { limit: 10 }, max: { limit: 50 }, pick: (j) => j.map((d) => ({ id: d.id, state: d.state, branch: d.branch, created: d.created_at, error: d.error_message })) },
    ],
  },
  {
    id: 'cloudflare', label: 'Cloudflare', category: 'Nuvem e hospedagem', desc: 'Zonas e registros DNS.',
    help: 'dash.cloudflare.com/profile/api-tokens (permissão Zone:DNS:Read, e Edit para alterar)', base: 'https://api.cloudflare.com/client/v4', hosts: ['api.cloudflare.com'],
    fields: [token('Token de API', 'cole o token')], auth: { type: 'bearer', field: 'token' }, test: 'verify',
    failIf: (j) => (j?.success === false ? (j.errors ?? []).map((e) => e.message).join('; ') || 'erro' : null),
    tools: [
      { name: 'verify', desc: 'Confere o token.', risk: 'read', method: 'GET', path: '/user/tokens/verify', pick: (j) => j.result },
      { name: 'zones', desc: 'Zonas (domínios).', risk: 'read', method: 'GET', path: '/zones', params: { name: 'domínio (opcional)' }, query: { name: 'name' }, pick: (j) => (j.result ?? []).map((z) => ({ id: z.id, name: z.name, status: z.status })) },
      { name: 'dns_list', desc: 'Registros DNS de uma zona.', risk: 'read', method: 'GET', path: '/zones/{zone_id}/dns_records', params: { zone_id: 'id da zona', type: 'A|CNAME|TXT… (opcional)', name: 'nome (opcional)' }, req: ['zone_id'], query: { type: 'type', name: 'name' }, pick: (j) => (j.result ?? []).map((r) => ({ id: r.id, type: r.type, name: r.name, content: clip(r.content, 120), proxied: r.proxied, ttl: r.ttl })) },
      { name: 'dns_create', desc: 'Cria um registro DNS.', risk: 'write', method: 'POST', path: '/zones/{zone_id}/dns_records', params: { zone_id: 'id da zona', type: 'A|AAAA|CNAME|TXT', name: 'nome', content: 'valor', ttl: '1 = automático', proxied: 'true|false' }, req: ['zone_id', 'type', 'name', 'content'], body: { type: 'type', name: 'name', content: 'content', ttl: 'ttl', proxied: 'proxied' }, json: ['ttl', 'proxied'], defaults: { ttl: 1 }, pick: (j) => j.result && { id: j.result.id, name: j.result.name } },
      { name: 'dns_delete', desc: 'Apaga um registro DNS (não volta).', risk: 'danger', method: 'DELETE', path: '/zones/{zone_id}/dns_records/{record_id}', params: { zone_id: 'id da zona', record_id: 'id do registro' }, req: ['zone_id', 'record_id'], pick: (j) => j.result },
    ],
  },
  {
    id: 'sentry', label: 'Sentry', category: 'Código', desc: 'Erros em produção: organizações, projetos e issues.',
    help: 'sentry.io/settings/account/api/auth-tokens', base: 'https://sentry.io/api/0', hosts: ['sentry.io'],
    fields: [token('Token de autenticação', 'sntrys_…')], auth: { type: 'bearer', field: 'token' }, test: 'orgs',
    tools: [
      { name: 'orgs', desc: 'Minhas organizações.', risk: 'read', method: 'GET', path: '/organizations/', pick: (j) => j.map((o) => ({ slug: o.slug, name: o.name })) },
      { name: 'projects', desc: 'Projetos de uma organização.', risk: 'read', method: 'GET', path: '/organizations/{org}/projects/', params: { org: 'slug da organização' }, req: ['org'], pick: (j) => j.map((x) => ({ slug: x.slug, platform: x.platform })) },
      { name: 'issues', desc: 'Issues (erros) de um projeto.', risk: 'read', method: 'GET', path: '/projects/{org}/{project}/issues/', params: { org: 'organização', project: 'projeto', query: 'filtro (padrão is:unresolved)' }, req: ['org', 'project'], query: { query: 'query' }, defaults: { query: 'is:unresolved' }, pick: (j) => j.slice(0, 30).map((i) => ({ id: i.id, title: i.title, level: i.level, count: i.count, lastSeen: i.lastSeen, url: i.permalink })) },
      { name: 'issue_resolve', desc: 'Marca uma issue como resolvida.', risk: 'write', method: 'PUT', path: '/issues/{issue_id}/', params: { issue_id: 'id da issue' }, req: ['issue_id'], fixedBody: { status: 'resolved' }, pick: (j) => ({ id: j.id, status: j.status }) },
    ],
  },
  {
    id: 'supabase', label: 'Supabase (tabelas)', category: 'Dados', desc: 'Lê e altera linhas das tabelas do seu projeto (API REST do Postgres).',
    help: 'Project Settings › API: o ref do projeto e uma chave. Use a anon/publishable (respeita as regras de acesso); a service_role ignora todas elas',
    base: 'https://{project}.supabase.co/rest/v1', hosts: ['.supabase.co'],
    fields: [{ name: 'project', label: 'Ref do projeto', kind: 'slug', required: true, placeholder: 'abcdefghijklmnop' }, token('Chave da API', 'anon / publishable / service_role')],
    auth: { type: 'bearer', field: 'token', also: { apikey: 'token' } }, test: 'select', testArgs: { table: 'x', limit: '1' }, testOkStatuses: [200, 404, 406],
    tools: [
      { name: 'select', desc: 'Lê linhas de uma tabela. filter no formato PostgREST: "status=eq.open&id=gt.10".', risk: 'read', method: 'GET', path: '/{table}', params: { table: 'tabela', select: 'colunas (padrão *)', filter: 'filtros (opcional)', limit: 'quantas (padrão 50)' }, req: ['table'], query: { select: 'select', limit: 'limit' }, rawQuery: 'filter', defaults: { select: '*', limit: 50 }, max: { limit: 500 } },
      { name: 'insert', desc: 'Insere uma linha (JSON) em uma tabela.', risk: 'write', method: 'POST', path: '/{table}', params: { table: 'tabela', row: 'objeto JSON com as colunas' }, req: ['table', 'row'], json: ['row'], bodyFn: (a) => a.row, headers: { Prefer: 'return=representation' } },
      { name: 'update', desc: 'Altera linhas que casam com o filtro (o filtro é obrigatório).', risk: 'write', method: 'PATCH', path: '/{table}', params: { table: 'tabela', filter: 'filtro, ex.: id=eq.5', values: 'objeto JSON com os novos valores' }, req: ['table', 'filter', 'values'], json: ['values'], rawQuery: 'filter', bodyFn: (a) => a.values, headers: { Prefer: 'return=representation' } },
      { name: 'delete', desc: 'Apaga linhas que casam com o filtro (o filtro é obrigatório; não volta).', risk: 'danger', method: 'DELETE', path: '/{table}', params: { table: 'tabela', filter: 'filtro, ex.: id=eq.5' }, req: ['table', 'filter'], rawQuery: 'filter', headers: { Prefer: 'return=representation' } },
    ],
  },

  // ---------------------------------------------------------------------------------------------------- produtividade
  {
    id: 'notion', label: 'Notion', category: 'Produtividade', desc: 'Buscar, ler e escrever em páginas e bancos de dados.',
    help: 'notion.so/profile/integrations: crie uma integração e compartilhe as páginas com ela',
    base: 'https://api.notion.com/v1', hosts: ['api.notion.com'], headers: { 'Notion-Version': '2022-06-28' },
    fields: [token('Segredo da integração', 'ntn_… ou secret_…')], auth: { type: 'bearer', field: 'token' }, test: 'search', testArgs: { limit: '1' },
    tools: [
      { name: 'search', desc: 'Busca páginas e bancos de dados compartilhados com a integração.', risk: 'read', method: 'POST', path: '/search', params: { query: 'texto (opcional)', limit: 'quantos' }, body: { query: 'query', limit: 'page_size' }, defaults: { limit: 10 }, max: { limit: 50 }, pick: (j) => j.results.map((r) => ({ id: r.id, type: r.object, title: notionTitle(r), url: r.url })) },
      { name: 'page_get', desc: 'Dados de uma página (propriedades).', risk: 'read', method: 'GET', path: '/pages/{page_id}', params: { page_id: 'id da página' }, req: ['page_id'], pick: (r) => ({ id: r.id, title: notionTitle(r), url: r.url, properties: notionProps(r.properties) }) },
      { name: 'blocks', desc: 'Conteúdo (texto) de uma página ou bloco.', risk: 'read', method: 'GET', path: '/blocks/{block_id}/children', params: { block_id: 'id da página/bloco', limit: 'quantos blocos' }, req: ['block_id'], query: { limit: 'page_size' }, defaults: { limit: 50 }, max: { limit: 100 }, pick: (j) => j.results.map((b) => ({ id: b.id, type: b.type, text: notionText(b[b.type]?.rich_text) })) },
      { name: 'db_query', desc: 'Linhas de um banco de dados.', risk: 'read', method: 'POST', path: '/databases/{database_id}/query', params: { database_id: 'id do banco', limit: 'quantas' }, req: ['database_id'], body: { limit: 'page_size' }, defaults: { limit: 20 }, max: { limit: 100 }, pick: (j) => j.results.map((r) => ({ id: r.id, url: r.url, ...notionProps(r.properties) })) },
      { name: 'page_create', desc: 'Cria uma página dentro de uma página (parent_type=page) ou de um banco (parent_type=database).', risk: 'write', method: 'POST', path: '/pages', params: { parent_type: 'page|database', parent_id: 'id do pai', title: 'título', text: 'texto (opcional)', title_property: 'nome da coluna de título do banco (padrão Name)' }, req: ['parent_type', 'parent_id', 'title'], bodyFn: (a) => ({ parent: a.parent_type === 'database' ? { database_id: a.parent_id } : { page_id: a.parent_id }, properties: { [a.parent_type === 'database' ? a.title_property || 'Name' : 'title']: { title: [{ text: { content: String(a.title).slice(0, 1900) } }] } }, ...(a.text ? { children: blocksOf(a.text) } : {}) }), pick: (r) => ({ id: r.id, url: r.url }) },
      { name: 'append_text', desc: 'Acrescenta parágrafos ao fim de uma página.', risk: 'write', method: 'PATCH', path: '/blocks/{block_id}/children', params: { block_id: 'id da página/bloco', text: 'texto' }, req: ['block_id', 'text'], bodyFn: (a) => ({ children: blocksOf(a.text) }), pick: (j) => ({ added: j.results?.length }) },
    ],
  },
  {
    id: 'todoist', label: 'Todoist', category: 'Produtividade', desc: 'Tarefas e projetos.',
    help: 'Todoist › Configurações › Integrações › Desenvolvedor (token da API)', base: 'https://api.todoist.com/api/v1', hosts: ['api.todoist.com'],
    fields: [token('Token da API', 'cole o token')], auth: { type: 'bearer', field: 'token' }, test: 'projects',
    tools: [
      { name: 'projects', desc: 'Projetos.', risk: 'read', method: 'GET', path: '/projects', pick: (j) => (j.results ?? j).map((x) => ({ id: x.id, name: x.name })) },
      { name: 'tasks', desc: 'Tarefas abertas (filtro opcional, ex.: "today | overdue").', risk: 'read', method: 'GET', path: '/tasks', params: { filter: 'filtro (opcional)', project_id: 'projeto (opcional)' }, query: { filter: 'filter', project_id: 'project_id' }, pick: (j) => (j.results ?? j).slice(0, 50).map((t) => ({ id: t.id, content: t.content, due: t.due?.string ?? t.due?.date, priority: t.priority, project: t.project_id })) },
      { name: 'task_create', desc: 'Cria uma tarefa (data em linguagem natural: "amanhã 9h").', risk: 'write', method: 'POST', path: '/tasks', params: { content: 'texto da tarefa', due_string: 'quando (opcional)', project_id: 'projeto (opcional)', priority: '1-4 (4 = urgente)' }, req: ['content'], body: { content: 'content', due_string: 'due_string', project_id: 'project_id', priority: 'priority' }, json: ['priority'], pick: (t) => ({ id: t.id, content: t.content, due: t.due?.string }) },
      { name: 'task_close', desc: 'Conclui uma tarefa.', risk: 'write', method: 'POST', path: '/tasks/{task_id}/close', params: { task_id: 'id da tarefa' }, req: ['task_id'] },
    ],
  },
  {
    id: 'trello', label: 'Trello', category: 'Produtividade', desc: 'Quadros, listas e cartões.',
    help: 'trello.com/power-ups/admin: chave da API e, pelo link da página, um token', base: 'https://api.trello.com/1', hosts: ['api.trello.com'],
    fields: [{ name: 'key', label: 'Chave da API', secret: true, required: true }, { name: 'token', label: 'Token', secret: true, required: true }], auth: { type: 'query', params: { key: 'key', token: 'token' } }, test: 'boards',
    tools: [
      { name: 'boards', desc: 'Meus quadros.', risk: 'read', method: 'GET', path: '/members/me/boards', fixedQuery: { fields: 'name,url,closed' }, pick: (j) => j.filter((b) => !b.closed).map((b) => ({ id: b.id, name: b.name, url: b.url })) },
      { name: 'lists', desc: 'Listas de um quadro.', risk: 'read', method: 'GET', path: '/boards/{board_id}/lists', params: { board_id: 'id do quadro' }, req: ['board_id'], pick: (j) => j.map((l) => ({ id: l.id, name: l.name })) },
      { name: 'cards', desc: 'Cartões de uma lista.', risk: 'read', method: 'GET', path: '/lists/{list_id}/cards', params: { list_id: 'id da lista' }, req: ['list_id'], fixedQuery: { fields: 'name,desc,due,url' }, pick: (j) => j.map((c) => ({ id: c.id, name: c.name, due: c.due, url: c.url, desc: clip(c.desc, 200) })) },
      { name: 'card_create', desc: 'Cria um cartão em uma lista.', risk: 'write', method: 'POST', path: '/cards', params: { list_id: 'id da lista', name: 'título', desc: 'descrição (opcional)' }, req: ['list_id', 'name'], query: { list_id: 'idList', name: 'name', desc: 'desc' }, pick: (c) => ({ id: c.id, url: c.url }) },
      { name: 'card_move', desc: 'Move um cartão para outra lista.', risk: 'write', method: 'PUT', path: '/cards/{card_id}', params: { card_id: 'id do cartão', list_id: 'lista de destino' }, req: ['card_id', 'list_id'], query: { list_id: 'idList' }, pick: (c) => ({ id: c.id, list: c.idList }) },
      { name: 'card_comment', desc: 'Comenta em um cartão.', risk: 'write', method: 'POST', path: '/cards/{card_id}/actions/comments', params: { card_id: 'id do cartão', text: 'comentário' }, req: ['card_id', 'text'], query: { text: 'text' } },
    ],
  },
  {
    id: 'asana', label: 'Asana', category: 'Produtividade', desc: 'Projetos e tarefas.',
    help: 'app.asana.com/0/my-apps (token de acesso pessoal)', base: 'https://app.asana.com/api/1.0', hosts: ['app.asana.com'],
    fields: [token('Token de acesso pessoal', 'cole o token')], auth: { type: 'bearer', field: 'token' }, test: 'me',
    tools: [
      { name: 'me', desc: 'Minha conta e áreas de trabalho.', risk: 'read', method: 'GET', path: '/users/me', pick: (j) => ({ name: j.data?.name, email: j.data?.email, workspaces: j.data?.workspaces?.map((w) => ({ gid: w.gid, name: w.name })) }) },
      { name: 'projects', desc: 'Projetos de uma área de trabalho.', risk: 'read', method: 'GET', path: '/projects', params: { workspace: 'gid da área de trabalho' }, req: ['workspace'], query: { workspace: 'workspace' }, fixedQuery: { archived: 'false' }, pick: (j) => j.data.map((x) => ({ gid: x.gid, name: x.name })) },
      { name: 'tasks', desc: 'Tarefas de um projeto, ou minhas (informe workspace).', risk: 'read', method: 'GET', path: '/tasks', params: { project: 'gid do projeto', workspace: 'gid da área (para as minhas)' }, query: { project: 'project', workspace: 'workspace' }, fixedQuery: { opt_fields: 'name,completed,due_on,permalink_url', limit: '50' }, pick: (j) => j.data.map((t) => ({ gid: t.gid, name: t.name, done: t.completed, due: t.due_on, url: t.permalink_url })) },
      { name: 'task_create', desc: 'Cria uma tarefa.', risk: 'write', method: 'POST', path: '/tasks', params: { name: 'título', notes: 'descrição (opcional)', project: 'gid do projeto', workspace: 'gid da área (se não houver projeto)' }, req: ['name'], bodyFn: (a) => ({ data: { name: a.name, ...(a.notes ? { notes: a.notes } : {}), ...(a.project ? { projects: [a.project] } : {}), ...(a.workspace ? { workspace: a.workspace } : {}) } }), pick: (j) => ({ gid: j.data.gid, url: j.data.permalink_url }) },
      { name: 'task_complete', desc: 'Conclui uma tarefa.', risk: 'write', method: 'PUT', path: '/tasks/{task_gid}', params: { task_gid: 'gid da tarefa' }, req: ['task_gid'], fixedBody: { data: { completed: true } }, pick: (j) => ({ gid: j.data.gid, done: j.data.completed }) },
    ],
  },
  {
    id: 'linear', label: 'Linear', category: 'Produtividade', desc: 'Issues e times (GraphQL).',
    help: 'linear.app › Settings › API › Personal API keys', base: 'https://api.linear.app', hosts: ['api.linear.app'],
    fields: [token('Chave de API pessoal', 'lin_api_…')], auth: { type: 'header', name: 'Authorization', field: 'token', prefix: '' }, test: 'me',
    failIf: (j) => (j?.errors?.length ? j.errors.map((e) => e.message).join('; ') : null),
    tools: [
      { name: 'me', desc: 'Quem sou eu no Linear.', risk: 'read', method: 'POST', path: '/graphql', graphql: { query: '{ viewer { id name email } }' }, pick: (j) => j.data.viewer },
      { name: 'teams', desc: 'Times.', risk: 'read', method: 'POST', path: '/graphql', graphql: { query: '{ teams { nodes { id key name } } }' }, pick: (j) => j.data.teams.nodes },
      { name: 'issues', desc: 'Issues mais recentes.', risk: 'read', method: 'POST', path: '/graphql', params: { limit: 'quantas' }, graphql: { query: 'query($first:Int){ issues(first:$first, orderBy: updatedAt){ nodes { identifier title url priority state { name } assignee { name } } } }', ints: { limit: 'first' } }, defaults: { limit: 20 }, max: { limit: 50 }, pick: (j) => j.data.issues.nodes.map((i) => ({ id: i.identifier, title: i.title, state: i.state?.name, assignee: i.assignee?.name, url: i.url })) },
      { name: 'issue_create', desc: 'Cria uma issue em um time.', risk: 'write', method: 'POST', path: '/graphql', params: { teamId: 'id do time (veja teams)', title: 'título', description: 'texto (opcional)' }, req: ['teamId', 'title'], graphql: { query: 'mutation($teamId:String!,$title:String!,$description:String){ issueCreate(input:{teamId:$teamId,title:$title,description:$description}){ success issue { identifier url } } }', vars: ['teamId', 'title', 'description'] }, pick: (j) => j.data.issueCreate },
      { name: 'issue_comment', desc: 'Comenta em uma issue.', risk: 'write', method: 'POST', path: '/graphql', params: { issueId: 'id da issue', body: 'comentário' }, req: ['issueId', 'body'], graphql: { query: 'mutation($issueId:String!,$body:String!){ commentCreate(input:{issueId:$issueId, body:$body}){ success } }', vars: ['issueId', 'body'] }, pick: (j) => j.data.commentCreate },
    ],
  },
  {
    id: 'clickup', label: 'ClickUp', category: 'Produtividade', desc: 'Espaços, listas e tarefas.',
    help: 'ClickUp › Configurações › Apps › Token de API pessoal', base: 'https://api.clickup.com/api/v2', hosts: ['api.clickup.com'],
    fields: [token('Token de API pessoal', 'pk_…')], auth: { type: 'header', name: 'Authorization', field: 'token', prefix: '' }, test: 'teams',
    tools: [
      { name: 'teams', desc: 'Áreas de trabalho.', risk: 'read', method: 'GET', path: '/team', pick: (j) => j.teams.map((t) => ({ id: t.id, name: t.name })) },
      { name: 'spaces', desc: 'Espaços de uma área de trabalho.', risk: 'read', method: 'GET', path: '/team/{team_id}/space', params: { team_id: 'id da área' }, req: ['team_id'], pick: (j) => j.spaces.map((s) => ({ id: s.id, name: s.name })) },
      { name: 'lists', desc: 'Listas de um espaço (sem pasta).', risk: 'read', method: 'GET', path: '/space/{space_id}/list', params: { space_id: 'id do espaço' }, req: ['space_id'], pick: (j) => j.lists.map((l) => ({ id: l.id, name: l.name })) },
      { name: 'tasks', desc: 'Tarefas de uma lista.', risk: 'read', method: 'GET', path: '/list/{list_id}/task', params: { list_id: 'id da lista' }, req: ['list_id'], pick: (j) => j.tasks.map((t) => ({ id: t.id, name: t.name, status: t.status?.status, url: t.url })) },
      { name: 'task_create', desc: 'Cria uma tarefa em uma lista.', risk: 'write', method: 'POST', path: '/list/{list_id}/task', params: { list_id: 'id da lista', name: 'título', description: 'texto (opcional)' }, req: ['list_id', 'name'], body: { name: 'name', description: 'description' }, pick: (t) => ({ id: t.id, url: t.url }) },
      { name: 'task_status', desc: 'Muda o status de uma tarefa.', risk: 'write', method: 'PUT', path: '/task/{task_id}', params: { task_id: 'id da tarefa', status: 'novo status (nome exato)' }, req: ['task_id', 'status'], body: { status: 'status' }, pick: (t) => ({ id: t.id, status: t.status?.status }) },
    ],
  },
  {
    id: 'airtable', label: 'Airtable', category: 'Dados', desc: 'Bases, tabelas e registros.',
    help: 'airtable.com/create/tokens (escopos data.records:read/write e schema.bases:read)', base: 'https://api.airtable.com/v0', hosts: ['api.airtable.com'],
    fields: [token('Token de acesso pessoal', 'pat…')], auth: { type: 'bearer', field: 'token' }, test: 'bases',
    tools: [
      { name: 'bases', desc: 'Bases que o token enxerga.', risk: 'read', method: 'GET', path: '/meta/bases', pick: (j) => j.bases.map((b) => ({ id: b.id, name: b.name })) },
      { name: 'tables', desc: 'Tabelas e campos de uma base.', risk: 'read', method: 'GET', path: '/meta/bases/{base_id}/tables', params: { base_id: 'id da base (app…)' }, req: ['base_id'], pick: (j) => j.tables.map((t) => ({ id: t.id, name: t.name, fields: t.fields.map((f) => f.name) })) },
      { name: 'records', desc: 'Registros de uma tabela.', risk: 'read', method: 'GET', path: '/{base_id}/{table}', params: { base_id: 'id da base', table: 'nome ou id da tabela', limit: 'quantos', formula: 'filterByFormula (opcional)' }, req: ['base_id', 'table'], query: { limit: 'maxRecords', formula: 'filterByFormula' }, defaults: { limit: 20 }, max: { limit: 100 }, pick: (j) => j.records.map((r) => ({ id: r.id, ...r.fields })) },
      { name: 'record_create', desc: 'Cria um registro (fields = objeto JSON).', risk: 'write', method: 'POST', path: '/{base_id}/{table}', params: { base_id: 'id da base', table: 'tabela', fields: 'objeto JSON campo→valor' }, req: ['base_id', 'table', 'fields'], body: { fields: 'fields' }, json: ['fields'], pick: (r) => ({ id: r.id }) },
      { name: 'record_update', desc: 'Altera campos de um registro.', risk: 'write', method: 'PATCH', path: '/{base_id}/{table}/{record_id}', params: { base_id: 'id da base', table: 'tabela', record_id: 'id do registro', fields: 'objeto JSON campo→valor' }, req: ['base_id', 'table', 'record_id', 'fields'], body: { fields: 'fields' }, json: ['fields'], pick: (r) => ({ id: r.id }) },
    ],
  },
  {
    id: 'jira', label: 'Jira Cloud', category: 'Produtividade', desc: 'Buscar, ler, criar e comentar issues.',
    help: 'id.atlassian.com/manage-profile/security/api-tokens', base: 'https://{site}.atlassian.net/rest/api/3', hosts: ['.atlassian.net'],
    fields: [{ name: 'site', label: 'Site (a parte antes de .atlassian.net)', kind: 'slug', required: true }, { name: 'email', label: 'E-mail da conta', kind: 'text', required: true }, token('Token de API', 'cole o token')],
    auth: { type: 'basic', user: 'email', pass: 'token' }, test: 'me',
    tools: [
      { name: 'me', desc: 'Minha conta Jira.', risk: 'read', method: 'GET', path: '/myself', pick: (j) => ({ name: j.displayName, email: j.emailAddress }) },
      { name: 'search', desc: 'Busca issues com JQL (ex.: "assignee = currentUser() AND resolution = Unresolved").', risk: 'read', method: 'GET', path: '/search/jql', params: { jql: 'consulta JQL', limit: 'quantas' }, req: ['jql'], query: { jql: 'jql', limit: 'maxResults' }, fixedQuery: { fields: 'summary,status,assignee,issuetype' }, defaults: { limit: 20 }, max: { limit: 50 }, pick: (j) => (j.issues ?? []).map((i) => ({ key: i.key, summary: i.fields?.summary, status: i.fields?.status?.name, assignee: i.fields?.assignee?.displayName })) },
      { name: 'issue_get', desc: 'Uma issue.', risk: 'read', method: 'GET', path: '/issue/{key}', params: { key: 'chave, ex.: ABC-12' }, req: ['key'], fixedQuery: { fields: 'summary,status,assignee,description,comment' }, pick: (i) => ({ key: i.key, summary: i.fields?.summary, status: i.fields?.status?.name, comments: i.fields?.comment?.total }) },
      { name: 'issue_create', desc: 'Cria uma issue.', risk: 'write', method: 'POST', path: '/issue', params: { project: 'chave do projeto', summary: 'título', description: 'texto (opcional)', type: 'tipo (padrão Task)' }, req: ['project', 'summary'], bodyFn: (a) => ({ fields: { project: { key: a.project }, summary: a.summary, issuetype: { name: a.type || 'Task' }, ...(a.description ? { description: adf(a.description) } : {}) } }), pick: (j) => ({ key: j.key }) },
      { name: 'comment', desc: 'Comenta em uma issue.', risk: 'write', method: 'POST', path: '/issue/{key}/comment', params: { key: 'chave da issue', text: 'comentário' }, req: ['key', 'text'], bodyFn: (a) => ({ body: adf(a.text) }), pick: (j) => ({ id: j.id }) },
    ],
  },

  // ---------------------------------------------------------------------------------------------------- mensagens
  {
    id: 'slack', label: 'Slack', category: 'Mensagens', desc: 'Ler canais e enviar mensagens (app com token de bot).',
    help: 'api.slack.com/apps › OAuth & Permissions › Bot User OAuth Token (channels:read, channels:history, chat:write)', base: 'https://slack.com/api', hosts: ['slack.com'],
    fields: [token('Token do bot', 'xoxb-…')], auth: { type: 'bearer', field: 'token' }, test: 'auth_test',
    failIf: (j) => (j?.ok === false ? String(j.error ?? 'erro') : null),
    tools: [
      { name: 'auth_test', desc: 'Confere o token e mostra o workspace.', risk: 'read', method: 'GET', path: '/auth.test', pick: (j) => ({ team: j.team, user: j.user, url: j.url }) },
      { name: 'channels', desc: 'Canais (públicos e privados em que o bot está).', risk: 'read', method: 'GET', path: '/conversations.list', params: { limit: 'quantos' }, query: { limit: 'limit' }, fixedQuery: { types: 'public_channel,private_channel', exclude_archived: 'true' }, defaults: { limit: 100 }, max: { limit: 200 }, pick: (j) => j.channels.map((c) => ({ id: c.id, name: c.name, private: c.is_private, members: c.num_members })) },
      { name: 'history', desc: 'Últimas mensagens de um canal.', risk: 'read', method: 'GET', path: '/conversations.history', params: { channel: 'id do canal', limit: 'quantas' }, req: ['channel'], query: { channel: 'channel', limit: 'limit' }, defaults: { limit: 20 }, max: { limit: 100 }, pick: (j) => j.messages.map((m) => ({ user: m.user, text: clip(m.text, 400), ts: m.ts })) },
      { name: 'post', desc: 'Envia uma mensagem a um canal.', risk: 'write', method: 'POST', path: '/chat.postMessage', params: { channel: 'id do canal', text: 'mensagem' }, req: ['channel', 'text'], body: { channel: 'channel', text: 'text' }, pick: (j) => ({ channel: j.channel, ts: j.ts }) },
    ],
  },
  {
    id: 'discord', label: 'Discord (bot)', category: 'Mensagens', desc: 'Servidores, canais e mensagens de um bot seu.',
    help: 'discord.com/developers/applications › Bot › Token (convide o bot ao servidor)', base: 'https://discord.com/api/v10', hosts: ['discord.com'], headers: { 'User-Agent': 'DiscordBot (https://jarvis.local, 1.0)' },
    fields: [token('Token do bot', 'cole o token')], auth: { type: 'header', name: 'Authorization', field: 'token', prefix: 'Bot ' }, test: 'me',
    tools: [
      { name: 'me', desc: 'Dados do bot.', risk: 'read', method: 'GET', path: '/users/@me', pick: (j) => ({ id: j.id, username: j.username }) },
      { name: 'guilds', desc: 'Servidores em que o bot está.', risk: 'read', method: 'GET', path: '/users/@me/guilds', pick: (j) => j.map((g) => ({ id: g.id, name: g.name })) },
      { name: 'channels', desc: 'Canais de um servidor.', risk: 'read', method: 'GET', path: '/guilds/{guild_id}/channels', params: { guild_id: 'id do servidor' }, req: ['guild_id'], pick: (j) => j.map((c) => ({ id: c.id, name: c.name, type: c.type })) },
      { name: 'messages', desc: 'Últimas mensagens de um canal.', risk: 'read', method: 'GET', path: '/channels/{channel_id}/messages', params: { channel_id: 'id do canal', limit: 'quantas' }, req: ['channel_id'], query: { limit: 'limit' }, defaults: { limit: 20 }, max: { limit: 100 }, pick: (j) => j.map((m) => ({ id: m.id, author: m.author?.username, text: clip(m.content, 400), at: m.timestamp })) },
      { name: 'send', desc: 'Envia uma mensagem a um canal.', risk: 'write', method: 'POST', path: '/channels/{channel_id}/messages', params: { channel_id: 'id do canal', content: 'mensagem' }, req: ['channel_id', 'content'], body: { content: 'content' }, pick: (m) => ({ id: m.id }) },
    ],
  },
  {
    id: 'discord-webhook', label: 'Discord (webhook)', category: 'Mensagens', desc: 'Só enviar mensagens a um canal, sem bot.',
    help: 'Canal › Editar › Integrações › Webhooks › Copiar URL', base: '{url}', hosts: ['discord.com', 'discordapp.com'], baseCheck: /^https:\/\/(discord|discordapp)\.com\/api\/webhooks\/\d+\/[\w-]+$/,
    fields: [{ name: 'url', label: 'URL do webhook', secret: true, required: true, placeholder: 'https://discord.com/api/webhooks/…' }], auth: { type: 'none' }, test: null,
    tools: [{ name: 'send', desc: 'Envia uma mensagem ao canal do webhook.', risk: 'write', method: 'POST', path: '', params: { content: 'mensagem', username: 'nome exibido (opcional)' }, req: ['content'], body: { content: 'content', username: 'username' }, fixedQuery: { wait: 'true' }, pick: (m) => ({ id: m.id }) }],
  },
  {
    id: 'telegram', label: 'Telegram (bot)', category: 'Mensagens', desc: 'Receber e enviar mensagens por um bot seu.',
    help: 'Converse com @BotFather, crie um bot e copie o token', base: 'https://api.telegram.org/bot{token}', hosts: ['api.telegram.org'],
    fields: [token('Token do bot', '123456:ABC…')], auth: { type: 'none' }, test: 'me',
    failIf: (j) => (j?.ok === false ? String(j.description ?? 'erro') : null),
    tools: [
      { name: 'me', desc: 'Dados do bot.', risk: 'read', method: 'GET', path: '/getMe', pick: (j) => ({ username: j.result?.username, name: j.result?.first_name }) },
      { name: 'updates', desc: 'Mensagens recebidas pelo bot (e os chat_id).', risk: 'read', method: 'GET', path: '/getUpdates', params: { limit: 'quantas' }, query: { limit: 'limit' }, defaults: { limit: 20 }, max: { limit: 100 }, pick: (j) => j.result.map((u) => ({ id: u.update_id, chat: u.message?.chat?.id, from: u.message?.from?.username, text: clip(u.message?.text, 300) })) },
      { name: 'send', desc: 'Envia uma mensagem a um chat.', risk: 'write', method: 'POST', path: '/sendMessage', params: { chat_id: 'id do chat', text: 'mensagem' }, req: ['chat_id', 'text'], body: { chat_id: 'chat_id', text: 'text' }, pick: (j) => ({ message_id: j.result?.message_id }) },
    ],
  },
  {
    id: 'ntfy', label: 'ntfy (notificações no celular)', category: 'Mensagens', desc: 'Manda uma notificação push para o seu celular.',
    help: 'ntfy.sh: escolha um tópico difícil de adivinhar e assine no app ntfy', base: '{server}', allowPrivate: true,
    fields: [{ name: 'server', label: 'Servidor', kind: 'url', default: 'https://ntfy.sh' }, { name: 'topic', label: 'Tópico', kind: 'slug', required: true }, { name: 'token', label: 'Token (só se o tópico for protegido)', secret: true }],
    auth: { type: 'bearer', field: 'token', optional: true }, test: null,
    tools: [{ name: 'notify', desc: 'Envia uma notificação ao celular.', risk: 'write', method: 'POST', path: '/{topic}', params: { message: 'texto', title: 'título (opcional)', priority: '1 a 5 (opcional)' }, req: ['message'], bodyRaw: 'message', headerArgs: { title: 'Title', priority: 'Priority' }, pick: (j) => ({ id: j.id }) }],
  },
  {
    id: 'resend', label: 'Resend (e-mail)', category: 'Mensagens', desc: 'Envia e-mails (conta Resend).',
    help: 'resend.com/api-keys', base: 'https://api.resend.com', hosts: ['api.resend.com'],
    fields: [token('Chave da API', 're_…'), { name: 'from', label: 'Remetente', kind: 'text', required: true, default: 'onboarding@resend.dev', placeholder: 'Nome <voce@seudominio.com>' }], auth: { type: 'bearer', field: 'token' }, test: 'domains',
    tools: [
      { name: 'domains', desc: 'Domínios cadastrados (confere a chave).', risk: 'read', method: 'GET', path: '/domains', pick: (j) => (j.data ?? []).map((d) => ({ name: d.name, status: d.status })) },
      { name: 'send', desc: 'Envia um e-mail (não dá para desfazer).', risk: 'danger', method: 'POST', path: '/emails', params: { to: 'destinatário', subject: 'assunto', text: 'corpo em texto' }, req: ['to', 'subject', 'text'], bodyFn: (a, f) => ({ from: f.from, to: a.to, subject: a.subject, text: a.text }), pick: (j) => ({ id: j.id }) },
    ],
  },

  // ---------------------------------------------------------------------------------------------------- casa e IA
  {
    id: 'home-assistant', label: 'Home Assistant', category: 'Casa', desc: 'Ver o estado dos dispositivos e acionar serviços (luzes, tomadas, cenas).',
    help: 'Perfil › Segurança › Tokens de acesso de longa duração; o endereço é o do seu servidor, ex.: http://homeassistant.local:8123', base: '{url}', allowPrivate: true,
    fields: [{ name: 'url', label: 'Endereço do Home Assistant', kind: 'url', required: true, placeholder: 'http://homeassistant.local:8123' }, token('Token de longa duração', 'cole o token')], auth: { type: 'bearer', field: 'token' }, test: 'ping',
    tools: [
      { name: 'ping', desc: 'Confere a conexão.', risk: 'read', method: 'GET', path: '/api/', pick: (j) => ({ message: j.message }) },
      { name: 'states', desc: 'Estado das entidades (filtre por domínio: light, switch, sensor, climate…).', risk: 'read', method: 'GET', path: '/api/states', params: { domain: 'domínio (opcional)' }, pick: (j, a) => j.filter((e) => !a.domain || e.entity_id.startsWith(`${a.domain}.`)).slice(0, 100).map((e) => ({ id: e.entity_id, state: e.state, name: e.attributes?.friendly_name })) },
      { name: 'state_get', desc: 'Estado e atributos de uma entidade.', risk: 'read', method: 'GET', path: '/api/states/{entity_id}', params: { entity_id: 'ex.: light.sala' }, req: ['entity_id'], pick: (e) => ({ id: e.entity_id, state: e.state, attributes: e.attributes, changed: e.last_changed }) },
      { name: 'services', desc: 'Serviços disponíveis (domínio e nomes).', risk: 'read', method: 'GET', path: '/api/services', pick: (j) => j.map((d) => ({ domain: d.domain, services: Object.keys(d.services) })) },
      { name: 'call_service', desc: 'Aciona um serviço, ex.: domain=light service=turn_on entity_id=light.sala.', risk: 'write', method: 'POST', path: '/api/services/{domain}/{service}', params: { domain: 'domínio', service: 'serviço', entity_id: 'entidade (opcional)', data: 'JSON com parâmetros extras (opcional)' }, req: ['domain', 'service'], json: ['data'], bodyFn: (a) => ({ ...(a.data && typeof a.data === 'object' ? a.data : {}), ...(a.entity_id ? { entity_id: a.entity_id } : {}) }), pick: (j) => ({ changed: Array.isArray(j) ? j.map((e) => ({ id: e.entity_id, state: e.state })) : j }) },
    ],
  },
  {
    id: 'huggingface', label: 'Hugging Face', category: 'IA e dados', desc: 'Buscar modelos e datasets.',
    help: 'huggingface.co/settings/tokens (token de leitura)', base: 'https://huggingface.co', hosts: ['huggingface.co'],
    fields: [token('Token de acesso', 'hf_…')], auth: { type: 'bearer', field: 'token' }, test: 'whoami',
    tools: [
      { name: 'whoami', desc: 'Minha conta.', risk: 'read', method: 'GET', path: '/api/whoami-v2', pick: (j) => ({ name: j.name, type: j.type }) },
      { name: 'models', desc: 'Busca modelos (os mais baixados primeiro).', risk: 'read', method: 'GET', path: '/api/models', params: { search: 'texto', limit: 'quantos' }, query: { search: 'search', limit: 'limit' }, fixedQuery: { sort: 'downloads', direction: '-1' }, defaults: { limit: 10 }, max: { limit: 50 }, pick: (j) => j.map((m) => ({ id: m.id, task: m.pipeline_tag, downloads: m.downloads, likes: m.likes })) },
      { name: 'datasets', desc: 'Busca datasets.', risk: 'read', method: 'GET', path: '/api/datasets', params: { search: 'texto', limit: 'quantos' }, query: { search: 'search', limit: 'limit' }, fixedQuery: { sort: 'downloads', direction: '-1' }, defaults: { limit: 10 }, max: { limit: 50 }, pick: (j) => j.map((m) => ({ id: m.id, downloads: m.downloads, likes: m.likes })) },
    ],
  },

  // ---------------------------------------------------------------------------------------------------- consulta aberta (sem conta nem chave)
  {
    id: 'wikipedia', label: 'Wikipedia', category: 'Consulta aberta', desc: 'Buscar e ler resumos (sem chave).',
    help: 'sem cadastro', base: 'https://{lang}.wikipedia.org', hosts: ['.wikipedia.org'], fields: [{ name: 'lang', label: 'Idioma', kind: 'slug', default: 'pt', required: true }], auth: { type: 'none' }, test: 'search', testArgs: { q: 'Brasil', limit: '1' },
    tools: [
      { name: 'search', desc: 'Busca artigos.', risk: 'read', method: 'GET', path: '/w/api.php', params: { q: 'consulta', limit: 'quantos' }, req: ['q'], query: { q: 'srsearch', limit: 'srlimit' }, fixedQuery: { action: 'query', list: 'search', format: 'json', utf8: '1' }, defaults: { limit: 5 }, max: { limit: 20 }, pick: (j) => j.query.search.map((s) => ({ title: s.title, snippet: plain(s.snippet) })) },
      { name: 'summary', desc: 'Resumo de um artigo pelo título exato.', risk: 'read', method: 'GET', path: '/api/rest_v1/page/summary/{title}', params: { title: 'título do artigo' }, req: ['title'], pick: (j) => ({ title: j.title, description: j.description, extract: clip(j.extract, 1500), url: j.content_urls?.desktop?.page }) },
    ],
  },
  {
    id: 'open-meteo', label: 'Open-Meteo (clima)', category: 'Consulta aberta', desc: 'Previsão do tempo e busca de coordenadas de cidades (sem chave).',
    help: 'sem cadastro', base: 'https://api.open-meteo.com', hosts: ['api.open-meteo.com', 'geocoding-api.open-meteo.com'], fields: [], auth: { type: 'none' }, test: 'geocode', testArgs: { name: 'São Paulo', limit: '1' },
    tools: [
      { name: 'geocode', desc: 'Acha latitude/longitude de uma cidade.', risk: 'read', base: 'https://geocoding-api.open-meteo.com', method: 'GET', path: '/v1/search', params: { name: 'cidade', limit: 'quantos' }, req: ['name'], query: { name: 'name', limit: 'count' }, fixedQuery: { language: 'pt', format: 'json' }, defaults: { limit: 3 }, max: { limit: 10 }, pick: (j) => (j.results ?? []).map((r) => ({ name: r.name, region: r.admin1, country: r.country, latitude: r.latitude, longitude: r.longitude })) },
      { name: 'forecast', desc: 'Tempo agora e previsão diária para uma coordenada.', risk: 'read', method: 'GET', path: '/v1/forecast', params: { latitude: 'latitude', longitude: 'longitude', days: 'dias de previsão (padrão 3)' }, req: ['latitude', 'longitude'], query: { latitude: 'latitude', longitude: 'longitude', days: 'forecast_days' }, fixedQuery: { current: 'temperature_2m,relative_humidity_2m,apparent_temperature,precipitation,weather_code,wind_speed_10m', daily: 'weather_code,temperature_2m_max,temperature_2m_min,precipitation_sum', timezone: 'auto' }, defaults: { days: 3 }, max: { days: 16 }, pick: (j) => ({ now: j.current, units: j.current_units, daily: j.daily }) },
    ],
  },
  {
    id: 'hackernews', label: 'Hacker News', category: 'Consulta aberta', desc: 'Principais histórias (sem chave).',
    help: 'sem cadastro', base: 'https://hacker-news.firebaseio.com/v0', hosts: ['hacker-news.firebaseio.com'], fields: [], auth: { type: 'none' }, test: 'top', testArgs: { limit: '1' },
    tools: [
      { name: 'top', desc: 'As histórias mais votadas agora.', risk: 'read', params: { limit: 'quantas (padrão 10)' }, defaults: { limit: 10 }, max: { limit: 20 }, custom: async ({ get, args }) => { const ids = (await get('/topstories.json')).slice(0, args.limit); const items = await Promise.all(ids.map((id) => get(`/item/${id}.json`))); return items.map((i) => ({ id: i.id, title: i.title, url: i.url, score: i.score, by: i.by, comments: i.descendants })) } },
      { name: 'item', desc: 'Uma história ou comentário.', risk: 'read', method: 'GET', path: '/item/{id}.json', params: { id: 'id' }, req: ['id'], pick: (i) => ({ id: i.id, type: i.type, title: i.title, text: clip(plain(i.text), 1500), url: i.url, score: i.score, by: i.by }) },
    ],
  },
  {
    id: 'cambio', label: 'Câmbio (open.er-api.com)', category: 'Consulta aberta', desc: 'Cotações de moedas do dia (sem chave).',
    help: 'sem cadastro; dados de referência, não servem para operar', base: 'https://open.er-api.com/v6', hosts: ['open.er-api.com'], fields: [], auth: { type: 'none' }, test: 'taxa', testArgs: { de: 'USD', para: 'BRL' },
    tools: [
      { name: 'taxa', desc: 'Cotação de uma moeda em outras (ex.: de=USD para=BRL,EUR) e, se informar valor, a conversão.', risk: 'read', method: 'GET', path: '/latest/{de}', params: { de: 'moeda de origem, ex.: USD', para: 'moedas de destino separadas por vírgula', valor: 'quantia a converter (opcional)' }, req: ['de'], pick: (j, a) => { const want = String(a.para ?? '').toUpperCase().split(/[,\s]+/).filter(Boolean); const rates = Object.fromEntries(Object.entries(j.rates ?? {}).filter(([k]) => !want.length || want.includes(k)).slice(0, 30)); const v = Number(a.valor); return { base: j.base_code, updated: j.time_last_update_utc, rates, ...(Number.isFinite(v) && a.valor !== undefined ? { converted: Object.fromEntries(Object.entries(rates).map(([k, r]) => [k, Math.round(v * r * 100) / 100])) } : {}) } } },
    ],
  },

  // ---------------------------------------------------------------------------------------------------- Google (login pelo navegador, OAuth: google.mjs)
  ...googleConnectors(),

  // ---------------------------------------------------------------------------------------------------- genérico
  {
    id: 'rest', label: 'API REST personalizada', category: 'Genérico', desc: 'Qualquer serviço com API HTTP/JSON: o endereço e a chave são seus.',
    help: 'Informe o endereço base e como a chave é enviada (padrão: cabeçalho Authorization: Bearer …)', base: '{url}', allowPrivate: true,
    fields: [{ name: 'url', label: 'Endereço base', kind: 'url', required: true, placeholder: 'https://api.exemplo.com/v1' }, { name: 'token', label: 'Chave/token (opcional)', secret: true }, { name: 'header', label: 'Cabeçalho da chave', kind: 'text', default: 'Authorization' }, { name: 'prefix', label: 'Prefixo da chave', kind: 'text', default: 'Bearer ' }],
    auth: { type: 'header', nameField: 'header', field: 'token', prefixField: 'prefix', optional: true }, test: null,
    tools: [
      { name: 'get', desc: 'GET em um caminho da API.', risk: 'read', method: 'GET', path: '{+path}', params: { path: 'caminho começando com /', query: 'a=1&b=2 (opcional)' }, req: ['path'], rawQuery: 'query', raw: true },
      { name: 'send', desc: 'POST/PUT/PATCH/DELETE em um caminho da API (pode alterar ou apagar dados).', risk: 'danger', methodArg: 'method', methods: ['POST', 'PUT', 'PATCH', 'DELETE'], path: '{+path}', params: { method: 'POST|PUT|PATCH|DELETE', path: 'caminho começando com /', query: 'a=1&b=2 (opcional)', body: 'JSON do corpo (opcional)' }, req: ['method', 'path'], rawQuery: 'query', json: ['body'], bodyFn: (a) => a.body, raw: true },
    ],
  },
]
