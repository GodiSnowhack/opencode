import { afterEach, describe, expect, test } from "bun:test"
import type { GatewayStatus, MemoryStatusSnapshot } from "@opencode-ai/core/memory/status"
import { createMemoryStatusClient, MemoryStatusClient } from "./memory-status"

const idle: GatewayStatus = {
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
}
const waitFor = async (condition: () => boolean) => {
  for (let attempt = 0; attempt < 150; attempt++) {
    if (condition()) return
    await Bun.sleep(20)
  }
  throw new Error("Timed out waiting for memory status")
}
const requestURL = (input: RequestInfo | URL) =>
  typeof input === "string" ? input : input instanceof URL ? input.href : input.url

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

describe("Desktop MemoryStatus client", () => {
  test("disabled and cloud configurations create no client or requests", () => {
    process.env.OPENCODE_MEMORY_INTEGRATION = "false"
    process.env.OPENCODE_MEMORY_GATEWAY_URL = "http://127.0.0.1:11435/v1"
    expect(createMemoryStatusClient()).toBeUndefined()
    process.env.OPENCODE_MEMORY_INTEGRATION = "true"
    process.env.OPENCODE_MEMORY_GATEWAY_URL = "https://api.openai.com/v1"
    expect(createMemoryStatusClient()).toBeUndefined()
    process.env.OPENCODE_MEMORY_GATEWAY_URL = "http://remote.example/v1"
    expect(createMemoryStatusClient()).toBeUndefined()
  })

  test("fetches initial status, reads actual SSE frames, shares one stream and cleans up", async () => {
    const requests: string[] = []
    let stream!: ReadableStreamDefaultController<Uint8Array>
    let aborted = false
    const request = (async (input: RequestInfo | URL, init?: RequestInit) => {
      requests.push(requestURL(input))
      if (requestURL(input).endsWith("/memory/status")) return Response.json(idle)
      init?.signal?.addEventListener("abort", () => {
        aborted = true
      })
      return new Response(
        new ReadableStream<Uint8Array>({
          start(controller) {
            stream = controller
          },
        }),
        { headers: { "content-type": "text/event-stream" } },
      )
    }) as typeof fetch
    const client = new MemoryStatusClient("http://127.0.0.1:11435", request)
    const seen: MemoryStatusSnapshot[] = []
    const first = client.subscribe((value) => seen.push(value))
    const second = client.subscribe(() => undefined)
    await waitFor(() => requests.length === 2 && seen.some((value) => value.connected))
    stream.enqueue(
      new TextEncoder().encode(
        `: keepalive\n\nevent: memory.status\ndata: ${JSON.stringify({ ...idle, state: "MEMORY_ANALYZING", phase: "MEMORY_ANALYZING" })}\n\n`,
      ),
    )
    await waitFor(() => seen.some((value) => value.status?.phase === "MEMORY_ANALYZING"))
    expect(requests).toEqual(["http://127.0.0.1:11435/memory/status", "http://127.0.0.1:11435/memory/events"])
    first()
    expect(aborted).toBe(false)
    second()
    await waitFor(() => aborted)
    await Bun.sleep(50)
    expect(requests).toHaveLength(2)
  })

  test("shows offline and refreshes status after bounded reconnect", async () => {
    let calls = 0
    const request = (async (input: RequestInfo | URL) => {
      calls++
      if (calls === 1) throw new Error("Gateway stopped")
      if (requestURL(input).endsWith("/memory/status")) return Response.json(idle)
      return new Response(new ReadableStream<Uint8Array>({ start() {} }), {
        headers: { "content-type": "text/event-stream" },
      })
    }) as typeof fetch
    const client = new MemoryStatusClient("http://localhost:11435", request)
    const seen: MemoryStatusSnapshot[] = []
    const stop = client.subscribe((value) => seen.push(value))
    try {
      await waitFor(() => calls === 1)
      expect(seen.at(-1)?.connected).toBe(false)
      await waitFor(() => seen.some((value) => value.connected && value.status?.state === "IDLE"))
      expect(calls).toBeGreaterThanOrEqual(3)
    } finally {
      stop()
    }
  })

  test("refreshes after an established SSE stream closes and cancels retry on cleanup", async () => {
    let calls = 0
    let stream!: ReadableStreamDefaultController<Uint8Array>
    const request = (async (input: RequestInfo | URL) => {
      calls++
      if (requestURL(input).endsWith("/memory/status")) return Response.json(idle)
      return new Response(
        new ReadableStream<Uint8Array>({
          start(controller) {
            stream = controller
          },
        }),
        { headers: { "content-type": "text/event-stream" } },
      )
    }) as typeof fetch
    const client = new MemoryStatusClient("http://127.0.0.1:11435", request)
    const seen: MemoryStatusSnapshot[] = []
    const stop = client.subscribe((value) => seen.push(value))
    await waitFor(() => calls === 2)
    const lastUpdate = seen.at(-1)?.receivedAt
    stream.close()
    await waitFor(() => seen.at(-1)?.connected === false)
    expect(seen.at(-1)?.receivedAt).toBe(lastUpdate)
    expect(seen.at(-1)?.status?.state).toBe("IDLE")
    await waitFor(() => calls === 4 && seen.at(-1)?.connected === true)
    stop()
    await Bun.sleep(50)
    expect(calls).toBe(4)

    let failed = 0
    const unavailable = new MemoryStatusClient("http://127.0.0.1:11435", (async () => {
      failed++
      throw new Error("offline")
    }) as typeof fetch)
    const cancel = unavailable.subscribe(() => undefined)
    await waitFor(() => failed === 1)
    cancel()
    await Bun.sleep(1_100)
    expect(failed).toBe(1)
  })

  test("rapid unsubscribe and resubscribe keeps the new stream alive", async () => {
    let calls = 0
    const request = (async (input: RequestInfo | URL) => {
      calls++
      if (requestURL(input).endsWith("/memory/status")) return Response.json(idle)
      return new Response(new ReadableStream<Uint8Array>({ start() {} }), {
        headers: { "content-type": "text/event-stream" },
      })
    }) as typeof fetch
    const client = new MemoryStatusClient("http://127.0.0.1:11435", request)
    const first = client.subscribe(() => undefined)
    await waitFor(() => calls === 2)
    first()
    const seen: MemoryStatusSnapshot[] = []
    const second = client.subscribe((value) => seen.push(value))
    try {
      await waitFor(() => calls === 4 && seen.some((value) => value.connected))
      await Bun.sleep(50)
      expect(calls).toBe(4)
      expect(seen.at(-1)?.connected).toBe(true)
    } finally {
      second()
    }
  })

  test("manual refresh performs one GET without opening a second event stream", async () => {
    const requests: string[] = []
    const request = (async (input: RequestInfo | URL) => {
      requests.push(requestURL(input))
      if (requestURL(input).endsWith("/memory/status")) return Response.json(idle)
      return new Response(new ReadableStream<Uint8Array>({ start() {} }), {
        headers: { "content-type": "text/event-stream" },
      })
    }) as typeof fetch
    const client = new MemoryStatusClient("http://127.0.0.1:11435", request)
    const stop = client.subscribe(() => undefined)
    try {
      await waitFor(() => requests.length === 2)
      await client.refreshStatus()
      expect(requests.filter((value) => value.endsWith("/memory/status"))).toHaveLength(2)
      expect(requests.filter((value) => value.endsWith("/memory/events"))).toHaveLength(1)
    } finally {
      stop()
    }
  })

  test("manual reconnect replaces the stream instead of running in parallel", async () => {
    let activeStreams = 0
    let maximumStreams = 0
    let eventRequests = 0
    const request = (async (input: RequestInfo | URL, init?: RequestInit) => {
      if (requestURL(input).endsWith("/memory/status")) return Response.json(idle)
      eventRequests++
      return new Response(
        new ReadableStream<Uint8Array>({
          start(controller) {
            activeStreams++
            maximumStreams = Math.max(maximumStreams, activeStreams)
            init?.signal?.addEventListener(
              "abort",
              () => {
                activeStreams--
                controller.error(new DOMException("Aborted", "AbortError"))
              },
              { once: true },
            )
          },
        }),
        { headers: { "content-type": "text/event-stream" } },
      )
    }) as typeof fetch
    const client = new MemoryStatusClient("http://127.0.0.1:11435", request)
    const stop = client.subscribe(() => undefined)
    try {
      await waitFor(() => eventRequests === 1)
      client.reconnect()
      await waitFor(() => eventRequests === 2)
      expect(maximumStreams).toBe(1)
      expect(activeStreams).toBe(1)
    } finally {
      stop()
    }
  })
})
