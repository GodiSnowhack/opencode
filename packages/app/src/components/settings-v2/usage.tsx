import { For, Show, createMemo, createResource, onCleanup, onMount } from "solid-js"
import { createStore } from "solid-js/store"
import { ButtonV2 } from "@opencode-ai/ui/v2/button-v2"
import { useDialog } from "@opencode-ai/ui/context/dialog"
import { useLanguage } from "@/context/language"
import { usePlatform } from "@/context/platform"
import { MemoryConfirmDialog } from "@/pages/session/memory-manager-dialogs"
import { usageChart, usageKinds, usageRanges, usageShare } from "@/usage/model"
import type { UsageRange } from "@opencode-ai/core/usage/types"
import "./usage.css"

export function SettingsUsageV2() {
  const language = useLanguage()
  const platform = usePlatform()
  const dialog = useDialog()
  const [state, setState] = createStore({ tab: "overview", range: 30 as UsageRange })
  const [snapshot, { refetch }] = createResource(
    () => state.range,
    (range) => platform.usage!.get(range),
  )
  const number = (value: number) => new Intl.NumberFormat(language.intl(), { maximumFractionDigits: 1 }).format(value)
  const date = (value: number | string) =>
    new Intl.DateTimeFormat(language.intl(), { dateStyle: "medium" }).format(
      typeof value === "string" ? new Date(`${value}T12:00:00`) : value,
    )
  const chart = createMemo(() => (snapshot() ? usageChart(snapshot()!, state.range) : []))
  const maximum = createMemo(() => Math.max(1, ...chart().map((item) => item.total)))
  const periodKeys = { 7: "usage.days7", 30: "usage.days30", 90: "usage.days90", all: "usage.all" } as const
  const kindKeys = { agent: "usage.agent", memory: "usage.memory", service: "usage.service" } as const
  const overview = createMemo(() => {
    const value = snapshot()
    if (!value) return []
    return [
      { key: "usage.total", value: number(value.overview.total) },
      { key: "usage.today", value: number(value.todayTokens) },
      {
        key: "usage.record",
        value: number(value.record?.total ?? 0),
        detail: value.record ? date(value.record.day) : undefined,
      },
      { key: "usage.requests", value: number(value.overview.requests) },
      { key: "usage.sessions", value: number(value.overview.sessions) },
      { key: "usage.averageInput", value: number(value.overview.averageInput) },
      { key: "usage.averageOutput", value: number(value.overview.averageOutput) },
      { key: "usage.averageSession", value: number(value.overview.averageSession) },
      { key: "usage.maximumRequest", value: number(value.overview.maximumRequest) },
      { key: "usage.maximumSession", value: number(value.overview.maximumSession) },
      { key: "usage.generationTime", value: number(value.overview.generationMs / 1000) },
      {
        key: "usage.speed",
        value:
          value.overview.tokensPerSecond === null
            ? language.t("usage.unknownValue")
            : number(value.overview.tokensPerSecond),
      },
    ] as const
  })
  let timer: ReturnType<typeof setInterval> | undefined
  onMount(() => {
    timer = setInterval(() => {
      if (!snapshot.loading) void refetch()
    }, 10000)
  })
  onCleanup(() => clearInterval(timer))
  const clear = () =>
    dialog.show(() => (
      <MemoryConfirmDialog
        title={language.t("usage.clear")}
        message={language.t("usage.clearConfirm")}
        errorText={() => language.t("usage.error")}
        confirm={async () => {
          await platform.usage!.clear(true)
          await refetch()
        }}
      />
    ))
  return (
    <div data-component="local-usage" class="usage-panel">
      <div class="settings-v2-tab-header">
        <h2 class="settings-v2-tab-title">{language.t("usage.title")}</h2>
      </div>
      <div class="settings-v2-tab-body">
        <p class="usage-muted">{language.t("usage.privacy")}</p>
        <p class="usage-muted">{language.t("usage.coverage")}</p>
        <div class="usage-controls" role="tablist" aria-label={language.t("usage.title")}>
          <For each={["overview", "models"] as const}>
            {(tab) => (
              <ButtonV2
                role="tab"
                aria-selected={state.tab === tab}
                variant={state.tab === tab ? "contrast" : "neutral"}
                onClick={() => setState("tab", tab)}
              >
                {language.t(tab === "overview" ? "usage.overview" : "usage.models")}
              </ButtonV2>
            )}
          </For>
          <ButtonV2 variant="neutral" disabled={snapshot.loading} onClick={() => void refetch()}>
            {language.t("usage.refresh")}
          </ButtonV2>
        </div>
        <Show when={snapshot.error}>
          <p role="alert">{language.t("usage.error")}</p>
        </Show>
        <Show when={snapshot()}>
          {(value) => (
            <>
              <p class="usage-muted">{language.t("usage.since", { date: date(value().collectedSince) })}</p>
              <Show when={!value().overview.requests}>
                <p>{language.t("usage.empty")}</p>
              </Show>
              <Show when={value().overview.unknown}>
                <p class="usage-muted">{language.t("usage.unknown", { count: value().overview.unknown })}</p>
              </Show>
              <Show when={state.tab === "overview"}>
                <section data-testid="usage-overview" class="usage-grid">
                  <For each={overview()}>
                    {(metric) => (
                      <div class="usage-card">
                        <span class="usage-muted">{language.t(metric.key)}</span>
                        <strong title={metric.value}>{metric.value}</strong>
                        <Show when={"detail" in metric && metric.detail}>
                          <span class="usage-muted">{"detail" in metric ? metric.detail : undefined}</span>
                        </Show>
                      </div>
                    )}
                  </For>
                </section>
                <div class="usage-controls">
                  <For each={usageRanges}>
                    {(range) => (
                      <ButtonV2
                        variant={state.range === range ? "contrast" : "neutral"}
                        aria-pressed={state.range === range}
                        onClick={() => setState("range", range)}
                      >
                        {language.t(periodKeys[range])}
                      </ButtonV2>
                    )}
                  </For>
                </div>
                <section aria-label={language.t("usage.history")}>
                  <h3>{language.t("usage.history")}</h3>
                  <svg
                    role="img"
                    aria-label={language.t("usage.history")}
                    viewBox="0 0 640 160"
                    width="100%"
                    class="usage-chart"
                  >
                    <For each={chart()}>
                      {(item, index) => (
                        <rect
                          x={(index() * 640) / chart().length}
                          y={150 - (item.total / maximum()) * 145}
                          width={Math.max(0.5, 640 / chart().length - 1)}
                          height={(item.total / maximum()) * 145}
                        >
                          <title>
                            {item.day}: {number(item.total)}
                          </title>
                        </rect>
                      )}
                    </For>
                  </svg>
                  <div class="usage-chart-labels">
                    <span>{chart()[0]?.day}</span>
                    <span>{chart().at(-1)?.day}</span>
                  </div>
                </section>
              </Show>
              <Show when={state.tab === "models"}>
                <section data-testid="usage-models" class="usage-models">
                  <For each={usageKinds}>
                    {(kind) => {
                      const models = () => value().models.filter((model) => model.kind === kind)
                      const total = () => models().reduce((sum, model) => sum + model.total, 0)
                      return (
                        <div>
                          <h3>
                            {language.t(kindKeys[kind])} · {number(usageShare(total(), value().overview.total))}%
                          </h3>
                          <For each={models()}>
                            {(model) => (
                              <article class="usage-card">
                                <strong class="usage-model-name">{model.model}</strong>
                                <span class="usage-muted">{model.provider}</span>
                                <dl class="usage-grid">
                                  <For
                                    each={
                                      [
                                        ["usage.total", number(model.total)],
                                        ["usage.input", number(model.input)],
                                        ["usage.output", number(model.output)],
                                        ["usage.requests", number(model.requests)],
                                        ["usage.share", `${number(usageShare(model.total, value().overview.total))}%`],
                                        [
                                          "usage.speed",
                                          model.tokensPerSecond === null
                                            ? language.t("usage.unknownValue")
                                            : number(model.tokensPerSecond),
                                        ],
                                      ] as const
                                    }
                                  >
                                    {(metric) => (
                                      <div>
                                        <dt class="usage-muted">{language.t(metric[0])}</dt>
                                        <dd>{metric[1]}</dd>
                                      </div>
                                    )}
                                  </For>
                                </dl>
                                <Show when={model.unknown}>
                                  <p class="usage-muted">{language.t("usage.unknown", { count: model.unknown })}</p>
                                </Show>
                              </article>
                            )}
                          </For>
                        </div>
                      )
                    }}
                  </For>
                </section>
              </Show>
            </>
          )}
        </Show>
        <ButtonV2 variant="neutral" onClick={() => void clear()} disabled={snapshot.loading}>
          {language.t("usage.clear")}
        </ButtonV2>
      </div>
    </div>
  )
}
