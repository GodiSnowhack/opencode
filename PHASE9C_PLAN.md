# Phase 9C — Shell / Test Runner / Process Manager

## Audit and plan

- [x] Read the complete Phase 9C request and applicable repository instructions.
- [x] Audit V1 ShellTool, V2 BashTool, AppProcess/CrossSpawnSpawner, Shell, permissions, managed catalogs, budgets and existing cards.
- [x] Implement shared managed command policy and owned execution using the existing spawner; reuse Phase 9B cwd validation.
- [x] Connect canonical leaves to V1/V2, preserve other providers and Tools OFF; support V1 progress without inventing a V2 progress protocol.
- [x] Test command security, permission ordering, output bounds/redaction, cancellation/timeouts, process ownership/tree cleanup and V1/V2 exposure.
- [x] Run focused regressions, affected typechecks/builds and real Qwen/Gemma disposable coding-loop acceptance.
- [x] Document results, limitations and commit readiness; no commit/push.

## Architecture decisions

The managed layer reuses AppProcess's upstream CrossSpawnSpawner (Effect child-process handles, stream consumption, scoped finalizers and Windows tree termination). It does not replace native Bash/Shell tools for other providers. A conservative single-command grammar excludes shell interpolation, redirection and pipelines; dangerous/system/network/install commands are denied rather than inheriting a broad Build allow rule. Approved project scripts still execute with host-user authority: workspace cwd validation is not an OS sandbox. Background handles are process-local, workspace/session-bound and expire automatically; they are not durable across Desktop restart. Managed Windows shells additionally join a kill-on-close Windows Job before starting children, covering intermediate-parent exit beyond upstream taskkill /T discovery.

## Results so far

- Final targeted Core set: 202 passed / 0 failed, 8 files (managed execution/security, V2 leaves, workspace regressions, session/exposure/provenance, Location catalog, upstream process/shell).
- Final targeted V1 set: 105 passed / 0 failed, 3 files (includes SessionPrompt.cancel physically stopping an owned background process).
- Session UI aliases/errors: 2 passed / 0 failed.
- Existing backend admission/provenance: 9 passed / 0 failed; no backend source changes.
- Typecheck: Core, opencode, session-ui, Desktop passed.
- Targeted oxlint: 0 errors, 61 warnings; broader baseline suites intentionally not rerun.
- Real V1 Qwen3-Coder and Gemma: failing test -> exact edit -> focused test PASS -> build PASS. Initial combined run then hit a cleanup-layer dependency error on Gemma OFF; fixed with explicit SessionPrompt dependency and cancellation regression. Separate OFF rerun passed for both models.
- Real V2 Qwen3-Coder: full coding loop and Tools OFF passed.
- Windows real process tests include timeout, foreground interruption, start/status/stop, foreign handles/PID rejection, concurrent limit and parent-exits-first orphan cleanup.
- Final post-approval path revalidation regressions: 54 passed / 0 failed across the two execution test files; Core typecheck passed again. This overlaps the 202-test checkpoint rather than adding 54 distinct tests.
- Node sidecar, app and Desktop builds passed. Node sidecar rebuilt after the last path fix.
- Isolated built Desktop startup passed, no page errors; 1440px has no horizontal overflow. Existing shell overflow remains at 360/768/1024px. Temporary profile removed.
- Final acceptance and limitations: PHASE9C_SELF_ACCEPTANCE.md. No commit/push.

## Validation policy

Run direct reproductions and critical affected regressions first. Broaden only for a concrete remaining risk. Never repeat known baseline failures merely to increase test counts.
