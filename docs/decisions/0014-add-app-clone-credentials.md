# ADR-0014: Add-app clone with project git credentials

## Status

Accepted (2026-10-23; plan `0024-add-app-git-credentials` review PASS; design
[`docs/design/git-credentials.md`](../design/git-credentials.md) §19).

## Context

`addApplication` clones a remote with `execFileSync("git", ["clone", ...], { stdio: "ignore" })`.
The coordinator image has no `~/.ssh`, no ssh-agent, and no credential fallback by design, so a
private SSH remote fails with a swallowed `Permission denied (publickey)`; HTTPS remotes cannot use
a configured token either. The application does not exist yet, so only the target project's
`global` and `project` settings can apply.

The existing credential materializer already produces the SSH wrapper, HTTPS askpass, host
allowlist, `known_hosts`/TOFU, and child-env allowlist for the app HOME and the Test connection
sandbox. The clone needs the same behavior in a short-lived location without weakening the
coordinator's no-ambient-credential stance.

## Decision

1. **Scope and error states.** `SettingsService.projectGitAuth(projectId)` resolves
   `GitAuthStore.listFor(projectId)` (global + project only, no `app` scope, no host auth or
   provider keys) and returns the full `GitAuthResolution`. If the credential for the remote's
   scheme has `status.state === "error"`, `addApplication` fails with
   `ProvisioningError("clone_failed", 500, "the stored <KIND> credential for this project is
   unreadable")` before any directory or temp target is created.
2. **Reuse the materializer.** The clone calls `writeGitCredentialFiles` and `credentialEnv`; there
   is no second wrapper/askpass implementation. `identity: {}`, `visibleDir` is the real
   ephemeral path, and `ownership: null` because the coordinator runs as the same uid that reads
   the directory.
3. **Minimal child environment.** The env is `gitChildEnv({ source: process.env, home: <dir>/home,
   sshCommand: <dir>/ssh, askpass: <dir>/askpass })` overlaid with `credentialEnv(<dir>)` for a
   credentialed clone; the plain branch uses the same allowlist without `askpass` and writes no
   credential files. `HANSE_CREDENTIALS_READONLY=0` is set explicitly. `process.env` is never
   spread. The credentialed argv is prefixed with `gitConfigArgs({ sshCommand, askpass })` so hooks,
   credential helpers, ext protocols, and submodule recursion stay disabled.
4. **Per-scheme behavior.** SSH-like remotes (`ssh://`, scp-like) require an SSH credential and fail
   with `clone_failed` 502 and a clear "no SSH git credential is configured for this project"
   message without invoking git. `http(s)://` remotes materialize an HTTPS credential when present
   and otherwise run the unchanged plain clone argv. `git://` always runs the plain clone argv. The
   plain branch still runs with the allowlisted env and an empty `HOME`, so there is no ambient
   config/helper/credential fallback. `validateRemote` rejects `?`/`#`, so a query/fragment token
   cannot reach argv, the manifest, stderr, or the browser notice.
5. **Ephemeral lifecycle.** The module-level temp registry and the single `process.once("exit")`
   sweep move to `src/git/temp-dir.ts`. `GitService` keeps its behavior with
   `createRuntimeDir("hanse-git-")`; the clone uses `createRuntimeDir("hanse-git-clone-")`, asserts
   the directory is not inside `workspaceRoot`, removes it in `finally`, and `serve` sweeps stale
   `hanse-git-clone-*` directories (default one hour) at startup. The sweep skips registered
   directories, other uids, symlinks, and the protected workspace root.
6. **Truthful sanitized errors.** Exec captures stderr only on both branches. Stderr is decoded,
   C0/C1 controls are turned into spaces, the exact HTTPS token/username and every non-empty
   private-key line are replaced with `***`, and the result passes `redactUserinfo`, is
   whitespace-collapsed, trimmed, and capped to 300 characters after redaction. Only the sanitized
   `Error` is attached as the cause; the raw exec error is never chained. Empty/null stderr falls
   back to the sanitized `error.message`. The clone remains synchronous.

## Accepted capability

The master agent can call `add_app` with another project's `project_id` and an attacker-chosen SSH
remote, so it can use that project's SSH key as an authentication oracle against an arbitrary host
(success proves the key works there, but does not reveal the key). This is accepted because the
master is operator-trusted and both provisioning entry points share one path. HTTPS tokens remain
confined by the exact host allowlist and the `https://`-only askpass, so a master-chosen host
cannot receive a token outside the allowlist. A same-uid IDE terminal can read the ephemeral
`0700` credential directory while a clone runs; the operator owns the credential and the window is
one synchronous clone. These risks are recorded in
[`docs/design/git-credentials.md`](../design/git-credentials.md) §13.2.

## Consequences

Positive:

- Adding an application from a private SSH or HTTPS remote works with the project's configured
  credential and the same hardening as fetch/push.
- A missing or unreadable credential produces a clear, secret-free failure instead of a swallowed
  git error.
- Credentials never enter the workspace, state volume, argv, or logs, and the ephemeral directory
  is cleaned up on success and failure.

Negative / residual:

- The clone stays synchronous and can block the coordinator event loop on a slow remote.
- A crash between `mkdtemp` and `finally` can leave a `0700` credential directory in the container
  temp root until the startup sweep or container removal; `exit` does not fire on `SIGTERM`.
- A hardened deployment with `noexec` on the temp root cannot run the SSH wrapper/askpass and must
  use a writable, executable temp root.
- The master authentication-oracle capability and same-uid visibility window above are accepted.
