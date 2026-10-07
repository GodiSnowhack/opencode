import { expect, test } from "bun:test"
import { defaultMemoryDesktopSettings, type MemoryServiceSnapshot } from "@opencode-ai/core/memory/desktop"
import { createMemoryServiceSubscriptions } from "./memory-service-subscriptions"

test("closing Settings preserves the Desktop root subscription, with one IPC listener", async () => {
  let publish!: (value: MemoryServiceSnapshot) => void
  let subscriptions = 0
  let removals = 0
  let detachments = 0
  const subscribe = createMemoryServiceSubscriptions({
    listen(callback) {
      publish = callback
      return () => detachments++
    },
    subscribe: async () => {
      subscriptions++
    },
    unsubscribe: async () => {
      removals++
    },
  })
  const root: boolean[] = []
  const settings: boolean[] = []
  const value: MemoryServiceSnapshot = {
    settings: { ...defaultMemoryDesktopSettings, enabled: true },
    state: "running",
    dataDirectory: "temporary",
    ollama: { connected: true, models: [] },
  }
  const stopRoot = await subscribe((next) => root.push(next.settings.enabled))
  publish(value)
  const stopSettings = await subscribe((next) => settings.push(next.settings.enabled))
  expect(settings).toEqual([true])
  expect(subscriptions).toBe(1)
  stopSettings()
  expect(removals).toBe(0)
  publish({ ...value, settings: { ...value.settings, enabled: false } })
  expect(root).toEqual([true, false])
  expect(settings).toEqual([true])
  stopRoot()
  stopRoot()
  expect(removals).toBe(1)
  expect(detachments).toBe(1)
  const remount = await subscribe(() => undefined)
  expect(subscriptions).toBe(2)
  remount()
  expect(detachments).toBe(2)
})

test("failed service subscribe removes the IPC listener and permits recovery", async () => {
  let attempts = 0
  let detachments = 0
  const subscribe = createMemoryServiceSubscriptions({
    listen: () => () => {
      detachments++
    },
    subscribe: async () => {
      if (++attempts === 1) throw new Error("unavailable")
    },
    unsubscribe: async () => undefined,
  })
  await expect(subscribe(() => undefined)).rejects.toThrow("unavailable")
  expect(detachments).toBe(1)
  const stop = await subscribe(() => undefined)
  stop()
  expect(detachments).toBe(2)
})
