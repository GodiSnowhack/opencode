import { afterEach, describe, expect, spyOn, test } from "bun:test"
import fs from "node:fs/promises"
import os from "node:os"
import path from "node:path"
import { FILE_BYTES, PATCH_BYTES, WorkspaceFiles } from "@opencode-ai/core/tool/workspace-files"

const roots: string[] = []
async function fixture() {
  const base = await fs.mkdtemp(path.join(os.tmpdir(), "phase9b-"))
  roots.push(base)
  const root = path.join(base, "workspace с пробелами")
  await fs.mkdir(root)
  await fs.writeFile(path.join(root, "info.txt"), "TEST_MODE = local\r\nOther line\r\n")
  return { root, base, files: new WorkspaceFiles(root) }
}
afterEach(async () => {
  for (const root of roots.splice(0)) await fs.rm(root, { recursive: true, force: true })
})
const reject = (promise: Promise<unknown>, code: string) =>
  promise.then(
    () => {
      throw new Error(`Expected ${code}`)
    },
    (error: unknown) => expect(error).toMatchObject({ code }),
  )

describe("Phase 9B workspace file policy", () => {
  for (const attempt of [
    "../secret.txt",
    "..\\secret.txt",
    "sub/..\\secret.txt",
    "C:\\Windows\\win.ini",
    "C:/Windows/win.ini",
    "/etc/passwd",
    "\\\\server\\share\\secret.txt",
    "\\\\?\\C:\\secret.txt",
    "\\\\.\\NUL",
    "C:secret.txt",
    "info.txt:stream",
    "NUL.txt",
    "dir/CON",
    "info.txt.",
    "info.txt ",
    "x\0.txt",
  ]) {
    test(`rejects model path ${JSON.stringify(attempt)}`, async () => {
      const { files } = await fixture()
      await reject(files.prepare("s", "write", { path: attempt, content: "bad" }), "PATH_OUTSIDE_WORKSPACE")
    })
  }
  test("rejects junction escape for existing and new files", async () => {
    const { root, base, files } = await fixture()
    await fs.writeFile(path.join(base, "secret.txt"), "secret")
    await fs.symlink(base, path.join(root, "escape"), process.platform === "win32" ? "junction" : "dir")
    await reject(files.read("s", { path: "escape/secret.txt" }), "PATH_OUTSIDE_WORKSPACE")
    await reject(files.prepare("s", "write", { path: "escape/new.txt", content: "bad" }), "PATH_OUTSIDE_WORKSPACE")
    expect(await fs.readFile(path.join(base, "secret.txt"), "utf8")).toBe("secret")
  })
  test("reads bounded UTF-8 lines and returns revision without absolute path", async () => {
    const { files, root } = await fixture()
    const result = await files.read("s", { path: "info.txt", maxLines: 1 })
    expect(result.content).toBe("TEST_MODE = local")
    expect(result.truncated).toBe(true)
    expect(result.hash).toMatch(/^[0-9a-f]{64}$/)
    expect(JSON.stringify(result)).not.toContain(root)
  })
  test("creates a Unicode filename without overwriting existing files", async () => {
    const { files, root } = await fixture()
    const input = { path: "данные теста.txt", content: "Юникод 😀\n" }
    await files.commit("s", "turn", await files.prepare("s", "write", input))
    expect(await fs.readFile(path.join(root, input.path), "utf8")).toBe(input.content)
    await reject(files.prepare("s", "write", input), "FILE_ALREADY_EXISTS")
    expect((await fs.readdir(root)).filter((name) => name.endsWith(".tmp"))).toEqual([])
  })
  test("requires trusted same-session read even when expectedHash is supplied", async () => {
    const { files } = await fixture()
    const read = await files.read("reader", { path: "info.txt" })
    await reject(
      files.prepare("other", "edit", {
        path: "info.txt",
        oldString: "local",
        newString: "changed",
        expectedHash: read.hash,
      }),
      "FILE_CHANGED_SINCE_READ",
    )
    await reject(
      files.prepare("other", "write", { path: "info.txt", mode: "replace", content: "changed" }),
      "FILE_CHANGED_SINCE_READ",
    )
  })
  test("exact edit preserves CRLF and BOM", async () => {
    const { files, root } = await fixture()
    await fs.writeFile(path.join(root, "info.txt"), "\uFEFFTEST_MODE = local\r\nOther line\r\n")
    await files.read("s", { path: "info.txt" })
    const plan = await files.prepare("s", "edit", {
      path: "info.txt",
      oldString: "local\nOther",
      newString: "phase9b\nOther",
    })
    await files.commit("s", "t", plan)
    expect(await fs.readFile(path.join(root, "info.txt"), "utf8")).toBe("\uFEFFTEST_MODE = phase9b\r\nOther line\r\n")
  })
  test("full replacement preserves BOM and checks expected revision", async () => {
    const { files, root } = await fixture()
    await fs.writeFile(path.join(root, "info.txt"), "\uFEFForiginal")
    const read = await files.read("s", { path: "info.txt" })
    await reject(
      files.prepare("s", "write", { path: "info.txt", mode: "replace", content: "new", expectedHash: "fake" }),
      "FILE_CHANGED_SINCE_READ",
    )
    await files.commit(
      "s",
      "t",
      await files.prepare("s", "write", { path: "info.txt", mode: "replace", content: "new", expectedHash: read.hash }),
    )
    expect(await fs.readFile(path.join(root, "info.txt"), "utf8")).toBe("\uFEFFnew")
  })
  test("no match and ambiguous edit leave original unchanged; replaceAll is explicit", async () => {
    const { files, root } = await fixture()
    await fs.writeFile(path.join(root, "info.txt"), "local local")
    await files.read("s", { path: "info.txt" })
    await reject(files.prepare("s", "edit", { path: "info.txt", oldString: "absent", newString: "x" }), "NO_MATCH")
    await reject(files.prepare("s", "edit", { path: "info.txt", oldString: "local", newString: "x" }), "AMBIGUOUS_EDIT")
    expect(await fs.readFile(path.join(root, "info.txt"), "utf8")).toBe("local local")
    await files.commit(
      "s",
      "t",
      await files.prepare("s", "edit", { path: "info.txt", oldString: "local", newString: "x", replaceAll: true }),
    )
    expect(await fs.readFile(path.join(root, "info.txt"), "utf8")).toBe("x x")
  })
  test("detects change after read and after preparing permission prompt", async () => {
    const { files, root } = await fixture()
    await files.read("s", { path: "info.txt" })
    const plan = await files.prepare("s", "edit", { path: "info.txt", oldString: "local", newString: "x" })
    await fs.writeFile(path.join(root, "info.txt"), "external editor")
    await reject(files.commit("s", "t", plan), "FILE_CHANGED_SINCE_READ")
    await reject(
      files.prepare("s", "edit", { path: "info.txt", oldString: "editor", newString: "x" }),
      "FILE_CHANGED_SINCE_READ",
    )
    expect(await fs.readFile(path.join(root, "info.txt"), "utf8")).toBe("external editor")
  })
  test("serializes concurrent replacement: second stale commit fails", async () => {
    const { files, root } = await fixture()
    await files.read("s", { path: "info.txt" })
    const plans = await Promise.all(
      ["one", "two"].map((newString) =>
        files.prepare("s", "edit", { path: "info.txt", oldString: "local", newString }),
      ),
    )
    const results = await Promise.allSettled(plans.map((plan) => files.commit("s", "t", plan)))
    expect(results.filter((result) => result.status === "fulfilled")).toHaveLength(1)
    expect(results.find((result) => result.status === "rejected")).toMatchObject({
      reason: { code: "FILE_CHANGED_SINCE_READ" },
    })
    expect(await fs.readFile(path.join(root, "info.txt"), "utf8")).toContain("one")
  })
  test("concurrent create never overwrites winner", async () => {
    const { files, root } = await fixture()
    const plans = await Promise.all(
      ["one", "two"].map((content) => files.prepare("s", "write", { path: "new.txt", content })),
    )
    const results = await Promise.allSettled(plans.map((plan) => files.commit("s", "t", plan)))
    expect(results.filter((result) => result.status === "fulfilled")).toHaveLength(1)
    expect(results.find((result) => result.status === "rejected")).toMatchObject({
      reason: { code: "FILE_ALREADY_EXISTS" },
    })
    expect(await fs.readFile(path.join(root, "new.txt"), "utf8")).toBe("one")
  })
  test("cancellation before commit preserves original and leaves no temporary files", async () => {
    const { files, root } = await fixture()
    await files.read("s", { path: "info.txt" })
    const plan = await files.prepare("s", "edit", { path: "info.txt", oldString: "local", newString: "x" })
    const controller = new AbortController()
    controller.abort()
    await reject(files.commit("s", "t", plan, controller.signal), "CANCELLED")
    expect(await fs.readFile(path.join(root, "info.txt"), "utf8")).toContain("local")
    expect((await fs.readdir(root)).filter((name) => name.endsWith(".tmp"))).toEqual([])
  })
  test("failed atomic rename preserves original and cleans temporary sibling", async () => {
    const { files, root } = await fixture()
    await files.read("s", { path: "info.txt" })
    const plan = await files.prepare("s", "edit", { path: "info.txt", oldString: "local", newString: "changed" })
    const rename = spyOn(fs, "rename").mockImplementationOnce(async () => {
      throw new Error("simulated IO failure")
    })
    try {
      await files.commit("s", "t", plan).then(
        () => {
          throw new Error("Expected atomic IO failure")
        },
        (error: unknown) => expect(error).toMatchObject({ message: "simulated IO failure" }),
      )
      expect(await fs.readFile(path.join(root, "info.txt"), "utf8")).toContain("local")
      expect((await fs.readdir(root)).filter((name) => name.endsWith(".tmp"))).toEqual([])
    } finally {
      rename.mockRestore()
    }
  })
  test("rejects binary/invalid UTF-8 on read and replacement", async () => {
    const { files, root } = await fixture()
    for (const bytes of [Buffer.from([0, 1]), Buffer.from([0xff, 0xfe, 65]), Buffer.from([0xc3, 0x28])]) {
      await fs.writeFile(path.join(root, "info.txt"), bytes)
      await reject(files.read("s", { path: "info.txt" }), "UNSUPPORTED_BINARY_FILE")
      await reject(
        files.prepare("s", "write", { path: "info.txt", mode: "replace", content: "x" }),
        "UNSUPPORTED_BINARY_FILE",
      )
    }
    await reject(files.prepare("s", "write", { path: "binary.bin", content: "text" }), "UNSUPPORTED_BINARY_FILE")
  })
  test("bounds file and patch bytes", async () => {
    const { files, root } = await fixture()
    await fs.writeFile(path.join(root, "large.txt"), "a".repeat(FILE_BYTES + 1))
    await reject(files.read("s", { path: "large.txt" }), "FILE_TOO_LARGE")
    await reject(files.prepare("s", "write", { path: "new.txt", content: "Ю".repeat(FILE_BYTES) }), "FILE_TOO_LARGE")
    await files.read("s", { path: "info.txt" })
    await reject(
      files.prepare("s", "edit", { path: "info.txt", oldString: "local", newString: "x".repeat(PATCH_BYTES) }),
      "FILE_TOO_LARGE",
    )
  })
  test("bounds concurrent distinct files per trusted turn and resets on next turn", async () => {
    const { files } = await fixture()
    const plans = await Promise.all(
      Array.from({ length: 9 }, (_, i) => files.prepare("s", "write", { path: `${i}.txt`, content: "x" })),
    )
    const results = await Promise.allSettled(plans.map((plan) => files.commit("s", "t", plan)))
    expect(results.filter((result) => result.status === "fulfilled")).toHaveLength(8)
    expect(results.find((result) => result.status === "rejected")).toMatchObject({
      reason: { code: "WRITE_LIMIT_EXCEEDED" },
    })
    await files.commit("s", "next", plans[8])
  })
  test("bounds aggregate write bytes during concurrent commits", async () => {
    const { files } = await fixture()
    const plans = await Promise.all(
      Array.from({ length: 5 }, (_, i) =>
        files.prepare("s", "write", { path: `${i}.txt`, content: "x".repeat(FILE_BYTES) }),
      ),
    )
    const results = await Promise.allSettled(plans.map((plan) => files.commit("s", "t", plan)))
    expect(results.filter((result) => result.status === "fulfilled")).toHaveLength(4)
    expect(results.find((result) => result.status === "rejected")).toMatchObject({
      reason: { code: "WRITE_LIMIT_EXCEEDED" },
    })
  })
  test("missing target and missing parent do not create directories", async () => {
    const { files, root } = await fixture()
    await reject(files.read("s", { path: "missing.txt" }), "FILE_NOT_FOUND")
    await reject(files.prepare("s", "write", { path: "missing/new.txt", content: "x" }), "FILE_NOT_FOUND")
    expect(await fs.readdir(root)).toEqual(["info.txt"])
  })
  test("rejects parent replaced by a junction while waiting for permission", async () => {
    const { files, root, base } = await fixture()
    await fs.mkdir(path.join(root, "sub"))
    const plan = await files.prepare("s", "write", { path: "sub/new.txt", content: "bad" })
    await fs.rename(path.join(root, "sub"), path.join(root, "original-sub"))
    await fs.symlink(base, path.join(root, "sub"), process.platform === "win32" ? "junction" : "dir")
    await reject(files.commit("s", "t", plan), "PATH_OUTSIDE_WORKSPACE")
    expect(await fs.readdir(base)).not.toContain("new.txt")
  })
  test("multi-file read/edit/create workflow shares a turn without a transaction", async () => {
    const { files, root } = await fixture()
    await fs.writeFile(path.join(root, "second.txt"), "SECOND = local\n")
    await files.read("s", { path: "info.txt" })
    await files.read("s", { path: "second.txt" })
    await files.commit(
      "s",
      "t",
      await files.prepare("s", "edit", { path: "info.txt", oldString: "local", newString: "phase9b" }),
    )
    await files.commit("s", "t", await files.prepare("s", "write", { path: "created.txt", content: "created\n" }))
    await files.commit(
      "s",
      "t",
      await files.prepare("s", "edit", { path: "second.txt", oldString: "local", newString: "gemma" }),
    )
    expect(await fs.readFile(path.join(root, "info.txt"), "utf8")).toContain("phase9b")
    expect(await fs.readFile(path.join(root, "second.txt"), "utf8")).toBe("SECOND = gemma\n")
    expect(await fs.readFile(path.join(root, "created.txt"), "utf8")).toBe("created\n")
  })
  test("Windows case aliases share canonical read revision and never bypass create protection", async () => {
    if (process.platform !== "win32") return
    const { files, root } = await fixture()
    await files.read("s", { path: "INFO.TXT" })
    await reject(files.prepare("s", "write", { path: "Info.Txt", content: "bad" }), "FILE_ALREADY_EXISTS")
    await files.commit(
      "s",
      "t",
      await files.prepare("s", "edit", { path: "info.txt", oldString: "local", newString: "phase9b" }),
    )
    expect(await fs.readFile(path.join(root, "info.txt"), "utf8")).toContain("phase9b")
  })
})
