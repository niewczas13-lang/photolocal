# Production cutover preparation

The user approved migration while preserving current production work. Staging has
been exercised, including Google authentication, photo deduplication and restarts.
Its database has changed during testing and must not replace live production data.

This preparation step creates a separate verified writable NAS volume and adds a
read-only inventory of native production configuration. It does not stop the old
application, change public ports, disable its autostart or promote staging data.

- Implement `connect-production-storage` using the existing bounded SMB read/write
  probe, local credential prompt and stdin transport. Retain only a successful
  volume, publish a separate version 2 RW manifest, and preserve RO staging.
- Add a Windows PowerShell 5.1 inventory reporting known environment assignment
  names only, default data locations, listener/PID correlation, descendant
  processes, native autostart metadata and available disk space. Explicitly report
  that effective runtime configuration and active application jobs are unverified.
- Test secret redaction, resource collisions, uncertain probe cleanup and safe
  read-only metadata collection without real credentials or system mutations.
- Deploy these helpers through the existing branch and collect the server reports.

## Remaining work before the final switch

Resolve custom configuration and data roots, including geocoding keys and Ollama
settings, without printing secrets. Preserve these in private production settings.
Prepare separate production data/Google/download directories and a Compose project
using host port 4873, the public OAuth callback, and the new RW NAS volume. Resolve
the legacy file write/copy policy and review the known missing-path report; a
successful NAS probe is not proof that all historical photos are available.

Coordinate a short pause in application work. Native version 21aac58 has no shutdown
signal handler: wait for Google download, import, classification and user file
operations to finish. Then verify and disable only the native PhotoLocal Autostart
task, recheck the exact process identity, stop that instance and confirm that no
owned writer children remain. Do not use the broad existing stop-server.ps1.

After writers have stopped, make a fresh SQLite backup including committed WAL and
matching copies of local files. Migrate only that fresh copy and check counts and
file availability. Start production Docker and verify private/public health and
authenticated user operations. Keep the old files as the initial rollback point.
Once new production writes are allowed, rollback needs reconciliation of those
writes; restarting the stale native database would lose continuity.

The read-only inventory is not a complete quiescence check or permission to kill a
PID. It deliberately does not expose command lines, task arguments or `.env`
values. Relative entrypoint text plus a PID file provides correlation, not proof
of the process working directory.

## Private production configuration implementation

The server has now verified the separate RW volume and supplied a native-process
inventory. Source `.env` declares DB, log, port and Windows invite-headless only.
Proceed with preparation within the approved migration; do not start downtime yet.

- [x] Add `production-deployment-config.mjs` and tests: resolve native relative
  paths against `productionRoot/backend`; generate one standalone production
  Compose service pinned to the inspected image ID, host port 4873, public OAuth
  callback, six explicit mounts and fixed authentication. Preserve only known
  integrations with literal Compose escaping. Validate resolved Compose privately.
- [x] Add `prepare-production-deployment.mjs` and tests: parse native dotenv without
  importing app configuration; detect conflicts with the caller's Process/User/
  Machine settings; resolve the source DB and local directories; count all local
  files including hidden metadata while rejecting links and limiting traversal.
  Check the five source tables/counts through the native readonly SQLite runtime.
  Reserve local-copy bytes plus three SQLite/WAL/journal sizes and 1 GiB headroom.
  Copy the prepared Google web client and matching refresh token into the private
  production directory; verify the configured public callback is listed. Write
  config, mappings, source metadata and a nonsecret summary, but no database copy.
- [x] Add `prepare-production-deployment.ps1` and Windows tests: verify current
  Docker owner, create a fresh directory with a protected owner/SYSTEM/Administrators
  ACL, capture only known environment keys and pass them via UTF-8 stdin. Print
  validated summary fields only. Never print raw child errors or configuration.
- [x] Run focused Node/PS5 tests and real Compose parsing without starting services:
  57 tests passed, including private ACL creation, protected stdin transport,
  source WAL reads and actual offline Compose normalization. Read-only review
  confirmed scope; fix Windows key casing and match real Compose dollar escaping.
- [ ] Collect one server preparation report before constructing
  the final quiesce/snapshot/copy/start operation. A prepared config does not mark
  the pending database and file copy as complete.

Commands after implementation: `node --test scripts/production-deployment-config.spec.mjs
scripts/prepare-production-deployment.spec.mjs scripts/prepare-production-deployment.windows.spec.mjs`.
Fixtures use disposable local trees and synthetic tokens, never live customer data.
