import { expect, test } from "bun:test"
import { usageChart, usageShare } from "./model"
import type { UsageSnapshot } from "@opencode-ai/core/usage/types"
const snapshot = {
  today: "2026-10-09",
  daily: [
    { day: "2026-10-08", total: 10, requests: 1 },
    { day: "2026-10-09", total: 20, requests: 2 },
  ],
} as UsageSnapshot
test("7/30/90 day chart fills calendar gaps and includes today", () => {
  for (const range of [7, 30, 90] as const) {
    const chart = usageChart(snapshot, range)
    expect(chart).toHaveLength(range)
    expect(chart.at(-1)).toEqual(snapshot.daily[1])
    expect(chart.reduce((sum, item) => sum + item.total, 0)).toBe(30)
  }
})
test("all-time chart keeps exact daily counts and adapts long histories to months", () => {
  expect(usageChart(snapshot, "all")).toEqual(snapshot.daily)
  const daily = Array.from({ length: 400 }, (_, index) => ({
    day: new Date(Date.UTC(2025, 0, index + 1)).toISOString().slice(0, 10),
    total: 3,
    requests: 1,
  }))
  const chart = usageChart({ ...snapshot, daily }, "all")
  expect(chart.length).toBeLessThan(15)
  expect(chart.reduce((sum, item) => sum + item.total, 0)).toBe(1200)
})
test("shares use global total including memory and service; empty data is zero", () => {
  expect(usageShare(72, 100)).toBe(72)
  expect(usageShare(24, 100)).toBe(24)
  expect(usageShare(0, 0)).toBe(0)
  expect(usageChart({ ...snapshot, daily: [] }, 7).every((item) => item.total === 0)).toBe(true)
})
