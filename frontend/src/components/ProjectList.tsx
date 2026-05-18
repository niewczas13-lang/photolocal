import { useState, useMemo } from 'react';
import { Camera, CheckCheck, FolderPlus, Map as MapIcon, Search, Settings, Trash2 } from 'lucide-react';
import { api } from '../api';
import { getProjectEntryActions, type ProjectEntryActionKey } from '../project-entry-actions';
import type { ProjectSummary } from '../types';
import { Tabs, TabsList, TabsTrigger, TabsContent } from './ui/tabs';
import { Button } from './ui/button';
import { Badge } from './ui/badge';
import { Progress } from './ui/progress';

interface ProjectListProps {
  projects: ProjectSummary[];
  onCreate: () => void;
  onOpenPhotos: (projectId: string) => void;
  onOpenMap: (projectId: string) => void;
  onOpenSettings: (projectId: string) => void;
  onDeleted: (projectId: string) => void;
}

export default function ProjectList({
  projects,
  onCreate,
  onOpenPhotos,
  onOpenMap,
  onOpenSettings,
  onDeleted,
}: ProjectListProps) {
  const [tab, setTab] = useState<'IN_PROGRESS' | 'COMPLETED'>('IN_PROGRESS');
  const [deletingProjectId, setDeletingProjectId] = useState<string | null>(null);
  const [searchQuery, setSearchQuery] = useState('');

  const filteredProjects = useMemo(() => {
    const query = searchQuery.trim().toLowerCase();
    return projects.filter((p) => {
      const matchesTab = tab === 'IN_PROGRESS' ? p.status !== 'Kompletne' : p.status === 'Kompletne';
      if (!matchesTab) return false;
      if (!query) return true;

      return [p.projectDefinition, p.name, p.gpkgFileName]
        .filter(Boolean)
        .some((value) => value!.toLowerCase().includes(query));
    });
  }, [projects, searchQuery, tab]);

  const handleDelete = async (project: ProjectSummary) => {
    const confirmed = window.confirm(
      `Usunac projekt "${project.name}" z aplikacji?\n\nZdjecia na dysku zostana w folderze:\n${project.baseFolder}`,
    );
    if (!confirmed) return;

    setDeletingProjectId(project.id);
    try {
      await api.deleteProject(project.id);
      onDeleted(project.id);
    } catch (error) {
      console.error(error);
      alert('Blad podczas usuwania projektu');
    } finally {
      setDeletingProjectId(null);
    }
  };

  const handleProjectAction = (projectId: string, action: ProjectEntryActionKey) => {
    if (action === 'map') {
      onOpenMap(projectId);
      return;
    }
    if (action === 'settings') {
      onOpenSettings(projectId);
      return;
    }
    onOpenPhotos(projectId);
  };

  const getActionIcon = (action: ProjectEntryActionKey) => {
    if (action === 'map') return <MapIcon size={15} />;
    if (action === 'settings') return <Settings size={15} />;
    return <Camera size={15} />;
  };

  return (
    <section className="container mx-auto p-6 max-w-6xl">
      <div className="flex flex-col md:flex-row items-start md:items-center justify-between mb-8 gap-4">
        <div>
          <h2 className="text-3xl font-bold text-foreground tracking-tight">Lista zlecen</h2>
          <p className="text-muted-foreground mt-1">Wybierz tryb pracy dla projektu</p>
        </div>
        <Button onClick={onCreate} className="gap-2 font-semibold">
          <FolderPlus size={18} />
          Utwórz zadanie
        </Button>
      </div>

      <div className="mb-6 rounded-xl border border-border bg-card p-3 shadow-sm">
        <div className="relative w-full">
          <Search size={16} className="absolute left-3 top-1/2 -translate-y-1/2 text-muted-foreground" />
          <input
            value={searchQuery}
            onChange={(event) => setSearchQuery(event.target.value)}
            placeholder="Szukaj po definicji projektu, nazwie albo pliku GPKG"
            className="h-10 w-full rounded-lg border border-input bg-background pl-9 pr-3 text-sm outline-none transition-colors placeholder:text-muted-foreground focus-visible:border-ring focus-visible:ring-3 focus-visible:ring-ring/50"
          />
        </div>
      </div>

      <Tabs defaultValue="IN_PROGRESS" value={tab} onValueChange={(v) => setTab(v as any)} className="w-full">
        <TabsList className="mb-6">
          <TabsTrigger value="IN_PROGRESS">W trakcie</TabsTrigger>
          <TabsTrigger value="COMPLETED">Ukończone</TabsTrigger>
        </TabsList>
        <TabsContent value={tab} className="mt-0 outline-none">
          {filteredProjects.length === 0 ? (
            <div className="flex flex-col items-center justify-center min-h-[240px] border border-dashed border-border rounded-xl text-center gap-4">
              <p className="text-muted-foreground">
                {tab === 'IN_PROGRESS' ? 'Brak projektów w trakcie.' : 'Brak ukończonych projektów.'}
              </p>
              {tab === 'IN_PROGRESS' && (
                <Button variant="outline" onClick={onCreate}>
                  Utwórz nowe zadanie
                </Button>
              )}
            </div>
          ) : (
            <div className="rounded-xl border border-border overflow-hidden">
              {/* Table Header */}
              <div className="grid grid-cols-[150px_1fr_190px_330px_52px] bg-muted/50 border-b border-border">
                <div className="px-4 py-3 text-xs font-semibold uppercase tracking-wider text-muted-foreground">
                  Definicja
                </div>
                <div className="px-4 py-3 text-xs font-semibold uppercase tracking-wider text-muted-foreground">
                  Nazwa projektu
                </div>
                <div className="px-4 py-3 text-xs font-semibold uppercase tracking-wider text-muted-foreground">
                  Postep
                </div>
                <div className="px-4 py-3 text-xs font-semibold uppercase tracking-wider text-muted-foreground">
                  Wejscie
                </div>
                <div />
              </div>

              {/* Table Rows */}
              {filteredProjects.map((project, idx) => {
                const isComplete = project.status === 'Kompletne';
                const progressPercentage = project.progressTotal > 0
                  ? Math.round((project.progressDone / project.progressTotal) * 100)
                  : 0;
                const isLast = idx === filteredProjects.length - 1;

                return (
                  <div
                    key={project.id}
                    className={`grid grid-cols-[150px_1fr_190px_330px_52px] items-center transition-colors hover:bg-primary/5 ${
                      !isLast ? 'border-b border-border' : ''
                    } ${isComplete ? 'bg-green-500/5' : ''}`}
                  >
                    {/* Column A: Definition */}
                    <div className="px-4 py-4">
                      {project.projectDefinition ? (
                        <span className="text-xs font-mono font-semibold text-primary bg-primary/10 rounded px-2 py-1 whitespace-nowrap">
                          {project.projectDefinition}
                        </span>
                      ) : (
                        <span className="text-xs text-muted-foreground italic">—</span>
                      )}
                    </div>

                    {/* Column B: Name */}
                    <div className="px-4 py-4 flex items-center gap-2 min-w-0">
                      {isComplete && <CheckCheck className="text-green-500 shrink-0" size={16} />}
                      <span className="font-medium text-sm truncate">{project.name}</span>
                    </div>

                    {/* Column C: Progress */}
                    <div className="px-4 py-4 flex items-center gap-3">
                      <div className="flex-1 flex flex-col gap-1">
                        <Progress
                          value={progressPercentage}
                          className={`h-2 ${isComplete ? 'bg-green-500/20' : ''}`}
                        />
                        <span className="text-xs text-muted-foreground">
                          {project.progressDone} / {project.progressTotal} ({progressPercentage}%)
                        </span>
                      </div>
                      <Badge
                        variant={isComplete ? 'default' : 'secondary'}
                        className={`shrink-0 text-xs ${isComplete ? 'bg-green-600 hover:bg-green-700' : ''}`}
                      >
                        {isComplete ? 'Gotowe' : 'W trakcie'}
                      </Badge>
                    </div>

                    <div className="flex items-center gap-2 px-4 py-4">
                      {getProjectEntryActions(project.id).map((action) => (
                        <Button
                          key={action.key}
                          variant={action.key === 'map' ? 'default' : 'outline'}
                          size="sm"
                          title={action.label}
                          onClick={() => handleProjectAction(project.id, action.key)}
                        >
                          {getActionIcon(action.key)}
                          {action.label}
                        </Button>
                      ))}
                    </div>

                    <div className="flex items-center justify-end gap-1 pr-2">
                      <Button
                        variant="ghost"
                        size="icon"
                        disabled={deletingProjectId === project.id}
                        className="h-8 w-8 text-muted-foreground hover:text-destructive"
                        title="Usun projekt z aplikacji"
                        onClick={(event) => {
                          event.stopPropagation();
                          void handleDelete(project);
                        }}
                      >
                        <Trash2 size={15} />
                      </Button>
                    </div>
                  </div>
                );
              })}
            </div>
          )}
        </TabsContent>
      </Tabs>
    </section>
  );
}
