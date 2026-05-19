import { describe, expect, it } from 'vitest';
import { formatCableLength } from './map-format';

describe('map formatters', () => {
  it('formats cable lengths for Polish map popups', () => {
    expect(formatCableLength(620.5)).toBe('620,5 m');
    expect(formatCableLength(500)).toBe('500 m');
    expect(formatCableLength(null)).toBe('brak danych');
  });
});
