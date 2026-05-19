export type ProjectTab = 'photos' | 'missing' | 'import' | 'ready' | 'review';

export interface PhotoRoute {
  mode: 'photos';
  projectId: string | null;
  tab: ProjectTab;
}

export interface MapRoute {
  mode: 'map';
  projectId: string | null;
  view: MapView;
}

export type AppRoute = PhotoRoute | MapRoute;
export type MapView = 'map' | 'tasks' | 'notes';

const DEFAULT_TAB: ProjectTab = 'photos';
const PROJECT_TABS = new Set<ProjectTab>(['photos', 'missing', 'import', 'ready', 'review']);

export function projectListRoute(): string {
  return '/';
}

export function parseRouteFromHash(hash: string): AppRoute {
  const normalizedHash = hash.replace(/^#\/?/, '');
  const parts = normalizedHash.split('/').filter(Boolean);

  if (parts[0] === 'mapa') {
    const projectId = parts[1] === 'projects' && parts[2] ? decodeURIComponent(parts[2]) : null;
    const view: MapView = parts[3] === 'tasks' ? 'tasks' : parts[3] === 'notes' ? 'notes' : 'map';
    return { mode: 'map', projectId, view };
  }

  if (parts[0] !== 'projects' || !parts[1]) {
    return { mode: 'photos', projectId: null, tab: DEFAULT_TAB };
  }

  const tab = PROJECT_TABS.has(parts[2] as ProjectTab) ? (parts[2] as ProjectTab) : DEFAULT_TAB;
  return { mode: 'photos', projectId: decodeURIComponent(parts[1]), tab };
}

export function photoProjectRoute(projectId: string | null, tab: ProjectTab = DEFAULT_TAB): string {
  return projectId ? `/projects/${encodeURIComponent(projectId)}/${tab}` : projectListRoute();
}

export function mapProjectRoute(projectId: string | null, view: MapView = 'map'): string {
  if (!projectId) return '/mapa';
  const suffix = view === 'tasks' ? '/tasks' : view === 'notes' ? '/notes' : '';
  return `/mapa/projects/${encodeURIComponent(projectId)}${suffix}`;
}
