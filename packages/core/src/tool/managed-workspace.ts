export * as ManagedWorkspaceTools from "./managed-workspace"

import { Effect, Layer, Schema } from "effect"
import { makeLocationNode } from "../effect/app-node"
import { Location } from "../location"
import { PermissionV2 } from "../permission"
import { Ripgrep } from "../ripgrep"
import { MemoryGateway } from "../memory/gateway"
import { WorkspaceFiles, WorkspaceFileError } from "./workspace-files"
import {
  workspaceKinds,
  v2WorkspaceNames,
  workspaceOperation,
  workspaceSchemas,
  workspaceDescriptions,
  workspacePermission,
  workspaceRisk,
} from "./workspace-operations"
import { Tools } from "./tools"
import { ToolRegistry } from "./registry"
import { Tool } from "./tool"

const layer = Layer.effectDiscard(
  Effect.gen(function* () {
    const tools = yield* Tools.Service
    const location = yield* Location.Service
    const permission = yield* PermissionV2.Service
    const search = yield* Ripgrep.Service
    const files = new WorkspaceFiles(location.project.id === "global" ? location.directory : location.project.directory)
    for (const [index, kind] of workspaceKinds.entries()) {
      yield* tools
        .register({
          [v2WorkspaceNames[index]]: Tool.withPermission(
            Tool.make({
              description: workspaceDescriptions[kind],
              input: workspaceSchemas[kind],
              output: Schema.String,
              execute: (args, ctx) =>
                Effect.gen(function* () {
                  const started = Date.now()
                  const result = yield* workspaceOperation({
                    files,
                    search,
                    kind,
                    args,
                    sessionID: ctx.sessionID,
                    turnID: ctx.turnID ?? ctx.assistantMessageID,
                    authorize: (action, resource, metadata) =>
                      permission
                        .assert({
                          action,
                          resources: [resource],
                          save: ["*"],
                          metadata,
                          sessionID: ctx.sessionID,
                          agent: ctx.agent,
                          source: { type: "tool", messageID: ctx.assistantMessageID, callID: ctx.toolCallID },
                        })
                        .pipe(Effect.mapError(() => new WorkspaceFileError("PERMISSION_DENIED"))),
                  })
                  yield* Effect.logInfo("agent_tool_invocation", {
                    invocationId: ctx.toolCallID,
                    sessionId: ctx.sessionID,
                    projectId: MemoryGateway.effectiveProjectID({
                      projectID: location.project.id,
                      projectRoot: location.project.directory,
                      directory: location.directory,
                    }),
                    tool: v2WorkspaceNames[index],
                    version: "1",
                    risk: workspaceRisk(kind),
                    permission: ["PERMISSION_DENIED", "PATH_OUTSIDE_WORKSPACE"].includes(
                      result.metadata.errorCode ?? "",
                    )
                      ? "DENY"
                      : "ALLOW",
                    durationMs: Date.now() - started,
                    status: "errorCode" in result.metadata ? "error" : "success",
                    errorCode: result.metadata.errorCode,
                    path: "path" in result.metadata ? result.metadata.path : undefined,
                    bytesChanged: "bytesChanged" in result.metadata ? result.metadata.bytesChanged : undefined,
                  })
                  return result.output
                }),
            }),
            workspacePermission(kind),
          ),
        })
        .pipe(Effect.orDie)
    }
  }),
)

export const node = makeLocationNode({
  name: "tool/managed-workspace",
  layer,
  deps: [ToolRegistry.node, Location.node, PermissionV2.node, Ripgrep.node],
})
