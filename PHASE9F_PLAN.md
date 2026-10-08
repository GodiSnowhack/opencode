# Phase 9F — HTTP / API Tools

- [x] Read the full specification; audit V1/V2 registry, permission mandatory-approval path, existing webfetch, process policy and usage boundaries.
- [x] Implement one shared Core HTTP policy and pinned Node transport with bounded payloads/results, cancellation, redirects and content-free audit.
- [x] Register V1 `http.request` / V2 `http_request`; reuse mandatory confirmation, Tools OFF, cards and tool provenance.
- [x] Add deterministic HTTP/security/permission/registry tests and closest regressions.
- [x] Run isolated real Qwen/Gemma V1 and V2 local API workflows; verify cleanup, continuation usage and provenance.
- [x] Validate affected packages, Desktop startup/composer/card smoke and document actual acceptance/limitations.

## Acceptance evidence

Real Qwen V1: full read/start/GET500/POST201/GET/edit/restart/GET200/stop workflow, 4 HTTP confirmations, 11 workflow inferences; Tools OFF adds one inference with no schemas/calls.
Real Gemma V1: GET/POST201/GET in three ordinary turns, 3 confirmations, 6 workflow inferences; Tools OFF adds one inference.
Real V2 Qwen/Gemma: each executes 3 HTTP calls with 3 confirmations; Qwen 8 inferences and Gemma 7 including Tools OFF.
Built Desktop: ordinary composer, actual permission click, Node HTTP200 card and tool-role Raw History; card bounds checked at 360/768/1024/1440, no page errors, owned Gateway shutdown verified.
Focused validation and complete limitations: `PHASE9F_SELF_ACCEPTANCE.md`. No commit/push.

## Decisions

Existing webfetch remains for ordinary providers; managed catalog already excludes it. Its generic fetch client cannot guarantee endpoint pinning. The new leaf reuses canonical Tool/Permission/turn budgets and Node networking, with an explicit pinned lookup and peer validation; no new dependency, browser or executable registry. Local/internal and every write/auth request require approval even under saved/global allow. Protected addresses/system ports cannot be overridden by approval. Secrets can use trusted process-only named environment references bound to exact origins; no credential UI/database or plaintext credential persistence. Phase 9E uncommitted changes are preserved.
