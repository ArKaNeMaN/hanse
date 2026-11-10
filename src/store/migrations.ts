export interface Migration {
  version: number;
  name: string;
  sql: string;
  /**
   * Whether the previous coordinator release can still run against this schema (an additive/expand
   * migration). `false` marks a migration that needs the image rollback path (restore a backup).
   */
  backwardCompatible?: boolean;
  /** Whether the migration rewrites existing rows and should not run while the coordinator serves. */
  requiresExclusive?: boolean;
  /** Rough offline/online application time used by `hanse migrate --check`. */
  estimatedMs?: number;
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
    backwardCompatible: false,
    requiresExclusive: true,
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
  {
    version: 21,
    name: "agent-media",
    sql: `
CREATE TABLE agent_media (
  id TEXT PRIMARY KEY,
  app_id TEXT NOT NULL REFERENCES apps(id) ON DELETE CASCADE,
  session_id TEXT,
  message_id TEXT,
  part_id TEXT,
  original_name TEXT NOT NULL,
  stored_name TEXT NOT NULL,
  rel_path TEXT NOT NULL,
  mime TEXT NOT NULL,
  size INTEGER NOT NULL CHECK (size >= 0),
  caption TEXT,
  state TEXT NOT NULL CHECK (state IN ('staged', 'attached', 'missing')),
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL,
  CHECK (length(id) BETWEEN 1 AND 64),
  CHECK (length(original_name) > 0),
  CHECK (length(mime) > 0),
  CHECK (caption IS NULL OR length(caption) <= 200),
  CHECK (
    state <> 'staged'
    OR (session_id IS NULL AND message_id IS NULL AND part_id IS NULL)
  ),
  CHECK (
    state NOT IN ('attached', 'missing')
    OR (session_id IS NOT NULL AND message_id IS NOT NULL AND part_id IS NOT NULL)
  ),
  UNIQUE (app_id, rel_path)
);
CREATE INDEX agent_media_app_state ON agent_media(app_id, state, created_at);
CREATE INDEX agent_media_app_session ON agent_media(app_id, session_id);
CREATE UNIQUE INDEX agent_media_message_part
  ON agent_media(app_id, message_id, part_id)
  WHERE message_id IS NOT NULL AND part_id IS NOT NULL;
`,
  },
  {
    version: 22,
    name: "handoff-threads",
    sql: `
-- v22: stage-1 handoff threads
ALTER TABLE handoffs ADD COLUMN mode TEXT NOT NULL DEFAULT 'one_shot' CHECK (mode IN ('one_shot','thread'));
ALTER TABLE handoffs ADD COLUMN message_seq INTEGER NOT NULL DEFAULT 0 CHECK (message_seq >= 0);
ALTER TABLE handoffs ADD COLUMN message_count INTEGER NOT NULL DEFAULT 0 CHECK (message_count >= 0);
ALTER TABLE handoffs ADD COLUMN last_message_at TEXT;
ALTER TABLE handoffs ADD COLUMN thread_idle_expires_at TEXT;
ALTER TABLE handoffs ADD COLUMN source_invoking_session_id TEXT;

ALTER TABLE handoff_messages ADD COLUMN seq INTEGER NOT NULL DEFAULT 0;
ALTER TABLE handoff_messages ADD COLUMN author_app_id TEXT REFERENCES apps(id) ON DELETE SET NULL;
ALTER TABLE handoff_messages ADD COLUMN author_side TEXT NOT NULL DEFAULT 'system' CHECK (author_side IN ('source','target','system'));
ALTER TABLE handoff_messages ADD COLUMN state TEXT NOT NULL DEFAULT 'binding' CHECK (state IN ('binding','queued','dispatching','delivered','waiting_operator','cancelled'));
ALTER TABLE handoff_messages ADD COLUMN outcome TEXT CHECK (outcome IS NULL OR outcome IN ('completed','blocked','failed'));
ALTER TABLE handoff_messages ADD COLUMN delivery_session_id TEXT;
ALTER TABLE handoff_messages ADD COLUMN delivery_message_id TEXT;
ALTER TABLE handoff_messages ADD COLUMN delivered_at TEXT;
ALTER TABLE handoff_messages ADD COLUMN claimed_at TEXT;
ALTER TABLE handoff_messages ADD COLUMN client_message_id TEXT CHECK (client_message_id IS NULL OR length(client_message_id) BETWEEN 1 AND 128);
ALTER TABLE handoff_messages ADD COLUMN binding_nonce TEXT CHECK (binding_nonce IS NULL OR length(binding_nonce) BETWEEN 1 AND 64);
ALTER TABLE handoff_messages ADD COLUMN bound_session_id TEXT;
ALTER TABLE handoff_messages ADD COLUMN bound_at TEXT;
ALTER TABLE handoff_messages ADD COLUMN invoking_session_id TEXT;
ALTER TABLE handoff_messages ADD COLUMN reply_to_message_id INTEGER REFERENCES handoff_messages(id) ON DELETE SET NULL CHECK (reply_to_message_id IS NULL OR reply_to_message_id > 0);
ALTER TABLE handoff_messages ADD COLUMN error_code TEXT CHECK (error_code IS NULL OR length(error_code) BETWEEN 1 AND 64);
ALTER TABLE handoff_messages ADD COLUMN updated_at TEXT;

-- Defensive legacy backfill: production table is empty; new rows must set positive seq.
UPDATE handoff_messages SET state = 'delivered';
UPDATE handoff_messages SET seq = (
  SELECT COUNT(*) FROM handoff_messages AS earlier
  WHERE earlier.handoff_id = handoff_messages.handoff_id
    AND (earlier.created_at < handoff_messages.created_at
      OR (earlier.created_at = handoff_messages.created_at AND earlier.id <= handoff_messages.id))
);
UPDATE handoff_messages SET updated_at = created_at WHERE updated_at IS NULL;

CREATE TRIGGER handoff_messages_seq_positive BEFORE INSERT ON handoff_messages
WHEN NEW.seq <= 0 BEGIN SELECT RAISE(ABORT, 'handoff_messages.seq must be positive'); END;
CREATE TRIGGER handoff_messages_seq_immutable BEFORE UPDATE OF seq ON handoff_messages
WHEN NEW.seq <> OLD.seq BEGIN SELECT RAISE(ABORT, 'handoff_messages.seq is immutable'); END;
CREATE TRIGGER handoff_messages_dispatch_requires_session_insert BEFORE INSERT ON handoff_messages
WHEN NEW.state = 'dispatching' AND NEW.delivery_session_id IS NULL
BEGIN SELECT RAISE(ABORT, 'dispatching message requires delivery_session_id'); END;
CREATE TRIGGER handoff_messages_dispatch_requires_session_update
BEFORE UPDATE OF state, delivery_session_id ON handoff_messages
WHEN NEW.state = 'dispatching' AND NEW.delivery_session_id IS NULL
BEGIN SELECT RAISE(ABORT, 'dispatching message requires delivery_session_id'); END;

CREATE TRIGGER handoff_messages_reply_to_valid_insert BEFORE INSERT ON handoff_messages
WHEN NEW.reply_to_message_id IS NOT NULL BEGIN
  SELECT CASE WHEN NOT EXISTS (
    SELECT 1 FROM handoff_messages AS p
    WHERE p.id = NEW.reply_to_message_id AND p.handoff_id = NEW.handoff_id
      AND p.author_side = 'source' AND p.kind IN ('request','message')
      AND p.state IN ('dispatching','delivered')
  ) THEN RAISE(ABORT, 'reply_to must reference a dispatching or delivered source message in the same thread') END;
END;
CREATE TRIGGER handoff_messages_reply_to_valid_update
BEFORE UPDATE OF reply_to_message_id ON handoff_messages
WHEN NEW.reply_to_message_id IS NOT NULL BEGIN
  SELECT CASE WHEN NOT EXISTS (
    SELECT 1 FROM handoff_messages AS p
    WHERE p.id = NEW.reply_to_message_id AND p.handoff_id = NEW.handoff_id
      AND p.author_side = 'source' AND p.kind IN ('request','message')
      AND p.state IN ('dispatching','delivered')
  ) THEN RAISE(ABORT, 'reply_to must reference a dispatching or delivered source message in the same thread') END;
END;

CREATE TRIGGER handoff_messages_body_size_insert BEFORE INSERT ON handoff_messages
WHEN length(CAST(NEW.body AS BLOB)) > 32768
BEGIN SELECT RAISE(ABORT, 'handoff_messages.body exceeds 32768 bytes'); END;
CREATE TRIGGER handoff_messages_body_size_update BEFORE UPDATE OF body ON handoff_messages
WHEN length(CAST(NEW.body AS BLOB)) > 32768
BEGIN SELECT RAISE(ABORT, 'handoff_messages.body exceeds 32768 bytes'); END;

CREATE UNIQUE INDEX handoff_messages_thread_seq ON handoff_messages(handoff_id, seq);
CREATE UNIQUE INDEX handoff_messages_client ON handoff_messages(handoff_id, author_side, client_message_id)
  WHERE client_message_id IS NOT NULL;
CREATE UNIQUE INDEX handoff_messages_reply_once ON handoff_messages(handoff_id, reply_to_message_id)
  WHERE kind = 'reply' AND reply_to_message_id IS NOT NULL AND state <> 'cancelled';
CREATE INDEX handoff_messages_due ON handoff_messages(state, id);
CREATE INDEX handoff_messages_delivery_session ON handoff_messages(delivery_session_id, state);
CREATE UNIQUE INDEX handoff_messages_delivery_message ON handoff_messages(delivery_message_id)
  WHERE delivery_message_id IS NOT NULL;
CREATE UNIQUE INDEX handoff_messages_one_dispatch_per_session
  ON handoff_messages(delivery_session_id)
  WHERE state = 'dispatching' AND delivery_session_id IS NOT NULL;
CREATE INDEX handoff_messages_reply_to ON handoff_messages(reply_to_message_id)
  WHERE reply_to_message_id IS NOT NULL;
CREATE INDEX handoff_messages_author_created ON handoff_messages(author_app_id, created_at);

CREATE UNIQUE INDEX handoffs_active_thread_pair ON handoffs(source_session_id, target_session_id)
  WHERE mode = 'thread' AND state IN ('queued','awaiting_approval','dispatching','in_progress')
    AND source_session_id IS NOT NULL AND target_session_id IS NOT NULL;
CREATE INDEX handoffs_thread_source_app ON handoffs(from_app_id, mode, state) WHERE mode = 'thread';
CREATE INDEX handoffs_thread_target_app ON handoffs(to_app_id, mode, state) WHERE mode = 'thread';
CREATE INDEX handoffs_thread_idle ON handoffs(state, thread_idle_expires_at)
  WHERE mode = 'thread' AND state = 'in_progress';
CREATE INDEX handoffs_thread_gc ON handoffs(mode, updated_at)
  WHERE mode = 'thread' AND state IN ('rejected','failed','expired','cancelled');
CREATE INDEX handoffs_deadline ON handoffs(deadline_at) WHERE deadline_at IS NOT NULL;
CREATE INDEX events_scope_type_created ON events(scope, type, created_at);
`,
  },
  {
    version: 23,
    name: "agent-process-status",
    sql: `
-- v23: agent process lifecycle current state and durable history
ALTER TABLE instances ADD COLUMN process_attempt_id TEXT;
ALTER TABLE instances ADD COLUMN process_phase TEXT;
ALTER TABLE instances ADD COLUMN process_started_at TEXT;
ALTER TABLE instances ADD COLUMN process_error_code TEXT;
ALTER TABLE instances ADD COLUMN process_error_message TEXT;
ALTER TABLE instances ADD COLUMN process_error_at TEXT;
ALTER TABLE instances ADD COLUMN process_updated_at TEXT;

UPDATE instances SET
  process_phase = CASE COALESCE(runtime_state, state)
    WHEN 'running' THEN 'ready'
    WHEN 'starting' THEN 'requested'
    WHEN 'stopped' THEN 'stopped'
    WHEN 'failed' THEN 'failed'
    WHEN 'error' THEN 'failed'
    ELSE NULL
  END,
  process_updated_at = updated_at
WHERE process_phase IS NULL;

CREATE TABLE agent_run_events (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  app_id TEXT NOT NULL REFERENCES apps(id) ON DELETE CASCADE,
  attempt_id TEXT NOT NULL CHECK (length(attempt_id) BETWEEN 1 AND 128),
  seq INTEGER NOT NULL CHECK (seq > 0),
  state TEXT NOT NULL CHECK (state IN ('starting','running','stopped','error')),
  phase TEXT CHECK (phase IS NULL OR phase IN (
    'requested','preparing','creating','waiting_ready','ready',
    'stopping','stopped','failed','interrupted')),
  source TEXT NOT NULL CHECK (source IN ('operator','runtime','reconciler','system')),
  reason TEXT CHECK (reason IS NULL OR length(reason) <= 200),
  error_code TEXT CHECK (error_code IS NULL OR length(error_code) <= 200),
  message TEXT CHECK (message IS NULL OR length(message) <= 2000),
  created_at TEXT NOT NULL
);
CREATE UNIQUE INDEX agent_run_events_attempt_seq
  ON agent_run_events(app_id, attempt_id, seq);
CREATE INDEX agent_run_events_app_id
  ON agent_run_events(app_id, id DESC);
CREATE INDEX agent_run_events_created
  ON agent_run_events(created_at);
`,
  },
  {
    version: 24,
    name: "external-skill-sources",
    sql: `
-- v24: external skill sources, immutable snapshots, and arbitrary local skill files
CREATE TABLE skill_files (
  skill_id INTEGER NOT NULL REFERENCES skills(id) ON DELETE CASCADE,
  path TEXT NOT NULL CHECK (length(path) BETWEEN 1 AND 1024),
  content BLOB NOT NULL,
  encoding TEXT NOT NULL DEFAULT 'utf8' CHECK (encoding IN ('utf8', 'binary')),
  executable INTEGER NOT NULL DEFAULT 0 CHECK (executable IN (0, 1)),
  sha256 TEXT,
  size INTEGER,
  updated_at TEXT NOT NULL,
  PRIMARY KEY (skill_id, path)
);

INSERT INTO skill_files (skill_id, path, content, encoding, executable, sha256, size, updated_at)
SELECT r.skill_id, r.path, CAST(r.content AS BLOB), 'utf8', 0, NULL, NULL, s.updated_at
FROM skill_references r
JOIN skills s ON s.id = r.skill_id;

CREATE TABLE skill_sources (
  id TEXT PRIMARY KEY,
  slug TEXT NOT NULL UNIQUE CHECK (length(slug) BETWEEN 1 AND 64),
  name TEXT NOT NULL CHECK (length(name) BETWEEN 1 AND 128),
  kind TEXT NOT NULL CHECK (length(kind) BETWEEN 1 AND 64),
  endpoint TEXT NOT NULL CHECK (length(endpoint) BETWEEN 1 AND 2048),
  config_json TEXT NOT NULL DEFAULT '{}' CHECK (json_valid(config_json)),
  priority INTEGER NOT NULL DEFAULT 100 CHECK (priority BETWEEN 0 AND 100000),
  enabled INTEGER NOT NULL DEFAULT 1 CHECK (enabled IN (0, 1)),
  mode TEXT NOT NULL DEFAULT 'track' CHECK (mode IN ('track', 'pinned')),
  sync_interval_sec INTEGER NOT NULL DEFAULT 900
    CHECK (sync_interval_sec BETWEEN 60 AND 604800),
  stale_after_sec INTEGER NOT NULL DEFAULT 86400
    CHECK (stale_after_sec BETWEEN 60 AND 2592000),
  request_timeout_ms INTEGER NOT NULL DEFAULT 15000
    CHECK (request_timeout_ms BETWEEN 1000 AND 120000),
  active_snapshot_id TEXT,
  pinned_snapshot_id TEXT,
  disabled_at TEXT,
  last_attempt_at TEXT,
  last_success_at TEXT,
  last_checked_at TEXT,
  last_error_code TEXT,
  last_error_message TEXT,
  etag TEXT,
  revision TEXT,
  state TEXT NOT NULL DEFAULT 'never_synced'
    CHECK (state IN ('never_synced', 'syncing', 'ready', 'degraded', 'error', 'disabled')),
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL,
  updated_by TEXT
);

ALTER TABLE skills ADD COLUMN origin TEXT NOT NULL DEFAULT 'local'
  CHECK (origin IN ('local', 'forked'));
ALTER TABLE skills ADD COLUMN forked_from_source_id TEXT
  REFERENCES skill_sources(id) ON DELETE SET NULL;
ALTER TABLE skills ADD COLUMN forked_from_name TEXT;
ALTER TABLE skills ADD COLUMN forked_from_revision TEXT;

CREATE TABLE skill_source_credentials (
  source_id TEXT PRIMARY KEY REFERENCES skill_sources(id) ON DELETE CASCADE,
  cipher TEXT,
  nonce TEXT,
  meta_json TEXT NOT NULL DEFAULT '{}' CHECK (json_valid(meta_json)),
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL,
  updated_by TEXT
);

CREATE TABLE skill_source_snapshots (
  id TEXT PRIMARY KEY,
  source_id TEXT NOT NULL,
  revision TEXT NOT NULL,
  etag TEXT,
  manifest_sha256 TEXT NOT NULL,
  bucket_set_json TEXT NOT NULL CHECK (json_valid(bucket_set_json)),
  skill_count INTEGER NOT NULL DEFAULT 0 CHECK (skill_count >= 0),
  total_bytes INTEGER NOT NULL DEFAULT 0 CHECK (total_bytes >= 0),
  state TEXT NOT NULL DEFAULT 'active' CHECK (state IN ('active', 'superseded', 'failed')),
  fetched_at TEXT NOT NULL,
  published_at TEXT,
  error_code TEXT,
  error_message TEXT
);
CREATE INDEX skill_source_snapshots_source
  ON skill_source_snapshots(source_id, published_at);

CREATE TABLE skill_source_skills (
  snapshot_id TEXT NOT NULL REFERENCES skill_source_snapshots(id) ON DELETE CASCADE,
  source_id TEXT NOT NULL,
  bucket TEXT NOT NULL,
  name TEXT NOT NULL,
  description TEXT NOT NULL,
  version TEXT,
  content_hash TEXT,
  skill_md_sha256 TEXT NOT NULL,
  files_json TEXT NOT NULL CHECK (json_valid(files_json)),
  file_count INTEGER NOT NULL DEFAULT 0 CHECK (file_count >= 0),
  total_bytes INTEGER NOT NULL DEFAULT 0 CHECK (total_bytes >= 0),
  state TEXT NOT NULL DEFAULT 'ok' CHECK (state IN ('ok', 'quarantined')),
  error_code TEXT,
  error_message TEXT,
  PRIMARY KEY (snapshot_id, bucket, name)
);
CREATE INDEX skill_source_skills_name ON skill_source_skills(snapshot_id, name);

ALTER TABLE instances ADD COLUMN applied_skills_hash TEXT;
`,
  },
  {
    version: 25,
    name: "deploy-drain-and-restart-claims",
    sql: `
-- v25: persisted deploy drain state and surviving async restart claims
CREATE TABLE deploy_state (
  id INTEGER PRIMARY KEY CHECK (id = 1),
  draining INTEGER NOT NULL DEFAULT 0 CHECK (draining IN (0, 1)),
  drain_id TEXT,
  draining_since TEXT,
  updated_at TEXT NOT NULL
);

INSERT INTO deploy_state (id, draining, drain_id, draining_since, updated_at)
VALUES (1, 0, NULL, NULL, strftime('%Y-%m-%dT%H:%M:%fZ', 'now'));

CREATE TABLE restart_claims (
  app_id TEXT PRIMARY KEY REFERENCES apps(id) ON DELETE CASCADE,
  claim_id TEXT NOT NULL,
  reason TEXT,
  created_at TEXT NOT NULL
);
`,
  },
  {
    version: 26,
    name: "telegram-notification-outbox",
    sql: `
CREATE TABLE notification_outbox (
  id TEXT PRIMARY KEY,
  group_id TEXT NOT NULL,
  chunk_index INTEGER NOT NULL DEFAULT 0 CHECK (chunk_index >= 0),
  chunk_count INTEGER NOT NULL DEFAULT 1 CHECK (chunk_count >= 1),
  dedupe_key TEXT NOT NULL UNIQUE,
  kind TEXT NOT NULL CHECK (kind IN (
    'turn_completed','question','permission','ssh_approval',
    'handoff_approval','handoff_waiting_operator','handoff_failed',
    'thread_message_waiting','agent_interrupted'
  )),
  format TEXT NOT NULL DEFAULT 'rich' CHECK (format IN ('rich','plain')),
  scope TEXT NOT NULL CHECK (scope IN ('global','project','app')),
  project_id TEXT,
  app_key TEXT,
  app_id TEXT,
  session_id TEXT,
  payload_json TEXT NOT NULL
    CHECK (json_valid(payload_json) AND length(CAST(payload_json AS BLOB)) <= 1048576),
  state TEXT NOT NULL DEFAULT 'pending'
    CHECK (state IN ('pending','sending','sent','dead')),
  attempts INTEGER NOT NULL DEFAULT 0,
  next_attempt_at TEXT NOT NULL,
  error_code TEXT,
  last_error TEXT,
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL,
  sent_at TEXT,
  FOREIGN KEY (app_id) REFERENCES apps(id) ON DELETE CASCADE,
  FOREIGN KEY (project_id) REFERENCES projects(id) ON DELETE CASCADE
);
CREATE UNIQUE INDEX notification_outbox_group_chunk ON notification_outbox(group_id, chunk_index);
CREATE INDEX notification_outbox_due ON notification_outbox(state, next_attempt_at);
CREATE INDEX notification_outbox_app ON notification_outbox(app_id, created_at);
CREATE INDEX notification_outbox_session ON notification_outbox(session_id, created_at);

CREATE TABLE notification_watermarks (
  app_id TEXT NOT NULL REFERENCES apps(id) ON DELETE CASCADE,
  session_id TEXT NOT NULL,
  last_notified_message_id TEXT,
  initialized_at TEXT NOT NULL,
  updated_at TEXT NOT NULL,
  PRIMARY KEY (app_id, session_id)
);

CREATE TABLE notification_meta (
  key TEXT PRIMARY KEY,
  value TEXT NOT NULL,
  updated_at TEXT NOT NULL
);

CREATE TABLE notification_channel_state (
  channel TEXT PRIMARY KEY,
  state TEXT NOT NULL CHECK (state IN ('ok','error')),
  last_error TEXT,
  updated_at TEXT NOT NULL
);
`,
  },
  {
    version: 27,
    name: "idle-agent-maintenance",
    backwardCompatible: true,
    requiresExclusive: true,
    // Bounds the apps UPDATE plus the handoffs index build at pre-alpha scale.
    estimatedMs: 500,
    sql: `
-- v27: durable per-app agent activity clock and launch fingerprint
ALTER TABLE apps ADD COLUMN last_agent_activity_at TEXT
  CHECK (
    last_agent_activity_at IS NULL OR last_agent_activity_at GLOB
      '[0-9][0-9][0-9][0-9]-[0-9][0-9]-[0-9][0-9]T[0-9][0-9]:[0-9][0-9]:[0-9][0-9].[0-9][0-9][0-9]Z'
  );

-- Created before the UPDATE so the from-side backfill uses the index.
CREATE INDEX handoffs_from_app_state ON handoffs(from_app_id, state);

UPDATE apps
SET last_agent_activity_at = MAX(
  apps.created_at,
  COALESCE((SELECT i.started_at FROM instances i WHERE i.app_id = apps.id), apps.created_at),
  COALESCE((SELECT MAX(s.last_activity_at) FROM session_state s WHERE s.app_id = apps.id), apps.created_at),
  COALESCE((SELECT MAX(r.last_busy_seen_at) FROM session_resume r WHERE r.app_id = apps.id), apps.created_at),
  COALESCE((SELECT MAX(COALESCE(h.last_message_at, h.updated_at)) FROM handoffs h WHERE h.from_app_id = apps.id), apps.created_at),
  COALESCE((SELECT MAX(COALESCE(h.last_message_at, h.updated_at)) FROM handoffs h WHERE h.to_app_id = apps.id), apps.created_at)
);

ALTER TABLE instances ADD COLUMN applied_launch_hash TEXT;
`,
  },
  {
    version: 28,
    name: "cross-project-handoff-grants",
    backwardCompatible: true,
    sql: `
-- v28: explicit cross-project handoff grants
CREATE TABLE handoff_grants (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  project_id TEXT NOT NULL REFERENCES projects(id) ON DELETE CASCADE,
  from_app_key TEXT NOT NULL DEFAULT '*',
  target_project_id TEXT NOT NULL REFERENCES projects(id) ON DELETE CASCADE,
  to_app_key TEXT NOT NULL DEFAULT '*',
  dispatch_mode TEXT NOT NULL CHECK (dispatch_mode IN ('auto','approve')),
  reply_mode TEXT NOT NULL CHECK (reply_mode IN ('auto','approve')),
  created_at TEXT NOT NULL,
  created_by TEXT,
  updated_at TEXT NOT NULL,
  updated_by TEXT,
  UNIQUE (project_id, from_app_key, target_project_id, to_app_key),
  CHECK (project_id <> target_project_id)
);
CREATE INDEX handoff_grants_target ON handoff_grants(target_project_id, to_app_key);

ALTER TABLE handoffs ADD COLUMN target_project_id TEXT;
ALTER TABLE handoffs ADD COLUMN grant_id INTEGER;
UPDATE handoffs SET target_project_id = project_id WHERE target_project_id IS NULL;
CREATE INDEX handoffs_target_project ON handoffs(target_project_id, state);
`,
  },
];
