import type { MemoryServiceSnapshot } from "@opencode-ai/core/memory/desktop"

export function createMemoryServiceSubscriptions(transport: {
  listen(callback: (snapshot: MemoryServiceSnapshot) => void): () => void
  subscribe(): Promise<void>
  unsubscribe(): Promise<void>
}) {
  const callbacks = new Set<(snapshot: MemoryServiceSnapshot) => void>()
  let snapshot: MemoryServiceSnapshot | undefined
  let ready: Promise<void> | undefined
  let detach: (() => void) | undefined
  const remove = (callback: (snapshot: MemoryServiceSnapshot) => void) => {
    if (!callbacks.delete(callback) || callbacks.size) return
    detach?.()
    detach = undefined
    ready = undefined
    snapshot = undefined
    void transport.unsubscribe().catch(() => undefined)
  }
  return async (callback: (snapshot: MemoryServiceSnapshot) => void) => {
    callbacks.add(callback)
    if (snapshot) callback(snapshot)
    if (!ready) {
      detach = transport.listen((value) => {
        snapshot = value
        callbacks.forEach((listener) => listener(value))
      })
      ready = transport.subscribe()
    }
    try {
      await ready
    } catch (error) {
      remove(callback)
      throw error
    }
    return () => remove(callback)
  }
}
