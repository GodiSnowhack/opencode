// Presentation aliases only; execution stays in the canonical runtime registries.
const actions: Record<string, string> = {
  "shell.exec": "bash",
  shell_exec: "bash",
  "test.run": "bash",
  test_run: "bash",
  "process.start": "bash",
  process_start: "bash",
  "process.status": "bash",
  process_status: "bash",
  "process.stop": "bash",
  process_stop: "bash",
  "project.info": "list",
  project_info: "list",
  "fs.list": "list",
  fs_list: "list",
  "fs.read": "read",
  fs_read: "read",
  "fs.glob": "glob",
  fs_glob: "glob",
  "fs.search": "grep",
  fs_search: "grep",
  "fs.write": "write",
  fs_write: "write",
  "fs.edit": "edit",
  fs_edit: "edit",
}
export const gitToolKinds = [
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
]
for (const kind of gitToolKinds) {
  actions[`git.${kind}`] = "git"
  actions[`git_${kind.replaceAll(".", "_")}`] = "git"
}
export const gitToolKind = (name: string) =>
  gitToolKinds.find((kind) => name === `git.${kind}` || name === `git_${kind.replaceAll(".", "_")}`)
export const workspaceToolAction = (name: string) => actions[name]

export const isHttpTool = (name: string) => name === "http.request" || name === "http_request"
export function httpToolInfo(input: Record<string, unknown>, metadata: Record<string, unknown>, output?: string) {
  let result = metadata
  try {
    const parsed: unknown = JSON.parse(output ?? "")
    if (parsed && typeof parsed === "object" && !Array.isArray(parsed)) result = { ...parsed, ...metadata }
  } catch {
    /* Pending calls have no JSON result. */
  }
  let path = ""
  try {
    path = new URL(String(input.url)).pathname.slice(0, 256)
  } catch {
    /* Invalid URL is displayed by the structured result, without reflecting raw input. */
  }
  const method = ["GET", "HEAD", "POST", "PUT", "PATCH", "DELETE"].includes(String(input.method))
    ? String(input.method)
    : "GET"
  const status = typeof result.status === "number" ? String(result.status) : ""
  const error = typeof result.errorCode === "string" && /^[A-Z_]+$/u.test(result.errorCode) ? result.errorCode : ""
  const duration = typeof result.durationMs === "number" ? `${Math.round(result.durationMs)} ms` : ""
  return { title: `HTTP ${method} ${path}`.trim(), subtitle: [status, error, duration].filter(Boolean).join(" · ") }
}

export function workspaceToolStatus(status?: string, output?: string, errorCode?: unknown) {
  if (status !== "completed") return status
  if (typeof errorCode === "string") return "error"
  try {
    const result: unknown = JSON.parse(output ?? "")
    if (result && typeof result === "object" && "ok" in result && result.ok === false) return "error"
  } catch {
    /* Ordinary text remains a successful result. */
  }
  return status
}
