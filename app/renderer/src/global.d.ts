import type { ProjectGraph } from '../../electron/projects.ts'
import type { AgentEvent, Metrics } from '../../electron/transcripts.ts'
import type { IaMode, IaStatus } from '../../electron/ia.ts'

export type Engine = 'claude' | 'agent' | 'shell'
export interface AppSettings { autostart: boolean; closeToTray: boolean; hotkey: string; packaged: boolean; hotkeyActive: string }

declare global {
  interface Window {
    /** Present only inside the Electron app (see electron/preload.ts); absent in a plain browser. */
    jarvis?: {
      token: string
      projects: {
        list: () => Promise<ProjectGraph[]>
        add: () => Promise<ProjectGraph | null>
        remove: (root: string) => Promise<boolean>
        rescan: (root: string) => Promise<ProjectGraph | null>
      }
      access: { pick: () => Promise<string | null> }
      app: {
        getSettings: () => Promise<AppSettings>
        setSettings: (p: Partial<Pick<AppSettings, 'autostart' | 'closeToTray' | 'hotkey'>>) => Promise<AppSettings>
        /** Fired by the global hotkey and the tray menu: start listening now. */
        onListen: (cb: () => void) => () => void
      }
      ia: {
        status: () => Promise<IaStatus>
        start: (mode: IaMode) => Promise<IaStatus>
        stop: () => Promise<IaStatus>
        setRoot: () => Promise<IaStatus>
      }
      code: {
        engines: () => Promise<{ claude: boolean; agent: string | null; shell: boolean }>
        start: (o: { engine: Engine; cwd: string; cols: number; rows: number }) => Promise<{ ok: boolean; error?: string }>
        write: (data: string) => void
        resize: (cols: number, rows: number) => void
        stop: () => void
        setAgentPath: () => Promise<string | null>
        onData: (cb: (d: string) => void) => () => void
        onExit: (cb: (code: number) => void) => () => void
        onMetrics: (cb: (m: Metrics, ev: AgentEvent[]) => void) => () => void
      }
    }
  }
}
