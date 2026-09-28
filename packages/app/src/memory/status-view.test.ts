import { describe, expect, test } from "bun:test"
import type { GatewayStatus, MemoryStatusSnapshot } from "@opencode-ai/core/memory/status"
import { memoryStatusEnabled, statusView } from "./status-view"

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
