# 0024 - Add-app clone with project git credentials

Status: implemented and verified (journal 0027); deployment pending. Plan review PASS (rev 2,
blockers from the Oracle design review folded in). Follow-up to
[0010 - Git credentials](./0010-git-credentials.md): that design deferred `git clone` on add-app
(`docs/design/git-credentials.md` §3, §16.5).

## Problem

Adding an application from a private remote fails with
`failed to add application: failed to clone the application: Command failed: git clone ...`.
The clone runs synchronously in the coordinator container, which has no `~/.ssh`, no ssh-agent, and
no credential fallback (by design). `defaultClone` also uses `stdio: "ignore"`, so the operator sees
only the command line and never git's actual error (`Permission denied (publickey)`).

## Goal

When an operator adds an application from a remote, the coordinator clones it with the effective git
credential for the target project, from an ephemeral managed credential directory that is never
written to the workspace or the state volume, with a minimal child environment, and reports git's
sanitized failure reason.

## Decisions

- **D1 - Scope and error states.** The clone resolves `global` + `project` scope for the target
  project, never `app` scope (the application does not exist yet). The resolver returns the existing
  `GitAuthResolution`, not just `{ssh?, https?}`: a stored credential with `status.state === "error"`
  (unreadable/undecryptable) must fail as
  `ProvisioningError("clone_failed", 500, "the stored <KIND> credential for this project is unreadable")`
  before any filesystem work, never degrade into a misleading `Permission denied (publickey)`.
  Implemented as a narrow `SettingsService.projectGitAuth(projectId)` that uses
  `GitAuthStore.listFor(projectId)` (global + project rows) and never reads host auth or provider keys.
- **D2 - Reuse the materializer.** Use `writeGitCredentialFiles` + `credentialEnv`, not a second
  credential implementation: SSH wrapper, HTTPS askpass, host allowlist, `known_hosts`/TOFU, and
  `GIT_CONFIG_NOSYSTEM` stay identical to the agent/workbench path.
- **D3 - Minimal child environment.** Never spread `process.env`. Build the child env with the
  existing allowlist `gitChildEnv({ source: process.env, home: <tmp>/home, sshCommand, askpass })`
  (`src/git/env.ts`), then overlay `credentialEnv(dir)` (managed `GIT_CONFIG_GLOBAL`, wrapper paths).
  Set `HANSE_CREDENTIALS_READONLY=0` explicitly so TOFU `known_hosts` stays inside the ephemeral dir
  instead of the predictable shared `${TMPDIR}/hanse-known_hosts`. Apply the existing
  `gitConfigArgs({ sshCommand, askpass })` hardening (`core.hooksPath=/dev/null`, `credential.helper=`,
  `protocol.ext.allow=never`, `submodule.recurse=false`, ...) to the clone argv. This prevents
  inherited `GIT_TRACE`/`GIT_CURL_VERBOSE`/`GIT_CONFIG_COUNT`/`GIT_DIR` from leaking a token into
  stderr or overriding the wrapper.
- **D4 - Per-scheme materialization; no credentials = today's clone.**
  - SSH-like remote (`ssh://` or scp-like): requires a project SSH credential. If none is configured,
    fail fast with a clear `clone_failed` message ("no SSH git credential is configured for this
    project; add one in Settings -> Git") and no filesystem changes.
  - `http(s)://` remote: materialize the HTTPS credential when one is configured; otherwise run the
    unchanged plain clone argv (public repos keep working).
  - `git://` remote: unchanged plain clone argv (the protocol has no credential).
  - Every clone, including the plain branch, runs with the `gitChildEnv` allowlist and a throwaway
    empty `HOME`; the plain branch writes no credential files and has no `GIT_ASKPASS`. There is no
    ambient config/helper/credential fallback.
  - `validateRemote` also rejects `?`/`#` in a remote, so a query/fragment token cannot reach argv,
    the manifest, stderr, or the error notice.
- **D5 - Ephemeral directory.** `mkdtemp` under `os.tmpdir()` (already `0700`), `ownership: null`
  (coordinator runs as uid 1000), `visibleDir` is the real path (no container translation).
  Register the dir in a module-level registry and remove it in `finally`; also sweep stale
  `hanse-git-clone-*` dirs at coordinator start (container `/tmp` survives process restarts, and
  `exit` does not fire on SIGTERM). Extract the registry/exit hook from `GitService.createRuntimeDir`
  into a shared `src/git/temp-dir.ts` and reuse it in both callers. The sweep skips registered
  directories, a protected root (the workspace), other uids, and symlinks. After `mkdtemp`, assert
  the dir is not inside `workspaceRoot` (guards a misconfigured `TMPDIR`). Credentials never enter
  `workspace/`, `state/`, argv, or a log.
- **D6 - Truthful, sanitized errors.** Capture stderr only
  (`stdio: ["ignore", "ignore", "pipe"]`). Sanitize: decode, turn C0/C1 control characters into
  spaces, replace every exact occurrence of `auth.https.token`, `auth.https.username`, and each
  non-empty line of `auth.ssh.privateKey` with `***`, apply `redactUserinfo`, collapse whitespace to
  single spaces, then cap to 300 characters (cap after redaction). The sanitizer covers **both** the
  credentialed and the plain branch. Pass only the sanitized `Error` as the `ProvisioningError`
  cause; never chain the raw exec error (its message embeds raw stderr). If stderr is empty or null
  (for example `ENOENT`), fall back to the sanitized `error.message`.
- **D7 - Both provisioning entry points.** The web form (`src/http/handler.ts`) and the master tool
  `add_app` (`src/master/tools.ts`) share `addApplication`. Both wire the resolver whenever a
  `SettingsService` is present (production `serve` always supplies one; embeds/tests may omit it, in
  which case behavior is plain-clone/no-credential). No resolver is called for a local (no remote)
  add.
- **D8 - Identity is not needed.** `git clone` does not commit, so materialize `identity: {}`;
  `git.user.*` stays a workbench concern.

## Changes

1. `src/git/temp-dir.ts` (new): `createRuntimeDir(prefix)` with a module-level registry + one
   `process.once("exit")` sweep, and `sweepStaleRuntimeDirs({ root?, prefix, maxAgeMs?, now?,
   protectedRoot? })` that skips registered directories, other uids, symlinks, and the protected
   root. Refactor `src/git/service.ts` (`createRuntimeDir`, `TEMP_DIRS`, `cleanupRegistered`) to use
   it without behavior change.
2. `src/settings/service.ts`: `projectGitAuth(projectId): GitAuthResolution` over
   `#gitAuth.listFor(projectId)`.
3. `src/coordinator/provision.ts`:
   - `ProvisioningDeps.resolveGitAuth?: (projectId: string) => GitAuthResolution`;
   - `clone?: (remote: string, target: string, auth: GitCredentialAuth) => void` (widened seam;
     existing two-argument doubles stay assignable);
   - `cloneRemote(remote, target, auth, { exec?, tempRoot?, workspaceRoot? })` where
     `exec(args: readonly string[], options: { env?: NodeJS.ProcessEnv })`; production `exec` runs
     `execFileSync("git", args, ...)`; scheme selection, credential-error mapping, allowlisted env,
     sanitization (both branches), cleanup as in D1-D6;
   - `addApplication` resolves the auth once per remote add and passes it to the seam.
4. `src/http/handler.ts`, `src/master/tools.ts`: pass `resolveGitAuth: (projectId) =>
   settings.projectGitAuth(projectId)` in their `provisioningDeps`.
5. `src/cli/commands.ts`: sweep stale clone dirs during `serve` startup.
6. `src/git/materialize.ts`: update the `writeGitCredentialFiles` JSDoc to name the third
   (coordinator ephemeral clone) caller.
7. Docs: `docs/design/git-credentials.md` new §19 (renumber References to §20), update §3 non-goals,
   §9.1/§9.3, §13.1/§13.2, §16.5; `docs/decisions/0014-add-app-clone-credentials.md`;
   `docs/deployment.md` (Git credentials behavior, noexec `/tmp` caveat, troubleshooting);
   `docs/current-state.md` (add-app cloning and known limits); `docs/plans/README.md`;
   `docs/journal/README.md` and `docs/journal/0027-add-app-git-credentials.md`.

## Tests

| # | Where | Assertion |
| --- | --- | --- |
| T1 | `test/master-provision.test.ts` | `resolveGitAuth` is called once with the project id and its `gitAuth` reaches the clone seam; an `error` status raises `clone_failed` 500 before the seam; no resolver call for a local add. |
| T2 | `test/add-app-clone.test.ts` (new) | SSH credential: injected exec gets `credentialEnv` + allowlisted env (PATH kept, `GIT_TRACE`/`GIT_CONFIG_COUNT` from `process.env` dropped), `HOME` inside the temp dir, `HANSE_CREDENTIALS_READONLY=0`, hardening `-c` flags, and a `0700` dir with `config`/`ssh`/`id` (`0600`); the dir is gone after return. |
| T3 | same | HTTPS credential: `token`/`username`/`https_hosts` files, `GIT_ASKPASS` set, token absent from argv and env. |
| T4 | same | `http(s)` remote with no credential -> exec receives the allowlisted env (PATH kept, `GIT_TRACE` dropped, no `GIT_ASKPASS`, empty `HOME`) and exactly today's argv; `git://` remote -> same; SSH remote with no SSH credential -> clear `clone_failed` and exec not called; a query/fragment remote is rejected by `validateRemote`. |
| T5 | same | Exec failure on both branches: message contains the sanitized stderr, exact token/key substrings replaced, C0/C1 normalized, no newlines, length <= 300 after redaction, temp dir removed; empty/`null` stderr (`ENOENT`) -> sanitized `error.message`, no `undefined`; the raw exec error is never chained. |
| T6 | same | Materializer failure removes the temp dir and surfaces `clone_failed`; two concurrent clones get distinct dirs and both are cleaned. |
| T7 | same | `TMPDIR` inside the workspace is refused (or the dir is not created under the workspace); mode assertions `0700`/`0600`. |
| T8 | `test/temp-dir.test.ts` | `createRuntimeDir` uses exactly one exit listener; `sweepStaleRuntimeDirs` removes only stale matching dirs and keeps registered, protected-root, symlinked, and other-uid directories. |
| T9 | `test/settings.test.ts` | `projectGitAuth` returns global/project rows, ignores an app-scope row, returns `{}` when only an app row exists, and exposes `status.state === "error"`. |
| T10 | `test/master-tools.test.ts` + `provisioningDeps` test in `test/http.test.ts` | Both call sites pass a resolver when settings exist (spy on `projectGitAuth`); master `add_app` still works without a credential for a local path; a remote add with no SSH credential fails before touching the filesystem. |

Real network clones stay out of the automated suite; the live smoke is the deployment step.

## Verification

`npm run lint`, `npm run typecheck`, `npm test`, `npm run build`, `npm run check:sensitive`, then the
deployment procedure in `docs/deploy/` (archive to the host, pull the published images, restart,
health check, deploy-log entry). Live smoke: add an application from an SSH remote with a
project-scope deploy key; an SSH remote without a credential must now report a clear
"no SSH git credential is configured" message, and a wrong key must report
`Permission denied (publickey)` instead of a bare `Command failed`.

## Rollback

Revert the stage commit: the coordinator returns to the ambient-less `defaultClone`; stored
credentials and the database are untouched (no migration), and running apps are unaffected.

## Risks

- A coordinator crash between `mkdtemp` and `finally` can leave a `0700` credential directory in the
  container `/tmp` until the startup sweep or container removal; `exit` does not fire on SIGTERM.
  Accepted: same exposure class as the existing git runtime dirs, coordinator-only.
- While a clone runs, the same-uid IDE terminal could read the ephemeral directory. Accepted: the
  operator already owns every credential and the window is one clone.
- The clone stays synchronous (unchanged): a slow remote blocks the coordinator event loop.
- A hardened deployment that mounts `/tmp` `noexec` cannot run the wrapper/askpass; documented as a
  prerequisite.
- Per-scheme selection means an SSH remote never silently falls back to an ambient key; the
  coordinator has none and the design forbids ambient credentials.
- Accepted capability (ADR): the master agent can drive another project's SSH key as an
  authentication oracle against an arbitrary host; HTTPS tokens stay confined to their allowlist.
