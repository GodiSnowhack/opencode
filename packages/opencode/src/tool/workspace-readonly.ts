import path from "node:path"
import { realpath, stat } from "node:fs/promises"
import { Cause, Effect, Exit, Schema } from "effect"
import { InstanceState } from "@/effect/instance-state"
import type { InstanceContext } from "@/project/instance-context"
import { ReadTool } from "./read"
import * as Tool from "./tool"
import { TOOL_TIMEOUT_MS } from "./turn-budget"

const READ_TOOL_METADATA = {
  version: "1",
  category: "workspace",
  risk: "READ",
  permission: "read",
  availability: "AVAILABLE",
  timeoutMs: TOOL_TIMEOUT_MS,
  cancellable: true,
} as const

export type WorkspacePathErrorCode = "NOT_ALLOWED" | "NOT_FOUND"

export class WorkspacePathError extends Error {
  constructor(readonly code: WorkspacePathErrorCode) {
    super(code)
    this.name = "WorkspacePathError"
  }
}

// The model supplies only a relative name. Both the trusted root and target are
// canonicalized before the native OpenCode reader sees the path.
export async function workspacePath(root: string, relative: string) {
  if (
    !relative ||
    relative.includes("\0") ||
    relative.includes(":") ||
    path.posix.isAbsolute(relative) ||
    path.win32.isAbsolute(relative) ||
    relative.startsWith("\\\\") ||
    relative.split(/[\\/]+/u).includes("..")
  )
    throw new WorkspacePathError("NOT_ALLOWED")
  const workspace = await realpath(root)
  const target = path.resolve(workspace, ...relative.split(/[\\/]+/u))
  let canonical: string
  try {
    canonical = await realpath(target)
  } catch {
    throw new WorkspacePathError("NOT_FOUND")
  }
  const inside = path.relative(workspace, canonical)
  if (inside === ".." || inside.startsWith(`..${path.sep}`) || path.isAbsolute(inside))
    throw new WorkspacePathError("NOT_ALLOWED")
  return canonical
}

const location = (ctx: InstanceContext) => (ctx.project.id === "global" ? ctx.directory : ctx.worktree)

type ReadonlyMetadata = { errorCode?: string; truncated: boolean; count: number }
const metadata = (value: ReadonlyMetadata) => value

const failure = (error: unknown) => ({
  title: "Tool error",
  output: JSON.stringify({
    ok: false,
    code: error instanceof WorkspacePathError ? error.code : "EXECUTION_FAILED",
  }),
  metadata: metadata({
    errorCode: error instanceof WorkspacePathError ? error.code : "EXECUTION_FAILED",
    truncated: false,
    count: 0,
  }),
})

export const ProjectInfoTool = Tool.define(
  "project.info",
  Effect.succeed({
    ...READ_TOOL_METADATA,
    description: "Show safe information about the current project and read-only capabilities.",
    parameters: Schema.Struct({}),
    execute: (_args: Record<string, never>, _ctx: Tool.Context) =>
      Effect.gen(function* () {
        const instance = yield* InstanceState.context
        const root = location(instance)
        return {
          title: "Project information",
          output: JSON.stringify({
            name: path.basename(root),
            workspaceAvailable: true,
            platform: process.platform,
            capabilities: ["project.info", "fs.list", "fs.read"],
          }),
          metadata: { truncated: false },
        }
      }),
  }),
)

const ListParameters = Schema.Struct({
  path: Schema.optional(Schema.String),
  limit: Schema.optional(Schema.Int),
})

export const WorkspaceListTool = Tool.define(
  "fs.list",
  Effect.gen(function* () {
    const read = yield* ReadTool
    const native = yield* Tool.init(read)
    return {
      ...READ_TOOL_METADATA,
      description: "List entries in a relative directory inside the current workspace. Maximum 100 entries.",
      parameters: ListParameters,
      execute: (args: Schema.Schema.Type<typeof ListParameters>, ctx: Tool.Context) =>
        Effect.gen(function* () {
          try {
            if (args.limit !== undefined && (args.limit < 1 || args.limit > 100))
              return {
                title: "Tool error",
                output: '{"ok":false,"code":"INVALID_ARGUMENT"}',
                metadata: metadata({ errorCode: "INVALID_ARGUMENT", truncated: false, count: 0 }),
              }
            const instance = yield* InstanceState.context
            const target = yield* Effect.promise(() => workspacePath(location(instance), args.path ?? "."))
            if (!(yield* Effect.promise(() => stat(target))).isDirectory())
              return {
                title: "Tool error",
                output: '{"ok":false,"code":"INVALID_ARGUMENT"}',
                metadata: metadata({ errorCode: "INVALID_ARGUMENT", truncated: false, count: 0 }),
              }
            const allowed = yield* ctx
              .ask({ permission: "read", patterns: [args.path ?? "."], always: ["*"], metadata: {} })
              .pipe(Effect.exit)
            if (Exit.isFailure(allowed) && Cause.hasInterrupts(allowed.cause))
              return yield* Effect.failCause(allowed.cause)
            if (Exit.isFailure(allowed)) return failure(new WorkspacePathError("NOT_ALLOWED"))
            const result = yield* native.execute(
              { filePath: target, limit: args.limit ?? 100 },
              { ...ctx, ask: () => Effect.void },
            )
            const display = result.metadata.display
            const entries = display?.type === "directory" ? display.entries : []
            return {
              title: args.path ?? ".",
              output: JSON.stringify({
                ok: true,
                path: args.path ?? ".",
                entries,
                truncated: result.metadata.truncated,
                totalEntries: display?.type === "directory" ? display.totalEntries : entries.length,
              }),
              metadata: metadata({ truncated: result.metadata.truncated, count: entries.length }),
            }
          } catch (error) {
            return failure(error)
          }
        }).pipe(
          Effect.catchCause((cause) =>
            Cause.hasInterrupts(cause) ? Effect.failCause(cause) : Effect.succeed(failure(Cause.squash(cause))),
          ),
        ),
    }
  }),
)

const ReadParameters = Schema.Struct({
  path: Schema.String,
  startLine: Schema.optional(Schema.Int),
  maxLines: Schema.optional(Schema.Int),
})

export const WorkspaceReadTool = Tool.define(
  "fs.read",
  Effect.gen(function* () {
    const read = yield* ReadTool
    const native = yield* Tool.init(read)
    return {
      ...READ_TOOL_METADATA,
      description: "Read bounded UTF-8 text from a relative file in the current workspace.",
      parameters: ReadParameters,
      execute: (args: Schema.Schema.Type<typeof ReadParameters>, ctx: Tool.Context) =>
        Effect.gen(function* () {
          try {
            if (
              (args.startLine !== undefined && args.startLine < 1) ||
              (args.maxLines !== undefined && (args.maxLines < 1 || args.maxLines > 200))
            )
              return {
                title: "Tool error",
                output: '{"ok":false,"code":"INVALID_ARGUMENT"}',
                metadata: metadata({ errorCode: "INVALID_ARGUMENT", truncated: false, count: 0 }),
              }
            const instance = yield* InstanceState.context
            const target = yield* Effect.promise(() => workspacePath(location(instance), args.path))
            if (!(yield* Effect.promise(() => stat(target))).isFile())
              return {
                title: "Tool error",
                output: '{"ok":false,"code":"INVALID_ARGUMENT"}',
                metadata: metadata({ errorCode: "INVALID_ARGUMENT", truncated: false, count: 0 }),
              }
            const allowed = yield* ctx
              .ask({ permission: "read", patterns: [args.path], always: ["*"], metadata: {} })
              .pipe(Effect.exit)
            if (Exit.isFailure(allowed) && Cause.hasInterrupts(allowed.cause))
              return yield* Effect.failCause(allowed.cause)
            if (Exit.isFailure(allowed)) return failure(new WorkspacePathError("NOT_ALLOWED"))
            const result = yield* native.execute(
              { filePath: target, offset: args.startLine ?? 1, limit: args.maxLines ?? 200 },
              { ...ctx, ask: () => Effect.void },
            )
            if (result.attachments?.length)
              return {
                title: "Tool error",
                output: '{"ok":false,"code":"NOT_ALLOWED"}',
                metadata: metadata({ errorCode: "NOT_ALLOWED", truncated: false, count: 0 }),
              }
            return {
              title: args.path,
              output: JSON.stringify({
                ok: true,
                path: args.path,
                content: result.output.replaceAll(target, args.path),
                truncated: result.metadata.truncated,
              }),
              metadata: metadata({ truncated: result.metadata.truncated, count: 0 }),
            }
          } catch (error) {
            return failure(error)
          }
        }).pipe(
          Effect.catchCause((cause) =>
            Cause.hasInterrupts(cause) ? Effect.failCause(cause) : Effect.succeed(failure(Cause.squash(cause))),
          ),
        ),
    }
  }),
)
