import { afterEach, describe, expect, test } from "bun:test"
import fs from "node:fs/promises"
import os from "node:os"
import path from "node:path"
import { Cause, Effect, Exit } from "effect"
import { LayerNode } from "@opencode-ai/core/effect/layer-node"
import { ProviderV2 } from "@opencode-ai/core/provider"
import { ModelV2 } from "@opencode-ai/core/model"
import { ToolRegistry } from "@/tool/registry"
import { Agent } from "@/agent/agent"
import { MessageID, SessionID } from "@/session/schema"
import { Tool } from "@/tool/tool"
import { ToolTurnBudget, TOOL_RESULT_BYTES, executeBounded, recordToolMetric, toolMetrics } from "@/tool/turn-budget"
import { workspacePath } from "@/tool/workspace-readonly"
import { Permission } from "@/permission"
import { SessionPrompt } from "@/session/prompt"
import { disposeAllInstances, TestInstance } from "../fixture/fixture"
import { testEffect, pollWithTimeout } from "../lib/effect"

const it = testEffect(LayerNode.compile(LayerNode.group([ToolRegistry.node, Agent.node, SessionPrompt.node])))

afterEach(async () => {
  await disposeAllInstances()
})

describe("managed workspace READ tools", () => {
  for (const modelID of ["gemma4:26b-a4b", "qwen3-coder:30b"]) {
    it.instance(`exposes file tools to ${modelID} and preserves ordinary providers`, () =>
      Effect.gen(function* () {
        const registry = yield* ToolRegistry.Service
        const agents = yield* Agent.Service
        const agent = yield* agents.defaultInfo()
        const managed = yield* registry.tools({
          providerID: ProviderV2.ID.make("memory-local"),
          modelID: ModelV2.ID.make(modelID),
          agent,
        })
        expect(managed.map((tool) => tool.id)).toContain("fs.write")
        expect(managed.map((tool) => tool.id)).toContain("fs.edit")
        for (const name of ["shell.exec", "test.run", "process.start", "process.status", "process.stop"])
          expect(managed.map((tool) => tool.id)).toContain(name)
        expect(managed.map((tool) => tool.id)).not.toContain("shell")
        const other = yield* registry.tools({
          providerID: ProviderV2.ID.make("other"),
          modelID: ModelV2.ID.make(modelID),
          agent,
        })
        expect(other.map((tool) => tool.id)).toContain("read")
        expect(other.map((tool) => tool.id)).toContain("bash")
        expect(managed.map((tool) => tool.id)).not.toContain("bash")
        expect(other.map((tool) => tool.id)).not.toContain("fs.write")
        expect(other.map((tool) => tool.id)).not.toContain("shell.exec")
      }),
    )
  }
  test("managed catalog respects upstream Plan/read-only edit denial", () => {
    const denied = Permission.disabled(
      ["fs.read", "fs.write", "fs.edit", "fs.search", "fs.glob"],
      [{ permission: "edit", pattern: "*", action: "deny" }],
    )
    expect([...denied]).toEqual(["fs.write", "fs.edit"])
    const executionNames = ["shell.exec", "test.run", "process.start", "process.status", "process.stop"]
    expect([...Permission.disabled(executionNames, [{ permission: "bash", pattern: "*", action: "deny" }])]).toEqual(
      executionNames,
    )
  })
  it.instance("Phase 9C V1 leaf uses shared shell policy and real process execution", () =>
    Effect.gen(function* () {
      const registry = yield* ToolRegistry.Service
      const agents = yield* Agent.Service
      const agent = yield* agents.defaultInfo()
      const tools = yield* registry.tools({
        providerID: ProviderV2.ID.make("memory-local"),
        modelID: ModelV2.ID.make("qwen3-coder:30b"),
        agent,
      })
      const shell = tools.find((tool) => tool.id === "shell.exec")!
      const asked: string[] = []
      const ctx: Tool.Context = {
        sessionID: SessionID.make("ses_phase9c"),
        messageID: MessageID.make("msg_phase9c"),
        agent: agent.name,
        abort: new AbortController().signal,
        messages: [],
        metadata: () => Effect.void,
        ask: (request) =>
          Effect.sync(() => {
            asked.push(request.permission)
          }),
      }
      const result = yield* shell.execute({ command: "echo Phase9C" }, ctx)
      expect(JSON.parse(result.output)).toMatchObject({ ok: true, exitCode: 0, cwd: "." })
      expect(asked).toEqual(["bash"])
      const denied = yield* shell.execute({ command: "Stop-Process -Id 1" }, ctx)
      expect(JSON.parse(denied.output)).toMatchObject({ ok: false, code: "COMMAND_DENIED" })
      expect(asked).toHaveLength(1)
      const noPermission = yield* shell.execute({ command: "echo no" }, { ...ctx, ask: () => Effect.die("denied") })
      expect(JSON.parse(noPermission.output)).toMatchObject({ ok: false, code: "PERMISSION_DENIED" })
    }),
  )
  it.instance("V1 session cancellation stops a previously started owned process", () =>
    Effect.gen(function* () {
      const instance = yield* TestInstance
      yield* Effect.promise(() =>
        fs.writeFile(
          path.join(instance.directory, "dev.js"),
          "require('fs').writeFileSync('pid.txt',String(process.pid));setInterval(()=>{},100)",
        ),
      )
      const registry = yield* ToolRegistry.Service
      const agents = yield* Agent.Service
      const agent = yield* agents.defaultInfo()
      const tools = yield* registry.tools({
        providerID: ProviderV2.ID.make("memory-local"),
        modelID: ModelV2.ID.make("qwen3-coder:30b"),
        agent,
      })
      const prompt = yield* SessionPrompt.Service
      const ctx: Tool.Context = {
        sessionID: SessionID.make("ses_phase9c_cancel"),
        messageID: MessageID.make("msg_cancel"),
        agent: agent.name,
        abort: new AbortController().signal,
        messages: [],
        metadata: () => Effect.void,
        ask: () => Effect.void,
      }
      const started = yield* tools.find((tool) => tool.id === "process.start")!.execute({ command: "node dev.js" }, ctx)
      expect(JSON.parse(started.output).running).toBe(true)
      const pid = yield* pollWithTimeout(
        Effect.promise(() =>
          fs.readFile(path.join(instance.directory, "pid.txt"), "utf8").then(Number, () => undefined),
        ),
        "owned process did not start",
      )
      yield* prompt.cancel(ctx.sessionID)
      expect(() => process.kill(pid, 0)).toThrow()
    }),
  )
  test("rejects traversal, Windows absolute paths, UNC, and symlink escape", async () => {
    const base = await fs.mkdtemp(path.join(os.tmpdir(), "phase9a-"))
    const root = path.join(base, "workspace with spaces")
    const outside = path.join(base, "outside.txt")
    await fs.mkdir(root)
    await fs.writeFile(outside, "secret")
    await fs.writeFile(path.join(root, "данные теста.txt"), "Phase 9A читает UTF-8 корректно.")
    try {
      expect(await workspacePath(root, "данные теста.txt")).toBe(path.join(root, "данные теста.txt"))
      for (const attempt of [
        "../outside.txt",
        "..\\..\\outside.txt",
        "C:\\Windows\\win.ini",
        "C:/Windows/win.ini",
        "\\\\server\\share",
        "/etc/passwd",
        "sub/..\\../outside.txt",
      ])
        await workspacePath(root, attempt).then(
          () => {
            throw new Error("expected rejection")
          },
          (error) => expect(error).toMatchObject({ code: "NOT_ALLOWED" }),
        )
      const link = path.join(root, "outside-link")
      await fs.symlink(base, link, process.platform === "win32" ? "junction" : "dir")
      await workspacePath(root, "outside-link/outside.txt").then(
        () => {
          throw new Error("expected rejection")
        },
        (error) => expect(error).toMatchObject({ code: "NOT_ALLOWED" }),
      )
    } finally {
      await fs.rm(base, { recursive: true, force: true })
    }
  })

  it.instance("exposes bounded managed file tools and shares read/edit revisions", () =>
    Effect.gen(function* () {
      const registry = yield* ToolRegistry.Service
      const agents = yield* Agent.Service
      const tools = yield* registry.tools({
        providerID: ProviderV2.ID.make("memory-local"),
        modelID: ModelV2.ID.make("qwen3:8b"),
        agent: yield* agents.defaultInfo(),
      })
      expect(tools.map((item) => item.id).sort()).toEqual([
        "fs.edit",
        "fs.glob",
        "fs.list",
        "fs.read",
        "fs.search",
        "fs.write",
        "process.start",
        "process.status",
        "process.stop",
        "project.info",
        "shell.exec",
        "test.run",
      ])
      const test = yield* TestInstance
      yield* Effect.promise(() =>
        fs.writeFile(path.join(test.directory, "данные теста.txt"), "Phase 9A читает UTF-8 корректно."),
      )
      const read = tools.find((item) => item.id === "fs.read")!
      const context = {
        sessionID: SessionID.make("ses_phase9a"),
        messageID: MessageID.make("msg_phase9a"),
        agent: (yield* agents.defaultInfo()).name,
        abort: new AbortController().signal,
        messages: [],
        metadata: () => Effect.void,
        ask: () => Effect.void,
      } satisfies Tool.Context
      const result = yield* read.execute({ path: "данные теста.txt" }, context)
      expect(result.output).toContain("Phase 9A читает UTF-8 корректно.")
      expect(result.output).not.toContain(test.directory)
      const edited = yield* tools
        .find((item) => item.id === "fs.edit")!
        .execute({ path: "данные теста.txt", oldString: "Phase 9A", newString: "Phase 9B" }, context)
      expect(edited.output).toContain('"ok":true')
      expect(yield* Effect.promise(() => fs.readFile(path.join(test.directory, "данные теста.txt"), "utf8"))).toContain(
        "Phase 9B",
      )
      const listed = yield* tools.find((item) => item.id === "fs.list")!.execute({ path: "." }, context)
      expect(listed.output).toContain("данные теста.txt")
      const info = yield* tools.find((item) => item.id === "project.info")!.execute({}, context)
      expect(info.output).not.toContain(test.directory)
      const denied = yield* read.execute(
        { path: "данные теста.txt", approved: true, projectRoot: "C:\\Windows" },
        { ...context, ask: () => Effect.die(new Error("denied")) },
      )
      expect(denied.output).toContain("PERMISSION_DENIED")
      const invalid = yield* read.execute({ path: 42 }, context).pipe(Effect.exit)
      expect(Exit.isFailure(invalid)).toBe(true)
      yield* Effect.promise(() => fs.writeFile(path.join(test.directory, "binary.bin"), Buffer.from([0, 1, 2, 3])))
      const binary = yield* read.execute({ path: "binary.bin" }, context)
      expect(binary.output).not.toContain("\\u0000")
      expect(binary.output).toContain("UNSUPPORTED_BINARY_FILE")
    }),
  )

  test("bounds result bytes, call count, and repeated identical results", () => {
    const budget = new ToolTurnBudget(3)
    expect(budget.begin("fs.read", { path: "a" })).toBeUndefined()
    const large = budget.finish("fs.read", { path: "a" }, "Ю".repeat(20_000), 5)
    expect(large.truncated).toBe(true)
    expect(large.originalBytes).toBe(40_000)
    expect(Buffer.byteLength(large.output)).toBeLessThanOrEqual(TOOL_RESULT_BYTES)
    expect(budget.begin("fs.read", { path: "a" })).toBeUndefined()
    budget.finish("fs.read", { path: "a" }, "Ю".repeat(20_000), 5)
    expect(budget.begin("fs.read", { path: "a" })).toBe("NOT_ALLOWED")
    expect(budget.loopPrevented).toBe(true)
    expect(budget.begin("fs.list", { path: "." })).toBeUndefined()
    expect(budget.begin("project.info", {})).toBe("NOT_ALLOWED")
    expect(budget.available).toBe(false)
  })
  test("bounds escaped file result JSON and stops tools at turn output exhaustion", () => {
    const budget = new ToolTurnBudget()
    for (let index = 0; index < 4; index++) {
      expect(budget.begin("fs.read", { path: `${index}.txt` })).toBeUndefined()
      const result = budget.finish("fs.read", { path: `${index}.txt` }, '\\"\n\t'.repeat(20_000), 1)
      expect(Buffer.byteLength(result.output)).toBeLessThanOrEqual(TOOL_RESULT_BYTES)
      expect(() => JSON.parse(result.output)).not.toThrow()
    }
    expect(budget.available).toBe(false)
    expect(budget.begin("fs.write", { path: "extra.txt" })).toBe("NOT_ALLOWED")
  })

  test("interrupts a running handler on timeout or user cancellation", async () => {
    const timeout = await Effect.runPromiseExit(executeBounded(Effect.never, undefined, 5))
    expect(Exit.isFailure(timeout)).toBe(true)
    if (Exit.isFailure(timeout)) expect(Cause.isTimeoutError(Cause.squash(timeout.cause))).toBe(true)
    const controller = new AbortController()
    const cancelled = Effect.runPromiseExit(executeBounded(Effect.never, controller.signal, 1000))
    controller.abort()
    const exit = await cancelled
    expect(Exit.isFailure(exit)).toBe(true)
    if (Exit.isFailure(exit)) expect(Cause.squash(exit.cause)).toBe("CANCELLED")
  })

  test("reports bounded in-process metrics without identity labels", () => {
    const before = toolMetrics()
    recordToolMetric({ status: "denied", durationMs: 3, loopPrevented: true, truncated: true })
    const after = toolMetrics()
    expect(after.tool_calls_total).toBe(before.tool_calls_total + 1)
    expect(after.tool_calls_denied).toBe(before.tool_calls_denied + 1)
    expect(after.tool_loop_prevented).toBe(before.tool_loop_prevented + 1)
    expect(after.tool_result_truncated).toBe(before.tool_result_truncated + 1)
    expect(Object.keys(after)).not.toContain("sessionId")
  })
})
