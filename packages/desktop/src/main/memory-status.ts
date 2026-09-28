import { MemoryGateway } from "@opencode-ai/core/memory/gateway"
import { parseGatewayStatus, type MemoryStatusSnapshot } from "@opencode-ai/core/memory/status"

const backoff = [1_000, 2_000, 5_000, 10_000, 20_000, 30_000]

export class MemoryStatusClient {
  private readonly listeners = new Set<(value: MemoryStatusSnapshot) => void>()
  private snapshot: MemoryStatusSnapshot = { connected: false, status: null, receivedAt: 0 }
  private active = false
  private generation = 0
  private controller?: AbortController
  private retryTimer?: ReturnType<typeof setTimeout>
  private retryDone?: () => void

  constructor(
    private readonly origin: string,
    private readonly request: typeof fetch = fetch,
  ) {}

  subscribe(listener: (value: MemoryStatusSnapshot) => void): () => void {
    this.listeners.add(listener)
    listener(this.snapshot)
    if (!this.active) {
      this.active = true
      void this.run(++this.generation)
    }
    return () => {
      this.listeners.delete(listener)
      if (this.listeners.size === 0) this.stop()
    }
  }

  stop() {
    this.active = false
    this.generation++
    this.controller?.abort()
    if (this.retryTimer) clearTimeout(this.retryTimer)
    this.retryTimer = undefined
    this.retryDone?.()
    this.retryDone = undefined
    this.snapshot = { connected: false, status: null, receivedAt: 0 }
  }

  private publish(snapshot: MemoryStatusSnapshot) {
    if (!this.active) return
    this.snapshot = snapshot
    for (const listener of this.listeners) listener(snapshot)
  }

  private async run(generation: number) {
    let failures = 0
    while (this.active && this.generation === generation) {
      const controller = new AbortController()
      this.controller = controller
      try {
        await this.refresh(controller.signal)
        if (!this.active || this.generation !== generation) break
        failures = 0
        await this.events(controller.signal)
        if (this.active && this.generation === generation) throw new Error("Memory event stream ended")
      } catch {
        if (!this.active || this.generation !== generation) break
        this.publish({ connected: false, status: null, receivedAt: Date.now() })
      } finally {
        controller.abort()
        if (this.controller === controller) this.controller = undefined
      }
      if (!this.active || this.generation !== generation) break
      const delay = backoff[Math.min(failures++, backoff.length - 1)]
      await new Promise<void>((resolve) => {
        const done = () => {
          if (this.retryDone === done) {
            if (this.retryTimer) clearTimeout(this.retryTimer)
            this.retryDone = undefined
            this.retryTimer = undefined
          }
          resolve()
        }
        this.retryDone = done
        this.retryTimer = setTimeout(done, delay)
      })
    }
  }

  private async refresh(signal: AbortSignal) {
    const response = await this.request(new URL("/memory/status", this.origin), {
      signal: AbortSignal.any([signal, AbortSignal.timeout(5_000)]),
      redirect: "error",
      headers: { accept: "application/json" },
    })
    if (!response.ok) throw new Error("Memory status unavailable")
    const status = parseGatewayStatus(await response.json())
    if (!status) throw new Error("Invalid memory status")
    if (!signal.aborted) this.publish({ connected: true, status, receivedAt: Date.now() })
  }

  private async events(signal: AbortSignal) {
    const response = await this.request(new URL("/memory/events", this.origin), {
      signal,
      redirect: "error",
      headers: { accept: "text/event-stream" },
    })
    if (!response.ok || !response.body) throw new Error("Memory events unavailable")
    const reader = response.body.getReader()
    const decoder = new TextDecoder()
    let pending = ""
    try {
      while (this.active) {
        const { done, value } = await reader.read()
        if (done) break
        pending = (pending + decoder.decode(value, { stream: true })).replaceAll("\r\n", "\n")
        if (pending.length > 128_000) throw new Error("Memory event too large")
        let end: number
        while ((end = pending.indexOf("\n\n")) >= 0) {
          const frame = pending.slice(0, end)
          pending = pending.slice(end + 2)
          const event = frame.match(/^event: ?(.+)$/m)?.[1]
          if (event !== "memory.status") continue
          const data = frame
            .split("\n")
            .filter((line) => line.startsWith("data:"))
            .map((line) => line.slice(5).trimStart())
            .join("\n")
          try {
            const status = parseGatewayStatus(JSON.parse(data))
            if (status && !signal.aborted) this.publish({ connected: true, status, receivedAt: Date.now() })
          } catch {
            /* Ignore malformed events; the next status or reconnect refresh can recover. */
          }
        }
      }
    } finally {
      await reader.cancel().catch(() => undefined)
    }
  }
}

export function createMemoryStatusClient(request?: typeof fetch): MemoryStatusClient | undefined {
  const origin = MemoryGateway.statusOrigin()
  return origin ? new MemoryStatusClient(origin, request) : undefined
}
