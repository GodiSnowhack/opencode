export * as ManagedGitTools from "./git-tools"
import { Context, Effect, Layer, Schema } from "effect"
import { makeLocationNode } from "../effect/app-node"
import { Location } from "../location"
import { Git } from "../git"
import { AppProcess } from "../process"
import { PermissionV2 } from "../permission"
import {
  ManagedGit,
  gitKinds,
  gitPermission,
  v2GitNames,
  gitFailure,
  GitError,
  gitApprovalResources,
  type GitKind,
} from "./managed-git"
import { Tool } from "./tool"
import { Tools } from "./tools"
import { ToolRegistry } from "./registry"
const paths = Schema.Struct({ paths: Schema.Array(Schema.String) })
const reviewed = Schema.Struct({ paths: Schema.Array(Schema.String), reviewId: Schema.String })
const remote = Schema.Struct({
  remote: Schema.String,
  branch: Schema.String,
  force: Schema.optional(Schema.Boolean),
  forceWithLease: Schema.optional(Schema.Boolean),
  flags: Schema.optional(Schema.Array(Schema.String)),
})
export const gitSchemas = {
  status: Schema.Struct({}),
  diff: Schema.Struct({
    paths: Schema.optional(Schema.Array(Schema.String)),
    staged: Schema.optional(Schema.Boolean),
    stat: Schema.optional(Schema.Boolean),
  }),
  log: Schema.Struct({ count: Schema.optional(Schema.Int), paths: Schema.optional(Schema.Array(Schema.String)) }),
  "branch.list": Schema.Struct({}),
  "branch.create": Schema.Struct({ branch: Schema.String }),
  "branch.switch": Schema.Struct({ branch: Schema.String }),
  stage: reviewed,
  unstage: paths,
  commit: Schema.Struct({ message: Schema.String, reviewId: Schema.String }),
  restore: reviewed,
  "remote.list": Schema.Struct({}),
  fetch: remote,
  push: remote,
}
export const gitDescription = (kind: GitKind) =>
  `Git ${kind}. Use Git tools instead of shell git. Review git.diff with the exact ordered paths before stage/restore and pass reviewId. Before commit review git.diff staged=true and use its reviewId; commit never stages. Only session-approved staged files may be committed; pre-existing/mixed changes require explicit permission. Run focused tests before commit. Restore always asks. Fetch/push require separate approval showing remote, branch and commit. Never push autonomously. No force/history rewrite, arbitrary repo or URL.`
export class Runtime extends Context.Service<Runtime, ReturnType<typeof ManagedGit.make>>()("@opencode/ManagedGitV2") {}
export const runtimeNode = makeLocationNode({
  service: Runtime,
  layer: Layer.effect(
    Runtime,
    Effect.gen(function* () {
      const location = yield* Location.Service
      const git = yield* Git.Service
      const app = yield* AppProcess.Service
      return ManagedGit.make(location.directory, git, app)
    }),
  ),
  deps: [Location.node, Git.node, AppProcess.node],
})
const layer = Layer.effectDiscard(
  Effect.gen(function* () {
    const tools = yield* Tools.Service
    const runtime = yield* Runtime
    const permission = yield* PermissionV2.Service
    for (const [index, kind] of gitKinds.entries())
      yield* tools
        .register({
          [v2GitNames[index]]: Tool.withPermission(
            Tool.make({
              description: gitDescription(kind),
              input: gitSchemas[kind],
              output: Schema.String,
              execute: (args, ctx) =>
                runtime
                  .invoke({
                    kind,
                    args,
                    sessionID: ctx.sessionID,
                    authorize: (action, resource, metadata) =>
                      permission
                        .assert({
                          action,
                          resources: gitApprovalResources(resource, metadata),
                          save: [],
                          metadata,
                          sessionID: ctx.sessionID,
                          agent: ctx.agent,
                          source: { type: "tool", messageID: ctx.assistantMessageID, callID: ctx.toolCallID },
                        })
                        .pipe(Effect.mapError(() => new GitError("PERMISSION_DENIED"))),
                  })
                  .pipe(
                    Effect.catch((error) => Effect.succeed(gitFailure(error))),
                    Effect.tap((result) =>
                      Effect.logInfo("managed_git", {
                        tool: v2GitNames[index],
                        sessionID: ctx.sessionID,
                        ok: result.ok,
                        code: "code" in result ? result.code : undefined,
                      }),
                    ),
                    Effect.map((result) => JSON.stringify(result)),
                  ),
            }),
            gitPermission(kind),
          ),
        })
        .pipe(Effect.orDie)
  }),
)
export const node = makeLocationNode({
  name: "tool/managed-git",
  layer,
  deps: [ToolRegistry.node, runtimeNode, PermissionV2.node],
})
