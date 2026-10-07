import path from "node:path"
import { createHash, randomUUID } from "node:crypto"
import fs, { link, lstat, open, realpath, unlink } from "node:fs/promises"
import { constants } from "node:fs"

export const FILE_BYTES = 512 * 1024
export const PATCH_BYTES = 128 * 1024
export const TURN_WRITE_BYTES = 2 * 1024 * 1024
export const TURN_WRITE_FILES = 8
export const MAX_RESULTS = 100
export const MAX_LINES = 200

export type FileErrorCode =
  | "PATH_OUTSIDE_WORKSPACE"
  | "PERMISSION_DENIED"
  | "FILE_NOT_FOUND"
  | "FILE_ALREADY_EXISTS"
  | "FILE_CHANGED_SINCE_READ"
  | "AMBIGUOUS_EDIT"
  | "NO_MATCH"
  | "UNSUPPORTED_BINARY_FILE"
  | "FILE_TOO_LARGE"
  | "WRITE_LIMIT_EXCEEDED"
  | "TIMEOUT"
  | "CANCELLED"
  | "INVALID_ARGUMENT"
  | "EXECUTION_FAILED"

export class WorkspaceFileError extends Error {
  constructor(readonly code: FileErrorCode) {
    super(code)
    this.name = "WorkspaceFileError"
  }
}

export type FileInput = {
  path?: string
  content?: string
  mode?: "create" | "replace"
  expectedHash?: string
  oldString?: string
  newString?: string
  replaceAll?: boolean
  startLine?: number
  maxLines?: number
  limit?: number
  pattern?: string
  regex?: boolean
  include?: string
}
export type FilePlan = {
  relative: string
  target: string
  parent: string
  before?: Buffer
  after: Buffer
  operation: "create" | "write" | "edit"
}
export const contentHash = (value: Uint8Array) => createHash("sha256").update(value).digest("hex")
const fail = (code: FileErrorCode): never => {
  throw new WorkspaceFileError(code)
}
const cancelled = (signal?: AbortSignal) => {
  if (signal?.aborted) fail("CANCELLED")
}

export function relativeFilePath(value: string) {
  if (!value || value.includes("\0") || path.win32.isAbsolute(value) || path.posix.isAbsolute(value))
    fail("PATH_OUTSIDE_WORKSPACE")
  const segments = value.split(/[\\/]+/u)
  if (
    segments.some(
      (part) =>
        part === ".." ||
        /[:<>"|?*]/u.test(part) ||
        (/[. ]$/u.test(part) && part !== ".") ||
        /^(con|prn|aux|nul|com[1-9]|lpt[1-9])(?:\.|$)/iu.test(part),
    )
  )
    return fail("PATH_OUTSIDE_WORKSPACE")
  return segments.join(path.sep)
}
const inside = (root: string, target: string) => {
  const relative = path.relative(root, target)
  if (relative === ".." || relative.startsWith(`..${path.sep}`) || path.isAbsolute(relative))
    fail("PATH_OUTSIDE_WORKSPACE")
}
const binaryExtension = /\.(?:exe|dll|zip|7z|gz|png|jpe?g|gif|webp|ico|pdf|db|sqlite3?|bin|wasm)$/iu
function text(value: Uint8Array, name: string) {
  if (binaryExtension.test(name) || value.some((byte) => byte === 0 || byte < 9 || (byte > 13 && byte < 32)))
    return fail("UNSUPPORTED_BINARY_FILE")
  try {
    return new TextDecoder("utf-8", { fatal: true, ignoreBOM: true }).decode(value)
  } catch {
    return fail("UNSUPPORTED_BINARY_FILE")
  }
}
const bounded = <K, V>(map: Map<K, V>, key: K, value: V, limit: number) => {
  map.delete(key)
  map.set(key, value)
  if (map.size > limit) map.delete(map.keys().next().value!)
}

/** Shared managed policy; roots, session and turn keys come only from the runtime. */
export class WorkspaceFiles {
  private revisions = new Map<string, string>()
  private writes = new Map<string, { bytes: number; files: Set<string> }>()
  private canonicalRoot?: Promise<string>
  // Process-local cooperating commits serialize per canonical target, across sessions and runtimes.
  private static locks = new Map<string, Promise<void>>()
  constructor(readonly root: string) {}

  rootPath() {
    return (this.canonicalRoot ??= realpath(this.root))
  }

  async resolve(relative: string, missing = false) {
    const safe = relativeFilePath(relative)
    const root = await this.rootPath()
    const target = path.resolve(root, safe)
    inside(root, target)
    try {
      const canonical = await realpath(target)
      inside(root, canonical)
      return canonical
    } catch (error) {
      if (error instanceof WorkspaceFileError) throw error
      if (!(error && typeof error === "object" && "code" in error && error.code === "ENOENT")) throw error
      if (!missing) return fail("FILE_NOT_FOUND")
      // No implicit parent creation. A dangling symlink cannot become a create target.
      const info = await lstat(target).catch(() => undefined)
      if (info) return fail("PATH_OUTSIDE_WORKSPACE")
      const parent = await realpath(path.dirname(target)).catch(() => fail("FILE_NOT_FOUND"))
      inside(root, parent)
      return path.join(parent, path.basename(target))
    }
  }

  private async bytes(target: string, signal?: AbortSignal) {
    cancelled(signal)
    const handle = await open(target, constants.O_RDONLY | constants.O_NOFOLLOW).catch(() => fail("FILE_NOT_FOUND"))
    try {
      // Recheck after opening. The descriptor remains tied to that inode.
      const canonical = await realpath(target)
      inside(await this.rootPath(), canonical)
      if (canonical !== target) return fail("PATH_OUTSIDE_WORKSPACE")
      const info = await handle.stat()
      if (!info.isFile()) return fail("UNSUPPORTED_BINARY_FILE")
      if (info.size > FILE_BYTES) return fail("FILE_TOO_LARGE")
      const buffer = Buffer.alloc(FILE_BYTES + 1)
      let length = 0
      while (length < buffer.length) {
        cancelled(signal)
        const result = await handle.read(buffer, length, buffer.length - length, length)
        if (!result.bytesRead) break
        length += result.bytesRead
      }
      if (length > FILE_BYTES) return fail("FILE_TOO_LARGE")
      return buffer.subarray(0, length)
    } finally {
      await handle.close()
    }
  }

  async validateText(relative: string, signal?: AbortSignal) {
    text(await this.bytes(await this.resolve(relative), signal), relative)
  }

  async read(session: string, input: FileInput, signal?: AbortSignal) {
    const relative = input.path ?? ""
    const target = await this.resolve(relative)
    const bytes = await this.bytes(target, signal)
    const content = text(bytes, relative)
    const hash = contentHash(bytes)
    const start = input.startLine ?? 1
    const limit = input.maxLines ?? MAX_LINES
    if (!Number.isInteger(start) || start < 1 || !Number.isInteger(limit) || limit < 1 || limit > MAX_LINES)
      return fail("INVALID_ARGUMENT")
    bounded(this.revisions, `${session}:${target}`, hash, 1024)
    const lines = content.split(/\r?\n/u)
    return {
      ok: true,
      path: relative.replaceAll("\\", "/"),
      content: lines.slice(start - 1, start - 1 + limit).join("\n"),
      hash,
      startLine: start,
      truncated: lines.length > start - 1 + limit,
      bytes: bytes.length,
    }
  }

  async prepare(
    session: string,
    operation: "write" | "edit",
    input: FileInput,
    signal?: AbortSignal,
  ): Promise<FilePlan> {
    cancelled(signal)
    const relative = input.path ?? ""
    const target = await this.resolve(relative, operation === "write")
    const info = await lstat(target).catch(() => undefined)
    if (info?.isSymbolicLink()) return fail("PATH_OUTSIDE_WORKSPACE")
    if (operation === "write" && (input.mode ?? "create") === "create" && info) return fail("FILE_ALREADY_EXISTS")
    if ((operation === "edit" || input.mode === "replace") && !info) return fail("FILE_NOT_FOUND")
    const before = info ? await this.bytes(target, signal) : undefined
    const old = before ? text(before, relative) : ""
    if (before) {
      const observed = this.revisions.get(`${session}:${target}`)
      if (
        !observed ||
        observed !== contentHash(before) ||
        (input.expectedHash !== undefined && observed !== input.expectedHash)
      )
        fail("FILE_CHANGED_SINCE_READ")
    }
    let next = input.content
    if (operation === "edit") {
      const from = input.oldString
      const to = input.newString
      if (!from || to === undefined || from === to) return fail("INVALID_ARGUMENT")
      if (Buffer.byteLength(from) + Buffer.byteLength(to) > PATCH_BYTES) return fail("FILE_TOO_LARGE")
      const ending = old.includes("\r\n") ? "\r\n" : "\n"
      const normalize = (value: string) => value.replaceAll("\r\n", "\n").replaceAll("\n", ending)
      const search = normalize(from)
      const replacement = normalize(to)
      const matches = old.split(search).length - 1
      if (!matches) return fail("NO_MATCH")
      if (matches > 1 && !input.replaceAll) return fail("AMBIGUOUS_EDIT")
      next = input.replaceAll ? old.replaceAll(search, replacement) : old.replace(search, () => replacement)
    }
    if (next === undefined) return fail("INVALID_ARGUMENT")
    if (/\p{Surrogate}/u.test(next)) return fail("UNSUPPORTED_BINARY_FILE")
    // Retain a source BOM on full replacement.
    if (old.startsWith("\uFEFF") && !next.startsWith("\uFEFF")) next = `\uFEFF${next}`
    const after = Buffer.from(next, "utf8")
    if (after.length > FILE_BYTES) return fail("FILE_TOO_LARGE")
    text(after, relative)
    return {
      relative,
      target,
      parent: path.dirname(target),
      before,
      after,
      operation: operation === "edit" ? "edit" : before ? "write" : "create",
    }
  }

  async commit(session: string, turn: string, plan: FilePlan, signal?: AbortSignal) {
    const previous = WorkspaceFiles.locks.get(plan.target) ?? Promise.resolve()
    let unlock!: () => void
    const current = new Promise<void>((resolve) => {
      unlock = resolve
    })
    WorkspaceFiles.locks.set(plan.target, current)
    await previous
    try {
      cancelled(signal)
      const key = `${session}:${turn}`
      const budget = this.writes.get(key) ?? { bytes: 0, files: new Set<string>() }
      if (
        budget.bytes + plan.after.length > TURN_WRITE_BYTES ||
        (!budget.files.has(plan.target) && budget.files.size >= TURN_WRITE_FILES)
      )
        return fail("WRITE_LIMIT_EXCEEDED")
      // Reserve before async IO, including concurrent writes to other targets.
      // Failed attempts consume the same bounded turn budget.
      budget.bytes += plan.after.length
      budget.files.add(plan.target)
      bounded(this.writes, key, budget, 128)
      const verify = async () => {
        cancelled(signal)
        try {
          if (
            (await this.resolve(plan.relative, !plan.before)) !== plan.target ||
            (await realpath(plan.parent)) !== plan.parent
          )
            fail("PATH_OUTSIDE_WORKSPACE")
        } catch (error) {
          if (plan.before && error instanceof WorkspaceFileError && error.code === "FILE_NOT_FOUND")
            fail("FILE_CHANGED_SINCE_READ")
          throw error
        }
        if (plan.before) {
          if (contentHash(await this.bytes(plan.target, signal)) !== contentHash(plan.before))
            fail("FILE_CHANGED_SINCE_READ")
        } else if (await lstat(plan.target).catch(() => undefined)) fail("FILE_ALREADY_EXISTS")
      }
      await verify()
      const temporary = path.join(plan.parent, `.opencode-${randomUUID()}.tmp`)
      let handle: Awaited<ReturnType<typeof open>> | undefined
      try {
        const mode = (await lstat(plan.target).catch(() => undefined))?.mode ?? 0o600
        handle = await open(temporary, "wx", mode)
        await verify()
        await handle.writeFile(plan.after)
        await handle.sync()
        await handle.close()
        handle = undefined
        await verify()
        if (plan.before) await fs.rename(temporary, plan.target)
        else
          await link(temporary, plan.target).catch((error) => {
            if (error && typeof error === "object" && "code" in error && error.code === "EEXIST")
              return fail("FILE_ALREADY_EXISTS")
            throw error
          })
      } finally {
        await handle?.close().catch(() => undefined)
        if ((await realpath(plan.parent).catch(() => undefined)) === plan.parent)
          await unlink(temporary).catch(() => undefined)
      }
      const hash = contentHash(plan.after)
      bounded(this.revisions, `${session}:${plan.target}`, hash, 1024)
      return {
        ok: true,
        operation: plan.operation,
        path: plan.relative.replaceAll("\\", "/"),
        changed: !plan.before || !plan.before.equals(plan.after),
        bytes: plan.after.length,
        oldHash: plan.before ? contentHash(plan.before) : null,
        hash,
      }
    } finally {
      unlock()
      if (WorkspaceFiles.locks.get(plan.target) === current) WorkspaceFiles.locks.delete(plan.target)
    }
  }
}
