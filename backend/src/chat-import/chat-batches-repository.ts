import type Database from 'better-sqlite3';
import { randomUUID } from 'node:crypto';
import { join } from 'node:path';
import { listKnownProjectPhotoHashes } from '../photos/photo-hash-cache.js';
import type { ReserveClassification } from './vision-classifier.js';
import type { ChatManifest, ChatManifestSourceMessage } from './chat-manifest.js';

export type ChatBatchStatus =
  | 'WAITING_FOR_CLASSIFICATION'
  | 'PENDING_REVIEW'
  | 'READY_FOR_IMPORT'
  | 'IMPORTED'
  | 'REJECTED';

export interface ImportChatManifestInput {
  projectId: string;
  manifest: ChatManifest;
  status: ChatBatchStatus;
  reviewReason?: string | null;
  checklistNodeId?: string | null;
  reserveLocation?: ReserveClassification | null;
  confidence?: number | null;
  llmModel?: string | null;
  llmRawResponse?: string | null;
  visualEvidence?: string[];
}

export interface UpdateChatBatchDecisionInput {
  projectId: string;
  batchId: string;
  status: ChatBatchStatus;
  reviewReason?: string | null;
  checklistNodeId?: string | null;
  reserveLocation?: ReserveClassification | null;
  confidence?: number | null;
  llmModel?: string | null;
  llmRawResponse?: string | null;
  visualEvidence?: string[];
}

export interface ChatBatchRecord {
  id: string;
  projectId: string;
  source: 'google-chat';
  sourceSpaceName: string;
  sourceSpaceDisplayName: string;
  sourceMessageName: string;
  messageText: string;
  sourceCreateTime: string;
  sourceMessages: ChatManifestSourceMessage[];
  folderName: string;
  folderPath: string;
  status: ChatBatchStatus;
  reviewReason: string | null;
  checklistNodeId: string | null;
  reserveLocation: ReserveClassification | null;
  confidence: number | null;
  llmModel: string | null;
  llmRawResponse: string | null;
  visualEvidence: string[];
  fileCount: number;
  createdAt: string;
  updatedAt: string;
}

export interface ChatBatchFileRecord {
  id: string;
  batchId: string;
  fileName: string;
  contentName: string;
  contentType: string;
  sourcePath: string;
  contentHash: string | null;
  photoId: string | null;
  createdAt: string;
}

export interface ChatBatchFileImportRecord {
  id: string;
  chatPhotoFileId: string;
  photoId: string;
  checklistNodeId: string;
  createdAt: string;
}

interface ChatBatchRow {
  id: string;
  projectId: string;
  source: 'google-chat';
  sourceSpaceName: string;
  sourceSpaceDisplayName: string;
  sourceMessageName: string;
  messageText: string;
  sourceCreateTime: string;
  sourceMessages: string;
  folderName: string;
  folderPath: string;
  status: ChatBatchStatus;
  reviewReason: string | null;
  checklistNodeId: string | null;
  reserveLocation: ReserveClassification | null;
  confidence: number | null;
  llmModel: string | null;
  llmRawResponse: string | null;
  visualEvidence: string;
  fileCount: number;
  createdAt: string;
  updatedAt: string;
}

function parseVisualEvidence(value: string): string[] {
  try {
    const parsed = JSON.parse(value) as unknown;
    return Array.isArray(parsed) ? parsed.filter((item): item is string => typeof item === 'string') : [];
  } catch {
    return [];
  }
}

function parseSourceMessages(value: string): ChatManifestSourceMessage[] {
  try {
    const parsed = JSON.parse(value) as unknown;
    if (!Array.isArray(parsed)) return [];
    return parsed
      .filter((item): item is Partial<ChatManifestSourceMessage> => item !== null && typeof item === 'object')
      .map((item) => ({
        messageName: typeof item.messageName === 'string' ? item.messageName : '',
        messageText: typeof item.messageText === 'string' ? item.messageText : '',
        createTime: typeof item.createTime === 'string' ? item.createTime : '',
      }))
      .filter((item) => item.messageName || item.messageText || item.createTime);
  } catch {
    return [];
  }
}

function toBatchRecord(row: ChatBatchRow): ChatBatchRecord {
  return {
    ...row,
    sourceMessages: parseSourceMessages(row.sourceMessages),
    visualEvidence: parseVisualEvidence(row.visualEvidence),
  };
}

export class ChatBatchesRepository {
  constructor(private readonly db: Database.Database) {}

  importManifest(input: ImportChatManifestInput): ChatBatchRecord {
    const batchId = randomUUID();
    const visualEvidence = JSON.stringify(input.visualEvidence ?? []);
    const sourceMessages = JSON.stringify(input.manifest.sourceMessages ?? []);

    const tx = this.db.transaction(() => {
      const existing = this.findBatchIdentity(input.projectId, input.manifest.messageName, input.manifest.folderPath);
      if (existing) {
        this.db
          .prepare(
            `UPDATE chat_photo_batches
             SET source_space_name = ?,
                 source_space_display_name = ?,
                 source_message_name = ?,
                 message_text = ?,
                 source_create_time = ?,
                 source_messages = ?,
                 folder_name = ?,
                 status = ?,
                 review_reason = ?,
                 checklist_node_id = ?,
                 reserve_location = ?,
                 confidence = ?,
                 llm_model = ?,
                 llm_raw_response = ?,
                 visual_evidence = ?,
                 updated_at = CURRENT_TIMESTAMP
             WHERE id = ?`,
          )
          .run(
            input.manifest.spaceName,
            input.manifest.spaceDisplayName,
            input.manifest.messageName,
            input.manifest.messageText,
            input.manifest.createTime,
            sourceMessages,
            input.manifest.folderName,
            input.status,
            input.reviewReason ?? null,
            input.checklistNodeId ?? null,
            input.reserveLocation ?? null,
            input.confidence ?? null,
            input.llmModel ?? null,
            input.llmRawResponse ?? null,
            visualEvidence,
            existing.id,
          );
      } else {
        this.db
          .prepare(
            `INSERT INTO chat_photo_batches (
              id, project_id, source, source_space_name, source_space_display_name,
              source_message_name, message_text, source_create_time, source_messages, folder_name, folder_path,
              status, review_reason, checklist_node_id, reserve_location, confidence,
              llm_model, llm_raw_response, visual_evidence
            ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
          )
          .run(
            batchId,
            input.projectId,
            input.manifest.source,
            input.manifest.spaceName,
            input.manifest.spaceDisplayName,
            input.manifest.messageName,
            input.manifest.messageText,
            input.manifest.createTime,
            sourceMessages,
            input.manifest.folderName,
            input.manifest.folderPath,
            input.status,
            input.reviewReason ?? null,
            input.checklistNodeId ?? null,
            input.reserveLocation ?? null,
            input.confidence ?? null,
            input.llmModel ?? null,
            input.llmRawResponse ?? null,
            visualEvidence,
          );
      }

      const batch = this.findBatchIdentity(input.projectId, input.manifest.messageName, input.manifest.folderPath);
      if (!batch) throw new Error('Imported chat batch was not found');

      const insertFile = this.db.prepare(
        `INSERT INTO chat_photo_files (
          id, batch_id, file_name, content_name, content_type, source_path, content_hash
        ) VALUES (?, ?, ?, ?, ?, ?, ?)
        ON CONFLICT(batch_id, file_name) DO UPDATE SET
          content_name = excluded.content_name,
          content_type = excluded.content_type,
          source_path = excluded.source_path,
          content_hash = excluded.content_hash`,
      );

      for (const file of input.manifest.files) {
        const sourcePath = join(input.manifest.folderPath, file.fileName);
        insertFile.run(
          randomUUID(),
          batch.id,
          file.fileName,
          file.contentName,
          file.contentType,
          sourcePath,
          file.contentHash ?? null,
        );
      }

      this.db.prepare(`UPDATE projects SET updated_at = CURRENT_TIMESTAMP WHERE id = ?`).run(input.projectId);
    });

    tx();

    const imported = this.findBatchIdentity(input.projectId, input.manifest.messageName, input.manifest.folderPath);
    if (!imported) throw new Error('Imported chat batch was not found');

    const record = this.getBatch(input.projectId, imported.id);
    if (!record) throw new Error('Imported chat batch record was not found');
    return record;
  }

  listBatches(projectId: string, status?: ChatBatchStatus): ChatBatchRecord[] {
    const rows = status
      ? this.db
          .prepare(
            `SELECT
              batch.id,
              batch.project_id AS projectId,
              batch.source,
              batch.source_space_name AS sourceSpaceName,
              batch.source_space_display_name AS sourceSpaceDisplayName,
              batch.source_message_name AS sourceMessageName,
              batch.message_text AS messageText,
              batch.source_create_time AS sourceCreateTime,
              batch.source_messages AS sourceMessages,
              batch.folder_name AS folderName,
              batch.folder_path AS folderPath,
              batch.status,
              batch.review_reason AS reviewReason,
              batch.checklist_node_id AS checklistNodeId,
              batch.reserve_location AS reserveLocation,
              batch.confidence,
              batch.llm_model AS llmModel,
              batch.llm_raw_response AS llmRawResponse,
              batch.visual_evidence AS visualEvidence,
              COUNT(file.id) AS fileCount,
              batch.created_at AS createdAt,
              batch.updated_at AS updatedAt
            FROM chat_photo_batches batch
            LEFT JOIN chat_photo_files file ON file.batch_id = batch.id
            WHERE batch.project_id = ? AND batch.status = ?
            GROUP BY batch.id
            ORDER BY batch.created_at ASC, batch.folder_name ASC`,
          )
          .all(projectId, status)
      : this.db
          .prepare(
            `SELECT
              batch.id,
              batch.project_id AS projectId,
              batch.source,
              batch.source_space_name AS sourceSpaceName,
              batch.source_space_display_name AS sourceSpaceDisplayName,
              batch.source_message_name AS sourceMessageName,
              batch.message_text AS messageText,
              batch.source_create_time AS sourceCreateTime,
              batch.source_messages AS sourceMessages,
              batch.folder_name AS folderName,
              batch.folder_path AS folderPath,
              batch.status,
              batch.review_reason AS reviewReason,
              batch.checklist_node_id AS checklistNodeId,
              batch.reserve_location AS reserveLocation,
              batch.confidence,
              batch.llm_model AS llmModel,
              batch.llm_raw_response AS llmRawResponse,
              batch.visual_evidence AS visualEvidence,
              COUNT(file.id) AS fileCount,
              batch.created_at AS createdAt,
              batch.updated_at AS updatedAt
            FROM chat_photo_batches batch
            LEFT JOIN chat_photo_files file ON file.batch_id = batch.id
            WHERE batch.project_id = ?
            GROUP BY batch.id
            ORDER BY batch.created_at ASC, batch.folder_name ASC`,
          )
          .all(projectId);

    return (rows as ChatBatchRow[]).map(toBatchRecord);
  }

  findBatchForManifest(projectId: string, manifest: ChatManifest): ChatBatchRecord | undefined {
    const batch = this.findBatchIdentity(projectId, manifest.messageName, manifest.folderPath);
    return batch ? this.getBatch(projectId, batch.id) : undefined;
  }

  listAssignedProjectPhotoContentHashes(projectId: string): string[] {
    return listKnownProjectPhotoHashes(this.db, projectId);
  }

  clearWorkingBatches(projectId: string): number {
    const result = this.db
      .prepare(
        `DELETE FROM chat_photo_batches
         WHERE project_id = ?
           AND status IN ('WAITING_FOR_CLASSIFICATION', 'PENDING_REVIEW', 'READY_FOR_IMPORT')`,
      )
      .run(projectId);

    return result.changes;
  }

  getBatch(projectId: string, batchId: string): ChatBatchRecord | undefined {
    const row = this.db
      .prepare(
        `SELECT
          batch.id,
          batch.project_id AS projectId,
          batch.source,
          batch.source_space_name AS sourceSpaceName,
          batch.source_space_display_name AS sourceSpaceDisplayName,
          batch.source_message_name AS sourceMessageName,
          batch.message_text AS messageText,
          batch.source_create_time AS sourceCreateTime,
          batch.source_messages AS sourceMessages,
          batch.folder_name AS folderName,
          batch.folder_path AS folderPath,
          batch.status,
          batch.review_reason AS reviewReason,
          batch.checklist_node_id AS checklistNodeId,
          batch.reserve_location AS reserveLocation,
          batch.confidence,
          batch.llm_model AS llmModel,
          batch.llm_raw_response AS llmRawResponse,
          batch.visual_evidence AS visualEvidence,
          COUNT(file.id) AS fileCount,
          batch.created_at AS createdAt,
          batch.updated_at AS updatedAt
        FROM chat_photo_batches batch
        LEFT JOIN chat_photo_files file ON file.batch_id = batch.id
        WHERE batch.project_id = ? AND batch.id = ?
        GROUP BY batch.id`,
      )
      .get(projectId, batchId) as ChatBatchRow | undefined;

    return row ? toBatchRecord(row) : undefined;
  }

  listBatchFiles(projectId: string, batchId: string): ChatBatchFileRecord[] {
    return this.db
      .prepare(
        `SELECT
          file.id,
          file.batch_id AS batchId,
          file.file_name AS fileName,
          file.content_name AS contentName,
          file.content_type AS contentType,
          file.source_path AS sourcePath,
          file.content_hash AS contentHash,
          file.photo_id AS photoId,
          file.created_at AS createdAt
        FROM chat_photo_files file
        JOIN chat_photo_batches batch ON batch.id = file.batch_id
        WHERE batch.project_id = ? AND file.batch_id = ?
        ORDER BY file.file_name ASC`,
      )
      .all(projectId, batchId) as ChatBatchFileRecord[];
  }

  recordFileImport(input: { chatPhotoFileId: string; photoId: string; checklistNodeId: string }): void {
    this.db
      .prepare(
        `INSERT INTO chat_photo_file_imports (
          id, chat_photo_file_id, photo_id, checklist_node_id
        ) VALUES (?, ?, ?, ?)
        ON CONFLICT(chat_photo_file_id, photo_id) DO NOTHING`,
      )
      .run(randomUUID(), input.chatPhotoFileId, input.photoId, input.checklistNodeId);
  }

  removeBatchFiles(projectId: string, batchId: string, fileIds: string[]): number {
    if (fileIds.length === 0) return 0;

    const placeholders = fileIds.map(() => '?').join(', ');
    const result = this.db
      .prepare(
        `DELETE FROM chat_photo_files
         WHERE batch_id = ?
           AND id IN (${placeholders})
           AND EXISTS (
             SELECT 1
             FROM chat_photo_batches batch
             WHERE batch.id = chat_photo_files.batch_id
               AND batch.project_id = ?
           )`,
      )
      .run(batchId, ...fileIds, projectId);

    return result.changes;
  }

  listFileImports(projectId: string, batchId: string): ChatBatchFileImportRecord[] {
    return this.db
      .prepare(
        `SELECT
          import.id,
          import.chat_photo_file_id AS chatPhotoFileId,
          import.photo_id AS photoId,
          import.checklist_node_id AS checklistNodeId,
          import.created_at AS createdAt
        FROM chat_photo_file_imports import
        JOIN chat_photo_files file ON file.id = import.chat_photo_file_id
        JOIN chat_photo_batches batch ON batch.id = file.batch_id
        WHERE batch.project_id = ? AND batch.id = ?
        ORDER BY import.created_at ASC, import.photo_id ASC`,
      )
      .all(projectId, batchId) as ChatBatchFileImportRecord[];
  }

  updateDecision(input: UpdateChatBatchDecisionInput): ChatBatchRecord | undefined {
    this.db
      .prepare(
        `UPDATE chat_photo_batches
         SET status = ?,
             review_reason = ?,
             checklist_node_id = ?,
             reserve_location = ?,
             confidence = ?,
             llm_model = ?,
             llm_raw_response = ?,
             visual_evidence = ?,
             updated_at = CURRENT_TIMESTAMP
         WHERE project_id = ? AND id = ?`,
      )
      .run(
        input.status,
        input.reviewReason ?? null,
        input.checklistNodeId ?? null,
        input.reserveLocation ?? null,
        input.confidence ?? null,
        input.llmModel ?? null,
        input.llmRawResponse ?? null,
        JSON.stringify(input.visualEvidence ?? []),
        input.projectId,
        input.batchId,
      );

    return this.getBatch(input.projectId, input.batchId);
  }

  private findBatchIdentity(
    projectId: string,
    sourceMessageName: string,
    folderPath: string,
  ): { id: string } | undefined {
    const exact = this.db
      .prepare(
        `SELECT id
         FROM chat_photo_batches
         WHERE project_id = ? AND source_message_name = ? AND folder_path = ?`,
      )
      .get(projectId, sourceMessageName, folderPath) as { id: string } | undefined;

    if (exact) return exact;

    return this.db
      .prepare(
        `SELECT id
         FROM chat_photo_batches
         WHERE project_id = ? AND folder_path = ?
         ORDER BY updated_at DESC, created_at DESC
         LIMIT 1`,
      )
      .get(projectId, folderPath) as { id: string } | undefined;
  }
}
