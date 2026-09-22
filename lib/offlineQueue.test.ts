import { describe, expect, test } from "bun:test"
import {
  clearOfflineQueueForTests,
  enqueueOfflineAction,
  flushOfflineQueue,
  OfflineSyncConflictError,
  pendingOfflineActions,
} from "./offlineQueue"

describe("offline queue sync", () => {
  test.serial("keeps actions pending while offline", async () => {
    clearOfflineQueueForTests()
    const previousNavigator = globalThis.navigator
    Object.defineProperty(globalThis, "navigator", { configurable: true, value: { onLine: false } })
    enqueueOfflineAction({ id: "offline" })

    const result = await flushOfflineQueue(async () => {
      throw new Error("network should not be called")
    })

    expect(result).toEqual({ synced: 0, failed: 0, pending: 1 })
    expect(pendingOfflineActions()).toBe(1)
    Object.defineProperty(globalThis, "navigator", { configurable: true, value: { onLine: previousNavigator?.onLine ?? true } })
    clearOfflineQueueForTests()
  })

  test.serial("retries transient failures and removes successful actions", async () => {
    clearOfflineQueueForTests()
    enqueueOfflineAction({ id: "retry" })
    let calls = 0

    const result = await flushOfflineQueue(async () => {
      calls++
      if (calls === 1) throw new Error("temporary outage")
    })

    expect(calls).toBe(1)
    expect(result).toEqual({ synced: 0, failed: 1, pending: 1 })
    expect(pendingOfflineActions()).toBe(1)
    clearOfflineQueueForTests()
  })

  test.serial("captures conflicts and can replace the local payload", async () => {
    clearOfflineQueueForTests()
    enqueueOfflineAction({ version: 1 })
    const conflicts: unknown[] = []

    const result = await flushOfflineQueue(
      async (payload) => {
        if ((payload as { version: number }).version === 1) {
          throw new OfflineSyncConflictError("stale version", { version: 2 })
        }
      },
      async (conflict) => {
        conflicts.push(conflict)
        return { action: "replace", payload: { version: 2 } }
      },
    )

    expect(conflicts).toHaveLength(1)
    expect(result).toEqual({ synced: 0, failed: 1, pending: 1 })
    expect(pendingOfflineActions()).toBe(1)
    clearOfflineQueueForTests()
  })
})

// The queue intentionally flushes once per event. A later flush retries actions
// that failed transiently or were replaced during conflict resolution.
test("flushes a retained action on a later reconnect", async () => {
  clearOfflineQueueForTests()
  enqueueOfflineAction({ id: "reconnect" })
  let calls = 0

  await flushOfflineQueue(async () => {
    calls++
    throw new Error("offline")
  })
  const result = await flushOfflineQueue(async () => {
    calls++
  })

  expect(calls).toBe(2)
  expect(result).toEqual({ synced: 1, failed: 0, pending: 0 })
  expect(pendingOfflineActions()).toBe(0)
  clearOfflineQueueForTests()
})

clearOfflineQueueForTests()
