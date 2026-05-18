import { useCallback, useEffect, useMemo, useState } from 'react';
import L, { type LatLngExpression, type PathOptions } from 'leaflet';
import { GeoJSON, MapContainer, Marker, Polyline, Popup, TileLayer, useMap } from 'react-leaflet';
import { Cable, Circle, Home, ListChecks, Map, RefreshCw, Triangle } from 'lucide-react';
import type { Feature, GeoJsonObject, Geometry } from 'geojson';

import { api } from '../api';
import { cn } from '../lib/utils';
import {
  getCableStatusActions,
  getNodeStatusActions,
  STATUS_LABELS,
} from '../map-status-actions';
import {
  getCableLineStyle,
  getMarkerTone,
  getMarkerToneStyle,
  isCableReady,
  isNodeReady,
  type MarkerTone,
} from '../map-style';
import type {
  ProjectMapAddress,
  ProjectMapCable,
  ProjectMapCableStatus,
  ProjectMapData,
  ProjectMapInfraNode,
  ProjectMapNodeStatus,
  ProjectMapPolygon,
} from '../types';
import { MapStatusActionButton } from './MapStatusControls';
import ProjectMapTasks from './ProjectMapTasks';
import { Badge } from './ui/badge';
import { Button } from './ui/button';

interface ProjectMapProps {
  projectId: string;
  view: 'map' | 'tasks';
  onViewChange: (view: 'map' | 'tasks') => void;
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

function markerIcon(kind: 'address' | 'OSD' | 'OPP' | 'ZS', tone: MarkerTone): L.DivIcon {
  const style = getMarkerToneStyle(tone);
  return L.divIcon({
    className: 'project-map-marker',
    html: `<span class="project-map-marker__shape project-map-marker__shape--${kind.toLowerCase()}" style="--map-marker-color: ${style.color}; --map-marker-border: ${style.border};"></span>`,
    iconSize: [24, 24],
    iconAnchor: [12, 12],
    popupAnchor: [0, -12],
  });
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

function CablePopup({
  cable,
  onStatusChange,
  busy,
}: {
  cable: ProjectMapCable;
  onStatusChange: (cableId: string, status: ProjectMapCableStatus) => void;
  busy: boolean;
}) {
  const isAerial = cable.routingType === 'aerial';
  const actions = getCableStatusActions({ status: cable.status, routingType: cable.routingType });

  return (
    <div className="project-map-popup">
      <div className="project-map-popup__title">{cable.rawName ?? `${cable.fromNode} - ${cable.toNode}`}</div>
      <div className="project-map-popup__meta">
        {cable.cableType} · {isAerial ? 'napowietrzny' : 'doziemny'}
      </div>
      <div className="project-map-popup__status-row">
        <Badge variant="outline">{STATUS_LABELS[cable.status]}</Badge>
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
    </div>
  );
}

function NodePopup({
  node,
  onStatusChange,
  busy,
}: {
  node: ProjectMapInfraNode;
  onStatusChange: (nodeId: string, status: ProjectMapNodeStatus) => void;
  busy: boolean;
}) {
  const actions = getNodeStatusActions(node.status);

  return (
    <div className="project-map-popup">
      <div className="project-map-popup__title">{node.label ?? node.name}</div>
      <div className="project-map-popup__meta">{node.nodeType}</div>
      <div className="project-map-popup__status-row">
        <Badge variant={node.status === 'WELDED' || node.hasPhoto ? 'default' : 'outline'}>
          {node.hasPhoto ? 'Jest zdjecie' : STATUS_LABELS[node.status]}
        </Badge>
      </div>
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
    </div>
  );
}

function AddressPopup({ address }: { address: ProjectMapAddress }) {
  return (
    <div className="project-map-popup">
      <div className="project-map-popup__title">{address.label}</div>
      <div className="project-map-popup__meta">{address.distributionPoint ?? 'Bez punktu dystrybucyjnego'}</div>
      <Badge variant={address.hasReservePhoto ? 'default' : 'outline'}>
        {address.hasReservePhoto ? 'Zapas ze zdjeciem' : 'Brak zdjecia zapasu'}
      </Badge>
    </div>
  );
}

export default function ProjectMap({ projectId, view, onViewChange }: ProjectMapProps) {
  const [data, setData] = useState<ProjectMapData | null>(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [busyId, setBusyId] = useState<string | null>(null);

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

  const boundsPositions = useMemo(() => {
    if (!data) return [];
    return [
      ...data.addresses.map((address) => [address.lat, address.lng] as LatLngExpression),
      ...data.infraNodes.map((node) => [node.lat, node.lng] as LatLngExpression),
      ...data.trunkCables.flatMap((cable) => collectGeometryPositions(cable.geojson)),
      ...data.polygons.flatMap((polygon) => collectGeometryPositions(polygon.geojson)),
    ];
  }, [data]);

  const totals = useMemo(() => {
    if (!data) return { addressesReady: 0, addressesTotal: 0, cablesReady: 0, cablesTotal: 0, nodesReady: 0, nodesTotal: 0 };
    return {
      addressesReady: data.addresses.filter((address) => address.hasReservePhoto).length,
      addressesTotal: data.addresses.length,
      cablesReady: data.trunkCables.filter((cable) => isCableReady(cable.status)).length,
      cablesTotal: data.trunkCables.length,
      nodesReady: data.infraNodes.filter((node) => isNodeReady(node.status, node.hasPhoto)).length,
      nodesTotal: data.infraNodes.length,
    };
  }, [data]);

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
          </div>
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
      ) : (
        <>
          <div className="project-map-canvas">
            <MapContainer center={[52.05, 19.4]} zoom={7} className="project-map-leaflet">
              <TileLayer
                attribution='&copy; <a href="https://www.openstreetmap.org/copyright">OpenStreetMap</a>'
                url="https://{s}.tile.openstreetmap.org/{z}/{x}/{y}.png"
              />
              <FitBounds positions={boundsPositions} />

              {data.polygons.map((polygon) =>
                isGeoJsonObject(polygon.geojson) ? (
                  <GeoJSON key={polygon.id} data={polygon.geojson} style={() => polygonStyle(polygon)}>
                    <Popup>
                      <div className="project-map-popup">
                        <div className="project-map-popup__title">{polygon.label ?? polygon.osdName}</div>
                        <div className="project-map-popup__meta">
                          Adresy ze zdjeciem: {polygon.addressWithReservePhoto}/{polygon.addressTotal}
                        </div>
                        <div className="project-map-popup__meta">
                          HH: {polygon.households ?? '-'} PA: {polygon.paCount ?? '-'}
                        </div>
                      </div>
                    </Popup>
                  </GeoJSON>
                ) : null,
              )}

              {data.trunkCables.map((cable) =>
                linePositions(cable).map((positions, index) => (
                  <Polyline
                    key={`${cable.id}-${index}`}
                    positions={positions}
                    pathOptions={getCableLineStyle(cable.status, cable.routingType)}
                  >
                    <Popup>
                      <CablePopup cable={cable} onStatusChange={updateCableStatus} busy={busyId === cable.id} />
                    </Popup>
                  </Polyline>
                )),
              )}

              {data.infraNodes.map((node) => (
                <Marker
                  key={node.id}
                  position={[node.lat, node.lng]}
                  icon={markerIcon(node.nodeType, getMarkerTone(node))}
                >
                  <Popup>
                    <NodePopup node={node} onStatusChange={updateNodeStatus} busy={busyId === node.id} />
                  </Popup>
                </Marker>
              ))}

              {data.addresses.map((address) => (
                <Marker
                  key={address.id}
                  position={[address.lat, address.lng]}
                  icon={markerIcon('address', address.hasReservePhoto ? 'done' : 'addressPending')}
                >
                  <Popup>
                    <AddressPopup address={address} />
                  </Popup>
                </Marker>
              ))}
            </MapContainer>
          </div>

          <div className="project-map-legend" aria-hidden="true">
            <span><span className="project-map-dot project-map-dot--red" /> adres bez zapasu</span>
            <span><span className="project-map-line project-map-line--underground" /> kabel doziemny</span>
            <span><span className="project-map-line project-map-line--aerial" /> kabel napowietrzny</span>
            <span><span className="project-map-line project-map-line--duct" /> rurociag</span>
            <span><span className="project-map-line project-map-line--done" /> gotowe</span>
            <span><Triangle size={13} className="project-map-legend-icon project-map-legend-icon--osd" /> OSD</span>
            <span><Circle size={13} className="project-map-legend-icon project-map-legend-icon--opp" /> OPP</span>
            <span><span className="project-map-legend-square project-map-legend-square--zs" /> ZS</span>
          </div>
        </>
      )}
    </div>
  );
}
