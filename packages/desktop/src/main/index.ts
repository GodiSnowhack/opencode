import { randomUUID } from "node:crypto"
import { createDesktopUsageStore } from "./usage-store"
import { existsSync, mkdirSync } from "node:fs"
import * as http from "node:http"
import { createServer } from "node:net"
import { homedir, tmpdir } from "node:os"
import { basename, dirname, join, resolve } from "node:path"
import { getCACertificates, setDefaultCACertificates } from "node:tls"
import type { Event } from "electron"
import { app, BrowserWindow } from "electron"

import { Deferred, Effect, Fiber } from "effect"
import contextMenu from "electron-context-menu"

import type { ServerReadyData } from "../preload/types"
import { checkAppExists, resolveAppPath } from "./apps"
import { CHANNEL } from "./constants"
import { registerIpcHandlers, sendDeepLinks, sendMenuCommand } from "./ipc"
import { forwardInitializationFailure } from "./initialization"
import { exportDebugLogs, initCrashReporter, initLogging, startNetLog, write as writeLog } from "./logging"
import { createMenu } from "./menu"
import {
  finishFirstLaunchOnboarding,
  initializeOldLayoutEligibility,
  isFirstLaunchOnboardingPending,
  isOldLayoutEligible,
} from "./onboarding"
import {
  getDefaultServerUrl,
  preferAppEnv,
  setDefaultServerUrl,
  spawnLocalServer,
  type SidecarListener,
} from "./server"
import { setupAutoUpdater, showUpdaterDialog } from "./updater"
import { safeWebContentsURL } from "./window-state"
import {
  getLastFocusedWindow,
  registerRendererProtocol,
  setRelaunchHandler,
  setAppQuitting,
  setBackgroundColor,
  setDockIcon,
  restoreMainWindows,
} from "./windows"
import { createWslServersController } from "./wsl/servers"
import { registerWslIpcHandlers } from "./wsl/ipc"
import { spawnWslSidecar } from "./wsl/sidecar"
import { migrate } from "./migrate"
import { cleanupStoreFiles } from "./store-cleanup"
import { startBackgroundCli } from "./background-cli"
import {
  MemoryService,
  managedMemoryProvider,
  managedProviderModels,
  memoryGatewayResources,
  memoryDevRelaunchArgs,
} from "./memory-service"
import { getStore } from "./store"
import { setNativeTranslations } from "./native-translations"

const APP_NAMES: Record<string, string> = {
  dev: "OpenCode Dev",
  beta: "OpenCode Beta",
  prod: "OpenCode",
}
const APP_IDS: Record<string, string> = {
  dev: "ai.opencode.desktop.dev",
  beta: "ai.opencode.desktop.beta",
  prod: "ai.opencode.desktop",
}
const TEST_ONBOARDING = process.env.OPENCODE_TEST_ONBOARDING === "1"
const SIDECAR_VERSION = process.env.OPENCODE_SIDECAR_V2 === "1" ? "v2" : "v1"
const jsCallStackFeature = "DocumentPolicyIncludeJSCallStacksInCrashReports"

let logger: ReturnType<typeof initLogging>
let server: SidecarListener | null = null

const pendingDeepLinks: string[] = []

function useEnvProxy() {
  try {
    // Electron 41.2 runs Node 24.14.1; latest @types/node@24 is 24.12.2.
    ;(http as any).setGlobalProxyFromEnv()
  } catch (error) {
    logger.warn("failed to load proxy environment", error)
  }
}

function emitDeepLinks(urls: string[]) {
  if (urls.length === 0) return
  pendingDeepLinks.push(...urls)
  const win = getLastFocusedWindow()
  if (win) sendDeepLinks(win, urls)
}

async function killSidecar() {
  if (!server) return
  const current = server
  server = null
  await current.stop()
}

function ensureLoopbackNoProxy() {
  const loopback = ["127.0.0.1", "localhost", "::1"]
  const upsert = (key: string) => {
    const items = (process.env[key] ?? "")
      .split(",")
      .map((value: string) => value.trim())
      .filter((value: string) => Boolean(value))

    for (const host of loopback) {
      if (items.some((value: string) => value.toLowerCase() === host)) continue
      items.push(host)
    }

    process.env[key] = items.join(",")
  }

  upsert("NO_PROXY")
  upsert("no_proxy")
}

const main = Effect.gen(function* () {
  contextMenu({ showSaveImageAs: true, showLookUpSelection: false, showSearchWithGoogle: false })

  // on macOS apps run in `/` which can cause issues with ripgrep
  try {
    process.chdir(homedir())
  } catch {}

  process.env.OPENCODE_DISABLE_EMBEDDED_WEB_UI = "true"

  const appId = app.isPackaged ? APP_IDS[CHANNEL] : "ai.opencode.desktop.dev"
  const onboardingTestRoot = ((): string | undefined => {
    if (!TEST_ONBOARDING) return

    const previous = process.env.OPENCODE_TEST_ONBOARDING_ROOT
    const root =
      previous &&
      dirname(resolve(previous)) === resolve(tmpdir()) &&
      /^opencode-onboarding-[a-f0-9-]{36}$/u.test(basename(previous)) &&
      existsSync(previous)
        ? previous
        : join(tmpdir(), `opencode-onboarding-${randomUUID()}`)
    process.env.OPENCODE_TEST_ONBOARDING_ROOT = root
    ;["data", "config", "cache", "state", "desktop", "session"].forEach((dir) =>
      mkdirSync(join(root, dir), { recursive: true }),
    )
    process.env.OPENCODE_DB = ":memory:"
    process.env.XDG_DATA_HOME = join(root, "data")
    process.env.XDG_CONFIG_HOME = join(root, "config")
    process.env.XDG_CACHE_HOME = join(root, "cache")
    process.env.XDG_STATE_HOME = join(root, "state")
    return root
  })()
  app.setName(app.isPackaged ? APP_NAMES[CHANNEL] : "OpenCode Dev")
  app.setAppUserModelId(appId)
  app.setPath(
    "userData",
    onboardingTestRoot ? join(onboardingTestRoot, "desktop") : join(app.getPath("appData"), appId),
  )
  if (onboardingTestRoot) app.setPath("sessionData", join(onboardingTestRoot, "session"))
  initializeOldLayoutEligibility(app.getPath("userData"))
  logger = initLogging()
  initCrashReporter()

  const wslServers = createWslServersController(
    app.getVersion(),
    async (distro) => {
      logger.log("spawning wsl sidecar", { distro })
      return spawnWslSidecar(distro, {
        onLine: (line) => logger.log("wsl sidecar", { distro, stream: line.stream, text: line.text }),
      })
    },
    {
      logger: {
        log: (message, meta) => logger.log(message, meta),
        error: (message, meta) => logger.error(message, meta),
      },
    },
  )
  const stopSidecars = async () => {
    await killSidecar()
    wslServers.stopAll()
  }
  const inheritedMemoryEnv = {
    OPENCODE_CONFIG_CONTENT: process.env.OPENCODE_CONFIG_CONTENT,
    OPENCODE_MEMORY_INTEGRATION: process.env.OPENCODE_MEMORY_INTEGRATION,
    OPENCODE_MEMORY_GATEWAY_URL: process.env.OPENCODE_MEMORY_GATEWAY_URL,
    OPENCODE_AGENT_TOOLS_ENABLED: process.env.OPENCODE_AGENT_TOOLS_ENABLED,
    OPENCODE_AGENT_MAX_TOOL_CALLS: process.env.OPENCODE_AGENT_MAX_TOOL_CALLS,
  }
  const relaunch = () => {
    setAppQuitting()
    void stopSidecars().finally(() => {
      for (const [key, value] of Object.entries(inheritedMemoryEnv)) {
        if (value === undefined) delete process.env[key]
        else process.env[key] = value
      }
      if (app.isPackaged) app.relaunch()
      else app.relaunch({ execPath: process.execPath, args: memoryDevRelaunchArgs(app.getAppPath(), process.argv) })
      app.quit()
    })
  }

  try {
    setDefaultCACertificates([...new Set([...getCACertificates("default"), ...getCACertificates("system")])])
  } catch (error) {
    logger.warn("failed to load system certificates", error)
  }

  logger.log("app starting", {
    version: app.getVersion(),
    packaged: app.isPackaged,
    onboardingTest: Boolean(onboardingTestRoot),
  })

  ensureLoopbackNoProxy()
  useEnvProxy()
  app.commandLine.appendSwitch("proxy-bypass-list", "<-loopback>")
  const features = app.commandLine.getSwitchValue("enable-features")
  app.commandLine.appendSwitch("enable-features", features ? `${jsCallStackFeature},${features}` : jsCallStackFeature)
  if (!app.isPackaged) app.commandLine.appendSwitch("remote-debugging-port", "9222")

  if (!app.requestSingleInstanceLock()) {
    app.quit()
    return
  }

  const shellEnv = preferAppEnv(app.getPath("userData"))
  const usage = (() => {
    try {
      return createDesktopUsageStore(join(app.getPath("userData"), "usage.sqlite"))
    } catch {
      console.error("Local usage statistics unavailable")
      return undefined
    }
  })()
  app.once("will-quit", () => usage?.close())
  const memoryService = new MemoryService({
    store: getStore("opencode.memory"),
    userData: app.getPath("userData"),
    resources: memoryGatewayResources(app.isPackaged, app.getAppPath(), process.resourcesPath),
    executable: process.execPath,
    onUsage: (event) => {
      usage?.bestEffort(event)
    },
  })
  const initialOllamaDetection = memoryService.detectOllama()
  const configureMemoryEnv = () => {
    for (const [key, value] of Object.entries(inheritedMemoryEnv)) {
      if (value === undefined) delete process.env[key]
      else process.env[key] = value
    }
    if (!memoryService.snapshot.settings.enabled) return
    const settings = memoryService.snapshot.settings
    try {
      process.env.OPENCODE_CONFIG_CONTENT = managedMemoryProvider(
        process.env.OPENCODE_CONFIG_CONTENT,
        memoryService.snapshot.ollama.chatModels ?? [],
        settings.port,
        settings.contextLength,
      )
      process.env.OPENCODE_MEMORY_INTEGRATION = "true"
      process.env.OPENCODE_MEMORY_GATEWAY_URL = `http://127.0.0.1:${settings.port}/v1`
      process.env.OPENCODE_AGENT_TOOLS_ENABLED = String(settings.agentTools)
      process.env.OPENCODE_AGENT_MAX_TOOL_CALLS = String(settings.maxToolCalls)
    } catch (error) {
      logger.error("managed memory provider setup failed", error)
    }
  }
  const serverReady = Deferred.makeUnsafe<ServerReadyData, unknown>()
  let v2Sidecar: Awaited<ReturnType<typeof startBackgroundCli>> | undefined
  const verifyManagedContext = async (url: string, password: string) => {
    const settings = memoryService.snapshot.settings
    if (!settings.enabled) return
    const expected = Object.fromEntries(
      (memoryService.snapshot.ollama.chatModels ?? []).map((model) => [
        model.id,
        Math.min(settings.contextLength, model.context ?? settings.contextLength),
      ]),
    )
    let observed: Record<string, number> | undefined
    for (let attempt = 0; attempt < 5; attempt++) {
      observed = await fetch(new URL("/provider", url), {
        headers: { authorization: `Basic ${Buffer.from(`opencode:${password}`).toString("base64")}` },
        signal: AbortSignal.timeout(3000),
      })
        .then(async (response) => (response.ok ? managedProviderModels(await response.json()) : undefined))
        .catch(() => undefined)
      if (
        observed &&
        JSON.stringify(Object.entries(observed).sort()) === JSON.stringify(Object.entries(expected).sort())
      )
        return
      await new Promise((resolve) => setTimeout(resolve, 200))
    }
    throw new Error("managed_provider_catalog_mismatch")
  }
  const doApplyMemorySettings = async () => {
    if (app.isPackaged) {
      relaunch()
      return
    }
    configureMemoryEnv()
    const ready = await Effect.runPromise(Deferred.await(serverReady))
    if (!ready.password) throw new Error("dev_sidecar_credentials_unavailable")
    if (SIDECAR_VERSION === "v2") {
      if (!v2Sidecar) throw new Error("managed_v2_service_unavailable")
      const next = await v2Sidecar.restart()
      await verifyManagedContext(next.url, next.password)
      if (next.url !== ready.url || next.password !== ready.password) {
        relaunch()
        return
      }
      for (const window of BrowserWindow.getAllWindows()) window.reload()
      return
    }
    await killSidecar()
    const url = new URL(ready.url)
    const { listener, health } = await spawnLocalServer(url.hostname, Number(url.port), ready.password, {
      userDataPath: app.getPath("userData"),
      onStdout: (message) => writeLog("server", "stdout", { message }),
      onStderr: (message) => writeLog("server", "stderr", { message }, "warn"),
      onExit: (code) => writeLog("utility", "sidecar exited", { code }, "warn"),
    })
    server = listener
    await health.wait
    await verifyManagedContext(ready.url, ready.password)
    for (const window of BrowserWindow.getAllWindows()) window.reload()
  }
  let pendingMemoryApply = Promise.resolve()
  const applyMemorySettings = () => {
    const task = pendingMemoryApply.then(doApplyMemorySettings)
    pendingMemoryApply = task.catch(() => undefined)
    return task
  }
  void initialOllamaDetection
    .then(() =>
      memoryService.snapshot.settings.enabled && memoryService.snapshot.settings.autoStart
        ? memoryService.start()
        : undefined,
    )
    .catch((error) => logger.error("memory gateway startup failed", error))

  let memoryQuitPending = false
  app.on("before-quit", (event) => {
    if (memoryQuitPending) return
    memoryQuitPending = true
    event.preventDefault()
    void memoryService.stop().finally(() => app.quit())
  })

  app.on("second-instance", (_event: Event, argv: string[]) => {
    const urls = argv.filter((arg: string) => arg.startsWith("opencode://"))
    if (urls.length) {
      logger.log("deep link received via second-instance", { urls })
      emitDeepLinks(urls)
    }
    const win = getLastFocusedWindow()
    if (win) {
      win.show()
      win.focus()
    }
  })

  app.on("open-url", (event: Event, url: string) => {
    event.preventDefault()
    logger.log("deep link received via open-url", { url })
    emitDeepLinks([url])
  })

  app.on("before-quit", () => {
    setAppQuitting()
    void stopSidecars()
  })

  app.on("will-quit", () => {
    setAppQuitting()
    void stopSidecars()
  })

  app.on("child-process-gone", (_event, details) => {
    writeLog("utility", "child process gone", { details }, "error")
  })

  app.on("render-process-gone", (_event, webContents, details) => {
    writeLog("window", "app render process gone", { url: safeWebContentsURL(webContents), details }, "error")
  })

  setRelaunchHandler(() => {
    relaunch()
  })

  for (const signal of ["SIGINT", "SIGTERM"] as const) {
    process.on(signal, () => {
      setAppQuitting()
      void stopSidecars().finally(() => app.quit())
    })
  }

  yield* Effect.promise(() => app.whenReady())

  if (!TEST_ONBOARDING) migrate()
  yield* Effect.promise(() => cleanupStoreFiles(app.getPath("userData"))).pipe(
    Effect.tap((result) =>
      Effect.sync(() => {
        if (result.deleted.length === 0) return
        logger.log("cleaned scoped store files", { count: result.deleted.length, scanned: result.scanned })
      }),
    ),
    Effect.catch((error) =>
      Effect.sync(() => {
        logger.warn("failed to clean scoped store files", error)
      }),
    ),
  )
  if (!TEST_ONBOARDING) app.setAsDefaultProtocolClient("opencode")
  registerRendererProtocol()
  setDockIcon()
  const updater = setupAutoUpdater(stopSidecars)
  const menuDeps = {
    trigger: (id: string) => {
      const win = getLastFocusedWindow()
      if (win) sendMenuCommand(win, id)
    },
    checkForUpdates: () => void showUpdaterDialog(updater, true),
    relaunch,
  }
  registerIpcHandlers({
    memoryService,
    usage,
    killSidecar: () => killSidecar(),
    relaunch,
    applyMemorySettings,
    awaitInitialization: Effect.fnUntraced(
      function* () {
        logger.log("awaiting server ready")
        const res = yield* Deferred.await(serverReady)
        logger.log("server ready", { url: res.url })
        return res
      },
      (e) => Effect.runPromise(e),
    ),
    consumeInitialDeepLinks: () => pendingDeepLinks.splice(0),
    getDefaultServerUrl: () => getDefaultServerUrl(),
    setDefaultServerUrl: (url) => setDefaultServerUrl(url),
    isFirstLaunchOnboardingPending,
    finishFirstLaunchOnboarding,
    isOldLayoutEligible,
    getDisplayBackend: async () => null,
    setDisplayBackend: async () => undefined,
    checkAppExists: (appName) => checkAppExists(appName),
    resolveAppPath: async (appName) => resolveAppPath(appName),
    updater,
    showUpdater: () => showUpdaterDialog(updater, true),
    setBackgroundColor: (color) => setBackgroundColor(color),
    exportDebugLogs: () => exportDebugLogs(),
    recordFatalRendererError: (error) => writeLog("renderer", "fatal renderer error", { ...error }, "error"),
    setNativeTranslations: (bundle) => {
      if (setNativeTranslations(bundle)) createMenu(menuDeps)
    },
  })
  registerWslIpcHandlers(wslServers)
  void updater.start()
  const updateTimer = setInterval(() => void updater.check(), 10 * 60 * 1000)
  updateTimer.unref()
  app.once("will-quit", () => clearInterval(updateTimer))
  yield* Effect.promise(() => startNetLog()).pipe(
    Effect.catch((error) =>
      Effect.sync(() => {
        logger.warn("failed to start net log", error)
      }),
    ),
  )

  const loadingTask = yield* Effect.gen(function* () {
    logger.log("sidecar connection started", { version: SIDECAR_VERSION })

    ensureLoopbackNoProxy()
    useEnvProxy()
    yield* Effect.promise(() => initialOllamaDetection)
    configureMemoryEnv()

    if (SIDECAR_VERSION === "v2") {
      logger.log("spawning v2 sidecar")
      const sidecar = yield* Effect.promise(() => startBackgroundCli(logger, shellEnv?.XDG_STATE_HOME))
      v2Sidecar = sidecar
      yield* Deferred.succeed(serverReady, {
        url: sidecar.url,
        username: sidecar.username,
        password: sidecar.password,
      })

      if (process.platform === "win32") {
        void wslServers.initialize().catch((error) => logger.error("wsl server initialization failed", error))
      }

      logger.log("loading task finished")
      return
    }

    const port = yield* Effect.gen(function* () {
      const fromEnv = process.env.OPENCODE_PORT
      if (fromEnv) {
        const parsed = Number.parseInt(fromEnv, 10)
        if (!Number.isNaN(parsed)) return parsed
      }

      const res = yield* Deferred.make<number, unknown>()
      const socket = createServer()
      socket.on("error", (e) => Deferred.failSync(res, () => e))
      socket.listen(0, "127.0.0.1", () => {
        const address = socket.address()
        if (typeof address !== "object" || !address) {
          socket.close()
          Deferred.failSync(res, () => new Error("Failed to get port"))
          return
        }
        const port = address.port
        socket.close(() => Effect.runSync(Deferred.succeed(res, port)))
      })

      return yield* Deferred.await(res)
    })
    const hostname = "127.0.0.1"
    const url = `http://${hostname}:${port}`
    const password = randomUUID()

    logger.log("spawning sidecar", { url })
    const { listener, health } = yield* Effect.promise(() =>
      spawnLocalServer(hostname, port, password, {
        userDataPath: app.getPath("userData"),
        onStdout: (message) => writeLog("server", "stdout", { message }),
        onStderr: (message) => writeLog("server", "stderr", { message }, "warn"),
        onExit: (code) => writeLog("utility", "sidecar exited", { code }, "warn"),
      }),
    )
    server = listener
    yield* Deferred.succeed(serverReady, {
      url,
      username: "opencode",
      password,
    })

    if (process.platform === "win32") {
      void wslServers.initialize().catch((error) => logger.error("wsl server initialization failed", error))
    }

    yield* Effect.promise(() => health.wait).pipe(
      Effect.timeout("30 seconds"),
      Effect.catch((e) =>
        Effect.sync(() => {
          logger.error("sidecar health check failed", e.toString())
        }),
      ),
    )

    logger.log("loading task finished")
  }).pipe(forwardInitializationFailure(serverReady), Effect.forkChild)

  yield* Fiber.await(loadingTask)

  app.on("window-all-closed", () => {
    if (process.platform === "darwin") return
    app.quit()
  })
  app.on("activate", () => {
    if (BrowserWindow.getAllWindows().length > 0) return
    restoreMainWindows()
  })

  const windows = restoreMainWindows()
  if (windows.length) createMenu(menuDeps)
})

Effect.runFork(main)
