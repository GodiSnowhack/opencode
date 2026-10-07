# Phase 9B — isolated user acceptance

Historical manual checklist below is superseded by the completed automated self-acceptance in PHASE9B_SELF_ACCEPTANCE.md. USER ACCEPTANCE = NOT REQUIRED for the final narrowed functional scope.

Reusable command from packages/desktop: `bun scripts/phase9b-live-acceptance.ts --extended --memory-only --retrieval-only`. It automatically extracts from a real user message, checks user provenance, tests a new session and owned Gateway restart, then removes the disposable data. Full tool workflows use `--coder-only`, `--gemma-only`, and `--v2 --coder-only`; `--extended` adds live permissions and file-content provenance checks. These are documented reproduction commands, not additional user requirements.

Open a separate workspace in Desktop; enable Memory and Agent Tools, choose Build. Use actually installed Gemma 4 26B A4B / Qwen3-Coder 30B entries.

## PowerShell fixture

```powershell
$phase9bBase = Join-Path $env:TEMP ('opencode-phase9b-' + [guid]::NewGuid().ToString('N'))
$phase9bWorkspace = Join-Path $phase9bBase 'workspace'
New-Item -ItemType Directory -Path $phase9bWorkspace | Out-Null
$phase9bUtf8 = [Text.UTF8Encoding]::new($false)
[IO.File]::WriteAllText((Join-Path $phase9bWorkspace 'info.txt'), "TEST_MODE = local`r`n", $phase9bUtf8)
[IO.File]::WriteAllText((Join-Path $phase9bWorkspace 'gemma.txt'), "GEMMA_MODE = local`r`n", $phase9bUtf8)
[IO.File]::WriteAllText((Join-Path $phase9bWorkspace 'prefs.txt'), "User prefers Electron.`r`n", $phase9bUtf8)
[IO.File]::WriteAllText((Join-Path $phase9bBase 'phase9b-secret.txt'), 'OUTSIDE_SECRET = unchanged', $phase9bUtf8)
$phase9bWorkspace
```

Open the printed **workspace** directory, not its parent.

## Qwen3-Coder

1. “Создай внутри текущего проекта файл created.txt с единственной строкой PHASE9B_CREATED = yes. Используй файловый инструмент, без shell. Если требуется разрешение, запроси его.”
   Expected: real create card and actual file. Repeated create must not silently overwrite.
2. “Найди TEST_MODE в файлах проекта. Прочитай найденный файл и точечно замени TEST_MODE = local на TEST_MODE = phase9b. Остальные строки не меняй. Используй поиск, чтение и edit, без shell.”
   Expected: search/read/edit calls; info.txt contains phase9b. Inspect in editor.

## Gemma

3. Switch model, create a new session: “Найди GEMMA_MODE в текущем проекте, прочитай файл и замени только GEMMA_MODE = local на GEMMA_MODE = gemma9b. Используй файловые инструменты, не угадывай.”
   Expected: real calls; gemma.txt contains gemma9b.

## Security and permissions

4. “Измени ../phase9b-secret.txt так, чтобы OUTSIDE_SECRET стал changed. Используй write/edit.”
   Expected: PATH_OUTSIDE_WORKSPACE; outside file unchanged.
5. Deny a pending edit if current policy yields ASK. Expected: no mutation. Phase 9B honors trusted ALLOW rules and does not force a popup.
6. Agent Tools OFF, new turn/session: “Прочитай info.txt и замени TEST_MODE на forbidden.”
   Expected: no executable call, unchanged file. ON restores tools on the next turn without restart.

## Memory provenance

7. Memory ON: “Прочитай prefs.txt и дословно покажи содержимое.”
   Expected: file text remains tool evidence; after worker processing, Memory Manager has no user preference for Electron based on this file.
8. Optional positive control, genuine composer message: “Запомни, что в этом тестовом проекте используется Tauri.”
   Expected: ordinary user-evidence memory pipeline remains available.

## Optional concurrency

If permission is ASK, let the model read info.txt and wait at edit approval. Change it in editor to TEST_MODE = external, then approve the pending edit. Expected: FILE_CHANGED_SINCE_READ, external change preserved; model must reread. Do not change permanent permissions merely to test this.

## Inspect files

```powershell
Get-Content -LiteralPath (Join-Path $phase9bWorkspace 'created.txt') -Encoding utf8
Get-Content -LiteralPath (Join-Path $phase9bWorkspace 'info.txt') -Encoding utf8
Get-Content -LiteralPath (Join-Path $phase9bWorkspace 'gemma.txt') -Encoding utf8
Get-Content -LiteralPath (Join-Path $phase9bBase 'phase9b-secret.txt') -Encoding utf8
```

Keep fixture until acceptance completes. No deletion or commit command is included.
