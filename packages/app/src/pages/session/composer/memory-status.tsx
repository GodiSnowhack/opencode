import { Show } from "solid-js"
import { Icon } from "@opencode-ai/ui/icon"
import { ButtonV2 } from "@opencode-ai/ui/v2/button-v2"
import { TooltipV2 } from "@opencode-ai/ui/v2/tooltip-v2"
import { useLanguage } from "@/context/language"
import { usePlatform } from "@/context/platform"
import { memoryStatusEnabled, statusView } from "@/memory/status-view"

export function MemoryStatusButton(props: {
  label: string
  accessibleLabel: string
  expanded: boolean
  queue: number
  queueLabel: string
  elapsed: string
  onToggle(): void
}) {
  return (
    <ButtonV2
      size="small"
      variant="ghost-muted"
      data-component="memory-status"
      aria-controls="memory-panel"
      aria-expanded={props.expanded}
      aria-label={props.accessibleLabel}
      onClick={() => props.onToggle()}
      class="max-w-full min-w-0 !h-auto !min-h-0 !px-1 !py-0 text-12-regular text-text-weak"
    >
      <Icon name="brain" size="small" class="shrink-0" />
      <span class="truncate">{props.label}</span>
      <Show when={props.queue > 0}>
        <span>{props.queueLabel}</span>
      </Show>
      <Show when={props.elapsed}>
        <span>· {props.elapsed}</span>
      </Show>
    </ButtonV2>
  )
}

function VisibleMemoryStatus() {
  const platform = usePlatform()
  const language = useLanguage()
  const snapshot = () => platform.memoryStatus!.snapshot()
  const view = () => statusView(snapshot(), platform.memoryStatus!.now())
  const label = () => language.t(view().key)

  return (
    <TooltipV2
      placement="top"
      value={
        <div class="flex flex-col gap-0.5 text-xs">
          <div>
            {language.t("memory.status.tooltip.gateway", {
              state: language.t(snapshot().connected ? "memory.status.connected" : "memory.status.offlineValue"),
            })}
          </div>
          <Show when={snapshot().status}>
            {(status) => (
              <>
                <div>{language.t("memory.status.tooltip.state", { state: status().state })}</div>
                <div>{language.t("memory.status.tooltip.phase", { phase: status().phase })}</div>
                <div>{language.t("memory.status.tooltip.queue", { count: view().queue })}</div>
                <div>{language.t("memory.status.tooltip.processed", { count: status().processedItems })}</div>
                <Show when={view().elapsed}>
                  <div>{language.t("memory.status.tooltip.elapsed", { elapsed: view().elapsed })}</div>
                </Show>
                <Show when={status().error}>
                  <div>{language.t("memory.status.tooltip.error")}</div>
                </Show>
                <Show when={status().degradedReasons.length}>
                  <div>{language.t("memory.status.tooltip.degraded", { count: status().degradedReasons.length })}</div>
                </Show>
              </>
            )}
          </Show>
        </div>
      }
    >
      <MemoryStatusButton
        label={label()}
        accessibleLabel={language.t("memory.panel.open", { status: label() })}
        expanded={platform.memoryStatus!.panel.opened()}
        queue={view().queue}
        queueLabel={language.t("memory.status.queueSuffix", { count: view().queue })}
        elapsed={view().elapsed}
        onToggle={() => platform.memoryStatus!.panel.toggle()}
      />
    </TooltipV2>
  )
}

export function MemoryStatus() {
  const platform = usePlatform()
  return (
    <Show when={memoryStatusEnabled(platform.memoryStatus)}>
      <div class="flex justify-end pt-0.5">
        <VisibleMemoryStatus />
      </div>
    </Show>
  )
}
