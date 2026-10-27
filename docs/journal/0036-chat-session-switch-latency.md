# 0036 - Chat session switch latency and cancellation

Status: implemented and verified; committed and pushed.
Date: 2026-10-27.

## Problem

Selecting a session in the chat rail did not switch the visible thread immediately. The old thread
stayed active while the client awaited a draft write, then the thread cleared and showed no messages
for a second latency window. Rapid clicks could leave the UI on the wrong session because overlapping
selections had no latest-wins guard.

## Profiling

- Direct `opencode` reads are fast: `GET /session` returned the session list in 6-22 ms (21 KB) and
  `GET /session/:sid/message?limit=30` returned 30-message tails of 215 KB-1.4 MB in 11-87 ms once
  warm (a cold 505 KB read took about 0.5 s). The upstream is not the primary delay.
- Every coordinator read of sessions or messages called `InstanceManager.ensure()`. Even when the
  container was already running, `ensure` serialized on the per-app lock and performed a
  `runtime.status` round-trip (runner -> Docker inspect), filesystem reads/mkdirs, DB marker/token/
  collision queries, and a pending-send lookup. On the reconnect or cold path it runs the full start
  path instead of reusing the endpoint.
- A session switch fans out `GET /messages`, `GET /sessions`, and `GET /todo`; all three entered the
  same per-app lock and repeated the runtime inspection.
- Client-side, `selectSession()` awaited `flushDraftForSwitch()` before assigning `sessionId`. That
  call always PUT the previous draft (even when unchanged) and waited on the serialized draft-write
  chain. Only after that did the rail/title/URL change and the skeleton appear.
- `GET /messages` also reserves the full 192 MiB history budget for every page (30 messages included)
  and projects attachments with per-message DB reads, but this is CPU/DB work after the upstream
  response, not the startup/lock delay observed on click.

## What shipped

- `assets/chat.js`: `selectSession()` now assigns the selected session, updates the rail/title/URL,
  resets the feed, and shows the message skeleton before any network wait. The previous draft is
  flushed in the background; an unchanged draft is not re-PUT. Messages and the target draft load in
  parallel.
- A selection generation plus `AbortController`s abort the previous message/history/draft/todo reads
  when another session is selected; stale hydration cannot repaint a newer selection. `startDraft()`
  cancels the same in-flight reads.
- `refreshSessions()` is latest-wins and refuses to apply a stale session list that omits a session
  selected while the request was in flight.
- `src/http/chat.ts`: `GET /sessions` and `GET /messages` attach to an already running agent with
  `manager.endpointFor()` and fall back to `ensure()` only when there is no attached endpoint or the
  endpoint fails at the transport level (one retry). Pending-deletion markers still return `409`.
- `src/http/prompts.ts`: `GET` prompts, saved permissions, and Todo routes use the same attached-
  endpoint fast path (writes still call `ensure`).
- Tests cover the no-`ensure` read path, the no-endpoint fallback, the transport-failure fallback, the
  Todo fast path, and the client's switch-before-flush/loading-placeholder invariants.

## Verification

- `npm run typecheck` - pass.
- `npm run lint` - pass.
- `npm run check:sensitive` - pass.
- `npx vitest run test/chat-page.test.ts test/prompts-http.test.ts` - 113 tests pass.
- Full suite has two environment-related exceptions documented in 0035: the default 5 s timeout is
  flaky under the app container's load, and the managed `GIT_*`/`HANSE_CREDENTIALS_DIR` environment
  changes the `git-service` expected `core.sshCommand`. Run it with that environment removed and a
  larger timeout.

## Residual risks

- The server still calls `ensure()` (with its runtime status round-trip) for sends, creates, deletes,
  compaction, and event-stream attach; only the read routes listed above use the attached endpoint.
- Aborting the browser request does not cancel the coordinator's upstream `opencode` read; the
  client ignores the result via the generation guard, but the server may finish the read.
- `refreshSessions()` remains a polling refresh; a stale list is now ignored, but there is no realtime
  session lifecycle feed.
