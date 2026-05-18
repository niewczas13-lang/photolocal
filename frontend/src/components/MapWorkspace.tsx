import { useMemo, useState } from 'react';
import { Camera, Map, Search, Settings } from 'lucide-react';

import type { MapView } from '../app-routing';
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
    <div className="flex h-[calc(100vh-64px)] overflow-hidden bg-background">
      <aside className="flex w-80 shrink-0 flex-col border-r border-border bg-muted/10">
        <div className="border-b border-border p-4">
          <div className="flex items-center gap-2">
            <div className="rounded-md bg-primary/10 p-2 text-primary">
              <Map size={18} />
            </div>
            <div>
              <h2 className="text-base font-bold leading-none">Mapy zlecen</h2>
              <p className="mt-1 text-xs text-muted-foreground">{projects.length} projektow w bazie</p>
            </div>
          </div>
          <div className="relative mt-4">
            <Search size={15} className="absolute left-3 top-1/2 -translate-y-1/2 text-muted-foreground" />
            <Input
              value={query}
              onChange={(event) => setQuery(event.target.value)}
              placeholder="Szukaj projektu..."
              className="h-9 pl-9"
            />
          </div>
        </div>

        <div className="min-h-0 flex-1 overflow-y-auto p-2">
          {filteredProjects.map((project) => {
            const isSelected = project.id === selectedProjectId;
            return (
              <button
                key={project.id}
                type="button"
                onClick={() => onSelectProject(project.id)}
                className={`mb-2 w-full rounded-md border p-3 text-left transition ${
                  isSelected
                    ? 'border-primary bg-primary/5 shadow-sm'
                    : 'border-border bg-background hover:border-primary/40'
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

      <section className="flex min-w-0 flex-1 flex-col">
        {selectedProject ? (
          <>
            <div className="flex min-h-16 items-center justify-between gap-4 border-b border-border px-5">
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
                <Button variant="outline" size="sm" onClick={() => onSelectProject(selectedProject.id)}>
                  Odswiez widok
                </Button>
              </div>
            </div>
            <ProjectMap projectId={selectedProject.id} view={mapView} onViewChange={onMapViewChange} />
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
