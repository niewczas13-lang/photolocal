import { describe, expect, it } from 'vitest';
import { inferSplitterTopology, normalizeCableAddressEntry } from './gpkg-extractor.js';

describe('GPKG extractor helpers', () => {
  it('marks more than two splitters as cascade', () => {
    expect(inferSplitterTopology(3)).toBe('CASCADE');
    expect(inferSplitterTopology(4)).toBe('CASCADE');
  });

  it('marks two or fewer splitters as single', () => {
    expect(inferSplitterTopology(0)).toBe('SINGLE');
    expect(inferSplitterTopology(1)).toBe('SINGLE');
    expect(inferSplitterTopology(2)).toBe('SINGLE');
  });

  it('normalizes cable destination address into the same format as checklist matching', () => {
    expect(normalizeCableAddressEntry('RADOM, UL. WRONCKIEJ, 13')).toBe('WRONCKIEJ 13');
    expect(normalizeCableAddressEntry('OSTRZESZEWO, 22')).toBe('OSTRZESZEWO 22');
  });
});
