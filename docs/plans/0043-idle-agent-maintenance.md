# Plan 0043 - Idle agent maintenance

Status: **implemented and verified** - design `idle-agent-maintenance.md` revision 7 approved
(Oracle round 6 PASS WITH FIXES; security-engineer round 6 PASS WITH FIXES; clarifications folded);
plan `momus` round 3 OKAY (canonical `.omo/plans/` path; content unchanged); implemented and verified
(journal 0051).
Design: [`docs/design/idle-agent-maintenance.md`](../design/idle-agent-maintenance.md).
Owner decisions: [`docs/open-questions.md`](../open-questions.md) `0043-idle-agent-maintenance`
(2-day auto-stop; 3-hour auto-update only onto an already built/pulled image; agent work only, with
a pending interactive prompt active and a text-only question inactive; an active operator terminal
blocks both while demo previews may stop; pending configuration never applies silently; auto-pull
allowed; "Rebuild only" in chat; automatic rollback deferred; environment thresholds only).
Mode: **feature** - automatic idle lifecycle policy, runner image pull, and a chat rebuild-only
action.
Baseline: the zero-ssr stage commit (plan 0042) and the 0041 telegram stage commit (migration v26).
The working tree currently contains uncommitted zero-ssr and 0041 work; do not start Step 1 until
both are committed. Re-run the baseline gates on that commit.
Baseline gates: `npm run lint`, `npm run typecheck`, `npm run typecheck:ui`, `npm test`,
`npm run build`, `npm run check:ui`, `npm run check:sensitive`, `npm run test:e2e` (green on the
zero-ssr and 0041 commits).
Verification gates for this stage: the same full list, including `npm run check:ui` and
`npm run test:e2e` because the chat image banner changes.
Journal: `docs/journal/0051-idle-agent-maintenance.md`. Journal 0049 is zero-SSR and 0050 is
Telegram notifications, so this stage records as 0051.

## Goal

Add a durable per-app agent-activity clock and a maintenance scheduler that:

- stops a running agent after two days without agent work;
- restarts a running agent after three hours without agent work only when the image state is
  `restart_required`, the target image identity is pinned and unchanged, and the launch fingerprint
  is unchanged (never applying pending configuration);
- pulls the configured default agent image and shared base image on a schedule through the runner;
- offers "Rebuild only" in the chat image banner when a rebuild is required.

## Non-goals

- Automatic image rebuilds, automatic rollback, automatic application of pending
  settings/skills/model/provider/git/rule/instruction/plugin changes.
- Signature verification of pulled images, per-app maintenance overrides, a maintenance settings UI.
- Stopping the master agent, zero-downtime updates, or session/message retention changes.
- Changes to existing manual start/restart/stop, the image state vocabulary, chat/session/process
  contracts, the deployment lock, or the restart claim.

## Execution steps

Each step is independently reviewable and leaves the tree green. Apply the listed focused tests and
typecheck before moving on; revert the step on failure.

### Step 1 - Migration v27 and store plumbing

Files: `src/store/migrations.ts`, `src/store/index.ts`, `src/store/process.ts`,
`test/migrations.test.ts`, `test/migrate-cli.test.ts`, `test/commands.test.ts`, `test/store.test.ts`,
`test/settings-store.test.ts`, `test/skills-store.test.ts`, `test/deploy-http.test.ts`,
`test/http.test.ts`.

Change:

- Add migration `version: 27`, `name: "idle-agent-maintenance"`, `backwardCompatible: true`,
  `requiresExclusive: true`, `estimatedMs: 500`, with a comment that the estimate bounds the apps
  UPDATE plus the handoffs index build at pre-alpha scale. SQL exactly as design §10:
  - `ALTER TABLE apps ADD COLUMN last_agent_activity_at TEXT CHECK (...)` with the canonical
    millisecond-UTC GLOB;
  - `CREATE INDEX handoffs_from_app_state ON handoffs(from_app_id, state)` **before** the UPDATE;
  - the `UPDATE apps SET last_agent_activity_at = MAX(...)` backfill from `apps.created_at`,
    `instances.started_at`, `session_state.last_activity_at`, `session_resume.last_busy_seen_at`,
    source handoffs, and target handoffs;
  - `ALTER TABLE instances ADD COLUMN applied_launch_hash TEXT`.
- Store plumbing: read `last_agent_activity_at`; a monotonic best-effort `touchActivity` using the
  `WHERE ... IS NULL OR last_agent_activity_at < @at` guard; read/write `applied_launch_hash`; keep
  explicit column lists and no `SELECT *`.
- Schema-version test updates:
  - `test/migrations.test.ts`: `runMigrations` 26 -> 27, add `27` to the version array at line 64,
    all hardcoded 26s, the 12 partial counts at lines 225, 253, 285, 316, 470, 621, 759, 906, 1185,
    1381, 1635, 1978 (`21->22, 17->18, 16->17, 15->16, 14->15, 8->9, 12->13, 11->12, 9->10, 7->8,
    5->6, 4->5`), `max.version`/`knownMax` 26 -> 27, and future-schema lines 365/396 to 28 with
    `applied: 28, known: 27`.
  - `test/commands.test.ts:135,145`: future version 27 -> 28 and expected output `"26"` -> `"27"`.
  - `test/migrate-cli.test.ts`: current/target/pending 26 -> 27; keep deleting v26 in the online test
    so `applied` stays 1; add a v27-only pending test asserting `--online` exits 1 with
    `migration_requires_offline`.
  - `test/store.test.ts:53` add 27; `test/settings-store.test.ts:45` 27;
    `test/skills-store.test.ts:1336` 16; `test/deploy-http.test.ts:74,111` and
    `test/http.test.ts:609` `schemaVersion: 27`.
- Add a v27 migration test: backfill includes handoff activity and uses the greatest signal; the
  CHECK rejects a non-canonical shape; `handoffs_from_app_state` exists; `applied_launch_hash` is
  nullable; `requiresExclusive` is true and `estimatedMs` is 500.
- Schema version is derived from `MIGRATIONS.at(-1)` in `src/store/database.ts`; there is no
  separate constant to edit, but confirm the guard's `knownMax` and the readiness target read 27.

Tests: the migration/store/CLI/HTTP files and cases above, including the v27 backfill/CHECK/index/
launch-hash/`requiresExclusive` test, the 12 partial counts, future 28/known 27, and the v27-only
`--online` rejection.

Verification: `npx vitest run test/migrations.test.ts test/migrate-cli.test.ts test/commands.test.ts
test/store.test.ts test/settings-store.test.ts test/skills-store.test.ts test/deploy-http.test.ts
test/http.test.ts`, then `npm run typecheck`, `npm run lint`.

Rollback: revert the step files. If v27 was already applied, restore the pre-v27 database backup;
the schema guard blocks an older binary after v27.

### Step 2 - Activity service, strict prompt clients, and manager hooks

Files: new `src/opencode/activity.ts`; `src/opencode/client.ts`, `src/opencode/manager.ts`,
`src/opencode/recovery.ts`, `src/http/chat.ts`, `src/http/prompts.ts`, `src/http/context.ts`,
`src/coordinator/dispatcher.ts`, `src/cli/commands.ts`; `test/agent-activity.test.ts` (new),
`test/client.test.ts`, `test/manager.test.ts`, `test/session-resume.test.ts`,
`test/prompts-http.test.ts`, `test/context-http.test.ts`, `test/chat-stage-a-client.test.ts`.

Change:

- `src/opencode/client.ts`: add strict `listQuestionsStrict`, `listPermissionsStrict`,
  `listQuestionsV2Strict`, and `listPermissionsV2Strict`. They throw on a non-array body, a
  missing/non-array v2 `data`, or a malformed entry; keep the existing non-strict functions for the
  HTTP list route.
- `src/opencode/activity.ts`: `AgentActivityService` with `touch`, `lastActivityAt`, `isActive` and
  the design §11.1 dependencies. Implement the design §5.5 check order: lock-free
  `activityEndpoint` tri-state; strict `/session/status`; busy/retry `session_resume`; all four
  strict prompt sources with per-source 404/405 capability semantics and an epoch-keyed cache that
  never short-circuits; recent pending sends; one-shot handoffs (`awaiting_approval`,
  `dispatching`, `in_progress`) and thread messages (`dispatching`, `waiting_operator`); 5-second
  per-call timeouts; fail-closed on malformed/transport/unprobeable. `touch` is best-effort,
  coalesces `status` writes to one per app per 60 seconds, and never throws.
- `src/opencode/manager.ts`: add `noteActivity`, `activityEndpoint` (lock-free; installs endpoint
  auth from `runtime.status` when the in-memory entry is absent), and the write hooks: successful
  destructive start/restart, sampled busy/retry statuses, monitor `session.status`/`question.*`/
  `permission.*`, and recovery resume. Fix `#resumeOne` to set endpoint authorization and
  `#running` for every running app even when monitors are disabled, and to store
  `applied_skills_hash` as well as settings/profile so `pendingRestart` does not fall back to the
  legacy settings-only branch.
- `src/http/chat.ts`, `src/http/prompts.ts`, `src/http/context.ts`,
  `src/coordinator/dispatcher.ts`, `src/opencode/recovery.ts`: touch `prompt` before `ensure` and
  after the pending row insert, `answer` on question/permission answer/reject, `compact` on manual
  and monitor compaction, `handoff` on dispatch and reply routing, and `resume` on resume dispatch.
  `GET`, drafts, SSE heartbeats, terminal/preview/IDE traffic, settings reads, and aborts do not
  touch.
- `src/cli/commands.ts`: construct the service and inject it into `InstanceManager` options; no
  scheduler yet.

Tests: strict clients fail closed on malformed bodies and 404/405 semantics; capability cache
per-source and epoch reset; malformed status; subagent recovery row; unprobeable endpoint; pending
send age; handoff `awaiting_approval` and thread `waiting_operator`; sampler independence;
`#resumeOne` after coordinator restart with `applied_skills_hash` present; GET/draft/abort do not
touch.

Verification: `npx vitest run test/agent-activity.test.ts test/client.test.ts test/manager.test.ts
test/session-resume.test.ts test/prompts-http.test.ts test/context-http.test.ts
test/chat-stage-a-client.test.ts`, then `npm run typecheck`, `npm run lint`.

Rollback: revert the step files; no schema or HTTP contract changes remain.

### Step 3 - Launch snapshot, fingerprint, and pinned image identity

Files: new `src/opencode/launch.ts`; `src/opencode/manager.ts`, `src/opencode/process-errors.ts`,
`src/agent/protocol.ts`, `src/agent/client.ts`, `src/runner/validate.ts`, `src/runner/server.ts`,
`src/runner/docker.ts`; `test/manager.test.ts`, `test/runner-validate.test.ts`,
`test/agent-protocol.test.ts`, `test/runner-build.test.ts`, `test/process-sanitizer.test.ts`.

Change:

- `src/opencode/launch.ts`: `LaunchSnapshot` and `launchFingerprint(snapshot)` from design §5.3.
  Include effective settings, provider/auth/git hashes, OMO profile/skills/model-registry/rule
  hashes, app instruction **content**, shared instruction **content**, baseline plugins, codegraph
  and coordinator commands, coordinator MCP/web overlay, permission policy inputs,
  `resolveRuntimeResources()`, and `HANSE_AGENT_API_BASE`. Exclude the target image and per-request
  identity. Hash content, not paths.
- `src/opencode/manager.ts`: `launchSnapshot`, `launchFingerprint`, `pendingRestart` lock-free by
  contract. `#ensureLocked` captures one snapshot, computes the fingerprint from it, compares it to
  `expectedLaunchFingerprint` before applying, passes `expectedImageId` to the runner, applies from
  the same snapshot, and writes `instances.applied_launch_hash` only on success. Reconnect, status,
  reconcile, and rollback preserve the existing value; legacy `NULL` skips auto-update.
  `restartIfRunning` accepts `{ source, reason, guard, expectedLaunchFingerprint, expectedImageId }`
  and evaluates the caller guard at the top of `#restartLocked`, before any process transition,
  `recordStopIntent`, or side effect. The live target image is resolved and inspected in that guard;
  `#ensureLocked` does not re-inspect after the stop.
- `src/agent/protocol.ts` / `src/agent/client.ts`: carry optional `expectedImageId` on the ensure
  request. `src/runner/validate.ts`: validate it as `sha256:<64 lowercase hex>` and exclude it from
  `specHash`; `RunnerSpec` carries it outside the hashed spec.
- `src/runner/server.ts`: `ensure` resolves the allowlisted reference, verifies its image ID equals
  `expectedImageId`, creates the container **from the pinned image ID**, verifies the created
  container image ID, and removes/aborts on mismatch before start. The running-container reuse and
  adopt paths also verify the image ID; if inspection is unavailable and `expectedImageId` is
  supplied, fail closed with `409 image_changed`. `src/runner/docker.ts` accepts an image ID in the
  create call.
- `src/opencode/process-errors.ts`: add `launch_changed` and `image_changed` to `KNOWN_CODES` and
  `GENERIC_MESSAGES`.

Tests: fingerprint changes on instruction/settings/skill content and not on paths or target image;
reconnect does not write the hash; `NULL` skips auto-update; a configuration change after the guard
fails with `launch_changed` and leaves the app in `error`; a changed target image fails with
`image_changed` before the stop; runner create-by-ID, post-create verification, reuse/adopt
verification, inspect-unavailable fail-closed, and `expectedImageId` excluded from `specHash`.

Verification: `npx vitest run test/manager.test.ts test/runner-validate.test.ts
test/agent-protocol.test.ts test/runner-build.test.ts test/process-sanitizer.test.ts`, then
`npm run typecheck`, `npm run lint`.

Rollback: revert the step files; `applied_launch_hash` remains nullable and unused.

### Step 4 - Terminal session registry and maintenance gate

Files: `src/http/terminal.ts`, `src/http/server.ts`, `src/http/handler.ts`,
`src/opencode/manager.ts`, `src/cli/commands.ts`; `test/terminal-http.test.ts`,
`test/terminal-registry.test.ts` (new), `test/manager.test.ts`.

Change:

- `src/http/terminal.ts`: export `TerminalSessionRegistry` with `register(appId)` (idempotent
  release, `undefined` while a maintenance gate is active), `isActive(appId)`, and synchronous
  refcounted `beginMaintenance(appId)`. The proxy registers **before** forwarding the upstream 101
  and returns `409 agent_maintenance` when registration is refused; release in `finally` on every
  early return, including a false guard.
- `src/http/server.ts` / `src/http/handler.ts`: construct and thread the registry into the terminal
  proxy and manager.
- `src/opencode/manager.ts`: `stopApp` calls `beginMaintenance` inside the per-app lock before the
  guard; `restartIfRunning` calls it in `#runRestartClaimed` after the restart claim is acquired and
  the per-app lock is held, before `#restartLocked` evaluates the guard; release after the
  destructive branch. The claim-failure path does not set the gate. The guard checks
  `terminalSessions.isActive(appId)`, never the maintenance flag.

Tests: register-before-`beginMaintenance` makes the guard skip; register after is refused and the
proxy returns `409`; refcounted release; stop/restart release in `finally`; interleaving with
`stopApp` and `restartIfRunning`.

Verification: `npx vitest run test/terminal-registry.test.ts test/terminal-http.test.ts
test/manager.test.ts`, then `npm run typecheck`, `npm run lint`.

Rollback: revert the step files; the proxy returns to the current no-registry behavior.

### Step 5 - Manager source/reason plumbing and recovery notices

Files: `src/opencode/manager.ts`, `src/opencode/recovery.ts`, `ui/chat/notice-groups.ts`,
`assets/chat-core.js`, `assets/chat-core.d.ts`; `test/manager.test.ts`,
`test/process-recovery.test.ts`, `test/process-http.test.ts`, `test/chat-core.test.ts`,
`test/ui/chat-notice-groups.test.ts`.

Change:

- `stopApp(appId, { source, reason, guard })`: under the per-app lock, check `isRestarting`,
  `isLaunching`, and `isBuilding` before calling `#stopLocked`; evaluate the caller guard; a false
  guard returns false with no process-state change. `#stopLocked` evaluates no internal concurrency
  checks and no caller guard, so the nested stops from `#restartLocked`,
  `#stopForDeletionLocked`, and `rollbackImage` always run. Thread the supplied source/reason into
  every transition, including the runtime-error transition.
- `restartIfRunning(app, options)`: thread source/reason through `#restartLocked`,
  `#ensureLocked`, `#handleRestartFailure`, and `#recordStatus`; the caller guard runs at the top of
  `#restartLocked` before the initial `requested` transition and `recordStopIntent`.
- `StopIntentReason` gains `auto_stop` and `auto_update`; extend `STOP_INTENT_REASON`,
  `#freshIntent`, `SESSION_NOTICE_REASONS`, and `RESTART_REASONS`. Add `restartLike(reason)` for
  `operator_restart` and `auto_update` at the three resume/schedule comparisons in
  `src/opencode/recovery.ts`; `recordStopIntent` treats `auto_update` like `restart` and `auto_stop`
  like `stop`. Add chat notice labels "Stopped automatically after inactivity" and "Restarted
  automatically to apply an image update"; the notice grouping treats `auto_update` as a restart.

Tests: auto-update stop half calls `runtime.delete`, records the `auto_update` stop intent and
notice, and resumes like a restart; manual restart still records `restart`; deletion during a
restart stops the container before `deleting = 1`; `#freshIntent` recognizes both new reasons; a
concurrent ensure/restart/build makes `stopApp` return false; notice labels and grouping.

Verification: `npx vitest run test/manager.test.ts test/process-recovery.test.ts
test/process-http.test.ts test/chat-core.test.ts test/ui/chat-notice-groups.test.ts`, then
`npm run typecheck`, `npm run typecheck:ui`, `npm run lint`.

Rollback: revert the step files; manual source/reason behavior is unchanged.

### Step 6 - Maintenance scheduler and background wiring

Files: new `src/coordinator/agent-maintenance.ts`; `src/cli/commands.ts`, `src/opencode/manager.ts`
(`isBuilding`/lock-free accessors); `test/agent-maintenance.test.ts` (new),
`test/agent-maintenance-config.test.ts` (new), `test/cli.test.ts`, `test/process-recovery.test.ts`.

Change:

- `src/coordinator/agent-maintenance.ts`: `resolveMaintenanceConfig(env)` for
  `HANSE_AGENT_AUTO_STOP_MS`, `HANSE_AGENT_AUTO_UPDATE_MS`,
  `HANSE_AGENT_MAINTENANCE_INTERVAL_MS`, and `HANSE_AGENT_AUTO_PULL_MS` (defaults, clamps, `0`
  disables, one warning on invalid input). `AgentMaintenanceScheduler` with the design §11.3
  options and report, two `unref()`ed timers, `start`/`stop`, testable `runOnce`/`runPullOnce`, a
  shared idle/pull single-flight mutex, drain/shutdown checks before each pass and inside guards,
  and an `AbortController` for in-flight pulls.
- Idle pass: candidate query with the design §11.3 `MAX(...)` fallback and
  `cutoff = min(enabled thresholds)`; branch stop before update; skip master, deleting,
  starting/stopping/restarting/building, deployment-locked, and draining apps; bounded per-app
  concurrency, overall deadline, and one-hour per-app failure cooldowns; audit/events/logs per
  design §15. If `images` is absent, skip update and pull but keep auto-stop.
- Pull pass: call `images.pullConfigured({ signal, isDraining })` on its timer; failures are logged
  and do not stop the idle timer.
- `src/cli/commands.ts`: construct the scheduler after the manager, images, drain, terminal
  registry, and `managedAppFor` resolver exist; `await recoverRestartClaims(...)` before
  `scheduler.start()` so a persisted claim is visible; stop it in `stopBackground` and on close.

Tests: config defaults/clamps/disable; candidate `MAX` protects a recent start; stop wins when both
thresholds are met; update requires `restart_required`, unchanged fingerprint, and pinned image;
skip reasons for rebuild/building/error/not-ready/unknown/master/deleting/transitioning; drain and
deployment lock; terminal gate; per-app concurrency/deadline/cooldown; shared idle/pull mutex;
recovery-before-scheduler; audit rows; scheduler stop aborts a pull.

Verification: `npx vitest run test/agent-maintenance.test.ts test/agent-maintenance-config.test.ts
test/cli.test.ts test/process-recovery.test.ts`, then `npm run typecheck`, `npm run lint`.

Rollback: revert the step files; timers are not constructed, so no automatic action runs.

### Step 7 - Runner image pull and coordinator auto-pull

Files: new `src/runner/image-mutation.ts`, new `src/runner/image-pull.ts`; `src/runner/server.ts`,
`src/runner/docker.ts`, `src/runner/images.ts`, `src/runner/image-gc.ts`, `src/images/client.ts`,
`src/images/service.ts`, `src/cli/commands.ts`; `test/runner-build.test.ts`,
`test/image-lifecycle.test.ts`, `test/image-pull.test.ts` (new).

Change:

- `src/runner/image-mutation.ts`: shared `ImageMutationMutex` held for the entire asynchronous
  build, pull, and GC/purge. Build-vs-build and purge-vs-build keep `build_in_progress`; a pull
  conflict returns `409 image_mutation_in_progress`; release in `finally`.
- `src/runner/image-pull.ts`: strict reference validator (reject multiple `@`, empty tags,
  malformed digests, control characters, malformed registry/repository forms; exact equality
  against `allowedImages`, `defaultImage`, or `baseImage`; app-built images rejected) and the pull
  operation.
- `src/runner/docker.ts`: `DockerTransport.stream()` / `DockerClient.pullImage(reference,
  { signal })` returning NDJSON lines with a bounded line/byte budget and `error`/`errorDetail`/
  `aux.ID` parsing. Do not use the 8 MiB buffered request or the WebSocket upgrade.
- `src/runner/server.ts`: register `POST /v1/images/pull` after the bearer-token check and before
  the generic `/v1/images/:id` route. Read and validate the body before the mutex; 10-minute
  deadline; abort the Docker stream on `response.on("close")` when `!response.writableFinished` and
  on `request.socket` close; sanitized `502 pull_failed`, `403 image_disallowed`, `409
  image_mutation_in_progress`, `507 disk_critical`, `507 disk_guard_unavailable`; response
  `{ reference, previousImageId, imageId, changed, digest }`. Old runners return `405` on the
  generic route; the coordinator treats `404`/`405` as an unsupported skip.
- `src/runner/image-gc.ts`: fail-closed disk guard. `usage()` with `disk === null` is unavailable;
  the pull rejects at `warning`/`critical` (75%/85%) before and at `critical` during the pull. Use
  `HANSE_IMAGE_DISK_PATH` (default `HANSE_HOST_WORKSPACE`).
- `src/images/client.ts`: `RunnerImageClient.pull(reference, { signal })` with a 12-minute
  `AbortSignal.any` timeout; `409`/`507`/`404`/`405` are benign skips.
- `src/images/service.ts`: `ImageService.pullConfigured({ signal, isDraining })` pulls the default
  agent reference and, when configured and used, the shared base reference sequentially and
  deduped; skips digest-pinned references, deployment-locked/draining, and critical disk; invalidates
  the identity cache after success; returns a bounded report. Audit global `image.auto_pull` for
  every attempt, `app.auto_pulled` for changed default-image apps, and `app.rebuild_required` when a
  base move makes a custom app rebuild-required.

Tests: allowlist/validation/control-character/digest/app-built rejection; body-before-mutex;
streaming NDJSON and oversized-line budget; build-vs-build keeps `build_in_progress`; pull conflict
`image_mutation_in_progress`; pre/during disk guard and statfs fail-closed; client disconnect
releases the mutex; old-runner `405`; sanitized errors; `previousImageId`; coordinator skip matrix,
identity-cache invalidation, and audit events; `/v1/images/pull` in the reserved-route test.

Verification: `npx vitest run test/image-pull.test.ts test/runner-build.test.ts
test/image-lifecycle.test.ts`, then `npm run typecheck`, `npm run lint`.

Rollback: revert the step files. The coordinator ignores the missing route as an unsupported skip;
idle stop/update continue to work without auto-pull.

### Step 8 - Rebuild-only chat action and image-mutation origin check

Files: `assets/chat-core.js`, `assets/chat-core.d.ts`, `ui/components/chat/ChatImageWarning.vue`,
`ui/pages/ChatPage.vue`, `ui/chat/session-storage.ts`, `src/http/images.ts`,
`src/http/handler.ts`, `docs/design/chat-qa.mjs`, `e2e/spa-chat.spec.ts`;
`test/chat-core.test.ts`, `test/ui/chat-cards.test.ts`, `test/ui/chat-session-storage.test.ts`,
`test/ui/chat-page.test.ts`, `test/app-image-api.test.ts`.

Change:

- `assets/chat-core.js`: warning shape `{ tone, title, body, action, secondaryAction? }`; for
  `rebuild_required` primary `rebuild_restart` ("Rebuild & restart"), secondary `rebuild` ("Rebuild
  only"), body "Rebuild and restart, or rebuild only to apply later." Add `"rebuild"` to the
  `ImageWarningAction` typedef and `imageActionLabel()`. An unknown action is ignored.
- `ChatImageWarning.vue`: render the secondary button with the existing classes and
  `data-chat-image-action="rebuild"`; both buttons emit the action string.
- `ui/chat/session-storage.ts`: add `"rebuild"` to the image-intent type and read guard.
- `ui/pages/ChatPage.vue`: add `"rebuild"` to the poll modes. After the build is ready, refetch the
  image view only; never call restart or start. Continue only when the view is `restart_required`
  or `current`; `build_error` never restarts onto the old image. The banner then shows the normal
  restart action and a toast says the image is built and a restart is required.
- `src/http/images.ts` / `src/http/handler.ts`: export/reuse `isSameOrigin` and apply it to all
  image mutations (build, rollback, check, gc). An absent Origin remains accepted; the cookie is
  the primary control.
- `docs/design/chat-qa.mjs`: update the image banner button assertions and add a rebuild-only
  scenario. Add the rebuild-only E2E case to `e2e/spa-chat.spec.ts` (no restart request after a
  successful rebuild-only build).

Tests: warning shape/labels; secondary button render and emit; session-intent round trip; poll
mode does not restart on `rebuild`; `build_error` does not restart; same-origin rejection on each
image mutation; chat QA button assertions; E2E rebuild-only.

Verification: `npx vitest run test/chat-core.test.ts test/ui/chat-cards.test.ts
test/ui/chat-session-storage.test.ts test/ui/chat-page.test.ts test/app-image-api.test.ts`, then
`npm run typecheck`, `npm run typecheck:ui`, `npm run lint`, `npm run check:ui`.

Rollback: revert the step files; the banner returns to the single `rebuild_restart` action.

### Step 9 - Documentation, environment, and Compose

Files: `Dockerfile`, `docs/current-state.md`, `docs/deployment.md`, `README.md`, `.env.example`,
`compose.yaml`, `docs/design/README.md`, `docs/plans/README.md`.

Change:

- `Dockerfile`: `org.hanse.schema.max="27"`.
- `docs/current-state.md`: schema `[1..27]`; add a maintenance section (activity clock, auto-stop,
  auto-update, auto-pull, terminal veto, rebuild-only); qualify the explicit build/restart
  statements.
- `docs/deployment.md`: schema `1..27`; bump the sample `/api/deploy/drain` JSON `schemaVersion` at
  line 406 from 26 to 27; add the five environment variables; document the mutable-tag
  supply-chain trade-off, digest-pin or `HANSE_AGENT_AUTO_PULL_MS=0` opt-out, the
  `HANSE_IMAGE_DISK_PATH` filesystem assumption, the pull disk guard, the coordinator/runner
  together upgrade requirement, and that binary rollback after v27 requires restoring the pre-v27
  backup.
- `README.md`: feature bullet and the explicit-restart qualification.
- `.env.example`: the five variables with defaults and disable semantics.
- `compose.yaml`: coordinator environment for the idle/update/interval/pull timers; runner
  environment for `HANSE_IMAGE_DISK_PATH`.
- `docs/design/README.md` and `docs/plans/README.md`: add this stage's entries and status.

Tests: none (documentation, environment, and Compose only); the focused checks are the sensitive
scan and the schema-reference search below.

Verification: `npm run check:sensitive`; `rg -n "1\\.\\.26|schemaVersion.?26|schema.max=.?26"
Dockerfile docs README.md .env.example compose.yaml` (only historical journal/design entries may
remain).

Rollback: revert the docs/env/Compose files; the runtime defaults are unchanged.

### Step 10 - Full verification, record, and commit

Files: `docs/journal/0051-idle-agent-maintenance.md` (new), `docs/journal/README.md`, plus any
step file that needs a verification fix.

Change:

- Write the journal with baseline SHA, design/plan status, decisions, migration v27, test evidence,
  accepted limits (mutable tags, no auto-rollback, no auto-rebuild, terminal veto, journal
  numbering if it moved), and next steps.
- Update `docs/journal/README.md`.
- Run the full verification gate list below. Fix any failure and re-run the affected focused tests.
- Commit once (code + tests + docs + record) after all gates pass, with owner authorization:
  `feat(agents): add idle agent maintenance`.

Tests: the complete suite from every step plus `npm run test:e2e`; the journal records the counts
and any pre-existing failures inherited from the zero-ssr and 0041 baseline.

Rollback: revert the commit; if v27 was applied, restore the pre-v27 database backup (the schema
guard blocks an older binary).

## Test matrix

| AC/risk | Level | Test files | Evidence |
| --- | --- | --- | --- |
| Auto-stop at 2 days, stop wins over update | Integration | `test/agent-maintenance.test.ts`, `test/manager.test.ts` | idle pass stops a `ready` app with `source: system`, `reason: auto_stop`; a stop candidate also due for update is stopped |
| Auto-update at 3 hours with unchanged fingerprint and pinned image | Integration | `test/agent-maintenance.test.ts`, `test/manager.test.ts`, `test/runner-build.test.ts` | restart only for `restart_required` + matching fingerprint + `expectedImageId`; create-by-ID and post-create verification |
| Terminal blocks auto-stop/update | Unit + integration | `test/terminal-registry.test.ts`, `test/terminal-http.test.ts`, `test/manager.test.ts` | register-before-gate skips; register-after is `409`; refcount and release |
| Pending prompts/handoffs/sends count as active | Unit + integration | `test/agent-activity.test.ts`, `test/client.test.ts`, `test/process-recovery.test.ts`, `test/prompts-http.test.ts` | strict v1/v2 fail-closed, capability cache, subagent row, `awaiting_approval`, `waiting_operator`, pending-send age |
| Auto-pull default/base, disk guard, serialization | Integration | `test/image-pull.test.ts`, `test/runner-build.test.ts`, `test/image-lifecycle.test.ts` | allowlist, streaming, mutex, 507 fail-closed, disconnect, `previousImageId`, cache invalidation, audit |
| Rebuild-only chat action | Unit + component + E2E | `test/chat-core.test.ts`, `test/ui/chat-cards.test.ts`, `test/ui/chat-session-storage.test.ts`, `test/ui/chat-page.test.ts`, `e2e/spa-chat.spec.ts` | secondary action, no restart after rebuild, `build_error` never restarts |
| No silent configuration apply | Integration | `test/manager.test.ts`, `test/agent-maintenance.test.ts` | `pendingRestart`/fingerprint skip; `launch_changed`/`image_changed` fail closed; hash written only by `#ensureLocked` |
| Migration v27 | Integration | `test/migrations.test.ts` | backfill, CHECK, indexes, `applied_launch_hash`, `requiresExclusive`, `estimatedMs` |
| Schema-version gates | Unit | `test/commands.test.ts`, `test/migrate-cli.test.ts`, `test/store.test.ts`, `test/settings-store.test.ts`, `test/skills-store.test.ts`, `test/deploy-http.test.ts`, `test/http.test.ts` | 26 -> 27, future 28/known 27, v27-only `--online` rejection |
| Drain/deployment lock/single-flight/recovery-before-scheduler | Integration | `test/agent-maintenance.test.ts`, `test/cli.test.ts`, `test/process-recovery.test.ts` | both passes skip on drain/lock; shared mutex; scheduler waits for restart-claim recovery |
| Activity clock only real work | Unit | `test/agent-activity.test.ts`, `test/chat-stage-a-client.test.ts`, `test/context-http.test.ts`, `test/manager.test.ts` | prompt/answer/compact/handoff/resume/start/restart/busy touch; GET/draft/SSE/terminal/abort do not |
| Risk: mutable-tag supply chain | Integration + docs | `test/image-pull.test.ts`, `docs/deployment.md` | digest-pin and disable opt-out documented; `image.auto_pull` records identities/digest |
| Risk: disk guard path mismatch | Integration | `test/image-pull.test.ts` | `disk === null` rejects; warning/critical reject; during-pull critical aborts |
| Risk: auto-update failure leaves app in `error` | Integration | `test/manager.test.ts`, `test/agent-maintenance.test.ts` | failure records `system`/`auto_update`, app stays `error`, one-hour cooldown, no auto-rollback |
| Risk: binary rollback after v27 | Integration + docs | `test/migrations.test.ts`, `docs/deployment.md` | schema guard blocks old binary; pre-v27 backup restore documented |
| Risk: zero-ssr overlap | Process | baseline commit + rebase | implementation starts only after the zero-ssr and 0041 commits; overlapping files re-read before Step 8 |

## Acceptance criteria

- A running app with no agent work for two days, no live activity, and a clear terminal/maintenance
  gate is stopped with source `system` and reason `auto_stop`; the process history and chat notice
  say "Stopped automatically after inactivity".
- A running app with no agent work for three hours is restarted only when image state is
  `restart_required`, the target image identity is pinned and unchanged, and the launch fingerprint
  equals `applied_launch_hash`; it records source `system` and reason `auto_update`.
- `rebuild_required`, `building`, `build_error`, `not_ready`, `unknown`, changed configuration,
  changed image, stopped/deleting/master/transitioning apps are skipped; no automatic build starts.
- An active operator terminal WebSocket blocks both auto-stop and auto-update; terminal registration
  after maintenance begins returns `409 agent_maintenance`; previews remain stoppable.
- Pending v1/v2 questions and permissions, busy/retry sessions (including subagent recovery rows),
  recent pending sends, and dispatching/awaiting one-shot handoffs and thread messages count as
  active; malformed/unprobeable responses fail closed.
- The runner exposes authenticated, exact-allowlisted, streaming, serialized `POST /v1/images/pull`
  with a fail-closed disk guard, disconnect abort, sanitized errors, and `previousImageId`; the
  coordinator pulls configured default/base references and audits every attempt.
- The chat banner offers "Rebuild only" for `rebuild_required`; it builds without restarting and
  never restarts after `build_error`.
- Auto-update never applies pending settings/skills/model/provider/git/rule/instruction/plugin
  changes; a changed fingerprint fails closed.
- Migration v27 adds `apps.last_agent_activity_at`, `instances.applied_launch_hash`, the handoff
  index before the backfill, the backfill, `requiresExclusive: true`, and `estimatedMs: 500`.
- Schema gates report 27; future-schema simulations use 28/known 27; `migrate --online` refuses a
  v27-only pending migration with `migration_requires_offline`.
- The full verification gate list passes, including `npm run check:ui` and `npm run test:e2e`.

## Risks and rollback

| Risk | Mitigation / rollback |
| --- | --- |
| Mutable-tag auto-pull can introduce an unreviewed image | Owner-accepted; deployment guide documents digest pinning or `HANSE_AGENT_AUTO_PULL_MS=0`; `image.auto_pull` records old/new IDs and resolved digest; no signature verification this iteration. |
| Disk guard path may not be the Docker data root | `HANSE_IMAGE_DISK_PATH` documented; runner fails closed on statfs failure; operators point it at the image filesystem or disable auto-pull. |
| Auto-update failure leaves the app in `error` | No automatic rollback (owner-deferred); process history records `system`/`auto_update`; manual rollback remains; one-hour cooldown prevents retry storms. |
| Binary rollback after v27 | The schema guard blocks an older binary; rollback requires restoring the pre-v27 database backup; deployment guide states this. |
| Zero-ssr overlap | Do not start implementation until the zero-ssr and 0041 stages are committed; rebase on that commit; re-read `ui/pages/ChatPage.vue`, `src/http/handler.ts`, and `src/http/server.ts` before Step 8; re-run baseline gates. |
| Migration number | Migration number is v27 because 0041 owns v26; re-check the highest applied migration after both baselines commit. |
| Pull endpoint security | Runtime-token auth, exact allowlist, no app-built images, shared mutex, streaming bounds, sanitized errors, fail-closed disk guard, client-disconnect abort. |
| Persisted restart claim invisible to the scheduler | `recoverRestartClaims()` completes before `scheduler.start()`; a test covers recovery-before-scheduler. |
| Journal number collision | Owner instruction fixes 0049; if zero-ssr records 0049 first, use the next free number and update the journal index. |

## Open questions

None. All owner decisions are resolved in
[`docs/open-questions.md`](../open-questions.md) under `0043-idle-agent-maintenance` and design §17.

## Verification

```bash
npm run lint
npm run typecheck
npm run typecheck:ui
npm test
npm run build
npm run check:ui
npm run check:sensitive
npm run test:e2e
```

## Ambiguity resolutions

The design does not name every new module; this plan chooses:

- `src/opencode/activity.ts` for `AgentActivityService` (it depends on the OpenCode clients and a
  manager callback).
- `src/opencode/launch.ts` for the pure `LaunchSnapshot`/fingerprint logic.
- `src/coordinator/agent-maintenance.ts` for the scheduler and `resolveMaintenanceConfig`.
- `TerminalSessionRegistry` in `src/http/terminal.ts`.
- `src/runner/image-mutation.ts` and `src/runner/image-pull.ts` for the shared mutex and pull
  validator/service.
- Migration v27 (not v26) because stage 0041 owns v26.

All behavior follows the design's stated rules; no new product requirement is introduced.
