import { describe, expect, it } from 'vitest';
import {
  mapProjectRoute,
  parseRouteFromHash,
  photoProjectRoute,
  projectListRoute,
} from './app-routing';

describe('app routing', () => {
  it('routes the map workspace separately from PhotoLocal project tabs', () => {
    expect(parseRouteFromHash('#/mapa')).toEqual({ mode: 'map', projectId: null, view: 'map' });
    expect(parseRouteFromHash('#/mapa/projects/project-1')).toEqual({
      mode: 'map',
      projectId: 'project-1',
      view: 'map',
    });
    expect(parseRouteFromHash('#/mapa/projects/project-1/tasks')).toEqual({
      mode: 'map',
      projectId: 'project-1',
      view: 'tasks',
    });
    expect(parseRouteFromHash('#/mapa/projects/project-1/notes')).toEqual({
      mode: 'map',
      projectId: 'project-1',
      view: 'notes',
    });
    expect(parseRouteFromHash('#/mapa/projects/project-1/address-candidates')).toEqual({
      mode: 'map',
      projectId: 'project-1',
      view: 'address-candidates',
    });
  });

  it('keeps PhotoLocal project tabs photo-only when a stale map hash is opened', () => {
    expect(parseRouteFromHash('#/projects/project-1/map')).toEqual({
      mode: 'photos',
      projectId: 'project-1',
      tab: 'photos',
    });
    expect(parseRouteFromHash('#/projects/project-1/settings')).toEqual({
      mode: 'photos',
      projectId: 'project-1',
      tab: 'photos',
    });
  });

  it('builds isolated hash routes for PhotoLocal and map workspace', () => {
    expect(projectListRoute()).toBe('/');
    expect(photoProjectRoute('project-1', 'review')).toBe('/projects/project-1/review');
    expect(photoProjectRoute('project-1', 'photos', 'node-5')).toBe('/projects/project-1/photos/node-5');
    expect(parseRouteFromHash('#/projects/project-1/photos/node-5')).toEqual({
      mode: 'photos',
      projectId: 'project-1',
      tab: 'photos',
      nodeId: 'node-5',
    });
    expect(mapProjectRoute('project-1')).toBe('/mapa/projects/project-1');
    expect(mapProjectRoute('project-1', 'tasks')).toBe('/mapa/projects/project-1/tasks');
    expect(mapProjectRoute('project-1', 'notes')).toBe('/mapa/projects/project-1/notes');
    expect(mapProjectRoute('project-1', 'address-candidates')).toBe('/mapa/projects/project-1/address-candidates');
    expect(mapProjectRoute(null)).toBe('/mapa');
  });
});
