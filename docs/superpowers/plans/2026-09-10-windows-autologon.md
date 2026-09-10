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

Local verification downloaded the official archive and validated the extracted Microsoft signature under Windows PowerShell 5.1 without launching the GUI. The real CIM-definition test initially exposed PowerShell module auto-loading replacing mocks; the resulting local test task was identified by its exact definition, removed, and the test now imports modules before mocking and disables further auto-loading. No GUI, password configuration or screen lock ran during this check. Server installation and a coordinated full-host reboot remain untested.
