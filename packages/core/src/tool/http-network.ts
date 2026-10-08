import { lookup } from "node:dns/promises"
import { isIP } from "node:net"
import http from "node:http"
import https from "node:https"

export class HttpError extends Error {
  constructor(readonly code: string) {
    super(code)
    this.name = "HttpError"
  }
}
export type Address = { address: string; family: number }
export function addressRisk(address: string): "public" | "internal" | "blocked" {
  if (isIP(address) === 4) {
    const [a, b, c, d] = address.split(".").map(Number)
    if (a === 0 || a >= 224 || (a === 169 && b === 254) || (a === 100 && b >= 64 && b <= 127)) return "blocked"
    if (a === 127 || a === 10 || (a === 172 && b >= 16 && b <= 31) || (a === 192 && b === 168)) return "internal"
    if ((a === 192 && b === 0 && c === 0) || (a === 198 && (b === 18 || b === 19)) || (a === 255 && d === 255))
      return "blocked"
    return "public"
  }
  if (isIP(address) !== 6) return "blocked"
  const expanded = new URL(`http://[${address}]/`).hostname.slice(1, -1).toLowerCase()
  if (expanded === "::") return "blocked"
  if (expanded === "::1") return "internal"
  // IPv4 translations/mappings, multicast, link/site-local and non-global IPv6 fail closed.
  if (!/^[23][0-9a-f]{3}:/u.test(expanded)) return /^f[cd][0-9a-f]{2}:/u.test(expanded) ? "internal" : "blocked"
  if (/^(?:2001:(?:0:|:|db8:)|2002:)/u.test(expanded)) return "blocked" // Teredo, documentation and 6to4.
  return "public"
}
export function normalizeHttpUrl(value: string) {
  try {
    if (value.length > 4096 || /[\x00-\x20\\]/u.test(value)) throw new Error()
    const url = new URL(value)
    if (!/^https?:$/u.test(url.protocol) || url.username || url.password || url.hash) throw new Error()
    if (!url.hostname || url.hostname.endsWith(".")) throw new Error()
    return url
  } catch {
    throw new HttpError("INVALID_URL")
  }
}
export async function resolveEndpoint(
  url: URL,
  signal: AbortSignal,
  resolver: (hostname: string, options: { all: true; verbatim: true }) => Promise<Address[]> = lookup,
): Promise<Address[]> {
  signal.throwIfAborted()
  const host = url.hostname.replace(/^\[|\]$/gu, "")
  if (
    /^(?:metadata|metadata\.google\.internal)$/iu.test(host) ||
    host.endsWith(".localhost") ||
    host.endsWith(".local")
  )
    throw new HttpError("BLOCKED_ADDRESS")
  const addresses = isIP(host)
    ? [{ address: host, family: isIP(host) }]
    : await new Promise<Address[]>((resolve, reject) => {
        const abort = () => reject(signal.reason)
        signal.addEventListener("abort", abort, { once: true })
        if (signal.aborted) abort()
        resolver(host, { all: true, verbatim: true })
          .then(resolve, reject)
          .finally(() => signal.removeEventListener("abort", abort))
      })
  signal.throwIfAborted()
  if (!addresses.length) throw new HttpError("DNS_FAILURE")
  if (addresses.some((item) => addressRisk(item.address) === "blocked")) throw new HttpError("BLOCKED_ADDRESS")
  const internal = addresses.some((item) => addressRisk(item.address) === "internal")
  if (internal) {
    const ports = [22, 25, 53, 135, 139, 445, 2375, 2376, 3306, 5432, 6379, 9222, 11211, 11434, 11435, 11436]
    for (const endpoint of [process.env.OPENCODE_MEMORY_GATEWAY_URL, process.env.OLLAMA_BASE_URL]) {
      if (endpoint) {
        try {
          ports.push(Number(new URL(endpoint).port || "80"))
        } catch {
          /* Not a trusted endpoint. */
        }
      }
    }
    if (ports.includes(Number(url.port || (url.protocol === "https:" ? 443 : 80))))
      throw new HttpError("BLOCKED_ADDRESS")
  }
  return addresses
}

export type WireResponse = {
  status: number
  statusText: string
  headers: Record<string, string>
  body: Buffer
  truncated: boolean
  bytes: number
}
/** Direct transport: no inherited proxy, redirects, pooled socket or second DNS lookup. */
export function pinnedRequest(
  url: URL,
  address: Address,
  method: string,
  headers: Record<string, string>,
  body: string | undefined,
  signal: AbortSignal,
): Promise<WireResponse> {
  return new Promise((resolve, reject) => {
    if (signal.aborted) {
      reject(signal.reason)
      return
    }
    // Bun's Node compatibility socket has no remoteAddress. Connect to a literal
    // pinned IP, retain the virtual host/SNI, and refuse ambient proxy routing.
    if (
      ["HTTP_PROXY", "HTTPS_PROXY", "ALL_PROXY", "http_proxy", "https_proxy", "all_proxy"].some(
        (key) => process.env[key],
      )
    ) {
      reject(new HttpError("PROXY_UNSUPPORTED"))
      return
    }
    const target = new URL(url)
    target.hostname = address.family === 6 ? `[${address.address}]` : address.address
    const req = (url.protocol === "https:" ? https : http).request(
      target,
      {
        method,
        headers: { ...headers, host: url.host },
        servername: url.hostname.replace(/^\[|\]$/gu, ""),
        agent: false,
        signal,
        maxHeaderSize: 8192,
        rejectUnauthorized: true,
        lookup: (_hostname, options, callback) => {
          if (options.all) callback(null, [address])
          else callback(null, address.address, address.family)
        },
      },
      (res) => {
        const peer = res.socket.remoteAddress?.replace(/^::ffff:/u, "")
        const expected = address.address.replace(/^::ffff:/u, "")
        if ((!peer && !process.versions.bun) || (peer && peer !== expected)) {
          signal.removeEventListener("abort", abort)
          res.destroy()
          req.destroy()
          reject(new HttpError("BLOCKED_ADDRESS"))
          return
        }
        const chunks: Buffer[] = []
        let bytes = 0
        let settled = false
        const finish = (truncated: boolean) => {
          if (settled) return
          settled = true
          signal.removeEventListener("abort", abort)
          resolve({
            status: res.statusCode ?? 0,
            statusText: res.statusMessage ?? "",
            headers: Object.fromEntries(
              Object.entries(res.headers).map(([key, value]) => [
                key,
                Array.isArray(value) ? value.join(", ") : (value ?? ""),
              ]),
            ),
            body: Buffer.concat(chunks),
            truncated,
            bytes,
          })
        }
        res.on("data", (chunk: Buffer) => {
          const remaining = 8192 - bytes
          chunks.push(chunk.subarray(0, Math.max(0, remaining)))
          bytes += chunk.length
          if (bytes > 8192) {
            finish(true)
            res.destroy()
            req.destroy()
          }
        })
        res.on("end", () => finish(false))
        res.on("error", (error) => {
          signal.removeEventListener("abort", abort)
          if (!settled) reject(error)
        })
      },
    )
    const abort = () => {
      req.destroy()
      signal.removeEventListener("abort", abort)
      reject(signal.reason)
    }
    signal.addEventListener("abort", abort, { once: true })
    if (signal.aborted) abort()
    req.on("error", (error) => {
      signal.removeEventListener("abort", abort)
      reject(error)
    })
    req.end(body)
  })
}
