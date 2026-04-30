# Checklist Matcher V2 Design

## Goal

Improve matching between Google Chat folder/message descriptions and checklist targets without introducing an LLM into the primary matching path.

The matcher should handle:

- street name typos
- noisy suffixes and prefixes
- address number variants such as `28B`, `28 B`, `D2278`, `D 2278`
- `ul.` / `UL_` / underscore / hyphen variants
- OSD / OPP / ZS style point identifiers
- mixed chat descriptions that contain useful target data plus irrelevant commentary

## Current Behavior

Current matching in `chat-classification-runner.ts` is deterministic and relatively narrow:

- it normalizes text
- it matches direct `name` / `path tail` inclusion
- it falls back to `street + building` matching
- it allows street typos with a basic Levenshtein threshold
- it requires exactly one candidate to match

This already works for some typo cases, but it breaks down when:

- the chat description contains too much extra text
- multiple textual variants of the same address appear
- point identifiers and addresses appear in unusual formats
- normalization is not strong enough to isolate the useful signal
- one candidate is clearly better than the others, but the code still treats the result as ambiguous

## Desired Behavior

The matcher should remain rule-based and deterministic, but become more tolerant and more explicit about why it selected a target.

Target outcomes:

- clearly valid single-target descriptions should auto-match more often
- noisy but still recognizable descriptions should auto-match when evidence is strong
- truly ambiguous descriptions should still fall back to review
- matching decisions should be debuggable via scoring and intermediate extracted features

## Non-Goals

- No LLM in the primary matching path
- No replacement of the vision classifier
- No auto-resolution of clearly multi-address messages
- No attempt to force a match when top candidates are too close
- No user-configured alias editor in this phase

## Recommended Architecture

Split the current matching logic into three explicit stages:

1. normalization and token cleanup
2. target feature extraction
3. candidate scoring and winner selection

This should likely become a dedicated matcher module rather than continuing to grow inside `chat-classification-runner.ts`.

## Stage 1: Normalization And Cleanup

### Input sources

Use both:

- `batch.messageText`
- `batch.folderName`

Treat them as separate signals and as one combined signal.

### Required cleanup

Normalization should aggressively reduce formatting noise:

- lowercase
- remove Polish diacritics
- replace `_` and `-` with spaces
- collapse repeated whitespace
- normalize `ul.` / `ul` prefixes
- normalize punctuation around address numbers
- normalize `D 2278` into `D2278`
- normalize `28 B` into `28B`
- strip leading date prefixes like `2025-10-20_`

### Noise phrases

The matcher should ignore common descriptive suffixes when extracting candidate targets, for example:

- `zapas w studni`
- `zapas kabla`
- `rurka drozna`
- `do posesji`
- `granica`
- `przy granicy`
- `zdj`
- `zdjecia`
- `wykop`
- other repeated construction-note fragments that do not identify the checklist point

This should be done in a focused cleanup layer, not by weakening all later matching rules.

## Stage 2: Feature Extraction

Instead of trying one direct regex and stopping there, extract a structured set of possible clues from the normalized input.

### Address features

Extract zero or more candidate address features:

- street tokens
- building identifier
- optional `Dxxxx` style parcel/building form

Examples:

- `Maleniecka 28B`
- `ul malenicka 28b`
- `Maleniecka D2278`

### Point identifier features

Extract point-style identifiers:

- `OSD2766`
- `OPP13`
- `ZS...`

Allow flexible formatting:

- `OSD 2766`
- `osd2766`
- `opp 13`

### Residual text

Keep the cleaned residual text as a bag of tokens for weaker fallback signals.

This allows later scoring to reward partial evidence without pretending it is a full address match.

## Stage 3: Candidate Scoring

Move from binary filtering to scoring every relevant candidate.

### Candidate pool

For reserve matching, candidates are still checklist nodes with:

- `nodeType === 'CABLE_RESERVE'`
- `acceptsPhotos === true`

For distribution detail matching, keep the existing fast path, but let it use normalized point-id extraction instead of one narrow regex match.

### Scoring signals

Each candidate should receive points from independent signals.

Strong signals:

- exact normalized full name contained in source
- exact normalized path tail contained in source
- exact building identifier match
- exact point identifier match

Medium signals:

- street similarity after normalization
- address extracted from source aligns with candidate address
- OSD / OPP token alignment with candidate path

Weak signals:

- overlap in non-noise tokens
- partial prefix match for street tokens

Negative signals:

- conflicting building number
- conflicting point identifier
- low street similarity with same building

### Winner rule

Do not auto-match just because one candidate has the highest score.

Auto-match only if:

- top candidate score is above a confidence threshold
- and top candidate has a minimum lead over candidate #2

Otherwise:

- send to `PENDING_REVIEW`
- reason remains `Nie znaleziono jednoznacznego punktu checklisty`

This preserves safety while improving recall.

## Debuggability

The matcher should expose enough structured data to understand why a candidate won or why review was chosen.

Recommended internal debug output per classification:

- normalized source text
- extracted address features
- extracted point-id features
- top candidate list with scores
- reason for auto-match or reason for ambiguity

This does not need to be user-visible in the main UI immediately, but it should be available in logs or debug event structures for future troubleshooting.

## Suggested Refactor Boundary

Introduce a dedicated matcher module, for example:

- `backend/src/chat-import/checklist-matcher.ts`

Potential responsibilities:

- `normalizeMatcherText`
- `extractMatcherFeatures`
- `scoreChecklistCandidate`
- `findBestChecklistCandidate`
- `findBestDistributionDetailCandidate`

Then `chat-classification-runner.ts` becomes an orchestrator rather than the home for every matching rule.

## Testing Strategy

The new matcher needs explicit regression coverage for the failure classes you described.

Required test categories:

- street typo with same building number
- `ul.` / `_` / mixed case variants
- `D2278` and spaced `D 2278`
- suffix noise like `zapas w studni rurka drozna do posesji`
- point-id forms like `OSD 2766`
- exact candidate wins over fuzzy candidate
- ambiguous two-candidate case still goes to review
- aggressive cleanup does not erase meaningful address tokens

Existing runner tests should stay, but more of the matching surface should move into focused matcher tests once the logic is extracted.

## Rollout Strategy

Phase 1:

- improve deterministic matcher only
- keep existing review fallbacks
- add extensive regression tests

Phase 2, only if needed later:

- add optional alias dictionary for repeated local naming patterns

Phase 3, only if deterministic matching still leaves too many good cases in review:

- add LLM fallback only for low-confidence or ambiguous matches

## Acceptance Criteria

- More noisy Google Chat descriptions auto-match correctly without using an LLM
- Existing typo-match coverage continues to pass
- Ambiguous same-number cases still stay in review
- Matching remains deterministic and testable
- Debug output is strong enough to explain non-trivial decisions
