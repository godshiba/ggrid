import { existsSync } from 'node:fs'
import { serveStatic } from 'hono/bun'
import { buildApp } from './app'
import { config, solanaConfigured } from './config'
import { startRetention } from './retention'
import { startCanary } from './canary'
import { sweepRateLimit } from './ratelimit'
import { sweepCache } from './cache'
import { sandboxBalance } from './sandbox'

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

// Background workers (all no-ops unless their env knobs are set): purge old usage
// history per the retention window, and run canary probes against nodes.
startRetention()
startCanary()

// Bound rate-limiter + RPC-cache memory: drop expired entries every 5 minutes.
setInterval(() => {
  sweepRateLimit()
  sweepCache()
}, 5 * 60_000)

console.log(
  `[GpuGrid] gateway listening on :${config.port} · db=${config.dbPath} · runpod=${config.runpodApiKey ? 'on' : 'off'} · payouts=${solanaConfigured() ? 'on' : 'off'} · retention=${config.privacy.retentionDays || 'off'} · spotcheck=${config.integrity.spotcheckRate > 0 ? config.integrity.spotcheckRate : 'off'} · canary=${config.integrity.canaryEnabled ? 'on' : 'off'} · playground=${config.playground.enabled ? `on (${config.playground.model}, fund $${(sandboxBalance() / 1_000_000).toFixed(2)})` : 'off'}`,
)

// Bun reads this default export to start the HTTP server.
export default { port: config.port, fetch: app.fetch }
