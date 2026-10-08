import assert from "node:assert/strict"
import { mkdir, writeFile, rm } from "node:fs/promises"
import { tmpdir } from "node:os"
import { join, resolve } from "node:path"
import { createServer } from "node:net"
import { createRequire } from "node:module"
import { randomUUID } from "node:crypto"
import http from "node:http"
import { DatabaseSync } from "node:sqlite"

const root = resolve(import.meta.dirname, "../../..")
const { _electron } = createRequire(resolve(root, "packages/app/package.json"))("@playwright/test")
const temporary = join(tmpdir(), `opencode-onboarding-${randomUUID()}`)
await mkdir(temporary)
const workspace = join(temporary, "workspace")
await mkdir(join(temporary, "desktop"))
await mkdir(workspace)
await writeFile(
  join(temporary, "desktop/opencode.settings"),
  JSON.stringify({ firstLaunchOnboardingComplete: true, oldLayoutEligible: false }),
)
await writeFile(
  join(temporary, "desktop/opencode.global.dat"),
  JSON.stringify({
    server: JSON.stringify({
      projects: { local: [{ worktree: workspace, expanded: true }] },
      lastProject: { local: workspace },
    }),
  }),
)
const socket = createServer()
await new Promise((done) => socket.listen(0, "127.0.0.1", done))
const port = socket.address().port
await new Promise((done) => socket.close(done))
await writeFile(
  join(temporary, "desktop/opencode.memory"),
  JSON.stringify({ settings: { enabled: true, agentTools: true, embeddings: false, port, contextLength: 16384 } }),
)
const output = resolve(root, "output/playwright/phase9f")
await mkdir(output, { recursive: true })
const wrapper = join(temporary, "desktop-smoke.cjs")
const desktopPath = resolve(root, "packages/desktop")
const mainPath = resolve(desktopPath, "out/main/index.js")
await writeFile(
  wrapper,
  `const {app}=require('electron');app.setAppPath(${JSON.stringify(desktopPath)});const append=app.commandLine.appendSwitch.bind(app.commandLine);app.commandLine.appendSwitch=(name,value)=>{if(name==='remote-debugging-port')return;append(name,value)};require(${JSON.stringify(mainPath)});`,
)
const desktop = await _electron.launch({
  executablePath: resolve(root, "packages/desktop/node_modules/electron/dist/electron.exe"),
  args: [wrapper],
  env: {
    ...process.env,
    OPENCODE_TEST_ONBOARDING: "1",
    OPENCODE_TEST_ONBOARDING_ROOT: temporary,
    OPENCODE_DISABLE_MODELS_FETCH: "true",
    MEMORY_WORKER_MESSAGE_THRESHOLD: "1000",
    MEMORY_IDLE_TRIGGER_SECONDS: "3600",
  },
  timeout: 120000,
})
const errors = []
let hits = 0
const local = http.createServer((_request, response) => {
  hits++
  response.setHeader("content-type", "application/json")
  response.end(JSON.stringify({ items: [{ name: "phase9f-gui" }], message: "User prefers Electron." }))
})
await new Promise((done) => local.listen(0, "127.0.0.1", done))
const apiPort = local.address().port
try {
  const page = await desktop.firstWindow()
  page.on("pageerror", (error) => errors.push(error.message))
  await page.waitForFunction(() => window.api?.memoryService, { timeout: 120000 })
  const deadline = Date.now() + 90000
  let status
  do {
    status = await page.evaluate(() => window.api.memoryService({ kind: "get" }))
    if (status.state === "running") break
    await page.waitForTimeout(500)
  } while (Date.now() < deadline)
  assert.equal(status.state, "running")
  assert((await fetch(`http://127.0.0.1:${port}/health`)).ok)
  console.log("PASS Desktop startup / owned Gateway healthy")
  await page
    .getByRole("button", { name: /^(Новая сессия|New session)$/u })
    .first()
    .click({ timeout: 120000 })
  const editor = page.locator('[data-component="prompt-input"][contenteditable="true"]')
  await editor.waitFor()
  await page.locator('[data-action="prompt-model"]').click()
  await page.locator('[data-option-key="memory-local:qwen3-coder:30b"]').click()
  await editor.fill(
    `Use http.request GET http://127.0.0.1:${apiPort}/api/items and report the actual JSON. This disposable API request is authorized. Do not call other tools or invent a result.`,
  )
  await editor.press("Enter")
  await page.getByRole("button", { name: /^(Allow once|Разрешить один раз)$/u }).click({ timeout: 600000 })
  const card = page.getByText("HTTP GET /api/items", { exact: true }).last()
  await card.waitFor({ timeout: 600000 })
  await page
    .getByText(/^200 · \d+ ms$/u)
    .last()
    .waitFor({ timeout: 600000 })
  assert.equal(hits, 1)
  const database = new DatabaseSync(join(temporary, "desktop/Memory/memory.db"), { readOnly: true })
  try {
    assert(
      Number(
        database
          .prepare("SELECT COUNT(*) AS count FROM messages WHERE role='tool' AND content_json LIKE '%phase9f-gui%'")
          .get().count,
      ) > 0,
    )
    assert.equal(
      Number(
        database
          .prepare(
            "SELECT COUNT(*) AS count FROM messages WHERE role='user' AND content_json LIKE '%User prefers Electron.%'",
          )
          .get().count,
      ),
      0,
    )
  } finally {
    database.close()
  }
  console.log("PASS composer / real HTTP permission / Node transport / card / tool provenance")
  for (const width of [360, 768, 1024, 1440]) {
    await page.setViewportSize({ width, height: 900 })
    await page.waitForTimeout(300)
    assert(
      await card
        .locator('xpath=ancestor::*[@data-component="tool-trigger"]')
        .evaluate((element) => element.scrollWidth <= element.clientWidth),
      `HTTP card overflow at ${width}`,
    )
    await page.screenshot({ path: join(output, `startup-${width}.png`) })
  }
  assert.equal(errors.length, 0, errors.join("\n"))
  console.log("PASS Desktop startup / owned Gateway healthy / 4 widths / no page errors")
} finally {
  local.closeAllConnections()
  await new Promise((done) => local.close(done))
  await desktop.close()
  const deadline = Date.now() + 15000
  while (
    Date.now() < deadline &&
    (await fetch(`http://127.0.0.1:${port}/health`)
      .then(() => true)
      .catch(() => false))
  )
    await new Promise((done) => setTimeout(done, 100))
  assert.equal(
    await fetch(`http://127.0.0.1:${port}/health`)
      .then(() => true)
      .catch(() => false),
    false,
    "Owned Gateway orphan",
  )
  await rm(temporary, { recursive: true, force: true, maxRetries: 10, retryDelay: 300 })
  console.log("PASS Desktop / Gateway cleanup")
}
