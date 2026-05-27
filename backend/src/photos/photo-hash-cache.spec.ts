import Database from 'better-sqlite3';
import { createHash } from 'node:crypto';
import { mkdirSync, writeFileSync } from 'node:fs';
import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { runMigrations } from '../db/migrations.js';
import { hashProjectPhotoFolders } from './photo-hash-cache.js';

function sha256(value: string): string {
  return createHash('sha256').update(value).digest('hex');
}

describe('hashProjectPhotoFolders', () => {
  it('hashes project folder photos into cache and backfills assigned photo hashes', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'photo-local-hash-cache-'));
    const db = new Database(':memory:');
    runMigrations(db);
    const baseFolder = join(dir, 'project');
    const assignedPath = join(baseFolder, 'Zapasy', 'photo.jpeg');
    const loosePath = join(baseFolder, 'Manual', 'loose.png');
    const thumbPath = join(baseFolder, '.thumbnails', 'thumb.webp');
    mkdirSync(dirname(assignedPath), { recursive: true });
    mkdirSync(dirname(loosePath), { recursive: true });
    mkdirSync(dirname(thumbPath), { recursive: true });
    writeFileSync(assignedPath, 'assigned-image');
    writeFileSync(loosePath, 'loose-image');
    writeFileSync(thumbPath, 'thumbnail-image');
    writeFileSync(join(baseFolder, 'not-photo.txt'), 'text');

    db.prepare(
      `INSERT INTO projects (
        id, name, project_type, splitter_topology, splitter_topology_source,
        gpkg_file_name, base_folder
      ) VALUES ('project-1', 'Projekt', 'SI', 'SINGLE', 'AUTO', 'projekt.gpkg', ?)`,
    ).run(baseFolder);
    db.prepare(
      `INSERT INTO checklist_nodes (
        id, project_id, parent_id, name, path, node_type, source,
        address_id, sort_order, min_photos, accepts_photos, status
      ) VALUES (
        'node-1', 'project-1', NULL, 'Zapasy', 'Zapasy', 'STATIC', 'GPKG',
        NULL, 0, 1, 1, 'OPEN'
      )`,
    ).run();
    db.prepare(
      `INSERT INTO photos (
        id, project_id, checklist_node_id, source_file_name, stored_file_name,
        storage_path, mime_type, file_size, content_hash
      ) VALUES (
        'photo-1', 'project-1', 'node-1', 'photo.jpeg', 'photo.jpeg',
        ?, 'image/jpeg', 14, NULL
      )`,
    ).run(assignedPath);

    const events: Array<{ processed: number; total: number; percent: number }> = [];
    const result = await hashProjectPhotoFolders(db, {
      onProgress: (event) => {
        if (event.phase === 'hashing') {
          events.push({ processed: event.processed, total: event.total, percent: event.percent });
        }
      },
    });

    const cacheRows = db
      .prepare(
        `SELECT storage_path AS storagePath, content_hash AS contentHash
         FROM project_photo_hash_cache
         WHERE project_id = 'project-1'
         ORDER BY storage_path ASC`,
      )
      .all() as Array<{ storagePath: string; contentHash: string }>;
    const assignedPhoto = db
      .prepare("SELECT content_hash AS contentHash FROM photos WHERE id = 'photo-1'")
      .get() as { contentHash: string | null };
    db.close();

    expect(result).toMatchObject({
      projectCount: 1,
      filesFound: 2,
      hashedFiles: 2,
      skippedUnchanged: 0,
      updatedPhotoRows: 1,
      errorCount: 0,
    });
    expect(cacheRows).toEqual([
      { storagePath: loosePath, contentHash: sha256('loose-image') },
      { storagePath: assignedPath, contentHash: sha256('assigned-image') },
    ]);
    expect(assignedPhoto.contentHash).toBe(sha256('assigned-image'));
    expect(events.at(-1)).toMatchObject({ processed: 2, total: 2, percent: 100 });
  });
});
