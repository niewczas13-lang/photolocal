import type Database from 'better-sqlite3';
import { randomUUID } from 'node:crypto';
import type {
  ChecklistNodeRecord,
  ChecklistNodeSource,
  ChecklistNodeType,
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

export class ProjectsRepository {
  constructor(private readonly db: Database.Database) {}

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
