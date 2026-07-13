import { Hono } from 'hono'
import { cors } from 'hono/cors'
import { logger } from 'hono/logger'
import { bodyLimit } from 'hono/body-limit'
import { v1 } from './routes/v1'
import { api } from './routes/api'
import { nodes } from './routes/nodes'
import { config } from './config'
import { ensureSandboxUser } from './sandbox'
import './db' // initialize schema on import

// Build the gateway app (routes + middleware). Static file serving is wired up
// in index.ts so tests can use this without a built web app present.
export function buildApp(): Hono {
  // Sandbox fund backing the playground + free-request tier (idempotent).
  ensureSandboxUser()

  const app = new Hono()

  if (process.env.LOG !== 'off') app.use('*', logger())

  // Reject oversized request bodies before they are parsed (memory guard). Applies
  // to every JSON API surface; the static site / SPA fallback is unaffected.
  const limit = bodyLimit({
    maxSize: config.security.maxBodyBytes,
    onError: (c) => c.json({ error: { message: 'request body too large' } }, 413),
  })
  app.use('/v1/*', limit)
  app.use('/api/*', limit)
  app.use('/nodes/*', limit)

  app.use('/v1/*', cors({ origin: config.corsOrigin }))
  app.use('/api/*', cors({ origin: config.corsOrigin }))

  app.get('/health', (c) => c.json({ ok: true, service: 'gpugrid-gateway' }))
  app.route('/v1', v1)
  app.route('/api', api)
  app.route('/nodes', nodes)

  app.notFound((c) => c.json({ error: { message: 'not found' } }, 404))
  app.onError((err, c) => {
    console.error('[error]', err)
    return c.json({ error: { message: 'internal error' } }, 500)
  })
  return app
}
