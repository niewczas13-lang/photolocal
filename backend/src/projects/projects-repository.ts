import type Database from 'better-sqlite3';
import { randomUUID } from 'node:crypto';
import type {
  ChecklistNodeRecord,
  ChecklistNodeSource,
  ChecklistNodeType,
  CableRoutingType,
  MapCableStatus,
  MapInfraNodeInput,
  MapNodeStatus,
  MapPolygonInput,
  MapTrunkCableInput,
  ProjectMapRecord,
  ProjectRecord,
  ProjectType,
  SplitterTopology,
  SplitterTopologySource,
} from '../types.js';
import type { GeneratedChecklistNode, ChecklistAddress } from '../checklist/checklist-generator.js';
import { safeFolderName } from '../utils/path-names.js';

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

function getMapCableKey(cable: Pick<MapTrunkCableInput, 'rawName' | 'fromNode' | 'toNode' | 'cableType'>): string {
  const rawName = cable.rawName?.trim();
  return rawName || `${cable.fromNode}|${cable.toNode}|${cable.cableType}`;
}

function getCableRoutingType(cable: Pick<MapTrunkCableInput, 'routingType' | 'cableType' | 'rawName'>): CableRoutingType {
  if (cable.routingType === 'aerial' || cable.routingType === 'underground') return cable.routingType;
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

export class ProjectsRepository {
  constructor(private readonly db: Database.Database) {}

  private replaceMapFeatures(
    projectId: string,
    polygons: MapPolygonInput[],
    trunkCables: MapTrunkCableInput[],
    infraNodes: MapInfraNodeInput[],
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
      .prepare(`SELECT cable_key AS cableKey FROM map_trunk_cables WHERE project_id = ?`)
      .all(projectId) as Array<{ cableKey: string }>;
    const deleteCable = this.db.prepare(
      `DELETE FROM map_trunk_cables WHERE project_id = ? AND cable_key = ?`,
    );
    for (const row of existingCableRows) {
      if (!cableKeys.has(row.cableKey)) deleteCable.run(projectId, row.cableKey);
    }

    const insertCable = this.db.prepare(
      `INSERT INTO map_trunk_cables (
        id, project_id, cable_key, cable_type, route_type, from_node, to_node, osd_name, geojson, raw_name
      ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
      ON CONFLICT(project_id, cable_key) DO UPDATE SET
        cable_type = excluded.cable_type,
        route_type = excluded.route_type,
        from_node = excluded.from_node,
        to_node = excluded.to_node,
        osd_name = excluded.osd_name,
        geojson = excluded.geojson,
        raw_name = excluded.raw_name`,
    );
    for (const cable of trunkCables) {
      insertCable.run(
        randomUUID(),
        projectId,
        getMapCableKey(cable),
        cable.cableType,
        getCableRoutingType(cable),
        cable.fromNode,
        cable.toNode,
        cable.osdName,
        JSON.stringify(cable.geojson),
        cable.rawName,
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

      this.replaceMapFeatures(id, input.polygons ?? [], input.trunkCables ?? [], input.infraNodes ?? []);
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

  getProjectMap(projectId: string): ProjectMapRecord {
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
          COUNT(photo.id) AS reservePhotoCount
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
      reservePhotoCount: number;
    }>;

    const addresses = addressRows.map((address) => {
      const reservePhotoCount = Number(address.reservePhotoCount);
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
        hasReservePhoto: reservePhotoCount > 0,
      };
    });

    const addressCountsByNode = new Map<string, { total: number; withReservePhoto: number }>();
    const addressCountsByTerminalNode = new Map<string, { total: number; withReservePhoto: number }>();
    for (const address of addresses) {
      const nodeKey = normalizeMapNodeKey(address.distributionPoint);
      if (!nodeKey) continue;
      const counts = addressCountsByNode.get(nodeKey) ?? { total: 0, withReservePhoto: 0 };
      counts.total += 1;
      if (address.hasReservePhoto) counts.withReservePhoto += 1;
      addressCountsByNode.set(nodeKey, counts);

      const terminalNodeKey = normalizeMapNodeTerminalKey(address.distributionPoint);
      const terminalCounts = addressCountsByTerminalNode.get(terminalNodeKey) ?? {
        total: 0,
        withReservePhoto: 0,
      };
      terminalCounts.total += 1;
      if (address.hasReservePhoto) terminalCounts.withReservePhoto += 1;
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
      status: cable.status,
    }));

    const photoNodeRows = this.db
      .prepare(
        `SELECT
          node.name,
          node.path,
          COUNT(photo.id) AS photoCount
        FROM checklist_nodes node
        LEFT JOIN photos photo ON photo.checklist_node_id = node.id
        WHERE node.project_id = ?
          AND node.node_type != 'CABLE_RESERVE'
        GROUP BY node.id
        HAVING COUNT(photo.id) > 0`,
      )
      .all(projectId) as Array<{ name: string; path: string; photoCount: number }>;

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
      const hasPhoto = photoNodeRows.some((photoNode) => {
        const nameKey = normalizeSearchKey(photoNode.name);
        const pathKey = normalizeSearchKey(photoNode.path);
        return nameKey === nodeKey || pathKey.includes(nodeKey);
      });
      return {
        id: node.id,
        nodeType: node.nodeType,
        name: node.name,
        label: node.label,
        lat: Number(node.lat),
        lng: Number(node.lng),
        status: node.status,
        hasPhoto,
      };
    });

    return { addresses, polygons, trunkCables, infraNodes };
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

      for (const address of input.addresses) {
        const key = getAddressMergeKey(address);
        const existingId = addressKeyToId.get(key);
        if (existingId) {
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
         SET status = 'NOT_APPLICABLE',
             not_applicable_reason = 'Nie wystepuje w ostatnio przeliczonym GPKG',
             updated_at = CURRENT_TIMESTAMP
         WHERE id = ? AND project_id = ?`,
      );
      for (const nodeId of staleNodeIdsWithPhotos) {
        updateStaleNode.run(nodeId, input.projectId);
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

  addPhoto(input: AddPhotoInput): void {
    const tx = this.db.transaction(() => {
      this.db
        .prepare(
          `INSERT INTO photos (
            id, project_id, checklist_node_id, source_file_name, stored_file_name,
            storage_path, thumbnail_path, mime_type, file_size, lat, lng,
            captured_at, reserve_location
          ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
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
