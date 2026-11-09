# Design - Chat notice grouping and leading-notice hiding

Status: **cleared** - Oracle Round 1/2/3 findings folded; no material change after Round 3. Owner
decisions are closed (2026-11-09); no open questions remain.

Scope: the SPA chat timeline (`/chat`) - the persisted `session_notices` break rows rendered by
`ChatNoticeRow.vue`, their projection in `ChatPage.vue`, and the timeline renderer in
`ChatThread.vue`.

Out of scope: OMO/system-reminder cards (`OmoCard.vue`), synthetic `Agent error` rows, the server
notice model, the database schema, notice retention/pagination, the retired legacy chat renderer,
and any change to the notice labels or reasons.

Governing context: [`agent-process-protection.md`](./agent-process-protection.md) (persisted
notices), [`chat-pagination.md`](./chat-pagination.md) (message tail and cursor), and
[`docs/open-questions.md`](../open-questions.md) (owner decisions for this stage).

---

## 1. Problem

A single runtime stop/restart writes one `agent_stopped` notice on the interrupted session and one
`subagent_interrupted` notice on its parent **per active child** (`src/opencode/recovery.ts:2340-2365`).
All rows of one batch share the same `createdAt`, and ties are ordered by random UUID, so
`agent_stopped` can appear in the middle of a run of `subagent_interrupted` rows. Repeated restarts
create one new parent rollup per affected child per runtime epoch; the parent chat therefore shows a
wall of near-identical full-width divider rows.

A second defect appears while history is paginated: notices are loaded as the latest 50
independently of the 30-message tail, so notices whose timestamp precedes the first loaded message
render at the very top of the thread. They are not the first events of the conversation - the
messages before them are simply not loaded yet.

## 2. Requirements

| ID | Requirement |
| --- | --- |
| G1 | Consecutive notice divider rows with the same cause collapse into one summary row; a message breaks the run. |
| G2 | The collapsed summary is the most detailed available: cause, notice count, distinct subagents, distinct restarts, per-kind breakdown, and time range. |
| G3 | While older messages are not loaded, notice rows before the first locally loaded message are hidden; they reappear once history is exhausted. |
| G4 | A group of one renders exactly as today. Grouping does not change notice data, labels, or reasons. |
| G5 | Scroll anchoring, follow-bottom, unseen counting, session switching, and accessibility keep working. |
| G6 | No server, API, schema, or retention change; no OMO/system-card grouping. |

## 3. Decisions

### D1 - Group only notice dividers

Only `ChatThreadItem` values of type `notice` participate. OMO cards are message rows with a
different component and remain untouched.

### D2 - Group key is the normalized reason, not the kind

A group is a maximal contiguous run of notice items with the same normalized cause:

- the raw `reason` when it is a non-empty string;
- otherwise the `kind` when it is a non-empty string;
- otherwise the empty string.

Rationale: within one stop batch all rows share `createdAt` but their order is random, so grouping
by `kind` would split the batch around an interleaved `agent_stopped` row. `reason` is the
human-meaningful cause shared by the parent and child rows. A `message` item breaks the run. No time
window is used: adjacency in the already-sorted feed is sufficient and predictable.

Consequences: `agent_stopped` and `subagent_interrupted` rows with the same reason group together;
different reasons do not; client warning notices group only when their warning text is identical.

### D3 - Hide leading notices only while history is incomplete

Before grouping, compute the flat timeline as today. If `historyCursor !== null` (older messages may
still be unloaded), drop every notice item before the first message item. If there is no message
item and `historyCursor !== null`, drop all notices. When `historyCursor === null`, keep them.

Rationale: a notice before the first locally loaded message cannot be proven to be the first event
while an older message page exists. A notice-only session with complete history keeps its notice.

The filter is presentation-only: the feed store, the notice list, and the SSE path are unchanged.
The hidden notices reappear after the user pages to the start of the conversation.

### D4 - Projection helper, not a renderer-local pass

A new pure module `ui/chat/notice-groups.ts` exposes:

- `noticeGroupKey(notice): string`;
- `buildNoticeTimeline(items, options): ChatThreadItem[]`, where `options` is
  `{ historyComplete: boolean }`.

`ChatPage.vue` calls it from the existing `threadItems` computed, after building the flat list from
`feed.feedOrder`. `ChatThread.vue` stays presentational but its template must be made
discriminant-safe:

- a `threadItemKey(item)` helper returns `message:<id>`, `notice:<id>`, or `group.id`
  (which already has the `notice-group:` prefix); the current inline ternary key
  (`ChatThread.vue:678`) assumes every non-message item has `.notice` and would throw for a group;
- the body becomes explicit `v-if="item.type === 'message'"`,
  `v-else-if="item.type === 'notice'"`, and `v-else` for the group; the current `v-else`
  (`ChatThread.vue:690`) would pass `undefined` to `ChatNoticeRow`.

`ChatThread.vue` scroll anchoring stays message-based (`[data-message-id]`); no scroll-logic change is
required.

Rejected alternatives:

- **Group in `ChatThread.vue`**: the component receives a flat array with no neighbour metadata and
  its scroll logic counts items; a new item shape would still be needed.
- **Group in `assets/chat-core.js` `mergeFeedOrder`**: it returns only `{type,id,createdAt}`, loses
  the notice payload, and is shared with the frozen legacy client.
- **Server-side aggregation**: changes payload, dedupe keys, labels, and the API; deferred until the
  wall is proven to hurt other clients or the 50-notice retention.
- **Time-window grouping**: hides the natural message boundary and merges unrelated episodes.

### D5 - Summary shape and detail

The new union member is:

```ts
type ChatThreadItem =
  | { type: "message"; message: ChatMessageView }
  | { type: "notice"; notice: NoticeView }
  | { type: "notice-group"; group: ChatNoticeGroupView };

interface ChatNoticeGroupView {
  id: string;                 // `notice-group:<first notice id>`
  notices: readonly NoticeView[];
  reason: string;             // normalized group key
  reasonLabel: string;        // mapped cause
  count: number;              // notices.length
  kindBreakdown: readonly { label: string; count: number }[];
  subagentCount: number;      // distinct child sessions
  restartCount: number;       // distinct runtime epochs for restart causes
  firstAt: string;            // first valid createdAt, or ""
  lastAt: string;             // last valid createdAt, or ""
  metricsText: string;        // "18 notices · 4 subagents · 3 restarts"
  breakdownText: string;      // "Subagent interrupted ×17 · Agent was restarted here ×1"
  timeText: string;           // "13:41-14:02" or full dates across days
  timeTitle: string;          // full absolute range
}
```

**Singleton.** A run of length 1 emits a plain `{ type: "notice", notice }` item, not a
`notice-group`. This preserves `ChatNoticeRow`'s DOM exactly (`role="note"`, `data-kind`,
`data-notice-id`, `.chat-notice`), keeps the existing stream-warning test green, and removes the
need to special-case size 1 in the component.

**Label mapping.** `reasonLabel` reuses `noticeLabel()` from `assets/chat-core.js` on the **first
member**, never a raw reason table:

- `const mapped = noticeLabel(group.notices[0]); reasonLabel = mapped.reason || mapped.label;`

This keeps kind-keyed groups (the members' raw `reason` is empty, e.g. `resume_started`) labelled
"Agent resumed here" and preserves the `resume_failed` + `ambiguous` special case ("Outcome
unknown"), because `noticeLabel` sees both `kind` and `reason` from the first member. The breakdown uses
`noticeLabel(notice).label` per member, so no new label vocabulary is introduced.

**Metric rules.** All payload reads are defensive: only string values count; missing or non-string
values are skipped and the metric is omitted, never rendered as zero.

- `subagentCount`: distinct `payload.childSessionID` values, excluding a value equal to the notice's
  own `sessionId` (the child-abort path writes a self-referential `subagent_interrupted` row into the
  child session, which must not report "1 subagent").
- `restartCount`: distinct `payload.runtimeEpoch` values, but only when the group's `reason` is one
  of `process_exit`, `operator_restart`, `deployment`, or `unknown_restart`. Abort/stop/deletion
  groups never report restarts.
- `metricsText` joins only available metrics: `N notices` always; `X subagents` and `Y restarts`
  when non-zero.
- `timeText`/`timeTitle`: parse `createdAt`; invalid values are skipped. Same day renders
  `HH:MM-HH:MM` (single `HH:MM` for one minute); across days renders the full `absoluteTime` range.
  `timeTitle` always carries the full range.

Collapsed summary, two lines inside the existing `.feed-notice` shell:

1. `reasonLabel` + `metricsText`
2. `breakdownText` + `timeText`

### D6 - Interaction and accessibility

- The group wrapper `.chat-notice-group` has no role; `role="note"` stays only on the inner
  `ChatNoticeRow` rows. The summary is a native `<button type="button">` with `aria-expanded` and
  `aria-controls`.
- The controlled region is **always rendered** (unique `id="${group.id}-body"`) and hidden with
  `v-show`; `aria-controls` never points at a missing element, and the inner rows remain queryable
  for QA.
- Default is collapsed. Open state is local to the group component; the component key is the group
  id, so a new group starts collapsed.
- The chevron uses `AppIcon name="chevron-down"` and is `aria-hidden`.
- The full first/last timestamps are available as the button `title` (`timeTitle`); the visible range
  is compact (`timeText`).
- Group size 1 is a plain `ChatNoticeRow`, no button and no chevron (D5 singleton rule).

### D7 - Styling reuses the existing divider tokens

No new colors or typography. The group wrapper adds layout only; the summary keeps
`.feed-notice`, `.feed-notice__rule`, `.feed-notice__body`, `.feed-notice__label`, and
`.feed-notice__reason`. New classes cover the button reset, wrapping, chevron rotation, and the
expanded body. Tokens: `--line`, `--text-2`, `--text-3`, `--text-caption`, `--text-micro`,
`--font-mono`, `--space-*`, `--radius-sm`.

The existing deterministic process-notice QA (`docs/design/process-protection-qa.mjs`) produces no
groups today: its fixtures either use different reasons or place a message between notices, and its
**messages** route returns `nextCursor: null` (`:485`), so leading hiding does not trigger. (Leading
hiding keys off the messages cursor, not the notices cursor at `:477`.) The harness itself currently
stops before any notice assertion on a stale legacy selector (`#chat-prompt`, removed by the SPA
cutover); that is a pre-existing harness failure, not a product regression. The route gate is
`npm run test:e2e`. If the harness is refreshed and a grouped scenario is added, update its
`feedSnapshot` to descend into `.chat-notice-group` and count the underlying `[data-notice-id]`
rows; the expanded region is always in the DOM, so those rows remain queryable.

## 4. Impact

- No API, schema, or server change; no new notice fields.
- Timeline item count changes, but scroll anchors are message-based (`data-message-id`), so
  `captureAnchor`/`restoreAnchor` are unaffected. The unseen counter counts timeline items, so a new
  notice that joins an existing group adds 0 to `items.length` and does not increment the badge; this
  is newly introduced by grouping and accepted.
- Notices remain capped at the latest 50 per session; grouping cannot span notices that were never
  loaded, and "Load earlier messages" still does not page notices.
- A message created in the same millisecond as a notice batch can tie-break between two same-reason
  notices and split the run (`mergeFeedOrder` ties by id). Accepted: it is a rare, harmless split.

## 5. Risks

| Risk | Mitigation |
| --- | --- |
| A legitimate leading notice is hidden while history is incomplete | It reappears when `historyCursor` becomes null; a notice-only complete session keeps it. |
| Random same-timestamp ordering splits a batch | Group by reason, not kind; test mixed-kind runs. |
| Group summary is too wide | `.feed-notice__body` already wraps; the summary uses flex-wrap and short tokens. |
| Scroll/unseen regressions | Keep message anchors; cover grouping with scroll and history tests. |
| Group id changes when a same-timestamp notice is inserted before the first member | State resets to collapsed; no data loss. Accepted. |
| A group of N adds N+1 `.feed-notice` nodes (summary shell + always-rendered inner rows), and `feedSnapshot` filters direct `#chat-messages > *` children, so it would drop the wrapper entirely | Existing QA fixtures form no groups; a grouped scenario updates `feedSnapshot` to descend into `.chat-notice-group` and count `[data-notice-id]`. |
| Page tests cannot seed notices today | Extend `ChatFixture` with `notices`/`noticeNextCursor` and wire the `/notices` route in `test/ui/chat-support.ts`. |

## 6. Open questions

None. Owner decisions (2026-11-09): scope is divider rows only; the collapsed caption is the most
detailed variant; the leading-notice rule is "hide while an earlier message chunk is not loaded".

## 7. Verification

`npm run lint`, `npm run typecheck`, `npm run typecheck:ui`, `npm run check:ui`, `npm test`,
`npm run build`, `npm run check:sensitive`, and `npm run test:e2e` (the rendered `/chat` route
changes; the Playwright `e2e/chat.spec.ts` and `e2e/spa-chat.spec.ts` suites are the route gates,
and the notice-rendering assertions live at `e2e/spa-chat.spec.ts:609-662`). The optional
`node docs/design/process-protection-qa.mjs` currently fails at `gotoChat` on the stale legacy
`#chat-prompt` selector, before any notice assertion; record it as a pre-existing harness failure,
not a stage regression.

New tests:

- pure projection: same-reason mixed-kind runs, message/reason boundaries, singleton emission,
  leading hiding (incomplete vs complete history, notice-only, no-message case), defensive payloads,
  self-child exclusion, restart-reason gating, pluralization, the same-day/cross-day time range, and
  a `resume_failed` + `ambiguous` group whose `reasonLabel` is "Outcome unknown";
- component: collapsed summary text, `aria-expanded`/`aria-controls`, expansion renders the original
  rows, singleton keeps `.chat-notice`;
- page: `ChatFixture.notices` seeds leading notices; hidden while `nextCursor` is non-null, revealed
  when it becomes null; a grouped run renders one group and expands; the existing stream-warning
  test still finds `.chat-notice`;
- history/scroll: the existing `chat-history` paging tests stay green; add a transition test for the
  stale-null cursor branch (`ChatPage.vue:1563`) so leading hide/keep cannot regress.

## 8. Design review

Round 1 (`oracle`, 2026-11-09): **CHANGES REQUESTED**. All findings are folded:

1. HIGH - `ChatThread.vue` key/`v-else` break on the third union member -> D4 now names
   `threadItemKey()` and the explicit `v-if`/`v-else-if`/`v-else` branches.
2. HIGH - page tests cannot seed notices -> D7 risk and §7 add the `ChatFixture.notices` /
   `noticeNextCursor` harness change.
3. MEDIUM - singleton unspecified -> D5 now emits a plain `notice` item for a run of length 1.
4. MEDIUM - `reasonLabel` inconsistent with `noticeLabel()` -> D5 now derives it from the first
   member through `noticeLabel()`, including the `resume_failed`/`ambiguous` case.
5. MEDIUM - "restarts" from raw `runtimeEpoch` is misleading -> D5 gates it on restart reasons and
   excludes the self-child count.
6. MEDIUM - QA/verification names -> D7 documents the existing QA behavior and §7 names
   `e2e/chat.spec.ts` plus the optional process-notice QA.
7. MEDIUM - accessibility -> D6 always renders the controlled region, removes the role from the
   group shell, and keeps `role="note"` on the inner rows.
8. LOW - defensive payload extraction -> D5 metric rules require string-only extraction and omit
   missing metrics.
9. LOW - same-millisecond split and unseen wording -> Impact now records both as accepted/newly
   introduced.
10. LOW - stale-cursor branch -> §7 adds a transition regression test.

Round 2 (`oracle`, 2026-11-09): **CHANGES REQUESTED** on the first fold. Remaining findings and
resolutions:

1. HIGH - `reasonLabel` still lost `resume_failed` + `ambiguous` because it passed only `reason` to
   `noticeLabel()` -> D5 now derives it from the first member (`noticeLabel(notices[0])`), and §7
   adds an ambiguous-group test.
2. LOW - `check:ui` missing -> added to §7.
3. LOW - QA leading-hide was attributed to the notices cursor -> D7 now cites the messages route
   (`nextCursor: null`) as the reason the QA stays green.
4. LOW - risk row understated the `.feed-notice` growth and the direct-child `feedSnapshot` filter ->
   corrected.
5. LOW - `threadItemKey` double-prefixed groups -> the key now returns `group.id` directly.
6. LOW - route gates understated -> §7 names both `e2e/chat.spec.ts` and `e2e/spa-chat.spec.ts`
   (notice assertions at `e2e/spa-chat.spec.ts:609-662`).

Round 3 (`oracle`, 2026-11-09): **CHANGES REQUESTED** on documentation only. Both findings are
folded and do not change the design materially, so no Round 4 is required:

1. MEDIUM - §7 did not list the ambiguous-group test -> added.
2. LOW - D5 wording implied `group.reason === ""` for kind-keyed groups -> reworded to "the
   members' raw `reason` is empty".

Design-review gate: **cleared** (Round 3 findings folded; no material design change after Round 3).
