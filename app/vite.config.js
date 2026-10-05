import { defineConfig } from 'vite'
import react from '@vitejs/plugin-react'

// Builds straight into ../dist, which the Node server serves. Same arrangement as
// Bushido, so `npm run build` is the step that makes a change live in both apps.
export default defineConfig({
  plugins: [react()],
  base: './',
  build: { outDir: '../dist', emptyOutDir: true },
  /*
   * `npm run dev` serves the app on 5173 and proxies everything the Node server
   * owns: the API, the MCP, and the server-rendered sign-in pages. The proxy
   * keeps the browser's Host header (changeOrigin: false), so to the server the
   * request is same-origin and its cross-site check needs no dev exception.
   */
  server: {
    host: true,
    proxy: Object.fromEntries(['/api', '/mcp', '/login', '/setup'].map(p => [
      p, { target: process.env.KRAKATOA_DEV_BACKEND || 'http://localhost:8101', changeOrigin: false },
    ])),
  },
})
