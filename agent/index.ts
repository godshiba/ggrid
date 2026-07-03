#!/usr/bin/env bun
// GpuGrid node agent — connects a provider's local Ollama to the grid.
//
//   bun index.ts --public-url https://xxxx.ngrok.app --provider-token ggrid_pv_...
//
// Flags (or env): --gateway/GGRID_GATEWAY, --public-url/PUBLIC_URL,
// --provider-token/PROVIDER_TOKEN, --ollama/OLLAMA_URL, --interval (seconds).

interface Args {
  gateway: string
  publicUrl: string
  providerToken: string
  ollama: string
  intervalMs: number
}

function parseArgs(): Args {
  const a = process.argv.slice(2)
  const get = (flag: string, env: string, def = ''): string => {
    const i = a.indexOf(flag)
    if (i >= 0 && a[i + 1]) return a[i + 1]
    return process.env[env] ?? def
  }
  return {
    gateway: get('--gateway', 'GGRID_GATEWAY', 'http://localhost:8080').replace(/\/$/, ''),
    publicUrl: get('--public-url', 'PUBLIC_URL', '').replace(/\/$/, ''),
    providerToken: get('--provider-token', 'PROVIDER_TOKEN', ''),
    ollama: get('--ollama', 'OLLAMA_URL', 'http://localhost:11434').replace(/\/$/, ''),
    intervalMs: Number(get('--interval', 'HEARTBEAT_INTERVAL', '15')) * 1000,
  }
}

async function getModels(ollama: string): Promise<string[]> {
  const r = await fetch(ollama + '/api/tags')
  if (!r.ok) throw new Error(`Ollama not reachable at ${ollama} (HTTP ${r.status})`)
  const j = (await r.json()) as { models?: { name: string }[] }
  return (j.models ?? []).map((m) => m.name)
}

async function main(): Promise<void> {
  const args = parseArgs()
  if (!args.publicUrl || !args.providerToken) {
    console.error(
      'Usage: bun index.ts --public-url <https://...ngrok...> --provider-token <ggrid_pv_...> [--gateway URL] [--ollama URL]',
    )
    process.exit(1)
  }

  console.log(`[agent] ollama=${args.ollama} gateway=${args.gateway} public=${args.publicUrl}`)
  const models = await getModels(args.ollama)
  if (!models.length) console.warn('[agent] WARNING: Ollama has no models. Try: ollama pull llama3:8b')
  else console.log(`[agent] models: ${models.join(', ')}`)

  const reg = (await (
    await fetch(args.gateway + '/nodes/register', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ url: args.publicUrl, models, providerToken: args.providerToken }),
    })
  ).json()) as { nodeId?: string; nodeSecret?: string; error?: string }

  if (!reg.nodeId || !reg.nodeSecret) {
    console.error('[agent] register failed:', reg)
    process.exit(1)
  }
  console.log(`[agent] registered as node ${reg.nodeId}`)

  const beat = async (): Promise<void> => {
    try {
      const m = await getModels(args.ollama)
      await fetch(`${args.gateway}/nodes/${reg.nodeId}/heartbeat`, {
        method: 'POST',
        headers: { 'content-type': 'application/json', 'x-node-secret': reg.nodeSecret! },
        body: JSON.stringify({ status: 'ONLINE', models: m }),
      })
    } catch (e) {
      console.error('[agent] heartbeat error:', String(e))
    }
  }

  await beat()
  const timer = setInterval(beat, args.intervalMs)
  console.log(`[agent] heartbeat every ${args.intervalMs / 1000}s. Ctrl+C to stop and deregister.`)

  const shutdown = async (): Promise<void> => {
    clearInterval(timer)
    try {
      await fetch(`${args.gateway}/nodes/${reg.nodeId}`, { method: 'DELETE', headers: { 'x-node-secret': reg.nodeSecret! } })
    } catch {
      /* ignore */
    }
    console.log('\n[agent] deregistered. bye.')
    process.exit(0)
  }
  process.on('SIGINT', shutdown)
  process.on('SIGTERM', shutdown)
}

main().catch((e) => {
  console.error('[agent] fatal:', e)
  process.exit(1)
})
