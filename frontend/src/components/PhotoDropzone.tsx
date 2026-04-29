import { useRef, useState } from 'react';
import { UploadCloud } from 'lucide-react';
import { Button } from './ui/button';

interface PhotoDropzoneProps {
  disabled: boolean;
  onFiles: (files: File[]) => void;
}

export default function PhotoDropzone({ disabled, onFiles }: PhotoDropzoneProps) {
  const inputRef = useRef<HTMLInputElement | null>(null);
  const [dragging, setDragging] = useState(false);

  const acceptFiles = (files: FileList | null) => {
    if (!files || disabled) return;
    onFiles(Array.from(files).filter((file) => file.type.startsWith('image/')));
  };

  return (
    <div
      className={`relative flex flex-col items-center justify-center p-12 mt-2 gap-4 border-2 border-dashed rounded-xl transition-all duration-200
        ${disabled ? 'opacity-50 cursor-not-allowed bg-muted/30 border-muted-foreground/20' : 'cursor-pointer hover:bg-muted/50'} 
        ${dragging ? 'bg-primary/5 border-primary shadow-sm' : 'border-border'}`}
      onDragOver={(event) => {
        event.preventDefault();
        if (!disabled) setDragging(true);
      }}
      onDragLeave={() => setDragging(false)}
      onDrop={(event) => {
        event.preventDefault();
        setDragging(false);
        acceptFiles(event.dataTransfer.files);
      }}
      onClick={() => {
        if (!disabled) inputRef.current?.click();
      }}
    >
      <input
        ref={inputRef}
        hidden
        multiple
        type="file"
        accept="image/*,.heic,.heif"
        onChange={(event) => acceptFiles(event.target.files)}
      />
      
      <div className={`p-4 rounded-full ${dragging ? 'bg-primary/20 text-primary' : 'bg-muted text-muted-foreground'}`}>
        <UploadCloud size={32} />
      </div>
      
      <div className="text-center space-y-1">
        <p className="text-sm font-medium">
          {dragging ? 'Upuść pliki tutaj...' : 'Przeciągnij zdjęcia tutaj lub kliknij, aby wybrać z dysku'}
        </p>
        <p className="text-xs text-muted-foreground">
          Obsługiwane formaty: JPG, PNG, HEIC
        </p>
      </div>

      <Button 
        type="button" 
        variant="secondary" 
        disabled={disabled} 
        onClick={(e) => {
          e.stopPropagation();
          inputRef.current?.click();
        }}
        className="mt-2"
      >
        Wybierz pliki
      </Button>
    </div>
  );
}
