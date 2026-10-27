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
    version: 8,
    name: "git-credentials",
    sql: `
CREATE TABLE setting_secrets (
  scope TEXT NOT NULL CHECK (scope IN ('global', 'project', 'app')),
  project_id TEXT NOT NULL DEFAULT '',
  app_key TEXT NOT NULL DEFAULT '',
  key TEXT NOT NULL CHECK (length(key) > 0),
  cipher TEXT,
  nonce TEXT,
  meta_json TEXT NOT NULL CHECK (json_valid(meta_json)),
  cleared INTEGER NOT NULL DEFAULT 0 CHECK (cleared IN (0, 1)),
  updated_at TEXT NOT NULL,
  updated_by TEXT,
  PRIMARY KEY (scope, project_id, app_key, key),
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

DROP TABLE IF EXISTS secrets;
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
  {
    version: 10,
    name: "applied-runtime-state",
    sql: `
ALTER TABLE instances ADD COLUMN applied_settings_hash TEXT;
ALTER TABLE instances ADD COLUMN applied_profile INTEGER;
`,
  },
  {
    version: 11,
    name: "deletion-markers",
    sql: `
ALTER TABLE apps ADD COLUMN deleting INTEGER NOT NULL DEFAULT 0 CHECK (deleting IN (0, 1));
ALTER TABLE projects ADD COLUMN deleting INTEGER NOT NULL DEFAULT 0 CHECK (deleting IN (0, 1));
`,
  },
  {
    version: 12,
    name: "skills",
    sql: `
CREATE TABLE skills (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  scope TEXT NOT NULL CHECK (scope IN ('global', 'project', 'app')),
  project_id TEXT NOT NULL DEFAULT '',
  app_key TEXT NOT NULL DEFAULT '',
  name TEXT NOT NULL CHECK (
    length(name) BETWEEN 1 AND 64
    AND name GLOB '[a-z0-9]*'
    AND name NOT GLOB '*[^a-z0-9-]*'
    AND name NOT GLOB '*-'
    AND name NOT GLOB '*--*'
  ),
  description TEXT NOT NULL CHECK (length(description) BETWEEN 1 AND 1024),
  content TEXT NOT NULL CHECK (length(content) BETWEEN 1 AND 48000),
  enabled INTEGER NOT NULL DEFAULT 1 CHECK (enabled IN (0, 1)),
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL,
  updated_by TEXT,
  CHECK (
    (scope = 'global' AND project_id = '' AND app_key = '') OR
    (scope = 'project' AND project_id <> '' AND app_key = '') OR
    (scope = 'app' AND project_id <> '' AND app_key <> '')
  ),
  UNIQUE (scope, project_id, app_key, name)
);
CREATE INDEX skills_scope ON skills(project_id, app_key);
`,
  },
  {
    version: 13,
    name: "skill-bundles",
    sql: `
ALTER TABLE skills ADD COLUMN license TEXT
  CHECK (license IS NULL OR (length(license) BETWEEN 1 AND 256));
ALTER TABLE skills ADD COLUMN compatibility TEXT
  CHECK (compatibility IS NULL OR (length(compatibility) BETWEEN 1 AND 512));
ALTER TABLE skills ADD COLUMN metadata_json TEXT NOT NULL DEFAULT '{}'
  CHECK (json_valid(metadata_json) AND length(metadata_json) <= 16384);

CREATE TABLE skill_references (
  skill_id INTEGER NOT NULL REFERENCES skills(id) ON DELETE CASCADE,
  path TEXT NOT NULL CHECK (
    length(path) BETWEEN 15 AND 78
    AND path GLOB 'references/*.md'
    AND path NOT GLOB 'references/*/*'
  ),
  content TEXT NOT NULL CHECK (length(content) BETWEEN 1 AND 48000),
  PRIMARY KEY (skill_id, path)
);
`,
  },
  {
    version: 14,
    name: "session-bound-handoffs",
    sql: `
ALTER TABLE handoffs ADD COLUMN source_session_id TEXT;
ALTER TABLE handoffs ADD COLUMN source_session_title TEXT;
ALTER TABLE handoffs ADD COLUMN target_session_id TEXT;
ALTER TABLE handoffs ADD COLUMN target_session_title TEXT;
ALTER TABLE handoffs ADD COLUMN source_session_deleted_at TEXT;
ALTER TABLE handoffs ADD COLUMN reply_state TEXT NOT NULL DEFAULT 'none'
  CHECK (reply_state IN (
    'none', 'pending', 'awaiting_approval', 'delivered',
    'waiting_operator', 'failed', 'cancelled'
  ));
ALTER TABLE handoffs ADD COLUMN reply_message_id TEXT;
ALTER TABLE handoffs ADD COLUMN reply_delivered_session_id TEXT;
ALTER TABLE handoffs ADD COLUMN reply_delivered_at TEXT;
ALTER TABLE handoffs ADD COLUMN reply_error TEXT;
ALTER TABLE handoffs ADD COLUMN reply_attempts INTEGER NOT NULL DEFAULT 0;
ALTER TABLE handoffs ADD COLUMN dispatch_message_id TEXT;
ALTER TABLE handoffs ADD COLUMN dispatch_started_at TEXT;
ALTER TABLE handoffs ADD COLUMN deadline_at TEXT;
ALTER TABLE handoffs ADD COLUMN outcome TEXT
  CHECK (outcome IS NULL OR outcome IN ('completed', 'blocked', 'failed'));
ALTER TABLE handoffs ADD COLUMN origin TEXT NOT NULL DEFAULT 'agent'
  CHECK (origin IN ('agent', 'operator'));
ALTER TABLE handoffs ADD COLUMN parent_handoff_id TEXT;
ALTER TABLE handoffs ADD COLUMN root_handoff_id TEXT;
ALTER TABLE handoffs ADD COLUMN depth INTEGER NOT NULL DEFAULT 0
  CHECK (depth >= 0);
ALTER TABLE handoffs ADD COLUMN policy_dispatch_mode TEXT NOT NULL DEFAULT 'auto'
  CHECK (policy_dispatch_mode IN ('auto', 'approve', 'deny'));
ALTER TABLE handoffs ADD COLUMN policy_reply_mode TEXT NOT NULL DEFAULT 'auto'
  CHECK (policy_reply_mode IN ('auto', 'approve'));
ALTER TABLE handoffs ADD COLUMN operator_note TEXT;
ALTER TABLE handoffs ADD COLUMN delivered_via TEXT;

ALTER TABLE approvals ADD COLUMN kind TEXT NOT NULL DEFAULT 'dispatch'
  CHECK (kind IN ('dispatch', 'reply'));
CREATE INDEX approvals_handoff_kind ON approvals(handoff_id, kind, state);

CREATE TABLE handoff_policies (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  project_id TEXT NOT NULL REFERENCES projects(id) ON DELETE CASCADE,
  from_app_key TEXT NOT NULL DEFAULT '*',
  to_app_key TEXT NOT NULL DEFAULT '*',
  dispatch_mode TEXT NOT NULL CHECK (dispatch_mode IN ('auto', 'approve', 'deny')),
  reply_mode TEXT NOT NULL CHECK (reply_mode IN ('auto', 'approve')),
  updated_at TEXT NOT NULL,
  updated_by TEXT,
  UNIQUE (project_id, from_app_key, to_app_key)
);
CREATE INDEX handoff_policies_project ON handoff_policies(project_id);

CREATE INDEX handoffs_source_session ON handoffs(source_session_id);
CREATE INDEX handoffs_target_session ON handoffs(target_session_id);
CREATE INDEX handoffs_reply_state ON handoffs(reply_state);
CREATE INDEX handoffs_to_app_state ON handoffs(to_app_id, state);
`,
  },
  {
    version: 15,
    name: "chat-drafts-and-pending-sends",
    sql: `
CREATE TABLE message_drafts (
  app_id TEXT NOT NULL REFERENCES apps(id) ON DELETE CASCADE,
  session_id TEXT NOT NULL,
  text TEXT NOT NULL DEFAULT '',
  updated_at TEXT NOT NULL,
  PRIMARY KEY (app_id, session_id)
);

CREATE TABLE session_state (
  app_id TEXT NOT NULL REFERENCES apps(id) ON DELETE CASCADE,
  session_id TEXT NOT NULL,
  has_messages INTEGER NOT NULL DEFAULT 0 CHECK (has_messages IN (0, 1)),
  last_activity_at TEXT NOT NULL,
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL,
  PRIMARY KEY (app_id, session_id)
);
CREATE INDEX session_state_activity
  ON session_state(app_id, has_messages, last_activity_at);

CREATE TABLE pending_sends (
  id TEXT PRIMARY KEY,
  app_id TEXT NOT NULL REFERENCES apps(id) ON DELETE CASCADE,
  session_id TEXT NOT NULL,
  message_id TEXT NOT NULL UNIQUE,
  text TEXT NOT NULL DEFAULT '',
  attachments_json TEXT NOT NULL DEFAULT '[]',
  state TEXT NOT NULL CHECK (state IN ('sending', 'unknown', 'failed')),
  error_code TEXT,
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL
);
CREATE INDEX pending_sends_session_state
  ON pending_sends(app_id, session_id, state);
`,
  },
  {
    version: 16,
    name: "chat-attachments-and-deliveries",
    sql: `
CREATE TABLE app_attachments (
  id TEXT PRIMARY KEY,
  app_id TEXT NOT NULL REFERENCES apps(id) ON DELETE CASCADE,
  session_id TEXT NOT NULL,
  original_name TEXT NOT NULL CHECK (length(original_name) > 0),
  stored_name TEXT,
  rel_path TEXT,
  temp_rel_path TEXT,
  mime TEXT,
  size INTEGER CHECK (size IS NULL OR size >= 0),
  declared_size INTEGER CHECK (declared_size IS NULL OR declared_size >= 0),
  kind TEXT CHECK (kind IS NULL OR kind IN ('image', 'video', 'pdf', 'file')),
  mode TEXT NOT NULL DEFAULT 'auto' CHECK (mode IN ('auto', 'inline', 'file')),
  state TEXT NOT NULL CHECK (state IN ('uploading', 'available', 'missing')),
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL
);
CREATE UNIQUE INDEX app_attachments_rel_path ON app_attachments(rel_path);
CREATE UNIQUE INDEX app_attachments_temp_rel_path
  ON app_attachments(app_id, temp_rel_path)
  WHERE temp_rel_path IS NOT NULL;
CREATE INDEX app_attachments_app_session ON app_attachments(app_id, session_id);
CREATE INDEX app_attachments_app_state ON app_attachments(app_id, state);

CREATE TABLE attachment_deliveries (
  id TEXT PRIMARY KEY,
  attachment_id TEXT NOT NULL REFERENCES app_attachments(id) ON DELETE CASCADE,
  app_id TEXT NOT NULL REFERENCES apps(id) ON DELETE CASCADE,
  session_id TEXT NOT NULL,
  part_id TEXT,
  message_id TEXT NOT NULL,
  state TEXT NOT NULL CHECK (state IN ('sending', 'sent', 'unknown', 'failed')),
  error_code TEXT,
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL
);
CREATE UNIQUE INDEX attachment_deliveries_part_id
  ON attachment_deliveries(app_id, part_id);
CREATE INDEX attachment_deliveries_app_message
  ON attachment_deliveries(app_id, message_id);
CREATE INDEX attachment_deliveries_app_attachment
  ON attachment_deliveries(app_id, attachment_id);
CREATE INDEX attachment_deliveries_session_state
  ON attachment_deliveries(app_id, session_id, state);
`,
  },
  {
    version: 17,
    name: "handoff-message-lookup",
    sql: `
CREATE INDEX handoffs_dispatch_message ON handoffs(dispatch_message_id)
  WHERE dispatch_message_id IS NOT NULL;
CREATE INDEX handoffs_reply_message ON handoffs(reply_message_id)
  WHERE reply_message_id IS NOT NULL;
CREATE INDEX handoffs_reply_delivered_session ON handoffs(reply_delivered_session_id)
  WHERE reply_delivered_session_id IS NOT NULL;
`,
  },
  {
    version: 18,
    name: "agent-image-validity",
    sql: `
ALTER TABLE apps ADD COLUMN build_configured INTEGER NOT NULL DEFAULT 0
  CHECK (build_configured IN (0, 1));
ALTER TABLE apps ADD COLUMN image_base_ref TEXT;
ALTER TABLE apps ADD COLUMN image_base_kind TEXT
  CHECK (image_base_kind IS NULL OR image_base_kind IN ('default', 'base', 'explicit', 'unknown'));
ALTER TABLE apps ADD COLUMN image_hash_version INTEGER NOT NULL DEFAULT 1
  CHECK (image_hash_version >= 1);
ALTER TABLE apps ADD COLUMN image_build_id TEXT;
ALTER TABLE apps ADD COLUMN image_build_ref TEXT;
ALTER TABLE apps ADD COLUMN image_build_started_at TEXT;
ALTER TABLE apps ADD COLUMN image_build_rejected_ref TEXT;

ALTER TABLE app_image_versions ADD COLUMN base_ref TEXT;
ALTER TABLE app_image_versions ADD COLUMN base_kind TEXT
  CHECK (base_kind IS NULL OR base_kind IN ('default', 'base', 'explicit', 'unknown'));
ALTER TABLE app_image_versions ADD COLUMN hash_version INTEGER NOT NULL DEFAULT 1
  CHECK (hash_version >= 1);

ALTER TABLE instances ADD COLUMN applied_image_id TEXT;
`,
  },
  {
    version: 19,
    name: "custom-model-providers",
    sql: `
CREATE TABLE model_providers (
  id TEXT PRIMARY KEY,
  name TEXT NOT NULL,
  npm TEXT NOT NULL CHECK (npm = '@ai-sdk/openai-compatible'),
  base_url TEXT NOT NULL,
  models_json TEXT NOT NULL CHECK (json_valid(models_json)),
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL,
  CHECK (length(id) BETWEEN 1 AND 128),
  CHECK (length(name) BETWEEN 1 AND 128),
  CHECK (length(base_url) BETWEEN 1 AND 2048)
);
`,
  },
  {
    version: 20,
    name: "agent-process-protection",
    sql: `
ALTER TABLE instances ADD COLUMN applied_rule_hash TEXT;
ALTER TABLE instances ADD COLUMN runtime_started_at TEXT;
ALTER TABLE instances ADD COLUMN runtime_restart_count INTEGER;
ALTER TABLE instances ADD COLUMN last_exit_code INTEGER;
ALTER TABLE instances ADD COLUMN last_oom_killed INTEGER CHECK (last_oom_killed IN (0, 1));
ALTER TABLE instances ADD COLUMN last_stop_reason TEXT;
ALTER TABLE instances ADD COLUMN last_stop_at TEXT;

CREATE TABLE session_resume (
  app_id TEXT NOT NULL REFERENCES apps(id) ON DELETE CASCADE,
  session_id TEXT NOT NULL,
  parent_session_id TEXT,
  observed_status TEXT NOT NULL CHECK (observed_status IN ('busy', 'retry')),
  observed_at TEXT NOT NULL,
  last_busy_seen_at TEXT NOT NULL,
  interrupted_at TEXT,
  interruption_epoch TEXT,
  interruption_key TEXT,
  reason TEXT,
  runtime_started_at TEXT,
  runtime_restart_count INTEGER,
  resume_state TEXT NOT NULL DEFAULT 'observing'
    CHECK (resume_state IN ('observing','resuming','resumed','completed','failed','ambiguous','superseded','deferred','skipped_stopped','skipped_stale','skipped_missing')),
  defer_reason TEXT,
  dispatch_state TEXT NOT NULL DEFAULT 'none'
    CHECK (dispatch_state IN ('none','prepared','sent','ambiguous','not_sent','failed')),
  auto_dispatch_retries INTEGER NOT NULL DEFAULT 0,
  auto_attempts INTEGER NOT NULL DEFAULT 0,
  last_attempt_at TEXT,
  resume_message_id TEXT,
  last_error TEXT,
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL,
  PRIMARY KEY (app_id, session_id)
);
CREATE INDEX session_resume_due
  ON session_resume(resume_state, last_busy_seen_at);

CREATE TABLE session_notices (
  id TEXT PRIMARY KEY,
  app_id TEXT NOT NULL REFERENCES apps(id) ON DELETE CASCADE,
  session_id TEXT NOT NULL,
  parent_session_id TEXT,
  dedupe_key TEXT NOT NULL,
  kind TEXT NOT NULL CHECK (kind IN ('agent_stopped','subagent_interrupted','resume_started','resume_failed','resume_completed','resume_unavailable')),
  reason TEXT,
  payload_json TEXT NOT NULL CHECK (json_valid(payload_json) AND length(payload_json) <= 4096),
  created_at TEXT NOT NULL,
  UNIQUE (app_id, session_id, dedupe_key)
);
CREATE INDEX session_notices_page
  ON session_notices(app_id, session_id, created_at DESC, id);

CREATE TABLE session_notice_dedupe (
  app_id TEXT NOT NULL REFERENCES apps(id) ON DELETE CASCADE,
  session_id TEXT NOT NULL,
  dedupe_key TEXT NOT NULL,
  created_at TEXT NOT NULL,
  PRIMARY KEY (app_id, session_id, dedupe_key)
);
`,
  },
];
