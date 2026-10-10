import { contextBridge, ipcRenderer } from 'electron'

// The only door between the page and the machine. Every call is a fixed, typed channel; the page
// never gets a path to read, a command to run beyond the three engines, or the raw ipcRenderer.
const on = (channel: string, cb: (...a: any[]) => void) => {
  const h = (_: unknown, ...a: any[]) => cb(...a)
  ipcRenderer.on(channel, h)
  return () => ipcRenderer.removeListener(channel, h)
}

contextBridge.exposeInMainWorld('jarvis', {
  projects: {
    list: () => ipcRenderer.invoke('projects:list'),
    add: () => ipcRenderer.invoke('projects:add'),
    remove: (root: string) => ipcRenderer.invoke('projects:remove', root),
    rescan: (root: string) => ipcRenderer.invoke('projects:rescan', root),
  },
  ia: {
    status: () => ipcRenderer.invoke('ia:status'),
    start: (mode: string) => ipcRenderer.invoke('ia:start', mode),
    stop: () => ipcRenderer.invoke('ia:stop'),
    setRoot: () => ipcRenderer.invoke('ia:setRoot'),
  },
  code: {
    engines: () => ipcRenderer.invoke('code:engines'),
    start: (opts: { engine: string; cwd: string; cols: number; rows: number }) => ipcRenderer.invoke('code:start', opts),
    write: (data: string) => ipcRenderer.send('code:write', data),
    resize: (cols: number, rows: number) => ipcRenderer.send('code:resize', cols, rows),
    stop: () => ipcRenderer.send('code:stop'),
    setAgentPath: () => ipcRenderer.invoke('code:setAgentPath'),
    onData: (cb: (d: string) => void) => on('code:data', cb),
    onExit: (cb: (c: number) => void) => on('code:exit', cb),
    onMetrics: (cb: (m: unknown, ev: unknown[]) => void) => on('code:metrics', cb),
  },
})
