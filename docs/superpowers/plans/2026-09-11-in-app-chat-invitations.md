# In-app Google Chat invitations and storage navigation

> For agentic workers: execute the independent parts with subagents and review their integration.

**Goal:** Find pending Google Chat room invitations and accept a selected invitation in Import Chat, including manual Google login in Romek; allow returning from Photos to the Photos/NAS selection without losing the project draft.

**Authorization:** The user requested both changes and selected login inside Romek without RDP on 2026-09-11.

**Architecture:** A separate browser container owns only its persistent browser profile. Headed Chromium, Xvfb and x11vnc provide a manual login desktop; the existing authenticated application proxies VNC through an operator-bound, expiring WebSocket lease. Browser automation is disconnected during manual login. Invitation listing is read-only, and acceptance operates on one previously discovered pending invitation and verifies membership before reporting success. The photo download OAuth session remains separate.

**Tech stack:** Existing React/Vite, Fastify, Playwright, Docker Compose; noVNC for the login window and Fastify WebSocket for the authenticated VNC transport.

## Storage navigation

- [x] Reproduce Photos -> disabled Up with the real CreateProjectDialog in an isolated browser and mocked filesystem endpoints.
- [x] Change frontend/src/components/CreateProjectDialog.tsx so Up at a storage root restores the roots list, while Up below a root opens the actual parent. Preserve file, project options, chosen storage path and folder-name draft. Disable conflicting actions during pending filesystem operations.
- [x] Verify Photos -> roots -> NAS, child -> parent, draft preservation and delayed responses in the browser. Keep the backend's root boundary intact.

## Browser container

- [x] Add docker/chat-browser/Dockerfile and entrypoint.sh: non-root headed browser, persistent /profile only, Xvfb and private VNC/CDP endpoints, process supervision and bounded startup health checks.
- [x] Keep port publication disabled and separate the browser from photo/database/NAS mounts. Keep sandbox enabled by default; any explicit sidecar-only compatibility switch must not alter the main application container.
- [x] Validate shell syntax and Docker contract. Run real container smoke checks where an engine is available; explicitly report if local Docker Engine is unavailable.

## Backend and membership operations

- [x] Add browser service and route tests for expired/foreign leases, unauthenticated access, cross-origin requests, concurrent login/automation, and selected invitation handling. See failures before implementation.
- [x] Extend Google Chat configuration and connection status with DOCKER_BROWSER when private browser endpoints are configured; retain existing Windows/link behavior otherwise.
- [x] Implement POST /api/google-chat/invites/browser/start, DELETE /api/google-chat/invites/browser/:sessionId, and authenticated WS /api/google-chat/invites/browser/:sessionId/socket. Return sessionId, expiresAt and a same-origin websocketPath; allow one operator at a time and invalidate the connection on expiry/logout/close.
- [x] Route existing invitation list/accept endpoints to the Docker browser when configured. Never report accepted after a click alone. Require pending-invitation evidence, re-resolve the selected candidate and confirm the exact joined room through Google Chat membership visibility. Return an actionable uncertainty/error if confirmation is unavailable.

## Frontend

- [x] Add a dedicated invitation panel with Find invitations, explicit Accept per room, distinct initial/empty/loading/error/login-required states, and refresh rooms after confirmed acceptance.
- [x] Add a lazily loaded noVNC login dialog. Close/release its lease on dismissal/unmount and show connection expiry/failure. Do not store or log Google passwords in application state; keyboard events travel only through the authenticated session transport.
- [x] Integrate the panel for DOCKER_BROWSER in ChatImportPanel and leave existing fallback modes functional.
- [x] Verify mocked invitation discovery/acceptance and browser-session transitions using tests and a real isolated browser; build both workspaces.

## Deployment and verification

- [x] Prepare scripts/update-chat-browser.ps1 with an image/service override for the known live production Compose files. Build before the main service restart, pin image IDs, preserve all existing production data mounts, add only the browser profile volume and private browser endpoints, and verify health without using an old database snapshot.
- [x] Document operator setup in a new docs/chat-invitations.md; do not overwrite the pre-existing edited docs/google-docker-deployment.md.
- [x] Review authentication/transport and Compose boundaries independently. Prepare the verified changes on codex/google-auth-docker for commit and push.
- [ ] Have the operator deploy, log in inside Romek and test a real selected invitation. Synthetic fixtures cannot prove Google's live markup or login challenge behavior.

## External constraints verified

- Google spaces.list returns joined spaces, not an invitation inbox: https://developers.google.com/workspace/chat/api/reference/rest/v1/spaces/list
- Membership patch supports role changes, not changing the output-only invitation state: https://developers.google.com/workspace/chat/api/reference/rest/v1/spaces.members/patch
- Google can require interactive verification or reject unsupported browser sign-in: https://support.google.com/accounts/answer/7675428
- noVNC API: https://github.com/novnc/noVNC/blob/master/docs/API.md
- Fastify WebSocket authentication hooks: https://github.com/fastify/fastify-websocket

## Verification evidence (2026-09-11)

- Full build: frontend and backend passed.
- Backend: 311 passed, 1 skipped; frontend: 114 passed.
- Updater: 9 passed, including real offline Compose and PowerShell 5 execution with mocked operations.
- Actual Chrome: folder navigation/draft preservation; invitation discovery/selected acceptance/error and timeout recovery; real noVNC RFB handshake against a synthetic desktop; serialized DOM selection and hidden-ancestor checks.
- Independent review completed. Local Docker Engine unavailable: browser image build, public WebSocket forwarding and Google login/invitation remain operator verification steps.
