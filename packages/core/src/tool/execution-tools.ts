export * as ManagedExecutionTools from "./execution-tools"

import { Context, Effect, Layer, Schema } from "effect"
import { makeLocationNode } from "../effect/app-node"
import { Location } from "../location"
import { PermissionV2 } from "../permission"
import { AppProcess } from "../process"
import { CommandError, commandFailure, EXECUTION_GUIDANCE } from "./command-policy"
import { ManagedExecution, type ExecutionKind } from "./managed-execution"
import { Tools } from "./tools"
import { ToolRegistry } from "./registry"
import { Tool } from "./tool"

export const executionKinds = ["exec", "test", "start", "status", "stop"] as const
export const v1ExecutionNames = ["shell.exec", "test.run", "process.start", "process.status", "process.stop"]
export const v2ExecutionNames = ["shell_exec", "test_run", "process_start", "process_status", "process_stop"]
export const executionSchemas = {
  exec: Schema.Struct({
    command: Schema.String,
    cwd: Schema.optional(Schema.String),
    timeoutMs: Schema.optional(Schema.Int),
  }),
  test: Schema.Struct({
    command: Schema.String,
    cwd: Schema.optional(Schema.String),
    timeoutMs: Schema.optional(Schema.Int),
  }),
  start: Schema.Struct({
    command: Schema.String,
    cwd: Schema.optional(Schema.String),
    timeoutMs: Schema.optional(Schema.Int),
  }),
  status: Schema.Struct({ processId: Schema.String }),
  stop: Schema.Struct({ processId: Schema.String }),
}
export const executionDescription = (kind: ExecutionKind) =>
  `${
    {
      exec: "Execute one literal project command; return separate bounded stdout/stderr, exit code and timeout state.",
      test: "Run a focused project test command; nonzero exit is a failure, not a passing test.",
      start:
        "Start an owned background dev process. Returns immediately with an opaque session-bound processId. Max lifetime 10 minutes, max 4 running jobs.",
      status:
        "Inspect your session's processId and bounded recent stdout/stderr. Handles are process-local and disappear on runtime shutdown.",
      stop: "Stop your owned processId and its child tree. Arbitrary operating-system PIDs are never accepted.",
    }[kind]
  } ${EXECUTION_GUIDANCE}`
export const executionTimeout = (name: string) =>
  name.startsWith("git_") || name.startsWith("git.")
    ? 180_000
    : /^(shell[._]exec|test[._]run)$/.test(name)
      ? 310_000
      : 10_000

export class Runtime extends Context.Service<Runtime, Effect.Success<ReturnType<typeof ManagedExecution.make>>>()(
  "@opencode/ManagedExecutionV2",
) {}
export const runtimeNode = makeLocationNode({
  service: Runtime,
  layer: Layer.effect(
    Runtime,
    Effect.gen(function* () {
      const location = yield* Location.Service
      const app = yield* AppProcess.Service
      return yield* ManagedExecution.make(
        location.project.id === "global" ? location.directory : location.project.directory,
        app,
      )
    }),
  ),
  deps: [Location.node, AppProcess.node],
})

const layer = Layer.effectDiscard(
  Effect.gen(function* () {
    const tools = yield* Tools.Service
    const permission = yield* PermissionV2.Service
    const runtime = yield* Runtime
    for (const [index, kind] of executionKinds.entries()) {
      yield* tools
        .register({
          [v2ExecutionNames[index]]: Tool.withPermission(
            Tool.make({
              description: executionDescription(kind),
              input: executionSchemas[kind],
              output: Schema.String,
              execute: (args, ctx) =>
                runtime
                  .invoke({
                    kind,
                    args,
                    sessionID: ctx.sessionID,
                    authorize: (command, risk) =>
                      permission
                        .assert({
                          action: "bash",
                          resources: [command],
                          save: [command],
                          metadata: { risk },
                          sessionID: ctx.sessionID,
                          agent: ctx.agent,
                          source: { type: "tool", messageID: ctx.assistantMessageID, callID: ctx.toolCallID },
                        })
                        .pipe(Effect.mapError(() => new CommandError("PERMISSION_DENIED"))),
                  })
                  .pipe(
                    Effect.catch((error) => Effect.succeed(commandFailure(error))),
                    Effect.tap((result) =>
                      Effect.logInfo("managed_execution", {
                        tool: v2ExecutionNames[index],
                        sessionId: ctx.sessionID,
                        code: "code" in result ? result.code : undefined,
                        risk: "risk" in result ? result.risk : undefined,
                        exitCode: "exitCode" in result ? result.exitCode : undefined,
                        durationMs: "durationMs" in result ? result.durationMs : undefined,
                        cwd: "cwd" in result ? result.cwd : undefined,
                        command: "command" in result ? result.command : undefined,
                        processId: "processId" in result ? result.processId : undefined,
                        timedOut: "timedOut" in result ? result.timedOut : undefined,
                        cancelled: "cancelled" in result ? result.cancelled : undefined,
                      }),
                    ),
                    Effect.map((result) => JSON.stringify(result)),
                  ),
            }),
            "bash",
          ),
        })
        .pipe(Effect.orDie)
    }
  }),
)
export const node = makeLocationNode({
  name: "tool/managed-execution",
  layer,
  deps: [ToolRegistry.node, runtimeNode, PermissionV2.node],
})
