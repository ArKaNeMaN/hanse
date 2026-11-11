# 0051 - Idle agent maintenance

Status: **implemented and verified** (2026-11-11). Commit: this stage commit.
Design: [Idle agent maintenance](../design/idle-agent-maintenance.md) (revision 7; Oracle round 6
PASS WITH FIXES; security-engineer round 6 PASS WITH FIXES; clarifications folded).
Plan: [0043 - Idle agent maintenance](../plans/0043-idle-agent-maintenance.md) (`momus` OKAY).
Baseline: commit `ca74553` (zero-SSR, journal 0049) plus commit `9913271` (Telegram notifications,
migration v26, journal 0050). This stage adds migration v27.
Mode: **feature** - a durable activity policy, a runner image pull, and a chat rebuild-only action.

## Scope

A running agent is stopped after two days without agent work, and is restarted after three hours
without work only when an already present image is pinned and the launch configuration is unchanged.
The coordinator also pulls the configured default/base images on a schedule, an active operator
terminal vetoes both actions, and the chat `rebuild_required` banner gains **Rebuild only**.

## What changed

- **Schema (migration v27).** `apps.last_agent_activity_at` with a canonical-shape CHECK,
  `instances.applied_launch_hash`, the `handoffs(from_app_id, state)` index (created before the
  backfill), and a greatest-signal backfill from app start, session activity, recovery rows, and
  handoffs. The migration is `requiresExclusive: true` and `estimatedMs: 500`.
- **Activity clock.** `AgentActivityService` coalesces status writes, resolves a tri-state endpoint,
  uses strict `/session/status` and strict v1/v2 question/permission clients, keeps an epoch-keyed
  prompt-capability cache, and fails closed on malformed/transport/unprobeable checks. It counts
  busy/retry sessions (including subagent recovery rows), recent pending sends, `awaiting_approval`/
  `dispatching`/`in_progress` one-shot handoffs, and `dispatching`/`waiting_operator` thread
  messages. Prompt/answer/compact/handoff/resume/start/restart touch the clock; GET/draft/SSE/
  terminal/preview/IDE/settings reads do not. `#resumeOne` now attaches every running app and reads
  `applied_skills_hash` even when monitors are disabled.
- **Launch authority.** A pure `LaunchSnapshot`/`launchFingerprint` hashes settings, provider/auth/
  git hashes, OMO/profile/skills/model-registry/rule hashes, instruction content, baseline plugins,
  coordinator/web overlays, permission inputs, runtime resources, and the API base; it excludes the
  target image and per-request identity. Only a successful destructive `#ensureLocked` writes
  `applied_launch_hash`; reconnect/status/reconcile preserve it.
- **Pinned image identity.** Auto-update passes the guarded `expectedImageId`. The runner validates
  it as a Docker ID, excludes it from `specHash`, re-inspects the allowlisted reference, creates the
  container from the pinned ID rather than the mutable tag, verifies the created/adopted container,
  and returns `409 image_changed` on mismatch. The running-container reuse path also verifies the
  image ID; an unavailable inspect fails closed.
- **Terminal gate.** `TerminalSessionRegistry` counts attached terminals with an idempotent release.
  The proxy registers before forwarding the upstream 101 and returns `409 agent_maintenance` when
  refused. `beginMaintenance` is synchronous, set inside the per-app lock before the guard,
  refcounted, and released in `finally`; the claim-failure path does not set it. The guard checks
  `isActive`, never the maintenance flag.
- **Manager source/reason.** `stopApp` owns the `isRestarting`/`isLaunching`/`isBuilding` checks and
  the caller guard; `#stopLocked` evaluates neither, so nested stop, deletion, and rollback always
  run. `auto_stop` and `auto_update` flow through process history, chat notices, `#freshIntent`,
  `restartLike`, `SESSION_NOTICE_REASONS`, and `RESTART_REASONS`; manual behavior stays
  `operator`/`stop` or `operator`/`restart`. Auto-update resumes like a restart; deletion still stops
  the container before setting `deleting = 1`.
- **Scheduler.** `AgentMaintenanceScheduler` runs unref'ed idle and pull timers with one shared
  single-flight mutex. The idle pass uses the `MAX(COALESCE(...))` activity fallback, the minimum
  enabled cutoff, stop-before-update, bounded concurrency/deadline, and one-hour failure cooldowns.
  Guards re-check drain, deployment lock, terminal, process phase, clock, live activity, image
  state, target identity, pending restart, and fingerprint. Startup waits for `recoverRestartClaims`
  before the scheduler starts; shutdown stops it.
- **Auto-pull.** The runner adds authenticated `POST /v1/images/pull` after the bearer check and
  before the generic image route, with an exact allowlist, strict reference grammar, bounded
  streaming Docker pull, shared `ImageMutationMutex`, fail-closed pre/during disk guard, disconnect
  abort, sanitized errors, and `{ reference, previousImageId, imageId, changed, digest }`. The
  coordinator pulls default/base images with drain/deployment-lock/digest skips, invalidates the
  identity cache, and audits `image.auto_pull`, `app.auto_pulled`, and `app.rebuild_required`.
- **Rebuild only.** `imageWarningFromView` exposes a secondary `rebuild` action for
  `rebuild_required`; `ChatImageWarning` renders it; the chat poll refetches the image without
  restarting and never restarts after `build_error`. All image mutations now use the existing
  `isSameOrigin` check.
- **Docs and configuration.** Schema references are 27. `.env.example`, Compose, README,
  `docs/current-state.md`, and `docs/deployment.md` document the five settings, the mutable-tag
  trade-off, the disk-path assumption, the coordinator/runner together upgrade, and the v27
  forward-only rollback.

## Verification

- Focused suites: Step 1 **149**, Steps 2/8 **662**, Step 3 **239**, Steps 4/7 **271**, Step 5
  **527**, Step 6 **85** tests passed.
- `npm test`: **3,931 passed, 1 skipped** (267 files: 266 passed, 1 skipped).
- `npm run typecheck`, `npm run typecheck:ui`, `npm run lint`: passed.
- `npm run build`: passed. `npm run check:ui`: 85 SFCs, sentinel present, ChatPage chunk 76,422 B
  gzip (budget 256,000 B).
- `npm run check:sensitive`: passed.
- `npm run test:e2e`: **135 passed, 1 skipped** (including the rebuild-only scenario).

## Accepted limits

- Mutable tags can introduce an unreviewed image. Pin digests or set
  `HANSE_AGENT_AUTO_PULL_MS=0`; signature verification is not implemented.
- The pull disk guard statfs'es `HANSE_IMAGE_DISK_PATH` (default `HANSE_HOST_WORKSPACE`). It fails
  closed on statfs failure but can under-report if Docker's data root is on another filesystem;
  operators must point it at the image filesystem or disable auto-pull.
- Auto-update failure leaves the app in `error`; rollback stays manual (one-hour cooldown). There is
  no automatic build or rollback.
- Auto-pull requires the new runner; with an old runner the missing pull route is an unsupported
  skip, so stop/update still work. Upgrade the coordinator and runner together.
- An active operator terminal blocks maintenance indefinitely by design.
- A first-ever prompt on a source that has never succeeded and returns a transient 404 is treated
  as unsupported; the probe still queries all four sources and is fail-closed on other failures.
- Journal numbering moved to 0051 because 0049 is zero-SSR and 0050 is Telegram notifications.
- Deployment was not performed by this stage.
