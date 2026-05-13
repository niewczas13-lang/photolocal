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

  it('recalculates checklist without removing assigned photos', () => {
    const { db, repository } = createRepository();

    const project = repository.createProject({
      name: 'OPP0013',
      projectDefinition: null,
      projectType: 'SI',
      splitterTopology: 'SINGLE',
      splitterTopologySource: 'AUTO',
      splitterCount: 1,
      gpkgFileName: 'old.gpkg',
      baseFolder: 'C:/photos/OPP0013',
      addresses: [
        {
          id: 'address-old-5',
          city: 'Olsztyn',
          street: 'Malenicka',
          buildingNo: '5',
          propertyId: null,
          parcelNumber: null,
          distributionPoint: 'OSD2766',
          lat: null,
          lng: null,
          householdCount: 1,
          businessUnitCount: 0,
        },
      ],
      dacToAddressCableCount: 1,
      adssToAddressCableCount: 0,
      checklistNodes: [
        {
          id: 'root-old',
          projectId: 'project-temp',
          parentId: null,
          name: 'Zapasy_kabli_instalacyjnych',
          path: 'Zapasy_kabli_instalacyjnych',
          nodeType: 'STATIC',
          addressId: null,
          sortOrder: 6,
          minPhotos: 0,
          acceptsPhotos: false,
        },
        {
          id: 'dp-old',
          projectId: 'project-temp',
          parentId: 'root-old',
          name: 'OSD2766',
          path: 'Zapasy_kabli_instalacyjnych/OSD2766',
          nodeType: 'DISTRIBUTION',
          addressId: null,
          sortOrder: 0,
          minPhotos: 0,
          acceptsPhotos: false,
        },
        {
          id: 'reserve-old-5',
          projectId: 'project-temp',
          parentId: 'dp-old',
          name: 'Malenicka_5',
          path: 'Zapasy_kabli_instalacyjnych/OSD2766/Malenicka_5',
          nodeType: 'CABLE_RESERVE',
          addressId: 'address-old-5',
          sortOrder: 0,
          minPhotos: 1,
          acceptsPhotos: true,
        },
      ],
    });

    repository.addPhoto({
      id: 'photo-1',
      projectId: project.id,
      checklistNodeId: 'reserve-old-5',
      sourceFileName: 'original.jpeg',
      storedFileName: 'stored.jpeg',
      storagePath: 'C:/photos/OPP0013/Zapasy_kabli_instalacyjnych/OSD2766/Malenicka_5/stored.jpeg',
      thumbnailPath: null,
      mimeType: 'image/jpeg',
      fileSize: 123,
      lat: null,
      lng: null,
      capturedAt: null,
      reserveLocation: 'Doziemny',
    });

    const result = repository.recalculateChecklist({
      projectId: project.id,
      projectDefinition: 'OPP0013',
      projectType: 'SI',
      splitterTopology: 'SINGLE',
      splitterTopologySource: 'MANUAL',
      splitterCount: 2,
      gpkgFileName: 'new.gpkg',
      addresses: [
        {
          id: 'address-new-5',
          city: 'Olsztyn',
          street: 'Malenicka',
          buildingNo: '5',
          propertyId: null,
          parcelNumber: null,
          distributionPoint: 'OSD2766',
          lat: null,
          lng: null,
          householdCount: 1,
          businessUnitCount: 0,
        },
        {
          id: 'address-new-7',
          city: 'Olsztyn',
          street: 'Malenicka',
          buildingNo: '7',
          propertyId: null,
          parcelNumber: null,
          distributionPoint: 'OSD2766',
          lat: null,
          lng: null,
          householdCount: 1,
          businessUnitCount: 0,
        },
      ],
      dacToAddressCableCount: 2,
      adssToAddressCableCount: 0,
      checklistNodes: [
        {
          id: 'root-new',
          projectId: project.id,
          parentId: null,
          name: 'Zapasy_kabli_instalacyjnych',
          path: 'Zapasy_kabli_instalacyjnych',
          nodeType: 'STATIC',
          addressId: null,
          sortOrder: 6,
          minPhotos: 0,
          acceptsPhotos: false,
        },
        {
          id: 'dp-new',
          projectId: project.id,
          parentId: 'root-new',
          name: 'OSD2766',
          path: 'Zapasy_kabli_instalacyjnych/OSD2766',
          nodeType: 'DISTRIBUTION',
          addressId: null,
          sortOrder: 0,
          minPhotos: 0,
          acceptsPhotos: false,
        },
        {
          id: 'reserve-new-5',
          projectId: project.id,
          parentId: 'dp-new',
          name: 'Malenicka_5',
          path: 'Zapasy_kabli_instalacyjnych/OSD2766/Malenicka_5',
          nodeType: 'CABLE_RESERVE',
          addressId: 'address-new-5',
          sortOrder: 0,
          minPhotos: 1,
          acceptsPhotos: true,
        },
        {
          id: 'reserve-new-7',
          projectId: project.id,
          parentId: 'dp-new',
          name: 'Malenicka_7',
          path: 'Zapasy_kabli_instalacyjnych/OSD2766/Malenicka_7',
          nodeType: 'CABLE_RESERVE',
          addressId: 'address-new-7',
          sortOrder: 1,
          minPhotos: 1,
          acceptsPhotos: true,
        },
      ],
    });

    const checklist = repository.getChecklist(project.id) as Array<{
      id: string;
      path: string;
      photoCount: number;
      addressId: string | null;
    }>;
    const updatedProject = repository.getProject(project.id);
    db.close();

    expect(result).toEqual({ addedNodes: 1, updatedNodes: 3, unchangedNodes: 0, addedAddresses: 1, reusedAddresses: 1 });
    expect(checklist.find((node) => node.path.endsWith('Malenicka_5'))).toMatchObject({
      id: 'reserve-old-5',
      photoCount: 1,
      addressId: 'address-old-5',
    });
    expect(checklist.find((node) => node.path.endsWith('Malenicka_7'))).toMatchObject({
      id: 'reserve-new-7',
      photoCount: 0,
    });
    expect(updatedProject).toMatchObject({
      gpkgFileName: 'new.gpkg',
      splitterCount: 2,
      dacToAddressCableCount: 2,
    });
  });
});
