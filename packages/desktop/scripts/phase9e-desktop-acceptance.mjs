import assert from "node:assert/strict"
import { mkdir, writeFile, rm } from "node:fs/promises"
import { tmpdir } from "node:os"
import { join, resolve } from "node:path"
import { randomUUID } from "node:crypto"
import { createServer } from "node:net"
import { createRequire } from "node:module"

const root = resolve(import.meta.dirname, "../../..")
const { _electron } = createRequire(resolve(root, "packages/app/package.json"))("@playwright/test")
const temporary = join(tmpdir(), `opencode-onboarding-${randomUUID()}`)
await mkdir(join(temporary, "desktop"), { recursive: true })
const workspace = join(temporary, "workspace")
await mkdir(workspace)
await writeFile(join(workspace, "info.txt"), "Phase 9E disposable workspace\n")
await writeFile(
  join(temporary, "desktop/opencode.settings"),
  JSON.stringify({ firstLaunchOnboardingComplete: true, oldLayoutEligible: false }),
)
// Seed only project placement in the disposable profile, avoiding an unrelated native picker.
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
  JSON.stringify({ settings: { enabled: true, embeddings: false, port, contextLength: 8192 } }),
)
const screenshots = resolve(root, "output/playwright/phase9e")
await mkdir(screenshots, { recursive: true })
const errors = []
const launchOptions = {
  executablePath: resolve(root, "packages/desktop/node_modules/electron/dist/electron.exe"),
  args: [resolve(root, "packages/desktop")],
  env: {
    ...process.env,
    OPENCODE_TEST_ONBOARDING: "1",
    OPENCODE_TEST_ONBOARDING_ROOT: temporary,
    OPENCODE_DISABLE_MODELS_FETCH: "true",
    MEMORY_WORKER_MESSAGE_THRESHOLD: "1000",
    MEMORY_IDLE_TRIGGER_SECONDS: "3600",
  },
  timeout: 120000,
}
let desktop = await _electron.launch(launchOptions)
try {
  const page = await desktop.firstWindow()
  page.on("pageerror", (error) => errors.push(error.message))
  await page.waitForLoadState("domcontentloaded")
  await page.waitForFunction(() => window.api?.usage, { timeout: 120000 })
  await page.getByRole("button", { name: /^(Настройки|Settings)$/u }).click()
  await page.getByRole("tab", { name: "Local Profile / Usage" }).click({ timeout: 60000 })
  await page.getByText("No recorded inference yet.").waitFor()
  assert.equal((await page.evaluate(() => window.api.usage.get("all"))).overview.total, 0)
  console.log(
    "PASS Profile opens / empty state / local IPC",
    await page.locator('[data-component="local-usage"]').ariaSnapshot(),
  )
  for (const width of [360, 768, 1024, 1440]) {
    await page.setViewportSize({ width, height: 900 })
    await page.screenshot({ path: join(screenshots, `overview-${width}.png`) })
    assert(
      await page
        .locator('[data-component="local-usage"]')
        .evaluate((element) => element.scrollWidth <= element.clientWidth),
      "Horizontal Usage overflow",
    )
  }
  for (const label of ["7 days", "30 days", "90 days", "All time"])
    await page.getByRole("button", { name: label, exact: true }).click()
  await page.getByRole("tab", { name: "Models", exact: true }).last().click()
  await page.locator('[data-testid="usage-models"]').waitFor()
  await page.getByRole("button", { name: "Clear usage statistics", exact: true }).click()
  await page.getByText("Delete local usage statistics?", { exact: false }).waitFor()
  await page.getByRole("button", { name: /^(Отмена|Cancel)$/u }).click()
  assert.equal(errors.length, 0, errors.join("\n"))
  console.log("PASS ranges / Models / clear confirmation / no page errors")
  await page.setViewportSize({ width: 1024, height: 900 })
  await page
    .getByRole("button", { name: /^(Новая сессия|New session)$/u })
    .first()
    .click()
  const editor = page.locator('[data-component="prompt-input"][contenteditable="true"]')
  await editor.waitFor()
  await page.locator('[data-action="prompt-model"]').click()
  await page.locator('[data-option-key="memory-local:qwen3-coder:30b"]').click()
  await editor.fill("Reply with exactly OK. Do not call tools.")
  await editor.press("Enter")
  const deadline = Date.now() + 600000
  let recorded = await page.evaluate(() => window.api.usage.get("all"))
  while (!recorded.models.some((model) => model.kind === "agent" && model.total > 0) && Date.now() < deadline) {
    await page.waitForTimeout(1000)
    recorded = await page.evaluate(() => window.api.usage.get("all"))
  }
  assert(recorded.overview.total > 0)
  assert(
    recorded.models.some((model) => model.kind === "agent" && model.total > 0),
    "Agent inference missing",
  )
  await page.keyboard.press("Control+,")
  await page.getByRole("tab", { name: "Local Profile / Usage" }).click()
  await page.getByRole("button", { name: "Refresh", exact: true }).click()
  const formatted = new Intl.NumberFormat("ru-RU", { maximumFractionDigits: 1 }).format(recorded.overview.total)
  assert((await page.locator('[data-testid="usage-overview"]').innerText()).includes(formatted))
  await page.getByRole("tab", { name: "Models", exact: true }).last().click()
  await page.locator('[data-testid="usage-models"]').getByText("qwen3-coder:30b", { exact: true }).first().waitFor()
  for (const theme of ["dark", "light"]) {
    await page.emulateMedia({ colorScheme: theme })
    await page.screenshot({ path: join(screenshots, `models-${theme}.png`) })
  }
  console.log(
    "PASS real composer inference updates Profile / Models / dark-light",
    JSON.stringify({ requests: recorded.overview.requests, tokens: recorded.overview.total }),
  )
  const beforeRestart = await page.evaluate(() => window.api.usage.get("all"))
  await desktop.close()
  assert.equal(
    await fetch(`http://127.0.0.1:${port}/memory/health`)
      .then(() => true)
      .catch(() => false),
    false,
    "Owned Gateway did not exit",
  )
  desktop = await _electron.launch(launchOptions)
  const restarted = await desktop.firstWindow()
  restarted.on("pageerror", (error) => errors.push(error.message))
  await restarted.waitForFunction(() => window.api?.usage)
  assert.equal(
    (await restarted.evaluate(() => window.api.usage.get("all"))).overview.total,
    beforeRestart.overview.total,
  )
  // The existing onboarding test hook uses an in-memory session DB. Return home
  // after relaunch instead of opening the restored, intentionally absent session.
  await restarted.getByRole("button", { name: /^(Главная|Home)$/u }).click()
  await restarted.getByRole("button", { name: /^(Настройки|Settings)$/u }).click()
  await restarted.getByRole("tab", { name: "Local Profile / Usage" }).click()
  await restarted.getByRole("button", { name: "Clear usage statistics", exact: true }).click()
  await restarted.getByRole("button", { name: /^(Подтвердить|Confirm)$/u }).click()
  assert.equal((await restarted.evaluate(() => window.api.usage.get("all"))).overview.total, 0)
  assert.equal(errors.length, 0, errors.join("\n"))
  console.log("PASS full Desktop restart / owned Gateway shutdown / persisted totals / confirmed clear")
} catch (error) {
  const page = desktop.windows()[0]
  if (page) {
    console.error(await page.locator("body").ariaSnapshot())
    await page.screenshot({ path: join(screenshots, "failure.png") })
  }
  throw error
} finally {
  await desktop.close()
  await rm(temporary, { recursive: true, force: true, maxRetries: 10, retryDelay: 500 })
  console.log("CLEANUP", temporary)
}
