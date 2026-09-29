import { ButtonV2 } from "@opencode-ai/ui/v2/button-v2"
import { Dialog, DialogBody, DialogFooter, DialogHeader, DialogTitle } from "@opencode-ai/ui/v2/dialog-v2"
import { Field } from "@opencode-ai/ui/v2/field-v2"
import { SelectV2 } from "@opencode-ai/ui/v2/select-v2"
import { TextareaV2 } from "@opencode-ai/ui/v2/textarea-v2"
import { TextInputV2 } from "@opencode-ai/ui/v2/text-input-v2"
import { For, Show } from "solid-js"
import { createStore } from "solid-js/store"
import type {
  ManagedMemory,
  ManagedProject,
  ManagedTaxonomyNode,
  ManagementContent,
  ManagementEdit,
  ManagementMerge,
  MemoryManagementMetadata,
  MemoryScope,
} from "@opencode-ai/core/memory/management-types"
import { useDialog } from "@opencode-ai/ui/context/dialog"
import { useLanguage } from "@/context/language"
import { compatibleMemory } from "@/memory/manager-model"

type SaveProps = {
  metadata: MemoryManagementMetadata
  projects: ManagedProject[]
  scope: MemoryScope
  projectId?: string
  memory?: ManagedMemory
  mergeCandidates?: ManagedMemory[]
  save(input: ManagementContent | ManagementEdit | ManagementMerge): Promise<void>
  errorText(error: unknown): string
}

export function MemorySaveDialog(props: SaveProps) {
  const language = useLanguage()
  const dialog = useDialog()
  const mode = props.mergeCandidates ? "merge" : props.memory ? "edit" : "create"
  const [form, setForm] = createStore({
    scope: props.memory?.scope ?? props.scope,
    projectId: props.memory?.projectId ?? props.projectId ?? "",
    type: props.memory?.type ?? props.metadata.types[props.scope]?.[0] ?? "",
    summary: props.memory?.summary ?? "",
    details: props.memory?.details ?? "",
    importance: props.memory?.importance ?? 0.7,
    confidence: props.memory?.confidence ?? 0.9,
    secondId: "",
    pending: false,
    confirmMerge: false,
    error: "",
  })
  const types = () => props.metadata.types[form.scope] ?? []
  const candidates = () =>
    props.mergeCandidates?.filter((candidate) => props.memory && compatibleMemory(props.memory, candidate)) ?? []
  const selectedProject = () => props.projects.find((project) => project.projectId === form.projectId)

  const submit = async (event: SubmitEvent) => {
    event.preventDefault()
    if (form.pending) return
    if (
      !form.summary.trim() ||
      !form.type ||
      (form.scope === "project" && !form.projectId) ||
      (mode === "merge" && !form.secondId)
    ) {
      setForm("error", language.t("memory.manager.required"))
      return
    }
    if (mode === "merge" && !form.confirmMerge) {
      setForm("confirmMerge", true)
      return
    }
    setForm("pending", true)
    setForm("error", "")
    try {
      if (mode === "merge") {
        await props.save({
          firstId: props.memory!.id,
          secondId: form.secondId,
          summary: form.summary.trim(),
          details: form.details,
          importance: form.importance,
          confidence: form.confidence,
        })
      } else if (mode === "edit") {
        await props.save({
          summary: form.summary.trim(),
          details: form.details,
          type: form.type,
          importance: form.importance,
          confidence: form.confidence,
        })
      } else {
        await props.save({
          scope: form.scope,
          projectId: form.scope === "global" ? null : form.projectId,
          type: form.type,
          summary: form.summary.trim(),
          details: form.details,
          importance: form.importance,
          confidence: form.confidence,
        })
      }
      dialog.close()
    } catch (error) {
      setForm("error", props.errorText(error))
    } finally {
      setForm("pending", false)
    }
  }

  return (
    <Dialog fit>
      <form class="contents" onSubmit={(event) => void submit(event)}>
        <DialogHeader>
          <DialogTitle>
            {language.t(
              mode === "merge"
                ? "memory.manager.merge"
                : mode === "edit"
                  ? "memory.manager.edit"
                  : "memory.manager.new",
            )}
          </DialogTitle>
        </DialogHeader>
        <DialogBody class="flex max-h-[min(650px,calc(100vh-140px))] w-full min-w-0 flex-col gap-4 overflow-y-auto px-4 py-4">
          <Show when={mode === "create"}>
            <Field>
              <Field.Label>{language.t("memory.manager.scope")}</Field.Label>
              <SelectV2
                options={props.metadata.scopes}
                current={form.scope}
                label={(value) => language.t(value === "global" ? "memory.manager.global" : "memory.manager.current")}
                onSelect={(value) => {
                  if (!value) return
                  setForm("scope", value)
                  setForm("type", props.metadata.types[value]?.[0] ?? "")
                }}
              />
            </Field>
            <Show when={form.scope === "project"}>
              <Field>
                <Field.Label>{language.t("memory.manager.project")}</Field.Label>
                <SelectV2
                  options={props.projects}
                  current={selectedProject()}
                  value={(project) => project.projectId}
                  label={(project) => project.name}
                  placeholder={language.t("memory.manager.chooseProject")}
                  onSelect={(project) => setForm("projectId", project?.projectId ?? "")}
                />
              </Field>
            </Show>
          </Show>
          <Show when={mode === "merge"}>
            <Show when={form.confirmMerge}>
              <p role="alert" class="text-12-regular text-text-weak">
                {language.t("memory.manager.mergePrompt")}
              </p>
            </Show>
            <Field>
              <Field.Label>{language.t("memory.manager.mergeWith")}</Field.Label>
              <SelectV2
                options={candidates()}
                current={candidates().find((item) => item.id === form.secondId)}
                value={(item) => item.id}
                label={(item) => item.summary}
                placeholder={language.t("memory.manager.chooseMemory")}
                onSelect={(item) => {
                  setForm("secondId", item?.id ?? "")
                  setForm("confirmMerge", false)
                }}
              />
            </Field>
          </Show>
          <Show when={mode === "create" || props.metadata.editableFields.includes("type")}>
            <Field>
              <Field.Label>{language.t("memory.manager.type")}</Field.Label>
              <SelectV2 options={types()} current={form.type} onSelect={(value) => value && setForm("type", value)} />
            </Field>
          </Show>
          <Field>
            <Field.Label>{language.t("memory.manager.summary")}</Field.Label>
            <TextInputV2
              class="!w-full"
              value={form.summary}
              maxLength={1000}
              required
              onInput={(event) => setForm("summary", event.currentTarget.value)}
            />
          </Field>
          <Field>
            <Field.Label>{language.t("memory.manager.details")}</Field.Label>
            <TextareaV2
              class="!w-full"
              value={form.details}
              maxLength={20000}
              rows={5}
              onInput={(event) => setForm("details", event.currentTarget.value)}
            />
          </Field>
          <For each={["importance", "confidence"] as const}>
            {(field) => (
              <Field>
                <Field.Label>
                  {language.t(field === "importance" ? "memory.manager.importance" : "memory.manager.confidence")} ·{" "}
                  {form[field].toFixed(2)}
                </Field.Label>
                <input
                  type="range"
                  min="0"
                  max="1"
                  step="0.01"
                  value={form[field]}
                  class="w-full accent-v2-icon-icon-base"
                  onInput={(event) => setForm(field, Number(event.currentTarget.value))}
                />
              </Field>
            )}
          </For>
          <Show when={form.error}>
            <p role="alert" class="text-12-regular text-v2-state-fg-danger">
              {form.error}
            </p>
          </Show>
        </DialogBody>
        <DialogFooter>
          <ButtonV2 type="button" variant="neutral" disabled={form.pending} onClick={() => dialog.close()}>
            {language.t("memory.manager.cancel")}
          </ButtonV2>
          <ButtonV2
            type="submit"
            variant="contrast"
            disabled={form.pending || (mode === "merge" && candidates().length === 0)}
          >
            {language.t(mode === "merge" && form.confirmMerge ? "memory.manager.confirm" : "memory.manager.save")}
          </ButtonV2>
        </DialogFooter>
      </form>
    </Dialog>
  )
}

export function MemoryConfirmDialog(props: {
  title: string
  message: string
  confirm(): Promise<void>
  errorText(error: unknown): string
}) {
  const language = useLanguage()
  const dialog = useDialog()
  const [state, setState] = createStore({ pending: false, error: "" })
  const confirm = async () => {
    if (state.pending) return
    setState("pending", true)
    try {
      await props.confirm()
      dialog.close()
    } catch (error) {
      setState("error", props.errorText(error))
    } finally {
      setState("pending", false)
    }
  }
  return (
    <Dialog fit>
      <DialogHeader>
        <DialogTitle>{props.title}</DialogTitle>
      </DialogHeader>
      <DialogBody class="px-4 py-4">
        <p class="text-14-regular text-text-base">{props.message}</p>
        <Show when={state.error}>
          <p role="alert" class="mt-3 text-12-regular text-v2-state-fg-danger">
            {state.error}
          </p>
        </Show>
      </DialogBody>
      <DialogFooter>
        <ButtonV2 variant="neutral" disabled={state.pending} onClick={() => dialog.close()}>
          {language.t("memory.manager.cancel")}
        </ButtonV2>
        <ButtonV2 variant="contrast" disabled={state.pending} onClick={() => void confirm()}>
          {language.t("memory.manager.confirm")}
        </ButtonV2>
      </DialogFooter>
    </Dialog>
  )
}

export function MemoryMoveDialog(props: {
  nodes: ManagedTaxonomyNode[]
  move(nodeId: string): Promise<void>
  errorText(error: unknown): string
}) {
  const language = useLanguage()
  const dialog = useDialog()
  const [state, setState] = createStore({ nodeId: "", pending: false, error: "" })
  const nodes = () => props.nodes.filter((node) => node.status !== "archived")
  const submit = async () => {
    if (!state.nodeId || state.pending) return
    setState("pending", true)
    try {
      await props.move(state.nodeId)
      dialog.close()
    } catch (error) {
      setState("error", props.errorText(error))
    } finally {
      setState("pending", false)
    }
  }
  return (
    <Dialog fit>
      <DialogHeader>
        <DialogTitle>{language.t("memory.manager.move")}</DialogTitle>
      </DialogHeader>
      <DialogBody class="px-4 py-4">
        <Field>
          <Field.Label>{language.t("memory.manager.taxonomy")}</Field.Label>
          <SelectV2
            options={nodes()}
            current={nodes().find((node) => node.id === state.nodeId)}
            value={(node) => node.id}
            label={(node) =>
              `${"  ".repeat(node.level === "domain" ? 0 : node.level === "topic" ? 1 : 2)}${node.displayName}`
            }
            placeholder={language.t("memory.manager.chooseNode")}
            onSelect={(node) => setState("nodeId", node?.id ?? "")}
          />
        </Field>
        <Show when={state.error}>
          <p role="alert" class="mt-3 text-12-regular text-v2-state-fg-danger">
            {state.error}
          </p>
        </Show>
      </DialogBody>
      <DialogFooter>
        <ButtonV2 variant="neutral" disabled={state.pending} onClick={() => dialog.close()}>
          {language.t("memory.manager.cancel")}
        </ButtonV2>
        <ButtonV2 variant="contrast" disabled={!state.nodeId || state.pending} onClick={() => void submit()}>
          {language.t("memory.manager.move")}
        </ButtonV2>
      </DialogFooter>
    </Dialog>
  )
}
