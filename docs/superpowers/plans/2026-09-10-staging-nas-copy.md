# Staging NAS and database copy implementation plan

> **For agentic workers:** Use superpowers:subagent-driven-development to execute the independent helpers, then review their integration.

**Goal:** Show existing projects and photo samples in isolated Docker staging while production continues working.

**Architecture:** Retain a dedicated read-only CIFS volume after one private authentication. Take an online SQLite backup using the native Windows runtime, migrate only that completed snapshot, and create a private Compose override. Mount production photo/download directories read-only; keep new downloads, Google credentials and the test project folder in existing staging directories.

**Tech Stack:** Node 24, better-sqlite3 online backup, Windows PowerShell 5, Docker Compose, the existing offline migration helper.

The user has authorized Docker migration, continuity of production, a staging database copy and the dedicated storage account. The latest Docker test confirms photo read, isolated file write/rename/delete, and cleanup. These helpers implement the already agreed staging step; they do not switch public traffic.

## Steps

- [ ] Add `scripts/snapshot-staging-database.mjs` and its spec. Open source read-only through the production native dependency; include committed WAL records through SQLite's backup API. Validate integrity and counts, publish a new file without overwrite, bound progress, and suppress raw CLI errors. Test real SQLite with WAL and existing destinations.
- [ ] Add `scripts/connect-staging-storage.mjs`, its PowerShell wrapper and spec. Accept credentials through UTF-8 stdin, run the existing read-only directory probe, keep a uniquely named CIFS volume only on success, and publish a credential-free `docker-data/storage.json`. Test failure cleanup and secret suppression.
- [ ] Add `scripts/audit-staging-copy.mjs` and its spec. Read counts, inspect each project folder and at most three original photos per project from the mounted snapshot. Return only aggregate results and fixed statuses.
- [ ] Add `scripts/prepare-staging-copy.mjs` and its spec. Refuse an existing staging-copy manifest, create a unique private run directory, call native online backup, run the existing offline migrator in the already-built image, validate the merged Compose configuration, audit read-only storage, and publish the resulting override path only when verified.
- [ ] The override replaces only staging's `/data` mount with the new database directory. NAS is `/nas`; existing local photos and downloads are `/legacy-local-photos` and `/legacy-downloads`, both read-only. Existing staging Google settings and writable test directories remain supplied by `.env.docker`.
- [ ] Validate with `node --test scripts/*staging*.spec.mjs` using explicitly enumerated filenames on Windows, plus existing SMB/migration tests and offline Docker Compose parsing. Include the new Node tests in Linux CI.
- [ ] Update deployment documentation with native snapshot limitations, retained Docker credential metadata, startup and rollback commands, and the distinction between staging validation and final cutover.
- [ ] Commit and push to the existing migration branch after review. Give the user commands to connect storage, prepare the verified copy and recreate only the loopback staging service.

## Completion evidence

The user should receive `STAGING_STORAGE_READY`, then `STAGING_COPY_READY` with matching snapshot/audit counts and accessible project folders/photo samples. The final user-run Compose command recreates only `photolocal-staging`; public production continues to use its original database and files. A future production cutover still needs a fresh consistent database/files plan, Google browser testing and a Windows reboot/autostart check.
