# Phase 9B — Managed Files / Search / Edit

## Architecture and audit

Desktop uses V1 SessionPrompt/SessionTools/SessionProcessor; V2 uses canonical Core Tool.make, Tools.Service, ToolRegistry and SessionRunner. Existing tool calls/results/continuation, permissions, Ripgrep and tool cards are reused. No new transport, provider adapter, executable registry or permission UI was added.

Native Read/List/Glob/Grep/Edit/Write/Patch remain available to ordinary providers. V1 native Edit/Write write directly. V2 mutations guard changes after permission approval but do not require an earlier read revision. These implementations do not satisfy the combined atomic-write/read-to-edit contract. Managed-only leaves therefore share WorkspaceFiles policy and workspaceOperation.

## Catalog

| V1           | V2           | Operation                         | Permission   |
| ------------ | ------------ | --------------------------------- | ------------ |
| project.info | project_info | Safe directory label/capabilities | read catalog |
| fs.list      | fs_list      | Bounded directory list            | read         |
| fs.read      | fs_read      | UTF-8 page and trusted revision   | read         |
| fs.glob      | fs_glob      | Native Ripgrep filename glob      | glob         |
| fs.search    | fs_search    | Native Ripgrep text search        | grep         |
| fs.write     | fs_write     | Explicit create or full replace   | edit         |
| fs.edit      | fs_edit      | Exact replacement                 | edit         |

V2 names prohibit dots; underscore names have identical contracts. V1 reserved names cannot be replaced by plugins. Managed providers receive this file catalog plus the Phase 9C execution catalog below; ordinary providers retain native tools. No model ID special case exists.

Agent Tools OFF removes every executable schema on the managed provider/configured Gateway route, regardless of Build/Plan. Managed models without tool capability receive no schemas. ON restores the permission-filtered catalog. V2 refuses managed calls that were not advertised, without starting continuation. V1 excludes MCP/plugins from managed exposure.

## Workspace security

The runtime supplies workspace/session/stable turn identity. Model arguments supply relative names only. Canonical root is pinned on first use. Reject absolute Windows/Unix paths, drive-relative prefixes, UNC/device paths, ADS colons, traversal, NUL, reserved Windows names and trailing dot/space aliases. Realpath validates existing targets and immediate create parents. Symlink/junction escape, including a parent changed during a permission prompt, is denied. Outside access has no approval override.

File tools are UTF-8 only: reject invalid UTF-8, NUL/control bytes and known binary extensions; retain BOM and source line endings for exact edits. Search never follows symlinks, filters binary/oversized/non-UTF-8 results and revalidates disclosed paths. These file tools do not expose Git, browser, delete/move or binary mutation.

## Write/edit, revision and atomicity

write defaults to mode=create and never overwrites. mode=replace requires a prior trusted read in the same session. edit requires exact oldString/newString; no match fails, ambiguous match requires explicit replaceAll. Parents must exist. Model-supplied expectedHash cannot substitute for a trusted read. Revisions are keyed by session/canonical filename and checked before permission and again before commit; stale files require rereading.

Commit validates a complete plan, requests existing edit permission, creates an exclusive random temporary sibling, writes, flushes and closes, revalidates path/revision, then commits. Replacement uses same-directory rename; creation uses an atomic exclusive hard link plus temporary-name cleanup to prevent overwriting a concurrent winner. IO failure before replacement preserves the original. Cooperating commits serialize per canonical target. Unsupported filesystems fail without non-atomic fallback. Single-file atomicity does not imply a multi-file transaction.

Existing permissions decide ALLOW/ASK/DENY. Plan/read-only edit denial hides mutation definitions and remains enforced at invocation. Permission UI receives a bounded relative-filename diff preview with previewTruncated for long files. This does not change full revision checks. Denial causes no write; approved/root/session arguments have no authority.

## Limits and cancellation

| Limit                                      | Value                            |
| ------------------------------------------ | -------------------------------- |
| UTF-8 read/write file                      | 512 KiB                          |
| Exact edit old/new patch bytes             | 128 KiB                          |
| Write bytes / distinct files per user turn | 2 MiB / 8                        |
| Read page                                  | 200 lines                        |
| List/glob/search results                   | 100                              |
| Search match preview                       | 500 characters                   |
| Tool timeout / cumulative execution        | 10 seconds / 60 seconds          |
| Calls per turn                             | Desktop setting 1–24; default 12 |
| Managed result / turn output               | 16 KiB / 64 KiB                  |

Failed write attempts consume budget. Reservations occur before async IO, including concurrent distinct-file writes. ToolTurnBudget was moved to Core and reexported from V1. V2 shares it across continuation and resets on a new user turn. Two identical results trigger loop prevention. Canonical ToolRegistry retains V2 generic output bounding/retention; runner budgets add turn-wide enforcement.

Cancellation interrupts Effect, aborts Ripgrep and checks IO AbortSignal before commit. Issued OS syscalls cannot be undone. Node lacks directory-handle-relative compare-and-swap rename: a hostile external process racing the final check/syscall is not fully excluded. This is a local workspace guard, not an OS sandbox. Normal external-editor changes and junction swaps before approval completes are detected.

## Results, UI and audit

Write/edit return compact operation/path/changed/bytes/oldHash/hash JSON. Stable errors: PATH_OUTSIDE_WORKSPACE, PERMISSION_DENIED, FILE_NOT_FOUND, FILE_ALREADY_EXISTS, FILE_CHANGED_SINCE_READ, AMBIGUOUS_EDIT, NO_MATCH, UNSUPPORTED_BINARY_FILE, FILE_TOO_LARGE, WRITE_LIMIT_EXCEEDED, TIMEOUT, CANCELLED; invalid arguments/IO failures use existing structured failure semantics.

Both naming variants use existing BasicTool cards and localized native action labels, existing pending/running/completed/error messages, and expandable bounded results. No Files panel or renderer filesystem bridge was added.

V1 invocation audit adds canonical relative path/bytes changed. V2 leaves log the same content-free fields; runner logs correlated settlement/budget/timeout events. Audit excludes file content, old/new strings, diff previews and arbitrary arguments. Permission previews are separate trusted UI data.

## Memory provenance and acceptance

File results keep the tool role in continuation/history. “User prefers Electron” or “Запомни…” inside a file cannot become a real user confirmation. Gateway/worker requires user evidence. Phase 1 identity, injection and worker configuration stay unchanged. Tests cover fork role preservation and existing backend rejection of file-only preference evidence.

See PHASE9B_SELF_ACCEPTANCE.md for the completed Phase 9B validation. Phase 9C evidence is recorded separately in PHASE9C_SELF_ACCEPTANCE.md. No commit/push.

## Phase 9C execution catalog

| V1             | V2             | Purpose                                    | Permission                                   |
| -------------- | -------------- | ------------------------------------------ | -------------------------------------------- |
| shell.exec     | shell_exec     | One foreground project command             | bash                                         |
| test.run       | test_run       | Focused test command with actual exit code | bash                                         |
| process.start  | process_start  | Explicit background/dev launch             | bash                                         |
| process.status | process_status | Recent logs/state for an owned handle      | bash catalog; session ownership at execution |
| process.stop   | process_stop   | Terminate an owned handle and child tree   | bash catalog; session ownership at execution |

All are hidden for other providers. Managed Tools OFF applies to the entire catalog in Build/Plan, including MCP/native fallbacks. Existing native shell tools are preserved for other providers.

### Reused runtime and restrictions

Both runtime adapters call one Core policy over upstream AppProcess/CrossSpawnSpawner. Existing scoped child handles, separate stdout/stderr streams, permissions and cards remain the execution/UI boundaries. V1 progress uses existing metadata updates. V2 has no invocation progress context; it exposes pending/running/completed states, final output and process.status log snapshots, without a new protocol.

The grammar accepts one literal invocation with quoted arguments. No expansion, substitutions, pipelines, redirections, command chains, arbitrary executable roots, env override or encoded commands. Arguments/cwd reject absolute/traversal paths. Cwd reuses WorkspaceFiles realpath validation and is rechecked after approval and before spawn. Node entrypoints must resolve inside the workspace.

Risk classification: SAFE_READ, SAFE_TEST, SAFE_BUILD, WRITE, DESTRUCTIVE, NETWORK, SYSTEM, PRIVILEGED. Elevated/system/destructive/network/install commands are denied before permission, including global installs. Unknown invocations are denied; project package scripts may use `run <custom-script>` as WRITE. Git shell invocations are denied for managed agents until Phase 9D. npm/pnpm `.cmd` launchers are supported through PowerShell. Approved project scripts/code still run with host-user filesystem/network authority: command classification and validated cwd are **not an OS sandbox** and do not inspect every transitive script/dependency.

### Ownership, cleanup and limits

Process handles are opaque UUIDs, workspace-instance/session-bound, never arbitrary PIDs. Max 4 concurrent jobs (including foreground), 64 retained handles. Background jobs persist across normal turns, expire after at most 10 minutes, and are cleaned on runtime disposal. V1 session cancel and active V2 runner interruption stop owned jobs. Idle V2 interruption retains upstream no-op semantics; use process.stop to stop an idle session's dev server. No durable process recovery after restart.

Windows defaults to PowerShell with NoProfile and UTF-8 output. Each shell joins a process-local Windows Job with KILL_ON_JOB_CLOSE before executing code. This handles descendants even if an intermediate parent exits; upstream taskkill /T remains the explicit stop/finalizer path. Job setup fails closed. POSIX uses upstream detached process groups; deliberately escaping/daemonizing descendants are not supported.

Defaults: short command 30s, focused test 120s, build/check 180s; foreground cap 300s; background default/cap 600s. Managed outer foreground deadline is 310s to allow cleanup. Existing call/output/cumulative turn budgets still apply; exceeding cumulative time removes subsequent schemas. Repeated command/result detection excludes changing duration/handle fields.

Results include command, relative cwd, risk, opaque processId, separate stdout/stderr, exitCode, durationMs, running, timedOut, cancelled and truncated. Keep the most recent 4 KiB per stream; oversized lines (>16 Ki characters) are omitted. No full log archive or arbitrary log offsets. V1 progress is throttled and publishes only complete redacted lines. UTF-8 Cyrillic is tested; fixed legacy OEM encodings are not universally supported.

No model-controlled environment. Inherited credentials are usable by approved code but known secret values/labels are redacted from exposed logs; inline known secrets are denied before approval logging. Diagnostics never log full output. stdout/stderr retain tool provenance, not user evidence.

### Test priority

1. Direct reproduction/unit test.
2. Affected package tests.
3. Closest integration/regression.
4. Build/typecheck/lint of affected packages.
5. Broad suites only with an explained technical reason.

Prefer fs.edit/fs.write for normal text changes. Use shell for tests/builds/scripts and explicit process.start for dev servers. A failed command must not be reported as PASS.

# Phase 9D Git tools

Managed V1 exposes `git.status`, `git.diff`, `git.log`, `git.branch.list/create/switch`, `git.stage`, `git.unstage`, `git.commit`, `git.restore`, `git.remote.list`, `git.fetch`, and `git.push`; V2 uses underscore aliases. They reuse upstream Git discovery/history and AppProcess argv execution. Shell Git stays denied.

Use selected-path `git.diff` and pass its session-bound `reviewId` to stage/restore. Before commit, obtain a fresh `git.diff` with `staged=true` and pass that review ID. Commit does not stage and refuses unrelated/unapproved index changes. Canonical filesystem writes supply ownership evidence; pre-existing/mixed or unattributed changes require ASK. Restore/fetch/push always ask, including under broad/saved allow. Force/history rewrite is unavailable. Git paths are workspace-scoped; nested branch switch is refused.

Automatic workflow ends at local commit and report. Never push merely to finish a task. Remotes must already exist; explicit branch mapping is required. Managed commands do not run hooks/signing, do not expose credential URLs, and do not modify Git configuration. Approved project scripts/custom filters still have host-user authority; this is not an OS sandbox. Ownership/reviews are bounded and process-local; mixed changes use whole-file approval, without hunk staging.

Actual checks and limitations: `PHASE9D_SELF_ACCEPTANCE.md`.

# Phase 9F HTTP / API tools

Managed V1 exposes `http.request`; canonical V2 exposes `http_request`. Both use
the same `ManagedHttp` policy and `http-network` transport. Native webfetch and
other providers remain unchanged. These tools are excluded from ordinary provider
catalogs. Tools OFF removes executable schemas at the existing runner gate and
also rejects stale HTTP invocations inside the shared runtime.

## API and limits

Arguments: `method` (GET default, HEAD, POST, PUT, PATCH, DELETE), `url`, optional
string maps `query`/`headers`, `body`, `contentType`, `timeoutMs`, and
`credentialProfile`. JSON values serialize as JSON; a JSON string remains a
string. Text and URL-encoded string maps are supported; multipart/uploads are not.
GET/HEAD cannot have a body. Inline credential fields and unsafe headers are denied.

Results include `ok`, requestID, method, status/statusText, filtered headers,
body, contentType, durationMs, finalUrl, redirectCount, truncated, bytesReceived
and optional errorCode. HTTP 400/401/403/404/500 remain HTTP exchanges with their
status, rather than transport errors. JSON retains structure; HTML/XML/plain text
remain inert text. Binary responses have metadata and UNSUPPORTED_CONTENT.

| Limit                           | Value                                          |
| ------------------------------- | ---------------------------------------------- |
| URL / model-supplied headers    | 4096 characters / 24 headers                   |
| Header name / supplied value    | 64 / 2048 characters                           |
| Request body / response preview | 32 KiB / 8 KiB                                 |
| Response headers exposed        | 24, 1024 characters each, 4 KiB total          |
| Redirects                       | 3, validated and confirmed independently       |
| Network timeout                 | 10 seconds default, maximum 30 seconds         |
| Per session/turn                | 8 requests, 30 seconds cumulative network time |
| Concurrent requests             | 2 per scoped runtime                           |
| Retained turn budgets           | 256; completed old turns evicted               |

DNS failures and transport failures consume network time. Permission waiting is
excluded from the network counter, while the existing outer tool deadline is
35 seconds and includes confirmation waiting. Generic agent call/output/time
budgets still apply. Response streams are destroyed on truncation/cancellation.
OS DNS lookup cannot itself be cancelled, but the tool stops awaiting it and
never connects after the deadline. There are no automatic retries, including
writes and HTTP429; Retry-After remains visible in the bounded result.

## Permissions and endpoint safety

Every request requires the existing ASK/once flow, including public reads.
Writes, authentication and internal endpoints cannot inherit broad/saved allow
or Desktop auto-accept. Configured deny still wins. Confirmation shows method,
origin/path, risk code, authentication presence, payload size and content type;
never payload or secret. Internal endpoints need NETWORK_INTERNAL approval.

Only normalized HTTP/HTTPS URLs are accepted. Embedded credentials and ambiguous
forms are rejected. All DNS answers are classified; metadata, link-local,
unspecified/broadcast/multicast, mapped/translated IPv6 and protected system
ports fail closed. RFC1918, loopback and IPv6 ULA remain available with approval.
Known database/admin/Ollama/Gateway ports and configured service ports are blocked.

Transport connects to a literal pinned IP, preserves Host/SNI and uses no pooled
agent. Node validates the actual peer; Bun's compatibility socket lacks peer
metadata, so literal addressing and refusal of ambient proxies provide pinning.
HTTP_PROXY/HTTPS_PROXY/ALL_PROXY, including lowercase names, cause
PROXY_UNSUPPORTED. No implicit proxy bypass or user configuration changes occur.
Public pinned connections cannot redirect into an internal address, even when
the original DNS set mixes public/private answers. HTTPS downgrade is blocked.
Every redirect is resolved, classified and confirmed again. TLS verification
is always enabled; use an operator-trusted certificate setup for local HTTPS.

## Credentials and provenance

No credential vault/UI/database is introduced. The trusted process may set
`OPENCODE_HTTP_CREDENTIAL_PROFILES` to a JSON registry with exact origin bindings
and **environment variable names**, not token values:

```json
{
  "local-test-api": {
    "origin": "http://127.0.0.1:8000",
    "type": "bearer",
    "env": "LOCAL_API_TOKEN"
  }
}
```

Other trusted profile types: `apiKey` with header/env; `basic` with
usernameEnv/passwordEnv. Values are process-only, bounded, and redacted from
results/audit, including escaped JSON echoes and Basic encoding. Missing/wrong
origin profiles fail AUTH_REQUIRED. Headers and status/type metadata are redacted
before truncation. Authenticated oversized response bodies are omitted to avoid
exposing a partial secret at the preview boundary. Credentials never follow an origin change.
No durable plaintext credential persistence or automatic credential discovery.

Audit records contain request ID, tool, method, safe origin/path, risk,
permission, status, duration, byte count and error; no request/response bodies.
HTTP results retain tool-role provenance. They are not user confirmation or
sources of user preferences. Inference Usage is recorded only by the unchanged
Gateway observer: HTTP bytes are not model tokens; subsequent model inference
is counted normally. Worker model selection remains independent.

Errors: INVALID_URL, INVALID_ARGUMENT, BLOCKED_ADDRESS, BLOCKED_REDIRECT,
PERMISSION_DENIED, AUTH_REQUIRED, UNSAFE_HEADER, DNS_FAILURE, TLS_ERROR,
CONNECTION_REFUSED, TIMEOUT, CANCELLED, REQUEST_TOO_LARGE, RESPONSE_TOO_LARGE,
TOO_MANY_REDIRECTS, UNSUPPORTED_CONTENT, INVALID_JSON, NETWORK_ERROR,
PROXY_UNSUPPORTED, NETWORK_BUDGET_EXCEEDED, TOOLS_DISABLED.

Phase9C blocks direct curl/wget/PowerShell HTTP/encoded commands/inline Node or
Python networking. Approved project scripts retain host-user authority; this
policy is **not OS network isolation**. Likewise untrusted API instructions may
influence a model: tool-role separation and real permissions limit execution,
but do not guarantee semantic immunity to all prompt injection.

Acceptance, commands, source files and remaining boundaries:
`PHASE9F_SELF_ACCEPTANCE.md`.
