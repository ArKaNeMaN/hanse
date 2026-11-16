# Design - Per-application memory limits and container memory metrics

Status: **approved by `oracle`** (2026-11-16; design review PASS, no must-fix). Implementation is
gated on the plan review. The six-round review history and the two optional nits are recorded in
§18. Owner decisions are closed (no open questions).

Scope: a per-application memory limit available at global, project, and application scope, with
`HANSE_APP_MEMORY_MB` as the default; bounded per-application container memory sampling with a
history chart; and a distinct `oom_killed` process event so an OOM interruption is obvious in the
application page and chat.

Out of scope: per-application CPU/PID settings, alerting or automatic remediation, memory history
longer than 72 hours, per-process (opencode vs Godot vs LSP) breakdown, memory-pressure prediction,
and changing the runner's hard resource-ceiling model.

Project profile bindings (phase 0 of `feature-delivery`, from `docs/process.md`):

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

Today every application container receives the same resources from the coordinator process
environment: `HANSE_APP_MEMORY_MB` (default 2048), `HANSE_APP_CPUS` (default 2), and
`HANSE_APP_PIDS` (default 512), resolved by `resolveRuntimeResources()` and applied at
`#captureLaunch`. There is no per-application override and no runtime memory history. A game
development agent that needs 1.5 GB for `opencode`, 600 MB for the Godot LSP, and 1 GB+ for test
renders therefore competes for one 4 GB cap with no way to see what actually happens over time.

This design adds three coupled pieces:

1. **A hierarchical `runtime.memory_mb` setting** at global, project, and application scope.
   `null`/absent inherits the wider scope and eventually the environment-derived default
   `HANSE_APP_MEMORY_MB` (2048 MB). The effective value is resolved at launch and becomes the
   container's `Memory`/`MemorySwap`; it is part of the launch fingerprint and the settings hash, so
   a change shows the existing "restart required" state instead of restarting silently.
2. **Container memory metrics.** The runner exposes one-shot Docker `/stats` for all managed running
   containers in one batch. The coordinator samples every 30 seconds, stores bounded rows in a new
   `app_memory_samples` table (72-hour retention), and serves pre-bucketed min/max/average series
   for 6, 24, or 72 hours at 10- or 30-minute resolution. The application page gets a full-width
   `Memory` card between the state strip and the four-group accordion.
3. **A distinct OOM event.** OOM is observed from Docker `oom` events by the runner (not only from
   the status reconciler), persisted as an `agent_run_events` row with `reason: "oom_killed"` and
   `errorCode: "oom_killed"`, and surfaced as a distinct pill/title in the UI and as a chart marker.
   When the container did not auto-restart, the existing crashed branch also records the error code.

The metric is deliberately a **container/cgroup** metric, not the `opencode` process RSS: the Godot
LSP, renders, MCP children, and Chromium all live in the same container cgroup and share the limit.

## 2. Current behaviour and problem

- Resources are global: `resolveRuntimeResources()` reads `HANSE_APP_MEMORY_MB`/`HANSE_APP_CPUS`/
  `HANSE_APP_PIDS` from `process.env` and is called with no application argument at
  `src/opencode/manager.ts:1681`. `.hanse/app.yaml` and `.hanse/project.yaml` have no resource field.
- The runner applies `Memory = MemorySwap = memoryBytes`, `NanoCpus`, and `PidsLimit`
  (`src/runner/docker.ts:1157-1165`), so swap is off and the cgroup cap is hard.
- App containers use `RestartPolicy: unless-stopped` (`src/runner/docker.ts:1166-1169`). Docker
  restarts an OOM-killed container automatically and resets `State.OOMKilled` on start, so the
  15-second status reconciler usually sees a live `starting`/`running` container with an increased
  restart count and records `reason: "external_restart"`, not a crash. OOM detection cannot rely on
  the crashed branch alone.
- A runner-side ceiling (`HANSE_APP_MEMORY_MAX_MB`) rejects, but never clamps, a spec above it
  (`src/runner/server.ts:774-797`). The compose file currently forwards it empty, so by default no
  runner ceiling exists.
- No Docker stats call, cgroup read, metrics table, or chart exists. The only adjacent signals are
  `State.OOMKilled` (a current boolean), `instances.last_oom_killed`, and the append-only
  `agent_run_events` history.
- OOM is recorded as a generic error transition only when the reconciler catches an exited
  container: state `error`, phase `failed`, `reason: "oom_killed"`,
  `errorCode: "runtime_unavailable"`, with Docker's `State.Error` or a generic message. History
  shows the raw reason, but the pill says "Failed"; chat says "Agent failed to start"; `errorCode`
  is not displayed.

The operational result is blind sizing: the operator raises the global cap for every app, still sees
OOMs for the heaviest app, and has no evidence of the actual working set, peak, or whether the
container hit its limit or merely filled page cache.

## 3. Requirements

| ID | Requirement |
| --- | --- |
| M1 | A `runtime.memory_mb` setting exists at global, project, and application scope, resolves wide-to-narrow, and defaults to the normalized environment-derived `HANSE_APP_MEMORY_MB` (2048 when unset or invalid). |
| M2 | The effective memory value is applied at launch to the container memory cap; CPU and PID limits stay environment-only in this stage. |
| M3 | A memory setting change alters the launch fingerprint and the launch-effective settings hash, so the existing restart-required flow is shown and no silent restart occurs. |
| M4 | The runner exposes one-shot container memory statistics for managed running applications in one authenticated batch call, and the per-app status endpoint returns that app's recent Docker `oom` events. |
| M5 | The coordinator samples metrics every 30 seconds with one coordinator-assigned batch timestamp, stores bounded rows idempotently, and prunes data older than 72 hours. |
| M6 | The human-only metrics API returns 6/24/72-hour windows at 10/30-minute buckets with per-bucket min, max, average, and count, plus window current/min/peak/average/limit and OOM events. |
| M7 | Missing samples are gaps, never zero; a stopped or never-started app is not rendered as 0 MiB. |
| M8 | The application page shows a full-width Memory card with a four-cell summary, a hand-rolled SVG chart, range/bucket controls, OOM markers, and a link to edit the limit in settings. |
| M9 | An OOM observed by the runner's Docker event watcher is returned with the per-app status and persisted by the single status reconciler as a distinct `agent_run_events` event with `reason`/`errorCode` `oom_killed`, even when the container auto-restarts; when the container stays down, the existing crashed path records `errorCode: "oom_killed"`. One kill produces one OOM row (never two), and history-only OOM rows are coalesced to at most one per 60 seconds per app. The event is visibly distinct in process history and the Memory card; chat, the runtime panel, and the overview show it when the process is in error. |
| M10 | High-frequency memory samples never enter `agent_run_events`; only semantic transitions (notably OOM) do. |
| M11 | Storage and query cost stay bounded: at 30 applications, 72 hours of 30-second samples is roughly 260k rows and tens of megabytes, and a 24-hour chart query reads at most 2,880 rows for one app. |
| M12 | The change is additive: migration v29 is a new online-appliable table; the runner endpoint is additive and does not require a protocol-version bump; the OOM change needs no migration. An older binary still requires a pre-upgrade database backup (the schema guard rejects a newer schema). |
| M13 | Existing app-scoped settings, master settings tools, the numeric settings row, and form-encoded settings writes keep working. |
| M14 | Memory values are not secrets; no raw container logs or process environments are stored or returned. |

## 4. Decisions

### D1 - Container memory as raw usage plus working set

Docker/cgroup `usage` includes page cache. A container can show 3.9 GiB of 4 GiB while most of it is
reclaimable. The sampler therefore stores both:

- `usage_bytes` - `memory_stats.usage`, the number the kernel enforces;
- `working_set_bytes` - `max(0, usage - inactive_file)` (cgroup v2 `inactive_file`, v1
  `total_inactive_file`), matching the Docker CLI's "MEM USAGE" intent;
- `limit_bytes` - `memory_stats.limit` at sample time;
- `anon_bytes` / `file_bytes` - optional cgroup breakdown for diagnosis.

The chart's primary series is the working set; raw usage and the breakdown remain available for
tooltips and future detail. The limit line is the actual container limit from the latest sample in
the selected window, not the configured setting, so the chart stays truthful before a restart
applies a new setting.

### D2 - Runner batch endpoint, not per-app calls or direct cgroup reads

The runner is the only component with the Docker socket. Add one authenticated
`GET /v1/app-stats` that:

1. lists managed containers with `hanse.managed=true`;
2. keeps those in `running` state, deduplicating by `hanse.app.id` (newest `Created` wins if a
   recreate briefly leaves two generations);
3. calls Docker `GET /containers/<id>/stats?stream=false&one-shot=true` for each (the `one-shot`
   flag is what avoids waiting for two collection cycles; memory fields are valid in a one-shot
   sample);
4. resolves each container's `hanse.app.id` label;
5. returns `{ apps: RuntimeAppMemoryStat[] }`.

The per-app status endpoint `GET /v1/apps/:appId?since=<ISO>` is extended to return
`oomEvents: RuntimeOomEvent[]` from the runner's Docker event tracker. The status response is the
existing per-app status call the 15-second reconciler already makes for every non-stopped instance,
so the OOM events ride the single process writer's input rather than requiring a second writer. The
tracker is independent of the stats batch; memory sampling never writes process state.

This is one coordinator-to-runner HTTP request per tick instead of N, and it keeps Docker access in
the runner. Direct cgroup reads were rejected: they require resolving the Docker cgroup path and
diverge between cgroup v1/v2 and Docker drivers, while `docker stats` already normalizes the fields.
Per-container failures are omitted from the response and logged; one bad container must not fail the
whole sample. Each stats call gets a 5-second timeout and the batch has a 15-second deadline, so a
hung container cannot consume the coordinator's 30-second client timeout.

`GET /v1/app-stats` does not collide with `/v1/apps/:appId`; the latter requires the `/v1/apps/`
prefix. The `oomEvents` field and the optional `since` query are additive response/request fields.
**The runner API version stays at 3.** A coordinator talking to an older runner receives `404` for
the stats endpoint and simply backs off; an older runner ignores the unknown `since` query and
returns the status without `oomEvents`. A new runner still serves an older coordinator. This keeps
coordinator-only and runner-only rollback possible. No handshake change is needed.

### D3 - 30-second sampling, 72-hour retention, aggregation on read

- Sampling interval: 30 s. This catches render/test spikes that a 60 s sample can miss and bounds
  the chart to a readable resolution.
- Retention: 72 h, matching the longest UI window. At 30 apps this is about 259k rows; one app is
  about 8.6k rows and 1-2 MB. The table is tiny relative to the image/build data.
- No pre-aggregated tables. A 24-hour query reads 2,880 rows for one app; 72 hours reads 8,640. SQL
  grouping is fast enough and keeps the write path single-table.
- Prune hourly in batches of 500, following the existing `pruneAllProcessEvents` pattern. Do not run
  it on every 30-second tick. The `sampled_at` index makes the hourly prune a bounded range scan;
  the write cost of the extra index is accepted for predictable prune time.
- If a future deployment needs more history, the migration path is a 5- or 10-minute rollup table,
  not a longer raw retention. This stage does not add that table.

### D4 - Reliable OOM detection via Docker events, recorded by the single status reconciler

The current crashed branch is insufficient because `unless-stopped` auto-restarts the container
before the 15-second reconciler can observe `State.OOMKilled`. Add a runner-side Docker event
watcher, but keep **one process writer**: the existing status reconciler.

Runner side:

- `DockerClient.streamEvents(filter, signal)` uses the existing line-oriented `DockerTransport.stream`
  on `GET /events?filters=<encoded JSON>` (Docker events are newline-delimited JSON). The request
  sets an explicit long/disabled idle timeout (the transport's default is an idle timeout), treats
  close/timeout as a normal reconnect, and encodes the filter JSON.
- The `oom` event's `Actor.Attributes["hanse.app.id"]` carries the app label; a fallback
  `inspectContainer` is used only when the attribute is absent, so a container removed immediately
  after the OOM can still be attributed.
- `ContainerEventTracker` keeps a bounded ring of recent `{ appId, at }` OOM events (last 256
  events or 10 minutes), reconnects with capped backoff, and **filters** the ring by `since`
  (exclusive) without draining it. It is constructed from a narrow `DockerEventStream` capability;
  `DockerRuntime.streamEvents?` is optional, and an absent capability disables the tracker while
  the crashed branch remains the fallback. The tracker is injected into `RunnerService` as a
  constructor option so the status handler can read it. A Docker daemon restart (not just runner
  downtime) loses the ring's events; this is the documented best-effort boundary.
- The per-app status handler attaches `oomEvents` for that app since the requested `since` (default:
  last 10 minutes). The tracker is started in `runRunner` and stopped synchronously (abort signal +
  cleared reconnect timer) on shutdown. Events during runner downtime are best-effort lost.

Coordinator side:

- `#reconcileOne` already calls `runtime.status(appId)` under the per-app lock every 15 seconds. It
  passes a per-app in-memory watermark `#lastOomAt` (undefined on a fresh coordinator) and receives
  `status.oomEvents`. After a successful status response, `nextOomAt = max(at)` is computed. The
  watermark is advanced on **every** response that carries `oomEvents`, in every branch, before any
  early return, but never past an event that was not durably handled:
  - in the live branch, `#recordOomEvents` returns the highest `at` it handled (inserted, deduped,
    or rate-limited). The watermark advances to that value. If an insert fails, processing stops at
    that event and the watermark stays before it, so the next tick retries the failed and later
    events; dedupe and the rate limit make the retry idempotent;
  - in the error/stopped branches, the watermark advances to `nextOomAt` **after** the terminal
    transition/write completes and before the return. If the transition throws, the watermark is
    left unchanged and the tick retries;
  - the already-error tail (`persisted error` + `status error`, which has no terminal branch)
    advances `nextOomAt` once at the end of `#reconcileOne` if no branch advanced it.
  Rate-limited events count as handled and are an intentional drop, not a late insert.
- `#recordOomEvents(appId, status, events)` is called at the **top of the `live` block** of
  `#reconcileOne` (`status.state === "running" || "starting"`), **before** the
  `persisted.state` sub-branches and their early `return`s. When `status.state === "error"`, the
  crashed/startup branch owns the OOM and no history-only row is written. This is the exact
  call-site gate: one kill cannot produce both a history-only row and a crash error row.
- For every returned event in the live branch (processed in ascending `at`; each event is isolated
  in its own try/catch; a failed insert is logged and stops the watermark at that event, and later
  events are retried next tick):
  - append a **history-only** event with the current state/phase, `source: "runtime"`,
    `reason`/`errorCode` `oom_killed`, a neutral message, and `createdAt` = the Docker event time;
  - if the event predates the current attempt start, use the bounded synthetic attempt id
    `oom:<at>` and `seq = 1` instead of misattributing it to the new attempt (`at` is a 24-char ISO
    timestamp; the id is 28 chars and unique per app because the unique index is
    `(app_id, attempt_id, seq)`). It is **not** clamped to the attempt start;
  - deduplicate against **any** `agent_run_events` row for the app with `reason='oom_killed'`
    whose `created_at` is within ±60 seconds of `at` (exact `created_at = at` is included). This
    recognizes a history row and the crashed-branch row, whose `created_at` is the coordinator
    transition time (normally ≤15 seconds after `at`; a blocked reconciler can delay it further,
    and the window is anchored to the row, so a second kill can be coalesced up to ~75 seconds
    after the first). It survives replay, backoff, and a coordinator restart;
  - rate-limit **all** history-only OOM rows, including replayed/synthetic ones, to one per 60
    seconds per app to prevent a crash loop from consuming the 1,000-event budget. Update the
    per-app rate-limit timestamp only after a successful insert. The state resets on a coordinator
    restart; the ±60s dedupe still prevents duplicates. A rate-limited event is a handled drop and
    does not block the watermark.
- The history-only append reuses the store insert, per-attempt `seq` allocation, retention, and
  pruning through a private `#appendProcessEvent` helper rather than updating `instances`. It does
  **not** emit on the process SSE bus: an artificial attempt id must never reach
  `useAgentProcess`, which would treat it as a new attempt and reset `startedAt`. The page's
  `lastEventId` poll is the live-history path (see §9.2), and the `lastEventId` snapshot still
  advances because it is `MAX(agent_run_events.id)`.
- Because the reconciler is the only writer, the sampler has no manager dependency and cannot race
  the crashed branch. If the status is live after an auto-restart, the reconciler appends the
  history-only event; if the status is error, the crash/startup branch writes the error transition
  with `errorCode: "oom_killed"`. One OOM kill produces one OOM row; the existing `external_restart`
  transition may still be recorded separately, as it is today.
- In the non-live `persisted.state === "starting"` branch (the app was launching when it was
  OOM-killed and did not restart), if `status.oomKilled === true` or a matching OOM event is
  present, write the terminal transition as `state: "error"`, `phase: "failed"`,
  `reason: "oom_killed"`, `errorCode: "oom_killed"`, and the strong message instead of the generic
  `stale_start`/`interrupted` label. "Matching" means `status.oomKilled === true`, or an event
  whose `at` falls within the current attempt's `[startedAt, now]` (`readProcess` exposes
  `startedAt` from `process_started_at`; or within ±60 seconds of the terminal write when the
  attempt start is unavailable). Do not also append a history-only row for that event.
- `created_at` deliberately mixes two clocks: OOM history rows use the Docker daemon event time,
  while normal transitions use the coordinator time. The difference is bounded by the 15-second
  status cadence and is documented for `timeAgo` and the memory-event window query.

When the container does **not** auto-restart, the existing crashed branch sets
`errorCode: "oom_killed"` and the current state becomes `error`, so the runtime panel and chat show
the OOM as well. When it does auto-restart, the current state stays `running`, but the history and
the Memory card carry the OOM marker; this is the correct semantic ("OOM-killed, then restarted"),
not an error state.

### D5 - Setting semantics: hierarchical, inherited, not clearable

`runtime.memory_mb` is a scalar integer with `merge: "replace"` and `clearable: false`. The
application runs with the narrowest set value; `inherit` deletes the row at the current scope so the
wider scope or the default applies. There is no "cleared" memory meaning: a null tombstone would
only force the launcher to invent a fallback while the UI said "Cleared". This matches the existing
numeric `context.auto_compact.percent` key.

Default resolution is environment-derived. No existing settings key has a non-constant default, so
the definition contract is extended from a static `defaultValue: T` to
`defaultValue: T | (() => T)`, with one helper used by all three resolver clone sites. The resolver
calls the function per resolve, so a coordinator restart with a different `HANSE_APP_MEMORY_MB`
changes the default, the settings hash, and the launch fingerprint. This preserves the current env
behaviour instead of freezing it at module load.

The env value is normalized to an integer in `128..65536`; a non-finite, fractional, or
out-of-range value falls back to 2048 with a one-time warning. This is a deliberate safety change:
a value below 128 MB is not a viable agent container, and a fractional value cannot be expressed by
the settings schema.

`runtime.memory_mb` is **human-only**: `runtime.` is added to `HUMAN_ONLY_SETTING_PREFIXES`. Memory
is a containment control, and the master agent must not be able to raise its own cap. The setting
is still global/project/application scoped for the operator.

### D6 - UI placement: full-width card above the accordion

An independent visual-engineering review compared a fifth `AppGroup`, a card between the state strip
and the accordion, and a third state-strip cell. The recommendation, accepted here, is the card:

- It keeps the fixed four-group accordion (Git, Image, SSH access, Danger zone) and its order
  unchanged; only the page-archetype sentence is amended.
- It gives the chart the full content width; a strip cell or a half-width panel cannot render 48-144
  buckets legibly.
- It surfaces an OOM badge above the fold; a fifth group at the bottom of the page would hide it.
- It keeps monitoring separate from management; memory is cross-cutting health data, not a CRUD
  area.

The card is not collapsible on desktop: a memory incident should not be behind a click. On viewports
below 768 px the chart body is collapsed behind a `Show chart` disclosure by default; the summary
and an OOM badge remain visible. The summary is a four-cell `.watch-strip` (Current, Peak, Average,
Limit), not nested cards. The edit affordance is a foot link to the settings row; the card does not
contain an editable number input and does not duplicate the Settings strip's restart-pending
statement.

### D7 - Chart is hand-rolled SVG, no dependency

The UI has no chart library and `DESIGN.md` requires new visual patterns to be documented first. Use
one inline SVG with HTML axis labels outside the SVG, a min-max band, a working-set average line, a
dashed limit line, OOM markers as HTML buttons over the plot, and a `<details>` data table as the
accessible path. No new colors, spacing, radii, or motion tokens are introduced; the chart's
geometry literals are named in the DESIGN.md amendment.

## 5. Data model (migration v29)

Append `version: 29` to `MIGRATIONS` with defaults (`backwardCompatible: true`,
`requiresExclusive: false`):

```sql
CREATE TABLE app_memory_samples (
  app_id TEXT NOT NULL REFERENCES apps(id) ON DELETE CASCADE,
  sampled_at TEXT NOT NULL CHECK (
    sampled_at GLOB
      '[0-9][0-9][0-9][0-9]-[0-9][0-9]-[0-9][0-9]T[0-9][0-9]:[0-9][0-9]:[0-9][0-9].[0-9][0-9][0-9]Z'
  ),
  usage_bytes INTEGER NOT NULL CHECK (usage_bytes >= 0),
  working_set_bytes INTEGER NOT NULL CHECK (working_set_bytes >= 0),
  limit_bytes INTEGER NOT NULL CHECK (limit_bytes > 0),
  anon_bytes INTEGER CHECK (anon_bytes IS NULL OR anon_bytes >= 0),
  file_bytes INTEGER CHECK (file_bytes IS NULL OR file_bytes >= 0),
  PRIMARY KEY (app_id, sampled_at)
);
CREATE INDEX app_memory_samples_sampled_at ON app_memory_samples(sampled_at);
```

- The coordinator assigns **one `sampled_at` per batch tick**, not the runner. Composite primary key
  `(app_id, sampled_at)` plus `ON CONFLICT(app_id, sampled_at) DO NOTHING` makes a replayed batch
  idempotent. `INSERT OR IGNORE` is not used because it would also hide CHECK/FK failures.
- Rows are inserted with `WHERE EXISTS (SELECT 1 FROM apps WHERE id = ?)` per app (or an equivalent
  filtered batch), so a container for an app deleted between listing and insert is skipped rather
  than aborting the transaction. Unknown app ids are counted and logged at most once.
- ISO timestamps match the repository convention and sort lexicographically. Bucket grouping uses
  `CAST(strftime('%s', sampled_at) AS INTEGER) / CAST(@bucketSeconds AS INTEGER)`; the explicit
  `CAST` is required because better-sqlite3 binds every JS number as REAL (verified), and REAL
  division would create one bucket per sample.
- `ON DELETE CASCADE` removes history with the app. No extra deletion code is required.
- Index `(app_id, sampled_at)` is the primary range/group path; the `sampled_at` index serves the
  hourly prune. The extra index is a deliberate trade-off: predictable prune time at a small write
  cost.

Retention constants in the store module:

```ts
export const MEMORY_SAMPLE_INTERVAL_MS = 30_000;
export const MEMORY_SAMPLE_RETENTION_MS = 72 * 60 * 60 * 1_000;
const MEMORY_SAMPLE_PRUNE_BATCH = 500;
```

Store API: `insertMemorySamples(db, samples, sampledAt)`,
`readMemoryBuckets(db, appId, from, to, bucketSeconds)`,
`readMemorySummary(db, appId, from, to)`, `readLatestMemorySample(db, appId, to)`,
`pruneMemorySamples(db, now)`.

## 6. Runner API (additive, version 3)

### 6.1 Contract

`src/agent/protocol.ts`:

```ts
export interface RuntimeAppMemoryStat {
  appId: string;
  usageBytes: number;
  workingSetBytes: number;
  limitBytes: number;
  anonBytes: number | null;
  fileBytes: number | null;
}

export interface RuntimeOomEvent {
  appId: string;
  at: string;
}

export interface RuntimeAppStats {
  apps: RuntimeAppMemoryStat[];
}
```

`RuntimeAppStatus` (in the same file) gains `oomEvents?: RuntimeOomEvent[]`.
`AgentRuntimeClient` gains `appStats?(): Promise<RuntimeAppStats>` and an optional
`status(appId, options?: { since?: string })` parameter. `appStats` is optional so existing fakes
and the legacy supervisor path need no implementation. `HttpAgentRuntimeClient` implements
`GET /v1/app-stats` and appends `?since=<ISO>` to the existing status call. The sampler treats an
absent method or a `404`/transport error as "metrics unavailable" and retries with backoff; it never
disables permanently. The status reconciler ignores a missing `oomEvents` field (old runner).

### 6.2 Docker wrapper

`DockerClient.containerStats(id)` calls:

```
GET /containers/<id>/stats?stream=false&one-shot=true
```

with a 5-second timeout, and parses:

- `memory_stats.usage` -> `usageBytes`
- `memory_stats.limit` -> `limitBytes`
- `memory_stats.stats.inactive_file` (v2) or `memory_stats.stats.total_inactive_file` (v1) ->
  `workingSetBytes = max(0, usage - inactive)`
- `memory_stats.stats.anon`, `memory_stats.stats.file` -> optional breakdown

Values must be safe non-negative integers; an invalid payload is omitted for that container. Add an
optional `containerStats?(id)` to the `DockerRuntime` interface, matching the existing optional
capability methods (`inspectImage?`, `systemDf?`), so test fakes stay valid without a new method.

`DockerClient.streamEvents(filter, signal)` uses the existing line-oriented transport on
`GET /events?filters=...`. The runner's `ContainerEventTracker` subscribes to container `oom`
events and keeps a bounded ring; the ring is filtered by `since` on each per-app status request and
is never drained.

### 6.3 Batch handler

`GET /v1/app-stats`:

1. `listContainers("hanse.managed=true")`;
2. filter `State === "running"` and a non-empty `Labels["hanse.app.id"]`;
3. deduplicate by app id, newest `Created` wins;
4. call `containerStats` with a concurrency cap of 4, a 5-second per-call timeout, and a 15-second
   batch deadline;
5. use `Promise.allSettled`, omit rejected containers, and log a single structured warning with the
   count;
6. return `{ apps }` sorted by `appId`.

The existing `GET /v1/apps/:appId` status handler attaches `oomEvents` from the tracker for that app
**in the HTTP handler, not inside `RunnerService.status()`**, so `POST /v1/reconcile` and the
`ensure`/`delete` responses do not grow with event payloads. The optional `since` query is
URL-encoded and validated; an invalid value is treated as absent (the default is the last 10
minutes). The endpoint requires the runtime bearer token like every other runner endpoint except
`/healthz`. No app path is accepted for the batch stats endpoint, so there is no per-app
authorization question; the status endpoint retains its existing app-id validation.

## 7. Coordinator sampler

New `src/opencode/memory-sampler.ts`:

```ts
export class AppMemorySampler {
  constructor(options: {
    db: SqliteDatabase;
    runtime: AgentRuntimeClient;
    logger: Logger;
    intervalMs?: number;   // default 30_000
  });
  start(): void;
  stop(): Promise<void>;
  runOnce(): Promise<void>;
}
```

- `start()` schedules `setInterval`, calls `timer.unref?.()`, and runs one immediate `runOnce()`.
- `runOnce()` is single-flight. It records the batch timestamp `sampledAt = new Date().toISOString()`
  once, calls `runtime.appStats()`, and inserts every returned row in one SQLite transaction with
  the same `sampledAt`.
- It does not touch process state or OOM events; those belong to the status reconciler (D4).
- It prunes when at least one hour has passed since the last prune.
- On failure, it logs on state transition (not every tick), applies capped exponential backoff
  (30 s -> 5 min), and re-enables on the first success. A `404` is treated like a transport failure,
  not a permanent disable.
- `stop()` sets a stopped flag, awaits the in-flight `runOnce()`, and clears the timer. The shutdown
  path awaits it before `db.close()`.
- It is constructed in `src/cli/commands.ts` with the existing `db`, `runtime`, and `logger`,
  started next to `manager.startStatusReconciler()` (`commands.ts:1062`), and stopped in the
  `stopBackground` shutdown block (`commands.ts:1183-1193`) before the database closes.
- It runs even when no browser is open, so history exists when an incident is investigated. It does
  not run during database migration because the HTTP server and samplers start after the database is
  open and migrated.

## 8. Metrics HTTP API

`GET /api/apps/:app/memory?project=<projectId>&window=24h&bucket=30m`

- Human-only (operator cookie or bearer), `?project` required, same 400/404/409 semantics as
  `/api/apps/:app/process`, `Cache-Control: no-store`.
- `window`: `6h`, `24h` (default), `72h`.
- `bucket`: `10m`, `30m` (default `30m`). `10m` with `72h` is rejected with `400` to keep the
  response at most 144 full buckets plus a partial current bucket; invalid values are `400`.
- `from` is aligned down to a bucket boundary; `to` is now. The current bucket may be partial; the
  response documents that the last bucket covers less than `bucketSeconds`.
- Response:

```ts
interface AppMemoryResponse {
  appId: string;
  window: { from: string; to: string; bucketSeconds: number };
  summary: {
    currentBytes: number | null;
    minBytes: number | null;
    peakBytes: number | null;
    averageBytes: number | null;
    limitBytes: number | null;
    samples: number;
    lastSampleAt: string | null;
  };
  buckets: Array<{
    start: string;
    minBytes: number;
    maxBytes: number;
    averageBytes: number;
    samples: number;
  }>;
  events: Array<{ at: string; kind: "oom_killed"; message: string | null }>;
}
```

- `summary.currentBytes` and `summary.limitBytes` are taken from the latest sample **inside the
  window**; `summary.lastSampleAt` is the latest sample overall (for the "last sample" caption). If
  the window has no samples, current/limit are `null` even when older samples exist. `minBytes`,
  `peakBytes`, and `averageBytes` are over the window samples. Per-bucket `minBytes`/`maxBytes` are
  the bucket extrema.
- Buckets with no samples are omitted, not returned as zero. The client derives gaps from
  `start`/`bucketSeconds`; a stopped agent is a gap.
- `events` are read from `agent_run_events` where `app_id = ?`, `created_at` is in the window, and
  `reason = 'oom_killed' OR error_code = 'oom_killed'`. This covers old rows (reason only) and new
  rows (both).
- Aggregation SQL:

```sql
SELECT CAST(strftime('%s', sampled_at) AS INTEGER) / CAST(@bucketSeconds AS INTEGER) AS bucket_epoch,
       MIN(working_set_bytes) AS min_bytes,
       MAX(working_set_bytes) AS max_bytes,
       CAST(AVG(working_set_bytes) AS INTEGER) AS average_bytes,
       COUNT(*) AS samples
FROM app_memory_samples
WHERE app_id = @appId AND sampled_at >= @from AND sampled_at < @to
GROUP BY bucket_epoch
ORDER BY bucket_epoch
```

- `readLatestMemorySample(db, appId, to)` is bounded by `to` and uses the `(app_id, sampled_at)`
  primary key.
- The route lives in `src/http/memory.ts` (modeled on `src/http/process.ts`) and is dispatched before
  the `/api/apps/` chat catch-all in `src/http/server.ts`.

## 9. OOM-killed process event

### 9.1 Write side

`src/opencode/process-errors.ts`:

- add `"oom_killed"` to `ProcessErrorCode`;
- add it to `KNOWN_CODES`;
- add a generic message: `The agent was killed after exceeding its memory limit.`

`src/opencode/manager.ts:2976-2993` crashed branch:

```ts
errorCode: status.oomKilled === true ? "oom_killed" : "runtime_unavailable",
message:
  status.oomKilled === true
    ? "The agent was killed after exceeding its memory limit."
    : (status.error ?? "The agent process exited unexpectedly."),
```

Keep `state: "error"`, `phase: "failed"`, `reason: "oom_killed"`. No migration, no new enum, no new
event kind.

New private `InstanceManager.#recordOomEvents(appId, status, events)` (D4) appends history-only
events for an auto-restarted container. It is called at the top of the live status branch and uses a
new private `#appendProcessEvent` helper that shares seq allocation, insert, and pruning with
`#transitionProcess` but does not update `instances` and does **not** emit on the process SSE bus.
It requires a current process row in `running` or `starting` and a valid current state/phase pair;
otherwise it is a no-op. It deduplicates against any `reason='oom_killed'` row for the app whose
`created_at` is within ±60 seconds of `at` (which covers both a previous history row and the
crashed-branch row), uses the bounded synthetic `oom:<at>` attempt when the event predates the
current attempt, and rate-limits all history-only OOM rows to one per 60 seconds per app after a
successful insert. Events are processed in ascending `at`; each is isolated in its own try/catch. A
failed insert stops the returned watermark at that event so the next tick retries it (dedupe and
the rate limit make the retry idempotent). The `#lastOomAt` and rate-limit maps are per app and
bounded by the app count. The history-only message is neutral ("A process in the container exceeded
the memory limit; the container is still running."); the crashed/startup branch keeps the strong
"The agent was killed after exceeding its memory limit." message. A non-live `persisted starting` +
`status error` path with `oomKilled` records the terminal `error`/`failed`/`oom_killed` transition
instead of `interrupted`.

### 9.2 Read and UI side

- `processPill(state, phase, errorCode?, reason?)` in `ui/status.ts` returns an "Out of memory"
  pill when `errorCode === "oom_killed"` or `reason === "oom_killed"` before the phase/state
  fallback.
- `AppStateStrip.vue` current pill uses `processPill(runtimeState, processPhase,
  processError?.code, null)`; history rows use `processPill(event.state, event.phase,
  event.errorCode, event.reason)`. The error body uses a code-specific message and a new
  `errorTitle` computed value ("Agent ran out of memory" for OOM, otherwise absent).
- `ChatThread.vue` passes `props.processError?.code` to `processPillSpec`; the title is
  "Agent ran out of memory" for `oom_killed`, otherwise "Agent failed to start".
- `OverviewProcessRowProps` gains `errorCode: string | null` from `process.error?.code ?? null`, and
  the overview passes it to `processPill`. Old rows without a code keep "Failed".
- The metrics chart markers use the same `agent_run_events` rows, so the badge and the graph cannot
  disagree. Old rows with `reason='oom_killed'` but `error_code='runtime_unavailable'` show a marker
  and a history OOM pill; their current snapshot may still show "Failed" because the snapshot does
  not carry `reason`. This is documented and acceptable for pre-change rows.
- **Live history:** `AppPage`'s existing 10-second runtime poll compares `process.lastEventId`. When
  it increases and the history has already loaded, the page refetches only the first `/process` page
  (`limit=50`) and merges it into `historyEvents`: union by `id`, sort by `id` descending, dedupe by
  `id`. It **keeps the existing `historyCursor`** (the oldest loaded id) unchanged; only the initial
  load and "Load older" update the cursor. It ignores the merge while `historyLoading` is true so an
  in-flight initial/older load cannot be overwritten. `historyLoaded` stays true after the first
  load, so a closed-then-reopened disclosure does not re-run the initial load; a disclosure that was
  never opened loads normally on its first open. This makes a history-only OOM row appear without a
  page reload and also fixes the existing stale-history gap. No new SSE subscription is required.

## 10. Settings

### 10.1 Key and resolution

- Key: `runtime.memory_mb`.
- Type: integer MB, `128..65536`; `merge: "replace"`; `clearable: false`.
- Effective shape: `runtime: { memoryMb: EffectiveValue<number> }`.
- Add `"runtime.memory_mb"` to `SettingsKey` for a complete inventory, even though the union is
  currently unused by consumers.
- Registry definition uses the dynamic default hook (D5): the default is
  `defaultAppMemoryMb(process.env)` from a shared resource-limits module.
- `resolve()` adds `runtime.memoryMb`; `launchEffectiveSettings()` includes `runtime` (the
  `Omit<EffectiveSettings, "context" | "notifications">` return type forces this).
- `settingsHashFor()` therefore changes when the effective memory changes, and `pendingRestart`
  reports `settings_changed`.
- `launchFingerprint()` already hashes `LaunchSnapshot.resources`; the resource override changes it
  independently.
- **One-time upgrade effect:** adding the `runtime` group to `launchEffectiveSettings` changes every
  persisted `applied_settings_hash`, so after the upgrade every running app reports "restart
  required" once, even at the default 2048. This is expected and documented; no silent restart and
  no hash backfill.

### 10.2 Launch resources

Create `src/config/app-resources.ts` (name may be adjusted to the existing config convention) with:

```ts
export const DEFAULT_APP_MEMORY_MB = 2048;
export const DEFAULT_APP_CPUS = 2;
export const DEFAULT_APP_PIDS = 512;
export function positiveNumber(raw: string | undefined, fallback: number): number;
export function defaultAppMemoryMb(env: NodeJS.ProcessEnv = process.env): number;
```

`defaultAppMemoryMb` returns an integer in `128..65536`; a non-finite, fractional, or out-of-range
env value falls back to 2048 with a one-time warning. `src/opencode/manager.ts` imports these
defaults instead of owning them. `resolveRuntimeResources` gains an optional memory override:

```ts
export function resolveRuntimeResources(
  env: NodeJS.ProcessEnv = process.env,
  memoryMb?: number,
): { memoryBytes: number; nanoCpus: number; pidsLimit: number };
```

When `memoryMb` is `undefined`, `resolveRuntimeResources` uses `defaultAppMemoryMb(env)` as its
fallback, so the settings path and the no-settings path (tests, partial wiring, legacy callers)
agree on normalization. `#captureLaunch` passes `effective?.runtime.memoryMb.value ?? undefined` at
`manager.ts:1681`. CPU and PIDs remain `HANSE_APP_CPUS`/`HANSE_APP_PIDS`.

The runner's `HANSE_APP_MEMORY_MAX_MB` remains the optional hard operational ceiling when
configured. This stage does **not** introduce a new default: a deployment that already raised
`HANSE_APP_MEMORY_MB` above any new default must not be rejected after upgrade. `compose.yaml`
continues to forward it empty (no ceiling), and `docs/deployment.md` documents that production
should set it deliberately. The settings schema caps the value at 65536 MB, matching the UI maximum;
a deployment whose runner max is lower rejects the launch with the runner's `400 resource_limit`.
The launch error currently surfaces as `runtime_unavailable` with the runner message; the design
documents that text, and the plan may add `resource_limit` to known codes if the error presentation
needs a stable label. The settings row's hint states that a configured runner maximum is the hard
ceiling.

`HANSE_APP_MEMORY_MB` is added explicitly to the coordinator service environment in `compose.yaml`
and to `.env.example` with the default `2048`, so the env default is no longer an undocumented
Compose-override-only value.

### 10.3 Settings UI and tools

- Add a numeric row to the existing **Agent** settings pane (model + memory limit), with title
  `Memory limit`, hint `Container memory cap for this application, in MB (1 MB = 1024 x 1024
  bytes).`, and the existing number control.
- Placeholder at global scope: `Default: <env value> MB`; at project/app:
  `Inherited: <effective value> MB`.
- `clearable: false`, so the only reset action is `Use inherited`; the server `inheritAction`
  already explains "Already inherited from ..." / "Already uses the default."
- Update `RESTART_AFFECTING_KEYS`, `REGISTRY_KEYS` (13 -> 14), `registryRows`, the server/client
  `SettingsProps.rows` mirrors, and `SettingsRowKind`. Update the "13 keys" comments in
  `ui/settings-view.ts` and `docs/design/settings-console.md`.
- Update the master agent's hardcoded `effectiveValue` map in `src/master/tools.ts:469-489` so
  `get_settings` can format the new key. Because `runtime.` is added to
  `HUMAN_ONLY_SETTING_PREFIXES`, the master can read but not set/inherit the key; the existing
  human-only error path applies.
- Form-encoded `POST /api/settings` converts numeric strings only for the context keys today. Add
  `runtime.memory_mb` to that conversion (or generalize a numeric-key set) so `application/
  x-www-form-urlencoded` writes behave like the JSON UI.
- Validation errors use the existing `invalid value for "runtime.memory_mb"` shape; a value outside
  the range is a `400`, never a silent clamp. The env-derived default is normalized separately in
  `defaultAppMemoryMb`.

## 11. UI - Memory card

### 11.1 Placement and anatomy

Insert `AppMemoryPanel` after every `<AppStateStrip>` in `AppPage.vue` (managed and master branches),
before the first `AppGroup`:

```
AppStateStrip
AppMemoryPanel      // full-width card, not an accordion
AppGroup git
AppGroup image
AppGroup ssh
AppGroup danger
```

```
┌ MEMORY ───────────────────────── last 24 h     [6h│24h│72h] ────┐
│ CURRENT        PEAK          AVERAGE        LIMIT              │
│ 412 MiB        1.84 GiB      486 MiB        2 GiB               │
│ ┌ chart-ground ──────────────────────────────────────────────┐ │
│ │ 2 GiB ┄┄┄┄┄┄┄┄┄┄┄┄┄┄┄┄┄┄┄┄┄┄┄┄┄┄┄┄┄┄┄┄┄┄ Limit      │ │
│ │        ░░░░░░ min–max band ░░░░░░                         │ │
│ │  ─────── working set (bucket avg) ────────────────● now    │ │
│ │ 0      06:00        12:00        18:00                    │ │
│ │              ▲ OOM 13:42                                  │ │
│ └────────────────────────────────────────────────────────────┘ │
│ legend  ▰ min–max   ─ avg   ┄ limit   ▲ OOM     Bucket [30m ▾]  │
│ Last sample 12s ago                     [Edit memory limit →]   │
└─────────────────────────────────────────────────────────────────┘
```

- New `ui/components/AppMemoryPanel.vue` for the card, summary, controls, states, and edit link.
- New `ui/memory-chart.ts` for pure geometry/formatting helpers (`scaleY`, `linePath`, `bandPath`,
  `nearestBucket`, `formatBytes`, `chartDescription`), unit-tested without a chart library.
- Optional `ui/composables/useAppMemory.ts` for the query: `refetchInterval: 60_000`, refetch on
  window focus, keep previous data during refetch.
- Do not split a separate `MemoryChart.vue` until the panel is reused on another page.

### 11.2 Chart encoding

| Element | Encoding | Token | Non-color cue |
| --- | --- | --- | --- |
| Working set line | 2px solid, per-bucket average | `--text-1` | Solid stroke + legend |
| Min-max band | Filled band between bucket min/max, 1px edges | `--wash-2` fill, `--line` edges | Shaded shape + legend |
| Limit line | 1px dashed horizontal rule, right-edge label `Limit 2 GiB` | `--text-2` | Dashed + text label; not `--danger` at rest |
| OOM marker | Triangle above the plot, vertical tick, count if >1 in a bucket | `--danger` | Triangle glyph + `OOM` label + head badge |
| Current point | 3px dot, surface ring, `now` label | `--text-1`, `--surface-1` | Text label + readout |
| Missing bucket | Line and band break | `--wash-1`, `--line` | Explicit "no samples"; never zero |
| Axes | HTML labels outside the SVG | `--text-3`, caption type | Real text at every width |

No brass: brass remains the single action/nav/focus accent. Do not put `<text>` inside the scaled
SVG; render axis labels as HTML. Use `vector-effect="non-scaling-stroke"` or a measured pixel
viewBox. OOM markers and the current point are HTML buttons positioned over the plot so they remain
crisp, focusable, and 44px-tappable.

### 11.3 Summary, controls, edit link

- Four-cell `.watch-strip` (not nested cards): Current, Peak (with time), Average, Limit.
- Limit is the **actual container limit** from the latest sample in the window; when there are no
  samples, the cell is `—`. The card does not show the configured scope/source; the settings page
  owns that. There is no "unlimited" state for managed app containers.
- Range `.segmented`: `6 h | 24 h | 72 h`, default 24 h.
- Bucket `.select`: `Auto | 10 min | 30 min`, default Auto. Auto = 10 min for 6 h, 30 min for 24 h
  and 72 h. Disable 10 min at 72 h and below 768 px with a visible reason; keep the point count
  ≤144 full buckets plus a partial current bucket.
- Persist the selection in the URL query (`mem=24h:30m`) so an incident view is shareable and
  survives reload.
- `Edit memory limit` ghost link in the card foot goes to
  `/projects/<project>/apps/<app>/settings#memory-limit`. The settings row owns editing; the card
  never duplicates the restart-pending statement.

### 11.4 States and responsive behaviour

- Loading: skeleton summary and chart; `aria-busy="true"`; no fake line.
- Empty/never sampled: Limit `—`; "No memory samples yet. Samples appear after this agent starts."
- No data in the selected range: `No samples in the last 6 hours` + a wider-range action.
- Stopped: Current `—`; historical chart remains; caption `Agent stopped · last sample 14:02`; never
  zero.
- Error: inline error with `role="alert"` and Retry; if stale data exists, show it with
  `Showing data from 13:40 · refresh failed`.
- OOM in range: head pill `1 OOM`, chart marker, no implication that the OOM is still active.
  OOM history rows (and therefore chart markers) are coalesced to at most one per 60 seconds per
  app; the card caption states that a crash loop may show one marker per minute rather than every
  kill.
- ≥1024 px: one-row head, 4-up summary, 160-176px chart, four x ticks.
- 768-1023 px: head wraps, 2×2 summary, 150px chart, three ticks.
- <768 px: 2×2 summary, chart body collapsed behind a `Show chart` disclosure (summary and OOM badge
  stay visible); when expanded, 128px chart, two ticks, 10-minute bucket disabled, controls wrap,
  44px targets.
- <480 px: same summary; OOM markers keep 44px invisible hit areas; no horizontal chart scroll.

### 11.5 Accessibility

- `<section aria-labelledby="memory-title">` with `h2` "Memory".
- Range/bucket controls: `role="group"` + `aria-label`, buttons with `aria-pressed` (no invented tab
  roles); disabled 10-minute option has a visible and `aria-describedby` reason.
- SVG `role="img"` with `<title>`/`<desc>` summary; the SVG is not a tab stop.
- OOM markers are `<button aria-label="OOM at 13:42">`; focus/tap updates a persistent readout;
  readout is `role="status"` polite and does not announce every poll.
- A `<details>` data table (bucket start, min, average, max, OOM count) is the canonical accessible
  representation; no hover-only information.
- `prefers-reduced-motion`: static chart, no range crossfade.
- `forced-colors: active`: chart ground is hidden by existing CSS; strokes follow system colors and
  OOM markers keep a text label.
- Focus uses the existing `--focus`; no new focus/hover tokens.

### 11.6 DESIGN.md and evidence amendments

- §4.4 item 8: insert the full-width Memory card between the state strip and the accordion; keep the
  accordion exactly four groups in the order Git, Image, SSH access, Danger zone.
- §5.6: the Memory card is a bounded resource panel; its metrics use `.watch-strip`, not nested
  cards.
- §5.20: document `.memory-panel`, `.memory-summary`, `.memory-chart`, `.memory-chart__plot`,
  `.memory-chart__axis`, `.memory-legend`, `.memory-toolbar`, `.memory-readout`, `.memory-oom`,
  `.memory-foot`, the encoding table, states, and responsive rules. Name the chart geometry literals
  (plot heights 160-176/150/128px, strokes 1/2/3px, 44px hit areas) in the same section, so the
  "no unnamed size" rule is satisfied.
- §8.1: replace "Charts/figures are out of scope for stage 1" with the chart contract: hand-rolled
  SVG only, no chart library, shape/style/text legend, HTML labels outside the SVG, OOM markers as
  glyphs, gaps not zeros, mandatory data table, reduced motion static, forced-colors mapping,
  `role="img"` + `<desc>`.
- §9: add the `.memory-*` classes to the Stage 2 class contract; they compose existing tokens only.
- §2.4: one clarifying line that the working-set series uses `--text-1`, never brass.
- §8.3 evidence: add the Memory card states (loading, empty, normal, OOM, error, 390/768/1440, dark
  and light) to the design showcase/capture harness, or explicitly defer the browser evidence to the
  plan's QA phase.

## 12. Security

- The metrics API is human-only and project-scoped; agent principals get `403`, a missing `project`
  is `400`, and a cross-project app key is `404` via the existing app resolution.
- The runner stats endpoint uses the internal runtime bearer; it is not exposed to the operator or
  the app container.
- Memory values are not secrets. No raw container logs, process environments, or file paths are
  stored or returned; the OOM message is fixed and sanitized by the existing process-error path.
- `runtime.memory_mb` is human-only (`HUMAN_ONLY_SETTING_PREFIXES`), so the master agent and app
  agents cannot raise memory caps. The settings rows remain global/project/application scoped for
  the operator.
- The runner max is optional and remains unset by default; production should set
  `HANSE_APP_MEMORY_MAX_MB` deliberately. The settings schema's 65536 MB cap and operator-only
  access bound what the UI can request; the runner rejects a configured max breach with
  `400 resource_limit`.

## 13. Alternatives considered

| Option | Why rejected / deferred |
| --- | --- |
| Per-app `GET /v1/apps/:id/stats` | N HTTP calls per 30 s and N app lookups; the batch endpoint is one request and Docker access stays in the runner. |
| Direct cgroup file reads | Requires resolving the Docker cgroup path per driver and handling v1/v2 differences; Docker stats already normalizes the fields. |
| 60-second sampling / 7-30 days retention | 60 s misses short render spikes; 30 days multiplies disk for a low-value feature. 30 s / 72 h matches the UI and stays small. |
| Pre-aggregated rollup tables | Adds a second write path and migration before the raw table is proven; on-read grouping is fast at 8.6k rows/app. |
| Store only working set | Raw usage is what the kernel enforces and explains cache-related "near limit" readings; the pair is cheap. |
| OOM from the status reconciler without Docker events | `unless-stopped` auto-restarts the container and resets `State.OOMKilled`; the reconciler usually sees `external_restart`. Rejected after the design review; Docker events are required. |
| Sampler writes OOM events into process history | Two writers race the reconciler, events are lost while the app is in restart/backoff, and dedupe spans two call paths. Revision 2 tried this and the review rejected it; revision 3 feeds the events into the single reconciler writer. |
| Set `restartPolicy: "no"` to observe OOM | Changes crash recovery behavior and requires owner sign-off; Docker events solve the problem without changing lifecycle semantics. |
| Fifth `AppGroup` | Breaks the fixed four-group layout and hides an OOM signal below the fold; changes "four" to "five" in the design contract. |
| Third state-strip cell | Breaks the two-cell strip and gives the chart half width; overloads the runtime cell. |
| New process phase `oom_killed` | Closed CHECK requires a table rebuild; an old UI throws on an unknown phase; `errorCode` already carries the semantic and is rollback-safe. |
| New event `kind` / separate OOM table | New column/table across store, SSE, pagination, pruning, and UI for information already in `reason`/`error_code`. Docker events feed the existing event table. |
| Memory setting in `.hanse/app.yaml` | The app directory is agent-writable; an agent could raise its own cap. Settings are operator-managed and already hierarchical. |
| Env-only per-app map | A new env var per app is unmanageable and not visible in the settings UI; it does not satisfy all-scope resolution. |
| Add a chart dependency | The repo has no chart library and the design contract forbids adopting new visual primitives ad hoc; the chart is small and hand-rollable. |
| Bump the runner API for the additive endpoint | The exact handshake would force a coupled deploy and break coordinator-only rollback; optional response fields and an optional endpoint with 404 backoff are safer. |
| New compose default for `HANSE_APP_MEMORY_MAX_MB` | A new ceiling can reject a documented existing `HANSE_APP_MEMORY_MB` override after upgrade. Leave the runner max unset by default and document that production should set it. |

## 14. Impact

| Area | Change |
| --- | --- |
| Migrations | v29 `app_memory_samples` + `sampled_at` index; additive, online-appliable. Rollback requires a pre-upgrade database backup. |
| Store | New memory-sample repository with insert/read/summary/prune and integer-division bucket SQL. |
| Runner | Docker `containerStats` and `streamEvents`, `ContainerEventTracker`, `GET /v1/app-stats`, and `oomEvents` on the per-app status; API version stays 3. |
| Coordinator | `AgentRuntimeClient.appStats?` and status `since`, `AppMemorySampler`, the reconciler's `#recordOomEvents` and the history-only event helper; startup/shutdown wiring. |
| HTTP | New human-only `GET /api/apps/:app/memory`; route dispatch before the app catch-all. |
| Settings | `runtime.memory_mb` key, dynamic default hook (three clone sites), env normalization, effective shape, launch resources override, settings hash, human-only prefix, UI row, master map, form conversion. |
| Process | `errorCode: "oom_killed"`, Docker-event-driven history-only OOM events, generic message, pill/title/history/overview labels; no migration. |
| UI | `AppMemoryPanel`, `memory-chart` helpers, `useAppMemory`, AppPage placement, mobile chart disclosure, design tokens/classes, accessibility and states. |
| Docs | `DESIGN.md` (+ showcase evidence), `docs/current-state.md`, `docs/deployment.md` (per-app setting, runner max, v29 forward-only, one-time restart marker), `README.md` sizing, `docs/design/settings-console.md` key count, design/plan/journal indexes. |
| Tests | Migration v29 and every hard-coded `28` expectation (`test/migrations.test.ts:57,480,557,766,913`, `docs/current-state.md:694`); sample store and integer bucket SQL (two samples in one 30-minute bucket); partial current bucket; Docker stats parsing; Docker event tracker (Actor.Attributes, reconnect, `since`); runner batch endpoint; status `oomEvents`; sampler stop/backoff/unknown-app/batch timestamp; settings (dynamic default normalization, all three clone sites, scopes, launch, hash, human-only, form, `EffectiveSettings` literals in `test/settings.test.ts:330-380` and `test/manager.test.ts:174-186`); OOM history-only event ±60s dedupe, bounded `oom:<at>` synthetic attempt with a 128-char app key, status-live-vs-error gate (exactly one row), crash-then-restart no-duplicate, startup-OOM label, per-event error isolation, rate-limit/watermark interaction, and one-writer crash path; OOM UI (strip current/history, chat, overview); live history merge by `lastEventId` including cursor preservation, in-flight-load guard, and the >50-event merge bound; metrics API validation/auth; chart geometry and panel states; E2E route. |

## 15. Non-goals

- Per-app CPU/PID limits or per-app runner maxima.
- Automatic restart or limit increase on OOM.
- Alerting, Telegram notifications for memory thresholds, or a fleet memory dashboard.
- History longer than 72 hours, or a rollup/retention tier.
- Per-process RSS attribution (opencode vs LSP vs Godot vs renders).
- A memory panel on the project page or overview in this stage.
- Changing the hard cgroup model, swap policy, or `OomScoreAdj`.
- Changing chat/turn semantics for OOM; the process history and labels change, not the conversation
  state machine.
- A new chat notice for an OOM that auto-restarted; the process history and Memory card carry that
  event. Chat shows OOM only when the process is in error.
- Persistent Docker event history across runner downtime; OOM events are best-effort for that gap.

## 16. Resolved owner decisions (2026-11-16)

1. **Per-app memory setting** - implement it; all scopes from global to application; the current
   environment value is the default.
2. **Metrics** - sampling, storage, and aggregation are delegated to the implementer, optimizing for
   low disk use and fast page open.
3. **OOM markers** - delegated; also make OOM-killed a distinct, obvious interruption event because
   the current cause is unclear.
4. **UI placement** - a card is acceptable; the owner is not opinionated and asked for an
   independent design opinion. Accepted: full-width card above the accordion.
5. **Delivery cycle** - design first, then design review, owner questions, plan, plan review, and
   implementation.

## 17. Open questions

None. The remaining choices (sampling interval, retention, bucket sizes, exact runner payload,
working-set semantics, OOM event transport, default normalization, human-only ownership, and UI
layout) are resolved above or delegated by the owner.

## 18. Review history

- 2026-11-16: revision 1 draft.
- 2026-11-16: `oracle` design review 1: **PASS WITH FIXES**. Blockers: (1) OOM is usually missed
  because app containers use `unless-stopped` and auto-restart; (2) the bucket SQL uses REAL
  division because better-sqlite3 binds JS numbers as REAL. Should-fixes: runner API bump/deploy
  trap, sampler shutdown race, false idempotency/`INSERT OR IGNORE`, permanent 404 disable,
  `stream=false` vs `one-shot`, summary/limit semantics, incomplete OOM UI wiring, dynamic default
  normalization/units/compose env, master-writable memory and unset runner max, one-time fleet-wide
  restart marker, migration rollback wording, and missing tests. Revision 2 folds all findings:
  Docker-event OOM tracking + history-only events, `CAST(... AS INTEGER)` bucket math, no API bump,
  async sampler stop, coordinator batch timestamp + `ON CONFLICT DO NOTHING`, backoff, `one-shot`
  stats, window-bounded summary/limit, explicit OOM UI edits, normalized env default, human-only
  setting, compose defaults, and expanded tests/docs.
- 2026-11-16: `oracle` design review 2: **PASS WITH FIXES** (2 blockers remain). Bucket math was
  confirmed fixed against better-sqlite3. Blockers: (1) the sampler processed OOM events only for
  apps in the running stats batch, dropping events in the restart/backoff window; (2) a compose
  default of 8192 for the runner max would reject documented existing `HANSE_APP_MEMORY_MB`
  overrides and mismatch the UI. Should-fixes: 5-second dedupe vs. replay window, two writers,
  stale process history, crash-loop flood, missing `streamEvents` capability, event-stream idle
  timeout/encoding, false OOM message for a surviving agent, non-settings resource default
  mismatch, M9 overclaim, per-event error isolation, ordering, and test/doc gaps. Revision 3 folds
  all of them: OOM events now ride the per-app status into the single reconciler writer; the sampler
  only writes samples; exact event identity + synthetic attempt + rate limit replace the proximity
  dedupe; the runner max stays unset; the stats stream uses `Actor.Attributes`, explicit idle
  timeout, and encoded filters; live history merges by `lastEventId`; and the message/test/doc
  details are corrected.
- 2026-11-16: `oracle` design review 3: **PASS WITH FIXES** (1 blocker, 5 should-fixes). The
  single-writer refactor and the rev-2 blockers were confirmed resolved. Remaining blocker: the
  synthetic attempt id `oom:<appId>:<at>` could exceed the 128-char `attempt_id` CHECK for a long
  but valid app key, silently losing the OOM row. Should-fixes: gate history-only recording on a
  live status so the crash case cannot double-record; preserve `historyCursor` on a live merge;
  define the watermark/rate-limit interaction and reword M9; keep history-only frames off the
  client's attempt/startedAt state; state the `defaultAppMemoryMb` fallback and attach `oomEvents`
  only in the HTTP status handler with an encoded/validated `since`. Revision 4 folds all of them:
  `oom:<at>` synthetic id, live-branch call site, no SSE emission for history-only rows, cursor-
  preserving live merge, watermark advance for every returned event, rate-limited history rows, and
  the handler/fallback details.
- 2026-11-16: `oracle` design review 4: **PASS WITH FIXES** (no blockers; 4 should-fixes).
  Confirmed `oom:<at>`, the live-branch gate, the no-SSE history rows, and the handler-only
  `oomEvents`. Remaining: crash-then-restart can still duplicate because the crashed row's
  `created_at` is the coordinator time; the watermark was tied to the live-only recorder; a startup
  OOM is labeled `interrupted`; the exact `#recordOomEvents` position inside the `live` block was
  unstated. Revision 5 folds all four plus the nits: ±60s OOM dedupe that recognizes the crashed
  row, watermark advanced on every status response, startup-OOM terminal label, the recorder at
  the top of the `live` block, per-event isolation, rate-limit timestamp after a successful insert,
  crash-loop undercount copy, merge-bound/clock notes, and the tracker injection/daemon-restart
  boundary.
- 2026-11-16: `oracle` design review 5: **PASS WITH FIXES** (no blockers; one must-fix). Confirmed
  the ±60s dedupe closes the crash-then-restart duplicate, `oom:<at>` is bounded, the startup
  `error/failed` pair is valid, the recorder position is safe, and a legitimate second OOM ≥60s
  after the recorded row is allowed. Remaining must-fix: the watermark advanced to `max(at)` even
  when a per-event insert was caught and logged, so the failed event was dropped while the design
  also claimed a retry. Nits: define the startup "matching OOM event", advance the error/stopped
  watermark after the terminal write, document the row-anchored ±60s window (~75s coalescing) and
  the delayed-reconciler assumption, and note the per-app map bounds. Revision 6 folds the
  must-fix and nits: `#recordOomEvents` returns the highest durably handled `at` (inserted, deduped,
  or rate-limited) and stops at a failed insert; the error/stopped watermark advances after the
  terminal write; the startup match and the window/map bounds are explicit.
- 2026-11-16: `oracle` design review 6 (final confirmation): **PASS**. No must-fix. Optional nits
  folded: advance `nextOomAt` once at the `#reconcileOne` tail for the already-error path, and name
  the field as `startedAt` (`process_started_at`) rather than `processStartedAt`. The design is
  approved; implementation is gated on the plan review.
