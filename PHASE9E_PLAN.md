# Phase 9E — Local Profile / Usage Analytics

- [x] Read full task and audit provider metrics, session counters, workers, Desktop SQLite and Settings V2.
- [x] Record actual inference metadata at the provider boundary, including failure/cancel and continuations.
- [x] Pass metadata through an owned process pipe; persist with the existing Desktop node:sqlite stack.
- [x] Add local Profile/Usage overview, model breakdown, calendar ranges and confirmed clearing.
- [x] Test ingestion, duplicates, concurrency, aggregation, boundaries, migrations, privacy and restart.
- [x] Run real Qwen/Gemma/Memory worker/continuation acceptance with temporary data.
- [x] Validate affected packages and Desktop UI; document actual results and limitations.

## Decisions

Usage is independent of Durable Memory. Desktop owns a separate usage.sqlite using the existing node:sqlite library; no additional dependency, HTTP API or authentication. Gateway provider callbacks emit content-free metadata through a dedicated child-process pipe. Exact native counts/timings are retained; OpenAI-compatible worker responses provide exact counts with unavailable timing fields left null. Each actual provider invocation has one UUID; duplicate completion events share it. A genuine retry that performs inference is a new invocation and counts separately. Local calendar date uses the system timezone at inference start; tied record days select the later date. No historical backfill: existing session counters omit workers and do not reliably identify all historical inference boundaries. Only owned managed Gateway calls are collected in this phase; external Gateway/cloud providers require a future recorder integration.

## Completion evidence

- 77 focused tests passed: backend 34, Desktop recorder 9, Desktop Memory regressions 31, App calculations 3.
- Actual Qwen/Gemma/Memory/service/tool continuation: 7 requests, 3361 tokens, 3 agent sessions; exact provider-count equality. Gateway restart/reopen and additional collection passed.
- Actual built Desktop composer/Profile: 2 requests, 7166 tokens in final run; UI update, full Desktop restart, owned Gateway shutdown, persistent totals and confirmed clearing passed. Disposable profile removed.
- Usage UI verified at 360/768/1024/1440 and light/dark; no renderer page errors.
- Backend/Desktop/App/Core typechecks, Gateway bundle and Desktop production build passed. Backend targeted ESLint clean; fork targeted Oxlint 0 errors, 27 warnings. Prettier and diff checks passed.
- Full factual report and file inventory: `PHASE9E_SELF_ACCEPTANCE.md`. No commit/push. USER ACCEPTANCE: NOT REQUIRED. Commit recommendation: READY.

## Russian localization polish

- [x] Localized all 36 Usage keys through the existing Russian dictionary with a typed complete translation of the English fallback. No component hardcoding or analytics changes.
- [x] Added focused checks for locale parity/placeholders, Overview/Models/confirmation copy and component key coverage. Usage i18n/calculation tests: 6 passed, 258 assertions. App typecheck passed.
- [x] Targeted lint, Prettier and diff checks passed. Commit recommendation: READY; no commit/push.
