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
