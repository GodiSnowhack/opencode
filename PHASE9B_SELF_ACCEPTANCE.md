# Phase 9B self-acceptance — 2026-10-07

## Implementation Status

Files/search/edit are implemented through the existing V1/V2 registries and permissions. Shared workspace policy enforces revisions, atomic single-file commits, UTF-8, path isolation and turn budgets. The user's final instruction narrowed the remaining validation to the failed memory scenario and changed-code checks; broad suites below were run before that narrowing. No commit or push.

## Automated Test Status / Tests Run

Counts describe individual runs and overlap; do not add them together.

| Directory       | Command                                                                                                                                                                                                                 | Result                                                                                                                                |
| --------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------- |
| core            | `bun run test`                                                                                                                                                                                                          | 1155 pass, 7 skip, 1 fail: unchanged Windows echo quoting                                                                             |
| core            | `bun test test/tool-workspace-files.test.ts test/tool-managed-workspace.test.ts test/tool-registry.test.ts test/session-runner-message.test.ts test/session-runner.test.ts test/location-layer.test.ts --only-failures` | 151 pass, 0 fail; Bun selected 5 existing files                                                                                       |
| opencode        | `bun run test`                                                                                                                                                                                                          | 3661 pass, 58 skip, 1 todo, 8 fail in initial broad run                                                                               |
| opencode        | `bun test test/tool test/session test/provider test/permission --timeout 30000 --only-failures`                                                                                                                         | 1675 pass, 20 skip, 1 todo, 0 fail                                                                                                    |
| opencode        | `bun test test/permission/next.test.ts test/session/revert-compact.test.ts --timeout 30000 --only-failures`                                                                                                             | 87 pass, 0 fail; resolves two 5-second timeout failures from the earlier critical run                                                 |
| opencode        | `bun test test/snapshot/snapshot.test.ts test/util/glob.test.ts test/cli/tui/editor-context-zed.test.ts test/tool/shell.test.ts --timeout 30000 --only-failures`                                                        | 172 pass, 3 skip, 5 fail: file-symlink creation EPERM                                                                                 |
| llm             | `bun run test`                                                                                                                                                                                                          | 298 pass, 30 skip, 0 fail                                                                                                             |
| session-ui      | `bun run test`                                                                                                                                                                                                          | 85 pass, 0 fail                                                                                                                       |
| app             | `bun run test`                                                                                                                                                                                                          | unit stage: 752 pass, 3 fail, unchanged `dv` locale parity; browser stage run separately                                              |
| app             | `bun run test:browser`                                                                                                                                                                                                  | 41 pass, 0 fail                                                                                                                       |
| desktop         | `bun test --only-failures`                                                                                                                                                                                              | 107 pass, 2 fail, 1 module error; Bun node:sqlite and existing Node extensionless import                                              |
| backend         | `pnpm test`                                                                                                                                                                                                             | 200 pass, 1 fail before the final system-message consolidation: pre-existing `.env.example` lacks optional MEMORY_CHAT_CONTEXT_LENGTH |
| backend         | `pnpm test:integration`                                                                                                                                                                                                 | 39 pass, 0 fail before final consolidation                                                                                            |
| backend         | `pnpm exec vitest run tests/managed-context.test.ts tests/injection.test.ts`                                                                                                                                            | final adapter/injection: 19 pass, 0 fail                                                                                              |
| backend         | `pnpm exec vitest run tests/integration/gateway.test.ts tests/integration/e2e-memory.test.ts --pool=threads --maxWorkers=1 --exclude dist/**`                                                                           | final focused integration: 13 pass, 0 fail                                                                                            |
| repository root | `bun run test`                                                                                                                                                                                                          | intentionally exits 1: upstream script says to run package tests                                                                      |

The initial focused Phase 9B selection had 88 distinct passing tests; see PHASE9B_PLAN.md for its breakdown.

## Real Model E2E Status

Disposable workspace/profile/database; real CLI or V2 runner → Desktop MemoryService → disposable copy of bundled Gateway → installed Ollama. No Management API creates memories and no SQLite writes seed live acceptance. Inspection APIs and read-only SQLite are used only for assertions/diagnostics.

- Qwen3-Coder: real search/read/exact edit/create two files/read verification and continuation PASS.
- Gemma: same filesystem workflow PASS, including exact Cyrillic file content.
- Tools OFF: Qwen and Gemma schemas absent; files unchanged. A stronger Gemma rerun also requires exactly one main request and no tool events: PASS.
- V2 Qwen runner: real filesystem workflow and OFF PASS after the streamed-index correction.
- Live permissions: DENY exposes no write/edit schemas and preserves the original; ASK is rejected by noninteractive CLI and creates no file. ALLOW performs actual commits.
- Live provenance: agent reads `User prefers Electron.`; qwen3:8b worker runs; no global Electron preference is saved.

Commands (from desktop): `bun scripts/phase9b-live-acceptance.ts --coder-only`; default workflow (initial Coder pass, Gemma timing failure); `--gemma-only` (workflow pass); `--gemma-only --off-only` (strong OFF rerun); `--v2 --coder-only`; `--extended` (permissions/provenance); final `--extended --memory-only --retrieval-only` (extraction/retrieval/restart).

## Security Validation

Core filesystem tests exercise actual disposable files: traversal, absolute/UNC/device/ADS paths, outside-workspace paths, junction escape and parent replacement, same-session trusted reads, stale revisions, no-match/ambiguous edits, binary/invalid UTF-8, file/patch/aggregate byte limits, maximum files, concurrent commits, cancellation and failed rename cleanup. V1/V2 tests cover permissions and timeout/budget boundaries. Regular Windows file symlinks cannot be created in this environment (EPERM); junction escape tests pass. No system-file writes are attempted.

## V1 Status / V2 Status

V1 critical suite and real Coder/Gemma workflows pass. V2 canonical registry/runner tests and real Coder workflow pass. Ordinary-provider attached tool context retains its prior shape. V1 dotted and V2 underscore names retain their existing architecture.

## Memory Regression Status

Final clean-profile live run PASS:

1. Real user: `Запомни для этого проекта: отчёты проверки Phase 9B хранятся в каталоге phase9b-verified-logs.`
2. Automatic worker creates active `project_state` under the canonical project ID; sources API points only to the real user message.
3. New session, Tools OFF, original Russian question: answer is exactly `phase9b-verified-logs`.
4. Stop owned Gateway, verify stopped, start healthy, another new session: same exact answer.
5. Temporary profile/database/workspace removed in finally.

Synthetic memory context is injected after history capture; the final native conversion merges leading policy/context into one system message without mutating input history. Unit tests also verify project isolation and unchanged original messages. This is a managed-service restart, not a fresh packaged Desktop restart acceptance.

## Model Routing Status

Disposable-bundle fetch instrumentation logs only model/path and memory-block presence. Coder agent calls use native `/api/chat` with `qwen3-coder:30b`; worker calls use `/v1/chat/completions` with `qwen3:8b`. Gemma agent requests use its installed model ID. Simultaneous Gemma-agent/worker activity was not separately repeated in the final narrowed run.

## Build Status / Targeted Validation

- Six-package Turbo typecheck: core/opencode/app/desktop/session-ui/llm PASS; app E2E typecheck PASS.
- App production build PASS; Desktop main/preload/renderer build PASS; fresh Node sidecar build PASS; Windows CLI build/version smoke PASS.
- Final backend `pnpm package:gateway` builds and packages the changed adapter: PASS.
- Backend typecheck/lint/read-only memory:check PASS before final consolidation; final changed-code typecheck/lint and both Git diff checks are recorded in PLAN.
- Prettier on changed fork files PASS. Targeted fork lint: 0 errors, 89 warnings in the expanded set; root lint retains 4993 warnings/1 unchanged octal-escape error.
- Node/Playwright launched the built Electron Desktop with isolated app-data/documents. No page errors; 1440 px fits. The existing shell is 1143 px wide and overflows at 360/768/1024 px, as previously documented in backend PLAN. Bun/Playwright launch failed; Node automation succeeded.
- Desktop Gateway resource rebundling hit EBUSY because a user's existing process holds resources. It was preserved; live tests used a fresh disposable bundle. No installer build was requested for this final fix.

## Bugs Found During Self-Test

1. Native streamed calls reset index to zero in each fragment; V2 parser received a delta without its call start. Maintain monotonically increasing indices. Unit, Gateway/replayed-history integration, real V2 workflow pass.
2. Gemma can emit unsolicited calls with empty schemas; native adapter surfaced phantom cards/continuations despite rejecting execution. Suppress unavailable calls and finish normally. Streaming/nonstreaming tests and strict real Gemma OFF rerun pass.
3. Admission interpreted report labels or `verified` inside a directory name as proof of completed verification. Narrow explicit project-location handling; retain scope, user-source, secret, confidence and completion restrictions. Negative controls and real automatic extraction pass.
4. The native model ignored the second leading system message containing retrieved memory. Consolidate leading system/developer blocks in order. Input token count increased from 2092 to 2205; real answer and post-restart answer now match the saved value. Adapter and injection regressions pass.
5. Broad suites exposed stale catalog assertions and an ordinary-provider turnID change. Correct expectations and scope turnID to managed provider. Core selected tests and ordinary-provider suite pass.
6. Managed V1 guidance still called the expanded registry read-only. Replace it with workspace/read-before-edit guidance.

Harness-only corrections: V1 prompt uses stdin to avoid Windows argv quote artifacts; management reads explicitly query project scope; Node drives Electron automation; test scheduling is isolated from unrelated background batches. These are not production extraction fixes.

## Files Changed

Original Phase 9B implementation list is in PHASE9B_PLAN.md. Additional fork files: location-layer test, V1 prompt guidance, `packages/core/script/phase9b-live.ts`, `packages/desktop/scripts/phase9b-live-acceptance.ts`, `packages/app/e2e/phase9b-desktop-smoke.ts`, acceptance/plan/report documentation.

Backend: `packages/ollama/src/index.ts`, `packages/ollama/src/managed-chat.ts`, `packages/workers/src/admission.ts`, `tests/managed-context.test.ts`, `tests/injection.test.ts`, `tests/memory-admission.test.ts`, `tests/integration/gateway.test.ts`, PLAN.md.

## Known Existing Issues / Remaining Untested Areas

Broad suite failures above remain; the initial V1 run did not retain all eight failure names, so they are not all claimed individually classified. The critical changed-function suite passed on rerun. No installer installation, packaged GUI restart, or interactive tool-card screenshot acceptance was added. Final live persistence uses Qwen3-Coder; Gemma combined worker/restart was not repeated after scope narrowing. No multi-file rollback or OS-level compare-and-swap guarantee is introduced.

## USER ACCEPTANCE

NOT REQUIRED for the narrowed functional acceptance. Existing shell visual overflow and unrelated suite failures are disclosed, not assigned to the user as backend retests.

## Commit Recommendation

READY for review of this Phase 9B change, with existing broad-suite/resource limitations disclosed. Raw local phase9b*.log evidence remains: automatic approval rejected pattern-based cleanup as insufficiently proven ownership. Exclude these temporary logs from any later commit. Disposable live workspaces/databases and failed GUI profiles created by this run were removed. No commit/push performed.
