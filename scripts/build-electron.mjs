import { build } from 'esbuild'

// The Electron main process is one TypeScript file; bundle it to CommonJS.
await build({
  entryPoints: ['app/electron/main.ts'],
  outfile: 'dist-electron/main.cjs',
  bundle: true,
  platform: 'node',
  format: 'cjs',
  target: 'node22',
  external: ['electron'],
})
console.log('[app] electron main built')
