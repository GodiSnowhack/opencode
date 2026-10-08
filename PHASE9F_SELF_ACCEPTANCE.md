# Phase 9F — Self acceptance

## Implementation Status

Implemented. No commit or push. Phase9E working-tree changes were preserved.
Phase9F changes are in the fork only; installed Ollama/models, user OpenCode
configuration and the sibling backend source were not changed.

## Architecture Audit

Inspected native webfetch, provider clients, V1/V2 canonical registries,
mandatory Permission approval, cancellation/turn budgets, Phase9C command policy,
shared BasicTool cards, existing redactor, Gateway Usage and worker admission.

## Reused Network Runtime

Reuses Node HTTP/HTTPS and existing Tool/Permission/Effect lifecycles. Native
webfetch's generic fetch transport cannot ensure IP pinning; it stays intact for
ordinary providers. One Core leaf policy/transport serves both managed runtimes.
No new dependency, browser, credential vault or secondary execution registry.

## HTTP Tool Catalog

V1 `http.request`, V2 `http_request`: GET/HEAD/POST/PUT/PATCH/DELETE. Managed-only;
ordinary provider behavior stays unchanged. HTTP uses existing cards, not a new
API-client UI. Reserved V1 names cannot be replaced by custom tools.

## Request / Response Schemas

Optional query/headers, JSON/text/form body, timeoutMs and named credentialProfile.
Structured bounded status/headers/body/type/duration/final URL/redirects/bytes/
error/truncation. HTTP404/500 are HTTP exchanges; invalid JSON, binary content and
oversized bodies are reported explicitly. Exact limits are in TOOL_RUNTIME.md.

## URL Validation

Only normalized HTTP/HTTPS; embedded credentials, invalid protocols, control
characters, backslashes, fragments and invalid hosts fail before transport.
Numeric/hex/encoded IPv4 forms normalize before address checks.

## SSRF Protection

DNS answers are checked individually. Metadata/link-local/special/mapped IPv6,
unspecified/broadcast and protected admin/database/Ollama/Gateway ports cannot
be approved. Local/private/ULA developer APIs require independent confirmation.

## DNS / Redirect Protection

Literal IP connection with original Host/SNI and explicit pinned lookup, no
pooled agent; Node checks socket peer. Bun compatibility lacks remoteAddress,
so the runtime pins the literal URL and rejects ambient proxies. This constraint
was verified against [Bun 1.3.14 HTTP client source](https://raw.githubusercontent.com/oven-sh/bun/bun-v1.3.14/src/js/node/_http_client.ts).
Every redirect is validated again. Public-to-internal, HTTPS downgrade, excessive
redirects and credential cross-origin redirects are blocked. Mixed DNS answers
cannot hide the fact that the first pinned connection was public.

## Permission Policy

Existing requireApproval overrides allow/saved Always, preserves deny, and blocks
Desktop auto-accept. All requests ask, including public reads. The existing
dialog displays method, origin/path, risk/auth presence, payload size/type only.
Actual localhost confirmations were exercised in both runners and Desktop.

## Authentication / Credential Safety

Origin-bound trusted process profiles reference env names for Bearer/API key/
Basic. No secret UI, plaintext vault or persistence. All three modes and origin
refusal were tested. Raw/escaped echoes and encoded Basic authorization are
redacted before header truncation; JSON structure is preserved. Authenticated
truncated response previews are omitted to avoid partial-secret disclosure. Audit contains neither token nor body.

## Headers / Payload Safety

Host/transport/proxy/authorization/cookie headers from model arguments are denied.
Sensitive query/body credentials are refused. Response cookies/auth headers are
removed. Inputs/results have explicit bounds; multipart/binary uploads are absent.

## Timeout / Cancellation

DNS and sockets are bounded/abortable at the tool boundary; active streams are
destroyed. Interrupted fibers release concurrency slots. Failed DNS contributes
to cumulative network time. Both aliases have a 35-second outer deadline rather
than V2's unrelated 10-second default. Network timeout is capped at 30 seconds.

## Retry / Rate Limits

No automatic retries, especially writes. HTTP429/Retry-After are returned.
Eight requests and 30 seconds cumulative network time per session/turn; two
concurrent requests per scoped runtime. Generic agent budgets remain effective.

## Local API Workflow

Temporary workspace/profile/database and owned managed Gateway only. Mock APIs
bind loopback on free ports; Qwen owns its Node server through process tools.
No Management API memory creation, production DB writes or external API writes.

## External API Restrictions

Public reads/writes still require approval; real external endpoints were not
contacted for acceptance. Controlled resolver/transport tests cover public
approval, rebinding/redirects and unsafe endpoints without contacting them.

## Shell Bypass Limitations

Existing command policy rejects curl/wget, PowerShell HTTP/encoded invocations,
inline Node/Python networking. Approved project scripts still have host-user
authority; this is not an OS sandbox or absolute network isolation.

## V1 Status

PASS: managed Qwen/Gemma exposure, deny-before-connect, stale OFF execution guard,
real saved-Always/configured-deny behavior and actual model workflows.

## V2 Status

PASS: canonical Tool materialization/settlement, trusted source/turn context,
permission filter and stale OFF guard. Real Qwen and Gemma GET/POST/GET passed.
The harness observes the actual runner-scoped Permission service and replies
once; it does not replace permission evaluation or transport.

## Tools OFF Status

PASS for Qwen and Gemma in V1 and V2: no executable schemas/HTTP calls. Canonical
leaf independently rejects stale invocation. Existing Build/Plan and ordinary
chat/Memory behavior remain covered by nearest regressions.

## Memory Provenance

Desktop Raw History contains the real API response as tool-role content; its
"User prefers Electron." text is absent from user-role sources. Existing worker
test rejects exactly that phrase as a user preference/confirmation. Admission,
worker and injection regressions passed. A real memory-worker extraction run
was not added here: acceptance scheduler was isolated from API timing tests.

## Usage Analytics Regression

Gateway event stream recorded real continuation inference: Qwen V1 12 and Gemma
V1 7; Qwen V2 8 and Gemma V2 7, including one Tools OFF inference in each run.
HTTP execution emits no inference Usage event. Existing observer/UI tests passed.

## UI Tool Cards

Reused BasicTool, status handling and bounded text output. Both aliases show
HTTP method/path, status/duration or structured error code; no credentials/query
in the title. Actual built Desktop composer GET/permission/card passed through
Node transport. HTTP card bounds passed at 360/768/1024/1440; no page errors.
Screenshots: output/playwright/phase9f/startup-{width}.png. 360 and 1024 reviewed.
Presentation lookup benchmark: 1M existing aliases, baseline 2.715 ms / after
1.901 ms; this is a bounded helper benchmark, not a full timeline benchmark.

## Real Qwen3-Coder E2E

PASS, installed qwen3-coder:30b. V1: fs.read → process.start → GET500 → POST201 →
GET stored payload → fs.edit → stop/start → GET200 → process.stop. Four HTTP
confirmations, 11 workflow inferences; server stopped, no orphan. OFF: one
inference, no schemas/tools. V2: project fs_read then GET/POST201/GET, three
confirmations, eight inferences including OFF. No plain-text XML fallback.

## Real Gemma E2E

PASS, installed gemma4:26b-a4b-it-q4_K_M. V1 GET/POST201/GET in ordinary consecutive
turns verifies stored data: three confirmations, six inferences plus one OFF.
V2 same HTTP sequence: three confirmations, seven inferences including OFF.
All owned APIs/Gateways/processes and temporary profiles cleaned up.

## Security E2E

| Requirement             | Evidence                                                    |
| ----------------------- | ----------------------------------------------------------- |
| A Public GET permission | Controlled public resolver/transport, mandatory metadata    |
| B Localhost approval    | Real runtime server, V1/V2 models and Desktop               |
| C POST confirmation     | Real 201 requests; saved/global allow cannot bypass ASK     |
| D DENY no request       | Actual local server hit count unchanged                     |
| E Protocol restriction  | file/ftp and embedded credentials refused                   |
| F Metadata              | IPv4/link-local/mapped IPv6 and protected ports refused     |
| G Public → private      | Pure and mixed DNS redirect tests, one transport only       |
| H Rebinding             | Mock resolution plus real virtual-host request to pinned IP |
| I Embedded credentials  | INVALID_URL before transport                                |
| J Unsafe headers        | Host/auth/cookie/connection checks                          |
| K Timeout               | Actual slow local response and hanging DNS                  |
| L Cancellation          | Fiber interruption and caller AbortController               |
| M Oversize              | Actual 20 KiB response bounded to 8 KiB                     |
| N Loop                  | Actual local redirect loop capped at three redirects        |
| O Tools OFF             | Real models V1/V2 plus stale leaf guard                     |
| P V1/V2                 | Shared policy, registry and real model workflows            |
| Q No secret audit       | Logger capture, all credential modes, escaped echoes        |
| R Provenance            | Real Desktop Raw History plus worker/admission regressions  |

Actual self-signed TLS rejection, unavailable server, HTTP404/500, malformed JSON
and mixed DNS failure passed. TLS verification was never disabled.

## Bugs Found During Self-Test

| Finding                                                                               | Fix / proof                                                                                                   |
| ------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------- |
| Bun Windows env enumeration omits newly set HTTP_PROXY                                | Direct known-key reads; fail-closed proxy test                                                                |
| Bun compatibility request close precedes response end                                 | Retain abort listener until stream settles; timeout/cancellation tests                                        |
| V2 outer deadline was generic 10s                                                     | Both HTTP aliases use 35s; focused regression                                                                 |
| JSON escape/short secret redaction could corrupt structure or miss an escaped echo    | Decode JSON first, redact string values/keys; escaped credential regression                                   |
| Failed DNS did not consume cumulative budget                                          | Ensuring charges failures; deterministic failed-DNS budget test                                               |
| Mixed DNS could hide initial public connection during redirect                        | Classify initial pinned endpoint; one-transport regression                                                    |
| Harness inherited server authentication / parsed empty prompt_async response          | Own random temporary auth and HTTP204 handling                                                                |
| V2 harness polled a different location Permission instance                            | Observe actual runner service with original dependencies/tag; real approval PASS                              |
| Qwen simple V2 prompts sometimes printed XML instead of calling                       | Real project read/API workflow passed; no executable text fallback introduced                                 |
| Desktop harness conflicted with existing debug port and used invalid test-root naming | Own validated onboarding root and test-only wrapper preserving free debugger port; composer/card/cleanup PASS |
| Global shell geometry checked before/independently of the new card                    | Check real completed HTTP card at four widths; preserve unrelated layout                                      |

## Tests Run

Counts are per command and overlap; do not sum repeated focused runs.

| Command / scope                                               | Result                                                                 |
| ------------------------------------------------------------- | ---------------------------------------------------------------------- |
| Core HTTP + canonical V2 registry, final                      | 14 PASS, 0 FAIL, 212 assertions, 2 files                               |
| Core nearest registry/FS/process/Git/permission set           | 121 PASS, 0 FAIL, 439 assertions, 8 files; includes earlier HTTP tests |
| V1 HTTP + session exposure                                    | 5 PASS, 0 FAIL, 20 assertions, 2 files                                 |
| Session UI workspace/HTTP cards                               | 4 PASS, 0 FAIL, 92 assertions                                          |
| App mandatory auto-response                                   | 15 PASS, 0 FAIL, 19 assertions                                         |
| App Usage model/i18n                                          | 6 PASS, 0 FAIL, 258 assertions                                         |
| Backend observer/admission/worker/injection, unchanged source | 52 PASS, 0 FAIL, 4 files                                               |

New tests: thirteen shared HTTP runtime/security cases, one canonical V2 case,
two V1 catalog/permission cases and one UI card case (17 total).

Reproduction commands, from the named package roots:

```text
core: bun test test/tool-managed-http.test.ts test/tool-http-registry.test.ts --only-failures
core: bun test test/session-runner-tool-registry.test.ts test/tool-http-registry.test.ts test/tool-managed-http.test.ts test/tool-managed-workspace.test.ts test/tool-managed-execution.test.ts test/tool-execution-registry.test.ts test/tool-managed-git.test.ts test/permission.test.ts --only-failures
opencode: bun test test/tool/http-tools.test.ts test/session/tools.test.ts --only-failures
session-ui: bun test src/components/workspace-tool.test.ts --only-failures
app: bun test src/context/permission-auto-respond.test.ts --only-failures
app: bun test src/usage/model.test.ts src/usage/i18n.test.ts --only-failures
backend: pnpm exec vitest run tests/usage-observer.test.ts tests/memory-admission.test.ts tests/worker.test.ts tests/integration/context-injection.test.ts --pool=threads --maxWorkers=1
fork: bun run packages/desktop/scripts/phase9f-live-acceptance.ts --coder-only
fork: bun run packages/desktop/scripts/phase9f-live-acceptance.ts --gemma-only
fork: bun run packages/desktop/scripts/phase9f-live-acceptance.ts --v2 --coder-only
fork: bun run packages/desktop/scripts/phase9f-live-acceptance.ts --v2 --gemma-only
fork: node packages/desktop/scripts/phase9f-desktop-smoke.mjs
```

## Build / Typecheck Status

Core/opencode/app/session-ui/desktop targeted typechecks passed. Affected Node
sidecar and Desktop electron-vite builds passed using the repository models.dev
snapshot. Targeted lint has no errors; new files have no warnings (10 files), 45 inherited
warnings in edited upstream files are retained. Changed-file Prettier and
git diff --check passed. No full monorepo or installer build.

The final standard `bun run build` reached prebuild but stopped with Windows
EBUSY while replacing resources/memory-gateway used by the existing Desktop.
The application was not restarted or stopped. Direct `bunx electron-vite build`
validates Desktop compilation without repeating resource replacement.

## Files Changed

- Core: src/tool/http-network.ts, managed-http.ts, http-tools.ts (new); builtins.ts,
  execution-tools.ts and src/session/runner/llm.ts (small registration/deadline changes).
- V1: packages/opencode/src/tool/http-tools.ts (new), registry.ts.
- UI: packages/session-ui/src/components/message-part.tsx, workspace-tool.ts,
  workspace-tool.test.ts; no layout/style or locale changes.
- Tests: packages/core/test/tool-managed-http.test.ts, tool-http-registry.test.ts;
  packages/opencode/test/tool/http-tools.test.ts (new).
- Harness: packages/core/script/phase9f-live.ts; packages/desktop/scripts/
  phase9f-live-acceptance.ts, phase9f-desktop-smoke.mjs (new).
- Documentation: PHASE9F_PLAN.md, PHASE9F_SELF_ACCEPTANCE.md (new), TOOL_RUNTIME.md.

## Known Limitations

Process-only credential references; no persistent vault/editor or OAuth refresh.
Ambient proxies fail closed. No OS network sandbox, uploads/browser rendering,
unbounded downloads, cookie jar or automatic retry. Slow human confirmation may
reach the existing outer deadline. Bun emits an upstream socket-listener warning
during longer model workflows; actual HTTP/cleanup assertions passed. Native
model text sometimes resembles a tool call; it is never executed as one.

## Remaining Untested Areas

No real public API, live hostile DNS rebinding service, enterprise proxy or trusted
custom-CA success scenario. DNS/rebinding protection is deterministic plus real
pinned-local integration; self-signed TLS rejection is real. TLS fixture creation
uses installed Git OpenSSL on this Windows host. No live memory-worker extraction
or packaged installer/restart acceptance was repeated; related backend regressions
and built Desktop startup/composer smoke passed.

## USER ACCEPTANCE

NOT REQUIRED for Phase9F. Real model workflows, security and the actual Desktop
permission/card/provenance flow were checked automatically.

## Commit Recommendation

READY for review with the above boundaries. No commit/push performed.
