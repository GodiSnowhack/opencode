import type { UsageRange, UsageSnapshot } from "@opencode-ai/core/usage/types"

export const usageKinds = ["agent", "memory", "service"] as const
export const usageRanges = [7, 30, 90, "all"] as const
export function usageShare(tokens: number, total: number) {
  return total > 0 ? (tokens / total) * 100 : 0
}
export function usageChart(snapshot: UsageSnapshot, range: UsageRange) {
  if (range === "all") {
    if (snapshot.daily.length <= 366) return snapshot.daily
    const months = new Map<string, { day: string; total: number; requests: number }>()
    snapshot.daily.forEach((item) => {
      const day = item.day.slice(0, 7)
      const previous = months.get(day) ?? { day, total: 0, requests: 0 }
      previous.total += item.total
      previous.requests += item.requests
      months.set(day, previous)
    })
    return [...months.values()]
  }
  const byDay = new Map(snapshot.daily.map((item) => [item.day, item]))
  return Array.from({ length: range }, (_, index) => {
    const date = new Date(`${snapshot.today}T00:00:00Z`)
    date.setUTCDate(date.getUTCDate() - range + 1 + index)
    const day = date.toISOString().slice(0, 10)
    return byDay.get(day) ?? { day, total: 0, requests: 0 }
  })
}
