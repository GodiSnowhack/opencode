import { Cause, Context, Effect, Exit, Layer } from "effect"
import { InstanceState } from "@/effect/instance-state"
import { LayerNode } from "@opencode-ai/core/effect/layer-node"
import { AppProcess } from "@opencode-ai/core/process"
import { ManagedExecution, type ExecutionInput, type ExecutionKind } from "@opencode-ai/core/tool/managed-execution"
import { CommandError, commandFailure } from "@opencode-ai/core/tool/command-policy"
import { executionDescription, executionSchemas, executionTimeout } from "@opencode-ai/core/tool/execution-tools"
import { Tool } from "./tool"

class Runtime extends Context.Service<
  Runtime,
  InstanceState.InstanceState<Effect.Success<ReturnType<typeof ManagedExecution.make>>>
>()("@opencode/ManagedExecution") {}
const layer = Layer.effect(
  Runtime,
  Effect.gen(function* () {
    const app = yield* AppProcess.Service
    return yield* InstanceState.make((ctx) =>
      ManagedExecution.make(ctx.project.id === "global" ? ctx.directory : ctx.worktree, app),
    )
  }),
)
export const executionNode = LayerNode.make({ service: Runtime, layer, deps: [AppProcess.node] })
export const executionSessionCleanup = Effect.gen(function* () {
  const state = yield* Runtime
  return (sessionID: string) =>
    Effect.gen(function* () {
      const runtime = yield* InstanceState.get(state)
      yield* runtime.stopSession(sessionID)
    })
})
function define(name: string, kind: ExecutionKind) {
  return Tool.define(
    name,
    Effect.gen(function* () {
      const state = yield* Runtime
      return {
        version: "1",
        category: "execution",
        risk: "EXTERNAL_ACTION" as const,
        permission: "bash",
        availability: "AVAILABLE" as const,
        timeoutMs: executionTimeout(name),
        cancellable: true,
        description: executionDescription(kind),
        parameters: executionSchemas[kind],
        execute: (args: ExecutionInput, ctx: Tool.Context) =>
          Effect.gen(function* () {
            const runtime = yield* InstanceState.get(state)
            const result = yield* runtime
              .invoke({
                kind,
                args,
                sessionID: ctx.sessionID,
                progress:
                  kind === "start"
                    ? undefined
                    : (result) =>
                        ctx.metadata({
                          title: result.command,
                          metadata: {
                            output: result.stdout + result.stderr,
                            risk: result.risk,
                            processId: result.processId,
                          },
                        }),
                authorize: (command, risk) =>
                  ctx
                    .ask({ permission: "bash", patterns: [command], always: [command], metadata: { command, risk } })
                    .pipe(
                      Effect.exit,
                      Effect.flatMap((exit) =>
                        Exit.isSuccess(exit)
                          ? Effect.void
                          : Cause.hasInterrupts(exit.cause)
                            ? Effect.failCause(exit.cause)
                            : Effect.fail(new CommandError("PERMISSION_DENIED")),
                      ),
                    ),
              })
              .pipe(Effect.catch((error) => Effect.succeed(commandFailure(error))))
            yield* Effect.logInfo("managed_execution", {
              tool: name,
              sessionId: ctx.sessionID,
              code: "code" in result ? result.code : undefined,
              risk: result.risk,
              command: "command" in result ? result.command : undefined,
              cwd: "cwd" in result ? result.cwd : undefined,
              processId: "processId" in result ? result.processId : undefined,
              exitCode: "exitCode" in result ? result.exitCode : undefined,
              durationMs: "durationMs" in result ? result.durationMs : undefined,
              timedOut: "timedOut" in result ? result.timedOut : undefined,
              cancelled: "cancelled" in result ? result.cancelled : undefined,
            })
            return {
              title: kind === "test" ? "Tests" : kind === "start" ? "Process started" : "Project command",
              output: JSON.stringify(result),
              metadata: {
                truncated: "truncated" in result ? result.truncated : false,
                errorCode: "code" in result ? result.code : undefined,
              },
            }
          }),
      }
    }),
  )
}
export const ShellExecTool = define("shell.exec", "exec")
export const TestRunTool = define("test.run", "test")
export const ProcessStartTool = define("process.start", "start")
export const ProcessStatusTool = define("process.status", "status")
export const ProcessStopTool = define("process.stop", "stop")
