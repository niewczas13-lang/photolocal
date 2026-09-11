# Final production cutover implementation plan

**Goal:** Move the verified native installation to the prepared Docker service using
a fresh database and matching local files, while retaining the original data.

The server preparation succeeded: the source database contains 32 projects and
14,396 photos; local copies total approximately 9.05 GB and available space is
29.06 GB. Google web credentials, matching refresh token and public callback are
verified. The user controls the server by RDP and has authorized migration. A
short work pause must be confirmed before running the final command.

- [x] `production-file-copy.mjs` plus tests: copy full local trees exclusively into
  empty destinations, include hidden metadata and empty directories, verify hashes
  and source stability, refuse links/overlap, retain partial copies on failure.
- [x] `finalize-production-data.mjs` plus tests: revalidate the private preparation;
  before stopping native, snapshot/migrate/audit a comparison copy using read-only
  original files and NAS. Permit only missing NAS references already recorded by
  the tested staging preview. After the coordinator confirms native stopped, take
  a new snapshot, copy local files, migrate and audit again. Check all five counts,
  source stability and absence of new gaps. Never start application services.
- [x] `windows-native-cutover.ps1` plus tests: correlate the exact native PID,
  creation time, owner, PID file and autostart log; verify the native task and runner;
  refuse active writer children. Back up and disable only that task, stop only that
  instance, confirm port 4873 is empty and write the stop marker. Offer scoped native
  recovery only before the production start marker exists.
- [x] `switch-production-to-docker.ps1` plus tests: coordinate preflight, verified
  staging stop, native stop, final copy, production start and health/count checks.
  Start only the prepared project on 4873. Compare public/private application HTML.
  Before start, failures can restore native; after start, keep new writes and report
  attention instead of reverting to stale data. Print bounded, nonsecret progress.
- [x] Independently review copy, finalizer, native lifecycle and coordinator. Run
  focused PS5/Node/SQLite/Compose tests: 116 passed, including real SQLite WAL,
  exclusive file copies, Windows argument handling and scoped helper timeout.
  Add these checks to CI and document the operator command and recovery boundary.
- [ ] Run the published helper on the server during the work pause and verify the
  resulting deployment. Production remains unchanged until the user runs that
  command. No shared-host reboot or unrelated Docker changes.

Prior NAS findings describe what Docker could not read. They do not prove those
files are unavailable to the native Windows application. Preserve those findings
in the cutover report; do not rename folders, create substitutes or erase records.

Completion requires successful private/public health, unchanged snapshot counts,
and user verification of projects/photos/Google access through the public address.
