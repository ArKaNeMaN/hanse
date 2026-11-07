# Design - Agent process lifecycle and status tracking

Status: **implemented and verified** (2026-11-07; stage record:
[`docs/journal/0043-agent-process-status.md`](../journal/0043-agent-process-status.md)). This
document remains the design contract; the review history is in §18. The implementation follows the
frozen decisions and requirement IDs below. See the stage record for evidence and accepted debt.

Scope: durable tracking of a managed application's agent process lifecycle: cold start, lazy start,
reconnect, restart, stop, crashes/out-of-band stops, readiness failures, and their history; the read
API and the SSE delivery that make that lifecycle visible in the chat workspace, the application
page, and the fleet overview.

Out of scope: the OpenCode turn/chat state machine (`session.status`, `session.error`), turn-level
retries, container log streaming, the IDE, the operator terminal, and multi-user/RBAC.

Project profile bindings (phase 0 of `feature-delivery`):

| Binding | Value |
| --- | --- |
| Design reviewer | `oracle` |
| Plan reviewer | `momus` |
| Design docs | `docs/design/`, index `docs/design/README.md` |
| Plans | `docs/plans/`, index `docs/plans/README.md` |
| Decision records | `docs/decisions/NNNN-<slug>.md` |
| Stage journal | `docs/journal/`, index `docs/journal/README.md` |
| Open questions | this document, then the plan and `docs/open-questions.md` while open |
| Language | English |
| Verification | `npm run lint`, `npm run typecheck`, `npm run typecheck:ui`, `npm test`, `npm run build`, `npm run check:sensitive`, `npm run test:e2e` (this stage changes a rendered route) |
| Commit policy | one stage, one coherent commit; owner authorizes; Conventional Commits |

---

## 1. Summary

Hanse already stores one coarse runtime state per application (`instances.state` /
`instances.runtime_state`: `starting`, `running`, `stopped`, `error`). That state is written **after**
the runtime call that creates and starts the container (`InstanceManager.#ensureLocked()`,
`src/opencode/manager.ts:999-1006`), not before it. The chat Start button's busy state is a
component-local `ref` (`ui/pages/ChatPage.vue:129`, `654-671`), and the chat's "not running" view is
derived from the persisted state plus any HTTP `503` (`ChatPage.vue:1073-1082`).

The result is the reported behaviour: during a slow container create/start the database still says
`stopped`, so a page remount shows an active Start button; the readiness wait after the container
starts is not visible; a start failure is only a transient toast because no error text is persisted;
and an `error` state is rendered as the same neutral "Agent is not running" shell as `stopped`.

This design makes the agent process a first-class durable object:

1. **Current process** on `instances`: attempt id, phase, start time, sanitized last error, update
   time. The first write happens **after cheap guards and the runtime status probe, but before the
   image preflight and the heavy preparation**, and it is an **upsert** so a never-started app gets a
   row.
2. **Durable history** in a new `agent_run_events` table: one ordered row per transition, grouped by
   attempt. History is append-only; current error fields are separate and clear on a new attempt, a
   confirmed successful reconnect, an explicit stop, or a successful readiness recovery.
3. **One authoritative writer**: every process transition (start, readiness, reconnect, stop,
   restart, skills failure, restart failure, reconciler, out-of-band crash/OOM) goes through one
   locked transaction that updates the current row and appends the history row.
   `RuntimeRecovery.observeRuntime()` remains notice-only and is not the history writer.
4. **Reconciler authority**: the attempt owner **or a successful readiness probe** is the only writer
   of `ready`. The 15s reconciler may not promote a terminal `error` or an ownerless stale
   `starting` to `running` from Docker state alone; it always runs a readiness probe and only
   interrupts when the runtime is absent or the probe fails.
5. **Read API**: the existing `GET /api/apps/:app/runtime` is extended; a new
   `GET /api/apps/:app/process` returns current state plus paginated history.
6. **Push delivery**: a new always-available, human-only SSE endpoint
   `GET /api/apps/:app/process/events` that works while the agent is stopped or starting. It is
   separate from the existing app event stream, which attaches to the running OpenCode endpoint and
   returns `503 agent_stopped` otherwise (`src/http/prompts.ts:718-722`).
7. **UI**: chat and application page render `starting`, `stopping`, `stopped`, and `error` as distinct
   states, with phase, elapsed time, sanitized error text, history, and Retry. The Start button is
   disabled from server state, not a local request flag, so a remount cannot re-enable it while a
   launch or reconnect is in progress. The process state is authoritative over transport `503`s.

The existing 5s chat props poll and 10s application runtime poll remain as fallbacks; SSE is
additive and must not be required for correctness.

## 2. Problem and current behaviour

### 2.1 The reported sequence

1. A new app's chat shows "Agent is not running" because the app was never started. Expected.
2. The operator clicks **Start agent**. The button is disabled while the `POST /api/apps/:app/start`
   request is open (`ChatPage.vue:654-671`).
3. The request waits for `manager.ensure()` (`src/http/chat.ts:494`), which first waits for the
   runner to create and start the container (`manager.ts:999`), then waits up to 30s for OpenCode
   HTTP readiness (`manager.ts:1006`, `src/opencode/client.ts:193-195`).
4. Meanwhile the database row is still the previous state. For a first start that is `stopped`, so a
   page remount reads `stopped` from boot/chat props and re-enables Start. The local `startingAgent`
   flag was lost with the unmounted component.
5. If readiness fails, `AgentStartingError` maps to `503 agent_starting`
   (`src/http/errors.ts:29-36, 82-92`). The UI shows a toast; the persisted state may already be
   `running` because the runner reports the container as running after `docker start`
   (`src/runner/server.ts:288-330, 857-861`), and no error text is stored.
6. If the container itself fails to start, the manager records `state=error` with no message
   (`manager.ts:1497-1513`), and the chat renders the generic "Agent is not running" shell.

### 2.2 Current data shapes

- Coarse state: `src/agent/protocol.ts:4` (`RuntimeAppState`), `src/http/ui.ts` (`RuntimeState`),
  `ui/status.ts:29`.
- Persistence: `instances` (`src/store/migrations.ts:32-42`, plus lifecycle columns added through
  v20 at `migrations.ts:649-655`).
- Runtime read: `GET /api/apps/:app/runtime` (`src/http/handler.ts:824-884`) returns state, endpoint,
  spec hash, container identity, image, timestamps, and `restarting`, but no error, phase, or
  history.
- Chat props: `ChatRuntimeProps` carries only `{state, runtimeUrl}` (`src/http/props/chat.ts:39-42`,
  `173-176`).
- Live state: the chat SSE (`src/http/prompts.ts:678-846`) is gated on a live endpoint
  (`prompts.ts:718-722`); the legacy session SSE (`src/http/chat.ts:240-340`) is also
  running-only.
- Runtime observations: `InstanceManager.#readRuntimeRow()` / `#queueObservation()` /
  `RuntimeRecovery.observeRuntime()` already detect external stops, crashes, OOM, and restart-count
  changes (`manager.ts:2056-2177`). `observeRuntime()` early-returns when there is no previous
  started-at or no active resume row (`src/opencode/recovery.ts:1408-1418`), so it is not a general
  process-history writer.

### 2.3 Root causes

- **No persisted "launch in progress"** before the long runtime call, including the reconnect path.
- **No launch attempt identity**, so concurrent/retried starts cannot be correlated and a coordinator
  crash mid-start cannot be classified.
- **No persisted error** (message, code, time) for a failed start, reconnect, or out-of-band failure.
- **No history**, so the operator cannot answer "did it try to start, and what happened last time?".
- **No lifecycle transport** that survives `stopped`/`starting`.
- **The chat view conflates** `stopped`, `error`, `starting`, and transport `503`.
- **The reconciler can erase a terminal error** by promoting Docker's `running` state without a
  readiness probe.

## 3. Requirements

| ID | Requirement |
| --- | --- |
| L1 | A start/restart/reconnect attempt is durably visible as `starting` (with an attempt id and start time) after cheap guards and the status probe, but before the image preflight and the heavy preparation/readiness call. |
| L2 | Every process transition is persisted as an ordered history event: attempt start, phase changes, running, reconnect, stop, crash, OOM, readiness failure, out-of-band stop, and restart. |
| L3 | A failed start/restart/reconnect persists a sanitized error code and message with its time. History retains the error until retention prunes it; current `process_error_*` fields clear on a new attempt, a confirmed successful reconnect, an explicit stop, or a successful readiness recovery. |
| L4 | Current state and history are readable without a running agent and without calling the runtime. |
| L5 | Chat and application pages show distinct `starting`, `stopping`, `stopped`, `error`, and `running` presentations; `starting` includes a phase and elapsed time; `error` includes the message, time, and Retry. |
| L6 | The Start button is disabled from persisted/server state while a launch or reconnect is in progress, including after a page remount; a repeated start is idempotent and does not create a second attempt. |
| L7 | Process transitions are delivered live over SSE, with a consistent snapshot carrying a per-app `lastEventId`; every post-snapshot delivery is deduped by id, and a snapshot mismatch or warning triggers a `/process` refetch. Polling remains a fallback. |
| L8 | History is bounded and pruned; error text is bounded, sanitized, and redacted; no secret, token, environment value, file content, or raw internal exception is stored or returned. |
| L9 | Existing behaviour is preserved: the sync `POST /api/apps/:app/start` contract, `GET /runtime` fields, chat/SSE/terminal/handoffs, and the `starting|running|stopped|error` coarse vocabulary. Legacy `failed` normalizes to `error`. |
| L10 | The fleet overview shows the number of agents in `starting`, `stopping`, and `error`, and a short list of affected applications with links. |
| L11 | One authoritative writer owns every process transition; the reconciler never promotes `error` or an ownerless stale `starting` to `running` without a successful readiness probe. |
| L12 | The attempt boundary is explicit: explicit start/restart of a running app and a lazy start create a new attempt; a reconnect to a running container does not create a new attempt but is visible; plain stop closes the current attempt; restart of a stopped app is a no-op with no attempt; an out-of-band restart creates a new attempt. |

## 4. Decision

Adopt a durable **agent process** attached to each application:

- Extend `instances` with the current process detail (`process_*` columns). Keep `state` /
  `runtime_state` as the coarse state for every existing reader.
- Add `agent_run_events` for ordered history grouped by `attempt_id`.
- Route every process write through one locked `#transitionProcess()` helper in `InstanceManager`.
- Add one per-app **launch primitive** that resolves the endpoint string and is shared by `ensure`,
  the restart claim, the sync restart, and image rollback.
- Expose current + history through `/api/apps/:app/runtime` and `/api/apps/:app/process`.
- Push transitions through `/api/apps/:app/process/events`, independent of the OpenCode endpoint.
- Render the process in chat, the application page, and the overview.

The process is **process-level**, not turn-level. OpenCode `session.error`, retries, queueing, and
compaction stay in the existing chat/session machinery.

The new domain is named `process_*` / `/process` to avoid colliding with the existing in-flight
`lifecycleActivity` / `#beginLifecycle` / `/readyz` counter (`manager.ts:2323-2325`).

## 5. Data model (migration v23)

### 5.1 `instances` additions

```sql
ALTER TABLE instances ADD COLUMN process_attempt_id TEXT;
ALTER TABLE instances ADD COLUMN process_phase TEXT;
ALTER TABLE instances ADD COLUMN process_started_at TEXT;
ALTER TABLE instances ADD COLUMN process_error_code TEXT;
ALTER TABLE instances ADD COLUMN process_error_message TEXT;
ALTER TABLE instances ADD COLUMN process_error_at TEXT;
ALTER TABLE instances ADD COLUMN process_updated_at TEXT;

UPDATE instances SET
  process_phase = CASE COALESCE(runtime_state, state)
    WHEN 'running' THEN 'ready'
    WHEN 'starting' THEN 'requested'
    WHEN 'stopped' THEN 'stopped'
    WHEN 'failed' THEN 'failed'
    WHEN 'error' THEN 'failed'
    ELSE NULL
  END,
  process_updated_at = updated_at
WHERE process_phase IS NULL;
```

Phase mapping is explicit because coarse states are not phases. `process_phase` is `NULL` only for a
row whose coarse state is unknown; the application treats `NULL` as absent and the UI falls back to
the coarse state. `process_attempt_id` stays `NULL` for legacy rows and is set on the next explicit or
lazy start. `process_started_at` is the attempt start; `instances.started_at` keeps its existing
meaning (last transition to running).

SQLite cannot add a `CHECK` to an existing table without a rebuild, so `instances.process_phase` is
validated by the single writer at runtime, including the state/phase pairing (`ready` only with
`running`; `stopped` only with `stopped`; `failed`/`interrupted` only with `error`; the other phases
only with `starting`). The new table below enforces its own `CHECK`s.

### 5.2 `agent_run_events`

```sql
CREATE TABLE agent_run_events (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  app_id TEXT NOT NULL REFERENCES apps(id) ON DELETE CASCADE,
  attempt_id TEXT NOT NULL CHECK (length(attempt_id) BETWEEN 1 AND 128),
  seq INTEGER NOT NULL CHECK (seq > 0),
  state TEXT NOT NULL CHECK (state IN ('starting','running','stopped','error')),
  phase TEXT CHECK (phase IS NULL OR phase IN (
    'requested','preparing','creating','waiting_ready','ready',
    'stopping','stopped','failed','interrupted')),
  source TEXT NOT NULL CHECK (source IN ('operator','runtime','reconciler','system')),
  reason TEXT CHECK (reason IS NULL OR length(reason) <= 200),
  error_code TEXT CHECK (error_code IS NULL OR length(error_code) <= 200),
  message TEXT CHECK (message IS NULL OR length(message) <= 2000),
  created_at TEXT NOT NULL
);
CREATE UNIQUE INDEX agent_run_events_attempt_seq
  ON agent_run_events(app_id, attempt_id, seq);
CREATE INDEX agent_run_events_app_id
  ON agent_run_events(app_id, id DESC);
CREATE INDEX agent_run_events_created
  ON agent_run_events(created_at);
```

- Every row is a transition snapshot; the sequence reconstructs the attempt timeline.
- `state` mirrors the normalized coarse state. The writer normalizes legacy `failed` to `error`
  before insert; the `CHECK` therefore never receives `failed`.
- `phase` is the §6 phase. `message` is sanitized and bounded (§10).
- The existing `events` audit table is not reused: it is a generic JSON audit trail with different
  retention and no per-attempt ordering; see §14.
- Indexes are aligned with the history query: newest-first by `id`, cursor by `id` (§11).

### 5.3 Attempt boundary

| Event | New attempt? | Source | Notes |
| --- | --- | --- | --- |
| Explicit `POST /start` | yes | `operator` | New UUID; `requested` first event. |
| Explicit restart of a **running/starting** app (sync or async claim) | yes | `operator` | New UUID; `requested → stopping → …`. |
| Explicit restart of a **stopped** app | **no** | n/a | Preserve current no-op behavior: `{restarted:false, reason:"not_running"}`; no attempt, no event. |
| Lazy start triggered by a prompt, context read, command, handoff, or master tool | yes | `system` | `reason` names the caller (`prompt`, `context`, `command`, `handoff`, `master`). |
| Reconnect to an already-running container | no | `system` | Appends a visible `starting`/`waiting_ready` transition when the persisted state is not `running`; appends `running`/`ready` on success. Uses the current attempt or a synthetic `system:<appId>:<timestamp>` attempt when none exists. |
| Plain operator stop | no (closes) | `operator` | `stopping → stopped`; closes the open attempt; clears current `process_error_*`. |
| Deletion stop | no (closes) | `system` | `reason=delete`. |
| Out-of-band restart (runtime epoch or restart count change) | yes | `reconciler` | Uses the runtime epoch key when available; `reason=external_restart`. |
| Crash/OOM/out-of-band stop while no attempt is open | yes | `reconciler` | Synthetic attempt; records `error`/`stopped` with the observed exit/OOM detail. |
| Legacy row with no attempt | yes on next event | `system` | First new event creates the attempt. |

A pre-attempt refusal (deletion pending, deployment lock, state-path collision) does **not** create an
attempt: no launch was attempted, the current state is unchanged, and the typed HTTP error is the
operator signal. An image preflight failure **does** create an attempt because the operator asked to
launch; it is recorded as `error` with `error_code=image_unavailable` (or
`default_image_unavailable`), and a later Retry creates a new attempt.

A reconnect does not create a new attempt, but it **does** write transitions: if the persisted state
is `stopped`/`error`, it writes `starting`/`waiting_ready` before the readiness await; if the persisted
state is already `running`, it keeps `running` and only writes an error on a readiness/token failure.

### 5.4 Why not a separate `agent_processes` table

`instances` is already one row per app with the runtime identity, endpoint, and lifecycle counters.
A second current-state table would need to be kept transactionally consistent with `instances` on
every write. Extending `instances` keeps one writer and one read path. `agent_run_events` is the
append-only history.

## 6. State machine and phases

Coarse states remain `starting | running | stopped | error`.

| Phase | Coarse state | UI label | Meaning |
| --- | --- | --- | --- |
| `requested` | `starting` | Starting… | An explicit or lazy start/restart was accepted. |
| `preparing` | `starting` | Starting… | Credentials, skills, settings, token, and files are being prepared. |
| `creating` | `starting` | Starting… | The runner is creating the network/container. |
| `waiting_ready` | `starting` | Starting… | The container is running or reconnecting; OpenCode readiness is being awaited. |
| `ready` | `running` | Running | OpenCode answered its readiness probe. |
| `stopping` | `starting` | Stopping… | A stop or the stop half of a restart is in progress. |
| `stopped` | `stopped` | Stopped | No running container. |
| `failed` | `error` | Error | The attempt failed; `process_error_*` holds the sanitized detail. |
| `interrupted` | `error` | Interrupted | A `starting` attempt has no live owner (coordinator crash/restart) and the runtime cannot confirm it. |

`stopping` mapping to coarse `starting` is a deliberate compatibility choice: the coarse vocabulary
has no `stopping`, and the app is not usable while stopping. Existing readers (`GET /runtime`,
`startingCount`, chat props) therefore report `starting` during a stop; the new UI uses the phase and
shows "Stopping…", and the new overview block splits `starting` vs `stopping` by phase (§8.4). This is
recorded as an owner confirmation in §17.

Transitions:

- Explicit start: `requested → preparing → creating → waiting_ready → ready` (`running`), or
  `failed`.
- Restart of a running/starting app: one attempt, `requested → stopping → preparing → creating →
  waiting_ready → ready`, or `failed`. The restart's stop half must **not** emit a terminal `stopped`
  event or a stopped→starting regression (§7.7).
- Lazy start: the same as explicit start, with source `system` and a caller reason.
- Reconnect: `waiting_ready → ready` when the persisted state was not `running`; `running` stays
  `running` with an error transition on failure.
- Plain stop: `stopping → stopped`; closes the attempt and clears current error fields.
- Deletion stop: `stopping → stopped`, `reason=delete`.
- Reconcile/external: `running → stopped` (out-of-band stop), `running → error` (crash/OOM),
  `starting → interrupted` (stale launch with no owner and a failed readiness probe), or
  `error → running` only after a successful readiness probe.
- A terminal `error` is **sticky for automatic reconciliation**: a later Docker `stopped` or
  `running` state alone does not replace it. Only a new explicit/lazy attempt, an explicit stop, or
  a successful readiness probe may transition it.
- An explicit stop from `error` writes `stopped` and clears `process_error_*`; the history keeps the
  error event. The UI's error panel is keyed on `state=error`, so a stopped app with a historical
  error shows the stopped panel and a history link.

The coarse state is written on every transition; the phase is written alongside it.

## 7. Write ownership, ordering, and consistency

### 7.1 One authoritative writer and lock ownership

`InstanceManager` owns a single `#transitionProcess(appId, input)` helper. **The helper never
acquires the per-app lock; every caller must hold it.** This is explicit because the helper is called
from both already-locked contexts (`#reconcileStatuses`, `#stopLocked`, `#restartLocked`,
`#ensureLocked`) and from callers that must wrap themselves (`probeStatus`, `#handleRestartFailure`).
A self-locking helper would deadlock the reconciler, which already holds `#withAppLock` at
`manager.ts:1972-1985`.

The helper, in one SQLite transaction:

- upserts the current `instances` row with:
  - process fields: `process_attempt_id`, `process_phase`, `process_started_at`,
    `process_error_code`, `process_error_message`, `process_error_at`, `process_updated_at`;
  - coarse fields: `state`, `runtime_state`, `endpoint`, `spec_hash`, `container_id`,
    `container_name`, `image_ref`, `applied_image_id`, `applied_settings_hash`, `applied_profile`,
    `applied_rule_hash`, `started_at`, `runtime_started_at`, `runtime_restart_count`,
    `last_exit_code`, `last_oom_killed`, `last_stop_reason`, `last_stop_at`;
  - the existing `applied_image_id`/`applied_rule_hash` COALESCE and `started_at` preservation
    semantics;
- inserts the `agent_run_events` row;
- allocates `seq` inside the transaction as `COALESCE(MAX(seq),0)+1` for
  `(app_id, attempt_id)`;
- normalizes `failed → error`, validates the phase enum and state/phase pairing, and sanitizes the
  message.

After the transaction commits, the caller/helper queues the same `RuntimeObservation` that
`#recordStatus`/`#recordStatusById` queue today (so `observeRuntime` keeps detecting external
stops/crashes/OOM), and then the manager emits the process event to subscribers. The event emission
is not part of the DB transaction.

`#recordStatus` and `#recordStatusById` become thin adapters that build the helper input (process
state + runtime identity payload) instead of writing `instances` directly. `#recordSkillsError` and
`#handleRestartFailure` also build the helper input. There is no second process writer.

### 7.2 Exact write order

In `ensure()` / `#ensureLocked()`:

1. Cheap guards: absolute app dir, deletion marker, state-path collision. A failure here is a
   **pre-attempt refusal**: no process attempt is written, the current state is unchanged.
   The **deployment lock** is checked before the destructive path but is **not** an early guard for
   reconnect: a running app with a working password still reconnects and serves chat during a
   deploy, as documented in `docs/current-state.md`.
2. `runtime.status()` probe to decide reconnect vs destructive start.
3. **Reconnect branch** (running container with a usable password): write `starting`/`waiting_ready`
   with source `system`, `reason=reconnect`, **before** `ensureAgentToken`,
   `#restoreProcessRuleOnReconnect`, and `#awaitReady`, but only when the persisted coarse state is
   not already `running`. On success, write `running`/`ready`, clear `process_error_*`, and append a
   `running` event (reason `reconnect`). On a token/readiness failure, write
   `error`/`failed` with `token_reconcile_failed`/`readiness_timeout` and rethrow. No new attempt.
4. **Destructive branch**, after the probe and before `#preflightImage` and the heavy preparation:
   generate an `attempt_id`, write `state=runtime_state=starting`, `process_phase=requested`,
   `   process_started_at=now`, clear `process_error_*` for the new attempt, and insert event `seq=1`
   with source `operator|system` and the caller reason. This is an **upsert**. When the destructive
   branch is entered from `#restartLocked`, the caller supplies the existing attempt context;
   `#ensureLocked` does not generate a second attempt or re-emit `requested`/`seq=1`.
5. Preflight (`#preflightImage`): a failure is `error`/`failed` with
   `error_code=image_unavailable` / `default_image_unavailable`, then rethrow the typed error.
6. `process_phase=preparing` after the first heavy preparation step; `process_phase=creating`
   immediately before `runtime.ensure`.
7. `runtime.ensure` returns a running/starting container: persist the runtime identity and
   `state=runtime_state=starting`, `process_phase=waiting_ready` (do **not** write `running` yet).
8. `#awaitReady` succeeds: `state=runtime_state=running`, `process_phase=ready`, set
   `instances.started_at=now`, insert the `running` event.
9. Any failure from step 4 onward: `state=runtime_state=error`, `process_phase=failed` (or
   `interrupted` for a stale launch), sanitized `error_code`/`message`/`error_at`, insert the error
   event, then rethrow the original error for the existing HTTP mapping.

The reconnect branch's `starting` write is what closes the remount window for a start that finds an
already-running container after a coordinator restart.

### 7.3 Initial write is an upsert

A new app has no `instances` row. The initial transition uses
`INSERT ... ON CONFLICT(app_id) DO UPDATE`, the same shape as `#recordStatus`
(`manager.ts:2191-2245`). `#recordStatusById` is UPDATE-only (`manager.ts:2256-2307`) and is not used
for the first write. The current row and the history row commit together.

### 7.4 The launch primitive

One per-app `Map<string, Promise<string>>` (`#launches`) is the idempotency boundary. The promise
resolves the endpoint string, not a boolean.

- `ensure()` reads/writes `#launches` **before** `#withAppLock`. If a launch is in flight, it returns
  that promise.
- `beginRestart` creates the launch promise **synchronously**, stores it in `#launches`, and only
  then returns the `202`; the deferred body runs that promise. `#restartClaims` remains the
  `202`/`409 restart_in_progress` claim, and the launch promise is the actual work.
- `restartIfRunning` (sync) registers its promise in `#launches` before acquiring the lock.
- `rollbackImage` registers its restart promise in `#launches` **before** its `#withAppLock`.
- `#restartLocked` is a locked helper and **does not** register in `#launches`; it runs inside the
  promise created by one of the public entry points above.
- A **restart during a start** chains the restart's promise after the in-flight launch promise (it
  waits for the start to finish, then stops/restarts under the claim). A **start during a restart**
  joins the restart promise and receives its endpoint. This is the only ordering, so the operator
  never gets two concurrent launches for one app.
- A rejected promise is removed in `finally`; the next call starts a new attempt.

`ensure()` takes an origin argument: `{origin: "operator"}` for `POST /start` and explicit restart,
`{origin: "system", reason}` for the lazy callers (`prompts.ts:600`, `context.ts:113`,
`commands.ts:147,220`, `chat.ts:1500,2268`, `dispatcher.ts:480,634,825,896`,
`master/tools.ts:~1051`). The history source is `system` for lazy starts; the reason names the
caller.

### 7.5 Running only after readiness

`#recordStatus` currently writes the status returned by `runtime.ensure` (including `running`) at
`manager.ts:1000`, before `#awaitReady` at `1006`. The design replaces that write with the
`waiting_ready` transition from §7.2, and writes `running`/`ready` only after `#awaitReady` succeeds.
A readiness failure therefore never has to regress `running → error`; the row was still `starting`.

`instances.started_at` keeps its existing meaning (set when the coarse state first becomes running).
The running transition sets it to `now`; `process_started_at` is the attempt start and is
independent.

### 7.6 Reconciler authority, error stickiness, and the age cutoff

The 15s `#reconcileStatuses()` (`manager.ts:1962-1991`) runs under the per-app lock, so it cannot
interleave with a live attempt's readiness wait. The design makes its authority explicit:

- **Authority rule:** the attempt owner **or a successful readiness probe** is the only writer of
  `ready`. The reconciler never writes `running`/`ready` from Docker state alone.
- **Live attempt:** the in-memory attempt owner is authoritative. The reconciler queues behind the
  lock and only runs after the attempt finishes.
- **Healthy running:** runtime `running` + persisted `running` keeps `running`; no new event unless
  the runtime identity/epoch changed.
- **Persisted `error`:** run a bounded readiness probe. Success transitions to `running`/`ready` with
  source `reconciler`, `reason=readiness_recovered`, and clears `process_error_*`; failure keeps
  `error`.
- **Persisted `starting` with no in-memory attempt (crash mid-start):**
  - always run a bounded readiness probe first, even after the age cutoff and even when Docker
    reports `running`;
  - probe success → `running`/`ready` (source `reconciler`, `reason=readiness_recovered`);
  - runtime absent/stopped, or probe failure after `process_updated_at` is older than
    `readinessTimeout + 60s` (default 90s), → `error`/`interrupted` with `reason=stale_start`;
  - probe failure within the cutoff → keep `starting` and retry next tick.
- **Persisted `error` and runtime `stopped`:** keep `error` (sticky). Only an explicit stop/start or
  a successful readiness probe changes it.
- **Runtime transport failure:** keep the last known state, as today (`manager.ts:1979-1981`).

This closes the ways the original confusion returns: a readiness error being erased by the next tick,
a healthy recovered app being declared interrupted, and a coordinator crash leaving `starting`
forever.

### 7.7 Stop and restart

- `#stopLocked(appId, reason, options)` gains a `terminal` flag.
  - **Plain stop/deletion stop** (`terminal=true`): write `stopping` before `runtime.delete`; after
    it returns, write terminal `stopped` (via the generic status writer), queue the observation, and
    clear `process_error_*`.
  - **Restart stop half** (`terminal=false`): write `stopping` before `runtime.delete`; after it
    returns, **suppress** the generic `#recordStatusById(finalStatus)` terminal write, its event, its
    coarse-state change, and its `#queueObservation`. The restart's subsequent start phases write the
    next state; the intentional stop is already recorded by `recordStopIntent("restart")`.
  - **Stop failure:** if `runtime.delete` throws after `stopping` is written, write
    `error`/`failed` with `error_code=runtime_unavailable` and rethrow. Do not leave the row
    `starting` for the age cutoff to misclassify; `#handleRestartFailure` then sees the same
    attempt/state/code and must not append a second event.
- `#restartLocked` on a running/starting app:
  1. write `requested` (new attempt) **before** its preflight;
  2. run `#preflightImage`; on failure write `error`/`image_unavailable` and rethrow;
  3. non-terminal stop (above);
  4. start phases to `ready`.
- `#restartLocked` on a **stopped** app early-returns `false` with no attempt/event, preserving
  `{restarted:false, reason:"not_running"}`.
- The settings restart route's synchronous `preflightRestart` runs before `beginRestart`. To record
  an image-preflight failure, the route writes the attempt (`requested`) through the manager before
  the preflight and writes `error`/`image_unavailable` on failure; `beginRestart` then continues the
  same attempt. The same rule applies to `rollbackImage`.
- `#handleRestartFailure` (`manager.ts:1497-1513`) runs after `#runRestartClaimed` releases the lock,
  so it must be wrapped in `#withAppLock` before calling `#transitionProcess`. It must not duplicate
  an error already written by `#ensureLocked`/`#restartLocked`: the helper treats a same-attempt,
  same-state, same-code transition as a no-op (no second event).
- The async `202` claim path uses the same transitions; a duplicate claim keeps its existing
  `409 restart_in_progress` response.

### 7.8 Direct writers, observation flush, and the trigger

These existing paths route through `#transitionProcess`:

- `#recordSkillsError` (`manager.ts:2057-2070`, already called under the `#ensureLocked` lock) →
  `error`/`failed`, `error_code=skills_materialize_failed`.
- `#handleRestartFailure` (`manager.ts:1497-1513`) → `error`/`failed` with the restart reason, under
  the lock (above).
- `probeStatus` (`manager.ts:1454-1464`, called from `images.ts:351`) → wrap in `#withAppLock`, then
  use the writer.
- `#recordStatus` / `#recordStatusById` → build the helper input and call the writer. The trigger is
  not only a coarse state/phase change: it also fires when `runtime_started_at`,
  `runtime_restart_count`, `exitCode`, `oomKilled`, `finishedAt`, `stopReason/At`, `endpoint`,
  `spec_hash`, `container_id`, `image_ref`, or the process error fields change. This is how an
  out-of-band restart or OOM that leaves coarse `running` still becomes history.
- `RuntimeRecovery.observeRuntime()` (`recovery.ts:1408-1418`) stays **notice-only**. It early-returns
  without active resumes and runs outside the lock, so it must not own process history. The flush in
  `#flushObservations` may keep its notice work; the process transition is recorded by the locked
  status writer.

`seq` is allocated under the same lock as the current-row update, so two writers cannot duplicate a
sequence. The existing `#queueObservation` call is preserved after the helper's transaction commits.

## 8. API

All routes require a human principal and an explicit `?project=<projectId>`; `findApp` only filters
by project when the parameter is present (`src/http/apps.ts:14-29`), so the route must reject a
missing `project` with `400` like `/runtime` (`src/http/handler.ts:837-840`). Agent principals get
`403`. The SSE route requires the operator cookie because `EventSource` cannot send a bearer header;
the JSON routes keep the existing human cookie/bearer behavior.

### 8.1 `GET /api/apps/:app/runtime` (extended)

Keep every existing field. Add:

```json
{
  "process": {
    "attemptId": "…",
    "phase": "waiting_ready",
    "startedAt": "2026-11-07T12:00:00.000Z",
    "updatedAt": "2026-11-07T12:00:04.000Z",
    "error": { "code": "readiness_timeout", "message": "…", "at": "…" } | null,
    "lastEventId": 42
  }
}
```

`state` remains the coarse state. The route stays DB-only and works while stopped.

### 8.2 `GET /api/apps/:app/process`

Returns current + paginated history:

```json
{
  "current": { "state": "error", "phase": "failed", "attemptId": "…", "startedAt": "…",
               "updatedAt": "…", "error": { "code": "readiness_timeout", "message": "…", "at": "…" },
               "lastEventId": 42 },
  "events": [
    { "id": 42, "attemptId": "…", "seq": 4, "state": "error", "phase": "failed",
      "source": "runtime", "reason": "readiness_timeout", "errorCode": "readiness_timeout",
      "message": "…", "createdAt": "…" }
  ],
  "nextCursor": "17"
}
```

- `limit` 1..100, default 50; `before` is a positive integer event id; invalid/negative/non-numeric
  returns `400`. Newest first, ordered by `id DESC`; `nextCursor` is the last returned id or `null`.
- DB-only; never calls the manager or runtime; works while stopped and while another call holds the
  app lock.
- The snapshot (`current` + `lastEventId`) is read in **one SQL statement** (a scalar subquery for
  `MAX(id)`) so the current row and the cursor cannot diverge.

### 8.3 `GET /api/apps/:app/process/events` (new SSE)

- Human-only, `?project` required, `Cache-Control: no-store`, `text/event-stream`, heartbeat every
  existing `HANSE_EVENT_HEARTBEAT_MS`.
- Does **not** require `manager.endpointFor()`; it works while stopped, starting, stopping, or error.
- Frames use the existing `{seq, streamID}` envelope (`src/http/prompts.ts:744-759`):
  - `stream.ready` (seq 0);
  - `process.snapshot` (seq 1) with `{current, lastEventId}`;
  - `process.transition` (seq 2+) with the §8.2 event shape.
- **Subscribe/read ordering:** subscribe to the in-process bus first into a bounded buffer, then read
  the snapshot (one consistent query, §8.2), then flush buffered transitions with `id >
  lastEventId`. **Every** transition delivered after the snapshot is also filtered/deduped by `id >
  lastEventId`; the client additionally dedupes by id. A transition emitted after the snapshot read
  but committed before it cannot be delivered twice.
- **Global ids are not contiguous per app.** `agent_run_events.id` is a global `AUTOINCREMENT`; ids
  for one app skip values from other apps. Gap detection must not assume `id + 1`. A gap is detected
  only by a new `streamID`, a `stream.warning`, or a transition whose id is not greater than the
  client's local `lastEventId` (duplicate/out-of-order). Any of those triggers one
  `GET /api/apps/:app/process` refetch and replaces the local state.
- **`stream.warning`** is emitted with `{type:"stream.warning", code, message?}` when:
  `process_buffer_overflow` (the pre-snapshot buffer exceeded 256 frames),
  `process_snapshot_failed` (the snapshot read failed after headers), or
  `process_slow_consumer` (the response write queue exceeded 1 MiB). The client refetches on any of
  these.
- **Stream limit:** a new per-app `ProcessStreamRegistry` (separate from `AppStreamRegistry`,
  `src/attachments/streams.ts:1-39`) allows 4 browser streams per app; over the limit returns
  `429 stream_limit`. The client **closes** the `EventSource` on 429/terminal error and falls back to
  the existing 5s/10s poll with backoff; it does not let `EventSource` auto-retry against 429.
- **Dispatch:** the route and `/process` must be dispatched in `src/http/server.ts` before the
  `/api/apps/` chat catch-all (`server.ts:431-481`).
- A deletion-pending app returns `409 deletion_pending` like the other app routes.
- If `deps.manager` is undefined (runtime not configured), the route still serves the DB snapshot and
  then closes; it never returns 503 solely because the manager is absent.

### 8.4 Overview summary

Extend `OverviewProps` with a `processes` summary derived from the same `SiteModel` data:

- `starting`, `stopping`, and `error` counts (the existing coarse `startingCount` includes
  `stopping`; the new block uses the phase to split them);
- up to five applications in `starting`/`stopping`/`error`, ordered by `process_updated_at`
  descending, excluding the built-in master (`isMasterApp`);
- each row has state, phase, update time, and links to the chat and application page.

No new endpoint; no history in the overview.

## 9. UI

### 9.1 State precedence

The process state is authoritative over transport errors when it is present:

1. `process.current` from the initial props / `/process` read / SSE snapshot.
2. `state=running` → normal chat. A transient sessions `503` shows the existing stream/reconnect
   affordance, not "Agent is not running".
3. `state=starting`/`stopping` → starting/stopping panel, composer disabled as today when no session
   is available.
4. `state=error` → error panel with the sanitized message, time, Retry, and a history link.
5. `state=stopped` → the existing "Agent is not running" panel with Start.
6. Only when no process information exists (legacy server) does the old fallback apply. Only the
   `agent_stopped` code confirms stopped; `agent_unavailable`, `agent_starting`, and
   `default_image_unavailable` map to their own presentations rather than the generic stopped shell.

`ChatPage.vue`'s `isStopped()` any-503 behavior (`ChatPage.vue:1073-1082`) is replaced by this
precedence. The Start/Retry button is disabled when the server state is `starting`/`stopping`,
including after remount. A local `startingAgent` ref may remain as an immediate double-click guard,
but it is not the source of truth.

### 9.2 Chat workspace

- `running`: the normal chat.
- `starting` (`requested|preparing|creating|waiting_ready`): a full-width "Starting agent…" panel
  with a phase label, elapsed time, and no Start button.
- `stopping`: a "Stopping agent…" panel. It must not be labelled "Starting".
- `stopped`: the existing "Agent is not running" panel with Start.
- `error`: "Agent failed to start" with the sanitized message, time, Retry, and a link to the
  application page's process history. Legacy rows with no message show
  "The agent failed to start. No error details were recorded."
- `deleting`: unchanged.

The Start handler still calls the sync route. On success or failure it refetches the process view
(and relies on the SSE/poll), so a failed POST immediately shows the persisted error rather than
leaving the button enabled. The success toast is aligned with the visible panel (no "Agent starting."
toast after the awaited request already returned `running`).

### 9.3 Application page

- The Runtime state strip shows the coarse state and, for `starting`/`stopping`, the phase and
  elapsed time.
- An `error` state shows a short sanitized message and a **Process history** disclosure.
- The disclosure fetches `/api/apps/:app/process?limit=50` and renders the events newest first:
  time, state/phase, source, reason, and sanitized message. It supports "Load older".
- The page keeps its 10s runtime poll as a fallback and subscribes to the process SSE while visible.

### 9.4 Overview

The existing watch strip keeps its counts. Add a compact "Agent processes" block listing applications
in `starting`, `stopping`, or `error` with a link to the application page; hidden when empty. No
history and no new page.

## 10. Error handling and redaction

- Store `error_code` as a stable machine code: `runtime_unavailable`, `image_unavailable`,
  `default_image_unavailable`, `token_reconcile_failed`, `skills_materialize_failed`,
  `readiness_timeout`, `interrupted`. `external_restart` and `out_of_band_stop` are **reasons**, not
  error codes; `deployment_in_progress` is a pre-attempt HTTP refusal, not a process error code.
- Add a new shared helper `sanitizeProcessError(input, { secrets })` in a small coordinator module
  (for example `src/opencode/process-errors.ts`) because the existing helpers are input-specific:
  `sanitizeLogs` (`src/images/service.ts:1617-1639`) redacts roots/Bearer/runtime token;
  `sanitizeCloneError` (`src/coordinator/provision.ts:700-726`) needs a caller-supplied secret list;
  `redactUserinfo` (`src/git/env.ts:251`) only handles URLs. The new helper:
  - keeps the first line only, strips ANSI escapes and control characters, caps at 2,000 characters;
  - redacts `Bearer <token>`, `Authorization: ...`, `HANSE_RUNTIME_TOKEN`, `HANSE_OPERATOR_TOKEN`,
    provider keys, MCP tokens, opencode passwords, git tokens/private-key markers, and every
    caller-supplied secret value (the caller passes the effective settings/auth/token values it
    already holds);
  - for an unknown/internal exception, stores a generic message keyed by `error_code` instead of the
    raw exception;
  - is tested against each secret class and against oversized/multiline input.
- Runner errors may include image names and paths; those are acceptable operator diagnostics. Do not
  store container logs by default (the user chose events + history, not log streaming).
- The API returns only the sanitized stored value; it never re-reads the runtime or a raw exception.
- History is durable, so redaction happens **at write**, not at read.

## 11. Retention, limits, and pagination

- History is capped per application at **1,000 events** and **30 days**; the older of the two wins.
  Pruning runs opportunistically on insert under the same lock (delete rows beyond the cap) and once
  per 15s status-reconciler tick **unfiltered by app state** (delete rows older than 30 days; a
  stopped app's history must still prune). Both are batched and idempotent. The cap is a proposed
  default; §17 asks the owner to confirm it.
- `message` ≤ 2,000; `reason`/`error_code` ≤ 200; `attempt_id` ≤ 128; `phase` is the fixed enum.
- Current fields are one row per app; no growth.
- `/process` pages by `id DESC` with a positive-integer `before` cursor and a 100-row maximum. The
  index `agent_run_events(app_id, id DESC)` matches the query.

## 12. Concurrency and idempotency

- The per-app lock serializes `ensure`/`stop`/`restart` and the reconciler.
- `#launches` (read/written **before** the lock) makes a duplicate start return the in-flight
  endpoint promise; it is created synchronously by every public entry point (`ensure`,
  `beginRestart`, `restartIfRunning`, `rollbackImage`) and cleaned in `finally`. `#restartClaims`
  remains the async `202`/`409` claim. A start joins a restart promise; a restart during a start
  chains after it.
- The attempt write is inside the lock before the first long await, so a second caller sees a visible
  `starting` row and joins the launch.
- After a coordinator restart, `#launches` is empty; the durable `starting` row plus the reconciler
  (readiness probe + age cutoff) decide whether the attempt is live, failed, or interrupted.
- `probeStatus` is wrapped in the per-app lock so its write cannot race a start/stop.
- `#transitionProcess` never acquires the lock; every caller holds it (§7.1).

## 13. Security

- All new routes require a human principal; agent principals get `403`. The SSE route requires the
  operator cookie (EventSource); the JSON routes keep the existing cookie/bearer behavior.
- No new secret is stored. Error text is sanitized at write. History is not a secret store.
- The process stream is per-app and project-scoped; a missing `?project` is `400`, and a cross-project
  app key is rejected.
- Deployment-lock and deletion guards are unchanged: a locked or deleting app still reports
  `deployment_in_progress`/`deletion_pending`; a pre-attempt refusal does not create a process
  attempt. A running app reconnects during a deployment lock. An image preflight failure does create
  an attempt with `image_unavailable`.

## 14. Alternatives considered

| Option | Why rejected / deferred |
| --- | --- |
| Reuse `instances.state` only, no history | Does not answer "what happened last time?"; the owner chose full history. |
| Reuse the generic `events` audit table | JSON payload, different retention, no per-attempt ordering or pagination; a dedicated table is simpler to query and prune. |
| Add process frames to `/api/apps/:app/events` | That stream attaches to the running OpenCode endpoint and returns `503 agent_stopped`; process state must work exactly when stopped/starting. A separate always-on stream is correct. |
| Poll only, no SSE | Works, but the owner chose live transitions; polling remains a fallback. |
| A separate `agent_processes` current-state table | Duplicates `instances` and creates a two-writer consistency problem. |
| Persist full container logs | The owner chose events + history, not log streaming; logs would add size/redaction risk. |
| Make start asynchronous (`202`) | Not required to fix visibility; the sync contract is preserved. An `?async=1` mode can be added later. |
| Include OpenCode turn errors in process history | Turn errors are already first-class chat events; mixing them would blur process and conversation state. |
| Let the reconciler trust Docker's `running` | Reproduces the reported confusion: a readiness error or crash-stale `starting` would flip to running without OpenCode being ready. The attempt owner or a readiness probe is authoritative. |

## 15. Impact

| Area | Change |
| --- | --- |
| Store/migrations | v23: `instances` `process_*` columns + `agent_run_events` + indexes/CHECKs. Forward-only. |
| Store helper | New process read/write helpers next to `src/store/runtime-state.ts`. |
| InstanceManager | `#transitionProcess`, `#launches`, attempt id, phase writes, sanitized error capture, reconnect transitions, reconciler authority/cutoff, direct-writer routing, non-terminal restart stop. |
| Runtime status read | `GET /api/apps/:app/runtime` adds `process`; new `GET /api/apps/:app/process`; new SSE `/api/apps/:app/process/events`. |
| Site props | `SiteModel` carries process detail for chat/app/overview; chat props extended; overview `processes` summary. |
| UI | ChatPage/ChatThread distinct states; AppPage phase/error/history; overview summary; a process composable/store; Start gating from server state; state precedence over 503. |
| Tests | Migration backfill/CHECKs; store; manager transitions/idempotency/readiness/reconnect/reconciler/crash/restart/non-terminal stop; sanitizer; HTTP read/pagination/SSE snapshot-race/global-id/dedupe/limit; jsdom cases for `running`+sessions-503, `stopped`+`agent_stopped`, `error`, `agent_unavailable`, `agent_starting`, `default_image_unavailable`; E2E remount + error. |
| Docs | `docs/current-state.md` (schema v23, API, UI), design/plan/journal indexes. |

## 16. Non-goals

- Container log streaming in the process UI.
- Historical charts, metrics, alerting, or notifications.
- Turn-level errors, retries, queueing, or compaction.
- Multi-user, RBAC, or cross-project visibility bypass.
- A new fleet "processes" page; the overview summary is the fleet surface.
- Changing the sync start contract or the `RuntimeAppState` vocabulary.
- Backfilling history that predates migration v23.
- Cancelling an in-flight start (Stop during `starting` still waits for the attempt to finish, as
  today).

## 17. Resolved owner decisions (2026-11-07)

All decisions are closed; there are no open questions for this stage.

1. **Scope.** All process lifecycle events with durable history: start, lazy start, reconnect,
   restart, stop, crash, OOM, out-of-band stop, and readiness failure.
2. **Surfaces.** Chat and the application page, plus a compact fleet-overview summary.
3. **Delivery.** SSE with a snapshot and a per-app `lastEventId`; polling remains a fallback.
4. **Retention.** 1,000 events per app and 30 days, whichever comes first.
5. **Overview.** Compact block with counts and up to five affected apps (starting, stopping, error).
6. **Error text.** Sanitized runner/container text is visible; no secrets; unknown errors show a
   generic message keyed by code.
7. **Lazy starts.** Recorded as a new attempt with source `system` and a caller reason.
8. **Stopping count.** The existing coarse `starting` count may include `stopping`; the new block
   splits them by phase.
9. **Restart-on-stopped.** No-op, no attempt (current behavior).
10. **Stop from error.** Clears the current error fields; the error event stays in history.

## 18. Review

### Round 1 (`oracle`, 2026-11-07): FAIL (revise and re-review)

The durable-process + always-on SSE direction was accepted; the design was not plan-ready. Blockers:
reconciler overwriting a terminal error with Docker `running`; v23 phase backfill using coarse states
not in the phase enum; `#starts` inside the lock and the initial-write timing; history outside the
lock and behind `observeRuntime`'s early return; restart's `#stopLocked` writing a terminal
`stopped`. Majors M1-M11 were folded into the first revision.

### Round 2 (`oracle`, 2026-11-07): FAIL (focused round 3)

All round-1 blockers and majors were verified as resolved in the text. This revision closes the five
round-2 blockers and the majors:

- **B6 — launch promise type/entry-point registration.** §7.4: one `Promise<string>` per app;
  `ensure`, `beginRestart`, `restartIfRunning`, `rollbackImage` register before their locks/202;
  `#restartLocked` is a locked helper and does not register; restart-during-start chains after the
  in-flight launch; start-during-restart joins it.
- **B7 — restart-on-stopped and preflight ordering.** §5.3/§7.7: restart of a stopped app is an
  explicit no-op with no attempt; the settings `preflightRestart` and `rollbackImage` paths write
  `requested` before their preflight and `error`/`image_unavailable` on failure.
- **B8 — non-terminal restart stop vs the generic writer.** §7.7: the restart stop suppresses
  `#recordStatusById`'s terminal write, event, coarse-state change, and observation; the stop-failure
  path writes `error`/`runtime_unavailable`.
- **B9 — age cutoff vs a healthy recovered app; authority wording.** §7.6: always run a readiness
  probe before interrupting, even after the cutoff and even when Docker reports `running`; interrupt
  only when the runtime is absent or the probe fails; "the attempt owner **or** a successful
  readiness probe writes `ready`".
- **B10 — reconnect path writes nothing.** §7.2/§5.3: reconnect writes `starting`/`waiting_ready`
  before readiness when the persisted state is not `running`, `running`/`ready` + error clearing on
  success, and `error`/`failed` on token/readiness failure.
- **M12 — writer trigger misses epoch/OOM.** §7.8: the trigger includes epoch/restart-count/
  exit/OOM/identity changes, not only coarse state/phase.
- **M13 — lock ownership.** §7.1/§7.8: the helper never locks; callers hold it; `#handleRestartFailure`
  is wrapped in the lock; `#recordSkillsError` is already under it; `probeStatus` is wrapped.
- **M14 — SSE global ids/dedupe.** §8.3: per-app ids are non-contiguous; gap detection never assumes
  `id+1`; every post-snapshot delivery is filtered/deduped; the snapshot is one query; 429 closes the
  EventSource; `stream.warning` producers are defined.
- **M15 — error stickiness/retention.** L3/§6/§7.6/§11: history is kept until retention prunes it;
  current errors clear on a new attempt, reconnect success, explicit stop, or readiness recovery.
- **M16 — writer transaction/identity.** §7.1: the helper input includes the runtime-identity
  payload and writes it in the same transaction, preserving COALESCE/started_at semantics and
  `#queueObservation`.
- Minors m1-m9 are folded into §6 (stopping consequence), §7.2 (deployment guard/reconnect),
  §10 (taxonomy), §9.2 (legacy error text), §11 (unfiltered prune), §15 (explicit jsdom cases),
  §8.3 (429 close, buffer warning), and §7.2/§7.5 (`started_at`).

### Round 3 (`oracle`, 2026-11-07): PASS — plan-ready

All five round-2 blockers (B6-B10) and all five majors (M12-M16) were verified as resolved in the
body, with no new plan-blocking contradiction. Non-blocking nits folded: restart attempt threading
(§7.2 step 4), the stop-failure restore rule (§7.7), and the `#recordSkillsError` lock note (§7.8).

## 19. References

- `docs/current-state.md` - runtime topology, state vocabulary, chat/SPA surfaces, schema versions.
- `docs/design/agent-runtime.md` - runtime API and lifecycle requirements R12/R18.
- `docs/design/agent-process-protection.md` - crash/OOM/reconcile observations and session notices.
- `docs/process.md` - delivery pipeline, reviewers, artifacts, verification, commit policy.
- `src/opencode/manager.ts` - `ensure`, `#ensureLocked`, `#recordStatus`, `#reconcileStatuses`,
  `#stopLocked`, `#restartLocked`, `#handleRestartFailure`, `#recordSkillsError`, `probeStatus`.
- `src/opencode/recovery.ts` - `observeRuntime` early return and notice-only role.
- `src/http/prompts.ts` - existing app SSE and its running-only gate.
- `src/http/handler.ts` - `GET /api/apps/:app/runtime`.
- `src/http/server.ts` - route dispatch order.
- `src/store/migrations.ts` - schema and the v22 tail.
- `src/images/service.ts`, `src/coordinator/provision.ts`, `src/git/env.ts` - existing
  input-specific sanitizers.
