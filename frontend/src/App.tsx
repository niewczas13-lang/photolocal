import { useEffect, useState } from 'react';
import { api } from './api';
import CreateProjectDialog from './components/CreateProjectDialog';
import ProjectList from './components/ProjectList';
import ProjectView from './components/ProjectView';
import type { ProjectSummary } from './types';
import { Camera } from 'lucide-react';

export type ProjectTab = 'photos' | 'missing' | 'import' | 'ready' | 'review' | 'settings';

interface AppRoute {
  projectId: string | null;
  tab: ProjectTab;
}

const DEFAULT_TAB: ProjectTab = 'photos';
const PROJECT_TABS = new Set<ProjectTab>(['photos', 'missing', 'import', 'ready', 'review', 'settings']);

function parseRoute(): AppRoute {
  const hash = window.location.hash.replace(/^#\/?/, '');
  const parts = hash.split('/').filter(Boolean);

  if (parts[0] !== 'projects' || !parts[1]) {
    return { projectId: null, tab: DEFAULT_TAB };
  }

  const tab = PROJECT_TABS.has(parts[2] as ProjectTab) ? (parts[2] as ProjectTab) : DEFAULT_TAB;
  return { projectId: decodeURIComponent(parts[1]), tab };
}

function setProjectRoute(projectId: string | null, tab: ProjectTab = DEFAULT_TAB): void {
  window.location.hash = projectId ? `/projects/${encodeURIComponent(projectId)}/${tab}` : '/';
}

export default function App() {
  const [projects, setProjects] = useState<ProjectSummary[]>([]);
  const [creating, setCreating] = useState(false);
  const [route, setRoute] = useState<AppRoute>(() => parseRoute());

  useEffect(() => {
    void api.listProjects().then(setProjects);
  }, []);

  useEffect(() => {
    const handleHashChange = () => setRoute(parseRoute());
    window.addEventListener('hashchange', handleHashChange);
    return () => window.removeEventListener('hashchange', handleHashChange);
  }, []);

  const selectedProjectId = route.projectId;
  const selectedProject = selectedProjectId ? projects.find((project) => project.id === selectedProjectId) : null;

  return (
    <main className="min-h-screen bg-background text-foreground flex flex-col font-sans selection:bg-primary/20">
      {/* Global Topbar */}
      <header className="h-16 shrink-0 border-b border-border bg-background/80 backdrop-blur-xl sticky top-0 z-50 flex items-center px-6 shadow-sm">
        <div className="flex items-center gap-3">
          <div className="bg-primary/10 p-2 rounded-lg text-primary">
            <Camera size={22} strokeWidth={2.5} />
          </div>
          <h1 className="text-xl font-bold tracking-tight">Photo Local</h1>
        </div>
      </header>

      {/* Main View Area */}
      <div className="flex-1 flex flex-col">
        {selectedProjectId && selectedProject ? (
          <ProjectView 
            project={selectedProject}
            initialTab={route.tab}
            onBack={() => {
              setProjectRoute(null);
              void api.listProjects().then(setProjects);
            }} 
            onTabChange={(tab) => setProjectRoute(selectedProjectId, tab)}
            onRename={(newName) => {
              setProjects(projects.map(p => p.id === selectedProjectId ? { ...p, name: newName } : p));
            }}
            onProjectUpdated={(updatedProject) => {
              setProjects(projects.map(p => p.id === selectedProjectId ? updatedProject : p));
            }}
          />
        ) : (
          <ProjectList
            projects={projects}
            onCreate={() => setCreating(true)}
            onOpen={(projectId) => setProjectRoute(projectId)}
            onDeleted={(projectId) => setProjects(projects.filter((project) => project.id !== projectId))}
          />
        )}
      </div>

      <CreateProjectDialog
        open={creating}
        onClose={() => setCreating(false)}
        onCreated={(newProject) => setProjects([newProject, ...projects])}
      />
    </main>
  );
}
