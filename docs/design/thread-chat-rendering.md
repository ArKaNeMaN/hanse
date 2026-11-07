# Design - Thread chat rendering and the agent-to-agent question ban

Status: approved (`oracle` PASS after blocker fixes)

Scope: stage `0035-thread-chat-rendering`, a follow-up to committed stage
`0034-handoff-threads`. This design covers the thread-message chat projection, the `HandoffCard`
thread variant, the target-facing prompt instruction, the target-session question guard, and the
matching SSE visibility filter. It changes no production code and adds no database migration.

## 1. Context

Stage 0034 implemented stage-1 handoff threads but deliberately deferred thread chat projection.
Thread messages are injected as ordinary user turns. They carry no
`info.hanse.handoff`, so the chat renders them like operator input and the only visible trace is
the envelope text plus the normal tool blocks. The stage-1 design recorded this as R8 and as an
explicit non-goal (`docs/design/handoff-threads.md`; `docs/plans/0034-handoff-threads.md`).

The owner now wants five follow-up properties:

1. Thread messages appear in chat as messages from the sending agent, subtly distinct from
   operator input.
2. Agent-to-agent interactive questions are forbidden, not merely discouraged by prompt text.
3. Operator-created threads/handoffs are not needed; the operator writes directly in chat.
4. Sessions stay fresh per thread; there is no session reuse.
5. Target-initiated messages and attachments are future work; worktree isolation is a separate
   future plan.

One-shot handoff cards remain exactly as today. The thread card is an additive variant, not a
replacement.

Existing facts that bound the work:

- `src/coordinator/handoff-messages.ts` projects only the one-shot
  `dispatch_message_id`/`reply_message_id`; thread rows never write those columns.
  `handoff_messages.delivery_message_id` (unique partial index) is the live join key and
  `delivery_session_id` (indexed) is the history join key.
- `HandoffDispatcher.observe()` returns unless the event is a completed handoff tool part and
  ignores question events; thread binding already relies on the same `onEvent` hook.
- The question pipeline emits `question.asked` with
  `{ request: { key, id, sessionID, questions, source: "v1"|"v2", ... } }`. The v1 reject is
  `rejectQuestion(endpoint, requestId)`; the v2 reject is
  `rejectQuestionV2(endpoint, sessionId, requestId)`. `buildPermissionPolicy` is instance-wide
  with `question: "allow"`, so a global deny would also break operator sessions.
- Thread roots are `handoffs.source_session_id`/`target_session_id` for `mode='thread'` and
  `state='in_progress'`; subagent sessions resolve to one of those roots.
- `HandoffCard` owns the one-shot body Markdown (`sealed`), long-body disclosure, inbox link, and
  operator-note block. There is no thread-management UI or operator thread creation.

## 2. Requirements

| ID | Requirement |
| --- | --- |
| R1 | Thread messages in the destination chat render as messages from the sending agent, with a subtle thread treatment distinct from operator input. Source-authored rows read as requests/messages from the source app; target-authored rows read as replies from the target app. |
| R2 | Agent-to-agent interactive questions are forbidden in thread target sessions. The coordinator auto-rejects a question raised by a target root, including target subagents. It does not reject source, operator, or unrelated sessions. |
| R3 | Operator-created threads/handoffs do not exist. The operator writes directly in chat; no operator thread creation, close, retry, relaunch, retarget, or management UI is added. |
| R4 | Sessions remain fresh per thread. This stage does not reuse, resume, or share a thread session. |
| R5 | Target-initiated messages and attachments through handoffs/threads remain future work. |
| R6 | Worktree isolation remains a separate future plan. |
| R7 | One-shot handoff cards, their projection, their prompts, and their lifecycle remain byte-compatible. Thread meta is additive and only appears for thread rows. |
| R8 | Server metadata is authoritative for author, thread, kind, and sequence. Client text parsing is a body fallback only and never decides identity. No DB migration is added. |

## 3. Decisions

### D1 - Thread metadata is an additive shape on `HandoffMessageMeta`

Extend `HandoffMessageMeta` with optional `mode: "thread"`, `kind: "request" | "message" |
"reply"`, `authorSide: "source" | "target"`, `messageId: number`, and `seq: number`.

For a thread row:

- `id` is the handoff/thread id (`handoffs.id`), the same value the one-shot card calls `id`.
- `direction` stays `request` for source-authored rows and `reply` for target-authored rows.
  `kind` carries the finer distinction (`request`, `message`, or `reply`).
- `agent` is the author app key. `from` and `to` are the thread participants.
- `state` is the thread header state (`in_progress` throughout a live thread).
- `summary` is the header summary, bounded like the one-shot summary.
- `outcome` is present only for a reply; it is `null` for a request or message.
- `replyState` is the header reply state (normally `none` for a thread).
- `origin` is the header origin.
- `body` is present on history only, as today.
- There is no `operatorNote` on a thread meta. Stage-1 threads are agent-originated and the
  thread header note is not a chat-facing operator note.

One-shot meta keeps its exact current shape. The new fields are absent and the client sees the
same object it sees today.

### D2 - Projection is server-side, live and history

The live resolver first queries `handoff_messages` by `delivery_message_id` (unique partial
index). A hit returns thread meta. A miss falls through to the existing one-shot query unchanged.
Thread wins on the astronomically unlikely id collision.

`projectHandoffMessages` keeps its existing one-shot query and adds a second query on
`handoff_messages` by `delivery_session_id` plus the page message ids, joined to `handoffs` and
`apps`. It maps thread rows by `delivery_message_id`, then annotates each page message by
`threadMap.get(id) ?? oneShotMap.get(id)`.

Thread cards therefore appear in the chat where the envelope was injected: source-authored
messages in the target session, target replies in the source session. A source agent's own
outgoing follow-up is a tool call in its own session and is not duplicated as a chat card there.

### D3 - One card with a thread variant, not a new card

Reuse `HandoffCard` with a thread branch selected by `handoff.mode === "thread"`. The thread
branch adds a `Thread` chip, the author app key, a kind label (`Request` / `Message` / `Reply`),
the sequence (`#3`), and the existing route (`from -> to`). It keeps the avatar, summary, body
Markdown (`sealed`), long-body disclosure, reply outcome, and inbox link. It renders no operator
note block.

The thread card must not get the operator `message--user` bubble. The existing `ChatMessage` rule
already excludes any handoff from `message--user` and hides the operator meta row/parts when a
handoff card is present; the thread branch inherits that behavior without a new bubble rule.

The card gets an accessible group label naming the sending agent and thread. One-shot card DOM
is unchanged.

### D4 - History body from the DB, live body from the envelope text only

History metadata carries the exact `handoff_messages.body` (bounded). Live metadata omits the
body to stay inside the enriched-event cap; the client extracts the body from the message text
using the thread envelope marker and the nonce fence.

The extraction is display-only. Author, thread, kind, and sequence always come from server
metadata. A body that mimics a marker can change what body text is shown, never who sent it.

### D5 - The question guard is a target-session policy in the dispatcher

`HandoffDispatcher.observe` handles `question.asked` before its tool-part early return. It
resolves the observed session to its durable root with the existing bounded parentID walk,
generalized into a shared helper. If the root is the `target_session_id` of an `in_progress`
`mode='thread'` handoff, and is not also a thread source root, it auto-rejects the question.

- `source="v2"` uses `rejectQuestionV2(endpoint, request.sessionID, request.id)`; the exact
  observed session id is used, so target subagents are rejected correctly.
- `source="v1"` uses `rejectQuestion(endpoint, request.id)`.
- Deduplicate by `${app.id}:${request.key}` before the asynchronous work.
- Swallow 404/409 and any race with a human answer.
- Log only fixed metadata: app id, short session id, source, and status. Never question text.
- Do not reject source sessions, operator/unrelated sessions, terminal threads, one-shot
  handoffs, or `permission.asked`.
- If the endpoint or root cannot be resolved, do not reject. Fail open for non-thread safety and
  emit one bounded warning.

### D6 - SSE suppresses only the now-pointless thread question

`streamAppEvents` drops `question.asked` for a thread target root when `deps.dispatcher` is
present. It does not suppress when the dispatcher is absent, and it does not suppress source,
operator, unrelated, or unresolved sessions. Terminal `question.replied`/`question.rejected`
events are harmless and may be forwarded unchanged. The `/api/apps/:app/prompts` hydration read
applies the same target-root filter to the v1/v2 question arrays, so a pending target question
cannot appear on load before the asynchronous auto-reject lands. This is visibility hygiene; the
server auto-reject is the actual unblock.

### D7 - Prompt instruction is target-facing only

Add the question ban to the thread start and follow-up envelopes. Do not add it to the
source-facing reply envelope: source agents may still ask the operator. Do not ban
`permission.asked`; tool approvals remain available.

### D8 - No schema or lifecycle expansion

No DB migration. Reuse `delivery_message_id` (unique partial index), `delivery_session_id`
(index), and the existing thread lifecycle. No thread-management UI, no close/retry/relaunch/
retarget, no attachments, no target-initiated messages, and no worktree isolation.

## 4. Invariants

- Server metadata is authoritative for thread identity; text parsing only derives the display
  body. A thread meta never carries an operator note.
- One-shot meta shape/card rendering are unchanged; new fields are absent for one-shot rows.
  Thread rows continue to leave every one-shot routing column null.
- A thread card exists only when a page message id equals a non-null
  `handoff_messages.delivery_message_id` for a thread row.
- `direction` is `request` for `author_side='source'` and `reply` for `target`; `kind` is the
  row kind; `messageId` is the numeric row id; `seq` is the positive sequence.
- The guard runs only for `question.asked` (never `permission.asked` or the terminal question
  events) and rejects only a root that is a target of an `in_progress` thread. A source root is
  never rejected, even in the pathological source+target overlap.
- The guard/SSE filter fail open on an unresolved endpoint or root. No question text, answer
  text, or request payload reaches logs. No schema bump; the database stays at v22.

## 5. Contracts

### 5.1 Exact thread meta JSON

A source-authored follow-up in history:

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

A target reply in history:

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

Live metadata is the same object with `body` omitted, plus no operator note. The `id` is the
thread id, not the numeric message id; `messageId` is the numeric row id used for debugging and
`data-message-id` correspondence.

TypeScript shape added to `HandoffMessageMeta`:

```ts
export interface HandoffMessageMeta {
  // existing fields unchanged
  mode?: "thread";
  kind?: "request" | "message" | "reply";
  authorSide?: "source" | "target";
  messageId?: number;
  seq?: number;
}
```

The one-shot `metaFor` path does not assign any of the five fields.

### 5.2 Exact live resolver query

`createHandoffEventResolver` runs this query first:

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

If this returns no row, the existing one-shot query
(`WHERE h.dispatch_message_id = ? OR h.reply_message_id = ?`) runs unchanged and its
`messageMap` result is returned. If the thread query returns a row, the resolver returns the
thread meta without executing the one-shot query. The existing positive-result cache remains;
the thread path uses the same cache and the same bound.

`HandoffMessageMeta` is still the only value attached to `events.ts`; `EventProjector` needs no
change. Live thread meta is small (no body), so it fits under the existing 8 KiB enriched-event
cap. If an unrelated enrichment (for example many attachments) pushes the event over the cap,
the live card is skipped for that frame and history still shows it; this is accepted residual.

### 5.3 Exact history projection query

`projectHandoffMessages` keeps the existing one-shot select/join/query and builds its map as
today. It then runs:

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

The `IN` list is the page's message ids. The page is bounded by the existing page limit; when a
full-history page would exceed SQLite's variable limit, the caller chunks the ids (recommended
500 per statement) and merges the resulting maps. The query is covered by
`handoff_messages_delivery_session` and the unique `delivery_message_id` index. The existing
`if (rows.length === 0) return;` guard does not block thread-only sessions: the one-shot query
also matches thread headers through `source_session_id`/`target_session_id`, so `rows.length` is
nonzero. Keep the guard; if the one-shot query is later scoped to `mode='one_shot'`, move it after
the thread query.

Annotation precedence is thread first:

```ts
for (const message of messages) {
  if (message.info.role !== "user") continue;
  const meta = threadMap.get(message.info.id) ?? oneShotMap.get(message.info.id);
  if (meta === undefined) continue;
  // preserve existing info.hanse fields and set handoff
}
```

### 5.4 Exact field mapping

For a thread row, `threadMetaFor(row, includeBody)` produces:

| Meta field | Source |
| --- | --- |
| `id` | `m.handoff_id` |
| `direction` | `m.author_side === "target" ? "reply" : "request"` |
| `agent` | `author_key` (author app key, fallback by author side to the participant app key, then app id) |
| `from` | `from_key` (thread source participant) |
| `to` | `to_key` (thread target participant) |
| `state` | `h.state` (header state) |
| `summary` | `boundedSummary(h.summary)` (max 500 chars, same truncation as one-shot) |
| `outcome` | `m.kind === "reply" ? m.outcome : null` |
| `replyState` | `h.reply_state` |
| `origin` | `h.origin` |
| `body` | `includeBody ? capUtf8(m.body, 32 * 1024) : undefined` |
| `mode` | `"thread"` |
| `kind` | `m.kind` |
| `authorSide` | `m.author_side` |
| `messageId` | `m.id` (number) |
| `seq` | `m.seq` |
| `operatorNote` | absent, always |

Rows with a null `delivery_message_id`, a non-thread kind, or a `system` author side are not
mapped. A deleted author app leaves `author_app_id` null (`ON DELETE SET NULL`); the `COALESCE`
falls back to the participant key/id for the recorded side.

### 5.5 Exact body extraction rules

`handoffBodyFromText(text, direction)` keeps its signature. It normalizes CRLF to LF and enters
the thread branch only when the **first non-empty line** is exactly one of the thread envelope
markers. A thread marker later inside one-shot summary/spec/result text is ordinary content, so
one-shot extraction remains unchanged.

1. If the first non-empty line is `[Hanse handoff thread start]`:
   - take the content strictly between the `UNTRUSTED CONTENT BEGIN <nonce>` line and the next
     `UNTRUSTED CONTENT END <nonce>` line;
   - drop the `Summary:` line and everything through the first following blank line (a multi-line
     summary is fully removed);
   - return the remainder trimmed.
2. If the first non-empty line is `[Hanse handoff thread message]`:
   - take the fenced content;
   - return it trimmed with no line dropped.
3. If the first non-empty line is `[Hanse handoff thread reply]`:
   - take the fenced content;
   - drop the `Summary:` line and everything through the first following blank line;
   - return the remainder trimmed.
4. Otherwise use the existing one-shot `Specification:` / `Result:` extraction unchanged.
5. If the marker or either fence line is missing, return `""`.

The first-non-empty-line gate is what keeps a one-shot prompt that quotes a thread marker in its
`Summary:`, `Specification:`, or `Result:` on the one-shot path.

The fence markers themselves and the nonce are never returned. Body content is not unescaped;
it is the same text the agent saw inside the fence. `handoffNoteFromText` is unchanged and is
never called for `mode === "thread"`; a thread body that happens to contain `Operator note
(trusted):` cannot create a note block.

### 5.6 Client normalization and types

`assets/chat-core.js` `normalizeHandoffMeta` accepts these optional fields with bounds:

| Field | Accepted value |
| --- | --- |
| `mode` | exactly `"thread"`; anything else omitted |
| `kind` | exactly `"request"`, `"message"`, or `"reply"`; anything else omitted |
| `authorSide` | exactly `"source"` or `"target"`; anything else omitted |
| `messageId` | finite integer `> 0`; anything else omitted |
| `seq` | finite integer `> 0`; anything else omitted |

Existing fields keep their current validation and bounds. The current `assets/chat-core.d.ts`
declares `normalizeHandoffMeta` as returning `Record<string, unknown> | null`; that declaration
needs no field list. If it is later narrowed to a `HandoffMessageMeta` type, include the optional
fields.

`ui/chat/types.ts` `ChatHandoffView` gains:

```ts
readonly mode?: "thread";
readonly kind?: "request" | "message" | "reply";
readonly authorSide?: "source" | "target";
readonly messageId?: number;
readonly seq?: number;
```

`ui/pages/ChatPage.vue` `normalizeHandoffMetadata` passes those five fields through. It computes
`body` as today: prefer a non-empty server `body`, otherwise call `handoffBodyFromText` on the
record text. For `mode === "thread"` it sets `note` to `""` and does not call
`handoffNoteFromText`. For one-shot it keeps the existing body/note fallback exactly.

`ui/stores/chat-feed.ts` needs no functional change. Its existing merge keeps a previously
projected body when a live frame arrives without one, and it never invents a note. Add a test
that a history thread body survives a later body-less live frame.

### 5.7 Exact `HandoffCard` thread data attributes and labels

One-shot branch: unchanged template, classes, attributes, and order.

Thread branch (`handoff.mode === "thread"`) renders:

```html
<div class="handoff-card" data-handoff-card data-mode="thread"
  :data-direction="handoff.direction" :data-kind="handoff.kind"
  :data-seq="handoff.seq" :data-outcome="handoff.outcome ?? undefined"
  role="group"
  :aria-label="`Message from agent ${handoff.agent} in thread ${handoff.id.slice(0, 8)}`">
  <div class="handoff-card__head">
    <span class="avatar avatar--sm" aria-hidden="true">{{ initials }}</span>
    <span class="badge badge--mono" data-thread-chip>Thread</span>
    <span class="handoff-card__author mono" data-thread-author>{{ handoff.agent }}</span>
    <span class="handoff-card__kind" data-thread-kind>{{ kindLabel }}</span> <!-- Request|Message|Reply -->
    <span class="handoff-card__seq mono" data-thread-seq>#{{ handoff.seq }}</span>
    <span class="handoff-card__route"><span class="mono">{{ handoff.from }}</span>
      <span aria-hidden="true">→</span><span class="mono">{{ handoff.to }}</span></span>
    <span v-if="handoff.kind === 'reply' && handoff.outcome != null"
      class="handoff-card__outcome" :data-tone="tone(handoff.outcome)">{{ handoff.outcome }}</span>
    <a class="handoff-card__link mono" :href="`/handoffs?q=${encodeURIComponent(handoff.id)}`"
      target="_blank" rel="noreferrer noopener"
      :title="`Open handoff ${handoff.id} in the inbox`">#{{ handoff.id.slice(0, 8) }}</a>
  </div>
  <p class="handoff-card__summary">{{ handoff.summary }}</p>
  <!-- body: same long-body disclosure and sealed MarkdownBlock as today; no note block -->
</div>
```

Exact labels and attributes:

- `data-handoff-card` is present in both modes; `data-mode="thread"` only for thread meta.
- `data-kind` is the raw kind; the visible label is `Request`, `Message`, or `Reply`.
- `data-seq` is the numeric sequence; the visible label is `#<seq>`.
- `data-thread-author` is the author app key rendered with `.mono`; `data-thread-chip` is the
  visible `Thread` badge.
- `role="group"` and `aria-label="Message from agent <agent> in thread <first 8 id chars>"` are
  thread-only. The avatar remains `aria-hidden="true"`; the author is also visible text.
- The outcome chip appears only for `kind === "reply"` with a non-null outcome. The route always
  shows `from → to`; the author is not inferred from the route.
- The inbox link, summary, sealed `MarkdownBlock` body, long-body `details`/preview, and "No
  handoff body is available yet." fallback are identical to the one-shot card.
- The note block (`handoff-card__note`) is rendered only in the one-shot branch.

CSS additions use existing tokens only:

```css
.handoff-card[data-mode="thread"] { background: var(--surface-1); }
.handoff-card__author, .handoff-card__seq { color: var(--text-2); }
.handoff-card[data-mode="thread"] .handoff-card__kind {
  background: var(--wash-1); border-color: var(--line); color: var(--text-2);
}
```

No brass, no colored side stripe, no shadow, and no new radius. The card keeps the existing
`--radius-md`; the chip uses the existing `.badge` treatment. The card is not clickable as a
whole, so it gets no hover wash.

### 5.8 Exact question guard algorithm

`HandoffDispatcher.observe` becomes:

```ts
observe(app: { id: string; projectId: string; appKey: string }, event: HanseEvent): void {
  if (event.type === "question.asked") return this.#observeThreadQuestion(app, event.request);
  if (event.type !== "message.part.updated" || event.partType !== "tool") return;
  // existing tool binding logic unchanged
}

#seenQuestions = new Set<string>();

#observeThreadQuestion(app: { id: string }, request: BoundedQuestionRequest): void {
  const key = `${app.id}:${request.key}`;
  if (this.#seenQuestions.has(key)) return;
  rememberBounded(this.#seenQuestions, key);
  void this.#rejectThreadQuestion(app, request).catch(() => {
    this.#log(`thread question failed app=${app.id} status=error`);
  });
}
```

Asynchronous decision:

```ts
async #rejectThreadQuestion(app: { id: string }, request: BoundedQuestionRequest): Promise<void> {
  const log = (status: string): void => this.#log(
    `thread question app=${app.id} session=${shortId(request.sessionID)} source=${request.source} status=${status}`,
  );
  const endpoint = this.#manager.endpointFor?.(app.id);
  if (endpoint === undefined) return log("no_endpoint");
  const resolved = await this.#resolveSessionRoot(app.id, request.sessionID);
  if (resolved === undefined) return log("unresolved");
  const root = resolved.rootId;
  // Source sessions are never rejected; this check wins in the pathological overlap case.
  if (this.#isThreadSourceRoot(root)) return log("source");
  if (!this.#isThreadTargetRoot(root)) return;
  try {
    if (request.source === "v2") {
      await this.#client.rejectQuestionV2(endpoint, request.sessionID, request.id);
    } else {
      await this.#client.rejectQuestion(endpoint, request.id);
    }
    log("rejected");
  } catch (error) {
    const status = error instanceof OpencodeHttpError ? error.status : undefined;
    log(`${status ?? "error"}`);
  }
}
```

Exact root and membership queries:

```sql
-- source check first; any in-progress thread whose source root is this session
SELECT 1 FROM handoffs
WHERE mode = 'thread' AND state = 'in_progress' AND source_session_id = ?
LIMIT 1;

-- target check
SELECT 1 FROM handoffs
WHERE mode = 'thread' AND state = 'in_progress' AND target_session_id = ?
LIMIT 1;
```

`#resolveSessionRoot(appId, sessionID): Promise<{ rootId: string; title: string | null } | undefined>`
is the current `#resolveObservedRoot` body generalized: get `endpointFor(appId)`,
`listSessions(endpoint)`, walk `parentID` with `HANDOFF_THREAD_ROOT_DEPTH = 8`, and return
`undefined` on a missing session, missing parent, cycle, or depth overflow.
`#resolveObservedRoot(observation)` delegates to it with `observation.appId` and
`observation.sessionId` and returns the same object; the `title` is preserved for stage-0034
thread binding.

v1/v2 selection is exact: `request.source === "v2"` uses the session-scoped v2 endpoint and
therefore the exact observed `request.sessionID` (a subagent id when the question came from a
subagent); every other source uses the v1 reject with `request.id`. `request.id` and
`request.sessionID` are never logged.

The guard ignores terminal threads (`state !== 'in_progress'`), one-shot handoffs, operator
sessions, unrelated sessions, and every `permission.asked` event. A 404 or 409 from the reject
means the human already answered or the question disappeared; it is swallowed. No retry is
attempted.

The dispatcher client surface gains the two existing functions:

```ts
export interface HandoffDispatcherClient {
  // existing methods unchanged
  rejectQuestion(endpoint: string, requestId: string): Promise<boolean>;
  rejectQuestionV2(endpoint: string, sessionId: string, requestId: string): Promise<void>;
}
```

`DEFAULT_CLIENT` spreads/imports the existing `rejectQuestion` and `rejectQuestionV2` from
`src/opencode/client.ts`. No new client behavior is implemented there.

### 5.9 Exact SSE suppression

In the `streamAppEvents` event loop:

```ts
for await (const event of stream.events) {
  if (response.destroyed || response.writableEnded) break;
  if (
    event.type === "question.asked" &&
    deps.dispatcher !== undefined &&
    (await deps.dispatcher.shouldSuppressQuestion(found.app.id, event.request.sessionID))
  ) {
    continue;
  }
  await write(emit(event));
}
```

Public read-only method:

```ts
async shouldSuppressQuestion(appId: string, sessionId: string): Promise<boolean> {
  const resolved = await this.#resolveSessionRoot(appId, sessionId);
  if (resolved === undefined) return false;   // fail open
  const root = resolved.rootId;
  if (this.#isThreadSourceRoot(root)) return false;
  return this.#isThreadTargetRoot(root);
}
```

Rules:

- `deps.dispatcher === undefined` -> no suppression at all.
- `permission.asked` is not inspected.
- `question.replied` and `question.rejected` are forwarded unchanged.
- A source root, operator session, unrelated session, terminal thread, or unresolved root is
  forwarded.
- Suppression performs no state change and no reject; it is only a visibility filter.
- The `/api/apps/:app/prompts` hydration path (`handlePromptsList`) applies the same
  `shouldSuppressQuestion` filter to the v1/v2 question arrays when `deps.dispatcher` is present.
  It does not reject or mutate; it only drops target-root questions from the read. This closes the
  load-time race where the dock could show a pending question before the async auto-reject lands.
- The lookup is per question event; questions are rare, so no cache is required. If a cache is
  added later it must not change the fail-open behavior.

### 5.10 Exact prompt instruction

Add this exact line to the target-facing start (`#threadStartPrompt`) and follow-up
(`#threadFollowUpPrompt`) envelopes, immediately after
`Do not call send_handoff_message; the target side replies only.`:

```text
Do not use the interactive question tool in this thread. If you are blocked, reply with deliver_handoff using outcome "blocked" and put your question in result.
```

Do not add it to `#threadReplyPrompt` (the source-facing reply envelope) or to any one-shot
prompt. `permission.asked` remains allowed; the instruction only bans the interactive question
tool.

### 5.11 No migration and no management surface

- Schema version remains v22. No `ALTER TABLE`, no trigger, no index, no backfill.
- `handoffs` and `handoff_messages` are read for projection and the question guard; their writes
  are unchanged.
- No `/api/handoffs` thread management route is added. The existing human cancel route remains
  the only thread terminal action.
- No thread create/close/retry/relaunch/retarget UI, no thread composer, no thread list, and no
  attachment affordance.
- No session reuse. Thread dispatch still creates a fresh target session per the stage-0034
  lifecycle.

## 6. Change map

| File | Exact change |
| --- | --- |
| `src/coordinator/handoff-messages.ts` | Extend `HandoffMessageMeta` with optional `mode`, `kind`, `authorSide`, `messageId`, `seq`. Add a thread row type and the live/history thread SQL from §5.2-§5.3, `threadMetaFor`, and `threadMessageMap`. Keep `metaFor`/`messageMap` for one-shot unchanged. In `projectHandoffMessages`, keep the one-shot query and add the thread query; annotate with thread precedence. In `createHandoffEventResolver`, query thread first, then the unchanged one-shot query. |
| `src/http/prompts.ts` | `streamAppEvents`: add the `question.asked` suppression branch from §5.9. `handlePromptsList`: apply the same target-root filter to the v1/v2 question arrays. No other change. |
| `src/coordinator/dispatcher.ts` | `observe`: handle `question.asked` before the tool-part early return. Add `#seenQuestions`, `#observeThreadQuestion`, `#rejectThreadQuestion`, `#resolveSessionRoot`, `#isThreadSourceRoot`, `#isThreadTargetRoot`, and public `shouldSuppressQuestion`. Make `#resolveObservedRoot` delegate to `#resolveSessionRoot`. Add `rejectQuestion`/`rejectQuestionV2` to `HandoffDispatcherClient` and `DEFAULT_CLIENT`. Extend `#threadStartPrompt` and `#threadFollowUpPrompt` with §5.10. |
| `assets/chat-core.js` | Extend the `HandoffMessageMeta` JSDoc typedef and `normalizeHandoffMeta` with the optional `mode`, `kind`, `authorSide`, `messageId`, `seq` fields. `handoffBodyFromText`: sniff thread start/message/reply markers before one-shot markers, following §5.5. `handoffNoteFromText` unchanged. |
| `assets/chat-core.d.ts` | `normalizeHandoffMeta` already returns `Record<string, unknown> | null`, so no field list changes; keep the `handoffBodyFromText`/`handoffNoteFromText` signatures unchanged. |
| `ui/chat/types.ts` | Add the optional thread fields to `ChatHandoffView`. |
| `ui/pages/ChatPage.vue` | `normalizeHandoffMetadata`: pass `mode`, `kind`, `authorSide`, `messageId`, `seq`; set `note = ""` and skip `handoffNoteFromText` for threads; keep the one-shot body/note path unchanged. `threadMessages` still projects `record.handoff`. |
| `ui/components/chat/HandoffCard.vue` | Add the thread branch from §5.7: `data-mode`, `data-kind`, `data-seq`, Thread chip, visible author, kind label, sequence, route, reply-only outcome, `role="group"`/`aria-label`, sealed body, detail disclosure, no note block. Keep the one-shot branch unchanged. |
| `src/http/styles.css` | Add the thread-only selectors from §5.7. No token, shadow, brass, or side-stripe additions. |
| Tests | `test/handoff-messages.test.ts`, `test/handoff-dispatcher.test.ts`, `test/app-events.test.ts` or `test/prompts-http.test.ts` for SSE, `test/chat-core.test.ts`, `test/ui/chat-cards.test.ts`, `test/ui/chat-message.test.ts`, `test/chat-feed-store.test.ts` or `test/chat-feed-characterization.test.ts`, and `test/chat-page.test.ts` as described in §7. |
| No change | `src/opencode/events.ts`, `src/http/chat.ts`, `src/opencode/client.ts`, `src/http/*` other than `prompts.ts`, and `ui/stores/chat-feed.ts` keep their current behavior; the existing hooks already cover the thread path. Tests cover the merge and projection boundary. |

Not changed at all: no migration or schema-version test; no `/api/handoffs` management route or
`HandoffsPage` action; no attachment or target-initiated path; no worktree isolation; no
`sendPromptAsync` agent selector or per-thread agent/profile.

## 7. Test matrix

### 7.1 Projection: live and history

- Source `request`/`message` in target history and target `reply` in source history: assert
  `mode="thread"`, `direction`, `kind`, `authorSide`, `agent`/`from`/`to`, header
  `state`/`summary`/`origin`/`replyState`, `outcome`, `messageId`, `seq`, DB `body`, and no
  `operatorNote`.
- Live resolver for the same rows: identical fields, no `body`; unknown ids return `undefined`;
  a thread match does not fall through to one-shot.
- Thread precedence wins a synthetic id collision.
- Page scoping: only page ids are annotated; another session, assistant messages, and null
  `delivery_message_id` rows are untouched.
- Author deletion falls back to the participant key/id for the recorded side.
- One-shot exact-shape regression still passes; new fields are absent.
- Thread rows still leave all one-shot routing columns null. Rename/replace the stale "does not
  annotate thread messages as HandoffCard" test so it uses a real `delivery_message_id` and
  asserts thread meta.

### 7.2 Body extraction and client normalization

- `handoffBodyFromText` extracts start/reply after the `Summary:` block and the first following
  blank line, and message directly; CRLF is equivalent; missing marker/fence returns `""`;
  one-shot extraction is unchanged.
- A one-shot prompt whose `spec`/`result` contains a literal thread marker still uses the
  one-shot `Specification:`/`Result:` extraction; thread sniffing only triggers when the marker
  is the first non-empty line.
- A multi-line `Summary:` in a thread start/reply is fully removed through the first following
  blank line, not partially leaked into the body.
- `normalizeHandoffMeta` accepts the five thread fields with the §5.6 bounds and omits invalid
  values; one-shot objects keep the same normalized shape.
- `ChatPage.normalizeHandoffMetadata` passes the fields, prefers server body, falls back to
  thread text on live frames, and never creates a note from a thread body containing
  `Operator note (trusted):`.
- `chat-feed` merge preserves a history thread body across a later body-less live frame and
  introduces no note.

### 7.3 UI: `HandoffCard` thread variant and operator bubble

- Thread request/message/reply render `data-mode="thread"`, `data-kind`, `data-seq`, `Thread`
  chip, author, kind label, `#<seq>`, route, summary, and sealed Markdown body.
- Reply-only outcome chip; long-body disclosure reused; thread card has `role="group"` and the
  exact `aria-label`, with the avatar still `aria-hidden`.
- The thread card has no `handoff-card__note` even when `note` is non-empty.
- One-shot card test passes unchanged with no extra thread attributes.
- `ChatMessage` thread handoff gets `message--handoff`, not `message--user`, no
  `data-message-meta`, and no operator text/tool parts; a plain operator message still gets its
  bubble. `ChatPage`/`ChatThread` adds no second meta row.

### 7.4 Question guard

- v2 target root calls `rejectQuestionV2(endpoint, observedSessionID, request.id)` once and not
  v1; v1 target root calls `rejectQuestion(endpoint, request.id)` once and not v2.
- A target subagent resolves to the target root and uses the child `request.sessionID` for v2.
- No reject for a source root (even in the pathological source+target fixture), operator/
  unrelated root, terminal thread, one-shot handoff, or `permission.asked`.
- Duplicate `question.asked` key -> one reject.
- 404/409/human race is swallowed with no throw/retry.
- Unresolved endpoint/root -> no reject, one bounded warning, question remains answerable.
- Logs contain only app id, short session id, source, and status; no question text/answers.
- Existing tool binding tests remain green.

### 7.5 SSE suppression and prompt text

- `streamAppEvents` drops `question.asked` for a target root when `deps.dispatcher` is present;
  it forwards when the dispatcher is absent, the root is source/operator/unrelated, or root
  resolution fails.
- SSE forwarding covers a terminal-thread question and a source+target overlap question
  (source-first precedence), so `state='in_progress'` is locked for suppression.
- The `/api/apps/:app/prompts` list excludes a target-root question when the dispatcher is
  present, and forwards source/operator/unrelated/unresolved; without a dispatcher it forwards
  all.
- `permission.asked`, `question.replied`, and `question.rejected` are forwarded.
- Start and follow-up prompts contain the exact §5.10 line; reply and one-shot prompts do not;
  permission text is unchanged.

### 7.6 Gates

```bash
npm run lint && npm run typecheck && npm run typecheck:ui && npm test
npm run build && npm run check:ui && npm run check:sensitive
npm run test:e2e
```

`test:e2e` is **required**: this stage changes `ui/components/chat/HandoffCard.vue` and
`src/http/styles.css`, i.e. the rendered `/chat` route. Add a deterministic thread-card assertion
to `e2e/spa-chat.spec.ts` (or its fixture) covering the agent author, `Thread` chip, `#seq`, and
the absence of the operator bubble. `check:ui` remains.

## 8. Risks and residual

- The question ban is policy, not a hard security boundary: a compromised agent can call the
  upstream loopback directly or avoid the question tool. The guard only removes the normal path.
- The guard depends on the same dispatcher `onEvent` hook as thread binding. If context monitors
  are disabled, threads do not bind and the guard is inactive; the SSE and prompts-list filters
  are gated only on dispatcher presence, so they can still hide a question without an auto-reject.
  Production enables the hook; if monitors can be disabled at runtime, gate suppression on a
  shared `guardActive` signal. This is a residual, not the normal path.
- Root resolution failure leaves the question visible and answerable (deliberate fail-open); a
  human answer racing the reject produces 404/409, which is swallowed with no retry.
- The auto-reject is not a chat notice and does not fail the thread; the prompt asks the agent to
  reply `blocked`, and an agent that does neither remains blocked by its own turn.
- UI suppression happens only with a dispatcher; tests, embeds, or a degraded coordinator without
  one may still show the question, and the server guard is absent there too.
- Live metadata is body-less; a frame over the 8 KiB cap loses the live card for that frame while
  history still projects it. Body extraction is display-only: a hostile body can change the
  displayed text, never the server-derived author/thread/kind/seq.
- Thread messages remain ordinary user turns, so stage-0034 prompt-injection residual is
  unchanged. One-shot behavior is unchanged; no thread-management UI, attachment path,
  target-initiated message, or worktree isolation is added. The guard logs only fixed metadata;
  no question text is written.

## 9. Alternatives considered

| Alternative | Decision | Reason |
| --- | --- | --- |
| New `ThreadMessageCard` component | Rejected; use a `HandoffCard` thread variant | A second card would duplicate body Markdown safety, long-body disclosure, inbox linking, outcome tone, and accessibility, and would drift from the one-shot card. The variant keeps one rendering contract and adds only the thread fields. |
| Parse author/thread identity from envelope text on the client | Rejected; parse only the body | Text is attacker-controlled and can mimic `From application:` or a handoff id. Server projection from `handoff_messages` + `apps` is the only authoritative source. |
| Global `question` deny in the permission policy | Rejected | The policy is instance-wide and would also remove the operator's ability to answer questions in their own sessions. The guard is scoped to thread target sessions. |
| Prompt-only question ban | Rejected as insufficient | A model can still call the question tool; the operator would see an unanswerable agent-to-agent question. The server guard is the actual block. |
| Abort the target turn or fail the thread on a question | Rejected | The source message was already delivered; killing the turn destroys useful work and there is no thread failure state for a started thread. Auto-reject lets the agent continue to a `blocked` reply. |
| Per-thread agent/profile or `sendPromptAsync` agent selector | Rejected | `sendPromptAsync` has no agent selector and the client has no per-thread agent choice. This is a separate future design. |

## 10. Open questions

None. The metadata shape, live/history SQL, card variant, body extraction, question guard, SSE
filter, prompt text, change map, and test matrix are fixed; no schema or lifecycle decision
remains open.
