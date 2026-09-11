# Windows Autologon Implementation Plan

> **For agentic workers:** Use superpowers:subagent-driven-development to implement this approved deployment step.

**Goal:** Prepare the explicitly authorized Windows autologon for the existing Docker Desktop owner, with automatic console locking, without handling the Windows password in scripts.

**Architecture:** An elevated PowerShell 5.1 installer verifies that its current account owns the running Docker backend and has the existing Docker sign-in entry. It downloads Microsoft's Autologon to a new private deployment directory, validates the Microsoft Authenticode signature, installs one scoped logon task, then opens the official GUI for local password entry. A separate limited-privilege runner requests a console lock and skips RDP sessions. The installer checks only non-secret Winlogon settings after the GUI closes.

**Tech Stack:** Windows PowerShell 5.1, Task Scheduler, Win32 console-lock APIs, Microsoft Sysinternals Autologon, Node's test runner.

- [x] Write failing boundary tests for the installer and console-lock runner; no actual local task registration, GUI launch, locking or autologon changes in the final tests.
- [x] Implement the runner with account/session checks and bounded retries; a successful asynchronous request must not be reported as verified locking.
- [x] Implement account/sign-in preflight, fresh-directory download/extraction, signature validation, scoped task creation and GUI-only credentials. Refuse unrelated task collisions; preserve production's old autostart until cutover.
- [x] Verify the configured autologon account after GUI exit, without reading the password or LSA secret. Distinguish configuration from a successful boot.
- [x] Document server commands, password versus PIN/SMB-account distinction, idempotent retries, targeted rollback and later reboot validation.
- [x] Run Windows boundary tests and review the deployment helpers: 24 tests passed under Windows PowerShell 5.1. Prepared for commit and push.

The user has approved autologon with screen locking. No additional approval gate is needed for preparation or installing those settings. Restarting the shared Windows host and the later production cutover remain separate coordinated actions. The original server files, SQLite database, Google token and network share remain untouched by this installer. It must not restart Docker or install a second engine.

Local verification downloaded the official archive and validated the extracted Microsoft signature under Windows PowerShell 5.1 without launching the GUI. The real CIM-definition test initially exposed PowerShell module auto-loading replacing mocks; the resulting local test task was identified by its exact definition, removed, and the test now imports modules before mocking and disables further auto-loading. No GUI, password configuration or screen lock ran during this local check.

## Confirmed boot timeout follow-up

The user installed Autologon and performed two coordinated host reboots. Application ports and public health returned before the requested RDP entry, and the user confirmed healthy containers. The console-lock task was terminated after one minute; the second boot's Operational event 329 explicitly confirmed the execution limit. A manual RDP task run completed with exit 0, and a read-only native API loading probe took 0.9 seconds. These warm results do not establish cold-boot console locking or explain the internal startup delay.

The existing approved lock design is retained. Increase only the verified legacy task limit from PT1M to PT5M, without delaying its trigger or changing the bounded retry policy. Add -RepairConsoleLock to update that setting without reopening Autologon or touching credentials. Record per-run, best-effort progress before native compilation and around session/lock checks; preserve separate boot/RDP traces with bounded retention. No new reboot is performed by the repair command.

Verification uses Windows PowerShell 5.1 tests with task mutations and lock APIs mocked, importing modules before the mocks. Cover exact legacy upgrade, conflict/busy refusal, idempotency, early progress, privacy, and logging failure isolation.

All 34 combined Windows PowerShell 5.1 tests passed. Review also checked real in-memory CIM settings and the trigger's empty execution limit, without registering a task. The repair refuses a task that disappears during its preflight, and no local scheduled task remains from verification.

The user installed the repair and completed a third coordinated cold boot on 2026-09-10. Application health returned before RDP entry was allowed at 18:05:03 UTC. The boot trace records matching process/console session 1, native initialization completed, and LockWorkStation accepted the request at 18:01:16 UTC, with final LOCK_REQUEST_ACCEPTED / exitCode 0 after 5.9 seconds. This verifies execution at boot and acceptance before RDP, not an independently observed locked screen. No further reboot is needed for the current preparation step; production cutover has not been performed.
