import type { Feature, GeoJsonObject, Geometry } from 'geojson';

import type { ProjectMapData } from './types';

export type MapBoundsPosition = [number, number];

function isGeoJsonObject(value: unknown): value is GeoJsonObject {
  return Boolean(value && typeof value === 'object' && 'type' in value);
}

function geometryFromGeojson(value: unknown): Geometry | null {
  if (!isGeoJsonObject(value)) return null;
  if (value.type === 'Feature') return (value as Feature).geometry;
  if (value.type === 'FeatureCollection') return null;
  return value as Geometry;
}

function toLatLng(coordinate: number[]): MapBoundsPosition | null {
  const [lng, lat] = coordinate;
  if (!Number.isFinite(lat) || !Number.isFinite(lng)) return null;
  return [lat, lng];
}

function collectGeometryPositions(value: unknown): MapBoundsPosition[] {
  const geometry = geometryFromGeojson(value);
  if (!geometry) return [];

  if (geometry.type === 'Point') {
    const point = toLatLng(geometry.coordinates);
    return point ? [point] : [];
  }

  if (geometry.type === 'LineString' || geometry.type === 'MultiPoint') {
    return geometry.coordinates.map(toLatLng).filter(Boolean) as MapBoundsPosition[];
  }

  if (geometry.type === 'MultiLineString' || geometry.type === 'Polygon') {
    return geometry.coordinates.flatMap((line) => line.map(toLatLng).filter(Boolean) as MapBoundsPosition[]);
  }

  if (geometry.type === 'MultiPolygon') {
    return geometry.coordinates.flatMap((polygon) =>
      polygon.flatMap((line) => line.map(toLatLng).filter(Boolean) as MapBoundsPosition[]),
    );
  }

  return [];
}

export function getMapBoundsPositions(data: ProjectMapData): MapBoundsPosition[] {
  return [
    ...data.addresses.map((address) => [address.lat, address.lng] as MapBoundsPosition),
    ...data.addressCandidates.map((candidate) => [candidate.lat, candidate.lng] as MapBoundsPosition),
    ...data.infraNodes.map((node) => [node.lat, node.lng] as MapBoundsPosition),
    ...data.trunkCables.flatMap((cable) => collectGeometryPositions(cable.geojson)),
    ...data.polygons.flatMap((polygon) => collectGeometryPositions(polygon.geojson)),
  ];
}
