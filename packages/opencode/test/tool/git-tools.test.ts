import { describe, expect } from "bun:test"
import fs from "node:fs/promises"
import path from "node:path"
import { Effect, Fiber } from "effect"
import { LayerNode } from "@opencode-ai/core/effect/layer-node"
import { ProviderV2 } from "@opencode-ai/core/provider"
import { ModelV2 } from "@opencode-ai/core/model"
import { PermissionV1 } from "@opencode-ai/core/v1/permission"
import { ToolRegistry } from "@/tool/registry"
import { Agent } from "@/agent/agent"
import { Permission } from "@/permission"
import { SessionID, MessageID } from "@/session/schema"
import { Tool } from "@/tool/tool"
import { v1GitNames } from "@opencode-ai/core/tool/managed-git"
import { TestInstance } from "../fixture/fixture"
import { testEffect, pollWithTimeout } from "../lib/effect"

const it = testEffect(LayerNode.compile(LayerNode.group([ToolRegistry.node, Agent.node, Permission.node])))
describe("Phase 9D V1 Git leaves and permissions", () => {
  it.instance("managed catalog exposes Git; ordinary providers retain their catalog", () =>
    Effect.gen(function* () {
      const registry = yield* ToolRegistry.Service
      const agents = yield* Agent.Service
      const agent = yield* agents.defaultInfo()
      const managed = yield* registry.tools({
        providerID: ProviderV2.ID.make("memory-local"),
        modelID: ModelV2.ID.make("qwen3-coder:30b"),
        agent,
      })
      for (const name of v1GitNames) expect(managed.map((item) => item.id)).toContain(name)
      const other = yield* registry.tools({
        providerID: ProviderV2.ID.make("other"),
        modelID: ModelV2.ID.make("model"),
        agent,
      })
      for (const name of v1GitNames) expect(other.map((item) => item.id)).not.toContain(name)
      expect([...Permission.disabled(v1GitNames, [{ permission: "*", pattern: "*", action: "deny" }])]).toEqual(
        v1GitNames,
      )
    }),
  )
  it.instance("file edit -> Git review -> stage -> commit shares provenance and preserves user changes", () =>
    Effect.gen(function* () {
      const test = yield* TestInstance
      yield* Effect.promise(async () => {
        for (const args of [
          ["init", "-b", "main"],
          ["config", "user.name", "V1"],
          ["config", "user.email", "v1@example.invalid"],
          ["config", "core.autocrlf", "false"],
        ])
          expect(
            await Bun.spawn(["git", ...args], { cwd: test.directory, stdout: "ignore", stderr: "ignore" }).exited,
          ).toBe(0)
        await fs.writeFile(path.join(test.directory, "task.txt"), "original\n")
        await fs.writeFile(path.join(test.directory, "user.txt"), "user original\n")
        for (const args of [
          ["add", "task.txt", "user.txt"],
          ["commit", "-m", "initial"],
        ])
          expect(
            await Bun.spawn(["git", ...args], { cwd: test.directory, stdout: "ignore", stderr: "ignore" }).exited,
          ).toBe(0)
        await fs.writeFile(path.join(test.directory, "user.txt"), "user dirty\n")
      })
      const registry = yield* ToolRegistry.Service
      const agents = yield* Agent.Service
      const agent = yield* agents.defaultInfo()
      const tools = yield* registry.tools({
        providerID: ProviderV2.ID.make("memory-local"),
        modelID: ModelV2.ID.make("gemma4:26b"),
        agent,
      })
      const context = {
        sessionID: SessionID.make("ses_git_v1"),
        messageID: MessageID.make("msg_git_v1"),
        agent: agent.name,
        abort: new AbortController().signal,
        messages: [],
        metadata: () => Effect.void,
        ask: () => Effect.void,
      } satisfies Tool.Context
      const invoke = (name: string, input: Record<string, unknown>) =>
        tools
          .find((item) => item.id === name)!
          .execute(input, context)
          .pipe(Effect.map((result) => JSON.parse(result.output) as Record<string, unknown>))
      yield* invoke("fs.read", { path: "task.txt" })
      yield* invoke("fs.edit", { path: "task.txt", oldString: "original", newString: "agent" })
      const review = yield* invoke("git.diff", { paths: ["task.txt"] })
      expect((yield* invoke("git.stage", { paths: ["task.txt"], reviewId: review.reviewId })).ok).toBe(true)
      const staged = yield* invoke("git.diff", { staged: true })
      const commit = yield* invoke("git.commit", { message: "fix: v1", reviewId: staged.reviewId })
      expect(commit.filesChanged).toEqual(["task.txt"])
      expect((yield* invoke("git.status", {})).clean).toBe(false)
      expect((yield* invoke("git.push", { remote: "origin", branch: "main", force: true })).code).toBe(
        "FORCE_GIT_DENIED",
      )
      expect((yield* invoke("git.branch.create", { branch: "--force" })).code).toBe("INVALID_BRANCH_NAME")
    }),
  )
  it.instance("mandatory Git approval overrides broad allow and saved approvals; deny stays deny", () =>
    Effect.gen(function* () {
      const permission = yield* Permission.Service
      const input = {
        sessionID: SessionID.make("ses_ask_git"),
        permission: "bash",
        patterns: ["git.push"],
        always: ["git.push"],
        metadata: { requireApproval: true, remote: "origin", branch: "main" },
        ruleset: [{ permission: "bash", pattern: "*", action: "allow" as const }],
      }
      for (const attempt of [1, 2]) {
        const fiber = yield* permission.ask(input).pipe(Effect.forkScoped)
        const request = yield* pollWithTimeout(
          permission.list().pipe(Effect.map((items) => items[0])),
          "mandatory Git approval did not ask",
        )
        expect(request.metadata).toMatchObject({ requireApproval: true, remote: "origin" })
        yield* permission.reply({ requestID: request.id, reply: attempt === 1 ? "always" : "once" })
        yield* Fiber.join(fiber)
      }
      const denied = yield* permission
        .ask({ ...input, ruleset: [{ permission: "bash", pattern: "*", action: "deny" }] })
        .pipe(Effect.flip)
      expect(denied).toBeInstanceOf(PermissionV1.DeniedError)
    }),
  )
})
