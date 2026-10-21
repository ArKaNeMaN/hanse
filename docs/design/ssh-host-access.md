# SSH host access for agents

- Status: design review PASS (oracle, 2026-10-21); design gate cleared; plan review pending
- Date: 2026-10-21
- Stage: `0011-ssh-host-access`
- Owners: Hanse maintainers
- Design reviewer: `oracle`
- Plan reviewer: `momus`

## Delivery bindings

| Binding | Value |
| --- | --- |
| Design docs | `docs/design/`; index `docs/design/README.md` |
| Plans | `docs/plans/`; index `docs/plans/README.md` |
| Journal | `docs/journal/`; index `docs/journal/README.md` |
| Decision records | `docs/decisions/NNNN-<slug>.md` |
| Open questions | this document; none remain |
| Documentation language | English |
| Verification | `npm run lint && npm run typecheck && npm test && npm run build` |
| Commit policy | one coherent stage commit, only on explicit owner instruction |

## 1. Context

Hanse runs one isolated `opencode` agent per application. Agents can edit code, run commands inside
their app container, and call the coordinator through a per-app MCP bridge. They cannot reach
operator-managed servers: the app container has no host keys, and the operator has no way to grant
one application access to one host.

The operator wants to define a global set of SSH targets once (address, port, user, private key),
then grant individual applications access to selected targets. An agent must be able to run arbitrary
commands and transfer files over SSH, but **must never see the private key**. The operator also wants
a per-host "ask permission" switch: the first use in an active period must surface a request in chat,
which the operator can approve or reject.

This document designs that feature. It is a new stage after `0010-git-credentials`, which introduces
the encrypted `setting_secrets` store, removes the legacy `secrets` table, and materializes git
credentials into the app HOME. The git credential model deliberately gives the agent a readable
deploy key for native git; this stage does the opposite for operator host keys: execution is
coordinator-side and the key never enters the app container.

## 2. Goals and requirements

| ID | Requirement |
| --- | --- |
| R1 | The operator can define global SSH hosts: name, address, port, user, private key, host-key pin, `require_approval`, idle-grant duration, and optional remote root. |
| R2 | A host private key is encrypted at rest with the coordinator `secret.key` and is never returned by any API, written to the app state, placed in a runtime spec or `OPENCODE_CONFIG_CONTENT`, or logged. |
| R3 | Access is granted strictly per application (`app_id`), with no project-level inheritance. An app with no grants sees no allowed hosts. |
| R4 | The agent gets MCP tools `ssh_list_hosts`, `ssh_exec`, `ssh_upload`, and `ssh_download`; tools accept only an opaque `host_id` from the app's allowlist, never an address, user, port, or key. |
| R5 | `ssh_exec` runs arbitrary non-interactive commands with a timeout and bounded output. Upload/download use SFTP with local-path and remote-path containment and size caps. |
| R6 | A host with `require_approval` cannot be used until a human approves a request in chat. The approval creates an idle-based grant for `(app, host)`; the grant expires after inactivity and has an absolute cap. |
| R7 | Host keys are pinned automatically on the first successful connection (TOFU). A later mismatch fails closed and requires an explicit human re-pin; it is never auto-accepted. |
| R8 | Every operation and approval decision is audited (app, host, action, command hash/preview, exit code, duration, bytes, error code). |
| R9 | All host, grant, approval, and audit routes are human-only; agent tokens receive `403` for them. The only agent-facing route remains `/internal/mcp`. |
| R10 | The feature is additive: no existing table is rewritten; a code rollback leaves unused tables and does not affect existing behavior. |
| R11 | The agent's per-app MCP token is not an authorization boundary. Authorization is evaluated server-side on every call against the verified token identity. |
| R12 | No new component is introduced: execution runs in the coordinator process behind a narrow `SshService`. |

## 3. Non-goals

- A separate `ssh-gateway` container or a new network segment. Deferred; see §6.
- A host allowlist or host credentials in `.hanse/app.yaml`. The agent can edit its own manifest.
- Project-level grants, host groups, tags, or inheritance.
- Multiple credentials per host, multiple users per host, jump hosts, bastion chaining, agent
  forwarding, X11 forwarding, port forwarding, or interactive shells/PTY.
- Password authentication, passphrase-protected private keys, or SSH certificates.
- Command allowlists, deploy recipes, or per-command approval. The owner chose arbitrary commands
  and per-host approval; see §4.
- Network egress filtering. The app network remains an open bridge; this feature protects the
  operator's keys, not the app's outbound network.
- Live termination of an in-flight SSH command when a grant is revoked. Revocation applies to new
  operations; commands stop at their timeout.
- Multi-user, RBAC, or tenancy isolation.
- Automatic host-key rotation. The initial pin is automatic; rotation is explicit.
- A file browser, directory upload, recursive transfer, or resume.

## 4. Owner decisions

These decisions are locked for this stage.

1. **Arbitrary commands.** `ssh_exec` runs a command string as the configured SSH user. The hard
   boundary is the remote user's privileges and the optional approval, not a command allowlist.
2. **Per-host approval with an idle grant.** A host has a `require_approval` switch. The first
   operation without an active grant creates an approval request. Approval grants access to that
   `(app, host)` for as long as it is used, bounded by inactivity and an absolute cap. "Session" is
   not the opencode chat session: the MCP call does not carry a session id. See §12.
3. **Approval card in chat.** The request is rendered as a card in the chat workspace, in the same
   family as permission/question cards, with Approve and Reject actions. The card is app-scoped; it
   is not bound to one chat session because that identity is unavailable.
4. **Automatic host-key pinning.** The first successful connection stores the presented host key and
   its SHA-256 fingerprint. The operator is not asked to paste a fingerprint. A mismatch fails
   closed; re-pinning is an explicit human action.
5. **Per-app allowlist only.** Hosts are global; grants are `app_id -> host_id`. No project scope, no
   inheritance.
6. **Coordinator-hosted execution.** No separate gateway in v1. The coordinator is already attached
   to every app network, holds the database and `secret.key`, and owns the human UI.
7. **`ssh2` dependency.** The coordinator uses the maintained `ssh2` package for exec and SFTP. It
   avoids shelling out to `ssh`/`sftp` and keeps the private key in memory, not in a temp file.
8. **Idle grant constants.** Idle expiry is 30 minutes since the last operation (per-host override
   5–120 minutes); the absolute cap is 8 hours from grant creation. Pending approvals expire after
   5 minutes. A tool waits up to 30 seconds for a decision, then returns `ssh_approval_pending`.

## 5. Current state and constraints

- **MCP bridge.** `hanse mcp` in the app container is a stdio-to-HTTP bridge. It forwards every
  JSON-RPC line unchanged to `${HANSE_MCP_API_BASE}/internal/mcp` with the app bearer token
  (`src/mcp/remote.ts:62-102`). The coordinator verifies the token, resolves
  `{appId, projectId, appKey}` from `agent_tokens`, and calls `handleRpc`
  (`src/http/handler.ts:259-285`, `src/mcp/agent-tokens.ts:90-105`).
- **Tool registration.** Tools are a static array in `src/mcp/protocol.ts:20-56`; `tools/list` and
  `tools/call` are handled by the coordinator (`src/mcp/protocol.ts:107-150`). Because the bridge is
  generic, adding tools to the coordinator does **not** require a new app image; the in-app bridge
  already forwards `tools/list` and `tools/call`.
- **Sync dispatch.** `handleRpc` and `callTool` are synchronous today. SSH/SFTP and approval waits are
  asynchronous. The MCP route must become async (§13.2).
- **Token file.** The per-app token lives at
  `<agentsHome>/<sanitized project>/<sanitized app>/mcp-token`, mode `0600`
  (`src/mcp/agent-tokens.ts:107-134`). The app can read it; it authorizes only that app.
- **Runtime spec.** The app container gets an explicit env built from scratch
  (`src/opencode/manager.ts:401-415`), two writable binds (app dir and app agents root), a read-only
  rootfs, `cap_drop: ALL`, and a per-app bridge network (`src/runner/server.ts:589-645`,
  `src/runner/docker.ts:796-847`). The coordinator is attached to each app network as `hanse`.
- **Secrets.** AES-256-GCM helpers (`loadOrCreateKey`, `seal`, `open`) live in
  `src/secrets/crypto.ts:13-50`; `secret.key` is coordinator-only and mode `0600`
  (`src/runtime/paths.ts:38-41`). The legacy `secrets` table and `git-credential` helper are removed
  by stage 0010; this stage must not use them.
- **Stage 0010 dependency.** `0010-git-credentials` introduces `setting_secrets` at migration v8,
  removes the legacy secret table, and materializes git credentials into the app HOME. This stage
  uses a separate `ssh_host_credentials` table and migration **v9**, even while 0010 is uncommitted;
  v8 is reserved for 0010. `runMigrations` applies by version and tolerates the gap: on a fresh DB
  without v8, this stage applies 8 migrations (v1-v7 + v9) and the schema versions are
  `[1..7, 9]`; if 0010 lands first, they become 9 and `[1..8, 9]`. The migration test asserts the
  applicable counts for the tree it runs in.
- **Path patterns.** The git workbench already demonstrates the coordinator-side realpath/containment
  discipline (`src/git/service.ts`, `src/runner/server.ts`). This design applies the same discipline
  to upload/download paths.
- **Constraints.** Node >= 20, ESM/NodeNext, TypeScript, SQLite via better-sqlite3, no new runtime
  dependency without justification. `ssh2` is the one new dependency. The coordinator image is based
  on `codercom/code-server` and already provides `ssh`/`ssh-keygen` for key validation; `ssh2` avoids
  relying on the binary for connections.

## 6. Alternatives considered and rejected

| Alternative | Why rejected |
| --- | --- |
| Materialize host keys into the app HOME, like git credentials | Violates the core requirement: a compromised agent reads every host key. Stage 0010 accepts this for scoped git deploy keys; operator host keys are broader. |
| Run the SSH MCP server with the key inside the app container | Same leak: same uid, same filesystem, `/proc/<pid>/environ`, and the agent can read the process memory/files. A keyless in-app shim is the only acceptable placement. |
| Separate `ssh-gateway` container | Adds an image, compose service, network, health, backups, and a second credential store. It only improves compartmentalization if the gateway owns its own key material and authenticates the app itself; behind the coordinator, a coordinator compromise can impersonate any app. Deferred (§6.1). |
| Run SSH in the runner | The runner is root-equivalent through the Docker socket, has no database, and is not attached to app networks. Moving keys there increases blast radius and requires a new proxy path. |
| Use opencode native permissions only (`hanse_ssh_exec: ask`) | Permissions are per tool, not per host; "always" is project-scoped and durable, broader than an idle grant. The agent can bypass the MCP process and call `/internal/mcp` directly, so server-side enforcement is still required. |
| Put the host allowlist in `.hanse/app.yaml` | The agent can edit its own manifest and grant itself a host. The allowlist must live in the coordinator DB and be changed only by a human. |
| Store host credentials in `settings.value_json` or `provider_keys` | Settings values are returned to the API/UI; provider keys are materialized into the app-readable `auth.json`. Both would leak. Host credentials need a status-only, never-materialized store. |
| Reuse `setting_secrets` (stage 0010) for host credentials | Wrong shape: `setting_secrets` is resolved wide-to-narrow for git credential kinds; hosts are global entities with per-app grants and their own metadata. Reusing it would couple the git snapshot to SSH keys and complicate status-only reads. The crypto helpers and the cipher/nonce/cleared pattern are reused instead. |
| Keep a persistent connection pool per host | Keeps decrypted keys and connections in memory longer, adds liveness/retry complexity. v1 connects per operation and closes. |

### 6.1 Why not a gateway now

A separate gateway is the right answer when key compartmentalization is a requirement. It is not a
free win:

- If the coordinator decrypts and forwards the key, the gateway provides almost no isolation.
- If the gateway stores the key, the coordinator still needs the host metadata and allowlist, and a
  compromised coordinator can call the gateway as any app unless the gateway authenticates the app
  itself (direct app-to-gateway channel or signed tokens).
- That is a second authorization system, a second secret store, and a new operational surface.

For a single-operator, pre-alpha deployment, the coordinator is already the most trusted component:
it holds `secret.key`, provider keys, the operator token, and the database. Adding SSH keys does not
change the trust class; it makes an already-total compromise more complete. A narrow `SshService`
keeps the code extractable if key compartmentalization becomes a requirement later.

## 7. Architecture overview

```
opencode agent (app container)
  └─ hanse mcp (stdio bridge, no keys)
        │  JSON-RPC + per-app bearer token
        v
coordinator /internal/mcp
  ├─ verifyAgentToken -> { appId, projectId, appKey }
  ├─ SshService
  │    ├─ authorize(appId, hostId)  -> app_ssh_hosts JOIN ssh_hosts
  │    ├─ approval check / grant    -> ssh_approvals, ssh_grants
  │    ├─ decrypt host key          -> ssh_host_credentials + secret.key
  │    ├─ ssh2 connect/exec/SFTP    -> remote host
  │    └─ audit                     -> ssh_audit
  └─ human HTTP API / chat SSE
        ├─ host registry (human-only)
        ├─ per-app grants (human-only)
        └─ approval cards + audit (human-only)

SQLite coordinator.db: ssh_hosts, ssh_host_credentials, app_ssh_hosts,
                       ssh_approvals, ssh_grants, ssh_audit
```

Design principles:

- **Key custody is separate from execution.** The agent calls a tool; the coordinator holds the key.
- **The token identifies, the database authorizes.** The app token selects the app; it never selects
  a host. Every call re-checks the grant.
- **The approval is a UX gate, not the security boundary.** The remote user's privileges are the real
  boundary. The grant is explicit about that in the UI.
- **Fail closed on every ambiguity.** Unknown host, missing grant, decrypt failure, host-key
  mismatch, path escape, and approval uncertainty all deny.

## 8. Data model

All tables are new in migration v9 (stage 0010 owns v8). Timestamps are ISO-8601
`TEXT`; booleans are `INTEGER` with `CHECK`; ids are UUID `TEXT` except the audit sequence.

### 8.1 `ssh_hosts`

```sql
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
```

- `name` is the operator-facing label and must be unique; it is not a security identifier.
- `address` is a hostname or IP literal (no scheme, path, userinfo, or whitespace).
- `username` is the SSH user; no whitespace or control characters.
- `host_key` is the pinned OpenSSH public key in canonical `type base64` form; `host_key_type` and
  `host_key_bits` describe it; `host_key_fingerprint` is the OpenSSH `SHA256:` form (base64 of the
  SHA-256 of the SSH key blob, no padding); `host_key_pinned_at` records the first successful pin.
  They are nullable until the first authenticated connection. `host_key_pinned_at` is the current
  pin time; an explicit re-pin updates it, and the audit keeps the old/new fingerprints.
- `pending_host_key*` is a short-TTL observation written by a successful Test connection with
  `ignorePin`; `re-pin` consumes it. `host_key_mismatch_at` records the last mismatch for the host
  page. See §9.3.
- Changing `address` or `port` clears the active pin and any pending observation: the operator
  changed the target, so a fresh authenticated TOFU pin is required.
- `require_approval` defaults to on. Turning it off is an explicit operator choice; the audit still
  records every operation.
- `approval_idle_sec` is the per-host idle grant duration (5–120 minutes), default 30 minutes.
- `remote_root` is an optional absolute POSIX path used to confine SFTP paths. If null, SFTP paths
  must still be absolute and normalized; the UI defaults it to the user's home. One pin covers one
  address; a load-balanced name with multiple host keys is not supported in v1 (create one host per
  backend or re-pin deliberately).

### 8.2 `ssh_host_credentials`

```sql
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
```

- `cipher`/`nonce` seal the private key (AES-256-GCM, `seal`/`open`). The plaintext is never a column
  and is never selected by list/status queries.
- `public_key`/`public_key_fingerprint`/`key_type`/`bits`/`validated_at` are status-only metadata
  derived from the private key at save time. The public key is shown so the operator can install it
  in the remote `authorized_keys`; the private key is write-only.
- A separate table keeps key material and public-key status out of `SELECT * FROM ssh_hosts` paths.
- `ON DELETE CASCADE` removes the credential with the host. There is no soft delete in v1.
- On replace/delete, the service enables `secure_delete` and checkpoints the WAL (matching
  `ProviderKeyStore`). Ciphertext is not AAD-bound in v1; binding `host_id` is a later hardening.

### 8.3 `app_ssh_hosts`

```sql
CREATE TABLE app_ssh_hosts (
  app_id TEXT NOT NULL REFERENCES apps(id) ON DELETE CASCADE,
  host_id TEXT NOT NULL REFERENCES ssh_hosts(id) ON DELETE CASCADE,
  created_at TEXT NOT NULL,
  created_by TEXT,
  PRIMARY KEY (app_id, host_id)
);
CREATE INDEX app_ssh_hosts_host ON app_ssh_hosts(host_id);
```

This is the entire allowlist. No project rows, no inheritance, no wildcard. An empty set means no
access.

### 8.4 `ssh_approvals`

```sql
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
```

- `command_hash` is SHA-256 over the action and its arguments: for `exec`, the command string; for
  `upload`/`download`, the local/remote paths plus size. It deduplicates identical requests without
  storing the full command in the index.
- `command_preview` is the control-character-stripped command for `exec` (up to the 16 KiB command
  cap), or the source/destination paths and byte size for `upload`/`download`, shown in the card; the
  card scrolls rather than silently truncating. `command_bytes` records the original size so the UI
  can show a truncation marker if the cap is ever lowered.
- A pending approval is reusable only for the same `command_hash`; a different command creates a new
  request. The partial unique index makes the dedupe race-safe.
- `expires_at` is 5 minutes after `requested_at`; "pending" means `status='pending' AND
  expires_at > now` in every query. Expired rows are transitioned lazily in the same transaction that
  reads them, and audited once. Because the partial unique index cannot express `expires_at > now`,
  request creation runs in `BEGIN IMMEDIATE`: first transition any expired row with the same
  `(app, host, action, command_hash)` to `expired`, then select the unexpired pending row, then
  insert. A uniqueness conflict is re-read; an expired winner is transitioned and the insert retried,
  never reused.
- An approved grant supersedes other pending approvals for the same `(app, host)`: they are marked
  `superseded` so they disappear from the UI and stop consuming the pending cap.

### 8.5 `ssh_grants`

```sql
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
```

Active grant: `revoked_at IS NULL AND now < idle_expires_at AND now < absolute_expires_at`. Each
successful operation (including a non-zero remote exit code) updates `last_used_at` and
`idle_expires_at` (idle window from the host's `approval_idle_sec`). `absolute_expires_at` is fixed
at grant creation (8 hours). An expired grant is not deleted immediately; it is left for audit and
ignored by the active query. The unique `approval_id` index makes grant creation idempotent under a
concurrent double-approve.

### 8.6 `ssh_audit`

```sql
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
```

- No foreign keys: audit rows must survive host/app deletion. Names and address are snapshotted.
- `command_preview` is bounded (4 KiB) and stripped of control characters; `presented_fingerprint`
  records a host-key mismatch; `detail_json` carries bounded test/re-pin/host-change details.
- The row is inserted **before** connecting (`started_at`, action, command hash, approval/grant ids)
  and updated in `finally`. At startup, rows with `finished_at IS NULL` are marked `interrupted`.
  If the pre-insert fails, the operation does not start; if the post-update fails after a command ran,
  the result is returned with `ssh_audit_failed` and the failure is logged without secrets.
- `test`, `re-pin`, host create/update/delete, and approval decisions are audited with the same
  table (action values such as `test`, `re-pin`, `host.update`, `approval.approve`).
- The audit is human-only read. There is no API to delete rows in v1; retention is operator-managed
  (backup/DB policy). A manual purge is a possible later admin action.

### 8.7 Migration and compatibility

- New tables only; no `ALTER TABLE` on existing tables. Existing apps, instances, and sessions are
  untouched. The migration is additive and reversible by code rollback (unused tables remain).
- `PRAGMA foreign_keys = ON` is already set in `openDatabase` (`src/store/database.ts:13`); the
  migration test asserts the cascade behavior rather than re-checking the pragma.
- Version numbering: stage 0010 owns v8 (`setting_secrets`); this stage uses v9. The 0010 work is
  currently uncommitted and may land before or after this stage; `runMigrations` applies by version
  and tolerates the gap, so v9 is safe either way. In the clean HEAD without v8, a fresh DB applies
  8 migrations and the versions are `[1..7, 9]`; the v5 upgrade test applies 3 (v6, v7, v9). If v8
  is present, the counts are 9 and `[1..8, 9]`, and the v5 upgrade applies 4. The migration test
  asserts the new tables, indexes, and cascades.

## 9. Credentials and host keys

### 9.1 Private-key validation

- The private key is submitted once over a human-only JSON route, validated, sealed, and never
  returned. The key field is write-only in the UI.
- Validation reuses the stage 0010 SSH-key rules where possible: 1 byte–32 KiB, LF-normalized, no
  NUL/control characters except newline, `-----BEGIN ... PRIVATE KEY-----` and matching end marker,
  no public keys/certificates. Passphrase-protected keys are rejected with a clear error (v1 does not
  support passphrases). The derived public key and fingerprint are shown for verification.
- `ssh-keygen -y -P ""` is the validation mechanism (coordinator image already has it). It runs with
  an argument array, a 5-second timeout, and a `0600` temp file outside the workspace; the temp file
  is removed in `finally`.
- Supported key types: Ed25519, ECDSA, and RSA (>= 2048-bit). DSA is rejected.

### 9.2 Encryption at rest

- `seal(privateKey)` with the coordinator's AES-256-GCM key; `cipher`/`nonce` are base64 strings in
  `ssh_host_credentials`.
- `SshService` decrypts only when an authorized operation needs to connect. The plaintext key is
  passed to `ssh2` as a string; it is not written to disk and is not cached between operations.
- The coordinator `secret.key` remains coordinator-only. The app container has no `/data/state`
  mount; the key is never in the app agents root.
- Decryption failure is `ssh_credential_unavailable` (fail closed), audited, and never falls back to
  an ambient key, SSH agent, or `~/.ssh`.

### 9.3 Host-key pinning (TOFU)

- On connect, `ssh2`'s `hostVerifier` receives the raw SSH host-key blob. The service computes the
  OpenSSH SHA-256 fingerprint (base64 of `sha256(blob)` without padding) and compares it to
  `ssh_hosts.host_key_fingerprint` in constant time. It also restricts `serverHostKey` to
  `ssh-ed25519`, `ecdsa-sha2-nistp256/384/521`, and `rsa-sha2-512/256`; legacy `ssh-rsa` (SHA-1) and
  `ssh-dss` are disabled. `readyTimeout` is 15 seconds.
- If no pin exists, the verifier **captures** the presented key/fingerprint in memory and allows the
  handshake to continue. The pin is persisted only after the `ready` event (authentication success)
  in a conditional transaction (`UPDATE ... WHERE host_key IS NULL`; on a race, re-read and compare).
  A failed authentication never writes a pin.
- If a pin exists and does not match, the connection is aborted before authentication with
  `ssh_host_key_mismatch`; `host_key_mismatch_at` and the presented fingerprint are recorded, and the
  operator is prompted to investigate. A changed key is never auto-accepted. A later successful
  authenticated connection with the correct pin clears `host_key_mismatch_at`.
- The preferred pin moment is the human-only "Test connection" action on the host page. A plain
  `test` on an unpinned host pins after successful authentication (it is the first successful
  connection) and never replaces an existing pin. `test` with `ignorePin: true` captures the
  presented key, authenticates, and, only on success, writes a short-TTL pending observation
  (`pending_host_key*`, 10 minutes) and returns the old/new fingerprints; this is the rotation flow.
  If the operator never tests, the first agent operation pins after successful authentication; the UI
  shows "pinned on first connection".
- Re-pin is an explicit human action: the operator runs Test connection with `ignorePin`, sees the
  old and new fingerprints, and submits the new fingerprint. `re-pin` requires a matching, unexpired
  pending observation, replaces the pin, clears the observation, and audits old/new in one
  `BEGIN IMMEDIATE` transaction. There is no automatic rotation.
- Changing `address` or `port` clears the active pin and any pending observation; the next
  authenticated connection pins the new target.
- Accepted risk: the first connection is TOFU and can be MITM'd on an untrusted network. The feature
  targets a trusted LAN/VPN (the project's existing deployment model). After the first pin, host-key
  verification is strict.

### 9.4 What the agent can and cannot see

- The agent can see: host name, address, port, username, fingerprint, its own grants, approval
  status, command output, and upload/download paths. Audit entries are human-only; there is no
  agent-facing audit tool in v1.
- The agent cannot see: the private key, the encrypted ciphertext, another app's grants or audit,
  host-key rotation controls, or the operator token.
- The agent can read its own app state (including model `auth.json` and, after stage 0010, git
  credentials). Those are separate credentials; this feature does not add host keys there.
- The app image contains `openssh-client`, and the app network has egress. The agent can create its
  own keys and connect to hosts directly; this feature does not prevent that. The guarantee is that
  **the operator's host keys** are never in the app, and the managed path is authorized and audited.

## 10. Authorization and allowlist

### 10.1 Identity

`verifyAgentToken` returns `{appId, projectId, appKey}`. The MCP handler must pass the full identity
to the SSH service. The current `handleRpc` options carry only `fromAppKey`; this stage changes them
to carry `agent: AgentTokenIdentity` (or an equivalent object). No host/address/user value from the
tool arguments is trusted.

### 10.2 Every-call checks

For each tool call:

1. `host_id` is a non-empty string; look up `ssh_hosts` by id.
2. `app_ssh_hosts` must contain `(agent.appId, host_id)`. An unknown id and a known-but-not-granted
   id both return `ssh_host_not_allowed`; do not reveal whether the host exists.
3. The host must have a credential; missing/decrypt failure → `ssh_credential_unavailable`.
4. If `require_approval`, an active grant for `(app_id, host_id)` is required; otherwise create/ask
   for approval (§12).
5. The operation's arguments are validated (command length, paths, sizes).
6. Only then connect.

The checks are server-side and re-evaluated on every call. An agent that steals its own token and
calls `/internal/mcp` directly gets the same checks; there is no "came through MCP" trust.

### 10.3 Path confinement

**Local upload source / download destination (race-free, dirfd-relative):**

The app container runs as the same uid (1000) and can atomically replace a checked file or directory
with a symlink. A `realpath`-then-open check is therefore a TOCTOU: the coordinator could be made to
read `/data/state/secret.key`, `coordinator.db`, another app's agents root, or its git credentials.
The service never re-opens an app-controlled path by string:

- Resolve the registered app directory from the registry (`<workspaceRoot>/<projectPath>/<appDir>`)
  and open it with `O_DIRECTORY|O_NOFOLLOW`. Verify the opened fd's `/proc/self/fd/<fd>` realpath is
  inside the workspace and equals the registered app dir. Reject a symlinked app dir. The app cannot
  replace its own directory (its parent is not app-writable), so this anchor is stable.
- Normalize the user path before walking: reject NUL/control characters, empty components, `.`,
  `..`, and any absolute component that is not the registered app-dir prefix. Split the remainder
  into plain names only. `O_NOFOLLOW` stops symlinks but **does not stop `..` traversal**; the
  component validation is what keeps the walk beneath the app dir.
- Walk each remaining component relative to the held dirfd with `O_NOFOLLOW`
  (`/proc/self/fd/<dirfd>/<name>` on Linux); intermediate components use
  `O_DIRECTORY|O_NOFOLLOW`, the final component uses `O_NOFOLLOW`. A component swapped after the
  check cannot escape the held directory, and `..` cannot leave it because it is rejected before the
  walk.
- Upload: open the final component with `O_RDONLY|O_NOFOLLOW`, `fstat` it, require a regular file and
  the size cap, and stream from the fd. Never re-open by path.
- Download: open the destination parent relative to the app dirfd with `O_DIRECTORY|O_NOFOLLOW`,
  create a temp file with `O_CREAT|O_EXCL|O_NOFOLLOW` relative to that fd, write, `fsync`, and
  `rename` relative to the same fd. Never re-resolve the final path. Mode `0600`.
- The coordinator's `/data/state`, `/data/agents`, and sibling app directories are unreachable even
  under a concurrent symlink swap. The helper lives in `src/ssh/paths.ts` and is unit-tested with a
  symlink-flip harness. Linux `/proc/self/fd` is available in the coordinator container.

**Remote SFTP paths:**

- Accept absolute POSIX paths only; normalize `.`/`..` lexically and reject any result that escapes
  the configured `remote_root` (when set). When `remote_root` is null, require an absolute normalized
  path with no `..`.
- When `remote_root` is set, the `sftp.realpath()` re-check is **mandatory**; reject a resolved path
  outside the root and `lstat` the final component to reject symlinks. The remote host is
  operator-trusted, so this is a guard against accidental escapes, not a boundary against the remote
  administrator.
- Upload: regular file, 1 byte–50 MiB, written to a temporary name in the target directory and
  renamed into place; `chmod 0600` after write when replacing an existing file. Download: regular file
  only, reject directories/devices/symlinks. No agent-supplied mode.
- If the remote host is load-balanced or presents multiple host keys, the pin will mismatch; create
  one host per backend or re-pin deliberately.

### 10.4 Rate limits and concurrency

- Approval waits are **not** in-flight SSH operations. The per-`(app, host)` operation slot is
  acquired only after an active grant exists; at most 2 callers may wait on the same pending
  approval. Once a slot is held, additional calls wait up to 5 seconds, then `ssh_busy`.
- Global: at most 4 in-flight SSH operations in the coordinator; beyond that, `ssh_busy`.
- Per `(app, host)`: at most 60 operations per hour. Counted from `ssh_audit` in the DB (survives a
  coordinator restart). Per app: at most 10 unexpired pending approvals; at most 10 approval requests
  per hour. After a rejection, a cooldown of 60 seconds per `(app, host)` applies before a new card
  can be created.
- When a grant is created, other pending approvals for the same `(app, host)` become `superseded`;
  waiting callers re-check the grant and proceed without another card.
- These are constants in v1; no UI configuration. The limits are intentionally generous for deploy
  work and low enough to bound resource use. `SQLITE_BUSY` from a concurrent decision maps to
  `ssh_busy` and is safe to retry.

## 11. MCP tools

The tools are added to the existing `hanse` MCP server. The app image does not need a new binary; the
in-app bridge forwards `tools/list` and `tools/call` unchanged. The coordinator sets an explicit
`timeout` on the `hanse` MCP entry in `OPENCODE_CONFIG_CONTENT` (600,000 ms) so the worst case
(30 s approval + 15 s connect + 300 s exec + transfer) fits inside opencode's client timeout; see
§13.4. The agent **requires a restart** (not an image rebuild) to refresh its cached tool list and
pick up the timeout.

### 11.1 `ssh_list_hosts`

Input: none.

Result:

```json
{
  "hosts": [
    {
      "id": "uuid",
      "name": "prod-web-1",
      "address": "10.0.0.12",
      "port": 22,
      "username": "deploy",
      "fingerprint": "SHA256:...",
      "require_approval": true,
      "grant": { "active": true, "idle_expires_at": "...", "absolute_expires_at": "..." }
    }
  ]
}
```

Only hosts in `app_ssh_hosts`. No key material. An empty list is a valid answer.

### 11.2 `ssh_exec`

Input:

| Field | Type | Rules |
| --- | --- | --- |
| `host_id` | string | Required; must be in the app's allowlist. |
| `command` | string | Required; 1–16 KiB; no NUL; may contain newlines. |
| `timeout_sec` | number | Optional; 1–300; default 60. |

Result (success):

```json
{
  "ok": true,
  "host": "prod-web-1",
  "command": "systemctl restart app",
  "exit_code": 0,
  "stdout": "...",
  "stderr": "...",
  "truncated": { "stdout": false, "stderr": false },
  "duration_ms": 842
}
```

Result (denied / approval):

```json
{ "ok": false, "code": "ssh_approval_pending", "approval_id": "uuid", "expires_at": "...", "message": "..." }
```

Behavior:

- Non-interactive `exec`; no PTY. The remote command runs through the SSH user's shell (the feature
  is arbitrary commands by owner decision).
- `stdout` and `stderr` are each capped at 64 KiB; the total result is capped at 128 KiB. Excess is
  dropped from the tail and flagged in `truncated`. NUL and most control characters are stripped
  before the result is returned and audited; newlines and tabs are preserved.
- Exit code is returned even for non-zero; a non-zero exit is not a protocol error.
- Authentication failure, connect timeout, command timeout, host-key mismatch, and transport errors
  return `ok: false` with a stable code. A timeout kills the channel; the remote process may continue
  if it ignores SIGHUP — this is documented.
- `ssh2` connects per call and closes in `finally`; no pooling.

### 11.3 `ssh_upload`

Input:

| Field | Type | Rules |
| --- | --- | --- |
| `host_id` | string | Required; allowlisted. |
| `local_path` | string | Relative to the app directory or absolute inside it; opened via the dirfd helper (§10.3); regular file; ≤ 50 MiB. |
| `remote_path` | string | Absolute; confined to `remote_root`; regular file target. |

Result: `{ "ok": true, "bytes": 1234, "remote_path": "/srv/app/release.tar" }`.

No agent-supplied mode, owner, or recursive flag. The remote file is written with mode `0600`; the
operator can change the remote permissions with `ssh_exec` if needed. Upload has a fixed 300-second
transfer deadline; on expiry the SFTP stream is aborted and the tool returns `ssh_transfer_timeout`.
This keeps 30 s approval + 15 s connect + 300 s transfer inside the 600 s MCP timeout.

### 11.4 `ssh_download`

Input:

| Field | Type | Rules |
| --- | --- | --- |
| `host_id` | string | Required; allowlisted. |
| `remote_path` | string | Absolute; confined to `remote_root`; regular file; ≤ 50 MiB. |
| `local_path` | string | Relative to the app directory or absolute inside it; written via the dirfd helper (§10.3); target file. |

Result: `{ "ok": true, "bytes": 1234, "local_path": "logs/app.log" }`.

The local write is atomic (temp + rename), mode `0600`, no symlink following. An existing file is
replaced; the agent can already write the app directory. Download has the same fixed 300-second
transfer deadline and returns `ssh_transfer_timeout` on expiry.

### 11.5 Error codes

Stable machine-readable codes: `ssh_host_not_allowed`, `ssh_credential_unavailable`,
`ssh_auth_failed`, `ssh_host_key_mismatch`,
`ssh_connect_timeout`, `ssh_command_timeout`, `ssh_transfer_timeout`, `ssh_transport_error`,
`ssh_path_not_allowed`, `ssh_file_too_large`, `ssh_invalid_argument`, `ssh_approval_pending`,
`ssh_approval_rejected`, `ssh_approval_expired`, `ssh_busy`, `ssh_rate_limited`,
`ssh_audit_failed`.

Policy/validation failures and approval states are normal tool results with `ok: false` and a code,
so the agent can react. Internal failures that prevent producing a result (for example a database
error before the tool starts) may use a JSON-RPC error; the tool must try to return a structured
result for anything the agent can act on.

### 11.6 Tool descriptions

The descriptions must tell the agent:

- Hosts come from `ssh_list_hosts`; never invent an address, user, or port.
- `ssh_exec` may require operator approval; if the result is `ssh_approval_pending`, the operator has
  been asked and the agent should wait for approval or tell the user, then retry the same call.
- Output may be truncated; the exit code is authoritative.
- Upload/download paths are confined; use paths inside the app directory and the configured remote
  root.

## 12. Approval flow

### 12.1 Grant semantics

- A grant is per `(app_id, host_id)` and covers all actions (`exec`, `upload`, `download`) to that
  host. The first approved action unlocks the host for the app; subsequent actions within the idle
  window do not ask.
- Idle expiry: 30 minutes since the last successful operation, configurable per host (5–120 minutes).
  Each operation updates `last_used_at`/`idle_expires_at`.
- Absolute cap: 8 hours from `granted_at`. It never extends; after it, a new approval is required.
- Revocation: a human can revoke a grant at any time. New operations ask again; an in-flight command
  is not killed.
- The approval card states explicitly: "Approving grants this application arbitrary command
  execution on this host while the grant is active (30 min idle, 8 h maximum)." This is the
  consequence of the arbitrary-command decision.

### 12.2 Request flow

1. The tool has an allowlisted host with `require_approval` and no active grant.
2. In `BEGIN IMMEDIATE`, the service transitions expired rows with the same
   `(app, host, action, command_hash)` to `expired`, looks for an unexpired `pending` row, and reuses
   it if present; otherwise it inserts a new pending row with a 5-minute expiry. On a uniqueness
   conflict it re-selects; an expired winner is transitioned and the insert is retried, never reused.
   This makes the check-then-insert race-safe despite the non-deterministic expiry predicate.
3. Make the pending list available through the human API. The chat polls the app-scoped approval
   list every 5 seconds; v1 does not add a coordinator-originated SSE frame (the design's polling
   fallback is the implementation). An SSE event remains a later optimization.
4. Wait up to 30 seconds for a decision:
   - **approved** → create a grant (idle/absolute), supersede other pending approvals for the same
     `(app, host)`, execute the operation, return the result.
   - **rejected** → return `ssh_approval_rejected`; a 60-second cooldown applies before another request
     for the same `(app, host)`.
   - **timeout** → return `ssh_approval_pending` with the approval id and expiry. The approval remains
     pending; the agent can retry the same call. A retry reuses the pending row and waits again.
5. Unexpired pending rows are the only ones counted or shown; an expired row is transitioned to
   `expired` lazily in the reading transaction and audited once. A retry after expiry creates a new
   request.

The 30-second wait keeps the common case (an attentive operator) smooth without holding an HTTP
request for minutes. If the operator approves after the tool returned `ssh_approval_pending`, the grant
exists; the agent's retry executes without a new prompt.

### 12.3 Decision API and UI

- `POST /api/apps/:app/ssh/approvals/:id/decision?project=<id>` with
  `{ "decision": "approve" | "reject", "reason"?: string }`. Human-only; agent tokens `403`. The
  handler resolves the app and requires the approval's `app_id` to match it. A decision runs in
  `BEGIN IMMEDIATE`: `UPDATE ... WHERE id=? AND status='pending' AND expires_at > now`, a `changes`
  check, then the grant insert (unique `approval_id`) in the same transaction. Repeating the same
  decision returns the current state; a conflicting decision returns `409`.
- The chat card shows: app/project, host name/address/user, action, the full command (up to the
  16 KiB command cap, escaped as text and scrollable; a byte count marks any truncation), requested
  time, pending expiry, and the grant terms. Buttons: Approve, Reject. The card is app-scoped and
  appears above the composer; a badge/count appears in the top bar so the operator notices it from
  another session. After a decision, the card updates to Approved/Rejected and the tool call proceeds
  or returns.
- The app page has a "Pending SSH approvals" panel and a "Grants" list with Revoke. The dashboard
  shows a global count of unexpired pending approvals.
- The agent cannot approve or reject; it can only observe the tool result. The card is rendered from
  coordinator data, not from the agent's message, so a prompt-injected agent cannot forge a card.

### 12.4 Deduplication, flooding, and offline operators

- Identical requests (same action + `command_hash`) reuse a pending approval. A different command
  creates a separate card with the full command (up to the 16 KiB cap), so the operator can inspect
  it. The approval is host-wide after approval: it unlocks arbitrary commands for the idle window,
  and the card says so. Command-hash binding only dedupes the pending request; it does not limit
  commands after the grant. §15.2 reflects this.
- At most 10 unexpired pending approvals per app (and 10 approval requests per hour per app); beyond
  that, `ssh_rate_limited`. A rejection starts a 60-second cooldown per `(app, host)`. The agent
  cannot flood the operator across hosts.
- When a grant is created, other pending approvals for the same `(app, host)` are superseded and
  waiting callers re-check the grant and proceed.
- If the operator is offline, the tool returns `ssh_approval_pending` after 30 seconds; the card remains
  for up to 5 minutes. The agent can continue other work and retry.
- If the chat is closed, the app page/dashboard still shows the pending request; approval from there
  creates the same grant.

## 13. Runtime integration

### 13.1 `SshService`

New module `src/ssh/service.ts` (plus `src/ssh/keys.ts`, `src/ssh/approvals.ts`, `src/ssh/paths.ts`,
and `src/ssh/mcp.ts` for the tool handlers). `SshService` is constructed in `serveCommand` with:

- the SQLite database;
- the coordinator secret key (the same `loadOrCreateKey` result used by `SettingsService`);
- `workspaceRoot` and `agentsHome` for local path resolution;
- injectable seams: `connect` (an `ssh2` client factory), `now`, `randomUUID`, and a clock for
  tests.

It exposes:

- `listHosts(agent)` — allowed hosts + active grant status;
- `exec(agent, input, signal?)` — authorization, approval, connect, exec, audit;
- `upload(agent, input)` / `download(agent, input)` — SFTP with path checks;
- `requestApproval`, `decideApproval`, `activeGrant`, `revokeGrant`;
- `testHost(hostId, options?: { ignorePin?: boolean })` — human-only connection test/pin, no command;
- `listApprovals(agent)`, `listAudit(agent)`.

The service never returns the private key or ciphertext.

### 13.2 Async MCP route

The current `handleRequest`/`routeInternalMcp` path is synchronous. The SSH handler is async. Add an
`isInternalMcp` route in `src/http/server.ts` (like `isChat`/`isSettings`) that dispatches to a new
async `handleInternalMcp` before the synchronous `handleRequest`. `handleInternalMcp` verifies the
agent token, builds the base service, and calls a new async `handleRpcAsync`:
`tools/call` for `ssh_*` tools awaits `SshService`; every other method/tool delegates to the existing
synchronous `handleRpc`/`callTool` unchanged. The local stdio server (`src/mcp/server.ts`) and its
tests remain synchronous. `handleInternalMcp` replaces the old `/internal/mcp` branch in
`handleRequest`; update the route tests accordingly. The in-app bridge already awaits the HTTP
response, so no bridge change is needed.

### 13.3 Identity propagation

`handleInternalMcp` passes `{ agent }` (the full `AgentTokenIdentity`) to `handleRpcAsync`. SSH tools
use the full identity. Non-SSH tools delegate to the existing synchronous `handleRpc` with
`{ fromAppKey: agent.appKey }`; the sync `handleRpc` signature, the local stdio server, and their
tests remain unchanged. No tool trusts a caller-supplied app key. The old `routeInternalMcp` branch
in `handleRequest` is removed.

### 13.4 App image and tool list

Because the in-app `hanse mcp` bridge forwards arbitrary JSON-RPC, the new tools are served by the
coordinator and do not require a new agent image. The coordinator upgrade is sufficient for the
bridge; opencode caches `tools/list` per process, so an agent **restart** (not an image rebuild) is
required to see the new tools and pick up the MCP timeout.

The `hanse` MCP entry in `OPENCODE_CONFIG_CONTENT` gains an explicit `timeout: 600000` (10 minutes),
covering 30 s approval + 15 s connect + 300 s exec + transfer. `McpLocalServer` gains
`timeout?: number`. This must be verified against opencode 1.19.3: the in-app bridge serializes every
forwarded line and does not abort the HTTP request when stdin closes, so a client-side timeout would
leave the coordinator running the command while the agent sees a transport error. v1 documents this
as a limitation; forwarding `notifications/cancelled` and aborting the fetch is a follow-up if
needed. A real-agent QA scenario runs a >60 s command and an approval wait.

### 13.5 Coordinator image and dependency

Add `ssh2` (1.x, pinned in `package-lock.json`) to `dependencies`. The coordinator image installs
`node_modules` in the `deps` stage, which already has `python3`, `make`, and `g++` for
`better-sqlite3`; `ssh2`'s optional native pieces build there. The runtime does not need
`openssh-client` for connections, but the coordinator uses `ssh-keygen` for key validation (already
present per stage 0010). No new system package is required.

## 14. HTTP API and UI

All routes are human-only. Mutations are JSON-only (except form posts that use the existing form
conventions), use the `SameSite=Strict` operator cookie, and never return key material.

### 14.1 Host registry

- `GET /api/ssh/hosts` — status-only list: id, name, address, port, username, host-key fingerprint,
  `require_approval`, `approval_idle_sec`, `remote_root`, credential status, the credential's
  `public_key`/`public_key_fingerprint`/`key_type`/`bits`/`validated_at`, pinned-at,
  `host_key_mismatch_at`, and usage counts. Never cipher/nonce.
- `POST /api/ssh/hosts` — create: `{ name, address, port?, username, privateKey, requireApproval?,
  approvalIdleSec?, remoteRoot? }`. Validates and seals; inserts the host row and credential row in
  one transaction. Response is status-only.
- `PATCH /api/ssh/hosts/:id` — update metadata; an optional `privateKey` replaces the credential and
  its derived public-key status after validation. Changing `address` or `port` clears the active pin
  and pending observation; the next authenticated connection pins the new target.
- `DELETE /api/ssh/hosts/:id` — delete the host, its credential, grants, and pending approvals.
  Audit rows remain (no FK).
- `POST /api/ssh/hosts/:id/test` — connect with the stored credential. A plain test uses the active
  pin and never changes it; `{ "ignorePin": true }` captures the presented key, authenticates, and on
  success writes a 10-minute pending observation. Returns
  `{ ok, authOk, fingerprint, previousFingerprint?, mismatch?, serverBanner? }`. No command execution.
  Human-only. A failed authentication never pins.
- `POST /api/ssh/hosts/:id/re-pin` — explicit rotation: body `{ fingerprint }`; requires a matching,
  unexpired pending observation from a successful Test connection, then replaces the pin and clears
  the observation in one transaction. Audits old/new. Human-only.

### 14.2 App grants

- `GET /api/projects/:projectId/apps/:appKey/ssh` — all global hosts with an `allowed` flag, active
  grant summary, and pending approval count.
- `POST /api/projects/:projectId/apps/:appKey/ssh` — replace the app's allowlist:
  `{ hostIds: string[] }`. Validates every id exists; replaces `app_ssh_hosts` in a transaction.
  Removing a host revokes its active grants (sets `revoked_at`) and expires pending approvals.
- `POST /api/projects/:projectId/apps/:appKey/ssh/grants/:id/revoke` — revoke a grant.

### 14.3 Approvals and audit

- `GET /api/apps/:app/ssh/approvals?project=<id>` — pending and recent approvals (status, host,
  action, command preview, times). Human-only.
- `POST /api/apps/:app/ssh/approvals/:id/decision?project=<id>` — approve/reject (§12.3).
- `GET /api/apps/:app/ssh/audit?project=<id>&limit=...&before=...` — bounded audit page, newest
  first. Human-only; same app scoping as chat routes.
- `GET /api/ssh/approvals/count` — human-only global count of unexpired pending approvals for the
  dashboard/top-bar badge.
- v1 polls `/api/apps/:app/ssh/approvals` every 5 seconds while the app chat is open; no
  coordinator-originated SSE frame is added. The approval card is app-scoped; it is shown in the
  chat workspace above the composer and in the app page panel. An SSE event is a later optimization.
- **Dispatch order:** `src/http/server.ts` checks an `isSshRoute` predicate for `/ssh`,
  `/api/ssh/...`, `/api/projects/.../ssh...`, and `/api/apps/.../ssh...` **before** `isChat` and
  before the generic `handleRequest` chain. Every `/api/apps/...` path otherwise goes to
  `handleChat`, which returns 404 for unknown paths before any principal check. `handleSsh` is async
  and does `principalFrom` + `kind === "human"`; agent tokens get `403`, anonymous API calls `401`,
  and HTML pages redirect to `/login`. Tests cover every new route with an agent token.

### 14.4 UI pages

- A global "SSH hosts" page linked from `/settings` (or a dedicated `/ssh` page): table of hosts,
  add/edit dialog with a write-only private-key field, "Test connection", fingerprint display,
  require-approval checkbox, idle-duration select, remote-root field, usage/audit link.
- The app settings page gains an "SSH access" section: checkboxes for global hosts, grant status,
  Revoke, pending approvals.
- The chat approval card reuses the visual language of question/permission cards (bordered card,
  monospace command block, Approve/Reject buttons, focus management, `aria-live` for the decision
  result). It is keyboard accessible and does not trap focus.
- The dashboard shows a pending-approval count; the app page shows the same count.

## 15. Security analysis

### 15.1 Assets and trust boundaries

| Asset | Holder | Boundary |
| --- | --- | --- |
| Host private keys | Coordinator memory + encrypted DB | Never crosses into the app container |
| Host metadata / grants | Coordinator DB | Human-only writes; agent reads only its own allowed hosts |
| App MCP token | App state (`0600`) | Readable by the app; identifies the app only |
| Operator token / `secret.key` | Coordinator | Never in the app container |
| Remote hosts | Operator-managed | Untrusted output; authenticated by pinned host key |

Trust boundaries: the app container is untrusted; the coordinator is trusted; the network between
the coordinator and remote hosts is untrusted (host-key verification); the remote host is
operator-trusted but its output is untrusted input to the agent.

### 15.2 Threat table (STRIDE-lite)

| Threat | Scenario | Control |
| --- | --- | --- |
| Spoofing (app) | A sibling app or a stolen token calls the MCP endpoint. | Token selects `appId`; every call checks `app_ssh_hosts`; sibling app has no grant. |
| Spoofing (host) | MITM on first connection presents a fake host key. | TOFU on first connection; strict pin afterward; trusted-LAN assumption documented. |
| Tampering (command) | Agent changes the command after approval. | The pending request is bound to `command_hash` for dedupe; approval then grants the host for the idle window, so arbitrary commands are expected. The card states this; the audit records every command. |
| Repudiation | Agent denies running a command. | Audit rows with app, host, command hash/preview, exit code, timestamps. |
| Information disclosure (key) | Agent reads `/proc`, app state, env, logs. | Key never in the app; no key in specs/logs/results; `ssh2` uses it in coordinator memory only. |
| Information disclosure (other apps) | Agent reads another app's hosts/audit. | Queries filter by `appId`; human-only routes reject agent tokens; `ssh_list_hosts` is app-scoped. |
| Denial of service | Agent floods SSH connections/approvals. | Rate limits, per-host/global concurrency, pending cap, command timeout. |
| Elevation of privilege | Agent grants itself a host or approves its own request. | Host/grant/decision routes are human-only; agent tokens get `403`; allowlist lives in the DB. |
| Path escape (local) | `ssh_upload(local_path=/data/state/secret.key)` or a symlink-flip race against the app dir. | Dirfd-relative open with `O_NOFOLLOW` and `/proc/self/fd` containment; the final fd is verified before reading; no path re-resolution. |
| Path escape (remote) | `remote_path=../../etc/shadow` or a symlink inside `remote_root`. | Absolute normalized paths; mandatory `realpath` when `remote_root` is set; `lstat` symlink rejection; temp+rename. |
| Prompt injection | Remote output tells the agent to use another host. | The other host needs its own grant/approval; arbitrary commands on an already-approved host are the owner's accepted risk. |

### 15.3 Residual risks

- **Arbitrary commands on an approved host are broad.** A prompt-injected or malicious agent with an
  active grant can do anything the SSH user can. The operator must use a least-privilege deploy user
  and approve deliberately. The UI says this explicitly.
- **TOFU first connection.** A first-use MITM is possible; after the pin, host-key verification is
  strict. Test connection at host creation is the recommended pin moment.
- **Coordinator compromise.** The coordinator can decrypt all host keys and execute as any app. This
  is the existing trust model; a gateway would not fix it unless it owns the keys and authenticates
  apps independently.
- **In-flight operations survive revocation.** A revoked grant stops new calls; a running command
  continues until its timeout. A future kill switch is out of scope.
- **Audit preview may contain secrets.** The command preview is bounded and stored; operators should
  avoid putting secrets in command lines. The full stdout/stderr is not stored, only returned and
  capped.
- **Remote output is untrusted.** It is stripped of control characters and rendered as text; the
  agent may still be prompt-injected. The approval gate is the control for cross-host actions.
- **App egress is open.** The app can create its own keys and connect directly. The feature protects
  operator keys and provides an audited path; it is not a network egress control.
- **Targeting the coordinator host or a host with access to coordinator state defeats key custody in
  effect.** If the operator grants SSH to the Docker host (or any host that can read `/data/state`,
  the Docker socket, or a backup of them), `ssh_exec` gives the agent a shell there, and the agent can
  read `secret.key`/`coordinator.db` or use the Docker socket. The host-creation UI shows a prominent
  warning ("do not target the coordinator host or a host that can read coordinator state") and the
  audit records the grant; v1 does not hard-deny such addresses because the set is deployment-specific.
- **The SSH user's privileges are the real boundary.** The approval grants arbitrary execution as
  that user; least-privilege deploy users and `sudo` policy are the operator's responsibility.

## 16. Failure modes

| Failure | Behavior |
| --- | --- |
| Host not in allowlist | `ssh_host_not_allowed`; no connection; audited. |
| Host deleted / grant removed | New calls fail; in-flight calls continue to timeout. |
| Credential missing / decrypt fails | `ssh_credential_unavailable`; no connection; audited; no ambient fallback. |
| Host key mismatch | `ssh_host_key_mismatch`; connection aborted before auth; audit stores the presented fingerprint; UI prompts re-pin. |
| DNS / connect timeout | `ssh_connect_timeout` (15 s default); audited. |
| Auth failure | `ssh_auth_failed`; audited; no retry loop. |
| Command timeout | Channel closed; `ssh_command_timeout`; remote process may continue; audited. |
| Transfer timeout | SFTP stream aborted after 300 s; `ssh_transfer_timeout`; partial remote file removed/replaced atomically; audited. |
| Output exceeds cap | Tail dropped; `truncated` flags; result still returned. |
| Upload/download too large | `ssh_file_too_large`; checked before transfer. |
| Local path escape | `ssh_path_not_allowed`; no read/write. |
| Remote path escape | `ssh_path_not_allowed`; no transfer. |
| Approval pending | `ssh_approval_pending` after 30 s; approval remains for 5 min; retry reuses it. |
| Approval rejected | `ssh_approval_rejected`; no connection; audited. |
| Approval expired | `ssh_approval_expired`; a new request is needed. |
| Busy / rate limit | `ssh_busy` / `ssh_rate_limited`; audited. |
| Coordinator restart | In-flight SSH operations fail; pending approvals/grants persist; the next call reconnects. |
| DB error | Fail closed; structured error where possible; no connection without an authorization read. |

## 17. Quality attributes and verification scenarios

| ID | Scenario | Mechanism |
| --- | --- | --- |
| Q1 | An allowed host with an active grant executes `ssh_exec` and returns up to 128 KiB within the command timeout (default 60 s, max 300 s); the whole call, including a 30 s approval wait, fits inside the `hanse` MCP timeout; coordinator overhead p95 < 500 ms excluding network/command. | `ssh2` per-call connection, output caps, 600 s MCP timeout in `OPENCODE_CONFIG_CONTENT`. |
| Q2 | A host outside the app's allowlist returns `ssh_host_not_allowed` within 50 ms and opens no connection. | DB check before connect. |
| Q3 | A stored private key never appears in an HTTP response, MCP result, log, runtime spec, or app container file. | Status-only store; `ssh2` in-memory key; tests scan responses/logs; container mount audit. |
| Q4 | A changed host key aborts before authentication and records `ssh_host_key_mismatch`; a failed authentication of a fresh host writes no pin. | `hostVerifier` compare/capture; pin persisted only after `ready`; audit. |
| Q5 | The operator approves within 30 s and the tool returns the command result within 1 s of the decision. | Blocking wait on the grant/approval row. |
| Q6 | 10 concurrent calls to one host do not exceed 1 in-flight operation; excess returns `ssh_busy` after 5 s. | Per-host semaphore. |
| Q7 | A 51 MiB upload is rejected before transfer; a 50 MiB upload succeeds. | `stat` size check + streaming cap. |
| Q8 | A local path outside the app directory, a symlink-flip race, and a remote path outside `remote_root` are all denied. | dirfd-relative `O_NOFOLLOW` open + fd containment; remote normalization + mandatory `realpath`/`lstat`. |
| Q9 | After 30 minutes without operations, the grant expires and the next call asks again; after 8 hours, it always asks. | Idle/absolute grant checks. |
| Q10 | An agent token calling a human-only host/grant/approval route gets `403`. | Existing human principal checks. |
| Q11 | The coordinator restarts; pending approvals/grants persist; the next operation works after re-approval/active grant. | SQLite persistence; no in-memory grant state. |
| Q12 | A real agent runs a >60 s command and an approval wait under opencode 1.19.3 without a client-side timeout; the MCP timeout is 600 s. | explicit `McpLocalServer.timeout`; live agent QA. |
| Q13 | A failed authentication on a fresh host writes no pin; a successful `ignorePin` test writes a 10-minute pending observation; re-pin consumes it. | pin-after-`ready`; pending observation table/columns; transaction. |
| Q14 | Concurrent direct `/internal/mcp` requests create one pending approval and one grant; approve/reject race yields one winner. | partial unique index, unique `approval_id`, `BEGIN IMMEDIATE`. |

## 18. Testing strategy

- **Unit:** key validation (RFC/edge cases), encryption round trip, host-key fingerprint comparison,
  grant idle/absolute math, path normalization/containment (local and remote), dirfd path helper with
  a symlink-flip harness plus `..`, repeated-`..`, absolute, NUL, empty-component, and
  directory-swap cases, command/output caps, tool schemas, error-code mapping.
- **Integration:** an in-process `ssh2` server with a generated host key and a test user. Cover exec,
  non-zero exit, stdout/stderr caps, timeout, upload/download, host-key pin after auth, mismatch,
  auth failure writes no pin, failed `ignorePin` test writes no observation, successful test/re-pin,
  remote path escape, local path escape (including a race harness), file size, concurrency, rate
  limit.
- **Approval:** pending → approve → execute; pending → reject; pending → timeout → retry → approve;
  expiry; dedupe by command hash; a different command creates a new card; agent token cannot decide;
  approve is idempotent; conflicting decision `409`; parallel direct-HTTP dedupe/decision race;
  supersede other pending rows; cooldown after rejection; per-app pending cap.
- **Security:** key never in responses/logs/spec; agent cannot select address/user/port; sibling app
  cannot see hosts/audit; human-only routes reject agent tokens with `403` (and every new route is
  tested); host-key mismatch fails; pin only after auth; re-pin requires the pending observation;
  audit survives host and app deletion; audit pre-insert/orphan recovery.
- **Migration:** apply v9 after v7/v8; tables/indexes/constraints exist; foreign-key cascades;
  existing data intact; `test/migrations.test.ts` expects 9.
- **MCP timeout:** a real-agent QA scenario with an approval wait and a >60 s command verifies the
  600 s `hanse` timeout; a unit test asserts the overlay contains the timeout.
- **UI QA:** host registry, app grants, chat approval card at 390/768/1440 in dark/light; keyboard
  focus; no duplicate DOM ids; zero console/page errors. Reuse the existing capture/QA harness where
  practical.
- **Verification:** `npm run lint && npm run typecheck && npm test && npm run build`.

## 19. Rollout and compatibility

- **Migration:** additive v9; no existing table changes. Existing apps have no grants and therefore
  no access. `runMigrations` tolerates the gap if 0010's v8 is not merged yet.
- **Coordinator upgrade:** deploys the new `SshService` and tools. Because the in-app MCP bridge is
  generic, no agent image rebuild is required. **An agent restart is required** to refresh
  `tools/list` and pick up the 600 s MCP timeout; it is not optional.
- **Stage 0010 interaction:** 0010 owns v8 and the `setting_secrets` store. This stage must not
  modify 0010's tables. If both stages are in flight, land 0010 first or keep the v9 gap; the plan
  records the chosen order.
- **Rollback:** revoke grants/delete hosts (or disable the feature by leaving no grants) and roll
  back the coordinator code. The additive tables remain unused; no existing behavior changes.
- **Operator runbook:** add hosts with a Test connection (pins the host key), grant them per app,
  decide approvals in chat, review audit. The deployment doc gains a short section.
- **No data migration:** no existing rows are transformed. Audit retention is operator-managed.

## 20. Open questions

None owner-level. The decided constants are: idle grant 30 minutes (5–120 per host), absolute cap
8 hours, pending approval 5 minutes, tool wait 30 seconds, connect timeout 15 seconds, command
default 60 seconds/max 300 seconds, transfer deadline 300 seconds, stdout/stderr 64 KiB each
(128 KiB total), file 50 MiB, per-host concurrency 1, global concurrency 4, 60 operations/hour per
`(app, host)`, 10 pending
approvals per app, 10 approval requests/hour per app, 60-second rejection cooldown,
600,000 ms MCP tool-call timeout, 10-minute pending host-key observation. The owner may override
these constants before implementation; they are recorded here so the plan is decision-complete.

## 21. Review

Design review: **PASS — design gate cleared** (`oracle`, 2026-10-21). The first pass required a
race-free local path helper (P0), pin-after-auth, stored re-pin observation, race-safe approval/grant
transactions, and an explicit MCP client timeout (P1), plus P2/P3 revisions. A focused re-review
found one remaining P0 — the dirfd walk did not explicitly reject `..`/absolute/NUL components —
plus three P2s (expired-pending rows versus the partial unique index, an unbounded SFTP transfer
against the 600 s MCP timeout, and a `handleInternalMcp`/identity wording contradiction). All were
folded: explicit component validation and tests, a `BEGIN IMMEDIATE` expired-row transition before
insert, a 300 s transfer deadline, and the additive `handleInternalMcp` identity wording. The final
confirmation reported PASS with no remaining P0/P1. Plan review is pending.
