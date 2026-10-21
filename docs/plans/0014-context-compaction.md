# Plan 0014: Session context usage, manual compaction, and auto-compaction

- Status: implemented, verified, and deployed as `sha-50acf4f` (journal 0017)
- Design: [`docs/design/context-compaction.md`](../design/context-compaction.md) (oracle PASS after
  three revisions)
- Design reviewer: `oracle` - PASS
- Plan reviewer: `momus`
- Owner decisions: resolved autonomously; see design section 8
- Date: 2026-10-21

## Delivery bindings

| Binding | Value |
| --- | --- |
| Stage | `0014-context-compaction` |
| Design artifact | `docs/design/context-compaction.md` |
| Plan artifact | `docs/plans/0014-context-compaction.md` |
| Design index | `docs/design/README.md` |
| Plan index | `docs/plans/README.md` |
| Journal | `docs/journal/0017-context-compaction.md`; index `docs/journal/README.md` |
| Open questions | none open; record resolved decisions in `docs/open-questions.md` |
| Verification | `npm run lint && npm run typecheck && npm test && npm run build` |
| Browser QA | `node docs/design/chat-qa.mjs` (extend fixtures/scenarios); settings save QA for the Context section |
| Commit policy | one code commit (code+tests+docs+record) plus the allowed docs-only deploy-record commit; autonomous mode may commit and push |
| Deploy | `docs/deploy/README.md` + `docs/deploy/host.md`; deploy after gates |

## Global invariants

- No database migration; schema version stays 11.
- Browser SSE frames and caps stay compatible. `session.compacted` is additive; usage fields on
  `message.updated` exist only in the monitor's opt-in projector mode, so the browser wire payload
  does not grow.
- `GET /api/apps/:app/sessions/:sid/context` never starts a stopped app. `POST .../compact` is an
  explicit action and may `ensure` it.
- `percent` is `null` exactly when `used` or `limit` is null/<=0; otherwise
  `Math.round(used / limit * 100)` and may exceed 100. The UI clamps the meter/`aria-valuenow`.
- `lastError` is one of `compaction_failed`, `compaction_timeout`, `compaction_unavailable`, or null;
  never an upstream body or provider payload.
- Auto-compaction is off by default; when enabled it is idle-only, top-level-only, one claim at a
  time, with the hysteresis floor, failure cooldown (from the failure instant), and `ineffective`
  latch from the design.
- Adding context settings must not change the launch settings hash for any existing app. The
  projection omits the `context` key entirely; `llm.model` changes still produce `settings_changed`.
- All new routes are human-only; agent principals receive `403`.
- No provider configuration, API key, prompt text, message content, or raw upstream error body is
  stored, logged, returned, or written to the DB.
- Existing chat, session, deletion, settings, SSE, IDE, git, SSH, terminal, and handoff behavior is
  unchanged when the feature is disabled or its data is unavailable.
- No new runtime dependency; Node 20+, ESM/NodeNext, `.js` relative imports.

## Shared interfaces (define in phase 1 before parallel work)

```ts
// src/opencode/client.ts
export interface OpencodeModelLimit { context?: number; input?: number; output?: number }
export interface OpencodeProviderModel { id?: string; limit?: OpencodeModelLimit; [key: string]: unknown }
export interface OpencodeProvider { id: string; models: Record<string, OpencodeProviderModel>; [key: string]: unknown }
export interface OpencodeProviders { providers: OpencodeProvider[]; default?: Record<string, string> }

export function listProviders(endpoint: string): Promise<OpencodeProviders>;
export function listSessionsBounded(endpoint: string): Promise<OpencodeSession[]>;
export function summarizeSession(
  endpoint: string,
  sessionId: string,
  model: OpencodeModel,
  options?: { signal?: AbortSignal; timeoutMs?: number },
): Promise<boolean>;

// src/opencode/events.ts
export interface EventProjectorOptions { includeUsage?: boolean }
export interface EventProjector { constructor(options?: EventProjectorOptions) }
export interface EventStreamOptions { includeUsage?: boolean } // forwarded to the projector
// message.updated gains optional bounded usage/model/summary when includeUsage is true
// HanseEvent gains { type: "session.compacted"; sessionID: string }

// src/opencode/context.ts
export interface ContextPolicy {
  enabled: boolean;
  percent: number;
  model: string;
  enabledSource: SettingsScope | "default";
  percentSource: SettingsScope | "default";
}
export interface ContextSnapshot { /* exactly the design D4 JSON */ }
export interface ContextPolicySource {
  contextPolicy(target: SettingsTarget): ContextPolicy;
}
export interface ContextMonitorLike {
  start(): void;
  snapshot(sessionId: string): Promise<ContextSnapshot>;
  compact(sessionId: string): Promise<{ accepted: true }>;
  stop(): void;
}
export class AgentNotRunningError extends Error {
  readonly code = "agent_not_running";
}
```

`InstanceManagerOptions` gains `monitorFactory?` and `enableContextMonitors?`; the enable predicate
is `settings !== undefined && settings.contextPolicy !== undefined && enableContextMonitors !== false`.

## Phase 1 - Upstream client, event usage mode, projector event

Boundaries: `src/opencode/client.ts`, `src/opencode/events.ts`, `test/client.test.ts`,
`test/app-events.test.ts`, `test/opencode-events.test.ts`. No manager/UI work.

Work:

1. `client.ts`:
   - Add the provider types and `listProviders()` for `GET /config/providers` using `getJson` with
     `{ maxBytes: 4 * 1024 * 1024, timeoutMs: 10_000 }`; expose a narrow cache-facing shape
     (`providerID -> modelID -> limit`) rather than handing raw provider options to the tracker.
   - Add `listSessionsBounded()` using `requestResponse`/`readJson` with a 5s timeout and 2 MiB cap;
     keep `listSessions()` unchanged.
   - Add `summarizeSession()` posting `{ providerID, modelID, auto: false }` to
     `/session/:id/summarize`; parse a JSON boolean; support `signal` and a default
     `timeoutMs: 600_000`; map transport/HTTP failures to `OpencodeHttpError`.
2. `events.ts`:
   - Add `EventProjectorOptions.includeUsage` (default false). In `messageUpdated`, when enabled,
     add bounded optional `usage` (`input`, `output`, `reasoning`, `cacheRead`, `cacheWrite`),
     `model` (`providerID`, `modelID`), and `summary` to the event. Keep `MAX_MESSAGE_INFO_BYTES`
     enforcement and omit fields when malformed.
   - Add `session.compacted` to `HanseEvent` and the projector (`sessionID` required; return the
     event plus `session.activity`).
   - Add `EventStreamOptions.includeUsage` and pass it to the internal projector; keep the default
     false. Do not change existing frame shapes.
3. Tests:
   - Client: provider URL/limits parsing, 4 MiB cap, timeout, malformed provider payload, summarize
     body/path/boolean, signal abort, HTTP/transport errors.
   - Events: usage mode adds bounded fields; default mode omits them; `session.compacted` projects
     and dedupes; oversized/malformed usage is omitted; existing projector tests unchanged.

Acceptance:
- `npm run typecheck` and the touched test files pass.
- A browser-mode projector output is byte-identical for existing fixtures.
- Monitor-mode `message.updated` carries the exact usage/model/summary fields.
- `session.compacted` is emitted once per upstream event.

Risks: upstream field names may differ; tests pin the design's verified names and fail loudly.

## Phase 2 - Context tracker, hydration, provider limits, policy

Boundaries: new `src/opencode/context.ts`, `test/context-tracker.test.ts`,
`test/context-policy.test.ts`. No manager or HTTP integration.

Work:

1. Implement pure types/helpers:
   - `promptTokens(tokens)` = `input + cache.read + cache.write` (finite, non-negative).
   - `contextPercent(used, limit)` = null when either is null/<=0, else
     `Math.round((used / limit) * 100)`.
   - `formatContextError(code)` fixed-code mapping.
   - `autoCompactDecision(state, policy)` implementing the design D6: enabled, top-level, idle,
     armed/hysteresis floor, failure cooldown, `ineffective` latch, no model/limit.
2. Implement `ContextTracker`:
   - Session records with usage, model, status, compaction state, message metadata
     (role/summary/model), `armed`, `lastAttemptAt`, `failureCooldownUntil`, `lastCompactedAt`,
     `lastError`, `ineffective`.
   - Apply `message.updated` (usage/model/summary/finish), `message.part.updated` (`step-finish`
     tokens; `compaction` parts mark live compacting), `session.status`, `session.idle`,
     `session.error`, `session.compacted`.
   - Step-finish precedence over message finish; summary exclusion; per-message metadata lookup;
     live-only compaction marking; bounded maps (500 sessions, bounded messages/parts, 24h eviction).
   - Hydration helper: given `OpencodeMessage[]` and `OpencodeSession[]`, find newest non-summary
     usage and newest compaction boundary; if the boundary is newer, usage unknown; derive
     `parentID`; set `lastCompactedAt` where possible.
3. Implement `ProviderLimitCache`:
   - Lookup `providerID/modelID`; fetch `listProviders` once on miss; parse only finite positive
     `limit.context/input/output`; keep successful entries for the monitor lifetime; 60s failure
     backoff; return null on failure (never throw to the tracker).
4. Tests:
   - Tokens: prompt sum, zero/missing/malformed fields, cache read/write, finite guards.
   - Tracker: step-finish before finish, fallback, summary excluded, metadata ordering, compaction
     part live/historical, status transitions, per-session isolation, bounded eviction,
     `session.compacted` resets usage but keeps model/limit, late `session.compacted` after a timeout
     is accepted without re-arming.
   - Hydration: usage after boundary, boundary newer than usage, summary-only, child parentID,
     malformed messages, empty list.
   - Policy: percent 1/5/6/80 floor cases, busy-to-idle crossing, armed latch, failure cooldown
     measured from failure instant, retry after cooldown, ineffective latch, re-arm on model/threshold
     change, disabled/missing limit/missing model/child session, `compaction_unavailable` when no
     endpoint/model can be resolved before a claimed auto attempt.
   - Limits: lookup, cache hit, failure backoff, malformed payload, 4MiB/10s options asserted.

Acceptance:
- Pure tests pass with no network, no timers, no manager.
- The phase 2 test names cover every design D2/D6 invariant, including the `session.compacted`
  reset/keep model/limit, late compacted, re-arm on model/threshold change, failure cooldown from the
  failure instant, and `compaction_unavailable`.
- No provider payload beyond the three numeric limits is retained.

Risks: event ordering differs from fixtures; tests drive the state machine directly and add one
integration fixture from the real projector.

## Phase 3 - Context monitor and InstanceManager lifecycle

Boundaries: `src/opencode/context.ts` (monitor), `src/opencode/manager.ts`,
`src/cli/commands.ts`, `test/context-monitor.test.ts`, `test/context-resume.test.ts`,
`test/manager.test.ts`, `test/image-lifecycle.test.ts`, `test/runtime-manager.test.ts`,
`test/permission-policy.test.ts`. No HTTP routes or UI.

Work:

1. `ContextMonitor`:
   - Constructor: endpoint, projectId/appKey, `isCurrent()`, `settings`, `client` hooks, options
     (`maxFrameBytes`, backoff, timeouts).
   - `start()`: fetch `${endpoint}/event` with `authorizationFor`, consume via `createEventStream`
     with `includeUsage: true` and `APP_STREAM_MAX_FRAME_BYTES`; apply events to the tracker; on
     upstream end/error reconnect with 1s..30s backoff while current and not stopped.
   - `snapshot(sessionId)`: if unknown, hydrate via `listMessagePage(limit 30)` and
     `listSessionsBounded()` using the endpoint/auth; update the tracker; return the D4 JSON with
     `autoCompact` from `contextPolicy`.
   - `compact(sessionId)`: atomic claim; reject `busy`/`retry`/already-compacting; **hydrate the
     session first**, then resolve the last-used model from the tracker, falling back to the effective
     `llm.model` only when hydration finds no assistant usage; validate the model (typed
     `model_unavailable` for manual, `compaction_unavailable` for a claimed auto attempt that has no
     endpoint/model); start `summarizeSession` with a 10-minute timeout and monitor-level abort;
     `void run().catch(...)`; return accepted.
   - `stop()`: synchronous abort of SSE, summarize, timeouts, and timers; set stopped so no
     reconnect/claim; settle detached promises.
   - Auto evaluation after usage/status events; refresh the bounded session list for parentID and
     fail closed; trigger on idle.
2. `InstanceManager`:
   - Add `generation` to the private entry; `#monitors` map and generation counter;
     `monitorFactory`/`enableContextMonitors` options (default on in production; enabled only when
     the injected settings source exposes `contextPolicy`). Every manager fixture that constructs
     without settings must explicitly disable monitors or inject a fake factory.
   - Start monitors after `#running.set` in both `ensure` branches; stop before auth clear in
     `#stopLocked`, before endpoint replacement/stale delete, in `stopAll` before
     `runtime.reconcile([])`, and in `detach`. Idempotent start per app/endpoint/generation.
   - `resumeRunning(apps)`: per-app lock, skip deletion markers, runtime status only, attach entry +
     auth + monitor for running/starting (readable password + matching agent token), never
     `runtime.ensure`.
   - `contextSnapshot(appId, sessionId)` and `compactSession(appId, sessionId)`: use the monitor;
     throw typed `AgentNotRunningError` for GET; `compactSession` requires a running monitor.
3. Wire `serveCommand` through one exported helper
   `resumeContextMonitors(manager, apps)` after `server.listen`. The helper takes a bounded
   non-deleting app list queried from the DB (id/projectId/appKey; cap 200), calls
   `resumeRunning`, and logs sanitized failures. Unit-test the helper with a fake manager; keep
   `serveCommand` to one `void helper(...).catch(logSanitized)` call. The monitor's parentID cache is
   30s and refreshes before an auto trigger (design D2).
4. Tests:
   - Monitor: fake fetch/ReadableStream emits usage/status/compacted; reconnect backoff; stop aborts
     and prevents reconnect; compaction claim contention; timeout/failure/late event; auto trigger
     once; no trigger busy/child/missing limit.
   - Manager: uses a fake monitor factory; start on new/reconnect, stop on stop/delete/restart/detach;
     `stopAll` stops before reconcile; resume only running; no duplicate on repeated ensure;
     generation supersedes old monitor.
   - Manual compaction on a stopped app hydrates first and uses the session's non-effective last-used
     model, falling back to effective only when no assistant usage exists.
   - `resumeContextMonitors` helper: fake manager, app-list cap, sanitized error logging, no throw.
   - The manager fixture without settings disables monitors explicitly; no real network/timer is
     created.

Acceptance:
- No test performs real network calls or leaves timers open.
- A repeated `ensure` does not create a second monitor or reset its tracker.
- `stopAll` never leaves a monitor reconnecting after auth clear.
- The resume helper never throws and skips non-running/deleting apps.

Risks: lifecycle races; mitigated by per-app lock, generation, and fake monitor tests.

## Phase 4 - HTTP context and compact routes

Boundaries: new `src/http/context.ts`, `src/http/server.ts` dispatch,
`src/http/handler.ts` deps if needed, `src/opencode/manager.ts` method error types,
`test/context-http.test.ts`.

Work:

1. New module:
   - `isContextRoute(method, path)` for the two routes.
   - `handleContext(deps, request)`:
     - `GET /api/apps/:app/sessions/:sid/context`: human principal, app lookup (project query),
       manager present; `manager.contextSnapshot`; map `AgentNotRunningError` -> 503
       `agent_not_running`, upstream 404 -> 404 `session_not_found`, deletion -> 409, other -> 502/503.
       No `ensure`.
     - `POST /api/apps/:app/sessions/:sid/compact`: human principal; validate app/session; call
       `manager.ensure`; 409 mapping; `manager.compactSession`; 202 `{accepted:true, sessionID}`;
       map 409 busy/compacting/model, 404, 502.
   - JSON only; no body required; use the existing `json` helper style.
2. Dispatch in `server.ts` before `isChat` (or add to the `isPrompts` family); ensure HEAD/unknown
   methods return 405 and the generic chat route never sees these paths.
3. Tests:
   - Auth: anonymous 401, agent token 403, human 200/202.
   - GET: 503 when not running; does not call `runtime.ensure`; hydration 404; deletion 409;
     unknown app/project scoping; snapshot shape/invariants; percent null/clamp.
   - POST: 202; ensure called; busy/compacting/model 409; upstream/transport 502; session missing 404;
     no body handling; method 405.
   - Every 502/503 JSON body is a fixed message/code and never contains
     `OpencodeHttpError.bodyExcerpt` or provider text (sentinel secret test).
   - Route dispatch unit test proves `/context` and `/compact` do not fall through to `handleChat`.

Acceptance:
- All new route tests pass; existing chat route tests unchanged.
- GET never starts an instance (assert fake runtime ensure calls).
- POST starts only through `manager.ensure` and never compacts twice.

Risks: route regex overlap with chat; explicit dispatch ordering test.

## Phase 5 - Settings: keys, context policy, launch hash, UI section

Boundaries: `src/settings/registry.ts`, `src/settings/types.ts`, `src/settings/service.ts`,
`src/opencode/manager.ts` (hash projection), `src/http/settings.ts`, `assets/settings.js`,
`docs/design/settings-save-qa.mjs`, `test/settings*.test.ts`, `test/manager.test.ts`.

Work:

1. Registry/types:
   - `context.auto_compact.enabled` boolean, default false, non-clearable.
   - `context.auto_compact.percent` integer 1..99, default 80, non-clearable.
   - Add the keys to `SettingsKey`; add `context` to `EffectiveSettings`:
     `autoCompact: { enabled: EffectiveValue<boolean>, percent: EffectiveValue<number> }`.
   - Build the effective group in `SettingsService.#resolve`.
2. `SettingsService.contextPolicy(target)`:
   - Read only `llm.model`, `context.auto_compact.enabled`, `context.auto_compact.percent` through the
     existing resolver rows; return `{ enabled, percent, model, enabledSource, percentSource }`;
     no host-auth/provider/git resolution. Cache only in the monitor (5s).
   - Extend the manager's `SettingsSource` with `contextPolicy?` and update the test fakes
     accordingly; the monitor factory receives that source (do not use a second parallel policy
     source).
3. Launch hash:
   - Define and export `launchEffectiveSettings(effective)` in `src/settings/service.ts`; it omits
     the `context` key entirely. Import it into `src/opencode/manager.ts` and use it in
     `settingsHashFor` for both launch and pending comparison.
   - Keep `SettingsService.effectiveHash` as the full diagnostics hash and document it.
   - Tests: a hardcoded pre-change effective fixture (the shape before the `context` group) hashes to
     the same value; context changes do not mark pending; `llm.model` does. Put the pure projection
     test in `test/settings.test.ts` and the manager `pendingRestart` test in `test/manager.test.ts`.
4. Settings UI:
   - `SECTION_KEYS` add `context`; `SettingsSections` add it; nav/section order Agent, Web tools,
     Context, Git, Restart; `settingsSections` renders a Context card with two rows.
   - `contextControls` renders a boolean select (`On`/`Off`) and a number input (1..99, `%`), hidden
     target, `data-settings-form`, `data-no-busy`, error slot, standard actions.
   - `settingValue` converts `context.*` form strings to boolean/number; JSON callers keep native
     types. Invalid/empty -> validation error.
   - `context.*` mutations return `["context","restart","warnings"]`; other non-Git mutations
     include `context` (so source labels stay fresh). Git mapping unchanged.
   - `assets/settings.js` `SECTION_IDS` add `context`; no other JS needed.
5. Tests:
   - Settings defaults/precedence/validation/clear rejection, contextPolicy sources, hash projection.
   - HTTP page renders five cards including Context, row order/ids, form action/hidden target,
     number/select controls, fragment changed lists, live-save no restart, invalid number 400.
   - settings-asset test for `SECTION_IDS.context` and fragment header.
   - Settings save QA: extend `docs/design/settings-save-qa.mjs` with a Context section save/fragment
     scenario (model row untouched, context rows updated in place, no restart warning).

Acceptance:
- All settings tests pass; existing counts updated intentionally.
- Saving context settings returns the Context fragment and shows no restart warning.
- A pre-change hash fixture remains stable.

Risks: section counts/fragment lists; mitigated by updating server/client in one phase and tests.

## Phase 6 - Chat UI: chip, rail, compact action, polling

Boundaries: `src/http/chat.ts`, `src/http/ui.ts` (gauge icon), `src/http/styles.css`,
`assets/chat.js`, `assets/chat-core.js`, `test/chat-core.test.ts`, `test/chat-page.test.ts`,
`test/app-events.test.ts`, `docs/design/chat-qa.mjs`, `docs/design/artifacts/chat/README.md`.

Work:

1. SSR:
   - Add the `gauge` icon to `ui.ts`.
   - Add `#chat-context-chip` (hidden, `aria-controls="chat-context-usage"`) in
     `.chat-thread__meta` next to the plan chip.
   - Add `#chat-context-usage` section between Application and Plan in the context rail:
     summary, `role="meter"` meter, detail, auto-compact line + settings link, Compact now button,
     inline confirm, error line, loading state.
2. `chat-core.js` pure helpers:
   - `formatTokenCount`, `contextChipLabel`, `contextMeterPercent`, `contextStateClass`,
     `autoCompactText`, `contextErrorText`.
   - Export/import in `chat.js`; tests with snapshots (ready/unknown/limit-less/compacting/error).
3. `chat.js`:
   - DOM refs for chip/meter/detail/auto/action/confirm/error.
   - `contextBySession` Map + request sequence; `refreshContext(sessionId, {force})`; drop stale
     responses; cache snapshot; render cached immediately on switch.
   - Triggers: selectSession/startDraft/ensureSession, `stream.ready` (retry 503 once),
     `session.status`, `session.compacted`, `session.error`, after POST compact, 2s poll while
     compacting, stop on terminal/10min/switch/draft.
   - `session.compacted` handler: refresh context, toast only for the selected session; do not
     disturb background sessions.
   - Compact action: open inline confirm; POST `.../compact`; handle 202/401/403/404/409/502;
     start polling; on success toast/refresh; on failure map fixed `lastError`.
   - Chip click opens the rail (or scrolls) using the existing context toggle helpers; do not reuse
     `id="chat-context"`.
   - Meter: clamp `aria-valuenow` 0..100, `aria-valuetext` true percent/tokens, accessible name.
   - Clear timers on switch/draft/page teardown; no live-region chatter.
4. CSS:
   - Add `.chat-context-chip`, `.chat-context-usage`, meter fill/track, confirm, error, responsive
     rules (chip visible at all widths, compact at 390; rail section existing layout), reduced-motion.
   - Use existing tokens; no new color/size tokens. Run `npm run build:css`.
5. Tests/QA:
   - chat-core helper tests, including `percent > 100` clamped to 100 for the meter while
     `aria-valuetext` keeps the true value, and the accessible name/`aria-labelledby`.
   - chat-page SSR markup/order/ids; app-events `session.compacted`; asset tests for new
     handlers/strings.
   - Extend `docs/design/chat-qa.mjs`:
     - add a **default** context snapshot (and default `POST /compact` response) in `installRoutes`
       before per-scenario overrides, so every existing scenario does not receive the `{}` fallback;
     - add fixtures for ready/unknown/compacting/ineffective/error, manual compact POST,
       session-switch race, and `session.compacted`;
     - screenshots at 390/768/1440 dark and light; update artifacts README.
   - Settings save QA covers the Context section fragment (see phase 5).

Acceptance:
- `npm test` and `npm run build` pass.
- Chat QA exits 0 with zero console/page errors; screenshots inspected.
- No stale context overwrites on rapid session switching; no poll survives a switch.
- Chip/rail show truthful states; compact button disabled only for busy/compacting/no model.

Risks: client state races and layout crowding; mitigated by request sequence, poll cleanup, and
captures at 390/768/1440.

## Phase 7 - Documentation, gates, deploy

Boundaries: `docs/current-state.md`, `README.md`, `docs/design/README.md`,
`docs/plans/README.md`, `docs/journal/README.md`, `docs/journal/0017-context-compaction.md`,
`docs/open-questions.md`.

Work:

1. Update `docs/current-state.md`: chat context indicator, context/compact API, auto-compaction
   settings, monitor/auto behavior, lazy hydration, no DB migration, known limits (one extra SSE
   connection, child-session exclusion, opencode auto may compact first).
2. Update `README.md` feature list (context meter, manual/auto compaction).
3. Update indexes and write journal 0017: context, decisions, files, verification, residual risks.
   The deploy result is appended after deployment (step 7).
4. Record resolved owner decisions in `docs/open-questions.md` for stage `0014`.
5. Run all gates:
   `npm run lint && npm run typecheck && npm test && npm run build`.
6. Browser QA: `node docs/design/chat-qa.mjs`; settings save QA per its runbook.
7. Deploy per `docs/deploy/README.md` / `deployment-host.md`:
   - run all gates and browser QA first;
   - commit code + tests + docs + journal **without** a deploy result, then push and wait for CI to
     publish the `sha-<short>` image to GHCR;
   - archive `HEAD` to `deployment-host`, set `HANSE_TAG=sha-<short>`, `docker compose pull`, restart, health
     checks;
   - live smoke (context GET, manual compact on a small session, auto-compaction at a low threshold
     with the ineffective latch);
   - append the deploy result to the journal and `docs/deploy/deploy-log.md` as the allowed docs-only
     record commit; do not rewrite the code commit.

Acceptance:
- All gates green.
- QA report zero errors; screenshots and report saved.
- Journal/indexes updated before the code commit; the deploy result is appended in the allowed
  docs-only record commit.
- Deploy health checks pass and the live smoke records the context route, one manual compaction, and
  one auto-compaction trigger (or a documented reason the paid compaction smoke was skipped).

## Phase dependencies

`1 -> 2 -> 3 -> 4`; `5` depends on `1` and `2` (settings types/service) and owns the launch-hash
projection; `3` and `5` may be developed in parallel after `2` if the shared interfaces are frozen;
`6` depends on `4` and `5`; `7` depends on all. Do not merge a phase with failing tests.

## Verification commands

```bash
npm run lint
npm run typecheck
npm test
npm run build
node docs/design/chat-qa.mjs
```

`npm test` includes the new tracker/policy/monitor/http/settings/chat tests. No test may be deleted,
skipped, or weakened.

## Risks and mitigations

| Risk | Mitigation |
| --- | --- |
| Monitor lifecycle leaks | Fake monitor factory, generation, stop tests, no real timers in tests. |
| Auto-compaction loop | Hysteresis floor, armed/ineffective latch, failure cooldown from failure instant, one claim. |
| Wrong model on a stopped app | Resolve after ensure + hydration; test a non-effective last-used model. |
| Settings hash drift | Pre-change hash fixture + `llm.model` regression. |
| Browser stale context | Request sequence, session filter, poll cleanup, switch race QA. |
| SSE payload growth | Usage fields only in monitor mode; existing fixture byte assertions. |
| Section/fragment drift | Server and client section lists in one phase; counts/fragment tests. |
| Failure not visible | `session.error` refresh trigger, fixed `lastError` mapping, QA error scenario. |
| Deploy regression | Full gates, chat QA, deployment-host health checks, rollback tag/backup per runbook. |
