// Presentation aliases only; execution stays in the canonical runtime registries.
const actions: Record<string, string> = {
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
export const workspaceToolAction = (name: string) => actions[name]

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
