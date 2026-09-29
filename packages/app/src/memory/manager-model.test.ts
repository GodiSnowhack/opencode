import { describe, expect, test } from "bun:test"
import { MemoryGateway } from "@opencode-ai/core/memory/gateway"
import type { ManagedMemory } from "@opencode-ai/core/memory/management-types"
import { compatibleMemory, memoryManagerQuery, memoryManagerScope } from "./manager-model"

const memory = (input: Partial<ManagedMemory> = {}): ManagedMemory => ({
  id: "one",
  scope: "project",
  projectId: "local-project",
  type: "project_decision",
  status: "active",
  summary: "Store config in SQLite",
  details: "",
  importance: 0.8,
  confidence: 0.9,
  createdAt: "2026-09-29T00:00:00Z",
  updatedAt: "2026-09-29T00:00:00Z",
  supersededBy: null,
  taxonomy: [],
  ...input,
})

describe("Memory Manager state", () => {
  test("selects global, canonical current project, and explicit project without rehashing", () => {
    const canonical = MemoryGateway.effectiveProjectID({
      projectID: "global",
      projectRoot: "",
      directory: "C:\\yes\\OpenCode_Sessions",
    })!
    expect(memoryManagerScope("global", canonical)).toEqual({ scope: "global", projectId: undefined })
    expect(memoryManagerScope("current", canonical)).toEqual({ scope: "project", projectId: canonical })
    expect(memoryManagerScope("all", canonical, "other-project")).toEqual({
      scope: "project",
      projectId: "other-project",
    })
    expect(memoryManagerScope("current")).toBeUndefined()
    expect(memoryManagerScope("all", canonical)).toBeUndefined()
  })

  test("builds backend query with search, filters, fixed page size, and cursor", () => {
    expect(
      memoryManagerQuery({
        mode: "global",
        status: "archived",
        type: "user_fact",
        search: "  logs  ",
        sort: "importance",
        taxonomyNodeId: "node",
        cursor: "next",
      }),
    ).toEqual({
      scope: "global",
      projectId: undefined,
      status: "archived",
      type: "user_fact",
      search: "logs",
      sort: "importance",
      taxonomyNodeId: "node",
      cursor: "next",
      limit: 50,
    })
    expect(memoryManagerQuery({ mode: "all", status: "active", sort: "updated_at" })).toBeUndefined()
  })

  test("merge candidates must be active and match scope, project and canonical type", () => {
    expect(compatibleMemory(memory(), memory({ id: "two" }))).toBe(true)
    expect(compatibleMemory(memory(), memory())).toBe(false)
    expect(compatibleMemory(memory(), memory({ id: "two", projectId: "other" }))).toBe(false)
    expect(compatibleMemory(memory(), memory({ id: "two", scope: "global", projectId: null }))).toBe(false)
    expect(compatibleMemory(memory(), memory({ id: "two", type: "project_state" }))).toBe(false)
    expect(compatibleMemory(memory(), memory({ id: "two", status: "superseded" }))).toBe(false)
  })
})
