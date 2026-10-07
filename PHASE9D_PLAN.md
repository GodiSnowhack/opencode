# Phase 9D — Git

- [x] Read full specification and audit upstream Git, process, workspace, permission and V1/V2 tool paths.
- [x] Implement shared managed Git operations using upstream discovery/history and AppProcess argv execution.
- [x] Protect explicit staging, user changes, review freshness, staged scope, secrets, restore and remote operations.
- [x] Integrate canonical V2 and existing V1 tools, permissions, exposure, UI mappings and provenance.
- [x] Run critical disposable-repository tests and closest regressions; fix failures.
- [x] Run real Qwen/Gemma acceptance, affected typecheck/build/lint/format and final diff review.
- [x] Record actual results and remaining limitations; no commit/push of this repository.

## Decisions

Reuse Core Git repository discovery/history and upstream AppProcess; add missing agent operations without replacing the upstream snapshot/index engine. Trusted scope is the active workspace directory even when repository root is an ancestor. File runtime records process-local session write provenance; pre-existing mixed changes require fresh approval. Review tokens are session-bound and checked again after permissions. Remote and restore requests force an existing permission ASK rather than accepting broad agent allow rules. No arbitrary Git argv, repository URL, force operation or automatic init is exposed.

## Validation

- Final critical Git/V2/permission set: 35 passed, zero failed, three files, 144 assertions.
- Core integration checkpoint: 105 passed, zero failed, seven files, 279 assertions. Counts overlap with the critical set.
- V1 Git/workspace/permission set after final permission fix: 35 passed, zero failed, three files, 174 assertions.
- Targeted managed Gateway/tool gate/continuation: 11 passed, zero failed, 88 filtered out.
- Session UI aliases/status: three passed, zero failed, 84 assertions.
- Actual Qwen V1/V2 and Gemma V1 task-only commits and Tools OFF: passed. Corrected Gemma fixture with a distinct project directory also passed without Raw History capture warnings.
- Desktop permission auto-response: 15 passed, zero failed, 19 assertions; mandatory ASK cannot be answered automatically.
- Typecheck: Core, opencode, app, session-ui, ui passed.
- Builds: Node sidecar, app and Desktop passed; no installer.
- Final targeted lint: zero errors, 76 warnings across 27 changed source/test files. Prettier and git diff --check passed.
- Existing repository HEAD remains 01444019d1; test commits/pushes were confined to disposable repositories.
