-- Additive v0.3.0 migration. Deploy the new Worker first (it accepts schema 2 and 3).
-- Does not delete sessions, messages, AI configuration or earlier data.
CREATE TABLE IF NOT EXISTS recording_pages (
  session_id TEXT NOT NULL REFERENCES sessions(id),
  page_id TEXT NOT NULL,
  time_origin_ms REAL NOT NULL,
  started_wall_ms REAL NOT NULL,
  declared_seq INTEGER NOT NULL DEFAULT 0,
  closed INTEGER NOT NULL DEFAULT 0 CHECK(closed IN (0,1)),
  created_ms INTEGER NOT NULL,
  updated_ms INTEGER NOT NULL,
  PRIMARY KEY(session_id,page_id)
);
CREATE TABLE IF NOT EXISTS drafts (
  session_id TEXT NOT NULL REFERENCES sessions(id),
  draft_id TEXT NOT NULL,
  client_message_id TEXT NOT NULL,
  revision INTEGER NOT NULL,
  text TEXT NOT NULL,
  state TEXT NOT NULL CHECK(state IN ('editing','pending','sent','unsent')),
  raw_at_send TEXT,
  last_page_id TEXT NOT NULL,
  last_seq INTEGER NOT NULL,
  message_id INTEGER REFERENCES messages(id),
  created_ms INTEGER NOT NULL,
  updated_ms INTEGER NOT NULL,
  PRIMARY KEY(session_id,draft_id),
  UNIQUE(session_id,client_message_id)
);
CREATE TABLE IF NOT EXISTS interaction_events (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  session_id TEXT NOT NULL REFERENCES sessions(id),
  page_id TEXT NOT NULL,
  seq INTEGER NOT NULL,
  draft_id TEXT,
  event_type TEXT NOT NULL,
  client_elapsed_ms REAL NOT NULL,
  client_wall_ms REAL NOT NULL,
  payload_json TEXT NOT NULL,
  received_ms INTEGER NOT NULL,
  received_after_end INTEGER NOT NULL CHECK(received_after_end IN (0,1)),
  UNIQUE(session_id,page_id,seq),
  FOREIGN KEY(session_id,page_id) REFERENCES recording_pages(session_id,page_id),
  FOREIGN KEY(session_id,draft_id) REFERENCES drafts(session_id,draft_id)
);
CREATE INDEX IF NOT EXISTS events_draft ON interaction_events(session_id,draft_id,page_id,seq);
CREATE INDEX IF NOT EXISTS drafts_message ON drafts(message_id);
INSERT INTO schema_meta(name,value) VALUES('schema_version','3') ON CONFLICT(name) DO UPDATE SET value='3';
