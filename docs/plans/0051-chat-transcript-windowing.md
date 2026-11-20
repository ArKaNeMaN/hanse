# Plan 0051 - Chat transcript windowing and lazy detail bodies

Status: **implemented and verified** (journal 0064); not deployed. `momus` round 1 **OKAY WITH
FIXES**; all findings are folded below. Design review is cleared (Oracle round 2 PASS WITH FIXES,
findings folded).

Design: [`docs/design/chat-transcript-windowing.md`](../design/chat-transcript-windowing.md).

## Process binding

| Binding | Value |
| --- | --- |
| Design reviewer | `oracle` (round 1 PASS WITH FIXES, focused round 2 PASS WITH FIXES; all findings folded) |
| Plan reviewer | `momus` (this document) |
| Design doc | `docs/design/chat-transcript-windowing.md` |
| Design index | `docs/design/README.md` |
| Plan doc | `docs/plans/0051-chat-transcript-windowing.md` |
| Plan index | `docs/plans/README.md` |
| Journal | `docs/journal/0064-chat-transcript-windowing.md` + `docs/journal/README.md` |
| Open questions | `docs/open-questions.md` (stage 0051 decisions closed; append when the in-flight stage's edits settle) |
| Language | English (docs, code, comments) |
| Commit policy | One coherent stage commit, **commit only, no push**; the owner authorized the commit but not a push. Do not stage another stage's uncommitted files. If a shared file still carries another stage's hunks at commit time, pause and report rather than force-staging. |

### Owner decisions (closed 2026-11-20)

1. Implement both A (lazy detail bodies) and B (measured-height windowing) through the full cycle.
2. Overscan is two viewport heights above and below the visible area.
3. Remember expanded detail state while rows leave and re-enter the window.
4. No deployment in this stage; commit when the work is complete.

### Invariants

| ID | Invariant |
| --- | --- |
| T1 | A collapsed work group, tool, reasoning, or file/subtask body is absent from the DOM; opening mounts it, closing unmounts it. |
| T2 | The window is a contiguous slice of `props.items`; rendered rows plus top/bottom spacers reproduce the full item-run height exactly. |
| T3 | `topPad = P[start] + G*start` with `margin-block-end: -G`; `bottomPad = (P[n]-P[end]) + G*(n-1-end)` with no negative margin. The pad identity in design D5 holds for every window. |
| T4 | Anchors are key + `visualOffset` from the mounted DOM; the model `P`/`runTop` is only a fallback when the anchor is unmounted. |
| T5 | `scrollTop`, `viewportHeight`, and `pinned` are reactive inputs updated synchronously by every programmatic scroll, resize, and correction. |
| T6 | The first render after mount/session change runs with windowing disabled for the initial restore; activation is evaluated only after that restore and the first measurement pass. |
| T7 | A focused row is never unmounted while it holds focus; keep-alive is bounded to the window plus one overscan per side. |
| T8 | Below activation, no spacers and no extra rows are added; lazy detail bodies still apply everywhere. |
| T9 | No server, API, schema, auth, permission, or dependency change. |
| T10 | jsdom/no-layout renders all rows; the pure modules are deterministic and DOM-free. |

### Non-goals

- Server message eviction, retention, or a pagination protocol change.
- Projection memoization for `threadMessages`/`threadItems` (measure and record as a follow-up).
- Lazy notice-group bodies, OMO/handoff cards, session/context rails.
- Persisting scroll/heights/open state across hard reloads or devices.
- Print/find-in-page parity, full tab-order traversal through unmounted history.
- A new virtual-list dependency.
- Deploying the stage.

### Contract freeze

Freeze these names and shapes before Phase A; later phases must not rename them.

```ts
// ui/chat/view-scope.ts
export function scrollMemoryKey(workspaceKey: string, sessionID: string | null): string | null;

// ui/chat/scroll-memory.ts
export interface ChatScrollMemory {
  readonly scrollTop: number;
  readonly scrollHeight: number;
  readonly key?: string;
  readonly visualOffset?: number;
}
export function readScrollMemory(key: string | null): ChatScrollMemory | null;
export function writeScrollMemory(key: string | null, value: ChatScrollMemory): void;
export function clearScrollMemory(key?: string): void;

// ui/chat/transcript-memory.ts
export interface TranscriptDetailScope {
  isOpen(id: string): boolean | undefined;
  setOpen(id: string, open: boolean): void;
}
export interface TranscriptMemory extends TranscriptDetailScope {
  readHeight(key: string): number | undefined;
  writeHeight(key: string, height: number): void;
  pruneHeights(liveKeys: ReadonlySet<string>): void;
  pruneDetails(liveIds: ReadonlySet<string>): void;
}
export function createTranscriptMemory(scopeKey: string | null): TranscriptMemory;
export function clearTranscriptMemory(scopeKey?: string): void;
export const TRANSCRIPT_DETAIL_SCOPE: symbol;

// ui/chat/transcript-window.ts
export interface TranscriptWindowInput {
  readonly heights: readonly number[]; // aligned to items; 0 = unmeasured
  readonly fallbackHeight: number;
  readonly gap: number;
  readonly localScrollTop: number;
  readonly viewportHeight: number;
  readonly overscan: number;
  readonly pinned: boolean;
  readonly keepAlive: readonly number[];
  readonly revealIndex?: number;
  readonly enabled: boolean;
}
export interface TranscriptWindow {
  readonly start: number;
  readonly end: number;
  readonly topPad: number;
  readonly bottomPad: number;
}
export function computeTranscriptWindow(input: TranscriptWindowInput): TranscriptWindow;
```

The injected detail scope key is `TRANSCRIPT_DETAIL_SCOPE`, a module-local `Symbol` exported from
`ui/chat/transcript-memory.ts` and provided by `ChatThread`.

---

## Phase A - Pure window and memory modules

**Goal:** deterministic, DOM-free modules with full unit coverage; no renderer change.

**Files:** `ui/chat/view-scope.ts` (new), `ui/chat/transcript-memory.ts` (new),
`ui/chat/transcript-window.ts` (new), `ui/chat/scroll-memory.ts`,
`test/ui/chat-transcript-window.test.ts` (new), `test/ui/chat-transcript-memory.test.ts` (new).

**Work items**

A1. Move `scrollMemoryKey` from `ui/chat/scroll-memory.ts` to `ui/chat/view-scope.ts`; re-export it
from `scroll-memory.ts` for existing imports. Add optional `key`/`visualOffset` to
`ChatScrollMemory`, and make `writeScrollMemory` copy and sanitize them when present (do not drop
them). `readScrollMemory` preserves them. Add a round-trip unit test.

A2. Add `clearTranscriptMemory(scope?)` and have `clearScrollMemory(scope?)` call it in one
direction (no cycle). `clearScrollMemory()` with no argument clears all scroll and transcript state.

A3. Implement `ui/chat/transcript-window.ts` exactly as the contract, including:
- full range when `!enabled`, `n === 0`, or `viewportHeight <= 0`;
- prefix over `h[i] > 0 ? h[i] : fallbackHeight`;
- pinned tail selection with `start <= n - 1`;
- non-pinned overscan selection using `localScrollTop`;
- `keepAlive` expansion, one-shot `revealIndex`, clamping;
- the D5 pads and the pad identity;
- binary search over the prefix.

A4. Implement `ui/chat/transcript-memory.ts`:
- scope key from `scrollMemoryKey`;
- per-scope `heights`/`details` maps;
- `readHeight`/`writeHeight` with delete-then-set LRU refresh;
- `pruneHeights(liveKeys)` and `pruneDetails(liveIds)` that never remove live keys;
- `isOpen`/`setOpen`;
- caps 5000 heights / 2000 details as safety nets for removed keys;
- no storage, network, Vue, or DOM dependency.

A5. Tests:
- pad identity for `[0,n)`, a middle window, and a tail window, with and without a top spacer;
- two-viewport overscan and pinned tail;
- one row taller than the viewport still yields a non-empty range;
- `keepAlive` expansion and a far `revealIndex`;
- unknown heights/fallback; disabled mode; zero viewport; empty list;
- gap > 0 and gap = 0;
- memory scope isolation, LRU refresh, live-key pruning, caps, clear.

**Acceptance:** `npm run typecheck:ui` and the two new test files pass; no component or page change.

---

## Phase B - Lazy detail bodies and remembered state

**Goal:** collapsed details are unmounted; open state survives a row leaving and re-entering the
window. Independent of windowing.

**Files:** `ui/components/chat/ChatThread.vue` (provide), `ChatWorkGroup.vue`, `ToolPart.vue`,
`ReasoningPart.vue`, `ChatMessage.vue`; `test/ui/chat-work-group-row.test.ts`,
`test/ui/chat-tools.test.ts`, `test/ui/chat-message.test.ts`,
`test/ui/chat-highlight-teardown.test.ts` (or `chat-diff-view.test.ts`),
`docs/design/chat-qa.mjs` (scenario selectors for lazy bodies).

**Work items**

B1. `ChatThread` creates a `shallowRef<TranscriptMemory>` for the current scope (Phase A) and
`provide`s a **stable facade** under `TRANSCRIPT_DETAIL_SCOPE`; the facade's `isOpen`/`setOpen`
delegate to `memoryRef.value`. Session change swaps `memoryRef.value`; `provide` is called once in
setup and is never re-called. When no session key exists, use a transient memory. Test that a
session switch, a detail toggle, and a return to the old session restore the old scope's state.

B2. `ChatWorkGroup.vue`:
- `const remembered = scope.isOpen(group.id)`;
- `open = ref(group.hasError || remembered === true)`;
- `:open="open"` and `@toggle="onToggle"`; `onToggle` reads
  `(event.target as HTMLDetailsElement).open`, then calls `setOpen(value)`; `setOpen` updates both
  the local ref and `scope.setOpen(group.id, value)`;
- `watch(() => group.hasError, hasError => { if (hasError) setOpen(true); })`;
- `v-if="open"` on `.chat-work-group__body`.

B3. `ToolPart.vue`:
- memory ids are `part.id`;
- initialize `open` from `status === "error" || scope.isOpen(part.id) === true`;
- keep the existing status watcher, and make it call `setOpen(true)` on an error transition;
- `@toggle` reads `details.open`, then calls `setOpen`, which writes `scope.setOpen(part.id, value)`;
- wrap every body branch in `v-if="open"`, leaving the summary untouched;
- `DiffView`/`ReadView`/`WriteView` receive `:open="true"` while mounted.

B4. `ReasoningPart.vue`:
- memory id is `part.id`;
- `open = ref(scope.isOpen(part.id) === true)`, `:open`, `@toggle` reads `details.open` and writes
  the memory;
- `<pre v-if="open">`; the summary elapsed timer stays.

B5. `ChatMessage.vue`:
- seed `openDetails` from the scope for file/subtask parts on mount;
- bind `:open="isDetailOpen(part.id)"` on the file/subtask `<details>`;
- `onDetailToggle` updates the local set and `scope.setOpen(part.id, open)`;
- `<pre v-if="isDetailOpen(part.id)">`.

B6. No-op fallback: `inject` returns `undefined` outside `ChatThread`; leaf components then use only
their local state (isolated component tests keep working).

B7. Tests:
- closed group body absent; open mounts reasoning/tools; close unmounts; remembered after remount;
- an error group is open even when the memory says closed;
- closed tool body absent for bash, structured, read/write/diff; open renders; collapse tears down
  the highlight view; error opens;
- closed reasoning body absent; summary/elapsed works; remembered;
- file/subtask body absent until opened; remembered;
- a tool body is not in the DOM when its enclosing group is open but the tool is closed.

**Acceptance:** the updated and new component tests pass; `npm run typecheck:ui` passes; a manual
DOM check shows no `.chat-work-group__body`, `.chat-reasoning__text`, `[data-tool-output]`,
`[data-diff-view]`, `[data-read-view]`, or `[data-write-view]` under a closed details.

---

## Phase C - Anchor and reactive-scroll refactor (windowing still off)

**Goal:** replace the O(all) DOM anchor scan and make scroll inputs reactive, with the window
disabled so the rendered DOM is unchanged. This isolates the riskiest behavior before windowing.

**Files:** `ui/components/chat/ChatThread.vue`, `test/ui/chat-scroll.test.ts`,
`test/ui/chat-history.test.ts`, `test/ui/chat-anchor.test.ts` (new).

**Work items**

C1. Add refs: `scrollTopValue` (current scrollTop), `viewportHeightValue`, `runTopValue` (initial 0).
`onScroll`, `scrollToBottom`, `restoreAnchor`, and `onViewportResize` update them synchronously.
Never read `node.scrollTop` or DOM rects inside a computed.

C2. Add `:data-thread-key="threadItemKey(item)"` to every row component in the `v-for`. Keep
`data-message-id` untouched for existing QA.

C3. Replace `captureAnchor`:
- scan the rendered `[data-thread-key]` rows (all rows while windowing is off);
- take the first row whose bottom is below the viewport top;
- return `{ scrollTop, scrollHeight, key, visualOffset }` where
  `visualOffset = rowRect.top - scrollRect.top`;
- if no row is mounted, return the legacy `messageID`/`messageOffset`/scroll fields.

C3a. `onScroll` captures the current anchor (bounded to rendered rows) and stores it in
`lastAnchor`; `scrollToBottom` captures the first row below the viewport top after the scroll.
The persisted anchor is never stale.

C4. Replace `restoreAnchor` to match design D6 exactly:
- key path first;
- if the key is mounted, set `scrollTop += currentVisualOffset - visualOffset`;
- if the key is not mounted and the model is available (Phase D), set `revealIndex` from the key,
  set the reactive `scrollTopValue` from `runTopValue + P[i] + G*i - visualOffset`, `await
  nextTick()`, then correct once with the DOM rect if the key is now mounted; clear `revealIndex`
  after settle;
- if the key is gone, use the current `scrollHeight` delta rule;
- update `scrollTopValue`, `pinned`, `unseen`, `topRequested`, `lastClientHeight`, and persist;
- keep the returned shape compatible with `ChatPage.loadEarlier`.

C5. `persist()` writes `scrollTop`/`scrollHeight`; in Phase D, when windowing is active, it also
writes `lastAnchor.key`/`lastAnchor.visualOffset` from C3a. Phase C keeps the current
`scrollTop`/`scrollHeight` persistence; the O(window) anchor capture is added with the window.
`writeScrollMemory` must preserve the new fields (A1).

C6. Remove the `persist(previous)` call from the session-change watcher (`ChatThread.vue:401-403`).
The last scroll write already captured the outgoing position; the post-flush call would read the
new session's DOM under the old scope.

C7. `onViewportResize` and the viewport `ResizeObserver` update `viewportHeightValue` and
`lastClientHeight`, then re-settle the pinned bottom.

C8. Watch `loadingEarlier`: when it flips false after a prepend, re-settle from `lastAnchor` after
`nextTick` so the history-row content swap does not leave a residual jump; suppress load-earlier
while re-settling.

C9. Tests:
- all existing scroll/history tests keep passing with the new anchor (no windowing);
- key-based restore after a prepend, after a remount with saved memory, and when the anchor key is
  gone (delta fallback);
- programmatic scroll updates the reactive inputs before the next frame;
- the session-change watcher does not overwrite the outgoing scope's scroll memory;
- `loadingEarlier` flip re-settles without triggering load-earlier.

**Acceptance:** existing scroll/history tests pass; the new anchor tests pass; the rendered DOM has
no spacers (windowing is off).

---

## Phase D - Measured-height window, spacers, activation, focus

**Goal:** bound rendered rows, preserve scroll/focus, and activate only after the initial restore
and first measurement pass.

**Files:** `ui/components/chat/ChatThread.vue`, `src/http/styles.css`,
`test/ui/chat-window.test.ts` (new), `test/ui/chat-scroll.test.ts`, `test/ui/chat-perf.test.ts`.

**Work items**

D1. Row registry:
- `rowElements: Map<string, HTMLElement>`, `rowSetters: Map<string, (el) => void>`, `heightsByKey:
  Map<string, number>`, `renderedHeights: shallowRef<number[]>` aligned to `items`;
- a cached setter per `threadItemKey` (same function identity across patches); register/unregister
  on `null`; normalize component `$el`;
- `rebuildRenderedHeights()` runs on a structural item change (item key sequence/count), on every
  height write, and on session change; it maps `items` to `heightsByKey.get(key) ?? 0`;
- on a structural change, prune setters/elements for removed keys and call
  `memory.pruneHeights(liveKeys)` and `memory.pruneDetails(liveDetailIds)` (design D8). Never prune
  on every SSE revision, and never build the live sets per token.

D2. Measurement:
- one `ResizeObserver` over registered rows;
- read the border-box height from `borderBoxSize` (array or object) with `target.offsetHeight`
  fallback; ignore < 0.5px;
- store `lastFallbackHeight` when the prefix/window is built; the baseline for an unmeasured row is
  its cached height, else `lastFallbackHeight`;
- rows fully above the viewport and not pinned: batch deltas in one rAF, adjust `scrollTopValue`
  once, suppress load-earlier;
- pinned: schedule the bottom scroll in the same rAF;
- write heights to `transcript-memory`; call `rebuildRenderedHeights()`; on remount, seed from
  memory.

D3. Window computation:
- `fallbackHeight` = average measured height clamped `80..480`, default `160`;
- `gap` = computed `rowGap`/`gap` parsed once on mount (fallback 20); use the same number for inline
  margins;
- `localScrollTop = scrollTopValue - runTopValue`; `runTopValue` measured after the initial restore
  and `nextTick`, and re-measured when the history row/panels change;
- `computeTranscriptWindow` computed from the frozen inputs, including a `revealIndex` ref;
- `renderedItems = items.slice(start, end)` when enabled, else `items`;
- top/bottom spacers inside `#chat-messages` around the item loop with inline height and the top
  `margin-block-end: -Gpx`; bottom spacer has no negative margin; add
  `.chat-thread__spacer { flex: none; inline-size: 100%; pointer-events: none; }` and
  `aria-hidden="true"`.

D3a. `revealIndex` lifecycle:
- set from the anchor key's index in `restoreAnchor` when the key is not mounted (or when a latch
  shifts the window);
- pass it to `computeTranscriptWindow` for one tick;
- after `nextTick`, correct with the DOM rect if the key is mounted, then clear `revealIndex`;
- never persist or keep it beyond the restore settle.

D4. Activation:
- `windowEnabled = ref(false)`, `measurementReady = ref(false)`, `initialRestorePending = true`;
- mount/session change: windowing off; restore scroll/bottom; then set `initialRestorePending =
  false`;
- run `maybeActivate()` when **either** `measurementReady` or `initialRestorePending` changes, and
  after the first RO batch; this avoids the RO-before-restore deadlock;
- the count threshold (`items.length > 60`) may latch without the RO batch once the initial restore
  is done; the measured-height threshold (`> 8 * viewportHeight`, measured heights only) requires
  the first RO batch. This matches design D4;
- on item count change while not latched, re-evaluate; once latched, keep until session change;
- when latching, capture the current anchor, set `revealIndex` if needed, enable, `nextTick`,
  restore the anchor, then clear `revealIndex`;
- on session change, reset `windowEnabled`, `measurementReady`, `initialRestorePending`, row maps,
  and reload heights from the new scope in a pre-flush watcher;
- test the RO-batch-before-restore order explicitly.

D5. Focus:
- `focusin`/`focusout` on `#chat-scroll`; map `event.target` to `[data-thread-key]`; keep only the
  focused row index; use `relatedTarget` containment;
- `keepAlive` is bounded to the **base** (keepAlive-free) window ± one overscan; compute the base
  window first, then decide whether the focused row survives;
- in the scroll/window update, if the focused index would leave that range, move focus to the
  scroll container (`tabindex="-1"`) or the nearest visible summary, then drop the keep-alive and
  commit the slice; do this synchronously before the slice changes.

D6. Thread metadata:
- add a numeric `loadedMessageCount` prop to `ChatThread` from `ChatPage` (`feed.thread.order.length`,
  the message count, not `threadItems`/item count) and bind
  `:data-chat-loaded-count="loadedMessageCount"`;
- expose the item count separately as `:data-chat-item-count="items.length"` for diagnostics;
- `:data-chat-window-start`/`:data-chat-window-end` on `#chat-messages` for deterministic tests;
- `tabindex="-1"` on `#chat-scroll`.

D7. Tests:
- `test/ui/chat-window.test.ts` (new) with stubbed `clientHeight`/row heights: 500 items render a
  bounded row count; `data-chat-loaded-count` is the message count; top/bottom spacer styles match
  the pad identity;
- scroll to the middle/top changes the window and keeps the first visible row at the same
  `visualOffset`;
- prepend/remount restore after activation; initial restore happens with windowing off; an
  unmounted anchor key uses `revealIndex` and is corrected by the DOM rect;
- the scroll position is unchanged across the restore → latch transition (no-jump);
- pinned bottom follows a height change and a revision;
- viewport resize updates the window and pinned bottom;
- focus in the last rendered row, scroll far away: focus moves to the scroll container, the row
  unmounts, focus is not on `<body>`;
- streaming 20 deltas does not re-register/re-observe the window;
- jsdom/clientHeight 0 renders all rows;
- `test/ui/chat-perf.test.ts` stays a jsdom **full-render** test (clientHeight 0, no window) and
  asserts the loaded message count and the 500 rendered rows; it does not assert a bounded window.
  The bounded assertions live only in `chat-window.test.ts` with explicit layout stubs;
- `test/ui/chat-scroll.test.ts:117,139` keeps its full-render expectations (no RO/layout batch
  before the assertions) and adds a loaded-count assertion; any new windowed variant goes to
  `chat-window.test.ts`.

**Acceptance:** the D5 pad identity holds in the DOM for a middle/tail window; rendered rows are
bounded and independent of loaded count; scroll/focus tests pass; below activation the DOM has no
spacers.

---

## Phase E - E2E, docs, record, full gates

**Goal:** prove the behavior in a real browser, update the record, and land one coherent commit.

**Files:** `e2e/support/seed.ts`, `e2e/spa-chat.spec.ts`, `test/ui/chat-perf.test.ts`,
`docs/design/chat-qa.mjs`, `docs/current-state.md`, `docs/design/README.md`,
`docs/plans/README.md`, `docs/journal/0064-chat-transcript-windowing.md`,
`docs/journal/README.md`, `docs/open-questions.md` (if the in-flight stage's edits have settled).

**Work items**

E1. Extend `perfMessages()` with deterministic large content: every 25th message gets a `reasoning`
part and a `bash` tool part with a ~16 KiB output, including at least one assistant message at the
tail (`msg_e2e_perf_500`) so it is in the initial tail window. Keep ids/roles/timestamps stable.
The loaded **message** count stays 500; work-group splitting may raise the item count, which is why
E2 pages by `data-chat-loaded-count` (messages) and not by items.

E2. Rewrite the 500-message E2E test:
- page older history until `data-chat-loaded-count` reaches 500 (never use rendered row count or
  item count as the paging signal);
- assert `#chat-scroll [data-thread-key]` count is bounded (budget derived from viewport/row
  height; assert independence from 500);
- assert `data-chat-loaded-count="500"` and, if useful, `data-chat-item-count` separately;
- scroll to the bottom, open the last work group/tool (a deterministic tail target), assert its
  body mounts, close it, assert it is absent;
- record `JSHeapUsedSize`, chunk transfer, and the bounded row count in the test annotation.

E3. Add a deterministic long-thread QA scenario (or reuse `ses_e2eperf`) for scroll/prepend/remount/
focus; record the evidence in the stage record.

E3a. Update `docs/design/chat-qa.mjs` for lazy bodies: `scenarioRead` clicks the summary before
waiting for `.tool-code`; closed diff/write assertions change to "no body and no worker";
"expand all tool disclosures" re-queries `.tool-call` after opening a work group. Add the harness
to the Phase B/E file list so it is not missed.

E4. Update `docs/current-state.md` chat paragraph with the windowed transcript, lazy detail bodies,
and the accepted limitations (offscreen find/print/tab traversal).

E5. Update the design/plan/journal indexes. If `docs/design/README.md`, `docs/open-questions.md`,
`src/http/styles.css`, or `docs/current-state.md` still contains another stage's uncommitted edits,
do not stage those files in this commit; add the entry when the other stage lands, and note the
pending index edit in the record. Prefer landing/committing the in-flight `0050-mermaid-diagrams`
stage first; if that is impossible, pause and report rather than force-staging shared hunks. The
stage commit must contain only this stage's files.

E6. Write `docs/journal/0064-chat-transcript-windowing.md` with: context, design/review/plan
outcome, phases, the pad identity, perf before/after (DOM rows, heap), test counts, accepted
limitations, and the deployment note (not deployed). Update `docs/journal/README.md`.

E6a. Measure the per-token `threadMessages`/`threadItems` projection cost with 500 loaded messages
and 20 streamed deltas (a `performance.now` log in `chat-window.test.ts` or a browser QA probe).
Record it in the journal. If it dominates, add it to the record as the deferred follow-up (design
§6, non-goal); do not silently drop the measurement.

E7. Run the full verification suite:

```bash
npm run lint
npm run typecheck
npm run typecheck:ui
npm run typecheck:e2e
npm test
npm run build
npm run check:ui
npm run check:sensitive
npm run test:e2e
```

**Acceptance:** all gates green; the 500-message test records a bounded row count and the new heap
metric; the journal and indexes are updated; the commit contains only this stage's files and is
not pushed.

---

## Risks and rollback

| Risk | Mitigation |
| --- | --- |
| Scroll jump from estimated heights | Measure-before-unmount, cached heights, pad identity, DOM-first anchor, conservative activation. |
| Initial restore on a long remount | Windowing off for the initial restore; restore with mounted DOM, then latch. |
| Focus loss | Bounded keep-alive, synchronous focus move before the slice commits. |
| Height memory grows | Caps + live-key pruning on structural changes; no per-token prune. |
| Detail state lost | Stable provided facade over a per-session memory ref; scope read on mount/remount; error wins over remembered closed. |
| E2E paging loop relies on rendered rows | `data-chat-loaded-count` is the loaded **message** count; item count is separate. Update the test before enabling the window in CI. |
| Unmounted anchor after prepend/remount | `revealIndex` lifecycle + DOM correction; test the unmounted-key path. |
| Detail cache evicts a live row | `pruneDetails(liveIds)` on structural changes; caps are safety nets only. |
| Concurrent stage files | `src/http/styles.css`, `docs/current-state.md`, `docs/design/README.md`, `docs/open-questions.md` may carry the in-flight Mermaid stage's hunks. Prefer landing that stage first; otherwise pause and report, do not force-stage. |
| Journal collision | Use `0064` (the current index ends at 0063); no renumber note. |
| Chat QA harness selectors | `docs/design/chat-qa.mjs` is updated in Phase B/E for lazy bodies. |

Rollback is a normal image rollback; the change is UI-only, with no schema or API migration. The new
modules are additive; reverting the commit restores the eager renderer.

## Verification summary

Phase-level: `npm run typecheck:ui` + target Vitest files after A-D; `npm test` after B-D; the full
gate list after E, including `npm run typecheck:e2e`. The stage is not done until the 500-message
E2E and the full `test:e2e` suite pass and the record is written.

## Plan review record

`momus` round 1 (2026-11-20): **OKAY WITH FIXES**. The phase order and pad math were accepted; the
findings were folded:

- **High** - `data-chat-loaded-count` now carries the loaded message count (new prop from
  `ChatPage`), not `items.length`; the `revealIndex` lifecycle is wired into restore/latch; the
  detail scope is a stable provided facade over a per-session `shallowRef`; the journal moves to
  `0064` and the journal index is added; `writeScrollMemory` preserves key/visualOffset.
- **Medium** - `chat-perf`/`chat-scroll` stay jsdom full-render tests while bounded assertions live
  in `chat-window.test.ts`; `pruneDetails`/live-key guard added and the dangling "D8" reference
  fixed; `docs/design/chat-qa.mjs` added to Phase B/E; `typecheck:e2e` added; shared
  `styles.css`/`current-state.md` concurrency covered; activation re-runs on either readiness flag
  and the count threshold may latch before the RO batch; `rebuildRenderedHeights` and
  `lastFallbackHeight` specified; the E2E open target is pinned to the tail and the restore→latch
  no-jump check is added.
- **Low** - base-window focus bound, named `TRANSCRIPT_DETAIL_SCOPE` symbol, `:` attribute bindings,
  toggle handlers read `details.open`, commit-only push policy, and the projection-cost
  measurement in E6a.

No further design change; the plan is cleared for execution.
