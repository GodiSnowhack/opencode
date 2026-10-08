import { test } from "node:test"
import assert from "node:assert/strict"
import { mkdtempSync, rmSync } from "node:fs"
import { join } from "node:path"
import { tmpdir } from "node:os"
import { DatabaseSync } from "node:sqlite"
import { createDesktopUsageStore, usageCalendar, validateUsage } from "./usage-store.ts"
import { createUsageReceiver } from "./usage-pipe.ts"
import type { UsageEvent } from "@opencode-ai/core/usage/types"

const timestamp = Date.parse("2026-10-08T19:01:00Z")
const event = (request_id: string, values: Partial<UsageEvent> = {}): UsageEvent => ({
  request_id,
  timestamp_utc: timestamp,
  provider: "ollama",
  model: "qwen3-coder:30b",
  usage_kind: "agent",
  input_tokens: 10,
  output_tokens: 20,
  duration_ms: 1200,
  load_duration_ms: 100,
  prompt_eval_duration_ms: 100,
  eval_duration_ms: 1000,
  session_id: "ses_a",
  project_id: "local-123",
  status: "success",
  ...values,
})
const make = () =>
  createDesktopUsageStore(
    ":memory:",
    () => timestamp,
    () => "Asia/Qyzylorda",
  )

test("inserts a stable inference once despite duplicate finals, retry delivery and changed duplicate values", () => {
  const store = make()
  try {
    assert.equal(store.record(event("request-1")), true)
    assert.equal(store.record(event("request-1")), false)
    assert.equal(store.record(event("request-1", { input_tokens: 100 })), false)
    const value = store.get("all").overview
    assert.deepEqual([value.total, value.requests, value.sessions, value.tokensPerSecond], [30, 1, 1, 20])
  } finally {
    store.close()
  }
})
test("classifies exact model tags and counts only unique agent sessions across continuations", () => {
  const store = make()
  try {
    store.record(event("one"))
    store.record(event("two"))
    store.record(event("three", { model: "gemma4:26b-a4b-it-q4_K_M", session_id: "ses_b", project_id: "local-456" }))
    store.record(event("four", { model: "qwen3:8b", usage_kind: "memory", session_id: "ses_worker" }))
    store.record(event("five", { usage_kind: "service", session_id: "ses_b" }))
    store.record(event("six", { model: "qwen3:8b-other", usage_kind: "memory", session_id: null }))
    const snapshot = store.get("all")
    const value = snapshot.overview
    assert.deepEqual(
      [
        value.total,
        value.input,
        value.output,
        value.requests,
        value.sessions,
        value.maximumSession,
        value.averageSession,
      ],
      [180, 60, 120, 6, 2, 60, 45],
    )
    assert.equal(snapshot.models.length, 5)
    assert.equal(
      snapshot.models.find((model) => model.kind === "agent" && model.model === "qwen3-coder:30b")?.requests,
      2,
    )
  } finally {
    store.close()
  }
})
test("calendar boundaries use inference timezone, record-day ties select later date, ranges include today", () => {
  const store = make()
  try {
    store.record(event("before", { timestamp_utc: Date.parse("2026-10-08T18:59:00Z") }))
    store.record(event("after"))
    store.record(event("old", { timestamp_utc: Date.parse("2026-09-01T00:00:00Z"), input_tokens: 1, output_tokens: 2 }))
    const snapshot = store.get(7)
    assert.equal(snapshot.today, "2026-10-09")
    assert.equal(snapshot.todayTokens, 30)
    assert.deepEqual({ ...snapshot.record }, { day: "2026-10-09", total: 30 })
    assert.deepEqual(
      snapshot.daily.map((item) => item.day),
      ["2026-10-08", "2026-10-09"],
    )
    assert.equal(store.get("all").daily.length, 3)
    assert.equal(usageCalendar(Date.parse("2026-03-08T06:59:00Z"), "America/New_York").offset, -300)
    assert.equal(usageCalendar(Date.parse("2026-03-08T07:01:00Z"), "America/New_York").offset, -240)
  } finally {
    store.close()
  }
})
test("failed and cancelled requests retain reported counts and distinguish unknown from zero", () => {
  const store = make()
  try {
    store.record(
      event("cancelled", { status: "cancelled", input_tokens: 5, output_tokens: null, eval_duration_ms: null }),
    )
    store.record(event("failed", { status: "failed", input_tokens: null, output_tokens: null, eval_duration_ms: null }))
    store.record(event("zero", { input_tokens: 0, output_tokens: 0, eval_duration_ms: 0 }))
    const value = store.get("all").overview
    assert.deepEqual([value.total, value.unknown, value.requests, value.tokensPerSecond], [5, 2, 3, null])
  } finally {
    store.close()
  }
})
test("timezone captured at inference start survives a later system timezone change", () => {
  const store = createDesktopUsageStore(
    ":memory:",
    () => timestamp,
    () => "America/New_York",
  )
  try {
    store.record(event("started-in-qyzylorda", { timezone: "Asia/Qyzylorda" }))
    assert.equal(store.get("all").daily[0].day, "2026-10-09")
    assert.throws(() => validateUsage(event("invalid", { timezone: "Invalid/Zone" })))
  } finally {
    store.close()
  }
})
test("clearing prevents delayed old final/retry delivery from resurrecting deleted statistics", () => {
  const store = make()
  try {
    store.record(event("old", { timestamp_utc: timestamp - 1000 }))
    store.clear(true)
    assert.equal(store.record(event("old", { timestamp_utc: timestamp - 1000 })), false)
    assert.equal(store.record(event("new", { timestamp_utc: timestamp + 1000 })), true)
    assert.equal(store.get("all").overview.requests, 1)
  } finally {
    store.close()
  }
})
test("fresh migration, reopen and two concurrent database connections preserve rows and unrelated data", async () => {
  const directory = mkdtempSync(join(tmpdir(), "usage-store-"))
  const filename = join(directory, "usage.sqlite")
  const old = new DatabaseSync(filename)
  old.exec("CREATE TABLE protected_memory(value TEXT); INSERT INTO protected_memory VALUES ('keep')")
  old.close()
  const first = createDesktopUsageStore(filename)
  const second = createDesktopUsageStore(filename)
  try {
    await Promise.all(
      Array.from({ length: 30 }, (_, index) =>
        Promise.resolve().then(() => (index % 2 ? first : second).record(event(`request-${index}`))),
      ),
    )
    assert.equal(first.get("all").overview.requests, 30)
    assert.equal(second.record(event("request-1")), false)
  } finally {
    first.close()
    second.close()
  }
  const reopened = createDesktopUsageStore(filename)
  try {
    assert.equal(reopened.get("all").overview.total, 900)
    assert.throws(() => reopened.clear(false), /usage_confirmation_required/)
    reopened.clear(true)
    assert.equal(reopened.get("all").overview.total, 0)
    assert.equal(reopened.get("all").daily.length, 0)
    reopened.record(event("new"))
    assert.equal(reopened.get("all").overview.requests, 1)
    const inspect = new DatabaseSync(filename)
    assert.equal(inspect.prepare("SELECT value FROM protected_memory").get()?.value, "keep")
    assert.equal(inspect.prepare("PRAGMA user_version").get()?.user_version, 1)
    assert.equal(
      inspect.prepare("SELECT status, local_day, timezone_offset FROM usage_requests").get()?.status,
      "success",
    )
    inspect.close()
  } finally {
    reopened.close()
    rmSync(directory, { recursive: true, force: true })
  }
})
test("metadata whitelist discards content and rejects fabricated or malformed counts", () => {
  assert.equal(
    "prompt" in validateUsage({ ...event("one"), prompt: "SECRET", response: "SECRET", tool: "SECRET" }),
    false,
  )
  assert.throws(() => validateUsage(event("one", { input_tokens: -1 })))
  assert.throws(() => validateUsage(event("one", { output_tokens: 1.5 })))
  assert.throws(() => validateUsage(event("one", { model: "C:\\Users\\secret" })))
  const store = make()
  store.close()
  assert.equal(store.bestEffort(event("one")), false)
})
test("pipe receiver handles split frames, duplicates, invalid and oversized input", () => {
  const store = make()
  const receive = createUsageReceiver((value) => store.bestEffort(value))
  const bytes = new TextEncoder().encode(JSON.stringify(event("one")) + "\n")
  try {
    receive(bytes.slice(0, 5))
    receive(bytes.slice(5))
    receive(bytes)
    receive(new TextEncoder().encode("invalid\n" + "x".repeat(17000)))
    receive(new TextEncoder().encode("\n" + JSON.stringify(event("two")) + "\n"))
    assert.equal(store.get("all").overview.requests, 2)
  } finally {
    store.close()
  }
})
