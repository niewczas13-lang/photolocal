import { describe, expect, it } from 'vitest';
import { getCandidateDisplay, getSuggestedCandidates, type CandidateNode } from './chat-review-suggestions';

const candidates: CandidateNode[] = [
  {
    id: 'address-5',
    name: 'Malenicka_5',
    path: 'Zapasy_kabli_instalacyjnych/OSD2766/Malenicka_5',
    nodeType: 'CABLE_RESERVE',
  },
  {
    id: 'address-7',
    name: 'Malenicka_7',
    path: 'Zapasy_kabli_instalacyjnych/OSD2766/Malenicka_7',
    nodeType: 'CABLE_RESERVE',
  },
  {
    id: 'excavation',
    name: 'Wykopy/Przeciski',
    path: 'Wykopy_Przeciski',
    nodeType: 'STATIC',
  },
  {
    id: 'work',
    name: 'Prace_zanikowe',
    path: 'Wykopy_Przeciski/Prace_zanikowe',
    nodeType: 'STATIC',
  },
  {
    id: 'notes',
    name: 'Zdjecia',
    path: 'Notatki_z_budowy/Zdjecia',
    nodeType: 'STATIC',
  },
  {
    id: 'pge',
    name: 'Budowa_liniowa',
    path: 'Podwieszenie_kabla_PGE/Budowa_liniowa',
    nodeType: 'STATIC',
  },
  {
    id: 'hanging',
    name: 'Budowa_liniowa',
    path: 'Podwieszenie_kabli/Budowa_liniowa',
    nodeType: 'STATIC',
  },
];

describe('chat review suggestions', () => {
  it('prioritizes generic work folders over addresses when a batch has no address-like description', () => {
    const suggested = getSuggestedCandidates({
      batch: { messageText: '', folderName: '2025-10-16_Brak opisu' },
      candidates,
      selected: new Set(),
      query: '',
    });

    expect(suggested.map(({ candidate }) => candidate.id).slice(0, 4)).toEqual([
      'notes',
      'pge',
      'hanging',
      'excavation',
    ]);
    expect(suggested.some(({ candidate }) => candidate.id === 'address-5')).toBe(false);
  });

  it('routes ordinary excavation and jacking batches to the Wykopy/Przeciski folder', () => {
    const suggested = getSuggestedCandidates({
      batch: { messageText: 'wykop pod kabel i przecisk pod droga', folderName: '2026-06-01_wykopy' },
      candidates,
      selected: new Set(),
      query: '',
    });

    expect(suggested[0]).toMatchObject({
      candidate: expect.objectContaining({ id: 'excavation' }),
      score: 95,
    });
  });

  it('routes restoration and backfilling batches to Prace zanikowe', () => {
    const suggested = getSuggestedCandidates({
      batch: {
        messageText: 'odtworzenie nawierzchni po przecisku, zasypanie i zageszczenie',
        folderName: '2026-06-02_odtworzenie',
      },
      candidates,
      selected: new Set(),
      query: '',
    });

    expect(suggested[0]).toMatchObject({
      candidate: expect.objectContaining({ id: 'work' }),
    });
    expect(suggested[0].score).toBeGreaterThan(suggested.find(({ candidate }) => candidate.id === 'excavation')!.score);
  });

  it('keeps address matches first when the batch text contains a real address', () => {
    const suggested = getSuggestedCandidates({
      batch: { messageText: 'Malenicka 5 zapas', folderName: '2025-10-17_Malenicka 5' },
      candidates,
      selected: new Set(),
      query: '',
    });

    expect(suggested[0].candidate.id).toBe('address-5');
  });

  it('puts the folder selected by classification before other suggestions', () => {
    const suggested = getSuggestedCandidates({
      batch: { messageText: 'Malenicka 5 zapas', folderName: '2025-10-17_Malenicka 5' },
      candidates,
      selected: new Set(['address-7']),
      query: '',
    });

    expect(suggested[0].candidate.id).toBe('address-7');
  });

  it('still allows searching address folders manually', () => {
    const suggested = getSuggestedCandidates({
      batch: { messageText: '', folderName: '2025-10-16_Brak opisu' },
      candidates,
      selected: new Set(),
      query: 'Malenicka 7',
    });

    expect(suggested.some(({ candidate }) => candidate.id === 'address-7')).toBe(true);
  });

  it('uses the checklist category as the primary display label for generic folders', () => {
    expect(getCandidateDisplay(candidates.find((candidate) => candidate.id === 'notes')!)).toEqual({
      primary: 'Notatki z budowy',
      secondary: 'Zdjecia',
    });
    expect(getCandidateDisplay(candidates.find((candidate) => candidate.id === 'pge')!)).toEqual({
      primary: 'Podwieszenie kabla PGE',
      secondary: 'Budowa liniowa',
    });
    expect(getCandidateDisplay(candidates.find((candidate) => candidate.id === 'work')!)).toEqual({
      primary: 'Wykopy/Przeciski',
      secondary: 'Prace zanikowe',
    });
    expect(getCandidateDisplay(candidates.find((candidate) => candidate.id === 'excavation')!)).toEqual({
      primary: 'Wykopy/Przeciski',
      secondary: 'Wykopy_Przeciski',
    });
  });
});
