import { expect, test } from "bun:test"
import { join, resolve, sep } from "node:path"
import { createServer } from "node:net"
import { mkdtempSync, mkdirSync, rmSync, writeFileSync } from "node:fs"
import { tmpdir } from "node:os"
import { defaultMemoryDesktopSettings, parseMemoryDesktopSettings } from "@opencode-ai/core/memory/desktop"
import { MemoryService, managedMemoryProvider, memoryGatewayDirectory } from "./memory-service"

test("validates memory settings without accepting arbitrary paths or models", () => {
  expect(parseMemoryDesktopSettings(defaultMemoryDesktopSettings).port).toBe(11435)
  expect(() => parseMemoryDesktopSettings({ ...defaultMemoryDesktopSettings, port: 0 })).toThrow("invalid_port")
  expect(() => parseMemoryDesktopSettings({ ...defaultMemoryDesktopSettings, retrievalTokens: 100000 })).toThrow(
    "invalid_retrieval_tokens",
  )
  expect(() => parseMemoryDesktopSettings({ ...defaultMemoryDesktopSettings, model: "../qwen" })).toThrow(
    "invalid_model",
  )
  expect(
    parseMemoryDesktopSettings({ ...defaultMemoryDesktopSettings, model: "hf.co/DavidAU/Qwen3-8B:latest" }).model,
  ).toBe("hf.co/DavidAU/Qwen3-8B:latest")
  expect(() => parseMemoryDesktopSettings({ ...defaultMemoryDesktopSettings, model: "http://remote/model" })).toThrow(
    "invalid_model",
  )
})

test("managed provider preserves unrelated providers", () => {
  const configured = JSON.parse(
    managedMemoryProvider(JSON.stringify({ provider: { cloud: { options: { apiKey: "test" } } } }), "qwen3:8b", 11435),
  )
  expect(configured.provider.cloud.options.apiKey).toBe("test")
  expect(configured.provider["memory-local"].options.baseURL).toBe("http://127.0.0.1:11435/v1")
  expect(() => managedMemoryProvider(JSON.stringify(configured), "qwen3:8b", 11435)).toThrow(
    "managed_provider_conflict",
  )
})

test("disabled memory does not launch a Gateway", async () => {
  const store = { get: () => defaultMemoryDesktopSettings, set: () => undefined }
  const service = new MemoryService({
    store,
    userData: join("C:", "Data With Spaces"),
    resources: "missing",
    executable: "missing",
  })
  expect((await service.start()).state).toBe("stopped")
  expect(memoryGatewayDirectory(join("C:", "Program Files", "OpenCode"))).toContain("memory-gateway")
})

test("compatible external Gateway remains owned by its process", async () => {
  const store = { get: () => ({ ...defaultMemoryDesktopSettings, enabled: true, port: 11435 }), set: () => undefined }
  const request = async () => Response.json({ status: "ok", apiVersion: 1, gatewayVersion: "0.8.0" })
  const service = new MemoryService({
    store,
    userData: "test-data",
    resources: "missing",
    executable: "missing",
    request: request as typeof fetch,
  })
  expect((await service.start()).state).toBe("external")
  await service.stop()
  expect(service.snapshot.state).toBe("stopped")
})

test("incompatible port is rejected without spawning", async () => {
  const store = { get: () => ({ ...defaultMemoryDesktopSettings, enabled: true }), set: () => undefined }
  const request = async () => Response.json({ status: "ok" })
  const service = new MemoryService({
    store,
    userData: "test-data",
    resources: "missing",
    executable: "missing",
    request: request as typeof fetch,
  })
  expect((await service.start()).reason).toBe("port_occupied_or_incompatible")
})

test("an unrelated TCP listener is not killed", async () => {
  const listener = createServer((socket) => socket.end())
  await new Promise<void>((resolve) => listener.listen(0, "127.0.0.1", resolve))
  const address = listener.address()
  if (!address || typeof address === "string") throw new Error("No port")
  const store = {
    get: () => ({ ...defaultMemoryDesktopSettings, enabled: true, port: address.port }),
    set: () => undefined,
  }
  const service = new MemoryService({ store, userData: "test-data", resources: "missing", executable: "missing" })
  try {
    expect((await service.start()).reason).toBe("port_occupied_or_incompatible")
    expect(listener.listening).toBe(true)
  } finally {
    await new Promise<void>((resolve) => listener.close(() => resolve()))
  }
})

test("settings persist through store reopen", async () => {
  let saved: unknown = defaultMemoryDesktopSettings
  const store = {
    get: () => saved,
    set: (_key: string, value: unknown) => {
      saved = value
    },
  }
  const first = new MemoryService({ store, userData: "test-data", resources: "missing", executable: "missing" })
  await first.update({ ...defaultMemoryDesktopSettings, injection: false, retrievalTokens: 900 })
  const reopened = new MemoryService({ store, userData: "test-data", resources: "missing", executable: "missing" })
  expect(reopened.snapshot.settings.injection).toBe(false)
  expect(reopened.snapshot.settings.retrievalTokens).toBe(900)
})

test("crashed owned Gateway retries only three times", async () => {
  const root = mkdtempSync(join(tmpdir(), "memory-crash-test-"))
  const resources = join(root, "resources")
  mkdirSync(join(resources, "memory-gateway"), { recursive: true })
  writeFileSync(join(resources, "memory-gateway", "gateway.mjs"), "process.exit(1)\n")
  const listener = createServer()
  await new Promise<void>((resolve) => listener.listen(0, "127.0.0.1", resolve))
  const address = listener.address()
  if (!address || typeof address === "string") throw new Error("No port")
  await new Promise<void>((resolve) => listener.close(() => resolve()))
  const service = new MemoryService({
    store: {
      get: () => ({ ...defaultMemoryDesktopSettings, enabled: true, port: address.port }),
      set: () => undefined,
    },
    userData: join(root, "profile"),
    resources,
    executable: process.execPath,
  })
  let restarts = 0
  const unsubscribe = service.subscribe((snapshot) => {
    if (snapshot.state === "restarting") restarts++
  })
  try {
    await service.start()
    await new Promise<void>((resolve, reject) => {
      const timeout = setTimeout(() => reject(new Error("crash retry timeout")), 12_000)
      const stop = service.subscribe((snapshot) => {
        if (snapshot.state !== "failed") return
        clearTimeout(timeout)
        stop()
        resolve()
      })
    })
    expect(service.snapshot.reason).toBe("gateway_crashed")
    expect(restarts).toBe(3)
  } finally {
    unsubscribe()
    await service.stop()
    if (resolve(root).startsWith(resolve(tmpdir()) + sep)) rmSync(root, { recursive: true, force: true })
  }
}, 15_000)
