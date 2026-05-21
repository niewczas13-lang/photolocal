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

    expect(result).toEqual({
      addedNodes: 1,
      updatedNodes: 3,
      unchangedNodes: 0,
      addedAddresses: 1,
      reusedAddresses: 1,
      removedStaleNodes: 0,
      preservedAssignedStaleNodes: 0,
    });
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

  it('updates reused addresses with coordinates during GPKG recalculation', () => {
    const { db, repository } = createRepository();

    const project = repository.createProject({
      name: 'MAPA',
      projectDefinition: null,
      projectType: 'SI',
      splitterTopology: 'SINGLE',
      splitterTopologySource: 'AUTO',
      splitterCount: 1,
      gpkgFileName: 'old.gpkg',
      baseFolder: 'C:/photos/MAPA',
      addresses: [
        {
          id: 'address-old',
          city: 'Radom',
          street: 'Polna',
          buildingNo: '15',
          propertyId: null,
          parcelNumber: null,
          distributionPoint: 'RADOM/OSD0001',
          lat: null,
          lng: null,
          householdCount: 0,
          businessUnitCount: 0,
        },
      ],
      dacToAddressCableCount: 0,
      adssToAddressCableCount: 0,
      checklistNodes: [],
    });

    expect(repository.getProjectMap(project.id).addresses).toHaveLength(0);

    repository.recalculateChecklist({
      projectId: project.id,
      projectDefinition: null,
      projectType: 'SI',
      splitterTopology: 'SINGLE',
      splitterTopologySource: 'AUTO',
      splitterCount: 1,
      gpkgFileName: 'new.gpkg',
      addresses: [
        {
          id: 'address-new',
          city: 'Radom',
          street: 'Polna',
          buildingNo: '15',
          propertyId: 'pa-1',
          parcelNumber: '12/3',
          distributionPoint: 'RADOM/OSD0001',
          lat: 51.4,
          lng: 21.1,
          householdCount: 1,
          businessUnitCount: 0,
        },
      ],
      dacToAddressCableCount: 0,
      adssToAddressCableCount: 0,
      checklistNodes: [],
    });

    const map = repository.getProjectMap(project.id);
    db.close();

    expect(map.addresses).toHaveLength(1);
    expect(map.addresses[0]).toMatchObject({
      id: 'address-old',
      lat: 51.4,
      lng: 21.1,
    });
  });

  it('removes stale recalculated nodes only when they have no assigned photos', () => {
    const { db, repository } = createRepository();

    const project = repository.createProject({
      name: 'BARTAG',
      projectDefinition: null,
      projectType: 'SI',
      splitterTopology: 'SINGLE',
      splitterTopologySource: 'AUTO',
      splitterCount: 1,
      gpkgFileName: 'old.gpkg',
      baseFolder: 'C:/photos/BARTAG',
      addresses: [],
      dacToAddressCableCount: 0,
      adssToAddressCableCount: 0,
      checklistNodes: [
        {
          id: 'stale-empty-root',
          projectId: 'project-temp',
          parentId: null,
          name: 'BARTAG/ZS00031',
          path: '01_BARTAG_ZS00031',
          nodeType: 'STATIC',
          addressId: null,
          sortOrder: 0,
          minPhotos: 0,
          acceptsPhotos: false,
        },
        {
          id: 'stale-empty-photo-node',
          projectId: 'project-temp',
          parentId: 'stale-empty-root',
          name: 'Zdjecia',
          path: '01_BARTAG_ZS00031/Zdjecia',
          nodeType: 'STATIC',
          addressId: null,
          sortOrder: 0,
          minPhotos: 1,
          acceptsPhotos: true,
        },
        {
          id: 'stale-assigned-root',
          projectId: 'project-temp',
          parentId: null,
          name: 'BARTAG/ZS00032',
          path: '01_BARTAG_ZS00032',
          nodeType: 'STATIC',
          addressId: null,
          sortOrder: 0,
          minPhotos: 0,
          acceptsPhotos: false,
        },
        {
          id: 'stale-assigned-photo-node',
          projectId: 'project-temp',
          parentId: 'stale-assigned-root',
          name: 'Zdjecia',
          path: '01_BARTAG_ZS00032/Zdjecia',
          nodeType: 'STATIC',
          addressId: null,
          sortOrder: 0,
          minPhotos: 1,
          acceptsPhotos: true,
        },
      ],
    });

    repository.addPhoto({
      id: 'photo-zs',
      projectId: project.id,
      checklistNodeId: 'stale-assigned-photo-node',
      sourceFileName: 'zs.jpeg',
      storedFileName: 'zs.jpeg',
      storagePath: 'C:/photos/BARTAG/01_BARTAG_ZS00032/Zdjecia/zs.jpeg',
      thumbnailPath: null,
      mimeType: 'image/jpeg',
      fileSize: 123,
      lat: null,
      lng: null,
      capturedAt: null,
      reserveLocation: null,
    });

    const result = repository.recalculateChecklist({
      projectId: project.id,
      projectDefinition: 'BARTAG',
      projectType: 'SI',
      splitterTopology: 'SINGLE',
      splitterTopologySource: 'AUTO',
      splitterCount: 1,
      gpkgFileName: 'new.gpkg',
      addresses: [],
      dacToAddressCableCount: 0,
      adssToAddressCableCount: 0,
      checklistNodes: [
        {
          id: 'current-root',
          projectId: project.id,
          parentId: null,
          name: 'BARTAG/ZS00033',
          path: '01_BARTAG_ZS00033',
          nodeType: 'STATIC',
          addressId: null,
          sortOrder: 0,
          minPhotos: 0,
          acceptsPhotos: false,
        },
        {
          id: 'current-photo-node',
          projectId: project.id,
          parentId: 'current-root',
          name: 'Zdjecia',
          path: '01_BARTAG_ZS00033/Zdjecia',
          nodeType: 'STATIC',
          addressId: null,
          sortOrder: 0,
          minPhotos: 1,
          acceptsPhotos: true,
        },
      ],
    });

    const checklist = repository.getChecklist(project.id) as Array<{
      id: string;
      path: string;
      status: string;
      notApplicableReason: string | null;
      photoCount: number;
    }>;
    db.close();

    expect(result.removedStaleNodes).toBe(2);
    expect(result.preservedAssignedStaleNodes).toBe(2);
    expect(checklist.some((node) => node.path.startsWith('01_BARTAG_ZS00031'))).toBe(false);
    expect(checklist.find((node) => node.id === 'stale-assigned-photo-node')).toMatchObject({
      status: 'NOT_APPLICABLE',
      photoCount: 1,
      notApplicableReason: 'Nie wystepuje w ostatnio przeliczonym GPKG',
    });
    expect(checklist.find((node) => node.path === '01_BARTAG_ZS00033/Zdjecia')).toMatchObject({
      id: 'current-photo-node',
    });
  });

  it('keeps manually added folders during GPKG recalculation even without photos', () => {
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
      addresses: [],
      dacToAddressCableCount: 0,
      adssToAddressCableCount: 0,
      checklistNodes: [
        {
          id: 'old-gpkg-node',
          projectId: 'project-temp',
          parentId: null,
          name: 'Old GPKG',
          path: 'Old_GPKG',
          nodeType: 'STATIC',
          addressId: null,
          sortOrder: 0,
          minPhotos: 1,
          acceptsPhotos: true,
        },
      ],
    });

    const manual = repository.addManualChecklistNode({
      projectId: project.id,
      parentId: null,
      name: 'Nowe OSD',
      nodeType: 'STATIC',
      minPhotos: 1,
      acceptsPhotos: true,
    });

    const result = repository.recalculateChecklist({
      projectId: project.id,
      projectDefinition: 'OPP0013',
      projectType: 'SI',
      splitterTopology: 'SINGLE',
      splitterTopologySource: 'AUTO',
      splitterCount: 1,
      gpkgFileName: 'new.gpkg',
      addresses: [],
      dacToAddressCableCount: 0,
      adssToAddressCableCount: 0,
      checklistNodes: [],
    });

    const checklist = repository.getChecklist(project.id) as Array<{
      id: string;
      path: string;
      source: string;
    }>;
    db.close();

    expect(result.removedStaleNodes).toBe(1);
    expect(checklist.find((node) => node.id === manual.id)).toMatchObject({
      path: 'NOWE_OSD',
      source: 'MANUAL',
    });
    expect(checklist.some((node) => node.id === 'old-gpkg-node')).toBe(false);
  });

  it('returns project map data and turns address markers green when reserve photos exist', () => {
    const { db, repository } = createRepository();

    const project = repository.createProject({
      name: 'MAPA',
      projectDefinition: null,
      projectType: 'SI',
      splitterTopology: 'SINGLE',
      splitterTopologySource: 'AUTO',
      splitterCount: 1,
      gpkgFileName: 'mapa.gpkg',
      baseFolder: 'C:/photos/MAPA',
      addresses: [
        {
          id: 'address-1',
          city: 'Radom',
          street: 'Polna',
          buildingNo: '15',
          propertyId: 'pa-1',
          parcelNumber: null,
          distributionPoint: 'RADOM/OSD0001',
          lat: 51.4,
          lng: 21.1,
          householdCount: 1,
          businessUnitCount: 0,
        },
      ],
      dacToAddressCableCount: 1,
      adssToAddressCableCount: 0,
      checklistNodes: [
        {
          id: 'reserve-address-1',
          projectId: 'project-temp',
          parentId: null,
          name: 'Polna_15',
          path: 'Zapasy_kabli_instalacyjnych/OSD0001/Polna_15',
          nodeType: 'CABLE_RESERVE',
          addressId: 'address-1',
          sortOrder: 0,
          minPhotos: 1,
          acceptsPhotos: true,
        },
      ],
      polygons: [
        {
          osdName: 'OSD0001',
          label: 'RADOM/OSD0001',
          geojson: { type: 'Polygon', coordinates: [] },
          households: 1,
          paCount: 1,
          cableRef: 'K-1',
        },
      ],
      trunkCables: [
        {
          cableType: 'MI-MKF 48J',
          fromNode: 'ZS0001',
          toNode: 'OSD0001',
          osdName: 'OSD0001',
          geojson: { type: 'LineString', coordinates: [[21.1, 51.4], [21.2, 51.5]] },
          rawName: 'TK-1',
          routingType: 'underground',
        },
      ],
      infraNodes: [
        {
          nodeType: 'OSD',
          name: 'OSD0001',
          label: 'RADOM/OSD0001',
          lat: 51.5,
          lng: 21.2,
        },
      ],
    });

    let map = repository.getProjectMap(project.id);
    expect(map.addresses).toHaveLength(1);
    expect(map.addresses[0]).toMatchObject({
      id: 'address-1',
      label: 'Polna 15, Radom',
      hasReservePhoto: false,
      reservePhotoCount: 0,
    });
    expect(map.polygons[0]).toMatchObject({
      osdName: 'OSD0001',
      addressTotal: 1,
      addressWithReservePhoto: 0,
    });
    expect(map.trunkCables[0]).toMatchObject({
      fromNode: 'ZS0001',
      toNode: 'OSD0001',
      status: 'PENDING',
      routingType: 'underground',
      routeLengthMeters: null,
      installationLengthMeters: null,
    });
    expect(map.infraNodes[0]).toMatchObject({
      nodeType: 'OSD',
      name: 'OSD0001',
      status: 'PENDING',
      hasPhoto: false,
    });

    repository.addPhoto({
      id: 'photo-reserve',
      projectId: project.id,
      checklistNodeId: 'reserve-address-1',
      sourceFileName: 'reserve.jpeg',
      storedFileName: 'reserve.jpeg',
      storagePath: 'C:/photos/MAPA/reserve.jpeg',
      thumbnailPath: null,
      mimeType: 'image/jpeg',
      fileSize: 123,
      lat: null,
      lng: null,
      capturedAt: null,
      reserveLocation: 'Doziemny',
    });

    map = repository.getProjectMap(project.id);
    db.close();

    expect(map.addresses[0]).toMatchObject({
      hasReservePhoto: true,
      reservePhotoCount: 1,
      status: 'COMPLETE',
    });
    expect(map.addresses[0].photos).toEqual([
      expect.objectContaining({
        id: 'photo-reserve',
        checklistNodeId: 'reserve-address-1',
        storedFileName: 'reserve.jpeg',
      }),
    ]);
    expect(map.polygons[0]).toMatchObject({
      addressWithReservePhoto: 1,
    });
  });

  it('stores clicked address candidates without creating checklist folders', () => {
    const { db, repository } = createRepository();

    const project = repository.createProject({
      name: 'MAPA',
      projectDefinition: null,
      projectType: 'SI',
      splitterTopology: 'SINGLE',
      splitterTopologySource: 'AUTO',
      splitterCount: 1,
      gpkgFileName: 'mapa.gpkg',
      baseFolder: 'C:/photos/MAPA',
      addresses: [],
      dacToAddressCableCount: 0,
      adssToAddressCableCount: 0,
      checklistNodes: [],
      polygons: [
        {
          osdName: 'OSTRZESZEWO/OPP0002',
          label: 'OSTRZESZEWO/OPP0002',
          geojson: {
            type: 'Polygon',
            coordinates: [
              [
                [20.4, 53.7],
                [20.7, 53.7],
                [20.7, 54.0],
                [20.4, 54.0],
                [20.4, 53.7],
              ],
            ],
          },
          households: null,
          paCount: null,
          cableRef: null,
        },
      ],
      trunkCables: [],
      infraNodes: [],
    });

    const candidate = repository.addMapAddressCandidate({
      projectId: project.id,
      lat: 53.8,
      lng: 20.5,
      city: 'Ostrzeszewo',
      street: 'Lesna',
      buildingNo: '7',
      postalCode: '10-001',
      propertyId: null,
      parcelNumber: null,
      geocoderSource: 'adresy.app',
      geocoderDistanceMeters: 8.4,
    });
    const map = repository.getProjectMap(project.id);
    const checklist = repository.getChecklist(project.id);
    db.close();

    expect(candidate).toMatchObject({
      city: 'Ostrzeszewo',
      street: 'Lesna',
      buildingNo: '7',
      suggestedDistributionPoint: 'OSTRZESZEWO/OPP0002',
      assignmentSource: 'REGION',
      status: 'PENDING',
    });
    expect(map.addressCandidates).toHaveLength(1);
    expect(map.addressCandidates[0]).toMatchObject({
      id: candidate.id,
      label: 'Lesna 7, Ostrzeszewo',
      geocoderDistanceMeters: 8.4,
    });
    expect(map.addresses).toEqual([]);
    expect(checklist).toEqual([]);
  });

  it('approves an address candidate into a reserve checklist folder', () => {
    const { db, repository } = createRepository();

    const project = repository.createProject({
      name: 'MAPA',
      projectDefinition: null,
      projectType: 'KPO',
      splitterTopology: 'SINGLE',
      splitterTopologySource: 'AUTO',
      splitterCount: 1,
      gpkgFileName: 'mapa.gpkg',
      baseFolder: 'C:/photos/MAPA',
      addresses: [],
      dacToAddressCableCount: 0,
      adssToAddressCableCount: 0,
      checklistNodes: [],
      polygons: [],
      trunkCables: [],
      infraNodes: [
        {
          nodeType: 'OSD',
          name: 'RADOM/OSD0001',
          label: 'RADOM/OSD0001',
          lat: 51.5,
          lng: 21.2,
        },
      ],
    });
    const candidate = repository.addMapAddressCandidate({
      projectId: project.id,
      lat: 51.51,
      lng: 21.21,
      city: 'Radom',
      street: 'Polna',
      buildingNo: '12',
      postalCode: null,
      propertyId: null,
      parcelNumber: null,
      geocoderSource: 'adresy.app',
      geocoderDistanceMeters: 3,
    });

    const approved = repository.approveMapAddressCandidate({
      projectId: project.id,
      candidateId: candidate.id,
      city: 'Radom',
      street: 'Polna',
      buildingNo: '12',
      propertyId: null,
      parcelNumber: null,
      distributionPoint: 'RADOM/OSD0001',
      reserveLocation: 'Doziemny',
      createDistributionNodeType: null,
    });
    const map = repository.getProjectMap(project.id);
    const checklistPaths = (repository.getChecklist(project.id) as Array<{ path: string }>)
      .map((node) => node.path)
      .sort();
    const [summary] = repository.listProjects();
    db.close();

    expect(approved).toMatchObject({
      status: 'APPROVED',
      approvedAddressId: expect.any(String),
    });
    expect(map.addressCandidates).toEqual([]);
    expect(map.addresses).toEqual([
      expect.objectContaining({
        id: approved.approvedAddressId,
        label: 'Polna 12, Radom',
        distributionPoint: 'RADOM/OSD0001',
        status: 'PENDING',
      }),
    ]);
    expect(checklistPaths).toEqual([
      'Zapasy_kabli_instalacyjnych',
      'Zapasy_kabli_instalacyjnych/RADOM_OSD0001',
      'Zapasy_kabli_instalacyjnych/RADOM_OSD0001/POLNA_12',
    ]);
    expect(summary.addressCount).toBe(1);
  });

  it('rejects pending address candidates from the map workflow', () => {
    const { db, repository } = createRepository();

    const project = repository.createProject({
      name: 'MAPA',
      projectDefinition: null,
      projectType: 'SI',
      splitterTopology: 'SINGLE',
      splitterTopologySource: 'AUTO',
      splitterCount: 1,
      gpkgFileName: 'mapa.gpkg',
      baseFolder: 'C:/photos/MAPA',
      addresses: [],
      dacToAddressCableCount: 0,
      adssToAddressCableCount: 0,
      checklistNodes: [],
    });
    const candidate = repository.addMapAddressCandidate({
      projectId: project.id,
      lat: 51.51,
      lng: 21.21,
      city: 'Radom',
      street: 'Polna',
      buildingNo: '12',
      postalCode: null,
      propertyId: null,
      parcelNumber: null,
      geocoderSource: 'adresy.app',
      geocoderDistanceMeters: 3,
    });

    const rejected = repository.rejectMapAddressCandidate(project.id, candidate.id);
    const map = repository.getProjectMap(project.id);
    db.close();

    expect(rejected.status).toBe('REJECTED');
    expect(map.addressCandidates).toEqual([]);
  });

  it('marks map addresses as not applicable through their reserve nodes', () => {
    const { db, repository } = createRepository();

    const project = repository.createProject({
      name: 'ADRES NIE DOTYCZY',
      projectDefinition: null,
      projectType: 'SI',
      splitterTopology: 'SINGLE',
      splitterTopologySource: 'AUTO',
      splitterCount: 1,
      gpkgFileName: 'adresy.gpkg',
      baseFolder: 'C:/photos/ADRESY',
      addresses: [
        {
          id: 'address-skip',
          city: 'Radom',
          street: 'Polna',
          buildingNo: '15',
          propertyId: null,
          parcelNumber: null,
          distributionPoint: 'RADOM/OSD0001',
          lat: 51.4,
          lng: 21.1,
          householdCount: 1,
          businessUnitCount: 0,
        },
      ],
      dacToAddressCableCount: 1,
      adssToAddressCableCount: 0,
      checklistNodes: [
        {
          id: 'reserve-skip',
          projectId: 'project-temp',
          parentId: null,
          name: 'POLNA_15',
          path: 'Zapasy_kabli_instalacyjnych/RADOM_OSD0001/POLNA_15',
          nodeType: 'CABLE_RESERVE',
          addressId: 'address-skip',
          sortOrder: 0,
          minPhotos: 1,
          acceptsPhotos: true,
        },
      ],
    });

    repository.markAddressNotApplicable(project.id, 'address-skip', 'Klient potwierdzil brak zakresu');

    const map = repository.getProjectMap(project.id);
    const node = repository.getChecklistNode(project.id, 'reserve-skip');
    db.close();

    expect(map.addresses[0]).toMatchObject({
      id: 'address-skip',
      status: 'NOT_APPLICABLE',
      isNotApplicable: true,
      hasReservePhoto: false,
    });
    expect(node).toMatchObject({
      status: 'NOT_APPLICABLE',
      notApplicableReason: 'Klient potwierdzil brak zakresu',
    });
  });

  it('stores map notes with optional targets and note photos', () => {
    const { db, repository } = createRepository();

    const project = repository.createProject({
      name: 'NOTATKI',
      projectDefinition: null,
      projectType: 'SI',
      splitterTopology: 'SINGLE',
      splitterTopologySource: 'AUTO',
      splitterCount: 1,
      gpkgFileName: 'notatki.gpkg',
      baseFolder: 'C:/photos/NOTATKI',
      addresses: [],
      dacToAddressCableCount: 0,
      adssToAddressCableCount: 0,
      checklistNodes: [],
      trunkCables: [
        {
          cableType: 'MI-MKF 48J',
          fromNode: 'ZS0001',
          toNode: 'OSD0001',
          osdName: 'OSD0001',
          geojson: { type: 'LineString', coordinates: [[21.1, 51.4], [21.2, 51.5]] },
          rawName: 'TK-1',
          routingType: 'existing_duct',
        },
      ],
    });
    const cableId = repository.getProjectMap(project.id).trunkCables[0].id;

    const note = repository.addMapNote({
      projectId: project.id,
      targetType: 'cable',
      targetId: cableId,
      targetLabel: 'TK-1',
      body: 'Niedroznosc w studni',
      lat: 51.45,
      lng: 21.15,
    });
    repository.addMapNotePhoto({
      id: 'note-photo-1',
      projectId: project.id,
      noteId: note.id,
      sourceFileName: 'notatka.jpg',
      storedFileName: 'notatka-001.jpg',
      storagePath: 'C:/photos/NOTATKI/Notatki_mapy/TK-1/Zdjecia/notatka-001.jpg',
      thumbnailPath: null,
      mimeType: 'image/jpeg',
      fileSize: 123,
      lat: null,
      lng: null,
      capturedAt: null,
    });

    const map = repository.getProjectMap(project.id);
    db.close();

    expect(map.trunkCables[0]).toMatchObject({ routingType: 'existing_duct' });
    expect(map.notes).toHaveLength(1);
    expect(map.notes[0]).toMatchObject({
      id: note.id,
      targetType: 'cable',
      targetId: cableId,
      targetLabel: 'TK-1',
      body: 'Niedroznosc w studni',
      lat: 51.45,
      lng: 21.15,
      photoCount: 1,
    });
    expect(map.notes[0].photos[0]).toMatchObject({
      sourceFileName: 'notatka.jpg',
      storedFileName: 'notatka-001.jpg',
    });
  });

  it('keeps different trunk cables between the same map nodes', () => {
    const { db, repository } = createRepository();

    const project = repository.createProject({
      name: 'MAPA',
      projectDefinition: null,
      projectType: 'SI',
      splitterTopology: 'SINGLE',
      splitterTopologySource: 'AUTO',
      splitterCount: 1,
      gpkgFileName: 'mapa.gpkg',
      baseFolder: 'C:/photos/MAPA',
      addresses: [],
      dacToAddressCableCount: 0,
      adssToAddressCableCount: 2,
      checklistNodes: [],
      trunkCables: [
        {
          cableType: 'ADSS LTC 12J G.652D',
          fromNode: 'ZS00003',
          toNode: 'OPP0004',
          osdName: 'OPP0004',
          geojson: { type: 'LineString', coordinates: [[20.56, 53.76], [20.57, 53.77]] },
          rawName: 'OKH0030737-BC/009',
        },
        {
          cableType: 'ADSS LTC 12J G.652D',
          fromNode: 'ZS00003',
          toNode: 'OPP0004',
          osdName: 'OPP0004',
          geojson: { type: 'LineString', coordinates: [[20.58, 53.78], [20.59, 53.79]] },
          rawName: 'OKH0030737-BC/010',
        },
      ],
    });

    const map = repository.getProjectMap(project.id);
    db.close();

    expect(map.trunkCables.map((cable) => cable.rawName).sort()).toEqual([
      'OKH0030737-BC/009',
      'OKH0030737-BC/010',
    ]);
  });

  it('carries an existing cable status onto recalculated route sections with the same raw name', () => {
    const { db, repository } = createRepository();

    const project = repository.createProject({
      name: 'PODZIAL',
      projectDefinition: null,
      projectType: 'SI',
      splitterTopology: 'SINGLE',
      splitterTopologySource: 'AUTO',
      splitterCount: 1,
      gpkgFileName: 'podzial.gpkg',
      baseFolder: 'C:/photos/PODZIAL',
      addresses: [],
      dacToAddressCableCount: 0,
      adssToAddressCableCount: 0,
      checklistNodes: [],
      trunkCables: [
        {
          cableType: 'MI-MKF 12J',
          fromNode: 'ZS0001',
          toNode: 'OPP0001',
          osdName: 'OPP0001',
          geojson: { type: 'LineString', coordinates: [[20.56, 53.76], [20.57, 53.77]] },
          rawName: 'OKH-MIX/001',
          routingType: 'existing_duct',
        },
      ],
    });
    const oldCable = repository.getProjectMap(project.id).trunkCables[0];
    repository.updateCableStatus(project.id, oldCable.id, 'PULLED');

    repository.recalculateChecklist({
      projectId: project.id,
      projectDefinition: null,
      projectType: 'SI',
      splitterTopology: 'SINGLE',
      splitterTopologySource: 'AUTO',
      splitterCount: 1,
      gpkgFileName: 'podzial-2.gpkg',
      addresses: [],
      checklistNodes: [],
      dacToAddressCableCount: 0,
      adssToAddressCableCount: 0,
      polygons: [],
      trunkCables: [
        {
          cableKey: 'OKH-MIX/001|existing_duct|1',
          cableType: 'MI-MKF 12J',
          fromNode: 'ZS0001',
          toNode: 'OPP0001',
          osdName: 'OPP0001',
          geojson: { type: 'LineString', coordinates: [[20.56, 53.76], [20.565, 53.765]] },
          rawName: 'OKH-MIX/001',
          routingType: 'existing_duct',
        },
        {
          cableKey: 'OKH-MIX/001|underground|2',
          cableType: 'MI-MKF 12J',
          fromNode: 'ZS0001',
          toNode: 'OPP0001',
          osdName: 'OPP0001',
          geojson: { type: 'LineString', coordinates: [[20.565, 53.765], [20.57, 53.77]] },
          rawName: 'OKH-MIX/001',
          routingType: 'underground',
        },
      ],
      infraNodes: [],
      infrastructureFeatures: [],
    });

    const map = repository.getProjectMap(project.id);
    db.close();

    expect(map.trunkCables).toHaveLength(2);
    expect(map.trunkCables.map((cable) => cable.routingType).sort()).toEqual([
      'existing_duct',
      'underground',
    ]);
    expect(map.trunkCables.map((cable) => cable.status)).toEqual(['PULLED', 'PULLED']);
  });

  it('keeps map area counts separated for the same OPP number in different localities', () => {
    const { db, repository } = createRepository();

    const project = repository.createProject({
      name: 'DUPLIKATY OPP',
      projectDefinition: null,
      projectType: 'KPO',
      splitterTopology: 'SINGLE',
      splitterTopologySource: 'AUTO',
      splitterCount: 1,
      gpkgFileName: 'duplikaty.gpkg',
      baseFolder: 'C:/photos/DUPLIKATY',
      addresses: [
        {
          id: 'address-ostrzeszewo',
          city: 'Ostrzeszewo',
          street: 'Ostrzeszewo',
          buildingNo: '10B',
          propertyId: null,
          parcelNumber: null,
          distributionPoint: 'OSTRZESZEWO/OPP0002',
          lat: 53.74,
          lng: 20.55,
          householdCount: 1,
          businessUnitCount: 0,
        },
        {
          id: 'address-klebark',
          city: 'Klebark Maly',
          street: 'Klebark Maly',
          buildingNo: '38D',
          propertyId: null,
          parcelNumber: null,
          distributionPoint: 'KLEBARK MALY/OPP0002',
          lat: 53.75,
          lng: 20.57,
          householdCount: 1,
          businessUnitCount: 0,
        },
      ],
      dacToAddressCableCount: 0,
      adssToAddressCableCount: 0,
      checklistNodes: [],
      polygons: [
        {
          osdName: 'OSTRZESZEWO/OPP0002',
          label: 'OSTRZESZEWO/OPP0002',
          geojson: { type: 'Polygon', coordinates: [] },
          households: 4,
          paCount: 4,
          cableRef: 'OKH0030737-BD/010',
        },
        {
          osdName: 'KLEBARK MALY/OPP0002',
          label: 'KLEBARK MALY/OPP0002',
          geojson: { type: 'Polygon', coordinates: [] },
          households: 1,
          paCount: 1,
          cableRef: 'OKH0030737-BA/007',
        },
      ],
      trunkCables: [],
      infraNodes: [],
    });

    const map = repository.getProjectMap(project.id);
    db.close();

    expect(map.polygons.map((polygon) => polygon.osdName).sort()).toEqual([
      'KLEBARK MALY/OPP0002',
      'OSTRZESZEWO/OPP0002',
    ]);
    expect(map.polygons).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          osdName: 'OSTRZESZEWO/OPP0002',
          addressTotal: 1,
          cableRef: 'OKH0030737-BD/010',
        }),
        expect.objectContaining({
          osdName: 'KLEBARK MALY/OPP0002',
          addressTotal: 1,
          cableRef: 'OKH0030737-BA/007',
        }),
      ]),
    );
  });

  it('carries infra node status from old short OPP keys to scoped node names', () => {
    const { db, repository } = createRepository();

    const project = repository.createProject({
      name: 'STATUSY MAPY',
      projectDefinition: null,
      projectType: 'KPO',
      splitterTopology: 'SINGLE',
      splitterTopologySource: 'AUTO',
      splitterCount: 1,
      gpkgFileName: 'statusy.gpkg',
      baseFolder: 'C:/photos/STATUSY',
      addresses: [],
      dacToAddressCableCount: 0,
      adssToAddressCableCount: 0,
      checklistNodes: [],
      infraNodes: [
        {
          nodeType: 'OPP',
          name: 'OPP0002',
          label: 'O_KLEBARK MALY/OPP0002',
          lat: 53.75,
          lng: 20.57,
        },
      ],
    });

    const oldNode = repository.getProjectMap(project.id).infraNodes[0];
    repository.updateInfraNodeStatus(project.id, oldNode.id, 'WELDED');

    repository.recalculateChecklist({
      projectId: project.id,
      projectDefinition: null,
      projectType: 'KPO',
      splitterTopology: 'SINGLE',
      splitterTopologySource: 'AUTO',
      splitterCount: 1,
      gpkgFileName: 'statusy.gpkg',
      addresses: [],
      dacToAddressCableCount: 0,
      adssToAddressCableCount: 0,
      checklistNodes: [],
      infraNodes: [
        {
          nodeType: 'OPP',
          name: 'KLEBARK MALY/OPP0002',
          label: 'O_KLEBARK MALY/OPP0002',
          lat: 53.75,
          lng: 20.57,
        },
      ],
    });

    const map = repository.getProjectMap(project.id);
    db.close();

    expect(map.infraNodes).toHaveLength(1);
    expect(map.infraNodes[0]).toMatchObject({
      nodeType: 'OPP',
      name: 'KLEBARK MALY/OPP0002',
      status: 'WELDED',
    });
  });

  it('returns and refreshes background infrastructure map features', () => {
    const { db, repository } = createRepository();

    const project = repository.createProject({
      name: 'INFRA',
      projectDefinition: null,
      projectType: 'SI',
      splitterTopology: 'SINGLE',
      splitterTopologySource: 'AUTO',
      splitterCount: 1,
      gpkgFileName: 'infra.gpkg',
      baseFolder: 'C:/photos/INFRA',
      addresses: [],
      dacToAddressCableCount: 0,
      adssToAddressCableCount: 0,
      checklistNodes: [],
      polygons: [],
      trunkCables: [],
      infraNodes: [],
      infrastructureFeatures: [
        {
          featureType: 'duct',
          sourceLayer: 'Odcinki Kanalizacji',
          label: 'K-1',
          elementType: 'Kanalizacja pierwotna',
          owner: 'ORANGE',
          geojson: { type: 'LineString', coordinates: [[21.1, 51.4], [21.2, 51.5]] },
        },
      ],
    });

    let map = repository.getProjectMap(project.id);
    expect(map.infrastructureFeatures).toHaveLength(1);
    expect(map.infrastructureFeatures[0]).toMatchObject({
      featureType: 'duct',
      sourceLayer: 'Odcinki Kanalizacji',
      label: 'K-1',
      owner: 'ORANGE',
    });

    repository.recalculateChecklist({
      projectId: project.id,
      projectDefinition: null,
      projectType: 'SI',
      splitterTopology: 'SINGLE',
      splitterTopologySource: 'AUTO',
      splitterCount: 1,
      gpkgFileName: 'infra-2.gpkg',
      addresses: [],
      dacToAddressCableCount: 0,
      adssToAddressCableCount: 0,
      checklistNodes: [],
      polygons: [],
      trunkCables: [],
      infraNodes: [],
      infrastructureFeatures: [
        {
          featureType: 'manhole',
          sourceLayer: 'Studnia',
          label: 'ST-1',
          elementType: 'Studnia kablowa',
          owner: null,
          geojson: { type: 'Point', coordinates: [21.3, 51.6] },
        },
        {
          featureType: 'pole',
          sourceLayer: 'Slup',
          label: 'SLP-1',
          elementType: 'Slup',
          owner: null,
          geojson: { type: 'Point', coordinates: [21.31, 51.61] },
        },
      ],
    });

    map = repository.getProjectMap(project.id);
    db.close();

    expect(map.infrastructureFeatures).toHaveLength(2);
    expect(map.infrastructureFeatures).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          featureType: 'manhole',
          sourceLayer: 'Studnia',
          label: 'ST-1',
          geojson: { type: 'Point', coordinates: [21.3, 51.6] },
        }),
        expect.objectContaining({
          featureType: 'pole',
          sourceLayer: 'Slup',
          label: 'SLP-1',
        }),
      ]),
    );
  });
});
