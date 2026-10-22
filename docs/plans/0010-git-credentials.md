# Plan 0010 - Git credentials

Status: **implemented, verified, and deployed** as `sha-e2d89a2` (1152 tests); see
[`docs/journal/0012-git-credentials.md`](../journal/0012-git-credentials.md).

Design: [`docs/design/git-credentials.md`](../design/git-credentials.md). Design review: `oracle`,
2026-10-21, PASS; design gate cleared. Owner decisions are recorded in the design (§4) and carried
into this plan; there are no open questions.

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
| Commit policy | one stage code commit (code + tests + docs) plus one docs-only deploy-record commit (the `docs/process.md` exception); owner authorizes; Conventional Commits |

Owner decisions carried into this plan:

1. Variant A: native git in the app container with per-app materialized credentials; the agent can
   read its own credentials. Scoped deploy keys/fine-grained PATs and documentation mitigate.
2. SSH first, HTTPS also required. GPG signing out of scope. Passphrase-protected SSH keys are
   rejected in v1; the derived public key is shown.
3. `known_hosts` optional: strict + managed file when provided; `accept-new` with a UI warning when
   absent.
4. The application directory is the repository root for v1; `GIT_CEILING_DIRECTORIES` stays.
5. Web IDE credentials are out of scope.
6. Git settings apply on an explicit agent restart; the web workbench reads the same materialized
   files; Test connection tests draft values without saving.
7. One SSH credential and one HTTPS credential per scope; the schema leaves a seam for host-keyed
   credentials later.
8. Remove the credential/config `HANSE_GIT_*` mechanism, `HANSE_HOST_GIT_DIR`, and
   `HANSE_GIT_SSL_CAINFO` with no fallback; remove the legacy `secrets` table/helper. The legacy table
   was empty and had no configured values, so no data migration is required.
9. Test connection runs draft values through the runner's network-enabled one-shot sandbox and is
   app-page-only.

Prerequisite already committed and published: `a49d5cd` adds `openssh-client` to `agent-base`; the
`sha-a49d5cd` image was verified on `deployment-host` with the host OpenSSH, `/usr/bin/ssh-keygen`, and the host git.

---

## 1. Global invariants

1. No private key, token, or known-hosts content is written to the plain `settings` table, the
   settings API/HTML, logs, the runtime spec, or any process environment. The app env contains paths
   only; the test credential dir is a read-only bind mount.
2. Secrets are stored encrypted with the existing AES-256-GCM `secret.key`; status responses carry
   metadata only. A decrypt/schema failure is an explicit `error` status and never falls back to a
   wider scope or ambient config.
3. Missing or cleared credentials fail closed with a clear message. Local git operations continue to
   work without a network credential.
4. The app directory remains the repository root; app containers keep only their app directory and
   per-app agents root. The workbench one-shot gets the app directory rw for mutations and the
   **managed** credential dir read-only. The Test one-shot gets the app directory read-only and an
   **ephemeral draft** credential dir read-only; it never mounts or writes the app's managed dir.
5. Settings changes never restart an agent silently. `settingsHashFor` includes the effective git
   identity and `gitAuthHash`, so the existing `pendingRestart` marker covers secret-only changes.
6. Settings and Test routes are human-only; agent principals receive `403`. POST + `SameSite=Strict`
   remains the CSRF control, and `return_to` goes through `safeLocalPath`.
7. Materialization is symlink-safe: it derives `expectedAppRoot` from `realpath(agentsRoot)` plus the
   sanitized project/app, verifies `appRoot`/`home` real directories and realpaths, lstat's every
   managed component, and writes temp files with `O_NOFOLLOW` before rename.
8. Existing git hardening is preserved: no shell, fixed argument vectors, hooks/fsmonitor/ext/
   credential-helper disabling, output caps, redaction, and the one-shot sandbox.
9. `HANSE_GIT_*` credential/config variables and the legacy `secrets` store are removed, not
   shadowed. The four non-secret sandbox operation variables (`HANSE_GIT_OP`, `HANSE_GIT_APP_DIR`,
   `HANSE_GIT_BRANCH`, `HANSE_GIT_MESSAGE`) remain.
10. Every phase leaves `npm run lint && npm run typecheck && npm test && npm run build` green.

## 2. Non-goals

- GPG/SSH commit signing; passphrase-protected SSH keys; live apply; multiple host-keyed credentials;
  monorepo/project-root repositories; IDE/terminal credentials; `git clone` on add-app; custom CA
  settings; credential rotation/vault/audit reads; multi-user or RBAC.
- Changes to the provider-key, web-tool, OMO, chat, handoff, terminal, or IDE surfaces except the
  settings page and the git workbench changes described here.

## 3. Phase overview

| Phase | Outcome | Main areas |
| --- | --- | --- |
| 1 | Persisted git identity and encrypted SSH/HTTPS credentials with status-only API/UI | migration v8, settings, secret store, validation, HTTP settings, assets |
| 2 | Materialized credentials and native git in the app container | materializer, manager env, wrappers/config, spec validation |
| 3 | Workbench reads the managed credentials; draft Test connection | runner label/mount, `GitService`, `git-op test`, HTTP/UI |
| 4 | Old mechanism removed; docs updated; deployed and smoke-tested | compose/.env/docs, removal, image, deployment-host, journal |

Phases 1-3 are implementation phases inside one stage. After owner approval: commit the stage code
(code + tests + docs), push/publish, deploy and verify, then make a docs-only deploy-record commit
(journal + indexes), as allowed by `docs/process.md`. Phase gates are strict: do not start a later
phase with a red earlier gate.

---

## 4. Phase 1 - Persistence, settings, validation, UI

### 4.1 Scope

- Add migration **v8** `git-credentials`:
  - copy the exact `setting_secrets` DDL from design §12, including `json_valid(meta_json)`,
    `length(key) > 0`, the scope CHECK, and the `cleared`/cipher CHECK;
  - `DROP TABLE IF EXISTS secrets`.
- Delete `src/secrets/git-credential.ts` and `src/secrets/store.ts`; keep `src/secrets/crypto.ts`.
  Remove their exports from `src/secrets/index.ts`. The legacy drop happens here once; phase 4 only
  verifies it.
- Add `src/settings/git-auth.ts`: encrypted store, `set`/`clear`/`inherit`, wide-to-narrow
  resolution, status-only `GitAuthStatus`, `meta_json` (public key/fingerprint/hosts/username),
  `secure_delete` + WAL checkpoint, and a plaintext snapshot for materialization. Export it from
  `src/settings/index.ts`.
- Add `git.user.name` / `git.user.email` to the settings registry and types:
  `SettingsKeyDefinition<string | null>` with a non-null string schema and `defaultValue: null`;
  clear/inherit semantics unchanged.
- `ResolvedSettings` gains only `gitAuth` (status) and `gitAuthScoped`.
  `LaunchSettingsSnapshot` gains plaintext `gitAuth` and `gitAuthHash`. **`gitAuthHash` must never be
  on `ResolvedSettings` or any HTTP response**; include it in `SettingsService.effectiveHash`.
- Add `src/git/credentials.ts`: schemas and validation for SSH private keys (size/format, reject
  encrypted/public/certificate, `ssh-keygen -y -P "" -f <temp>`, derive public key + `SHA256:`
  fingerprint), optional `known_hosts` (`ssh-keygen -l -f`, empty -> absent), HTTPS hosts
  (DNS/IPv4/bracketed IPv6, no scheme/path/userinfo/wildcard/port/CIDR), username, token, and test
  remote validation including an explicit non-empty `password` rejection.
- Add `POST /api/settings/git` (JSON only) for set/clear/inherit; extend `GET /api/settings` with
  `git.user.*` and the credential statuses. Never return plaintext. Add `/api/settings/git` to
  `isSettingsRoute` (`src/http/settings.ts:316-330`).
- Render the Git section on `/settings`, `/projects/:id/settings`, and
  `/projects/:id/apps/:appKey/settings`: identity form, SSH status/public key/fingerprint/known_hosts
  flag, HTTPS status/hosts/username, Set/Inherit/Clear, TOFU/passphrase/security copy. Test button is
  **not** part of this phase.
- Add `assets/git-settings.js` for JSON credential submissions, add it to the static allowlist, and
  keep identity forms as normal POSTs. Update `DESIGN.md`/Tailwind only if new classes are introduced.
- Add `openssh-client` to the `runtime` Dockerfile stage explicitly (or a build-time `ssh-keygen`
  assertion), because save validation uses `ssh-keygen`.

### 4.2 Acceptance criteria

- Migration v8 applies on a fresh DB and on a DB that still has `secrets`; `setting_secrets` exists,
  `secrets` is gone, and re-running migrations is a no-op.
- `git.user.name/email` resolve global -> project -> app, inherit/clear correctly, and appear in
  `GET /api/settings` and the scoped rows.
- `git.auth.ssh`/`git.auth.https` set/clear/inherit resolve atomically; clearing suppresses wider
  scopes; a decrypt/schema failure is `error`; status responses contain no plaintext.
- SSH validation accepts a real unencrypted ed25519/RSA key and rejects encrypted, public,
  certificate, and garbage input with bounded redacted errors; public key and fingerprint are
  available for the UI.
- HTTPS hosts validation accepts DNS/IPv4/bracketed IPv6 and rejects schemes/paths/userinfo/
  wildcards/ports/CIDR; token/username bounds hold; embedded passwords are rejected in test remotes.
- The settings pages render at 390/768/1440 without duplicate ids, console errors, or secret
  re-rendering; agent principals get `403` on the new route; the body limit accommodates a 32 KiB key
  plus known_hosts. `GET /api/settings` and the POST responses contain no `gitAuthHash`, private key,
  token, or known-hosts body.
- The runtime image builds with `ssh-keygen` explicitly available.

### 4.3 Tests

- `test/migrations.test.ts`: v8 create/drop, constraints, idempotent re-run, restored DB.
- `test/git-auth-store.test.ts` (new): set/clear/inherit, tombstones, resolution, status, metadata,
  decrypt failure, no plaintext in `meta_json`.
- `test/settings.test.ts`: `git.user.*`, defaults, clear/inherit, `gitAuthHash`, `effectiveHash`.
- `test/git-credentials.test.ts` (new): all validation cases above with a real/injected
  `ssh-keygen` seam.
- `test/settings-http.test.ts`: new route, JSON-only, errors, 403, no plaintext, HTML status; assert
  `gitAuthHash`/private key/token/known-hosts are absent from GET and POST responses.
- `test/settings-store.test.ts`: update for the new snapshot/effective-hash shape if it asserts the
  full settings payload.
- `test/git-settings-asset.test.ts` (new): JSON submit payload, in-flight control disable, and
  `textContent` error rendering; keep the secret value out of URLs, `data-*`, and inline scripts.
- `test/secrets.test.ts`: crypto round-trip only; old store/helper tests removed.
- UI verification: extend the page tests for DOM ids/status/secret absence; run the existing
  Playwright/page-smoke pattern at 390/768/1440 for the three settings pages with zero console/page
  errors and no secret text in the DOM, recording the result in the stage journal.

### 4.4 Verification

```bash
npm run lint
npm run typecheck
npm test
npm run build
docker build --target runtime -t hanse-runtime:test .
docker run --rm --entrypoint sh hanse-runtime:test -c 'command -v ssh; command -v ssh-keygen'
```

Targeted: `npx vitest run test/git-auth-store.test.ts test/git-credentials.test.ts test/settings.test.ts test/settings-http.test.ts test/settings-store.test.ts test/migrations.test.ts`.

### 4.5 Risks

- `DROP TABLE secrets` is destructive in principle; the legacy table is empty and the migration is additive for
  all other state. Back up `state/` before deploy.
- `ssh-keygen` in the coordinator is a new runtime dependency; the explicit runtime-stage install
  removes reliance on the code-server base.
- `meta_json` must be constructed from non-secret fields only; tests inspect it for key/token
  substrings and known-hosts content.

---

## 5. Phase 2 - Materializer and app-container env

### 5.1 Scope

- Add `src/git/materialize.ts`:
  - `materializeGitCredentials({ agentsRoot, appRoot, home, projectId, appKey, identity, auth })`;
  - `expectedAppRoot = path.join(realpath(agentsRoot), sanitizeAppKey(projectId), sanitizeAppKey(appKey))`;
  - require `lstat(appRoot)`/`lstat(home)` real directories, `realpath(appRoot) === expectedAppRoot`,
    `realpath(home) === expectedAppRoot/home`;
  - lstat `.config`, `hanse`, `git`; refuse/remove symlinks; create dirs `0700`;
  - write `config`, `ssh`, `askpass`, and optionally `id`, `known_hosts`, `token`, `username`,
    `https_hosts`; `0600` files, `0700` wrappers, atomic temp + `O_NOFOLLOW` + rename;
  - set mode/ownership on temp files before rename; remove stale credential files on clear/inherit;
  - return the env fragment (`GIT_CONFIG_GLOBAL`, `GIT_CONFIG_NOSYSTEM`, `GIT_TERMINAL_PROMPT`,
    `GIT_SSH_COMMAND`, `GIT_ASKPASS`, `GIT_ASKPASS_REQUIRE`, `HANSE_CREDENTIALS_DIR`, `LC_ALL`,
    `LANG`).
- `InstanceManager.ensure`:
  - create `appRoot`/`home` with recursive `0700` before materialization;
  - call the materializer after the snapshot and before `runtime.ensure`;
  - add the env fragment to the spec env; keep `GIT_CEILING_DIRECTORIES`;
  - include `snapshot.gitAuthHash` in `settingsHashFor`;
  - throw `git_credentials_materialize_failed` on any failure; do not start the agent.
- Extend `SCRUBBED_ENV_KEYS` with inherited git config/credential variables and
  `HANSE_CREDENTIALS_DIR`/`HANSE_CREDENTIALS_READONLY`, `GIT_CONFIG_*`, `GIT_SSH*`, `GIT_ASKPASS*`,
  `GIT_TERMINAL_PROMPT`, `GIT_SSL_CAINFO`, `GIT_DIR`, `GIT_WORK_TREE`, `GIT_CEILING_DIRECTORIES`, and
  the legacy credential `HANSE_GIT_*` names. The manager sets the app's `GIT_CEILING_DIRECTORIES`
  after scrubbing. B0/local `launcher.ts` stays unmanaged.
- Extend `src/runner/validate.ts` and `src/agent/spec.ts` path-key validation with
  `GIT_CONFIG_GLOBAL`, `GIT_ASKPASS`, and `HANSE_CREDENTIALS_DIR`; add the shared
  `validateGitSshCommand` for the shell-quoted `GIT_SSH_COMMAND` path.
- Implement the managed `config`, SSH wrapper, and HTTPS askpass exactly as the design specifies:
  HTTPS-only askpass, host allowlist, known_hosts strict/accept-new, `-F /dev/null`,
  `IdentitiesOnly`, `IdentityAgent=none`, `BatchMode`, `core.sshCommand` shell-quoted, empty
  credential helper.

### 5.2 Acceptance criteria

- A fresh app start creates `appRoot`/`home` if absent, materializes the managed dir, and starts.
- `docker exec` into the app shows the path-only env; `git config --list` shows the effective
  identity; `GIT_ASKPASS_REQUIRE=force`; no secret appears in the env/spec.
- SSH: an unencrypted deploy key authenticates to a test remote with/without known_hosts; missing
  `id` fails with the clear message; encrypted keys are rejected at save.
- HTTPS: the askpass releases the token only for allowlisted `https://` hosts; `http://`/other
  schemes fail closed; `credential.helper=` is empty.
- `clear`/`inherit` removes stale key/token/known_hosts files on the next materialization; local git
  still works without a credential.
- A symlinked `home`, `appRoot`, project/app segment, `.config`/`hanse`/`git`, or final component is
  refused/repaired; no write escapes the expected app HOME.
- A secret-only settings change flips `pendingRestart`; the app is not restarted automatically.
- `npm run` gates green; targeted tests green.

### 5.3 Tests

- `test/git-materialize.test.ts`: file set, modes, ownership seam, atomic rewrite, config quoting,
  clear-by-removal, env fragment, symlink cases (home/appRoot/project/app/managed components/final
  files), expectedAppRoot mismatch, no `~/.ssh` writes.
- `test/git-wrappers.test.ts`: fake `ssh` on PATH; strict/accept-new/TOFU read-only behavior; missing
  key; askpass username/password, allowlist, IPv6/port, https-only, OTP refusal, no `eval`.
- `test/manager.test.ts`: mkdir/materialize ordering, env, spec hash, `gitAuthHash`,
  `pendingRestart`, materialization failure, scrub list.
- `test/runner-validate.test.ts` and `test/agent-protocol.test.ts`: path keys, quoted
  `GIT_SSH_COMMAND`, out-of-root rejection, spec hash/label.
- `test/launcher.test.ts`: B0/local remains unmanaged; no legacy credential env.

### 5.4 Verification

```bash
npm run lint
npm run typecheck
npm test
npm run build
```

Targeted: `npx vitest run test/git-materialize.test.ts test/git-wrappers.test.ts test/manager.test.ts test/runner-validate.test.ts test/launcher.test.ts`.

### 5.5 Risks

- Fresh-app creation must happen before materialization; the symlink check remains fail-closed.
- `GIT_SSH_COMMAND` is shell-interpreted; both validators must unwrap the generated `shellQuote`
  form and reject anything outside the app agents root.
- The managed dir is inside the app-writable HOME. The static symlink checks close the app-created
  path; the app can still read its own credentials by design.

---

## 6. Phase 3 - Workbench and Test connection

### 6.1 Scope

- Runner app container: add `hanse.agents.root=<hostAgentsRoot>` (and `hashInput.labels` on the
  coordinator); read/re-validate it for git/test; require two segments.
- Runner `git` (workbench): compute `hostAgentsRoot/home/.config/hanse/git`, verify
  `home`/`.config`/`hanse`/`git` real directories and realpath equality, require
  `config`/`ssh`/`askpass`; return `409 restart_required` otherwise. Mount that **managed** dir
  read-only at `/run/hanse/git/app`; set the path env from §10.2; keep the app directory rw for
  mutations.
- Runner `test`: verify the app/managed-dir preconditions the same way, but mount an **ephemeral
  draft** dir, never the managed dir: create `<hostRunnerTmp>/git-test-<uuid>/git`, write the draft
  with `writeGitCredentialFiles(..., { visibleDir: "/run/hanse/git/app" })`, and mount it at
  `/run/hanse/git/app:ro`. Set `HANSE_GIT_OP=test`, `HANSE_TEST_KIND=<ssh|https>`, and
  `HANSE_TEST_REMOTE` only when supplied; the app directory is mounted read-only for Test.
- `GitService`: use `HANSE_CREDENTIALS_DIR`; fallback for unit/local tests uses a private temp HOME,
  plain `ssh`, `GIT_CONFIG_GLOBAL=/dev/null`, and an explicit empty askpass plus
  `-c core.askpass=`; no generated askpass.
- `git-op test`: new `HANSE_GIT_OP=test` path; `HANSE_TEST_KIND` selects the credential scheme;
  optional `HANSE_TEST_REMOTE`; `git remote get-url origin` when absent; scheme check; `ls-remote`
  with bound output; read `$TMPDIR/hanse-known_hosts` and return TOFU fingerprints in `warnings`.
- `GitTestRequest` validator; `RunnerGitClient.test`; runner `POST /v1/apps/:id/git/test`;
  coordinator `POST /api/projects/:projectId/apps/:appKey/git/test`. Return `503 runner_required`
  when no runner is configured. Extend `GitErrorCode`/`GIT_ERROR_CODES` in `src/git/errors.ts` with
  `not_running`, `restart_required`, `missing_remote`, `credential_scheme_mismatch`,
  `host_not_allowed`, and `runner_required`.
- Add `HANSE_HOST_RUNNER_TMP` (default `/var/lib/hanse/tmp`) to the runner config and Compose with
  its same-path host bind; validate it is absolute and does not overlap workspace/agents. Test temp
  dir under it: `0700` temp root, ownership seam, cleanup in `finally`, startup sweep.
- Switch `gitContainerEnv` to the managed/ephemeral dirs and remove the `config.gitEnv` loop/path
  translation in this phase, so the one-shot has no `HANSE_GIT_*` secret env. Replace
  `hasGitCredentials(config)` with a mounted-dir check (`id`/`token`) so the "credentials not
  configured" hint reflects the managed dir. Phase 4 deletes the then-dead
  `RunnerConfig.gitEnv`/`hostGitDir` fields.
- UI: app-page-only Test button, remote input, result/warnings panel; global/project sections link to
  an app page. Error mapping: 400 validation/host/scheme, 409 not_running/restart_required/
  missing_remote/not_git/not_root, 502 auth/network, 503 runner_required, 504 timeout.

### 6.2 Acceptance criteria

- Web status/fetch/update/switch/commit/push continue to work; fetch/push use the app's effective
  credentials; a missing credential gives the clear message; a stopped app gives `409`; a
  pre-upgrade container gives `409 restart_required`.
- Test connection with draft SSH/HTTPS values returns success/ref count for a working remote and a
  redacted failure otherwise; it defaults to `origin`; it rejects scheme mismatch, embedded
  passwords, and a non-allowlisted HTTPS host; it never writes settings or the app dir.
- TOFU: no known_hosts -> warning + fingerprints; known_hosts -> strict; a changed key fails.
- The one-shot container has no secret env and no credential files outside the ro mount; cleanup
  leaves no temp dir/container; the runner has no `hanse-git-*` container.
- `npm run` gates green; targeted tests green.

### 6.3 Tests

- `test/runner-git.test.ts`: label/mount/env, missing/restart, cred dir realpath/lstat, symlinked
  home/component -> 409, test bind source under `hostRunnerTmp` (not the managed dir), managed dir
  unchanged, `HANSE_TEST_KIND`/`HANSE_TEST_REMOTE`, test temp dir lifecycle, cleanup, no secrets,
  two-segment validation, `hostRunnerTmp` absolute/no-overlap.
- `test/git-service.test.ts`/`git-sandbox`/`git-hardening`: managed dir, fallback, `ls-remote`,
  TOFU fingerprints, redaction, hardening, error-code mapping, 503 `runner_required`.
- `test/git-http.test.ts`: `/git/test` auth/JSON/body/scheme/host/embedded password/404/409/502/503/504,
  app-page-only UI, Test result/panel DOM, existing workbench regressions.
- `test/runner-client.test.ts`: `test()` timeout/error mapping for the new codes.

### 6.4 Verification

```bash
npm run lint
npm run typecheck
npm test
npm run build
```

Targeted: `npx vitest run test/runner-git.test.ts test/git-service.test.ts test/git-http.test.ts test/runner-client.test.ts`.

### 6.5 Risks

- The runner's repeated check is static and not atomic against a running app; documented residual.
- Test requires a running app; the UI states this.
- The runner temp root is a new deployment path; it must not overlap workspace/agents and must not be
  on a backed-up/shared volume.

---

## 7. Phase 4 - Removal, docs, deploy, record

### 7.1 Scope

- Remove `HANSE_HOST_GIT_DIR`, `HANSE_GIT_TOKEN`, `HANSE_GIT_SSH_KEY`, `HANSE_GIT_SSH_COMMAND`,
  `HANSE_GIT_KNOWN_HOSTS`, `HANSE_GIT_ASKPASS`, `HANSE_GIT_AUTHOR_*`, `HANSE_GIT_COMMITTER_*`,
  `HANSE_GIT_SSL_CAINFO` from `compose.yaml`, `.env.example`, `docs/deployment.md`, and the env table;
  keep the four operation vars.
- Remove the now-dead `RunnerConfig.gitEnv`/`hostGitDir` fields, `CONTROLLED_GIT_ENV`,
  `GIT_FILE_ENV_KEYS`/`translateGitPath`, and the `git/env.ts` ambient credential resolution
  including `IDENTITY_ENV`/`GIT_AUTHOR_*`/`GIT_COMMITTER_*` handling, and the old test helpers that
  inject those vars. (Phase 3 already removed the loop/path use; phase 4 deletes the dead code.)
- Verify the v8 drop of the legacy `secrets` table/helper already performed in phase 1; do not
  duplicate the deletion.
- Retain the Phase 3 `HANSE_HOST_RUNNER_TMP` config/mount; document it in `compose.yaml`/
  `.env.example`/`docs/current-state.md` and keep the default `/var/lib/hanse/tmp`.
- Update `docs/current-state.md`, `docs/conventions.md`, `docs/deployment.md`,
  `docs/design/agent-runtime.md`, `docs/design/git-workbench.md`, `docs/design/README.md`,
  `docs/plans/README.md`, and `docs/open-questions.md` (stage 0010, no open items). Update
  `docs/security/review.md` or mark it historical where it still says git credentials are ambient.
- Add `docs/decisions/0010-agent-readable-git-credentials.md` recording the accepted Variant A
  security posture (agent-readable creds; scoped keys/PATs; no ambient env); the journal references
  it instead of duplicating the decision.
- Commit the stage code (code + tests + docs + ADR) after owner approval, then push to `origin/main`
  to publish the images. This is the commit deployed in Step 4.
- Publish the images (including the runtime `openssh-client` change and `a49d5cd` agent base).
- Deploy to deployment-host: backup, compose pull/up, migration, one-time restart each app, configure
  `git.user.*` and credentials, Test connection, restart, live smoke.
- Live smoke:
  - HTTPS on `demo-app`: fine-grained PAT, Test success, restart, fetch/push from the workbench and
    from the agent terminal; clear + restart -> clear failure and no token file.
  - SSH after the image publish: test deploy key/known_hosts, Test success, restart, fetch/push;
    no known_hosts -> TOFU warning; wrong host key fails.
  - Confirm app env path-only, no `HANSE_GIT_*` in app/runner, one-shot no secret env, no leftover
    `hanse-git-*` container, `GET /api/settings` no plaintext, `setting_secrets` populated,
    `secrets` gone.
- Write `docs/journal/0011-git-credentials.md` and update the journal index; record the deploy in
  `docs/deploy/deploy-log.md` (git-ignored).
- Commit the docs-only deploy record (journal + index/status updates) as the `docs/process.md`
  exception; both commits belong to the same stage.

### 7.2 Acceptance criteria

- `rg "HANSE_GIT_|HANSE_HOST_GIT_DIR"` finds only the four operation vars and intentionally retained
  test/docs references; no credential env remains.
- All four gates green; live smoke passes; health/agent probes pass; deployment-host app containers restarted with
  the new env.
- The stage record, ADR, open-questions page, and indexes are updated; the deploy log is written.

### 7.3 Verification

```bash
npm run lint
npm run typecheck
npm test
npm run build
```

Publish/deploy commands: follow `docs/deploy/host.md` Steps 2-7 in order; the stage-specific
additions are below. Do not skip Step 3 (backup + rollback tags), Step 4 (deliver the commit), or
Step 5 (`.env` update), and do not rely on `docker compose pull` for the agent image because
`hanse-agent-default` is not a Compose service.

```bash
set -euo pipefail

# Step 2: published images (record the sha-<short> and digests)
gh run list --workflow=publish.yml --limit 3
for image in hanse hanse-agent-base hanse-agent-default hanse-agent-ide hanse-runner; do
  docker buildx imagetools inspect "ghcr.io/arkaneman/$image:sha-<short>"
done

# Step 3: run the backup + rollback-tag block verbatim
# (state/, workspace/, agents/, .env; tags hanse, hanse-ide, hanse-runner)
# Separately record the running app-agent image ref/digest for rollback.

# Step 4: deliver the stage commit, not the working tree
git archive --format=tar HEAD | ssh deployment-host 'tar xf - -C <INSTALL_DIR>'
ssh deployment-host 'rm -f <INSTALL_DIR>/docker-compose.yml'

# Step 5: run deployment-host Step 5 first (HANSE_BIND/HANSE_TAG/paths), then:
# pin both the coordinator and agent/IDE/runner tags to the new sha, remove the old git env,
# and add the runner temp root.
ssh deployment-host 'set -eu; cd <INSTALL_DIR>
  sed -i "/^HANSE_TAG=/d;/^HANSE_AGENT_TAG=/d;/^HANSE_GIT_/d;/^HANSE_HOST_GIT_DIR=/d;/^HANSE_HOST_RUNNER_TMP=/d" .env
  printf "HANSE_TAG=sha-<short>\nHANSE_AGENT_TAG=sha-<short>\nHANSE_HOST_RUNNER_TMP=/var/lib/hanse/tmp\n" >> .env
  chmod 600 .env'

# Step 6: pull services + the non-service agent image, then recreate and wait for health
ssh deployment-host 'cd <INSTALL_DIR> && docker compose pull && docker pull ghcr.io/arkaneman/hanse-agent-default:sha-<short> && docker compose up -d --wait --remove-orphans'
# If you intentionally pin a different HANSE_AGENT_TAG, substitute it consistently in Step 5/6.

# Migration assertion and probe
TABLES=$(ssh deployment-host 'docker exec hanse node -e "const D=require(\"better-sqlite3\");const d=new D(\"/data/state/hanse/coordinator.db\",{readonly:true});console.log(d.prepare(\"select name from sqlite_master where type = ?\").all(\"table\").map(r=>r.name).join(\"\n\"))"')
echo "$TABLES" | grep -qx setting_secrets
! echo "$TABLES" | grep -qx secrets
ssh deployment-host 'cd <INSTALL_DIR> && scripts/agent-runtime-probe.sh b1'
```

Then restart each existing app once (UI restart action or `POST /api/apps/:app/restart?project=<id>`)
so its container is recreated with `hanse.agents.root` and the managed git env. Run the health checks
from `docs/deploy/host.md` §5 Step 7 and the live git smoke above (HTTPS `demo-app`, then SSH with a
test deploy key). Record the image digest, rollback tag, and smoke output in the deploy log.

### 7.4 Rollback

- Code rollback: revert the stage commit and restore the old compose/.env git variables. The v8
  migration is forward-only; downgrade by dropping `setting_secrets`, recreating the v2 `secrets`
  table, and deleting the `schema_migrations` row for version 8.
- Restore the saved `.env` from the Step 3 backup (this restores both `HANSE_TAG` and
  `HANSE_AGENT_TAG`), or set both explicitly; the agent/IDE/runner images resolve from
  `HANSE_AGENT_TAG` first. Restore `state/` (including `state/hanse/secret.key`) together with the DB;
  a DB restored without its matching `secret.key` cannot decrypt `setting_secrets` or provider keys.
  Record `HANSE_TAG`, `HANSE_AGENT_TAG`, and the app-agent image ref/digest in the deploy log.
- Running apps must be restarted after rollback to drop the managed git env. Materialized files are
  harmless and can be removed with the app HOME.
- Credentials entered in the new UI are not migrated back to `.env`; the operator must reconfigure
  deployment-wide variables on rollback.

---

## 8. Stage-level acceptance checklist

- [ ] `git.user.name`/`email` and `git.auth.ssh`/`https` resolve global -> project -> app; secrets
      are encrypted and status-only.
- [ ] A fresh app starts, materializes the managed dir, and native git uses the effective identity
      and credentials; missing credentials fail clearly; local operations work.
- [ ] SSH and HTTPS work from the agent and the web workbench; no secrets in API/HTML/logs/env/spec.
- [ ] Test connection tests drafts, is app-page-only, redacts output, and handles TOFU/timeout/
      stopped/pre-upgrade cases.
- [ ] `HANSE_GIT_*`/`HANSE_HOST_GIT_DIR`/`HANSE_GIT_SSL_CAINFO` and the legacy `secrets` store are
      removed; `secrets` is dropped; no fallback.
- [ ] Symlink/canonical-root defenses are tested; no cross-app/state write is possible through the
      managed path.
- [ ] Restart-required behavior is correct for identity and secret changes.
- [ ] All four gates green; docs/indexes/journal/deploy record updated; deployment-host live smoke passed.

## 9. Plan review

Status: **PASS** (`momus`, 2026-10-21); plan gate cleared.

The review verified the phase boundaries, acceptance criteria, tests, verification commands, owner
decisions, deploy/rollback sequence, and the design-to-plan mapping. Required findings (settings hash
surface, Test mount split, docs/ADR, UI verification, `hostRunnerTmp`, deploy/rollback commands,
Phase 3/4 ordering, tag handling, fail-fast shell) were folded. No open question remains; the
executor can implement without asking.

## 10. References

- [`docs/design/git-credentials.md`](../design/git-credentials.md)
- [`docs/process.md`](../process.md)
- [`docs/current-state.md`](../current-state.md)
- [`docs/conventions.md`](../conventions.md)
- [`docs/deployment.md`](../deployment.md)
- [`docs/design/git-workbench.md`](../design/git-workbench.md)
- [`docs/design/web-tools-and-settings.md`](../design/web-tools-and-settings.md)
- [`docs/design/agent-runtime.md`](../design/agent-runtime.md)
- Commit `a49d5cd` - `openssh-client` in `agent-base`.
