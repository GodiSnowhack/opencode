import { MemoryGateway } from "@opencode-ai/core/memory/gateway"
import type {
  ManagementListQuery,
  MemoryManagementAction,
  MemoryManagementResult,
} from "@opencode-ai/core/memory/management-types"

export class MemoryManagementError extends Error {
  constructor(
    readonly code: string,
    readonly status?: number,
  ) {
    super(code)
  }
}

export class MemoryManagementClient {
  constructor(
    private readonly origin: string,
    private readonly request: typeof fetch = fetch,
  ) {}

  private async send<T>(method: string, path: string, body?: unknown): Promise<T> {
    const response = await this.request(new URL(path, this.origin), {
      method,
      redirect: "error",
      credentials: "omit",
      cache: "no-store",
      signal: AbortSignal.timeout(10_000),
      headers: { accept: "application/json", ...(body === undefined ? {} : { "content-type": "application/json" }) },
      ...(body === undefined ? {} : { body: JSON.stringify(body) }),
    }).catch(() => {
      throw new MemoryManagementError("offline")
    })
    const value = await response.json().catch(() => {
      throw new MemoryManagementError("invalid_response", response.status)
    })
    if (!response.ok) {
      const code =
        value && typeof value === "object" && "error" in value && typeof value.error?.code === "string"
          ? value.error.code
          : "request_failed"
      throw new MemoryManagementError(code, response.status)
    }
    return value as T
  }

  metadata() {
    return this.send<MemoryManagementResult["metadata"]>("GET", "/memory/manage/metadata")
  }
  projects() {
    return this.send<MemoryManagementResult["projects"]>("GET", "/memory/manage/projects")
  }
  list(query: ManagementListQuery) {
    const url = new URL("/memory/manage", this.origin)
    for (const key of [
      "scope",
      "projectId",
      "status",
      "type",
      "taxonomyNodeId",
      "search",
      "sort",
      "limit",
      "cursor",
    ] as const) {
      const value = query?.[key]
      if (value !== undefined && value !== null && typeof value !== "object") url.searchParams.set(key, String(value))
    }
    return this.send<MemoryManagementResult["list"]>("GET", url.pathname + url.search)
  }
  get(id: string) {
    return this.send<MemoryManagementResult["get"]>("GET", `/memory/manage/${encodeURIComponent(id)}`)
  }
  sources(id: string) {
    return this.send<MemoryManagementResult["sources"]>("GET", `/memory/manage/${encodeURIComponent(id)}/sources`)
  }
  history(id: string) {
    return this.send<MemoryManagementResult["history"]>("GET", `/memory/manage/${encodeURIComponent(id)}/history`)
  }
  taxonomy(scope: "global" | "project", projectId?: string) {
    const url = new URL("/memory/manage/taxonomy", this.origin)
    url.searchParams.set("scope", scope)
    if (projectId) url.searchParams.set("projectId", projectId)
    return this.send<MemoryManagementResult["taxonomy"]>("GET", url.pathname + url.search)
  }
  create(input: Extract<MemoryManagementAction, { kind: "create" }>["input"]) {
    return this.send<MemoryManagementResult["create"]>("POST", "/memory/manage", input)
  }
  edit(id: string, input: Extract<MemoryManagementAction, { kind: "edit" }>["input"]) {
    return this.send<MemoryManagementResult["edit"]>("PATCH", `/memory/manage/${encodeURIComponent(id)}`, input)
  }
  archive(id: string) {
    return this.send<MemoryManagementResult["archive"]>("DELETE", `/memory/manage/${encodeURIComponent(id)}`)
  }
  merge(input: Extract<MemoryManagementAction, { kind: "merge" }>["input"]) {
    return this.send<MemoryManagementResult["merge"]>("POST", "/memory/manage/merge", input)
  }
  move(id: string, nodeId: string) {
    return this.send<MemoryManagementResult["move"]>("POST", `/memory/manage/${encodeURIComponent(id)}/move`, {
      nodeId,
    })
  }

  execute(action: MemoryManagementAction) {
    if (!action || typeof action !== "object") throw new MemoryManagementError("invalid_request")
    switch (action.kind) {
      case "metadata":
        return this.metadata()
      case "projects":
        return this.projects()
      case "list":
        return this.list(action.query)
      case "get":
        return this.get(action.id)
      case "sources":
        return this.sources(action.id)
      case "history":
        return this.history(action.id)
      case "taxonomy":
        return this.taxonomy(action.scope, action.projectId)
      case "create":
        return this.create(action.input)
      case "edit":
        return this.edit(action.id, action.input)
      case "archive":
        return this.archive(action.id)
      case "merge":
        return this.merge(action.input)
      case "move":
        return this.move(action.id, action.nodeId)
    }
    throw new MemoryManagementError("invalid_request")
  }
}

export function createMemoryManagementClient(request?: typeof fetch) {
  const origin = MemoryGateway.statusOrigin()
  return origin ? new MemoryManagementClient(origin, request) : undefined
}
