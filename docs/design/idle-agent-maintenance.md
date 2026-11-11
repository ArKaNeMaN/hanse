# Design - Idle agent maintenance

Status: **revision 7 - proposed** (design review round 6 PASS WITH FIXES; clarifications folded). This
document is the design contract for automatic idle stop, automatic image update, automatic image
pull, and the chat "Rebuild only" action. The review history is in §18. Baseline correction: the
migration number is corrected to v27 because stage 0041 (telegram notifications) owns migration v26.

Scope: per-application agent maintenance driven by real agent work:

- automatically stop a running agent that has performed no agent work for two days;
- automatically restart a running agent onto an already-built or already-pulled image after three
  hours without agent work, without applying pending configuration;
- automatically pull the configured default agent image and shared base image so an update can become
  visible without a human `docker pull`;
- add a "Rebuild only" action to the chat image banner when a rebuild is required, without leaving the
  chat page.

Out of scope: automatic image rebuilds, automatic rollback, automatic application of pending
settings/skills/model restarts, per-app maintenance UI, signature verification, multi-user/RBAC, and
changes to the existing chat/session/process semantics.

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
| Verification | `npm run lint`, `npm run typecheck`, `npm run typecheck:ui`, `npm test`, `npm run build`, `npm run check:ui`, `npm run check:sensitive`, `npm run test:e2e` (this stage changes a rendered route) |
| Commit policy | one stage, one coherent commit; owner authorizes; Conventional Commits |

Owner decisions (2026-11-10):

- Activity is any **agent work**. Opening the chat and any other `GET` operation do not count.
- Automatic pull is allowed.
- Demo services may be stopped; with such an idle period they would stop themselves.
- An agent waiting for an interactive answer (for example a pending question) counts as active. An
  agent that only produced a text answer containing questions counts as inactive.
- Rebuild stays explicit: the update condition additionally requires that the actual target image is
  already built or pulled.
- A "Rebuild only" button is wanted in the chat restart banner.
- Rollback is desirable but not required for the first iteration.
- **An active operator terminal WebSocket blocks both auto-stop and auto-update.** Previews/demo
  services remain stoppable; the IDE is a separate code-server container and has no app-specific
  attachment to guard.

---

## 1. Summary

Hanse already has a durable per-app process state and history (`instances.process_*`,
`agent_run_events`), a 15-second runtime reconciler, and a per-app image state machine
(`current`, `restart_required`, `rebuild_required`, `building`, `build_error`, `not_ready`,
`unknown`). It has no durable per-app activity clock, no idle policy, no automatic stop, and no
automatic update.

The design adds one durable activity timestamp per application, one activity service, one launch
snapshot/fingerprint, one terminal-session registry with a maintenance gate, and one maintenance
scheduler:

1. **Activity clock**: `apps.last_agent_activity_at` is updated only by real agent work: prompt
   dispatch, a busy/retry status observation, an answered or rejected interactive prompt, a resume,
   compaction, a handoff dispatch/reply, and a successful start/restart. `GET` routes, chat page
   opens, drafts, SSE heartbeats, terminal/preview/IDE traffic, and settings reads never update it.
2. **Live active check**: before acting, the scheduler asks the running agent whether it is busy or
   retrying, whether a v1 **or v2** question/permission is pending, whether a recent send is pending,
   whether a recovery row is still busy/retry (including subagents), or whether a one-shot handoff is
   dispatching/in progress. Prompt-source failures are handled per source with **strict** clients: a
   404/405 on a source that has never succeeded is unsupported and empty; any other failure, a
   malformed response, or a 404 after a previous success is active (fail closed). A running but
   unprobeable endpoint also means active.
3. **Auto-stop**: a running app whose activity clock is older than two days, whose live active check
   is false, and whose terminal/maintenance gate is clear is stopped through `InstanceManager`, with
   source `system` and reason `auto_stop`.
4. **Auto-update**: a running app whose activity clock is older than three hours, whose live active
   check is false, whose terminal/maintenance gate is clear, whose image state is
   `restart_required`, whose target image identity is unchanged, and whose launch fingerprint is
   unchanged is restarted onto that exact target image, with source `system` and reason
   `auto_update`. The fingerprint and image identity guards are mandatory: a restart re-applies
   settings, skills, model profile, provider keys, git credentials, MCP config, process rule, app
   instructions, and baseline plugins; applying any of them silently would violate the "settings
   never restart silently" invariant. `rebuild_required`, `building`, `build_error`, `not_ready`, and
   `unknown` are skipped; a rebuild remains a human action.
5. **Auto-pull**: the runner gains a bounded, exact-allowlisted, streaming `POST /v1/images/pull`,
   serialized with builds/GC/purge by a shared image-mutation mutex. The runner enforces a
   fail-closed disk guard before and during the pull. The coordinator pulls the configured default
   agent image and, when configured and used, the shared base image on a schedule. A pulled image
   becomes a `restart_required` target for default-image apps; a changed base only makes a
   build-configured app `rebuild_required` and still needs an explicit rebuild.
6. **Rebuild only**: the chat image banner gains a secondary action for `rebuild_required` that runs
   the existing build route and stops before restart; when the build is ready the banner switches to
   the normal restart action.

The design deliberately keeps image rebuilds and pending configuration restarts manual. It changes
the documented "builds and restarts are explicit" rule only for the image-restart case that the owner
asked for.

## 2. Current behavior and constraints

### 2.1 Existing state

- Process state: `instances.process_*` and `agent_run_events` (migration v23); the single writer is
  `InstanceManager.#transitionProcess()` (`src/opencode/manager.ts:2828`).
- Runtime reconciliation: `InstanceManager.startStatusReconciler()` every 15 seconds
  (`src/opencode/manager.ts:1801`), with session-status sampling
  (`src/opencode/manager.ts:2720`).
- Stop: `InstanceManager.stopApp()` (`src/opencode/manager.ts:1674`) takes the per-app lock, checks
  the deployment lock, records a stop intent, deletes the container, clears previews and the monitor,
  and revokes the MCP token. It has no HTTP/UI caller today.
- Restart: `InstanceManager.beginRestart()` / `restartIfRunning()` (`src/opencode/manager.ts:1832`,
  `1864`), with a durable restart claim (`restart_claims`), image preflight, stop, and ensure.
- Image state: `ImageService.status()` / `imageState()` (`src/images/service.ts:451`, `493`) and
  `deriveImageState()` (`src/images/service.ts:201`).
- Image build: human-only `ImageService.build()` (`src/images/service.ts:371`) and
  `POST /api/apps/:app/build` (`src/http/images.ts:212`).
- Image identity: local Docker image IDs and manifest digests only; the coordinator never queries a
  registry (`src/images/service.ts:1326`).
- Runner image endpoints: build, status, inspect, usage, GC (`src/runner/server.ts:1302-1357`); there
  is no pull endpoint. The Docker transport buffers responses (`src/runner/docker.ts`), and
  `ImageBuildService` owns a private `#active` build marker; there is no shared image-mutation mutex
  or streaming Docker method.
- Chat image banner: `imageWarningFromView()` (`assets/chat-core.js:3785`) returns one action;
  `ChatImageWarning.vue` renders one button; `ChatPage.vue:1066` executes `build_start`,
  `rebuild_restart`, or `restart`. `ImageWarningAction` and the `session-storage` image-intent type
  do not include `rebuild`.
- Activity signals today: `session_state.last_activity_at` is bumped by chat sends **and** by draft
  `GET`/`touch` (`src/chat/state.ts:208`); `session_resume.last_busy_seen_at` covers busy/retry only;
  `instances.heartbeat_at` is written only at launch; `projectLastActivity` is handoff-only.
- Interactive prompts have **two sources**: v1 `/question` + `/permission` and v2
  `/api/question/request` + `/api/permission/request` with an app directory. The HTTP list route
  queries all four with `Promise.allSettled` (`src/http/prompts.ts:488-542`). The v2 list functions
  return `[]` when `data` is missing/not an array (`src/opencode/client.ts:1018-1026`,
  `1059-1067`), and the v1 list functions do not validate `Array.isArray`; a malformed response can
  look like "no pending prompt". The activity path needs strict variants.
- `listSessionStatuses` is non-strict and returns `{}` for a malformed 200 body; a strict variant
  exists (`src/opencode/client.ts:306`).
- The startup reattach path returns before `#running.set()` when context monitors are disabled
  (`src/opencode/manager.ts:2292`), and the 15-second sampler iterates `#running`. Activity sampling
  must not depend on context monitors.
- Drain is separate from the external deployment lock: HTTP mutations are blocked by
  `drainingResponse` (`src/http/server.ts:290`), but `InstanceManager` does not throw on drain.
- `#stopLocked` derives `source` from the stop reason (`delete` is `system`, everything else is
  `operator`), and `#restartLocked` / `#handleRestartFailure` hardcode `operator` / `restart`
  (`src/opencode/manager.ts:1734`, `1971-1978`, `2007-2038`). New system actions need explicit
  source/reason plumbing.
- `#freshIntent` in `ProcessRecovery` recognizes only `restart` / `stop` / `delete` stop reasons, and
  the resume/schedule decisions compare the returned reason to the literal `"operator_restart"`
  (`src/opencode/recovery.ts:1451`, `1461`, `1462`). A distinct `auto_update` notice reason would be
  treated as `skipped_stopped` unless those comparisons change.
- `SESSION_NOTICE_REASONS` (`src/opencode/recovery.ts:87-106`) has no `auto_stop` / `auto_update`
  notice reason; `RESTART_REASONS` in the UI notice grouping has no `auto_update`.
- A restart re-runs `#ensureLocked`, which applies the current settings, skills, model profile,
  provider keys, git credentials, MCP config, process rule, app instructions, shared instructions, and
  baseline plugins. `pendingRestart` covers settings/skills/profile/providers/git/rule but is a
  point-in-time check and does not cover instructions/plugins; auto-update needs a launch snapshot and
  fingerprint captured and re-checked under the lock.
- `#ensureLocked` resolves the image from the live manifest (`resolveAgentImage`), while the guard's
  `imageState` is DB-derived; an agent can edit `.hanse/Dockerfile` between the guard and the launch
  and substitute a different image. Auto-update must pin the expected target image identity.
- The schema guard refuses to start an older binary against a newer schema
  (`src/store/database.ts:172-174`). Additive data compatibility does not make binary rollback safe.
- Terminal traffic is proxied by `src/http/terminal.ts` and is not persisted; there is no active
  terminal-session registry and the proxy does not take the manager's per-app lock.
- `ImageGcService.usage()` reports filesystem usage from `HANSE_HOST_WORKSPACE` plus Docker
  image/build-cache totals; the Docker data root may be on a different filesystem. `usage()` returns
  level `ok` when statfs fails (`src/runner/image-gc.ts`), which would make a pull disk guard
  fail-open.
- Many tests hardcode the current schema version (26), the future-schema value (27), and the
  `schemaVersion` response (26) in `test/migrations.test.ts`, `test/migrate-cli.test.ts`,
  `test/store.test.ts`, `test/settings-store.test.ts`, `test/skills-store.test.ts`,
  `test/deploy-http.test.ts`, and `test/http.test.ts`.

### 2.2 Constraints

- The coordinator is a single long-running Node process. In-process timers reset on every coordinator
  restart; durable timestamps are the source of truth.
- The runner is the only Docker-socket holder. The coordinator cannot pull images itself.
- All destructive lifecycle actions must respect the deployment lock, the in-process drain, the
  per-app lock, the restart claim, the deletion markers, and `lifecycleActivity` (`/readyz`).
- Builds are human-only and globally serialized in the runner; the first iteration must not start
  builds automatically.
- Settings and skills restarts are currently explicit by design; this design does not change that.
- The chat banner already distinguishes `restart_required` and `rebuild_required`; the new action
  must fit that vocabulary.
- `#withAppLock` is not re-entrant. Any guard evaluated under the lock must not call a manager method
  that takes the same lock.

## 3. Requirements

| ID | Requirement |
| --- | --- |
| R1 | A durable per-application agent-activity timestamp exists and survives coordinator restarts. |
| R2 | The timestamp is updated only by real agent work: prompt dispatch, busy/retry observation, an answered/rejected interactive prompt, a resume, compaction, a handoff dispatch/reply, and a successful start/restart. `GET` requests, chat page opens, drafts, SSE heartbeats, terminal/IDE/preview traffic, settings reads, and an abort request do not update it. |
| R3 | A live active check treats the agent as active when any session is `busy` or `retry`, a v1 or v2 question/permission is pending, a recent send is pending, a recovery row is busy/retry (including subagents), or a one-shot handoff is dispatching/in progress. Strict prompt clients make malformed responses active; a 404/405 is unsupported only for a source that has never succeeded, otherwise active; all-unsupported sources are inactive. A running but unprobeable endpoint also means active. |
| R4 | A running app with no agent work for two days, a false live active check, and a clear terminal/maintenance gate is stopped through the manager with source `system` and reason `auto_stop`. |
| R5 | A running app with no agent work for three hours, a false live active check, a clear terminal/maintenance gate, image state `restart_required`, an unchanged target image identity, and an unchanged launch fingerprint is restarted through the manager with source `system` and reason `auto_update`. |
| R6 | `rebuild_required`, `building`, `build_error`, `not_ready`, `unknown`, changed launch configuration, changed target image, stopped, deleting, master, starting, stopping, and restarting apps are skipped by auto-update. No automatic build is triggered. |
| R7 | The runner exposes an authenticated, exact-allowlisted, streaming, serialized image-pull endpoint with a fail-closed runner-side disk guard before and during the pull, strict reference validation, client-disconnect abort, and sanitized errors; the coordinator pulls the configured default and base references on a schedule, passes a drain signal, invalidates the image identity cache, and never pulls during drain. |
| R8 | The chat image banner offers a "Rebuild only" action for `rebuild_required`; it runs the existing build and does not restart; after the build is ready the banner shows the normal restart action. |
| R9 | Auto actions are audited and observable: structured logs, an `events` row, process-history reasons `auto_stop`/`auto_update`, a global pull audit for every attempt, and an auto-pull audit with old/new image identity and resolved digest; failures are bounded and retried with a cooldown. |
| R10 | Existing behavior is preserved: manual start/restart/stop, the image state vocabulary, the chat/session/process contracts, the deployment lock, the restart claim, and the existing verification gates. |
| R11 | Activity sampling and the live active check work without context monitors; the startup reattach path populates the running/endpoint state even when monitors are disabled. |
| R12 | The scheduler respects the in-process drain and shutdown state, not only the external deployment lock; drain is re-checked inside the destructive guard and aborts an in-flight pull. |
| R13 | `auto_stop`/`auto_update` are recognized by `ProcessRecovery.#freshIntent`, the restart-like resume predicate, session notices, resume semantics, and the UI notice grouping. |
| R14 | An active operator terminal WebSocket blocks both auto-stop and auto-update; terminal registration is serialized with the destructive guard; previews remain stoppable; IDE is not app-specific. |
| R15 | The launch fingerprint is written only by the destructive start/restart path, is computed from the same captured snapshot that is applied, and hashes instruction content, not paths. |

## 4. Decision

Adopt a **durable activity clock, a launch snapshot/fingerprint, a terminal maintenance gate, and a
separate maintenance scheduler**, not an extension of the 15-second reconciler and not a reuse of
`session_state.last_activity_at`.

The scheduler has two independent timers:

- an **idle timer** (default 5 minutes) that evaluates auto-stop and auto-update;
- a **pull timer** (default 15 minutes) that pulls the configured default/base references.

Both timers are `unref()`ed, are stopped during drain/shutdown, are single-flight, and never block
the HTTP server. The scheduler reads the durable clock, asks the live active check, checks the
in-process drain, the deployment lock, the terminal gate, and calls the existing manager lifecycle
methods. It never talks to Docker directly.

The activity service is a small collaborator, not a new domain aggregate:

- it owns the durable `apps.last_agent_activity_at` write and the live active query;
- it is injected into `InstanceManager`, the chat send/answer/compact routes, and the handoff
  dispatcher;
- it does not observe every OpenCode delta; the 15-second status sampler and explicit work hooks are
  enough for 3-hour/2-day thresholds;
- it resolves the running endpoint through a lock-free manager callback that probes the runtime and
  installs endpoint authorization, not through the monitor-gated `#running` map.

The launch snapshot is captured once by the destructive start/restart path. The fingerprint is
computed from that snapshot, compared to the expected fingerprint before stop and before apply, and
the **same snapshot** is used to build the launch. A concurrent settings/skill/instruction change
therefore cannot be applied silently after the check. Only the destructive `#ensureLocked` path writes
`instances.applied_launch_hash`; reconnect/status/reconcile preserve the existing value.

## 5. Activity model

### 5.1 Definition

"Agent work" is any of:

- a prompt dispatched to the agent (operator send, handoff dispatch, resume);
- an OpenCode `session.status` of `busy` or `retry`;
- an interactive `question.asked` / `permission.asked` (the agent is waiting for input);
- a `question.replied` / `question.rejected` / `permission.replied` (the wait ended; the clock resets);
- a manual or automatic compaction;
- a one-shot handoff dispatch to the app or a reply routed to the app;
- a successful start or restart (a new work period begins).

"Not agent work" includes:

- any `GET`: chat page, session list, messages, drafts, context, runtime, process, image, previews,
  settings, app page, health/readiness;
- an open SSE connection or its heartbeat;
- terminal, IDE, preview, and SSH traffic;
- a text answer that contains questions but leaves no pending interactive prompt;
- an abort/stop request itself. An abort is not a work event; the preceding busy/retry samples keep
  the clock fresh, and a full stop does not need an activity clock.

A client-side queued prompt that has not become active is not agent work. Once the queue head starts,
the session is `busy`/`retry` and the sampler touches the clock. The chat queue is not a durable
server-side queue; losing it on an auto-stop/update is accepted for this iteration.

### 5.2 Durable clock

Add `apps.last_agent_activity_at TEXT` in migration v27. The value is a canonical ISO-8601 UTC
timestamp with milliseconds (`new Date(at).toISOString()`). A column `CHECK` enforces the canonical
shape so lexical comparison is valid. The write is monotonic and best-effort:

```sql
UPDATE apps
SET last_agent_activity_at = @at
WHERE id = @id
  AND (last_agent_activity_at IS NULL OR last_agent_activity_at < @at);
```

`touch()` catches and logs a database/CHECK failure; it never throws into chat send, handoff
dispatch, or recovery.

The migration creates the handoff index **before** the backfill and backfills from the greatest real
signal, including handoff work:

```sql
ALTER TABLE apps ADD COLUMN last_agent_activity_at TEXT
  CHECK (
    last_agent_activity_at IS NULL OR last_agent_activity_at GLOB
      '[0-9][0-9][0-9][0-9]-[0-9][0-9]-[0-9][0-9]T[0-9][0-9]:[0-9][0-9]:[0-9][0-9].[0-9][0-9][0-9]Z'
  );

-- Created before the UPDATE so the from-side backfill uses the index.
CREATE INDEX handoffs_from_app_state ON handoffs(from_app_id, state);

UPDATE apps
SET last_agent_activity_at = MAX(
  apps.created_at,
  COALESCE((SELECT i.started_at FROM instances i WHERE i.app_id = apps.id), apps.created_at),
  COALESCE((SELECT MAX(s.last_activity_at) FROM session_state s WHERE s.app_id = apps.id), apps.created_at),
  COALESCE((SELECT MAX(r.last_busy_seen_at) FROM session_resume r WHERE r.app_id = apps.id), apps.created_at),
  COALESCE((SELECT MAX(COALESCE(h.last_message_at, h.updated_at)) FROM handoffs h WHERE h.from_app_id = apps.id), apps.created_at),
  COALESCE((SELECT MAX(COALESCE(h.last_message_at, h.updated_at)) FROM handoffs h WHERE h.to_app_id = apps.id), apps.created_at)
);
```

The `handoffs_from_app_state` index is non-partial so it serves both the one-shot source-side live
check and the one-time backfill; the to side uses the existing `handoffs_to_app_state`. The existing
thread-source partial index remains for thread queries. No `apps(last_agent_activity_at)` index: the
candidate query filters running instances and uses `COALESCE`, so such an index is not usable and
would add a write on every touch.

`session_state.last_activity_at` is inflated by draft `GET`/`touch`; for a one-time backfill this
errs toward active, which is safe. `handoffs.updated_at` includes non-work transitions (expiry, GC,
retry); it also errs toward active and is acceptable for a one-time backfill. `agent_run_events` and
`process_updated_at` are deliberately excluded: a stop/transition is not work and would defeat idle
detection. The CHECK validates the canonical **shape**, not calendar validity: a value such as
`2026-13-99T99:99:99.999Z` passes the GLOB, but only `toISOString()` writes and every backfill source
is canonical. It is fail-closed: if legacy data contains a non-canonical timestamp, the transaction
aborts and the upgrade must be fixed rather than silently accepting an unorderable value.

New rows may keep `NULL`; the scheduler falls back to `instances.started_at`, then `apps.created_at`.
An explicit start/restart writes the timestamp after the manager records `running/ready`. The
migration is data-compatible with N-1, but the schema guard blocks an older binary after v27 is
applied; rollback requires restoring the pre-v27 backup (see §19).

### 5.3 Launch snapshot and fingerprint

`InstanceManager` captures a `LaunchSnapshot` for the destructive path. It contains:

- the settings snapshot (effective settings, provider keys, auth hash, git auth hash);
- the OMO profile content hash, skills hash, model-provider registry hash, and process-rule hash;
- the authoritative app contract/instructions **content** and shared-instruction **content**;
- baseline plugins (`HANSE_OMO_PLUGIN`), the codegraph command, the coordinator command, the
  coordinator MCP/web overlay, and the permission policy inputs;
- `resolveRuntimeResources()` and `HANSE_AGENT_API_BASE` (deployment-level launch inputs).

The fingerprint is the hash of that snapshot. It deliberately excludes the **target image** (the
intended change) and per-request data such as the agent token/password (persisted, stable). The
design says "every configuration input except the target image and per-request identity".

Only the destructive `#ensureLocked` path writes `instances.applied_launch_hash` (migration v27 adds
the column; legacy rows stay `NULL`). Reconnect, status probe, reconcile, and rollback preserve the
existing value. A legacy `NULL` fingerprint is "unknown" and skips auto-update until the next destructive start/restart (explicit or lazy); any successful `#ensureLocked` writes it.

`restartIfRunning(app, { expectedLaunchFingerprint, expectedImageId })` captures/re-checks the
fingerprint and the resolved image identity under the per-app lock at the top of the destructive
branch (before any process transition). `#ensureLocked` captures its own `LaunchSnapshot` once,
computes the fingerprint from that same snapshot, compares it to the expected value, and applies from
that same snapshot. If it changed after the stop, the restart fails with `launch_changed` and leaves
the app in `error` rather than applying new configuration silently.

### 5.4 Write hooks

The service is called from:

| Source | Hook | Reason |
| --- | --- | --- |
| `InstanceManager` | after a successful destructive start/restart (`#ensureLocked` with the attempt's source/reason) | `start`/`restart` |
| `InstanceManager.#sampleAppSessionStatuses()` | any sampled `busy`/`retry` status | `status` |
| `InstanceManager.#startMonitor()` | `session.status` busy/retry, `question.*`, `permission.*` when a monitor is running | `status`/`waiting` |
| Chat send (`src/http/chat.ts`) | **before** `ensure` and again after the pending row is inserted | `prompt` |
| Chat answer/reject (`src/http/prompts.ts` question/permission routes) | input supplied | `answer` |
| Manual compact (`src/http/context.ts`) | compaction requested | `compact` |
| Handoff dispatcher (`src/coordinator/dispatcher.ts`) | target dispatch and source reply routing | `handoff` |
| Process recovery resume (`src/opencode/recovery.ts`) | resume prompt dispatched | `resume` |
| Context monitor auto-compaction | compaction started | `compact` |

The monitor hook is optional: the status sampler and the explicit routes must be sufficient when the
context monitor is disabled or disconnected. Event-level `message.part.delta` updates are deliberately
not used to avoid write amplification. `status` touches are coalesced to at most one database write
per app per 60 seconds; explicit work hooks always write.

Reconnect is not a work event and does not touch the clock. A coordinator restart reattaches running
apps but does not reset their idle period.

### 5.5 Live active check

`AgentActivityService.isActive(appId)`:

1. `InstanceManager.activityEndpoint(appId)` returns a tri-state:
   - `{ state: "not_running" }` when the runtime is stopped/absent (runner 404 / stopped status);
   - `{ state: "running", endpoint }` when the endpoint and password are available;
   - `{ state: "unprobeable", reason }` when the runtime is running/starting but the endpoint,
     password, authorization, or runtime probe cannot be resolved.
   `not_running` means not active; `unprobeable` means active (fail closed). The callback is
   lock-free and must never take `#withAppLock`; it is bounded by the same 5-second deadline as the
   live check.
2. `GET /session/status` with the strict parser: any `busy` or `retry` means active; a malformed
   response means active.
3. A `session_resume` row for the app with `observed_status IN ('busy','retry')` and a non-terminal
   resume state means active. This covers subagent sessions missing from the status map.
4. Pending prompts: query **all four strict sources** with `Promise.allSettled`:
   `listQuestionsStrict(endpoint)`, `listPermissionsStrict(endpoint)`,
   `listQuestionsV2Strict(endpoint, appDir)`, and `listPermissionsV2Strict(endpoint, appDir)`.
   These variants throw on a non-array body, a missing/non-array `data`, or a malformed entry.
   - A fulfilled non-empty list means active.
   - A 404/405 means that source is unsupported **only if it has never returned a successful
     response for this app** (in-memory capability cache); otherwise it is a transient failure and
     means active.
   - Any other rejection or a malformed response means active (fail closed).
   - If every source is unsupported (404/405 and never successful), no prompt capability exists;
     treat as inactive.
   - The cache never short-circuits the probe: all four sources are queried on every check; the cache only interprets a 404/405 (unsupported if that source has never succeeded). Key it by runtime epoch and clear it on start/restart so an image update can discover a newly supported v2 endpoint.
5. `pending_sends` for the app with state `sending` or `unknown` and `updated_at` within
   `PENDING_CONFIRMATION_STALE_MS` (15 minutes) means active. Older unresolved rows are user-visible
   and do not block maintenance forever.
6. A one-shot handoff in `awaiting_approval`, `dispatching`, or `in_progress` where the app is the source or target means
   active; the source-side query uses `handoffs_from_app_state`, the target side uses
   `handoffs_to_app_state`. A thread message in `dispatching` or `waiting_operator` involving the app means active; the
   query uses `handoff_messages_due(state, id)` and the header indexes. A thread `in_progress` header
   alone does not; its 24-hour idle TTL is the thread's own lifecycle.
7. Every prompt/status query has a 5-second timeout. The idle pass is single-flight, has bounded
   per-app concurrency, and has an overall deadline. Unexpected failures return active and log a
   bounded warning once per app per hour.

The check is conservative: an `unknown` OpenCode status, a missing subagent status, a malformed
response, or a transport failure never causes a stop or restart.

### 5.6 Sampler independence

The 15-second sampler and the activity service must not depend on context monitors:

- `#resumeOne` installs endpoint authorization and sets `#running` for every running app, even when
  `#monitorsEnabled()` is false; only `#startMonitor` remains conditional.
- `#sampleAppSessionStatuses` continues to run for every attached app and touches the activity clock
  on `busy`/`retry`.
- `activityEndpoint` uses `runtime.status` and endpoint auth when the in-memory entry is absent, so a
  coordinator restart cannot silently disable idle maintenance.
- `#resumeOne` reads and stores `applied_skills_hash` as well as `applied_settings_hash`/`applied_profile`, so `pendingRestart` classifies skill changes correctly and does not fall back to the legacy settings-only branch after a coordinator restart; the reconnect path already does this.

### 5.7 Terminal registry and maintenance gate

`src/http/terminal.ts` gains a `TerminalSessionRegistry`:

- `register(appId): (() => void) | undefined` increments on a successful WebSocket upgrade and
  returns an idempotent release; it returns `undefined` when a maintenance gate is active for the app.
  Close/error/termination calls release.
- `isActive(appId): boolean` is true while at least one terminal WebSocket is attached.
- `beginMaintenance(appId): () => void` sets a per-app maintenance flag; `register` refuses while the
  flag is set. The manager stop/restart calls `beginMaintenance` under the per-app lock before the
  destructive branch and releases it after. This closes the attach-after-guard window: a terminal
  either registers before maintenance (the guard sees it and skips) or is refused during maintenance
  and the proxy returns `409 agent_maintenance`.
- `beginMaintenance(appId)` is synchronous and is called inside the per-app lock **before** the guard reads `isActive`: `stopApp` calls it in the locked body before the guard; `restartIfRunning` calls it in `#runRestartClaimed` after the restart claim is acquired and the per-app lock is held, before `#restartLocked` evaluates the guard. It is refcounted, so concurrent/nested callers cannot clear it early. This closes the attach-after-guard window: a terminal either registers before maintenance (the guard sees it and skips) or is refused during maintenance and the proxy returns `409 agent_maintenance`. The guard checks `terminalSessions.isActive(appId)`, never the maintenance flag. `register` runs before the coordinator forwards the upstream 101. Release it in a `finally` on every early return, including a false guard; the claim-failure path does not set the gate.
- The registry is in-memory and reset on coordinator restart (a restarted coordinator has no live
  terminal sockets). An idle terminal blocks maintenance indefinitely; the owner accepted this
  trade-off.

An active terminal blocks auto-stop and auto-update. Previews/demo services remain stoppable. The IDE
is a separate code-server container and has no app-specific attachment to guard.

## 6. Auto-stop

- Threshold: `now - lastAgentActivityAt >= HANSE_AGENT_AUTO_STOP_MS` (default 2 days).
- Candidate: a running app with `process_phase` absent or `ready`, not master, not deleting, not
  starting/stopping/restarting, and not in an active image build.
- The scheduler checks the external deployment lock and the in-process drain before the pass and
  before each action.
- `stopApp` evaluates the destructive guard inside the per-app lock before calling `#stopLocked`. It first checks the internal concurrency signals (`isRestarting`, `isLaunching`, `isBuilding`); a top-level stop owns neither a restart claim nor a launch, so these are never self-referential. It then evaluates the caller guard, which re-checks deployment lock, drain, `terminalSessions.isActive(appId)`, process phase `ready`/absent, the durable clock, and `activity.isActive(appId)`. The durable-clock check uses the same `MAX(COALESCE(a.last_agent_activity_at, a.created_at), COALESCE(i.started_at, a.created_at), a.created_at)` fallback as the candidate query. `#stopLocked` itself evaluates no internal concurrency checks and no caller guard, so the nested stop from `#restartLocked` and `#stopForDeletionLocked` cannot self-collide. A false guard returns false with no process-state change. `isBuilding(appId)` is `imageState(appId).state === "building"` (or an equivalent lock-free check); it must not take `#withAppLock`.
- Action: `manager.stopApp(appId, { source: "system", reason: "auto_stop", guard })`.
- `stopApp` deletes the container, clears previews and the monitor, and revokes the MCP token.
  Sessions, messages, drafts, attachments, handoff rows, and the app image remain on disk.
- A stop is not a pause: terminals, preview services, and in-container background processes die. The
  terminal gate prevents killing a live operator terminal; demo previews may stop.
- If the app is already stopped, `#stopLocked` records the stop intent and returns `false`; the scheduler's running-only candidate query normally prevents this.
- If auto-stop and auto-update are both due, **stop wins**: stopping is cheaper and the next start
  uses the current target image anyway.
- A stop failure is logged, recorded in the process history, and the app gets a one-hour cooldown
  before the next attempt.
- The stop intent is `auto_stop`; the process history source is `system` and the reason is
  `auto_stop`. `#freshIntent` recognizes `auto_stop`, `SESSION_NOTICE_REASONS` includes it, and the
  chat notice label map says "Stopped automatically after inactivity". Resume state is
  `skipped_stopped`.
- Auto-stop does not change configuration. A later start applies the current configuration by the
  normal start contract; the `app.auto_stopped` audit includes the pending-restart reasons so the
  operator can see that a start will apply them.

## 7. Auto-update

- Threshold: `now - lastAgentActivityAt >= HANSE_AGENT_AUTO_UPDATE_MS` (default 3 hours).
- Candidate cutoff: the idle pass queries with `cutoff = min(enabled thresholds)`. With both enabled,
  the 3-hour cutoff returns both update and stop candidates; the pass branches stop first when the
  2-day threshold is also met. If one timer is disabled, the other threshold is the cutoff.
- Candidate: the same running/non-deleting/non-master/non-transitioning set, with drain and
  deployment-lock checks.
- The destructive guard is evaluated at the **top** of `#restartLocked`, before the initial `starting/requested` transition, `recordStopIntent`, and any side effect. The restart claim and launch are acquired before `#restartLocked` by `restartIfRunning`; they are the **current attempt** and are deliberately excluded from the in-lock guard. `#acquireRestartClaim` already rejects another restart, `#registerLaunch` chains the current launch after any earlier one, and the per-app lock excludes a concurrent `ensure`. The caller guard re-checks deployment lock, drain, `terminalSessions.isActive(appId)`, process phase `ready`/absent, the durable clock, `activity.isActive`, `imageState === "restart_required"` (which also excludes `building`), the resolved target image identity, and the launch fingerprint. `beginMaintenance` is already set under the lock before this guard; `#stopLocked` does not re-evaluate it. The internal `#stopLocked` call from `#restartLocked` (and `rollbackImage`) passes no guard; `#stopLocked` evaluates no internal concurrency checks and no caller guard, so the stop half always runs. A false guard returns false with no process-state change.
- Image condition: `ImageService.imageState(appId)` returns `restart_required` and the **resolved live image** (`resolveAgentImage` + runner inspect) has the guarded `targetImageId`. The runner `ensure` also receives the optional `expectedImageId` (a Docker image ID, `sha256:...`), re-inspects the allowlisted reference immediately before create, **creates the container from the pinned image ID** (not the tag), then verifies the created container's image ID and removes/aborts it on mismatch before start. If an existing running container matches the spec hash, the runner still verifies its image ID equals `expectedImageId` when provided; otherwise it returns `409 image_changed`. This closes the inspect-to-create window; a concurrent pull that moves the tag cannot change the created container. This prevents an agent-edited `.hanse/Dockerfile` from substituting a different image between the guard and the launch. A mismatch skips with `image_changed`. The adopted-container path is verified too; if inspection is unavailable and `expectedImageId` is supplied, the runner fails closed.
- **Configuration guard:** `pendingRestart(appId).pending` must be false and
  `applied_launch_hash === launchFingerprint(LaunchSnapshot)`. If either differs, skip with
  `agent_auto_update_skipped` reason `configuration_changed` (log once per cooldown). A restart
  re-runs `#ensureLocked`; applying settings/skills/model/providers/git/rule/instructions/plugins
  silently is forbidden.
- Action: `manager.restartIfRunning(app, {
  source: "system",
  reason: "auto_update",
  guard,
  expectedLaunchFingerprint,
  expectedImageId,
  })`.
- The restart uses the existing claim, image preflight, stop half, and ensure half. It is not
  zero-downtime. If the restart fails, the app stays in `error` and the operator can use the existing
  manual rollback. Automatic rollback is deferred.
- The stop intent is `auto_update`; `#freshIntent` recognizes it, the restart-like predicate covers
  `auto_update`, and `SESSION_NOTICE_REASONS`/`RESTART_REASONS` include it. The process history
  source is `system` and the reason is `auto_update` for every transition, including failures.
- On success, the activity clock is reset and the process history records `auto_update`.
- A failure gets a one-hour cooldown per app; the scheduler does not retry every tick.

## 8. Auto-pull

### 8.1 Runner endpoint

Add `POST /v1/images/pull` to the runner, before the generic `/v1/images/:id` route:

- Request: `{ "reference": "<image reference>" }`; the handler rejects a non-string with `400`.
- Auth: the existing runtime bearer token.
- Route ordering: the handler is registered after the bearer-token check and before the generic `/v1/images/:id` route; the request body is bounded like the other runner JSON routes.
- Reference validation: a strict validator (not only `normalizeImageReference`) rejects multiple
  `@`, empty tags, malformed digests, control characters, and malformed registry/repository forms.
  Exact equality against `config.allowedImages`, `config.defaultImage`, or `config.baseImage` only.
  No `hanse-app-*` prefix rule (that rule belongs to inspect); app-built images are rejected. A
  digest is accepted but the coordinator skips digest-pinned references. The Docker API path uses
  `URLSearchParams` and the safe reference charset.
- Serialization: a shared `ImageMutationMutex` covers `ImageBuildService.start` (held for the entire
  asynchronous build, not only the `202`), `RunnerService.pull` (held until the Docker pull stream
  ends), and image GC/purge. A concurrent request returns `409 image_mutation_in_progress`, except
  build-vs-build and purge-vs-build, which keep the existing `build_in_progress` contract. The mutex
  is released in `finally`.
- The image-mutation mutex does not need to cover `RunnerService.ensure`; the pinned `expectedImageId` is the authority. If the runner cannot create by ID, it must re-inspect the created container and remove it on mismatch before `startContainer`.
- Streaming: add `DockerTransport.stream()` / `DockerClient.pullImage(reference, { signal })` that
  returns an async iterable of NDJSON lines. The existing 8 MiB buffered `DockerTransport.request`
  and the WebSocket `upgrade` method are not used. The parser has a bounded line/byte budget and
  reads `error`/`errorDetail`/`aux.ID`.
- Deadline: 10 minutes. The handler aborts the Docker stream on `response.on("close")` when
  `!response.writableFinished` (and on `request.socket` close), releasing the mutex promptly on
  coordinator disconnect/drain. It does not use `request.on("close")`, which can fire when the
  request body is complete.
- Body and mutex order: read and validate the request body before acquiring the image-mutation mutex. A periodic statfs failure during the pull aborts with `507 disk_guard_unavailable`. An old runner without the pull route returns `405` on the generic route; the coordinator treats `405` as an unsupported skip alongside `404`.
- Disk guard: the runner acquires the image-mutation mutex, calls `ImageGcService.usage()` before the
  pull, and rejects at `warning` or `critical` (75%/85%) with `507 disk_critical`; a failed/absent
  statfs (`disk === null`) also rejects with `507 disk_guard_unavailable` (fail closed). During the
  pull, a bounded periodic statfs aborts at `critical`. The usage filesystem is the configured
  `HANSE_IMAGE_DISK_PATH` (default `HANSE_HOST_WORKSPACE`); the deployment guide must tell operators
  to point it at the filesystem that backs Docker images (mount it read-only if different) or disable
  auto-pull.
- Response: `{ reference, previousImageId, imageId, changed, digest }`, where `previousImageId` is
  inspected before the pull and `digest` is the resolved repo digest when available.
- Failure is `502 pull_failed` with a control-character-stripped bounded message; the raw Docker
  stream is never echoed. The pull handler maps Docker failures to its own sanitized `RunnerError`;
  it must not rely on the generic `errorBody`, which currently echoes `DockerError.message`. A
  concurrent request is `409 image_mutation_in_progress`; a disallowed reference is
  `403 image_disallowed`.

### 8.2 Coordinator

- `RunnerImageClient.pull(reference, { signal })` combines the external signal with a 12-minute
  timeout (`AbortSignal.any`) and treats `409 image_mutation_in_progress`, `507 disk_critical`,
  `507 disk_guard_unavailable`, and `404`/`405` (old runner) as benign skips.
- `ImageService.pullConfigured({ signal, isDraining })` pulls the configured default agent reference
  and, when configured and at least one app uses the shared base, the base reference, sequentially and
  deduped. It skips a reference that contains a digest, skips when the deployment lock is active or
  `isDraining()` is true, skips at `critical` disk usage (runner-side guard is authoritative),
  invalidates the identity cache after a successful pull, and returns a bounded report. The scheduler
  passes the drain callback and signal; `ImageService` does not own the drain controller.
- The scheduler runs `pullConfigured()` on its pull timer (default 15 minutes). Pull failures are
  logged and do not stop the idle timer. An in-flight pull is aborted on drain/shutdown via the
  scheduler's `AbortController`, which is also passed to the runner request; the runner aborts the
  Docker stream on disconnect.
- The idle pass and the pull pass share one single-flight scheduler mutex, so a pull cannot complete while an auto-update is between its guard and its launch.
- After a pull, default-image apps with a new target image become `restart_required`; custom apps
  whose base digest moved become `rebuild_required` and wait for an explicit rebuild.
- A global `image.auto_pull` event is written for every attempt with
  `{ reference, previousImageId, imageId, digest, changed, outcome }`. Changed pulls additionally
  write `app.auto_pulled` for affected default-image apps. Disallowed/507 attempts are audited in the
  global event and logged at warn; they are not per-app events.

### 8.3 Risks

- Mutable tags mean auto-pull can introduce an unreviewed image. A digest-pinned deployment does not
  move, so auto-pull is a no-op there. Operators who require reproducibility should pin digests or set
  `HANSE_AGENT_AUTO_PULL_MS=0`. Signature verification is out of scope for this iteration; the
  residual supply-chain risk is accepted by the owner and must be documented in the deployment guide.
- Pulls consume bandwidth and disk. The runner-side fail-closed guard checks before and during the
  pull; the existing explicit image GC remains the cleanup path. If the Docker data root is on a
  different filesystem than `HANSE_IMAGE_DISK_PATH`, the guard may under-report; the deployment guide
  documents the assumption and the disable opt-out.
- Registry credentials stay in the Docker daemon; the coordinator never receives them.

## 9. Rebuild-only chat action

Current behavior:

- `imageWarningFromView()` returns one action. For `rebuild_required` it returns
  `{ action: "rebuild_restart" }`.
- `ChatImageWarning.vue` renders one primary button.
- `ChatPage.vue` starts a build, polls until it is no longer `building`, then calls `restart` (for
  `rebuild_restart`) or `start` (for `build_start`).

Change:

- Extend the warning shape with an optional secondary action:
  `{ tone, title, body, action, secondaryAction? }`. For `rebuild_required`:
  - primary: `rebuild_restart` ("Rebuild & restart");
  - secondary: `rebuild` ("Rebuild only");
  - body: "Rebuild and restart, or rebuild only to apply later."
- Add `"rebuild"` to the `ImageWarningAction` typedef, `imageActionLabel()`
  ("Rebuild only"), and the `session-storage` image-intent type/read guard.
- `ChatImageWarning.vue` renders the secondary button with the existing button classes and a distinct
  `data-chat-image-action="rebuild"` attribute; both buttons emit the action string.
- `ChatPage.vue` adds `"rebuild"` to the poll modes. After the build is ready, `rebuild` only refetches
  the image view; it does not call restart or start. It only continues when the view is
  `restart_required` (or `current`); a `build_error` never restarts onto the old image. The banner then
  shows the normal `restart_required` action. A toast says the image is built and a restart is
  required.
- The client maps action strings through a fixed switch; an unknown action is ignored, never turned
  into a URL.
- The build route is human-only. Add an explicit `isSameOrigin` check to **all** image mutations
  (build, rollback, check, gc); the current route relies on `SameSite=Strict` plus the human
  principal. Export/reuse the handler's helper. An absent Origin remains accepted; the cookie is the
  primary control.
- Update `test/chat-core`, `ChatImageWarning` tests, `session-storage` tests, `docs/design/chat-qa.mjs`
  button assertions, and add a rebuild-only E2E scenario. Add `/v1/images/pull` to the runner
  reserved-route test.

## 10. Data model (migration v27)

Logical model:

- The application aggregate owns its activity clock. No new table is needed.
- `apps.last_agent_activity_at` is nullable for legacy rows and is backfilled from the greatest real
  signal (start, session activity, busy observation, handoff activity, creation).
- `instances.applied_launch_hash` stores the launch fingerprint; legacy rows stay `NULL` and skip
  auto-update until the next explicit start/restart.
- No activity history table is added: `agent_run_events` records lifecycle actions, and `events`
  records the audit of auto actions.

Physical migration (database-engineer reviewed):

```sql
-- v27: durable per-app agent activity clock and launch fingerprint
ALTER TABLE apps ADD COLUMN last_agent_activity_at TEXT
  CHECK (
    last_agent_activity_at IS NULL OR last_agent_activity_at GLOB
      '[0-9][0-9][0-9][0-9]-[0-9][0-9]-[0-9][0-9]T[0-9][0-9]:[0-9][0-9]:[0-9][0-9].[0-9][0-9][0-9]Z'
  );

-- Created before the UPDATE so the from-side backfill uses the index.
CREATE INDEX handoffs_from_app_state ON handoffs(from_app_id, state);

UPDATE apps
SET last_agent_activity_at = MAX(
  apps.created_at,
  COALESCE((SELECT i.started_at FROM instances i WHERE i.app_id = apps.id), apps.created_at),
  COALESCE((SELECT MAX(s.last_activity_at) FROM session_state s WHERE s.app_id = apps.id), apps.created_at),
  COALESCE((SELECT MAX(r.last_busy_seen_at) FROM session_resume r WHERE r.app_id = apps.id), apps.created_at),
  COALESCE((SELECT MAX(COALESCE(h.last_message_at, h.updated_at)) FROM handoffs h WHERE h.from_app_id = apps.id), apps.created_at),
  COALESCE((SELECT MAX(COALESCE(h.last_message_at, h.updated_at)) FROM handoffs h WHERE h.to_app_id = apps.id), apps.created_at)
);

ALTER TABLE instances ADD COLUMN applied_launch_hash TEXT;
```

The migration is additive and data-compatible with N-1: every `INSERT INTO apps`/`instances` uses an
explicit column list, and no code uses `SELECT *` from either table. It is marked
`requiresExclusive: true` because the handoffs index build and the apps UPDATE must not run through
the online path; the normal startup migration path applies it after the coordinator stops. Set
`estimatedMs: 500` with a comment that it bounds the apps UPDATE plus the handoffs index build at
pre-alpha scale; the default formula understates the index build. `backwardCompatible` stays `true`
for the data contract only, but the schema guard still blocks an older binary after v27 is applied;
rollback requires restoring the pre-v27 backup. The CHECK validates canonical **shape**, not calendar
validity; it is fail-closed on non-canonical legacy timestamps. All current writers use
`new Date().toISOString()`, so the risk is low.

Update the hardcoded schema-version assertions in `test/migrations.test.ts`,
`test/migrate-cli.test.ts`, `test/store.test.ts`, `test/settings-store.test.ts`,
`test/skills-store.test.ts`, `test/deploy-http.test.ts`, and `test/http.test.ts`; add a v27 migration
test for the backfill, the CHECK, the indexes, `applied_launch_hash`, and the `requiresExclusive`
classification. The future-schema simulations that hardcode 27 (`test/migrations.test.ts:365`,
`:396`) must use 28 and `known: 27`.

## 11. Interfaces and data flow

### 11.1 Activity service

```ts
export type AgentActivityReason =
  | "prompt" | "status" | "waiting" | "answer"
  | "compact" | "handoff" | "resume" | "start" | "restart";

export type ActivityEndpoint =
  | { state: "not_running" }
  | { state: "running"; endpoint: string }
  | { state: "unprobeable"; reason: string };

export interface AgentActivityService {
  touch(appId: string, reason: AgentActivityReason, at?: number): void;
  lastActivityAt(appId: string): number | null;
  isActive(appId: string): Promise<boolean>;
}
```

The service depends on the database, a manager-provided **lock-free** `activityEndpoint(appId)`
callback, an `appDirFor(appId)` callback, the strict opencode prompt/status clients, the
pending-send/handoff queries, an active-recovery-session query, a prompt-capability cache, `now`, a
logger, and bounded timeouts. It must not depend on `InstanceManager` directly; the callbacks avoid a
construction cycle. The service is injected into `InstanceManager` and exposed to the HTTP routes and
dispatcher through a small `noteActivity` method. `touch` is best-effort and never throws.

### 11.2 Manager lifecycle options

Extend the stop/restart entry points with an explicit source/reason, a lock-safe guard, a launch
fingerprint, and an expected image identity:

```ts
stopApp(
  appId: string,
  options?: {
    source?: ProcessSource;
    reason?: string;
    guard?: () => boolean | Promise<boolean>;
  },
): Promise<boolean>;

restartIfRunning(
  app: ManagedApp,
  options?: {
    source?: ProcessSource;
    reason?: string;
    guard?: () => boolean | Promise<boolean>;
    expectedLaunchFingerprint?: string;
    expectedImageId?: string;
  },
): Promise<boolean>;
```

The caller `guard` is evaluated at the top of the destructive branch: in `stopApp` for a stop, in `#restartLocked` for a restart. It is **not** a generic "is anything in flight" predicate. The manager adds the internal concurrency checks itself:
- `stopApp` checks `isRestarting`, `isLaunching`, and `isBuilding` inside the per-app lock before calling `#stopLocked`; a top-level stop owns neither a restart claim nor a launch, so these are never self-referential.
- `#restartLocked` does not check the restart claim or the launch: `restartIfRunning` acquired the claim and registered the launch for this attempt before entering the lock; `#acquireRestartClaim` rejects a concurrent restart and `#registerLaunch` chains after any earlier launch, and the per-app lock excludes a concurrent `ensure`. `#stopLocked` evaluates no internal checks and no caller guard; the nested calls from `#restartLocked`, `rollbackImage`, and `#stopForDeletionLocked` pass no guard, so the stop half always runs.

The caller guard re-reads deployment lock, drain, `terminalSessions.isActive`, process phase, durable
clock, live activity, image state, target image identity, and launch fingerprint. It must not call any
manager method that takes `#withAppLock`; `activityEndpoint`, `pendingRestart`, and
`launchFingerprint` are lock-free by contract. A re-entrancy test asserts this. A test asserts that an auto-update with a supplied guard actually calls `runtime.delete` from the stop half and records the `auto_update` stop intent/notice (not merely that `#stopLocked` was reached). A test asserts a manual restart still records the `restart` stop intent. A test asserts deletion during a restart still stops the container before setting `deleting = 1`. A test asserts that a concurrent ensure/restart/build makes `stopApp` return false. A false guard returns false with no process-state change.

`beginRestart` stays unchanged; the scheduler uses the synchronous `restartIfRunning`.

`#stopLocked` and `#restartLocked` thread the supplied source/reason into every process transition;
`#handleRestartFailure` uses the supplied source/reason. `#ensureLocked` uses the attempt source/reason, captures one `LaunchSnapshot`, re-checks `expectedLaunchFingerprint` before applying, passes `expectedImageId` to the runner, and verifies only that the pinned ID is resolvable; the runner's create-by-ID plus post-create verification is authoritative. Any coordinator re-inspection of the live reference happens in the top-of-`#restartLocked` guard, before the stop half. `#ensureLocked` writes `applied_launch_hash` only on success. A mismatch fails
with `launch_changed`/`image_changed` and does not start. Reconnect/status/reconcile preserve the
existing hash.

`#recordStatus` and the internal stop's runtime-error transition use the supplied attempt source/reason, not hardcoded `runtime`. New `ProcessErrorCode` values `launch_changed` and `image_changed` must be added to `KNOWN_CODES` and `GENERIC_MESSAGES`. The runner `ensure` request accepts an optional `expectedImageId`; `validateRunnerSpec` validates it as a `sha256:...` string and excludes it from `specHash`; the handler resolves the allowlisted reference, compares its image ID to `expectedImageId`, creates from the pinned image ID, and verifies after create. Export the existing `isSameOrigin` helper from `src/http/handler.ts` (or move it to a shared module) for the image routes.

`StopIntentReason` gains `auto_stop` and `auto_update`; `STOP_INTENT_REASON`, `#freshIntent`,
`SESSION_NOTICE_REASONS`, and `RESTART_REASONS` include them. A `restartLike(reason)` predicate covers
`operator_restart` and `auto_update` at the three resume/schedule comparisons
(`src/opencode/recovery.ts:1451`, `1461`, `1462`); `recordStopIntent` treats `auto_update` like
`restart` and `auto_stop` like `stop`. The chat notice label map gets "Stopped automatically after
inactivity" and "Restarted automatically to apply an image update".

`InstanceManager` also gets:

- `noteActivity(appId, reason)` for HTTP and dispatcher callers;
- `activityEndpoint(appId)` that probes the runtime and installs endpoint auth without starting and
  without taking `#withAppLock`;
- `launchSnapshot(app)` / `launchFingerprint(snapshot)` and `pendingRestart(appId)`;
- `terminalSessions.beginMaintenance(appId)` around the destructive branch;
- an optional `activity` dependency in `InstanceManagerOptions`.

`resumeRunning`/`#resumeOne` must set endpoint authorization and `#running` for every running app,
even when context monitors are disabled; only `#startMonitor` remains conditional.

### 11.3 Scheduler

```ts
export interface AgentMaintenanceSchedulerOptions {
  db: SqliteDatabase;
  manager: InstanceManager;
  images?: Pick<ImageService, "imageState" | "pullConfigured">;
  activity: AgentActivityService;
  logger?: Logger;
  deploymentLock?: DeploymentLock;
  drain: { isDraining(): boolean; isShuttingDown(): boolean };
  terminalSessions: TerminalSessionRegistry;
  managedAppFor: (appId: string) => ManagedApp | undefined;
  now?: () => number;
  config: MaintenanceConfig;
  isMasterApp?: (projectId: string, appKey: string) => boolean;
}

export interface MaintenanceReport {
  evaluated: number;
  stopped: string[];
  updated: string[];
  skipped: Array<{ appId: string; reason: string }>;
  pull?: ImagePullReport;
}
```

`start()` creates the two unref'ed timers. `stop()` clears them and aborts the pull controller.
`runOnce()` is the testable idle pass; `runPullOnce()` is the testable pull pass. Both are
single-flight, catch every error, never reject into the timer, and check drain before work. The idle
pass has per-call timeouts, bounded per-app concurrency, and an overall deadline. The pull pass owns
an `AbortController` that is aborted on drain/shutdown. If `images` is absent (dev/no runner),
auto-update and pull are skipped; auto-stop still works. `managedAppFor` loads the authoritative
`ManagedApp` (same resolver as `toManagedApp`) so the fingerprint and restart see instructions and
shared instructions.

Candidate query (both tables are small; the planner may scan either side):

```sql
SELECT a.id, a.project_id, a.app_key,
       MAX(COALESCE(a.last_agent_activity_at, a.created_at), COALESCE(i.started_at, a.created_at), a.created_at) AS last_activity_at
FROM instances i
JOIN apps a ON a.id = i.app_id
JOIN projects p ON p.id = a.project_id
WHERE COALESCE(i.runtime_state, i.state) = 'running'
  AND (i.process_phase IS NULL OR i.process_phase = 'ready')
  AND a.deleting = 0 AND p.deleting = 0
  AND MAX(COALESCE(a.last_agent_activity_at, a.created_at), COALESCE(i.started_at, a.created_at), a.created_at) < @cutoffIso
ORDER BY last_activity_at;
```

Using `MAX` rather than `COALESCE` ensures a recent start protects the app even if the best-effort start-time activity write failed.

`@cutoffIso` is `min(enabled thresholds)`; the pass branches stop before update. The pass skips
`manager.isRestarting(appId)`, master apps (default real `isMasterApp`), and apps in
`starting`/`stopping`/`building`.

The scheduler starts only after `recoverRestartClaims()` completes (or skips actions until it does); a persisted restart claim must not be invisible to `isRestarting` while the scheduler can stop.

### 11.4 Data flow

```
OpenCode events / status sampler / HTTP work routes / handoff dispatcher
        -> AgentActivityService.touch()
        -> apps.last_agent_activity_at

AgentMaintenanceScheduler (idle timer)
        -> candidate query (apps + instances)
        -> managedAppFor + AgentActivityService.isActive()
        -> ImageService.imageState() + pendingRestart() + launchFingerprint()
        -> terminal gate / drain / deployment guards
        -> manager.stopApp() / restartIfRunning({ guard, expectedLaunchFingerprint, expectedImageId })
        -> process history + events audit + logger

AgentMaintenanceScheduler (pull timer)
        -> ImageService.pullConfigured({ signal, isDraining })
        -> RunnerImageClient.pull({ signal })
        -> runner POST /v1/images/pull (streaming, mutex, fail-closed disk guard)
        -> Docker /images/create
        -> invalidate identity cache + image.auto_pull / app.auto_pulled events
```

## 12. Configuration

Environment variables, following the existing `HANSE_SHUTDOWN_GRACE_MS` helper style:

| Variable | Default | Purpose |
| --- | --- | --- |
| `HANSE_AGENT_AUTO_STOP_MS` | `172800000` (2 days) | Idle stop threshold; `0` disables. |
| `HANSE_AGENT_AUTO_UPDATE_MS` | `10800000` (3 hours) | Idle image-update threshold; `0` disables. |
| `HANSE_AGENT_MAINTENANCE_INTERVAL_MS` | `300000` (5 minutes) | Idle scheduler tick; clamped to at least 30 seconds. |
| `HANSE_AGENT_AUTO_PULL_MS` | `900000` (15 minutes) | Pull timer; `0` disables. |
| `HANSE_IMAGE_DISK_PATH` | `HANSE_HOST_WORKSPACE` | Runner path statfs'd for the pull disk guard; point it at the filesystem that backs Docker images (mount it read-only if different). |

A pure `resolveMaintenanceConfig(env)` validates and clamps the values. Invalid values fall back to
the defaults and log one warning. Per-app overrides and a settings UI are deferred; the owner's
current requirements are satisfied by process-wide thresholds, and demo services are allowed to stop.
The variables must be added to `.env.example`, `compose.yaml` (coordinator and runner environment as
appropriate), and the deployment guide. Defaults are enabled; the deployment guide must call out the
mutable-tag supply-chain trade-off and the digest-pin/`0` opt-out.

## 13. Failure modes and races

| Failure / race | Behavior |
| --- | --- |
| Prompt source returns 404/405 | Unsupported only if it never succeeded for this app; otherwise active. |
| Prompt source returns any other error / malformed body | Active (strict clients fail closed). |
| All prompt sources unsupported | Inactive (no prompt capability). |
| Status response malformed | Active (strict parser). |
| Runtime running but endpoint/password/authorization unavailable | Active (`unprobeable`). |
| Live check hangs | 5-second per-call timeout; overall pass deadline; single-flight skips overlapping ticks. |
| Runner unavailable | Skip; the next tick retries. |
| Deployment lock active | Skip; re-checked inside the guard. |
| In-process drain/shutdown | Skip both timers, re-check drain inside the guard, and abort an in-flight pull. |
| Active operator terminal | Skip auto-stop and auto-update; the guard checks `isActive`, not the maintenance flag; terminal registration is refused while maintenance is active. |
| Restart claim or build/pull/GC mutation in progress | Skip; the next tick retries. The current auto-update's own restart claim/launch is not treated as in-flight; the internal checks live in `stopApp`, not `#stopLocked`. |
| App deleting / project deleting | Skip. |
| App starting/stopping/restarting | Skip; re-checked inside the guard before any transition. |
| App already stopped | No action. |
| Master app | Excluded by default `isMasterApp`. |
| Prompt arrives between the check and the action | The chat send route touches activity before `ensure`; the manager guard re-reads the clock, drain, terminal, process phase, and live activity at the top of the destructive branch. A residual race after the guard is accepted and bounded by the per-app lock. |
| Auto-stop and auto-update both due | Stop wins. |
| Auto-update with changed configuration | Skip with `configuration_changed`; never apply silently. |
| Auto-update with changed target image | Skip with `image_changed` before the stop half; a change after the stop fails closed and never launches a different image. |
| Configuration changes after the guard but before `#ensureLocked` | `launch_changed`; the restart fails and does not apply the new configuration. |
| Auto-update restart fails | Process history records `system`/`auto_update`; the app stays `error`; one-hour cooldown; manual rollback. |
| Auto-stop delete fails | Process history records `runtime_unavailable`; one-hour cooldown. |
| Pull fails | Log, continue; the next pull tick retries; the idle timer is unaffected. |
| Pull and build/GC overlap | The shared image-mutation mutex serializes them; build-vs-build keeps `build_in_progress`; a pull conflict is a benign skip. |
| Pull exceeds the deadline / client disconnects | The runner aborts the Docker stream on `response.close`/socket close and releases the mutex; the coordinator treats a timeout/409/507 as a skip. |
| Disk warning/critical or statfs failure | Runner rejects the pull (507) and aborts a pull that reaches critical; coordinator skips. |
| Coordinator restart | Timers reset; durable activity timestamps, process state, and the schema make the next tick idempotent. Cooldowns are in-memory and reset; an action may retry once after restart. |
| Activity clock is `NULL` | Fall back to `instances.started_at`, then `apps.created_at`. |
| Launch fingerprint is `NULL` (legacy) | Auto-update skips until the next explicit start/restart. |
| Migration upgrade | The backfill includes handoff activity, uses the greatest real signal, and creates the handoff index before the UPDATE. |

## 14. Security and operational risks

- **Mutable tags and auto-update.** Auto-pull plus auto-update can deploy a newly pushed mutable tag
  without a human review. Digest-pinned references do not move, so auto-pull is a no-op there.
  Operators who require reproducibility must pin digests or disable auto-pull. Signature verification
  is out of scope for this iteration. This is the main accepted residual risk; the deployment guide
  must state it, and `image.auto_pull` records the old/new image identity and resolved digest.
- **Pull endpoint.** Runtime-token authenticated, exact-allowlisted, serialized with builds/GC,
  streaming and bounded; no arbitrary references, no app-built image pulls, no registry credentials
  in the coordinator. Pull errors are sanitized; the handler aborts on client disconnect; the disk
  guard fails closed.
- **Disk guard.** Enforced by the runner at warning/critical before the pull and at critical during
  the pull, with statfs failure rejecting. If the Docker data root is on another filesystem, the
  guard may under-report; the deployment guide documents the assumption and the auto-pull disable
  opt-out.
- **Destructive actions.** Auto-stop and auto-update are system actions, not agent tools. They use the
  existing manager guards and are audited. No MCP surface is added.
- **Live work.** An active operator terminal blocks both actions and terminal registration is
  serialized with the destructive gate; previews/demo services may stop. The IDE is a separate
  code-server container and is not app-specific.
- **No auto-rollback.** A bad image can leave an app in `error`; the operator uses the existing manual
  rollback. This is accepted for the first iteration.
- **Build route CSRF.** All image mutations are human-only and cookie-protected by `SameSite=Strict`;
  this design adds an explicit `isSameOrigin` check to build, rollback, check, and gc for
  defense-in-depth. An absent Origin is accepted by the existing helper; the cookie remains the
  primary control.
- **Start after auto-stop.** Auto-stop does not change configuration; a later start applies the
  current configuration by the normal start contract. The audit records pending-restart reasons so
  the operator can see what a start will apply.
- **First-ever prompt 404.** A source that has never succeeded and returns a transient 404 on its first prompt is treated as unsupported; a supported route normally returns `200` with an empty list, so the risk is low. The capability cache is epoch-keyed and never short-circuits the four-source probe.
- **Auto-update / auto-pull overlap.** The idle and pull passes share a single-flight mutex, so a pull cannot complete between the auto-update guard and launch. A forward tag move detected before the stop is a true skip; a move detected after the stop fails closed and leaves the app in `error`.
- **Persisted restart claims.** `recoverRestartClaims()` must complete before the scheduler can act; `isRestarting` alone only sees the in-memory map.
- **Adopt path.** The adopted container is image-verified; if inspection is unavailable and `expectedImageId` is supplied, the runner fails closed.
- **Pull request order.** The body is validated before the mutex; a periodic statfs failure aborts; an old-runner `405` is an unsupported skip.

## 15. Observability and audit

- Structured logs: `agent_auto_stopped`, `agent_auto_updated`, `agent_auto_update_skipped`,
  `agent_auto_pull`, `agent_auto_pull_failed`, `agent_auto_maintenance_error`. App ids and image
  references are allowed; no secrets, raw pull streams, or unbounded registry text.
- `events` rows: `app.auto_stopped`, `app.auto_updated`, `app.auto_pulled`, a per-app `app.rebuild_required` event when a base pull moves a custom app to `rebuild_required`, and a global `image.auto_pull` with `{ idleMs, reason, reference, previousImageId, imageId, digest, changed, outcome }` as applicable. Skipped actions are logged, not audited on every tick; a `configuration_changed` skip is logged once per cooldown. Disallowed/507 pulls are audited in the global event and logged at warn. Coordinator-side skips (digest-pinned, drain, deployment lock, pre-check disk critical) are logged once per cooldown; a persistent pull failure gets a pull-specific cooldown so it does not retry every 15 minutes.
- Process history: source `system`, reasons `auto_stop` / `auto_update`; `app.auto_updated` also records the previous and applied image IDs so a supply-chain change is traceable per app. The application page process history shows them without new UI.
- Session notices: `auto_stop` and `auto_update` reasons with operator-readable labels; the UI notice
  grouping treats `auto_update` as a restart.
- Chat: the existing process SSE turns a stopped agent into the stopped shell and an updating agent
  into the starting/ready shell.
- Rebuild-only: the existing build polling and image banner show progress; a success toast says the
  image is built and a restart is required.

## 16. Alternatives and non-goals

Alternatives considered:

1. **Reuse `session_state.last_activity_at`.** Rejected: it is bumped by draft `GET`/`touch`, covers
   only chat sessions, and cannot represent waiting prompts or handoffs.
2. **In-memory activity only.** Rejected: coordinator restarts would reset the clock and could stop or
   update an app immediately.
3. **Event-level touch for every OpenCode delta.** Rejected: write amplification with no benefit at
   3-hour/2-day thresholds.
4. **v1-only prompt check or "all four failed" fail-closed.** Rejected: a single failed v2 source can
   hide a pending prompt, producing a false-idle stop.
5. **Backfill from `instances.started_at` only.** Rejected: an app started days ago but used recently
   would be auto-stopped immediately after upgrade; handoff work would also be missed.
6. **Extend the 15-second reconciler.** Rejected: couples a fast correctness loop to a slow policy;
   a separate timer is testable and can be disabled independently.
7. **Automatic rebuild.** Rejected for this iteration: builds are human-only, expensive, globally
   serialized, and can bake uncommitted workspace changes. The chat banner gets "Rebuild only"
   instead.
8. **Automatic rollback.** Deferred; manual rollback remains.
9. **Coordinator pulls via its own Docker socket.** Rejected: the runner is the only Docker-socket
   holder by design.
10. **Buffered Docker pull response.** Rejected: the pull progress stream can exceed the existing
    8 MiB response buffer; a dedicated streaming parser is required.
11. **Auto-update with changed configuration.** Rejected: a restart applies it silently, violating the
    existing invariant. Auto-update requires an unchanged launch fingerprint.
12. **Point-in-time `pendingRestart` only.** Rejected: configuration can change during the restart;
    the launch snapshot is captured once and the same snapshot is applied.
13. **No terminal veto.** Rejected by the owner: a live operator terminal blocks auto-stop and
    auto-update; terminal registration is serialized with the maintenance gate.
14. **Coordinator-only disk guard.** Rejected: the runner enforces the guard at the pull endpoint,
    before and during the pull, and fails closed on statfs errors.
15. **Settings UI for thresholds.** Deferred; environment variables match the existing lifecycle
    configuration style and keep the first iteration small.

Non-goals:

- Auto-applying settings/skills/model pending restarts.
- Auto-rebuild and auto-rollback.
- Signature verification of pulled images.
- Per-app maintenance overrides or a maintenance UI.
- Stopping the master agent.
- Zero-downtime updates.
- Changes to session/message retention.

## 17. Open questions

All owner questions are resolved:

| ID | Question | Resolution |
| --- | --- | --- |
| Q1 | Does auto-update also apply pending settings/skills/model restarts? | No. Auto-update requires an unchanged launch fingerprint; pending configuration stays manual. |
| Q2 | Should an active operator terminal/IDE session block auto-stop and auto-update? | Yes for an active operator terminal WebSocket; previews/demo services remain stoppable; IDE is separate and not app-specific. |
| Q3 | Are the environment thresholds the right configuration surface for v1, with no settings UI? | Yes; per-app overrides are a follow-up. |
| Q4 | Should auto-pull pull the shared base image as well as the default agent image? | Yes, when configured and at least one app uses the shared base; otherwise skip. A changed base only marks custom apps `rebuild_required` and still needs an explicit rebuild. |

## 18. Design review

Baseline correction after round 6: stage 0041 (telegram notifications) takes migration v26; this
stage is v27. Historical round notes that say v26 are preserved as written. The pre-stage baseline is
therefore schema 26 (future-schema test value 27); this stage's targets are v27 (future-schema 28).

### Round 1 - `oracle`: FAIL; database-engineer: findings; security-engineer: findings

Findings folded into revision 2: v1-only prompts, unsafe start-time backfill, silent pending-config
application, drain, hardcoded source/reason, check-outside-lock, monitor-gated sampling, buffered
pull, missing disk/build coordination, permanent pending sends, dead index, missing handoff index,
and N-1 rollback wording.

### Round 2 - `oracle`: FAIL; database-engineer: major findings; security-engineer: blocker

Findings folded into revision 3: per-source prompt handling, `#freshIntent`/notice reasons, cutoff,
lock-free guard, drain-in-guard, tri-state endpoint, strict status/session_resume, launch fingerprint,
handoff backfill/index, streaming pull/mutex/disk guard, terminal registry, UI/test updates.

### Round 3 - `oracle`: FAIL; database-engineer: major findings; security-engineer: do not ship

Revision 4 folds:

- **Blocker:** malformed v2 prompts still collapsed to empty. Fixed by strict v1/v2 prompt clients,
  a prompt-capability cache, and per-source 404/405 semantics (§5.5).
- **Blocker:** the guard ran after the restart/stop transition. Fixed by evaluating it at the top of
  `#stopLocked`/`#restartLocked`, before any transition or stop intent (§6, §7, §11.2).
- **Blocker:** `auto_update` did not get restart resume semantics. Fixed by the `restartLike`
  predicate at the three `operator_restart` comparisons and `recordStopIntent` (§11.2, R13).
- **Blocker:** `applied_launch_hash` could falsely certify an unapplied configuration. Fixed by
  writing it only from the destructive `#ensureLocked`, capturing one `LaunchSnapshot` and applying
  that same snapshot, and preserving it on reconnect/status (§5.3, R15).
- **Major:** pull used `request.on("close")`. Fixed to `response.on("close")` with
  `!response.writableFinished` / socket close (§8.1).
- **Major:** the shared mutex changed the `build_in_progress` contract. Fixed by keeping
  `build_in_progress` for build-vs-build and using `image_mutation_in_progress` only for pull
  conflicts (§8.1).
- **Major:** terminal veto had an unguarded attach window. Fixed by the terminal maintenance gate
  (`beginMaintenance`/`register`) (§5.7, R14).
- **Major:** release identity/docs omitted schema 26. Fixed in §19 and the test list.
- **Major:** `pullConfigured` could not check drain. Fixed by passing `{ signal, isDraining }` from the
  scheduler (§8.2).
- **Major:** auto-update could launch a different image via the live manifest. Fixed by the expected
  image identity guard (`expectedImageId` + live resolve/inspect) (§7, §11.2).
- **Major:** disk guard failed open on statfs error and only checked before the pull. Fixed by
  fail-closed statfs, warning/critical pre-check, and periodic critical abort during the pull (§8.1).
- **Major:** guard did not re-check process phase/in-flight start/build or the deployment lock. Fixed
  by the top-of-destructive-branch guard (§6, §7, §11.2).
- **Major:** migration index ordering made the handoff backfill O(apps×handoffs). Fixed by creating
  the index before the UPDATE (§5.2, §10).
- **Major:** migration test scope was incomplete. Fixed by the expanded §19 list, future-schema 27,
  migrate-cli expectations, and schemaVersion 26 in deploy/http tests.
- **Minor:** fingerprint wording, `touch` best-effort, scheduler `managedAppFor`, audit digest/global
  pull event, pull 507/404 skip, same-origin scope, reserved-route test, and doc/test nits. Fixed or
  recorded.

### Round 4 - `oracle`: FAIL; database-engineer: PASS WITH FIXES; security-engineer: FAIL

Revision 5 folds:

- **Blocker:** the top-of-`#restartLocked` guard checked the restart's own claim/launch, so auto-update would always skip (or throw `RestartInProgressError`). Fixed by splitting the internal concurrency checks from the caller guard: `#stopLocked` checks `isRestarting`/`isLaunching`/`isBuilding`; `#restartLocked` excludes the current attempt's claim/launch (claim acquisition and launch chaining already serialize); the nested `#stopLocked` does not re-evaluate the guard. Added reachability and concurrency tests (§6, §7, §11.2, §13).
- **Major:** `#resumeOne` did not populate `applied_skills_hash`, disabling auto-update after a coordinator restart. Fixed (§5.6).
- **Major:** the prompt capability cache could short-circuit a source and miss a v2 prompt after an image update. Fixed by always probing and keying/clearing the cache by runtime epoch (§5.5).
- **Major:** the expected image identity was checked but not pinned at container create. Fixed by passing `expectedImageId` to the runner `ensure` and rejecting a mismatch before create (§7, §11.2).
- **Major:** `test/commands.test.ts:135,145` future-schema 26 would become a known version. Fixed in §19.
- **Minor:** CHECK shape-only wording, `backwardCompatible` comment, `#recordStatus` source/reason, `beginMaintenance` nesting, `docs/deployment.md:406` sample, `migrations.test.ts:64` array, `ProcessErrorCode` additions.

### Round 5 - `oracle`: FAIL; security-engineer: FAIL

Revision 6 folds:

- **Blocker B1:** the nested `#stopLocked` from `#restartLocked` would see the restart's own claim/launch if `#stopLocked` checked them, and only the caller guard was exempted. Fixed by moving the internal concurrency checks to `stopApp`; `#stopLocked` evaluates no internal checks and no caller guard, and the nested/delete callers pass no guard. Added stop-half reachability, stop-intent, and deletion-during-restart tests (§6, §7, §11.2, §13).
- **Blocker B2:** `expectedImageId` was checked before create but the container was created from the mutable tag; a concurrent pull could substitute the image. Fixed by creating from the pinned image ID and verifying the created container, including the running-container reuse path (§7, §8.1, §11.2).
- **Major/minor:** `#resumeOne` rationale wording, `beginMaintenance` release in `finally`, `isBuilding` source, `ProcessErrorCode` maps, `isSameOrigin` export, pull error sanitization, `previousImageId` response, custom-app rebuild-required audit, coordinator skip/pull cooldown, candidate `MAX`, `test/http.test.ts:609`, and `#resumeOne` tests.

### Round 6 - `oracle`: PASS WITH FIXES; security-engineer: PASS WITH FIXES

The two blockers are verified fixed. Revision 7 folds the remaining clarifications:

- Terminal gate ordering is explicit: `beginMaintenance` is synchronous, set inside the per-app lock before the guard reads `isActive`, refcounted, and not set on the claim-failure path (§5.7, §6, §7).
- `#ensureLocked` passes `expectedImageId` to the runner and does not re-inspect-and-abort after the stop; the runner's create-by-ID + post-create verification is authoritative; re-inspection lives in the top-of-`#restartLocked` guard (§11.2, §13).
- Handoff `awaiting_approval` and thread `waiting_operator` count as active (§5.5).
- The guard clock uses the same `MAX(...)` fallback as the candidate query (§6).
- The idle and pull passes share a single-flight mutex; persisted restart-claim recovery completes before the scheduler acts (§8.2, §11.3).
- Adopt-path image verification, inspect-unavailable fail-closed, pull body-before-mutex, periodic-statfs abort, and old-runner `405` are explicit (§7, §8.1, §8.2).
- §6 already-stopped wording and the `stopApp` test wording are corrected (§6, §11.2).
- `app.auto_updated` records previous/applied image IDs (§15).

No round 7 review is required; the design gate is cleared.

## 19. Rollout and verification

- Migration v27 adds `apps.last_agent_activity_at`, `instances.applied_launch_hash`, the backfill,
  and `handoffs_from_app_state` (created before the UPDATE). It is data-compatible with N-1 but
  marked `requiresExclusive: true`; apply it via the normal startup migration after the coordinator
  stops. `estimatedMs: 500`. The CHECK validates shape, not calendar validity. Binary rollback after v27 requires restoring the pre-v27 backup.
- Update `Dockerfile` `org.hanse.schema.max="27"`, `docs/current-state.md` schema `[1..27]`, and
  `docs/deployment.md` schema `1..27`.
- The scheduler starts after the manager, image service, drain controller, terminal registry, and
  `managedAppFor` resolver are constructed; it stops in `stopBackground` and on close. It checks
  drain before each pass/action, re-checks drain in the guard, and aborts an in-flight pull.
- The feature is on by default with the owner's thresholds; `0` disables each timer. The deployment
  guide documents the mutable-tag supply-chain trade-off, the digest-pin/disable opt-out, and the
  `HANSE_IMAGE_DISK_PATH` assumption.
- The runner and coordinator must be updated together for auto-pull; idle stop/update work without
  the runner pull endpoint.
- Documentation updates: `docs/current-state.md` (new maintenance section; qualify the explicit
  build/restart statements), `docs/deployment.md` (env table, upgrade/rollback, supply-chain and disk
  warnings), `README.md` (feature bullet and the explicit-restart qualification), `.env.example`,
  `compose.yaml`, and `docs/design/README.md`.
  - `docs/deployment.md:406`: bump the sample `/api/deploy/drain` JSON `schemaVersion` from 26 to 27.
- Test updates:
  - `test/migrations.test.ts`: all hardcoded 26s and partial counts (21→22, 17→18, 16→17, 15→16,
    14→15, 8→9, 12→13, 11→12, 9→10, 7→8, 5→6, 4→5), `max.version` 26→27, `knownMax` 26→27; future
    schema 27→28 at lines 365/396 and `applied: 28, known: 27`; add a v27
    backfill/CHECK/index/launch-hash/requiresExclusive test.
  - `test/commands.test.ts:135,145`: future-schema 27→28 and expected output `"26"`→`"27"` (v27 is now a known version, so the old assertion no longer raises `SchemaTooNewError`).
  - `test/migrate-cli.test.ts`: pending length 26→27, current/target 26→27; keep deleting v26, so
    `applied` stays 1; add a v27-only pending test asserting `--online` exit 1 /
    `migration_requires_offline`.
  - `test/migrations.test.ts:64`: add `27` to the version array (the "all hardcoded 26s" wording does not clearly cover inserting a new element).
  - `test/store.test.ts:53` add 27; `test/settings-store.test.ts:45` 27; `test/skills-store.test.ts:1336`
    16; `test/deploy-http.test.ts:74,111` and `test/http.test.ts:609` schemaVersion 27.
  - `test/runner-build.test.ts`/`test/image-lifecycle.test.ts`: keep `build_in_progress` for
    build-vs-build; add pull-conflict `image_mutation_in_progress`; add `/v1/images/pull` to the
    reserved-route test.
  - `test/chat-core`, `test/ui/chat-*` (`ChatImageWarning`), `session-storage`, `docs/design/chat-qa.mjs`
    button assertions, and a rebuild-only E2E scenario.
  - New activity/scheduler/pull/terminal-registry tests: strict v1/v2 prompt fail-closed, capability
    cache, malformed status, subagent recovery row, unprobeable endpoint, drain, terminal gate/race,
    cutoff, launch fingerprint (reconnect no-write, concurrent change, NULL), expected image identity,
    source/reason process history, `#freshIntent`/restartLike notices/resume, pull
    allowlist/streaming/mutex/disk guard/client disconnect/507, and rebuild-only no-restart. Add a
    `#resumeOne`/`pendingRestart` test after a coordinator restart (applied skills hash present, no
    legacy settings-only fallback), a test that the auto-update stop half records the `auto_update`
    stop intent and notice, a deletion-during-restart stop test, and a pull error-sanitization test.
    Add terminal interleaving tests (register just before `beginMaintenance` makes the guard skip; register after is refused with 409), handoff `awaiting_approval`/`waiting_operator` active tests, pull body-before-mutex/405/periodic-statfs tests, adopt-path image verification, and a restart-claim recovery-before-scheduler test.
- Verification: the repository's full gate set, including `npm run check:ui` and `npm run test:e2e`
  because the chat banner changes.
