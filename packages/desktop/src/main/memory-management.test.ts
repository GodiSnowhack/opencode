import { afterEach, describe, expect, test } from "bun:test"
import { createMemoryManagementClient, MemoryManagementClient, MemoryManagementError } from "./memory-management"

const previous = {
  enabled: process.env.OPENCODE_MEMORY_INTEGRATION,
  url: process.env.OPENCODE_MEMORY_GATEWAY_URL,
}
afterEach(() => {
  if (previous.enabled === undefined) delete process.env.OPENCODE_MEMORY_INTEGRATION
  else process.env.OPENCODE_MEMORY_INTEGRATION = previous.enabled
  if (previous.url === undefined) delete process.env.OPENCODE_MEMORY_GATEWAY_URL
  else process.env.OPENCODE_MEMORY_GATEWAY_URL = previous.url
})

describe("Desktop Memory Management client", () => {
  test("managed settings provide navigation before sidecar env, including a changed port", async () => {
    process.env.OPENCODE_MEMORY_INTEGRATION = "false"
    delete process.env.OPENCODE_MEMORY_GATEWAY_URL
    const urls: string[] = []
    const request = (async (input: RequestInfo | URL) => {
      urls.push(typeof input === "string" ? input : input instanceof URL ? input.href : input.url)
      return Response.json({ items: [] })
    }) as typeof fetch
    for (const port of [11435, 11436]) {
      const client = createMemoryManagementClient(request, { enabled: true, gatewayURL: `http://127.0.0.1:${port}/v1` })
      expect(client).toBeDefined()
      await client!.execute({ kind: "projects" })
    }
    expect(urls).toEqual([
      "http://127.0.0.1:11435/memory/manage/projects",
      "http://127.0.0.1:11436/memory/manage/projects",
    ])
    expect(createMemoryManagementClient(request, { enabled: false })).toBeUndefined()
    expect(
      createMemoryManagementClient(request, { enabled: true, gatewayURL: "http://remote.example/v1" }),
    ).toBeUndefined()
  })
  test("disabled and nonlocal endpoints create no client", () => {
    process.env.OPENCODE_MEMORY_INTEGRATION = "false"
    process.env.OPENCODE_MEMORY_GATEWAY_URL = "http://127.0.0.1:11435/v1"
    expect(createMemoryManagementClient()).toBeUndefined()
    process.env.OPENCODE_MEMORY_INTEGRATION = "true"
    process.env.OPENCODE_MEMORY_GATEWAY_URL = "https://api.openai.com/v1"
    expect(createMemoryManagementClient()).toBeUndefined()
    process.env.OPENCODE_MEMORY_GATEWAY_URL = "http://remote.example/v1"
    expect(createMemoryManagementClient()).toBeUndefined()
  })

  test("allows only fixed management paths and sends no credentials", async () => {
    const seen: Array<{ url: string; init?: RequestInit }> = []
    const request = (async (input: RequestInfo | URL, init?: RequestInit) => {
      seen.push({ url: String(input), init })
      return Response.json({ items: [], nextCursor: null })
    }) as typeof fetch
    const client = new MemoryManagementClient("http://127.0.0.1:11435", request)
    await client.execute({
      kind: "list",
      query: { scope: "project", projectId: "local-abc", status: "archived", search: "logs", limit: 50 },
    })
    await client.execute({ kind: "get", id: "00000000-0000-4000-8000-000000000000" })
    await client.execute({
      kind: "create",
      input: {
        scope: "global",
        projectId: null,
        type: "user_preference",
        summary: "Use local storage",
        details: "",
        importance: 0.7,
        confidence: 0.9,
      },
    })
    await client.execute({ kind: "move", id: "00000000-0000-4000-8000-000000000000", nodeId: "node-id" })
    expect(seen.map((item) => item.url)).toEqual([
      "http://127.0.0.1:11435/memory/manage?scope=project&projectId=local-abc&status=archived&search=logs&limit=50",
      "http://127.0.0.1:11435/memory/manage/00000000-0000-4000-8000-000000000000",
      "http://127.0.0.1:11435/memory/manage",
      "http://127.0.0.1:11435/memory/manage/00000000-0000-4000-8000-000000000000/move",
    ])
    expect(seen.every((item) => item.init?.credentials === "omit" && item.init?.redirect === "error")).toBe(true)
    expect(seen.every((item) => !JSON.stringify(item.init?.headers).toLowerCase().includes("authorization"))).toBe(true)
  })

  test("routes pagination, lazy detail requests, version edit, merge and archive through the local API", async () => {
    const seen: Array<{ method: string; url: string; body?: unknown }> = []
    const request = (async (input: RequestInfo | URL, init?: RequestInit) => {
      seen.push({
        method: init?.method ?? "GET",
        url: String(input),
        body: init?.body ? JSON.parse(String(init.body)) : undefined,
      })
      return Response.json({ items: [], nextCursor: "next-page" })
    }) as typeof fetch
    const client = new MemoryManagementClient("http://127.0.0.1:11435", request)
    const first = "11111111-1111-4111-8111-111111111111"
    const second = "22222222-2222-4222-8222-222222222222"
    const page = await client.list({
      scope: "project",
      projectId: "local-project",
      status: "active",
      type: "project_decision",
      taxonomyNodeId: "node-1",
      sort: "updated_at",
      limit: 50,
      cursor: "page-1",
    })
    expect(page.nextCursor).toBe("next-page")
    await client.sources(first)
    await client.history(first)
    await client.taxonomy("project", "local-project")
    await client.edit(first, { summary: "Updated test memory" })
    await client.merge({
      firstId: first,
      secondId: second,
      summary: "Merged test memory",
      details: "",
      importance: 0.7,
      confidence: 0.9,
    })
    await client.archive(first)
    expect(seen.map(({ method, url }) => `${method} ${url}`)).toEqual([
      "GET http://127.0.0.1:11435/memory/manage?scope=project&projectId=local-project&status=active&type=project_decision&taxonomyNodeId=node-1&sort=updated_at&limit=50&cursor=page-1",
      `GET http://127.0.0.1:11435/memory/manage/${first}/sources`,
      `GET http://127.0.0.1:11435/memory/manage/${first}/history`,
      "GET http://127.0.0.1:11435/memory/manage/taxonomy?scope=project&projectId=local-project",
      `PATCH http://127.0.0.1:11435/memory/manage/${first}`,
      "POST http://127.0.0.1:11435/memory/manage/merge",
      `DELETE http://127.0.0.1:11435/memory/manage/${first}`,
    ])
    expect(seen[4]?.body).toEqual({ summary: "Updated test memory" })
    expect(seen[5]?.body).toMatchObject({ firstId: first, secondId: second })
  })

  test("preserves backend error codes and reports offline without raw network details", async () => {
    const conflict = new MemoryManagementClient("http://127.0.0.1:11435", (async () =>
      Response.json(
        { error: { code: "cross_project_merge", message: "private backend details" } },
        { status: 409 },
      )) as typeof fetch)
    expect(
      conflict.merge({ firstId: "a", secondId: "b", summary: "merged", details: "", importance: 0.7, confidence: 0.9 }),
    ).rejects.toMatchObject({ code: "cross_project_merge", status: 409 })
    const offline = new MemoryManagementClient("http://127.0.0.1:11435", (async () => {
      throw new Error("private path and stack")
    }) as typeof fetch)
    expect(offline.projects()).rejects.toBeInstanceOf(MemoryManagementError)
    expect(offline.projects()).rejects.toMatchObject({ code: "offline" })
  })
})
