import { describe, expect, test } from "bun:test"
import type { GatewayStatus, MemoryStatusSnapshot } from "@opencode-ai/core/memory/status"
import { MemoryGateway } from "@opencode-ai/core/memory/gateway"
import { memoryPanelView, nextMemoryPanelOpen, safeProjectLabel, shortMemoryID } from "./panel-view"

const now = Date.parse("2026-09-28T12:00:14Z")
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

describe("Memory Panel view", () => {
  test("opens, closes and toggles panel state", () => {
    expect(nextMemoryPanelOpen(false, "open")).toBe(true)
    expect(nextMemoryPanelOpen(true, "close")).toBe(false)
    expect(nextMemoryPanelOpen(false, "toggle")).toBe(true)
    expect(nextMemoryPanelOpen(true, "toggle")).toBe(false)
  })

  test("shows ready data and privacy-safe reactive identity", () => {
    const first = memoryPanelView(snapshot(), now, {
      sessionID: "ses_1234567890abcdef",
      project: {
        id: "project_1234567890abcdef",
        worktree: "C:\\Users\\person\\Desktop\\PET PROJECT\\opencode-custom",
      },
    })
    expect(first).toMatchObject({
      connected: true,
      statusKey: "memory.status.ready",
      phase: "IDLE",
      projectLabel: "opencode-custom",
      projectID: "",
      sessionID: "ses_1234…cdef",
    })
    expect(first.projectLabel).not.toContain("person")

    const switched = memoryPanelView(snapshot(), now, {
      sessionID: "ses_new",
      project: { id: "project_new", name: "New project" },
    })
    expect(switched).toMatchObject({ projectLabel: "New project", projectID: "", sessionID: "ses_new" })
  })

  test("shows active job, queue, elapsed and processed values", () => {
    expect(
      memoryPanelView(
        snapshot({
          state: "MEMORY_ANALYZING",
          phase: "MEMORY_ANALYZING",
          jobId: "job_1234567890abcdef",
          startedAt: "2026-09-28T12:00:00Z",
          queueLength: 2,
          queuedUserRequests: 1,
          processedItems: 8,
        }),
        now,
        {},
      ),
    ).toMatchObject({
      statusKey: "memory.status.analyzing",
      jobID: "job_1234…cdef",
      elapsed: "14s",
      queueLength: 2,
      queuedUserRequests: 1,
      processedItems: 8,
    })
  })

  test("keeps last update offline and exposes compact error and degraded reasons", () => {
    const stale: MemoryStatusSnapshot = {
      connected: false,
      status: status({ error: "Worker failed\nprivate stack", degradedReasons: ["embedding unavailable"] }),
      receivedAt: now,
    }
    expect(memoryPanelView(stale, now + 1_000, {})).toMatchObject({
      connected: false,
      statusKey: "memory.status.offline",
      error: "Worker failed",
      degradedReasons: ["embedding unavailable"],
      receivedAt: now,
    })
  })

  test("shortens ids and path labels without inventing identity", () => {
    expect(shortMemoryID("short")).toBe("short")
    expect(shortMemoryID(null)).toBe("")
    expect(safeProjectLabel({ directory: "/home/person/work/project" })).toBe("project")
    expect(safeProjectLabel({ project: { id: "project", name: "C:\\Users\\person\\project" } })).toBe("project")
    expect(
      safeProjectLabel({ project: { id: "global", name: "global" }, directory: "C:\\Users\\person\\workspace" }),
    ).toBe("workspace")
    expect(safeProjectLabel({ project: { id: "global" } })).toBe("")
    expect(safeProjectLabel({})).toBe("")
  })

  test("uses the exact Phase 1 identity for a non-Git directory", () => {
    const config = { enabled: true, gatewayURL: "http://127.0.0.1:11435/v1" }
    const endpoint = config.gatewayURL
    const global = {
      endpoint,
      sessionID: "ses-global",
      projectID: "global",
      projectRoot: "",
      directory: "C:\\Users\\person\\Desktop\\OpenCode_Sessions",
    }
    const globalID = MemoryGateway.effectiveProjectID(global)
    const globalView = memoryPanelView(snapshot(), now, {
      sessionID: global.sessionID,
      project: { id: global.projectID },
      directory: global.directory,
      effectiveProjectID: globalID,
    })
    expect(globalID).toMatch(/^local-[a-f0-9]{64}$/)
    expect(globalView.projectID).toBe(MemoryGateway.headers(global, config)["X-Memory-Project-Id"])
    expect(globalView.projectLabel).toBe("OpenCode_Sessions")
    expect(globalView.projectLabel).not.toContain("person")
  })

  test("keeps the existing Git project identity", () => {
    const config = { enabled: true, gatewayURL: "http://127.0.0.1:11435/v1" }
    const git = {
      endpoint: config.gatewayURL,
      sessionID: "ses-git",
      projectID: "project-git",
      projectRoot: "C:\\Projects\\git-repo",
      directory: "C:\\Projects\\git-repo\\src",
    }
    const gitID = MemoryGateway.effectiveProjectID(git)
    const gitView = memoryPanelView(snapshot(), now, {
      project: { id: git.projectID, worktree: git.projectRoot },
      directory: git.directory,
      effectiveProjectID: gitID,
    })
    expect(gitView.projectID).toBe("project-git")
    expect(gitView.projectID).toBe(MemoryGateway.headers(git, config)["X-Memory-Project-Id"])
    expect(gitView.projectLabel).toBe("git-repo")
  })
})
