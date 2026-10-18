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
  are capped at 64 KiB. Git runs with argument arrays, no shell, timeouts, bounded output, and
  per-repository serialization. The application directory must resolve, via `realpath`, to the
  repository toplevel inside the workspace; symlink/nested-repository escapes are rejected. Remote
  URLs and command output are redacted for URL userinfo before leaving the server.
- **Secrets at rest**: git credentials are encrypted with AES-256-GCM; the key file lives outside the
  ciphertext (mode `0600`); tokens are never written into managed repositories.
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

## Current deployment (stages 8-19)

- Single operator login (operator token -> `hanse_token` cookie); no separate IDE password.
- The IDE runs in a separate `ide` container mounting only the workspace, so `/data/state` (DB,
  `secret.key`) is not present there. `/ide/?folder=` is confined to the workspace root at the proxy.
- The terminal's `HOME` is the opened folder (`shell/hanse-shell`).
- **Residual risk:** the `opencode` agents run in the `hanse` container as the same uid as the
  coordinator and can read `/data/state` (DB, `secret.key`). Untrusted applications remain out of scope.
- **Git workbench risks:** repository hooks execute as the coordinator; `git fetch --all --prune`
  contacts every configured remote with ambient credentials; the in-memory mutation lock does not
  cover agents/IDE writing to the same repository; `realpath`-then-exec is TOCTOU in a writable
  workspace; "Commit all" can include untracked files. These are accepted under the trusted-repository
  model. Push/fetch credentials are ambient and are not managed by this stage.
- No TLS; LAN-only.
