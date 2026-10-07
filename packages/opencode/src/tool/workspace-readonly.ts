import path from "node:path"
import { realpath } from "node:fs/promises"

export type WorkspacePathErrorCode = "NOT_ALLOWED" | "NOT_FOUND"

export class WorkspacePathError extends Error {
  constructor(readonly code: WorkspacePathErrorCode) {
    super(code)
    this.name = "WorkspacePathError"
  }
}

// The model supplies only a relative name. Both the trusted root and target are
// canonicalized before the native OpenCode reader sees the path.
export async function workspacePath(root: string, relative: string) {
  if (
    !relative ||
    relative.includes("\0") ||
    relative.includes(":") ||
    path.posix.isAbsolute(relative) ||
    path.win32.isAbsolute(relative) ||
    relative.startsWith("\\\\") ||
    relative.split(/[\\/]+/u).includes("..")
  )
    throw new WorkspacePathError("NOT_ALLOWED")
  const workspace = await realpath(root)
  const target = path.resolve(workspace, ...relative.split(/[\\/]+/u))
  let canonical: string
  try {
    canonical = await realpath(target)
  } catch {
    throw new WorkspacePathError("NOT_FOUND")
  }
  const inside = path.relative(workspace, canonical)
  if (inside === ".." || inside.startsWith(`..${path.sep}`) || path.isAbsolute(inside))
    throw new WorkspacePathError("NOT_ALLOWED")
  return canonical
}

export { ProjectInfoTool, WorkspaceListTool, WorkspaceReadTool } from "./workspace-tools"
