# Design - Session context usage, manual compaction, and auto-compaction

Status: **approved** - design review rounds 1-2 (`oracle`) CHANGES REQUESTED, revision 3, round 3
PASS (2026-10-21). Implementation permitted.
Scope: coordinator-side per-session context accounting, model context-limit lookup, manual
compaction, threshold-based auto-compaction, the chat context chip/rail, and the hierarchical
setting that controls auto-compaction.
Out of scope: implementation in this document.

## 1. Problem

The chat workspace shows session status, queue, plan, and tool activity, but not how much of the
model's context window the session is using. An operator cannot see an approaching context limit,
cannot trigger opencode's compaction on demand, and cannot ask Hanse to compact early at a chosen
fill level.

opencode already exposes the raw inputs: assistant messages and `step-finish` parts carry per-step
token usage and the selected model, and the provider catalog carries each model's context limit.
Hanse currently drops the usage in its typed SSE projection and never fetches provider limits. There
is also no coordinator route for compaction.

## 2. Requirements

| ID | Requirement |
| --- | --- |
| C1 | For the selected session, the chat shows the context used, the model context limit, and the fill percentage, with a truthful unknown state when either value is unavailable. |
| C2 | Usage accounting is server-side and tracks every top-level session of a running application, not only the session currently open in a browser. |
| C3 | Usage is the latest non-summary assistant step's prompt tokens, `tokens.input + tokens.cache.read + tokens.cache.write`; `step-finish` parts are authoritative during a turn and `message.updated` is the final fallback. The model is the message's `providerID`/`modelID`. |
| C4 | The context limit is the selected model's `limit.context` from opencode's configured-provider catalog; a missing limit degrades to a token count, never to a guessed percentage. |
| C5 | A human operator can compact the selected session on demand; the action is rejected while the session is busy or already compacting. |
| C6 | Compaction uses opencode 1.19.3's `POST /session/:sessionID/summarize` with the session's last-used model, falling back to the effective Hanse model, and `auto:false`. |
| C7 | Global, project, and application settings can enable auto-compaction and choose a threshold percentage; the default is off at 80%. |
| C8 | Auto-compaction triggers only for idle top-level sessions, with hysteresis that prevents repeated compaction when compaction cannot reduce usage below the threshold, and a cooldown after failure. It never disables opencode's built-in overflow compaction. |
| C9 | Changing the auto-compaction settings does not mark running agents restart-required; the coordinator reads them live. |
| C10 | A coordinator restart resumes accounting for application instances that are still running, best-effort, without starting stopped instances. |
| C11 | The API is human-only; agent principals receive `403`. No provider key material, prompt text, message content, or raw upstream error body leaves the tracker. |
| C12 | Existing chat, settings, SSE, session, and deletion behavior remains unchanged; the legacy message route and the IDE extension keep working. |

## 3. Verified upstream facts (opencode 1.19.3, commit e3c4eb2)

- Manual compaction route: `POST /session/:sessionID/summarize`, body
  `{ providerID: string, modelID: string, auto?: boolean }`, success `true` (JSON boolean). It is the
  v1 route used by the TUI `/compact` action. The v2 `POST /api/session/:sessionID/compact` exists but
  is a stub returning `503` in 1.19.3.
- `summarize` is blocking: it creates a compaction user message, runs the prompt loop to completion,
  and returns. It does not reject a busy session; it joins the existing run via
  `Runner.ensureRunning`. Unknown models fail through the prompt loop (a `session.error` event, then
  an unhandled error/500), so the coordinator must own a model that the instance knows.
- Assistant message usage: `info.tokens` = `{ input, output, reasoning, cache: { read, write }, total? }`,
  `info.cost`, `info.providerID`, `info.modelID`, `info.summary?`, `info.finish?`. `tokens` is
  overwritten with each step's usage (last step), while `cost` accumulates across the message.
- `step-finish` parts carry the same per-step `tokens` and `cost`, and are emitted before the
  message's final `finish`. They are the best live source during a long turn.
- Context occupancy for the latest request is `input + cache.read + cache.write` (raw prompt tokens).
  Including `output`/`reasoning` describes the approximate context after the turn, not the request
  that filled the window. Hanse uses the request measure for the indicator and the auto threshold.
- Model limits: `GET /config/providers` returns
  `{ providers: [{ id, models: { [modelID]: { limit: { context, input?, output } } } }], default }`.
  `GET /provider` returns `{ all, default, connected }` with the same model shape. The configured
  catalog is the correct source for an agent's available models.
- Compaction events: `message.updated` / `message.part.updated` carry the compaction user message,
  the summary assistant message, and its streamed parts; `session.compacted` (`{ sessionID }`) is
  emitted after a successful compaction; `session.error` covers provider failures.
- opencode's built-in auto-compaction uses `usable = limit.input - reserved` (when `limit.input`
  exists) or `limit.context - maxOutputTokens`, with `reserved = min(20000, maxOutputTokens)`, and
  only runs when `compaction.auto !== false`. Hanse does not configure or disable it.
- `GET /session` returns session metadata including `parentID`, so child/subagent sessions can be
  distinguished from top-level sessions.

## 4. Decisions

### D1 - One background context monitor per running application instance

`InstanceManager` owns a `ContextMonitor` per running application, alongside its private running
entry. The monitor opens one long-lived `GET {endpoint}/event` subscription with the existing Basic
auth and consumes it through `createEventStream` (the same projector as the browser route, with a
usage-enabled projector option). It does not implement a second SSE parser.

Why here: the manager is the only component that owns instance lifecycle, the runtime endpoint, and
the endpoint-auth registration. HTTP route handlers are per-request and must not own background
state; the existing app SSE route opens a new upstream connection per browser and cannot be the
accounting source.

Lifecycle wiring:

- Start after the running entry and endpoint auth exist, in both `ensure` branches (a new instance
  and a reconnect after coordinator restart). Every monitor gets a monotonically increasing
  generation token per app; `isCurrent()` checks both the generation and
  `#running.get(appId)?.endpoint === endpoint`. A newer monitor supersedes and aborts an older one;
  start is idempotent per `(appId, endpoint, generation)`.
- Stop before clearing endpoint auth in `#stopLocked`, before replacing an endpoint in the reconnect
  path, before deleting a stale entry, and in `stopAll`/`detach`. In `stopAll`, stop all monitors
  **before** `runtime.reconcile([])`. `stop()` is synchronous: abort the fetch and clear timers; the
  async reader unwinds on its own. Every detached compaction promise has an explicit `.catch`.
- `restartIfRunning` needs no extra code: `stopApp` stops the monitor, `ensure` starts a new one.
- Deletion is covered by `stopForDeletion` -> `#stopLocked`.
- Add `InstanceManager.resumeRunning(apps: Array<{ id, projectId, appKey }>)` for coordinator startup.
  It runs each app through `#withAppLock`, skips apps/projects with deletion markers, reads runtime
  status, attaches only to `running`/`starting` instances with a readable password and matching agent
  token, populates the same private `Entry` shape as the `ensure` reconnect branch, and starts a
  monitor. It never calls `runtime.ensure`, so stopped apps stay stopped. `serveCommand` invokes it
  best-effort after the HTTP server starts; failures are logged without secrets and do not block
  serving. The per-app lock makes it safe against a concurrent `ensure`.
- Monitor injection: `InstanceManagerOptions.monitorFactory?` and `enableContextMonitors?` let tests
  use a fake monitor or disable the network entirely; production defaults to on.

The monitor reconnects with bounded exponential backoff (1s, 2s, 4s, ... capped at 30s) and stops
when its `isCurrent()` callback fails. It never reconnects after `stop()`.

### D2 - Tracker semantics and scope

The tracker is in memory, keyed by session ID per application:

- Last assistant usage: tokens (`input`, `output`, `reasoning`, `cache.read`, `cache.write`), model,
  message ID, timestamp, source (`step-finish` or message finish).
- Per-message metadata (bounded map): message ID -> role, `summary`, model, so a `step-finish` part
  can be attributed and summary messages excluded.
- Session status: `idle`, `busy`, `retry`, `unknown`, from `session.status`/`session.idle`.
- Compaction state: `state` (`unknown`/`ready`/`compacting`), `lastCompactedAt`, `lastError` (fixed
  code), `lastAttemptAt`, `armed` (auto threshold latch), `lastAutoCompactionAt`.
- Usage is accepted only for non-`summary` assistant messages. A `step-finish` part is authoritative
  for the current step; a finished `message.updated` is the fallback. A message whose model is not
  known yet is ignored until `message.updated` supplies it.
- `session.compacted` resets usage to unknown, keeps the last known model/limit, and records
  `lastCompactedAt`; the next non-summary step repopulates usage. The summary message's tokens are
  never used for context occupancy.
- Live `compaction` parts mark the session compacting. Historical compaction parts found during
  hydration **do not** set `compacting`; only events observed after the monitor attaches do.
- Child sessions (`parentID !== undefined` from `GET /session`) are tracked for the manual indicator
  but excluded from auto-compaction. The monitor caches the session list for 30s and refreshes it
  before an auto trigger with a bounded request (timeout + max bytes). A failed refresh, a session
  absent from the list, or an unknown `parentID` skips the auto trigger (fail closed).
- Bounded memory: at most 500 sessions per app, plus bounded message/part maps, 24 hours of
  inactivity; oldest entries are evicted. No message text is stored.

Initial state is hydrated lazily on the first snapshot request for a session:
`GET /session/:sid/message?limit=30`. The newest non-summary usage and the newest compaction boundary
(compaction part or summary assistant) are compared; if the compaction boundary is newer than the
newest usage, usage is unknown (the pre-compaction number must not be resurrected). Hydration also
uses `GET /session` to learn `parentID`. Hydration is owned by the context service and uses the
running entry's endpoint/auth, so it still works when the monitor itself failed.

### D3 - Provider limits are cached per monitor, never persisted

`ContextMonitor` fetches `GET /config/providers` once per instance lifetime (4 MiB cap, 10s timeout),
indexes `providerID -> modelID -> limit`, and keeps only the three numeric limits. A successful cache
survives until the monitor stops (an instance restart re-reads it). A failed fetch is retried on the
next usage with a 60s backoff. The endpoint is never called per browser request.

The indicator denominator is `limit.context`. If the model or limit is missing, the snapshot carries
`used` tokens and `limit: null`; the UI shows tokens only and auto-compaction is skipped. No static
model map is introduced.

The built-in opencode auto-compaction remains enabled. Hanse's threshold is an additional, usually
earlier policy; for models where opencode's usable window is smaller than Hanse's raw-context
threshold, opencode may compact first. That is an accepted safety-net interaction, not a bug.

### D4 - HTTP contract

New human-only routes, both accepting the optional `?project=<projectId>` disambiguator:

`GET /api/apps/:app/sessions/:sid/context`

```json
{
  "sessionID": "...",
  "state": "ready" | "unknown" | "compacting",
  "used": 124000,
  "limit": 200000,
  "percent": 62,
  "model": { "providerID": "deepseek", "modelID": "deepseek-flash" },
  "status": "idle",
  "updatedAt": "2026-10-21T...",
  "lastCompactedAt": null,
  "lastError": null,
  "autoCompact": { "enabled": true, "percent": 80, "source": "app", "percentSource": "global" }
}
```

Invariants: `percent` is `null` exactly when `used` or `limit` is null or `limit <= 0`; otherwise it is
`Math.round(used / limit * 100)` and may exceed 100. `state` is authoritative and `compacting` is not
duplicated as a boolean. `lastError` is a fixed code (`compaction_failed`, `compaction_timeout`,
`compaction_unavailable`) or `null`, never an upstream body; `compaction_unavailable` means no
attempt could start (no endpoint/auth or no model), not a provider failure. `autoCompact.source` is
the source of `enabled`; `autoCompact.percentSource` is the source of `percent`, and both are
`global`/`project`/`app`/`default`.

`POST /api/apps/:app/sessions/:sid/compact` takes no body and returns
`202 {accepted:true, sessionID}`.

Read/write side effects: `GET` does not start a stopped instance. If no running entry exists it
returns `503 {error, code:"agent_not_running"}`, or a `200` snapshot when a monitor/hydration path is
available. `POST` is an explicit action and calls `manager.ensure` like chat send; if the app is
stopped it may start it.

Errors: `401` unauthenticated, `403` non-human, `404 unknown_app`/`session_not_found` (only when
opencode reports the session missing during hydration or summarize), `409`
`deletion_pending`/`session_busy`/`compact_in_progress`/`model_unavailable`, `502`
`agent_unavailable`, `503` runtime not configured / `agent_not_running`. The routes validate before
`manager.ensure` where possible, use the same `findApp`/`toManagedApp` helpers as chat, and never
expose provider payloads.

Compaction is asynchronous from the HTTP caller's perspective: the manager atomically claims the
session, starts the blocking summarize call in the monitor, and returns `202`. The browser follows
`session.compacted`, `session.error`, and the context snapshot. A POST retry while compacting returns
`409`, not a second summarize.

### D5 - Manual compaction model and state machine

The route resolves the model **after** `manager.ensure` and on-demand hydration. It prefers the
tracker's last-used `providerID`/`modelID` (latest non-summary assistant message) and uses the
effective `llm.model` only when hydration finds no assistant usage at all. This keeps compaction on
the model the session actually used; a stopped app's existing session is hydrated before the choice,
so the effective default cannot override a real session model. Missing/invalid model ->
`409 model_unavailable`. No per-action override is exposed in v1.

If the tracker knows the session is `busy`/`retry`, the route returns `409 session_busy`; if it is
`compacting`, `409 compact_in_progress`. If status is `unknown` (monitor just attached), the route
allows the attempt; opencode itself joins a run if one exists. `compactSession` performs a
synchronous atomic claim before any await, so two concurrent POSTs cannot both start.

Compaction state transitions (one table for manual and auto):

| Event | `state` | Side effects |
| --- | --- | --- |
| trigger claimed | `compacting` | clear `lastError`, set `lastAttemptAt`, abort previous attempt if any (should be impossible) |
| summarize resolves `true` | `ready` | `usage = unknown`, keep model/limit, `lastCompactedAt = now`, `armed = false` for auto |
| summarize rejects / non-2xx | `ready` | `lastError = compaction_failed`, `failureCooldownUntil = now + 5m`, `armed = false` |
| 10-minute timeout | `ready` | abort the summarize request, `lastError = compaction_timeout`, `failureCooldownUntil = now + 5m`, `armed = false` |
| new non-summary usage after `failureCooldownUntil` | unchanged | `armed = true` once, regardless of the hysteresis band (one retry opportunity) |
| `session.compacted` event | `ready` | `usage = unknown`, `lastCompactedAt = now`, clear `compacting`; late events after a timeout are accepted as success but do not re-arm |
| `session.error` while compacting | unchanged | the summarize promise/timeout owns failure; the event only feeds the chat error card |
| `stop()` / instance stop | discarded | abort in-flight request, never reconnect, all promises settled |

A fixed timeout callback runs even if no events arrive. Late `session.compacted` after a timeout
updates `lastCompactedAt` and clears the error but does not trigger another compaction.

### D6 - Auto-compaction policy

Add two live settings:

- `context.auto_compact.enabled` - boolean, default `false`.
- `context.auto_compact.percent` - integer 1..99, default `80`.

Threshold: `used / limit.context * 100 >= percent`.

Evaluation happens on every accepted usage update and on an `idle` transition. A crossing while
busy is remembered and evaluated when the session becomes idle. The monitor triggers the same
`summarize` call as manual compaction, using the same claimed state.

Hysteresis and guards:

- enabled, top-level session, valid limit/percent, effective/last-used model, no in-flight
  compaction;
- `armed` starts true for a session's first observed above-threshold usage (busy or idle); a
  crossing while busy is retained and evaluated on idle. Any trigger (manual or auto) sets it false;
- hysteresis floor: `floor = percent <= 5 ? 1 : percent - 5`; re-arm only when a later observed
  percentage is strictly below `floor`, or when the model/threshold changes. The comparison uses the
  raw unrounded percentage, and tests cover thresholds 1, 5, 6, and 80 so a low threshold is not
  accidentally one-shot. This keeps thresholds of 1-5% usable instead of making them one-shot;
- after a successful compaction whose next observed usage is still at/above the threshold, record
  `auto_compaction_ineffective` in the tracker, keep `armed = false`, and do not retry until usage
  drops below `floor` or the model/threshold changes;
- after a failure, set `failureCooldownUntil = failureAt + 5 minutes`, where `failureAt` is the
  rejection or timeout instant (not `lastAttemptAt`); after the cooldown, the first new non-summary
  usage re-arms `armed = true` regardless of the band (one retry opportunity). A second failure
  repeats the cooldown. This is the only path that bypasses the hysteresis band;
- if an auto attempt is claimed but no endpoint/model can be resolved before the summarize starts,
  set `lastError = compaction_unavailable`, clear `compacting`, and do not start a request. The
  manual route returns `409 model_unavailable` instead and does not set `lastError`;
- a 10-minute hard timeout marks a stuck compaction as failed, aborts the request, sets the same
  cooldown, and clears the flag;
- no trigger for summary-only sessions, child sessions, missing model, or missing limit.

This prevents the "compact -> still above threshold -> compact again every turn" loop. Auto-compaction
applies to top-level sessions of the application, not only the open chat; the settings scope controls
where it applies. Child/subagent sessions are excluded.

### D7 - Settings are live and excluded from the launch hash

Add a `context` group to `EffectiveSettings` with
`autoCompact: { enabled: EffectiveValue<boolean>, percent: EffectiveValue<number> }`.

`settingsHashFor` in `InstanceManager` hashes `launchEffectiveSettings(effective)`, which **omits the
`context` key entirely** (not an empty object) before hashing. The omission must produce exactly the
pre-change object shape so already-applied hashes stay valid after deploy. The same projection is
used inside `settingsHashFor` for both new launches and `pendingRestart`, so a change to a context
key never marks a running agent `settings_changed`. A regression test pins a pre-change effective
shape and asserts its projected hash is unchanged; another asserts that `llm.model` still triggers
`settings_changed`.

`SettingsService.effectiveHash` remains the full effective hash and is documented as a diagnostics/
test value, not a launch signal. If a future caller needs launch semantics, it must use the same
projection.

Both keys are non-clearable (`clearable: false`) so an effective boolean/number always exists; a
narrower scope can still set `false`/another percent to override a wider scope.

The settings UI gets a new `Context` section (making five rendered cards: Agent, Web tools, Context,
Git, Restart) with two server-rendered rows:

- `Auto-compaction` - select `On`/`Off`.
- `Auto-compaction threshold` - number input 1..99, suffix `%`, hint that it is used when
  auto-compaction is on and that opencode's own overflow compaction remains a fallback.

The section participates in the existing live-save fragment protocol. The server's `SECTION_KEYS`,
`settingsSections`, navigation, and the client's `SECTION_IDS` all add `context` in the same phase.
`context.*` mutations return `["context","restart","warnings"]`; other non-Git mutations include
`context` in their changed list. Form values arrive as strings, so `settingValue` converts the new
keys explicitly (booleans and numbers); JSON callers keep native types.

The monitor reads the effective policy through a new narrow
`SettingsService.contextPolicy(target)` (three keys only, no host-auth/provider/git resolution),
cached in the monitor for 5 seconds. This avoids a full settings snapshot on every step.

### D8 - SSE adds one typed frame, no context push channel

Extend the projector with an optional usage mode:
`EventProjector({ includeUsage: true })` adds bounded `usage`, `model`, and `summary` to the existing
`message.updated` event. `createEventStream` accepts the projector/options and the monitor uses
`APP_STREAM_MAX_FRAME_BYTES` (8 MiB), so it sees the same bounded frames as the app stream. The
browser route keeps `includeUsage: false`, so its wire payload does not grow.

Add `{ type: "session.compacted"; sessionID }` to `HanseEvent` and the projector for all consumers.
The client uses it to refresh the context snapshot and show a toast only when the event belongs to the
selected session; a `session.error` for the selected session also triggers a context refresh so a
failed compaction surfaces its fixed `lastError` even when the session never leaves idle.

Context values themselves are fetched over HTTP; there is no new push channel and no per-token
event. The client refreshes the context:

- after session selection/hydration and after creating a session;
- after `stream.ready`, including one retry when the first GET returned `503 agent_not_running`;
- after `session.status` (idle/busy/retry), `session.compacted`, and `session.error`;
- after a manual compaction is accepted, starting the compacting poll immediately even if the first
  snapshot still reads `ready` because of the claim/event race;
- every 2s while the snapshot says `compacting`, stopping after a terminal state (`ready` with
  `lastError`, `compacted`, or the 10-minute window);
- never on message deltas.

Each request captures the requested session ID and is dropped if the current session changed; a
per-session request sequence prevents an older response from overwriting a newer one. The poll timer
is cleared on session switch, draft start, page teardown, and terminal state. This keeps one
authoritative server-side number while avoiding a new streaming protocol.

### D9 - Chat UI

**Thread meta chip.** A compact `Context 62%` chip next to the plan chip in `.chat-thread__meta`,
with a small meter. Clicking it opens the context rail (or scrolls to the section at wide widths).
It is hidden for drafts and when no running instance is known; unknown usage shows `Context —`
(while the rail keeps the last known model/limit) and unknown limit shows `Context 124k`. It is not a
live region; the accessible name includes the exact tokens and model. A new `gauge` icon is added to
the existing icon set.

**Context rail section.** A new section between Application and Plan with its own IDs
(`chat-context-usage`, not reusing `chat-context` which is the rail):

- heading `Context`, summary `62% of 200k` or `124k tokens` when the limit is unknown;
- a horizontal meter (`role="meter"`, `aria-valuemin=0`, `aria-valuemax=100`,
  `aria-valuenow` clamped to 0..100, `aria-valuetext` with the true percent/tokens, and an
  `aria-label`/`aria-labelledby`);
- detail line `124,000 / 200,000 tokens - deepseek/deepseek-flash`;
- auto-compaction line `Auto-compact at 80%` or `Auto-compact off`, with the enabled source
  (`app`/`project`/`global`/`default`), the threshold source in the detail title when it differs,
  and a Settings link;
- `Compact now` button; an inline confirm explains that summarization can lose detail. The button is
  disabled with a visible reason while busy or compacting, or when no model is known. A known limit
  is not required for manual compaction;
- a small error line mapping fixed `lastError` codes to human text after a failed compaction.

The chip and rail are session-scoped. Switching sessions restores the cached snapshot immediately
and refreshes it; a draft clears both. The compact action uses the existing `api()` helper,
`setBusy`-style disabled state, `announce`/`showToast`, and the inline confirm pattern used by saved
permission revocation. No native `confirm()` for this action. Meter transitions honor
`prefers-reduced-motion`.

### D10 - Persistence and restart

No database migration. Settings use the existing key/value table; the tracker is in memory. After a
coordinator restart, `resumeRunning` attaches monitors to still-running instances, and the first
snapshot request hydrates from opencode's message history through the running entry even if the
monitor failed. After an application restart, the monitor is recreated and its provider-limit cache is
re-read. No usage history is retained across a coordinator restart; opencode is the source of truth
for messages.

### D11 - Security and bounds

- Both routes require a human principal; agent tokens get `403`.
- The monitor never logs or returns provider configuration, API keys, prompt text, message content,
  or raw upstream error bodies. Only token counts, model identifiers, limits, status, and fixed error
  codes are kept. `lastError` uses fixed codes, not `OpencodeHttpError.message`.
- Provider responses are capped and parsed defensively; malformed values are ignored.
- Auto-compaction is opt-in and rate-limited (hysteresis, one claim at a time, 5-minute failure
  cooldown, 10-minute timeout) so a misconfiguration cannot create a compaction loop.
- The summarize call uses the endpoint-auth Basic header, never a URL credential.
- The route body is empty; the global 64 KiB body cap applies.
- The tracker's session/message maps are bounded; eviction is by oldest activity.

## 5. Alternatives considered

| Alternative | Why rejected |
| --- | --- |
| Client-only accounting from `step-finish` parts | Token usage is already in the browser, but auto-compaction with no chat open and a server-authoritative indicator both require a server-side tracker. |
| Compute usage on demand from `GET /messages` only | No way to evaluate the threshold while nobody is viewing the session; each poll transfers messages. Kept as lazy hydration. |
| Reuse the per-browser SSE route for accounting | The route is per-request and aborts on disconnect; accounting would stop when the tab closes and duplicate state per tab. |
| Poll opencode messages every N seconds | Unknown which sessions are active, and message transfers are large; events are cheaper and already available. |
| A second raw `SseParser`/projector in the monitor | Duplicates envelope dedupe, identity, idle/status, and part tracking; extending the existing projector with an opt-in usage mode reuses tested behavior. |
| Fetch limits from `/provider` instead of `/config/providers` | `/provider` exposes the whole catalog; `/config/providers` is the configured set the agent can actually use. `/provider` remains a fallback only if the configured catalog lacks a model (not implemented in v1). |
| Disable opencode's built-in auto-compaction | It is the safety net for overflow; Hanse's early threshold should not remove it. Configuring it would also require an agent restart. |
| Store the setting in a new table/endpoint | Duplicates the hierarchical settings resolver, UI, inheritance, and live-save behavior. |
| Make context settings restart-scoped | It would force an agent restart for a UI/coordinator policy that is read live. The hash projection avoids this. |
| Use opencode's `usable` window as the denominator | It hides the actual context window and depends on opencode's reserved-output policy. Raw `limit.context` is easier to explain and still meaningful; the built-in auto remains a fallback. |
| Compact with the effective setting model | It can differ from the model the session actually used after a pending-restart change and can be unauthenticated in the instance. The last-used model is the correct session model; effective is only the empty-session fallback. |

## 6. Impact

- **Settings**: two keys, one new effective group, one new settings section, form-value conversion,
  fragment section list, section IDs, narrow `contextPolicy`, hash projection.
- **Database**: none; migration version stays 11.
- **OpenCode client**: `listProviders` and `summarizeSession` with bounded timeouts; no change to
  existing methods.
- **OpenCode events**: opt-in `includeUsage` projector mode, `session.compacted` event, no change to
  the browser payload.
- **Instance manager**: monitor map/generation, monitor factory, start/stop hooks, `resumeRunning`,
  `contextSnapshot`, `compactSession`, and the launch-hash projection.
- **HTTP**: new context module and two routes, dispatched before the generic chat route.
- **SSE**: one added typed event (`session.compacted`); existing frames and caps unchanged.
- **Chat UI**: chip, rail section, confirm, context fetch/poll, CSS/icon, tests/QA.
- **Docs**: design, plan, journal, `docs/current-state.md`, indexes, open-questions.

## 7. Non-goals

- Replacing or configuring opencode's internal `compaction.*` options.
- Per-message cost/billing displays, provider usage dashboards, or historical charts.
- Compaction of a specific message range or a user-editable summary.
- Persisting usage or compaction history in the coordinator DB.
- Pushing context values over SSE per token or per step.
- Auto-compaction of stopped applications or starting an app to compact it.
- A v2 `/api/session/.../compact` integration in this stage (stubbed upstream).
- Manual compaction of child/subagent sessions from the chat UI (auto-compaction excludes them;
  manual actions only target the selected top-level session).

## 8. Owner questions (resolved autonomously)

The owner delegated all decisions. Recorded decisions:

1. **Default**: auto-compaction off, 80%.
2. **Numerator**: prompt tokens of the latest non-summary assistant step (`input + cache.read +
   cache.write`), not output/reasoning.
3. **Denominator**: raw `limit.context`; unknown limit disables the percentage and auto-trigger.
4. **Scope of auto-compaction**: every top-level session of the app, not only the open chat; child
   sessions excluded.
5. **Manual compaction while busy**: rejected with `409`; unknown status allowed.
6. **Compaction model**: last-used session model, falling back to effective `llm.model`; no
   per-action override.
7. **Settings are live**: excluded from the launch hash; no restart prompt.
8. **API shape**: `GET .../context`, `POST .../compact` returning `202`; human-only.
9. **Tracker persistence**: in-memory, lazy rehydrate, best-effort resume on coordinator start.
10. **UI placement**: chip in the thread meta; full meter/action in the context rail; settings in a
    new `Context` section on the settings pages.
11. **No DB migration** and no new dependency.
12. **Loop prevention**: hysteresis plus an `ineffective` latch; a post-compaction above-threshold
    session is not compacted again until usage drops below the hysteresis band or the policy changes.

## 9. Risks

| Risk | Mitigation |
| --- | --- |
| Background SSE connection leaks or reconnects forever | Abort-driven stop, generation token, `isCurrent()` endpoint/auth check, bounded backoff, bounded maps, lifecycle tests. |
| Monitor duplicates opencode connections/CPU | One extra connection per running app; accepted for v1; a shared hub is a later optimization. |
| Summarize blocks or hangs | 10-minute timeout that aborts the request, atomic claim, hysteresis/cooldown, fixed error codes. |
| Auto-compaction loop | Usable hysteresis floor, `armed` latch, `ineffective` latch, failure cooldown with one retry, one claim, manual/auto shared guard. |
| Threshold triggers at a bad time | Idle-only, top-level-only, one per crossing, compaction-part detection, failure cooldown. |
| Live settings accidentally cause restart prompts | Explicit hash projection that omits `context` entirely, plus pre-change fixture and `llm.model` tests. |
| Provider catalog response is large or changes shape | 4 MiB cap, 10s timeout, defensive parsing, unknown limit fallback. |
| Compaction loses detail | Inline confirmation, manual action only; auto-compaction is opt-in and documented. |
| New context section breaks settings fragment tests | Update section keys/IDs and the settings QA/count assertions in the same phase. |
| Manual compaction with a stale/effective model fails | Prefer the last-used session model; fixed error code; no retry storm. |
| Late compaction event after timeout | Accepted as success for timestamps, never re-arms or starts a second compaction. |
| Race between manual and auto compaction | One synchronous claim in the monitor; both paths call the same `runCompaction`. |

## 10. Verification

- `npm run lint && npm run typecheck && npm test && npm run build`.
- Unit: step-finish vs finish precedence, summary exclusion, compaction reset/boundary hydration,
  child-session exclusion, limit lookup/backoff, hysteresis/armed/ineffective, state-machine
  transitions, fixed error codes, hash projection.
- HTTP: context/compact auth, scoping, busy/compacting, unknown model, upstream errors, session
  not found, deletion pending, GET no-start invariant.
- Lifecycle: monitor starts on ensure, stops on stop/delete/restart/detach, `stopAll` stops before
  reconcile, resume only running instances, per-app lock/generation prevents duplicates, tests can
  disable/inject the monitor.
- SSE: `session.compacted` projection, usage-enabled projector bounded payload, browser payload
  unchanged, 8 MiB frame cap.
- Browser QA: `node docs/design/chat-qa.mjs` with fixtures for ready/unknown/compacting/ineffective/
  error, manual compaction, session-switch race, and the new settings section; screenshots at
  390/768/1440, dark and light.
- Settings: `docs/design/settings-save-qa.mjs` or the chat harness covers a live context save and
  asserts the fragment updates the Context section.
- Live: deploy to `deployment-host`, open a real chat, confirm the chip and context route; run a manual
  compaction on a small session and confirm the summary + `session.compacted`; enable auto-compaction
  at a low threshold on a test app and confirm one trigger and the ineffective latch, then disable it.

## 11. Design review

Round 1 (`oracle`, 2026-10-21): CHANGES REQUESTED. Folded into this revision:

- auto-compaction post-success loop -> hysteresis, `armed`, `ineffective` latch, manual/auto shared
  claim;
- hydration resurrecting pre-compaction usage and stale compaction parts -> compaction-boundary
  hydration, live-only `compacting`;
- lifecycle races -> per-app generation, `isCurrent()`, `resumeRunning` under the app lock, stop
  monitors before `runtime.reconcile`, injectable monitor;
- event ingestion ambiguity -> opt-in usage mode in the existing projector, 8 MiB cap, no second
  parser;
- error leakage -> fixed `lastError` codes;
- state machine -> explicit transition table, atomic claim, timeout/abort/late-event handling;
- contract contradictions -> single `state`, `percent` null invariant, `autoCompact.source`, GET
  no-start, button conditions;
- model/child-session scope -> last-used model, fallback effective, child sessions excluded from
  auto;
- first-snapshot availability -> on-demand hydration in the context service, model/limit retention,
  empty-session fallback;
- UI continuity/a11y -> `Context —` state, clamped `aria-valuenow`, accessible meter name;
- settings fragment wiring -> explicit server/client section lists and changed mapping;
- testability/settings cost -> monitor factory/disable flag, narrow `contextPolicy` with 5s cache;
- client race/poll scope and resume details -> request sequence, poll cleanup, selected-session
  filtering, defined resume input/lock semantics.

Round 2 (`oracle`, 2026-10-21): CHANGES REQUESTED. Folded into revision 3:

- hysteresis/re-arm -> usable floor for 1-5% thresholds, `failureCooldownUntil`, one retry on the
  first new usage after the cooldown, tests for low thresholds and failure-then-new-usage;
- stopped/unhydrated manual compaction -> resolve the model after `ensure` and hydration; effective
  only when no assistant usage exists;
- failure/first-view surfacing -> `session.error` and `stream.ready` refresh triggers, 503 retry,
  immediate compacting poll after `202`;
- parentID safety -> bounded session-list refresh and fail closed for absent/unknown sessions;
- contract clarity -> `compaction_unavailable` meaning, `autoCompact.percentSource`.

Round 3 (`oracle`, 2026-10-21): PASS. The failure-cooldown origin was aligned to the failure
instant and low-threshold tests were added; no remaining blockers.
