# Git credentials

- Status: implemented, verified, and deployed as `sha-e2d89a2` (1152 tests)
- Date: 2026-10-21
- Stage: `0010-git-credentials`
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
| Open questions | this document; none remain; `docs/open-questions.md` is updated with the plan |
| Documentation language | English |
| Verification | `npm run lint && npm run typecheck && npm test && npm run build` |
| Commit policy | one coherent stage commit, only on explicit owner instruction |

## 1. Context

Hanse already has a hierarchical settings system (`settings` and `provider_keys`, migration v3), an
AES-256-GCM secret helper, and a human-only git workbench. The workbench executes every git operation
in a one-shot container through the runner, but its fetch/push credentials are still deployment-wide
environment variables on the runner:

- `HANSE_GIT_TOKEN`, `HANSE_GIT_SSH_KEY`, `HANSE_GIT_KNOWN_HOSTS`, `HANSE_GIT_SSH_COMMAND`,
  `HANSE_GIT_ASKPASS`, and `HANSE_GIT_SSL_CAINFO` are read in `src/runner/validate.ts:108-118` and
  passed into the one-shot container by `src/runner/server.ts:394-433`;
- `HANSE_HOST_GIT_DIR` is a read-only host directory mounted at `/run/hanse/git`
  (`compose.yaml:104-119`);
- `src/git/env.ts:28-40` defines `CONTROLLED_GIT_ENV`, and `src/git/env.ts:184-241` synthesizes an
  `ssh` command and an askpass helper from those variables;
- `src/git/service.ts:895-946` builds the child environment and a temporary helper directory.

This mechanism has four problems:

1. It is **deployment-wide**. Two applications with different remotes cannot use different keys, and a
   token intended for one repository is ambient for every runner-executed fetch/push.
2. It is **not in the product UI**. An operator must edit `.env`, recreate the runner, and has no
   per-application control, no test, and no status.
3. It **does not reach the agent**. The agent's own native `git` (run through `bash` inside the app
   container) has no credentials, so it cannot fetch or push even though the web workbench can.
4. It carries a **legacy, unused secret store**. `src/secrets/store.ts` and
   `src/secrets/git-credential.ts` back the migration-v2 `secrets` table, but nothing reads them; the
   store is not wired into `serve`. The legacy table was empty (verified before this stage).

The owner wants git credentials to be first-class application configuration: one SSH and one HTTPS
credential per scope, configured in the existing settings pages, encrypted at rest, materialized into
the application's own HOME so the **agent** can use native git, and reused by the web git workbench.
The base image prerequisite is already committed as `a49d5cd`: `openssh-client` was added to
`agent-base` because Debian's `git` only *recommends* `ssh-client` and the image uses
`--no-install-recommends` (`Dockerfile:167-170`). The coordinator runtime and IDE images already
provide `ssh`/`ssh-keygen`.

## 2. Goals and requirements

| ID | Requirement |
| --- | --- |
| R1 | Add `git.user.name` and `git.user.email` as plain, clearable settings keys (`string \| null`, `replace`, default `null`) resolved global -> project -> application like every other setting. |
| R2 | Add one SSH credential (`git.auth.ssh = { privateKey, knownHosts? }`) and one HTTPS credential (`git.auth.https = { hosts, username, token }`) per scope, stored encrypted with AES-256-GCM, with a status-only API that never returns plaintext. |
| R3 | Materialize the effective credentials and identity into a managed per-app directory so the **agent's native git** works, without touching `~/.ssh/id_*` or any ambient git configuration. |
| R4 | SSH first, HTTPS also required. Reject passphrase-protected SSH keys on save with a clear error; show the derived public key and fingerprint for the deploy-key workflow. |
| R5 | `known_hosts` is optional. If provided, use `StrictHostKeyChecking=yes` and the managed file; if absent, use `accept-new` and show a TOFU warning. |
| R6 | HTTPS `hosts` is mandatory. The askpass helper must refuse to release the token to any host not on the list. |
| R7 | The web git workbench must read the same materialized files through a read-only mount; remove all runner-global git credential environment. |
| R8 | Add a Test connection button that tests **draft** values through a network-enabled one-shot sandbox (`git ls-remote`), with an ephemeral credential directory, redacted output, and no persistence. |
| R9 | Git settings apply on an explicit agent restart using the existing `pendingRestart` mechanism. `settingsHashFor` must include git plain values and a hash of the plaintext git credentials so a secret-only change is detected. |
| R10 | Remove every credential/config `HANSE_GIT_*` variable (`HANSE_GIT_TOKEN`, `HANSE_GIT_SSH_KEY`, `HANSE_GIT_KNOWN_HOSTS`, `HANSE_GIT_SSH_COMMAND`, `HANSE_GIT_ASKPASS`, `HANSE_GIT_AUTHOR_*`, `HANSE_GIT_COMMITTER_*`, `HANSE_GIT_SSL_CAINFO`), `HANSE_HOST_GIT_DIR`, and `HANSE_GIT_SSL_CAINFO` with no fallback; retain the four non-secret sandbox operation variables (`HANSE_GIT_OP`, `HANSE_GIT_APP_DIR`, `HANSE_GIT_BRANCH`, `HANSE_GIT_MESSAGE`). Remove the legacy `secrets` table and its helper. |
| R11 | v1 supports exactly one SSH credential and one HTTPS credential per scope. The schema and materializer leave a seam for multiple host-keyed credentials later. |
| R12 | The application directory remains the repository root for v1; `GIT_CEILING_DIRECTORIES` stays. |
| R13 | Settings and test routes stay human-only; agent principals receive `403`. No private key, token, or known-hosts content appears in the API, HTML, logs, or process environment. |
| R14 | Preserve the existing git hardening: no shell, fixed argument vectors, hook/fsmonitor/ext/helper disabling, output caps, redaction, and the one-shot sandbox. |
| R15 | Local status/switch/commit work without any network credential; only fetch/update/push require one. |

## 3. Non-goals

- GPG/SSH commit signing.
- Passphrase-protected SSH keys (backlog).
- Live credential apply without a restart (backlog).
- Multiple SSH credentials or multiple HTTPS tokens per scope, host-keyed credential selection, or
  per-remote credential maps (backlog; the seam is described in §8.2).
- Monorepo or project-root repositories; the app directory must remain the repository root.
- Git credentials for the web IDE and its terminal.
- `git clone` on add-app; it is deferred to a follow-up that reuses project-scope settings.
- A custom CA/TLS setting. If a private CA is ever needed, it belongs in the app image trust store or
  a future `git.tls` setting.
- A credential vault, key rotation, AAD binding of ciphertext, or audit history for reads.
- Changing the human-only trust model or the existing one-operator deployment.

## 4. Owner decisions

These nine decisions are locked. Implementation must not reopen them or add alternatives that
contradict them. There are **no open questions** for this stage.

1. **Variant A: native git inside the app container with per-app materialized credentials.** The agent
   can read its own credentials; this is accepted. Mitigate with scoped deploy keys/fine-grained PATs
   and documentation.
2. **SSH first, HTTPS also required.** GPG signing is out of scope. No passphrase-protected SSH keys in
   v1: reject encrypted keys on save with a clear validation error and show the derived public key.
   Passphrase support is backlog.
3. **`known_hosts` optional.** If provided: `StrictHostKeyChecking=yes` and
   `UserKnownHostsFile=<managed>`. If absent: `accept-new` with a clear UI warning (TOFU).
4. **App directory = repository root for v1.** Monorepo/project-root repositories are out of scope.
   `GIT_CEILING_DIRECTORIES` stays.
5. **Web IDE is out of scope;** its terminal git will not receive these credentials.
6. **Git settings apply on explicit restart for the agent in v1** (existing `pendingRestart`
   mechanism). Live apply is backlog. The web git workbench reads the same materialized files, so it
   also reflects applied settings. Test connection tests draft values without saving.
7. **v1 supports one SSH credential and one HTTPS credential per scope.** The data model and wrapper
   leave a seam for multiple host-keyed credentials later.
8. **Remove the entire `HANSE_GIT_*` mechanism, `HANSE_HOST_GIT_DIR`, and `HANSE_GIT_SSL_CAINFO`; no
   fallback.** Remove the unused legacy `secrets` table/helper (`src/secrets/git-credential.ts`,
   `src/secrets/store.ts`); the legacy table was empty. A private CA, if ever needed, belongs in the app image
   trust store or a future `git.tls` setting.
9. **Add a Test connection button** that tests draft values through a new runner operation
   (`ls-remote`) in a network-enabled one-shot sandbox, using an ephemeral credential dir, redacted
   output, and no persistence.

## 5. Current state and constraints

- **Plain settings.** `src/settings/registry.ts:50-79` defines `llm.model`, `web.search`, and
  `web.fetch`; `src/settings/service.ts:189-229` resolves them, snapshots host auth, and computes
  `effectiveHash`; `src/settings/types.ts:28-67` holds `EffectiveSettings`, `ResolvedSettings`, and
  `LaunchSettingsSnapshot`.
- **Encrypted provider keys.** `src/settings/provider-keys.ts:78-175` is the pattern to follow:
  `set`/`clear`/`inherit`, a nullable cipher/nonce pair, a cleared tombstone, `secure_delete`, a WAL
  checkpoint, and wide-to-narrow resolution.
- **Crypto.** `src/secrets/crypto.ts:13-51` provides `loadOrCreateKey`, `seal`, and `open`
  (AES-256-GCM, 32-byte key, 12-byte nonce, no AAD).
- **Migrations.** The current maximum is v7 (`src/store/migrations.ts:205-224`); v2 created the
  `secrets` table (`src/store/migrations.ts:111-123`). Migrations are forward-only
  (`src/store/database.ts:23-64`).
- **Instance start.** `src/opencode/manager.ts:265-476` takes one settings snapshot, writes auth,
  applies the OMO profile, builds the runtime spec, and records a settings hash. The environment is
  assembled at `src/opencode/manager.ts:401-415`; `GIT_CEILING_DIRECTORIES` is already set there.
  `settingsHashFor` is at `src/opencode/manager.ts:115-122`; `pendingRestart` is at
  `src/opencode/manager.ts:483-510`.
- **Per-app paths.** `resolveInstanceEnv` (`src/opencode/instance.ts:77-94`) gives each app a HOME,
  XDG dirs, `TMPDIR`, and a mise dir under `<agentsHome>/<sanitized project>/<sanitized app>/`. The
  app agents root is the parent of `state`.
- **App container.** `src/runner/server.ts:584-658` creates the container with the app directory and
  the app agents root as the only writable binds. `src/runner/server.ts:734-816` derives the app mount
  from the running container's bind list and runs the one-shot git container.
- **Runner git config.** `RunnerConfig.hostGitDir`/`gitEnv` (`src/runner/validate.ts:26-40`),
  `gitContainerEnv` (`src/runner/server.ts:394-423`), path translation
  (`src/runner/server.ts:385-392`), and the "credentials not configured" hint
  (`src/runner/server.ts:425-433`) are the ambient mechanism being removed.
- **Git hardening.** `src/git/env.ts:120-161` builds the command-line config; `src/git/service.ts`
  implements the status parser, mutations, auth-failure classification, and redaction;
  `src/git/op.ts:38-61` runs one operation in the sandbox; `src/git/request.ts:42-83` validates the
  fixed operation set.
- **HTTP.** `src/http/git.ts:112-199` is the human-only workbench API; `src/http/settings.ts` owns the
  settings pages and JSON API; `src/http/server.ts:142-159` dispatches `isGit` and `isSettingsRoute`.
- **Deployment.** `compose.yaml:104-119` injects the ambient git variables and mounts
  `HANSE_HOST_GIT_DIR`; `.env.example:38-56` documents them; `docs/deployment.md:180-183,207-209,436-451,485-489`
  describes the old workflow.
- **Image prerequisite.** `a49d5cd` adds `openssh-client` to `agent-base` (`Dockerfile:167-170`). The
  agent, IDE, and app images now have `ssh` and `ssh-keygen`; app images built on the new base inherit
  them. The coordinator runtime and IDE images already provide `ssh`/`ssh-keygen`.
- **Constraints.** Node >= 20, ESM/NodeNext, TypeScript, SQLite via better-sqlite3, no new runtime
  dependency unless justified, repo-root-only repositories, and the existing trusted-repository trust
  model.

## 6. Alternatives considered and rejected

| Alternative | Why rejected |
| --- | --- |
| Keep `HANSE_GIT_*` and add a UI that writes `.env` | Deployment-wide, requires a runner recreate, cannot differ per app, and cannot reach the agent's native git. Decision 8 removes it. |
| Write credentials into each repository's `.git/config` | Repo-controlled, travels with the repository, conflicts with the app-owned git config, and is hard to clear safely. |
| Store git secrets in `settings.value_json` (encrypted or not) | The resolver returns settings values to the API/UI; a single missed redaction leaks a private key or token. A separate status-only store mirrors the provider-key pattern. |
| Put the token/private key in the app container environment | Visible in `/proc/<pid>/environ`, inherited by every child, hard to rotate, and violates "no secrets in one-shot env". Materialize `0600` files instead. |
| Generate the askpass script from an environment token | The old `resolveGitAskpass` embedded the token in a shell script. The new askpass reads a `0600` file and checks the host allowlist. |
| Require an SSH host allowlist in v1 | The private key is never sent to the host, and scoped deploy keys limit the blast radius. A host list adds a second allowlist and host-keyed credential selection, which is backlog. `known_hosts` is the host-authentication control. |
| Multiple credentials per scope in v1 | Requires per-remote selection in the wrapper/askpass and a resolver key per host. The schema keeps a `key` column and the materializer one credential object per kind; multiple keys can be added later. |
| Run Test connection in the coordinator | Repository-controlled git would execute in the coordinator's secret context (the reason B1 moved git to the runner). Test runs in the same one-shot sandbox as the workbench. |
| Upload the test credential dir into the container with Docker's archive API | Avoids a host temp path but adds a new Docker client operation, tar handling, and a less obvious cleanup path. A dedicated writable runner temp root is simpler and auditable (§10.3). |
| Make the workbench/test work for stopped apps | The one-shot image and mounts are derived from the running app container. A stopped-app path needs a second image/mount resolution and is deferred; the UI tells the operator to start the agent. |

## 7. Decision: architecture overview

```
Settings pages / JSON API (human-only)
        |
        v
SettingsService ──── plain keys ────> settings (SQLite v3)
        |                              resolver: global -> project -> app
        |
        └──── GitAuthStore ─────────> setting_secrets (SQLite v8, AES-256-GCM)
                     |                 meta_json: non-secret status only
                     | decrypt once per snapshot (internal only)
                     v
             InstanceManager.ensure
                     |
                     ├── materializeGitCredentials({ agentsRoot, appRoot, home, ... })
                     |      -> <home>/.config/hanse/git
                     |      config, ssh, askpass, id, known_hosts, token, username, https_hosts
                     ├── env: GIT_CONFIG_GLOBAL, GIT_SSH_COMMAND, GIT_ASKPASS, ...
                     └── runtime.ensure(spec) ──> app container
                                                   agent's native git

Web git workbench / Test connection
        |
        v
Coordinator GitService (runner-backed)
        |
        v
Runner POST /v1/apps/:id/git[/test]
        ├── mount <app agents root>/home/.config/hanse/git read-only at /run/hanse/git/app
        └── one-shot container from the app image -> `hanse git-op`
```

Design principles:

- **Plain and secret settings are separate.** Plain values use the existing `settings` resolver and
  appear in the effective API. Secrets use `setting_secrets` and a status-only API. Nothing in the
  resolver output contains secret material.
- **One materialization, two consumers.** The agent container and the one-shot git container read the
  same managed files. There is no second credential path and no runner-global fallback.
- **Paths are stable; content is rewritten.** The spec environment contains only fixed paths. A
  settings change rewrites the files and requires an agent restart to restart the process with the
  new files; the workbench sees the files immediately after a restart.
- **Fail closed, but locally usable.** A missing or undecryptable credential removes the secret files
  and produces a clear auth error on network operations; local status/switch/commit keep working.

## 8. Settings model and data model

### 8.1 Plain settings

Add two definitions to `src/settings/registry.ts` and two members to `src/settings/types.ts`:

| Key | Type | Merge | Clearable | Default |
| --- | --- | --- | --- | --- |
| `git.user.name` | string (1-256 chars) or `null` | `replace` | yes | `null` |
| `git.user.email` | string (3-320 chars, one `@`) or `null` | `replace` | yes | `null` |

```ts
interface EffectiveSettings {
  llm: { /* existing */ };
  web: { /* existing */ };
  git: {
    user: {
      name: EffectiveValue<string>;
      email: EffectiveValue<string>;
    };
  };
}
```

`EffectiveValue<string>` already carries `value: string | null`. The registry definition is
`SettingsKeyDefinition<string | null>` with a non-null string schema and `defaultValue: null`; a stored
JSON `null` is the tombstone handled before schema validation, so the existing resolver semantics do not
change. Validation rejects control characters, NUL, leading/trailing whitespace, and (for email) strings
without exactly one `@` or with whitespace. The name/email are written to the managed git config with
git-config quoting; quotes and backslashes are escaped, never interpolated into a shell.

Resolution is unchanged: absent inherits, `null` is an explicit clear that stops inheritance, and a
narrower scope can set a value again. `scoped` gains `scope:git.user.name` and
`scope:git.user.email` rows for the settings UI. These keys live in the existing `settings` table;
there is no migration for them.

The identity is also visible to the web git workbench: `git var GIT_AUTHOR_IDENT` inside the one-shot
container uses the same managed config, so the existing "commit identity missing" state reflects the
effective `git.user.*` values (or a repository-local identity).

### 8.2 Secret settings: `setting_secrets`

New table in migration v8, modeled on `provider_keys`:

```sql
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
```

Semantics:

- `key` is the setting name. v1 writes only `git.auth.ssh` and `git.auth.https`; the store validates
  that allowlist. The column is a string with only a non-empty CHECK (matching `provider_keys`), so
  host-keyed keys (for example `git.auth.ssh.github.com`) can be added later without a schema rewrite.
- `cipher`/`nonce` seal the **entire JSON credential object** with AES-256-GCM
  (`src/secrets/crypto.ts:33-51`). The plaintext is never a column and never appears in `meta_json`.
- `meta_json` contains only non-secret status metadata:
  - SSH: `{ "kind": "ssh", "publicKey": "...", "fingerprint": "SHA256:...", "hasKnownHosts": true }`
  - HTTPS: `{ "kind": "https", "hosts": ["github.com"], "username": "x-access-token" }`
- `cleared = 1` with null cipher/nonce is the explicit empty override. It stops inheritance and
  suppresses wider scopes. `inherit` deletes the row. `set` upserts and clears the tombstone.
- The PK prefix serves resolution; no extra index is needed at this scale. No foreign key is added,
  for the same reason as `provider_keys`: global rows have no project/app and the coordinator
  validates targets before writing.
- A tombstone stores `meta_json = '{}'` and null cipher/nonce.
- The store enables `secure_delete` and checkpoints the WAL after each mutation, matching
  `ProviderKeyStore` (`src/settings/provider-keys.ts:78-152`). Physical media and backups can still
  retain old pages; this is a documented residual risk.
- One SSH and one HTTPS credential per scope is enforced by `(scope, project_id, app_key, key)`.
  Making `hosts` a list inside the HTTPS value keeps the allowlist coupled to the token. The
  credential is an **atomic value**: a narrower scope's `set` replaces the whole object, including
  `hosts` and `username`; fields are not appended across scopes.

The seam for multiple host-keyed credentials is: keep `key` as a string and keep the store keyed by
`key`; later, resolve all `git.auth.ssh.*` rows and let the wrapper select `id.<host>`; add a matching
`git.auth.https.<host>` selector. v1 does not implement it.

### 8.3 Resolution, clear, and status

`GitAuthStore.listFor(projectId?, appKey?)` returns applicable rows ordered wide to narrow, like
`ProviderKeyStore.listFor` (`src/settings/provider-keys.ts:154-175`). For each kind, the last
matching row wins:

| Row state | Meaning |
| --- | --- |
| absent at every scope | `missing`; no credential is materialized |
| `cleared = 1` at the narrowest row | `cleared`; no credential is materialized, wider scopes are suppressed |
| `cleared = 0` | decrypt and validate; `set` |

Status type (returned by the API and rendered by the pages):

```ts
type GitAuthKind = "ssh" | "https";

type GitAuthStatus =
  | { state: "set"; kind: "ssh"; source: SettingsScope; publicKey: string; fingerprint: string; hasKnownHosts: boolean }
  | { state: "set"; kind: "https"; source: SettingsScope; hosts: string[]; username: string }
  | { state: "cleared"; kind: GitAuthKind; source: SettingsScope }
  | { state: "error"; kind: GitAuthKind; message: string }
  | { state: "missing"; kind: GitAuthKind };
```

The status never includes `privateKey`, `token`, or `knownHosts` content. `hasKnownHosts` is a boolean.
The service decrypts a set row once to validate it and build the status; the plaintext is discarded
and never returned. Decryption or schema failure produces `state: "error"` with a bounded message; it
never falls back to a wider scope or to ambient git config, and the materializer removes stale secret
files. The `ResolvedSettings` response gains:

```ts
gitAuth: { ssh: GitAuthStatus; https: GitAuthStatus };
gitAuthScoped: {
  ssh: Record<SettingsScope, "absent" | "cleared" | "set">;
  https: Record<SettingsScope, "absent" | "cleared" | "set">;
};
```

`gitAuthScoped` is the raw per-scope state for the UI's "Inherited / Cleared / Set" rows. It does not
carry values.

### 8.4 Hashing and restart detection

`SettingsService.snapshot(target)` decrypts the effective SSH/HTTPS credentials once and returns them
internally together with a hash:

```ts
interface LaunchSettingsSnapshot {
  resolved: ResolvedSettings;
  mergedAuth: Record<string, unknown>;
  authHash: string;
  providerKeys: Map<string, ProviderKeyState>;
  gitAuth: {
    ssh?: { privateKey: string; knownHosts?: string };
    https?: { hosts: string[]; username: string; token: string };
  };
  gitAuthHash: string;
}
```

`gitAuthHash` is `hashValue({ purpose: "git-auth-v1", ssh: ..., https: ... })` over the **plaintext**
values (using the deterministic serializer in `src/settings/hash.ts`). SHA-256 over plaintext is
one-way; the hash is never returned by the API and never logged. Both kinds are included, including
their absence, so setting or clearing either changes the hash. A decryption/schema failure is
represented by a stable error marker in `gitAuthHash`; `snapshot` does not throw for a bad credential,
so `effectiveHash` and `pendingRestart` keep working and the UI shows the error state.

`SettingsService.effectiveHash` gains `gitAuthHash`. `InstanceManager.settingsHashFor`
(`src/opencode/manager.ts:115-122`) gains `gitAuthHash` as well; the effective settings object already
contains `git.user.*` once `EffectiveSettings` grows. A secret-only change therefore makes
`pendingRestart` true even though the materialized paths and the spec environment strings are
unchanged. The existing `settings_changed` reason is sufficient; no new reason string is required. The
UI copy says "Git credentials changed — restart the agent to apply."

`pendingRestart` calls `snapshot()` on each render; it decrypts at most two small credentials per app.
No plaintext is cached. If a coordinator restart reattaches to a running container, the existing
behavior records the current hash, so a change made while the coordinator was down is not detected;
this is the same limitation as provider keys and is recorded in §13.

### 8.5 Validation on save

All validation runs in the coordinator before sealing. It uses `ssh-keygen` from the coordinator image
(already present) through an injectable `runSshKeygen` seam for tests. No shell is used; arguments are
an array with a 5 s timeout.

**SSH key (`privateKey`):**

- Size 1 byte to 32 KiB; normalize CRLF to LF; reject NUL and control characters except newline.
- Must start with `-----BEGIN ` and end with the matching `-----END ... PRIVATE KEY-----`; public keys
  and certificates are rejected.
- Write the draft to a `0600` temp file, run
  `ssh-keygen -y -P "" -f <temp>` (the file form of `ssh-keygen -y -f -P ""`), then remove the temp
  file in `finally`.
- Non-zero exit with `incorrect passphrase`, `passphrase is needed`, or `encrypted` in the captured
  stderr is the **passphrase-protected** error:
  "This SSH key is passphrase-protected. Passphrase-protected keys are not supported in v1; use an
  unencrypted deploy key."
- Any other non-zero exit is `invalid_key` with a bounded, redacted stderr excerpt.
- On success, stdout is the OpenSSH public key. Reject `ssh-dss` (disabled in modern OpenSSH). Derive
  the fingerprint with `ssh-keygen -lf` on the public-key temp file and store `SHA256:...`.
- The stored `meta_json` holds the public key, fingerprint, and `hasKnownHosts`; the sealed value holds
  the private key and known-hosts content.

**`knownHosts` (optional):**

- Size 0 to 16 KiB; normalize CRLF; reject NUL and control characters except newline. An empty or
  whitespace-only value is normalized to **absent** (the UI textarea submits an empty string); a
  non-empty value must contain at least one non-empty, non-comment line.
- Write to a `0600` temp file and run `ssh-keygen -l -f <temp>`. A non-zero exit is
  `invalid_known_hosts` with "The known_hosts file is not valid; paste the output of
  `ssh-keyscan <host>`." Remove the temp file in `finally`.
- Hashed host entries (`|1|...`) and `@cert-authority`/`@revoked` markers are accepted if
  `ssh-keygen` accepts them.

**HTTPS:**

- `hosts`: array of 1-32 entries. Lowercase; trim; deduplicate. Each entry is a DNS name (letters,
  digits, `-`, `.`), an IPv4 literal, or a bracketed IPv6 literal. Reject schemes, paths, userinfo,
  wildcards, CIDR, ports, whitespace, control characters, and empty entries. Exact host matching; the
  port is ignored. This is the mandatory exfiltration guard.
- `username`: 1-256 characters, trimmed, no control characters.
- `token`: 1-4096 characters, trimmed, no NUL/control characters. Tokens are opaque; do not validate
  a provider-specific prefix.
- No network call on save. Network validation is the Test connection button.

**Common:** the whole request is capped by the existing 64 KiB body limit. The per-field caps above
leave headroom. A validation failure returns `400` with a stable field name and never echoes the
submitted secret.

### 8.6 Host allowlisting and the SSH stance

**HTTPS `hosts` is mandatory.** Without it, a changed remote URL (written by the agent or a malicious
repository) could redirect the askpass token to an attacker's host. The askpass helper:
1. parses the URL in the credential prompt;
2. extracts the hostname, strips userinfo and port, lowercases it;
3. requires an exact match in `https_hosts`; otherwise prints a bounded error to stderr and exits 1
   without writing the username or token.

The list is exact-match only. It is not an egress control: a compromised agent can read the token file
and use the token directly. It specifically protects the **askpass path** and makes an accidental
remote change fail closed. No wildcard or suffix matching exists in v1 (for example `github.com` does
not allow `gist.github.com`; list both if needed).

**SSH has no host allowlist in v1.** The private key is not sent to the remote; it signs a challenge
locally, so a changed SSH remote cannot receive or extract the key. An attacker can still make the
agent authenticate to an attacker-controlled SSH server and receive repository data the agent pushes,
so the meaningful controls are:

- scoped deploy keys (one repository, read-only unless push is needed);
- `known_hosts` when the operator wants strict host pinning;
- `IdentitiesOnly=yes`, `IdentityAgent=none`, `BatchMode=yes`, no agent forwarding, and
  `-F /dev/null` (no ambient `~/.ssh/config`);
- `GIT_CEILING_DIRECTORIES` and the repository-root rule.

A host allowlist for SSH would add a second list and interact with host-keyed credential selection;
the owner chose to keep v1 simple. It is backlog, together with multiple host-keyed keys.

### 8.7 HTTP API

All routes are human-only. JSON requests from agent principals receive `403`; HTML pages redirect
unauthenticated humans to login. Mutations are POST; the existing `SameSite=Strict` cookie remains the
CSRF control. `return_to` goes through `safeLocalPath`.

**Extend `GET /api/settings`** (and the existing settings page render path) with `effective.git.user`,
`gitAuth`, and `gitAuthScoped`. The response never contains plaintext credentials. The
`Cache-Control: no-store` header stays. `isSettingsRoute` (`src/http/settings.ts:316-330`) gains `/api/settings/git`; the
`/git/test` route is already covered by `isGit` (`src/http/server.ts:142-159`).

**Add `POST /api/settings/git`** (JSON only; `Content-Type: application/json`):

```ts
{
  scope: "global" | "project" | "app";
  projectId?: string;
  appKey?: string;
  kind: "ssh" | "https";
  action: "set" | "clear" | "inherit";
  value?: GitSshDraft | GitHttpsDraft; // required for set, rejected otherwise
}
```

- `ssh` value: `{ privateKey: string, knownHosts?: string }`.
- `https` value: `{ hosts: string[], username: string, token: string }`.
- `set` validates, seals, and writes the row; `clear` writes a tombstone; `inherit` deletes the row.
- Returns `200` with the updated settings response (status only) for JSON callers. A validation
  failure returns `400 { error, code: "invalid_git_credential", field? }`.
- The page's identity forms continue to post to `POST /api/settings` with
  `key=git.user.name|git.user.email` and `action=set|clear|inherit`. The credential forms are
  JSON-only because a private key and a known_hosts file are multiline and must not be placed in a
  query string or a hidden HTML field; `assets/git-settings.js` submits them.

**Add `POST /api/projects/:projectId/apps/:appKey/git/test`** (human-only; JSON only):

```ts
{
  kind: "ssh" | "https";
  remote?: string;              // optional; defaults to the app's origin
  ssh?: { privateKey: string; knownHosts?: string };
  https?: { hosts: string[]; username: string; token: string };
}
```

- Exactly one of `ssh`/`https` is required, and it must match `kind`.
- `value` bounds are the same as save. `remote`, when present, is 1-2048 characters and must pass the
  existing `validateRemoteUrl` plus a scheme check: `ssh` accepts `ssh://` or scp-like
  `user@host:path`; `https` accepts `https://` only. In addition, reject any parsed URL whose
  `password` is non-empty for both `https://` and `ssh://` (a username-only URL is allowed).
  `http://`, `git://`, `ext::`, whitespace, control characters, and embedded passwords are rejected.
- When `remote` is present and `kind=ssh`, the SSH host is not restricted (see §8.6). When `kind=https`,
  the remote host must be in the draft `hosts`; otherwise `400 host_not_allowed` before any sandbox
  runs.
- The response is `GitTestResult` (§10.3). Errors use `400` for invalid input/scheme/host, `409` for
  `restart_required`/`not_running`/`missing_remote`, `502` for auth/network failures, and `504` for a
  timeout. Error messages are redacted and bounded.
- The test does not write settings, the materialized app directory, or any database row.

## 9. Materialization

### 9.1 Location and files

The managed directory is:

```text
<app agents root>/home/.config/hanse/git/
├── config          # git config (0600): user identity, credential.helper=, core.sshCommand
├── ssh             # SSH wrapper (0700)
├── askpass         # HTTPS askpass helper (0700)
├── id              # SSH private key (0600; absent when no SSH credential)
├── known_hosts     # optional managed known_hosts (0600; absent when not configured)
├── token           # HTTPS token (0600; absent when no HTTPS credential)
├── username        # HTTPS username (0600; absent when no HTTPS credential)
└── https_hosts     # one lowercase host per line (0600; absent when no HTTPS credential)
```

`<app agents root>` is the parent of the app's `state` directory, i.e.
`<HANSE_AGENTS_HOME>/<sanitized project>/<sanitized app>` from `resolveInstanceEnv`. The coordinator
owns the directory through the read-write `/data/agents` mount; the runner sees it read-only and
mounts the `git` subdirectory into the one-shot container. The path recorded in the app env is the
path the coordinator sees through that mount (`/data/agents/...`), which is also the app container's
mount path; this is the existing `resolveInstanceEnv` assumption. Nothing is written under `~/.ssh`,
so a user's `id_*`, `config`, or agent socket is never clobbered or read.

The materializer never uses the agent's `HOME/.ssh`; the wrapper uses `-F /dev/null` and an explicit
`-i` path, and the askpass is explicit. This is the "no clobbering `~/.ssh/id_*`" guarantee.

### 9.2 Modes, ownership, and atomic writes

- Directories `0700`; the key, known_hosts, token, username, hosts file, and config `0600`; the `ssh`
  and `askpass` scripts `0700`.
- **No symlink following, including `home`.** The materializer receives `agentsRoot`, `projectId`, and
  `appKey` (sanitized exactly as `resolveInstanceEnv` does), computes
  `expectedAppRoot = path.join(realpath(agentsRoot), sanitizeAppKey(projectId), sanitizeAppKey(appKey))`,
  and requires `lstat(appRoot)` and `lstat(home)` to be real directories,
  `realpath(appRoot) === expectedAppRoot`, and `realpath(home) === path.join(expectedAppRoot, "home")`.
  This rejects a symlinked `appRoot`, a symlinked parent component, or a symlinked `home`. It then
  `lstat`s every managed component (`.config`, `hanse`, `git`) and refuses or removes a symlink before
  writing; the target directory must realpath inside `<realpath(home)>/.config/hanse`. Temp files are
  opened with `O_CREAT|O_EXCL|O_NOFOLLOW`; mode/ownership are set on the temp file **before** `rename`,
  and the final path is never re-chmodded/chowned. Rename replaces a symlink at the final component
  rather than following it. This closes the `home -> /data/state` or
  `home -> ../../otherapp/home` bypass: the app owns its agents root, so `home` itself must be checked,
  not used as the containment base. A legitimately symlinked `agentsRoot` is supported because the
  expected path is derived from `realpath(agentsRoot)`, not from the literal string.
- Writes use a temp file in the same directory (`.<name>.tmp-<random>`), `chmod`, `fsync` where
  practical, then `rename` over the target. A reader never sees a partial key or token.
- The coordinator normally runs as uid 1000 in Compose, so files are created as 1000:1000 and the app
  container (uid 1000) can read them. If `process.getuid()` is not 1000, the materializer attempts
  `chown(1000, 1000)`; production fails the start with `git_credentials_materialize_failed` when it
  cannot produce 1000-owned files, while tests inject an ownership seam. There is no warning-only mode
  in production.
- On every materialization the materializer rewrites `config`, `ssh`, and `askpass`, and then either
  writes or **removes** `id`, `known_hosts`, `token`, `username`, and `https_hosts`. Removal is how
  `inherit`/`clear` and a kind switch take effect; a stale credential must never survive.
- The `config`, `ssh`, and `askpass` files are always present so the environment paths are stable and
  local git works with no network credential. They contain no secret values.
- `writeGitCredentialFiles` takes a `visibleDir` option used for the `core.sshCommand` value. The app
  materializer passes the directory's app-container path (`<isolated.HOME>/.config/hanse/git`, which is
  what the coordinator sees through its `/data/agents` mount); the test materializer passes
  `/run/hanse/git/app`. The wrappers themselves discover their own directory, so the same file content
  works in both mount locations.

### 9.3 Environment contract

`InstanceManager.ensure` adds these variables to the app container spec (paths except where noted):

| Variable | Value |
| --- | --- |
| `GIT_CONFIG_GLOBAL` | `<dir>/config` |
| `GIT_CONFIG_NOSYSTEM` | `1` |
| `GIT_TERMINAL_PROMPT` | `0` |
| `GIT_SSH_COMMAND` | `'<dir>/ssh'` (shell-quoted command string) |
| `GIT_ASKPASS` | `<dir>/askpass` |
| `GIT_ASKPASS_REQUIRE` | `force` |
| `HANSE_CREDENTIALS_DIR` | `<dir>` (internal marker consumed by `src/git/env.ts`) |
| `GIT_CEILING_DIRECTORIES` | app's real parent (existing; unchanged) |
| `LC_ALL` / `LANG` | `C` (stable askpass prompt strings) |

No token, private key, or known-hosts content is placed in the environment, `OPENCODE_CONFIG_CONTENT`,
the runtime spec, or the database. The paths are stable across settings changes, so an agent restart
with the same container spec is sufficient; the rewritten files are visible through the existing
`/data/agents/<project>/<app>` bind. The spec hash changes when the app is recreated after an upgrade
because the env set gains these keys; the restart then creates or reuses a container with the new env.
`GIT_SSH_COMMAND` and `core.sshCommand` are shell-interpreted, so the wrapper path is shell-quoted with
the existing `shellQuote` helper; `GIT_ASKPASS` is a direct program path.

`src/runner/validate.ts` and `src/agent/spec.ts` must include `GIT_CONFIG_GLOBAL`, `GIT_ASKPASS`, and
`HANSE_CREDENTIALS_DIR` in their path-key sets. `GIT_SSH_COMMAND` is a shell command string, not a plain
path: do **not** add it to `ENV_PATH_KEYS`; both validators use a shared `validateGitSshCommand` that
accepts only the generated `shellQuote(<path>)` form, unwraps it, and checks the path is inside the
application's agents root. Add a test with a quoted path and a path outside the root.

`src/opencode/policy.ts:81-92` must also scrub inherited git configuration before the managed values
are applied: add `GIT_CONFIG_GLOBAL`, `GIT_CONFIG_SYSTEM`, `GIT_CONFIG_NOSYSTEM`, `GIT_CONFIG_COUNT`,
`GIT_CONFIG_KEY_*`, `GIT_CONFIG_VALUE_*`, `GIT_SSH_COMMAND`, `GIT_SSH`, `GIT_ASKPASS`,
`GIT_ASKPASS_REQUIRE`, `GIT_TERMINAL_PROMPT`, `GIT_SSL_CAINFO`, `GIT_DIR`, `GIT_WORK_TREE`,
`GIT_CEILING_DIRECTORIES`, `HANSE_CREDENTIALS_DIR`, `HANSE_CREDENTIALS_READONLY`, and every legacy
config/credential `HANSE_GIT_*` variable to `SCRUBBED_ENV_KEYS`. The manager builds an explicit env
object (no `process.env` spread), but the B0 `launcher.ts` path spreads `process.env` and must not
inherit a host credential dir or helper.

### 9.4 SSH wrapper

`ssh` is a POSIX shell script, mode 0700:

```sh
#!/bin/sh
# Hanse managed SSH wrapper. Do not edit; it is rewritten by the coordinator.
dir=$(CDPATH= cd -- "$(dirname -- "$0")" && pwd)

if [ ! -f "$dir/id" ]; then
  echo "hanse: no SSH credential is configured for this application" >&2
  exit 1
fi

if [ -s "$dir/known_hosts" ]; then
  strict=yes
  user_kh="$dir/known_hosts"
else
  strict=accept-new
  if [ "${HANSE_CREDENTIALS_READONLY:-0}" = "1" ]; then
    user_kh="${TMPDIR:-/tmp}/hanse-known_hosts"
  else
    user_kh="$dir/known_hosts"
  fi
fi

exec ssh -F /dev/null \
  -i "$dir/id" \
  -o IdentitiesOnly=yes \
  -o IdentityAgent=none \
  -o BatchMode=yes \
  -o ConnectTimeout=20 \
  -o GlobalKnownHostsFile=/dev/null \
  -o UserKnownHostsFile="$user_kh" \
  -o StrictHostKeyChecking="$strict" \
  "$@"
```

- With a managed `known_hosts`, the file is authoritative (`GlobalKnownHostsFile=/dev/null`,
  `StrictHostKeyChecking=yes`). A changed host key fails.
- Without it, `accept-new` accepts a previously unknown host but still rejects a **changed** key. In
  the read-only one-shot mount, newly trusted entries go to `${TMPDIR:-/tmp}/hanse-known_hosts`
  because the managed directory cannot be written; this is why the one-shot container sets
  `HANSE_CREDENTIALS_READONLY=1`. In the app container the managed directory is writable, so TOFU
  persists to `$dir/known_hosts` until the next materialization. Because the materializer removes
  `known_hosts` when the setting is absent, learned host keys last only until the next agent restart;
  pinning `known_hosts` is the way to keep them.
- A missing `id` fails before invoking `ssh`, with a clear message. There is no fallback to ambient
  keys or the SSH agent.
- `"$@"` is passed unchanged (git supplies the destination and remote command). No shell interpolation
  of user input occurs in the wrapper.

### 9.5 HTTPS askpass

`askpass` is a POSIX shell script, mode 0700, with no `eval`:

```sh
#!/bin/sh
dir=$(CDPATH= cd -- "$(dirname -- "$0")" && pwd)
prompt=$1

case "$prompt" in
  *"Username for '"*|*"Password for '"*) ;;
  *) echo "hanse: unexpected git credential prompt" >&2; exit 1 ;;
esac

url=${prompt#*\'}
url=${url%%\'*}
case "$url" in
  https://*) ;;
  *) echo "hanse: refusing a non-HTTPS credential prompt" >&2; exit 1 ;;
esac

host=${url#*://}
host=${host%%/*}
host=${host##*@}
host=$(printf '%s' "$host" | tr '[:upper:]' '[:lower:]')
case "$host" in
  \[*\]:*) host="${host%]:*}]" ;;
  \[*\]*)  ;;
  *:*)     host=${host%%:*};;
esac

if [ ! -s "$dir/https_hosts" ]; then
  echo "hanse: no HTTPS credential is configured for this application" >&2
  exit 1
fi

if ! grep -Fxiq -- "$host" "$dir/https_hosts"; then
  echo "hanse: git host '$host' is not in the HTTPS allowlist" >&2
  exit 1
fi

case "$prompt" in
  *"Username for"*) cat "$dir/username" ;;
  *"Password for"*) cat "$dir/token" ;;
  *) echo "hanse: unsupported git credential prompt" >&2; exit 1 ;;
esac
```

- Only the two expected prompts are answered. A verification-code, OTP, or unknown prompt produces an
  error, not the token.
- Only `https://` prompts are answered. A repository that changes its remote to `http://`, `ftp://`, or
  any other scheme gets no credential; this closes the plaintext-token path.
- The host is parsed from the prompt URL, not from an environment variable, so a changed remote cannot
  reuse a stale host check.
- `grep -Fxiq` is exact, case-insensitive, fixed-string matching. The host list is one entry per line.
- `credential.helper =` in the managed global config disables inherited helpers for the managed scope;
  a repository-local helper can still override it, which is accepted under the agent-readable model
  (the agent can read the token anyway). `GIT_ASKPASS_REQUIRE=force` makes git use this helper even
  when a terminal is present; `GIT_TERMINAL_PROMPT=0` prevents hangs.
- The token is never written into a remote URL. The config and the wrapper do not rewrite remotes.
  Existing remotes with an embedded password remain readable but are redacted in status output; the
  Test connection body rejects an embedded password in its `remote` field, so a draft never carries
  one. A username-only URL is allowed and the configured username is used when the URL has none.

### 9.6 Managed `config`

```ini
[user]
	name = "Ada Lovelace"
	email = "ada@example.com"

[credential]
	helper =

[core]
	sshCommand = '/home/.../home/.config/hanse/git/ssh'
	askpass = /home/.../home/.config/hanse/git/askpass
```

- The `[user]` section is omitted when both identity values are unset; repository-local identity still
  works, and the workbench's identity preflight reports the missing identity.
- Identity values use git-config double-quote and backslash escaping; control characters are already
  rejected at save time. The `core.sshCommand` value is shell-single-quoted with the existing
  `shellQuote` helper (export it from `src/git/env.ts`) because git passes that value to the shell;
  `core.askpass` is a direct path and is written without shell quoting.
- `[credential] helper =` is always present (empty).
- `[core] sshCommand` and `[core] askpass` duplicate `GIT_SSH_COMMAND`/`GIT_ASKPASS` so a process that
  unsets those environment variables still uses the managed wrappers, provided `GIT_CONFIG_GLOBAL`
  still points at the managed config.
- Path precedence: command-line `-c` (the one-shot workbench) > `GIT_SSH_COMMAND`/`GIT_ASKPASS`
  (both contexts) > `core.sshCommand`/`core.askpass` in `config`. The app materializer writes its own
  app-container path in `config`; the one-shot container sets the env and `-c` to
  `/run/hanse/git/app`, so the same file works in both mount locations. The test materializer passes
  `visibleDir: "/run/hanse/git/app"` so its `config` fallback is also correct there.
- No `commit.gpgsign`, `tag.gpgsign`, `url.*.insteadOf`, or non-empty credential helper is written. GPG signing
  remains out of scope; a repository that enables it fails with a clear git error in the one-shot
  workbench (the existing signing refusal stays).

## 10. Runtime integration

### 10.1 `InstanceManager.ensure`

Production `ensure` (`src/opencode/manager.ts:265-476`) already takes one settings snapshot inside the
per-app lock. Add:

1. A new module `src/git/materialize.ts` exporting
   `materializeGitCredentials({ agentsRoot, appRoot, home, projectId, appKey, identity, auth })` and
   `writeGitCredentialFiles(dir, input)`. The materializer is pure filesystem work plus injectable
   ownership; it never reads the DB.
2. Before the call, `ensure` creates `appRoot` and `home` with
   `mkdirSync(..., { recursive: true, mode: 0o700 })` if absent (the existing token/password/profile
   writers may already have created them). A pre-existing symlink is not repaired by `mkdir`; the
   materializer's lstat check fails closed. Then, after the snapshot and before `runtime.ensure`, call
   it with `agentsRoot: this.#runtimeRoot`, `appRoot: path.dirname(isolated.HOME)`,
   `home: isolated.HOME`, `projectId: app.projectId`, `appKey: app.appKey`,
   `identity: effective.git.user`, and `auth: snapshot.gitAuth`. The materializer verifies `appRoot`
   against `realpath(agentsRoot)` plus the two sanitized segments and rejects a symlinked `home`
   (§9.2).
3. Add the env fragment from §9.3 to the `env` object at `src/opencode/manager.ts:401-415`. Keep
   `GIT_CEILING_DIRECTORIES`.
4. Include `snapshot.gitAuthHash` in `settingsHashFor`; `effective.git.user` is already included via
   `effective`.
5. If materialization fails (permissions, disk full, unwritable directory), throw
   `git_credentials_materialize_failed` with a bounded message; do not start the agent without the
   managed config. This is fail-closed: the agent never silently falls back to ambient git config.
6. If the settings source is not wired (unit tests, local B0 path), skip materialization and the env
   fragment; behavior is unchanged.

**B0/local non-runner path is explicitly unsupported for managed git credentials.** `launcher.ts` /
`buildInstanceEnv` do not receive a settings snapshot, so they cannot materialize or decrypt. Leave them
without managed git env and without a credential fallback; this avoids a half-implemented `LaunchInput`
interface. Network git in B0/local uses the repository's own git configuration; the production B1
runner path is the supported one. The scrub list still removes inherited legacy `HANSE_GIT_*` so a host
credential cannot leak into a local instance.

The `ensure` early-return for an already-running container (`src/opencode/manager.ts:279-306`) is
unchanged: a settings change does not hot-reload the process. The operator uses the existing restart
action. On restart, `stopApp`/`ensure` runs, rewrites the files, and starts the container with the same
stable env paths. If the app was created before this stage and is still running, its container lacks
the new env; the rollout restarts it (§16).

### 10.2 Web git workbench

The workbench route and hardening stay in `src/http/git.ts` and `src/git/{service,op,env,request}.ts`.
The runner changes:

1. **App agents root.** When creating an app container, set a label
   `hanse.agents.root=<spec.hostAgentsRoot>` from the validated spec
   (`src/runner/server.ts:615-645`), and add the same value to the coordinator's
   `hashInput.labels` (`stateDir` already encodes the path) so the spec hash covers it. A restart then
   creates a labeled container. An already-running pre-upgrade container is not restarted
   automatically and returns `409 restart_required` until the operator restarts it (§16.2). On `git()`
   and `test()`, read the label, re-validate it with
   `resolveWithinRoot({ target: label, root: config.hostAgents })`, and require exactly two path
   segments (`<project>/<app>`). A missing label or an invalid path means the container predates this
   stage: return `409 restart_required` ("Restart the agent to materialize git credentials.").
2. **Credential directory.** Compute
   `credentialDirHost = path.join(hostAgentsRoot, "home", ".config", "hanse", "git")`. Before using
   it, `realpath` `hostAgentsRoot/home` and require it to equal `<realpath(hostAgentsRoot)>/home`, with
   `lstat` proving `home`, `.config`, `hanse`, and `git` are real directories (not symlinks); otherwise
   return `409 restart_required` with "The application home is not a real directory; repair it and
   restart the agent." This closes the same `home`-symlink path for the workbench/test mount. Require
   `config`, `ssh`, and `askpass` to exist; otherwise `409 restart_required`. This makes a
   half-materialized app fail explicitly instead of running an unconfigured git.
3. **Mount.** Add `${credentialDirHost}:/run/hanse/git/app:ro` to the one-shot container in addition to
   the existing app-directory bind. Do **not** mount the whole agents root. The one-shot container
   still has no `/data/state`, no Docker socket, no coordinator/runtime token, and `read-only rootfs`
   with `tmpfs` `/tmp` and `/run`.
4. **Environment.** Remove `gitContainerEnv`'s `config.gitEnv` loop and path translation. Set:
   `GIT_CONFIG_GLOBAL=/run/hanse/git/app/config`,
   `GIT_SSH_COMMAND` = the shell-quoted `'/run/hanse/git/app/ssh'`,
   `GIT_ASKPASS=/run/hanse/git/app/askpass`,
   `GIT_ASKPASS_REQUIRE=force`,
   `HANSE_CREDENTIALS_DIR=/run/hanse/git/app`,
   `HANSE_CREDENTIALS_READONLY=1`,
   `GIT_CONFIG_NOSYSTEM=1`, `GIT_TERMINAL_PROMPT=0`, `GCM_INTERACTIVE=never`,
   `HOME=/tmp/hanse-git-home`, `TMPDIR=/tmp`, `LC_ALL=C`, `LANG=C`, plus the existing operation
   fields and `PATH`. No credential value is in the env.
5. **GitService.** `git-op` constructs `GitService` with `env: process.env` (unchanged). `GitService`
   stops creating its own temp helper dir and stops deriving an askpass from a token. It reads
   `HANSE_CREDENTIALS_DIR` and uses the managed paths. If the variable is absent (unit tests or a
   local service), it uses a private empty home under `os.tmpdir()`, plain `ssh`,
   `GIT_CONFIG_GLOBAL=/dev/null`, and an explicit empty `GIT_ASKPASS` plus `-c core.askpass=` so a
   repository cannot supply its own askpass. This fallback is test/local only and has no managed
   credentials.
6. **Hardening.** Keep `gitConfigArgs` (`src/git/env.ts:127-161`): `color.ui=false`,
   `core.hooksPath=/dev/null`, `core.fsmonitor=false`, `credential.helper=`,
   `protocol.ext.allow=never`, `submodule.recurse=false`, `core.pager=cat`,
   `core.sshCommand=<managed wrapper>`, `core.askpass=<managed askpass>` when present, and the safe
   remote upload/receive-pack pins. Command-line config overrides repository config, so a repo cannot
   substitute its own SSH command, helper, or hooks.
7. **Credentials-not-configured hint.** The old `hasGitCredentials(config)` hint is replaced by a
   check of the mounted directory: if neither `id` nor `token` exists, append "Git credentials are not
   configured for this application. Configure SSH or HTTPS in Settings." to an auth failure. The
   coordinator can also enrich the message from `gitAuth` status.

The coordinator `RunnerGitClient` (`src/git/runner-client.ts`) keeps the fixed operation set and adds
the test call (§10.3). The coordinator `GitService` remains the only place that resolves the app path
and app id; the runner never trusts a client path.

**Stopped app behavior.** The workbench and Test connection require the app container to be running,
because the one-shot image and the app/agents mount source are derived from the running container. A
stopped app returns `409 not_running`; the UI shows "Start the agent to use git actions." This is the
existing workbench behavior, now explicitly also true for Test connection. Local status for a stopped
app could be added later by resolving the app image and mounts without a running container; it is out
of scope.

**Settings changed without restart.** The materialized files are rewritten on the next restart. Until
then the agent and the one-shot workbench see the previous files. The app/settings page shows the
existing "Restart required" marker because `settingsHashFor` includes `gitAuthHash`. A manual fetch
from the workbench before restart uses the old credential, which is expected and stated in the UI.

### 10.3 Test connection

**Coordinator flow.**

`POST /api/projects/:projectId/apps/:appKey/git/test` (human-only, JSON only):

1. `handleGit` authenticates the human principal, finds the project/app, and resolves the app path with
   the existing `appDir`/`resolveRepository` rules (workspace containment, repository root). It uses
   the app id for runner routing.
2. Validate the body with the §8.5 validators. `kind` and the matching draft are required; unknown
   fields are rejected; `remote` is optional and validated for scheme and embedded credentials.
3. For `kind=https` with a supplied `remote`, require the remote's host in the draft `hosts` and return
   `400 host_not_allowed` before any container starts. For `kind=ssh`, require `ssh://` or scp-like.
4. Call `deps.git.testConnection(resolved, { kind, remote, ssh, https })`. In production `GitService`
   has the runner client; the method calls `RunnerGitClient.test`. If no runner is configured (local
   dev/test without `HANSE_RUNNER_URL`), return `503 runner_required`; the production Compose stack
   always has a runner.
5. Map the result to `GitTestResult` or a redacted error. Do not save anything.

**Runner flow.**

`POST /v1/apps/:appId/git/test` (runtime-token protected) with the same body. The runner:

1. Validates the body shape and bounds (a dedicated `validateGitTestRequest`, not the generic
   `GitRequest` validator), including exactly one credential kind and the remote scheme.
2. Resolves the running app container exactly like `git()`: managed label, running state, allowed app
   image, app mount, agents root, and the managed credential directory. A stopped app is
   `409 not_running`; a pre-upgrade container or missing directory is `409 restart_required`.
3. Creates an ephemeral root under `config.hostRunnerTmp`:
   `<hostRunnerTmp>/git-test-<uuid>/`. Writes the draft with the same `writeGitCredentialFiles` core
   used by the app materializer; the writer applies the `1000:1000` ownership to temp files and
   directories before `rename` through the same ownership seam, so the runner does not chown final
   paths. The temp root itself is `0700`.
   Because the directory is bind-mounted at `/run/hanse/git/app`, the writer is called with
   `visibleDir: "/run/hanse/git/app"` so the generated `config` contains the **container** path in
   `core.sshCommand`, not the host temp path. `hostRunnerTmp` is a new absolute host path, mounted at
   the same absolute path in the runner and writable by it. It must not overlap the workspace or
   agents roots.
4. Creates a one-shot container from the running app image, `user: 1000:1000`, command
   `["/usr/local/bin/hanse", "git-op"]`, with the app directory `ro` (the test only reads),
   the temp `git` directory `/run/hanse/git/app:ro`, the app network (egress), and the env from §10.2
   plus `HANSE_GIT_OP=test`, `HANSE_TEST_KIND=<kind>`, and `HANSE_TEST_REMOTE=<remote>` only when the
   caller supplied one. `GIT_SSH_COMMAND` is shell-quoted. `HANSE_TEST_REMOTE` is not secret; embedded
   passwords are rejected before it is set, while username-only userinfo is allowed.
5. Starts the container and waits up to 60 s (inner `ls-remote` timeout 45 s). Captures bounded logs
   (existing 4 MiB cap) and parses a JSON envelope, like the existing git op.
6. Parses `GitTestResult`. `git-op test` adds the `host_key_tofu` warning when `knownHosts` was omitted
   ("No known_hosts was supplied; a new host key is trusted on first use. Add known_hosts to pin it.")
   and, when `$TMPDIR/hanse-known_hosts` exists, reads it with `ssh-keygen -lf` and includes bounded
   host-key fingerprints in `warnings`. The runner only merges the result; it does not read the
   container's tmpfs.
7. In `finally`, removes the container (`force: true`) and the temp directory recursively. A failure
   to clean up is logged as a warning with the path only; a runner-startup sweep removes stale
   `git-test-*` directories older than one hour.

**`git-op test`.**

`git-op` gains a dedicated `runGitTest` entry point (selected by `HANSE_GIT_OP=test`). It does **not**
extend the workbench's `GitRequest`/`GIT_OPERATIONS` set, so `POST /v1/apps/:id/git` still rejects a
`test` operation. Steps:

1. Resolve the repository with the existing `resolveRepository` (workspace containment, repo root).
2. If `HANSE_TEST_REMOTE` is set, use it; otherwise run `git remote get-url origin` with the hardened
   args. Absence of `origin` is `missing_remote` ("No remote is configured and no remote was given.").
3. `validateRemoteUrl(url, appDir)` and check the scheme against `HANSE_TEST_KIND`: `ssh` accepts
   `ssh://` and scp-like; `https` accepts `https://` only. A mismatch is
   `credential_scheme_mismatch`.
4. Run `git ls-remote <url>` with the existing timeouts/caps (inner 45 s, 8 MiB buffer). Parse the
   output into `{ refs, head? }`: `refs` is the number of lines; `head` is the SHA of the `HEAD` line
   when present. Do not return raw ref lines (unbounded/odd ref names); return counts and a short
   redacted remote.
5. Return `{ ok: true, kind, remote: redactUserinfo(url), refs, head?, warnings: [] }`, where
   `warnings` includes the TOFU warning and fingerprints read from `$TMPDIR/hanse-known_hosts`. Auth
   and network failures pass through `remoteFailure`/`failureFromResult`, so they map to `auth_failed`
   or `git_failed` with redaction.

**Response type.**

```ts
interface GitTestResult {
  ok: true;
  kind: "ssh" | "https";
  remote: string;      // redacted userinfo
  refs: number;
  head?: string;
  warnings: string[];  // TOFU and host-key fingerprints; never secrets
}
```

The test uses the same 60 s budget as the requirement. It does not run for a stopped app; the UI says
so. It never writes a database row or the app's managed directory.

`handleGit` maps test errors explicitly: validation/host/scheme failures -> `400`; `not_running`,
`restart_required`, `missing_remote`, `not_git`, and `not_root` -> `409`; auth/network failures ->
`502`; timeout -> `504`. This requires extending the existing git error mapping, which currently maps
`timeout` to `500`.

### 10.4 UI

The existing settings pages gain a **Git** section (global, project, and app scopes), rendered by
`src/http/settings.ts`:

- **Identity.** Effective `git.user.name`/`git.user.email`, scoped rows, and a normal form with
  Set/Inherit/Clear.
- **SSH credential.** Status badge (`Set at app` / `Inherited from global` / `Cleared` / `Not configured` /
  `Error`), the public key in a copyable `<code>` block, the `SHA256:` fingerprint, a
  "known_hosts configured" flag, and a warning when no `known_hosts` is set (TOFU). Form fields:
  "Private key (unencrypted)" textarea, "known_hosts (optional)" textarea, Set/Inherit/Clear. Save
  clears the secret fields; the key is never re-rendered.
- **HTTPS credential.** Status, hosts chips/list, username, and a warning that the token is released
  only to these hosts. Form fields: hosts (one per line or comma-separated), username, token
  (password input, `autocomplete="new-password"`), Set/Inherit/Clear.
- **Test connection is app-page-only.** A remote input (placeholder "Defaults to origin"), a Test
  button, and a result panel with success/failure, refs count, redacted remote, and warnings. The
  panel uses `role="status"`/`aria-live="polite"`; errors use `role="alert"`. Global and project Git
  sections show credential status and configuration but no Test button; they link to an application
  page to run it, because the endpoint needs an app id and a running container (§10.3).
- **Restart.** The existing pending-restart card lists affected apps. The Git cards add the copy
  "Changes apply after the agent restarts."
- **Security copy.** "The agent can read these credentials. Use a deploy key scoped to this repository
  or a fine-grained token with the smallest permissions and an expiry."
- **Passphrase copy.** "Passphrase-protected keys are not supported. Use an unencrypted deploy key."

`assets/git-settings.js` (new, or a clearly separated module in `assets/settings.js`) posts the
credential forms and the test as JSON with `fetch`, disables controls while a request is in flight,
and renders server error messages with `textContent`. It never puts a secret in a URL, `data-*`
attribute, or inline script. Add the asset to the strict allowlist in `src/http/handler.ts` and to the
Tailwind build if new classes are introduced. The server-rendered page escapes all status metadata
with `escapeHtml`.

No-JS behavior: identity forms work like the existing settings forms; credential forms and Test
connection require JavaScript. The page states this and keeps the rest usable.

## 11. Removal plan

The old mechanism is removed, not shadowed. Exact areas:

| Area | Change |
| --- | --- |
| `compose.yaml` | Remove `HANSE_HOST_GIT_DIR` and every `HANSE_GIT_*` from the runner (`compose.yaml:104-114`) and the `${HANSE_HOST_GIT_DIR}:/run/hanse/git:ro` volume (`compose.yaml:119`). Add `HANSE_HOST_RUNNER_TMP` (default `/var/lib/hanse/tmp`) and mount it into the runner at the same absolute path (`${HANSE_HOST_RUNNER_TMP}:${HANSE_HOST_RUNNER_TMP}`), so `config.hostRunnerTmp` is valid both for creating the temp credential directory and for the Docker bind mount used by Test connection (§10.3). |
| `.env.example` | Delete the B1 git credential block (`38-56`). Add an optional `HANSE_HOST_RUNNER_TMP` comment and a pointer to Settings -> Git for credentials. |
| `docs/deployment.md` | Remove the `HANSE_HOST_GIT_DIR`/`HANSE_GIT_*` rows (`180-183`) and the volume bullet (`207-209`). Rewrite "Git workbench credentials" (`436-451`) for Settings -> Git, Test connection, TOFU, restart, and the openSSH image prerequisite. Update troubleshooting (`485-489`). |
| `docs/current-state.md` | Update the git workbench, settings, environment table (`408-410`), data layout (`355-371`), and known limitations (`504-518`) for per-app credentials, `setting_secrets`, materialized files, and the removed env. |
| `docs/conventions.md` | Add `home/.config/hanse/git/` to the per-app runtime layout and note that git credentials are configured in Settings, not `.hanse` manifests. |
| `src/runner/validate.ts` | Remove `CONTROLLED_GIT_ENV`, `RunnerConfig.hostGitDir`, and `RunnerConfig.gitEnv`; add `hostRunnerTmp` (absolute, no workspace/agents overlap); add `GIT_CONFIG_GLOBAL`/`GIT_ASKPASS`/`HANSE_CREDENTIALS_DIR` to the path-key set and a shared `validateGitSshCommand` for the shell-quoted `GIT_SSH_COMMAND`. |
| `src/agent/spec.ts` | Add the same path-key and `GIT_SSH_COMMAND` validation, or centralize the validator; the design's earlier `ENV_PATH_KEYS` reference covers only the runner. |
| `src/runner/server.ts` | Remove `GIT_FILE_ENV_KEYS`, `translateGitPath`, the `config.gitEnv` loop, and `hasGitCredentials`. Add the `hanse.agents.root` label (and spec-hash input), the credential mount/env, `restart_required`, and the `test` route/flow. |
| `src/git/env.ts` | Remove `CONTROLLED_GIT_ENV`, `IDENTITY_ENV`, the `HANSE_GIT_*` branches of `resolveGitSshCommand`, the token/askpass generator, and the `HANSE_GIT_SSL_CAINFO` mapping. Add `HANSE_CREDENTIALS_DIR` resolution, `GIT_ASKPASS_REQUIRE=force`, an explicit empty `GIT_ASKPASS` fallback, and export `shellQuote` for the managed `core.sshCommand`. |
| `src/git/service.ts` | Remove `createRuntimeDir`, `TEMP_DIRS`, and ambient askpass/ssh derivation (`895-946`); use the managed credential dir; give the fallback a private temp HOME and an empty askpass; add `testConnection` and the `test` operation. |
| `src/git/op.ts` | Add the dedicated `runGitTest` entry point, `HANSE_TEST_KIND`/`HANSE_TEST_REMOTE`, TOFU fingerprint output, and `GitTestResult` serialization. |
| `src/git/request.ts` | Keep the fixed workbench operation set; add a separate `GitTestRequest` validator (kind, one draft, optional remote, explicit embedded-password rejection) for the test route. |
| `src/git/runner-client.ts` | Add `test()` with the 60-75 s timeout; keep the existing operation timeouts. |
| `src/secrets/git-credential.ts`, `src/secrets/store.ts` | Delete. Remove their exports from `src/secrets/index.ts`. `src/secrets/crypto.ts` stays. |
| `src/store/migrations.ts` | Add v8: create `setting_secrets`, drop `secrets` (§12). |
| `src/settings/{registry,types,service,index}.ts` | Add `git.user.*`; add `gitAuth`, `gitAuthScoped`, `gitAuthHash`, and the `GitAuthStore` wiring. |
| `src/settings/git-auth.ts` | New: encrypted store, resolution, status, tombstones, `secure_delete`/checkpoint. |
| `src/git/credentials.ts` | New: schemas, SSH key/known_hosts validation, public-key derivation, HTTPS host validation, `runSshKeygen` seam. |
| `src/git/materialize.ts` | New: managed file writer, symlink-safe path/ownership/atomic rename, env fragment, clear-by-removal. |
| `src/opencode/manager.ts` | Materialize on start, add path env, include `gitAuthHash`, fail closed on materialization errors. |
| `src/opencode/launcher.ts` / `policy.ts` | `launcher.ts` stays unmanaged for git credentials (B0/local unsupported); extend `SCRUBBED_ENV_KEYS` with the legacy and inherited git variables. |
| `src/http/settings.ts` | Render the Git cards; add `POST /api/settings/git`; include status in `GET /api/settings`; Test button only on app pages. |
| `src/http/git.ts` | Add `POST .../git/test`; map test errors (409/502/504) explicitly; keep all existing actions. |
| `src/http/handler.ts` | Add `assets/git-settings.js` (or the extended settings asset) to the allowlist. |
| `assets/git-settings.js`, `src/http/styles.css` / Tailwind, `DESIGN.md` | Credential form and test-result components; visual contract if new classes are added. |
| `Dockerfile` | Add `openssh-client` to the `runtime` stage explicitly (or a build assertion), because save/Test validation calls `ssh-keygen`; `agent-base` already has it from `a49d5cd`. |
| `docs/design/agent-runtime.md`, `docs/design/git-workbench.md` | Update the R17/no-secret-git wording and the "credential management" non-goal to point at this stage. |
| Tests | Update `test/git-hardening.test.ts`, `test/git-sandbox.test.ts`, `test/runner-git.test.ts`, `test/runner-validate.test.ts`, `test/launcher.test.ts`, `test/manager.test.ts`, `test/settings.test.ts`, `test/settings-store.test.ts`, `test/settings-http.test.ts`, `test/git-http.test.ts`, `test/secrets.test.ts`, `test/migrations.test.ts`, and `test/agent-protocol.test.ts` (the ones that inject `HANSE_GIT_*`, `HANSE_HOST_GIT_DIR`, `gitEnv`, or the old `secrets` store). Add the new unit/integration files in §15. |

The removal covers the ambient credential/config variables: `HANSE_GIT_TOKEN`, `HANSE_GIT_SSH_KEY`,
`HANSE_GIT_KNOWN_HOSTS`, `HANSE_GIT_SSH_COMMAND`, `HANSE_GIT_ASKPASS`, `HANSE_GIT_SSL_CAINFO`,
`HANSE_GIT_AUTHOR_*`, and `HANSE_GIT_COMMITTER_*`. The existing sandbox operation fields
(`HANSE_GIT_OP`, `HANSE_GIT_APP_DIR`, `HANSE_GIT_BRANCH`, `HANSE_GIT_MESSAGE`) remain; they carry an
operation name and non-secret arguments, not credentials. The new managed-credential paths use the
`HANSE_CREDENTIALS_*` prefix, so the stage does not introduce a new `HANSE_GIT_*` credential channel.

There is no compatibility fallback: if an operator leaves the old variables in `.env`, Compose no
longer passes them to the runner and the coordinator never reads them. The old `secrets` table is
dropped.

## 12. Database migration

Migration **v8**, name `git-credentials`:

```sql
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
```

- Additive for `setting_secrets`; the only destructive statement is `DROP TABLE IF EXISTS secrets`.
- **The legacy table was empty.** No data migration/backfill is needed. The pre-drop
  check is `SELECT COUNT(*) FROM secrets`; the expected result is `0`.
- `runMigrations` wraps the migration in a transaction (`src/store/database.ts:38-64`), so the
  create+drop is atomic. `DROP TABLE IF EXISTS` keeps the migration idempotent on restored or
  partially migrated copies where `secrets` was already removed by hand.
- Rollback is forward-only. To downgrade: drop `setting_secrets`, recreate the v2 `secrets` table
  exactly as in `src/store/migrations.ts:111-123`, and delete the `schema_migrations` row for version
  8. Because the old table had no rows, no data is lost. The old code/Compose env must also be restored
  for fetch/push to work after a rollback.
- No index beyond the PK is needed. No FK, for the same reason as `provider_keys`.

## 13. Security and threat model

### 13.1 Assets and boundaries

| Asset | Lives in | Readable by |
| --- | --- | --- |
| SSH private key / HTTPS token | `setting_secrets` ciphertext; on disk in `<app agents root>/home/.config/hanse/git/{id,token}` | Coordinator (key + DB), that app's container (files), the runner (host agents volume read-only and the test temp dir), the one-shot git container (read-only mount) |
| Git identity | `settings` plaintext; managed `config` | Coordinator, that app, the one-shot git container |
| `secret.key` | `/data/state/hanse/secret.key` (`0600`) | Coordinator only; never mounted into agents |
| Public key / fingerprint / hosts / username | `meta_json` + API/HTML | Humans; not secret |

### 13.2 Accepted risks and mitigations

- **The agent can read its own credentials (owner decision 1).** A compromised agent can use the key
  or token for its repository and can read the token directly, bypassing the askpass. Mitigation is
  scoping: a deploy key per repository (read-only unless push is required), or a fine-grained PAT with
  one repository, the minimum permissions, and an expiry; rotate by replacing the setting and
  restarting. Documentation states this in the settings page and deployment guide.
- **Cross-app isolation.** Each app has its own HOME, its own managed directory, its own container, and
  its own network. App A cannot read app B's credentials through the normal mounts. The coordinator DB
  is not mounted into apps; `secret.key` is not mounted. The runner is root-equivalent through the
  Docker socket (existing trust model) and can read the host agents volume read-only; this is
  unchanged. The materializer's expected-app-root, `lstat(home)`, `realpath`, and `O_NOFOLLOW` checks
  (§9.2) prevent an app from redirecting the coordinator into another app's agents root or
  `/data/state` through a symlinked `home` or managed directory; the runner repeats the check before
  mounting the workbench/test credential dir (§10.2).
- **HTTPS host allowlist.** It prevents the askpass from releasing the token to a changed remote host.
  The askpass answers only `https://` prompts, so a remote changed to `http://` gets no token. It does
  not stop a compromised agent from using the token directly, and it is not an egress control. The
  claim is scoped accordingly: "the askpass path fails closed on a non-allowlisted host or a non-HTTPS
  scheme."
- **SSH.** The private key is never sent to the host; it signs locally. `IdentitiesOnly=yes`,
  `IdentityAgent=none`, `BatchMode=yes`, `-F /dev/null`, and no forwarding prevent ambient keys/agent
  use. `known_hosts` is the host-authentication control; without it, TOFU accepts an unknown host and
  warns. A changed host key fails with `accept-new` too. TOFU entries learned in the app container live
  until the next materialization; pinning `known_hosts` is the durable option.
- **File modes and atomicity.** `0700` dirs, `0600` secrets, `0700` wrappers, temp+rename writes. A
  crash cannot leave a half-written key. The materializer removes stale secret files on clear.
- **No secrets in one-shot env.** The test credential is a bind-mounted directory, not an environment
  variable. The app env contains only paths. The runtime spec and DB contain only paths/hashes.
- **No secrets in API/HTML/logs.** The status API returns metadata only; the HTML renders escaped
  metadata; the private key/token textareas are never repopulated; errors are redacted and truncated;
  the runner never logs a request body. `gitChildEnv` is an explicit allowlist and does not spread
  `process.env`.
- **Repository config cannot override the managed path in the one-shot workbench.** `gitConfigArgs`
  passes `-c core.sshCommand=`, `-c core.askpass=`, `-c credential.helper=`, `-c core.hooksPath=/dev/null`,
  and the protocol/submodule pins on the command line, which outranks repository config. The agent's
  own native git inside the app container is not wrapped by the one-shot config; a repository can
  still run its hooks and other config there. The env-set `GIT_SSH_COMMAND`/`GIT_ASKPASS` override
  repository `core.sshCommand`/`core.askpass`, so the managed wrappers win for SSH/HTTPS, but the
  native git is not the one-shot hardening. That is the existing trusted-repository model, not a new
  boundary.
- **Test sandbox.** The test container runs the app image as uid 1000, with the app directory ro (the
  test only reads), the credential dir ro, no `/data/state`, no Docker socket, no coordinator/runtime
  token, a read-only rootfs, and tmpfs `/tmp`/`/run`. It is on the app network for egress. It could
  reach the coordinator's internal MCP route if it had a token; it has none.
- **Temp dir lifecycle.** The test temp dir is `0700`, removed in `finally`, and swept at runner
  startup if stale. A crash between write and cleanup leaves a `0600` secret file on the host runner
  temp root until the sweep; this is a documented residual risk. Do not place `hostRunnerTmp` on a
  shared/backed-up volume.
- **The runner's path check is not atomic.** The runner `lstat`s the credential path and then Docker
  resolves the bind while the app (same uid 1000) may be running; a racing app can swap a component
  between the check and mount resolution. This cannot disclose host secrets the app cannot already
  reach (it owns its own credential dir), and the agent-readable model accepts it; the coordinator-side
  materializer runs while the app is stopped. Treat this as a residual, not an absolute prevention.
- **Encryption.** AES-256-GCM with the existing key, no AAD binding to scope/key (same as provider
  keys). A DB-write attacker could swap ciphertexts; key rotation and restoring a DB without
  `secret.key` are not addressed. `secure_delete` + WAL checkpoint reduces, but does not eliminate,
  stale pages; backups may retain old ciphertext.
- **Host allowlist parsing.** The askpass extracts the host from the prompt URL without `eval` and
  uses fixed-string matching. It answers only the two expected prompts; an OTP/verification prompt is
  refused. A malformed URL fails closed.
- **Settings/test authorization.** Both are human-only; agent principals get `403`. HTML redirects
  unauthenticated humans to login. POST + `SameSite=Strict` is the CSRF control. `return_to` is
  `safeLocalPath`-validated.
- **No custom CA.** `HANSE_GIT_SSL_CAINFO` is removed. A private CA belongs in the app image trust
  store or a future `git.tls` setting. This is a deliberate non-goal.

## 14. Failure modes

| Failure | Behavior |
| --- | --- |
| Missing git identity | Commit is disabled in the workbench with "Set git.user.name and git.user.email in Settings, or set a repository-local identity." Native git reports its normal identity error. |
| Missing SSH/HTTPS credential | Fetch/update/push fails with `auth_failed` and "Git credentials are not configured for this application. Configure SSH or HTTPS in Settings." Local status/switch/commit still work. |
| Passphrase-protected key | Save/test returns `400` with the passphrase message; nothing is stored. |
| Invalid SSH key / public key / certificate | Save/test returns `400 invalid_key` with a bounded, redacted `ssh-keygen` error. |
| Invalid `known_hosts` | Save/test returns `400 invalid_known_hosts` with the `ssh-keyscan` hint. |
| HTTPS host not allowlisted | The askpass writes `hanse: git host '<host>' is not in the HTTPS allowlist` and exits 1; git reports an auth failure. Test returns `400 host_not_allowed` when the remote is supplied, otherwise `502 auth_failed` with the same hint. |
| Remote scheme does not match the credential | Test returns `400 credential_scheme_mismatch`; the workbench reports an auth error for a network action. |
| No `known_hosts` | SSH uses `accept-new`; the UI and Test result show the TOFU warning and any newly trusted fingerprint. A changed host key fails. |
| Managed dir/container predates the feature | `409 restart_required` ("Restart the agent to materialize git credentials.") for workbench and Test. |
| Settings changed without restart | `pendingRestart` / "Restart required"; the old files remain until restart. |
| App stopped | `409 not_running`; the UI shows "Start the agent to use git actions." This applies to Test connection too. |
| App image lacks `ssh`/`ssh-keygen` | SSH operations fail with `git_failed` plus "the app image does not provide ssh (openssh-client); rebuild it on a current base." HTTPS is unaffected. `a49d5cd` fixes the default base. |
| Coordinator lacks `ssh-keygen` | Save/test fails with a clear internal error; the `runtime` stage must install `openssh-client` explicitly (or assert `ssh-keygen` at build time), rather than relying on the code-server base. |
| Decryption/schema failure in a stored credential | Status `error`; no credential is materialized (stale secret files removed); local git still works; network git fails with `git_credentials_unreadable`. No fallback to a wider scope or ambient config. |
| Materialization write failure | `ensure` fails with `git_credentials_materialize_failed`; the agent does not start, so it cannot silently use ambient git config. |
| Test temp dir cleanup failure | Warning logged with the path only; the startup sweep removes stale `git-test-*` directories. |
| Test timeout | `504 timeout`; the container is force-removed and the temp dir is deleted in `finally`. |
| Missing `origin` and no remote in the test body | `409 missing_remote` with "No remote is configured and no remote was given." |
| Remote contains an embedded password | `400 invalid_remote`; never accepted or echoed. |
| Agent principal calls settings/test | `403`; no data is returned. |

## 15. Testing

### 15.1 Unit

- `test/settings.test.ts` (extend): `git.user.name`/`email` registry, default `null`, set/inherit/clear,
  invalid values, `EffectiveSettings.git` shape, `scoped` rows; `gitAuthHash` changes when either
  credential changes and when a credential is cleared; `effectiveHash` includes it.
- `test/git-auth-store.test.ts` (new): migration v8; set/clear/inherit; tombstone clears ciphertext and
  meta; `secure_delete`/checkpoint call; wide-to-narrow resolution; two kinds independent;
  decrypt/schema failure -> `error`; `meta_json` never contains `privateKey`/`token`/known-hosts
  content; only the two v1 keys are accepted.
- `test/git-credentials.test.ts` (new): SSH key validation with real or injected `ssh-keygen`
  (unencrypted ed25519/RSA accepted; passphrase-protected rejected with the exact message; public
  key/certificate/garbage rejected; public key and `SHA256:` fingerprint derived); known_hosts
  validation (valid, hashed, invalid, empty/comment-only); HTTPS hosts (DNS/IPv4/bracketed IPv6
  accepted; scheme/path/userinfo/wildcard/port/CIDR/empty rejected; lowercase/dedupe); username/token
  bounds; request size caps.
- `test/git-materialize.test.ts` (new): exact file set; modes (0700/0600); ownership seam; atomic
  rewrite; `[user]` quoting; `credential.helper=`; `core.sshCommand`; clear removes
  `id`/`known_hosts`/`token`/`username`/`https_hosts`; no writes under `~/.ssh`; stable `config`/`ssh`/
  `askpass`; env fragment contains paths only; a symlinked `.config/hanse/git`, a symlinked managed
  file, a symlinked final component, and a symlinked `home` pointing to another app or `/data/state`
  are refused/repaired and never write outside the expected app HOME; the target realpath is under
  the expected app HOME; a symlinked `appRoot`, a symlinked project/app segment, and an
  `expectedAppRoot` mismatch (different `agentsRoot`/identity) fail with
  `git_credentials_materialize_failed` before any write.
- `test/git-wrappers.test.ts` (new): execute the wrapper with a fake `ssh` on `PATH`: missing `id`
  fails with the clear message and does not invoke `ssh`; known_hosts present -> `StrictHostKeyChecking=yes`
  and `UserKnownHostsFile=<managed>`, `GlobalKnownHostsFile=/dev/null`; absent -> `accept-new`;
  `HANSE_CREDENTIALS_READONLY=1` uses `$TMPDIR`; identity agent disabled/IdentitiesOnly/BatchMode;
  `"$@"` passthrough. Askpass: username/password prompts; allowlisted host (case-insensitive);
  non-allowlisted host exits 1 with no token; `http://`, `ftp://`, and unknown schemes exit 1 without
  reading the token; OTP/unknown prompt exits 1; malformed URL exits 1; no `eval`; TOFU file is
  written in the app container and reset on the next materialization; IPv6/port host matching.
- `test/runner-validate.test.ts` (update): remove `hostGitDir`/`gitEnv`; add `hostRunnerTmp` absolute
  validation and workspace/agents-overlap rejection; quoted `GIT_SSH_COMMAND` accepted and an
  out-of-root/unquoted value rejected; `GIT_CONFIG_GLOBAL`/`GIT_ASKPASS`/`HANSE_CREDENTIALS_DIR`
  containment.
- `test/runner-git.test.ts` (update): credential mount at `/run/hanse/git/app:ro`; env has
  `HANSE_CREDENTIALS_DIR` and no `HANSE_GIT_TOKEN`/`HANSE_GIT_*`; missing label/dir ->
  `restart_required`; a symlinked `home`, `.config`, `hanse`, or `git` -> `409` and no
  `createContainer` bind; test operation creates a temp dir, mounts it, runs `git-op`, cleans up in
  `finally`; no secrets in env; redacted errors; network selection; stopped app -> 409.
- `test/git-service.test.ts`, `test/git-sandbox.test.ts`, `test/git-hardening.test.ts` (update):
  `GitService` uses the managed dir; no temp askpass generation; no ambient env; command-line config
  still overrides repo config; `testConnection` parses `ls-remote` (refs/head/missing origin/scheme
  mismatch); `runGitTest` reads `$TMPDIR/hanse-known_hosts` and returns fingerprints in `warnings`;
  redaction.
- `test/manager.test.ts` (extend): materialization runs before `ensure`; env includes the git paths;
  spec hash includes them; `settingsHashFor` includes `gitAuthHash`; a secret-only change flips
  `pendingRestart`; `SCRUBBED_ENV_KEYS` covers inherited git vars; materialization failure prevents
  start.
- `test/secrets.test.ts` (update): keep the crypto round-trip; remove the old `secrets` store/helper
  tests.
- `test/migrations.test.ts` (extend): v8 applies; `setting_secrets` constraints (scope/key, tombstone);
  `secrets` is gone; re-running is a no-op; a restored DB with `secrets` present upgrades.
- `test/settings-http.test.ts` (extend): `GET /api/settings` includes `gitAuth`/`gitAuthScoped` and
  never plaintext; `POST /api/settings/git` set/clear/inherit, validation errors, JSON-only, 64 KiB
  cap; agent principal 403; HTML renders public key/fingerprint/status and no private key/token.
- `test/git-http.test.ts` (extend): `/git/test` human-only, JSON-only, body validation, scheme/host
  mismatch, success/error mapping, redaction, stopped app/restart required; timeout -> `504`;
  `missing_remote`/`not_running`/`restart_required` -> `409`; embedded password in `remote` ->
  `400`; Test button absent on global/project pages and present on the app page; the existing
  workbench actions still pass.

### 15.2 Integration

- A temporary coordinator DB + settings service + `GitAuthStore` round-trip: save at global, override
  at project, clear at app, resolve, decrypt, materialize, hash, restart detection.
- `InstanceManager.ensure` with a fake runtime: inspect the captured spec env, assert the paths, the
  absence of secrets, and the `hanse.agents.root` label on the app container.
- Runner one-shot with a fake Docker runtime (the existing pattern in `test/runner-git.test.ts`):
  capture `createContainer` arguments for the workbench and test; assert mounts, env, network, user,
  and cleanup calls.
- Redaction: a remote with `https://user:example-password@host/repo` in an error/log never appears verbatim in
  the API, runner logs, or test output.
- Security tests:
  - The askpass never releases the token to a non-allowlisted host, including a host with a port and
    a case variation.
  - A repository with `core.sshCommand`, `core.askpass`, and `credential.helper` cannot override the
    one-shot command-line config.
  - Clearing a credential removes the files after the next restart and a fetch fails with the
    credentials-not-configured message.
  - Inherited host `GIT_*`/`HANSE_GIT_*` variables do not reach the app or the one-shot container.
  - `GET /api/settings`, the HTML, and the runner logs contain no private key, token, or known-hosts
    body.
  - Agent principals get 403 on settings and test routes.

### 15.3 Live smoke on `deployment-host`

- **HTTPS (`demo-app`).** Configure a fine-grained PAT scoped to the test repository in Settings ->
  Git -> HTTPS (host list includes the remote host), Test connection -> success with a ref count;
  restart the app; fetch/update/push from the workbench succeeds; the agent's native `git fetch`
  succeeds in the operator terminal; clear the credential, restart, and confirm fetch fails with the
  clear message and the token file is gone. Do not write the actual token or host address into this
  document.
- **SSH (after the image publish).** Confirm `ssh -V` and `ssh-keygen` in the running app image
  (built on `a49d5cd`), add a test deploy key to a test remote, configure `git.auth.ssh` with the
  private key and a `known_hosts` entry, Test connection -> success, restart, fetch/push succeeds;
  remove `known_hosts`, test again -> TOFU warning; a deliberately wrong host key fails. Use a
  throwaway test remote/key, never a production credential in the doc.
- Confirm `docker exec` into the app shows `GIT_CONFIG_GLOBAL`, `GIT_SSH_COMMAND`, `GIT_ASKPASS`,
  `GIT_ASKPASS_REQUIRE`, and no `HANSE_GIT_*`; the runner has no credential env; the one-shot
  container has no secret env and no `hanse-git-*` container remains; `GET /api/settings` contains no
  plaintext; `setting_secrets` is populated and `secrets` is gone.
- Run the four repo gates: `npm run lint && npm run typecheck && npm test && npm run build`.

## 16. Rollout and compatibility

### 16.1 Image prerequisite

- `a49d5cd` adds `openssh-client` to `agent-base` (`Dockerfile:167-170`). The base, default, IDE, and
  any app images built on them now provide `ssh`/`ssh-keygen`. Runtime and IDE images already provide
  them, but the runtime stage must add `openssh-client` explicitly (or a build-time
  `ssh-keygen` assertion) so save/Test validation does not depend on an unverified code-server base
  package.
- Publish the agent/default/IDE/runner images for this stage; the default image tag used by Compose
  must include `a49d5cd`. Apps with a custom `.hanse/Dockerfile` that inherit `ARG HANSE_BASE` pick up
  the new base on the next build; rebuild them before relying on SSH. A custom image that does not
  inherit the base must provide `git` and `openssh-client` or SSH fails with the clear image error.
- Add `openssh-client` to the `runtime` stage explicitly (or a build-time `ssh-keygen` assertion). The
  coordinator validates drafts with `ssh-keygen`; relying on the code-server base package set is
  fragile. This is an additional image change for the stage.

### 16.2 Deploy sequence

1. Publish and pull the images. Apply the `compose.yaml`/`.env.example` changes: remove
   `HANSE_HOST_GIT_DIR` and all `HANSE_GIT_*`; add `HANSE_HOST_RUNNER_TMP` and its runner mount.
2. `docker compose up -d` (recreates the runner with the new image and no credential env). Verify the
   coordinator, runner, and IDE are healthy.
3. Run the v8 migration by starting the coordinator (automatic). Verify `setting_secrets` exists and
   `secrets` is gone (`SELECT COUNT(*) FROM secrets` was 0 before the drop).
4. One-time restart of each existing app so its container is recreated with `hanse.agents.root` and the
   managed git env and its HOME is materialized. A pre-upgrade running container returns
   `409 restart_required` for git actions until then; it is not restarted automatically (owner
   decision 6).
5. Configure `git.user.*` and the SSH/HTTPS credential at the desired scope in Settings. Use Test
   connection with the draft values. Restart the app to apply. Then run the live smoke (§15.3).
6. Confirm the app terminal has the managed env, the app container cannot read `/data/state` or other
   apps' credentials, and the runner has no `HANSE_GIT_*`.

### 16.3 Documentation updates

- `docs/current-state.md`: git workbench, settings, environment table, data layout, known limitations.
- `docs/conventions.md`: per-app runtime layout and the "settings, not manifests" rule for git
  credentials.
- `docs/deployment.md`: the new settings workflow, Test connection (app pages only), TOFU, restart,
  image prerequisite, the new `HANSE_HOST_RUNNER_TMP`, and removal of the old env vars.
- `.env.example` and `compose.yaml`: remove the old block; add the runner temp dir comment/mount.
- `docs/design/agent-runtime.md`: update the R17/no-secret-git wording to point at the accepted
  agent-readable credential model.
- `docs/design/git-workbench.md`: replace the "credential management is out of scope" non-goal with a
  pointer to this stage.
- `docs/design/README.md`: this document.
- `docs/plans/README.md` and `docs/journal/` when the plan and stage record exist (not part of this
  design task).

### 16.4 Rollback

- Code rollback: revert the stage commit and restore the old `compose.yaml`/`.env` git variables for
  runner-executed fetch/push. The v8 migration is forward-only; downgrade by dropping
  `setting_secrets`, recreating the v2 `secrets` table, and deleting the `schema_migrations` row for
  version 8. The old table was empty, so no data is lost.
- Running apps must be restarted after a rollback to drop the managed git env. The materialized files
  can remain (harmless) or be removed with the app's HOME; a reverted coordinator does not read them.
- Credentials entered in the new UI are not migrated back to `.env`; an operator who rolls back must
  reconfigure the deployment-wide variables. This is acceptable for pre-alpha and is stated in the
  deployment guide.

### 16.5 Compatibility

- Existing settings rows and provider keys are untouched. `settings` v3 stays.
- Existing repositories and remotes are untouched. A remote with an embedded password remains
  readable and is redacted in status; Test connection rejects an embedded password in its `remote`
  field. The workbench does not rewrite an existing remote; the operator should remove the embedded
  credential and configure HTTPS in Settings.
- Local status/switch/commit keep working with no credential. A repository-local `user.name`/
  `user.email` still supplies identity when the setting is unset.
- The web IDE and its terminal are unchanged and do not receive these credentials (owner decision 5).
- `git clone` on add-app still uses its existing path and does not read project-scope git settings;
  wiring it is the deferred follow-up.

## 17. Open questions

None. The nine owner decisions in §4 close every fork for this stage. There is no question about GPG,
passphrases, multiple credentials, live apply, IDE, monorepo/project-root repositories, clone, or
custom CA: each is explicitly out of scope. `docs/open-questions.md` will record the same "no open
items" statement when the plan is written.

## 18. Design review

Status: **PASS** (`oracle`, 2026-10-21); design gate cleared.

The first independent review found five blockers and a set of should-fix items. The second review
confirmed four of the five and found that the materializer symlink fix was still bypassable through
`home` itself. The third review confirmed the `home` fix but found that the claimed canonical-root
check was unimplementable with the documented API and that a fresh app could fail closed before
`home` existed. Revision 4 folded those changes. The final focused review confirmed both required
changes and found no blockers; the remaining items are non-blocking wording/test-coverage
should-fixes, folded below.

| Finding | Resolution |
| --- | --- |
| `GIT_SSH_COMMAND` shell quoting contradicted `ENV_PATH_KEYS`; the app spec would be rejected. | Dedicated `validateGitSshCommand` in `src/runner/validate.ts` and `src/agent/spec.ts`; the other git paths join the path-key sets (§9.3, §11). |
| HTTPS askpass accepted any URL scheme and could release the token over `http://`. | Askpass now requires `https://` explicitly; `http`/`ftp`/unknown schemes fail closed (§9.5, §13.2). |
| Materialization could follow an app-created symlink into another app's agents root or `/data/state`. | The materializer receives `agentsRoot`/`projectId`/`appKey`, derives `expectedAppRoot` from `realpath(agentsRoot)`, requires real-dir `lstat` plus `realpath` equality for `appRoot` and `home`, `lstat`s every managed component, and uses `O_NOFOLLOW`/rename. The runner repeats the check (§9.2, §10.2, §13.2). |
| Test TOFU fingerprints were read from the one-shot container's tmpfs by the runner. | `git-op test` reads `$TMPDIR/hanse-known_hosts`, derives fingerprints, and returns them in `warnings`; the runner only merges (§10.3). |
| Test connection was described on global/project pages without an app target. | Test is app-page-only; global/project sections link to an app page (§10.4). |
| The canonical-root check was asserted but the materializer API had no `agentsRoot`; a fresh app could fail closed because `home` did not exist. | Added `agentsRoot`/`projectId`/`appKey` to the input, an explicit `expectedAppRoot` equality check, and `ensure`-side creation of `appRoot`/`home` at `0700` before materialization (§9.2, §10.1). A pre-existing symlink still fails closed. |

Should-fix items folded: explicit embedded-password rejection in test remotes; the second
`ENV_PATH_KEYS` set in `src/agent/spec.ts`; `core.sshCommand` shell quoting; empty-askpass fallback in
local `GitService`; B0/local parity dropped as unsupported; fallback `HOME` specified; R10 narrowed to
credential/config variables; empty `known_hosts` normalized to absent and TOFU reset documented;
single ownership policy; expanded scrub list; explicit test error mapping; explicit `openssh-client`
in the runtime image; app env locale pinned; test app mount read-only; docs updates for
`agent-runtime.md`/`git-workbench.md`; `gitAuthScoped` wording; config-claim wording; the
`git-op test` fingerprint test; username-only userinfo wording; the `home`-symlink regression test;
the runner symlinked-`home` 409 test; the runner TOCTOU residual; the `hashInput.labels`
clarification; temp chown-before-rename; the diagram path naming; the chown-after-rename wording in
the test flow; and the `expectedAppRoot`-mismatch negative tests.

No review finding reopened a locked owner decision. The final focused review confirmed both required
changes and cleared the design gate.

## 19. References

- `docs/current-state.md` - current topology, git workbench, settings, and known limits.
- `docs/conventions.md` - `.hanse` manifests and runtime layout.
- `docs/process.md` - delivery gates and verification.
- `docs/deployment.md` - GHCR/Compose operations and the per-app git credential rollout.
- `docs/design/git-workbench.md` - the application page, operation set, and hardening.
- `docs/design/web-tools-and-settings.md` - the settings hierarchy, provider-key pattern, restart
  semantics, and design-doc structure.
- `docs/design/agent-runtime.md` - per-app containers, the runner, the one-shot no-secret git context,
  and the trust model.
- `src/settings/registry.ts`, `src/settings/service.ts`, `src/settings/types.ts`,
  `src/settings/provider-keys.ts`, `src/settings/hash.ts`, `src/settings/git-auth.ts`
- `src/secrets/crypto.ts`
- `src/opencode/manager.ts`, `src/opencode/instance.ts`, `src/opencode/launcher.ts`,
  `src/opencode/policy.ts`
- `src/git/env.ts`, `src/git/credentials.ts`, `src/git/materialize.ts`, `src/git/service.ts`,
  `src/git/runner-client.ts`, `src/git/op.ts`, `src/git/request.ts`
- `src/runner/server.ts`, `src/runner/validate.ts`
- `src/http/settings.ts`, `src/http/git.ts`, `src/http/server.ts`, `src/http/handler.ts`
- `src/store/migrations.ts`, `src/store/database.ts`
- `compose.yaml`, `.env.example`, `Dockerfile`
- Commit `a49d5cd` - `openssh-client` in `agent-base`.
- OpenSSH `ssh`, `ssh-keygen`, `ssh-keyscan` manual pages; git `credentials`, `git-config`,
  `git-ls-remote`, and `GIT_ASKPASS`/`GIT_ASKPASS_REQUIRE` documentation.

