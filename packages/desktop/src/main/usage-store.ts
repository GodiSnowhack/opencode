import { DatabaseSync } from "node:sqlite"
import type { UsageEvent, UsageRange, UsageSnapshot } from "@opencode-ai/core/usage/types"

export function usageCalendar(timestamp: number, timezone = Intl.DateTimeFormat().resolvedOptions().timeZone) {
  const fields = Object.fromEntries(
    new Intl.DateTimeFormat("en-CA", {
      timeZone: timezone,
      year: "numeric",
      month: "2-digit",
      day: "2-digit",
      hour: "2-digit",
      minute: "2-digit",
      second: "2-digit",
      hourCycle: "h23",
    })
      .formatToParts(timestamp)
      .map((part) => [part.type, part.value]),
  )
  const local = Date.UTC(+fields.year, +fields.month - 1, +fields.day, +fields.hour, +fields.minute, +fields.second)
  return {
    day: `${fields.year}-${fields.month}-${fields.day}`,
    timezone,
    offset: (local - Math.floor(timestamp / 1000) * 1000) / 60000,
  }
}

export function validateUsage(input: unknown): UsageEvent {
  if (!input || typeof input !== "object") throw new Error("invalid_usage")
  const value = input as Record<string, unknown>
  const label = (key: string, pattern: RegExp) => {
    const item = value[key]
    if (typeof item !== "string" || !pattern.test(item)) throw new Error("invalid_usage")
    return item
  }
  const numeric = (key: string, integer = false) => {
    const item = value[key]
    if (item === null) return null
    if (typeof item !== "number" || !Number.isFinite(item) || item < 0 || (integer && !Number.isSafeInteger(item)))
      throw new Error("invalid_usage")
    return item
  }
  const identity = (key: string) => (value[key] === null ? null : label(key, /^[a-zA-Z0-9_.:-]{1,200}$/u))
  const kind = value.usage_kind
  const status = value.status
  if (kind !== "agent" && kind !== "memory" && kind !== "service") throw new Error("invalid_usage")
  if (status !== "success" && status !== "failed" && status !== "cancelled") throw new Error("invalid_usage")
  const timestamp = numeric("timestamp_utc", true)
  if (timestamp === null || timestamp > 8640000000000000) throw new Error("invalid_usage")
  const timezone = value.timezone === undefined ? undefined : label("timezone", /^[A-Za-z0-9_+\-/]{1,100}$/u)
  if (timezone) new Intl.DateTimeFormat("en", { timeZone: timezone })
  const inputTokens = numeric("input_tokens", true)
  const outputTokens = numeric("output_tokens", true)
  if (!Number.isSafeInteger((inputTokens ?? 0) + (outputTokens ?? 0))) throw new Error("invalid_usage")
  return {
    request_id: label("request_id", /^[a-zA-Z0-9_.:-]{1,200}$/u),
    timestamp_utc: timestamp,
    ...(timezone ? { timezone } : {}),
    provider: label("provider", /^[a-zA-Z0-9_.:-]{1,100}$/u),
    model: label("model", /^[a-zA-Z0-9_.:/-]{1,200}$/u),
    usage_kind: kind,
    status,
    input_tokens: inputTokens,
    output_tokens: outputTokens,
    duration_ms: numeric("duration_ms"),
    load_duration_ms: numeric("load_duration_ms"),
    prompt_eval_duration_ms: numeric("prompt_eval_duration_ms"),
    eval_duration_ms: numeric("eval_duration_ms"),
    session_id: identity("session_id"),
    project_id: identity("project_id"),
  }
}

/** Separate database, same node:sqlite stack as Desktop drafts. */
export function createDesktopUsageStore(
  filename: string,
  clock = () => Date.now(),
  timezone = () => Intl.DateTimeFormat().resolvedOptions().timeZone,
) {
  const native = new DatabaseSync(filename)
  native.exec("PRAGMA journal_mode=WAL; PRAGMA synchronous=NORMAL; PRAGMA busy_timeout=5000;")
  const version = Number(native.prepare("PRAGMA user_version").get()?.user_version ?? 0)
  if (version > 1) {
    native.close()
    throw new Error("unsupported_usage_schema")
  }
  if (version === 0) {
    native.exec(`BEGIN IMMEDIATE;
      CREATE TABLE usage_requests (
        request_id TEXT PRIMARY KEY, timestamp_utc INTEGER NOT NULL, local_day TEXT NOT NULL,
        timezone TEXT NOT NULL, timezone_offset INTEGER NOT NULL, provider TEXT NOT NULL, model TEXT NOT NULL,
        usage_kind TEXT NOT NULL CHECK(usage_kind IN ('agent','memory','service')),
        input_tokens INTEGER, output_tokens INTEGER, total_tokens INTEGER,
        duration_ms REAL, load_duration_ms REAL, prompt_eval_duration_ms REAL, eval_duration_ms REAL,
        generation_tokens_per_second REAL, session_id TEXT, project_id TEXT,
        status TEXT NOT NULL CHECK(status IN ('success','cancelled','failed')));
      CREATE INDEX usage_day ON usage_requests(local_day);
      CREATE INDEX usage_model_kind ON usage_requests(provider,model,usage_kind);
      CREATE INDEX usage_session ON usage_requests(session_id) WHERE usage_kind='agent';
      CREATE TABLE usage_meta (key TEXT PRIMARY KEY,value INTEGER NOT NULL);
      PRAGMA user_version=1; COMMIT;`)
  }
  native.prepare("INSERT OR IGNORE INTO usage_meta VALUES ('collected_since', ?)").run(clock())
  const insert = native.prepare(
    `INSERT OR IGNORE INTO usage_requests VALUES (${Array.from({ length: 19 }, () => "?").join(",")})`,
  )
  const clearedAt = native.prepare("SELECT value FROM usage_meta WHERE key='cleared_at'")
  const record = (input: unknown) => {
    const event = validateUsage(input)
    const cutoff = clearedAt.get()?.value
    if (typeof cutoff === "number" && event.timestamp_utc <= cutoff) return false
    const calendar = usageCalendar(event.timestamp_utc, event.timezone ?? timezone())
    const total =
      event.input_tokens === null || event.output_tokens === null ? null : event.input_tokens + event.output_tokens
    const speed =
      event.output_tokens !== null && event.eval_duration_ms && event.eval_duration_ms > 0
        ? (event.output_tokens * 1000) / event.eval_duration_ms
        : null
    return (
      insert.run(
        event.request_id,
        event.timestamp_utc,
        calendar.day,
        calendar.timezone,
        calendar.offset,
        event.provider,
        event.model,
        event.usage_kind,
        event.input_tokens,
        event.output_tokens,
        total,
        event.duration_ms,
        event.load_duration_ms,
        event.prompt_eval_duration_ms,
        event.eval_duration_ms,
        speed,
        event.session_id,
        event.project_id,
        event.status,
      ).changes > 0
    )
  }
  return {
    record,
    bestEffort(input: unknown) {
      try {
        return record(input)
      } catch {
        console.error("Usage statistics write failed")
        return false
      }
    },
    get(range: UsageRange): UsageSnapshot {
      if (![7, 30, 90, "all"].includes(range)) throw new Error("invalid_usage_range")
      const today = usageCalendar(clock(), timezone()).day
      const beginning = new Date(`${today}T00:00:00Z`)
      if (range !== "all") beginning.setUTCDate(beginning.getUTCDate() - range + 1)
      const from = range === "all" ? "0000-00-00" : beginning.toISOString().slice(0, 10)
      const totals = native
        .prepare(
          `SELECT coalesce(sum(input_tokens),0) input, coalesce(sum(output_tokens),0) output,
        coalesce(avg(input_tokens),0) averageInput, coalesce(avg(output_tokens),0) averageOutput,
        coalesce(sum(coalesce(input_tokens,0)+coalesce(output_tokens,0)),0) total, count(*) requests,
        sum(CASE WHEN input_tokens IS NULL OR output_tokens IS NULL THEN 1 ELSE 0 END) unknown,
        max(coalesce(input_tokens,0)+coalesce(output_tokens,0)) maximumRequest,
        coalesce(sum(eval_duration_ms),0) generationMs,
        sum(CASE WHEN eval_duration_ms>0 THEN output_tokens ELSE 0 END)*1000.0/nullif(sum(CASE WHEN output_tokens IS NOT NULL AND eval_duration_ms>0 THEN eval_duration_ms ELSE 0 END),0) tokensPerSecond
        FROM usage_requests`,
        )
        .get()!
      const sessions = native
        .prepare(
          `SELECT count(*) sessions, coalesce(max(total),0) maximumSession, coalesce(avg(total),0) averageSession FROM (
        SELECT session_id, sum(coalesce(input_tokens,0)+coalesce(output_tokens,0)) total FROM usage_requests
        WHERE usage_kind='agent' AND session_id IS NOT NULL GROUP BY session_id)`,
        )
        .get()!
      const daily = native
        .prepare(
          `SELECT local_day day, sum(coalesce(input_tokens,0)+coalesce(output_tokens,0)) total, count(*) requests
        FROM usage_requests WHERE local_day>=? AND local_day<=? GROUP BY local_day ORDER BY local_day`,
        )
        .all(from, range === "all" ? "9999-12-31" : today) as UsageSnapshot["daily"]
      const recordDay = native
        .prepare(
          `SELECT local_day day, sum(coalesce(input_tokens,0)+coalesce(output_tokens,0)) total
        FROM usage_requests GROUP BY local_day ORDER BY total DESC, local_day DESC LIMIT 1`,
        )
        .get() as UsageSnapshot["record"] | undefined
      const models = native
        .prepare(
          `SELECT provider,model,usage_kind kind, coalesce(sum(input_tokens),0) input,coalesce(sum(output_tokens),0) output,
        sum(coalesce(input_tokens,0)+coalesce(output_tokens,0)) total, count(*) requests,
        sum(CASE WHEN input_tokens IS NULL OR output_tokens IS NULL THEN 1 ELSE 0 END) unknown,
        sum(CASE WHEN eval_duration_ms>0 THEN output_tokens ELSE 0 END)*1000.0/nullif(sum(CASE WHEN output_tokens IS NOT NULL AND eval_duration_ms>0 THEN eval_duration_ms ELSE 0 END),0) tokensPerSecond
        FROM usage_requests GROUP BY provider,model,usage_kind ORDER BY total DESC,provider,model,kind`,
        )
        .all() as UsageSnapshot["models"]
      return {
        collectedSince: Number(native.prepare("SELECT value FROM usage_meta WHERE key='collected_since'").get()!.value),
        today,
        overview: {
          input: Number(totals.input),
          output: Number(totals.output),
          total: Number(totals.total),
          requests: Number(totals.requests),
          unknown: Number(totals.unknown ?? 0),
          sessions: Number(sessions.sessions),
          averageInput: Number(totals.averageInput),
          averageOutput: Number(totals.averageOutput),
          averageSession: Number(sessions.averageSession),
          maximumSession: Number(sessions.maximumSession),
          maximumRequest: Number(totals.maximumRequest ?? 0),
          generationMs: Number(totals.generationMs),
          tokensPerSecond: totals.tokensPerSecond === null ? null : Number(totals.tokensPerSecond),
        },
        todayTokens: Number(
          native
            .prepare(
              "SELECT coalesce(sum(coalesce(input_tokens,0)+coalesce(output_tokens,0)),0) total FROM usage_requests WHERE local_day=?",
            )
            .get(today)!.total,
        ),
        record: recordDay ?? null,
        daily,
        models,
      }
    },
    clear(confirm: boolean) {
      if (confirm !== true) throw new Error("usage_confirmation_required")
      native.exec("BEGIN IMMEDIATE")
      try {
        native.exec("DELETE FROM usage_requests")
        native.prepare("UPDATE usage_meta SET value=? WHERE key='collected_since'").run(clock())
        native
          .prepare("INSERT INTO usage_meta VALUES ('cleared_at',?) ON CONFLICT(key) DO UPDATE SET value=excluded.value")
          .run(clock())
        native.exec("COMMIT")
      } catch (error) {
        native.exec("ROLLBACK")
        throw error
      }
    },
    close: () => native.close(),
  }
}
