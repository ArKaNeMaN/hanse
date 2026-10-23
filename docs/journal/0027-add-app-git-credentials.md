# 0027 - Add-app clone with project git credentials

Design: [`docs/design/git-credentials.md`](../design/git-credentials.md) §19. Plan:
[`docs/plans/0024-add-app-git-credentials.md`](../plans/0024-add-app-git-credentials.md). ADR:
[`docs/decisions/0014-add-app-clone-credentials.md`](../decisions/0014-add-app-clone-credentials.md).
Stage: `0024-add-app-git-credentials`.

## Context

Adding an application from a private remote failed because `addApplication` ran a bare
`execFileSync("git", ["clone", ...], { stdio: "ignore" })` in the coordinator, which has no ambient
SSH key, and HTTPS credentials were not used. The operator saw only a command-line failure, never
git's `Permission denied (publickey)`. The plan closes the §3 deferral of
`docs/design/git-credentials.md` (rev 2, plan review PASS).

## What was implemented

- **Scope/error resolution** (`src/settings/service.ts`, `src/coordinator/provision.ts`):
  `SettingsService.projectGitAuth(projectId)` resolves `global` + `project` rows only and returns
  the full `GitAuthResolution`. `addApplication` maps an `error` status for the remote's scheme to
  `clone_failed` 500 before any filesystem work, and a missing SSH credential to `clone_failed` 502
  with "no SSH git credential is configured for this project; add one in Settings -> Git" without
  invoking git.
- **Clone path** (`src/coordinator/provision.ts`): exported `cloneRemote(remote, target, auth,
  { exec?, tempRoot?, workspaceRoot? })`, a widened `clone` seam, and `resolveGitAuth` in
  `ProvisioningDeps`. SSH-like remotes materialize an SSH credential; `http(s)://` remotes use an
  HTTPS credential when present and otherwise run the unchanged plain clone argv; `git://` is
  unchanged. Every branch runs through the `gitChildEnv` allowlist with a throwaway empty `HOME`;
  the plain branch writes no credential files and pairs the argv
  `["clone","--depth","1","--",remote,target]` with that allowlisted env. `validateRemote` now also
  rejects `?`/`#` so a query/fragment token cannot reach argv, the manifest, stderr, or the notice.
- **Materialization/environment** (`src/git/materialize.ts`, `src/git/env.ts`): reused
  `writeGitCredentialFiles` (`identity: {}`, real `visibleDir`, `ownership: null`) with only the
  credential for the remote's scheme, and `credentialEnv`; built the child env from `gitChildEnv`
  (never a `process.env` spread), set `HANSE_CREDENTIALS_READONLY=0`, and prefixed the credentialed
  argv with `gitConfigArgs({ sshCommand, askpass })`. Moved `redactUserinfo` into `src/git/env.ts`
  and re-exported it from `src/git/service.ts`.
- **Ephemeral lifecycle** (`src/git/temp-dir.ts`, `src/git/service.ts`, `src/cli/commands.ts`):
  extracted the temp registry and single exit sweep into `createRuntimeDir` and
  `sweepStaleRuntimeDirs`. `GitService` uses `hanse-git-` with no behavior change; the clone uses
  `hanse-git-clone-`, refuses a directory inside `workspaceRoot`, removes it in `finally`, and
  `serve` sweeps stale clone directories at startup (default one hour), skipping registered
  directories, other uids, symlinks, and the protected workspace root.
- **Truthful errors** (`src/coordinator/provision.ts`): exec captures stderr only on both branches;
  sanitization turns C0/C1 controls into spaces, replaces the exact HTTPS token/username and each
  non-empty private-key line with `***`, applies `redactUserinfo`, collapses whitespace, trims, and
  caps to 300 characters after redaction. Only the sanitized `Error` becomes the `ProvisioningError`
  cause; empty/null stderr falls back to the sanitized `error.message`, and the raw exec error is
  never chained.
- **Wiring** (`src/http/handler.ts`, `src/master/tools.ts`): both `provisioningDeps` pass the
  resolver when a `SettingsService` is present; local adds never call it.
- **Docs**: design §19 plus §3/§9.1/§9.3/§13.1/§13.2/§16.5 updates, ADR 0014, deployment Git
  credentials/troubleshooting, current state, plan and journal indexes.

## Decisions and why

- **Project scope only.** The application does not exist yet; app scope is meaningless and reading
  it would be a silent inconsistency. Host auth/provider keys stay out of the clone.
- **Per-scheme, no fallback.** SSH requires an SSH key, HTTPS uses the token only when configured,
  and `git://` remains unauthenticated. This keeps public-repo behavior while giving a clear failure
  for the common "no deploy key" case.
- **One materializer.** The clone reuses the workbench wrapper/askpass and host allowlist instead of
  a second credential implementation, so TOFU, `known_hosts`, and hardening stay identical.
- **Minimal env and argv hardening.** Inherited `GIT_TRACE`/`GIT_CONFIG_COUNT`/`GIT_DIR` cannot leak
  a token into stderr or override the wrapper; `core.hooksPath=/dev/null`, `credential.helper=`,
  `protocol.ext.allow=never`, and `submodule.recurse=false` apply on the command line.
- **Sanitized cause, not the raw exec error.** The raw exec error message embeds stderr, so chaining
  it would defeat sanitization. The clone stays synchronous per the plan.
- **Accepted master capability.** The master can use another project's SSH key as an authentication
  oracle against a master-chosen host; HTTPS tokens stay within the exact host allowlist. The
  same-uid IDE terminal can read the ephemeral directory during the one-clone window. Both are
  recorded in design §13.2 and ADR 0014.

## Tests run

`npm test` (full suite): 113 files, 1968 tests passed.

New/extended coverage:

- `test/add-app-clone.test.ts` (10 tests): SSH env/files/modes/`0700`/`0600`/cleanup with only the
  scheme's credential, HTTPS token absent from argv/env and no SSH key written, allowlisted plain
  clones for HTTP(S)-without-credential and `git://`, sanitized failures on the plain branch, missing
  SSH credential, sanitized exec stderr, ENOENT fallback, materializer failure cleanup, nested
  clones with distinct dirs, and the workspace temp-root refusal.
- `test/temp-dir.test.ts` (3 tests): exactly one exit listener across runtime dirs; a sweep that
  removes only stale matching-prefix directories; and a sweep that keeps registered, protected-root,
  and symlinked directories.
- `test/master-provision.test.ts` (3 new tests): resolver called once with the project id and its
  `gitAuth` reaches the seam; an unreadable credential is rejected before cloning with no app
  directory/row; local add does not resolve and two-argument clone doubles stay assignable; query and
  fragment remotes are rejected.
- `test/settings.test.ts` (3 new tests): `projectGitAuth` returns global/project rows, ignores an
  app-scope row, returns `{}` with only an app row, and exposes an error status for an
  undecryptable credential.
- `test/master-tools.test.ts` (1 new test): local `add_app` does not resolve; an SSH remote does and
  fails `clone_failed` without network.
- `test/http.test.ts` (1 new test): `provisioningDeps` omits the resolver without settings and wires
  `projectGitAuth` when settings are present.

## Gates

- `npm run lint`: pass (269 files).
- `npm run typecheck`: pass.
- `npm test`: pass (113 files, 1968 tests).
- `npm run build`: pass (`tsc`, Tailwind CSS).
- `npm run check:sensitive`: pass ("Sensitive-data check passed.").

## Deployment and residual risk

Deployment is pending. Live smoke after deploy: add an application from an SSH remote with a
project-scope deploy key; an SSH remote without a credential must report the clear message; a wrong
key must report sanitized `Permission denied (publickey)`. A `noexec` coordinator temp root cannot
run the wrapper/askpass. A crash between `mkdtemp` and `finally` can leave a `0700` credential
directory until the startup sweep. The clone remains synchronous and blocks the event loop.
