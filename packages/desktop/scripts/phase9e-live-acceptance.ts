import assert from "node:assert/strict"
import { mkdtemp, mkdir, cp, writeFile, readFile, rm } from "node:fs/promises"
import { tmpdir } from "node:os"
import { join, resolve } from "node:path"
import { fileURLToPath } from "node:url"
import { createServer } from "node:net"
import { DatabaseSync } from "node:sqlite"
import { MemoryService } from "../src/main/memory-service"
import { createDesktopUsageStore } from "../src/main/usage-store"
import { defaultMemoryDesktopSettings } from "@opencode-ai/core/memory/desktop"
import type { UsageEvent } from "@opencode-ai/core/usage/types"

const root = resolve(process.env.PHASE9E_REPO ?? fileURLToPath(new URL("../../..", import.meta.url)))
const temporary = await mkdtemp(join(tmpdir(), "opencode-phase9e-live-"))
const workspace = join(temporary, "workspace")
await mkdir(workspace)
await mkdir(join(temporary, "profile"))
await cp(resolve(root, "../opencode-memory-system/dist/desktop-gateway"), join(temporary, "resources/memory-gateway"), {
  recursive: true,
})
await writeFile(join(workspace, "info.txt"), "TEST_MODE = usage-live\n")
const bundle = join(temporary, "resources/memory-gateway/gateway.mjs")
// Acceptance-only provider observation. Logs counts/timings, never generated content.
await writeFile(
  bundle,
  `const originalFetch=globalThis.fetch;globalThis.fetch=async(input,init)=>{const response=await originalFetch(input,init);const url=new URL(String(input));if(['/api/chat','/v1/chat/completions'].includes(url.pathname)&&init?.body&&response.ok){const selected=JSON.parse(String(init.body));void response.clone().text().then(text=>{const parts=url.pathname==='/api/chat'&&selected.stream?text.trim().split('\\n'):selected.stream?text.split('\\n').filter(x=>x.startsWith('data: {')).map(x=>x.slice(6)):[text];for(const part of parts){try{const value=JSON.parse(part);if(value.done||value.usage)console.error('PROVIDER_METRICS '+JSON.stringify({model:selected.model,input:value.prompt_eval_count??value.usage?.prompt_tokens??null,output:value.eval_count??value.usage?.completion_tokens??null,totalDuration:value.total_duration??null}));}catch{}}}).catch(()=>{});}return response};\n` +
    (await readFile(bundle, "utf8")),
)
const server = createServer()
await new Promise<void>((done) => server.listen(0, "127.0.0.1", done))
const address = server.address()
assert(address && typeof address !== "string")
const port = address.port
await new Promise<void>((done) => server.close(() => done()))
const originalThreshold = process.env.MEMORY_WORKER_MESSAGE_THRESHOLD
process.env.MEMORY_WORKER_MESSAGE_THRESHOLD = "1000"
process.env.MEMORY_IDLE_TRIGGER_SECONDS = "3600"
const settings = { ...defaultMemoryDesktopSettings, enabled: true, embeddings: false, port, contextLength: 8192 }
let usage = createDesktopUsageStore(join(temporary, "profile/usage.sqlite"))
const events: UsageEvent[] = []
const metrics: { model: string; input: number | null; output: number | null; totalDuration: number | null }[] = []
let diagnostic = ""
const service = new MemoryService({
  store: { get: () => settings, set: () => undefined },
  userData: join(temporary, "profile"),
  resources: join(temporary, "resources"),
  executable: resolve(root, "packages/desktop/node_modules/electron/dist/electron.exe"),
  onUsage(value) {
    if (usage.bestEffort(value)) events.push(value as UsageEvent)
  },
  onStderr(chunk) {
    diagnostic += chunk
    for (let end = diagnostic.indexOf("\n"); end >= 0; end = diagnostic.indexOf("\n")) {
      const line = diagnostic.slice(0, end)
      diagnostic = diagnostic.slice(end + 1)
      if (line.startsWith("PROVIDER_METRICS ")) metrics.push(JSON.parse(line.slice(17)))
      else if (/failed|unavailable/iu.test(line)) console.error(line)
    }
  },
})
const chat = async (
  model: string,
  session: string,
  text: string,
  kind = "user",
  extra: Record<string, unknown> = {},
) => {
  const response = await fetch(`http://127.0.0.1:${port}/v1/chat/completions`, {
    method: "POST",
    headers: {
      "content-type": "application/json",
      "x-memory-session-id": session,
      "x-memory-project-id": "phase9e-project",
      "x-memory-project-root": workspace,
      "x-memory-request-kind": kind,
    },
    body: JSON.stringify({
      model,
      stream: false,
      messages: [{ role: "user", content: text }],
      max_tokens: 256,
      temperature: 0,
      ...extra,
    }),
    signal: AbortSignal.timeout(600000),
  })
  assert(response.ok, `Chat HTTP ${response.status}`)
  return (await response.json()) as {
    choices: {
      message: { content?: string; tool_calls?: { id: string; function: { name: string; arguments: string } }[] }
    }[]
  }
}
try {
  await service.detectOllama()
  await service.start()
  assert.equal(service.snapshot.state, "running")
  await chat("qwen3-coder:30b", "usage-qwen", "Reply with exactly OK.")
  await chat("gemma4:26b-a4b-it-q4_K_M", "usage-gemma", "Запомни: отчеты проекта Phase 9E хранятся в папке usage-logs.")
  await chat("gemma4:26b-a4b-it-q4_K_M", "usage-gemma", "Give a three word session title.", "title")
  const tools = [
    {
      type: "function",
      function: {
        name: "fs_read",
        description: "Read a project file",
        parameters: {
          type: "object",
          properties: { path: { type: "string" } },
          required: ["path"],
          additionalProperties: false,
        },
      },
    },
  ]
  const text = "Call fs_read with path info.txt to read the exact TEST_MODE. Do not guess."
  const first = await chat("qwen3-coder:30b", "usage-tools", text, "user", { tools })
  const call = first.choices[0]?.message.tool_calls?.[0]
  assert(call && call.function.name === "fs_read", "Real tool call missing")
  assert.equal(JSON.parse(call.function.arguments).path, "info.txt")
  const content = await readFile(join(workspace, "info.txt"), "utf8")
  const continuation = await chat("qwen3-coder:30b", "usage-tools", text, "user", {
    tools,
    messages: [
      { role: "user", content: text },
      { role: "assistant", ...first.choices[0].message },
      { role: "tool", tool_call_id: call.id, name: "fs_read", content },
    ],
  })
  assert.match(continuation.choices[0]?.message.content ?? "", /usage-live/u)
  const deadline = Date.now() + 600000
  while (Date.now() < deadline) {
    const status = (await fetch(`http://127.0.0.1:${port}/memory/status`).then((response) => response.json())) as {
      state?: string
      queue?: { pending?: number }
    }
    if (events.some((event) => event.usage_kind === "memory") && status.state === "IDLE") break
    await new Promise((done) => setTimeout(done, 1000))
  }
  await new Promise((done) => setTimeout(done, 1000))
  assert(
    events.some((event) => event.usage_kind === "memory" && event.model === "qwen3:8b"),
    "Memory worker usage missing",
  )
  assert(
    events.some((event) => event.usage_kind === "service"),
    "Service usage missing",
  )
  const signature = (model: string, input: number | null, output: number | null) => `${model}|${input}|${output}`
  assert.deepEqual(
    events.map((event) => signature(event.model, event.input_tokens, event.output_tokens)).sort(),
    metrics.map((metric) => signature(metric.model, metric.input, metric.output)).sort(),
  )
  assert.equal(new Set(events.map((event) => event.request_id)).size, events.length)
  assert.equal(events.filter((event) => event.session_id === "usage-tools").length, 2)
  const snapshot = usage.get("all")
  assert.equal(
    snapshot.overview.total,
    metrics.reduce((sum, metric) => sum + (metric.input ?? 0) + (metric.output ?? 0), 0),
  )
  assert.equal(snapshot.overview.sessions, 3)
  const memory = new DatabaseSync(join(temporary, "profile/Memory/memory.db"), { readOnly: true })
  assert(
    Number(memory.prepare("SELECT count(*) count FROM memory_jobs WHERE status='completed'").get()?.count ?? 0) > 0,
    "Memory extraction job did not complete",
  )
  memory.close()
  console.log(
    "PASS real Qwen/Gemma/Memory/service/continuation",
    JSON.stringify({
      requests: snapshot.overview.requests,
      tokens: snapshot.overview.total,
      sessions: snapshot.overview.sessions,
      models: snapshot.models.map(({ model, kind, total }) => ({ model, kind, total })),
    }),
  )
  await service.stop()
  usage.close()
  usage = createDesktopUsageStore(join(temporary, "profile/usage.sqlite"))
  assert.equal(usage.get("all").overview.total, snapshot.overview.total)
  await service.start()
  assert.equal(service.snapshot.state, "running")
  await chat("qwen3-coder:30b", "usage-restart", "Reply with exactly OK.")
  await new Promise((done) => setTimeout(done, 1000))
  assert(usage.get("all").overview.total > snapshot.overview.total)
  console.log("PASS Gateway restart / SQLite reopen / model switch persistence")
} finally {
  await service.stop()
  usage.close()
  process.env.MEMORY_WORKER_MESSAGE_THRESHOLD = originalThreshold
  await rm(temporary, { recursive: true, force: true })
  console.log("CLEANUP", temporary)
}
