# 0025 - Mobile chat polish and turn control

- Status: implemented; automated gates green; stage committed as `5a0a121`; background stream recovery
  follow-up in journal 0030; browser QA blocked by missing Chromium host libs (journal 0029);
  real-device mobile QA pending. Design review PASS (`oracle` round 7); plan review PASS (`momus`
  round 3)
- Design: [`docs/design/chat-mobile-polish.md`](../design/chat-mobile-polish.md)
- Design reviewer: `oracle`; plan reviewer: `momus`
- Owner decisions: closed (design §9); no open questions
- Date: 2026-10-24

## Delivery bindings

| Binding | Value |
| --- | --- |
| Stage | `0025-chat-mobile-polish` |
| Design artifact | `docs/design/chat-mobile-polish.md` |
| Plan artifact | `docs/plans/0025-chat-mobile-polish.md` |
| Design index | `docs/design/README.md` |
| Plan index | `docs/plans/README.md` |
| Journal | `docs/journal/0029-chat-mobile-polish.md`; index `docs/journal/README.md` |
| Open questions | none; no `docs/open-questions.md` entry |
| Verification | `npm run lint && npm run typecheck && npm test && npm run build` |
| Extra gate | `npm run check:sensitive`; browser QA `node docs/design/chat-qa.mjs` |
| Commit policy | One coherent stage commit only on explicit owner instruction |

## Global invariants

- No database, schema, manifest, settings, or dependency changes.
- The coordinator's existing chat routes and their response shapes stay unchanged; the abort route is
  additive.
- An abort never starts a stopped agent: it uses `manager.endpointFor`, not `manager.ensure`.
- A human principal is required for abort; agent principals get `403`.
- `policy_unverified:` diagnostics never reach the chat banner; real policy findings do.
- Desktop Enter/focus semantics are unchanged; coarse-pointer Enter inserts a newline.
- The plan section, plan divider, and chip are hidden until the active session renders at least one
  Todo; cached Todos survive a failed refresh.
- The queue block lives outside the thread store and survives `applySnapshot`/`rekeyOptimistic`
  rebuilds, session switches, and (with storage available) reloads; it clears only on a real
  `idle → busy|retry` transition or deletion.
- Intentional abort never marks prompts failed, inserts an Agent error card, shows an error toast,
  or drops the queue.
- Smooth autoscroll is the only scroll path for live following; initial load/session switch remain
  instant; programmatic writes are not user intent; reduced motion is instant.
- Pure helpers stay in `assets/chat-core.js` with no DOM, timers, or storage; all tests remain green.
- No test is deleted, skipped, or weakened.

## Phase 0 - Baseline and upstream probe

Boundaries: no product code. This phase produces evidence for the journal and closes the only
behavioral uncertainty (queued prompts after abort).

Work:

1. Run the baseline gates: `npm run lint`, `npm run typecheck`, `npm test`, `npm run build`. Record
   the starting state.
2. Confirm the pinned upstream contract from the `opencode` 1.19.3 source:
   - `POST /session/{id}/abort` returns 200 boolean and calls the session cancel path.
   - A cancelled turn publishes `session.error` with serialized name `MessageAbortedError` and
     settles `session.status` to `idle`.
   - `MessageV2.fromError` maps the abort `DOMException` to `AbortedError`/`MessageAbortedError`.
3. If a disposable managed app is available, run the queue probe: send prompt A, queue prompt B
   (`prompt_async` while A runs), call `POST /session/{id}/abort`, and record whether B runs, remains
   queued, or is dropped. If no disposable app is available, record the source-level finding and the
   limitation; no UI behavior depends on auto-run.
4. Record the probe result in the stage journal draft before Phase 1. Do not use a production app.

Acceptance: baseline is green; the probe evidence is recorded; no product files changed.

## Phase 1 - Server contracts and pure helpers

Boundaries: `src/opencode/client.ts`, `src/http/chat.ts`, `src/http/prompts.ts`,
`src/opencode/manager.ts`, `assets/chat-core.js`, and their tests. No `assets/chat.js` DOM or CSS.

Work:

1. `src/opencode/client.ts`: add `abortSession(endpoint, sessionId, options?)`.
   - `POST /session/{id}/abort` with the existing authenticated request helper and 10s reply
     timeout; parse the boolean body.
   - Return `true`/`false`; 404/other `OpencodeHttpError` and transport failures propagate.
2. `src/http/chat.ts`: add the abort route.
   - Regex `^/api/apps/([^/]+)/sessions/([^/]+)/abort$`; include it in the route null-check and the
     `appKey` extraction.
   - Principal check before the app lookup: agent principals → `403`.
   - `POST` only; other methods → `405 {error:"method not allowed"}`.
   - After `findApp`: deletion markers → `409 {code:"deletion_pending"}`.
   - Resolve `endpoint = deps.manager.endpointFor(found.app.id)`; undefined →
     `503 {error:"agent is not running", code:"agent_not_running"}`. Do **not** call `ensure`.
   - `abortSession`: upstream 404 → `404 {code:"session_not_found"}`; other
     `OpencodeHttpError`/transport → `502 {code:"abort_failed"}`; success →
     `200 {aborted: boolean}`.
3. `src/http/prompts.ts`: filter `policy_unverified:` from the returned `warnings` (trim before the
   prefix check); keep every real policy finding and the source-degradation warnings.
4. `src/opencode/manager.ts`: after `#verifyPolicy`, log every returned `policy_unverified:` warning
   (failure and timeout) once per start through the optional logger as a bounded
   `policy_verification_failed` entry; keep `policyWarnings` unchanged.
5. `assets/chat-core.js`: add pure helpers and options:
   - `composerAction({ turnActive, hasDraft, sessionId, acceptanceBusy, promptsWaiting, abortPending })`
     → `{ mode: "stop" | "send", disabled }`.
   - `elapsedSeed(assistantCreated, activated)` → normalized ms or `null`; prefer a finite assistant
     time, fall back to activation.
   - `provisionalPartType(partType)` → `"text" | "reasoning" | null`.
   - `reasoningElapsedMs(start, end, now)` → normalized non-negative ms or `null`.
   - `autoscrollFollow({ prepend, forceBottom, pinned })` and `autoscrollStep(current, target, ease)`.
   - `deriveQueue(store, { sessionStatusType, allowPromotion })`: when `allowPromotion === false` and
     pending prompts exist, return them all as `queuedIDs` with `nextActivePromptID: null`.
   - `resolveActiveStatusLabel({ ..., queueBlocked })`: a blocked idle/undefined status returns
     `Ready` before the queue-length fallback.
   - `applySnapshot` and `rekeyOptimistic` accept `allowPromotion` in their options and forward it to
     their internal `deriveQueue` calls.
6. Tests: extend `test/client.test.ts`, `test/chat-page.test.ts`, `test/prompts-http.test.ts`,
   `test/permission-policy.test.ts` (or the manager fixture), and `test/chat-core.test.ts` per the
   test table.

Acceptance: the abort client/route tests pass; the policy filter/log tests pass; all pure-helper
tests pass; `npm run lint` and `npm run typecheck` are green.

Risks: route ordering (abort must be handled before `manager.ensure`), 404/503 mapping, and helper
semantics. Any mismatch is fixed in this phase before the client uses them.

## Phase 2 - Mobile composer, Stop, and abort lifecycle

Boundaries: `src/http/ui.ts`, `src/http/chat.ts` (viewport/textarea markup), `src/http/styles.css`,
`assets/chat.js`, and tests. Plan markup changes stay in Phase 3.

Work:

1. `src/http/ui.ts`:
   - Add a `stop` icon (`<rect x="6" y="6" width="12" height="12" rx="1" />`).
   - Add optional `viewport` to `documentPage`/`ShellOptions`; render
     `<meta name="viewport" content="${viewport ?? "width=device-width, initial-scale=1"}">`.
2. `src/http/chat.ts`: pass
   `viewport: "width=device-width, initial-scale=1, interactive-widget=resizes-content"` and
   `enterkeyhint="enter"` on `#chat-prompt`.
3. `src/http/styles.css`:
   - `.chat-shell--workspace { block-size: calc(100% - var(--chat-keyboard-inset, 0px)); }`.
   - `@media (pointer: coarse) { .composer .textarea { font-size: 1rem; } }`.
   - No safe-area rule.
4. `assets/chat.js` mobile input:
   - `syncChatViewport()`: scale guard (`|scale - 1| <= 0.01`, else inset 0), inset
     `max(0, round(innerHeight - vv.height - vv.offsetTop))`, rAF debounce; call at boot and on
     `vv.resize`, `vv.scroll`, `window.resize`, `focusin`, `focusout`, `orientationchange`.
   - Coarse-pointer `matchMedia` with a `change` listener.
   - Keydown: palette first; Cmd/Ctrl+Enter sends; coarse Enter/Shift+Enter inserts a newline; fine
     Enter sends.
   - `syncComposer()` updates the hint for the pointer type and calls `updateComposerAction()`.
   - `sendPrompt()` captures `wasFocused` before the first await and restores focus after acceptance
     only if it was focused and `activeElement` is `body`/`null`; remove the unconditional focus.
   - `mousedown` on `#chat-send` calls `preventDefault()`; no `touchstart` preventDefault. Add a
     click handler that calls `abortTurn()` only in stop mode.
5. `assets/chat.js` composer/Stop:
   - `updateComposerAction()` is the sole writer of the primary button's `type`, `disabled`, icon,
     label, class (`btn-primary`/`btn-danger`), `aria-label`, and `title`. Remove the direct
     `sendButton.disabled` write from `syncComposer`.
   - Call it from the textarea `input` listener, `syncComposer`, `applyAgentStatus` both branches,
     `refreshContext` (seed and idle), and every abort-outcome/`abortPending` change.
   - Stop mode: `const statusType = currentStatusType(); const turnActive = statusType === "busy" ||
     statusType === "retry";` then `hasDraft === false`, `sessionId !== null`,
     `acceptanceBusy === false`; pending dock does not hide Stop.
6. `assets/chat.js` abort lifecycle:
   - `abortTurn()`: guard `abortPending`; set `abortPending = sessionId` and
     `suppressAbortUntil = now + 15s` before the POST; call the route.
   - On `200 {aborted:true}`: add the session to `queuePromotionBlocked`, persist it,
     **immediately** call `clearSessionPrompts(sessionId)` (Send returns even while a dock was open),
     call `recomputeQueue()`/`updateComposerAction()`, and start the settle poll.
   - On `200 {aborted:false}`: clear `abortPending`, remove any block entry, refresh
     runtime/context status, call `updateComposerAction()`, and show the exact retryable string
     `The turn was already idle.`; do not insert an error card.
   - On `503 agent_not_running`: same cleanup, show `The agent is not running.`. On `404`/`502`/
     transport failure: same cleanup, keep the turn, show `Could not stop the turn.` in
     `#chat-send-error`.
   - `suppressAbortUntil` is per session; `session.error` with `name === "MessageAbortedError"` (or
     the abort message) within the grace bypasses the failure path: set
     `store.agentStatus = { type: "idle" }`, clear `abortPending`, stop the settle poll, keep
     `queuePromotionBlocked`, `clearSessionPrompts(sessionId)`, `settleSessionIdle()`,
     `scheduleFlush()`, `hydrate()`, and announce `Stopped.`. A different-name error clears the
     suppression grace and stops the poll before taking the normal failure path.
   - SSE status handling: `session.status idle` clears `abortPending` and stops the settle poll. An
     SSE `busy|retry` is ignored for block clearing while `abortPending` is set; after idle, an
     `idle → busy|retry` transition clears the block and supersedes the 15s `MessageAbortedError`
     grace. A context snapshot `busy|retry` never clears the block.
   - `settleSessionIdle()`: flush pending classifications, `sealAllParts()`, `recomputeQueue()`,
     `resetElapsed()`, `updateComposerAction()`, `scheduleIdleReconcile()`,
     `followUpHydration = false`; callers call `scheduleFlush()`. It does not clear the queue block.
   - `clearSessionPrompts(sessionID)`: delete the session's prompt entries and their drafts/errors/
     busy flags, then render the dock/inline questions/queue and `syncComposer`.
   - Bounded settle poll: `refreshContext(sessionID)` immediately, then every 1s for 10s while
     `abortPending`; idle → clear pending + `settleSessionIdle` + `clearSessionPrompts` + `hydrate`;
     deadline → clear pending, refresh messages, `clearSessionPrompts` + `hydrate`, show
     `Stopped; status is reconciling.`
   - `refreshContext` status authority: when `store.agentStatus` is unset and the snapshot is
     `busy|retry|idle`, set `store.agentStatus = { type: snapshot.status }`, then
     `recomputeQueue()` + `updateComposerAction()` (this is what makes Stop appear after reload).
     When the snapshot is `idle` during `abortPending`/grace, set `{type:"idle"}` authoritatively,
     clear `abortPending`, keep `queuePromotionBlocked`, run the idle settle path,
     `clearSessionPrompts` + `hydrate()`. A snapshot `busy|retry` updates the status but never clears
     the block.
   - Session switch: clear the previous session's `abortPending`/`suppressAbortUntil`/settle timer
     (keep its `queuePromotionBlocked` entry). Session deletion: delete the block entry, clear pending/
     grace, and stop the poll.
   - `queuePromotionBlocked` module-level Set per session; load/save `sessionStorage` under
     `hanse-chat-queue-blocked:${projectId}:${appKey}` (best effort). Clear only on an SSE
     `idle → busy|retry` transition or session deletion; ignore context busy/retry for clearing.
   - `recomputeQueue`: `const blockedStatus = statusType === "idle" || statusType === undefined ||
     statusType === "unknown"; const allowPromotion = !(queuePromotionBlocked.has(sessionId) &&
     blockedStatus);` pass it to `deriveQueue`; `hydrateMessages`/`rekeyAcceptanceRow` pass the same
     to `applySnapshot`/`rekeyOptimistic`.
   - `activeStatusLabel` passes `queueBlocked: queuePromotionBlocked.has(sessionId)`.
7. Tests: `composerAction` matrix; `chat-page` viewport meta; manual/browser checks for the tap/focus
   and viewport behavior in Phase 4. Add explicit assertions for the status seed after reload and for
   `clearSessionPrompts` on abort success/suppression/context-idle (Send returns with a pending dock).

Acceptance: no direct `sendButton.disabled` writer remains; the Stop/Send mode follows the pure
helper; abort success/failure/`aborted:false`/deadline paths settle or clear; the queue block
survives store rebuilds and session switches; `npm run lint`/`typecheck` pass.

Risk: `visualViewport` behavior and abort state races. Real-device QA in Phase 4 is the gate.

## Phase 3 - Feed behavior

Boundaries: `src/http/chat.ts` plan/saved markup, `assets/chat.js`, and tests. No server route
changes.

Work:

1. Plan markup (`src/http/chat.ts`):
   - `#chat-plan-divider` (`<hr>`) and `#chat-plan-section` render with `hidden`.
   - `#chat-saved-divider` (`<hr>`) renders with `hidden`.
2. `assets/chat.js` plan:
   - Add `planDivider`/`savedDivider` refs.
   - `renderPlan()` derives `planVisible` from rendered Todos (cached Todos count on
     `todoState === "error"` with a cache); toggles section/divider; calls `updatePlanChip()`.
   - `updatePlanChip()` hides the chip unless `planVisible`.
   - `renderSavedPermissions()` sets `savedDivider.hidden = savedSection.hidden` in both branches;
     the server-rendered hidden state covers a failed saved hydrate.
3. `assets/chat.js` smooth scroll:
   - Constant `AUTOSCROLL_THRESHOLD_PX = 32` (design D4); `isAtBottom()` uses it.
   - State: `scrollPinned`, `scrollRaf`, `lastScrollTop`, `smoothScrollActive`, paused flag, and a
     programmatic expectation `{ expected, expiresAt }`.
   - `requestBottomScroll({ force, instant })` idempotent; eases toward live `scrollHeight`; instant
     for initial/session switch and reduced motion; clears on feed reset/session switch.
   - `flushFrame`: set `scrollPinned` when `isAtBottom()`; `follow = autoscrollFollow(...)`; when
     follow, skip anchor capture/restore and request the bottom; prepends unchanged; show/hide the
     New messages affordance as today.
   - Scroll listener: update `lastScrollTop`; cancel on a decrease unless it matches a live
     programmatic expectation (consume it; expire after 250ms); clear the paused flag when
     `isAtBottom()`; keep the `scrollTop <= 120` history branch reachable when
     `smoothScrollActive` is false.
   - `newMessages` click requests a smooth bottom; only focus the composer when the pointer is fine.
   - `restoreScrollAnchor` and the instant `flushFrame` set record the programmatic expectation.
4. `assets/chat.js` reasoning:
   - Delta handler uses `provisionalPartType(payload.partType)`; a missing part with no type is
     dropped (the first snapshot supplies the text).
   - `updateDetailPart` for reasoning appends `.tool-call__elapsed.mono`; registers
     `{ el, start, end }` on every rebuild; signature includes start/end, not the live duration.
   - A dedicated 1s `tickReasoningElapsed()` updates `textContent` only while an entry has no `end`;
     entries are removed on part removal/type change/feed reset; final duration remains.
5. `assets/chat.js` elapsed seed:
   - `statusSeedTime` uses `elapsedSeed(assistantCreated, activation)`; `startElapsed` returns
     without starting when the seed is null, and `updateWorkingStatus` retries.
6. Tests: `chat-core` helpers; `chat-page` plan markup; browser QA in Phase 4.

Acceptance: R4/R5/R7/R8/R9 pass; a cached plan survives a failed refresh; no phantom queue turn; no
text flash; no timer jump; `npm run lint`/`typecheck` pass.

Risk: scroll races (anchor restore, history pagination), reasoning element rebuilds, and plan
visibility during Todo loading. Browser QA covers each.

## Phase 4 - Browser QA, docs, and record

Boundaries: `docs/design/chat-qa.mjs`, docs/indexes, journal, and verification. No product behavior
changes.

Work:

1. Extend `chat-qa.mjs`:
   - `newPage` accepts `hasTouch`/`isMobile` (and passes them to `browser.newContext`).
   - Scenarios: coarse Enter/newline/hint; Stop/Send with an empty composer; Stop with a pending
     dock; abort success, `MessageAbortedError` suppression, `aborted:false`/failure; queue block
     clear on idle→busy (assert the `sessionStorage` key); reload with/without storage; 10s settle
     deadline; plan hidden/visible/cached-error and saved-divider rules; reasoning delta before
     snapshot and live/frozen timer; smooth near-bottom follow, keyboard/scrollbar cancel,
     programmatic-scroll no-cancel, and near-top New messages no history request.
   - Register the scenarios in `main`; write screenshots/report.
2. Manual device QA (record in the journal): iOS Safari and Android Chrome keyboard open/close, send
   focus, pinch zoom (inset 0), and near-bottom smooth scroll.
3. Run `npm run lint`, `npm run typecheck`, `npm test`, `npm run build`, `npm run check:sensitive`;
   run `node docs/design/chat-qa.mjs`.
4. Docs:
   - `docs/current-state.md`: abort route, Stop/Send behavior, policy diagnostic filter, mobile
     composer/viewport, plan visibility, smooth scroll, reasoning timer/delta behavior, elapsed seed.
   - `docs/design/README.md`, `docs/plans/README.md`, `docs/journal/README.md` indexes.
   - `docs/journal/0029-chat-mobile-polish.md`: context, decisions, probe result, implementation,
     verification evidence, deviations, known limits (storage-unavailable reload, real keyboard
     caveat).
5. Commit only on explicit owner instruction; one coherent commit with code, tests, docs, and
   record.

Acceptance: all five gates green; browser QA report passes; manual device QA recorded; indexes and
journal updated; commit pending/authorized.

## Tests

| # | Where | Assertion |
| --- | --- | --- |
| T1 | `test/client.test.ts` | `abortSession` posts to `/session/<id>/abort`, sends auth, parses `true`/`false`; 404 and transport failures keep their typed error. |
| T2 | `test/chat-page.test.ts` | Abort route: human-only `403`; non-POST `405`; unknown app; deletion `409`; not running `503` via `endpointFor`; `ensure` never called; success `200 {aborted}`; upstream 404 → `404 session_not_found`; other → `502 abort_failed`. |
| T3 | `test/chat-page.test.ts` | Chat HTML has the chat-only viewport meta, `enterkeyhint`, hidden plan section/divider, hidden saved divider, and the stop icon symbol. |
| T4 | `test/prompts-http.test.ts` | `policy_unverified: ... failed` and `... timed out` are filtered; a real `agent "..."` warning remains. |
| T5 | `test/permission-policy.test.ts` (or manager fixture) | The manager logs `policy_verification_failed` for failure and timeout forms (bounded) and still exposes `policyWarnings`. |
| T6 | `test/chat-core.test.ts` | `composerAction` matrix (idle/busy, draft/empty, dock, acceptance, abortPending); `elapsedSeed` preference and non-finite fallback; `provisionalPartType`; `reasoningElapsedMs`; `autoscrollFollow`/`autoscrollStep`; `deriveQueue` `allowPromotion` for idle/undefined/unknown and `resolveActiveStatusLabel` `queueBlocked`; `applySnapshot`/`rekeyOptimistic` forward the option. |
| T7 | `docs/design/chat-qa.mjs` | Touch Enter/newline/hint and Send tap; Stop/Send modes; Stop with a pending dock and Send returns after abort; abort success/`MessageAbortedError` suppression (including `Stopped.` and cleared `abortPending`)/`aborted:false`/failure with the exact outcome strings; SSE idle clears `abortPending`; a same-turn SSE busy during `abortPending` does not clear the block; context-status seed after reload makes Stop appear; queue block clears on idle→busy, the `hanse-chat-queue-blocked:${projectId}:${appKey}` entry is removed, the queued prompt promotes, and no phantom “Working” turn appears before the new busy; reload with/without storage; 10s settle deadline; plan hidden/visible/cached-error and divider rules; reasoning delta/timer; smooth scroll follow/cancel/programmatic/new-messages; `AUTOSCROLL_THRESHOLD_PX` boundary; no console/page errors. |
| T8 | Manual device QA | iOS Safari and Android Chrome: keyboard stays on send, layout reflows, pinch zoom leaves inset 0, smooth near-bottom scroll. |

> Commit policy note: the owner authorized the pipeline, but `docs/process.md` keeps the commit as a
> separate gate. Phase 4 reports ready-to-commit and asks for the explicit commit/push instruction
> unless the owner has already given it.

## Verification

```bash
npm run lint
npm run typecheck
npm test
npm run build
npm run check:sensitive
node docs/design/chat-qa.mjs
```

## Rollback

Revert the stage commit. No migration or persisted data is involved; `sessionStorage` keys are
best-effort and harmless if left behind. Running agents are unaffected.

## Plan review

Pending (`momus`). Findings and revisions will be recorded here before execution.
