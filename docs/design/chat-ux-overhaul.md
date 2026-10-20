# Design - Chat UX overhaul

Status: **implemented and verified** (2026-10-19). The lint/typecheck/test/build gates and the
deterministic browser harness (`node docs/design/chat-qa.mjs`) pass. Evidence:
[journal 0006](../journal/0006-chat-ux-overhaul.md) and
[artifacts/chat/README.md](./artifacts/chat/README.md). The live-agent smoke passed on `deployment-host` after
deployment; deterministic coverage is 1440/390 dark.
Scope: the Web UI chat workspace and the Hanse app event/send APIs that feed it.
Out of scope: implementation. This document is the contract a plan can be written from.

## 1. Summary

The chat workspace currently refetches and fully re-renders the message list after every SSE
activity event. That makes streaming impossible, makes "Working" a proxy for one blocking POST, and
turns every turn into a 300 ms debounce plus `replaceChildren`. This design replaces that loop with:

- a typed, sequenced app SSE stream that forwards message and part updates;
- an additive `?async=1` send path with a server-generated message ID, an immediate optimistic user
  message, and upstream queueing while the agent works;
- a keyed client store and incremental DOM patching (no framework, no bundler, no dependency);
- a truthful status model derived from `session.status`, the latest part, and the queued-message count;
- inline question/Q&A cards correlated to the existing `question` tool part (no new persistence),
  with forward auto-advance for single-select questions in a multi-question block;
- client-only OMO system-message classification so internal reminders/results render as system cards,
  not operator prompts, and stay out of the queue;
- streamed bash output, pretty `todowrite`, one-line previews for every tool, and GFM pipe tables;
- a 75% feed measure at `>= 1024` (60ch floor, 96rem cap) with a prose measure inside it;
- explicit performance, scroll, reconnect, queue, and accessibility rules.

The upstream contract is the verified `opencode` 1.19.3 surface (`opencode-ai@1.19.3`), the locally
verified 1.18.35 event payloads, and the bundled `oh-my-openagent@5.1.35` message contract listed in
section 4. Nothing here invents a `message.part.*` shape.

## 2. Current behavior and root causes

| Area | Current code | Consequence |
| --- | --- | --- |
| Projection | `EventProjector` in `src/opencode/events.ts:205-307` maps `message.updated` and `message.part.updated` to `session.activity` | The stream carries no parts/text; the browser cannot render incrementally. |
| Reload | `assets/chat.js:904-909` debounces 300 ms and calls `loadMessages` | Every token/tool tick becomes a GET. |
| Render | `assets/chat.js:853-891` collects open tools, `replaceChildren()`, re-renders all messages | Full-list DOM destruction every reload; scroll and open state are patched after the fact. |
| Send | `assets/chat.js:2759-2817` awaits the blocking `POST .../messages`; `src/http/chat.ts:480-488` awaits `sendPrompt` | The user message appears only after the turn; `pendingSends` (line 68) is the only "Working" signal. |
| Status | `setWorking(sending && !promptsWaiting)` (`assets/chat.js:363`) | `Working` means "the POST is in flight", not "the agent is busy/retrying/running a tool". |
| Reasoning | `renderDetail("reasoning", ...)` (`assets/chat.js:837-839`) | Label reads `reasoning`, not `Thinking`. |
| Questions | `renderPromptDock` (`assets/chat.js:1991-2011`) replaces a single dock above the composer | Questions and answers are not feed history; the completed Q&A disappears. |
| Tools | `renderTool` (`assets/chat.js:764-783`) prints the whole `state.output` in `<pre>` | No partial bash output, no `todowrite` checklist, weak one-line preview. |
| Markdown | `renderMarkdown` (`assets/chat.js:658-737`) | No tables. |
| Width | `.chat-thread__inner { max-inline-size: 76ch }`, `.message__body { max-inline-size: 68ch }` (`src/http/styles.css:2136-2142, 2172-2178, 3602-3604`) | The feed does not use available width on wide screens. |

The existing prompt plumbing (`src/http/prompts.ts:645-749`), the raw per-session SSE
(`src/http/chat.ts:336-396`), and the blocking send route stay compatible. The new work is additive.

## 3. Requirements

Every user request has an ID. Acceptance criteria in section 13 trace back to these IDs.

| ID | Requirement |
| --- | --- |
| R1 | Pressing Enter in a question's custom-answer input submits the current step's primary action (Next, Review, or Send answer) without inserting anything; for multi-select it includes the custom answer and advances; it never auto-confirms an empty send or a dismissal. |
| R2 | A submitted user message appears in the feed immediately, before the server accepts the prompt, and is reconciled with the authoritative server message without a duplicate or a flicker. |
| R3 | Agent status is explicit and accurate: `Sending`, `Thinking`, `Working`, `Running <tool>`, `Waiting for you`, `Ready`, `Retrying`, `Paused`, with elapsed time while a turn is active. Status is no longer inferred from the in-flight HTTP request. |
| R4 | The reasoning disclosure is labelled `Thinking`; its content and collapsed-by-default behavior are unchanged. |
| R5 | Assistant text streams into the feed as it arrives, in part order, without duplicated or lost characters after reconnect or idle. |
| R6 | Questions appear as interactive feed cards in place of their `question` tool part; answered questions become read-only Q&A cards in the same place. No new database table is used. |
| R7 | Tool output streams where the upstream provides it; `bash` is the minimum (partial output while running, final output on completion). A >1 MiB upstream bash snapshot must still reach the app projector and be capped/streamed, not dropped by the default parser frame cap. |
| R8 | Collapsed tool calls have a useful one-line preview, and tool rendering is type-aware: `todowrite` is a checklist, `question` is a Q&A card, and read/write/edit/grep/glob/webfetch/websearch/generic have defined previews. |
| R9 | Assistant markdown renders GFM pipe tables safely. |
| R10 | At `>= 1024px` the feed/composer content box is `min(100%, max(60ch, 75%))` capped at `96rem`, with a readable prose measure inside it; below 1024px it is 100%. Ratios are measured against the padded content box (see 9.1). |
| R11 | Incremental stream updates patch keyed DOM nodes rather than replacing the feed; scroll is stable, and a reader who is away from the bottom is not dragged. |
| R12 | No regression in questions, permissions, the Plan/Todo panel, saved permissions, policy warnings, session switching, drafts, deletion, or the existing message/send APIs. |
| R13 | Stream transport is bounded and recoverable: app frames up to 8 MiB reach the projector, typed events stay within 256 KiB after caps, truncation/omission is flagged, sequences/hydration recover, and message content is not duplicated across a snapshot. |
| R14 | Accessibility is preserved: no token-level live-region announcements, status changes are announced once, streaming content is not announced, keyboard and focus behavior are defined, and reduced motion is honored. |
| R15 | While the agent is busy, `?async=1` sends are accepted and queued upstream; the feed shows the operator messages immediately, the queue strip shows count and one-line previews, status shows `Working · N queued` (or another active-turn label) when queued messages exist, and queued rows clear when the last visible assistant's `parentID` reaches them; bare shells do not clear. A completed assistant with `finish:"tool-calls"` still means the turn continues, so new prompts are queued, not active. No Hanse-side holding queue, no remove control, and no 409-on-busy rejection. |
| R16 | In a multi-question block, choosing an option for a single-select question immediately advances to the next question or to Review after the last; focus moves to the next question's first input/tab and the advance is announced. Multi-select does not auto-advance, and a single-question block never auto-submits. |
| R17 | OMO-injected operator-role messages whose text parts are all `synthetic === true` or contain `<!-- OMO_INTERNAL_INITIATOR -->` render as OMO system cards (label, kind, tone, title, safe markdown body), not operator messages; internal markers are hidden, `<system-reminder>` is unwrapped, long results are collapsible, and system messages are excluded from the operator queue. |

## 4. Upstream facts used as the contract

These are authoritative for this design. They are verified against the local `opencode serve`
1.18.35 OpenAPI and the repo's 1.19.3-verified behavior, plus the bundled `oh-my-openagent@5.1.35`
source for the OMO message contract. The design must not assume fields beyond these.

| Surface | Verified shape |
| --- | --- |
| `/event` `message.part.delta` | `properties: {sessionID, messageID, partID, field, delta}`. Text and reasoning deltas use `field: "text"` and carry incremental strings. |
| `/event` `message.part.updated` | `properties: {sessionID, part}` where `part` is a full Part snapshot. |
| Part types | `text`, `reasoning`, `tool`, `step-start`, `step-finish`, `patch`, `file`, `subtask`, `retry`, `compaction`, `snapshot`, `agent`. |
| Text/reasoning part | `id`, `sessionID`, `messageID`, `text`, `time`, optional `synthetic`, optional `ignored`. `ignored: true` means the text is internal bookkeeping; it is not rendered but still participates in OMO classification when `synthetic`/marker applies. |
| Tool part | `id`, `sessionID`, `messageID`, `callID`, `tool`, `state`. |
| `ToolState` | `pending`, `running`, `completed`, `error`. Running has `input`, `time`, optional `metadata`; `bash` streams partial output in `state.metadata.output` while running. Completed has `state.output`, `state.metadata`, `title`, `time.start`, `time.end`. |
| `todowrite` | `state.input.todos` while running; `state.metadata.todos` when completed; items are `{content, status, priority}`. |
| `session.status` | `{sessionID, status: {type: "idle" \| "busy" \| "retry", attempt?, message?, next?, action?}}`. |
| `session.idle` | `{sessionID}`. |
| `message.updated` | `{sessionID, info: Message}`. Assistant `info` may carry `finish?: string` (for example `tool-calls`); the app stream copies it bounded to 32 chars. |
| Removals | `message.part.removed` and `message.removed` exist; their exact payload fields are not part of this contract. |
| Send | `POST /session/:id/prompt_async` accepts the same body as `/message` (`parts`, optional `messageID` matching `^msg`) and returns 204 immediately. `POST /session/:id/message` blocks and returns the AssistantMessage. |
| Queueing | `prompt_async` returns 204 immediately even while the session is busy; the user message is created in v1 history immediately and is consumed at the next LLM call/turn after the current assistant turn finishes. Multiple queued prompts appear in order; one assistant response may answer several of them. The assistant `parentID` is the last queued user message, so `parentID` alone cannot mark each queued prompt as processed. |
| Queue removal | `DELETE /session/:sid/message/:mid` while busy returns 409 `SessionBusyError`; queued messages cannot be removed while the agent works. |
| Question correlation | A pending question has `QuestionRequest.tool = {messageID, callID}`. History already contains a `tool` part with `tool: "question"`, `state.status: "running"`, and `state.input.questions`. After answering, the same part becomes `completed` with `state.output` and `state.metadata.answers: string[][]`. |
| Frame limit | The `SseParser` default is 1 MiB; the app stream explicitly uses `APP_STREAM_MAX_FRAME_BYTES` = 8 MiB (6.4). Frames above 8 MiB are dropped/omitted per 6.4. |

Question/answer history therefore needs no new table. The request ID is still required for the reply
route; the tool part is the render key.

### 4.1 OMO message contract (client-side classification)

Verified in the bundled `oh-my-openagent@5.1.35` source (`isSyntheticOrInternalUserMessage` and the
internal-marker helpers):

- Internal markers are `<!-- OMO_INTERNAL_INITIATOR -->` and `<!-- OMO_INTERNAL_NOREPLY -->`.
- A message is synthetic/internal iff `role === "user"`, it has at least one text part, and **every**
  text part is `synthetic === true` or contains `<!-- OMO_INTERNAL_INITIATOR -->`.
- Marker stripping uses `/\n*<!--\s*OMO_INTERNAL_INITIATOR\s*-->\s*/g` and
  `/\n*<!--\s*OMO_INTERNAL_NOREPLY\s*-->\s*/g`.
- Background notifications are wrapped in `<system-reminder>...</system-reminder>` and begin with
  one or more bracket headers such as `[BACKGROUND TASK RESULT READY]`, `[BACKGROUND TASK COMPLETED]`,
  `[ALL BACKGROUND TASKS COMPLETE]`, `[ALL BACKGROUND TASKS FINISHED - N FAILED]`,
  `[BACKGROUND TASK ERROR]`, `[BACKGROUND TASK CANCELLED]`, `[BACKGROUND TASK INTERRUPTED]`,
  `[BACKGROUND TASK RETRYING]`, `[BACKGROUND TASK RETRY SESSION READY]`, and
  `[SYSTEM DIRECTIVE: OH-MY-OPENCODE - ...]`. `BOULDER COMPLETE` is a plain first line.
- Header extraction follows OMO's own `getSystemReminderHeaderLines` rule: skip empty lines; if the
  first content line is exactly `<system-reminder>`, start after it; collect consecutive
  `/^\[[^\]]+\]$/` lines until a blank line, `</system-reminder>`, or a non-bracket line. Treat a
  leading `BOULDER COMPLETE...` line as an additional title line.

This classification is client-side only. It is stable from the first render because OMO appends the
marker at creation and sets `synthetic: true` on continuation parts. An operator who pastes
`<!-- OMO_INTERNAL_INITIATOR -->` into an otherwise real prompt is the only false positive; strict
parity with OMO is chosen over a known-header guard (see 9.10).

## 5. Decisions

Each decision names the rejected alternatives and why.

### D1 - Transport: extend the existing app-scoped typed SSE

Use `GET /api/apps/:app/events` and add typed `message.*` and `session.status` variants. Keep the
raw per-session SSE route unchanged for compatibility.

Rejected:

- **Raw per-session proxy.** It puts upstream parsing, caps, and normalization in the browser,
  duplicates the app-level stream, and cannot enforce the 8 MiB frame/256 KiB event caps centrally.
- **Polling `/messages`.** It cannot produce token streaming, multiplies full-session reads, and
  still needs a separate prompt/permission stream.
- **WebSocket.** It adds a second protocol and runtime surface with no benefit over ordered SSE.

The existing stream already has server-side parsing, heartbeats, backpressure, hydration, and tests;
extending it is the smallest correct change.

### D2 - Send: additive `?async=1` flag with a Hanse-generated message ID

Add `?async=1` to `POST /api/apps/:app/sessions/:sid/messages`. With the flag, the route generates a
`msg_...` ID, forwards it to `prompt_async` with the same `parts` body, and returns
`202 {accepted: true, messageID}` immediately. Without the flag, the blocking `{message}` response is
unchanged for the IDE extension and other callers. The async path never returns 409 because the
session is busy.

Rejected:

- **Keep blocking POST.** It cannot show the user message or status before the turn ends, and it
  cannot queue while the agent works.
- **Client-supplied `messageID`.** It would make optimistic reconciliation simpler but moves ID
  authority and duplicate handling into every client. The server owns the ID so every client gets the
  same contract.
- **A separate `/messages/async` route.** A query flag is the additive form the owner selected; it
  keeps one message route and one request body.

The optimistic client row uses a temporary `local_...` ID and is rekeyed to the server ID on `202`.
User events for the server ID that arrive before the response are buffered and applied to that row
when the ID is known, so one node remains (invariant 12).

### D3 - Questions: inline feed card keyed to the tool part; dock is the fallback

Any question with a valid `tool = {messageID, callID}` renders inline at the matching `question` tool
part. If the part is missing or omitted after hydration, the same inline node stays at the end of the
feed in a `part-unavailable`/`preparing` state (it can still be answered from the request). The same
node transitions from interactive controls to read-only Q&A when the part becomes `completed`.
Questions **without** a tool ref keep the existing dock above the composer; the dock is not used for a
request that has a tool ref. Permissions always stay in the dock.

Rejected:

- **Dock only.** Fails R6; answered questions vanish from history.
- **Both dock and feed card.** Duplicate controls, two sources of truth, and ambiguous focus.
- **Move a request with a missing part to the dock.** It creates a duplicate/orphan when the part
  arrives and breaks correlation; keep the inline `part-unavailable` card instead.
- **Synthesize a feed card without a part correlation.** It cannot be ordered, keyed, or reconciled
  with history, and would duplicate on reload.

No persistence is added: the tool part is the record.

### D4 - Rendering: keyed maps + incremental DOM patching

The browser keeps keyed `Map`s for messages and parts, plus a part-order array per message. Event
handlers mutate the store, schedule one animation-frame flush, and patch only changed nodes. A full
`replaceChildren` is allowed only for empty/error states and session switches.

Rejected:

- **Keep `replaceChildren` per reload.** Fails R11 and preserves the jank.
- **A client framework or morphdom-style dependency.** Violates the no-bundler/no-dependency
  constraint and is unnecessary for append/replace semantics.
- **Server-rendered HTML fragments for every tick.** It moves rendering cost to the coordinator and
  still requires DOM replacement.

### D5 - Status: derive from the session, latest part, and queue; connection is separate

Use `session.status` (`busy`/`idle`/`retry`), the derived queued-message count, and the latest
running/streaming part. The SSE connection state stays in `.chat-live` and is never conflated with
agent status. A busy status with queued messages renders `Working · N queued` (or the current tool/
thinking label plus `· N queued`); queueing itself never changes the label to `Thinking`.

Rejected:

- **`pendingSends` only.** Fails R3.
- **A single "Working" label.** It cannot distinguish pre-first-token, streaming, a running tool,
  retry, and waiting for input.
- **Infer entirely from part activity.** It cannot represent `idle`, `retry`, or a turn that has not
  produced a part yet.

### D6 - Markdown: extend the hand-rolled safe renderer with GFM pipe tables

Keep the existing DOM-only renderer, add pipe tables with inline formatting inside cells, and cap
the table size. No dependency, no new parser package, no bundler.

Rejected:

- **Add `markdown-it`/`remark` and a bundler.** Violates the runtime constraint and pulls a new
  parser into a security-sensitive path.
- **Server-side markdown HTML.** It would require sanitizing agent HTML and shipping HTML over SSE.
- **No tables.** Fails R9.

### D7 - Layout: 75% feed at `>= 1024`, 100% below, prose measure inside

At `>= 1024`, the shared feed/composer content box uses
`inline-size: min(100%, max(60ch, 75%))` and `max-inline-size: 96rem`; below 1024 it is 100%.
Assistant prose (`p`, lists, headings, blockquotes) is capped at `--reading-measure` (68ch), while
tables, code blocks, and tool output may use the full feed width. The 60ch floor exists because at
1360-1440 the three-pane grid leaves roughly 550-630px of content; a literal 75% would drop prose to
~49-56ch, while the floor keeps it readable. The derived ratio table is in 9.1; 1440 is floor-driven
and is not claimed to be 75%.

Rejected:

- **Keep `76ch`.** Fails R10; wide screens leave the feed narrow.
- **Pure `100%` with no prose cap.** Long prose becomes hard to read and tables dominate.
- **Container queries.** Unnecessary; the existing breakpoints already select the layout.

### D8 - Tool rendering: one generic path plus explicit renderers

Keep one `.tool-call` disclosure and add type-aware content. `bash` streams; `todowrite` is a
checklist; `question` delegates to the inline card; every other tool has a one-line preview rule
(section 9.4). Reasoning stays collapsed by default and only its label changes to `Thinking`; no
auto-expand while streaming.

Rejected:

- **One generic `<pre>` for all tools.** Fails R7/R8 and hides structure that is already in the part.
- **A renderer package or per-tool HTML templates from upstream.** No dependency; upstream has no
  such templates.

### D9 - Performance: coalesce deltas, throttle expensive renders, never re-render the rail per tick

Deltas are buffered per part and applied once per animation frame. Markdown is re-rendered at most
every 50 ms while streaming and once on completion/idle; tool output at most every 100 ms. The
sessions rail renders only when its signature changes. Scroll is anchored manually.

### D10 - Persistence: none

Questions and answers come from existing message parts. Status, optimistic messages, queue
derivation, OMO classification, drafts, and scroll state are client state. The queue lives in
upstream history, not in a Hanse-side holding queue. There is no new SQLite table, migration, or
durable prompt inbox.

### D11 - Queueing: use the upstream queue, not a Hanse holding queue

Keep one agent turn per session but allow multiple operator prompts to be accepted while the turn is
busy. `?async=1` calls `prompt_async`; the upstream queue consumes the prompts at the next LLM
call/turn. The client may serialize acceptance POSTs in a short per-session chain so send order is
preserved, but the chain is only an HTTP ordering device: it does not hold prompts for the agent and
it is not persisted.

Send gating changes: the composer is disabled only while a blocking question/permission is pending,
while an acceptance request is in flight, or while an acceptance outcome is `unknown` and awaiting
reconciliation. It is **not** disabled merely because `session.status` is `busy`. The old turn-long
`pendingSends` lock is removed.

Queue derivation uses feed order, `parentID`, and turn state:

- Ignore assistant **shells** (no visible part) when choosing the last assistant boundary.
- The last assistant with visible parts has `parentID` = the last consumed user message. Mark trailing
  operator rows up to and including that `parentID` as processed (feed-position fallback when
  `parentID` is absent/unusable). Pending rows are the operator rows after that boundary.
- `turnContinues = lastVisibleAssistant !== null && (assistant.time.completed absent ||
  assistant.finish === "tool-calls")`, with an **idle `session.status` override to false**. A
  completed assistant with `finish:"tool-calls"` means the agent is still in a multi-step turn, so a
  prompt sent then is queued, not active. An uncompleted assistant is also still active. An aborted
  assistant is normally finalized (`time.completed` + `finish:"aborted"`); if a snapshot is
  uncompleted but the session is idle, the override prevents a false "turn continues".
- If `turnContinues`, every pending row is queued (`activeID = null`). Otherwise, the head is the
  tracked `activePromptID` if it is still in pending, else the first pending row; rows after the head
  are queued. The head is the active/current prompt.
- The head is never shown in the strip and is not counted in `N queued`. It renders normally
  (`Sending` before 202, otherwise `accepted`/normal). If `turnContinues` is false and the head was
  derived only because no tracked ID exists, the client adopts it as `activePromptID`.
- Track `activePromptID` from the accepted send (`202`) for the current turn. Clear it when the last
  visible assistant's `parentID` reaches it, or when it leaves pending. On reload derive it as above;
  if ambiguous, use the first pending row only when `turnContinues` is false.
- OMO system messages are excluded from this scan; they do not count as operator prompts and do not
  break the trailing operator sequence.
- Optimistic `sending` rows are included in the scan; optimistic `unknown` rows are included when they
  are beyond the consumed boundary.

Queue strip density is fixed: one line, up to three one-line previews plus `+N more`, horizontally
scrollable on mobile. It is placed **above the prompt dock**, between the feed and the dock, because
the dock's question/permission controls must stay adjacent to the composer while the queue is
informational; when the dock is hidden the strip sits directly above the composer. It has no remove
action and is hidden when empty.

Rejected:

- **A Hanse-side holding queue.** It duplicates upstream queue semantics, needs persistence and
  recovery rules, and would diverge from `parentID`/history.
- **Reject sends while busy (409).** Fails R15 and forces the operator to wait for the whole turn.
- **Clear every trailing row whenever any assistant message appears.** It clears prompts that the
  assistant did not consume; the `parentID` boundary is required.
- **Treat any completed assistant as an idle turn.** A completed assistant with `finish:"tool-calls"`
  is mid-turn; using completion alone marks the next prompt active when it is queued.
- **Count the active prompt as queued.** It makes a normal first prompt look queued and inflates
  `N queued`.
- **Expose cancel/remove for queued messages.** Upstream `DELETE /session/:sid/message/:mid` returns
  409 `SessionBusyError` while busy. No remove control is exposed; a future local outbox is a new
  stage.

### D12 - Multi-question auto-advance

For a block with more than one question, selecting an option on a single-select question
(`multiple !== true`) immediately advances to the next question; selecting on the last question
advances to Review. Focus moves to the next question's first input/tab (or the Review primary), and
`#chat-announcer` announces `Question N of M`. The card is patched in place so focus and the custom
draft survive.

Multi-select questions never auto-advance; the operator uses Next/Review. A single-question block
never auto-submits on selection; the explicit Send answer remains. Enter in the custom input keeps
R1's behavior (Next/Review/Send answer) and, for multi-select, includes the custom answer and advances.
Auto-advance is skipped while composing or when a confirmation is open.

Rejected:

- **Auto-advance for multi-select.** It would submit an incomplete selection.
- **Auto-submit a single question on selection.** It removes the explicit confirmation/empty-answer
  safety.
- **Re-render the whole card on selection.** It loses focus and the custom draft, and it is what D4
  removes.

### D13 - OMO system messages: client-side classification and system cards

Classify an operator-role message as OMO/system when it has at least one text part and **every** text
part is `synthetic === true` or contains `<!-- OMO_INTERNAL_INITIATOR -->` (the OMO 5.1.35
`isSyntheticOrInternalUserMessage` contract). Strip `<!-- OMO_INTERNAL_INITIATOR -->` and
`<!-- OMO_INTERNAL_NOREPLY -->`, unwrap `<system-reminder>...</system-reminder>`, extract the leading
header line(s), and render a system card: `OMO` + kind, system glyph, timestamp, inset surface, no
operator avatar/bubble, safe markdown body. Long background results are collapsible with a one-line
preview; short reminders are inline.

Classification is client-only. System messages are conversation history, excluded from the operator
queue and from queued detection. No SSE or server change is needed because the marker and
`synthetic` flag are present from creation.

Rejected:

- **Server-side classification.** It would need a new event/field or persistence and would duplicate a
  browser-only concern.
- **Render as operator messages.** It pollutes the operator transcript and the queue strip.
- **Hide system messages entirely.** Background-task results and continuation directives are useful
  history.
- **Require a known header.** It would miss synthetic continuations that have no bracket header; strict
  OMO parity is chosen. The only false positive is an operator pasting the internal marker into a real
  prompt; 9.10 documents the optional known-header guard.

## 6. Hanse event contract

### 6.1 Envelope

Every app-stream frame is one `data:` line with:

```ts
interface HanseStreamEnvelope {
  type: string;
  seq: number;       // 0 only for stream.ready; 1..N otherwise
  streamID: string;  // opaque, new per HTTP connection
}
```

`stream.ready` carries `{type: "stream.ready", seq: 0, streamID}`. The server allocates `streamID`
once per `streamAppEvents` connection (for example `crypto.randomUUID()`), increments `seq` for every
emitted event, and never reuses a `streamID`. Heartbeats (`: ping`) carry no sequence.

The envelope additions are additive: old clients ignore unknown fields and types. `stream.ready` is
emitted after the upstream reader is attached, as today (`src/http/prompts.ts:715-729`).

### 6.2 New variants

```ts
type PartType =
  | "text" | "reasoning" | "tool" | "step-start" | "step-finish" | "patch"
  | "file" | "subtask" | "retry" | "compaction" | "snapshot" | "agent";

interface Truncation {
  fields: string[];      // dotted paths, e.g. ["state.metadata.output"]
  omittedBytes: number;
}

type HanseEvent =
  | { type: "stream.ready"; seq: 0; streamID: string }
  | {
      type: "message.updated";
      seq: number;
      streamID: string;
      sessionID: string;
      messageID: string;
      role: "user" | "assistant";
      parentID?: string;   // assistant -> consumed user message (bounded)
      finish?: string;     // assistant finish reason, max 32 chars
      time?: { created?: number; completed?: number };
    }
  | {
      type: "message.part.updated";
      seq: number;
      streamID: string;
      sessionID: string;
      messageID: string;
      partID: string;
      partType: PartType;
      part: Record<string, unknown>;   // bounded snapshot; see 6.4
      truncated?: Truncation;
    }
  | {
      type: "message.part.delta";
      seq: number;
      streamID: string;
      sessionID: string;
      messageID: string;
      partID: string;
      field: "text";
      delta: string;
      partType?: "text" | "reasoning"; // present when the projector has seen the snapshot
    }
  | {
      type: "message.part.omitted";
      seq: number;
      streamID: string;
      sessionID: string;
      messageID: string;
      partID: string;
      partType?: PartType;
      reason: "too_large";
    }
  | {
      type: "session.status";
      seq: number;
      streamID: string;
      sessionID: string;
      status: {
        type: "idle" | "busy" | "retry";
        attempt?: number;
        message?: string;   // capped at 2,000 chars
        next?: number;
        action?: unknown;   // bounded JSON, at most 2 KiB serialized
      };
      truncated?: Truncation;
    };
```

Existing variants (`question.asked`, `question.replied`, `question.rejected`, `permission.asked`,
`permission.replied`, `todo.updated`, `stream.warning`) keep their payloads and gain
`seq`/`streamID` from the envelope. `session.activity` also gains an optional additive
`cause: "message" | "status" | "removed" | "unknown"` so the new client can ignore the compatibility
copies of typed events while still reconciling for removals/unknown types. `stream.warning` gains an
optional `sessionID` (best-effort for oversized frames) and `code` may be
`frame_too_large | invalid_json | delta_too_large`.

`session.idle` is normalized to `session.status {type: "idle"}`. The projector drops a consecutive
duplicate idle for the same session. This avoids two client branches for the same state.

`message.part.removed` and `message.removed` are **not** forwarded as new types in this stage: their
payload fields are not part of the verified contract. They fall through to `session.activity`, and
the client schedules a reconcile. This is deliberate and is listed as a risk, not an invented shape.

### 6.3 Projector rules

In `src/opencode/events.ts`, `EventProjector.project` gains:

| Upstream type | Hanse output |
| --- | --- |
| `message.updated` | `message.updated` when `properties.info.id` and `info.role` are valid; otherwise `session.activity`. Only `id`, `role`, `parentID`, `finish`, and `time.created`/`time.completed` are copied; `parentID` is bounded to 200 chars and `finish` to 32. |
| `message.part.updated` | `message.part.updated` when `part.id`, `part.type`, and `part.sessionID`/`part.messageID` exist; `partID` is `part.id`, and a mismatch is treated as activity. Otherwise `session.activity`. The part is bounded by 6.4. If bounding cannot get under the event cap, `message.part.omitted`. |
| `message.part.delta` | `message.part.delta` only when `field === "text"`, `delta` is a non-empty string, and the identity fields exist. Other fields are dropped (no invented delta kinds). `partType` is filled from a `Map<partID, type>` learned from `part.updated`, bounded to 5,000 entries. |
| `session.status` | `session.status` with the status object re-built from known keys and bounded. |
| `session.idle` | `session.status {type:"idle"}` unless it duplicates the last emitted status for that session. |

`session.activity` remains for backward compatibility on `message.updated` and `session.status`
(so an old tab still reloads at message granularity) with `cause: "message"` / `"status"`. It is also
emitted with `cause: "removed"` or `"unknown"` for the events folded into activity. It is **not**
emitted for `message.part.delta` or `message.part.updated`; emitting it per token/tool tick would
recreate the reload storm. Old tabs therefore do not stream, but still receive message-level updates.
The new client ignores `cause: "message" | "status"` and schedules one reconcile for
`removed`/`unknown` (or when `cause` is absent, for an older server).

Duplicate envelope IDs are still dropped by the existing `eventIds` set. The `askedKeys` prompt
de-duplication is unchanged.

Snapshot forwarding policy (server-side, before the caps):

- **text/reasoning:** track a per-part `sawDelta` flag.
  - If the part has emitted deltas, forward the first snapshot (prefix) and the completion snapshot
    (`time.end` is present); drop intermediate snapshots.
  - If it has **not** emitted deltas, forward throttled snapshots (at most one per 100 ms) and the
    completion snapshot. This covers snapshot-only growth without assuming the streaming path.
  - Snapshots over the 64 KiB text cap are omitted; deltas/completion/idle reconcile cover the text.
- **tool/other:** forward every status change (`pending` → `running` → `completed`/`error`) and the
  first running snapshot. While `state.status === "running"`, forward at most one snapshot per part
  per 100 ms (last-write-wins). Completion/error snapshots are never throttled.
- This is safe because snapshots are cumulative and the idle GET is authoritative. It prevents an
  O(n²) tool-output stream where every 10 ms snapshot repeats the whole output. The `sawDelta` and
  throttle maps are per connection and bounded (5,000 part IDs).

The throttle maps are per connection and bounded (5,000 part IDs); they are discarded when the
stream closes.

### 6.4 Bounds and truncation

All sizes are UTF-8 serialized bytes after normalization. The **app stream** must not use the default
1 MiB parser frame cap: a >1 MiB upstream `message.part.updated` would be dropped before the part caps
can apply, leaving no partial bash output. `streamAppEvents` calls
`createEventStream(body, {maxFrameBytes: APP_STREAM_MAX_FRAME_BYTES, ...})`; the default 1 MiB stays
for any other SSE use (the raw session proxy does not parse frames).

| Constant | Value | Rule |
| --- | --- | --- |
| `APP_STREAM_MAX_FRAME_BYTES` | 8 MiB | App-stream parser frame cap. Large enough for a full upstream bash/part snapshot to reach the projector. Memory/backpressure: the parser may hold up to this bound per open app stream; the writer already pauses on `drain`, and the cap is fixed, not cumulative. |
| `MAX_TYPED_EVENT_BYTES` | 256 KiB | Post-normalization budget for one typed app event (`message.part.updated`, `question.asked`, `permission.asked`, `todo.updated`, `session.status`). Enforced before serialization. |
| `MAX_DELTA_BYTES` | 64 KiB | Larger deltas are dropped and `stream.warning {code:"delta_too_large"}` is emitted once; the client marks the session for reconcile (debounced and at idle). |
| `MAX_TEXT_SNAPSHOT_BYTES` | 64 KiB | Text/reasoning snapshots larger than this are not forwarded; the client relies on deltas and the idle reconcile. |
| `MAX_PART_EVENT_BYTES` | 256 KiB | Target maximum for a `message.part.updated` frame after caps. If it still exceeds, emit `message.part.omitted`. |
| `MAX_TOOL_OUTPUT_BYTES` | 64 KiB | Running `bash` keeps the **last** 64 KiB of `state.metadata.output`; completed output keeps the **first** 64 KiB of `state.output`. The other is dropped. |
| `MAX_PATCH_BYTES` | 64 KiB | `patch` text (first 64 KiB); the rest is dropped and flagged. |
| `MAX_PART_STRING_BYTES` | 8 KiB | Any other string field (`state.input`, `title`, path, pattern, error). |
| `MAX_PART_ARRAY_ITEMS` | 200 | Arrays inside `state.input`/`state.metadata` (todowrite todos are already normalized to 200). |
| `MAX_STATUS_MESSAGE` | 2,000 chars | `session.status.status.message`. |
| `MAX_STATUS_ACTION_BYTES` | 2 KiB | `session.status.status.action`; oversized action is omitted, not partially parsed. |
| `MAX_MESSAGE_INFO_BYTES` | 8 KiB | The derived `message.updated` fields, including `parentID`; `finish` is capped at 32 chars. |
| `MESSAGES_RESPONSE_MAX_BYTES` | 8 MiB | Explicit cap for `listMessages` (`GET /messages`). Over cap → `502 messages_too_large`; the client keeps its last loaded feed and shows a non-blocking "Session too large to refresh" notice (or the thread error on first load). |

Oversized upstream frame (> 8 MiB) handling:

- The parser drops the frame. To make identity salvage possible, `SseParser` retains a bounded prefix
  (`IDENTITY_SALVAGE_PREFIX_BYTES`, e.g. 64 KiB) of the dropped frame and exposes it with the
  `SseWarning`. If that prefix yields `sessionID`, `messageID`, and `partID`, emit a synthetic
  `message.part.omitted` with `reason:"too_large"` for that part. Salvage is best-effort: `part.id`
  may appear after a large output in the JSON, so a prefix may not contain the identity.
- Otherwise emit **one** `stream.warning {code:"frame_too_large", sessionID?}` while the stream
  remains open. `sessionID` is included when the projector/route has a current session context for the
  connection (or a bounded prefix yields one); it is not invented. Warnings are deduped by
  `code + sessionID`, not by code alone, so a second session's `frame_too_large` is not suppressed.
- The client schedules a reconcile on that warning. A frame that exceeds 8 MiB cannot produce partial
  output because its JSON was never parsed; that is an explicit, bounded failure, not a silent cap.

Truncation algorithm for a tool/patch part:

1. Copy identity and control fields first: `id`, `sessionID`, `messageID`, `callID`, `type`,
   `tool`, `title`, `state.status`, `state.title`, `state.time`, and the text-part `synthetic`
   and `ignored` booleans (`synthetic` is required for OMO classification; `ignored` suppresses
   rendering).
2. Copy `state.input` with per-string and per-array caps (this preserves previews and todowrite).
   For `question`, preserve `state.input.questions` under the prompt caps (`MAX_HEADER_LENGTH`,
   `MAX_QUESTION_LENGTH`, `MAX_LABEL_LENGTH`, `MAX_OPTION_DESCRIPTION_LENGTH`) and up to 100
   questions/options instead of the generic 8 KiB/200 caps.
3. Copy `state.metadata` with the same caps, except `state.metadata.answers` (string[][], each string
   at most 2,000 chars, at most 100×100) and `state.metadata.todos`. If the resulting question event
   still exceeds 256 KiB, omit the part; the inline card falls back to the normalized prompt request
   (or the dock after reload).
4. Copy `state.output`/`state.error` under the output rule.
5. Copy `text`/`patch` under the text/patch rule.
6. Fill `truncated.fields` with the dotted paths that were shortened and `omittedBytes` with the
   dropped byte count.
7. If the serialized event still exceeds 256 KiB, emit `message.part.omitted` with
   `reason: "too_large"` and no part.

A truncated snapshot is renderable but is not authoritative for the truncated fields. The client
marks the part `partial` and reconciles at idle.

Prompt/Todo event budget (`MAX_TYPED_EVENT_BYTES`, applied to the whole serialized event after the
existing per-field caps):

- **`question.asked`:** if over budget, keep identity/`source`/`tool`, set `tooLarge:true`, set a
  bounded `tooLargeReason`, add a bounded `summary` (first header/question, 500 chars), and drop the
  `questions` payload. The existing dismiss-only too-large card renders the summary; answers cannot be
  aligned, so it is never answerable.
- **`permission.asked`:** if over budget, keep identity/`source`/`tool`/`permission`, set
  `tooLarge:true`, set a bounded `tooLargeReason` and `summary`, and drop `patterns`, `always`, and
  `metadata`. The permission dock renders a deny-only card ("Details too large to review safely"); no
  allow/always action is offered.
- **`todo.updated`:** drop trailing items until the event fits, set `truncated:true`; the Plan panel
  shows "List truncated". Existing 200-item/8,000-char caps still apply first.
- These `summary`/`tooLarge` fields are additive to the normalized prompt types. They are never
  persisted; they only guard the app-stream frame budget.

`GET /messages` is not an event and is not truncated: `listMessages` reads with an explicit 8 MiB cap
using the capped reader and `MESSAGES_RESPONSE_TIMEOUT_MS` (30 s) rather than the default 5 s read
timeout, so a large-but-valid response is not timed out by the cap path. Over cap returns `502
{code:"messages_too_large"}`; there is no partial-message JSON. The client keeps the last loaded feed
(or shows the thread error on first load) and surfaces "Session too large to refresh; showing the last
loaded state." Consequently the "full output at turn end" promise is conditional: the idle snapshot
replaces a truncated live tool view only when the whole message response fits the 8 MiB cap.

### 6.5 Sequence and gap handling

- Per connection, `seq` is strictly increasing. The client drops `seq <= lastSeq` for the same
  `streamID`.
- A new `streamID` resets `lastSeq` and triggers hydration.
- If `seq > lastSeq + 1`, the client records a gap, shows the existing `stream.warning` state, and
  schedules one debounced reconcile (500 ms) plus the idle reconcile.
- `stream.warning` with `frame_too_large`, `invalid_json`, or `delta_too_large` also marks the active
  session for reconcile. Warnings are not shown as a modal; they reuse the existing quiet warning
  channel so a degraded stream is still usable.
- `stream.ready` is not a message event; its `seq` is 0 and it always resets the connection state.

### 6.6 No new variants for queue or OMO

Queueing and OMO classification add **no** SSE fields or event types:

- Queued user messages arrive through `message.updated` and `message.part.updated`, exactly like any
  other user message. The queue is derived client-side from feed order (section 8.2).
- OMO system messages also arrive through the same message/part events. The classifier is client-side
  over the full message snapshot (section 9.10).
- The projector only needs identity/role/text/`synthetic` to be preserved for these paths. Keep the
  `synthetic` boolean on text parts in the bounded part snapshot; it is small and required for OMO
  classification. Do not forward OMO markers as a new server field.

## 7. Async send contract

### 7.1 Route

```http
POST /api/apps/:app/sessions/:sid/messages?async=1&project=<projectId>
content-type: application/json

{ "text": "hello" }
```

Success:

```http
202 Accepted
{ "accepted": true, "messageID": "msg_<32 hex>", "sessionID": "ses_..." }
```

The server:

1. Resolves the app and instance exactly like the blocking `/messages` route (`findApp`,
   `manager.ensure`).
2. Requires the existing principal model (same as `POST /messages`; no new auth rule).
3. Requires non-empty `text`, at most **32 KiB UTF-8 bytes** (`Buffer.byteLength(text, "utf8") <=
   32 * 1024`; the existing HTTP body cap is 64 KiB, so 32 KiB plus JSON overhead stays under it). A
   32 KiB+overhead body near the boundary is tested for both success and 413; multibyte text is
   measured in bytes, not characters.
4. Generates `messageID = "msg_" + randomUUID().replaceAll("-", "")`.
5. Calls upstream `POST /session/{sid}/prompt_async` with
   `{"parts":[{"type":"text","text":text}],"messageID":messageID}`.
6. Returns 202 only after upstream returns 204. It does **not** return 409 when the session is busy;
   the upstream queue accepts the prompt.

Without `async=1`, the route keeps the current blocking behavior and `{message}` response.

Errors:

| Status | Condition | Body `code` |
| --- | --- | --- |
| 400 | empty/invalid text | `empty_message` |
| 400 | text over 32 KiB UTF-8 | `message_too_large` |
| 401 | no principal | - |
| 404 | unknown app, or upstream 404 for the session | `unknown_app` / `session_not_found` |
| 502 | instance start failure, upstream 5xx | `agent_unavailable` (`outcome:"not_sent"`) |
| 502 | transport failure/timeout after the prompt may have been sent | `agent_unavailable` + `outcome:"unknown"`, `messageID`, `sessionID` |
| 502 | upstream 405 on `prompt_async` (route unavailable) | `async_unavailable` |
| 503 | runtime not configured | - |

There is no 409 `session_busy` path. A busy session is the expected queueing case, not an error. Any
other unexpected upstream 4xx (including a stray 409) maps to 502 `agent_unavailable`; the route
never synthesizes a 409.

The pinned upstream is 1.19.3, where `prompt_async` exists, so an upstream 404 is treated as a missing
session (`session_not_found`). A 405 is the explicit "route unavailable" signal. The design does
**not** silently fall back to the blocking route (because the blocking route would destroy optimistic
reconciliation). The legacy route remains available for callers that need a fallback.

Outcome semantics: a definitive HTTP error response (4xx, upstream 5xx, instance-start failure) means
the prompt was not accepted (`outcome: "not_sent"`). If the upstream fetch throws/timeouts after the
request may have been sent, the route returns 502 with `outcome: "unknown"`, `messageID`, and
`sessionID` (the ID was generated before the call). The client removes the optimistic row only for
`not_sent`; for `unknown` it keeps the row keyed by the returned `messageID`, shows "Delivery unknown;
checking…", and reconciles by ID before allowing another send. It never auto-retries an unknown
outcome.

### 7.2 Client flow

1. Trim. Block the send only when `allPendingForSession` has a blocking question/permission, an
   acceptance POST is already in flight, or an acceptance outcome is `unknown` and awaiting
   reconciliation. Do **not** block because `session.status` is `busy`; that is the queueing case.
2. Insert an optimistic user message immediately, keyed by `local_<uuid>`, with one text part and
   `optimistic: "sending"`. The row is in the feed before any network call.
3. Add the send to the session's short acceptance chain. The chain serializes `?async=1` POSTs so UI
   order equals server/upstream order; it is not a holding queue and it does not persist.
4. If the session is a draft, call `ensureSession`; adopt the optimistic row into the new session and
   keep its place in the chain.
5. `POST .../messages?async=1`.
6. On 202, rekey the optimistic message to `messageID` in one store mutation (its local part ID stays
   provisional until the upstream text part arrives), recompute the boundary, and set
   `optimistic: "queued"` only if the row is in `queuedIDs`. If it is the active head, set
   `activePromptID = messageID` and `optimistic: "accepted"`; if consumed, `accepted`. Release the
   acceptance slot for the next chained send.
7. On a definitive `not_sent` error, remove the optimistic row, release the acceptance slot, restore
   the draft only if the composer is still empty, show the inline error, and continue the chain.
8. On an `unknown` outcome, rekey the row to the returned `messageID`, set `optimistic: "unknown"`,
   show "Delivery unknown; checking…", and hold the session's acceptance gate. Every snapshot is
   applied and merges by ID. If the ID appears, adopt/resolve. If a snapshot confirms absence, wait
   `UNKNOWN_ACCEPTANCE_GRACE_MS` (5 s), then expose `Check again` and `Remove`; `Check again` performs
   one GET, `Remove` clears the local row/gate only. Never auto-retry; a later appearance resolves.
9. `message.updated`/`message.part.updated` for an accepted or hydrated user row recompute the
   boundary and `turnContinues`. The last visible assistant's `parentID` clears rows up to it and
   clears `activePromptID` when it reaches the head; a bare shell or an earlier `parentID` leaves
   later rows queued. `idle` finalizes and reconciles; it does not release a turn-long client lock.
   Refresh the sessions list once after 202 and once on idle (titles can change), using the signature
   guard.

If the HTTP response itself is lost (no 202 and no error body), the outcome is also `unknown` but no
server ID is available. The client keeps the temp row, reconciles, and matches a recent user message
with identical text in the same session before offering an explicit retry. It never auto-retries.

If user events for the server ID arrive before the 202, they are held in the pre-202 buffer; when the
202 maps the temp row to the server ID, the buffered events are applied to that node. No second
message is inserted.

The acceptance chain and the send gate are per session. A send in session A never blocks session B. A
paused stream does not silently drop the queue; the strip keeps the last derived queue and `Retry`
hydrates. Queued messages cannot be removed while busy (409 `SessionBusyError`); no remove control is
rendered.

### 7.3 Upstream client function

`src/opencode/client.ts` gains:

```ts
export function sendPromptAsync(
  endpoint: string,
  sessionId: string,
  text: string,
  messageID: string,
  options?: OpencodeRequestOptions,
): Promise<void>
```

It uses the existing `sendVoid` path (204, no JSON) and a 10 s timeout. It must not use the current
`call()` helper, which expects a JSON body.

## 8. Client data model and invariants

### 8.1 Store

```ts
interface PartRecord {
  id: string;
  type: PartType;
  data: Record<string, unknown>;   // bounded snapshot as received
  provisional?: boolean;           // created by a delta before a snapshot
  partial?: boolean;               // truncated snapshot or omitted event
  sealed?: boolean;                // set on session idle for text/reasoning
  version: number;
}

type OmoKind = "System reminder" | "Background task" | "Task result" | "Continuation" | "System";

interface OmoSystemMeta {
  kind: OmoKind;
  tone: "neutral" | "info" | "success" | "warning" | "error";
  headers: string[];       // extracted leading header lines, joined for the title
  title: string;           // headers.join(" · "), bounded
  body: string;            // markers stripped, system-reminder unwrapped
}

interface MessageRecord {
  id: string;
  role: "user" | "assistant";
  parentID?: string;       // assistant -> last consumed user message
  finish?: string;         // assistant finish reason, max 32 chars
  time?: { created?: number; completed?: number };
  optimistic?: "sending" | "queued" | "accepted" | "unknown";
  system?: OmoSystemMeta;  // derived, never persisted
  partOrder: string[];
  parts: Map<string, PartRecord>;
  needsReconcile?: boolean;
  version: number;
}

interface ThreadStore {
  sessionID: string | null;
  generation: number;
  turnGeneration: number;               // increments on send acceptance and busy/idle
  order: string[];
  messages: Map<string, MessageRecord>;
  activePromptID: string | null;        // current/active trailing operator row; never in queue
  queue: string[];                      // queued message IDs, chronological; derived, never persisted
  openParts: Set<string>;
  lastSeqByStream: Map<string, number>;
  currentStreamID: string | null;
  pendingDeltas: Map<string, string>;   // partID -> unapplied text
  agentStatus: AgentStatus;
  connection: "live" | "reconnecting" | "paused" | "connecting";
}
```

A single active session is materialized. Events for other sessions update only a small
`sessionRuntime` map used when switching; they never touch the feed DOM.

### 8.2 Update invariants

1. **Snapshot replaces.** A `GET /messages` response replaces `order`, `messages`, and parts
   atomically, increments `generation`, preserves `openParts` by part ID, clears `needsReconcile`,
   and recomputes the queue. Optimistic rows that have not been accepted are re-applied from the
   acceptance-chain map after the snapshot; accepted rows are matched by server message ID so the
   snapshot does not duplicate them.
2. **`message.updated` upserts.** It creates a shell if absent (role from the event) and updates
   role, `parentID`, `finish`, and time. It never clears parts.
3. **`message.part.updated` replaces the part snapshot.** If new, append its ID to `partOrder`. If
   `truncated` is present, set `partial`. If the type changed (for example a provisional text part
   becomes reasoning), replace that part's DOM node and re-apply its open state. Tool parts are
   sealed by their `state.status`. **Snapshot sealing:** on hydration/boot/reconnect, seal every
   text/reasoning part whose message has `time.completed`; leave only the last uncompleted assistant
   message's text/reasoning parts unsealed. If the snapshot has no running tool and the last assistant
   is complete, seal all parts. Idle still seals all parts as a backstop (8.4).
4. **Deltas append; snapshots win.** `message.part.delta` applies only to `field === "text"` and only
   to a `text`/`reasoning` part or a provisional part. If the part is missing, create a provisional
   `text` part with empty text, then append. If `sealed`, ignore. When a `message.part.updated`
   snapshot is applied, set the part text to the snapshot text and **clear `pendingDeltas` for that
   part** (deltas already included in the snapshot must not be appended twice). Deltas that arrived
   after the snapshot generation but before it was applied are dropped; the next snapshot/completion
   or idle reconcile recovers them. It never creates a second part for an existing ID.
5. **Hydration always applies the snapshot; content is not replayed.** Hydration captures
   `turnGeneration` (incremented on send acceptance and on `busy`/`idle`) and the acceptance state.
   Buffered content events are discarded; only the last buffered `session.status` is replayed. The
   fetched snapshot is **always applied**, even for a `sending`/`unknown` acceptance or a changed
   turn generation. Local optimistic rows merge by server message ID: if present, adopt the server
   row and derive accepted/queued; if absent, keep the local row. If `turnGeneration` changed during
   the GET, schedule one follow-up GET after the turn settles; do not discard the history and retry
   from scratch. Events that arrive after the GET was generated but before it is applied are covered
   by the buffer discard + early 500 ms reconcile, not replayed.
6. **Unknown part type.** Mark the message `needsReconcile`, render a neutral placeholder, and
   schedule one reconcile. Never loop.
7. **Ordering.** Snapshot order is authoritative. Live messages append at the end. Live parts append
   in first-seen order; a later snapshot replaces the part but keeps its position. A transient
   first-seen misorder is corrected on idle/reconnect.
8. **Unknown message for a part.** Create an assistant shell for the message ID, then attach the
   part. The optimistic user row is always inserted before assistant rows for its turn.
9. **Duplicate events.** Drop `seq <= lastSeq` for the current `streamID`; drop duplicate part deltas
   with the same (partID, delta) only when the sequence check cannot be used (defensive).
10. **Omitted/partial part.** Set `partial`, render what is available, and reconcile at idle (and
    once early for an omitted part). Never present a truncated tool output as complete.
11. **Optimistic user text is reconciled once.** While a user message is `sending`, `queued`,
    `accepted`, or `unknown`, its local text part is a placeholder. The first `message.part.updated`
    of type `text` for that message ID replaces the placeholder in the same DOM position and adopts
    the upstream part ID; further user text parts append. The client never renders two copies of the
    prompt. A delta for a user part is ignored while the placeholder exists.
12. **Pre-202 user events are buffered.** While a send is `sending` and the server ID is unknown,
    buffer incoming `message.updated`/`message.part.updated` events with `role: "user"` for that
    session. On 202 (or on the `unknown` 502 that returns `messageID`), rekey the temp row and apply
    the buffered events whose `messageID` matches; apply leftover events normally. This prevents a
    second user row and a flicker when upstream beats the HTTP response.
13. **Queue is derived from feed order, `parentID`, and turn state.** After any `message.updated`,
    part update that establishes a message, optimistic row rekey, snapshot, or session switch,
    recompute `{activeID, queuedIDs, turnContinues}`:
    - find the last assistant message with at least one visible part (ignore bare shells);
    - mark operator rows up to and including its usable `parentID` processed; if `parentID` is
      absent/unusable, use the assistant's feed position as the boundary;
    - rows after the boundary (or from the feed start if no visible assistant) are pending;
    - `turnContinues = lastVisibleAssistant !== null && (time.completed absent ||
      lastVisibleAssistant.finish === "tool-calls")`, overridden to false when
      `session.status.type === "idle"`;
    - if `turnContinues`, every pending row is `queuedIDs` and `activeID = null`;
    - otherwise, `activeID` = tracked `activePromptID` if it is still pending, else the first pending
      row; rows after it are `queuedIDs`. Adopt the derived head as `activePromptID` only when no
      tracked ID exists;
    - clear `activePromptID` when the assistant `parentID` reaches it or it leaves pending;
    - skip OMO system rows and rows whose OMO classification is still pending; include optimistic
      `sending`/`unknown` rows.
    `queue` stores only `queuedIDs`; the strip and `N queued` never include `activeID`. A message's
    `optimistic` state is presentation only: `sending` before 202; `queued` when in `queuedIDs`;
    `accepted` when it is `activeID` or consumed by `parentID`; `unknown` for an unresolved outcome.
    `queued` is never persisted and is reproducible from a snapshot. `parentID` is the processing
    boundary; assistant completion alone is not an idle signal.
14. **OMO classification is per message snapshot.** After a user message's parts are known (first
    text part or snapshot), compute `system` with the 9.10 classifier. Do not classify from a single
    streaming delta; wait for at least one complete text snapshot or the idle snapshot. System
    messages never enter `queue`, never get operator styling, and are not announced as operator
    messages. Recompute the queue after classification (a newly classified system row must leave the
    queue immediately). Classification is recomputed on snapshot replacement; the marker/synthetic
    flag makes it stable.
15. **No server queue/OMO event.** No new SSE variant is required. The client must not expect a
    `session.queue` or `message.system` event; both are derived locally from the existing events.
16. **Unknown acceptance resolves through snapshots, not deadlock.** Keep the local `unknown` row and
    the send gate after the snapshot. If the server ID appears in a live event or snapshot, adopt it
    and resolve (accepted/queued). If a snapshot confirms absence, start
    `UNKNOWN_ACCEPTANCE_GRACE_MS` (5 s); after the grace, expose explicit `Check again` and `Remove`
    actions. `Check again` performs one GET; `Remove` clears the local row/gate without deleting any
    server message. No auto-retry; a later appearance resolves automatically.

### 8.3 Hydration and reconnect

`hydrateMessages({reason})`:

1. Increment `hydrationSeq`; capture `startSeq = lastSeq`, `turnGen = turnGeneration`, and the
   per-session acceptance state.
2. Set `hydrating = true`; buffer typed message/status events in a log capped at 200 events or
   256 KiB.
3. `GET /messages` for the target session. If it fails with `messages_too_large`, keep the last
   loaded feed and show a non-blocking "Session too large to refresh; showing the last loaded state"
   notice (on first load, the thread error). Do not retry in a loop; a manual Retry may run once.
4. If a newer hydration started, discard this response.
5. **Always apply the snapshot**, even if a send is `sending`/`unknown` or `turnGeneration` changed.
6. Merge local optimistic rows by server message ID: if present, adopt the server row and derive
   accepted/queued; if absent, keep the local row. Buffered message content is **discarded**, not
   replayed: a buffered `message.part.updated` can be older than the GET snapshot and would regress
   it. Live events resume after hydration. Apply snapshot sealing (8.2 invariant 3).
7. Replay only the last buffered `session.status` per session with `seq > startSeq`, if any.
8. If the log overflowed, discard the buffer and re-fetch once.
9. Unknown acceptance: if the server ID is in the snapshot, adopt/resolve; if absent, start the 5 s
   grace and expose `Check again`/`Remove` after it (invariant 16).
10. If `turnGeneration !== turnGen`, schedule one follow-up GET after the turn settles; do not discard
    the applied snapshot or retry the history from scratch.
11. Re-derive status from the snapshot (section 9.5), recompute the queue (8.2 invariant 13),
    reclassify OMO system messages (9.10), re-correlate inline questions, and render.
12. If any content events were discarded, schedule one early reconcile (500 ms) in addition to the
    idle reconcile. This bounds the lost-gap window without risking duplicates. Events that arrive
    after the GET was generated but before it is applied are in this discarded set.
13. Clear `hydrating`; schedule a scroll restore.

Reconnect (`stream.ready` with a new `streamID`) runs `hydrateMessages` plus the existing prompt/todo
hydration. A session switch does the same with a hydration-sequence guard, then resets the feed DOM.

### 8.4 Idle reconcile

On `session.status idle` for the active session:

1. Stop the elapsed timer; seal text/reasoning parts per 8.2 invariant 3. Do not clear queued rows
   here; only the queue recompute does that.
2. Capture `turnGen = turnGeneration`; finalize streaming text render (one markdown pass), then
   debounce 200 ms and `GET /messages`.
3. Always apply the snapshot and merge optimistic rows by server ID; if absent keep the local row.
   If `turnGeneration !== turnGen`, schedule one follow-up GET after the turn settles. Unknown rows
   follow invariant 16 (5 s grace, then `Check again`/`Remove`).
4. Preserve `openParts` and scroll; apply snapshot sealing.
5. Recompute the queue (`parentID` + `turnContinues`), re-correlate questions, reclassify OMO
   messages, and refresh the session-list signature.

This is the correctness backstop for dropped deltas, truncated outputs, and transient ordering. It is
one GET per turn, not per token.

## 9. Web UI contract

### 9.1 Feed layout

At `>= 1024px`:

```css
:root {
  --chat-feed-ratio: 75%;
  --chat-feed-min: 60ch;
  --chat-feed-max: 96rem;
}

/* Shared content box for feed and composer. */
.chat-thread__inner,
.composer__row,
.composer__hint {
  inline-size: min(100%, max(var(--chat-feed-min), var(--chat-feed-ratio)));
  max-inline-size: var(--chat-feed-max);
  margin-inline: auto;
}
```

- Below 1024px all three are `inline-size: 100%; max-inline-size: none`.
- `.chat-thread__scroll` and `.composer` use the same horizontal padding (`--space-6` at >= 768,
  `--space-4` below), so the feed and composer share one content box. Below 768 the composer keeps
  its existing `--space-2` vertical padding and adopts `--space-4` horizontal padding to match the
  feed.
- `.message__body` is `max-inline-size: 100%`. Assistant prose children (`p`, `ul`, `ol`,
  `blockquote`, `h3`-`h5`) are capped at `--reading-measure` (68ch). Tables, `pre`, and tool bodies
  use the full feed width. User message bodies stay at `min(100%, 68ch)` so a bubble does not become
  a full-width band.
- The permission/question dock above the composer keeps its existing 76ch card. Inline question cards
  live inside the feed and are capped at 76ch for readability.
- Mobile keeps `--space-4` feed padding, 44px controls, and no horizontal page scroll. Table wrappers
  scroll horizontally inside the feed.

Derived ratios (shared content box, 15px chat text; `60ch` is a floor, `96rem` a cap):

| Viewport | Layout state | Thread content width | Feed width | Ratio |
| --- | --- | --- | --- | --- |
| 1024 | sessions + context drawer closed | ~720px | ~540px | ~75% |
| 1440 | sessions + context open | ~584px | ~510px (60ch floor) | ~87% |
| 1920 | sessions + context open | ~1064px | ~798px | ~75% |

The ratio is measured against the padded content box, not the pane border; the 1440 case is
floor-driven and is expected to exceed 75%.

### 9.2 Message and part rendering

Each message is an `<article class="message" data-message-id="...">`; each part is a keyed child
with `data-part-id` and `data-part-type`. The renderer:

- reuses the existing `.message__meta` role label and timestamp;
- inserts a message shell only once it has a visible part (a `message.updated` with no parts yet is
  stored, not rendered); the first visible part inserts it at the end of the feed;
- classifies a complete user-message snapshot as OMO/system before choosing the row style; system
  rows use `.message--system` and the 9.10 card, never the operator avatar or user bubble;
- renders each non-`ignored` text part as its own `.message__body` in part order (multiple text parts
  are allowed); `ignored: true` text is not rendered but is still available to OMO classification;
- renders tool/reasoning/patch parts at their part positions;
- never uses `innerHTML`; agent content is `textContent` or the safe markdown DOM;
- keeps `details[open]` state in `openParts`, not by querying the DOM;
- uses `message--optimistic` with `data-state="sending"` for the immediate user row; on failure the
  row is removed rather than left with a fake timestamp.

`renderMessages` becomes `applySnapshot` + `patchMessage` + `patchPart`. `replaceChildren` is used
only for the empty state, the error state, and a session switch.

### 9.3 Markdown

Keep the existing block parser (paragraphs, headings, lists, blockquote, fenced/inline code,
strong/em, http(s) links, rules) and add GFM pipe tables:

1. A table starts when the current line contains an unescaped `|`; the next line is split into
   candidate delimiter cells.
2. Split cells on unescaped `|`, ignoring pipes inside backtick code spans. Trim cells. Leading and
   trailing pipes are optional.
3. Every delimiter cell must match `^:?-+:?$` (**one or more** dashes, GFM), and the header and
   delimiter cell counts must be equal. Otherwise the block is not a table (for example a prose line
   containing `|` followed by a delimiter-looking line). A one-column table is valid when both lines
   carry pipes (`| a |` / `| - |`).
4. Header cell count is the delimiter count. Body rows are padded with empty cells or have extra
   cells ignored (never shifted); body-row count may differ from the header.
5. Build `<div class="message__table-wrap" tabindex="0" role="region" aria-label="Table"><table
   class="message__table"><thead><tr><th scope="col" data-align="left|center|right">…`. Alignment
   comes from the delimiter colons and is applied with `data-align` CSS, not inline styles.
6. Render each cell with `renderInline` (code, strong, em, links). No block content, images, or raw
   HTML inside cells.
7. Caps: at most 16 columns, 200 body rows, and 2,000 characters per cell. If the column cap is
   exceeded, do not treat the block as a table; render the lines as paragraphs. If the row cap is
   exceeded, render the first 200 rows and a `.message__table-note` "Table truncated to 200 rows."
8. A partial stream renders a table only once the delimiter row is present. While streaming, the
   table body is re-rendered at the markdown throttle; on completion/idle it is rendered once more.
   Fixtures: escaped pipes, code spans containing pipes, ragged body rows, one-column/one-dash, and a
   prose line with a pipe followed by a delimiter-looking line (must not become a table).

Tables use the existing type scale and tokens: header overline weight, `--line` rules, `--inset`
header background, numeric cells `font-variant-numeric: tabular-nums` when the alignment is right.

### 9.4 Tool rendering

One `.tool-call` `<details>` remains the container. Summary children: glyph, mono tool name,
one-line preview, status chip, optional elapsed while running. `details.open` is restored from
`openParts`; errors auto-open on first render and stay open unless the user closes them.

One-line preview rules (first match wins; first line only, whitespace collapsed, max 120 characters,
`title` carries the full value, never output text):

| Tool | Preview source |
| --- | --- |
| `bash` | `state.input.command`; fallback `state.title`/`part.title`; no cwd (not provided). |
| `read` | `state.input.filePath` or `state.input.path`; no line range (not provided). |
| `write`, `edit` | `state.input.filePath` or `state.input.path`. |
| `grep` | `state.input.pattern`, plus `in <path>` when a path exists. |
| `glob` | `state.input.pattern`. |
| `webfetch` | `state.input.url`. |
| `websearch` | `state.input.query`. |
| `task` | `state.input.description`, else the agent/subagent name. |
| `todowrite` | `N of M done` plus `· K now` when an item is in progress; `No tasks` when empty. |
| `question` | `Question · N waiting` or `Answered`; the card below carries the detail. |
| generic | `state.title`/`part.title`, else the first scalar string in `state.input`, else the tool name. |

These are presentation heuristics over optional `state.input` fields (the current `toolPath` helper
already uses `command`/`filePath`/`path`/`pattern`/`url`). The verified title is `state.title`;
`part.title` above is only an optional compatibility fallback for older payloads. Missing fields fall
through; no preview depends on a field the verified contract does not provide. If
`part.ignored === true`, do not render the text part, but still include it in OMO classification.

Body rules:

- **bash (streaming):** while `state.status === "running"`, render `state.metadata.output` (tail,
  capped by 6.4) as `<pre class="tool-call__output">`; if absent, show `Waiting for output…`. On
  completion, use `state.output` first, then `metadata.output`, then `No output`. Follow the bottom
  of the `<pre>` only while the user has not scrolled it up (`scrollHeight - scrollTop - clientHeight
  < 24`). Show `Running` with elapsed from `state.time.start`.
- **todowrite:** read-only `.tool-todo` list. Items come from `state.input.todos` while running and
  `state.metadata.todos` when completed. Status glyph + text (`Pending`, `Now`, `Done`, `Dropped`,
  `Unknown`); only the first `in_progress` item gets `aria-current="step"`. Priority reuses the
  existing 3-tick meter treatment with a visually hidden label.
- **question:** do not render a generic tool body; section 9.6 owns it.
- **patch / file / subtask:** generic details with a preview and `<pre>` text; a `patch` with a diff
  string or file list uses the syntax-highlighted diff/file-list renderer from
  [chat-diff-highlighting.md](./chat-diff-highlighting.md).
- **edit / apply_patch / write:** completed `edit` and `apply_patch` diffs use the
  syntax-highlighted unified-diff renderer; `write` renders syntax-highlighted content with a path
  and line count. If no diff/content source exists, fall back to preview + `<pre>`.
- **read:** a completed `read` with opencode's `<path>/<content>` XML renders as a structured
  syntax-highlighted block: path, XML line numbers, code, and the status line in a footer. Errors,
  running parts, and malformed output keep the preview + `<pre>` fallback.
- **grep/glob/webfetch/websearch/generic:** preview + `<pre>` for `state.output`, `state.error`, or
  the best available string.
- **step-start, step-finish, retry, compaction, snapshot, agent:** hidden (internal bookkeeping);
  `retry` is represented by the status model instead.
- Truncation notices are field-aware and follow
  [chat-diff-highlighting.md](./chat-diff-highlighting.md) §5.5. Diff, content, patch, file, line,
  live, snapshot, and omitted cases use their exact strings; never promise the full result
  unconditionally.
- Reasoning renders with label `Thinking` (mono summary), collapsed by default, no preview. Its body
  is the reasoning text in `<pre>`; it uses the same `.tool-call` disclosure and open-state keying as
  other parts.

### 9.5 Status model

Two separate elements:

- `.chat-live` (connection): `Connecting`, `Live`, `Reconnecting`, `Paused`. Existing
  `Starting agent...` remains for boot.
- `.chat-working` (agent): spinner (except `Ready` and `Paused`) plus a label and an `aria-hidden`
  elapsed span. The label is a `role="status" aria-live="polite" aria-atomic="true"` node; the
  elapsed is not. The `· N queued` suffix is a separate `.chat-working__queued` span with
  `aria-hidden="true"`; the queue strip count is the single live source for count changes, so a queue
  update is not announced twice.
- `Waiting for you` keeps the existing `.chat-waiting` stamp element (now `role="status"
  aria-live="polite"`); `.chat-working` is hidden while it is visible, so only one agent-status live
  region is in the accessibility tree. The elapsed freezes and is hidden with `.chat-working`.
- `#chat-runtime` remains the app instance runtime pill (running/stopped/error) and is not reused for
  agent status.

Precedence (first match wins):

| # | Condition | Label |
| --- | --- | --- |
| 1 | A question or permission is pending in the active session | `Waiting for you` |
| 2 | An acceptance POST is in flight and the newest row is not accepted yet | `Sending` |
| 3 | Connection paused and the turn is active | `Paused` |
| 4 | `session.status` is `retry` | `Retrying` |
| 5 | Latest running tool part exists | `Running <tool>` (humanized: `bash`, `edit`, `fetch`, `search`, `plan`, ...) |
| 6 | Reasoning is streaming, or busy with no running tool and no streaming text | `Thinking` |
| 7 | Busy with streaming assistant text | `Working` |
| 8 | Idle (or a snapshot with no running part) | `Ready` |
| 9 | No status yet | `Ready`, unless a send/queue is pending → `Working` |

Queue suffix: `queue` is the queued-only set (never the active prompt). When `queue.length > 0` and
the base label is `Thinking`, `Working`, `Running <tool>`, `Retrying`, or `Ready`, render
`· N queued` in `.chat-working__queued`
(`Working · 2 queued`,
`Running bash · 1 queued`, `Thinking · 3 queued`, `Ready · 1 queued`). Do not append it to
`Waiting for you`, `Sending`, or `Paused`. The suffix never changes the base label; in particular, a
busy session with queued prompts but no streaming text remains `Thinking`/`Working` according to the
current turn, not `Thinking` because of the queue. `Sending` is used only while an acceptance POST is
in flight, not for queued-but-accepted prompts.

Elapsed starts when the send is accepted (or on the transition to busy) and ticks once per second;
it is hidden below 1 s and formatted `Ns` then `Nm SSs`. It freezes while `Waiting for you` and resets
on `Ready`. The timer updates only the elapsed text node; it never re-renders the rail or feed. When
status is derived from a snapshot, use the earliest running part's `time.start` (or the assistant
message's `time.created`) as the start; if neither exists, omit elapsed rather than guess.

On boot/reconnect, derive the label from the **sealed** snapshot rather than waiting for an idle
event: seal text/reasoning parts of completed messages, leave only the last uncompleted assistant
message's parts unsealed (8.2 invariant 3), then use running tool → `Running <tool>`; unsealed
reasoning → `Thinking`; unsealed text → `Working`; otherwise `Ready`. If the snapshot has no running
tool and the last assistant is complete, every part is sealed; derive `Ready` only when
`session.status` is also idle (or absent) and no `activePromptID` is pending. An active
`session.status` (`busy`/`retry`) outranks the sealed snapshot: show `Thinking`/`Working` until the
turn ends. A snapshot with no running part clears only stale resolved turn state; it never clears an
in-flight acceptance or an `unknown` outcome (8.2 invariant 16). It does not discard queued user
messages, which remain visible because they are trailing operator rows.

### 9.6 Inline questions and Q&A

Correlation:

```text
questionKey      = `${source}:${request.id}`                       // reply/tombstone key, unchanged
correlationKey   = `${source}:${sessionID}:${messageID}:${callID}` // render key
```

A `question` tool part is identified by `part.type === "tool" && part.tool === "question"` and by
matching `part.messageID`/`part.callID`. The request supplies `tool.messageID` and `tool.callID`;
both must be non-empty strings; if either is missing, the request has no valid tool ref and uses the
dock (9.6 placement).

Card states:

| State | Condition | UI |
| --- | --- | --- |
| `preparing` | Request has a valid tool ref, part not seen yet | Inline card at the feed end with "Preparing request…"; controls are request-backed when the request is present, otherwise the tool-part questions are read-only. |
| `part-unavailable` | Request has a valid tool ref, but the part is missing/omitted after hydration | Inline card at the feed end with "Question part unavailable"; answer controls from the request remain available. |
| `pending` | Request open, part running | Interactive card (existing question controls). |
| `answered` | Part completed (answers from `state.metadata.answers`; fallback `state.output`) | Read-only Q&A: each question plus `answers[i].join(", ")`, or "No answer"; if neither answers nor output exist, "Answer detail unavailable". |
| `dismissed` | `question.rejected` tombstone and no answers | Read-only "Dismissed" with the question text. |
| `expired` | Request missing after hydration and not answered/dismissed | Read-only "Request no longer pending" until the part/GET confirms a terminal state. |
| `tooLarge` | `request.tooLarge` | Dismiss-only card showing `summary` (if present) and `tooLargeReason`; never answerable. |
| `stale` | Stream paused | Modifier: keep controls; header says "Not updating". |

State precedence (first match): terminal `answered`/`dismissed`/`expired` win over `tooLarge`, which
wins over `part-unavailable`, then `preparing`, then `pending`. `stale` is a modifier applied to the
chosen state, not a separate state. `tooLarge` is never answerable, even when the request is still
pending and its tool part is running.

Placement:

- The card is a child of the message/part position. If the request arrives before the part, render a
  placeholder keyed by `correlationKey` at the end of the feed; move the same DOM node when the part
  arrives. If the part never arrives (omitted/mismatch), keep that node as `part-unavailable`; never
  move it to the dock and never create a second card.
- Multiple pending questions render in part order. The top-bar/per-session counts use
  `allPendingForSession` (inline included) and still navigate to the session; navigating to a
  correlated question scrolls its inline card into view and focuses its heading or first control.
- Any request with a valid `tool` ref renders inline. The dock renders only requests **without** a
  tool ref (plus permissions), so one request never has two controls. Permissions never move into the
  feed.
- Split the two pending sets:
  - `allPendingForSession(id)` = every pending question (inline + dock) and permission. It drives the
    composer gate, `Waiting for you`, per-session flags, active-session counts, Escape handling, and
    Ctrl/Cmd+Enter. The top-bar "needs input" count stays filtered to other sessions
    (`entry.sessionID !== activeSession`), as today; it must not count the active inline question a
    second time.
  - `dockRenderEntries(id)` = uncorrelated questions + permissions only. It drives
    `renderPromptDock`.
  - `focusRequest()` targets the oldest pending inline card first, then the dock, then the composer.
  Correlated inline questions still block sending and respond to the global keyboard handlers; they
  are not invisible to the gate just because they are not in the dock.

DOM and interaction:

- Root: `<article class="chat-question" data-question-key data-correlation-key data-state>`, reusing
  `.prompt-question`, `.prompt-option`, `.prompt-custom`, `.prompt-confirm`, and
  `.prompt-dock__foot` inside. New classes are only the container and the read-only answers:
  `.chat-question`, `.chat-question__answers`, `.chat-question__answer`,
  `.chat-question__answer-label`, `.chat-question__answer-value`, `.chat-question__state`.
- Refactor the existing `buildQuestionDock`/`buildQuestionField`/`renderTabs`/`syncQuestionChrome`/
  `focusOption` helpers to accept a scope root and an id prefix. The dock and the inline card then
  share one implementation instead of forking the question UI.
- Option/checkbox changes patch the affected controls and the primary label; they do not replace the
  card (so focus and the custom draft survive). Capture the focused control's index/label before a
  patch and restore it after.
- In a block with more than one question, selecting an option on a **single-select** question
  (`multiple !== true`) immediately advances: `draft.index += 1`, or `draft.index = steps` (Review)
  after the last question. Focus moves to the next question's first input (radio/checkbox/custom),
  its heading if it has no input, or the Review primary/heading. Announce `Question N of M` for the next question and
  `Review` when advancing to Review, once per user action, via `#chat-announcer`.
- Multi-select questions never auto-advance; the operator uses Next/Review. A single-question block
  never auto-submits on selection. Auto-advance is skipped while composing and when an inline
  confirmation is open. Selecting an option while editing from Review advances forward from that
  question, not back to Review; Back remains available. Existing empty-answer confirmation and
  dismissal rules are unchanged; auto-advance never opens or confirms them.
- `id` attributes are unique per request (`chat-question-<short request key>-...`); the dock keeps its
  existing fixed ids. Tabs use roving tabindex with unique `aria-controls`.
- Reply routes are unchanged: `POST /api/apps/:app/questions/:id/reply` with `{source, answers}` and
  `/reject`. Tombstones remain keyed by `questionKey`.
- `question.replied` carries **no answers**. If this client submitted the reply, transition
  immediately using the local draft answers (optimistic Q&A). If the event came from another tab or
  arrives before the completed part, show "Answered elsewhere" without answer values until the
  completed part snapshot or a GET supplies them.
- Authoritative Q&A values render only from the completed part's `state.metadata.answers` (fallback
  `state.output` when answers are absent). A local submit may show its own draft answers
  optimistically in the meantime; never render answers from the `question.replied` event.
- Q&A rendering pairs `state.input.questions[i]` with `state.metadata.answers[i]` for
  `i < min(lengths)`. If the arrays do not align, render `state.output` as plain text and a small
  note "Answer detail unavailable"; never shift an answer onto the wrong question.

### 9.7 Keyboard and focus

- Composer: Enter sends, Shift+Enter inserts a newline, Ctrl/Cmd+Enter sends. Unchanged.
- Question custom input: Enter (without Shift, not composing) triggers the current step's primary
  action exactly once:
  - multi-step, not last: `Next`;
  - last step needing review: `Review`;
  - final step: `Send answer` (which may open the existing "Send without answering?" confirmation);
  - for multi-select, the custom answer is included in the current selection before advancing;
  - if a confirmation is already open, Enter does nothing; the explicit button must be pressed.
- Selecting a single-select option in a multi-question block advances immediately (9.6), focuses the
  next question, and announces `Question N of M`. Multi-select and single-question blocks do not
  auto-advance/submit on selection.
- Ctrl/Cmd+Enter on a question card triggers the primary action from anywhere in the card (existing
  behavior, extended to inline cards).
- Escape cancels an inline confirmation/step first, then closes queue/drawers. It never rejects.
- On success/expiry/dismiss, if focus was inside the removed card, move it to the composer. Otherwise
  preserve focus. Never steal focus when the composer has a draft.
- After a question card moves (placeholder → part position), preserve focus and the draft.

### 9.8 State inventory

Existing states are preserved unchanged unless named here:

| Surface | States |
| --- | --- |
| Thread | initial skeleton, empty ("Send a message to start a session."), draft, messages, loading a session, thread error with Retry. |
| Sessions | loading skeleton, empty, filtered empty, error with Retry, creating, deleting, selected/draft. |
| Stream | `Starting agent...`, `Live`, `Reconnecting`, `Paused` + Retry. |
| Agent | `Sending`, `Thinking`, `Working`, `Running <tool>`, `Waiting for you`, `Ready`, `Retrying`, `Paused` (connection-paused with an active turn), plus `· N queued` on non-waiting labels when the queue is non-empty. |
| Optimistic message | `sending` (subdued), `queued` (beyond the active/consumed boundary), `accepted` (active or consumed; normal), `unknown` ("Delivery unknown; checking…" until reconciled), removed on a definitive failure. No "failed bubble"; the draft and inline error are the recovery surface. |
| Tool | pending, running (bash output following), completed, error (auto-open), truncated (`tool-call__truncated`), omitted ("Output too large for live view"). |
| Question | `preparing`, `part-unavailable`, `pending`, `answered`, `dismissed`, `expired`, `tooLarge`, `stale`. |
| Permission | normal, `tooLarge` (deny-only, no allow/always), stale. |
| Plan / saved permissions / policy warnings / top-bar prompt-request queue | Unchanged from the interactive-prompts stage; Plan shows `List truncated` when `truncated`. |
| Send queue | `sending` (POST in flight), `queued` (beyond the active/consumed boundary), `accepted` (active or consumed), `unknown` (delivery unresolved); strip count/preview list excludes the active prompt; hidden when empty. |
| OMO system card | neutral/info/success/warning/error tone; short inline body or collapsible long result. |
| New messages | Floating button only when `order` grows while away from the bottom. |

### 9.9 Queue strip

Placement and geometry:

- The strip is an in-flow row **above the prompt dock**, between the feed viewport and the dock. When
  the dock is hidden it sits directly above the composer. This keeps the actionable question/
  permission controls adjacent to the composer and gives the informational queue its own stable row.
- In the chat grid, add a `chat-queue-strip` row before `prompt-dock`; `grid-template-rows` becomes
  `auto auto auto minmax(0, 1fr) auto auto auto`, and the explicit `grid-row` pins become queue = 5,
  dock = 6, composer = 7.
- The strip is hidden when `queue.length === 0`. It is one compact line (wrapping only at very narrow
  widths), with a count chip and one-line previews; it never overlays the feed and never scrolls the
  page. Markup: `<div class="chat-queue-strip"><span class="chat-queue-strip__count" role="status"
  aria-live="polite">…</span><ol class="chat-queue-strip__list"><li class="chat-queue-strip__item">
  <span class="…__preview">…</span><span class="chat-queue-strip__state">Queued</span></li>…</ol></div>`.

Contents:

- `queue` is `queuedIDs` from 8.2. It never contains the active head (`activePromptID`) and excludes
  OMO system messages. When `turnContinues` is true there is no active head; every pending row is in
  the strip (including the newest prompt sent during a multi-step turn).
- Count = `queue.length`; the head is not counted. A server/hydrated row in `queue` renders `Queued`
  even without an optimistic flag; local flags add `Sending…`/`Delivery unknown`. Previews use the
  optimistic text or the first text part; if neither is available, render `Queued message`. Previews
  are the first line, whitespace-collapsed, max 120 characters; `title` carries the full first line.
- Show up to 3 previews; if more, append `+N more`. On mobile the preview list scrolls horizontally
  inside the strip; no page overflow.
- Row state text: `Sending…` before acceptance, `Queued` after acceptance, `Delivery unknown` for an
  unresolved outcome. The strip never shows operator avatars, bubbles, or internal markers.
- No remove/cancel control. `DELETE /session/:sid/message/:mid` returns 409 while busy; a future local
  outbox is a separate stage.
- The strip clears a row when the last visible assistant's `parentID` reaches it (processed), not
  merely because any assistant message exists. Bare assistant shells do not clear the strip. The strip
  also clears/recomputes on session switch/snapshot replacement.

Accessibility:

- The count chip is `role="status" aria-live="polite" aria-atomic="true"`; previews are not a live
  region. Announce only count changes (for example `2 messages queued`), not token or text changes.
- The strip is non-interactive (no tab stops), so it does not add keyboard noise. If a future version
  makes previews clickable, they must be real buttons with labels.

### 9.10 OMO system cards

Classification (client-side, per complete message snapshot):

```text
isOmoSystem(message) =
  message.role === "user"
  && textParts.length > 0
  && textParts.every(p => p.synthetic === true
       || /<!--\s*OMO_INTERNAL_INITIATOR\s*-->/.test(p.text))
```

- Only text parts are considered, matching OMO's `isSyntheticOrInternalUserMessage`. Non-text parts do
  not disqualify a message if every text part is synthetic/marked.
- Classification waits for at least one complete text snapshot (or the idle snapshot); it is not done
  from a delta. A user row from history/snapshot is classified before insertion. A live user row
  buffers its text parts until a 100 ms quiet period after the last part (or idle), then classifies;
  this avoids the common operator flash but is not a proof for every multi-part arrival order. If a
  later text part changes the `every()` result, reclassify and swap the row style in place. If the
  first text snapshot is omitted by the 64 KiB cap, classification happens at the idle reconcile. It
  is recomputed on snapshot replacement and hydration. Optimistic local rows are always operator rows
  (they cannot contain OMO markers).
- Strip `<!-- OMO_INTERNAL_INITIATOR -->` and `<!-- OMO_INTERNAL_NOREPLY -->` (with surrounding
  newlines/whitespace, per OMO's regexes) from every text part after concatenation; exclude
  `ignored: true` parts from the rendered body. Unwrap all `<system-reminder>`/`</system-reminder>`
  tags (case-insensitive), keeping their content.
- Header extraction: skip empty lines; if the first content line is exactly `<system-reminder>`,
  start after it; collect consecutive `/^\[[^\]]+\]$/` lines until a blank line,
  `</system-reminder>`, or a non-bracket line. Treat a leading `BOULDER COMPLETE...` line as an
  additional title line.
- `title = headers.join(" · ")`, bounded to 240 characters; if no header, use the kind.
- Body = the remaining text after the consumed header lines and markers, trimmed. Render it with the
  safe markdown renderer (tables allowed). If no body remains, omit the body.

Kind and tone mapping:

| Header/content | Kind | Tone |
| --- | --- | --- |
| `[BACKGROUND TASK RESULT READY]`, `[BACKGROUND TASK COMPLETED]`, `[ALL BACKGROUND TASKS COMPLETE]` | `Task result` | `success` |
| `[ALL BACKGROUND TASKS FINISHED - N FAILED]`, `[BACKGROUND TASK ERROR]` | `Task result` | `error` |
| `[BACKGROUND TASK CANCELLED]`, `[BACKGROUND TASK INTERRUPTED]`, `[BACKGROUND TASK RETRYING]` | `Background task` | `warning` |
| other `[BACKGROUND TASK ...]` / `[BACKGROUND TASK RETRY SESSION READY]` | `Background task` | `info` |
| `[SYSTEM DIRECTIVE: OH-MY-OPENCODE - TODO CONTINUATION]`, `[SYSTEM DIRECTIVE: OH-MY-OPENCODE - BOULDER CONTINUATION]`, `RALPH LOOP`, `ULTRAWORK`, `BOULDER COMPLETE...` | `Continuation` | `neutral` |
| `[SYSTEM REMINDER - ...]`, other `[SYSTEM DIRECTIVE: OH-MY-OPENCODE - ...]` (including `DELEGATION REQUIRED`, `SINGLE TASK ONLY`, `COMPACTION CONTEXT`, `CONTEXT WINDOW MONITOR`, `PROMETHEUS READ-ONLY`) | `System reminder` | `neutral` |
| unknown synthetic-only text | `System` | `neutral` |

The classification matches the first recognized header; content without a recognized header is
`System` neutral.

Rendering:

- Row: `<article class="message message--system">` with no operator avatar, no user bubble, and no
  `message__body` operator padding. Meta line: system glyph (`settings`), `OMO`, kind, timestamp.
  The card is `<div class="omo-card" data-kind data-tone>` on an inset surface with a hairline.
- `.omo-card__head` holds `.omo-card__title` (mono-ish header line, `textContent`) and
  `.omo-card__kind`; the title wraps and never truncates. `.omo-card__body` also carries
  `message__body` so the safe markdown (including tables) reuses the prose/table rules.
- Short reminders/continuations render inline. A long background result is collapsed in
  `<details class="omo-card__details">` when the body is > 600 chars, > 8 lines, or contains
  `**ID:**`/`**Description:**`; the `<summary>` is a one-line preview built from the first available
  of `**ID:**`, `**Description:**`, or `**Duration:**` (regex on the body), otherwise the first body
  line. Expanding shows the full markdown body.
- Long bodies/tables use the existing `.message__table-wrap` scroll; mobile has no page overflow.
  Summary is a 44px target at < 768 and keeps a visible focus ring.
- OMO system messages are conversation history: they never enter `queue`, never count toward
  `N queued`, and are never announced as operator messages. Do not add a live-region announcement for
  their arrival; they appear as history. Errors inside a background result are visible by their
  `data-tone` and text, not by an alert loop.

False positives:

- Because the classifier mirrors OMO exactly, an operator who pastes
  `<!-- OMO_INTERNAL_INITIATOR -->` into an otherwise real prompt is classified as system. This is
  obscure and accepted. An optional known-header guard (classify only if a recognized header exists)
  would remove this false positive but would miss synthetic continuations without a bracket header;
  it is not enabled in this stage. Document the guard if it is added later.

## 10. Performance and accessibility

### 10.1 Rendering schedule

- One `requestAnimationFrame` flush; all store mutations before it are coalesced.
- `message.part.delta` text is buffered per part; the DOM text is updated at most once per frame.
- Markdown for a streaming part is re-rendered at most every 50 ms and once on seal/idle.
- Running tool output is re-rendered at most every 100 ms and once on completion.
- No re-render when the part version and text did not change.
- If `document.hidden`, skip DOM work and flush once on `visibilitychange`.
- The sessions rail renders only when its full signature changes: `sessionId`, search needle, ordered
  `{id,title}`, per-session prompt counts/flags (including inline correlated questions), runtime,
  and deleting/creating state. Status ticks and token updates never call `renderSessions`; selection
  and search repaint even when the underlying list is unchanged.
- Message count updates only when `order.length` changes.
- The queue recomputes only on message insert/role boundary/assistant arrival, snapshot replacement,
  or session switch; not on text deltas. The strip patches its count and previews only when the
  derived queue signature changes.
- OMO classification runs once per complete message snapshot (first text snapshot or idle), not per
  delta; the result is cached on the message record.

### 10.2 Scroll

- `overflow-anchor: none` on `.chat-thread__scroll`; anchoring is manual.
- Before a DOM update, if the reader is not at the bottom, capture the first visible message/part and
  its offset. After the update, restore `scrollTop` by the offset delta.
- If the reader is at the bottom (`scrollHeight - scrollTop - clientHeight < 80`), pin to the new
  bottom in the same frame. No smooth scrolling.
- `.chat-new-messages` appears only when `order` grows while the reader is away from the bottom. Token
  growth in an existing message does not show it.
- Session switches reset to the bottom. Loading a session must not inherit the previous session's
  scroll.
- A queue-strip appearance/height change reuses the same bottom-pin/anchor logic; it never scrolls a
  reader who is away from the bottom.

### 10.3 Accessibility

- `#chat-messages` keeps `role="log"` but becomes `aria-live="off"`; `aria-relevant` is removed.
  Streaming text/tool output is never announced. `aria-busy="true"` is set only during the initial
  snapshot/session load and removed afterwards; it is not used while streaming.
- `#chat-working .chat-working__label` is the non-waiting agent-status live region
  (`role="status"`, `aria-live="polite"`, `aria-atomic="true"`). The existing `.chat-waiting` is the
  waiting live region; the two are never visible together. The elapsed span is `aria-hidden`.
- `#chat-announcer` (existing, polite) announces message-level events only: "Message sent", "Agent
  replied" (on idle if new assistant text), "Answer sent", "Message failed", "Reconnected". Debounced
  at 300 ms; never per token. Do not also announce the waiting transition here: `.chat-waiting` is
  the single status announcement for it.
- Inline question cards have `aria-labelledby` pointing at their own header; `fieldset`/`legend`,
  native radio/checkbox, and `role="alert"` errors are preserved. Auto-advance announces
  `Question N of M` once via `#chat-announcer`; the re-render itself is not a live region.
- The queue strip count chip is `role="status" aria-live="polite"`; previews are not live. Announce
  count changes only, never queued text or token changes. The status suffix
  `.chat-working__queued` is `aria-hidden`, so the same count is not announced twice.
- OMO system cards are history, not alerts: no live-region announcement on arrival, no focus steal.
  Their `<details>` summary is keyboard-operable; body markdown/tables use the same accessible
  primitives as assistant text.
- Tables use `<th scope="col">`, a labelled focusable wrapper for horizontal scrolling, and no
  content conveyed by color alone.
- Status is always glyph + text + color. Risk/plan/tool states stay non-color-only.
- `prefers-reduced-motion`: no new animation; the existing spinner is allowed (DESIGN 6.3); no
  streaming caret, pulse, or typewriter effect. Any positional change is a cross-fade.
- Touch targets are at least 44px below 768px for question/card controls.
- Focus rings stay 2px with 2px offset; no focus is moved by streaming updates.

## 11. CSS and compatibility contract

### 11.1 New classes

Every new class has one job; no existing primitive is duplicated.

| Class | Purpose |
| --- | --- |
| `.message--optimistic` | Immediate user row; `data-state="sending"` uses the existing wash and a subdued role label. No layout shift when rekeyed. |
| `.message__table-wrap` | Focusable horizontal-scroll wrapper for a GFM table inside prose. |
| `.message__table` | GFM table: hairline rules, `--inset` header, compact cell padding; `[data-align="right"]` uses tabular numerals. |
| `.message__table-note` | Caption for a table truncated at the 200-row cap. |
| `.tool-call__truncated` | Truncation notice under a tool `<pre>`; never implies the full output is displayable. |
| `.tool-call__output` | Streaming tool `<pre>`; owns its own scroll position (separate from the feed scroll). |
| `.tool-todo`, `.tool-todo__item`, `.tool-todo__status`, `.tool-todo__content` | Read-only `todowrite` checklist inside a tool disclosure. |
| `.chat-question` | Inline feed card container; surface 1, hairline, 76ch max, `data-state` for pending/answered/etc. |
| `.chat-question__answers`, `.chat-question__answer`, `.chat-question__answer-label`, `.chat-question__answer-value` | Read-only Q&A layout after a question part completes. |
| `.chat-question__state` | Small state label (`Answered`, `Dismissed`, `Request expired`). |
| `.chat-working__label`, `.chat-working__elapsed`, `.chat-working__queued` | Split agent-status label (live region), elapsed time, and the decorative `· N queued` suffix, so the timer/queue count never announces twice. |
| `.chat-queue-strip`, `.chat-queue-strip__count`, `.chat-queue-strip__list`, `.chat-queue-strip__item`, `.chat-queue-strip__preview`, `.chat-queue-strip__state` | In-flow queue row above the prompt dock; count live region, one-line previews, per-row sending/queued/unknown state. |
| `.message--system` | OMO system row; removes operator avatar/bubble styling and uses the inset system card. |
| `.omo-card`, `.omo-card__head`, `.omo-card__title`, `.omo-card__kind`, `.omo-card__body`, `.omo-card__details`, `.omo-card__preview` | OMO system card: label + kind + header title, safe markdown body, collapsible long results, one-line preview. Tone is `data-tone`. |

Reused as-is: `.message`, `.message__meta`, `.message__body`, `.tool-call`, `.tool-call__path`,
`.composer*`, `.prompt-*`, `.chat-live`, `.chat-working`, `.chat-new-messages`, `.chat-plan*`,
`.session-item*`, `.status`, `.badge`, `.rule`, `.sr-only`.

### 11.2 Tokens

| Token | Value | Justification |
| --- | --- | --- |
| `--chat-feed-ratio` | `75%` | R10; one place to tune the feed measure at `>= 1024`. |
| `--chat-feed-min` | `60ch` | Prevents the three-pane desktop (1360-1440) from squeezing prose below a readable measure when 75% is small. |
| `--chat-feed-max` | `96rem` | Prevents an unreadably wide feed on ultrawide displays while allowing tables/tool output to breathe. |

`--reading-measure` (68ch) is reused for prose; no duplicate measure token. No new color, motion,
radius, or spacing tokens. Status colors use existing `--success`, `--warning`, `--danger`, `--brass`.

### 11.3 Compatibility

- `POST /api/apps/:app/sessions/:sid/messages` keeps its current blocking `{text}` request and
  `{message}` response when `async=1` is absent. The IDE extension and non-browser callers are
  unaffected. `async=1` is the additive 202 form.
- The raw per-session SSE route is unchanged and remains unused by `assets/chat.js`.
- The app SSE route keeps its default `message` frames, heartbeat, backpressure, and 401/403/404/502
  behavior. The `seq`/`streamID` fields and new types are additive.
- Old app-stream clients ignore the new types and still receive `session.activity` for
  `message.updated` and `session.status`, so they reload at message granularity.
- No route, response, or schema is removed. No SQLite migration is needed.
- `assets/chat.js` becomes an ES module and imports the pure helper module `assets/chat-core.js`;
  the chat page emits `<script type="module">` for it and the asset allowlist adds
  `/assets/chat-core.js`. No bundler or build step is added. CSS stays in `src/http/styles.css` and is
  built by the existing Tailwind CLI.
- The module split is what makes `deriveQueue`, `classifyOmo`, `applySnapshot`, `rekeyOptimistic`,
  and `parseMarkdownTable` directly importable by Vitest, so the four existing gates exercise the core
  client logic.

### 11.4 Security

- All agent/question/tool content is untrusted. Markdown tables build DOM nodes; no `innerHTML`, no
  raw HTML, no images, no `javascript:` links. Table cells use the same inline renderer as prose.
- Question text, options, answers, todos, metadata, and tool previews are `textContent`; `title`
  attributes receive bounded plain text; metadata is never turned into links.
- The async path validates `text` length and never forwards arbitrary JSON. The generated message ID
  matches the upstream `^msg` contract. Busy sessions are accepted for queueing; this is not a
  privilege change.
- OMO classification is presentation-only. It never changes message identity, queue membership except
  to exclude the system row, or server state. The marker false positive (an operator pasting the
  internal marker) is documented and accepted; it cannot inject HTML because all OMO body rendering
  stays in the safe markdown/text path.
- Auth behavior is unchanged; the async form uses the same principal model as the existing chat API.
  No new secret is exposed to agents.
- The existing documented residual risks (same-uid agent, unauthenticated loopback upstream, SSE
  payload from a trusted local instance) do not change. This design reduces what the browser accepts
  by capping payloads and dropping unknown delta fields.

### 11.5 Implementation surface (contract, not a plan)

| File | Contract change |
| --- | --- |
| `src/opencode/events.ts` | Extend `HanseEvent` with `parentID` and `session.warning.sessionID`; add `APP_STREAM_MAX_FRAME_BYTES`, `MAX_TYPED_EVENT_BYTES`, bounds/truncation helpers, and prompt/todo event budgets; keep `session.activity` compatibility copies with `cause`. |
| `src/http/prompts.ts` | `streamAppEvents` passes `maxFrameBytes: APP_STREAM_MAX_FRAME_BYTES` to `createEventStream`, allocates `streamID`, adds `seq`, and keeps `stream.ready` after upstream attach. |
| `src/opencode/client.ts` | Add `sendPromptAsync` using `sendVoid`; add an explicit bounded `MESSAGES_RESPONSE_MAX_BYTES` (8 MiB) and `MESSAGES_RESPONSE_TIMEOUT_MS` (30 s) to `listMessages` via the capped reader; no change to `sendPrompt`. |
| `src/http/chat.ts` | Add `?async=1` to the existing `POST .../messages` route; map an oversized message snapshot to `502 messages_too_large`; keep the blocking form and `streamSessionEvents` unchanged. |
| `assets/chat-core.js` | Pure ESM helpers: `deriveQueue`, `classifyOmo`, `applySnapshot`, `rekeyOptimistic`, `parseMarkdownTable`, and the OMO/queue types. No DOM access. |
| `assets/chat.js` | ES module importing `chat-core.js`; replace debounce/reload rendering with the keyed store, SSE handlers, hydration/reconcile, inline questions + auto-advance, queue strip/derivation, OMO system cards, tool renderers, status model, table markdown, and keyboard handling. |
| `src/http/ui.ts` / `src/http/chat.ts` / `src/http/handler.ts` | Emit the chat module script (`type="module"`), pass the module script from `handleChat`, and add `/assets/chat-core.js` to the handler asset allowlist. |
| `src/http/styles.css` | Add the feed tokens, feed/composer width rules, table, optimistic, tool-todo, inline-question, queue-strip, OMO card, truncation, and status-label/elapsed classes. |
| `test/chat-core.test.ts` | Vitest coverage for queue derivation, OMO classification, snapshot/optimistic rekey, table parser, and the risky invariants. |
| `test/*` | Extend projector, client, chat HTTP, app-events, and browser QA coverage per section 14. |

## 12. Failure modes and race handling

| Scenario | Behavior |
| --- | --- |
| Text delta arrives before its part snapshot | Create a provisional `text` part, append; a later snapshot replaces it (and may correct the type to `reasoning`). |
| Delta arrives after the part is sealed (idle/completed tool) | Ignore; the snapshot is authoritative. |
| Duplicate event (same envelope or same seq) | Drop via `eventIds` or `seq <= lastSeq`. |
| Sequence gap | Schedule one 500 ms reconcile and the idle reconcile; do not guess the missing bytes. |
| App frame > 8 MiB | Parser drops it; salvage identity → synthetic `message.part.omitted`, otherwise one `stream.warning` (with `sessionID` when available); reconcile. |
| Part snapshot > 256 KiB after caps | `message.part.omitted`; render a placeholder with "Output too large for live view"; reconcile at idle. |
| Text snapshot > 64 KiB | Omit the snapshot; deltas/completion/idle reconcile fill the rest. |
| Prompt/Todo event > 256 KiB | Question → `tooLarge` + summary, dismiss-only; permission → deny-only `tooLarge`; todos → truncate trailing items with `truncated:true`. |
| Hydration GET overlaps events | Always apply the snapshot; merge optimistic by server ID; discard buffered content; replay only the last status; reconcile once early plus at idle. Turn change schedules one follow-up, never discards history. |
| Event after GET generated, before applied | In the discarded buffer; not replayed; the early 500 ms reconcile covers it. |
| Send starts during idle reconcile | Apply the snapshot (keep the optimistic row), then schedule one follow-up after the turn settles; never discard/retry from scratch. |
| Unknown acceptance absent after snapshot | Start 5 s grace; then `Check again` (one GET) / `Remove` (local only); no auto-retry or deadlock. |
| Unknown acceptance appears later | Adopt by server ID live or in a snapshot; clear the gate. |
| Reconnect | New `streamID`; hydrate messages, prompts, todo; preserve open parts and scroll anchor. |
| Idle | Final markdown/tool render; recompute queue from the snapshot; one 200 ms GET reconcile. |
| Send while busy | `?async=1` returns 202; the row is `queued` when it is beyond the visible-assistant/`parentID` boundary (otherwise active/normal); status renders `Working · N queued`; no 409 and no client-side holding queue. |
| Send fails before 202, outcome `not_sent` | Remove optimistic row; release the acceptance slot; restore the draft if the composer is empty; inline error; continue the chain. |
| Send outcome unknown (timeout/transport after request) | Keep the row as `unknown` keyed by the returned `messageID`; hold the acceptance gate; reconcile by ID; no auto-retry. If it appears, mark queued/accepted; if not, offer an explicit retry. |
| Send accepted but no events | Keep the optimistic row and `Working`/`Paused`; reconnect hydration derives status and reconciles. |
| Two queued prompts, one combined assistant reply | Both are queued after the visible assistant's `parentID`; the combined assistant's `parentID` points to the last queued prompt, so both become processed and leave the strip. Earlier prompts are not cleared by a bare shell. |
| Consume race | If an assistant appears while a later prompt is still queued, only rows up to the assistant's `parentID` are processed; rows after it stay in the strip. |
| Bare assistant shell | A shell with no visible parts is ignored for the boundary; it never clears the queue. |
| Completed assistant + `finish:"tool-calls"` + new prompt | `turnContinues` is true; the new prompt is queued, not active, and appears in the strip/`N queued`. |
| Retry / aborted assistant, idle session | A retry keeps `turnContinues` true while busy. An aborted assistant is finalized (`time.completed` + `finish:"aborted"`), and an idle `session.status` overrides `turnContinues` to false; the next prompt becomes the head. |
| Completed previous assistant + new prompt | `turnContinues` is false; the tracked/derived head is active, renders normally, and is excluded from the strip. |
| Streaming assistant + queued prompts | `turnContinues` is true; every pending row is queued; the active head is null. |
| Queue row reload/reconnect | Snapshot recomputes the boundary from the last visible assistant + `parentID`; rows after the boundary reappear as `queued` while the last visible assistant is uncompleted, otherwise the first is `active` and the rest are queued. Unaccepted optimistic rows are re-applied from the acceptance map. |
| Attempt to remove a queued message | No UI control. Upstream `DELETE` would return 409 `SessionBusyError`; this is an accepted limitation. |
| OMO system message in history | Classified client-side; rendered as `OMO` card; excluded from queue and queued detection; no server event. |
| OMO marker pasted by operator | Classified as system under strict OMO parity; documented false positive; optional known-header guard is not enabled. |
| `prompt_async` unavailable | 502 `async_unavailable`; the client shows the inline error and does not silently use the blocking route. |
| Stream paused | Keep inline question controls interactive; status shows `Paused` when a turn is active; `Retry` reconnects and hydrates. |
| Session deleted while streaming | Existing delete/select behavior; a stale event for the missing session is ignored. |
| Session switch mid-stream | Generation guard drops the old session's snapshot/events; drafts and open state are per session. |
| Multiple tabs | Independent stores; each hydrates on its own stream. No shared client state. |
| Unknown part type | Placeholder + one reconcile; if still unknown, hide it without looping. |
| Removed part/message event | Fold into `session.activity`; reconcile; no invented payload shape. |
| Big tool output after idle | The idle GET replaces the truncated view only if the whole message response fits the 8 MiB cap; otherwise `502 messages_too_large`, keep the last feed, and show "Session too large to refresh." |
| Message snapshot > 8 MiB | `listMessages` rejects it; `GET /messages` maps to `502 messages_too_large`; no partial JSON. |
| Elapsed timer while waiting | Freeze; resume on answer; reset on `Ready`. |

## 13. Acceptance criteria

| ID | Acceptance criterion |
| --- | --- |
| R1 | In a multi-question request, focusing the custom input and pressing Enter moves to the next step exactly once; on the final step it triggers the primary action. For multi-select it includes the custom answer and advances. With a confirmation open, Enter does not confirm. No newline is inserted. |
| R2 | On submit, a user row is visible before the async POST resolves; after the 202 and the first `message.updated`, exactly one user row exists with the server message ID and no visual re-mount. It is `queued` only when beyond the active/`parentID` boundary; the active/consumed row is `accepted`/normal. On a definitive `not_sent` failure, the row disappears and the draft is restored when possible. On an unknown transport outcome, the row stays "Delivery unknown; checking…", every snapshot applies, and after 5 s of confirmed absence it offers `Check again`/`Remove` instead of deadlocking; no duplicate is sent. |
| R3 | During a turn, the status shows `Sending` only while an acceptance POST is in flight, then `Thinking`/`Working`/`Running <tool>`/`Retrying` as the corresponding state occurs; `Waiting for you` when a prompt is pending; `Ready` after idle. With queued messages it appends `· N queued` to the active-turn label (`Working · 2 queued`). Elapsed is shown and stops at `Ready`. The status is not derived from `pendingSends` alone. |
| R4 | Every reasoning disclosure summary reads `Thinking`; it remains collapsed by default and expands to the reasoning text. |
| R5 | A 500-token reply appears incrementally and ends with the same characters as the final `GET /messages` snapshot. Reconnecting mid-stream or receiving a dropped frame produces no duplicated text after idle. |
| R6 | A question appears in the feed at its `question` tool part, is answerable, and becomes a read-only Q&A card with the submitted answers in the same position after completion. Reloading the session reproduces the Q&A from history. No new table exists. |
| R7 | A running `bash` call shows partial stdout/stderr while running and the final output on completion; the collapsed summary shows the command. A >1 MiB running snapshot is accepted by the 8 MiB app parser, capped to the live window, and rendered; it is not silently dropped as a 1 MiB frame. |
| R8 | Collapsed previews are one line for bash/read/write/edit/grep/glob/webfetch/websearch/generic; `todowrite` renders a checklist with statuses and counts. |
| R9 | A GFM pipe table with alignment renders as a real table at 390/768/1440/1920, does not overflow the page, and is safe for `<script>`/raw HTML cell content (rendered as text). |
| R10 | With the layout state in 9.1 (1024/1359 context drawer closed; 1440/1920 sessions+context open), the padded content-box ratio is ~75% at 1024, ~87% at 1440 (60ch floor), and ~75% at 1920; at 768 and below it is 100%. The 96rem cap applies. No horizontal page overflow at 390; composer and feed share the same content box. |
| R11 | Streaming a long reply does not replace the feed; open tool disclosures, selection, and focus survive updates. A reader scrolled up stays at the same anchor while tokens arrive. `New messages` appears only for new messages. |
| R12 | Questions, permissions, Plan/Todo, saved permissions, policy warnings, session switching, drafts, deletion, the blocking send route, and the raw session SSE still behave as before. The full existing test suite stays green. |
| R13 | Every typed event is within the 256 KiB post-cap budget; app frames up to 8 MiB reach the projector and >8 MiB follows the omission/warning rule; oversized parts produce `message.part.omitted`/`truncated` rather than being silently cut; seq gaps trigger one reconcile; snapshot application does not duplicate deltas. |
| R14 | The feed is not a token live region; status transitions announce once; the announcer covers message-level outcomes only; keyboard behavior in R1 works; reduced motion removes any non-essential motion. |
| R15 | Sending while `busy` returns 202 and adds a queued row without a 409. Two accepted prompts appear in order; a combined assistant reply with `parentID` = the last queued prompt clears both, while a bare shell or an assistant whose `parentID` stops earlier does not clear later prompts. If `turnContinues` (uncompleted assistant, or completed with `finish:"tool-calls"`), all rows after the processed boundary are queued; otherwise the tracked/derived head is active and rows after it are queued. The head is not in the strip. The strip shows count + one-line previews, excludes OMO systems, hides when empty, survives reload/reconnect, and has no remove control. Sending is disabled only for a pending question/permission, an in-flight acceptance POST, or an unresolved acceptance outcome; an unknown outcome resolves through an applied snapshot or the 5 s grace + `Check again`/`Remove`, never a deadlock. |
| R16 | In a 3-question block, choosing a single-select option on Q1 advances to Q2 with focus on Q2's first input and announces `Question 2 of 3`; Q3 advances to Review. A multi-select question stays put, and a single-question block does not auto-submit. Custom-answer Enter still advances/submits once, ignoring composition and open confirmations. |
| R17 | Each OMO fixture (marker-only, synthetic-only, each header, unknown header) renders a system card with `OMO`, kind, tone, title, and safe markdown body; no operator avatar/bubble; markers and `<system-reminder>` tags are hidden; long results collapse with a one-line preview; OMO rows never appear in the queue strip; mobile/keyboard have no overflow or focus loss. |

## 14. Test strategy

### 14.1 Unit

- `test/opencode-events.test.ts` extended:
  - `message.updated` mapping (valid/invalid role, missing id, `parentID`, time fields, activity
    compatibility).
  - `message.part.delta` mapping (field `text`, empty/other fields dropped, identity fields, large
    delta dropped + one warning, `partType` learned from a prior snapshot).
  - `message.part.updated` mapping for text/reasoning/tool/patch, identity validation, tool output
    caps (tail while running, head when completed), `truncated.fields`, `message.part.omitted` when
    over 256 KiB.
  - `session.status` and `session.idle` normalization, duplicate idle suppression, bounded message
    and action.
  - Question tool parts keep `state.input.questions` and `state.metadata.answers` under caps.
  - Prompt/todo event budget: `question.asked` over 256 KiB becomes `tooLarge` + bounded `summary` with
    no answerable questions; `permission.asked` over budget becomes deny-only `tooLarge`; `todo.updated`
    truncates trailing items with `truncated:true`; boundary cases just under/over 256 KiB.
  - Removed events and unknown events fall back to `session.activity`.
- `test/client.test.ts` extended: `sendPromptAsync` sends the exact `{parts, messageID}` body, accepts
  204, maps 404/5xx/timeouts to `OpencodeHttpError`, and does not attempt JSON parsing.
- `test/prompts-normalize.test.ts`: unchanged behavior for existing prompts; add the question tool
  ref retention assertion.
- `test/chat-core.test.ts` imports `assets/chat-core.js` and covers the risky pure helpers:
  - `deriveQueue`: parentID boundary, combined reply, consume race, bare assistant shell, no-visible-
    assistant head, completed assistant + `finish:"tool-calls"` + new prompt queued, retry, aborted
    assistant with idle override, completed previous assistant + new prompt active, streaming
    assistant + queued prompts, OMO exclusion, optimistic sending/unknown, reload reconstruction.
  - `classifyOmo`: every marker/header, synthetic-only, multi-part marker-on-later-part, ignored text,
    false positive, header extraction/tones.
  - `applySnapshot`/`rekeyOptimistic`: snapshot sealing (completed messages, last uncompleted), no
    delta duplication after a snapshot (delta-before-snapshot overlap), snapshot-only growth,
    completion snapshot, optimistic rekey with pre-202 buffered events, no clearing of
    in-flight/unknown acceptance.
  - `parseMarkdownTable`: escaped pipes, code spans, ragged rows, one-column/one-dash, prose-pipe +
    delimiter false positive, caps.

### 14.2 HTTP and stream integration

- `test/chat-page.test.ts` / chat HTTP tests:
  - `?async=1`: 202 `{accepted:true, messageID}` body/ID format, exact upstream
    `{parts, messageID}` body, 204 handling, empty text 400, unknown app 404, upstream 404
    `session_not_found`, upstream 5xx 502, no manager 503, principal 401. Text boundary: 32 KiB UTF-8
    succeeds; a multibyte text just over 32 KiB returns 400 `message_too_large`; a body just above the
    64 KiB JSON cap returns 413 `payload_too_large`.
  - busy session: upstream `prompt_async` 204 is returned as 202, never 409; the route does not
    pre-check `session.status`.
  - unknown transport outcome: 502 includes `outcome:"unknown"`, `messageID`, `sessionID`.
  - blocking `/messages` response and body unchanged; `async` absent still blocks.
  - `GET /messages`: a large-but-valid response under 8 MiB completes through the 30 s capped-reader
    path (it is not timed out by the default 5 s read timeout); over the 8 MiB cap returns `502
    messages_too_large` (no partial JSON) and the client keeps its last feed with the "Session too
    large to refresh" notice; a first-load
    failure shows the thread error.
  - the flag is accepted with `?project=` and does not affect the sessions/messages list routes.
- `test/app-events.test.ts`:
  - `stream.ready` includes `seq:0` and a stable `streamID`.
  - every event increments `seq`; ids are unique per connection.
  - typed message/part/status frames; `session.activity` compatibility frames for message/status.
  - heartbeat frames carry no seq; backpressure/abort behavior unchanged.
  - oversized part behavior and one warning per code; >1 MiB bash snapshot (large metadata.output)
    reaches the projector and is capped/streamed rather than dropped; >8 MiB frame yields
    `message.part.omitted` when identity is salvageable, otherwise one `stream.warning`; prompt/todo
    budget boundaries.
- Static page test: `#chat-messages` is `role="log"` with `aria-live="off"`; status label/elapsed/
  queue-suffix nodes exist; the chat script is `type="module"`; `/assets/chat-core.js` is allowlisted;
  no `innerHTML` usage in `chat.js`.

### 14.3 Browser QA (Playwright route interception + stub EventSource)

Run at 390, 768, 1024, 1440, and 1920, dark and light where the change affects surfaces:

- Layout: with 1024/1359 context drawer closed and 1440/1920 sessions+context open, assert the
  computed padded-content-box ratio (~75%, ~87% floor-driven, ~75%), 100% below 1024, shared
  feed/composer box, no horizontal page overflow, and table wrapper scroll at 390.
- Streaming: feed a scripted sequence of `message.updated` + deltas + tool snapshots; assert
  incremental text, no duplicates after `stream.ready`/reconnect, final markdown/table on idle.
  Include delta-before-snapshot overlap (snapshot includes some/all text), snapshot-only growth (no
  deltas), and a completion snapshot; no repeated text.
- Scroll: at-bottom follows; scrolled-up anchor holds; `New messages` only on new messages; session
  switch resets.
- Sessions rail: selection/search repaint correctly when the list signature is otherwise unchanged;
  prompt flags (including inline questions) and runtime/deleting/creating states repaint; token ticks
  do not.
- Keyboard: custom-answer Enter advances/submits once; multi-select includes the custom answer;
  single-select auto-advance focuses the next question and announces once; confirmation is not
  auto-accepted; Ctrl/Cmd+Enter; Escape order.
- Tool previews: bash streaming/final/truncated; todowrite checklist; read/write/edit/grep/glob/
  webfetch/websearch/generic previews; error auto-open.
- Tables: escaped pipes, code spans containing pipes, ragged rows, one-column/one-dash, alignment,
  200-row cap, and a prose pipe followed by a delimiter-looking line (must remain prose).
- Questions: pending inline, `part-unavailable`/omitted part, answered Q&A, dismissed, expired, too
  large, dock-only uncorrelated request, top-bar prompt-request count, focus return.
- Question reply races: two tabs (one replies, the other sees "Answered elsewhere" without answers
  until the part snapshot/GET); delayed completed part supplies answers; a local submit shows its draft
  answers immediately. No event is assumed to carry answers.
- Inline-pending gate: a correlated inline question (not in the dock) still disables send, shows
  `Waiting for you`, increments the top-bar/per-session count, responds to Escape and Ctrl/Cmd+Enter,
  and receives focus when appropriate.
- Status: Sending → Thinking → Running bash → Working → Waiting for you → Ready; `· N queued` suffix;
  retry; paused; elapsed freezes/resets.
- Queue: send while busy; two sends accepted in order; a combined reply with `parentID` = the second
  prompt clears both; an assistant that stops at the first prompt leaves the second queued (consume
  race); a bare shell clears nothing; completed assistant + `finish:"tool-calls"` + new prompt is
  queued (not active); retry and streaming assistant with queued prompts; aborted assistant with idle
  session makes the next prompt the head; completed previous assistant + new prompt makes it the
  head; reload/reconnect preserves the boundary; no remove control; a pending question disables send;
  optimistic `sending`/`queued`/`unknown` states; OMO rows excluded.
- OMO: fixtures for each marker/header, synthetic-only, and a multi-part message where the marker/
  `synthetic` flag appears only on a later text part. For the no-flash case the later part arrives
  within the 100 ms quiet period; a late part may reclassify, and the fixture asserts the
  reclassification rather than a guaranteed no-flash. Also: no operator avatar/bubble; queue
  exclusion; markdown/table body; long result collapse; mobile/keyboard; no live-region spam.
- Reconnect: close the EventSource, reconnect, assert hydration and no duplicate tokens; seq gap
  triggers exactly one reconcile; queue recomputed.
- Hydration races: an event arrives during the GET; a send starts during hydration; a send starts
  during the idle reconcile; a fresh page load overlaps the first send; back-to-back turns. In each
  case the snapshot is applied, the optimistic row is merged/kept, a follow-up GET is scheduled when
  the turn changed, no duplicate token appears, and no deadlock.
- Unknown acceptance: the message appears in a live event/snapshot (resolve); it is absent after a
  snapshot (5 s grace, then `Check again` and `Remove`, no deadlock); a later appearance resolves
  automatically.
- Snapshot sealing: reload a completed turn (all parts sealed, `Ready`), a turn with a running tool
  (`Running <tool>`), and a snapshot whose last assistant is uncompleted (only its text/reasoning
  unsealed; earlier completed messages sealed). No idle event is required for the correct status.
- A11y: `aria-live` behavior (no token announcements), status/queue count announcement once, table
  headers, OMO details focus, focus after card removal, reduced-motion media emulation.

### 14.4 Live agent smoke

With a real managed `opencode` 1.19.3 instance:

1. Send a prompt that streams a 10-line answer and a markdown table; verify incremental text, final
   table, and idle reconciliation.
2. Ask for a `bash` command that prints in a loop; verify partial output and final output.
3. Trigger a `todowrite`; verify the checklist and Plan panel consistency.
4. Trigger a `question`; verify inline placement, answer, and completed Q&A after reload. If the
   request has multiple single-select questions, verify auto-advance/focus/announcement; if a
   multi-select, verify it does not auto-advance.
5. While a turn is running, send two more prompts; verify 202s, ordered queued rows, `· N queued`,
   one combined assistant response, both rows cleared from the strip, and a reload that preserves the
   queue until consumption.
6. Trigger an OMO background task/continuation (or replay real OMO fixtures); verify system cards,
   marker stripping, long-result collapse, and queue exclusion.
7. Trigger a retry (or inspect a retry fixture) and verify `Retrying`.
8. Reload mid-turn and verify reconnect hydration without duplicate text; reload while queued and
   verify the queue is reconstructed from history.

### 14.5 Gates

```bash
npm run lint
npm run typecheck
npm test
npm run build
```

All four must be green. Existing tests must not be weakened; new behavior gets new assertions.

`test/chat-core.test.ts` is part of `npm test`, so the four gates now exercise queue derivation, OMO
classification, snapshot sealing/rekey, and the table parser. The deterministic browser fixture suite
in 14.3 is **not** a product dependency; it is a required manual pre-merge command, run the same way as
the design capture script:

```bash
node docs/design/chat-qa.mjs
```

The script is added with the implementation (it is not a product dependency). It resolves an installed
Playwright module/Chromium and must report zero page/console errors for the R1/R15/R16/R17 fixtures. A
missing local Playwright is a blocked QA gate, not a silent skip. The last run passed 3 scenarios /
81 assertions with zero console/page errors; captured screenshots and the JSON report live in
[`artifacts/chat/`](./artifacts/chat/README.md).

## 15. Risks, non-goals, and accepted debt

### 15.1 Risks

| Risk | Mitigation |
| --- | --- |
| Upstream event shapes drift between 1.18.35 and 1.19.3 | Pin 1.19.3 in the image; projector validates identity fields and falls back to `session.activity`; contract tests cover the verified shapes. |
| Part snapshot volume/rate makes SSE expensive | 8 MiB app frame cap, 256 KiB typed-event budget, 64 KiB output caps, 64 KiB delta cap, client coalescing; per-stream parser memory is bounded and backpressure pauses the writer. If measured cost is high, add server-side per-part throttle (see falsifiers). |
| Long sessions still render every message | Accepted debt; no virtualization in this stage. Idle reconcile is one GET. Large sessions remain a scaling limit. |
| Inline questions regress the existing dock | Correlated cards reuse existing controls; uncorrelated questions keep the dock; regression tests cover both; permissions never move. |
| Hydration/delta races duplicate text | Generation-guarded hydration discards buffered content; a send/turn change restarts the reconcile; idle reconcile is authoritative; seq gaps trigger one reconcile. |
| `prompt_async` unavailable on an older image | Explicit 502 `async_unavailable`; the image pins 1.19.3; the blocking route remains. |
| Table parser edge cases (escaped pipes, code spans) | Unit fixtures for escapes, code spans, alignment, ragged rows, caps; fallback to paragraphs on too many columns. |
| 75% feed makes 1360px tight | The 60ch floor keeps the feed readable at 1360-1440 while 1920 reaches 75%; verify at 1024/1360/1440/1920. |
| Status derivation disagrees with upstream | Status labels are derived from documented fields only; snapshot derivation covers boot/reconnect; `Retrying`/`Paused` are explicit. |
| Queue order differs from UI order under rapid sends | A per-session acceptance chain serializes `?async=1` POSTs; the UI never sends concurrently. The chain is not a holding queue. |
| `parentID` absent or ambiguous in a snapshot | Queue uses the last visible assistant's `parentID` as the processing boundary; if absent, it uses the assistant's feed position and keeps rows after it queued. Bare shells are ignored. Contract tests cover combined reply, consume race, and bare shell. |
| Queue strip drifts from upstream on lost events/reload | Hydration and idle reconcile recompute the queue from full message history; the strip is derived, never persisted. |
| Queued messages cannot be removed while busy | Accepted limitation: upstream `DELETE .../message/:mid` returns 409 `SessionBusyError`; no remove control is shown. A local outbox is a future stage. |
| Auto-advance surprises an operator editing an earlier question | Deliberate R16 behavior; Back/tabs remain available. The card is patched in place, so draft/focus survive. |
| OMO header/marker drift across OMO versions | Strict 5.1.35 parity; unknown headers fall back to neutral `System`; fixtures pin every known header. |
| OMO false positive (operator pastes the marker) | Accepted; documented in 9.10. A known-header guard is optional but would miss headerless synthetic continuations. |
| Large hydration GETs | `listMessages` is explicitly capped at 8 MiB; over cap is a visible `messages_too_large` state, not a silent truncation. A future pagination design is out of scope. |
| Old tabs lose token streaming | They still receive `session.activity` for message/status and reload at message granularity; this is an accepted pre-alpha compatibility trade. |

### 15.2 Non-goals

- No images, embeds, raw HTML, or HTML sanitizer.
- No virtualization or windowing of the message list.
- No abort/steer, message editing, deletion, reactions, attachments, or offline send queue.
- No Hanse-side holding/outbox queue, queue persistence, queue reordering, or cancel/remove control
  for queued messages. The queue is the upstream queue.
- No auto-advance for multi-select questions and no auto-submit for single-question blocks.
- No server-side OMO classification, OMO persistence, or new OMO SSE fields; classification is
  client-side.
- No new database table, migration, durable prompt inbox, or server-side chat state.
- No React/Vue/Svelte or JS bundler. No new runtime npm dependency; chat tool diffs and written
  content use a checked-in, vendored PrismJS 1.30.0 browser build (MIT) loaded as a same-origin asset.
  See [chat-diff-highlighting.md](./chat-diff-highlighting.md).
- No changes to permission semantics, saved permissions, the Plan panel, policy warnings, or the
  VS Code extension.
- No multi-user/RBAC or cross-app prompt inbox changes.
- No session-rail activity indicator (status is for the active session; prompt flags remain).
- No server-side markdown rendering.
- No change to the raw per-session SSE contract.

## 16. Owner decisions (closed)

No open owner questions remain. Queue strip density (one line), the `96rem` feed cap, and collapsed
`Thinking` were settled in D11/D7/D8 with the recommended values.

1. **Live tool-output retention (owner, 2026-10-19).** Use a 64 KiB live window with a truncation
   notice; the idle snapshot supplies the full output only when the whole message response fits the
   8 MiB cap (finding 11). A dedicated full-output fetch is a later stage if real sessions routinely
   exceed the cap.
2. **Uncorrelated questions (owner, 2026-10-19).** Keep the existing dock for requests without a
   `tool` reference. Native upstream questions supply `tool`, so the dock is a rare fallback; do not
   synthesize a feed card and add ordering/deduplication risk.

## 17. Review, falsifiers, and references

Design review: `oracle`. Owner decisions: section 16. Plan review: `momus` after owner answers.
Implementation must not start before those gates close (`docs/process.md`).

What would change this design:

- A measured CPU/SSE cost above the acceptable budget from part snapshots → add server-side per-part
  coalescing (100 ms) or delta-only tool events.
- Evidence that `prompt_async` is absent or returns a body on 1.19.3 → replace the `?async=1` path
  with a client-supplied ID + blocking route and defer queueing, or pin a different upstream.
- Evidence that `parentID` is absent/wrong in real snapshots, or that an assistant can consume a
  non-contiguous set of prompts → add an upstream queue event or a server-side queue snapshot rather
  than weakening the boundary heuristic.
- Real sessions routinely exceeding the 64 KiB tool-output window → add an explicit full-output fetch
  instead of relying on the idle snapshot.
- A table parser that cannot be kept safe/small → ship tables behind a stricter subset or defer R9
  rather than add a parser dependency.
- Playwright evidence that inline question cards regress focus/drafts → keep the dock for correlated
  questions too and render a read-only Q&A card in the feed.
- OMO header/marker drift in a newer OMO → update the classifier fixtures and the header table; keep
  unknown headers neutral rather than styling them as results.
- Auto-advance evidence that operators routinely overshoot on Edit → make auto-advance forward-only
  from the current question or disable it while editing; keep multi-select manual.

References: [`DESIGN.md`](../../DESIGN.md) sections 4.2-4.5, 5.16, 5.19, 6; [`stage-3.md`](./stage-3.md);
[`interactive-prompts.md`](./interactive-prompts.md); [`docs/current-state.md`](../current-state.md);
[`docs/process.md`](../process.md); `src/opencode/events.ts`; `src/opencode/client.ts`;
`src/http/chat.ts`; `src/http/prompts.ts`; `assets/chat.js`; `assets/chat-core.js`;
`src/http/styles.css`; `oh-my-openagent@5.1.35` (`isSyntheticOrInternalUserMessage`,
`getSystemReminderHeaderLines`, internal-marker helpers).

## 18. Design review - oracle

Verdict: **BLOCK** (original review). This revision addresses every finding below; the block is
cleared when `oracle` re-reviews and confirms the revised contracts.

### Findings

| # | Severity | Section | Problem | Revision |
| --- | --- | --- | --- | --- |
| 1 | BLOCKER | §4, §6.4, §9.4, R7/R13 | The default 1 MiB `SseParser` cap drops a >1 MiB `message.part.updated` before part caps apply, so bash streaming/truncation never runs. | App stream uses `APP_STREAM_MAX_FRAME_BYTES` 8 MiB; part/prompt caps run before serialization; >8 MiB omits if identity is salvageable, otherwise one warning; default 1 MiB stays elsewhere; test. |
| 2 | BLOCKER | §8.2, §9.9, R15 | Queue derivation cleared unconsumed prompts and exposed the first/active prompt as queued because it ignored `parentID` and counted assistant shells. | Forward `parentID`; boundary = last visible assistant's `parentID`; ignore bare shells; if the last visible assistant is uncompleted all trailing rows are queued, otherwise the first is active and the rest queued; tests for consume race/bare shell/combined reply. |
| 3 | MAJOR | §8.2-8.4, §9.5 | Snapshot text/reasoning parts stayed unsealed until an idle event, so reload status was wrong. | Seal completed messages on snapshot; only the last uncompleted assistant stays unsealed; derive status from the sealed snapshot; reload tests. |
| 4 | MAJOR | §9.6 | Correlated inline questions were excluded from the dock filter used for gating/counts/keyboard. | Split `allPendingForSession` (gates/status/counts/Escape/Ctrl-Enter) from `dockRenderEntries` (render only); inline-pending test. |
| 5 | MAJOR | §9.6 | `question.replied` was treated as carrying answers. | Local submit shows draft answers; other tab shows "Answered elsewhere" without values; Q&A only from the completed part's `state.metadata.answers`; two-tab/delayed-part test. |
| 6 | MAJOR | D3, §9.6 | Missing/omitted parts could duplicate a question or orphan it between dock and feed. | Any valid tool ref stays inline (`preparing`/`part-unavailable`); dock only for no tool ref; omitted/mismatch tests. |
| 7 | MAJOR | §6.4 | Prompt/todo events could exceed the app-stream frame cap despite per-field caps. | `MAX_TYPED_EVENT_BYTES` 256 KiB: question `tooLarge` + summary, permission deny-only `tooLarge`, todos truncated with flag; boundary tests. |
| 8 | MAJOR | §6.3, §8.2 | Text snapshots were all dropped after the first; a delta already in a snapshot could double-append. | Track `sawDelta`; no-delta snapshots are throttled; completion snapshot; clear `pendingDeltas` on snapshot apply; overlap/snapshot-only tests. |
| 9 | MAJOR | §8.2-8.4 | Hydration discarded good events and could clear an in-flight/unknown send; idle reconcile raced new sends. | Always apply the snapshot; merge optimistic by server ID; turn change schedules one follow-up; unknown uses 5 s grace + `Check again`/`Remove`; never clear rows; tests. |
| 10 | MAJOR | §11.3, §11.5, §14 | Core client logic was untested by the four gates. | Extract `assets/chat-core.js` ESM helpers; Vitest `test/chat-core.test.ts`; required manual Playwright command `node docs/design/chat-qa.mjs`. |
| 11 | MAJOR | §6.4, §9.4, §12, §15 | `listMessages` was uncapped, so "full output at turn end" was not guaranteed. | Explicit 8 MiB messages-response cap; `502 messages_too_large`; keep last feed + notice; promise is conditional; tests. |
| 12 | MINOR | D7, §9.1, R10 | Width formula/ratio claim did not match the clamp math or shared content box. | `min(100%, max(60ch, 75%))`, 96rem cap, shared padding; derived 75%/87%/75% table with layout state. |
| 13 | MINOR | §9.3 | Table grammar required 3+ dashes and did not validate header/delimiter counts. | GFM `-+`, equal counts, one-column/one-dash valid; escaped-pipe/code-span/ragged/prose-pipe fixtures. |
| 14 | MINOR | §9.10 | A later-part marker could make the first snapshot classify as operator and flash. | Live multipart rows buffer for a 100 ms quiet period; reclassify on `every()` change; claim softened; fixture. |
| 15 | MINOR | §4, §9.4 | Text-part `synthetic`/`ignored` and tool `title` location were underspecified. | Add `synthetic?`/`ignored?`; do not render ignored text but classify it; verified `state.title`, `part.title` only compatibility fallback. |
| 16 | MINOR | §7.1 | A 64 KiB text plus JSON overhead exceeds the 64 KiB body cap. | Text cap lowered to 32 KiB; boundary/413 tests. |
| 17 | MINOR | §10.1 | Sessions rail signature omitted selection/search/runtime/prompt state. | Signature includes `sessionId`, search needle, prompt counts/flags, runtime, deleting/creating; repaint test. |

### Disposition

1. **Fixed** in §4 (frame fact), §6.3-6.4 (8 MiB app cap, oversize rule, memory tradeoff), §9.4
   (conditional full-output copy), §13 R7/R13, §14.2 (>1 MiB bash and >8 MiB frame tests).
2. **Fixed** in §6.3 (`parentID` forwarding), §8.1-8.2 (`parentID`, boundary, active/queued invariants),
   §9.5 (queue count), §9.8-9.9 (states/strip), §13 R15, §14.1/14.3 (combined/consume-race/bare-shell).
3. **Fixed** in §8.2 invariant 3, §8.3 step 6, §8.4, §9.5, §14.3 (reload sealing matrix).
4. **Fixed** in §9.6 (`allPendingForSession` vs `dockRenderEntries`), §14.3 inline-pending gate test.
5. **Fixed** in §9.6 (local draft vs answered-elsewhere; part-only answers), §14.3 two-tab/delayed-part.
6. **Fixed** in D3 and §9.6: valid tool ref always inline, `part-unavailable`, dock only no-tool-ref;
   omitted/mismatch browser fixtures.
7. **Fixed** in §6.4 prompt/todo budget, §9.6/9.8 tooLarge states, §12, §14.1-14.2 boundary tests.
8. **Fixed** in §6.3 `sawDelta` policy, §8.2 invariant 4 (clear `pendingDeltas`), §14.1/14.3 overlap and
   snapshot-only tests.
9. **Fixed** in §8.2 invariants 5/16, §8.3-8.4 (always apply, merge by ID, follow-up GET, 5 s
   unknown grace with `Check again`/`Remove`), §7.2 step 8, §12, §14.3 hydration/unknown tests.
10. **Fixed** in §11.3/§11.5 module split and `test/chat-core.test.ts`; §14.5 adds the required
    `node docs/design/chat-qa.mjs` browser gate (no product dependency).
11. **Fixed** in §6.4 `MESSAGES_RESPONSE_MAX_BYTES`, §9.4 notice, §12, §14.2, §15.1.
12. **Fixed** in D7, §9.1 shared content box + derived ratio table, §13 R10, §14.3 layout state.
13. **Fixed** in §9.3 grammar/fixtures; §14.1/14.3 cover the listed parser cases.
14. **Fixed** in §9.10 multipart timing/reclassification, §14.3 fixture; the absolute "cannot flash"
    claim is removed.
15. **Fixed** in §4 (text-part contract), §6.4 (preserve flags), §9.2/9.4 (ignored rendering,
    `state.title`), §9.10.
16. **Fixed** in §7.1 32 KiB text cap, §14.2 boundary/413 tests.
17. **Fixed** in §10.1 full sessions signature, §14.3 repaint test.

What clears the block: findings 1-2 and majors 3-11 are closed in this revision; `oracle` re-review
must confirm the revised contracts are internally consistent before plan review.

### Re-review (focused, second oracle pass)

Verdict: **PASS WITH CHANGES.** No blockers remained. The frame/typed-event/response caps, snapshot
sealing, `sawDelta`/`pendingDeltas`, question split, prompt budgets, pure-helper module, and
width/table grammar were confirmed closed. Two majors remained, and this revision applies them:

1. **Queue turn-state.** `message.updated` now carries `finish`; `turnContinues` is true for an
   uncompleted assistant or `finish:"tool-calls"` (with an idle `session.status` override), and
   `activePromptID` tracks the accepted head. This distinguishes a tool-gap from a new turn and
   prevents both queued prompts being hidden and current prompts being counted as queued. The
   requirement, failure table, and tests were updated.
2. **Unknown-acceptance reconciliation.** Hydration always applies the snapshot and merges local
   optimistic rows by server ID; a turn change schedules one follow-up rather than discarding the
   history. An absent `unknown` row gets a 5 s grace and explicit `Check again`/`Remove`, so the send
   gate cannot deadlock.

The remaining minors from the second pass are applied: the §3 R15 wording, question state precedence
and `answered`/local-draft wording, OMO multipart fixture timing, bounded parser identity salvage and
warning dedupe, the bounded messages-reader timeout/`messages_too_large` notice, UTF-8 async text cap,
below-768 composer padding wording, boot status with an active prompt, and the top-bar other-session
count clarification. Owner decisions are closed in §16. The design gate is cleared for the plan;
`momus` plan review is next.
