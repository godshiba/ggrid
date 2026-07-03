import { Hono } from 'hono'
import { cors } from 'hono/cors'
import { logger } from 'hono/logger'
import { v1 } from './routes/v1'
import { api } from './routes/api'
import { nodes } from './routes/nodes'
import { config } from './config'
import './db' // initialize schema on import

// Build the gateway app (routes + middleware). Static file serving is wired up
// in index.ts so tests can use this without a built web app present.
export function buildApp(): Hono {
  const app = new Hono()

  if (process.env.LOG !== 'off') app.use('*', logger())
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
