# PhotoLocal: reliable Google access and Docker migration

The approved direction is to first improve Google connection and interrupted downloads, then prepare Docker while keeping the existing Windows application available. Local startup findings are not evidence about the production server. Deployment-specific access details belong outside the repository.

## Stage 1: Google access and downloads

- Keep application login separate from the shared Google Chat connection. Use web-server OAuth with a registered HTTPS callback at `/api/google-chat/auth/callback`. Start authorization only for an authenticated PhotoLocal user. Bind one-use, expiring state and PKCE to the initiating browser. Never send Google credentials to the frontend, logs, or repository.
- Persist Google refresh credentials outside the image, in the authorized-user JSON format used by the Python downloader. Use offline access and the existing read-only Chat scopes. Reconnecting happens in the user's browser. Initial Google Cloud web-client setup and actual consent require the account owner.
- Noninteractive download/list processes never open a browser. Terminal authorization failure produces an explicit AUTH_REQUIRED state; transient network failures remain retryable errors. Keep legacy desktop login an explicit CLI action.
- Keep a durable job snapshot, restore interrupted jobs as PAUSED, and provide explicit resume. Store a per-attachment validated receipt, write downloads atomically, serialize manifest updates, and retry transient failures. Never mark partial failures as complete. Reconnecting preserves previous completed files.
- Keep Windows invitation automation available on Windows. The Docker interface provides a link to ordinary Google Chat for invitation acceptance on the same Google account; integrated browser automation is not silently claimed to have been migrated.

## Stage 2: Docker preparation

- One Linux image serves the built frontend/backend and Python downloader. Build once; container startup only runs the server. Compose uses `restart: unless-stopped`, health checks and explicit persistent data, download, credential and project mounts.
- Support configured project-folder roots in the web picker on Linux. Preserve existing Windows mapped-drive behavior when roots are not configured. Resolve configured roots and reject traversal and symlink escapes.
- Provide an offline migration utility that creates a consistent SQLite backup and remaps all filesystem path columns in the copied database, never modifying the source. Fail on unknown mappings, missing roots and unsafe output targets. Do not copy production credentials into development.
- Staging uses its own database, project files and downloads. No production writes during development. Final cutover waits for jobs, pauses writes, captures consistent DB/files, verifies imported data and restarts, then switches service. Rolling back after new writes requires retaining/reconciling them.

## Validation and deployment constraints

Run Python fault/retry tests, backend OAuth/runner/filesystem/migration tests, frontend workflow tests and production builds. Test container when an engine is available and report actual verification scope. Before touching production determine its source version, application directory, mounted shares and a usable administrative connection. Do not infer remote credentials or the Google Cloud publishing status.
