export type OllamaChatModel = {
  id: string
  name: string
  context?: number
  tools: boolean
  thinking: boolean
  vision: boolean
}

type TaggedModel = { name?: unknown; digest?: unknown }

function object(value: unknown): value is Record<string, unknown> {
  return !!value && typeof value === "object" && !Array.isArray(value)
}

function contextLength(value: unknown): number | undefined {
  if (!object(value)) return undefined
  const found = Object.entries(value).find(
    ([key, item]) => key.endsWith(".context_length") && typeof item === "number" && Number.isInteger(item) && item > 0,
  )?.[1]
  return typeof found === "number" ? found : undefined
}

export function ollamaChatModel(id: string, value: unknown): OllamaChatModel | undefined {
  if (!object(value) || !Array.isArray(value.capabilities)) return undefined
  const capabilities = value.capabilities.filter((item): item is string => typeof item === "string")
  if (!capabilities.includes("completion")) return undefined
  return {
    id,
    name: id,
    context: contextLength(value.model_info),
    tools: capabilities.includes("tools"),
    thinking: capabilities.includes("thinking"),
    vision: capabilities.includes("vision"),
  }
}

export class OllamaModelInventory {
  private cache = new Map<string, { digest: string; model?: OllamaChatModel }>()
  private last: OllamaChatModel[] = []

  get chatModels() {
    return this.last
  }

  async refresh(request: typeof fetch = fetch) {
    const response = await request("http://127.0.0.1:11434/api/tags", {
      signal: AbortSignal.timeout(3000),
      redirect: "error",
      cache: "no-store",
    })
    if (!response.ok) throw new Error("ollama_unavailable")
    const data: unknown = await response.json()
    if (!object(data) || !Array.isArray(data.models)) throw new Error("invalid_ollama_tags")
    const tags = data.models.map((item): TaggedModel => (object(item) ? item : {}))
    if (tags.some((tag) => typeof tag.name !== "string" || !tag.name)) throw new Error("invalid_ollama_tags")
    const names = tags.flatMap((tag) => (typeof tag.name === "string" ? [tag.name] : []))
    const nextCache = new Map<string, { digest: string; model?: OllamaChatModel }>()
    const chatModels = await Promise.all(
      tags.map(async (tag) => {
        if (typeof tag.name !== "string" || !tag.name) throw new Error("invalid_ollama_tags")
        const digest = typeof tag.digest === "string" ? tag.digest : ""
        const cached = this.cache.get(tag.name)
        if (cached && digest && cached.digest === digest) {
          nextCache.set(tag.name, cached)
          return cached.model
        }
        const shown = await request("http://127.0.0.1:11434/api/show", {
          method: "POST",
          headers: { "content-type": "application/json" },
          body: JSON.stringify({ model: tag.name }),
          signal: AbortSignal.timeout(3000),
          redirect: "error",
        })
        if (!shown.ok) throw new Error("ollama_show_unavailable")
        const details = await shown.json()
        if (!object(details) || !Array.isArray(details.capabilities)) throw new Error("invalid_ollama_show")
        const model = ollamaChatModel(tag.name, details)
        nextCache.set(tag.name, { digest, model })
        return model
      }),
    )
    this.cache = nextCache
    this.last = chatModels.filter((model): model is OllamaChatModel => !!model)
    return { names, chatModels: this.last }
  }
}
