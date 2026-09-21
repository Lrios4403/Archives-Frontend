export type QueuedAction<T = unknown> = {
  id: string
  createdAt: number
  payload: T
  attempts: number
}

const queue: QueuedAction[] = []

export function enqueueOfflineAction<T>(payload: T): QueuedAction<T> {
  const action: QueuedAction<T> = { id: crypto.randomUUID(), createdAt: Date.now(), payload, attempts: 0 }
  queue.push(action)
  return action
}

export async function flushOfflineQueue<T>(send: (payload: T) => Promise<void>, resolveConflict?: (action: QueuedAction<T>, error: unknown) => Promise<boolean>) {
  if (typeof navigator !== "undefined" && !navigator.onLine) return { synced: 0, failed: 0 }
  let synced = 0
  let failed = 0
  for (const action of [...queue] as QueuedAction<T>[]) {
    try {
      await send(action.payload)
      queue.splice(queue.indexOf(action), 1)
      synced++
    } catch (error) {
      action.attempts++
      const resolved = resolveConflict ? await resolveConflict(action, error) : false
      if (resolved) queue.splice(queue.indexOf(action), 1)
      failed++
    }
  }
  return { synced, failed }
}

export function pendingOfflineActions() { return queue.length }
