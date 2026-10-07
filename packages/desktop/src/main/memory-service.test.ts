import { expect, test } from "bun:test"
import { join, resolve, sep } from "node:path"
import { createServer } from "node:net"
import { mkdtempSync, mkdirSync, rmSync, writeFileSync } from "node:fs"
import { tmpdir } from "node:os"
import { defaultMemoryDesktopSettings, parseMemoryDesktopSettings } from "@opencode-ai/core/memory/desktop"
import {
  MemoryService,
  managedMemoryProvider,
  managedProviderContext,
  managedProviderModels,
  memoryWorkerModelEnv,
  memoryGatewayDirectory,
  memoryGatewayResources,
  memoryDevRelaunchArgs,
  applyAgentToolSettings,
} from "./memory-service"

test("validates memory settings without accepting arbitrary paths or models", () => {
  expect(parseMemoryDesktopSettings(defaultMemoryDesktopSettings).port).toBe(11435)
  expect(parseMemoryDesktopSettings({}).contextLength).toBe(32768)
  for (const contextLength of [8192, 16384, 32768, 49152, 65536, 98304, 131072, 262144])
    expect(parseMemoryDesktopSettings({ contextLength }).contextLength).toBe(contextLength)
  for (const contextLength of [0, -1, 1.5, "abc", 1000000000])
    expect(() => parseMemoryDesktopSettings({ contextLength })).toThrow("invalid_context_length")
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
  expect(parseMemoryDesktopSettings(defaultMemoryDesktopSettings).agentTools).toBe(true)
  expect(parseMemoryDesktopSettings({ ...defaultMemoryDesktopSettings, agentTools: false }).agentTools).toBe(false)
  expect(() => parseMemoryDesktopSettings({ ...defaultMemoryDesktopSettings, agentTools: "true" })).toThrow()
  expect(() => parseMemoryDesktopSettings({ ...defaultMemoryDesktopSettings, maxToolCalls: 0 })).toThrow(
    "invalid_max_tool_calls",
  )
  expect(() => parseMemoryDesktopSettings({ ...defaultMemoryDesktopSettings, maxToolCalls: 25 })).toThrow(
    "invalid_max_tool_calls",
  )
})

test("Agent Tools toggle waits for sidecar refresh and can be turned back on", async () => {
  const before = defaultMemoryDesktopSettings
  const off = { ...before, enabled: true, agentTools: false }
  let release!: () => void
  const pending = new Promise<void>((resolve) => {
    release = resolve
  })
  let finished = false
  const update = applyAgentToolSettings({ ...before, enabled: true }, off, () => pending).then(() => {
    finished = true
  })
  await Promise.resolve()
  expect(finished).toBe(false)
  release()
  await update
  expect(finished).toBe(true)
  let calls = 0
  await applyAgentToolSettings(off, { ...off, agentTools: true }, async () => {
    calls++
  })
  expect(calls).toBe(1)
  await applyAgentToolSettings(off, { ...off, contextLength: 65536 }, async () => {
    calls++
  })
  expect(calls).toBe(2)
})

test("managed provider preserves unrelated providers", () => {
  const configured = JSON.parse(
    managedMemoryProvider(JSON.stringify({ provider: { cloud: { options: { apiKey: "test" } } } }), "qwen3:8b", 11435),
  )
  expect(configured.provider.cloud.options.apiKey).toBe("test")
  expect(configured.provider["memory-local"].options.baseURL).toBe("http://127.0.0.1:11435/v1")
  expect(configured.provider["memory-local"].models["qwen3:8b"].limit.context).toBe(32768)
  expect(
    JSON.parse(managedMemoryProvider(undefined, "qwen3:8b", 11435, 65536)).provider["memory-local"].models["qwen3:8b"]
      .limit,
  ).toEqual({ context: 65536, output: 8192 })
  expect(() => managedMemoryProvider(JSON.stringify(configured), "qwen3:8b", 11435)).toThrow(
    "managed_provider_conflict",
  )
})

test("managed model metadata follows 32K to 64K to 32K without changing output", () => {
  for (const context of [32768, 65536, 32768]) {
    const config = JSON.parse(managedMemoryProvider(undefined, "qwen3:8b", 11435, context))
    const model = config.provider["memory-local"].models["qwen3:8b"]
    expect(model.limit).toEqual({ context, output: 8192 })
    expect(managedProviderContext({ all: [{ id: "memory-local", models: { "qwen3:8b": model } }] }, "qwen3:8b")).toBe(
      context,
    )
  }
  expect(managedProviderContext({ all: [] }, "qwen3:8b")).toBeUndefined()
})

test("managed provider exports discovered chat models with exact tags and per-model capabilities", () => {
  const models = [
    { id: "qwen3:8b", name: "qwen3:8b", context: 40960, tools: true, thinking: true, vision: false },
    { id: "qwen3-coder:30b", name: "qwen3-coder:30b", context: 262144, tools: true, thinking: false, vision: false },
    {
      id: "gemma4:26b-a4b-it-q4_K_M",
      name: "gemma4:26b-a4b-it-q4_K_M",
      context: 262144,
      tools: true,
      thinking: true,
      vision: true,
    },
  ]
  const provider = JSON.parse(managedMemoryProvider(undefined, models, 11435, 131072)).provider["memory-local"]
  expect(Object.keys(provider.models)).toEqual(models.map((model) => model.id))
  expect(provider.models["qwen3:8b"].limit).toEqual({ context: 40960, output: 8192 })
  expect(provider.models["qwen3-coder:30b"].limit.context).toBe(131072)
  expect(provider.models["gemma4:26b-a4b-it-q4_K_M"].limit.context).toBe(131072)
  expect(provider.models["gemma4:26b-a4b-it-q4_K_M"].modalities.input).toEqual(["text", "image"])
  expect(provider.models["gemma4:26b-a4b-it-q4_K_M"].tool_call).toBe(true)
  expect(managedProviderModels({ all: [{ id: "memory-local", models: provider.models }] })).toEqual({
    "qwen3:8b": 40960,
    "qwen3-coder:30b": 131072,
    "gemma4:26b-a4b-it-q4_K_M": 131072,
  })
  expect(managedProviderModels({ all: [] })).toEqual({})
})

test("selecting an agent model does not change the Memory worker model", () => {
  const settings = { ...defaultMemoryDesktopSettings, enabled: true, model: "qwen3:8b" }
  const agent = [
    { id: "gemma4:26b-a4b-it-q4_K_M", name: "Gemma", context: 262144, tools: true, thinking: true, vision: true },
  ]
  const provider = JSON.parse(managedMemoryProvider(undefined, agent, settings.port, settings.contextLength))
  expect(Object.keys(provider.provider["memory-local"].models)).toEqual(["gemma4:26b-a4b-it-q4_K_M"])
  expect(memoryWorkerModelEnv(settings)).toEqual({ MEMORY_LLM_MODEL: "qwen3:8b", MEMORY_CHAT_CONTEXT_LENGTH: "32768" })
})

test("dev resources and relaunch preserve the absolute app path after cwd changes", () => {
  const appPath = join("C:", "Workspace With Spaces", "opencode-custom", "packages", "desktop")
  const resources = join("C:", "Program Files", "OpenCode", "resources")
  expect(memoryGatewayResources(false, appPath, resources)).toBe(join(appPath, "resources"))
  expect(memoryGatewayResources(true, appPath, resources)).toBe(resources)
  expect(memoryDevRelaunchArgs(appPath, ["electron.exe", ".", "--remote-debugging-port=9222"])).toEqual([
    appPath,
    "--remote-debugging-port=9222",
  ])
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

test("missing development Gateway resource fails without terminating Desktop", async () => {
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
    userData: join(tmpdir(), "memory-missing-resource-profile"),
    resources: join(tmpdir(), "memory-missing-resource-bundle"),
    executable: process.execPath,
    request: async () => {
      throw new Error("offline")
    },
  })
  const snapshot = await service.start()
  expect(snapshot.state).toBe("failed")
  expect(snapshot.reason).toBe("gateway_not_bundled")
  await service.stop()
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

test("a newly discovered external Gateway cannot silently accept a changed managed context", async () => {
  let saved: unknown = defaultMemoryDesktopSettings
  const service = new MemoryService({
    store: {
      get: () => saved,
      set: (_key, value) => {
        saved = value
      },
    },
    userData: "test-data",
    resources: "missing",
    executable: "missing",
    request: async () => Response.json({ status: "ok", apiVersion: 1, gatewayVersion: "0.8.0" }),
  })
  await expect(
    service.update({ ...defaultMemoryDesktopSettings, enabled: true, contextLength: 65536 }),
  ).rejects.toThrow("managed_context_requires_owned_gateway")
  expect(parseMemoryDesktopSettings(saved).contextLength).toBe(32768)
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
  await first.update({ ...defaultMemoryDesktopSettings, injection: false, retrievalTokens: 900, contextLength: 65536 })
  const reopened = new MemoryService({ store, userData: "test-data", resources: "missing", executable: "missing" })
  expect(reopened.snapshot.settings.injection).toBe(false)
  expect(reopened.snapshot.settings.retrievalTokens).toBe(900)
  expect(reopened.snapshot.settings.contextLength).toBe(65536)
})

test("effective context comes from Ollama running model metadata", async () => {
  let shown = 0
  const service = new MemoryService({
    store: { get: () => ({ ...defaultMemoryDesktopSettings, contextLength: 65536 }), set: () => undefined },
    userData: "test-data",
    resources: "missing",
    executable: "missing",
    request: async (input) => {
      const path = input instanceof Request ? input.url : input instanceof URL ? input.href : input
      if (path.endsWith("/api/tags")) return Response.json({ models: [{ name: "qwen3:8b", digest: "one" }] })
      if (path.endsWith("/api/show")) {
        shown++
        return Response.json({
          capabilities: ["completion", "tools", "thinking"],
          model_info: { "qwen3.context_length": 40960 },
        })
      }
      if (path.endsWith("/api/ps")) return Response.json({ models: [{ name: "qwen3:8b", context_length: 40960 }] })
      throw new Error("unexpected_request")
    },
  })
  await service.detectOllama()
  expect(service.snapshot.settings.contextLength).toBe(65536)
  expect(service.snapshot.ollama.effectiveContextLength).toBe(40960)
  expect(service.snapshot.ollama.modelContextLength).toBe(40960)
  await service.detectOllama()
  expect(shown).toBe(1)
})

test("effective context reports the full requested value when Ollama loads it", async () => {
  const service = new MemoryService({
    store: { get: () => ({ ...defaultMemoryDesktopSettings, contextLength: 65536 }), set: () => undefined },
    userData: "test-data",
    resources: "missing",
    executable: "missing",
    request: async (input) => {
      const path = input instanceof Request ? input.url : input instanceof URL ? input.href : input
      if (path.endsWith("/api/tags")) return Response.json({ models: [{ name: "qwen3:8b", digest: "one" }] })
      if (path.endsWith("/api/show"))
        return Response.json({ capabilities: ["completion", "tools"], model_info: { "qwen3.context_length": 131072 } })
      if (path.endsWith("/api/ps")) return Response.json({ models: [{ name: "qwen3:8b", context_length: 65536 }] })
      throw new Error("unexpected_request")
    },
  })
  await service.detectOllama()
  expect(service.snapshot.ollama.effectiveContextLength).toBe(65536)
  expect(service.snapshot.ollama.modelContextLength).toBe(131072)
})

test("failed managed Gateway apply restores the previous context setting", async () => {
  let saved: unknown = defaultMemoryDesktopSettings
  const service = new MemoryService({
    store: {
      get: () => saved,
      set: (_key, value) => {
        saved = value
      },
    },
    userData: "test-data",
    resources: "missing",
    executable: "missing",
    request: async () => {
      throw new Error("gateway_unavailable")
    },
  })
  await expect(
    service.update({ ...defaultMemoryDesktopSettings, enabled: true, contextLength: 131072 }),
  ).rejects.toThrow()
  expect(service.snapshot.settings.contextLength).toBe(32768)
  expect(parseMemoryDesktopSettings(saved).contextLength).toBe(32768)
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
