import { config } from './config'
import { selectNode, penalize } from './registry'
import { shadowChat, lastUserMessage, type ChatMessage } from './probe'

// Spot-check verification.
//
// After a job finishes, a small fraction of jobs (config.integrity.spotcheckRate)
// are replayed on a DIFFERENT node serving the same model. A judge model then
// decides whether the two answers agree in meaning (wording may differ). If they
// clearly disagree, the node that served the original job is penalized — repeated
// divergence drops it below the reliability floor and it is quarantined out of
// routing, exactly like any other unreliable node.
//
// This is best-effort and fully asynchronous: it runs after the user already has
// their response, never blocks or bills them, and NEVER persists prompt/answer
// content. Any error just ends the audit quietly.

export interface SpotCheckInput {
  model: string
  messages: ChatMessage[]
  firstNodeId: string
  firstAnswer: string
}

type Verdict = 'consistent' | 'inconsistent' | 'unknown'

export async function spotCheck(inp: SpotCheckInput): Promise<Verdict> {
  const { model, messages, firstNodeId, firstAnswer } = inp
  if (!Array.isArray(messages) || messages.length === 0) return 'unknown'
  if (!firstAnswer || firstAnswer.trim().length === 0) return 'unknown'

  // A second node serving the same model, excluding the one under audit.
  const second = selectNode(model, new Set([firstNodeId]), { endpoint: 'chat' })
  if (!second) return 'unknown' // nothing to compare against

  const secondAnswer = await shadowChat(second, model, messages, config.integrity.spotcheckMaxTokens)
  if (!secondAnswer || secondAnswer.trim().length === 0) return 'unknown'

  const verdict = await judge(model, messages, firstAnswer, secondAnswer)
  if (verdict === 'inconsistent') {
    penalize(firstNodeId)
    console.warn(`[spotcheck] node ${firstNodeId} answer diverged on '${model}' — penalized`)
  }
  return verdict
}

// Ask a judge model whether two answers to the same question are consistent in
// meaning. Returns 'unknown' if no judge node is available or the reply is
// unparseable, so an inconclusive judge never penalizes a node.
async function judge(model: string, messages: ChatMessage[], a: string, b: string): Promise<Verdict> {
  const judgeModel = config.integrity.spotcheckJudgeModel || model
  const jnode = selectNode(judgeModel, undefined, { endpoint: 'chat' })
  if (!jnode) return 'unknown'

  const question = lastUserMessage(messages)
  const prompt: ChatMessage[] = [
    {
      role: 'system',
      content:
        'You are a strict evaluator. Two assistants answered the same question. Decide whether they are consistent in meaning; wording, length and style may differ. Answer with exactly one word.',
    },
    {
      role: 'user',
      content: `QUESTION:\n${question}\n\nANSWER A:\n${a}\n\nANSWER B:\n${b}\n\nAre A and B consistent in meaning? Reply CONSISTENT or INCONSISTENT.`,
    },
  ]
  const out = await shadowChat(jnode, judgeModel, prompt, 8)
  if (!out) return 'unknown'
  const u = out.toUpperCase()
  // Check INCONSISTENT first — it contains the substring "CONSISTENT".
  if (u.includes('INCONSISTENT')) return 'inconsistent'
  if (u.includes('CONSISTENT')) return 'consistent'
  return 'unknown'
}
