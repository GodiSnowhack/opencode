export * as ManagedExecution from "./managed-execution"

import path from "node:path"
import { stat } from "node:fs/promises"
import { randomUUID } from "node:crypto"
import { Effect, Exit, Scope, Semaphore, Stream } from "effect"
import { ChildProcess } from "effect/unstable/process"
import type { ChildProcessHandle } from "effect/unstable/process/ChildProcessSpawner"
import { AppProcess } from "../process"
import { Shell } from "../shell"
import { WorkspaceFiles, WorkspaceFileError } from "./workspace-files"
import { classifyCommand, CommandError, outputRedactor } from "./command-policy"
import { windowsJobBootstrap } from "./windows-job"

export type ExecutionInput = { command?: string; cwd?: string; timeoutMs?: number; processId?: string }
export type ExecutionKind = "exec" | "test" | "start" | "status" | "stop"
export type ExecutionResult = {
  ok: boolean
  code?: string
  command: string
  cwd: string
  risk: string
  processId: string
  exitCode: number | null
  stdout: string
  stderr: string
  durationMs: number
  timedOut: boolean
  cancelled: boolean
  truncated: boolean
  running: boolean
}
type Job = {
  session: string
  scope: Scope.Closeable
  handle: ChildProcessHandle
  result: ExecutionResult
  started: number
}

/** One policy over the upstream spawner, scoped to the current workspace/Location. */
export function make(root: string, app: AppProcess.Interface) {
  return Effect.gen(function* () {
    const owner = yield* Effect.scope
    const files = new WorkspaceFiles(root)
    const jobs = new Map<string, Job>()
    const spawnLock = yield* Semaphore.make(1)
    const redact = outputRedactor()
    yield* Effect.addFinalizer(() =>
      Effect.forEach(jobs.values(), (job) => Scope.close(job.scope, Exit.void), { discard: true }),
    )
    const snapshot = (job: Job) => ({
      ...job.result,
      durationMs: job.result.running ? Date.now() - job.started : job.result.durationMs,
    })
    const stop = (job: Job) =>
      Scope.close(job.scope, Exit.void).pipe(
        Effect.tap(() =>
          Effect.sync(() => {
            if (job.result.running) job.result.durationMs = Date.now() - job.started
            job.result.running = false
          }),
        ),
      )

    const invoke = Effect.fn("ManagedExecution.invoke")(function* (input: {
      kind: ExecutionKind
      args: ExecutionInput
      sessionID: string
      authorize(command: string, risk: string): Effect.Effect<void, CommandError>
      progress?(result: ExecutionResult): Effect.Effect<void>
    }) {
      if (input.kind === "status" || input.kind === "stop") {
        const job = jobs.get(input.args.processId ?? "")
        if (!job) return yield* Effect.fail(new CommandError("PROCESS_NOT_FOUND"))
        if (job.session !== input.sessionID) return yield* Effect.fail(new CommandError("PROCESS_NOT_OWNED"))
        if (input.kind === "stop") {
          if (!job.result.running) return { ...snapshot(job), ok: false, code: "PROCESS_ALREADY_EXITED" }
          job.result.cancelled = true
          job.result.ok = false
          job.result.code = "CANCELLED"
          yield* stop(job)
          return { ...snapshot(job), ok: true, code: undefined }
        }
        return snapshot(job)
      }
      const policy = yield* Effect.try({
        try: () => classifyCommand(input.args.command ?? ""),
        catch: (error) => (error instanceof CommandError ? error : new CommandError("INVALID_ARGUMENT")),
      })
      if (redact(input.args.command!) !== input.args.command)
        return yield* Effect.fail(new CommandError("COMMAND_DENIED", "SYSTEM"))
      if (input.kind === "test" && policy.risk !== "SAFE_TEST")
        return yield* Effect.fail(new CommandError("COMMAND_DENIED", policy.risk))
      const cwd = yield* Effect.tryPromise({
        try: () => files.resolve(input.args.cwd ?? "."),
        catch: () => new CommandError("PATH_OUTSIDE_WORKSPACE"),
      })
      if (
        !(yield* Effect.tryPromise({
          try: () => stat(cwd),
          catch: () => new CommandError("PATH_OUTSIDE_WORKSPACE"),
        })).isDirectory()
      )
        return yield* Effect.fail(new CommandError("INVALID_ARGUMENT"))
      const canonicalRoot = yield* Effect.promise(() => files.rootPath())
      // Node entrypoints must exist inside the validated cwd. No -e/-p/loaders.
      const entrypoint =
        policy.tokens[0].toLowerCase().replace(/\.(?:exe|cmd|bat)$/, "") === "node"
          ? path.relative(canonicalRoot, path.resolve(cwd, policy.tokens[1]))
          : undefined
      const verifyEntry = () =>
        Effect.tryPromise({
          try: () => files.resolve(entrypoint!),
          catch: (error) =>
            new CommandError(
              error instanceof WorkspaceFileError && error.code === "FILE_NOT_FOUND"
                ? "COMMAND_NOT_FOUND"
                : "PATH_OUTSIDE_WORKSPACE",
            ),
        })
      if (entrypoint) yield* verifyEntry()
      const timeout = input.args.timeoutMs ?? (input.kind === "start" ? 600_000 : policy.timeoutMs)
      if (!Number.isInteger(timeout) || timeout < 100 || timeout > (input.kind === "start" ? 600_000 : 300_000))
        return yield* Effect.fail(new CommandError("INVALID_ARGUMENT"))
      if ([...jobs.values()].filter((job) => job.result.running).length >= 4)
        return yield* Effect.fail(new CommandError("PROCESS_LIMIT_EXCEEDED"))
      yield* input.authorize(input.args.command!, policy.risk)
      // Revalidate after both permission and spawn-lock waits.
      const job = yield* spawnLock.withPermit(
        Effect.gen(function* () {
          if ([...jobs.values()].filter((job) => job.result.running).length >= 4)
            return yield* Effect.fail(new CommandError("PROCESS_LIMIT_EXCEEDED"))
          if (
            (yield* Effect.tryPromise({
              try: () => files.resolve(input.args.cwd ?? "."),
              catch: () => new CommandError("PATH_OUTSIDE_WORKSPACE"),
            })) !== cwd
          )
            return yield* Effect.fail(new CommandError("PATH_OUTSIDE_WORKSPACE"))
          if (entrypoint) yield* verifyEntry()
          const scope = yield* Scope.make()
          const shell = Shell.preferred(process.platform === "win32" ? "powershell.exe" : "/bin/sh")
          if (!shell || (process.platform === "win32" && !Shell.ps(shell)))
            return yield* Effect.fail(new CommandError("COMMAND_NOT_FOUND"))
          const literal = policy.tokens
            .map((token) => `'${token.replaceAll("'", Shell.ps(shell) ? "''" : "'\\''")}'`)
            .join(" ")
          const executable = `'${policy.tokens[0].replaceAll("'", "''")}'`
          const command = Shell.ps(shell)
            ? `${windowsJobBootstrap}\n[Console]::OutputEncoding = [System.Text.UTF8Encoding]::new(); $OutputEncoding = [Console]::OutputEncoding; if (-not (Get-Command -Name ${executable} -ErrorAction SilentlyContinue)) { [Console]::Error.WriteLine('MANAGED_COMMAND_NOT_FOUND'); exit 127 }; $global:LASTEXITCODE = 0; & ${literal}; $commandSucceeded = $?; if ($LASTEXITCODE -ne 0) { exit $LASTEXITCODE }; if (-not $commandSucceeded) { exit 1 }; exit 0`
            : literal
          const handle = yield* app
            .spawn(
              ChildProcess.make(shell, Shell.args(shell, command, cwd), {
                cwd,
                stdin: "ignore",
                detached: process.platform !== "win32",
                forceKillAfter: "3 seconds",
              }),
            )
            .pipe(
              Effect.provideService(Scope.Scope, scope),
              Effect.mapError(() => new CommandError("COMMAND_NOT_FOUND")),
              Effect.onError(() => Scope.close(scope, Exit.void)),
            )
          const id = randomUUID()
          const job: Job = {
            session: input.sessionID,
            scope,
            handle,
            started: Date.now(),
            result: {
              ok: true,
              command: redact(input.args.command!),
              cwd: path.relative(canonicalRoot, cwd).replaceAll("\\", "/") || ".",
              risk: policy.risk,
              processId: id,
              exitCode: null,
              stdout: "",
              stderr: "",
              durationMs: 0,
              timedOut: false,
              cancelled: false,
              truncated: false,
              running: true,
            },
          }
          jobs.set(id, job)
          return job
        }),
      )
      while (jobs.size > 64) {
        const finished = [...jobs].find(([, item]) => !item.result.running)
        if (!finished) break
        jobs.delete(finished[0])
      }
      const capture = (stream: typeof job.handle.stdout, channel: "stdout" | "stderr") =>
        Effect.gen(function* () {
          const decoder = new TextDecoder()
          let pending = ""
          let dropping = false
          let lastProgress = 0
          const append = (text: string) => {
            const safe = redact(text).replaceAll(canonicalRoot, "<workspace>")
            const next = job.result[channel] + safe
            const buffer = Buffer.from(next)
            if (buffer.length <= 4096) {
              job.result[channel] = next
              return
            }
            job.result.truncated = true
            let offset = buffer.length - 4096
            while ((buffer[offset] & 0xc0) === 0x80) offset++
            job.result[channel] = buffer.subarray(offset).toString("utf8")
          }
          yield* Stream.runForEach(stream, (chunk) =>
            Effect.gen(function* () {
              const text = decoder.decode(chunk, { stream: true })
              for (const part of text.split(/(?<=\n)/)) {
                if (!dropping) pending += part
                if (pending.length > 16_384) {
                  pending = ""
                  dropping = true
                  job.result.truncated = true
                }
                if (!part.endsWith("\n")) continue
                append(dropping ? "[oversized output line omitted]\n" : pending)
                pending = ""
                dropping = false
                if (input.progress && Date.now() - lastProgress >= 100) {
                  lastProgress = Date.now()
                  yield* input.progress(snapshot(job))
                }
              }
            }),
          )
          pending += decoder.decode()
          if (!dropping) append(pending)
        })
      const completion = Effect.all(
        [capture(job.handle.stdout, "stdout"), capture(job.handle.stderr, "stderr"), job.handle.exitCode],
        { concurrency: "unbounded" },
      ).pipe(
        Effect.tap(([, , exit]) =>
          Effect.sync(() => {
            job.result.exitCode = exit
            if (job.result.cancelled || job.result.timedOut) return
            job.result.ok = exit === 0
            job.result.code =
              exit === 0
                ? undefined
                : exit === 127 && job.result.stderr.includes("MANAGED_COMMAND_NOT_FOUND")
                  ? "COMMAND_NOT_FOUND"
                  : exit === 125 && job.result.stderr.includes("MANAGED_JOB_SETUP_FAILED")
                    ? "PROCESS_ISOLATION_FAILED"
                    : "COMMAND_FAILED"
          }),
        ),
        Effect.catch(() =>
          Effect.sync(() => {
            if (!job.result.cancelled && !job.result.timedOut) {
              job.result.ok = false
              job.result.code = "COMMAND_FAILED"
            }
          }),
        ),
        Effect.timeoutOrElse({
          duration: timeout,
          orElse: () =>
            Effect.sync(() => {
              job.result.timedOut = true
              job.result.ok = false
              job.result.code = "TIMEOUT"
            }),
        }),
        Effect.ensuring(stop(job)),
      )
      if (input.kind === "start") {
        yield* Effect.forkIn(completion, owner)
        return snapshot(job)
      }
      return yield* completion.pipe(
        Effect.map(() => snapshot(job)),
        Effect.onInterrupt(() =>
          Effect.sync(() => {
            job.result.cancelled = true
            job.result.ok = false
            job.result.code = "CANCELLED"
          }),
        ),
      )
    })
    const stopSession = (session: string) =>
      Effect.forEach(
        [...jobs.values()].filter((job) => job.session === session && job.result.running),
        (job) => {
          job.result.cancelled = true
          job.result.ok = false
          job.result.code = "CANCELLED"
          return stop(job)
        },
        { discard: true },
      )
    return { invoke, stopSession }
  })
}
