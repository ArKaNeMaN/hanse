# Stage 0010 - Git credentials

- Date: 2026-10-21
- Status: implemented, verified, and deployed to `deployment-host` as `sha-e2d89a2`; deployment record in the
  local `docs/deploy/deploy-log.md`
- Design: [`docs/design/git-credentials.md`](../design/git-credentials.md)
- Plan: [`docs/plans/0010-git-credentials.md`](../plans/0010-git-credentials.md)
- Gate reviews: `oracle` design review (PASS after revisions); `momus` plan review (PASS); `oracle`
  final code review (PASS after required fixes)
- Owner decisions: [`docs/open-questions.md`](../open-questions.md) (no open items)
- Related: [`docs/decisions/0010-agent-readable-git-credentials.md`](../decisions/0010-agent-readable-git-credentials.md)

## Context

Git fetch and push credentials were deployment-wide runner environment variables
(`HANSE_GIT_*`, `HANSE_HOST_GIT_DIR`). They could not differ per application, were absent from the
UI, and never reached the agent's own native `git`. The legacy `secrets` table existed but nothing
read it.

The owner chose Variant A: one SSH and one HTTPS credential per settings scope, encrypted at rest,
materialized into the application's own HOME so the **agent** can use native git, and reused by the
human workbench through a read-only mount. The agent can read its own credentials; scoped deploy keys
and fine-grained tokens are the mitigation.

## Delivered

- Migration v8 (`git-credentials`) adds `setting_secrets` and drops the legacy `secrets` table.
  Stage 0011's v9 lands beside it, so a current tree applies versions `[1..9]`; a clean pre-0010 tree
  applies v1-v7 + v9.
- `src/settings/git-auth.ts` stores one SSH (`privateKey`, optional `knownHosts`) and one HTTPS
  (`hosts`, `username`, `token`) credential per scope with AES-256-GCM, status-only reads, and
  inheritance. `git.user.name`/`git.user.email` are clearable settings.
- `src/git/credentials.ts` validates unencrypted Ed25519/ECDSA/RSA keys with `ssh-keygen`, derives the
  public key/fingerprint, rejects embedded-password remotes, and validates HTTPS host allowlists.
- `src/git/materialize.ts` writes the managed directory
  `<app>/home/.config/hanse/git/{config,ssh,askpass,id,known_hosts,token,username}` with symlink-safe,
  canonical-root-checked, `O_NOFOLLOW`/rename writes and `0700`/`0600` modes. The app receives only
  paths (`GIT_CONFIG_GLOBAL`, `GIT_SSH_COMMAND`, `GIT_ASKPASS`, `GIT_ASKPASS_REQUIRE`,
  `HANSE_CREDENTIALS_DIR`); `settingsHashFor` includes `gitAuthHash`.
- The runner mounts the managed directory read-only for workbench git, and an ephemeral draft
  directory for `POST /git/test`. The test runs `git ls-remote` in the network-enabled one-shot
  sandbox, reports redacted warnings and TOFU fingerprints, and never touches the managed directory.
- The application page gets a Settings -> Git section and an app-page-only **Test connection**.
  Global/project pages show status and link to an app. Draft SSH validation happens in the
  coordinator before the runner is called.
- Removed all credential/config `HANSE_GIT_*` variables, `HANSE_HOST_GIT_DIR`,
  `HANSE_GIT_SSL_CAINFO`, `src/secrets/store.ts`, and `src/secrets/git-credential.ts` with no
  fallback. `HANSE_HOST_RUNNER_TMP` is the new runner scratch-path setting.
- Tests: `git-auth-store`, `git-credentials`, `git-materialize`, `git-wrappers`, `git-sandbox`,
  `git-service`, `git-http`, `runner-git`, `runner-validate`, `settings`, `settings-http`,
  `migrations`, `manager`, `launcher`, `agent-protocol`, `git-settings-asset`, and `secrets`. The
  full suite is **1152 passing**; `npm run lint`, `npm run typecheck`, `npm test`, and `npm run build`
  are green.

## Deployment and live verification

Published and deployed as `sha-e2d89a2`: coordinator, IDE, runner, and default agent images. The
deploy was merged on top of stage 0011 (`sha-b844bc3`); SSH tables and features remain live.

- Health: coordinator, IDE, and runner are healthy; `/healthz`, `/login`, `/settings`, and an
  authenticated sessions request return `200`. The `demo-app` app was lazily started on the new
  default image. `scripts/agent-runtime-probe.sh b1` passes.
- Database: migrations `[1..9]` applied; `setting_secrets` exists, `secrets` is absent, and the SSH
  tables remain.
- Materialization: `demo-app` has the managed Git directory with `config`, `ssh`, and `askpass`
  (`0700`/`0600`). Its environment contains only the path variables and no `HANSE_GIT_*`.
- Workbench: `GET .../git/status` and `POST .../git/fetch` return `200` for the public
  `<APP_REPO_URL>` remote; no one-shot container remains afterward.
- Test connection: an invalid draft key returns `400 invalid_git_credential`; a valid but unauthorized
  key reaches GitHub, reports the TOFU warning and `502 auth_failed`, and leaks no key material.
  `HANSE_HOST_RUNNER_TMP` is empty afterward.
- UI: the app settings page contains the **Test connection** control.

No operator PAT or deploy key was available on the host, so a **successful credential-backed**
fetch/push and a successful SSH Test were not executed live. The failure paths, public HTTPS fetch,
materialization, and API/UI wiring were verified; unit and integration tests cover the success paths.

## Decisions and residuals

- Accepted Variant A: the agent can read its own credentials. Use one-repository deploy keys,
  least-privilege HTTPS tokens with expiry, and avoid granting the coordinator host.
- SSH is TOFU by default (`accept-new`); a supplied `known_hosts` switches to strict checking. The
  learned key lasts until the next materialization. HTTPS hosts must match the allowlist exactly, and
  the askpass helper refuses non-HTTPS URLs.
- Passphrase-protected SSH keys, GPG signing, multiple credentials per scope, custom CA, IDE
  credentials, and project-root/monorepo repositories are out of scope for v1.
- Settings apply on explicit agent restart. The workbench uses the last materialized files until
  then. `git clone` on add-app still uses its existing path and does not read project-scope settings.
- The `hanse-agent-default` base image prerequisite (`a49d5cd`) adds `openssh-client`; custom images
  must include the agent contract and `openssh-client` for SSH materialization to work.

## Gates

`npm run lint`, `npm run typecheck`, `npm test` (1152), and `npm run build` are green. Deploy uses the
GHCR `sha-e2d89a2` images; backup, rollback tags, and live-smoke details are recorded in the local
deploy log.
