import { describe, expect, test } from "bun:test"
import { MEMORY_ENGLISH } from "../i18n/memory-fallback"
import { dict as russian } from "../i18n/ru"

describe("Memory Manager localization", () => {
  test("every Manager key has English and Russian copy", () => {
    const keys = Object.keys(MEMORY_ENGLISH).filter((key) => key.startsWith("memory.manager."))
    expect(keys.length).toBeGreaterThan(50)
    expect(keys.filter((key) => !MEMORY_ENGLISH[key as keyof typeof MEMORY_ENGLISH]?.trim())).toEqual([])
    expect(keys.filter((key) => !russian[key as keyof typeof russian]?.trim())).toEqual([])
  })
})
