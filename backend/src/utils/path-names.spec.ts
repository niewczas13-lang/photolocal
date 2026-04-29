import { describe, expect, it } from 'vitest';
import { safeFolderName, toAddressFolderName, uniqueFolderName } from './path-names.js';

describe('path name helpers', () => {
  it('normalizes Polish filesystem names into stable ASCII-ish folder names', () => {
    expect(safeFolderName('ul. Wronckiej 13/2')).toBe('UL_WRONCKIEJ_13_2');
    expect(safeFolderName('\u0141\u00f3d\u017a \u015al\u0105ska')).toBe('LODZ_SLASKA');
  });

  it('builds address folder names from street and building number', () => {
    expect(toAddressFolderName('Wronckiej', '13')).toBe('WRONCKIEJ_13');
    expect(toAddressFolderName('', '13')).toBe('ADRES_13');
  });

  it('returns a suffixed folder name when the first name already exists', () => {
    const existing = new Set(['PROJEKT', 'PROJEKT_2']);
    expect(uniqueFolderName('PROJEKT', (name) => existing.has(name))).toBe('PROJEKT_3');
  });
});
