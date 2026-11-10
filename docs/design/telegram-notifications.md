# Design - Telegram notifications

Status: **revision 7 - design review round 6 PASS WITH FIXES, findings folded** (2026-11-10). Owner
decisions are recorded in section 12. Design review gate cleared; plan review (`momus`) pending.
Plan:
`docs/plans/0041-telegram-notifications.md` (pending).

Scope: outbound Telegram notifications for a self-hosted Hanse coordinator. The notifier reports
two things: (a) a top-level agent turn is finished and nothing is still running on its behalf, and
(b) the agent is blocked or was interrupted and needs the operator (questions, permissions, SSH
approvals, handoff approvals, parked handoff replies/messages, agent stop/error). Every notification
carries a link to the session, or to the app/project when no session exists. Quick replies from
Telegram are a later stage.

Non-goals for this stage: inbound Telegram commands or quick replies; per-project chats or forum
topics (the settings hierarchy already allows them later); a webhook endpoint; Telegram as a
general chat client; file/photo attachments from the agent; notification history in the web UI;
multi-user subscriptions (one operator, one chat for now); a second outbound transport (email,
Slack, push).

Governing context: [`docs/current-state.md`](../current-state.md) (chat turn state, handoffs, SSH
approvals, agent process status, settings, secrets), [`interactive-prompts.md`](./interactive-prompts.md),
[`chat-turn-state.md`](./chat-turn-state.md), [`agent-process-status.md`](./agent-process-status.md),
and the Telegram Bot API (10.4, 2026-11-09; Rich Messages 10.1, 2026-06-11).

---

## 1. What exists today

The coordinator already observes everything the notifier needs; it just does not deliver it.

- **Turn lifecycle.** `ContextMonitor` holds the opencode SSE stream and forwards every projected
  `HanseEvent` to `InstanceManager`'s `onEvent` callback (`src/opencode/manager.ts:2444-2464`).
  `session.status {type:"idle"}` is the turn-idle signal; `session.error` is the turn-error signal.
  The authoritative completion check is `deriveTurn` (`src/chat/turn.ts:249-327`):
  `status=idle && turnContinues=false && activePromptID=null && !queuedTruncated`.
- **Subagent activity.** `ContextTracker` computes `hasActiveChildren(sessionID)` and
  `hasPendingTask(sessionID)` (`src/opencode/context.ts:603-631`), exposed on `ContextSnapshot` as
  `activeChildren`/`pendingTask` (`context.ts:51-71`). `hasActiveChildren` currently walks **direct
  children only** and returns `false` for an unhydrated tracker; both limits are addressed in this
  design.
- **Subagent tree.** Subagent sessions are ordinary opencode sessions linked by `parentID`
  (`src/opencode/client.ts:5-11`); `collectSessionSubtreeIDs` (`src/chat/session-tree.ts:30`) walks
  the tree.
- **Handoffs.** One-shot states are `queued|awaiting_approval|dispatching|in_progress|delivered|
  rejected|failed|expired|cancelled`; replies have `reply_state =
  none|pending|awaiting_approval|delivered|waiting_operator|failed|cancelled`
  (`src/coordinator/handoff.ts:4-41`). `handoffs.mode` is `one_shot|thread` (migration v22,
  `src/store/migrations.ts:767`). Thread headers start as `queued` or `awaiting_approval`, then
  `dispatching`/`in_progress`; they never reach `delivered` and end in `expired`/`cancelled`
  (`handoff.ts:139-153`). Thread messages have
  `state = binding|queued|dispatching|delivered|waiting_operator|cancelled`, `author_side`, `kind`,
  `delivery_session_id`, and `reply_to_message_id` (`migrations.ts:774-790`).
- **Handoff binding.** Both one-shot `createHandoff` and thread creation insert neither
  `source_session_id` nor `source_invoking_session_id`; the dispatcher binds them later from the
  observed tool event (`src/coordinator/handoff.ts:469-487`, `src/coordinator/thread.ts:771-799`,
  `src/coordinator/service.ts:323-351`). The thread initial binding sets both in one transaction
  (`src/coordinator/dispatcher.ts:1258-1271`). The binding timeout is
  `HANDOFF_BINDING_TIMEOUT_MS = 10 min` (`dispatcher.ts:46`); in normal operation the window is
  milliseconds.
- **Interactive prompts.** `question.asked` / `permission.asked` arrive on the same stream; the
  answer endpoints already exist (`src/http/prompts.ts:341-486`). Thread-target questions are
  auto-rejected and suppressed (`src/coordinator/dispatcher.ts:380-420`).
- **SSH approvals.** `SshService.withOperation` creates a pending row and blocks up to 30 s
  (`src/ssh/service.ts:684-752`); no event is emitted.
- **Handoff approvals.** `requestApproval` writes an `approvals` row
  (`src/coordinator/approval.ts:71-103`) from `CoordinatorService` dispatch/reply and from thread
  start (`src/coordinator/thread.ts:692, 824`); no event is emitted.
- **Agent process notices.** `subscribeNotices` delivers `agent_stopped`, `subagent_interrupted`,
  `resume_started`, `resume_failed`, `resume_completed`, `resume_unavailable`
  (`src/opencode/recovery.ts:79-85`); persisted notices are in `session_notices`
  (`migrations.ts:698-709`) and are not replayed to a new subscriber. The reason vocabulary is
  `SESSION_NOTICE_REASONS` (`recovery.ts:87-105`).
- **Settings and secrets.** Hierarchical `global -> project -> app` settings
  (`src/settings/service.ts:101-110, 499-589`), AES-256-GCM sealed secrets in `setting_secrets`
  (`src/settings/git-auth.ts`), and a settings SPA with write-only secret fields.
- **Public links.** All browser links are root-relative. The session link is
  `/chat?app=<appKey>&project=<projectId>&session=<sessionId>`
  (`src/http/props/project.ts:200-208`). There is no public base URL setting today.
- **No notification transport exists.** No Telegram, webhook, SMTP, or push code or config.

---

## 2. Requirements

| ID | Requirement |
|---|---|
| R1 | Notify when a top-level agent turn is finished and nothing is still running for it. |
| R2 | Do not report "finished" while any subagent of that session is running. |
| R3 | Do not report "finished" while the session is waiting for an in-flight handoff reply or an undelivered thread message. |
| R4 | Notify when the agent is blocked on a human decision: question, permission, SSH approval, handoff dispatch/reply approval, or a parked handoff reply/message. |
| R5 | Notify when the agent was interrupted: `session.error`, unexpected agent stop, or a failed/unavailable resume. |
| R6 | Every notification links to the session, or to the app/project when the event has no session. |
| R7 | The completion message contains the full final assistant answer with Telegram rich formatting. |
| R8 | Delivery survives a coordinator restart and rate limits; duplicates are suppressed per chunk. |
| R9 | The bot token and proxy credentials are encrypted at rest and never returned by an API, a page prop, a log, or a toast. |
| R10 | Outbound Telegram traffic can go through an HTTP(S) or SOCKS5 proxy on Node 20. |
| R11 | Configuration is hierarchical (`global -> project -> app`) and editable in the settings SPA. |
| R12 | The notifier never starts a stopped agent and never performs a destructive operation. |

---

## 3. Architecture

```text
opencode SSE ──> ContextMonitor ──> InstanceManager.onEvent ──┐
                                                              ├─> NotificationRouter
notices (agent_stopped/resume_*) ─────────────────────────────┤     │  rules + completion predicate
SSH approval created ──> notificationEvents.emit ─────────────┤     │  dedupe + watermark
handoff approval/failure ──> notificationEvents.emit ─────────┘     v
                                                              notification_outbox (one row per chunk)
                                                              notification_watermarks
                                                              notification_meta
                                                              notification_channel_state
                                                                     │
                                                              NotificationSender (single loop)
                                                                     │  resolve settings + secret
                                                                     v
                                                              TelegramTransport
                                                               direct fetch | node:https + proxy agent
                                                                     │
                                                                    Telegram
```

Modules under `src/notifications/`:

| Module | Responsibility |
|---|---|
| `events.ts` | Module-level bus for signals that are not agent events (SSH approval, handoff approval/failure/delivery, parked thread message). Mirrors `processEvents`; every signal carries a transition timestamp. |
| `router.ts` | Subscribes to agent events, notices, and `notificationEvents`; applies the completion predicate and attention rules; writes deduped chunk rows and watermarks. |
| `catch-up.ts` | Boot/reconnect sweep of top-level sessions and unnotified notices; runs after the dispatcher's unbound reconciliation. |
| `outbox.ts` | Durable queue: claim, retry, prune, reset on boot, payload clearing, group-dead helper. |
| `telegram/` | `transport.ts` (direct/proxy HTTPS), `client.ts` (`sendRichMessage`/`sendMessage`), `format.ts` (message bodies, block/column counting, chunking, plain re-chunking). |

The router is process-local. Durable state is in `notification_outbox`, `notification_watermarks`,
`notification_meta`, `notification_channel_state`, and `setting_secrets`. The sender is the only
component that talks to Telegram.

---

## 4. Completion predicate

A completion notification for session `S` is enqueued only when every check passes. The check runs
after a debounce (`NOTIFY_SETTLE_MS = 2500`) from the last `session.status idle` for `S`, and is
re-scheduled by any of: a child session going idle, a pending prompt being answered, a handoff reply
being delivered (`handoff_reply_delivered`), and the 60 s deferred sweep.

### 4.1 Checks

1. **Top-level session.** `sessions = listSessionsBounded(endpoint)`; `S` exists and has no
   `parentID`. Subagent completions are not reported directly.
2. **Still idle.** `statuses = listSessionStatusesStrict(endpoint)`; `statuses[S]` is absent or
   `type === "idle"`. A `busy`/`retry` status cancels the notification.
3. **No running subagent (positive signal).** Call
   `manager.sessionActivity(appId, S)`, backed by the `ContextTracker`. The new API returns
   `{ activeChildren, pendingTask, known }`:
   - `activeChildren` walks the **whole subtree** (not only direct children) and treats a child
     with `busy`/`retry`/`compacting`, or an `unknown` child with activity inside
     `CHILD_ACTIVITY_WINDOW_MS`, as active.
   - `known` is `false` until `setSessionParents`/`#refreshParents` has run for the app. Require
     `known === true`; otherwise **defer**. `manager.sessionActivity` must hydrate before returning:
     reuse `monitor.snapshot`/`#hydrate`, or call `#refreshParents` + `setSessionParents` with the
     session list from check 1. Do not rely on a browser `/context` call, because
     `#refreshParents` only runs when auto-compaction is enabled (default off). Do not guess from
     the status map.
   - Require `activeChildren === false && pendingTask === false`. As a second signal, no descendant
     in `collectSessionSubtreeIDs(sessions, S)` has `busy`/`retry` in the status map. An absent
     child is **not** treated as idle: the tracker is the positive confirmation.
4. **No queued prompts.** Use a shared `readTurnSnapshot(endpoint, S, { isSubagent: false })`
   helper (extracted from the `/turn` route) that reads status -> history -> status, pages back to
   the boundary within a budget, and calls
   `deriveTurn(messages, status, { isSubagent: false, settling, queuedTruncated })`. Require
   `activePromptID === null`, `queuedPromptIDs.length === 0`, `queuedTruncated === false`, and
   `settling === false`. The helper returns `{ snapshot, messages, answerMessageId, answerText }`;
   `answerMessageId` is the last assistant message with **visible text** (not a tool/reasoning-only
   message), and `answerText` is its concatenated text. Both helpers use the same message list, so
   the id and the body cannot disagree. A truncated page budget or a settling race defers the
   check, never completes it.
5. **No pending prompt in the subtree.** Read v1 and v2 questions and permissions (the same
   `Promise.allSettled` shape as `GET /prompts`, with the v2 `location: { directory: appDir }`).
   **Fail closed:** any rejected read defers the check. Suppress completion if any request's
   `sessionID` is in `collectSessionSubtreeIDs(sessions, S)`, not only `S`. A child blocked on a
   question must not look like a finished parent.
6. **No in-flight one-shot handoff.** The predicate is **subtree-aware**, because a one-shot
   handoff started by a subagent binds the invoking session, not the root. `:subtreeJson` is the
   JSON array from `collectSessionSubtreeIDs(sessions, S)` (capped at 500 ids):

   ```sql
   SELECT 1 FROM handoffs
   WHERE mode = 'one_shot'
     AND (
       source_session_id IN (SELECT value FROM json_each(:subtreeJson))
       OR (source_session_id IS NULL
           AND source_invoking_session_id IN (SELECT value FROM json_each(:subtreeJson)))
     )
     AND (
       state IN ('queued','awaiting_approval','dispatching','in_progress')
       OR (state = 'delivered' AND reply_state IN ('pending','awaiting_approval'))
     )
   LIMIT 1
   ```

   The predicate is subtree-aware, so a one-shot handoff bound to the invoking subagent is caught
   by the first branch; `bindSourceSession` keeps its current semantics (`source_session_id` is the
   invoking session, which is the reply target) and does not change reply routing.
   `source_invoking_session_id` is recorded by the thread initial binding (root in
   `source_session_id`, invoker in `source_invoking_session_id`); the `source_session_id IS NULL`
   branch covers a partially bound row. `waiting_operator` and `failed` are excluded from
   suppression; they get their own attention notification (section 6).
7. **No outstanding thread work.** Thread headers are non-terminal in
   `queued|awaiting_approval|dispatching|in_progress` (they never reach `delivered`):

   ```sql
   SELECT 1
   FROM handoffs h
   JOIN handoff_messages m ON m.handoff_id = h.id
   WHERE h.mode = 'thread'
     AND h.state IN ('queued','awaiting_approval','dispatching','in_progress')
     AND (
       h.source_session_id IN (SELECT value FROM json_each(:subtreeJson))
       OR (h.source_session_id IS NULL
           AND h.source_invoking_session_id IN (SELECT value FROM json_each(:subtreeJson)))
     )
     AND (
       (m.delivery_session_id = :S AND m.state IN ('binding','queued','dispatching'))
       OR (
         m.author_side = 'source'
         AND m.kind IN ('request','message')
         AND m.state IN ('binding','queued','dispatching','waiting_operator')
       )
       OR (
         m.author_side = 'source'
         AND m.kind IN ('request','message')
         AND m.state = 'delivered'
         AND NOT EXISTS (
           SELECT 1 FROM handoff_messages r
           WHERE r.handoff_id = m.handoff_id
             AND r.kind = 'reply'
             AND r.reply_to_message_id = m.id
             AND r.state IN ('delivered','waiting_operator','cancelled')
         )
       )
     )
   LIMIT 1
   ```

   The first branch catches a reply being delivered to `S` but not yet arrived. The second catches
   a source message that has not reached the target, or is parked `waiting_operator`; a parked
   thread message also emits a `thread_message_waiting` attention. The third catches a delivered
   source message with no terminal reply. A reply in `binding|queued|dispatching` is caught by the
   first branch. `delivered`/`waiting_operator`/`cancelled` are terminal for waiting purposes;
   `waiting_operator` also gets attention.
8. **No unbound handoff in the binding window.** One-shot and thread handoffs are created with both
   source columns NULL and bound on a later event. While unbound they are invisible to checks 6
   and 7. The router therefore **defers** when the app has any non-terminal `handoffs` row with
   `source_session_id IS NULL AND source_invoking_session_id IS NULL` and
   `created_at > now - NOTIFY_UNBOUND_GRACE_MS` (60 s). The grace is shorter than the dispatcher's
   10-minute failure cutoff: normal binding is immediate, and a handoff that stays unbound past the
   grace no longer suppresses completions. The failure paths are named: one-shot
   `#failUnboundHandoffs` (`dispatcher.ts:769-788`) and thread
   `#failTimedOutBindings`/`#failThreadStart` (`dispatcher.ts:1405-1430`); both emit a
   `handoff_failed` attention after their transition commits.
   The notifier boot sweep waits for `handoffDispatcher.ready()` (a new promise resolved after the
   startup unbound/binding reconcile) before it runs; `ready()` resolves even if the reconcile
   throws, and a failure falls back to the 60 s unbound defer. If the promise is unavailable, it
   defers while any unbound row exists. This closes the boot ordering gap.
9. **Dedupe and watermark.** `base = "turn:<appId>:<sessionId>:<answerMessageId>"`; when
   `answerMessageId` is null (a turn with no new visible text), use
   `"turn:<appId>:<sessionId>:<lastUserMessageId>:<5mBucket>"` so repeated `Done` turns are not
   collapsed and a tool-only turn after a text turn is a distinct occurrence. The bucket is anchored
   to the turn (the last user message's `time.created` or the idle event time), never to `now`, so a
   re-evaluation after a bucket roll does not duplicate the `Done`. The answer search is
   scoped to the current turn (after the last non-handoff user prompt); it never reuses the previous
   turn's answer id. Each chunk row uses `dedupe_key = "<base>:<chunkIndex>"` (plain-fallback rows use
   `"<base>:plain:<newGroupId>:<index>"`, where `newGroupId` is the fallback group's UUID, so a
   second fallback cannot collide). If the outbox already has any chunk for the base, update
   the watermark to the current answer id (or occurrence id) and skip; this keeps the 60 s sweep
   from re-running the predicate and from re-enqueuing after a prune.

If any check fails, the router records `S` in a bounded in-memory deferred set and retries on the
next trigger or the 60 s sweep, up to 30 minutes. The boot/reconnect sweep (section 4.3) covers a
restart that loses the in-memory set.

### 4.2 Reads and caching

The predicate runs only on idle transitions, not per token. `listSessionsBounded` is capped at
2 MiB and 5 s; `listSessionStatusesStrict` is a single small `GET`; the turn snapshot and prompt
lists are bounded. A per-app 10 s cache is allowed **only** for the session list
(`listSessionsBounded`); never for the status map or the tracker activity used in the final check.
`history_busy` or a `messages_too_large` read defers the check, never completes it. A per-session
single-flight guard prevents a burst of idle frames from multiplying reads. The subtree JSON is
validated and capped at 500 ids; an oversized or invalid subtree defers the check.

If the endpoint is gone (`manager.endpointFor` returns `undefined`), the router skips the
completion; the interruption notice covers the stop.

### 4.3 Restart, reconnect, and watermark semantics

`ContextMonitor` currently never emits `stream.ready`, so the manager's `stream.ready` branch is
dead and a restart loses an idle that arrived while the coordinator was down. This stage fixes that:

- `ContextMonitor` emits a synthetic `stream.ready` event on every successful attach/reconnect.
  The manager already handles it by sampling statuses; the router uses the same event to run the
  catch-up sweep for that app.
- A persisted `notification_meta` row `telegram.first_sweep_at` records when the feature first
  became active. On the first enable (boot or a runtime enable transition), the router sets it to
  `now` and initializes a watermark for every existing top-level session to the same
  `answerMessageId`/occurrence id the predicate computes **without notifying**. This prevents a
  historical flood on first enable, including a tool-only tail.
- Thereafter, one rule is shared by the event path and the catch-up path:
  - watermark exists and differs from the current answer id -> enqueue and update;
  - watermark absent and the session's `time.created` is **after** `first_sweep_at` -> it is a new
    session; enqueue its first completed turn and update;
  - watermark absent and the session predates `first_sweep_at` -> initialize without notifying
    (historical session from before the feature);
  - `time.created` missing -> initialize without notifying (conservative; documented limit).
- **Channel and mode gates.** The effective `notifications.mode` is:
  `off` = no notifications; `attention` = attention kinds only (no `turn_completed`);
  `all` = attention + `turn_completed`. The router gates `turn_completed` on `mode === "all"` and
  attention on `mode !== "off"`, and also requires `notifications.telegram.enabled`. While
  disabled it advances the completion watermark to the current answer id, so re-enabling starts
  from the next turn. On a transition to `off`, all pending rows are marked `dead` with
  `error_code = "channel_disabled"`; on a transition to `attention`, pending `turn_completed` rows
  are marked `dead` with `error_code = "mode_attention"`.
- **Notice scan marker.** `notification_meta.telegram.notice_scan_at` is set to `now` on the first
  enable and advanced to `now` on every boot while the channel is disabled; the live notice handler
  also advances it while disabled. `notification_meta.telegram.channel_enabled` persists the last
  observed enabled state; `telegram.enabled_at` is set to `now` only on a real disabled→enabled
  transition, and the boot sequence writes it **before** the notice scan. The boot scan enqueues
  only notices with
  `created_at > max(notice_scan_at, enabled_at)` (and within 7 days), so a re-enable cannot replay
  notices from a disabled period that occurred between boots. After a successful scan, the marker
  advances to the newest scanned `created_at`.
- On boot, and on `stream.ready`, `catch-up.ts` sweeps every top-level session of every running app
  with the rule above. The notifier starts after `handoffDispatcher.start()`; the boot sweep runs
  after the dispatcher's `#reconcileUnbound` pass (or applies the 60 s unbound defer). A per-app
  sweep also runs when an app first produces an event after a start.
- On boot, scan `session_notices` from the last 7 days, restricted to the four attention kinds
  (`agent_stopped`, `subagent_interrupted`, `resume_failed`, `resume_unavailable`) and to the
  reason matrix in section 6; enqueue each unnotified row with `dedupe_key = "notice:<noticeId>"`.
  The outbox unique key makes the scan idempotent.

---

## 5. Full answer extraction and formatting

There is no server-side assistant-text helper today. `readTurnSnapshot` and `readFinalAnswer` are
the same read: one message list, one status read, one `deriveTurn`. The helper returns
`{ snapshot, messages, answerMessageId, answerText }`:

1. Read the newest page with `listMessagePage(endpoint, S, { limit: 50, maxBytes: 8 MiB })`.
2. Project it with `createMessageProjector` and `projectHandoffMessages` (so handoff user rows are
   not mistaken for assistant text).
3. Find the last assistant message with a visible **text** part **within the current turn**, using
   the same boundary and exclusions as `deriveTurn` (handoff/OMO/resume/synthetic rows are not
   boundaries), by array order. A trailing tool/reasoning-only assistant is not the answer id; if
   the current turn has no text-bearing assistant, the answer is empty (do not reuse the previous
   turn's text).
4. Concatenate its visible `text` parts in order, joined by `\n\n`. Handle the `part.data` wrapper,
   and exclude ignored/synthetic/attachment-manifest/agent-resume/blank parts. Text parts already
   contain model Markdown.
5. If the newest page has no visible text assistant, page older with `before` up to three pages.
   For a single message larger than the page cap, read it with `getMessage` and a larger `maxBytes`
   (default 8 MiB, up to the 48 MiB history cap).
6. If the current turn has no visible assistant text, return `{ answerMessageId: null, answerText: "" }`
   and send a short `Done` body; the dedupe base uses the last user message id plus a 5-minute bucket.

The returned `answerMessageId` is the same id used by the turn snapshot for the dedupe base and
watermark; the two helpers are one implementation, so they cannot disagree.

### 5.1 Telegram rich messages

The completion body is sent with `sendRichMessage` and `rich_message: { markdown: body }`
(Bot API 10.1+, current 10.4). Rich messages support headings, lists, tables, code blocks,
blockquotes, details, math, and inline buttons, with limits of 32768 UTF-8 characters, 500 blocks,
16 nesting levels, 50 media, and 20 table columns. Block counting includes nested blocks, list
items, table rows, quotes, and details, not only top-level paragraphs. The model Markdown is passed
through; no MarkdownV2 escaping is needed.

**Fallback is mandatory and covers ordinary agent output, not only an old server:**

- Count blocks, table columns, and characters before sending. If the chunk exceeds 500 blocks or
  contains a table with more than 20 columns, format that chunk as plain text (4000-character
  chunks) at enqueue time.
- On a `400` whose description indicates a parse/format/limit error, or on `404` (unknown method),
  **re-chunk the remaining suffix** (the failed chunk N through the last chunk) in one transaction:
  mark the rich rows N..end `dead` with
  `error_code = "rich_fallback"`, split their combined text into plain parts of at most 4000
  characters, and insert new `format='plain'` rows with a new `group_id`, `chunk_index`,
  `chunk_count`, and `dedupe_key = "<base>:plain:<newGroupId>:<index>"`. The link button goes on the
  last plain chunk. Chunks 0..N-1 that were already sent stay as rich and are not resent. The
  fallback group is exempt from the 20-chunk cap: the suffix is bounded by the original 20 rich
  chunks, and the plain group may use as many 4000-character rows as needed.
- On `401`/`403`, mark the chunk `dead` and set the channel error; do not retry.
- The plain path sets `link_preview_options: { is_disabled: true }`. `sendRichMessage` does not
  accept `link_preview_options`, so rich messages cannot disable previews; this is a documented
  residual risk (section 11).

### 5.2 Chunking and one row per chunk

- Split on blank-line blocks; never split inside an inline link or a table row. A table row that
  alone exceeds the budget is forced to plain text and split at cell boundaries, repeating the
  header row in each part.
- Track fenced code blocks; if a split lands inside a fence, close it at the end of the chunk and
  reopen it with the same language at the start of the next.
- Hard-split a single block that exceeds 30000 characters at a newline or space, reopening fences.
  Telegram's rich limit is documented in UTF-8 characters; count Unicode code points (not UTF-16
  units) for the rich budget and also measure UTF-8 bytes, splitting further if the byte count is
  close to 32768. For the plain `sendMessage` budget, measure both code points and
  UTF-16 units (JS `.length`) and use the larger value, because entity offsets are UTF-16 and a
  surrogate pair counts as two units; keep a margin for emoji.
- Budget 30000 characters per rich chunk and 4000 characters per plain chunk. If the block/column
  count forces plain text, use the plain budget for that chunk.
- **One outbox row per chunk.** A notification is a group of rows sharing `group_id`, with
  `chunk_index` 0..n-1 and `chunk_count`. The header is in chunk 0; the session link button is in
  the last chunk. Per-chunk dedupe keys and per-chunk retry prevent a 429 on chunk N from resending
  chunks 1..N-1. A rich fallback creates a new plain group for the remaining suffix (section 5.1),
  so the original group is closed with dead rich rows.
- A permanent failure of a chunk marks the remaining chunks of its group `dead` with
  `error_code = "chunk_failed"` in the same transaction.
- A group is capped at 20 chunks; beyond that the answer is truncated with a `truncated` marker and
  a session link.

### 5.3 Message bodies

Plain labels, no emoji:

| Kind | Body |
|---|---|
| `turn_completed` | `<Project> / <App>` newline `<session title>` newline blank line `<full answer>` |
| `question` | `<Project> / <App> - needs an answer` newline `<session title>` newline blank line `**<header>**` newline `<question>` newline options list |
| `permission` | `<Project> / <App> - permission required` newline `<session title>` newline `<permission>` (`<tool>`) newline `<patterns/command>` |
| `ssh_approval` | `<Project> / <App> - SSH approval` newline `<host> - <action>` newline `<command preview>` newline `Expires <time>.` |
| `handoff_approval` | `<Project> - handoff approval` newline `<source> -> <target>` newline `<summary>` |
| `handoff_waiting_operator` | `<Project> - handoff reply needs an operator` newline `<source> -> <target>` newline `<summary>` |
| `handoff_failed` | `<Project> - handoff failed` newline `<source> -> <target>` newline `<state/reason>` |
| `thread_message_waiting` | `<Project> - thread message needs an operator` newline `<source> -> <target>` newline `<summary/error>` |
| `agent_interrupted` | `<Project> / <App> - agent interrupted` newline `<session title>` newline `<sanitized message>` |

The session link button is `Open session`, URL
`<publicBaseUrl>/chat?app=<appKey>&project=<projectId>&session=<sessionId>`. When the row has no
`session_id` (SSH or handoff approval), the button is `Open app` with
`<publicBaseUrl>/chat?app=<appKey>&project=<projectId>`, or the project page when there is no app.
If the public base URL is missing, the message is sent without the button; the settings page shows
the warning. Error text is sanitized with `sanitizeProcessError` (or the same redactor) before it
reaches a message.

---

## 6. Attention triggers

| Trigger | Source | Dedupe key |
|---|---|---|
| Question asked | `question.asked` | `question:<appId>:<source>:<requestId>` |
| Permission asked | `permission.asked` | `permission:<appId>:<source>:<requestId>` |
| SSH approval | `notificationEvents` after `SshStore.createPending` | `ssh:<approvalId>` |
| Handoff dispatch/reply approval | `notificationEvents` after the creating transaction commits | `handoff:<handoffId>:<kind>:<approvalId>` |
| Parked handoff reply | `notificationEvents` when `reply_state` becomes `waiting_operator` | `handoff-waiting:<handoffId>:<transitionAt>` |
| Handoff reply failed | `notificationEvents` when `reply_state` becomes `failed` | `handoff-failed:<handoffId>:<transitionAt>` |
| Terminal handoff failure | `notificationEvents` when a waiting source handoff becomes `failed`/`rejected`/`expired` | `handoff-terminal:<handoffId>:<state>:<transitionAt>` |
| Parked thread message | `notificationEvents` when a thread message becomes `waiting_operator` | `thread-waiting:<messageId>:<transitionAt>` |
| Agent error | `session.error` (ignore `MessageAbortedError`) | `error:<appId>:<sessionId>:<answerMessageId ?? 5mBucket>:<messageHash>` |
| Agent stop/resume failure | `subscribeNotices` (`agent_stopped`, `subagent_interrupted`, `resume_failed`, `resume_unavailable`) | `notice:<noticeId>` |
| Unnotified notice on boot | `session_notices` boot scan | `notice:<noticeId>` |

Every `notificationEvents` signal carries the transition timestamp (`transitionAt`) captured at the
transition, so a later unrelated `updated_at` change cannot create a duplicate key. Every kind,
including attention notifications, uses `<base>:<chunkIndex>` for its chunk rows, so a long
question/permission/notice body has the same per-chunk retry/dedupe behavior as a completion answer.

### 6.1 Notice reason matrix

`SESSION_NOTICE_REASONS` has exactly these 18 values (`src/opencode/recovery.ts:87-105`):
`process_exit`, `operator_restart`, `operator_stop`, `deletion`, `deployment`, `unknown_restart`,
`unknown`, `operator_abort`, `subagent_abort`, `stopped`, `stale`, `missing`, `ttl_expired`,
`superseded`, `completed`, `ambiguous`, `resume_failed`, `resume_unavailable`.

| Kind | Notify | Suppress |
|---|---|---|
| `agent_stopped`, `subagent_interrupted` | `process_exit`, `unknown_restart`, `unknown`, `missing`, `stale`, `ttl_expired`, `resume_failed`, `resume_unavailable`, an unrecognized reason | `operator_restart`, `operator_stop`, `deletion`, `deployment`, `operator_abort`, `subagent_abort`, `stopped`, `superseded`, `completed`, `ambiguous` |
| `resume_failed`, `resume_unavailable` | every reason (the resume itself failed) | - |
| `resume_started`, `resume_completed` | never | every reason |

This is a total partition of all 18 values. The boot scan is restricted to the four attention kinds
and applies the same matrix; it must not replay `resume_started`/`resume_completed`.

### 6.2 Suppressions and emission

- Questions for an active thread target session are ignored (the dispatcher auto-rejects them).
- `MessageAbortedError` is ignored (the operator stopped the turn).
- `notifications.mode = off` or `notifications.telegram.enabled = false` suppresses enqueue;
  `mode = attention` suppresses only `turn_completed` (section 4.3). The router advances the
  watermark instead of building a backlog, and dead-letters pending rows that no longer match the
  mode.
- The same attention row is never sent twice; the dedupe keys above include an occurrence identity
  (`approvalId`/`transitionAt`/`noticeId`/answer id/time bucket).
- `notificationEvents` is emitted **after** the outer transaction commits. `requestApproval`
  commits its own transaction, so the caller emits after it returns. `insertThreadApproval` runs
  inside `createThreadInternal`'s `db.transaction` (`src/coordinator/thread.ts:741-839`);
  `createThreadInternal` returns the pending approval id/`requestedAt` (or the caller queries
  `getPendingApproval` after `run.immediate()` returns) and emits after commit.
- `handoff_reply_delivered` is emitted after `markReplyDelivered` commits, so the router can
  re-schedule the source session without waiting for the 60 s sweep.
- Every transition to `waiting_operator`/`failed` for a reply or thread message goes through one
  helper that captures `transitionAt` and emits after the update commits.

---

## 7. Settings and secrets

### 7.1 Non-secret keys

| Key | Type | Scope | Default |
|---|---|---|---|
| `notifications.mode` | `off \| attention \| all` | global/project/app | `all` |
| `notifications.telegram.enabled` | boolean | global/project/app | `false` |
| `notifications.telegram.chat_id` | string (`-?\d+` or `@name`) | global/project/app | unset |
| `notifications.public_base_url` | URL (`http`/`https`, no query/hash) | global/project/app | unset |
| `notifications.telegram.api_base_url` | URL (`http`/`https`) | global/project/app | `https://api.telegram.org` |
| `notifications.include_answer` | boolean | global/project/app | `true` |

These keys are registered in `src/settings/registry.ts`, added to the `SettingsKey` union and
`EffectiveSettings`, and resolved in both `SettingsService.resolve()` and `snapshot()`.
`launchEffectiveSettings` (`src/settings/service.ts:220-228`) changes to
`Omit<EffectiveSettings, "context" | "notifications">` and keeps returning `{ llm, web, git }`, so
notification changes never mark a running agent `Restart required`. A settings-hash test proves
each notification key is excluded.

`src/master/tools.ts` `effectiveValue` gains the new key mappings, and
`src/http/props/settings.ts` `SETTINGS_SECTION_KEYS` gains `notifications`; otherwise master
`get_setting` throws for the new keys and the settings section key is missing.

### 7.2 Secrets

| Secret | Key in `setting_secrets` | Scope |
|---|---|---|
| Bot token | `notifications.telegram.bot_token` | global/project/app |
| Proxy URL | `notifications.telegram.proxy_url` | global/project/app |

Both are sealed with the existing AES-256-GCM key and exposed only as a status
(`set`/`cleared`/`missing`) in `ResolvedSettings.telegram`. The design defines
`SecretStatus = { state: "set"; source: SettingsScope } | { state: "cleared"; source: SettingsScope }
| { state: "missing" }` and `SettingsService.telegramConfig(target)`, which resolves
app > project > global with cleared tombstones, exactly like `GitAuthStore`/`ProviderKeyStore`.
The plaintext is returned only to the notifier; it is never part of `ResolvedSettings`, page props,
`/api/settings`, logs, or toasts. Reusing `setting_secrets` needs no migration; app/project deletion
already removes scoped rows (`src/coordinator/deletion.ts:1031, 1079`).

Validation (trim first; never echo the value):

- Bot token: `^\d{5,}:[A-Za-z0-9_-]{20,}$`, max 200 chars.
- Proxy URL: scheme in `http`, `https`, `socks5`, `socks5h`; no fragment; max 2048 chars.
- Chat id: numeric (optionally negative) or `@name`; max 100 chars.
- Public/API base URL: `http`/`https`, no query/hash for the public base; trailing slash stripped.
- A validation error message contains only the field name and the reason, never the submitted value.

### 7.3 Settings API and UI

- Non-secret keys use the existing `POST /api/settings` contract.
- New `POST /api/settings/telegram` (human-only, JSON-only, **cross-site guarded**):
  `{ scope, projectId?, appKey?, action: "set"|"clear"|"inherit", field: "bot_token"|"proxy_url",
  value? }` -> `{ ok: true, ...settingsResponse }`. Errors: `400 invalid_telegram_secret`,
  `400 invalid_request`, `401`, `403`.
- New `POST /api/settings/telegram/test` (human-only, JSON, cross-site guarded):
  `{ scope, projectId?, appKey? }` sends a fixed test message through the effective transport.
  Returns `{ ok: true }` or `502 telegram_unavailable` with a sanitized message. In-memory limit:
  one test per 5 s per scope.
- `isSettingsRoute` (`src/http/settings.ts:422-433`) adds both POST paths; otherwise `server.ts`
  falls through and the routes 404.
- Both new routes call `crossSiteMutation(request)` first and return `403` on a cross-site `Origin`.
  The existing `/api/settings` and `/api/settings/git` POSTs lack this guard; the new secret routes
  must not copy that omission.
- `ResolvedSettings` gains `telegram: { botToken: SecretStatus; proxyUrl: SecretStatus }`;
  `SettingsProps`, `src/http/props/settings.ts`, and `ui/settings-types.ts` gain the notification
  rows, labels, and secret status. `SettingsPage.vue` renders a `Notifications` section at every
  scope; non-secret rows use `SettingsRow`, and a new `SettingsTelegramSection.vue` (modeled on
  `SettingsProviderSection.vue`) holds the password inputs, `Not shown` placeholder,
  set/clear/inherit, and the test action.
- Tests assert that `/api/settings`, `/api/ui/settings`, master `get_settings`, logs, and toasts
  never contain the token or proxy URL.

---

## 8. Outbox and sender

### 8.1 Migration v26

```sql
CREATE TABLE notification_outbox (
  id TEXT PRIMARY KEY,
  group_id TEXT NOT NULL,
  chunk_index INTEGER NOT NULL DEFAULT 0 CHECK (chunk_index >= 0),
  chunk_count INTEGER NOT NULL DEFAULT 1 CHECK (chunk_count >= 1),
  dedupe_key TEXT NOT NULL UNIQUE,
  kind TEXT NOT NULL CHECK (kind IN (
    'turn_completed','question','permission','ssh_approval',
    'handoff_approval','handoff_waiting_operator','handoff_failed',
    'thread_message_waiting','agent_interrupted'
  )),
  format TEXT NOT NULL DEFAULT 'rich' CHECK (format IN ('rich','plain')),
  scope TEXT NOT NULL CHECK (scope IN ('global','project','app')),
  project_id TEXT,
  app_key TEXT,
  app_id TEXT,
  session_id TEXT,
  payload_json TEXT NOT NULL
    CHECK (json_valid(payload_json) AND length(CAST(payload_json AS BLOB)) <= 1048576),
  state TEXT NOT NULL DEFAULT 'pending'
    CHECK (state IN ('pending','sending','sent','dead')),
  attempts INTEGER NOT NULL DEFAULT 0,
  next_attempt_at TEXT NOT NULL,
  error_code TEXT,
  last_error TEXT,
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL,
  sent_at TEXT,
  FOREIGN KEY (app_id) REFERENCES apps(id) ON DELETE CASCADE,
  FOREIGN KEY (project_id) REFERENCES projects(id) ON DELETE CASCADE
);
CREATE UNIQUE INDEX notification_outbox_group_chunk ON notification_outbox(group_id, chunk_index);
CREATE INDEX notification_outbox_due ON notification_outbox(state, next_attempt_at);
CREATE INDEX notification_outbox_app ON notification_outbox(app_id, created_at);
CREATE INDEX notification_outbox_session ON notification_outbox(session_id, created_at);

CREATE TABLE notification_watermarks (
  app_id TEXT NOT NULL REFERENCES apps(id) ON DELETE CASCADE,
  session_id TEXT NOT NULL,
  last_notified_message_id TEXT,
  initialized_at TEXT NOT NULL,
  updated_at TEXT NOT NULL,
  PRIMARY KEY (app_id, session_id)
);

CREATE TABLE notification_meta (
  key TEXT PRIMARY KEY,
  value TEXT NOT NULL,
  updated_at TEXT NOT NULL
);

CREATE TABLE notification_channel_state (
  channel TEXT PRIMARY KEY,
  state TEXT NOT NULL CHECK (state IN ('ok','error')),
  last_error TEXT,
  updated_at TEXT NOT NULL
);
```

The migration is forward-only and additive. Each row is one Telegram message (chunk); a multi-chunk
answer is a group. `payload_json` is cleared to `{}` on `sent`/`dead`, and `pending` rows older than
7 days are marked `dead` with `error_code = "expired"` and cleared (the group-dead helper closes the
rest of the group, excluding `sent` chunks), so agent output is not kept at rest indefinitely.
`notification_meta` holds `telegram.first_sweep_at`, `telegram.notice_scan_at`,
`telegram.enabled_at`, and `telegram.channel_enabled`. The project FK cascades project-level rows;
the app FK cascades app rows. `notification_watermarks` rows are also deleted when a session is
deleted; the notifier's session-deletion path does that explicitly.

### 8.2 Sender

- One loop in the coordinator. At boot, reset `sending` rows to `pending` (crash recovery).
- Claim one row atomically, respecting strict group order: a chunk is eligible only when every
  earlier chunk of the same group is `sent`:

  ```sql
  UPDATE notification_outbox
  SET state = 'sending', updated_at = :now
  WHERE id = (
    SELECT o.id FROM notification_outbox o
    WHERE o.state = 'pending' AND o.next_attempt_at <= :now
      AND NOT EXISTS (
        SELECT 1 FROM notification_outbox p
        WHERE p.group_id = o.group_id AND p.chunk_index < o.chunk_index
          AND p.state <> 'sent'
      )
    ORDER BY o.created_at, o.group_id, o.chunk_index
    LIMIT 1
  )
  RETURNING *;
  ```

  If an earlier chunk is `dead`, the group is blocked; the group-dead helper marks every remaining
  chunk of the group `dead` in the same transaction, so no partial group is sent. The same helper
  runs on a 7-day pending expiry.
- Resolve settings by the row's scope: `app` -> `{ projectId, appKey }`, `project` ->
  `{ projectId }`, `global` -> `{}`. This covers project-level handoff/SSH notifications that have
  no `app_id`. The sender re-checks the effective channel/mode for every claimed row: if the
  channel is disabled or the row's kind is no longer allowed (`turn_completed` under `attention`),
  the row is marked `dead` with `error_code = "channel_disabled"`/`"mode_attention"` and is never
  sent. It also re-checks `include_answer`: a pending full-answer row created before it was turned
  off is marked `dead` with `error_code = "answer_disabled"`. This per-row check makes a missed
  settings transition harmless. If `enabled=true` but the token or chat id is missing, the row is
  marked `dead` with `error_code = "channel_unconfigured"`; the settings section shows the warning.
- Send with a 15 s timeout and a 1 MiB response cap. Serialize per chat; a minimum 1.1 s gap
  between sends to the same chat. Global 30/s is irrelevant with one chat.
- `429`: read `parameters.retry_after`, set `next_attempt_at = now + retry_after + 1 s`, keep
  `pending`, do not increment the hard-failure count.
- `5xx`/network: exponential backoff `min(5 s * 2^attempts, 5 min)`, max 8 attempts, then `dead`.
- `400` parse/format/limit or `404` unknown method: create the plain suffix group (section 5.1)
  in one transaction, mark the rich rows N..end `dead` with `error_code = "rich_fallback"`.
  `401`/`403`: `dead` + channel error. Other `400`: `dead` with a sanitized `last_error`.
- A `dead` chunk marks the remaining chunks of its group `dead` with `error_code = "chunk_failed"`
  in the same transaction.
- Retention: prune individual `sent`/`dead` rows older than 30 days (the group-atomic rule applies
  only to the cap). Cap the outbox at 500 **groups**; when the
  cap is exceeded, delete whole `turn_completed` groups oldest-first, then whole groups of any kind,
  but never a group that has a `sending` or `sent` chunk. Never delete a single chunk out of a
  group.
- Channel error: a permanent failure writes `notification_channel_state` (`state='error'`,
  sanitized `last_error`); a successful send or a successful test resets it to `ok`. The settings
  section reads this state.
- Drain: the sender checks `drain.isDraining()`/`isShuttingDown()` before claiming; each in-flight
  send is wrapped in `lifecycleActivity.begin("telegram_notify")` so `awaitQuiescence` waits for it.
- **Clean shutdown does not abort an in-flight send.** `stop()` sets `stopping`, resolves the
  backoff sleep, and awaits the current send (bounded by a 10 s timeout) before returning.
  `runGracefulShutdown` closes the HTTP server first, then awaits `stopBackground` (its type
  becomes `() => void | Promise<void>`), then `awaitQuiescence`, the WAL checkpoint, and
  `closeDb`, so no DB write happens after close. The `stop()` elapsed time is subtracted from the
  `awaitQuiescence` budget so the total stays inside the configured grace. The in-flight send has a 15 s transport timeout;
  the 10 s stop wait and the 15 s transport overlap, and `awaitQuiescence` counts the send until
  it ends. If the grace expires, the row stays `sending` and is reset on boot, accepting one
  possible duplicate (section 10 qualifies this).
- Single coordinator only. The atomic claim protects against a second sender if two processes share
  the DB, but the deployment is single-instance.

---

## 9. Transport and proxy

`TelegramTransport` is a small interface:

```ts
interface TelegramTransport {
  call(method: string, body: unknown, signal: AbortSignal): Promise<unknown>;
}
```

- **Direct**: `fetch("<apiBaseUrl>/bot<token>/<method>", { method: "POST", ... })` with
  `AbortSignal.timeout(15_000)` and a bounded JSON read.
- **Proxied**: branch on the target protocol and the proxy scheme:
  - `https:` target + `http:`/`https:` proxy -> `node:https.request` + `HttpsProxyAgent`.
  - `http:` target + `http:`/`https:` proxy -> `node:http.request` + `HttpProxyAgent`.
  - `socks5:`/`socks5h:` proxy -> the matching `node:http`/`node:https` request + `SocksProxyAgent`.
  All support `AbortSignal` and a bounded response read. The agent is cached by proxy URL and
  rebuilt when the setting changes.
- New direct dependencies: `https-proxy-agent`, `http-proxy-agent`, and `socks-proxy-agent` (pure
  JS, Node 20 compatible). `undici`'s `ProxyAgent` is rejected for this stage because SOCKS5
  support requires undici 8 (Node >=22.19.0), which conflicts with the repository's
  `node >=20.19.0` engine.
- `apiBaseUrl` comes from `notifications.telegram.api_base_url` (default
  `https://api.telegram.org`), so a self-hosted Bot API server and the test endpoint can target a
  local URL. A base URL with a path is joined with exactly one slash.
- The token is part of the URL path. It is never logged; errors are sanitized to
  `telegram_unavailable` / `telegram_unauthorized` / `telegram_rate_limited` / `telegram_format`
  plus a redacted description.

---

## 10. Security and failure modes

- The bot token and proxy URL are encrypted at rest and never leave the coordinator. They are not
  mounted into app containers; `credentialDenyPatterns()` needs no change.
- Message bodies contain agent output. The full answer is sent because the owner asked for it; the
  chat is the operator's private chat. `notifications.include_answer=false` switches to a status-only
  body. `payload_json` is cleared after send/dead-letter and after a 7-day pending expiry.
- **Rich messages can carry agent-supplied links, images, and `tg-button` URLs; Telegram renders
  them.** `sendRichMessage` has no `link_preview_options`, so previews cannot be disabled on the
  rich path. The plain path sets `link_preview_options: { is_disabled: true }`. This is a
  documented residual risk: the operator's private chat is trusted, and the agent already produces
  the text the operator reads in the web UI. If this is unacceptable, set
  `notifications.include_answer=false`.
- The session link is built only from the configured base URL and Hanse route parameters; agent
  text never contributes to the session button URL. Rows without a session use the app/project
  link described in section 5.3.
- Inbound updates are not processed in this stage. There is no webhook and no `getUpdates`; the bot
  is send-only. This avoids the 409 single-consumer problem and any inbound attack surface.
- The notifier never calls `manager.ensure`, `runtime.*`, or any destructive route. It reads
  `manager.endpointFor`, opencode read endpoints, and the coordinator DB.

| Failure | Behaviour |
|---|---|
| Telegram unreachable / 5xx | Exponential backoff; the agent is unaffected. |
| 429 | `retry_after` respected; row stays `pending`. |
| Bad token / blocked chat | Row `dead`; channel error in settings; no retry loop. |
| Rich parse/limit error, unknown method | Re-chunk the remaining suffix as a new plain group; per-chunk. |
| Coordinator restart | Outbox/watermarks persist; `sending` rows reset; boot/reconnect catch-up enqueues missed turns and notices. |
| Clean SIGTERM during a send | In-flight send finishes within grace; a duplicate is possible only if the grace expires (one resend on boot). |
| Drain | Sender stops claiming; in-flight send is counted by `lifecycleActivity`. |
| App stopped before the answer is read | Completion skipped; the stop notice is sent instead. |
| Subagent activity unknown (no hydrated tracker) | Defer; do not guess from the status map. |
| Handoff unbound in the binding window | Defer up to 60 s; after that the dispatcher's binding timeout sends `handoff_failed`. |
| Handoff reply parked `waiting_operator` | Not counted as in-flight; a separate attention notification is sent. |
| Handoff reply `failed` / terminal failure | Not counted as in-flight; a separate `handoff_failed` attention is sent. |
| Answer > 32768 chars | Chunked rich messages, one outbox row per chunk; link only on the last chunk. |
| Answer > 500 blocks / >20 table columns | Plain-text chunks for that part. |
| Plain fallback after a rich 400 | New plain group for the remaining suffix, 4000-character chunks. |
| Channel disabled | No enqueue; watermark advances; pending rows dead-lettered on disable. |
| Public base URL missing | Message without a button; settings warning. |
| Two coordinators on one DB | Atomic claim prevents double-send; deployment remains single-instance. |

---

## 11. Risks and limits

- Rich messages are new (10.1+); the plain fallback covers an older Bot API server and ordinary
  parse/limit failures.
- The tracker's `activeChildren` signal is in-memory and resets on a coordinator restart; the
  `known` guard defers until the tracker is hydrated. This is conservative (delays a completion,
  never fabricates one).
- A subagent that starts after the parent's completion was enqueued belongs to a new turn; the new
  turn produces its own completion.
- The full answer can be large; chunking is bounded per chunk and a group is capped at 20 chunks;
  beyond that the answer is truncated with a `truncated` marker and a session link.
- Full answers can contain sensitive code or secrets; this is accepted for the operator's private
  chat, with `include_answer=false` as the off switch. Pending payloads are cleared after 7 days.
- Telegram egress may require a proxy; the setting is a secret because proxy URLs often contain
  credentials.
- Notification noise is controlled by `mode`, dedupe, debounce, the notice-reason matrix, and the
  pending-prompt suppression; the operator can mute a project/app without a restart.
- The notifier is read-only with respect to agents; it never starts or stops an app.
- The outbox is another durable table; retention, payload clearing, and a group cap keep it
  bounded.
- An unbound handoff suppresses completions for the app for at most 60 s; normal binding is
  immediate. A handoff that never binds produces a `handoff_failed` attention at the dispatcher
  timeout.

---

## 12. Owner decisions (closed)

Collected 2026-11-10:

1. **Completion** = `turn idle`, but only when no subagent is running and no handoff reply is
   in flight (only in-process handoffs count).
2. **One chat for now**; the settings hierarchy is used so project/app separation is possible
   later.
3. **Public URL is a setting**, because the operator sometimes opens the UI through different
   addresses. It is resolved per scope.
4. **Scope** = everything that interrupted the agent (questions, SSH, and similar) plus completion.
5. **Text** = the full answer with the new Telegram rich formatting.
6. **Proxy is required.**
7. **Full delivery cycle is authorized** (design, reviews, plan, implementation, record, commit).

Autonomous decisions (recorded here so the plan does not guess):

- Durable outbox with one row per Telegram chunk; per-chunk dedupe/retry; payload cleared after
  send and after a 7-day pending expiry.
- Send-only v1; no `getUpdates`/webhook; quick replies are a later stage.
- `waiting_operator` is excluded from the completion predicate and gets its own attention message.
- `notifications.mode` (`off|attention|all`) and `notifications.include_answer` are per-scope
  escape hatches; a disabled channel does not build a backlog.
- Node 20-compatible `node:http(s)` proxy transport instead of undici 8.
- Completion is suppressed when the session subtree has a pending prompt; the prompt notification
  is the actionable one.
- Boot/reconnect catch-up with a persisted `first_sweep_at` and a per-session watermark prevents
  missed completions and avoids a historical flood on first enable.
- `ContextTracker` activity over the whole subtree with a `known` hydration guard is the positive
  subagent signal; an absent status is never treated as idle.
- `sendRichMessage` has no `link_preview_options`; the rich-path preview risk is accepted and the
  plain path disables previews.
- One-shot handoffs are attributed by the session subtree and `source_invoking_session_id`; an
  unbound handoff defers completion for at most 60 s.
- A rich 400/404 re-chunks the remaining suffix into a new plain group; a rich chunk is never sent
  unchanged to `sendMessage`.

---

## 13. Alternatives considered

| Option | Why rejected |
|---|---|
| In-memory fire-and-forget sender | Loses notifications on restart, no retry/429 handling, duplicates on reconnect. |
| Poll the DB for approvals instead of emitting signals | Adds latency and load; the coordinator already knows when it creates the row. |
| Webhook + quick reply in v1 | Needs public inbound HTTPS and a webhook secret; the owner only asked for links first. |
| `sendMessage` with MarkdownV2/HTML for completion | Cannot express headings, lists, tables, and code cleanly; rich messages fit the model output. |
| `undici` `ProxyAgent` | SOCKS5 requires undici 8 (Node >=22.19), conflicting with `node >=20.19.0`. |
| Notify on every idle without subagent/handoff checks | False "done" reports during subagent work and handoff waits. |
| Conservative thread predicate (any open thread) | Suppresses completions for idle open threads with no outstanding message. |
| Count `waiting_operator` as in-flight | It never arrives automatically; the operator would never get a completion. |
| One outbox row per notification with the full answer | 64 KiB payload cannot hold the full answer and per-row retry duplicates chunks. |
| Treat an absent subagent status as idle | The status map omits idle sessions and cannot distinguish idle from not-yet-started; false "done". |
| Send a 30000-character rich chunk through `sendMessage` | `sendMessage` rejects text over 4096; the fallback must re-chunk. |
| Suppress completions while the channel is disabled | Builds a backlog that floods on first enable; the watermark advances instead. |

---

## 14. Test strategy

| Layer | Coverage |
|---|---|
| Unit | Completion matrix: idle/busy, child active/idle/unknown/just-started, grandchild, `pendingTask`, `known=false`, queued prompts, `queuedTruncated`, `settling`, pending question/permission in the subtree, one-shot in-flight states, one-shot unbound source (both columns NULL), thread header `queued/awaiting_approval/dispatching/in_progress`, thread source message `binding/queued/dispatching/delivered/waiting_operator`, in-flight reply to the source, `waiting_operator` exclusion, dedupe key, watermark init/update, deferred sweep expiry. |
| Unit | Watermark: first enable (no flood), session created after `first_sweep_at` (first turn notifies), turn completed while the coordinator was down (notifies), missing `time.created` (initializes), repeated sweep (no duplicate), dedupe skip advances the watermark, null answer id uses the occurrence id, `notice_scan_at` prevents a re-enable replay. |
| Unit | Mode and notice scan: `attention` suppresses `turn_completed`; `attention → all` does not replay the last suppressed completion; a disabled period between boots does not replay notices; `enabled_at` is set on each enable; first-enable watermark uses the predicate's answer id for a tool-only tail; a tool-only turn after a text turn sends a distinct `Done`. |
| Unit | Text extraction: visible text parts, `part.data`, synthetic/attachment/resume exclusions, trailing tool-only assistant, no visible text, `readTurnSnapshot`/`readFinalAnswer` parity. |
| Unit | Formatter: 30000/4000 boundaries, code fences, links, tables, 500-block/21-column fallback, oversized block hard-split, emoji, empty body, 20-chunk cap, rich 400 on a middle chunk (suffix preserved, link on the last plain chunk, original group closed), a second fallback uses a new group id, a fallback group >20 chunks is not truncated by the cap. |
| Unit | Settings: new keys resolve global/project/app; `launchEffectiveSettings` excludes notifications (hash unchanged per key); secret status is status-only; token/proxy validation redacts the value; master `get_setting` maps the new keys; disabled channel gates enqueue; `mode=attention` suppresses `turn_completed` and dead-letters pending completion rows; `mode=off` dead-letters all pending rows. |
| Unit | Transport: direct/proxy selection, HTTP and HTTPS targets through HTTP/SOCKS proxies, scheme validation, 429/400/401/403/404/5xx mapping, redaction, timeout/abort, `api_base_url` with a path. |
| Store | Migration v26; outbox strict group claim/order/reset/prune/group cap/payload clearing/group-dead on expiry; unique dedupe; app and project FK cascade; watermark; meta; channel state. |
| Route | `POST /api/settings/telegram` auth/JSON/CSRF/validation/status masking; `.../test` success and failure; `isSettingsRoute` dispatch; `/api/settings` and `/api/ui/settings` include the new props and never the secret. |
| UI (jsdom) | Notifications section renders at all scopes; write-only fields show `Not shown`; set/clear/inherit; test button states; warning when enabled but unconfigured. |
| Integration | Router with a fake `InstanceManager` event stream, fake opencode HTTP, and a fake outbox/DB: completion suppressed by a child, handoff, pending prompt, unbound handoff, duplicate idle; attention rows for each source; boot/reconnect catch-up waits for `dispatcher.ready`; notice kind/reason replay; post-commit approval emit; `handoff_reply_delivered`; disabled channel; `mode=attention`; a subagent one-shot reply still routes to the invoking session. |
| Sender | Fake transport: strict group order, per-chunk retry, 429, 5xx, rich 400 -> plain suffix group, dead-letter, group cap excluding partially sent groups, drain quiescence, clean-SIGTERM duplicate caveat, restart reset. |
| E2E | Settings page Notifications section save/test with route interception (only if the rendered route changes; otherwise a jsdom suite is enough). |
| Gates | `npm run lint`, `npm run typecheck`, `npm run typecheck:ui`, `npm test`, `npm run build`, `npm run check:ui`, `npm run check:sensitive`, and `npm run test:e2e` if a rendered route changes. |

---

## 15. Design review

### Round 1 - `oracle` (2026-11-10) - **BLOCK**

The predicate was internally contradictory (the one-shot query matched open threads), an absent
subagent was treated as idle contrary to `chat-turn-state`, restart/reconnect lost observations, and
the outbox could not represent a full chunked answer. Every finding is folded into revision 2.

| ID | Severity | Finding | Resolution |
|---|---|---|---|
| F1 | BLOCKER | One-shot handoff query had no `mode` filter; every open thread suppressed completion. | `mode='one_shot'` / `mode='thread'` filters. |
| F2 | BLOCKER | Absent child treated as idle, contradicting the governing turn-state design. | Positive tracker signal; `known` guard; absent status never idle. |
| F3 | BLOCKER | Source thread messages in `binding/queued/dispatching/waiting_operator` were missed; parked thread messages had no attention. | All states covered; `thread_message_waiting` added. |
| F4 | BLOCKER | Event-only router; no `stream.ready`, no notice replay, restart loses completions. | Synthetic `stream.ready`, catch-up, watermarks, notice scan. |
| F5 | BLOCKER | 64 KiB payload cannot hold the full answer; per-row retry duplicates chunks. | One row per chunk, group/chunk columns, per-chunk dedupe/retry. |
| F6 | BLOCKER | Rich fallback only covered unknown-method errors. | Format/limit 4xx/404 fallback, block/column counting. |
| F7-F25 | SHOULD FIX / NOTE | Options/truncation, subtree prompts, failed handoffs, launch hash, route dispatch, CSRF, secret props, shutdown, project cascade, scope resolution, notice reasons, occurrence keys, preview risk, block/column paths, api base URL, channel state, payload retention, validation redaction, test matrix. | Folded into revision 2 and refined in revisions 3-4. |

### Round 2 - `oracle` (2026-11-10) - **BLOCK**

Four new blockers remained: thread start states, watermark first-observation, one-shot source
attribution, and the plain fallback size. All are folded into revision 3.

| ID | Severity | Finding | Resolution |
|---|---|---|---|
| N1 | BLOCKER | Thread SQL required `h.state='in_progress'`; a thread starts `queued`/`awaiting_approval` and its initial message is `binding`. | All non-terminal header states. |
| N2 | BLOCKER | Watermark "first observation" was undefined for the event path and raced catch-up. | `first_sweep_at` + shared rule. |
| N3 | BLOCKER | `source_session_id` is not the resolved root for one-shot handoffs. | Subtree predicate + `source_invoking_session_id`. |
| N4 | BLOCKER | "Retry the same chunk as plain `sendMessage`" is invalid for 30000-character rich chunks. | Re-chunk into a new plain group. |
| N5-N24 | SHOULD FIX / NOTE | Tracker `known`, strict group claim, `error_code`, notice scan/reasons, error occurrence id, HTTP proxy, pending payload, master keys, secret status, reply-delivered signal, duplicate caveat, dedupe id, whole subtree, byte length, `failed` state, sanitizer, thread approval emit, secret hierarchy, test matrix. | Folded into revision 3 and refined in revision 4. |

### Round 3 - `oracle` (2026-11-10) - **BLOCK**

N1 was resolved; N2/N3/N4 were partial. New blockers: the unbound handoff window, rich-fallback
suffix truncation, and the disabled-channel backlog. All are folded into this revision.

| ID | Severity | Finding | Resolution in this revision |
|---|---|---|---|
| M1 | BLOCKER | Unbound one-shot/thread rows are invisible to the predicate: both source columns are NULL until binding; the "unbound branch" is dead. | §4.1(8) adds a 60 s unbound defer for the app; the boot sweep runs after `#reconcileUnbound`; the dispatcher timeout emits `handoff_failed`. |
| M2 | BLOCKER | A rich 400 on chunk N>0 re-chunked only that chunk; the suffix was lost and the link button disappeared. | §5.1 re-chunks the remaining suffix (N..end) into a new plain group, link on its last chunk, original rich rows N..end dead. |
| M3 | BLOCKER | `telegram.enabled=false` still enqueued rows, so first enable replayed a backlog. | §4.3 gates enqueue on effective enabled/mode, advances the watermark, and dead-letters pending rows on disable. |
| M4 | SHOULD FIX | Dedupe skip did not advance the watermark; the sweep re-ran the predicate and a prune could re-enqueue. | §4.1(9) advances the watermark on the skip path. |
| M5 | SHOULD FIX | A null answer id made every `Done` turn share the base `...:null`. | §4.1(9) uses the last user message id or a 5-minute bucket. |
| M6 | SHOULD FIX | `readTurnSnapshot` and `readFinalAnswer` were separate reads; a trailing tool-only assistant broke the id/body parity. | §4.1(4)/§5 use one message list and define the id as the last assistant with visible text. |
| M7 | SHOULD FIX | The notice reason matrix used non-existent `failed`/`not_sent` and omitted `resume_failed`/`resume_unavailable`. | §6.1 is a total partition of all 18 `SESSION_NOTICE_REASONS` values. |
| M8 | SHOULD FIX | Parked/failed dedupe keys used `updatedAt`, which can change for unrelated updates. | §3/§6 use a `transitionAt` carried by the signal. |
| M9 | SHOULD FIX | `bindSourceSession` cannot resolve the root; `CoordinatorService` has only db+projectId. | §4.1(6) resolves the root in the dispatcher and passes `{rootSessionId, invokingSessionId}`. |
| M10 | NOTE | The cap could delete a partially sent group. | §8.2 excludes groups with a `sending`/`sent` chunk. |
| M11 | NOTE | Pending expiry marked one chunk dead without closing the group. | §8.2 applies the group-dead helper on expiry. |
| M12 | NOTE | Awaiting `stopBackground` before `server.close` keeps the server accepting. | §8.2 closes the server first, then awaits `stopBackground`. |
| M13 | NOTE | `<base>:plain:<index>` collides on a second fallback. | §4.1(9)/§5.1 add a fallback attempt suffix. |
| M14 | NOTE | `json_each` subtree was unbounded/invalid-JSON fragile. | §4.2 validates and caps the subtree at 500 ids. |
| M15 | NOTE | Attention rows without a session could not satisfy R6. | §5.3 defines the app/project fallback link. |
| M16 | NOTE | Test matrix missed the M1-M3 cases. | §14 adds them. |

### Round 4 - `oracle` (2026-11-10) - **BLOCK**

M1/M2 and most M findings were resolved. M3 was partial: `mode=attention` behaved like `all`, and a
re-enable could replay disabled-period notices. Both are folded into this revision.

| ID | Severity | Finding | Resolution in this revision |
|---|---|---|---|
| M1 | BLOCKER | 60 s unbound defer was sound, but the boot-sweep ordering claim was not guaranteed. | §4.1(8) waits for `handoffDispatcher.ready()`; the 60 s grace remains the bounded fallback. |
| M2 | BLOCKER | Suffix re-chunk was sound; the fallback dedupe counter was undefined. | §4.1(9)/§5.1 key by `newGroupId` (a UUID), so a second fallback cannot collide. |
| M3 | BLOCKER | `mode=attention` did not suppress completion; a re-enable could replay notices from the disabled period. | §4.3 defines `off/attention/all`, gates `turn_completed` on `all`, dead-letters mismatched pending rows, and adds `notice_scan_at`. |
| M4 | SHOULD FIX | Dedupe skip did not advance the watermark. | §4.1(9) advances it on the skip path. |
| M5 | SHOULD FIX | Null answer id shared `...:null`. | §4.1(9) uses the last user message id or a 5-minute bucket. |
| M6 | SHOULD FIX | Separate reads broke id/body parity. | §4.1(4)/§5 use one message list and a text-bearing answer id. |
| M7 | SHOULD FIX | Notice matrix was not a total partition. | §6.1 partitions all 18 reasons. |
| M8 | SHOULD FIX | `updatedAt` dedupe keys could change. | §3/§6 use `transitionAt` carried by the signal. |
| M9 | SHOULD FIX | `bindSourceSession` cannot resolve the root. | §4.1(6) resolves in the dispatcher and passes both ids. |
| M10 | NOTE | Cap could delete a partially sent group. | §8.2 excludes groups with a `sending`/`sent` chunk. |
| M11 | NOTE | Expiry closed only one chunk. | §8.2 runs the group-dead helper, excluding `sent` chunks. |
| M12 | NOTE | Awaiting `stopBackground` before `server.close`. | §8.2 closes the server first. |
| M13 | NOTE | Fallback key collision. | §4.1(9)/§5.1 use `newGroupId`. |
| M14 | NOTE | Subtree JSON unbounded. | §4.2 validates and caps at 500 ids. |
| M15 | NOTE | Rows without a session had no link. | §5.3 adds the app/project fallback. |
| M16 | NOTE | Test matrix missed the new cases. | §14 adds mode, notice-scan, boot-order, and fallback cases. |
| P1 | BLOCKER | `mode=attention` did not suppress `turn_completed`. | §4.3/§6.2 gate completion on `mode === "all"`. |
| P2 | BLOCKER | Boot notice scan could replay disabled-period notices. | §4.3 adds `notification_meta.telegram.notice_scan_at`. |
| P3 | SHOULD FIX | `handoffDispatcher.start()` does not await reconcile. | §4.1(8) waits for `handoffDispatcher.ready()`. |
| P4 | SHOULD FIX | Fallback `attempt` undefined; length unit ambiguous. | §4.1(9)/§5.1 use `newGroupId`; §5.2 defines code-point and UTF-16 budgets. |
| P5 | NOTE | §1 said thread start sets both source columns at creation. | §1 corrected: creation leaves both NULL; initial binding sets both. |
| P6 | NOTE | The `handoff_failed` emit path was unnamed. | §4.1(8) names `#failUnboundHandoffs` and `#failTimedOutBindings`/`#failThreadStart`. |
| P7 | NOTE | "500 groups" wording mixed rows/groups. | §8.2 says 500 groups; the group-dead helper excludes `sent` chunks. |

### Round 5 - `oracle` (2026-11-10) - **BLOCK**

P1 and P3-P7 were resolved; P2 was partial (a disabled period between boots could replay notices).
The Q findings are folded into this revision.

| ID | Severity | Finding | Resolution in this revision |
|---|---|---|---|
| P1 | RESOLVED | `off`/`attention`/`all` semantics are correct. | §4.3/§6.2 gate completion on `all`, attention on `!= off`. |
| P2 | PARTIAL (BLOCKER) | `notice_scan_at` advanced only on boot while disabled; a disable→enable cycle between boots could replay notices. | §4.3 adds `telegram.enabled_at` on every enable and scans `created_at > max(notice_scan_at, enabled_at)`; live notices advance the marker while disabled. |
| P3 | RESOLVED | `handoffDispatcher.ready()` is the boot barrier. | §4.1(8) waits for it; the 60 s unbound defer remains the fallback. |
| P4 | RESOLVED | `newGroupId` UUID and length budgets are defined. | §4.1(9)/§5.1/§5.2. |
| P5 | RESOLVED | §1 now says creation leaves both source columns NULL. | §1 corrected. |
| P6 | RESOLVED | Failure paths are named. | §4.1(8) names `#failUnboundHandoffs` and `#failTimedOutBindings`/`#failThreadStart`. |
| P7 | RESOLVED | Cap is 500 groups; group-dead excludes sent chunks. | §8.2 clarified. |
| Q1 | SHOULD FIX | First-enable watermark used the raw last assistant id, not the text-bearing answer id. | §4.3 initializes to the predicate's `answerMessageId`/occurrence id. |
| Q2 | SHOULD FIX | A fallback plain group could exceed the 20-chunk cap and truncate the suffix. | §5.1 exempts the fallback group from the cap. |
| Q3 | SHOULD FIX | Resolving the root into `source_session_id` would change one-shot reply routing. | §4.1(6) keeps `source_session_id` as the invoking session; the subtree predicate catches it. |
| Q4 | SHOULD FIX | Mode/disable transitions had no detection mechanism. | §8.2 re-checks channel/mode per claimed row and dead-letters disallowed rows. |
| Q5 | SHOULD FIX | A tool-only turn reused the previous turn's answer id. | §4.1(9)/§5 scope the answer to the current turn and use the occurrence id. |
| Q6 | NOTE | Rich length unit may be bytes, not code points. | §5.2 also measures UTF-8 bytes and splits further near 32768. |
| Q7 | NOTE | A non-format rich 400 triggered a pointless fallback. | §5.1 restricts the fallback to format/limit/404; other 400s dead-letter. |
| Q8 | NOTE | An oversized table row was unsplittable. | §5.2 forces plain text and splits at cell boundaries, repeating the header. |
| Q9 | NOTE | Retention prunes individual rows, not groups. | §8.2 states retention is per-row; only the cap is group-atomic. |
| Q10 | NOTE | Runtime first enable left `first_sweep_at` unset. | §4.3 sets it on the enable transition, not only boot. |
| Q11 | NOTE | Test matrix missed the new cases. | §14 adds mode/notice-scan/tool-only/fallback/regression cases. |

### Round 6 - `oracle` (2026-11-10) - **PASS WITH FIXES**

P2 and Q1-Q11 are resolved; no new correctness/implementability blocker was introduced. The
remaining R findings are folded into this revision.

| ID | Severity | Finding | Resolution in this revision |
|---|---|---|---|
| R1 | SHOULD FIX | `known` could stay false because `#refreshParents` only runs when auto-compaction is enabled (default off). | §4.1(3) requires `manager.sessionActivity` to hydrate before returning; test with auto-compaction off and no `/context`. |
| R2 | SHOULD FIX | The 5m bucket reference time was undefined. | §4.1(9) anchors it to the turn, never to `now`. |
| R3 | SHOULD FIX | The answer boundary differed from `deriveTurn`. | §5 step 3 uses the same boundary/exclusions. |
| R4 | NOTE | Boot ordering/previous enabled state. | §4.3 persists `telegram.channel_enabled` and writes `enabled_at` before the scan. |
| R5 | NOTE | Per-chunk dedupe for attention kinds. | §6 states `<base>:<chunkIndex>` for every kind. |
| R6 | NOTE | Watermark cleanup on session deletion; global markers. | §8.1 deletes watermarks with the session and documents the global markers. |
| R7 | NOTE | `include_answer` was not re-checked per row. | §8.2 dead-letters `answer_disabled` rows. |
| R8 | NOTE | No unique `(group_id, chunk_index)`. | §8.1 adds `notification_outbox_group_chunk`. |
| R9 | NOTE | `handoff_reply_delivered` for a subagent one-shot needs the root. | §4 uses the 60 s sweep as the fallback; the plan resolves the root when available. |
| R10 | NOTE | `ready()` could hang the sweep on a failed reconcile. | §4.1(8) resolves it on failure and falls back to the unbound defer. |
| R11 | NOTE | `stop()` time plus `awaitQuiescence` could exceed the grace. | §8.2 subtracts the elapsed stop time from the budget. |
| R12 | NOTE | Missing token/chat id behavior was unspecified. | §8.2 dead-letters `channel_unconfigured` and surfaces the warning. |

Design review gate: **cleared** (PASS WITH FIXES, findings folded). Next: plan review (`momus`).
