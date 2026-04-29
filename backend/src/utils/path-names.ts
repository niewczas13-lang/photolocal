const POLISH_CHARS: Record<string, string> = {
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

const POLISH_PATTERN =
  /[\u0105\u0107\u0119\u0142\u0144\u00f3\u015b\u017a\u017c\u0104\u0106\u0118\u0141\u0143\u00d3\u015a\u0179\u017b]/g;

export function safeFolderName(value: string): string {
  const normalized = value
    .replace(POLISH_PATTERN, (char) => POLISH_CHARS[char] ?? char)
    .toUpperCase()
    .replace(/[^A-Z0-9]+/g, '_')
    .replace(/^_+|_+$/g, '');

  return normalized || 'BEZ_NAZWY';
}

export function toAddressFolderName(street: string, buildingNo: string | null): string {
  const base = [street || 'ADRES', buildingNo ?? ''].filter(Boolean).join(' ');
  return safeFolderName(base);
}

export function uniqueFolderName(baseName: string, exists: (name: string) => boolean): string {
  const safeBase = safeFolderName(baseName);
  if (!exists(safeBase)) return safeBase;

  for (let index = 2; index < 10_000; index++) {
    const candidate = `${safeBase}_${index}`;
    if (!exists(candidate)) return candidate;
  }

  throw new Error(`Unable to build unique folder name for ${safeBase}`);
}
