import type { MemoryStatusSnapshot } from "@opencode-ai/core/memory/status"
import { statusView } from "./status-view"

export type MemoryPanelIdentity = {
  sessionID?: string
  project?: { id: string; name?: string; worktree?: string }
  directory?: string
  effectiveProjectID?: string
}

export function nextMemoryPanelOpen(current: boolean, action: "open" | "close" | "toggle") {
  if (action === "open") return true
  if (action === "close") return false
  return !current
}

export function shortMemoryID(value: string | null | undefined) {
  if (!value) return ""
  return value.length <= 12 ? value : `${value.slice(0, 8)}…${value.slice(-4)}`
}

export function safeProjectLabel(identity: MemoryPanelIdentity) {
  const value =
    identity.project?.id === "global"
      ? (identity.directory ?? identity.project?.name)
      : (identity.project?.name ?? identity.project?.worktree ?? identity.directory)
  if (value)
    return (
      value
        .split(/[\\/]+/)
        .filter(Boolean)
        .at(-1) ?? ""
    )
  return identity.project?.id === "global" ? "" : shortMemoryID(identity.project?.id)
}

export function memoryPanelView(snapshot: MemoryStatusSnapshot, now: number, identity: MemoryPanelIdentity) {
  const status = snapshot.status
  const view = statusView(snapshot, now)
  return {
    connected: snapshot.connected,
    statusKey: view.key,
    phase: status?.phase ?? "—",
    elapsed: view.elapsed,
    jobID: shortMemoryID(status?.jobId),
    queueLength: Math.max(0, status?.queueLength ?? 0),
    queuedUserRequests: Math.max(0, status?.queuedUserRequests ?? 0),
    processedItems: Math.max(0, status?.processedItems ?? 0),
    degradedReasons: status?.degradedReasons ?? [],
    error: status?.error?.split(/\r?\n/, 1)[0]?.slice(0, 300) ?? "",
    receivedAt: snapshot.receivedAt,
    projectLabel: safeProjectLabel(identity),
    projectID: identity.effectiveProjectID ?? "",
    sessionID: shortMemoryID(identity.sessionID),
  }
}
