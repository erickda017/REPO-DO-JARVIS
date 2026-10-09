import { defineConfig } from 'vite'
import react from '@vitejs/plugin-react'

// The desktop app's renderer. Separate from the original HUD (vite.config.ts) so
// neither can break the other. Port 5174 is inside the range the bridge allows.
export default defineConfig({
  root: 'app/renderer',
  base: './',
  plugins: [react()],
  build: { outDir: '../../dist-app', emptyOutDir: true, chunkSizeWarningLimit: 1600 },
  server: { host: '127.0.0.1', port: 5174, strictPort: true },
})
