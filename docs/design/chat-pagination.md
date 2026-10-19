# Design - Chat session pagination and in-thread generation indicator

Status: **implemented and verified** (2026-10-19). Design review: `oracle` round 1 CHANGES
REQUESTED (findings folded), round 3 PASS. Plan: `docs/plans/0007-chat-pagination.md`; journal:
`docs/journal/0008-chat-pagination.md`.
Scope: the chat workspace (`assets/chat.js`, `assets/chat-core.js`, `src/http/styles.css`),
the chat page markup (`src/http/chat.ts`), and the message-list API/client
(`src/opencode/client.ts`).
Out of scope: implementation in this document.

## 1. Problem

Opening a chat currently fetches the **entire** upstream message history in one
`GET /session/:sid/message` call and renders every message into the DOM. Even moderate sessions
therefore spend time on the JSON transfer, snapshot merge, and DOM construction before the thread is
usable. The idle/reconnect reconcile repeats the same full fetch.

Separately, the only generation feedback is the small status chip in the thread meta bar. While the
user reads the conversation, the fact that the agent is still producing an answer is not visible in
the conversation itself.

## 2. Requirements

| ID | Requirement |
| --- | --- |
| P1 | Opening a session loads only a bounded tail page of messages; the thread becomes interactive without reading the whole session. |
| P2 | Scrolling to the top of the thread loads the previous page of older messages, repeatedly, until the beginning of the session. |
| P3 | Prepending older messages preserves the visible scroll position (no jump) and does not show the "New messages" affordance. |
| P4 | Live SSE updates, idle/reconnect reconcile, optimistic sends, queue derivation, and turn sealing keep working against a partially loaded history; reconcile must not drop already loaded older pages unless the history is provably disjoint. |
| P5 | The existing `GET .../messages` contract without pagination parameters keeps working unchanged (other clients, including the IDE extension). |
| P6 | While a turn is being generated, the thread shows an in-feed indicator (animated label + elapsed time) near the end of the conversation, mirroring the existing truthful status model. |
| P7 | The indicator is decorative for assistive technology (the existing status live region remains the single announcement source) and honors `prefers-reduced-motion`. |
| P8 | No regression in session switching, drafts, deletion, questions/permissions, the plan panel, saved permissions, OMO cards, tables, tool streaming, or the 8 MiB oversize guard. |

## 3. Upstream facts (opencode 1.19.3, verified)

- `GET /session/:sessionID/message` accepts `limit` (integer >= 0) and `before` (opaque cursor).
  `before` requires `limit`. `limit` omitted or `0` returns the full history.
- Without `before`, a limited request returns the **newest** `limit` messages in chronological
  order. With `before`, it returns the page immediately **older** than the cursor, also in
  chronological order.
- When more older messages exist, the response carries `X-Next-Cursor` and a `Link: <...>;
  rel="next"` header; otherwise neither header is present. The body has no cursor field.
- The v1 SDK types omit `before`, but the server and OpenAPI accept it; the coordinator talks raw
  HTTP, so this is not a blocker.
- `GET /session/:sessionID/message/:messageID` exists but is not needed for this feature.

## 4. Decisions

### D1 - Extend the coordinator message route additively with a cursor

`GET /api/apps/:app/sessions/:sid/messages` accepts optional `limit` and `before`.

- Validation happens **before** `manager.ensure`, so a bad request never starts an agent.
- `limit` is a canonical base-10 integer in `1..200` (defensive coordinator cap; upstream has no
  practical cap). Empty, non-canonical, fractional, or out-of-range values are rejected. Repeated
  query keys collapse to the last value before the handler (`Object.fromEntries` in
  `src/http/server.ts`), so duplicate-key rejection is not part of this contract.
- `before` is accepted only together with `limit`; it is trimmed and must be non-empty.
- With `limit`, the response becomes `{ messages, nextCursor }`, where `nextCursor` is the upstream
  `X-Next-Cursor` or `null`.
- Without `limit`, the route keeps the legacy full-history response `{ messages }`.
- Invalid `limit` → `400 {code:"invalid_limit"}`; `before` without `limit` →
  `400 {code:"cursor_requires_limit"}`; upstream `400` for a malformed cursor → `400
  {code:"invalid_cursor"}`; upstream `404` on a paged GET → `404 {code:"session_not_found"}`.
- The cursor is never parsed or re-encoded; it is passed through `URLSearchParams` so opaque
  characters are encoded correctly.

Rationale: the cursor is upstream-owned; re-encoding it in the coordinator would add a second
cursor format and break if upstream changes it. The page size cap prevents an accidental
full-history request through the new path.

Rejected: coordinator-side slicing of the full upstream list. It still transfers and parses the
whole session, which is the cost we are removing.

### D2 - One page size for the tail and for scroll-back

The client requests `30` messages for the initial tail and `30` for each older page. Upstream
messages are coarse (one user + one assistant message per turn, parts inside), so 30 is several
turns; larger values defeat the purpose, smaller values make scroll-back chatty. The constant lives
in `assets/chat.js`; the API stays caller-controlled.

### D3 - ID-keyed, overlap-aware snapshots

`applySnapshot` gains an explicit `position` option:

- `replace` (default, legacy): current behavior.
- `tail`: merge a newer snapshot into the loaded window.
- `older`: prepend an older page to the loaded window.

The merge is **ID-keyed and order-aware**. The current window is a contiguous range; the client
never assumes it can append a disjoint newer range.

`tail` applies only when at least one snapshot ID is already in the current server-loaded window, or
when there is no server-loaded window yet:

1. Preserve existing non-optimistic records that occur before the first snapshot ID in current
   order (the older prefix), de-duplicated by ID.
2. Apply the snapshot in its own order.
3. Keep any non-optimistic current records that occur after that anchor and are not in the snapshot
   (these are transient live records newer than the response; they stay at the end).
4. Adopt/merge **transient local** rows (`local_`, `sending`, `unknown`, `failed`) by ID and append
   only rows that are not present in the snapshot. Server-backed `accepted`/`queued` rows are
   normal history: they are preserved in the prefix/suffix by ID, not appended at the end. No ID
   appears twice in `order`.

Sealing is recomputed for snapshot records. Preserved prefix records are older than the newest
snapshot message and are therefore sealed (text/reasoning/patch/file/subtask = sealed; tool parts
follow their status) so a previously streaming record cannot stay unsealed forever. Preserved
suffix records (transient live) keep their state.

`older`:

1. Prepend the page in its own order.
2. Append the current records that are not in the page, in current order, de-duplicated by ID.
3. Keep transient local rows (`local_`, `sending`, `unknown`, `failed`) at the end; accepted/queued
   server-backed rows are preserved in their current position. No ID appears twice.
4. An empty page is a no-op.
5. Page records are sealed by the normal snapshot sealing; preserved current records keep state.

**Disjoint-tail policy.** If the current window has server records, the tail snapshot is
**non-empty**, and it shares **no** ID with the window, the ranges are disjoint (the client missed
more than a page while disconnected). The store is reset to the tail snapshot (`replace` semantics,
optimistic rows kept), `historyLoaded` becomes false, and `historyCursor` is taken from the tail
response. This is the only case where already loaded history is dropped; re-deriving a contiguous
window is cheaper and safer than representing a gap. Server-backed `accepted`/`queued` rows that are
outside the tail are dropped with it; only truly local in-flight rows (`local_`, `sending`, `unknown`,
`failed`) are kept at the end. The client forces the view to the bottom on this rare reset so the user
is not left looking at a removed range.

An empty tail snapshot with a non-empty current window is a failed reconcile, not a disjoint tail:
keep the window and cursor unchanged (the next reconcile retries).

Rejected: keeping disjoint ranges, or filling the gap only on scroll-up. A gap in the middle cannot
be repaired by prepending older pages; it needs a separate backfill protocol and a second cursor.

### D4 - Cursor ownership, reset, and concurrency

The client keeps `historyCursor` (fetches messages older than the oldest loaded server message) and
`historyLoaded` (whether at least one older page has been loaded) per session, stored in
`sessionRuntime` alongside the existing thread state and reset for drafts.

- Initial load sets `historyCursor` from the tail response.
- A tail reconcile keeps the existing cursor when the merge preserved an older prefix **or**
  `historyLoaded` is true. It takes the tail response's cursor only when no prefix was preserved and
  no older page has been loaded. This keeps the cursor older than the merged window's oldest message
  (a preserved prefix makes the tail cursor point inside the window).
- A disjoint-tail reset sets `historyLoaded=false` and takes the new cursor from the tail.
- A successful older-page load sets `historyCursor` to that page's `nextCursor`; `null` means the
  beginning of the session.

Concurrency:

- `historyRequestSeq` increments on `selectSession`, `startDraft`, and every disjoint-tail reset.
  `loadOlderMessages` captures the target session, `historyRequestSeq`, and `store.generation`
  before the request. After the await it applies only if all three still match; otherwise the
  response is discarded.
- The older-page request is also a compare-and-set on the cursor: it applies only if the
  `historyCursor` it started from still equals the current cursor. This prevents a stale page from
  advancing the cursor after a reconcile/reset.
- The in-flight marker is a token `{session, requestSeq, storeGeneration}`, not a bare boolean. A
  `finally` clears it only when that exact token is still current, so a stale request cannot clear
  the marker of a newer session or request.

### D5 - Scroll loading reuses the existing anchor machinery

A passive `scroll` listener on `#chat-scroll` with a `requestAnimationFrame` throttle triggers
`loadOlderMessages()` when `scrollTop <= 120`, a cursor exists, and no load is in flight.

`flushFrame` gains a `prepend` option:

- It captures a scroll anchor even when the container is at the bottom (`captureScrollAnchor` gets a
  force mode) and restores it after rendering, so the visible content stays fixed while older nodes
  are inserted above.
- It never forces the bottom and never shows the "New messages" affordance for a prepend.
- The existing element anchor (rather than a one-shot `scrollHeight` delta) is used so that
  throttled markdown re-renders and the hidden-tab `flushPending` path re-anchor correctly. A
  prepend while the tab is hidden is applied to the store immediately and rendered by the existing
  visibility-change flush; the `prepend` suppression flag survives until that flush runs.
- If the anchor node was removed (disjoint reset), no adjustment is made.

The loading row sits **above** `#chat-messages` inside `#chat-scroll`; it is not a message and is not
removed by the message renderer. It shows `Loading earlier messages...` while a request is in
flight and a short error label for terminal failures. It is hidden when idle and on session switch.

Rejected: `IntersectionObserver` sentinel. The thread already owns a scroll container and already
listens for scroll to hide "New messages"; one throttle path is simpler and testable.

### D6 - Older-page outcome matrix

The loader is explicit about terminal states; it never retries forever and never stays in flight.

| Outcome | Action |
| --- | --- |
| Page with new IDs, `nextCursor` non-null | Merge; set cursor to `nextCursor`; hide the row. |
| Empty page, or `nextCursor: null` | Mark the beginning; cursor `null`; hide the row. |
| Page containing only IDs already loaded (and a cursor) | Advance the cursor; auto-fetch the next page at most 3 times for this trigger, then stop and hide the row. |
| `400 invalid_cursor` | Clear the cursor, stop paging, show `Earlier messages unavailable.`; no auto-retry. |
| `404 session_not_found` | Stop paging, clear the cursor, hide the row, and call `refreshSessions()` so the existing selection flow switches or returns to the draft. |
| `502`/timeout/transport | Keep the cursor, clear the in-flight flag, show `Earlier messages unavailable - scroll to retry.`; retry only on a new scroll trigger. |
| `messages_too_large` | Keep the feed, stop paging, clear the cursor, show `Earlier messages are too large to load.`; no retry loop. |
| Session switch / stale generation | Discard; do not touch the new session's state. |

### D7 - In-feed generation indicator mirrors the existing status model

A `#chat-generating` row lives after `#chat-messages` inside `#chat-scroll`. It shows three animated
dots, the current `activeStatusLabel()` (`Sending`, `Thinking`, `Working`, `Running <tool>`,
`Retrying`), and the existing elapsed text. It is hidden for `Ready`, `Waiting for you`, and
`Paused`. `updateWorkingStatus()` owns both the meta chip and the in-feed row so they cannot drift;
it must not early-return when the meta chip is absent.

`renderElapsed()` updates both elapsed elements (meta chip and in-feed row). The in-feed row is
`aria-hidden="true"` and uses no `role=status`, no duplicate IDs, and no live region: the meta
chip's status remains the single announcement source. The row is reset/hidden in `resetFeedDom` and
when the draft starts. Its animation stops under `prefers-reduced-motion: reduce`.

Rejected: a blinking caret appended to the last text part. It requires tracking which part is the
live tail across snapshots and tool parts, and it does not answer "is the agent still working"
when the agent is thinking or running a tool.

### D8 - Keep the oversize guard honest

Paged requests are normally far below the 8 MiB response cap. The paged client reuses
`MESSAGES_RESPONSE_MAX_BYTES` and `MESSAGES_RESPONSE_TIMEOUT_MS` through
`requestResponse`/`readCapped`; it must not use the 1 MiB default JSON path. The existing
`messages_too_large` fallback remains for legacy and pathological pages: the client keeps its last
feed and shows the existing notice. Paging does not add a second "session too large" path.

### D9 - Loaded-count and unknown-acceptance accuracy

- The message counter shows the loaded count with a `+` while an older cursor exists
  (`30+ messages`), so a partial window is not presented as the session total.
- `loadOlderMessages` adds the loaded user IDs to any pending unknown-acceptance state for the
  active session, or the acceptance matcher restricts itself to messages created after the send
  started, so an older identical prompt cannot falsely resolve an `unknown` send.

## 5. Impact

- `src/opencode/client.ts`: new paged read function; `listMessages` unchanged.
- `src/http/chat.ts`: optional `limit`/`before` handling and `nextCursor` in the JSON response.
- `assets/chat-core.js`: `applySnapshot` `position` modes and overlap-aware merge.
- `assets/chat.js`: page size, history cursor state, `loadOlderMessages`, `flushFrame` prepend mode,
  scroll listener, count label, in-feed indicator wiring.
- `src/http/chat.ts` markup + `src/http/styles.css`: `#chat-history`, `#chat-generating`, CSS.
- Tests: `test/client.test.ts`, `test/chat-page.test.ts`, `test/chat-core.test.ts`.
- Docs: `docs/current-state.md`, `docs/journal/0008-chat-pagination.md`.

No database, schema, auth, or permission changes.

## 6. Non-goals

- Virtualizing the message list or capping the number of messages held in memory.
- Per-message/part pagination; a page is a whole-message page.
- Gap backfill when more than one tail page was missed; the disjoint-tail reset covers it.
- Changing the SSE protocol or reconcile cadence.
- Server-side caching of message pages.
- Removing the legacy full-history route or the IDE extension's behavior.

## 7. Open questions

None. Page size, indicator placement, cursor ownership, and disjoint-tail reset follow from the
requirements above; no owner fork remains.
