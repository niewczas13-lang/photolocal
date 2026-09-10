# Google access and Docker implementation plan

> **For agentic workers:** Use superpowers:subagent-driven-development with bounded independent ownership and review before integration. Steps use checkboxes for tracking.

**Goal:** Reconnect Google from the user's browser, safely resume photo downloads, and prepare an isolated Docker deployment with a reversible data migration.

**Architecture:** Fastify manages web OAuth and durable download state; Python owns API requests, refresh and per-file persistence. React displays reconnect/resume states. Linux deployment mounts all mutable data separately from the image.

**Tech Stack:** Existing Node 24/TypeScript/Fastify, React/Vite, Python/google-auth, SQLite, Docker Compose.

## 1. Isolation and baseline

- [x] Create `codex/google-auth-docker` worktree without production data or credentials.
- [x] Install Node packages with `npm ci --workspaces --include-workspace-root`.
- [x] Run `npm test`, record existing failures separately, and verify the approved baseline.

## 2. Downloader reliability

**Files:** `pobierzchat/chat.py`, new focused Python helpers and `pobierzchat/test_*.py`.

- [x] Write and run failing unittest cases for noninteractive missing/revoked credentials, failed refresh, partial files, same-name attachments, concurrent manifest writes and nonzero partial-failure exits.
- [x] Implement configurable credential/token/download paths; explicit `--login`; exit 3 with `PHOTO_LOCAL_AUTH_REQUIRED`, exit 2 for failures, exit 0 only for full success.
- [x] Implement atomic files and validated per-attachment receipts, bounded transient retries and serialized refresh/metadata operations.
- [x] Run `python -m unittest discover -s pobierzchat -p 'test_*.py'` and review compatibility with existing import manifests.

## 3. Web OAuth and durable backend jobs

**Files:** new `backend/src/google-chat/google-chat-auth.ts` and `.spec.ts`, `google-chat-auth-routes.ts` and tests; `google-chat-downloader.ts` and tests; `config.ts`, `app.ts`, `projects/projects-routes.ts` and relevant tests.

- [x] Test start/callback state, browser binding, replay/expiry, denied consent, token errors, offline scopes, token persistence and secret-free status.
- [x] Add GET `/api/google-chat/auth/status`, POST `/api/google-chat/auth/start`, GET `/api/google-chat/auth/callback`; fixed configured HTTPS redirect and Google endpoints, request timeouts, state/PKCE.
- [x] Serialize Python processes and OAuth credential writes; cap process output and sanitize credential-bearing errors. Persist job state outside code, restore RUNNING as PAUSED, add resume endpoint and clean shutdown.
- [x] Preserve existing interfaces while adding AUTH_REQUIRED/PAUSED/PARTIAL_FAILURE states. Convert OAuth failures to 409 with machine code, not PhotoLocal's own 401 session failure.
- [x] Run backend focused tests then production TypeScript build.

## 4. User interface

**Files:** `frontend/src/api.ts`, `types.ts`, new `components/google-chat-connection.tsx`, `ChatImportPanel.tsx`, workflow helpers/tests.

- [x] Test workflow refuses to continue after AUTH_REQUIRED, PAUSED or PARTIAL_FAILURE.
- [x] Add connection status and browser reconnect button, safe error messages and explicit resume; keep app login intact on Google errors.
- [x] Explain invitation connection separately; on Linux link to Google Chat on the user's computer.
- [x] Run frontend tests and build.

## 5. Container and migration

**Files:** `Dockerfile`, `.dockerignore`, `compose.yaml`, `.env.docker.example`, build helper; `backend/src/filesystem/shared-folder-browser.ts` and tests; offline migration utility/tests; deployment documentation.

- [x] Test configured Linux roots and traversal/symlink rejection; test all stored path columns are remapped on a destination backup while the source remains unchanged.
- [x] Implement cross-platform build, image, health check and explicit mounts; persist token/job/download data, connect Ollama through configured URL.
- [ ] Build and smoke-test on Linux CI with isolated synthetic data (local engine did not start).
- [x] Document OAuth web-client setup including `https://romek.pawelzykubek.pl/api/google-chat/auth/callback`, Google Testing status, data backup, mount mappings, cutover and rollback.

## 6. Review and production readiness

- [x] Independent spec and code quality/security reviews passed after resolving and re-reviewing two P2 recovery issues.
- [x] Run complete relevant suites and builds once integrated.
- [ ] Production directory and RDP-only management are confirmed. Still verify the actual server commit, data paths, Docker startup and Google setup before any live switch.
