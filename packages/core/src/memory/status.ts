export type GatewayStatus = {
  type: "memory.status"
  state: string
  phase: string
  jobId: string | null
  startedAt: string | null
  elapsedMs: number
  queuedUserRequests: number
  queueLength: number
  processedItems: number
  degradedReasons: string[]
  error: string | null
}

export type MemoryStatusSnapshot = { connected: boolean; status: GatewayStatus | null; receivedAt: number }

export function parseGatewayStatus(value: unknown): GatewayStatus | undefined {
  if (!value || typeof value !== "object") return
  const input = value as Record<string, unknown>
  if (input.type !== "memory.status" || typeof input.state !== "string" || typeof input.phase !== "string") return
  if (
    typeof input.elapsedMs !== "number" ||
    typeof input.queueLength !== "number" ||
    typeof input.queuedUserRequests !== "number" ||
    typeof input.processedItems !== "number"
  )
    return
  if (!Array.isArray(input.degradedReasons) || !input.degradedReasons.every((reason) => typeof reason === "string"))
    return
  if (input.error !== null && typeof input.error !== "string") return
  if (input.startedAt !== null && typeof input.startedAt !== "string") return
  if (input.jobId !== null && typeof input.jobId !== "string") return
  return input as GatewayStatus
}
