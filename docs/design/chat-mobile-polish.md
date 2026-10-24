# Design - Mobile chat polish and turn control

Status: **implemented and verified (automated)** (2026-10-24); browser QA blocked by the container's
missing Chromium host libraries; real-device mobile QA pending. Background stream recovery follow-up
in journal 0030. Design review: rounds 1-6 CHANGES REQUESTED, findings folded; **round 7 PASS**
(non-blocking notes folded). Plan: `docs/plans/0025-chat-mobile-polish.md`; journal:
`docs/journal/0029-chat-mobile-polish.md`.

Scope: the chat client (`assets/chat.js`, `assets/chat-core.js`), chat markup and routes
(`src/http/chat.ts`), the shared page shell (`src/http/ui.ts`), prompt warnings
(`src/http/prompts.ts`), the opencode HTTP client (`src/opencode/client.ts`), the instance manager
(`src/opencode/manager.ts`), and chat CSS (`src/http/styles.css`).
Out of scope: implementation in this document.

## 1. Problem

The operator uses the chat workspace primarily from a phone. Nine defects make that surface
unreliable: the composer loses and reopens the virtual keyboard on send, Enter cannot insert a
newline on touch devices, a startup policy-verification failure is shown as a permanent policy
banner, near-bottom autoscroll is instant instead of smooth, the plan block is visible before a
plan exists, there is no way to stop a running turn, reasoning blocks have no generation timer,
reasoning deltas briefly render as ordinary assistant text, and the request timer starts from page
open until message hydration corrects it.

## 2. Requirements

| ID | Requirement |
| --- | --- |
| R1 | Sending from a touch device keeps the composer focused and the virtual keyboard open; the chat layout shrinks to the visible viewport instead of being overlapped. |
| R2 | On a coarse pointer, plain Enter inserts a newline; sending is done with the Send button (or Cmd/Ctrl+Enter on a hardware keyboard). Desktop Enter semantics are unchanged. |
| R3 | `policy_unverified: agent policy verification failed` is not shown as a chat policy banner. Real policy findings remain visible. |
| R4 | Autoscroll engages only near the bottom and is smooth, including while streaming; user scrolling cancels it; reduced motion is respected. |
| R5 | The plan section, its divider, and the plan chip are hidden until the active session has at least one rendered Todo item. |
| R6 | A Stop action appears in the composer when the composer is empty and the agent is running; it aborts only the current turn and leaves already-queued prompts untouched. |
| R7 | A reasoning block that is still generating shows elapsed time from its `time.start`; the final duration remains when it completes. |
| R8 | A reasoning delta never renders as ordinary assistant text before its part type is known. |
| R9 | The request elapsed timer shows nothing until a real start time is known; it never starts from page open. |
| R10 | No regression in send/queue, session switching, pagination, questions/permissions, tool streaming, OMO cards, markdown/tables, context compaction, previews, SSH approvals, or the plan panel once a plan exists. |

## 3. Current facts

- The chat page is server-rendered markup plus a native ESM client (`assets/chat.js`); CSS source is
  compiled from `src/http/styles.css` to `assets/app.css` by `npm run build:css`.
- The composer button is `type="submit"`; `sendPrompt()` clears the textarea and re-focuses it after
  the async `202` (`assets/chat.js:8813`). There is no `visualViewport` handling in chat.
- A plain Enter without Shift sends on every device (`assets/chat.js:9063-9067`).
- `GET /api/apps/:app/prompts` merges degraded prompt-source warnings and
  `manager.policyWarnings()` into one `warnings` array (`src/http/prompts.ts:501-538`).
  `policy_unverified:` is produced when the best-effort post-start verifier throws or times out
  (`src/opencode/policy.ts:428-467`).
- `isAtBottom()` uses an 80px threshold; `flushFrame` writes `scrollTop = scrollHeight` instantly
  (`assets/chat.js:4020-4108`). There is no smooth scroll path. The scroll handler loads older
  history when `scrollTop <= 120` (`assets/chat.js:9099-9110`).
- The plan section is always in the HTML (`src/http/chat.ts:406-410`); `renderPlan()` never hides the
  section, and `updatePlanChip()` unhides the chip whenever a session is selected
  (`assets/chat.js:7156-7257`). `renderPlan()` keeps cached Todos visible when a refresh fails
  (`assets/chat.js:7216-7248`), which the resized visibility rule must preserve.
- The pinned upstream `opencode` is 1.19.3 (`Dockerfile:6`). It exposes
  `POST /session/{id}/abort` (200 boolean; SDK `session.abort({ path: { id } })`). The handler calls
  `promptSvc.cancel(sessionID)`. A cancelled turn publishes `session.error` whose serialized error
  name is `MessageAbortedError` (upstream `AbortedError`; the abort `DOMException` is mapped through
  `MessageV2.fromError`) and settles the session to `idle`. Hanse has no abort client or route
  today.
- Reasoning part snapshots carry top-level `time.start`/`time.end`; the event projector preserves
  them. Reasoning deltas can arrive before a part snapshot; the client currently creates a
  provisional `type: "text"` part (`assets/chat.js:4576-4586`) and later recreates the node as a
  reasoning block.
- `startElapsed()` falls back to `Date.now()` when no prompt is known (`assets/chat.js:750-755`);
  SSE `session.status: busy` can arrive before `/messages` hydration.
- `ContextSnapshot.status` is a string (`"busy" | "retry" | "idle" | "unknown"`), while
  `store.agentStatus` is an SSE status object read through `.type` (`assets/chat.js:544-550`).

## 4. Decisions

### D1 - Preserve composer focus and size the chat to the visual viewport (R1)

**Focus.** Tapping Send must not move focus out of the textarea. The Send control gets a
`mousedown` handler that calls `preventDefault()`, matching the existing command listbox pattern
(`assets/chat.js:9087-9097`). Do **not** prevent `touchstart`: canceling it suppresses the synthesized
click on iOS Safari, so Send and Stop would stop working. The handler is attached directly to the
button (no `event.target` check, because the target may be the inner SVG).

`sendPrompt()` stops unconditionally re-focusing after acceptance. It captures
`wasFocused = document.activeElement === promptEl` before its first await, and restores focus after
the `202` only when the field had focus and nothing else took it (`document.activeElement` is
`body`/`null`). If the user moved to another control while the POST was in flight, focus is not
stolen; if the button somehow took focus, it is not restored (that is the dismiss/reopen loop).

**Viewport.** Add a chat-only `syncChatViewport()` that reads `window.visualViewport` and sets
`--chat-keyboard-inset` on the document element. Compute the inset only when
`Math.abs(visualViewport.scale - 1) <= 0.01` (pinch zoom is not a keyboard); otherwise set `0`.
Then `inset = max(0, round(innerHeight - visualViewport.height - visualViewport.offsetTop))`.
Run it once at boot and on `visualViewport.resize`, `visualViewport.scroll`, `window.resize`,
`focusin`, `focusout`, and `orientationchange`, debounced with `requestAnimationFrame`. CSS applies
the inset to the chat shell:
`.chat-shell--workspace { block-size: calc(100% - var(--chat-keyboard-inset, 0px)); }`.
The height chain is correct: `.app-shell` is `100dvb`, `.shell-main` gives the page a definite
height, `.page__body--chat` is `100%`, and `.chat-shell--workspace` is `100%` of that.

The chat page passes a `viewport` string to the shared shell:
`width=device-width, initial-scale=1, interactive-widget=resizes-content`. The meta is **not**
changed globally; `documentPage`/`ShellOptions` gain an optional `viewport` and other pages keep the
current value. Chrome Android then resizes the layout viewport, making the JS inset ~0; iOS Safari
ignores the hint and uses the `visualViewport` inset. No `viewport-fit=cover` is added, so
`env(safe-area-inset-*)` stays 0 and no composer safe-area rule is added (it would be inert).

**iOS zoom.** Under `@media (pointer: coarse)`, `.composer .textarea` uses `1rem` (16px) so iOS does
not auto-zoom on focus; the current mobile `--text-body` is 15px.

Rejected: a fixed composer overlay. It would not fix the keyboard-overlap for the feed and would
require a matching feed bottom inset. Rejected: only the meta tag; iOS Safari ignores it. Rejected:
`touchstart` preventDefault; it breaks tap-to-send on iOS.

### D2 - Coarse-pointer Enter inserts a newline (R2)

Detect `(pointer: coarse)` with a cached `matchMedia`, updated on `change`. In the composer keydown:

- palette open: existing selection behavior;
- `metaKey`/`ctrlKey` + Enter: send (hardware keyboard escape hatch);
- coarse pointer: plain Enter and Shift+Enter insert a newline;
- fine pointer: Enter sends, Shift+Enter inserts a newline.

The server-rendered textarea gets `enterkeyhint="enter"`. `syncComposer()` updates the hint to
`Enter for a new line · Send button to send` on coarse pointers and keeps the current hint on fine
pointers. The command palette remains Enter-driven because it is a selection surface, not a message
composer.

Rejected: sniffing the user agent or `maxTouchPoints`; `(pointer: coarse)` is the media feature that
matches the primary input and updates when a mouse is connected.

### D3 - Treat `policy_unverified` as a diagnostic, not a chat policy warning (R3)

`manager.policyWarnings` stays unchanged (real mismatch findings and the verification failure/timeout).
`handlePromptsList` filters warnings whose trimmed value starts with `policy_unverified:` before
returning them to the browser. After verification, the manager logs every returned
`policy_unverified:` warning (failure and timeout) once per start as a bounded
`policy_verification_failed` warning, so both remain diagnosable without a permanent chat banner.

Rationale: the text means "the coordinator could not verify the runtime policy", not "the runtime
policy is wrong". Showing it on every `/prompts` hydrate is noise and it is not actionable from the
chat. Real findings (`agent "x": question is not allowed`, path mismatches, etc.) remain visible.

Rejected: persisting dismissal in local storage. It hides real findings on a new device and does not
address the classification. Rejected: lengthening verification timeouts in the start path; that
delays every agent start and still leaves a misleading banner when verification genuinely fails.

### D4 - One smooth, cancellable near-bottom scroll controller (R4)

Replace direct `scrollTop = scrollHeight` writes with a controller:

- Threshold: `AUTOSCROLL_THRESHOLD_PX = 32` (down from 80). `isAtBottom()` uses it to decide
  whether the controller may enter the pinned state.
- A `scrollPinned` flag is the controller's real state: it becomes true when `isAtBottom()` is true
  (or `forceBottom` is requested), and stays true while content keeps growing even if the eased
  position temporarily lags more than the threshold behind `scrollHeight`. This avoids the
  fast-stream trap where a lagging animation looks “not at bottom” and stops pinning.
- `requestBottomScroll({ force, instant })` is **idempotent**: one `scrollRaf` handle; if the loop is
  already running, it only refreshes the live target and returns. The loop eases `scrollTop` toward
  the live `scrollHeight` every frame, and stops when within 0.5px, when the session/feed resets, or
  when the user scrolls up.
- `flushFrame` computes `follow = !prepend && (settings.forceBottom || scrollPinned)` once, after
  setting `scrollPinned = true` when `isAtBottom()`. When `follow` is true it requests the bottom and
  **skips anchor capture/restore** (the controller owns the scroll position); prepends keep the
  existing anchor restoration and never request the bottom. This prevents a streaming flush from
  anchor-restoring the feed backwards while the smooth scroll is still catching up.
- User intent is detected from the scroll direction, not from an input-device list: the controller
  only ever increases `scrollTop`, so a `scroll` event that observes `scrollTop < lastScrollTop - 1`
  clears `scrollPinned`, sets a paused flag, and stops the animation. This covers wheel, touch,
  keyboard PageUp/Home/arrows, and native scrollbar drags in every browser. Upward `wheel` and
  `touchmove` may cancel earlier for responsiveness. `lastScrollTop` is updated on every scroll and
  reset with the feed.
- Programmatic writes are not user intent. `restoreScrollAnchor()` (`scrollEl.scrollTop += ...`,
  which can be negative) and the instant `flushFrame` set can both decrease/clamp `scrollTop` and
  emit the same scroll event as a user. They record `{ expected, expiresAt: now + 250ms }`; the
  scroll listener skips the cancel only for the first scroll event whose observed value matches
  `expected`, then clears the expectation. An unmatched expectation expires after 250ms, so it can
  never suppress a later PageUp/Home. The paused flag clears when a genuine scroll reaches
  `isAtBottom()` again.
- Listener ordering keeps the history path reachable: the scroll handler first updates
  `lastScrollTop`/cancel state, then (when no smooth scroll is active) evaluates the
  `scrollTop <= 120` history branch. A genuine user cancel at the top therefore still loads older
  history after `smoothScrollActive` clears.
- The “New messages” button requests a smooth scroll and does not focus the composer on coarse
  pointers (focusing there reopens the keyboard).
- While a smooth scroll is active, a `smoothScrollActive` guard makes the scroll listener skip
  `loadOlderMessages()` (the `scrollTop <= 120` branch). Otherwise a near-top “New messages” click
  would emit scroll events in the history range and prepend an older page. The guard clears when the
  controller stops.
- Initial load and session switch use `instant: true` when the feed is replaced, so opening a
  30-message tail does not animate through the whole page. Every subsequent near-bottom autoscroll,
  including streaming, is smooth.
- `prefers-reduced-motion: reduce` forces instant behavior.
- The easing step and the follow decision are pure helpers in `assets/chat-core.js` for unit testing.

Rejected: CSS `scroll-behavior: smooth` alone. Repeated writes on every streaming flush restart the
native animation and produce lag/jitter; the controller needs a live target, a single handle, and a
user-cancel path. Rejected: smooth only on send/“New messages”; the owner asked for smooth autoscroll
always during streaming.

### D5 - Plan UI exists only when the active session has rendered Todos (R5)

- The server renders `#chat-plan-section` and its preceding divider with `hidden`; the divider gets
  `id="chat-plan-divider"`. The divider after the plan (before Saved permissions) gets
  `id="chat-saved-divider"` and is hidden together with `#chat-saved-section`, so hiding the plan
  never leaves two consecutive rules before Handoffs.
- `renderPlan()` derives `planVisible` from the Todos it is actually rendering, not from
  `todoState` alone: `sessionId !== null && renderedTodos.length > 0`. Cached Todos count when a
  refresh fails (`todoState === "error"` with a cache), preserving the “Not updating” plan view
  (R10). Loading/error with no cache and the empty list are hidden.
- `renderPlan()` toggles only the section, the plan divider, and the chip. The divider after the
  plan (before Saved permissions) gets `id="chat-saved-divider"`, is rendered `hidden` in the server
  markup, and is toggled by `renderSavedPermissions()` from `savedSection.hidden`, because that
  function is the only writer of the Saved section and a revoke does not call `renderPlan()`. A
  rejected `/permissions/saved` hydrate leaves the server-rendered hidden state intact, so a failed
  fetch cannot leave two consecutive rules before Handoffs.
- `updatePlanChip()` stops deriving visibility from `sessionId`; it uses the `planVisible` state, so
  `syncComposer()` cannot unhide the chip before Todo data arrives.
- The chip label remains `Plan N/M` when visible. A later empty Todo list hides the block again.

Rejected: hiding only the list and keeping the “No plan yet” empty state. That is the current
behavior and is exactly the reported noise. Rejected: hiding on any `todoState === "error"`; that
would make a cached plan disappear on a transient refresh failure.

### D6 - Add a human-only abort route and a Stop/Send composer action (R6)

**Upstream client.** Add `abortSession(endpoint, sessionId, options?)` to `src/opencode/client.ts`:
`POST /session/{id}/abort`, authenticated like other calls, 10s reply timeout, parse the boolean
body.

**Coordinator route.** Add `POST /api/apps/:app/sessions/:sid/abort?project=<id>` in
`handleChat` (plus the abort regex, the `appKey` extraction, and the route null-check). It is
human-only (403 for agent principals) and resolved **before** `manager.ensure`, using
`manager.endpointFor(appId)` so an abort never starts a stopped agent. Check the deletion markers
(`found.app.deleting` / `found.project.deleting`) before `endpointFor` and return
`409 {code:"deletion_pending"}`. Not running → `503 {code:"agent_not_running"}` (matching the
context route); upstream 404 → `404 {code:"session_not_found"}`; other upstream/transport failure →
`502 {code:"abort_failed"}`; success → `200 {aborted: boolean}`. No request body is required.

**Client action.** The primary composer button is mode-dependent, rendered by one
`updateComposerAction()` path (also called by `syncComposer()` and the textarea input listener):

- `composerAction({ turnActive, hasDraft, sessionId, acceptanceBusy, promptsWaiting, abortPending })`
  is a pure helper in `assets/chat-core.js`.
- `stopMode = turnActive && !hasDraft && sessionId !== null && !acceptanceBusy`, where `turnActive`
  is `session.status busy|retry` only. A bare `activePromptID` does not count: after an abort the
  queue derivation can promote a pending prompt while the session is idle, and that must not present
  a Stop (or a phantom running turn). A pending question/permission does **not** hide Stop: the
  owner rule is “empty composer + live turn”, and Stop is the way out of a turn that is waiting on a
  prompt. The Send path remains disabled while a prompt dock is waiting.
- Stop mode renders a new `stop` icon and “Stop”, sets the button `type="button"` (the `required`
  textarea must not block the click), and disables it while `abortPending` is true.
- Send mode restores `type="submit"`, the send icon, and “Send”; disabled when an acceptance is in
  flight/unknown or a prompt dock is waiting. The existing submit/keydown paths are unchanged.
- `syncComposer()` delegates the primary button's `disabled`/`type`/icon/label entirely to
  `updateComposerAction()`; it keeps only `waitingEl`, the hint text, and the non-button composer
  state. The current direct `sendButton.disabled = sending || promptsWaiting` write is removed, so a
  pending dock cannot disable Stop.
- On click, set a per-session `abortPending` flag **before** the POST, set a per-session
  `suppressAbortUntil = now + 15s`, call the route, and keep the button in a stopping state until
  `session.status idle` or the context snapshot reports idle. `abortPending` is cleared on idle,
  failure, session switch, or deletion; the suppression grace is independent, so a late
  `MessageAbortedError` cannot re-enter the failure path. `updateComposerAction()` is called from the
  textarea input listener, `syncComposer()`, and `applyAgentStatus()` in both its idle and busy
  branches, so a status change alone cannot leave a stale Stop.
- A successful abort starts a bounded settle poll (`refreshContext` immediately, then every 1s for up
  to 10s while `abortPending` is set). This is the trigger for the context-idle fallback when the SSE
  idle frame is missed. The poll stops on idle, a different-name error, or the deadline; on deadline
  it clears `abortPending`, refreshes messages, calls `clearSessionPrompts` + `hydrate()` so a
  still-pending dock is not left invisible, and shows a retryable “Stopped; status is reconciling.”
  notice.

**Abort outcomes.** On `200 {aborted:false}`, clear `abortPending`, refresh runtime/context status,
and show a retryable “The turn was already idle.” message; do not insert an error card. On
`503 agent_not_running`, clear and show “The agent is not running.” On `404`/`502`/transport failure,
clear `abortPending`, keep the turn, and show a retryable message in `#chat-send-error`. Whenever
`abortPending` changes in any of these outcomes, call `updateComposerAction()` explicitly, so the
Stop control cannot remain disabled after a failed abort even when no status event follows.

**Queue state after abort.** The block lives **outside the store** in a module-level
`queuePromotionBlocked` Set of session IDs (like `promptActivation`), because `applySnapshot` and
`rekeyOptimistic` rebuild the store object and would drop a store field. It is added **only after
`200 {aborted:true}`**; `aborted:false`, `404`, `502`, and transport failures do not add it and
remove any stale entry for that session. `recomputeQueue()` reads
`queuePromotionBlocked.has(sessionId)` and passes `allowPromotion` to `deriveQueue`. The queue
derivation gains an `allowPromotion` option: when promotion is blocked and the session status is
idle/unknown, pending user messages stay in `queuedIDs` and no `activePromptID` is chosen. The
internal `deriveQueue` calls inside `applySnapshot` (`assets/chat-core.js:1145`) and `rekeyOptimistic`
(`:1417`) also receive `allowPromotion` (threaded through their options) so a reconcile or an
acceptance rekey cannot re-promote. `resolveActiveStatusLabel()` gains a `queueBlocked` input and
returns `Ready` for a blocked idle session even with a non-empty queue, so the elapsed timer and the
“Working” label do not start for a prompt upstream is not running. The queue strip still lists the
prompts.

The block clears only when an **SSE `session.status` transitions from `idle` to `busy|retry`** (a new
turn actually started after the abort) or on session deletion. A coordinator context snapshot
reporting `busy`/`retry` is the **same** aborted turn and must not clear it: the abort settle poll
normally observes `busy` until the turn settles, and clearing there would reintroduce the phantom at
idle. While `abortPending` is set, an SSE busy/retry is ignored; once `abortPending` clears (the idle
was observed), the next idle→busy/retry transition is a real new turn and clears the block. The 15s
`suppressAbortUntil` grace is **only** for `MessageAbortedError` suppression and does not gate block
clearing, so a new prompt or an auto-run queued prompt inside the grace still shows Working. The Set
survives session switches and store rebuilds. It is mirrored to `sessionStorage` under
`hanse-chat-queue-blocked:${projectId}:${appKey}` (best effort, try/catch) and loaded at boot, so a
page reload after an abort does not recreate the phantom turn; a reload with the old turn still busy
keeps the block until a real idle→busy transition. If storage is unavailable, the in-memory Set is
the fallback and reload survival is a known limit. This prevents the phantom turn the old
`deriveQueue` promotion would create after an abort.

**Prompt dock after abort.** Stop can be used while a question/permission dock is open. The abort
path therefore reconciles prompts: on a successful abort it removes the aborted session's entries
from the local prompt map immediately (`clearSessionPrompts(sessionID)`, which re-renders the dock,
inline questions, the queue, and the composer), then calls the existing `hydrate()` after idle so
the authoritative `/prompts` response can re-add anything upstream still lists. This guarantees
`promptsWaiting` becomes false and Send returns after idle even if upstream does not emit
`question.rejected`/`permission.replied` for the cancelled turn.

**Intentional-abort suppression.** Upstream publishes `session.error` when a turn is cancelled; the
serialized error name is `MessageAbortedError` (upstream `AbortedError`). When the event's session is
within `suppressAbortUntil` and the error name is `MessageAbortedError` (with the abort message as a
fallback), the client settles the turn as stopped instead of running the normal failure path: do not
mark prompts `failed`, do not drop the queue, do not insert the “Agent error” card, and do not show
the error toast. Announce “Stopped.” and settle idle. A real error while aborting (different name)
still takes the normal path and clears the grace. The `name` field is already projected by
`src/opencode/events.ts` (`sessionError`), so no server event change is needed.

**Busy state on reload.** `refreshContext()` already fetches a context snapshot with
`ContextSnapshot.status` (a string). When `store.agentStatus` is still unset and the snapshot status
is `busy`, `retry`, or `idle`, seed `store.agentStatus = { type: snapshot.status }`, then call
`recomputeQueue()` and `updateComposerAction()` (or `syncComposer()`). When the snapshot status is
`idle` **and an abort is pending or the grace is active**, treat it as authoritative even if
`agentStatus` still says busy: set `store.agentStatus = { type: "idle" }`, clear `abortPending`,
**keep** the session in `queuePromotionBlocked` (it clears only on an SSE idle→busy/retry
transition or deletion), and run the shared idle settle path (`settleSessionIdle()`: flush pending
classifications, `sealAllParts()`, `recomputeQueue()`, `resetElapsed()`, `updateComposerAction()`,
`scheduleIdleReconcile()`, `followUpHydration = false`), then `clearSessionPrompts` + `hydrate()`.
The caller calls `scheduleFlush()` after the helper, exactly as the current SSE-idle branch does.
The SSE-idle branch already runs flush/seal/recompute + `followUpHydration = false` +
`scheduleIdleReconcile()`; the helper adds `resetElapsed()`/`updateComposerAction()` (the missing
composer update is exactly what clears a stale Stop). `scheduleFlush()` is called after the branch
and is idempotent, so the helper does not include it. This is the fallback when the SSE idle frame is
missed; the bounded abort poll above guarantees it runs. A snapshot `busy`/`retry` updates the status
but does **not** clear `queuePromotionBlocked` (see the queue-state rule). This makes Stop appear
after a page reload even if the SSE status event has not arrived yet, and gives R9 a status source
without a new route.

**Queue semantics.** Stop aborts the current run only. Hanse does not delete already-submitted
queued prompts and this stage does not add queue editing. Upstream behavior for an already-queued
`prompt_async` after an abort is recorded by a phase-0 probe, but no UI state depends on auto-run:
the queue block keeps an unanswered prompt queued (not a phantom active turn), and the operator can
send a new prompt to start a turn. If the probe shows upstream auto-runs the queue, the block simply
clears on the resulting `busy` status.

Rejected: restarting the app to interrupt. It kills every session and is far heavier. Rejected:
aborting the browser fetch. Client disconnect only closes the SSE subscription; the upstream turn
continues (verified in the `/stop` design).

### D7 - Per-reasoning generation timer (R7)

Reasoning parts expose top-level `time.start`/`time.end`. Add a pure
`reasoningElapsedMs(time, now)` helper in `assets/chat-core.js` and format it with the existing
`formatElapsed` in `assets/chat.js`. Append a `.tool-call__elapsed.mono` span to the reasoning
`<summary>`.

The span is re-created by every `updateDetailPart()` call for a reasoning part, because that function
rebuilds `<summary>` with `replaceChildren()`. Each rebuild re-registers `{ el, start, end }` for the
**current** node in a `reasoningElapsed` registry. The rendered signature includes
`time.start`/`time.end`, not the live duration, so a tick updates only `el.textContent` and never
re-renders markdown. Entries are removed when the part node is removed, when the part type changes,
and on feed reset.

A dedicated one-second `tickReasoningElapsed()` interval runs while at least one registry entry has
no `time.end`; it stops when no live entries remain. This is independent of the global request
elapsed timer, which is cleared when the turn becomes `Ready`. Completed entries keep their frozen
final duration until the part is removed.

Rejected: calling `flushFrame()` every second. It would re-render markdown and tool bodies for every
open reasoning block. Rejected: coupling the reasoning tick to `tickElapsed()`; `resetElapsed()`
clears that interval, so a reasoning block could stop ticking.

### D8 - Use the delta's part type before creating a provisional part (R8)

The server includes `partType` on `message.part.delta` when it has already seen the part snapshot
(`src/opencode/events.ts:1772-1782`). The client uses it:

- existing part: unchanged;
- missing part with `partType === "text"`: create a provisional text part;
- missing part with `partType === "reasoning"`: create a provisional reasoning part;
- missing part with no `partType`: do not create a visible part and do not queue the delta. The
  event projector forwards the first text/reasoning snapshot (`shouldForwardSnapshot`), which
  carries the full text up to that point; the completion snapshot follows. Dropping the early delta
  trades at most one snapshot interval of text for the elimination of the wrong-type flash.

The status label therefore reads `Thinking`/`Working` from the correct part type instead of briefly
counting a reasoning delta as unsealed text.

Rejected: always creating a text part and correcting it later. That is the reported flash. Rejected:
buffering unknown deltas and appending them to the first snapshot; the snapshot already contains
those characters and the client would duplicate them.

### D9 - Wait for a real elapsed seed (R9)

`statusSeedTime(prompt)` prefers `firstAssistantForPrompt(prompt.id).time.created` (the real turn
start, normalized from seconds if needed) and falls back to `promptActivation` (the observed busy
time) when the assistant record is missing **or its `time.created` is not a finite number**.
`startElapsed()` returns without starting when the seed is null; `renderElapsed()` already hides
empty text and `updateWorkingStatus()` retries on the next status/recompute.

This removes the page-open start: a busy event before hydration no longer creates a timer, and the
timer appears after hydration at the assistant's real created time. `promptActivation` remains the
seed for a freshly sent prompt whose assistant record has not arrived yet. The preference is a pure
`elapsedSeed` helper in `assets/chat-core.js` for unit testing.

## 5. Interfaces and contracts

- New route: `POST /api/apps/:app/sessions/:sid/abort?project=<projectId>`; human-only; JSON
  `200 {aborted: boolean}`; errors `403`, `404 {code:"session_not_found"}`, `409
  {code:"deletion_pending"}`, `503 {code:"agent_not_running"}`, `502 {code:"abort_failed"}`. No
  request body.
- Upstream call: `POST /session/{id}/abort`, authenticated, 200 boolean. No version probe; a 404
  from an image without the route maps to `404 session_not_found` (the pinned image has the route).
- `src/opencode/client.ts` gains `abortSession`; `src/http/chat.ts` gains the abort route and its
  error mapping.
- `assets/chat-core.js` gains pure `composerAction`, `elapsedSeed`, `provisionalPartType`,
  `reasoningElapsedMs`, and scroll follow/step helpers; `deriveQueue` gains `allowPromotion`;
  `resolveActiveStatusLabel` gains `queueBlocked`. `applySnapshot`/`rekeyOptimistic` accept and
  forward `allowPromotion` so internal queue derivation cannot bypass the block. The per-session
  `queuePromotionBlocked` Set lives in `assets/chat.js`, outside the store, and is mirrored to
  `sessionStorage` under `hanse-chat-queue-blocked:${projectId}:${appKey}`.
- No database, schema, manifest, or settings changes.
- CSS: one new custom property `--chat-keyboard-inset`, a coarse-pointer textarea font rule, and the
  chat-shell height expression. No composer safe-area rule (inert without `viewport-fit=cover`).
- Markup: a `stop` icon symbol, `enterkeyhint="enter"` on the textarea, `hidden` on the plan section,
  plan divider, and saved divider, and `chat-plan-divider`/`chat-saved-divider` ids.
- `documentPage`/`ShellOptions` gain an optional `viewport` string; only the chat page passes
  `interactive-widget=resizes-content`.

## 6. Non-goals

- A separate mobile layout or a mobile-only composer design.
- Queue editing, removing the last user message, or deleting a session from Stop.
- Persisting policy-warning dismissal or adding a policy-warning settings surface.
- Changing the upstream opencode version or its verification timing.
- Smooth-scrolling the initial hydration/session switch through the whole tail.
- `viewport-fit=cover` or topbar/rail safe-area work.
- Reworking pagination, tool rendering, question/permission prompts, OMO cards, or context
  compaction.

## 7. Risks

- `visualViewport` behavior differs between iOS Safari and Chrome; the inset must be verified on a
  real device, including pinch zoom (scale guard) and keyboard open/close, and focus preservation
  must not regress desktop.
- A continuous smooth scroll can fight user scrolling, a streaming flush can anchor-restore the
  feed backwards, and a near-top “New messages” animation can trigger history pagination; the
  single-handle controller, the `follow` branch that skips anchor restore, the `scrollTop`-decrease
  cancel (keyboard/scrollbar included), and the `smoothScrollActive` guard are mandatory and need QA.
- Abort-error suppression could hide a real failure if the grace is stale; it is scoped to the
  session, the `MessageAbortedError` name (with message fallback), and a 15s window, and is cleared
  on a different-name error or session switch.
- After an abort, the queue derivation could promote an unanswered prompt into a phantom “Working”
  turn; the module-level `queuePromotionBlocked` Set (outside the rebuilt store),
  `allowPromotion`/`queueBlocked`, and the threaded `applySnapshot`/`rekeyOptimistic` options are the
  guard, and the queue strip remains the source of truth.
- A missed SSE idle frame could leave a disabled Stop or a stale busy status; the bounded abort
  settle poll plus the authoritative context-idle path (`settleSessionIdle`) is the guard.
- Programmatic `scrollTop` writes (anchor restore, instant set) can look like a user scroll-up; the
  expected-value guard (consumed by the first matching scroll, 250ms expiry) prevents a false cancel,
  and the paused flag clears when the feed reaches the bottom.
- The queue block is in memory plus best-effort `sessionStorage`; if storage is unavailable (private
  mode), a reload loses the block and can briefly re-promote an unanswered prompt. This is recorded
  as a known limit, not a correctness dependency.
- Aborting with an open prompt dock could leave Send disabled; `clearSessionPrompts` plus the
  authoritative `hydrate()` reconciliation is the guard, and QA covers Stop with a pending dock.
- Filtering `policy_unverified` hides a diagnostic from the chat; the manager log records both the
  failure and timeout forms.
- Dropping deltas without a known part type could delay first text if upstream does not forward the
  first snapshot; the projector's `shouldForwardSnapshot` invariant is the guard, and browser QA
  covers streaming.
- Per-reasoning timer updates must not re-render markdown; the registry re-registers the current
  summary element on every detail update and updates text nodes only.
- Upstream queue behavior after an abort is not assumed; a probe records it and the UI does not
  depend on auto-run.

## 8. Acceptance and verification

- R1: on a coarse-pointer viewport, tapping Send leaves the textarea focused and the keyboard open;
  with a simulated/real keyboard inset the composer remains above the keyboard; pinch zoom leaves the
  inset at 0; desktop focus is unchanged. QA uses a `hasTouch`/`isMobile` context for the tap and
  Enter cases; real keyboard behavior is a manual device check.
- R2: coarse pointer + plain Enter inserts `\n`; fine pointer + Enter sends; Cmd/Ctrl+Enter sends on
  both; the hint text matches.
- R3: a `/prompts` response with `policy_unverified: ... failed` or `... timed out` and a real
  mismatch returns only the real mismatch; the chat banner is hidden when only the verification
  failure exists; the manager logs the stripped diagnostic.
- R4: near-bottom streaming autoscroll is smooth; scrolling up with wheel, touch, keyboard
  PageUp/Home/arrows, or a native scrollbar drag stops it; a streaming flush during the animation
  does not anchor-restore it backwards; a programmatic anchor restore/instant set does not count as a
  user cancel, and a stale expectation cannot suppress a later PageUp; a near-top “New messages”
  click does not request older history; reduced motion is instant; initial load/session switch are
  instant.
- R5: before any Todo, the context rail has no Plan heading, divider, or chip; after the first
  `todo.updated`/Todo fetch with items, all three appear; an empty list hides them again; a failed
  refresh with cached Todos keeps the cached plan and “Not updating”; revoking the last saved
  permission hides the saved divider with the saved section; a failed saved hydrate leaves the
  server-rendered hidden divider; no consecutive rules remain before Handoffs.
- R6: Stop appears only when the composer is empty and `session.status` is `busy`/`retry`, including
  while a question/permission dock is open; typing switches to Send; clicking Stop aborts the
  current turn, a `MessageAbortedError` does not produce an “Agent error” card/toast, the queue is
  untouched, and Send returns after idle. Stop is not offered for a bare `activePromptID` on an idle
  session. A successful abort keeps unanswered prompts queued (no phantom “Working” turn), and this
  survives idle reconcile, session switching, and (with storage available) a page reload; the prompt
  dock is cleared/reconciled so Send is not stranded. A missed SSE idle frame is settled by the
  bounded abort poll/context-idle path, and the deadline path also rehydrates prompts. A stopped
  agent never starts because of the abort route; `endpointFor` is used and `ensure` is not called.
- R7: a streaming reasoning block shows an advancing elapsed value; after completion it freezes at
  the final duration; no full markdown re-render occurs on each tick; the timer survives a
  `Ready` transition long enough to show the final value.
- R8: a reasoning delta arriving before its snapshot never renders in `.message__body`; the
  reasoning block appears directly.
- R9: after a reload during a live turn, no elapsed value is shown until hydration supplies the
  assistant `time.created`, then the real elapsed appears without a page-open jump; an assistant
  record without a finite `time.created` falls back to the activation time.

Automated gates: `npm run lint`, `npm run typecheck`, `npm test`, `npm run build`. Targeted tests:
`test/chat-core.test.ts` (`composerAction`, `elapsedSeed`, `provisionalPartType`,
`reasoningElapsedMs`, scroll follow/step helpers, `deriveQueue` `allowPromotion`, and
`resolveActiveStatusLabel` `queueBlocked`), `test/client.test.ts` (`abortSession` path, auth,
boolean body, error mapping), `test/chat-page.test.ts` (abort route: human-only, `endpointFor`
without `ensure`, 409/503/404/502, success; plan markup hidden + divider ids),
`test/prompts-http.test.ts` (failure/timeout filter, real warning preserved). Browser checks extend
`docs/design/chat-qa.mjs` with a `hasTouch`/`isMobile` context for Enter, Stop/Send, Stop with a
pending dock, plan visibility (including cached-error), reasoning delta/timer, abort-error
suppression, queue-after-abort (no phantom Working), keyboard/scrollbar scroll cancel, and near-top
“New messages” without a history request. Three queue-lifecycle cases are explicit: (a) abort → idle
→ a new prompt (or an upstream auto-run) produces an SSE idle→busy/retry and the mirrored
`sessionStorage` block entry is removed (assert the storage key, not just the Working label, which
also shows from busy alone), and the queued prompt promotes; (b) a reload with `sessionStorage`
available keeps the block (no phantom) and a storage-unavailable run falls back to in-memory with
the documented limit; (c) the 10s settle-poll deadline / missed idle reconciles messages and
rehydrates prompts without leaving a disabled Stop. The phase-0 abort/queue probe is recorded in the
journal; real keyboard/viewport behavior is a manual device check because the harness cannot open a
virtual keyboard.

## 9. Owner decisions (closed)

- The reported policy banner text is `policy_unverified: agent policy verification failed`; it must
  not be shown in chat. Real policy findings remain.
- Stop appears when the composer is empty; typing switches the primary button back to Send. Stop
  interrupts the current turn only.
- Autoscroll is smooth whenever it engages, including during streaming.
- Consequence recorded for the plan: because the composer stays empty while a question/permission
  dock is open, Stop is available there too; this follows the owner rule and is not a separate
  decision.

## 10. Review

### Round 1 (`oracle`) - CHANGES REQUESTED

| # | Finding | Resolution in this revision |
| --- | --- | --- |
| 1 | `touchstart` preventDefault suppresses tap-to-send | D1 uses only `mousedown`, direct button listener; QA taps Send and Stop with `hasTouch`. |
| 2 | Pinch zoom treated as a keyboard | D1 guards on `visualViewport.scale === 1`; adds `window.resize` and a boot call. |
| 3 | Global `interactive-widget` and inert safe-area rule | D1 adds a `viewport` option used only by the chat page; safe-area rule dropped. |
| 4 | Context status is a string, not an SSE object | D6 seeds `{ type: snapshot.status }` and calls `recomputeQueue` + composer action. |
| 5 | Typing does not re-run composer state | D6 introduces `updateComposerAction()` called from input and `syncComposer`; `composerAction` is a pure helper. |
| 6 | “No prompt dock” contradicts the owner rule | D6 removes it; Stop is available with a pending dock, Send stays disabled. |
| 7 | Abort failure/`aborted:false`/late error can strand or fail | D6 adds outcome handling, a 15s suppression grace, idle fallback via context, and one status mapping (`503`). |
| 8 | Hiding on `error` regresses a cached plan | D5 derives visibility from rendered Todos, including cached ones. |
| 9 | Plan divider leaves a rule artifact | D5 adds a saved-section divider id and hides it with the saved section. |
| 10 | Reasoning registry goes stale / ticks stop | D7 re-registers the current element on every update and uses a dedicated reasoning interval. |
| 11 | Smooth “New messages” triggers history pagination | D4 adds a `smoothScrollActive` guard around history loading. |
| 12 | Controller not idempotent / anchor restore fights it | D4 uses one `scrollRaf` handle, a single `follow` decision, and skips anchor restore while following. |
| 13 | Queue semantics asserted, not verified | D6 and the plan add a phase-0 probe; no code depends on auto-run. |
| 14 | Timeout form not logged | D3 logs every returned `policy_unverified:` warning. |
| 15 | Assistant record without `time.created` yields a null seed | D9 falls back when `time.created` is not finite. |
| 16 | QA has no touch context / helpers untested | §8 adds `hasTouch`/`isMobile` and pure-helper tests, including `endpointFor` without `ensure`. |

Round 2 review: CHANGES REQUESTED. Findings folded in this revision:

| # | Finding | Resolution in this revision |
| --- | --- | --- |
| 1 | Queue fallback is false: idle `deriveQueue` promotes a pending prompt into a phantom Working turn | D6 adds per-session `queuePromotionBlocked`, `deriveQueue` `allowPromotion`, `resolveActiveStatusLabel` `queueBlocked`, and derives Stop from `busy|retry` only. |
| 2 | Aborting with a pending dock can strand Send | D6 adds `clearSessionPrompts` on abort plus authoritative `hydrate()` reconciliation. |
| 3 | User-cancel misses keyboard scrolling and scrollbar drags | D4 cancels on an observed `scrollTop` decrease, which covers every input device. |
| 4 | Saved divider is written by `renderSavedPermissions`, not `renderPlan` | D5 moves the saved-divider toggle into `renderSavedPermissions`. |
| 5 | Idle composer re-render hook unspecified | D6 calls `updateComposerAction()` from `applyAgentStatus` both branches and unconditionally on a context `idle` snapshot. |

Round 3 review: CHANGES REQUESTED. Findings folded in this revision:

| # | Finding | Resolution in this revision |
| --- | --- | --- |
| 1 | Queue block dropped by `applySnapshot`/`rekeyOptimistic` store rebuilds | D6 moves it to a module-level per-session Set and threads `allowPromotion` through both internal `deriveQueue` calls. |
| 2 | Context-idle fallback has no trigger and does not clear a stale busy status | D6 adds a bounded abort settle poll and makes an idle snapshot authoritative during the abort grace, running `settleSessionIdle()`. |
| 3 | Decrease-based cancel false-positives on anchor restore/instant set | D4 adds `ignoreProgrammaticScroll`/expected-value guards and clears paused at the bottom; history evaluation stays reachable. |
| 4 | `syncComposer` still writes `sendButton.disabled` | D6 makes `updateComposerAction()` the sole button writer; `syncComposer` keeps only hint/`waitingEl` state. |
| 5 | Saved divider not guaranteed hidden on a failed saved hydrate | D5 renders the saved divider hidden server-side; `renderSavedPermissions` toggles it. |

Round 4 review: CHANGES REQUESTED. Findings folded in this revision:

| # | Finding | Resolution in this revision |
| --- | --- | --- |
| 1 | Context-idle path deletes the queue block (the review read an older revision; current text said **keep**) | Verified the current D6 keeps the block through idle; only `busy`/`retry`/deletion clears it. |
| 2 | `settleSessionIdle()` drops the message reconcile | D6 adds `scheduleIdleReconcile()` and `followUpHydration = false` to the helper and states the SSE-idle branch may use it unchanged. |
| 3 | Queue block does not survive a page reload | D6 mirrors the Set to `sessionStorage` (`hanse-chat-queue-blocked:${projectId}:${appKey}`, best effort) and loads it at boot; storage-unavailable is a recorded limit. |
| 4 | Abort deadline leaves a prompt dock invisible | D6 calls `clearSessionPrompts` + `hydrate()` on the deadline path too. |
| 5 | Programmatic-scroll expected-value lifetime unspecified | D4 consumes the expectation on the first matching scroll and expires it after 250ms. |

Round 5 review: CHANGES REQUESTED. Findings folded in this revision:

| # | Finding | Resolution in this revision |
| --- | --- | --- |
| 1 | Adjacent “context busy/retry clears the block” contradicts keep-through-idle | D6 removes it; only an SSE idle→busy/retry transition (new turn) or deletion clears the block. |
| 2 | `settleSessionIdle` wording claimed no behavior change | D6 states the SSE-idle branch gains `resetElapsed()`/`updateComposerAction()` and keeps its existing reconcile; `scheduleFlush` remains outside. |
| 3 | Storage key not app-global | D6 uses `hanse-chat-queue-blocked:${projectId}:${appKey}`. |
| 4 | Deadline path misses `hydrate()` | D6 adds `clearSessionPrompts` + `hydrate()` on the deadline branch. |
| 5 | Expected-scroll lifetime unspecified | D4 consumes the first matching scroll and expires after 250ms. |
| 6 | Abort poll's busy snapshot could clear the block | D6 ignores context busy/retry for clearing while aborting; clears only on an SSE idle→busy/retry transition. |
| 7 | Set add/clear lifecycle on abort outcomes unspecified | D6 adds only on `200 {aborted:true}`; `aborted:false`/failure does not add and removes a stale entry. |
| 8 | Storage key collision across projects | Same fix as #3 (`projectId:appKey`). |
| 9 | “Without behavior change” claim | Same fix as #2. |
| 10 | Stale header | Header now records rounds 1-5 and round 6 pending. |

Round 6 review: CHANGES REQUESTED. Findings folded in this revision:

| # | Finding | Resolution in this revision |
| --- | --- | --- |
| 1 | Suppression grace swallows the first busy of a genuinely new turn | D6 ignores SSE busy only while `abortPending` is set; the 15s grace is only for `MessageAbortedError`. After idle, the next idle→busy/retry clears the block, even inside the grace. |
| 2 | `settleSessionIdle` wording off by one | D6 now states the branch runs flush/seal/recompute + followUpHydration + scheduleIdleReconcile, gains resetElapsed/updateComposerAction, and scheduleFlush stays outside/idempotent. |
| 3 | Verification list missing block-clear, reload/storage, and settle-deadline cases | §8 adds explicit QA cases (a) new turn after abort clears the block, (b) reload/storage and storage-unavailable fallback, (c) 10s settle deadline/missed idle reconciliation. |

Round 7 review: **PASS**. Non-blocking notes folded:

| # | Note | Resolution |
| --- | --- | --- |
| 1 | §10 round-5 rows 2/3 rendered as one malformed row | Split into two rows. |
| 2 | Abort-failure composer re-render was implicit | D6 requires `updateComposerAction()` whenever `abortPending` changes in the failure outcomes. |
| 3 | §8(a) “showing Working” is not discriminating | §8(a) now asserts the `sessionStorage` block entry is removed and the queued prompt promotes. |

**Gate cleared:** design review PASS. The plan is written next.

## Follow-up 2026-10-24: background stream recovery

**Problem.** After a phone browser was backgrounded and restored, the chat stayed `Paused`. The
app SSE's `onerror` counted hidden-tab failures, so three errors closed the source; the
`visibilitychange` handler restarted runtime polling but never checked or replaced the SSE source.
bfcache restores and network changes had the same gap.

**Decision.** Hidden-tab errors set `Reconnecting` without consuming the three-strike budget. On
return, `shouldResubscribe()` replaces a missing/`CLOSED` source, a source still `CONNECTING` after
5 s, or any source after 10 s hidden (half-open protection), while a healthy `OPEN` source survives
a short hide. `pageshow` (persisted) and `online` use the same reconnect path. Reconnect closes the
old source, detaches its handlers, opens a fresh one, and hydrates prompts plus the last message
page. The pure decision is `assets/chat-core.js:shouldResubscribe`; browser coverage is the
`reconnect` scenario in `docs/design/chat-qa.mjs`.

**Verification.** Unit tests cover missing/`CLOSED`, short/long hides, `CONNECTING` grace, and
invalid values. The deterministic browser scenario is added but cannot launch Chromium in this
container; real iOS/Android QA remains pending. Journal: `docs/journal/0030-chat-stream-recovery.md`.
