import { mapProjectRoute, photoProjectRoute } from './app-routing';

export type ProjectEntryActionKey = 'map' | 'photos' | 'settings';

export interface ProjectEntryAction {
  key: ProjectEntryActionKey;
  label: string;
  route: string | null;
}

export function getProjectEntryActions(projectId: string): ProjectEntryAction[] {
  return [
    {
      key: 'map',
      label: 'Mapa + zadania',
      route: mapProjectRoute(projectId),
    },
    {
      key: 'photos',
      label: 'Zdjecia',
      route: photoProjectRoute(projectId, 'photos'),
    },
    {
      key: 'settings',
      label: 'Ustawienia',
      route: null,
    },
  ];
}
