export interface Migration {
  version: number;
  name: string;
  sql: string;
}

export const MIGRATIONS: readonly Migration[] = [
  {
    version: 1,
    name: "initial-schema",
    sql: `
CREATE TABLE projects (
  id TEXT PRIMARY KEY,
  name TEXT NOT NULL,
  base_branch TEXT NOT NULL,
  root_path TEXT NOT NULL,
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL
);

CREATE TABLE apps (
  id TEXT PRIMARY KEY,
  project_id TEXT NOT NULL REFERENCES projects(id) ON DELETE CASCADE,
  app_key TEXT NOT NULL,
  path TEXT NOT NULL,
  kind TEXT,
  contract TEXT NOT NULL,
  created_at TEXT NOT NULL,
  UNIQUE (project_id, app_key)
);

CREATE TABLE instances (
  id TEXT PRIMARY KEY,
  app_id TEXT NOT NULL UNIQUE REFERENCES apps(id) ON DELETE CASCADE,
  endpoint TEXT,
  pid INTEGER,
  boot_id TEXT,
  state TEXT NOT NULL,
  started_at TEXT,
  heartbeat_at TEXT,
  updated_at TEXT NOT NULL
);

CREATE TABLE tasks (
  id TEXT PRIMARY KEY,
  app_id TEXT NOT NULL REFERENCES apps(id) ON DELETE CASCADE,
  handoff_id TEXT,
  session_id TEXT,
  state TEXT NOT NULL,
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL
);
CREATE UNIQUE INDEX tasks_active_lane ON tasks(app_id) WHERE state IN ('dispatched', 'running');

CREATE TABLE handoffs (
  id TEXT PRIMARY KEY,
  project_id TEXT NOT NULL REFERENCES projects(id) ON DELETE CASCADE,
  from_app_id TEXT NOT NULL REFERENCES apps(id),
  to_app_id TEXT NOT NULL REFERENCES apps(id),
  state TEXT NOT NULL,
  summary TEXT NOT NULL,
  spec TEXT NOT NULL,
  approval_id TEXT,
  idempotency_key TEXT NOT NULL UNIQUE,
  attempts INTEGER NOT NULL DEFAULT 0,
  next_attempt_at TEXT,
  expires_at TEXT,
  target_task_id TEXT REFERENCES tasks(id),
  result TEXT,
  error TEXT,
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL
);

CREATE TABLE handoff_messages (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  handoff_id TEXT NOT NULL REFERENCES handoffs(id) ON DELETE CASCADE,
  author_principal TEXT,
  kind TEXT NOT NULL,
  body TEXT NOT NULL,
  created_at TEXT NOT NULL
);

CREATE TABLE principals (
  id TEXT PRIMARY KEY,
  kind TEXT NOT NULL,
  name TEXT NOT NULL,
  secret_hash TEXT,
  created_at TEXT NOT NULL
);

CREATE TABLE approvals (
  id TEXT PRIMARY KEY,
  handoff_id TEXT NOT NULL REFERENCES handoffs(id) ON DELETE CASCADE,
  state TEXT NOT NULL,
  requested_at TEXT NOT NULL,
  decided_at TEXT,
  decided_by TEXT REFERENCES principals(id),
  reason TEXT
);

CREATE TABLE events (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  scope TEXT NOT NULL,
  type TEXT NOT NULL,
  payload TEXT NOT NULL,
  created_at TEXT NOT NULL
);
`,
  },
  {
    version: 2,
    name: "secrets",
    sql: `
CREATE TABLE secrets (
  host TEXT PRIMARY KEY,
  username TEXT NOT NULL,
  cipher TEXT NOT NULL,
  nonce TEXT NOT NULL,
  created_at TEXT NOT NULL
);
`,
  },
  {
    version: 3,
    name: "settings",
    sql: `
CREATE TABLE settings (
  scope TEXT NOT NULL CHECK (scope IN ('global', 'project', 'app')),
  project_id TEXT NOT NULL DEFAULT '',
  app_key TEXT NOT NULL DEFAULT '',
  key TEXT NOT NULL CHECK (length(key) > 0),
  value_json TEXT NOT NULL CHECK (json_valid(value_json)),
  updated_at TEXT NOT NULL,
  updated_by TEXT,
  PRIMARY KEY (scope, project_id, app_key, key),
  CHECK (
    (scope = 'global' AND project_id = '' AND app_key = '') OR
    (scope = 'project' AND project_id <> '' AND app_key = '') OR
    (scope = 'app' AND project_id <> '' AND app_key <> '')
  )
);

CREATE TABLE provider_keys (
  scope TEXT NOT NULL CHECK (scope IN ('global', 'project', 'app')),
  project_id TEXT NOT NULL DEFAULT '',
  app_key TEXT NOT NULL DEFAULT '',
  provider TEXT NOT NULL CHECK (length(provider) > 0),
  cipher TEXT,
  nonce TEXT,
  cleared INTEGER NOT NULL DEFAULT 0 CHECK (cleared IN (0, 1)),
  updated_at TEXT NOT NULL,
  updated_by TEXT,
  PRIMARY KEY (scope, project_id, app_key, provider),
  CHECK (
    (scope = 'global' AND project_id = '' AND app_key = '') OR
    (scope = 'project' AND project_id <> '' AND app_key = '') OR
    (scope = 'app' AND project_id <> '' AND app_key <> '')
  ),
  CHECK (
    (cleared = 0 AND cipher IS NOT NULL AND nonce IS NOT NULL) OR
    (cleared = 1 AND cipher IS NULL AND nonce IS NULL)
  )
);
`,
  },
  {
    version: 4,
    name: "agent-runtime",
    sql: `
CREATE TABLE agent_tokens (
  id TEXT PRIMARY KEY,
  app_id TEXT NOT NULL REFERENCES apps(id) ON DELETE CASCADE,
  token_hash TEXT NOT NULL UNIQUE,
  created_at TEXT NOT NULL,
  revoked_at TEXT
);
CREATE INDEX agent_tokens_app_id ON agent_tokens(app_id);

ALTER TABLE instances ADD COLUMN spec_hash TEXT;
ALTER TABLE instances ADD COLUMN runtime_state TEXT;
`,
  },
  {
    version: 5,
    name: "runner-containers",
    sql: `
ALTER TABLE instances ADD COLUMN container_id TEXT;
ALTER TABLE instances ADD COLUMN container_name TEXT;
`,
  },
  {
    version: 6,
    name: "app-images",
    sql: `
ALTER TABLE apps ADD COLUMN image_ref TEXT;
ALTER TABLE apps ADD COLUMN image_status TEXT NOT NULL DEFAULT 'missing'
  CHECK (image_status IN ('missing', 'building', 'ready', 'stale', 'error'));
ALTER TABLE apps ADD COLUMN image_hash TEXT;
ALTER TABLE apps ADD COLUMN image_base_digest TEXT;
ALTER TABLE apps ADD COLUMN image_built_at TEXT;
ALTER TABLE apps ADD COLUMN image_error TEXT;
`,
  },
  {
    version: 7,
    name: "app-image-versions",
    sql: `
CREATE TABLE app_image_versions (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  app_id TEXT NOT NULL REFERENCES apps(id) ON DELETE CASCADE,
  image_ref TEXT NOT NULL,
  image_id TEXT,
  spec_hash TEXT,
  base_digest TEXT,
  built_at TEXT,
  created_at TEXT NOT NULL,
  UNIQUE (app_id, image_ref)
);
CREATE INDEX app_image_versions_app_created ON app_image_versions(app_id, created_at DESC, id DESC);

ALTER TABLE instances ADD COLUMN image_ref TEXT;
`,
  },
];
