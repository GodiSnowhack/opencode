import { expect, test } from "bun:test"
import { defaultMemoryDesktopSettings } from "@opencode-ai/core/memory/desktop"
import type { ElectronAPI } from "../preload/types"
import { subscribeMemory } from "./memory-subscriptions"

test("renderer observes live Memory enablement and status independently and cleans up on remount", async () => {
  let service!: Parameters<ElectronAPI["memoryServiceSubscribe"]>[0]
  let status!: Parameters<ElectronAPI["memoryStatusSubscribe"]>[0]
  const enabled: boolean[] = []
  const connected: boolean[] = []
  let stops = 0
  const api = {
    memoryServiceSubscribe: async (callback: typeof service) => {
      service = callback
      return () => stops++
    },
    memoryStatusSubscribe: async (callback: typeof status) => {
      status = callback
      return () => stops++
    },
  }
  const stop = subscribeMemory(
    api,
    (value) => enabled.push(value),
    (value) => connected.push(value.connected),
  )
  const publish = (value: boolean) =>
    service({
      settings: { ...defaultMemoryDesktopSettings, enabled: value },
      state: "running",
      dataDirectory: "temporary",
      ollama: { connected: true, models: [] },
    })
  publish(false)
  publish(true)
  status({ connected: false, status: null, receivedAt: 0 })
  status({ connected: true, status: null, receivedAt: 1 })
  publish(false)
  await Promise.resolve()
  stop()
  expect(enabled).toEqual([false, true, false])
  expect(connected).toEqual([false, true])
  expect(stops).toBe(2)
  status({ connected: true, status: null, receivedAt: 2 })
  expect(connected).toHaveLength(2)
  const remount = subscribeMemory(
    api,
    (value) => enabled.push(value),
    () => undefined,
  )
  remount()
  await Promise.resolve()
  expect(stops).toBe(4)
})
