# Map Address Candidates Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Build the "Dodaj adres" map workflow from clicked point to approved checklist folder.

**Architecture:** Add a backend candidate table and repository methods, a small Adresy.app reverse-geocoder, API routes, frontend types/API calls, and map UI for candidate markers plus a review tab. Approval is the only point where normal addresses and checklist folders are created.

**Tech Stack:** Fastify, better-sqlite3, Vitest, React, Leaflet.

---

### Task 1: Backend Data Model

**Files:**
- Modify: `backend/src/db/schema.sql`
- Modify: `backend/src/types.ts`
- Modify: `backend/src/projects/projects-repository.ts`
- Test: `backend/src/projects/projects-repository.spec.ts`

- [ ] Write repository tests for pending candidate creation and map serialization.
- [ ] Add `map_address_candidates` schema and indexes.
- [ ] Add candidate types.
- [ ] Add repository methods to create, list, approve, and reject candidates.

### Task 2: Reverse Geocoder

**Files:**
- Create: `backend/src/geocoding/address-geocoder.ts`
- Create: `backend/src/geocoding/address-geocoder.spec.ts`
- Modify: `backend/src/config.ts`

- [ ] Write geocoder tests with a fake `fetch`.
- [ ] Add Adresy.app URL/key config.
- [ ] Parse `/lookup/blisko` results into the app's address candidate shape.

### Task 3: API Routes

**Files:**
- Modify: `backend/src/projects/projects-routes.ts`
- Test: `backend/src/projects/projects-routes.spec.ts`

- [ ] Write route tests for click creation, approval, and validation.
- [ ] Add `POST /api/projects/:projectId/map/address-candidates/reverse`.
- [ ] Add `POST /api/projects/:projectId/map/address-candidates/:candidateId/approve`.
- [ ] Add `POST /api/projects/:projectId/map/address-candidates/:candidateId/reject`.

### Task 4: Frontend Map Workflow

**Files:**
- Modify: `frontend/src/types.ts`
- Modify: `frontend/src/api.ts`
- Modify: `frontend/src/app-routing.ts`
- Modify: `frontend/src/app-routing.spec.ts`
- Modify: `frontend/src/components/ProjectMap.tsx`
- Create: `frontend/src/components/ProjectMapAddressCandidates.tsx`
- Modify: `frontend/src/styles.css`

- [ ] Write routing test for `/mapa/projects/:id/address-candidates`.
- [ ] Add candidate types and API calls.
- [ ] Add "Dodaj adres" click mode and candidate markers.
- [ ] Add the "Adresy do dodania" review tab with approve/reject controls.

### Task 5: Verification

- [ ] Run backend focused tests.
- [ ] Run frontend focused tests.
- [ ] Run `npm test`.
- [ ] Run `npm run build`.
- [ ] Start the app and verify the map UI manually.
- [ ] Commit and push to `main`.

