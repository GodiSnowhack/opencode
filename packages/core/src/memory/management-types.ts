export type MemoryScope = "global" | "project"
export type MemoryStatus = "active" | "provisional" | "superseded" | "archived" | "deleted"
export type MemorySort = "updated_at" | "created_at" | "importance"

export type MemoryTaxonomyPlacement = { id: string; level: string; name: string }
export type ManagedMemory = {
  id: string
  scope: MemoryScope
  projectId: string | null
  type: string
  status: MemoryStatus
  summary: string
  details: string
  importance: number
  confidence: number
  createdAt: string
  updatedAt: string
  supersededBy: string | null
  taxonomy: MemoryTaxonomyPlacement[]
}
export type MemoryManagementMetadata = {
  scopes: MemoryScope[]
  statuses: MemoryStatus[]
  types: Record<MemoryScope, string[]>
  editableFields: string[]
  taxonomyLevels: string[]
  maxTaxonomyDepth: number
  operations: string[]
}
export type ManagedProject = { projectId: string; name: string; memoryCount: number; lastActivity: string | null }
export type ManagedSource = {
  kind: string
  id: string
  sessionId: string | null
  projectId: string | null
  role: string
  timestamp: string
  excerpt: string
}
export type ManagedHistory = {
  versions: ManagedMemory[]
  audit: Array<{ id: string; memoryId: string; action: string; timestamp: string; details: unknown }>
}
export type ManagedTaxonomyNode = {
  id: string
  parentId: string | null
  level: string
  displayName: string
  status: string
  activeMemoryCount: number
}
export type ManagementListQuery = {
  scope: MemoryScope
  projectId?: string
  status?: MemoryStatus
  type?: string
  taxonomyNodeId?: string
  search?: string
  sort?: MemorySort
  limit?: number
  cursor?: string
}
export type ManagementContent = {
  scope: MemoryScope
  projectId: string | null
  type: string
  summary: string
  details: string
  importance: number
  confidence: number
}
export type ManagementEdit = Partial<
  Pick<ManagementContent, "type" | "summary" | "details" | "importance" | "confidence">
>
export type ManagementMerge = Pick<ManagementContent, "summary" | "details" | "importance" | "confidence"> & {
  firstId: string
  secondId: string
}

export type MemoryManagementAction =
  | { kind: "metadata" }
  | { kind: "projects" }
  | { kind: "list"; query: ManagementListQuery }
  | { kind: "get" | "sources" | "history" | "archive"; id: string }
  | { kind: "taxonomy"; scope: MemoryScope; projectId?: string }
  | { kind: "create"; input: ManagementContent }
  | { kind: "edit"; id: string; input: ManagementEdit }
  | { kind: "merge"; input: ManagementMerge }
  | { kind: "move"; id: string; nodeId: string }

export type MemoryManagementResult = {
  metadata: MemoryManagementMetadata
  projects: ManagedProject[]
  list: { items: ManagedMemory[]; nextCursor: string | null }
  get: ManagedMemory
  sources: ManagedSource[]
  history: ManagedHistory
  archive: ManagedMemory
  taxonomy: ManagedTaxonomyNode[]
  create: ManagedMemory
  edit: ManagedMemory
  merge: ManagedMemory
  move: ManagedMemory
}

export type MemoryManagementResponse =
  | { ok: true; value: MemoryManagementResult[keyof MemoryManagementResult] }
  | { ok: false; error: { code: string; status?: number } }
