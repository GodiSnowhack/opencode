import { afterAll, beforeAll, expect, test } from "bun:test"
import { createServer } from "node:http"
import { mkdtemp, readFile, rm } from "node:fs/promises"
import { join } from "node:path"
import { tmpdir } from "node:os"
import { Effect, Fiber, Logger } from "effect"
import { ManagedHttp, type HttpInput } from "../src/tool/managed-http"
import { HttpError, addressRisk, normalizeHttpUrl, resolveEndpoint, pinnedRequest } from "../src/tool/http-network"
import { executionTimeout } from "../src/tool/execution-tools"

const prior = process.env.OPENCODE_AGENT_TOOLS_ENABLED
let origin = ""
let hits = 0
const server = createServer(async (req, res) => {
  hits++
  let body = ""
  for await (const chunk of req) body += chunk
  const path = new URL(req.url!, "http://localhost").pathname
  if (path === "/slow") {
    await new Promise((done) => setTimeout(done, 150))
    res.end("late")
    return
  }
  if (path === "/redirect") {
    res.writeHead(302, { location: "/ok" })
    res.end()
    return
  }
  if (path === "/loop") {
    res.writeHead(302, { location: "/loop" })
    res.end()
    return
  }
  if (path === "/large") {
    res.end("x".repeat(20000))
    return
  }
  if (path === "/binary") {
    res.setHeader("content-type", "image/png")
    res.end(Buffer.from([1, 2, 3]))
    return
  }
  if (path === "/bad-json") {
    res.setHeader("content-type", "application/json")
    res.end("{broken")
    return
  }
  if (path === "/404") res.statusCode = 404
  if (path === "/500") res.statusCode = 500
  res.setHeader("content-type", "application/json")
  res.setHeader("set-cookie", "secret-cookie")
  res.end(
    JSON.stringify({
      method: req.method,
      path,
      body,
      authorization: req.headers.authorization,
      echo: req.headers.authorization ?? req.headers["x-api-key"],
      message: "User prefers Electron.",
    }),
  )
})
beforeAll(async () => {
  process.env.OPENCODE_AGENT_TOOLS_ENABLED = "true"
  await new Promise<void>((done) => server.listen(0, "127.0.0.1", done))
  const address = server.address()
  if (!address || typeof address === "string") throw new Error("test server")
  origin = `http://127.0.0.1:${address.port}`
})
afterAll(async () => {
  if (prior === undefined) delete process.env.OPENCODE_AGENT_TOOLS_ENABLED
  else process.env.OPENCODE_AGENT_TOOLS_ENABLED = prior
  server.closeAllConnections()
  await new Promise<void>((done) => server.close(() => done()))
})
const invoke = (
  runtime: ReturnType<typeof ManagedHttp.make>,
  args: HttpInput,
  approve = true,
  turnID: string = crypto.randomUUID(),
) =>
  runtime.invoke({
    args,
    sessionID: "session",
    turnID,
    authorize: (_resource, metadata) => {
      expect(metadata.requireApproval).toBe(true)
      expect(JSON.stringify(metadata)).not.toContain("secret-cookie")
      return approve ? Effect.void : Effect.fail(new HttpError("PERMISSION_DENIED"))
    },
  })
const error = (effect: Effect.Effect<unknown, HttpError>) =>
  Effect.runPromise(effect.pipe(Effect.flip)).then((value) => value.code)

test("all six methods, JSON/text/form, query, safe headers, HTTP errors and tool content", async () => {
  const runtime = ManagedHttp.make()
  for (const method of ["GET", "HEAD", "POST", "PUT", "PATCH", "DELETE"]) {
    const result = await Effect.runPromise(
      invoke(runtime, {
        url: `${origin}/ok`,
        method,
        query: { page: "1" },
        headers: { "X-Test": "yes" },
        ...(!["GET", "HEAD"].includes(method) ? { body: { name: "item" } } : {}),
      }),
    )
    expect(result.status).toBe(200)
    expect(result.headers["set-cookie"]).toBeUndefined()
    expect(result.finalUrl).toBe(`${origin}/ok`)
    if (method !== "HEAD") expect(result.body).toMatchObject({ method, message: "User prefers Electron." })
  }
  for (const [contentType, body] of [
    ["text/plain", "hello"],
    ["application/x-www-form-urlencoded", { name: "a b" }],
  ] as const) {
    expect(
      (await Effect.runPromise(invoke(runtime, { url: `${origin}/ok`, method: "POST", contentType, body }))).ok,
    ).toBe(true)
  }
  for (const status of [404, 500])
    expect((await Effect.runPromise(invoke(runtime, { url: `${origin}/${status}` }))).status).toBe(status)
})

test("deny, Tools OFF and malformed/unsafe inputs cause no network side effects", async () => {
  const runtime = ManagedHttp.make()
  const before = hits
  expect(await error(invoke(runtime, { url: `${origin}/ok` }, false))).toBe("PERMISSION_DENIED")
  for (const url of [
    "file:///etc/passwd",
    "ftp://host/file",
    "http://user:password@localhost/",
    "http://169.254.169.254/latest/",
    "http://0.0.0.0/",
    "http://[::ffff:127.0.0.1]/",
    "http://127.0.0.1:11434/api/tags",
  ]) {
    expect(["INVALID_URL", "BLOCKED_ADDRESS"]).toContain(await error(invoke(runtime, { url })))
  }
  for (const header of ["Host", "Connection", "Authorization", "Cookie", "Proxy-Authorization", "X-Api-Key"]) {
    expect(await error(invoke(runtime, { url: origin, headers: { [header]: "bad" } }))).toBe("UNSAFE_HEADER")
  }
  expect(await error(invoke(runtime, { url: origin, method: "POST", body: "x".repeat(40000) }))).toBe(
    "REQUEST_TOO_LARGE",
  )
  expect(await error(invoke(runtime, { url: `${origin}/?token=secret` }))).toBe("AUTH_REQUIRED")
  expect(await error(invoke(runtime, { url: origin, method: "POST", body: { token: "inline" } }))).toBe("AUTH_REQUIRED")
  process.env.OPENCODE_AGENT_TOOLS_ENABLED = "false"
  try {
    expect(await error(invoke(runtime, { url: origin }))).toBe("TOOLS_DISABLED")
  } finally {
    process.env.OPENCODE_AGENT_TOOLS_ENABLED = "true"
  }
  expect(hits).toBe(before)
})

test("IP normalization blocks metadata/special forms and marks private endpoints separately", () => {
  for (const ip of [
    "0.0.0.0",
    "169.254.1.1",
    "100.100.100.200",
    "224.0.0.1",
    "255.255.255.255",
    "::",
    "::ffff:127.0.0.1",
    "fe80::1",
    "2002:7f00:1::",
  ])
    expect(addressRisk(ip)).toBe("blocked")
  for (const ip of ["127.0.0.1", "10.1.2.3", "172.16.1.2", "192.168.0.1", "::1", "fd00::1"])
    expect(addressRisk(ip)).toBe("internal")
  expect(addressRisk("8.8.8.8")).toBe("public")
  expect(addressRisk("2001:4860:4860::8888")).toBe("public")
  expect(normalizeHttpUrl("http://2130706433/").hostname).toBe("127.0.0.1")
  expect(normalizeHttpUrl("http://0x7f000001/").hostname).toBe("127.0.0.1")
  expect(normalizeHttpUrl("http://%31%32%37.0.0.1/").hostname).toBe("127.0.0.1")
})

test("DNS validates every answer, pins one lookup and refuses public-to-private redirect", async () => {
  const signal = new AbortController().signal
  expect(await resolveEndpoint(new URL(origin), signal)).toHaveLength(1)
  let connected = ""
  let calls = 0
  const runtime = ManagedHttp.make({
    resolve: async () => {
      calls++
      return [{ address: calls === 1 ? "8.8.8.8" : "127.0.0.1", family: 4 }]
    },
    transport: async (_url, address) => {
      connected = address.address
      return {
        status: 302,
        statusText: "Found",
        headers: { location: `${origin}/ok` },
        body: Buffer.alloc(0),
        truncated: false,
        bytes: 0,
      }
    },
  })
  expect(await error(invoke(runtime, { url: "https://public.example/" }))).toBe("BLOCKED_REDIRECT")
  expect(connected).toBe("8.8.8.8")
  calls = 0
  expect(await error(invoke(runtime, { url: "http://public.example/" }))).toBe("BLOCKED_ADDRESS")
  expect(calls).toBe(2)
  let connectedMixed = 0
  const mixed = ManagedHttp.make({
    resolve: async () => [
      { address: "8.8.8.8", family: 4 },
      { address: "127.0.0.1", family: 4 },
    ],
    transport: async () => {
      connectedMixed++
      return {
        status: 302,
        statusText: "Found",
        headers: { location: `${origin}/ok` },
        body: Buffer.alloc(0),
        truncated: false,
        bytes: 0,
      }
    },
  })
  // The first pinned endpoint is public, even when a later DNS answer is private.
  expect(await error(invoke(mixed, { url: "http://mixed.example/" }))).toBe("BLOCKED_ADDRESS")
  expect(connectedMixed).toBe(1)
})

test("timeout, cancellation, bounded responses, redirect loops and malformed JSON", async () => {
  const runtime = ManagedHttp.make()
  expect(await error(invoke(runtime, { url: `${origin}/slow`, timeoutMs: 15 }))).toBe("TIMEOUT")
  const fiber = Effect.runFork(invoke(runtime, { url: `${origin}/slow` }))
  await new Promise((done) => setTimeout(done, 15))
  await Effect.runPromise(Fiber.interrupt(fiber))
  const large = await Effect.runPromise(invoke(runtime, { url: `${origin}/large` }))
  expect(large.truncated).toBe(true)
  expect(large.errorCode).toBe("RESPONSE_TOO_LARGE")
  expect(Buffer.byteLength(String(large.body))).toBeLessThanOrEqual(8192)
  expect((await Effect.runPromise(invoke(runtime, { url: `${origin}/binary` }))).errorCode).toBe("UNSUPPORTED_CONTENT")
  expect((await Effect.runPromise(invoke(runtime, { url: `${origin}/bad-json` }))).errorCode).toBe("INVALID_JSON")
  expect((await Effect.runPromise(invoke(runtime, { url: `${origin}/redirect` }))).redirectCount).toBe(1)
  expect(await error(invoke(runtime, { url: `${origin}/loop` }))).toBe("TOO_MANY_REDIRECTS")
})

test("caller cancellation aborts the actual socket and both aliases leave room for the HTTP timeout", async () => {
  expect(executionTimeout("http.request")).toBe(35000)
  expect(executionTimeout("http_request")).toBe(35000)
  const controller = new AbortController()
  const request = error(
    ManagedHttp.make().invoke({
      args: { url: `${origin}/slow` },
      sessionID: "cancel",
      turnID: "turn",
      signal: controller.signal,
      authorize: () => Effect.void,
    }),
  )
  await new Promise((done) => setTimeout(done, 15))
  controller.abort()
  expect(await request).toBe("CANCELLED")
})

test("origin-bound environment credential reference never appears in model results", async () => {
  const oldProfiles = process.env.OPENCODE_HTTP_CREDENTIAL_PROFILES
  process.env.PHASE9F_SECRET = "phase9f-private-token"
  process.env.PHASE9F_HTTP_USER = "phase9f-user"
  process.env.OPENCODE_HTTP_CREDENTIAL_PROFILES = JSON.stringify({
    local: { origin, type: "bearer", env: "PHASE9F_SECRET" },
    api: { origin, type: "apiKey", header: "X-Api-Key", env: "PHASE9F_SECRET" },
    basic: { origin, type: "basic", usernameEnv: "PHASE9F_HTTP_USER", passwordEnv: "PHASE9F_SECRET" },
  })
  try {
    const runtime = ManagedHttp.make()
    const audit: unknown[] = []
    const logger = Logger.make((options) => {
      audit.push(options.message)
    })
    const result = await Effect.runPromise(
      invoke(runtime, { url: `${origin}/ok`, credentialProfile: "local" }).pipe(Effect.provide(Logger.layer([logger]))),
    )
    expect(JSON.stringify(result)).not.toContain("phase9f-private-token")
    expect(result.body).toMatchObject({ authorization: "[REDACTED]" })
    expect(JSON.stringify(audit)).not.toContain("phase9f-private-token")
    expect(JSON.stringify(audit)).not.toContain("User prefers Electron.")
    expect(JSON.stringify(audit)).toContain("managed_http")
    for (const credentialProfile of ["api", "basic"]) {
      const result = await Effect.runPromise(
        invoke(runtime, { url: `${origin}/ok`, credentialProfile }).pipe(Effect.provide(Logger.layer([logger]))),
      )
      expect(result.body).toMatchObject({ echo: "[REDACTED]" })
      expect(JSON.stringify(result)).not.toContain("phase9f-private-token")
    }
    expect(JSON.stringify(audit)).not.toContain("phase9f-user")
    let sent = 0
    const redirect = ManagedHttp.make({
      resolve: async () => [{ address: "127.0.0.1", family: 4 }],
      transport: async () => {
        sent++
        return {
          status: 302,
          statusText: "Found",
          headers: { location: `http://different.example:${new URL(origin).port}/` },
          body: Buffer.alloc(0),
          truncated: false,
          bytes: 0,
        }
      },
    })
    expect(await error(invoke(redirect, { url: origin, credentialProfile: "local" }))).toBe("AUTH_REQUIRED")
    expect(sent).toBe(1)
    expect(await error(invoke(runtime, { url: "https://elsewhere.example/", credentialProfile: "local" }))).toBe(
      "AUTH_REQUIRED",
    )
  } finally {
    delete process.env.PHASE9F_SECRET
    delete process.env.PHASE9F_HTTP_USER
    if (oldProfiles === undefined) delete process.env.OPENCODE_HTTP_CREDENTIAL_PROFILES
    else process.env.OPENCODE_HTTP_CREDENTIAL_PROFILES = oldProfiles
  }
})

test("escaped credential echoes are redacted after JSON decoding without destroying structure", async () => {
  const previous = process.env.OPENCODE_HTTP_CREDENTIAL_PROFILES
  process.env.PHASE9F_SECRET = 'quoted-"value\\'
  process.env.OPENCODE_HTTP_CREDENTIAL_PROFILES = JSON.stringify({
    local: { origin, type: "apiKey", header: "X-Api-Key", env: "PHASE9F_SECRET" },
  })
  let truncated = false
  const runtime = ManagedHttp.make({
    resolve: resolveEndpoint,
    transport: async () => ({
      status: 200,
      statusText: `OK ${process.env.PHASE9F_SECRET}`,
      headers: {
        "content-type": `application/json; note=${process.env.PHASE9F_SECRET}`,
        "x-echo": "h".repeat(1018) + process.env.PHASE9F_SECRET,
      },
      body: Buffer.from(JSON.stringify({ echo: process.env.PHASE9F_SECRET, items: ["safe"] })),
      truncated,
      bytes: 40,
    }),
  })
  try {
    const result = await Effect.runPromise(invoke(runtime, { url: `${origin}/ok`, credentialProfile: "local" }))
    expect(result.ok).toBe(true)
    expect(result.body).toEqual({ echo: "[REDACTED]", items: ["safe"] })
    expect(result.statusText).not.toContain("quoted")
    expect(result.contentType).not.toContain("quoted")
    expect(result.headers["x-echo"]).not.toContain("quoted")
    truncated = true
    const oversized = await Effect.runPromise(invoke(runtime, { url: `${origin}/ok`, credentialProfile: "local" }))
    expect(oversized.truncated).toBe(true)
    expect(oversized.body).toBeNull()
  } finally {
    delete process.env.PHASE9F_SECRET
    if (previous === undefined) delete process.env.OPENCODE_HTTP_CREDENTIAL_PROFILES
    else process.env.OPENCODE_HTTP_CREDENTIAL_PROFILES = previous
  }
})

test("per-turn requests and concurrency budgets; no automatic write retries", async () => {
  const runtime = ManagedHttp.make()
  const turn = "budget"
  const before = hits
  for (let index = 0; index < 8; index++)
    await Effect.runPromise(invoke(runtime, { url: `${origin}/404`, method: "POST", body: { id: index } }, true, turn))
  expect(await error(invoke(runtime, { url: origin }, true, turn))).toBe("NETWORK_BUDGET_EXCEEDED")
  expect(hits - before).toBe(8)
  const jobs = [
    Effect.runPromise(invoke(runtime, { url: `${origin}/slow` })),
    Effect.runPromise(invoke(runtime, { url: `${origin}/slow` })),
  ]
  expect(await error(invoke(runtime, { url: origin }))).toBe("NETWORK_BUDGET_EXCEEDED")
  await Promise.all(jobs)
})

test("failed DNS attempts consume cumulative network time before any transport", async () => {
  const clock = Date.now
  let now = clock()
  let lookups = 0
  const runtime = ManagedHttp.make({
    resolve: async () => {
      lookups++
      now += 15000
      throw new HttpError("DNS_FAILURE")
    },
    transport: async () => {
      throw new Error("No transport allowed")
    },
  })
  Date.now = () => now
  try {
    for (let i = 0; i < 2; i++)
      expect(
        await error(invoke(runtime, { url: "http://unavailable.example/", timeoutMs: 30000 }, true, "dns-budget")),
      ).toBe("DNS_FAILURE")
    expect(
      await error(invoke(runtime, { url: "http://unavailable.example/", timeoutMs: 30000 }, true, "dns-budget")),
    ).toBe("NETWORK_BUDGET_EXCEEDED")
    expect(lookups).toBe(2)
  } finally {
    Date.now = clock
  }
})

test("pinned transport checks actual peer and refuses connection to an unavailable local port", async () => {
  const response = await pinnedRequest(
    new URL(`${origin}/ok`),
    { address: "127.0.0.1", family: 4 },
    "GET",
    {},
    undefined,
    new AbortController().signal,
  )
  expect(response.status).toBe(200)
  const hostname = new URL(origin)
  hostname.hostname = "rebind.invalid"
  expect(
    (
      await pinnedRequest(
        hostname,
        { address: "127.0.0.1", family: 4 },
        "GET",
        {},
        undefined,
        new AbortController().signal,
      )
    ).status,
  ).toBe(200)
  expect(await error(invoke(ManagedHttp.make(), { url: "http://127.0.0.1:1/" }))).toBe("CONNECTION_REFUSED")
})

test("DNS mixed answers and hanging resolution fail closed; configured proxy cannot reroute Bun requests", async () => {
  const rejected = (promise: Promise<unknown>) =>
    promise.then(
      () => {
        throw new Error("Expected rejection")
      },
      (error: unknown) => error,
    )
  expect(
    await rejected(
      resolveEndpoint(new URL("http://mock.example/"), new AbortController().signal, async () => [
        { address: "8.8.8.8", family: 4 },
        { address: "169.254.169.254", family: 4 },
      ]),
    ),
  ).toMatchObject({ code: "BLOCKED_ADDRESS" })
  expect(
    await rejected(
      resolveEndpoint(
        new URL("http://mock.example/"),
        AbortSignal.timeout(10),
        async () => new Promise(() => undefined),
      ),
    ),
  ).toMatchObject({ name: "TimeoutError" })
  const old = process.env.HTTP_PROXY
  process.env.HTTP_PROXY = "http://127.0.0.1:61112"
  try {
    expect(
      await rejected(
        pinnedRequest(
          new URL(origin),
          { address: "127.0.0.1", family: 4 },
          "GET",
          {},
          undefined,
          new AbortController().signal,
        ),
      ),
    ).toMatchObject({ code: "PROXY_UNSUPPORTED" })
  } finally {
    if (old === undefined) delete process.env.HTTP_PROXY
    else process.env.HTTP_PROXY = old
  }
})

test("untrusted self-signed local HTTPS certificate remains rejected", async () => {
  const directory = await mkdtemp(join(tmpdir(), "phase9f-tls-"))
  let tls: ReturnType<typeof Bun.serve> | undefined
  try {
    const child = Bun.spawn(
      [
        "C:\\Program Files\\Git\\usr\\bin\\openssl.exe",
        "req",
        "-x509",
        "-newkey",
        "rsa:2048",
        "-nodes",
        "-keyout",
        join(directory, "key.pem"),
        "-out",
        join(directory, "cert.pem"),
        "-days",
        "1",
        "-subj",
        "/CN=localhost",
      ],
      { stdout: "ignore", stderr: "ignore" },
    )
    expect(await child.exited).toBe(0)
    tls = Bun.serve({
      hostname: "127.0.0.1",
      port: 0,
      tls: { key: await readFile(join(directory, "key.pem")), cert: await readFile(join(directory, "cert.pem")) },
      fetch: () => Response.json({ ok: true }),
    })
    expect(await error(invoke(ManagedHttp.make(), { url: `https://127.0.0.1:${tls.port}/` }))).toBe("TLS_ERROR")
  } finally {
    await tls?.stop(true)
    await rm(directory, { recursive: true, force: true })
  }
}, 10000)
