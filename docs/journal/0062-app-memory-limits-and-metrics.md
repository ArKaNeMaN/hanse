# Journal 0062 - Per-application memory limits and container memory metrics

Status: **implementation complete (phases A-G); final full gates, E2E, and visual QA pass**
(2026-11-16). Design `oracle` PASS; plan `momus` OKAY. Commit is blocked until the owner explicitly
authorizes it. This record does not claim a commit.

Design: [`docs/design/app-memory-limits-and-metrics.md`](../design/app-memory-limits-and-metrics.md)
Plan: [`docs/plans/0048-app-memory-limits-and-metrics.md`](../plans/0048-app-memory-limits-and-metrics.md)
Owner decisions: [`docs/open-questions.md`](../open-questions.md), stage
`0048-app-memory-limits-and-metrics` (2026-11-16). No open questions.

## Phase 0 - baseline and probes

- Baseline on the working tree before product changes: `npm run typecheck` exit 0,
  `npm run typecheck:ui` exit 0, `npm run lint` exit 0 (967 files, no fixes). The tree already
  contains uncommitted changes from the concurrent deploy-contract stage; they are preserved, not
  reverted.
- SQL probe (temporary `better-sqlite3` database under the app runtime temp directory): the exact
  v29 DDL, both CHECK sets, the composite primary key, `ON CONFLICT(app_id, sampled_at) DO NOTHING`
  idempotency, `INSERT ... SELECT ... WHERE EXISTS` unknown-app skip, `strftime('%s', ...Z)`
  parsing, integer bucket division via `CAST(... AS INTEGER)`, two samples in one 30-minute bucket,
  and `ON DELETE CASCADE` all passed. Result: PASS.
- Docker probe: the application container has no `docker` CLI/socket, so the disposable
  stats/`oom` event probe could not run here. The runner implementation is covered by unit fixtures
  (cgroup v1/v2 fields, `Actor.Attributes`, `since`, reconnect) and the design's Docker API
  contract; this limitation is recorded rather than worked around. **The Docker stats/event probe
  remains pending.**
- AppPage/settings probes: `historyEvents`/`historyCursor`/`historyLoaded`/`historyLoading`/
  `refreshRuntime` live in `ui/pages/AppPage.vue`; `onHistoryToggle` lives in
  `ui/components/AppStateStrip.vue`; the three dynamic-default clone sites were
  `src/settings/registry.ts:264,308,321`; `launchEffectiveSettings`/`settingsHashFor` are the
  launch-hash path. No code changed in phase 0.

## Phase A - migration v29 and the memory-sample store

Shipped:

- Migration v29 `app-memory-samples` is additive/backward-compatible, appends after v28, and creates
  `app_memory_samples` with a composite `(app_id, sampled_at)` primary key, the timestamp/byte
  CHECKs, `ON DELETE CASCADE`, and the `sampled_at` prune index.
- `src/store/memory-samples.ts` adds `MemorySample`, `MemoryBucket`, `MemorySummary`, the 30 s
  interval/72 h retention/500-row prune constants, and `insertMemorySamples`,
  `readMemoryBuckets`, `readMemorySummary`, `readLatestMemorySample`, and `pruneMemorySamples`.
- Inserts use one coordinator-assigned batch timestamp, one transaction, `INSERT ... WHERE EXISTS`
  so a just-deleted app is skipped, and `ON CONFLICT(app_id, sampled_at) DO NOTHING` for idempotent
  replay. Bucket grouping uses integer division, not REAL division.
- Migration fixtures moved deliberately to 29, while the v28 regression assertion stays 28 and the
  future-schema test uses 30/29. Readiness fixtures moved to 29.

Changed files: `src/store/migrations.ts`, `src/store/index.ts`, `src/store/memory-samples.ts`,
`Dockerfile` (coordinator `org.hanse.schema.max` 28 -> 29), `test/migrations.test.ts`,
`test/migrate-cli.test.ts`, `test/memory-store.test.ts`, `test/settings-store.test.ts`,
`test/deploy-http.test.ts`, `test/drain.test.ts`, `test/http.test.ts`, `test/commands.test.ts`,
`test/skills-store.test.ts`, `test/store.test.ts`.

Evidence: targeted `npx vitest run` for the migration/store files, **119 tests**. Typecheck, UI
typecheck, and lint were clean at this phase.

## Phase B - runner stats, container event tracker, protocol/client

Shipped:

- `DockerClient.containerStats(id)` uses `GET /containers/<id>/stats?stream=false&one-shot=true`
  with a 5 s timeout and parses cgroup v2 `inactive_file` or v1 `total_inactive_file` into
  `workingSetBytes = max(0, usage - inactive)` plus `usageBytes`, `limitBytes`, and optional
  `anonBytes`/`fileBytes`.
- `DockerClient.streamEvents(filter, signal)` uses the line-oriented Docker transport on
  `GET /events` with the idle timeout disabled; close/timeout is a normal reconnect.
- New `ContainerEventTracker` keeps a bounded ring of `{appId, at}` Docker `oom` events, resolves
  the app from `Actor.Attributes["hanse.app.id"]` with an inspect fallback, filters by `since`
  without draining, reconnects with capped backoff, and stops synchronously.
- `GET /v1/app-stats` lists managed `running` containers, dedupes by app id with the newest
  `Created`, calls stats with concurrency 4, a 5 s per-call timeout, and a 15 s batch deadline,
  omits failed containers, logs one count, and returns `{apps}` sorted by `appId`.
- `GET /v1/apps/:appId?since=<ISO>` attaches `oomEvents` in the HTTP handler only; `reconcile` and
  `ensure` responses do not grow. An invalid `since` is treated as absent (default last 10 minutes).
- Protocol types `RuntimeAppMemoryStat`, `RuntimeOomEvent`, `RuntimeAppStats`, and
  `RuntimeAppStatus.oomEvents`; the coordinator client adds optional `appStats?()` and
  `status(appId, {since?})`. **The runner API version stays 3; the endpoint and fields are
  additive**, so an older runner's `404` means "metrics unavailable" and an older coordinator still
  consumes a new runner.

Changed files: `src/runner/docker.ts`, `src/runner/container-events.ts`, `src/runner/server.ts`,
`src/agent/protocol.ts`, `src/agent/client.ts`, `test/runner-memory-stats.test.ts`,
`test/runner-container-events.test.ts`, `test/runner-containers.test.ts`,
`test/agent-protocol.test.ts`, `test/runtime-client.test.ts`, `test/fixtures/fake-runtime.ts`.

Evidence: targeted runner/agent tests, **71 tests**. Typecheck, UI typecheck, and lint were clean at
this phase.

## Phase C - coordinator sampler and metrics HTTP API

Shipped:

- New `AppMemorySampler` runs immediately and then every 30 s, is single-flight, uses one batch
  timestamp, writes one transaction, prunes at most hourly in 500-row batches, logs on failure
  transition, and backs off from 30 s to 5 min instead of disabling on a `404`/transport failure.
  `stop()` awaits an in-flight tick and no write happens after `db.close()`.
- It is constructed in `src/cli/commands.ts` next to the status reconciler and awaited in the
  shutdown block before the database closes. It never writes process state or OOM events.
- New `GET /api/apps/:app/memory?project=<id>&window=6h|24h|72h&bucket=10m|30m` is human-only,
  project-scoped, `no-store`, and uses the same `400`/`403`/`404`/`409` semantics as `/process`.
  `10m` with `72h` is `400`. The window starts on a bucket boundary and ends at now; empty buckets
  are omitted (gaps, never zero). Summary current/limit are in-window; `lastSampleAt` is global;
  `events` reads `oom_killed` rows from `agent_run_events`.

Changed files: `src/opencode/memory-sampler.ts`, `src/http/memory.ts`, `src/http/server.ts`,
`src/cli/commands.ts`, `test/memory-sampler.test.ts`, `test/memory-http.test.ts`.

Evidence: targeted sampler/HTTP tests, **25 tests**. Typecheck, UI typecheck, and lint were clean at
this phase.

## Phase D - OOM event pipeline and labels

Shipped:

- `oom_killed` is a stable `ProcessErrorCode`/`KNOWN_CODES` entry with the strong message
  "The agent was killed after exceeding its memory limit."
- The 15 s reconciler passes a per-app `since` watermark and consumes `status.oomEvents ?? []`.
  In the live `running`/`starting` branch it appends a **history-only** row with the current
  state/phase, `source: "runtime"`, `reason`/`errorCode` `oom_killed`, a neutral message, and the
  Docker event time. It uses the current attempt or a bounded synthetic `oom:<at>` attempt when the
  event predates the attempt.
- Dedupe against any `reason='oom_killed'` row within ±60 s makes replay/restart idempotent.
  History-only OOM rows are rate-limited to one per 60 s per app, so a crash loop is coalesced to one
  row and one chart marker per minute. A failed insert stops the watermark at that event and the
  next tick retries; a handled/rate-limited event advances it.
- The crash path writes `error`/`failed` with `errorCode: "oom_killed"`; a startup OOM writes
  `error`/`failed`/`oom_killed` instead of `interrupted`. One kill produces one OOM row (an
  `external_restart` transition may still be separate).
- History-only rows never touch `instances` and **never emit on the process SSE bus**; an open page
  learns them from its `lastEventId` history poll. UI: `processPill` returns "Out of memory" from
  `errorCode`/`reason`, the app strip/chat/overview use an OOM title, and old rows without a code
  keep "Failed".

Changed files: `src/opencode/process-errors.ts`, `src/opencode/manager.ts`, `ui/status.ts`,
`ui/components/AppStateStrip.vue`, `ui/components/chat/ChatThread.vue`, `src/http/props/overview.ts`,
`ui/pages/OverviewPage.vue`, `test/manager.test.ts`, `test/process-sanitizer.test.ts`,
`test/process-sse.test.ts`, `test/process-store.test.ts`, `ui/components/AppStateStrip.test.ts`,
`ui/components/chat/ChatThread.test.ts`, `ui/pages/OverviewPage.test.ts`, `ui/status.test.ts`.

Evidence: targeted manager/process/UI tests, **247 tests**. Typecheck, UI typecheck, and lint were
clean at this phase.

## Phase E - settings, launch resources, and settings UI

Shipped:

- New `src/config/app-resources.ts` owns `DEFAULT_APP_MEMORY_MB=2048`, CPU/PID defaults, the
  `128..65536` bounds, `positiveNumber`, and `defaultAppMemoryMb`, which normalizes
  `HANSE_APP_MEMORY_MB` per resolve and warns once for a non-finite/fractional/out-of-range value.
- `runtime.memory_mb` is an integer MB setting at global/project/application scope, `merge:
  replace`, `clearable: false`, with a dynamic env-derived default. The three registry clone sites
  call the default function per resolve.
- `EffectiveSettings.runtime.memoryMb` and `launchEffectiveSettings` include it, so the effective
  setting, spec hash, and settings hash change together; a memory change shows the existing
  restart-required state and never restarts silently. The one-time fleet-wide restart marker after
  the upgrade is expected and documented.
- `resolveRuntimeResources(env, memoryMb?)` uses the setting override or the normalized env default;
  CPU and PIDs remain `HANSE_APP_CPUS`/`HANSE_APP_PIDS`. `compose.yaml` now passes
  `HANSE_APP_MEMORY_MB` explicitly and `.env.example` documents it. No default was added for
  `HANSE_APP_MEMORY_MAX_MB`.
- `runtime.` joined `HUMAN_ONLY_SETTING_PREFIXES`: the master can read `get_settings` but cannot
  set/inherit the key. The settings UI adds the Agent-pane **Memory limit** row with global
  `Default: <n> MB` and project/app `Inherited: <n> MB` placeholders; key counts moved from 13 to 14.
  Form-encoded numeric writes convert the key like JSON writes.

Changed files: `src/config/app-resources.ts`, `src/settings/registry.ts`, `src/settings/service.ts`,
`src/settings/types.ts`, `src/opencode/manager.ts`, `src/master/tools.ts`, `src/http/settings.ts`,
`src/http/props/settings.ts`, `ui/settings-types.ts`, `ui/settings-view.ts`,
`ui/pages/SettingsPage.vue`, `compose.yaml`, `.env.example`, `test/settings.test.ts`,
`test/settings-props.test.ts`, `test/settings-http.test.ts`, `test/settings-store.test.ts`,
`test/manager.test.ts`, `test/master-tools.test.ts`, `test/web-mcp.test.ts`, `ui/settings-view.test.ts`,
`ui/pages/SettingsPage.test.ts`, `ui/components/SettingsTelegramSection.test.ts`.

Evidence: targeted settings/manager/master/UI tests, **344 tests**. Typecheck, UI typecheck, and
lint were clean at this phase.

## Phase F - Memory card, chart, AppPage, and live history

Shipped:

- New `AppMemoryPanel.vue` renders the full-width Memory card with a four-cell summary, a hand-rolled
  inline SVG chart (min-max band, working-set average line, dashed actual container limit, current
  point, OOM markers), an accessible `<details>` data table, a polite readout, and a
  `6 h | 24 h | 72 h` range plus `Auto | 10 min | 30 min` bucket control. `Auto` resolves to 10 min
  for 6 h and 30 min for 24/72 h; 10 min is disabled for 72 h and below 768 px, where the chart body
  collapses behind **Show chart**. The selection is persisted in the URL as `mem=24h:30m`.
- States: loading skeleton, never sampled, no data in the selected range (with a wider-range
  action), stopped (historical chart remains, current is blank), stale/error with Retry, and OOM in
  range. Captions state that OOM rows/markers are coalesced to one per minute per app. Limit is the
  actual container limit from the latest in-window sample, not the configured setting. The edit link
  goes to `.../settings#setting-runtime-memory`.
- New `ui/memory-chart.ts` pure geometry/formatting helpers and `ui/composables/useAppMemory.ts`
  (60 s poll, keep previous data, refetch on focus, no retry storm). `AppPage.vue` inserts the card
  after `AppStateStrip` in both the managed and master branches and merges new `/process` first-page
  events into loaded history by id while preserving the oldest cursor and skipping while a load is
  in flight.
- `DESIGN.md` documents the card placement and chart contract; no chart dependency was added.

Changed files: `ui/components/AppMemoryPanel.vue`, `ui/components/AppMemoryPanel.test.ts`,
`ui/memory-chart.ts`, `ui/memory-chart.test.ts`, `ui/composables/useAppMemory.ts`,
`ui/pages/AppPage.vue`, `ui/pages/AppPage.test.ts`, `ui/app-types.ts`, `src/http/styles.css`,
`DESIGN.md`, `e2e/spa-app.spec.ts`, `e2e/app.spec.ts`, `docs/design/memory-qa.mjs`,
`docs/design/artifacts/memory/`.

Evidence: targeted core UI tests, **30 tests**; targeted AppPage tests, **53 tests**. Typecheck, UI
typecheck, and lint were clean at this phase. A static showcase specimen was not added; the card is
covered by component/E2E fixtures instead. Playwright covers placement, summary, chart/legend,
OOM, controls/URL, edit link, mobile disclosure, empty/no-data, and retryable error states. The
visual-QA harness passed **92 assertions** and wrote eight element screenshots at 390/768/1440 in
dark and light.

## Phase G - documentation

- `docs/current-state.md` now describes the per-app `runtime.memory_mb` cap and env default, enforced
  CPU/PID limits, the additive runner memory/OOM API, the OOM history/dedupe/rate-limit behavior, the
  Memory card and live-history merge, the v29 `app_memory_samples` table, the 14-key settings
  surface, the memory HTTP API, and the four memory/CPU/PID env variables.
- `docs/deployment.md` now records schema `1..29`, the additive runner API 3 memory/OOM note, the
  setting/default/optional-ceiling semantics, the v29 forward-only boundary, and the one-time
  fleet-wide restart-required effect from `runtime` joining the launch settings hash.
- Indexes: `docs/journal/README.md` gained this entry; the plan and design entries reflect the
  implementation status. `docs/open-questions.md` already records the closed owner decisions.
- The design's `docs/design/settings-console.md` key count moved from 13 to 14.

## Verification state

Known targeted evidence from the implementation phases: Phase A 119 tests, B 71, C 25, D 247,
E 344, F core 30, F app 53; typecheck, `typecheck:ui`, and lint were clean at each phase.

Still open:

- The disposable Docker `stats`/`oom` probe could not run in the application container (no Docker
  CLI/socket). Runner behavior is covered by unit fixtures and the documented Docker API contract.
- OOM events during runner or Docker daemon downtime are lost; the crashed/startup branch remains
  the fallback.

## Final gates

All commands below ran on the final tree and passed:

- `npm run lint` - 987 files, no fixes.
- `npm run typecheck` - exit 0.
- `npm run typecheck:ui` - exit 0.
- `npm run typecheck:e2e` - exit 0.
- `npm test` - 291 files passed, 4 skipped; 4,353 tests passed, 4 skipped.
- `npm run build` - passed as part of `npm run test:e2e` (tsc + Tailwind + Vite).
- `npm run check:sensitive` - passed.
- `npm run test:e2e` - 151 passed, 1 skipped (includes the Memory card states and the live-history
  merge).
- `node docs/design/memory-qa.mjs` - PASS, 92 assertions, eight screenshots at 390/768/1440 in
  dark and light.

E2E note: the existing `#runtime-state` assertions in `e2e/spa-app.spec.ts` and `e2e/app.spec.ts`
now expect `Ready` instead of `Running`, matching the concurrent `AppStateStrip` change that renders
the process phase. No assertion was weakened or skipped.

## Accepted limits

- OOM events during runner or Docker daemon downtime are lost; the crashed/startup branch remains
  the fallback and the Memory card still shows samples.
- A crash loop is coalesced to at most one history OOM row and marker per minute per app; process
  history may still show separate `external_restart` transitions.
- Samples measure the container cgroup, not one process. Raw usage includes page cache, so the chart
  uses the working set and the limit line is the actual container limit from the latest sample.
- `HANSE_APP_MEMORY_MAX_MB` remains an optional operational ceiling; this stage adds no default and
  does not clamp a request.
- History is limited to 72 hours of 30-second samples; there is no longer-term rollup table.
