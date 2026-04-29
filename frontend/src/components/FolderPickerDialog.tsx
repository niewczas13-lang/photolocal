import { useEffect, useState } from 'react';
import { ChevronLeft, FolderClosed, Loader2 } from 'lucide-react';
import { api } from '../api';
import type { FolderBrowserEntry } from '../types';
import { Button } from './ui/button';
import {
  Dialog,
  DialogContent,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from './ui/dialog';

interface FolderPickerDialogProps {
  open: boolean;
  initialPath: string;
  onClose: () => void;
  onSelect: (path: string) => void;
}

export default function FolderPickerDialog({
  open,
  initialPath,
  onClose,
  onSelect,
}: FolderPickerDialogProps) {
  const [currentPath, setCurrentPath] = useState('');
  const [parentPath, setParentPath] = useState<string | null>(null);
  const [entries, setEntries] = useState<FolderBrowserEntry[]>([]);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const loadFolders = async (path?: string) => {
    setLoading(true);
    setError(null);
    try {
      const result = await api.listFolders(path);
      setCurrentPath(result.currentPath);
      setParentPath(result.parentPath);
      setEntries(result.entries);
    } catch (loadError) {
      console.error(loadError);
      setError(loadError instanceof Error ? loadError.message : 'Nie udalo sie otworzyc folderu');
    } finally {
      setLoading(false);
    }
  };

  useEffect(() => {
    if (open) void loadFolders(initialPath || undefined);
  }, [initialPath, open]);

  return (
    <Dialog open={open} onOpenChange={(isOpen) => !isOpen && onClose()}>
      <DialogContent className="sm:max-w-[640px]">
        <DialogHeader>
          <DialogTitle>Wybierz folder zadania</DialogTitle>
        </DialogHeader>

        <div className="flex flex-col gap-3 py-2">
          <div className="rounded-md border bg-muted/30 px-3 py-2 text-xs font-mono break-all">
            {currentPath || 'Ladowanie...'}
          </div>

          <div className="flex items-center gap-2">
            <Button
              type="button"
              variant="outline"
              size="sm"
              disabled={!parentPath || loading}
              onClick={() => parentPath && void loadFolders(parentPath)}
            >
              <ChevronLeft size={16} className="mr-2" />
              Poziom wyzej
            </Button>
            {loading && <Loader2 size={16} className="animate-spin text-muted-foreground" />}
          </div>

          {error && <p className="text-sm text-destructive">{error}</p>}

          <div className="max-h-80 overflow-auto rounded-md border">
            {entries.length === 0 && !loading ? (
              <div className="p-4 text-sm text-muted-foreground">Brak podfolderow.</div>
            ) : (
              entries.map((entry) => (
                <button
                  key={entry.path}
                  type="button"
                  className="flex w-full items-center gap-2 border-b border-border/50 px-3 py-2 text-left text-sm hover:bg-muted/50"
                  onClick={() => void loadFolders(entry.path)}
                >
                  <FolderClosed size={16} className="text-muted-foreground" />
                  <span className="truncate">{entry.name}</span>
                </button>
              ))
            )}
          </div>
        </div>

        <DialogFooter>
          <Button type="button" variant="outline" onClick={onClose}>
            Anuluj
          </Button>
          <Button
            type="button"
            disabled={!currentPath}
            onClick={() => {
              onSelect(currentPath);
              onClose();
            }}
          >
            Wybierz ten folder
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}
