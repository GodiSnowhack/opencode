import { expect, test } from "bun:test"
import { missingManagedModel } from "./local-model-availability"

test("removed managed agent model requires reselection while other providers keep their behavior", () => {
  const removed = { providerID: "memory-local", modelID: "gemma4:26b-a4b-it-q4_K_M" }
  expect(missingManagedModel(removed, () => false)).toBe(removed.modelID)
  expect(missingManagedModel(removed, () => true)).toBeUndefined()
  expect(missingManagedModel({ providerID: "cloud", modelID: "model" }, () => false)).toBeUndefined()
})
