import Database from 'better-sqlite3';
import { randomUUID } from 'node:crypto';
import { mkdirSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { runMigrations } from './migrations.js';

function insertProject(db: Database.Database, id: string): void {
  db.prepare(
    `INSERT INTO projects (
      id, name, project_type, splitter_topology, splitter_topology_source,
      gpkg_file_name, base_folder
    ) VALUES (?, ?, 'SI', 'SINGLE', 'AUTO', 'projekt.gpkg', 'C:/photos')`,
  ).run(id, id);
}

describe('runMigrations', () => {
  it('creates the project photo hash cache table', () => {
    const db = new Database(':memory:');
    runMigrations(db);

    const table = db
      .prepare("SELECT name FROM sqlite_master WHERE type = 'table' AND name = 'project_photo_hash_cache'")
      .get() as { name: string } | undefined;
    db.close();

    expect(table).toMatchObject({ name: 'project_photo_hash_cache' });
  });

  it('migrates legacy Metki checklist nodes into a folder with a photo child', () => {
    const db = new Database(':memory:');
    runMigrations(db);

    insertProject(db, 'project-1');
    db.prepare(
      `INSERT INTO checklist_nodes (
        id, project_id, parent_id, name, path, node_type, source,
        address_id, sort_order, min_photos, accepts_photos, status
      ) VALUES (
        'legacy-metki', 'project-1', NULL, 'Metki', 'Metki', 'STATIC', 'SYSTEM',
        NULL, 6, 0, 1, 'OPEN'
      )`,
    ).run();
    db.prepare(
      `INSERT INTO photos (
        id, project_id, checklist_node_id, source_file_name, stored_file_name,
        storage_path, mime_type, file_size
      ) VALUES (
        'photo-1', 'project-1', 'legacy-metki', 'metka.jpg', 'metka.jpg',
        'Metki/metka.jpg', 'image/jpeg', 10
      )`,
    ).run();

    runMigrations(db);

    const metki = db
      .prepare(
        `SELECT id, parent_id AS parentId, accepts_photos AS acceptsPhotos
         FROM checklist_nodes
         WHERE project_id = 'project-1' AND path = 'Metki'`,
      )
      .get() as { id: string; parentId: string | null; acceptsPhotos: number };
    const metkiPhotos = db
      .prepare(
        `SELECT id, parent_id AS parentId, accepts_photos AS acceptsPhotos
         FROM checklist_nodes
         WHERE project_id = 'project-1' AND path = 'Metki/Zdjecia'`,
      )
      .get() as { id: string; parentId: string; acceptsPhotos: number };
    const photo = db
      .prepare("SELECT checklist_node_id AS checklistNodeId FROM photos WHERE id = 'photo-1'")
      .get() as { checklistNodeId: string };

    expect(metki).toMatchObject({ id: 'legacy-metki', parentId: null, acceptsPhotos: 0 });
    expect(metkiPhotos).toMatchObject({ parentId: 'legacy-metki', acceptsPhotos: 1 });
    expect(photo.checklistNodeId).toBe(metkiPhotos.id);

    db.close();
  });

  it('does not hash existing photo files during startup migrations', () => {
    const dir = join(tmpdir(), `photo-local-migration-${randomUUID()}`);
    const photoPath = join(dir, 'photos', 'photo.jpg');
    mkdirSync(join(dir, 'photos'), { recursive: true });
    writeFileSync(photoPath, 'existing-photo');

    const db = new Database(':memory:');
    runMigrations(db);
    insertProject(db, 'project-1');
    db.prepare(
      `INSERT INTO checklist_nodes (
        id, project_id, parent_id, name, path, node_type, source,
        address_id, sort_order, min_photos, accepts_photos, status
      ) VALUES (
        'node-1', 'project-1', NULL, 'Node', 'Node', 'STATIC', 'SYSTEM',
        NULL, 0, 0, 1, 'OPEN'
      )`,
    ).run();
    db.prepare(
      `INSERT INTO photos (
        id, project_id, checklist_node_id, source_file_name, stored_file_name,
        storage_path, mime_type, file_size, content_hash
      ) VALUES (
        'photo-1', 'project-1', 'node-1', 'photo.jpg', 'photo.jpg',
        ?, 'image/jpeg', 10, NULL
      )`,
    ).run(photoPath);

    runMigrations(db);

    const photo = db
      .prepare("SELECT content_hash AS contentHash FROM photos WHERE id = 'photo-1'")
      .get() as { contentHash: string | null };
    db.close();

    expect(photo.contentHash).toBeNull();
  });

  it('repairs automatic stale checklist statuses when preserved photos exist', () => {
    const db = new Database(':memory:');
    runMigrations(db);
    insertProject(db, 'project-1');
    db.prepare(
      `INSERT INTO checklist_nodes (
        id, project_id, parent_id, name, path, node_type, source,
        address_id, sort_order, min_photos, accepts_photos, status, not_applicable_reason
      ) VALUES
        (
          'stale-root', 'project-1', NULL, 'OSD2766', 'OSD2766', 'STATIC', 'GPKG',
          NULL, 0, 0, 0, 'NOT_APPLICABLE', 'Nie wystepuje w ostatnio przeliczonym GPKG'
        ),
        (
          'stale-photo', 'project-1', 'stale-root', 'Malenicka_5', 'OSD2766/Malenicka_5',
          'CABLE_RESERVE', 'GPKG', NULL, 0, 1, 1, 'NOT_APPLICABLE',
          'Nie wystepuje w ostatnio przeliczonym GPKG'
        ),
        (
          'manual-skip', 'project-1', NULL, 'Manual', 'Manual', 'STATIC', 'GPKG',
          NULL, 1, 1, 1, 'NOT_APPLICABLE', 'Klient potwierdzil brak zakresu'
        )`,
    ).run();
    db.prepare(
      `INSERT INTO photos (
        id, project_id, checklist_node_id, source_file_name, stored_file_name,
        storage_path, mime_type, file_size
      ) VALUES
        (
          'photo-stale', 'project-1', 'stale-photo', 'reserve.jpg', 'reserve.jpg',
          'OSD2766/Malenicka_5/reserve.jpg', 'image/jpeg', 10
        ),
        (
          'photo-manual', 'project-1', 'manual-skip', 'manual.jpg', 'manual.jpg',
          'Manual/manual.jpg', 'image/jpeg', 10
        )`,
    ).run();

    runMigrations(db);

    const rows = db
      .prepare(
        `SELECT id, status, not_applicable_reason AS notApplicableReason
         FROM checklist_nodes
         WHERE project_id = 'project-1'
           AND id IN ('manual-skip', 'stale-photo', 'stale-root')
         ORDER BY id ASC`,
      )
      .all() as Array<{ id: string; status: string; notApplicableReason: string | null }>;
    db.close();

    expect(rows).toEqual([
      {
        id: 'manual-skip',
        status: 'NOT_APPLICABLE',
        notApplicableReason: 'Klient potwierdzil brak zakresu',
      },
      { id: 'stale-photo', status: 'COMPLETE', notApplicableReason: null },
      { id: 'stale-root', status: 'OPEN', notApplicableReason: null },
    ]);
  });
});
