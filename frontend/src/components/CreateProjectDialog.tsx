import { useEffect, useState } from 'react';
import { api } from '../api';
import type { SharedFolderEntry, SharedFolderRoot } from '../types';
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
import { ArrowUp, FolderOpen, HardDrive, Loader2, Plus } from 'lucide-react';

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
  const [sharedRoots, setSharedRoots] = useState<SharedFolderRoot[]>([]);
  const [sharedEntries, setSharedEntries] = useState<SharedFolderEntry[]>([]);
  const [browserPath, setBrowserPath] = useState('');
  const [browserParentPath, setBrowserParentPath] = useState<string | null>(null);
  const [newFolderName, setNewFolderName] = useState('');
  const [loadingSharedFolders, setLoadingSharedFolders] = useState(false);
  const [creatingFolder, setCreatingFolder] = useState(false);
  const [loading, setLoading] = useState(false);

  useEffect(() => {
    if (!open) return;

    api
      .listSharedFolderRoots()
      .then((result) => setSharedRoots(result.roots))
      .catch((error) => {
        console.error(error);
        setSharedRoots([]);
      });
  }, [open]);

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

  const openSharedFolder = async (path: string) => {
    setLoadingSharedFolders(true);
    try {
      const result = await api.listSharedFolderChildren(path);
      setBrowserPath(result.currentPath);
      setBrowserParentPath(result.parentPath);
      setSharedEntries(result.entries);
    } catch (err) {
      console.error(err);
      alert('Nie udalo sie odczytac folderu z dysku udostepnionego');
    } finally {
      setLoadingSharedFolders(false);
    }
  };

  const createFolder = async () => {
    if (!browserPath || !newFolderName.trim()) return;

    setCreatingFolder(true);
    try {
      const result = await api.createSharedFolder(browserPath, newFolderName.trim());
      setNewFolderName('');
      await openSharedFolder(result.path);
      setPhotoRootPath(result.path);
    } catch (err) {
      console.error(err);
      alert('Nie udalo sie utworzyc folderu na dysku udostepnionym');
    } finally {
      setCreatingFolder(false);
    }
  };

  // Reset form when closed
  const handleOpenChange = (isOpen: boolean) => {
    if (!isOpen) {
      setFile(null);
      setPhotoRootPath('');
      setBrowserPath('');
      setBrowserParentPath(null);
      setSharedEntries([]);
      setNewFolderName('');
      onClose();
    }
  };

  return (
    <Dialog open={open} onOpenChange={handleOpenChange}>
      <DialogContent className="sm:max-w-[640px]">
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
                Folder zapisu zdjec
              </label>
              <Input
                id="photoRootPath"
                value={photoRootPath}
                onChange={(event) => setPhotoRootPath(event.target.value)}
                placeholder="\\KOMPUTER\Udostepnione\OPP0013"
                required
              />
              <div className="rounded-md border bg-background p-2">
                <div className="mb-2 flex items-center justify-between gap-2">
                  <span className="text-xs font-medium text-muted-foreground">Dyski udostepnione widoczne dla backendu</span>
                  {loadingSharedFolders && <Loader2 size={14} className="animate-spin text-muted-foreground" />}
                </div>

                {!browserPath ? (
                  <div className="grid gap-1">
                    {sharedRoots.length > 0 ? (
                      sharedRoots.map((root) => (
                        <button
                          key={root.path}
                          type="button"
                          onClick={() => void openSharedFolder(root.path)}
                          className="flex items-center gap-2 rounded-md px-2 py-1.5 text-left text-sm hover:bg-muted"
                        >
                          <HardDrive size={15} className="text-muted-foreground" />
                          <span className="min-w-0 flex-1 truncate">{root.label}</span>
                          <span className="font-mono text-xs text-muted-foreground">{root.path}</span>
                        </button>
                      ))
                    ) : (
                      <p className="px-2 py-1 text-xs text-muted-foreground">
                        Backend nie widzi zadnego zmapowanego dysku udostepnionego.
                      </p>
                    )}
                  </div>
                ) : (
                  <div className="grid gap-2">
                    <div className="flex items-center gap-2">
                      <Button
                        type="button"
                        size="sm"
                        variant="outline"
                        disabled={!browserParentPath || loadingSharedFolders}
                        onClick={() => browserParentPath && void openSharedFolder(browserParentPath)}
                      >
                        <ArrowUp size={14} className="mr-1" />
                        W gore
                      </Button>
                      <Button type="button" size="sm" onClick={() => setPhotoRootPath(browserPath)}>
                        Uzyj tego folderu
                      </Button>
                    </div>
                    <p className="break-all rounded bg-muted/50 px-2 py-1 font-mono text-xs">{browserPath}</p>
                    <div className="grid grid-cols-[1fr_auto] gap-2">
                      <Input
                        value={newFolderName}
                        onChange={(event) => setNewFolderName(event.target.value)}
                        placeholder="Nazwa nowego folderu"
                        disabled={creatingFolder}
                      />
                      <Button
                        type="button"
                        variant="outline"
                        disabled={!newFolderName.trim() || creatingFolder}
                        onClick={() => void createFolder()}
                      >
                        {creatingFolder ? (
                          <Loader2 size={14} className="mr-1 animate-spin" />
                        ) : (
                          <Plus size={14} className="mr-1" />
                        )}
                        Utworz
                      </Button>
                    </div>
                    <div className="max-h-40 overflow-auto rounded border">
                      {sharedEntries.length > 0 ? (
                        sharedEntries.map((entry) => (
                          <button
                            key={entry.path}
                            type="button"
                            onClick={() => void openSharedFolder(entry.path)}
                            className="flex w-full items-center gap-2 border-b px-2 py-1.5 text-left text-sm last:border-b-0 hover:bg-muted"
                          >
                            <FolderOpen size={15} className="text-muted-foreground" />
                            <span className="truncate">{entry.name}</span>
                          </button>
                        ))
                      ) : (
                        <p className="px-2 py-2 text-xs text-muted-foreground">Brak podfolderow.</p>
                      )}
                    </div>
                  </div>
                )}
              </div>
              <div className="rounded-md bg-muted/40 p-2 text-xs text-muted-foreground">
                <p>
                  Wpisz folder, do ktorego dostep ma komputer z backendem. Moze to byc folder na tym komputerze albo
                  udzial sieciowy z innego komputera.
                </p>
                <p className="mt-1 font-mono text-[11px] text-foreground/80">
                  Przyklady: C:\PhotoLocal\projekty\OPP0013 albo \\KOMPUTER-ANIA\PhotoLocal\OPP0013
                </p>
              </div>
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
