import { expect, test } from "bun:test"
import { spawnSync } from "node:child_process"
import { createHash } from "node:crypto"
import { existsSync, mkdtempSync, readFileSync, rmSync } from "node:fs"
import { createServer } from "node:net"
import { tmpdir } from "node:os"
import { dirname, join, resolve } from "node:path"
import { defaultMemoryDesktopSettings } from "@opencode-ai/core/memory/desktop"
import { MemoryService } from "./memory-service"

test("bundled Gateway starts from a path with spaces, persists data, and stops", async () => {
  const binary =
    process.env.MEMORY_TEST_PACKAGED_EXE ?? join(process.cwd(), "node_modules", "electron", "dist", "electron.exe")
  const resources = process.env.MEMORY_TEST_PACKAGED_EXE
    ? join(dirname(binary), "resources")
    : join(process.cwd(), "resources")
  if (!existsSync(join(resources, "memory-gateway", "gateway.mjs")) || !existsSync(binary))
    throw new Error("Run bun scripts/bundle-memory-gateway.ts before the live service test")
  const runtime = spawnSync(binary, ["-e", "console.log(process.version)"], {
    env: { ...process.env, ELECTRON_RUN_AS_NODE: "1" },
    encoding: "utf8",
    windowsHide: true,
  })
  expect(runtime.stdout, runtime.stderr).toContain("v24")
  const socket = createServer()
  await new Promise<void>((resolve) => socket.listen(0, "127.0.0.1", resolve))
  const address = socket.address()
  if (!address || typeof address === "string") throw new Error("No test port")
  const port = address.port
  await new Promise<void>((resolve) => socket.close(() => resolve()))
  const userData = mkdtempSync(join(tmpdir(), "memory phase8 "))
  const importedData = mkdtempSync(join(tmpdir(), "memory imported "))
  const settings = { ...defaultMemoryDesktopSettings, enabled: true, port }
  const stderr: string[] = []
  const service = new MemoryService({
    store: { get: () => settings, set: () => undefined },
    userData,
    resources,
    executable: binary,
    onStderr: (line) => stderr.push(line),
  })
  try {
    await service.detectOllama()
    const state = await service.start()
    expect(["running", "degraded"], stderr.join("\n")).toContain(state.state)
    expect(await (await fetch(`http://127.0.0.1:${port}/health`)).json()).toMatchObject({ apiVersion: 1, status: "ok" })
    expect(existsSync(join(userData, "Memory", "memory.db"))).toBe(true)
    expect(await service.maintenance("diagnostics")).toMatchObject({ ok: true, database: { integrity: "ok" } })
    const created = (await service.maintenance("backup")) as { id: string; verified: boolean }
    expect(created.verified).toBe(true)
    expect(
      ((await service.maintenance("backups")) as { backups: { id: string }[] }).backups.some(
        (item) => item.id === created.id,
      ),
    ).toBe(true)
    expect(await service.maintenance("restoreDryRun", created.id)).toMatchObject({ valid: true })
    expect(await service.maintenance("restore", created.id, true)).toBeTruthy()
    const support = (await service.maintenance("supportBundle")) as { path: string }
    expect(existsSync(support.path)).toBe(true)
    await service.stop()
    expect(service.snapshot.state).toBe("stopped")
    expect((await service.start()).state).toMatch(/^(running|degraded)$/u)
    expect(await service.maintenance("diagnostics")).toMatchObject({ ok: true })
    await service.stop()
    const original = join(userData, "Memory", "memory.db")
    const digest = () => createHash("sha256").update(readFileSync(original)).digest("hex")
    const before = digest()
    const script =
      "import('./src/main/memory-service.ts').then(async ({MemoryService}) => { const service = new MemoryService({store:{get:()=>({enabled:false}),set:()=>{}},userData:process.env.MEMORY_TEST_IMPORT_DATA,resources:'',executable:''}); await service.importDatabase(process.env.MEMORY_TEST_IMPORT_SOURCE); console.log('imported') }).catch(error=>{console.error(error);process.exitCode=1})"
    const importedByNode = spawnSync("node", ["--experimental-transform-types", "-e", script], {
      cwd: process.cwd(),
      encoding: "utf8",
      windowsHide: true,
      env: { ...process.env, MEMORY_TEST_IMPORT_DATA: importedData, MEMORY_TEST_IMPORT_SOURCE: original },
    })
    expect(importedByNode.status, importedByNode.stderr).toBe(0)
    expect(digest()).toBe(before)
    expect(existsSync(join(importedData, "Memory", "memory.db"))).toBe(true)
    const imported = new MemoryService({
      store: { get: () => settings, set: () => undefined },
      userData: importedData,
      resources,
      executable: binary,
    })
    expect((await imported.start()).state).toMatch(/^(running|degraded)$/u)
    expect(await imported.maintenance("diagnostics")).toMatchObject({ ok: true })
    await imported.stop()
    const pendingMigration = spawnSync(
      "node",
      [
        "-e",
        "const {DatabaseSync}=require('node:sqlite');const db=new DatabaseSync(process.env.MEMORY_TEST_IMPORT_DEST);const latest=db.prepare('SELECT version FROM schema_migrations ORDER BY version DESC LIMIT 1').get();db.prepare('DELETE FROM schema_migrations WHERE version=?').run(latest.version);db.close()",
      ],
      {
        encoding: "utf8",
        windowsHide: true,
        env: { ...process.env, MEMORY_TEST_IMPORT_DEST: join(importedData, "Memory", "memory.db") },
      },
    )
    expect(pendingMigration.status, pendingMigration.stderr).toBe(0)
    expect((await imported.start()).state).toMatch(/^(running|degraded)$/u)
    const postMigrationBackups = (await imported.maintenance("backups")) as {
      backups: { kind: string; verified: boolean }[]
    }
    expect(postMigrationBackups.backups.some((item) => item.kind === "safety" && item.verified)).toBe(true)
    await imported.stop()
  } finally {
    await service.stop()
    if (resolve(userData).startsWith(resolve(tmpdir()) + "\\")) rmSync(userData, { recursive: true, force: true })
    if (resolve(importedData).startsWith(resolve(tmpdir()) + "\\"))
      rmSync(importedData, { recursive: true, force: true })
  }
}, 30_000)
