import { expect, test } from "bun:test"
import { workspaceToolAction, workspaceToolStatus } from "./workspace-tool"

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
