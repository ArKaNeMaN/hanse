# Journal 0047 - Chat notice grouping and leading-notice hiding

Stage: `0039-chat-notice-grouping` (design
[`docs/design/chat-notice-grouping.md`](../design/chat-notice-grouping.md), plan
[`docs/plans/0039-chat-notice-grouping.md`](../plans/0039-chat-notice-grouping.md)).
Date: 2026-11-09.

## Context

The owner showed a chat timeline where one runtime stop/restart produced a wall of full-width
`SUBAGENT INTERRUPTED / Process exited` divider rows. The rows are persisted `session_notices`, not
messages: one `agent_stopped` on the interrupted session plus one `subagent_interrupted` on the
parent per active child, all sharing one `createdAt` but ordered by random UUID. Repeated restarts
create a new rollup per child per runtime epoch. The owner asked to group these dividers and to hide
dividers that sit above the first locally loaded message while an older message chunk is still
unloaded.

## What changed

- **Pure projection.** `ui/chat/notice-groups.ts` hides leading notices while
  `historyCursor !== null`, then groups maximal contiguous notice runs with the same normalized
  cause (`reason`, else `kind`, else `""`). A message breaks a run; a run of one stays a plain
  notice. A group carries the cause label, notice/subagent/restart counts, per-kind breakdown, and a
  same-day or cross-day time range. Labels come from the existing `noticeLabel()`; payload reads are
  string-only and defensive; `subagentCount` excludes a self-referential child row; `restartCount`
  is gated on restart reasons and distinct runtime epochs.
- **Types.** `ChatNoticeGroupView` and the third `ChatThreadItem` member (`notice-group`).
- **UI.** `ChatNoticeGroupRow.vue` renders the existing `.feed-notice` divider shell as a native
  toggle with `aria-expanded`/`aria-controls`, a detailed two-line caption, and a `v-show` region
  containing the original `ChatNoticeRow` members. `ChatThread.vue` uses `threadItemKey()` and
  explicit message/notice/group branches. New `.chat-notice-group*` styles use existing tokens only.
- **Page.** `ChatPage.vue` runs `buildNoticeTimeline(items, { historyComplete: historyCursor ===
  null })` in the existing `threadItems` computed. No feed-store, cursor, SSE, or server change.
- **Tests.** New pure-projection tests (25), a group-row component test, and five page tests
  (leading hide/reveal, complete-history keep, notice-only, grouping, singleton). The history suite
  gained a stale-null cursor transition test. `test/ui/chat-support.ts` can seed notices.
- **Docs.** Design/plan indexes, the stage-0039 owner decisions, this journal, and the journal index.

## Decisions

- Group by normalized `reason`, not `kind`: within one stop batch the order is random, so
  `agent_stopped` can sit in the middle of the `subagent_interrupted` run.
- Leading hide keys off the **messages** cursor (`historyCursor`), not the notices response; the
  notices endpoint is independent and capped at 50.
- A singleton is a plain `notice` item, preserving the existing `ChatNoticeRow` DOM and the
  stream-warning test.
- `reasonLabel` is derived from the first member through `noticeLabel()` so
  `resume_failed` + `ambiguous` stays "Outcome unknown".
- No time window: adjacency in the sorted feed is the grouping boundary.
- The group summary shell is `.feed-notice chat-notice`; the controlled region is always rendered
  with `v-show`, so QA can still query every `[data-notice-id]`.

## Verification

- Design: `oracle` Round 1 **CHANGES REQUESTED**, Round 2 **CHANGES REQUESTED**, Round 3
  **CHANGES REQUESTED** (documentation only). All findings are folded; the gate is cleared with no
  material change after Round 3.
- Plan: `momus` Round 1 **CHANGES REQUESTED**, Round 2 **OKAY** (findings folded).
- `npm run lint` green.
- `npm run typecheck` green.
- `npm run typecheck:ui` green.
- `npm test`: **251 files passed, 1 skipped; 3637 tests passed, 1 skipped** (the skip is the
  pre-existing Docker reaper integration test).
- `npm run build` green; `npm run check:ui` green (80 SFCs, CSS sentinel present, chat chunk
  76,196 B gzip).
- `npm run check:sensitive` green.
- `npm run test:e2e`: **130 passed, 1 skipped** (the skip is the pre-existing legacy settings
  redirect case). The `/chat` notice rendering case is
  `e2e/spa-chat.spec.ts:609-662`.
- Optional `node docs/design/process-protection-qa.mjs`: **FAIL before notice assertions** at
  `gotoChat`, waiting for the removed legacy `#chat-prompt` selector. This is a pre-existing harness
  failure from the SPA cutover, not a stage regression; the route gate is `npm run test:e2e`.

## Accepted limits

- Notices remain capped at the latest 50 per session; "Load earlier messages" does not page notices,
  so grouping cannot span notices that were never loaded.
- A notice that joins an existing group adds 0 to `items.length`, so the "New messages (N)" badge
  does not increment for it. Accepted, newly introduced by grouping.
- A message created in the same millisecond as a notice batch can tie-break between two same-reason
  notices and split the run. Accepted.
- The group id is `notice-group:<first notice id>`; inserting a same-timestamp notice before the
  first member resets the open state to collapsed. Accepted.
- `docs/current-state.md` was not updated because the worktree already contains unrelated
  uncommitted changes to it; the behavior is recorded here and in the design. A follow-up should add
  one line to the canonical current-state chat section once those changes land.

## Open threads

- No commit was made; the owner has not authorized one.
- The process-protection QA harness needs a separate refresh from legacy selectors (`#chat-prompt`,
  `#chat-message-count`) before it can exercise notice grouping.
