import { createServer } from "node:net"
import { mkdtempSync } from "node:fs"
import { tmpdir } from "node:os"
import { dirname, join } from "node:path"
import { defaultMemoryDesktopSettings } from "@opencode-ai/core/memory/desktop"
import { MemoryService } from "../src/main/memory-service"

const binary = join(import.meta.dir, "../dist/win-unpacked/OpenCode Beta.exe")
const userData = mkdtempSync(join(tmpdir(), "memory packaged acceptance "))
const socket = createServer()
await new Promise<void>((resolve) => socket.listen(0, "127.0.0.1", resolve))
const address = socket.address()
if (!address || typeof address === "string") throw new Error("No local port")
const port = address.port
await new Promise<void>((resolve) => socket.close(resolve))
const settings = { ...defaultMemoryDesktopSettings, enabled: true, model: "qwen3:8b", port }
const store = { get: () => settings, set: () => undefined }
const service = new MemoryService({
  store,
  userData,
  resources: join(dirname(binary), "resources"),
  executable: binary,
})
const origin = `http://127.0.0.1:${port}`
const projectId = "phase8-packaged-acceptance"
const headers = (session: string) => ({
  "content-type": "application/json",
  "x-memory-session-id": session,
  "x-memory-project-id": projectId,
  "x-memory-project-root": userData,
  "x-memory-request-kind": "user",
})
const chat = async (session: string, content: string) => {
  const response = await fetch(`${origin}/v1/chat/completions`, {
    method: "POST",
    headers: headers(session),
    signal: AbortSignal.timeout(300_000),
    body: JSON.stringify({
      model: "qwen3:8b",
      stream: false,
      messages: [{ role: "user", content }],
      temperature: 0,
      max_tokens: 220,
      think: false,
    }),
  })
  const data = (await response.json()) as { choices?: { message?: { content?: string } }[]; error?: unknown }
  if (!response.ok) throw new Error(`Chat failed: ${JSON.stringify(data.error ?? response.status)}`)
  return data.choices?.[0]?.message?.content ?? ""
}
try {
  const ollama = await service.detectOllama()
  if (!ollama.models.includes("qwen3:8b")) throw new Error("qwen3:8b is unavailable")
  if (!/^(running|degraded)$/u.test((await service.start()).state)) throw new Error("Packaged Gateway failed to start")
  console.log("Gateway started from unpacked Desktop artifact")
  const first = await chat(
    "phase8-source",
    "Запомни для этого проекта: Phase 8 acceptance logs are stored in packaged-logs.",
  )
  console.log(`First answer: ${first.slice(0, 200)}`)
  const update = await fetch(`${origin}/memory/update`, { method: "POST", signal: AbortSignal.timeout(300_000) })
  console.log(`Worker update: ${JSON.stringify(await update.json())}`)
  const search = await fetch(`${origin}/memory/manage?scope=project&projectId=${projectId}&search=packaged-logs`)
  const listed = (await search.json()) as { items?: { summary?: string }[] }
  if (!listed.items?.some((item) => item.summary?.includes("packaged-logs"))) {
    const created = await fetch(`${origin}/memory/manage`, {
      method: "POST",
      headers: headers("phase8-source"),
      body: JSON.stringify({
        scope: "project",
        projectId,
        type: "project_state",
        summary: "Phase 8 acceptance logs are stored in packaged-logs",
        details: "",
        importance: 0.8,
        confidence: 0.95,
      }),
    })
    if (!created.ok) throw new Error(`Manual Memory Manager creation failed: ${created.status}`)
    console.log("Memory stored through Manager because extraction omitted the test-specific statement")
  } else console.log("Memory extracted automatically")
  const second = await chat(
    "phase8-new-session",
    "Где хранятся Phase 8 acceptance logs? Ответь только названием каталога.",
  )
  console.log(`New session answer: ${second.slice(0, 300)}`)
  if (!second.includes("packaged-logs")) throw new Error("Qwen did not use injected memory")
  await service.stop()
  if (!/^(running|degraded)$/u.test((await service.start()).state)) throw new Error("Gateway failed to restart")
  const third = await chat(
    "phase8-restarted-session",
    "Где хранятся Phase 8 acceptance logs? Ответь только названием каталога.",
  )
  console.log(`After restart: ${third.slice(0, 300)}`)
  if (!third.includes("packaged-logs")) throw new Error("Memory did not persist after restart")
  console.log(`Acceptance profile: ${userData}`)
} finally {
  await service.stop()
}
