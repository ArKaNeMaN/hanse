# Stage 0011 - SSH host access

- Date: 2026-10-21
- Status: implemented, verified, and deployed to `deployment-host` as `sha-b844bc3`; deployment record in the
  local `docs/deploy/deploy-log.md`
- Design: [`docs/design/ssh-host-access.md`](../design/ssh-host-access.md)
- Plan: [`docs/plans/0011-ssh-host-access.md`](../plans/0011-ssh-host-access.md)
- Gate reviews: `oracle` design review (PASS after P0/P1 revisions); `momus` plan review (PASS
  after revisions)
- Owner decisions: [`docs/open-questions.md`](../open-questions.md) (no open items)
- Related: [`docs/decisions/0009-ssh-host-access-in-coordinator.md`](../decisions/0009-ssh-host-access-in-coordinator.md)

## Context

Agents could edit code and run commands inside their app container but had no way to reach
operator-managed servers. The owner wanted a global host registry (address, port, user, private
key), per-application grants, arbitrary SSH commands and file transfer, and a per-host
"ask permission" switch, with the private key never visible to the agent.

The design deliberately diverges from the git-credential model: host keys are coordinator-held and
executed through the keyless `hanse` MCP bridge, not materialized into the app HOME. The coordinator
was selected over a separate gateway because it already owns the database, `secret.key`, operator UI,
audit, and every app network; a gateway behind the coordinator would not improve compartmentalization
for a single-operator deployment.

## Delivered

- Migration v9 (`ssh-hosts`) with `ssh_hosts`, `ssh_host_credentials`, `app_ssh_hosts`,
  `ssh_approvals`, `ssh_grants`, and `ssh_audit`, including the partial unique pending-approval
  index, unique grant `approval_id`, and audit-survival (no FKs). Stage 0010's v8 is reserved; a clean
  v7 tree applies eight migrations and versions `[1..7, 9]`.
- `src/ssh/keys.ts` validates unencrypted Ed25519/ECDSA/RSA keys with `ssh-keygen`, rejects
  passphrases/DSA/short RSA, and derives the public key/fingerprint/type/bits.
- `src/ssh/paths.ts` uses dirfd-relative `O_NOFOLLOW` walks with explicit `.`/`..`/empty/
  absolute-outside/NUL rejection, `O_NONBLOCK` + `fstat` for FIFO-safe reads, and held-destination
  dirfd atomic writes; `src/ssh/connection.ts` pins host keys only after authentication and restricts
  host-key algorithms.
- `src/ssh/service.ts` implements host CRUD, test/re-pin, exec, SFTP upload/download, idle/absolute
  grants, approvals, audit, rate/concurrency limits, and one `withAuthorizedOperation` pipeline for
  all three actions. `src/ssh/store.ts` holds the transactional store.
- The `hanse` MCP server exposes `ssh_list_hosts`, `ssh_exec`, `ssh_upload`, and `ssh_download`; the
  async `/internal/mcp` route wraps the existing sync handoff tools, and the `hanse` overlay carries
  `timeout: 600000`.
- Human-only `/ssh` page and JSON API (hosts, grants/revoke, approvals/decision, audit, count),
  an application-page SSH panel, a sidebar/dashboard pending count, and an app-scoped chat approval
  card polling every five seconds.
- Tests: `ssh-paths`, `ssh-keys`, `ssh-service`, `ssh-approvals`, `ssh-http`, `ssh-mcp`,
  `application-ssh`, `chat-ssh-asset`, updated migration/store/MCP tests. The full suite is
  **1058 passing**; `npm run lint`, `npm run typecheck`, `npm test`, and `npm run build` are green.
- Local serve smoke: `/healthz` 200, anonymous `/ssh` 303, authenticated `/ssh` 200, and
  `/api/ssh/hosts` `{hosts:[]}` on an empty workspace.

## Decisions and residuals

- Arbitrary commands are intentional; the SSH user's privileges are the real boundary. The operator
  must not grant the coordinator host or a host that can read coordinator state or the Docker socket.
- Host-key pinning is TOFU on first authenticated use; a mismatch fails closed and requires an
  explicit Test + re-pin. Address/port changes clear the pin. Load-balanced multi-key addresses are
  not supported.
- Approvals are app-scoped and idle-based (30 min idle, 8 h absolute); the chat uses 5-second polling
  rather than a coordinator-originated SSE frame. Revocation does not kill an in-flight command.
- No SSH gateway, jump hosts, agent/port forwarding, password auth, passphrase keys, recursive
  transfers, or command allowlists. The app's own egress is not restricted.

## Deployment

Deployed to `deployment-host` as `sha-b844bc3`. The coordinator, IDE, runner, and default agent images were
published by the `Publish container` workflow and pulled with that tag. Pre-deploy backup:
`<BACKUP_DIR>/20261021-042428-pre-ssh/` (state, workspace, agents, env, compose override);
rollback tags `hanse:rollback-pre-ssh`, `hanse-agent-ide:rollback-pre-ssh`,
`hanse-runner:rollback-pre-ssh`; previous agent default `sha-02281c9` remains in GHCR.

Health: all three static services healthy, `/healthz` 200, anonymous `/` 303, `/login` 200, and
`/ssh`, `/settings`, `/api/projects` with the operator cookie 200. The SSH tables exist; the legacy
`secrets` table is untouched and `setting_secrets` is absent because stage 0010 is not in this
commit. An app `mcp-token` gets 403 on `/api/ssh/hosts`; `/internal/mcp` lists all four SSH tools;
the app overlay reports `mcp.hanse.timeout=600000`.

Live SSH QA used a temporary `linuxserver/openssh-server` on `hanse_front`: Test pinned the host
key, the approval API approved a pending `exec`, `echo QA_OK` returned exit 0, `sleep 65` with
`timeout_sec=120` returned `AGENT_LONG_OK` after 65 s, and a 15-byte upload/download round trip
succeeded. A real `opencode` turn called `hanse_ssh_exec` for `sleep 65` and got the completed result
after 65 s, confirming the 600 s MCP timeout. Audit rows survived host deletion. The temporary host
and container were removed.

Gates: `npm run lint`, `npm run typecheck`, `npm test` (1058), and `npm run build` are green.
