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
