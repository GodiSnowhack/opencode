import { createEffect, createSignal, onCleanup, Show } from "solid-js"
import { Icon } from "@opencode-ai/ui/icon"
import { TooltipV2 } from "@opencode-ai/ui/v2/tooltip-v2"
import { useLanguage } from "@/context/language"
import { usePlatform } from "@/context/platform"
import { memoryStatusEnabled, statusView } from "@/memory/status-view"

function VisibleMemoryStatus() {
  const platform = usePlatform()
  const language = useLanguage()
  const [now, setNow] = createSignal(Date.now())
  const snapshot = () => platform.memoryStatus!.snapshot()
  createEffect(() => {
    if (!statusView(snapshot(), Date.now()).active) return
    const timer = setInterval(() => setNow(Date.now()), 1_000)
    onCleanup(() => clearInterval(timer))
  })
  const view = () => statusView(snapshot(), now())
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
      <div
        tabindex="0"
        role="img"
        aria-label={label()}
        class="inline-flex max-w-full items-center gap-1 rounded px-1 text-12-regular text-text-weak focus-visible:outline focus-visible:outline-1 focus-visible:outline-border-strong-base"
      >
        <Icon name="brain" size="small" class="shrink-0" />
        <span class="truncate">{label()}</span>
        <Show when={view().queue > 0}>
          <span>{language.t("memory.status.queueSuffix", { count: view().queue })}</span>
        </Show>
        <Show when={view().elapsed}>
          <span>· {view().elapsed}</span>
        </Show>
      </div>
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
