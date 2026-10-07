export * as ManagedGit from "./managed-git"

import path from "node:path"
import fs from "node:fs/promises"
import { randomUUID } from "node:crypto"
import { Effect } from "effect"
import { ChildProcess } from "effect/unstable/process"
import { Git } from "../git"
import { AbsolutePath } from "../schema"
import { AppProcess } from "../process"
import { KeyedMutex } from "../effect/keyed-mutex"
import { WorkspaceFiles, contentHash, relativeFilePath } from "./workspace-files"
import { gitWriteEvidence } from "./git-ownership"
import { outputRedactor } from "./command-policy"

export const gitKinds = [
  "status",
  "diff",
  "log",
  "branch.list",
  "branch.create",
  "branch.switch",
  "stage",
  "unstage",
  "commit",
  "restore",
  "remote.list",
  "fetch",
  "push",
] as const
export type GitKind = (typeof gitKinds)[number]
export const v1GitNames = gitKinds.map((kind) => `git.${kind}`)
export const v2GitNames = v1GitNames.map((name) => name.replaceAll(".", "_"))
export const gitPermission = (kind: GitKind) =>
  ["status", "diff", "log", "branch.list", "remote.list"].includes(kind) ? "read" : "bash"
export type GitInput = {
  paths?: readonly string[]
  staged?: boolean
  stat?: boolean
  count?: number
  branch?: string
  remote?: string
  message?: string
  reviewId?: string
  force?: boolean
  forceWithLease?: boolean
  flags?: readonly string[]
}
export class GitError extends Error {
  constructor(readonly code: string) {
    super(code)
  }
}
export const gitFailure = (error: unknown) => ({
  ok: false,
  code: error instanceof GitError ? error.code : "GIT_OPERATION_FAILED",
})
type Review = { session: string; paths: string[]; staged: boolean; fingerprint: string }
/** Safe code-form summary rendered by the existing permission dock's resource list. */
export function gitApprovalResources(resource: string, metadata: Record<string, unknown>) {
  if (metadata.requireApproval !== true) return [resource]
  const summary = ["remote", "branch", "commit", "paths", "warning"]
    .filter((key) => metadata[key] !== undefined)
    .map((key) => `${key}=${Array.isArray(metadata[key]) ? metadata[key].join(", ") : String(metadata[key])}`)
    .join(" | ")
  return summary ? [resource, summary] : [resource]
}
/** Preserve trusted credential infrastructure without inheriting repository/index redirects. */
export function gitEnvironment(environment = process.env): Record<string, string> {
  return {
    ...Object.fromEntries(
      Object.entries(environment)
        .filter(
          ([name, value]) =>
            value !== undefined &&
            (!name.startsWith("GIT_") ||
              /^(GIT_SSH|GIT_SSH_COMMAND|GIT_ASKPASS|GIT_CONFIG_GLOBAL|GIT_CONFIG_SYSTEM|GIT_CONFIG_NOSYSTEM)$/u.test(
                name,
              )),
        )
        .map(([name, value]) => [name, value!]),
    ),
    GIT_TERMINAL_PROMPT: "0",
  }
}
const locks = KeyedMutex.makeUnsafe<string>()
const io = <A>(run: () => Promise<A>) =>
  Effect.tryPromise({ try: run, catch: (error) => (error instanceof GitError ? error : new GitError("INVALID_PATH")) })
const fail = (code: string) => Effect.fail(new GitError(code))
const contained = (root: string, target: string) => {
  const relative = path.relative(root, target)
  return relative !== ".." && !relative.startsWith(`..${path.sep}`) && !path.isAbsolute(relative)
}
const ref = (value?: string) =>
  !!value &&
  value.length <= 200 &&
  !value.startsWith("-") &&
  !/[\x00-\x20~^:?*\[\\]/u.test(value) &&
  !value.includes("..") &&
  !value.includes("@{") &&
  !value.endsWith(".") &&
  !value.endsWith(".lock")
const secret = (value: string) =>
  /-----BEGIN (?:RSA |EC |OPENSSH )?PRIVATE KEY-----|(?:password|api[_-]?key|token|secret)\s*[:=]\s*["']?[^\s"']{6,}|(?:gh[pousr]_|github_pat_|sk-)[A-Za-z0-9_\-]{16,}/iu.test(
    value,
  )
const sensitive = (value: string) =>
  /(?:^|\/)(?:\.env(?:\..*)?|credentials(?:\..*)?|id_rsa|id_ed25519|[^/]*\.(?:pem|key|p12|pfx))$/iu.test(value)

/** Missing agent operations over upstream discovery/history and bounded AppProcess argv execution. */
export function make(root: string, git: Git.Interface, app: AppProcess.Interface) {
  const files = new WorkspaceFiles(root)
  const reviews = new Map<string, Review>()
  const approvedIndex = new Map<string, Map<string, string>>()
  const inherited = outputRedactor()
  const redact = (value: string) =>
    inherited(value)
      .replace(
        /-----BEGIN (?:RSA |EC |OPENSSH )?PRIVATE KEY-----[\s\S]*?(?:-----END (?:RSA |EC |OPENSSH )?PRIVATE KEY-----|$)/gu,
        "[REDACTED PRIVATE KEY]",
      )
      .replace(/(?:gh[pousr]_|github_pat_|sk-)[A-Za-z0-9_\-]{16,}/gu, "[REDACTED TOKEN]")
  return {
    invoke(input: {
      kind: GitKind
      args: GitInput
      sessionID: string
      authorize(action: string, resource: string, metadata: Record<string, unknown>): Effect.Effect<void, GitError>
    }) {
      return Effect.gen(function* () {
        if (input.args.force || input.args.forceWithLease || input.args.flags?.length)
          return yield* fail("FORCE_GIT_DENIED")
        const workspace = yield* io(() => files.rootPath())
        const repository = yield* git.repo.discover(AbsolutePath.make(workspace))
        if (!repository) return yield* fail("NOT_A_GIT_REPOSITORY")
        const repo = yield* io(() => fs.realpath(repository.worktree))
        if (!contained(repo, workspace)) return yield* fail("REPOSITORY_SCOPE_MISMATCH")
        const run = (args: string[], cap = 128 * 1024) =>
          app
            .run(
              ChildProcess.make(
                "git",
                [
                  "--no-pager",
                  "--literal-pathspecs",
                  "--git-dir",
                  repository.gitDirectory,
                  "--work-tree",
                  repo,
                  "-c",
                  "core.hooksPath=" + (process.platform === "win32" ? "NUL" : "/dev/null"),
                  "-c",
                  "core.fsmonitor=false",
                  ...args,
                ],
                {
                  cwd: repo,
                  extendEnv: false,
                  env: gitEnvironment(),
                },
              ),
              { maxOutputBytes: cap, maxErrorBytes: 4096, timeout: "60 seconds" },
            )
            .pipe(Effect.mapError(() => new GitError("GIT_OPERATION_FAILED")))
        const command = (args: string[], code = "GIT_OPERATION_FAILED", cap?: number) =>
          run(args, cap).pipe(Effect.flatMap((result) => (result.exitCode === 0 ? Effect.succeed(result) : fail(code))))
        const status = () =>
          command(["status", "--porcelain=v2", "--branch", "-z", "--untracked-files=all"], undefined, 512 * 1024).pipe(
            Effect.flatMap((result) =>
              result.stdoutTruncated
                ? fail("REPOSITORY_STATE_TOO_LARGE")
                : Effect.succeed(parseStatus(result.stdout.toString("utf8"))),
            ),
          )
        const selected = (values?: readonly string[]) =>
          io(async () => {
            if (!values?.length || values.length > 100 || new Set(values).size !== values.length)
              throw new GitError("EXPLICIT_PATHS_REQUIRED")
            return Promise.all(
              values.map(async (value) => {
                const safe = relativeFilePath(value)
                if (safe === "." || value.split(/[\\/]/u).some((part) => part.toLowerCase() === ".git"))
                  throw new GitError("INVALID_PATH")
                const target = await files.resolve(value, true)
                if (
                  path
                    .relative(workspace, target)
                    .split(/[\\/]/u)
                    .some((part) => part.toLowerCase() === ".git")
                )
                  throw new GitError("INVALID_PATH")
                if ((await fs.lstat(target).catch(() => undefined))?.isDirectory())
                  throw new GitError("EXPLICIT_FILES_REQUIRED")
                if (!contained(workspace, target)) throw new GitError("PATH_OUTSIDE_WORKSPACE")
                return path.relative(repo, target).replaceAll("\\", "/")
              }),
            )
          })
        const fingerprint = (paths: string[], staged: boolean) =>
          Effect.gen(function* () {
            const index = yield* command(["ls-files", "--stage", "-z", "--", ...paths], undefined, 512 * 1024)
            if (index.stdoutTruncated) return yield* fail("REPOSITORY_STATE_TOO_LARGE")
            const head = yield* git.history.head(repository)
            const contents = staged
              ? []
              : yield* io(() =>
                  Promise.all(
                    paths.map(async (item) => {
                      const target = path.join(repo, item)
                      const info = await fs.stat(target).catch(() => undefined)
                      if (!info) return "missing"
                      if (!info.isFile() || info.size > 2 * 1024 * 1024) throw new GitError("FILE_TOO_LARGE")
                      return contentHash(await fs.readFile(target))
                    }),
                  ),
                )
            return contentHash(Buffer.from(JSON.stringify([head, index.stdout.toString("utf8"), contents])))
          })
        const validateReview = (paths: string[], staged: boolean) =>
          Effect.gen(function* () {
            const review = input.args.reviewId ? reviews.get(input.args.reviewId) : undefined
            if (
              !review ||
              review.session !== input.sessionID ||
              review.staged !== staged ||
              JSON.stringify(review.paths) !== JSON.stringify(paths)
            )
              return yield* fail("DIFF_REVIEW_REQUIRED")
            if (review.fingerprint !== (yield* fingerprint(paths, staged))) return yield* fail("STALE_DIFF_REVIEW")
          })
        const approve = (requireApproval = false, extra: Record<string, unknown> = {}) =>
          input.authorize(gitPermission(input.kind), `git.${input.kind}`, {
            operation: input.kind,
            requireApproval,
            ...extra,
          })
        return yield* locks.withLock(repository.commonDirectory)(
          Effect.gen(function* () {
            const state = yield* status()
            const kind = input.kind
            if (kind === "status") {
              yield* approve()
              return { ok: true, ...state, entries: state.entries.slice(0, 100), truncated: state.entries.length > 100 }
            }
            if (kind === "diff") {
              const paths = input.args.paths
                ? yield* selected(input.args.paths)
                : state.entries
                    .filter(
                      (entry) =>
                        contained(workspace, path.join(repo, entry.path)) &&
                        (input.args.staged ? entry.staged : entry.unstaged || entry.untracked),
                    )
                    .flatMap((entry) => (entry.originalPath ? [entry.originalPath, entry.path] : [entry.path]))
              if (paths.length > 100) return yield* fail("EXPLICIT_PATHS_REQUIRED")
              yield* approve()
              const staged = input.args.staged ?? false
              const options = ["diff", "--no-ext-diff", "--no-textconv", ...(staged ? ["--cached"] : [])]
              const before = yield* fingerprint(paths, staged)
              const patch = paths.length ? yield* command([...options, "--", ...paths], undefined, 8 * 1024) : undefined
              const untracked = !staged
                ? yield* io(async () => {
                    const chunks = await Promise.all(
                      paths
                        .filter((item) => state.entries.some((entry) => entry.path === item && entry.untracked))
                        .map(async (item) => {
                          const bytes = await fs.readFile(path.join(repo, item))
                          return bytes.includes(0)
                            ? `BINARY_DIFF ${item}`
                            : `Untracked ${item}\n${bytes.toString("utf8")}`
                        }),
                    )
                    const bytes = Buffer.from(redact(chunks.join("\n")))
                    return {
                      text: new TextDecoder().decode(bytes.subarray(0, 4096), { stream: true }),
                      truncated: bytes.length > 4096,
                    }
                  })
                : { text: "", truncated: false }
              const stat = paths.length
                ? yield* command([...options, "--numstat", "--", ...paths], undefined, 2 * 1024)
                : undefined
              if (before !== (yield* fingerprint(paths, staged))) return yield* fail("STALE_DIFF_REVIEW")
              const reviewId = randomUUID()
              reviews.set(reviewId, { session: input.sessionID, paths, staged, fingerprint: before })
              if (reviews.size > 128) reviews.delete(reviews.keys().next().value!)
              return {
                ok: true,
                reviewId,
                paths,
                staged,
                stat: redact(stat?.stdout.toString("utf8") ?? ""),
                patch: input.args.stat ? undefined : redact((patch?.stdout.toString("utf8") ?? "") + untracked.text),
                binary: /BINARY_DIFF|Binary files|\t-\t|^-\t-/mu.test(
                  (patch?.stdout.toString("utf8") ?? "") + (stat?.stdout.toString("utf8") ?? "") + untracked.text,
                )
                  ? "BINARY_DIFF"
                  : undefined,
                truncated: patch?.stdoutTruncated || stat?.stdoutTruncated || untracked.truncated,
              }
            }
            if (kind === "log") {
              const count = input.args.count ?? 10
              if (!Number.isInteger(count) || count < 1 || count > 50) return yield* fail("INVALID_ARGUMENT")
              const paths = input.args.paths ? yield* selected(input.args.paths) : []
              yield* approve()
              const result = yield* run(
                ["log", `-${count}`, "--format=%H%x00%an%x00%aI%x00%s%x00", "--", ...paths],
                8 * 1024,
              )
              return {
                ok: true,
                commits: result.exitCode ? [] : parseLog(redact(result.stdout.toString("utf8"))),
                truncated: result.stdoutTruncated,
              }
            }
            if (kind === "branch.list") {
              yield* approve()
              const result = yield* command(
                ["for-each-ref", "--count=100", "--format=%(refname:short)%09%(upstream:short)", "refs/heads/"],
                undefined,
                16 * 1024,
              )
              return {
                ok: true,
                current: state.branch,
                branches: result.stdout
                  .toString("utf8")
                  .trim()
                  .split("\n")
                  .filter(Boolean)
                  .map((row) => {
                    const [name, upstream] = row.trim().split("\t")
                    return { name, upstream: upstream || undefined }
                  }),
                truncated: result.stdoutTruncated,
              }
            }
            if (kind === "branch.create" || kind === "branch.switch") {
              if (
                !ref(input.args.branch) ||
                (yield* run(["check-ref-format", "--branch", input.args.branch!])).exitCode
              )
                return yield* fail("INVALID_BRANCH_NAME")
              if (kind === "branch.switch" && !state.clean) return yield* fail("DIRTY_WORKTREE")
              if (kind === "branch.switch" && path.relative(repo, workspace))
                return yield* fail("PATH_OUTSIDE_WORKSPACE")
              yield* approve(false, { branch: input.args.branch })
              if (kind === "branch.switch" && !(yield* status()).clean) return yield* fail("DIRTY_WORKTREE")
              yield* command(
                kind === "branch.create"
                  ? ["branch", input.args.branch!]
                  : ["switch", "--no-guess", input.args.branch!],
                "BRANCH_OPERATION_FAILED",
              )
              return { ok: true, branch: input.args.branch }
            }
            if (["stage", "unstage", "restore"].includes(kind)) {
              const paths = yield* selected(input.args.paths)
              if (kind !== "unstage") yield* validateReview(paths, false)
              let mixed = false
              if (kind === "stage") {
                for (const item of paths) {
                  const target = path.join(repo, item)
                  const evidence = gitWriteEvidence(input.sessionID, target)
                  const head = yield* run(["show", `HEAD:${item}`], 2 * 1024 * 1024)
                  const index = yield* run(["show", `:${item}`], 2 * 1024 * 1024)
                  const current = yield* io(() => fs.readFile(target).catch(() => undefined))
                  if (
                    !evidence ||
                    !current ||
                    evidence.after !== contentHash(current) ||
                    (head.exitCode === 0
                      ? evidence.before !== contentHash(head.stdout) || head.stdoutTruncated
                      : evidence.before !== undefined) ||
                    (head.exitCode === 0 && index.exitCode === 0 && !head.stdout.equals(index.stdout))
                  )
                    mixed = true
                }
              }
              yield* approve(kind === "restore" || mixed, {
                paths,
                warning: mixed
                  ? "USER_OR_UNATTRIBUTED_CHANGES"
                  : kind === "restore"
                    ? "DISCARDS_SELECTED_WORKTREE_CHANGES"
                    : undefined,
              })
              if (kind !== "unstage") yield* validateReview(paths, false)
              // Revalidate canonical paths after permission waits.
              if (JSON.stringify(paths) !== JSON.stringify(yield* selected(input.args.paths)))
                return yield* fail("INVALID_PATH")
              const addPaths: string[] = []
              if (kind === "stage")
                for (const item of paths) {
                  const exists = yield* io(() =>
                    fs
                      .lstat(path.join(repo, item))
                      .then(() => true)
                      .catch(() => false),
                  )
                  const tracked = yield* command(["ls-files", "--stage", "-z", "--", item])
                  if (exists || tracked.stdout.length) addPaths.push(item)
                }
              if (kind !== "stage" || addPaths.length)
                yield* command(
                  kind === "stage"
                    ? ["add", "--", ...addPaths]
                    : kind === "restore"
                      ? ["restore", "--worktree", "--", ...paths]
                      : state.unborn
                        ? ["rm", "--cached", "--ignore-unmatch", "--", ...paths]
                        : ["restore", "--staged", "--", ...paths],
                )
              if (kind === "stage") {
                const owned = approvedIndex.get(input.sessionID) ?? new Map<string, string>()
                for (const item of paths)
                  owned.set(item, (yield* command(["ls-files", "--stage", "-z", "--", item])).stdout.toString("utf8"))
                approvedIndex.set(input.sessionID, owned)
                if (approvedIndex.size > 256) approvedIndex.delete(approvedIndex.keys().next().value!)
              }
              return {
                ok: true,
                paths,
                staged: (yield* status()).entries.filter((entry) => entry.staged).slice(0, 100),
              }
            }
            if (kind === "commit") {
              const message = input.args.message
              if (!message || !message.trim() || message.length > 500 || /[\x00-\x1f\x7f]/u.test(message))
                return yield* fail("INVALID_COMMIT_MESSAGE")
              if (secret(message) || redact(message) !== message)
                return yield* fail("POTENTIAL_SECRET_IN_STAGED_CHANGES")
              if (state.conflicts.length) return yield* fail("CONFLICTED_INDEX")
              const paths = state.entries
                .filter((entry) => entry.staged)
                .flatMap((entry) => (entry.originalPath ? [entry.originalPath, entry.path] : [entry.path]))
              if (
                state.entries.some(
                  (entry) =>
                    entry.staged && entry.originalPath && !contained(workspace, path.join(repo, entry.originalPath)),
                )
              )
                return yield* fail("PATH_OUTSIDE_WORKSPACE")
              if (!paths.length) return yield* fail("NOTHING_TO_COMMIT")
              yield* validateReview(paths, true)
              const verify = () =>
                Effect.gen(function* () {
                  const next = yield* status()
                  if (
                    JSON.stringify(
                      next.entries
                        .filter((entry) => entry.staged)
                        .flatMap((entry) => (entry.originalPath ? [entry.originalPath, entry.path] : [entry.path])),
                    ) !== JSON.stringify(paths)
                  )
                    return yield* fail("STALE_DIFF_REVIEW")
                  if (next.conflicts.length) return yield* fail("CONFLICTED_INDEX")
                  for (const entry of next.entries.filter((item) => item.staged && item.originalPath)) {
                    if (!contained(workspace, path.join(repo, entry.originalPath!)))
                      return yield* fail("PATH_OUTSIDE_WORKSPACE")
                    if (approvedIndex.get(input.sessionID)?.get(entry.originalPath!) === undefined)
                      return yield* fail("UNAPPROVED_STAGED_CHANGES")
                  }
                  for (const item of paths) {
                    if (!contained(workspace, path.join(repo, item))) return yield* fail("PATH_OUTSIDE_WORKSPACE")
                    if (sensitive(item)) return yield* fail("POTENTIAL_SECRET_IN_STAGED_CHANGES")
                    const approved = approvedIndex.get(input.sessionID)?.get(item)
                    const current = (yield* command(["ls-files", "--stage", "-z", "--", item])).stdout.toString("utf8")
                    if (approved === undefined || approved !== current) return yield* fail("UNAPPROVED_STAGED_CHANGES")
                    const blob = yield* run(["show", `:${item}`], 2 * 1024 * 1024)
                    if (
                      blob.exitCode === 0 &&
                      (blob.stdoutTruncated ||
                        secret(blob.stdout.toString("utf8")) ||
                        redact(blob.stdout.toString("utf8")) !== blob.stdout.toString("utf8"))
                    )
                      return yield* fail("POTENTIAL_SECRET_IN_STAGED_CHANGES")
                  }
                  yield* validateReview(paths, true)
                })
              yield* verify()
              yield* approve(false, { filesChanged: paths, subject: message })
              yield* verify()
              yield* command(["commit", "--no-gpg-sign", "-m", message], "COMMIT_FAILED")
              approvedIndex.delete(input.sessionID)
              return {
                ok: true,
                sha: yield* git.history.head(repository),
                branch: state.branch,
                subject: message,
                filesChanged: paths,
              }
            }
            if (kind === "remote.list") {
              yield* approve()
              const result = yield* command(["remote"], undefined, 4096)
              // URL and credential helper values are deliberately not model-visible.
              return {
                ok: true,
                remotes: result.stdout.toString("utf8").trim().split("\n").filter(Boolean).slice(0, 50),
                truncated: result.stdoutTruncated,
              }
            }
            if (kind === "push" || kind === "fetch") {
              const remote = input.args.remote
              const branch = input.args.branch
              if (!remote || !/^[A-Za-z0-9][A-Za-z0-9._-]{0,80}$/u.test(remote)) return yield* fail("INVALID_REMOTE")
              if (!ref(branch) || (yield* run(["check-ref-format", "--branch", branch!])).exitCode)
                return yield* fail("INVALID_BRANCH_NAME")
              const url = yield* git.remote.get(repository, remote)
              if (!url) return yield* fail("REMOTE_NOT_FOUND")
              if (secret(url) || /(?:https?:\/\/)[^/]*@/iu.test(url) || redact(url) !== url)
                return yield* fail("UNSAFE_REMOTE_CREDENTIALS")
              const pushTarget = () =>
                command(["remote", "get-url", "--push", "--all", remote], "REMOTE_NOT_FOUND", 4096).pipe(
                  Effect.flatMap((result) => {
                    const urls = result.stdout.toString("utf8").trim().split("\n")
                    if (
                      result.stdoutTruncated ||
                      urls.length !== 1 ||
                      !urls[0] ||
                      secret(urls[0]) ||
                      /(?:https?:\/\/)[^/]*@/iu.test(urls[0]) ||
                      redact(urls[0]) !== urls[0]
                    )
                      return fail("UNSAFE_REMOTE_TARGET")
                    return Effect.succeed(urls[0])
                  }),
                )
              const target = kind === "push" ? yield* pushTarget() : url
              const newSha = yield* run(["rev-parse", "--verify", `refs/heads/${branch}`])
              if (kind === "push" && newSha.exitCode) return yield* fail("BRANCH_NOT_FOUND")
              const previous = yield* run(["rev-parse", "--verify", `refs/remotes/${remote}/${branch}`])
              yield* approve(true, {
                remote,
                branch,
                commit: newSha.exitCode ? undefined : newSha.stdout.toString("utf8").trim(),
                warning: "EXTERNAL_GIT_SIDE_EFFECT",
              })
              if ((yield* git.remote.get(repository, remote)) !== url) return yield* fail("REMOTE_CHANGED")
              let oldSha: string | null = previous.exitCode ? null : previous.stdout.toString("utf8").trim()
              if (kind === "push") {
                if ((yield* pushTarget()) !== target) return yield* fail("REMOTE_CHANGED")
                if (!(yield* command(["rev-parse", "--verify", `refs/heads/${branch}`])).stdout.equals(newSha.stdout))
                  return yield* fail("STALE_DIFF_REVIEW")
                const observed = yield* command(
                  ["ls-remote", "--heads", "--", target, `refs/heads/${branch}`],
                  "PUSH_REJECTED",
                  4096,
                )
                oldSha = observed.stdout.toString("utf8").trim().split(/\s/u)[0] || null
                yield* command(
                  [
                    "-c",
                    `remote.${remote}.mirror=false`,
                    "push",
                    "--porcelain",
                    "--no-follow-tags",
                    "--recurse-submodules=no",
                    remote,
                    `refs/heads/${branch}:refs/heads/${branch}`,
                  ],
                  "PUSH_REJECTED",
                )
              } else
                yield* command(
                  [
                    "fetch",
                    "--no-tags",
                    "--no-prune",
                    "--recurse-submodules=no",
                    remote,
                    `refs/heads/${branch}:refs/remotes/${remote}/${branch}`,
                  ],
                  "FETCH_FAILED",
                )
              return {
                ok: true,
                remote,
                branch,
                oldSha,
                newSha:
                  kind === "push"
                    ? newSha.stdout.toString("utf8").trim()
                    : (yield* command(["rev-parse", `refs/remotes/${remote}/${branch}`])).stdout
                        .toString("utf8")
                        .trim(),
              }
            }
            return yield* fail("GIT_OPERATION_DENIED")
          }),
        )
      })
    },
  }
}

function parseStatus(value: string) {
  const rows = value.split("\0")
  const entries: {
    path: string
    originalPath?: string
    code: string
    staged: boolean
    unstaged: boolean
    untracked: boolean
    conflict: boolean
  }[] = []
  let branch: string | undefined
  let upstream: string | undefined
  let ahead = 0
  let behind = 0
  let unborn = false
  for (let index = 0; index < rows.length; index++) {
    const row = rows[index]
    if (row.startsWith("# branch.head ")) branch = row.slice(14)
    if (row.startsWith("# branch.upstream ")) upstream = row.slice(18)
    if (row.startsWith("# branch.oid (initial)")) unborn = true
    if (row.startsWith("# branch.ab ")) {
      const parts = row.slice(12).split(" ")
      ahead = Number(parts[0])
      behind = Math.abs(Number(parts[1]))
    }
    const type = row[0]
    if (!["1", "2", "u", "?"].includes(type)) continue
    const fields = type === "1" ? 8 : type === "2" ? 9 : type === "u" ? 10 : 1
    const parts = row.split(" ")
    const name = parts.slice(fields).join(" ")
    const code = type === "?" ? "??" : parts[1]
    entries.push({
      path: name,
      originalPath: type === "2" ? rows[++index] : undefined,
      code,
      staged: type !== "?" && code[0] !== ".",
      unstaged: type !== "?" && code[1] !== ".",
      untracked: type === "?",
      conflict: type === "u",
    })
  }
  return {
    branch,
    upstream,
    ahead,
    behind,
    unborn,
    entries,
    conflicts: entries
      .filter((entry) => entry.conflict)
      .flatMap((entry) => (entry.originalPath ? [entry.originalPath, entry.path] : [entry.path])),
    clean: entries.length === 0,
  }
}
function parseLog(value: string) {
  const parts = value.split("\0")
  return Array.from({ length: Math.floor(parts.length / 4) }, (_, index) => ({
    sha: parts[index * 4].trim(),
    author: parts[index * 4 + 1],
    date: parts[index * 4 + 2],
    subject: parts[index * 4 + 3],
  }))
}
