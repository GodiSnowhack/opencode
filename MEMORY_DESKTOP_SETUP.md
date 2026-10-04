# Desktop Memory setup

## Use

Install and open the Windows OpenCode Desktop build, then open **Settings → Memory**. Turn Memory on. Desktop checks local Ollama, starts its bundled Gateway, and adds the **Memory Local (managed)** provider at `http://127.0.0.1:11435/v1`. Select an installed Ollama model from the list; `qwen3:8b` is the initial default when installed. The model is supplied by your local Ollama installation. Desktop does not install Ollama or download models.

The Gateway starts with Desktop when **Start Memory Gateway automatically** is on. A provider or Memory on/off change restarts the local OpenCode sidecar in development and relaunches packaged Desktop so the server reads the new provider configuration. Gateway-only settings apply through a controlled service restart. Existing cloud and custom providers are retained. Select the managed model in OpenCode's model picker to route chat through Memory Gateway. Direct Ollama and cloud models do not receive Memory identity headers.

The status beside the composer reports the existing Gateway connection. Settings shows the service state (running, external, degraded, failed), Ollama availability, installed models, and advanced settings. **Check again** retries Ollama detection. If Ollama is unavailable, Desktop remains usable and Memory reports a degraded state.

## Data and maintenance

The managed database is stored under the Desktop application's writable `userData/Memory/memory.db`. On Windows this is the Electron app data directory for the installed app channel. The same directory contains `backups/`, `logs/`, and `support/`. Nothing is stored beside the executable. Existing development databases are not moved automatically.

With the managed Gateway stopped and no managed database present, **Import existing database** opens a native `.db` picker. Desktop opens the source read-only, checks integrity and required tables, snapshots it into a temporary managed file, verifies that copy, then atomically places it in the managed data directory. The source stays unchanged. An existing managed database cannot be overwritten by import.

**Backup now**, **Backups**, **Diagnostics**, **Restore**, and **Create diagnostic bundle** use Phase 7 Gateway APIs. Restore verifies a selected backup and asks for explicit confirmation; the backend creates a safety backup of the current state. Support bundles contain bounded diagnostic metadata. The UI can reveal a generated bundle in the file manager. When a packaged Gateway encounters a database migration, it creates a verified safety backup first. A database with an unknown newer migration is not downgraded.

## Service ownership and troubleshooting

Desktop checks `/health` for the Memory API version. It uses a compatible already-running Gateway as **External** and does not stop it on exit. It starts its own Gateway only when the port is free. A different process on the port is left alone and reported as an error. Owned Gateways have a bounded crash-restart policy; **Restart Memory Service** is for owned processes. On normal Desktop shutdown, Desktop requests graceful Gateway shutdown and waits before ending the child process.

If Memory reports **Gateway not bundled**, rebuild the Desktop with `packages/desktop/scripts/bundle-memory-gateway.ts` and package again. If Ollama reports unavailable, start the existing local Ollama installation and select **Check again**. If Memory reports a database issue, open Diagnostics and use the verified backup/restore workflow. Do not manually replace a live SQLite database.

## Development and packaging

The previous manual development configuration remains valid: `OPENCODE_MEMORY_INTEGRATION=true`, `OPENCODE_MEMORY_GATEWAY_URL=http://127.0.0.1:11435/v1`, a provider pointing to that URL, and a separately started Gateway. Desktop settings are held in `electron-store`, not the backend `.env`. The Desktop prebuild/predev script packages the sibling `opencode-memory-system` when present. Development resolves the Gateway bundle from the Electron app checkout path, including paths with spaces. It attaches to a compatible external Gateway before attempting to start an owned one. Missing development resources leave Memory in a failed state without closing Desktop. The backend `pnpm package:gateway` command bundles Gateway JavaScript, migrations, prompts, and the native `sqlite-vec` extension for the build platform. Windows packaging places the bundle under `resources/memory-gateway`; Electron itself supplies the Node runtime, including `node:sqlite`. End users do not need a separate Node, Bun, pnpm, or backend clone.

The Windows development installer is unsigned unless a real signing certificate is configured. The packaged Gateway uses only loopback HTTP and local Ollama. Renderer controls use a narrow typed IPC API; they cannot choose an executable or shell command.
