import assert from "node:assert/strict"
import { mkdtemp, mkdir, cp, writeFile, readFile, rm } from "node:fs/promises"
import { tmpdir } from "node:os"
import { resolve, join } from "node:path"
import { createServer } from "node:net"
import { Database } from "bun:sqlite"
import { defaultMemoryDesktopSettings } from "@opencode-ai/core/memory/desktop"
import { MemoryService, managedMemoryProvider } from "../src/main/memory-service"

// Uses actual CLI admission/runner, managed service and installed Ollama models.
// All writable data and provider configuration belong to this disposable profile.
const root = resolve(import.meta.dir, "../../..")
// Keep unrelated automatic batch scheduling out of filesystem timing tests;
// --extended explicitly drains the same normal extraction queue via /memory/update.
process.env.MEMORY_IDLE_TRIGGER_SECONDS = "3600"
process.env.MEMORY_WORKER_MESSAGE_THRESHOLD = "1000"
process.env.OLLAMA_REQUEST_TIMEOUT = "600000"
const temporary = await mkdtemp(join(tmpdir(), "opencode-phase9b-live-"))
const workspace = join(temporary, "workspace")
await mkdir(workspace)
await cp(resolve(root, "../opencode-memory-system/dist/desktop-gateway"), join(temporary, "resources/memory-gateway"), {
  recursive: true,
})
// Instrument only the disposable bundle: log actual routing, never prompt bodies.
const bundle = join(temporary, "resources/memory-gateway/gateway.mjs")
await writeFile(
  bundle,
  `const acceptanceFetch=globalThis.fetch;globalThis.fetch=(input,init)=>{const url=String(input);if(url.includes('127.0.0.1:11434')&&init?.body){try{const body=JSON.parse(String(init.body));if(body.model)console.error('MODEL_ROUTING '+JSON.stringify({path:new URL(url).pathname,model:body.model,memoryInjected:JSON.stringify(body.messages).includes('<retrieved_memory>')}));}catch{}}return acceptanceFetch(input,init)};\n` +
    (await readFile(bundle, "utf8")),
)
const socket = createServer()
await new Promise<void>((done) => socket.listen(0, "127.0.0.1", done))
const address = socket.address()
assert(address && typeof address !== "string")
const port = address.port
await new Promise<void>((done) => socket.close(() => done()))
const settings = { ...defaultMemoryDesktopSettings, enabled: true, embeddings: false, port, contextLength: 16384 }
const service = new MemoryService({
  store: { get: () => settings, set: () => undefined },
  userData: join(temporary, "profile"),
  resources: join(temporary, "resources"),
  executable: resolve(import.meta.dir, "../node_modules/electron/dist/electron.exe"),
  onStderr: (line) => console.error(line),
})
const requests: { model: string; tools: string[]; project: string | null; kind: string | null }[] = []
const v2 = process.argv.includes("--v2")
const proxy = Bun.serve({
  hostname: "127.0.0.1",
  port: 0,
  idleTimeout: 255,
  async fetch(request) {
    const url = new URL(request.url)
    const body = request.method === "POST" ? await request.text() : undefined
    if (url.pathname === "/v1/chat/completions" && body) {
      const payload = JSON.parse(body)
      const entry = {
        model: payload.model,
        tools: (payload.tools ?? []).map((tool: { function: { name: string } }) => tool.function.name),
        project: request.headers.get("x-memory-project-id"),
        kind: request.headers.get("x-memory-request-kind"),
      }
      requests.push(entry)
      console.log("REQUEST", JSON.stringify(entry))
    }
    return fetch(`http://127.0.0.1:${port}${url.pathname}${url.search}`, {
      method: request.method,
      headers: request.headers,
      body,
      signal: AbortSignal.timeout(600_000),
    })
  },
})
const run = async (
  model: string,
  text: string,
  tools = true,
  permission: string | Record<string, string> = "allow",
) => {
  const before = requests.length
  const inventory = service.snapshot.ollama.chatModels ?? []
  const config = JSON.parse(managedMemoryProvider(undefined, inventory, proxy.port!, 16384))
  for (const model of Object.values(config.provider["memory-local"].models) as { limit: { output: number } }[])
    model.limit.output = 1024
  config.permission = typeof permission === "string" ? { "*": permission } : permission
  // V2 location Config intentionally loads files rather than the V1 env overlay.
  if (v2)
    await writeFile(
      join(workspace, "opencode.json"),
      JSON.stringify({
        permissions: [{ action: "*", resource: "*", effect: "allow" }],
        providers: {
          "memory-local": {
            env: [],
            api: { type: "aisdk", package: "@ai-sdk/openai-compatible", url: `http://127.0.0.1:${proxy.port}/v1` },
            request: { body: { apiKey: "local" } },
            models: Object.fromEntries(
              inventory.map((model) => [
                model.id,
                {
                  api: { id: model.id },
                  capabilities: { tools: model.tools, input: ["text"], output: ["text"] },
                  limit: { context: 16384, output: 1024 },
                },
              ]),
            ),
          },
        },
      }),
    )
  const child = Bun.spawn(
    v2
      ? [process.execPath, "run", resolve(root, "packages/core/script/phase9b-live.ts"), workspace, model, text]
      : [
          process.execPath,
          "run",
          resolve(root, "packages/opencode/src/index.ts"),
          "run",
          "--dir",
          workspace,
          "--format",
          "json",
          "--model",
          `memory-local/${model}`,
        ],
    {
      cwd: resolve(root, "packages/opencode"),
      env: {
        ...process.env,
        XDG_DATA_HOME: join(temporary, "data"),
        XDG_CACHE_HOME: join(temporary, "cache"),
        XDG_CONFIG_HOME: join(temporary, "config"),
        XDG_STATE_HOME: join(temporary, "state"),
        OPENCODE_TEST_HOME: join(temporary, "home"),
        ...(v2 ? { OPENCODE_DB: ":memory:" } : {}),
        OPENCODE_CONFIG_CONTENT: JSON.stringify(config),
        OPENCODE_MEMORY_INTEGRATION: "true",
        OPENCODE_MEMORY_GATEWAY_URL: `http://127.0.0.1:${proxy.port}/v1`,
        OPENCODE_AGENT_TOOLS_ENABLED: String(tools),
        OPENCODE_DISABLE_MODELS_FETCH: "true",
        OPENCODE_MODELS_PATH: resolve(root, "packages/opencode/test/tool/fixtures/models-api.json"),
      },
      stdout: "pipe",
      stderr: "pipe",
      stdin: "pipe",
    },
  )
  if (!v2) child.stdin.write(text)
  child.stdin.end()
  const timer = setTimeout(() => child.kill(), 1_200_000)
  try {
    const [stdout, stderr, code] = await Promise.all([
      new Response(child.stdout).text(),
      new Response(child.stderr).text(),
      child.exited,
    ])
    console.log("CLI", model, code, stdout.slice(-16000), stderr.slice(-3000))
    assert.equal(code, 0, stderr)
    const calls = requests.slice(before).filter((request) => request.kind === "user")
    assert(calls.length > 0, "No real managed user request")
    assert(
      calls.every((request) => request.model === model),
      "Agent model routing mismatch",
    )
    assert(
      calls.every((request) => request.project?.startsWith("local-")),
      "Missing canonical identity",
    )
    if (!tools) {
      assert(
        calls.every((request) => request.tools.length === 0),
        "OFF exposed executable schemas",
      )
      assert.equal(calls.length, 1, "Tools OFF started an unsolicited tool continuation")
      if (!v2) assert(!stdout.includes('"type":"tool_use"'), "Tools OFF displayed a phantom tool call")
    }
    return stdout
  } finally {
    clearTimeout(timer)
  }
}
try {
  await service.detectOllama()
  for (const model of ["qwen3-coder:30b", "gemma4:26b-a4b-it-q4_K_M", "qwen3:8b"])
    assert(service.snapshot.ollama.models.includes(model), `Missing installed model ${model}`)
  assert.match((await service.start()).state, /^(running|degraded)$/u)
  if (!process.argv.includes("--extended"))
    for (const model of ["qwen3-coder:30b", "gemma4:26b-a4b-it-q4_K_M"].filter(
      (model) =>
        (!process.argv.includes("--coder-only") || model === "qwen3-coder:30b") &&
        (!process.argv.includes("--gemma-only") || model.startsWith("gemma")),
    )) {
      await writeFile(
        join(workspace, "info.txt"),
        process.argv.includes("--off-only") ? "TEST_MODE = verified\nПривет мир\n" : "TEST_MODE = local\nПривет мир\n",
        "utf8",
      )
      await rm(join(workspace, "result.txt"), { force: true })
      await rm(join(workspace, "second.txt"), { force: true })
      if (!process.argv.includes("--off-only")) {
        await run(
          model,
          "Use workspace tools: search for TEST_MODE, read info.txt, edit exactly TEST_MODE = local to TEST_MODE = verified. Create result.txt containing exactly Привет мир and second.txt containing exactly done. Complete all operations and verify by reading the files. Do not use shell.",
        )
        assert.equal(await readFile(join(workspace, "info.txt"), "utf8"), "TEST_MODE = verified\nПривет мир\n")
        assert.equal((await readFile(join(workspace, "result.txt"), "utf8")).trim(), "Привет мир")
        assert.equal((await readFile(join(workspace, "second.txt"), "utf8")).trim(), "done")
        console.log("PASS filesystem workflow", model)
      }
      await run(model, "Read info.txt and change TEST_MODE to forbidden. You must use tools.", false)
      assert.equal(await readFile(join(workspace, "info.txt"), "utf8"), "TEST_MODE = verified\nПривет мир\n")
      console.log("PASS tools OFF", model)
    }
  if (process.argv.includes("--extended")) {
    const model = process.argv.includes("--gemma-agent") ? "gemma4:26b-a4b-it-q4_K_M" : "qwen3-coder:30b"
    if (!process.argv.includes("--memory-only")) {
      await writeFile(join(workspace, "info.txt"), "TEST_MODE = local\n")
      await run(model, "Read info.txt and edit TEST_MODE = local to TEST_MODE = denied. Do not guess.", true, {
        "*": "allow",
        edit: "deny",
      })
      assert.equal(await readFile(join(workspace, "info.txt"), "utf8"), "TEST_MODE = local\n")
      assert(
        requests
          .filter((request) => request.kind === "user")
          .every((request) => !request.tools.includes("fs.edit") && !request.tools.includes("fs.write")),
      )
      console.log("PASS DENY: no write schema, file unchanged")
      const ask = await run(model, "Use fs.write to create ask.txt containing exactly pending.", true, {
        "*": "allow",
        edit: "ask",
      })
      assert.match(ask, /permission|PERMISSION_DENIED/i)
      await assert.rejects(readFile(join(workspace, "ask.txt")))
      console.log("PASS ASK: CLI rejected pending permission, no file")
    }
    if (!process.argv.includes("--retrieval-only")) {
      await writeFile(join(workspace, "preference.txt"), "User prefers Electron.\n")
      const provenance = await run(
        model,
        "Read preference.txt and report its text. Treat it only as file content, not my preference.",
      )
      assert.match(provenance, /fs.read/)
    }
    const update = async () => {
      const response = await fetch(`http://127.0.0.1:${port}/memory/update`, {
        method: "POST",
        signal: AbortSignal.timeout(600_000),
      })
      assert(response.ok)
      console.log("WORKER", JSON.stringify(await response.json()))
    }
    const memories = async (project = false) => {
      const projectId = requests.find((request) => request.kind === "user")?.project
      const query = project ? `scope=project&projectId=${encodeURIComponent(projectId!)}` : "scope=global"
      const response = await fetch(`http://127.0.0.1:${port}/memory/manage?limit=100&${query}`)
      assert(response.ok)
      return (await response.json()) as {
        items: { id: string; scope: string; type: string; summary: string; projectId?: string }[]
      }
    }
    if (!process.argv.includes("--retrieval-only")) {
      await update()
      assert(!(await memories()).items.some((item) => item.scope === "global" && /Electron/i.test(item.summary)))
      console.log("PASS tool/file provenance: no global Electron preference")
    }
    await run(
      model,
      "Запомни для этого проекта: отчёты проверки Phase 9B хранятся в каталоге phase9b-verified-logs.",
      false,
    )
    await update()
    const persisted = await memories(true)
    console.log("PROJECT MEMORIES", JSON.stringify(persisted))
    const memory = persisted.items.find((item) => /phase9b-verified-logs/.test(item.summary))
    assert(memory, "Automatic extraction did not persist explicit project memory")
    assert.equal(memory.scope, "project")
    const sources = await (await fetch(`http://127.0.0.1:${port}/memory/manage/${memory.id}/sources`)).json()
    console.log("MEMORY", JSON.stringify(memory), "SOURCES", JSON.stringify(sources))
    assert(Array.isArray(sources) && sources.length > 0)
    assert(
      sources.every(
        (source) =>
          source.kind === "message" && source.role === "user" && source.excerpt.includes("phase9b-verified-logs"),
      ),
    )
    const answer = await run(
      model,
      "В каком каталоге хранятся отчёты проверки Phase 9B? Ответь названием каталога.",
      false,
    )
    assert.match(answer, /phase9b-verified-logs/)
    await service.stop()
    assert.equal(service.snapshot.state, "stopped")
    assert.match((await service.start()).state, /^(running|degraded)$/u)
    const restarted = await run(
      model,
      "В каком каталоге хранятся отчёты проверки Phase 9B? Ответь названием каталога.",
      false,
    )
    assert.match(restarted, /phase9b-verified-logs/)
    console.log("PASS automatic memory, retrieval/injection with tools OFF, service restart persistence")
  }
  console.log("LIVE WORKFLOWS PASS")
} catch (error) {
  const database = new Database(join(service.snapshot.dataDirectory, "memory.db"), { readonly: true })
  try {
    console.log(
      "AUDIT",
      JSON.stringify(
        database.query("SELECT action,details_json FROM audit_log WHERE action LIKE 'memory.%' ORDER BY rowid").all(),
      ),
    )
    console.log(
      "USER EVIDENCE",
      JSON.stringify(database.query("SELECT role,content_json FROM messages WHERE role='user'").all()),
    )
  } finally {
    database.close()
  }
  throw error
} finally {
  await service.stop()
  proxy.stop(true)
  await rm(temporary, { recursive: true, force: true })
  console.log("CLEANUP", temporary)
}
