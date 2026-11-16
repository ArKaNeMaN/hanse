# Plan 0048 - Per-application memory limits and container memory metrics

Status: **approved - implementation in progress** (2026-11-16). Design `oracle` **PASS** (six
rounds; no must-fix). Plan `momus` review 3 **OKAY**; all findings are folded below. Commit remains
blocked until the owner explicitly authorizes it.

Design: [Per-application memory limits and container memory metrics](../design/app-memory-limits-and-metrics.md)
Owner decisions: [open questions](../open-questions.md), stage `app-memory-limits-and-metrics`
(2026-11-16). There are no open questions.

Scope: a hierarchical `runtime.memory_mb` setting (global/project/application, env-derived default);
per-application container memory sampling with a 72-hour bounded store and a 6/24/72-hour bucketed
read API; a full-width Memory card on the application page; and a distinct `oom_killed` process
event (including auto-restarted containers) with UI labels.

Non-goals: per-app CPU/PID settings, alerting/automatic remediation, history beyond 72 hours,
per-process RSS attribution, a fleet memory dashboard, changing swap/`OomScoreAdj`/restart policy,
a new chat notice for an auto-restarted OOM, persistent Docker event history across runner/daemon
downtime, and new npm dependencies.

## Bindings

- Design author: maintainer; design reviewer: `oracle` (PASS, 2026-11-16).
- Plan author: maintainer; plan reviewer: `momus`.
- Design index: `docs/design/README.md`; plan index: `docs/plans/README.md`; journal index:
  `docs/journal/README.md`; open questions: `docs/open-questions.md`.
- Language: English for docs, code comments, copy, and notices.
- Verification: `npm run lint`, `npm run typecheck`, `npm run typecheck:ui`, `npm test`,
  `npm run build`, `npm run check:sensitive`, `npm run test:e2e` (the stage changes a rendered
  route).
- Commit policy: one coherent stage commit, only after the owner explicitly authorizes it. Do not
  commit, push, or deploy without that authorization.
- No new npm dependencies.

## Owner decisions (closed, 2026-11-16)

1. Implement the per-app memory limit at global, project, and application scope; the environment
   value is the default.
2. Sampling interval, retention, and aggregation are delegated, optimizing for low disk use and
   fast page open. Selected: 30 s samples, 72 h retention, on-read 10/30-minute buckets, 6/24/72 h
   windows.
3. OOM markers are delegated; OOM-killed must be a distinct, obvious interruption event. Selected:
   Docker `oom` events feed the single status reconciler, which writes history-only rows for
   auto-restarted containers and a terminal `oom_killed` row for crashed/startup-failed ones.
4. UI placement: accepted full-width card between the state strip and the four-group accordion.
5. Delivery cycle: design, design review, owner questions, plan, plan review, implementation,
   record, and commit.

---

## Phase 0 - Baseline probes and call-graph confirmation

### Boundaries

In scope: read-only inspection, disposable SQLite databases, optional disposable Docker containers,
and a local test state. Out of scope: production code changes, production state, deployment
secrets, and real project data.

### Invariants

- Probes are read-only or use disposable local state; no production app, token, or data is touched.
- A failed probe blocks the dependent phase and becomes an owner question, not a silent workaround.
- Recorded evidence is redacted of host-specific values.

### Work

1. **Gate baseline.** Run `npm run lint`, `npm run typecheck`, `npm run typecheck:ui`, and targeted
   `npm test` on the untouched branch. Record pre-existing failures; do not fix unrelated ones.
2. **Migration SQL probe.** Apply the exact v29 DDL from the design to a temporary `better-sqlite3`
   database and assert: table/PK/CHECKs/indexes; `INSERT ... SELECT ... WHERE EXISTS` skips an
   unknown app; `ON CONFLICT(app_id, sampled_at) DO NOTHING` is idempotent; `strftime('%s', ...Z)`
   parses the repository timestamp; `CAST(... AS INTEGER) / CAST(? AS INTEGER)` produces integer
   buckets; two samples in one 30-minute bucket group together; a 24h/10m window is 144 full
   buckets plus one partial. Record the output in the journal draft.
3. **Docker stats/event probe (if Docker is available).** Run a disposable container with a small
   memory limit, verify `GET /containers/<id>/stats?stream=false&one-shot=true` returns
   `memory_stats.usage/limit/stats`, and verify a forced `oom` event appears on `GET /events` with
   `Actor.Attributes["hanse.app.id"]` when the container has the label. Do not touch any managed app.
   If Docker is unavailable, use API fixtures in the unit tests and record the limitation.
4. **AppPage history probe.** Re-read `ui/pages/AppPage.vue` (`historyEvents`, `historyCursor`,
   `historyLoaded`, `historyLoading`, `refreshRuntime`) and `ui/components/AppStateStrip.vue`
   (`onHistoryToggle`) and confirm the merge points described in the design.
5. **Settings resolver probe.** Confirm the three `structuredClone(definition.defaultValue)` sites
   and the `launchEffectiveSettings`/`settingsHashFor` path against the current code.

### Acceptance criteria

- Baseline failures (if any) are recorded and attributed to pre-existing code.
- The migration probe passes every assertion, including the two-samples-one-bucket and idempotency
  cases.
- The Docker probe result (pass or unavailable) is recorded; no managed container is touched.
- The AppPage merge points and settings clone sites are named with file:line in the journal draft.

### Verification

Manual/temporary probes only; record redacted evidence in the journal draft. No product code gates.

---

## Phase A - Migration v29 and memory-sample store

### Boundaries

In scope: migration v29, the memory-sample table/index, and a new store module with
insert/read/summary/latest/prune helpers. Out of scope: runner collection, HTTP, settings, OOM, UI.

### Invariants

- Migration v29 is appended after v28; no existing migration is edited.
- The table is additive and online-appliable; `ON DELETE CASCADE` removes history with the app.
- Timestamps are ISO `...Z`; the PK is `(app_id, sampled_at)`; insert is idempotent.
- Bucket SQL uses integer division (`CAST(@bucketSeconds AS INTEGER)`), never REAL division.
- Retention is 72 hours; prune is batched (500) and hourly, not per tick.

### Work

1. `src/store/migrations.ts`: append `version: 29`, name `app-memory-samples`,
   `backwardCompatible: true`, `requiresExclusive: false`, the exact DDL from design §5, and
   `CREATE INDEX app_memory_samples_sampled_at`.
2. `src/store/memory-samples.ts`: types `MemorySample`, `MemoryBucket`, `MemorySummary`; constants
   `MEMORY_SAMPLE_INTERVAL_MS = 30_000`, `MEMORY_SAMPLE_RETENTION_MS = 72h`,
   `MEMORY_SAMPLE_PRUNE_BATCH = 500`; functions `insertMemorySamples(db, samples, sampledAt)`,
   `readMemoryBuckets(db, appId, from, to, bucketSeconds)`,
   `readMemorySummary(db, appId, from, to)`, `readLatestMemorySample(db, appId, to)`,
   `pruneMemorySamples(db, now)`.
3. Insert uses one transaction, `INSERT ... SELECT ... WHERE EXISTS (SELECT 1 FROM apps WHERE
   id = ?)` per row (or an equivalent filtered batch), `ON CONFLICT(app_id, sampled_at) DO
   NOTHING`, and logs/counts skipped unknown app ids.
4. Update migration fixtures deliberately; **do not blanket-replace 28**:
   - `test/migrations.test.ts:65` - the version list gains 29 (`27,28` -> `27,28,29`);
   - `test/migrations.test.ts:365,375,378` - the future-schema test inserts version 30 and expects
     `applied: 30`, `known: 29`, with the message containing 30 and 29;
   - `test/migrations.test.ts:2344` - `MIGRATIONS.find(v === 28)?.backwardCompatible` stays 28
     (the v28 regression assertion);
   - `test/migrations.test.ts:480,557,766,913,1190` - `MAX(version)`/`max.version` become 29;
   - `test/migrations.test.ts:422` - the unknown-migration test's `knownMax: 28` becomes 29;
   - `test/migrations.test.ts:57,543,568,650,800,1086,1242,1417,1748,2276` - `runMigrations`
     expectations become 29;
   - `test/migrate-cli.test.ts:76,102,109` - `target`/`pendingCount` become 29; the `--online`
     test removes the v29 `app_memory_samples` table/index **and** the v29 schema row (not just the
     version), then expects `applied: 1, current: 29, target: 29`;
   - `test/settings-store.test.ts:45` - fresh `runMigrations` becomes 29;
   - decide and record whether the `schemaVersion: 28` fixtures in `test/deploy-http.test.ts:74,111`,
     `test/drain.test.ts:56,64`, and `test/http.test.ts:725` move to 29 (recommended: move them;
     they are readiness fixtures, not migration-regression assertions);
   - `docs/current-state.md:694` - `[1..28]` -> `[1..29]`.

### Acceptance criteria

- Fresh `runMigrations` reports 29 applied; a second run reports 0.
- The v29 DDL rejects negative usage/working-set, non-positive limit, and malformed timestamps.
- Two samples in the same 30-minute bucket return one bucket with `samples=2`, correct min/max/avg.
- Re-inserting the same `(app_id, sampled_at)` is a no-op; an unknown app id is skipped without
  aborting the batch; a real FK failure is not silently ignored.
- `readLatestMemorySample` is bounded by `to`; `pruneMemorySamples` removes rows older than 72h in
  batches and is idempotent.
- Deleting an app cascades its `app_memory_samples` rows.
- Current-schema expectations are 29; the deliberate v28 regression assertion remains 28; the
  future-schema test uses 30/29.

### Tests

- `test/migrations.test.ts`
- New `test/memory-store.test.ts` (DDL, CHECKs, idempotency, unknown app, bucket integer division,
  min/max/avg, partial bucket, latest bound, prune, app-delete cascade)

### Verification

`npm run typecheck`, `npx vitest run test/migrations.test.ts test/memory-store.test.ts`.

---

## Phase B - Runner stats, Docker event tracker, protocol/client

### Boundaries

In scope: Docker stats/event wrappers, `ContainerEventTracker`, `GET /v1/app-stats`, `oomEvents`
on the per-app status HTTP handler, protocol types, and the coordinator runtime client. Out of
scope: sampling loop, persistence, metrics HTTP API, settings, OOM process writes, UI.

### Invariants

- Runner API version stays 3; the new endpoint and `oomEvents` are additive; an older runner's 404
  is handled as "unsupported" by the sampler.
- Only the runner touches Docker. `containerStats?` and `streamEvents?` are optional
  `DockerRuntime` capabilities so existing fakes stay valid.
- Stats calls use `stream=false&one-shot=true`, a 5-second per-call timeout, a 15-second batch
  deadline, concurrency 4, and `Promise.allSettled`; one bad container cannot fail the batch.
- The tracker filters by `since` (exclusive), never drains, and is stopped synchronously with the
  runner.
- `oomEvents` is attached only in the `GET /v1/apps/:appId` HTTP handler, not in
  `RunnerService.status()`, so reconcile/ensure responses do not grow.

### Work

1. `src/runner/docker.ts`:
   - add `DockerContainerStats` / `DockerEvent` types and `containerStats?(id)` to
     `DockerRuntime`; implement `DockerClient.containerStats(id)`.
   - add `streamEvents(filter, signal)` on `DockerClient` using the existing line-oriented
     transport; encode the filter JSON; set an explicit long/disabled idle timeout; treat
     close/timeout as a normal reconnect.
2. New `src/runner/container-events.ts`: `ContainerEventTracker` with a bounded ring (256 events or
   10 minutes), `start()`, `stop()` (abort + clear timer), `eventsFor(appId, since)`, capped
   reconnect backoff, and app-id resolution from `Actor.Attributes["hanse.app.id"]` with an
   `inspectContainer` fallback. A Docker daemon restart loses events (documented).
3. `src/runner/server.ts`:
   - inject the tracker into `RunnerService` as a constructor option;
   - add `GET /v1/app-stats` (list managed running containers, dedupe by app id newest `Created`,
     stats, omit failures, return `{apps}`);
   - attach `oomEvents` in the `/v1/apps/:appId` HTTP handler only; parse/validate/URL-encode
     `since` (invalid -> absent);
   - start/stop the tracker in `runRunner`.
4. `src/agent/protocol.ts`: add `RuntimeAppMemoryStat`, `RuntimeOomEvent`, `RuntimeAppStats`, and
   `oomEvents?: RuntimeOomEvent[]` on `RuntimeAppStatus`.
5. `src/agent/client.ts`: optional `appStats?()`, and `status(appId, {since?})` with
   `encodeURIComponent`; 404 -> undefined for status, 404/transport for stats -> unsupported.
6. Tests: extend `test/runner-containers.test.ts` or add `test/runner-memory-stats.test.ts` and
   `test/runner-container-events.test.ts`; extend `test/agent-protocol.test.ts`/client tests.

### Acceptance criteria

- `GET /v1/app-stats` returns only running managed containers, one row per app id, with safe
  non-negative integer fields; a failed stats call is omitted and logged.
- `containerStats` parses cgroup v2 `inactive_file`, cgroup v1 `total_inactive_file`, and computes
  `workingSetBytes = max(0, usage - inactive)`; `limitBytes` is the container limit.
- The tracker emits parsed `{appId, at}` events, filters by `since`, survives a reconnect, and
  `stop()` leaves no timer/socket keeping the process alive.
- The status HTTP handler includes `oomEvents`; `RunnerService.reconcile()`/`ensure()` responses do
  not.
- The runner API version remains 3 and an old runner's 404 is treated as unsupported.

### Tests

- New `test/runner-memory-stats.test.ts` - cgroup v2 `inactive_file`, cgroup v1
  `total_inactive_file`, working-set clamp at zero, invalid payload omission, `one-shot` URL,
  per-call/batch timeout, newest-`Created` dedupe, sorted output, failed-container isolation.
- New `test/runner-container-events.test.ts` - `Actor.Attributes` app id, `inspect` fallback,
  `since` filtering (exclusive, non-draining), reconnect/backoff, `stop()` clears the timer/socket.
- Extend `test/runner-containers.test.ts` for the status handler/reconcile non-growth.
- Extend `test/agent-protocol.test.ts` / client request tests for `appStats` and `since`
  (`encodeURIComponent`, 404 -> unsupported).

### Verification

`npm run typecheck`, targeted `npx vitest run` for the runner/agent tests, and the Phase 0 Docker
probe evidence (or the recorded unavailability).

---

## Phase C - Coordinator sampler and metrics HTTP API

### Boundaries

In scope: `AppMemorySampler`, startup/shutdown wiring, `GET /api/apps/:app/memory`, bucket/summary
SQL, and the route tests. Out of scope: OOM process writes, settings, UI.

### Invariants

- One coordinator timestamp per batch; `ON CONFLICT DO NOTHING`; unknown app ids skipped.
- Sampling is single-flight, `unref`ed, 30 s; `stop(): Promise<void>` awaits the in-flight tick.
- A failure logs on transition, backs off 30 s -> 5 min, and re-enables on success; a 404 is not a
  permanent disable.
- The metrics route is human-only, project-scoped, `no-store`, with 400/404/409 semantics matching
  `/process`; 10m buckets with 72h are a 400.
- The sampler never writes process state or OOM events.

### Work

1. New `src/opencode/memory-sampler.ts`: `AppMemorySampler` with `db`, `runtime`, `logger`,
   `intervalMs`; `start`/`stop`/`runOnce`; batch timestamp; insert transaction; hourly prune;
   backoff/single-flight.
2. `src/cli/commands.ts`: construct with the existing `db`, `runtime`, `logger`; start next to
   `manager.startStatusReconciler()`; await `stop()` in the `stopBackground` block before DB close.
3. New `src/http/memory.ts`: parse/validate `window`/`bucket`, align `from` down, read buckets,
   summary (current/min/peak/average/limit in-window, `lastSampleAt` global), and OOM events from
   `agent_run_events` (`reason='oom_killed' OR error_code='oom_killed'`). Wire the route in
   `src/http/server.ts` before the `/api/apps/` chat catch-all.
4. Tests: `test/memory-sampler.test.ts`, `test/memory-http.test.ts`, plus route auth/validation
   coverage; use a temp DB and a fake runtime.

### Acceptance criteria

- A tick inserts one row per app with the same `sampled_at`; a repeat tick is idempotent; an
  unknown app id is skipped.
- A runner 404/transport failure backs off and recovers on the next success; `stop()` awaits an
  in-flight tick and no write happens after `db.close()`.
- The API returns 6/24/72h and 10/30m buckets; invalid params are 400; 10m+72h is 400; empty
  windows return empty buckets and null summary fields; gaps are omitted, never zero.
- `summary.currentBytes/limitBytes` are in-window; `lastSampleAt` is global; `averageBytes` is the
  window average; `minBytes`/`peakBytes` are window extrema.
- Agent principals get 403; a missing `project` is 400; an unknown app is 404; deletion pending is
  409; `cache-control: no-store`.

### Tests

- New `test/memory-sampler.test.ts` - immediate first tick, single timestamp per batch, repeat
  tick idempotency, unknown-app skip, 404/transport backoff 30s -> 5m, recovery, `stop()` awaiting
  an in-flight tick, no write after close.
- New `test/memory-http.test.ts` - window/bucket validation, 10m+72h 400, bucket math, gaps, empty
  window, in-window current/limit vs global `lastSampleAt`, OOM events, auth/project/404/409,
  `no-store`.
- Extend `test/application-api.test.ts` / route-dispatch tests for the new path.

### Verification

`npm run typecheck`, targeted `npx vitest run test/memory-sampler.test.ts test/memory-http.test.ts`,
and the Phase 0 SQL probe.

---

## Phase D - OOM event pipeline and labels

### Boundaries

In scope: `oom_killed` process-error code, the reconciler's history-only recorder, startup/crash
labels, watermark/rate-limit state, and the process/chat/overview UI labels. Out of scope: metrics
sampling, settings, the Memory card.

### Invariants

- The status reconciler is the only process writer; the sampler never writes process state.
- `#recordOomEvents` runs at the top of the `live` block, before the `persisted.state` early
  returns; the crash/startup branches own non-live OOMs.
- A history-only row does not update `instances` and does not emit on the process SSE bus.
- `oom:<at>` synthetic attempt ids are ≤128 chars; the ±60s dedupe recognizes history and crash
  rows; the watermark advances only to the highest durably handled `at`; rate-limited events are
  deliberate drops; per-event failures retry next tick.
- One OOM kill produces one OOM row; the existing `external_restart` transition may remain separate.

### Work

1. `src/opencode/process-errors.ts`: add `"oom_killed"` to `ProcessErrorCode`, `KNOWN_CODES`, and
   `GENERIC_MESSAGES` with the strong message.
2. `src/opencode/manager.ts`:
   - `#reconcileOne`: pass `{ since: this.#lastOomAt.get(appId) }` to `runtime.status(appId, ...)`
     (the current call is at `manager.ts:2869`). Use `const events = status.oomEvents ?? []`; only
     when `events.length > 0` compute `nextOomAt = max(events.map((event) => event.at))` and advance
     `#lastOomAt` at the exact live/error/stopped/tail points from design D4. An old runner without
     `oomEvents` and a response with no events must not throw or advance. The map is per app, in
     memory, and is not persisted (a fresh coordinator relies on the ±60s DB dedupe).
   - crashed branch: `errorCode: status.oomKilled ? "oom_killed" : "runtime_unavailable"` and the
     strong message;
   - non-live `persisted starting` branch: if `status.oomKilled` or a matching event
     (`startedAt <= at <= now`, ±60s fallback), write `error/failed/oom_killed` instead of
     `stale_start`;
   - add `#recordOomEvents` and `#appendProcessEvent`; call the former at the top of the `live`
     block; implement the ±60s dedupe, `oom:<at>`, rate limit after a successful insert,
     per-event try/catch, highest-handled-`at` return, and the tail watermark advance for the
     already-error path; advance error/stopped watermarks after the terminal write.
3. `ui/status.ts`: extend `processPill` with `errorCode`/`reason` and an "Out of memory" pill.
4. `ui/components/AppStateStrip.vue`: the current Runtime pill is currently
   `runtimePill`/`processPhasePill`, not `processPill`; replace that computed with
   `processPill(runtimeState, processPhase, processError?.code ?? null, null)` so an error-state
   OOM is labelled "Out of memory" (the history rows keep `processPill`). History rows pass
   `event.errorCode, event.reason`; add an OOM error title/body. In `ui/status.ts`, check
   `oom_killed` before the phase/state fallback.
5. `ui/components/chat/ChatThread.vue`: pass the code to the pill and use "Agent ran out of memory"
   for `oom_killed`.
6. `src/http/props/overview.ts` + `ui/pages/OverviewPage.vue`: add `errorCode` to the process row and
   pass it to the pill.
7. Tests: `test/manager.test.ts` (auto-restart, restart-backoff, no-restart crash, startup OOM,
   crash-then-restart no duplicate, rate-limit/watermark, per-event failure retry); `test/process-
   sanitizer.test.ts`; UI tests for `AppStateStrip`, `ChatThread`, `OverviewPage`, and `ui/status`.

### Acceptance criteria

- An auto-restarted OOM writes exactly one history-only row (state running/starting, no current
  error), visible in the app process history and the Memory card, not via a fake SSE attempt.
- A no-restart crash writes one terminal `error/failed/oom_killed` row.
- A startup OOM writes `error/failed/oom_killed`, not `interrupted`.
- A crash followed by a restart within the ring window does not create a second OOM row.
- A second legitimate OOM at least 60s after the recorded row is recorded; a burst within 60s is
  coalesced; the watermark advances for handled/rate-limited events and not past a failed insert.
- The app strip, chat, and overview show "Out of memory" when the process is in error; old rows with
  `reason=oom_killed` show the history pill.
- No process SSE frame carries a synthetic attempt id.

### Tests

- Extend `test/manager.test.ts` (including `since` propagation and watermark advancement),
  `test/process-sanitizer.test.ts`, `test/process-store.test.ts`, and `test/process-sse.test.ts`
  (history-only rows do not emit and do not reset `startedAt` in the stream adapter)
- New/extended UI tests: `ui/components/AppStateStrip.test.ts`, `ui/components/chat/ChatThread.test.ts`,
  `ui/pages/OverviewPage.test.ts`, `ui/status.test.ts`

### Verification

`npm run typecheck`, `npm run typecheck:ui`, targeted `npx vitest run` for the manager/process/UI
tests.

---

## Phase E - Settings, launch resources, and settings UI

### Boundaries

In scope: the `runtime.memory_mb` key, dynamic env default, effective/launch shapes, resource
override, settings hash/restart marker, master/human-only behavior, form conversion, and the
settings row. Out of scope: metrics/UI card.

### Invariants

- `runtime.memory_mb` is an integer MB, 128..65536, `merge: replace`, `clearable: false`.
- The env default is normalized to an integer in range; invalid/out-of-range -> 2048.
- `resolveRuntimeResources(env, memoryMb?)` uses `defaultAppMemoryMb(env)` when the override is
  undefined.
- `runtime.memoryMb` is in `EffectiveSettings` and `launchEffectiveSettings`; the spec hash and the
  settings hash both change on a memory change; the one-time fleet-wide restart marker is expected.
- `runtime.` is human-only; the master can read but not set/inherit it.
- Form-encoded numeric writes convert to a number; JSON writes already do.

### Work

1. New `src/config/app-resources.ts`: defaults, `positiveNumber`, `defaultAppMemoryMb`,
   `resolveConfiguredMemoryMb` (or equivalent). `defaultAppMemoryMb` is called **per resolve**
   (not frozen at module load), normalizes to an integer in `128..65536`, falls back to 2048 for
   non-finite/fractional/out-of-range values, and logs the one-time warning from design D5.
   Add `HANSE_APP_MEMORY_MB: ${HANSE_APP_MEMORY_MB:-2048}` to the coordinator service in
   `compose.yaml` and document it in `.env.example`. Do **not** add a default for
   `HANSE_APP_MEMORY_MAX_MB`.
2. `src/settings/types.ts`: add `"runtime.memory_mb"`, `EffectiveSettings.runtime.memoryMb`.
3. `src/settings/registry.ts`: add the definition; extend `defaultValue` to `T | (() => T)` and add
   one helper used at all three clone sites (`registry.ts:264,308,321`); the helper must call the
   function per resolve so an env change is visible after a coordinator restart; add to
   `KEY_DEFINITIONS`.
4. `src/settings/service.ts`: add `runtime.memoryMb` to `#resolve`; include `runtime` in
   `launchEffectiveSettings`.
5. `src/opencode/manager.ts`: import the shared defaults; `resolveRuntimeResources` override/
   fallback; `#captureLaunch` passes the effective value.
6. `src/master/tools.ts`: add the key to `effectiveValue`; add `"runtime."` to
   `HUMAN_ONLY_SETTING_PREFIXES`.
7. `src/http/settings.ts`: add `runtime.memory_mb` to the form numeric conversion.
8. `src/http/props/settings.ts`: add `buildRuntimeMemoryRow` and `rows.runtimeMemory`; add the row
   kind (`SettingsRowKind`). The key-count/restart constants are **not** in this file: in
   `ui/settings-view.ts` update `RESTART_AFFECTING_KEYS` (`:81`), `REGISTRY_KEYS` (`:90`), and
   `registryRows` (`:129`) plus the "13" comments.
9. `ui/settings-types.ts`, `ui/settings-view.ts`, `ui/pages/SettingsPage.vue`: add the row to the
   Agent pane, the client prop mirror, key counts, restart marker, and section mapping.
10. Update the test literals/hashes that break after `runtime` joins `EffectiveSettings`:
    `test/settings.test.ts:330-380` (`preChangeEffective`), `test/manager.test.ts:174-186`
    (`FakeSettings.snapshot`), `test/manager.test.ts:2690` (`preChangeEffective` hash input), and
    `test/web-mcp.test.ts:58` (`effectiveSettings()` is typed `EffectiveSettings`).
11. Tests: `test/settings.test.ts` (dynamic default per resolve, normalization/warning, all three
    clone sites, scopes/inherit, human-only), `test/settings-props.test.ts`,
    `test/settings-http.test.ts` (form numeric), `test/manager.test.ts` (launch resources/hash),
    `test/master.test.ts` (human-only set/inherit, get formatting), `ui/settings-view.test.ts`.

### Acceptance criteria

- Global/project/app resolution and inherit work; there is no clear action; invalid values are 400.
- The env default is normalized and displayed as `Default: <n> MB`; app/project show
  `Inherited: <n> MB`.
- The effective value changes the container `Memory`/`MemorySwap` and the spec hash; the settings
  hash changes too, so `pendingRestart` reports `settings_changed`.
- The master gets a human-only error for set/inherit; `get_settings` can format the key.
- Form-encoded numeric writes behave like JSON writes.
- The one-time fleet-wide restart marker is documented; no silent restart.

### Tests

- `test/settings.test.ts`, `test/settings-props.test.ts`, `test/settings-http.test.ts`,
  `test/manager.test.ts`, `test/master.test.ts`, `ui/settings-view.test.ts`

### Verification

`npm run typecheck`, `npm run typecheck:ui`, targeted `npx vitest run` for settings/manager/master/UI.

---

## Phase F - Memory card, chart, and live history

### Boundaries

In scope: `AppMemoryPanel`, SVG geometry helpers, the memory query composable, AppPage placement and
history merge, DESIGN.md amendments, and the E2E route coverage. Out of scope: settings editing
inside the card, project/overview memory surfaces, new chart dependencies.

### Invariants

- Managed branch: the card sits between `AppStateStrip` and the first `AppGroup`; the accordion
  remains exactly four groups. Master branch: the card sits after `AppStateStrip` and before the
  master panel (there is no `AppGroup` accordion in that branch).
- No chart library; inline SVG plus HTML axis labels; no brass; OOM/limit/band have non-color cues.
- Summary is `.watch-strip--4`; range/bucket are `.segmented`/`.select`; the summary Limit is the
  actual container limit from the latest in-window sample (not the configured setting); the edit
  link goes to `.../settings#memory-limit`.
- Range/bucket selection is persisted in the URL as `mem=24h:30m`; `Auto` means 10m for 6h and 30m
  for 24h/72h; 10m is disabled at 72h and below 768px.
- The card caption states that OOM rows/markers are coalesced to one per 60 seconds per app, so a
  crash loop may show one marker per minute rather than every kill.
- Poll 60 s, keep previous data, refetch on focus; gaps are gaps, never zero.
- The live-history merge unions by id, sorts desc, keeps the existing `historyCursor`, ignores while
  `historyLoading`, and leaves `historyLoaded` true after the first load.
- Mobile <768 collapses the chart body behind `Show chart`; the summary and OOM badge stay visible.

### Work

1. New `ui/memory-chart.ts` pure helpers; new `ui/components/AppMemoryPanel.vue`; new
   `ui/composables/useAppMemory.ts` (required by Work item 3).
2. `ui/pages/AppPage.vue`: insert the panel in both branches; add the `lastEventId` live-history
   merge with cursor/loading guards; wire the edit link.
3. Use the composable/API path: `AppMemoryPanel` calls `GET /api/apps/:app/memory` through
   `useAppMemory`; do not add a memory payload to page props in this stage.
4. `DESIGN.md`: §4.4 item 8, §5.6, §5.20 (classes, geometry literals, encoding, states, responsive),
   §8.1 chart contract, §9 class contract, §2.4 no-brass line.
5. `e2e/spa-app.spec.ts`: deterministic mocks for `/api/apps/:app/memory` (normal, empty, no-data,
   loading, stopped, OOM, error) and assertions for card placement, summary, actual limit,
   chart/legend, OOM badge, range/bucket, URL persistence, edit link, mobile disclosure, and the
   history merge. Add a visual QA scenario (extend `docs/design/ux-qa.mjs` fixtures/assertions or
   add `docs/design/memory-qa.mjs`) for 390/768/1440 dark/light; if Chromium is unavailable, record
   the explicit deferral in the journal instead of silently skipping.
6. Optional: add a static Memory card specimen to `docs/design/showcase.html` if it can be done
   without a live API; otherwise rely on the E2E/visual fixtures and document the choice in the
   journal.

### Acceptance criteria

- The managed branch renders the card after the state strip and before Git, with the four-group
  order unchanged; the master branch renders it after the state strip and before the master panel.
- The summary shows Current/Peak/Average/Limit; the chart shows the min–max band, working-set line,
  dashed limit, OOM markers, and a visible legend; 10m is disabled at 72h/<768.
- Empty/no-data/stopped/error/loading states match the design; no zero series is fabricated.
- The edit link opens the Agent settings pane at the memory row.
- A history-only OOM row appears in an open history list within one 10 s poll without a reload; the
  cursor is preserved and "Load older" still works.
- A11y: `role="img"` + `<desc>`, data table, focusable OOM markers/readout, `aria-pressed` controls,
  no hover-only information.
- `npm run test:e2e` covers the new route states.

### Tests

- New `ui/components/AppMemoryPanel.test.ts`, `ui/memory-chart.test.ts`
- Extend `ui/pages/AppPage.test.ts` (placement, merge, cursor, loading guard)
- Extend `e2e/spa-app.spec.ts` (route mocks + states)
- `ui/settings-view.test.ts` if the restart marker/section map changes

### Verification

`npm run typecheck:ui`, `npm run build`, `npm run check:ui`, `npx vitest run` for the UI files,
`npm run test:e2e`.

---

## Phase G - Documentation, full gates, record, and commit gate

### Boundaries

In scope: docs updates, the journal record, index updates, and the full verification suite. Out of
scope: committing without owner authorization.

### Work

1. `docs/current-state.md`: migration v29, the memory store/API/UI, `runtime.memory_mb`, the
   `oom_killed` event, and the sampler/backoff/retention behavior.
2. `docs/deployment.md`: per-app memory setting and env default, runner max (unset by default),
   migration v29 forward-only note, one-time fleet-wide restart marker, rollback = pre-upgrade DB
   backup, Docker-event best-effort boundary. Update the stale schema/N-1 examples in this file
   (`1..27` and `schemaVersion: 27` around the compatibility/readiness sections) to the current
   post-v29 values, or explain why the example is intentionally pinned.
3. `README.md`: sizing guidance now references the per-app override; remove the implication that the
   only knob is the global env cap.
4. `docs/design/settings-console.md`: 13 -> 14 keys; Agent pane memory row.
5. `docs/design/README.md`, `docs/plans/README.md`, `docs/journal/README.md`: update the entries and
   statuses.
6. Write `docs/journal/0062-app-memory-limits-and-metrics.md` with context, decisions, artifacts,
   verification output, accepted debt, and next steps.
7. Run the full gate set:
   `npm run lint`, `npm run typecheck`, `npm run typecheck:ui`, `npm run typecheck:e2e`, `npm test`,
   `npm run build`, `npm run check:sensitive`, `npm run test:e2e`.
8. Report "ready to commit" and wait for explicit owner authorization. On authorization, make one
   coherent commit (code + tests + docs + journal) with a Conventional Commit message.

### Acceptance criteria

- Every gate passes, including `test:e2e`; any pre-existing failure is attributed and not silently
  fixed.
- The journal and all indexes are updated.
- No commit exists until the owner explicitly authorizes it.
- The commit contains exactly the stage's files.

---

## Dependencies and parallelization

- Phase A, Phase B, and Phase E are independent and can proceed in parallel after Phase 0.
- Phase C depends on A + B.
- Phase D depends on B (status `oomEvents`) and the existing manager code.
- Phase F depends on C + D + E.
- Phase G depends on all prior phases.

## Risks and mitigations

| Risk | Mitigation |
| --- | --- |
| Migration v29 is forward-only; rollback after upgrade requires a pre-upgrade backup. | Document in `docs/deployment.md`; flag the migration in the deploy request; no destructive DDL. |
| Existing `HANSE_APP_MEMORY_MB` overrides could be rejected by a new runner max. | Leave `HANSE_APP_MEMORY_MAX_MB` unset by default; document that operators may set it; do not introduce an 8192 default. |
| One-time fleet-wide "restart required" after adding `runtime` to the launch hash. | Document; no silent restart; no hash backfill. |
| OOM events during runner/daemon downtime are lost. | Documented best-effort; the status crashed/startup branch remains a fallback; the Memory card still shows samples. |
| A crash loop is coalesced to one OOM history row per minute. | Documented in M9 and the card copy; the process history still shows `external_restart` transitions. |
| A per-event insert failure could lose an OOM row. | The recorder returns the highest durably handled `at`; the failed and later events retry next tick; dedupe/rate limit are idempotent. |
| Samples include page cache, overstating consumption. | Store raw usage and working set; chart the working set; limit line is the actual cgroup limit. |
| Docker stats overhead or a hung call. | 30 s batch, concurrency 4, 5 s per-call timeout, 15 s batch deadline, `one-shot=true`. |
| Env default normalization changes behavior for values <128 or >65536. | Documented; falls back to 2048; settings schema enforces 128..65536. |
| New chart drifts from the design contract. | DESIGN.md amendments, no new tokens, E2E/visual assertions, data-table fallback. |

## Plan review

### Review 1 - `momus`: OKAY WITH FIXES

The plan was found strong and aligned with the design, but not decision-complete for execution.
Findings and folded changes:

1. **Phase A migration-version update was unsafe/incomplete.** Replaced "28 -> 29 at all sites"
   with an explicit per-line list: the version list gains 29; the future-schema test uses 30/29;
   the v28 regression stays 28; `MAX(version)`/`runMigrations` expectations move to 29;
   `test/migrate-cli.test.ts` and `test/settings-store.test.ts` are included; the
   `schemaVersion: 28` readiness fixtures are moved to 29; the acceptance wording now
   distinguishes current-schema expectations from the deliberate v28 regression. Added the v29
   flags and an app-delete cascade test.
2. **Phase E missed approved settings behavior/fixtures.** Added `compose.yaml`/`.env.example`
   `HANSE_APP_MEMORY_MB`; stated the dynamic default is called per resolve (not frozen); added the
   one-time warning; named the `EffectiveSettings` test literals that must change
   (`test/settings.test.ts:330-380`, `test/manager.test.ts:174-186`); moved the
   `RESTART_AFFECTING_KEYS`/`REGISTRY_KEYS`/`registryRows` edits to `ui/settings-view.ts`; added
   explicit dynamic-default/normalization/human-only/form test cases.
3. **Phase D underspecified the OOM watermark and current pill.** Added the exact
   `runtime.status(appId, {since: #lastOomAt.get(appId)})` call-site, `nextOomAt = max(at)`, and
   the live/error/stopped/tail advancement points; clarified that the current Runtime pill uses
   `runtimePill`/`processPhasePill` today and must be replaced by
   `processPill(runtimeState, processPhase, processError?.code, null)`; added a
   `test/process-sse.test.ts` assertion that history-only rows do not emit and do not reset
   `startedAt`.
4. **P2 folds:** Phase F now covers URL persistence (`mem=24h:30m`), the Auto bucket mapping, the
   actual container limit, the master-branch placement, the crash-loop caption, loading/stopped
   E2E states, and a 390/768/1440 dark/light visual QA scenario (or an explicit journal
   deferral). Phase G adds `npm run typecheck:e2e` and the stale deployment schema/N-1 examples.
   Phase B/C test lists now name the risky cases instead of only files. Phase 0 attributes
   `onHistoryToggle` to `AppStateStrip.vue`.

### Review 2 - `momus`: OKAY WITH FIXES

The revision folded the prior groups, but three concrete test/guard gaps remained:

1. **Phase A:** `test/migrations.test.ts:422` (`knownMax: 28 -> 29`) was missing; the `--online`
   fixture also needed to remove the v29 table/index plus the schema row, not only the version.
2. **Phase E:** the `EffectiveSettings` literal list was incomplete; `test/web-mcp.test.ts:58`
   (typed) and `test/manager.test.ts:2690` (`preChangeEffective` hash input) also break.
3. **Phase D:** the `since`/watermark step must guard optional/empty `status.oomEvents`; otherwise
   an old runner throws on `undefined` and an empty list yields `-Infinity`.

Revision 3 adds the missing migration line and CLI fixture detail, the two settings literals, and
the `status.oomEvents ?? []` guard with "advance only when non-empty"; it also fixes the Phase F
"both branches before Git" acceptance wording and chooses the composable/API path instead of the
open props-vs-composable option.

### Review 3 - `momus`: OKAY

No remaining must-fix. The three prior gaps are correctly folded: Phase A includes
`test/migrations.test.ts:422` and the v29 `--online` fixture; Phase E covers
`test/web-mcp.test.ts:58` and `test/manager.test.ts:2690`; Phase D guards
`status.oomEvents ?? []` and only advances the watermark when events exist; Phase F acceptance
distinguishes the managed and master branches and Work item 3 chooses the composable path. One
optional nit (the Work item 1 "optional" wording for `useAppMemory`) is folded by making the
composable required. Implementation may proceed; commit still requires explicit owner
authorization.
