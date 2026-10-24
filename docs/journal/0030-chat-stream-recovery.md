# 0030 - Chat stream recovery after backgrounding

- Date: 2026-10-24
- Status: implemented, automated gates green; the browser QA scenario is added but the container
  cannot launch Chromium (missing host libraries); real-device QA pending.
- Follow-up to: `docs/journal/0029-chat-mobile-polish.md`
- Design: `docs/design/chat-mobile-polish.md`

## Problem

Minimizing the browser on a phone and returning left the chat on `Paused`. The app SSE had already
closed for two reasons:

- `EventSource.onerror` counted every failure, including failures while the page was hidden. Three
  errors called `closeStream()` and exposed only the manual Retry control.
- `visibilitychange` restarted runtime polling on return but never checked the SSE source. A source
  closed while hidden therefore stayed closed until the operator tapped Retry.

The same gap affected bfcache restores and network changes. A source that stayed `OPEN` but was
half-open after a long hide could also look live without delivering frames.

## What changed

- **Hidden tabs do not consume the error budget.** An `onerror` while `document.hidden` shows
  `Reconnecting` but does not increment `failures`; the three-strike `Paused` path is foreground-only.
- **Visible recovery.** On return, `shouldResubscribe()` decides whether to replace the source: a
  missing or `CLOSED` source always; a source still `CONNECTING` after 5 s; or any source after 10 s
  hidden, because the socket may be half-open. A healthy `OPEN` source survives a short hide.
- **Other lifecycle entries.** `pageshow` after a bfcache restore and `online` after a network change
  use the same reconnect path.
- **Reconnect path.** `reconnectStream()` closes the old source, detaches its handlers, opens a fresh
  one, and hydrates prompts plus the last message page. Stale handlers are guarded by source identity
  so an old source cannot close a replacement.
- **QA coverage.** `docs/design/chat-qa.mjs` gains a `reconnect` scenario: three background errors
  do not open a replacement or expose Retry; returning opens exactly one replacement and returns to
  `Live`. The pure decision helper is covered in `test/chat-core.test.ts`.

## Verification

- `npm run lint`, `npm run typecheck`, `npm run build` — green.
- `npm test` — 117 files / 2036 tests pass (run with `HANSE_CREDENTIALS_DIR` and
  `HANSE_CREDENTIALS_READONLY` unset; the agent environment otherwise overrides one unrelated
  git-service test).
- `node --check assets/chat.js`, `node --check assets/chat-core.js`,
  `node --check docs/design/chat-qa.mjs` — green.
- `node docs/design/chat-qa.mjs` — blocked at browser launch: the container lacks
  `libnss3`, `libgbm`, `libasound`, `libatk`, and related Chromium host libraries, and `sudo` is
  unavailable. The new `reconnect` scenario has not run here.
- `npm run check:sensitive` — green.

## Known limits

- There is no server-side liveness probe for an `OPEN` but half-open EventSource. A hide shorter than
  10 s that leaves such a socket behind relies on the browser's own error/open transition; the next
  long hide or the Retry control recovers it.
- Reconnect hydrates the last message page; older paged history is not re-fetched, matching the
  existing reconnect contract.
- Real iOS Safari and Android Chrome background/foreground behavior still needs a device check on the
  deployment.
- The browser QA harness still needs the Playwright Chromium host dependencies to run in a container.
