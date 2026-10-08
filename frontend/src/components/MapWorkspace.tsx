import { useId, useMemo, useState } from 'react';
import { Camera, Map, PanelLeftClose, PanelLeftOpen, Search, Settings } from 'lucide-react';

import type { MapView } from '../app-routing';
import { cn } from '../lib/utils';
import {
  filterAndSortProjects,
  getProjectCityOptions,
  PROJECT_SORT_OPTIONS,
  type ProjectSortOrder,
} from '../map-project-list';
import type { ProjectSummary } from '../types';
import ProjectMap from './ProjectMap';
import { Badge } from './ui/badge';
import { Button } from './ui/button';
import { Input } from './ui/input';

interface MapWorkspaceProps {
  projects: ProjectSummary[];
  selectedProjectId: string | null;
  mapView: MapView;
  onSelectProject: (projectId: string) => void;
  onMapViewChange: (view: MapView) => void;
  onOpenPhotos: (projectId: string) => void;
  onOpenSettings: (projectId: string) => void;
  onProjectsChanged?: () => Promise<void>;
}

export default function MapWorkspace({
  projects,
  selectedProjectId,
  mapView,
  onSelectProject,
  onMapViewChange,
  onOpenPhotos,
  onOpenSettings,
  onProjectsChanged,
}: MapWorkspaceProps) {
  const [query, setQuery] = useState('');
  const [city, setCity] = useState('');
  const [sortOrder, setSortOrder] = useState<ProjectSortOrder>('updated-desc');
  const [projectPanelOpen, setProjectPanelOpen] = useState(true);
  const filterId = useId();
  const selectedProject = selectedProjectId
    ? projects.find((project) => project.id === selectedProjectId) ?? null
    : null;
  const cityOptions = useMemo(() => getProjectCityOptions(projects), [projects]);
  const filteredProjects = useMemo(
    () => filterAndSortProjects(projects, { query, city, sortOrder }),
    [projects, query, city, sortOrder],
  );
  const hasFilters = Boolean(query.trim() || city);
  const clearFilters = () => {
    setQuery('');
    setCity('');
  };

  return (
    <div className={cn('map-workspace', !projectPanelOpen && 'map-workspace--collapsed')}>
      <aside className="map-workspace__sidebar">
        <div className="map-workspace__sidebar-header">
          <div className="map-workspace__sidebar-heading">
            <div className="map-workspace__sidebar-icon">
              <Map size={18} />
            </div>
            <div className="map-workspace__sidebar-title">
              <h2>Mapy zlecen</h2>
              <p>{projects.length} projektow w bazie</p>
            </div>
            <Button
              type="button"
              variant="ghost"
              size="icon"
              className="map-workspace__sidebar-toggle"
              aria-label={projectPanelOpen ? 'Zwin panel projektow' : 'Rozwin panel projektow'}
              onClick={() => setProjectPanelOpen((current) => !current)}
            >
              {projectPanelOpen ? <PanelLeftClose size={17} /> : <PanelLeftOpen size={17} />}
            </Button>
          </div>
          <div className="map-workspace__search">
            <Search size={15} className="absolute left-3 top-1/2 -translate-y-1/2 text-muted-foreground" />
            <Input
              value={query}
              onChange={(event) => setQuery(event.target.value)}
              placeholder="Szukaj projektu..."
              aria-label="Szukaj projektu lub miejscowości"
              className="h-9 pl-9"
            />
          </div>
          <div className="map-workspace__filters mt-3 space-y-3">
            <div className="space-y-1">
              <label htmlFor={`${filterId}-city`} className="block text-xs text-muted-foreground">
                Miejscowość
              </label>
              <select
                id={`${filterId}-city`}
                value={city}
                onChange={(event) => setCity(event.target.value)}
                className="h-9 w-full min-w-0 rounded-lg border border-input bg-background px-2 text-sm outline-none focus-visible:border-ring focus-visible:ring-2 focus-visible:ring-ring/50"
              >
                <option value="">Wszystkie miejscowości</option>
                {city && !cityOptions.some((option) => option.value === city) && (
                  <option value={city}>Wybrana miejscowość (0)</option>
                )}
                {cityOptions.map((option) => (
                  <option key={option.value} value={option.value}>
                    {option.label} ({option.count})
                  </option>
                ))}
              </select>
            </div>
            <div className="space-y-1">
              <label htmlFor={`${filterId}-sort`} className="block text-xs text-muted-foreground">
                Sortowanie
              </label>
              <select
                id={`${filterId}-sort`}
                value={sortOrder}
                onChange={(event) => setSortOrder(event.target.value as ProjectSortOrder)}
                className="h-9 w-full min-w-0 rounded-lg border border-input bg-background px-2 text-sm outline-none focus-visible:border-ring focus-visible:ring-2 focus-visible:ring-ring/50"
              >
                {PROJECT_SORT_OPTIONS.map((option) => (
                  <option key={option.value} value={option.value}>{option.label}</option>
                ))}
              </select>
            </div>
            <div className="flex min-h-7 items-center justify-between gap-2">
              <p role="status" className="text-xs text-muted-foreground">
                Projekty: {filteredProjects.length} z {projects.length}
              </p>
              {hasFilters && (
                <Button type="button" variant="ghost" size="sm" onClick={clearFilters}>
                  Wyczyść filtry
                </Button>
              )}
            </div>
          </div>
        </div>

        <div className="map-workspace__project-list">
          {filteredProjects.map((project) => {
            const isSelected = project.id === selectedProjectId;
            return (
              <button
                key={project.id}
                type="button"
                onClick={() => onSelectProject(project.id)}
                className={`map-workspace__project-card ${
                  isSelected
                    ? 'map-workspace__project-card--selected'
                    : 'map-workspace__project-card--idle'
                }`}
              >
                <div className="flex items-start justify-between gap-3">
                  <div className="min-w-0">
                    <p className="truncate text-sm font-semibold">{project.name}</p>
                    <p className="mt-1 truncate text-xs text-muted-foreground">{project.gpkgFileName}</p>
                    <p
                      className="mt-1 truncate text-xs text-muted-foreground"
                      title={project.cities?.join(', ') || 'Brak miejscowości'}
                    >
                      {project.cities?.join(', ') || 'Brak miejscowości'}
                    </p>
                  </div>
                  <Badge variant={project.status === 'Kompletne' ? 'default' : 'outline'}>
                    {project.projectType}
                  </Badge>
                </div>
                <div className="mt-3 flex items-center justify-between text-xs text-muted-foreground">
                  <span>{project.addressCount} adresow</span>
                  <span>
                    {project.progressDone}/{project.progressTotal}
                  </span>
                </div>
              </button>
            );
          })}

          {filteredProjects.length === 0 && (
            <div className="rounded-md border border-dashed border-border p-6 text-center text-sm text-muted-foreground">
              {projects.length === 0
                ? 'Brak projektów w bazie.'
                : 'Brak projektów spełniających wybrane filtry.'}
            </div>
          )}
        </div>
      </aside>

      <section className="map-workspace__main">
        {selectedProject ? (
          <>
            <div className="map-workspace__project-header">
              <Button
                type="button"
                variant="outline"
                size="sm"
                className="map-workspace__main-toggle"
                onClick={() => setProjectPanelOpen((current) => !current)}
              >
                {projectPanelOpen ? <PanelLeftClose size={15} /> : <PanelLeftOpen size={15} />}
                Projekty
              </Button>
              <div className="min-w-0">
                <h1 className="truncate text-lg font-bold">{selectedProject.name}</h1>
                <p className="text-sm text-muted-foreground">
                  {selectedProject.projectDefinition ?? 'Bez definicji'} · {selectedProject.gpkgFileName}
                </p>
              </div>
              <div className="flex shrink-0 items-center gap-2">
                <Button variant="outline" size="sm" onClick={() => onOpenPhotos(selectedProject.id)}>
                  <Camera size={15} />
                  Zdjecia
                </Button>
                <Button variant="outline" size="sm" onClick={() => onOpenSettings(selectedProject.id)}>
                  <Settings size={15} />
                  Ustawienia
                </Button>
              </div>
            </div>
            <ProjectMap
              projectId={selectedProject.id}
              projectName={selectedProject.name}
              view={mapView}
              onViewChange={onMapViewChange}
              onProjectsChanged={onProjectsChanged}
            />
          </>
        ) : (
          <div className="flex flex-1 items-center justify-center p-8 text-center text-muted-foreground">
            <div>
              <Map size={44} className="mx-auto mb-4 opacity-30" />
              <h1 className="text-lg font-semibold text-foreground">Wybierz zlecenie z listy</h1>
              <p className="mt-2 max-w-sm text-sm">
                Ten ekran jest osobnym panelem mapowym i korzysta z tej samej bazy projektow co PhotoLocal.
              </p>
            </div>
          </div>
        )}
      </section>
    </div>
  );
}
