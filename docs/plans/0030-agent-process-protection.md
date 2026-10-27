# Plan 0030 - Agent process protection

Status: **deployed** - plan review (`momus`) OKAY; journal 0037; commit `25e5c81`.
Design: [Agent process protection](../design/agent-process-protection.md) (approved, `oracle`
round 10 PASS).
Owner decisions: [open questions](../open-questions.md), 2026-10-27.
Scope: a persistent safe-test instruction, narrow bash self-kill denies with `/agent` verification,
runtime-epoch stop detection, persisted chat notices, subagent-to-parent signals, recency-guarded
top-level session auto-resume, and non-starting chat read paths.
Non-goals: a settings UI, a manual Resume route/button, auto-starting a stopped app, child-session
auto-resume, seccomp/UID isolation, a general process supervisor, and deployment.

## Bindings

- Design author: maintainer; design reviewer: `oracle` (round 10 PASS).
- Plan author: maintainer; plan reviewer: `momus`.
- Design index: `docs/design/README.md`; plan index: `docs/plans/README.md`; journal index:
  `docs/journal/README.md`; open questions: `docs/open-questions.md`.
- Language: English for docs, code comments, and notices.
- Verification: `npm run lint`, `npm run typecheck`, `npm test`, `npm run build`, and
  `npm run check:sensitive`.
- Commit policy: one coherent stage commit, only after the owner explicitly authorizes it. Do not
  commit, push, or deploy without that authorization.
- No new npm dependencies.

## Owner decisions (closed)

1. Notices render inside the ordinary chat log as full-width break rows, interleaved by timestamp.
2. Auto-resume on any restart, including operator restart and external `docker restart`; the reason
   is shown but is not a skip reason. A stopped app is never auto-started.
3. TTL is 30 minutes from `last_busy_seen_at`; one automatic attempt.
4. No manual Resume route/button/attempt budget; the operator sends a normal message to continue.
5. Top-level sessions only; constants in this stage; no settings UI.

No open questions remain for this stage.

## Phase 0 - Runtime probes and decisions

### Boundaries

In scope: disposable test-state probes of opencode 1.19.3 and the runner; recording results in the
journal. No production code and no committed fixture data.
Out of scope: changing the design, the launcher, or the image.

### Work

Use a disposable app under a temporary `XDG_STATE_HOME`, a test token, and a free port. Never use
production apps or deployment secrets. Record exact commands and outcomes in the eventual journal;
redact host-specific values.

1. **Absolute instruction path.** Write a sentinel rule file at
   `<XDG_STATE_HOME>/hanse/agent-process-rules.md`, pass its absolute container-visible path in
   `OPENCODE_CONFIG_CONTENT.instructions`, start opencode, and confirm the sentinel is loaded in the
   agent instruction context (or `opencode debug config`/the first system message). If it is not
   loaded, stop and ask the owner before implementation; this is a design precondition.
2. **SIGTERM events.** With an active turn, send SIGTERM to opencode and record whether it emits
   `session.error` `MessageAbortedError`, `session.status` `idle`/`error`, neither, or both. The
   design's SIGTERM rule applies regardless; record which path is live.
3. **Caller-supplied message id.** Send `prompt_async` with a deterministic `msg_...` id and confirm
   the stored user message uses it. If not honored, use the design fallback: server-generated id +
   pre-dispatch sentinel.
4. **Assistant `parentID` with queued prompts.** Send a second prompt while the first is running and
   record the assistant `parentID`. If it is not the last queued user message, keep the design's
   tail-correlation rule.
5. **Docker inspect fields.** Record `State.StartedAt`, `State.FinishedAt`, `State.ExitCode`,
   `State.OOMKilled`, and top-level `RestartCount` from a stopped and a restarted container.

### Acceptance criteria

- Every probe has a recorded result and a chosen implementation path (design default or documented
  fallback).
- A failed absolute-instruction probe blocks Phase A with an owner question, not a silent workaround.
- No production state, secret, or real project data is touched.

### Verification

Manual disposable probe; journal entry with redacted evidence. No code gates for this phase.

## Phase A - Schema v20, persistent rule, and bash policy

### Boundaries

In scope: migration v20, the process-rule file materializer, the `bash` permission overlay and
verification, manager wiring for the rule file and applied hash, and tests.
Out of scope: runtime epoch detection, notices, resume, and no-start reads.

### Invariants

- Migration v20 is forward-only and idempotent through the migration runner. Existing rows get NULL
  runtime fields and are treated as an unknown baseline; no upgrade synthesizes notices.
- The rule file is at
  `<per-app XDG_STATE_HOME>/hanse/agent-process-rules.md`, outside the app repository, and is
  passed as an absolute container-visible path after any app-specific `instructions`.
- The active rule file and the applied sidecar are written atomically (temp file + rename) with mode
  `0600`; the sidecar is `agent-process-rules.applied.md`.
- `applied_rule_hash` is the hash of the content actually applied on the last explicit start. A
  reconnect restores the applied sidecar only when its hash matches `applied_rule_hash`; otherwise
  it restores the current code rule, leaves the applied hashes unchanged, logs a bounded integrity
  warning, and keeps the app `Restart required`.
- `settingsHashFor` includes the process-rule hash; changing the rule marks running apps `Restart
  required` exactly like a policy-version bump.
- `ATTACHMENTS_POLICY_VERSION` becomes 3.
- The bash policy is deny-only, has no `"*"` entry, and contains exactly the design D2 probes:
  `pkill *opencode*`, `killall *opencode*`, `kill 1`, `kill -9 1`, `kill -KILL 1`, `kill -TERM 1`,
  `kill -15 1`, `kill -s KILL 1`, `kill -s TERM 1`, `kill -1`, `kill -- -1`, `kill -s KILL -1`,
  `kill 0`.
- `/agent` verification requires every non-hidden agent, including subagents, to resolve every bash
  probe to `deny`; hidden agents remain skipped. Warnings are deterministic and warning-only.
- No behaviour is enabled for a stopped app; this phase only writes files and policy.

### Work

1. `src/store/migrations.ts`: add **v20** `agent-process-protection`:

   ```sql
   ALTER TABLE instances ADD COLUMN applied_rule_hash TEXT;
   ALTER TABLE instances ADD COLUMN runtime_started_at TEXT;
   ALTER TABLE instances ADD COLUMN runtime_restart_count INTEGER;
   ALTER TABLE instances ADD COLUMN last_exit_code INTEGER;
   ALTER TABLE instances ADD COLUMN last_oom_killed INTEGER CHECK (last_oom_killed IN (0, 1));
   ALTER TABLE instances ADD COLUMN last_stop_reason TEXT;
   ALTER TABLE instances ADD COLUMN last_stop_at TEXT;

   CREATE TABLE session_resume (
     app_id TEXT NOT NULL REFERENCES apps(id) ON DELETE CASCADE,
     session_id TEXT NOT NULL,
     parent_session_id TEXT,
     observed_status TEXT NOT NULL CHECK (observed_status IN ('busy', 'retry')),
     observed_at TEXT NOT NULL,
     last_busy_seen_at TEXT NOT NULL,
     interrupted_at TEXT,
     interruption_epoch TEXT,
     interruption_key TEXT,
     reason TEXT,
     runtime_started_at TEXT,
     runtime_restart_count INTEGER,
     resume_state TEXT NOT NULL DEFAULT 'observing'
       CHECK (resume_state IN ('observing','resuming','resumed','completed','failed','ambiguous','superseded','deferred','skipped_stopped','skipped_stale','skipped_missing')),
     defer_reason TEXT,
     dispatch_state TEXT NOT NULL DEFAULT 'none'
       CHECK (dispatch_state IN ('none','prepared','sent','ambiguous','not_sent','failed')),
     auto_dispatch_retries INTEGER NOT NULL DEFAULT 0,
     auto_attempts INTEGER NOT NULL DEFAULT 0,
     last_attempt_at TEXT,
     resume_message_id TEXT,
     last_error TEXT,
     created_at TEXT NOT NULL,
     updated_at TEXT NOT NULL,
     PRIMARY KEY (app_id, session_id)
   );
   CREATE INDEX session_resume_due
     ON session_resume(resume_state, last_busy_seen_at);

   CREATE TABLE session_notices (
     id TEXT PRIMARY KEY,
     app_id TEXT NOT NULL REFERENCES apps(id) ON DELETE CASCADE,
     session_id TEXT NOT NULL,
     parent_session_id TEXT,
     dedupe_key TEXT NOT NULL,
     kind TEXT NOT NULL CHECK (kind IN ('agent_stopped','subagent_interrupted','resume_started','resume_failed','resume_completed','resume_unavailable')),
     reason TEXT,
     payload_json TEXT NOT NULL CHECK (json_valid(payload_json) AND length(payload_json) <= 4096),
     created_at TEXT NOT NULL,
     UNIQUE (app_id, session_id, dedupe_key)
   );
   CREATE INDEX session_notices_page
     ON session_notices(app_id, session_id, created_at DESC, id);

   CREATE TABLE session_notice_dedupe (
     app_id TEXT NOT NULL REFERENCES apps(id) ON DELETE CASCADE,
     session_id TEXT NOT NULL,
     dedupe_key TEXT NOT NULL,
     created_at TEXT NOT NULL,
     PRIMARY KEY (app_id, session_id, dedupe_key)
   );
   ```

   The `reason` values are validated in the store, not by a DB CHECK, so the bounded enum can grow
   without a migration. `payload_json` is written as `'{}'` when empty; the store enforces the 4 KiB
   cap and bounded structured fields.

2. New `src/opencode/process-rules.ts`:
   - `PROCESS_RULES_VERSION = 1`.
   - `PROCESS_RULE_TEXT` with the exact D1 content (never signal opencode; no
     `pkill`/`killall`/`kill` against opencode; safe separate-instance testing; report a stuck server
     to the operator).
   - `PROCESS_RULE_HASH = sha256(PROCESS_RULE_TEXT)`; stable, lowercase hex.
   - `processRulePath(env)`, `processRuleAppliedPath(env)`,
     `writeProcessRule(env, content)`, `readProcessRule(env)`, `restoreAppliedRule(env, appliedHash)`,
     `hashFileContent(text)`.
   - `writeProcessRule` uses `mkdirSync(..., {recursive:true, mode:0o700})`, a `.tmp-<uuid>` file,
     `chmod 0600`, `renameSync`; the applied sidecar is written the same way on an explicit start.

3. `src/opencode/policy.ts`:
   - Add `bash: PermissionRules` to `PermissionPolicy` and `BASH_DENY_PATTERNS` as a readonly
     constant.
   - Build `bash` from the constant in `buildPermissionPolicy`; do not add a catch-all.
   - Bump `ATTACHMENTS_POLICY_VERSION` to 3.
   - Add `BASH_DENY_PROBES` and `bashProbes?: string[]` to `VerifyPolicyOptions`.
   - Extend `evaluateAgentPolicy` to check every non-hidden agent's `bash` rules for every probe and
     emit `agent "<name>": bash does not deny "<probe>"`.
   - Keep the existing `policy_unverified` hiding and `/prompts` warning path.

4. `src/opencode/manager.ts`:
   - `settingsHashFor(snapshot, profile, skillsHash?, providersHash?, ruleHash?)` includes
     `ruleHash` when defined; update both call sites (`#ensureLocked`, `#pendingRestartFor`) and test
     helpers.
   - In `#ensureLocked`, after `resolveInstanceEnv`, write the current process rule (active +
     applied sidecar) before building the overlay; append `processRulePath(isolated)` after
     `app.instructions` in `buildConfigOverlay({instructions})`.
   - Persist `applied_rule_hash` in `#recordStatus`/the instances upsert on an explicit start; keep
     it unchanged on reconnect.
   - On the early reconnect path, restore the applied sidecar when it matches
     `instances.applied_rule_hash`; otherwise restore the current rule, leave applied hashes
     unchanged, and log `process_rule_integrity_failed` with only the app id and a bounded reason.
   - `#pendingRestartFor` compares the same rule hash so an upgrade shows `Restart required`.
   - Pass the rule path through the app spec/environment as needed; do not mount it read-only in this
     phase.

5. `src/opencode/instance.ts`: no new overlay key; assert the absolute path is preserved in
   `instructions` and the overlay byte guard still applies.

6. Tests:
   - `test/permission-policy.test.ts`: bash rules are deny-only; every probe denied for a normal
     primary and a subagent; hidden agents skipped; a widened allow produces the deterministic
     warning; no broad `kill *` deny; policy version 3.
   - `test/process-rules.test.ts`: content/hash stability; atomic write and mode; sidecar restore
     match/mismatch; no app-repository write.
   - `test/instance.test.ts` / `test/manager.test.ts`: absolute instruction path appended after
     app-specific instructions; rule hash changes `settingsHashFor`/pending restart; start writes
     active + sidecar + applied hash; reconnect with a valid sidecar restores applied content;
     missing/mismatched sidecar restores current content and keeps restart required.
   - `test/migrations.test.ts`: v20, versions `[1..20]`, new columns/tables and constraints, a
     v19→v20 upgrade with no data rewrite, and the existing future-version/known/max/applied-count
     assertions updated. Update `test/settings-store.test.ts`/`test/http.test.ts` schema-version
     expectations.

### Acceptance criteria

- A fresh database is at v20; a v19 database gains only the new columns/tables.
- A new start writes the rule file and appends its absolute path; the applied sidecar/hash match.
- A code-rule change marks a running app `Restart required`; a Docker auto-restart before the
  explicit restart does not silently apply a new code rule when a trusted sidecar exists.
- Every non-hidden agent resolves all bash probes to `deny`; warnings are visible through the
  existing policy path.
- No detection, notice, resume, or read-path behavior is enabled yet.

### Verification

```bash
npx vitest run test/permission-policy.test.ts test/process-rules.test.ts test/instance.test.ts test/manager.test.ts test/migrations.test.ts test/settings-store.test.ts
npm run typecheck
npm run lint
```

## Phase B - Runtime epoch, active turns, notices, and detection

### Boundaries

In scope: runtime status fields, epoch/intent persistence, `session_resume`/notice stores, monitor and
status sampling, stop classification, SIGTERM handling, subagent signals, the DB-only notices API,
and `notice.created` SSE. No resume dispatch and no chat UI yet.
Out of scope: resume attempts, no-start read paths, reload shell, and notice rendering.

### Invariants

- A migration v20 row with `runtime_started_at IS NULL` is a baseline: record the first observed
  epoch and do not synthesize an interruption.
- An epoch is `(runtime_started_at, runtime_restart_count)`; a Docker `StartedAt`/`RestartCount`
  change is the authoritative restart signal. The reconciler's persisted row may be up to one tick
  stale; live status wins for confirmation.
- `#stopLocked` records the reason (`restart`, `stop`, `delete`) and `last_stop_at` before deleting
  the container; the intent is consumed atomically when the new epoch is recorded. An intent older
  than 10 minutes or older than the previous runtime start is stale and must not suppress a later
  crash.
- Detection runs outside the app lock (or is enqueued) and never calls `ensure`; it may read runtime
  status and session status.
- A session is active only while `busy`/`retry`; every successful busy/retry sample refreshes
  `last_busy_seen_at`. Terminal `idle`/`error` sets `terminal_pending_at` and is confirmed after 5 s
  with `GET /session/status` and live runtime status. A completed tail clears; an unfinished tail
  with a changed/failed epoch preserves the marker.
- A process stop with no active session writes no notice. A completed-turn tail at the interruption
  cutoff writes no interruption notice. Session titles are never stored in notices or injected into
  the resume prompt; only coordinator-generated ids and bounded reasons/child ids are used.
- The startup catch-up stopped branch uses the same grace/re-probe and restart/deploy precedence as
  the live reconciler. A transient external restart during coordinator downtime must not be turned
  into a terminal notice when the new epoch appears within the grace.
- Notices are deduped in the same transaction as the interruption update: `session_resume` key
  change authorizes the interruption, `session_notice_dedupe` insert authorizes the notice. The
  dedupe key includes the runtime epoch and cycle; child keys include the child session and epoch.
- `GET /sessions/:sid/notices` is DB-only, authenticated, bounded, and never calls `ensure`.
- `notice.created` is a typed app SSE event; every notice is also recoverable by the notices API.

### Work

1. `src/agent/protocol.ts`: add `startedAt?: string | null`, `restartCount?: number`,
   `exitCode?: number | null`, `oomKilled?: boolean`, `finishedAt?: string | null` to
   `RuntimeAppStatus`; `stoppedStatus` returns null/zero defaults. Add the same fields to
   `HostStatusPayload` where available.
2. `src/runner/docker.ts` / `src/runner/server.ts`: add top-level `RestartCount` and
   `State.OOMKilled` to `DockerContainerInspect`; map all fields in `statusFromInspect`; map the B0
   host status with `restartCount: 0` when unknown. Preserve existing container/state semantics.
3. `src/opencode/client.ts`: add `listSessionStatuses(endpoint)` for `GET /session/status`
   (bounded/timeout, tolerant of absent entries) and export it. Keep `sendPromptAsync` unchanged for
   this phase. Add the server-side abort tombstone in the abort route (`src/http/chat.ts`): record
   `(app, session, now)` before calling opencode, bounded to 30 seconds, and pass the tombstone to
   recovery for ancestor-aware `operator_abort` classification. The tombstone is never trusted from
   the client.
4. New `src/opencode/recovery.ts` (or `src/chat/process-recovery.ts`; one module):
   - `SessionResumeStore` with `upsertBusy`, `sampleBusy`, `markInterrupted`, `setResumeState`,
     `setDeferReason`, `listEligible`, `listDeferred`, `deleteSessionRows`.
   - `SessionNoticeStore` with `record` (transactional dedupe + 50-row cap), `list` (before/limit),
     `prune`, `deleteSessionRows`.
   - `ProcessRecovery` with injected `db`, `runtime`, `endpointFor`, `isRestarting`,
     `deploymentLock`, `sendPromptAsync` (unused in this phase), `statusForSession`,
     `listSessions`, `now`, `logger`, `onNotice`.
   - `observeSessionStatus(app, {sessionID, status, parentID?})`: busy/retry upsert and
     `last_busy_seen_at` refresh; terminal pending/confirmation timer; parent resolution via a
     per-app cached `listSessionsBounded` map.
   - `observeRuntime(appId, previous, current)`: baseline/epoch comparison, intent classification,
     notice writes, subagent rollup, and a `resume` callback scheduled only after the current lock
     is released (Phase C).
   - `recordStopIntent(appId, reason)`: mark all active sessions interrupted and persist notices
     before `runtime.delete`; dedupe by cycle/epoch. Notice writes check the deletion marker and
     upstream session existence under the existing session lock; orphan rows are left for the sweep.
   - `handleChildAbort(app, childSessionID, parentID, epoch, reason)`; the 30-second server-side
     abort tombstone (keyed by app/session/time) classifies `MessageAbortedError` as
     `operator_abort` when the session or an ancestor matches, otherwise `subagent_abort`.
   - `startupCatchUp()`: the design D3 bounded pass; deferred rows retried; `skipped_*` ignored;
     stopped rows use the grace/re-probe and restart/deploy precedence before a notice/terminal.
   - `reconcile()`: TTL/stopped grace/deferred/lock retries; no auto-start. A deferred row whose
     TTL expires becomes `skipped_stale`; `defer_reason` is cleared on resume/cycle reset.
   - `stop()`: clear timers.
5. `src/opencode/manager.ts`:
   - Add the recovery dependency/construction and expose `isRestarting`/`deploymentLock` to it.
   - `#recordStatus` reads the previous epoch, writes `runtime_*`, exit/OOM fields, consumes a
     fresh stop intent, and calls `recovery.observeRuntime` after the DB write.
   - `#recordStatusById` updates the same fields; preserve `runtime_started_at` when the runtime
     reports no new epoch.
   - `#stopLocked(appId, reason)`: call `recovery.recordStopIntent` before `runtime.delete`, store
     `last_stop_reason`/`last_stop_at`, and update all callers (`stopApp` -> `stop`,
     `stopForDeletion` -> `delete`, `#restartLocked` -> `restart`).
   - `#startMonitor`: forward every `session.status` and `session.error` event to recovery.
   - Status sampler: on each reconciler tick, for every running app, sample
     `listSessionStatuses(endpoint)` outside the app lock and call `recovery.observeSessionStatus`;
     on monitor reconnect/`status.ready`, call it once immediately.
   - `resumeRunning`/startup: after reconnecting running apps, call `recovery.startupCatchUp()` once;
     start/stop the recovery service with the manager lifecycle.
6. `src/opencode/events.ts`: add
   `{ type: "notice.created"; notice: SessionNoticeView }` to `HanseEvent`; keep the typed event
   under the existing byte budget. `src/http/prompts.ts`: emit it from the manager notice
   subscription through the current app SSE attach path. Phase C changes that attach path to be
   non-starting; Phase B does not change read-path behavior.
7. `src/http/chat.ts`: add `GET /api/apps/:app/sessions/:sid/notices` with `limit`/`before`,
   human auth, app lookup/deletion checks, and a DB-only bounded response
   `{notices, nextCursor}`. Add the route match before the runtime endpoint resolution.
8. `src/chat/state.ts`: `deleteSessionChatRows` deletes `session_notices`,
   `session_notice_dedupe`, and `session_resume`; `localSessionBlockReason` gains `has_notice`;
   parent-subtree cleanup covers all ids.
9. `src/chat/sweep.ts`: add the notice-orphan pass (probe upstream existence first) so a notice-only
   session can be swept when the upstream session vanished; preserve current block-before-probe
   behavior for live sessions.
10. Tests:
    - `test/runtime-status.test.ts` / runner tests: field mapping, stopped defaults, host fallback.
    - `test/session-resume.test.ts`: busy refresh, transition reset, TTL, interrupted-key
      idempotency, deferred/stopped/stale/missing transitions, delete cleanup.
    - `test/session-notices.test.ts`: `SessionNoticeView` shape (bounded id/session/parent/kind/
      reason/payload/createdAt), transactional dedupe, cap-50 pruning with dedupe evidence,
      parent+child uniqueness, payload bounds, list pagination, deletion/cascade.
    - `test/process-recovery.test.ts`: baseline skip, epoch change classifications, operator
      stop/restart/deletion, external restart, deployment defer, stopped grace/re-probe, SIGTERM
      idle/error, completed-tail cutoff, child abort with/without an operator/ancestor tombstone,
      notice existence/deletion checks, startup catch-up including a slow external restart across
      coordinator downtime, deferred TTL.
    - `test/manager.test.ts`: stop reason persistence, intent consumption/staleness, status sampler
      outside lock, monitor event forwarding, no `ensure` from detection.
    - `test/http.test.ts`/`test/chat-page.test.ts`: notices route auth/bounds/no runtime, deletion,
      notice-only session, SSE event.

### Acceptance criteria

- A v19 upgrade with running sessions writes no notices/resumes on the first observation.
- An operator restart produces one operator-restart notice per active session; a process crash
  produces one `agent_stopped`; a child abort produces one parent and one child notice.
- A normal completion followed by a crash produces no interruption notice.
- A stopped app is never started by detection, status sampling, notices, or startup catch-up.
- Notices survive coordinator restart and are readable while the app is stopped.
- Dedupe survives the 50-notice cap and parent/child notices do not collide.

### Verification

```bash
npx vitest run test/runtime-status.test.ts test/session-resume.test.ts test/session-notices.test.ts test/process-recovery.test.ts test/manager.test.ts test/http.test.ts test/chat-page.test.ts
npm run typecheck
npm run lint
```

## Phase C - Resume, non-starting reads, and chat UI

### Boundaries

In scope: resume eligibility/dispatch/outcome state machine, no-start read endpoints, notice
rendering/interleaving, reload-while-stopped shell, Start affordance, and browser QA.
Out of scope: manual resume, child auto-resume, settings UI, and start-on-read.

### Invariants

- Only a top-level session with a `busy`/`retry` cycle, a running/ready app, an unfinished tail, and
  no newer message is resumed. TTL 30 minutes; one `auto_attempts`.
- No resume calls `ensure`. A `starting` app is polled via `runtime.status`/readiness; if it is not
  running within the bounded wait, the notice remains.
- Resume uses the exact synthetic prompt, deterministic `msg_` id (or the documented fallback), and
  `parts: [{type:"text", text, synthetic:true, metadata:{hanse:"agent-resume"}}]`. The prompt may
  name interrupted child session ids as bounded untrusted data or only state that a subagent was
  interrupted; it never includes titles or notice payloads.
- Before dispatch: `resuming` + `prepared` + `last_attempt_at` + `resume_message_id` in one
  transaction. On 204/accepted: conditional `sent` + `auto_attempts + 1`; the counter increments
  only there. Transport ambiguity is `ambiguous`, never a silent retry loop; one confirmed-not-sent
  retry is allowed. Lease 2 minutes, extended while busy/retry.
- A newer user message after `resume_message_id` marks `superseded`, releases the exception, and
  does not consume the new turn's cap. A bare idle after send is not completion. `completed` only
  after `resumed` and an observed idle with the correlated assistant.
- Every chat read endpoint uses a non-starting resolver: `/sessions`, `/messages`, app SSE,
  `/prompts`, `/saved-permissions`, `/todo`, `/context`, and the legacy session SSE
  (`/sessions/:sid/events`) is either converted or explicitly marked deprecated. On no endpoint,
  return `agent_stopped`/503; never `ensure`.
- Sending a message and the explicit Start action remain the only ways a stopped app starts.
- On reload while stopped, the client renders a shell from the URL session id or a DB-only summary,
  fetches notices, and offers Start; it does not clear the thread or pretend the app is running.
- Notices merge with messages by `created_at`/id in the ordinary feed; `.feed-notice` rows are
  full-width break rows. `messageCountLabel` counts messages only. `resetFeedDom`,
  `saveCurrentRuntime`, `adoptRuntime`, `renderDirty`, `syncMessageOrder`, and scroll anchors handle
  notices. The resume synthetic part is excluded from `classifyOmo`/visible parts and shown only as
  `resume_started`.
- A notice-only session has history and is not empty.

### Work

1. `src/opencode/recovery.ts`: implement `ResumeService` (or methods on `ProcessRecovery`):
   - eligibility: parent absent, state busy/retry, TTL, newer-message/tail cutoff, busy/retry status,
     `auto_attempts`, single-flight, restart claim/deployment deferral before stopped, stopped
     grace/re-probe, stopped/missing/stale terminals.
   - dispatch: deterministic id, synthetic part, prepared/sent/ambiguous state, lease, context
     correlation, outcome notices (`resume_started`, `resume_completed`, `resume_failed`,
     `resume_unavailable`).
   - startup reconciliation: resolve `prepared`/`ambiguous` by fetching the deterministic id/tail;
     one confirmed-not-sent retry; no loop.
2. `src/opencode/manager.ts`: call resume only after the app lock is released; use
   `runtime.status`/readiness, never `ensure`; expose the dispatch dependency to the recovery
   service; ensure a shutdown stops timers and leaves rows recoverable.
3. `src/http/chat.ts`:
   - Replace `withReadEndpoint`'s `ensure` fallback with a non-starting `AgentStoppedError` mapped
     to 503 `{error:"agent is stopped", code:"agent_stopped"}`; use `manager.endpointFor` only.
   - `readSessionsResponse`/`readMessagesResponse`: on no endpoint, return `agent_stopped`; keep
     deletion/404 behavior. Add a DB-only session summary shape for the reload shell if the client
     cannot use the URL id.
   - App SSE and legacy session SSE: no `ensure`; return `agent_stopped` with no stream.
   - Align `agent_stopped` with the existing `agent_not_running` client handling.

   `src/http/prompts.ts`:
   - `/prompts`, `/saved-permissions`, `/todo`: resolve only for read kinds with `endpointFor`; fall
     back to `agent_stopped`; mutation kinds (question/permission replies) keep explicit `ensure`.
   - App SSE (`streamAppEvents`) uses the same non-starting resolver and returns `agent_stopped` when
     no endpoint is attached.
4. `assets/chat-core.js`/`assets/chat.js`:
   - Add the notice map/order/cursor, merge/sort, `.feed-notice` renderer, empty/notice-only state,
     count label, full-render cleanup, and older-notice trigger (including `historyCursor === null`).
   - Add `notice.created` handling and DB notices fetch on `stream.ready`, session open, stream
     error/pause; dedupe by notice id.
   - Add `agent_stopped` boot/reload shell: URL session id or DB summary, notices fetch, Start
     action, no `showThreadError` feed clear.
   - Exclude `metadata.hanse === "agent-resume"` from `classifyOmo` and visible parts; render only
     `resume_started`.
   - Add `sessionHasHistory` notice handling; add a Start affordance using the existing start path.
5. Tests:
   - `test/process-recovery.test.ts`: resume eligibility/dispatch/outcome matrix, TTL, one attempt,
     supersession, idle-after-send, ambiguous/not-sent, lease expiry, deferred/stopped, no `ensure`.
   - `test/chat-page.test.ts`/`test/http.test.ts`: no-start `/sessions`, `/messages`, `/prompts`,
     `/saved-permissions`, `/todo`, app SSE, legacy SSE; `agent_stopped` shape; notices route.
   - `test/chat-core.test.ts`/client tests: merge order, count semantics, notice-only history,
     resume-part OMO exclusion, stopped shell state.
   - `docs/design/process-protection-qa.mjs` (new deterministic browser QA): reload while stopped
     (shell + Start + notice), interleaved notice above/below messages, child notice, resume
     `resume_started` not an OMO card, no console/page errors, 1440/768 light/dark screenshots in
     `docs/design/artifacts/process-protection/`.
6. Manual QA: use a disposable app/state and token; verify notice persistence across reload and
   coordinator restart, Start not auto-starting, and no read path starts a stopped app.

### Acceptance criteria

- A busy top-level session resumes once after an operator/external restart within 30 minutes; a
  stopped app is never started; a stale/completed/newer session is skipped with the right notice.
- The resume prompt is model-visible but renders only as `resume_started`, never an OMO system card.
- A stopped app survives reload with a shell, notices, and Start; reads never start it.
- Notices interleave correctly with messages and survive the 50-cap/dedupe.
- Browser QA passes at 1440/768, light/dark, with zero console/page errors.

### Verification

```bash
npx vitest run test/process-recovery.test.ts test/chat-page.test.ts test/http.test.ts test/chat-core.test.ts
npm run typecheck
npm run lint
node docs/design/process-protection-qa.mjs --base http://127.0.0.1:<PORT> --token <TEST_TOKEN>
```

## Phase D - Full gates, docs, journal, and commit

### Work

1. `docs/current-state.md`: document the rule file/overlay, bash denies and bypass caveats, runtime
   epoch, notices, read-path `agent_stopped`, resume limits (top-level, 30 min, one attempt, no
   manual resume, no auto-start), and the new API/SSE.
2. `docs/conventions.md` only if the `.hanse/` manifest semantics change (they should not).
3. `docs/journal/0037-agent-process-protection.md`: design/review history (round 10 PASS), Phase 0
   probe results, phase commits/decisions, test counts, browser QA evidence, known limits, and
   deployment status. Add it to `docs/journal/README.md`.
4. `docs/plans/README.md`: add plan 0030 and status.
5. `docs/design/README.md`: status approved, implementation record link.
6. Run `npm run check:sensitive`; inspect screenshots/binaries manually for host data.
7. Full gates: `npm run lint`, `npm run typecheck`, `npm test`, `npm run build`,
   `npm run check:sensitive`.
8. Commit only after explicit owner authorization; stage only this stage's files. Do not commit
   unrelated working-tree changes.

### Acceptance criteria

- All gates green; `npm run check:sensitive` clean; screenshots contain only disposable data.
- Docs describe the shipped behavior and every known limit; the journal records evidence.
- The stage is one coherent commit after owner authorization; no push/deploy unless separately
  authorized.

## Rollout

- Backup the coordinator database before the migration. v20 is forward-only and additive; old code
  ignores the new columns/tables.
- Deploy after the gates. Existing running apps show `Restart required` because the policy version
  and rule hash change; the rule is applied on the explicit restart. Docker auto-restarts before
  that keep the applied sidecar where trusted.
- First observations after the upgrade establish the runtime/active-turn baseline; no historical
  notices or resumes are synthesized.
- Watch logs for `agent_stopped`, `resume_started`/`resume_failed`, `process_rule_integrity_failed`,
  and `agent_stopped` read responses. No kill switch in this stage; roll back code if needed, leaving
  the additive schema in place.
- Do not deploy or push without explicit owner authorization.

## Risks and mitigations

- **False positives/duplicates:** completed-tail cutoff, cycle/epoch dedupe, parent+child keys,
  50-row cap tests.
- **External restart slower than the grace:** pin the grace above Docker stop timeout + startup and
  re-probe for a new epoch; add a slow-external-restart test. If it still terminalizes, the operator
  can send a normal message; no auto-start.
- **Read-path regression:** no-start tests for every read endpoint plus reload browser QA; keep
  explicit send/Start as the only starters.
- **Resume duplicate side effects:** one attempt, deterministic id, prepared/sent state, lease, and
  tail correlation; ambiguous never loops.
- **Rule file tampering:** applied sidecar + `applied_rule_hash`; integrity failure restores the
  current rule and keeps restart required. The file is agent-writable; the guard is a safety
  guardrail, not a security boundary.
- **Policy bypass:** wrappers/scripts/v1 always/v2 saved allows can widen the final ruleset;
  verification is warning-only and documented.
- **Status API unavailable:** persisted busy marker + runtime epoch fallback; no resume without
  running/ready.
- **Migration lock/data loss:** additive columns/tables, backup, migration tests, no destructive SQL.

## Definition of done

- Phase 0 probes recorded; Phases A-C implemented with their tests.
- All gates pass; browser QA evidence recorded; `check:sensitive` clean.
- `docs/current-state.md`, plan/design indexes, and journal 0037 updated.
- No commit/push/deploy until explicitly authorized.
