import { describe, expect, it } from 'vitest';
import {
  extractMatcherFeatures,
  findBestChecklistCandidate,
  findBestDistributionDetailCandidate,
  normalizeMatcherText,
  type ChecklistMatcherCandidate,
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

describe('findBestChecklistCandidate', () => {
  it('selects the exact candidate over a fuzzy candidate', () => {
    const source = '2025-10-20_UL_MALENICKA_30A zapas w studni rurka drozna';
    const candidates: ChecklistMatcherCandidate[] = [
      {
        id: 'node-ul_malenicka_30a',
        name: 'UL_MALENICKA_30A',
        path: 'Zapasy_kabli_instalacyjnych/RADOM_OPP1416/UL_MALENICKA_30A',
        nodeType: 'CABLE_RESERVE',
        acceptsPhotos: true,
      },
      {
        id: 'node-ul_malinicka_30a',
        name: 'UL_MALINICKA_30A',
        path: 'Zapasy_kabli_instalacyjnych/RADOM_OPP1416/UL_MALINICKA_30A',
        nodeType: 'CABLE_RESERVE',
        acceptsPhotos: true,
      },
    ];

    const result = findBestChecklistCandidate(source, candidates);
    expect(result?.candidate.id).toBe('node-ul_malenicka_30a');
  });

  it('keeps ambiguous same-number candidates unresolved', () => {
    const source = 'Maleniecka 44';
    const candidates: ChecklistMatcherCandidate[] = [
      {
        id: 'node-malenicka-44',
        name: 'Malenicka_44',
        path: 'Zapasy_kabli_instalacyjnych/OPP0013/Malenicka_44',
        nodeType: 'CABLE_RESERVE',
        acceptsPhotos: true,
      },
      {
        id: 'node-malinicka-44',
        name: 'Malinicka_44',
        path: 'Zapasy_kabli_instalacyjnych/OPP0013/Malinicka_44',
        nodeType: 'CABLE_RESERVE',
        acceptsPhotos: true,
      },
    ];

    const result = findBestChecklistCandidate(source, candidates);
    expect(result).toBeNull();
  });
});

describe('findBestDistributionDetailCandidate', () => {
  it('matches point identifiers with flexible spacing', () => {
    const source = 'OSD 2766';
    const candidates: ChecklistMatcherCandidate[] = [
      {
        id: 'node-osd2766-details',
        name: 'Szczegoly_skrzynki',
        path: 'OSD2766/Szczegoly_skrzynki',
        nodeType: 'DISTRIBUTION',
        acceptsPhotos: true,
      },
    ];

    const result = findBestDistributionDetailCandidate(source, candidates);
    expect(result?.id).toBe('node-osd2766-details');
  });
});
