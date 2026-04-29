import type Database from 'better-sqlite3';
import { randomUUID } from 'node:crypto';
import { join } from 'node:path';
import type { ReserveClassification } from './vision-classifier.js';
import type { ChatManifest } from './chat-manifest.js';

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

function toBatchRecord(row: ChatBatchRow): ChatBatchRecord {
  return {
    ...row,
    visualEvidence: parseVisualEvidence(row.visualEvidence),
  };
}

export class ChatBatchesRepository {
  constructor(private readonly db: Database.Database) {}

  importManifest(input: ImportChatManifestInput): ChatBatchRecord {
    const batchId = randomUUID();
    const visualEvidence = JSON.stringify(input.visualEvidence ?? []);

    const tx = this.db.transaction(() => {
      this.db
        .prepare(
          `INSERT INTO chat_photo_batches (
            id, project_id, source, source_space_name, source_space_display_name,
            source_message_name, message_text, source_create_time, folder_name, folder_path,
            status, review_reason, checklist_node_id, reserve_location, confidence,
            llm_model, llm_raw_response, visual_evidence
          ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
          ON CONFLICT(project_id, source_message_name, folder_path) DO UPDATE SET
            source_space_name = excluded.source_space_name,
            source_space_display_name = excluded.source_space_display_name,
            message_text = excluded.message_text,
            source_create_time = excluded.source_create_time,
            folder_name = excluded.folder_name,
            status = excluded.status,
            review_reason = excluded.review_reason,
            checklist_node_id = excluded.checklist_node_id,
            reserve_location = excluded.reserve_location,
            confidence = excluded.confidence,
            llm_model = excluded.llm_model,
            llm_raw_response = excluded.llm_raw_response,
            visual_evidence = excluded.visual_evidence,
            updated_at = CURRENT_TIMESTAMP`,
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

      const batch = this.findBatchIdentity(input.projectId, input.manifest.messageName, input.manifest.folderPath);
      if (!batch) throw new Error('Imported chat batch was not found');

      const insertFile = this.db.prepare(
        `INSERT INTO chat_photo_files (
          id, batch_id, file_name, content_name, content_type, source_path
        ) VALUES (?, ?, ?, ?, ?, ?)
        ON CONFLICT(batch_id, file_name) DO UPDATE SET
          content_name = excluded.content_name,
          content_type = excluded.content_type,
          source_path = excluded.source_path`,
      );

      for (const file of input.manifest.files) {
        insertFile.run(
          randomUUID(),
          batch.id,
          file.fileName,
          file.contentName,
          file.contentType,
          join(input.manifest.folderPath, file.fileName),
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
    return this.db
      .prepare(
        `SELECT id
         FROM chat_photo_batches
         WHERE project_id = ? AND source_message_name = ? AND folder_path = ?`,
      )
      .get(projectId, sourceMessageName, folderPath) as { id: string } | undefined;
  }
}
