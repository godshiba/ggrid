import { config } from './config'
import { db, uid, now } from './db'
import { touch, dropNode, getNode } from './registry'
import { sha256, randToken } from './auth'
import type { NodeRow } from './types'

// RunPod fallback: when the grid has no live node for a model, spin a cloud GPU,
// run Ollama on it, register it as a RUNPOD node, and tear it down when idle.
// Disabled cleanly when RUNPOD_API_KEY is absent (returns null → caller 503s).

const SYSTEM_PROVIDER_ID = 'prv_runpod_system'
const RUNPOD_GQL = 'https://api.runpod.io/graphql'

interface RpEntry {
  podId: string
  lastUse: number
  timer: ReturnType<typeof setInterval>
}
const rp = new Map<string, RpEntry>()

function ensureSystemProvider(): void {
  const exists = db.query('SELECT id FROM providers WHERE id = ?').get(SYSTEM_PROVIDER_ID)
  if (!exists) {
    db.query('INSERT INTO providers (id,email,token_hash,balance,created_at) VALUES (?,?,?,?,?)').run(
      SYSTEM_PROVIDER_ID,
      'runpod@system',
      sha256(randToken('sys_')),
      0,
      now(),
    )
  }
}

export function markRunpodUse(nodeId: string): void {
  const e = rp.get(nodeId)
  if (e) e.lastUse = Date.now()
}

export async function ensureNode(model: string): Promise<NodeRow | null> {
  if (!config.runpodApiKey) {
    console.warn('[runpod] disabled - no RUNPOD_API_KEY; cannot fall back')
    return null
  }
  ensureSystemProvider()
  try {
    const podId = await createPod(model)
    const url = await waitReady(podId)
    if (!url) {
      await terminatePod(podId)
      return null
    }
    await pullModel(url, model)
    const id = uid('nod_')
    db.query(
      'INSERT INTO nodes (id,provider_id,url,secret_hash,source,models,gpu_info,reliability,price_factor,created_at) VALUES (?,?,?,?,?,?,?,?,?,?)',
    ).run(
      id,
      SYSTEM_PROVIDER_ID,
      url,
      sha256(randToken('rp_')),
      'RUNPOD',
      JSON.stringify([model]),
      JSON.stringify({ runpodPodId: podId }),
      1.0,
      config.runpodPriceFactor,
      now(),
    )
    registerRunpod(id, podId)
    console.log(`[runpod] node ${id} up for ${model} (pod ${podId})`)
    return getNode(id)
  } catch (e) {
    console.error('[runpod] ensureNode failed:', e)
    return null
  }
}

// RUNPOD nodes don't run our agent, so we keep them "alive" with a keepalive
// tick and reap them once idle past runpodIdleMs.
function registerRunpod(nodeId: string, podId: string): void {
  const entry: RpEntry = {
    podId,
    lastUse: Date.now(),
    timer: setInterval(() => {
      const e = rp.get(nodeId)
      if (!e) return
      if (Date.now() - e.lastUse > config.runpodIdleMs) {
        clearInterval(e.timer)
        rp.delete(nodeId)
        db.query('DELETE FROM nodes WHERE id=?').run(nodeId)
        dropNode(nodeId)
        void terminatePod(podId)
        console.log(`[runpod] torn down idle pod ${podId}`)
      } else {
        touch(nodeId, 'ONLINE') // keepalive
      }
    }, 15_000),
  }
  rp.set(nodeId, entry)
  touch(nodeId, 'ONLINE')
}

async function gql(query: string, variables: unknown): Promise<any> {
  const res = await fetch(`${RUNPOD_GQL}?api_key=${config.runpodApiKey}`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ query, variables }),
  })
  const json = await res.json()
  if (json.errors) throw new Error(JSON.stringify(json.errors))
  return json.data
}

async function createPod(model: string): Promise<string> {
  const data = await gql(
    `mutation($input: PodFindAndDeployOnDemandInput!){
       podFindAndDeployOnDemand(input:$input){ id }
     }`,
    {
      input: {
        cloudType: 'ALL',
        gpuCount: 1,
        gpuTypeId: config.runpodGpuType,
        name: `ggrid-${model}`.slice(0, 40),
        imageName: config.runpodImage,
        ports: '11434/http',
        containerDiskInGb: 20,
        volumeInGb: 0,
        env: [{ key: 'OLLAMA_HOST', value: '0.0.0.0' }],
      },
    },
  )
  return data.podFindAndDeployOnDemand.id as string
}

async function waitReady(podId: string): Promise<string | null> {
  const url = `https://${podId}-11434.proxy.runpod.net`
  for (let i = 0; i < 60; i++) {
    try {
      const r = await fetch(url + '/api/tags')
      if (r.ok) return url
    } catch {
      /* not ready yet */
    }
    await new Promise((r) => setTimeout(r, 5000))
  }
  return null
}

async function pullModel(url: string, model: string): Promise<void> {
  try {
    await fetch(url + '/api/pull', { method: 'POST', body: JSON.stringify({ name: model }) })
  } catch {
    /* best effort; model may be preloaded in the image */
  }
}

async function terminatePod(podId: string): Promise<void> {
  try {
    await gql(`mutation($id:String!){ podTerminate(input:{podId:$id}) }`, { id: podId })
  } catch (e) {
    console.error('[runpod] terminate failed:', e)
  }
}
