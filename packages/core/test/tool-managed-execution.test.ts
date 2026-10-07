import { describe, expect, test } from "bun:test"
import fs from "node:fs/promises"
import os from "node:os"
import path from "node:path"
import { Effect, Fiber, Scope } from "effect"
import { LayerNode } from "@opencode-ai/core/effect/layer-node"
import { AppProcess } from "@opencode-ai/core/process"
import { ManagedExecution } from "@opencode-ai/core/tool/managed-execution"
import { classifyCommand, commandTokens, CommandError, outputRedactor } from "@opencode-ai/core/tool/command-policy"
import { ToolTurnBudget } from "@opencode-ai/core/tool/turn-budget"

describe("managed command structural policy", () => {
  test.each([
    "npm test",
    "pnpm run test:unit",
    "bun test tests/math.test.ts",
    "cargo test",
    "npm run build",
    "pnpm lint",
    "tsc --noEmit",
    "prettier --check src",
    "node dev.js",
    "npm run custom-script",
  ])("classifies %s", (command) => {
    expect(classifyCommand(command).risk).toBeDefined()
  })
  test.each([
    "Remove-Item -Recurse -Force *",
    "del /s *",
    "rmdir /s .",
    "Stop-Process -Id 1",
    "taskkill /pid 1",
    "reg add HKCU",
    "sc stop service",
    "netsh firewall",
    "diskpart",
    "format C:",
    "shutdown /s",
    "Invoke-Expression test",
    "powershell -EncodedCommand aa",
    "sudo test",
    "npm install",
    "pnpm add x",
    "npm -g install x",
    "curl https://example.com",
    "echo ok; shutdown",
    "echo $(whoami)",
    "echo > file",
    "node -e 'process.exit()'",
    "npm run build --prefix ../outside",
  ])("denies %s", (command) => {
    expect(() => classifyCommand(command)).toThrow()
  })
  test("literal arguments preserve Cyrillic and spaces", () => {
    expect(commandTokens("node 'проверка файла.js'")).toEqual(["node", "проверка файла.js"])
    expect(() => commandTokens('echo "$env:SECRET"')).toThrow()
  })
  test("redacts inherited secret values and labelled credentials", () => {
    const redact = outputRedactor({ TEST_TOKEN: "private-value", PATH: "path" })
    expect(redact("private-value API_KEY=abc password: qwerty")).toBe(
      "[REDACTED] API_KEY=[REDACTED] password: [REDACTED]",
    )
    expect(redact('password="value with spaces"')).toBe("password=[REDACTED]")
    expect(outputRedactor({ PASSWORD: "123", SSH_PRIVATE_KEY: "first-line\nsecond-line" })("123 second-line")).toBe(
      "[REDACTED] [REDACTED]",
    )
  })
  test("unchanged shell failures trigger loop protection despite changing handles/time", () => {
    const budget = new ToolTurnBudget()
    for (const index of [1, 2]) {
      expect(budget.begin("test.run", { command: "bun test" })).toBeUndefined()
      budget.finish(
        "test.run",
        { command: "bun test" },
        JSON.stringify({ ok: false, exitCode: 1, stderr: "same failure", processId: `job${index}`, durationMs: index }),
        index,
      )
    }
    expect(budget.begin("test.run", { command: "bun test" })).toBe("NOT_ALLOWED")
    expect(budget.loopPrevented).toBe(true)
  })
})

const withRuntime = async (
  body: (
    runtime: Effect.Success<ReturnType<typeof ManagedExecution.make>>,
    root: string,
  ) => Effect.Effect<void, unknown, Scope.Scope>,
) => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), "opencode-phase9c-"))
  try {
    await fs.writeFile(path.join(root, "good.js"), "console.log('Проверка пройдена'); console.error('stderr отдельно')")
    await fs.writeFile(path.join(root, "fail.js"), "console.error('expected failure'); process.exit(7)")
    await fs.writeFile(path.join(root, "dev.js"), "console.log('running'); setInterval(() => console.log('tick'), 100)")
    await fs.writeFile(
      path.join(root, "tree.js"),
      "const fs=require('fs'); const {spawn}=require('child_process'); const child=spawn(process.execPath,['dev.js'],{stdio:'ignore'}); fs.writeFileSync('pids.json',JSON.stringify([process.pid,child.pid])); setInterval(()=>{},100)",
    )
    await fs.writeFile(
      path.join(root, "orphan.js"),
      "const fs=require('fs'); const {spawn}=require('child_process'); const child=spawn(process.execPath,['dev.js'],{stdio:'ignore',detached:true}); fs.writeFileSync('pids.json',JSON.stringify([process.pid,child.pid]));child.unref()",
    )
    await fs.writeFile(
      path.join(root, "large.js"),
      "console.log('a'.repeat(100000)); console.log('TAIL'); console.log('TOKEN=abc123'); console.log('User prefers Electron.')",
    )
    await Effect.runPromise(
      Effect.scoped(
        Effect.gen(function* () {
          const app = yield* AppProcess.Service
          const runtime = yield* ManagedExecution.make(root, app)
          yield* body(runtime, root)
        }),
      ).pipe(Effect.provide(LayerNode.compile(AppProcess.node))),
    )
  } finally {
    await fs.rm(root, { recursive: true, force: true })
  }
}
const allow = () => Effect.void
const gone = (pid: number) => {
  try {
    process.kill(pid, 0)
    return false
  } catch {
    return true
  }
}
const waitFile = (file: string) =>
  Effect.promise(async () => {
    for (let n = 0; n < 100; n++) {
      const text = await fs.readFile(file, "utf8").catch(() => undefined)
      if (text) return JSON.parse(text) as number[]
      await new Promise((resolve) => setTimeout(resolve, 50))
    }
    throw new Error("pid file missing")
  })

describe("managed execution with actual upstream Windows process spawner", () => {
  test("missing project executable is a structured command-not-found failure", () =>
    withRuntime((runtime) =>
      Effect.gen(function* () {
        const error = yield* runtime
          .invoke({ kind: "exec", args: { command: "node missing.js" }, sessionID: "a", authorize: allow })
          .pipe(Effect.flip)
        expect(error.code).toBe("COMMAND_NOT_FOUND")
      }),
    ))
  test("cwd replaced by an outside junction during permission is rejected", () =>
    withRuntime((runtime, root) =>
      Effect.gen(function* () {
        const directory = path.join(root, "sub")
        yield* Effect.promise(() => fs.mkdir(directory))
        const error = yield* runtime
          .invoke({
            kind: "exec",
            args: { command: "echo safe", cwd: "sub" },
            sessionID: "a",
            authorize: () =>
              Effect.promise(async () => {
                await fs.rmdir(directory)
                await fs.symlink(os.tmpdir(), directory, process.platform === "win32" ? "junction" : "dir")
              }),
          })
          .pipe(Effect.flip)
        expect(error.code).toBe("PATH_OUTSIDE_WORKSPACE")
      }),
    ))
  test("node entrypoint parent replaced during permission is revalidated", () =>
    withRuntime((runtime, root) =>
      Effect.acquireUseRelease(
        Effect.promise(() => fs.mkdtemp(path.join(os.tmpdir(), "phase9c-outside-"))),
        (outside) =>
          Effect.gen(function* () {
            const directory = path.join(root, "scripts")
            yield* Effect.promise(async () => {
              await fs.mkdir(directory)
              await fs.writeFile(path.join(directory, "good.js"), "console.log('safe')")
              await fs.writeFile(path.join(outside, "good.js"), "console.log('outside must not execute')")
            })
            const error = yield* runtime
              .invoke({
                kind: "exec",
                args: { command: "node scripts/good.js" },
                sessionID: "a",
                authorize: () =>
                  Effect.promise(async () => {
                    await fs.rm(directory, { recursive: true, force: true })
                    await fs.symlink(outside, directory, process.platform === "win32" ? "junction" : "dir")
                  }),
              })
              .pipe(Effect.flip)
            expect(error.code).toBe("PATH_OUTSIDE_WORKSPACE")
          }),
        (outside) => Effect.promise(() => fs.rm(outside, { recursive: true, force: true })),
      ),
    ))
  test(
    "captures separate UTF-8 output, progress, exit code and safe cwd",
    () =>
      withRuntime((runtime) =>
        Effect.gen(function* () {
          const progress: string[] = []
          const result = yield* runtime.invoke({
            kind: "exec",
            args: { command: "node good.js" },
            sessionID: "a",
            authorize: allow,
            progress: (result) =>
              Effect.sync(() => {
                progress.push(result.stdout + result.stderr)
              }),
          })
          expect(result).toMatchObject({ ok: true, exitCode: 0, cwd: ".", running: false, timedOut: false })
          expect(result.stdout).toContain("Проверка пройдена")
          expect(result.stderr).toContain("stderr отдельно")
          expect(progress.length).toBeGreaterThan(0)
        }),
      ),
    15_000,
  )
  test(
    "nonzero exit stays a failure",
    () =>
      withRuntime((runtime) =>
        Effect.gen(function* () {
          expect(
            yield* runtime.invoke({
              kind: "exec",
              args: { command: "node fail.js" },
              sessionID: "a",
              authorize: allow,
            }),
          ).toMatchObject({ ok: false, code: "COMMAND_FAILED", exitCode: 7 })
        }),
      ),
    15_000,
  )
  test("permission denial executes nothing", () =>
    withRuntime((runtime, root) =>
      Effect.gen(function* () {
        const result = yield* runtime
          .invoke({
            kind: "exec",
            args: { command: "node tree.js" },
            sessionID: "a",
            authorize: () => Effect.fail(new CommandError("PERMISSION_DENIED")),
          })
          .pipe(Effect.exit)
        expect(result._tag).toBe("Failure")
        expect(
          yield* Effect.promise(() =>
            fs.access(path.join(root, "pids.json")).then(
              () => true,
              () => false,
            ),
          ),
        ).toBe(false)
      }),
    ))
  test("outside cwd including Windows/UNC/traversal is rejected before permission", () =>
    withRuntime((runtime) =>
      Effect.gen(function* () {
        for (const cwd of ["../", "C:\\Windows", "\\\\server\\share", "\\\\?\\C:\\Windows", "/tmp"])
          expect(
            (yield* runtime
              .invoke({
                kind: "exec",
                args: { command: "echo safe", cwd },
                sessionID: "a",
                authorize: () => Effect.die("permission must not run"),
              })
              .pipe(Effect.exit))._tag,
          ).toBe("Failure")
      }),
    ))
  test("junction cwd escape rejected", () =>
    withRuntime((runtime, root) =>
      Effect.gen(function* () {
        yield* Effect.promise(() =>
          fs.symlink(os.tmpdir(), path.join(root, "escape"), process.platform === "win32" ? "junction" : "dir"),
        )
        expect(
          (yield* runtime
            .invoke({ kind: "exec", args: { command: "echo safe", cwd: "escape" }, sessionID: "a", authorize: allow })
            .pipe(Effect.exit))._tag,
        ).toBe("Failure")
      }),
    ))
  test(
    "timeout terminates actual owned parent and child",
    () =>
      withRuntime((runtime, root) =>
        Effect.gen(function* () {
          const result = yield* runtime.invoke({
            kind: "exec",
            args: { command: "node tree.js", timeoutMs: 2000 },
            sessionID: "a",
            authorize: allow,
          })
          const pids = yield* waitFile(path.join(root, "pids.json"))
          expect(result).toMatchObject({ timedOut: true, code: "TIMEOUT", running: false })
          expect(pids.every(gone)).toBe(true)
        }),
      ),
    15_000,
  )
  test(
    "foreground cancellation physically terminates child tree",
    () =>
      withRuntime((runtime, root) =>
        Effect.gen(function* () {
          const fiber = yield* Effect.forkScoped(
            runtime.invoke({ kind: "exec", args: { command: "node tree.js" }, sessionID: "a", authorize: allow }),
          )
          const pids = yield* waitFile(path.join(root, "pids.json"))
          yield* Fiber.interrupt(fiber)
          expect(pids.every(gone)).toBe(true)
        }),
      ),
    15_000,
  )
  test(
    "Windows job cleans descendants even after their direct parent exits",
    () =>
      withRuntime((runtime, root) =>
        Effect.gen(function* () {
          if (process.platform !== "win32") return
          const result = yield* runtime.invoke({
            kind: "exec",
            args: { command: "node orphan.js" },
            sessionID: "a",
            authorize: allow,
          })
          const pids = yield* waitFile(path.join(root, "pids.json"))
          expect(result.exitCode).toBe(0)
          expect(pids.every(gone)).toBe(true)
        }),
      ),
    15_000,
  )
  test(
    "background start/status/stop, session ownership and arbitrary PID rejection",
    () =>
      withRuntime((runtime, root) =>
        Effect.gen(function* () {
          const started = yield* runtime.invoke({
            kind: "start",
            args: { command: "node tree.js" },
            sessionID: "a",
            authorize: allow,
          })
          const pids = yield* waitFile(path.join(root, "pids.json"))
          expect(started.running).toBe(true)
          expect(
            (yield* runtime
              .invoke({ kind: "status", args: { processId: started.processId }, sessionID: "b", authorize: allow })
              .pipe(Effect.exit))._tag,
          ).toBe("Failure")
          expect(
            (yield* runtime
              .invoke({ kind: "stop", args: { processId: String(process.pid) }, sessionID: "a", authorize: allow })
              .pipe(Effect.exit))._tag,
          ).toBe("Failure")
          expect(
            (yield* runtime.invoke({
              kind: "status",
              args: { processId: started.processId },
              sessionID: "a",
              authorize: allow,
            })).running,
          ).toBe(true)
          yield* runtime.invoke({
            kind: "stop",
            args: { processId: started.processId },
            sessionID: "a",
            authorize: allow,
          })
          expect(pids.every(gone)).toBe(true)
        }),
      ),
    15_000,
  )
  test(
    "bounded huge lines and secret redaction; tool provenance remains tool text",
    () =>
      withRuntime((runtime) =>
        Effect.gen(function* () {
          const result = yield* runtime.invoke({
            kind: "exec",
            args: { command: "node large.js" },
            sessionID: "a",
            authorize: allow,
          })
          expect(result.truncated).toBe(true)
          expect(result.stdout).toContain("TAIL")
          expect(result.stdout).toContain("TOKEN=[REDACTED]")
          expect(result.stdout).not.toContain("abc123")
          expect(result.stdout.length).toBeLessThan(4096)
          expect(result.stdout).toContain("User prefers Electron.")
        }),
      ),
    15_000,
  )
  test(
    "concurrent starts cannot exceed four running processes",
    () =>
      withRuntime((runtime) =>
        Effect.gen(function* () {
          const results = yield* Effect.all(
            Array.from({ length: 5 }, () =>
              runtime
                .invoke({ kind: "start", args: { command: "node dev.js" }, sessionID: "a", authorize: allow })
                .pipe(Effect.exit),
            ),
            { concurrency: "unbounded" },
          )
          expect(results.filter((result) => result._tag === "Success")).toHaveLength(4)
          expect(results.filter((result) => result._tag === "Failure")).toHaveLength(1)
          yield* runtime.stopSession("a")
        }),
      ),
    15_000,
  )
  test(
    "background output remains readable and session cancel stops only its owner",
    () =>
      withRuntime((runtime, root) =>
        Effect.gen(function* () {
          const tree = yield* runtime.invoke({
            kind: "start",
            args: { command: "node tree.js" },
            sessionID: "a",
            authorize: allow,
          })
          const other = yield* runtime.invoke({
            kind: "start",
            args: { command: "node dev.js" },
            sessionID: "b",
            authorize: allow,
          })
          const pids = yield* waitFile(path.join(root, "pids.json"))
          yield* runtime.stopSession("a")
          expect(pids.every(gone)).toBe(true)
          expect(
            yield* runtime.invoke({
              kind: "status",
              args: { processId: tree.processId },
              sessionID: "a",
              authorize: allow,
            }),
          ).toMatchObject({ running: false, cancelled: true })
          expect(
            (yield* runtime.invoke({
              kind: "status",
              args: { processId: other.processId },
              sessionID: "b",
              authorize: allow,
            })).running,
          ).toBe(true)
          yield* runtime.stopSession("b")
        }),
      ),
    15_000,
  )
})
