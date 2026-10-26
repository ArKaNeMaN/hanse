# Journal 0034 - Live context updates on each agent step

Status: **implemented and verified** (2026-10-26). Owner-directed revision 4 of the context stage;
no new plan, because it changes the delivery of the existing snapshot rather than the accounting
model.
Design: [`docs/design/context-compaction.md`](../design/context-compaction.md), D8 revision 4.

## Context

Context usage was already live on the server: the monitor applied every `step-finish` to the
tracker, and `GET /api/apps/:app/sessions/:sid/context` returned the refreshed snapshot. The chat
client only fetched that snapshot on session selection, `stream.ready`, status transitions,
compaction events, and abort. During a busy turn the chip and meter therefore stayed at the value
from the turn's start, and a session's first turn showed `Context —` until it went idle.

The fix had to ride the existing chat event stream: one HTTP request per step would add transport
and latency for a number that already exists server-side.

## What shipped

- **Monitor callback** in `src/opencode/context.ts`: after the tracker applies a `step-finish`,
  `onContextUpdate` receives the refreshed `ContextSnapshot`; a usage-changing assistant
  `message.updated` that completes a step-finish arriving before its model metadata also emits, so
  the first step is not lost. If the provider limit is not known yet, the monitor resolves it once
  (coalesced by the existing limit cache) before the first frame; until then the client shows tokens
  without a percentage.
- **Fan-out** in `src/opencode/manager.ts`: `subscribeContext(appId, listener)` keeps per-app
  listeners; a listener failure is isolated and cannot affect other streams or the monitor. The
  callback is wired into every monitor start, including coordinator resume.
- **Existing stream carries the frame**: `GET /api/apps/:app/events` writes
  `{ type: "context.updated"; sessionID; context }` on the same SSE connection and sequence as chat
  events. The route unsubscribes on close. No new route, no provider call, and no HTTP request per
  step; the frame is the authoritative tracker snapshot (cache accounting, summary exclusion,
  limit/percent, status, compaction fields).
- **Client** in `assets/chat.js`: caches the pushed snapshot per session and renders it only when it
  belongs to the selected session. The existing HTTP refresh list is unchanged as the initial and
  fallback path (monitors disabled, browser attaching mid-step, reconnect, compaction polling).
- **Docs**: design D8 revision 4; `docs/current-state.md` context bullet and typed-frame list.
- **Tests**: monitor callback and limit composition; manager fan-out and unsubscribe; app-events
  frame push and unsubscribe; client source assertion; deterministic `context-live` QA scenario.

## Decisions

- **Server snapshot frame, not client-side token math.** The browser payload only grows by one
  bounded snapshot per step, and the displayed number is exactly the server snapshot used by the
  fallback GET. Duplicating the cache/summary/limit rules in JavaScript was rejected.
- **Step granularity is the maximum available freshness.** opencode publishes token usage at step
  boundaries, so one frame per `step-finish` is the contract; there is no per-token event and no
  polling while busy.
- **Fallback stays.** A monitor-less deployment or a browser that attaches between steps still gets
  the snapshot over HTTP, so the indicator degrades to the previous behavior rather than breaking.

## Verification

- `npm run lint`, `npm run typecheck`, `npm run build`: green.
- Targeted suites: `test/context-monitor.test.ts`, `test/manager.test.ts`,
  `test/app-events.test.ts`, `test/chat-page.test.ts`: 236 tests green.
- Full `npm test`: 2478/2481. The failures are environment-only or load-only and unrelated to this
  change: `test/git-service.test.ts` expects this host's global Git SSH wrapper to be absent;
  `test/skills-store.test.ts` (two cases) timed out under full-suite load and passes alone; earlier
  full runs also saw `test/mcp-http.test.ts` and `test/handoff.test.ts` time out under load and pass
  alone.
- Browser QA: `CHAT_QA_ONLY=context-live node docs/design/chat-qa.mjs` PASS (4 assertions, zero
  console/page errors, `docs/design/artifacts/chat/context-live-1440-dark.png`). The scenario pushes
  a `context.updated` frame over the fake EventSource and asserts the chip/rail move from 62% to 75%
  without a new context GET.
- The existing `context-switch-race` scenario timed out when run alone in this environment; the
  failure reproduces with the unmodified `assets/chat.js`, so it is not caused by this revision.

## Accepted limits

- No live update for a single long step until it reaches `step-finish`; that is the upstream
  granularity, not a client timer.
- The frame is app-wide like the rest of the stream; the client filters by session, so child
  sessions and other sessions do not affect the visible chip.
- A browser that connects while a step is already running waits for the next step, the next status
  transition, or the initial snapshot refresh.
