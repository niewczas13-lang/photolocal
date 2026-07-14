import Database from 'better-sqlite3';
import { mkdirSync, writeFileSync } from 'node:fs';
import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { runMigrations } from '../db/migrations.js';
import { auditProjectPhotoFiles } from './photo-file-audit.js';

describe('auditProjectPhotoFiles', () => {
  it('reports assigned photos whose original file is missing while thumbnail still exists', () => {
    const dir = mkdtempSync(join(tmpdir(), 'photo-local-file-audit-'));
    const db = new Database(':memory:');
    runMigrations(db);
    const baseFolder = join(dir, 'project');
    const missingOriginalPath = join(baseFolder, 'Zapasy', 'missing.jpeg');
    const thumbnailPath = join(baseFolder, '.thumbnails', 'missing.webp');
    mkdirSync(dirname(missingOriginalPath), { recursive: true });
    mkdirSync(dirname(thumbnailPath), { recursive: true });
    writeFileSync(thumbnailPath, 'thumbnail');

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
        storage_path, thumbnail_path, mime_type, file_size
      ) VALUES (
        'photo-1', 'project-1', 'node-1', 'source.jpeg', 'missing.jpeg',
        ?, ?, 'image/jpeg', 123
      )`,
    ).run(missingOriginalPath, thumbnailPath);

    const result = auditProjectPhotoFiles(db);
    db.close();

    expect(result).toMatchObject({
      projectCount: 1,
      checklistPhotoRows: 1,
      notePhotoRows: 0,
      missingStorageFiles: 1,
      missingThumbnailFiles: 0,
      thumbnailFallbackOnly: 1,
    });
    expect(result.issues).toEqual([
      expect.objectContaining({
        code: 'STORAGE_MISSING',
        source: 'checklist',
        projectName: 'Projekt',
        targetPath: 'Zapasy',
        storagePath: missingOriginalPath,
        thumbnailPath,
      }),
    ]);
  });

  it('checks map note photos and detects file size mismatches', () => {
    const dir = mkdtempSync(join(tmpdir(), 'photo-local-note-file-audit-'));
    const db = new Database(':memory:');
    runMigrations(db);
    const baseFolder = join(dir, 'project');
    const notePhotoPath = join(baseFolder, 'Notatki_mapy', 'note.jpeg');
    mkdirSync(dirname(notePhotoPath), { recursive: true });
    writeFileSync(notePhotoPath, 'real-photo');

    db.prepare(
      `INSERT INTO projects (
        id, name, project_type, splitter_topology, splitter_topology_source,
        gpkg_file_name, base_folder
      ) VALUES ('project-1', 'Projekt', 'SI', 'SINGLE', 'AUTO', 'projekt.gpkg', ?)`,
    ).run(baseFolder);
    db.prepare(
      `INSERT INTO map_notes (
        id, project_id, target_type, target_id, target_label, body, lat, lng
      ) VALUES ('note-1', 'project-1', 'free', NULL, 'Niedroznosc', 'Opis', NULL, NULL)`,
    ).run();
    db.prepare(
      `INSERT INTO map_note_photos (
        id, project_id, note_id, source_file_name, stored_file_name,
        storage_path, thumbnail_path, mime_type, file_size
      ) VALUES (
        'note-photo-1', 'project-1', 'note-1', 'note.jpeg', 'note.jpeg',
        ?, NULL, 'image/jpeg', 999
      )`,
    ).run(notePhotoPath);

    const result = auditProjectPhotoFiles(db);
    db.close();

    expect(result).toMatchObject({
      projectCount: 1,
      checklistPhotoRows: 0,
      notePhotoRows: 1,
      sizeMismatches: 1,
    });
    expect(result.issues).toEqual([
      expect.objectContaining({
        code: 'SIZE_MISMATCH',
        source: 'map_note',
        projectName: 'Projekt',
        targetPath: 'Niedroznosc',
        storagePath: notePhotoPath,
        dbFileSize: 999,
        diskFileSize: 10,
      }),
    ]);
  });
});
