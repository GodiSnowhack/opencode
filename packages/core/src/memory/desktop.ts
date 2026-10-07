export type MemoryDesktopSettings = {
  enabled: boolean
  injection: boolean
  autoStart: boolean
  port: number
  model: string
  contextLength: number
  retrievalTokens: number
  embeddings: boolean
  embeddingModel: string
  agentTools: boolean
  maxToolCalls: number
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
  ollama: {
    connected: boolean
    models: string[]
    chatModels?: {
      id: string
      name: string
      context?: number
      tools: boolean
      thinking: boolean
      vision: boolean
    }[]
    effectiveContextLength?: number
    modelContextLength?: number
  }
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
  contextLength: 32768,
  retrievalTokens: 1500,
  embeddings: false,
  embeddingModel: "",
  agentTools: true,
  maxToolCalls: 12,
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
    contextLength: input.contextLength === undefined ? defaultMemoryDesktopSettings.contextLength : input.contextLength,
    retrievalTokens:
      input.retrievalTokens === undefined ? defaultMemoryDesktopSettings.retrievalTokens : input.retrievalTokens,
    embeddings: input.embeddings === undefined ? defaultMemoryDesktopSettings.embeddings : input.embeddings,
    embeddingModel:
      input.embeddingModel === undefined ? defaultMemoryDesktopSettings.embeddingModel : input.embeddingModel,
    agentTools: input.agentTools === undefined ? defaultMemoryDesktopSettings.agentTools : input.agentTools,
    maxToolCalls: input.maxToolCalls === undefined ? defaultMemoryDesktopSettings.maxToolCalls : input.maxToolCalls,
  }
  if (
    [settings.enabled, settings.injection, settings.autoStart, settings.embeddings, settings.agentTools].some(
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
  if (
    typeof settings.contextLength !== "number" ||
    !Number.isInteger(settings.contextLength) ||
    settings.contextLength < 4096 ||
    settings.contextLength > 262144
  )
    throw new Error("invalid_context_length")
  if (
    typeof settings.maxToolCalls !== "number" ||
    !Number.isInteger(settings.maxToolCalls) ||
    settings.maxToolCalls < 1 ||
    settings.maxToolCalls > 24
  )
    throw new Error("invalid_max_tool_calls")
  if (settings.embeddingModel !== "" && !validModelName(settings.embeddingModel))
    throw new Error("invalid_embedding_model")
  if (settings.embeddings && !settings.embeddingModel) throw new Error("embedding_model_required")
  return settings as MemoryDesktopSettings
}
