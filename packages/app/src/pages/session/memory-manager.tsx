import { makeEventListener } from "@solid-primitives/event-listener"
import { ButtonV2 } from "@opencode-ai/ui/v2/button-v2"
import { Icon } from "@opencode-ai/ui/v2/icon"
import { SelectV2 } from "@opencode-ai/ui/v2/select-v2"
import { TabsV2 } from "@opencode-ai/ui/v2/tabs-v2"
import { TextInputV2 } from "@opencode-ai/ui/v2/text-input-v2"
import { useDialog } from "@opencode-ai/ui/context/dialog"
import type {
  ManagedHistory,
  ManagedMemory,
  ManagedProject,
  ManagedSource,
  ManagedTaxonomyNode,
  ManagementContent,
  ManagementEdit,
  ManagementMerge,
  MemoryManagementAction,
  MemoryManagementMetadata,
  MemoryManagementResult,
  MemorySort,
  MemoryStatus,
} from "@opencode-ai/core/memory/management-types"
import {
  For,
  Show,
  createEffect,
  createMemo,
  createResource,
  getOwner,
  on,
  onCleanup,
  onMount,
  runWithOwner,
} from "solid-js"
import { createStore } from "solid-js/store"
import { useLanguage } from "@/context/language"
import { usePlatform } from "@/context/platform"
import {
  compatibleMemory,
  memoryManagerQuery,
  memoryManagerScope,
  type MemoryManagerMode,
} from "@/memory/manager-model"
import { shortMemoryID, type MemoryPanelIdentity } from "@/memory/panel-view"
import { showToast } from "@/utils/toast"
import { MemoryConfirmDialog, MemoryMoveDialog, MemorySaveDialog } from "./memory-manager-dialogs"

const errorKeys = {
  offline: "memory.manager.error.offline",
  invalid_request: "memory.manager.error.invalid_request",
  memory_not_found: "memory.manager.error.memory_not_found",
  unknown_project: "memory.manager.error.unknown_project",
  unsupported_type: "memory.manager.error.unsupported_type",
  scope_mismatch: "memory.manager.error.scope_mismatch",
  cross_project_merge: "memory.manager.error.cross_project_merge",
  invalid_taxonomy_target: "memory.manager.error.invalid_taxonomy_target",
  memory_conflict: "memory.manager.error.memory_conflict",
  secret: "memory.manager.error.secret",
} as const

const date = (value: string | null | undefined) => (value ? new Date(value).toLocaleString() : "—")

export function MemoryManager(props: MemoryPanelIdentity) {
  const owner = getOwner()
  const language = useLanguage()
  const platform = usePlatform()
  const dialog = useDialog()
  const memory = () => platform.memoryStatus!
  const identity = createMemo(() => {
    const projectID = props.project?.id
    const directory = props.directory || props.project?.worktree
    if (!projectID || !directory) return undefined
    return { projectID, projectRoot: props.project?.worktree ?? directory, directory }
  })
  const [effective] = createResource(identity, (input) => memory().effectiveProjectID(input))
  const currentProjectID = createMemo(() => effective())
  const [state, setState] = createStore({
    mode: "global" as MemoryManagerMode,
    selectedProjectID: "",
    status: "active" as MemoryStatus,
    type: "",
    sort: "updated_at" as MemorySort,
    searchDraft: "",
    search: "",
    taxonomyNodeID: "",
    metadata: undefined as MemoryManagementMetadata | undefined,
    projects: [] as ManagedProject[],
    taxonomy: [] as ManagedTaxonomyNode[],
    items: [] as ManagedMemory[],
    nextCursor: null as string | null,
    listLoading: false,
    listError: "",
    selectedID: "",
    detail: undefined as ManagedMemory | undefined,
    detailLoading: false,
    detailError: "",
    detailTab: "details" as "details" | "sources" | "history",
    sources: undefined as ManagedSource[] | undefined,
    history: undefined as ManagedHistory | undefined,
    secondaryError: "",
    secondaryLoading: false,
  })
  const request = async <K extends keyof MemoryManagementResult>(
    action: MemoryManagementAction,
  ): Promise<MemoryManagementResult[K]> => {
    const response = await memory().manage(action)
    if (!response.ok) throw response.error
    return response.value as MemoryManagementResult[K]
  }
  const errorText = (error: unknown) => {
    const code = error && typeof error === "object" && "code" in error ? String(error.code) : ""
    const key = errorKeys[code as keyof typeof errorKeys]
    return key ? language.t(key) : language.t("memory.manager.error")
  }
  const offline = () => !memory().snapshot().connected
  const scope = createMemo(() => memoryManagerScope(state.mode, currentProjectID(), state.selectedProjectID))
  const projectName = (id: string | null) =>
    id
      ? (state.projects.find((project) => project.projectId === id)?.name ?? shortMemoryID(id))
      : language.t("memory.manager.global")
  const query = createMemo(() =>
    memoryManagerQuery({
      mode: state.mode,
      currentProjectID: currentProjectID(),
      selectedProjectID: state.selectedProjectID,
      status: state.status,
      type: state.type,
      search: state.search,
      sort: state.sort,
      taxonomyNodeId: state.taxonomyNodeID,
    }),
  )
  let listGeneration = 0
  let detailGeneration = 0
  let secondaryGeneration = 0
  let searchTimer: ReturnType<typeof setTimeout> | undefined

  const refreshProjects = async () => {
    const projects = await request<"projects">({ kind: "projects" })
    setState("projects", projects)
  }
  const refreshTaxonomy = async () => {
    const current = scope()
    if (!current) {
      setState("taxonomy", [])
      return
    }
    const nodes = await request<"taxonomy">({ kind: "taxonomy", ...current })
    setState("taxonomy", nodes)
  }
  const loadList = async (more = false) => {
    const current = query()
    const generation = ++listGeneration
    if (!more) {
      setState("items", [])
      setState("nextCursor", null)
    }
    if (!current) {
      setState("listLoading", false)
      setState("listError", "")
      return
    }
    setState("listLoading", true)
    setState("listError", "")
    try {
      const page = await request<"list">({
        kind: "list",
        query: { ...current, cursor: more ? (state.nextCursor ?? undefined) : undefined },
      })
      if (generation !== listGeneration) return
      setState("items", more ? [...state.items, ...page.items] : page.items)
      setState("nextCursor", page.nextCursor)
    } catch (error) {
      if (generation === listGeneration) setState("listError", errorText(error))
    } finally {
      if (generation === listGeneration) setState("listLoading", false)
    }
  }
  const loadDetail = async (id: string) => {
    const generation = ++detailGeneration
    setState("detail", undefined)
    setState("sources", undefined)
    setState("history", undefined)
    setState("detailTab", "details")
    setState("detailError", "")
    if (!id) {
      setState("detailLoading", false)
      return
    }
    setState("detailLoading", true)
    try {
      const detail = await request<"get">({ kind: "get", id })
      if (generation === detailGeneration) setState("detail", detail)
    } catch (error) {
      if (generation === detailGeneration) setState("detailError", errorText(error))
    } finally {
      if (generation === detailGeneration) setState("detailLoading", false)
    }
  }
  const loadSecondary = async () => {
    const id = state.selectedID
    const tab = state.detailTab
    const generation = ++secondaryGeneration
    if (!id || tab === "details" || (tab === "sources" && state.sources) || (tab === "history" && state.history)) return
    setState("secondaryLoading", true)
    setState("secondaryError", "")
    try {
      if (tab === "sources") {
        const sources = await request<"sources">({ kind: "sources", id })
        if (generation === secondaryGeneration) setState("sources", sources)
      } else {
        const history = await request<"history">({ kind: "history", id })
        if (generation === secondaryGeneration) setState("history", history)
      }
    } catch (error) {
      if (generation === secondaryGeneration) setState("secondaryError", errorText(error))
    } finally {
      if (generation === secondaryGeneration) setState("secondaryLoading", false)
    }
  }
  const loadBase = async () => {
    try {
      const [metadata, projects] = await Promise.all([
        request<"metadata">({ kind: "metadata" }),
        request<"projects">({ kind: "projects" }),
      ])
      setState("metadata", metadata)
      setState("projects", projects)
    } catch (error) {
      setState("listError", errorText(error))
    }
  }
  const refresh = async () => {
    await loadBase()
    await Promise.all([
      refreshTaxonomy(),
      loadList(),
      state.selectedID ? loadDetail(state.selectedID) : Promise.resolve(),
    ])
  }
  const changed = async (result: ManagedMemory) => {
    await Promise.all([loadList(), refreshProjects(), refreshTaxonomy()])
    setState("selectedID", result.id)
    if (state.selectedID === result.id) await loadDetail(result.id)
    runWithOwner(owner, () => showToast({ title: language.t("memory.manager.success"), variant: "success" }))
  }

  createEffect(on(query, () => void loadList()))
  createEffect(on(scope, () => void refreshTaxonomy().catch(() => setState("taxonomy", []))))
  createEffect(
    on(
      () => state.selectedID,
      (id) => void loadDetail(id),
    ),
  )
  createEffect(
    on(
      () => [state.selectedID, state.detailTab] as const,
      () => void loadSecondary(),
    ),
  )
  onMount(() => void loadBase())
  onCleanup(() => {
    listGeneration++
    detailGeneration++
    secondaryGeneration++
    if (searchTimer) clearTimeout(searchTimer)
  })
  makeEventListener(document, "keydown", (event) => {
    if (event.key !== "Escape" || dialog.active) return
    if (state.selectedID && window.innerWidth < 768) {
      setState("selectedID", "")
      return
    }
    memory().manager.close()
  })

  const openForm = (kind: "create" | "edit" | "merge") => {
    const metadata = state.metadata
    if (!metadata || offline()) return
    const selected = state.detail
    if (kind !== "create" && (!selected || selected.status !== "active")) return
    const candidates =
      kind === "merge" ? state.items.filter((item) => selected && compatibleMemory(selected, item)) : undefined
    void dialog.show(() => (
      <MemorySaveDialog
        metadata={metadata}
        projects={state.projects}
        scope={selected?.scope ?? scope()?.scope ?? "global"}
        projectId={selected?.projectId ?? scope()?.projectId}
        memory={kind === "create" ? undefined : selected}
        mergeCandidates={candidates}
        errorText={errorText}
        save={async (input) => {
          if (kind === "create")
            return changed(await request<"create">({ kind: "create", input: input as ManagementContent }))
          if (kind === "edit")
            return changed(await request<"edit">({ kind: "edit", id: selected!.id, input: input as ManagementEdit }))
          return changed(await request<"merge">({ kind: "merge", input: input as ManagementMerge }))
        }}
      />
    ))
  }
  const archive = () => {
    const selected = state.detail
    if (!selected || offline()) return
    void dialog.show(() => (
      <MemoryConfirmDialog
        title={language.t("memory.manager.archive")}
        message={language.t("memory.manager.archivePrompt")}
        errorText={errorText}
        confirm={async () => changed(await request<"archive">({ kind: "archive", id: selected.id }))}
      />
    ))
  }
  const move = () => {
    const selected = state.detail
    if (!selected || offline()) return
    void dialog.show(() => (
      <MemoryMoveDialog
        nodes={state.taxonomy}
        errorText={errorText}
        move={async (nodeId) => changed(await request<"move">({ kind: "move", id: selected.id, nodeId }))}
      />
    ))
  }
  const resetFilters = (mode: MemoryManagerMode) => {
    setState("mode", mode)
    setState("type", "")
    setState("taxonomyNodeID", "")
    setState("selectedID", "")
    if (mode !== "all") setState("selectedProjectID", "")
  }
  const recordLine = (label: string, value: string | number | undefined | null) => (
    <div class="grid grid-cols-[minmax(0,1fr)_minmax(0,2fr)] gap-3 border-b border-border-weak-base py-2 text-12-regular last:border-0">
      <span class="text-text-weak">{label}</span>
      <span class="min-w-0 break-words text-end text-text-strong">{value ?? "—"}</span>
    </div>
  )

  return (
    <section
      id="memory-manager"
      data-component="memory-manager"
      aria-label={language.t("memory.manager.title")}
      class="absolute inset-0 z-40 flex min-h-0 min-w-0 flex-col overflow-hidden bg-v2-background-bg-base text-text-base"
    >
      <header class="flex shrink-0 flex-wrap items-center justify-between gap-3 border-b border-border-weak-base px-4 py-3">
        <div class="flex min-w-0 items-center gap-3">
          <Icon name="sidebar-right" />
          <h1 class="truncate text-16-medium text-text-strong">{language.t("memory.manager.title")}</h1>
        </div>
        <div class="flex items-center gap-2">
          <ButtonV2 size="small" variant="neutral" onClick={() => void refresh()}>
            {language.t("memory.manager.refresh")}
          </ButtonV2>
          <ButtonV2
            size="small"
            variant="contrast"
            disabled={offline() || !state.metadata}
            onClick={() => openForm("create")}
          >
            {language.t("memory.manager.new")}
          </ButtonV2>
          <ButtonV2 size="small" variant="ghost-muted" onClick={() => memory().manager.close()}>
            {language.t("memory.manager.close")}
          </ButtonV2>
        </div>
      </header>
      <Show when={offline()}>
        <div
          role="status"
          class="border-b border-v2-state-border-warning bg-v2-state-bg-warning px-4 py-2 text-12-regular"
        >
          <strong>{language.t("memory.manager.offline")}</strong> · {language.t("memory.manager.offlineHint")}
        </div>
      </Show>
      <nav
        aria-label={language.t("memory.manager.scope")}
        class="flex shrink-0 gap-1 overflow-x-auto border-b border-border-weak-base px-4 py-2"
      >
        <For each={["global", "current", "all"] as const}>
          {(mode) => (
            <ButtonV2
              size="small"
              variant={state.mode === mode ? "neutral" : "ghost-muted"}
              aria-pressed={state.mode === mode}
              onClick={() => resetFilters(mode)}
            >
              {language.t(
                mode === "global"
                  ? "memory.manager.global"
                  : mode === "current"
                    ? "memory.manager.current"
                    : "memory.manager.all",
              )}
            </ButtonV2>
          )}
        </For>
      </nav>
      <Show when={state.mode === "all"}>
        <div
          class="flex shrink-0 gap-2 overflow-x-auto border-b border-border-weak-base px-4 py-2"
          aria-label={language.t("memory.manager.projects")}
        >
          <For each={state.projects}>
            {(project) => (
              <ButtonV2
                size="small"
                variant={state.selectedProjectID === project.projectId ? "neutral" : "ghost-muted"}
                aria-pressed={state.selectedProjectID === project.projectId}
                onClick={() => {
                  setState("selectedProjectID", project.projectId)
                  setState("selectedID", "")
                  setState("taxonomyNodeID", "")
                }}
              >
                {project.name} · {project.memoryCount}
                <Show when={project.projectId === currentProjectID()}>
                  {" "}
                  · {language.t("memory.manager.currentBadge")}
                </Show>
                <span class="ms-2 text-11-regular text-text-weak">{date(project.lastActivity)}</span>
              </ButtonV2>
            )}
          </For>
        </div>
      </Show>
      <Show when={scope()}>
        <div class="flex shrink-0 flex-wrap items-center gap-2 border-b border-border-weak-base px-4 py-2">
          <TextInputV2
            aria-label={language.t("memory.manager.search")}
            placeholder={language.t("memory.manager.search")}
            value={state.searchDraft}
            onInput={(event) => {
              const value = event.currentTarget.value
              setState("searchDraft", value)
              if (searchTimer) clearTimeout(searchTimer)
              searchTimer = setTimeout(() => setState("search", value), 300)
            }}
          />
          <SelectV2
            appearance="inline"
            options={state.metadata?.statuses ?? (["active", "superseded", "archived"] as MemoryStatus[])}
            current={state.status}
            label={(value) => language.t(`memory.manager.${value}` as "memory.manager.active")}
            onSelect={(value) => value && setState("status", value)}
          />
          <SelectV2
            appearance="inline"
            options={["__all__", ...(state.metadata?.types[scope()!.scope] ?? [])]}
            current={state.type || "__all__"}
            label={(value) => (value === "__all__" ? language.t("memory.manager.allTypes") : value)}
            onSelect={(value) => setState("type", value === "__all__" ? "" : (value ?? ""))}
          />
          <SelectV2
            appearance="inline"
            options={["updated_at", "created_at", "importance"] as MemorySort[]}
            current={state.sort}
            label={(value) =>
              language.t(
                value === "updated_at"
                  ? "memory.manager.updated"
                  : value === "created_at"
                    ? "memory.manager.created"
                    : "memory.manager.importanceSort",
              )
            }
            onSelect={(value) => value && setState("sort", value)}
          />
        </div>
      </Show>
      <div class="flex min-h-0 min-w-0 flex-1 overflow-hidden">
        <div
          class="flex min-h-0 min-w-0 w-full flex-col border-e border-border-weak-base md:w-[min(42%,420px)] md:shrink-0"
          classList={{ "hidden md:flex": !!state.selectedID }}
        >
          <Show
            when={scope()}
            fallback={
              <div class="p-5 text-14-regular text-text-weak">
                {language.t(state.mode === "current" ? "memory.manager.noProject" : "memory.manager.chooseProject")}
              </div>
            }
          >
            <Show when={state.taxonomy.length > 0}>
              <div
                class="max-h-32 shrink-0 overflow-y-auto border-b border-border-weak-base px-3 py-2"
                aria-label={language.t("memory.manager.taxonomy")}
              >
                <ButtonV2
                  size="small"
                  variant={state.taxonomyNodeID ? "ghost-muted" : "neutral"}
                  onClick={() => setState("taxonomyNodeID", "")}
                >
                  {language.t("memory.manager.allTaxonomy")}
                </ButtonV2>
                <For each={state.taxonomy}>
                  {(node) => (
                    <button
                      type="button"
                      aria-pressed={state.taxonomyNodeID === node.id}
                      class="block w-full truncate rounded px-2 py-1 text-start text-12-regular text-text-base hover:bg-v2-overlay-simple-overlay-hover focus-visible:outline-v2-border-border-focus"
                      style={{
                        "padding-inline-start": `${8 + (node.level === "domain" ? 0 : node.level === "topic" ? 12 : 24)}px`,
                      }}
                      onClick={() => setState("taxonomyNodeID", node.id)}
                    >
                      {node.displayName} · {node.activeMemoryCount}
                    </button>
                  )}
                </For>
              </div>
            </Show>
            <div class="min-h-0 flex-1 overflow-y-auto">
              <Show when={state.listError}>
                <div role="alert" class="p-4 text-12-regular text-text-strong">
                  {state.listError}
                  <ButtonV2 size="small" variant="neutral" onClick={() => void loadList()}>
                    {language.t("memory.manager.retry")}
                  </ButtonV2>
                </div>
              </Show>
              <Show when={state.listLoading && state.items.length === 0}>
                <p class="p-4 text-12-regular text-text-weak">{language.t("memory.manager.loading")}</p>
              </Show>
              <Show when={!state.listLoading && !state.listError && state.items.length === 0}>
                <p class="p-4 text-12-regular text-text-weak">{language.t("memory.manager.noMemories")}</p>
              </Show>
              <For each={state.items}>
                {(item) => (
                  <button
                    type="button"
                    aria-current={state.selectedID === item.id ? "true" : undefined}
                    class="block w-full min-w-0 border-b border-border-weak-base px-4 py-3 text-start hover:bg-v2-overlay-simple-overlay-hover focus-visible:outline-v2-border-border-focus"
                    classList={{ "bg-v2-overlay-simple-overlay-hover": state.selectedID === item.id }}
                    onClick={() => setState("selectedID", item.id)}
                  >
                    <span class="block truncate text-14-medium text-text-strong">{item.summary}</span>
                    <span class="mt-1 flex flex-wrap gap-x-2 text-11-regular text-text-weak">
                      <span>{item.type}</span>
                      <span>
                        {item.scope === "global" ? language.t("memory.manager.global") : projectName(item.projectId)}
                      </span>
                      <span
                        class="rounded px-1"
                        classList={{
                          "bg-v2-state-bg-success text-v2-state-fg-success": item.status === "active",
                          "bg-v2-state-bg-warning text-v2-state-fg-warning":
                            item.status === "superseded" || item.status === "provisional",
                          "bg-v2-overlay-simple-overlay-hover text-text-weak":
                            item.status === "archived" || item.status === "deleted",
                        }}
                      >
                        {language.t(`memory.manager.${item.status}` as "memory.manager.active")}
                      </span>
                      <span>{item.importance.toFixed(2)}</span>
                      <span>{date(item.updatedAt)}</span>
                      <Show when={item.taxonomy.length}>
                        <span>{item.taxonomy.at(-1)?.name}</span>
                      </Show>
                    </span>
                  </button>
                )}
              </For>
              <Show when={state.nextCursor}>
                <div class="p-3">
                  <ButtonV2
                    size="small"
                    variant="neutral"
                    disabled={state.listLoading}
                    onClick={() => void loadList(true)}
                  >
                    {language.t("memory.manager.loadMore")}
                  </ButtonV2>
                </div>
              </Show>
            </div>
          </Show>
        </div>
        <div class="min-h-0 min-w-0 flex-1 overflow-y-auto" classList={{ "hidden md:block": !state.selectedID }}>
          <Show
            when={state.selectedID}
            fallback={<p class="p-6 text-14-regular text-text-weak">{language.t("memory.manager.chooseMemory")}</p>}
          >
            <div class="p-4 md:p-6">
              <div class="mb-3 md:hidden">
                <ButtonV2 size="small" variant="neutral" onClick={() => setState("selectedID", "")}>
                  {language.t("memory.manager.close")}
                </ButtonV2>
              </div>
              <Show when={state.detailLoading}>
                <p>{language.t("memory.manager.loading")}</p>
              </Show>
              <Show when={state.detailError}>
                <div role="alert">
                  {state.detailError}
                  <ButtonV2 size="small" variant="neutral" onClick={() => void loadDetail(state.selectedID)}>
                    {language.t("memory.manager.retry")}
                  </ButtonV2>
                </div>
              </Show>
              <Show when={state.detail}>
                {(detail) => (
                  <>
                    <div class="mb-4 flex flex-wrap items-start justify-between gap-3">
                      <div class="min-w-0">
                        <h2 class="break-words text-16-medium text-text-strong">{detail().summary}</h2>
                        <span class="text-12-regular text-text-weak">
                          {detail().type} · {language.t(`memory.manager.${detail().status}` as "memory.manager.active")}
                        </span>
                      </div>
                      <Show when={detail().status === "active"}>
                        <div class="flex flex-wrap gap-2">
                          <ButtonV2
                            size="small"
                            variant="neutral"
                            disabled={offline()}
                            onClick={() => openForm("edit")}
                          >
                            {language.t("memory.manager.edit")}
                          </ButtonV2>
                          <ButtonV2
                            size="small"
                            variant="neutral"
                            disabled={offline() || !state.items.some((item) => compatibleMemory(detail(), item))}
                            onClick={() => openForm("merge")}
                          >
                            {language.t("memory.manager.merge")}
                          </ButtonV2>
                          <ButtonV2
                            size="small"
                            variant="neutral"
                            disabled={offline() || state.taxonomy.length === 0}
                            onClick={move}
                          >
                            {language.t("memory.manager.move")}
                          </ButtonV2>
                          <ButtonV2 size="small" variant="neutral" disabled={offline()} onClick={archive}>
                            {language.t("memory.manager.archive")}
                          </ButtonV2>
                        </div>
                      </Show>
                    </div>
                    <TabsV2
                      value={state.detailTab}
                      onChange={(value) => setState("detailTab", value as typeof state.detailTab)}
                    >
                      <TabsV2.List class="mb-3 flex gap-2">
                        <TabsV2.Trigger value="details">{language.t("memory.manager.detailsTab")}</TabsV2.Trigger>
                        <TabsV2.Trigger value="sources">{language.t("memory.manager.sourcesTab")}</TabsV2.Trigger>
                        <TabsV2.Trigger value="history">{language.t("memory.manager.historyTab")}</TabsV2.Trigger>
                      </TabsV2.List>
                      <TabsV2.Content value="details">
                        <p class="whitespace-pre-wrap break-words text-14-regular text-text-base">{detail().details}</p>
                        <div class="mt-4">
                          {recordLine(language.t("memory.manager.scope"), detail().scope)}
                          {recordLine(
                            language.t("memory.manager.project"),
                            detail().projectId ? projectName(detail().projectId) : "—",
                          )}
                          {recordLine(language.t("memory.manager.type"), detail().type)}
                          {recordLine(language.t("memory.manager.status"), detail().status)}
                          {recordLine(language.t("memory.manager.importance"), detail().importance.toFixed(2))}
                          {recordLine(language.t("memory.manager.confidence"), detail().confidence.toFixed(2))}
                          {recordLine(language.t("memory.manager.createdAt"), date(detail().createdAt))}
                          {recordLine(language.t("memory.manager.updatedAt"), date(detail().updatedAt))}
                          {recordLine(language.t("memory.manager.supersededBy"), shortMemoryID(detail().supersededBy))}
                          {recordLine(
                            language.t("memory.manager.taxonomy"),
                            detail()
                              .taxonomy.map((node) => node.name)
                              .join(" / ") || "—",
                          )}
                        </div>
                      </TabsV2.Content>
                      <TabsV2.Content value="sources">
                        <Show when={state.secondaryLoading}>
                          <p>{language.t("memory.manager.loading")}</p>
                        </Show>
                        <Show when={state.secondaryError}>
                          <p role="alert">
                            {state.secondaryError}
                            <ButtonV2 size="small" variant="neutral" onClick={() => void loadSecondary()}>
                              {language.t("memory.manager.retry")}
                            </ButtonV2>
                          </p>
                        </Show>
                        <Show when={state.sources && state.sources.length === 0}>
                          <p class="text-text-weak">{language.t("memory.manager.noSources")}</p>
                        </Show>
                        <For each={state.sources ?? []}>
                          {(source) => (
                            <article class="mb-3 rounded-md border border-border-weak-base p-3 text-12-regular">
                              <div class="text-text-weak">
                                {source.kind} · {source.role} · {date(source.timestamp)}
                              </div>
                              <div class="text-text-weak">
                                {language.t("memory.manager.session")}: {shortMemoryID(source.sessionId)} ·{" "}
                                {language.t("memory.manager.project")}: {projectName(source.projectId)}
                              </div>
                              <p class="mt-2 whitespace-pre-wrap break-words text-text-base">{source.excerpt}</p>
                            </article>
                          )}
                        </For>
                      </TabsV2.Content>
                      <TabsV2.Content value="history">
                        <Show when={state.secondaryLoading}>
                          <p>{language.t("memory.manager.loading")}</p>
                        </Show>
                        <Show when={state.secondaryError}>
                          <p role="alert">
                            {state.secondaryError}
                            <ButtonV2 size="small" variant="neutral" onClick={() => void loadSecondary()}>
                              {language.t("memory.manager.retry")}
                            </ButtonV2>
                          </p>
                        </Show>
                        <Show when={state.history && state.history.versions.length === 0}>
                          <p>{language.t("memory.manager.noHistory")}</p>
                        </Show>
                        <For each={state.history?.versions ?? []}>
                          {(version) => (
                            <article class="mb-2 rounded-md border border-border-weak-base p-3 text-12-regular">
                              <div class="break-words text-text-strong">{version.summary}</div>
                              <div class="text-text-weak">
                                {shortMemoryID(version.id)} ·{" "}
                                {language.t(`memory.manager.${version.status}` as "memory.manager.active")} ·{" "}
                                {date(version.createdAt)}
                              </div>
                              <Show when={version.supersededBy}>
                                <div class="text-text-weak">→ {shortMemoryID(version.supersededBy)}</div>
                              </Show>
                            </article>
                          )}
                        </For>
                        <Show when={state.history?.audit.length}>
                          <h3 class="mb-2 text-12-medium">{language.t("memory.manager.audit")}</h3>
                          <For each={state.history?.audit ?? []}>
                            {(event) => (
                              <div class="border-b border-border-weak-base py-2 text-12-regular text-text-weak">
                                {event.action} · {date(event.timestamp)}
                              </div>
                            )}
                          </For>
                        </Show>
                      </TabsV2.Content>
                    </TabsV2>
                  </>
                )}
              </Show>
            </div>
          </Show>
        </div>
      </div>
    </section>
  )
}
