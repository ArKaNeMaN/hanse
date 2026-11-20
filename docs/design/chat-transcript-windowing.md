# Design - Chat transcript windowing and lazy detail bodies

Status: **implemented and verified** (journal 0064) - Oracle round 1 and focused round 2 returned
PASS WITH FIXES; all findings are folded below. Owner decisions are closed (2026-11-20); no open
question remains. Not deployed.

Scope: the SPA chat transcript (`/chat`) - the list in `ChatThread.vue`, the detail bodies of
`ChatWorkGroup.vue`, `ToolPart.vue`, `ReasoningPart.vue`, and the file/subtask `<details>` in
`ChatMessage.vue`, plus the in-memory scroll/detail/height cache.

Out of scope: the server message model, pagination protocol, SSE protocol, Markdown renderer,
diff/highlight budgets, the session rail, the context rail, the notice-group body, and the retired
legacy chat client.

Governing context: [`chat-pagination.md`](./chat-pagination.md) (30-message tail and cursor),
[`chat-diff-highlighting.md`](./chat-diff-highlighting.md) (lazy highlight worker),
[`docs/current-state.md`](../current-state.md), and [`docs/process.md`](../process.md).

---

## 1. Problem

A long chat session can freeze the tab or trigger the browser's "kill page" prompt. The current
transcript is a single eagerly rendered list; after messages are loaded, nothing ever leaves the
DOM.

Evidence:

- `ChatThread.vue:735-749` renders `v-for` over every loaded `ChatThreadItem`. History paging
  (`ChatPage.vue:1458-1468`, 30-message tail plus `before`) reduces the initial page only; every
  older page is prepended and kept forever (`assets/chat-core.js:1964-1990`).
- Native `<details>` hides content visually but keeps it mounted. `ChatWorkGroup.vue:11-29` always
  renders `.chat-work-group__body`; the only `v-if` there selects the part type. The group test
  asserts reasoning/tool rows exist while `details.open === false`
  (`test/ui/chat-work-group-row.test.ts:43-65`).
- `ToolPart.vue:330-426` is another `<details>` whose body is selected by `bodyKind`, not by
  `open`; `ReasoningPart.vue:55-63` always renders its `<pre>`; `ChatMessage.vue:231-245` always
  renders the file/subtask `<pre>`.
- Tool diff/read/write views build their full line DOM at mount through `mountToolView`
  (`DiffView.vue:32-46`, `assets/chat-highlight.js:211-239`, `293-320`, `355-395`), even while the
  enclosing details is closed. Only the Prism worker is open-gated
  (`assets/chat-highlight.js:997-1011`).
- Every SSE token bumps `revision` (`ui/stores/chat-feed.ts:117-119`), which rebuilds every
  message/part view (`ChatPage.vue:1982-2057`) and patches every rendered row. With a large loaded
  history this is a continuous O(loaded) cost on top of the retained DOM.

Grouping alone does not help: it is visual only. The fix has two independent parts - stop holding
collapsed bodies in the DOM, and bound the rendered row count.

An existing harness already exercises the worst case: `E2E_CHAT_PERF_SESSION_ID` seeds 500 messages
(`e2e/support/seed.ts:376-398`) and `e2e/spa-chat.spec.ts:905-951` loads them, records chunk/heap
metrics, and currently asserts all 500 are rendered. That test becomes the primary before/after
evidence.

## 2. Requirements

| ID | Requirement |
| --- | --- |
| W1 | With a long loaded transcript, the number of rendered transcript rows is bounded and does not grow with the number of loaded messages. |
| W2 | The rendered window keeps at least two viewport heights of overscan above and below the visible area. |
| W3 | Scroll position stays stable when rows are mounted/unmounted, older pages are prepended, the viewport resizes, and the thread is pinned to the bottom. |
| W4 | A collapsed detail body is not in the DOM: work group, tool call, reasoning, file/subtask. Expanding mounts it; collapsing unmounts it. |
| W5 | Detail expansion state is remembered while the user scrolls a row out of the window and back, and across session switches within one SPA session. |
| W6 | Below the window activation threshold, the transcript renders the same rows with no spacers and no extra rows. Lazy detail bodies (W4) apply to every session, including small ones. |
| W7 | Streaming, unseen counting, follow-bottom, load-earlier, focus retention, and keyboard interaction keep working. |
| W8 | A focused control is never unmounted while it holds focus. |
| W9 | No server, API, schema, or dependency change; the work is UI-only. |
| W10 | In jsdom or any layout-less environment the transcript renders all rows (deterministic tests, no silent empty thread). |
| W11 | The loaded message count remains observable independently of the rendered row count, so tests and QA can page history without counting DOM rows. |

## 3. Decisions

### D1 - Lazy detail bodies are opt-in per component, with remembered state

Each detail body is mounted only while its details is open:

- `ChatWorkGroup.vue`: add a controlled `open` ref, `:open="open"`, `@toggle`, and
  `v-if="open"` on `.chat-work-group__body`. Initialize to `hasError || remembered`; a later
  `hasError` forces open.
- `ToolPart.vue`: reuse its existing `open` ref, initialize to `hasError || remembered`, keep the
  error auto-open, and put `v-if="open"` around the body branches (`DiffView`/`ReadView`/
  `WriteView`/todo/bash/structured/pre/truncation notice).
- `ReasoningPart.vue`: add an `open` ref initialized to `remembered`, `:open`, `@toggle`, and
  `v-if="open"` on the `<pre>`. The summary elapsed timer keeps running.
- `ChatMessage.vue`: the file/subtask `<details>` becomes controlled: `:open="isDetailOpen(part.id)"`;
  the `<pre>` is rendered only while open; the toggle writes the same memory. The current local
  `openDetails` set remains the reactive presentation; the scope memory is read on mount/remount.

Error precedence is uniform: `open = hasError || remembered`, plus the existing false-to-true error
watch. A remembered closed state never suppresses a current error.

`ChatNoticeGroupRow.vue` keeps `v-show` (light text rows, 50 notices max); `ChatQuestionCard` is an
active prompt and stays visible; Markdown text bodies are the visible message and stay mounted.

The toggle handler is the single normal-path writer; error auto-open and programmatic open also
write the memory so a remount matches. Collapsing unmounts the body, which also tears down a
`DiffView`'s highlight controller (`DiffView.vue:24-30`, `58`) and stops its line DOM from being
retained.

### D2 - Detail memory reaches leaf components through a provided scope

`ChatThread` already owns `sessionId`, so it provides a scope-bound interface:

```ts
interface TranscriptDetailScope {
  isOpen(id: string): boolean | undefined;
  setOpen(id: string, open: boolean): void;
}
```

Leaf components inject it with a no-op fallback, so isolated component tests keep working without
Pinia or a session. The implementation lives in `ui/chat/transcript-memory.ts` and is keyed by the
existing `scrollMemoryKey(workspaceKey, sessionId)`.

### D3 - Windowing lives in `ChatThread`, not in the page or the store

`ChatPage.vue` keeps building the full `threadItems` list; the store keeps every loaded message.
`ChatThread.vue` receives the full list and decides which items to render. This keeps grouping,
paging, SSE, and the page's projection untouched, and keeps the window logic testable at the same
boundary where scrolling already lives.

The window is a contiguous `[start, end)` slice of `props.items`. Non-item content (history row,
error/stopped panels, approvals, generating row) stays outside the window exactly as today.

### D4 - Activation threshold is conservative and measured

Windowing activates only when the transcript is genuinely large:

- `items.length > 60`, or
- the measured content height (including gaps) is greater than `8 * clientHeight`.

The height threshold is evaluated only after the first measurement pass and uses measured heights
only; it never latches on fallback estimates. The count threshold may latch immediately (a count
that high is already a large list). Once active, the window stays active for that
`ChatThread` instance/session until the session changes; collapsing details does not flip the mode
off and remount the whole thread.

Ordinary sessions therefore keep their current row DOM. The 30- and 35-message E2E fixtures stay
below the count threshold; at typical row heights they also stay below `8` viewports.

The first render after mount or a session change always runs with windowing disabled, so the initial
scroll restore can use the mounted DOM. After that restore settles and the first measurement pass
completes, the thresholds are evaluated and the window may latch. A remount of an already long
session therefore pays one full mount (the current behavior) and then drops to the bounded window.

In jsdom, `clientHeight` is 0 and the height threshold is unavailable, so only the count threshold
can activate windowing; `computeWindow` still returns the full range when `viewportHeight <= 0`
(W10). Tests that want real windowing stub layout and the row observer.

### D5 - Coordinates, gap-aware pads, and the window algorithm

The transcript is a flex column with `gap: var(--space-5)` = 20px
(`src/http/styles.css:2310-2316`). A spacer that replaces hidden items must reproduce both their
heights and the gaps between them.

Definitions:

- `G` - row gap in px, read once from `getComputedStyle` (`rowGap`/`gap`), default 20; the same
  numeric value is used for inline margins, never a second CSS source.
- `h[i]` - item `i`'s measured border-box height, or the fallback when unmeasured.
- `P[i]` - `sum(h[0..i-1])`, the height prefix.
- `runTop` - the scroll-content coordinate of the first item's top in the full layout. It includes
  scroll padding and any non-item children before the items (history row, error/stopped panels). It
  is measured in the scroll/layout pass and stored in a ref (initial 0), never read from the DOM
  inside a computed:
  `runTop = (firstRenderedRowRect.top - scrollRect.top) + scrollTopRef - (P[start] + G * start)`.
  It is re-measured when non-item content above the items changes (history row, panels).
- `localScrollTop = scrollTopRef - runTopRef`.

Pads for a rendered `[start, end)` window:

- `topPad = P[start] + G * start`;
- `bottomPad = (P[n] - P[end]) + G * (n - 1 - end)`.

Render the top spacer only when `topPad > 0`, with inline `height: topPad` and inline
`margin-block-end: -G px`. The negative margin cancels the flex gap between the spacer and the first
rendered row, so the first rendered row starts at `runTop + topPad` exactly.

Render the bottom spacer only when `bottomPad > 0`, with inline `height: bottomPad` and **no
negative margin**. The flex gap before it accounts for the gap after the last rendered row; the pad
formula already excludes that boundary gap. Given the fallback rule, any hidden item contributes at
least the fallback height, so `bottomPad > 0` whenever `end < n`. This pair is the invariant:

```
topPad + sum(h[start..end-1]) + G * (end - start - 1) + G + bottomPad
  = P[n] + G * (n - 1)
```

for every `0 <= start < end <= n`, with the `+G` boundary term omitted when `bottomPad === 0`.
The pure module must be tested against this identity.

Spacers are `aria-hidden="true"`, `flex: none`, `inline-size: 100%`, `pointer-events: none`.

Fallback height: the average measured row height, clamped to `80..480`, default `160`. Unmeasured
rows above the viewport are only an estimate until they mount.

Pure module `ui/chat/transcript-window.ts`:

```ts
export interface TranscriptWindowInput {
  readonly heights: readonly number[]; // aligned to items; 0 = unmeasured
  readonly fallbackHeight: number;
  readonly gap: number;
  readonly localScrollTop: number;
  readonly viewportHeight: number;
  readonly overscan: number; // two viewport heights
  readonly pinned: boolean;
  readonly keepAlive: readonly number[]; // bounded by the caller
  readonly revealIndex?: number; // one-shot restore anchor, may be far away
  readonly enabled: boolean;
}

export interface TranscriptWindow {
  readonly start: number;
  readonly end: number;
  readonly topPad: number;
  readonly bottomPad: number;
}
```

Behavior:

- `enabled === false`, `n === 0`, or `viewportHeight <= 0` -> full range, zero pads.
- Prefix sums use `h[i] > 0 ? h[i] : fallbackHeight`.
- Pinned: `end = n`; `start` is the smallest index whose remaining window
  `P[n] - P[start] + G * (n - 1 - start)` fits `viewportHeight + overscan`. Clamp
  `start <= n - 1` so a single row taller than the viewport still renders one row.
- Not pinned: `start` is the first item intersecting `localScrollTop - overscan`; `end` is the
  last item intersecting `localScrollTop + viewportHeight + overscan`, plus one.
- Expand `start`/`end` to include every keep-alive index the caller passes, then clamp.
- `revealIndex` is a one-shot unbounded include used only by restore; the caller clears it after the
  restore settles. It is separate from the bounded focus `keepAlive`.
- Pads use the formulas above.
- Binary search over the prefix array. The prefix build is O(n) numeric work and may run on each
  items projection; it is cheap relative to DOM work and is recorded by the perf test. Pruning and
  row-registry maintenance are gated on structural changes (D8), not on every revision.

Two viewport heights of overscan is the owner decision.

### D6 - Anchors use mounted DOM geometry; the model is only a fallback

The current `captureAnchor`/`restoreAnchor` scan all `[data-message-id]` nodes and read
`offsetTop` (`ChatThread.vue:282-326`). That is O(all rows) and cannot work when most rows are not
mounted.

New anchor shape:

```ts
interface ChatScrollAnchor extends ChatScrollMemory {
  readonly key?: string; // threadItemKey
  readonly visualOffset?: number; // row rect top - scroll rect top
  readonly messageID?: string; // legacy fallback
  readonly messageOffset?: number;
}
```

- **Capture:** find the first rendered item whose bottom is below the viewport top; store its
  `threadItemKey` and `visualOffset = rowRect.top - scrollRect.top`. The rect difference includes
  padding, the history row, and any preceding panel, so no separate origin term is needed. If no
  item is mounted, fall back to the legacy `messageID`/`messageOffset` or the current
  `scrollTop`/`scrollHeight`.
- **Restore:** the key path runs first; the old `scrollHeight` delta rule is only a fallback when
  the key is gone.
  - If the key is mounted, set `scrollTop += (rowRect.top - scrollRect.top) - visualOffset`. This
    is exact regardless of measured/estimated heights or a changed run origin.
  - If the key is not mounted, use the model: `scrollTop = runTop + P[i] + G * i - visualOffset`,
    then `await nextTick()`; if the window now includes the key, correct once with the DOM rect.
- **Reveal before paint:** restoring or shifting the window is a two-phase operation:
  1. set the reactive `scrollTop` and `revealIndex` (the anchor's index) so the window includes the
     anchor;
  2. `await nextTick()`;
  3. settle with DOM rects (or the model when unmounted), clear `revealIndex`.
  If settling changes `scrollTop`, update the reactive input and repeat once.
- **Programmatic scrolls are reactive:** `scrollTop`, `viewportHeight`, and `pinned` are refs.
  `onScroll`, `scrollToBottom`, `restoreAnchor`, height corrections, and `onViewportResize` all
  update them synchronously. `onViewportResize` sets `viewportHeight`/`lastClientHeight` and
  re-settles before the pinned bottom scroll. The window is computed from these refs, never by
  reading `node.scrollTop` inside a computed. This prevents a frame that paints a stale or blank
  slice after a programmatic jump.
- **Persistence:** `persist()` writes `scrollTop`, `scrollHeight`, and, when windowing is active,
  the last captured `key`/`visualOffset`. The `persist(previous)` call in the session-change
  watcher (`ChatThread.vue:401-403`) is removed: the last scroll write already captured the
  outgoing position, and the post-flush call would otherwise read the new session's DOM under the
  old scope. Content changes that move the position without a scroll persist through
  `scrollToBottom`/`restoreAnchor`.
- `ui/chat/scroll-memory.ts` gains optional `key`/`visualOffset`. To avoid a module cycle,
  `scrollMemoryKey` moves to a small `ui/chat/view-scope.ts` shared by `scroll-memory` and
  `transcript-memory`; `clearScrollMemory()` calls `clearTranscriptMemory()` in one direction so
  tests do not leak heights or open state.

### D7 - Row measurement is one observer over mounted rows, with a baseline

- A cached ref setter per `threadItemKey` registers the row root (normalized through `$el` when it
  is a component instance) and unregisters on `null`. The setter is stored in a `Map`, so a
  streaming patch does not call `null`/register on every token.
- One `ResizeObserver` observes registered roots. On resize, read the border-box height from either
  `entry.borderBoxSize` shape:
  `const box = Array.isArray(entry.borderBoxSize) ? entry.borderBoxSize[0] : entry.borderBoxSize;`
  `const height = box?.blockSize ?? target.offsetHeight;`. Never fall back to
  `contentRect.height` (content-box, excludes padding/border). Ignore changes below 0.5px.
- The baseline for the first measurement of a row is its cached height, else the exact effective
  height that the prefix build used when it last laid the row out (store the fallback snapshot for
  that build, not a recomputed average). A newly mounted overscan row above the viewport can
  therefore be corrected by `measured - baseline` instead of jumping by the full measured height.
- If one or more changed rows sit fully above the viewport and the reader is not pinned, batch
  their deltas in one rAF and adjust `scrollTop` once. Suppress the resulting synthetic
  `load-earlier` trigger during this correction.
- If the reader is pinned, schedule a bottom scroll in the same rAF after measurement.
- The existing viewport `ResizeObserver` (`ChatThread.vue:374-381`) stays for composer/window
  resizes; it updates `viewportHeight` and re-settles. The row observer is separate.
- Unmounted rows keep their last measured height. On remount, the cached height is the baseline;
  the row is measured again and the delta corrected.
- The focus check runs synchronously in the scroll/window-update path before the new slice commits
  (D9); a post-render watcher would be too late.

### D8 - Detail and height memory is in-memory, per session, and pruned safely

New `ui/chat/transcript-memory.ts`:

- scope key = `scrollMemoryKey(workspaceKey, sessionId)`;
- `heights: Map<threadItemKey, number>` per scope; `details: Map<detailId, boolean>` per scope;
- read/write helpers, `pruneHeights(scope, liveKeys)`, `clearTranscriptMemory(scope?)`.

The cache is view state only: no `localStorage`, no database, no route parameter. It survives route
unmount/remount within one SPA session; a hard reload starts empty.

Eviction never removes a key present in the live item set. `pruneHeights` runs when the item key
sequence structurally changes (item count changes, session change, or an explicit structural
signal), not on every SSE revision; a same-count regrouping may leave stale entries until the next
structural prune, bounded by the cap, and stale entries do not affect live layout. Building the
live-key set per token is forbidden. Height and detail caps are safety nets for removed keys only
(5000 heights, 2000 details); access refreshes insertion order (delete then set), so hot tail rows
are not evicted while old removed keys are. A detail eviction for a loaded key would change the row
height and cause a jump, so the live-key guard applies to details as well; the caller passes the
live detail ids it knows.

On session change, the component resets its local index and loads the new scope's heights in a
pre-flush watcher (or derives the local index from `sessionId`) so the first render after the
switch does not use the previous scope or pure fallbacks. It then prunes to the new live keys and
restores scroll. The old session's data stays under its own scope.

### D9 - Focus keep-alive is bounded

Unmounting a row that contains `document.activeElement` would drop focus. The thread tracks
`focusin`/`focusout` on the scroll container with `relatedTarget` containment and keeps only the
focused row's index.

The keep-alive set is bounded to indices within the visible window plus one overscan on each side.
If the focused row would leave that range, the thread first moves focus to the scroll container
(`tabindex="-1"`) or the nearest visible row summary, then drops the keep-alive and unmounts. This
check runs synchronously in the scroll/window-update path before the new slice is committed; a
post-render watcher would already have unmounted the row. This preserves focus without expanding
the window across thousands of rows.

Keyboard tab traversal beyond the rendered window is an accepted virtualization limitation; it is
recorded with the screen-reader limitation. Focus retention itself is guaranteed.

### D10 - Failure and fallback behavior

- `ResizeObserver` missing, `clientHeight <= 0`, or windowing disabled -> full render, no spacers.
- Unknown heights -> fallback estimate; pinned mode always anchors to the tail.
- Anchor key missing -> the key-less delta fallback, then the model estimate if needed.
- Session change -> reset local window/height index/keep-alive; reload the new scope's memory.
- jsdom with the count threshold active still returns the full range because `viewportHeight <= 0`.

### D11 - Test and evidence strategy

Pure:

- `test/ui/chat-transcript-window.test.ts`: the pad identity in D5 for `[0,n)`, a middle window, and
  a tail window; two-viewport overscan; pinned tail; single-row-taller-than-viewport clamp;
  keep-alive expansion; one-shot `revealIndex`; unknown heights; disabled mode; zero viewport.
- `test/ui/chat-transcript-memory.test.ts`: scope isolation, live-key pruning, LRU refresh, clears.

Component:

- `ChatWorkGroup`: closed body absent; open mounts; close unmounts; remembered after remount; error
  wins over remembered closed.
- `ToolPart`: closed body absent; open renders diff/read/write/pre; collapse tears down the view;
  error wins; remembered.
- `ReasoningPart`: closed body absent; summary/elapsed still work; remembered.
- `ChatMessage`: file/subtask body absent until opened; remembered after remount.
- `ChatThread`: 500 items render a bounded number of `[data-thread-key]` rows; scrolling changes the
  window; the pad identity holds in the DOM; prepend/remount anchor; bottom pin; viewport resize;
  bounded focus keep-alive; jsdom full render; streaming 20 deltas does not re-register rows.

Regression updates:

- `test/ui/chat-scroll.test.ts` and `test/ui/chat-perf.test.ts`: replace "all 500 nodes exist" with
  "bounded window exists and the loaded count is preserved". The 30/35 paging tests stay below the
  activation threshold.
- `test/ui/chat-tools.test.ts` and `test/ui/chat-message.test.ts`: open details before asserting
  body content; add closed-body absence assertions.
- `test/ui/chat-work-group-row.test.ts`: invert the closed-body expectation.
- `test/ui/chat-highlight-teardown.test.ts` or `chat-diff-view.test.ts`: assert collapse triggers
  highlight teardown.
- `e2e/spa-chat.spec.ts:905-951`: page by the exposed loaded count, not by rendered rows; assert the
  rendered row count stays bounded and the 500-message heap metric is recorded.

Browser/QA:

- Existing Playwright chat specs keep their 30/35-row counts.
- One deterministic long-thread run (`ses_e2eperf`): 500 loaded messages; assert bounded rendered
  rows, stable scroll on window shifts and prepend, correct expansion after leaving/re-entering the
  window, and no focus loss.
- A QA pass with many remembered-open diffs, scrolling away and back, to check remount cost.
- A remount/reload check: the first render after a route return or session switch mounts all rows
  once, restores the anchor, then latches the window; assert no jump between the restore and the
  latch.
- Manual QA on a local test state with a test token: 300+ messages, large diffs/outputs, streaming,
  scroll up/down, load earlier, expand/collapse, focus a button then scroll away and back. Record
  DOM node count and heap before/after. Never use deployment secrets or real project data.

Acceptance:

- With 500 loaded messages, the rendered row count is bounded by the viewport/row-height budget
  (target: no more than the rows needed for `viewport + 2 * overscan`, plus bounded keep-alive;
  assert independence from the loaded count, not a magic constant).
- A collapsed body yields `null` from `querySelector` for its content; opening mounts it.
- The D5 pad identity holds; scroll position is preserved across a window shift, a prepend, a
  remount, and a detail collapse above the viewport; pinned bottom follows new content; unseen
  count still increments.
- A focused control stays mounted until focus leaves the bounded keep-alive range; focus then lands
  on the scroll container, not `<body>`.
- All mandatory gates pass, including `npm run test:e2e`.

## 4. Data flow

Before:

```
feed.revision -> ChatPage.threadMessages (all messages/parts)
              -> threadItems (all groups)
              -> ChatThread v-for (all items)
                 -> ChatMessage/ToolPart/WorkGroup (all detail bodies mounted)
```

After:

```
feed.revision -> ChatPage.threadMessages/threadItems (unchanged, all data)
              -> ChatThread: computeWindow(items, heights, localScrollTop, overscan)
                 -> visible slice + top/bottom spacers
                    -> ChatMessage/WorkGroup (bodies mounted only when open)
                       -> ResizeObserver -> height cache -> recompute window
```

Paging, SSE, grouping, unseen counts, and `load-earlier` keep their current contracts. The loaded
count is exposed as `data-chat-loaded-count` on the thread root for tests and QA.

## 5. Impact

UI only:

- `ui/components/chat/ChatThread.vue` - window state, spacers, row registry, measurement,
  anchor capture/restore, focus keep-alive, loaded-count attribute.
- `ui/components/chat/ChatWorkGroup.vue`, `ToolPart.vue`, `ReasoningPart.vue`,
  `ChatMessage.vue` - lazy bodies, controlled `open`, remembered state, error precedence.
- `ui/chat/transcript-window.ts` - new pure window math.
- `ui/chat/transcript-memory.ts` - new in-memory height/detail cache and provided scope.
- `ui/chat/view-scope.ts` - shared `scrollMemoryKey` so scroll and transcript memory do not cycle.
- `ui/chat/scroll-memory.ts` - optional anchor key/visualOffset and cache clearing.
- `src/http/styles.css` - spacer class; gap compensation is inline from the measured `G`.
- `test/ui/*` - new and updated coverage.
- `e2e/support/seed.ts`, `e2e/spa-chat.spec.ts` - long-thread assertions.
- `docs/current-state.md`, `docs/design/README.md`, `docs/plans/*`, `docs/journal/*`.

No server, database, API, auth, permissions, or dependency changes. No message retention change.

## 6. Alternatives considered

- **`content-visibility: auto` only**: skips layout/paint for offscreen rows, but the DOM and
  component instances remain. It does not fix memory retention or eager detail bodies. A possible
  later additive optimization, not a substitute.
- **Cap the rendered tail at N items**: scrolling back would need a jump or a "load more" step and
  ignores actual heights. Rejected.
- **Drop old messages from the feed store**: loses data and breaks scroll-back without a refetch;
  paging already exists. Rejected.
- **A general virtual-scroller dependency**: adds a dependency, assumes known item sizes, and
  fights the existing anchor/follow-bottom logic. Rejected.
- **Windowing in `ChatPage`/`threadItems`**: mixes view geometry into the data projection and still
  needs DOM measurement. Rejected.
- **Rebuild the anchor from the model only**: simpler, but wrong across remounts and partial
  prepends where real heights differ from estimates. The DOM-first anchor in D6 is the fix.
- **Memoize the message projection now**: the per-token O(loaded) projection remains a separate
  hot path. Deferred; measure it in this stage and record it as a follow-up if it dominates.
- **Lazy notice-group bodies**: `v-show`, but light rows capped at 50. Deferred.

## 7. Risks and mitigations

| Risk | Mitigation |
| --- | --- |
| Scroll jumps from estimated heights | Measure before unmounting, cache heights, the D5 pad identity, DOM-first anchors, conservative activation. |
| ResizeObserver feedback loop | Ignore sub-pixel changes, coalesce in rAF, only observe mounted rows, cache ref setters. |
| Native details state and Vue binding diverge | Fully controlled `open` ref; toggle and error opens write the same memory. |
| Unmounting a focused row | Bounded keep-alive; move focus to the scroll container before unmounting. |
| keep-alive expanding the window without bound | Cap at visible window plus one overscan per side. |
| A row is unmounted while a streamed part updates | Data stays in the store; remount re-renders; offscreen streaming work is skipped intentionally. |
| Details open/close changes total height above the reader | DOM-first anchor / height delta correction; pinned mode re-anchors bottom. |
| History row swap after load-earlier completion changes `runTop` | Re-settle from the last anchor after `loadingEarlier` flips false; `runTop` is measured, not assumed. |
| Cache eviction invalidates a loaded row | Never evict live keys; prune only removed keys. |
| Tests assume all rows exist | Intentional updates; the loaded count is exposed separately. |
| Print/find-in-page cannot see offscreen rows | Accepted limitation for a long lived log; recorded. |
| Screen-reader/tab traversal loses offscreen rows | Accepted virtualization tradeoff; focused rows are retained and focus is moved to the scroll container, not lost. |

## 8. Non-goals

- Server-side message eviction, retention, or a new pagination protocol.
- A new virtual-list dependency or a generic virtual-scroller abstraction.
- Changing Markdown, diff, or highlight limits.
- Memoizing the per-token `threadMessages`/`threadItems` projection (follow-up if measurement
  requires it).
- Lazy notice-group bodies, OMO cards, handoff cards, or the session/context rails.
- Persisting scroll, heights, or open state across hard reloads or devices.
- Print or find-in-page parity for unmounted rows.
- Full tab-order traversal through unmounted history rows (focus retention is in scope; traversal
  parity is not).

## 9. Owner decisions

Collected 2026-11-20:

1. **Approach** - both A (lazy detail bodies) and B (measured-height windowing), full delivery
   cycle.
2. **Overscan** - two viewport heights above and below the visible area.
3. **Detail state** - remember open details while rows leave and re-enter the window.
4. **Delivery** - no deployment in this stage; commit when the work is complete.

No open question remains for this design.

## 10. Verification

```bash
npm run lint
npm run typecheck
npm run typecheck:ui
npm test
npm run build
npm run check:ui
npm run check:sensitive
npm run test:e2e
```

Plus the targeted window/memory/detail tests and the long-thread browser scenario described in
D11.

## 11. Design review record

Oracle round 1 (2026-11-20): **PASS WITH FIXES**. The architecture was accepted; the findings below
were folded into this revision:

- **High** - bottom-spacer off by one gap; anchor coordinate/origin and DOM-versus-model restore;
  prepend/window sequencing; unbounded focus keep-alive; first-measurement baseline above the
  viewport; programmatic-scroll reactivity.
- **Medium** - `ChatMessage` details not controlled; detail-scope plumbing; activation latching on
  estimates; cache eviction of live keys; pinned re-anchor on non-revision height changes; the
  500-message E2E and unit expectations; `persist`/session-switch anchoring; per-render ref churn;
  remembered-open heavy bodies; the acceptance bound; keyboard traversal; error precedence.
- **Low** - W6 wording, pinned empty range, spurious load-earlier during corrections, history-row
  swap after load-earlier, `borderBoxSize` fallback/epsilon, wording.

Focused round 2 (2026-11-20): **PASS WITH FIXES**. It confirmed the round-1 High/Medium items are
resolved; the remaining localized findings were folded as follows:

- border-box measurement uses the array/object `borderBoxSize` shape and `offsetHeight` fallback,
  never `contentRect.height`;
- `scrollMemoryKey` moved to `ui/chat/view-scope.ts` to avoid a scroll-memory/transcript-memory
  cycle;
- the prefix build is documented as O(n) numeric work that may run per projection, while pruning
  and row-registry maintenance are gated on structural changes; live-key sets are not built per
  token;
- `onViewportResize` updates `viewportHeight` and re-settles;
- the focus check runs synchronously before the slice commits;
- the `persist(previous)` call in the session-change watcher is explicitly removed;
- `revealIndex` is a separate one-shot input from the bounded focus `keepAlive`.

No material design change remains; the plan may be written.
