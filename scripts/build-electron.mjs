import { build } from 'esbuild'

// The Electron main process and its preload are TypeScript; bundle each to CommonJS.
// The native terminal package stays external (it ships its own prebuilt binary).
const common = { bundle: true, platform: 'node', format: 'cjs', target: 'node22', external: ['electron', '@lydell/node-pty'] }
await build({ ...common, entryPoints: ['app/electron/main.ts'], outfile: 'dist-electron/main.cjs' })
await build({ ...common, entryPoints: ['app/electron/preload.ts'], outfile: 'dist-electron/preload.cjs' })
console.log('[app] electron main + preload built')
