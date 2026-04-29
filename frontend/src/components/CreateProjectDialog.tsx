import { useState } from 'react';
import { api } from '../api';
import {
  Dialog,
  DialogContent,
  DialogHeader,
  DialogTitle,
  DialogFooter,
} from './ui/dialog';
import { Button } from './ui/button';
import { Input } from './ui/input';
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from './ui/select';
import { FolderOpen, Loader2 } from 'lucide-react';

interface CreateProjectDialogProps {
  open: boolean;
  onClose: () => void;
  onCreated: (project: any) => void;
}

export default function CreateProjectDialog({ open, onClose, onCreated }: CreateProjectDialogProps) {
  const [file, setFile] = useState<File | null>(null);
  const [projectType, setProjectType] = useState('SI');
  const [splitterTopology, setSplitterTopology] = useState('AUTO');
  const [photoRootPath, setPhotoRootPath] = useState('');
  const [pickingFolder, setPickingFolder] = useState(false);
  const [loading, setLoading] = useState(false);

  const handleSubmit = async (event: React.FormEvent) => {
    event.preventDefault();
    if (!file) return;

    setLoading(true);
    try {
      const project = await api.createProject(file, projectType, splitterTopology, photoRootPath);
      onCreated(project);
      onClose();
    } catch (err) {
      console.error(err);
      alert('Blad podczas tworzenia projektu');
    } finally {
      setLoading(false);
    }
  };

  const handlePickFolder = async () => {
    setPickingFolder(true);
    try {
      const result = await api.pickFolder(photoRootPath);
      if (result.path) {
        setPhotoRootPath(result.path);
      }
    } catch (err) {
      console.error(err);
      alert('Nie udalo sie otworzyc windowsowego wybierania folderu');
    } finally {
      setPickingFolder(false);
    }
  };

  // Reset form when closed
  const handleOpenChange = (isOpen: boolean) => {
    if (!isOpen) {
      setFile(null);
      setPhotoRootPath('');
      onClose();
    }
  };

  return (
    <Dialog open={open} onOpenChange={handleOpenChange}>
      <DialogContent className="sm:max-w-[425px]">
        <form onSubmit={handleSubmit}>
          <DialogHeader>
            <DialogTitle className="text-xl">Utwórz zadanie</DialogTitle>
          </DialogHeader>
          
          <div className="grid gap-6 py-6">
            <div className="grid gap-2">
              <label htmlFor="gpkg" className="text-sm font-medium leading-none peer-disabled:cursor-not-allowed peer-disabled:opacity-70">Plik GPKG</label>
              <Input
                id="gpkg"
                type="file"
                accept=".gpkg"
                onChange={(event) => setFile(event.target.files?.[0] || null)}
                required
                className="cursor-pointer file:text-primary file:font-semibold"
              />
            </div>

            <div className="grid gap-2">
              <label htmlFor="photoRootPath" className="text-sm font-medium leading-none">
                Folder zadania
              </label>
              <div className="grid grid-cols-[1fr_auto] gap-2">
                <Input
                  id="photoRootPath"
                  value={photoRootPath}
                  onChange={(event) => setPhotoRootPath(event.target.value)}
                  placeholder="D:\projekty\opp13\pw\sap"
                  required
                />
                <Button type="button" variant="outline" onClick={handlePickFolder} disabled={pickingFolder}>
                  {pickingFolder ? (
                    <Loader2 size={16} className="mr-2 animate-spin" />
                  ) : (
                    <FolderOpen size={16} className="mr-2" />
                  )}
                  {pickingFolder ? 'Wybieranie...' : 'Wybierz'}
                </Button>
              </div>
              <p className="text-xs text-muted-foreground">
                Aplikacja utworzy w nim folder zdjecia i zapisze tam cala strukture zdjec.
              </p>
            </div>
            
            <div className="grid gap-2">
              <label className="text-sm font-medium leading-none">Typ projektu</label>
              <Select value={projectType} onValueChange={(val) => setProjectType(val as string)}>
                <SelectTrigger>
                  <SelectValue />
                </SelectTrigger>
                <SelectContent>
                  <SelectItem value="SI">SI</SelectItem>
                  <SelectItem value="KPO">KPO</SelectItem>
                </SelectContent>
              </Select>
            </div>
            
            <div className="grid gap-2">
              <label className="text-sm font-medium leading-none">Topologia spliterów</label>
              <Select value={splitterTopology} onValueChange={(val) => setSplitterTopology(val as string)}>
                <SelectTrigger>
                  <SelectValue />
                </SelectTrigger>
                <SelectContent>
                  <SelectItem value="AUTO">Wykryj z GPKG</SelectItem>
                  <SelectItem value="SINGLE">1 spliter (Pojedynczy)</SelectItem>
                  <SelectItem value="CASCADE">Kaskada (Wiele spliterów)</SelectItem>
                </SelectContent>
              </Select>
            </div>
          </div>
          
          <DialogFooter>
            <Button type="button" variant="outline" onClick={onClose} disabled={loading}>
              Anuluj
            </Button>
            <Button type="submit" disabled={!file || !photoRootPath.trim() || loading} className="min-w-24">
              {loading ? (
                <>
                  <Loader2 className="mr-2 h-4 w-4 animate-spin" />
                  Tworzenie...
                </>
              ) : (
                'Utwórz'
              )}
            </Button>
          </DialogFooter>
        </form>
      </DialogContent>
    </Dialog>
  );
}
