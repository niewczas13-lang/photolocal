import { describe, expect, it } from 'vitest';
import { getProjectEntryActions } from './project-entry-actions';

describe('project entry actions', () => {
  it('offers map, photo checklist, and settings entries for each project', () => {
    expect(getProjectEntryActions('project-1')).toEqual([
      {
        key: 'map',
        label: 'Mapa + zadania',
        route: '/mapa/projects/project-1',
      },
      {
        key: 'photos',
        label: 'Zdjecia',
        route: '/projects/project-1/photos',
      },
      {
        key: 'settings',
        label: 'Ustawienia',
        route: null,
      },
    ]);
  });
});
