import { useEffect, useMemo, useState } from 'react';
import { ImagePlus, LocateFixed, MapPin, Save, StickyNote, Trash2 } from 'lucide-react';

import type { ProjectMapNote } from '../types';
import { getMapNoteFocusPosition } from '../map-note-focus';
import { Badge } from './ui/badge';
import { Button } from './ui/button';

interface ProjectMapNotesProps {
  notes: ProjectMapNote[];
  busyId: string | null;
  onUpdateNote: (noteId: string, body: string, lat: number | null, lng: number | null) => void;
  onDeleteNote: (noteId: string) => void;
  onUploadNotePhoto: (noteId: string, file: File) => void;
  onShowOnMap: (note: ProjectMapNote) => void;
}

function noteTargetLabel(note: ProjectMapNote): string {
  if (note.targetLabel) return note.targetLabel;
  if (note.targetType === 'free') return 'Punkt na mapie';
  if (note.targetType === 'cable') return 'Kabel';
  if (note.targetType === 'node') return 'Punkt';
  if (note.targetType === 'address') return 'Adres';
  return 'Obszar';
}

function noteKindLabel(note: ProjectMapNote): string {
  if (note.targetType === 'free') return 'Mapa';
  if (note.targetType === 'cable') return 'Kabel';
  if (note.targetType === 'node') return 'Punkt';
  if (note.targetType === 'address') return 'Adres';
  return 'Obszar';
}

function MapNotePhotoInput({
  noteId,
  disabled,
  onUpload,
}: {
  noteId: string;
  disabled: boolean;
  onUpload: (noteId: string, file: File) => void;
}) {
  return (
    <label className={`project-map-note-upload ${disabled ? 'project-map-note-upload--disabled' : ''}`}>
      <ImagePlus size={14} />
      Zdjecie
      <input
        type="file"
        accept="image/*"
        disabled={disabled}
        onChange={(event) => {
          const file = event.currentTarget.files?.[0];
          if (file) onUpload(noteId, file);
          event.currentTarget.value = '';
        }}
      />
    </label>
  );
}

function ProjectMapNoteCard({
  note,
  busy,
  onUpdateNote,
  onDeleteNote,
  onUploadNotePhoto,
  onShowOnMap,
}: {
  note: ProjectMapNote;
  busy: boolean;
  onUpdateNote: ProjectMapNotesProps['onUpdateNote'];
  onDeleteNote: ProjectMapNotesProps['onDeleteNote'];
  onUploadNotePhoto: ProjectMapNotesProps['onUploadNotePhoto'];
  onShowOnMap: ProjectMapNotesProps['onShowOnMap'];
}) {
  const [body, setBody] = useState(note.body);
  const focusPosition = getMapNoteFocusPosition(note);

  useEffect(() => {
    setBody(note.body);
  }, [note.body]);

  return (
    <article className="project-map-note-card">
      <div className="project-map-note-card__header">
        <div className="project-map-note-card__title">
          <StickyNote size={16} />
          <span>{noteTargetLabel(note)}</span>
        </div>
        <Badge variant="outline">{noteKindLabel(note)}</Badge>
      </div>

      <textarea
        className="project-map-note-textarea"
        value={body}
        rows={4}
        onChange={(event) => setBody(event.target.value)}
      />

      <div className="project-map-note-card__meta">
        <span>
          <MapPin size={13} />
          {note.lat == null || note.lng == null ? 'Bez punktu' : `${note.lat.toFixed(6)}, ${note.lng.toFixed(6)}`}
        </span>
        <span>{note.photoCount} zdjec</span>
      </div>

      {note.photos.length > 0 && (
        <div className="project-map-note-card__photos">
          {note.photos.map((photo) => (
            <span key={photo.id}>{photo.storedFileName}</span>
          ))}
        </div>
      )}

      <div className="project-map-note-card__actions">
        <Button
          type="button"
          size="sm"
          onClick={() => onUpdateNote(note.id, body, note.lat, note.lng)}
          disabled={busy || body.trim() === ''}
        >
          <Save size={14} />
          Zapisz
        </Button>
        <MapNotePhotoInput noteId={note.id} disabled={busy} onUpload={onUploadNotePhoto} />
        <Button
          type="button"
          size="sm"
          variant="outline"
          onClick={() => onShowOnMap(note)}
          disabled={busy || !focusPosition}
        >
          <LocateFixed size={14} />
          Pokaz
        </Button>
        <Button
          type="button"
          size="sm"
          variant="outline"
          className="project-map-note-card__delete"
          onClick={() => onDeleteNote(note.id)}
          disabled={busy}
        >
          <Trash2 size={14} />
          Usun
        </Button>
      </div>
    </article>
  );
}

export default function ProjectMapNotes({
  notes,
  busyId,
  onUpdateNote,
  onDeleteNote,
  onUploadNotePhoto,
  onShowOnMap,
}: ProjectMapNotesProps) {
  const sortedNotes = useMemo(
    () =>
      [...notes].sort((a, b) => {
        const updated = b.updatedAt.localeCompare(a.updatedAt);
        if (updated !== 0) return updated;
        return a.id.localeCompare(b.id);
      }),
    [notes],
  );

  return (
    <div className="project-map-notes">
      <div className="project-map-notes__header">
        <div>
          <h2>Notatki z mapy</h2>
          <p>Uwagi przypiete do elementow albo do konkretnego miejsca na mapie.</p>
        </div>
        <Badge variant="outline">{notes.length} notatek</Badge>
      </div>

      <div className="project-map-notes__list">
        {sortedNotes.map((note) => (
          <ProjectMapNoteCard
            key={note.id}
            note={note}
            busy={busyId === note.id}
            onUpdateNote={onUpdateNote}
            onDeleteNote={onDeleteNote}
            onUploadNotePhoto={onUploadNotePhoto}
            onShowOnMap={onShowOnMap}
          />
        ))}

        {sortedNotes.length === 0 && (
          <div className="project-map-notes__empty">
            Brak notatek. Na mapie kliknij "Dodaj notatke" i wskaz miejsce.
          </div>
        )}
      </div>
    </div>
  );
}
