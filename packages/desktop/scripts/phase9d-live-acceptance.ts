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
const temporary = await mkdtemp(join(tmpdir(), "opencode-phase9d-live-"))
let workspace = join(temporary, "workspace")
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
        OPENCODE_AGENT_MAX_TOOL_CALLS: "24",
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
      calls.every((request) => request.project && request.project !== "global"),
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

async function git(...args: string[]) {
  const child = Bun.spawn(["git", ...args], { cwd: workspace, stdout: "pipe", stderr: "pipe" })
  const [output, error, code] = await Promise.all([
    new Response(child.stdout).text(),
    new Response(child.stderr).text(),
    child.exited,
  ])
  assert.equal(code, 0, error)
  return output.trim()
}
try {
  await service.detectOllama()
  assert.match((await service.start()).state, /^(running|degraded)$/u)
  const models = ["qwen3-coder:30b", "gemma4:26b-a4b-it-q4_K_M"].filter(
    (model) =>
      (!process.argv.includes("--coder-only") || model.startsWith("qwen")) &&
      (!process.argv.includes("--gemma-only") || model.startsWith("gemma")),
  )
  for (const model of models) {
    workspace = join(temporary, "workspace", model.startsWith("qwen") ? "qwen" : "gemma")
    assert(service.snapshot.ollama.models.includes(model), `Missing model ${model}`)
    assert(workspace.startsWith(temporary + "\\") || workspace.startsWith(temporary + "/"))
    await rm(workspace, { recursive: true, force: true })
    await mkdir(join(workspace, "src"), { recursive: true })
    await mkdir(join(workspace, "tests"))
    await git("init", "-b", "main")
    await git("config", "user.name", "Phase9D Acceptance")
    await git("config", "user.email", "phase9d@example.invalid")
    await git("config", "core.autocrlf", "false")
    await writeFile(join(workspace, "src/math.ts"), "export const add = (a: number, b: number) => a - b\n")
    await writeFile(
      join(workspace, "tests/math.test.ts"),
      "import {test,expect} from 'bun:test';import {add} from '../src/math';test('add',()=>expect(add(2,3)).toBe(5));",
    )
    await writeFile(
      join(workspace, "package.json"),
      JSON.stringify({ scripts: { "test:focused": "bun test tests/math.test.ts" } }),
    )
    await writeFile(join(workspace, "user-notes.txt"), "Original user notes\n")
    await git("add", "src/math.ts", "tests/math.test.ts", "package.json", "user-notes.txt")
    await git("commit", "-m", "initial")
    await writeFile(join(workspace, "user-notes.txt"), "User changes before agent task — do not commit\n")
    const initial = await git("rev-parse", "HEAD")
    const before = requests.length
    await run(
      model,
      "You are in a disposable Git repository with explicit permission to create one LOCAL commit for this task. Do NOT push or modify user-notes.txt. Use first-class tools: read src/math.ts and tests/math.test.ts; run test.run command bun run test:focused before editing; fix subtraction to addition using fs.edit; rerun that focused test and check exitCode=0. Use git.status and git.diff paths=[src/math.ts]; use the returned reviewId to git.stage ONLY src/math.ts. Then git.diff staged=true paths=[src/math.ts]; use THAT new reviewId to git.commit message=fix: correct addition. Never use shell git. Report real commit SHA. Do not touch other files. For V2 use underscore tool aliases.",
    )
    const head = await git("rev-parse", "HEAD")
    assert.notEqual(head, initial, "Model did not create a real commit")
    assert.equal(await git("show", "--format=", "--name-only", "HEAD"), "src/math.ts")
    assert.match(await readFile(join(workspace, "src/math.ts"), "utf8"), /a\s*\+\s*b/u)
    assert.match(await git("status", "--porcelain"), /(?:^|\n) ?M user-notes\.txt/u)
    assert.equal(
      await readFile(join(workspace, "user-notes.txt"), "utf8"),
      "User changes before agent task — do not commit\n",
    )
    assert(
      requests.slice(before).some((request) => request.tools.includes(v2 ? "git_commit" : "git.commit")),
      "Git executable schema missing",
    )
    console.log("PASS actual task-only Git commit / user changes preserved", model, v2 ? "V2" : "V1", head)
    await run(model, "Use git.stage and git.commit to commit user-notes.txt. You must call tools.", false)
    assert.equal(await git("rev-parse", "HEAD"), head)
    assert.match(await git("status", "--porcelain"), /(?:^|\n) ?M user-notes\.txt/u)
    console.log("PASS Tools OFF repository unchanged", model)
  }
  console.log("PHASE9D MODEL E2E PASS")
} finally {
  await service.stop()
  proxy.stop(true)
  await rm(temporary, { recursive: true, force: true })
  console.log("CLEANUP", temporary)
}
