import { useMemo, useState } from 'react';
import { Camera, Map, PanelLeftClose, PanelLeftOpen, Search, Settings } from 'lucide-react';

import type { MapView } from '../app-routing';
import { cn } from '../lib/utils';
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
}

function normalize(value: string): string {
  return value.toLowerCase().replace(/\s+/g, ' ').trim();
}

export default function MapWorkspace({
  projects,
  selectedProjectId,
  mapView,
  onSelectProject,
  onMapViewChange,
  onOpenPhotos,
  onOpenSettings,
}: MapWorkspaceProps) {
  const [query, setQuery] = useState('');
  const [projectPanelOpen, setProjectPanelOpen] = useState(true);
  const selectedProject = selectedProjectId
    ? projects.find((project) => project.id === selectedProjectId) ?? null
    : null;
  const filteredProjects = useMemo(() => {
    const normalizedQuery = normalize(query);
    if (!normalizedQuery) return projects;
    return projects.filter((project) =>
      normalize([project.name, project.projectDefinition, project.gpkgFileName].filter(Boolean).join(' ')).includes(
        normalizedQuery,
      ),
    );
  }, [projects, query]);

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
              className="h-9 pl-9"
            />
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
              Brak projektow dla tego wyszukiwania.
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
