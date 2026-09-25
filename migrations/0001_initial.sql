CREATE TABLE ai_settings (
  id INTEGER PRIMARY KEY CHECK (id = 1),
  endpoint TEXT NOT NULL,
  model TEXT NOT NULL,
  key_ciphertext TEXT NOT NULL,
  key_iv TEXT NOT NULL,
  updated_at TEXT NOT NULL DEFAULT (datetime('now'))
);
CREATE TABLE proposals (
  id TEXT PRIMARY KEY,
  user_id INTEGER NOT NULL,
  actions_json TEXT NOT NULL,
  status TEXT NOT NULL CHECK (status IN ('PENDING','RUNNING','DONE','FAILED')),
  next_index INTEGER NOT NULL DEFAULT 0,
  results_json TEXT NOT NULL DEFAULT '[]',
  expires_at TEXT NOT NULL,
  created_at TEXT NOT NULL DEFAULT (datetime('now'))
);
CREATE INDEX idx_proposals_expiry ON proposals(expires_at);
CREATE TABLE model_call_cooldowns (
  user_id INTEGER PRIMARY KEY,
  next_allowed_at INTEGER NOT NULL
);
