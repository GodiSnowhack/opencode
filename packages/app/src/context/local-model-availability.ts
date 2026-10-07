type ModelKey = { providerID: string; modelID: string }

export function missingManagedModel(model: ModelKey | undefined, valid: (model: ModelKey) => boolean) {
  if (!model || model.providerID !== "memory-local" || valid(model)) return undefined
  return model.modelID
}
