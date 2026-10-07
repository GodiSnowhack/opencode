import { describe, expect } from "bun:test"
import fs from "node:fs/promises"
import path from "node:path"
import { Effect, Layer } from "effect"
import { AppNodeBuilder } from "@opencode-ai/core/effect/app-node-builder"
import { LayerNode } from "@opencode-ai/core/effect/layer-node"
import { Location } from "@opencode-ai/core/location"
import { PermissionV2 } from "@opencode-ai/core/permission"
import { AbsolutePath } from "@opencode-ai/core/schema"
import { SessionV2 } from "@opencode-ai/core/session"
import { ToolRegistry } from "@opencode-ai/core/tool/registry"
import { ToolOutputStore } from "@opencode-ai/core/tool-output-store"
import { ManagedWorkspaceTools } from "@opencode-ai/core/tool/managed-workspace"
import { workspaceOperation } from "@opencode-ai/core/tool/workspace-operations"
import { WorkspaceFiles, WorkspaceFileError } from "@opencode-ai/core/tool/workspace-files"
import { Ripgrep } from "@opencode-ai/core/ripgrep"
import { executeBounded } from "@opencode-ai/core/tool/turn-budget"
import { location } from "./fixture/location"
import { tmpdir } from "./fixture/tmpdir"
import { testEffect } from "./lib/effect"
import { toolIdentity } from "./lib/tool"

const it = testEffect(Layer.empty)
const sessionID = SessionV2.ID.make("ses_phase9b")
const withTools = <A, E>(
  body: (registry: ToolRegistry.Interface, root: string, assertions: PermissionV2.AssertInput[]) => Effect.Effect<A, E>,
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
          AppNodeBuilder.build(
            LayerNode.group([ToolRegistry.node, ToolRegistry.toolsNode, ManagedWorkspaceTools.node]),
            [
              [
                Location.node,
                Layer.succeed(
                  Location.Service,
                  Location.Service.of(location({ directory: AbsolutePath.make(tmp.path) })),
                ),
              ],
              [PermissionV2.node, permission],
              [ToolOutputStore.node, ToolOutputStore.nodeWithoutConfig],
            ],
          ),
        ),
      )
    },
    (tmp) => Effect.promise(() => tmp[Symbol.asyncDispose]()),
  )

describe("Phase 9B canonical V2 workspace tools", () => {
  it.live("registers bounded file catalog and hides writes when edit denied", () =>
    withTools((registry) =>
      Effect.gen(function* () {
        const catalog = yield* registry.materialize()
        expect(catalog.definitions.map((tool) => tool.name)).toEqual([
          "project_info",
          "fs_list",
          "fs_read",
          "fs_glob",
          "fs_search",
          "fs_write",
          "fs_edit",
        ])
        const denied = yield* registry.materialize([{ action: "edit", resource: "*", effect: "deny" }])
        expect(denied.definitions.map((tool) => tool.name)).not.toContain("fs_write")
        expect(denied.definitions.map((tool) => tool.name)).not.toContain("fs_edit")
      }),
    ),
  )

  it.live("creates, reads and edits via registry with existing permissions and trusted turn", () =>
    withTools((registry, root, assertions) =>
      Effect.gen(function* () {
        const catalog = yield* registry.materialize()
        const execute = (name: string, input: unknown) =>
          catalog.settle({
            sessionID,
            ...toolIdentity,
            turnID: "trusted-turn",
            call: { type: "tool-call", name, id: `call-${name}`, input },
          })
        const created = yield* execute("fs_write", { path: "info.txt", content: "TEST_MODE = local\n" })
        expect(created.result).toMatchObject({ type: "text" })
        expect(created.result.value).toContain('"operation":"create"')
        yield* execute("fs_read", { path: "info.txt" })
        const edited = yield* execute("fs_edit", { path: "info.txt", oldString: "local", newString: "phase9b" })
        expect(edited.result.value).toContain('"ok":true')
        expect(yield* Effect.promise(() => fs.readFile(path.join(root, "info.txt"), "utf8"))).toBe(
          "TEST_MODE = phase9b\n",
        )
        expect(assertions.map((item) => item.action)).toEqual(["edit", "read", "edit"])
        expect(assertions[2]).toMatchObject({
          sessionID,
          agent: "build",
          resources: ["info.txt"],
          source: { type: "tool", callID: "call-fs_edit" },
        })
        expect(JSON.stringify(edited.result)).not.toContain(root)
      }),
    ),
  )

  it.live("searches and globs with native Ripgrep, bounds output and does not follow junctions", () =>
    withTools((registry, root) =>
      Effect.gen(function* () {
        yield* Effect.promise(() => fs.writeFile(path.join(root, "info.txt"), "TEST_MODE = local\nother\n"))
        yield* Effect.promise(() =>
          fs.symlink(path.dirname(root), path.join(root, "escape"), process.platform === "win32" ? "junction" : "dir"),
        )
        const catalog = yield* registry.materialize()
        const execute = (name: string, input: unknown) =>
          catalog.settle({
            sessionID,
            ...toolIdentity,
            turnID: "t",
            call: { type: "tool-call", id: name, name, input },
          })
        const search = yield* execute("fs_search", { pattern: "TEST_MODE", limit: 1 })
        expect(search.result.value).toContain("TEST_MODE = local")
        expect(search.result.value).not.toContain("escape/")
        const glob = yield* execute("fs_glob", { pattern: "*.txt" })
        expect(glob.result.value).toContain("info.txt")
        expect(glob.result.value).not.toContain("escape/")
        const invalid = yield* execute("fs_search", { pattern: "[", regex: true })
        expect(invalid.result.value).toContain("INVALID_ARGUMENT")
      }),
    ),
  )

  it.live("permission rejection and model-supplied approval cannot authorize a write", () =>
    Effect.acquireUseRelease(
      Effect.promise(() => tmpdir()),
      (tmp) =>
        Effect.gen(function* () {
          const search = yield* Ripgrep.Service
          const result = yield* workspaceOperation({
            files: new WorkspaceFiles(tmp.path),
            search,
            kind: "write",
            args: { path: "new.txt", content: "secret" },
            sessionID: "s",
            turnID: "t",
            authorize: () => Effect.fail(new WorkspaceFileError("PERMISSION_DENIED")),
          })
          expect(result.output).toBe('{"ok":false,"code":"PERMISSION_DENIED"}')
          expect(yield* Effect.promise(() => fs.readdir(tmp.path))).not.toContain("new.txt")
        }).pipe(Effect.provide(LayerNode.compile(Ripgrep.node))),
      (tmp) => Effect.promise(() => tmp[Symbol.asyncDispose]()),
    ),
  )
  it.live("timeout while permission is pending never creates the file", () =>
    Effect.acquireUseRelease(
      Effect.promise(() => tmpdir()),
      (tmp) =>
        Effect.gen(function* () {
          const search = yield* Ripgrep.Service
          const operation = workspaceOperation({
            files: new WorkspaceFiles(tmp.path),
            search,
            kind: "write",
            args: { path: "new.txt", content: "secret" },
            sessionID: "s",
            turnID: "t",
            authorize: () => Effect.never,
          })
          const exit = yield* executeBounded(operation, undefined, 10).pipe(Effect.exit)
          expect(exit._tag).toBe("Failure")
          expect(yield* Effect.promise(() => fs.readdir(tmp.path))).not.toContain("new.txt")
        }).pipe(Effect.provide(LayerNode.compile(Ripgrep.node))),
      (tmp) => Effect.promise(() => tmp[Symbol.asyncDispose]()),
    ),
  )
})
