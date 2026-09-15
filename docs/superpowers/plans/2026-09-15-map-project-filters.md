# Map project filters

**Goal:** Filter the map sidebar by cities from each project's address list and sort projects.

**Design:** Extend project summaries with `cities: string[]`, derived from `addresses.city` in a separate grouped query so checklist totals stay accurate. No migration or filename heuristics. A project can match multiple cities. Use compact labeled locality and sorting controls below the existing search, a visible result count, a filter reset, and locality labels on project cards. Filtering does not change the selected map. Keep the existing responsive and collapsed sidebar.

**Implementation:**

- [x] Backend: add database-backed tests for multiple/blank/duplicate cities and unchanged progress; expose city arrays consistently through list and single-project summaries.
- [x] Frontend helper: combine normalized text search and exact city membership, provide unique city options and counts, and sort a copied list by updated date, name, city or completion ratio. Missing cities sort last. Test Polish characters, multi-city projects, zero totals and input immutability.
- [x] UI: add controls, result count, reset and per-card cities; handle no matches. Extend frontend summary types and affected fixtures.
- [x] Verify focused and full workspace tests, production build, interactive desktop/mobile behavior, and independent code review.

**Source checkout:** `photolocal/.worktrees/google-auth-docker`, identified from the prior Docker deployment task. Existing deployment-document edits belong to the user and are preserved. Production Docker runs on another computer; local Docker engine is unavailable.

**Verification:** Backend 341 passed / 1 skipped; frontend 139 passed; full production build passed. Browser checks passed for combined filters, multiple cities, accent-insensitive search, all sorting criteria covered by unit tests, filter reset, selection preservation, desktop collapse, phone portrait (390x844) and short landscape (844x360) scrolling. Review findings fixed: summary refresh after address approval/manual map refresh, and SQLite UTC timestamp parsing. Temporary preview files and server were removed/stopped.
