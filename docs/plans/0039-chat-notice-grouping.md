# Plan 0039 - Chat notice grouping and leading-notice hiding

Status: **implemented and verified** (journal 0047) - `momus` Round 2 **OKAY**; design review
cleared (Round 3 findings folded). All phases and gates passed.

Design: [`docs/design/chat-notice-grouping.md`](../design/chat-notice-grouping.md).

## Process binding

| Binding | Value |
| --- | --- |
| Design reviewer | `oracle` (cleared: Round 1 CHANGES, Round 2 CHANGES, Round 3 CHANGES folded; no material change after Round 3) |
| Plan reviewer | `momus` (Round 2 OKAY) |
| Design doc | `docs/design/chat-notice-grouping.md` |
| Design index | `docs/design/README.md` |
| Plan doc | `docs/plans/0039-chat-notice-grouping.md` |
| Plan index | `docs/plans/README.md` |
| Journal | `docs/journal/0047-chat-notice-grouping.md` + `docs/journal/README.md` |
| Open questions | `docs/open-questions.md` (stage 0039 resolved) |
| Language | English (docs, code, comments) |
| Commit policy | One coherent stage commit, only on explicit owner instruction |

### Owner decisions (closed 2026-11-09)

1. Scope: notice divider rows only; OMO/system-reminder cards are out of scope.
2. The collapsed caption is the most detailed variant: cause, notice count, distinct subagents,
   distinct restarts, per-kind breakdown, and time range.
3. Leading notice rows before the first locally loaded message are hidden while an older message
   chunk is not loaded; they reappear when history is exhausted.
4. All other forks are delegated to the implementer; the design records the chosen rules.

### Invariants

| ID | Invariant |
| --- | --- |
| N1 | Only `ChatThreadItem` values of type `notice` are grouped; message and OMO rendering is untouched. |
| N2 | A group is a maximal contiguous run of notices with the same normalized key (`reason`, else `kind`, else `""`); a message breaks the run; a run of 1 stays a plain `notice`. |
| N3 | Leading notices are dropped only when `historyCursor !== null`; with complete history they stay, including a notice-only session. |
| N4 | All labels come from `noticeLabel()`; no new label vocabulary. `reasonLabel` is derived from the first member so `resume_failed` + `ambiguous` stays "Outcome unknown". |
| N5 | Payload reads are defensive (string-only); missing metrics are omitted, never zero; `subagentCount` excludes a childSessionID equal to the notice's own session; `restartCount` is gated on restart reasons. |
| N6 | The group summary is a native button with `aria-expanded`/`aria-controls`; the controlled region is always rendered with `v-show`; `role="note"` stays only on inner `ChatNoticeRow`s. |
| N7 | No server, API, schema, notice-production, retention, or notice-pagination change. |
| N8 | Scroll anchors stay message-based (`[data-message-id]`); the `v-for` key gains a `message:` prefix but message DOM identity is unchanged; the group key is stable across recomputes. |

### Non-goals

- OMO/system cards, synthetic `Agent error` rows, or any non-notice timeline item.
- Server-side aggregation of interruption notices, dedupe-key changes, payload changes, or the
  50-notice retention.
- Notice pagination or loading older notices with "Load earlier messages".
- A visual redesign beyond the group row; no new colors, typography, or SFC `<style>`.
- Changing the existing singleton `ChatNoticeRow` DOM.
- Committing without an explicit owner instruction.

### Contract freeze

Before Phase A starts, freeze these names and shapes; Phases B/C must not rename them:

```ts
// ui/chat/types.ts
export interface ChatNoticeGroupView {
  readonly id: string;                 // `notice-group:<first notice id>`
  readonly notices: readonly NoticeView[];
  readonly reason: string;
  readonly reasonLabel: string;
  readonly count: number;
  readonly kindBreakdown: readonly { readonly label: string; readonly count: number }[];
  readonly subagentCount: number;
  readonly restartCount: number;
  readonly firstAt: string;
  readonly lastAt: string;
  readonly metricsText: string;
  readonly breakdownText: string;
  readonly timeText: string;
  readonly timeTitle: string;
}

export type ChatThreadItem =
  | { readonly type: "message"; readonly message: ChatMessageView }
  | { readonly type: "notice"; readonly notice: NoticeView }
  | { readonly type: "notice-group"; readonly group: ChatNoticeGroupView };
```

```ts
// ui/chat/notice-groups.ts
export function noticeGroupKey(notice: NoticeView): string;
export function threadItemKey(item: ChatThreadItem): string;
export function buildNoticeTimeline(
  items: readonly ChatThreadItem[],
  options: { readonly historyComplete: boolean },
): ChatThreadItem[];
```

---

## Phase A - Pure projection and types

**Goal:** a testable, renderer-free projection that hides leading notices and groups the rest.

**Files:** `ui/chat/types.ts`, `ui/chat/notice-groups.ts` (new),
`test/ui/chat-notice-groups.test.ts` (new).

**Work items**

A1. Add `ChatNoticeGroupView` and the third `ChatThreadItem` member exactly as frozen above.

A2. Implement `noticeGroupKey(notice)`:
- `reason` when it is a non-empty string;
- else `kind` when it is a non-empty string;
- else `""`.

A3. Implement `threadItemKey(item)`:
- `message:<id>`, `notice:<id>`, `group.id` (already prefixed). No double prefix.

A4. Implement `buildNoticeTimeline(items, { historyComplete })`:
1. If `historyComplete` is false, find the first `message` item. If none, drop all notices; if it is
   at index `> 0`, keep `items.slice(firstMessageIndex)`; if it is at index `0`, keep all.
2. Walk the remaining flat list and accumulate contiguous `notice` runs with the same
   `noticeGroupKey`.
3. Flush a run of 1 as `{ type: "notice", notice }`; flush a longer run as
   `{ type: "notice-group", group: buildGroup(run) }`. A `message` flushes the current run and is
   pushed unchanged.
4. Return a new array; never mutate input.

A5. Implement the group view builder:
- `id = notice-group:${notices[0].id}`; `reason = noticeGroupKey(notices[0])`.
- `mapped = noticeLabel(notices[0])`; `reasonLabel = mapped.reason || mapped.label`.
- `count = notices.length`.
- `kindBreakdown`: first-seen order of `noticeLabel(notice).label`, with counts.
- `subagentCount`: distinct string `payload.childSessionID`, skipping values equal to the notice's
  own string `sessionId`; skip missing/non-string values.
- `restartCount`: only when `reason` is `process_exit`, `operator_restart`, `deployment`, or
  `unknown_restart`; distinct string `payload.runtimeEpoch`; skip missing/non-string.
- `firstAt`/`lastAt`: first/last parseable `createdAt` strings, else `""`.
- `metricsText`: `${count} notice(s)` plus ` · ${subagentCount} subagent(s)` when > 0 and
  ` · ${restartCount} restart(s)` when > 0.
- `breakdownText`: `${label} ×${count}` joined by ` · `.
- `timeText`/`timeTitle`: same calendar day -> `HH:MM-HH:MM` (single `HH:MM` for one minute),
  otherwise `absoluteTime(first) - absoluteTime(last)`; `timeTitle` always the full range. Use
  `absoluteTime` from `ui/format.ts`; invalid dates yield `""`.

A6. Tests (`test/ui/chat-notice-groups.test.ts`):
- mixed `agent_stopped` + `subagent_interrupted` same reason -> one group;
- a message between notices -> two groups; a different reason -> two groups;
- singleton -> plain `notice`;
- leading hiding: incomplete with leading notices before a message -> dropped; complete -> kept;
  no message + incomplete -> all notices dropped; no message + complete -> kept; message at index 0
  -> kept;
- summary: count, kind breakdown, subagent count (including self-child exclusion and two notices
  sharing one `childSessionID` counting once), restart gating (`process_exit` counts,
  `subagent_abort` does not, two notices sharing one `runtimeEpoch` counting once), payload-less
  metrics omitted, pluralization, same-day and cross-day time text, `resume_failed` + `ambiguous`
  -> `reasonLabel === "Outcome unknown"`;
- `threadItemKey` for all three item types.

**Acceptance:** `npm run typecheck:ui` and the new test file pass; no renderer or page change yet.

---

## Phase B - Group component and timeline branch

**Goal:** render a group with the detailed collapsed caption and an accessible expansion.

**Files:** `ui/components/chat/ChatNoticeGroupRow.vue` (new),
`ui/components/chat/ChatThread.vue`, `src/http/styles.css`,
`test/ui/chat-notice-group-row.test.ts` (new).

**Work items**

B1. `ChatNoticeGroupRow.vue`:
- props `{ group: ChatNoticeGroupView }`; local `open = ref(false)`;
  `bodyId = computed(() => `${group.id}-body`)`.
- wrapper `.chat-notice-group` with `:data-notice-group-id="group.id"` and an open modifier class;
- summary uses the existing `.feed-notice` shell with two `.feed-notice__rule` spans and a native
  `<button class="feed-notice__body chat-notice-group__toggle" type="button"
  :aria-expanded="open" :aria-controls="bodyId" :title="group.timeTitle">`;
- inside the button: `.feed-notice__label` = `reasonLabel`, `.feed-notice__reason` = `metricsText`,
  `.chat-notice-group__breakdown` = `breakdownText`, `.chat-notice-group__time` = `timeText`,
  `AppIcon name="chevron-down"` with `class-name="chat-notice-group__chevron"` and `aria-hidden`;
- controlled region `:id="bodyId"` `v-show="open"` `.chat-notice-group__body` containing one
  `ChatNoticeRow` per member, keyed by notice id;
- the wrapper has no role; inner rows keep `role="note"`.

B2. `ChatThread.vue`:
- import `ChatNoticeGroupRow` and `threadItemKey`;
- `:key="threadItemKey(item)"`;
- `v-if="item.type === 'message'"` -> `ChatMessage`;
- `v-else-if="item.type === 'notice'"` -> `ChatNoticeRow`;
- `v-else` -> `ChatNoticeGroupRow :group="item.group"`;
- no scroll-logic change.

B3. CSS in `src/http/styles.css` immediately after the `.feed-notice` block:
- `.chat-notice-group` column layout, full inline size, `gap: var(--space-1)`;
- `.chat-notice-group__toggle` button reset (`margin/padding/border/background/font` inherit), flex
  wrap, centered baseline, `gap: var(--space-1) var(--space-2)`, `cursor: pointer`,
  `min-inline-size: 0`;
- `.chat-notice-group__chevron` 1em, `--text-3`, `transition: transform var(--dur-micro)
  var(--ease-out)`; `.chat-notice-group--open` rotates it 180deg;
- `.chat-notice-group__breakdown`, `.chat-notice-group__time`: `--text-3`, `--text-caption`,
  `line-height: 1.4`;
- `.chat-notice-group__body`: column, `gap: var(--space-1)`, `padding-block: var(--space-1)`.
- No new tokens, no SFC `<style>`.

B4. Component tests:
- summary text contains `reasonLabel`, `metricsText`, `breakdownText`, `timeText`;
- `aria-expanded="false"`, controlled region hidden (`v-show`), `aria-controls` matches the region
  id;
- click -> `aria-expanded="true"`, region visible, one `.chat-notice` per member;
- `title` equals `timeTitle`.

**Acceptance:** `npm run typecheck:ui`, `npm run build` followed by `npm run check:ui`, the
component test, and the existing `chat-page`/`chat-history` tests pass.

---

## Phase C - ChatPage integration and harness

**Goal:** wire the projection into the page and make leading hiding/grouping testable at page level.

**Files:** `ui/pages/ChatPage.vue`, `test/ui/chat-support.ts`,
`test/ui/chat-page.test.ts`, `test/ui/chat-history.test.ts` (only if a regression test is needed).

**Work items**

C1. `ChatPage.vue`: import `buildNoticeTimeline`; return
`buildNoticeTimeline(items, { historyComplete: historyCursor.value === null })` from the existing
`threadItems` computed. Keep the flat `items` construction unchanged. `historyCursor` is reactive,
so the computed updates on page load, tail refresh, and `loadEarlier`.

C2. `test/ui/chat-support.ts`: add to `ChatFixture`:
- `readonly notices?: readonly unknown[];`
- `readonly noticeNextCursor?: string | null;`
and return them from the `/notices` route:
`{ notices: fixture.notices ?? [], nextCursor: fixture.noticeNextCursor ?? null }`.

C3. Page tests (`test/ui/chat-page.test.ts`):
- leading notice hidden: messages with `nextCursor: "cursor-old"` and a notice whose `createdAt`
  precedes the first message -> no `[data-notice-id]` for it; click `[data-chat-load-earlier]` with
  `olderMessages: []` -> `nextCursor` becomes null and the notice appears;
- complete history keeps a leading notice (`nextCursor: null`, notice-only or before the first
  message);
- grouping: three notices with the same reason after a message -> one `.chat-notice-group`,
  `metricsText` contains `3 notices`, clicking expands to three `.chat-notice` rows;
- singleton: one notice -> no `.chat-notice-group`, `.chat-notice` still present;
- the existing stream-warning test (`chat-page.test.ts:156-174`) still finds `.chat-notice`.

C4. History/scroll: the existing `chat-history` paging and scroll tests must stay green. Add one
transition regression test for the stale-null cursor branch (`ChatPage.vue:1563`) if the existing
harness can drive a tail refresh that changes the cursor; otherwise record the branch as covered by
the pure `historyComplete` tests and note the limitation in the journal.

**Acceptance:** `npm run typecheck:ui`, `npm run check:ui`, `test/ui/chat-page.test.ts`,
`test/ui/chat-history.test.ts`, and the full `npm test` pass.

---

## Phase D - Record and full verification

**Files:** `docs/design/README.md`, `docs/plans/README.md`, `docs/open-questions.md`,
`docs/journal/0047-chat-notice-grouping.md` (new), `docs/journal/README.md`.

**Work items**

D1. Update/confirm the pre-seeded design and plan index entries and their status.
D2. Update/confirm the stage-0039 resolved owner decisions in `docs/open-questions.md`.
D3. Write the journal entry: context, what changed, decisions and why, files, verification output,
   accepted limits (50-notice cap, no notice paging, unseen undercount, same-ms split), and the
   deferred `docs/current-state.md` update if the worktree still has unrelated uncommitted changes.
D4. Update the journal index.
D5. Run the full gate set and record the output:

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

`check:ui` reads the git-ignored `assets/app.css` and `assets/ui/.vite/manifest.json`, so `build`
must run first (the same order as CI and AGENTS.md).

The optional `node docs/design/process-protection-qa.mjs` currently fails at `gotoChat` on the stale
legacy `#chat-prompt` selector, before any notice assertion; record it as a pre-existing harness
failure, not a stage regression. The route gate is `npm run test:e2e`.

**Acceptance:** every gate is green or a pre-existing failure is explicitly identified; the record
and all configured indexes are updated.

---

## Risks

| Risk | Mitigation |
| --- | --- |
| Leading hide hides a legitimate notice | Only while `historyCursor !== null`; it reappears when the cursor becomes null; test both directions. |
| Template key/`v-else` breaks on the new union member | Phase B uses `threadItemKey` and explicit branches; component + page tests cover rendering. |
| Summary label regression (`resume_failed`/`ambiguous`) | `reasonLabel` from `noticeLabel(first)`; explicit test. |
| Misleading metrics | Self-child exclusion, restart-reason gating, defensive payload reads; tests. |
| Scroll/unseen regression | Message anchors unchanged; existing history/scroll tests; group adds 0 to unseen when it grows. |
| QA selector drift | Existing QA fixtures form no groups; the process-notice harness currently fails on a stale `#chat-prompt` selector before notice assertions (pre-existing). The route gate is `test:e2e`; a refreshed harness needs the documented `feedSnapshot` update if a grouped scenario is added. |
| Worktree contains unrelated uncommitted changes | Touch only this stage's files; do not commit without explicit instruction; note any deferred current-state update. |

## Plan review

Round 1 (`momus`, 2026-11-09): **CHANGES REQUESTED**. Findings folded:

1. MEDIUM - design status line contradicted the cleared gate -> design header is now `cleared`.
2. MEDIUM - `check:ui` ran before `build` -> Phase B acceptance and D5 now run `build` first.
3. LOW/MEDIUM - N8 said message keys are unchanged while A3 adds a `message:` prefix -> N8 now
   distinguishes DOM identity/anchors from the `v-for` key.
4. Optional strengthening - distinct dedupe not asserted -> A6 now covers two notices sharing one
   `childSessionID`/`runtimeEpoch`.
5. Minor - D1/D2 said "Add" for pre-seeded entries -> reworded to "Update/confirm".

Round 2 (`momus`, 2026-11-09): **OKAY**. All five checks pass; no remaining blocking findings.
Implementation and verification are recorded in journal 0047.
