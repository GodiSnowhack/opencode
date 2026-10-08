import { expect } from "bun:test"
import { Effect, Layer } from "effect"
import { AppNodeBuilder } from "../src/effect/app-node-builder"
import { LayerNode } from "../src/effect/layer-node"
import { Location } from "../src/location"
import { PermissionV2 } from "../src/permission"
import { AbsolutePath } from "../src/schema"
import { SessionV2 } from "../src/session"
import { ToolRegistry } from "../src/tool/registry"
import { ToolOutputStore } from "../src/tool-output-store"
import { ManagedHttpTools } from "../src/tool/http-tools"
import { location } from "./fixture/location"
import { tmpdir } from "./fixture/tmpdir"
import { testEffect } from "./lib/effect"
import { toolIdentity } from "./lib/tool"

const it = testEffect(Layer.empty)
it.live("V2 canonical HTTP leaf filters permission, uses trusted context, and blocks stale Tools OFF calls", () =>
  Effect.acquireUseRelease(
    Effect.promise(() => tmpdir()),
    (tmp) =>
      Effect.gen(function* () {
        const seen: PermissionV2.AssertInput[] = []
        const permission = Layer.succeed(
          PermissionV2.Service,
          PermissionV2.Service.of({
            assert: (input) =>
              Effect.sync(() => {
                seen.push(input)
              }).pipe(Effect.andThen(Effect.fail(new PermissionV2.BlockedError({ rules: [] })))),
            ask: () => Effect.die("unused"),
            reply: () => Effect.die("unused"),
            get: () => Effect.die("unused"),
            forSession: () => Effect.die("unused"),
            list: () => Effect.die("unused"),
          }),
        )
        const old = process.env.OPENCODE_AGENT_TOOLS_ENABLED
        process.env.OPENCODE_AGENT_TOOLS_ENABLED = "true"
        yield* Effect.addFinalizer(() =>
          Effect.sync(() => {
            if (old === undefined) delete process.env.OPENCODE_AGENT_TOOLS_ENABLED
            else process.env.OPENCODE_AGENT_TOOLS_ENABLED = old
          }),
        )
        yield* ToolRegistry.Service.use((registry) =>
          Effect.gen(function* () {
            const catalog = yield* registry.materialize()
            expect(catalog.definitions.map((item) => item.name)).toEqual(["http_request"])
            expect(
              (yield* registry.materialize([{ action: "http", resource: "*", effect: "deny" }])).definitions,
            ).toHaveLength(0)
            const call = {
              sessionID: SessionV2.ID.make("ses_http_v2"),
              ...toolIdentity,
              turnID: "turn",
              call: {
                type: "tool-call" as const,
                id: "call_http",
                name: "http_request",
                input: { url: "http://127.0.0.1:61111/items", method: "POST", body: {} },
              },
            }
            const denied = yield* catalog.settle(call)
            expect(JSON.parse(String(denied.result.value)).errorCode).toBe("PERMISSION_DENIED")
            expect(seen[0]).toMatchObject({
              action: "http",
              source: { type: "tool", callID: "call_http" },
              metadata: { requireApproval: true, method: "POST" },
            })
            expect(seen[0].resources.join(" ")).toContain("NETWORK_INTERNAL")
            process.env.OPENCODE_AGENT_TOOLS_ENABLED = "false"
            expect(JSON.parse(String((yield* catalog.settle(call)).result.value)).errorCode).toBe("TOOLS_DISABLED")
            expect(seen).toHaveLength(1)
          }),
        ).pipe(
          Effect.provide(
            AppNodeBuilder.build(LayerNode.group([ToolRegistry.node, ToolRegistry.toolsNode, ManagedHttpTools.node]), [
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
      }),
    (tmp) => Effect.promise(() => tmp[Symbol.asyncDispose]()),
  ),
)
