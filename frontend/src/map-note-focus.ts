import type { ProjectMapNote } from './types';

export interface MapNoteFocusPosition {
  lat: number;
  lng: number;
}

export function getMapNoteFocusPosition(note: ProjectMapNote): MapNoteFocusPosition | null {
  if (note.lat == null || note.lng == null) return null;
  return { lat: note.lat, lng: note.lng };
}
