import { config } from './config'
import type { NodeRow } from './types'

// Shared helpers for the integrity audits (spot-check + canary). A "shadow" chat
// is an un-billed, non-streaming call straight to a node — it never touches the
// DB, the user's balance, or the ledger, and its content is discarded.

export interface ChatMessage {
  role: string
  content: string
}

// One un-billed, non-streaming, deterministic (temperature 0) chat call against a
// node. Returns the assistant text, or null on any failure (unreachable, non-200,
// malformed). Never throws.
export async function shadowChat(
  node: NodeRow,
  model: string,
  messages: ChatMessage[],
  maxTokens: number,
): Promise<string | null> {
  try {
    const res = await fetch(node.url.replace(/\/$/, '') + '/v1/chat/completions', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ model, messages, max_tokens: maxTokens, temperature: 0, stream: false }),
      signal: AbortSignal.timeout(config.integrity.probeTimeoutMs),
    })
    if (!res.ok) return null
    const data: any = await res.json()
    const text = data?.choices?.[0]?.message?.content
    return typeof text === 'string' ? text : null
  } catch {
    return null
  }
}

// Pull the assistant text out of an OpenAI-style SSE transcript (concatenated
// delta.content). Used to recover the answer of a streamed job for spot-checking.
export function extractText(sseText: string): string {
  let out = ''
  for (const line of sseText.split('\n')) {
    const t = line.trim()
    if (!t.startsWith('data:')) continue
    const payload = t.slice(5).trim()
    if (!payload || payload === '[DONE]') continue
    try {
      const obj = JSON.parse(payload)
      const c = obj?.choices?.[0]
      const piece = c?.delta?.content ?? c?.message?.content
      if (typeof piece === 'string') out += piece
    } catch {
      /* partial chunk; ignore */
    }
  }
  return out
}

// Last user turn in a message list — the actual question a judge should score.
export function lastUserMessage(messages: ChatMessage[]): string {
  for (let i = messages.length - 1; i >= 0; i--) {
    if (messages[i]?.role === 'user') return String(messages[i]?.content ?? '')
  }
  return String(messages[messages.length - 1]?.content ?? '')
}
