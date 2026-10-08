import Database from 'better-sqlite3';
import { afterEach, describe, expect, it } from 'vitest';
import { generateChecklistNodes, type ChecklistAddress } from '../checklist/checklist-generator.js';
import { runMigrations } from '../db/migrations.js';
import type { ChecklistNodeRecord, ChecklistNodeSource, ProjectType } from '../types.js';
import { ProjectsRepository } from './projects-repository.js';

const ARCHIVE_REASON = 'Zapasy napowietrzne nie dotycza projektu SI';
const databases: Database.Database[] = [];
afterEach(() => {
  for (const db of databases.splice(0)) db.close();
});

function fixture(
  projectType: ProjectType = 'SI',
  source: ChecklistNodeSource = 'MANUAL',
  legacy = true,
) {
  const db = new Database(':memory:');
  db.pragma('foreign_keys = ON');
  databases.push(db);
  runMigrations(db);
  const repository = new ProjectsRepository(db);
  const addresses: ChecklistAddress[] = ['air-empty', 'air-photo', 'ground'].map((id, index) => ({
    id,
    city: 'Baranowo',
    street: 'Testowa',
    buildingNo: String(index + 1),
    propertyId: id,
    parcelNumber: null,
    distributionPoint: 'BARANOWO/OSD0001',
    lat: 53,
    lng: 20,
    householdCount: 1,
    businessUnitCount: 0,
    hasAerialReserve: index < 2,
  }));
  const currentAddresses = (groundPhoto: boolean) => addresses.map((address) =>
    groundPhoto && address.id === 'air-photo' ? { ...address, hasAerialReserve: false } : address,
  );
  const generate = (type: ProjectType, groundPhoto = false) => generateChecklistNodes({
    projectId: 'fixture',
    projectName: 'Baranowo',
    projectType: type,
    splitterTopology: 'SINGLE',
    addresses: currentAddresses(groundPhoto),
    dacToAddressCableEntries: groundPhoto ? ['TESTOWA 2', 'TESTOWA 3'] : ['TESTOWA 3'],
    adssToAddressCableEntries: groundPhoto ? ['TESTOWA 1'] : ['TESTOWA 1', 'TESTOWA 2'],
  });
  const metadata = {
    projectDefinition: null,
    splitterTopology: 'SINGLE' as const,
    splitterTopologySource: 'AUTO' as const,
    splitterCount: 1,
    gpkgFileName: 'baranowo.gpkg',
    addresses,
    dacToAddressCableCount: 1,
    adssToAddressCableCount: 2,
  };
  const infraNodes = [{
    nodeType: 'OSD' as const,
    name: 'BARANOWO/OSD0001',
    label: null,
    lat: 53,
    lng: 20,
  }];
  const project = repository.createProject({
    ...metadata,
    name: 'Baranowo',
    projectType,
    baseFolder: 'unused',
    checklistNodes: generate(legacy ? 'KPO' : projectType).map((node) =>
      node.path.startsWith('Zapasy_kabli_napowietrznych')
        ? { ...node, source, minPhotos: node.addressId === 'air-photo' ? 2 : node.minPhotos }
        : node,
    ),
    infraNodes,
  });
  const checklist = () => repository.getChecklist(project.id) as ChecklistNodeRecord[];
  const aerialNodes = () => checklist().filter((node) =>
    node.path.startsWith('Zapasy_kabli_napowietrznych'),
  );
  const recalculate = (type: ProjectType = projectType, groundPhoto = false) =>
    repository.recalculateChecklist({
      ...metadata,
      projectId: project.id,
      projectType: type,
      addresses: currentAddresses(groundPhoto),
      checklistNodes: generate(type, groundPhoto),
      infraNodes,
    });
  const addOldPhoto = () => {
    const node = aerialNodes().find(node => node.addressId === 'air-photo')!;
    repository.addPhoto({ id: 'old-photo', projectId: project.id, checklistNodeId: node.id,
      sourceFileName: 'old.jpg', storedFileName: 'old.jpg', storagePath: 'unused/old.jpg',
      thumbnailPath: null, mimeType: 'image/jpeg', fileSize: 1, lat: null, lng: null,
      capturedAt: null, reserveLocation: 'Napowietrzny' });
    return node;
  };
  const approveAerialCandidate = () => {
    const candidate = repository.addMapAddressCandidate({ projectId: project.id, lat: 53, lng: 20,
      city: 'Baranowo', street: 'Polna', buildingNo: '99', postalCode: null,
      propertyId: null, parcelNumber: null, geocoderSource: 'fixture', geocoderDistanceMeters: 0 });
    return repository.approveMapAddressCandidate({ projectId: project.id, candidateId: candidate.id,
      city: 'Baranowo', street: 'Polna', buildingNo: '99', propertyId: null, parcelNumber: null,
      distributionPoint: 'BARANOWO/OSD0001', reserveLocation: 'Napowietrzny', createDistributionNodeType: null });
  };
  return { db, repository, project, checklist, aerialNodes, recalculate, addOldPhoto, approveAerialCandidate };
}

describe('SI aerial reserve lifecycle', () => {
  it.each(['MANUAL', 'GPKG'] as const)('removes empty legacy %s aerial folders on SI recalculation', source => {
    const f = fixture('SI', source);
    const empty = f.aerialNodes().find(node => node.addressId === 'air-empty')!;
    f.repository.markNotApplicable(f.project.id, empty.id, 'Zapas nie wystepuje');
    const manual = f.repository.addManualChecklistNode({ projectId: f.project.id, parentId: null,
      name: 'Dodatkowe zdjecia', nodeType: 'STATIC', minPhotos: 1, acceptsPhotos: true });
    f.recalculate();
    expect(f.aerialNodes()).toEqual([]);
    expect(f.repository.getChecklistNode(f.project.id, manual.id)).toBeDefined();
    expect(f.checklist().filter(node => node.nodeType === 'CABLE_RESERVE')).toHaveLength(1);
    expect(f.repository.getProjectMap(f.project.id).addresses.find(address => address.id === 'air-empty'))
      .toMatchObject({ isAerialReserve: true, usesDistributionPhotoForCompletion: true, status: 'PENDING' });
  });

  it.each(['MANUAL', 'GPKG'] as const)('archives assigned %s aerial photos without SI requirements or map completion', source => {
    const f = fixture('SI', source);
    const photoNode = f.addOldPhoto();
    f.recalculate();
    expect(f.aerialNodes().some(node => node.addressId === 'air-empty')).toBe(false);
    expect(f.aerialNodes().every(node => node.minPhotos === 0 && node.status === 'NOT_APPLICABLE')).toBe(true);
    expect(f.repository.getChecklistNode(f.project.id, photoNode.id))
      .toMatchObject({ minPhotos: 0, status: 'NOT_APPLICABLE', notApplicableReason: ARCHIVE_REASON });
    expect(f.repository.getNodePhotos(f.project.id, photoNode.id))
      .toMatchObject([{ id: 'old-photo', storagePath: 'unused/old.jpg' }]);
    expect(f.repository.getProjectMap(f.project.id).addresses.find(address => address.id === 'air-photo'))
      .toMatchObject({ reservePhotoCount: 0, hasReservePhoto: false, isNotApplicable: false, status: 'PENDING' });
    f.recalculate();
    expect(f.repository.getChecklistNode(f.project.id, photoNode.id)).toMatchObject({ minPhotos: 0 });
  });

  it('restores real photo requirements if an archived SI project is recalculated as KPO', () => {
    const f = fixture('SI');
    const photoNode = f.addOldPhoto();
    f.db.prepare('UPDATE checklist_nodes SET min_photos=0,status=?,not_applicable_reason=? WHERE id=?')
      .run('NOT_APPLICABLE', ARCHIVE_REASON, photoNode.id);
    f.recalculate('KPO');
    expect(f.repository.getChecklistNode(f.project.id, photoNode.id))
      .toMatchObject({ minPhotos: 1, status: 'COMPLETE', notApplicableReason: null });
  });

  it('approves an SI aerial map address without creating reserve folders', () => {
    const f = fixture('SI', 'MANUAL', false);
    const approved = f.approveAerialCandidate();
    expect(approved.status).toBe('APPROVED');
    expect(f.aerialNodes()).toEqual([]);
    expect(f.repository.getProjectMap(f.project.id).addresses.find(address => address.id === approved.approvedAddressId))
      .toMatchObject({ isAerialReserve: true, usesDistributionPhotoForCompletion: true, status: 'PENDING' });
  });

  it('keeps aerial photo requirements and manual map approval for KPO', () => {
    const f = fixture('KPO');
    f.recalculate();
    expect(f.aerialNodes().filter(node => node.nodeType === 'CABLE_RESERVE')).toHaveLength(2);
    const approved = f.approveAerialCandidate();
    expect(f.aerialNodes().find(node => node.addressId === approved.approvedAddressId))
      .toMatchObject({ minPhotos: 1, acceptsPhotos: 1 });
  });

  it('creates KPO requirements for manual aerial addresses retained outside the GPKG', () => {
    const f = fixture('SI', 'MANUAL', false);
    const approved = f.approveAerialCandidate();
    f.recalculate('KPO');
    expect(f.aerialNodes().find(node => node.addressId === approved.approvedAddressId))
      .toMatchObject({ minPhotos: 1, status: 'OPEN' });
  });

  it('recreates an empty manual aerial requirement after KPO to SI to KPO', () => {
    const f = fixture('KPO', 'MANUAL', false);
    const approved = f.approveAerialCandidate();
    f.recalculate('SI');
    expect(f.aerialNodes()).toEqual([]);
    f.recalculate('KPO');
    expect(f.aerialNodes().find(node => node.addressId === approved.approvedAddressId))
      .toMatchObject({ minPhotos: 1, status: 'OPEN' });
  });

  it('keeps a human not-applicable decision on a manual KPO reserve during recalculation', () => {
    const f = fixture('KPO', 'MANUAL', false);
    const approved = f.approveAerialCandidate();
    const node = f.aerialNodes().find(value => value.addressId === approved.approvedAddressId)!;
    f.repository.markNotApplicable(f.project.id, node.id, 'Weryfikacja terenowa');
    f.recalculate('KPO');
    expect(f.repository.getChecklistNode(f.project.id, node.id))
      .toMatchObject({ status: 'NOT_APPLICABLE', notApplicableReason: 'Weryfikacja terenowa' });
  });

  it('restores an assigned manual aerial requirement after KPO to SI to KPO', () => {
    const f = fixture('KPO', 'MANUAL', false);
    const approved = f.approveAerialCandidate();
    const node = f.aerialNodes().find(node => node.addressId === approved.approvedAddressId)!;
    f.repository.addPhoto({ id: 'manual-photo', projectId: f.project.id, checklistNodeId: node.id,
      sourceFileName: 'manual.jpg', storedFileName: 'manual.jpg', storagePath: 'unused/manual.jpg',
      thumbnailPath: null, mimeType: 'image/jpeg', fileSize: 1, lat: null, lng: null,
      capturedAt: null, reserveLocation: 'Napowietrzny' });
    f.recalculate('SI');
    expect(f.repository.getChecklistNode(f.project.id, node.id))
      .toMatchObject({ minPhotos: 0, status: 'NOT_APPLICABLE' });
    f.recalculate('KPO');
    expect(f.repository.getChecklistNode(f.project.id, node.id))
      .toMatchObject({ minPhotos: 1, status: 'COMPLETE', notApplicableReason: null });
    expect(f.repository.getNodePhotos(f.project.id, node.id)).toMatchObject([{ id: 'manual-photo' }]);
  });

  it('does not count archived aerial photos when GPKG reclassifies the address as ground', () => {
    const f = fixture('SI');
    f.addOldPhoto();
    const osdPhotoNode = f.checklist().find(node => node.path === 'BARANOWO_OSD0001/Szczegoly_skrzynki')!;
    f.repository.addPhoto({ id: 'osd-photo', projectId: f.project.id, checklistNodeId: osdPhotoNode.id,
      sourceFileName: 'osd.jpg', storedFileName: 'osd.jpg', storagePath: 'unused/osd.jpg',
      thumbnailPath: null, mimeType: 'image/jpeg', fileSize: 1, lat: null, lng: null,
      capturedAt: null, reserveLocation: null });
    const osd = f.repository.getProjectMap(f.project.id).infraNodes[0];
    f.repository.updateInfraNodeStatus(f.project.id, osd.id, 'WELDED');
    f.recalculate('SI', true);
    const address = f.repository.getProjectMap(f.project.id).addresses.find(value => value.id === 'air-photo')!;
    expect(address).toMatchObject({ isAerialReserve: false, usesDistributionPhotoForCompletion: false,
      reservePhotoCount: 0, hasReservePhoto: false, status: 'PENDING' });
    expect(address.photos).toHaveLength(1);
  });

  it.each([null, 'Weryfikacja terenowa'])(
    'preserves a human not-applicable decision on an assigned KPO reserve through SI: %s',
    (reason) => {
      const f = fixture('KPO');
      const node = f.addOldPhoto();
      f.repository.markNotApplicable(f.project.id, node.id, reason);
      f.recalculate('SI');
      expect(f.repository.getChecklistNode(f.project.id, node.id))
        .toMatchObject({ minPhotos: 0, status: 'NOT_APPLICABLE', notApplicableReason: reason });
      expect(f.repository.getProjectMap(f.project.id).addresses.find(value => value.id === 'air-photo'))
        .toMatchObject({ reservePhotoCount: 0, isNotApplicable: false });
      f.recalculate('KPO');
      expect(f.repository.getChecklistNode(f.project.id, node.id))
        .toMatchObject({ minPhotos: 1, status: 'NOT_APPLICABLE', notApplicableReason: reason });
      expect(f.repository.getNodePhotos(f.project.id, node.id)).toMatchObject([{ id: 'old-photo' }]);
    },
  );

  it.each([false, true])(
    'does not treat an archived aerial subfolder as an OSD photo (human decision: %s)',
    (humanDecision) => {
      const f = fixture('KPO');
      const parent = f.aerialNodes().find(node => node.nodeType === 'DISTRIBUTION')!;
      const node = f.repository.addManualChecklistNode({
        projectId: f.project.id,
        parentId: parent.id,
        name: 'Stare zdjecia zapasu',
        nodeType: 'STATIC',
        minPhotos: 1,
        acceptsPhotos: true,
      });
      f.repository.addPhoto({
        id: 'subfolder-photo', projectId: f.project.id, checklistNodeId: node.id,
        sourceFileName: 'reserve.jpg', storedFileName: 'reserve.jpg',
        storagePath: 'unused/reserve.jpg', thumbnailPath: null, mimeType: 'image/jpeg',
        fileSize: 1, lat: null, lng: null, capturedAt: null, reserveLocation: 'Napowietrzny',
      });
      if (humanDecision) f.repository.markNotApplicable(f.project.id, node.id, 'Weryfikacja terenowa');
      const osd = f.repository.getProjectMap(f.project.id).infraNodes[0];
      f.repository.updateInfraNodeStatus(f.project.id, osd.id, 'WELDED');
      f.recalculate('SI');
      expect(f.repository.getChecklistNode(f.project.id, node.id))
        .toMatchObject({ minPhotos: 0, status: 'NOT_APPLICABLE' });
      expect(f.repository.getNodePhotos(f.project.id, node.id))
        .toMatchObject([{ id: 'subfolder-photo', storagePath: 'unused/reserve.jpg' }]);
      const map = f.repository.getProjectMap(f.project.id);
      expect(map.infraNodes[0]).toMatchObject({ hasPhoto: false, photos: [] });
      expect(map.addresses.find(value => value.id === 'air-empty'))
        .toMatchObject({ hasDistributionPhoto: false, hasReservePhoto: false, status: 'PENDING' });
    },
  );

  it('refuses explicit creation of an SI aerial reserve folder', () => {
    const f = fixture('SI', 'MANUAL', false);
    expect(() => f.repository.ensureReserveChecklistNodeForAddress(f.project.id, {
      id: 'air-empty', city: 'Baranowo', street: 'Testowa', buildingNo: '1',
      distributionPoint: 'BARANOWO/OSD0001', hasAerialReserve: true,
    }, 'Napowietrzny')).toThrow('Aerial reserve folders are not applicable to SI projects');
    expect(f.aerialNodes()).toEqual([]);
  });

  it('refuses manual photo requirements inside an archived SI aerial branch', () => {
    const f = fixture('SI');
    const parent = f.aerialNodes().find(node => node.nodeType === 'DISTRIBUTION')!;
    expect(() => f.repository.addManualChecklistNode({ projectId: f.project.id, parentId: parent.id,
      name: 'Nowy zapas', nodeType: 'CABLE_RESERVE', minPhotos: 1, acceptsPhotos: true }))
      .toThrow('Aerial reserve folders are not applicable to SI projects');
  });
});
