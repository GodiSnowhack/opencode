import { describe, expect } from "bun:test"
import fs from "node:fs/promises"
import path from "node:path"
import { Effect, Fiber, Layer, Scope } from "effect"
import { AppNodeBuilder } from "@opencode-ai/core/effect/app-node-builder"
import { LayerNode } from "@opencode-ai/core/effect/layer-node"
import { Location } from "@opencode-ai/core/location"
import { PermissionV2 } from "@opencode-ai/core/permission"
import { AbsolutePath } from "@opencode-ai/core/schema"
import { SessionV2 } from "@opencode-ai/core/session"
import { ToolRegistry } from "@opencode-ai/core/tool/registry"
import { ToolOutputStore } from "@opencode-ai/core/tool-output-store"
import { ManagedExecutionTools } from "@opencode-ai/core/tool/execution-tools"
import { location } from "./fixture/location"
import { tmpdir } from "./fixture/tmpdir"
import { testEffect } from "./lib/effect"
import { toolIdentity } from "./lib/tool"

const it = testEffect(Layer.empty)
const sessionID = SessionV2.ID.make("ses_phase9c")
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
          AppNodeBuilder.build(
            LayerNode.group([ToolRegistry.node, ToolRegistry.toolsNode, ManagedExecutionTools.node]),
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

describe("Phase 9C V2 canonical execution leaves", () => {
  it.live("advertises execution tools with bash permission filtering", () =>
    withTools((registry) =>
      Effect.gen(function* () {
        const catalog = yield* registry.materialize()
        expect(catalog.definitions.map((tool) => tool.name)).toEqual([
          "shell_exec",
          "test_run",
          "process_start",
          "process_status",
          "process_stop",
        ])
        const denied = yield* registry.materialize([{ action: "bash", resource: "*", effect: "deny" }])
        expect(denied.definitions).toHaveLength(0)
      }),
    ),
  )
  it.live("executes through upstream spawner and retains session permission source", () =>
    withTools((registry, root, assertions) =>
      Effect.gen(function* () {
        const catalog = yield* registry.materialize()
        const result = yield* catalog.settle({
          sessionID,
          ...toolIdentity,
          call: { type: "tool-call", name: "shell_exec", id: "exec1", input: { command: "echo Phase9C" } },
        })
        expect(JSON.parse(String(result.result.value))).toMatchObject({ ok: true, exitCode: 0, cwd: "." })
        expect(assertions[0]).toMatchObject({
          action: "bash",
          resources: ["echo Phase9C"],
          source: { type: "tool", callID: "exec1" },
        })
        expect(JSON.stringify(result)).not.toContain(root)
        const denied = yield* catalog.settle({
          sessionID,
          ...toolIdentity,
          call: { type: "tool-call", name: "shell_exec", id: "exec2", input: { command: "taskkill /pid 1" } },
        })
        expect(JSON.parse(String(denied.result.value))).toMatchObject({ ok: false, code: "COMMAND_DENIED" })
        expect(assertions).toHaveLength(1)
      }),
    ),
  )
  it.live(
    "V2 canonical settlement interruption physically stops executable process",
    () =>
      withTools((registry, root) =>
        Effect.gen(function* () {
          yield* Effect.promise(() =>
            fs.writeFile(
              path.join(root, "dev.js"),
              "require('fs').writeFileSync('pid.txt',String(process.pid));setInterval(()=>{},100)",
            ),
          )
          const catalog = yield* registry.materialize()
          const fiber = yield* Effect.forkScoped(
            catalog.settle({
              sessionID,
              ...toolIdentity,
              call: { type: "tool-call", name: "shell_exec", id: "cancel", input: { command: "node dev.js" } },
            }),
          )
          const pid = yield* Effect.promise(async () => {
            for (let n = 0; n < 100; n++) {
              const text = await fs.readFile(path.join(root, "pid.txt"), "utf8").catch(() => undefined)
              if (text) return Number(text)
              await new Promise((resolve) => setTimeout(resolve, 50))
            }
            throw new Error("process readiness missing")
          })
          yield* Fiber.interrupt(fiber)
          expect(() => process.kill(pid, 0)).toThrow()
        }),
      ),
    15_000,
  )
})
