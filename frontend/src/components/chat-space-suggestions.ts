import type { GoogleChatSpace, ProjectSummary } from '../types';

interface RankedSpace {
  space: GoogleChatSpace;
  score: number;
  isSuggested: boolean;
}

function normalizeForMatch(value: string): string {
  return value
    .normalize('NFD')
    .replace(/\p{Diacritic}/gu, '')
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, ' ')
    .trim();
}

function compact(value: string): string {
  return normalizeForMatch(value).replace(/\s+/g, '');
}

function tokens(value: string): string[] {
  const ignored = new Set(['q', 'kpo', 'si', 'mr', 'e', 'olsz', 'ols', 'pl']);
  return normalizeForMatch(value)
    .split(/\s+/)
    .filter((token) => token.length >= 3 && !ignored.has(token));
}

function scoreSpace(project: ProjectSummary, space: GoogleChatSpace): number {
  const spaceText = `${space.displayName} ${space.name}`;
  const normalizedSpace = normalizeForMatch(spaceText);
  const compactSpace = compact(spaceText);
  let score = 0;

  if (project.googleChatSpaceName && space.name === project.googleChatSpaceName) score += 10_000;

  if (project.projectDefinition) {
    const normalizedDefinition = normalizeForMatch(project.projectDefinition);
    const compactDefinition = compact(project.projectDefinition);
    const definitionDigits = project.projectDefinition.replace(/\D+/g, '');

    if (normalizedDefinition && normalizedSpace.includes(normalizedDefinition)) score += 1000;
    if (compactDefinition && compactSpace.includes(compactDefinition)) score += 900;
    if (definitionDigits.length >= 5 && compactSpace.includes(definitionDigits)) score += 700;
  }

  const nameTokens = tokens(project.name);
  const spaceTokens = new Set(tokens(spaceText));
  for (const token of nameTokens) {
    if (spaceTokens.has(token) || normalizedSpace.includes(token)) {
      score += token.length >= 5 ? 80 : 40;
    }
  }

  return score;
}

export function getSuggestedGoogleChatSpaces(
  project: ProjectSummary,
  spaces: GoogleChatSpace[],
): RankedSpace[] {
  return spaces
    .map((space) => {
      const score = scoreSpace(project, space);
      return { space, score, isSuggested: score > 0 };
    })
    .sort((left, right) => {
      if (right.score !== left.score) return right.score - left.score;
      return left.space.displayName.localeCompare(right.space.displayName, 'pl');
    });
}

