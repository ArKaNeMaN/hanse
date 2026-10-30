# Design - Migrating `/chat` and `/terminal` to the Vue SPA

Status: **approved** - `oracle` round 5 PASS. The two round-4 blockers and non-blocking notes are
folded in. Implementation is blocked until the plan review (Momus) is complete. The six owner
questions are closed (§11.1); there are no unresolved owner questions.

Scope: the two remaining legacy page routes, `/chat` and `/terminal`, their page shells, client
modules, route registration, server props/boot, SPA shell integration, and the staged removal of the
legacy implementations after operator verification.

Out of scope: implementing the migration; deleting or changing legacy code now; changing the SSE or
WebSocket wire contracts; changing chat/terminal server behavior or APIs; changing `DESIGN.md`
tokens; database changes; a new runtime dependency; changing `/ide` or `/preview`.

Governing context: [`spa-migration.md`](./spa-migration.md) (approved, round 5 `oracle` PASS),
plan [`0031`](../plans/0031-spa-migration.md), and the revised D1 owner decision in
[`docs/open-questions.md`](../open-questions.md:21-30). D1 now requires both routes to move to the
SPA **before** legacy cleanup, and cleanup stays blocked until the operator has verified the full
chat/terminal surface. A collection window/soak is no longer the blocker. This design carries the
explicit `spa-migration.md` amendments listed in §1.5; the approved document remains unchanged until
the migration plan records them there.

---

## 1. Goal, non-goals, invariants, constraints

### 1.1 Goal

Serve `/chat` and `/terminal` through the Vue 3 SPA, with the same shell, authentication, behavior,
performance, and visual contract as the legacy documents, and with a real migration path that lets
the legacy page renderers and DOM-owning client modules be deleted after the operator verifies both
surfaces.

The owner's required order is fixed:

1. both routes are SPA routes;
2. the operator verifies chat and terminal end to end;
3. only then is legacy cleanup allowed.

### 1.2 Non-goals

- Changing the app-scoped SSE protocol (`GET /api/apps/:app/events`) or the terminal WebSocket
  protocol/proxy.
- Changing chat/terminal HTTP handlers, request/response shapes, auth, or DB state.
- Moving chat/terminal data into `/api/ui/*` where an existing chat API already owns it.
- Redesigning the chat workspace or terminal; visual parity is the requirement.
- Migrating `/ide/*`, `/preview/*`, or `/login`.
- A new runtime dependency, a new UI framework, SSR, or a no-JavaScript chat/terminal.
- Deleting legacy code in this design or in the implementation before the operator gate.

### 1.3 Invariants

The approved SPA invariants continue to apply, with these route-specific readings:

| ID | Invariant for this migration |
| --- | --- |
| S1 | A route is either fully legacy or fully SPA. Chat and terminal each cut over only after every action, state, keyboard path, and responsive layout is ported. Server-rendered entry/error pages (no-app, unknown app) are not route implementations: they are static shell-only pages with no chat/terminal client and do not count as a legacy route. |
| S2 | While a route is still legacy, its HTML, scripts, redirects, and behavior are unchanged. For this migration `assets/chat.js` and `assets/terminal.js` are byte-frozen until Stage 9; a new shared module may copy behavior, but nothing may edit or import into those two files before cleanup (§4.5, Stage 3A). |
| S3 | Exactly one shell. Chat/terminal do not fork the sidebar, topbar, breadcrumb, drawer, theme, toasts, or page classes. The topbar is App-level and persistent; route pages never own it. |
| S4 | Navigation between migrated routes is client-side. There is **no** workspace/full-document exception for chat or terminal; any future exception requires an explicit S4 amendment to `spa-migration.md`, not a route-level choice. |
| S6 | `/api/apps/*` chat endpoints, the app SSE stream, the terminal WebSocket, `/api/ui/*`, CLI, MCP, and the IDE extension remain contract-compatible. |
| S7 | SPA documents and `/api/ui/*` are cookie-only. Chat/terminal SSE/WS keep their current human-cookie authentication. |
| S8 | `assets/app.css` remains the only application stylesheet; no new tokens. The pre-existing vendored xterm CSS is the one documented exception and is loaded by exactly one owner (§4.7). |
| S9 | Runtime rollback by `HANSE_UI_LEGACY=1`, `?legacy=1`, or removal from `HANSE_UI_SPA_ROUTES` stays available until the Stage 8 operator gate. After Stage 9 cleanup it is retired for chat/terminal: those route definitions are marked `legacyRetired`, so the server ignores all three rollback inputs for them. For a workspace request (app resolves) it always serves SPA; a missing UI build produces a clear 503 HTML. The only non-SPA responses are the static shell-only entry/error pages for no-app/unknown-app, which contain no legacy chat/terminal client. Never `undefined` into a deleted legacy branch. The only rollback then is an image rollback plus the mandatory UI-build/deploy check in §4.13/§10. |
| S12 | A checkout without a UI build starts and serves legacy routes. Once chat/terminal legacy code is deleted in Stage 9, this exception no longer applies to them: deploying that image requires a successful UI build, and the deploy check in §4.13 is mandatory. |
| S15 | Boot JSON and props never carry tokens, passwords, provider keys, MCP tokens, or credentials. |
| S16 | The shared entry budget is not regressed; chat/terminal are lazy route chunks, and heavy vendors load only on their route. |
| S14 | Focus, live regions, route announcements, dialog focus, reduced motion, and keyboard paths are preserved. |

Chat/terminal-specific invariants:

| ID | Invariant |
| --- | --- |
| C1 | One app SSE connection per open chat page; one terminal WebSocket per open terminal page. Route changes, visibility changes, and back/forward never create duplicates. |
| C2 | SSE sequence handling (`streamID`, `seq`, `stream.ready`, gap warnings) and reconnect/reconcile behavior are preserved. |
| C3 | URL state is single-owner: `route.query` is the **sole** source for `app`, `project`, and `session`. Stores hold fetched data and selection generations only; they never write the URL. User actions call the router, and exactly one route-derived watcher applies the query to the stores. There are no duplicate writers and no replace/select guard flags. |
| C4 | A session switch paints the target shell immediately, aborts stale reads, flushes the previous draft in the background, and lets the last selection win. |
| C5 | Send/queue state is truthful: optimistic rows, `sending`/`accepted`/`queued`/`unknown`/`failed`, blocking/async delivery, and the upstream queue derivation are unchanged. |
| C6 | Prompt cards (questions, permissions, saved permissions, SSH approvals), OMO system cards, handoff cards, notices, and restart/image gates keep their behavior. |
| C7 | Markdown, tables, tool output, diffs, write content, and highlighting keep their DOM-safety and budget rules (no `v-html`, no untrusted `innerHTML`). |
| C8 | Scroll ownership is explicit: chat scrolls inside `#chat-scroll`, never `window`; reaching top pages history; prepends preserve the anchor; follow-bottom behavior is preserved. |
| C9 | Terminal resize, fit, reconnect backoff, runtime preflight, stopped/exited/closed states, copy, theme, and keyboard integration are preserved. **Intentional deviation:** automatic retries are bounded to the five `[1,2,4,8,15]s` attempts and then stop at a manual Reconnect; legacy retries indefinitely at the 15s cap (`assets/terminal.js:471-506`). This removes an infinite loop and is recorded as a C9 deviation, not parity (§4.7/§6.7). |
| C10 | Unmount removes every timer, listener, observer, worker, SSE/WS connection, and pending fetch. The highlight worker and its `readyTimer` are explicitly disposed (§4.10); tests assert worker/timer counts return to baseline. |
| C11 | SSE/WS authentication expiry is detected on failure through a cookie-only probe, and reconnect is bounded and pausable. No client-adapter failure path retries forever (native `EventSource` auto-reconnect is separate). A hidden document never increments a client failure counter, schedules an app-level retry, or probes; native reconnect may still occur, and the adapter does not claim to stop it (§4.6). |

### 1.4 Constraints (verified facts)

- `assets/chat.js` is 14,362 lines, has 121 `addEventListener` call sites, ~623 function
  declarations, ~46 fetch/api call sites, one huge `main()` closure
  (`assets/chat.js:188`), and no teardown beyond `beforeunload` (`assets/chat.js:14254-14255`).
  Its state is closure-local (`assets/chat.js:309-430`), so it cannot be moved into Vue piecemeal
  without first extracting stores.
- The page markup is server-rendered by `renderChatPage` (`src/http/chat.ts:365-620`) and
  `renderTerminalPage` (`src/http/terminal.ts:45-106`), including page classes, viewport, topbar
  actions, vendor scripts/styles, and the module entry.
- The client already has reusable, pure ESM helpers: `chat-core.js` (3,752 lines),
  `chat-commands.js` (303), `chat-diff.js` (1,812), `markdown.js` (214), and the worker controller
  `chat-highlight.js` (1,076) plus `chat-highlight-worker.js` (207).
- The SPA mounts into the existing `<main id="main" class="page">` (`ui/main.ts:82-100`,
  `src/http/ui.ts:532-570`). Vue replaces the server fallback on mount. Existing page components
  (`AppPage`, `ProjectsPage`) own both `.page-header` and `.page__body`; chat and terminal render no
  `.page-header` (legacy calls `appShell` with `header: ""`), so `ChatPage`/`TerminalPage` own only
  the runtime `.page__body page__body--chat/--terminal` root and their interior headings
  (`#chat-shell`/`#terminal`), not a page header.
- `ui/router.ts` registers a static record list and has no chat/terminal records today. The browser
  bundle cannot read `HANSE_UI_SPA_ROUTES` or `HANSE_UI_LEGACY`; `SmartLink` decides client vs full
  load through `isSpaPath()` (`ui/components/SmartLink.vue:4`, `src/shared/routes.ts:280`). The
  resolved server route set must therefore be carried in boot JSON, and the router needs a guard for
  any non-SPA destination (§4.1/§4.3).
- `renderSpaDocument` passes no `topbarActions`, so `appShell` emits the default IDE action on every
  SPA first load (`src/http/spa.ts:488-525`, `src/http/ui.ts:550-552`). A chat/terminal first load
  must either server-render a route fallback or accept a visible default-IDE flash; §4.2 chooses the
  server fallback with zeroed counters.
- Chat needs `page--chat` / `page__body--chat` with `overflow: hidden` and an inner scroll container
  (`src/http/styles.css:3841-3856`). Terminal needs `page--terminal` / `page__body--terminal`
  (`src/http/styles.css:8667-8684`). Both differ from the default `.page` scroll container.
- Chat sets `viewport = "width=device-width, initial-scale=1, interactive-widget=resizes-content"`
  (`src/http/chat.ts:585-589`); terminal loads four xterm vendor scripts and one vendor stylesheet
  (`src/http/terminal.ts:94-101`).
- The SPA dispatcher currently matches page routes only and deliberately excludes `/chat` and
  `/terminal` (`src/shared/routes.ts:197-211`; `test/shared-routes.test.ts:89-105`).
- The server dispatches `/chat` and all `/api/apps/*` through `handleChat` after the SPA dispatcher
  (`src/http/server.ts:326-359`, `:413-439`); terminal upgrade is handled separately
  (`src/http/server.ts:460-465`).
- The terminal proxy already authenticates with the human cookie and injects the runner bearer token
  server-side (`src/http/terminal.ts:125-184`); the browser never sees the runner token.
- The E2E fixture currently stubs the manager and has no deterministic chat SSE/terminal upstream
  (`e2e/support/server.ts:152-176`); chat/terminal E2E must add one.

### 1.5 Explicit amendments to the approved `spa-migration.md`

The owner direction closes the forks that the approved design deferred. These are amendments the
implementation plan must carry into `spa-migration.md`; they do not change its other invariants.

1. **Route registry matching.** `matchPage` gains the `chat` and `terminal` ids and therefore matches
   `/chat` and `/terminal` as page routes. The old statement "never matches `/chat` or `/terminal`"
   is superseded. `/api/*`, `/ide`, `/preview`, `/assets/*`, and terminal upgrades remain unmatched.
   The client router records for both ids are **not** covered by this amendment; they are design work
   in §4.1/Stage 1-3B.
2. **No default-enabled legacy island.** A temporary legacy island is forbidden on a
   default-enabled SPA route. A test-only/internal allowlist containing the full default SPA set
   plus the route under test is used while a registry flag is still `false`; a bare `=chat` or
   `=terminal` is forbidden because it replaces the whole set. Any temporary scaffold is removed
   before that route's default cutover. Stage 9 is a real DOM/state migration, not an island kept
   alive.
3. **Vendored xterm CSS exception.** The terminal keeps the existing vendored xterm stylesheet as a
   same-origin asset. It is an explicit exception to "`assets/app.css` is the single stylesheet";
   the exception is limited to the terminal route and has exactly one loader owner (§4.7). Prism
   stays behind the existing worker; no new dependency is added. Q6 means "no new dependency", not
   "no Vite bundling": Vite may bundle the existing Prism worker/assets (§4.10, §11.1 Q6).
4. **S4 has no workspace exception.** Entering/leaving chat and terminal is client-side like any
   other migrated route. A future full-document boundary would be a new S4 amendment, not a
   per-route Q.
5. **Shared modules are not legacy scripts.** `assets/markdown.js`, `assets/chat-core.js`,
   `assets/chat-commands.js`, `assets/chat-diff.js`, `assets/chat-highlight.js`, and
   `assets/chat-highlight-worker.js` stay in place as shared libraries through this migration (§11.1
   Q3). Only `assets/chat.js` and `assets/terminal.js` are page clients to be deleted. The new
   `assets/chat-feed-store.js` copy is an additional UI-owned module, not a move of any of the six.
6. **S9/S12 rollback/checkout lifecycle narrowed after cleanup.** S9/S12 hold through the operator
   gate: the legacy document and runtime flags remain a valid rollback, and a checkout without a UI
   build can still serve legacy chat/terminal. Stage 9 deliberately retires that for these two
   routes: they become `legacyRetired`, so `HANSE_UI_LEGACY=1`, `?legacy=1`, and
   `HANSE_UI_SPA_ROUTES` removal are ignored for them and the SPA is served (or a 503 HTML when the
   UI manifest is missing) instead of `undefined`/JSON 404. Afterwards the invariant reads "image
   rollback + mandatory UI build/deploy check" (§4.13), not "flag rollback". This is an intentional
   post-cleanup contract change, not a regression.
7. **S10 scope narrowed.** S10's "`/chat`, `/terminal`, `/ide`, and demo previews are untouched by
   this program" is superseded for `/chat` and `/terminal` only. Both are explicitly in this
   program's scope; `/ide` and demo previews remain untouched (S6 still protects their contracts).
8. **S13 page-HTML test lifecycle changed for chat/terminal.** S13's "page-HTML tests are replaced at
   a route's cutover" is narrowed: for chat and terminal the legacy page-HTML tests keep guarding
   the rollback renderer through the Stage 8 operator gate and are deleted with the legacy renderer
   at Stage 9, not at cutover. Every other migrated route keeps the S13 behavior. The legacy
   rollback smoke test is likewise retired at Stage 9, when post-cleanup rollback becomes image
   rollback + the §4.13 deploy check.

---

## 2. Current behavior and state ownership inventory

### 2.1 Legacy page composition

**Chat.** `GET /chat?app=<appKey>&project=<projectId>` is handled inside `handleChat`
(`src/http/chat.ts:2403-2434`). It:
- authenticates with `humanFrom`;
- redirects a missing app to the first operator application (`src/http/chat.ts:2411-2423`);
- renders a shell empty state when there are no apps (`renderNoApps`, `src/http/chat.ts:314-336`);
- returns the styled 404 for an unknown app;
- records the operator host for preview URL construction (`:2429-2431`);
- renders the full three-pane document (`renderChatPage`, `:365-620`).

The document sets `pageClass: "page--chat"`, `bodyClass: "page__body--chat"`, viewport, the chat
topbar actions, and loads only `/assets/chat.js` as a module (`src/http/chat.ts:573-619`). The shell
is the ordinary `appShell` with sidebar, topbar, breadcrumb, notices, and icon sprite
(`src/http/ui.ts:532-570`).

**Terminal.** `GET /terminal?app=<appKey>&project=<projectId>` is handled in `handler.route`
(`src/http/handler.ts:1157-1170`). `renderTerminalPage` returns `undefined` for an unknown app/project
and the caller renders 404. It renders a toolbar, status, banner, xterm host, announcer, and loads
`/assets/vendor/xterm/*` plus `/assets/terminal.js` (`src/http/terminal.ts:61-105`).

### 2.2 Chat SSE lifecycle

Server:
- `streamAppEvents` owns the app-scoped stream (`src/http/prompts.ts:669-842`).
- It requires a human principal, a configured manager, a running endpoint, and an app stream slot
  (`:683-727`); it emits `stream.ready` with `seq: 0` and a `streamID` (`:742-746`).
- Each event is enveloped as `data: JSON.stringify({...event, seq, streamID})\n\n` (`:742-745`).
- Heartbeats are `: ping` comments at `HANSE_EVENT_HEARTBEAT_MS` or the default
  (`:660-663`, `:799-801`).
- Cleanup aborts the upstream fetch, unsubscribes context/notice listeners, clears the heartbeat,
  and releases the stream slot (`:751-762`, `:722-729`).
- The server caps browser streams per application and returns `429 stream_limit` (`:714-721`).
- The typed event union is `HanseEvent` in `src/opencode/events.ts:139-225`: `stream.ready`,
  `question.*`, `permission.*`, `todo.updated`, `message.updated`, `message.part.updated`,
  `message.part.delta`, `message.part.omitted`, `session.status`, `session.error`,
  `session.compacted`, `notice.created`, `context.updated`, `session.activity`, `stream.warning`.

Client:
- `subscribe()` closes the previous source, then creates one `EventSource(eventsUrl())`
  (`assets/chat.js:8360-8429`). `eventsUrl()` is `/api/apps/:app/events?project=` (`:1238-1240`).
- `onopen` resets failures and sets `Live`; `onmessage` parses JSON and dispatches
  `handleStreamEvent`; `onerror` refreshes notices, retries twice, then pauses after three failures
  and probes the stream limit (`:8370-8429`).
- `closeStream()` nulls handlers, closes the source, and clears reconcile timers
  (`:8341-8358`).
- `reconnectStream()` re-subscribes, hydrates, refreshes notices, and reloads messages
  (`:8432-8439`).
- `stream.ready` and sequence handling live in `handleStreamReady` / `envelopeAccepted` /
  `handleStreamEvent` (`assets/chat.js:8817-8920`): a new `streamID` resets the sequence map;
  `seq <= last` is dropped; a gap schedules one reconcile; `stream.warning` and
  `message.part.omitted` also schedule reconcile and show a visible notice.
- Visibility and bfcache behavior: hidden stops runtime polling and flushes the draft; visible
  refreshes sessions/runtime/previews and reconnects when `shouldResubscribe` says so
  (`assets/chat.js:14115-14158`). `pagehide` flushes the draft and closes the stream when persisted;
  `pageshow` reconnects; `online` reconnects a non-open source; `beforeunload` closes the stream and
  context timers (`:14146-14255`).
- Hydration buffers events during a snapshot read (`assets/chat.js:8817-8850`), and idle/reconnect
  reconciliation is throttled (`:8441-8455`).

### 2.3 Terminal WebSocket lifecycle

Server: `proxyTerminalUpgrade` (`src/http/terminal.ts:109-263`):
- requires a human cookie (`:125-132`), `project` query (`:134-138`), a known app (`:140-146`), a
  runner URL/token (`:148-163`), and a WebSocket handshake (`:165-170`);
- connects to the runner `/v1/apps/:appId/exec` with `Authorization: Bearer <runner token>`
  (`:172-185`);
- pipes frames both ways and mirrors close/error (`:194-221`);
- forwards non-101 responses and rejects with 401/403/404/405/400/503/502 as appropriate
  (`:24-42`, `:224-260`).

Client (`assets/terminal.js`):
- reads `data-terminal-ws`, `data-runtime-url`, app/project from the shell (`:4-17`);
- keeps xterm, fit addon, socket, generation, retry attempt/deadline, fit frame, last cols/rows, and
  disposed flags in closure state (`:35-51`);
- runtime preflight via `GET /api/apps/:app/runtime?project=` (`:433-450`);
- retry delays `[1s, 2s, 4s, 8s, 15s]` with a visible countdown (`:20`, `:471-506`);
- every connect increments a generation and closes the old socket; stale callbacks are ignored
  (`:508-580`);
- `onmessage` writes `ArrayBuffer` frames to xterm; input is chunked at 16 KiB and sent as bytes
  (`:246-273`); resize is JSON `{type:"resize",cols,rows}` clamped to 1..1000 (`:275-304`);
- close handling distinguishes manual close, normal exit (1000/1001), retryable failure, and
  `1011` failure; it re-checks runtime before retrying (`:582-608`);
- fit uses `ResizeObserver`, `window.resize`, `visualViewport`, `document.fonts.ready`, and
  reduced-motion changes (`:646-674`);
- `pagehide` disposes xterm, disconnects observers, clears retries, and closes the socket
  (`:686-713`).

### 2.4 URL, session, and state ownership

| State | Current owner | Location |
| --- | --- | --- |
| `app`, `project`, `session` | URL query string | `/chat?app=&project=&session=` written by `updateUrl` (`assets/chat.js:12291-12297`) |
| Initial session | URL, validated against fetched sessions | `bootSessions` (`assets/chat.js:12723-12766`) |
| App switch | Full document navigation | app `<select>` sets `window.location.href` (`assets/chat.js:13963-13966`) |
| Sessions and tree | Closure state, server reads | `sessions`, `buildSessionTree` (`assets/chat-core.js:3390`), `refreshSessions` (`assets/chat.js:12238`) |
| Active session | Closure state + URL | `sessionId`, `selectSession` (`assets/chat.js:12379`) |
| Message/part store | Closure `store` from `createThreadStore` | `assets/chat.js:548`, `:379` |
| SSE source and sequence | Closure | `eventSource`, `lastSeqByStream` (`assets/chat.js:312`, `:8900`-ish) |
| Drafts, pending sends | Server rows + closure timers/maps | `assets/chat.js:320-345`, draft helpers `:2870-3062` |
| Queue-promotion suppression | `sessionStorage` | `assets/chat.js:179-182`, `:1056-1073` |
| Image intent | `sessionStorage` | `assets/chat.js:421`, `:4378-4409` |
| Terminal socket/generation | Closure | `assets/terminal.js:35-51` |
| Terminal retry deadline | Closure + DOM countdown | `assets/terminal.js:43-50`, `:483-506` |

There is no router, no store, and no teardown contract today. This is the central difficulty: a Vue
route must take ownership of state that currently lives in one closure.

### 2.5 Composer, queues, questions, approvals, OMO cards

- Composer: `#chat-composer` (`src/http/chat.ts:475-492`); event wiring at
  `assets/chat.js:13985-14055`. Enter sends (unless composing, coarse pointer, or Shift), Ctrl/Cmd+
  Enter sends, Escape closes palette/prompt/queue/drawer, and the textarea resizes to content.
- Drafts: debounced save (`DRAFT_SAVE_DEBOUNCE_MS = 500`, `assets/chat.js:139`), keepalive on hide,
  flush before switch, delete-if-empty, and server-side drafts (`GET/PUT .../draft`).
- Pending sends: `normalizePendingSends`/`pendingSendActions` in `assets/chat-core.js:2892-2997`;
  retry/dismiss via `POST .../pending/:pid/retry` and `DELETE .../pending/:pid`
  (`assets/chat.js:1282-1290`).
- Queue: `deriveQueue` (`assets/chat-core.js:921-1032`), queue strip
  (`assets/chat.js:1150-1187`), queue dialog (`:11499`), and `Needs input` topbar count.
- Questions: inline feed cards and the prompt dock; submit/reject
  (`assets/chat.js:11285-11421`), with correlation to the `question` tool part.
- Permissions: allow once/always/deny, risk chips, saved permissions, and the saved-permissions
  section (`assets/chat.js:11421-11680`); replies go to `/api/apps/:app/permissions/:id/reply`.
- SSH approvals: app-scoped polling and cards in `#chat-ssh-approvals`
  (`assets/chat.js:14266-14334`).
- OMO: `classifyOmo` (`assets/chat-core.js:841-919`) and client-side system cards; synthetic and
  internal messages are excluded from the queue.
- Handoffs: coordinator-annotated `info.hanse.handoff` cards and context-rail handoff list.

### 2.6 Attachments

- Upload uses `XMLHttpRequest` for progress/abort (`assets/chat.js:2538-2564`), up to
  `MAX_ATTACHMENTS = 10` and `MAX_ATTACHMENT_BYTES = 100 MiB` (`:148-151`), with two concurrent
  uploads (`:150`).
- Drag/drop, paste, attach button, hidden file input, chips, retry/remove, inline/file mode, quota
  warnings, and send payloads (`assets/chat.js:2768-2834`, `:2046-2340`, `:2270-2340`).
- Rendering: inline image/video/PDF or file-only path; history/SSE projections are already
  server-side (`src/http/chat.ts:1788-2250`, `src/attachments/*`).

### 2.7 Markdown, tables, diffs, highlighting

- `renderMarkdown(container, text)` builds DOM nodes with `textContent`; it never assigns Markdown
  through `innerHTML` (`assets/markdown.js:1-24`, `:129-214`). Tables come from
  `parseMarkdownTable` (`assets/chat-core.js:2408-2470`).
- `SafeMarkdown.vue` already wraps the same renderer for SPA pages, clears the container on every
  change, and is the precedent for chat Markdown (`ui/components/SafeMarkdown.vue:9-30`).
- `chat-diff.js` parses unified diffs, extracts edit/apply_patch/write/read views, and enforces caps
  (64 KiB per file, 128 KiB total, 50 files, 2,000 rendered lines; `assets/chat-diff.js:44-90`,
  `:614`, `:1396`).
- `chat-highlight.js` is stateful/DOM-adjacent, not pure: it lazily creates a module worker
  (`assets/chat-highlight.js:614-649`), owns `readyTimer`, mounts tool views (`:961`), resets on feed
  reset (`:1047`), and enforces time/node budgets. `chat-highlight-worker.js` runs Prism and returns
  plain fallback on failure. The migration keeps it as a shared library with explicit disposal
  (§4.10), not an island.

### 2.8 Scroll, keyboard, visibility, reconnect

- `.page` is the default scroll container (`src/http/styles.css:907-910`), but chat makes
  `.page--chat` `overflow: hidden` and scrolls `#chat-scroll` inside the thread
  (`src/http/styles.css:3841-3856`; markup `src/http/chat.ts:443-459`).
- Chat scroll state: pinned/paused/programmatic/RAF/last top (`assets/chat.js:372-377`), scroll
  handler (`:14078-14113`), autoscroll helpers (`:8127-8339`), history paging (`:12146`). The "New
  messages" button and prepend anchor are part of the contract.
- Keyboard paths: global Escape ordering (`:13913-13942`), composer keys (`:13985-14055`), palette
  keys, question Ctrl/Cmd+Enter (`:14161-14196`).
- Runtime/context/image/preview polling intervals: 10 s runtime, 2 s context up to 10 min, 60 s
  previews, image polls while building (`assets/chat.js:118-129`).
- Terminal keyboard/copy/theme/reduced-motion: `assets/terminal.js:139-240`, `:649-674`.

### 2.9 Current SPA integration points

- `ui/main.ts` reads boot JSON, creates Pinia/Vue Query, installs chrome, mounts into `#main`
  (`ui/main.ts:82-100`).
- `ui/router.ts` registers only current SPA routes, has no chat/terminal record and no navigation
  guard, and scrolls `.page` (`ui/router.ts:88-103`). Its `/:pathMatch(.*)*` record renders
  `NotImplementedPage`, which is what a direct SPA document for an unregistered route would show if
  the server and client route sets diverged.
- `ui/api.ts` is the cookie-only JSON client; mutations send `X-Hanse-Client: spa` (`ui/api.ts:90-130`).
- `ui/boot.ts` validates boot JSON and chrome only (`ui/boot.ts:28-103`); it has no route-set field.
  `ui/main.ts` calls `readBoot()` before installing the router (`ui/main.ts:82-100`). Boot JSON is
  emitted from `renderSpaDocument` (`src/http/spa.ts:492-524`) and is the only server-to-client
  channel that can carry the resolved SPA route set.
- `SmartLink` calls `isSpaPath()` at render time (`ui/components/SmartLink.vue:4`, `:20-23`). In the
  browser that function cannot see `HANSE_UI_SPA_ROUTES`/`HANSE_UI_LEGACY`; it must be parameterized
  by the boot route set (§4.1/§4.3).
- `ui/composables/useChrome.ts` applies a server-rendered chrome fragment, closes the mobile drawer,
  focuses main, resets `.page` scroll, and refreshes on visibility (`:20-152`).
- `src/http/spa.ts` emits the document, boot JSON, chrome, and `/api/ui/*` reads
  (`:392-525`, `:800-866`, `:933-1157`, `:1166-1221`).
- `src/http/ui.ts` composes the shell and owns sidebar/breadcrumb inner HTML (`:286-327`,
  `:340-363`, `:532-570`). `assets/app.js` owns the drawer/theme; `assets/app-content.js` owns legacy
  dialogs/menus/toasts/forms; SPA documents load only `app.js` (`src/http/ui.ts:316-319`;
  `test/ui/app-js-split.test.ts`).

---

## 3. Options

### Option A - Vue shell plus a lifecycle-managed legacy island (formal island contract)

What it is: a Vue `ChatPage.vue` / `TerminalPage.vue` owns the route and shell, renders a single root
container, and dynamically imports a refactored `assets/chat.js` / `terminal.js` that exposes
`mount(root, props)` and `dispose()`. The legacy module continues to own the chat/terminal DOM, but
all document-level queries/listeners become root-scoped and abortable.

Pros:
- Fastest path to "both routes are in the SPA"; preserves the battle-tested behavior with the least
  behavioral rewrite.
- Gives the operator something to verify early; rollback is trivial.
- Creates a formal seam (mount/dispose, root ownership) that a later port can reuse.

Cons:
- It is **not a migration of the implementation**: after cutover, `chat.js` still owns the chat DOM
  and all of its state. A later "cleanup" cannot delete `chat.js` without doing the migration anyway.
- Refactoring 121 listeners, 46 fetch sites, document-level selectors, sessionStorage, URL writes,
  and EventSource/WS lifecycles into a disposable root is itself a large, risky change to the
  least-tested code.
- It conflicts with the SPA rule "no legacy islands on SPA routes" (`spa-migration.md` §3.1) unless
  the island renders its own complete subtree and Vue never touches that subtree.
- The route is technically SPA but the owner's "migrate both before cleanup" outcome is not met: the
  legacy DOM owner survives.

Assessment: **rejected as the final architecture**. It can be accepted only if the owner defines
"migration" as route/shell cutover and explicitly keeps `chat.js`/`terminal.js` as supported code.
The owner rejected that definition (Q1). A short-lived scaffold is acceptable only behind the
test-only internal allowlist and must be removed before its route's default cutover; it is never the
default-enabled SPA route.

### Option B - Big-bang full Vue port

What it is: reimplement the entire chat/terminal client in Vue/TypeScript in one landed sequence,
including Markdown, tables, diff parsing, highlighting, commands, and all stores, then delete
`chat.js` and friends.

Pros:
- Clean, single-owner Vue implementation; easiest to test and maintain long term.
- No legacy island and no dual DOM ownership.

Cons:
- It is a big-bang rewrite of the highest-risk client code: the chat feed, streaming, scroll,
  diff, OMO, questions, and terminal lifecycles all change at once.
- The risk is concentrated exactly where the repository has the least test coverage (live DOM
  behavior), and every intermediate state must still be shippable.
- Reusing the pure modules is compatible with Option C and is not a reason to choose a big-bang
  port; Option B is rejected for sequencing and risk, not because shared pure modules must be
  rewritten.

Assessment: **rejected as the primary plan**. It is the wrong size for the available evidence and
test surface; Option C reaches the same end state in verifiable slices.

### Option C - Hybrid incremental extraction and adapters (recommended)

What it is: Vue owns the route, shell, DOM lifecycle, navigation, and new component tree; the
existing **pure/stateful** ESM modules are reused unchanged as shared libraries; the giant closure is
decomposed into stores + an explicit event reducer + adapters + components one vertical slice at a
time. A temporary island is allowed only as an internal scaffold behind the test-only allowlist and
is forbidden on a default-enabled SPA route; it is removed before that route's cutover.

Pros:
- Real migration: by the end, Vue owns chat/terminal DOM and `chat.js`/`terminal.js` can be deleted.
- Preserves proven behavior (`applySnapshot`, queue derivation, OMO classification, diff parsing,
  Prism worker, Markdown DOM builder) rather than rewriting it.
- Incremental and verifiable: each stage has usable sub-gates, tests, E2E, and rollback.
- Fits the existing SPA patterns (`ui/`, Pinia/Vue Query, boot/props, SafeMarkdown, chrome).
- Terminal is a small, isolated first proof; chat is ported by vertical slice.

Cons:
- Requires new stores/adapters, an event reducer, and a strict slice plan; more design/planning
  effort than A.
- The hard part is not `createThreadStore`; it is `handleStreamEvent` plus the DOM/state helpers.
  The plan must inventory every event and helper to a slice before implementation (Stage 0/3).
- Some modules are stateful/DOM-adjacent (`chat-diff`, `chat-highlight`), so their mounting needs a
  Vue container wrapper and explicit teardown; they remain shared libraries, not islands.
- Chat fidelity depends on preserving many small behaviors; the sub-gates and characterization
  tests, not Stage 7 alone, are the parity safety net.

Assessment: **recommended**. It is the only option that satisfies "migration before cleanup",
avoids a big-bang rewrite, and keeps the proven logic as shared libraries.

---

## 4. Proposed architecture (Option C)

### 4.1 Route manifest and dispatcher

Add two ids to `src/shared/routes.ts`:

| id | path | nav | spa until cutover | legacyRetired after Stage 9 |
| --- | --- | --- | --- | --- |
| `chat` | `/chat` | `none` (no nav item active) | `false` | `true` |
| `terminal` | `/terminal` | `project` | `false` | `true` |

**Client route records.** `ui/router.ts` is a static list, so the server flag alone cannot make
`/chat` or `/terminal` renderable. Add real records with lazy components and workspace metadata:

```ts
{ path: "/chat", name: "chat", component: () => import("./pages/ChatPage.vue"),
  meta: { workspace: "chat", legacyRetired: false } }
{ path: "/terminal", name: "terminal", component: () => import("./pages/TerminalPage.vue"),
  meta: { workspace: "terminal", legacyRetired: false } }
```

`RouteMeta` is augmented with `workspace?: "chat" | "terminal"` and `legacyRetired?: boolean`.
`meta.workspace` is the single signal `useChrome`/`focusMain`/`useWorkspaceShell` use to skip the
`.page` scroll reset and apply the workspace body/viewport (§4.2/§4.9); the `nav` table value still
drives `appShell`'s active nav. `meta.legacyRetired` is the client-side mirror of the shared route
flag and is set to `true` at Stage 9; the router guard reads it so `/chat?legacy=1` does not
reload-loop after cleanup. The terminal record lands in Stage 2 with `TerminalPage.vue`; the chat
record lands in Stage 3B with `ChatPage.vue`. Both exist before their route can receive a default
SPA document, so `router.push({ name: "chat" })` and a direct SPA load resolve to a component
instead of `NotImplementedPage`. A route-table test asserts that every page route id which can
appear in the boot `spaRoutes` set has a router record and a `legacyRetired` value consistent with
the shared registry.

**Resolved route set and navigation guard.** Boot JSON gains `spaRoutes` (the ids for which
`isSpaRoute(id, { manifestValid: true })` is true at document time, §4.3). `ui/main.ts` installs it
before `app.use(router)`. `SmartLink` and the router guard use this set instead of calling
`isSpaPath()` without server context:

- `SmartLink` computes `spa = isSpaPathIn(pathname, spaRoutes)`; a path outside the set renders the
  plain `<a>` and full-document-loads. `isSpaPathIn` is a pure helper added next to `isSpaPath` in
  `src/shared/routes.ts` (`matchPage(pathname)` plus set membership), so it has no `process.env`
  dependency in the browser; `ui/spa-routes.ts` owns the installed boot set.
- A `router.beforeEach` guard checks the destination: if `matchPage(to.path)` is undefined, or the
  matched id is not in `spaRoutes`, or (`to.query.legacy === "1"` **and** the id is not
  `legacyRetired`), it calls `window.location.assign(to.fullPath)` and returns `false`. This is a
  full document load, never a client render of `NotImplementedPage`. The guard covers programmatic
  `router.push`, back/forward, and a direct reload whose server route set changed after a restart.
  The `legacyRetired` exclusion is required after Stage 9: the server ignores `?legacy=1` on those
  routes, so the client must ignore it too or a direct `/chat?legacy=1` load would reload forever.
- The `/:pathMatch(.*)*` record stays only as a defensive fallback for a missing record on an SPA
  path; the route-table test above prevents that in practice.

**Allowlist behavior.** Before a registry cutover, a test-only allowlist containing the route under
test is used. Because `HANSE_UI_SPA_ROUTES` is a **replacement** set, the test value must contain
**every** default SPA route id plus the route under test; a bare `=chat` or `=terminal` would turn
all other SPA routes legacy. The E2E config exposes `SPA_E2E_ROUTE_IDS` (every default SPA id) and
builds the value as `${SPA_E2E_ROUTE_IDS},chat` (or `,terminal`) as needed. A test asserts the set
contains every route the spec navigates through. With no allowlist entry and `spa:false`, the boot
set omits the id, `SmartLink` emits a plain anchor, and the guard full-loads; no chat/terminal
component renders. After cutover (`spa:true`) the id is in the default set; pinning one route legacy
requires listing every route that should stay SPA. Do not enable chat/terminal through the allowlist
before the corresponding router record/component lands (Stage 2 terminal, Stage 3B chat). After
Stage 9, `legacyRetired` makes the two ids unconditionally present regardless of the allowlist
(§4.13).

`matchPage` changes from page-paths-only to also match the two static page paths `/chat` and
`/terminal` (amendment §1.5.1). The query string (`app`, `project`, `session`) is not part of the
match; the route component reads it from `route.query` and it is the sole URL owner (§4.8). The
route registry keeps `/api/*`, `/ide`, `/preview`, `/assets/*`, and terminal upgrades unmatched.
`RouteDefinition.nav` gains `"none"` (or a separate `shellNav` field) so chat can use the legacy
`active: "none"` shell state (`src/http/ui.ts:342`, `src/http/chat.ts:575`). Adding `nav: "none"`
does not add a sidebar item.

`maybeServeSpa` (`src/http/spa.ts:800-866`) remains the single page-dispatch point. For chat/terminal
it must:

1. resolve props with the same `findApp`/`buildSite` rules as the legacy page;
2. until Stage 9, fall through to the legacy renderer when props are `null` (missing app/project,
   no-app chat, unknown terminal), so the existing `302`/`404` behavior is preserved. After Stage 9
   there is no legacy branch to fall through to: the same edge cases are handled by
   `maybeServeSpa` itself (§4.13) and must never return `undefined`;
3. after resolving the app and before rendering, record the operator host **only when the host is
   present**, matching legacy exactly:
   `if (request.host !== undefined) deps.previews?.recordOperatorHost(app.id, request.host);`
   (`src/http/chat.ts:2429-2431`). The SPA and `/api/ui/chat` paths use the same guard;
4. not intercept `/api/apps/*`, `/api/ui/*`, `/assets/*`, `/ide`, `/preview`, or terminal upgrades.

Until Stage 9 this preserves the useful legacy entry behavior for `/chat` without an app:
`handleChat` still redirects to the first operator app (`src/http/chat.ts:2411-2423`); the
redirected request is then served by the SPA when the flag is on. Stage 9 implements the same entry
semantics in `maybeServeSpa` (§4.13).

The legacy branches stay in place until the operator gate:
- `handleChat` keeps `GET /chat` for rollback and all `/api/apps/*` APIs
  (`src/http/chat.ts:2400-2434`);
- `handler.route` keeps `GET /terminal` for rollback (`src/http/handler.ts:1157-1170`);
- the terminal upgrade proxy is unchanged (`src/http/server.ts:460-465`,
  `src/http/terminal.ts:109-263`).

### 4.2 Shell and page-class integration

The SPA shell emits `<main class="page" id="main">` with a `.page__body` wrapper
(`src/http/ui.ts:561-563`), while existing Vue route components own their header and a nested
`.page__body` (`ui/pages/AppPage.vue:279-317`). Chat/terminal need additional page/body classes, a
different viewport, and route-specific topbar actions. The legacy `appShell` markup is not changed:
legacy documents must stay byte-identical until cleanup (S2).

Proposed `WorkspaceHost` contract:

- `renderSpaDocument` gains optional `pageClass`, `bodyClass`, and `viewport`, and forwards them to
  `appShell` (`src/http/spa.ts:488-525`; `src/http/ui.ts:351-363`). For a chat first load it emits
  `page--chat` / `page__body--chat` and the chat viewport; for terminal `page--terminal` /
  `page__body--terminal`.
- The server-emitted `.page__body` is the **first-paint fallback only**, and it must carry
  `page__body--chat/--terminal` so the pre-mount paint does not flash the default scroll layout.
  On mount Vue replaces `#main`'s children. `ChatPage`/`TerminalPage` then render the single runtime
  `.page__body page__body--chat/--terminal` root plus their interior heading (`#chat-shell`/
  `#terminal`) themselves. Unlike `AppPage`/`ProjectsPage` they do **not** render a `.page-header`:
  legacy chat/terminal pass `header: ""` and put the accessible title inside the workspace shell
  (`src/http/chat.ts:573-620`, `src/http/terminal.ts:61-106`). There is never a second nested body
  wrapper and no invented page header. `useWorkspaceShell` toggles `#main`'s page class and the
  viewport meta on client navigation, and restores the default on leave; the route component owns
  its own body class.
- `TopbarActions.vue` is **App-level and persistent**, mounted once by `App.vue`, not owned or
  remounted by `ChatPage`/`TerminalPage`. It teleports into the existing `.topbar__actions` container
  (the class already exists in `appShell`; no id or markup change is needed, so legacy HTML stays
  byte-identical). The server fallback is **pre-JS only**: `ui/main.ts` reads the boot `topbar` seed,
  calls `replaceChildren()` on `.topbar__actions` exactly once before `app.mount`, then mounts;
  `TopbarActions` renders the same seed on its first render. After that the container is Vue-owned
  and there is exactly one action set (no server + teleport duplication). A test asserts node counts
  and unique action ids before/after mount, not only component ownership.
  It then renders:
  - default: the existing IDE action;
  - chat: needs-input button, policy chip, context toggle, IDE action
    (`src/http/chat.ts:392`);
  - terminal: the default IDE action.
  Chat controls read the Pinia `chatUi` store populated by `ChatPage.vue`. Leaving chat/terminal
  resets the store and the persistent component renders the default action again; the component is
  never unmounted by route changes, so there is one topbar owner across the SPA.
- **Topbar first paint.** `renderSpaDocument` currently emits no `topbarActions`, so a chat/terminal
  first load would show the default IDE-only action until mount. The chosen fix is a server-rendered
  route fallback, not hiding the actions: `renderSpaDocument` gains `topbarActions?: string`, and
  `maybeServeSpa` derives it from stable chat/terminal props. Chat emits the same control set as
  legacy with `needs-input` and policy chips hidden and the needs-input count at `0`; terminal emits
  the default IDE action. `TopbarActions` renders the same markup on mount, then updates counters
  from `chatUi`; there is no default-IDE flash and no action-set layout jump. Counts start at `0`
  because the store has no data before the first session read, which matches the legacy hidden
  needs-input button. A first-paint test asserts the chat control set is present before mount and
  the terminal action matches the default; visual QA/CLS cover the no-flash requirement.
- If a future owner decision changes the S4 navigation boundary, it must be an explicit S4 amendment
  in `spa-migration.md`; this design does not carry a route-level exception.

Why not let chat components mutate `main` or the topbar directly? Because leaving the route must
restore the default class/viewport/topbar deterministically, and the server first paint must match
the client. One composable with a cleanup function and one persistent topbar component are testable;
ad-hoc edits in multiple route components are not.

The vendor xterm stylesheet is **not** emitted through `renderSpaDocument.styles`. It has exactly one
owner, the `TerminalView` on-demand loader (§4.7), which works for both a first terminal document and
a client-side navigation into terminal. Server `<link>` injection and the loader are not combined.

### 4.3 Server props and boot

Add two prop modules and two cookie-only endpoints:

| Endpoint | Props |
| --- | --- |
| `GET /api/ui/chat?app=&project=` | app/project identity, app href/folder/master, links (app, IDE, settings, skills, terminal, handoffs), runtime state + runtime URL, app selector options, pending restart, handoffs, previews, deleting state, breadcrumb/title, stable `topbar` fallback (`ideHref`, `needsInputCount: 0`, `policyVisible: false`, `contextToggle: true`) |
| `GET /api/ui/terminal?app=&project=` | app/project identity, runtime state, WS path, runtime URL, chat href, breadcrumb/title, stable `topbar` fallback (`ideHref`) |

Rules:
- Cookie-only `humanFromCookie` like every `/api/ui/*` endpoint (`src/http/spa.ts:904-930`).
- **Boot route set.** `renderSpaDocument` takes `spaRoutes: readonly RouteId[]` and writes it into the
  boot JSON next to `route`, `props`, `chrome`, and `topbar`. The boot `topbar` seed is the same
  object used to render the server fallback for every SPA route (default IDE action for non-workspace
  routes; chat/terminal `topbar` props for those routes). `maybeServeSpa` computes `spaRoutes` once
  from the shared registry with the same `manifestValid: true` rule it used to admit the request:
  `ROUTES.filter((route) => isSpaRoute(route.id, { manifestValid: true })).map((route) => route.id)`.
  This is the client-readable result of `isSpaRoute`/the allowlist; it is not a second policy. The
  current boot route id must be in the set, otherwise boot is rejected (fail closed) and the client
  shows the existing load-failure fallback instead of routing to a page the server did not enable.
  `ui/boot.ts` validates `spaRoutes` as an array of strings, keeps only known `RouteId`s, and
  `ui/main.ts` installs the set before the router mounts (§4.1). Unknown ids never enable a route.
- **Topbar fallback.** `renderSpaDocument` also takes `topbarActions?: string` and forwards it to
  `appShell`. `maybeServeSpa` builds it from the same stable `topbar` props for chat/terminal so the
  first paint matches the mounted component and counters start at `0` (§4.2).
- No secrets: no runner token, no auth token, no WebSocket token. The WS path contains only
  app/project, exactly as today (`src/http/terminal.ts:58`). `spaRoutes` and `topbar` contain only
  route ids, hrefs, and zeroed counters.
- Chat message/session/queue/prompt data stays on the existing `/api/apps/*` APIs. `/api/ui/chat`
  only supplies the page frame and context-rail data that the legacy server render supplies.
- Extract the data assembly before freezing the legacy renderer, with characterization tests, so the
  legacy HTML and the SPA props cannot drift (same rule as `spa-migration.md` §6.5).
- Until Stage 9, `/chat` with no app falls through to the legacy redirect, `/chat` with an unknown
  app falls through to the legacy 404, and `/terminal` with a missing/unknown app falls through to
  the legacy 404. The SPA never renders boot with `props: null`. After Stage 9 those entry cases are
  implemented inside `maybeServeSpa` (redirect / retained no-apps page / styled 404, §4.13); they
  never fall through to a deleted branch.
- `route.query.session` is the **only** initial session input; `/api/ui/chat` does not carry an
  `initialSession` prop. Canonicalization is not unconditional
  (`assets/chat.js:12723-12766`): if the session list loads and the requested id exists, keep it; if
  the list loads and the requested id is absent, choose the first root and `router.replace` the
  canonical `session=`; if the list is empty, **preserve** any requested `?session=` and render the
  draft/empty state instead of inventing a session; if the agent is stopped/error and sessions are
  unreadable, **preserve** the requested `?session=` (or its absence) and render the stopped shell
  instead of canonicalizing to the first root. §4.8 carries the single-writer rules and tests.
- **Operator host recording.** Both the SPA first load (`maybeServeSpa`) and `/api/ui/chat` record
  the operator host before returning chat props, matching legacy `GET /chat`, **guarded by the same
  `request.host !== undefined` check** (`src/http/chat.ts:2429-2431`):
  `if (request.host !== undefined) deps.previews?.recordOperatorHost(app.id, request.host);`.
  A direct `/api/ui/chat` load and a client-side navigation into chat therefore behave like the
  legacy document for preview URL construction. The terminal has no equivalent legacy call.

`chromeFor` gains chat/terminal cases (`src/http/spa.ts:305-373`):
- chat: title `<appKey> chat`, breadcrumb Projects → project → app → Chat, active `none`;
- terminal: title `<appKey> terminal`, breadcrumb Projects → project → app → Terminal, active
  `project`.
Because the project/app come from the query, `chromeFor` needs a workspace hint (project id, app
key, title, breadcrumb) derived from the same props. `maybeServeSpa` passes that hint for the boot
document; `/api/ui/chrome` accepts the same `project`/`app` query hints, and `fetchChrome` forwards
them on every client navigation and visibility refresh (current call passes only `to.path`). As a
fallback, the page response already carries `chrome`, so a failed hint request cannot blank the
shell.

`GET /api/ui/chrome?path=/chat&project=<id>&app=<key>` resolves the project/app from hints, not only
`match.params`, so a chat/terminal chrome refresh keeps the correct active project and breadcrumb.

### 4.4 Client component boundaries

`ui/pages/ChatPage.vue` (lazy route chunk) orchestrates:

```
ChatPage
├─ ChatSessionsRail             sessions, tree, search, new/delete
├─ ChatThread
│  ├─ ChatHistoryRow            "load earlier" state
│  ├─ ChatMessage               keyed by message id
│  │  ├─ MarkdownBlock          text/reasoning, throttled renderMarkdown
│  │  ├─ ToolPart               generic tool view + specialized renderers
│  │  │  ├─ DiffView            chat-diff + chat-highlight container
│  │  │  └─ ReadView / WriteView
│  │  ├─ OmoCard                classifyOmo
│  │  └─ HandoffCard
│  ├─ ChatGeneratingRow
│  ├─ ChatNoticeRow
│  └─ ChatNewMessagesButton
├─ ChatComposer                 textarea, send/stop, attachments, draft, recovery
│  └─ ChatCommandPalette
├─ ChatQueueStrip
├─ ChatPromptDock               questions + permissions
├─ ChatQueueDialog
├─ ChatContextRail              app, previews, context/compact, plan, saved, handoffs
└─ ChatScrim
```

`TopbarActions` is not in this tree; it is the App-level persistent component described in §4.2.
Chat-specific topbar state is published to `chatUi` and reset on unmount.

`ui/pages/TerminalPage.vue`:

```
TerminalPage
├─ TerminalToolbar              title, runtime pill, status, copy/reconnect/close
├─ TerminalBanner
├─ TerminalView                 xterm host; loads vendor scripts/stylesheet
└─ TerminalStoppedState         runtime stopped/error
```

Boundary rules:
- Components never query the whole document. They use their own refs and the adapters.
- The shell chrome stays server-rendered and is swapped through `applyChrome` / the page response.
- Dialogs use the existing SPA dialog pattern (`<dialog>` + focus restoration); chat does not rely on
  `app-content.js` (SPA documents do not load it; `src/http/ui.ts:316-319`).
- Pure and stateful shared modules remain shared imports: `assets/markdown.js`,
  `assets/chat-core.js`, `assets/chat-diff.js`, `assets/chat-commands.js`,
  `assets/chat-highlight.js` and its worker. They are not "islands": they do not own document
  listeners, SSE/WS, URL state, or the route. `chat-highlight` is stateful/DOM-adjacent, not pure,
  and has explicit disposal (§4.10).
- The six shared modules stay at their current paths for this migration (owner decision §11.1 Q3).
  They are not moved under `ui/chat/lib/` as part of the cutover or cleanup; any future relocation is
  a separate behavior-preserving refactor. Stage 9 cleanup preserves all six.

### 4.5 Stores, feed model, and event reducer

The hard part of Option C is not `createThreadStore`; it is `handleStreamEvent`
(`assets/chat.js:8888-9600`) plus the DOM/state helpers it drives. The design makes that explicit:

- **`ui/chat/event-reducer.ts`** - a pure reducer that turns an enveloped `HanseEvent` into typed
  state actions. It owns sequence/gap decisions and per-session filtering but no DOM and no fetch.
- **`ui/chat/state-actions.ts`** - applies those actions to Pinia stores and returns render intents
  (dirty message/part ids, scroll intent, notice/toast, reconcile request). Components subscribe to
  intents; the reducer never queries the document.
- **Function/event-to-slice inventory** - a Stage 0 deliverable in the plan/journal. It lists every
  `HanseEvent` type, every `PartType`, and every function group in the legacy closure
  (`handleStreamEvent`, hydration buffering, message/part upsert, queue derivation, prompt dock,
  context/status render, notices, scroll, draft/pending, attachments, commands) with its target
  store/action and Stage sub-gate. No slice starts until its rows are assigned.

Event-to-slice map (the plan expands each row into exact actions and tests):

| Event | Slice / action |
| --- | --- |
| `stream.ready` | stream reset: new `streamID`, seq map reset, failures/limit cleared, ready rehydration, runtime/context/commands/notices refresh |
| `stream.warning` | `chatUi` notice + `scheduleReconcile`; `limit` pauses via `probeStreamLimit` |
| `notice.created` | `chatFeed.notices` (session-filtered) |
| `context.updated` | `chatContext.snapshot` + context meter/status |
| `message.updated` | `chatFeed.upsertMessage`, optimistic reconciliation, pending refresh |
| `message.part.updated` | `chatFeed.upsertPart`, queue recompute, unknown-part reconcile |
| `message.part.delta` | `chatFeed.appendDelta` (buffered + throttled) |
| `message.part.omitted` | `chatFeed.markOmitted`, inline-question unavailable, reconcile + warning |
| `session.status` | `chatFeed.agentStatus`, queue/composer state, context refresh |
| `session.error` | error row, pending/abort settlement, idle status, toast/notice |
| `session.compacted` | context refresh, announcement, toast |
| `session.activity` | reconcile unless `message`/`status` |
| `question.asked` / `permission.asked` | `chatPrompts.upsert`, dock/inline correlation, queue |
| `question.replied` / `question.rejected` / `permission.replied` | `chatPrompts.resolve` + tombstone/outcome |
| `todo.updated` | `chatContext.todos` / plan panel |

`PartType` coverage is explicit: `text`, `reasoning`, `tool`, `step-start`, `step-finish`, `patch`,
`file`, `subtask`, `retry`, `compaction`, `snapshot`, and `agent`. Unknown future part types keep the
legacy "needs reconcile + refresh" behavior, never a silent drop.

Pinia (client UI state; no URL writes):
- `chatUi`: route-derived app/project/session ids (read-only mirrors), sessions/context drawer open,
  queue dialog, palette state, topbar counters, connection label, policy warnings, pending image
  gate, deletion-pending banner.
- `chatSession`: session list/tree, active id mirror, selection generation, loading/error, expanded
  nodes.
- `chatComposer`: draft text, attachments, uploading count, send/error/recovery, pending sends.
- `chatPrompts`: questions, permissions, saved permissions, busy/error/draft per request key.
- `chatFeed`: keyed messages/parts, order, current `streamID`/`lastSeq`, notices, last rendered
  count, dirty flags. Use `shallowRef`/`markRaw` for large maps and mutate through store actions.
- `chatContext`: context snapshot/todos/plan, previews, handoffs, runtime view.

`route.query` is the source for `app`, `project`, and `session` (§4.8). Stores may hold the last
fetched/selected values and a monotonically increasing selection generation, but they do not write
the URL and are never a second source of truth. User selection calls the router; one route watcher
applies the new query.

Vue Query (server reads):
- sessions, message pages (`limit=30`, `before`), notices, todo/plan, prompts, saved permissions,
  context, commands, previews, runtime, handoffs. Use `staleTime: 0` / `no-store` like the legacy
  client, and `retry: false` for chat reads so `agent_stopped`/deletion errors render immediately.

Reuse and copy-first extraction:
- `createThreadStore` currently lives **inside the legacy page client** at `assets/chat.js:548` and
  is used by the legacy route at `:379`, `:11907`, and `:12530`. Legacy `/chat` loads
  `assets/chat.js` directly without Vite or TypeScript, so it cannot import a `ui/` module, and S2
  forbids editing or importing into `chat.js` before Stage 9. Stage 3A therefore does **not move**
  the function.
- Stage 3A adds a new plain-ESM copy, `assets/chat-feed-store.js`, exporting `createThreadStore` with
  the same shape the core functions expect (`sessionID`, `generation`, `turnGeneration`, `order`,
  `messages`, `activePromptID`, `queue`, `openParts`, `lastSeqByStream`, `currentStreamID`,
  `pendingDeltas`, `agentStatus`). `ui/chat/feed-store.ts` is a typed re-export/wrapper over that
  copy. `assets/chat.js` keeps its local function byte-frozen; the copy has no import from the
  legacy client and no `ui/` dependency.
- **Source-of-truth/drift rule.** Until Stage 9 the frozen legacy implementation is the behavior
  oracle and the new module is the SPA implementation. Characterization tests drive the new module
  with the same recorded fixtures used for the legacy page (feed order, message/part maps, optimistic
  rekey, queue, stream ids) and compare results; a freeze test pins the `createThreadStore` block in
  `assets/chat.js` to its recorded baseline so an accidental edit fails. Any behavioral fix during
  the migration lands in the new module first; editing the frozen legacy copy requires an explicit
  S2 exception recorded in the stage journal, after which both fixtures are updated. After Stage 9
  deletes `assets/chat.js`, the copied module is the sole implementation and the characterization
  tests become its regression suite. This rule is the only permitted source of a second copy.
- `applySnapshot` stays the single snapshot merge (`assets/chat-core.js:1763-1980`).
- `deriveQueue` stays the single queue derivation (`assets/chat-core.js:921-1032`).
- `buildSessionTree`/`firstRootId`/`ancestorIds` stay the single session tree
  (`assets/chat-core.js:3390-3500`).
- `docs/design/chat-qa.mjs` remains the deterministic browser harness; the plan reuses its scenarios
  rather than inventing a second fixture for chat.

### 4.6 Chat SSE adapter and auth expiry

`ui/chat/stream.ts` exports a framework-free adapter:

```
createChatStream({
  url,
  onEvent, onReady, onGap, onError, onStatus,
  onResync, onAuthExpired,
}): { connect(), disconnect(), dispose() }
```

- Uses `EventSource(url)` with credentials implied by same-origin cookies. The URL is
  `/api/apps/:app/events?project=` (`assets/chat.js:1238-1240`); no token is added.
- Tracks `lastSeqByStream` and `streamID`. Drops `seq <= last`, resets on a new streamID, and calls
  `onResync` once per gap/warning (mirrors `assets/chat.js:8817-8920`).
- `stream.ready` is handled on **every** ready frame, not only the first: reset `streamID`/sequence,
  `failures = 0`, clear stream-limit pause, hide warning/paused notices, set `Live`, and rehydrate
  runtime/context/commands/notices/messages. This mirrors `handleStreamReady`
  (`assets/chat.js:8817-8850`).
- `onerror` behavior is exact:
  1. If `document.hidden`, set `Reconnecting` and return: no client failure-counter increment, no
     stream-limit/auth probe, and no app-level reconnect timer while hidden. This does **not** stop
     the browser's native `EventSource` auto-reconnect; the adapter does not claim to. Visibility
     restore calls `shouldResubscribe` (`assets/chat-core.js:3075-3150`) with
     `STREAM_HIDDEN_RECONNECT_MS = 10s` / `STREAM_CONNECTING_RECONNECT_MS = 5s`
     (`assets/chat.js:134-135`) and closes/reopens only if the source is not open. Tests assert no
     client counter/probe/timer while hidden, not zero native reconnects.
  2. Visible failure: increment `failures`, refresh notices, keep `Reconnecting` for attempts 1-2.
  3. At `failures >= 3`: close the source, set `Paused`, render the plan, and run `probeStreamLimit`
     once (deduped by an in-flight guard; 3 s `AbortController`), mirroring
     `assets/chat.js:8388-8429` / `:1516-1550`.
  4. `probeStreamLimit` fetches the event URL with `accept: text/event-stream`, `cache: no-store`.
     `429` + `code: "stream_limit"` -> `pauseForStreamLimit` (visible notice, no auto retry).
     `401`/`403` -> run the cookie-only auth probe below, then redirect to
     `/login?next=<current fullPath>` and cancel retries. Any other response -> `Paused` with a
     manual Retry; there is no automatic fourth attempt.
- **Auth-expiry probe.** `EventSource` and `WebSocket` expose no HTTP status, so the adapter never
  guesses from the event. On the bounded pause (or on the terminal's final retryable close) it calls
  `GET /api/ui/chrome?path=/chat|/terminal` with same-origin credentials, one request per pause
  window with a 5 s cooldown. A `401` (or `403` for a rejected bearer) is treated as session expiry:
  stop reconnect, clear timers, and hand off to `onAuthExpired`, which uses the same
  `/login?next=` path as `ui/api.ts:77-88`. A `200` means the session is alive, so the state stays
  `Paused` for a manual Retry. The probe is never run while hidden.
- Bounds: at most three automatic visible failures, then pause; the stream-limit probe is at most one
  in flight; auth probes are at most one per pause window. No failure path loops.
- `dispose()` nulls handlers, closes the source, clears reconnect/limit/auth-probe timers and the
  abort controller, and ignores stale callbacks. The adapter owns no DOM.
- ChatPage calls `connect()` on mount and after an app switch; `disconnect()`/`dispose()` on unmount.
- Snapshot hydration is driven by `stream.ready`, `onResync`, visibility, and idle/reconnect
  reconciliation; it reuses the existing 30-message tail + older-page logic
  (`assets/chat.js:12146-12290`).
- `pagehide` (persisted) flushes the draft, closes the source, and marks bfcache; `pageshow` calls
  `connect()` once when the document is visible; `beforeunload` closes the source and context timers.

### 4.7 Terminal WebSocket adapter

`ui/terminal/socket.ts`:

```
createTerminalSocket({
  wsPath, runtimeUrl,
  onData(bytes), onStatus(kind, detail), onBanner(text), onExit(kind), onAuthExpired,
}): { connect(manual), close(), dispose() }
```

- Builds `ws(s)://${location.host}${wsPath}`; the proxy authenticates by cookie and injects the
  runner token (`src/http/terminal.ts:109-184`). No token in the URL.
- Runtime preflight via `/api/apps/:app/runtime?project=` before connecting
  (`assets/terminal.js:433-450`).
- Generation guard, retry delays `[1,2,4,8,15]s`, manual close, normal exit, `1011` failure,
  stopped/error handling (`assets/terminal.js:493-608`). Automatic retries stop after the final
  delay and expose a manual Reconnect; there is no infinite retry loop. **Recorded C9 deviation:**
  legacy `scheduleRetry` caps the delay at 15s but keeps retrying indefinitely; the SPA intentionally
  performs exactly five automatic attempts and then stops. Tests assert five attempts, a visible
  countdown, and a manual-only recovery after the fifth.
- **Auth expiry and reconnect.** A failed WebSocket upgrade exposes no HTTP status to the browser.
  Before scheduling a retryable close, at most once per retry window with a 5 s cooldown, the adapter
  calls the cookie-only `GET /api/ui/chrome?path=/terminal`. `401`/`403` stops retries, closes the
  socket, and calls `onAuthExpired` -> `/login?next=<current fullPath>`. `200` means the session is
  alive, so the normal bounded retry continues. No probe runs while `document.hidden`.
- Sends input as bytes, resize as JSON, clamps 1..1000 (`assets/terminal.js:246-304`).
- `dispose()` closes the socket, clears retries/countdown/auth-probe timers, and ignores stale
  callbacks.
- `pagehide` disposes xterm/observers and closes the socket; `pageshow` reconnects once when visible.

`TerminalView.vue`:
- **Sole owner of the vendor xterm CSS.** It loads `/assets/vendor/xterm/*.js` and the one vendor
  stylesheet on demand with an idempotent, promise-cached loader. The server does not also emit the
  stylesheet through `renderSpaDocument.styles`; this avoids a duplicate `<link>` on first load and
  works on client-side navigation into terminal. If loading fails, show "Terminal engine
  unavailable" with a retry; until Stage 9 the state also offers a `?legacy=1` link, and after Stage
  9 that link is removed because no classic terminal exists (§4.13). Do not fall back to a legacy
  script automatically.
- Instantiates xterm with the existing options (font from tokens, scrollback 5000, screenReaderMode,
  cursor blink honoring reduced motion) (`assets/terminal.js:319-386`).
- Uses `ResizeObserver`, `window.resize`, `visualViewport`, `document.fonts.ready`, and a
  `MutationObserver` on `data-theme` (`assets/terminal.js:646-674`). A pending `document.fonts.ready`
  callback is guarded by a disposed flag and cannot fit after unmount.
- Disposes xterm, observers, listeners, pending font callback, and the socket on unmount.

Vendor strategy: keep the existing vendored xterm/Prism assets (no new dependency). The loader is a
tiny same-origin script/CSS injector, not a legacy island. This preserves S11 and the asset allowlist
(`src/http/handler.ts:147-166`).

### 4.8 URL and router ownership

`route.query` is the single writer and single source for workspace identity:

- `/chat` route query: `app` (required to render the workspace), `project` (optional but
  disambiguating), `session` (optional; validated after sessions load).
- `/terminal` route query: `app`, `project`.
- A small `useChatRouteState` reads normalized query values (`string` only; arrays, blank strings,
  and unknown keys dropped) and exposes `routeApp`, `routeProject`, `routeSession`.
- Exactly one watcher applies `app`/`project`/`session` from `route.query` to the stores. Nothing
  else writes the URL: no component calls `history.replaceState`, no store writes the router, and
  there are no replace/select guard flags. When the query already equals the desired value, the
  action is a no-op.
- Session selection from the rail or a deep link is a **user action**: increment the selection
  generation, paint the target shell, abort stale reads, flush the previous draft in the background,
  then `router.replace({ query: { ...route.query, session } })`. `replace` matches legacy
  `history.replaceState` and does not add a history entry (`assets/chat.js:12291-12297`). Rapid
  clicks are serialized by the generation; only the last generation may apply.
- Initial canonicalization is conditional, matching legacy boot (`assets/chat.js:12723-12766`):
  1. sessions loaded and requested `session` exists -> keep it (no URL write);
  2. sessions loaded, requested `session` absent -> choose the first root and `router.replace` the
     canonical `session=`;
  3. sessions loaded but empty -> preserve any requested `?session=` exactly as legacy does
     (`startDraft` does not rewrite the URL) and render the draft/empty state; do not invent a
     session;
  4. agent stopped/error and sessions unreadable -> preserve the requested `?session=` (or its
     absence) and render the stopped shell; do not canonicalize to the first root or drop the deep
     link. This mirrors the legacy catch that restores `sessionId = requested` and calls
     `updateUrl()` (`assets/chat.js:12749-12762`).
  The watcher sees a canonicalized query once and does not re-select, because it compares against
  the already-applied session. This replaces the legacy boot validation without a guard flag.
- App switch is a **user action**: flush the current draft, drop the current session/draft/feed, and
  `router.push({ name: "chat", query: { app, project } })`. `ChatPage` is keyed by
  `appKey:projectId`, so the old SSE/feed/drafts are torn down and the new page boots cleanly. This
  replaces the full `window.location.href` switch (`assets/chat.js:13963-13966`) without losing SPA
  navigation.
- Back/forward restores the query; the watcher applies the target app/session. An app change remounts
  through the same key; a session change starts at the tail. If sessions loaded and the session is
  gone, fall back to the first root and `replace` the canonical URL. If the agent is stopped or the
  session list is empty, preserve the requested `session` per the four rules above.
- `scrollBehavior` targets `.page` only for normal routes. For chat/terminal the component owns the
  inner scroll container, so the router does not scroll `.page` (it is `overflow: hidden`).
  `focusMain()` likewise does not reset `.page` for workspace routes (§4.9); ChatPage restores its
  own `#chat-scroll` anchor on back/forward when the session is unchanged.
- `/chat` without `app`: server redirect (legacy); the SPA never invents an empty state.
  `/terminal` without `app`/`project`: 404/redirect per legacy; do not invent a new empty state.
- Tests must cover: deep link + refresh; browser back/forward across app and session changes;
  rapid session switches (last wins, stale reads aborted); app switch (flush + remount + no leaked
  session); invalid session canonicalization; agent-stopped deep link preserves `?session=`; empty
  session list preserves `?session=`; no duplicate URL writer (assert one navigation per action).

### 4.9 Chrome, auth, shell, and focus

- SPA document and `/api/ui/*` remain cookie-only (`src/http/spa.ts:904-930`). Chat/terminal APIs
  keep their current `principalFrom` behavior; the SPA calls them with same-origin cookies.
- `fetchChrome(path, nextPath, hints)` carries the current path **and** the workspace `project`/`app`
  hints; chat/terminal responses include `chrome` like every other SPA page response
  (`src/http/spa.ts:933-1157`). `/api/ui/chrome` resolves hints as described in §4.3.
- `renderSpaDocument` forwards `pageClass`, `bodyClass`, and `viewport`. The chat/terminal
  `.page__body--*` class is applied to the server first-paint wrapper; after mount the route
  component owns the runtime `.page__body` root, and `useWorkspaceShell` mirrors only the `#main`
  page class and viewport on client navigation (§4.2).
- The SPA document loads only `app.js` (shell: drawer, theme, nav). `app-content.js` is not loaded on
  SPA documents (`src/http/ui.ts:316-319`); chat/terminal dialogs, menus, toasts, and busy states are
  Vue-owned. `ToastHost` remains the only toast owner on SPA pages
  (`ui/components/ToastHost.vue`, `docs/design/spa-migration.md` §6.9).
- The mobile drawer close is delegated/reapplied by `useChrome` (`ui/composables/useChrome.ts:36-48`),
  so a chat page's own sessions/context drawers do not fight the shell drawer. Chat's own drawer
  state lives on the chat shell (`data-chat-sessions`, `data-chat-context`), as today
  (`src/http/chat.ts:590`, `:13880-13912`).
- **`focusMain()` contract.** It always focuses `#main` with `preventScroll: true`, but resets a
  scroll container only when the destination route owns `.page`. For chat/terminal it skips the
  `.page` reset (the page is `overflow: hidden`) and leaves scroll restoration to the route
  component: chat uses `#chat-scroll`, terminal focuses its host after xterm connects. The composable
  receives the destination route metadata (`useChrome(router)` reads `to.meta.workspace` or the
  route id), so a normal route still resets `.page` exactly as today. Tests cover both branches.

### 4.10 Safe Markdown, tables, diffs, highlighting

- `MarkdownBlock.vue` wraps `renderMarkdown(container, text)` exactly like `SafeMarkdown.vue`
  (`ui/components/SafeMarkdown.vue:9-30`): `replaceChildren()` then render, never `v-html`. During
  streaming, rerender at most every 50 ms (`MARKDOWN_THROTTLE_MS`, `assets/chat.js:106`) and once on
  seal/idle. This preserves the current budget without porting the DOM patcher first.
- `ToolPart.vue` calls `extractToolView` (`assets/chat-diff.js:1396`) and mounts the specialized view
  into a container; `DiffView.vue` uses `mountToolView`/`setToolViewOpen`/`resetHighlightController`
  (`assets/chat-highlight.js:961`, `:1047`). Removing a part calls `resetHighlightController({
  partID })`; leaving the route calls the dispose path below.
- **Highlight worker/timer ownership.** `chat-highlight.js` is stateful/DOM-adjacent: it owns a
  module worker (`worker`), `workerPromise`/`resolveWorker`, and `readyTimer`
  (`assets/chat-highlight.js:45-51`, `:614-649`). The module gains an additive
  `disposeHighlightController()` that increments the controller generation, cancels every context,
  calls the existing `terminateWorker()` (which terminates the module worker and clears
  `readyTimer`), clears jobs/stats, and marks the controller disposed. It must **explicitly reset
  module-level `stats.disabled = false`** (and leave `worker`/`workerPromise`/`resolveWorker` in
  their initial state): `disableHighlighting()` sets `stats.disabled` permanently, so one worker
  failure would otherwise disable highlighting for the rest of the SPA session even after a route
  leave/remount. It also resets the per-controller generation so stale worker callbacks cannot apply
  to the next mount. A later mount creates a fresh controller and may construct a new worker. This is
  the only route-level teardown owner; components never call `worker.terminate()` directly.
- `chat-highlight.js` keeps its worker/module URL and budgets. Vite can bundle it from `assets/`
  because `ui/` already imports `assets/markdown.js`; the plan verifies the built worker URL, the
  same-origin allowlist, and a Vite worker smoke that actually executes Prism in the built worker
  (not just constructs it).
- Tests assert that after mount/unmount and feed reset: the `Worker` constructor/terminate counts
  return to baseline, `readyTimer` is cleared (fake timers show no pending ready timeout), and no
  highlight job/context remains. A worker-failure test proves that `disposeHighlightController()`
  resets `stats.disabled` and that a fresh mount constructs a worker and highlights again; the same
  test seam covers worker counts in §6.6.
- Tables remain `parseMarkdownTable` (`assets/chat-core.js:2408-2470`), capped at 16 columns/200 rows.
- No raw XML/HTML from tools reaches the DOM: the diff/read views use structured fields and text
  nodes; terminal `.innerHTML` uses today (`assets/terminal.js:114`, `:406`) must be replaced by Vue
  template/`createElement` nodes.

### 4.11 Lifecycle and teardown (no duplicate DOM/listeners)

Every long-lived resource is created by exactly one owner and disposed by that owner:

| Resource | Owner | Teardown |
| --- | --- | --- |
| EventSource | `useChatStream` | `dispose()` on unmount/app change |
| WebSocket | `useTerminalSocket` | `dispose()` on unmount |
| Runtime/context/image/preview timers | ChatPage/composables | clear on unmount and hidden |
| Draft save/keepalive/pending timers | `useChatComposer` | flush + clear on unmount |
| Highlight worker + `readyTimer` | `chat-highlight` controller | `disposeHighlightController()` on route unmount, including `stats.disabled = false` and generation reset; per-part reset on view removal |
| `ResizeObserver`/`MutationObserver`/`visualViewport` | TerminalView | disconnect/remove on unmount |
| Pending `document.fonts.ready` fit | TerminalView | disposed guard; no fit after unmount |
| Document keydown/visibility/pagehide/pageshow/listeners | composables | `AbortController` signal or tracked `removeEventListener` |
| Drag/drop/paste listeners | Composer | bound to component root; removed with it |
| `<dialog>` focus trap | shared SPA dialog composable | restore focus |
| Topbar content | App-level `TopbarActions` | never route-unmounted; route state reset renders default |
| URL (`app`/`project`/`session`) | Vue Router | single writer; no store/component writes |
| Queue-promotion suppression + image intent (sessionStorage) | `ui/chat/session-storage.ts` | namespaced by app/project/session; cleared on session delete and route leave |

Design rules:
- No component calls `document.querySelector("#chat-...")` for its own elements; use template refs.
  Querying the document is allowed only for the shell (`#main`, `#sidebar-nav`, `#breadcrumb-host`,
  `.topbar__actions`, `#toast-region`) through the existing composables.
- A route-level `:key="appKey + ':' + projectId"` forces a clean remount on app switch.
- `onBeforeUnmount` flushes the draft and disposes the stream/socket/controller before the DOM
  disappears.
- `pagehide` (persisted) flushes the draft and closes the stream/socket; `pageshow` reconnects once
  when visible; `beforeunload` closes the stream and clears context timers. bfcache restore must not
  create a second source/socket: the composable tracks a `persisted` generation and reconnects only
  if the previous owner was disposed.
- Queue-promotion suppression and image intent live in one `sessionStorage` owner, not in random
  components. They are keyed by app/project/session so an app switch cannot suppress or re-show a
  promotion from another workspace; the owner is reset on successful send, session delete, and
  unmount.
- E2E asserts one `#chat-shell`, one `#chat-scroll`, one `#terminal-host`, one live region per
  surface, no growth in fixture-side open SSE/WS connections after navigation, and no worker/timer
  growth after unmount.

### 4.12 Loading, empty, error, and deletion-pending states

- Chat page: boot renders a skeleton; sessions rail shows skeleton until the first read; thread
  shows skeleton; `agent_stopped` shows the persisted notices plus a Start shell (legacy behavior,
  `docs/current-state.md:590-595`); stream errors show the paused notice with Retry/Refresh history;
  unknown app/no apps is handled before SPA render; deletion-pending disables start/chat and shows
  the deletion banner.
- Terminal page: runtime preflight states (`starting`, `running`, `stopped`, `error`), connecting,
  live, reconnecting with countdown, paused, exited, closed, failed, and "Terminal engine
  unavailable". The stopped state links to chat (`assets/terminal.js:403-425`).
- **Until Stage 9**, both routes keep a `?legacy=1` link in their error/fallback states. The link
  preserves the other query parameters (`app`, `project`, `session`, and any future route state), so
  a fallback opens the same workspace rather than the first operator application. The server still
  strips `legacy` before rendering, matching `SmartLink`/`spa-migration.md` §6.8. **After Stage 9**
  the classic page no longer exists: every `?legacy=1` fallback link in chat/terminal (and the
  generic `renderSpaDocument`/`ui/main.ts` fallbacks) is removed or replaced with Reload/Back, and a
  stale `?legacy=1` request on a retired route is ignored and serves the SPA (§4.13).

### 4.13 Rollback

**Until the Stage 8 operator gate (runtime rollback is live):**
- Emergency: `HANSE_UI_LEGACY=1` (restart) serves the legacy document for every route.
- Single request: `?legacy=1`; `maybeServeSpa` returns `undefined` and the existing legacy
  `handleChat` / `handler.route` serve the page (`src/http/spa.ts:817-819`).
- Per-route: remove `chat`/`terminal` from `HANSE_UI_SPA_ROUTES` (restart). Because the allowlist is
  a replacement set, not an additive one, this must list every route that should remain SPA; any
  omitted route also falls back to legacy. This works only until Stage 9, while the legacy branches
  exist.
- The legacy renderer and scripts stay frozen and reachable until the operator gate.

**After Stage 8 sign-off and Stage 9 cleanup (runtime rollback is retired for chat/terminal):**
- The route definitions for `chat`/`terminal` set `legacyRetired: true`. The exact server behavior
  changes in three places, so a retired flag can never fall into a deleted legacy branch:
  1. `isSpaRoute(id)` checks `legacyRetired` **before** `HANSE_UI_LEGACY` and the allowlist: unless
     the caller explicitly passes `manifestValid: false`, a retired route returns `true` even when
     `HANSE_UI_LEGACY=1`, when `?legacy=1` is present, or when `HANSE_UI_SPA_ROUTES` omits it.
     `maybeServeSpa` still loads the manifest separately and handles its absence as the explicit
     `503` in point 3, so a missing build never reaches a legacy branch.
  2. `maybeServeSpa` applies the `?legacy=1` early return only to non-retired routes:
     `if (request.query?.legacy === "1" && !isLegacyRetired(match.id)) return undefined;`.
     For a retired route it ignores the query and proceeds to the SPA document.
  3. `maybeServeSpa` never returns `undefined` for a retired route when no SPA can be rendered. If
     `devUrl === undefined && manifest === undefined` it returns a `503` `text/html` "UI build
     missing" page instead of falling through to the deleted legacy handler/JSON 404. With
     `HANSE_UI_DEV_URL` set, the normal dev document is served. The deploy check below makes the
     missing-build state a failed deploy, not a silent fallback.
  Consequence: `?legacy=1`, `HANSE_UI_LEGACY=1`, and allowlist removal all still produce a `200`
  SPA document (or the explicit `503`), never the JSON/terminal `404` that a deleted page branch
  would leave behind. The allowlist can no longer pin a retired route to legacy.
- The page-entry semantics that used to live in the deleted `GET /chat`/`GET /terminal` branches are
  implemented inside `maybeServeSpa` **before the manifest/503 branch** (so they also work when the
  UI build is absent): `/chat` without `app` still `302`s to the first operator application; zero
  applications render the retained **static shell-only** no-apps entry page (`renderNoApps` with
  `contentScript:false`, no `app-content.js`, no chat client); an unknown app/project returns the
  styled 404 (`renderNotFound` with `contentScript:false`, no `app-content.js`); `/terminal` with a
  missing/unknown app returns that 404. These are entry/error pages, explicitly exempt from S1/S9,
  not a legacy chat/terminal route implementation.
- The only rollback is an **image rollback** to the last image that still contains the legacy pages
  (or to a version before chat/terminal cutover).
- **Mandatory pre-deploy check:** the image must have been built with `npm run build` (including
  `build:ui`) and the deployed image must serve the SPA document and its `assets/ui/*` entry. A
  checkout/image without a UI build is not deployable after cleanup (S12 no longer exempts these
  routes). The deploy runbook checks `/chat` and `/terminal` first load plus one client navigation
  before declaring the deploy healthy; failure requires an immediate image rollback.
- Chat/terminal-specific `?legacy=1` links are removed from their error states and the terminal
  engine-unavailable state; `NotImplementedPage`'s classic-interface link is replaced with a normal
  SPA destination. `renderSpaDocument` gains a route-aware `legacyAvailable`/`fallbackHref` input:
  for a retired route the server emits a Reload link, not `?legacy=1`; `ui/main.ts` uses the same
  boot flag. The shared fallback stays for non-retired routes. A user-supplied `?legacy=1` is
  silently ignored on retired routes as above.
- Rollback drills after cleanup exercise the image rollback + UI-build check, not the retired flags.

**Retired-flag matrix (server test, both `/chat` and `/terminal`).** Each row asserts the response
is `200` SPA (not the legacy document, not the JSON/terminal 404) after Stage 9; the missing-build
row is `503`, except with `HANSE_UI_DEV_URL` set (dev SPA).

| `HANSE_UI_LEGACY` | `?legacy=1` | `HANSE_UI_SPA_ROUTES` | Expected |
| --- | --- | --- | --- |
| unset | absent | unset | 200 SPA |
| `1` | absent | unset | 200 SPA |
| unset | `1` | unset | 200 SPA |
| `1` | `1` | `projects` (omits route) | 200 SPA |
| unset | absent | `""` (empty) | 200 SPA |
| any | any | any | 503 HTML if `devUrl` is unset and the UI manifest is missing |
| any | any | any, with `HANSE_UI_DEV_URL` set | 200 dev SPA (no manifest required) |

The matrix also runs with `manifestValid: false` directly against `isSpaRoute`/`maybeServeSpa` to
prove the `503` branch and that no request reaches the deleted `handleChat`/`handler.route` page
branch.

**Entry/error matrix (server test, both routes, independent of rollback flags).** These responses
are static shell-only pages, not SPA workspace documents and not legacy chat/terminal clients:

| Request | Expected after Stage 9 |
| --- | --- |
| `/chat` with no `app` | `302` to the first operator application |
| `/chat` with zero applications | `200` static no-apps entry page, no `app-content.js`, no chat client |
| `/chat` with unknown `app` | styled `404`, shell-only (`renderNotFound` with `contentScript:false`, no `app-content.js`) |
| `/terminal` with missing/unknown `app`/`project` | styled `404`, shell-only (`contentScript:false`) |

Run every entry/error row under the same `HANSE_UI_LEGACY`/`?legacy=1`/`HANSE_UI_SPA_ROUTES`
combinations as the retired-flag matrix; a retired route must still reach these static pages, not a
deleted legacy branch. These pages are not counted as a legacy route implementation (S1/S9).

---

## 5. Migration stages and exit gates

Order: **terminal first**, then chat in vertical slices. Terminal is small (717 lines), isolated
(WebSocket only), and proves the workspace shell, route props, page classes, vendor loader, and
rollback before the 14k-line chat client is touched. Chat is last because it has the most behavior
and the least isolation.

No route flag flips in Stage 0/1. A test-only/internal allowlist is used until each registry flag is
turned on: it must contain the full default SPA set plus the route under test (`HANSE_UI_SPA_ROUTES`
is a replacement set, so a bare `=chat`/`=terminal` is forbidden). The E2E config exposes
`SPA_E2E_ROUTE_IDS` for that purpose; it is not a production default, and any temporary scaffold
used behind it is removed before the route's default cutover.

### Stage 0 - Baseline and deterministic workspace harness

Scope:
- Record baseline `npm run lint`, `typecheck`, `test`, `build`, `check:sensitive`, and current
  `/chat`/`/terminal` browser evidence (including skeleton/CLS measurements) outside tracked docs.
- Extend the E2E fixture (`e2e/support/server.ts:152-176`) with a deterministic fake opencode
  endpoint and runner WS upstream: synthetic sessions/messages, scripted SSE frames
  (`stream.ready`, text deltas, tool part, `session.status`, `question.asked`, `permission.asked`,
  `stream.warning`, `notice.created`, `context.updated`), terminal echo/resize/exit behavior.
- Reuse `docs/design/chat-qa.mjs` as the deterministic browser harness; extend it for the new SPA
  routes instead of adding a second chat fixture.
- Add characterization tests for current chat/terminal page HTML (existing `test/chat-page.test.ts`,
  `test/terminal-http.test.ts`) and for each pure/stateful shared module, split per slice.
- Produce the **function/event-to-slice inventory** (§4.5): every `HanseEvent`, every `PartType`,
  `handleStreamEvent`, hydration buffering, DOM/state helpers, and their target slice/sub-gate.
- Add a fixture API/WS contract test proving the real `createHttpServer` SSE/WS paths work against
  the fake upstream.
- Add the Vite worker smoke that builds the UI and executes Prism inside the built
  `chat-highlight-worker.js` (not only a module-construction check).

Exit gate: baseline green; fake upstream can drive a legacy chat/terminal page in E2E; the
event/function inventory is complete; no route or code behavior change.

Tests: existing server/contract tests; new fixture contract tests; per-slice characterization;
legacy E2E chat/terminal smoke; built-worker smoke.
Rollback: none (no cutover). Legacy retention: unchanged.

### Stage 1 - Workspace shell, routes, props (no cutover)

Scope:
- Add `chat`/`terminal` route ids and `spa:false` entries; update `matchPage`,
  `test/shared-routes.test.ts`, and the route table test. Add the `legacyRetired?: boolean` field
  (false here) and the `meta.workspace` type augmentation.
- Add `src/http/props/chat.ts`, `src/http/props/terminal.ts`, `/api/ui/chat`, `/api/ui/terminal`,
  cookie-only auth, chrome hints, guarded `recordOperatorHost` on direct load, and boot/document
  shell options (`pageClass`, `bodyClass`, viewport, `topbarActions`).
- Add the client route-set path: `renderSpaDocument` boot `spaRoutes`, `ui/boot.ts` validation,
  `ui/spa-routes.ts` (or equivalent) installed by `ui/main.ts`, `isSpaPathIn`/`SmartLink`
  parameterization, and the `router.beforeEach` full-document-load guard. No chat/terminal route
  record/component yet; do **not** enable either id through `HANSE_UI_SPA_ROUTES` in Stage 1. The
  route-table test starts enforcing records once each component lands (Stage 2 terminal, Stage 3B
  chat).
- Add `useWorkspaceShell`, App-level persistent `TopbarActions`, `focusMain` workspace branch, and
  `fetchChrome` hint plumbing; no chat/terminal route component yet.
- Keep both routes legacy (`spa:false`); verify the new props endpoints only in tests.

Exit gate: route table tests reflect the new ids; `/api/ui/*` auth/secret tests pass; boot
`spaRoutes` round-trips and unknown ids fail closed; `SmartLink` uses the boot set (not process
env); the guard full-document-loads a path outside the set instead of rendering it; legacy
`/chat`/`/terminal` HTML is byte-for-byte unchanged (the topbar/body class is client-only and does
not alter `appShell`); shell tests cover bodyClass forwarding, topbar persistence/default restore,
focusMain's chat/terminal skip, and chrome hints; no SPA serve while flags are false.

Tests: route manifest, boot route-set/guard/SmartLink, props/auth/secret, guarded operator-host
recording, shell document snapshots, shell component tests, legacy page tests unchanged.
Rollback: flags false. Legacy retention: full.

### Stage 2 - Terminal full Vue port and cutover

Scope:
- Implement `TerminalPage.vue`, `TerminalView.vue`, toolbar/banner/stopped state, vendor loader,
  `useTerminalSocket`.
- Register the `terminal` router record with `meta.workspace: "terminal"` and the lazy
  `TerminalPage.vue`; add the server topbar fallback.
- Use the `TerminalView` on-demand loader as the sole owner of xterm scripts **and** CSS; extend
  `renderSpaDocument` only for `pageClass`/`bodyClass`/viewport/`topbarActions`, not for the vendor
  stylesheet.
- Add terminal props/boot and auth-expiry probe.

Exit gate (all required):
- Parity: connecting/live/reconnecting/countdown/paused/stopped/exited/closed/failed; copy,
  reconnect, close; resize after window/visualViewport/ResizeObserver/fonts; theme change; reduced
  motion; runtime preflight; 401/403/404/503/502; normal exit 1000/1001; failure 1011; app stopped.
- No duplicate sockets on reconnect; one `#terminal-host`; xterm and observers disposed on leave;
  one vendor CSS `<link>` after first load and after client navigation; no server duplicate.
- Auth expiry: failed upgrade + cookie probe 401 -> `/login?next=`, bounded retries, no loop.
- Router: direct SPA load renders `TerminalPage` (not `NotImplementedPage`); client navigation from
  another SPA route works; `router.push({ name: "terminal" })` resolves; a path outside the boot
  `spaRoutes` set or `?legacy=1` full-document-loads. Pre-cutover check (before the flag flips):
  with `spa:false` and no allowlist entry no terminal component renders; after cutover it is SPA by
  default.
- E2E SPA + legacy terminal spec; visual QA at 390/768/1024/1440 dark/light; skeleton/CLS measured;
  first-paint topbar is the default IDE action with no flash.
- Rollback: `?legacy=1`, `HANSE_UI_LEGACY=1`, remove `terminal` from `HANSE_UI_SPA_ROUTES` (until
  Stage 9).
- Operator can still open the legacy terminal as the rollback document.

Tests: component socket mock (retry/generation/close/resize/dispose/auth probe, exactly five bounded
attempts), terminal-http contract unchanged, loader/CSS-owner test, router/boot-set/direct-load/
full-load/no-SPA tests, E2E terminal, visual QA, console/page-error zero.
Legacy retention: `renderTerminalPage`, `assets/terminal.js`, vendor assets, handler branch.

### Stage 3 - Chat data foundation and read-only workspace

Split into three independently verifiable sub-gates; each lands green before the next.

#### Stage 3A - Event reducer, stores, feed extraction

Scope:
- Create `ui/chat/event-reducer.ts`, `ui/chat/state-actions.ts`, and the new plain-ESM
  `assets/chat-feed-store.js` plus its typed `ui/chat/feed-store.ts` wrapper. **Copy** the
  `createThreadStore` shape out of `assets/chat.js:548`; do not move it, edit `chat.js`, or import
  from `chat.js`. `applySnapshot`, `deriveQueue`, `rekeyOptimistic`, and `mergeFeedOrder` keep their
  current semantics and modules.
- Implement `chatFeed`/`chatContext`/`chatSession` stores and the event-to-slice map from §4.5.
- Add the source-of-truth/drift tests: frozen-block baseline for `assets/chat.js`, characterization
  fixtures for the copied store, and a test that the copy has no `ui/` or legacy-client import.

Exit gate: reducer unit tests cover every `HanseEvent` and `PartType`; characterization tests prove
the copied feed store and the reducer produce the same feed/queue/status as the recorded legacy
fixtures for the same scripted frames; the `chat.js` freeze test is green; no DOM or network in the
reducer. Editing `assets/chat.js` in this stage is a failure, not an implementation detail.

#### Stage 3B - Stream, route, and read-only shell

Scope:
- Implement `ChatPage.vue` shell, `ChatSessionsRail`, `ChatThread`, basic text/tool/OMO rendering,
  `useChatStream`, `/api/ui/chat` boot/props, and `useChatRouteState`.
- Register the `chat` router record with `meta.workspace: "chat"` and the lazy `ChatPage.vue`; add
  the chat server topbar fallback (counters `0`, chips hidden).
- Read-only: no send/composer mutation yet (or a disabled composer shell), but sessions, history,
  live stream, status, notices, and empty/stopped/error states work.
- Enable for E2E with `HANSE_UI_SPA_ROUTES=${SPA_E2E_ROUTE_IDS},chat` (full default set plus chat;
  a bare `=chat` would disable every other SPA route); registry flag stays `false`.

Exit gate:
- 30-message tail + older pages, prepend anchor, no duplicate messages, `stream.ready`/seq/gap
  resync, reconnect after visibility/online, hidden `onerror` without client failure increment/probe
  (native reconnect allowed), auth expiry probe, agent_stopped shell, unknown app/no-app fallbacks.
- URL single-owner tests: deep link, back/forward, rapid session switch last-wins, invalid session
  canonicalization, agent-stopped and empty-session `?session=` preservation, one URL write per
  action.
- No duplicate EventSource after 20 route enter/leave cycles; fixture-side stream count returns to
  baseline.
- Router/boot: direct SPA load renders `ChatPage` (not `NotImplementedPage`); client navigation from
  another SPA route works; `router.push({ name: "chat" })` resolves; a path outside the boot
  `spaRoutes` set or `?legacy=1` full-document-loads; with the flag false and no allowlist entry no
  chat component renders.
- E2E SPA chat read-only vs legacy read-only; visual QA shell/rail/thread; first-paint topbar is the
  chat control set with zeroed counters and no default-IDE flash.

#### Stage 3C - Session tree, history paging, and read-only parity

Scope:
- `buildSessionTree`/ancestor expansion, session search/new/delete, full history paging, scroll
  owner, and the read-only state matrix.

Exit gate: session tree/orphan/cycle handling, delete cleanup, paging without duplicates, scroll
anchor/follow-bottom, and the read-only visual/behavior parity report. Stage 3 is complete only
after 3A/3B/3C all pass.

Tests: reducer per event/part, feed store merge, stream adapter seq/gap/dispose/auth, history paging,
URL/back-forward/session-switch/app-switch, component/JSdom, E2E read-only, fixture stream-count.
Rollback: route flag still false; remove allowlist. Legacy retention: full.

### Stage 4 - Chat composer, drafts, send, queue, abort

Split into three independently verifiable sub-gates.

#### Stage 4A - Composer and drafts

Scope: `ChatComposer`, draft save/keepalive/delete-if-empty, resize, keyboard, attachment shell.

Exit gate: draft restore on switch/hide/unmount, keepalive, delete-if-empty, no cross-session draft
leak, focus/keyboard parity.

#### Stage 4B - Send and delivery

Scope: send/stop, optimistic rows, `202`/blocking delivery, `unknown` grace, retry/remove, pending
sends, `sending/accepted/queued/unknown/failed`.

Exit gate: optimistic send, accepted, blocking fallback, unknown + Check again/Remove, retry after
reload, no duplicate send after remount; auth expiry mid-send.

#### Stage 4C - Queue and abort

Scope: queue strip/dialog, upstream queue derivation, Stop/abort, intentional-abort suppression.

Exit gate: queue rows match `deriveQueue`, queue promotion suppression owner, Stop settles idle,
intentional abort is not shown as an error, last-wins under rapid send/stop.

Test split: 4A composer/draft unit + E2E; 4B delivery/pending unit + E2E send; 4C queue/abort unit +
E2E queue/stop. Rollback unchanged; legacy retention full.

### Stage 5 - Chat feed rendering parity

Split into three independently verifiable sub-gates.

#### Stage 5A - Text, reasoning, tools, notices, OMO, handoff

Scope: Markdown + tables, reasoning, tool output streaming, notices, OMO/handoff cards, image
gate/warning, generation row, message count.

Exit gate: deterministic fixture parity for streaming text, tool, bash tail, table, OMO, handoff,
notice, empty/oversized/truncated; Markdown clear/no duplicate nodes and 50 ms throttle.

#### Stage 5B - Diffs and highlighting

Scope: read/write/edit/apply_patch views, `chat-diff` caps, Prism worker, plain fallback,
`disposeHighlightController`.

Exit gate: diff caps (64 KiB/file, 128 KiB total, 50 files, 2,000 lines), highlight budgets/plain
fallback, no raw XML, worker/timer counts return to baseline after unmount, built-worker smoke.

#### Stage 5C - Scroll and performance

Scope: long-thread scroll, prepend anchor, new-messages button, pinned bottom, rAF flush, memory.

Exit gate: no full feed replacement per token; anchor preserved; 500-message/50-file perf trace and
memory recorded; E2E scroll scenarios; visual QA 390/1440 dark/light; no console errors.

Tests are per sub-gate: 5A MarkdownBlock/feed render; 5B diff/highlight/worker teardown; 5C scroll
store/E2E/perf trace.

### Stage 6 - Prompts, questions, permissions, SSH approvals, context rail

Split into two independently verifiable sub-gates.

#### Stage 6A - Questions, permissions, saved permissions

Scope: prompt dock + inline question cards, answer/reject/expiry, permissions allow once/always/deny,
saved permissions, correlation/outcome/tombstones, needs-input topbar count.

Exit gate: question auto-advance/custom/cancel/expiry, permission risk/scope/always/deny/saved
revoke, focus moves to dock/composer correctly, Ctrl/Cmd+Enter, no focus loss after answer, topbar
count owned by App-level `TopbarActions`.

#### Stage 6B - SSH approvals, context, plan, previews, restart, policy

Scope: SSH approval polling/cards, context meter/compact, plan/todo, handoffs rail, previews,
restart pending, policy warnings.

Exit gate: SSH approve/reject, context meter/compact confirm and `202`, plan panel, previews
open/close, restart pending, policy chip (`assets/chat.js:14257-14334`); E2E question/permission/
context/preview/restart; visual QA.

### Stage 7 - Attachments, slash commands, full parity, chat cutover

Split into three independently verifiable sub-gates; Stage 7 is not the only parity safety net
(Stages 3-6 each carry their own characterization/parity gate). Attachments and commands are
separate because they fail differently: attachments are upload/transport/quota state, while
commands are catalog/filter/confirmation state.

#### Stage 7A - Attachments

Scope: attachment upload (XHR progress/abort), drag/drop/paste, chips, mode, quota, inline/file
rendering, redelivery.

Exit gate: 10 files/100 MiB, two concurrent uploads, progress/cancel/retry, inline image/video/PDF,
file-only, quota warning, send payload, drop/paste paths, redelivery after reload; no orphan upload
or object URL after unmount.

#### Stage 7B - Slash commands and remaining context/app menu

Scope: slash command palette/filtering/confirmation; the remaining context/app menu surface not
already ported in Stage 6.

Exit gate: command catalog/filtering/slash detection/shell `present`/`unknown` confirmation/
Hanse-only degradation when stopped/`202`/error handling; context/app menu parity and keyboard/focus
paths.

#### Stage 7C - Full parity audit and cutover

Scope: full event/part/behavior audit and flip `chat` to `spa:true`.

Exit gate (cutover gate, all required):
- **Every `HanseEvent`** is ported and tested against the §4.5 map: `stream.ready`,
  `question.asked`, `question.replied`, `question.rejected`, `permission.asked`,
  `permission.replied`, `todo.updated`, `message.updated`, `message.part.updated`,
  `message.part.delta`, `message.part.omitted`, `session.status`, `session.error`,
  `session.compacted`, `notice.created`, `context.updated`, `session.activity`, `stream.warning`.
- **Every `PartType`** is ported and tested: `text`, `reasoning`, `tool`, `step-start`,
  `step-finish`, `patch`, `file`, `subtask`, `retry`, `compaction`, `snapshot`, `agent`, plus the
  unknown-type reconcile path.
- Every behavior in §2 and §7 has a component/unit/E2E or manual parity check.
- No duplicate DOM/listeners/sockets/workers/timers after 20 enter/leave and app/session switches.
- Back/forward/deep-link/refresh/auth-expiry/logout; mobile drawers; 390/768/1024/1440 dark/light.
- Chat route chunk measured; entry budget unchanged; no eager Prism/xterm; skeleton/CLS measured
  and no worse than legacy beyond the recorded threshold.
- Operator can still use legacy runtime rollback **until Stage 8 sign-off**.

**Freeze/porting policy.** At each cutover the legacy renderer and page script become frozen: no new
behavior is added there, and post-gate fixes land in Vue only. Until cleanup, the legacy page remains
the rollback document and keeps one smoke/E2E test. No port is "done" on the strength of Stage 7
alone: the Stage 3-6 sub-gates and characterization tests are the evidence.

Rollback: remove `chat` from allowlist, `?legacy=1`, `HANSE_UI_LEGACY=1` (until Stage 8/9). Legacy
retention: `renderChatPage`, `assets/chat.js`, all helpers, `handleChat` page branch until cleanup.

### Stage 8 - Operator verification gate (no cleanup)

The operator verifies the full chat/terminal surface **on the deployment host after deploy**, using
the checklist in §10. A deterministic local fixture may support development, but it does not replace
the operator's deployment-host sign-off. The gate is explicit sign-off, not a soak. Until sign-off:

- both routes stay SPA by default;
- legacy renderers/scripts stay frozen and reachable;
- runtime rollback (`HANSE_UI_LEGACY=1`, `?legacy=1`, allowlist removal) remains live;
- no cleanup commit.

### Stage 9 - Legacy cleanup (only after Stage 8 sign-off and an explicit owner instruction)

Remove only the legacy page implementation, not the contracts:

- `renderChatPage` and the `GET /chat` branch in `src/http/chat.ts` (keep all `/api/apps/*` handlers,
  `handleStart`, attachment upload/download, SSE). Name and delete the chat-only render helpers that
  exist only for the legacy document: `renderContextHandoffs`, `appOptions`, `renderPreviewRows`,
  `renderPreviewSection`, and any other chat-page-only helper found by the Stage 9 inventory.
  `renderNoApps` is **retained** as the minimal zero-application entry page used by
  `maybeServeSpa`, configured as a static shell-only page (`contentScript:false`; no
  `app-content.js`, no chat client). `renderNotFound` gains `contentScript?: boolean` and is retained
  as the shared styled 404; the chat/terminal entry/error path passes `contentScript:false`, while
  existing non-chat callers keep the default. Neither is a legacy chat/terminal route implementation.
- `renderTerminalPage` and the `GET /terminal` branch in `src/http/handler.ts`; keep
  `proxyTerminalUpgrade` and the upgrade dispatch. Name and delete terminal-page-only helpers
  (currently `renderTerminalPage`; any helper extracted for it in Stage 2 is added to the inventory).
- `assets/chat.js`, `assets/terminal.js`, and any legacy-only asset allowlist entries;
- legacy-only HTML-string tests (including the chat/terminal page HTML tests retained through Stage
  8 per the S13 amendment);
- legacy-only CSS selectors if nothing else uses them (verify first).

Set `legacyRetired: true` on both route definitions and implement the §4.13 behavior in
`isSpaRoute`/`maybeServeSpa`; implement the `/chat` redirect/no-apps/404 and terminal 404 entry
semantics inside `maybeServeSpa`. Remove or replace every `?legacy=1` fallback link, and add the retired-flag
matrix test from §4.13. `HANSE_UI_LEGACY`/allowlist machinery may remain for any still-legacy route
(only `/login` remains outside the SPA), but it must no longer affect chat/terminal.

Keep all six shared modules at their current paths: `assets/markdown.js`, `assets/chat-core.js`,
`assets/chat-commands.js`, `assets/chat-diff.js`, `assets/chat-highlight.js`,
`assets/chat-highlight-worker.js`. They are not an owner decision anymore (Q3 closed); cleanup must
not move or delete them. Keep the additive `assets/chat-feed-store.js`: it becomes the sole feed
store after `chat.js` is deleted.

After cleanup, retire the chat/terminal runtime rollback paths as well: `HANSE_UI_LEGACY=1`,
`?legacy=1`, and `HANSE_UI_SPA_ROUTES` removal no longer promise a legacy chat/terminal page. Delete
the dead legacy branch/allowlist expectations and update the runbook to the image-rollback procedure
in §4.13, including the mandatory UI-build/deploy check. Post-cleanup readiness is a checklist item:
the image builds the UI, the SPA document and chunks are present, `/chat` and `/terminal` first load
and client navigation work, the retired-flag matrix returns SPA/503 (never the deleted-page 404),
and an older image is available for rollback.

### Stage order summary

| Stage | Surface | Cutover | Primary risk |
| --- | --- | --- | --- |
| 0 | Harness + event inventory | none | fixture realism |
| 1 | Shell/routes/props | none | shell drift |
| 2 | Terminal | `terminal` | xterm/vendor/WS lifecycle |
| 3A/3B/3C | Chat reducer/stream/read-only | internal allowlist | SSE/state extraction |
| 4A/4B/4C | Composer/send/queue | internal | send/queue/races |
| 5A/5B/5C | Feed render | internal | Markdown/diff/perf |
| 6A/6B | Prompts/context | internal | focus/question races |
| 7A | Attachments | internal | upload/quota/orphan state |
| 7B | Commands/context menu | internal | catalog/filter/confirmation |
| 7C | Full parity + `chat` cutover | `chat` | full parity |
| 8 | Operator verification (deployed) | - | missed behavior |
| 9 | Cleanup + rollback retirement | - | deleting too early |

---

## 6. Testing strategy

### 6.1 Unit and component

- `chat-core`/`chat-diff`/`chat-commands`/`markdown` tests stay as the shared-contract layer and are
  not rewritten.
- Feed/reducer: snapshot tail/older/replace, optimistic merge, rekey, queue derivation, session tree,
  omission warnings, stream sequence/gap; every `HanseEvent` and `PartType`; legacy-vs-new
  characterization for the same scripted frames.
- Stream adapter: fake `EventSource`; open/message/error/reconnect/pause/limit; `stream.ready` resets
  on every ready; hidden `onerror` does not increment the client counter, probe, or schedule an
  app-level retry (native reconnect allowed); auth probe 401/403 -> login once, 200 -> paused; no
  infinite retry; dispose closes and removes handlers; no duplicate sources.
- Terminal socket: fake `WebSocket`; generation, retry delays/countdown, manual close, 1000/1001,
  1011, runtime stopped, resize JSON, auth probe, bounded retries, dispose.
- Components: composer/draft/pending, prompt dock/question/permission, queue strip/dialog, context
  rail, markdown block clear/throttle, tool/diff/highlight mount/unmount, terminal stopped state.
- Shell: `useWorkspaceShell` restores main/body classes and viewport; App-level `TopbarActions`
  persists across route changes and restores the default; `fetchChrome` forwards workspace hints;
  `focusMain` skips `.page` for chat/terminal and resets it for normal routes; boot `spaRoutes`
  validation/unknown-id failure; `SmartLink` uses the boot set; the router guard full-document-loads
  an off-set/`?legacy=1` destination; chat/terminal server topbar fallback has zeroed counters and
  no default-IDE flash.
- Chat feed store: the new `assets/chat-feed-store.js` copy preserves the legacy `createThreadStore`
  shape; the `assets/chat.js` freeze test is green; characterization fixtures match legacy recorded
  feed/queue/status.

### 6.2 SSE/WS contract

- Reuse `test/app-events.test.ts`, `test/context-http.test.ts`, `test/terminal-http.test.ts`, and
  add:
  - `stream.ready` `seq:0` + `streamID`, monotonic seq, heartbeat comments, cleanup on close,
    `429 stream_limit`, human-only `403`, `401`, agent-stopped `503`, deletion-pending `409`;
  - terminal upgrade cookie 401/403, project 400, unknown app 404, runner missing 503, upstream 502,
    binary/JSON frames, resize forwarding, close propagation.
- The client adapters are tested against the same fixture frames, so server and client cannot drift.

### 6.3 E2E

Use the deterministic fixture coordinator plus fake opencode/runner upstream. Run each spec in both
`legacy` and `spa` modes (`playwright.config.ts` already has mode projects). The SPA project uses
the full default set plus only the route whose record exists: Stage 2/3A
`HANSE_UI_SPA_ROUTES=${SPA_E2E_ROUTE_IDS},terminal`; Stage 3B onward
`${SPA_E2E_ROUTE_IDS},chat,terminal`. A bare `=chat,terminal` is forbidden because it replaces the
whole set and would break this suite; do not add `chat` before the Stage 3B record exists. Minimum
chat specs:

- client route set: direct load renders `ChatPage`/`TerminalPage` (not `NotImplementedPage`); client
  navigation from another SPA route; `router.push({ name })`; boot `spaRoutes` matches the server
  allowlist; a route outside the set or `?legacy=1` full-document-loads; with flags false and no
  allowlist entry no chat/terminal component renders; topbar first paint has no default-IDE flash;
- deep link with `app`/`project`/`session`, refresh, back/forward, app switch (flush + remount),
  rapid session switches (last wins), invalid-session canonicalization, agent-stopped/empty-session
  `?session=` preservation;
- sessions list/tree/search/new/delete; session switch while streaming;
- SSE streaming text, tool, bash tail, diff/write/read, table, OMO, handoff, notice;
- send/queue/stop, abort, delivery unknown/retry/remove, draft save/restore/delete-if-empty;
- questions/permissions/saved/SSH approval, context/compact, previews, restart;
- attachments upload/drop/paste/progress/cancel/retry/inline/file/quota;
- slash palette/filter/shell confirmation;
- reconnect: offline/online, visibility, bfcache/pagehide/pageshow, stream gap/warning, `429`
  pause/retry, auth expiry probe on stream and terminal failure;
- auth expiry mid-stream and mid-send → login with `next`;
- no duplicate DOM/listeners/workers/timers after route enter/leave and app/session switches;
- rollback `?legacy=1`, `HANSE_UI_LEGACY=1`, allowlist removal (until Stage 9).
- one Vite/build smoke that executes the built Prism worker, in addition to unit worker tests.

Terminal specs:
- direct SPA load and client navigation render `TerminalPage`; off-set/`?legacy=1` full-load; flag
  false/no allowlist renders no terminal component;
- deep link, runtime stopped/running/error, connect, input/output, resize, copy, reconnect (exactly
  five bounded attempts then manual), manual close, normal exit, 1011 failure, runner unavailable,
  auth expiry, teardown, rollback;
- one vendor CSS `<link>` after first load and after client navigation (no server duplicate);
- first-paint topbar is the default IDE action with no mount flash.

### 6.4 Visual QA

`visual-qa` checklist at 390/768/1024/1440 (plus the 1360 chat context breakpoint), dark/light:
chat sessions rail/thread/context, composer and composer focus with on-screen keyboard, queue strip,
prompt dock, diffs/tables, terminal toolbar/banner/host/stopped, empty/loading/error. Pixel parity
against the legacy document before each cutover; evidence outside tracked docs.

### 6.5 Performance and memory

- Preserve 50 ms Markdown / 100 ms tool output / rAF flush; no full feed replacement per token.
- Long session (500 messages), 50-file diff, 64 KiB write, 2,000-line diff, 120k highlight nodes:
  measure frame time and memory; ensure plain fallback and caps.
- 20 chat enter/leave cycles and 20 terminal reconnects: fixture-side SSE/WS counts return to
  baseline; no listener/timer/worker growth; no detached DOM nodes.
- Bundle: entry budget unchanged; chat/terminal are lazy chunks; Prism worker and xterm vendor load
  only when needed. Measure gzip and document the chat route budget in the plan.
- Skeleton/CLS: record first-paint skeleton and cumulative layout shift for chat (rail, thread,
  composer) and terminal (toolbar, host) at 390/1440, before and after cutover. No skeleton may
  shift the composer/terminal host beyond the recorded legacy threshold; a late stream hydration
  must not reflow the feed.

### 6.6 No duplicate DOM/listeners

Add a test seam that counts:
- `EventSource` and `WebSocket` constructions and active fixture connections;
- `document`/`window` listeners registered by chat/terminal composables (via injectable
  `addEventListener` wrappers or spy);
- `#chat-shell`, `#chat-scroll`, `#terminal-host`, live regions, and message nodes;
- highlight workers, `readyTimer`/retry timers, and pending `document.fonts.ready` fits;
- `.topbar__actions` owners (exactly one App-level component; no per-route copy).

Assert after mount/unmount/route-switch that counts return to baseline. E2E asserts one visible
surface, one topbar action set, and no duplicate messages after back/forward and app switch.

### 6.7 Auth expiry, reconnect, and rollback

- A `401` from any chat read/mutation redirects to `/login?next=` with the current path
  (`ui/api.ts:77-88`).
- SSE: `EventSource` cannot report 401/403. On the bounded pause, the adapter probes
  `GET /api/ui/chrome?path=/chat` once (5 s cooldown); 401/403 -> login with `next`, 200 -> paused
  with manual Retry. A hidden document neither increments the client failure counter nor probes nor
  schedules an app-level retry; native `EventSource` auto-reconnect may still occur. `stream.ready`
  resets failures and sequence on every frame. `429 stream_limit` probes once and pauses without
  looping.
- Terminal: a failed upgrade probes `GET /api/ui/chrome?path=/terminal`; 401/403 stops retries and
  redirects, 200 continues the bounded `[1,2,4,8,15]s` retries (exactly five, then manual
  Reconnect), then paused/manual. No infinite reconnect; this is the recorded C9 deviation from
  legacy's unlimited 15s retries.
- Tests: fake `EventSource`/`WebSocket` + fake timers assert exact call counts (three visible SSE
  failures, one limit probe, one auth probe; five terminal retries, one auth probe), no probe while
  hidden, and stale callbacks ignored after dispose.
- Every stage before cleanup runs its runtime rollback drill (`HANSE_UI_LEGACY=1`, `?legacy=1`,
  allowlist removal) and keeps one legacy smoke test per route. After cleanup the drill is the
  retired-flag matrix (§4.13) plus the image rollback + mandatory UI-build/deploy check
  (§4.13/§10); the old flags must return SPA/503, never the deleted-page 404.

---

## 7. Risks, bundle/perf, security, accessibility

### 7.1 Risks and mitigations

| Risk | Severity | Mitigation |
| --- | --- | --- |
| Chat behavior regression (14k lines, 121 listeners) | High | Option C vertical slices; event-to-slice inventory; characterization per slice; legacy rollback every stage; operator gate. |
| Duplicate SSE/WS/DOM after route switch | High | Single owner per resource; `:key` remount; dispose on unmount; fixture connection counts; 20-cycle E2E. |
| Feed scroll/anchor regression | High | Keep the existing scroll state model; test prepend/new-messages/pinned; visual/E2E scroll scenarios. |
| Markdown/tool/diff rendering perf | High | Throttles 50/100 ms, rAF, caps, worker budgets; no full feed replacement; perf trace; skeleton/CLS measurement. |
| Stream gap/reconnect drift | Medium | Reuse sequence logic; adapter contract tests; resync on new streamID/gap/warning. |
| Auth expiry not observable on SSE/WS | High | Bounded failure counters; cookie-only `/api/ui/chrome` probe; login redirect; no infinite retry; exact-call tests. |
| Prompt/question focus and expiry races | Medium | Keep server outcome mapping; component tests for 404/expired; focus restoration E2E. |
| Attachment upload/draft races | Medium | Reuse existing debounce/keepalive/delete-if-empty semantics; E2E switch/hide/unmount. |
| Shell/page-class/topbar drift | Medium | One `useWorkspaceShell`; one App-level persistent `TopbarActions`; server first paint; visual QA. |
| URL/router divergence | Medium | `route.query` is the only source; one watcher; user actions call router; back/forward/session/app-switch tests. |
| Client route set/allowlist divergence | High | Boot `spaRoutes` mirrors the server `isSpaRoute` result; `SmartLink` and the router guard use it; every boot-enabled id has a router record; off-set paths full-load; no-flag/no-allowlist tests. |
| Post-cleanup retired flags reach a deleted branch | High | `legacyRetired` precedence in `isSpaRoute`, `?legacy=1` guard, never `undefined` for retired routes, 503 HTML when the UI build is missing; retired-flag matrix test. |
| Feed-store copy drifts from frozen legacy | Medium | Copy-first extraction, no `chat.js` edit/import, frozen-block baseline, characterization fixtures, Stage 9 sole-owner promotion. |
| Topbar first paint flashes default IDE | Low | Server-rendered route fallback from stable props with zeroed counters; first-paint/CLS tests. |
| xterm vendor globals, CSS duplication, or worker URL break under Vite | Medium | One `TerminalView` loader owns scripts+CSS; built worker smoke; terminal route chunk test; rollback. |
| E2E fixture cannot drive chat/SSE deterministically | High | Stage 0 hard gate: fake opencode/runner upstream with scripted frames; no real Docker/opencode. |
| Legacy cleanup before verification | High | Stage 8 deployment-host operator gate; D1; no cleanup commit without sign-off. |
| Shared modules get deleted or moved with legacy | Medium | Q3 closed: all six stay at their current paths; cleanup checklist names them; the new feed-store copy is additive and no legacy client is edited before Stage 9. |
| Rollback promise stale after cleanup | Medium | §4.13 retires runtime flags for chat/terminal; image rollback + mandatory UI-build/deploy check. |

### 7.2 Bundle and performance

- The SPA entry (`ui/main.ts` + shell + router) must not grow materially; chat/terminal are lazy
  route chunks (`ui/router.ts:10-86` pattern).
- Chat chunk target (proposed, measured in Stage 0/7): ≤ 250 KiB gzip for chat route code including
  reused pure modules; Prism worker and its vendor bundle load only when a diff is opened; xterm
  vendor (~separate) loads only on terminal.
- Terminal chunk target: ≤ 60 KiB gzip plus the existing vendored xterm assets.
- No eager import of `assets/chat.js`/`terminal.js` in the SPA entry.
- Keep the existing measured entry budget and S16; document the actual chat/terminal transfer in the
  plan and current-state. Record skeleton/CLS at 390/1440 before and after cutover (§6.5).

### 7.3 Security

- No `v-html`; Markdown uses the `textContent` DOM builder (`assets/markdown.js:1-24`,
  `ui/components/SafeMarkdown.vue`). Terminal `innerHTML` uses today are replaced with Vue templates.
- No secrets in props, boot JSON, URLs, localStorage, or sessionStorage. The runner token stays in
  the server proxy (`src/http/terminal.ts:172-184`); the SSE URL carries only app/project.
- SPA document and `/api/ui/*` remain cookie-only with the existing bearer/agent-token rejection
  (`src/http/spa.ts:904-930`); chat APIs keep their current human-principal checks
  (`src/http/chat.ts:2471-2502`).
- Mutations keep same-origin/SameSite protections; chat cross-site mutation guard unchanged
  (`assets/chat.js:829`, `src/http/chat.ts:2475-2477`).
- Attachments stay same-origin; preview risk is unchanged (same-origin demo risk already accepted).
- The vendor loader injects same-origin allowlisted scripts; no `eval`, no remote script.

### 7.4 Accessibility

- Route change: focus `#main`, announce title, update `aria-current`/document title through chrome
  (`ui/composables/useChrome.ts:50-68`). Reset `.page` only for page routes; chat/terminal skip it and
  restore their own `#chat-scroll`/terminal focus (§4.9).
- Chat: `role="log"` feed, polite announcer, status live region, queue strip live count, prompt dock
  focus management, question cards, composer `aria-describedby`, error `role="alert"`.
- Terminal: `screenReaderMode`, announcer, status `role="status"`, copy/reconnect/close labels,
  reduced-motion cursor blink, focus host on connect, keyboard copy/paste.
- Dialogs: focus trap/restore as the existing SPA dialog pattern; Escape ordering preserved.
- Mobile: chat sessions/context drawers and shell drawer do not trap each other; viewport
  `interactive-widget=resizes-content` preserved for chat.

---

## 8. Contract impact

- **Additive**: `chat`/`terminal` route ids and `matchPage` matching; `GET /api/ui/chat`,
  `GET /api/ui/terminal`; client router records with `meta.workspace`; boot `spaRoutes` and the
  router guard; workspace shell options (`pageClass`, `bodyClass`, viewport, `topbarActions`);
  chrome hints; `page__body--chat`/`page__body--terminal` in the SPA document; an App-level
  persistent topbar-actions component; `assets/chat-feed-store.js`; lazy chunks and same-origin
  vendor loaders.
- **Unchanged**: `/api/apps/*` chat APIs, `GET /api/apps/:app/events`, terminal WS path/proxy,
  auth/cookie behavior, headers/status codes, `/internal/mcp`, IDE/preview, CLI/MCP/extension.
- **Changed**: a migrated route's HTML becomes the SPA shell + boot JSON; Vue renders chat/terminal.
  Until Stage 9 this is reversible by flag; after cleanup the legacy flags/allowlist are ignored for
  these two `legacyRetired` routes and rollback is image rollback only (§4.13).
- **Approved-design amendments**: the eight explicit amendments in §1.5 (route matching, no default
  island, vendored xterm CSS exception plus Q6 bundling clarification, no S4 workspace exception,
  shared modules plus the additive feed-store copy, S9/S12 rollback/checkout lifecycle, S10 scope,
  S13 page-HTML test lifecycle).
- **Test churn**: chat/terminal HTML-string tests are retired only at cleanup; until then they keep
  guarding the rollback renderer (S13 amendment). New component/SSE/WS/E2E/router/boot tests are
  added. API/service tests are never deleted.
- **Docs**: `docs/current-state.md` gains the chat/terminal SPA status at cutover; `DESIGN.md` is
  unchanged.

---

## 9. Non-goals (explicit)

- No SSE/WS protocol change, no new server event types, no chat API shape change.
- No DB migration or new runtime dependency.
- No visual redesign; `assets/app.css` remains the single application stylesheet. The existing
  vendored xterm CSS is the sole documented exception, owned by `TerminalView` (§4.7).
- No no-JavaScript chat/terminal; `/login` stays legacy.
- No cleanup in this design or before the operator gate.
- No moving the six shared modules under `ui/` during this migration, and no editing or importing
  into `assets/chat.js`/`assets/terminal.js` before Stage 9. The feed store is a new copy, not a move.
- No new package; Vite bundling the existing Prism worker/xterm assets is allowed (Q6).
- No multi-user/rbac, offline/PWA, or service worker.

---

## 10. What "delete legacy" can mean, and only after operator verification

"Delete legacy" is a **post-verification cleanup of the legacy page implementation**, not a change to
the chat/terminal contracts.

It is allowed only when all of these are true:

1. both `/chat` and `/terminal` are SPA by default and the registry flags are `true`;
2. the operator has signed off the checklist below;
3. the owner has explicitly instructed the cleanup commit;
4. the cleanup plan names every file it deletes and every shared module it keeps.

Operator verification happens **on the deployment host after deploy**, not only in a local fixture.
The checklist is the minimum:

- chat: open/deep-link/refresh/back-forward; sessions list/tree/search/new/delete/switch while
  streaming; streaming text/tool/bash/table/diff/write/read/OMO/handoff/notice; send/stop/queue/
  pending/retry/drafts; questions/permissions/saved/SSH approvals; attachments upload/drop/paste/
  inline/file/quota; slash commands; context/compact/plan/previews/restart; reconnect/visibility/
  auth expiry; mobile widths and dark/light.
- terminal: open/deep-link; stopped/running/error runtime; connect/input/output/copy/reconnect/close;
  resize at multiple widths; normal exit/failure; theme/reduced motion; auth expiry; mobile/desktop.
- both: first load and client navigation on the deployed image; SPA chunks present; no console/page
  errors; no duplicate panels/messages; no duplicate vendor CSS; one topbar action set; rollback
  links work until cleanup.

After sign-off, cleanup may remove:
- `renderChatPage` and the legacy `GET /chat` page branch; `renderTerminalPage` and the legacy
  `GET /terminal` branch;
- chat-only render helpers `renderContextHandoffs`, `appOptions`, `renderPreviewRows`,
  `renderPreviewSection` and any other chat-page-only helper in the Stage 9 inventory;
  terminal-page-only helpers (currently `renderTerminalPage`, plus anything extracted for it);
- `assets/chat.js`, `assets/terminal.js`, and legacy-only allowlist entries;
- legacy-only tests and CSS;
- chat/terminal runtime-rollback expectations (`HANSE_UI_LEGACY=1`, `?legacy=1`, allowlist removal),
  replaced by the `legacyRetired` behavior + retired-flag matrix, the image-rollback procedure, and
  the mandatory UI-build/deploy check in §4.13.

Cleanup must **not** remove:
- `/api/apps/*` chat handlers, SSE, attachment upload/download, start;
- terminal WebSocket proxy/upgrade;
- all six shared modules at their current paths: `assets/markdown.js`, `assets/chat-core.js`,
  `assets/chat-commands.js`, `assets/chat-diff.js`, `assets/chat-highlight.js`,
  `assets/chat-highlight-worker.js`;
- the additive `assets/chat-feed-store.js` (the SPA feed store after `chat.js` is deleted);
- `renderNoApps` as the static shell-only zero-application entry page (`contentScript:false`, no
  `app-content.js`) and `renderNotFound` as the shared styled 404 (`contentScript?: boolean`; the
  chat/terminal path passes `false`, existing callers keep the default);
- `app.js`/`app-content.js` needed by `/login` or any remaining legacy page.

The six shared modules are not moved during this migration (Q3 closed). A future relocation is a
separate behavior-preserving refactor, not a cleanup step.

Post-cleanup readiness: the image builds the UI, `assets/ui/*` and the SPA entry are present, both
routes pass first-load + client-navigation smoke, the retired-flag matrix returns SPA/503 (never a
deleted-page 404), the deploy host is verified, and the previous image is available for image
rollback. If any of these is false, cleanup is not complete.

---

## 11. Owner decisions and remaining questions

### 11.1 Owner decisions (closed - do not reopen)

Recorded from the owner direction before round 2. These are decisions, not forks; implementation
must follow them.

| # | Decision |
| --- | --- |
| Q1 | **Option C is the architecture.** "Migration complete" means Vue owns the chat/terminal DOM and state, `chat.js`/`terminal.js` are deletable, and a formal legacy island is not the end state. |
| Q2 | **Client-side navigation** between migrated routes. There is no workspace/full-document exception to S4. Any exception would require an explicit S4 amendment, not a route-level Q. |
| Q3 | **Keep all six shared modules** as shared libraries at their current paths: `markdown.js`, `chat-core.js`, `chat-commands.js`, `chat-diff.js`, `chat-highlight.js`, `chat-highlight-worker.js`. Do not move them during this migration; cleanup must preserve them. |
| Q4 | **App switch = `router.push` with keyed `ChatPage` remount.** Flush the previous draft, drop the old session, and boot the new workspace cleanly. |
| Q5 | **Preserve legacy `/chat` without app** and its `302` to the first operator application; the SPA does not invent a no-app empty state. |
| Q6 | **Keep existing vendored xterm/Prism assets and add no new runtime dependency.** They stay same-origin; the existing Prism worker/xterm assets may be bundled by Vite (§4.10). Q6 is "no new package / no remote loader", not "no Vite bundling". |
| Verification | Operator verification is on the deployment host after deploy. |
| Cleanup | After operator sign-off, chat/terminal runtime rollback (S9) is retired; post-cleanup rollback is image rollback only, with the mandatory UI-build/deploy check. |

Prior decisions remain closed: Vue 3 + Vue Router + Pinia; Vue Query for server reads; cookie-only
SPA and `/api/ui/*`; no new runtime dependency; no `v-html`; no SFC `<style>`; `assets/app.css` is
the single application stylesheet (vendored xterm CSS excepted per §1.5.3); both routes migrate
before cleanup; cleanup waits for operator verification, not a soak.

### 11.2 Remaining owner questions

None. Q1-Q6 are closed above. If implementation surfaces a genuinely new owner-level fork (a UX or
product decision that requirements and code cannot settle), it must be added here and closed before
the affected stage; it must not be smuggled into a stage as a hidden assumption.

---

## 12. Verification (for the implementation plan)

Every stage must leave the repository green:

```bash
npm run lint
npm run typecheck
npm run typecheck:ui
npm test
npm run build
npm run check:sensitive
npm run check:ui
npm run test:e2e
```

Per stage additionally:
- legacy + SPA E2E for the touched route (Stage 2/3A:
  `HANSE_UI_SPA_ROUTES=${SPA_E2E_ROUTE_IDS},terminal`; Stage 3B onward:
  `${SPA_E2E_ROUTE_IDS},chat,terminal`; test-only, never a bare `=chat,terminal`);
- router/boot tests: direct load, client navigation, full-load fallback, no SPA render with the flag
  false, boot `spaRoutes` matches the server result;
- feed-store copy drift/freeze tests until Stage 9; the copied module becomes the sole
  implementation after `chat.js` is deleted;
- rollback drill before cleanup (`HANSE_UI_LEGACY=1`, `?legacy=1`, allowlist removal); after cleanup
  the retired-flag matrix + image rollback + the mandatory UI-build/deploy check;
- visual QA at 390/768/1024/1440 dark/light, including first-paint topbar;
- skeleton/CLS measurement at 390/1440;
- duplicate-resource check after enter/leave cycles, including highlight worker/`readyTimer` and
  vendor CSS ownership;
- chat/terminal chunk transfer measured and built-worker smoke for Prism;
- legacy rollback smoke retained until cleanup;
- operator checklist at Stage 8, executed on the deployment host after deploy.

---

## 13. Review history

- 2026-10-30 - initial draft authored for design review. No implementation has started.
- 2026-10-30 - **round 1 `oracle` review: CHANGES REQUESTED, nine blockers.** The blockers were:
  (1) S9/S12 runtime rollback vs Stage 9 cleanup; (2) topbar ownership (ChatPage-owned instead of
  App-level); (3) duplicate URL writers/guard flags; (4) S4/approved-design amendments missing;
  (5) Option C cost/stage size understated (event reducer and helper inventory); (6) highlight
  worker/`readyTimer` teardown; (7) SSE/WS auth expiry and bounded reconnect; (8) missing
  `recordOperatorHost` on the SPA/API path; (9) shell gaps (`bodyClass`, vendor CSS ownership,
  chrome hints, `focusMain`). Non-blocking notes covered Option B framing, shared-module wording,
  `?legacy=1` query preservation, bfcache/fonts disposal, sessionStorage ownership, reuse of
  `chat-qa.mjs`, test-only allowlist + built worker smoke, freeze/porting policy, event/PartType
  enumeration, and skeleton/CLS.
- 2026-10-30 - **revision 2: all nine round-1 blockers resolved**; owner decisions Q1-Q6 are
  recorded as closed in §11.1, with no remaining owner questions. §1.5 records the explicit
  `spa-migration.md` amendments; Stages 3-7 are split into independently verifiable sub-gates; the
  event-reducer/state-action inventory and the six-module keep list are explicit. Status was
  "revised after `oracle` round 1"; awaiting round 2 review.
- 2026-10-30 - **round 2 `oracle` review: CHANGES REQUESTED, four blockers.** The blockers were:
  (1) the client router/allowlist path was undefined (no chat/terminal records, no `meta.workspace`,
  no way for `HANSE_UI_SPA_ROUTES` to reach the browser, no full-load guard, so cutover would render
  `NotImplementedPage`); (2) post-cleanup rollback retirement still returned `undefined` and therefore
  a JSON/terminal 404 for `?legacy=1`, `HANSE_UI_LEGACY=1`, or allowlist removal; (3) Stage 3A's
  "move `createThreadStore`" would edit/import the byte-frozen legacy `chat.js` and break legacy
  rollback; (4) the approved-design amendments omitted S10 and S13 and did not narrow S9 sharply
  enough. Non-blocking notes covered page-header/body ownership, topbar first paint, agent-stopped/
  no-sessions deep links, highlight `stats.disabled` reset, the terminal bounded-retry C9 deviation,
  hidden SSE native reconnect, splitting Stage 7A, naming Stage 9 helpers, the `recordOperatorHost`
  guard, and Q6 vs Vite bundling.
- 2026-10-30 - **revision 3 (this document): all four round-2 blockers resolved** and all non-blocking
  notes folded in; owner decisions Q1-Q6 remain closed in §11.1 with **no remaining owner questions**.
  The client route set is carried in boot `spaRoutes` with router records/guard; post-cleanup routes
  are `legacyRetired` and have a retired-flag matrix; Stage 3A is copy-first with a drift rule; and
  §1.5 now carries the exhaustive S10/S13/S9 amendments. Status was "revised after `oracle` round 2";
  awaiting round 3 review.
- 2026-10-30 - **round 3 `oracle` review: CHANGES REQUESTED, two blockers.** (1) The post-cleanup
  contract said retired routes always serve SPA but retained `renderNoApps`/`renderNotFound` as
  `appShell` legacy HTML (one emitted `app-content.js`), contradicting S1/S9/Stage 9. (2) The
  test-only `HANSE_UI_SPA_ROUTES=chat[,terminal]` examples contradicted replacement-set semantics and
  would disable every existing SPA route, making the "navigate from another SPA route" gate and the
  SPA E2E suite fail. Non-blocking notes covered `/api/ui/chat` carrying a second session source,
  dev-URL 503, topbar first-paint seeding, Stage 1 allowlist timing, global fallback-link removal,
  and entry/error matrix coverage.
- 2026-10-30 - **revision 4: both round-3 blockers resolved** and non-blocking notes folded in.
  Entry/error pages became static shell-only pages (`contentScript:false`, no `app-content.js`)
  explicitly exempt from S1/S9; E2E allowlists use the full default SPA set plus the route under
  test via `SPA_E2E_ROUTE_IDS`; `/api/ui/chat` no longer carries `initialSession`; retired-route 503
  excludes `HANSE_UI_DEV_URL`; topbar is seeded before mount; Stage 1 does not allowlist records that
  do not exist; shared fallback-link removal is scoped. Status was "revised after `oracle` round 3";
  awaiting round 4 review.
- 2026-10-30 - **round 4 `oracle` review: CHANGES REQUESTED, two blockers.** (1) The server topbar
  fallback plus the App-level `TopbarActions` teleport would duplicate the action set because Vue
  Teleport appends to the existing `.topbar__actions` children; (2) `renderNotFound` still used the
  default `contentScript` and emitted `app-content.js`, so the "static shell-only / no app-content"
  claim was only true for `renderNoApps`. Non-blocking notes covered stage-specific E2E allowlists,
  the client `legacyRetired` data path, route-aware fallback links, and a `HANSE_UI_DEV_URL` matrix
  row.
- 2026-10-30 - **revision 5 (this document): both round-4 blockers resolved and non-blocking notes
  folded in.** `ui/main.ts` clears `.topbar__actions` exactly once before mount after seeding from
  boot, with node-count/id tests; `renderNotFound` gains `contentScript?: boolean` and the
  chat/terminal entry path passes `false`; route records carry `meta.legacyRetired`; fallback links
  are route-aware; E2E allowlists are stage-specific; the dev-URL matrix row is added. Status is
  "revised after `oracle` round 4"; awaiting round 5 review.
- 2026-10-30 - **round 5 `oracle` review: PASS.** Both round-4 blockers are resolved: `main.ts`
  clears `.topbar__actions` after reading boot and before mount, with node-count/id tests; the
  server fallback is pre-JS only. `renderNotFound` gained backward-compatible
  `contentScript?: boolean`, and the chat/terminal entry path passes `false`; no `app-content.js`
  leak remains. Non-blocking notes for the plan: forward `contentScript` through the private
  `shell()` helper, emit the boot `topbar` seed for every SPA route, keep `humanFromCookie` before
  post-cleanup entry semantics, and consider `contentScript:false` for the 503 page.

Round 1 blocker disposition (for review traceability):

| Blocker | Resolution |
| --- | --- |
| 1. Rollback vs cleanup | §1.3 S9/S12, §4.13, §10, Stage 8/9: runtime flags until sign-off; post-cleanup image rollback + mandatory UI build/deploy check. |
| 2. Topbar ownership | §4.2/§4.4/§4.9: App-level persistent `TopbarActions`, target existing `.topbar__actions`, ChatPage tree cleaned, default restored on leave. |
| 3. URL single owner | §1.3 C3, §4.5, §4.8: `route.query` sole source, no guard flags, one watcher; back/forward/session/app-switch tests. |
| 4. S4/approved-design amendments | §1.5: route matching, no default island/test-only allowlist, xterm CSS exception, no S4 workspace exception, shared modules, rollback/checkout lifecycle. |
| 5. Option C cost/stage size | §3 Option C, §4.5, Stage 0/3-7: event reducer + state-action + function/event inventory; sub-gates; per-slice characterization. |
| 6. Highlight teardown | §4.10/§4.11/C10: `disposeHighlightController()`, worker/`readyTimer` ownership, worker/timer count tests. |
| 7. SSE/WS auth expiry | §4.6/§4.7/§6.7: cookie-only probe on failure, bounded reconnect/pause, hidden `onerror`, every `stream.ready`, 429 probe, exact tests. |
| 8. `recordOperatorHost` | §4.1/§4.3/Stage 1: SPA first load, `/api/ui/chat` direct load, and client nav record the host with the legacy `request.host !== undefined` guard; test. |
| 9. Shell gaps | §4.2/§4.3/§4.9: `bodyClass` forwarding, one vendor CSS owner, chrome hints through `fetchChrome`, `focusMain` workspace branch, shell tests. |

Round 2 blocker disposition (for review traceability):

| Blocker | Resolution |
| --- | --- |
| 1. Client router/allowlist path | §4.1/§4.3/§4.2/Stages 1-3B/§6.1/§6.3: lazy chat/terminal records with `meta.workspace`; boot `spaRoutes` from `isSpaRoute`/allowlist; `SmartLink`/`isSpaPathIn` use the set; router guard full-document-loads off-set paths; test-only allowlist before cutover, registry default after; direct-load/client-nav/full-load/no-SPA tests. |
| 2. Post-cleanup rollback 404 | §1.3 S9, §4.13, Stage 9, §10: `legacyRetired` precedence, `?legacy=1` ignored for retired routes, never `undefined`, 503 HTML when the UI build is missing, entry semantics implemented inside `maybeServeSpa`, fallback links removed, retired-flag matrix. |
| 3. Stage 3A legacy break | §1.3 S2, §4.5, Stage 3A: copy-first `assets/chat-feed-store.js` + typed wrapper; `chat.js` byte-frozen, no import/edit; frozen-block baseline + characterization fixtures + drift rule; copy promoted sole owner at Stage 9. |
| 4. Approved-design amendments | §1.5: exhaustive eight amendments including S10 scope and S13 page-HTML test lifecycle; S9 narrowed to `legacyRetired` post-cleanup semantics; §8 updated. |

Non-blocking round-2 notes disposition: §1.4/§4.2 page-header vs body ownership; §4.2/§4.3 server
topbar fallback with zeroed counters; §4.8/§4.3 agent-stopped and empty-session `?session=`
preservation; §4.10 `stats.disabled` reset and remount test; §1.3 C9/§4.7/§6.7 bounded terminal
retry recorded as an intentional deviation; §1.3 C11/§4.6 hidden SSE native reconnect wording; Stage
7 split into 7A attachments/7B commands/7C cutover; Stage 9 names the chat/terminal-only helpers;
§4.1/§4.3 `recordOperatorHost` guard; §11.1 Q6 clarified as "no new dependency" with Vite bundling
allowed.
