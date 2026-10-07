import { Cause, Context, Effect, Exit, Layer } from "effect"
import { InstanceState } from "@/effect/instance-state"
import { LayerNode } from "@opencode-ai/core/effect/layer-node"
import { Ripgrep } from "@opencode-ai/core/ripgrep"
import { WorkspaceFiles, WorkspaceFileError, type FileInput } from "@opencode-ai/core/tool/workspace-files"
import {
  workspaceOperation,
  workspaceSchemas,
  workspaceDescriptions,
  workspacePermission,
  workspaceRisk,
  type WorkspaceKind,
} from "@opencode-ai/core/tool/workspace-operations"
import { TOOL_TIMEOUT_MS } from "./turn-budget"
import { Tool } from "./tool"

class Files extends Context.Service<Files, InstanceState.InstanceState<WorkspaceFiles>>()("@opencode/WorkspaceFiles") {}
const layer = Layer.effect(
  Files,
  InstanceState.make((ctx) =>
    Effect.succeed(new WorkspaceFiles(ctx.project.id === "global" ? ctx.directory : ctx.worktree)),
  ),
)
export const workspaceFilesNode = LayerNode.make({ service: Files, layer, deps: [] })

function define(name: string, kind: WorkspaceKind) {
  return Tool.define(
    name,
    Effect.gen(function* () {
      const state = yield* Files
      const search = yield* Ripgrep.Service
      return {
        version: "1",
        category: "workspace",
        risk: workspaceRisk(kind),
        permission: workspacePermission(kind),
        availability: "AVAILABLE" as const,
        timeoutMs: TOOL_TIMEOUT_MS,
        cancellable: true,
        description: workspaceDescriptions[kind],
        parameters: workspaceSchemas[kind],
        execute: (args: FileInput, ctx: Tool.Context) =>
          Effect.gen(function* () {
            const files = yield* InstanceState.get(state)
            return yield* workspaceOperation({
              files,
              search,
              kind,
              args,
              sessionID: ctx.sessionID,
              turnID: typeof ctx.extra?.turnID === "string" ? ctx.extra.turnID : ctx.messageID,
              signal: ctx.abort,
              authorize: (action, resource, metadata) =>
                Effect.gen(function* () {
                  const result = yield* ctx
                    .ask({ permission: action, patterns: [resource], always: ["*"], metadata: metadata ?? {} })
                    .pipe(Effect.exit)
                  if (Exit.isFailure(result)) {
                    if (Cause.hasInterrupts(result.cause)) return yield* Effect.failCause(result.cause)
                    return yield* Effect.fail(new WorkspaceFileError("PERMISSION_DENIED"))
                  }
                  return undefined
                }),
            })
          }),
      }
    }),
  )
}

export const ProjectInfoTool = define("project.info", "info")
export const WorkspaceListTool = define("fs.list", "list")
export const WorkspaceReadTool = define("fs.read", "read")
export const WorkspaceGlobTool = define("fs.glob", "glob")
export const WorkspaceSearchTool = define("fs.search", "search")
export const WorkspaceWriteTool = define("fs.write", "write")
export const WorkspaceEditTool = define("fs.edit", "edit")
