-- Additive v1.1.0 migration. Deploy the v1.1.0 Worker first, then run this once.
-- It does not change or delete participants, sessions, messages or recording data.
CREATE TABLE IF NOT EXISTS participant_consents (
  participant_code TEXT PRIMARY KEY REFERENCES participants(participant_code) ON DELETE CASCADE,
  consent_version TEXT NOT NULL,
  pls_version TEXT NOT NULL,
  accepted_items_json TEXT NOT NULL,
  accepted_ms INTEGER NOT NULL
);
INSERT INTO schema_meta(name,value) VALUES('schema_version','4') ON CONFLICT(name) DO UPDATE SET value='4';
