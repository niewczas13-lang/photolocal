import { mkdirSync, writeFileSync } from 'node:fs';
import { createHash } from 'node:crypto';
import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { openDatabase } from '../db/connection.js';
import { runMigrations } from '../db/migrations.js';
import { ProjectsRepository } from '../projects/projects-repository.js';
import { ChatBatchesRepository } from './chat-batches-repository.js';
import { importChatFolders } from './chat-importer.js';

function createContext() {
  const dir = mkdtempSync(join(tmpdir(), 'photo-local-chat-importer-'));
  mkdirSync(dir, { recursive: true });
  const db = openDatabase(join(dir, 'test.sqlite'));
  runMigrations(db);
  const projects = new ProjectsRepository(db);
  const projectBaseFolder = mkdtempSync(join(tmpdir(), 'photo-local-project-photos-'));
  const project = projects.createProject({
    name: 'OPP0013',
    projectDefinition: null,
    projectType: 'SI',
    splitterTopology: 'SINGLE',
    splitterTopologySource: 'AUTO',
    splitterCount: 1,
    gpkgFileName: 'OPP0013.gpkg',
    baseFolder: projectBaseFolder,
    addresses: [],
    dacToAddressCableCount: 0,
    adssToAddressCableCount: 0,
    checklistNodes: [
      {
        id: 'node-existing',
        projectId: 'project-temp',
        parentId: null,
        name: 'Maleniecka_5',
        path: 'Zapasy_kabli_instalacyjnych/OPP0013/Maleniecka_5',
        nodeType: 'CABLE_RESERVE',
        addressId: null,
        sortOrder: 0,
        minPhotos: 1,
        acceptsPhotos: true,
      },
    ],
  });

  return { db, projects, repository: new ChatBatchesRepository(db), projectId: project.id, dir, projectBaseFolder };
}

function writeManifest(
  root: string,
  folderName: string,
  messageText: string,
  messageName?: string,
  photoContent = `image:${folderName}`,
  contentHash?: string,
): void {
  const folderPath = join(root, folderName);
  mkdirSync(folderPath, { recursive: true });
  writeFileSync(join(folderPath, 'photo.jpeg'), photoContent);
  writeFileSync(
    join(folderPath, 'manifest.json'),
    JSON.stringify(
      {
        source: 'google-chat',
        spaceName: 'spaces/AAA',
        spaceDisplayName: 'Budowa',
        messageName: messageName ?? `spaces/AAA/messages/${folderName}`,
        messageText,
        createTime: '2026-04-27T10:00:00Z',
        folderName,
        files: [
          {
            fileName: 'photo.jpeg',
            contentName: 'photo.jpeg',
            contentType: 'image/jpeg',
            ...(contentHash ? { contentHash } : {}),
          },
        ],
      },
      null,
      2,
    ),
  );
}

function sha256(value: string): string {
  return createHash('sha256').update(value).digest('hex');
}

describe('importChatFolders', () => {
  it('routes normal folders to LLM classification and risky folders to review', async () => {
    const { db, repository, projectId, dir } = createContext();
    writeManifest(dir, 'Maleniecka 5', 'Maleniecka 5');
    writeManifest(dir, 'brak_opisu', '');
    writeManifest(dir, 'Maleniecka 5 i 7', 'Maleniecka 5 i 7');

    const result = await importChatFolders({ projectId, rootPath: dir, repository });
    const batches = repository.listBatches(projectId);
    db.close();

    expect(result).toEqual({ imported: 3, waitingForClassification: 1, pendingReview: 2, cleared: 0 });
    expect(batches).toEqual([
      expect.objectContaining({ folderName: 'Maleniecka 5', status: 'WAITING_FOR_CLASSIFICATION' }),
      expect.objectContaining({
        folderName: 'Maleniecka 5 i 7',
        status: 'PENDING_REVIEW',
        reviewReason: 'Wiadomosc wyglada na wiele adresow',
      }),
      expect.objectContaining({
        folderName: 'brak_opisu',
        status: 'PENDING_REVIEW',
        reviewReason: 'Brak opisu wiadomosci',
      }),
    ]);
  });

  it('sends non-address construction notes to review without LLM classification', async () => {
    const { db, repository, projectId, dir } = createContext();
    writeManifest(dir, 'Tu nie ma przejscia', 'Tu nie ma przejscia');

    const result = await importChatFolders({ projectId, rootPath: dir, repository });
    const [batch] = repository.listBatches(projectId);
    db.close();

    expect(result).toEqual({ imported: 1, waitingForClassification: 0, pendingReview: 1, cleared: 0 });
    expect(batch).toMatchObject({
      folderName: 'Tu nie ma przejscia',
      status: 'PENDING_REVIEW',
      reviewReason: 'Opis nie wyglada na adres ani punkt checklisty',
    });
  });

  it('sends street-only descriptions to review without LLM classification', async () => {
    const { db, repository, projectId, dir } = createContext();
    writeManifest(dir, 'Maleniecka', 'Maleniecka');

    const result = await importChatFolders({ projectId, rootPath: dir, repository });
    const [batch] = repository.listBatches(projectId);
    db.close();

    expect(result).toEqual({ imported: 1, waitingForClassification: 0, pendingReview: 1, cleared: 0 });
    expect(batch).toMatchObject({
      folderName: 'Maleniecka',
      status: 'PENDING_REVIEW',
      reviewReason: 'Opis nie wyglada na adres ani punkt checklisty',
    });
  });

  it('sends long noisy descriptions with incidental numbers to review', async () => {
    const { db, repository, projectId, dir } = createContext();
    writeManifest(
      dir,
      'Zapas kabla w studni jutro koparka 3 osoby na miejscu',
      'Zapas kabla w studni jutro koparka 3 osoby na miejscu',
    );

    const result = await importChatFolders({ projectId, rootPath: dir, repository });
    const [batch] = repository.listBatches(projectId);
    db.close();

    expect(result).toEqual({ imported: 1, waitingForClassification: 0, pendingReview: 1, cleared: 0 });
    expect(batch).toMatchObject({
      folderName: 'Zapas kabla w studni jutro koparka 3 osoby na miejscu',
      status: 'PENDING_REVIEW',
      reviewReason: 'Opis nie wyglada na adres ani punkt checklisty',
    });
  });

  it('routes address folders with trailing underscores to LLM classification', async () => {
    const { db, repository, projectId, dir } = createContext();
    writeManifest(dir, '2025-10-20_Maleniecka 36B_', 'Maleniecka 36B_');
    writeManifest(dir, '2025-10-27_Malenicka 48_', 'Malenicka 48_');

    const result = await importChatFolders({ projectId, rootPath: dir, repository });
    const batches = repository.listBatches(projectId);
    db.close();

    expect(result).toEqual({ imported: 2, waitingForClassification: 2, pendingReview: 0, cleared: 0 });
    expect(batches).toEqual([
      expect.objectContaining({ folderName: '2025-10-20_Maleniecka 36B_', status: 'WAITING_FOR_CLASSIFICATION' }),
      expect.objectContaining({ folderName: '2025-10-27_Malenicka 48_', status: 'WAITING_FOR_CLASSIFICATION' }),
    ]);
  });

  it('routes noisy address folders with construction-note suffixes to classification', async () => {
    const { db, repository, projectId, dir } = createContext();
    writeManifest(
      dir,
      '2025-10-20_Ul. Maleniecka 30A zapas w studni rurka drozna',
      'Ul. Maleniecka 30A zapas w studni rurka drozna',
    );

    const result = await importChatFolders({ projectId, rootPath: dir, repository });
    const [batch] = repository.listBatches(projectId);
    db.close();

    expect(result).toEqual({ imported: 1, waitingForClassification: 1, pendingReview: 0, cleared: 0 });
    expect(batch).toMatchObject({
      folderName: '2025-10-20_Ul. Maleniecka 30A zapas w studni rurka drozna',
      status: 'WAITING_FOR_CLASSIFICATION',
    });
  });

  it('routes spaced point-id folder names to classification', async () => {
    const { db, repository, projectId, dir } = createContext();
    writeManifest(dir, 'OSD 2766', 'OSD 2766');

    const result = await importChatFolders({ projectId, rootPath: dir, repository });
    const [batch] = repository.listBatches(projectId);
    db.close();

    expect(result).toEqual({ imported: 1, waitingForClassification: 1, pendingReview: 0, cleared: 0 });
    expect(batch).toMatchObject({
      folderName: 'OSD 2766',
      status: 'WAITING_FOR_CLASSIFICATION',
    });
  });

  it('does not send previously handled batches back to classification or review', async () => {
    const { db, repository, projectId, dir } = createContext();
    writeManifest(dir, 'Maleniecka 5', 'Maleniecka 5');
    writeManifest(dir, 'brak_opisu', '');
    writeManifest(dir, 'Tu nie ma przejscia', 'Tu nie ma przejscia');

    await importChatFolders({ projectId, rootPath: dir, repository });
    const initialBatches = repository.listBatches(projectId);
    const waiting = initialBatches.find((batch) => batch.folderName === 'Maleniecka 5');
    const reviewWithoutAddress = initialBatches.find((batch) => batch.folderName === 'Tu nie ma przejscia');
    if (!waiting || !reviewWithoutAddress) {
      throw new Error('Expected test batches were not created');
    }

    repository.updateDecision({
      projectId,
      batchId: waiting.id,
      status: 'IMPORTED',
      reserveLocation: 'Doziemny',
      confidence: 0.95,
    });
    repository.updateDecision({
      projectId,
      batchId: reviewWithoutAddress.id,
      status: 'REJECTED',
      reviewReason: 'Odrzucone recznie',
    });

    const result = await importChatFolders({ projectId, rootPath: dir, repository });
    const batches = repository.listBatches(projectId);
    db.close();

    expect(result).toEqual({ imported: 1, waitingForClassification: 0, pendingReview: 1, cleared: 1 });
    expect(batches).toEqual(
      expect.arrayContaining([
        expect.objectContaining({ folderName: 'Tu nie ma przejscia', status: 'REJECTED' }),
        expect.objectContaining({ folderName: 'Maleniecka 5', status: 'IMPORTED' }),
        expect.objectContaining({ folderName: 'brak_opisu', status: 'PENDING_REVIEW' }),
      ]),
    );
  });

  it('does not requeue a rejected folder when Google Chat refresh changes the message id', async () => {
    const { db, repository, projectId, dir } = createContext();
    writeManifest(dir, '2026-04-27_Maleniecka 5', 'Maleniecka 5', 'spaces/AAA/messages/first');

    await importChatFolders({ projectId, rootPath: dir, repository });
    const [batch] = repository.listBatches(projectId);
    repository.updateDecision({
      projectId,
      batchId: batch.id,
      status: 'REJECTED',
      reviewReason: 'Odrzucone recznie',
    });
    writeManifest(dir, '2026-04-27_Maleniecka 5', 'Maleniecka 5', 'spaces/AAA/messages/second');

    const result = await importChatFolders({ projectId, rootPath: dir, repository });
    const batches = repository.listBatches(projectId);
    db.close();

    expect(result).toEqual({ imported: 0, waitingForClassification: 0, pendingReview: 0, cleared: 0 });
    expect(batches).toEqual([
      expect.objectContaining({
        folderName: '2026-04-27_Maleniecka 5',
        status: 'REJECTED',
      }),
    ]);
  });

  it('requeues new files added to a previously imported chat folder', async () => {
    const { db, projects, repository, projectId, dir, projectBaseFolder } = createContext();
    const oldHash = sha256('old-image');
    const newHash = sha256('new-image');
    writeManifest(dir, 'brak_opisu', '', 'spaces/AAA/messages/first', 'old-image', oldHash);

    await importChatFolders({ projectId, rootPath: dir, repository });
    const [firstBatch] = repository.listBatches(projectId);
    const oldFiles = repository.listBatchFiles(projectId, firstBatch.id);
    repository.removeBatchFiles(projectId, firstBatch.id, oldFiles.map((file) => file.id));
    repository.updateDecision({
      projectId,
      batchId: firstBatch.id,
      status: 'IMPORTED',
      reviewReason: null,
    });
    const storedPath = join(projectBaseFolder, 'Zapasy_kabli_instalacyjnych', 'OPP0013', 'Maleniecka_5', 'photo.jpeg');
    mkdirSync(dirname(storedPath), { recursive: true });
    writeFileSync(storedPath, 'old-image');
    projects.addPhoto({
      id: 'photo-existing',
      projectId,
      checklistNodeId: 'node-existing',
      sourceFileName: 'photo.jpeg',
      storedFileName: 'photo.jpeg',
      storagePath: storedPath,
      thumbnailPath: null,
      mimeType: 'image/jpeg',
      fileSize: 9,
      lat: null,
      lng: null,
      capturedAt: null,
      reserveLocation: null,
      contentHash: oldHash,
    });

    const folderPath = join(dir, 'brak_opisu');
    writeFileSync(join(folderPath, 'new.jpeg'), 'new-image');
    writeFileSync(
      join(folderPath, 'manifest.json'),
      JSON.stringify(
        {
          source: 'google-chat',
          spaceName: 'spaces/AAA',
          spaceDisplayName: 'Budowa',
          messageName: 'spaces/AAA/messages/first',
          messageText: '',
          createTime: '2026-04-27T10:00:00Z',
          folderName: 'brak_opisu',
          files: [
            { fileName: 'photo.jpeg', contentName: 'photo.jpeg', contentType: 'image/jpeg', contentHash: oldHash },
            { fileName: 'new.jpeg', contentName: 'new.jpeg', contentType: 'image/jpeg', contentHash: newHash },
          ],
        },
        null,
        2,
      ),
    );

    const result = await importChatFolders({ projectId, rootPath: dir, repository });
    const [batch] = repository.listBatches(projectId, 'PENDING_REVIEW');
    const files = repository.listBatchFiles(projectId, batch.id);
    db.close();

    expect(result).toEqual({ imported: 1, waitingForClassification: 0, pendingReview: 1, cleared: 0 });
    expect(batch.id).toBe(firstBatch.id);
    expect(files.map((file) => file.fileName)).toEqual(['new.jpeg']);
  });

  it('does not create review batches for photos already assigned inside the project folder', async () => {
    const { db, projects, repository, projectId, dir, projectBaseFolder } = createContext();
    writeManifest(dir, '2026-04-27_Maleniecka 5', 'Maleniecka 5', undefined, 'image', sha256('image'));
    const storedPath = join(projectBaseFolder, 'Zapasy_kabli_instalacyjnych', 'OPP0013', 'Maleniecka_5', 'photo.jpeg');
    mkdirSync(dirname(storedPath), { recursive: true });
    writeFileSync(storedPath, 'image');
    projects.addPhoto({
      id: 'photo-existing',
      projectId,
      checklistNodeId: 'node-existing',
      sourceFileName: 'photo.jpeg',
      storedFileName: 'photo.jpeg',
      storagePath: storedPath,
      thumbnailPath: null,
      mimeType: 'image/jpeg',
      fileSize: 5,
      lat: null,
      lng: null,
      capturedAt: null,
      reserveLocation: null,
      contentHash: sha256('image'),
    });

    const result = await importChatFolders({ projectId, rootPath: dir, repository });
    const batches = repository.listBatches(projectId);
    db.close();

    expect(result).toEqual({ imported: 0, waitingForClassification: 0, pendingReview: 0, cleared: 0 });
    expect(batches).toEqual([]);
  });

  it('skips already assigned project photos even when stored and downloaded hashes are missing', async () => {
    const { db, projects, repository, projectId, dir, projectBaseFolder } = createContext();
    writeManifest(dir, 'brak_opisu', '', undefined, 'image');
    const storedPath = join(projectBaseFolder, 'Zapasy_kabli_instalacyjnych', 'OPP0013', 'Maleniecka_5', 'photo.jpeg');
    mkdirSync(dirname(storedPath), { recursive: true });
    writeFileSync(storedPath, 'image');
    projects.addPhoto({
      id: 'photo-existing',
      projectId,
      checklistNodeId: 'node-existing',
      sourceFileName: 'photo.jpeg',
      storedFileName: 'photo.jpeg',
      storagePath: storedPath,
      thumbnailPath: null,
      mimeType: 'image/jpeg',
      fileSize: 5,
      lat: null,
      lng: null,
      capturedAt: null,
      reserveLocation: null,
      contentHash: null,
    });

    const result = await importChatFolders({ projectId, rootPath: dir, repository });
    const batches = repository.listBatches(projectId);
    const photo = db
      .prepare(`SELECT content_hash AS contentHash FROM photos WHERE id = 'photo-existing'`)
      .get() as { contentHash: string | null };
    db.close();

    expect(result).toEqual({ imported: 0, waitingForClassification: 0, pendingReview: 0, cleared: 0 });
    expect(batches).toEqual([]);
    expect(photo.contentHash).toBe(sha256('image'));
  });

  it('keeps only one review batch when two new Google Chat messages contain the same photo', async () => {
    const { db, repository, projectId, dir } = createContext();
    const contentHash = sha256('same-image');
    writeManifest(
      dir,
      '2026-04-27_Maleniecka 5 pierwsza',
      'Maleniecka 5',
      'spaces/AAA/messages/first',
      'same-image',
      contentHash,
    );
    writeManifest(
      dir,
      '2026-04-27_Maleniecka 5 druga',
      'Maleniecka 5',
      'spaces/AAA/messages/second',
      'same-image',
      contentHash,
    );

    const result = await importChatFolders({ projectId, rootPath: dir, repository });
    const batches = repository.listBatches(projectId);
    db.close();

    expect(result).toEqual({ imported: 1, waitingForClassification: 0, pendingReview: 1, cleared: 0 });
    expect(batches).toHaveLength(1);
  });

  it('clears old working chat queue before importing another folder', async () => {
    const { db, repository, projectId, dir } = createContext();
    const wrongRoot = join(dir, 'wrong-room');
    const rightRoot = join(dir, 'right-room');
    mkdirSync(wrongRoot, { recursive: true });
    mkdirSync(rightRoot, { recursive: true });
    writeManifest(wrongRoot, 'Zly pokoj 1', '');
    writeManifest(wrongRoot, 'Zly pokoj 2', 'Tu nie ma przejscia');
    writeManifest(wrongRoot, 'Zly pokoj 3', 'Maleniecka 5');

    await importChatFolders({ projectId, rootPath: wrongRoot, repository });
    const oldBatches = repository.listBatches(projectId);
    const oldWaiting = oldBatches.find((batch) => batch.folderName === 'Zly pokoj 3');
    const oldReview = oldBatches.find((batch) => batch.folderName === 'Zly pokoj 2');
    const oldReady = oldBatches.find((batch) => batch.folderName === 'Zly pokoj 1');
    if (!oldWaiting || !oldReview || !oldReady) {
      throw new Error('Expected wrong-room test batches were not created');
    }
    repository.updateDecision({ projectId, batchId: oldReady.id, status: 'READY_FOR_IMPORT' });
    writeManifest(rightRoot, 'Maleniecka 7', 'Maleniecka 7');

    const result = await importChatFolders({ projectId, rootPath: rightRoot, repository });
    const batches = repository.listBatches(projectId);
    db.close();

    expect(result).toEqual({ imported: 1, waitingForClassification: 1, pendingReview: 0, cleared: 3 });
    expect(batches).toEqual([
      expect.objectContaining({ folderName: 'Maleniecka 7', status: 'WAITING_FOR_CLASSIFICATION' }),
    ]);
  });
});
