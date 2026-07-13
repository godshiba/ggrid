// A fake Ollama node for tests: implements /api/tags and an OpenAI-compatible
// /v1/chat/completions (both streaming and non-streaming, with usage) plus
// /v1/embeddings. A single node can be spun with options so the integrity tests
// can model an honest node, a model-spoofing node, and a judge.

export interface MockOpts {
  models?: string[]
  port?: number
  wrong?: boolean // answer every canary/question wrong (fakes a smaller model)
  content?: string // override the default reply content
}

// Deterministic answers to the canary prompts in src/canary.ts, so an "honest"
// mock passes the integrity probes. Keyed on stable substrings of each question.
function canaryAnswer(q: string): string | null {
  if (q.includes('17 * 23')) return '391'
  if (q.includes('capital city of Australia')) return 'Canberra'
  if (q.includes('days are in a week')) return '7'
  if (q.includes('chemical symbol for gold')) return 'Au'
  if (q.includes('2 to the power of 10')) return '1024'
  return null
}

function between(s: string, start: string, end: string | null): string {
  const i = s.indexOf(start)
  if (i < 0) return ''
  const from = i + start.length
  const j = end ? s.indexOf(end, from) : -1
  return j < 0 ? s.slice(from) : s.slice(from, j)
}

const norm = (s: string): string => s.trim().toLowerCase().replace(/\s+/g, ' ')

function lastUserText(body: any): string {
  const msgs = Array.isArray(body?.messages) ? body.messages : []
  for (let i = msgs.length - 1; i >= 0; i--) if (msgs[i]?.role === 'user') return String(msgs[i]?.content ?? '')
  return ''
}

// Decide the assistant reply for a request. Order matters: judge detection first
// (so a node picked as judge always judges), then spoof mode, then canaries.
function computeContent(body: any, opts: MockOpts): string {
  const t = lastUserText(body)
  if (/Reply CONSISTENT or INCONSISTENT/i.test(t)) {
    const a = between(t, 'ANSWER A:', 'ANSWER B:')
    const b = between(t, 'ANSWER B:', 'Are A and B')
    return norm(a) === norm(b) ? 'CONSISTENT' : 'INCONSISTENT'
  }
  if (opts.wrong) return 'nope'
  const canary = canaryAnswer(t)
  if (canary) return canary
  return (
    opts.content ??
    process.env.MOCK_CONTENT ??
    'A GPU runs thousands of small calculations at once, which is what makes it fast at graphics and AI workloads.'
  )
}

export function makeMockNode(opts: MockOpts = {}) {
  const models = opts.models ?? (process.env.MOCK_MODELS ?? 'llama3:8b').split(',')
  return Bun.serve({
    port: opts.port ?? Number(process.env.MOCK_PORT ?? 0), // 0 → random free port
    async fetch(req) {
      const url = new URL(req.url)

      if (url.pathname === '/api/tags') {
        return Response.json({ models: models.map((name) => ({ name })) })
      }

      if (url.pathname === '/v1/chat/completions' && req.method === 'POST') {
        const body = await req.json().catch(() => ({}) as any)
        const content = computeContent(body, opts)
        // realistic-ish token counts so billing + fee split are exercised properly
        const usage = { prompt_tokens: 1280, completion_tokens: 845, total_tokens: 2125 }

        if (body.stream) {
          const enc = new TextEncoder()
          const words = content.split(' ')
          const stream = new ReadableStream({
            async start(controller) {
              for (const w of words) {
                const chunk = { choices: [{ index: 0, delta: { content: w + ' ' } }] }
                controller.enqueue(enc.encode(`data: ${JSON.stringify(chunk)}\n\n`))
                await new Promise((r) => setTimeout(r, 3))
              }
              const final = { choices: [{ index: 0, delta: {}, finish_reason: 'stop' }], usage }
              controller.enqueue(enc.encode(`data: ${JSON.stringify(final)}\n\n`))
              controller.enqueue(enc.encode('data: [DONE]\n\n'))
              controller.close()
            },
          })
          return new Response(stream, { headers: { 'content-type': 'text/event-stream' } })
        }

        return Response.json({
          id: 'chatcmpl-mock',
          object: 'chat.completion',
          model: body.model ?? 'mock',
          choices: [{ index: 0, message: { role: 'assistant', content }, finish_reason: 'stop' }],
          usage,
        })
      }

      if (url.pathname === '/v1/embeddings' && req.method === 'POST') {
        const body = await req.json().catch(() => ({}) as any)
        return Response.json({
          object: 'list',
          data: [{ object: 'embedding', index: 0, embedding: [0.1, 0.2, 0.3] }],
          model: body.model ?? 'mock',
          usage: { prompt_tokens: 8, total_tokens: 8 },
        })
      }

      return new Response('not found', { status: 404 })
    },
  })
}

// Default shared node, used by the main e2e flow.
export const server = makeMockNode()

if (import.meta.main) console.log(`[mock-node] http://localhost:${server.port}`)
