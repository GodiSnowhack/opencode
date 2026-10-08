/** Content-free local inference metadata. Unavailable measurements remain null. */
export type UsageEvent = {
  request_id: string
  timestamp_utc: number
  timezone?: string
  provider: string
  model: string
  usage_kind: "agent" | "memory" | "service"
  input_tokens: number | null
  output_tokens: number | null
  duration_ms: number | null
  load_duration_ms: number | null
  prompt_eval_duration_ms: number | null
  eval_duration_ms: number | null
  session_id: string | null
  project_id: string | null
  status: "success" | "cancelled" | "failed"
}
export type UsageRange = 7 | 30 | 90 | "all"
export type UsageSnapshot = {
  collectedSince: number
  today: string
  overview: {
    input: number
    output: number
    total: number
    requests: number
    unknown: number
    sessions: number
    averageInput: number
    averageOutput: number
    averageSession: number
    maximumRequest: number
    maximumSession: number
    generationMs: number
    tokensPerSecond: number | null
  }
  todayTokens: number
  record: { day: string; total: number } | null
  daily: { day: string; total: number; requests: number }[]
  models: {
    provider: string
    model: string
    kind: UsageEvent["usage_kind"]
    input: number
    output: number
    total: number
    requests: number
    unknown: number
    tokensPerSecond: number | null
  }[]
}
export type UsagePlatform = {
  get(range: UsageRange): Promise<UsageSnapshot>
  clear(confirm: true): Promise<void>
}
