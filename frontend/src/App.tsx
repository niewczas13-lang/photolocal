import { useEffect, useState } from 'react';
import { api } from './api';
import CreateProjectDialog from './components/CreateProjectDialog';
import ProjectList from './components/ProjectList';
import ProjectView from './components/ProjectView';
import type { ProjectSummary } from './types';
import { Camera } from 'lucide-react';

export default function App() {
  const [projects, setProjects] = useState<ProjectSummary[]>([]);
  const [creating, setCreating] = useState(false);
  const [selectedProjectId, setSelectedProjectId] = useState<string | null>(null);

  useEffect(() => {
    void api.listProjects().then(setProjects);
  }, []);

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
        {selectedProjectId && projects.find(p => p.id === selectedProjectId) ? (
          <ProjectView 
            project={projects.find(p => p.id === selectedProjectId)!} 
            onBack={() => {
              setSelectedProjectId(null);
              void api.listProjects().then(setProjects);
            }} 
            onRename={(newName) => {
              setProjects(projects.map(p => p.id === selectedProjectId ? { ...p, name: newName } : p));
            }}
          />
        ) : (
          <ProjectList projects={projects} onCreate={() => setCreating(true)} onOpen={setSelectedProjectId} />
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
