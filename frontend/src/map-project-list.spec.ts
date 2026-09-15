import { describe, expect, it, vi } from 'vitest';
import {
  filterAndSortProjects,
  getProjectCityOptions,
  normalizeProjectSearch,
  NO_CITY_FILTER,
  type ProjectSortOrder,
} from './map-project-list';
import type { ProjectSummary } from './types';

function project(
  id: string,
  overrides: Partial<ProjectSummary> = {},
): ProjectSummary {
  return {
    id,
    name: `Projekt ${id}`,
    projectDefinition: null,
    projectType: 'KPO',
    splitterTopology: 'SINGLE',
    splitterTopologySource: 'AUTO',
    splitterCount: 1,
    gpkgFileName: 'sample.gpkg',
    baseFolder: 'Z:\\projekty',
    googleChatSpaceName: null,
    googleChatSpaceDisplayName: null,
    googleChatLastDownloadAt: null,
    addressCount: 0,
    dacToAddressCableCount: 0,
    adssToAddressCableCount: 0,
    progressDone: 0,
    progressTotal: 0,
    status: 'W trakcie',
    createdAt: '2026-09-01T00:00:00Z',
    updatedAt: '2026-09-01T00:00:00Z',
    cities: [],
    ...overrides,
  };
}

function sortedIds(projects: ProjectSummary[], sortOrder: ProjectSortOrder): string[] {
  return filterAndSortProjects(projects, { query: '', city: '', sortOrder }).map(({ id }) => id);
}

describe('normalizeProjectSearch', () => {
  it('normalizes Polish diacritics, letter case and repeated whitespace', () => {
    expect(normalizeProjectSearch('  ŁÓDŹ\t\n Żółć  ')).toBe('lodz zolc');
  });

  it('normalizes decomposed Unicode accents and blank input', () => {
    expect(normalizeProjectSearch('Ło\u0301dz\u0301')).toBe('lodz');
    expect(normalizeProjectSearch(' \n\t ')).toBe('');
  });
});

describe('getProjectCityOptions', () => {
  it('counts each project once per normalized city while preserving display spelling', () => {
    const options = getProjectCityOptions([
      project('1', { cities: ['  Łódź ', 'LODZ', 'Nowa   Wieś'] }),
      project('2', { cities: ['łódź', 'NOWA WIES'] }),
      project('3', { cities: ['Poznań'] }),
    ]);

    expect(options).toEqual([
      { value: 'lodz', label: 'Łódź', count: 2 },
      { value: 'nowa wies', label: 'Nowa Wieś', count: 2 },
      { value: 'poznan', label: 'Poznań', count: 1 },
    ]);
  });

  it('sorts cities alphabetically in Polish and puts unknown cities last', () => {
    const legacyProject = project('legacy');
    Reflect.deleteProperty(legacyProject, 'cities');

    expect(getProjectCityOptions([
      project('1', { cities: ['Żary', 'Zamość', 'Łódź', 'Lublin'] }),
      project('2', { cities: [] }),
      project('3', { cities: [' ', '\t'] }),
      legacyProject,
    ])).toEqual([
      { value: 'lublin', label: 'Lublin', count: 1 },
      { value: 'lodz', label: 'Łódź', count: 1 },
      { value: 'zamosc', label: 'Zamość', count: 1 },
      { value: 'zary', label: 'Żary', count: 1 },
      { value: NO_CITY_FILTER, label: 'Brak miejscowości', count: 3 },
    ]);
  });

  it('does not infer cities from the project name or file name', () => {
    expect(getProjectCityOptions([
      project('1', { name: 'Łódź', gpkgFileName: 'Warszawa.gpkg' }),
    ])).toEqual([{ value: NO_CITY_FILTER, label: 'Brak miejscowości', count: 1 }]);
    expect(getProjectCityOptions([])).toEqual([]);
  });
});

describe('filterAndSortProjects filtering', () => {
  it.each([
    ['project name', { name: 'Łódź Zachód' }, '  LODZ   zachod '],
    ['project definition', { projectDefinition: 'X/04017284' }, 'x/04017'],
    ['GeoPackage file name', { gpkgFileName: 'Żółta-Sieć.gpkg' }, 'zolta-siec'],
    ['any project city', { cities: ['Olsztyn', 'Łódź'] }, 'lodz'],
  ])('searches %s without requiring exact Polish spelling', (_field, overrides, query) => {
    const match = project('match', overrides);
    expect(filterAndSortProjects([project('other'), match], {
      query,
      city: '',
      sortOrder: 'updated-desc',
    })).toEqual([match]);
  });

  it.each([
    { projectDefinition: 'X/04017284', query: 'zachod x/04017' },
    { projectDefinition: null, query: 'zachod sample.gpkg' },
  ])('preserves search across adjacent project fields for "$query"', ({
    projectDefinition,
    query,
  }) => {
    const match = project('match', { name: 'Łódź Zachód', projectDefinition });
    expect(filterAndSortProjects([project('other'), match], {
      query,
      city: '',
      sortOrder: 'updated-desc',
    })).toEqual([match]);
  });

  it('combines search with exact city membership across all project cities', () => {
    const match = project('1', { name: 'Etap 2', cities: ['Olsztyn', 'Łódź'] });
    const projects = [
      project('2', { name: 'Etap 2', cities: ['Łódź Wschód'] }),
      project('3', { name: 'Etap 1', cities: ['Łódź'] }),
      project('4', { name: 'Etap 2 Łódź' }),
      match,
    ];

    expect(filterAndSortProjects(projects, {
      query: 'ETAP 2',
      city: '  LODZ ',
      sortOrder: 'name-asc',
    })).toEqual([match]);
  });

  it('matches projects with empty or missing cities using the no-city filter', () => {
    const empty = project('empty', { name: 'Łódź' });
    const legacy = project('legacy');
    Reflect.deleteProperty(legacy, 'cities');
    const known = project('known', { cities: ['Łódź'] });

    expect(filterAndSortProjects([legacy, known, empty], {
      query: '',
      city: NO_CITY_FILTER,
      sortOrder: 'name-asc',
    })).toEqual([empty, legacy]);
  });

  it('shows all projects for blank filters and returns no rows for an unknown city', () => {
    const projects = [project('1'), project('2', { cities: ['Łódź'] })];

    expect(filterAndSortProjects(projects, {
      query: ' \t ', city: '', sortOrder: 'updated-desc',
    })).toEqual(projects);
    expect(filterAndSortProjects(projects, {
      query: '', city: 'Warszawa', sortOrder: 'updated-desc',
    })).toEqual([]);
  });
});

describe('filterAndSortProjects sorting', () => {
  it('treats SQLite timestamps as UTC alongside ISO timestamps in Europe/Warsaw', () => {
    vi.stubEnv('TZ', 'Europe/Warsaw');
    try {
      expect(new Date('2026-09-15T12:00:00Z').getTimezoneOffset()).toBe(-120);
      expect(sortedIds([
        project('iso-older', { updatedAt: '2026-09-15T11:30:00Z' }),
        project('sqlite-newer', { updatedAt: '2026-09-15 12:30:00' }),
        project('iso-tie', { name: 'Etap 10', updatedAt: '2026-09-15T12:00:00Z' }),
        project('sqlite-tie', { name: 'Etap 2', updatedAt: '2026-09-15 12:00:00' }),
      ], 'updated-desc')).toEqual(['sqlite-newer', 'sqlite-tie', 'iso-tie', 'iso-older']);
    } finally {
      vi.unstubAllEnvs();
    }
  });

  it('keeps malformed timestamps at the fallback value with deterministic name order', () => {
    expect(sortedIds([
      project('malformed', { name: 'Etap 10', updatedAt: 'not-a-date' }),
      project('invalid-sqlite', { name: 'Etap 2', updatedAt: '2026-99-99 88:88:88' }),
      project('valid', { updatedAt: '2026-09-15 12:30:00' }),
      project('empty', { name: 'Etap 1', updatedAt: '' }),
    ], 'updated-desc')).toEqual(['valid', 'empty', 'invalid-sqlite', 'malformed']);
  });

  it('sorts by update instant descending and uses names to resolve equal timestamps', () => {
    expect(sortedIds([
      project('older', { updatedAt: '2026-09-15T10:00:00+02:00' }),
      project('tie-10', { name: 'Etap 10', updatedAt: '2026-09-15T10:00:00Z' }),
      project('tie-2', { name: 'Etap 2', updatedAt: '2026-09-15T12:00:00+02:00' }),
      project('newer', { updatedAt: '2026-09-16T00:00:00Z' }),
    ], 'updated-desc')).toEqual(['newer', 'tie-2', 'tie-10', 'older']);
  });

  it.each([
    ['name-asc', ['2', '10', 'lublin', 'lodz']],
    ['name-desc', ['lodz', 'lublin', '10', '2']],
  ] as const)('uses natural Polish project names for %s', (sortOrder, expected) => {
    expect(sortedIds([
      project('lodz', { name: 'Łódź' }),
      project('10', { name: 'Etap 10' }),
      project('lublin', { name: 'Lublin' }),
      project('2', { name: 'Etap 2' }),
    ], sortOrder)).toEqual(expected);
  });

  it.each([
    ['city-asc', ['multi', 'tie-2', 'tie-10', 'unknown']],
    ['city-desc', ['tie-2', 'tie-10', 'multi', 'unknown']],
  ] as const)('uses the first alphabetical city and keeps unknowns last for %s', (sortOrder, expected) => {
    expect(sortedIds([
      project('unknown', { name: 'A' }),
      project('tie-10', { name: 'Etap 10', cities: ['Łódź'] }),
      project('multi', { cities: ['Żary', 'Lublin'] }),
      project('tie-2', { name: 'Etap 2', cities: ['Łódź', 'Olsztyn'] }),
    ], sortOrder)).toEqual(expected);
  });

  it.each([
    ['progress-asc', ['empty', 'quarter', 'half-2', 'half-10', 'complete']],
    ['progress-desc', ['complete', 'half-2', 'half-10', 'quarter', 'empty']],
  ] as const)('compares completion fractions with zero totals treated as zero for %s', (sortOrder, expected) => {
    expect(sortedIds([
      project('half-10', { name: 'Etap 10', progressDone: 50, progressTotal: 100 }),
      project('empty', { progressDone: 4, progressTotal: 0 }),
      project('complete', { progressDone: 1, progressTotal: 1 }),
      project('quarter', { progressDone: 25, progressTotal: 100 }),
      project('half-2', { name: 'Etap 2', progressDone: 1, progressTotal: 2 }),
    ], sortOrder)).toEqual(expected);
  });

  it('uses IDs as the final tie-breaker for identical names and values', () => {
    const projects = [project('b', { name: 'Etap' }), project('a', { name: 'Etap' })];
    expect(sortedIds(projects, 'updated-desc')).toEqual(['a', 'b']);
    expect(sortedIds([...projects].reverse(), 'updated-desc')).toEqual(['a', 'b']);
  });

  it('does not mutate project order, project values or the supplied city arrays', () => {
    const first = project('b', { cities: ['Żary', 'Lublin'] });
    const second = project('a', { cities: ['Łódź'] });
    Object.freeze(first.cities);
    Object.freeze(first);
    Object.freeze(second.cities);
    Object.freeze(second);
    const projects = Object.freeze([first, second]);

    const sorted = filterAndSortProjects(projects, {
      query: '', city: '', sortOrder: 'name-asc',
    });
    getProjectCityOptions(projects);
    filterAndSortProjects(projects, { query: '', city: '', sortOrder: 'city-asc' });

    expect(sorted).toEqual([second, first]);
    expect(sorted).not.toBe(projects);
    expect(projects).toEqual([first, second]);
    expect(first.cities).toEqual(['Żary', 'Lublin']);
  });
});
