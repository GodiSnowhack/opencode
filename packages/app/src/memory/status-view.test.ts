import { describe, expect, test } from "bun:test"
import type { GatewayStatus, MemoryStatusSnapshot } from "@opencode-ai/core/memory/status"
import { memoryStatusEnabled, openMemoryManager, statusView, toggleMemoryPanel } from "./status-view"
import { nextMemoryPanelOpen } from "./panel-view"

const now = Date.parse("2026-09-28T12:00:12Z")
const status = (input: Partial<GatewayStatus> = {}): GatewayStatus => ({
  type: "memory.status",
  state: "IDLE",
  phase: "IDLE",
  jobId: null,
  startedAt: null,
  elapsedMs: 0,
  queuedUserRequests: 0,
  queueLength: 0,
  processedItems: 0,
  degradedReasons: [],
  error: null,
  ...input,
})
const snapshot = (input: Partial<GatewayStatus> = {}): MemoryStatusSnapshot => ({
  connected: true,
  status: status(input),
  receivedAt: now,
})

describe("MemoryStatus view", () => {
  test.each(["gemma4:26b-a4b-it-q4_K_M", "qwen3-coder:30b", "qwen3:8b"])(
    "Memory remains visible with agent %s and separate Qwen worker",
    (agentModel) => {
      const memory = { enabled: () => true, agentModel, workerModel: "qwen3:8b" }
      expect(memoryStatusEnabled(memory)).toBe(true)
      expect(statusView(snapshot(), now).key).toBe("memory.status.ready")
      expect(statusView({ connected: false, status: null, receivedAt: now }, now).key).toBe("memory.status.offline")
      expect(memoryStatusEnabled(memory)).toBe(true)
    },
  )
  test("agent switches, catalog refresh and temporary restart do not hide enabled Memory", () => {
    const memory = { enabled: () => true, agentModel: "gemma4:26b-a4b-it-q4_K_M", catalog: ["gemma", "coder"] }
    for (const agent of ["qwen3-coder:30b", "gemma4:26b-a4b-it-q4_K_M"]) {
      memory.agentModel = agent
      memory.catalog = []
      expect(memoryStatusEnabled(memory)).toBe(true)
      expect(statusView({ connected: false, status: null, receivedAt: now }, now).key).toBe("memory.status.offline")
      memory.catalog = ["gemma", "coder"]
      expect(memoryStatusEnabled(memory)).toBe(true)
      expect(statusView(snapshot(), now).key).toBe("memory.status.ready")
    }
  })
  test("footer opens and toggles the side panel without opening the full manager", () => {
    const state = { panel: false, manager: false }
    const memory = {
      enabled: () => true,
      panel: {
        toggle: () => {
          state.panel = nextMemoryPanelOpen(state.panel, "toggle")
        },
      },
      manager: {
        open: () => {
          state.manager = true
        },
      },
    }
    toggleMemoryPanel(memory)
    expect(state).toEqual({ panel: true, manager: false })
    toggleMemoryPanel(memory)
    expect(state).toEqual({ panel: false, manager: false })
  })
  test("side panel opens the existing full manager on its explicit action", () => {
    const calls: string[] = []
    const memory = {
      enabled: () => true,
      panel: { toggle: () => calls.push("panel") },
      manager: { open: () => calls.push("manager") },
    }
    toggleMemoryPanel(memory)
    expect(calls).toEqual(["panel"])
    openMemoryManager(memory)
    expect(calls).toEqual(["panel", "manager"])
  })
  test("Settings opens the full manager directly, with Settings dismissed first", () => {
    const calls: string[] = []
    const memory = {
      enabled: () => true,
      panel: { toggle: () => calls.push("unexpected-panel") },
      manager: { open: () => calls.push("manager") },
    }
    openMemoryManager(memory, () => calls.push("settings-close"))
    expect(calls).toEqual(["settings-close", "manager"])
    openMemoryManager({ ...memory, enabled: () => false }, () => calls.push("unexpected"))
    expect(calls).toHaveLength(2)
  })
  test("Gemma to Qwen3-Coder switch preserves footer side-panel navigation", () => {
    const calls: string[] = []
    const memory = {
      enabled: () => true,
      agent: "gemma4:26b-a4b-it-q4_K_M",
      panel: { toggle: () => calls.push("panel") },
      manager: { open: () => calls.push("unexpected-manager") },
    }
    toggleMemoryPanel(memory)
    memory.agent = "qwen3-coder:30b"
    toggleMemoryPanel(memory)
    expect(calls).toEqual(["panel", "panel"])
  })
  test("disabled Memory cannot open the panel", () => {
    let opened = false
    toggleMemoryPanel({
      enabled: () => false,
      panel: {
        toggle: () => {
          opened = true
        },
      },
    })
    toggleMemoryPanel()
    expect(opened).toBe(false)
  })
  test("Memory queue transitions ready to analyzing to idle", () => {
    expect([
      statusView(snapshot(), now).key,
      statusView(snapshot({ state: "MEMORY_ANALYZING", phase: "MEMORY_ANALYZING", queueLength: 2 }), now).key,
      statusView(snapshot(), now).key,
    ]).toEqual(["memory.status.ready", "memory.status.analyzing", "memory.status.ready"])
  })
  test("stays hidden without an enabled desktop integration", () => {
    expect(memoryStatusEnabled()).toBe(false)
    expect(memoryStatusEnabled({ enabled: () => false })).toBe(false)
    expect(memoryStatusEnabled({ enabled: () => true })).toBe(true)
  })
  test("maps idle, running, taxonomy, consolidation and unknown active states", () => {
    expect(statusView(snapshot(), now).key).toBe("memory.status.ready")
    expect(
      statusView(
        snapshot({ state: "MEMORY_ANALYZING", phase: "MEMORY_ANALYZING", startedAt: "2026-09-28T12:00:00Z" }),
        now,
      ),
    ).toMatchObject({ key: "memory.status.analyzing", elapsed: "12s" })
    expect(statusView(snapshot({ state: "TAXONOMY_RUNNING", phase: "TAXONOMY_RUNNING" }), now).key).toBe(
      "memory.status.taxonomy",
    )
    expect(statusView(snapshot({ state: "CONSOLIDATION_RUNNING", phase: "CONSOLIDATION_RUNNING" }), now).key).toBe(
      "memory.status.consolidating",
    )
    expect(statusView(snapshot({ state: "FUTURE_RUNNING", phase: "FUTURE_RUNNING" }), now).key).toBe(
      "memory.status.working",
    )
  })

  test("reflects queue, error, degraded and offline without fabricated progress", () => {
    expect(statusView(snapshot({ queueLength: 2 }), now)).toMatchObject({ key: "memory.status.queued", queue: 2 })
    expect(statusView(snapshot({ error: "failure" }), now).key).toBe("memory.status.error")
    expect(statusView(snapshot({ degradedReasons: ["model unavailable"] }), now).key).toBe("memory.status.degraded")
    expect(statusView({ connected: false, status: null, receivedAt: now }, now).key).toBe("memory.status.offline")
    expect(
      Object.keys(statusView(snapshot({ state: "MEMORY_ANALYZING", phase: "MEMORY_ANALYZING" }), now)),
    ).not.toContain("percentage")
  })

  test("advances elapsed locally and never shows idle elapsed", () => {
    const running = snapshot({ phase: "MEMORY_WRITING", state: "MEMORY_WRITING", elapsedMs: 65_000, startedAt: null })
    expect(statusView(running, now + 7_000).elapsed).toBe("1m 12s")
    expect(statusView(snapshot({ elapsedMs: 65_000 }), now + 7_000).elapsed).toBe("")
  })
})
