# 0039 - Chat and terminal SPA migration

Plan: [`0032`](../plans/0032-chat-terminal-migration.md). Design:
[`chat-terminal-migration.md`](../design/chat-terminal-migration.md). Governing design:
[`spa-migration.md`](../design/spa-migration.md) plus the Stage 0 amendment record in §15.

Status: **Stages 0-2 implemented**. `/terminal` is SPA by default with the legacy document and
`assets/terminal.js` retained for rollback. `/chat` remains legacy. Stages 3-9 are not started.

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

## Stage 1 - Workspace shell, routes, and props (no cutover)

Stage 1 adds the chat/terminal route identities and the client/server shell plumbing without enabling
either route. `/chat` and `/terminal` still serve the legacy renderers; `spa:false` and
`legacyRetired:false` remain in the registry.

Implemented:
- `routes.ts`: `chat`/`terminal` ids, `nav:"none"` for chat, `legacyRetired`, `isLegacyRetired`,
  `isSpaPathIn`, and `matchPage` coverage for the two static page paths. API/assets/IDE/preview and
  terminal-upgrade paths remain unmatched.
- `spa.ts`/`ui.ts`/`dashboard.ts`: SPA shell inputs (`pageClass`, `bodyClass`, `viewport`,
  `topbarActions`, `spaRoutes`, `topbar` seed), chat/terminal chrome cases with project/app hints,
  `/api/ui/chrome` hint support, `/api/ui/chat` and `/api/ui/terminal` prop endpoints, guarded
  `recordOperatorHost`, and `contentScript` forwarding through the private shell helper. The legacy
  `appShell` markup and `renderChatPage`/`renderTerminalPage` are untouched.
- Client: boot validation of the resolved route set/topbar seed, installed boot route set,
  `SmartLink` membership, router full-document guard, App-level persistent `TopbarActions`,
  pre-mount server-fallback clear, `useWorkspaceShell`, workspace-aware `focusMain`, and chrome
  hints. No chat/terminal router records or components were added; no allowlist entry exists.
- Props builders `buildChatProps`/`buildTerminalProps` extract the page frame and context-rail data
  without carrying `initialSession`; `/api/ui/chat` records the operator host only when
  `request.host` is present.

Verification:
- `NODE_ENV=development npm test`: **3046 passed** (178 files).
- `npm run lint`: pass (18 pre-existing docs/design `innerText` warnings).
- `npm run typecheck`, `typecheck:ui`, `typecheck:e2e`: pass.
- `npm run build`: pass; `check:ui`: pass (42 SFCs); `check:chat-worker`: pass.
- `npm run test:e2e`: **139 passed, 1 skipped**.
- `check:sensitive`: pass; `git diff --check`: pass.
- `test/ui-legacy-bytes.test.ts`: legacy `/chat` and `/terminal` SHA-256 hashes match the Stage 0
  baseline (`bd4c2e69…` and `f5878374…`), and both routes remain `maybeServeSpa`-ineligible.

Known baseline debt remains: the pre-existing `chat-qa` `main` queue-strip expectation is still red
on the unchanged legacy harness and must be reconciled in Stage 3B/7C; see Stage 0.


## Stage 2 - Terminal full Vue port and cutover

Stage 2 replaces the legacy `/terminal` document with `TerminalPage`/`TerminalView` and cuts the
route over. `/chat`, `assets/chat.js`, `assets/terminal.js`, `renderTerminalPage`, the WS proxy/upgrade
contract, and the runner are untouched.

Implemented:
- `ui/router.ts` registers the lazy `/terminal` record with `meta.workspace:"terminal"` and
  `meta.legacyRetired:false`; `src/shared/routes.ts` flips `terminal.spa` to `true`. The application
  page's Terminal links use `SmartLink`, so client navigation into `/terminal` is exercised.
- `ui/pages/TerminalPage.vue` owns the runtime `.page__body page__body--terminal` root and `#terminal`
  heading, consumes boot or `/api/ui/terminal` props on client navigation, applies chrome and the
  workspace shell, and renders `TerminalToolbar`, `TerminalBanner`, `TerminalView`, and
  `TerminalStoppedState`. There is no `.page-header`.
- `ui/terminal/loader.ts` is the sole vendor loader: four scripts in order plus one
  `/assets/vendor/xterm/xterm-6.0.0.css` link, promise-cached, idempotent across first load and
  client navigation, retryable after a failed tag, and never fed by server styles.
- `ui/terminal/socket.ts` + `ui/composables/useTerminalSocket.ts`: runtime preflight, generation
  guard, normal close 1000/1001, failure 1011, stopped/error, input bytes, clamped resize JSON,
  cookie-only auth probe (401/403 -> `/login?next=`, 200 -> continue, 5 s cooldown, never hidden),
  dispose/stale-callback guarding, and pagehide/pageshow handling. Retries are exactly
  `[1,2,4,8,15]s` for five automatic attempts and then manual only (recorded C9 deviation).
- `TerminalView` instantiates xterm with the legacy token font/theme, scrollback, screen-reader mode,
  and reduced-motion cursor blink; it owns `ResizeObserver`, window/visualViewport resize,
  `document.fonts.ready` with a disposed guard, and the `data-theme` MutationObserver.
- Server wiring uses the existing Stage 1 `/api/ui/terminal` props, terminal page/body classes,
  default IDE topbar seed, and no `recordOperatorHost`. `?legacy=1`, `HANSE_UI_LEGACY=1`, and
  allowlist omission still reach `renderTerminalPage`.

Tests and evidence:
- New `test/ui/terminal-loader.test.ts`, `terminal-socket.test.ts`, `terminal-page.test.ts`,
  `terminal-route.test.ts`; updated `shared-routes`, `router-guard`, `boot`, `ui-legacy-bytes`, and
  `ui-props-auth` for the cutover. The terminal HTTP/proxy/legacy-page tests are unchanged and green.
- New `e2e/terminal.spec.ts` (legacy + SPA modes) and `e2e/spa-terminal.spec.ts`; the SPA project uses
  `HANSE_UI_SPA_ROUTES=${SPA_E2E_ROUTE_IDS},terminal`. Coverage: direct load/deep link, client
  navigation, stopped/error runtime, connect/input/output/resize, copy, manual close/reconnect,
  normal 1000/1001 exit, 1011 retry, auth expiry, runner-unavailable, one vendor link/host, zero
  console/page errors, and all three rollback paths.
- Visual QA at 390/768/1024/1440 dark/light plus stopped state, theme switch, and reduced motion is
  untracked at `docs/deploy/chat-terminal-stage2/evidence/` (`report.json`, 18 rows, PASS). CLS is
  `0.00006`-`0.00047` across the 16 live/stopped captures; time-to-Live is about `1.4-1.5 s` on the
  fixture. Toolbar height is `91.25 px` at 390 and `48 px` at 768/1024/1440; the host fills the
  remaining viewport.

Gate results (all with `NODE_ENV=development`):
- `npm run lint`: pass (20 pre-existing/known warnings, 0 errors).
- `npm run typecheck`, `typecheck:ui`, `typecheck:e2e`: pass.
- `npm test`: **3072 passed**, 182 files.
- `npm run build`: pass; terminal route chunk is lazy (`TerminalPage`, 24.33 kB raw / 8.74 kB gzip).
- `npm run check:ui`: pass (47 SFCs); `check:sensitive`: pass; `check:chat-worker`: pass.
- `npm run test:e2e`: **165 passed, 3 skipped**.
- `git diff --check`: pass.

Deviations and limits:
- The recorded C9 bound replaces legacy's unlimited retry; this is the design's approved deviation.
- The E2E copy interaction covers the SPA copy path; the legacy rollback client is unchanged/frozen
  and is covered by its document/render smoke rather than a new copy test.
- Stage 2 checkpoint commit is created with this record.

Next stage: Stage 3A (chat feed store/reducer), not started.

## Stage 3A - Chat feed store, event reducer, and state actions

Stage 3A adds the pure chat data layer. There is no chat route, component, cutover, or allowlist
entry; `/chat` remains the legacy document and `assets/chat.js` is still byte-frozen.

Implemented:
- `assets/chat-feed-store.js` is a plain-ESM **copy** of the legacy `createThreadStore` shape, with
  no imports. `ui/chat/feed-store.ts` is the typed wrapper; `chat.js` was not edited or imported.
- `ui/chat/event-reducer.ts` is a pure `HanseEvent` -> typed-action reducer covering every event in
  `src/opencode/events.ts`, all twelve `PartType`s, unknown part types, unknown future events,
  stream identity/reset, duplicate/gap sequence handling, and the legacy per-session filters.
- `ui/chat/state-actions.ts` applies the actions to Pinia stores and returns render intents
  (dirty message/part ids, scroll, notice/toast, reconcile, refresh, stream pause, prompt
  upsert/resolve). Prompt intents are deferred to Stage 6A because the prompt store is not part of
  3A.
- `ui/stores/chat-feed.ts`, `chat-session.ts`, and `chat-context.ts` hold keyed messages/parts,
  order, stream/sequence, notices/dirty flags, session list/tree/generation/status, and
  session-keyed context/todos/plan plus previews/handoffs/runtime. Large maps use
  `shallowRef`/`markRaw`; no store writes the URL.
- Existing `chat-core.js` helpers are reused unchanged: `applySnapshot`, `deriveQueue`,
  `rekeyOptimistic`, `mergeFeedOrder`, `buildSessionTree`, `firstRootId`, `ancestorIds`,
  `classifyOmo`, `normalizeAttachments`, `normalizeHandoffMeta`, `provisionalPartType`, and
  `applyOmittedPart`.
- Freeze/drift proof: `test/fixtures/legacy-clients.sha256` pins `assets/chat.js` and
  `assets/terminal.js`; `test/chat-legacy-freeze.test.ts` verifies both; `chat-feed-store.ts` has no
  import from the legacy clients. `test/chat-feed-parity.test.ts` replays the Stage 0 fixture for
  feed order, message/part maps, optimistic rekey, queue, stream ids, and active/queued prompt
  relation through both the copy and the Pinia wrapper.

Verification (all with `NODE_ENV=development`):
- `npm test`: **3121 passed** (189 files).
- `npm run lint`: pass (20 known warnings, 0 errors); `typecheck`, `typecheck:ui`, `typecheck:e2e`:
  pass.
- `npm run build`: pass; `check:ui`: pass (47 SFCs); `check:chat-worker`: pass.
- `npm run test:e2e`: **165 passed, 3 skipped**.
- `check:sensitive`: pass; `git diff --check`: pass.
- The entry bundle is unchanged from Stage 2 because the new data layer is not imported by any
  route yet.

Limits: prompt upsert/resolve is represented as render intents until the Stage 6A prompt store;
session-history paging and the read-only shell are Stage 3B/3C. The pre-existing `chat-qa` queue
baseline debt is still recorded in Stage 0. Stage 3A checkpoint commit is created with this record.

## Stage 3B - Chat read-only SPA behind the test allowlist

Stage 3B registers the chat route record and renders a read-only chat workspace only when the
test-only allowlist includes `chat`. `chat.spa` remains `false`; `/chat` is still the legacy document
by default and for every rollback path.

Implemented:
- `ui/router.ts` adds `/chat` with `meta.workspace:"chat"`/`legacyRetired:false`; the registry flag is
  still false. `App.vue` keys chat by `app:project` so an app switch remounts the stream/feed scope,
  and passes the active workspace to the persistent topbar.
- `ui/pages/ChatPage.vue` owns the runtime `.page__body--chat` root, boot/client-nav `/api/ui/chat`
  props, chrome/workspace shell, sessions and message-tail reads, 30-message tail, older-page paging
  with anchor preservation, read-only sessions rail/thread, keyed text/tool/OMO rows, disabled
  composer, and empty/loading/error/stopped/deletion states. No `.page-header`.
- `ui/chat/useChatRouteState.ts`: `route.query` is the only source for app/project/session; one
  watcher applies it to the session store. Session selection uses `router.replace` and last-wins
  generation; app switch uses `router.push`; stopped/empty sessions preserve the requested deep link;
  no history/location writer exists outside the router.
- `ui/chat/stream.ts` + `useChatStream.ts`: one EventSource, every `stream.ready` reset, duplicate
  drop, gap/stream-id resync, hidden no-failure/probe behavior, three visible failures then one
  stream-limit probe, cookie-only auth probe with 5s cooldown, 401/403 login redirect, dispose/
  stale-callback guards, pagehide/pageshow/visibility lifecycle.
- The read-only page applies `reduceEvent` + `applyChatActions`, refreshes tail/context/notices/
  runtime/commands, and renders render intents. It does not send, queue, abort, upload, mutate
  prompts, search/delete sessions, or use a legacy island.

Tests/evidence:
- New `test/ui/chat-page.test.ts`, `chat-readonly.test.ts`, `chat-route-state.test.ts`,
  `chat-stream.test.ts`, shared support, and `e2e/chat.spec.ts`/`spa-chat.spec.ts`.
- `npm test`: **3153 passed** (193 files).
- `npm run test:e2e`: **177 passed, 11 skipped** (three modes; SPA-only cases skipped in legacy).
- Lint/typecheck/typecheck:ui/typecheck:e2e, build, check:ui (53 SFCs), check:chat-worker,
  check:sensitive, and `git diff --check`: pass.
- Chat route chunk is lazy (`ChatPage`, 45.22 kB raw / 14.27 kB gzip); entry is 282.91 kB raw /
  102.69 kB gzip.
- The Stage 0 `chat-qa` queue-strip baseline debt remains for Stage 3C/7C; no new debt recorded.

Limits: session tree/search/new/delete and the full read-only parity report are Stage 3C; composer/
send/queue are Stage 4; feed rendering depth is Stage 5; prompts/context rail is Stage 6; attachments/
commands and the `chat.spa` cutover are Stage 7. Stage 3B checkpoint commit is created with this
record.

## Stage 3C - Session tree, history paging, and read-only parity

Stage 3C completes the read-only chat navigation surface behind the same test-only allowlist. The
registry flag stays `false`; `/chat` remains the legacy document by default, under `?legacy=1`,
`HANSE_UI_LEGACY=1`, and when the allowlist omits `chat`. No composer, send, queue, abort, prompt,
attachment, command, or cutover path was added; `assets/chat.js` and `assets/terminal.js` are
unchanged.

Implemented:
- `ChatSessionsRail` + `ChatSessionNode` render the `buildSessionTree` tree with multi-level
  disclosure, active-ancestor auto-expansion, title/id filtering, forced ancestor visibility while
  searching, and a start/empty/error/skeleton matrix. New sessions use the existing
  `POST /sessions`; delete confirms the subtree, calls the existing `DELETE /sessions/:id`, removes
  every descendant locally, clears the active selection, and falls back to the first root (or drops
  `session=` when the list becomes empty).
- Prompt wait counts are tracked per session by stable prompt key and aggregated over descendants,
  excluding the active session, matching the legacy parent-wait badge. Stage 6 can render the same
  counts in the prompt dock without a second source.
- History paging keeps `limit=30` and the opaque `before` cursor, triggers on scroll-top as well as
  the explicit row, merges overlap through `applySnapshot({position:"older"})`, preserves the
  prepend anchor, never rewinds a tail refresh behind the loaded older prefix, and shows the
  start-of-history row only when the cursor is exhausted. Cursor errors keep the loaded tail.
- Scroll ownership is component-local: `#chat-scroll` is the only chat scroller, the router no
  longer scrolls `.page` for workspace routes, a constrained `.chat-main` grid makes the scroll
  container actually scrollable, and follow-bottom/pause/new-messages/prepend-anchor/back-forward
  restoration live in `ChatThread` plus `ui/chat/scroll-memory.ts`. Message and part keys remain
  stable across deltas, so a delta does not replace the feed DOM.
- `ui/chat/session-storage.ts` is the sole `sessionStorage` owner for queue-promotion suppression
  and image intent, using the legacy keys and app/project namespace. It clears on session delete,
  route leave, and app switch; successful-send clearing is wired for Stage 4.
- Parity repairs: app switches clear the old workspace/session tree and feed before the keyed
  remount paints, stale message reads are generation/abort guarded (last selection wins), stopped/
  empty/deleted/back-forward states preserve accepted deep links, and `session.status` idle refreshes
  context in addition to messages while status/context refresh remains read-only.

Tests/evidence:
- New `test/ui/chat-sessions.test.ts` (tree, disclosure, search, new, subtree delete, cancel, parent
  wait aggregation), `chat-history.test.ts` (30-message tail, scroll-top paging, overlap de-dupe,
  cursor error, keyed delta DOM identity, follow-bottom/new-messages), and
  `chat-session-storage.test.ts` (namespace, legacy idle rule, clear paths, malformed intent).
- Extended `chat-page.test.ts` (idle context refresh, stale-read last-wins, session controls vs
  read-only composer), `chat-readonly.test.ts` (navigation stays read-only for messages), and E2E
  `chat.spec.ts`/`spa-chat.spec.ts` (legacy+SPA tree/search/disclosure, new/delete, history paging
  with anchor and new-messages, session switching with one EventSource and no duplicate messages,
  and a read-only request assertion).
- `NODE_ENV=development npm test`: **3171 passed** (196 files).
- `npm run test:e2e`: **181 passed, 12 skipped** across the three modes (SPA, legacy,
  allowlist-empty); the allowlist remains the full default set plus `chat,terminal` in the SPA
  project.
- `npm run lint`: pass (20 pre-existing warnings, no errors); `typecheck`, `typecheck:ui`,
  `typecheck:e2e`, `build`, `check:ui` (54 SFCs), `check:chat-worker`, `check:sensitive`, and
  `git diff --check`: pass.
- Visual QA (untracked) at 390/768/1024/1440, dark/light for shell, full history, empty, and stopped:
  32 captures and 16 geometry checks (one `#chat-shell`, one `#chat-scroll`, zero horizontal
  overflow) under `docs/deploy/chat-terminal-stage3c/`; report written there, not in tracked docs.

Limits and deferred debt: composer/send/queue/abort remain Stage 4; prompt docking and the context
rail remain Stage 6; attachments, commands, feed-rendering depth, and the `chat.spa` cutover remain
later stages. The Stage 0 `chat-qa` `main` queue-strip baseline assertion is **not exercised by Stage
3C** because the queue strip does not exist in the read-only surface; it remains deferred to the
Stage 4/7C queue work and was not hidden or changed to make the harness pass. Stage 3C checkpoint
commit is created with this record.

## Stage 4 - Composer, drafts, send, queue, abort

Stage 4 makes the allowlisted SPA chat surface functional for composing while `chat.spa` stays
`false`. Drafts, optimistic send/delivery recovery, queue display, and human Stop/abort are ported;
attachments, commands, prompts, SSH approvals, the context rail, feed-rendering depth, and the chat
cutover remain later stages. `assets/chat.js` and `assets/terminal.js` are unchanged.

Implemented:
- `ChatComposer.vue` replaces the read-only shell: enabled textarea, autosize, Send/Stop primary
  action, Enter / Shift+Enter / Cmd+Ctrl+Enter parity, IME and coarse-pointer handling, focus
  retention, disabled/stopped states, pending-send rows, and the unknown-delivery recovery actions.
- `useChatComposer.ts` + `chat-composer.ts` own one lifecycle per mount: 500 ms debounced draft
  save, keepalive on hide/pagehide, flush on session/app switch and unmount, delete-if-empty,
  per-session isolation, optimistic acceptance, unknown grace, retry/dismiss/restore, and
  bounded abort settling. `chat-feed.ts` gained optimistic insert/remove/state and a single
  queue-promotion guard; `session-storage.ts` remains the only suppression writer.
- `chat/send.ts` and `chat/queue.ts` are pure helpers for endpoint construction, delivery
  classification, intentional-abort detection, pending normalization, and `deriveQueue` rows.
  `ChatQueueStrip.vue`/`ChatQueueDialog.vue` render the derived queue; user selection and draft
  flushes still go through the one route watcher.
- `ui/api.ts` retains the response outcome/payload on `ApiError` and supports the existing draft
  `PUT`. A mid-send `401` uses the same `/login?next=` path as other SPA reads.
- The E2E fixture upstream now records async prompt parts as user messages and broadcasts the
  matching events, so send, reload, and queue scenarios exercise the real coordinator projection.

Tests/evidence:
- New `test/ui/chat-composer.test.ts`, `chat-send.test.ts`, `chat-draft.test.ts`,
  `chat-queue.test.ts`, `chat-abort.test.ts`; updated `chat-page.test.ts`, `chat-readonly.test.ts`,
  shared chat support, and `e2e/chat.spec.ts`/`spa-chat.spec.ts`.
- `NODE_ENV=development npm test`: **3201 passed** (201 files).
- `NODE_ENV=development npm run test:e2e`: **188 passed, 12 skipped** across the three modes;
  composer/draft/send/blocking/unknown/queue/Stop/rapid-stop/auth-expiry cases are SPA-only.
- `npm run lint`: pass (20 pre-existing warnings, no errors); `typecheck`, `typecheck:ui`,
  `typecheck:e2e`, `build`, `check:ui` (56 SFCs), `check:chat-worker`, `check:sensitive`, and
  `git diff --check`: pass.
- Chat route chunk is lazy (`ChatPage`, 86.30 kB raw / 26.54 kB gzip); entry is 283.14 kB raw /
  102.76 kB gzip. The chat registry flag and route allowlist are unchanged.

Limits: `chat.spa` stays `false`; no cutover, attachments, commands, prompts, permissions, SSH,
context rail, or feed-depth rendering was added. Stage 5 is the next action.
