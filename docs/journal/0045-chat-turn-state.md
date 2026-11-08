# Journal 0045 - Truthful chat turn state

Stage: `0038-chat-turn-state` (design [`docs/design/chat-turn-state.md`](../design/chat-turn-state.md),
plan [`docs/plans/0038-chat-turn-state.md`](../plans/0038-chat-turn-state.md)).
Date: 2026-11-08.

## Context

The owner reported a persistent in-feed "...Working" row after an agent finished a turn, cleared only
by a reload or a session change. The row was a client-side derivation over optimistic rows, a
30-message tail, and ephemeral `session.status` events; any mismatch produced a false or missing turn.
The owner asked to close the whole class, not the single label.

## What changed

- **Server.** `src/chat/turn.ts` adds pure `deriveTurn()`; `GET /api/apps/:app/sessions/:sid/turn`
  is human-only, non-starting, and read-only. It uses the same message projector as `/messages`,
  projects handoffs, pages past the boundary (3 x 50 with `queuedTruncated`), reads a strict status map
  (a malformed 200 is a 502, not idle), retries status -> history -> status once and sets `settling`
  on a persistent idle inconsistency, and resolves subagents via a bounded `listSessionsBounded`.
  A 250-500 ms single-flight snapshot cache is invalidated by an accepted send. T13:
  `turnContinues`, `runningPromptID` (busy && !turnContinues), `activePromptID` (running when busy,
  head when idle). T11/T16: handoff/OMO/hidden-synthetic/resume exclusions, a resume prompt consumes
  its interrupted prompt, attachment-only rows count, and an absent subagent status is `unknown`.
- **Client.** `ui/chat/turn-state.ts` holds the turn slice and a coalescing fetch with
  `requestEpoch`/`liveRevision`/`stale`/`hidden`; it hydrates on open, ready, reconnect/gap,
  visibility, every reconcile, status transitions, session errors, pause/limit, send acceptance, and
  dialog open. Precedence is `abort-settle > sse > snapshot`. `chat-feed` projects the server turn to
  status/queue/`optimistic` state; rows carry `origin:"server"|"local"` and a client-only row never
  drives the row, count, or `Queued` chip. The client `deriveQueue` row/queue path and the
  queue-promotion block (plus its `sessionStorage` mirror) are retired. The composer has a bounded
  `sending -> unknown` timeout and a late-202 rekey. The stream adapter is the sole SSE identity
  owner; the dead reducer duplicate/gap path is removed.
- **UI.** The queue strip is deleted. A polite thread turn-status live region renders the label and a
  `N queued` button (`Ready · N queued`, `N+` when truncated); the queue dialog is a native modal with
  focus trap/restore, empty/failed states, and an active running row.
- **Tests and docs.** Parity markers, the e2e fake-upstream status synchronization/reset, the SPA
  browser-QA `turn-status` scenario, `current-state.md`, the design/plan/journal indexes, and the
  stage documents.

## Supersessions

- **chat-mobile-polish §D6**: the client queue-promotion block is retired.
- **chat-pagination §D7**: the idle-with-queue row (`Ready · N queued`) and the turn-status live region
  supersede "the row is hidden for Ready" and "the meta chip is the only announcement source".
  `Waiting for you` and `Paused` remain out of the row (dock/meta and connection chip).

## Decisions

- Idle with a server queue renders `Ready · N queued`; the display count includes an idle head and
  excludes a running prompt (T13).
- Status/history race: status -> history -> status, one retry, `settling` suppresses the queued row
  for one reconcile.
- A subagent absent from `/session/status` is `unknown`, never idle.
- Multi-tab consistency is best-effort; each tab hydrates on its own transitions.
- No database/schema change and no app SSE event-set change.

## Verification

- Design: `oracle` Round 1 **BLOCK** (Option A), Round 2 **PASS WITH FIXES**; all
  B1-B4/S1-S19/N1-N10 folded.
- Plan: `momus` **OKAY**; R1-R10 folded.
- `npm run lint`, `npm run typecheck`, `npm run typecheck:ui`, `npm run typecheck:e2e` green.
- `npm test`: 240 files, **3562 tests passed**.
- `npm run build`, `npm run check:ui` (79 SFCs, sentinel), `npm run check:sensitive` green.
- `npm run test:e2e`: **130 passed, 1 skipped**.
- `CHAT_QA_MODE=spa CHAT_QA_ONLY=turn-status node docs/design/chat-qa.mjs`: **PASS**, 23 assertions,
  1 screenshot, zero console/page errors.

## Open threads

- The full SPA browser QA still stops at the documented pre-existing `main` feed/composer width
  assertion (501 vs 568); `main`/`send` still use legacy selectors. The Phase C gate used the exact
  `CHAT_QA_ONLY=turn-status` set.
- A push `turn.updated`/`stream.ready` status frame is a future optimization; pull hydration covers the
  missed-idle case.
- The pure client `deriveQueue` remains only for parity tests; a follow-up can remove it entirely.
- No commit was made; the owner has not authorized one.
