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

const NOISE_PATTERNS = [
  /\bzapas(?:u|y)?(?: kabla)?\b/g,
  /\bw studni\b/g,
  /\brurka drozna\b/g,
  /\bdo posesji\b/g,
  /\bprzy granicy\b/g,
  /\bgranica\b/g,
  /\bzdj(?:ecia)?\b/g,
  /\bwykop(?:ie)?\b/g,
  /\bdrozna\b/g,
];

const ADDRESS_PATTERN = /\b(?<street>[a-z][a-z0-9 ]{1,}?)\s+(?<building>(?:d\d{3,5})|\d+[a-z]?)\b/gi;
const POINT_PATTERN = /\b(?<prefix>osd|opp|zs)\s*(?<number>\d+[a-z]?)\b/gi;
const DATE_PREFIX_PATTERN = /^\d{4}-\d{2}-\d{2}[ _-]*/;
const DIRECT_MATCH_SCORE = 120;
const PATH_TAIL_MATCH_SCORE = 110;
const BUILDING_MATCH_SCORE = 55;
const EXACT_STREET_MATCH_SCORE = 45;
const FUZZY_STREET_MATCH_SCORE = 30;
const POINT_ID_MATCH_SCORE = 90;
const TOKEN_OVERLAP_SCORE = 4;
const CONFLICT_BUILDING_PENALTY = 50;
const CONFLICT_POINT_PENALTY = 70;
const MIN_WIN_SCORE = 70;
const MIN_SCORE_LEAD = 15;

function unique<T>(values: T[], key: (value: T) => string): T[] {
  const seen = new Set<string>();
  return values.filter((value) => {
    const signature = key(value);
    if (seen.has(signature)) return false;
    seen.add(signature);
    return true;
  });
}

function cleanNoise(value: string): string {
  let current = value;
  for (const pattern of NOISE_PATTERNS) {
    current = current.replace(pattern, ' ');
  }
  return current.replace(/\s+/g, ' ').trim();
}

export function normalizeMatcherText(value: string): string {
  return value
    .normalize('NFKD')
    .replace(/[\u0300-\u036f]/g, '')
    .replace(DATE_PREFIX_PATTERN, '')
    .replace(/[_-]+/g, ' ')
    .replace(/\bul\.?\s+/gi, '')
    .replace(/\bd\s+(\d{3,5})\b/gi, 'd$1')
    .replace(/\b(\d+)\s+([a-z])\b/gi, '$1$2')
    .replace(/[^a-z0-9]+/gi, ' ')
    .replace(/\s+/g, ' ')
    .trim()
    .toLowerCase();
}

function extractAddresses(value: string): ExtractedAddressFeature[] {
  const matches = Array.from(value.matchAll(ADDRESS_PATTERN))
    .map((match) => match.groups)
    .filter((groups): groups is { street: string; building: string } => Boolean(groups))
    .map((groups) => ({
      street: groups.street.trim(),
      building: groups.building.replace(/\s+/g, '').trim(),
    }))
    .filter((address) => address.street.length >= 3);

  return unique(matches, (address) => `${address.street}|${address.building}`);
}

function extractPointIds(value: string): string[] {
  const matches = Array.from(value.matchAll(POINT_PATTERN))
    .map((match) => match.groups)
    .filter((groups): groups is { prefix: string; number: string } => Boolean(groups))
    .map((groups) => `${groups.prefix}${groups.number}`.toLowerCase());

  return [...new Set(matches)];
}

function removeRecognizedFeatures(source: string, addresses: ExtractedAddressFeature[], pointIds: string[]): string {
  let residual = source;
  for (const address of addresses) {
    residual = residual.replace(new RegExp(`\\b${escapeRegExp(address.street)}\\s+${escapeRegExp(address.building)}\\b`, 'g'), ' ');
  }
  for (const pointId of pointIds) {
    const [prefix, number] = pointId.match(/^(osd|opp|zs)(.+)$/)?.slice(1) ?? [];
    if (prefix && number) {
      residual = residual.replace(new RegExp(`\\b${escapeRegExp(prefix)}\\s*${escapeRegExp(number)}\\b`, 'g'), ' ');
    }
  }
  return residual.replace(/\s+/g, ' ').trim();
}

function escapeRegExp(value: string): string {
  return value.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

function levenshtein(left: string, right: string): number {
  const previous = Array.from({ length: right.length + 1 }, (_, index) => index);
  const current = Array.from({ length: right.length + 1 }, () => 0);

  for (let leftIndex = 1; leftIndex <= left.length; leftIndex += 1) {
    current[0] = leftIndex;
    for (let rightIndex = 1; rightIndex <= right.length; rightIndex += 1) {
      const cost = left[leftIndex - 1] === right[rightIndex - 1] ? 0 : 1;
      current[rightIndex] = Math.min(
        previous[rightIndex] + 1,
        current[rightIndex - 1] + 1,
        previous[rightIndex - 1] + cost,
      );
    }
    previous.splice(0, previous.length, ...current);
  }

  return previous[right.length];
}

function isLikelyStreetTypo(left: string, right: string): boolean {
  if (left === '' || right === '') return false;
  if (left === right) return true;
  const distance = levenshtein(left, right);
  const maxLength = Math.max(left.length, right.length);
  return distance <= 2 || distance / maxLength <= 0.18;
}

function splitStreetAndBuilding(value: string): ExtractedAddressFeature | null {
  return extractAddresses(normalizeMatcherText(value))[0] ?? null;
}

function pathTail(path: string): string {
  return path.split('/').at(-1) ?? path;
}

function candidatePointIds(candidate: ChecklistMatcherCandidate): string[] {
  const source = `${normalizeMatcherText(candidate.name)} ${normalizeMatcherText(candidate.path)}`;
  return extractPointIds(source);
}

export function extractMatcherFeatures(value: string): MatcherFeatures {
  const normalizedSource = normalizeMatcherText(value);
  const noiseCleaned = cleanNoise(normalizedSource);
  const addresses = extractAddresses(noiseCleaned);
  const pointIds = extractPointIds(noiseCleaned);
  const residual = removeRecognizedFeatures(noiseCleaned, addresses, pointIds);
  const residualTokens = residual.split(' ').filter((token) => token.length >= 3);

  return {
    normalizedSource,
    addresses,
    pointIds,
    residualTokens,
  };
}

export function scoreChecklistCandidate(
  source: MatcherFeatures,
  candidate: ChecklistMatcherCandidate,
): RankedChecklistCandidate {
  let score = 0;
  const reasons: string[] = [];
  const normalizedName = normalizeMatcherText(candidate.name);
  const normalizedTail = normalizeMatcherText(pathTail(candidate.path));
  const candidateAddress = splitStreetAndBuilding(candidate.name) ?? splitStreetAndBuilding(pathTail(candidate.path));
  const candidatePoints = candidatePointIds(candidate);

  if (normalizedName && source.normalizedSource.includes(normalizedName)) {
    score += DIRECT_MATCH_SCORE;
    reasons.push('exact-name');
  }
  if (normalizedTail && source.normalizedSource.includes(normalizedTail)) {
    score += PATH_TAIL_MATCH_SCORE;
    reasons.push('path-tail');
  }

  if (candidatePoints.length > 0) {
    const hasPointConflict = source.pointIds.length > 0 && !candidatePoints.some((pointId) => source.pointIds.includes(pointId));
    if (hasPointConflict) {
      score -= CONFLICT_POINT_PENALTY;
      reasons.push('point-conflict');
    } else if (candidatePoints.some((pointId) => source.pointIds.includes(pointId))) {
      score += POINT_ID_MATCH_SCORE;
      reasons.push('point-id');
    }
  }

  if (candidateAddress) {
    const buildingMatches = source.addresses.filter((address) => address.building === candidateAddress.building);
    const conflictingBuilding = source.addresses.length > 0 && buildingMatches.length === 0;
    if (conflictingBuilding) {
      score -= CONFLICT_BUILDING_PENALTY;
      reasons.push('building-conflict');
    }

    for (const address of buildingMatches) {
      score += BUILDING_MATCH_SCORE;
      reasons.push('building');
      if (address.street === candidateAddress.street) {
        score += EXACT_STREET_MATCH_SCORE;
        reasons.push('street-exact');
      } else if (isLikelyStreetTypo(address.street, candidateAddress.street)) {
        score += FUZZY_STREET_MATCH_SCORE;
        reasons.push('street-fuzzy');
      }
    }
  }

  const candidateTokens = new Set(
    normalizeMatcherText(`${candidate.name} ${pathTail(candidate.path)}`)
      .split(' ')
      .filter((token) => token.length >= 3),
  );
  const overlap = source.residualTokens.filter((token) => candidateTokens.has(token)).length;
  if (overlap > 0) {
    score += overlap * TOKEN_OVERLAP_SCORE;
    reasons.push(`token-overlap:${overlap}`);
  }

  return { candidate, score, reasons };
}

function normalizeCandidates(rows: unknown[], predicate: (candidate: ChecklistMatcherCandidate) => boolean): ChecklistMatcherCandidate[] {
  return rows.filter((row): row is ChecklistMatcherCandidate => {
    if (row === null || typeof row !== 'object') return false;
    const candidate = row as Partial<ChecklistMatcherCandidate>;
    return (
      typeof candidate.id === 'string' &&
      typeof candidate.name === 'string' &&
      typeof candidate.path === 'string' &&
      predicate(candidate as ChecklistMatcherCandidate)
    );
  });
}

export function findBestChecklistCandidate(sourceText: string, rows: unknown[]): ChecklistMatchResult | null {
  const features = extractMatcherFeatures(sourceText);
  const candidates = normalizeCandidates(
    rows,
    (candidate) => candidate.nodeType === 'CABLE_RESERVE' && Boolean(candidate.acceptsPhotos),
  );

  const ranked = candidates
    .map((candidate) => scoreChecklistCandidate(features, candidate))
    .filter((result) => result.score > 0)
    .sort((left, right) => right.score - left.score || left.candidate.name.localeCompare(right.candidate.name));

  const best = ranked[0];
  const second = ranked[1];
  if (!best) return null;
  if (best.score < MIN_WIN_SCORE) return null;
  if (second && best.score - second.score < MIN_SCORE_LEAD) return null;

  return {
    candidate: best.candidate,
    topCandidates: ranked.slice(0, 5),
  };
}

export function findBestDistributionDetailCandidate(sourceText: string, rows: unknown[]): ChecklistMatcherCandidate | null {
  const features = extractMatcherFeatures(sourceText);
  if (features.pointIds.length === 0) return null;

  const candidates = normalizeCandidates(rows, (candidate) => Boolean(candidate.acceptsPhotos));
  const matches = candidates.filter((candidate) => {
    const normalizedPath = normalizeMatcherText(candidate.path).replace(/\s+/g, '');
    return (
      normalizedPath.includes('szczegolyskrzynki') &&
      features.pointIds.some((pointId) => normalizedPath.includes(pointId))
    );
  });

  return matches.length === 1 ? matches[0] : null;
}
