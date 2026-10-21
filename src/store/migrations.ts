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
  {
    version: 9,
    name: "ssh-hosts",
    sql: `
CREATE TABLE ssh_hosts (
  id TEXT PRIMARY KEY,
  name TEXT NOT NULL UNIQUE,
  address TEXT NOT NULL,
  port INTEGER NOT NULL DEFAULT 22 CHECK (port BETWEEN 1 AND 65535),
  username TEXT NOT NULL,
  host_key TEXT,
  host_key_type TEXT,
  host_key_bits INTEGER,
  host_key_fingerprint TEXT,
  host_key_pinned_at TEXT,
  pending_host_key TEXT,
  pending_host_key_type TEXT,
  pending_host_key_fingerprint TEXT,
  pending_host_key_at TEXT,
  host_key_mismatch_at TEXT,
  require_approval INTEGER NOT NULL DEFAULT 1 CHECK (require_approval IN (0, 1)),
  approval_idle_sec INTEGER NOT NULL DEFAULT 1800
    CHECK (approval_idle_sec BETWEEN 300 AND 7200),
  remote_root TEXT,
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL
);

CREATE TABLE ssh_host_credentials (
  host_id TEXT PRIMARY KEY REFERENCES ssh_hosts(id) ON DELETE CASCADE,
  cipher TEXT NOT NULL,
  nonce TEXT NOT NULL,
  public_key TEXT NOT NULL,
  public_key_fingerprint TEXT NOT NULL,
  key_type TEXT NOT NULL,
  bits INTEGER,
  validated_at TEXT NOT NULL,
  updated_at TEXT NOT NULL,
  updated_by TEXT
);

CREATE TABLE app_ssh_hosts (
  app_id TEXT NOT NULL REFERENCES apps(id) ON DELETE CASCADE,
  host_id TEXT NOT NULL REFERENCES ssh_hosts(id) ON DELETE CASCADE,
  created_at TEXT NOT NULL,
  created_by TEXT,
  PRIMARY KEY (app_id, host_id)
);
CREATE INDEX app_ssh_hosts_host ON app_ssh_hosts(host_id);

CREATE TABLE ssh_approvals (
  id TEXT PRIMARY KEY,
  app_id TEXT NOT NULL REFERENCES apps(id) ON DELETE CASCADE,
  host_id TEXT NOT NULL REFERENCES ssh_hosts(id) ON DELETE CASCADE,
  action TEXT NOT NULL CHECK (action IN ('exec', 'upload', 'download')),
  command_hash TEXT NOT NULL,
  command_preview TEXT NOT NULL,
  command_bytes INTEGER NOT NULL,
  status TEXT NOT NULL
    CHECK (status IN ('pending', 'approved', 'rejected', 'expired', 'superseded')),
  requested_at TEXT NOT NULL,
  expires_at TEXT NOT NULL,
  decided_at TEXT,
  decided_by TEXT,
  grant_id TEXT
);
CREATE UNIQUE INDEX ssh_approvals_pending_unique
  ON ssh_approvals(app_id, host_id, action, command_hash)
  WHERE status = 'pending';
CREATE INDEX ssh_approvals_pending ON ssh_approvals(app_id, status, requested_at);
CREATE INDEX ssh_approvals_expiry ON ssh_approvals(status, expires_at);

CREATE TABLE ssh_grants (
  id TEXT PRIMARY KEY,
  app_id TEXT NOT NULL REFERENCES apps(id) ON DELETE CASCADE,
  host_id TEXT NOT NULL REFERENCES ssh_hosts(id) ON DELETE CASCADE,
  approval_id TEXT NOT NULL REFERENCES ssh_approvals(id) ON DELETE CASCADE,
  granted_by TEXT NOT NULL,
  granted_at TEXT NOT NULL,
  last_used_at TEXT NOT NULL,
  idle_expires_at TEXT NOT NULL,
  absolute_expires_at TEXT NOT NULL,
  revoked_at TEXT
);
CREATE UNIQUE INDEX ssh_grants_approval ON ssh_grants(approval_id);
CREATE INDEX ssh_grants_active ON ssh_grants(app_id, host_id, revoked_at, idle_expires_at);

CREATE TABLE ssh_audit (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  app_id TEXT NOT NULL,
  project_id TEXT NOT NULL,
  app_key TEXT NOT NULL,
  host_id TEXT NOT NULL,
  host_name TEXT NOT NULL,
  address TEXT NOT NULL,
  username TEXT NOT NULL,
  action TEXT NOT NULL,
  command_hash TEXT,
  command_preview TEXT,
  presented_fingerprint TEXT,
  detail_json TEXT,
  approval_id TEXT,
  grant_id TEXT,
  started_at TEXT NOT NULL,
  finished_at TEXT,
  exit_code INTEGER,
  error_code TEXT,
  bytes_out INTEGER,
  truncated INTEGER NOT NULL DEFAULT 0 CHECK (truncated IN (0, 1))
);
CREATE INDEX ssh_audit_app_started ON ssh_audit(app_id, started_at DESC, id DESC);
CREATE INDEX ssh_audit_host_started ON ssh_audit(host_id, started_at DESC, id DESC);
`,
  },
];
