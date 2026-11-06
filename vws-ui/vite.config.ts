import { defineConfig } from 'vite'
import react from '@vitejs/plugin-react'
import electron from 'vite-plugin-electron'
import { resolve } from 'path'

// `npm run dev` opens the Electron window (which starts the backend itself);
// `npm run dev:web` (vite --mode web) serves the UI to a browser only.
export default defineConfig(({ mode }) => ({
  // Relative asset paths, so the packaged app can load dist/index.html from disk.
  base: './',
  plugins: [
    react(),
    ...(mode === 'web' ? [] : [electron({ entry: 'electron/main.ts' })]),
  ],
  resolve: {
    alias: {
      '@': resolve(__dirname, './src')
    }
  }
}))
