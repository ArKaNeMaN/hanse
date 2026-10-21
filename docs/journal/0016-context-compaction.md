# 0016 - Session context usage, manual compaction, and auto-compaction

Status: implemented and verified; deployment pending.

## Problem

The chat workspace could show status, queue, plan, and tool activity, but not how much of the
model's context window a session had consumed. Operators could not see an approaching limit,
trigger opencode compaction on demand, or ask Hanse to compact early at a chosen fill percentage.
opencode already carried per-step token usage and per-model context limits; Hanse dropped the usage
in its typed SSE projection and never fetched provider limits.

## Decision

Deliver a server-authoritative context layer rather than a client-only meter.

- **Per-app monitor.** `InstanceManager` owns one `ContextMonitor` per running application. The
  monitor subscribes to opencode's `/event` stream with the existing endpoint Basic auth, consumes
  the projector in an opt-in `includeUsage` mode, and keeps per-session usage/model/status/compaction
  state in memory. It starts with the running entry, stops before endpoint auth is cleared, and
  `resumeRunning` attaches best-effort to instances that survive a coordinator restart without
  starting stopped apps.
- **Semantics.** Usage is the latest non-summary assistant step's prompt tokens
  (`input + cache.read + cache.write`); `step-finish` is authoritative and a finished
  `message.updated` is the fallback. Limits come from `GET /config/providers` and are cached per
  monitor. A missing limit shows tokens only. Hydration reads a 30-message tail and respects the last
  compaction boundary, so a restart cannot resurrect pre-compaction usage.
- **Manual compaction.** `POST /session/:sid/summarize` (opencode 1.19.3) with the session's last-used
  model, falling back to effective `llm.model` only when hydration finds no assistant usage, and
  `auto:false`. The coordinator returns `202`, claims the session synchronously, and runs the
  blocking summarize in the background; the UI follows SSE and the context snapshot.
- **Auto-compaction.** Two live settings (`context.auto_compact.enabled`, default false;
  `context.auto_compact.percent`, default 80, 1..99). Idle top-level sessions only, with a hysteresis
  floor, an `ineffective` latch, a failure cooldown measured from the failure instant, one retry after
  the cooldown, and a 10-minute timeout. opencode's built-in overflow compaction remains enabled.
- **Settings are live.** The `context` group is excluded entirely from the launch settings hash, so
  changing it never marks a running agent restart-required. `llm.model` and other launch settings
  still do.
- **API/UI.** Human-only `GET /api/apps/:app/sessions/:sid/context` and
  `POST .../compact`; the chat thread meta has a context chip, the context rail has a meter,
  auto-compaction state, confirmation, and `Compact now`; a new `Context` settings section exposes
  the two keys. `session.compacted` is a new typed SSE frame.
- **No database migration.** Tracker state is in memory; opencode remains the message source of
  truth.

## Verification

- `npm run lint`, `npm run typecheck`, `npm test`, `npm run build` pass (1429 tests in 91 files).
- New unit/HTTP coverage: context tracker/policy/hydration/limit cache (41 tests), context monitor
  and lifecycle/resume (23), context HTTP routes (24), usage-enabled projector/client (including
  provider limits and summarize), and the settings/chat additions.
- `node docs/design/chat-qa.mjs`: 14 scenarios PASS, zero console/page errors. New context scenarios
  cover ready, tokens-only, unknown, ineffective, manual compaction (confirm -> 202 -> compacting ->
  poll -> `session.compacted` -> refreshed), a fixed 409 path, a session-switch stale-response race,
  and a `stream.ready` 503 retry. Screenshots are in `docs/design/artifacts/chat/`
  (`context-*.png`, 1440/390 dark plus 768 light).
- Browser QA also confirms existing chat scenarios still pass with the new context requests.
- The settings-save QA harness was extended with a Context section scenario; it requires a seeded
  live coordinator and was not run as part of the deterministic chat harness.
- Live `deployment-host` smoke is recorded in the deploy section below once the stage is deployed.

## Accepted debt / risks

- One extra opencode SSE connection per running application (browser app stream + context monitor).
  A shared event hub is a later optimization.
- Context state is in memory and lazily rehydrated; there is no historical usage chart or per-message
  cost UI.
- Child/subagent sessions are excluded from auto-compaction and manual actions target the selected
  top-level session.
- opencode's built-in auto-compaction may act before the configured raw-context threshold for models
  with a smaller usable window; it remains a safety net rather than being disabled.
- A summarize call can continue upstream after Hanse's timeout; the tracker accepts a late
  `session.compacted` as success but does not re-arm or start a second compaction.
- Fixed `lastError` codes are intentionally surfaced instead of raw upstream provider text.

## Deploy

Pending: commit, push, wait for the GHCR `sha-<short>` image, deploy to `deployment-host`, health-check, live
smoke, and append the result here plus `docs/deploy/deploy-log.md`.
