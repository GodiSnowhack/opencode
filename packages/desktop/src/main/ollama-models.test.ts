import { expect, test } from "bun:test"
import { OllamaModelInventory } from "./ollama-models"

test("Ollama inventory discovers chat capabilities, filters embeddings, and tracks add/remove", async () => {
  const inventory = new OllamaModelInventory()
  const details: Record<string, { capabilities: string[]; model_info: Record<string, number> }> = {
    "qwen3:8b": { capabilities: ["completion", "tools", "thinking"], model_info: { "qwen3.context_length": 40960 } },
    "qwen3-coder:30b": { capabilities: ["completion", "tools"], model_info: { "qwen3moe.context_length": 262144 } },
    "gemma4:26b-a4b-it-q4_K_M": {
      capabilities: ["completion", "tools", "thinking", "vision"],
      model_info: { "gemma4.context_length": 262144 },
    },
    "nomic-embed-text:latest": { capabilities: ["embedding"], model_info: { "nomic.context_length": 8192 } },
  }
  let names = Object.keys(details)
  let showCount = 0
  const request = (async (input: string | URL | Request, init?: RequestInit) => {
    const url = input instanceof Request ? input.url : input instanceof URL ? input.href : input
    if (url.endsWith("/api/tags")) return Response.json({ models: names.map((name) => ({ name, digest: name })) })
    if (url.endsWith("/api/show")) {
      showCount++
      if (typeof init?.body !== "string") throw new Error("missing_model")
      const body: unknown = JSON.parse(init.body)
      if (!body || typeof body !== "object" || !("model" in body) || typeof body.model !== "string")
        throw new Error("missing_model")
      const name = body.model
      return Response.json(details[name])
    }
    throw new Error("unexpected_request")
  }) as typeof fetch
  const first = await inventory.refresh(request)
  expect(first.names).toContain("nomic-embed-text:latest")
  expect(first.chatModels.map((model) => model.id)).toEqual(names.slice(0, 3))
  expect(first.chatModels[0]?.context).toBe(40960)
  expect(first.chatModels[1]?.context).toBe(262144)
  expect(first.chatModels[2]?.vision).toBe(true)
  expect(first.chatModels[2]?.tools).toBe(true)
  await inventory.refresh(request)
  expect(showCount).toBe(4)
  names = names.filter((name) => name !== "qwen3-coder:30b")
  expect((await inventory.refresh(request)).chatModels.map((model) => model.id)).not.toContain("qwen3-coder:30b")
  names.push("new-chat:latest")
  details["new-chat:latest"] = { capabilities: ["completion"], model_info: { "new.context_length": 16384 } }
  expect((await inventory.refresh(request)).chatModels.map((model) => model.id)).toContain("new-chat:latest")
})

test("temporary Ollama discovery failure keeps last-known-good chat catalog", async () => {
  const inventory = new OllamaModelInventory()
  const good = (async (input: string | URL | Request) =>
    (input instanceof Request ? input.url : input instanceof URL ? input.href : input).endsWith("/api/tags")
      ? Response.json({ models: [{ name: "qwen3:8b", digest: "first" }] })
      : Response.json({ capabilities: ["completion"], model_info: { "qwen3.context_length": 40960 } })) as typeof fetch
  await inventory.refresh(good)
  await expect(
    inventory.refresh((async () => {
      throw new Error("offline")
    }) as typeof fetch),
  ).rejects.toThrow("offline")
  expect(inventory.chatModels.map((model) => model.id)).toEqual(["qwen3:8b"])
})
