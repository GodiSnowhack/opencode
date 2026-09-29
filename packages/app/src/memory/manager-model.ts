import type {
  ManagedMemory,
  ManagementListQuery,
  MemoryScope,
  MemoryStatus,
  MemorySort,
} from "@opencode-ai/core/memory/management-types"

export type MemoryManagerMode = "global" | "current" | "all"

export function memoryManagerScope(mode: MemoryManagerMode, currentProjectID?: string, selectedProjectID?: string) {
  if (mode === "global") return { scope: "global" as MemoryScope, projectId: undefined }
  const projectId = mode === "current" ? currentProjectID : selectedProjectID
  return projectId ? { scope: "project" as MemoryScope, projectId } : undefined
}

export function memoryManagerQuery(input: {
  mode: MemoryManagerMode
  currentProjectID?: string
  selectedProjectID?: string
  status: MemoryStatus
  type?: string
  search?: string
  sort: MemorySort
  taxonomyNodeId?: string
  cursor?: string
}): ManagementListQuery | undefined {
  const scope = memoryManagerScope(input.mode, input.currentProjectID, input.selectedProjectID)
  if (!scope) return undefined
  return {
    ...scope,
    status: input.status,
    type: input.type || undefined,
    search: input.search?.trim() || undefined,
    sort: input.sort,
    taxonomyNodeId: input.taxonomyNodeId || undefined,
    cursor: input.cursor,
    limit: 50,
  }
}

export function compatibleMemory(first: ManagedMemory, second: ManagedMemory) {
  return (
    first.id !== second.id &&
    first.status === "active" &&
    second.status === "active" &&
    first.scope === second.scope &&
    first.projectId === second.projectId &&
    first.type === second.type
  )
}
