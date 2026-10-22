# 0006 - Chat UX overhaul

Date: 2026-10-19. Status: implemented, verified, and deployed to `deployment-host` (phases 1-7); not committed
(the owner has not asked).

## Artifacts

- Design: [`docs/design/chat-ux-overhaul.md`](../design/chat-ux-overhaul.md) (Oracle PASS WITH
  CHANGES; findings and owner decisions closed in §16-§18).
- Plan: [`docs/plans/0005-chat-ux-overhaul.md`](../plans/0005-chat-ux-overhaul.md).
- QA harness: [`docs/design/chat-qa.mjs`](../design/chat-qa.mjs).
- QA evidence: [`docs/design/artifacts/chat/README.md`](../design/artifacts/chat/README.md) plus
  `report.json` and ten screenshots in the same directory.
- Indexes: [`docs/design/README.md`](../design/README.md),
  [`docs/plans/README.md`](../plans/README.md), [`docs/journal/README.md`](./README.md).

## Context

The chat workspace refetched the full message list after every activity event, so assistant text and
tool output could not stream, "Working" only meant an in-flight blocking POST, and every turn ended
in a feed-wide `replaceChildren`. The overhaul replaces that loop with a typed, sequenced app stream,
a keyed client store, an additive async send path, a derived upstream queue, inline question/Q&A
cards, client-side OMO classification, tool renderers, GFM tables, and a measured feed width. The
design is the contract; this entry records what shipped and how it was verified.

## What was delivered

- Typed app SSE: `HanseEvent & {seq, streamID}`, `stream.ready` at `seq:0`, message/part/status/
  question/permission/Todo frames, `message.part.delta`, omitted/truncated parts, warnings, and
  `session.activity` compatibility. Caps are enforced before serialization (8 MiB frame, 256 KiB
  typed event, 64 KiB delta/text snapshot/tool output/patch).
- Keyed client store and DOM patch layer: one rAF flush, throttled markdown/tool rendering, snapshot
  sealing, optimistic merge by server ID, `openParts` restoration, scroll anchoring, and hydration
  that always applies the snapshot and discards buffered content events.
- Streaming assistant text and running bash output; `Thinking` reasoning; one-line tool previews; a
  `todowrite` checklist; error auto-open; truncation and omitted-part notices.
- Async send: `POST .../messages?async=1` returns `202 {accepted, messageID, sessionID}`; the
  optimistic row is inserted before the request, rekeyed to the server ID, and preserves its feed
  position. The blocking route is unchanged. Async text is capped at 32 KiB and
  `async_unavailable` is explicit for an older upstream.
- Derived queue strip and truthful status: parentID/finish/idle boundary, active head excluded,
  `sending`/`queued`/`accepted`/`unknown` presentation, combined-reply clearing, `· N queued`
  suffix, elapsed time, and `Waiting for you` gating.
- Inline questions: correlation to the `question` tool part, in-place answered Q&A, custom-answer
  Enter, forward auto-advance with focus, multi-select staying put, and the uncorrelated request
  kept in the dock. Permissions remain dock-only.
- Client-only OMO classification into system cards: markers and `<system-reminder>` tags hidden,
  long results collapsed, queue exclusion, and no server field or persistence.
- GFM pipe tables with alignment, safe cells, 16-column/200-row caps, and a scroll wrapper.
- Feed measure: `min(100%, max(60ch, 75%))` with a `96rem` cap and a shared feed/composer content
  box at `>=1024`; 100% below 1024. At 1440 the harness measured 80% of the scroll client and 87% of
  the padded content box.
- QA: `docs/design/chat-qa.mjs`, a self-starting, dependency-free harness with route fixtures, a
  fake `EventSource`, three deterministic scenarios, screenshots, a JSON report, and a `--live`
  real-agent mode.

## Key decisions

- **Streaming transport:** typed app SSE with `seq`/`streamID` envelopes and snapshot sealing, not a
  new session stream or a polling loop. The raw per-session SSE remains for compatibility.
- **Async send:** the additive `?async=1` route and per-session acceptance chain; the UI never
  concurrently POSTs and never adds a Hanse-side holding queue.
- **Queue:** derived from upstream history using the last visible assistant `parentID`, with
  `finish:"tool-calls"`/idle overrides and bare shells ignored. No persistence, reordering, or remove
  control.
- **OMO:** classification stays client-side (`synthetic`/`<!-- OMO_INTERNAL_INITIATOR -->` plus
  header extraction); no server field, no durable chat state, and system rows never enter the queue.
- **Width:** 75% ratio with a 60ch floor and 96rem cap, one shared box for feed and composer; prose
  keeps a separate reading measure.
- **Questions:** correlated requests stay inline; uncorrelated requests keep the existing dock;
  permissions never move.
- **QA isolation:** the harness starts a throwaway server with a temp workspace/state and routes all
  API calls, so it does not need a live agent, a database, or a network service. `CHAT_QA_URL`/
  `CHAT_QA_TOKEN` target an existing server; missing Playwright or `dist/` is a blocked gate.

## Verification evidence

- `npm run lint` - pass.
- `npm run typecheck` - pass.
- `npm test` - 28 files, 396 tests pass (including `test/chat-core.test.ts` for queue derivation,
  OMO classification, snapshot sealing/rekey, and the table parser).
- `npm run build` - pass (`tsc` + Tailwind CSS).
- `node docs/design/chat-qa.mjs` - **PASS**: 3 scenarios, 81 assertions, 10 screenshots, zero
  console/page errors. Covered: streaming delta, running bash snapshot, todowrite checklist, GFM
  table, OMO card, two-row queue and status suffix, expanded tools, 1440/390 no-overflow and the
  80%/87% measure; inline pending/dock-hidden/composer-disabled, Q1->Q2 auto-advance/focus,
  multi-select staying, `[["Red"],["Unit"]]`, answered Q&A, custom Enter `[["Green"]]`; optimistic
  row before a delayed 202, server-ID rekey without duplicates, streaming text, second-send queue,
  and `parentID` consumption clearing the strip.
- External-server mode also passed against the local QA server:
  `CHAT_QA_URL=http://127.0.0.1:8792 CHAT_QA_TOKEN=qa-token node docs/design/chat-qa.mjs`.
- Product defects found during the QA pass and fixed before the final green run:
  - A completed question re-render crashed in `buildInlineQuestionHead` when the historical card had
    no live request entry, leaving an empty `.chat-question` node. The head builder now guards a
    missing entry; verified by `question-answered-1440-dark.png` and the answered Q&A assertions.
  - Streaming text deltas did not refresh the status label, so a busy turn stayed `Thinking` after
    text began. `flushFrame` now re-derives the status after applying pending deltas; verified by
    `send-streaming-1440-dark.png` and the `Working` status assertion.
  - Pending OMO classification at idle now classifies even when the live 64 KiB text snapshot was
    unavailable, so an omitted first snapshot cannot leave a permanent neutral row.
  These are the only product changes made in response to QA; the final harness, typecheck, lint,
  test, and build runs are green.
- Live agent smoke on `deployment-host` - **PASS**: `CHAT_QA_APP=demo-app`, existing session
  `<SESSION_ID>`. The real managed agent answered a prompt with a markdown table; 1 scenario, 2
  assertions, 1 screenshot, zero console/page errors. The live report, screenshot, and session
  identifiers are intentionally not committed; only the deterministic harness is tracked. The full
  design §14.4 eight-scenario live matrix was not run as a scripted live suite; those paths are
  covered by deterministic browser/unit/HTTP tests.

## Accepted debt

- No virtualization; very large sessions still render every message.
- The idle `GET /messages` snapshot is capped at 8 MiB; over the cap the client keeps its last feed
  and shows the too-large notice. There is no dedicated full-output fetch; live tool output is a
  64 KiB tail.
- Queued messages cannot be removed while busy (upstream 409 `SessionBusyError`); the queue is not
  persisted, reordered, or client-owned.
- OMO classification is client-only and re-runs on snapshot replacement; an operator who pastes the
  marker can still be classified as a system row.
- Permissions remain dock-only; there are no inline permission cards.
- Deterministic browser captures are dark at 1440/390. The 768/1024/1920, light-theme,
  reduced-motion, reconnect/hydration-race, unknown-acceptance, and snapshot-sealing browser matrix
  rows are covered by unit/HTTP tests or remain manual/deployment checks; they are not all separate
  screenshots.
- No database migration, durable chat state, new runtime/client dependency, or commit in this stage.

## Deployment

Deployed 2026-10-19 on owner instruction.

- Image: `hanse:0.1.0`, `sha256:384546b4e280a8653472c62a105c726489feb7d2e90989e53d4880cb042c8c03`.
- Previous image: `sha256:2c7504c722ab` (tagged `hanse:rollback-20261019-152524-pre-chat-ux`).
- Backup: `<BACKUP_DIR>/20261019-152516-pre-chat-ux/{state.tgz,workspace.tgz,env}`.
- Health: `/`, `/projects`, `/handoffs`, `/chat`, `/api/projects`, `/assets/{app.css,app.js,chat.js,
  chat-core.js,favicon.svg}` - 200; anonymous `/` - 303 to `/login?next=%2F`; `/ide/` - 200 after
  redirect; both containers `Up`; logs `hanse serving 1 project(s)`, no errors.
- Live smoke: PASS on `demo-app`, 1 scenario, 2 assertions, 1 screenshot, zero console/page errors.
- Deploy log: local `docs/deploy/deploy-log.md` (git-ignored).
