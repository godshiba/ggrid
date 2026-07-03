// A fake Ollama node for tests: implements /api/tags and an OpenAI-compatible
// /v1/chat/completions (both streaming and non-streaming, with usage).
const MODELS = (process.env.MOCK_MODELS ?? 'llama3:8b').split(',')

export const server = Bun.serve({
  port: Number(process.env.MOCK_PORT ?? 0), // 0 → random free port
  async fetch(req) {
    const url = new URL(req.url)

    if (url.pathname === '/api/tags') {
      return Response.json({ models: MODELS.map((name) => ({ name })) })
    }

    if (url.pathname === '/v1/chat/completions' && req.method === 'POST') {
      const body = await req.json().catch(() => ({}) as any)
      const content = 'Hello from the grid! (mock response)'
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

if (import.meta.main) console.log(`[mock-node] http://localhost:${server.port} models=${MODELS.join(',')}`)
