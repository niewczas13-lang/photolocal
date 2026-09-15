import type { ProjectSummary } from './types';

export const NO_CITY_FILTER = '__no_city__';

export type ProjectSortOrder =
  | 'updated-desc'
  | 'name-asc'
  | 'name-desc'
  | 'city-asc'
  | 'city-desc'
  | 'progress-asc'
  | 'progress-desc';

export const PROJECT_SORT_OPTIONS: { value: ProjectSortOrder; label: string }[] = [
  { value: 'updated-desc', label: 'Ostatnio aktualizowane' },
  { value: 'name-asc', label: 'Nazwa: A–Z' },
  { value: 'name-desc', label: 'Nazwa: Z–A' },
  { value: 'city-asc', label: 'Miejscowość: A–Z' },
  { value: 'city-desc', label: 'Miejscowość: Z–A' },
  { value: 'progress-asc', label: 'Postęp: rosnąco' },
  { value: 'progress-desc', label: 'Postęp: malejąco' },
];

const COLLATOR = new Intl.Collator('pl', { numeric: true, sensitivity: 'base' });

export interface ProjectCityOption {
  value: string;
  label: string;
  count: number;
}

export interface ProjectListFilters {
  query: string;
  city: string;
  sortOrder: ProjectSortOrder;
}

export function normalizeProjectSearch(value: string): string {
  return value
    .toLocaleLowerCase('pl')
    .normalize('NFD')
    .replace(/\p{M}/gu, '')
    .replace(/ł/g, 'l')
    .replace(/\s+/g, ' ')
    .trim();
}

function getProjectCities(project: ProjectSummary): string[] {
  return (project.cities ?? [])
    .map((city) => city.replace(/\s+/g, ' ').trim())
    .filter(Boolean);
}

export function getProjectCityOptions(projects: readonly ProjectSummary[]): ProjectCityOption[] {
  const optionsByCity = new Map<string, ProjectCityOption>();
  let unknownCount = 0;

  for (const project of projects) {
    const cities = getProjectCities(project);
    if (cities.length === 0) {
      unknownCount += 1;
      continue;
    }

    const projectCityKeys = new Set<string>();
    for (const label of cities) {
      const value = normalizeProjectSearch(label);
      if (projectCityKeys.has(value)) continue;
      projectCityKeys.add(value);

      const option = optionsByCity.get(value);
      if (option) {
        option.count += 1;
      } else {
        optionsByCity.set(value, { value, label, count: 1 });
      }
    }
  }

  const options = [...optionsByCity.values()].sort((a, b) => COLLATOR.compare(a.label, b.label));
  if (unknownCount > 0) {
    options.push({ value: NO_CITY_FILTER, label: 'Brak miejscowości', count: unknownCount });
  }
  return options;
}

function compareProjectNames(a: ProjectSummary, b: ProjectSummary): number {
  return COLLATOR.compare(a.name, b.name) || (a.id < b.id ? -1 : a.id > b.id ? 1 : 0);
}

function getProjectProgress(project: ProjectSummary): number {
  return project.progressTotal > 0 ? project.progressDone / project.progressTotal : 0;
}

function parseProjectTimestamp(value: string): number {
  // SQLite CURRENT_TIMESTAMP is UTC even though it does not include a timezone suffix.
  const timestamp = /^\d{4}-\d{2}-\d{2} \d{2}:\d{2}:\d{2}$/.test(value)
    ? `${value.replace(' ', 'T')}Z`
    : value;
  return Date.parse(timestamp) || 0;
}

export function filterAndSortProjects(
  projects: readonly ProjectSummary[],
  filters: ProjectListFilters,
): ProjectSummary[] {
  const query = normalizeProjectSearch(filters.query);
  const city = normalizeProjectSearch(filters.city);

  return projects
    .map((project) => ({ project, cities: getProjectCities(project).sort(COLLATOR.compare) }))
    .filter(({ project, cities }) => {
      const matchesCity =
        city === '' ||
        (city === NO_CITY_FILTER
          ? cities.length === 0
          : cities.some((value) => normalizeProjectSearch(value) === city));
      const matchesQuery =
        query === '' ||
        normalizeProjectSearch(
          [project.name, project.projectDefinition, project.gpkgFileName, ...cities]
            .filter(Boolean)
            .join(' '),
        ).includes(query);

      return matchesCity && matchesQuery;
    })
    .sort(({ project: a, cities: aCities }, { project: b, cities: bCities }) => {
      let order = 0;
      switch (filters.sortOrder) {
        case 'name-asc':
          order = COLLATOR.compare(a.name, b.name);
          break;
        case 'name-desc':
          order = COLLATOR.compare(b.name, a.name);
          break;
        case 'city-asc':
        case 'city-desc': {
          const aCity = aCities[0];
          const bCity = bCities[0];
          if (aCity === undefined || bCity === undefined) {
            order = Number(aCity === undefined) - Number(bCity === undefined);
          } else {
            order = COLLATOR.compare(aCity, bCity) * (filters.sortOrder === 'city-desc' ? -1 : 1);
          }
          break;
        }
        case 'progress-asc':
          order = getProjectProgress(a) - getProjectProgress(b);
          break;
        case 'progress-desc':
          order = getProjectProgress(b) - getProjectProgress(a);
          break;
        case 'updated-desc':
        default:
          order = parseProjectTimestamp(b.updatedAt) - parseProjectTimestamp(a.updatedAt);
      }
      return order || compareProjectNames(a, b);
    })
    .map(({ project }) => project);
}
