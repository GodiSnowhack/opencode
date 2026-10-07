import { describe, expect, test } from "bun:test"
import fs from "node:fs/promises"
import path from "node:path"
import { Effect } from "effect"
import { LayerNode } from "@opencode-ai/core/effect/layer-node"
import { Git } from "@opencode-ai/core/git"
import { AppProcess } from "@opencode-ai/core/process"
import {
  ManagedGit,
  GitError,
  gitKinds,
  gitEnvironment,
  type GitKind,
  type GitInput,
} from "@opencode-ai/core/tool/managed-git"
import { WorkspaceFiles } from "@opencode-ai/core/tool/workspace-files"
import { classifyCommand } from "@opencode-ai/core/tool/command-policy"
import { tmpdir } from "./fixture/tmpdir"
import { testEffect } from "./lib/effect"

const it = testEffect(LayerNode.compile(LayerNode.group([Git.node, AppProcess.node])))
const setup = <A, E, R>(
  body: (
    root: string,
    runtime: ReturnType<typeof ManagedGit.make>,
    approvals: Record<string, unknown>[],
    invoke: (kind: GitKind, args?: GitInput) => Effect.Effect<Record<string, unknown>, GitError>,
  ) => Effect.Effect<A, E, R>,
  nested = false,
  init = true,
) =>
  Effect.acquireUseRelease(
    Effect.promise(() => tmpdir()),
    (tmp) =>
      Effect.gen(function* () {
        const git = yield* Git.Service
        const app = yield* AppProcess.Service
        if (init) {
          yield* Effect.promise(async () => {
            await raw(tmp.path, "init", "-b", "main")
            await raw(tmp.path, "config", "user.email", "test@example.invalid")
            await raw(tmp.path, "config", "user.name", "Phase9D")
            await raw(tmp.path, "config", "core.autocrlf", "false")
            await fs.mkdir(path.join(tmp.path, "src"))
            await fs.writeFile(path.join(tmp.path, "src/app.ts"), "original\n")
            await fs.writeFile(path.join(tmp.path, "user.txt"), "original user\n")
            await raw(tmp.path, "add", "src/app.ts", "user.txt")
            await raw(tmp.path, "commit", "-m", "initial")
          })
        }
        const runtime = ManagedGit.make(nested ? path.join(tmp.path, "src") : tmp.path, git, app)
        const approvals: Record<string, unknown>[] = []
        const invoke = (kind: GitKind, args: GitInput = {}) =>
          runtime.invoke({
            kind,
            args,
            sessionID: "session",
            authorize: (_action, _resource, metadata) =>
              Effect.sync(() => {
                approvals.push(metadata)
              }),
          })
        return yield* body(tmp.path, runtime, approvals, invoke)
      }),
    (tmp) => Effect.promise(() => tmp[Symbol.asyncDispose]()),
  )
async function raw(root: string, ...args: string[]) {
  const child = Bun.spawn(["git", ...args], { cwd: root, stdout: "pipe", stderr: "pipe" })
  const [output, error, code] = await Promise.all([
    new Response(child.stdout).text(),
    new Response(child.stderr).text(),
    child.exited,
  ])
  if (code) throw new Error(error)
  return output.trim()
}
const edit = (root: string, value = "agent task\n") =>
  Effect.promise(async () => {
    const files = new WorkspaceFiles(root)
    await files.read("session", { path: "src/app.ts" })
    await files.commit(
      "session",
      "turn",
      await files.prepare("session", "write", { path: "src/app.ts", mode: "replace", content: value }),
    )
  })
const errorCode = <A>(effect: Effect.Effect<A, GitError>) =>
  effect.pipe(Effect.match({ onSuccess: () => "OK", onFailure: (error) => error.code }))

describe("Phase 9D actual disposable Git runtime", () => {
  test("credential environment is preserved while repository/index overrides are removed", () => {
    expect(
      gitEnvironment({
        PATH: "path",
        GIT_DIR: "foreign",
        GIT_INDEX_FILE: "foreign-index",
        GIT_SSH_COMMAND: "ssh -i approved-key",
        GIT_ASKPASS: "approved-helper",
        GIT_CONFIG_GLOBAL: "trusted-config",
      }),
    ).toEqual({
      PATH: "path",
      GIT_SSH_COMMAND: "ssh -i approved-key",
      GIT_ASKPASS: "approved-helper",
      GIT_CONFIG_GLOBAL: "trusted-config",
      GIT_TERMINAL_PROMPT: "0",
    })
  })
  it.live("stages/commits only task file and preserves pre-existing user change", () =>
    setup((root, _runtime, approvals, invoke) =>
      Effect.gen(function* () {
        yield* Effect.promise(() => fs.writeFile(path.join(root, "user.txt"), "user dirty\n"))
        yield* edit(root)
        const review = yield* invoke("diff", { paths: ["src/app.ts"] })
        expect(review.patch).toContain("agent task")
        yield* invoke("stage", { paths: ["src/app.ts"], reviewId: String(review.reviewId) })
        expect(approvals.at(-1)?.requireApproval).toBe(false)
        const staged = yield* invoke("diff", { staged: true })
        const commit = yield* invoke("commit", { message: "fix: task", reviewId: String(staged.reviewId) })
        expect(commit.filesChanged).toEqual(["src/app.ts"])
        expect(yield* Effect.promise(() => raw(root, "show", "--format=", "--name-only", "HEAD"))).toBe("src/app.ts")
        expect(yield* Effect.promise(() => fs.readFile(path.join(root, "user.txt"), "utf8"))).toBe("user dirty\n")
        expect((yield* invoke("status")).clean).toBe(false)
      }),
    ),
  )
  it.live("mixed pre-existing file requires explicit approval; denied approval leaves index untouched", () =>
    setup((root, runtime, _approvals, invoke) =>
      Effect.gen(function* () {
        yield* Effect.promise(() => fs.writeFile(path.join(root, "src/app.ts"), "user mixed\n"))
        yield* edit(root)
        const review = yield* invoke("diff", { paths: ["src/app.ts"] })
        const denied = runtime.invoke({
          kind: "stage",
          args: { paths: ["src/app.ts"], reviewId: String(review.reviewId) },
          sessionID: "session",
          authorize: (_action, _resource, metadata) => {
            expect(metadata.requireApproval).toBe(true)
            return Effect.fail(new GitError("PERMISSION_DENIED"))
          },
        })
        expect(yield* errorCode(denied)).toBe("PERMISSION_DENIED")
        expect(yield* Effect.promise(() => raw(root, "diff", "--cached", "--name-only"))).toBe("")
      }),
    ),
  )
  it.live("rejects stale review, foreign-session review and missing explicit paths", () =>
    setup((root, runtime, _approvals, invoke) =>
      Effect.gen(function* () {
        yield* edit(root)
        const review = yield* invoke("diff", { paths: ["src/app.ts"] })
        const args = { paths: ["src/app.ts"], reviewId: String(review.reviewId) }
        expect(
          yield* errorCode(runtime.invoke({ kind: "stage", args, sessionID: "other", authorize: () => Effect.void })),
        ).toBe("DIFF_REVIEW_REQUIRED")
        yield* Effect.promise(() => fs.writeFile(path.join(root, "src/app.ts"), "changed after review\n"))
        expect(yield* errorCode(invoke("stage", args))).toBe("STALE_DIFF_REVIEW")
        expect(yield* errorCode(invoke("stage", { paths: ["."] }))).toBe("INVALID_PATH")
        expect(yield* errorCode(invoke("stage", { paths: [] }))).toBe("EXPLICIT_PATHS_REQUIRED")
        expect(yield* errorCode(invoke("diff", { paths: ["../outside"] }))).toBe("INVALID_PATH")
        expect(yield* errorCode(invoke("diff", { paths: ["C:\\other-repo\\file.txt"] }))).toBe("INVALID_PATH")
        expect(yield* errorCode(invoke("diff", { paths: ["\\\\server\\share\\file.txt"] }))).toBe("INVALID_PATH")
      }),
    ),
  )
  it.live("revalidates after permission and refuses changed staged index", () =>
    setup((root, runtime, _approvals, invoke) =>
      Effect.gen(function* () {
        yield* edit(root)
        const review = yield* invoke("diff", { paths: ["src/app.ts"] })
        const operation = runtime.invoke({
          kind: "stage",
          args: { paths: ["src/app.ts"], reviewId: String(review.reviewId) },
          sessionID: "session",
          authorize: () => Effect.promise(() => fs.writeFile(path.join(root, "src/app.ts"), "raced\n")),
        })
        expect(yield* errorCode(operation)).toBe("STALE_DIFF_REVIEW")
        expect(yield* Effect.promise(() => raw(root, "diff", "--cached", "--name-only"))).toBe("")
      }),
    ),
  )
  it.live("nested workspace discovers parent repo but cannot stage/commit outside scope", () =>
    setup(
      (root, _runtime, _approvals, invoke) =>
        Effect.gen(function* () {
          yield* Effect.promise(async () => {
            await fs.writeFile(path.join(root, "user.txt"), "outside workspace\n")
            await raw(root, "add", "user.txt")
          })
          expect(yield* errorCode(invoke("diff", { paths: ["../user.txt"] }))).toBe("INVALID_PATH")
          const review = yield* invoke("diff", { paths: ["app.ts"], staged: true })
          expect(
            yield* errorCode(invoke("commit", { message: "no outside", reviewId: String(review.reviewId) })),
          ).not.toBe("OK")
        }),
      true,
    ),
  )
  it.live("branch create/switch works; dirty tree switch preserves bytes", () =>
    setup((root, _runtime, _approvals, invoke) =>
      Effect.gen(function* () {
        yield* invoke("branch.create", { branch: "feature/test" })
        yield* invoke("branch.switch", { branch: "feature/test" })
        expect((yield* invoke("status")).branch).toBe("feature/test")
        yield* edit(root)
        expect(yield* errorCode(invoke("branch.switch", { branch: "main" }))).toBe("DIRTY_WORKTREE")
        expect(yield* Effect.promise(() => fs.readFile(path.join(root, "src/app.ts"), "utf8"))).toBe("agent task\n")
        expect(yield* errorCode(invoke("branch.create", { branch: "--force" }))).toBe("INVALID_BRANCH_NAME")
        const review = yield* invoke("diff", { paths: ["src/app.ts"] })
        yield* invoke("stage", { paths: ["src/app.ts"], reviewId: String(review.reviewId) })
        const staged = yield* invoke("diff", { staged: true })
        yield* invoke("commit", { message: "feature", reviewId: String(staged.reviewId) })
        yield* invoke("branch.switch", { branch: "main" })
        expect(yield* Effect.promise(() => fs.readFile(path.join(root, "src/app.ts"), "utf8"))).toBe("original\n")
      }),
    ),
  )
  it.live("unstage keeps working tree; restore requires separate ASK", () =>
    setup((root, runtime, approvals, invoke) =>
      Effect.gen(function* () {
        yield* edit(root)
        let review = yield* invoke("diff", { paths: ["src/app.ts"] })
        yield* invoke("stage", { paths: ["src/app.ts"], reviewId: String(review.reviewId) })
        yield* invoke("unstage", { paths: ["src/app.ts"] })
        expect(yield* Effect.promise(() => fs.readFile(path.join(root, "src/app.ts"), "utf8"))).toBe("agent task\n")
        review = yield* invoke("diff", { paths: ["src/app.ts"] })
        const args = { paths: ["src/app.ts"], reviewId: String(review.reviewId) }
        expect(
          yield* errorCode(
            runtime.invoke({
              kind: "restore",
              args,
              sessionID: "session",
              authorize: (_action, _resource, metadata) => {
                expect(metadata.requireApproval).toBe(true)
                return Effect.fail(new GitError("PERMISSION_DENIED"))
              },
            }),
          ),
        ).toBe("PERMISSION_DENIED")
        yield* invoke("restore", args)
        expect(approvals.at(-1)?.requireApproval).toBe(true)
        expect(yield* Effect.promise(() => fs.readFile(path.join(root, "src/app.ts"), "utf8"))).toBe("original\n")
      }),
    ),
  )
  it.live("nothing to commit and unapproved user staging are rejected", () =>
    setup((root, _runtime, _approvals, invoke) =>
      Effect.gen(function* () {
        expect(yield* errorCode(invoke("commit", { message: "empty", reviewId: "none" }))).toBe("NOTHING_TO_COMMIT")
        yield* Effect.promise(async () => {
          await fs.writeFile(path.join(root, "user.txt"), "user staged\n")
          await raw(root, "add", "user.txt")
        })
        const review = yield* invoke("diff", { staged: true })
        expect(yield* errorCode(invoke("commit", { message: "user", reviewId: String(review.reviewId) }))).toBe(
          "UNAPPROVED_STAGED_CHANGES",
        )
      }),
    ),
  )
  it.live("secret files/patterns block commit without exposing secret diagnostics", () =>
    setup((root, _runtime, _approvals, invoke) =>
      Effect.gen(function* () {
        yield* edit(root, 'api_key="super-private-value"\n')
        const review = yield* invoke("diff", { paths: ["src/app.ts"] })
        expect(review.patch).not.toContain("super-private-value")
        yield* invoke("stage", { paths: ["src/app.ts"], reviewId: String(review.reviewId) })
        const staged = yield* invoke("diff", { staged: true })
        expect(yield* errorCode(invoke("commit", { message: "secret", reviewId: String(staged.reviewId) }))).toBe(
          "POTENTIAL_SECRET_IN_STAGED_CHANGES",
        )
        expect(
          yield* errorCode(
            invoke("commit", { message: "token=super-private-value", reviewId: String(staged.reviewId) }),
          ),
        ).toBe("POTENTIAL_SECRET_IN_STAGED_CHANGES")
        expect(yield* errorCode(invoke("commit", { message: "bad\nmessage", reviewId: String(staged.reviewId) }))).toBe(
          "INVALID_COMMIT_MESSAGE",
        )
      }),
    ),
  )
  it.live("configured bare remote push/fetch requires ASK; URL/force/missing targets denied", () =>
    setup((root, _runtime, approvals, invoke) =>
      Effect.gen(function* () {
        const remote = path.join(root, "remote.git")
        yield* Effect.promise(async () => {
          await raw(root, "init", "--bare", remote)
          await raw(root, "remote", "add", "origin", remote)
        })
        const pushed = yield* invoke("push", { remote: "origin", branch: "main" })
        expect(approvals.at(-1)).toMatchObject({ requireApproval: true, remote: "origin", branch: "main" })
        expect(yield* Effect.promise(() => raw(root, "--git-dir", remote, "rev-parse", "refs/heads/main"))).toBe(
          String(pushed.newSha),
        )
        expect(yield* errorCode(invoke("push", { remote: "origin", branch: "main", force: true }))).toBe(
          "FORCE_GIT_DENIED",
        )
        expect(yield* errorCode(invoke("push", { remote: "https://attacker.example/repo", branch: "main" }))).toBe(
          "INVALID_REMOTE",
        )
        expect(yield* errorCode(invoke("push", { remote: "missing", branch: "main" }))).toBe("REMOTE_NOT_FOUND")
        yield* invoke("fetch", { remote: "origin", branch: "main" })
        yield* Effect.promise(() =>
          raw(root, "--git-dir", remote, "update-ref", "refs/heads/remote-only", String(pushed.newSha)),
        )
        expect((yield* invoke("fetch", { remote: "origin", branch: "remote-only" })).ok).toBe(true)
        expect(yield* errorCode(invoke("push", { remote: "origin", branch: "main", forceWithLease: true }))).toBe(
          "FORCE_GIT_DENIED",
        )
        expect(yield* errorCode(invoke("push", { remote: "origin", branch: "main", flags: ["-f"] }))).toBe(
          "FORCE_GIT_DENIED",
        )
        expect(approvals.at(-1)?.requireApproval).toBe(true)
        expect((yield* invoke("remote.list")).remotes).toEqual(["origin"])
        expect((yield* invoke("push", { remote: "origin", branch: "main" })).oldSha).toBe(String(pushed.newSha))
      }),
    ),
  )
  it.live("no repo returns structured error and does not initialize Git", () =>
    setup(
      (root, _runtime, _approvals, invoke) =>
        Effect.gen(function* () {
          expect(yield* errorCode(invoke("status"))).toBe("NOT_A_GIT_REPOSITORY")
          expect(yield* Effect.promise(() => fs.stat(path.join(root, ".git")).catch(() => undefined))).toBeUndefined()
        }),
      false,
      false,
    ),
  )
  it.live(".git writes and aliases are blocked; shell destructive Git has no bypass", () =>
    setup((root) =>
      Effect.gen(function* () {
        const files = new WorkspaceFiles(root)
        for (const item of [".git/config", ".git/HEAD", ".git/index"]) {
          yield* Effect.promise(async () => {
            await files.read("session", { path: item }).catch(() => undefined)
            await expect(
              files.prepare("session", "write", { path: item, mode: "replace", content: "corrupt" }),
            ).rejects.toThrow("PERMISSION_DENIED")
          })
        }
        for (const command of [
          "git status",
          "git reset --hard",
          "git clean -fd",
          "git push --force",
          "git push --force-with-lease",
          "git checkout -- .",
        ])
          expect(() => classifyCommand(command)).toThrow()
        expect(gitKinds).not.toContain("reset")
      }),
    ),
  )
  it.live("new files are reviewed; .env staging is blocked at commit", () =>
    setup((root, _runtime, _approvals, invoke) =>
      Effect.gen(function* () {
        yield* Effect.promise(async () => {
          const files = new WorkspaceFiles(root)
          await files.commit(
            "session",
            "new",
            await files.prepare("session", "write", { path: ".env", content: "ordinary-looking configuration" }),
          )
        })
        const review = yield* invoke("diff", { paths: [".env"] })
        expect(review.patch).toContain("ordinary-looking configuration")
        yield* invoke("stage", { paths: [".env"], reviewId: String(review.reviewId) })
        const staged = yield* invoke("diff", { staged: true })
        expect(yield* errorCode(invoke("commit", { message: "config", reviewId: String(staged.reviewId) }))).toBe(
          "POTENTIAL_SECRET_IN_STAGED_CHANGES",
        )
      }),
    ),
  )
  it.live("rename/deletion metadata is preserved and both paths require ownership", () =>
    setup((root, _runtime, _approvals, invoke) =>
      Effect.gen(function* () {
        yield* Effect.promise(() => raw(root, "mv", "src/app.ts", "src/new.ts"))
        const state = yield* invoke("status")
        expect(state.entries).toMatchObject([{ path: "src/new.ts", originalPath: "src/app.ts", staged: true }])
        const staged = yield* invoke("diff", { staged: true })
        expect(staged.paths).toEqual(["src/app.ts", "src/new.ts"])
        expect(yield* errorCode(invoke("commit", { message: "rename", reviewId: String(staged.reviewId) }))).toBe(
          "UNAPPROVED_STAGED_CHANGES",
        )
        const review = yield* invoke("diff", { paths: ["src/app.ts", "src/new.ts"] })
        yield* invoke("stage", { paths: ["src/app.ts", "src/new.ts"], reviewId: String(review.reviewId) })
        const fresh = yield* invoke("diff", { staged: true })
        expect((yield* invoke("commit", { message: "rename approved", reviewId: String(fresh.reviewId) })).ok).toBe(
          true,
        )
      }),
    ),
  )
  it.live("conflicted index is reported and commit refuses unresolved paths", () =>
    setup((root, _runtime, _approvals, invoke) =>
      Effect.gen(function* () {
        yield* Effect.promise(async () => {
          await raw(root, "switch", "-c", "other")
          await fs.writeFile(path.join(root, "src/app.ts"), "other branch\n")
          await raw(root, "add", "src/app.ts")
          await raw(root, "commit", "-m", "other")
          await raw(root, "switch", "main")
          await fs.writeFile(path.join(root, "src/app.ts"), "main branch\n")
          await raw(root, "add", "src/app.ts")
          await raw(root, "commit", "-m", "main")
          expect(
            await Bun.spawn(["git", "merge", "other"], { cwd: root, stdout: "ignore", stderr: "ignore" }).exited,
          ).not.toBe(0)
        })
        expect((yield* invoke("status")).conflicts).toEqual(["src/app.ts"])
        expect(yield* errorCode(invoke("commit", { message: "conflict", reviewId: "none" }))).toBe("CONFLICTED_INDEX")
      }),
    ),
  )
  it.live("bounded textual/binary diff and log use actual Git metadata", () =>
    setup((root, _runtime, _approvals, invoke) =>
      Effect.gen(function* () {
        yield* edit(root, "large line\n".repeat(10000))
        const large = yield* invoke("diff", { paths: ["src/app.ts"] })
        expect(large.truncated).toBe(true)
        expect(Buffer.byteLength(String(large.patch))).toBeLessThanOrEqual(8192)
        yield* Effect.promise(() => fs.writeFile(path.join(root, "binary.bin"), Buffer.from([0, 1, 2])))
        expect((yield* invoke("diff", { paths: ["binary.bin"] })).binary).toBe("BINARY_DIFF")
        yield* Effect.promise(() => fs.writeFile(path.join(root, "large-untracked.txt"), "Проверка\n".repeat(2000)))
        const untracked = yield* invoke("diff", { paths: ["large-untracked.txt"] })
        expect(untracked.truncated).toBe(true)
        expect(Buffer.byteLength(String(untracked.patch))).toBeLessThanOrEqual(4096)
        expect((yield* invoke("log", { count: 1 })).commits).toMatchObject([{ subject: "initial", author: "Phase9D" }])
        expect(yield* errorCode(invoke("log", { count: 1000 }))).toBe("INVALID_ARGUMENT")
      }),
    ),
  )
  it.live("push rejection never forces or changes remote branch", () =>
    setup((root, _runtime, _approvals, invoke) =>
      Effect.gen(function* () {
        const remote = path.join(root, "remote.git")
        yield* Effect.promise(async () => {
          await raw(root, "init", "--bare", remote)
          await raw(root, "remote", "add", "origin", remote)
        })
        yield* invoke("push", { remote: "origin", branch: "main" })
        const old = yield* Effect.promise(() => raw(root, "rev-parse", "HEAD"))
        const advanced = yield* Effect.promise(() =>
          raw(
            root,
            "--git-dir",
            remote,
            "-c",
            "user.name=Remote",
            "-c",
            "user.email=remote@example.invalid",
            "commit-tree",
            `${old}^{tree}`,
            "-p",
            old,
            "-m",
            "remote advanced",
          ),
        )
        yield* Effect.promise(() => raw(root, "--git-dir", remote, "update-ref", "refs/heads/main", advanced))
        expect(yield* errorCode(invoke("push", { remote: "origin", branch: "main" }))).toBe("PUSH_REJECTED")
        expect(yield* Effect.promise(() => raw(root, "--git-dir", remote, "rev-parse", "refs/heads/main"))).toBe(
          advanced,
        )
      }),
    ),
  )
  it.live("junction escapes and metadata aliases are rejected", () =>
    setup((root, _runtime, _approvals, invoke) =>
      Effect.gen(function* () {
        yield* Effect.promise(async () => {
          const outside = await fs.mkdtemp(path.join(path.dirname(root), "phase9d-outside-"))
          try {
            await fs.writeFile(path.join(outside, "file.txt"), "outside")
            await fs.symlink(outside, path.join(root, "escape"), "junction")
            await fs.symlink(path.join(root, ".git"), path.join(root, "metadata"), "junction")
            const files = new WorkspaceFiles(root)
            await expect(files.resolve("escape/file.txt")).rejects.toThrow("PATH_OUTSIDE_WORKSPACE")
            await files.read("session", { path: "metadata/config" })
            await expect(
              files.prepare("session", "write", { path: "metadata/config", mode: "replace", content: "corrupt" }),
            ).rejects.toThrow("PERMISSION_DENIED")
          } finally {
            await fs.rm(path.join(root, "escape"), { force: true }).catch(() => undefined)
            await fs.rm(outside, { recursive: true, force: true })
          }
        })
        expect(yield* errorCode(invoke("branch.switch", { branch: "main" }))).toBe("DIRTY_WORKTREE")
      }),
    ),
  )
  it.live("nested clean branch switch cannot change files above workspace", () =>
    setup(
      (_root, _runtime, _approvals, invoke) =>
        Effect.gen(function* () {
          yield* invoke("branch.create", { branch: "feature/nested" })
          expect(yield* errorCode(invoke("branch.switch", { branch: "feature/nested" }))).toBe("PATH_OUTSIDE_WORKSPACE")
          expect((yield* invoke("status")).branch).toBe("main")
        }),
      true,
    ),
  )
  it.live("Windows path casing shares canonical workspace write ownership", () =>
    setup((root) =>
      Effect.gen(function* () {
        yield* edit(root)
        const git = yield* Git.Service
        const app = yield* AppProcess.Service
        const runtime = ManagedGit.make(process.platform === "win32" ? root.toUpperCase() : root, git, app)
        const invoke = (kind: GitKind, args: GitInput) =>
          runtime.invoke({
            kind,
            args,
            sessionID: "session",
            authorize: (_action, _resource, metadata) => {
              if (kind === "stage") expect(metadata.requireApproval).toBe(false)
              return Effect.void
            },
          })
        const review = yield* invoke("diff", { paths: ["src/app.ts"] })
        expect((yield* invoke("stage", { paths: ["src/app.ts"], reviewId: String(review.reviewId) })).ok).toBe(true)
      }),
    ),
  )
})
