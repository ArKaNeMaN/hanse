# Security review - hanse 0.1.0

- Reviewer: maintainers (pre-release self-review).
- Scope: the coordinator core (stages 0-7).
- Status: reviewed; open risks accepted for a pre-alpha, single-owner deployment.

## Trust model

- Single owner, single OS user, **trusted** repositories. Applications are cloned and their code
  (including `opencode` plugins) runs on the host. A malicious application repository must be treated
  as able to run arbitrary code on the host.
- Isolation between applications is **logical** (separate `opencode` state via XDG + `OPENCODE_DB`),
  not OS-level. Containers/users are out of scope; documented as a non-goal.

## Controls in place

- **Config injection**: coordinator config is applied via `OPENCODE_CONFIG_CONTENT`, never committed
  into a managed repository. The coordinator MCP server name (`hanse`) is reserved.
- **Approvals**: cross-application writes can be gated; only a **human** principal may decide an
  approval (agents are rejected).
- **API authn**: mutating HTTP endpoints require a bearer token; a non-human principal receives 403.
- **Git workbench**: the application page and `/api/projects/:id/apps/:key/git/*` are human-only;
  agent principals receive 403. Mutations are JSON-only (plus `SameSite=Strict`) and request bodies
  are capped at 64 KiB; the `/api/skills*` routes alone accept 512 KiB for 48,000-character skill
  bodies, with per-field limits still applied. Git runs in the runner one-shot container with
  argument arrays, no shell,
  timeouts, bounded output, and per-repository serialization. The application directory must resolve,
  via `realpath`, to the repository toplevel inside the workspace; symlink/nested-repository escapes
  are rejected. Remote URLs and command output are redacted for URL userinfo before leaving the
  server.
- **Secrets at rest**: provider keys and git credentials are encrypted with AES-256-GCM; the key file
  lives outside the ciphertext (mode `0600`); tokens and private keys are never written into managed
  repositories. Git credential status responses and pages contain metadata only (public key,
  fingerprint, hosts, username).
- **SQL**: all statements use bound parameters.
- **Spawn safety**: the launcher spawns processes with argument arrays, never a shell string.

## Open risks (accepted, pre-alpha)

- Logical isolation does not contain a hostile agent; the secret vault is only as safe as the host.
- The HTTP API binds locally by default; remote exposure must go through a VPN or reverse proxy.
- The writer lock is an `O_EXCL` file with pid liveness (single node), not a distributed lock.
- No rate limiting or audit retention limits yet.

## Recommendations before any untrusted/multi-tenant use

- OS-level isolation per application (users/containers).
- Replace the local file lock with a fenced, kernel-backed lock if moving to multi-process coordination.
- Add a managed key store (OS keyring) for the secret key.

## Historical: pre-B1/B2 deployment (stages 8-19)

These findings describe the earlier single-container deployment. They are retained for history and
are **superseded** by the per-app container/runner model and by stage `0010-git-credentials`.

- Single operator login (operator token -> `hanse_token` cookie); no separate IDE password.
- The IDE runs in a separate `ide` container mounting only the workspace, so `/data/state` (DB,
  `secret.key`) is not present there. `/ide/?folder=` is confined to the workspace root at the proxy.
- The terminal's `HOME` is the opened folder (`shell/hanse-shell`).
- **Residual risk (historical):** `opencode` agents ran in the `hanse` container as the same uid as
  the coordinator and could read `/data/state` (DB, `secret.key`). Untrusted applications remained out
  of scope.
- **Git workbench risks (historical):** repository hooks executed as the coordinator;
  `git fetch --all --prune` contacted every configured remote with ambient credentials; the in-memory
  mutation lock did not cover agents/IDE writing to the same repository; `realpath`-then-exec was
  TOCTOU in a writable workspace; "Commit all" can include untracked files. These are superseded:
  app-repo git now runs in the runner one-shot sandbox, and credentials are per-app settings.

## Git credentials (stage 0010-git-credentials)

The authoritative design and threat model are
[`docs/design/git-credentials.md`](../design/git-credentials.md); the accepted decision is
[ADR-0009](../decisions/0010-agent-readable-git-credentials.md).

- **No ambient git credential.** `HANSE_GIT_*` credential/config variables, `HANSE_HOST_GIT_DIR`, and
  `HANSE_GIT_SSL_CAINFO` are removed. Fetch/push use the effective per-scope credential materialized
  into the app HOME; the one-shot workbench mounts that directory read-only and has no secret
  environment.
- **Agent-readable by design (accepted).** Each app can read its own
  `<home>/.config/hanse/git/{id,token,known_hosts}`. A compromised agent can use or copy its own
  credential. Mitigations: repository-scoped deploy keys (read-only unless push is required),
  fine-grained tokens with minimal permissions and an expiry, per-app isolation, and a documented
  rotation path.
- **HTTPS host allowlist.** The askpass releases the token only for an exact host in `https_hosts` and
  only for `https://` prompts; a changed remote or non-allowlisted host fails closed. This is not an
  egress control: the agent can read the token directly.
- **SSH.** The private key signs locally and is never sent to the remote. `-F /dev/null`,
  `IdentitiesOnly=yes`, `IdentityAgent=none`, `BatchMode=yes`, and no forwarding prevent ambient key
  or agent use. Optional `known_hosts` enables strict host pinning; without it, `accept-new` warns on
  first use and still rejects a changed key.
- **Test connection.** Draft credentials are written to an ephemeral `0700` directory under
  `HANSE_HOST_RUNNER_TMP`, mounted read-only, and removed in `finally`; a startup sweep handles stale
  directories. The test never writes settings or the managed app directory. A crash can leave a
  `0600` secret in the temp root until the sweep, so the temp root must not be shared or backed up.
- **Accepted residuals.** No AAD binding or key rotation (same as provider keys); `secure_delete` plus
  a WAL checkpoint cannot erase physical media/backups; the runner's path check is not atomic against
  a running app (the app owns its own credential directory); the web IDE terminal is out of scope.

## Current deployment (stages 8-19)

- No TLS; LAN-only.
