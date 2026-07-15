# Map Notes Export Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Add a project XLSX export for non-address map notes, with an optional Qwen-generated operational summary.

**Architecture:** Keep filtering and workbook creation in a focused report module, and place the Ollama text request in a separate summarizer with an injectable `fetch`. Expose one report endpoint with an optional `summary=qwen` query and connect two explicit actions in the existing map notes view.

**Tech Stack:** TypeScript, Fastify, React, Vitest, the existing zero-dependency XLSX writer, Ollama `/api/chat`.

---

### Task 1: Non-address map notes workbook

**Files:**
- Create: `backend/src/reports/map-notes-report.spec.ts`
- Create: `backend/src/reports/map-notes-report.ts`

- [ ] **Step 1: Write the failing report tests**

Test the public API before it exists:

```ts
const notes = [
  createNote({ id: 'address-note', targetType: 'address', body: 'Komentarz adresowy' }),
  createNote({ id: 'cable-note', targetType: 'cable', body: 'Niedroznosc kabla' }),
  createNote({ id: 'free-note', targetType: 'free', body: 'Uszkodzona nawierzchnia' }),
];

expect(getExportableMapNotes(notes).map((note) => note.id)).toEqual(['cable-note', 'free-note']);

const workbook = buildMapNotesReport(project, map);
const content = workbook.toString('utf8');
expect(content).toContain('Niedroznosc kabla');
expect(content).not.toContain('Komentarz adresowy');
```

Also test an empty export and a supplied Qwen summary sheet.

- [ ] **Step 2: Run the tests and verify RED**

Run: `npm test --workspace backend -- src/reports/map-notes-report.spec.ts`

Expected: FAIL because `map-notes-report.ts` and its exports do not exist.

- [ ] **Step 3: Implement filtering and workbook creation**

Create these public contracts:

```ts
export interface MapNotesSummary {
  overview: string;
  blockers: string[];
  recommendedActions: string[];
  attentionPoints: string[];
  model: string;
  generatedAt: string;
}

export function getExportableMapNotes(notes: ProjectMapNote[]): ProjectMapNote[] {
  return notes.filter((note) => note.targetType !== 'address');
}

export function buildMapNotesReport(
  project: ProjectRecord,
  notes: ProjectMapNote[],
  summary?: MapNotesSummary,
): Buffer;
```

Build `Notatki` with Polish type labels and the approved columns. Add a `Brak notatek nieprzypisanych do adresow` row when empty. Add `Podsumowanie Qwen` only when `summary` is supplied.

- [ ] **Step 4: Run the tests and verify GREEN**

Run: `npm test --workspace backend -- src/reports/map-notes-report.spec.ts`

Expected: all report tests PASS.

### Task 2: Qwen text summarizer

**Files:**
- Create: `backend/src/reports/map-notes-summarizer.spec.ts`
- Create: `backend/src/reports/map-notes-summarizer.ts`

- [ ] **Step 1: Write the failing summarizer tests**

Cover model fallback, structured response parsing, the outgoing Ollama request, malformed JSON, and HTTP errors:

```ts
const fetchImpl = vi.fn(async () => new Response(JSON.stringify({
  message: {
    content: JSON.stringify({
      overview: 'Dwie kwestie wymagaja reakcji.',
      blockers: ['Niedroznosc'],
      recommendedActions: ['Sprawdzic studnie'],
      attentionPoints: ['Studnia S-1'],
    }),
  },
}), { status: 200 }));

const summary = await summarizeMapNotes({
  projectName: 'BARTAG',
  notes: [note],
  fetchImpl,
  model: 'qwen-test',
});

expect(summary.model).toBe('qwen-test');
expect(summary.blockers).toEqual(['Niedroznosc']);
```

- [ ] **Step 2: Run the tests and verify RED**

Run: `npm test --workspace backend -- src/reports/map-notes-summarizer.spec.ts`

Expected: FAIL because the summarizer module does not exist.

- [ ] **Step 3: Implement the text-only Ollama client**

Implement:

```ts
export type MapNotesSummarizer = (input: {
  projectName: string;
  notes: ProjectMapNote[];
}) => Promise<MapNotesSummary>;

export function getDefaultNotesModel(): string {
  return process.env.OLLAMA_NOTES_MODEL?.trim()
    || process.env.OLLAMA_VISION_MODEL?.trim()
    || 'qwen2.5vl:3b';
}

export async function summarizeMapNotes(input: SummarizeMapNotesInput): Promise<MapNotesSummary>;
```

Send a Polish FTTH-oriented prompt to `${OLLAMA_URL}/api/chat` with `stream: false`, `format: 'json'`, no images, temperature `0`, and a bounded timeout. Validate every returned field and throw readable errors for transport or response failures.

- [ ] **Step 4: Run the tests and verify GREEN**

Run: `npm test --workspace backend -- src/reports/map-notes-summarizer.spec.ts`

Expected: all summarizer tests PASS.

### Task 3: Report API routes

**Files:**
- Modify: `backend/src/projects/projects-routes.ts`
- Modify: `backend/src/projects/projects-routes.spec.ts`

- [ ] **Step 1: Write failing route tests**

Add tests for:

```text
GET /api/projects/:projectId/reports/map-notes.xlsx
GET /api/projects/:projectId/reports/map-notes.xlsx?summary=qwen
GET /api/projects/:projectId/reports/map-notes.xlsx?summary=invalid
```

Verify XLSX headers and file names, confirm the address note body is absent, confirm the Qwen sheet is present only in Qwen mode, and verify summarizer failures return `502` with the original readable message.

- [ ] **Step 2: Run the route tests and verify RED**

Run: `npm test --workspace backend -- src/projects/projects-routes.spec.ts -t "map notes report"`

Expected: FAIL with `404` because the report route is missing.

- [ ] **Step 3: Add an injectable summarizer and route**

Extend route options:

```ts
export interface RegisterProjectRoutesOptions {
  addressGeocoder?: AddressGeocoder;
  mapNotesSummarizer?: MapNotesSummarizer;
}
```

The route reads current map notes, filters them once, skips Qwen for an empty list, maps `summary=qwen` to the injected/default summarizer, and catches Qwen errors as `502`. Use file names `<projekt>_raport_notatek.xlsx` and `<projekt>_raport_notatek_qwen.xlsx`.

- [ ] **Step 4: Run the route tests and verify GREEN**

Run: `npm test --workspace backend -- src/projects/projects-routes.spec.ts -t "map notes report"`

Expected: all focused route tests PASS.

### Task 4: Frontend download actions

**Files:**
- Create: `frontend/src/map-notes-export.spec.ts`
- Create: `frontend/src/map-notes-export.ts`
- Modify: `frontend/src/api.ts`
- Modify: `frontend/src/components/ProjectMap.tsx`
- Modify: `frontend/src/components/ProjectMapNotes.tsx`
- Modify: `frontend/src/styles.css`

- [ ] **Step 1: Write the failing frontend helper tests**

```ts
expect(buildMapNotesReportUrl('project-1', false))
  .toBe('/api/projects/project-1/reports/map-notes.xlsx');
expect(buildMapNotesReportUrl('project-1', true))
  .toBe('/api/projects/project-1/reports/map-notes.xlsx?summary=qwen');
expect(buildMapNotesReportFileName('BARTAG / 01', true))
  .toBe('BARTAG_01_raport_notatek_qwen.xlsx');
```

- [ ] **Step 2: Run the frontend test and verify RED**

Run: `npm test --workspace frontend -- src/map-notes-export.spec.ts`

Expected: FAIL because the helper module does not exist.

- [ ] **Step 3: Implement download wiring and UI states**

Add `api.downloadMapNotesReport(projectId, includeQwenSummary)` using `requestBlob`. In `ProjectMap`, track `notesReportBusy: 'plain' | 'qwen' | null`, create and revoke the object URL, and surface errors through the existing map error area.

Extend `ProjectMapNotes` with:

```ts
onDownloadReport: (includeQwenSummary: boolean) => void;
reportBusy: 'plain' | 'qwen' | null;
```

Render `Eksport XLSX` and `Eksport + Qwen` as compact icon-and-text buttons in the notes header. Disable both during any report request and show `Generuje...` or `Qwen pracuje...` on the active button. Keep the badge and actions wrapping cleanly on mobile.

- [ ] **Step 4: Run the frontend tests and build**

Run: `npm test --workspace frontend -- src/map-notes-export.spec.ts`

Expected: helper tests PASS.

Run: `npm run build --workspace frontend`

Expected: TypeScript and Vite build PASS.

### Task 5: Full verification and review

**Files:**
- Review all files changed by Tasks 1-4.

- [ ] **Step 1: Run all automated tests**

Run: `npm test`

Expected: backend and frontend suites PASS with zero failures.

- [ ] **Step 2: Run the production build**

Run: `npm run build`

Expected: frontend and backend builds PASS.

- [ ] **Step 3: Check the patch**

Run: `git diff --check`

Expected: no whitespace errors.

Run: `git status --short`

Expected: only the planned report, summarizer, route, frontend, test, and documentation files are changed.

- [ ] **Step 4: Review requirements against the spec**

Confirm that address notes are excluded, regular export never calls Qwen, empty exports work, Qwen errors are readable, both buttons show busy states, and existing address reporting is unchanged.

