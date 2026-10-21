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
