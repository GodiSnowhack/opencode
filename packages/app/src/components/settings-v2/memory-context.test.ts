import { expect, test } from "bun:test"
import { contextMismatch, contextPresets, contextWarning } from "./memory"

test("managed context presets use binary token limits", () => {
  expect(contextPresets).toEqual([8192, 16384, 32768, 49152, 65536, 98304, 131072, 262144])
})

test("runtime mismatch and large context guidance are distinguished", () => {
  expect(contextMismatch(65536, 32768)).toBe(true)
  expect(contextMismatch(65536, 65536)).toBe(false)
  expect(contextMismatch(131072, 40960, 40960)).toBe(false)
  expect(contextMismatch(131072, 32768, 40960)).toBe(true)
  expect(contextMismatch(65536)).toBe(false)
  expect(contextWarning(65536)).toBe("memory.settings.contextLarge")
  expect(contextWarning(262144)).toBe("memory.settings.contextExperimental")
  expect(contextWarning(32768)).toBeUndefined()
})
