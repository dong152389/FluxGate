PRAGMA foreign_keys = OFF;

CREATE TABLE sources_new (
  id TEXT PRIMARY KEY,
  user_id TEXT NOT NULL,
  name TEXT NOT NULL,
  v2ray_url_encrypted TEXT,
  clash_url_encrypted TEXT,
  enabled INTEGER NOT NULL DEFAULT 1,
  priority INTEGER NOT NULL DEFAULT 0,
  notes TEXT,
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL,
  FOREIGN KEY (user_id) REFERENCES users(id) ON DELETE CASCADE
);

INSERT INTO sources_new (
  id,
  user_id,
  name,
  v2ray_url_encrypted,
  clash_url_encrypted,
  enabled,
  priority,
  notes,
  created_at,
  updated_at
)
SELECT
  id,
  user_id,
  name,
  url_encrypted,
  NULL,
  enabled,
  priority,
  notes,
  created_at,
  updated_at
FROM sources;

DROP TABLE sources;
ALTER TABLE sources_new RENAME TO sources;

CREATE INDEX IF NOT EXISTS idx_sources_user_priority ON sources(user_id, priority, name);

PRAGMA foreign_keys = ON;
