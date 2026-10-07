import { For, Show, createResource, createSignal, onCleanup, onMount, type Component } from "solid-js"
import type { MemoryDesktopSettings, MemoryServiceSnapshot } from "@opencode-ai/core/memory/desktop"
import { Switch } from "@opencode-ai/ui/v2/switch-v2"
import { SelectV2 } from "@opencode-ai/ui/v2/select-v2"
import { TextInputV2 } from "@opencode-ai/ui/v2/text-input-v2"
import { ButtonV2 } from "@opencode-ai/ui/v2/button-v2"
import { useDialog } from "@opencode-ai/ui/context/dialog"
import { useLanguage } from "@/context/language"
import { usePlatform } from "@/context/platform"
import { useServerSync } from "@/context/server-sync"
import { SettingsListV2 } from "./parts/list"
import { SettingsRowV2 } from "./parts/row"
import { MemoryConfirmDialog } from "@/pages/session/memory-manager-dialogs"
import { openMemoryManager } from "@/memory/status-view"
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
  memory_model_not_installed: "memory.settings.reason.memoryModelMissing",
  port_occupied_or_incompatible: "memory.settings.reason.port",
  gateway_not_bundled: "memory.settings.reason.bundle",
  gateway_crashed: "memory.settings.reason.crash",
  gateway_start_timeout: "memory.settings.reason.timeout",
} as const

export const contextPresets = [8192, 16384, 32768, 49152, 65536, 98304, 131072, 262144] as const
const isContextPreset = (value: number) => contextPresets.some((preset) => preset === value)
export const contextMismatch = (configured: number, effective?: number, modelMaximum?: number) =>
  effective !== undefined && effective !== Math.min(configured, modelMaximum ?? configured)

export function contextWarning(configured: number) {
  if (configured >= 262144) return "memory.settings.contextExperimental"
  if (configured >= 131072) return "memory.settings.contextHigh"
  if (configured >= 65536) return "memory.settings.contextLarge"
  return undefined
}

export const SettingsMemoryV2: Component = () => {
  const language = useLanguage()
  const platform = usePlatform()
  const serverSync = useServerSync()
  const dialog = useDialog()
  const [snapshot, { mutate, refetch }] = createResource(
    async () => platform.memoryService?.({ kind: "get" }) as Promise<MemoryServiceSnapshot | undefined>,
  )
  const [busy, setBusy] = createSignal(false)
  const [error, setError] = createSignal("")
  const [advanced, setAdvanced] = createSignal(false)
  const [customContext, setCustomContext] = createSignal("")
  const [backups, setBackups] = createSignal<Backup[]>([])
  const [diagnostics, setDiagnostics] = createSignal<Diagnostics>()
  const [bundle, setBundle] = createSignal("")
  let stop: (() => void) | undefined
  let contextRefresh: ReturnType<typeof setInterval> | undefined
  let disposed = false
  onMount(() => {
    const refreshContext = () => {
      if (busy()) return
      void platform
        .memoryService?.({ kind: "checkOllama" })
        .then(() => {
          if (!disposed) void refetch()
        })
        .catch(() => undefined)
    }
    refreshContext()
    contextRefresh = setInterval(refreshContext, 15_000)
    void platform
      .memoryServiceSubscribe?.((next) => mutate(next))
      .then((unsubscribe) => {
        if (disposed) unsubscribe()
        else stop = unsubscribe
      })
  })
  onCleanup(() => {
    disposed = true
    if (contextRefresh) clearInterval(contextRefresh)
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
      if (change.contextLength !== undefined || change.model !== undefined) await serverSync().refreshProviders()
    } catch (cause) {
      setError(
        cause instanceof Error && cause.message.includes("memory_settings_require_v2_service_restart")
          ? language.t(
              change.contextLength === undefined
                ? "memory.settings.agentToolsRestartRequired"
                : "memory.settings.contextRestartRequired",
            )
          : language.t("memory.settings.error"),
      )
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
      void dialog.push(() => (
        <MemoryConfirmDialog
          title={language.t("memory.settings.restore")}
          message={`${language.t("memory.settings.restoreConfirm")} ${detail}`}
          confirm={async () => {
            await platform.memoryService!({ kind: "restore", backupId: item.id, confirm: true })
            await action("diagnostics")
          }}
          errorText={() => language.t("memory.settings.error")}
        />
      ))
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
          <div class="memory-settings-actions">
            <ButtonV2
              variant="neutral"
              disabled={!snapshot()!.settings.enabled || !platform.memoryStatus}
              onClick={() => openMemoryManager(platform.memoryStatus, dialog.close)}
            >
              {language.t("memory.manager.open")}
            </ButtonV2>
          </div>
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
            title={language.t("memory.settings.agentTools")}
            description={language.t("memory.settings.agentToolsDescription")}
          >
            <Switch
              hideLabel
              checked={snapshot()!.settings.agentTools}
              disabled={busy() || !snapshot()!.settings.enabled}
              onChange={(value) => void update({ agentTools: value })}
            >
              {language.t("memory.settings.agentTools")}
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
            <SelectV2
              appearance="inline"
              aria-label={language.t("memory.settings.model")}
              options={[
                ...new Set([
                  snapshot()!.settings.model,
                  ...(snapshot()!.ollama.chatModels ?? []).map((model) => model.id),
                ]),
              ]}
              current={snapshot()!.settings.model}
              disabled={busy() || !snapshot()!.ollama.connected}
              onSelect={(model) => model && void update({ model })}
            />
          </SettingsRowV2>
          <h3 class="memory-settings-subtitle">{language.t("memory.settings.modelContext")}</h3>
          <SettingsRowV2
            title={language.t("memory.settings.contextLength")}
            description={language.t("memory.settings.contextApplies")}
          >
            <SelectV2
              appearance="inline"
              aria-label={language.t("memory.settings.contextLength")}
              options={[...contextPresets, "custom"] as (number | string)[]}
              current={
                isContextPreset(snapshot()!.settings.contextLength) ? snapshot()!.settings.contextLength : "custom"
              }
              value={String}
              label={(value) =>
                value === "custom"
                  ? language.t("memory.settings.contextCustom")
                  : `${Number(value) / 1024}K${value === 262144 ? " · Experimental" : ""}`
              }
              disabled={busy() || !snapshot()!.settings.enabled || snapshot()!.state === "external"}
              onSelect={(value) => {
                if (value === "custom") {
                  setAdvanced(true)
                  return
                }
                if (typeof value === "number") void update({ contextLength: value })
              }}
            />
          </SettingsRowV2>
          <p class="memory-settings-note" role="status">
            {language.t("memory.settings.contextConfigured")}:{" "}
            {snapshot()!.settings.contextLength.toLocaleString(language.intl())} ·{" "}
            {language.t("memory.settings.contextEffective")}:{" "}
            {snapshot()!.ollama.effectiveContextLength?.toLocaleString(language.intl()) ??
              language.t("memory.settings.contextUnknown")}
            {" · "}
            {language.t("memory.settings.contextModelMaximum")}:{" "}
            {snapshot()!.ollama.modelContextLength?.toLocaleString(language.intl()) ??
              language.t("memory.settings.contextUnknown")}
          </p>
          <Show when={contextWarning(snapshot()!.settings.contextLength)}>
            {(warning) => (
              <p class="memory-settings-note" role="alert">
                {language.t(warning())}
              </p>
            )}
          </Show>
          <Show
            when={contextMismatch(
              snapshot()!.settings.contextLength,
              snapshot()!.ollama.effectiveContextLength,
              snapshot()!.ollama.modelContextLength,
            )}
          >
            <p class="memory-settings-note" role="alert">
              {language.t("memory.settings.contextMismatch")}
            </p>
          </Show>
          <div class="memory-settings-actions">
            <ButtonV2 variant="neutral" disabled={busy()} onClick={() => void action("checkOllama")}>
              {language.t("memory.settings.retry")}
            </ButtonV2>
            <ButtonV2
              variant="neutral"
              disabled={busy() || snapshot()!.state === "external"}
              onClick={() => void action("restart")}
            >
              {language.t("memory.settings.restart")}
            </ButtonV2>
          </div>
          <ButtonV2
            variant="ghost-muted"
            class="memory-settings-expander"
            aria-expanded={advanced()}
            onClick={() => setAdvanced(!advanced())}
          >
            {language.t("memory.settings.advanced")}
          </ButtonV2>
          <Show when={advanced()}>
            <SettingsRowV2 title={language.t("memory.settings.contextCustom")} description="4096–262144">
              <div class="memory-settings-inline">
                <TextInputV2
                  type="number"
                  min="4096"
                  max="262144"
                  step="1"
                  aria-label={language.t("memory.settings.contextCustom")}
                  value={
                    customContext() ||
                    (isContextPreset(snapshot()!.settings.contextLength)
                      ? ""
                      : String(snapshot()!.settings.contextLength))
                  }
                  disabled={busy() || !snapshot()!.settings.enabled || snapshot()!.state === "external"}
                  onInput={(event) => setCustomContext(event.currentTarget.value)}
                />
                <ButtonV2
                  variant="neutral"
                  disabled={
                    busy() ||
                    snapshot()!.state === "external" ||
                    !/^\d+$/.test(customContext()) ||
                    Number(customContext()) < 4096 ||
                    Number(customContext()) > 262144
                  }
                  onClick={() => void update({ contextLength: Number(customContext()) })}
                >
                  {language.t("memory.settings.contextApply")}
                </ButtonV2>
              </div>
            </SettingsRowV2>
            <SettingsRowV2 title={language.t("memory.settings.maxToolCalls")} description="1–24">
              <TextInputV2
                type="number"
                min="1"
                max="24"
                aria-label={language.t("memory.settings.maxToolCalls")}
                value={snapshot()!.settings.maxToolCalls}
                disabled={busy() || !snapshot()!.settings.enabled}
                onChange={(event) => void update({ maxToolCalls: Number(event.currentTarget.value) })}
              />
            </SettingsRowV2>
            <SettingsRowV2 title={language.t("memory.settings.budget")} description="100–8000">
              <TextInputV2
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
              <SelectV2
                appearance="inline"
                aria-label={language.t("memory.settings.embeddingModel")}
                options={["", ...snapshot()!.ollama.models]}
                current={snapshot()!.settings.embeddingModel}
                value={(model) => model || "__memory_embedding_none__"}
                label={(model) => model || "—"}
                disabled={busy() || !snapshot()!.ollama.connected}
                onSelect={(model) => model !== null && void update({ embeddingModel: model })}
              />
            </SettingsRowV2>
            <SettingsRowV2 title={language.t("memory.settings.data")} description={snapshot()!.dataDirectory}>
              <span>memory.db</span>
            </SettingsRowV2>
            <div class="memory-settings-actions">
              <ButtonV2
                variant="neutral"
                disabled={busy() || snapshot()!.state === "running" || snapshot()!.state === "external"}
                onClick={() => void action("importDatabase")}
              >
                {language.t("memory.settings.import")}
              </ButtonV2>
            </div>
          </Show>
          <h3 class="memory-settings-subtitle">{language.t("memory.settings.maintenance")}</h3>
          <div class="memory-settings-actions">
            <ButtonV2
              variant="neutral"
              disabled={busy() || !snapshot()!.settings.enabled}
              onClick={() => void action("backup")}
            >
              {language.t("memory.settings.backup")}
            </ButtonV2>
            <ButtonV2 variant="neutral" disabled={busy()} onClick={() => void action("backups")}>
              {language.t("memory.settings.backups")}
            </ButtonV2>
            <ButtonV2 variant="neutral" disabled={busy()} onClick={() => void action("diagnostics")}>
              {language.t("memory.settings.diagnostics")}
            </ButtonV2>
            <ButtonV2 variant="neutral" disabled={busy()} onClick={() => void action("supportBundle")}>
              {language.t("memory.settings.support")}
            </ButtonV2>
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
              <ButtonV2
                variant="ghost-muted"
                aria-label={language.t("memory.settings.support")}
                onClick={() => void platform.revealPath?.(bundle())}
              >
                ↗
              </ButtonV2>
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
                    <ButtonV2 variant="neutral" disabled={busy() || !item.verified} onClick={() => void restore(item)}>
                      {language.t("memory.settings.restore")}
                    </ButtonV2>
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
