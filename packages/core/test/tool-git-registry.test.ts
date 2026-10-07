import { describe, expect } from "bun:test"
import fs from "node:fs/promises"
import path from "node:path"
import { Effect, Layer, Scope } from "effect"
import { AppNodeBuilder } from "@opencode-ai/core/effect/app-node-builder"
import { LayerNode } from "@opencode-ai/core/effect/layer-node"
import { Location } from "@opencode-ai/core/location"
import { PermissionV2 } from "@opencode-ai/core/permission"
import { AbsolutePath } from "@opencode-ai/core/schema"
import { SessionV2 } from "@opencode-ai/core/session"
import { ToolRegistry } from "@opencode-ai/core/tool/registry"
import { ToolOutputStore } from "@opencode-ai/core/tool-output-store"
import { ManagedGitTools } from "@opencode-ai/core/tool/git-tools"
import { v2GitNames } from "@opencode-ai/core/tool/managed-git"
import { WorkspaceFiles } from "@opencode-ai/core/tool/workspace-files"
import { location } from "./fixture/location"
import { tmpdir } from "./fixture/tmpdir"
import { testEffect } from "./lib/effect"
import { toolIdentity } from "./lib/tool"

const it = testEffect(Layer.empty)
const sessionID = SessionV2.ID.make("ses_phase9d")
const withTools = <A, E>(
  body: (
    registry: ToolRegistry.Interface,
    root: string,
    assertions: PermissionV2.AssertInput[],
  ) => Effect.Effect<A, E, Scope.Scope>,
) =>
  Effect.acquireUseRelease(
    Effect.promise(() => tmpdir()),
    (tmp) => {
      const assertions: PermissionV2.AssertInput[] = []
      const permission = Layer.succeed(
        PermissionV2.Service,
        PermissionV2.Service.of({
          assert: (input) => Effect.sync(() => assertions.push(input)).pipe(Effect.asVoid),
          ask: () => Effect.die("unused"),
          reply: () => Effect.die("unused"),
          get: () => Effect.die("unused"),
          forSession: () => Effect.die("unused"),
          list: () => Effect.die("unused"),
        }),
      )
      return ToolRegistry.Service.use((registry) => body(registry, tmp.path, assertions)).pipe(
        Effect.provide(
          AppNodeBuilder.build(LayerNode.group([ToolRegistry.node, ToolRegistry.toolsNode, ManagedGitTools.node]), [
            [
              Location.node,
              Layer.succeed(
                Location.Service,
                Location.Service.of(location({ directory: AbsolutePath.make(tmp.path) })),
              ),
            ],
            [PermissionV2.node, permission],
            [ToolOutputStore.node, ToolOutputStore.nodeWithoutConfig],
          ]),
        ),
      )
    },
    (tmp) => Effect.promise(() => tmp[Symbol.asyncDispose]()),
  )

describe("Phase 9D V2 canonical Git leaves", () => {
  it.live("catalog is canonical and filters read/bash denials", () =>
    withTools((registry) =>
      Effect.gen(function* () {
        expect((yield* registry.materialize()).definitions.map((item) => item.name)).toEqual(v2GitNames)
        expect(
          (yield* registry.materialize([{ action: "*", resource: "*", effect: "deny" }])).definitions,
        ).toHaveLength(0)
        const readonly = yield* registry.materialize([{ action: "bash", resource: "*", effect: "deny" }])
        expect(readonly.definitions.map((item) => item.name)).toEqual([
          "git_status",
          "git_diff",
          "git_log",
          "git_branch_list",
          "git_remote_list",
        ])
      }),
    ),
  )
  it.live("stage/commit uses canonical context, workspace journal and separate review", () =>
    withTools((registry, root, assertions) =>
      Effect.gen(function* () {
        yield* Effect.promise(async () => {
          for (const args of [
            ["init", "-b", "main"],
            ["config", "user.name", "V2"],
            ["config", "user.email", "v2@example.invalid"],
            ["config", "core.autocrlf", "false"],
          ]) {
            const child = Bun.spawn(["git", ...args], { cwd: root, stdout: "ignore", stderr: "ignore" })
            expect(await child.exited).toBe(0)
          }
          await fs.writeFile(path.join(root, "file.txt"), "initial\n")
          for (const args of [
            ["add", "file.txt"],
            ["commit", "-m", "initial"],
          ])
            expect(await Bun.spawn(["git", ...args], { cwd: root, stdout: "ignore", stderr: "ignore" }).exited).toBe(0)
          const files = new WorkspaceFiles(root)
          await files.read(sessionID, { path: "file.txt" })
          await files.commit(
            sessionID,
            "turn",
            await files.prepare(sessionID, "edit", { path: "file.txt", oldString: "initial", newString: "agent" }),
          )
        })
        const catalog = yield* registry.materialize()
        const invoke = (name: string, input: Record<string, unknown>) =>
          catalog
            .settle({ sessionID, ...toolIdentity, call: { type: "tool-call", name, id: name, input } })
            .pipe(Effect.map((value) => JSON.parse(String(value.result.value)) as Record<string, unknown>))
        const review = yield* invoke("git_diff", { paths: ["file.txt"] })
        expect((yield* invoke("git_stage", { paths: ["file.txt"], reviewId: review.reviewId })).ok).toBe(true)
        const staged = yield* invoke("git_diff", { staged: true })
        const commit = yield* invoke("git_commit", { message: "fix: v2", reviewId: staged.reviewId })
        expect(commit.ok).toBe(true)
        expect(commit.filesChanged).toEqual(["file.txt"])
        yield* Effect.promise(() => fs.writeFile(path.join(root, "file.txt"), "discard only after approval\n"))
        const restoreReview = yield* invoke("git_diff", { paths: ["file.txt"] })
        expect((yield* invoke("git_restore", { paths: ["file.txt"], reviewId: restoreReview.reviewId })).ok).toBe(true)
        const restoreRequest = assertions.find((item) => item.resources.includes("git.restore"))
        expect(restoreRequest?.metadata).toMatchObject({ requireApproval: true })
        expect(restoreRequest?.resources.join(" ")).toContain("paths=file.txt")
        expect(restoreRequest?.resources.join(" ")).toContain("DISCARDS_SELECTED_WORKTREE_CHANGES")
        expect(assertions.find((item) => item.resources.includes("git.commit"))).toMatchObject({
          action: "bash",
          source: { type: "tool", callID: "git_commit" },
        })
        expect((yield* invoke("git_push", { remote: "origin", branch: "main", force: true })).code).toBe(
          "FORCE_GIT_DENIED",
        )
        expect((yield* invoke("git_diff", { paths: ["../outside"] })).ok).toBe(false)
      }),
    ),
  )
})
