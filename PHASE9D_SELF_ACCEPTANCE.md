# Phase 9D — Git self acceptance

## Implementation Status

Implemented first-class managed Git tools and automated acceptance. Commit recommendation: **READY**, within the stated restrictions below. No commit or push of the working OpenCode repository was performed. Installed Ollama/models, user configuration and backend source were not changed.

## Architecture Audit / Reused Git Runtime

Upstream Core Git owns repository discovery, history, remotes, snapshots, index/tree capture and worktree helpers. The existing VCS adapter consumes status/stat/patch helpers for review UI. There was no complete first-class agent catalog for the requested workflow. Some upstream snapshot/refresh/reset helpers have broader mutation semantics than this managed policy permits.

Managed tools reuse Core Git discovery/history/remote lookup and AppProcess/CrossSpawnSpawner for bounded, scoped, literal argv execution. Missing stage/commit/branch/push operations use the installed Git executable; there is no second repository discovery engine or object store. Existing native tools and cloud-provider behavior remain intact. Git tools are visible only to memory-local managed agents.

## Git Tool Catalog

V1 names:

- git.status, git.diff, git.log
- git.branch.list, git.branch.create, git.branch.switch
- git.stage, git.unstage, git.commit, git.restore
- git.remote.list, git.fetch, git.push

V2 uses underscore aliases, including git_branch_list and git_commit. Both catalogs invoke the same policy implementation. Existing tool cards display localized English/Russian labels, bounded structured output and errors; no Git client UI was created. Other locales use the existing fallback behavior.

## Repository Scope

Discovery starts from the trusted active workspace directory; the model cannot choose another root. Nested workspaces use their parent Git repository for metadata but mutation paths must remain inside the workspace. Branch switch is refused for nested workspaces because it could update files above that boundary. Canonical realpaths, Windows casing, absolute/UNC paths, traversal and junction escape are covered. Missing repositories return NOT_A_GIT_REPOSITORY without initialization.

## Status / Diff / Log

Porcelain v2 status includes branch, upstream, ahead/behind, staged/unstaged/untracked flags, conflicts, clean state and rename source/destination. Public lists are bounded; an oversized internal state is refused instead of silently overlooking staged files.

Diff supports working tree, staged, selected paths and stat-only review. Text patches and untracked previews are bounded and redacted; binary output is marked BINARY_DIFF without binary payload. External diff/textconv helpers are disabled. Reviews receive opaque session-bound tokens tied to HEAD, selected index entries and working bytes. State is checked after permission waits. Log returns bounded SHA/author/date/subject records, optionally scoped to selected paths.

## Staging Isolation / User Change Protection

Only explicitly selected files are accepted; directories, broad add, path escapes and .git metadata are refused. Successful canonical filesystem writes record session-specific before/after hashes. Automatic staging approval applies only when current bytes match that evidence and the initial bytes match HEAD, with no unrelated prior index change.

Mixed pre-existing changes, shell-generated files, deletions and unattributed changes require a fresh permission ASK. Whole-file selection is supported; hunk staging is not implemented. The model must review the exact selected path set before stage. Rename review and commit scope include both paths. No ownership evidence is inferred merely from a filename or agent claim.

The critical user-change scenario passed: user.txt/user-notes.txt was modified before the task, the agent edited its task file, and the resulting commit contained only the task file. User changes remained modified in the working tree.

## Commit Semantics / Secret Guard

Commit never stages automatically. It requires a nonempty conflict-free staged set, fresh staged review, workspace-scoped paths and exact session-approved index entries. Unrelated user staging blocks commit rather than being silently included or removed. Permission and state checks repeat before mutation.

Messages are nonempty, at most 500 characters, without control characters or obvious secret content, and passed by argv. Obvious .env/key/credential files, private-key markers, token/password patterns and inherited secret values block commit with POTENTIAL_SECRET_IN_STAGED_CHANGES. Oversized staged blobs are refused conservatively. This is a small guard, not a comprehensive secret scanner. Audit logs contain tool/session/outcome/error code, not patches, credentials or prompt content.

Commit returns SHA, branch, subject and selected changed files. The implementation disables hooks and signing for these managed operations through per-command settings; it does not change Git configuration. Custom repository filters and approved project scripts still execute with host-user authority. No OS sandbox is claimed.

## Branch Safety / Restore Policy

Branch names are checked conservatively and with Git check-ref-format. Local create uses existing write authorization. Switch never forces and refuses any dirty tree, not only known checkout conflicts; bytes are preserved. Nested-workspace switch is refused.

Unstage affects only selected index entries and preserves the working tree, including unborn-repository semantics. Restore accepts explicit reviewed paths, checks freshness and always asks through the existing permission framework with a discard warning. No broad restore/reset/clean operation exists.

## Destructive Git Policy / .git Protection / Shell Git Restrictions

Reset --hard, clean, force push/force-with-lease, history rewrite, branch deletion and destructive orphan/rebase operations are not exposed. Force/lease/extra-flag requests are rejected. Managed shell already rejects Git; guidance now directs the model to first-class Git tools. Approved project scripts remain outside a full OS sandbox and cannot be claimed as transitively incapable of Git access.

Filesystem write/edit rejects direct .git paths and canonical aliases into .git. Git selected-path operations apply the same metadata boundary. The protection does not alter installed OpenCode or user configuration.

## Remote / Push Policy

Remote listing returns configured names without URLs or credential-helper values. Fetch/push accept only an existing remote name and validated branch; arbitrary model-provided URLs are rejected. Fetch uses one explicit ref mapping without tags, pruning, recursive submodule fetch or forced update, and does not change working files. A remote-only branch can be fetched without an existing local branch.

Push always requires a fresh ASK showing remote, branch and local commit, even under broad Build allow or saved Always approval. Explicit deny remains effective. The configured push target is checked before/after permission, multiple push destinations are refused, and URL credentials are rejected. The normal branch-to-branch push disables mirror/follow-tags/recursive submodule behavior. Actual old remote SHA is read only after network approval; new SHA is verified before push. A rejected non-fast-forward push remains rejected; no retry with force exists.

Credential helpers/SSH infrastructure are used by Git without exposing their values to the model. Trusted SSH/askpass/global-config environment settings are preserved, while inherited repository/index redirects are removed. No GitHub network push was performed. Actual push/fetch testing used disposable local bare remotes; permission policy was exercised separately in V1/V2.

## V1 / V2 / Tools OFF / Memory Provenance

Canonical V2 tools and V1 leaves share repository, review, ownership, stage/commit, branch and network policy. Catalog denials use existing read/bash actions. Mandatory restore/network/mixed-change ASK uses trusted leaf metadata. Desktop auto-response also refuses these requests regardless of session, parent-session or directory auto-accept settings. Existing permission resources show remote, branch, commit, selected paths and discard warning; no popup framework or public protocol was added.

Tools OFF exposes no Git schemas and starts no tool continuation. Real Qwen V1/V2 and Gemma V1 OFF runs left repository HEAD and user changes unchanged. Git log/commit/diff text remains tool provenance, not user fact/preference/confirmation. Relevant session projection tests passed. Full memory-worker extraction was not rerun.

## Real Qwen3-Coder E2E / Real Gemma E2E

Actual installed qwen3-coder:30b ran the full read/failing-test/edit/passing-test/status/diff/stage/commit workflow in both V1 and V2 through the real managed Gateway. Real Git HEAD changed, the commit contained only src/math.ts, and user-notes.txt remained modified. Tools OFF also passed.

Actual gemma4:26b-a4b-it-q4_K_M completed the V1 task-only commit workflow and Tools OFF. A corrected acceptance run used a distinct disposable project directory and passed without Raw History capture warnings. Both models use temporary profile/config/database/workspaces and the existing bundled Gateway; nothing was written to the production database or configuration.

## Branch E2E / Push E2E / Security E2E

Actual disposable repositories verified create/switch/edit/stage/commit/safe switch, dirty-switch preservation, local bare remote push/fetch, observed old SHA, remote-only branch fetch and rejected non-fast-forward push. Security checks cover force variants, shell Git denial, .git write/alias denial, external paths, review replay/staleness, permission-wait changes, user/mixed staging, unapproved index content, conflicts, secrets, binary/bounded output, Windows casing and nested boundaries.

## Bugs Found During Self-Test

| Finding                                                                              | Fix                                                                                                   | Proof                                                  |
| ------------------------------------------------------------------------------------ | ----------------------------------------------------------------------------------------------------- | ------------------------------------------------------ |
| Staged diff included unrelated unstaged path scopes                                  | Filter default review paths by selected diff mode                                                     | Task-only commit/user-change test passes               |
| Already staged rename tried to add an already removed source path                    | Skip nonexistent/unindexed add arguments; retain both approval records                                | Actual rename regression passes                        |
| Untracked binary preview lacked binary marker                                        | Include preview marker in binary metadata detection                                                   | Binary diff regression passes                          |
| Broad/saved allow could bypass mandatory approval; configured deny needed precedence | Force existing ASK and preserve configured deny for mandatory requests                                | Real V1 saved Always test and V2 permission tests pass |
| Nested switch could mutate files above workspace                                     | Refuse nested branch switch                                                                           | Clean nested scope regression passes                   |
| Rename could hide an outside/unapproved source path                                  | Include and validate both sides in review/commit                                                      | Rename/scope tests pass                                |
| Fetch unnecessarily required a local branch                                          | Require local SHA only for push                                                                       | Remote-only fetch passes                               |
| Push destination and old SHA needed stronger precision                               | Revalidate one configured push URL and observe remote head after ASK                                  | Bare remote/old SHA/rejection tests pass               |
| Acceptance trimmed leading porcelain whitespace                                      | Fix harness expectation                                                                               | Real Qwen/Gemma acceptance passes                      |
| Harness reused one root_path for two independently initialized Git identities        | Give model fixtures separate project directories                                                      | Corrected Gemma run passes without capture warning     |
| Desktop auto-accept could answer mandatory requests; metadata was not displayed      | Block trusted mandatory requests in auto-response; show safe approval summaries in existing resources | App 15-test suite and canonical restore test pass      |
| Untracked previews could omit the truncation flag or split UTF-8 characters          | Redact before byte bounding and decode complete UTF-8 characters                                      | Bounded untracked preview regression passes            |
| Removing all Git environment variables discarded credential infrastructure           | Preserve trusted SSH/askpass/config settings; remove repository/index redirects                       | Environment regression passes                          |

The last two were test-harness defects, not claimed production Git regressions. Typecheck also caught a misplaced UI mapping and a test dependency annotation during implementation; both were repaired before acceptance.

## Tests Run

### Critical tests

Final Git runtime + canonical V2 leaves + permission set: **35 passed, zero failed, three files, 144 assertions**. The runtime file contains 20 actual disposable-repository tests and one environment-policy test. This final set covers the last runtime, approval-summary, UTF-8 and credential-environment changes.

### Relevant regressions

- Core checkpoint: **105 passed, zero failed, seven files, 279 assertions**; includes Git, permissions, managed filesystem/shell, session provenance and Location catalogs. It precedes the last two boundary tests and final push-target refinement; the critical set above covers those final changes. Counts overlap and are not summed.
- Final V1 Git/workspace/permission set: **35 passed, zero failed, three files, 174 assertions**.
- Targeted managed Gateway/tool gate/continuation: **11 passed, zero failed**, 88 unrelated cases filtered out.
- UI aliases/status: **three passed, zero failed, 84 assertions**.
- Desktop permission auto-response: **15 passed, zero failed, 19 assertions**.
- Direct V1 Git rerun after approval-summary changes: **three passed, zero failed, 41 assertions**; overlaps with the V1 set above.
- Actual model acceptance: Qwen V1/V2 and Gemma V1, including OFF, passed as described above.

Model workflows preceded the final permission/environment refinements; the final focused tests cover those changes. Unaffected model generation was not repeated.

### Broader tests

No full monorepo, unrelated UI/browser suite or installer. Affected builds and targeted shared permission regressions were run because those integration points changed.

## Build / Typecheck Status

- Typecheck passed: Core, opencode, app, session-ui, ui.
- Builds passed: Node sidecar, app and Desktop electron-vite. Node sidecar is rebuilt after the final runtime edits.
- Final targeted oxlint: zero errors, 76 warnings across 27 changed source/test files. These warnings are not all claimed as upstream baseline.
- Final Prettier and git diff --check: passed.

## Files Changed

New: Core managed-git.ts, git-tools.ts, git-ownership.ts; Core tool-managed-git.test.ts and tool-git-registry.test.ts; V1 tool/git-tools.ts and test/tool/git-tools.test.ts; Desktop scripts/phase9d-live-acceptance.ts; PHASE9D_PLAN.md and this report.

Updated: Core permission, runner exposure, builtins, execution guidance/timeouts, filesystem metadata protection/journal and relevant catalog/permission/provenance tests; V1 permission/registry and workspace catalog tests; app permission-auto-respond.ts and its tests; Session UI card mappings/tests; ui English/Russian dictionaries; TOOL_RUNTIME.md.

## Known Baseline Failures / Remaining Untested Areas

App/Desktop builds retain large-chunk warnings. Prior Windows symlink privilege, locale parity, unrelated prompt-input lint, live-Gateway EBUSY and narrow Desktop overflow suites were not repeatedly run. Junction tests in the current environment passed.

Not verified: live GitHub/SSH credentials, full installer, all Git permission-popup/card visual interactions, complete memory-worker extraction, cross-process filesystem/index races beyond the scoped checks, and exhaustive secret detection. Ownership/reviews are process-local; after restart, existing staging requires explicit reapproval. Whole-file staging uses ASK for mixed changes; no hunk splitting or merge/rebase orchestration was added. Git commit/index mutation is not transactionally atomic against external Git processes; cooperating managed calls use a common-directory lock and freshness checks.

## USER ACCEPTANCE / Commit Recommendation

Functional USER ACCEPTANCE: **NOT REQUIRED**. Task commits, user-change preservation, branches, local remote operations, security gates and real-model execution were checked automatically in disposable repositories.

Commit recommendation: **READY** with the documented scope. This repository remains uncommitted by the agent; no push.
