# 0042 - Thread chat rendering and the agent-to-agent question ban

Stage: `0035-thread-chat-rendering`
Design: [`docs/design/thread-chat-rendering.md`](../design/thread-chat-rendering.md) (`oracle` PASS)
Plan: [`docs/plans/0035-thread-chat-rendering.md`](../plans/0035-thread-chat-rendering.md) (`momus` PASS)
ADR: [`docs/decisions/0017-thread-message-rendering.md`](../decisions/0017-thread-message-rendering.md)
Commit: `<commit-hash>`

## What shipped

Handoff-thread messages now render in the destination chat as subtler agent-authored cards instead of
looking like operator input, and agent-to-agent interactive questions are removed from thread target
sessions. The work is additive: one-shot handoff metadata, card DOM, projection, prompts, lifecycle,
dispatch, and reply behavior are unchanged, and the database remains at schema v22.

### Phase A - server projection and body extraction

- `HandoffMessageMeta` gains optional `mode: "thread"`, `kind`, `authorSide`, `messageId`, and `seq`.
  One-shot `metaFor`/`messageMap` never assign them.
- The live resolver queries `handoff_messages` by `delivery_message_id` first (thread wins a synthetic
  id collision), returns body-less thread meta, and otherwise runs the unchanged one-shot query. The
  positive cache and its bound are reused.
- History projection keeps the one-shot query/map and adds a `delivery_session_id` + page-id thread
  query with 500-id chunking, annotating by thread-first precedence
  (`threadMap.get(id) ?? oneShotMap.get(id)`).
- Author keys come from `author_app_id` with the participant/fallback chain; thread rows keep every
  one-shot routing column null. Thread replies carry `outcome`; requests/messages do not. Thread meta
  never carries an operator note.
- `handoffBodyFromText` normalizes CRLF and enters the thread branch only when the first non-empty line
  is a thread marker. Start/reply drop the `Summary:` block through the first blank line; message
  returns the fenced content; missing marker/fence returns `""`. The one-shot
  `Specification:`/`Result:` path is unchanged.

### Phase B - client types, ChatPage, thread card, styles

- `ChatHandoffView` gains the five optional thread fields.
- `ChatPage.normalizeHandoffMetadata` passes the fields through, prefers the projected server body,
  falls back to `handoffBodyFromText` for live frames, and sets `note = ""` without calling
  `handoffNoteFromText` for `mode === "thread"`. The one-shot body/note path is unchanged.
- `HandoffCard` keeps the existing one-shot branch byte-identical and adds a thread branch with
  `data-mode="thread"`, `data-kind`, `data-seq`, `data-direction`, reply-only `data-outcome`,
  `role="group"`, and the exact aria-label. It shows the `Thread` badge, author, kind label, `#<seq>`,
  route, reply outcome, summary, sealed body, and long-body disclosure, and never renders the operator
  note block.
- Thread CSS uses existing tokens only (`--surface-1`, `--text-2`, `--wash-1`, `--line`); no brass,
  stripe, shadow, or new radius. `ChatMessage` needed no change: any handoff already suppresses the
  operator bubble, meta row, and parts.

### Phase C - question guard, SSE/prompts suppression, prompt line

- `HandoffDispatcher.observe` handles `question.asked` before the tool-part path. It dedupes by
  `${app.id}:${request.key}`, resolves the observed session to its durable root (depth 8), and applies
  source-first precedence before the target check.
- Only a root that is the target of an `in_progress` thread is auto-rejected. v2 uses the exact
  observed session id (`rejectQuestionV2`), so target subagents are covered; v1 uses the request id
  (`rejectQuestion`). 404/409 and other reject races are swallowed with no retry. Logs contain only app
  id, short session id, source, and status.
- Source, operator, unrelated, terminal, one-shot, and `permission.asked` paths never reject. An
  unresolved endpoint or root fails open with one bounded warning.
- `streamAppEvents` drops `question.asked` for a dispatcher-known thread target root; terminal question
  events, permissions, and source/unresolved sessions forward. `handlePromptsList` applies the same
  read-only filter to v1/v2 question arrays when a dispatcher is present.
- The exact question-ban line is added to the target-facing thread start and follow-up prompts only.
  The source-facing reply prompt and every one-shot prompt are unchanged; permissions stay allowed.

## Owner decisions and deferred scope

- Keep `HandoffCard` as one component with a thread variant; do not add a second card.
- Server metadata is authoritative for thread identity; text parsing only supplies the display body.
- The question ban is a target-session policy in the dispatcher, not a global permission deny and not
  prompt-only. SSE/prompts filtering is visibility hygiene; the auto-reject is the unblock.
- Deferred: thread-management UI/routes, operator-created threads, session reuse, target-initiated
  messages, attachments through threads, worktree isolation, per-thread agents, and any schema change.

## Security notes

- Thread bodies remain untrusted sibling content: the card renders them as sealed Markdown, and body
  parsing never affects author, thread, kind, sequence, or route.
- Question guard logs carry no question text, answers, request id, or full session id. The guard fails
  open on unresolved endpoint/root, and a human-answer race is a swallowed 404/409.
- The question ban is policy, not a hard boundary: an agent that bypasses the question tool or calls
  the loopback directly is outside this guard.
- No credentials or deployment data were added to tracked files; E2E fixtures are synthetic.

## Verification

- Phase A gate: `npm run lint && npm run typecheck &&
  npx vitest run test/handoff-messages.test.ts test/chat-core.test.ts` - green.
- Phase B gate: `npm run lint && npm run typecheck && npm run typecheck:ui &&
  npx vitest run test/ui/chat-cards.test.ts test/ui/chat-message.test.ts
  test/chat-page.test.ts test/chat-feed-store.test.ts` - green, plus the UI ChatPage and Pinia
  feed-store equivalents.
- Phase C gate: `npm run lint && npm run typecheck &&
  npx vitest run test/handoff-dispatcher.test.ts test/prompts-http.test.ts` - green after rerunning an
  unrelated pre-existing flake in `handoff thread lifecycle > garbage-collects terminal threads`
  (identical `updated_at` plus random ids makes the `gcBatch=1` selection order nondeterministic).
- Stage gate: `npm run lint`, `npm run typecheck`, `npm run typecheck:ui`, `npm test`, `npm run build`,
  `npm run check:ui`, `npm run check:sensitive`, and `npm run typecheck:e2e` passed. `npm run test:e2e`
  ran the full matrix: 216 passed, 3 skipped, with one unrelated pre-existing failure
  `e2e/app.spec.ts:10 > renders the application runtime strip and git/image panels` (the
  `Repository` heading is hidden because commit `26f59f8` made application-page blocks collapsed and
  that spec was not updated). The stage's own `e2e/spa-chat.spec.ts` thread-card assertions passed.
- The stage also removed a pre-existing nondeterministic failure in
  `test/handoff-dispatcher.test.ts > handoff thread lifecycle > garbage-collects terminal threads`
  by giving the two fixture headers distinct old timestamps; the assertions were not weakened.
- The deterministic `/chat` E2E seeds a real thread header plus its initial `handoff_messages` row and
  asserts `data-mode="thread"`, author `alpha`, the `Thread` chip, `#1`, the body, the summary, and the
  absence of the operator bubble. Existing one-shot card assertions remain green.

## Residual risks

- A live thread card is body-less; the client extracts the display body from envelope text. An
  unrelated enrichment can push a frame over the 8 KiB cap, losing the live card for that frame while
  history still projects it.
- Suppression applies only when a dispatcher is present. A degraded coordinator without one leaves
  questions visible/answerable, matching the missing server guard.
- Questions are rare, so `shouldSuppressQuestion` is per-event with no cache; a cache added later must
  preserve fail-open behavior.
