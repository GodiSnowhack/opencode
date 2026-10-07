import { Cause, Context, Effect, Exit, Layer } from "effect"
import { InstanceState } from "@/effect/instance-state"
import { LayerNode } from "@opencode-ai/core/effect/layer-node"
import { Git } from "@opencode-ai/core/git"
import { AppProcess } from "@opencode-ai/core/process"
import {
  ManagedGit,
  gitKinds,
  v1GitNames,
  gitPermission,
  gitFailure,
  GitError,
  gitApprovalResources,
  type GitInput,
} from "@opencode-ai/core/tool/managed-git"
import { gitSchemas, gitDescription } from "@opencode-ai/core/tool/git-tools"
import { Tool } from "./tool"
class Runtime extends Context.Service<Runtime, InstanceState.InstanceState<ReturnType<typeof ManagedGit.make>>>()(
  "@opencode/ManagedGit",
) {}
export const gitNode = LayerNode.make({
  service: Runtime,
  layer: Layer.effect(
    Runtime,
    Effect.gen(function* () {
      const git = yield* Git.Service
      const app = yield* AppProcess.Service
      return yield* InstanceState.make((ctx) => Effect.succeed(ManagedGit.make(ctx.directory, git, app)))
    }),
  ),
  deps: [Git.node, AppProcess.node],
})
export const gitTools = gitKinds.map((kind, index) =>
  Tool.define(
    v1GitNames[index],
    Effect.gen(function* () {
      const state = yield* Runtime
      return {
        version: "1",
        category: "git",
        risk: gitPermission(kind) === "read" ? ("READ" as const) : ("EXTERNAL_ACTION" as const),
        permission: gitPermission(kind),
        availability: "AVAILABLE" as const,
        timeoutMs: 180_000,
        cancellable: true,
        description: gitDescription(kind),
        parameters: gitSchemas[kind],
        execute: (args: GitInput, ctx: Tool.Context) =>
          Effect.gen(function* () {
            const runtime = yield* InstanceState.get(state)
            const result = yield* runtime
              .invoke({
                kind,
                args,
                sessionID: ctx.sessionID,
                authorize: (action, resource, metadata) =>
                  ctx
                    .ask({
                      permission: action,
                      patterns: gitApprovalResources(resource, metadata),
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
                            : Effect.fail(new GitError("PERMISSION_DENIED")),
                      ),
                    ),
              })
              .pipe(Effect.catch((error) => Effect.succeed(gitFailure(error))))
            yield* Effect.logInfo("managed_git", {
              tool: v1GitNames[index],
              sessionID: ctx.sessionID,
              ok: result.ok,
              code: "code" in result ? result.code : undefined,
            })
            return {
              title: `Git ${kind}`,
              output: JSON.stringify(result),
              metadata: {
                truncated: "truncated" in result ? !!result.truncated : false,
                errorCode: "code" in result ? result.code : undefined,
              },
            }
          }),
      }
    }),
  ),
)
