import { Cause, Context, Effect, Exit, Layer } from "effect"
import { InstanceState } from "@/effect/instance-state"
import { LayerNode } from "@opencode-ai/core/effect/layer-node"
import {
  ManagedHttp,
  httpDescription,
  httpFailure,
  httpApprovalResources,
  type HttpInput,
} from "@opencode-ai/core/tool/managed-http"
import { HttpError } from "@opencode-ai/core/tool/http-network"
import { HttpRequestInput } from "@opencode-ai/core/tool/http-tools"
import { Tool } from "./tool"
class Runtime extends Context.Service<Runtime, InstanceState.InstanceState<ReturnType<typeof ManagedHttp.make>>>()(
  "@opencode/ManagedHttpV1",
) {}
export const httpNode = LayerNode.make({
  service: Runtime,
  layer: Layer.effect(
    Runtime,
    InstanceState.make(() => Effect.succeed(ManagedHttp.make())),
  ),
  deps: [],
})
export const HttpRequestTool = Tool.define(
  "http.request",
  Effect.gen(function* () {
    const state = yield* Runtime
    return {
      version: "1",
      category: "http",
      risk: "EXTERNAL_ACTION" as const,
      permission: "http",
      availability: "AVAILABLE" as const,
      timeoutMs: 35000,
      cancellable: true,
      description: httpDescription,
      parameters: HttpRequestInput,
      execute: (args: HttpInput, context: Tool.Context) =>
        Effect.gen(function* () {
          const runtime = yield* InstanceState.get(state)
          const result = yield* runtime
            .invoke({
              args,
              signal: context.abort,
              sessionID: context.sessionID,
              turnID: typeof context.extra?.turnID === "string" ? context.extra.turnID : context.messageID,
              authorize: (resource, metadata) =>
                context
                  .ask({
                    permission: "http",
                    patterns: httpApprovalResources(resource, metadata),
                    always: [],
                    metadata,
                  })
                  .pipe(
                    Effect.exit,
                    Effect.flatMap((exit) =>
                      Exit.isSuccess(exit)
                        ? Effect.void
                        : Cause.hasInterrupts(exit.cause)
                          ? Effect.failCause(exit.cause)
                          : Effect.fail(new HttpError("PERMISSION_DENIED")),
                    ),
                  ),
            })
            .pipe(Effect.catch((error) => Effect.succeed(httpFailure(error))))
          return {
            title: "HTTP",
            output: JSON.stringify(result),
            metadata: {
              truncated: "truncated" in result ? result.truncated : false,
              errorCode: "errorCode" in result ? result.errorCode : undefined,
              method: "method" in result ? result.method : undefined,
              status: "status" in result ? result.status : undefined,
              durationMs: "durationMs" in result ? result.durationMs : undefined,
              finalUrl: "finalUrl" in result ? result.finalUrl : undefined,
            },
          }
        }),
    }
  }),
)
