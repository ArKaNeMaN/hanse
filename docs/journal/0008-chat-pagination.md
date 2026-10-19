# Stage 0007 - Chat session pagination and in-thread generation indicator

- Date: 2026-10-19
- Status: implemented and verified; not committed (no owner commit instruction)
- Design: [`docs/design/chat-pagination.md`](../design/chat-pagination.md)
- Plan: [`docs/plans/0007-chat-pagination.md`](../plans/0007-chat-pagination.md)
- Gate reviews: `oracle` design review (round 1 CHANGES REQUESTED, round 3 PASS);
  `momus` plan review (OKAY)
- Owner decisions: none open

## Context

Opening a chat fetched the entire upstream session history in one `GET /messages` call and rendered
every message. Moderate sessions therefore paid for the whole transfer, snapshot merge, and DOM
construction before the thread was usable, and idle/reconnect reconcile repeated the full fetch. The
only generation feedback was the small status chip in the thread meta bar.

## Delivered

- `src/opencode/client.ts`: `listMessagePage()` uses the upstream v1 `limit`/`before` cursor,
  returns `nextCursor` from `X-Next-Cursor`, and reuses the 8 MiB/timeout capped read. `listMessages`
  keeps its full-history behavior.
- `src/http/chat.ts` message route: optional `limit` (canonical 1..200) and `before`, validated
  before `manager.ensure`; paged responses are `{messages, nextCursor}`. Upstream 400 → `400
  invalid_cursor`, upstream 404 on a paged GET → `404 session_not_found`; the legacy no-limit
  `{messages}` response is unchanged.
- `assets/chat-core.js`: `applySnapshot(..., {position})` with `replace` (default), `tail`, and
  `older`; ID-keyed, order-aware merge; no duplicate IDs; preserved prefix records sealed; accepted
  server-backed rows preserved in place; empty `tail`/`older` pages are a no-op (an empty tail cannot
  seal a live streaming part). The disjoint reset uses `keepOptimistic:"transient"` so accepted/queued
  history outside the new tail is dropped while local in-flight rows are kept.
- `assets/chat.js`: 30-message tail on open; scroll-up older pages with a 120 px threshold; cursor
  ownership per session; token/session/store-generation guards; disjoint-tail reset to a contiguous
  window; terminal/retryable error matrix; scroll-anchor-preserving prepend; `N+ messages` count;
  loaded older user IDs added to unknown-acceptance matching; decorative in-feed generation row
  driven by the existing status label and elapsed timer.
- Markup/CSS: `#chat-history` above the feed and `#chat-generating` after it, both outside the
  message renderer's cleanup, sharing the desktop feed width; reduced-motion disables the dot pulse.
- Tests: 558 total (up from the prior tree): client paging, route validation/error mapping, merge
  modes, accepted-row preservation, page markup/placement, and duplicate-ID checks.

## Verification

- `npm run lint && npm run typecheck && npm test && npm run build` — all green; **558 tests**.
- `node docs/design/chat-qa.mjs` — PASS: 3 scenarios, 81 assertions, 10 screenshots, zero
  console/page errors. The existing streaming/tool scenarios render the new in-feed row at 1440 and
  390; screenshots inspected, no overflow or overlap introduced.
- The deterministic harness does not drive a paged scroll-up scenario; pagination is covered by the
  pure merge tests, route/client tests, and markup tests, while the visual row is covered by the
  existing QA screenshots.

## Decisions and why

- Use the upstream cursor verbatim instead of a coordinator cursor: no second format, no parsing.
- Merge by ID and current order, never by index alone: live rows, optimistic rows, and duplicated
  pages are all safe.
- A provably disjoint tail resets the window instead of representing a gap: prepending older pages
  cannot fill a middle gap, and the reset is rare (more than one page missed while disconnected).
- Reuse `captureScrollAnchor`/`restoreScrollAnchor` rather than a height delta: throttled markdown
  and hidden-tab deferred flushes re-anchor correctly.
- Keep the in-feed indicator `aria-hidden` and purely visual: the meta chip remains the single live
  announcement source.

## Residual risks

- The loaded window is not virtualized; a very long scroll-back still grows the DOM (documented in
  `docs/current-state.md`).
- A reconcile that lands during an older-page request invalidates that request by store generation;
  the applied page is rendered by the interrupting hydrate when it is preserved, or discarded on a
  disjoint reset. The user may need to nudge the scroll to retry in the rare interrupted case.
- Older-page `messages_too_large` is terminal for paging (the cursor is cleared); there is no
  smaller-page retry.
- Hidden-tab prepends re-anchor through the deferred visibility flush, but a disjoint reset while
  hidden cannot carry its force-bottom intent through that deferred flush.
