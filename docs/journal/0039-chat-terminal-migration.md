# 0039 - Chat and terminal SPA migration

Plan: [`0032`](../plans/0032-chat-terminal-migration.md). Design:
[`chat-terminal-migration.md`](../design/chat-terminal-migration.md). Governing design:
[`spa-migration.md`](../design/spa-migration.md) plus the Stage 0 amendment record in §15.

Status: **Stage 0 implemented** (baseline and deterministic harness). No route cutover, no registry
flag, no production source/asset change. Stages 1-9 are not started.

## Stage 0 baseline

The full baseline evidence lives outside tracked docs at
`docs/deploy/chat-terminal-stage0-baseline.md` (git-ignored) with screenshots under
`docs/deploy/chat-terminal-stage0/`. Only placeholders and synthetic fixture identities are used;
no deployment host, address, real project/session id, token, or real screenshot is tracked.

Baseline commit: `HEAD` at Stage 0 start (see the untracked record; tracked docs never carry a
deployment-specific revision or path).

| Gate | Result |
| --- | --- |
| `git rev-parse HEAD` | recorded in untracked baseline |
| `npm run lint` | pass |
| `npm run typecheck` | pass |
| `npm run typecheck:ui` | pass |
| `npm run typecheck:e2e` | pass |
| `npm test` | pass: baseline `2999` tests; Stage 0 current `3005` tests (6 new). The earlier `2984` + 2 collection failures were the `NODE_ENV=production` environment trap; rerun with `NODE_ENV=development` is fully green |
| `npm run build` | pass |
| `npm run check:sensitive` | pass |
| `npm run check:ui` | pass |
| `npm run check:chat-worker` | pass (built worker tokenized a TypeScript sample) |
| `npm run test:e2e` | pass (`139` passed, `1` skipped, deterministic fixture only); two earlier full runs each had one settings-toast timeout, isolated and final full runs passed |
| `git diff --check` | pass |

Current `/chat` and `/terminal` remain on the legacy document path: `renderChatPage` and
`renderTerminalPage` are unchanged, `assets/chat.js` and `assets/terminal.js` are byte-frozen, and
no route id, `spa` flag, `legacyRetired` value, `HANSE_UI_SPA_ROUTES` default, or allowlist entry
was added. Baseline screenshots at 390/768/1024/1440 dark/light, skeleton/CLS measurements, and
current transfer sizes are recorded only in the untracked baseline.

## Stage 0 inventory: `HanseEvent` -> slice

Source of truth: `src/opencode/events.ts` (`HanseEvent` union). Actions are the design §4.5 target
shape; tests name the first stage that must cover the row.

| `HanseEvent` type | Target reducer action | Target store | Stage sub-gate | Protecting test |
| --- | --- | --- | --- | --- |
| `stream.ready` | `resetStream({streamID,seq})` + rehydrate runtime/context/commands/notices | `chatFeed` + `chatContext` + `chat-ui` | 3B | `ui/chat/event-reducer.test.ts`, `test/e2e-upstream.test.ts` (ready frame) |
| `question.asked` | `upsertQuestion(request)` | `chatPrompts` | 6A | `ui/chat/event-reducer.test.ts`, `test/ui/chat-prompts.test.ts` |
| `question.replied` | `resolveQuestion({requestID,outcome})` | `chatPrompts` | 6A | reducer + prompt dock tests |
| `question.rejected` | `resolveQuestion({requestID,outcome})` | `chatPrompts` | 6A | reducer + prompt dock tests |
| `permission.asked` | `upsertPermission(request)` | `chatPrompts` | 6A | reducer + prompt dock tests |
| `permission.replied` | `resolvePermission({requestID,reply})` | `chatPrompts` | 6A | reducer + prompt dock tests |
| `todo.updated` | `setTodos({sessionID,todos,truncated})` | `chatContext` | 3A/6B | reducer + context tests |
| `message.updated` | `upsertMessage` + optimistic reconciliation + pending refresh | `chatFeed` | 3A | `test/chat-feed-characterization.test.ts`, reducer tests |
| `message.part.updated` | `upsertPart` + queue recompute + unknown-part reconcile | `chatFeed` | 3A/5A | characterization + reducer + tool/markdown tests |
| `message.part.delta` | `appendDelta({partID,field,delta})` (buffered/throttled) | `chatFeed` | 3A/5A | characterization + reducer + streaming tests |
| `message.part.omitted` | `markPartOmitted` + later reconcile/warning | `chatFeed` + `chatUi` | 3A/5A | reducer + feed warning tests |
| `session.status` | `setAgentStatus` + queue/composer state + context refresh | `chatFeed` + `chatComposer` | 3A/4C | characterization (`deriveQueue`) + composer tests |
| `session.error` | `setSessionError` + pending/abort settlement + idle status + notice | `chatFeed` + `chatPrompts` | 3A/4B | reducer + send recovery tests |
| `session.compacted` | `markCompacted` + context refresh/announcement | `chatContext` | 6B | reducer + context tests |
| `notice.created` | `upsertNotice` (session-filtered) | `chatFeed.notices` | 3A | reducer + notice row tests |
| `context.updated` | `setContextSnapshot` | `chatContext` | 3A/6B | reducer + context meter tests |
| `session.activity` | `scheduleReconcile` unless cause is `message`/`status` | `chatUi` reconcile intent | 3A/3B | reducer tests |
| `stream.warning` | `warnStream` + `scheduleReconcile`; `limit` pauses via probe | `chatUi` + `chatFeed` | 3B | reducer + reconnect/limit tests |

## Stage 0 inventory: `PartType` -> slice

`PartType` is the 12-value union in `src/opencode/events.ts`; the projector maps any future type to
`session.activity` → reconcile. Unknown types are never silently dropped.

| `PartType` | Target render/action | Target store | Stage sub-gate | Protecting test |
| --- | --- | --- | --- | --- |
| `text` | `MarkdownBlock` via `renderMarkdown`, 50 ms throttle | `chatFeed` | 5A | `test/ui/markdown-block.test.ts`, streaming tests |
| `reasoning` | reasoning row + elapsed timer | `chatFeed` | 5A | `test/ui/reasoning.test.ts` |
| `tool` | `ToolPart` with tool status/summary | `chatFeed` | 5A/5B | tool part tests |
| `step-start` | step divider (or legacy no-op) | `chatFeed` | 5A | part parity tests |
| `step-finish` | step divider (or legacy no-op) | `chatFeed` | 5A | part parity tests |
| `patch` | `DiffView` / patch renderer | `chatFeed` | 5B | diff tests |
| `file` | `ReadView`/`WriteView`/file card | `chatFeed` | 5B | file view tests |
| `subtask` | subagent/task row | `chatFeed` | 5A | part parity tests |
| `retry` | retry status row | `chatFeed` | 5A/6B | part parity tests |
| `compaction` | compaction row + context refresh | `chatFeed` + `chatContext` | 5A/6B | part parity tests |
| `snapshot` | snapshot marker/no-op | `chatFeed` | 5A | part parity tests |
| `agent` | agent marker/no-op | `chatFeed` | 5A | part parity tests |
| unknown (`PartType` miss) | `needsReconcile` + refresh, never silent drop | `chatFeed`/`chatUi` | 3A/5A | reducer unknown-part test |

## Stage 0 inventory: legacy function groups -> slice

The function groups are the design §4.5 list derived from `assets/chat.js`. The frozen client stays
the behavior oracle until Stage 9.

| Legacy function group | Target store/action | Stage sub-gate | Protecting test |
| --- | --- | --- | --- |
| `handleStreamEvent` | `ui/chat/event-reducer.ts` `reduceEvent` -> `state-actions.ts` | 3A | reducer tests + `test/chat-feed-characterization.test.ts` |
| hydration buffering | stream adapter queue until initial snapshot resolves | 3B | `ui/chat/stream.test.ts` buffering tests |
| message/part upsert | `chatFeed.upsertMessage` / `upsertPart` | 3A | characterization + reducer tests |
| optimistic rekey | `chatFeed.rekeyOptimistic` (local -> server id) | 3A/4B | characterization rekey row + send tests |
| queue derivation | `chatFeed.applyQueue(deriveQueue(...))` | 3A/4C | characterization queue row + queue strip tests |
| session tree | `chatSession.setSessions` + `buildSessionTree` | 3C | session tree tests |
| prompt dock | `chatPrompts` upsert/resolve + `ChatPromptDock` | 6A | prompt dock tests |
| context/status render | `chatContext` snapshot/todos + `chatFeed.agentStatus` | 3A/6B | context + status tests |
| notices | `chatFeed.notices` + `ChatNoticeRow` | 3A/5A | notice tests |
| scroll | `ChatThread` scroll owner, follow-bottom, anchor preservation | 5C | scroll/perf tests |
| draft/pending | `chatComposer` draft + pending send recovery | 4A/4B | draft/recovery tests |
| attachments | `chatComposer` attachments + `ChatAttachments` | 7A | attachment tests |
| commands | `chatUi` palette + `ChatCommandPalette` | 7B | command palette tests |
| teardown | `useChatStream`/`useChatHighlight` disposers, one owner per resource | 3B/5B | teardown and worker-count tests |

## Deterministic harness (Stage 0)

- `e2e/support/opencode-upstream.ts` is a loopback-only fake opencode HTTP/SSE server and runner
  `/v1/apps/<appId>/exec` WebSocket. It serves the client routes actually used by the coordinator
  (sessions, messages, status, commands, questions, permissions, saved permissions, todos, abort,
  summarize, prompt_async, providers), a fixed-`streamID` `/event` stream with ready/heartbeat
  comments and scripted frames, binary echo, resize JSON, and normal/failure close codes. The
  control endpoint `/__control` advances frames; `/__state` is read-only. No Docker, real opencode,
  or non-loopback network is used.
- `e2e/support/server.ts` points `manager.endpointFor`/`ensure` for the alpha fixture app at that
  upstream, points `deps.runner` at its WebSocket, and keeps the existing fake services. Seeded
  sessions/messages live in `e2e/support/seed.ts`; runtime rows are the existing deterministic rows.
- `e2e/support/route-ids.ts` exports `SPA_E2E_ROUTE_IDS` (the 14 Stage 0 default SPA ids). The
  Playwright `spa` fixture uses it explicitly; chat/terminal are not present.
- `docs/design/chat-qa.mjs` accepts `CHAT_QA_MODE=legacy|spa` (default `legacy`) and
  `CHAT_QA_SPA_ROUTES` (validated as the full default set plus `chat`); it keeps the existing
  scenarios and the single fake `EventSource`.
- `scripts/check-chat-worker.mjs` builds `assets/chat-highlight-worker.js` with
  `scripts/vite.worker-smoke.config.mjs`, serves the built output over loopback, and requires a
  `tokens` result from a TypeScript sample inside headless Chromium.
- `test/e2e-upstream.test.ts` drives the real `createHttpServer` SSE and terminal upgrade paths
  against the fake upstream; `test/chat-feed-characterization.test.ts` pins the legacy feed/queue
  snapshot fixture in `test/fixtures/chat-feed-characterization.json` (synthetic data only).

## Accepted risks / limits

- The fake upstream is a protocol fixture, not an opencode conformance suite. New upstream routes
  must be added when a later stage calls them.
- Scripted `context.updated`/`notice.created` controls fan out through manager subscriptions in the
  fixture server; they are not emitted by the upstream `/event` body because the coordinator sources
  those from the manager.
- The Stage 0 worker smoke proves the built worker tokenizes in Chromium; it does not measure
  highlighting performance or visual parity.
- `CHAT_QA_MODE=legacy node docs/design/chat-qa.mjs` drives the legacy page but its `main` scenario
  fails the pre-existing queue-strip expectation (`2` rows expected, `1` observed). The same
  failure reproduces with the clean `ff78ca4` harness, so it is not a Stage 0 regression. Do not use
  chat-qa as a parity gate until Stage 3B/7C reconciles that baseline assertion.
- Two full E2E runs each timed out one settings toast (`allowlist-empty` and `spa`, different
  tests). Both failed cases pass in isolation, and the final full run is `139 passed, 1 skipped`;
  treat this as a pre-existing timing flake, not a Stage 0 code path.
- `npm run test:e2e` results and browser screenshots stay in the untracked baseline; Stage 0 adds no
  chat/terminal E2E project or allowlist entry.
- Legacy page HTML and `assets/chat.js`/`assets/terminal.js` remain the rollback oracle; nothing in
  Stage 0 changes their bytes.
