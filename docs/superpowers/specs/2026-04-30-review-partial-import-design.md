# Review Partial Import Design

## Goal

Allow a review batch from Google Chat to be partially imported while keeping the remaining, unchecked photos in the same batch for later review or rejection.

## Current Behavior

- A review batch starts with all photos selected for import.
- The user can uncheck photos before clicking import.
- Import can target one or more checklist nodes.
- The checked photos are imported to every selected checklist node.
- After import, the whole batch is marked as `IMPORTED`, even if some photos were unchecked and should remain available for later decisions.

This makes it impossible to process one subset of the batch now and come back to the rest later.

## Desired Behavior

- Review UI keeps the current default selection model: all photos are checked initially.
- The user unchecks photos that should stay in review.
- Import processes only the still-checked photos.
- The same checked photo may still be imported to multiple checklist nodes in one action, exactly as today.
- After import:
  - Imported photos disappear from the current review batch.
  - Unchecked photos stay in the same batch.
  - If at least one photo remains, the batch stays in `PENDING_REVIEW`.
  - If no photos remain, the batch becomes `IMPORTED`.
- The user may later import the remaining photos to another checklist node or reject the remaining batch.

## Non-Goals

- No new batch should be created from leftovers.
- No new batch status is needed.
- No change to the current meaning of multi-node import.
- No LLM changes or checklist matching changes are included in this feature.

## Data Model Decision

The batch remains the same logical entity throughout its lifetime. We do not split or clone it.

The system should treat chat-photo files as the active contents of the batch. Once selected files are imported, they should no longer belong to the active review set for that batch.

This means the batch record stays in place, while the set of still-reviewable files attached to it shrinks over time.

## Backend Design

### 1. Partial acceptance semantics

`acceptChatBatch` should stop assuming that a successful import always finishes the entire batch.

Instead it should:

- resolve the selected files for this action
- import those selected files to the chosen checklist nodes
- record file-to-photo imports as today
- remove the imported files from the active file set of the batch
- decide final batch state based on whether any active files remain

### 2. Batch state transition rules

After importing selected files:

- if unimported files remain in the batch:
  - keep batch status as `PENDING_REVIEW`
  - keep existing review context, unless we intentionally want to replace it with a more specific reason such as `Pozostaly niezaimportowane pliki`
- if no files remain:
  - mark batch as `IMPORTED`
  - clear `reviewReason`

`checklistNodeId` should only be set when the batch is fully consumed and exactly one checklist node was used for the final import action. If the batch remains in review, it should not pretend to be fully resolved to one node.

### 3. Repository support

The batch repository needs an explicit operation for removing already imported file records from the active batch file list.

Recommended shape:

- add a repository method that deletes or detaches selected `chat_photo_files` rows by `fileIds`
- keep `recordFileImport` unchanged for photo traceability

The important invariant is:

- already imported files must not appear again in review
- remaining files must still be queryable through `listBatchFiles`

### 4. Reject behavior

Reject should continue to work on whatever files remain in the batch at that moment.

If a user imports part of a batch and later rejects it, only the leftover files are being rejected conceptually. Already imported photos stay imported.

## Frontend Design

### 1. Review interaction

The review panel keeps its current interaction model:

- all files selected by default
- user can uncheck files
- user can still select one or multiple checklist nodes
- import button still reports how many selected photos go to how many nodes

No new controls are required for the first version.

### 2. After import

After a successful partial import, the next refresh should show:

- the same review batch
- with fewer photos
- with the unchecked leftovers still available

If the batch was fully consumed, it should disappear from review as today.

### 3. Optional user feedback

Useful but not mandatory for the first implementation:

- success message such as `Zaimportowano 3 zdjecia, pozostalo 2 w review`

This is a UX improvement, not a dependency for the feature.

## Error Handling

- Import with zero selected files should remain blocked by the frontend.
- Import with zero selected checklist nodes should remain blocked by the frontend.
- Backend must still validate both conditions.
- If repository cleanup fails after photos were imported, the operation must not silently leave the batch in an inconsistent state.

Because the import path touches filesystem writes and database updates, this flow should be treated as one logical unit. If there is no transaction layer today, implementation should at minimum update repository state in a deterministic order and add tests for partial-failure boundaries.

## Testing Strategy

Required backend tests:

- partial import to one checklist node keeps batch in `PENDING_REVIEW` with only leftover files
- partial import to multiple checklist nodes still duplicates selected files correctly
- full import of all remaining files marks batch as `IMPORTED`
- reject after partial import rejects only the remaining batch state
- already imported files do not reappear in `listBatchFiles`

Required frontend verification:

- review batch re-renders with remaining files after partial import
- import button count matches selected file count after changes
- fully consumed batch disappears from review after refresh

## Recommended Scope

Implement this feature without changing batch schema unless repository constraints force it. Prefer a minimal repository extension over introducing new statuses, new tables, or new UI branches.

## Acceptance Criteria

- User can partially import a review batch.
- Imported photos disappear from that batch immediately after refresh.
- Remaining photos stay in the same batch in `PENDING_REVIEW`.
- Remaining photos can later be imported to another checklist node or rejected.
- Multi-node import for selected photos continues to work exactly as before.
