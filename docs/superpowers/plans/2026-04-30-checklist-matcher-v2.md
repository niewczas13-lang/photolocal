# Checklist Matcher V2 Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Replace the current narrow checklist matcher with a deterministic, score-based matcher that handles noisy Google Chat address descriptions more reliably without using an LLM in the primary matching path.

**Architecture:** Extract matching logic out of `chat-classification-runner.ts` into a dedicated `checklist-matcher.ts` module with three stages: normalization, feature extraction, and candidate scoring. Keep the classification runner as the orchestrator, preserve review fallbacks for ambiguous cases, and lightly strengthen the importer’s “looks like a target” heuristic so good candidates are not blocked before classification starts.

**Tech Stack:** TypeScript, Fastify backend modules, better-sqlite3-backed repositories, Vitest

---

## File Map

- Create: `backend/src/chat-import/checklist-matcher.ts`
  New deterministic matcher module for normalization, feature extraction, scoring, and best-candidate selection.
- Create: `backend/src/chat-import/checklist-matcher.spec.ts`
  Focused matcher tests independent from the full classification runner.
- Modify: `backend/src/chat-import/chat-classification-runner.ts`
  Replace embedded matching helpers with the new matcher module and pass richer debug info.
- Modify: `backend/src/chat-import/chat-classification-runner.spec.ts`
  Keep regression coverage at orchestration level and align with new matcher output.
- Modify: `backend/src/chat-import/chat-importer.ts`
  Strengthen the initial “looks like a checklist target” gate using the same normalization ideas.
- Modify: `backend/src/chat-import/chat-importer.spec.ts`
  Add regression tests for noisy-but-valid folder names that should still reach classification.
- Modify: `docs/superpowers/specs/2026-04-30-checklist-matcher-v2-design.md`
  Only if implementation forces a design adjustment.

### Task 1: Extract A Dedicated Matcher Module

**Files:**
- Create: `backend/src/chat-import/checklist-matcher.ts`
- Test: `backend/src/chat-import/checklist-matcher.spec.ts`

- [ ] **Step 1: Write failing tests for normalization and feature extraction**

Create `backend/src/chat-import/checklist-matcher.spec.ts` with focused tests such as:

```ts
import { describe, expect, it } from 'vitest';
import {
  normalizeMatcherText,
  extractMatcherFeatures,
} from './checklist-matcher.js';

describe('normalizeMatcherText', () => {
  it('normalizes ul prefixes, separators, dates and spaced building suffixes', () => {
    expect(normalizeMatcherText('2025-10-20_Ul. Maleniecka 28 B')).toBe('maleniecka 28b');
  });

  it('normalizes spaced D identifiers', () => {
    expect(normalizeMatcherText('Maleniecka D 2278')).toContain('maleniecka d2278');
  });
});

describe('extractMatcherFeatures', () => {
  it('extracts address and point-id clues from noisy text', () => {
    const features = extractMatcherFeatures('Ul. Maleniecka 30A zapas w studni rurka drozna OSD 2766');

    expect(features.addresses).toEqual(
      expect.arrayContaining([
        expect.objectContaining({ street: 'maleniecka', building: '30a' }),
      ]),
    );
    expect(features.pointIds).toContain('osd2766');
  });
});
```

- [ ] **Step 2: Run matcher tests to verify they fail**

Run:

```powershell
npm.cmd run test --workspace backend -- src/chat-import/checklist-matcher.spec.ts
```

Expected:
- fail because the new matcher module does not exist yet

- [ ] **Step 3: Implement matcher normalization and extraction**

Create `backend/src/chat-import/checklist-matcher.ts` with these exports:

```ts
export interface ExtractedAddressFeature {
  street: string;
  building: string;
}

export interface MatcherFeatures {
  normalizedSource: string;
  addresses: ExtractedAddressFeature[];
  pointIds: string[];
  residualTokens: string[];
}

export function normalizeMatcherText(value: string): string {
  return value
    .normalize('NFKD')
    .replace(/[\u0300-\u036f]/g, '')
    .replace(/^\d{4}-\d{2}-\d{2}[ _-]*/g, '')
    .replace(/[_-]+/g, ' ')
    .replace(/\bul\.?\s+/gi, '')
    .replace(/\bd\s+(\d{3,5})\b/gi, 'd$1')
    .replace(/\b(\d+)\s+([a-z])\b/gi, '$1$2')
    .replace(/[^a-z0-9]+/gi, ' ')
    .replace(/\s+/g, ' ')
    .trim()
    .toLowerCase();
}
```

Also implement:

- cleanup of known noise phrases before address extraction
- extraction of repeated address-like patterns from source text
- extraction of normalized point IDs like `osd2766`, `opp13`, `zs12`
- residual token list after removing recognized features

Keep the module self-contained and free of repository concerns.

- [ ] **Step 4: Run matcher tests to verify they pass**

Run:

```powershell
npm.cmd run test --workspace backend -- src/chat-import/checklist-matcher.spec.ts
```

Expected:
- PASS for normalization and extraction tests

- [ ] **Step 5: Commit matcher module skeleton**

```powershell
git add backend/src/chat-import/checklist-matcher.ts backend/src/chat-import/checklist-matcher.spec.ts
git commit -m "feat: extract checklist matcher module"
```

### Task 2: Implement Candidate Scoring And Safe Winner Selection

**Files:**
- Modify: `backend/src/chat-import/checklist-matcher.ts`
- Test: `backend/src/chat-import/checklist-matcher.spec.ts`

- [ ] **Step 1: Write failing tests for scoring behavior**

Add tests such as:

```ts
it('selects the exact candidate over a fuzzy candidate', () => {
  const result = findBestChecklistCandidate(source, candidates);
  expect(result?.candidate.id).toBe('node-ul_malenicka_30a');
});

it('keeps ambiguous same-number candidates unresolved', () => {
  const result = findBestChecklistCandidate(source, candidates);
  expect(result).toBeNull();
});

it('matches point identifiers with flexible spacing', () => {
  const result = findBestDistributionDetailCandidate(source, candidates);
  expect(result?.id).toBe('node-osd2766-details');
});
```

Define candidates inline in the test file as plain objects with `id`, `name`, `path`, `nodeType`, `acceptsPhotos`.

- [ ] **Step 2: Run matcher tests to verify they fail**

Run:

```powershell
npm.cmd run test --workspace backend -- src/chat-import/checklist-matcher.spec.ts
```

Expected:
- fail because scoring and winner selection are not implemented yet

- [ ] **Step 3: Implement score-based reserve and distribution matching**

Add these exports in `checklist-matcher.ts`:

```ts
export interface ChecklistMatcherCandidate {
  id: string;
  name: string;
  path: string;
  nodeType: string;
  acceptsPhotos: number | boolean;
}

export interface RankedChecklistCandidate {
  candidate: ChecklistMatcherCandidate;
  score: number;
  reasons: string[];
}

export interface ChecklistMatchResult {
  candidate: ChecklistMatcherCandidate;
  topCandidates: RankedChecklistCandidate[];
}
```

Implement:

- `scoreChecklistCandidate(source: MatcherFeatures, candidate: ChecklistMatcherCandidate): RankedChecklistCandidate`
- `findBestChecklistCandidate(sourceText: string, rows: unknown[]): ChecklistMatchResult | null`
- `findBestDistributionDetailCandidate(sourceText: string, rows: unknown[]): ChecklistMatcherCandidate | null`

Required rules:

- strong positive score for exact normalized full name or path-tail match
- strong positive score for exact building match
- medium positive score for fuzzy street match when building matches
- strong positive score for normalized point-id match
- negative score for conflicting building numbers
- ambiguous result if top candidate is below threshold or too close to #2

Use explicit thresholds in constants so tuning is easy.

- [ ] **Step 4: Run matcher tests to verify they pass**

Run:

```powershell
npm.cmd run test --workspace backend -- src/chat-import/checklist-matcher.spec.ts
```

Expected:
- PASS for exact, fuzzy, point-id, and ambiguity cases

- [ ] **Step 5: Commit scoring logic**

```powershell
git add backend/src/chat-import/checklist-matcher.ts backend/src/chat-import/checklist-matcher.spec.ts
git commit -m "feat: add score-based checklist candidate matching"
```

### Task 3: Replace Embedded Runner Matching With Matcher V2

**Files:**
- Modify: `backend/src/chat-import/chat-classification-runner.ts`
- Test: `backend/src/chat-import/chat-classification-runner.spec.ts`

- [ ] **Step 1: Write failing runner-level regression tests for new noise cases**

Add tests in `backend/src/chat-import/chat-classification-runner.spec.ts` for:

```ts
it('matches noisy suffix descriptions that still contain a valid address', async () => {
  // e.g. "Maleniecka 30A zapas w studni rurka drozna do posesji"
});

it('matches spaced point-id forms like OSD 2766', async () => {
  // should resolve to Szczegoly_skrzynki node without invoking vision branch
});
```

Keep them at orchestration level, using the same harness as existing tests.

- [ ] **Step 2: Run runner tests to verify they fail**

Run:

```powershell
npm.cmd run test --workspace backend -- src/chat-import/chat-classification-runner.spec.ts
```

Expected:
- fail because the current embedded matcher does not support all new cases

- [ ] **Step 3: Refactor runner to use the new matcher**

In `backend/src/chat-import/chat-classification-runner.ts`:

- remove or inline-delete:
  - `normalizeMatchText`
  - `splitStreetAndBuilding`
  - `levenshtein`
  - `isLikelyStreetTypo`
  - `findChecklistCandidate`
  - `findDistributionDetailCandidate`
- import from `./checklist-matcher.js`

Replace candidate selection calls with:

```ts
const distributionCandidate = findBestDistributionDetailCandidate(
  `${batch.messageText} ${batch.folderName}`,
  checklistRows,
);
```

and

```ts
const match = findBestChecklistCandidate(
  `${batch.messageText} ${batch.folderName}`,
  checklistRows,
);
const candidate = match?.candidate ?? null;
```

Optionally enrich debug payload with top candidate reasons if the type shape is extended safely.

- [ ] **Step 4: Run runner tests to verify they pass**

Run:

```powershell
npm.cmd run test --workspace backend -- src/chat-import/chat-classification-runner.spec.ts
```

Expected:
- PASS for existing typo tests and new noisy-input tests

- [ ] **Step 5: Commit runner integration**

```powershell
git add backend/src/chat-import/chat-classification-runner.ts backend/src/chat-import/chat-classification-runner.spec.ts
git commit -m "feat: integrate checklist matcher v2 into classification runner"
```

### Task 4: Strengthen Import-Time Eligibility Heuristics

**Files:**
- Modify: `backend/src/chat-import/chat-importer.ts`
- Test: `backend/src/chat-import/chat-importer.spec.ts`

- [ ] **Step 1: Write failing importer regression tests for noisy valid targets**

Add importer tests for folders like:

```ts
it('routes noisy address folders with construction-note suffixes to classification', async () => {
  writeManifest(dir, '2025-10-20_Ul. Maleniecka 30A zapas w studni rurka drozna', 'Ul. Maleniecka 30A zapas w studni rurka drozna');
  // expect WAITING_FOR_CLASSIFICATION
});

it('routes spaced point-id folder names to classification', async () => {
  writeManifest(dir, 'OSD 2766', 'OSD 2766');
  // expect WAITING_FOR_CLASSIFICATION
});
```

- [ ] **Step 2: Run importer tests to verify they fail**

Run:

```powershell
npm.cmd run test --workspace backend -- src/chat-import/chat-importer.spec.ts
```

Expected:
- fail for one or more noisy valid target cases

- [ ] **Step 3: Reuse matcher-style normalization in importer gate**

Update `chat-importer.ts` to:

- import `normalizeMatcherText` or a narrowly shared helper from `checklist-matcher.ts`
- run address/point-target eligibility against normalized text rather than raw text only
- preserve current multi-address rejection behavior

Keep the importer simple:
- it only decides `WAITING_FOR_CLASSIFICATION` vs early `PENDING_REVIEW`
- it should not perform full candidate scoring

- [ ] **Step 4: Run importer tests to verify they pass**

Run:

```powershell
npm.cmd run test --workspace backend -- src/chat-import/chat-importer.spec.ts
```

Expected:
- PASS for old and new importer heuristics

- [ ] **Step 5: Commit importer heuristic upgrade**

```powershell
git add backend/src/chat-import/chat-importer.ts backend/src/chat-import/chat-importer.spec.ts
git commit -m "feat: improve chat import target heuristics"
```

### Task 5: Final Verification

**Files:**
- Modify: none required

- [ ] **Step 1: Run focused matcher and importer/classifier tests**

Run:

```powershell
npm.cmd run test --workspace backend -- src/chat-import/checklist-matcher.spec.ts src/chat-import/chat-classification-runner.spec.ts src/chat-import/chat-importer.spec.ts
```

Expected:
- PASS for the new matcher suite and existing orchestration coverage

- [ ] **Step 2: Run full backend regression slice covering recent related work**

Run:

```powershell
npm.cmd run test --workspace backend -- src/chat-import/chat-batch-acceptance.spec.ts src/chat-import/chat-batches-repository.spec.ts src/chat-import/chat-classification-runner.spec.ts src/chat-import/chat-importer.spec.ts src/projects/projects-routes.spec.ts
```

Expected:
- PASS for all closely related chat-import features

- [ ] **Step 3: Run full build**

Run:

```powershell
npm.cmd run build
```

Expected:
- frontend and backend build both pass

- [ ] **Step 4: Manual verification checklist**

Verify in the app with a representative project:

- noisy but valid single-address folders move to `WAITING_FOR_CLASSIFICATION`
- classifier resolves more typo/noise cases to `READY_FOR_IMPORT`
- ambiguous same-number competing candidates still remain in review
- OSD-like detail folders still jump directly to `READY_FOR_IMPORT`

- [ ] **Step 5: Final commit if any last verification fixes were needed**

```powershell
git add .
git commit -m "feat: upgrade checklist matcher for noisy chat targets"
```

Use this only if any small follow-up fix remained after prior task commits.
