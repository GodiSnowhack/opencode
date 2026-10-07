# Phase 9A Tool Runtime

## Architecture

The packaged Desktop uses OpenCode's existing V1 `SessionPrompt` multi-step loop, AI SDK tool protocol, `SessionProcessor`, and `SessionTools.resolve`. The managed `memory-local` provider receives only the three read-only tools below. Other providers retain their existing tool catalog. No new Ollama adapter is needed: structured `tool_calls`, tool results, and continuation already pass through Gateway.

## Registry

`ToolRegistry` initializes the three tools through `Tool.define`/`Tool.init`. Each definition has an ID, version, category, risk, permission, availability, timeout, and cancellability. Reserved names cannot be replaced by plugin tools. Agent Tools applies only to the managed local provider or a model routed through the configured local Memory Gateway. OFF removes every model-visible tool schema in both V1 and V2, regardless of Build/Plan mode; other providers keep their normal permission-filtered catalog. ON restores the existing permitted catalog.

## Execution Context

The model supplies validated arguments, never the workspace root, project identity, session identity, or permission decision. `InstanceState` supplies the workspace, and `MemoryGateway.effectiveProjectID` supplies the canonical project ID for audit. One `ToolTurnBudget` is created for each user turn and shared by all continuation steps.

## Permissions

The existing OpenCode `Permission.Service` evaluates `read` with agent and session rules. Its trusted UI/config path can ASK or DENY. Tool arguments such as `approved` have no authority. The native reader receives an already approved request without a second prompt. No renderer API for arbitrary execution or filesystem access was added.

## Risk Classes

The registry supports READ, SAFE_WRITE, DESTRUCTIVE, and EXTERNAL_ACTION metadata. Phase 9A exposes READ only. Future action tools require separate policy and implementation.

## Validation

`Tool.init` validates the existing Effect Schema before each handler. `project.info` takes no arguments; `fs.list` accepts a relative path and a limit from 1 to 100; `fs.read` accepts a relative path, start line, and up to 200 lines. Invalid input is reported as `INVALID_ARGUMENT`.

## Error Contract

Model-facing failures use codes `INVALID_ARGUMENT`, `NOT_ALLOWED`, `NOT_FOUND`, `UNAVAILABLE`, `TIMEOUT`, `CANCELLED`, `RESULT_TOO_LARGE`, and `EXECUTION_FAILED`. Raw filesystem errors and stack traces are not returned as the primary result.

## Timeouts

Each managed tool invocation has a 10-second timeout. The turn stops executing tools after 60 seconds of cumulative execution.

## Cancellation

The tool races execution against the caller's AbortSignal. Cancelling the user turn interrupts the active Effect and prevents further execution. Native file reading remains bounded and receives the existing context signal.

## Budgets

Default: 12 calls per turn; configurable from 1 to 24 in Desktop settings. Each result is limited to 16 KiB and the turn to 64 KiB of tool output.

## Loop Prevention

A normalized tool name and argument object plus SHA-256 of the result identify repeated calls. After two identical outcomes, the next identical invocation is denied. After two denied calls, or when the call/time budget is exhausted, the next model step has no tool schemas and must finish without more tool calls.

## Audit

Each managed invocation logs a timestamped structured event with invocation, session, canonical project, tool/version, risk, permission decision, duration, status, and error code. File content, arguments, paths, and secrets are omitted.

## Metrics

In-process counters track total, success, failure, denial, timeout, cancellation, loop prevention, truncation, and cumulative duration. They have no path, session, project, or filename labels.

## Workspace Security

`fs.list` and `fs.read` accept relative names only. Windows/Unix absolute paths, drive prefixes, UNC paths, traversal, and NUL are rejected. The trusted root and target are canonicalized, so symlinks and junctions outside the workspace are denied. Native `ReadTool` handles binary detection, bounded text, and UTF-8. Output does not contain the full local workspace path.

## Memory Interaction

Gateway injection remains request-local and uses one cached memory block per stateless continuation request. It does not enter Raw History as a new user message. Existing worker admission requires user evidence for user preference/fact/decision types; tool output alone cannot confirm a user preference.

## Ollama/Qwen Compatibility

The existing OpenAI-compatible Gateway passes tool schemas, structured Qwen tool calls, and tool result messages. The Desktop managed provider is gated by Agent Tools. Phase 9A automated tests cover the OpenCode runtime and existing Gateway continuation contract; live Desktop/Qwen user acceptance remains required.

## How to Add a Tool

Define an Effect Schema and `Tool.define` handler; register it in `ToolRegistry`; set metadata and trusted permissions; bound result and timeout; add focused security and continuation tests. Only expose a new risk class after its approval policy and audit are designed.

## Security Boundaries

Renderer settings only update narrow typed options. Filesystem access stays in the OpenCode sidecar. Phase 9A does not add write, shell, HTTP, browser, or generated tools.

In Desktop dev mode the V1 sidecar refresh completes before the Agent Tools settings call returns, so the next turn sees the new value. The experimental V2 background service does not support this live refresh; the settings UI reports that its service must be restarted before the new value takes effect.
