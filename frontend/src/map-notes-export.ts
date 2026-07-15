const POLISH_DIACRITICS: Record<string, string> = {
  '\u0105': 'a',
  '\u0107': 'c',
  '\u0119': 'e',
  '\u0142': 'l',
  '\u0144': 'n',
  '\u00f3': 'o',
  '\u015b': 's',
  '\u017a': 'z',
  '\u017c': 'z',
  '\u0104': 'A',
  '\u0106': 'C',
  '\u0118': 'E',
  '\u0141': 'L',
  '\u0143': 'N',
  '\u00d3': 'O',
  '\u015a': 'S',
  '\u0179': 'Z',
  '\u017b': 'Z',
};

const POLISH_DIACRITICS_PATTERN =
  /[\u0105\u0107\u0119\u0142\u0144\u00f3\u015b\u017a\u017c\u0104\u0106\u0118\u0141\u0143\u00d3\u015a\u0179\u017b]/g;

function normalizeProjectName(projectName: string): string {
  const normalized = projectName
    .replace(POLISH_DIACRITICS_PATTERN, (character) => POLISH_DIACRITICS[character] ?? character)
    .normalize('NFKD')
    .replace(/[\u0300-\u036f]/g, '')
    .toUpperCase()
    .replace(/[^A-Z0-9]+/g, '_')
    .replace(/^_+|_+$/g, '');

  return normalized || 'PROJEKT';
}

export function buildMapNotesReportUrl(projectId: string, includeQwenSummary: boolean): string {
  const summaryQuery = includeQwenSummary ? '?summary=qwen' : '';
  return `/api/projects/${encodeURIComponent(projectId)}/reports/map-notes.xlsx${summaryQuery}`;
}

export function buildMapNotesReportFileName(
  projectName: string,
  includeQwenSummary: boolean,
): string {
  const summarySuffix = includeQwenSummary ? '_qwen' : '';
  return `${normalizeProjectName(projectName)}_raport_notatek${summarySuffix}.xlsx`;
}
