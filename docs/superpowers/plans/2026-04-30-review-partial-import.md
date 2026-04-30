# Review Partial Import Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Allow Google Chat review batches to keep unchecked leftover photos in the same `PENDING_REVIEW` batch after a partial import.

**Architecture:** Extend the chat batch repository with file-removal support, then change `acceptChatBatch` to import selected files and shrink the batch instead of always closing it. Keep the current UI selection model and rely on existing refresh flows so the same review card re-renders with fewer files after import.

**Tech Stack:** TypeScript, Fastify, better-sqlite3, Vitest, React

---

## File Map

- Modify: `backend/src/chat-import/chat-batches-repository.ts`
  Add repository support for removing imported file rows from the active batch and keep file-import history intact.
- Modify: `backend/src/chat-import/chat-batch-acceptance.ts`
  Change partial-accept semantics so leftover files keep the batch in review.
- Modify: `backend/src/chat-import/chat-batch-acceptance.spec.ts`
  Add regression tests for partial import and batch state transitions.
- Modify: `backend/src/projects/projects-routes.spec.ts`
  Add route-level coverage for partial import behavior and refreshed batch payloads.
- Modify: `frontend/src/components/ChatReviewPanel.tsx`
  Optional small UX feedback only if needed by implementation outcome; otherwise no logic changes.
- Modify: `frontend/src/components/ProjectView.tsx`
  Optional success alert/message plumbing only if implemented; current refresh path is already sufficient.
- Modify: `docs/superpowers/specs/2026-04-30-review-partial-import-design.md`
  Only if implementation reveals a necessary design adjustment.

### Task 1: Repository Support For Shrinking Active Batch Files

**Files:**
- Modify: `backend/src/chat-import/chat-batches-repository.ts`
- Test: `backend/src/chat-import/chat-batches-repository.spec.ts`

- [ ] **Step 1: Write the failing repository test for removing selected active files**

Add a test in `backend/src/chat-import/chat-batches-repository.spec.ts` that:

```ts
it('removes selected files from the active batch while keeping import history', () => {
  const repository = new ChatBatchesRepository(db);
  const batch = repository.importManifest({
    projectId,
    manifest,
    status: 'PENDING_REVIEW',
    reviewReason: 'Needs review',
  });
  const files = repository.listBatchFiles(projectId, batch.id);

  repository.recordFileImport({
    chatPhotoFileId: files[0].id,
    photoId: 'photo-1',
    checklistNodeId: 'node-1',
  });

  repository.removeBatchFiles(projectId, batch.id, [files[0].id]);

  expect(repository.listBatchFiles(projectId, batch.id).map((file) => file.id)).toEqual([files[1].id]);
  expect(repository.listFileImports(projectId, batch.id)).toHaveLength(0);
});
```

Note:
- this test defines current repository constraint behavior
- because `listFileImports` currently joins through `chat_photo_files`, deleting the file row will also hide old import records from that query
- this is acceptable for now because the feature goal is active-review correctness, not audit reporting

- [ ] **Step 2: Run the repository test to verify it fails**

Run:

```powershell
npm.cmd run test --workspace backend -- src/chat-import/chat-batches-repository.spec.ts
```

Expected:
- fail with `repository.removeBatchFiles is not a function` or equivalent missing-method error

- [ ] **Step 3: Implement repository removal method**

Add this method to `ChatBatchesRepository` in `backend/src/chat-import/chat-batches-repository.ts`:

```ts
  removeBatchFiles(projectId: string, batchId: string, fileIds: string[]): number {
    if (fileIds.length === 0) return 0;

    const placeholders = fileIds.map(() => '?').join(', ');
    const result = this.db
      .prepare(
        `DELETE FROM chat_photo_files
         WHERE batch_id = ?
           AND id IN (${placeholders})
           AND EXISTS (
             SELECT 1
             FROM chat_photo_batches batch
             WHERE batch.id = chat_photo_files.batch_id
               AND batch.project_id = ?
           )`,
      )
      .run(batchId, ...fileIds, projectId);

    return result.changes;
  }
```

Purpose:
- delete only the active file rows for the current batch
- prevent cross-project deletion
- keep implementation minimal without schema changes

- [ ] **Step 4: Run the repository test to verify it passes**

Run:

```powershell
npm.cmd run test --workspace backend -- src/chat-import/chat-batches-repository.spec.ts
```

Expected:
- PASS for the new repository test

- [ ] **Step 5: Commit repository support**

```powershell
git add backend/src/chat-import/chat-batches-repository.ts backend/src/chat-import/chat-batches-repository.spec.ts
git commit -m "feat: support shrinking active chat review files"
```

### Task 2: Partial Import Semantics In acceptChatBatch

**Files:**
- Modify: `backend/src/chat-import/chat-batch-acceptance.ts`
- Test: `backend/src/chat-import/chat-batch-acceptance.spec.ts`

- [ ] **Step 1: Write failing tests for partial import state transitions**

Add tests in `backend/src/chat-import/chat-batch-acceptance.spec.ts` for:

```ts
it('keeps the batch in review with leftover files after partial import', async () => {
  const batch = batches.importManifest({
    projectId,
    manifest: createManifest(join(dir, 'Maleniecka 5 i 7')),
    status: 'PENDING_REVIEW',
    reviewReason: 'Wiadomosc wyglada na wiele adresow',
  });
  const files = batches.listBatchFiles(projectId, batch.id);
  const selectedFile = files.find((file) => file.fileName === 'photo.jpeg');
  if (!selectedFile) throw new Error('selected file missing');

  const result = await acceptChatBatch({
    projectId,
    batchId: batch.id,
    checklistNodeIds: ['node-maleniecka-5'],
    fileIds: [selectedFile.id],
    reserveLocation: 'W studni',
    projectsRepository: projects,
    batchesRepository: batches,
    processPhoto: async () => ({
      buffer: Buffer.from('processed-photo'),
      thumbnail: Buffer.from('thumb'),
      mimeType: 'image/jpeg',
      fileSize: 15,
      lat: null,
      lng: null,
      capturedAt: null,
    }),
  });

  const updatedBatch = batches.getBatch(projectId, batch.id);
  const remainingFiles = batches.listBatchFiles(projectId, batch.id);

  expect(result).toEqual({
    importedPhotos: 1,
    checklistNodeCount: 1,
    sourceFileCount: 1,
  });
  expect(updatedBatch).toMatchObject({
    status: 'PENDING_REVIEW',
    reviewReason: 'Wiadomosc wyglada na wiele adresow',
    checklistNodeId: null,
  });
  expect(remainingFiles.map((file) => file.fileName)).toEqual(['skip.jpeg']);
});
```

And:

```ts
it('marks the batch as imported when the last remaining files are imported', async () => {
  // import one file first, then import the leftover file in a second call
  // final batch should become IMPORTED and listBatchFiles should be empty
});
```

- [ ] **Step 2: Run the acceptance tests to verify they fail**

Run:

```powershell
npm.cmd run test --workspace backend -- src/chat-import/chat-batch-acceptance.spec.ts
```

Expected:
- existing behavior fails because batch becomes `IMPORTED` too early

- [ ] **Step 3: Implement partial batch completion logic**

Update `acceptChatBatch` in `backend/src/chat-import/chat-batch-acceptance.ts` by replacing the unconditional final decision with:

```ts
  const importedFileIds = files.map((file) => file.id);
  input.batchesRepository.removeBatchFiles(input.projectId, input.batchId, importedFileIds);
  const remainingFiles = input.batchesRepository.listBatchFiles(input.projectId, input.batchId);
  const isFullyConsumed = remainingFiles.length === 0;

  input.batchesRepository.updateDecision({
    projectId: input.projectId,
    batchId: input.batchId,
    status: isFullyConsumed ? 'IMPORTED' : 'PENDING_REVIEW',
    reviewReason: isFullyConsumed ? null : batch.reviewReason,
    checklistNodeId:
      isFullyConsumed && input.checklistNodeIds.length === 1 ? input.checklistNodeIds[0] : null,
    reserveLocation: isFullyConsumed ? input.reserveLocation : batch.reserveLocation,
    confidence: batch.confidence,
    llmModel: batch.llmModel,
    llmRawResponse: batch.llmRawResponse,
    visualEvidence: batch.visualEvidence,
  });
```

Important implementation notes:
- keep current multi-node copy semantics unchanged
- compute `files` once, before deletions
- only delete file rows after all photo imports complete successfully
- leave `sourceFileCount` equal to the number of files imported in that action, not the original batch size

- [ ] **Step 4: Run the acceptance tests to verify they pass**

Run:

```powershell
npm.cmd run test --workspace backend -- src/chat-import/chat-batch-acceptance.spec.ts
```

Expected:
- PASS for partial import and full-consumption tests

- [ ] **Step 5: Commit partial-accept behavior**

```powershell
git add backend/src/chat-import/chat-batch-acceptance.ts backend/src/chat-import/chat-batch-acceptance.spec.ts
git commit -m "feat: keep leftover review photos after partial import"
```

### Task 3: Route-Level Regression Coverage

**Files:**
- Modify: `backend/src/projects/projects-routes.spec.ts`

- [ ] **Step 1: Add a failing route test for partial review import**

Add a route test similar to the existing accept route tests:

```ts
it('keeps leftover review photos in the same batch after partial accept', async () => {
  // create batch with two files in PENDING_REVIEW
  // POST /api/projects/:projectId/chat-batches/:batchId/accept with one selected file
  // assert response imported only one file
  // assert GET /api/projects/:projectId/chat-batches?status=PENDING_REVIEW returns same batch with one remaining file
});
```

Assertions:
- accept response returns `sourceFileCount: 1`
- refreshed pending-review batch list contains the same `batch.id`
- that batch has `files.length === 1`
- remaining file is the unchecked one

- [ ] **Step 2: Run the route spec to verify it fails before route-visible fix**

Run:

```powershell
npm.cmd run test --workspace backend -- src/projects/projects-routes.spec.ts
```

Expected:
- fail because current implementation closes the batch

- [ ] **Step 3: Adjust route-adjacent assertions only if required**

If Task 2 implementation is complete, the route code itself may not need changes. If any route-level mismatch appears, keep fixes minimal and local to:

- `backend/src/projects/projects-routes.ts`

Likely no code change is needed here beyond what Task 2 already affects through shared domain logic.

- [ ] **Step 4: Run the route spec to verify it passes**

Run:

```powershell
npm.cmd run test --workspace backend -- src/projects/projects-routes.spec.ts
```

Expected:
- PASS for the new partial-review route coverage

- [ ] **Step 5: Commit route regression coverage**

```powershell
git add backend/src/projects/projects-routes.spec.ts backend/src/projects/projects-routes.ts
git commit -m "test: cover partial review batch accept flow"
```

### Task 4: Frontend Verification And Minimal UX Adjustment

**Files:**
- Modify: `frontend/src/components/ProjectView.tsx`
- Modify: `frontend/src/components/ChatReviewPanel.tsx`

- [ ] **Step 1: Verify whether current refresh flow already satisfies the feature**

Read the current accept handler:

```ts
await api.acceptChatBatch(projectId, batchId, checklistNodeIds, nextReserveLocation, fileIds);
await refreshChecklist(selectedNodeId);
await refreshNodeDetail(selectedNodeId);
await refreshChatBatches();
```

Expected:
- no code change is needed for the core behavior because the refreshed batch list should already show the same batch with fewer files

- [ ] **Step 2: Add optional success message only if lack of feedback is confusing**

If needed, add a minimal alert in `frontend/src/components/ProjectView.tsx`:

```ts
alert(`Zaimportowano ${result.sourceFileCount} zdjec. Pozostale zdjecia zostaly w review.`);
```

Only do this if UX feels unclear during manual verification. Prefer no change if refresh alone is sufficient.

- [ ] **Step 3: Run frontend build to verify no regressions**

Run:

```powershell
npm.cmd run build
```

Expected:
- full workspace build passes

- [ ] **Step 4: Commit frontend adjustment only if one was made**

```powershell
git add frontend/src/components/ProjectView.tsx frontend/src/components/ChatReviewPanel.tsx
git commit -m "feat: clarify partial review import feedback"
```

Skip this commit if no frontend code changed.

### Task 5: Final Verification

**Files:**
- Modify: none required

- [ ] **Step 1: Run focused backend tests**

Run:

```powershell
npm.cmd run test --workspace backend -- src/chat-import/chat-batch-acceptance.spec.ts src/chat-import/chat-batches-repository.spec.ts src/projects/projects-routes.spec.ts
```

Expected:
- PASS for all added partial-import coverage

- [ ] **Step 2: Run full build**

Run:

```powershell
npm.cmd run build
```

Expected:
- frontend and backend build both pass

- [ ] **Step 3: Manually verify review behavior**

Use the app to confirm:

- import a review batch with all files selected by default
- uncheck one file
- import the selected files
- review tab still shows the same batch
- remaining unchecked file is still there
- import the remaining file or reject it

- [ ] **Step 4: Final commit if verification required any last small fix**

```powershell
git add .
git commit -m "feat: support partial review batch imports"
```

Use this only if there are unstaged implementation changes left after previous task commits.
