# Design - Truthful chat turn state

Status: **implemented and verified** (journal 0045) - owner decisions Q1-Q6 are closed; Round 1
`oracle` was **BLOCK** and Round 2 `oracle` was **PASS WITH FIXES**. Every Round 1/2 finding
(B1-B4, S1-S19, N1-N10) is folded into this revision; the design-review gate is cleared. The plan
review (`momus` OKAY, R1-R10 folded) and the full gates passed.

Scope: the SPA chat turn phase, the in-feed generation row, the queue presentation (count, modal,
no strip), status hydration on load/reconnect/visibility, the server-computed turn snapshot, and SSE
stream identity handling.

Out of scope: changing the app SSE event set or the opencode `/event` mapping; database schema or
persisted turn state; changing opencode behavior; a visual redesign beyond truthful labels; the
retired legacy chat renderer; the terminal, IDE, previews, handoffs, and attachments.

Governing context: [`chat-ux-overhaul.md`](./chat-ux-overhaul.md) (status model, queue derivation),
[`chat-mobile-polish.md`](./chat-mobile-polish.md) (abort settle, queue-promotion block, status seed
on reload), [`chat-pagination.md`](./chat-pagination.md) (tail snapshot and generation row),
[`chat-terminal-migration.md`](./chat-terminal-migration.md) invariants C2/C5, and
[`docs/current-state.md`](../current-state.md) lines 806-871.

Supersessions recorded here (the old design docs remain historical records; `current-state.md` and
the stage journal get the new contract):

- **chat-mobile-polish.md §D6** (the client queue-promotion block) is retired: with the generation
  row driven by the server status and the queue computed by the server, client-side promotion can no
  longer create a phantom turn.
- **chat-pagination.md §D7** hides the in-feed row for `Ready`, and names the meta chip as the single
  announcement source. This stage supersedes both only for the idle-with-queue case and the new
  turn-status live region: the row shows `Ready · N queued`, and the live region announces a phase
  change once. `Waiting for you` and `Paused` stay out of the row (dock/meta and connection chip
  respectively), as D7 requires.

Incident reference: the owner reports that, after an agent finishes a turn, the chat often keeps
showing the in-feed "...Working" row until the page is reloaded or the session changes; from the
rest of the chat state the row is sometimes obviously false, and it is always information noise.
This is a class, not a single label: the same client-side derivation produces false or missing turn
state after Stop, reconnect, session switch, OMO/synthetic messages, unknown sends, and multi-tab
use.

---

## 1. What is actually broken

The SPA reconstructs "is a turn running" from three independent sources and renders a row when any
one of them says so:

1. **Server status events.** `session.status` / `session.idle` are projected to
   `session.status {type: idle|busy|retry}` (`src/opencode/events.ts:1723-1810`). They are
   per-connection, ephemeral, deduped, and never replayed; a missed frame has no server-side
   timeout or synthetic idle. The stream adapter already drops duplicates and detects gaps
   (`ui/chat/stream.ts:149-188`), but a detected gap only reloads messages
   (`ui/pages/ChatPage.vue:1717-1724`, `1606-1617`), not status.
2. **Server history.** The client keeps a 30-message tail and merges it into the live store. The
   tail merge preserves local rows and can re-append transient rows at the end of `order`
   (`assets/chat-core.js:1936-1966`), so a client-only user row can sit after the last visible
   assistant.
3. **Local send state.** Optimistic rows (`sending`, `unknown`, `accepted`, `queued`) live in the
   same `order` and are eligible for the queue derivation except `failed`.

`deriveQueue` (`assets/chat-core.js:900-1003`) then chooses a `pending` user row after the last
visible assistant and promotes it to `activePromptID` at idle. `generatingLabel`
(`ui/pages/ChatPage.vue:2009-2022`) renders a row whenever the status is busy/retry **or** the queue
or `activePromptID` is non-empty.

That last branch is the phantom. In the current SPA the generation row does not receive
`unsealedText`, `unsealedReasoning`, `runningTool`, `waiting`, `sending`, or `paused`, and
`queueBlocked` is hardcoded `false`, so:

- a literal "Working" can only come from the queue fallback (`chat-core.js:2804-2809`) while the
  status is not busy/retry - i.e. the agent is idle but a derived queue/active prompt remains;
- while the agent is genuinely busy the SPA shows "Thinking" instead of the legacy "Working" /
  "Running <tool>";
- a blocked queue after Stop renders "Working" instead of the legacy "Ready".

The migration also lost three correctness guarantees that the legacy renderer had:

- `applySnapshot` is called without `allowPromotion`/`sessionStatusType`
  (`ui/pages/ChatPage.vue:1522, 1582`; `ui/stores/chat-feed.ts:496-504`), so a tail reconcile
  bypasses `queuePromotionGuard` and re-promotes a queue that `settleIdle` deliberately blocked.
- `handleEvent` reduces every frame with `currentStreamID: null` and an empty `lastSeqByStream`
  (`ui/pages/ChatPage.vue:1692-1696`), so the store/reducer stream identity is stale; the adapter is
  the only real dedupe/gap owner, and `stream.ready` never reaches the reducer.
- Status is never hydrated on ready/reconnect/visibility: `loadSidecars` stores the context snapshot
  but does not seed status (`ui/pages/ChatPage.vue:1425-1453`), and `/context` requires a context
  monitor, which is only created when `contextPolicy` is configured
  (`src/opencode/manager.ts:2380-2402`).

The queue strip (`ChatQueueStrip.vue`) renders the first three derived rows above the composer and
excludes the active head (`ui/chat/queue.ts:48-61`); `ChatQueueDialog.vue` already exists but is only
opened by the strip's count button. The strip is the extra surface the owner wants removed; the
modal stays.

## 2. Goals

| ID | Goal |
| --- | --- |
| G1 | One authoritative turn snapshot per session, computed by the server. |
| G2 | The generation row reflects the real turn phase plus the local outbox; it is never driven by a client-derived backlog. |
| G3 | While a turn runs, the label matches the legacy vocabulary (`Sending`, `Thinking`, `Working`, `Running <tool>`, `Retrying`); `Waiting for you` and `Paused` stay in their approved surfaces. |
| G4 | An idle session with queued prompts shows `Ready · N queued`, never `Working`; a completely idle session shows no row. |
| G5 | The queue strip is removed; the count (excluding a running prompt, including an idle head) is a button that opens the existing queue dialog. |
| G6 | The state converges after a full reload, a reconnect/gap, a visibility return, a session switch, and a missed mid-stream idle; an idle completion never shows a false queued row. |
| G7 | No database change and no change to the app SSE event set. One new read-only turn route is allowed. |
| G8 | The behavior is locked by unit, jsdom, adapter, route, e2e, and browser QA tests. |

## 3. Invariants

| ID | Invariant | How it is proven |
| --- | --- | --- |
| T1 | A client-only message row never contributes to the generation row, `activePromptID`, or the queued count. Local rows carry `origin:"local"` and are excluded from the server backlog; only the outbox `Sending`/`unknown` state may show work in flight. | Unit: a live store with a local row must not change the row or the count. |
| T2 | The generation row exists iff `turn.status` is `busy`/`retry`, an outbox send is `sending`/`unknown`, or `turn.status` is `idle` with `queuedPromptIDs` non-empty. `Waiting for you` and `Paused` never create the row. | jsdom matrix over phase x outbox x queue; waiting/paused assertions. |
| T3 | An idle session with a non-empty server queue renders `Ready · N queued`; a completely idle session renders no row. `Ready` alone is never rendered. | jsdom + e2e. |
| T4 | The tail merge keeps the approved chat-pagination D3 order (transient local rows may be visually re-appended); local rows are tagged and cannot affect the row or queue. A disjoint tail (no shared ID in a non-empty history) resets with `position:"replace", keepOptimistic:"transient"` and resets the cursor. | Unit: tail/disjoint-tail fixtures; T1. |
| T5 | `queuedPromptIDs`, `runningPromptID`, and `turnContinues` come from the server turn snapshot; the SPA no longer derives the queue from messages for the row, the count, or the `Queued` chip. | Unit + route tests; the SPA does not use `deriveQueue` on the row/queue path. |
| T6 | The stream adapter is the single SSE identity owner (dedupe, gap detection, `stream.ready`). The store mirrors `streamID`/`lastSeq` for diagnostics only; the reducer performs no duplicate/gap filtering. C2 is preserved. | Adapter unit tests; jsdom reconnect. |
| T7 | A turn snapshot is fetched on every reconcile path (gap, warning, part-omitted, unknown-event, session-activity, idle, `session.error`, pause/limit) plus ready/reconnect/visibility/session open/every status transition/send acceptance/dialog open. An async snapshot is applied only if its `requestEpoch` and session still match and `liveRevision` has not advanced since the request; precedence is `abort-settle > sse > snapshot`. The abort settle bumps `liveRevision` at start and end. | Unit + jsdom with out-of-order fake fetches, session switch, and a late busy after abort. |
| T8 | The queue count is a keyboard-reachable button in the turn-status live region; it opens the dialog with focus management. The generation row stays decorative. | jsdom + browser QA. |
| T9 | The turn route never starts a stopped agent and uses the exact matrix: 401/403, 405, 404 `unknown_app`/`session_not_found`, 409 `deletion_pending`, 503 `agent_stopped`, 503 `history_busy`, 502 `turn_unavailable`/`messages_too_large`. Absent from the status map is `idle`; an unrecognized type is `unknown`; a malformed status map is 502, not idle. | Route tests. |
| T10 | `Waiting for you` remains in the dock/meta and `Paused` in the connection chip; neither appears in the generation row (chat-pagination D7 preserved for those two). | jsdom + e2e. |
| T11 | Hidden synthetic/resume rows and OMO internal rows never enter `queuedPromptIDs`; excluding a resume prompt also consumes the interrupted prompt it resumes; attachment-only rows are not treated as empty. | `deriveTurn` fixtures: idle-after-failed-resume, attachment-only send. |
| T12 | Outbox states are explicit: `sending` (bounded, then `unknown`), `unknown` (definitive uncertainty only), `accepted`/server-backed; idle never settles a send; a late 202 after `unknown` rekeys and clears it; a reload seeds the outbox from the existing `pendingSends`. | Unit/jsdom: idle-during-send, hung send, late 202, reload-while-pending. |
| T13 | The display count is `queuedPromptIDs.length - (runningPromptID ? 1 : 0)`. `runningPromptID = queuedPromptIDs[0]` only when `status=busy && !turnContinues`; at idle the count includes the head; while a multi-step turn continues all pending count. The dialog marks the running row active and never calls it queued. | `deriveTurn` + jsdom: busy pre-first-part + 1 prompt -> `Thinking`, no suffix, no `Queued` chip; busy + current + 1 queued -> `Working · 1 queued`; busy multi-step + 1 queued -> `Working · 1 queued`. |
| T14 | Status and history are read in a defined order (status -> history -> status). If the status changes during the read, retry once; if still inconsistent on idle, `settling:true` suppresses the queued row for one bounded reconcile. | Fake-upstream test: idle completion with an unpresisted final assistant never shows `Ready · 1 queued` beyond one reconcile. |
| T15 | Client failure behavior is defined: 502/503 keeps the last snapshot, marks client `stale`, and retries with a bounded backoff; 409 hides the turn surface while read-only; 404 uses the session-gone path; `unknown` keeps the current phase. | jsdom failure matrix. |
| T16 | The route projects handoffs (`projectHandoffMessages`) before `deriveTurn`; pages backward past the boundary within a page budget and returns `queuedTruncated`; a strict status read rejects a malformed map. Subagent sessions absent from the status map are `unknown`, never idle. | Route/`deriveTurn` fixtures: handoff session, >tail queue, malformed map, subagent. |

## 4. State model

### 4.1 Server: the turn snapshot

A new pure module `src/chat/turn.ts` derives one snapshot from the upstream history tail and the
upstream status map:

```ts
interface TurnSnapshot {
  sessionID: string;
  status: { type: "idle" | "busy" | "retry" | "unknown"; attempt?: number; message?: string; next?: number };
  turnContinues: boolean;          // last visible assistant incomplete or finish "tool-calls", idle override
  runningPromptID: string | null;  // queuedPromptIDs[0] only when status busy && !turnContinues
  activePromptID: string | null;   // runningPromptID when busy, queuedPromptIDs[0] when idle, else null
  queuedPromptIDs: string[];       // every pending prompt after the boundary, including the head
  queuedTruncated: boolean;        // tail page budget exhausted before the boundary
  settling: boolean;               // status/history were inconsistent; suppress the queued row once
  revision: string;                // stable hash of (status, active, running, queued, truncated)
}
```

`deriveTurn` mirrors the authoritative parts of `deriveQueue`:

- boundary = last **visible** assistant (non-empty non-synthetic text, or a tool/reasoning/patch/
  file/subtask part) or that assistant's normal-user `parentID` when it is present;
- queued = user messages after the boundary, excluding handoff rows, hidden synthetic rows
  (`synthetic:true` text with no visible content, the attachment manifest, and the auto-resume
  prompt identified by `metadata.hanse === "agent-resume"`), and OMO internal/synthetic rows (the
  same marker/`synthetic` predicate as the client's OMO classification, used here only for queue
  semantics - not for rendering);
- a completed assistant with `finish:"tool-calls"` keeps the turn open only while the status is not
  idle (the same idle override as today);
- a row is "empty" only when it has no non-hidden part **and** no attachment metadata/file part;
  bare shells are ignored, attachment-only sends are counted;
- excluding a resume prompt also consumes the immediately preceding pending user row (the prompt the
  resume resumes), so an interrupted turn does not reappear as a queued prompt;
- `queuedPromptIDs` includes the head; `runningPromptID` and the count follow T13.

`status` is read with a strict variant of `listSessionStatuses`
(`src/opencode/client.ts:263-297`): a valid empty map means idle; a malformed 200 body is a 502
`turn_unavailable`, not idle; an unrecognized session type is `unknown` (the client keeps its phase).
A subagent session absent from the status map is `unknown`, not idle; the client keeps its SSE/parent
phase and the limit is documented.

Status/history consistency: read status, then the history tail, then status again. If the status
changed between the first and last read, retry once (bounded). If the final status is idle and the
tail ends in an unanswered user row but the second status read is also idle, the row is genuinely
queued; if the inconsistency persists after the retry, return `settling:true` and let the client
suppress the queued row for one idle reconcile. This prevents a just-finished turn from appearing as
`Ready · 1 queued` while its final assistant is not yet persisted.

Delivery of the snapshot:

- `GET /api/apps/:app/sessions/:sid/turn?project=...` - human-only, non-starting, read-only. The
  handler lives in `handleChat` (`src/http/chat.ts`) before `ensure`, with the explicit matcher and
  the same non-starting read helper as `/messages`. It reuses `findApp`, `withReadEndpoint`, a
  bounded `listMessagePage` with an explicit small `maxBytes`, and `projectHandoffMessages` before
  `deriveTurn`. It pages backward until the boundary is found or a page budget (e.g. 3 x 50) is
  exhausted, then sets `queuedTruncated`. The error matrix is T9. A short per-session single-flight
  cache (~250-500 ms) is keyed by `appId + sessionId + endpoint` and invalidated on an accepted
  send. No `observedAt`: ordering uses the request epoch, not a client/server clock.
- No new SSE event. The client pulls on session open, `stream.ready`, reconnect, visibility return,
  every reconcile path, every `session.status` transition, `session.error`, pause/limit, a `202`
  send acceptance, and when the queue dialog opens. A push `turn.updated` event and a status frame on
  `stream.ready` are later optimizations; the reconcile fetch already covers the missed-idle case.
- When `loadSidecars` has already fetched `/context` and it carries a valid `status`, the client may
  seed `phase` from it to avoid a blank window; `/turn` remains authoritative for the queue and the
  `contextPolicy`-independent fallback.

### 4.2 Client: slices and precedence

| Slice | Contents | Authority | Drives the row? |
| --- | --- | --- | --- |
| `turn` | `status`, `turnContinues`, `runningPromptID`, `activePromptID`, `queuedPromptIDs`, `queuedTruncated`, `settling`, `revision`, `source`, `requestEpoch`, `liveRevision`, `stale` | Server turn snapshot + live SSE | Yes (`status`, count) |
| `outbox` | Local sends: `sending`, `unknown`; keyed by temp then server ID | Composer acceptance chain | Yes (`sending`/`unknown`) |

Rows are tagged `origin:"server"|"local"` rather than split into a second physical list; the backlog
projection reads only `origin:"server"` rows. Local rows may keep the approved D3 visual order; they
cannot affect the row, the count, or the `Queued` chip.

Rules:

- **Replace** (session open, load, full reload): the server page is authoritative for messages; drop
  local-only rows that are not in-flight, keep in-flight local rows per D3.
- **Tail** (idle reconcile, stream ready, post-send): merge by ID, keep D3 order. If a non-empty
  snapshot shares no ID with a non-empty current order, treat it as disjoint and replace with
  `keepOptimistic:"transient"`, resetting the history cursor.
- **Status precedence**: `abort-settle > sse > snapshot`. A live SSE `session.status` sets
  `turn.status` immediately with `source:"sse"` and bumps `liveRevision`; the abort settle bumps it
  at start and end. A snapshot seeds status only when its `requestEpoch` is current, the session
  matches, and `liveRevision` has not advanced since the request started; otherwise the response is
  discarded and one re-fetch is scheduled. While `abortPending`/the abort settle is active, a
  snapshot `busy` does not show the row.
- **Failure**: 502/503 keeps the last snapshot, marks the client `stale`, and retries with a bounded
  backoff (for example 1s, 2s, 5s, stop at 30s); 409 hides the turn surface while read-only; 404
  uses the existing session-gone path; `unknown` keeps the phase.
- **Outbox**: a local send is never inserted into the server backlog. `sending` starts before the
  POST and times out into `unknown` after the existing acceptance grace; `unknown` is presented as
  `Delivery unknown` (or via the composer recovery UI) and settles only on a definitive server echo,
  user dismissal/retry, or a later turn snapshot listing it; idle never settles a send; a late 202
  after `unknown` rekeys and clears it. On reload the outbox is seeded from the existing
  `pendingSends`.
- **Single presentation projection**: the store maps `turn` to `feed.setAgentStatus` (composer/
  `currentStatusType`), `thread.queue`/`activePromptID`, and each server-backed row's `optimistic`
  presentation: `queued` when its ID is in `queuedPromptIDs` and it is not `runningPromptID`,
  otherwise `accepted`. `applySnapshot`/`rekeyOptimistic` no longer derive the queue; the pure
  `deriveQueue` remains only for parity tests until a follow-up cleanup, and is not used by the SPA
  row/queue path. `settleIdle` keeps sealing parts on the idle transition (rendering), but no longer
  promotes a queue.
- **Retire the client queue-promotion block** (`ui/chat/session-storage.ts` queue block only, the
  `sessionStorage` mirror, the `useChatComposer` guard, and the `allowPromotion` plumbing): the
  server queue and the status-driven row make it redundant. Keep the unrelated image intent in
  `session-storage.ts`.
- **Retire the client `deriveQueue`/`deriveQueueRows` from the row/queue path.** The dialog maps
  `turn.queuedPromptIDs` to feed messages for previews; an ID not in the local feed renders
  `Queued message`.
- **Turn hash naming**: the client snapshot hash is `turnRevision`; it must not collide with the
  feed's existing `revision` (UI redraw counter).

## 5. Label semantics

| Condition | Row | Label |
| --- | --- | --- |
| Outbox send `sending` | yes | `Sending` |
| Outbox send `unknown` | yes | `Delivery unknown` (plus the composer recovery) |
| `turn.status = busy`, a tool part is running | yes | `Running <tool>` |
| `turn.status = busy`, unsealed reasoning and no unsealed text | yes | `Thinking` |
| `turn.status = busy`, unsealed text | yes | `Working` |
| `turn.status = busy`, no unsealed text or reasoning | yes | `Thinking` |
| `turn.status = retry` | yes | `Retrying` |
| `turn.status = idle`, `queuedPromptIDs` non-empty | yes | `Ready · N queued` |
| `turn.status = idle`, queue empty | no | hidden |
| `Waiting for you` | no (dock/meta) | dock/meta |
| `Paused` | no (connection chip) | connection chip |
| No status yet (initial hydration) | no (brief) | hidden |
| `settling = true` on idle | no (brief) | hidden until the next reconcile |

The `· N queued` suffix uses the T13 display count; when the count is zero the suffix is omitted.
`queuedTruncated` renders `N+`. The count includes an idle head and excludes a running prompt. The
suffix is a real button in the thread turn-status live region (stable accessible name,
`aria-controls` the dialog, keyboard reachable), not inside the `aria-hidden` generation row; the
row mirrors it visually. The live region keeps only the label text and announces a phase/label change
once per change, not per token; this supersedes D7's "meta chip is the single announcement source"
for the turn phase. `Ready` alone is never rendered.

## 6. Queue presentation

- Remove the `ChatQueueStrip` usage from `ChatPage.vue`; delete the component and its CSS if no other
  surface uses it.
- Add the thread turn-status surface (label + `· N queued` button) to `ChatThread.vue`; the
  generation row mirrors the label.
- Upgrade `ChatQueueDialog.vue` to a real modal (`<dialog>` or inert background): focus on open,
  focus trap, Escape/backdrop close, return focus to the count button (with a fallback if it
  disappeared), `role="dialog"` with `aria-modal`, and empty/failed states.
- Dialog rows come from `turn.queuedPromptIDs` (including the head), not local derivation. The
  running row is marked active and never labelled queued. Previews use the feed when the ID is
  present; otherwise `Queued message`. The dialog fetches a fresh snapshot on open.

## 7. Alternatives

### A. Client-authoritative turn model (rejected)

Server event set unchanged; the three slices live in the browser with a read-only status route.

- Cons: the queue remains a client derivation over a 30-message tail; the class is reduced but not
  closed. Round 1 found the missed-idle-after-gap and hydration-race paths. The owner chose server
  authority.

### B. Server-computed turn snapshot (chosen)

The server derives status + turnContinues + running/queued and serves it over a read-only route; the
client pulls it on transitions and every reconcile. No DB, no new SSE event.

- Pros: one authoritative queue including the head and the running prompt; local rows cannot affect
  it; reconnect/reload converge; the row is status-driven so a phantom running turn is impossible;
  no always-on observer or extra upstream connection; bounded tail read with a short cache.
- Cons: one extra bounded history read per transition/hydration (mitigated by the cache, a small
  `maxBytes`, and the history budget); a brief stale count between a transition and the fetch
  (best-effort, accepted); the server duplicates the queue predicate (locked by shared fixtures and a
  parity test).

### C. Minimal patches (rejected)

Thread `allowPromotion`, pass `queueBlocked`, stop re-appending transient rows. Does not close the
class; a local row, a missed idle, or a reconnect can still produce false or missing state.

## 8. Changes by area (interfaces, not implementation)

- `src/chat/turn.ts` (new): pure `deriveTurn(messages, status)` plus the snapshot/cache types, the
  turnContinues/running/count rule, the handoff/OMO/resume/attachment exclusions, the resume
  consumption rule, and the tail paging/`queuedTruncated` result.
- `src/opencode/client.ts`: a strict status read for `/turn` (a malformed body is an error, not an
  empty map); an explicit small `maxBytes` for the turn tail.
- `src/http/chat.ts` / `src/http/server.ts`: the `GET .../turn` matcher and handler in `handleChat`
  before `ensure`, human-only, non-starting, `?project`, the T9 matrix, cache key
  `appId+sessionId+endpoint`, invalidation on accepted sends, `projectHandoffMessages` before
  `deriveTurn`.
- `ui/chat/turn-state.ts` (new) and `ui/stores/chat-feed.ts`: the `turn` slice, `requestEpoch`/
  `liveRevision`/`stale`, the fetch/coalescing client, `origin` tagging, the single outbox projection,
  and the single turn -> status/queue/`optimistic` projection.
- `assets/chat-core.js`: the label selector takes the full input set and returns a nullable label
  (new `generationLabel()` contract); the queue fallback is removed from the row path; the tail
  merge supports the disjoint reset.
- `ui/pages/ChatPage.vue`: selector inputs (`unsealedText`, `unsealedReasoning`, `runningTool`,
  `sending`, `unknown`, `queuedCount`); hydration on every reconcile/ready/reconnect/visibility/
  status/error/pause/send/idle; the page-level visibility refresh even while the SSE is live; remove
  the queue-strip slot; remove the promotion guard calls.
- `ui/chat/state-actions.ts` / `ui/chat/event-reducer.ts`: a `turn/hydrate` and a `turn/apply` action
  with the epoch/session guard; status/error actions trigger a refresh; no message-derived queue;
  remove the dead reducer duplicate/gap filtering.
- `ui/chat/stream.ts` / `ui/composables/useChatStream.ts`: the adapter remains the identity owner;
  `onResync` (gap/stream-id) triggers `refreshTurn` + message reconcile; `onLimit`/pause triggers a
  fetch or hides the row; `stream.ready` updates the mirrored identity.
- `ui/chat/session-storage.ts` / `ui/composables/useChatComposer.ts`: remove the queue block and its
  `sessionStorage` mirror (keep image intent); keep the acceptance/outbox state machine, the send
  timeout, the late-202 rekey, and `pendingSends` seeding.
- `ui/components/chat/ChatThread.vue`, `ChatGeneratingRow.vue`, `ChatQueueDialog.vue`: the turn-status
  live region, nullable label, modal behavior.
- `docs/current-state.md`, the design/plan/journal indexes; record the two supersessions.

## 9. Scenario matrix

| Scenario | Expected |
| --- | --- |
| Normal finished turn | On `session.status idle` the row hides (queue empty) or shows `Ready · N queued`; never `Working`; a transient `settling` snapshot suppresses a false queued row. |
| Busy before the first assistant part | `Thinking`, no queue suffix, no `Queued` chip on the in-flight prompt. |
| Busy + one queued behind the current | `Working · 1 queued`; the dialog marks the running row active. |
| Busy multi-step + one queued | `Working · 1 queued` (all pending counted). |
| Queued prompt while busy | The count comes from the server; the strip is gone; the modal lists it. |
| Stop/abort | Row hides or `Ready · N queued`; the promotion block is retired; `abort-settle > sse > snapshot`; a late busy snapshot does not re-show the row after the settle. |
| Mid-stream gap / missed idle | The adapter detects the gap, `refreshTurn` runs, the snapshot reports idle, the row hides. |
| `session.error` with no idle | `refreshTurn` runs; the row settles idle/error; no stuck busy. |
| Pause/limit | The row is fetched or hidden; the connection chip shows paused; no frozen Working. |
| Visibility return while live | The page refreshes messages + turn even though the SSE never dropped. |
| Hydration race | A snapshot that resolves after a newer SSE/abort update is discarded; one re-fetch runs. |
| Reload while busy | The row appears from the turn snapshot before the first SSE frame; it hides on idle. |
| Reload while idle / one pending prompt | `Ready · 1 queued`; the modal lists the head. |
| Session switch during fetch | The stale response is discarded by the session/epoch guard. |
| Disjoint tail after a long disconnect | The feed resets to a contiguous window; in-flight local rows are preserved. |
| OMO system / resume synthetic | Never in `queuedPromptIDs`; a failed resume also consumes the interrupted prompt; idle does not stick. |
| Attachment-only send | Counted as a queued prompt, not as empty. |
| Unknown send | `Sending` then `Delivery unknown`; never enters the server queue until accepted; a late 202 clears it; reload seeds `pendingSends`. |
| > tail queue | `queuedTruncated` renders `N+`; the count is not silently under-reported. |
| Waiting / paused | No generation row; dock/meta and connection chip respectively. |
| Subagent session | A status map omission is `unknown`, not idle; the row does not fabricate. |
| Multi-tab | Each tab pulls on its transitions; status can diverge until the next hydration; in-flight sends are per-tab until accepted. Best-effort, as decided. |
| Queue dialog open | Fresh snapshot; the running row is active; focus trapped; Escape/backdrop close; focus returns to the count. |

## 10. Testing and verification

- Unit (`test/chat-core.test.ts`): label selector matrix (nullable), D3 tail order, D7 waiting/paused
  row absence, disjoint reset.
- Unit (`test/chat-turn.test.ts`, new): `deriveTurn` boundary/parentID/tool-calls/idle-override,
  visible-part rules, turnContinues/running/count (B4), handoff/OMO/synthetic/resume exclusions,
  resume consumption, attachment-only rows, bare shells, empty/busy queue, head inclusion, `unknown`
  status, malformed map, subagent status, `queuedTruncated`, `settling`.
- Route tests: human-only, non-starting, `?project`, the full T9 matrix including `history_busy`,
  `messages_too_large`, session 404, cache invalidation on send, bounded tail paging, handoff
  projection.
- Adapter unit: duplicate drop, gap detection, `stream.ready`, reconnect; the store identity mirror.
- jsdom (`test/ui/chat-page.test.ts`, `test/ui/chat-queue.test.ts`): phase x outbox x queue matrix;
  B4 count cases; waiting/paused never create the row; no local row affects the row/count; hydration
  epoch/precedence, out-of-order resolution, late busy after abort, session.error without idle,
  pause/limit, visibility-while-live; client failure/stale; dialog behavior and focus; the strip is
  gone; `Ready · 1 queued`.
- Retire `test/ui/chat-session-storage.test.ts` queue-block cases (keep image-intent cases).
- E2E (`e2e/spa-chat.spec.ts`): normal finish, queued prompt, Stop, mid-stream gap, reconnect,
  reload, session switch, OMO/synthetic, resume failure, attachment-only, >tail queue, queue modal,
  two tabs. Update the legacy-mode assumptions at `e2e/spa-chat.spec.ts:500-529`.
- Browser QA (`docs/design/chat-qa.mjs`): run in SPA mode with `data-chat-*` selectors; add a
  deterministic gap/reconnect hook and the normal/queued/abort/reload/dialog scenarios.
- Gates: `npm run lint`, `npm run typecheck`, `npm run typecheck:ui`, `npm run typecheck:e2e`,
  `npm test`, `npm run build`, `npm run check:ui`, `npm run check:sensitive`, `npm run test:e2e`.

## 11. Risks

- The chat feed core has a wide blast radius (streaming, queue, abort, handoffs, OMO, pagination,
  session switching). Mitigation: keep the change behind the store/selector API, add the matrix
  tests first, and run the full browser QA.
- One extra bounded history read per transition/hydration. Mitigation: short single-flight cache,
  explicit small `maxBytes`, the existing history budget, and invalidation only on accepted sends;
  measure in QA.
- The server queue predicate duplicates semantics that used to live only in `chat-core.js`.
  Mitigation: shared fixtures and a parity test covering OMO header variants, resume, attachment-only,
  tool-calls, and aborted assistants; keep the predicate pure and small.
- Status-vs-history race: a just-finished turn can transiently look queued if the final assistant is
  not yet persisted. Mitigation: T14 (status -> history -> status, one retry, `settling` suppression),
  plus a fake-upstream test.
- A malformed upstream status map could fabricate idle. Mitigation: the strict status read (T9/T16)
  returns 502 instead.
- Subagent sessions may be absent from `/session/status`; the turn route reports `unknown`, and the
  row keeps the SSE/parent phase. Documented limit.
- Retiring the promotion block is a behavior change; the owner approved the `Ready · N queued`
  semantics, which makes the block unnecessary. Document it in the stage record.
- Multi-tab status can diverge until the next hydration, not only for in-flight sends. Stated limit.
- The queue dialog becomes a real modal; verify focus, Escape, the fallback when the count disappears,
  and the no-queue state.
- The route cannot use status absence alone to detect a deleted session; the history read's 404 is the
  existence check.

## 12. Owner decisions

Closed on 2026-11-08:

| ID | Decision |
| --- | --- |
| Q1 | Idle + queue renders `Ready · N queued` (the queue means the work is not fully finished, so it is not a bare `Ready`). The queue strip is removed; the count (including an idle head, excluding a running prompt) opens a modal. Active labels append `· N queued` (for example `Working · N queued`) using the T13 count. |
| Q2 | Restore the full legacy label vocabulary during a turn (`Working` with unsealed text, `Thinking` with reasoning, `Running <tool>`, `Retrying`). `Waiting for you`/`Paused` stay in their approved surfaces, not the row. |
| Q3 | Server-computed turn snapshot (Option B). |
| Q4 | Hydrate the snapshot on ready/reconnect/visibility/status transition/send acceptance/idle and every reconcile, with a bounded settle and the epoch/session guard. |
| Q5 | Multi-tab consistency is best-effort: another tab sees a prompt/status after the server accepts/persists it or after its next hydration. |
| Q6 | Keep the existing label vocabulary; no renaming in this stage. |

## 13. Design review

### Round 1 - `oracle` (2026-11-08) - **BLOCK** (Option A draft)

The queue-fallback diagnosis and the turn/outbox/backlog direction were correct, but the Option A
draft did not close the class: a dropped idle after a mid-stream gap, an async hydration race, and a
row-visibility contradiction with chat-pagination D7 blocked it. The owner chose Option B; every
finding is folded below.

| ID | Severity | Finding | Resolution in this revision |
| --- | --- | --- | --- |
| B1 | BLOCKER | A mid-stream gap only reloads messages; a missed idle stays busy. | T7: `refreshTurn` on every reconcile path through `scheduleReconcile`, plus `session.error` and pause/limit (S8/S9). |
| B2 | BLOCKER | Async hydration can overwrite a newer SSE/abort status. | T7: `requestEpoch` + session + `liveRevision` guard; the abort settle bumps `liveRevision` at start and end; precedence `abort-settle > sse > snapshot`. |
| B3 | BLOCKER | `Waiting for you`/`Paused` in the row contradicts chat-pagination D7 and T2. | T10/§5: they stay out of the row; only the idle-queue `Ready · N queued` supersedes D7, explicitly recorded. |
| S1 | SHOULD FIX | T4 order change contradicts chat-pagination D3. | T4: keep D3 order; tag `origin`; implement the disjoint-tail reset (S16). |
| S2 | SHOULD FIX | `Ready · N queued`/meta surface does not exist; the strip excludes the head. | G5/T8/§6: add the turn-status live region; `queuedPromptIDs` includes the head; count includes it. |
| S3 | SHOULD FIX | Route contract/placement underspecified; possible cheaper contract. | T9/§4: the full matrix, the `handleChat` matcher, strict status, no `observedAt`, `/context` as a seed only. |
| S4 | SHOULD FIX | Two/three status owners; guard not centralized; strip re-derives. | T5/§4.2: one turn slice, one presentation projection (S15); the client `deriveQueue`/guard are retired. |
| S5 | SHOULD FIX | Outbox `unknown` undefined; idle settling is wrong; reload does not seed. | T12/§4.2: the explicit machine, the timeout, the late-202 rekey, `pendingSends` seeding, `Delivery unknown`. |
| S6 | SHOULD FIX | Selector returns a string/queue fallback; tests encode the phantom; no live announcement. | §8/§10: nullable `generationLabel()`, rewritten tests, the turn-status polite live region once per change. |
| S7 | SHOULD FIX | Abort-settle/block precedence vs the snapshot unspecified. | T7/§4.2: `abort-settle > sse > snapshot`; the abort-settle `liveRevision` bump; the block retired. |
| N1 | NOTE | Adapter already owns dedupe/gap; `stream.ready` never reaches the reducer. | T6/§8: the adapter is the single identity owner; remove the dead reducer filtering. |
| N2 | NOTE | Resume-synthetic rows can be counted pending. | T11: exclude `agent-resume` and consume the interrupted prompt (S10). |
| N3 | NOTE | Multi-tab divergence is broader than in-flight sends. | §11 states the limit. |
| N4 | NOTE | QA harness uses legacy selectors. | §10: SPA `data-chat-*` selectors plus a deterministic gap/reconnect hook. |
| N5 | NOTE | Gates/`observedAt`/deleted-session caveats. | §10/§11: added `check:ui` and `typecheck:e2e`; `observedAt` dropped; the history 404 is the existence check. |

### Round 2 - `oracle` (2026-11-08) - **PASS WITH FIXES** (Option B delta)

Option B is the right architecture and the Round 1 blockers are addressed in direction. The delta was
not implementable as written: B4 reintroduced the "active prompt is queued" behavior that
`chat-ux-overhaul` rejects, and the remaining items are spec completions and test-matrix gaps. All
findings are folded into this revision; the design-review gate is cleared.

| ID | Severity | Finding | Resolution in this revision |
| --- | --- | --- | --- |
| B4 | BLOCKER | The busy-head rule counted the in-flight prompt as queued: `activePromptID` null while busy and `queuedPromptIDs` included the head, so a normal turn showed `Working · 1 queued` and a `Queued` chip before the first visible part. `chat-ux-overhaul.md:288-330` explicitly rejects counting the active prompt. | T13/§4.1/§5: carry `turnContinues`; `runningPromptID = queuedPromptIDs[0]` only when `status=busy && !turnContinues`; the display count excludes it; at idle the count includes the head; while multi-step all pending count; the dialog marks the running row active. Fixtures added. |
| S8 | SHOULD FIX | `session.error` is not a turn trigger; a missed idle after an error leaves the row busy. | T7/§4.2: `session.error` (normal and abort-suppressed) calls `refreshTurn`, sets idle, and bumps `liveRevision`; test with no following idle. |
| S9 | SHOULD FIX | Stream pause/limit is not a turn trigger; a busy row stays frozen. | T7/§4.2: fetch `/turn` on the pause/limit transition (HTTP works while SSE is limited) or hide the row; jsdom test. |
| S10 | SHOULD FIX | Excluding the resume row does not consume the interrupted prompt; an idle-after-failed-resume can show `Ready · 1 queued`. | T11/§4.1: excluding a resume prompt also consumes the immediately preceding pending user row; fixture `user U, bare interrupted assistant, resume R, idle -> no row`. |
| S11 | SHOULD FIX | Handoff rows are DB-injected by `projectHandoffMessages`, not in upstream history; `deriveTurn` would count them. | T16/§4.1/§8: run `projectHandoffMessages` before `deriveTurn`; handoff-session fixture. |
| S12 | SHOULD FIX | A bounded 50-message tail undercounts >tail queues while `nextCursor` exists. | T16/§4.1: page backward to the boundary within a page budget and return `queuedTruncated`; the client renders `N+`; >tail fixture. |
| S13 | SHOULD FIX | The status-vs-history race is unspecified; a just-finished turn can look queued if the final assistant is not yet persisted. | T14/§4.1: status -> history -> status, retry once, `settling` suppresses the queued row for one reconcile; fake-upstream test. |
| S14 | SHOULD FIX | Client behavior on `/turn` failure is unspecified; `stale` lived in the server interface. | T15/§4.2: `stale` moves to the client; 502/503 keep last + bounded retry, 409 hides, 404 session-gone, `unknown` keeps the phase; jsdom failure matrix. |
| S15 | SHOULD FIX | Retiring `deriveQueue` from the row/queue path is under-specified; `applySnapshot`/`rekeyOptimistic`/`recomputeQueue`/`currentStatusType`/`settleIdle` still use it. | T5/§4.2: one `turn` -> status/queue/`optimistic` projection; remove or re-scope the internal derive calls; migrate `currentStatusType`; keep sealing only; test a snapshot alone sets the row and the `Queued`/`Accepted` chip. |
| S16 | SHOULD FIX | T4 claimed a disjoint-tail reset the SPA never performs. | T4/§4.2: implement the shared-ID/non-empty check and replace with `keepOptimistic:"transient"`; reset the cursor; fixture. |
| S17 | SHOULD FIX | "Empty user rows are ignored" is ambiguous for attachment-only sends. | T11/§4.1: empty = no non-hidden part and no attachment metadata/file part; count attachment-only; fixture. |
| S18 | SHOULD FIX | Route contract inconsistencies (`agent_stopped` vs `agent_not_running`, missing session 404/`history_busy`/`messages_too_large`, `/prompts` placement, cache key). | T9/§4.1: the exact matrix, `handleChat` before `ensure`, `appId+sessionId+endpoint` cache key, corrected deleted-session wording. |
| S19 | SHOULD FIX | The test matrix misses session.error, pause/limit, visibility-while-live, late busy after abort, >tail queue, handoff projection, attachment-only, subagent status, the status/history race, and the route `history_busy`/session 404; it does not retire the queue-block tests or update e2e/QA. | §10: all rows added; `test/ui/chat-session-storage.test.ts` queue-block cases retired; e2e/QA updated; SPA-mode browser QA. |
| N6 | NOTE | `listSessionStatuses` collapses a malformed 200 body to `{}`, fabricating idle. | T9/T16: a strict read makes a malformed body a 502; test. |
| N7 | NOTE | Subagent sessions may be absent from `/session/status`; `/turn` would report idle while a subagent runs. | T16/§4.1: report `unknown` for an absent subagent (not idle); the client keeps the SSE/parent phase; fixture and documented limit. |
| N8 | NOTE | D7's single-announcement source is not recorded as superseded; the live region could double-announce; the dialog is not modal. | §5/§6: record the supersession; only the label text in the live region; stable button name/`aria-controls`; a real modal with focus fallback. |
| N9 | NOTE | `listMessagePage` reserves `maxBytes*4`; the turn tail competes with `/messages`. | §4.1/§11: an explicit small `maxBytes`, the single-flight cache, and a QA measurement. |
| N10 | NOTE | `session-storage.ts` also owns image intent; the client hash name collides; `sending` has no timeout today. | §4.2/§8: keep image intent; name the hash `turnRevision`; define the send timeout and the late-202 race. |
