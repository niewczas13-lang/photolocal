import { describe, expect, it } from 'vitest';

import { buildMapNotesReportFileName, buildMapNotesReportUrl } from './map-notes-export';

describe('map notes report export helpers', () => {
  it('builds the plain and Qwen report URLs with an encoded project id', () => {
    expect(buildMapNotesReportUrl('projekt/01', false)).toBe(
      '/api/projects/projekt%2F01/reports/map-notes.xlsx',
    );
    expect(buildMapNotesReportUrl('projekt/01', true)).toBe(
      '/api/projects/projekt%2F01/reports/map-notes.xlsx?summary=qwen',
    );
  });

  it('builds concise ASCII-safe report file names', () => {
    expect(buildMapNotesReportFileName('BARTAG / 01', true)).toBe(
      'BARTAG_01_raport_notatek_qwen.xlsx',
    );
    expect(buildMapNotesReportFileName('\u0141\u00f3d\u017a \u015al\u0105ska', false)).toBe(
      'LODZ_SLASKA_raport_notatek.xlsx',
    );
  });

  it('falls back to PROJEKT when the project name has no ASCII letters or digits', () => {
    expect(buildMapNotesReportFileName(' / ', false)).toBe('PROJEKT_raport_notatek.xlsx');
  });
});
