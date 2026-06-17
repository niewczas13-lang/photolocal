import { describe, expect, it } from 'vitest';
import { getMapNoteFocusPosition } from './map-note-focus';
import type { ProjectMapNote } from './types';

const baseNote: ProjectMapNote = {
  id: 'note-1',
  targetType: 'free',
  targetId: null,
  targetLabel: 'Notatka mapy',
  body: 'Sprawdzic trase',
  lat: 53.75,
  lng: 20.55,
  photoCount: 0,
  photos: [],
  createdAt: '2026-06-17T10:00:00.000Z',
  updatedAt: '2026-06-17T10:00:00.000Z',
};

describe('map note focus', () => {
  it('returns coordinates for notes that can be shown on the map', () => {
    expect(getMapNoteFocusPosition(baseNote)).toEqual({ lat: 53.75, lng: 20.55 });
  });

  it('does not focus notes without a saved map point', () => {
    expect(getMapNoteFocusPosition({ ...baseNote, lat: null })).toBeNull();
    expect(getMapNoteFocusPosition({ ...baseNote, lng: null })).toBeNull();
  });
});
