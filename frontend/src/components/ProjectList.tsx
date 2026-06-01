import { useMemo, useState } from 'react';
import { Camera, CheckCheck, FolderPlus, Map as MapIcon, Search, Settings, Trash2 } from 'lucide-react';

import { api } from '../api';
import { getProjectEntryActions, type ProjectEntryActionKey } from '../project-entry-actions';
import type { ProjectSummary } from '../types';
import { Tabs, TabsContent, TabsList, TabsTrigger } from './ui/tabs';
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
  const tableGridClass =
    'grid grid-cols-[minmax(130px,160px)_minmax(420px,2fr)_minmax(180px,220px)_minmax(300px,340px)_52px]';

  const projectStats = useMemo(() => {
    const inProgress = projects.filter((project) => project.status !== 'Kompletne').length;
    const completed = projects.length - inProgress;
    const progressDone = projects.reduce((sum, project) => sum + project.progressDone, 0);
    const progressTotal = projects.reduce((sum, project) => sum + project.progressTotal, 0);
    const addressCount = projects.reduce((sum, project) => sum + project.addressCount, 0);

    return { inProgress, completed, progressDone, progressTotal, addressCount };
  }, [projects]);

  const filteredProjects = useMemo(() => {
    const query = searchQuery.trim().toLowerCase();
    return projects.filter((project) => {
      const matchesTab = tab === 'IN_PROGRESS' ? project.status !== 'Kompletne' : project.status === 'Kompletne';
      if (!matchesTab) return false;
      if (!query) return true;

      return [
        project.projectDefinition,
        project.name,
        project.gpkgFileName,
        project.googleChatSpaceDisplayName,
      ]
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
    <section className="container mx-auto max-w-[1480px] p-6">
      <div className="mb-6 flex flex-col gap-4 md:flex-row md:items-end md:justify-between">
        <div>
          <h2 className="text-3xl font-bold tracking-tight text-foreground">Lista zlecen</h2>
          <p className="mt-1 text-muted-foreground">Wybierz tryb pracy dla projektu</p>
        </div>
        <Button onClick={onCreate} className="gap-2 font-semibold">
          <FolderPlus size={18} />
          Utworz zadanie
        </Button>
      </div>

      <div className="mb-4 grid grid-cols-1 gap-3 md:grid-cols-4">
        <div className="rounded-lg border border-border bg-card px-4 py-3">
          <div className="text-[11px] font-semibold uppercase tracking-wider text-muted-foreground">Aktywne</div>
          <div className="mt-1 text-2xl font-bold tracking-tight">{projectStats.inProgress}</div>
        </div>
        <div className="rounded-lg border border-border bg-card px-4 py-3">
          <div className="text-[11px] font-semibold uppercase tracking-wider text-muted-foreground">Ukonczone</div>
          <div className="mt-1 text-2xl font-bold tracking-tight">{projectStats.completed}</div>
        </div>
        <div className="rounded-lg border border-border bg-card px-4 py-3">
          <div className="text-[11px] font-semibold uppercase tracking-wider text-muted-foreground">Punkty adresowe</div>
          <div className="mt-1 text-2xl font-bold tracking-tight">{projectStats.addressCount}</div>
        </div>
        <div className="rounded-lg border border-border bg-card px-4 py-3">
          <div className="text-[11px] font-semibold uppercase tracking-wider text-muted-foreground">
            Zdjecia / checklisty
          </div>
          <div className="mt-1 text-2xl font-bold tracking-tight">
            {projectStats.progressDone} / {projectStats.progressTotal}
          </div>
        </div>
      </div>

      <div className="mb-5 rounded-xl border border-border bg-card p-3 shadow-sm">
        <div className="relative w-full">
          <Search size={16} className="absolute left-3 top-1/2 -translate-y-1/2 text-muted-foreground" />
          <input
            value={searchQuery}
            onChange={(event) => setSearchQuery(event.target.value)}
            placeholder="Szukaj po definicji projektu, nazwie, pokoju albo pliku GPKG"
            className="h-10 w-full rounded-lg border border-input bg-background pl-9 pr-3 text-sm outline-none transition-colors placeholder:text-muted-foreground focus-visible:border-ring focus-visible:ring-3 focus-visible:ring-ring/50"
          />
        </div>
      </div>

      <Tabs defaultValue="IN_PROGRESS" value={tab} onValueChange={(value) => setTab(value as typeof tab)} className="w-full">
        <TabsList className="mb-6">
          <TabsTrigger value="IN_PROGRESS" className="gap-2">
            W trakcie <span className="text-xs text-muted-foreground">{projectStats.inProgress}</span>
          </TabsTrigger>
          <TabsTrigger value="COMPLETED" className="gap-2">
            Ukonczone <span className="text-xs text-muted-foreground">{projectStats.completed}</span>
          </TabsTrigger>
        </TabsList>

        <TabsContent value={tab} className="mt-0 outline-none">
          {filteredProjects.length === 0 ? (
            <div className="flex min-h-[240px] flex-col items-center justify-center gap-4 rounded-xl border border-dashed border-border text-center">
              <p className="text-muted-foreground">
                {tab === 'IN_PROGRESS' ? 'Brak projektow w trakcie.' : 'Brak ukonczonych projektow.'}
              </p>
              {tab === 'IN_PROGRESS' && (
                <Button variant="outline" onClick={onCreate}>
                  Utworz nowe zadanie
                </Button>
              )}
            </div>
          ) : (
            <div className="overflow-hidden rounded-xl border border-border bg-card shadow-sm">
              <div className="overflow-x-auto">
                <div className="min-w-[1180px]">
                  <div className={`${tableGridClass} border-b border-border bg-muted/50`}>
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

                  {filteredProjects.map((project, index) => {
                    const isComplete = project.status === 'Kompletne';
                    const progressPercentage =
                      project.progressTotal > 0 ? Math.round((project.progressDone / project.progressTotal) * 100) : 0;
                    const isLast = index === filteredProjects.length - 1;

                    return (
                      <div
                        key={project.id}
                        className={`${tableGridClass} items-center transition-colors hover:bg-primary/5 ${
                          !isLast ? 'border-b border-border' : ''
                        } ${isComplete ? 'bg-green-500/5' : ''}`}
                      >
                        <div className="px-4 py-4">
                          {project.projectDefinition ? (
                            <span className="whitespace-nowrap rounded bg-primary/10 px-2 py-1 font-mono text-xs font-semibold text-primary">
                              {project.projectDefinition}
                            </span>
                          ) : (
                            <span className="text-xs italic text-muted-foreground">-</span>
                          )}
                        </div>

                        <div className="flex min-w-0 items-start gap-2 px-4 py-4">
                          {isComplete && <CheckCheck className="mt-0.5 shrink-0 text-green-500" size={16} />}
                          <div className="min-w-0">
                            <span className="block break-words text-sm font-semibold leading-5 text-foreground">
                              {project.name}
                            </span>
                            <div className="mt-1 flex flex-wrap gap-x-3 gap-y-1 text-[11px] leading-4 text-muted-foreground">
                              <span className="max-w-[320px] truncate" title={project.gpkgFileName}>
                                GPKG: {project.gpkgFileName}
                              </span>
                              {project.googleChatSpaceDisplayName && (
                                <span className="max-w-[260px] truncate" title={project.googleChatSpaceDisplayName}>
                                  Chat: {project.googleChatSpaceDisplayName}
                                </span>
                              )}
                            </div>
                          </div>
                        </div>

                        <div className="flex items-center gap-3 px-4 py-4">
                          <div className="flex flex-1 flex-col gap-1">
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
              </div>
            </div>
          )}
        </TabsContent>
      </Tabs>
    </section>
  );
}
