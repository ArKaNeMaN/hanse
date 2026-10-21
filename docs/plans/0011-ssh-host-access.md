# Plan 0011 - SSH host access for agents

Status: **deployed** (`momus` plan gate PASS, 2026-10-21); implemented, verified, and deployed
to `deployment-host` as `sha-b844bc3`.

Design: [`docs/design/ssh-host-access.md`](../design/ssh-host-access.md). The design review passed
after revisions: race-free local path handling (P0), pin-after-auth, stored re-pin observation,
race-safe approval/grant transactions, and an explicit MCP client timeout (P1), plus the P2/P3
revisions. Owner decisions are in design §4; there are no open questions.

Plan reviewer: `momus`. Implementation is blocked until the plan review passes.

Project profile bindings:

| Binding | Value |
| --- | --- |
| Design reviewer | `oracle` |
| Plan reviewer | `momus` |
| Design docs | `docs/design/`, index `docs/design/README.md` |
| Plans | `docs/plans/`, index `docs/plans/README.md` |
| Decision records | `docs/decisions/NNNN-<slug>.md` |
| Stage journal | `docs/journal/`, index `docs/journal/README.md` |
| Open questions | `docs/open-questions.md` (none for this stage) |
| Language | English |
| Verification | `npm run lint`, `npm run typecheck`, `npm test`, `npm run build` |
| Commit policy | one stage code commit (code + tests + docs); one docs-only deploy-record commit after the deployment-host deployment, per `docs/process.md` |

Owner decisions carried into this plan:

1. Arbitrary commands via `ssh_exec`; the SSH user's privileges and the optional approval are the
   boundary.
2. Per-host `require_approval`; approval grants an idle-based `(app, host)` grant (30 min idle,
   8 h absolute).
3. Approval card in chat, app-scoped (the MCP call does not carry the opencode session id).
4. Automatic TOFU host-key pinning; explicit re-pin on mismatch.
5. Per-app grants only; no project inheritance.
6. Coordinator-hosted execution; no separate gateway.
7. `ssh2` dependency; 600,000 ms MCP tool-call timeout.
8. v1 uses the 5-second chat polling fallback for approvals; no coordinator-originated SSE frame.

## 1. Global invariants

1. The host private key never enters the app container: not in the runtime spec,
   `OPENCODE_CONFIG_CONTENT`, app env, app agents root, logs, tool results, or the audit. It is
   decrypted only inside `SshService` and passed to `ssh2` in memory.
2. The app token identifies the app; every SSH call re-checks `app_ssh_hosts` in the DB. The agent
   cannot choose an address, user, port, or key, and cannot approve its own request.
3. Local upload/download paths are resolved with the dirfd-relative helper: `O_NOFOLLOW` component
   walk, explicit rejection of `.`/`..`/empty/absolute-outside/NUL/control components, fd
   verification before reading, and a held destination dirfd for temp+rename. No
   `realpath`-then-open path remains. A FIFO source is opened with `O_NONBLOCK` and rejected by
   `fstat` so a malicious app cannot hang the coordinator.
4. Host-key pins are written only after authentication (`ready`); a failed auth writes no pin. A
   mismatch fails closed. Re-pin consumes a 10-minute pending observation written by a successful
   `ignorePin` test.
5. Approval and grant writes are transactional: partial unique pending index, unique `approval_id`,
   `BEGIN IMMEDIATE`, conditional `UPDATE ... changes`, expired-row transition, supersede, and
   `SQLITE_BUSY` mapping.
6. Every operation has a pre-inserted audit row updated in `finally`; startup marks orphaned rows
   `interrupted`; audit rows survive host/app deletion. Host CRUD and approval decisions are audited.
7. All human routes are human-only; agent tokens get `403`; the only agent-facing HTTP route is
   `/internal/mcp`. `isSshRoute` is dispatched before `isChat` and the generic chain.
8. The MCP `hanse` entry carries `timeout: 600000`; the agent must restart to see the tools and the
   timeout. No app image rebuild is needed.
9. The stage is additive: migration v9 only, no changes to 0010's tables. `runMigrations` tolerates
   the v8 gap while 0010 is uncommitted.
10. Every phase leaves `npm run lint && npm run typecheck && npm test && npm run build` green.

## 2. Non-goals

- A separate SSH gateway, jump hosts, agent/X11/port forwarding, interactive shells, password auth,
  passphrase-protected keys, host groups, multiple credentials/users per host, project-level grants,
  command allowlists, egress filtering, automatic rotation, in-flight kill on revoke, multi-user
  RBAC, and recursive/resumable transfers.
- Coordinator-originated SSE for approvals (v1 uses the 5-second polling fallback).
- Hard-denying the coordinator's own address (warning + residual risk only; owner may add a policy
  later).
- Changing the app image. Only the coordinator image and the MCP overlay change; agents restart.

## 3. Prerequisites and isolation

- **Worktree:** implement in a clean worktree of `HEAD` (`stage/0011-ssh-host-access`), not in the
  main working tree, which contains another agent's in-progress stage 0010 phase 1. Do not stage,
  commit, or format 0010 files. The main tree's 0010 changes are not part of this stage.
- **Migration baseline:** in this worktree `MIGRATIONS` ends at **v7**; stage 0010's v8 is
  uncommitted elsewhere. This stage adds **v9** and leaves the v8 gap. `runMigrations` applies by
  version and tolerates the gap:
  - fresh DB: `runMigrations` returns **8** (v1-v7 + v9); versions are `[1,2,3,4,5,6,7,9]`;
  - the existing v5-upgrade test returns **3** (v6, v7, v9);
  - if v8 is later present: fresh returns **9**, versions `[1..8,9]`, v5 upgrade returns **4**.
  Update `test/migrations.test.ts` to the counts of the tree it runs in; do not assume 9 on a
  fresh v7 tree.
- **Dependencies:** add `"ssh2": "^1.17.0"` to `dependencies` and `"@types/ssh2": "^1.15.6"` to
  `devDependencies` (the `ssh2` package ships no types). Install in the isolated worktree only; never
  in the main tree's `node_modules`.
- **Key validation:** the coordinator image already has `/usr/bin/ssh-keygen` and `OpenSSH_10.0p2`
  (verified locally with `docker run --rm --entrypoint sh ghcr.io/arkaneman/hanse:latest -c
  'command -v ssh-keygen; ssh -V'`). If the deployed image lacks it, add `openssh-client` to the
  runtime stage (after `apt-get update`) and record the deviation; no fallback to an ambient key.
- **Baseline:** `npm run typecheck` and `npm test` are green before phase 1 except a known flaky
  `test/permission-policy.test.ts` case that passes in isolation; rerun the full suite before
  declaring a failure.
- **`ssh2` install/build:** the image `deps` stage has `python3`/`make`/`g++` for `better-sqlite3`;
  `ssh2`'s optional native pieces build there. Pin `ssh2` in `package-lock.json`.

## 4. Phase 1a - Schema, stores, key material, path helper

### 4.1 Files

- `src/store/migrations.ts`: append v9 `ssh-hosts` migration with `ssh_hosts`,
  `ssh_host_credentials`, `app_ssh_hosts`, `ssh_approvals`, `ssh_grants`, `ssh_audit`, and the
  indexes from design §8 (including the partial unique pending index and the unique grant
  `approval_id`).
- `src/ssh/types.ts`: row/status/input types, error codes, constants:
  `IDLE_DEFAULT_SEC = 1800`, `IDLE_MIN_SEC = 300`, `IDLE_MAX_SEC = 7200`,
  `ABSOLUTE_GRANT_SEC = 8*3600`, `PENDING_APPROVAL_SEC = 300`, `APPROVAL_WAIT_MS = 30_000`,
  `TRANSFER_TIMEOUT_MS = 300_000`, `MCP_TIMEOUT_MS = 600_000`, `CONNECT_TIMEOUT_MS = 15_000`,
  `COMMAND_DEFAULT_SEC = 60`, `COMMAND_MAX_SEC = 300`, `COMMAND_MAX_BYTES = 16*1024`,
  `OUTPUT_CAP_BYTES = 64*1024`, `AUDIT_PREVIEW_BYTES = 4*1024`,
  `FILE_CAP_BYTES = 50*1024*1024`, `PENDING_PER_APP = 10`, `APPROVAL_REQUESTS_PER_HOUR = 10`,
  `REJECT_COOLDOWN_SEC = 60`, `OPERATIONS_PER_HOUR = 60`, `WAITERS_PER_APPROVAL = 2`,
  `GLOBAL_INFLIGHT = 4`, `PER_HOST_INFLIGHT = 1`, `BUSY_WAIT_MS = 5_000`.
- `src/ssh/store.ts`: `SshStore` with host/credential/grant/approval/audit queries. Bound
  parameters; select cipher/nonce only for an explicit credential read; never `SELECT *` into a
  status response. Enable `secure_delete` and checkpoint the WAL on credential replace/delete
  (matching `ProviderKeyStore`).
- `src/ssh/keys.ts`: private-key validation (1 byte–32 KiB, LF-normalized, no NUL/control except
  newline, begin/end markers, no public keys/certificates, passphrase rejection with clear error),
  `ssh-keygen -y -P ""` and `ssh-keygen -lf` in a `0600` temp dir with a 5 s timeout and `finally`
  cleanup; derive public key/fingerprint/type/bits; accept Ed25519/ECDSA/RSA >= 2048, reject DSA.
- `src/ssh/paths.ts`: `openAppFile(appDir, userPath)` / `openAppDestination(appDir, userPath)`
  dirfd helpers; reject `.`/`..`/empty/absolute-outside/NUL/control; walk with
  `O_NOFOLLOW`/`O_DIRECTORY`; verify `/proc/self/fd` confinement; `O_RDONLY|O_NOFOLLOW|O_NONBLOCK`
  + `fstat` for the source (reject FIFO/dir/non-regular); held destination dirfd for temp+rename
  (`0600`); remote path normalizer.
- Tests: `test/ssh-store.test.ts`, `test/ssh-keys.test.ts`, `test/ssh-paths.test.ts`, update
  `test/migrations.test.ts`.
- Migration test: v9 tables/indexes/cascades; fresh count 8 / versions `[1..7,9]`; v5 upgrade 3;
  `PRAGMA foreign_keys` already ON.

### 4.2 Acceptance criteria

- `npm run typecheck` and the new store/key/path tests pass.
- A host credential is sealed; a status read returns the public key/fingerprint/type/bits and never
  the private key/ciphertext; deleting the host cascades the credential.
- The dirfd helper rejects `..`, repeated `..`, absolute-outside, NUL, empty components, symlinks,
  directory-swap, and a FIFO source does not block (`O_NONBLOCK` + `fstat`).
- `test/migrations.test.ts` asserts the fresh/v5 counts and versions for the current tree (8 /
  `[1..7,9]` / 3; 9 / `[1..8,9]` / 4 if v8 is present).
- `npm run lint && npm run typecheck && npm test && npm run build` green.

### 4.3 Verification

```bash
npm run lint && npm run typecheck && npx vitest run test/ssh-store.test.ts test/ssh-keys.test.ts \
  test/ssh-paths.test.ts test/migrations.test.ts && npm test && npm run build
```

## 5. Phase 1b - Host registry service, API, page shell

### 5.1 Files

- `src/ssh/service.ts`: host registry portion only: `listHosts`, `getHost`, `createHost`,
  `updateHost`, `deleteHost`, `listAudit`; create host + credential in one transaction. No
  `testHost`/`rePin`/approvals yet.
- `src/http/ssh.ts`: `isSshRoute`, `handleSsh` host list/create/update/delete JSON + HTML; human
  auth; status-only responses; host-creation warning text ("do not target the coordinator host or a
  host that can read coordinator state"); no test/rePin/approvals yet.
- `src/http/handler.ts`: add `ssh?: SshService` to `HttpDeps`.
- `src/cli/commands.ts`: construct `SshService` with `db`, `secretKey`, `workspaceRoot: workspace`,
  `agentsHome: path.resolve(agentsHome())`; pass `ssh` to `createHttpServer`.
- `src/http/server.ts`: dispatch `isSshRoute` before `isChat`/generic; await `handleSsh`.
- `src/http/ui.ts`: add `"ssh"` to the active union and a "SSH" nav item.
- `src/http/ssh.ts` page shell for `/ssh` (host table + add form; grants/approvals/audit later).
- Tests: `test/ssh-http.test.ts` (host CRUD, page, anonymous 401/redirect, agent token 403, no
  secret in HTML/JSON), `test/ssh-store.test.ts`.

### 5.2 Acceptance criteria

- A host can be created with a private key; the response contains the public key/fingerprint and
  never the private key/ciphertext; the DB row is sealed.
- `PATCH` with a new key replaces the credential status; `DELETE` cascades credentials and grants;
  audit rows remain.
- `/ssh` and `/api/ssh/hosts` are human-only: anonymous `401`/redirect, agent token `403`.
- The host-creation UI shows the coordinator-host warning.
- The new pages/API never include `cipher`, `nonce`, or the private key.
- All gates green.

### 5.3 Verification

```bash
npm run lint && npm run typecheck && npx vitest run test/ssh-http.test.ts test/ssh-store.test.ts \
  test/migrations.test.ts && npm test && npm run build
```

## 6. Phase 2 - Connection, exec, host-key pinning, test/re-pin, audit

### 6.1 Files

- `src/ssh/connection.ts`: injectable `ssh2` client factory; connect options (`readyTimeout` 15 s,
  keepalive, `algorithms.serverHostKey` allowlist Ed25519/ECDSA/RSA-SHA2, `hostVerifier` capture/
  compare, no agent/PTY); fingerprint and canonical host-key helpers.
- `src/ssh/service.ts`: `exec(agent, input)`:
  - authorize allowlist and active grant (grant may be inserted by a test/manual fixture in this
    phase; full approval flow in phase 3a);
  - acquire the per-host/global slot; pre-insert `ssh_audit`; decrypt the key; connect; persist the
    first pin only after `ready`; run `client.exec` with no PTY; cap stdout/stderr; timeout; map
    errors; update the audit in `finally`.
  - `testHost(hostId, { ignorePin? })`, `rePin(hostId, fingerprint)`: plain test on an unpinned host
    pins after successful auth and never replaces an existing pin; `ignorePin` writes a 10-minute
    pending observation only on success; re-pin consumes it in one `BEGIN IMMEDIATE` transaction and
    audits old/new. Failed auth writes no pin/observation.
  - `host_key_mismatch_at` on mismatch; clear on a later correct authenticated connection; address/
    port change clears the pin and pending observation.
  - Host CRUD/decision audit writes (host create/update/delete, test, re-pin).
- `src/http/ssh.ts`: `POST /api/ssh/hosts/:id/test` (plain/`ignorePin`),
  `POST /api/ssh/hosts/:id/re-pin`; human-only; status-only.
- Tests: `test/ssh-service.test.ts` with an in-process `ssh2` server (generated host key; exec,
  non-zero exit, caps, command/connect timeout, auth failure no pin, mismatch, pin-after-auth,
  address/port clears pin, decrypt failure `ssh_credential_unavailable`, non-allowlisted host
  returns `ssh_host_not_allowed` without connecting, audit survives host deletion, audit
  pre-insert/finally/orphan/interrupted, host CRUD audit, secure_delete/WAL).
- Extend `test/ssh-http.test.ts` for test/re-pin plain/ignorePin and auth failure.

### 6.2 Acceptance criteria

- `SshService.exec` on an allowed host with an active grant returns `{ok, exit_code, stdout, stderr,
  truncated, duration_ms}`; non-zero exit is not a protocol error; a non-allowlisted host opens no
  connection and returns `ssh_host_not_allowed`. The MCP `ssh_exec` wrapper is added in phase 3b.
- A first authenticated connection pins the host key; a failed authentication writes no pin; a
  mismatch returns `ssh_host_key_mismatch` and records the presented fingerprint; a later correct
  auth clears `host_key_mismatch_at`.
- `test` with `ignorePin` writes a 10-minute pending observation only on success; `re-pin` requires
  a matching, unexpired observation and updates old/new in one transaction; stale/forged
  fingerprints are rejected; changing `address`/`port` clears the pin/observation.
- Credential decrypt failure returns `ssh_credential_unavailable`; no ambient key/agent fallback.
- `ssh_audit` has a row before connect, is updated in `finally`, survives host deletion, and orphan
  rows become `interrupted` after restart; host CRUD/test/re-pin audited.
- The private key never appears in results/audit/logs; the audit stores bounded previews/
  fingerprints.
- All gates green.

### 6.3 Verification

```bash
npm run lint && npm run typecheck && npx vitest run test/ssh-service.test.ts test/ssh-http.test.ts \
  test/ssh-keys.test.ts && npm test && npm run build
```

## 7. Phase 3a - Approvals, grants, and human routes

### 7.1 Files

- `src/ssh/approvals.ts`: request/dedupe/expire/cooldown/pending-cap/supersede/decision/grant/revoke
  logic; `BEGIN IMMEDIATE` transactions; expired-row transition before insert; `SQLITE_BUSY` →
  `ssh_busy`; idle/absolute grant math; 30-second wait polling; 2-waiter cap; 60 ops/hour counted
  from `ssh_audit`; 5-second chat polling data.
- `src/ssh/service.ts`: `requestApproval`, `decideApproval`, `activeGrant`, `revokeGrant`,
  `listApprovals`; extract one shared `withAuthorizedOperation` pipeline
  (allowlist -> approval/grant -> per-host/global slot -> audit pre-insert/finally -> grant idle
  refresh) and use it for `exec` now and `upload`/`download` in phase 4. `require_approval=true`
  without a grant asks; `require_approval=false` executes directly. Approval decisions audited.
- `src/http/ssh.ts`: `GET /api/projects/:projectId/apps/:appKey/ssh`,
  `POST /api/projects/:projectId/apps/:appKey/ssh` (replace allowlist in a transaction; removing a
  host revokes grants and expires pending approvals),
  `POST /api/projects/:projectId/apps/:appKey/ssh/grants/:id/revoke`,
  `GET /api/apps/:app/ssh/approvals?project=<id>`,
  `POST /api/apps/:app/ssh/approvals/:id/decision?project=<id>`,
  `GET /api/apps/:app/ssh/audit?project=<id>&limit=...&before=...`,
  `GET /api/ssh/approvals/count`; human-only, agent 403; app-scoping check on decisions and audit.
- `src/http/ui.ts`/`src/http/ssh.ts`: host page grants/approvals sections; app-page link.
- Tests: `test/ssh-approvals.test.ts` (approve/reject/timeout/expiry/dedupe/cooldown/caps/
  supersede/60 ops/2 waiters/global 4/per-host 1/5 s busy/require_approval=false/parallel direct
  HTTP), extend `test/ssh-http.test.ts` (grant replace/revoke, audit/count routes, agent 403).
- `test/migrations.test.ts` unchanged at this phase.

### 7.2 Acceptance criteria

- `SshService.listHosts`/`exec` only see/execute allowed hosts; `require_approval=false` skips the
  card; `require_approval=true` without a grant returns `ssh_approval_pending` after 30 s; approve
  creates exactly one grant and executes; reject returns `ssh_approval_rejected`; retry after
  approval executes without a new card. The MCP tools wrapping these methods are exercised in phase
  3b.
- Parallel direct `/internal/mcp` requests create one pending approval; approve/reject races have
  one winner; `SQLITE_BUSY` maps to `ssh_busy`; the 2-waiter, 10-pending/app, 10-requests/hour,
  60-second cooldown, 60-ops/hour, global-4/per-host-1/5 s-busy limits are tested.
- Replacing the app allowlist is transactional; removing a host revokes grants and expires pending
  approvals; `revokeGrant` stops new calls.
- Audit rows survive host/app deletion; host CRUD/test/re-pin/decision audited.
- All human SSH routes return `403` for agent tokens; app-scoped audit/count routes are correct.
- All gates green.

### 7.3 Verification

```bash
npm run lint && npm run typecheck && npx vitest run test/ssh-approvals.test.ts test/ssh-http.test.ts \
  test/ssh-service.test.ts && npm test && npm run build
```

## 8. Phase 3b - MCP tools, async route, timeout

### 8.1 Files

- `src/mcp/protocol.ts`: export the base `TOOLS`/`handleRpc` (no behavior change) for the wrapper.
- `src/mcp/ssh-protocol.ts`: `SSH_TOOLS` initially contains only `ssh_list_hosts`/`ssh_exec`;
  `handleRpcAsync` — `tools/list` merges base + SSH tools; `tools/call` handles those two async and
  delegates everything else to the sync `handleRpc` with `{ fromAppKey: agent.appKey }`; stable
  prefixed error codes. Phase 4 adds `ssh_upload`/`ssh_download` here.
- `src/http/handler.ts`: export/reuse the token verification helper; remove the old `/internal/mcp`
  branch from `route()`; keep `HttpDeps.ssh`.
- `src/http/internal-mcp.ts`: async `handleInternalMcp` — parse, `verifyAgentToken`, build
  `CoordinatorService`, call `handleRpcAsync` with `{ agent }`; 204 for notifications; 401 for invalid
  tokens.
- `src/http/server.ts`: `isInternalMcp` before the generic chain; `isSshRoute` before `isChat`.
- `src/opencode/instance.ts`: `McpLocalServer.timeout?: number`; the `hanse` entry gets
  `timeout: 600_000`.
- `src/opencode/manager.ts`: ensure the coordinator MCP entry carries the timeout (if the overlay
  builder takes it as an option).
- Tests: `test/ssh-mcp.test.ts` (tool list/call/async route/delegation/timeout/agent identity),
  update `test/mcp-http.test.ts` to exercise `handleInternalMcp`/the async HTTP route and retain
  401/204/parse-error coverage, update `test/mcp.test.ts`/`test/mcp-remote.test.ts` only if they
  call the removed branch.
- Verification command includes `test/mcp-http.test.ts`.

### 8.2 Acceptance criteria

- `ssh_list_hosts` returns only allowed hosts; `ssh_exec` is available through the `hanse` MCP
  server; non-SSH tools delegate unchanged. `ssh_upload`/`ssh_download` are registered in phase 4
  after their service methods exist.
- The async `/internal/mcp` route returns the same responses for base tools, 204 for notifications,
  401 for invalid tokens; the old synchronous branch is gone and `test/mcp-http.test.ts` is updated.
- The agent token gets `403` on every human SSH route; `isSshRoute` is before `isChat`.
- `OPENCODE_CONFIG_CONTENT.mcp.hanse.timeout === 600000`; `McpLocalServer` has the optional field;
  the local stdio `handleRpc` remains sync and its tests pass.
- All gates green.

### 8.3 Verification

```bash
npm run lint && npm run typecheck && npx vitest run test/ssh-mcp.test.ts test/mcp-http.test.ts \
  test/mcp.test.ts test/mcp-remote.test.ts test/ssh-http.test.ts && npm test && npm run build
```

## 9. Phase 4 - SFTP upload/download

### 9.1 Files

- `src/ssh/service.ts`: `upload`/`download` using `ssh2` SFTP, the dirfd local helper, remote path
  normalization/`remote_root`/`realpath`/`lstat`, size caps, temp+rename, `chmod 0600`, 300 s
  transfer deadline covering the whole SFTP operation. Both run through the same
  `withAuthorizedOperation` pipeline as `exec`: the `app_ssh_hosts` allowlist, the
  `require_approval`/active-grant check (action `upload`/`download`), the per-host/global slot, the
  pre-inserted audit row updated in `finally`, and the grant idle refresh. They return
  `ssh_approval_pending`/`ssh_approval_rejected` like `exec`.
- `src/mcp/ssh-protocol.ts`: add `ssh_upload`/`ssh_download` to `SSH_TOOLS` and their async
  `handleRpcAsync` dispatch after the service methods exist.
- `src/ssh/paths.ts`: local source/destination fds; remote path validator.
- Tests: `test/ssh-sftp.test.ts` with a fake SFTP client (injected `connect`) and local temp dirs;
  local `..`/absolute-outside/NUL/empty/symlink/FIFO cases; remote escape/symlink; size; atomic
  write; transfer timeout; upload/download approval-pending/rejected, audit pre-insert/finally, and
  grant idle refresh. Extend `test/ssh-approvals.test.ts` and `test/ssh-mcp.test.ts` for the two
  new actions/tools.
- Extend `test/ssh-service.test.ts` for the transfer deadline/remote rules.

### 9.2 Acceptance criteria

- A ≤50 MiB file uploads to an allowed path and a >50 MiB file is rejected before transfer.
- Download writes atomically inside the app dir with mode 0600 and rejects symlinks/directories.
- Local `..`/absolute-outside/NUL/empty/symlink/FIFO paths are rejected or do not block; a symlink
  swap cannot escape.
- Remote paths outside `remote_root`, symlinks, and non-regular files are rejected; a transfer over
  300 s returns `ssh_transfer_timeout` and cleans the temp.
- `ssh_upload`/`ssh_download` run through the same allowlist/approval/grant/slot/audit/idle pipeline
  as `exec`; a `require_approval` host returns `ssh_approval_pending` for an upload/download without
  a grant, and a successful transfer refreshes the grant idle window and is audited.
- `ssh_upload`/`ssh_download` are listed and callable through the `hanse` MCP server; their MCP
  tests pass.
- All gates green.

### 9.3 Verification

```bash
npm run lint && npm run typecheck && npx vitest run test/ssh-sftp.test.ts test/ssh-service.test.ts \
  test/ssh-paths.test.ts test/ssh-approvals.test.ts test/ssh-mcp.test.ts && npm test && npm run build
```

## 10. Phase 5 - UI

### 10.1 Files

- `src/http/ssh.ts`: full `/ssh` page — host registry (list/add/edit/delete/test/re-pin), host
  warning, app grants (project/app selector + checkboxes, revoke), pending approvals
  (approve/reject), audit table; `assets/ssh.js` for test/re-pin JSON forms; add it to the `ASSETS`
  allowlist in `src/http/handler.ts`.
- `src/http/application.ts` (`renderApplication`): "SSH access" panel with allowed-host count,
  active grants, pending approvals, and a link to `/ssh?project=<id>&app=<key>`. `src/http/apps.ts`
  only holds discovery helpers; do not add the panel there.
- `src/http/dashboard.ts`/`src/http/ui.ts`: global unexpired-pending count in `buildSite`/`ShellOptions`
  and the "SSH" sidebar count; dashboard card/link.
- `src/http/chat.ts`: `<div class="ssh-approval-slot" id="chat-ssh-approvals" hidden></div>` above
  the prompt dock/composer.
- `assets/chat.js`: poll `/api/apps/<app>/ssh/approvals?project=<id>` every 5 s while the chat is
  open; render pending cards with host/action/full command (escaped, scrollable), expiry, Approve/
  Reject; POST the decision; update/hide; use existing card/button classes; stop on page hide.
- `src/http/styles.css`: minimal `.ssh-command` scroll/pre-wrap and `.ssh-approval-slot` spacing;
  reuse existing primitives.
- Tests: `test/ssh-http.test.ts` (page/API/grant/revoke/approval/audit/count, no secrets, agent 403),
  `test/application-ssh.test.ts` (application page SSH panel/count/link), `test/chat-ssh-asset.test.ts`
  (asset contains poll/card; chat page contains slot).
- UI QA: extend `docs/design/chat-qa.mjs` with an SSH approval fixture (card appears, Approve POSTs,
  card hides, screenshots 390/1440 dark/light, no duplicate ids/console errors). If Playwright is
  unavailable, record exact manual steps and screenshots at 390/768/1440 dark/light for `/ssh` and
  the chat card, including duplicate-id and console-error checks.

### 10.2 Acceptance criteria

- `/ssh` is human-only and renders hosts, grants, pending approvals, audit, and the host warning; the
  private key is write-only and never appears in HTML/JSON.
- The app page shows the SSH panel/count and links to `/ssh`; the sidebar/dashboard shows the pending
  count.
- The app grants form replaces `app_ssh_hosts` in a transaction; removing a host revokes grants and
  expires pending approvals; revoke works.
- The chat card appears within 5 s, shows the full command (escaped), and approve/reject updates the
  card and the tool result.
- Keyboard/focus behavior is sane; no duplicate DOM ids; no console errors; UI QA evidence recorded.
- All gates green.

### 10.3 Verification

```bash
npm run lint && npm run typecheck && npx vitest run test/ssh-http.test.ts \
  test/application-ssh.test.ts test/chat-ssh-asset.test.ts && npm test && npm run build
node docs/design/chat-qa.mjs   # if Playwright is available; otherwise the exact manual checklist
```

## 11. Phase 6 - Docs, gates, deploy, live QA, record

### 11.1 Files

- `docs/current-state.md`: SSH hosts, grants, approvals, tools, routes, constants, limits.
- `docs/deployment.md`: operator runbook (add host/test/pin, grants, approvals, audit), `ssh2`
  dependency, restart note, no new env vars.
- `docs/design/README.md`, `docs/plans/README.md`: index entries.
- `docs/decisions/0009-ssh-host-access-in-coordinator.md`: ADR for coordinator-hosted execution and
  the rejected gateway/runner alternatives.
- `docs/journal/0011-ssh-host-access.md`: stage record (context, decisions, artifacts, verification,
  deploy, open threads).
- `docs/journal/README.md`: index entry.
- `docs/open-questions.md`: no open items for this stage.
- `docs/deploy/deploy-log.md` (local, gitignored): deployment entry. It is **not** part of the
  docs-only commit; the committed record is the journal + current-state/deployment/index updates.

### 11.2 Gates

```bash
npm run lint
npm run typecheck
npm test
npm run build
```

### 11.3 Commit and publish

```bash
git status --short   # stage only this stage's files; never 0010's uncommitted files
git add <stage files>
git commit -m "feat(ssh): operator SSH hosts, per-app grants, approvals, and exec/SFTP"
git fetch origin
# rebase on origin/main if it moved; do not force-push
git push origin HEAD:main
gh run list --workflow=publish.yml --limit 3
# wait for the sha-<short> images for hanse, hanse-agent-default, hanse-agent-ide, hanse-runner
```

### 11.4 Deploy to deployment-host (exact checks)

Follow `docs/deploy/host.md` for the backup/archive steps; inline the checks here so the plan is
executable without the gitignored runbook:

1. Back up `state`, `workspace`, `agents`, `.env`, `compose.override.yaml`; tag rollback images.
2. `git archive --format=tar HEAD | ssh deployment-host 'tar xf - -C <INSTALL_DIR>'`; remove the old
   `docker-compose.yml`.
3. Set `HANSE_TAG=sha-<short>` (and `HANSE_AGENT_TAG` if needed); keep `HANSE_BIND`,
   `HANSE_HOST_WORKSPACE`, `HANSE_HOST_AGENTS`, `HANSE_RUNTIME_TOKEN`.
4. `docker compose pull && docker pull ghcr.io/arkaneman/hanse-agent-default:sha-<short> &&
   docker compose up -d --remove-orphans`.
5. Health check:
   ```bash
   TOKEN=$(ssh deployment-host 'sed -n "s/^HANSE_OPERATOR_TOKEN=//p" <INSTALL_DIR>/.env')
   curl -s -o /dev/null -w '/healthz %{http_code}\n' http://<LAN_HOST>:8787/healthz
   curl -s -o /dev/null -w '/ssh %{http_code}\n' -H "Cookie: hanse_token=$TOKEN" \
     http://<LAN_HOST>:8787/ssh
   curl -s -H "Cookie: hanse_token=$TOKEN" http://<LAN_HOST>:8787/api/ssh/hosts
   TABLES=$(ssh deployment-host 'docker exec hanse node -e "const D=require(\"better-sqlite3\");const d=new D(\"/data/state/hanse/coordinator.db\",{readonly:true});console.log(d.prepare(\"select name from sqlite_master where type = ?\").all(\"table\").map(r=>r.name).join(\"\\n\"))"')
   for t in ssh_hosts ssh_host_credentials app_ssh_hosts ssh_approvals ssh_grants ssh_audit; do
     echo "$TABLES" | grep -qx "$t" || { echo "missing $t"; exit 1; }
   done
   if echo "$TABLES" | grep -qx setting_secrets; then echo "0010 setting_secrets present"; fi
   AGENT_TOKEN=$(ssh deployment-host 'cat <INSTALL_DIR>/agents/<projectId>/<appKey>/mcp-token')
   curl -s -o /dev/null -w 'agent /api/ssh/hosts %{http_code}\n' \
     -H "Authorization: Bearer $AGENT_TOKEN" http://<LAN_HOST>:8787/api/ssh/hosts
   # expect 403
   ```
6. Restart each existing app so it picks up the new `tools/list` and the 600 s MCP timeout:
   ```bash
   curl -s -X POST -H "Cookie: hanse_token=$TOKEN" \
     "http://<LAN_HOST>:8787/api/apps/<appKey>/restart?project=<projectId>"
   ```
7. Live QA (best effort; record the result or an explicit waiver):
   - Start a temporary SSH target on the `front` network with a generated key:
     ```bash
     ssh-keygen -t ed25519 -N "" -f /tmp/hanse-qa-id
     docker run -d --rm --name hanse-ssh-qa --network <hanse-front-network> \
       -e PUID=1000 -e PGID=1000 -e USER_NAME=qa \
       -e PUBLIC_KEY="$(cat /tmp/hanse-qa-id.pub)" \
       -e PASSWORD_ACCESS=false lscr.io/linuxserver/openssh-server:latest
     ```
   - Add host `hanse-ssh-qa:2222`, user `qa`, the private key via `/ssh`/API; grant it to one app;
     restart the app; ask the agent to call `ssh_exec` with command `sleep 65` and
     `timeout_sec: 120` (the default 60 s would return `ssh_command_timeout`). Approve the card; if
     the first call returned `ssh_approval_pending`, retry it after approval, and assert a successful
     result after >60 s. Then delete the host/grant and `docker rm -f hanse-ssh-qa`, and remove
     `/tmp/hanse-qa-id*`.
   - If no safe target can be created, record an explicit waiver with the reason and the verified
     unit/overlay evidence.
8. Add the deploy log entry (image digest, rollback tag, backup path, health/smoke results) to the
   local `docs/deploy/deploy-log.md`.
9. Commit the docs-only deploy record (journal + current-state/deployment/index updates) and push.

### 11.5 Rollback

- Code: revert the stage commit; migrations are additive, so the old code ignores the new tables. If
  a schema rollback is required, drop the v9 tables and delete the `schema_migrations` v9 row;
  restore `state` from the pre-deploy backup if the DB is affected.
- Runtime: set `HANSE_TAG` back to the previous `sha-<previous>`, `docker compose pull && up -d`;
  restore `state`/`agents` from the backup if the migration or credentials were changed. Running
  apps must be restarted to drop the new MCP tools/timeout.
- Revoke all SSH grants or delete hosts to disable the feature without a code rollback.

## 12. Stage-level acceptance checklist

- [ ] Migration v9 applies cleanly after v7 (and v8 if 0010 is present); tables/indexes/cascades
      exist; fresh count/versions and v5 upgrade counts match the current tree; existing data
      untouched.
- [ ] Host CRUD, encrypted credential, public-key status, test/pin, re-pin, and audit work; no key
      material in API/HTML/logs/spec/tool results.
- [ ] `ssh_exec` arbitrary commands, timeouts, output caps, audit; auth-failure no pin; mismatch
      fail-closed; pin-after-auth; non-allowlisted host no connect; decrypt failure.
- [ ] Approvals: idle grant, absolute cap, 30 s wait, 5 s chat poll, approve/reject, expiry,
      dedupe, supersede, cooldown, 2-waiter/10-pending/10-request/60-ops/global-4/per-host-1 limits,
      parallel direct-HTTP races, require_approval=false.
- [ ] SFTP upload/download: local dirfd confinement (no `..`/symlink/FIFO escape), remote
      `remote_root`/realpath/lstat, size caps, atomic writes, 300 s transfer deadline.
- [ ] Human-only routes return 403 for agent tokens; `isSshRoute` before `isChat`; `/internal/mcp`
      is the only agent route; app-scoped audit/count/revoke routes.
- [ ] `OPENCODE_CONFIG_CONTENT.mcp.hanse.timeout === 600000`; local stdio MCP remains sync; agent
      restart documented and performed.
- [ ] UI: `/ssh`, app-page SSH panel/link, sidebar/dashboard pending count, chat approval card,
      audit; no secrets in HTML/JSON; keyboard/focus and browser QA evidence.
- [ ] All four gates green; docs/indexes/journal/ADR updated; deployment-host deployed with health checks,
      migration assertions, live QA/waiver, and deploy log.

## 13. Plan review

Status: **PASS** (`momus`, 2026-10-21); plan gate cleared after the revisions above. Implementation
is complete, verified, and deployed to `deployment-host`; the deployment is recorded in the stage journal.
