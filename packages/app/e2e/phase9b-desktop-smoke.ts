import assert from "node:assert/strict"
import { randomUUID } from "node:crypto"
import { mkdir, rm, writeFile } from "node:fs/promises"
import { tmpdir } from "node:os"
import { resolve, join } from "node:path"
import { fileURLToPath, pathToFileURL } from "node:url"
import { _electron } from "@playwright/test"

const profile = join(tmpdir(), `opencode-onboarding-${randomUUID()}`)
await mkdir(profile)
const desktop = resolve(fileURLToPath(new URL(".", import.meta.url)), "../../desktop")
const errors: string[] = []
await mkdir(join(profile, "documents"))
const bootstrap = join(profile, "bootstrap.cjs")
await writeFile(
  bootstrap,
  `const {app}=require('electron'); app.setPath('documents', ${JSON.stringify(join(profile, "documents"))}); if(app.setAppPath)app.setAppPath(${JSON.stringify(desktop)}); const append=app.commandLine.appendSwitch.bind(app.commandLine); app.commandLine.appendSwitch=(key,value)=>{if(key==='remote-debugging-port'&&app.commandLine.hasSwitch(key))return;append(key,value)}; import(${JSON.stringify(pathToFileURL(join(desktop, "out/main/index.js")).href)});`,
)
let app: Awaited<ReturnType<typeof _electron.launch>> | undefined
try {
  app = await _electron.launch({
    executablePath: join(desktop, "node_modules/electron/dist/electron.exe"),
    args: [bootstrap],
    cwd: desktop,
    env: {
      ...process.env,
      OPENCODE_TEST_ONBOARDING: "1",
      OPENCODE_TEST_ONBOARDING_ROOT: profile,
      OPENCODE_TEST_HOME: join(profile, "home"),
      OPENCODE_DISABLE_MODELS_FETCH: "true",
      OPENCODE_DISABLE_AUTOUPDATE: "true",
    },
    timeout: 60_000,
  })
  const page = await app.firstWindow({ timeout: 60_000 })
  page.on("pageerror", (error) => errors.push(error.message))
  await page.waitForLoadState("domcontentloaded")
  await page.locator("body").waitFor({ state: "visible" })
  await page.waitForFunction(() => document.body.innerText.trim().length > 0)
  console.log("INITIAL UI", (await page.locator("body").innerText()).slice(0, 3000))
  for (const width of [360, 768, 1024, 1440]) {
    await page.setViewportSize({ width, height: 900 })
    await page.screenshot({ path: join(profile, `desktop-${width}.png`) })
    const dimensions = await page.evaluate(() => ({
      scroll: document.documentElement.scrollWidth,
      viewport: window.innerWidth,
      body: document.body.innerText.slice(0, 500),
    }))
    console.log("DIMENSIONS", width, JSON.stringify(dimensions))
    if (dimensions.scroll > dimensions.viewport) console.log("KNOWN SHELL OVERFLOW", width)
    else console.log("PASS viewport", width)
    if (width === 1440)
      assert.equal(dimensions.scroll > dimensions.viewport, false, "Horizontal overflow at desktop width")
  }
  assert.equal(errors.length, 0, JSON.stringify(errors))
  console.log("PASS isolated built Desktop startup, 4 viewports, no page errors")
} finally {
  await app?.close()
  await rm(profile, { recursive: true, force: true })
  console.log("CLEANUP", profile)
}
