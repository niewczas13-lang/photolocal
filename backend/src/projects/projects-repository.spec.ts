import { mkdirSync } from 'node:fs';
import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { openDatabase } from '../db/connection.js';
import { runMigrations } from '../db/migrations.js';
import { ProjectsRepository } from './projects-repository.js';

function createRepository() {
  const dir = mkdtempSync(join(tmpdir(), 'photo-local-repo-'));
  mkdirSync(dir, { recursive: true });
  const db = openDatabase(join(dir, 'test.sqlite'));
  runMigrations(db);
  return { db, repository: new ProjectsRepository(db) };
}

describe('ProjectsRepository', () => {
  it('returns clean project summaries with computed progress', () => {
    const { db, repository } = createRepository();

    const project = repository.createProject({
      name: 'PROJEKT',
      projectDefinition: null,
      projectType: 'SI',
      splitterTopology: 'SINGLE',
      splitterTopologySource: 'AUTO',
      splitterCount: 1,
      gpkgFileName: 'projekt.gpkg',
      baseFolder: 'C:/photos/PROJEKT',
      addresses: [],
      dacToAddressCableCount: 0,
      adssToAddressCableCount: 0,
      checklistNodes: [
        {
          id: 'node-complete',
          projectId: 'project-temp',
          parentId: null,
          name: 'Complete',
          path: 'Complete',
          nodeType: 'STATIC',
          addressId: null,
          sortOrder: 0,
          minPhotos: 1,
          acceptsPhotos: true,
        },
        {
          id: 'node-missing',
          projectId: 'project-temp',
          parentId: null,
          name: 'Missing',
          path: 'Missing',
          nodeType: 'STATIC',
          addressId: null,
          sortOrder: 1,
          minPhotos: 1,
          acceptsPhotos: true,
        },
        {
          id: 'node-skipped',
          projectId: 'project-temp',
          parentId: null,
          name: 'Skipped',
          path: 'Skipped',
          nodeType: 'STATIC',
          addressId: null,
          sortOrder: 2,
          minPhotos: 1,
          acceptsPhotos: true,
        },
      ],
    });

    repository.addPhoto({
      id: 'photo-1',
      projectId: project.id,
      checklistNodeId: 'node-complete',
      sourceFileName: 'original.jpeg',
      storedFileName: 'stored.jpeg',
      storagePath: 'C:/photos/PROJEKT/Complete/stored.jpeg',
      thumbnailPath: null,
      mimeType: 'image/jpeg',
      fileSize: 123,
      lat: null,
      lng: null,
      capturedAt: null,
      reserveLocation: null,
    });
    repository.markNotApplicable(project.id, 'node-skipped', 'not needed');

    const [summary] = repository.listProjects();
    db.close();

    expect(summary).toMatchObject({
      id: project.id,
      progressDone: 2,
      progressTotal: 3,
      status: 'W trakcie',
    });
  });
});
