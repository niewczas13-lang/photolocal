import type Database from 'better-sqlite3';
import { readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { ensureDefaultUsers } from '../auth/app-auth.js';

const __dirname = dirname(fileURLToPath(import.meta.url));
const AUTO_STALE_GPKG_NODE_REASON = 'Nie wystepuje w ostatnio przeliczonym GPKG';

export function runMigrations(db: Database.Database): void {
  const schema = readFileSync(join(__dirname, 'schema.sql'), 'utf8');
  db.exec(schema);

  try {
    db.exec('ALTER TABLE projects ADD COLUMN project_definition TEXT;');
  } catch (e) {
    // Ignore error if column already exists
  }

  try {
    db.exec(
      "ALTER TABLE checklist_nodes ADD COLUMN source TEXT NOT NULL DEFAULT 'GPKG' CHECK (source IN ('GPKG', 'MANUAL', 'SYSTEM'));",
    );
  } catch (e) {
    // Ignore error if column already exists
  }

  try {
    db.exec('ALTER TABLE projects ADD COLUMN google_chat_space_name TEXT;');
  } catch (e) {
    // Ignore error if column already exists
  }

  try {
    db.exec('ALTER TABLE projects ADD COLUMN google_chat_space_display_name TEXT;');
  } catch (e) {
    // Ignore error if column already exists
  }

  try {
    db.exec('ALTER TABLE projects ADD COLUMN google_chat_last_download_at TEXT;');
  } catch (e) {
    // Ignore error if column already exists
  }

  try {
    db.exec('ALTER TABLE photos ADD COLUMN content_hash TEXT;');
  } catch (e) {
    // Ignore error if column already exists
  }

  try {
    db.exec("ALTER TABLE addresses ADD COLUMN source TEXT NOT NULL DEFAULT 'GPKG' CHECK (source IN ('GPKG', 'MANUAL_MAP'));");
  } catch (e) {
    // Ignore error if column already exists
  }

  try {
    db.exec(
      'ALTER TABLE addresses ADD COLUMN opl_consent_confirmed INTEGER NOT NULL DEFAULT 0 CHECK (opl_consent_confirmed IN (0, 1));',
    );
  } catch (e) {
    // Ignore error if column already exists
  }

  try {
    db.exec(
      'ALTER TABLE addresses ADD COLUMN has_aerial_reserve INTEGER NOT NULL DEFAULT 0 CHECK (has_aerial_reserve IN (0, 1));',
    );
  } catch (e) {
    // Ignore error if column already exists
  }

  try {
    db.exec("ALTER TABLE chat_photo_batches ADD COLUMN source_messages TEXT NOT NULL DEFAULT '[]';");
  } catch (e) {
    // Ignore error if column already exists
  }

  try {
    db.exec('ALTER TABLE chat_photo_files ADD COLUMN content_hash TEXT;');
  } catch (e) {
    // Ignore error if column already exists
  }

  migrateChatReserveLocationConstraint(db, schema);
  migrateMapTrunkCableIdentity(db, schema);
  backfillSystemMetkiFolder(db);
  backfillWykopyPrzeciskiPhotoTarget(db);
  repairAutoStaleChecklistStatuses(db);
  ensureDefaultUsers(db);
}

function tableColumns(db: Database.Database, tableName: string): Set<string> {
  const rows = db.prepare(`PRAGMA table_info(${tableName})`).all() as Array<{ name: string }>;
  return new Set(rows.map((row) => row.name));
}

function migrateMapTrunkCableIdentity(db: Database.Database, schema: string): void {
  const row = db
    .prepare("SELECT sql FROM sqlite_master WHERE type = 'table' AND name = 'map_trunk_cables'")
    .get() as { sql: string } | undefined;

  if (
    !row?.sql ||
    (row.sql.includes('cable_key') &&
      row.sql.includes('route_type') &&
      row.sql.includes('existing_duct') &&
      row.sql.includes('route_length_m') &&
      row.sql.includes('installation_length_m') &&
      row.sql.includes('SUSPENDED') &&
      row.sql.includes('UNIQUE(project_id, cable_key)'))
  ) {
    return;
  }

  const columns = tableColumns(db, 'map_trunk_cables');
  const cableKeyExpression = columns.has('cable_key')
    ? 'cable_key'
    : "COALESCE(NULLIF(TRIM(raw_name), ''), from_node || '|' || to_node || '|' || cable_type)";
  const statusExpression = columns.has('status')
    ? "CASE WHEN status IN ('PENDING', 'DUCT_READY', 'PULLED', 'WELDED', 'SUSPENDED') THEN status ELSE 'PENDING' END"
    : "'PENDING'";
  const rawNameExpression = columns.has('raw_name') ? "COALESCE(raw_name, '')" : "''";
  const routeTypeExpression = columns.has('route_type')
    ? "CASE WHEN route_type IN ('underground', 'aerial', 'existing_duct') THEN route_type ELSE 'underground' END"
    : `CASE WHEN cable_type LIKE '%ADSS%' OR ${rawNameExpression} LIKE '%ADSS%' THEN 'aerial' ELSE 'underground' END`;
  const routeLengthExpression = columns.has('route_length_m') ? 'route_length_m' : 'NULL';
  const installationLengthExpression = columns.has('installation_length_m') ? 'installation_length_m' : 'NULL';

  db.exec(`
    PRAGMA foreign_keys = OFF;
    ALTER TABLE map_trunk_cables RENAME TO map_trunk_cables_old;
  `);
  db.exec(schema);
  db.exec(`
    INSERT OR IGNORE INTO map_trunk_cables (
      id, project_id, cable_key, cable_type, route_type, from_node, to_node, osd_name,
      geojson, raw_name, route_length_m, installation_length_m, status
    )
    SELECT
      id,
      project_id,
      ${cableKeyExpression},
      cable_type,
      ${routeTypeExpression},
      from_node,
      to_node,
      osd_name,
      geojson,
      raw_name,
      ${routeLengthExpression},
      ${installationLengthExpression},
      ${statusExpression}
    FROM map_trunk_cables_old;
    DROP TABLE map_trunk_cables_old;
    PRAGMA foreign_keys = ON;
  `);
  db.exec(schema);
}

function migrateChatReserveLocationConstraint(db: Database.Database, schema: string): void {
  const row = db
    .prepare("SELECT sql FROM sqlite_master WHERE type = 'table' AND name = 'chat_photo_batches'")
    .get() as { sql: string } | undefined;

  if (!row?.sql || row.sql.includes('Napowietrzny')) return;

  db.exec(`
    PRAGMA foreign_keys = OFF;
    ALTER TABLE chat_photo_batches RENAME TO chat_photo_batches_old;
  `);
  db.exec(schema);
  db.exec(`
    INSERT INTO chat_photo_batches (
      id, project_id, source, source_space_name, source_space_display_name,
      source_message_name, message_text, source_create_time, folder_name, folder_path,
      status, review_reason, checklist_node_id, reserve_location, confidence,
      llm_model, llm_raw_response, visual_evidence, created_at, updated_at
    )
    SELECT
      id, project_id, source, source_space_name, source_space_display_name,
      source_message_name, message_text, source_create_time, folder_name, folder_path,
      status, review_reason, checklist_node_id, reserve_location, confidence,
      llm_model, llm_raw_response, visual_evidence, created_at, updated_at
    FROM chat_photo_batches_old;
    DROP TABLE chat_photo_batches_old;
    PRAGMA foreign_keys = ON;
  `);
  db.exec(schema);
}

function backfillSystemMetkiFolder(db: Database.Database): void {
  const projects = db.prepare('SELECT id FROM projects').all() as Array<{ id: string }>;
  const insertRoot = db.prepare(
    `INSERT OR IGNORE INTO checklist_nodes (
      id, project_id, parent_id, name, path, node_type, source, address_id,
      sort_order, min_photos, accepts_photos, status
    ) VALUES (?, ?, NULL, 'Metki', 'Metki', 'STATIC', 'SYSTEM', NULL, 6, 0, 0, 'OPEN')`,
  );
  const updateRoot = db.prepare(
    `UPDATE checklist_nodes
     SET parent_id = NULL,
         name = 'Metki',
         node_type = 'STATIC',
         source = 'SYSTEM',
         address_id = NULL,
         sort_order = 6,
         min_photos = 0,
         accepts_photos = 0,
         updated_at = CURRENT_TIMESTAMP
     WHERE id = ?`,
  );
  const insertChild = db.prepare(
    `INSERT OR IGNORE INTO checklist_nodes (
      id, project_id, parent_id, name, path, node_type, source, address_id,
      sort_order, min_photos, accepts_photos, status
    ) VALUES (?, ?, ?, 'Zdjecia', 'Metki/Zdjecia', 'STATIC', 'SYSTEM', NULL, 0, 0, 1, 'OPEN')`,
  );
  const updateChild = db.prepare(
    `UPDATE checklist_nodes
     SET parent_id = ?,
         name = 'Zdjecia',
         node_type = 'STATIC',
         source = 'SYSTEM',
         address_id = NULL,
         sort_order = 0,
         min_photos = 0,
         accepts_photos = 1,
         updated_at = CURRENT_TIMESTAMP
     WHERE id = ?`,
  );
  const getNodeByPath = db.prepare(
    `SELECT id
     FROM checklist_nodes
     WHERE project_id = ? AND path = ?`,
  );
  const moveRootPhotos = db.prepare(
    `UPDATE photos
     SET checklist_node_id = ?
     WHERE project_id = ? AND checklist_node_id = ?`,
  );

  const tx = db.transaction(() => {
    for (const project of projects) {
      insertRoot.run(`system-metki-${project.id}`, project.id);

      const root = getNodeByPath.get(project.id, 'Metki') as { id: string } | undefined;
      if (!root) continue;
      updateRoot.run(root.id);

      insertChild.run(`system-metki-photos-${project.id}`, project.id, root.id);
      const child = getNodeByPath.get(project.id, 'Metki/Zdjecia') as { id: string } | undefined;
      if (!child) continue;

      updateChild.run(root.id, child.id);
      moveRootPhotos.run(child.id, project.id, root.id);
    }
  });

  tx();
}

function backfillWykopyPrzeciskiPhotoTarget(db: Database.Database): void {
  const projects = db.prepare('SELECT id FROM projects').all() as Array<{ id: string }>;
  const insertRoot = db.prepare(
    `INSERT OR IGNORE INTO checklist_nodes (
      id, project_id, parent_id, name, path, node_type, source, address_id,
      sort_order, min_photos, accepts_photos, status
    ) VALUES (?, ?, NULL, 'Wykopy/Przeciski', 'Wykopy_Przeciski', 'STATIC', 'GPKG', NULL, 1, 0, 1, 'OPEN')`,
  );
  const updateRoot = db.prepare(
    `UPDATE checklist_nodes
     SET parent_id = NULL,
         name = 'Wykopy/Przeciski',
         node_type = 'STATIC',
         address_id = NULL,
         sort_order = 1,
         min_photos = 0,
         accepts_photos = 1,
         updated_at = CURRENT_TIMESTAMP
     WHERE project_id = ? AND path = 'Wykopy_Przeciski'`,
  );

  const tx = db.transaction(() => {
    for (const project of projects) {
      insertRoot.run(`system-wykopy-przeciski-${project.id}`, project.id);
      updateRoot.run(project.id);
    }
  });

  tx();
}

function repairAutoStaleChecklistStatuses(db: Database.Database): void {
  db.prepare(
    `WITH RECURSIVE stale_subtree(root_id, node_id) AS (
       SELECT id, id
       FROM checklist_nodes
       WHERE status = 'NOT_APPLICABLE'
         AND not_applicable_reason = ?

       UNION ALL

       SELECT stale_subtree.root_id, child.id
       FROM checklist_nodes child
       JOIN stale_subtree ON child.parent_id = stale_subtree.node_id
     ),
     repair_nodes AS (
       SELECT DISTINCT stale_subtree.root_id AS id
       FROM stale_subtree
       JOIN photos ON photos.checklist_node_id = stale_subtree.node_id
     )
     UPDATE checklist_nodes
     SET status = CASE
           WHEN accepts_photos = 1
             AND min_photos > 0
             AND (
               SELECT COUNT(*)
               FROM photos
               WHERE checklist_node_id = checklist_nodes.id
             ) >= min_photos THEN 'COMPLETE'
           ELSE 'OPEN'
         END,
         not_applicable_reason = NULL,
         updated_at = CURRENT_TIMESTAMP
     WHERE id IN (SELECT id FROM repair_nodes)`,
  ).run(AUTO_STALE_GPKG_NODE_REASON);
}
