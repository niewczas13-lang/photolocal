import Database from 'better-sqlite3';
import fs from 'node:fs';
import proj4 from 'proj4';
import wkx from 'wkx';
import type {
  AddressInput,
  CableRoutingType,
  GpkgExtractionResult,
  MapInfraNodeInput,
  MapPolygonInput,
  MapTrunkCableInput,
  MufaEntry,
  SplitterTopology,
} from '../types.js';

proj4.defs(
  'EPSG:2180',
  '+proj=tmerc +lat_0=0 +lon_0=19 +k=0.9993 +x_0=500000 +y_0=-5300000 +ellps=GRS80 +units=m +no_defs',
);

function q(tableName: string): string {
  return `"${tableName.replace(/"/g, '""')}"`;
}

function tableExists(db: Database.Database, tableName: string): boolean {
  const row = db
    .prepare("SELECT name FROM sqlite_master WHERE type = 'table' AND name = ?")
    .get(tableName) as { name: string } | undefined;
  return Boolean(row);
}

function getTableColumns(db: Database.Database, tableName: string): Set<string> {
  const rows = db.prepare(`PRAGMA table_info(${q(tableName)})`).all() as Array<{ name: string }>;
  return new Set(rows.map((row) => row.name));
}

function tableHasColumns(db: Database.Database, tableName: string, columns: string[]): boolean {
  if (!tableExists(db, tableName)) return false;
  const tableColumns = getTableColumns(db, tableName);
  return columns.every((column) => tableColumns.has(column));
}

function gpkgWkbOffset(buf: Buffer): number | null {
  if (!buf || buf.length < 8 || buf[0] !== 0x47 || buf[1] !== 0x50) {
    return null;
  }

  const flags = buf[3];
  const envelopeType = (flags >> 1) & 7;
  let offset = 8;
  if (envelopeType === 1) offset += 32;
  else if (envelopeType === 2 || envelopeType === 3) offset += 48;
  else if (envelopeType === 4) offset += 64;

  return offset < buf.length ? offset : null;
}

function parseGpkgPoint(buf: Buffer): { x: number; y: number } | null {
  const offset = gpkgWkbOffset(buf);
  if (offset == null) return null;

  const geometry = wkx.Geometry.parse(buf.subarray(offset));
  if (geometry instanceof wkx.Point) {
    return { x: geometry.x, y: geometry.y };
  }
  return null;
}

function parseGpkgGeoJSON(buf: Buffer): Record<string, unknown> | null {
  const offset = gpkgWkbOffset(buf);
  if (offset == null) return null;

  const geometry = wkx.Geometry.parse(buf.subarray(offset));
  return geometry.toGeoJSON() as Record<string, unknown>;
}

function reprojectGeometry(geometry: Record<string, unknown>): void {
  const transformCoords = (coords: unknown): void => {
    if (!Array.isArray(coords) || coords.length === 0) return;
    if (typeof coords[0] === 'number' && typeof coords[1] === 'number') {
      const [lng, lat] = proj4('EPSG:2180', 'WGS84', [coords[0], coords[1]]);
      coords[0] = lng;
      coords[1] = lat;
      return;
    }

    for (const child of coords) {
      transformCoords(child);
    }
  };

  transformCoords(geometry.coordinates);
}

function toNodeName(value: string): string {
  return value.includes('/') ? value.split('/').pop()!.trim() : value.trim();
}

function toScopedNodeName(value: string): string {
  return value.trim().replace(/^O_/, '');
}

function getNodeType(name: string): MapInfraNodeInput['nodeType'] | null {
  const nodeName = toNodeName(name);
  if (/^ZS/i.test(nodeName)) return 'ZS';
  if (/^OPP/i.test(nodeName)) return 'OPP';
  if (/^OSD/i.test(nodeName)) return 'OSD';
  return null;
}

function isInfraNode(name: string): boolean {
  return getNodeType(name) != null;
}

function isCoordinatePair(value: unknown): value is number[] {
  return (
    Array.isArray(value) &&
    typeof value[0] === 'number' &&
    typeof value[1] === 'number' &&
    Number.isFinite(value[0]) &&
    Number.isFinite(value[1])
  );
}

function lineSegmentsFromGeojson(geojson: Record<string, unknown>): number[][][] {
  const { type, coordinates } = geojson;
  if (type === 'LineString' && Array.isArray(coordinates)) {
    const line = coordinates.filter(isCoordinatePair);
    return line.length >= 2 ? [line] : [];
  }

  if (type === 'MultiLineString' && Array.isArray(coordinates)) {
    return coordinates
      .filter(Array.isArray)
      .map((line) => line.filter(isCoordinatePair))
      .filter((line) => line.length >= 2);
  }

  return [];
}

function cloneLineSegments(segments: number[][][]): number[][][] {
  return segments.map((line) => line.map((point) => [...point]));
}

function lineSegmentsLengthMeters(segments: number[][][]): number | null {
  let total = 0;
  for (const segment of segments) {
    for (let index = 1; index < segment.length; index += 1) {
      const previous = segment[index - 1];
      const current = segment[index];
      total += Math.hypot(current[0] - previous[0], current[1] - previous[1]);
    }
  }

  return total > 0 ? Math.round(total * 10) / 10 : null;
}

function distancePointToLineSegment(point: number[], start: number[], end: number[]): number {
  const dx = end[0] - start[0];
  const dy = end[1] - start[1];
  if (dx === 0 && dy === 0) {
    return Math.hypot(point[0] - start[0], point[1] - start[1]);
  }

  const t = Math.max(
    0,
    Math.min(1, ((point[0] - start[0]) * dx + (point[1] - start[1]) * dy) / (dx * dx + dy * dy)),
  );
  return Math.hypot(point[0] - (start[0] + t * dx), point[1] - (start[1] + t * dy));
}

function distancePointToLineSegments(point: number[], segments: number[][][]): number {
  let minDistance = Number.POSITIVE_INFINITY;
  for (const line of segments) {
    for (let index = 1; index < line.length; index += 1) {
      minDistance = Math.min(minDistance, distancePointToLineSegment(point, line[index - 1], line[index]));
    }
  }

  return minDistance;
}

function sampleLinePoints(line: number[][]): number[][] {
  const points = [...line];
  for (let index = 1; index < line.length; index += 1) {
    const previous = line[index - 1];
    const current = line[index];
    points.push([(previous[0] + current[0]) / 2, (previous[1] + current[1]) / 2]);
  }

  return points;
}

function lineRunsAlongProjectedConduit(line: number[][], projectedConduitSegments: number[][][]): boolean {
  const toleranceMeters = 2;
  const samplePoints = sampleLinePoints(line);
  return (
    samplePoints.length > 0 &&
    samplePoints.every((point) => distancePointToLineSegments(point, projectedConduitSegments) <= toleranceMeters)
  );
}

function cableRunsAlongProjectedConduit(
  cableSegments: number[][][],
  projectedConduitSegments: number[][][],
): boolean {
  if (projectedConduitSegments.length === 0) return false;
  return cableSegments.some((segment) => lineRunsAlongProjectedConduit(segment, projectedConduitSegments));
}

function addNullableLengths(left: number | null | undefined, right: number | null | undefined): number | null {
  if (left == null) return right == null ? null : right;
  if (right == null) return left;
  return Math.round((left + right) * 10) / 10;
}

function geojsonFromLineSegments(segments: number[][][]): Record<string, unknown> {
  return segments.length === 1
    ? { type: 'LineString', coordinates: segments[0] }
    : { type: 'MultiLineString', coordinates: segments };
}

function getTrunkCableKey(input: {
  rawName: string | null;
  fromNode: string;
  toNode: string;
  cableType: string;
}): string {
  return input.rawName?.trim() || `${input.fromNode}|${input.toNode}|${input.cableType}`;
}

function normalizeCableRoutingText(value: string): string {
  return value
    .normalize('NFD')
    .replace(/[\u0300-\u036f]/g, '')
    .toLowerCase();
}

function getCableRoutingType(
  row: Record<string, unknown>,
  cableType: string,
  rawName: string | null,
): CableRoutingType {
  const routeDescription = [row.typ_elementu, row.modyfikacja, row.uwagi]
    .filter((value): value is string => typeof value === 'string')
    .join(' ');
  const normalizedDescription = normalizeCableRoutingText(routeDescription);
  const hasExistingMarker = normalizedDescription.includes('istniej');
  const hasConduitMarker =
    normalizedDescription.includes('rurociag') ||
    normalizedDescription.includes('mikrokanalizacj');

  if (normalizedDescription.includes('kabel napowietrzny')) return 'aerial';
  if (normalizedDescription.includes('kabel doziemny')) return 'underground';
  if (hasExistingMarker && (normalizedDescription.includes('kanalizacj') || hasConduitMarker)) {
    return 'existing_duct';
  }
  if (normalizedDescription.includes('kabel w kanalizacji') || normalizedDescription.includes('kanalizacj')) {
    return 'existing_duct';
  }
  if (hasConduitMarker) return 'underground';
  return /ADSS/i.test(`${cableType} ${rawName ?? ''}`) ? 'aerial' : 'underground';
}

function normalizeColumnName(value: string): string {
  return value
    .normalize('NFD')
    .replace(/[\u0300-\u036f]/g, '')
    .replace(/[^a-z0-9]+/gi, '_')
    .toLowerCase();
}

function parseLengthMeters(value: unknown): number | null {
  if (typeof value === 'number' && Number.isFinite(value)) return Math.round(value * 10) / 10;
  if (typeof value !== 'string') return null;
  const normalized = value.replace(',', '.').replace(/[^\d.-]+/g, '').trim();
  if (!normalized) return null;
  const numeric = Number(normalized);
  return Number.isFinite(numeric) ? Math.round(numeric * 10) / 10 : null;
}

function getInstallationLengthMeters(row: Record<string, unknown>): number | null {
  for (const [key, value] of Object.entries(row)) {
    const normalizedKey = normalizeColumnName(key);
    const isInstallationLength =
      (normalizedKey.includes('dlugosc') && normalizedKey.includes('instal')) ||
      normalizedKey === 'dl_instalacyjna' ||
      normalizedKey === 'dl_inst';
    if (!isInstallationLength) continue;

    const length = parseLengthMeters(value);
    if (length != null) return length;
  }

  return null;
}

function isExistingPassiveDevice(value: unknown): boolean {
  return typeof value === 'string' && value.trim().toLowerCase().startsWith('istniej');
}

function isExistingLayerTable(tableName: string): boolean {
  return tableName.trim().startsWith('_');
}

function isGpkgInternalTable(tableName: string): boolean {
  const normalized = tableName.trim().toLowerCase();
  return (
    normalized.startsWith('sqlite_') ||
    normalized.startsWith('gpkg_') ||
    normalized.startsWith('rtree_')
  );
}

function getUserTableNames(db: Database.Database): string[] {
  const rows = db
    .prepare("SELECT name FROM sqlite_master WHERE type = 'table'")
    .all() as Array<{ name: string }>;
  return rows.map((row) => row.name).filter((name) => !isGpkgInternalTable(name));
}

function isProjectedConduitTable(tableName: string): boolean {
  if (isExistingLayerTable(tableName)) return false;
  const normalizedName = normalizeColumnName(tableName);
  return (
    normalizedName.includes('odcinki_kanalizacji') ||
    normalizedName.includes('rurociagi_mikrokanalizacja')
  );
}

function extractProjectedConduitSegments(db: Database.Database): number[][][] {
  const segments: number[][][] = [];

  for (const tableName of getUserTableNames(db)) {
    if (!isProjectedConduitTable(tableName) || !tableHasColumns(db, tableName, ['geom'])) continue;

    const rows = db.prepare(`SELECT geom FROM ${q(tableName)}`).all() as Array<Record<string, unknown>>;
    for (const row of rows) {
      if (!(row.geom instanceof Buffer)) continue;
      const geojson = parseGpkgGeoJSON(row.geom);
      if (!geojson) continue;
      segments.push(...lineSegmentsFromGeojson(geojson));
    }
  }

  return segments;
}

function findExistingTables(db: Database.Database, candidates: string[]): string[] {
  return candidates.filter((tableName) => tableExists(db, tableName));
}

export function inferSplitterTopology(splitterCount: number): SplitterTopology {
  return splitterCount > 2 ? 'CASCADE' : 'SINGLE';
}

export function normalizeCableAddressEntry(value: string): string | null {
  const parts = value
    .replace(/\s+/g, ' ')
    .split(',')
    .map((part) => part.trim())
    .filter(Boolean);

  if (parts.length === 0) return null;

  // If 3 or more parts (City, Street, Number), remove City.
  // If 2 parts (Street/Village, Number), keep both.
  const addressParts = parts.length >= 3 ? parts.slice(1) : parts;
  const cleaned = addressParts
    .join(' ')
    .replace(/^UL\.\s*/i, '')
    .replace(/\s+/g, ' ')
    .trim()
    .toUpperCase();

  return cleaned || null;
}

function countSplitters(db: Database.Database): number {
  const splitterTables = ['Urzadzenia Pasywne', 'Urządzenia Pasywne', '_Urzadzenia Pasywne', '_Urządzenia Pasywne', 'Plan_Urzadzenia Pasywne', 'Plan_Urządzenia Pasywne'];

  for (const tableName of splitterTables) {
    if (!tableExists(db, tableName)) continue;
    const row = db
      .prepare(
        `SELECT COUNT(*) AS count FROM ${q(tableName)}
         WHERE lower(coalesce(typ_elementu, '')) LIKE '%spliter%'
            OR upper(coalesce(model_urzadzenia, '')) LIKE 'SPL%'`,
      )
      .get() as { count: number };
    if (row.count > 0) return row.count;
  }

  let sum = 0;
  for (const tableName of ['K OPP', 'K OSD']) {
    if (!tableExists(db, tableName)) continue;
    const row = db
      .prepare(`SELECT coalesce(sum(coalesce(liczba_spliterow, 0)), 0) AS count FROM ${q(tableName)}`)
      .get() as { count: number };
    sum += Number(row.count ?? 0);
  }
  return sum;
}

function extractAddresses(db: Database.Database): {
  addresses: AddressInput[];
  totalPaRows: number;
  totalLokaleRows: number;
  skippedNoGeom: number;
  skippedBadGeom: number;
} {
  if (!tableExists(db, 'PA')) {
    throw new Error('Brak wymaganej warstwy PA w pliku GPKG.');
  }

  const osdByProperty = new Map<string, string>();
  let totalLokaleRows = 0;
  if (tableExists(db, 'Lokale')) {
    const rows = db.prepare(`SELECT id_posesja_opl, opp_osd FROM ${q('Lokale')}`).all() as Array<{
      id_posesja_opl: unknown;
      opp_osd: unknown;
    }>;
    totalLokaleRows = rows.length;
    for (const row of rows) {
      const key = row.id_posesja_opl == null ? '' : String(row.id_posesja_opl).trim();
      const val = row.opp_osd == null ? '' : String(row.opp_osd).trim();
      if (key && val) osdByProperty.set(key, val);
    }
  }

  const paRows = db.prepare(`SELECT * FROM ${q('PA')}`).all() as Array<Record<string, unknown>>;
  const addresses: AddressInput[] = [];

  for (const row of paRows) {
    const propertyId = row.id_posesja_opl == null ? '' : String(row.id_posesja_opl).trim();
    let lat: number | null = null;
    let lng: number | null = null;
    if (row.geom instanceof Buffer) {
      try {
        const point = parseGpkgPoint(row.geom);
        if (point) {
          const [nextLng, nextLat] = proj4('EPSG:2180', 'WGS84', [point.x, point.y]);
          if (
            Number.isFinite(nextLat) &&
            Number.isFinite(nextLng) &&
            nextLat >= 48 &&
            nextLat <= 56 &&
            nextLng >= 13 &&
            nextLng <= 25
          ) {
            lat = nextLat;
            lng = nextLng;
          }
        }
      } catch {
        lat = null;
        lng = null;
      }
    }

    addresses.push({
      city: row.nazwa_miejsc == null ? '' : String(row.nazwa_miejsc).trim(),
      street: row.nazwa_ul == null ? '' : String(row.nazwa_ul).trim(),
      buildingNo: row.nr_domu == null ? null : String(row.nr_domu).trim(),
      propertyId: propertyId || null,
      parcelNumber: row.nr_dzialki == null ? null : String(row.nr_dzialki).trim(),
      distributionPoint: osdByProperty.get(propertyId) ?? null,
      lat,
      lng,
      householdCount: 0,
      businessUnitCount: 0,
    });
  }

  return {
    addresses,
    totalPaRows: paRows.length,
    totalLokaleRows,
    skippedNoGeom: 0,
    skippedBadGeom: 0,
  };
}

function extractMapGeometry(db: Database.Database): {
  polygons: MapPolygonInput[];
  trunkCables: MapTrunkCableInput[];
  infraNodes: MapInfraNodeInput[];
  passiveInfraNodes: MapInfraNodeInput[];
} {
  const polygons: MapPolygonInput[] = [];
  const polygonTables = ['Rejonizacja', 'rejonizacja', 'REJONIZACJA'];
  for (const tableName of polygonTables) {
    if (!tableExists(db, tableName)) continue;
    const rows = db.prepare(`SELECT * FROM ${q(tableName)}`).all() as Array<Record<string, unknown>>;
    for (const row of rows) {
      const label = row.rejonizacja == null ? '' : String(row.rejonizacja).trim();
      const terminalName = toNodeName(label);
      const osdName = toScopedNodeName(label);
      if (!/^(OSD|OPP)/i.test(terminalName)) continue;
      if (!(row.geom instanceof Buffer)) continue;

      const geojson = parseGpkgGeoJSON(row.geom);
      if (!geojson) continue;
      reprojectGeometry(geojson);

      polygons.push({
        osdName,
        label: label || null,
        geojson,
        households: typeof row.liczba_hh === 'number' ? row.liczba_hh : null,
        paCount: typeof row.liczba_pa === 'number' ? row.liczba_pa : null,
        cableRef: row.nr_kabla == null ? null : String(row.nr_kabla).trim() || null,
      });
    }
    if (rows.length > 0) break;
  }

  const trunkCableMap = new Map<
    string,
    { cable: Omit<MapTrunkCableInput, 'geojson'>; segments: number[][][] }
  >();
  const infraNodeMap = new Map<string, MapInfraNodeInput>();
  const passiveInfraNodeMap = new Map<string, MapInfraNodeInput>();
  const setInfraNode = (node: MapInfraNodeInput): void => {
    infraNodeMap.set(`${node.nodeType}:${node.name}`, node);
  };
  const setPassiveInfraNode = (node: MapInfraNodeInput): void => {
    passiveInfraNodeMap.set(`${node.nodeType}:${node.name}`, node);
    setInfraNode(node);
  };
  const cableTable = [
    'Kable Swiatlowodowe',
    'Kable Światłowodowe',
    'Kable ĹšwiatĹ‚owodowe',
  ].find((tableName) => tableExists(db, tableName));

  const projectedConduitSegments = extractProjectedConduitSegments(db);

  if (cableTable) {
    const rows = db.prepare(`SELECT * FROM ${q(cableTable)}`).all() as Array<Record<string, unknown>>;
    for (const row of rows) {
      const cableType = row.model_kabla == null ? '' : String(row.model_kabla).trim();
      const fromLabel = row.od == null ? '' : String(row.od).trim();
      const toLabel = row.do == null ? '' : String(row.do).trim();
      const fromNode = toScopedNodeName(fromLabel);
      const toNode = toScopedNodeName(toLabel);
      if (!cableType || !fromNode || !toNode || !isInfraNode(fromNode) || !isInfraNode(toNode)) {
        continue;
      }
      if (!(row.geom instanceof Buffer)) continue;

      const geojson = parseGpkgGeoJSON(row.geom);
      if (!geojson) continue;
      const projectedSegments = cloneLineSegments(lineSegmentsFromGeojson(geojson));
      const routeLengthMeters = lineSegmentsLengthMeters(projectedSegments);
      const installationLengthMeters = getInstallationLengthMeters(row);
      reprojectGeometry(geojson);
      const segments = lineSegmentsFromGeojson(geojson);
      if (segments.length === 0) continue;

      const fromNodeType = getNodeType(fromNode);
      const toNodeType = getNodeType(toNode);
      const osdName = toNodeType === 'OSD'
        ? toNode
        : fromNodeType === 'OSD'
          ? fromNode
          : toNode;
      const rawName = row.odcinek_kabla == null ? null : String(row.odcinek_kabla).trim() || null;
      const baseRoutingType = getCableRoutingType(row, cableType, rawName);
      const routingType =
        baseRoutingType === 'existing_duct' &&
        cableRunsAlongProjectedConduit(projectedSegments, projectedConduitSegments)
          ? 'underground'
          : baseRoutingType;
      const cableKey = getTrunkCableKey({ rawName, fromNode, toNode, cableType });
      const existingCable = trunkCableMap.get(cableKey);

      if (existingCable) {
        existingCable.segments.push(...segments);
        existingCable.cable.routeLengthMeters = addNullableLengths(
          existingCable.cable.routeLengthMeters,
          routeLengthMeters,
        );
        existingCable.cable.installationLengthMeters = addNullableLengths(
          existingCable.cable.installationLengthMeters,
          installationLengthMeters,
        );
        if (routingType === 'aerial') existingCable.cable.routingType = routingType;
        if (routingType === 'existing_duct' && existingCable.cable.routingType !== 'aerial') {
          existingCable.cable.routingType = routingType;
        }
      } else {
        trunkCableMap.set(cableKey, {
          cable: {
            cableType,
            fromNode,
            toNode,
            osdName,
            rawName,
            routingType,
            routeLengthMeters,
            installationLengthMeters,
          },
          segments: [...segments],
        });
      }

      const firstSegment = segments[0];
      const lastSegment = segments[segments.length - 1];
      const first = firstSegment[0];
      const last = lastSegment[lastSegment.length - 1];
      const firstType = getNodeType(fromNode);
      const lastType = getNodeType(toNode);
      if (
        firstType &&
        Array.isArray(first) &&
        typeof first[0] === 'number' &&
        typeof first[1] === 'number' &&
        !infraNodeMap.has(`${firstType}:${fromNode}`)
      ) {
        setInfraNode({
          nodeType: firstType,
          name: fromNode,
          label: fromLabel || null,
          lat: first[1],
          lng: first[0],
        });
      }
      if (
        lastType &&
        Array.isArray(last) &&
        typeof last[0] === 'number' &&
        typeof last[1] === 'number' &&
        !infraNodeMap.has(`${lastType}:${toNode}`)
      ) {
        setInfraNode({
          nodeType: lastType,
          name: toNode,
          label: toLabel || null,
          lat: last[1],
          lng: last[0],
        });
      }
    }
  }

  const passiveDeviceTables = findExistingTables(db, [
    'Urzadzenia Pasywne',
    'UrzÄ…dzenia Pasywne',
    'Urządzenia Pasywne',
    '_Urzadzenia Pasywne',
    '_UrzÄ…dzenia Pasywne',
    '_Urządzenia Pasywne',
    'Plan_Urzadzenia Pasywne',
    'Plan_UrzÄ…dzenia Pasywne',
    'Plan_Urządzenia Pasywne',
  ]);

  const projectedSpliceNodes = extractProjectedSpliceNodes(db);

  for (const tableName of passiveDeviceTables) {
    if (!tableHasColumns(db, tableName, ['wezel', 'geom'])) continue;

    const rows = db.prepare(`SELECT * FROM ${q(tableName)}`).all() as Array<Record<string, unknown>>;
    const requiresProjectedSplice = isExistingLayerTable(tableName);
    for (const row of rows) {
      const rawNode = typeof row.wezel === 'string' ? row.wezel.trim() : '';
      const nodeName = toScopedNodeName(rawNode);
      const nodeType = getNodeType(rawNode);
      if (!nodeType || !(row.geom instanceof Buffer)) continue;
      const canonicalNode = canonicalInfraNodeName(nodeName);
      if (requiresProjectedSplice) {
        if (!canonicalNode || !projectedSpliceNodes.has(canonicalNode)) continue;
      } else if (isExistingPassiveDevice(row.modyfikacja)) {
        continue;
      }

      let point: { x: number; y: number } | null = null;
      try {
        point = parseGpkgPoint(row.geom);
      } catch {
        point = null;
      }
      if (!point) continue;

      const [lng, lat] = proj4('EPSG:2180', 'WGS84', [point.x, point.y]);
      if (!Number.isFinite(lat) || !Number.isFinite(lng)) continue;
      const label =
        (typeof row.oznaczenie === 'string' && row.oznaczenie.trim()) ||
        (typeof row.oznaczenie_urzadzenia === 'string' && row.oznaczenie_urzadzenia.trim()) ||
        rawNode ||
        null;

      setPassiveInfraNode({
        nodeType,
        name: nodeName,
        label,
        lat,
        lng,
      });
    }
  }

  return {
    polygons,
    trunkCables: [...trunkCableMap.values()].map(({ cable, segments }) => ({
      ...cable,
      geojson: geojsonFromLineSegments(segments),
    })),
    infraNodes: [...infraNodeMap.values()],
    passiveInfraNodes: [...passiveInfraNodeMap.values()],
  };
}

function extractCableEntries(db: Database.Database): {
  totalCableRows: number;
  dacToAddressCableEntries: string[];
  adssToAddressCableEntries: string[];
} {
  if (!tableExists(db, 'Kable Światłowodowe') && !tableExists(db, 'Kable Swiatlowodowe')) {
    return { totalCableRows: 0, dacToAddressCableEntries: [], adssToAddressCableEntries: [] };
  }

  const tableName = tableExists(db, 'Kable Światłowodowe') ? 'Kable Światłowodowe' : 'Kable Swiatlowodowe';
  const rows = db.prepare(`SELECT * FROM ${q(tableName)}`).all() as Array<Record<string, unknown>>;
  const dac = new Set<string>();
  const adss = new Set<string>();

  for (const row of rows) {
    const elementType = row.typ_elementu == null ? '' : String(row.typ_elementu);
    const destination = row.do == null ? '' : String(row.do);
    const entry = normalizeCableAddressEntry(destination);
    if (!entry) continue;

    if (/Kabel doziemny|Kabel w kanalizacji/i.test(elementType)) {
      dac.add(entry);
    } else if (/Kabel napowietrzny/i.test(elementType)) {
      adss.add(entry);
    }
  }

  return {
    totalCableRows: rows.length,
    dacToAddressCableEntries: [...dac].sort((a, b) => a.localeCompare(b, 'pl')),
    adssToAddressCableEntries: [...adss].sort((a, b) => a.localeCompare(b, 'pl')),
  };
}

function extractProjectName(db: Database.Database): string | null {
  try {
    if (tableExists(db, 'npd_suite_metadane')) {
      const rows = db.prepare(`SELECT klucz, wartosc FROM ${q('npd_suite_metadane')}`).all() as Array<Record<string, unknown>>;
      
      const sapOpisRow = rows.find(r => typeof r.klucz === 'string' && r.klucz.toLowerCase() === 'sap_opis');
      if (sapOpisRow && typeof sapOpisRow.wartosc === 'string' && sapOpisRow.wartosc.trim().length > 0) {
        return sapOpisRow.wartosc.trim();
      }
      
      const glProjectRow = rows.find(r => typeof r.klucz === 'string' && r.klucz.toLowerCase() === 'gl_project');
      if (glProjectRow && typeof glProjectRow.wartosc === 'string' && glProjectRow.wartosc.trim().length > 0) {
        return glProjectRow.wartosc.trim();
      }
    }

    const allTables = db.prepare(`SELECT name FROM sqlite_master WHERE type='table'`).all() as {name: string}[];
    
    // Próba 1: Szukamy po nazwach kolumn (sap, projekt, zadanie)
    for (const t of allTables) {
      if (t.name.startsWith('sqlite_') || t.name.startsWith('gpkg_') || t.name.startsWith('rtree_')) continue;
      
      const rows = db.prepare(`SELECT * FROM ${q(t.name)} LIMIT 1`).all() as Array<Record<string, unknown>>;
      if (rows.length === 0) continue;
      
      for (const [key, value] of Object.entries(rows[0])) {
        const k = key.toLowerCase();
        if ((k.includes('sap') || k.includes('zadania') || k.includes('projekt')) && typeof value === 'string' && value.length > 3) {
          return value.trim();
        }
      }
    }
    
    // Próba 2: Szukamy jakiejkolwiek wartości tekstowej, która wygląda jak kod projektu (np. Q_KPO_..., dużo podkreślników)
    for (const t of allTables) {
      if (t.name.startsWith('sqlite_') || t.name.startsWith('gpkg_') || t.name.startsWith('rtree_')) continue;
      
      const rows = db.prepare(`SELECT * FROM ${q(t.name)} LIMIT 50`).all() as Array<Record<string, unknown>>;
      for (const row of rows) {
        for (const value of Object.values(row)) {
          if (typeof value === 'string') {
            const v = value.trim();
            if (/^Q_(KPO|SI)_[A-Z0-9_]+$/i.test(v)) return v;
            if (v.length > 15 && (v.match(/_/g) || []).length >= 4 && !v.includes(' ')) return v;
          }
        }
      }
    }
  } catch (err) {}
  
  return null;
}

function extractSplices(db: Database.Database): MufaEntry[] {
  const tables = ['Urządzenia Pasywne', '_Urządzenia Pasywne', 'Urzadzenia Pasywne', '_Urzadzenia Pasywne'];
  const results = new Map<string, MufaEntry>();
  const projectedSpliceNodes = extractProjectedSpliceNodes(db);

  for (const tableName of tables) {
    if (!tableExists(db, tableName)) continue;
    
    try {
      // Wyciągamy wszystko, co może mieć nazwę z ZS
      const rows = db.prepare(`SELECT * FROM ${q(tableName)}`).all() as Array<Record<string, unknown>>;
      const requiresProjectedSplice = isExistingLayerTable(tableName);
      for (const row of rows) {
        const modyfikacja = typeof row.modyfikacja === 'string' ? row.modyfikacja.trim() : null;
        if (!requiresProjectedSplice && isExistingPassiveDevice(modyfikacja)) {
          continue; // Pomiń mufy istniejące
        }

        const wezel = typeof row.wezel === 'string' ? row.wezel.trim() : null;
        const oznaczenie = typeof row.oznaczenie === 'string' ? row.oznaczenie.trim() : wezel;
        
        const hasZS = wezel?.includes('ZS') || oznaczenie?.includes('ZS');
        const hasOSD = wezel?.includes('OSD') || oznaczenie?.includes('OSD');
        const canonicalWezel = canonicalZsName(wezel);
        const canonicalOznaczenie = canonicalZsName(oznaczenie);
        const hasProjectedSplice =
          (canonicalWezel && projectedSpliceNodes.has(canonicalWezel)) ||
          (canonicalOznaczenie && projectedSpliceNodes.has(canonicalOznaczenie));
        if (requiresProjectedSplice && !hasProjectedSplice) continue;
        
        // Według uwag: ma być to ZS (np. po nazwie wezła ZS00004), a nie OSD.
        if (wezel && hasZS && !hasOSD && hasProjectedSplice) {
          results.set(wezel, { wezel, oznaczenie: oznaczenie || wezel });
        }
      }
    } catch (err) {}
  }

  const zsList = Array.from(results.values()).sort((a, b) => a.wezel.localeCompare(b.wezel, 'pl'));
  return zsList;
}

function extractProjectedSpliceNodes(db: Database.Database): Set<string> {
  const fiberTables = ['Włókna', 'Wlokna'];
  const requiredColumns = [
    'wezel_pocz',
    'oznaczenie_urzadzenia_pocz',
    'typ_polaczenia_pocz',
    'pigtail_pocz_spaw',
    'wezel_kon',
    'oznaczenie_urzadzenia_kon',
    'typ_polaczenia_kon',
    'pigtail_kon_spaw',
  ];
  const nodes = new Set<string>();

  for (const tableName of fiberTables) {
    if (!tableHasColumns(db, tableName, requiredColumns)) continue;

    const rows = db.prepare(`SELECT * FROM ${q(tableName)}`).all() as Array<Record<string, unknown>>;
    for (const row of rows) {
      if (!hasProjectedSpliceMarker(row)) continue;

      for (const field of ['wezel_pocz', 'oznaczenie_urzadzenia_pocz', 'wezel_kon', 'oznaczenie_urzadzenia_kon']) {
        const value = typeof row[field] === 'string' ? row[field] : '';
        const nodeName = canonicalInfraNodeName(value);
        if (nodeName) nodes.add(nodeName);
      }
    }
  }

  return nodes;
}

function hasProjectedSpliceMarker(row: Record<string, unknown>): boolean {
  return ['typ_polaczenia_pocz', 'pigtail_pocz_spaw', 'typ_polaczenia_kon', 'pigtail_kon_spaw'].some((field) => {
    const value = typeof row[field] === 'string' ? row[field].toLowerCase() : '';
    return value.includes('spaw') && value.includes('projekt');
  });
}

function canonicalZsName(value: string | null): string | null {
  const nodeName = canonicalInfraNodeName(value);
  return nodeName && /\/ZS\d+$/i.test(nodeName) ? nodeName : null;
}

function canonicalInfraNodeName(value: string | null): string | null {
  if (!value) return null;
  const normalized = value.trim().replace(/^O_/, '');
  const match = /([^,;|\r\n]+\/(?:OPP|OSD|ZS)\d+)/i.exec(normalized);
  return match ? match[1].trim().replace(/^O_/, '').toUpperCase() : null;
}

export function extractSplicePlaceholder(): void {} // keep lint happy

function extractProjectDefinition(db: Database.Database): string | null {
  // Pattern: letter/digits e.g. X/04009120 or F/04001314
  const codePattern = /^[A-Z]\/(\d{6,10})$/;

  const candidateTables = ['_Obiekty', 'Obiekty'];
  for (const tableName of candidateTables) {
    if (!tableExists(db, tableName)) continue;
    try {
      const rows = db.prepare(`SELECT * FROM ${q(tableName)} LIMIT 200`).all() as Array<Record<string, unknown>>;
      for (const row of rows) {
        for (const [key, value] of Object.entries(row)) {
          if (key === 'did' || key === 'geom') continue;
          if (typeof value === 'string' && codePattern.test(value.trim())) {
            return value.trim();
          }
        }
      }
    } catch (e) {}
  }

  // Fallback: scan all tables
  try {
    const allTables = db.prepare(`SELECT name FROM sqlite_master WHERE type='table'`).all() as {name: string}[];
    for (const t of allTables) {
      if (t.name.startsWith('sqlite_') || t.name.startsWith('gpkg_') || t.name.startsWith('rtree_')) continue;
      if (candidateTables.includes(t.name)) continue;
      const rows = db.prepare(`SELECT * FROM ${q(t.name)} LIMIT 100`).all() as Array<Record<string, unknown>>;
      for (const row of rows) {
        for (const [key, value] of Object.entries(row)) {
          if (key === 'did' || key === 'geom') continue;
          if (typeof value === 'string' && codePattern.test(value.trim())) {
            return value.trim();
          }
        }
      }
    }
  } catch (e) {}

  return null;
}

export function extractGpkg(filePath: string): GpkgExtractionResult {
  if (!fs.existsSync(filePath)) {
    throw new Error(`Plik GPKG nie istnieje: ${filePath}`);
  }

  const db = new Database(filePath, { readonly: true });
  try {
    const addresses = extractAddresses(db);
    const cables = extractCableEntries(db);
    const splitterCount = countSplitters(db);
    const suggestedProjectName = extractProjectName(db);
    const suggestedProjectDefinition = extractProjectDefinition(db);
    const splices = extractSplices(db);
    const mapGeometry = extractMapGeometry(db);

    return {
      suggestedProjectName,
      suggestedProjectDefinition,
      splices,
      addresses: addresses.addresses,
      polygons: mapGeometry.polygons,
      trunkCables: mapGeometry.trunkCables,
      infraNodes: mapGeometry.infraNodes,
      passiveInfraNodes: mapGeometry.passiveInfraNodes,
      dacToAddressCableEntries: cables.dacToAddressCableEntries,
      adssToAddressCableEntries: cables.adssToAddressCableEntries,
      splitterCount,
      suggestedSplitterTopology: inferSplitterTopology(splitterCount),
      totalPaRows: addresses.totalPaRows,
      totalLokaleRows: addresses.totalLokaleRows,
      totalCableRows: cables.totalCableRows,
      skippedNoGeom: addresses.skippedNoGeom,
      skippedBadGeom: addresses.skippedBadGeom,
    };
  } finally {
    db.close();
  }
}
