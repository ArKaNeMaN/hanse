# Plan 0035 - Thread chat rendering and the agent-to-agent question ban

Status: **ready for implementation** - design approved (`oracle` PASS after blocker fixes); plan
review PASS (`momus`). Implementation has not started.

## Bindings

- Stage: `0035-thread-chat-rendering`
- Design: `docs/design/thread-chat-rendering.md` (approved; `oracle` PASS after blocker fixes)
- Design reviewer: `oracle`; Plan reviewer: `momus`
- Open questions: `docs/open-questions.md` stage `0035-thread-chat-rendering` (resolved; none)
- Journal: `docs/journal/0042-thread-chat-rendering.md` (new)
- ADR: `docs/decisions/0017-thread-message-rendering.md` (new)
- Indexes: `docs/design/README.md`, `docs/plans/README.md`, `docs/journal/README.md`,
  `docs/current-state.md` (record phase)
- Verification: `npm run lint`, `npm run typecheck`, `npm run typecheck:ui`, `npm test`,
  `npm run build`, `npm run check:ui`, `npm run check:sensitive`, `npm run test:e2e` (mandatory:
  `HandoffCard.vue` and `styles.css` change the rendered `/chat` route)
- Commit policy: one coherent stage commit after all gates; no push unless explicitly asked.

## 1. Goal

Render committed stage-0034 thread messages in the destination chat as messages from the sending
agent, visually subtle versus operator input, using the existing `HandoffCard` vocabulary with a
thread variant. Source-authored rows read as requests/messages from the source app; target-authored
rows read as replies from the target app. Forbid agent-to-agent interactive questions in thread
target sessions by auto-rejecting `question.asked` v1/v2 for an in-progress thread target root
(including target subagents), and suppress that question from the human SSE stream and the
`/api/apps/:app/prompts` hydration read when a dispatcher is present.

One-shot handoff cards, projection, prompts, lifecycle, and public behavior remain byte-compatible.
Thread metadata is additive. No DB migration.

### Non-goals / deferred

- No DB migration, schema bump, trigger, index, or backfill (schema stays v22).
- No thread-management UI; no operator thread create, close, retry, relaunch, retarget, list,
  composer, or attachment affordance.
- No target-initiated messages or attachments; no worktree isolation.
- No session reuse; a fresh target session per thread remains the stage-0034 lifecycle.
- No question ban in source, operator, unrelated, terminal, or one-shot sessions; no
  `permission.asked` ban; tool approvals stay available.
- No change to one-shot meta shape, card DOM, prompts, dispatch/reply, or public routes.

## 2. Decisions carried from the design

1. **D1 - additive thread meta.** Extend `HandoffMessageMeta` with optional `mode: "thread"`,
   `kind: "request" | "message" | "reply"`, `authorSide: "source" | "target"`, `messageId: number`,
   `seq: number`. One-shot `metaFor` assigns none of them. No `operatorNote` on thread meta.
2. **D2 - server-side live and history projection.** Live resolver queries `handoff_messages` by
   `delivery_message_id` first, then falls through to the unchanged one-shot query. History keeps the
   one-shot query and adds a `delivery_session_id` + page-id query, annotating with thread precedence
   `threadMap.get(id) ?? oneShotMap.get(id)`.
3. **D3 - one card, thread variant.** Reuse `HandoffCard` with a branch on `handoff.mode ===
   "thread"`; add `Thread` chip, author key, kind label, sequence, route, reply-only outcome. Keep
   avatar, summary, sealed Markdown body, long-body disclosure, inbox link. No operator note block.
   No operator `message--user` bubble (existing `ChatMessage` rule already excludes any handoff).
4. **D4 - history body from DB, live body from envelope text only.** History meta carries bounded
   `handoff_messages.body`; live meta omits it and the client extracts the display body from the
   message text. Extraction is display-only; identity always comes from server metadata.
5. **D5 - target-session question guard in the dispatcher.** `HandoffDispatcher.observe` handles
   `question.asked` before its tool-part early return, resolves the observed session to its durable
   root, and auto-rejects only when the root is the target of an `in_progress` `mode='thread'`
   handoff and is not also a thread source root. v2 uses the exact observed session; v1 uses the
   request id. Dedupe, swallow 404/409, log fixed metadata only, fail open on unresolved
   endpoint/root.
6. **D6 - SSE and prompts-list suppression.** `streamAppEvents` drops `question.asked` for a thread
   target root only when `deps.dispatcher` is present. `handlePromptsList` applies the same filter to
   the v1/v2 question arrays. Source/operator/unrelated/unresolved/terminal questions forward. This
   is visibility hygiene; the server auto-reject is the unblock.
7. **D7 - target-facing prompt instruction only.** Add the exact question-ban line to
   `#threadStartPrompt` and `#threadFollowUpPrompt`. Do not add it to `#threadReplyPrompt` or any
   one-shot prompt. `permission.asked` stays allowed.
8. **D8 - no schema or lifecycle expansion.** Reuse `delivery_message_id` (unique partial index),
   `delivery_session_id` (index), and the existing thread lifecycle.

## 3. Invariants

- Server metadata is authoritative for thread identity; text parsing only derives the display body.
  A thread meta never carries an operator note.
- One-shot meta shape and card rendering are unchanged; the five thread fields are absent for
  one-shot rows. Thread rows continue to leave every one-shot routing column null.
- A thread card exists only when a page message id equals a non-null
  `handoff_messages.delivery_message_id` for a thread row.
- `direction` is `request` for `author_side='source'` and `reply` for `author_side='target'`; `kind`
  is the row kind; `messageId` is the numeric row id; `seq` is the positive sequence.
- The guard runs only for `question.asked` (never `permission.asked` or terminal question events)
  and rejects only a root that is the target of an `in_progress` thread. A source root is never
  rejected, even in the pathological source+target overlap (source-first precedence).
- The guard and SSE filter fail open on an unresolved endpoint or root. No question text, answer
  text, or request payload reaches logs.
- No schema bump; the database stays at v22.

## 4. Contracts

### 4.1 Exact thread meta JSON

Source-authored follow-up in history (`delivery_message_id` match):

```json
{
  "id": "hd_01J...",
  "direction": "request",
  "agent": "billing",
  "from": "billing",
  "to": "ops",
  "state": "in_progress",
  "summary": "Reconcile invoice totals",
  "outcome": null,
  "replyState": "none",
  "origin": "agent",
  "mode": "thread",
  "kind": "message",
  "authorSide": "source",
  "messageId": 17,
  "seq": 5,
  "body": "The March totals still disagree by 0.02."
}
```

Target reply in history:

```json
{
  "id": "hd_01J...",
  "direction": "reply",
  "agent": "ops",
  "from": "billing",
  "to": "ops",
  "state": "in_progress",
  "summary": "Reconcile invoice totals",
  "outcome": "completed",
  "replyState": "none",
  "origin": "agent",
  "mode": "thread",
  "kind": "reply",
  "authorSide": "target",
  "messageId": 18,
  "seq": 6,
  "body": "Reconciled; the mismatch was a rounding row."
}
```

Live metadata is the same object with `body` omitted and never an operator note. `id` is the thread
id (`handoffs.id`), not the numeric message id; `messageId` is the numeric row id used for debugging
and `data-message-id` correspondence. TypeScript shape added to `HandoffMessageMeta`
(`src/coordinator/handoff-messages.ts`):

```ts
mode?: "thread";
kind?: "request" | "message" | "reply";
authorSide?: "source" | "target";
messageId?: number;
seq?: number;
```

### 4.2 Exact live resolver query

`createHandoffEventResolver` runs this query first; a hit returns thread meta without running the
one-shot query. A miss falls through to the existing one-shot query unchanged. The existing
positive-result cache and its bound are reused; thread wins an id collision.

```sql
SELECT
  m.id AS message_pk,
  m.handoff_id,
  m.kind,
  m.author_side,
  m.author_app_id,
  m.body,
  m.outcome,
  m.seq,
  m.delivery_message_id,
  h.state AS header_state,
  h.summary AS header_summary,
  h.origin AS header_origin,
  h.reply_state AS header_reply_state,
  h.from_app_id,
  h.to_app_id,
  COALESCE(
    a.app_key,
    CASE m.author_side WHEN 'source' THEN f.app_key ELSE t.app_key END,
    CASE m.author_side WHEN 'source' THEN h.from_app_id ELSE h.to_app_id END
  ) AS author_key,
  COALESCE(f.app_key, h.from_app_id) AS from_key,
  COALESCE(t.app_key, h.to_app_id) AS to_key
FROM handoff_messages m
JOIN handoffs h ON h.id = m.handoff_id
LEFT JOIN apps a ON a.id = m.author_app_id
LEFT JOIN apps f ON f.id = h.from_app_id
LEFT JOIN apps t ON t.id = h.to_app_id
WHERE m.delivery_message_id = ?
  AND m.kind IN ('request', 'message', 'reply')
  AND m.author_side IN ('source', 'target')
LIMIT 1
```

Live thread meta is body-less, so it fits under the existing 8 KiB enriched-event cap. If an
unrelated enrichment pushes the event over the cap, the live card is skipped for that frame and
history still shows it (accepted residual).

### 4.3 Exact history projection query

`projectHandoffMessages` keeps its one-shot select/join/query and `messageMap` as today. It then
runs:

```sql
SELECT
  m.id AS message_pk,
  m.handoff_id,
  m.kind,
  m.author_side,
  m.author_app_id,
  m.body,
  m.outcome,
  m.seq,
  m.delivery_message_id,
  h.state AS header_state,
  h.summary AS header_summary,
  h.origin AS header_origin,
  h.reply_state AS header_reply_state,
  h.from_app_id,
  h.to_app_id,
  COALESCE(
    a.app_key,
    CASE m.author_side WHEN 'source' THEN f.app_key ELSE t.app_key END,
    CASE m.author_side WHEN 'source' THEN h.from_app_id ELSE h.to_app_id END
  ) AS author_key,
  COALESCE(f.app_key, h.from_app_id) AS from_key,
  COALESCE(t.app_key, h.to_app_id) AS to_key
FROM handoff_messages m
JOIN handoffs h ON h.id = m.handoff_id
LEFT JOIN apps a ON a.id = m.author_app_id
LEFT JOIN apps f ON f.id = h.from_app_id
LEFT JOIN apps t ON t.id = h.to_app_id
WHERE m.delivery_session_id = ?
  AND m.delivery_message_id IN (?, ?, ...)
  AND m.kind IN ('request', 'message', 'reply')
  AND m.author_side IN ('source', 'target')
```

- The `IN` list is the page's message ids; chunk at 500 per statement when a full-history page would
  exceed SQLite's variable limit, then merge the maps.
- Keep the existing `if (rows.length === 0) return;` guard: the one-shot query also matches thread
  headers through `source_session_id`/`target_session_id`, so a thread session yields nonzero rows.
  If the one-shot query is later scoped to `mode='one_shot'`, move the guard after the thread query.
- Annotation iterates user messages only: `const meta = threadMap.get(message.info.id) ??
  oneShotMap.get(message.info.id);` and preserves existing `info.hanse` fields when setting `handoff`.

### 4.4 Exact field mapping

`threadMetaFor(row, includeBody)` produces `HandoffMessageMeta`:

| Meta field | Source |
| --- | --- |
| `id` | `m.handoff_id` |
| `direction` | `m.author_side === "target" ? "reply" : "request"` |
| `agent` | `author_key` (author app key, fallback by author side to participant app key, then app id) |
| `from` | `from_key` (thread source participant) |
| `to` | `to_key` (thread target participant) |
| `state` | `header_state` |
| `summary` | `boundedSummary(header_summary)` (max 500 chars, same truncation as one-shot) |
| `outcome` | `m.kind === "reply" ? m.outcome : null` |
| `replyState` | `header_reply_state` |
| `origin` | `header_origin` |
| `body` | `includeBody ? capUtf8(m.body, 32 * 1024) : undefined` |
| `mode` | `"thread"` |
| `kind` | `m.kind` |
| `authorSide` | `m.author_side` |
| `messageId` | `m.id` (number) |
| `seq` | `m.seq` |
| `operatorNote` | absent, always |

Rows with a null `delivery_message_id`, a non-thread kind, or `system` author side are not mapped. A
deleted author app leaves `author_app_id` null; the `COALESCE` falls back to the participant key/id
for the recorded side.

### 4.5 Exact body extraction rules

`handoffBodyFromText(text, direction)` keeps its signature. Normalize CRLF to LF and enter the thread
branch only when the **first non-empty line** is exactly one of the thread envelope markers.

1. `[Hanse handoff thread start]`: take the content strictly between the
   `UNTRUSTED CONTENT BEGIN <nonce>` line and the next `UNTRUSTED CONTENT END <nonce>` line; drop the
   `Summary:` line and everything through the first following blank line (a multi-line summary is
   fully removed); return the remainder trimmed.
2. `[Hanse handoff thread message]`: take the fenced content; return it trimmed, dropping no line.
3. `[Hanse handoff thread reply]`: take the fenced content; drop the `Summary:` line and everything
   through the first following blank line; return the remainder trimmed.
4. Otherwise use the existing one-shot `Specification:` / `Result:` extraction unchanged.
5. Missing marker or either fence line returns `""`.

The first-non-empty-line gate keeps a one-shot prompt that merely quotes a thread marker in its
`Summary:`, `Specification:`, or `Result:` on the one-shot path. Fence markers and the nonce are
never returned; body content is not unescaped. `handoffNoteFromText` is unchanged and is never called
for `mode === "thread"`; a thread body containing `Operator note (trusted):` cannot create a note.

### 4.6 Exact client normalization and types

`assets/chat-core.js` `normalizeHandoffMeta` accepts these optional fields with bounds; invalid
values are omitted:

| Field | Accepted value |
| --- | --- |
| `mode` | exactly `"thread"` |
| `kind` | exactly `"request"`, `"message"`, or `"reply"` |
| `authorSide` | exactly `"source"` or `"target"` |
| `messageId` | finite integer `> 0` |
| `seq` | finite integer `> 0` |

Existing fields keep their current validation and bounds. `assets/chat-core.d.ts` keeps
`normalizeHandoffMeta` as `Record<string, unknown> | null` (no field list needed) and keeps the
`handoffBodyFromText`/`handoffNoteFromText` signatures unchanged. `ui/chat/types.ts`
`ChatHandoffView` gains the same five optional fields. `ui/pages/ChatPage.vue`
`normalizeHandoffMetadata` passes the five fields through, still prefers a non-empty server `body`,
falls back to `handoffBodyFromText(recordTextContent(record), direction)`, and for `mode ===
"thread"` sets `note = ""` and never calls `handoffNoteFromText`. One-shot body/note fallback is
unchanged. `ui/stores/chat-feed.ts` needs no functional change; its merge keeps a previously
projected body when a live frame arrives without one and never invents a note.

### 4.7 Exact `HandoffCard` thread branch and CSS

One-shot branch: template, classes, attributes, and order unchanged. Thread branch
(`handoff.mode === "thread"`) keeps the existing `.handoff-card` root and `__head`, then renders the
`Thread` badge, author, kind label, sequence, route, reply-only outcome, inbox link, summary, the
same sealed body/disclosure, and no note block. Exact rules:

- `data-handoff-card` present in both modes; `data-mode="thread"` only for thread meta.
- `data-kind` is the raw kind; visible label is `Request`, `Message`, or `Reply`.
- `data-seq` is numeric; visible label is `#<seq>`.
- `data-thread-author` is the author app key with `.mono`; `data-thread-chip` is the visible `Thread`
  badge.
- `role="group"` and the exact `aria-label` are thread-only; avatar stays `aria-hidden="true"`.
- Outcome chip appears only for `kind === "reply"` with non-null outcome. Route always shows
  `from → to`; author is not inferred from the route.
- Inbox link, summary, sealed `MarkdownBlock` body, long-body `details`/preview, and "No handoff body
  is available yet." fallback are identical to one-shot.
- The note block (`handoff-card__note`) is rendered only in the one-shot branch, even if `note` is
  non-empty.

CSS additions in `src/http/styles.css` use existing tokens only:

```css
.handoff-card[data-mode="thread"] { background: var(--surface-1); }
.handoff-card__author, .handoff-card__seq { color: var(--text-2); }
.handoff-card[data-mode="thread"] .handoff-card__kind {
  background: var(--wash-1); border-color: var(--line); color: var(--text-2);
}
```

No brass, colored side stripe, shadow, new radius, or whole-card hover. The card keeps
`--radius-md`; the chip uses the existing `.badge` treatment.

### 4.8 Exact question guard algorithm

`HandoffDispatcher.observe` becomes, in effect:

1. If `event.type === "question.asked"`, call `#observeThreadQuestion(app, event.request)` and return.
2. Otherwise keep the existing `message.part.updated` + tool-part logic unchanged.

`#observeThreadQuestion`:

- key = `${app.id}:${request.key}`; if `#seenQuestions` already has it, return; otherwise
  `rememberBounded(this.#seenQuestions, key)`.
- Fire-and-forget `#rejectThreadQuestion(app, request)`; a rejected promise logs
  `thread question failed app=<id> status=error` and nothing else.

`#rejectThreadQuestion(app, request)`:

1. `endpoint = this.#manager.endpointFor?.(app.id)`; `undefined` -> log `no_endpoint` and return.
2. `resolved = await this.#resolveSessionRoot(app.id, request.sessionID)`; `undefined` -> log
   `unresolved` and return.
3. `root = resolved.rootId`; if `#isThreadSourceRoot(root)` -> log `source` and return (source-first
   precedence wins even if the same root is also a target).
4. If `! #isThreadTargetRoot(root)` -> return with no log (not a target; nothing to do).
5. Reject: `request.source === "v2"` -> `await this.#client.rejectQuestionV2(endpoint,
   request.sessionID, request.id)`; every other source -> `await this.#client.rejectQuestion(endpoint,
   request.id)`. The v2 path uses the exact observed session id, so a target subagent is rejected
   correctly.
6. Log `thread question app=<id> session=<shortId(request.sessionID)> source=<source>
   status=rejected`. On a thrown error, `status = error instanceof OpencodeHttpError ?
   error.status : "error"` and log that; 404/409/human-race is swallowed with no retry. Never log
   `request.id`, question text, answers, or the full session id.

Exact membership queries:

```sql
-- source check first
SELECT 1 FROM handoffs
WHERE mode = 'thread' AND state = 'in_progress' AND source_session_id = ?
LIMIT 1;

-- target check
SELECT 1 FROM handoffs
WHERE mode = 'thread' AND state = 'in_progress' AND target_session_id = ?
LIMIT 1;
```

`#resolveSessionRoot(appId, sessionID): Promise<{ rootId: string; title: string | null } |
undefined>` is the current `#resolveObservedRoot` body generalized with `HANDOFF_THREAD_ROOT_DEPTH =
8`: get `endpointFor(appId)`, `listSessions(endpoint)`, walk `parentID`; return `undefined` on a
missing session, missing parent, cycle, or depth overflow. `#resolveObservedRoot(observation)`
delegates to it with `observation.appId`/`observation.sessionId` and preserves `title` for stage-0034
binding.

`HandoffDispatcherClient` gains the two existing functions; `DEFAULT_CLIENT` imports them from
`src/opencode/client.ts` (no new client behavior there):

```ts
rejectQuestion(endpoint: string, requestId: string): Promise<boolean>;
rejectQuestionV2(endpoint: string, sessionId: string, requestId: string): Promise<void>;
```

The guard ignores terminal threads (`state !== 'in_progress'`), one-shot handoffs, operator/unrelated
sessions, and every `permission.asked` event.

### 4.9 Exact SSE and prompts-list suppression

In the `streamAppEvents` event loop, before `await write(emit(event))`:

- If `event.type === "question.asked"` and `deps.dispatcher !== undefined` and
  `await deps.dispatcher.shouldSuppressQuestion(found.app.id, event.request.sessionID)` is true,
  `continue`.
- `deps.dispatcher === undefined` -> no suppression. `permission.asked`, `question.replied`, and
  `question.rejected` are forwarded unchanged.
- A source root, operator session, unrelated session, terminal thread, or unresolved root forwards.

Public read-only method:

```ts
async shouldSuppressQuestion(appId: string, sessionId: string): Promise<boolean> {
  const resolved = await this.#resolveSessionRoot(appId, sessionId);
  if (resolved === undefined) return false;      // fail open
  const root = resolved.rootId;
  if (this.#isThreadSourceRoot(root)) return false;
  return this.#isThreadTargetRoot(root);
}
```

`/api/apps/:app/prompts` hydration (`handlePromptsList`) applies the same
`shouldSuppressQuestion(found.app.id, request.sessionID)` filter to the combined v1/v2 question
arrays when `deps.dispatcher` is present. It does not reject or mutate; it only drops target-root
questions from the read. No cache is required; if one is added later it must not change fail-open
behavior.

### 4.10 Exact target-facing prompt line

Add this exact line to `#threadStartPrompt` and `#threadFollowUpPrompt` immediately after
`Do not call send_handoff_message; the target side replies only.`:

```text
Do not use the interactive question tool in this thread. If you are blocked, reply with deliver_handoff using outcome "blocked" and put your question in result.
```

Do not add it to `#threadReplyPrompt` or any one-shot prompt. `permission.asked` remains allowed.

### 4.11 No migration and no management surface

- Schema version remains v22. No `ALTER TABLE`, trigger, index, or backfill.
- `handoffs` and `handoff_messages` are read for projection and the guard; writes are unchanged.
- No `/api/handoffs` thread management route. The existing human cancel route remains the only thread
  terminal action.
- No thread create/close/retry/relaunch/retarget UI, composer, list, or attachment affordance.
- No session reuse; thread dispatch still creates a fresh target session per the stage-0034 lifecycle.

## 5. Phases

Each phase is independently verifiable and must pass its gate before the next. Phase D alone runs
the full matrix, records the stage, and commits.

### Phase A - server metadata, live/history projection, body extraction, tests

**Goal/boundary:** server-side handoff projection and the pure client body parser only. No UI
component, dispatcher guard, SSE, prompts-list, or prompt changes. One-shot output stays
byte-identical.

**Files/symbols:** `src/coordinator/handoff-messages.ts` (`HandoffMessageMeta`, new thread row type,
`threadMetaFor`, `threadMessageMap`, `projectHandoffMessages`, `createHandoffEventResolver`),
`assets/chat-core.js` (`HandoffMessageMeta` JSDoc, `normalizeHandoffMeta`, `handoffBodyFromText`,
`handoffFromInfo` unchanged), `test/handoff-messages.test.ts`, `test/chat-core.test.ts`.

**Ordered steps:**

1. Extend `HandoffMessageMeta` with the five optional fields; leave `metaFor`/`messageMap` for
   one-shot unchanged and assert no new fields are assigned there.
2. Add the thread row type and `threadMetaFor(row, includeBody)` implementing §4.4; add
   `threadMessageMap(rows, includeBody)` keyed by non-null `delivery_message_id` and skipping
   non-thread kinds/system sides.
3. In `projectHandoffMessages`, keep the one-shot query and `messageMap`; add the thread query from
   §4.3 with 500-id chunking; annotate with `threadMap.get(id) ?? oneShotMap.get(id)`; preserve
   existing `info.hanse`.
4. In `createHandoffEventResolver`, run the §4.2 query first; a hit returns/caches thread meta; a miss
   runs the unchanged one-shot query and reuses the same cache/bound.
5. Extend the `HandoffMessageMeta` JSDoc and `normalizeHandoffMeta` with the §4.6 bounds; extend
   `handoffBodyFromText` with the §4.5 first-non-empty-line gate; leave `handoffFromInfo` and
   `handoffNoteFromText` behavior unchanged.
6. Replace the stale `test/handoff-messages.test.ts` "does not annotate thread messages as
   HandoffCard" test with a real `delivery_message_id` row asserting thread meta (see §7).
7. Add live, history, precedence, page-scoping, deleted-author, one-shot-shape, and body-extraction
   tests (§7).

**Acceptance:** thread source/target history and live meta exactly match §4.1; live has no `body`;
thread wins a synthetic id collision; one-shot exact shape is unchanged and has no thread fields;
`assistant`/unrelated/null-delivery rows are untouched; body extraction handles start/message/reply,
CRLF, multi-line summary, missing fence, and one-shot marker-in-spec unchanged.

**Gate:** `npm run lint && npm run typecheck && npx vitest run test/handoff-messages.test.ts
test/chat-core.test.ts`.

### Phase B - client types, ChatPage, HandoffCard, styles, UI tests

**Goal/boundary:** render the thread card and normalize the thread meta in the Vue client. No server,
dispatcher, SSE, prompts-list, or prompt changes.

**Files/symbols:** `ui/chat/types.ts` (`ChatHandoffView`), `ui/pages/ChatPage.vue`
(`normalizeHandoffMetadata`; `threadMessages` unchanged in behavior), `ui/components/chat/HandoffCard.vue`,
`src/http/styles.css` (thread selectors only), `test/ui/chat-cards.test.ts`,
`test/ui/chat-message.test.ts`, `test/chat-page.test.ts`, `test/chat-feed-store.test.ts`.

**Ordered steps:**

1. Add the five optional fields to `ChatHandoffView`.
2. In `normalizeHandoffMetadata`, pass the five fields; set `note = ""` and skip
   `handoffNoteFromText` for `mode === "thread"`; keep one-shot body/note fallback unchanged.
   `threadMessages` still projects `record.handoff`.
3. Add the §4.7 thread branch to `HandoffCard.vue` with a `kindLabel` computed (`Request` /
   `Message` / `Reply`); keep the one-shot branch byte-identical; render the note block only in the
   one-shot branch.
4. Add the §4.7 CSS selectors to `src/http/styles.css`; no new tokens, shadow, brass, stripe, or
   radius.
5. Add UI tests for thread request/message/reply attributes, chip, author, kind label, `#seq`, route,
   reply-only outcome, `role`/`aria-label`, avatar `aria-hidden`, sealed body, long-body disclosure,
   no note block, and unchanged one-shot DOM. Add `ChatMessage`/`ChatPage` assertions that a thread
   handoff gets `message--handoff` not `message--user`, no `data-message-meta`, and no operator
   text/tool parts, while a plain operator message still gets its bubble. Add the `chat-feed` merge
   test that a history thread body survives a later body-less live frame and introduces no note.

**Acceptance:** thread cards render exactly the §4.7 DOM/labels; no note block for a non-empty note;
one-shot card test passes unchanged; no operator bubble or second meta row; UI typecheck clean.

**Gate:** `npm run lint && npm run typecheck && npm run typecheck:ui && npx vitest run
test/ui/chat-cards.test.ts test/ui/chat-message.test.ts test/chat-page.test.ts
test/chat-feed-store.test.ts`.

### Phase C - question guard, SSE/prompts suppression, prompt instruction, tests

**Goal/boundary:** dispatcher target-session guard, SSE and prompts-list visibility filter, and the
target-facing prompt line. No projection/UI change; no reject for source/operator/unrelated/terminal/
one-shot/permission; no new client behavior.

**Files/symbols:** `src/coordinator/dispatcher.ts` (`observe`, `#seenQuestions`,
`#observeThreadQuestion`, `#rejectThreadQuestion`, `#resolveSessionRoot`, `#resolveObservedRoot`
delegation, `#isThreadSourceRoot`, `#isThreadTargetRoot`, `shouldSuppressQuestion`,
`HandoffDispatcherClient`, `DEFAULT_CLIENT`, `#threadStartPrompt`, `#threadFollowUpPrompt`),
`src/http/prompts.ts` (`streamAppEvents`, `handlePromptsList`), `test/handoff-dispatcher.test.ts`,
`test/prompts-http.test.ts`. Reuse existing `rejectQuestion`/`rejectQuestionV2` in
`src/opencode/client.ts`; do not change that file's behavior.

**Ordered steps:**

1. Add the two reject functions to `HandoffDispatcherClient` and spread them into `DEFAULT_CLIENT`
   from `src/opencode/client.ts`.
2. Generalize `#resolveObservedRoot` into `#resolveSessionRoot(appId, sessionID)`; keep
   `#resolveObservedRoot` delegating and returning the same `{rootId, title}`.
3. Add `#isThreadSourceRoot`/`#isThreadTargetRoot` using the §4.8 queries and `#seenQuestions`.
4. Add the `question.asked` branch at the top of `observe`, `#observeThreadQuestion`, and
   `#rejectThreadQuestion` with the exact v1/v2 selection, dedupe key, status logs, source-first
   precedence, and swallowed 404/409.
5. Add public `shouldSuppressQuestion` with fail-open semantics.
6. Add the §4.10 line to `#threadStartPrompt` and `#threadFollowUpPrompt` only.
7. Add the `streamAppEvents` suppression branch and the `handlePromptsList` v1/v2 question filter,
   both gated on `deps.dispatcher` presence.
8. Add dispatcher and prompts tests for v1/v2, subagent, source/operator/unrelated/terminal/one-shot,
   `permission.asked`, duplicate key, 404/409/human race, unresolved endpoint/root, log redaction,
   SSE forwarding/suppression, prompts-list filtering, and prompt-text containment.

**Acceptance:** v2 target root rejects once via `rejectQuestionV2(endpoint, observedSessionID,
request.id)`; v1 rejects once via `rejectQuestion(endpoint, request.id)`; a target subagent resolves
to the target root and uses the child session for v2; no reject for source (including overlap),
operator/unrelated, terminal, one-shot, or `permission.asked`; duplicate key -> one reject; 404/409
swallowed; unresolved -> no reject, one bounded warning, question answerable; logs contain only app
id, short session id, source, status; SSE and prompts-list drop only target-root questions with a
dispatcher; prompt line present only on start/follow-up; existing tool-binding tests stay green.

**Gate:** `npm run lint && npm run typecheck && npx vitest run test/handoff-dispatcher.test.ts
test/prompts-http.test.ts`.

### Phase D - one-shot regressions, e2e, docs/record, full gates, commit

**Goal/boundary:** prove compatibility, add the deterministic `/chat` thread-card e2e assertion,
record the stage, and commit. No new behavior.

**Files:** `e2e/spa-chat.spec.ts`, `e2e/support/seed.ts` (render fixture + thread seed),
`docs/journal/0042-thread-chat-rendering.md`, `docs/decisions/0017-thread-message-rendering.md`,
`docs/design/README.md`, `docs/plans/README.md`, `docs/journal/README.md`, `docs/current-state.md`.

**Ordered steps:**

1. Add a real thread handoff plus a `handoff_messages` row with `delivery_session_id =
   E2E_CHAT_RENDER_SESSION_ID` and `delivery_message_id` equal to a new `renderMessages()` user
   message id in `ses_e2erender`; this exercises real server projection, not a hand-built meta.
2. In `e2e/spa-chat.spec.ts` assert the thread card: `[data-handoff-card][data-mode="thread"]`,
   `[data-thread-author]` = the source app key, `[data-thread-chip]` = `Thread`,
   `[data-thread-seq]` = `#<seq>`, the body text, and that the message container has
   `message--handoff` and not `message--user`.
3. Run one-shot compatibility tests: exact `HandoffMessageMeta` shape, card DOM, projection,
   prompts, lifecycle, and dispatch/reply are unchanged; only additive thread meta and the new
   question guard/SSE behavior differ.
4. Write journal 0042 and ADR 0017; update `docs/current-state.md` (thread chat projection, thread
   card, question guard, SSE/prompts suppression, prompt line; schema still v22) and all indexes
   (design README, plans README with a 0035 entry, journal README).
5. Re-read the diff: only the intended files; no migration; no management UI; no session reuse; no
   secrets. Then run the full §10 verification set and commit one coherent stage commit; no push
   unless explicitly asked.

**Acceptance:** full gates green including mandatory `test:e2e`; one-shot regressions pass; the e2e
thread-card assertion is deterministic and fails if the thread branch is removed; docs/ADR/journal/
indexes consistent; diff contains only intended changes.

**Gate:** the full §10 verification set.

## 6. Code touch map

| File | Exact change |
| --- | --- |
| `src/coordinator/handoff-messages.ts` | Extend `HandoffMessageMeta` (L13) with the five optional fields. Add thread row type, `threadMetaFor`, `threadMessageMap`, the §4.2/§4.3 SQL, thread-first resolution in `createHandoffEventResolver` (L167), and thread-precedence annotation in `projectHandoffMessages` (L132). Keep `metaFor` (L83)/`messageMap` (L112) one-shot unchanged. |
| `assets/chat-core.js` | Extend the `HandoffMessageMeta` JSDoc (L1350) and `normalizeHandoffMeta` (L1385) with §4.6 bounds. Add the §4.5 thread branch to `handoffBodyFromText` (L1434). `handoffFromInfo` (L1418) and `handoffNoteFromText` (L1461) unchanged. |
| `assets/chat-core.d.ts` | No field-list change; keep `normalizeHandoffMeta` returning `Record<string, unknown> | null` and keep the body/note signatures. |
| `ui/chat/types.ts` | Add the five optional fields to `ChatHandoffView` (L67). |
| `ui/pages/ChatPage.vue` | `normalizeHandoffMetadata` (L1767): pass the five fields, set `note = ""` and skip `handoffNoteFromText` for threads, keep one-shot body/note path. `threadMessages` (L1806) keeps projecting `record.handoff`. |
| `ui/components/chat/HandoffCard.vue` | Add the §4.7 thread branch selected by `handoff.mode === "thread"`; add `kindLabel`; keep the one-shot branch unchanged; render the note block only in the one-shot branch. |
| `src/http/styles.css` | Add the §4.7 thread-only selectors after the existing `.handoff-card` rules (L6413-6518). No new tokens/shadow/brass/stripe/radius. |
| `src/coordinator/dispatcher.ts` | `observe` (L316): handle `question.asked` before the tool early return. Add `#seenQuestions`, `#observeThreadQuestion`, `#rejectThreadQuestion`, `#resolveSessionRoot`, `#isThreadSourceRoot`, `#isThreadTargetRoot`, `shouldSuppressQuestion`; make `#resolveObservedRoot` (L1106) delegate. Add reject methods to `HandoffDispatcherClient` (L64)/`DEFAULT_CLIENT` (L124). Extend `#threadStartPrompt` (L1558) and `#threadFollowUpPrompt` (L1597) with §4.10; not `#threadReplyPrompt` (L1626). |
| `src/http/prompts.ts` | `handlePromptsList` (L487): filter v1/v2 question arrays via `shouldSuppressQuestion` when `deps.dispatcher` is present. `streamAppEvents` (L670): add the §4.9 suppression branch in the event loop (around L826). No other change. |
| `src/opencode/client.ts` | No behavior change; existing `rejectQuestion` (L918) and `rejectQuestionV2` (L991) are imported into `DEFAULT_CLIENT`. |
| `ui/stores/chat-feed.ts` | No functional change; covered by a merge test. |
| Tests | `test/handoff-messages.test.ts`, `test/chat-core.test.ts`, `test/ui/chat-cards.test.ts`, `test/ui/chat-message.test.ts`, `test/chat-page.test.ts`, `test/chat-feed-store.test.ts`, `test/handoff-dispatcher.test.ts`, `test/prompts-http.test.ts`, `e2e/spa-chat.spec.ts` + `e2e/support/seed.ts`. |
| No change | `src/opencode/events.ts`, `src/http/chat.ts`, `src/http/handler.ts`, `src/http/server.ts`, migrations/schema, `src/coordinator/thread.ts`, `src/coordinator/handoff.ts`, `src/mcp/*`, `ui/stores/chat-feed.ts` behavior. |

## 7. Test matrix

### 7.1 Projection - live and history (`test/handoff-messages.test.ts`)

- Source `request`/`message` in target history and target `reply` in source history: assert
  `mode="thread"`, `direction`, `kind`, `authorSide`, `agent`/`from`/`to`, header
  `state`/`summary`/`origin`/`replyState`, `outcome`, `messageId`, `seq`, DB `body`, no
  `operatorNote`.
- Live resolver for the same rows: identical fields, no `body`; unknown ids -> `undefined`; a thread
  match does not fall through to one-shot.
- Thread precedence wins a synthetic `delivery_message_id`/one-shot id collision.
- Page scoping: only page ids are annotated; another session, assistant messages, and null
  `delivery_message_id` rows are untouched.
- Deleted author app falls back to the participant key/id for the recorded side.
- One-shot exact-shape regression still passes; the five new fields are absent.
- Thread rows still leave `dispatch_message_id`, `reply_message_id`, `reply_state`,
  `reply_delivered_session_id` null. Replace the stale "does not annotate thread messages as
  HandoffCard" test (currently L194) with a real `delivery_message_id` row asserting thread meta.

### 7.2 Body extraction and client normalization (`test/chat-core.test.ts`)

- Start/reply extract after the `Summary:` block and first following blank line; message extracts
  directly; CRLF equivalent; missing marker/fence returns `""`; one-shot extraction unchanged.
- A one-shot prompt whose spec/result contains a literal thread marker still uses `Specification:`/
  `Result:` because the marker is not the first non-empty line.
- A multi-line `Summary:` in a thread start/reply is fully removed through the first blank line.
- `normalizeHandoffMeta` accepts the five thread fields with §4.6 bounds and omits invalid values;
  one-shot objects keep the same normalized shape.

### 7.3 UI (`test/ui/chat-cards.test.ts`, `test/ui/chat-message.test.ts`, `test/chat-page.test.ts`, `test/chat-feed-store.test.ts`)

- Thread request/message/reply render `data-mode="thread"`, `data-kind`, `data-seq`, `Thread` chip,
  author, kind label, `#<seq>`, route, summary, sealed Markdown body.
- Reply-only outcome chip; long-body disclosure; `role="group"` and exact `aria-label`; avatar
  `aria-hidden`.
- Thread card has no `handoff-card__note` even with a non-empty `note`.
- One-shot card test passes unchanged with no extra thread attributes.
- `ChatPage.normalizeHandoffMetadata` passes the fields, prefers server body, falls back to thread
  text on live frames, and never creates a note from a thread body containing
  `Operator note (trusted):`.
- `ChatMessage` thread handoff gets `message--handoff`, not `message--user`, no `data-message-meta`,
  and no operator text/tool parts; a plain operator message still gets its bubble; `ChatPage`/
  `ChatThread` adds no second meta row.
- `chat-feed` merge preserves a history thread body across a later body-less live frame and
  introduces no note.

### 7.4 Question guard (`test/handoff-dispatcher.test.ts`)

- v2 target root calls `rejectQuestionV2(endpoint, observedSessionID, request.id)` once and not v1;
  v1 target root calls `rejectQuestion(endpoint, request.id)` once and not v2.
- Target subagent resolves to the target root and uses the child `request.sessionID` for v2.
- No reject for a source root (including the pathological source+target fixture), operator/unrelated
  root, terminal thread, one-shot handoff, or `permission.asked`.
- Duplicate `question.asked` key -> one reject.
- 404/409/human race swallowed with no throw/retry.
- Unresolved endpoint/root -> no reject, one bounded warning, question remains answerable.
- Logs contain only app id, short session id, source, status; no question text/answers/id.
- Existing tool binding tests remain green.

### 7.5 SSE suppression and prompt text (`test/prompts-http.test.ts`)

- `streamAppEvents` drops `question.asked` for a target root when `deps.dispatcher` is present;
  forwards when the dispatcher is absent, the root is source/operator/unrelated, or root resolution
  fails.
- SSE forwards a terminal-thread question and a source+target overlap question (source-first
  precedence), locking `state='in_progress'`.
- `/api/apps/:app/prompts` excludes a target-root question when the dispatcher is present and
  forwards source/operator/unrelated/unresolved; without a dispatcher it forwards all.
- `permission.asked`, `question.replied`, and `question.rejected` are forwarded.
- Start and follow-up prompts contain the exact §4.10 line; reply and one-shot prompts do not;
  permission text is unchanged.

### 7.6 E2E and full gates

- `e2e/spa-chat.spec.ts` renders a deterministic thread card from a real seeded
  `handoff_messages.delivery_message_id` and asserts the agent author, `Thread` chip, `#<seq>`, body,
  and absence of `message--user`.
- Full §10 gate set.

## 8. Failure and rollback

- No DB migration, so there is no schema forward-only door and no data migration. Reverting the
  code/tests/docs restores the prior behavior with the same v22 database.
- One-shot fallback: if thread projection fails or a thread row is not mapped, the page message keeps
  the current one-shot behavior (or no handoff meta) and renders as today; no page load fails.
- Guard fail-open: an unresolved endpoint/root leaves the question visible and answerable; a human
  answer racing the reject yields 404/409, swallowed with no retry.
- No partial state: the guard and SSE/prompts filters perform no writes; suppression is read-only.
  Rejection is a single upstream call with no local state change.
- If the thread card branch is wrong, revert `HandoffCard.vue`/`styles.css`/client normalization
  independently; server-added thread meta is additive and harmless to the one-shot renderer.
- No live card due to the 8 KiB cap is not a failure: history still projects the row.

## 9. Risks and residual (from design §8)

- The question ban is policy, not a hard security boundary; a compromised agent can call the
  upstream loopback directly or avoid the question tool. The guard only removes the normal path.
- The guard depends on the dispatcher `onEvent` hook. If context monitors are disabled, threads do
  not bind and the guard is inactive; the SSE/prompts filters are gated only on dispatcher presence,
  so they could hide a question without an auto-reject. Production enables the hook; if monitors can
  be disabled at runtime, gate suppression on a shared `guardActive` signal (residual, not normal).
- Root-resolution failure leaves the question visible/answerable (deliberate fail-open); a human
  answer racing the reject produces a swallowed 404/409 with no retry.
- The auto-reject is not a chat notice and does not fail the thread; the prompt asks the agent to
  reply `blocked`, and an agent that does neither stays blocked by its own turn.
- UI suppression happens only with a dispatcher; tests, embeds, or a degraded coordinator without one
  may still show the question, and the server guard is absent there too.
- Live metadata is body-less; a frame over the 8 KiB cap loses the live card for that frame while
  history still projects it. Body extraction is display-only: a hostile body can change displayed
  text, never the server-derived author/thread/kind/seq.
- Thread messages remain ordinary user turns, so the stage-0034 prompt-injection residual is
  unchanged. One-shot behavior is unchanged; no thread UI, attachment path, target-initiated
  message, or worktree isolation is added. Logs contain only fixed metadata.

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

`test:e2e` is **mandatory**: this stage changes `ui/components/chat/HandoffCard.vue` and
`src/http/styles.css`, i.e. the rendered `/chat` route. The deterministic thread-card assertion in
`e2e/spa-chat.spec.ts` (with its seed in `e2e/support/seed.ts`) covers the agent author, `Thread`
chip, `#<seq>`, body, and absence of the operator bubble. `check:ui` remains required because the
stylesheet changes. Run tests under the repository's credential-environment rules; never use
deployment secrets or real project data.

## 11. Plan review

Status: PASS (`momus` round 1).

Findings:

- Round 1 - `momus` - PASS. Verified the design doc, all source/test/e2e references and line
  anchors, the v22 schema assumptions, and the new journal/ADR numbering. Each phase has ordered
  steps, file boundaries, acceptance criteria, and runnable gates. No blocking ambiguity or
  contradiction found. No plan-level open questions remain.
