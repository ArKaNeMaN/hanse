# Design - Agent process protection and interrupted-turn recovery

- Stage: `0030-agent-process-protection` (plan 0030; journal 0037)
- Status: implemented and verified (revision 10; design gate cleared; journal 0037); commit/deployment pending
- Related: [ADR-0005](../decisions/0005-permission-policy-guardrail.md),
  [interactive prompts](./interactive-prompts.md), [chat UX overhaul](./chat-ux-overhaul.md),
  [chat session tree](./chat-session-tree.md), [agent runtime](./agent-runtime.md)

## 1. Context

An `opencode` subagent killed its own server process while trying to test opencode behaviour. In the
runner deployment the app container entrypoint `exec`s `opencode serve`, so opencode is PID 1
(`shell/hanse-agent-entrypoint:1-3`, `src/runner/server.ts:84,875-877`). The bash tool runs in the same
PID namespace and as the same UID `1000:1000`; `pkill opencode`/`kill 1` sends SIGTERM and opencode
has a SIGTERM handler. Docker's `unless-stopped` policy (`src/runner/docker.ts:848-851`) restarts the
container. The in-flight turn is lost, and the coordinator currently ends the upstream SSE stream
silently (`src/opencode/events.ts:2081-2095`, `src/http/chat.ts:601-714`,
`src/http/prompts.ts:656-831`). The browser sees an EventSource error, but no `session.error` and no
coordinator-owned chat message.

The stage delivers the owner-selected scope 1+2+4:

1. a persistent safe-test instruction for every managed app;
2. narrow bash deny rules for the self-kill commands, with post-start verification;
3. process-stop detection, persisted system notices, a subagent-to-parent signal, and
   recency-guarded resume of recently interrupted top-level sessions.

The permission layer remains a guardrail, not a sandbox. A determined agent can bypass command
patterns (`sh -c`, `/bin/kill`, `node -e`, scripts), app-owned config/plugins can widen the final
ruleset, and post-start verification is warning-only. Hard isolation (separate UID/seccomp) is not in
this stage.

## 2. Requirements

| ID | Requirement |
| --- | --- |
| R1 | Every managed app receives an always-on instruction forbidding signals to opencode/PID 1 and documenting safe ways to inspect opencode behaviour. |
| R2 | Known self-kill bash commands resolve to `deny` in every non-hidden agent, including subagents; legitimate process cleanup still works. |
| R3 | When the opencode process stops while a session is working, a coordinator-owned system notice is persisted in that session's chat log and survives reload. |
| R4 | When only a subagent is interrupted, the parent session receives a distinct notice; the parent turn itself is not aborted. |
| R5 | After any opencode/container restart (unexpected, operator, external, or deployment), recently interrupted top-level sessions are resumed automatically when the app is running/ready, subject to TTL, attempt, and safety guards. |
| R6 | Long-downtime, stopped, or deleted interruptions are not auto-resumed; the operator sees a notice and can send a normal chat message to continue. |
| R7 | Resume must not duplicate a prompt or blindly replay tool side effects; every attempt is recorded and capped. |
| R8 | Notices are UI-only; they must not enter the model context. The resume prompt is the only model-visible text. |
| R9 | Existing chat pagination, SSE hydration, deletion/sweep, handoff routing, settings hash/restart semantics, and no-model test suites keep working. |

## 3. Current behaviour and gaps

### 3.1 Process and container lifecycle

- The production runner creates the app container with `Entrypoint:
  /usr/local/bin/hanse-agent-entrypoint`, `Cmd: []`, `User: 1000:1000`; the script `exec`s
  `opencode serve --hostname 0.0.0.0 --port 4100`, so opencode is PID 1. `dumb-init` and
  `hanse agent-host` from the image are bypassed (`Dockerfile:196-210`, `src/runner/server.ts:84,875-877`,
  `shell/hanse-agent-entrypoint:1-3`).
- App containers default to Docker `unless-stopped`; one-shot git/validation containers explicitly
  use `"no"` (`src/runner/docker.ts:848-851`, `src/runner/server.ts:1106,1198`).
- The coordinator can observe `RuntimeAppState` (`starting|running|stopped|error`) and the container
  ID/name, but not Docker `StartedAt`, `RestartCount`, `ExitCode`, `OOMKilled`, or `FinishedAt`
  (`src/agent/protocol.ts:14-25`, `src/runner/docker.ts:300-335`,
  `src/runner/server.ts:295-329`).
- The 15 s reconciler only probes rows not already `stopped`; it forgets the running entry and
  persists the observed state, but does not compare runtime epochs or fail a turn
  (`src/opencode/manager.ts:1299-1319,1806-1847,1931-1959`). A fast Docker restart between polls is
  invisible.
- Explicit restart/stop goes through `#stopLocked`; deletion and restart are distinguishable only by
  the caller, not by a persisted reason (`src/opencode/manager.ts:1208-1280,1405-1415`). There is no
  plain operator "stop" HTTP route in the current code.

### 3.2 Session/turn state

- Session and message content live in opencode's SQLite DB under
  `<state>/opencode.db`; the coordinator stores only chat metadata (`session_state`,
  `pending_sends`, drafts, attachments) and never a copy of messages
  (`src/opencode/instance.ts:104-114`, `src/store/migrations.ts:504-539`).
- `ContextMonitor` keeps per-session `status` (`idle|busy|retry|unknown`) and `lastActivityAt` in
  memory (`src/opencode/context.ts:1080-1122`); it is not persisted. The event projector also keeps
  per-stream duplicate-suppression maps only. A process death loses all of this.
- `session_state.last_activity_at` is bumped by chat interactions (draft/touch/send), not by every
  agent step (`src/chat/state.ts:209-281,347,411`). It is not an active-turn timestamp.
- opencode v1 has no resume/replay of an in-flight assistant turn. After SIGKILL the process-local
  runner/status map is gone; sessions and partial messages remain in SQLite, and the next prompt
  starts a new assistant message. `session.revert`/`unrevert` are destructive worktree/message
  checkpoint operations, not resume.
- opencode v1 `GET /session/status` returns only the in-memory active status map; idle sessions are
  absent. The coordinator does not wrap this endpoint yet (`src/opencode/client.ts:226-244`).
- `sendPromptAsync` accepts a message id and text/parts (`src/opencode/client.ts:606-627`). Text parts
  support `synthetic: true`; the Hanse UI hides synthetic parts, and the attachment manifest already
  uses this to send model-visible-but-hidden context (`src/attachments/manifest.ts:36-44`,
  `assets/chat.js:5198-5222`).

### 3.3 Subagent interruption

In opencode 1.19.3 a task child is a child session. Aborting the child cancels its run, finalizes the
child's assistant message with `MessageAbortedError`, and cancels the parent's background task job;
the parent `task` tool receives an error ("Task cancelled", or "Subagent failed (task_id: ...)") and
the parent turn continues. Aborting the parent interrupts the task tool itself. Killing the process
kills every session in that process. There is no synthetic event for process death.

### 3.4 Permissions and instructions

- `PermissionPolicy` has no `bash` field; `buildPermissionPolicy` produces external-directory,
  question/todo, web, read/edit, and doom-loop rules only (`src/opencode/policy.ts:12-25,222-267`).
- `evaluateAgentPolicy` verifies credential denies for every non-hidden agent and question/todowrite
  for primary/`all` agents; hidden agents are skipped and subagents stop after credential checks
  (`src/opencode/policy.ts:377-399`). Verification is warning-only
  (`src/opencode/policy.ts:457-498`, `src/opencode/manager.ts:1982-2002`).
- `OPENCODE_CONFIG_CONTENT.permission` is the highest non-managed config layer; `OPENCODE_PERMISSION`
  is scrubbed from the launcher environment (`src/opencode/policy.ts:100-126,270-281`) and not built
  into the manager/runtime env (`src/opencode/manager.ts:873-888`). App-owned `opencode.json` and
  plugins can still widen the final ruleset; verification is the only detector.
- The `instructions` overlay is already supported by `buildConfigOverlay`
  (`src/opencode/instance.ts:160-165`) and used by the master (`src/http/apps.ts:59`,
  `src/master/tools.ts:380`). The master writes its own `AGENTS.md` and passes the container-visible
  path. Ordinary apps have no coordinator-owned instruction file; project `shared` instructions are
  not wired into `toManagedApp` in the current code.

### 3.5 Chat notices and UI

- There is no coordinator-owned chat message table. OMO system cards and handoff cards are
  classifications/metadata on real opencode messages; tool cards are real parts; the generation row
  and stream notices are DOM-only; `session.error` is a tab-memory local error row. None is a
  persisted coordinator system message (`assets/chat-core.js:824-900,1340-1420`,
  `assets/chat.js:8806`, `src/coordinator/handoff-messages.ts`).
- The app SSE route proxies opencode and context snapshots only; there is no coordinator event bus
  for a new notice type (`src/http/prompts.ts:656-824`, `src/opencode/events.ts:137-229`).
- Deleting a session removes `session_state`, drafts, attachments, deliveries, and pending sends
  (`src/chat/state.ts:487-552`). Any new session-scoped table must join this cleanup and the
  delete-if-empty/sweep block predicate.

## 4. Decisions

### D1 - Instruction injection

Use the existing `OPENCODE_CONFIG_CONTENT.instructions` mechanism. The coordinator materializes a
constant English rule file at exactly
`path.join(isolated.XDG_STATE_HOME, "hanse", "agent-process-rules.md")`, where `isolated` is the
per-app environment from `resolveInstanceEnv` (`src/opencode/instance.ts:96-114`). That is
`<agentsHome>/<project>/<app>/state/hanse/agent-process-rules.md`, inside the agents root mounted
into the app container, so the container-visible path equals the coordinator path. It is not the
coordinator state directory (`<stateHome>/hanse`). Append that absolute path to
`buildConfigOverlay({ instructions })` for every managed app, after any app-specific instructions.
The file is rewritten on every start and verified/re-written on the early reconnect path too (an app
that deleted it and killed opencode must not reconnect without it); the write is atomic and does not
touch the app repository. To preserve "settings apply only on explicit restart", add
`instances.applied_rule_hash` and a sidecar `state/hanse/agent-process-rules.applied.md`. On
reconnect, restore/verify against the **applied** sidecar and hash; normally do not write a new
code-version rule into a running app's state file before the explicit restart that updates
`applied_settings_hash`. **Explicit safety exception:** if the sidecar is missing or its hash does
not match `instances.applied_rule_hash`, no trusted applied copy exists. Restore the current code
rule, keep `applied_rule_hash`/`applied_settings_hash` unchanged so the app stays `Restart required`,
and log the integrity failure. This exception can apply the new rule on a Docker auto-restart of
opencode before the explicit coordinator restart; that is accepted because the alternative is no
instruction at all. The sidecar is agent-writable; for a stronger restore, store the applied content
in the coordinator DB or a coordinator-owned path outside the agents mount. On an explicit restart,
write the sidecar first, then the active file, then the DB row (`applied_rule_hash` +
`applied_settings_hash`); startup reconciliation repairs a crash between the steps using the
`applied_rule_hash`. A live probe must confirm that opencode 1.19.3 loads an absolute `instructions`
path under `XDG_STATE_HOME` (not only
an app-dir path).

The instruction content:

- never signal or kill the opencode server/PID 1 or its process group;
- do not use `pkill`/`killall`/`kill`/`kill -9` against opencode, even to "test" it;
- to inspect opencode, use a separate instance with a temporary `HOME`/`XDG_*` and a free port, or
  read-only `opencode --version`/`opencode debug` commands;
- if the server appears stuck, report it to the operator instead of self-terminating.

The rule file content hash is added to `settingsHashFor` and `#pendingRestartFor`
(`src/opencode/manager.ts:331-347,1158-1206`) so changing the rule marks running apps
`Restart required`, like a policy version bump.

Rationale: `instructions` concatenate with project config, `AGENTS.md`, and the app's own
instructions; they are not overridden by a project config. The file is outside the app repository and
not named `AGENTS.md`, so it does not collide with user instructions. The master already proves the
overlay/container-visible path.

Alternatives rejected: writing each app's `AGENTS.md` (edits user repositories); a managed skill
(lazy-loaded, not guaranteed for a safety rule); a plugin/system-prompt hook (version-coupled and
larger); relying on `AGENTS.md` discovery only (project instructions can dilute or contradict it).

### D2 - Bash deny rules and verification

Add `bash: PermissionRules` to `PermissionPolicy` and build it from a narrow deny-only constant:

```
pkill *opencode*
killall *opencode*
kill 1
kill -9 1
kill -KILL 1
kill -TERM 1
kill -15 1
kill -s KILL 1
kill -s TERM 1
kill -1
kill -- -1
kill -s KILL -1
kill 0
```

No `"*"` entry in `bash` and no top-level catch-all. Do not use a broad `kill *` deny: legitimate
test-runner, dev-server, and `timeout` cleanup would break. The process-group forms cover the
instruction's process-group wording; `kill 0` is denied because the shell's process group can include
the agent runtime. The safe-test instruction must tell the agent to kill the recorded PID of its
throwaway test instance, not to use `pkill *opencode*`, or the deny rule will block its cleanup.
Bump `ATTACHMENTS_POLICY_VERSION` from 2 to 3 so existing instances show `Restart required`.

Extend `VerifyPolicyOptions`/`evaluateAgentPolicy` with the probe commands and require every non-hidden
agent, including subagents, to resolve each probe to `deny`. Warning text is deterministic, e.g.
`agent "<name>": bash does not deny "<probe>"`. Hidden agents remain skipped, matching the existing
intentional-profile rule. Warnings surface through the existing `policyWarnings`/`/prompts` path;
`policy_unverified` stays hidden from the operator banner.

Caveats: the rules are bypassable through wrappers, scripts, and obfuscation; app-owned config/plugins,
v1 `always` approvals (instance-lifetime, appended after config), and v2 saved allow permissions can
widen the final ruleset; verification runs only at start and is warning-only. The rules prevent the
observed accident, not a hostile agent.

### D3 - Runtime epoch and stop classification

Expose Docker observation fields needed to tell a restart from an idle/stopped app:

- `RuntimeAppStatus` gains `startedAt?: string | null`, `restartCount?: number`,
  `exitCode?: number | null`, `oomKilled?: boolean`, `finishedAt?: string | null`
  (`src/agent/protocol.ts:14-25`).
- `DockerContainerInspect` gains top-level `RestartCount?: number` and
  `State.OOMKilled?: boolean`; `statusFromInspect` maps them
  (`src/runner/docker.ts:300-335`, `src/runner/server.ts:295-329`).
- The B0 host status already has `startedAt`; map it to the same fields, with `restartCount: 0` when
  unknown (`src/agent/protocol.ts:74-83`).
- Migration v20 adds `instances.runtime_started_at`, `runtime_restart_count`, `last_exit_code`,
  `last_oom_killed`, `last_stop_reason`, `last_stop_at`. The reconciler updates them on every status
  observation; `#recordStatus`/`#recordStatusById` compare the previous epoch.
- `#stopLocked` accepts a reason (`restart`, `delete`, `stop`) and records the intent before deleting
  the container. The intent is consumed atomically when the new epoch is recorded: clear
  `last_stop_reason`/`last_stop_at` in the same update that writes `runtime_started_at`. An intent is
  honored only when `last_stop_at >= previous_runtime_started_at` and is less than a bounded window
  (recommended 10 minutes) old. A stale intent must never suppress a later crash.
- If the previous `runtime_started_at` is NULL (first observation after the migration), record the
  observed epoch as the baseline and skip interruption detection. An upgrade must not synthesize
  notices or resumes for pre-existing sessions.
- Persist the operator-stop notice (not just an in-memory snapshot) before an explicit
  stop/delete/restart calls `runtime.delete`, so a coordinator crash during the stop cannot lose the
  R3 notice for an intentional restart. Child notices are deduped by
  `(app, childSession, kind, runtime_epoch)`.
- **Unexpected SIGTERM rule (applies even if the phase-0 probe shows no abort event).** Terminal
  `idle`/`error` events do not clear a busy marker immediately. Set `terminal_pending_at`, capture
  whether the session tail was already complete at that instant, and after a short grace (recommended
  5 s) confirm with `GET /session/status` and a live `runtime.status` call. Clear the marker only when
  the session is idle/absent, the live `startedAt`/`restartCount` equals
  `session_resume.runtime_started_at`/`runtime_restart_count`, and readiness succeeds. If the tail was
  complete at `terminal_pending_at`, clear regardless of a later epoch change; the turn finished.
  Otherwise, if the status probe fails or the live epoch changed, preserve the busy marker as
  shutdown-induced. Do **not** treat a monitor stream close as evidence of process death: `/event`
  reconnects on ordinary network blips. Compare the live runtime status, not the reconciler's
  persisted `instances` row, which can be up to 15 s stale. A new busy event cancels the pending
  clear. If `session_resume.runtime_started_at`/`runtime_restart_count` is NULL or unknown (busy
  observed before the epoch was sampled, or a row from an upgrade), persist the live epoch in the
  busy upsert. At confirmation, if the row epoch is still unknown, do **not** use the post-restart
  live epoch as a pre-crash baseline:
  - status sample `busy`/`retry` -> preserve (the turn is still active);
  - status sample `idle`/absent and the `terminal_pending_at` tail was complete -> clear;
  - status sample `idle`/absent and the tail was unfinished or absent -> preserve.
  Add tests for SIGTERM that emits `idle`/`error`, a normal completion followed by a crash, a monitor
  reconnect during a normal completion, and a NULL/unknown busy epoch with a restart + unfinished
  tail and with an active status sample.

Detection rules:

| Observation | Classification | Auto-resume |
| --- | --- | --- |
| runtime epoch changed and a fresh intent is `restart` | operator restart | yes, if running/ready and eligible |
| runtime epoch changed and a fresh intent is `stop`/`delete` | operator stop/deletion | no; notice only / session is being deleted |
| runtime epoch changed with no intent, deploy lock active | deployment | defer; auto-resume after the lock clears if running/ready and eligible |
| runtime epoch changed with no intent and runtime is `running` | unexpected process exit/restart | yes, if eligible; `starting` waits for running/readiness, never calls `ensure` |
| app state `stopped`/`error` while a session was busy | unexpected exit, but the app is not running | no auto-start; notice only |
| coordinator restarted and an epoch changed while it was down | unknown restart | auto if the app is running/ready and eligible |
| child `session.error` `MessageAbortedError` only | subagent interruption | child no; parent notified |

An external `docker restart` produces a running new epoch with no Hanse intent and is therefore
classified as an unexpected restart (accepted ambiguity: the operator asked for a restart, and the
session may be resumed). An external `docker stop` leaves the app stopped, so it produces the notice
but **never auto-starts** the container; this prevents recovery from undoing an operator stop. The
the owner decision is auto-resume for any restart; a stopped app still gets no auto-start.

**Read paths must not undo the stop.** Today `GET /sessions`, `GET /messages`, the app SSE route,
`/prompts`, `/saved-permissions`, `/todo`, and `/context` all call `manager.ensure` (directly or via
`withReadEndpoint`) and lazily start a stopped app (`src/http/chat.ts:2244-2267,2462-2477`,
`src/http/prompts.ts:582-590,705-727`). That would let a browser reconnect or chat refresh start an
app the operator stopped. The design changes **every chat read endpoint** to use `endpointFor` (or a
non-starting runtime status); if the app is stopped, they return a typed `agent_stopped`/503 body and
do **not** start it. The client keeps its cached feed and shows the persisted notice + an explicit
**Start agent** action. Only a user action (Start, or sending a message, which is an explicit ensure)
starts the app. Automatic EventSource reconnect and hydration never start it. This is a behavior change
from the current lazy read-start and is part of R9. Align the new `agent_stopped` code with the
existing `agent_not_running` handling (`assets/chat.js:4663`) so the client has one handler.

**Reload while stopped.** A full page reload has no in-memory feed. When `/sessions` returns
`agent_stopped`, `bootSessions` must not clear the thread and stop; it uses the URL session id (or a
DB-only session summary from `session_state`/`session_resume`/notices) to render a stopped shell,
fetch the notices route, and show Start. If no session id is present, show a DB-backed recent-session
list or a Start action without pretending the app is running. Add a reload-while-stopped browser test.

The reconciler must run detection outside the app lock (or enqueue it) so the recovery service can
call `ensure` without deadlocking. `ensure`'s running/reconnect path must also compare the epoch,
because a fast Docker restart can avoid a `stopped` sample.

**Startup catch-up.** The reconciler only probes rows not already `stopped`
(`src/opencode/manager.ts:1817-1825`). A stop while the coordinator was down, or a crash between
persisting `stopped` and writing the notice, would therefore be missed. On coordinator startup, after
`resumeRunning`, run a bounded catch-up pass over `session_resume` cycles with `observed_status` in
`busy|retry` and (`interrupted_at` is NULL or `resume_state=deferred`), joined to `instances`:

- `stopped|error` -> write `agent_stopped` (reason `unknown_restart`, notice only);
- `running|starting` with a live runtime epoch different from
  `session_resume.runtime_started_at`/`runtime_restart_count` -> write a notice and allow the normal
  auto-resume eligibility (the epoch changed while the coordinator was down; the owner chose
  auto-resume for any restart);
- same epoch and running -> leave the cycle alone; the monitor/status sample will refresh it.

Deferred rows whose `defer_reason` is `restart_claim` or `deployment_lock` are retried by the same
pass once the claim/lock is gone; if the TTL expires first, they become `skipped_stale`. Clear
`defer_reason` on resume/cycle reset. `skipped_*` terminal rows are left alone and never auto-resume.

Write with the same interruption-key guard, apply the completed-tail cutoff, start no app, and be
idempotent across restarts.

### D4 - Active-turn records

Add `session_resume` (one row per app/session) and persist the last observed running status:

```
app_id, session_id, parent_session_id,
observed_status (busy|retry), observed_at, last_busy_seen_at,
interrupted_at, interruption_epoch, interruption_key,
reason, runtime_started_at, runtime_restart_count,
resume_state, defer_reason, dispatch_state, auto_dispatch_retries,
auto_attempts, last_attempt_at,
resume_message_id, last_error, created_at, updated_at
PRIMARY KEY (app_id, session_id)
```

The recovery service observes `session.status` events from the existing monitor (`#startMonitor`'s
`onEvent` callback, `src/opencode/manager.ts:1773-1787`) and upserts `busy`/`retry`; terminal
`idle`/`error` follows the 5 s confirmation rule above. Cycle resets and terminal clears are
transition-only, but every successful `busy`/`retry` status sample refreshes `last_busy_seen_at` (and
`observed_at` on a transition) even when the status is unchanged; best-effort, never breaking the
stream. TTL uses `last_busy_seen_at`, so a turn that stays busy longer than 30 minutes is not treated
as stale. A standalone `GET /session/status` wrapper is added and
sampled on every monitor reconnect and at the reconciler cadence while the app runs, because opencode
status is in-memory, absent for idle sessions, and the monitor is only started when
`settings.contextPolicy` exists (`src/opencode/manager.ts:1756-1764`). The status sample runs
**outside** the app lock, so an opencode timeout cannot extend the lock. It is the authoritative
fallback when the context monitor is disabled; it seeds/clears markers after a reconnect, and a
missing status entry clears a marker only when the session tail is complete (the same completed-tail
test as resume eligibility). If the status endpoint is unavailable, the persisted marker plus the
runtime epoch is the fallback.

A new `busy`/`retry` transition after an idle/terminal state starts a new interruption cycle: clear
`interrupted_at`, `interruption_epoch`, `interruption_key`, `resume_state`, `dispatch_state`,
`auto_dispatch_retries`, `auto_attempts`, `last_attempt_at`, `resume_message_id`, and `last_error`,
set `dispatch_state=none`, and set
`observed_at`. The new cycle must not inherit a spent dispatch-retry budget or a terminal dispatch
state from the previous cycle; `prepared` is reserved for the pre-dispatch transaction. TTL uses `last_busy_seen_at`, not the
cycle-start `observed_at`; a long busy turn is still resumable.
**Exception:** suppress this reset only while `resume_state=resuming`, the busy follows the recorded
resume attempt within its lease/time window, **and** `resume_message_id` is still the last user
message (no newer user message). That busy is the resume's own outcome, not a new user turn. If a
newer user message exists, mark the resume `superseded`, release the exception/lease, and reset for
the user's new turn. The reset resumes normally after the resume reaches
`resumed`/`completed`/`failed`/`superseded` or the lease expires. This preserves the resume
correlation and the auto-attempt cap. The cycle is the unit for TTL, attempts, and notice dedupe.
`observed_at` (the last busy observation), not `interrupted_at` (the detection time), is the cutoff
for "did the turn complete before the crash?". A session tail with an unanswered user message, an
assistant with `finish: "tool-calls"`, or an assistant without `time.completed` is resumable; a
completed non-tool-calls assistant after `observed_at` means the turn finished and no resume is
allowed.

The human abort route records a short-lived abort tombstone keyed by `(app, session, time)` before
calling opencode. `session.error` with `MessageAbortedError` is classified `operator_abort` only when
the tombstone matches the session **or one of its ancestors** (walk `parentID` upward) within the
window; otherwise it is `subagent_abort` (or unknown). A human Stop on the parent therefore covers an
aborted child; a child Stop is covered by the child tombstone. The tombstone is not trusted from the
client; it is server-side and bounded (recommended 30 seconds).

`session_state.last_activity_at` is not used as the turn timestamp. It remains a chat-interaction
timestamp for drafts/delete-if-empty.

### D5 - Persisted notices

Add `session_notices` (bounded-append system notice rows; latest 50 per session):

```
id, app_id, session_id, parent_session_id, dedupe_key,
kind (agent_stopped|subagent_interrupted|resume_started|resume_failed|resume_completed|resume_unavailable),
reason, payload_json, created_at
PRIMARY KEY (id)
UNIQUE (app_id, session_id, dedupe_key)
CHECK (kind IN (...)); CHECK (json_valid(payload_json) AND length(payload_json) <= 4096)
INDEX (app_id, session_id, created_at DESC, id)

session_notice_dedupe (
  app_id, session_id, dedupe_key, created_at,
  PRIMARY KEY (app_id, session_id, dedupe_key)
)
```

The separate `session_notice_dedupe` table preserves dedupe evidence when an old notice is pruned by
the 50-notice cap. The write is one transaction: `INSERT OR IGNORE` into `session_notice_dedupe`;
only if that insert changed a row (`changes() === 1`) insert the notice; otherwise do nothing. Do not
rely on the notice unique constraint alone, because pruning removes it. The dedupe row has
`session_id` and is deleted by `deleteSessionChatRows`, parent-subtree cleanup, and app/session
deletion. The child-abort key includes `runtime_epoch` and is stored in the key and payload.
`reason` enums include `process_exit`, `operator_restart`, `operator_stop`, `deletion`, `deployment`,
`unknown_restart`, and `unknown`.

`payload_json` is bounded structured data (`exitCode`, `oomKilled`, `childSessionID`, `attempts`,
`boundedError`). Session titles are **untrusted agent output**; do not store or inject them in the
resume prompt. If a title is shown in the UI, store it as bounded text and render with `textContent`.
IDs are coordinator-generated (`notice_<uuid>`). A notice is written exactly once per
interruption/event transition:

- process interruptions use one transaction with
  `UPDATE session_resume SET interrupted_at = ?, interruption_key = ?
   WHERE app_id = ? AND session_id = ? AND interruption_key IS NOT ?`;
  the `session_resume` `changes()` authorizes the interruption, and the subsequent dedupe
  `changes() === 1` authorizes the notice. Both run in the same transaction; a retry of the same
  interruption changes neither. The key includes the runtime epoch and the interruption cycle;
- child aborts use `(app, childSession, kind, runtime_epoch)` as the dedupe key (stored in
  `session_notice_dedupe` and the payload), so a child `MessageAbortedError` emitted during a
  graceful SIGTERM cannot duplicate the whole-process `agent_stopped` rollup;
- notice writes check the deletion marker and session existence under the existing session lock;
  orphan rows for a vanished upstream session are pruned by the sweep.

Notices are independent of the app runtime:

- `GET /api/apps/:app/sessions/:sid/notices?limit=&before=` reads the coordinator DB only and does
  not call `manager.ensure`, so it works while opencode is down.
- `notice.created` is added to the typed app SSE union and emitted through a manager/app event
  subscription (`src/opencode/events.ts:137-229`, `src/http/prompts.ts:799-810`). The client also
  fetches the latest notices on `stream.ready`/session open, so a missed event is recoverable.
- **Owner decision (2026-10-27): notices appear visually inside the ordinary chat log.** The client
  keeps a per-session notice map and interleaves notices with messages by `created_at` (stable
  tie-breaker by id). Each notice renders as a full-width "break" row with a horizontal rule and a
  short label such as "Agent was restarted here" / "Subagent interrupted" plus the reason. It is a
  visual separator in the flow, not a separate panel.
- Pagination stays decoupled: the message cursor remains opencode's opaque cursor; notices use their
  own `before` cursor. The client loads the latest notices on open and older notices when the feed
  scrolls past the oldest loaded message/notice. A notice older than the oldest loaded message is not
  shown until that scroll (accepted limit); a session with notices but no messages still shows them.
- Notices are not sent to opencode and do not enter the model context. The resume prompt is the only
  model-visible continuation text.
- **Renderer integration (blocking detail for the plan).** The client thread store gains a
  `notices` map, a notice `before` cursor, and a `noticeOrder` sorted by `created_at`/id. The feed
  render list is the merge of `store.order` message ids and `noticeOrder`; notice nodes use
  `.feed-notice` and are preserved by `syncMessageOrder` (`assets/chat.js:7688-7716`), counted by
  `flushFrame`, included in scroll anchors, and considered by the empty-feed branch (`emptyThread`)
  so a notice-only session shows them. `resetFeedDom`, `saveCurrentRuntime`, and `adoptRuntime`
  include/clear the notice map and cursor. `messageCountLabel` counts messages only; the merged list
  is only for order/empty/anchor. Cover the full-render `renderDirty` cleanup as well as
  `syncMessageOrder`. Older notices load with the message scroll; when the message `historyCursor` is
  already null, use an explicit notice-cursor trigger. The message cursor stays opencode's opaque
  cursor. `classifyOmo` must not classify the `agent-resume` synthetic
  part as a system card; the client hides parts with `metadata.hanse === "agent-resume"` and shows only
  `resume_started`.
- **Live and missed delivery.** `notice.created` is emitted when the app SSE is attached. When the
  SSE is unavailable/stopped, the client refreshes the DB-only notices route on stream error/pause,
  session open, and `stream.ready`; this is the fallback for the stop case where the SSE cannot attach.
  The events route must not `ensure` a stopped app (see D3 read-path rule).

Deletion/lifecycle integration:

- `localSessionBlockReason` gains `has_notice`; delete-if-empty and the normal sweep keep a session
  that has a notice. Because the current sweep checks the block before the upstream-gone probe
  (`src/chat/sweep.ts:128-133`), add a separate notice-orphan pass (or reorder the check) that probes
  upstream existence first and prunes notices/resume rows for a vanished session; otherwise a
  notice-only session can never be swept.
- `deleteSessionChatRows` deletes `session_notices`, `session_notice_dedupe`, and `session_resume` for
  the session; parent subtree cleanup calls it for every collected id; app/project deletion cascades.
- Manual session delete, parent subtree cleanup, retry-on-vanished-session, app/project cascade, and
  deletion tests cover the new rows.
- **Notice eligibility uses the completed-tail cutoff too.** Before writing `agent_stopped` (and
  before resuming), require an unfinished tail at `observed_at`: an unanswered user message, an
  assistant with `finish: "tool-calls"`, or an assistant without `time.completed`. If the last
  assistant is a completed non-tool-calls message, clear the marker and write no interruption notice;
  a normal completion followed by an unrelated process exit must not produce a false notice.
- The client's `sessionHasHistory` counts notice records; a notice-only session is not treated as
  empty.
- Notices are capped per session (latest 50) or pruned on session delete; no global retention job is
  added.

### D6 - Resume policy

Auto-resume is limited to top-level sessions (`session.parentID` absent) with a `session_resume` row
whose last observed state was `busy`/`retry`. **Owner decision (2026-10-27): any restart triggers
auto-resume, including an explicit operator restart and an external `docker restart`; the interruption
reason is shown in the notice but is not a skip reason.** Auto-resume requires the runtime to be
already `running` **and** a readiness probe to succeed. A `starting` container is not auto-resumed:
the manager's early reconnect reuses only `running` (`src/opencode/manager.ts:616-620`) and
`#ensureLocked` may stop/recreate a restarting container (`src/opencode/manager.ts:684,928`). For
`starting`, poll `runtime.status` and readiness without calling `ensure`; if it does not become
running within the bounded wait, leave the notice (the operator can send a normal message). It is
skipped when any of the following holds:

- `now - last_busy_seen_at` is older than the TTL (30 minutes; owner decision) -> terminal
  `skipped_stale` notice;
- the app is deleting or the session no longer exists -> terminal `skipped_missing`/deleted; no prompt;
- **before the stopped terminal rule**, a fresh restart intent/claim or a deployment transition is
  checked: a restart claim is active -> `resume_state=deferred` with `defer_reason=restart_claim`
  (the claim spans stop+ensure, `src/opencode/manager.ts:1328-1344,1405-1415`); a deployment lock is
  active -> `resume_state=deferred` with `defer_reason=deployment_lock`. The reconciler retries when
  the claim/lock is gone, and startup catch-up includes deferred rows;
- the app is `stopped`/`error` **and no restart/deploy transition is pending** -> terminal
  `skipped_stopped` only after a grace/re-probe (recommended one reconciler tick or 10 s) confirms the
  stopped state persists and no new runtime epoch appeared. A transient stopped sample during an
  explicit/external restart or a deployment must not terminalize the cycle. Never auto-start; the
  operator can start the app and send a normal message, but a later start must **not** trigger
  auto-resume for this cycle;
- the session has a newer user/assistant message after `last_busy_seen_at`, has a completed
  non-tool-calls assistant after `last_busy_seen_at`, or opencode reports it `busy`/`retry`;
- `auto_attempts` is already 1;
- a resume for the session is already in flight (per-session single-flight; a small app-level
  concurrency cap may be added, but one slow resume must not block every other session forever).

Resume sends exactly one synthetic continuation prompt to the same session:

```
The previous turn was interrupted because the agent process stopped and restarted.
Continue the same task from the existing session state. Before acting, inspect the
current files and tool state; do not repeat side effects that already happened.
If a subagent was interrupted, re-check its work or retry it as needed.
If you cannot determine safe progress, explain what is missing and stop.
```

The prompt is sent with `sendPromptAsync` and a text part `{ type: "text", text, synthetic: true,
metadata: { hanse: "agent-resume" } }`. The message id is `msg_` + 32 lowercase hex derived from
`(appId, sessionId, interruption_key, attempt)`; it matches the existing `msg_` id shape and is
deterministic per attempt. A live probe must confirm opencode 1.19.3 honors a caller-supplied
message id; if it does not, fall back to the server-generated id and dedupe with a pre-dispatch
sentinel. No model override: the session's model is used. The part carries
`metadata.hanse = "agent-resume"`; the client must exclude that marker from `classifyOmo` and from
`isVisibleRecordPart`, so it does not render as an OMO system card. A visible `resume_started` notice
appears instead. The synthetic text is deliberately model-visible so the agent knows why it is
continuing. Add a browser assertion that the resume prompt is not rendered as a system card.

Dispatch and outcome state machine:

- Before dispatch, in one transaction: set `resume_state=resuming`, `dispatch_state=prepared`, set
  `last_attempt_at`, and persist `resume_message_id`. Do **not** increment the visible attempt counter
  yet. Then call `sendPromptAsync`.
- On `204`, or when startup reconciliation finds the message id, run one conditional transaction:
  `UPDATE session_resume SET dispatch_state='sent',
   auto_attempts = auto_attempts + 1
   WHERE app_id=? AND session_id=? AND dispatch_state <> 'sent'`
  and check `changes()`. This is the only place the counter increments; a crash between statements is
  impossible because the state and counter change together. Then emit `resume_started` and wait for
  `session.status busy`/`retry` or an assistant message after `resume_message_id` while
  `resume_message_id` is still the **latest user message**. Use the message order/tail as the
  authoritative correlation; when the assistant's `parentID` is present it must not point to a newer
  user message, but strict equality is not required (opencode's documented rule is "parentID = last
  queued user message", and one assistant can answer several queued prompts). The phase-0 probe
  records the actual parentID with and without queued prompts.
- If a newer user message than `resume_message_id` appears (the operator sent a prompt during the
  resume), mark `resume_state=superseded`, release the cycle-reset exception/lease, and treat that
  user turn as a new cycle. It is not `completed` and must not consume the auto cap for the new turn.
- `busy`/`retry` or the tail-correlated assistant -> `resumed`; `completed` only after `resumed` and
  an observed `idle` with that assistant (not merely the resume user message or another user's
  assistant).
- A bare `idle` immediately after send is the pre-turn state and must not count as completion.
- `session.error` non-abort after the resume message and before any newer user message ->
  `failed`, `resume_failed` notice; no automatic retry. A later user-started error must not be
  attributed to the resume.
- Transport/timeout -> `dispatch_state=ambiguous` (not `failed`): the prompt may have landed. On
  startup, first fetch the deterministic message id / session tail:
  - message exists -> conditional `sent` update above, treat as accepted;
  - provably absent -> `dispatch_state=not_sent`; increment `auto_dispatch_retries`, **do not** count
    the confirmed attempt (`auto_attempts` stays unchanged); one automatic retry is allowed
    (`auto_dispatch_retries <= 1`), then `dispatch_state=failed`.
  - cannot prove (opencode unavailable) -> leave `ambiguous`, write `resume_failed`/notice.
- A `resuming` lease (recommended 2 minutes, extended while `busy`/`retry`) prevents a stuck row; on
  expiry -> `ambiguous`/notice, never a silent auto-loop.
- **No manual Resume mechanism (owner decision).** There is no `POST /resume` and no manual attempt
  budget. If auto-resume is skipped, failed, or the app is stopped, the notice tells the operator;
  they start/restart the app if needed and send a normal chat message (for example "Продолжай"), which
  is the existing chat send path with the full session context intact.

No child session is auto-resumed. A child is notified in its own feed; the parent notice says the
main turn was not stopped and the parent can re-invoke the task. If the parent is auto-resumed, its
continuation prompt names the interrupted child session ids (never titles) as untrusted data, or only
states that a subagent was interrupted.

### D7 - Subagent-to-parent signal

- On a child `session.error` with `MessageAbortedError` while the parent is alive, write a
  `subagent_interrupted` notice in the parent session and a child notice. The parent model already
  receives the task-tool error from opencode; do not duplicate it as a model-visible message.
- If the parent initiated the abort, reason `operator_abort`; no auto-resume. If the child was
  aborted unexpectedly, reason `subagent_abort`; the parent can retry. The parent turn is not
  aborted.
- On whole-process death, every active session (parent and children) gets `agent_stopped`; the
  parent additionally gets a `subagent_interrupted` rollup for each active child. This is the case
  where the parent was interrupted too; the notice is for the operator and the eventual resume.
- Parent resolution uses `parentID` from `listSessionsBounded` (or the context tracker's parent map);
  an unknown/expired parent yields a child-only notice. The event itself carries only the child
  `sessionID`. Child notices dedupe by `(app, childSession, kind, runtime_epoch)`; a graceful SIGTERM
  that emits child aborts before the process exits must not duplicate the whole-process rollup.

### D8 - Manual-stop semantics

The current code has no operator "stop" route; intentional stops are explicit restart and
application deletion, plus an external Docker stop/restart. The notice reason set covers
`process_exit`, `operator_restart`, `operator_stop`, `deletion`, `deployment`, `unknown_restart`, and
`unknown`. A process stop while no session is `busy`/`retry` creates no notice; there was no work in
progress. A user turn abort (`Stop`) is not a process stop
and keeps the existing `Stopped.` UX; it is recorded as `operator_abort` for subagent parent notices
only. External `docker stop` leaves the app stopped -> notice only, never auto-start; the cycle becomes
`skipped_stopped` and a later operator Start does **not** auto-resume it. The operator starts it and
sends a normal message if they want to continue. External `docker restart` produces a running new
epoch with no intent and auto-resumes under the owner decision.

## 5. Data model and API summary

Migration v20 adds:

- `instances.runtime_started_at TEXT`, `instances.runtime_restart_count INTEGER NOT NULL DEFAULT 0`,
  `instances.last_exit_code INTEGER`, `instances.last_oom_killed INTEGER NOT NULL DEFAULT 0
  CHECK (last_oom_killed IN (0,1))`, `instances.last_stop_reason TEXT`, `instances.last_stop_at TEXT`,
  `instances.applied_rule_hash TEXT`.
- `session_resume` with `PRIMARY KEY (app_id, session_id)`, `ON DELETE CASCADE` from `apps`,
  `CHECK` enums for `reason`/`resume_state`/`defer_reason`/`dispatch_state`, and
  `INDEX (app_id, resume_state, last_busy_seen_at)`. `auto_attempts` and `auto_dispatch_retries` are
  separate integers with `CHECK (>= 0)`; `dispatch_state` is
  `none|prepared|sent|ambiguous|not_sent|failed`; `resume_state` is
  `observing|resuming|resumed|completed|failed|ambiguous|superseded|deferred|skipped_stopped|skipped_stale|skipped_missing`.
- `session_notices` with `PRIMARY KEY (id)`, `UNIQUE (app_id, session_id, dedupe_key)`,
  `ON DELETE CASCADE` from `apps`, `CHECK (kind IN (...))`, `CHECK (json_valid(payload_json))`,
  `CHECK (length(payload_json) <= 4096)`, and `INDEX (app_id, session_id, created_at DESC, id)`.
- `session_notice_dedupe (app_id, session_id, dedupe_key, created_at,
  PRIMARY KEY (app_id, session_id, dedupe_key))`, retained across notice pruning and deleted by
  `deleteSessionChatRows`, parent-subtree cleanup, and app/session cascade.
- Update `test/migrations.test.ts` expected version 19 -> 20 (the file has multiple `19` assertions).
- Plan 0030 / journal 0036. The stage label is the plan number; journal numbering is independent
  (latest journal is 0035).

New/changed surfaces:

- `GET /api/apps/:app/sessions/:sid/notices` (human-only, DB only; client interleaves by timestamp).
- `GET /sessions`, `GET /messages`, and the app SSE no longer ensure a stopped app; they return a
  typed `agent_stopped`/503 and the client shows the cached feed/notices + a Start agent action.
- App SSE `notice.created`; auto-resume is internal (no HTTP route), with no manual Resume button.
- `RuntimeAppStatus` epoch/exit fields.
- Bash permission key plus `/agent` verification warnings.

No new npm dependency.

## 6. Security and failure analysis

- **Not a hard boundary.** The instruction and deny rules are guardrails. Wrappers/scripts/encodings
  bypass deny patterns; app-owned config/plugins, v1 `always` approvals, and v2 saved allow rules can
  widen the final ruleset; verification is startup-only and warning-only. The report must state this.
- **No model-context pollution from notices.** Notices live only in the coordinator DB and are
  rendered by the UI. The resume prompt is synthetic and visible to the model by design.
- **Idempotency.** The interruption-key guard, `session_notice_dedupe` (`changes() === 1` before
  inserting), deterministic resume message id, single conditional `sent` update, status/assistant
  check, and the one automatic attempt prevent duplicate notices/prompts. A transport timeout is `ambiguous`, not
  "not sent"; startup retry reconciles the message id before sending again. A `not_sent` attempt gets
  one bounded automatic retry (`auto_dispatch_retries`), then a notice. A process that crashes during
  resume produces a new interruption and does not loop automatically.
- **Deadlock/ordering.** Detection runs after the app lock is released or via a queue; the recovery
  service uses `ensure` and a bounded readiness retry; the status sample runs outside the app lock.
  DB write failures are logged and never break the event stream.
- **False positives.** A missed idle event on a network blip, graceful SIGTERM idle/error, or an
  external `docker restart` can look like an interruption. The design snapshots busy rows before an
  explicit stop, compares the live runtime epoch (not the stale `instances` row), applies the
  completed-tail/`observed_at` cutoff before any notice or resume, ignores monitor-stream closure as
  proof of death, and never auto-starts a stopped container. Unknown restarts after coordinator
  downtime are auto-resumed when running/ready and eligible.
- **Prompt injection.** Session titles and bounded error text are untrusted. Titles are not injected
  into the resume prompt; any UI text is rendered with `textContent`, not markdown/HTML.
- **Deletion races.** A notice or resume row must be deleted with its session; delete-if-empty and
  sweep must fail closed while a notice exists. A write checks the deletion marker/session existence
  under the session lock, and the sweep prunes orphan rows. App/project deletion cascades.
- **No-JS.** The chat feed already requires JavaScript; the notices route is JSON-only. This is an
  accepted limitation, matching the existing chat.

## 7. Verification plan

- Phase-0 live probe on pinned opencode 1.19.3: `GET /session/status` shape and idle absence; SIGTERM
  while busy (does it emit abort/idle?); custom `prompt_async` message id; `synthetic: true` text part;
  assistant `parentID`/tail behavior with and without queued prompts after a resume; child-session
  abort behavior and parent task tool result; `OPENCODE_CONFIG_CONTENT.instructions` with an absolute
  path under `XDG_STATE_HOME`. Record the results in the plan before implementation.
- Unit: policy shape/order/no catch-all; incident commands and process-group forms deny; legitimate
  commands not denied; `/agent` verification warnings for primary and subagent rulesets; version bump.
- Unit: instruction materialization/path/hash/overlay injection; restart-required hash change.
- Unit: runtime epoch classification; fresh-intent consumption; NULL-epoch baseline; notice
  idempotency/dedupe; resume eligibility (TTL from `observed_at`, completed-tail, top-level,
  newer activity, busy, missing session; operator restart and external restart both eligible);
  parent rollup; deletion/block predicates.
- Integration: fake runner status with a changed `StartedAt`/`RestartCount` and a fake opencode HTTP
  server for status/sessions/messages/prompt_async; assert notices and exactly one resume prompt.
  Cover: unexpected SIGTERM that emits idle/error; normal completion followed by a crash; monitor
  reconnect during normal completion; stale intent then crash; second interruption; cycle-reset
  suppression for the resume's own busy; a user prompt during a resume (superseded, new cycle);
  crash during resume; immediate idle before busy; missed idle; child-abort dedupe across monitor
  reconnect, coordinator restart, and notice pruning; operator stop not undone; parent Stop with
  active child; ambiguous dispatch with absent message id (one bounded auto retry, then notice) and
  with present message id (counted once); two-tab/auto race; startup catch-up for stopped and
  running-with-epoch-change apps; no auto-start for a stopped app; operator restart auto-resumes;
  stop -> operator start does not auto-resume; restart claim/deployment-lock deferred retry; read
  paths return agent_stopped and do not start; >30 min busy turn still resumable; parent+child notices
  coexist (app+session+dedupe uniqueness).
- Unit/browser: notice payload escaping, no model-context pollution, notice-only session not deleted,
  `sessionHasHistory` switch-away race; notices interleave by timestamp, render as a full-width break
  row, load with older history, and survive session switch/reload.
- Browser: chat QA scenario with a stop/restart notice break row, timestamp ordering, scroll-up
  notice pagination, and reload persistence; no Resume button.
- Gates: `npm run lint`, `npm run typecheck`, `npm test`, `npm run build`.

## 8. Non-goals

- seccomp/UID isolation, a PID-1 supervisor, or a change to the container restart policy;
- auto-resuming child/subagent sessions or replaying the exact interrupted tool call;
- automatic resume after a long downtime, deletion, or while the app is stopped;
- auto-starting an app whose container is stopped (including an external `docker stop`);
- a UI settings surface for TTL/attempts in this stage (constants are used; a setting is a follow-up);
- making the permission policy a security boundary.

## 9. Owner decisions (resolved 2026-10-27)

1. **Notice presentation** - visibly inside the ordinary chat log: a full-width "break" row with a
   horizontal rule and a label such as "Agent was restarted here", interleaved by timestamp with
   messages. Not a separate panel.
2. **Auto-resume trigger** - any restart, including an explicit operator restart and an external
   `docker restart`; the interruption reason is shown in the notice but does not block auto-resume.
   A stopped app is never auto-started; the operator starts it and sends a normal message.
3. **TTL and attempts** - 30 minutes from the last `busy` observation, one automatic attempt. No
   manual-attempt mechanic: if auto-resume is skipped or fails, the operator sends a normal chat
   message (for example "Продолжай") with the session context intact.
4. **Scope** - top-level sessions only; child/subagent sessions get a notice and are retried through
   the parent.
5. **Settings** - constants in this stage; a global setting/UI is a follow-up.

## 10. Design review

Round 1: `oracle`, 2026-10-27. Verdict: **FAIL**. Revision 2 addressed the 12 findings below.

Round 2: `oracle`, 2026-10-27. Verdict: **FAIL** (8 of 12 resolved, 4 partial). Revision 3 addressed
the 7 remaining blocking findings below.

Round 3: `oracle`, 2026-10-27. Verdict: **FAIL** (round-2 findings: 4 resolved, 3 partial).
Revision 4 addressed the 4 remaining blocking findings below.

Round 4: `oracle`, 2026-10-27. Verdict: **FAIL** (round-3 findings: (a) resolved, (b) partial,
(c) resolved, (d) resolved; one new edge each). Revision 5 addressed the 4 remaining blocking
findings below.

Round 5: `oracle`, 2026-10-27. Verdict: **FAIL** (round-4 findings: (a) partial, (b) partial,
(c) resolved, (d) resolved). Revision 6 addressed the 2 remaining blocking findings below.

Round 6: `oracle`, 2026-10-27. Verdict: **FAIL** (round-5 findings: (a) partial, (b) partial).
Revision 7 addresses the 2 remaining blocking findings below.

Round 1 blocking findings folded into the decisions above:

1. Graceful SIGTERM may clear busy markers; snapshot before delete, ignore shutdown terminal events
   while an epoch change is pending, dedupe child notices by epoch. See D3/D4/D7.
2. Resume cutoff used detection-time `interrupted_at`; switched to last busy `observed_at` plus a
   completed-tail check. See D4/D6.
3. Stop intent was never consumed; added fresh-intent consumption/window. See D3.
4. Resume dispatch was not crash-safe; added pre-dispatch transaction, `ambiguous` outcome, startup
   reconciliation, and a `msg_`+hex id. See D6.
5. Outcome machine could complete on the pre-turn idle; added busy/assistant/lease checks. See D6.
6. One attempts counter and no reset; split auto/manual, defined cycle reset and interruption-key
   guard. See D4/D5.
7. NULL epoch after upgrade caused false positives; added baseline skip. See D3.
8. External Docker stop/restart ambiguity; stopped containers are never auto-started; external
   restart is documented as an accepted unexpected restart. See D3/D8.
9. Child titles were injected into the resume prompt; titles are omitted/sanitized and the payload
   claim was corrected. See D5/D6.
10. `operator_abort` was not distinguishable; added a server-side abort tombstone. See D4.
11. Instruction path was ambiguous; pinned to `isolated.XDG_STATE_HOME/hanse/...` and added a probe.
    See D1.
12. Verification gaps; added a phase-0 live probe and transition tests. See section 7.

Non-blocking review notes folded in: v1 `always` caveat, process-group deny forms, safe-test cleanup
conflict, best-effort exit/OOM fields, deletion race, bounded-append wording, `textContent` UI
safety, monitor/status dependency, notice-only switch race, and per-session single-flight.

Round 2 blocking findings folded into revision 3:

1. Unexpected SIGTERM had no "epoch change pending" trigger; added the 5 s terminal confirmation
   rule using `/session/status` + a live readiness probe, independent of the probe result. See D3/D4.
2. The cycle reset cleared the resume's own busy state; added the `resume_state=resuming` exception.
   See D4.
3. `ambiguous` retry conflicted with the auto-attempt cap; added `dispatch_state` and counters that
   increment only on confirmed dispatch/startup discovery, with a refund/not-sent path. See D6.
4. Pre-turn idle could complete the resume; completion now requires `resumed` plus a new assistant
   message, not the resume user message. See D6.
5. Child-abort dedupe key had no storage; added `dedupe_key` + `session_notice_dedupe` retained across
   notice pruning. See D5.
6. A stopped app could miss the notice and manual Resume behavior was undefined; added the startup
   catch-up pass and explicit manual consent to start a stopped app. See D3/D6.
7. `operator_abort` tombstones did not cover a parent Stop's child abort; tombstone matching now walks
   ancestors. See D4.

Non-blocking round-2 notes folded in: auto-resume only on `running` + readiness (not `starting`);
rewrite/verify the instruction on the reconnect path; persist the operator-stop notice before
`runtime.delete`; run the status sample outside the app lock; share `sessionLocks` between the auto
service and the manual route.

Round 3 blocking findings folded into revision 4:

1. `session_notice_dedupe` could not enforce exactly-once: added `session_id`, app-scoped unique
   scope, transactional `changes() === 1` guard, and deletion in `deleteSessionChatRows`/subtree.
   See D5/§5.
2. `dispatch_state` idempotency and `not_sent` retry were unbounded: one conditional
   `UPDATE ... WHERE dispatch_state <> 'sent'`, plus per-source retry counters and a one-retry then
   manual transition. See D6/§5.
3. The 5 s confirmation used stream closure and a stale epoch, and notices skipped the completed-tail
   check: removed stream closure, compare live `runtime.status`, clear when the tail was complete,
   and apply the cutoff to notices. See D3/D5.
4. The cycle-reset exception could attribute a concurrent user turn to the resume: require the resume
   message to be the last user message, match only `parentID = resume_message_id`, and mark
   `superseded` on a newer user message. See D4/D6.

Non-blocking round-3 notes folded in: reconnect rewrite restores the applied rule content/hash;
`unknown_restart` added to the reason enum; running unknown-restart notice path; `ensure` is called
without an outer app lock; the owner questions are the only remaining forks.

Round 4 blocking findings folded into revision 5:

1. NULL/uncertain `session_resume` epoch: persist the live epoch in the busy upsert; if NULL, use the
   live epoch as the baseline/status+tail fallback. See D3.
2. `dispatch_retries` mixed auto/manual budgets: split into `auto_dispatch_retries` and
   `manual_dispatch_retries`, each capped at one before manual/failed. See D6/§5.
3. Applied rule content/hash was not in the data model: added `instances.applied_rule_hash` plus the
   `agent-process-rules.applied.md` sidecar and the reconnect/explicit-restart rules. See D1/§5.
4. Strict assistant `parentID` equality was unverified against opencode's "last queued user message"
   rule: switched to message-order/tail correlation with `parentID` as corroboration, and added the
   queued-prompt probe. See D6/§7.

Round 5 blocking findings folded into revision 6:

1. The new-cycle reset omitted `dispatch_state`, `auto_dispatch_retries`, and
   `manual_dispatch_retries`, leaking a spent retry budget into the next cycle. Added all three to
   the reset. See D4.
2. The unknown/NULL busy-epoch fallback could use the post-restart live epoch as the pre-crash
   baseline. Pinned the rule: unknown epoch + unfinished/absent tail preserves the marker; clear only
   on a complete tail or an actively running session. See D3.

Non-blocking round-5 notes folded in: sidecar missing/tamper fallback (restore current rule, mark
Restart required, log integrity failure), coordinator-DB/non-agent-writable applied content option,
sidecar → active file → DB write order with startup repair, and the process-interruption
`changes()`/transaction clarification. See D1/D5/§6.

Round 6 blocking findings folded into revision 7:

1. The cycle reset set `dispatch_state=prepared`, conflating a normal user turn with a resume
   dispatch. Added `none`; the reset uses `none`, and `prepared` is reserved for the pre-dispatch
   transaction. See D4/§5.
2. The unknown-epoch clear branch could clear an active session. Pinned the three cases: busy/retry
   preserves; idle/absent + complete tail clears; idle/absent + unfinished/absent tail preserves.
   See D3.

The sidecar exception was reworded as an explicit safety exception. Round 7: `oracle`, 2026-10-27.
Verdict: **PASS**; design gate cleared subject to owner answers.

Revision 8 applies the owner answers collected on 2026-10-27: notices render interleaved inside the
ordinary chat log as full-width break rows; auto-resume triggers on any restart, including operator
and external restarts; TTL 30 minutes; one automatic attempt; no manual Resume mechanism (the operator
sends a normal message); top-level sessions only; constants, no settings UI. This is a material UI and
scope change. Focused review round 8: `oracle`, 2026-10-27. Verdict: **FAIL** with 7 blocking
findings (read paths auto-start, deferred retry, stop->start auto-resume, long-busy TTL, interleaved
renderer, parent+child notice uniqueness, synthetic prompt OMO card). Revision 9 addresses all seven:

1. Read paths (`/sessions`, `/messages`, app SSE) use `endpointFor` and return `agent_stopped` without
   starting; automatic reconnect/hydration cannot undo a stop; explicit Start/Send is required.
2. Restart-claim and deployment-lock blocks become `resume_state=deferred` with `defer_reason`, retried
   by the reconciler and startup catch-up after the block clears.
3. Stopped interruptions become terminal `skipped_stopped`; a later operator Start does not auto-resume.
4. `last_busy_seen_at` is refreshed on every busy/retry sample; TTL no longer breaks for >30 min turns.
5. The client feed gets a merged message+notice render list; `.feed-notice` is preserved by
   `syncMessageOrder`, empty/count/anchor logic includes notices, and notice-only sessions render.
6. `session_notices` uniqueness is `(app_id, session_id, dedupe_key)`, so parent and child notices can
   coexist.
7. The resume synthetic part carries `metadata.hanse=agent-resume`, is excluded from `classifyOmo`/
   visible parts, and has a browser assertion that it does not render as a system card.

Non-blocking round-8 notes folded in: R5/R6 wording now matches any-restart; sweep gets a
notice-orphan pass; `notice.created` has a DB-only refresh fallback on stream error/pause.

Focused review round 10: `oracle`, 2026-10-27. Verdict: **PASS**. Both round-9 findings resolved;
design gate cleared. Non-blocking notes: legacy session SSE still calls `ensure` (unused by the current
client; include or deprecate), `/context` current-state claim is inaccurate (GET is already
non-starting), pin the grace above Docker stop timeout + startup and decide startup catch-up behavior,
define the no-URL DB session response, and align `agent_stopped` with `agent_not_running`.

Focused review round 9: `oracle`, 2026-10-27. Verdict: **FAIL** with 2 blocking findings: (1) all
chat read endpoints (including `/prompts`, `/saved-permissions`, `/todo`) must use the non-starting
resolver, and reload-while-stopped needs a URL/DB shell + notices + Start; (2) a transient stopped
sample must not terminalize an operator/external/deployment restart. Revision 10 applies both:
read-path coverage + reload shell, and restart/deploy precedence with a grace/re-probe before
`skipped_stopped`. Non-blocking notes folded in: `agent_stopped` handler alignment, message-count vs
merged order, full-render cleanup, notice-cursor trigger, deferred TTL/`defer_reason` cleanup.

Re-review is required before the plan gate.
