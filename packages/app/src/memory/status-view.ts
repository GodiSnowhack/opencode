import type { MemoryStatusSnapshot } from "@opencode-ai/core/memory/status"

export function memoryStatusEnabled(memory?: { enabled: () => boolean }): boolean {
  return memory?.enabled() === true
}

export function toggleMemoryPanel(memory?: { enabled: () => boolean; panel: { toggle(): void } }) {
  if (!memory || !memoryStatusEnabled(memory)) return
  memory.panel.toggle()
}

export function openMemoryManager(memory?: { enabled: () => boolean; manager: { open(): void } }, close?: () => void) {
  if (!memory || !memoryStatusEnabled(memory)) return
  close?.()
  memory.manager.open()
}

export type StatusLabelKey =
  | "memory.status.ready"
  | "memory.status.analyzing"
  | "memory.status.working"
  | "memory.status.taxonomy"
  | "memory.status.consolidating"
  | "memory.status.queued"
  | "memory.status.degraded"
  | "memory.status.error"
  | "memory.status.offline"

export function statusView(snapshot: MemoryStatusSnapshot, now: number) {
  const status = snapshot.status
  if (!snapshot.connected || !status)
    return { key: "memory.status.offline" as StatusLabelKey, active: false, elapsed: "", queue: 0 }
  const phase = status.phase
  const active = phase !== "IDLE" && phase !== "DEGRADED" && phase !== "ERROR" && phase !== "MEMORY_QUEUED"
  const queue = Math.max(0, status.queueLength, status.queuedUserRequests)
  let key: StatusLabelKey
  if (status.error !== null || phase === "ERROR" || status.state === "ERROR") key = "memory.status.error"
  else if (status.degradedReasons.length || phase === "DEGRADED" || status.state === "DEGRADED")
    key = "memory.status.degraded"
  else if (phase === "TAXONOMY_RUNNING") key = "memory.status.taxonomy"
  else if (phase === "CONSOLIDATION_RUNNING") key = "memory.status.consolidating"
  else if (phase.startsWith("MEMORY_") && phase !== "MEMORY_QUEUED") key = "memory.status.analyzing"
  else if (queue > 0 || phase === "MEMORY_QUEUED" || status.state === "USER_QUEUED") key = "memory.status.queued"
  else if (phase === "IDLE") key = "memory.status.ready"
  else key = "memory.status.working"

  const started = status.startedAt ? Date.parse(status.startedAt) : Number.NaN
  const elapsedMs = Number.isFinite(started)
    ? Math.max(0, now - started)
    : Math.max(0, status.elapsedMs + now - snapshot.receivedAt)
  const seconds = Math.floor(elapsedMs / 1_000)
  const elapsed = active ? (seconds < 60 ? `${seconds}s` : `${Math.floor(seconds / 60)}m ${seconds % 60}s`) : ""
  return { key, active, elapsed, queue }
}
