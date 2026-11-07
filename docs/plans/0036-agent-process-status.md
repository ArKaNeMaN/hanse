# Plan 0036 - Agent process lifecycle and status tracking

Status: **implemented and verified** (2026-11-07; journal
[0043](../journal/0043-agent-process-status.md)). Design `oracle` round 3 **PASS**; plan review
(`momus`) round 2 **OKAY**. All seven verification gates pass, including `npm run test:e2e`
(223 passed, 6 skipped). Commit requires explicit owner authorization.
Design: [Agent process lifecycle and status tracking](../design/agent-process-status.md).
Owner decisions: [open questions](../open-questions.md), 2026-11-07 (stage
`0036-agent-process-status`). No open questions remain for this stage.

Scope: durable current state and history for a managed application's agent process (start, lazy
start, reconnect, restart, stop, crash, OOM, out-of-band stop, readiness failure), the read API and
process SSE, and the chat, application-page, and overview surfaces.

Non-goals: OpenCode turn/chat state, turn retries, container log streaming, the IDE, the operator
terminal, multi-user/RBAC, a dedicated fleet processes page, changing the sync start contract, and
backfilling history before migration v23.

## Bindings

- Design author: maintainer; design reviewer: `oracle` (round 3 PASS).
- Plan author: maintainer; plan reviewer: `momus`.
- Design index: `docs/design/README.md`; plan index: `docs/plans/README.md`; journal index:
  `docs/journal/README.md`; open questions: `docs/open-questions.md`.
- Language: English for docs, code comments, copy, and notices.
- Verification: `npm run lint`, `npm run typecheck`, `npm run typecheck:ui`, `npm test`,
  `npm run build`, `npm run check:sensitive`, `npm run test:e2e`.
- Commit policy: one coherent stage commit, only after the owner explicitly authorizes it. Do not
  commit, push, or deploy without that authorization.
- No new npm dependencies.

## Owner decisions (closed)

1. All process lifecycle events with durable history; 1,000 events per app and 30 days.
2. Chat + application page + compact overview summary (counts and up to five affected apps).
3. SSE with a snapshot and per-app `lastEventId`; polling remains a fallback.
4. Sanitized runner/container text is visible; no secrets; unknown errors show a generic code-keyed
   message.
5. Lazy starts are new attempts with source `system` and a caller reason.
6. The existing coarse `starting` count may include `stopping`; the new block splits them.
7. Restart of a stopped app is a no-op with no attempt.
8. Explicit stop from `error` clears current error fields; history keeps the error event.

---

## Phase 0 - Baseline probes and call-graph confirmation

### Boundaries

In scope: read-only inspection, a throwaway SQLite database, and a disposable local test state.
Out of scope: production code changes, production state, deployment secrets, and real project data.

### Invariants

- Probes are read-only or use a disposable state; no production app, token, or data is touched.
- A failed probe blocks the relevant phase and becomes an owner question, not a silent workaround.
- Recorded evidence is redacted of host-specific values.

### Work

1. **Migration SQL probe.** Apply the exact v23 SQL (design §5.1-5.2) to a temporary SQLite database
   created with the repository's `better-sqlite3`; assert the new columns, the `CASE` backfill for
   every coarse state (`starting|running|stopped|error|failed`), the `agent_run_events` CHECKs, and
   the indexes. Record the output in the journal.
2. **Lock/call-graph confirmation.** Re-read `InstanceManager.#withAppLock` and confirm it is not
   re-entrant. Record every caller of `#recordStatus`, `#recordStatusById`, `probeStatus`,
   `#recordSkillsError`, `#handleRestartFailure`, `#stopLocked`, `#restartLocked`, `#ensureLocked`,
   and every `ensure(` call site. The result is the lock-ownership table used in Phase B.
3. **SSE baseline.** With a deterministic fixture, confirm the browser `EventSource` behavior for a
   second per-app stream (new `streamID`, `stream.ready`, `seq` handling) and the current 429/close
   behavior. Record the observed frames.
4. **Slow-launch baseline.** Using the existing fake runtime/wait-for-ready hooks, reproduce the
   reported sequence in a unit test: click start, remount before `runtime.ensure` resolves, observe
   `state=stopped` and an enabled Start button. This is the regression baseline.

### Acceptance criteria

- The migration probe passes for every coarse-state input and fails on an invalid phase/state/length.
- The lock table names every caller and its lock state; no caller is `unknown`.
- The SSE baseline records the exact frames and the 429 behavior.
- The slow-launch baseline reproduces the bug and is kept as a test in Phase E.

### Verification

Manual/temporary probes; record redacted evidence in the journal. No product code gates.

---

## Phase A - Migration v23 and store helpers

### Boundaries

In scope: the forward-only migration, `instances.process_*` columns, `agent_run_events`, and the
read/write helpers next to `src/store/runtime-state.ts`.
Out of scope: manager wiring, HTTP, SSE, and UI.

### Invariants

- Migration v23 is append-only after v22; existing rows keep their data and get the §5.1 `CASE`
  backfill (`running→ready`, `starting→requested`, `stopped→stopped`, `error/failed→failed`).
- `instances.process_phase` is nullable; no `NOT NULL`/`CHECK` is added to the existing table.
- `agent_run_events` enforces `state`, `phase`, `source`, `attempt_id`, `reason`, `error_code`, and
  `message` CHECKs; `(app_id, attempt_id, seq)` is unique.
- The snapshot query returns `current` and `lastEventId` consistently (one statement with a
  `MAX(id)` scalar subquery).
- History pagination is `id DESC`, `before` is a positive integer, limit 1..100.
- Pruning is per-app (`1,000` newest) and global (`30 days`), batched and idempotent.

### Work

1. `src/store/migrations.ts`: append `{ version: 23, name: "agent-process-status", sql: ... }` with
   the design §5.1-5.2 SQL.
2. `src/store/process.ts` (new): types `ProcessState`, `ProcessPhase`, `ProcessSource`,
   `ProcessEvent`, `ProcessCurrent`; `readProcess(db, appId)`, `readProcessSnapshot(db, appId)`,
   `readProcessEvents(db, appId, { limit, before })`, `pruneProcessEvents(db, appId)`,
   `pruneAllProcessEvents(db, now)`.
3. Export the helpers from `src/store/index.ts` if that barrel is the convention.
4. Tests: extend `test/migrations.test.ts`; add `test/process-store.test.ts` covering backfill,
   CHECKs, snapshot consistency, pagination (including invalid `before`), and both prune paths.

### Acceptance criteria

- `test/migrations.test.ts` proves v22 → v23 on a populated database and the exact phase mapping.
- `test/process-store.test.ts` proves the snapshot is consistent under a concurrent insert (or the
  single-statement query makes it impossible), pagination has no duplicates/skips, and pruning keeps
  the newest 1,000 and drops rows older than 30 days regardless of app state.
- Typecheck/lint pass for the new module.

### Verification

`npm run typecheck && npm run lint && npx vitest run test/migrations.test.ts test/process-store.test.ts`.

---

## Phase B - Manager process writer and lifecycle

### Boundaries

In scope: `InstanceManager` in `src/opencode/manager.ts`: `#transitionProcess`, `#launches`, attempt
ids, phase writes, reconnect transitions, readiness ordering, stop/restart semantics, reconciler
authority, sanitized error capture, the process event bus, and direct-writer routing.
Out of scope: the read API, SSE, UI, and docs; the settings/rollback restart-preflight call sites are
in scope.

### Invariants

- `#transitionProcess` never acquires `#withAppLock`; every caller holds it. The lock table from
  Phase 0 is the contract.
- Every transition upserts the current `instances` row and inserts the `agent_run_events` row in one
  transaction; `seq` is allocated under the lock.
- The initial destructive write is an upsert after cheap guards and the status probe, before
  `#preflightImage`/heavy preparation; it writes `starting`/`requested`.
- A reconnect writes `starting`/`waiting_ready` before readiness when the persisted state is not
  `running`; success writes `running`/`ready` and clears current error; failure writes
  `error`/`failed` with `token_reconcile_failed`/`readiness_timeout`.
- `running`/`ready` is written only after `#awaitReady` succeeds; `instances.started_at` is set there.
- Restart is one attempt: `requested → stopping → preparing → creating → waiting_ready → ready`; the
  restart stop writes `stopping` and suppresses the generic terminal `stopped` write/event/coarse
  change/observation.
- The `#launches` map is `Map<string, Promise<string>>`, created synchronously before locks/202 by
  `ensure`, `beginRestart`, `restartIfRunning`, and `rollbackImage`; `#restartLocked` does not register.
  A start joins a restart; a restart during a start chains after it.
- The reconciler never writes `running`/`ready` from Docker state alone; it runs a bounded readiness
  probe. A stale ownerless `starting` becomes `interrupted` only after a failed probe and the 90s age
  cutoff.
- Error fields clear on a new attempt, a successful reconnect, an explicit stop, or a readiness
  recovery; history is append-only.
- Direct writers (`#recordSkillsError`, `#handleRestartFailure`, `probeStatus`, `#recordStatus`,
  `#recordStatusById`) use the helper; `observeRuntime` stays notice-only; `#queueObservation` is
  preserved.
- The trigger fires on coarse state/phase/error changes and on runtime identity/epoch/restart-count/
  exit/OOM changes.
- Retention is wired: `#transitionProcess` calls `pruneProcessEvents(db, appId)` under the same lock;
  `#reconcileStatuses` calls `pruneAllProcessEvents(db, now)` once per tick, unfiltered by app state.
- A restart failure is idempotent: `#handleRestartFailure` uses the same-attempt/same-state/same-code
  no-op, so a stop-failure error is not appended twice.

### Work

1. Add `src/opencode/process-events.ts` (module-level `processEvents` bus with `subscribe`/`emit`),
   `#launches`, `#transitionProcess` (per-insert `pruneProcessEvents`), and the
   `ProcessTransitionInput` type; the manager emits through the bus.
2. Add `ensure(app, { origin?, reason? })`; `src/http/chat.ts:494` (`POST /start`) passes
   `{origin:"operator"}`; thread `origin`/`reason` through the lazy call sites (`prompts.ts:600`, `context.ts:113`, `commands.ts:147,220`, `chat.ts:1500,2268`,
   `src/coordinator/dispatcher.ts:482,636,827,898`, `src/master/tools.ts:1053`).
3. Refactor `#ensureLocked(app, attempt?)`: initial upsert, preflight/error mapping, `preparing`,
   `creating`, `waiting_ready`, then `running`/`ready` after `#awaitReady`.
4. Refactor the reconnect branch in `ensure()` per design §7.2 step 3.
5. Refactor `#stopLocked(appId, reason, { terminal })`; implement the restart stop suppression and
   the stop-failure error.
6. Refactor `#restartLocked`/`beginRestart`/`restartIfRunning`/`rollbackImage` around `#launches`,
   the `requested` preflight attempt, and restart-on-stopped no-op. Change the settings restart route
   in `src/http/settings.ts` and the image rollback route (`src/http/images.ts:268`) to write the
   `requested` attempt through a new manager method **after the running/stopped status probe and
   before the image preflight**, write `error`/`image_unavailable` on failure, and pass the same
   attempt onward (`beginRestart` for settings, `rollbackImage` for rollback). A stopped app still
   gets no attempt.
7. Wrap `#handleRestartFailure` and `probeStatus` in `#withAppLock`; route `#recordSkillsError`,
   `#recordStatus`, `#recordStatusById` through `#transitionProcess`; `#handleRestartFailure` relies
   on the same-attempt/same-state/same-code no-op.
8. Implement the reconciler authority, readiness probe, error stickiness, the 90s cutoff, and
   `pruneAllProcessEvents(db, now)` once per reconciler tick.
9. Add sanitizer calls at every error write; add `sanitizeProcessError` in
   `src/opencode/process-errors.ts` with the secret classes from design §10.
10. Add `test/manager.test.ts` cases and `test/process-sanitizer.test.ts`.

### Acceptance criteria

- A fake runtime that blocks `ensure` shows `starting` in `instances` before it resolves; a remount
  reads `starting`.
- Readiness failure persists `error`/`failed` with `readiness_timeout` and survives at least two
  reconcile ticks; a healthy recovered app becomes `running` after a successful probe.
- A coordinator crash mid-start (stale `starting`, no in-memory attempt) becomes `interrupted` after
  a failed probe + 90s cutoff; a ready runtime becomes `running`.
- Reconnect from `stopped` writes `starting`→`running`; a token/readiness failure writes `error`.
- Restart produces exactly one attempt and no terminal `stopped` event; restart-on-stopped is a no-op.
- A concurrent start returns the same promise and one attempt; a restart during a start chains.
- An out-of-band restart/OOM with unchanged coarse `running` appends history.
- The sanitizer removes every secret class and falls back to a generic message for unknown errors.
- 1,001 events collapse to the newest 1,000; a >30-day event for a stopped app is pruned and another
  app's rows are untouched.
- A failing settings preflight produces one attempt and one `error` event with `image_unavailable`;
  Retry creates a new attempt; a stop failure produces one `error` event; a successful preflight does
  not re-emit `requested`/`seq=1`.

### Verification

`npm run typecheck && npm run lint && npx vitest run test/manager.test.ts test/process-sanitizer.test.ts`.

---

## Phase C - Read API and page props

### Boundaries

In scope: `GET /api/apps/:app/runtime` extension, new `GET /api/apps/:app/process`, `SiteModel`
process detail, chat/app/overview props.
Out of scope: SSE and UI rendering.

### Invariants

- All routes are human-only, require `?project`, and reject cross-site mutations. JSON reads are
  DB-only with no agent-runtime probe; `/runtime` keeps the existing in-memory
  `manager.isRestarting()` flag for its `restarting` field.
- `/runtime` keeps every existing field and adds `process` (attempt, phase, timestamps, error,
  `lastEventId`).
- `/process` returns `current`, newest-first `events`, and a positive-integer `before` cursor; the
  snapshot is one query.
- `SiteModel` carries process detail without changing existing runtime counts; the overview summary
  excludes the master and orders by `process_updated_at` descending.

### Work

1. `src/http/handler.ts`: extend `routeRuntimeStatus` with the `process` block.
2. `src/http/process.ts` (new): `handleProcess` for `GET /api/apps/:app/process`.
3. `src/http/server.ts`: dispatch `/process` before the `/api/apps/` chat catch-all.
4. `src/http/dashboard.ts`: add a process map to `SiteModel`.
5. `src/http/props/chat.ts`, `props/app.ts`, `props/overview.ts`: add process props and the
   `processes` summary.
6. Tests: `test/process-http.test.ts`, `test/application-props.test.ts`,
   `test/dashboard-runtime.test.ts`.

### Acceptance criteria

- `/runtime` and `/process` work while stopped and never call the agent runtime/client.
- Missing `?project` is `400`; an unknown app is `404`; an agent principal is `403`.
- Pagination is stable and validated; cross-project keys are rejected.
- Chat/app props carry the process state; overview counts/summary are correct and exclude the master.

### Verification

`npm run typecheck && npm run lint && npx vitest run test/process-http.test.ts test/application-props.test.ts test/dashboard-runtime.test.ts`.

---

## Phase D - Process SSE

### Boundaries

In scope: the in-process process bus subscription, `GET /api/apps/:app/process/events`, the separate
per-app stream registry, frame types, snapshot/dedupe/gap/429 behavior, and its tests.
Out of scope: UI consumption.

### Invariants

- The route is human-only, requires `?project`, works while stopped/starting/stopping/error, and does
  not call `manager.endpointFor`.
- Frames use `{seq, streamID}`; `stream.ready` seq 0, `process.snapshot` seq 1 with
  `{current, lastEventId}`, `process.transition` seq 2+.
- Subscribe first into a bounded buffer, read the one-query snapshot, flush transitions with
  `id > lastEventId`, and filter/dedupe every later delivery by id.
- Global ids are not contiguous per app; gap detection never assumes `id+1`; `stream.warning` is
  emitted for buffer overflow, snapshot failure, or slow consumer.
- A separate `new AppStreamRegistry(4)` instance limits process streams; over the limit returns
  `429 stream_limit`; the client closes the `EventSource` and polls with backoff.
- The route is dispatched before the `/api/apps/` chat catch-all; a missing manager still serves the
  DB snapshot.

### Work

1. Reuse the module-level `processEvents` bus from Phase B (`src/opencode/process-events.ts`) and
   add the `ProcessEvent` frame types; the SSE route does not depend on `deps.manager` for the bus.
2. `src/http/process.ts`: `streamProcessEvents` with the subscribe/buffer/snapshot/flush logic,
   heartbeat, cleanup, and the separate registry.
3. `src/http/server.ts`: dispatch `isProcessEventsRoute`.
4. `ui/process/stream.ts` (client): EventSource wrapper with snapshot hydration, per-app last id,
   dedupe, gap refetch, 429 close/backoff. (The UI wiring is Phase E; the adapter and its unit
   test can land here.)
5. Tests: `test/process-sse.test.ts` and a client adapter test.

### Acceptance criteria

- A stopped app receives `stream.ready` + snapshot and live transitions.
- An event committed between subscribe and snapshot is not delivered twice; an event after the
  snapshot with an id ≤ the snapshot id is dropped.
- A duplicate/out-of-order id triggers one `/process` refetch; a buffer overflow emits
  `stream.warning` and refetches.
- The 5th concurrent process stream returns `429`; app-chat streams are unaffected.
- The route is reachable before the chat catch-all and works with `deps.manager` undefined.

### Verification

`npm run typecheck && npm run typecheck:ui && npm run lint && npx vitest run test/process-sse.test.ts`.

---

## Phase E - Chat UI

### Boundaries

In scope: `ChatPage.vue`, `ChatThread.vue`, the process composable, and the chat jsdom/e2e
cases.
Out of scope: application page and overview.

### Invariants

- The process state is authoritative over transport `503`s; only `agent_stopped` confirms stopped.
- `running`, `starting`, `stopping`, `stopped`, `error`, and `deleting` have distinct presentations;
  `stopping` is never labelled "Starting".
- The Start/Retry button is disabled from server state during `starting`/`stopping`, including after a
  remount; a local request flag is only an immediate double-click guard.
- A failed POST refetches the process view and shows the persisted error; the success toast does not
  contradict the visible panel.
- A legacy error row with no message shows the generic fallback text.

### Work

1. `ui/process/types.ts`, `ui/composables/useAgentProcess.ts` (Vue Query + a local reactive view; no
   Pinia store for server data): hydrate from chat props/`/process`, subscribe to the process SSE,
   expose `state`, `phase`, `elapsed`, `error`, `lastEventId`, and `refetch`.
2. `ui/pages/ChatPage.vue`: replace the any-503 `stopped` logic and the local-only `startingAgent`
   gating with the process view; keep the 5s chat props poll as a fallback; refetch on POST failure.
3. `ui/components/chat/ChatThread.vue`: add `starting`/`stopping`/`error` panels and the Retry/history
   link; keep the stopped panel.
4. `ui/status.ts`: phase labels/pills.
5. Tests: `test/chat-page.test.ts` (or the existing jsdom chat test) for
   `running`+sessions-503, `stopped`+`agent_stopped`, `starting`, `stopping`, `error`,
   `agent_unavailable`, `agent_starting`, `default_image_unavailable`, remount-during-start, and
   failed-POST refetch.
6. Update `e2e/support/seed.ts` to seed `process_phase`/`process_error_*` for the starting/error
   snapshots; the module-level bus means `e2e/support/server.ts` needs no fake-manager subscription.
   Extend `e2e/chat.spec.ts` with a slow-start remount and an error snapshot.

### Acceptance criteria

- A remount during a slow start immediately shows the starting panel and a disabled Start button.
- A readiness error shows the error panel with message/time/Retry, not the stopped shell.
- A transient sessions 503 while `running` does not show "Agent is not running".
- The E2E remount reads the persisted `starting` snapshot; the error disclosure shows the seeded
  message; no `/process/events` console/page error occurs.

### Verification

`npm run typecheck:ui && npm test -- chat-page && npm run test:e2e -- --grep chat`.

---

## Phase F - Application page and overview

### Boundaries

In scope: `AppPage.vue`, `AppStateStrip.vue`, `OverviewPage.vue`, `app-types.ts`, and their
jsdom/e2e cases.
Out of scope: chat.

### Invariants

- The Runtime strip shows the phase and elapsed time for `starting`/`stopping`; `error` shows the
  sanitized message and a **Process history** disclosure.
- The history fetches `/api/apps/:app/process?limit=50&project=<id>`, renders newest first, and
  supports "Load older" without duplicating rows.
- The 10s runtime poll remains the fallback; the page subscribes to the process SSE while visible.
- The overview block shows counts and up to five affected apps (starting/stopping/error), excludes
  the master, and is hidden when empty.

### Work

1. `ui/app-types.ts`: add the process shape to `AppRuntimeLive`/app props.
2. `ui/pages/AppPage.vue`: process state/phase/error, the history disclosure, and the SSE subscription.
3. `ui/components/AppStateStrip.vue`: phase/elapsed/error display and the history action.
4. `ui/pages/OverviewPage.vue`: the compact "Agent processes" block.
5. Reuse the Phase E seed fields for the app error disclosure; add tests
   `ui/pages/AppPage.test.ts`, `ui/pages/OverviewPage.test.ts`; E2E `e2e/app.spec.ts` and
   `e2e/overview.spec.ts`.

### Acceptance criteria

- The app page shows `Stopping…` during a stop, `Starting…` during a start, and the error message +
  history on failure.
- History pagination has no duplicates and stops at the oldest row.
- The overview lists only affected apps (max five, master excluded) and hides the block when empty.
- E2E passes with zero console/page errors.

### Verification

`npm run typecheck:ui && npm test -- application-page overview && npm run test:e2e -- --grep "app|overview"`.

---

## Phase G - Documentation, record, and full gates

### Boundaries

In scope: `docs/current-state.md`, the design/plan/journal indexes, the stage journal, and the full
verification run.
Out of scope: commit/push/deploy without explicit owner authorization.

### Work

1. `docs/current-state.md`: schema v23, the `process_*`/`agent_run_events` model, the `/process` and
   `/process/events` APIs, the UI states, and the accepted `stopping` coarse-count consequence.
2. `docs/design/README.md`: add the design entry with its status.
3. `docs/plans/README.md`: add plan 0036 with its status.
4. `docs/journal/0043-agent-process-status.md`: stage context, decisions, deviations, tests,
   artifacts, open threads, and next steps; update `docs/journal/README.md`.
5. Run the full gate set and record the results.

### Acceptance criteria

- All seven verification commands pass on the final tree.
- The current-state document matches the implemented behavior.
- The journal and indexes are updated.
- No commit is made unless the owner explicitly authorizes it.

### Verification

`npm run lint && npm run typecheck && npm run typecheck:ui && npm test && npm run build && npm run check:sensitive && npm run test:e2e`.

---

## Risks and mitigations

| Risk | Mitigation |
| --- | --- |
| Nested per-app locks deadlock the reconciler or a writer. | Phase 0 lock table; the helper never locks; explicit caller-held contract; manager tests for `probeStatus` and `#handleRestartFailure`. |
| The reconciler erases a readiness error or promotes a stale `starting`. | Readiness probe before any promotion/interrupt; error stickiness; 90s cutoff; regression tests. |
| The restart stop still emits a terminal `stopped` via `#recordStatusById`. | `terminal=false` suppresses the final status write, event, coarse change, and observation; a test asserts exactly one attempt and no `stopped` event. |
| SSE duplicates or misses events. | Subscribe-buffer-read-flush; `id > lastEventId` filter on every delivery; client dedupe; one-query snapshot; gap refetch. |
| Global event ids are mistaken for a per-app sequence. | No `id+1` gap detection; `stream.warning`/snapshot mismatch; a test with interleaved app events. |
| Error text leaks a secret. | `sanitizeProcessError` with explicit secret classes and a generic fallback; tests per class; no logs by default. |
| UI regression from replacing the any-503 stopped logic. | Precedence table; jsdom cases for every state/code; E2E remount and error. |
| Migration backfill writes a value outside the phase enum. | Explicit `CASE`; temp-DB probe; migration test on every coarse-state input. |

## Review

### Round 1 (`momus`, 2026-11-07): NOT OKAY

Three completeness gaps were folded:

1. **Retention wiring.** `#transitionProcess` now calls `pruneProcessEvents` under the lock; the
   reconciler calls `pruneAllProcessEvents` once per tick; Phase B has integration acceptance for
   1,001 → 1,000 and a stopped app's >30-day row.
2. **Restart failure/preflight ownership.** Phase B now names `src/http/settings.ts` and the image
   rollback route: write the `requested` attempt before the synchronous preflight, record
   `error`/`image_unavailable` on failure, pass the same attempt to `beginRestart`, and make
   `#handleRestartFailure` a same-attempt/same-state/same-code no-op. Acceptance covers one attempt,
   one error event, Retry as a new attempt, and no duplicate `requested`/`seq=1`.
3. **E2E fixture/seed.** `e2e/support/seed.ts` now seeds `process_phase`/`process_error_*`; the
   process bus is module-level, so the fake manager needs no `subscribeProcess`; the E2E acceptance
   checks the persisted starting snapshot, the seeded error message, and no `/process/events`
   console/page error.

Minor notes were also folded: `src/http/chat.ts:494` passes `{origin:"operator"}`; "DB-only" is
clarified to mean no agent-runtime probe while keeping `manager.isRestarting()`; the app-page history
URL includes `&project=<id>`; Phase 0 has an Invariants subsection; the chat process state uses a
Vue Query composable, not a Pinia store.

### Round 2 (`momus`, 2026-11-07): OKAY - plan-ready

The three blocking changes and all minor notes were verified in the body:

- Retention wiring: `#transitionProcess` prunes per app under the lock; the reconciler prunes the
  30-day window once per tick; Phase B acceptance covers 1,001 → 1,000 and a stopped app's row.
- Restart failure/preflight ownership: the settings and image-rollback routes write the `requested`
  attempt after the running/stopped probe and before the image preflight, record
  `error`/`image_unavailable`, pass the same attempt onward, and `#handleRestartFailure` is a
  same-attempt/same-state/same-code no-op.
- E2E fixture/seed: `e2e/support/seed.ts` seeds `process_phase`/`process_error_*`; the module-level
  bus removes the fake-manager `subscribeProcess` requirement; E2E acceptance covers the persisted
  starting snapshot, the seeded error message, and no `/process/events` console/page error.
- Minor notes folded: `src/http/chat.ts:494` uses `{origin:"operator"}`; DB-only is clarified;
  the history URL includes `&project=<id>`; Phase 0 has invariants; chat uses a Vue Query composable
  (no Pinia store); the lazy call-site paths/line numbers and the rollback file are named.

Plan review gate: cleared. Implementation may proceed; commit only on explicit owner authorization.

### Execution record (2026-11-07)

Phases A-G were implemented as written. The final tree passes `npm run lint` (806 files),
`npm run typecheck`, `npm run typecheck:ui`, `npm test` (238 files, 3,580 tests), `npm run build`,
`npm run check:sensitive`, and `npm run test:e2e` (223 passed, 6 skipped). The only gate correction
was test-only: `e2e/chat.spec.ts` now accounts for the application page's process stream in the
navigation EventSource assertion. Exact evidence is in
[journal 0043](../journal/0043-agent-process-status.md). No product behavior changed in Phase G. No
commit, push, or deployment was made.
