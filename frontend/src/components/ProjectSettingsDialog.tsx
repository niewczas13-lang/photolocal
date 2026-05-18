import { useEffect, useState } from 'react';
import { RefreshCw } from 'lucide-react';

import { api } from '../api';
import type { ProjectSummary } from '../types';
import { Button } from './ui/button';
import { Card, CardContent } from './ui/card';
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogHeader,
  DialogTitle,
} from './ui/dialog';
import { Input } from './ui/input';

interface ProjectSettingsDialogProps {
  project: ProjectSummary | null;
  open: boolean;
  onOpenChange: (open: boolean) => void;
  onProjectUpdated: (project: ProjectSummary) => void;
  onRecalculated?: () => void | Promise<void>;
}

function getErrorMessage(error: unknown): string {
  return error instanceof Error ? error.message : 'Nieznany blad';
}

export default function ProjectSettingsDialog({
  project,
  open,
  onOpenChange,
  onProjectUpdated,
  onRecalculated,
}: ProjectSettingsDialogProps) {
  const [draftName, setDraftName] = useState(project?.name ?? '');
  const [savingName, setSavingName] = useState(false);
  const [recalculateFile, setRecalculateFile] = useState<File | null>(null);
  const [recalculateTopology, setRecalculateTopology] = useState<'AUTO' | 'SINGLE' | 'CASCADE'>('AUTO');
  const [recalculating, setRecalculating] = useState(false);
  const [recalculateResult, setRecalculateResult] = useState<string | null>(null);

  useEffect(() => {
    if (!project) return;
    setDraftName(project.name);
    setRecalculateTopology(project.splitterTopologySource === 'MANUAL' ? project.splitterTopology : 'AUTO');
    setRecalculateFile(null);
    setRecalculateResult(null);
  }, [project]);

  if (!project) return null;

  const handleRename = async () => {
    if (!draftName.trim() || draftName.trim() === project.name) return;

    setSavingName(true);
    try {
      const updatedProject = await api.renameProject(project.id, draftName.trim());
      onProjectUpdated(updatedProject);
    } catch (error) {
      console.error(error);
      alert(`Blad podczas zmiany nazwy:\n${getErrorMessage(error)}`);
    } finally {
      setSavingName(false);
    }
  };

  const handleRecalculateChecklist = async () => {
    if (!recalculateFile) return;

    setRecalculating(true);
    setRecalculateResult(null);
    try {
      const result = await api.recalculateChecklist(
        project.id,
        recalculateFile,
        project.projectType,
        recalculateTopology,
      );
      onProjectUpdated(result.project);
      await onRecalculated?.();
      setRecalculateResult(
        `Gotowe: dodano ${result.addedNodes}, zaktualizowano ${result.updatedNodes}, usunieto stare ${result.removedStaleNodes}.`,
      );
      setRecalculateFile(null);
    } catch (error) {
      console.error(error);
      alert(`Blad podczas przeliczania checklisty:\n${getErrorMessage(error)}`);
    } finally {
      setRecalculating(false);
    }
  };

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent className="max-h-[90vh] gap-5 overflow-y-auto sm:max-w-3xl">
        <DialogHeader>
          <DialogTitle>Ustawienia projektu</DialogTitle>
          <DialogDescription>
            Osobne okno do edycji projektu, bez przechodzenia do modulu zdjec.
          </DialogDescription>
        </DialogHeader>

        <div className="flex flex-col gap-4">
          <Card>
            <CardContent className="p-4 flex flex-col gap-4">
              <div>
                <h4 className="font-semibold">Nazwa projektu</h4>
                <p className="text-sm text-muted-foreground">
                  Ta nazwa jest widoczna na liscie projektow i w naglowku zadania.
                </p>
              </div>
              <div className="flex flex-col gap-3 sm:flex-row">
                <Input
                  value={draftName}
                  onChange={(event) => setDraftName(event.target.value)}
                  onKeyDown={(event) => {
                    if (event.key === 'Enter') void handleRename();
                  }}
                  placeholder="Nazwa projektu"
                />
                <Button
                  onClick={handleRename}
                  disabled={savingName || !draftName.trim() || draftName.trim() === project.name}
                  className="sm:w-36"
                >
                  {savingName ? 'Zapisuje...' : 'Zapisz nazwe'}
                </Button>
              </div>
            </CardContent>
          </Card>

          <Card>
            <CardContent className="grid grid-cols-1 gap-4 p-4 text-sm md:grid-cols-2">
              <div>
                <p className="text-muted-foreground">Typ projektu</p>
                <p className="font-medium">{project.projectType}</p>
              </div>
              <div>
                <p className="text-muted-foreground">Topologia splitterow</p>
                <p className="font-medium">
                  {project.splitterTopology} ({project.splitterTopologySource})
                </p>
              </div>
              <div>
                <p className="text-muted-foreground">GPKG</p>
                <p className="font-medium">{project.gpkgFileName}</p>
              </div>
              <div>
                <p className="text-muted-foreground">Adresy / zapasy</p>
                <p className="font-medium">
                  {project.addressCount} adresow, {project.dacToAddressCableCount} doziemnych,{' '}
                  {project.adssToAddressCableCount} napowietrznych
                </p>
              </div>
              <div className="md:col-span-2">
                <p className="text-muted-foreground">Folder zdjec</p>
                <p className="break-all font-medium">{project.baseFolder}</p>
              </div>
            </CardContent>
          </Card>

          <Card>
            <CardContent className="flex flex-col gap-4 p-4">
              <div className="flex items-start justify-between gap-4">
                <div>
                  <h4 className="font-semibold">Przelicz checkliste z GPKG</h4>
                  <p className="text-sm text-muted-foreground">
                    Operacja dopisuje nowe punkty, odswieza istniejace po sciezce i usuwa stare punkty
                    bez zdjec. Punkty ze zdjeciami zostaja zachowane jako nie dotyczy.
                  </p>
                </div>
                <RefreshCw size={18} className="mt-1 shrink-0 text-muted-foreground" />
              </div>

              <div className="grid grid-cols-1 gap-3 md:grid-cols-[1fr_220px]">
                <Input
                  type="file"
                  accept=".gpkg"
                  onChange={(event) => setRecalculateFile(event.target.files?.[0] ?? null)}
                />
                <select
                  value={recalculateTopology}
                  onChange={(event) =>
                    setRecalculateTopology(event.target.value as 'AUTO' | 'SINGLE' | 'CASCADE')
                  }
                  className="h-10 rounded-md border border-input bg-background px-3 text-sm"
                >
                  <option value="AUTO">Topologia: auto</option>
                  <option value="SINGLE">Topologia: SINGLE</option>
                  <option value="CASCADE">Topologia: CASCADE</option>
                </select>
              </div>

              <div className="flex items-center justify-between gap-3">
                <p className="text-sm text-muted-foreground">
                  {recalculateFile ? recalculateFile.name : 'Wybierz plik GPKG do przeliczenia.'}
                </p>
                <Button onClick={handleRecalculateChecklist} disabled={!recalculateFile || recalculating}>
                  {recalculating ? 'Przeliczam...' : 'Przelicz checkliste'}
                </Button>
              </div>

              {recalculateResult && (
                <div className="rounded-md border border-green-200 bg-green-50 px-3 py-2 text-sm text-green-800">
                  {recalculateResult}
                </div>
              )}
            </CardContent>
          </Card>
        </div>
      </DialogContent>
    </Dialog>
  );
}
