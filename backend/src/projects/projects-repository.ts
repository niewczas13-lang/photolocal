import type Database from 'better-sqlite3';
import { randomUUID } from 'node:crypto';
import type {
  ChecklistNodeRecord,
  ChecklistNodeSource,
  ChecklistNodeType,
  CableRoutingType,
  MapAddressCandidateAssignmentSource,
  MapAddressCandidateStatus,
  MapCableStatus,
  MapInfraNodeInput,
  MapInfrastructureFeatureInput,
  MapNoteTargetType,
  MapNodeStatus,
  MapPolygonInput,
  ProjectMapAddressStatus,
  ProjectMapAddressCandidate,
  ProjectMapPhoto,
  MapTrunkCableInput,
  ProjectMapNote,
  ProjectMapNotePhoto,
  ProjectMapRecord,
  ProjectRecord,
  ProjectType,
  ReserveLocationKind,
  SplitterTopology,
  SplitterTopologySource,
} from '../types.js';
import type { GeneratedChecklistNode, ChecklistAddress } from '../checklist/checklist-generator.js';
import { listKnownProjectPhotoHashes } from '../photos/photo-hash-cache.js';
import { safeFolderName, toAddressFolderName } from '../utils/path-names.js';

const STALE_GPKG_NODE_REASON = 'Nie wystepuje w ostatnio przeliczonym GPKG';

export interface AddPhotoInput {
  id: string;
  projectId: string;
  checklistNodeId: string;
  sourceFileName: string;
  storedFileName: string;
  storagePath: string;
  thumbnailPath: string | null;
  mimeType: string;
  fileSize: number;
  lat: number | null;
  lng: number | null;
  capturedAt: string | null;
  reserveLocation: string | null;
  contentHash?: string | null;
}

export interface AddMapNoteInput {
  projectId: string;
  targetType: MapNoteTargetType;
  targetId: string | null;
  targetLabel: string | null;
  body: string;
  lat: number | null;
  lng: number | null;
}

export interface AddMapAddressCandidateInput {
  projectId: string;
  lat: number;
  lng: number;
  city: string;
  street: string;
  buildingNo: string | null;
  postalCode: string | null;
  propertyId: string | null;
  parcelNumber: string | null;
  geocoderSource: string;
  geocoderDistanceMeters: number | null;
}

export interface ApproveMapAddressCandidateInput {
  projectId: string;
  candidateId: string;
  city: string;
  street: string;
  buildingNo: string | null;
  propertyId: string | null;
  parcelNumber: string | null;
  distributionPoint: string | null;
  reserveLocation: ReserveLocationKind;
  createDistributionNodeType: 'OSD' | 'OPP' | null;
  oplConsentConfirmed?: boolean;
  noteBody?: string | null;
}

export interface UpdateMapNoteInput {
  body: string;
  lat?: number | null;
  lng?: number | null;
}

export interface AddMapNotePhotoInput {
  id: string;
  projectId: string;
  noteId: string;
  sourceFileName: string;
  storedFileName: string;
  storagePath: string;
  thumbnailPath: string | null;
  mimeType: string;
  fileSize: number;
  lat: number | null;
  lng: number | null;
  capturedAt: string | null;
}

export interface ChecklistPhotoRecord {
  id: string;
  projectId: string;
  checklistNodeId: string;
  sourceFileName: string;
  storedFileName: string;
  storagePath: string;
  thumbnailPath: string | null;
  mimeType: string;
  fileSize: number;
  lat: number | null;
  lng: number | null;
  capturedAt: string | null;
  uploadedAt: string;
  reserveLocation: string | null;
}

export interface MovePhotoRecordInput {
  projectId: string;
  photoId: string;
  sourceNodeId: string;
  targetNodeId: string;
  storedFileName: string;
  storagePath: string;
  thumbnailPath: string | null;
  reserveLocation: string | null;
}

export interface CreateProjectInput {
  name: string;
  projectDefinition: string | null;
  projectType: ProjectType;
  splitterTopology: SplitterTopology;
  splitterTopologySource: SplitterTopologySource;
  splitterCount: number;
  gpkgFileName: string;
  baseFolder: string;
  addresses: ChecklistAddress[];
  dacToAddressCableCount: number;
  adssToAddressCableCount: number;
  checklistNodes: GeneratedChecklistNode[];
  polygons?: MapPolygonInput[];
  trunkCables?: MapTrunkCableInput[];
  infraNodes?: MapInfraNodeInput[];
  infrastructureFeatures?: MapInfrastructureFeatureInput[];
}

export interface RecalculateChecklistInput {
  projectId: string;
  projectDefinition: string | null;
  projectType: ProjectType;
  splitterTopology: SplitterTopology;
  splitterTopologySource: SplitterTopologySource;
  splitterCount: number;
  gpkgFileName: string;
  addresses: ChecklistAddress[];
  dacToAddressCableCount: number;
  adssToAddressCableCount: number;
  checklistNodes: GeneratedChecklistNode[];
  polygons?: MapPolygonInput[];
  trunkCables?: MapTrunkCableInput[];
  infraNodes?: MapInfraNodeInput[];
  infrastructureFeatures?: MapInfrastructureFeatureInput[];
}

export interface RecalculateChecklistResult {
  addedNodes: number;
  updatedNodes: number;
  unchangedNodes: number;
  addedAddresses: number;
  reusedAddresses: number;
  removedStaleNodes: number;
  preservedAssignedStaleNodes: number;
}

export interface AddManualChecklistNodeInput {
  projectId: string;
  parentId: string | null;
  name: string;
  nodeType: ChecklistNodeType;
  minPhotos: number;
  acceptsPhotos: boolean;
}

function normalizeAddressKeyPart(value: string | null): string {
  return (value ?? '').trim().replace(/\s+/g, ' ').toUpperCase();
}

function getAddressMergeKey(address: {
  city: string;
  street: string;
  buildingNo: string | null;
  distributionPoint: string | null;
}): string {
  return [
    normalizeAddressKeyPart(address.city),
    normalizeAddressKeyPart(address.street),
    normalizeAddressKeyPart(address.buildingNo),
    normalizeAddressKeyPart(address.distributionPoint),
  ].join('|');
}

function normalizeMapNodeKey(value: string | null): string {
  const raw = (value ?? '').trim().toUpperCase();
  if (!raw) return '';
  return raw.replace(/^O_/, '').replace(/\s+/g, '');
}

function normalizeMapNodeTerminalKey(value: string | null): string {
  const raw = normalizeMapNodeKey(value);
  if (!raw) return '';
  return raw.split(/[\\/]/).at(-1) ?? raw;
}

function normalizeSearchKey(value: string | null): string {
  return (value ?? '').toUpperCase().replace(/[^A-Z0-9]/g, '');
}

function getMapCableKey(
  cable: Pick<MapTrunkCableInput, 'cableKey' | 'rawName' | 'fromNode' | 'toNode' | 'cableType'>,
): string {
  const cableKey = cable.cableKey?.trim();
  if (cableKey) return cableKey;
  const rawName = cable.rawName?.trim();
  return rawName || `${cable.fromNode}|${cable.toNode}|${cable.cableType}`;
}

function getCableStatusInheritanceKey(input: {
  rawName: string | null;
  fromNode: string;
  toNode: string;
  cableType: string;
}): string {
  const rawName = input.rawName?.trim();
  if (rawName) return `raw:${rawName.toUpperCase()}`;
  return `nodes:${input.fromNode}|${input.toNode}|${input.cableType}`.toUpperCase();
}

function getCableRoutingType(cable: Pick<MapTrunkCableInput, 'routingType' | 'cableType' | 'rawName'>): CableRoutingType {
  if (
    cable.routingType === 'aerial' ||
    cable.routingType === 'underground' ||
    cable.routingType === 'existing_duct'
  ) {
    return cable.routingType;
  }
  return /ADSS/i.test(`${cable.cableType} ${cable.rawName ?? ''}`) ? 'aerial' : 'underground';
}

function buildAddressLabel(address: {
  city: string;
  street: string;
  buildingNo: string | null;
}): string {
  const street = [address.street, address.buildingNo].filter(Boolean).join(' ').trim();
  return [street, address.city].filter(Boolean).join(', ');
}

function parseGeojson(value: string): Record<string, unknown> {
  const parsed = JSON.parse(value) as unknown;
  return parsed && typeof parsed === 'object' && !Array.isArray(parsed) ? (parsed as Record<string, unknown>) : {};
}

function asGeometry(value: Record<string, unknown>): Record<string, unknown> | null {
  if (value.type === 'Feature') {
    const geometry = value.geometry;
    return geometry && typeof geometry === 'object' && !Array.isArray(geometry)
      ? (geometry as Record<string, unknown>)
      : null;
  }
  return value;
}

function isCoordinate(value: unknown): value is [number, number] {
  return (
    Array.isArray(value) &&
    value.length >= 2 &&
    typeof value[0] === 'number' &&
    typeof value[1] === 'number'
  );
}

function pointInRing(lng: number, lat: number, ring: unknown[]): boolean {
  let inside = false;
  for (let index = 0, previousIndex = ring.length - 1; index < ring.length; previousIndex = index++) {
    const current = ring[index];
    const previous = ring[previousIndex];
    if (!isCoordinate(current) || !isCoordinate(previous)) continue;

    const [currentLng, currentLat] = current;
    const [previousLng, previousLat] = previous;
    const intersects =
      currentLat > lat !== previousLat > lat &&
      lng < ((previousLng - currentLng) * (lat - currentLat)) / (previousLat - currentLat) + currentLng;
    if (intersects) inside = !inside;
  }
  return inside;
}

function pointInPolygonCoordinates(lng: number, lat: number, polygon: unknown[]): boolean {
  const [outerRing, ...holes] = polygon;
  if (!Array.isArray(outerRing) || !pointInRing(lng, lat, outerRing)) return false;
  return !holes.some((hole) => Array.isArray(hole) && pointInRing(lng, lat, hole));
}

function pointInGeojson(lng: number, lat: number, value: Record<string, unknown>): boolean {
  const geometry = asGeometry(value);
  if (!geometry) return false;

  if (geometry.type === 'Polygon' && Array.isArray(geometry.coordinates)) {
    return pointInPolygonCoordinates(lng, lat, geometry.coordinates);
  }

  if (geometry.type === 'MultiPolygon' && Array.isArray(geometry.coordinates)) {
    return geometry.coordinates.some((polygon) => Array.isArray(polygon) && pointInPolygonCoordinates(lng, lat, polygon));
  }

  return false;
}

function buildCandidateLabel(candidate: {
  city: string;
  street: string;
  buildingNo: string | null;
  lat: number;
  lng: number;
}): string {
  const label = buildAddressLabel(candidate);
  return label || `Punkt ${candidate.lat.toFixed(5)}, ${candidate.lng.toFixed(5)}`;
}

function mapAddressCandidateRow(row: {
  id: string;
  status: MapAddressCandidateStatus;
  city: string;
  street: string;
  buildingNo: string | null;
  postalCode: string | null;
  propertyId: string | null;
  parcelNumber: string | null;
  lat: number;
  lng: number;
  geocoderSource: string;
  geocoderDistanceMeters: number | null;
  suggestedDistributionPoint: string | null;
  assignmentSource: MapAddressCandidateAssignmentSource;
  approvedAddressId: string | null;
  reserveLocation: ReserveLocationKind | null;
  createdAt: string;
  updatedAt: string;
}): ProjectMapAddressCandidate {
  const lat = Number(row.lat);
  const lng = Number(row.lng);
  return {
    id: row.id,
    label: buildCandidateLabel({
      city: row.city,
      street: row.street,
      buildingNo: row.buildingNo,
      lat,
      lng,
    }),
    status: row.status,
    city: row.city,
    street: row.street,
    buildingNo: row.buildingNo,
    postalCode: row.postalCode,
    propertyId: row.propertyId,
    parcelNumber: row.parcelNumber,
    lat,
    lng,
    geocoderSource: row.geocoderSource,
    geocoderDistanceMeters: row.geocoderDistanceMeters == null ? null : Number(row.geocoderDistanceMeters),
    suggestedDistributionPoint: row.suggestedDistributionPoint,
    assignmentSource: row.assignmentSource,
    approvedAddressId: row.approvedAddressId,
    reserveLocation: row.reserveLocation,
    createdAt: row.createdAt,
    updatedAt: row.updatedAt,
  };
}

function mapNotePhotoRow(row: {
  id: string;
  noteId: string;
  sourceFileName: string;
  storedFileName: string;
  storagePath: string;
  thumbnailPath: string | null;
  mimeType: string;
  fileSize: number | null;
  lat: number | null;
  lng: number | null;
  capturedAt: string | null;
  uploadedAt: string;
}): ProjectMapNotePhoto {
  return {
    id: row.id,
    noteId: row.noteId,
    sourceFileName: row.sourceFileName,
    storedFileName: row.storedFileName,
    storagePath: row.storagePath,
    thumbnailPath: row.thumbnailPath,
    mimeType: row.mimeType,
    fileSize: row.fileSize,
    lat: row.lat == null ? null : Number(row.lat),
    lng: row.lng == null ? null : Number(row.lng),
    capturedAt: row.capturedAt,
    uploadedAt: row.uploadedAt,
  };
}

function mapProjectPhotoRow(row: {
  id: string;
  checklistNodeId: string;
  storedFileName: string;
  reserveLocation: string | null;
  uploadedAt: string;
}): ProjectMapPhoto {
  return {
    id: row.id,
    checklistNodeId: row.checklistNodeId,
    storedFileName: row.storedFileName,
    reserveLocation: row.reserveLocation,
    uploadedAt: row.uploadedAt,
  };
}

export class ProjectsRepository {
  constructor(private readonly db: Database.Database) {}

  private replaceMapFeatures(
    projectId: string,
    polygons: MapPolygonInput[],
    trunkCables: MapTrunkCableInput[],
    infraNodes: MapInfraNodeInput[],
    infrastructureFeatures: MapInfrastructureFeatureInput[] = [],
  ): void {
    const polygonKeys = new Set(polygons.map((polygon) => polygon.osdName));
    const existingPolygonRows = this.db
      .prepare(`SELECT osd_name AS osdName FROM map_polygons WHERE project_id = ?`)
      .all(projectId) as Array<{ osdName: string }>;
    const deletePolygon = this.db.prepare(`DELETE FROM map_polygons WHERE project_id = ? AND osd_name = ?`);
    for (const row of existingPolygonRows) {
      if (!polygonKeys.has(row.osdName)) deletePolygon.run(projectId, row.osdName);
    }

    const insertPolygon = this.db.prepare(
      `INSERT INTO map_polygons (
        id, project_id, osd_name, label, geojson, households, pa_count, cable_ref
      ) VALUES (?, ?, ?, ?, ?, ?, ?, ?)
      ON CONFLICT(project_id, osd_name) DO UPDATE SET
        label = excluded.label,
        geojson = excluded.geojson,
        households = excluded.households,
        pa_count = excluded.pa_count,
        cable_ref = excluded.cable_ref`,
    );
    for (const polygon of polygons) {
      insertPolygon.run(
        randomUUID(),
        projectId,
        polygon.osdName,
        polygon.label,
        JSON.stringify(polygon.geojson),
        polygon.households,
        polygon.paCount,
        polygon.cableRef,
      );
    }

    const cableKeys = new Set(trunkCables.map(getMapCableKey));
    const existingCableRows = this.db
      .prepare(
        `SELECT
          cable_key AS cableKey,
          cable_type AS cableType,
          from_node AS fromNode,
          to_node AS toNode,
          raw_name AS rawName,
          status
        FROM map_trunk_cables
        WHERE project_id = ?`,
      )
      .all(projectId) as Array<{
      cableKey: string;
      cableType: string;
      fromNode: string;
      toNode: string;
      rawName: string | null;
      status: MapCableStatus;
    }>;
    const cableStatusByKey = new Map(existingCableRows.map((row) => [row.cableKey, row.status]));
    const inheritedCableStatusByKey = new Map<string, MapCableStatus | null>();
    const rememberInheritedCableStatus = (inheritanceKey: string, status: MapCableStatus): void => {
      const current = inheritedCableStatusByKey.get(inheritanceKey);
      if (current === undefined) {
        inheritedCableStatusByKey.set(inheritanceKey, status);
      } else if (current !== status) {
        inheritedCableStatusByKey.set(inheritanceKey, null);
      }
    };
    for (const row of existingCableRows) {
      rememberInheritedCableStatus(getCableStatusInheritanceKey(row), row.status);
    }
    const deleteCable = this.db.prepare(
      `DELETE FROM map_trunk_cables WHERE project_id = ? AND cable_key = ?`,
    );
    for (const row of existingCableRows) {
      if (!cableKeys.has(row.cableKey)) deleteCable.run(projectId, row.cableKey);
    }

    const insertCable = this.db.prepare(
      `INSERT INTO map_trunk_cables (
        id, project_id, cable_key, cable_type, route_type, from_node, to_node, osd_name,
        geojson, raw_name, route_length_m, installation_length_m, status
      ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
      ON CONFLICT(project_id, cable_key) DO UPDATE SET
        cable_type = excluded.cable_type,
        route_type = excluded.route_type,
        from_node = excluded.from_node,
        to_node = excluded.to_node,
        osd_name = excluded.osd_name,
        geojson = excluded.geojson,
        raw_name = excluded.raw_name,
        route_length_m = excluded.route_length_m,
        installation_length_m = excluded.installation_length_m`,
    );
    for (const cable of trunkCables) {
      const cableKey = getMapCableKey(cable);
      const inheritedStatus = inheritedCableStatusByKey.get(getCableStatusInheritanceKey(cable));
      insertCable.run(
        randomUUID(),
        projectId,
        cableKey,
        cable.cableType,
        getCableRoutingType(cable),
        cable.fromNode,
        cable.toNode,
        cable.osdName,
        JSON.stringify(cable.geojson),
        cable.rawName,
        cable.routeLengthMeters ?? null,
        cable.installationLengthMeters ?? null,
        cableStatusByKey.get(cableKey) ?? inheritedStatus ?? 'PENDING',
      );
    }

    const nodeKeys = new Set(infraNodes.map((node) => `${node.nodeType}|${node.name}`));
    const existingNodeRows = this.db
      .prepare(
        `SELECT node_type AS nodeType, name, label, status FROM map_infra_nodes WHERE project_id = ?`,
      )
      .all(projectId) as Array<{
      nodeType: MapInfraNodeInput['nodeType'];
      name: string;
      label: string | null;
      status: MapNodeStatus;
    }>;
    const nodeStatusByName = new Map<string, MapNodeStatus>();
    const nodeStatusByLabel = new Map<string, MapNodeStatus>();
    for (const row of existingNodeRows) {
      nodeStatusByName.set(`${row.nodeType}|${normalizeMapNodeKey(row.name)}`, row.status);
      const labelKey = normalizeMapNodeKey(row.label);
      if (labelKey) nodeStatusByLabel.set(`${row.nodeType}|${labelKey}`, row.status);
    }
    const deleteNode = this.db.prepare(
      `DELETE FROM map_infra_nodes WHERE project_id = ? AND node_type = ? AND name = ?`,
    );
    for (const row of existingNodeRows) {
      if (!nodeKeys.has(`${row.nodeType}|${row.name}`)) deleteNode.run(projectId, row.nodeType, row.name);
    }

    const insertNode = this.db.prepare(
      `INSERT INTO map_infra_nodes (
        id, project_id, node_type, name, label, lat, lng, status
      ) VALUES (?, ?, ?, ?, ?, ?, ?, ?)
      ON CONFLICT(project_id, node_type, name) DO UPDATE SET
        label = excluded.label,
        lat = excluded.lat,
        lng = excluded.lng`,
    );
    for (const node of infraNodes) {
      const status =
        nodeStatusByName.get(`${node.nodeType}|${normalizeMapNodeKey(node.name)}`) ??
        nodeStatusByLabel.get(`${node.nodeType}|${normalizeMapNodeKey(node.label)}`) ??
        'PENDING';
      insertNode.run(
        randomUUID(),
        projectId,
        node.nodeType,
        node.name,
        node.label,
        node.lat,
        node.lng,
        status,
      );
    }

    this.db.prepare(`DELETE FROM map_infrastructure_features WHERE project_id = ?`).run(projectId);
    const insertInfrastructureFeature = this.db.prepare(
      `INSERT INTO map_infrastructure_features (
        id, project_id, feature_type, source_layer, label, element_type, owner, geojson
      ) VALUES (?, ?, ?, ?, ?, ?, ?, ?)`,
    );
    for (const feature of infrastructureFeatures) {
      insertInfrastructureFeature.run(
        randomUUID(),
        projectId,
        feature.featureType,
        feature.sourceLayer,
        feature.label,
        feature.elementType,
        feature.owner,
        JSON.stringify(feature.geojson),
      );
    }
  }

  listProjects(): ProjectRecord[] {
    const rows = this.db
      .prepare(
        `SELECT
          project.id,
          project.name,
          project.project_definition AS projectDefinition,
          project.project_type AS projectType,
          project.splitter_topology AS splitterTopology,
          project.splitter_count AS splitterCount,
          project.splitter_topology_source AS splitterTopologySource,
          project.gpkg_file_name AS gpkgFileName,
          project.base_folder AS baseFolder,
          project.google_chat_space_name AS googleChatSpaceName,
          project.google_chat_space_display_name AS googleChatSpaceDisplayName,
          project.google_chat_last_download_at AS googleChatLastDownloadAt,
          project.address_count AS addressCount,
          project.dac_to_address_cable_count AS dacToAddressCableCount,
          project.adss_to_address_cable_count AS adssToAddressCableCount,
          project.created_at AS createdAt,
          project.updated_at AS updatedAt,
          COALESCE(SUM(
            CASE
              WHEN node.accepts_photos = 1 AND node.min_photos > 0 THEN 1
              ELSE 0
            END
          ), 0) AS progressTotal,
          COALESCE(SUM(
            CASE
              WHEN node.accepts_photos = 1
                AND node.min_photos > 0
                AND (
                  node.status = 'NOT_APPLICABLE'
                  OR COALESCE(photo_counts.photo_count, 0) >= node.min_photos
                )
              THEN 1
              ELSE 0
            END
          ), 0) AS progressDone
        FROM projects project
        LEFT JOIN checklist_nodes node ON node.project_id = project.id
        LEFT JOIN (
          SELECT checklist_node_id, COUNT(*) AS photo_count
          FROM photos
          GROUP BY checklist_node_id
        ) photo_counts ON photo_counts.checklist_node_id = node.id
        GROUP BY project.id
        ORDER BY project.updated_at DESC`,
      )
      .all() as Array<ProjectRecord & { progressDone: number; progressTotal: number }>;

    return rows.map((row) => ({
      ...row,
      progressDone: Number(row.progressDone),
      progressTotal: Number(row.progressTotal),
      status:
        Number(row.progressTotal) > 0 && Number(row.progressDone) >= Number(row.progressTotal)
          ? 'Kompletne'
          : 'W trakcie',
    }));
  }

  createProject(input: CreateProjectInput): ProjectRecord {
    const id = randomUUID();
    const now = new Date().toISOString();
    const tx = this.db.transaction(() => {
      this.db
        .prepare(
          `INSERT INTO projects (
            id, name, project_definition, project_type, splitter_topology, splitter_count,
            splitter_topology_source, gpkg_file_name, base_folder, address_count,
            dac_to_address_cable_count, adss_to_address_cable_count, created_at, updated_at
          ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
        )
        .run(
          id,
          input.name,
          input.projectDefinition ?? null,
          input.projectType,
          input.splitterTopology,
          input.splitterCount,
          input.splitterTopologySource,
          input.gpkgFileName,
          input.baseFolder,
          input.addresses.length,
          input.dacToAddressCableCount,
          input.adssToAddressCableCount,
          now,
          now,
        );

      const insertAddress = this.db.prepare(
        `INSERT INTO addresses (
          id, project_id, city, street, building_no, property_id, parcel_number,
          distribution_point, lat, lng, household_count, business_unit_count
        ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      );

      for (const address of input.addresses) {
        insertAddress.run(
          address.id,
          id,
          address.city,
          address.street,
          address.buildingNo,
          address.propertyId,
          address.parcelNumber,
          address.distributionPoint,
          address.lat,
          address.lng,
          address.householdCount,
          address.businessUnitCount,
        );
      }

      const insertNode = this.db.prepare(
        `INSERT INTO checklist_nodes (
          id, project_id, parent_id, name, path, node_type, address_id,
          sort_order, min_photos, accepts_photos, source, status
        ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 'OPEN')`,
      );

      for (const node of input.checklistNodes) {
        insertNode.run(
          node.id,
          id,
          node.parentId,
          node.name,
          node.path,
          node.nodeType,
          node.addressId,
          node.sortOrder,
          node.minPhotos,
          node.acceptsPhotos ? 1 : 0,
          node.source ?? 'GPKG',
        );
      }

      this.replaceMapFeatures(
        id,
        input.polygons ?? [],
        input.trunkCables ?? [],
        input.infraNodes ?? [],
        input.infrastructureFeatures ?? [],
      );
    });

    tx();

    const created = this.listProjects().find((project) => project.id === id);
    if (!created) throw new Error(`Created project ${id} not found`);
    return created;
  }

  getChecklist(projectId: string) {
    return this.db
      .prepare(
        `SELECT
          node.id,
          node.project_id AS projectId,
          node.parent_id AS parentId,
          node.name,
          node.path,
          node.node_type AS nodeType,
          node.source,
          node.address_id AS addressId,
          node.sort_order AS sortOrder,
          node.min_photos AS minPhotos,
          node.accepts_photos AS acceptsPhotos,
          node.status,
          node.not_applicable_reason AS notApplicableReason,
          COUNT(photo.id) AS photoCount
        FROM checklist_nodes node
        LEFT JOIN photos photo ON photo.checklist_node_id = node.id
        WHERE node.project_id = ?
        GROUP BY node.id
        ORDER BY node.sort_order ASC, node.name ASC`,
      )
      .all(projectId);
  }

  getProject(projectId: string): ProjectRecord | null {
    return this.listProjects().find((project) => project.id === projectId) ?? null;
  }

  assignGoogleChatSpace(
    projectId: string,
    input: {
      spaceName: string;
      spaceDisplayName: string;
      lastDownloadAt?: string | null;
    },
  ): ProjectRecord | null {
    this.db
      .prepare(
        `UPDATE projects
         SET google_chat_space_name = ?,
             google_chat_space_display_name = ?,
             google_chat_last_download_at = COALESCE(?, google_chat_last_download_at),
             updated_at = CURRENT_TIMESTAMP
         WHERE id = ?`,
      )
      .run(input.spaceName, input.spaceDisplayName, input.lastDownloadAt ?? null, projectId);

    return this.getProject(projectId);
  }

  private findDistributionPointForRegion(projectId: string, lat: number, lng: number): string | null {
    const polygonRows = this.db
      .prepare(
        `SELECT osd_name AS osdName, geojson
         FROM map_polygons
         WHERE project_id = ?
         ORDER BY osd_name COLLATE NOCASE ASC`,
      )
      .all(projectId) as Array<{ osdName: string; geojson: string }>;

    for (const polygon of polygonRows) {
      if (pointInGeojson(lng, lat, parseGeojson(polygon.geojson))) return polygon.osdName;
    }

    return null;
  }

  private getMapAddressCandidate(projectId: string, candidateId: string): ProjectMapAddressCandidate | null {
    const row = this.db
      .prepare(
        `SELECT
          id,
          status,
          city,
          street,
          building_no AS buildingNo,
          postal_code AS postalCode,
          property_id AS propertyId,
          parcel_number AS parcelNumber,
          lat,
          lng,
          geocoder_source AS geocoderSource,
          geocoder_distance_m AS geocoderDistanceMeters,
          suggested_distribution_point AS suggestedDistributionPoint,
          assignment_source AS assignmentSource,
          approved_address_id AS approvedAddressId,
          reserve_location AS reserveLocation,
          created_at AS createdAt,
          updated_at AS updatedAt
        FROM map_address_candidates
        WHERE project_id = ? AND id = ?`,
      )
      .get(projectId, candidateId) as
      | {
          id: string;
          status: MapAddressCandidateStatus;
          city: string;
          street: string;
          buildingNo: string | null;
          postalCode: string | null;
          propertyId: string | null;
          parcelNumber: string | null;
          lat: number;
          lng: number;
          geocoderSource: string;
          geocoderDistanceMeters: number | null;
          suggestedDistributionPoint: string | null;
          assignmentSource: MapAddressCandidateAssignmentSource;
          approvedAddressId: string | null;
          reserveLocation: ReserveLocationKind | null;
          createdAt: string;
          updatedAt: string;
        }
      | undefined;

    return row ? mapAddressCandidateRow(row) : null;
  }

  listMapAddressCandidates(projectId: string): ProjectMapAddressCandidate[] {
    const rows = this.db
      .prepare(
        `SELECT
          id,
          status,
          city,
          street,
          building_no AS buildingNo,
          postal_code AS postalCode,
          property_id AS propertyId,
          parcel_number AS parcelNumber,
          lat,
          lng,
          geocoder_source AS geocoderSource,
          geocoder_distance_m AS geocoderDistanceMeters,
          suggested_distribution_point AS suggestedDistributionPoint,
          assignment_source AS assignmentSource,
          approved_address_id AS approvedAddressId,
          reserve_location AS reserveLocation,
          created_at AS createdAt,
          updated_at AS updatedAt
        FROM map_address_candidates
        WHERE project_id = ? AND status = 'PENDING'
        ORDER BY created_at DESC, id ASC`,
      )
      .all(projectId) as Array<Parameters<typeof mapAddressCandidateRow>[0]>;

    return rows.map(mapAddressCandidateRow);
  }

  addMapAddressCandidate(input: AddMapAddressCandidateInput): ProjectMapAddressCandidate {
    const id = randomUUID();
    const suggestedDistributionPoint = this.findDistributionPointForRegion(input.projectId, input.lat, input.lng);
    const assignmentSource: MapAddressCandidateAssignmentSource = suggestedDistributionPoint ? 'REGION' : 'NONE';

    this.db
      .prepare(
        `INSERT INTO map_address_candidates (
          id, project_id, status, lat, lng, city, street, building_no,
          postal_code, property_id, parcel_number, geocoder_source, geocoder_distance_m,
          suggested_distribution_point, assignment_source
        ) VALUES (?, ?, 'PENDING', ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      )
      .run(
        id,
        input.projectId,
        input.lat,
        input.lng,
        input.city.trim(),
        input.street.trim(),
        input.buildingNo,
        input.postalCode,
        input.propertyId,
        input.parcelNumber,
        input.geocoderSource,
        input.geocoderDistanceMeters,
        suggestedDistributionPoint,
        assignmentSource,
      );
    this.db.prepare(`UPDATE projects SET updated_at = CURRENT_TIMESTAMP WHERE id = ?`).run(input.projectId);

    const created = this.getMapAddressCandidate(input.projectId, id);
    if (!created) throw new Error(`Created map address candidate ${id} not found`);
    return created;
  }

  private upsertManualChecklistNode(input: {
    projectId: string;
    parentId: string | null;
    name: string;
    path: string;
    nodeType: ChecklistNodeType;
    addressId: string | null;
    sortOrder: number;
    minPhotos: number;
    acceptsPhotos: boolean;
  }): string {
    const existing = this.db
      .prepare(`SELECT id FROM checklist_nodes WHERE project_id = ? AND path = ?`)
      .get(input.projectId, input.path) as { id: string } | undefined;

    if (existing) {
      this.db
        .prepare(
          `UPDATE checklist_nodes
           SET parent_id = ?,
               name = ?,
               node_type = ?,
               address_id = ?,
               sort_order = ?,
               min_photos = ?,
               accepts_photos = ?,
               updated_at = CURRENT_TIMESTAMP
           WHERE project_id = ? AND id = ?`,
        )
        .run(
          input.parentId,
          input.name,
          input.nodeType,
          input.addressId,
          input.sortOrder,
          input.minPhotos,
          input.acceptsPhotos ? 1 : 0,
          input.projectId,
          existing.id,
        );
      return existing.id;
    }

    const id = randomUUID();
    this.db
      .prepare(
        `INSERT INTO checklist_nodes (
          id, project_id, parent_id, name, path, node_type, source, address_id,
          sort_order, min_photos, accepts_photos, status
        ) VALUES (?, ?, ?, ?, ?, ?, 'MANUAL', ?, ?, ?, ?, 'OPEN')`,
      )
      .run(
        id,
        input.projectId,
        input.parentId,
        input.name,
        input.path,
        input.nodeType,
        input.addressId,
        input.sortOrder,
        input.minPhotos,
        input.acceptsPhotos ? 1 : 0,
      );
    return id;
  }

  private ensureReserveChecklistPath(input: {
    projectId: string;
    distributionPoint: string;
    addressId: string;
    street: string;
    buildingNo: string | null;
    reserveLocation: ReserveLocationKind;
  }): void {
    const rootPath =
      input.reserveLocation === 'Napowietrzny' ? 'Zapasy_kabli_napowietrznych' : 'Zapasy_kabli_instalacyjnych';
    const rootSort = input.reserveLocation === 'Napowietrzny' ? 8 : 7;
    const rootId = this.upsertManualChecklistNode({
      projectId: input.projectId,
      parentId: null,
      name: rootPath,
      path: rootPath,
      nodeType: 'STATIC',
      addressId: null,
      sortOrder: rootSort,
      minPhotos: 0,
      acceptsPhotos: false,
    });

    const safeDistributionPoint = safeFolderName(input.distributionPoint);
    const distributionPath = `${rootPath}/${safeDistributionPoint}`;
    const distributionId = this.upsertManualChecklistNode({
      projectId: input.projectId,
      parentId: rootId,
      name: input.distributionPoint,
      path: distributionPath,
      nodeType: 'DISTRIBUTION',
      addressId: null,
      sortOrder: 0,
      minPhotos: 0,
      acceptsPhotos: false,
    });

    const addressName = toAddressFolderName(input.street, input.buildingNo);
    this.upsertManualChecklistNode({
      projectId: input.projectId,
      parentId: distributionId,
      name: addressName,
      path: `${distributionPath}/${addressName}`,
      nodeType: 'CABLE_RESERVE',
      addressId: input.addressId,
      sortOrder: 0,
      minPhotos: 1,
      acceptsPhotos: true,
    });
  }

  approveMapAddressCandidate(input: ApproveMapAddressCandidateInput): ProjectMapAddressCandidate {
    const candidate = this.getMapAddressCandidate(input.projectId, input.candidateId);
    if (!candidate) throw new Error('Map address candidate not found');
    if (candidate.status !== 'PENDING') throw new Error('Map address candidate is not pending');

    const city = input.city.trim();
    const street = input.street.trim();
    const distributionPoint = (input.distributionPoint ?? candidate.suggestedDistributionPoint ?? '').trim();
    if (!city) throw new Error('City is required');
    if (!street) throw new Error('Street is required');
    if (!distributionPoint) throw new Error('Distribution point is required');

    const tx = this.db.transaction(() => {
      if (input.createDistributionNodeType) {
        this.db
          .prepare(
            `INSERT INTO map_infra_nodes (
              id, project_id, node_type, name, label, lat, lng, status
            ) VALUES (?, ?, ?, ?, ?, ?, ?, 'PENDING')
            ON CONFLICT(project_id, node_type, name) DO UPDATE SET
              label = excluded.label,
              lat = excluded.lat,
              lng = excluded.lng`,
          )
          .run(
            randomUUID(),
            input.projectId,
            input.createDistributionNodeType,
            distributionPoint,
            distributionPoint,
            candidate.lat,
            candidate.lng,
          );
      }

      const existingAddressRows = this.db
        .prepare(
          `SELECT
             id,
             city,
             street,
             building_no AS buildingNo,
             distribution_point AS distributionPoint,
             source,
             opl_consent_confirmed AS oplConsentConfirmed
           FROM addresses
           WHERE project_id = ?`,
        )
        .all(input.projectId) as Array<{
        id: string;
        city: string;
        street: string;
        buildingNo: string | null;
        distributionPoint: string | null;
        source: 'GPKG' | 'MANUAL_MAP';
        oplConsentConfirmed: number;
      }>;
      const targetKey = getAddressMergeKey({
        city,
        street,
        buildingNo: input.buildingNo,
        distributionPoint,
      });
      const existingAddress = existingAddressRows.find((address) => getAddressMergeKey(address) === targetKey);
      const addressId = existingAddress?.id ?? randomUUID();
      const oplConsentConfirmed = input.oplConsentConfirmed ? 1 : 0;
      const addressSource = existingAddress?.source === 'GPKG' ? 'GPKG' : 'MANUAL_MAP';

      if (existingAddress) {
        this.db
          .prepare(
            `UPDATE addresses
             SET city = ?,
                 street = ?,
                 building_no = ?,
                 property_id = ?,
                 parcel_number = ?,
                 distribution_point = ?,
                 lat = ?,
                 lng = ?,
                 source = ?,
                 opl_consent_confirmed = ?
             WHERE project_id = ? AND id = ?`,
          )
          .run(
            city,
            street,
            input.buildingNo,
            input.propertyId,
            input.parcelNumber,
            distributionPoint,
            candidate.lat,
            candidate.lng,
            addressSource,
            addressSource === 'GPKG' ? existingAddress.oplConsentConfirmed : oplConsentConfirmed,
            input.projectId,
            addressId,
          );
      } else {
        this.db
          .prepare(
            `INSERT INTO addresses (
              id, project_id, city, street, building_no, property_id, parcel_number,
              distribution_point, lat, lng, household_count, business_unit_count, source, opl_consent_confirmed
            ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 1, 0, 'MANUAL_MAP', ?)`,
          )
          .run(
            addressId,
            input.projectId,
            city,
            street,
            input.buildingNo,
            input.propertyId,
            input.parcelNumber,
            distributionPoint,
            candidate.lat,
            candidate.lng,
            oplConsentConfirmed,
          );
      }

      this.ensureReserveChecklistPath({
        projectId: input.projectId,
        distributionPoint,
        addressId,
        street,
        buildingNo: input.buildingNo,
        reserveLocation: input.reserveLocation,
      });

      const noteBody = input.noteBody?.trim() ?? '';
      if (noteBody) {
        this.db
          .prepare(
            `INSERT INTO map_notes (
              id, project_id, target_type, target_id, target_label, body, lat, lng
            ) VALUES (?, ?, 'address', ?, ?, ?, ?, ?)`,
          )
          .run(
            randomUUID(),
            input.projectId,
            addressId,
            buildAddressLabel({ city, street, buildingNo: input.buildingNo }),
            noteBody,
            candidate.lat,
            candidate.lng,
          );
      }

      this.db
        .prepare(
          `UPDATE map_address_candidates
           SET status = 'APPROVED',
               city = ?,
               street = ?,
               building_no = ?,
               property_id = ?,
               parcel_number = ?,
               approved_address_id = ?,
               reserve_location = ?,
               updated_at = CURRENT_TIMESTAMP
           WHERE project_id = ? AND id = ?`,
        )
        .run(
          city,
          street,
          input.buildingNo,
          input.propertyId,
          input.parcelNumber,
          addressId,
          input.reserveLocation,
          input.projectId,
          input.candidateId,
        );

      this.db
        .prepare(
          `UPDATE projects
           SET address_count = (SELECT COUNT(*) FROM addresses WHERE project_id = ?),
               updated_at = CURRENT_TIMESTAMP
           WHERE id = ?`,
        )
        .run(input.projectId, input.projectId);
    });

    tx();
    const approved = this.getMapAddressCandidate(input.projectId, input.candidateId);
    if (!approved) throw new Error('Approved map address candidate not found');
    return approved;
  }

  rejectMapAddressCandidate(projectId: string, candidateId: string): ProjectMapAddressCandidate {
    const result = this.db
      .prepare(
        `UPDATE map_address_candidates
         SET status = 'REJECTED',
             updated_at = CURRENT_TIMESTAMP
         WHERE project_id = ? AND id = ? AND status = 'PENDING'`,
      )
      .run(projectId, candidateId);
    if (result.changes === 0) throw new Error('Map address candidate not found');

    const rejected = this.getMapAddressCandidate(projectId, candidateId);
    if (!rejected) throw new Error('Rejected map address candidate not found');
    return rejected;
  }

  updateAddressOplConsent(projectId: string, addressId: string, confirmed: boolean): void {
    const result = this.db
      .prepare(
        `UPDATE addresses
         SET opl_consent_confirmed = ?
         WHERE project_id = ? AND id = ?`,
      )
      .run(confirmed ? 1 : 0, projectId, addressId);

    if (result.changes === 0) throw new Error('Address not found');
    this.db.prepare(`UPDATE projects SET updated_at = CURRENT_TIMESTAMP WHERE id = ?`).run(projectId);
  }

  getProjectMap(projectId: string): ProjectMapRecord {
    const projectRow = this.db
      .prepare(`SELECT project_type AS projectType FROM projects WHERE id = ?`)
      .get(projectId) as { projectType: ProjectType } | undefined;
    const projectType = projectRow?.projectType ?? 'SI';

    const addressRows = this.db
      .prepare(
        `SELECT
          address.id,
          address.city,
          address.street,
          address.building_no AS buildingNo,
          address.distribution_point AS distributionPoint,
          address.lat,
          address.lng,
          address.source,
          address.opl_consent_confirmed AS oplConsentConfirmed,
          COUNT(photo.id) AS reservePhotoCount,
          COUNT(DISTINCT CASE
            WHEN node.path LIKE 'Zapasy_kabli_napowietrznych/%' THEN node.id
          END) AS aerialReserveNodeCount,
          COUNT(DISTINCT CASE WHEN node.status = 'NOT_APPLICABLE' THEN node.id END) AS notApplicableReserveNodeCount
        FROM addresses address
        LEFT JOIN checklist_nodes node
          ON node.address_id = address.id
          AND node.node_type = 'CABLE_RESERVE'
        LEFT JOIN photos photo ON photo.checklist_node_id = node.id
        WHERE address.project_id = ?
          AND address.lat IS NOT NULL
          AND address.lng IS NOT NULL
        GROUP BY address.id
        ORDER BY address.city COLLATE NOCASE ASC,
          address.street COLLATE NOCASE ASC,
          address.building_no COLLATE NOCASE ASC`,
      )
      .all(projectId) as Array<{
      id: string;
      city: string;
      street: string;
      buildingNo: string | null;
      distributionPoint: string | null;
      lat: number;
      lng: number;
      source: 'GPKG' | 'MANUAL_MAP';
      oplConsentConfirmed: number;
      reservePhotoCount: number;
      aerialReserveNodeCount: number;
      notApplicableReserveNodeCount: number;
    }>;

    const addressPhotoRows = this.db
      .prepare(
        `SELECT
          node.address_id AS addressId,
          photo.id,
          photo.checklist_node_id AS checklistNodeId,
          photo.stored_file_name AS storedFileName,
          photo.reserve_location AS reserveLocation,
          photo.uploaded_at AS uploadedAt
        FROM photos photo
        JOIN checklist_nodes node ON node.id = photo.checklist_node_id
        WHERE photo.project_id = ?
          AND node.project_id = ?
          AND node.address_id IS NOT NULL
        ORDER BY photo.uploaded_at DESC, photo.id ASC`,
      )
      .all(projectId, projectId) as Array<{
      addressId: string;
      id: string;
      checklistNodeId: string;
      storedFileName: string;
      reserveLocation: string | null;
      uploadedAt: string;
    }>;
    const photosByAddressId = new Map<string, ProjectMapPhoto[]>();
    for (const photo of addressPhotoRows) {
      const photos = photosByAddressId.get(photo.addressId) ?? [];
      photos.push(mapProjectPhotoRow(photo));
      photosByAddressId.set(photo.addressId, photos);
    }

    const photoNodeRows = this.db
      .prepare(
        `SELECT
          node.name,
          node.path,
          photo.id,
          photo.checklist_node_id AS checklistNodeId,
          photo.stored_file_name AS storedFileName,
          photo.reserve_location AS reserveLocation,
          photo.uploaded_at AS uploadedAt
        FROM checklist_nodes node
        JOIN photos photo ON photo.checklist_node_id = node.id
        WHERE node.project_id = ?
          AND node.node_type != 'CABLE_RESERVE'
        ORDER BY photo.uploaded_at DESC, photo.id ASC`,
      )
      .all(projectId) as Array<{
      name: string;
      path: string;
      id: string;
      checklistNodeId: string;
      storedFileName: string;
      reserveLocation: string | null;
      uploadedAt: string;
    }>;

    const distributionPhotoKeys = photoNodeRows.map((photoNode) => ({
      nameKey: normalizeSearchKey(photoNode.name),
      pathKey: normalizeSearchKey(photoNode.path),
    }));
    const hasDistributionPhoto = (distributionPoint: string | null): boolean => {
      const nodeKey = normalizeSearchKey(distributionPoint);
      const terminalKey = normalizeSearchKey(normalizeMapNodeTerminalKey(distributionPoint));
      if (!nodeKey && !terminalKey) return false;

      return distributionPhotoKeys.some(({ nameKey, pathKey }) => {
        const matchesNode = Boolean(nodeKey) && (nameKey === nodeKey || pathKey.includes(nodeKey));
        const matchesTerminal =
          Boolean(terminalKey) && (nameKey === terminalKey || pathKey.includes(terminalKey));
        return matchesNode || matchesTerminal;
      });
    };

    const addresses = addressRows.map((address) => {
      const reservePhotoCount = Number(address.reservePhotoCount);
      const isAerialReserve = Number(address.aerialReserveNodeCount) > 0;
      const usesDistributionPhotoForCompletion = projectType === 'SI' && isAerialReserve;
      const hasDistributionPointPhoto = isAerialReserve && hasDistributionPhoto(address.distributionPoint);
      const hasEffectiveReservePhoto =
        reservePhotoCount > 0 || (usesDistributionPhotoForCompletion && hasDistributionPointPhoto);
      const isNotApplicable = !hasEffectiveReservePhoto && Number(address.notApplicableReserveNodeCount) > 0;
      const status: ProjectMapAddressStatus = hasEffectiveReservePhoto
        ? 'COMPLETE'
        : isNotApplicable
          ? 'NOT_APPLICABLE'
          : 'PENDING';
      return {
        id: address.id,
        label: buildAddressLabel(address),
        city: address.city,
        street: address.street,
        buildingNo: address.buildingNo,
        distributionPoint: address.distributionPoint,
        lat: Number(address.lat),
        lng: Number(address.lng),
        reservePhotoCount,
        hasReservePhoto: hasEffectiveReservePhoto,
        isAerialReserve,
        hasDistributionPhoto: hasDistributionPointPhoto,
        usesDistributionPhotoForCompletion,
        status,
        isNotApplicable,
        isManuallyAdded: address.source === 'MANUAL_MAP',
        oplConsentConfirmed: Number(address.oplConsentConfirmed) === 1,
        photos: photosByAddressId.get(address.id) ?? [],
      };
    });

    const addressCountsByNode = new Map<string, { total: number; withReservePhoto: number }>();
    const addressCountsByTerminalNode = new Map<string, { total: number; withReservePhoto: number }>();
    for (const address of addresses) {
      const nodeKey = normalizeMapNodeKey(address.distributionPoint);
      if (!nodeKey) continue;
      const counts = addressCountsByNode.get(nodeKey) ?? { total: 0, withReservePhoto: 0 };
      counts.total += 1;
      if (address.status === 'COMPLETE' || address.status === 'NOT_APPLICABLE') {
        counts.withReservePhoto += 1;
      }
      addressCountsByNode.set(nodeKey, counts);

      const terminalNodeKey = normalizeMapNodeTerminalKey(address.distributionPoint);
      const terminalCounts = addressCountsByTerminalNode.get(terminalNodeKey) ?? {
        total: 0,
        withReservePhoto: 0,
      };
      terminalCounts.total += 1;
      if (address.status === 'COMPLETE' || address.status === 'NOT_APPLICABLE') {
        terminalCounts.withReservePhoto += 1;
      }
      addressCountsByTerminalNode.set(terminalNodeKey, terminalCounts);
    }

    const polygonRows = this.db
      .prepare(
        `SELECT
          id,
          osd_name AS osdName,
          label,
          geojson,
          households,
          pa_count AS paCount,
          cable_ref AS cableRef
        FROM map_polygons
        WHERE project_id = ?
        ORDER BY osd_name COLLATE NOCASE ASC`,
      )
      .all(projectId) as Array<{
      id: string;
      osdName: string;
      label: string | null;
      geojson: string;
      households: number | null;
      paCount: number | null;
      cableRef: string | null;
    }>;

    const polygons = polygonRows.map((polygon) => {
      const counts =
        addressCountsByNode.get(normalizeMapNodeKey(polygon.osdName)) ??
        addressCountsByTerminalNode.get(normalizeMapNodeTerminalKey(polygon.osdName)) ??
        {
          total: 0,
          withReservePhoto: 0,
        };
      return {
        id: polygon.id,
        osdName: polygon.osdName,
        label: polygon.label,
        geojson: parseGeojson(polygon.geojson),
        households: polygon.households,
        paCount: polygon.paCount,
        cableRef: polygon.cableRef,
        addressTotal: counts.total,
        addressWithReservePhoto: counts.withReservePhoto,
      };
    });

    const cableRows = this.db
      .prepare(
        `SELECT
          id,
          cable_type AS cableType,
          route_type AS routingType,
          from_node AS fromNode,
          to_node AS toNode,
          osd_name AS osdName,
          geojson,
          raw_name AS rawName,
          route_length_m AS routeLengthMeters,
          installation_length_m AS installationLengthMeters,
          status
        FROM map_trunk_cables
        WHERE project_id = ?
        ORDER BY from_node COLLATE NOCASE ASC, to_node COLLATE NOCASE ASC`,
      )
      .all(projectId) as Array<{
      id: string;
      cableType: string;
      routingType: CableRoutingType;
      fromNode: string;
      toNode: string;
      osdName: string;
      geojson: string;
      rawName: string | null;
      routeLengthMeters: number | null;
      installationLengthMeters: number | null;
      status: MapCableStatus;
    }>;

    const trunkCables = cableRows.map((cable) => ({
      id: cable.id,
      cableType: cable.cableType,
      routingType: cable.routingType,
      fromNode: cable.fromNode,
      toNode: cable.toNode,
      osdName: cable.osdName,
      geojson: parseGeojson(cable.geojson),
      rawName: cable.rawName,
      routeLengthMeters: cable.routeLengthMeters == null ? null : Number(cable.routeLengthMeters),
      installationLengthMeters: cable.installationLengthMeters == null
        ? null
        : Number(cable.installationLengthMeters),
      status: cable.status,
    }));

    const infraRows = this.db
      .prepare(
        `SELECT
          id,
          node_type AS nodeType,
          name,
          label,
          lat,
          lng,
          status
        FROM map_infra_nodes
        WHERE project_id = ?
        ORDER BY node_type ASC, name COLLATE NOCASE ASC`,
      )
      .all(projectId) as Array<{
      id: string;
      nodeType: 'OSD' | 'OPP' | 'ZS';
      name: string;
      label: string | null;
      lat: number;
      lng: number;
      status: MapNodeStatus;
    }>;

    const infraNodes = infraRows.map((node) => {
      const nodeKey = normalizeSearchKey(node.name);
      const photos = photoNodeRows.filter((photoNode) => {
        const nameKey = normalizeSearchKey(photoNode.name);
        const pathKey = normalizeSearchKey(photoNode.path);
        return nameKey === nodeKey || pathKey.includes(nodeKey);
      });
      const hasPhoto = photos.length > 0;
      return {
        id: node.id,
        nodeType: node.nodeType,
        name: node.name,
        label: node.label,
        lat: Number(node.lat),
        lng: Number(node.lng),
        status: node.status,
        hasPhoto,
        photos: photos.map(mapProjectPhotoRow),
      };
    });

    const infrastructureRows = this.db
      .prepare(
        `SELECT
          id,
          feature_type AS featureType,
          source_layer AS sourceLayer,
          label,
          element_type AS elementType,
          owner,
          geojson
        FROM map_infrastructure_features
        WHERE project_id = ?
        ORDER BY feature_type ASC, label COLLATE NOCASE ASC, id ASC`,
      )
      .all(projectId) as Array<{
      id: string;
      featureType: 'duct' | 'pole' | 'manhole';
      sourceLayer: string;
      label: string | null;
      elementType: string | null;
      owner: string | null;
      geojson: string;
    }>;

    const infrastructureFeatures = infrastructureRows.map((feature) => ({
      id: feature.id,
      featureType: feature.featureType,
      sourceLayer: feature.sourceLayer,
      label: feature.label,
      elementType: feature.elementType,
      owner: feature.owner,
      geojson: parseGeojson(feature.geojson),
    }));

    return {
      addresses,
      addressCandidates: this.listMapAddressCandidates(projectId),
      polygons,
      trunkCables,
      infraNodes,
      infrastructureFeatures,
      notes: this.listMapNotes(projectId),
    };
  }

  updateCableStatus(projectId: string, cableId: string, status: MapCableStatus): void {
    const result = this.db
      .prepare(`UPDATE map_trunk_cables SET status = ? WHERE project_id = ? AND id = ?`)
      .run(status, projectId, cableId);
    if (result.changes === 0) throw new Error('Map cable not found');
    this.db.prepare(`UPDATE projects SET updated_at = CURRENT_TIMESTAMP WHERE id = ?`).run(projectId);
  }

  updateInfraNodeStatus(projectId: string, nodeId: string, status: MapNodeStatus): void {
    const result = this.db
      .prepare(`UPDATE map_infra_nodes SET status = ? WHERE project_id = ? AND id = ?`)
      .run(status, projectId, nodeId);
    if (result.changes === 0) throw new Error('Map node not found');
    this.db.prepare(`UPDATE projects SET updated_at = CURRENT_TIMESTAMP WHERE id = ?`).run(projectId);
  }

  listMapNotes(projectId: string): ProjectMapNote[] {
    const photoRows = this.db
      .prepare(
        `SELECT
          id,
          note_id AS noteId,
          source_file_name AS sourceFileName,
          stored_file_name AS storedFileName,
          storage_path AS storagePath,
          thumbnail_path AS thumbnailPath,
          mime_type AS mimeType,
          file_size AS fileSize,
          lat,
          lng,
          captured_at AS capturedAt,
          uploaded_at AS uploadedAt
        FROM map_note_photos
        WHERE project_id = ?
        ORDER BY uploaded_at ASC, id ASC`,
      )
      .all(projectId) as Array<{
      id: string;
      noteId: string;
      sourceFileName: string;
      storedFileName: string;
      storagePath: string;
      thumbnailPath: string | null;
      mimeType: string;
      fileSize: number | null;
      lat: number | null;
      lng: number | null;
      capturedAt: string | null;
      uploadedAt: string;
    }>;
    const photosByNoteId = new Map<string, ProjectMapNotePhoto[]>();
    for (const row of photoRows) {
      const photos = photosByNoteId.get(row.noteId) ?? [];
      photos.push(mapNotePhotoRow(row));
      photosByNoteId.set(row.noteId, photos);
    }

    const noteRows = this.db
      .prepare(
        `SELECT
          id,
          target_type AS targetType,
          target_id AS targetId,
          target_label AS targetLabel,
          body,
          lat,
          lng,
          created_at AS createdAt,
          updated_at AS updatedAt
        FROM map_notes
        WHERE project_id = ?
        ORDER BY updated_at DESC, created_at DESC, id ASC`,
      )
      .all(projectId) as Array<{
      id: string;
      targetType: MapNoteTargetType;
      targetId: string | null;
      targetLabel: string | null;
      body: string;
      lat: number | null;
      lng: number | null;
      createdAt: string;
      updatedAt: string;
    }>;

    return noteRows.map((note) => {
      const photos = photosByNoteId.get(note.id) ?? [];
      return {
        id: note.id,
        targetType: note.targetType,
        targetId: note.targetId,
        targetLabel: note.targetLabel,
        body: note.body,
        lat: note.lat == null ? null : Number(note.lat),
        lng: note.lng == null ? null : Number(note.lng),
        photoCount: photos.length,
        photos,
        createdAt: note.createdAt,
        updatedAt: note.updatedAt,
      };
    });
  }

  getMapNote(projectId: string, noteId: string): ProjectMapNote | null {
    return this.listMapNotes(projectId).find((note) => note.id === noteId) ?? null;
  }

  addMapNote(input: AddMapNoteInput): ProjectMapNote {
    const body = input.body.trim();
    if (!body) throw new Error('Map note body is required');

    const id = randomUUID();
    this.db
      .prepare(
        `INSERT INTO map_notes (
          id, project_id, target_type, target_id, target_label, body, lat, lng
        ) VALUES (?, ?, ?, ?, ?, ?, ?, ?)`,
      )
      .run(
        id,
        input.projectId,
        input.targetType,
        input.targetId,
        input.targetLabel?.trim() || null,
        body,
        input.lat,
        input.lng,
      );
    this.db.prepare(`UPDATE projects SET updated_at = CURRENT_TIMESTAMP WHERE id = ?`).run(input.projectId);

    const created = this.getMapNote(input.projectId, id);
    if (!created) throw new Error(`Created map note ${id} not found`);
    return created;
  }

  updateMapNote(projectId: string, noteId: string, input: UpdateMapNoteInput): ProjectMapNote {
    const body = input.body.trim();
    if (!body) throw new Error('Map note body is required');

    const result = this.db
      .prepare(
        `UPDATE map_notes
         SET body = ?,
           lat = COALESCE(?, lat),
           lng = COALESCE(?, lng),
           updated_at = CURRENT_TIMESTAMP
         WHERE project_id = ? AND id = ?`,
      )
      .run(body, input.lat ?? null, input.lng ?? null, projectId, noteId);
    if (result.changes === 0) throw new Error('Map note not found');
    this.db.prepare(`UPDATE projects SET updated_at = CURRENT_TIMESTAMP WHERE id = ?`).run(projectId);

    const updated = this.getMapNote(projectId, noteId);
    if (!updated) throw new Error(`Updated map note ${noteId} not found`);
    return updated;
  }

  deleteMapNote(projectId: string, noteId: string): void {
    const result = this.db
      .prepare(`DELETE FROM map_notes WHERE project_id = ? AND id = ?`)
      .run(projectId, noteId);
    if (result.changes === 0) throw new Error('Map note not found');
    this.db.prepare(`UPDATE projects SET updated_at = CURRENT_TIMESTAMP WHERE id = ?`).run(projectId);
  }

  addMapNotePhoto(input: AddMapNotePhotoInput): ProjectMapNotePhoto {
    const note = this.getMapNote(input.projectId, input.noteId);
    if (!note) throw new Error('Map note not found');

    this.db
      .prepare(
        `INSERT INTO map_note_photos (
          id, project_id, note_id, source_file_name, stored_file_name,
          storage_path, thumbnail_path, mime_type, file_size, lat, lng, captured_at
        ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      )
      .run(
        input.id,
        input.projectId,
        input.noteId,
        input.sourceFileName,
        input.storedFileName,
        input.storagePath,
        input.thumbnailPath,
        input.mimeType,
        input.fileSize,
        input.lat,
        input.lng,
        input.capturedAt,
      );
    this.db.prepare(`UPDATE map_notes SET updated_at = CURRENT_TIMESTAMP WHERE id = ?`).run(input.noteId);
    this.db.prepare(`UPDATE projects SET updated_at = CURRENT_TIMESTAMP WHERE id = ?`).run(input.projectId);

    const saved = this.getMapNote(input.projectId, input.noteId)?.photos.find((photo) => photo.id === input.id);
    if (!saved) throw new Error(`Created map note photo ${input.id} not found`);
    return saved;
  }

  renameProject(projectId: string, newName: string): void {
    this.db
      .prepare(`UPDATE projects SET name = ?, updated_at = CURRENT_TIMESTAMP WHERE id = ?`)
      .run(newName, projectId);
  }

  deleteProject(projectId: string): boolean {
    const result = this.db.prepare(`DELETE FROM projects WHERE id = ?`).run(projectId);
    return result.changes > 0;
  }

  recalculateChecklist(input: RecalculateChecklistInput): RecalculateChecklistResult {
    const result: RecalculateChecklistResult = {
      addedNodes: 0,
      updatedNodes: 0,
      unchangedNodes: 0,
      addedAddresses: 0,
      reusedAddresses: 0,
      removedStaleNodes: 0,
      preservedAssignedStaleNodes: 0,
    };

    const tx = this.db.transaction(() => {
      const existingAddressRows = this.db
        .prepare(
          `SELECT
            id,
            city,
            street,
            building_no AS buildingNo,
            distribution_point AS distributionPoint
          FROM addresses
          WHERE project_id = ?`,
        )
        .all(input.projectId) as Array<{
          id: string;
          city: string;
          street: string;
          buildingNo: string | null;
          distributionPoint: string | null;
        }>;

      const addressKeyToId = new Map<string, string>();
      for (const address of existingAddressRows) {
        addressKeyToId.set(getAddressMergeKey(address), address.id);
      }

      const generatedAddressIdToActualId = new Map<string, string>();
      const insertAddress = this.db.prepare(
        `INSERT INTO addresses (
          id, project_id, city, street, building_no, property_id, parcel_number,
          distribution_point, lat, lng, household_count, business_unit_count
        ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      );
      const updateAddress = this.db.prepare(
        `UPDATE addresses
         SET city = ?,
           street = ?,
           building_no = ?,
           property_id = ?,
           parcel_number = ?,
           distribution_point = ?,
           lat = ?,
           lng = ?,
           household_count = ?,
           business_unit_count = ?,
           source = 'GPKG'
         WHERE id = ?
           AND project_id = ?`,
      );

      for (const address of input.addresses) {
        const key = getAddressMergeKey(address);
        const existingId = addressKeyToId.get(key);
        if (existingId) {
          updateAddress.run(
            address.city,
            address.street,
            address.buildingNo,
            address.propertyId,
            address.parcelNumber,
            address.distributionPoint,
            address.lat,
            address.lng,
            address.householdCount,
            address.businessUnitCount,
            existingId,
            input.projectId,
          );
          generatedAddressIdToActualId.set(address.id, existingId);
          result.reusedAddresses += 1;
          continue;
        }

        insertAddress.run(
          address.id,
          input.projectId,
          address.city,
          address.street,
          address.buildingNo,
          address.propertyId,
          address.parcelNumber,
          address.distributionPoint,
          address.lat,
          address.lng,
          address.householdCount,
          address.businessUnitCount,
        );
        addressKeyToId.set(key, address.id);
        generatedAddressIdToActualId.set(address.id, address.id);
        result.addedAddresses += 1;
      }

      const existingNodeRows = this.db
        .prepare(
          `SELECT id, parent_id AS parentId, path, source
           FROM checklist_nodes
           WHERE project_id = ?`,
        )
        .all(input.projectId) as Array<{
          id: string;
          parentId: string | null;
          path: string;
          source: ChecklistNodeSource;
        }>;

      const pathToExistingNodeId = new Map(existingNodeRows.map((node) => [node.path, node.id]));
      const generatedPaths = new Set(input.checklistNodes.map((node) => node.path));
      const generatedNodeIdToActualId = new Map<string, string>();
      const insertNode = this.db.prepare(
        `INSERT INTO checklist_nodes (
          id, project_id, parent_id, name, path, node_type, address_id,
          sort_order, min_photos, accepts_photos, source, status
        ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 'OPEN')`,
      );
      const updateNode = this.db.prepare(
        `UPDATE checklist_nodes
         SET parent_id = ?,
             name = ?,
             node_type = ?,
             source = ?,
             address_id = ?,
             sort_order = ?,
             min_photos = ?,
             accepts_photos = ?,
             status = CASE
               WHEN status = 'NOT_APPLICABLE'
                 AND COALESCE(not_applicable_reason, '') != ? THEN status
               WHEN ? = 1
                 AND ? > 0
                 AND (
                   SELECT COUNT(*)
                   FROM photos
                   WHERE checklist_node_id = checklist_nodes.id
                 ) >= ? THEN 'COMPLETE'
               ELSE 'OPEN'
             END,
             not_applicable_reason = CASE
               WHEN status = 'NOT_APPLICABLE'
                 AND COALESCE(not_applicable_reason, '') != ? THEN not_applicable_reason
               ELSE NULL
             END,
             updated_at = CURRENT_TIMESTAMP
         WHERE id = ? AND project_id = ?`,
      );

      for (const node of input.checklistNodes) {
        const existingId = pathToExistingNodeId.get(node.path);
        const actualId = existingId ?? node.id;
        generatedNodeIdToActualId.set(node.id, actualId);
        const actualParentId = node.parentId ? (generatedNodeIdToActualId.get(node.parentId) ?? null) : null;
        const actualAddressId = node.addressId
          ? (generatedAddressIdToActualId.get(node.addressId) ?? node.addressId)
          : null;

        if (existingId) {
          updateNode.run(
            actualParentId,
            node.name,
            node.nodeType,
            node.source ?? 'GPKG',
            actualAddressId,
            node.sortOrder,
            node.minPhotos,
            node.acceptsPhotos ? 1 : 0,
            STALE_GPKG_NODE_REASON,
            node.acceptsPhotos ? 1 : 0,
            node.minPhotos,
            node.minPhotos,
            STALE_GPKG_NODE_REASON,
            existingId,
            input.projectId,
          );
          result.updatedNodes += 1;
        } else {
          insertNode.run(
            node.id,
            input.projectId,
            actualParentId,
            node.name,
            node.path,
            node.nodeType,
            actualAddressId,
            node.sortOrder,
            node.minPhotos,
            node.acceptsPhotos ? 1 : 0,
            node.source ?? 'GPKG',
          );
          pathToExistingNodeId.set(node.path, node.id);
          result.addedNodes += 1;
        }
      }

      result.unchangedNodes = Math.max(0, existingNodeRows.length - result.updatedNodes);

      const nodeIdsWithOwnPhotos = new Set(
        (
          this.db
            .prepare(
              `SELECT checklist_node_id AS nodeId
               FROM photos
               WHERE project_id = ?
               GROUP BY checklist_node_id`,
            )
            .all(input.projectId) as Array<{ nodeId: string }>
        ).map((row) => row.nodeId),
      );
      const childIdsByParentId = new Map<string, string[]>();
      for (const node of existingNodeRows) {
        if (!node.parentId) continue;
        const children = childIdsByParentId.get(node.parentId) ?? [];
        children.push(node.id);
        childIdsByParentId.set(node.parentId, children);
      }

      const hasPhotoInSubtree = (nodeId: string): boolean => {
        if (nodeIdsWithOwnPhotos.has(nodeId)) return true;
        return (childIdsByParentId.get(nodeId) ?? []).some((childId) => hasPhotoInSubtree(childId));
      };

      const staleNodes = existingNodeRows.filter((node) => node.source === 'GPKG' && !generatedPaths.has(node.path));
      const staleNodeIds = new Set(staleNodes.map((node) => node.id));
      const staleNodeIdsWithPhotos = new Set(
        staleNodes.filter((node) => hasPhotoInSubtree(node.id)).map((node) => node.id),
      );
      const removableStaleNodes = staleNodes.filter((node) => {
        if (staleNodeIdsWithPhotos.has(node.id)) return false;
        const staleChildren = childIdsByParentId.get(node.id)?.filter((childId) => staleNodeIds.has(childId)) ?? [];
        return staleChildren.every((childId) => !staleNodeIdsWithPhotos.has(childId));
      });

      const updateStaleNode = this.db.prepare(
        `UPDATE checklist_nodes
         SET status = CASE
               WHEN status = 'NOT_APPLICABLE'
                 AND COALESCE(not_applicable_reason, '') != ? THEN status
               WHEN accepts_photos = 1
                 AND min_photos > 0
                 AND (
                   SELECT COUNT(*)
                   FROM photos
                   WHERE checklist_node_id = checklist_nodes.id
                 ) >= min_photos THEN 'COMPLETE'
               ELSE 'OPEN'
             END,
             not_applicable_reason = CASE
               WHEN status = 'NOT_APPLICABLE'
                 AND COALESCE(not_applicable_reason, '') != ? THEN not_applicable_reason
               ELSE NULL
             END,
             updated_at = CURRENT_TIMESTAMP
         WHERE id = ? AND project_id = ?`,
      );
      for (const nodeId of staleNodeIdsWithPhotos) {
        updateStaleNode.run(STALE_GPKG_NODE_REASON, STALE_GPKG_NODE_REASON, nodeId, input.projectId);
      }
      result.preservedAssignedStaleNodes = staleNodeIdsWithPhotos.size;

      const deleteNode = this.db.prepare(`DELETE FROM checklist_nodes WHERE id = ? AND project_id = ?`);
      for (const node of removableStaleNodes.sort((a, b) => b.path.length - a.path.length)) {
        deleteNode.run(node.id, input.projectId);
        result.removedStaleNodes += 1;
      }

      this.db
        .prepare(
          `UPDATE projects
           SET project_definition = ?,
               project_type = ?,
               splitter_topology = ?,
               splitter_count = ?,
               splitter_topology_source = ?,
               gpkg_file_name = ?,
               address_count = ?,
               dac_to_address_cable_count = ?,
               adss_to_address_cable_count = ?,
               updated_at = CURRENT_TIMESTAMP
           WHERE id = ?`,
        )
        .run(
          input.projectDefinition,
          input.projectType,
          input.splitterTopology,
          input.splitterCount,
          input.splitterTopologySource,
          input.gpkgFileName,
          input.addresses.length,
          input.dacToAddressCableCount,
          input.adssToAddressCableCount,
          input.projectId,
        );

      this.replaceMapFeatures(
        input.projectId,
        input.polygons ?? [],
        input.trunkCables ?? [],
        input.infraNodes ?? [],
        input.infrastructureFeatures ?? [],
      );
    });

    tx();
    return result;
  }

  getChecklistNode(projectId: string, nodeId: string) {
    return this.db
      .prepare(
        `SELECT
          id,
          project_id AS projectId,
          parent_id AS parentId,
          name,
          path,
          node_type AS nodeType,
          source,
          address_id AS addressId,
          sort_order AS sortOrder,
          min_photos AS minPhotos,
          accepts_photos AS acceptsPhotos,
          status,
          not_applicable_reason AS notApplicableReason
        FROM checklist_nodes
        WHERE project_id = ? AND id = ?`,
      )
      .get(projectId, nodeId) as
      | {
          id: string;
          projectId: string;
          parentId: string | null;
          name: string;
          path: string;
          nodeType: string;
          source: ChecklistNodeSource;
          addressId: string | null;
          sortOrder: number;
          minPhotos: number;
          acceptsPhotos: number;
          status: string;
          notApplicableReason: string | null;
        }
      | undefined;
  }

  addManualChecklistNode(input: AddManualChecklistNodeInput): ChecklistNodeRecord {
    const name = input.name.trim();
    if (!name) throw new Error('Checklist node name is required');

    const parent = input.parentId ? this.getChecklistNode(input.projectId, input.parentId) : null;
    if (input.parentId && !parent) throw new Error('Parent checklist node not found');
    if (parent && Boolean(parent.acceptsPhotos)) {
      throw new Error('Cannot add a child folder under a photo folder');
    }

    const id = randomUUID();
    const pathPart = safeFolderName(name);
    const path = parent ? `${parent.path}/${pathPart}` : pathPart;
    const existing = this.db
      .prepare(`SELECT id FROM checklist_nodes WHERE project_id = ? AND path = ?`)
      .get(input.projectId, path);
    if (existing) throw new Error('Checklist folder already exists');

    const row = this.db
      .prepare(
        `SELECT COALESCE(MAX(sort_order), -1) + 1 AS sortOrder
         FROM checklist_nodes
         WHERE project_id = ? AND parent_id IS ?`,
      )
      .get(input.projectId, parent?.id ?? null) as { sortOrder: number } | undefined;

    this.db
      .prepare(
        `INSERT INTO checklist_nodes (
          id, project_id, parent_id, name, path, node_type, source, address_id,
          sort_order, min_photos, accepts_photos, status
        ) VALUES (?, ?, ?, ?, ?, ?, 'MANUAL', NULL, ?, ?, ?, 'OPEN')`,
      )
      .run(
        id,
        input.projectId,
        parent?.id ?? null,
        name,
        path,
        input.nodeType,
        Number(row?.sortOrder ?? 0),
        input.minPhotos,
        input.acceptsPhotos ? 1 : 0,
      );

    const created = (this.getChecklist(input.projectId) as ChecklistNodeRecord[]).find((node) => node.id === id);
    if (!created) throw new Error(`Created checklist node ${id} not found`);
    return created;
  }

  countPhotosForNode(nodeId: string, reserveLocation: string | null): number {
    const row = this.db
      .prepare(
        `SELECT COUNT(*) AS count
         FROM photos
         WHERE checklist_node_id = ?
           AND (? IS NULL OR reserve_location = ?)`,
      )
      .get(nodeId, reserveLocation, reserveLocation) as { count: number } | undefined;
    return Number(row?.count ?? 0);
  }

  getNodePhotos(projectId: string, nodeId: string): ChecklistPhotoRecord[] {
    return this.db
      .prepare(
        `SELECT
          id,
          project_id AS projectId,
          checklist_node_id AS checklistNodeId,
          source_file_name AS sourceFileName,
          stored_file_name AS storedFileName,
          storage_path AS storagePath,
          thumbnail_path AS thumbnailPath,
          mime_type AS mimeType,
          file_size AS fileSize,
          lat,
          lng,
          captured_at AS capturedAt,
          uploaded_at AS uploadedAt,
          reserve_location AS reserveLocation
        FROM photos
        WHERE project_id = ? AND checklist_node_id = ?
        ORDER BY uploaded_at ASC, id ASC`,
      )
      .all(projectId, nodeId) as ChecklistPhotoRecord[];
  }

  getPhotosByIds(projectId: string, nodeId: string, photoIds: string[]): ChecklistPhotoRecord[] {
    if (photoIds.length === 0) return [];

    const placeholders = photoIds.map(() => '?').join(', ');
    return this.db
      .prepare(
        `SELECT
          id,
          project_id AS projectId,
          checklist_node_id AS checklistNodeId,
          source_file_name AS sourceFileName,
          stored_file_name AS storedFileName,
          storage_path AS storagePath,
          thumbnail_path AS thumbnailPath,
          mime_type AS mimeType,
          file_size AS fileSize,
          lat,
          lng,
          captured_at AS capturedAt,
          uploaded_at AS uploadedAt,
          reserve_location AS reserveLocation
        FROM photos
        WHERE project_id = ? AND checklist_node_id = ? AND id IN (${placeholders})
        ORDER BY uploaded_at ASC, id ASC`,
      )
      .all(projectId, nodeId, ...photoIds) as ChecklistPhotoRecord[];
  }

  getPhoto(projectId: string, photoId: string): ChecklistPhotoRecord | null {
    return (
      (this.db
        .prepare(
          `SELECT
            id,
            project_id AS projectId,
            checklist_node_id AS checklistNodeId,
            source_file_name AS sourceFileName,
            stored_file_name AS storedFileName,
            storage_path AS storagePath,
            thumbnail_path AS thumbnailPath,
            mime_type AS mimeType,
            file_size AS fileSize,
            lat,
            lng,
            captured_at AS capturedAt,
            uploaded_at AS uploadedAt,
            reserve_location AS reserveLocation
          FROM photos
          WHERE project_id = ? AND id = ?`,
        )
        .get(projectId, photoId) as ChecklistPhotoRecord | undefined) ?? null
    );
  }

  updatePhotoRecord(
    photoId: string,
    input: {
      storedFileName: string;
      storagePath: string;
      thumbnailPath: string | null;
      reserveLocation: string | null;
    },
  ): void {
    this.db
      .prepare(
        `UPDATE photos
         SET stored_file_name = ?, storage_path = ?, thumbnail_path = ?, reserve_location = ?
         WHERE id = ?`,
      )
      .run(input.storedFileName, input.storagePath, input.thumbnailPath, input.reserveLocation, photoId);
  }

  listProjectPhotoContentHashes(projectId: string): string[] {
    return listKnownProjectPhotoHashes(this.db, projectId);
  }

  private refreshChecklistNodeStatus(projectId: string, nodeId: string): void {
    this.db
      .prepare(
        `UPDATE checklist_nodes
         SET status = CASE
           WHEN status = 'NOT_APPLICABLE' THEN status
           WHEN accepts_photos = 1
             AND min_photos > 0
             AND (
               SELECT COUNT(*)
               FROM photos
               WHERE checklist_node_id = checklist_nodes.id
             ) >= min_photos THEN 'COMPLETE'
           ELSE 'OPEN'
         END,
         updated_at = CURRENT_TIMESTAMP
         WHERE project_id = ? AND id = ?`,
      )
      .run(projectId, nodeId);
  }

  deletePhotoRecords(projectId: string, nodeId: string, photoIds: string[]): number {
    if (photoIds.length === 0) return 0;

    const placeholders = photoIds.map(() => '?').join(', ');
    const tx = this.db.transaction(() => {
      const result = this.db
        .prepare(
          `DELETE FROM photos
           WHERE project_id = ?
             AND checklist_node_id = ?
             AND id IN (${placeholders})`,
        )
        .run(projectId, nodeId, ...photoIds);

      this.refreshChecklistNodeStatus(projectId, nodeId);
      this.db.prepare(`UPDATE projects SET updated_at = CURRENT_TIMESTAMP WHERE id = ?`).run(projectId);
      return result.changes;
    });

    return Number(tx());
  }

  movePhotoRecord(input: MovePhotoRecordInput): void {
    const tx = this.db.transaction(() => {
      this.db
        .prepare(
          `UPDATE photos
           SET checklist_node_id = ?,
               stored_file_name = ?,
               storage_path = ?,
               thumbnail_path = ?,
               reserve_location = ?
           WHERE project_id = ? AND id = ? AND checklist_node_id = ?`,
        )
        .run(
          input.targetNodeId,
          input.storedFileName,
          input.storagePath,
          input.thumbnailPath,
          input.reserveLocation,
          input.projectId,
          input.photoId,
          input.sourceNodeId,
        );

      this.refreshChecklistNodeStatus(input.projectId, input.sourceNodeId);
      this.refreshChecklistNodeStatus(input.projectId, input.targetNodeId);
      this.db.prepare(`UPDATE projects SET updated_at = CURRENT_TIMESTAMP WHERE id = ?`).run(input.projectId);
    });

    tx();
  }

  addPhoto(input: AddPhotoInput): void {
    const tx = this.db.transaction(() => {
      this.db
        .prepare(
          `INSERT INTO photos (
            id, project_id, checklist_node_id, source_file_name, stored_file_name,
            storage_path, thumbnail_path, mime_type, file_size, lat, lng,
            captured_at, reserve_location, content_hash
          ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
        )
        .run(
          input.id,
          input.projectId,
          input.checklistNodeId,
          input.sourceFileName,
          input.storedFileName,
          input.storagePath,
          input.thumbnailPath,
          input.mimeType,
          input.fileSize,
          input.lat,
          input.lng,
          input.capturedAt,
          input.reserveLocation,
          input.contentHash ?? null,
        );

      this.db
        .prepare(
          `UPDATE checklist_nodes
           SET status = CASE
             WHEN (
               SELECT COUNT(*)
               FROM photos
               WHERE checklist_node_id = ?
             ) >= min_photos THEN 'COMPLETE'
             ELSE status
           END,
           updated_at = CURRENT_TIMESTAMP
           WHERE id = ?`,
        )
        .run(input.checklistNodeId, input.checklistNodeId);

      this.db.prepare(`UPDATE projects SET updated_at = CURRENT_TIMESTAMP WHERE id = ?`).run(input.projectId);
    });

    tx();
  }

  markNotApplicable(projectId: string, nodeId: string, reason: string | null): void {
    this.db
      .prepare(
        `UPDATE checklist_nodes
         SET status = 'NOT_APPLICABLE', not_applicable_reason = ?, updated_at = CURRENT_TIMESTAMP
         WHERE id = ? AND project_id = ?`,
      )
      .run(reason, nodeId, projectId);
  }

  markAddressNotApplicable(projectId: string, addressId: string, reason: string | null): void {
    const reserveNodes = this.db
      .prepare(
        `SELECT id
         FROM checklist_nodes
         WHERE project_id = ?
           AND address_id = ?
           AND node_type = 'CABLE_RESERVE'`,
      )
      .all(projectId, addressId) as Array<{ id: string }>;

    if (reserveNodes.length === 0) throw new Error('Address reserve node not found');

    const tx = this.db.transaction(() => {
      const updateNode = this.db.prepare(
        `UPDATE checklist_nodes
         SET status = 'NOT_APPLICABLE',
             not_applicable_reason = ?,
             updated_at = CURRENT_TIMESTAMP
         WHERE project_id = ? AND id = ?`,
      );
      for (const node of reserveNodes) {
        updateNode.run(reason, projectId, node.id);
      }
      this.db.prepare(`UPDATE projects SET updated_at = CURRENT_TIMESTAMP WHERE id = ?`).run(projectId);
    });

    tx();
  }

  reopenNode(projectId: string, nodeId: string): void {
    this.db
      .prepare(
        `UPDATE checklist_nodes
         SET status = 'OPEN', not_applicable_reason = NULL, updated_at = CURRENT_TIMESTAMP
         WHERE id = ? AND project_id = ?`,
      )
      .run(nodeId, projectId);
  }
}
