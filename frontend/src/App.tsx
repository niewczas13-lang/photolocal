import { useEffect, useState } from 'react';
import { api } from './api';
import {
  mapProjectRoute,
  parseRouteFromHash,
  photoProjectRoute,
  projectListRoute,
} from './app-routing';
import CreateProjectDialog from './components/CreateProjectDialog';
import MapWorkspace from './components/MapWorkspace';
import ProjectList from './components/ProjectList';
import ProjectSettingsDialog from './components/ProjectSettingsDialog';
import ProjectView from './components/ProjectView';
import type { ProjectSummary } from './types';
import { SmilePlus } from 'lucide-react';

export default function App() {
  const [projects, setProjects] = useState<ProjectSummary[]>([]);
  const [creating, setCreating] = useState(false);
  const [settingsProjectId, setSettingsProjectId] = useState<string | null>(null);
  const [route, setRoute] = useState(() => parseRouteFromHash(window.location.hash));

  useEffect(() => {
    void api.listProjects().then(setProjects);
  }, []);

  useEffect(() => {
    const handleHashChange = () => setRoute(parseRouteFromHash(window.location.hash));
    window.addEventListener('hashchange', handleHashChange);
    return () => window.removeEventListener('hashchange', handleHashChange);
  }, []);

  const selectedProjectId = route.projectId;
  const selectedProject = selectedProjectId ? projects.find((project) => project.id === selectedProjectId) : null;
  const settingsProject = settingsProjectId ? projects.find((project) => project.id === settingsProjectId) ?? null : null;
  const isMapMode = route.mode === 'map';
  const mapView = route.mode === 'map' ? route.view : 'map';
  const updateProject = (updatedProject: ProjectSummary) => {
    setProjects((current) =>
      current.map((project) => (project.id === updatedProject.id ? updatedProject : project)),
    );
  };

  return (
    <main className="min-h-screen bg-background text-foreground flex flex-col font-sans selection:bg-primary/20">
      {/* Global Topbar */}
      <header className="h-16 shrink-0 border-b border-border bg-background/80 backdrop-blur-xl sticky top-0 z-50 flex items-center px-6 shadow-sm">
        <button
          type="button"
          onClick={() => {
            window.location.hash = projectListRoute();
          }}
          className="flex items-center gap-3 rounded-lg focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring"
          title="BOT ROMAN"
        >
          <div className="bg-primary/10 p-2 rounded-lg text-primary">
            <SmilePlus size={22} strokeWidth={2.5} />
          </div>
          <div className="flex items-baseline gap-3">
            <h1 className="text-xl font-bold tracking-tight">BOT ROMAN</h1>
            {selectedProject && (
              <span className="text-sm text-muted-foreground">
                {isMapMode ? (mapView === 'tasks' ? 'Lista zadan' : 'Mapa + zadania') : 'Zdjecia'}
              </span>
            )}
          </div>
        </button>
      </header>

      {/* Main View Area */}
      <div className="flex-1 flex flex-col">
        {route.mode === 'map' ? (
          <MapWorkspace
            projects={projects}
            selectedProjectId={selectedProjectId}
            mapView={mapView}
            onSelectProject={(projectId) => {
              window.location.hash = mapProjectRoute(projectId, mapView);
            }}
            onMapViewChange={(view) => {
              window.location.hash = mapProjectRoute(selectedProjectId, view);
            }}
            onOpenPhotos={(projectId) => {
              window.location.hash = photoProjectRoute(projectId);
            }}
            onOpenSettings={(projectId) => {
              setSettingsProjectId(projectId);
            }}
          />
        ) : selectedProjectId && selectedProject ? (
          <ProjectView 
            project={selectedProject}
            initialTab={route.tab}
            onBack={() => {
              window.location.hash = projectListRoute();
              void api.listProjects().then(setProjects);
            }} 
            onTabChange={(tab) => {
              window.location.hash = photoProjectRoute(selectedProjectId, tab);
            }}
            onOpenMap={() => {
              window.location.hash = mapProjectRoute(selectedProjectId);
            }}
            onOpenSettings={() => {
              setSettingsProjectId(selectedProjectId);
            }}
            onRename={(newName) => {
              setProjects(projects.map(p => p.id === selectedProjectId ? { ...p, name: newName } : p));
            }}
            onProjectUpdated={(updatedProject) => {
              updateProject(updatedProject);
            }}
          />
        ) : (
          <ProjectList
            projects={projects}
            onCreate={() => setCreating(true)}
            onOpenPhotos={(projectId) => {
              window.location.hash = photoProjectRoute(projectId);
            }}
            onOpenMap={(projectId) => {
              window.location.hash = mapProjectRoute(projectId);
            }}
            onOpenSettings={(projectId) => {
              setSettingsProjectId(projectId);
            }}
            onDeleted={(projectId) => setProjects(projects.filter((project) => project.id !== projectId))}
          />
        )}
      </div>

      {!isMapMode && (
        <CreateProjectDialog
          open={creating}
          onClose={() => setCreating(false)}
          onCreated={(newProject) => setProjects([newProject, ...projects])}
        />
      )}

      <ProjectSettingsDialog
        open={Boolean(settingsProject)}
        project={settingsProject}
        onOpenChange={(open) => {
          if (!open) setSettingsProjectId(null);
        }}
        onProjectUpdated={updateProject}
        onRecalculated={async () => {
          const nextProjects = await api.listProjects();
          setProjects(nextProjects);
        }}
      />
    </main>
  );
}
