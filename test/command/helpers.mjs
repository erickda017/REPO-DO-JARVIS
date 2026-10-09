/** Fake fetch: routes is a function (url, init) => {status, body} | Error | 'hang'. */
export function fakeFetch(routes) {
  const calls = []
  const fn = async (url, init = {}) => {
    calls.push({ url: String(url), method: init.method ?? 'GET', headers: init.headers ?? {}, body: init.body })
    const r = await routes(String(url), init)
    if (r instanceof Error) throw r
    if (r === 'hang') {
      return new Promise((_, reject) => init.signal?.addEventListener('abort', () => reject(Object.assign(new Error('aborted'), { name: 'AbortError' }))))
    }
    const text = typeof r.body === 'string' ? r.body : JSON.stringify(r.body ?? {})
    return { status: r.status ?? 200, text: async () => text }
  }
  fn.calls = calls
  return fn
}
