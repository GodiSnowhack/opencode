# Phase 9E — Local Profile / Usage Analytics

## Implementation Status

Implemented and focused acceptance passed. No commit or push performed.

## Architecture Audit

OpenCode assistant messages already contain provider usage, but these counters do not cover all Memory/background inference and are not a reliable historical inference ledger. Managed chat converts native Ollama responses; workers use the compatible chat endpoint. Desktop already uses `node:sqlite` for drafts. Settings V2 and the existing preload/platform bridge provide the integration points.

Reuse the Desktop SQLite stack in a separate `usage.sqlite` under Desktop app-data. The owned Gateway emits only measurement metadata through child process pipe FD 3. Desktop validates and persists it. Renderer reads aggregates or requests confirmed clearing through local Electron IPC. No HTTP API, authentication service, account or dependency was added.

## Usage Source of Truth

- Native Ollama: `prompt_eval_count`, `eval_count`, `total_duration`, `load_duration`, `prompt_eval_duration`, `eval_duration`; nanoseconds converted to milliseconds.
- Compatible worker responses: actual `usage.prompt_tokens` and `usage.completion_tokens`. Native evaluation/load timing is unavailable on this path and stays null; observed request duration is wall time.
- Embeddings: provider prompt count and available timings; output tokens are zero because embeddings generate no text. Vectors are not copied into usage metadata.
- Unknown token counts remain null. Aggregates sum only reported counts and show incomplete measurement counts. No tokenizer estimates or context-limit substitutions.

## Usage Event Schema

Generic interface: request ID, UTC start timestamp, start timezone, exact provider/model, agent/memory/service kind, nullable input/output tokens and timings, optional session/project IDs, success/cancelled/failed status.

SQLite additionally stores local day, timezone offset, derived total when both counts exist, and generation tokens/second when native generation duration permits it. Validation selects only these fields; prompt, response, system, file, memory and tool content are excluded.

## Storage / Migration

Separate WAL SQLite database, `synchronous=NORMAL`, 5-second busy timeout. Version-1 migration creates `usage_requests`, `usage_meta` and indexes for local day, provider/model/kind and agent session. Repeated startup is idempotent. Unsupported future schema versions disable the recorder rather than modifying that database.

## Idempotency

One UUID is created at the provider invocation boundary, retained through streaming/final/cancel, passed unchanged through the pipe, and protected by the SQLite primary key with `INSERT OR IGNORE`. Duplicate final delivery cannot change or duplicate the stored inference. A genuine new provider call, including retry or tool continuation, consumes new tokens and receives its own ID. Session/turn IDs cannot serve as inference IDs because several inferences belong to one turn.

## Agent / Memory / Service Classification

- User requests/coding agent: agent.
- Extraction, consolidation, profile and other calls using the worker provider, plus embeddings: memory.
- Existing auxiliary request-kind headers, including title generation and compaction: service.

All categories contribute to the global total. Worker calls without an agent session never increase the user-session count.

## Model Tracking

Exact provider and model tags are the grouping key; similarly named tags are not merged. Real acceptance covered `qwen3-coder:30b`, `gemma4:26b-a4b-it-q4_K_M`, and worker `qwen3:8b`.

## Daily Aggregation

Local calendar day uses the system timezone captured at inference start, with UTC timestamp and offset retained. Historical local days do not change after a timezone change. Today uses the current system calendar. A record is the sum for a calendar day; ties choose the later date. Charts cover 7/30/90 days including today, or all history. Long all-time histories use exact monthly sums; overview and model totals stay all-time.

## Session Metrics

Distinct non-null agent session IDs determine sessions. Several continuations count once as a session and separately as requests. Includes average input/output per measured request, average agent-session tokens, maximum request/session, known generation duration and duration-weighted generation speed. Unknown values are excluded from measured averages.

## Profile UI

Settings → Local Profile / Usage, visible where the Desktop Usage platform capability exists. Uses existing Settings V2 components, design tokens and dialog/navigation architecture. Data refreshes while mounted every 10 seconds and through Refresh; timer is cleaned up on unmount.

### Overview

Total, today, daily record/date, requests, sessions, average and maximum metrics, generation time/speed, daily chart, period buttons, collection start, empty/error/unknown states.

### Models View

Agent Models, Memory Workers and Service/background sections; exact model/provider, input/output/total, requests, share of global tokens and known generation speed.

## Privacy

Local-only metadata; no analytics endpoint or telemetry. No prompts, responses, tools, vectors, file paths or memory contents are stored by Usage. Session/project IDs are validated opaque identifiers. Diagnostics are static strings. Existing LLM communication is unchanged. Cloud/external Gateway usage is not collected and the UI states this scope explicitly.

## Clear Statistics

Existing confirmation dialog is reused. Clearing deletes usage rows and resets collection start; unrelated Memory, sessions, projects, settings and models are untouched. A persisted clear cutoff rejects late completion/replay of pre-clear inferences. New inferences continue to record.

## Failure Isolation

Observer sink, pipe framing and SQLite insert failures are caught with content-free diagnostics. Provider response bytes continue unchanged. SQLite startup failure disables Usage recording and the UI reports unavailable data. The bounded pipe is best-effort: unavailable or saturated recording may lose measurements rather than block generation.

## Performance

No second response consumer, per-token database writes or heavyweight chart dependency. Streaming observer forwards bytes and keeps bounded parsing state. One insert per completed/cancelled/failed inference; indexed SQLite aggregate queries run through IPC on refresh, not every render. Pipe buffering is bounded. This phase does not claim large-history performance benchmarking.

## Historical Backfill Decision

No backfill. Existing session data lacks complete worker/service coverage and stable historical inference identities. UI explicitly shows when this installation began collecting; historical missing usage is not estimated.

## Real Qwen3-Coder Usage E2E

PASS. Installed local model, actual provider calls through owned managed Gateway. Input/output event signatures match independently observed raw provider metrics. Agent Qwen total in the shared acceptance batch: 676 tokens.

## Real Gemma Usage E2E

PASS. Actual Gemma user inference and title inference tracked separately: 293 agent tokens, 279 service tokens in the acceptance batch.

## Real Memory Worker Usage E2E

PASS. Explicit user memory triggered the actual background extraction pipeline; completed `memory_jobs` observed read-only in the temporary DB. Worker `qwen3:8b` contributed 2113 tokens as memory. No Management API memory creation or production DB modification.

Combined batch: **7 requests, 3361 reported tokens, 3 agent sessions**. Sum of provider counts equals the ledger and global aggregate. Temporary bundle instrumentation observed only counts/timings for comparison; production code does not include that instrumentation.

## Tool Continuation Accounting

PASS. Qwen requested `fs_read`, the disposable workspace file was read, and the tool result sent through a second real inference. Exactly two different inference IDs in that session; tool execution creates no usage row. Returned answer included the actual test value.

## Restart Persistence

PASS for owned Gateway stop/restart and SQLite close/reopen: totals persisted, and a further Qwen inference increased them. Full built Desktop shutdown/relaunch also passed: owned Gateway exited, same temporary profile retained exact totals, Profile reopened and confirmed clearing reset usage. Final composer run recorded 2 requests / 7166 tokens (agent plus title). Temporary profile removed.

## Bugs Found During Self-Test

- Unknown token values initially diluted measured averages. Fixed with nullable SQL averages; failed/cancelled/unknown regression passes.
- Calendar grouping initially depended on recorder-time timezone. Capture timezone at provider start; timezone-change regression passes.
- Clear could allow delayed pre-clear events to resurrect statistics. Persist cutoff; delayed-final/replay regression passes and later requests record normally.
- Test harness initially proceeded on title usage before agent usage arrived. Poll actual agent-category measurement before checking UI totals.
- Existing isolated Desktop test hook keeps sessions in memory, so restored session is absent after restart. Harness returns Home before opening Settings; production session persistence was not changed.

## Tests Run

### Critical Tests

- Backend usage observer: **8 passed**, including streamed native counts/final duplication, compatible worker counts, unknown/malformed values, fail/cancel, sink isolation, real HTTP tool continuation with fake provider, and embeddings privacy.
- Desktop SQLite/receiver: **9 passed**, including idempotency, exact models/categories, session count, local midnight/DST/record ties/ranges, timezone changes, failure/unknown, clear replay, migration/reopen/two connections, whitelist and bounded framing.
- App calculation tests: **3 passed, 16 assertions**, covering gaps/ranges, long history and global shares.
- Actual local models/worker/tool continuation/Gateway restart: PASS as detailed above.
- Actual built Desktop: empty Profile, all periods, Models, cancel clear, composer inference, live totals, dark/light, responsive Usage panel, full restart, persisted totals and confirmed clear: PASS. No renderer page errors.

### Relevant Regressions

- Backend combined usage + managed-context + Gateway integration: **34 passed in 3 files** (includes the 8 new tests).
- Desktop Memory service/status/management: **31 passed, 121 assertions in 3 files**.

Total focused automated tests: **77 passed**; not counting live acceptance assertions as unit tests.

### Broader Tests

Full monorepo, installer and unrelated suites were not run.

## Build / Typecheck Status

Backend typecheck and packaged Gateway build: PASS. Desktop, App and Core typechecks: PASS. Electron Vite production build of Desktop main/preload/renderer: PASS. Targeted backend ESLint: PASS. Fork targeted Oxlint: 0 errors, 27 warnings, including existing upstream type assertions and recorder/test boundary assertions. Prettier and both repository diff checks: PASS. Build retains upstream eval/chunk/sourcemap warnings; no build errors.

## Known Limitations

- Collection covers this Desktop's owned managed Gateway. External/cloud adapters need future recorder integration; generic interfaces already allow this.
- Compatible worker endpoint does not expose native eval/load timing; token counts are exact, timing/speed unknown where unavailable.
- No unreliable historical backfill; no collection toggle (optional in specification).
- All 36 new labels have Russian localization; other locales retain the English fallback. Numbers/dates use the selected locale.
- Best-effort writes can lose usage on DB/pipe failure and do not claim billing-grade delivery.

## Remaining Untested Areas

Installer packaging, cloud providers, large-history stress and multi-OS-process writer stress were not exercised. Concurrency regression uses two SQLite connections in one Node process. Responsive checks cover Usage at 360/768/1024/1440; an existing onboarding tooltip outside Usage can overflow the surrounding page at 360. No unrelated tooltip redesign was made.

## Files Changed

### OpenCode fork

- `packages/core/src/usage/types.ts`
- `packages/desktop/src/main/{usage-store.ts,usage-store.test.ts,usage-pipe.ts,index.ts,ipc.ts,memory-service.ts}`
- `packages/desktop/src/preload/{index.ts,types.ts}` and `packages/desktop/src/renderer/index.tsx`
- `packages/desktop/scripts/{phase9e-live-acceptance.ts,phase9e-desktop-acceptance.mjs}`
- `packages/app/src/components/settings-v2/{usage.tsx,usage.css,dialog-settings-v2.tsx}`
- `packages/app/src/context/platform.tsx`
- `packages/app/src/i18n/{usage-fallback.ts,memory-fallback.ts}`
- `packages/app/src/usage/{model.ts,model.test.ts}`
- `PHASE9E_PLAN.md`, this report. Local screenshots: `output/playwright/phase9e/`.

### Memory Gateway repository

- `packages/ollama/src/{usage.ts,index.ts,embedding.ts}`
- `apps/gateway/src/{usage-pipe.ts,main.ts}`
- `tests/usage-observer.test.ts`, `PLAN.md`.

## USER ACCEPTANCE

NOT REQUIRED. Automated real-model and Desktop acceptance completed; no manual check requested.

## Commit Recommendation

READY. No commit/push performed.

## Russian localization polish

Russian Settings section is now "Статистика использования". Overview, Models, controls, privacy/coverage, empty/error/unknown states and clearing confirmation use Russian dictionary entries; English fallback remains unchanged. Backend, database and analytics semantics are unchanged.

Additional files: `packages/app/src/i18n/usage-fallback.ts`, `packages/app/src/i18n/ru.ts`, `packages/app/src/usage/i18n.test.ts`, and the phase plan/report. Focused Usage locale/UI-copy and calculation checks: 6 passed, 258 assertions. App typecheck, targeted lint, Prettier and diff check passed. These checks validate key resolution and component copy coverage; no new live-model or Desktop restart run was needed for this locale-only change.
