import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import L, { type LatLngExpression, type PathOptions } from 'leaflet';
import { GeoJSON, MapContainer, Marker, Pane, Polyline, Popup, TileLayer, useMap } from 'react-leaflet';
import {
  Cable,
  Circle,
  Home,
  ImagePlus,
  Layers,
  ListChecks,
  Map,
  MapPinPlus,
  MessageSquarePlus,
  RefreshCw,
  Save,
  StickyNote,
  Trash2,
  Triangle,
  X,
} from 'lucide-react';
import type { Feature, GeoJsonObject, Geometry } from 'geojson';

import { api } from '../api';
import { photoProjectRoute, type MapView } from '../app-routing';
import { cn } from '../lib/utils';
import { getMapBoundsPositions } from '../map-bounds';
import { formatCableLength } from '../map-format';
import { getMapNoteFocusPosition, type MapNoteFocusPosition } from '../map-note-focus';
import {
  getMapClickCaptureClassName,
  isMapClickCaptureActive,
  shouldCaptureMapCanvasClick,
} from '../map-interaction-mode';
import {
  INFRASTRUCTURE_MAP_PANE,
  INFRASTRUCTURE_POPUP_PANE,
  INFRASTRUCTURE_PANE_STYLE,
  getInfrastructureLineStyle,
  getInfrastructurePointIconSpec,
} from '../map-infrastructure-style';
import {
  getCableStatusActions,
  getCableStatusLabel,
  getNodeStatusActions,
  STATUS_LABELS,
} from '../map-status-actions';
import {
  getAddressMarkerTone,
  getCableLineStyles,
  getMarkerTone,
  getMarkerToneStyle,
  isCableReady,
  isNodeReady,
  type MarkerTone,
} from '../map-style';
import type {
  ProjectMapAddress,
  ProjectMapAddressCandidate,
  ProjectMapCable,
  ProjectMapCableStatus,
  ProjectMapCandidateReserveLocation,
  ProjectMapData,
  ProjectMapInfraNode,
  ProjectMapInfrastructureFeature,
  ProjectMapNote,
  ProjectMapNoteTargetType,
  ProjectMapNodeStatus,
  ProjectMapPhoto,
  ProjectMapPolygon,
} from '../types';
import { MapStatusActionButton } from './MapStatusControls';
import ProjectMapAddressCandidates from './ProjectMapAddressCandidates';
import ProjectMapNotes from './ProjectMapNotes';
import ProjectMapTasks from './ProjectMapTasks';
import { Badge } from './ui/badge';
import { Button } from './ui/button';

interface ProjectMapProps {
  projectId: string;
  view: MapView;
  onViewChange: (view: MapView) => void;
}

interface CreateMapNoteInput {
  targetType: ProjectMapNoteTargetType;
  targetId: string | null;
  targetLabel: string | null;
  body: string;
  lat: number | null;
  lng: number | null;
}

function getErrorMessage(error: unknown): string {
  return error instanceof Error ? error.message : 'Nieznany blad';
}

function isGeoJsonObject(value: unknown): value is GeoJsonObject {
  return Boolean(value && typeof value === 'object' && 'type' in value);
}

function geometryFromGeojson(value: unknown): Geometry | null {
  if (!isGeoJsonObject(value)) return null;
  if (value.type === 'Feature') return (value as Feature).geometry;
  if (value.type === 'FeatureCollection') return null;
  return value as Geometry;
}

function toLatLng(coordinate: number[]): LatLngExpression | null {
  const [lng, lat] = coordinate;
  if (!Number.isFinite(lat) || !Number.isFinite(lng)) return null;
  return [lat, lng];
}

function linePositions(cable: ProjectMapCable): LatLngExpression[][] {
  const geometry = geometryFromGeojson(cable.geojson);
  if (!geometry) return [];

  if (geometry.type === 'LineString') {
    return [geometry.coordinates.map(toLatLng).filter(Boolean) as LatLngExpression[]];
  }

  if (geometry.type === 'MultiLineString') {
    return geometry.coordinates.map((line) => line.map(toLatLng).filter(Boolean) as LatLngExpression[]);
  }

  return [];
}

function collectGeometryPositions(value: unknown): LatLngExpression[] {
  const geometry = geometryFromGeojson(value);
  if (!geometry) return [];

  if (geometry.type === 'Point') {
    const point = toLatLng(geometry.coordinates);
    return point ? [point] : [];
  }

  if (geometry.type === 'LineString' || geometry.type === 'MultiPoint') {
    return geometry.coordinates.map(toLatLng).filter(Boolean) as LatLngExpression[];
  }

  if (geometry.type === 'MultiLineString' || geometry.type === 'Polygon') {
    return geometry.coordinates.flatMap((line) => line.map(toLatLng).filter(Boolean) as LatLngExpression[]);
  }

  if (geometry.type === 'MultiPolygon') {
    return geometry.coordinates.flatMap((polygon) =>
      polygon.flatMap((line) => line.map(toLatLng).filter(Boolean) as LatLngExpression[]),
    );
  }

  return [];
}

function markerIcon(kind: 'address' | 'OSD' | 'OPP' | 'ZS', tone: MarkerTone, attention = false): L.DivIcon {
  const style = getMarkerToneStyle(tone);
  const attentionHtml = attention ? '<span class="project-map-marker__attention">!</span>' : '';
  return L.divIcon({
    className: 'project-map-marker',
    html: `<span class="project-map-marker__shape project-map-marker__shape--${kind.toLowerCase()}" style="--map-marker-color: ${style.color}; --map-marker-border: ${style.border}; --map-marker-background: ${style.background ?? style.color};">${attentionHtml}</span>`,
    iconSize: [24, 24],
    iconAnchor: [12, 12],
    popupAnchor: [0, -12],
  });
}

function infrastructureLinePositions(feature: ProjectMapInfrastructureFeature): LatLngExpression[][] {
  const geometry = geometryFromGeojson(feature.geojson);
  if (!geometry) return [];

  if (geometry.type === 'LineString') {
    return [geometry.coordinates.map(toLatLng).filter(Boolean) as LatLngExpression[]];
  }

  if (geometry.type === 'MultiLineString') {
    return geometry.coordinates.map((line) => line.map(toLatLng).filter(Boolean) as LatLngExpression[]);
  }

  return [];
}

function infrastructurePointPosition(feature: ProjectMapInfrastructureFeature): LatLngExpression | null {
  const geometry = geometryFromGeojson(feature.geojson);
  if (!geometry) return null;

  if (geometry.type === 'Point') return toLatLng(geometry.coordinates);
  if (geometry.type === 'MultiPoint') {
    const first = geometry.coordinates[0];
    return first ? toLatLng(first) : null;
  }

  return null;
}

function infrastructurePointIcon(feature: ProjectMapInfrastructureFeature): L.DivIcon {
  return L.divIcon(getInfrastructurePointIconSpec(feature.featureType, feature.owner));
}

function addressCandidateIcon(): L.DivIcon {
  return L.divIcon({
    className: 'project-map-candidate-marker',
    html: '<span class="project-map-candidate-marker__pin"></span>',
    iconSize: [24, 24],
    iconAnchor: [12, 22],
    popupAnchor: [0, -20],
  });
}

function noteMarkerIcon(): L.DivIcon {
  return L.divIcon({
    className: 'project-map-note-marker',
    html: '<span class="project-map-note-marker__pin"></span>',
    iconSize: [24, 24],
    iconAnchor: [12, 22],
    popupAnchor: [0, -20],
  });
}

function cableRouteLabel(routingType: ProjectMapCable['routingType']): string {
  if (routingType === 'aerial') return 'napowietrzny';
  if (routingType === 'existing_duct') return 'istniejaca kanalizacja';
  return 'doziemny';
}

function asLatLngPoint(position: LatLngExpression): { lat: number; lng: number } | null {
  if (Array.isArray(position)) {
    const [lat, lng] = position;
    return Number.isFinite(lat) && Number.isFinite(lng) ? { lat, lng } : null;
  }

  const point = position as { lat?: unknown; lng?: unknown };
  return typeof point.lat === 'number' && typeof point.lng === 'number'
    ? { lat: point.lat, lng: point.lng }
    : null;
}

function averagePosition(positions: LatLngExpression[]): { lat: number; lng: number } | null {
  const points = positions.map(asLatLngPoint).filter(Boolean) as Array<{ lat: number; lng: number }>;
  if (points.length === 0) return null;
  const total = points.reduce(
    (sum, point) => ({ lat: sum.lat + point.lat, lng: sum.lng + point.lng }),
    { lat: 0, lng: 0 },
  );
  return { lat: total.lat / points.length, lng: total.lng / points.length };
}

function cableNotePosition(cable: ProjectMapCable): { lat: number; lng: number } | null {
  return averagePosition(linePositions(cable).flat());
}

function polygonNotePosition(polygon: ProjectMapPolygon): { lat: number; lng: number } | null {
  return averagePosition(collectGeometryPositions(polygon.geojson));
}

function notesForTarget(
  notes: ProjectMapNote[],
  targetType: ProjectMapNoteTargetType,
  targetId: string,
): ProjectMapNote[] {
  return notes.filter((note) => note.targetType === targetType && note.targetId === targetId);
}

function FitBounds({ positions }: { positions: LatLngExpression[] }) {
  const map = useMap();
  const key = useMemo(() => JSON.stringify(positions), [positions]);

  useEffect(() => {
    if (positions.length === 0) return;
    const bounds = L.latLngBounds(positions);
    if (!bounds.isValid()) return;
    map.fitBounds(bounds, { padding: [32, 32], maxZoom: 18 });
  }, [key, map]);

  return null;
}

function MapFocusTarget({ target }: { target: (MapNoteFocusPosition & { id: string }) | null }) {
  const map = useMap();

  useEffect(() => {
    if (!target) return;
    map.flyTo([target.lat, target.lng], Math.max(map.getZoom(), 18), {
      animate: true,
      duration: 0.45,
    });
  }, [target, map]);

  return null;
}

function MapClickCaptureClassController({ className }: { className: string | null }) {
  const map = useMap();

  useEffect(() => {
    const container = map.getContainer();
    const captureClassName = 'project-map-leaflet--click-capture';

    if (className) {
      container.classList.add(className);
      map.closePopup();
    } else {
      container.classList.remove(captureClassName);
    }

    return () => {
      container.classList.remove(captureClassName);
    };
  }, [className, map]);

  return null;
}

function polygonStyle(polygon: ProjectMapPolygon): PathOptions {
  const complete =
    polygon.addressTotal > 0 && polygon.addressWithReservePhoto >= polygon.addressTotal;
  return {
    color: complete ? '#16a34a' : '#2563eb',
    fillColor: complete ? '#22c55e' : '#60a5fa',
    fillOpacity: 0.12,
    opacity: 0.8,
    weight: 2,
  };
}

function infrastructureFeatureLabel(feature: ProjectMapInfrastructureFeature): string {
  if (feature.featureType === 'duct') return 'Kanalizacja';
  if (feature.featureType === 'pole') return 'Slup';
  return 'Studnia';
}

function InfrastructurePopup({ feature }: { feature: ProjectMapInfrastructureFeature }) {
  return (
    <div className="project-map-popup">
      <div className="project-map-popup__title">
        {feature.label ?? infrastructureFeatureLabel(feature)}
      </div>
      <div className="project-map-popup__meta">{infrastructureFeatureLabel(feature)}</div>
      <div className="project-map-popup__meta">Warstwa: {feature.sourceLayer}</div>
      {feature.elementType && <div className="project-map-popup__meta">Typ: {feature.elementType}</div>}
      {feature.owner && <div className="project-map-popup__meta">Wlasciciel: {feature.owner}</div>}
    </div>
  );
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

function MapNoteForm({
  label,
  initialBody = '',
  onSave,
  onCancel,
  busy,
}: {
  label: string;
  initialBody?: string;
  onSave: (body: string) => void;
  onCancel?: () => void;
  busy: boolean;
}) {
  const [body, setBody] = useState(initialBody);

  useEffect(() => {
    setBody(initialBody);
  }, [initialBody]);

  return (
    <div className="project-map-note-form">
      <div className="project-map-note-form__label">{label}</div>
      <textarea
        className="project-map-note-textarea"
        value={body}
        rows={3}
        placeholder="Wpisz notatke..."
        onChange={(event) => setBody(event.target.value)}
      />
      <div className="project-map-note-form__actions">
        <Button type="button" size="sm" onClick={() => onSave(body)} disabled={busy || body.trim() === ''}>
          <Save size={14} />
          Zapisz
        </Button>
        {onCancel && (
          <Button type="button" size="sm" variant="outline" onClick={onCancel} disabled={busy}>
            <X size={14} />
            Anuluj
          </Button>
        )}
      </div>
    </div>
  );
}

function MapNotePopup({
  note,
  busy,
  onUpdate,
  onDelete,
  onUpload,
}: {
  note: ProjectMapNote;
  busy: boolean;
  onUpdate: (noteId: string, body: string, lat: number | null, lng: number | null) => void;
  onDelete: (noteId: string) => void;
  onUpload: (noteId: string, file: File) => void;
}) {
  const [body, setBody] = useState(note.body);

  useEffect(() => {
    setBody(note.body);
  }, [note.body]);

  return (
    <div className="project-map-popup project-map-note-popup">
      <div className="project-map-popup__title">{note.targetLabel ?? 'Notatka mapy'}</div>
      <textarea
        className="project-map-note-textarea"
        value={body}
        rows={4}
        onChange={(event) => setBody(event.target.value)}
      />
      {note.photos.length > 0 && (
        <div className="project-map-note-photos">
          {note.photos.map((photo) => (
            <span key={photo.id}>{photo.storedFileName}</span>
          ))}
        </div>
      )}
      <div className="project-map-note-actions">
        <Button
          type="button"
          size="sm"
          onClick={() => onUpdate(note.id, body, note.lat, note.lng)}
          disabled={busy || body.trim() === ''}
        >
          <Save size={14} />
          Zapisz
        </Button>
        <MapNotePhotoInput noteId={note.id} disabled={busy} onUpload={onUpload} />
        <Button type="button" size="sm" variant="outline" onClick={() => onDelete(note.id)} disabled={busy}>
          <Trash2 size={14} />
          Usun
        </Button>
      </div>
    </div>
  );
}

function MapNoteMarker({
  note,
  focused,
  busy,
  onUpdate,
  onDelete,
  onUpload,
}: {
  note: ProjectMapNote;
  focused: boolean;
  busy: boolean;
  onUpdate: (noteId: string, body: string, lat: number | null, lng: number | null) => void;
  onDelete: (noteId: string) => void;
  onUpload: (noteId: string, file: File) => void;
}) {
  const markerRef = useRef<L.Marker | null>(null);

  useEffect(() => {
    if (focused) markerRef.current?.openPopup();
  }, [focused, note.id]);

  if (note.lat == null || note.lng == null) return null;

  return (
    <Marker ref={markerRef} position={[note.lat, note.lng]} icon={noteMarkerIcon()}>
      <Popup>
        <MapNotePopup
          note={note}
          busy={busy}
          onUpdate={onUpdate}
          onDelete={onDelete}
          onUpload={onUpload}
        />
      </Popup>
    </Marker>
  );
}

function MapNoteTargetPanel({
  notes,
  targetLabel,
  onCreate,
  busy,
}: {
  notes: ProjectMapNote[];
  targetLabel: string;
  onCreate: (body: string) => void;
  busy: boolean;
}) {
  return (
    <div className="project-map-target-notes">
      {notes.length > 0 && (
        <div className="project-map-target-notes__list">
          {notes.map((note) => (
            <div key={note.id} className="project-map-target-notes__item">
              <StickyNote size={13} />
              <span>{note.body}</span>
            </div>
          ))}
        </div>
      )}
      <MapNoteForm label={`Notatka: ${targetLabel}`} onSave={onCreate} busy={busy} />
    </div>
  );
}

function MiniPhotoGallery({ projectId, photos }: { projectId: string; photos: ProjectMapPhoto[] }) {
  if (photos.length === 0) return null;
  const galleryPhoto = photos[4] ?? photos[0];
  const galleryHref = `#${photoProjectRoute(projectId, 'photos', galleryPhoto.checklistNodeId)}`;

  return (
    <div className="project-map-mini-gallery" aria-label="Zdjecia przypisane do elementu">
      {photos.slice(0, 4).map((photo) => (
        <a
          key={photo.id}
          href={api.photoFileUrl(projectId, photo.id)}
          target="_blank"
          rel="noreferrer"
          title={photo.storedFileName}
          className="project-map-mini-gallery__item"
        >
          <img src={api.photoThumbUrl(projectId, photo.id)} alt={photo.storedFileName} loading="lazy" />
          <span>{photo.storedFileName}</span>
        </a>
      ))}
      {photos.length > 4 && (
        <a href={galleryHref} className="project-map-mini-gallery__more">
          +{photos.length - 4}
        </a>
      )}
    </div>
  );
}

function useCapturedMapClick({
  enabled,
  onPick,
}: {
  enabled: boolean;
  onPick: (lat: number, lng: number) => void;
}) {
  const map = useMap();
  const onPickRef = useRef(onPick);

  useEffect(() => {
    onPickRef.current = onPick;
  }, [onPick]);

  useEffect(() => {
    if (!enabled) return;

    const container = map.getContainer();
    const handleClick = (event: MouseEvent) => {
      if (!shouldCaptureMapCanvasClick(event.target)) return;
      if (!enabled) return;
      event.preventDefault();
      event.stopPropagation();
      event.stopImmediatePropagation();

      const latLng = map.mouseEventToLatLng(event);
      onPickRef.current(latLng.lat, latLng.lng);
    };

    container.addEventListener('click', handleClick, true);

    return () => {
      container.removeEventListener('click', handleClick, true);
    };
  }, [enabled, map]);
}

function MapClickNoteCreator({
  enabled,
  onPick,
}: {
  enabled: boolean;
  onPick: (lat: number, lng: number) => void;
}) {
  useCapturedMapClick({ enabled, onPick });

  return null;
}

function MapClickAddressCreator({
  enabled,
  onPick,
}: {
  enabled: boolean;
  onPick: (lat: number, lng: number) => void;
}) {
  useCapturedMapClick({ enabled, onPick });

  return null;
}

function DraftNoteMarker({
  position,
  busy,
  onSave,
  onCancel,
}: {
  position: { lat: number; lng: number };
  busy: boolean;
  onSave: (body: string) => void;
  onCancel: () => void;
}) {
  const markerRef = useRef<L.Marker | null>(null);

  useEffect(() => {
    markerRef.current?.openPopup();
  }, [position.lat, position.lng]);

  return (
    <Marker ref={markerRef} position={[position.lat, position.lng]} icon={noteMarkerIcon()}>
      <Popup closeOnClick={false}>
        <MapNoteForm label="Nowa notatka mapy" onSave={onSave} onCancel={onCancel} busy={busy} />
      </Popup>
    </Marker>
  );
}

function CablePopup({
  cable,
  notes,
  onStatusChange,
  onCreateNote,
  busy,
}: {
  cable: ProjectMapCable;
  notes: ProjectMapNote[];
  onStatusChange: (cableId: string, status: ProjectMapCableStatus) => void;
  onCreateNote: (input: CreateMapNoteInput) => void;
  busy: boolean;
}) {
  const actions = getCableStatusActions({ status: cable.status, routingType: cable.routingType });
  const label = cable.rawName ?? `${cable.fromNode} - ${cable.toNode}`;
  const notePosition = cableNotePosition(cable);

  return (
    <div className="project-map-popup">
      <div className="project-map-popup__title">{label}</div>
      <div className="project-map-popup__meta">
        {cable.cableType} · {cableRouteLabel(cable.routingType)}
      </div>
      <div className="project-map-popup__metrics">
        <span>
          <strong>Trasowa</strong>
          {formatCableLength(cable.routeLengthMeters)}
        </span>
        <span>
          <strong>Instalacyjna</strong>
          {formatCableLength(cable.installationLengthMeters)}
        </span>
      </div>
      <div className="project-map-popup__status-row">
        <Badge variant="outline">{getCableStatusLabel(cable.status, cable.routingType)}</Badge>
      </div>
      <div className="project-map-popup__actions">
        {actions.map((action) => (
          <MapStatusActionButton
            key={action.status}
            action={action}
            disabled={busy || (action.kind === 'reset' && cable.status === 'PENDING')}
            onSelect={(status) => onStatusChange(cable.id, status)}
          />
        ))}
      </div>
      <MapNoteTargetPanel
        notes={notes}
        targetLabel={label}
        busy={busy}
        onCreate={(body) =>
          onCreateNote({
            targetType: 'cable',
            targetId: cable.id,
            targetLabel: label,
            body,
            lat: notePosition?.lat ?? null,
            lng: notePosition?.lng ?? null,
          })
        }
      />
    </div>
  );
}

function NodePopup({
  projectId,
  node,
  notes,
  onStatusChange,
  onCreateNote,
  busy,
}: {
  projectId: string;
  node: ProjectMapInfraNode;
  notes: ProjectMapNote[];
  onStatusChange: (nodeId: string, status: ProjectMapNodeStatus) => void;
  onCreateNote: (input: CreateMapNoteInput) => void;
  busy: boolean;
}) {
  const actions = getNodeStatusActions(node.status);
  const label = node.label ?? node.name;
  const nodeWelded = node.status === 'WELDED';
  const nodeStatusLabel = nodeWelded
    ? 'Wyspawane'
    : node.hasPhoto
      ? 'Jest zdjecie, spaw do potwierdzenia'
      : STATUS_LABELS[node.status];

  return (
    <div className="project-map-popup">
      <div className="project-map-popup__title">{label}</div>
      <div className="project-map-popup__meta">{node.nodeType}</div>
      <div className="project-map-popup__status-row">
        <Badge
          variant={nodeWelded ? 'default' : 'outline'}
          className={!nodeWelded && node.hasPhoto ? 'border-orange-300 bg-orange-50 text-orange-700' : undefined}
        >
          {nodeStatusLabel}
        </Badge>
      </div>
      <MiniPhotoGallery projectId={projectId} photos={node.photos} />
      <div className="project-map-popup__actions">
        {actions.map((action) => (
          <MapStatusActionButton
            key={action.status}
            action={action}
            disabled={busy || (action.kind === 'reset' && node.status === 'PENDING')}
            onSelect={(status) => onStatusChange(node.id, status)}
          />
        ))}
      </div>
      <MapNoteTargetPanel
        notes={notes}
        targetLabel={label}
        busy={busy}
        onCreate={(body) =>
          onCreateNote({
            targetType: 'node',
            targetId: node.id,
            targetLabel: label,
            body,
            lat: node.lat,
            lng: node.lng,
          })
        }
      />
    </div>
  );
}

function AddressPopup({
  projectId,
  address,
  notes,
  onMarkNotApplicable,
  onOplConsentChange,
  onCreateNote,
  busy,
}: {
  projectId: string;
  address: ProjectMapAddress;
  notes: ProjectMapNote[];
  onMarkNotApplicable: (addressId: string) => void;
  onOplConsentChange: (addressId: string, confirmed: boolean) => void;
  onCreateNote: (input: CreateMapNoteInput) => void;
  busy: boolean;
}) {
  const addressReady = address.hasReservePhoto || address.isNotApplicable;

  return (
    <div className="project-map-popup">
      <div className="project-map-popup__title">{address.label}</div>
      <div className="project-map-popup__meta">{address.distributionPoint ?? 'Bez punktu dystrybucyjnego'}</div>
      <Badge variant={addressReady ? 'default' : 'outline'}>
        {address.isNotApplicable
          ? 'Nie dotyczy'
          : address.hasReservePhoto
            ? 'Zapas ze zdjeciem'
            : 'Brak zdjecia zapasu'}
      </Badge>
      <MiniPhotoGallery projectId={projectId} photos={address.photos} />
      {address.isManuallyAdded && (
        <label className="project-map-popup__checkbox">
          <input
            type="checkbox"
            checked={address.oplConsentConfirmed}
            disabled={busy}
            onChange={(event) => onOplConsentChange(address.id, event.currentTarget.checked)}
          />
          <span>Zgoda OPL</span>
        </label>
      )}
      {!addressReady && (
        <Button
          type="button"
          size="sm"
          variant="outline"
          className="project-map-popup__single-action"
          disabled={busy}
          onClick={() => {
            if (window.confirm('Oznaczyc ten adres jako nie dotyczy?')) {
              onMarkNotApplicable(address.id);
            }
          }}
        >
          Nie dotyczy
        </Button>
      )}
      <MapNoteTargetPanel
        notes={notes}
        targetLabel={address.label}
        busy={busy}
        onCreate={(body) =>
          onCreateNote({
            targetType: 'address',
            targetId: address.id,
            targetLabel: address.label,
            body,
            lat: address.lat,
            lng: address.lng,
          })
        }
      />
    </div>
  );
}

function AddressCandidatePopup({
  candidate,
  busy,
  onOpenReview,
  onReject,
}: {
  candidate: ProjectMapAddressCandidate;
  busy: boolean;
  onOpenReview: () => void;
  onReject: (candidateId: string) => void;
}) {
  return (
    <div className="project-map-popup">
      <div className="project-map-popup__title">{candidate.label}</div>
      <div className="project-map-popup__meta">
        {candidate.suggestedDistributionPoint
          ? `Rejonizacja: ${candidate.suggestedDistributionPoint}`
          : 'Do przypisania do OPP/OSD'}
      </div>
      <div className="project-map-popup__status-row">
        <Badge variant="outline">Adres do dodania</Badge>
      </div>
      <div className="project-map-popup__actions">
        <Button type="button" size="sm" onClick={onOpenReview} disabled={busy}>
          Zatwierdz
        </Button>
        <Button type="button" size="sm" variant="outline" onClick={() => onReject(candidate.id)} disabled={busy}>
          Odrzuc
        </Button>
      </div>
    </div>
  );
}

export default function ProjectMap({ projectId, view, onViewChange }: ProjectMapProps) {
  const [data, setData] = useState<ProjectMapData | null>(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [busyId, setBusyId] = useState<string | null>(null);
  const [addingFreeNote, setAddingFreeNote] = useState(false);
  const [addingAddress, setAddingAddress] = useState(false);
  const [showInfrastructure, setShowInfrastructure] = useState(false);
  const [draftNotePosition, setDraftNotePosition] = useState<{ lat: number; lng: number } | null>(null);
  const [focusedNote, setFocusedNote] = useState<(MapNoteFocusPosition & { id: string }) | null>(null);

  const refresh = useCallback(async () => {
    setLoading(true);
    setError(null);
    try {
      setData(await api.getProjectMap(projectId));
    } catch (err) {
      setError(getErrorMessage(err));
    } finally {
      setLoading(false);
    }
  }, [projectId]);

  useEffect(() => {
    void refresh();
  }, [refresh]);

  const updateCableStatus = async (cableId: string, status: ProjectMapCableStatus) => {
    setBusyId(cableId);
    setError(null);
    try {
      setData(await api.updateMapCableStatus(projectId, cableId, status));
    } catch (err) {
      setError(getErrorMessage(err));
    } finally {
      setBusyId(null);
    }
  };

  const updateNodeStatus = async (nodeId: string, status: ProjectMapNodeStatus) => {
    setBusyId(nodeId);
    setError(null);
    try {
      setData(await api.updateMapNodeStatus(projectId, nodeId, status));
    } catch (err) {
      setError(getErrorMessage(err));
    } finally {
      setBusyId(null);
    }
  };

  const markAddressNotApplicable = async (addressId: string) => {
    setBusyId(addressId);
    setError(null);
    try {
      setData(await api.markMapAddressNotApplicable(projectId, addressId, 'Oznaczone z mapy jako nie dotyczy'));
    } catch (err) {
      setError(getErrorMessage(err));
    } finally {
      setBusyId(null);
    }
  };

  const updateAddressOplConsent = async (addressId: string, confirmed: boolean) => {
    setBusyId(addressId);
    setError(null);
    try {
      setData(await api.updateMapAddressOplConsent(projectId, addressId, confirmed));
    } catch (err) {
      setError(getErrorMessage(err));
    } finally {
      setBusyId(null);
    }
  };

  const createAddressCandidate = async (lat: number, lng: number) => {
    setBusyId('address-candidate');
    setError(null);
    try {
      setData(await api.reverseGeocodeMapAddressCandidate(projectId, lat, lng));
      setAddingAddress(false);
      onViewChange('address-candidates');
    } catch (err) {
      setError(getErrorMessage(err));
    } finally {
      setBusyId(null);
    }
  };

  const approveAddressCandidate = async (
    candidateId: string,
    input: {
      city: string;
      street: string;
      buildingNo: string | null;
      propertyId: string | null;
      parcelNumber: string | null;
      distributionPoint: string | null;
      reserveLocation: ProjectMapCandidateReserveLocation;
      createDistributionNodeType: 'OSD' | 'OPP' | null;
      noteBody?: string | null;
    },
  ) => {
    setBusyId(candidateId);
    setError(null);
    try {
      setData(await api.approveMapAddressCandidate(projectId, candidateId, input));
    } catch (err) {
      setError(getErrorMessage(err));
    } finally {
      setBusyId(null);
    }
  };

  const rejectAddressCandidate = async (candidateId: string) => {
    setBusyId(candidateId);
    setError(null);
    try {
      setData(await api.rejectMapAddressCandidate(projectId, candidateId));
    } catch (err) {
      setError(getErrorMessage(err));
    } finally {
      setBusyId(null);
    }
  };

  const createMapNote = async (input: CreateMapNoteInput) => {
    setBusyId('note');
    setError(null);
    try {
      setData(await api.createMapNote(projectId, input));
      return true;
    } catch (err) {
      setError(getErrorMessage(err));
      return false;
    } finally {
      setBusyId(null);
    }
  };

  const updateMapNote = async (noteId: string, body: string, lat: number | null, lng: number | null) => {
    setBusyId(noteId);
    setError(null);
    try {
      setData(await api.updateMapNote(projectId, noteId, { body, lat, lng }));
    } catch (err) {
      setError(getErrorMessage(err));
    } finally {
      setBusyId(null);
    }
  };

  const deleteMapNote = async (noteId: string) => {
    setBusyId(noteId);
    setError(null);
    try {
      setData(await api.deleteMapNote(projectId, noteId));
    } catch (err) {
      setError(getErrorMessage(err));
    } finally {
      setBusyId(null);
    }
  };

  const uploadMapNotePhoto = async (noteId: string, file: File) => {
    setBusyId(noteId);
    setError(null);
    try {
      await api.uploadMapNotePhoto(projectId, noteId, file);
      setData(await api.getProjectMap(projectId));
    } catch (err) {
      setError(getErrorMessage(err));
    } finally {
      setBusyId(null);
    }
  };

  const showNoteOnMap = (note: ProjectMapNote) => {
    const position = getMapNoteFocusPosition(note);
    if (!position) return;
    setFocusedNote({ id: note.id, ...position });
    onViewChange('map');
  };

  const boundsPositions = useMemo(() => {
    if (!data) return [];
    return getMapBoundsPositions(data);
  }, [data]);

  const totals = useMemo(() => {
    if (!data) {
      return {
        addressesReady: 0,
        addressesTotal: 0,
        cablesReady: 0,
        cablesTotal: 0,
        nodesReady: 0,
        nodesTotal: 0,
        notesTotal: 0,
        candidatesTotal: 0,
      };
    }
    return {
      addressesReady: data.addresses.filter((address) => address.hasReservePhoto || address.isNotApplicable).length,
      addressesTotal: data.addresses.length,
      cablesReady: data.trunkCables.filter((cable) => isCableReady(cable.status)).length,
      cablesTotal: data.trunkCables.length,
      nodesReady: data.infraNodes.filter((node) => isNodeReady(node.status, node.hasPhoto)).length,
      nodesTotal: data.infraNodes.length,
      notesTotal: data.notes.length,
      candidatesTotal: data.addressCandidates.length,
    };
  }, [data]);

  const mapClickCaptureActive = isMapClickCaptureActive({
    addingAddress,
    addingFreeNote,
    hasDraftNote: Boolean(draftNotePosition),
  });
  const mapClickCaptureClassName = getMapClickCaptureClassName({
    addingAddress,
    addingFreeNote,
    hasDraftNote: Boolean(draftNotePosition),
  });

  if (loading && !data) {
    return (
      <div className="flex flex-1 items-center justify-center text-sm text-muted-foreground">
        Laduje mape...
      </div>
    );
  }

  if (!data) {
    return (
      <div className="flex flex-1 items-center justify-center text-sm text-muted-foreground">
        Nie udalo sie pobrac mapy.
      </div>
    );
  }

  return (
    <div className="project-map-shell">
      <div className="project-map-toolbar">
        <div className="project-map-toolbar__group">
          <span><Home size={15} /> Adresy {totals.addressesReady}/{totals.addressesTotal}</span>
          <span><Cable size={15} /> Kable {totals.cablesReady}/{totals.cablesTotal}</span>
          <span><Triangle size={15} /> Punkty {totals.nodesReady}/{totals.nodesTotal}</span>
          <span><StickyNote size={15} /> Notatki {totals.notesTotal}</span>
          <span><MapPinPlus size={15} /> Do dodania {totals.candidatesTotal}</span>
        </div>
        <div className="project-map-toolbar__actions">
          <div className="project-map-view-switch" aria-label="Widok mapy">
            <Button
              type="button"
              size="sm"
              variant="ghost"
              className={cn('project-map-view-switch__button', view === 'map' && 'project-map-view-switch__button--active')}
              onClick={() => onViewChange('map')}
            >
              <Map size={14} />
              Mapa
            </Button>
            <Button
              type="button"
              size="sm"
              variant="ghost"
              className={cn('project-map-view-switch__button', view === 'tasks' && 'project-map-view-switch__button--active')}
              onClick={() => onViewChange('tasks')}
            >
              <ListChecks size={14} />
              Lista zadan
            </Button>
            <Button
              type="button"
              size="sm"
              variant="ghost"
              className={cn('project-map-view-switch__button', view === 'notes' && 'project-map-view-switch__button--active')}
              onClick={() => onViewChange('notes')}
            >
              <StickyNote size={14} />
              Notatki
            </Button>
            <Button
              type="button"
              size="sm"
              variant="ghost"
              className={cn(
                'project-map-view-switch__button',
                view === 'address-candidates' && 'project-map-view-switch__button--active',
              )}
              onClick={() => onViewChange('address-candidates')}
            >
              <MapPinPlus size={14} />
              Adresy
            </Button>
          </div>
          {view === 'map' && (
            <>
              <Button
                variant={showInfrastructure ? 'default' : 'outline'}
                size="sm"
                onClick={() => setShowInfrastructure((current) => !current)}
              >
                <Layers size={14} className="mr-2" />
                Infrastruktura
              </Button>
              <Button
                variant={addingAddress ? 'default' : 'outline'}
                size="sm"
                onClick={() => {
                  setAddingAddress((current) => !current);
                  setAddingFreeNote(false);
                  setDraftNotePosition(null);
                }}
                disabled={busyId === 'address-candidate'}
              >
                <MapPinPlus size={14} className="mr-2" />
                Dodaj adres
              </Button>
              <Button
                variant={addingFreeNote ? 'default' : 'outline'}
                size="sm"
                onClick={() => {
                  setAddingFreeNote((current) => !current);
                  setAddingAddress(false);
                  setDraftNotePosition(null);
                }}
              >
                <MessageSquarePlus size={14} className="mr-2" />
                Dodaj notatke
              </Button>
            </>
          )}
          <Button variant="outline" size="sm" onClick={() => void refresh()} disabled={loading}>
            <RefreshCw size={14} className="mr-2" />
            Odswiez
          </Button>
        </div>
      </div>

      {error && <div className="project-map-error">{error}</div>}

      {view === 'tasks' ? (
        <ProjectMapTasks
          data={data}
          busyId={busyId}
          onCableStatusChange={updateCableStatus}
          onNodeStatusChange={updateNodeStatus}
        />
      ) : view === 'notes' ? (
        <ProjectMapNotes
          notes={data.notes}
          busyId={busyId}
          onUpdateNote={(noteId, body, lat, lng) => void updateMapNote(noteId, body, lat, lng)}
          onDeleteNote={(noteId) => void deleteMapNote(noteId)}
          onUploadNotePhoto={(noteId, file) => void uploadMapNotePhoto(noteId, file)}
          onShowOnMap={showNoteOnMap}
        />
      ) : view === 'address-candidates' ? (
        <ProjectMapAddressCandidates
          data={data}
          busyId={busyId}
          onApproveCandidate={(candidateId, input) => void approveAddressCandidate(candidateId, input)}
          onRejectCandidate={(candidateId) => void rejectAddressCandidate(candidateId)}
        />
      ) : (
        <>
          <div className="project-map-canvas">
            {addingFreeNote && !draftNotePosition && (
              <div className="project-map-note-hint">Kliknij miejsce na mapie dla nowej notatki.</div>
            )}
            {addingAddress && (
              <div className="project-map-note-hint project-map-note-hint--address">
                Kliknij adres na mapie do odczytania z PRG.
              </div>
            )}
            <MapContainer center={[52.05, 19.4]} zoom={7} className="project-map-leaflet">
              <TileLayer
                attribution='&copy; <a href="https://www.openstreetmap.org/copyright">OpenStreetMap</a>'
                url="https://{s}.tile.openstreetmap.org/{z}/{x}/{y}.png"
              />
              <FitBounds positions={boundsPositions} />
              <MapFocusTarget target={focusedNote} />
              <MapClickCaptureClassController className={mapClickCaptureClassName} />
              <MapClickNoteCreator
                enabled={addingFreeNote && !addingAddress}
                onPick={(lat, lng) => setDraftNotePosition({ lat, lng })}
              />
              <MapClickAddressCreator
                enabled={addingAddress && !addingFreeNote && busyId !== 'address-candidate'}
                onPick={(lat, lng) => void createAddressCandidate(lat, lng)}
              />
              {draftNotePosition && (
                <DraftNoteMarker
                  position={draftNotePosition}
                  busy={busyId === 'note'}
                  onCancel={() => setDraftNotePosition(null)}
                  onSave={(body) => {
                    void createMapNote({
                      targetType: 'free',
                      targetId: null,
                      targetLabel: 'Notatka mapy',
                      body,
                      lat: draftNotePosition.lat,
                      lng: draftNotePosition.lng,
                    }).then((saved) => {
                      if (saved) {
                        setDraftNotePosition(null);
                        setAddingFreeNote(false);
                      }
                    });
                  }}
                />
              )}

              {showInfrastructure && (
                <Pane name={INFRASTRUCTURE_MAP_PANE} style={INFRASTRUCTURE_PANE_STYLE}>
                  {data.infrastructureFeatures.map((feature) => {
                    if (feature.featureType === 'duct') {
                      return infrastructureLinePositions(feature).map((positions, index) => (
                        <Polyline
                          key={`infra-${feature.id}-${index}`}
                          positions={positions}
                          pathOptions={getInfrastructureLineStyle()}
                          pane={INFRASTRUCTURE_MAP_PANE}
                          interactive={!mapClickCaptureActive}
                        >
                          <Popup pane={INFRASTRUCTURE_POPUP_PANE}>
                            <InfrastructurePopup feature={feature} />
                          </Popup>
                        </Polyline>
                      ));
                    }

                    const position = infrastructurePointPosition(feature);
                    if (!position) return null;
                    return (
                      <Marker
                        key={`infra-${feature.id}`}
                        position={position}
                        icon={infrastructurePointIcon(feature)}
                        pane={INFRASTRUCTURE_MAP_PANE}
                        interactive={!mapClickCaptureActive}
                      >
                        <Popup pane={INFRASTRUCTURE_POPUP_PANE}>
                          <InfrastructurePopup feature={feature} />
                        </Popup>
                      </Marker>
                    );
                  })}
                </Pane>
              )}

              {data.polygons.map((polygon) => {
                if (!isGeoJsonObject(polygon.geojson)) return null;
                const label = polygon.label ?? polygon.osdName;
                const notePosition = polygonNotePosition(polygon);
                return (
                  <GeoJSON
                    key={polygon.id}
                    data={polygon.geojson}
                    style={() => polygonStyle(polygon)}
                    interactive={!mapClickCaptureActive}
                  >
                    <Popup>
                      <div className="project-map-popup">
                        <div className="project-map-popup__title">{label}</div>
                        <div className="project-map-popup__meta">
                          Adresy gotowe: {polygon.addressWithReservePhoto}/{polygon.addressTotal}
                        </div>
                        <div className="project-map-popup__meta">
                          HH: {polygon.households ?? '-'} PA: {polygon.paCount ?? '-'}
                        </div>
                        <MapNoteTargetPanel
                          notes={notesForTarget(data.notes, 'polygon', polygon.id)}
                          targetLabel={label}
                          busy={busyId === 'note'}
                          onCreate={(body) =>
                            void createMapNote({
                              targetType: 'polygon',
                              targetId: polygon.id,
                              targetLabel: label,
                              body,
                              lat: notePosition?.lat ?? null,
                              lng: notePosition?.lng ?? null,
                            })
                          }
                        />
                      </div>
                    </Popup>
                  </GeoJSON>
                );
              })}

              {data.trunkCables.map((cable) =>
                linePositions(cable).flatMap((positions, index) =>
                  getCableLineStyles(cable.status, cable.routingType).map((style, styleIndex) => (
                    <Polyline
                      key={`${cable.id}-${index}-${styleIndex}`}
                      positions={positions}
                      pathOptions={style}
                      interactive={!mapClickCaptureActive}
                    >
                      <Popup>
                        <CablePopup
                          cable={cable}
                          notes={notesForTarget(data.notes, 'cable', cable.id)}
                          onStatusChange={updateCableStatus}
                          onCreateNote={(input) => void createMapNote(input)}
                          busy={busyId === cable.id || busyId === 'note'}
                        />
                      </Popup>
                    </Polyline>
                  )),
                ),
              )}

              {data.infraNodes.map((node) => (
                <Marker
                  key={node.id}
                  position={[node.lat, node.lng]}
                  icon={markerIcon(node.nodeType, getMarkerTone(node))}
                  interactive={!mapClickCaptureActive}
                >
                  <Popup>
                    <NodePopup
                      projectId={projectId}
                      node={node}
                      notes={notesForTarget(data.notes, 'node', node.id)}
                      onStatusChange={updateNodeStatus}
                      onCreateNote={(input) => void createMapNote(input)}
                      busy={busyId === node.id || busyId === 'note'}
                    />
                  </Popup>
                </Marker>
              ))}

              {data.addresses.map((address) => {
                const needsOplConsent =
                  address.isManuallyAdded && !address.oplConsentConfirmed && !address.isNotApplicable;
                return (
                  <Marker
                    key={address.id}
                    position={[address.lat, address.lng]}
                    icon={markerIcon('address', getAddressMarkerTone(address), needsOplConsent)}
                    interactive={!mapClickCaptureActive}
                  >
                    <Popup>
                      <AddressPopup
                        projectId={projectId}
                        address={address}
                        notes={notesForTarget(data.notes, 'address', address.id)}
                        onMarkNotApplicable={(addressId) => void markAddressNotApplicable(addressId)}
                        onOplConsentChange={(addressId, confirmed) =>
                          void updateAddressOplConsent(addressId, confirmed)
                        }
                        onCreateNote={(input) => void createMapNote(input)}
                        busy={busyId === address.id || busyId === 'note'}
                      />
                    </Popup>
                  </Marker>
                );
              })}

              {data.addressCandidates.map((candidate) => (
                <Marker
                  key={candidate.id}
                  position={[candidate.lat, candidate.lng]}
                  icon={addressCandidateIcon()}
                  interactive={!mapClickCaptureActive}
                >
                  <Popup>
                    <AddressCandidatePopup
                      candidate={candidate}
                      busy={busyId === candidate.id}
                      onOpenReview={() => onViewChange('address-candidates')}
                      onReject={(candidateId) => void rejectAddressCandidate(candidateId)}
                    />
                  </Popup>
                </Marker>
              ))}

              {data.notes.map((note) => (
                <MapNoteMarker
                  key={`note-${note.id}`}
                  note={note}
                  focused={focusedNote?.id === note.id}
                  busy={busyId === note.id}
                  onUpdate={(noteId, body, lat, lng) => void updateMapNote(noteId, body, lat, lng)}
                  onDelete={(noteId) => void deleteMapNote(noteId)}
                  onUpload={(noteId, file) => void uploadMapNotePhoto(noteId, file)}
                />
              ))}
            </MapContainer>
          </div>

          <div className="project-map-legend" aria-hidden="true">
            <span><span className="project-map-dot project-map-dot--red" /> adres bez zapasu</span>
            <span><span className="project-map-dot project-map-dot--manual-pending" /> adres dodany recznie</span>
            <span><span className="project-map-dot project-map-dot--manual-done" /> reczny ze zdjeciem</span>
            <span><span className="project-map-dot project-map-dot--gray" /> adres nie dotyczy</span>
            <span><span className="project-map-dot project-map-dot--blue" /> adres do dodania</span>
            <span><span className="project-map-dot project-map-dot--orange" /> punkt ze zdjeciem</span>
            <span><span className="project-map-line project-map-line--underground" /> kabel doziemny</span>
            <span><span className="project-map-line project-map-line--aerial" /> kabel napowietrzny</span>
            <span><span className="project-map-line project-map-line--duct" /> istniejaca kanalizacja</span>
            <span><span className="project-map-line project-map-line--done" /> gotowe</span>
            {showInfrastructure && (
              <>
                <span><span className="project-map-line project-map-line--infra" /> kanalizacja / rurociag</span>
                <span>
                  <span className="project-map-infra-pole project-map-infra-pole--legend">
                    <span className="project-map-infra-pole__stem"></span>
                  </span>
                  <span className="project-map-infra-manhole project-map-infra-manhole--legend"></span>
                  slup / studnia
                </span>
              </>
            )}
            <span><Triangle size={13} className="project-map-legend-icon project-map-legend-icon--osd" /> OSD</span>
            <span><Circle size={13} className="project-map-legend-icon project-map-legend-icon--opp" /> OPP</span>
            <span><span className="project-map-legend-square project-map-legend-square--zs" /> ZS</span>
          </div>
        </>
      )}
    </div>
  );
}
