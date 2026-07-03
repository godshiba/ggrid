import { defineConfig } from 'vite'
import react from '@vitejs/plugin-react'
import compression from 'vite-plugin-compression'

// Static build → dist/ (served directly by the deploy platform).
// gzip + brotli are emitted alongside assets so the server can ship the
// smallest payload; fonts are self-hosted woff2 (via @fontsource) and images
// are referenced from /public.
export default defineConfig({
  plugins: [
    react(),
    compression({ algorithm: 'brotliCompress', ext: '.br' }),
    compression({ algorithm: 'gzip', ext: '.gz' }),
  ],
  build: {
    target: 'es2020',
    cssMinify: true,
    assetsInlineLimit: 4096,
  },
  // Dev: proxy the gateway routes to the local Bun server so the dashboard works
  // against a real backend (run `bun --watch src/index.ts` in ../server).
  // In production the same origin serves both, so these paths resolve directly.
  server: {
    proxy: {
      '/api': 'http://localhost:8080',
      '/v1': 'http://localhost:8080',
      '/health': 'http://localhost:8080',
      '/nodes': 'http://localhost:8080',
    },
  },
})
