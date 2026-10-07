export type CommandRisk =
  | "SAFE_READ"
  | "SAFE_BUILD"
  | "SAFE_TEST"
  | "WRITE"
  | "DESTRUCTIVE"
  | "NETWORK"
  | "SYSTEM"
  | "PRIVILEGED"
export class CommandError extends Error {
  constructor(
    readonly code: string,
    readonly risk?: CommandRisk,
  ) {
    super(code)
  }
}

export const commandFailure = (error: unknown) => ({
  ok: false,
  code: error instanceof CommandError ? error.code : "EXECUTION_FAILED",
  risk: error instanceof CommandError ? error.risk : undefined,
})

/** Deliberately a single literal invocation, not a permissive shell parser. */
export function commandTokens(command: string) {
  if (!command.trim() || command.length > 4096 || /[\r\n\0]/.test(command)) throw new CommandError("INVALID_ARGUMENT")
  const tokens: string[] = []
  let quote = ""
  let token = ""
  let active = false
  for (const char of command) {
    if (quote) {
      if (char === quote) quote = ""
      else {
        if (quote === '"' && /[$`]/.test(char)) throw new CommandError("COMMAND_DENIED", "SYSTEM")
        token += char
      }
      continue
    }
    if (char === "'" || char === '"') {
      if (token) throw new CommandError("COMMAND_DENIED", "SYSTEM")
      quote = char
      active = true
      continue
    }
    if (/[;&|<>$`(){}\[\]#]/.test(char)) throw new CommandError("COMMAND_DENIED", "SYSTEM")
    if (/\s/.test(char)) {
      if (active) tokens.push(token)
      token = ""
      active = false
      continue
    }
    token += char
    active = true
  }
  if (quote) throw new CommandError("INVALID_ARGUMENT")
  if (active) tokens.push(token)
  return tokens
}

export function classifyCommand(command: string) {
  const tokens = commandTokens(command)
  const name = tokens[0].toLowerCase().replace(/\.(?:exe|cmd|bat)$/, "")
  const args = tokens.slice(1)
  const lower = args.map((arg) => arg.toLowerCase())
  if (/^(sudo|runas)$/.test(name) || lower.some((arg) => /^(?:-verb|-encodedcommand|-enc|-executionpolicy)$/.test(arg)))
    throw new CommandError("PRIVILEGE_REQUIRED", "PRIVILEGED")
  if (/^(rm|rmdir|rd|del|erase|remove-item|format|diskpart)$/.test(name))
    throw new CommandError("COMMAND_DENIED", "DESTRUCTIVE")
  if (/^(curl|wget|invoke-webrequest|invoke-restmethod|pip|pip3)$/.test(name))
    throw new CommandError("COMMAND_DENIED", "NETWORK")
  if (/^(stop-process|taskkill|reg|sc|netsh|shutdown|invoke-expression|powershell|pwsh|cmd)$/.test(name))
    throw new CommandError("COMMAND_DENIED", "SYSTEM")
  if (
    /^(npm|pnpm|bun|yarn)$/.test(name) &&
    (/^(install|i|add|update|upgrade|publish|exec|x|dlx)$/.test(lower[0] ?? "") ||
      lower.some((arg) => /^(?:-g|--global)$/.test(arg)))
  )
    throw new CommandError("COMMAND_DENIED", "NETWORK")
  if (tokens.some((arg) => /(?:^|[=])(?:[a-z]:|\/|\\|~)|(?:^|[=\\/])\.\.(?:[\\/]|$)/i.test(arg)))
    throw new CommandError("PATH_OUTSIDE_WORKSPACE")
  if (tokens.some((arg) => /(?:token|api[_-]?key|password|secret|authorization)\s*[=:]/i.test(arg)))
    throw new CommandError("COMMAND_DENIED", "SYSTEM")
  const script = lower[0] === "run" ? lower[1] : lower[0]
  const risk: CommandRisk | undefined = /^(echo|write-output|pwd|get-location)$/.test(name)
    ? "SAFE_READ"
    : /^(npm|pnpm|bun|yarn)$/.test(name) && script
      ? /^(test)(?:$|[:.-])/.test(script)
        ? "SAFE_TEST"
        : /^(build|lint|typecheck|check)(?:$|[:.-])/.test(script)
          ? "SAFE_BUILD"
          : /^(dev|start|generate)(?:$|[:.-])/.test(script) ||
              (lower[0] === "run" && /^[a-z][a-z0-9:_-]*$/.test(script))
            ? "WRITE"
            : undefined
      : name === "cargo" && /^(test|check|build)$/.test(script)
        ? script === "test"
          ? "SAFE_TEST"
          : "SAFE_BUILD"
        : /^(tsc|eslint)$/.test(name)
          ? "SAFE_BUILD"
          : name === "prettier" && lower.includes("--check") && !lower.includes("--write")
            ? "SAFE_BUILD"
            : name === "node" && args[0] && !args[0].startsWith("-") && /\.(?:[cm]?js|ts)$/.test(args[0])
              ? "WRITE"
              : undefined
  if (!risk) throw new CommandError("COMMAND_DENIED", "SYSTEM")
  return { tokens, risk, timeoutMs: risk === "SAFE_TEST" ? 120_000 : risk === "SAFE_BUILD" ? 180_000 : 30_000 }
}

export function outputRedactor(environment = process.env) {
  const secrets = Object.entries(environment)
    .filter(
      ([key, value]) => /TOKEN|API_KEY|PASSWORD|SECRET|AUTH|PRIVATE_KEY|ACCESS_KEY|CREDENTIAL/i.test(key) && value,
    )
    .flatMap(([, value]) => value!.split(/\r?\n/).filter(Boolean))
    .sort((a, b) => b.length - a.length)
  return (text: string) => {
    for (const secret of secrets) text = text.replaceAll(secret, "[REDACTED]")
    return text.replace(
      /((?:token|api[_-]?key|password|secret|authorization)\s*[:=]\s*)(?:"[^"]*"|'[^']*'|(?:Bearer\s+)?[^\s,;]+)/gi,
      "$1[REDACTED]",
    )
  }
}

export const EXECUTION_GUIDANCE =
  "Use first-class Git tools for Git operations; shell git is denied, including force push/reset/clean. Use fs.edit/fs.write for text changes. Run the direct reproduction first, then affected package tests, closest regressions, and affected build/typecheck/lint. Broaden to full suites only with a stated reason. Use process.start for dev servers, process.status to inspect logs, and process.stop to stop only your owned handle. Commands must be one literal invocation; no interpolation, pipelines, redirection or elevated/system/network/install operations. Project scripts execute with host-user authority and require bash permission."
