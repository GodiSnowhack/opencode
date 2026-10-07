import { randomUUID } from "node:crypto"
import { spawn, type ChildProcess } from "node:child_process"
import { existsSync, mkdirSync, renameSync, rmSync } from "node:fs"
import { join } from "node:path"
import { connect } from "node:net"
import type { MemoryDesktopSettings, MemoryServiceSnapshot } from "@opencode-ai/core/memory/desktop"
import { defaultMemoryDesktopSettings, parseMemoryDesktopSettings } from "@opencode-ai/core/memory/desktop"
import { OllamaModelInventory, type OllamaChatModel } from "./ollama-models"

export async function applyAgentToolSettings(
  before: MemoryDesktopSettings,
  after: MemoryDesktopSettings,
  apply: () => Promise<void>,
) {
  if (
    before.agentTools !== after.agentTools ||
    before.maxToolCalls !== after.maxToolCalls ||
    before.contextLength !== after.contextLength
  )
    await apply()
}

type SettingsStore = { get(key: string): unknown; set(key: string, value: unknown): void }

export function memoryGatewayResources(packaged: boolean, appPath: string, resourcesPath: string) {
  return packaged ? resourcesPath : join(appPath, "resources")
}

export function memoryDevRelaunchArgs(appPath: string, argv: string[]) {
  return [appPath, ...argv.slice(2)]
}

export function memoryGatewayDirectory(resourcesPath: string) {
  return join(resourcesPath, "memory-gateway")
}

export function managedMemoryProvider(
  content: string | undefined,
  models: string | readonly OllamaChatModel[],
  port: number,
  contextLength = 32768,
) {
  const original = content ? (JSON.parse(content) as Record<string, unknown>) : {}
  if (!original || typeof original !== "object" || Array.isArray(original)) throw new Error("invalid_provider_config")
  const providers = original.provider
  if (providers !== undefined && (!providers || typeof providers !== "object" || Array.isArray(providers)))
    throw new Error("invalid_provider_config")
  const configured = (providers ?? {}) as Record<string, unknown>
  if (configured["memory-local"] !== undefined) throw new Error("managed_provider_conflict")
  const inventory =
    typeof models === "string" ? [{ id: models, name: models, tools: true, thinking: false, vision: false }] : models
  return JSON.stringify({
    ...original,
    provider: {
      ...configured,
      "memory-local": {
        name: "Memory Local (managed)",
        npm: "@ai-sdk/openai-compatible",
        env: [],
        models: Object.fromEntries(
          inventory.map((model) => [
            model.id,
            {
              name: model.name,
              tool_call: model.tools,
              reasoning: model.thinking,
              modalities: { input: model.vision ? ["text", "image"] : ["text"], output: ["text"] },
              limit: { context: Math.min(contextLength, model.context ?? contextLength), output: 8192 },
            },
          ]),
        ),
        options: { apiKey: "local", baseURL: `http://127.0.0.1:${port}/v1` },
      },
    },
  })
}

export function managedProviderContext(input: unknown, model: string): number | undefined {
  if (!input || typeof input !== "object" || !("all" in input) || !Array.isArray(input.all)) return
  const provider = input.all.find(
    (item: unknown) => item && typeof item === "object" && "id" in item && item.id === "memory-local",
  )
  if (
    !provider ||
    typeof provider !== "object" ||
    !("models" in provider) ||
    !provider.models ||
    typeof provider.models !== "object"
  )
    return
  if (Array.isArray(provider.models)) return
  const selected = Object.entries(provider.models).find(([key]) => key === model)?.[1]
  if (
    !selected ||
    typeof selected !== "object" ||
    !("limit" in selected) ||
    !selected.limit ||
    typeof selected.limit !== "object" ||
    !("context" in selected.limit)
  )
    return
  if (typeof selected.limit.context === "number") return selected.limit.context
  return undefined
}

export function managedProviderModels(input: unknown): Record<string, number> | undefined {
  if (!input || typeof input !== "object" || !("all" in input) || !Array.isArray(input.all)) return
  const provider = input.all.find(
    (item: unknown) => item && typeof item === "object" && "id" in item && item.id === "memory-local",
  )
  if (!provider) return {}
  if (
    typeof provider !== "object" ||
    !("models" in provider) ||
    !provider.models ||
    typeof provider.models !== "object" ||
    Array.isArray(provider.models)
  )
    return
  return Object.fromEntries(
    Object.keys(provider.models).flatMap((id) => {
      const context = managedProviderContext(input, id)
      return context === undefined ? [] : [[id, context]]
    }),
  )
}

export function memoryWorkerModelEnv(settings: MemoryDesktopSettings) {
  return {
    MEMORY_LLM_MODEL: settings.model,
    MEMORY_CHAT_CONTEXT_LENGTH: String(settings.contextLength),
  }
}

export class MemoryService {
  private settings: MemoryDesktopSettings
  private state: MemoryServiceSnapshot["state"] = "stopped"
  private reason: string | undefined
  private child: ChildProcess | undefined
  private shutdownToken: string | undefined
  private stopping = false
  private retries = 0
  private retryTimer: ReturnType<typeof setTimeout> | undefined
  private readonly listeners = new Set<(snapshot: MemoryServiceSnapshot) => void>()
  private ollama: MemoryServiceSnapshot["ollama"] = { connected: false, models: [] }
  private readonly inventory = new OllamaModelInventory()

  constructor(
    private readonly options: {
      store: SettingsStore
      userData: string
      resources: string
      executable: string
      request?: typeof fetch
      onStderr?: (line: string) => void
    },
  ) {
    try {
      this.settings = parseMemoryDesktopSettings(options.store.get("settings") ?? defaultMemoryDesktopSettings)
    } catch {
      this.settings = defaultMemoryDesktopSettings
    }
  }

  get snapshot(): MemoryServiceSnapshot {
    return {
      settings: this.settings,
      state: this.state,
      reason: this.reason,
      dataDirectory: join(this.options.userData, "Memory"),
      ollama: this.ollama,
    }
  }

  subscribe(listener: (snapshot: MemoryServiceSnapshot) => void) {
    this.listeners.add(listener)
    listener(this.snapshot)
    return () => this.listeners.delete(listener)
  }

  private publish(state: MemoryServiceSnapshot["state"], reason?: string) {
    this.state = state
    this.reason = reason
    for (const listener of this.listeners) listener(this.snapshot)
  }

  async detectOllama() {
    try {
      const discovered = await this.inventory.refresh(this.options.request ?? fetch)
      const running = await (this.options.request ?? fetch)("http://127.0.0.1:11434/api/ps", {
        signal: AbortSignal.timeout(3000),
        redirect: "error",
        cache: "no-store",
      })
        .then((result) =>
          result.ok ? (result.json() as Promise<{ models?: { name?: string; context_length?: number }[] }>) : undefined,
        )
        .catch(() => undefined)
      const effective = running?.models?.find((item) => item.name === this.settings.model)?.context_length
      this.ollama = {
        connected: true,
        models: discovered.names,
        chatModels: discovered.chatModels,
        effectiveContextLength:
          typeof effective === "number" && Number.isInteger(effective) && effective > 0 ? effective : undefined,
        modelContextLength: discovered.chatModels.find((item) => item.id === this.settings.model)?.context,
      }
    } catch {
      this.ollama = { ...this.ollama, connected: false, chatModels: this.inventory.chatModels }
    }
    const memoryModelMissing =
      this.ollama.connected && !this.inventory.chatModels.some((model) => model.id === this.settings.model)
    if (this.child && memoryModelMissing) this.publish("degraded", "memory_model_not_installed")
    else if (
      this.child &&
      this.state === "degraded" &&
      (this.reason === "ollama_unavailable" || this.reason === "memory_model_not_installed") &&
      this.ollama.connected
    )
      this.publish("running")
    else if (this.child && this.state === "running" && !this.ollama.connected)
      this.publish("degraded", "ollama_unavailable")
    else this.publish(this.state, this.reason)
    return this.ollama
  }

  async update(value: unknown) {
    const next = parseMemoryDesktopSettings(value)
    if (this.state === "external" && next.contextLength !== this.settings.contextLength)
      throw new Error("managed_context_requires_owned_gateway")
    if (this.ollama.connected && !this.inventory.chatModels.some((model) => model.id === next.model))
      throw new Error("model_not_installed")
    if (this.ollama.connected && next.embeddings && !this.ollama.models.includes(next.embeddingModel))
      throw new Error("embedding_model_not_installed")
    const previous = this.settings
    const previousOllama = this.ollama
    this.settings = next
    if (previous.model !== next.model)
      this.ollama = {
        ...this.ollama,
        modelContextLength: this.inventory.chatModels.find((item) => item.id === next.model)?.context,
      }
    if (previous.model !== next.model || previous.contextLength !== next.contextLength)
      this.ollama = { ...this.ollama, effectiveContextLength: undefined }
    this.options.store.set("settings", next)
    this.publish(this.state, this.reason)
    try {
      await this.stop()
      if (next.enabled && next.autoStart) {
        await this.start()
        if (next.contextLength !== previous.contextLength && this.state === "external")
          throw new Error("managed_context_requires_owned_gateway")
        if (this.state === "failed") throw new Error(this.reason ?? "gateway_start_failed")
      }
    } catch (error) {
      this.settings = previous
      this.ollama = previousOllama
      this.options.store.set("settings", previous)
      await this.stop()
      if (previous.enabled && previous.autoStart) await this.start().catch(() => undefined)
      throw error
    }
    return this.snapshot
  }

  private get origin() {
    return `http://127.0.0.1:${this.settings.port}`
  }

  private async health() {
    try {
      const response = await (this.options.request ?? fetch)(`${this.origin}/health`, {
        signal: AbortSignal.timeout(1500),
        redirect: "error",
        cache: "no-store",
      })
      const data = (await response.json()) as { status?: string; apiVersion?: number; gatewayVersion?: string }
      return response.ok && data.status === "ok" && data.apiVersion === 1 && typeof data.gatewayVersion === "string"
        ? ("compatible" as const)
        : ("incompatible" as const)
    } catch {
      return "absent" as const
    }
  }

  async start() {
    if (!this.settings.enabled) return this.snapshot
    if (this.child) return this.snapshot
    this.stopping = false
    this.publish("starting")
    const found = await this.health()
    if (found === "compatible") {
      this.publish("external")
      return this.snapshot
    }
    if (found === "incompatible") {
      this.publish("failed", "port_occupied_or_incompatible")
      return this.snapshot
    }
    const occupied = await new Promise<boolean>((resolve) => {
      const socket = connect(this.settings.port, "127.0.0.1")
      socket.setTimeout(1000)
      socket.once("connect", () => {
        socket.destroy()
        resolve(true)
      })
      socket.once("error", () => {
        socket.destroy()
        resolve(false)
      })
      socket.once("timeout", () => {
        socket.destroy()
        resolve(true)
      })
    })
    if (occupied) {
      this.publish("failed", "port_occupied_or_incompatible")
      return this.snapshot
    }
    const directory = memoryGatewayDirectory(this.options.resources)
    if (!existsSync(join(directory, "gateway.mjs"))) {
      this.publish("failed", "gateway_not_bundled")
      return this.snapshot
    }
    mkdirSync(join(this.snapshot.dataDirectory, "backups"), { recursive: true })
    mkdirSync(join(this.snapshot.dataDirectory, "logs"), { recursive: true })
    mkdirSync(join(this.snapshot.dataDirectory, "support"), { recursive: true })
    this.shutdownToken = randomUUID()
    const child = spawn(this.options.executable, [join(directory, "gateway.mjs")], {
      cwd: directory,
      windowsHide: true,
      stdio: ["ignore", "ignore", "pipe"],
      env: {
        ...process.env,
        ELECTRON_RUN_AS_NODE: "1",
        MEMORY_DESKTOP_MANAGED: "true",
        MEMORY_HOST: "127.0.0.1",
        MEMORY_PORT: String(this.settings.port),
        MEMORY_DATABASE_PATH: join(this.snapshot.dataDirectory, "memory.db"),
        MEMORY_BACKUP_DIRECTORY: join(this.snapshot.dataDirectory, "backups"),
        MEMORY_LOG_PATH: join(this.snapshot.dataDirectory, "logs", "memory.jsonl"),
        MEMORY_SUPPORT_DIRECTORY: join(this.snapshot.dataDirectory, "support"),
        ...memoryWorkerModelEnv(this.settings),
        MEMORY_ENABLED: "true",
        MEMORY_INJECTION_ENABLED: String(this.settings.injection),
        MEMORY_MAX_RETRIEVAL_TOKENS: String(this.settings.retrievalTokens),
        MEMORY_ENABLE_EMBEDDINGS: String(this.settings.embeddings),
        MEMORY_EMBEDDING_MODEL: this.settings.embeddingModel,
        OLLAMA_BASE_URL: "http://127.0.0.1:11434",
        MEMORY_SHUTDOWN_TOKEN: this.shutdownToken,
      },
    })
    this.child = child
    if (this.options.onStderr) child.stderr?.on("data", (chunk: Buffer) => this.options.onStderr?.(chunk.toString()))
    child.once("error", () => this.handleExit(child))
    child.once("exit", () => this.handleExit(child))
    for (let attempt = 0; attempt < 30 && this.child === child; attempt++) {
      await new Promise((resolve) => setTimeout(resolve, 250))
      if ((await this.health()) === "compatible") {
        this.retries = 0
        this.publish(
          this.ollama.connected ? "running" : "degraded",
          this.ollama.connected ? undefined : "ollama_unavailable",
        )
        return this.snapshot
      }
    }
    if (this.child === child) {
      await this.stop()
      this.publish("failed", "gateway_start_timeout")
    }
    return this.snapshot
  }

  private handleExit(child: ChildProcess) {
    if (this.child !== child) return
    this.child = undefined
    if (this.stopping || !this.settings.enabled) return
    if (this.retries >= 3) {
      this.publish("failed", "gateway_crashed")
      return
    }
    this.publish("restarting", "gateway_crashed")
    this.retryTimer = setTimeout(() => {
      this.retryTimer = undefined
      this.retries++
      void this.start()
    }, [1000, 2000, 5000][this.retries])
  }

  async stop() {
    this.stopping = true
    if (this.retryTimer) clearTimeout(this.retryTimer)
    this.retryTimer = undefined
    const child = this.child
    if (!child) {
      this.publish("stopped")
      return
    }
    this.publish("stopping")
    await (this.options.request ?? fetch)(`${this.origin}/memory/desktop/shutdown`, {
      method: "POST",
      headers: { "x-memory-shutdown-token": this.shutdownToken ?? "" },
      signal: AbortSignal.timeout(2000),
      redirect: "error",
    }).catch(() => undefined)
    await Promise.race([
      new Promise<void>((resolve) => child.once("exit", () => resolve())),
      new Promise<void>((resolve) => setTimeout(resolve, 5000)),
    ])
    if (this.child === child) child.kill()
    this.child = undefined
    this.shutdownToken = undefined
    this.publish("stopped")
  }

  async restart() {
    if (this.state === "external") return this.snapshot
    this.retries = 0
    await this.stop()
    return this.start()
  }

  async maintenance(
    kind: "diagnostics" | "backups" | "backup" | "supportBundle" | "restoreDryRun" | "restore",
    backupId?: string,
    confirm?: true,
  ): Promise<unknown> {
    const endpoints = {
      diagnostics: ["GET", "/memory/diagnostics"],
      backups: ["GET", "/memory/maintenance/backups"],
      backup: ["POST", "/memory/maintenance/backup"],
      supportBundle: ["POST", "/memory/maintenance/support-bundle"],
      restoreDryRun: ["POST", "/memory/maintenance/restore/dry-run"],
      restore: ["POST", "/memory/maintenance/restore"],
    } as const
    if (kind === "restore" || kind === "restoreDryRun") {
      if (
        !backupId ||
        !/^(daily|weekly|safety):memory-\d{4}-\d{2}-\d{2}T\d{2}-\d{2}-\d{2}-\d{3}Z-[a-f0-9-]{36}\.db$/u.test(backupId)
      )
        throw new Error("invalid_backup_id")
      if (kind === "restore" && confirm !== true) throw new Error("confirmation_required")
    }
    const [method, path] = endpoints[kind]
    const body =
      kind === "restore"
        ? { backupId, confirm: true }
        : kind === "restoreDryRun"
          ? { backupId }
          : kind === "backup"
            ? { kind: "daily" }
            : undefined
    const response = await (this.options.request ?? fetch)(`${this.origin}${path}`, {
      method,
      signal: AbortSignal.timeout(30_000),
      redirect: "error",
      headers: { accept: "application/json", ...(body ? { "content-type": "application/json" } : {}) },
      ...(body ? { body: JSON.stringify(body) } : {}),
    })
    if (!response.ok) throw new Error("maintenance_failed")
    const result = await response.json()
    if (kind !== "supportBundle") return result
    if (
      !result ||
      typeof result !== "object" ||
      typeof result.id !== "string" ||
      !/^support-[a-zA-Z0-9-]+\.json$/u.test(result.id)
    )
      throw new Error("invalid_support_bundle")
    return { ...result, path: join(this.snapshot.dataDirectory, "support", result.id) }
  }

  async importDatabase(source: string) {
    const { backup, DatabaseSync } = await import("node:sqlite")
    if (this.child || this.state === "external") throw new Error("stop_gateway_before_import")
    const destination = join(this.snapshot.dataDirectory, "memory.db")
    if (existsSync(destination)) throw new Error("database_already_exists")
    if (!source.toLowerCase().endsWith(".db") || !existsSync(source)) throw new Error("invalid_database")
    mkdirSync(this.snapshot.dataDirectory, { recursive: true })
    const temporary = join(this.snapshot.dataDirectory, `import-${randomUUID()}.db`)
    const database = new DatabaseSync(source, { readOnly: true })
    try {
      if (database.prepare("PRAGMA quick_check").get()?.quick_check !== "ok") throw new Error("invalid_database")
      const tables = new Set(
        database
          .prepare("SELECT name FROM sqlite_master WHERE type='table'")
          .all()
          .map((row) => String(row.name)),
      )
      for (const name of ["schema_migrations", "projects", "sessions", "messages", "memories", "memory_sources"])
        if (!tables.has(name)) throw new Error("invalid_database")
      await backup(database, temporary)
      const copied = new DatabaseSync(temporary, { readOnly: true })
      try {
        if (copied.prepare("PRAGMA quick_check").get()?.quick_check !== "ok")
          throw new Error("import_verification_failed")
      } finally {
        copied.close()
      }
      if (existsSync(destination)) throw new Error("database_already_exists")
      renameSync(temporary, destination)
      return this.snapshot
    } finally {
      database.close()
      rmSync(temporary, { force: true })
    }
  }
}
