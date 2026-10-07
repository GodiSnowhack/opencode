# Phase 9B — Files / Search / Edit

## Expanded self-acceptance — complete

The 2026-10-07 user validation policy supersedes the focused-only/manual acceptance policy below.

- [x] Full relevant Core, V1, app, session UI, Desktop and backend suites attempted.
- [x] App + Desktop renderer/main/preload production bundles; Windows CLI build + binary version smoke.
- [x] Five-package typecheck; backend typecheck/lint/build/memory:check.
- [x] Correct full-suite catalog expectations; retain ordinary-provider tool context without managed turnID.
- [x] Replace obsolete managed read-only prompt guidance with read-before-edit workspace guidance.
- [x] Real Qwen3-Coder search/read/edit/two-file create/continuation + UTF-8 filesystem checks; Tools OFF schemas empty and file unchanged.
- [x] Real Gemma workflow and strict OFF; V2 real Qwen runner workflow.
- [x] Real permissions, worker provenance/extraction, retrieval and owned Gateway restart.
- [x] Isolated built Desktop startup, final formatting/diff review, cleanup and evidence report.

Final necessary checks: adapter/injection 19/19; Gateway/e2e-memory integration 13/13; backend package/build/typecheck and targeted lint PASS. Fresh-profile automatic extraction, user-only source, new-session answer and post-Gateway-restart answer PASS. Native leading system messages are consolidated to preserve the retrieved block for Ollama; unavailable hallucinated calls are suppressed. Full evidence, counts, changed files and known limitations: PHASE9B_SELF_ACCEPTANCE.md. The user narrowed this final continuation to necessary checks; no broad suite reruns. No commit/push.

Current expanded results: Core 1155 pass / 7 skip / 1 fail (Windows echo quoting); V1 3661 pass / 58 skip / 1 todo / 8 fail; app 752 pass / 3 fail (locale parity) plus browser 41 pass; session UI 85 pass; Desktop 107 pass / 2 fail / 1 module error (Bun node:sqlite; Node extensionless import in existing live import test); backend 195 pass / 1 fail (.env.example missing MEMORY_CHAT_CONTEXT_LENGTH), integration 38 pass. Root lint: 4993 warnings / 1 syntax error in unchanged V2 composer. Source/resource rebundling reached a locked active resources directory (EBUSY); live tests use a disposable copy of the freshly built backend bundle and do not stop the user's process. No READY claim until remaining self-acceptance is complete.

## Audit

- V1 Read/Glob/Grep/Edit/Write/Patch and V2 canonical leaves already exist.
- Reuse ToolRegistry, permission UI, Ripgrep (no symlink following), tool cards and Phase 9A turn budgets.
- Native mutation leaves lack the required atomic replacement and read-to-edit revision contract. Managed wrappers need a shared strict text/workspace policy; ordinary providers retain native tools.
- V2 registry names exclude dots. V1 retains Phase 9A dotted names; V2 uses underscore equivalents with identical contracts.

## Implementation

- [x] Shared canonical text paths, revisions, atomic mutation, size/write limits.
- [x] V1 registry adapters and V2 canonical registrations, permissions, OFF/capability gates, shared budgets.
- [x] Compact results, content-free audit and existing tool-card rendering.
- [x] Filesystem/security, V1/V2 exposure, cancellation and provenance tests.
- [x] Documentation and isolated live acceptance checklist.
- [x] Final targeted validation, Prettier and diff checks.

Outside-workspace operations are denied in this phase. No shell, git, browser, destructive delete/move or binary mutation is added. Each file commit is atomic; a multi-file turn is not a transaction.

## Validation — 2026-10-07

All counts below refer to distinct selected tests, not repeated debug runs.

| Check                                                                                          | Result                                                                   |
| ---------------------------------------------------------------------------------------------- | ------------------------------------------------------------------------ |
| Core workspace filesystem/security                                                             | 36 passed, 0 failed                                                      |
| Core V2 managed registrations/permissions/native Ripgrep/timeout                               | 5 passed, 0 failed                                                       |
| Core canonical registry regressions                                                            | 18 passed, 0 failed                                                      |
| Core V2 runner Gemma/Coder Build/Plan/OFF/ON/no-tools/continuation budgets and memory identity | 12 passed, 0 failed (87 unselected)                                      |
| Fork tool-result memory provenance                                                             | 1 passed, 0 failed (6 unselected)                                        |
| V1 managed workspace/exposure/budgets                                                          | 9 passed, 0 failed                                                       |
| V1 SessionTools regressions                                                                    | 3 passed, 0 failed                                                       |
| V1 HTTP schema OFF/ON/no-tools gate                                                            | 1 passed, 0 failed (31 unselected)                                       |
| Session UI presentation/error state                                                            | 2 passed, 0 failed                                                       |
| Existing backend worker file-result preference rejection                                       | 1 passed, 0 failed (27 unselected)                                       |
| Total selected tests                                                                           | **88 passed, 0 failed**                                                  |
| bun typecheck — core, opencode, session-ui                                                     | PASS in all 3 packages                                                   |
| Targeted oxlint — 22 touched TS/TSX files                                                      | 0 errors; 79 warnings outside changed lines in existing upstream modules |
| oxlint — 9 new TS/TSX files                                                                    | 0 errors, 0 warnings                                                     |

Prettier check: PASS on all 25 touched files. git diff --check: PASS (Git CRLF normalization notices only).

Backend validation ran only the existing worker regression with fake extraction output and an in-memory DB. No backend source, production DB/.env, Ollama/model configuration or installed OpenCode was changed. No model generation, full monorepo test/build, installer or GUI acceptance was run. No commit/push.

## Changed files

- TOOL_RUNTIME.md
- PHASE9B_PLAN.md
- PHASE9B_ACCEPTANCE.md
- packages/core/src/tool/workspace-files.ts
- packages/core/src/tool/workspace-operations.ts
- packages/core/src/tool/managed-workspace.ts
- packages/core/src/tool/turn-budget.ts
- packages/core/src/tool/builtins.ts
- packages/core/src/tool/tool.ts
- packages/core/src/tool/registry.ts
- packages/core/src/session/runner/llm.ts
- packages/core/test/tool-workspace-files.test.ts
- packages/core/test/tool-managed-workspace.test.ts
- packages/core/test/session-runner-message.test.ts
- packages/core/test/session-runner.test.ts
- packages/opencode/src/tool/workspace-tools.ts
- packages/opencode/src/tool/workspace-readonly.ts
- packages/opencode/src/tool/turn-budget.ts
- packages/opencode/src/tool/registry.ts
- packages/opencode/src/session/tools.ts
- packages/opencode/src/permission/index.ts
- packages/opencode/test/tool/workspace-readonly.test.ts
- packages/session-ui/src/components/workspace-tool.ts
- packages/session-ui/src/components/workspace-tool.test.ts
- packages/session-ui/src/components/message-part.tsx

## Acceptance outcome

Functional live acceptance was completed autonomously. See PHASE9B_SELF_ACCEPTANCE.md for actual commands/results and limitations. Built Desktop startup was automated at four viewport sizes: 1440 fits; the pre-existing shell overflows below 1143 px. File symlinks require unavailable Windows privileges; junction escape tests pass. Single-file atomicity, no multi-file rollback and the final OS syscall race remain documented in TOOL_RUNTIME.md.

Commit recommendation: **READY for review**, with disclosed existing suite/environment limitations.
