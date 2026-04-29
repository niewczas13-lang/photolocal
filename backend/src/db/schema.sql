CREATE TABLE IF NOT EXISTS projects (
  id TEXT PRIMARY KEY,
  name TEXT NOT NULL,
  project_definition TEXT,
  project_type TEXT NOT NULL CHECK (project_type IN ('SI', 'KPO')),
  splitter_topology TEXT NOT NULL CHECK (splitter_topology IN ('SINGLE', 'CASCADE')),
  splitter_count INTEGER NOT NULL DEFAULT 0,
  splitter_topology_source TEXT NOT NULL CHECK (splitter_topology_source IN ('AUTO', 'MANUAL')),
  gpkg_file_name TEXT NOT NULL,
  base_folder TEXT NOT NULL,
  address_count INTEGER NOT NULL DEFAULT 0,
  dac_to_address_cable_count INTEGER NOT NULL DEFAULT 0,
  adss_to_address_cable_count INTEGER NOT NULL DEFAULT 0,
  created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
  updated_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP
);

CREATE TABLE IF NOT EXISTS addresses (
  id TEXT PRIMARY KEY,
  project_id TEXT NOT NULL REFERENCES projects(id) ON DELETE CASCADE,
  city TEXT NOT NULL,
  street TEXT NOT NULL,
  building_no TEXT,
  property_id TEXT,
  parcel_number TEXT,
  distribution_point TEXT,
  lat REAL,
  lng REAL,
  household_count INTEGER NOT NULL DEFAULT 0,
  business_unit_count INTEGER NOT NULL DEFAULT 0
);

CREATE TABLE IF NOT EXISTS checklist_nodes (
  id TEXT PRIMARY KEY,
  project_id TEXT NOT NULL REFERENCES projects(id) ON DELETE CASCADE,
  parent_id TEXT REFERENCES checklist_nodes(id) ON DELETE CASCADE,
  name TEXT NOT NULL,
  path TEXT NOT NULL,
  node_type TEXT NOT NULL CHECK (node_type IN ('STATIC', 'DISTRIBUTION', 'ADDRESS', 'CABLE_RESERVE')),
  address_id TEXT REFERENCES addresses(id),
  sort_order INTEGER NOT NULL DEFAULT 0,
  min_photos INTEGER NOT NULL DEFAULT 0,
  accepts_photos INTEGER NOT NULL DEFAULT 1,
  status TEXT NOT NULL DEFAULT 'OPEN' CHECK (status IN ('OPEN', 'COMPLETE', 'NOT_APPLICABLE')),
  not_applicable_reason TEXT,
  created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
  updated_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
  UNIQUE(project_id, path)
);

CREATE TABLE IF NOT EXISTS photos (
  id TEXT PRIMARY KEY,
  project_id TEXT NOT NULL REFERENCES projects(id) ON DELETE CASCADE,
  checklist_node_id TEXT NOT NULL REFERENCES checklist_nodes(id) ON DELETE CASCADE,
  source_file_name TEXT NOT NULL,
  stored_file_name TEXT NOT NULL,
  storage_path TEXT NOT NULL,
  thumbnail_path TEXT,
  mime_type TEXT NOT NULL DEFAULT 'image/jpeg',
  file_size INTEGER,
  lat REAL,
  lng REAL,
  captured_at TEXT,
  uploaded_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
  reserve_location TEXT,
  processing_status TEXT NOT NULL DEFAULT 'READY',
  error_message TEXT
);

CREATE TABLE IF NOT EXISTS chat_photo_batches (
  id TEXT PRIMARY KEY,
  project_id TEXT NOT NULL REFERENCES projects(id) ON DELETE CASCADE,
  source TEXT NOT NULL CHECK (source IN ('google-chat')),
  source_space_name TEXT NOT NULL,
  source_space_display_name TEXT NOT NULL,
  source_message_name TEXT NOT NULL,
  message_text TEXT NOT NULL DEFAULT '',
  source_create_time TEXT NOT NULL DEFAULT '',
  folder_name TEXT NOT NULL,
  folder_path TEXT NOT NULL,
  status TEXT NOT NULL CHECK (status IN (
    'WAITING_FOR_CLASSIFICATION',
    'PENDING_REVIEW',
    'READY_FOR_IMPORT',
    'IMPORTED',
    'REJECTED'
  )),
  review_reason TEXT,
  checklist_node_id TEXT REFERENCES checklist_nodes(id) ON DELETE SET NULL,
  reserve_location TEXT CHECK (reserve_location IN ('Doziemny', 'W studni') OR reserve_location IS NULL),
  confidence REAL,
  llm_model TEXT,
  llm_raw_response TEXT,
  visual_evidence TEXT NOT NULL DEFAULT '[]',
  created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
  updated_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
  UNIQUE(project_id, source_message_name, folder_path)
);

CREATE TABLE IF NOT EXISTS chat_photo_files (
  id TEXT PRIMARY KEY,
  batch_id TEXT NOT NULL REFERENCES chat_photo_batches(id) ON DELETE CASCADE,
  file_name TEXT NOT NULL,
  content_name TEXT NOT NULL,
  content_type TEXT NOT NULL,
  source_path TEXT NOT NULL,
  photo_id TEXT REFERENCES photos(id) ON DELETE SET NULL,
  created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
  UNIQUE(batch_id, file_name)
);

CREATE TABLE IF NOT EXISTS chat_photo_file_imports (
  id TEXT PRIMARY KEY,
  chat_photo_file_id TEXT NOT NULL REFERENCES chat_photo_files(id) ON DELETE CASCADE,
  photo_id TEXT NOT NULL REFERENCES photos(id) ON DELETE CASCADE,
  checklist_node_id TEXT NOT NULL REFERENCES checklist_nodes(id) ON DELETE CASCADE,
  created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
  UNIQUE(chat_photo_file_id, photo_id)
);

CREATE INDEX IF NOT EXISTS idx_addresses_project_id ON addresses(project_id);
CREATE INDEX IF NOT EXISTS idx_checklist_nodes_project_id ON checklist_nodes(project_id);
CREATE INDEX IF NOT EXISTS idx_checklist_nodes_parent_id ON checklist_nodes(parent_id);
CREATE INDEX IF NOT EXISTS idx_photos_project_id ON photos(project_id);
CREATE INDEX IF NOT EXISTS idx_photos_checklist_node_id ON photos(checklist_node_id);
CREATE INDEX IF NOT EXISTS idx_chat_photo_batches_project_id ON chat_photo_batches(project_id);
CREATE INDEX IF NOT EXISTS idx_chat_photo_batches_status ON chat_photo_batches(status);
CREATE INDEX IF NOT EXISTS idx_chat_photo_files_batch_id ON chat_photo_files(batch_id);
CREATE INDEX IF NOT EXISTS idx_chat_photo_file_imports_file_id ON chat_photo_file_imports(chat_photo_file_id);
CREATE INDEX IF NOT EXISTS idx_chat_photo_file_imports_photo_id ON chat_photo_file_imports(photo_id);
