import { For, Show, createResource, createSignal, onCleanup, onMount, type Component } from "solid-js"
import type { MemoryDesktopSettings, MemoryServiceSnapshot } from "@opencode-ai/core/memory/desktop"
import { Switch } from "@opencode-ai/ui/v2/switch-v2"
import { useLanguage } from "@/context/language"
import { usePlatform } from "@/context/platform"
import { SettingsListV2 } from "./parts/list"
import { SettingsRowV2 } from "./parts/row"
import "./settings-v2.css"

type Backup = { id: string; createdAt: string; sizeBytes: number; schemaVersion: string; verified: boolean }
type Diagnostics = {
  ok: boolean
  database?: { integrity?: string }
  profiles?: { stale?: number }
  issues?: { code: string; severity: string }[]
}

const stateKeys = {
  stopped: "memory.settings.state.stopped",
  starting: "memory.settings.state.starting",
  running: "memory.settings.state.running",
  restarting: "memory.settings.state.restarting",
  degraded: "memory.settings.state.degraded",
  failed: "memory.settings.state.failed",
  external: "memory.settings.state.external",
  stopping: "memory.settings.state.stopping",
} as const

const reasonKeys = {
  ollama_unavailable: "memory.settings.reason.ollama",
  port_occupied_or_incompatible: "memory.settings.reason.port",
  gateway_not_bundled: "memory.settings.reason.bundle",
  gateway_crashed: "memory.settings.reason.crash",
  gateway_start_timeout: "memory.settings.reason.timeout",
} as const

export const SettingsMemoryV2: Component = () => {
  const language = useLanguage()
  const platform = usePlatform()
  const [snapshot, { mutate, refetch }] = createResource(
    async () => platform.memoryService?.({ kind: "get" }) as Promise<MemoryServiceSnapshot | undefined>,
  )
  const [busy, setBusy] = createSignal(false)
  const [error, setError] = createSignal("")
  const [advanced, setAdvanced] = createSignal(false)
  const [backups, setBackups] = createSignal<Backup[]>([])
  const [diagnostics, setDiagnostics] = createSignal<Diagnostics>()
  const [bundle, setBundle] = createSignal("")
  let stop: (() => void) | undefined
  let disposed = false
  onMount(() => {
    void platform
      .memoryServiceSubscribe?.((next) => mutate(next))
      .then((unsubscribe) => {
        if (disposed) unsubscribe()
        else stop = unsubscribe
      })
  })
  onCleanup(() => {
    disposed = true
    stop?.()
  })

  const action = async (
    kind:
      | "start"
      | "stop"
      | "restart"
      | "checkOllama"
      | "backup"
      | "backups"
      | "diagnostics"
      | "supportBundle"
      | "importDatabase",
  ) => {
    if (!platform.memoryService) return
    setBusy(true)
    setError("")
    try {
      const result = await platform.memoryService({ kind })
      if (kind === "backups") setBackups((result as { backups: Backup[] }).backups)
      else if (kind === "diagnostics") setDiagnostics(result as Diagnostics)
      else if (kind === "supportBundle") setBundle((result as { path: string }).path)
      else if (kind === "backup") {
        const listed = (await platform.memoryService({ kind: "backups" })) as { backups: Backup[] }
        setBackups(listed.backups)
      } else mutate(result as MemoryServiceSnapshot)
      await refetch()
    } catch {
      setError(language.t("memory.settings.error"))
    } finally {
      setBusy(false)
    }
  }

  const update = async (change: Partial<MemoryDesktopSettings>) => {
    if (!platform.memoryService || !snapshot()) return
    setBusy(true)
    setError("")
    try {
      mutate(
        (await platform.memoryService({
          kind: "update",
          settings: { ...snapshot()!.settings, ...change },
        })) as MemoryServiceSnapshot,
      )
    } catch {
      setError(language.t("memory.settings.error"))
    } finally {
      setBusy(false)
    }
  }

  const restore = async (item: Backup) => {
    if (!platform.memoryService || !item.verified) return
    setBusy(true)
    setError("")
    try {
      const check = (await platform.memoryService({ kind: "restoreDryRun", backupId: item.id })) as { valid: boolean }
      if (!check.valid) throw new Error("backup_not_verified")
      const detail = `${new Date(item.createdAt).toLocaleString()} · ${Math.round(item.sizeBytes / 1024)} KB · schema ${item.schemaVersion}`
      if (!window.confirm(`${language.t("memory.settings.restoreConfirm")}\n\n${detail}`)) return
      await platform.memoryService({ kind: "restore", backupId: item.id, confirm: true })
      await action("diagnostics")
    } catch {
      setError(language.t("memory.settings.error"))
    } finally {
      setBusy(false)
    }
  }

  return (
    <>
      <div class="settings-v2-tab-header">
        <h2 class="settings-v2-tab-title">{language.t("memory.settings.title")}</h2>
      </div>
      <Show
        when={platform.memoryService && snapshot()}
        fallback={<p class="memory-settings-note">{language.t("memory.settings.unavailable")}</p>}
      >
        <SettingsListV2>
          <SettingsRowV2
            title={language.t("memory.settings.enabled")}
            description={language.t("memory.settings.gateway")}
          >
            <Switch
              hideLabel
              checked={snapshot()!.settings.enabled}
              disabled={busy()}
              onChange={(value) => void update({ enabled: value })}
            >
              {language.t("memory.settings.enabled")}
            </Switch>
          </SettingsRowV2>
          <SettingsRowV2
            title={language.t("memory.settings.injection")}
            description={language.t("memory.settings.enabled")}
          >
            <Switch
              hideLabel
              checked={snapshot()!.settings.injection}
              disabled={busy() || !snapshot()!.settings.enabled}
              onChange={(value) => void update({ injection: value })}
            >
              {language.t("memory.settings.injection")}
            </Switch>
          </SettingsRowV2>
          <SettingsRowV2
            title={language.t("memory.settings.autoStart")}
            description={language.t("memory.settings.gateway")}
          >
            <Switch
              hideLabel
              checked={snapshot()!.settings.autoStart}
              disabled={busy()}
              onChange={(value) => void update({ autoStart: value })}
            >
              {language.t("memory.settings.autoStart")}
            </Switch>
          </SettingsRowV2>
          <SettingsRowV2
            title={language.t("memory.settings.gateway")}
            description={
              snapshot()!.reason
                ? language.t(reasonKeys[snapshot()!.reason as keyof typeof reasonKeys] ?? "memory.settings.error")
                : ""
            }
          >
            <span role="status">{language.t(stateKeys[snapshot()!.state])}</span>
          </SettingsRowV2>
          <SettingsRowV2 title={language.t("memory.settings.ollama")} description="Local Ollama · 127.0.0.1:11434">
            <span role="status">
              {snapshot()!.ollama.connected
                ? language.t("memory.settings.connected")
                : language.t("memory.settings.unavailable")}
            </span>
          </SettingsRowV2>
          <SettingsRowV2 title={language.t("memory.settings.model")} description={language.t("memory.settings.ollama")}>
            <select
              aria-label={language.t("memory.settings.model")}
              value={snapshot()!.settings.model}
              disabled={busy() || !snapshot()!.ollama.connected}
              onChange={(event) => void update({ model: event.currentTarget.value })}
            >
              <For each={[...new Set([snapshot()!.settings.model, ...snapshot()!.ollama.models])]}>
                {(model) => <option value={model}>{model}</option>}
              </For>
            </select>
          </SettingsRowV2>
          <div class="memory-settings-actions">
            <button type="button" disabled={busy()} onClick={() => void action("checkOllama")}>
              {language.t("memory.settings.retry")}
            </button>
            <button
              type="button"
              disabled={busy() || snapshot()!.state === "external"}
              onClick={() => void action("restart")}
            >
              {language.t("memory.settings.restart")}
            </button>
          </div>
          <button
            type="button"
            class="memory-settings-expander"
            aria-expanded={advanced()}
            onClick={() => setAdvanced(!advanced())}
          >
            {language.t("memory.settings.advanced")}
          </button>
          <Show when={advanced()}>
            <SettingsRowV2 title={language.t("memory.settings.budget")} description="100–8000">
              <input
                aria-label={language.t("memory.settings.budget")}
                type="number"
                min="100"
                max="8000"
                value={snapshot()!.settings.retrievalTokens}
                disabled={busy()}
                onChange={(event) => void update({ retrievalTokens: Number(event.currentTarget.value) })}
              />
            </SettingsRowV2>
            <SettingsRowV2
              title={language.t("memory.settings.embeddings")}
              description="FTS fallback remains available"
            >
              <Switch
                hideLabel
                checked={snapshot()!.settings.embeddings}
                disabled={busy() || !snapshot()!.settings.embeddingModel}
                onChange={(value) => void update({ embeddings: value })}
              >
                {language.t("memory.settings.embeddings")}
              </Switch>
            </SettingsRowV2>
            <SettingsRowV2
              title={language.t("memory.settings.embeddingModel")}
              description={language.t("memory.settings.ollama")}
            >
              <select
                aria-label={language.t("memory.settings.embeddingModel")}
                value={snapshot()!.settings.embeddingModel}
                disabled={busy() || !snapshot()!.ollama.connected}
                onChange={(event) => void update({ embeddingModel: event.currentTarget.value })}
              >
                <option value="">—</option>
                <For each={snapshot()!.ollama.models}>{(model) => <option value={model}>{model}</option>}</For>
              </select>
            </SettingsRowV2>
            <SettingsRowV2 title={language.t("memory.settings.data")} description={snapshot()!.dataDirectory}>
              <span>memory.db</span>
            </SettingsRowV2>
            <div class="memory-settings-actions">
              <button
                type="button"
                disabled={busy() || snapshot()!.state === "running" || snapshot()!.state === "external"}
                onClick={() => void action("importDatabase")}
              >
                {language.t("memory.settings.import")}
              </button>
            </div>
          </Show>
          <h3 class="memory-settings-subtitle">{language.t("memory.settings.maintenance")}</h3>
          <div class="memory-settings-actions">
            <button
              type="button"
              disabled={busy() || !snapshot()!.settings.enabled}
              onClick={() => void action("backup")}
            >
              {language.t("memory.settings.backup")}
            </button>
            <button type="button" disabled={busy()} onClick={() => void action("backups")}>
              {language.t("memory.settings.backups")}
            </button>
            <button type="button" disabled={busy()} onClick={() => void action("diagnostics")}>
              {language.t("memory.settings.diagnostics")}
            </button>
            <button type="button" disabled={busy()} onClick={() => void action("supportBundle")}>
              {language.t("memory.settings.support")}
            </button>
          </div>
          <Show when={diagnostics()}>
            {(result) => (
              <p role="status" class="memory-settings-note">
                {result().ok ? language.t("memory.settings.healthy") : language.t("memory.settings.problem")}
                {result().database?.integrity === "ok" ? ` · ${language.t("memory.settings.databaseHealthy")}` : ""}
                {result().issues?.filter((issue) => issue.severity !== "info").length
                  ? ` · ${result()
                      .issues?.filter((issue) => issue.severity !== "info")
                      .map((issue) => issue.code)
                      .join(", ")}`
                  : ""}
              </p>
            )}
          </Show>
          <Show when={bundle()}>
            <p role="status" class="memory-settings-note">
              {bundle()}{" "}
              <button type="button" onClick={() => void platform.revealPath?.(bundle())}>
                ↗
              </button>
            </p>
          </Show>
          <Show
            when={backups().length}
            fallback={<p class="memory-settings-note">{language.t("memory.settings.noBackups")}</p>}
          >
            <ul class="memory-settings-backups">
              <For each={backups()}>
                {(item) => (
                  <li>
                    <span>
                      {new Date(item.createdAt).toLocaleString()} · {Math.round(item.sizeBytes / 1024)} KB · schema{" "}
                      {item.schemaVersion} · {item.verified ? "✓" : "!"}
                    </span>
                    <button type="button" disabled={busy() || !item.verified} onClick={() => void restore(item)}>
                      {language.t("memory.settings.restore")}
                    </button>
                  </li>
                )}
              </For>
            </ul>
          </Show>
          <Show when={error()}>
            <p role="alert" class="memory-settings-note">
              {error()}
            </p>
          </Show>
        </SettingsListV2>
      </Show>
    </>
  )
}
