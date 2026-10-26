# 0001 - Intermittent SSH host access failures

Status: open
Created: 2026-10-26
Priority: high (SSH workflows are not reliable)

## Problem

SSH access from an application to an allowlisted host is intermittent. The same host can be listed
as allowed, then rejected by `ssh_exec` with `ssh_host_not_allowed`; a retry may succeed without any
configuration change.

Observed on the test deployment from one application:

1. `ssh_list_hosts` returned the host with `allowed: true`, `grant: null`, and
   `pendingApprovals: 0`.
2. `ssh_exec` with the returned host id failed with `ssh_host_not_allowed` ("The host is not
   available to this application").
3. A retry with the same host id and a simple command succeeded.
4. A later `ssh_exec` with a longer compound command failed again with the same error.
5. A subsequent simple command (including `docker ps`) succeeded.

No allowlist, approval, or host-key change was made between the calls.

## Task

Find the root cause of the intermittent `ssh_host_not_allowed` responses and make allowlist
enforcement deterministic. Do not change the security model: an application must still reach only
the hosts explicitly allowed for it.

## Areas to inspect

- The app identity (`agent.appId`) used by `ssh_list_hosts` versus `ssh_exec`; confirm both calls
  resolve to the same application and token.
- `SshService.withOperation` / `SshStore.isAllowed` and the `app_ssh_hosts` lookup, including any
  database view or coordinator process differences between calls.
- Whether the MCP server or coordinator caches the SSH allowlist, the app identity, or the host list,
  and whether an allowlist change requires a restart or refresh.
- Any race between an allowlist update and an in-flight tool call.
- Coordinator logs around the failed calls: app id, host id, and the exact rejection path. Do not
  record tokens, key material, or command contents beyond what the SSH audit already stores.

## Reproduction

Capture the app id, host id, coordinator instance, and timestamps for every failed and successful
call. A useful reproduction is a loop that calls `ssh_list_hosts` and then `ssh_exec` against the
same returned host, including at least one compound command, and records both outcomes.

## Acceptance criteria

- A host that `ssh_list_hosts` returns for an app is always accepted by `ssh_exec` for that app,
  with no retry or configuration change.
- A host that is not allowed remains rejected with a clear, stable error.
- The behavior is covered by a regression test at the service/store boundary.
- The root cause and the fix are recorded in this task file or a journal entry.

## Constraints

- Do not weaken the allowlist, approval, host-key, or audit checks to hide the symptom.
- Keep the change scoped to diagnosis and the fix; do not bundle unrelated SSH work.
- Use placeholders, not real deployment hostnames, addresses, project ids, or app keys, in any
  tracked notes.
