import { mkdirSync, writeFileSync } from 'node:fs';
import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { openDatabase } from '../db/connection.js';
import { runMigrations } from '../db/migrations.js';
import { ProjectsRepository } from '../projects/projects-repository.js';
import { ChatBatchesRepository } from './chat-batches-repository.js';
import { classifyWaitingChatBatches } from './chat-classification-runner.js';
import type { ChatManifest } from './chat-manifest.js';

function createContext() {
  const dir = mkdtempSync(join(tmpdir(), 'photo-local-chat-classifier-'));
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
    checklistNodes: [
      {
        id: 'node-maleniecka-5',
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

  return {
    db,
    projects,
    batches: new ChatBatchesRepository(db),
    projectId: project.id,
    dir,
  };
}

function createManifest(folderPath: string, messageText: string): ChatManifest {
  mkdirSync(folderPath, { recursive: true });
  writeFileSync(join(folderPath, 'photo.jpeg'), 'image');

  return {
    source: 'google-chat',
    spaceName: 'spaces/AAA',
    spaceDisplayName: 'Budowa',
    messageName: `spaces/AAA/messages/${messageText}`,
    messageText,
    createTime: '2026-04-27T10:00:00Z',
    folderName: messageText,
    folderPath,
    files: [{ fileName: 'photo.jpeg', contentName: 'photo.jpeg', contentType: 'image/jpeg' }],
  };
}

describe('classifyWaitingChatBatches', () => {
  it('marks a confident reserve batch as ready for checklist import', async () => {
    const { db, projects, batches, projectId, dir } = createContext();
    const folderPath = join(dir, 'Maleniecka 5');
    const batch = batches.importManifest({
      projectId,
      manifest: createManifest(folderPath, 'Maleniecka 5'),
      status: 'WAITING_FOR_CLASSIFICATION',
    });

    const result = await classifyWaitingChatBatches({
      projectId,
      projectsRepository: projects,
      batchesRepository: batches,
      classifyFolder: async () => ({
        folder: folderPath,
        imageCount: 1,
        sampledImages: [join(folderPath, 'photo.jpeg')],
        model: 'qwen2.5vl:3b',
        reserveLocation: 'W studni',
        confidence: 0.94,
        visualEvidence: ['widoczna studnia z zapasem kabla'],
        shouldReview: false,
        rawResponse: '{"reserveLocation":"W studni"}',
        durationMs: 123,
        classifiedAt: '2026-04-28T10:00:00.000Z',
      }),
    });

    const updated = batches.getBatch(projectId, batch.id);
    db.close();

    expect(result).toEqual({ processed: 1, readyForImport: 1, pendingReview: 0 });
    expect(updated).toMatchObject({
      status: 'READY_FOR_IMPORT',
      checklistNodeId: 'node-maleniecka-5',
      reserveLocation: 'W studni',
      confidence: 0.94,
      llmModel: 'qwen2.5vl:3b',
    });
  });

  it('matches street typos when building number is the same', async () => {
    const { db, projects, batches, projectId, dir } = createContext();
    db.prepare(`UPDATE checklist_nodes SET name = ?, path = ? WHERE id = ?`).run(
      'Malenicka_44',
      'Zapasy_kabli_instalacyjnych/OPP0013/Malenicka_44',
      'node-maleniecka-5',
    );
    const folderPath = join(dir, 'Maleniecka 44');
    const batch = batches.importManifest({
      projectId,
      manifest: createManifest(folderPath, 'Maleniecka 44'),
      status: 'WAITING_FOR_CLASSIFICATION',
    });

    await classifyWaitingChatBatches({
      projectId,
      projectsRepository: projects,
      batchesRepository: batches,
      classifyFolder: async () => ({
        folder: folderPath,
        imageCount: 1,
        sampledImages: [join(folderPath, 'photo.jpeg')],
        model: 'qwen2.5vl:3b',
        reserveLocation: 'Doziemny',
        confidence: 0.91,
        visualEvidence: ['zapas kabla przy gruncie'],
        shouldReview: false,
        rawResponse: '{"reserveLocation":"Doziemny"}',
        durationMs: 123,
        classifiedAt: '2026-04-28T10:00:00.000Z',
      }),
    });

    const updated = batches.getBatch(projectId, batch.id);
    db.close();

    expect(updated).toMatchObject({
      status: 'READY_FOR_IMPORT',
      checklistNodeId: 'node-maleniecka-5',
      reserveLocation: 'Doziemny',
    });
  });

  it('matches street typos when checklist address has an UL prefix', async () => {
    const { db, projects, batches, projectId, dir } = createContext();
    db.prepare(`UPDATE checklist_nodes SET name = ?, path = ? WHERE id = ?`).run(
      'UL_MALENICKA_20',
      'Zapasy_kabli_instalacyjnych/RADOM_OPP1416/UL_MALENICKA_20',
      'node-maleniecka-5',
    );
    const folderPath = join(dir, '2025-10-17_Maleniecka 20 zapas w studni rurka drozna do posesji');
    const batch = batches.importManifest({
      projectId,
      manifest: createManifest(folderPath, 'Maleniecka 20 zapas w studni rurka drozna do posesji'),
      status: 'WAITING_FOR_CLASSIFICATION',
    });

    await classifyWaitingChatBatches({
      projectId,
      projectsRepository: projects,
      batchesRepository: batches,
      classifyFolder: async () => ({
        folder: folderPath,
        imageCount: 1,
        sampledImages: [join(folderPath, 'photo.jpeg')],
        model: 'qwen2.5vl:3b',
        reserveLocation: 'W studni',
        confidence: 0.91,
        visualEvidence: ['zapas kabla w studni'],
        shouldReview: false,
        rawResponse: '{"reserveLocation":"W studni"}',
        durationMs: 123,
        classifiedAt: '2026-04-28T10:00:00.000Z',
      }),
    });

    const updated = batches.getBatch(projectId, batch.id);
    db.close();

    expect(updated).toMatchObject({
      status: 'READY_FOR_IMPORT',
      checklistNodeId: 'node-maleniecka-5',
      reserveLocation: 'W studni',
    });
  });

  it('matches D-prefixed address identifiers', async () => {
    const { db, projects, batches, projectId, dir } = createContext();
    db.prepare(`UPDATE checklist_nodes SET name = ?, path = ? WHERE id = ?`).run(
      'UL_MALENICKA_D2278',
      'Zapasy_kabli_instalacyjnych/RADOM_OPP1416/UL_MALENICKA_D2278',
      'node-maleniecka-5',
    );
    const folderPath = join(dir, '2025-10-16_Maleniecka D2278');
    const batch = batches.importManifest({
      projectId,
      manifest: createManifest(folderPath, 'Maleniecka D2278'),
      status: 'WAITING_FOR_CLASSIFICATION',
    });

    await classifyWaitingChatBatches({
      projectId,
      projectsRepository: projects,
      batchesRepository: batches,
      classifyFolder: async () => ({
        folder: folderPath,
        imageCount: 1,
        sampledImages: [join(folderPath, 'photo.jpeg')],
        model: 'qwen2.5vl:3b',
        reserveLocation: 'Doziemny',
        confidence: 0.9,
        visualEvidence: ['zapas kabla w ziemi'],
        shouldReview: false,
        rawResponse: '{"reserveLocation":"Doziemny"}',
        durationMs: 123,
        classifiedAt: '2026-04-28T10:00:00.000Z',
      }),
    });

    const updated = batches.getBatch(projectId, batch.id);
    db.close();

    expect(updated).toMatchObject({
      status: 'READY_FOR_IMPORT',
      checklistNodeId: 'node-maleniecka-5',
      reserveLocation: 'Doziemny',
    });
  });

  it('matches chat address variants with ul prefix, suffix text and trailing separators', async () => {
    const { db, projects, batches, projectId, dir } = createContext();
    db.prepare(`DELETE FROM checklist_nodes WHERE project_id = ?`).run(projectId);
    const insertNode = db.prepare(
      `INSERT INTO checklist_nodes (
        id, project_id, parent_id, name, path, node_type, address_id,
        sort_order, min_photos, accepts_photos, status
      ) VALUES (?, ?, null, ?, ?, 'CABLE_RESERVE', null, ?, 1, 1, 'OPEN')`,
    );
    for (const [index, name] of ['UL_MALENICKA_28B', 'UL_MALENICKA_30A', 'UL_MALENICKA_31A', 'UL_MALENICKA_36C', 'UL_MALENICKA_38L'].entries()) {
      insertNode.run(
        `node-${name.toLowerCase()}`,
        projectId,
        name,
        `Zapasy_kabli_instalacyjnych/RADOM_OPP1416/${name}`,
        index,
      );
    }

    const cases = [
      ['2025-10-20_Ul. Malenicka 28B', 'node-ul_malenicka_28b'],
      ['2025-10-20_Ul. Malenicka 30A , zapas w studni', 'node-ul_malenicka_30a'],
      ['2025-10-20_Ul. Malenicka 31A Zapas kabla w studni. Rurka drozna za gran', 'node-ul_malenicka_31a'],
      ['2025-10-20_Maleniecka 36C_', 'node-ul_malenicka_36c'],
      ['2025-10-20_MALENICka 38l', 'node-ul_malenicka_38l'],
    ] as const;

    for (const [folderName, expectedNodeId] of cases) {
      const messageText = folderName.replace(/^\d{4}-\d{2}-\d{2}_/, '');
      batches.importManifest({
        projectId,
        manifest: createManifest(join(dir, folderName), messageText),
        status: 'WAITING_FOR_CLASSIFICATION',
      });
      await classifyWaitingChatBatches({
        projectId,
        projectsRepository: projects,
        batchesRepository: batches,
        classifyFolder: async (input) => ({
          folder: input.folderPath,
          imageCount: 1,
          sampledImages: [join(input.folderPath, 'photo.jpeg')],
          model: 'qwen2.5vl:3b',
          reserveLocation: 'W studni',
          confidence: 0.9,
          visualEvidence: ['zapas kabla w studni'],
          shouldReview: false,
          rawResponse: '{"reserveLocation":"W studni"}',
          durationMs: 123,
          classifiedAt: '2026-04-28T10:00:00.000Z',
        }),
      });

      const updated = batches
        .listBatches(projectId, 'READY_FOR_IMPORT')
        .find((batch) => batch.folderName === messageText);
      expect(updated?.checklistNodeId).toBe(expectedNodeId);
    }

    db.close();
  });

  it('does not auto-match street typos when multiple candidates share the same building number', async () => {
    const { db, projects, batches, projectId, dir } = createContext();
    db.prepare(`UPDATE checklist_nodes SET name = ?, path = ? WHERE id = ?`).run(
      'Malenicka_44',
      'Zapasy_kabli_instalacyjnych/OPP0013/Malenicka_44',
      'node-maleniecka-5',
    );
    db.prepare(
      `INSERT INTO checklist_nodes (
        id, project_id, parent_id, name, path, node_type, address_id,
        sort_order, min_photos, accepts_photos, status
      ) VALUES (?, ?, null, ?, ?, 'CABLE_RESERVE', null, 1, 1, 1, 'OPEN')`,
    ).run('node-malinicka-44', projectId, 'Malinicka_44', 'Zapasy_kabli_instalacyjnych/OPP0013/Malinicka_44');
    const folderPath = join(dir, 'Maleniecka 44');
    const batch = batches.importManifest({
      projectId,
      manifest: createManifest(folderPath, 'Maleniecka 44'),
      status: 'WAITING_FOR_CLASSIFICATION',
    });

    await classifyWaitingChatBatches({
      projectId,
      projectsRepository: projects,
      batchesRepository: batches,
      classifyFolder: async () => ({
        folder: folderPath,
        imageCount: 1,
        sampledImages: [join(folderPath, 'photo.jpeg')],
        model: 'qwen2.5vl:3b',
        reserveLocation: 'Doziemny',
        confidence: 0.91,
        visualEvidence: ['zapas kabla przy gruncie'],
        shouldReview: false,
        rawResponse: '{"reserveLocation":"Doziemny"}',
        durationMs: 123,
        classifiedAt: '2026-04-28T10:00:00.000Z',
      }),
    });

    const updated = batches.getBatch(projectId, batch.id);
    db.close();

    expect(updated).toMatchObject({
      status: 'PENDING_REVIEW',
      checklistNodeId: null,
      reserveLocation: 'Doziemny',
      reviewReason: 'Nie znaleziono jednoznacznego punktu checklisty',
    });
  });

  it('matches OSD folders to box detail checklist nodes without running vision classification', async () => {
    const { db, projects, batches, projectId, dir } = createContext();
    db.prepare(
      `INSERT INTO checklist_nodes (
        id, project_id, parent_id, name, path, node_type, address_id,
        sort_order, min_photos, accepts_photos, status
      ) VALUES (?, ?, null, ?, ?, 'DISTRIBUTION', null, 1, 1, 1, 'OPEN')`,
    ).run('node-osd2766-details', projectId, 'Szczegoly_skrzynki', 'OSD2766/Szczegoly_skrzynki');
    const folderPath = join(dir, 'OSD2766');
    const batch = batches.importManifest({
      projectId,
      manifest: createManifest(folderPath, 'OSD2766'),
      status: 'WAITING_FOR_CLASSIFICATION',
    });

    await classifyWaitingChatBatches({
      projectId,
      projectsRepository: projects,
      batchesRepository: batches,
      classifyFolder: async () => {
        throw new Error('Vision model should not run for OSD box folders');
      },
    });

    const updated = batches.getBatch(projectId, batch.id);
    db.close();

    expect(updated).toMatchObject({
      status: 'READY_FOR_IMPORT',
      checklistNodeId: 'node-osd2766-details',
      reserveLocation: null,
      reviewReason: null,
    });
  });

  it('sends uncertain or unmatched batches to review', async () => {
    const { db, projects, batches, projectId, dir } = createContext();
    const folderPath = join(dir, 'Nieznana 99');
    const batch = batches.importManifest({
      projectId,
      manifest: createManifest(folderPath, 'Nieznana 99'),
      status: 'WAITING_FOR_CLASSIFICATION',
    });

    await classifyWaitingChatBatches({
      projectId,
      projectsRepository: projects,
      batchesRepository: batches,
      classifyFolder: async () => ({
        folder: folderPath,
        imageCount: 1,
        sampledImages: [join(folderPath, 'photo.jpeg')],
        model: 'qwen2.5vl:3b',
        reserveLocation: 'Niepewne',
        confidence: 0.4,
        visualEvidence: [],
        shouldReview: true,
        rawResponse: '{}',
        durationMs: 123,
        classifiedAt: '2026-04-28T10:00:00.000Z',
      }),
    });

    const updated = batches.getBatch(projectId, batch.id);
    db.close();

    expect(updated).toMatchObject({
      status: 'PENDING_REVIEW',
      checklistNodeId: null,
      reserveLocation: null,
      reviewReason: 'LLM wymaga recznego sprawdzenia',
    });
  });

  it('keeps parser failures out of manual review so they can be retried', async () => {
    const { db, projects, batches, projectId, dir } = createContext();
    const folderPath = join(dir, 'Maleniecka 5');
    const batch = batches.importManifest({
      projectId,
      manifest: createManifest(folderPath, 'Maleniecka 5'),
      status: 'WAITING_FOR_CLASSIFICATION',
    });

    await classifyWaitingChatBatches({
      projectId,
      projectsRepository: projects,
      batchesRepository: batches,
      classifyFolder: async () => ({
        folder: folderPath,
        imageCount: 1,
        sampledImages: [join(folderPath, 'photo.jpeg')],
        model: 'qwen2.5vl:3b',
        reserveLocation: 'Niepewne',
        confidence: 0,
        visualEvidence: [],
        reason: 'Nie udalo sie sparsowac odpowiedzi modelu: Unexpected token',
        shouldReview: true,
        rawResponse: '{"!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!',
        durationMs: 123,
        classifiedAt: '2026-04-28T10:00:00.000Z',
      }),
    });

    const updated = batches.getBatch(projectId, batch.id);
    db.close();

    expect(updated).toMatchObject({
      status: 'WAITING_FOR_CLASSIFICATION',
      checklistNodeId: null,
      reserveLocation: null,
      reviewReason: 'Blad odpowiedzi LLM - ponow klasyfikacje',
    });
  });

  it('reports progress before and after each classified batch', async () => {
    const { db, projects, batches, projectId, dir } = createContext();
    batches.importManifest({
      projectId,
      manifest: createManifest(join(dir, 'Maleniecka 5'), 'Maleniecka 5'),
      status: 'WAITING_FOR_CLASSIFICATION',
    });
    const progress: Array<{ processed: number; total: number; currentFolderName: string | null }> = [];

    await classifyWaitingChatBatches({
      projectId,
      projectsRepository: projects,
      batchesRepository: batches,
      onProgress: (event) => {
        progress.push({
          processed: event.processed,
          total: event.total,
          currentFolderName: event.currentFolderName,
        });
      },
      classifyFolder: async () => ({
        folder: join(dir, 'Maleniecka 5'),
        imageCount: 1,
        sampledImages: [join(dir, 'Maleniecka 5', 'photo.jpeg')],
        model: 'qwen2.5vl:3b',
        reserveLocation: 'W studni',
        confidence: 0.94,
        visualEvidence: ['widoczna studnia'],
        shouldReview: false,
        rawResponse: '{}',
        durationMs: 123,
        classifiedAt: '2026-04-28T10:00:00.000Z',
      }),
    });
    db.close();

    expect(progress).toEqual([
      { processed: 0, total: 1, currentFolderName: 'Maleniecka 5' },
      { processed: 1, total: 1, currentFolderName: null },
    ]);
  });
});
