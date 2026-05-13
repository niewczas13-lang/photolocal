import type Database from 'better-sqlite3';
import { readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const __dirname = dirname(fileURLToPath(import.meta.url));

export function runMigrations(db: Database.Database): void {
  const schema = readFileSync(join(__dirname, 'schema.sql'), 'utf8');
  db.exec(schema);

  try {
    db.exec('ALTER TABLE projects ADD COLUMN project_definition TEXT;');
  } catch (e) {
    // Ignore error if column already exists
  }

  migrateChatReserveLocationConstraint(db, schema);
}

function migrateChatReserveLocationConstraint(db: Database.Database, schema: string): void {
  const row = db
    .prepare("SELECT sql FROM sqlite_master WHERE type = 'table' AND name = 'chat_photo_batches'")
    .get() as { sql: string } | undefined;

  if (!row?.sql || row.sql.includes('Napowietrzny')) return;

  db.exec(`
    PRAGMA foreign_keys = OFF;
    ALTER TABLE chat_photo_batches RENAME TO chat_photo_batches_old;
  `);
  db.exec(schema);
  db.exec(`
    INSERT INTO chat_photo_batches (
      id, project_id, source, source_space_name, source_space_display_name,
      source_message_name, message_text, source_create_time, folder_name, folder_path,
      status, review_reason, checklist_node_id, reserve_location, confidence,
      llm_model, llm_raw_response, visual_evidence, created_at, updated_at
    )
    SELECT
      id, project_id, source, source_space_name, source_space_display_name,
      source_message_name, message_text, source_create_time, folder_name, folder_path,
      status, review_reason, checklist_node_id, reserve_location, confidence,
      llm_model, llm_raw_response, visual_evidence, created_at, updated_at
    FROM chat_photo_batches_old;
    DROP TABLE chat_photo_batches_old;
    PRAGMA foreign_keys = ON;
  `);
  db.exec(schema);
}
