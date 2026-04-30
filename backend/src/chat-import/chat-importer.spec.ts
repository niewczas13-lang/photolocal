import { mkdirSync, writeFileSync } from 'node:fs';
import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
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
  const project = projects.createProject({
    name: 'OPP0013',
    projectDefinition: null,
    projectType: 'SI',
    splitterTopology: 'SINGLE',
    splitterTopologySource: 'AUTO',
    splitterCount: 1,
    gpkgFileName: 'OPP0013.gpkg',
    baseFolder: join(dir, 'photos'),
    addresses: [],
    dacToAddressCableCount: 0,
    adssToAddressCableCount: 0,
    checklistNodes: [],
  });

  return { db, repository: new ChatBatchesRepository(db), projectId: project.id, dir };
}

function writeManifest(root: string, folderName: string, messageText: string): void {
  const folderPath = join(root, folderName);
  mkdirSync(folderPath, { recursive: true });
  writeFileSync(join(folderPath, 'photo.jpeg'), 'image');
  writeFileSync(
    join(folderPath, 'manifest.json'),
    JSON.stringify(
      {
        source: 'google-chat',
        spaceName: 'spaces/AAA',
        spaceDisplayName: 'Budowa',
        messageName: `spaces/AAA/messages/${folderName}`,
        messageText,
        createTime: '2026-04-27T10:00:00Z',
        folderName,
        files: [{ fileName: 'photo.jpeg', contentName: 'photo.jpeg', contentType: 'image/jpeg' }],
      },
      null,
      2,
    ),
  );
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

    expect(result).toEqual({ imported: 3, waitingForClassification: 1, pendingReview: 2 });
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

    expect(result).toEqual({ imported: 1, waitingForClassification: 0, pendingReview: 1 });
    expect(batch).toMatchObject({
      folderName: 'Tu nie ma przejscia',
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

    expect(result).toEqual({ imported: 2, waitingForClassification: 2, pendingReview: 0 });
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

    expect(result).toEqual({ imported: 1, waitingForClassification: 1, pendingReview: 0 });
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

    expect(result).toEqual({ imported: 1, waitingForClassification: 1, pendingReview: 0 });
    expect(batch).toMatchObject({
      folderName: 'OSD 2766',
      status: 'WAITING_FOR_CLASSIFICATION',
    });
  });
});
