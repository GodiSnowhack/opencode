# Memory Gateway integration (Phase 1)

This fork can attach project and session identity to requests sent to a locally configured Memory Gateway. It is an opt-in transport integration; it does not inject memories or add a Desktop settings screen.

## Enable

Set these environment variables for the fork process:

```text
OPENCODE_MEMORY_INTEGRATION=true
OPENCODE_MEMORY_GATEWAY_URL=http://127.0.0.1:11435/v1
```

Configure the OpenCode model/provider base URL to that same Gateway endpoint. Both settings are required. The integration accepts only HTTP loopback endpoints (`127.0.0.1`, `localhost`, or `[::1]`) and compares the actual provider endpoint with the configured Gateway, including port and path. A terminal `/v1` and trailing slash are normalized. Other provider endpoints, including cloud providers and direct Ollama, receive no memory headers. The default is disabled. Do not configure the Gateway URL with credentials or query parameters.

Matching requests carry:

| Header                  | Value                                                                                                     |
| ----------------------- | --------------------------------------------------------------------------------------------------------- |
| `X-Memory-Session-Id`   | Existing OpenCode session ID                                                                              |
| `X-Memory-Project-Id`   | Existing OpenCode project ID, or deterministic `local-<sha256>` for the upstream `global` non-Git project |
| `X-Memory-Project-Root` | Absolute worktree/project directory; for the upstream `global` project, the session directory             |
| `X-Memory-Request-Kind` | `user`, `title`, or `compaction` when known from the call site                                            |

The non-Git fallback hashes a normalized absolute directory, so sessions in that directory share project identity and different directories do not collapse into upstream's common `global` ID. The absolute root is sent only to the matching local Gateway; it can reveal local path information to that local service.

## Request paths and identity

- **Legacy:** Desktop session prompt and tool continuation use `SessionProcessor` → `SessionLLM.stream` → `LLMRequestPrep.prepare` → provider/HTTP. The existing session ID is passed through the request. `InstanceState.context` supplies `project.id`, `worktree`, and `directory`. For a Git project, `worktree` is the project root. Title generation explicitly passes `title`; compaction explicitly passes `compaction`; normal turns and tool continuations use `user`.
- **V2:** `SessionV2` → `SessionRunnerLLM` → `LLMClient.stream` → provider/HTTP. The persisted session supplies `id`, `projectID`, and `location.directory`. The bound `Location.Service` supplies the project directory, and `SessionRunnerModel.route.endpoint.baseURL` supplies the actual provider endpoint. Each continuation reloads the same session identity. V2 currently labels these provider turns `user`.

`workspaceID` identifies a workspace placement/worktree, not a separate project. The integration uses the existing bound project/workspace directory to identify the absolute root and does not send a workspace header. Different worktrees of the same Git project can therefore share a project ID while having different roots. The helper is shared by Legacy and V2; endpoint and identity validation happen before headers are added. The kind is explicit call-site metadata, never inferred from prompt text. Other auxiliary operations that do not pass through these provider paths are not classified by this integration.

## Manual live acceptance test

1. Start the Memory Gateway and configure the fork environment and provider endpoint as above.
2. Start the fork's Desktop app, open a specific project, create a session, and send a normal request.
3. Inspect Gateway Raw History/SQLite and verify `session_id`, non-null `project_id`, and absolute `project_root` match the OpenCode session and project.
4. Trigger a tool call and check that the following provider request retains the same session and project identity.
5. Create a new session in the same project. Its session ID should change, while project ID and root remain the same.
6. Open a different project and create a session. Project ID and root should change.
7. For the durable-memory acceptance check, send: “Для этого проекта принято решение: конфигурацию приложения будем хранить в SQLite.” Verify a resulting project-scoped `project_decision` with a non-null project ID and source references in the Memory System.

These steps require a running Gateway, Desktop, and database. Unit and integration tests in this fork do not constitute that live acceptance test.

## Phase 2: Desktop MemoryStatus

When `OPENCODE_MEMORY_INTEGRATION=true` and `OPENCODE_MEMORY_GATEWAY_URL` names a valid HTTP loopback Gateway, Desktop shows a compact status beside the lower edge of the composer. With the integration disabled or an invalid/nonlocal URL, the indicator is absent and no status request or event stream is opened. This status is UI state only; it is never sent as a chat message.

The Desktop main process reads the same environment configuration used by Phase 1. The shared Gateway helper validates the URL and derives its origin with the URL parser. Main requests `GET /memory/status`, then reads `event: memory.status` frames from `GET /memory/events`. Both requests reject redirects. The main process maintains one stream for subscribed windows and sends parsed status snapshots through preload IPC. Session and project switches do not create additional streams. On a broken connection, the indicator becomes Offline and the client retries after 1, 2, 5, 10, 20, then at most 30 seconds. Each reconnect fetches a fresh status before streaming. Unmount/reload and the last window unsubscribe abort the stream and clear pending retry timers. Normal OpenCode requests continue independently of the status connection.

| Gateway `phase` or condition                                                    | Indicator             |
| ------------------------------------------------------------------------------- | --------------------- |
| `IDLE`                                                                          | Memory: Ready         |
| `MEMORY_ANALYZING`, `MEMORY_DEDUPLICATING`, `MEMORY_WRITING`, `MEMORY_INDEXING` | Memory: Analyzing     |
| `TAXONOMY_RUNNING`                                                              | Memory: Taxonomy      |
| `CONSOLIDATION_RUNNING`                                                         | Memory: Consolidating |
| Queue count above zero, without a more specific active phase                    | Memory: Queued        |
| `degradedReasons` nonempty or `DEGRADED`                                        | Memory: Degraded      |
| `error` non-null or `ERROR`                                                     | Memory: Error         |
| Gateway unavailable                                                             | Memory: Offline       |
| Other active phase                                                              | Memory: Working       |

The indicator also shows the real queue count when nonzero. Active operations show locally advancing elapsed time from `startedAt` or `elapsedMs`; there is no per-second Gateway polling, percentage, or ETA. A keyboard-focusable tooltip shows the reported state, phase, queue, processed count, elapsed time, and connection state. It never displays the project path, credentials, or full backend error text. Other locales fall back to English; English and Russian labels are included in the app's existing localization system.

For a live check, start the local Gateway and Desktop fork with the environment values above. Verify Ready while idle, an active label during worker activity, Ready after completion, Offline when the Gateway stops, and automatic recovery after it starts again. Start Desktop without `OPENCODE_MEMORY_INTEGRATION` and verify that the indicator and status traffic are absent.

## Phase 3: Desktop Memory Panel

MemoryStatus is an accessible button. Activating it opens a native right-side panel in the session split layout; activating it again or using the panel close button closes it. Escape also closes the panel. On narrow layouts the panel replaces the session body instead of covering the composer. The open state is window-local, remains open across session navigation in that window, and is not persisted to the Gateway or chat.

MemoryStatus and Memory Panel read the same renderer-level `MemoryStatusSnapshot` and centralized elapsed clock. Desktop still owns exactly one main-process `MemoryStatusClient` and one SSE stream for all panel and status views in a window. The panel never subscribes to Gateway events itself. It displays the real connection state, derived Memory state, Gateway phase, active job ID, elapsed time, queue length, queued user requests, processed items, error, degraded reasons, and the local time of the last successful status or event. Offline keeps that last successful timestamp and the already received status snapshot while clearly reporting the Gateway as unavailable. Recovery updates an already open panel automatically.

The current session ID and project identity come from the active OpenCode route and directory sync context, not from an additional Memory request. IDs are shortened for display. Project display prefers OpenCode's project name and otherwise shows only the final two path components, so a Windows username is not exposed in normal panel copy. Navigation changes these accessors without restarting or duplicating the shared status stream.

Refresh performs one fresh `GET /memory/status` through the existing main-process client and updates the shared snapshot without starting another SSE. Reconnect cancels the current stream or retry delay, advances the client generation, then starts one replacement GET-plus-SSE cycle. Repeated reconnect requests cannot leave parallel generations active. Closing the renderer subscription or Desktop aborts the stream and clears retry timers and listeners.

The current Gateway has `GET /memory/metrics`, but its global/project totals are not active counts for the current project. `GET /memory` is a paginated inspection API, not a count contract. Phase 3 therefore does not display memory counts, does not invent values, and does not access `memory.db` directly.

All status and panel traffic is restricted by the existing Gateway URL validation to configured HTTP loopback origins. The panel makes no cloud request, sends no chat message, does not expose auth headers or prompts, and performs no memory mutation. With `OPENCODE_MEMORY_INTEGRATION` disabled or an invalid/nonlocal Gateway URL, the main-process client is not created, no memory IPC subscription or network request starts, MemoryStatus is hidden, and the panel cannot open.

Phase 3 is observability and connection control only. It does not implement a memory list, taxonomy tree, search, editor, source/history viewer, create, delete, merge, move, retrieval, embeddings, or context injection; those remain outside this phase.

## Phase 4B: Desktop Memory Manager

With the local integration enabled, open Memory Panel from the composer status button and select **Open Memory Manager**. The manager occupies the session workspace; closing it returns to the same session. Memory Panel remains the compact status view.

The renderer calls the typed Desktop preload API, which invokes a fixed set of main-process IPC actions. `MemoryManagementClient` makes the corresponding `/memory/manage` requests to the configured local Gateway. The origin comes from the same Phase 1 loopback-only URL validation as MemoryStatus. The renderer cannot supply an arbitrary URL, read SQLite directly, or call a cloud service through this path. Management CRUD does not call a model.

The manager has Global, Current Project, and All Projects views. Current Project uses the same effective project identity helper as Phase 1 and Memory Panel; the UI does not hash a project again. All Projects uses the Gateway's safe project names, active memory counts, and last activity. Search and status/type/sort/taxonomy filters are sent to the Gateway. The list loads 50 records at a time using the returned cursor; it does not treat a page as a global total. The taxonomy tree shows backend active counts and filters the list by an existing node.

Selecting a memory fetches its detail. Sources and history are fetched only after opening their respective tabs. Sources show redacted excerpts and shortened session IDs; history shows versions, supersede links, and audit operations. Create uses canonical types from `/memory/manage/metadata`. Edit creates a new version, archive is logical and requires confirmation, merge accepts two compatible active memories and a user-entered result with confirmation, and move chooses an existing taxonomy node. Mutations wait for backend success and then refresh the affected list, detail, projects, and taxonomy counts.

When the status client reports Offline, the manager remains open, displays the connection state, and disables mutations. Refresh and Retry remain available. Closing the manager does not create or stop an additional SSE stream. The layout shows list and detail side by side on desktop and navigates between them on narrow screens. English and Russian copy uses the existing app i18n fallback mechanism.

Phase 4B does not add taxonomy node create/rename, physical purge, embeddings, semantic retrieval, injection, or automatic memory context.
