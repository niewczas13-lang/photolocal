# Project Map Tab Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Add a PhotoLocal project map that reuses the existing project database and photo checklist, without duplicating orders.

**Architecture:** Extend the existing PhotoLocal GPKG extractor to store map geometry in the same SQLite database as projects, addresses, checklist nodes, and photos. Add backend map queries/status mutations, then add a `Mapa` tab in the existing project view.

**Tech Stack:** Fastify, better-sqlite3, TypeScript, React, Vite, Leaflet/react-leaflet, Vitest.

---

## File Structure

- Modify `backend/src/types.ts`: add map geometry/status types.
- Modify `backend/src/gpkg/gpkg-extractor.ts`: decode GPKG geometry, reproject coordinates, and return addresses with coordinates plus polygons/cables/nodes.
- Modify `backend/src/gpkg/gpkg-extractor.spec.ts`: cover address coordinates and map feature extraction.
- Modify `backend/src/db/schema.sql`: add map tables.
- Modify `backend/src/db/migrations.ts`: add idempotent migration for existing local databases.
- Modify `backend/src/projects/projects-repository.ts`: persist map features on create/recalculate and expose map summaries.
- Modify `backend/src/projects/projects-routes.ts`: return map data and update work item status.
- Modify `backend/src/projects/projects-routes.spec.ts` or repository specs: cover `/api/projects/:projectId/map`.
- Modify `frontend/package.json` and lockfile: add `leaflet`, `react-leaflet`, and `@types/leaflet`.
- Modify `frontend/src/types.ts`: add project map DTOs and `ProjectTab = 'map'` support via `App.tsx`.
- Modify `frontend/src/api.ts`: add map API calls.
- Create `frontend/src/components/ProjectMap.tsx`: render map layers and status actions.
- Modify `frontend/src/components/ProjectView.tsx`: add `Mapa` tab.
- Modify `frontend/src/styles.css`: import Leaflet CSS and minimal popup/icon styling.

## Task 1: Backend Map Extraction

**Files:**
- Modify: `backend/src/types.ts`
- Modify: `backend/src/gpkg/gpkg-extractor.ts`
- Test: `backend/src/gpkg/gpkg-extractor.spec.ts`

- [ ] **Step 1: Write the failing extractor tests**

Add tests that create a temporary GPKG-like SQLite file with `PA`, `Lokale`, `Rejonizacja`, and `Kable Swiatlowodowe` tables. The expected assertions:

```ts
expect(result.addresses[0]).toMatchObject({
  city: 'Radom',
  street: 'Polna',
  buildingNo: '15',
  distributionPoint: 'RADOM/OSD0001',
});
expect(result.addresses[0].lat).toBeGreaterThan(48);
expect(result.addresses[0].lng).toBeGreaterThan(13);
expect(result.polygons[0].osdName).toBe('OSD0001');
expect(result.trunkCables[0]).toMatchObject({
  fromNode: 'ZS0001',
  toNode: 'OSD0001',
  osdName: 'OSD0001',
});
expect(result.infraNodes.map((node) => node.nodeType).sort()).toEqual(['OSD', 'ZS']);
```

- [ ] **Step 2: Run the failing extractor tests**

Run:

```bash
npm run test --workspace backend -- backend/src/gpkg/gpkg-extractor.spec.ts
```

Expected: fail because `polygons`, `trunkCables`, `infraNodes`, and address coordinates are not returned yet.

- [ ] **Step 3: Implement minimal extractor support**

Add these exported interfaces in `backend/src/types.ts`:

```ts
export interface MapPolygonInput {
  osdName: string;
  label: string | null;
  geojson: Record<string, unknown>;
  households: number | null;
  paCount: number | null;
  cableRef: string | null;
}

export interface MapTrunkCableInput {
  cableType: string;
  fromNode: string;
  toNode: string;
  osdName: string;
  geojson: Record<string, unknown>;
  rawName: string | null;
}

export interface MapInfraNodeInput {
  nodeType: 'OSD' | 'OPP' | 'ZS';
  name: string;
  label: string | null;
  lat: number;
  lng: number;
}
```

Extend `GpkgExtractionResult` with:

```ts
polygons: MapPolygonInput[];
trunkCables: MapTrunkCableInput[];
infraNodes: MapInfraNodeInput[];
```

Port the existing GPKG binary geometry helpers from Fiber ERP into `backend/src/gpkg/gpkg-extractor.ts`: `gpkgWkbOffset`, point parsing, GeoJSON parsing, and EPSG:2180 to WGS84 reprojection using `proj4`.

- [ ] **Step 4: Run extractor tests again**

Run:

```bash
npm run test --workspace backend -- backend/src/gpkg/gpkg-extractor.spec.ts
```

Expected: pass.

## Task 2: SQLite Schema And Persistence

**Files:**
- Modify: `backend/src/db/schema.sql`
- Modify: `backend/src/db/migrations.ts`
- Modify: `backend/src/projects/projects-repository.ts`
- Test: `backend/src/projects/projects-repository.spec.ts`

- [ ] **Step 1: Write failing repository tests**

Add a test that creates a project with map features and expects `getProjectMap(project.id)` to return:

```ts
expect(map.addresses).toHaveLength(1);
expect(map.addresses[0].hasReservePhoto).toBe(false);
expect(map.polygons[0].osdName).toBe('OSD0001');
expect(map.trunkCables[0].status).toBe('PENDING');
expect(map.infraNodes[0].status).toBe('PENDING');
```

Add a second test that adds a photo to a `CABLE_RESERVE` node and expects the matching map address to turn green:

```ts
expect(map.addresses[0].hasReservePhoto).toBe(true);
```

- [ ] **Step 2: Run the failing repository tests**

Run:

```bash
npm run test --workspace backend -- backend/src/projects/projects-repository.spec.ts
```

Expected: fail because map tables and repository methods do not exist.

- [ ] **Step 3: Add map tables**

Add to `backend/src/db/schema.sql`:

```sql
CREATE TABLE IF NOT EXISTS map_polygons (
  id TEXT PRIMARY KEY,
  project_id TEXT NOT NULL REFERENCES projects(id) ON DELETE CASCADE,
  osd_name TEXT NOT NULL,
  label TEXT,
  geojson TEXT NOT NULL,
  households INTEGER,
  pa_count INTEGER,
  cable_ref TEXT,
  UNIQUE(project_id, osd_name)
);

CREATE TABLE IF NOT EXISTS map_trunk_cables (
  id TEXT PRIMARY KEY,
  project_id TEXT NOT NULL REFERENCES projects(id) ON DELETE CASCADE,
  cable_type TEXT NOT NULL,
  from_node TEXT NOT NULL,
  to_node TEXT NOT NULL,
  osd_name TEXT NOT NULL,
  geojson TEXT NOT NULL,
  raw_name TEXT,
  status TEXT NOT NULL DEFAULT 'PENDING' CHECK (status IN ('PENDING', 'DUCT_READY', 'PULLED', 'WELDED')),
  UNIQUE(project_id, from_node, to_node)
);

CREATE TABLE IF NOT EXISTS map_infra_nodes (
  id TEXT PRIMARY KEY,
  project_id TEXT NOT NULL REFERENCES projects(id) ON DELETE CASCADE,
  node_type TEXT NOT NULL CHECK (node_type IN ('OSD', 'OPP', 'ZS')),
  name TEXT NOT NULL,
  label TEXT,
  lat REAL NOT NULL,
  lng REAL NOT NULL,
  status TEXT NOT NULL DEFAULT 'PENDING' CHECK (status IN ('PENDING', 'WELDED')),
  UNIQUE(project_id, node_type, name)
);
```

Add indexes for `project_id` on all three tables.

- [ ] **Step 4: Add repository persistence**

Update `CreateProjectInput` and `RecalculateChecklistInput` with map feature arrays. In `createProject()` and `recalculateChecklist()`, insert/upsert the map rows in the same transaction as addresses/checklist nodes.

Add:

```ts
getProjectMap(projectId: string): ProjectMapRecord
updateCableStatus(projectId: string, cableId: string, status: MapCableStatus): void
updateInfraNodeStatus(projectId: string, nodeId: string, status: MapNodeStatus): void
```

The map query must derive `hasReservePhoto` from `CABLE_RESERVE` checklist nodes joined through `address_id` and `photos`.

- [ ] **Step 5: Run repository tests again**

Run:

```bash
npm run test --workspace backend -- backend/src/projects/projects-repository.spec.ts
```

Expected: pass.

## Task 3: Backend Map API

**Files:**
- Modify: `backend/src/projects/projects-routes.ts`
- Test: `backend/src/projects/projects-routes.spec.ts`

- [ ] **Step 1: Write failing route tests**

Add route tests for:

```ts
GET /api/projects/:projectId/map
PATCH /api/projects/:projectId/map/cables/:cableId/status
PATCH /api/projects/:projectId/map/nodes/:nodeId/status
```

Expected body for cable status update:

```json
{ "status": "DUCT_READY" }
```

Expected body for node status update:

```json
{ "status": "WELDED" }
```

- [ ] **Step 2: Run the failing route tests**

Run:

```bash
npm run test --workspace backend -- backend/src/projects/projects-routes.spec.ts
```

Expected: fail because routes do not exist.

- [ ] **Step 3: Implement routes**

Add handlers in `registerProjectRoutes()`:

```ts
app.get('/api/projects/:projectId/map', async (request, reply) => {
  const { projectId } = request.params as { projectId: string };
  const project = repository.getProject(projectId);
  if (!project) return reply.status(404).send({ error: 'Project not found' });
  return repository.getProjectMap(projectId);
});
```

Add patch handlers that validate allowed statuses before calling repository update methods.

- [ ] **Step 4: Run route tests again**

Run:

```bash
npm run test --workspace backend -- backend/src/projects/projects-routes.spec.ts
```

Expected: pass.

## Task 4: Frontend Dependencies, Types, And API

**Files:**
- Modify: `frontend/package.json`
- Modify: `package-lock.json`
- Modify: `frontend/src/types.ts`
- Modify: `frontend/src/api.ts`
- Modify: `frontend/src/App.tsx`

- [ ] **Step 1: Add dependencies**

Run:

```bash
npm install --workspace frontend leaflet react-leaflet @types/leaflet
```

- [ ] **Step 2: Add frontend map types**

Add `ProjectMapData`, `ProjectMapAddress`, `ProjectMapPolygon`, `ProjectMapCable`, and `ProjectMapInfraNode` to `frontend/src/types.ts`.

- [ ] **Step 3: Add API client methods**

Add:

```ts
getProjectMap: (projectId: string) => request<ProjectMapData>(`/api/projects/${projectId}/map`),
updateMapCableStatus: (projectId: string, cableId: string, status: ProjectMapCable['status']) =>
  request<ProjectMapData>(`/api/projects/${projectId}/map/cables/${cableId}/status`, {
    method: 'PATCH',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ status }),
  }),
updateMapNodeStatus: (projectId: string, nodeId: string, status: ProjectMapInfraNode['status']) =>
  request<ProjectMapData>(`/api/projects/${projectId}/map/nodes/${nodeId}/status`, {
    method: 'PATCH',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ status }),
  }),
```

- [ ] **Step 4: Add route tab support**

Add `'map'` to `ProjectTab` and `PROJECT_TABS` in `frontend/src/App.tsx`.

- [ ] **Step 5: Run frontend typecheck/build**

Run:

```bash
npm run build --workspace frontend
```

Expected: fail until `ProjectMap` exists and is wired in Task 5, or pass if no component import has been added yet.

## Task 5: Frontend Map Tab

**Files:**
- Create: `frontend/src/components/ProjectMap.tsx`
- Modify: `frontend/src/components/ProjectView.tsx`
- Modify: `frontend/src/styles.css`

- [ ] **Step 1: Create `ProjectMap.tsx`**

Implement a focused component that:

- fetches `api.getProjectMap(projectId)`;
- renders `GeoJSON` polygons with the existing area color logic;
- renders cables as `Polyline`;
- renders OSD triangle, OPP circle, ZS square, and address house icons as Leaflet div icons;
- shows address markers red when `hasReservePhoto === false` and green when true;
- shows OSD/OPP/ZS red when pending and green when welded;
- shows cables red when pending, yellow when `DUCT_READY`, and green when `PULLED` or `WELDED`;
- sends status updates through the API and refreshes the map.

- [ ] **Step 2: Add the map tab to `ProjectView.tsx`**

Import `Map` icon and `ProjectMap`, add a `TabsTrigger value="map"`, and add:

```tsx
<TabsContent value="map" className="flex-1 min-h-0 mt-0 data-[state=inactive]:hidden">
  <ProjectMap projectId={projectId} />
</TabsContent>
```

- [ ] **Step 3: Add Leaflet CSS**

Add to `frontend/src/styles.css`:

```css
@import "leaflet/dist/leaflet.css";
```

Keep map container height fixed by parent flex layout to avoid blank maps.

- [ ] **Step 4: Run frontend build**

Run:

```bash
npm run build --workspace frontend
```

Expected: pass.

## Task 6: Full Verification

**Files:**
- No code files unless verification exposes a defect.

- [ ] **Step 1: Run backend tests**

Run:

```bash
npm run test --workspace backend
```

Expected: pass.

- [ ] **Step 2: Run frontend tests/build**

Run:

```bash
npm run test --workspace frontend
npm run build --workspace frontend
```

Expected: pass.

- [ ] **Step 3: Start local app for manual check**

Run:

```bash
npm run dev
```

Expected: backend and frontend start. Open the app and verify the `Mapa` tab appears inside an existing project.

## Self-Review

- Spec coverage: the plan covers one database, map extraction, photo-driven address status, manual map work status, and a new PhotoLocal tab.
- Placeholder scan: no TBD/TODO markers are present.
- Type consistency: status names are `PENDING`, `DUCT_READY`, `PULLED`, `WELDED` for cables and `PENDING`, `WELDED` for nodes across backend and frontend.
