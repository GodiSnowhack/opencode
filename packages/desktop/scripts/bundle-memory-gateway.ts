import { $ } from "bun"
import { cpSync, existsSync, mkdirSync, rmSync } from "node:fs"
import { resolve, sep } from "node:path"

const backend = resolve(import.meta.dir, "../../../../opencode-memory-system")
if (existsSync(resolve(backend, "package.json"))) {
  await $`pnpm package:gateway`.cwd(backend)
  const target = resolve(import.meta.dir, "../resources/memory-gateway")
  if (!target.startsWith(resolve(import.meta.dir, "../resources") + sep)) throw new Error("Unsafe resource directory")
  rmSync(target, { recursive: true, force: true })
  mkdirSync(target, { recursive: true })
  cpSync(resolve(backend, "dist/desktop-gateway"), target, { recursive: true, force: true })
  console.log(`Memory Gateway bundled at ${target}`)
}
