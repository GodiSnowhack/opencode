import { createHash } from "node:crypto"
import { Effect } from "effect"

export type ToolLimitCode = "NOT_ALLOWED" | "RESULT_TOO_LARGE"
export const DEFAULT_MAX_TOOL_CALLS = 12
export const HARD_MAX_TOOL_CALLS = 24
export const TOOL_TIMEOUT_MS = 10_000
export const TOOL_TURN_TIME_MS = 60_000
export const TOOL_RESULT_BYTES = 16 * 1024
export const TOOL_TURN_RESULT_BYTES = 64 * 1024

export function executeBounded<A, E, R>(
  execution: Effect.Effect<A, E, R>,
  signal: AbortSignal | undefined,
  timeoutMs = TOOL_TIMEOUT_MS,
) {
  const cancelled = Effect.callback<never, "CANCELLED">((resume) => {
    const abort = () => resume(Effect.fail("CANCELLED"))
    signal?.addEventListener("abort", abort, { once: true })
    if (signal?.aborted) abort()
    return Effect.sync(() => signal?.removeEventListener("abort", abort))
  })
  return Effect.raceFirst(execution, cancelled).pipe(Effect.timeout(timeoutMs))
}

export function configuredMaxToolCalls(value: string | undefined) {
  const parsed = Number(value)
  return Number.isInteger(parsed) && parsed >= 1 && parsed <= HARD_MAX_TOOL_CALLS ? parsed : DEFAULT_MAX_TOOL_CALLS
}

function normalized(value: unknown): unknown {
  if (Array.isArray(value)) return value.map(normalized)
  if (value && typeof value === "object")
    return Object.fromEntries(
      Object.entries(value)
        .sort(([a], [b]) => a.localeCompare(b))
        .map(([key, item]) => [key, normalized(item)]),
    )
  return value
}

function preview(value: string, limit: number) {
  let bytes = 0
  let result = ""
  for (const char of value) {
    const size = Buffer.byteLength(char, "utf8")
    if (bytes + size > limit) break
    bytes += size
    result += char
  }
  return result
}

export class ToolTurnBudget {
  private calls = 0
  private elapsed = 0
  private bytes = 0
  private denied = 0
  private loopDenied = false
  private previous = new Map<string, { result: string; repeats: number }>()

  constructor(readonly maxCalls = DEFAULT_MAX_TOOL_CALLS) {
    if (!Number.isInteger(maxCalls) || maxCalls < 1 || maxCalls > HARD_MAX_TOOL_CALLS)
      throw new Error("invalid_max_tool_calls")
  }

  get available() {
    return this.calls < this.maxCalls && this.elapsed < TOOL_TURN_TIME_MS && this.denied < 2
  }

  get loopPrevented() {
    return this.loopDenied
  }

  begin(name: string, args: unknown): ToolLimitCode | undefined {
    this.loopDenied = false
    if (!this.available) {
      this.denied++
      return "NOT_ALLOWED"
    }
    const key = `${name}:${JSON.stringify(normalized(args))}`
    if ((this.previous.get(key)?.repeats ?? 0) >= 2) {
      this.denied++
      this.loopDenied = true
      return "NOT_ALLOWED"
    }
    this.calls++
    return undefined
  }

  finish(name: string, args: unknown, output: string, durationMs: number) {
    this.elapsed += durationMs
    const key = `${name}:${JSON.stringify(normalized(args))}`
    const digest = createHash("sha256").update(output).digest("hex")
    const old = this.previous.get(key)
    this.previous.set(key, { result: digest, repeats: old?.result === digest ? old.repeats + 1 : 1 })
    const originalBytes = Buffer.byteLength(output, "utf8")
    const remaining = Math.max(0, TOOL_TURN_RESULT_BYTES - this.bytes)
    const limit = Math.min(TOOL_RESULT_BYTES, remaining)
    if (limit === 0) return { output: '{"ok":false,"code":"RESULT_TOO_LARGE"}', truncated: true, originalBytes }
    this.bytes += Math.min(originalBytes, limit)
    if (originalBytes <= limit) return { output, truncated: false, originalBytes }
    return {
      output: JSON.stringify({
        ok: true,
        truncated: true,
        originalBytes,
        preview: preview(output, Math.max(0, limit - 128)),
      }),
      truncated: true,
      originalBytes,
    }
  }
}

const counts = {
  total: 0,
  success: 0,
  failed: 0,
  denied: 0,
  timeout: 0,
  cancelled: 0,
  loopPrevented: 0,
  resultTruncated: 0,
  durationMs: 0,
}
export function toolMetrics() {
  return {
    tool_calls_total: counts.total,
    tool_calls_success: counts.success,
    tool_calls_failed: counts.failed,
    tool_calls_denied: counts.denied,
    tool_calls_timeout: counts.timeout,
    tool_calls_cancelled: counts.cancelled,
    tool_loop_prevented: counts.loopPrevented,
    tool_result_truncated: counts.resultTruncated,
    tool_duration_ms: counts.durationMs,
  }
}
export function recordToolMetric(input: {
  status: "success" | "failed" | "denied" | "timeout" | "cancelled"
  durationMs: number
  loopPrevented?: boolean
  truncated?: boolean
}) {
  counts.total++
  counts[input.status]++
  counts.durationMs += input.durationMs
  if (input.loopPrevented) counts.loopPrevented++
  if (input.truncated) counts.resultTruncated++
}
