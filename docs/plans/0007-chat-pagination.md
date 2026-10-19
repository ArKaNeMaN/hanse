# Plan 0007: Chat session pagination and in-thread generation indicator

- Status: implemented and verified (journal 0008); commit pending
- Design: [`docs/design/chat-pagination.md`](../design/chat-pagination.md)
- Design review: `oracle` round 1 — CHANGES REQUESTED; findings folded into D3-D9; round 3 — PASS
- Plan reviewer: `momus` — OKAY
- Owner decisions: none open (see design section 7)
- Date: 2026-10-19

## Delivery bindings

| Binding | Value |
| --- | --- |
| Stage | `0007-chat-pagination` |
| Design artifact | `docs/design/chat-pagination.md` |
| Plan artifact | `docs/plans/0007-chat-pagination.md` |
| Design index | `docs/design/README.md` |
| Plan index | `docs/plans/README.md` |
| Journal | `docs/journal/0008-chat-pagination.md`; index `docs/journal/README.md` |
| Open questions | none; no `docs/open-questions.md` entry |
| Verification | `npm run lint && npm run typecheck && npm test && npm run build` |
| Browser QA | `node docs/design/chat-qa.mjs` (extend fixtures for pagination if the harness supports it) |
| Commit policy | One coherent stage commit only on explicit owner instruction |

## Global invariants

- The legacy `GET .../messages` JSON shape (`{messages}`) is unchanged when `limit` is absent; the IDE
  extension and any older client keep working.
- A paged response is `{messages, nextCursor}`; `nextCursor` is `string | null`.
- Paged reads are bounded by `1 <= limit <= 200`; invalid values are `400`, never a silent full read.
  Validation runs before `manager.ensure`.
- The upstream cursor is passed through verbatim and URL-encoded; the coordinator never parses or
  re-encodes it.
- `applySnapshot` with no `position` option keeps its current replace semantics.
- The client's loaded window is contiguous. A disjoint tail resets the window; it is never
  represented as a gap.
- Tail hydration never discards records older than the snapshot within the contiguous window; older
  page hydration never discards the newer tail or optimistic rows.
- No ID appears twice in the store order; optimistic rows present in a snapshot are merged, not
  appended twice.
- Scroll position is preserved on prepend; prepends never show "New messages".
- A stale older-page response is discarded by session + request-sequence + store-generation checks.
- The in-feed indicator uses the same status label and elapsed values as the meta chip and is hidden
  for `Ready`, `Waiting for you`, and `Paused`.
- No new runtime dependency; Node 20+, ESM/NodeNext, relative imports with `.js`.
- Existing tests stay green; no test is deleted, skipped, or weakened.

## Phase 1 - Server pagination contract

Boundaries: `src/opencode/client.ts`, `src/http/chat.ts` message route, `test/client.test.ts`,
`test/chat-page.test.ts` (API cases only). No chat client changes.

Work:

1. Add `OpencodeMessagePage { messages: OpencodeMessage[]; nextCursor?: string }` and
   `listMessagePage(endpoint, sessionId, { limit, before?, maxBytes?, timeoutMs? })`.
   - Build `/session/:id/message` with `URLSearchParams` (`limit`, optional `before`).
   - Reuse `requestResponse`, `readCapped`, `MESSAGES_RESPONSE_MAX_BYTES`, and
     `MESSAGES_RESPONSE_TIMEOUT_MS`; keep `messages_too_large`.
   - Read `x-next-cursor` with `response.headers.get` (case-insensitive); return it only when
     non-empty.
2. Keep `listMessages` byte-for-byte behavior and tests.
3. Extend the coordinator route, validating before `manager.ensure`:
   - `limit` absent → legacy `{messages}` full read (no `nextCursor`).
   - `limit` present must be a canonical base-10 integer in `1..200`; otherwise
     `400 {error, code:"invalid_limit"}`. Repeated query keys are already collapsed to the last
     value by `Object.fromEntries` in `src/http/server.ts`; duplicate-key rejection is out of
     scope.
   - `before` present without `limit` → `400 {error, code:"cursor_requires_limit"}`.
   - `before` trimmed must be non-empty; otherwise `400 {error, code:"invalid_cursor"}`.
   - Call `listMessagePage`; return `{messages, nextCursor: page.nextCursor ?? null}`.
   - Map upstream `OpencodeHttpError` with `status === 400` on a `before` request to
     `400 {error, code:"invalid_cursor"}`. Map upstream `404` on a paged GET to
     `404 {error, code:"session_not_found"}`. Keep the existing `502` shaping for other cases.
4. Tests:
   - client: query string contains encoded `limit`/`before`; header populates `nextCursor`; absent
     header yields `undefined`; `messages_too_large` still throws with the code; the 8 MiB/timeout
     options are exercised.
   - HTTP: `?limit=30` returns `nextCursor`; `?limit=30&before=<opaque>` forwards the cursor
     unchanged and encoded; `limit=0`, `201`, `-1`, `1.5`, `abc`, empty → 400; `before` without
     limit → 400; no `limit` returns the legacy body; upstream 400 → 400 `invalid_cursor`;
     upstream 404 on a paged GET → 404 `session_not_found`; upstream 502 keeps its shape; an
     invalid request does not start the agent.

Acceptance criteria:
- All new tests pass; existing messages-route tests unchanged.
- A request without `limit` produces the same upstream URL as today.
- No coordinator code parses the cursor value.

Risks: upstream versions older than the pinned one may not return the header. Mitigation: absence
means "no more pages", which degrades to the current one-page behavior, never a broken thread.

## Phase 2 - Snapshot merge core

Boundaries: `assets/chat-core.js`, `test/chat-core.test.ts`. No `assets/chat.js` changes.

Work:

1. Add an optional `position: "replace" | "tail" | "older"` to `applySnapshot` (default `replace`).
2. Factor the merge so the default path is behaviorally identical.
3. `tail` (caller has verified overlap or no server window):
   - Find the first snapshot ID present in the current order; preserve current non-optimistic records
     before it as the older prefix, de-duplicated by ID.
   - Append the snapshot order.
   - Append current non-optimistic records after the anchor that are not in the snapshot (transient
     newer live rows), de-duplicated.
   - Merge **transient local** rows (`local_`/sending/unknown/failed) by ID; append only rows absent
     from the snapshot; preserve accepted/queued server-backed rows in place; no duplicate order IDs.
   - Seal preserved prefix records (text/reasoning/patch/file/subtask sealed; tool parts by status);
     keep suffix state. An empty tail snapshot is a no-op that preserves the window, sealing, pending
     deltas, and cursor.
4. `older`:
   - Prepend snapshot order; append current records not in the page; keep transient local rows at the
     end; no duplicate order IDs.
   - Empty page is a no-op.
5. Sealing: normal snapshot sealing for snapshot IDs; preserved records keep their state except the
   tail prefix rule above. `openParts` filtering works across the merged order.
6. Queue/active derivation runs on the merged chronological order.
7. Tests:
   - `tail` keeps the older prefix and merges updated snapshot parts.
   - `tail` keeps transient newer live records and optimistic rows without duplication.
   - `tail` seals a preserved previously-open text part.
   - `older` prepends without duplicating overlapping IDs and keeps tail sealing.
   - `older` with an empty page leaves order/messages intact.
   - `replace` still matches the existing tests.

Acceptance criteria:
- `npm test -- test/chat-core.test.ts` passes.
- Existing `applySnapshot` tests need no behavioral edits.

Risks: upstream timestamp ties can reorder records. Mitigation: merge by ID and current order, never
by index alone; duplicates are ignored.

## Phase 3 - Client integration and generation indicator

Boundaries: `assets/chat.js`, `src/http/chat.ts` markup, `src/http/styles.css`,
`test/chat-page.test.ts` (page/DOM cases), `docs/design/chat-qa.mjs` only if needed.

Work:

1. Page constants and URL helper:
   - `MESSAGES_PAGE_SIZE = 30`, `HISTORY_SCROLL_THRESHOLD_PX = 120`.
   - `messagesUrl(id, { limit, before })` appends `limit`/`before` with `URLSearchParams`.
2. History state:
- Add `historyCursor`, `historyLoaded` to `sessionRuntime` save/adopt and the partial runtime
   entries created by `applyAgentStatus` (default to `null`/`false`); `resetFeedDom` hides the
   history/generating rows. The in-flight marker is per-session via its token, not a global boolean.
   - On initial tail response, set both. On tail reconcile, apply `position:"tail"` only when an
     overlap exists (or no server window). Keep the existing cursor when the merge preserved an
     older prefix or `historyLoaded` is true; take the tail cursor only when no prefix was preserved
     and no older page has been loaded.
   - On a disjoint non-empty tail, apply `replace`, set `historyLoaded=false`, take the tail cursor,
     and force the view to the bottom; increment `historyRequestSeq`. An empty tail with a non-empty
     window is a failed reconcile: keep the window and cursor.
3. Older-page load:
   - `loadOlderMessages()` guards `sessionId`, cursor, in-flight state, and captures
     session/request-sequence/store-generation.
   - Fetch with the current cursor; apply only if the session, sequence, generation, and starting
     cursor still match; otherwise discard.
   - Apply `position:"older"`; set `historyLoaded=true`; set the cursor from `nextCursor`.
   - Implement the D6 outcome matrix: empty/null cursor ends; duplicate-only pages auto-continue at
     most 3 times; 400 clears the cursor; 404 `session_not_found` stops and calls `refreshSessions`;
     502 keeps the cursor for a scroll retry; `messages_too_large` stops.
   - The in-flight marker is a token `{session, requestSeq, storeGeneration}`; `finally` clears it
     only when that token is still current.
4. Scroll behavior:
   - Passive scroll listener with rAF throttle; trigger at `scrollTop <= 120`.
   - `flushFrame` gains `prepend`: capture a forced anchor (even at bottom), render, restore it,
     never force bottom, never show "New messages"; keep the flag across hidden-tab deferred flushes.
5. History row:
   - Add `#chat-history` above `#chat-messages` inside `#chat-scroll` with spinner
     `Loading earlier messages...` and a terminal error label. It is outside `#chat-messages`, so
     the renderer's non-message cleanup does not touch it.
6. In-feed indicator:
   - Add `#chat-generating` after `#chat-messages` inside `#chat-scroll`, `aria-hidden="true"` with
     dots, `#chat-generating-label`, `#chat-generating-elapsed`.
   - `renderElapsed()` updates both elapsed elements; `updateWorkingStatus()` toggles the row with
     the same label rules, hides it for `Ready`/`Waiting for you`/`Paused`, and does not early-return
     when the meta chip is missing.
7. Count and unknown acceptance:
   - Show `N+ messages` while `historyCursor !== null`; `N messages` when the beginning is reached.
   - When a page loads, add its user IDs to any pending acceptance state for the active session (or
     make the matcher reject records older than the send start).
8. CSS:
   - `.chat-history` and `.chat-generating` join the `>=1024` feed width rule.
   - Dots use a staggered opacity/transform animation; `prefers-reduced-motion` disables it.
   - Use existing tokens; no new colors.
9. Tests:
   - Page HTML contains `chat-history` and `chat-generating`; the generating row is `aria-hidden`.
   - Existing chat-page assertions for the composer/thread still pass.
   - Add pure/merge tests for the disjoint/overlap decisions where feasible; use the browser harness
     for scroll/no-jump/no-new-messages if it can deterministically drive a paged fixture.

Acceptance criteria:
- Opening a session requests `limit=30` and renders only the returned tail.
- Scrolling to the top requests `before=<cursor>` and prepends without a visible jump or "New
  messages".
- A reconnect/idle reconcile while older pages are loaded leaves them in place; a disjoint tail
  resets to a contiguous window.
- A session switch during an in-flight older-page request does not mutate the new session.
- The in-feed row appears for `Thinking`/`Working`/`Running <tool>` and disappears on `Ready`.
- `node docs/design/chat-qa.mjs` still passes.

Risks:
- `flushFrame` currently treats any count increase while not at bottom as "new messages"; the
  prepend option must cover the button and the bottom pin.
- Async markdown rendering can change height after the prepend flush; the existing element anchor is
  re-applied on the next throttled frame.
- A hidden tab defers flushes; the prepend anchor and suppression flag must survive until the
  visibility flush.

## Phase 4 - Verification and record

Work:

1. Run `npm run lint && npm run typecheck && npm test && npm run build`.
2. Run `node docs/design/chat-qa.mjs`; inspect screenshots for the new rows at 1440 and 390.
3. Update `docs/current-state.md`:
   - Chat opens a 30-message tail and loads older pages on scroll-up.
   - In-feed generation indicator.
   - Adjust the "renders every item" limitation to "paged DOM, not virtualized".
4. Add `docs/journal/0008-chat-pagination.md`; update `docs/journal/README.md`,
   `docs/design/README.md`, and `docs/plans/README.md`.
5. Report verification output; do not commit unless the owner asks.

Acceptance criteria:
- All four gates green; browser QA green.
- Docs match behavior; no stale "full session fetch" claim remains.

## Verification result

- `npm run lint && npm run typecheck && npm test && npm run build` — all green; **558 tests**.
- `node docs/design/chat-qa.mjs` — PASS: 3 scenarios, 81 assertions, 10 screenshots, zero
  console/page errors. The existing streaming/tool scenarios show the in-feed row at 1440 and 390;
  screenshots inspected with no new overflow or overlap.
- The harness has no deterministic paged-scroll scenario. Pagination behavior is covered by the
  merge tests (`test/chat-core.test.ts`), route/client tests (`test/chat-page.test.ts`,
  `test/client.test.ts`), and markup tests; the visual row is covered by the existing screenshots.

## Execution deviations

- The repeated-query-key rejection from the first design was removed: `Object.fromEntries` in
  `src/http/server.ts` collapses duplicate keys before the handler, so the requirement was not
  implementable without widening `HttpRequest`. The design now states this explicitly.
- The merge modes distinguish transient local rows (`local_`, sending/unknown/failed) from
  server-backed accepted/queued rows, so accepted history is preserved in chronological position
  rather than appended at the end.
- Older-page `messages_too_large` is terminal (cursor cleared, no smaller-page retry).
