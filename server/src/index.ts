import { existsSync } from 'node:fs'
import { serveStatic } from 'hono/bun'
import { buildApp } from './app'
import { config, solanaConfigured } from './config'

const app = buildApp()

// In production the same container serves the built React site. Skipped when
// web/dist isn't present (e.g. backend-only dev / tests).
if (existsSync(config.webDir)) {
  // precompressed: serve the .br/.gz built by vite-plugin-compression (the 3D
  // chunk drops from ~815KB to ~176KB on the wire).
  app.use('/*', serveStatic({ root: config.webDir, precompressed: true }))
  app.get('*', serveStatic({ path: 'index.html', root: config.webDir, precompressed: true })) // SPA fallback
  console.log(`[GpuGrid] serving web from ${config.webDir}`)
}

console.log(
  `[GpuGrid] gateway listening on :${config.port} · db=${config.dbPath} · runpod=${config.runpodApiKey ? 'on' : 'off'} · payouts=${solanaConfigured() ? 'on' : 'off'}`,
)

// Bun reads this default export to start the HTTP server.
export default { port: config.port, fetch: app.fetch }
