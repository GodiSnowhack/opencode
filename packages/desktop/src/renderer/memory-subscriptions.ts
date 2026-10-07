import type { MemoryStatusSnapshot } from "@opencode-ai/core/memory/status"
import type { ElectronAPI } from "../preload/types"

// Subscribe to settings even while disabled; status reconnects independently of the agent catalog.
export function subscribeMemory(
  api: Pick<ElectronAPI, "memoryServiceSubscribe" | "memoryStatusSubscribe">,
  enabled: (value: boolean) => void,
  snapshot: (value: MemoryStatusSnapshot) => void,
) {
  let disposed = false
  const stops: (() => void)[] = []
  const attach = (subscription: Promise<() => void>) => {
    void subscription.then((stop) => (disposed ? stop() : stops.push(stop))).catch(() => undefined)
  }
  attach(api.memoryServiceSubscribe((value) => !disposed && enabled(value.settings.enabled)))
  attach(api.memoryStatusSubscribe((value) => !disposed && snapshot(value)))
  return () => {
    disposed = true
    stops.splice(0).forEach((stop) => stop())
  }
}
