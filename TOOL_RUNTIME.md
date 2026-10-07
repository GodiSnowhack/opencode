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

V2 names prohibit dots; underscore names have identical contracts. V1 reserved names cannot be replaced by plugins. Managed providers receive only this catalog; ordinary providers retain native tools. No model ID special case exists.

Agent Tools OFF removes every executable schema on the managed provider/configured Gateway route, regardless of Build/Plan. Managed models without tool capability receive no schemas. ON restores the permission-filtered catalog. V2 refuses managed calls that were not advertised, without starting continuation. V1 excludes MCP/plugins from managed exposure.

## Workspace security

The runtime supplies workspace/session/stable turn identity. Model arguments supply relative names only. Canonical root is pinned on first use. Reject absolute Windows/Unix paths, drive-relative prefixes, UNC/device paths, ADS colons, traversal, NUL, reserved Windows names and trailing dot/space aliases. Realpath validates existing targets and immediate create parents. Symlink/junction escape, including a parent changed during a permission prompt, is denied. Outside access has no approval override.

UTF-8 only: reject invalid UTF-8, NUL/control bytes and known binary extensions; retain BOM and source line endings for exact edits. Search never follows symlinks, filters binary/oversized/non-UTF-8 results and revalidates disclosed paths. No shell, executable, Git, browser, delete/move or binary mutation is exposed.

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

See PHASE9B_PLAN.md for exact targeted results and PHASE9B_ACCEPTANCE.md for isolated live steps. Live generations, packaged installer and full monorepo checks were not run. No commit/push.
