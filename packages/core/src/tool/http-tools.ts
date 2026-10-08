export * as ManagedHttpTools from "./http-tools"
import { Context, Effect, Layer, Schema } from "effect"
import { makeLocationNode } from "../effect/app-node"
import { PermissionV2 } from "../permission"
import { Tool } from "./tool"
import { ToolRegistry } from "./registry"
import { Tools } from "./tools"
import { ManagedHttp, httpDescription, httpFailure, httpApprovalResources } from "./managed-http"
import { HttpError } from "./http-network"

export const HttpRequestInput = Schema.Struct({
  method: Schema.optional(Schema.Literals(["GET", "HEAD", "POST", "PUT", "PATCH", "DELETE"])),
  url: Schema.String,
  query: Schema.optional(Schema.Record(Schema.String, Schema.String)),
  headers: Schema.optional(Schema.Record(Schema.String, Schema.String)),
  body: Schema.optional(Schema.Unknown),
  contentType: Schema.optional(
    Schema.Literals(["application/json", "text/plain", "application/x-www-form-urlencoded"]),
  ),
  timeoutMs: Schema.optional(Schema.Int),
  credentialProfile: Schema.optional(Schema.String),
})
export class Runtime extends Context.Service<Runtime, ReturnType<typeof ManagedHttp.make>>()("@opencode/ManagedHttp") {}
export const runtimeNode = makeLocationNode({
  service: Runtime,
  layer: Layer.sync(Runtime, () => ManagedHttp.make()),
  deps: [],
})
const layer = Layer.effectDiscard(
  Effect.gen(function* () {
    const tools = yield* Tools.Service
    const runtime = yield* Runtime
    const permission = yield* PermissionV2.Service
    yield* tools
      .register({
        http_request: Tool.withPermission(
          Tool.make({
            description: httpDescription,
            input: HttpRequestInput,
            output: Schema.String,
            execute: (args, context) =>
              runtime
                .invoke({
                  args,
                  sessionID: context.sessionID,
                  turnID: context.turnID ?? context.assistantMessageID,
                  authorize: (resource, metadata) =>
                    permission
                      .assert({
                        action: "http",
                        resources: httpApprovalResources(resource, metadata),
                        save: [],
                        metadata,
                        sessionID: context.sessionID,
                        agent: context.agent,
                        source: { type: "tool", messageID: context.assistantMessageID, callID: context.toolCallID },
                      })
                      .pipe(Effect.mapError(() => new HttpError("PERMISSION_DENIED"))),
                })
                .pipe(
                  Effect.catch((error) => Effect.succeed(httpFailure(error))),
                  Effect.map((result) => JSON.stringify(result)),
                ),
          }),
          "http",
        ),
      })
      .pipe(Effect.orDie)
  }),
)
export const node = makeLocationNode({
  name: "tool/managed-http",
  layer,
  deps: [ToolRegistry.node, runtimeNode, PermissionV2.node],
})
