import { makeEventListener } from "@solid-primitives/event-listener"
import { ButtonV2 } from "@opencode-ai/ui/v2/button-v2"
import { Icon } from "@opencode-ai/ui/v2/icon"
import { IconButtonV2 } from "@opencode-ai/ui/v2/icon-button-v2"
import { For, Show, createMemo, createResource } from "solid-js"
import { createStore } from "solid-js/store"
import { useLanguage } from "@/context/language"
import { usePlatform } from "@/context/platform"
import { memoryPanelView, type MemoryPanelIdentity } from "@/memory/panel-view"

const time = (value: number) =>
  new Date(value).toLocaleTimeString([], { hour: "2-digit", minute: "2-digit", second: "2-digit" })

export function MemoryPanel(props: MemoryPanelIdentity) {
  const language = useLanguage()
  const platform = usePlatform()
  const memory = () => platform.memoryStatus!
  const projectIdentity = createMemo(() => {
    const projectID = props.project?.id
    const directory = props.directory || props.project?.worktree
    if (!projectID || !directory) return undefined
    return { projectID, projectRoot: props.project?.worktree ?? directory, directory }
  })
  const [resolvedProject] = createResource(projectIdentity, async (input) => ({
    ...input,
    effectiveID: await memory().effectiveProjectID(input),
  }))
  const view = createMemo(() => {
    const current = projectIdentity()
    const resolved = resolvedProject()
    const effectiveProjectID =
      current &&
      resolved?.projectID === current.projectID &&
      resolved.projectRoot === current.projectRoot &&
      resolved.directory === current.directory
        ? resolved.effectiveID
        : undefined
    return memoryPanelView(memory().snapshot(), memory().now(), { ...props, effectiveProjectID })
  })
  const [actions, setActions] = createStore({ refresh: false, reconnect: false })

  makeEventListener(document, "keydown", (event) => {
    if (event.key !== "Escape") return
    memory().panel.close()
  })

  const run = async (kind: "refresh" | "reconnect") => {
    if (actions[kind]) return
    setActions(kind, true)
    const action = kind === "refresh" ? memory().refresh() : memory().reconnect()
    await action.finally(() => setActions(kind, false))
  }

  const row = (label: string, value: string | number) => (
    <div class="grid grid-cols-[minmax(0,1fr)_minmax(0,1.4fr)] gap-3 py-2 border-b border-border-weak-base last:border-b-0">
      <div class="text-12-regular text-text-weak">{label}</div>
      <div class="min-w-0 text-12-medium text-text-strong break-words text-end">{value}</div>
    </div>
  )

  return (
    <aside
      id="memory-panel"
      data-component="memory-panel"
      aria-label={language.t("memory.panel.title")}
      class="h-full min-h-0 w-full md:w-[320px] md:min-w-[280px] md:max-w-[380px] shrink-0 overflow-hidden bg-v2-background-bg-base rounded-[10px] shadow-[var(--v2-elevation-raised)] flex flex-col"
    >
      <header class="h-11 shrink-0 flex items-center justify-between gap-3 px-3 border-b border-border-weak-base">
        <div class="min-w-0 flex items-center gap-2">
          <Icon name="sidebar-right" class="shrink-0" />
          <div class="truncate text-14-medium text-text-strong">{language.t("memory.panel.title")}</div>
        </div>
        <IconButtonV2
          size="small"
          variant="ghost-muted"
          aria-label={language.t("memory.panel.close")}
          onClick={() => memory().panel.close()}
          icon={<Icon name="xmark-small" />}
        />
      </header>

      <div class="min-h-0 flex-1 overflow-y-auto px-3 py-2">
        <section aria-label={language.t("memory.panel.connection")}>
          {row(
            language.t("memory.panel.gateway"),
            language.t(view().connected ? "memory.status.connected" : "memory.status.offlineValue"),
          )}
          {row(language.t("memory.panel.status"), language.t(view().statusKey))}
          {row(language.t("memory.panel.phase"), view().phase)}
          <Show when={view().jobID}>{(value) => row(language.t("memory.panel.job"), value())}</Show>
          <Show when={view().elapsed}>{(value) => row(language.t("memory.panel.elapsed"), value())}</Show>
          {row(language.t("memory.panel.queue"), view().queueLength)}
          {row(language.t("memory.panel.queuedRequests"), view().queuedUserRequests)}
          {row(language.t("memory.panel.processed"), view().processedItems)}
          <Show when={view().receivedAt > 0}>
            {row(
              language.t(view().connected ? "memory.panel.lastUpdate" : "memory.panel.lastConnected"),
              time(view().receivedAt),
            )}
          </Show>
        </section>

        <section class="mt-4" aria-label={language.t("memory.panel.identity")}>
          <div class="mb-1 text-11-medium uppercase tracking-wide text-text-faint">
            {language.t("memory.panel.identity")}
          </div>
          {row(language.t("memory.panel.project"), view().projectLabel || "—")}
          <Show when={view().projectID}>{(value) => row(language.t("memory.panel.projectId"), value())}</Show>
          {row(language.t("memory.panel.session"), view().sessionID || "—")}
        </section>

        <Show when={view().error}>
          {(error) => (
            <section class="mt-4 rounded-md border border-v2-state-border-danger bg-v2-state-bg-danger p-3">
              <div class="text-12-medium text-text-strong">{language.t("memory.panel.error")}</div>
              <div class="mt-1 text-12-regular text-text-base break-words">{error()}</div>
            </section>
          )}
        </Show>

        <Show when={view().degradedReasons.length > 0}>
          <section class="mt-4 rounded-md border border-v2-state-border-warning bg-v2-state-bg-warning p-3">
            <div class="text-12-medium text-text-strong">{language.t("memory.panel.degraded")}</div>
            <ul class="mt-1 list-disc ps-4 text-12-regular text-text-base">
              <For each={view().degradedReasons}>{(reason) => <li class="break-words">{reason}</li>}</For>
            </ul>
          </section>
        </Show>
      </div>

      <footer class="shrink-0 flex items-center justify-end gap-2 px-3 py-2 border-t border-border-weak-base">
        <ButtonV2 size="small" variant="neutral" onClick={() => memory().manager.open()}>
          {language.t("memory.manager.open")}
        </ButtonV2>
        <Show when={!view().connected}>
          <ButtonV2 size="small" variant="outline" disabled={actions.reconnect} onClick={() => void run("reconnect")}>
            {language.t("memory.panel.reconnect")}
          </ButtonV2>
        </Show>
        <ButtonV2 size="small" variant="neutral" disabled={actions.refresh} onClick={() => void run("refresh")}>
          {language.t("memory.panel.refresh")}
        </ButtonV2>
      </footer>
    </aside>
  )
}
