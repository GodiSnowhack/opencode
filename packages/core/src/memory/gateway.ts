import path from "node:path"
import { Hash } from "../util/hash"

export type Identity = {
  sessionID: string
  projectID: string
  projectRoot: string
  directory: string
  requestKind?: "user" | "title" | "compaction" | "summary" | "auxiliary"
}

export type Config = {
  enabled: boolean
  gatewayURL?: string
}

const loopback = (hostname: string) => hostname === "localhost" || hostname === "127.0.0.1" || hostname === "[::1]"
const absolute = (value: string) => path.posix.isAbsolute(value) || path.win32.isAbsolute(value)

function endpoint(value: string) {
  try {
    const url = new URL(value)
    if (url.protocol !== "http:" || !loopback(url.hostname) || url.username || url.password || url.search || url.hash)
      return undefined
    const pathname = url.pathname.replace(/\/+$/u, "").replace(/\/v1$/iu, "") || "/"
    return `${url.protocol}//${url.hostname === "localhost" ? "127.0.0.1" : url.hostname}:${url.port || "80"}${pathname}`
  } catch {
    return undefined
  }
}

const current = (): Config => ({
  enabled: process.env.OPENCODE_MEMORY_INTEGRATION === "true",
  gatewayURL: process.env.OPENCODE_MEMORY_GATEWAY_URL,
})

export function matches(url: string | undefined, config: Config = current()): boolean {
  if (!config.enabled || !config.gatewayURL || !url) return false
  const gateway = endpoint(config.gatewayURL)
  return gateway !== undefined && gateway === endpoint(url)
}

export function statusOrigin(config: Config = current()): string | undefined {
  if (!config.enabled || !config.gatewayURL || !endpoint(config.gatewayURL)) return undefined
  return new URL(config.gatewayURL).origin
}

export function headers(input: Identity & { endpoint?: string }, config: Config = current()): Record<string, string> {
  if (!matches(input.endpoint, config)) return {}
  const root = input.projectID === "global" ? input.directory : input.projectRoot
  if (!input.sessionID || !input.projectID || !absolute(root)) return {}
  const projectID =
    input.projectID === "global"
      ? `local-${Hash.sha256(path.win32.isAbsolute(root) ? path.win32.normalize(root).toLowerCase() : path.posix.normalize(root))}`
      : input.projectID
  return {
    "X-Memory-Session-Id": input.sessionID,
    "X-Memory-Project-Id": projectID,
    "X-Memory-Project-Root": root,
    ...(input.requestKind ? { "X-Memory-Request-Kind": input.requestKind } : {}),
  }
}

export * as MemoryGateway from "./gateway"
