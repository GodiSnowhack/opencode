import { expect, test } from "bun:test"
import {
  workspaceToolAction,
  workspaceToolStatus,
  gitToolKind,
  gitToolKinds,
  isHttpTool,
  httpToolInfo,
} from "./workspace-tool"

test("HTTP V1/V2 reuse safe bounded cards and structured errors", () => {
  expect(isHttpTool("http.request")).toBe(true)
  expect(isHttpTool("http_request")).toBe(true)
  expect(isHttpTool("plugin.http")).toBe(false)
  const input = { method: "POST", url: "https://user:password@example.test/api/items?token=secret" }
  const metadata = { status: 201, durationMs: 142 }
  expect(httpToolInfo(input, metadata)).toEqual({ title: "HTTP POST /api/items", subtitle: "201 · 142 ms" })
  expect(httpToolInfo({ url: "invalid secret" }, {}, '{"ok":false,"errorCode":"TIMEOUT"}')).toEqual({
    title: "HTTP GET",
    subtitle: "TIMEOUT",
  })
  expect(httpToolInfo(input, {}, JSON.stringify(metadata))).toEqual(httpToolInfo(input, metadata))
  expect(workspaceToolStatus("completed", '{"ok":false,"errorCode":"PERMISSION_DENIED"}')).toBe("error")
  expect(httpToolInfo({ url: `https://example.test/${"x".repeat(4096)}` }, {}).title.length).toBeLessThan(280)
})

test("managed V1 and V2 tools reuse native localized actions", () => {
  for (const [kind, action] of [
    ["list", "list"],
    ["read", "read"],
    ["glob", "glob"],
    ["search", "grep"],
    ["write", "write"],
    ["edit", "edit"],
  ]) {
    expect(workspaceToolAction(`fs.${kind}`)).toBe(action)
    expect(workspaceToolAction(`fs_${kind}`)).toBe(action)
  }
  expect(workspaceToolAction("bash")).toBeUndefined()
  expect(workspaceToolAction("plugin.file")).toBeUndefined()
  for (const name of [
    "shell.exec",
    "shell_exec",
    "test.run",
    "test_run",
    "process.start",
    "process_start",
    "process.status",
    "process_status",
    "process.stop",
    "process_stop",
  ])
    expect(workspaceToolAction(name)).toBe("bash")
})
test("structured workspace errors appear as errors while pending/running/success remain unchanged", () => {
  expect(workspaceToolStatus("completed", '{"ok":false,"code":"PERMISSION_DENIED"}')).toBe("error")
  expect(workspaceToolStatus("completed", undefined, "FILE_CHANGED_SINCE_READ")).toBe("error")
  expect(workspaceToolStatus("completed", '{"ok":true,"operation":"edit"}')).toBe("completed")
  expect(workspaceToolStatus("completed", "ordinary text")).toBe("completed")
  expect(workspaceToolStatus("pending")).toBe("pending")
  expect(workspaceToolStatus("running")).toBe("running")
})
test("Git V1/V2 cards share operation identity and errors", () => {
  for (const kind of gitToolKinds)
    for (const name of [`git.${kind}`, `git_${kind.replaceAll(".", "_")}`]) {
      expect(gitToolKind(name)).toBe(kind)
      expect(workspaceToolAction(name)).toBe("git")
    }
  expect(gitToolKind("plugin.git")).toBeUndefined()
  expect(workspaceToolStatus("completed", '{"ok":false,"code":"STALE_DIFF_REVIEW"}')).toBe("error")
})
