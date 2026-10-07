# Phase 9C — Self acceptance

## Implementation Status

Implemented the managed shell, focused test runner and owned background process tools. Commit recommendation: READY within the documented Windows-first scope. No commit or push performed. Backend source, installed Ollama/models and user configuration were not changed.

## Architecture Audit / Reused OpenCode Runtime

Audited V1 ShellTool, V2 BashTool, AppProcess/CrossSpawnSpawner, Shell, permission resolution, managed exposure, turn budgets and existing tool cards. Native tools remain intact for other providers. Execution uses upstream Effect child handles, streams, scoped finalizers and tree termination. Existing workspace realpath validation and bash permission architecture are reused.

## New Managed Runtime

V1 exposes shell.exec, test.run, process.start, process.status and process.stop. V2 exposes their underscore aliases through canonical Tool leaves. Both use the same command policy and execution implementation. Registry composition declares runtime dependencies explicitly. Existing shell-style cards render bounded output and errors; no terminal emulator or additional process manager UI was introduced.

## Shell Security Model / Risk Classification

Only a single literal invocation is accepted. Shell expansion, pipelines, redirection, chaining, encoded/elevated commands, direct destructive/system/network/install operations and unknown commands are rejected before execution. Classification includes SAFE_READ, SAFE_BUILD, SAFE_TEST, WRITE, DESTRUCTIVE, NETWORK, SYSTEM and PRIVILEGED. Accepted commands still require existing bash authorization. Text edits should use file tools. Project scripts and their transitive code execute with host-user authority after approval: this is not an OS sandbox or a guarantee against network/file access inside an approved script.

## Working Directory Security

Cwd is workspace-relative, canonicalized through realpath and checked against the effective workspace root. Absolute Windows/UNC paths, traversal and outside junctions are rejected. Cwd and node entrypoint are revalidated after permission and spawn-lock waits. Missing node entrypoints return COMMAND_NOT_FOUND. This closes the tested permission-wait replacement gap; it is not kernel-atomic protection against every filesystem race.

## Process Ownership / Process Tree Handling

Opaque handles are workspace/session-bound; arbitrary PIDs and foreign handles cannot be stopped. There are at most four concurrent jobs and 64 retained handles. Windows PowerShell joins a kill-on-close Windows Job before launching children, covering descendants whose intermediate parent has already exited. Setup failure prevents command execution. Upstream taskkill/tree finalizers remain in use. Handles are process-local and do not survive Desktop restart. POSIX deliberate daemon escape is outside the verified scope.

## Timeout / Cancellation / Output Streaming

Foreground defaults are 30 seconds for shell, 120 for tests and 180 for builds, capped at 300 seconds. Background lifetime is capped at 600 seconds. Timeout, foreground interruption, session cleanup and explicit stop release owned resources. Active V2 interruption cleans up the session's jobs; upstream idle V2 interruption remains a no-op, so idle background jobs use process.stop.

Stdout/stderr use separate UTF-8-safe recent tails, four KiB each. Oversized lines are omitted and truncation is reported. Known inherited secrets and credential-labelled values are redacted, including short/multiline secrets. V1 uses existing metadata progress updates; V2 has pending/completed cards and process status snapshots because upstream does not expose the same streaming metadata API. UTF-8 Cyrillic is tested; arbitrary legacy OEM output is not universally verified.

## Test Runner Strategy / Test Priority Policy

The model is instructed to run the direct reproduction or focused test first, then package/nearby regressions and affected checks. Broader suites require a technical reason. Nonzero exits remain visible, stable result identities support repeated-failure limits, and tests/builds reuse the shell runtime instead of creating a second runner.

## V1 / V2 / Tools OFF / Memory Provenance

V1 and V2 registration, permission gates and settlement tests passed. Tools OFF exposes no executable schemas for the managed models; real OFF runs passed for both Qwen and Gemma, and V2 Qwen. Other providers retain their native tool catalogs. Shell/test/process tool text is not user confirmation or a durable-memory source. Relevant session provenance and existing backend admission tests passed. The background memory worker itself was not rerun in this phase.

## Real Qwen3-Coder / Gemma E2E

Actual installed qwen3-coder:30b and gemma4:26b-a4b-it-q4_K_M ran against disposable workspaces/profiles and the bundled managed Gateway. Both V1 coding loops read the fixture, observed a failing focused test, edited the subtraction bug, obtained a passing test and successful build. Qwen also completed the V2 coding loop. Gateway model routing, canonical project headers, actual file changes, nonzero and zero exits and Tools OFF were asserted. Temporary data was removed.

The first combined run failed at Gemma OFF after successful coding loops because a cleanup service dependency was absent while integration code was being edited. The dependency was fixed; separate OFF acceptance then passed for both models. These model loops preceded the final cwd revalidation change; that change was verified with direct security regressions and a rebuilt Node sidecar, without repeating unaffected long model workflows.

## Security E2E

Actual Windows process tests cover denied execution, permission ordering, UTF-8 output, secret redaction, bounded output, invalid cwd/junctions, post-approval path replacement, timeout and foreground cancellation with child trees, owned background start/status/stop, foreign handles and arbitrary PIDs, concurrency limits, session isolation and orphan cleanup after parent exit.

## Build Status / Targeted Validation

- Typecheck passed: Core, opencode, session-ui and Desktop. Core was repeated after the final path change.
- Builds passed: Node sidecar, app and Desktop electron-vite. Node sidecar was rebuilt after the final path change.
- Targeted oxlint: zero errors, 61 warnings at the integration checkpoint; last two changed files: zero errors, two warnings. Warnings are not claimed as all upstream baseline.
- Prettier check passed for all changed source/documentation files; git diff --check passed.
- Existing Playwright smoke launched the real built Desktop in a temporary profile, reached visible UI, reported no page errors and cleaned up. Widths 360/768/1024 retain the known shell overflow; 1440 passed. This was a startup smoke, not visual acceptance of every tool card or permission popup.

## Bugs Found During Self-Test

| Bug or audited gap                                    | Fix                                             | Regression proof                                                          |
| ----------------------------------------------------- | ----------------------------------------------- | ------------------------------------------------------------------------- |
| PowerShell lost native nonzero exit code              | Capture success and preserve native exit code   | Actual exit 7 test passes                                                 |
| Classifier exceptions became Effect defects           | Lift classifier into typed Effect failure       | V1/V2 structured denial tests pass                                        |
| New aliases were absent from static bash deny mapping | Reuse bash permission mapping for all leaves    | Denied catalog tests pass                                                 |
| V1 cleanup runtime dependency was not supplied        | Capture cleanup in layer and declare dependency | Session cancel physically stops background process; real OFF rerun passes |
| Output byte bound and truncation disagreed            | UTF-8 byte-bound tails                          | Large output/Cyrillic tests pass                                          |
| Concurrent background starts raced capacity           | Serialize admission/spawn with semaphore        | Five starts allow four jobs                                               |
| Changing handles/duration masked repeated failures    | Exclude volatile fields from digest             | Stable failure digest regression passes                                   |
| Windows descendants could outlive intermediate parent | Kill-on-close Job before spawn                  | Actual parent-exits-first orphan test passes                              |
| Paths could change during approval wait               | Revalidate cwd and node entrypoint before spawn | Replacement-junction and missing-file regressions pass                    |

## Tests Run

### Critical tests

Final execution/security and canonical V2 leaves: **54 passed, zero failed, two files, 87 assertions**. This includes the final three path regressions. The preceding integration checkpoint covered 48 execution tests and three registry tests within the larger Core set below; these counts overlap.

### Relevant regressions

- Core affected set: **202 passed, zero failed, eight files, 548 assertions** (execution, registry, workspace, session/exposure/provenance, Location catalog, upstream process and shell).
- V1 affected set: **105 passed, zero failed, three files, 355 assertions** (workspace/catalog, session tools and native shell).
- Session UI mappings/errors: **two passed, zero failed, 30 assertions**.
- Existing backend admission/provenance: **nine passed, zero failed, one file**; backend source unchanged.
- Real V1 Qwen/Gemma coding loops, separate Tools OFF runs and real V2 Qwen coding loop/OFF: passed as described above.
- Isolated built Desktop startup smoke: passed with the recorded baseline small-width overflow.

### Broader tests

Full monorepo, installer and unrelated baseline suites were not run. Affected package builds and upstream process/shell regressions were included because execution/runtime integration changed.

## Known Baseline Failures / Remaining Untested Areas

The known Desktop shell overflow was observed at the three smaller widths. The app build retained a large-chunk warning. Prior symlink privilege, locale parity, unrelated prompt-input lint and live-Gateway EBUSY baselines were not repeatedly invoked. No new blocker remains in the executed checks.

Not verified: full installer, arbitrary legacy OEM encodings, POSIX daemon escape, all GUI tool-card/permission-popup visual interactions, and a complete memory-worker extraction acceptance. Those were not necessary to prove the changed Windows execution and provenance behavior.

## USER ACCEPTANCE / Commit Recommendation

Functional USER ACCEPTANCE: **NOT REQUIRED**; the shell/test/process and real model workflows are automated. GUI appearance beyond startup remains an explicitly unverified visual area. Commit recommendation: **READY**, with these scope limitations documented. No commit/push.
