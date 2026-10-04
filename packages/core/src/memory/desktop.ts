export type MemoryDesktopSettings = {
  enabled: boolean
  injection: boolean
  autoStart: boolean
  port: number
  model: string
  retrievalTokens: number
  embeddings: boolean
  embeddingModel: string
}

export type MemoryServiceState =
  | "stopped"
  | "starting"
  | "running"
  | "restarting"
  | "degraded"
  | "failed"
  | "external"
  | "stopping"

export type MemoryServiceSnapshot = {
  settings: MemoryDesktopSettings
  state: MemoryServiceState
  reason?: string
  dataDirectory: string
  ollama: { connected: boolean; models: string[] }
}

export type MemoryServiceAction =
  | { kind: "get" | "start" | "stop" | "restart" | "checkOllama" }
  | { kind: "update"; settings: MemoryDesktopSettings }
  | { kind: "diagnostics" | "backups" | "backup" | "supportBundle" | "importDatabase" }
  | { kind: "restoreDryRun" | "restore"; backupId: string; confirm?: true }

export const defaultMemoryDesktopSettings: MemoryDesktopSettings = {
  enabled: false,
  injection: true,
  autoStart: true,
  port: 11435,
  model: "qwen3:8b",
  retrievalTokens: 1500,
  embeddings: false,
  embeddingModel: "",
}

function validModelName(value: unknown): value is string {
  return (
    typeof value === "string" &&
    value.length <= 256 &&
    /^[\w.:-]+(?:\/[\w.:-]+)*$/u.test(value) &&
    value.split("/").every((segment) => segment !== "." && segment !== "..")
  )
}

export function parseMemoryDesktopSettings(value: unknown): MemoryDesktopSettings {
  if (!value || typeof value !== "object" || Array.isArray(value)) throw new Error("invalid_settings")
  const input = value as Record<string, unknown>
  const settings = {
    enabled: input.enabled === undefined ? defaultMemoryDesktopSettings.enabled : input.enabled,
    injection: input.injection === undefined ? defaultMemoryDesktopSettings.injection : input.injection,
    autoStart: input.autoStart === undefined ? defaultMemoryDesktopSettings.autoStart : input.autoStart,
    port: input.port === undefined ? defaultMemoryDesktopSettings.port : input.port,
    model: input.model === undefined ? defaultMemoryDesktopSettings.model : input.model,
    retrievalTokens:
      input.retrievalTokens === undefined ? defaultMemoryDesktopSettings.retrievalTokens : input.retrievalTokens,
    embeddings: input.embeddings === undefined ? defaultMemoryDesktopSettings.embeddings : input.embeddings,
    embeddingModel:
      input.embeddingModel === undefined ? defaultMemoryDesktopSettings.embeddingModel : input.embeddingModel,
  }
  if (
    [settings.enabled, settings.injection, settings.autoStart, settings.embeddings].some(
      (item) => typeof item !== "boolean",
    )
  )
    throw new Error("invalid_boolean")
  if (
    typeof settings.port !== "number" ||
    !Number.isInteger(settings.port) ||
    settings.port < 1024 ||
    settings.port > 65535
  )
    throw new Error("invalid_port")
  if (
    typeof settings.retrievalTokens !== "number" ||
    !Number.isInteger(settings.retrievalTokens) ||
    settings.retrievalTokens < 100 ||
    settings.retrievalTokens > 8000
  )
    throw new Error("invalid_retrieval_tokens")
  if (!validModelName(settings.model)) throw new Error("invalid_model")
  if (settings.embeddingModel !== "" && !validModelName(settings.embeddingModel))
    throw new Error("invalid_embedding_model")
  if (settings.embeddings && !settings.embeddingModel) throw new Error("embedding_model_required")
  return settings as MemoryDesktopSettings
}
