# ADR-0009: Agent-readable per-app git credentials

## Status

Accepted (2026-10-21; design review PASS in
[`docs/design/git-credentials.md`](../design/git-credentials.md); plan review PASS in
[`docs/plans/0010-git-credentials.md`](../plans/0010-git-credentials.md)).

## Context

The git workbench executed fetch/push with deployment-wide runner environment variables
(`HANSE_GIT_TOKEN`, `HANSE_GIT_SSH_KEY`, `HANSE_GIT_KNOWN_HOSTS`, `HANSE_GIT_SSH_COMMAND`,
`HANSE_GIT_ASKPASS`, `HANSE_GIT_SSL_CAINFO`, `HANSE_GIT_AUTHOR_*`, `HANSE_GIT_COMMITTER_*`) and a
read-only `/run/hanse/git` host directory (`HANSE_HOST_GIT_DIR`). That mechanism was:

- **deployment-wide**, so two applications could not use different keys or tokens;
- **invisible to the product**, requiring `.env` edits and a runner recreate, with no per-app status
  or test;
- **unavailable to the agent's native git**, so the workbench could push but the agent could not; and
- backed by an unused legacy `secrets` table/helper that nothing read (the legacy table was empty).

The owner wanted git credentials to be first-class application configuration: one SSH and one HTTPS
credential per scope, configured in the existing settings pages, encrypted at rest, and materialized
into the application HOME so the agent's own git and the web workbench use the same credential.

## Decision

We will adopt **Variant A**: per-app, agent-readable git credentials.

1. **Settings hierarchy.** `git.user.name`/`git.user.email` are plain clearable settings resolved
   global -> project -> application. One SSH credential (`privateKey`, optional `knownHosts`) and one
   HTTPS credential (`hosts`, `username`, `token`) may be set per scope in `setting_secrets`
   (migration v8), encrypted with AES-256-GCM. A narrower scope replaces the whole credential object;
   `cleared` is a tombstone that suppresses wider scopes; `inherit` deletes the row. The API and HTML
   return status metadata only.
2. **One materialization, two consumers.** On instance start the coordinator writes the effective
   identity and credential files into `<app>/home/.config/hanse/git/` (`config`, `ssh`, `askpass`, and
   optional `id`, `known_hosts`, `token`, `username`, `https_hosts`) with `0700` dirs, `0600` secrets,
   and atomic `O_NOFOLLOW` + rename writes. The app env carries paths only. The runner mounts the same
   directory read-only into the workbench one-shot. There is no second credential path and no
   runner-global fallback.
3. **SSH first, HTTPS required.** Passphrase-protected SSH keys are rejected in v1 and the derived
   public key/fingerprint are shown. `known_hosts` is optional; without it SSH uses `accept-new` with
   a TOFU warning, and a changed host key always fails. HTTPS hosts are mandatory and exact-match; the
   askpass answers only `https://` prompts, so a changed or non-allowlisted host fails closed.
4. **Explicit restart.** Settings changes never restart an agent silently. `settingsHashFor` includes
   `gitAuthHash` over the plaintext credentials, so a secret-only change flips the existing
   `pendingRestart` marker and the files are rewritten on the next restart.
5. **Draft Test connection.** A human-only, app-page-only route runs draft SSH/HTTPS values through
   the runner's network-enabled one-shot sandbox (`git ls-remote`). It writes to an ephemeral `0700`
   directory under `HANSE_HOST_RUNNER_TMP`, mounts it read-only, and deletes it in `finally`; it never
   saves settings or writes the managed app directory.
6. **Remove the old mechanism, not shadow it.** `HANSE_HOST_GIT_DIR` and every credential/config
   `HANSE_GIT_*` variable are removed from Compose, `.env`, docs, and code with no fallback. The four
   non-secret sandbox operation variables (`HANSE_GIT_OP`, `HANSE_GIT_APP_DIR`, `HANSE_GIT_BRANCH`,
   `HANSE_GIT_MESSAGE`) remain. The legacy `secrets` table and helper are removed (v8
   `DROP TABLE IF EXISTS secrets`; the legacy table was empty).
7. **Preserve hardening.** No shell, fixed argument arrays, command-line config that disables
   hooks/fsmonitor/ext/credential helpers, output caps, redaction, the repository-root rule,
   `GIT_CEILING_DIRECTORIES`, and the one-shot sandbox stay in force.
8. **Scope the accepted risk.** The agent can read its own credentials. Operators must use a deploy
   key scoped to one repository (read-only unless push is required), or a fine-grained token with the
   minimum permissions and an expiry. Documentation and the settings page state this and describe
   rotation by replacing the setting and restarting.

## Consequences

Positive:

- Different applications can use different credentials; one repository's token is not ambient for
  every fetch/push.
- The agent's native git and the web workbench authenticate with the same effective credential.
- Credentials are encrypted, status-only in the API/HTML, and configured without editing `.env` or
  recreating the runner.
- The unused legacy secret store and the deployment-wide env surface are gone.

Negative / residual:

- **The agent can read its own credential** and a compromised agent can use or copy it for its
  repository. This is accepted; repository scoping, minimal permissions, expiry, and per-app isolation
  limit the blast radius, and the askpass host allowlist protects only the askpass path, not direct
  token use.
- Git settings require an agent restart; the workbench uses the previous files until then.
- Passphrase-protected keys, multiple host-keyed credentials, live apply, GPG signing, a custom CA, and
  IDE/terminal credentials remain out of scope.
- No AAD binding or key rotation (same as provider keys); `secure_delete` plus a WAL checkpoint cannot
  erase physical media/backups.
- Test-connection cleanup is best-effort after a crash; stale `git-test-*` directories are swept at
  runner startup. The temp root must not be shared or backed up.

## Alternatives considered

| Alternative | Why rejected |
| --- | --- |
| Keep `HANSE_GIT_*` and write it from the UI | Still deployment-wide, requires a runner recreate, cannot differ per app, and cannot reach the agent's native git. |
| Store credentials in each repository's `.git/config` | Repository-controlled, travels with the repo, conflicts with the managed config, and is hard to clear safely. |
| Put secrets in `settings.value_json` | The resolver returns values to the API/UI; one missed redaction leaks a key or token. |
| Put the token/private key in the app environment | Visible in `/proc/<pid>/environ`, inherited by children, and violates the no-secrets-in-env rule. |
| Generate the askpass from an environment token | The old helper embedded the token in a script; the managed askpass reads a `0600` file and enforces the host allowlist. |
| Run Test connection in the coordinator | Repository-controlled git would execute in the coordinator's secret context; the runner sandbox is the established boundary. |

## References

- [`docs/design/git-credentials.md`](../design/git-credentials.md) - design, threat model, and owner
  decisions.
- [`docs/plans/0010-git-credentials.md`](../plans/0010-git-credentials.md) - implementation plan and
  deploy/rollback sequence.
- [`docs/design/agent-runtime.md`](../design/agent-runtime.md) - R17 and the runner/one-shot boundary.
- [`docs/security/review.md`](../security/review.md) - current security posture.
- Commit `a49d5cd` - `openssh-client` in `agent-base`.
