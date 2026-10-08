import { expect } from "bun:test"
import { Effect, Fiber } from "effect"
import { LayerNode } from "@opencode-ai/core/effect/layer-node"
import { ProviderV2 } from "@opencode-ai/core/provider"
import { ModelV2 } from "@opencode-ai/core/model"
import { PermissionV1 } from "@opencode-ai/core/v1/permission"
import { ToolRegistry } from "@/tool/registry"
import { Agent } from "@/agent/agent"
import { Permission } from "@/permission"
import { SessionID, MessageID } from "@/session/schema"
import { testEffect, pollWithTimeout } from "../lib/effect"

const it = testEffect(LayerNode.compile(LayerNode.group([ToolRegistry.node, Agent.node, Permission.node])))
it.instance(
  "V1 HTTP catalog is managed-only, denies before connection and rechecks Tools OFF",
  () =>
    Effect.gen(function* () {
      const registry = yield* ToolRegistry.Service
      const agents = yield* Agent.Service
      const agent = yield* agents.defaultInfo()
      const old = process.env.OPENCODE_AGENT_TOOLS_ENABLED
      process.env.OPENCODE_AGENT_TOOLS_ENABLED = "true"
      yield* Effect.addFinalizer(() =>
        Effect.sync(() => {
          if (old === undefined) delete process.env.OPENCODE_AGENT_TOOLS_ENABLED
          else process.env.OPENCODE_AGENT_TOOLS_ENABLED = old
        }),
      )
      for (const model of ["gemma4:26b-a4b-it-q4_K_M", "qwen3-coder:30b"]) {
        const tools = yield* registry.tools({
          providerID: ProviderV2.ID.make("memory-local"),
          modelID: ModelV2.ID.make(model),
          agent,
        })
        const tool = tools.find((item) => item.id === "http.request")!
        expect(tool).toBeDefined()
        const context = {
          sessionID: SessionID.make("ses_http"),
          messageID: MessageID.make("msg_http"),
          agent: agent.name,
          abort: new AbortController().signal,
          messages: [],
          metadata: () => Effect.void,
          ask: (input: { metadata: Record<string, unknown> }) => {
            expect(input.metadata).toMatchObject({
              requireApproval: true,
              method: "POST",
              authorization: false,
              payloadBytes: 2,
            })
            return Effect.die(new Error("denied"))
          },
        }
        expect(
          JSON.parse(
            (yield* tool.execute({ url: "http://127.0.0.1:61111/items", method: "POST", body: {} }, context)).output,
          ).errorCode,
        ).toBe("PERMISSION_DENIED")
        process.env.OPENCODE_AGENT_TOOLS_ENABLED = "false"
        expect(
          JSON.parse((yield* tool.execute({ url: "http://127.0.0.1:61111/items" }, context)).output).errorCode,
        ).toBe("TOOLS_DISABLED")
        process.env.OPENCODE_AGENT_TOOLS_ENABLED = "true"
      }
      const ordinary = yield* registry.tools({
        providerID: ProviderV2.ID.make("other"),
        modelID: ModelV2.ID.make("model"),
        agent,
      })
      expect(ordinary.some((item) => item.id === "http.request")).toBe(false)
    }),
  { timeout: 30000 },
)

it.instance(
  "HTTP mandatory confirmation overrides broad/saved allow; configured deny stays deny",
  () =>
    Effect.gen(function* () {
      const permission = yield* Permission.Service
      const input = {
        sessionID: SessionID.make("ses_http_ask"),
        permission: "http",
        patterns: ["POST http://127.0.0.1:61111/items"],
        always: [],
        metadata: { requireApproval: true, method: "POST", risk: "NETWORK_INTERNAL" },
        ruleset: [{ permission: "*", pattern: "*", action: "allow" as const }],
      }
      for (const attempt of [1, 2]) {
        const fiber = yield* permission.ask(input).pipe(Effect.forkScoped)
        const request = yield* pollWithTimeout(
          permission.list().pipe(Effect.map((items) => items[0])),
          "HTTP confirmation missing",
        )
        expect(request.metadata.requireApproval).toBe(true)
        yield* permission.reply({ requestID: request.id, reply: attempt === 1 ? "always" : "once" })
        yield* Fiber.join(fiber)
      }
      expect(
        yield* permission
          .ask({ ...input, ruleset: [{ permission: "http", pattern: "*", action: "deny" }] })
          .pipe(Effect.flip),
      ).toBeInstanceOf(PermissionV1.DeniedError)
    }),
  { timeout: 30000 },
)
