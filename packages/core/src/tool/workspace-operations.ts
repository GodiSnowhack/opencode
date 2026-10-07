import path from "node:path"
import { opendir } from "node:fs/promises"
import { Effect, Schema } from "effect"
import { createTwoFilesPatch } from "diff"
import { Ripgrep } from "../ripgrep"
import { MAX_RESULTS, WorkspaceFileError, WorkspaceFiles, type FileInput } from "./workspace-files"

export const workspaceKinds = ["info", "list", "read", "glob", "search", "write", "edit"] as const
export type WorkspaceKind = (typeof workspaceKinds)[number]
export const v1WorkspaceNames = ["project.info", "fs.list", "fs.read", "fs.glob", "fs.search", "fs.write", "fs.edit"]
export const v2WorkspaceNames = ["project_info", "fs_list", "fs_read", "fs_glob", "fs_search", "fs_write", "fs_edit"]
export const workspaceSchemas = {
  info: Schema.Struct({}),
  list: Schema.Struct({ path: Schema.optional(Schema.String), limit: Schema.optional(Schema.Int) }),
  read: Schema.Struct({
    path: Schema.String,
    startLine: Schema.optional(Schema.Int),
    maxLines: Schema.optional(Schema.Int),
  }),
  glob: Schema.Struct({
    pattern: Schema.String,
    path: Schema.optional(Schema.String),
    limit: Schema.optional(Schema.Int),
  }),
  search: Schema.Struct({
    pattern: Schema.String,
    path: Schema.optional(Schema.String),
    regex: Schema.optional(Schema.Boolean),
    include: Schema.optional(Schema.String),
    limit: Schema.optional(Schema.Int),
  }),
  write: Schema.Struct({
    path: Schema.String,
    content: Schema.String,
    mode: Schema.optional(Schema.Literals(["create", "replace"])),
    expectedHash: Schema.optional(Schema.String),
  }),
  edit: Schema.Struct({
    path: Schema.String,
    oldString: Schema.String,
    newString: Schema.String,
    replaceAll: Schema.optional(Schema.Boolean),
    expectedHash: Schema.optional(Schema.String),
  }),
}
export const workspaceDescriptions = {
  info: "Show safe project information and available workspace file capabilities.",
  list: "List up to 100 entries of a relative workspace directory.",
  read: "Read up to 200 lines of a UTF-8 workspace file (max 512 KiB). Returns a revision hash. Read existing files before any edit or replacement.",
  glob: "Find workspace filenames by glob, with bounded results. Does not follow symlinks.",
  search:
    "Find text inside the workspace. Exact string by default; regex=true uses Rust regex. Results are bounded; no symlink following.",
  write:
    "Create a UTF-8 workspace file atomically (default mode=create, never overwrites). For full replacement use mode=replace after reading the file. Parents must exist. Max 512 KiB; 8 files/2 MiB per turn.",
  edit: "Atomically replace exact text after reading the workspace file. No match or ambiguous match fails; replaceAll must be explicit. Concurrent changes require re-reading. Max 128 KiB patch; 8 files/2 MiB per turn.",
}
export const workspacePermission = (kind: WorkspaceKind) =>
  kind === "edit" || kind === "write" ? "edit" : kind === "glob" ? "glob" : kind === "search" ? "grep" : "read"
export const workspaceRisk = (kind: WorkspaceKind) => (kind === "write" || kind === "edit" ? "SAFE_WRITE" : "READ")
export type WorkspaceResult = {
  title: string
  output: string
  metadata: {
    truncated: boolean
    errorCode?: string
    path?: string
    operation?: string
    bytes?: number
    bytesChanged?: number
  }
}
export const workspaceFailure = (error: unknown) => {
  const code =
    error instanceof WorkspaceFileError
      ? error.code
      : error instanceof Ripgrep.InvalidPatternError
        ? "INVALID_ARGUMENT"
        : "EXECUTION_FAILED"
  return {
    title: "Tool error",
    output: JSON.stringify({ ok: false, code }),
    metadata: { truncated: false, errorCode: code },
  }
}
const io = <A>(operation: (signal: AbortSignal) => Promise<A>, signal?: AbortSignal) =>
  Effect.tryPromise({
    try: (cancel) => operation(signal ? AbortSignal.any([signal, cancel]) : cancel),
    catch: (error) => (error instanceof WorkspaceFileError ? error : new WorkspaceFileError("EXECUTION_FAILED")),
  })

/** Leaf operation reused by both registries. Authorization comes from each runtime's existing permission service. */
export function workspaceOperation(input: {
  files: WorkspaceFiles
  search: Ripgrep.Interface
  kind: WorkspaceKind
  args: FileInput
  sessionID: string
  turnID: string
  signal?: AbortSignal
  authorize(
    action: string,
    resource: string,
    metadata?: Record<string, unknown>,
  ): Effect.Effect<void, WorkspaceFileError>
}): Effect.Effect<WorkspaceResult> {
  let safeResource: string | undefined
  return Effect.gen(function* () {
    const { files, kind, args } = input
    if (input.signal?.aborted) return yield* Effect.fail(new WorkspaceFileError("CANCELLED"))
    if (kind === "info")
      return {
        title: "Project information",
        output: JSON.stringify({
          name: path.basename(files.root),
          workspaceAvailable: true,
          capabilities: v1WorkspaceNames,
        }),
        metadata: { truncated: false },
      }
    const target = yield* io(
      () =>
        files.resolve(
          args.path ?? (kind === "read" || kind === "write" || kind === "edit" ? "" : "."),
          kind === "write",
        ),
      input.signal,
    )
    const root = yield* io(() => files.rootPath())
    const resource = path.relative(root, target).replaceAll("\\", "/") || "."
    safeResource = resource
    if (kind === "write" || kind === "edit") {
      const plan = yield* io((signal) => files.prepare(input.sessionID, kind, args, signal), input.signal)
      yield* input.authorize("edit", resource, {
        filepath: resource,
        diff: createTwoFilesPatch(
          resource,
          resource,
          plan.before?.toString("utf8").slice(0, 4096) ?? "",
          plan.after.toString("utf8").slice(0, 4096),
        ),
        previewTruncated: (plan.before?.length ?? 0) > 4096 || plan.after.length > 4096,
      })
      const result = yield* io((signal) => files.commit(input.sessionID, input.turnID, plan, signal), input.signal)
      return {
        title: resource,
        output: JSON.stringify(result),
        metadata: {
          truncated: false,
          path: resource,
          operation: result.operation,
          bytes: result.bytes,
          bytesChanged: result.changed ? result.bytes : 0,
        },
      }
    }
    yield* input.authorize(workspacePermission(kind), resource)
    if (kind === "read") {
      const result = yield* io((signal) => files.read(input.sessionID, args, signal), input.signal)
      return {
        title: resource,
        output: JSON.stringify(result),
        metadata: { truncated: result.truncated, path: resource },
      }
    }
    const limit = args.limit ?? MAX_RESULTS
    if (!Number.isInteger(limit) || limit < 1 || limit > MAX_RESULTS)
      return yield* Effect.fail(new WorkspaceFileError("INVALID_ARGUMENT"))
    if (kind === "list") {
      const entries = yield* io(async (signal) => {
        const directory = await opendir(target)
        const entries: Array<{ name: string; type: string }> = []
        try {
          if ((await files.resolve(args.path ?? ".")) !== target) throw new WorkspaceFileError("PATH_OUTSIDE_WORKSPACE")
          while (entries.length <= limit) {
            if (signal.aborted) throw new WorkspaceFileError("CANCELLED")
            const entry = await directory.read()
            if (!entry) break
            if (!entry.isSymbolicLink())
              entries.push({ name: entry.name, type: entry.isDirectory() ? "directory" : "file" })
          }
          return entries
        } finally {
          await directory.close()
        }
      }, input.signal)
      const safe = entries.slice(0, limit)
      return {
        title: resource,
        output: JSON.stringify({ ok: true, path: resource, entries: safe, truncated: entries.length > limit }),
        metadata: { truncated: entries.length > limit, path: resource },
      }
    }
    if (!args.pattern || args.pattern.length > 2048 || args.pattern.includes("\0"))
      return yield* Effect.fail(new WorkspaceFileError("INVALID_ARGUMENT"))
    const pattern =
      kind === "search" && !args.regex ? args.pattern.replace(/[.*+?^${}()|[\]\\]/g, "\\$&") : args.pattern
    const found =
      kind === "glob"
        ? yield* input.search.glob({ cwd: target, pattern, limit, signal: input.signal })
        : yield* input.search.grep({ cwd: target, pattern, include: args.include, limit, signal: input.signal })
    // Validate result paths again before disclosing any search output.
    const results = yield* Effect.forEach(found, (entry) =>
      Effect.gen(function* () {
        const relative = path
          .relative(root, path.resolve(target, "entry" in entry ? entry.entry.path : entry.path))
          .replaceAll("\\", "/")
        yield* io(() => files.resolve(relative), input.signal)
        if (!("entry" in entry)) return { path: relative }
        const valid = yield* io((signal) => files.validateText(relative, signal), input.signal).pipe(
          Effect.catch((error) =>
            error.code === "UNSUPPORTED_BINARY_FILE" ||
            error.code === "FILE_TOO_LARGE" ||
            error.code === "FILE_NOT_FOUND"
              ? Effect.succeed(false)
              : Effect.fail(error),
          ),
        )
        if (valid === false) return undefined
        return { path: relative, line: entry.line, text: entry.text.slice(0, 500) }
      }),
    )
    return {
      title: resource,
      output: JSON.stringify({
        ok: true,
        matches: results.filter((result) => result !== undefined),
        truncated: found.length >= limit,
      }),
      metadata: { truncated: found.length >= limit, path: resource },
    }
  }).pipe(
    Effect.catch((error) => {
      const failure = workspaceFailure(error)
      return Effect.succeed({ ...failure, metadata: { ...failure.metadata, path: safeResource } })
    }),
  )
}
