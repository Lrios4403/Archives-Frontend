export type SyncConflict<T = unknown> = {
  actionId: string
  localPayload: T
  remotePayload?: unknown
  message: string
  detectedAt: number
}

export type ConflictResolution<T = unknown> =
  | "retry"
  | "discard"
  | { action: "replace"; payload: T }

export type QueuedAction<T = unknown> = {
  id: string
  createdAt: number
  payload: T
  attempts: number
  lastError?: string
  conflict?: SyncConflict<T>
}

export class OfflineSyncConflictError extends Error {
  readonly remotePayload?: unknown
  readonly isConflict = true

  constructor(message = "The remote record changed before this action synced", remotePayload?: unknown) {
    super(message)
    this.name = "OfflineSyncConflictError"
    this.remotePayload = remotePayload
  }
}

const DB_NAME = "archives-offline"
const STORE_NAME = "actions"
const DB_VERSION = 1
const queue: QueuedAction[] = []
let hydrated = false
let hydration: Promise<void> | undefined

function canUseIndexedDb() {
  return typeof window !== "undefined" && "indexedDB" in window
}

function openDatabase(): Promise<IDBDatabase> {
  return new Promise((resolve, reject) => {
    const request = indexedDB.open(DB_NAME, DB_VERSION)
    request.onupgradeneeded = () => request.result.createObjectStore(STORE_NAME, { keyPath: "id" })
    request.onsuccess = () => resolve(request.result)
    request.onerror = () => reject(request.error ?? new Error("Unable to open offline queue"))
  })
}

async function readPersistedActions() {
  if (!canUseIndexedDb()) return []
  const db = await openDatabase()
  return new Promise<QueuedAction[]>((resolve, reject) => {
    const request = db.transaction(STORE_NAME, "readonly").objectStore(STORE_NAME).getAll()
    request.onsuccess = () => { db.close(); resolve(request.result.sort((a, b) => a.createdAt - b.createdAt)) }
    request.onerror = () => { db.close(); reject(request.error) }
  })
}

async function persist(action: QueuedAction) {
  if (!canUseIndexedDb()) return
  const db = await openDatabase()
  await new Promise<void>((resolve, reject) => {
    const request = db.transaction(STORE_NAME, "readwrite").objectStore(STORE_NAME).put(action)
    request.onsuccess = () => resolve()
    request.onerror = () => reject(request.error)
  }).finally(() => db.close())
}

async function removePersisted(id: string) {
  if (!canUseIndexedDb()) return
  const db = await openDatabase()
  await new Promise<void>((resolve, reject) => {
    const request = db.transaction(STORE_NAME, "readwrite").objectStore(STORE_NAME).delete(id)
    request.onsuccess = () => resolve()
    request.onerror = () => reject(request.error)
  }).finally(() => db.close())
}

export async function hydrateOfflineQueue() {
  if (hydrated) return
  hydration ??= readPersistedActions().then((actions) => {
    // An action can be enqueued before IndexedDB hydration finishes. Merge the
    // persisted snapshot instead of replacing the in-memory action and losing
    // a user change made during startup.
    const persistedIds = new Set(actions.map((action) => action.id))
    const merged = [...actions, ...queue.filter((action) => !persistedIds.has(action.id))]
    queue.splice(0, queue.length, ...merged)
    hydrated = true
  }).catch(() => { hydrated = true })
  await hydration
}

function makeId() {
  return typeof crypto !== "undefined" && "randomUUID" in crypto
    ? crypto.randomUUID()
    : `${Date.now()}-${Math.random().toString(36).slice(2)}`
}

export function enqueueOfflineAction<T>(payload: T): QueuedAction<T> {
  const action: QueuedAction<T> = { id: makeId(), createdAt: Date.now(), payload, attempts: 0 }
  queue.push(action)
  void persist(action)
  return action
}

export async function flushOfflineQueue<T>(
  send: (payload: T, action: QueuedAction<T>) => Promise<void>,
  resolveConflict?: (
    conflict: SyncConflict<T>,
    action: QueuedAction<T>,
    error: unknown,
  ) => Promise<ConflictResolution<T> | boolean>,
) {
  await hydrateOfflineQueue()
  if (typeof navigator !== "undefined" && !navigator.onLine) return { synced: 0, failed: 0, pending: queue.length }
  let synced = 0
  let failed = 0
  for (const action of [...queue] as QueuedAction<T>[]) {
    try {
      await send(action.payload, action)
      queue.splice(queue.indexOf(action), 1)
      await removePersisted(action.id)
      synced++
    } catch (error) {
      action.attempts++
      action.lastError = error instanceof Error ? error.message : "Sync failed"

      if (error instanceof OfflineSyncConflictError) {
        const conflict: SyncConflict<T> = {
          actionId: action.id,
          localPayload: action.payload,
          remotePayload: error.remotePayload,
          message: error.message,
          detectedAt: Date.now(),
        }
        action.conflict = conflict
        await persist(action)

        if (resolveConflict) {
          const resolution = await resolveConflict(conflict, action, error)
          if (resolution === "discard" || resolution === true) {
            queue.splice(queue.indexOf(action), 1)
            await removePersisted(action.id)
          } else if (resolution === "retry") {
            delete action.conflict
            await persist(action)
          } else if (typeof resolution === "object" && resolution.action === "replace") {
            action.payload = resolution.payload
            delete action.conflict
            await persist(action)
          }
        }
      } else {
        await persist(action)
      }
      failed++
    }
  }
  return { synced, failed, pending: queue.length }
}

export function pendingOfflineActions() { return queue.length }

export function clearOfflineQueueForTests() {
  queue.splice(0, queue.length)
  hydrated = false
  hydration = undefined
}

if (typeof window !== "undefined") void hydrateOfflineQueue()
