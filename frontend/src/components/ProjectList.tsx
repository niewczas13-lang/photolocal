import { useState, useMemo } from 'react';
import { CheckCheck, FolderPlus, ChevronRight } from 'lucide-react';
import type { ProjectSummary } from '../types';
import { Tabs, TabsList, TabsTrigger, TabsContent } from './ui/tabs';
import { Button } from './ui/button';
import { Badge } from './ui/badge';
import { Progress } from './ui/progress';

interface ProjectListProps {
  projects: ProjectSummary[];
  onCreate: () => void;
  onOpen: (projectId: string) => void;
}

export default function ProjectList({ projects, onCreate, onOpen }: ProjectListProps) {
  const [tab, setTab] = useState<'IN_PROGRESS' | 'COMPLETED'>('IN_PROGRESS');

  const filteredProjects = useMemo(() => {
    return projects.filter((p) => {
      if (tab === 'IN_PROGRESS') return p.status !== 'Kompletne';
      return p.status === 'Kompletne';
    });
  }, [projects, tab]);

  return (
    <section className="container mx-auto p-6 max-w-6xl">
      <div className="flex flex-col md:flex-row items-start md:items-center justify-between mb-8 gap-4">
        <div>
          <h2 className="text-3xl font-bold text-foreground tracking-tight">Projekty</h2>
          <p className="text-muted-foreground mt-1">Wybierz projekt do zarządzania zdjęciami</p>
        </div>
        <Button onClick={onCreate} className="gap-2 font-semibold">
          <FolderPlus size={18} />
          Utwórz zadanie
        </Button>
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
              <div className="grid grid-cols-[160px_1fr_220px_36px] bg-muted/50 border-b border-border">
                <div className="px-4 py-3 text-xs font-semibold uppercase tracking-wider text-muted-foreground">
                  Definicja
                </div>
                <div className="px-4 py-3 text-xs font-semibold uppercase tracking-wider text-muted-foreground">
                  Nazwa projektu
                </div>
                <div className="px-4 py-3 text-xs font-semibold uppercase tracking-wider text-muted-foreground">
                  Stan uzupełnienia zdjęć
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
                    onClick={() => onOpen(project.id)}
                    className={`grid grid-cols-[160px_1fr_220px_36px] items-center cursor-pointer transition-colors hover:bg-primary/5 group ${
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

                    {/* Arrow */}
                    <div className="flex items-center justify-center pr-2">
                      <ChevronRight size={16} className="text-muted-foreground group-hover:text-primary transition-colors" />
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
