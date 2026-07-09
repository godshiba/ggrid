// In-memory capacity queue. When every node serving a model is at capacity, a
// request waits here for a slot to free instead of getting an instant 503. Single
// process / instance for now (would be Redis-backed when we scale horizontally).

import { config } from './config'

let waiting = 0
const waiters = new Set<() => void>()

// Called when a job finishes (a slot may have freed) -> wake waiters to re-check.
export function notifySlotFree(): void {
  for (const wake of [...waiters]) wake()
}

// How many requests are currently parked in the queue (for stats / backpressure).
export function queueDepth(): number {
  return waiting
}

// Wait until `ready()` returns true (a slot for the model is free) or we hit the
// max wait. Returns true if capacity became available. Bounded by queueMaxWaitMs,
// and by queueMaxDepth (beyond which we don't queue at all -> caller should 503).
// Re-checks on every slot-free notification and at least every 500ms as a safety
// net (covers a node coming online while we wait).
export async function waitForSlot(ready: () => boolean): Promise<boolean> {
  if (ready()) return true
  if (waiting >= config.routing.queueMaxDepth) return false

  waiting++
  try {
    const deadline = Date.now() + config.routing.queueMaxWaitMs
    while (Date.now() < deadline) {
      if (ready()) return true
      const remaining = deadline - Date.now()
      await new Promise<void>((resolve) => {
        let timer: ReturnType<typeof setTimeout>
        const wake = () => {
          clearTimeout(timer)
          waiters.delete(wake)
          resolve()
        }
        timer = setTimeout(wake, Math.min(500, remaining))
        waiters.add(wake)
      })
    }
    return ready()
  } finally {
    waiting--
  }
}
