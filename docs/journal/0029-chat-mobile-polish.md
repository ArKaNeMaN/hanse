# 0029 - Mobile chat polish and turn control

- Date: 2026-10-24
- Status: implemented, automated gates green; browser QA blocked by the container's Chromium host
  libraries; real-device mobile QA pending.
- Design: `docs/design/chat-mobile-polish.md` (oracle PASS round 7)
- Plan: `docs/plans/0025-chat-mobile-polish.md` (momus PASS round 3)

## What changed

- **Mobile composer.** The chat page is the only page with
  `interactive-widget=resizes-content`; a scale-guarded `visualViewport` inset drives
  `--chat-keyboard-inset` on the chat shell so the composer stays above the keyboard. Coarse-pointer
  textareas use 16px (no iOS focus zoom), plain Enter inserts a newline on coarse pointers, and Send
  no longer steals focus. Post-send focus is restored only if the composer had focus and nothing else
  took it.
- **Stop/interrupt.** `abortSession` posts to upstream `POST /session/{id}/abort`;
  `POST /api/apps/:app/sessions/:sid/abort` is human-only, resolves `manager.endpointFor` (never
  `ensure`), and maps not-running/deletion/upstream failures. The primary composer button is rendered
  solely by `composerAction`: Stop when the composer is empty and `session.status` is `busy`/`retry`,
  Send otherwise. `MessageAbortedError` within the abort grace settles as `Stopped.` without the
  Agent-error card/toast, failed prompts, or queue drop. Prompt docks are cleared and rehydrated.
- **Queue state after abort.** Unanswered queued prompts remain queued; a per-session
  `queuePromotionBlocked` Set (outside the thread store, mirrored to `sessionStorage` under
  `hanse-chat-queue-blocked:${projectId}:${appKey}`) prevents the idle `deriveQueue` promotion from
  showing a phantom `Working` turn. The block clears only on a real SSE `idle → busy|retry`
  transition or deletion; a context snapshot alone never clears it. A bounded settle poll
  reconciles a missed idle.
- **Policy banner.** `policy_unverified:` warnings are filtered from `/prompts`; real policy findings
  remain. The manager logs the stripped diagnostic (failure/timeout) once per start as
  `policy_verification_failed`.
- **Plan rail.** The Plan section, divider, and chip are hidden until the session renders at least one
  Todo; cached Todos survive a failed refresh with “Not updating”. The Saved-permissions divider now
  follows its section.
- **Autoscroll.** Near-bottom following uses a 32px threshold and an idempotent, cancellable rAF ease
  toward the live bottom. Initial load/session switch are instant; reduced motion is instant.
  Programmatic anchor/instant writes are guarded, genuine upward scroll (wheel/touch/keyboard/
  scrollbar) cancels, and history pagination is skipped while a smooth follow is active.
- **Reasoning.** Deltas use the server-provided `partType`; an unknown-type early delta is dropped
  until the first snapshot instead of flashing as ordinary text. In-progress reasoning blocks show a
  live elapsed value (frozen at completion) through a dedicated timer, independent of the request
  timer.
- **Request timer.** The elapsed seed prefers the assistant `time.created` and falls back to the
  activation time; with no seed the timer stays hidden until hydration supplies one, removing the
  page-open jump.

## Phase 0 probe

The pinned upstream is `opencode` 1.19.3. Source inspection confirmed `POST /session/{id}/abort`
returns a boolean, calls `SessionRunState.cancel`, publishes `session.error` with the serialized
`MessageAbortedError`, and settles the session to `idle`. A disposable live app was not available in
this environment, so the queued-prompt auto-run probe was source-level only: Hanse removes nothing
and does not depend on auto-run; the queue block keeps an unanswered prompt queued and clears on a
real new turn. This limitation is recorded rather than assumed.

## Verification

- `npm run lint`, `npm run typecheck`, `npm run build` — green.
- `npm test` — 117 files / 2031 tests pass (the agent environment's `HANSE_CREDENTIALS_DIR` is
  unset for the run; with it set, one unrelated git-service test fails because the managed credential
  dir overrides the fixed test environment).
- `node --check assets/chat.js` — green.
- `node docs/design/chat-qa.mjs` — extended with `mobile-composer`, `plan-visibility`, `reasoning`,
  and `stop` scenarios; the harness is syntax/format clean but cannot launch Chromium in this
  container: `libnss3.so`, `libgbm.so.1`, `libasound.so.2`, `libatk-1.0.so.0` and related host
  libraries are missing and `sudo` is unavailable. Browser QA is therefore blocked here, not skipped;
  no screenshots/report were produced.
- `npm run check:sensitive` — pending the final docs pass.

## Known limits

- Queued prompts after an abort are not removed and may not auto-run upstream; the operator can send
  a new prompt. There is no queue editing.
- Reload survival of the queue block uses best-effort `sessionStorage`; without storage the block is
  in-memory only.
- The intentional-abort message fallback is conservative because the exact upstream abort message is
  not pinned in this repository; the serialized `MessageAbortedError` name is the primary signal.
- Real iOS Safari/Android Chrome keyboard, reflow, pinch-zoom, and smooth-scroll behavior still needs
  a device check on the deployment.
- The browser QA harness needs Playwright Chromium host dependencies to run in CI/containers.

## Deviations

- Abort outcome messages (`The turn was already idle.`, `The agent is not running.`,
  `Could not stop the turn.`) use the retryable inline `#chat-send-error` region; no error card or
  toast is added.
- The suppression grace is cleared on non-success abort outcomes because no abort occurred; it is
  kept after a successful abort for a late `MessageAbortedError`.
- The reasoning QA scenario checks “no reasoning details” synchronously before the delta flush, since
  D8 intentionally creates a provisional reasoning part when the delta carries `partType`.
