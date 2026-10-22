-- SLP v0.1.0. Run in a NEW D1 database dedicated to SLP.
-- This script is additive and does not delete records.
CREATE TABLE IF NOT EXISTS schema_meta (
  name TEXT PRIMARY KEY,
  value TEXT NOT NULL
);
INSERT OR IGNORE INTO schema_meta(name, value) VALUES ('schema_version', '1');

CREATE TABLE IF NOT EXISTS participants (
  participant_code TEXT PRIMARY KEY,
  access_hash TEXT NOT NULL,
  created_ms INTEGER NOT NULL
);

CREATE TABLE IF NOT EXISTS sessions (
  id TEXT PRIMARY KEY,
  participant_code TEXT NOT NULL REFERENCES participants(participant_code),
  task_number INTEGER NOT NULL CHECK(task_number IN (1, 2)),
  condition TEXT NOT NULL CHECK(condition IN ('human', 'ai')),
  scenario_code TEXT NOT NULL CHECK(scenario_code IN ('A', 'B')),
  participant_prompt TEXT NOT NULL,
  interlocutor_prompt TEXT NOT NULL,
  status TEXT NOT NULL DEFAULT 'ready' CHECK(status IN ('ready', 'active', 'ended')),
  created_ms INTEGER NOT NULL,
  started_ms INTEGER,
  ended_ms INTEGER,
  end_reason TEXT,
  UNIQUE(participant_code, task_number)
);

CREATE TABLE IF NOT EXISTS messages (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  session_id TEXT NOT NULL REFERENCES sessions(id),
  sender TEXT NOT NULL CHECK(sender IN ('participant', 'interlocutor')),
  client_message_id TEXT NOT NULL,
  text TEXT NOT NULL,
  server_received_ms INTEGER NOT NULL,
  client_elapsed_ms REAL,
  UNIQUE(session_id, sender, client_message_id)
);
CREATE INDEX IF NOT EXISTS messages_session_id ON messages(session_id, id);
CREATE INDEX IF NOT EXISTS sessions_participant ON sessions(participant_code, task_number);
-- Additive migration for 0.1.0 -> 0.2.0. Does not delete existing sessions/messages.
CREATE TABLE IF NOT EXISTS app_settings (
  name TEXT PRIMARY KEY,
  value TEXT NOT NULL
);
CREATE TABLE IF NOT EXISTS ai_session_configs (
  session_id TEXT PRIMARY KEY REFERENCES sessions(id),
  config_json TEXT NOT NULL,
  created_ms INTEGER NOT NULL
);
CREATE TABLE IF NOT EXISTS ai_jobs (
  id TEXT PRIMARY KEY,
  session_id TEXT NOT NULL REFERENCES sessions(id),
  trigger_message_id INTEGER NOT NULL UNIQUE REFERENCES messages(id),
  state TEXT NOT NULL CHECK(state IN ('queued','generating','ready','delivered','error','cancelled','superseded')),
  lock_token TEXT,
  lease_until_ms INTEGER,
  created_ms INTEGER NOT NULL,
  generation_started_ms INTEGER,
  generation_completed_ms INTEGER,
  ready_after_ms INTEGER,
  target_latency_ms REAL,
  reply_text TEXT,
  requested_model TEXT,
  actual_model TEXT,
  response_id TEXT,
  usage_json TEXT,
  config_json TEXT,
  delivered_message_id INTEGER REFERENCES messages(id),
  delivered_ms INTEGER,
  error_code TEXT,
  attempt INTEGER NOT NULL DEFAULT 0
);
CREATE INDEX IF NOT EXISTS ai_jobs_session ON ai_jobs(session_id, state, trigger_message_id);
CREATE UNIQUE INDEX IF NOT EXISTS ai_one_running ON ai_jobs(session_id) WHERE state='generating';
UPDATE schema_meta SET value='2' WHERE name='schema_version';

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
