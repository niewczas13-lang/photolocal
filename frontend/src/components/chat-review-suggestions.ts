import type { ChecklistNode } from '../types';

export interface CandidateNode {
  id: string;
  name: string;
  path: string;
  nodeType: ChecklistNode['nodeType'];
}

export interface SuggestionBatch {
  messageText: string;
  folderName: string;
}

export interface SuggestedCandidate {
  candidate: CandidateNode;
  score: number;
}

export function normalize(value: string): string {
  return value
    .normalize('NFKD')
    .replace(/[\u0300-\u036f]/g, '')
    .replace(/[_-]+/g, ' ')
    .replace(/[^a-z0-9]+/gi, ' ')
    .replace(/\s+/g, ' ')
    .trim()
    .toLowerCase();
}

export function collectAcceptingNodes(nodes: ChecklistNode[]): CandidateNode[] {
  return nodes.flatMap((node) => {
    const self =
      node.acceptsPhotos
        ? [{ id: node.id, name: node.name, path: node.path, nodeType: node.nodeType }]
        : [];
    return [...self, ...collectAcceptingNodes(node.children)];
  });
}

function hasAddressLikeSignal(source: string): boolean {
  const sourceWithoutDates = source.replace(/\b20\d{2}\s+\d{1,2}\s+\d{1,2}\b/g, ' ');
  return (
    /\b(osd|opp|zs)\s*\d+[a-z]?\b/i.test(sourceWithoutDates) ||
    /\b[a-z]{3,}\s+\d+[a-z]?\b/i.test(sourceWithoutDates) ||
    /\b\d+[a-z]?\s+[a-z]{3,}\b/i.test(sourceWithoutDates)
  );
}

function isGenericWorkCandidate(candidate: CandidateNode): boolean {
  const path = normalize(candidate.path);
  return (
    path.includes('wykopy przeciski') ||
    path.includes('notatki z budowy') ||
    path.includes('podwieszenie kabli') ||
    path.includes('podwieszenie kabla pge')
  );
}

function scoreGenericWorkCandidate(source: string, candidate: CandidateNode): number {
  const path = normalize(candidate.path);
  if (path.includes('wykopy przeciski') && /\b(wykop|wykopy|przecisk|przejsc|przejazd|rura)\b/.test(source)) {
    return 95;
  }
  if (path.includes('notatki z budowy') && /\b(notatk|uwag|brak|nie ma|problem|map)\b/.test(source)) {
    return 90;
  }
  if (path.includes('podwieszenie kabla pge') && /\b(pge|slup|podwiesz)\b/.test(source)) {
    return 90;
  }
  if (path.includes('podwieszenie kabli') && /\b(slup|podwiesz|napowietrz)\b/.test(source)) {
    return 85;
  }
  return isGenericWorkCandidate(candidate) ? 25 : 0;
}

export function scoreCandidate(batch: SuggestionBatch, candidate: CandidateNode): number {
  const source = normalize(`${batch.messageText} ${batch.folderName}`);
  const name = normalize(candidate.name);
  const parts = name.split(' ').filter(Boolean);
  const number = parts.at(-1) ?? '';
  const street = parts.slice(0, -1).join(' ');
  const genericWorkScore = scoreGenericWorkCandidate(source, candidate);

  if (!hasAddressLikeSignal(source)) return genericWorkScore;
  if (genericWorkScore >= 85) return genericWorkScore;
  if (name && source.includes(name)) return 100;
  if (street && number && source.includes(street) && source.includes(number)) return 80;
  if (candidate.nodeType === 'CABLE_RESERVE' && number && source.includes(number)) return 30;
  return genericWorkScore;
}

export function getSuggestedCandidates(input: {
  batch: SuggestionBatch;
  candidates: CandidateNode[];
  selected: Set<string>;
  query: string;
  limit?: number;
}): SuggestedCandidate[] {
  const query = normalize(input.query);
  const limit = input.limit ?? (query ? 40 : 12);

  return input.candidates
    .map((candidate) => ({ candidate, score: scoreCandidate(input.batch, candidate) }))
    .filter(
      ({ candidate, score }) =>
        input.selected.has(candidate.id) ||
        score > 0 ||
        (query && (normalize(candidate.name).includes(query) || normalize(candidate.path).includes(query))),
    )
    .sort((left, right) => right.score - left.score || left.candidate.name.localeCompare(right.candidate.name))
    .slice(0, limit);
}
