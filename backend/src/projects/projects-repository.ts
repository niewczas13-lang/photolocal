import type Database from 'better-sqlite3';
import { randomUUID } from 'node:crypto';
import type { ProjectRecord, ProjectType, SplitterTopology, SplitterTopologySource } from '../types.js';
import type { GeneratedChecklistNode, ChecklistAddress } from '../checklist/checklist-generator.js';

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
          sort_order, min_photos, accepts_photos, status
        ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 'OPEN')`,
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
          addressId: string | null;
          sortOrder: number;
          minPhotos: number;
          acceptsPhotos: number;
          status: string;
          notApplicableReason: string | null;
        }
      | undefined;
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
