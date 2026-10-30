# Plan 0032 - Chat and terminal SPA migration

Status: **approved** - `momus` plan review PASS (2026-10-30). Design is approved (`oracle` round 5
PASS). Stages 0-3A are implemented; `/terminal` is SPA by default with the legacy rollback retained and the chat data layer is in place. Stage 3B is the next action.

Design: [Chat and terminal SPA migration](../design/chat-terminal-migration.md) (approved).
Governing design: [Incremental SPA migration](../design/spa-migration.md) plus the eight explicit
amendments in design §1.5.
Governing owner decision: Gate D1 in [open questions](../open-questions.md:21-30) - migrate both
routes to the SPA, then operator verification, then cleanup.
Plan base: repository HEAD `0c290de5a5c4dce9b48777270438efacab0ea794`.
Scope: `/chat` and `/terminal`, their workspace shell integration, client route records, server
props/boot, SSE/WebSocket adapters, the copy-first chat feed store, the vertical chat port, the
deployment-host verification gate, and the post-verification legacy cleanup.
Non-goals: SSE/WebSocket protocol changes; chat/terminal HTTP handler, auth, DB, or response-shape
changes; moving chat/terminal data into `/api/ui/*`; visual redesign; migrating `/ide`, `/preview`,
or `/login`; a new runtime dependency; SSR; no-JavaScript chat/terminal; deleting legacy code before
Stage 8 sign-off and an explicit owner cleanup instruction; changing `DESIGN.md` tokens.

## Bindings

- Design author: maintainer. Design reviewer: `oracle` (round 5 PASS).
- Plan author: maintainer. Plan reviewer: `momus`.
- Design index: `docs/design/README.md`. Plan index: `docs/plans/README.md`.
- Journal index: `docs/journal/README.md`; this program records in
  `docs/journal/0039-chat-terminal-migration.md`.
- Open questions: design §11.2 has none; this plan has no design-level owner question.
- Language: English for docs, code comments, notices, and tests.
- Verification commands are listed in [Verification](#verification-commands) and repeated per stage.
- Commit policy: one coherent stage commit only when the owner explicitly authorizes it. Stage
  checkpoints below are **not** commits unless the owner has authorized them. Stage 8 may use the
  process exception (one code commit plus one docs-only deploy record). Stage 9 requires a separate
  explicit owner instruction for the cleanup commit.
- Target: Node `>=20.19.0`; existing Vue 3 / Vue Router / Pinia / Vue Query / Playwright / Vitest
  stack; no new package; no database migration.

## Owner decisions (closed - do not reopen)

| # | Decision used by this plan |
| --- | --- |
| Q1 | Option C. Vue owns the chat/terminal DOM and state; `chat.js` and `terminal.js` become deletable; a formal legacy island is not the end state. |
| Q2 | Client-side navigation between migrated routes. No workspace/full-document exception to S4. |
| Q3 | Keep all six shared modules at their current paths: `assets/markdown.js`, `assets/chat-core.js`, `assets/chat-commands.js`, `assets/chat-diff.js`, `assets/chat-highlight.js`, `assets/chat-highlight-worker.js`. |
| Q4 | App switch is `router.push` plus a keyed `ChatPage` remount: flush the draft, drop the old session, boot the new workspace. |
| Q5 | Preserve `/chat` without an app and its `302` to the first operator application; do not invent a no-app SPA state. |
| Q6 | Keep the existing vendored xterm/Prism assets and add no new runtime dependency. Same-origin assets may be bundled by Vite; Q6 is not a ban on Vite bundling. |
| Verification | Operator verification happens on the deployment host after deploy, using the Stage 8 checklist. |
| Cleanup | After sign-off, chat/terminal runtime rollback is retired; post-cleanup rollback is image rollback plus the mandatory UI-build/deploy check. |

Plan-local resolutions (not owner decisions):

- `RouteDefinition.nav` gains the value `"none"` as the design's first option. No separate
  `shellNav` field is introduced; the sidebar map still emits no item for `"none"`.
- The exact deployment-host command and runbook are not in the tracked repository. If
  `docs/deploy/README.md` exists it is authoritative. Otherwise the owner/deploy agent supplies the
  deploy command and rollback image tag at Stage 8; this plan never invents host details. This is
  the only Stage 8 input that is not derivable from the repository.

## Route ids and enablement

`src/shared/routes.ts` remains the single source of truth.

| id | path | nav | registry `spa` | `legacyRetired` |
| --- | --- | --- | --- | --- |
| `terminal` | `/terminal` | `project` | `false` until Stage 2 exit; `true` after | `false` until Stage 9; `true` after |
| `chat` | `/chat` | `none` | `false` until Stage 7C exit; `true` after | `false` until Stage 9; `true` after |

Enablement semantics are unchanged from `spa-migration.md`:

- `HANSE_UI_SPA_ROUTES` unset -> routes with registry `spa: true`.
- `HANSE_UI_SPA_ROUTES=""` -> every route legacy (before Stage 9).
- `HANSE_UI_SPA_ROUTES="projects,terminal"` -> only those ids; unknown ids log and are ignored.
- `HANSE_UI_LEGACY=1` > `?legacy=1` > allowlist > manifest validity > registry `spa`.
- The allowlist is a **replacement** set. A test-only value must contain every default SPA id plus
  the route under test. A bare `=chat` or `=terminal` is forbidden in every stage and test config.
- After Stage 9, `legacyRetired` takes precedence for these two ids: the flags are ignored and the
  route serves SPA or the explicit `503` HTML when the UI build is missing.

## File manifest

New files are marked `new`; files retained through cleanup are marked `keep`.

### Shared/server

| File | Stages | Purpose |
| --- | --- | --- |
| `src/shared/routes.ts` | 1, 2, 7C, 9 | chat/terminal ids, `legacyRetired`, `isLegacyRetired`, `isSpaPathIn`, `matchPage` |
| `src/http/spa.ts` | 1, 2, 3B, 7C, 9 | boot `spaRoutes`/`topbar`, page/body/viewport/topbar, `/api/ui/chat`, `/api/ui/terminal`, chrome hints, retired-route dispatch |
| `src/http/ui.ts` | 1, 9 | `renderSpaDocument` shell inputs; no legacy markup change |
| `src/http/dashboard.ts` | 1, 9 | private `shell()` `contentScript` forwarding; `renderNotFound(..., contentScript?)` |
| `src/http/props/chat.ts` | 1 (new), 3B | `buildChatProps` and chat prop types |
| `src/http/props/terminal.ts` | 1 (new), 2 | `buildTerminalProps` and terminal prop types |
| `src/http/handler.ts` | 9 | delete the legacy `GET /terminal` branch and chat/terminal asset allowlist entries; keep proxy dispatch |
| `src/http/chat.ts` | 1 (characterization only), 9 | delete `renderChatPage` and page-only helpers/branch; keep every `/api/apps/*` handler |
| `src/http/terminal.ts` | 9 | delete `renderTerminalPage`; keep `proxyTerminalUpgrade` |
| `assets/chat-feed-store.js` | 3A (new), keep | copy-first `createThreadStore`; sole feed store after Stage 9 |
| `assets/chat-highlight.js` | 5B, keep | additive `disposeHighlightController()`; no other behavior change |
| `assets/chat.js` | frozen, 9 delete | legacy chat page client; byte-frozen before Stage 9 |
| `assets/terminal.js` | frozen, 9 delete | legacy terminal page client; byte-frozen before Stage 9 |
| `assets/markdown.js` | keep | shared Markdown DOM builder |
| `assets/chat-core.js` | keep | snapshot/queue/tree/Omo/prompt projections |
| `assets/chat-commands.js` | keep | command catalog/filter helpers |
| `assets/chat-diff.js` | keep | diff extraction/caps |
| `assets/chat-highlight-worker.js` | keep | Prism module worker |

### Client

| File | Stages | Purpose |
| --- | --- | --- |
| `ui/router.ts` | 1, 2, 3B | route records, meta augmentation, navigation guard |
| `ui/spa-routes.ts` | 1 (new) | installed boot route set |
| `ui/boot.ts` | 1 | validate `spaRoutes` and `topbar` |
| `ui/main.ts` | 1 | install route set, seed/clear topbar, mount |
| `ui/App.vue` | 1 | App-level persistent `TopbarActions` |
| `ui/components/SmartLink.vue` | 1 | use `isSpaPathIn` with the boot set |
| `ui/components/TopbarActions.vue` | 1 (new) | one persistent topbar owner |
| `ui/composables/useChrome.ts` | 1 | workspace `focusMain` branch, chrome hints, outlet cleanup |
| `ui/composables/useWorkspaceShell.ts` | 1 (new) | page class/viewport apply/restore |
| `ui/pages/TerminalPage.vue` | 2 (new) | terminal route shell |
| `ui/components/TerminalToolbar.vue` | 2 (new) | title, runtime pill, status, actions |
| `ui/components/TerminalBanner.vue` | 2 (new) | banner states |
| `ui/components/TerminalView.vue` | 2 (new) | xterm host, sole vendor script/CSS loader owner |
| `ui/components/TerminalStoppedState.vue` | 2 (new) | stopped/error runtime state |
| `ui/terminal/loader.ts` | 2 (new) | idempotent xterm script/CSS loader |
| `ui/terminal/socket.ts` | 2 (new) | framework-free terminal socket adapter |
| `ui/composables/useTerminalSocket.ts` | 2 (new) | lifecycle wrapper |
| `ui/pages/ChatPage.vue` | 3B (new) | chat route shell, keyed remount |
| `ui/chat/event-reducer.ts` | 3A (new) | pure `HanseEvent` -> state actions |
| `ui/chat/state-actions.ts` | 3A (new) | apply actions, return render intents |
| `ui/chat/feed-store.ts` | 3A (new) | typed wrapper over `assets/chat-feed-store.js` |
| `ui/chat/stream.ts` | 3B (new) | SSE adapter, seq/gap/auth probe |
| `ui/chat/useChatRouteState.ts` | 3B (new) | normalized `route.query` reader; no writer |
| `ui/chat/session-storage.ts` | 3C (new) | namespaced queue-promotion/image-intent owner |
| `ui/stores/chat-ui.ts` | 3B (new) | route-derived UI state, topbar counters, dialogs |
| `ui/stores/chat-session.ts` | 3A (new) | session list/tree, active mirror, generation |
| `ui/stores/chat-composer.ts` | 4A (new) | draft, attachments, upload, pending sends |
| `ui/stores/chat-prompts.ts` | 6A (new) | questions, permissions, saved permissions |
| `ui/stores/chat-feed.ts` | 3A (new) | keyed messages/parts, stream ids, notices |
| `ui/stores/chat-context.ts` | 3A (new) | context, todo/plan, previews, handoffs, runtime |
| `ui/composables/useChatStream.ts` | 3B (new) | connect/disconnect/visibility/bfcache lifecycle |
| `ui/composables/useChatComposer.ts` | 4A (new) | draft keepalive/flush, send/stop, recovery |
| `ui/components/chat/ChatSessionsRail.vue` | 3B (new), 3C | sessions/tree/search/new/delete |
| `ui/components/chat/ChatThread.vue` | 3B (new), 3C | history rows, keyed messages, scroll |
| `ui/components/chat/ChatMessage.vue` | 3B (new), 5A | one message |
| `ui/components/chat/MarkdownBlock.vue` | 5A (new) | `renderMarkdown`, 50 ms throttle |
| `ui/components/chat/ToolPart.vue` | 5A/5B (new) | tool view and mount container |
| `ui/components/chat/DiffView.vue` | 5B (new) | diff caps/worker mount |
| `ui/components/chat/ReadView.vue` | 5B (new) | read view |
| `ui/components/chat/WriteView.vue` | 5B (new) | write view |
| `ui/components/chat/OmoCard.vue` | 5A (new) | `classifyOmo` render |
| `ui/components/chat/HandoffCard.vue` | 5A (new) | handoff card |
| `ui/components/chat/ChatGeneratingRow.vue` | 5A (new) | generation row |
| `ui/components/chat/ChatNoticeRow.vue` | 5A (new) | notice rows |
| `ui/components/chat/ChatNewMessagesButton.vue` | 5C (new) | follow-bottom control |
| `ui/components/chat/ChatComposer.vue` | 4A (new) | textarea, send/stop, attachments, keyboard |
| `ui/components/chat/ChatCommandPalette.vue` | 7B (new) | slash palette |
| `ui/components/chat/ChatQueueStrip.vue` | 4C (new) | queue strip |
| `ui/components/chat/ChatPromptDock.vue` | 6A (new) | question/permission dock |
| `ui/components/chat/ChatQueueDialog.vue` | 4C (new) | needs-input dialog |
| `ui/components/chat/ChatContextRail.vue` | 6B (new) | app/previews/context/plan/saved/handoffs |
| `ui/components/chat/ChatScrim.vue` | 3B (new) | mobile drawers/scrim |
| `ui/components/chat/ChatAttachments.vue` | 7A (new) | chips, upload progress, drop/paste |

### Harness, tests, docs

| File | Stages | Purpose |
| --- | --- | --- |
| `e2e/support/opencode-upstream.ts` | 0 (new) | deterministic opencode HTTP/SSE and runner WS upstream |
| `e2e/support/route-ids.ts` | 0 (new) | `SPA_E2E_ROUTE_IDS` used by Playwright |
| `e2e/support/server.ts` | 0, 2, 3B | fake upstream/runtime wiring, route-mode flags |
| `e2e/support/seed.ts` | 0 | deterministic sessions/messages/runtime rows |
| `playwright.config.ts` | 0, 2, 3B | stage-specific allowlists, chat/terminal projects |
| `docs/design/chat-qa.mjs` | 0 | SPA/legacy mode and route-set support; one chat fixture |
| `scripts/check-chat-worker.mjs` | 0 (new) | execute Prism inside the built worker |
| `scripts/vite.worker-smoke.config.mjs` | 0 (new) | standalone worker build for the smoke |
| `package.json` | 0 | `check:chat-worker` script |
| `test/fixtures/chat-feed-characterization.json` | 0 (new) | recorded legacy feed/queue/status fixtures |
| `test/fixtures/legacy-clients.sha256` | 3A (new) | frozen `chat.js`/`terminal.js` hashes |
| `test/*.test.ts`, `test/ui/*.test.ts`, `e2e/*.spec.ts` | per stage | exact names in each stage |
| `docs/design/spa-migration.md` | 0 | record the design §1.5 amendments |
| `docs/journal/0039-chat-terminal-migration.md` | 0, every stage | baseline, inventory, stage records |
| `docs/current-state.md` | 2, 7C, 9 | rendering-mode status |
| `docs/deployment.md` | 8, 9 | operator check and post-cleanup rollback procedure |
| `docs/plans/README.md` | plan creation, 9 | plan status/index |

## Cross-stage invariants

These apply to every stage and are gate failures if violated.

- **No legacy island on a default-enabled SPA route.** Temporary scaffolding is only permitted
  behind the test-only allowlist containing the full default SPA set plus the route under test, and
  must be removed before that route's registry cutover.
- **Frozen legacy clients.** `assets/chat.js` and `assets/terminal.js` are byte-frozen until Stage 9.
  No stage may edit, import into, or refactor them. Only Stage 9 deletes them.
- **No hash or copy drift.** `assets/chat-feed-store.js` is a copy, not a move. It has no `ui/`
  import and no legacy-client import. The legacy file is the behavior oracle until Stage 9.
- **One URL owner.** `route.query` is the sole source for `app`, `project`, and `session`. Stores
  never write the URL; one route watcher applies the query. User actions call the router.
- **One shell.** Chat/terminal never fork sidebar, topbar, breadcrumb, drawer, theme, toasts, or page
  classes. `TopbarActions.vue` is mounted once by `App.vue`; route pages never own it.
- **One resource owner.** One EventSource per chat page, one WebSocket per terminal page, one
  highlight controller per route mount, one xterm vendor CSS loader. Every owner has a teardown.
- **Cookie-only.** SPA documents and `/api/ui/*` stay cookie-only; chat SSE and terminal WS keep
  their existing human-cookie auth. No token enters boot, props, URLs, or storage.
- **No secrets.** Boot/props carry route ids, hrefs, zeroed counters, identity, runtime state, and
  links only. No runner token, provider key, MCP token, or password.
- **No `v-html` and no SFC `<style>`.** Markdown uses the `renderMarkdown` DOM builder. Terminal
  `innerHTML` uses are replaced by Vue templates/createElement nodes.
- **Single application stylesheet.** `assets/app.css` stays the only application stylesheet. The
  vendored xterm CSS is the sole documented exception and is loaded only by `TerminalView`.
- **No premature cleanup.** No legacy renderer, script, CSS, HTML test, or asset allowlist entry is
  deleted before Stage 9 and the Stage 8 sign-off plus explicit owner cleanup instruction.

## Verification commands

Repository gates for every stage:

```bash
npm run lint
npm run typecheck
npm run typecheck:ui
npm run typecheck:e2e
npm test
npm run build
npm run check:sensitive
npm run check:ui
npm run test:e2e
```

Plan-local gates:

```bash
npm run check:chat-worker                          # Stage 0+, after npm run build
git diff --check                                   # every checkpoint
```

Stage-specific E2E allowlists (test-only; never a production default and never a bare route):

- Stage 0/1: no chat/terminal allowlist entry.
- Stage 2/3A: `HANSE_UI_SPA_ROUTES=${SPA_E2E_ROUTE_IDS},terminal`.
- Stage 3B onward: `HANSE_UI_SPA_ROUTES=${SPA_E2E_ROUTE_IDS},chat,terminal`.
- After Stage 9: the retired-flag matrix plus the image-rollback check; flags are ignored for the
  two retired routes.

## Rollback rules

Until Stage 8 sign-off:

- Global: `HANSE_UI_LEGACY=1` plus restart serves every route from the legacy renderer.
- Single request: `?legacy=1`; `maybeServeSpa` returns `undefined` and the legacy handler renders.
- Per-route: remove the route id from `HANSE_UI_SPA_ROUTES` (restart). This is a replacement set:
  every route that should stay SPA must be listed.
- The legacy renderer and script stay frozen and reachable until Stage 8 sign-off.

After Stage 9:

- Chat/terminal route definitions are `legacyRetired: true`. `HANSE_UI_LEGACY=1`, `?legacy=1`, and
  allowlist omission are ignored for them and produce the SPA document, or the explicit `503` HTML
  when no UI build exists.
- The only rollback is an image rollback to the last image containing the legacy pages. The
  mandatory UI-build/deploy check in Stage 8/9 applies before any post-cleanup deploy is healthy.
- No flag path may ever return `undefined` into a deleted legacy branch.

## Sensitive-data rules

- Tracked files, commit messages, screenshots, and reports never contain deployment-host names,
  LAN/public addresses, ports, SSH users, absolute home/install/backup/state paths, OS/package/
  container versions, disk usage, real project/app names or ids, session ids, tokens, keys, or
  screenshots of real data. Use `<deployment-host>`, `<LAN_HOST>`, `<INSTALL_DIR>`, `<BACKUP_DIR>`,
  `<PROJECT_ID>`, `<SESSION_ID>`.
- QA evidence, deploy logs, and deployment checklists live in the untracked, git-ignored
  `docs/deploy/` directory or the workspace, never in tracked docs.
- Run `npm run check:sensitive` before every checkpoint. Review binary artifacts manually.
- Fixture tokens and ids are obvious test literals; never reuse deployment secrets.

---

## Stage 0 - Baseline and deterministic workspace harness

Goal: prove the current behavior and build the deterministic harness and inventory that every later
stage relies on. No route, flag, or production behavior changes.

Depends on: design approval; repository gates currently green.

### Boundaries

In scope: baseline evidence, fake opencode/runner upstream, fixture wiring, chat-qa reuse, existing
page/client characterization, the event/PartType/function inventory, the built-worker smoke, and the
design-amendment record.

Out of scope: SPA code, route records, props endpoints, any route flag, any edit to
`assets/chat.js`/`assets/terminal.js`, and any legacy test retirement.

### Tasks

1. Record the baseline in the untracked workspace or `docs/deploy/` (placeholders only): `git rev-parse
   HEAD`, `npm run lint`, `npm run typecheck`, `npm run typecheck:ui`, `npm run typecheck:e2e`,
   `npm test`, `npm run build`, `npm run check:sensitive`, `npm run check:ui`, `npm run test:e2e`;
   current `/chat` and `/terminal` screenshots at 390/768/1024/1440 dark/light; skeleton/CLS
   measurements at 390/1440; current chat/terminal transfer sizes.
2. Create `docs/journal/0039-chat-terminal-migration.md` with the baseline, the Stage 0 inventory,
   accepted risks, and a status line. Add its entry to `docs/journal/README.md`.
3. Record design §1.5.1-§1.5.8 verbatim as a dated amendment section in
   `docs/design/spa-migration.md`. Do not change any other invariant or wording.
4. Add `e2e/support/opencode-upstream.ts`:
   - a deterministic loopback HTTP server implementing the opencode endpoints that
     `src/opencode/client.ts` and `src/http/prompts.ts` call for the fixture app: session list/get,
     messages (`GET` paged and legacy, `POST` async), session status, command list/execute,
     question/permission list/reply/reject, saved permissions, todo, abort, summarize, and
     prompt_async; exact route set comes from `src/opencode/client.ts`;
   - `GET /event` SSE with a fixed `streamID`, `seq: 0` ready frame, heartbeats, and scripted frames
     for `stream.ready`, text deltas, a tool part, `session.status`, `question.asked`,
     `permission.asked`, `stream.warning`, `notice.created`, `context.updated`, and
     `message.part.omitted`; all ids are synthetic;
   - a WebSocket upgrade at `/v1/apps/<appId>/exec` that requires the fixture bearer token, echoes
     binary input, accepts resize JSON, can emit normal exit 1000/1001 and failure 1011, and never
     contacts Docker or a real opencode;
   - no production import and no exposure through the coordinator; a loopback-only test control
     endpoint may advance scenario frames.
5. Wire the harness in `e2e/support/server.ts` and `e2e/support/seed.ts`: start the fake upstream on
   an ephemeral loopback port, point `manager.endpointFor` for the fixture app at it, point
   `deps.runner` at the fake WS upstream, seed deterministic session/message/runtime rows, and keep
   the existing fake services. No real Docker, opencode, or network.
6. Add `e2e/support/route-ids.ts` exporting `SPA_E2E_ROUTE_IDS` (every default SPA id) and use it in
   `playwright.config.ts`. Add chat/terminal spec entries to the config in Stage 2/3B; Stage 0 may
   keep placeholder skipped specs so no Playwright project is empty.
7. Extend `docs/design/chat-qa.mjs`: add `CHAT_QA_MODE=legacy|spa` (default `legacy`),
   `CHAT_QA_SPA_ROUTES` (full default set plus the route under test), and route-target selection so
   the same scenarios can run against a legacy or SPA `/chat`. Keep all existing scenarios and the
   fake `EventSource`; do not create a second chat fixture.
8. Add characterization coverage:
   - keep `test/chat-page.test.ts` and `test/terminal-http.test.ts` as the current contract;
   - add `test/chat-feed-characterization.test.ts` for the legacy feed/queue/status snapshots that
     the copy-first store will replay;
   - add `test/e2e-upstream.test.ts` proving the real `createHttpServer` SSE and terminal upgrade
     paths work against the fake upstream (ready/seq/heartbeat/close, cookie auth, resize, exit);
   - record `test/fixtures/chat-feed-characterization.json` from the legacy harness with synthetic
     data only (feed order, message/part maps, optimistic rekey, queue, stream ids).
9. Produce the **function/event-to-slice inventory** in journal 0039:
   - one row for every `HanseEvent` in `src/opencode/events.ts` with target reducer action, store,
     sub-gate, and test;
   - one row for every `PartType` (`text`, `reasoning`, `tool`, `step-start`, `step-finish`, `patch`,
     `file`, `subtask`, `retry`, `compaction`, `snapshot`, `agent`, unknown) with the same fields;
   - one row per legacy function group: `handleStreamEvent`, hydration buffering, message/part
     upsert, optimistic rekey, queue derivation, session tree, prompt dock, context/status render,
     notices, scroll, draft/pending, attachments, commands, and teardown; each row names its target
     store/action and Stage sub-gate.
10. Add the built Prism worker smoke:
    - `scripts/vite.worker-smoke.config.mjs` builds `assets/chat-highlight-worker.js` as a module
      worker into a temporary output;
    - `scripts/check-chat-worker.mjs` starts the baked/Playwright Chromium, instantiates the built
      worker, sends `init` and a small TypeScript tokenize request, asserts a token result (not just
      worker construction), and exits non-zero on console/page errors or a plain fallback;
    - add `check:chat-worker` to `package.json`; document that it runs after `npm run build`.
11. Add no route flag and no SPA route record. No chat/terminal allowlist entry exists in Stage 0 or
    Stage 1.

### Acceptance criteria

- Baseline is recorded; current `/chat` and `/terminal` render through the legacy path exactly as
  before.
- The fake upstream drives a real coordinator SSE stream and terminal WS proxy deterministically;
  no Docker or real opencode is contacted.
- `chat-qa.mjs` can drive the legacy chat with its existing scenarios and has the SPA mode seam.
- The inventory covers every `HanseEvent`, every `PartType`, and every legacy function group listed
  in design §4.5.
- The built worker smoke executes Prism inside the built worker.
- No production file, route flag, or legacy test changes.

### Tests, E2E, visual QA

- Existing server/contract suites remain green, including `test/app-events.test.ts`,
  `test/context-http.test.ts`, `test/terminal-http.test.ts`, `test/chat-page.test.ts`.
- New: `test/e2e-upstream.test.ts`, `test/chat-feed-characterization.test.ts`,
  `npm run check:chat-worker`.
- Browser evidence: `CHAT_QA_MODE=legacy node docs/design/chat-qa.mjs`; terminal legacy screenshots
  and skeleton/CLS captures from the baseline run. Evidence stays untracked.

### Gate commands

```bash
npm run lint
npm run typecheck
npm run typecheck:ui
npm run typecheck:e2e
npm test
npm run build
npm run check:sensitive
npm run check:ui
npm run check:chat-worker
npm run test:e2e
git diff --check
```

### Commit checkpoint

No commit unless the owner authorizes a Stage 0 commit. Suggested message:
`test(ui): add deterministic chat and terminal migration harness`.

### Legacy retention and rollback

No cutover. Both routes remain legacy. Rollback is "remove the new test harness and journal
additions"; no production behavior to roll back.

---

## Stage 1 - Workspace shell, routes, and props (no cutover)

Goal: add the chat/terminal route identity, server props/boot contract, client route-set/guard,
workspace shell primitives, and topbar ownership while both routes stay legacy.

Depends on: Stage 0.

### Boundaries

In scope: route ids and matching, `spa:false` entries, `legacyRetired:false`, props modules,
cookie-only `/api/ui/chat` and `/api/ui/terminal`, boot `spaRoutes`/`topbar`, `SmartLink`/guard,
workspace shell/composable, persistent `TopbarActions`, chrome hints, guarded operator-host
recording, and `renderSpaDocument` shell inputs.

Out of scope: chat/terminal route records or components, any chat/terminal allowlist entry, any
registry flag flip, any SPA page for either route, and any legacy renderer change.

### Invariants

- `matchPage("/chat")` and `matchPage("/terminal")` return the new ids; `/api/*`, `/ide`,
  `/preview`, `/assets/*`, and terminal upgrades remain unmatched.
- `RouteDefinition.nav` accepts `"none"`; `chat` uses it and `terminal` uses `"project"`.
- The client route set is the resolved boot set, not a second policy. `SmartLink` and the router
  guard use it. A path outside the set full-document-loads.
- `/api/ui/chat` and `/api/ui/terminal` are cookie-only and reject agent tokens and human bearers
  exactly like every `/api/ui/*` endpoint.
- `recordOperatorHost` is called only when `request.host !== undefined`, matching legacy.
- The private `shell()` helper accepts and forwards `contentScript` for Stage 9, defaulting to the
  current behavior.
- Legacy `/chat` and `/terminal` HTML remains byte-for-byte unchanged.

### Tasks

1. `src/shared/routes.ts`:
   - add `chat` and `terminal` to `RouteId`;
   - add `"none"` to `NavId` and register `chat` with `nav:"none"`, `terminal` with `nav:"project"`;
   - add `legacyRetired?: boolean` to `RouteDefinition` (both `false` in this stage);
   - add `isLegacyRetired(id)` and `isSpaPathIn(pathname, ids)`; `isSpaRoute` precedence is unchanged
     until Stage 9;
   - compile static `/chat` and `/terminal` in `matchPage`;
   - update `test/shared-routes.test.ts`: the old "never matches chat/terminal" assertion becomes
     the amendment assertion (matches the ids, still never matches API/assets/IDE/preview/upgrade
     paths); add a route-table test that every page id which can appear in boot `spaRoutes` has a
     router record and a `legacyRetired` value consistent with the registry. Enforce records for
     `terminal` at Stage 2 and `chat` at Stage 3B; before then assert the ids are absent from the
     boot set.
2. `src/http/spa.ts`:
   - `renderSpaDocument` takes `spaRoutes: readonly RouteId[]`, `pageClass?`, `bodyClass?`,
     `viewport?`, and `topbarActions?`; forwards the shell inputs to `appShell` and writes
     `spaRoutes` plus the topbar seed into boot JSON;
   - `maybeServeSpa` computes `spaRoutes` once from `ROUTES.filter((route) =>
     isSpaRoute(route.id, { manifestValid: true }))`; the current boot id must be in the set or the
     request is not served as SPA;
   - add `chat`/`terminal` cases to `routeChrome` (`<appKey> chat` / `<appKey> terminal`,
     breadcrumbs Projects -> project -> app -> Chat/Terminal, active `none`/`project`);
   - `/api/ui/chrome` accepts `project` and `app` hints and resolves chrome with
     `chromeFor(site, match, hint)`; `fetchChrome` gains the same optional hints and forwards them
     from `useChrome` on navigation and visibility;
   - add `/api/ui/chat` and `/api/ui/terminal` to `UI_API_PATHS` and `handleUiApi`; both use
     `authorizeUiRead`, `no-store`, and the shared prop builders;
   - for chat, record the operator host on the SPA document path and on a direct `/api/ui/chat`
     read with the legacy guard.
3. `src/http/props/chat.ts` and `src/http/props/terminal.ts` (new):
   - `buildChatProps` returns app/project identity, app href/folder/master, links (app, IDE,
     settings, skills, terminal, handoffs), runtime state and runtime URL, app selector options,
     pending restart, handoffs, previews, deleting state, breadcrumb/title, and the stable topbar
     fallback (`ideHref`, `needsInputCount: 0`, `policyVisible: false`, `contextToggle: true`);
   - `buildTerminalProps` returns app/project identity, runtime state, WS path, runtime URL, chat
     href, breadcrumb/title, and the stable topbar fallback (`ideHref`);
   - extract the data assembly from the legacy renderers with characterization tests so legacy HTML
     and SPA props cannot drift; do not edit `renderChatPage`/`renderTerminalPage`.
4. `src/http/ui.ts` / `src/http/dashboard.ts`:
   - keep `appShell` markup unchanged; `renderSpaDocument` already owns shell inputs;
   - extend the private `shell()` helper's options with `contentScript?: boolean` and forward it to
     `appShell` (default behavior unchanged). This is the Stage 9 path for
     `renderNotFound(..., { contentScript: false })`.
5. Client route set:
   - `ui/boot.ts` validates `spaRoutes` as an array of strings, filters to known `RouteId`s, and
     validates the topbar seed; unknown ids never enable a route;
   - `ui/spa-routes.ts` (new) installs the validated set and exposes it to `SmartLink` and the guard;
   - `ui/main.ts` installs the set before `app.use(router)`, reads the boot topbar seed, clears
     `.topbar__actions` exactly once with `replaceChildren()`, then mounts;
   - `ui/router.ts` augments `RouteMeta` with `workspace?: "chat" | "terminal"` and
     `legacyRetired?: boolean`; adds `router.beforeEach` that full-document-loads when `matchPage`
     is undefined, the id is not in the installed set, or (`to.query.legacy === "1"` and the id is
     not `legacyRetired`); no chat/terminal route record yet;
   - `ui/components/SmartLink.vue` computes `isSpaPathIn(pathname, installedSpaRoutes())`; no
     `process.env` in the browser;
   - `ui/App.vue` mounts `TopbarActions.vue` once; the new component teleports into the existing
     `.topbar__actions`, renders the boot seed on first render, and later renders the default IDE
     action or the chat control set from `chatUi`.
6. Workspace shell:
   - `ui/composables/useWorkspaceShell.ts` (new) applies/removes `#main` page class and the viewport
     meta on client navigation and restores the default on leave; the route component owns its own
     `.page__body--chat/--terminal` root;
   - `ui/composables/useChrome.ts` `focusMain(destination)` skips the `.page` reset for a workspace
     route and still focuses `#main` with `preventScroll`; normal routes keep the current reset;
   - `fetchChrome` accepts `{ projectId, appKey }` hints and uses them for chat/terminal.
7. Tests:
   - `test/shared-routes.test.ts` (ids, matching, `isSpaPathIn`, legacyRetired default);
   - `test/ui-props-auth.test.ts` (new endpoints: cookie human 200; no cookie 401; human bearer 403
     `cookie_required`; agent token 403; `no-store`; no secret sentinel);
   - `test/ui-props-chat.test.ts` and `test/ui-props-terminal.test.ts` (prop shape, links, zeroed
     topbar, operator-host guard called/not called);
   - `test/ui/boot.test.ts` (`spaRoutes` round-trip, unknown ids dropped, boot id absent -> fail
     closed, topbar seed validation);
   - `test/ui/spa-routes.test.ts` (install/read, no process env);
   - `test/ui/router-guard.test.ts` (off-set path full-load; `?legacy=1` non-retired full-load;
     retired route allowed; programmatic push/back-forward/direct reload);
   - `test/ui/smartlink.test.ts` is not added; extend `ui/components/SmartLink.test.ts`;
   - `test/ui/topbar-actions.test.ts` (one action set, node ids/counts before/after mount, default
     restore, chat seed counters 0);
   - `test/ui/workspace-shell.test.ts` (class/viewport apply/restore);
   - `test/ui/useChrome.test.ts` (hints, workspace focus skip, normal reset);
   - `test/ui/shell-scripts.test.ts` (legacy pages keep both scripts; SPA documents keep only
     `app.js`; `contentScript:false` forwarding).
8. No chat/terminal record, component, or allowlist entry. The `/api/ui/*` endpoints are exercised
   only by tests in this stage.

### Acceptance criteria

- Route table tests reflect both ids; `matchPage` matches both static paths and still excludes
  API/assets/IDE/preview/upgrades.
- `spaRoutes` round-trips; unknown ids fail closed; the boot route id must be in the set.
- `SmartLink` and the router guard use the boot set and full-document-load an off-set destination.
- Boot topbar seed renders one action set before and after mount, with no duplicate ids; leaving a
  chat/terminal route restores the default action.
- `/api/ui/chat` and `/api/ui/terminal` are cookie-only, carry no secrets, and return the documented
  props; guarded operator-host recording is tested.
- Legacy `/chat` and `/terminal` HTML is byte-for-byte unchanged; no SPA serve while both flags are
  false; no chat/terminal allowlist entry exists.

### Tests, E2E, visual QA

- Unit/component tests listed above; existing `/chat`/`terminal` HTML tests unchanged.
- E2E: full existing suite still green; assert `/chat` and `/terminal` remain legacy in `spa` and
  `legacy` modes; no chat/terminal SPA component is rendered.
- Visual QA: shell/topbar behavior on an existing SPA route at 390/768/1440 dark/light; no first
  paint change on legacy chat/terminal. Evidence untracked.

### Gate commands

```bash
npm run lint
npm run typecheck
npm run typecheck:ui
npm run typecheck:e2e
npm test
npm run build
npm run check:sensitive
npm run check:ui
npm run test:e2e
git diff --check
```

### Commit checkpoint

No commit unless the owner authorizes a Stage 1 commit. Suggested message:
`feat(ui): add chat and terminal workspace shell and route-set plumbing`.

### Legacy retention and rollback

Both routes stay legacy (`spa:false`, no allowlist entry). Rollback is to remove the route ids,
props endpoints, boot fields, guard, and workspace components; the legacy renderers and scripts are
untouched.

---

## Stage 2 - Terminal full Vue port and cutover

Goal: replace the legacy terminal document with `TerminalPage`/`TerminalView` and the terminal socket
adapter, then cut `/terminal` over to the SPA.

Depends on: Stage 1.

### Boundaries

In scope: terminal components, xterm loader, socket adapter, terminal boot/props/topbar, router
record, registry cutover, E2E/visual QA, rollback drill.

Out of scope: chat; changing `proxyTerminalUpgrade`, the WS path, or the runner contract; xterm
vendor file changes; Stage 9 cleanup.

### Invariants

- One xterm script/CSS loader; `TerminalView` is the sole owner. The server never emits the xterm
  stylesheet through `renderSpaDocument.styles`.
- One WebSocket per terminal page; connect increments a generation and stale callbacks are ignored.
- Retry delays are exactly `[1,2,4,8,15]s`, five automatic attempts, then manual Reconnect. This is
  the recorded C9 deviation from legacy's unlimited retry loop.
- Auth expiry is detected only through the cookie-only `/api/ui/chrome?path=/terminal` probe; no
  token is added to the WS URL.
- `pagehide`/unmount dispose xterm, observers, listeners, pending `document.fonts.ready` fit, retry
  timers, auth-probe timers, and the socket.
- Terminal `innerHTML` uses from `assets/terminal.js` are not copied; Vue templates/createElement
  nodes own the banner/status markup.

### Tasks

1. Implement `src/http/props/terminal.ts` consumption and wire terminal in `src/http/spa.ts`:
   `pagePropsFor` returns terminal props for `match.id === "terminal"` (or falls through until
   cutover); `renderSpaDocument` receives `page--terminal`, `page__body--terminal`, and the terminal
   viewport; the server topbar fallback is the default IDE action; `chromeFor` uses the terminal
   hints from Stage 1.
2. `ui/pages/TerminalPage.vue`: owns the runtime `.page__body page__body--terminal` root and the
   interior `#terminal` workspace heading. No `.page-header`, no second body wrapper.
3. `ui/components/TerminalToolbar.vue`, `TerminalBanner.vue`, `TerminalStoppedState.vue`:
   tool title/runtime pill/status, copy/reconnect/close labels, banner states, stopped/error state
   linking to chat; preserve live regions and reduced-motion behavior.
4. `ui/components/TerminalView.vue`:
   - loads the four existing `/assets/vendor/xterm/*.js` scripts in order and the one
     `/assets/vendor/xterm/xterm-6.0.0.css` through `ui/terminal/loader.ts` (idempotent,
     promise-cached, same-origin, no `eval`, no remote loader);
   - instantiates xterm with the legacy options (token font, scrollback 5000, screenReaderMode,
     reduced-motion cursor blink);
   - installs `ResizeObserver`, `window.resize`, `visualViewport`, `document.fonts.ready`, and a
     `data-theme` `MutationObserver`; a pending fonts callback is guarded by a disposed flag;
   - shows "Terminal engine unavailable" with Retry on loader failure; the `?legacy=1` link is
     present until Stage 9 and removed then.
5. `ui/terminal/socket.ts` + `ui/composables/useTerminalSocket.ts`:
   - build `ws(s)://${location.host}${wsPath}`; runtime preflight through
     `/api/apps/:app/runtime?project=` before connect;
   - generation guard, manual close, normal exit 1000/1001, retryable failure, 1011, stopped/error;
   - bounded five-attempt retry with a visible countdown; after the fifth, a manual-only Reconnect;
   - cookie-only auth probe on a retryable close (at most one per window, 5 s cooldown, none while
     hidden); 401/403 -> `/login?next=<current fullPath>`, 200 -> continue bounded retries;
   - input bytes, resize JSON `{type:"resize",cols,rows}` clamped to 1..1000;
   - `dispose()` closes the socket and clears every timer/abort controller; `pagehide` disposes;
     `pageshow` reconnects once when visible.
6. `ui/router.ts`: register the lazy `/terminal` record with `meta: { workspace: "terminal",
   legacyRetired: false }`. The route-table test starts enforcing the terminal record.
7. Cutover: flip `terminal.spa` to `true` only after every acceptance test passes. Add terminal to
   the E2E allowlist before the flip as `${SPA_E2E_ROUTE_IDS},terminal`; after the flip the default
   registry enables it. Keep the legacy smoke.
8. Tests:
   - `test/ui/terminal-page.test.ts` (page composition, no page header, body class, stopped state);
   - `test/ui/terminal-loader.test.ts` (one script/CSS load, order, idempotent cache, failure retry,
     one `<link>` after first load and client navigation, no server duplicate);
   - `test/ui/terminal-socket.test.ts` (fake WebSocket: generation, exactly five retries and
     countdown, manual close, 1000/1001, 1011, runtime stopped, resize JSON, auth probe 401/403/200,
     no probe while hidden, dispose/stale callbacks);
   - `test/ui/terminal-workspace.test.ts` (workspace shell class/viewport apply/restore, focus host
     on connect, no `.page` reset);
   - `test/terminal-http.test.ts` (proxy/auth/contract cases unchanged; page-render cases remain as
     the legacy rollback smoke until Stage 9);
   - `test/ui/router-guard.test.ts` and `test/shared-routes.test.ts` extend terminal record/default
     and pre-cutover no-render assertions.
9. E2E:
   - `e2e/terminal.spec.ts` runs in `legacy` and `spa` modes: direct load renders legacy vs
     `TerminalPage` (never `NotImplementedPage`), client navigation from another SPA route,
     `router.push({ name: "terminal" })`, deep link, runtime stopped/running/error, connect/input/
     output, resize at multiple widths, copy, reconnect (exactly five then manual), manual close,
     normal exit, 1011, runner unavailable, auth expiry, teardown, off-set/`?legacy=1` full load,
     no SPA component with the flag false and no allowlist entry;
   - `e2e/spa-terminal.spec.ts` covers first-paint topbar (default IDE action, no mount flash), one
     vendor CSS link, no duplicate sockets/hosts, console/page-error zero, and rollback with
     `HANSE_UI_LEGACY=1`, `?legacy=1`, and allowlist removal.
10. Visual QA at 390/768/1024/1440 dark/light: toolbar/banner/host/stopped, theme change,
    reduced motion, on-screen keyboard width, skeleton/CLS. Evidence untracked.

### Acceptance criteria

- Connecting/live/reconnecting/countdown/paused/stopped/exited/closed/failed states match legacy
  except the recorded C9 retry bound.
- Copy, reconnect, close, resize, theme, reduced motion, runtime preflight, 401/403/404/503/502,
  normal exit 1000/1001, failure 1011, and app-stopped behavior are verified.
- No duplicate sockets on reconnect; one `#terminal-host`; xterm/observers/listeners/timers disposed
  on leave.
- Exactly one vendor CSS `<link>` after first load and after client navigation; no server duplicate.
- Auth expiry redirects to login with `next`; retries never loop.
- Direct SPA load, client navigation, and `router.push({ name: "terminal" })` render the page;
  off-set/`?legacy=1` full-document-loads; with `spa:false` and no allowlist no terminal component
  renders.
- Legacy terminal remains reachable as the rollback document.

### Gate commands

```bash
npm run lint
npm run typecheck
npm run typecheck:ui
npm run typecheck:e2e
npm test
npm run build
npm run check:sensitive
npm run check:ui
npm run test:e2e
git diff --check
```

### Commit checkpoint

One coherent Stage 2 commit only when the owner authorizes it. Suggested message:
`feat(ui): migrate the operator terminal to the SPA`.

### Legacy retention and rollback

Keep `renderTerminalPage`, `assets/terminal.js`, the vendor assets, and the `GET /terminal` handler
branch. Roll back with `?legacy=1`, `HANSE_UI_LEGACY=1`, or by removing `terminal` from
`HANSE_UI_SPA_ROUTES` until Stage 9.

---

## Stage 3 - Chat data foundation and read-only workspace

Stage 3 is complete only when 3A, 3B, and 3C have each passed their own gate. Each sub-gate lands
green before the next starts.

### Stage 3A - Event reducer, stores, and copy-first feed extraction

Goal: establish the pure chat data model from the legacy behavior without touching the legacy client.

Depends on: Stage 2.

#### Boundaries

In scope: `assets/chat-feed-store.js`, `ui/chat/feed-store.ts`, `event-reducer.ts`,
`state-actions.ts`, `chatFeed`/`chatContext`/`chatSession` stores, characterization/drift tests.

Out of scope: routing, DOM, network, components, the SSE adapter, and any edit to `assets/chat.js`.

#### Tasks

1. Copy the `createThreadStore` shape from `assets/chat.js:548` into the new plain-ESM
   `assets/chat-feed-store.js`. Preserve `sessionID`, `generation`, `turnGeneration`, `order`,
   `messages`, `activePromptID`, `queue`, `openParts`, `lastSeqByStream`, `currentStreamID`,
   `pendingDeltas`, and `agentStatus`. The copy imports nothing from `assets/chat.js`, `ui/`, or the
   server.
2. `ui/chat/feed-store.ts` is a typed re-export/wrapper over that copy; legacy code keeps its local
   function byte-frozen.
3. `ui/chat/event-reducer.ts` is pure: typed `HanseEvent` -> actions, sequence/gap decisions,
   per-session filtering, no DOM, no fetch, no timers. `ui/chat/state-actions.ts` applies actions to
   Pinia and returns render intents (dirty message/part ids, scroll intent, notice/toast, reconcile
   request).
4. Implement `ui/stores/chat-feed.ts`, `ui/stores/chat-context.ts`, and `ui/stores/chat-session.ts`
   with `shallowRef`/`markRaw` for large maps; no URL writes.
5. Implement the full event-to-slice map from design §4.5 and every `PartType` path, including the
   unknown-part reconcile path. `applySnapshot`, `deriveQueue`, `rekeyOptimistic`,
   `mergeFeedOrder`, `buildSessionTree`, `firstRootId`, and `ancestorIds` keep their existing
   semantics and modules.
6. Add the drift/freeze tests:
   - `test/fixtures/legacy-clients.sha256` pins `assets/chat.js` and `assets/terminal.js`; any edit
     fails `test/chat-legacy-freeze.test.ts`;
   - `test/chat-feed-store.test.ts` asserts the copy has the same shape and no `ui/` or legacy-client
     import;
   - `test/chat-event-reducer.test.ts` covers every `HanseEvent` and every `PartType`;
   - `test/chat-feed-parity.test.ts` replays `test/fixtures/chat-feed-characterization.json`
     against the copy and compares feed order, message/part maps, optimistic rekey, queue, and
     stream ids with the legacy recording.
7. Editing `assets/chat.js` in this stage is a gate failure, not an implementation detail. If a
   behavioral fix is required, land it in the new module first; editing the frozen file requires an
   explicit S2 exception in the stage journal and both fixtures updated.

#### Acceptance criteria

- Every reducer event/part test passes; no DOM/network in the reducer.
- The copied store and reducer reproduce the recorded feed/queue/status fixtures.
- The `chat.js`/`terminal.js` freeze test is green.
- No route, component, allowlist, or production page behavior change.

#### Tests and gate

New: `test/chat-feed-store.test.ts`, `test/chat-event-reducer.test.ts`,
`test/chat-feed-parity.test.ts`, `test/chat-legacy-freeze.test.ts`. Existing shared-contract
tests (`chat-core`, `chat-diff`, `chat-commands`, `markdown`, highlighting) are unchanged.

```bash
npm run lint
npm run typecheck
npm run typecheck:ui
npm run typecheck:e2e
npm test
npm run build
npm run check:sensitive
npm run check:ui
npm run test:e2e
git diff --check
```

Commit checkpoint (owner-authorized only): `feat(ui): add the chat feed reducer and copy-first store`.

#### Legacy retention and rollback

No route change. `assets/chat.js` remains frozen and authoritative. Rollback deletes the new
modules/tests; the legacy page is untouched.

### Stage 3B - Stream, route, and read-only shell

Goal: render a read-only SPA chat workspace driven by `route.query` and the SSE adapter.

Depends on: Stage 3A.

#### Boundaries

In scope: `ChatPage`, sessions rail, thread shell, basic text/tool/OMO rendering, `useChatStream`,
`useChatRouteState`, `/api/ui/chat` consumption, chat router record, chat topbar seed, read-only
states, and the test-only chat allowlist.

Out of scope: composer mutation, send/queue, prompts, attachments, commands, diffs/highlighting
beyond basic rendering, and the chat cutover.

#### Tasks

1. `ui/pages/ChatPage.vue` owns the runtime `.page__body page__body--chat` root and the interior
   `#chat-shell`/`#chat-scroll`; no `.page-header`; keyed by `appKey:projectId`.
2. `ui/components/chat/ChatSessionsRail.vue`, `ChatThread.vue`, `ChatMessage.vue`, `ChatScrim.vue`:
   boot skeleton, sessions rail, read-only thread, basic text/tool/OMO render, notices, empty/
   stopped/error/deletion-pending states.
3. `ui/chat/stream.ts` + `ui/composables/useChatStream.ts`:
   - `EventSource` on `/api/apps/:app/events?project=`; no token;
   - every `stream.ready` resets `streamID`/sequence, clears failures/limit pause, and rehydrates
     runtime/context/commands/notices/messages; `seq <= last` drops; a gap/resync is once per
     event; `stream.warning`/`message.part.omitted` resync and show a notice;
   - visible errors increment failures; hidden `onerror` sets Reconnecting without incrementing the
     client counter, probing, or scheduling an app-level retry (native reconnect may still occur);
   - at three visible failures, close, `Paused`, run one deduped `probeStreamLimit` with a 3 s
     `AbortController`; `429 stream_limit` pauses without looping; `401/403` runs the cookie-only
     `/api/ui/chrome?path=/chat` probe once per pause window with a 5 s cooldown, then redirects to
     `/login?next=` or stays Paused; other responses stay Paused with manual Retry;
   - `dispose()` clears handlers/timers/abort controller and ignores stale callbacks;
   - `pagehide`/`pageshow`/`beforeunload` and visibility follow design §4.6.
4. `ui/chat/useChatRouteState.ts` reads normalized `app`/`project`/`session` from `route.query`
   (string only; arrays/blank/unknown dropped). Exactly one watcher applies the query to stores.
   Session selection is a user action: increment generation, paint target shell, abort stale reads,
   flush the previous draft in the background, then `router.replace` the query. App switch flushes
   the draft, drops the old session/feed, and `router.push({ name:"chat", query:{app,project} })`.
5. `src/http/spa.ts`: serve chat props for `match.id === "chat"`; add chat `pageClass`/
   `bodyClass`/viewport/topbar seed; `chromeFor` uses chat hints; `recordOperatorHost` on the SPA
   path is guarded; `/api/ui/chat` is the client refresh path. `/api/ui/chat` carries no
   `initialSession`; `route.query.session` is the only initial session input.
6. `ui/router.ts`: register the lazy `/chat` record with `meta: { workspace: "chat",
   legacyRetired: false }`; route-table test starts enforcing it. Enable for E2E with
   `HANSE_UI_SPA_ROUTES=${SPA_E2E_ROUTE_IDS},chat,terminal`; the registry flag stays `false`.
7. Read-only scope: sessions, history, live stream, status, notices, empty/stopped/error states work;
   the composer is absent or a disabled shell. No send/mutation.
8. Tests:
   - `test/ui/chat-page-readonly.test.ts` (shell/body/no header, keyed remount, stopped/empty/error,
     deletion-pending banner);
   - `test/ui/chat-stream.test.ts` (fake EventSource: open/message/error/reconnect/pause/limit,
     every ready resets, hidden no-counter/probe/timer, auth probe 401/403/200, dispose, no
     duplicates);
   - `test/ui/chat-route-state.test.ts` (deep link, back/forward, rapid session switch last-wins,
     invalid-session canonicalization, agent-stopped/empty-session preservation, one navigation per
     action, no duplicate writer);
   - `test/ui/chat-sessions-rail.test.ts` and `test/ui/chat-thread-basic.test.ts`;
   - `test/ui/props-chat.test.ts` is not added; extend `test/ui-props-chat.test.ts` for the
     `/api/ui/chat` props shape and no `initialSession`;
   - extend `test/ui/router-guard.test.ts`, `test/shared-routes.test.ts`, and
     `test/ui/topbar-actions.test.ts` for the chat record and first-paint control set.
9. E2E: extend `e2e/chat.spec.ts` (legacy + SPA read-only) and `e2e/spa-chat.spec.ts` with direct
   load, client navigation, `router.push({ name:"chat" })`, off-set/`?legacy=1` full load, no-SPA
   with flag false/no allowlist, 30-message tail/older pages, stream.ready/seq/gap, visibility/
   online reconnect, hidden error, auth expiry, agent-stopped, unknown-app/no-app fallbacks, and no
   duplicate EventSource after 20 enter/leave cycles. Fixture-side stream count returns to baseline.
10. Visual QA: chat shell/rail/thread at 390/768/1024/1440 dark/light; first-paint topbar is the
    chat control set with zeroed counters and no default-IDE flash; skeleton/CLS.

#### Acceptance criteria

- Read-only chat renders and streams; every URL/back-forward/session-switch rule passes.
- No duplicate EventSource after 20 enter/leave cycles; counts return to baseline.
- Direct load/client navigation resolve to `ChatPage`, never `NotImplementedPage`; off-set/
  `?legacy=1` full-load; with the flag false and no allowlist no chat component renders.
- First-paint topbar is the chat set with zeroed counters; no flash.
- Legacy `/chat` remains the rollback document.

#### Tests and gate

```bash
npm run lint
npm run typecheck
npm run typecheck:ui
npm run typecheck:e2e
npm test
npm run build
npm run check:sensitive
npm run check:ui
npm run test:e2e
git diff --check
```

Commit checkpoint (owner-authorized only): `feat(ui): render the read-only chat workspace as an SPA`.

#### Legacy retention and rollback

Registry flag stays `false`; removal from the test allowlist is the rollback. Legacy
`renderChatPage`/`assets/chat.js` stay untouched.

### Stage 3C - Session tree, history paging, and read-only parity

Goal: complete read-only parity for navigation, session tree, history, and scroll.

Depends on: Stage 3B.

#### Boundaries

In scope: `buildSessionTree`/ancestor expansion, search/new/delete, full history paging, scroll
owner/anchors, the read-only state matrix.

Out of scope: composer/send, prompts, attachments, commands, cutover.

#### Tasks

1. Wire `buildSessionTree`/`firstRootId`/`ancestorIds` from `assets/chat-core.js`; parent/subagent
   nesting, orphan/cycle handling, active-ancestor expansion, search filtering, subtree delete
   cleanup, and parent wait aggregation.
2. Implement history paging (`limit=30`, opaque `before`), overlap-aware snapshot merge via
   `applySnapshot`, prepend-anchor preservation, and no duplicate messages.
3. Implement scroll ownership: `#chat-scroll` is the only chat scroll container; never `window`;
   pinned bottom, paused when scrolled up, RAF flush, "New messages" button, prepend anchor,
   back/forward restoration through the component.
4. Add `ui/chat/session-storage.ts` as the sole namespaced owner of queue-promotion suppression and
   image intent; clear on successful send, session delete, route leave, and app switch.
5. Tests:
   - `test/ui/chat-session-tree.test.ts` (nesting, orphan/cycle, active ancestors, search, delete
     cleanup);
   - `test/ui/chat-history.test.ts` (tail/older, overlap merge, no duplicates, cursor errors);
   - `test/ui/chat-scroll.test.ts` (pinned, paused, anchor, new-messages, route leave);
   - `test/ui/chat-session-storage.test.ts` (namespace isolation, clear paths);
   - E2E extends `e2e/spa-chat.spec.ts` with session tree/search/new/delete, paging while streaming,
     scroll scenarios, and the read-only visual/behavior parity report.

#### Acceptance criteria

- Session tree/orphan/cycle/delete behavior matches legacy.
- Paging has no duplicates; prepend anchor and follow-bottom behavior are preserved.
- Read-only parity report covers shell/rail/thread/empty/loading/error at all required widths.
- Stage 3 is not complete until 3A, 3B, and 3C all pass.

#### Tests and gate

```bash
npm run lint
npm run typecheck
npm run typecheck:ui
npm run typecheck:e2e
npm test
npm run build
npm run check:sensitive
npm run check:ui
npm run test:e2e
git diff --check
```

Commit checkpoint (owner-authorized only): `feat(ui): complete read-only chat session and history parity`.

#### Legacy retention and rollback

Route flag still `false`; remove the allowlist entry. Legacy chat remains fully reachable.

---

## Stage 4 - Chat composer, drafts, send, queue, abort

Stage 4 is complete only when 4A, 4B, and 4C have each passed.

### Stage 4A - Composer and drafts

Goal: port composer input, keyboard, resize, drafts, and the attachment shell state.

Depends on: Stage 3C.

#### Tasks

1. `ui/components/chat/ChatComposer.vue`: textarea, send/stop controls, attach button/file input,
   drag/drop/paste entry points, autosize, `aria-describedby`, error/disabled states.
2. `ui/composables/useChatComposer.ts` + `ui/stores/chat-composer.ts`: debounced draft save (500 ms),
   keepalive on hide, flush before switch/unmount, delete-if-empty, no cross-session leak.
3. Keyboard parity: Enter sends unless composing/coarse pointer/Shift; Ctrl/Cmd+Enter sends; Escape
   closes palette/prompt/queue/drawer in the legacy order; resize to content.
4. Tests:
   - `test/ui/chat-composer.test.ts` (keyboard, focus, autosize, disabled/stop states);
   - `test/ui/chat-draft.test.ts` (restore on switch/hide/unmount, keepalive, delete-if-empty,
     cross-session isolation);
   - `test/ui/chat-composer-shell.test.ts` (attachment shell refs without upload mutation).
5. E2E: extend `e2e/chat.spec.ts`/`e2e/spa-chat.spec.ts` with draft save/restore/delete-if-empty,
   switch/hide/unmount, composer focus with on-screen keyboard, coarse-pointer Send behavior.

Acceptance: draft restore/keepalive/delete-if-empty and focus/keyboard parity pass; no cross-session
draft leak.

Gate: full repository gate block plus E2E; `git diff --check`. Commit checkpoint (owner only):
`feat(chat): port the chat composer and drafts`.

### Stage 4B - Send and delivery

Goal: port optimistic send, delivery states, pending recovery, and auth expiry mid-send.

Depends on: Stage 4A.

#### Tasks

1. Wire send/stop to the existing `/api/apps/*` handlers (no API change): optimistic rows,
   `202`/blocking delivery, `unknown` grace, retry/remove, pending sends
   (`normalizePendingSends`/`pendingSendActions`), and `sending/accepted/queued/unknown/failed`.
2. Preserve the cross-site mutation guard and session lock behavior; no duplicate send after
   remount; auth expiry mid-send uses `ui/api.ts`/the chat adapter redirect with `next`.
3. Tests:
   - `test/ui/chat-send.test.ts` (optimistic send, accepted, blocking fallback, unknown + Check
     again/Remove, retry after reload, no duplicate after remount);
   - `test/ui/chat-pending.test.ts` (pending normalization/actions, delete/retry);
   - `test/ui/chat-send-auth.test.ts` (401 mid-send -> login with next; cross-site guard);
   - E2E send/stop and delivery recovery cases.

Acceptance: delivery state is truthful; optimistic reconciliation and pending recovery match
legacy; no duplicate send; auth expiry is handled.

Gate: full repository gate block plus E2E; `git diff --check`. Commit checkpoint (owner only):
`feat(chat): port optimistic send and delivery recovery`.

### Stage 4C - Queue and abort

Goal: port the queue strip/dialog, upstream queue derivation, and Stop/abort semantics.

Depends on: Stage 4B.

#### Tasks

1. Use `deriveQueue` unchanged for the queue strip and queue dialog; `Needs input` count is owned by
   the App-level topbar via `chatUi`.
2. Implement Stop/abort through the existing human-only abort handler; intentional-abort
   suppression; last-wins under rapid send/stop; queue-promotion suppression owner from Stage 3C.
3. Tests:
   - `test/ui/chat-queue.test.ts` (rows match `deriveQueue`, strip/dialog, promotion suppression,
     needs-input count);
   - `test/ui/chat-abort.test.ts` (Stop settles idle, intentional abort not an error, rapid
     send/stop last-wins);
   - E2E queue/stop scenarios in `e2e/spa-chat.spec.ts`.

Acceptance: queue rows match `deriveQueue`; Stop settles idle; intentional abort is not an error;
last-wins holds.

Gate: full repository gate block plus E2E; `git diff --check`. Commit checkpoint (owner only):
`feat(chat): port queueing and turn abort`.

---

## Stage 5 - Chat feed rendering parity

Stage 5 is complete only when 5A, 5B, and 5C have each passed.

### Stage 5A - Text, reasoning, tools, notices, OMO, handoff

Goal: complete the read/streaming feed renderers.

Depends on: Stage 4C.

#### Tasks

1. `MarkdownBlock.vue`: wrap `renderMarkdown(container, text)` like `SafeMarkdown.vue`;
   `replaceChildren()` then render; no `v-html`; throttle streaming renders to 50 ms and render once
   on seal/idle; tables use `parseMarkdownTable` (16 columns/200 rows cap).
2. Reasoning, tool output streaming, bash tail, notices, OMO/handoff cards, image gate/warning,
   generation row, and message count.
3. Tests:
   - `test/ui/chat-markdown.test.ts` (clear/no duplicate nodes, throttle, tables, adversarial text);
   - `test/ui/chat-message.test.ts` (text/reasoning/tool/step/patch/file/subtask/retry/compaction/
     snapshot/agent and unknown part);
   - `test/ui/chat-tools.test.ts` (tool output streaming, bash tail, structured fields);
   - `test/ui/chat-cards.test.ts` (OMO/handoff/notice/generation/image gate).
4. E2E: streaming text/tool/bash/table/OMO/handoff/notice; empty/oversized/truncated fixtures;
   zero console/page errors.

Acceptance: deterministic fixture parity for all 5A surfaces; Markdown clears and does not duplicate
nodes; no raw XML/HTML reaches the DOM; 50 ms throttle holds.

Gate: full repository gate block plus E2E; `git diff --check`. Commit checkpoint (owner only):
`feat(chat): port the streaming feed renderers`.

### Stage 5B - Diffs and highlighting

Goal: port diff/read/write views, caps, Prism worker usage, plain fallback, and teardown.

Depends on: Stage 5A.

#### Tasks

1. `ToolPart.vue` calls `extractToolView`; `DiffView.vue` uses `mountToolView`,
   `setToolViewOpen`, and `resetHighlightController`; `ReadView`/`WriteView` use structured fields
   and text nodes.
2. Add the additive `disposeHighlightController()` to `assets/chat-highlight.js`: increment
   generation, cancel contexts, call `terminateWorker()`, clear jobs/stats, reset module-level
   `stats.disabled = false`, leave `worker`/`workerPromise`/`resolveWorker` in initial state, and
   reset the per-controller generation. The only route-level teardown owner; components never call
   `worker.terminate()` directly.
3. Keep the worker/module URL and budgets; verify the Vite-built worker URL, same-origin allowlist,
   and the Stage 0 built-worker smoke.
4. Tests:
   - `test/ui/chat-diff-view.test.ts` (read/write/edit/apply_patch, caps 64 KiB/file, 128 KiB total,
     50 files, 2,000 lines, no raw XML);
   - `test/ui/chat-highlight-teardown.test.ts` (worker constructor/terminate counts, `readyTimer`
     cleared under fake timers, no jobs/contexts, `stats.disabled` reset, fresh mount highlights
     again);
   - `test/ui/chat-highlight-fallback.test.ts` (plain fallback, timeout/error, disabled state);
   - the built-worker evidence is the `check:chat-worker` gate; no duplicate build test is added.
5. E2E diff scenarios reuse the existing `chat-qa` diff fixtures; visual QA diffs/tables at
   390/1440 dark/light.

Acceptance: diff caps and plain fallback hold; no raw XML; worker/timer counts return to baseline
after unmount; built-worker smoke passes.

Gate: full repository gate block plus `npm run check:chat-worker`, E2E, visual QA;
`git diff --check`. Commit checkpoint (owner only): `feat(chat): port diff rendering and highlight
teardown`.

### Stage 5C - Scroll and performance

Goal: preserve long-thread scroll behavior and prove the performance budget.

Depends on: Stage 5B.

#### Tasks

1. Finish long-thread scroll: prepend anchor, new-messages button, pinned bottom, rAF flush, and no
   full-feed replacement per token.
2. Keep Markdown 50 ms, tool output 100 ms, rAF flush; no eager Prism/xterm.
3. Tests/traces:
   - `test/ui/chat-scroll.test.ts` extended with 500-message scenarios;
   - `test/ui/chat-perf.test.ts` for render counts/no full replacement;
   - E2E scroll scenarios at 390/1440 dark/light; 500-message/50-file perf trace and memory
     recorded; skeleton/CLS at 390/1440.
4. Measure the chat route chunk transfer and record it (target <= 250 KiB gzip including reused pure
   modules; Prism worker loads only on a diff). Record actual numbers in the stage journal and
   `docs/current-state.md` at cutover.

Acceptance: no full feed replacement per token; anchor preserved; perf trace and memory recorded;
visual QA and console/page-error zero; chunk target measured.

Gate: full repository gate block plus E2E/visual QA; `git diff --check`. Commit checkpoint (owner
only): `perf(chat): complete scroll parity and record feed budgets`.

---

## Stage 6 - Prompts, questions, permissions, SSH approvals, context rail

Stage 6 is complete only when 6A and 6B have each passed.

### Stage 6A - Questions, permissions, saved permissions

Goal: port the prompt dock, inline cards, permissions, and needs-input topbar count.

Depends on: Stage 5C.

#### Tasks

1. `ChatPromptDock.vue` + inline question cards: submit/reject, custom answers, expiry, correlation
   with the `question` tool part, auto-advance, focus moves to dock/composer, Ctrl/Cmd+Enter, no
   focus loss after answer.
2. Permissions: allow once/always/deny, risk/scope chips, saved permissions list/revoke, correlation/
   outcome/tombstones; replies to the existing permission handler.
3. Needs-input count is published to `chatUi` and rendered by the App-level `TopbarActions`; no
   per-route topbar copy.
4. Tests:
   - `test/ui/chat-prompts.test.ts` (question submit/reject/custom/expiry, focus, keyboard);
   - `test/ui/chat-permissions.test.ts` (allow once/always/deny, saved revoke, risk/scope, outcome);
   - `test/ui/topbar-actions.test.ts` extended (needs-input count ownership, default restore);
   - E2E questions/permissions/saved in `e2e/spa-chat.spec.ts`.

Acceptance: question auto-advance/custom/cancel/expiry, permission flows, focus, keyboard, and
topbar count all pass.

Gate: full repository gate block plus E2E; `git diff --check`. Commit checkpoint (owner only):
`feat(chat): port questions and permissions`.

### Stage 6B - SSH approvals, context, plan, previews, restart, policy

Goal: complete the context rail and app-level gates.

Depends on: Stage 6A.

#### Tasks

1. SSH approval polling/cards in `ChatContextRail` using the existing app-scoped API; approve/reject.
2. Context meter/compact confirm and `202`; plan/todo panel; handoffs rail; previews open/close;
   restart pending; policy warnings/chip; deletion-pending behavior.
3. Tests:
   - `test/ui/chat-ssh-approvals.test.ts` (polling, approve/reject, idle, no duplicate timers);
   - `test/ui/chat-context-rail.test.ts` (context/compact, plan/todo, handoffs, previews, restart,
     policy chip);
   - `test/ui/chat-policy.test.ts` (warnings/chip, hidden when empty, topbar interaction);
   - E2E question/permission/context/preview/restart in `e2e/spa-chat.spec.ts`; visual QA rail at
     1360 breakpoint plus 390/768/1024/1440 dark/light.

Acceptance: SSH approve/reject, context compact `202`, plan panel, previews, restart pending, and
policy chip parity pass; polling cleans up on unmount.

Gate: full repository gate block plus E2E/visual QA; `git diff --check`. Commit checkpoint (owner
only): `feat(chat): port context rail, approvals, and previews`.

---

## Stage 7 - Attachments, slash commands, full parity, chat cutover

Stage 7 is complete only when 7A, 7B, and 7C have each passed. Stage 7C is the cutover gate; Stage 7
alone is not the parity safety net.

### Stage 7A - Attachments

Goal: port attachment upload/transport/quota state and rendering.

Depends on: Stage 6B.

#### Tasks

1. `ChatAttachments.vue` and `ui/stores/chat-composer.ts`: XHR upload with progress/abort, max 10
   files / 100 MiB, two concurrent uploads, drag/drop, paste, attach button/file input, chips,
   retry/remove, inline/file mode, quota warning, send payload, redelivery after reload.
2. Inline image/video/PDF and file-only rendering use the existing server projections; no new API.
3. Tests:
   - `test/ui/chat-attachments.test.ts` (limits, concurrency, progress/abort/retry, quota, chips,
     inline/file, payload);
   - `test/ui/chat-attachments-drop.test.ts` (drag/drop/paste, no orphan object URLs after unmount);
   - E2E upload/drop/paste/progress/cancel/retry/inline/file/quota in `e2e/spa-chat.spec.ts`.

Acceptance: 10 files/100 MiB, two concurrent uploads, progress/cancel/retry, inline/file, quota,
payload, drop/paste, redelivery, no orphan upload/object URL.

Gate: full repository gate block plus E2E; `git diff --check`. Commit checkpoint (owner only):
`feat(chat): port attachments and upload recovery`.

### Stage 7B - Slash commands and remaining context/app menu

Goal: port the command palette and the remaining menu surface.

Depends on: Stage 7A.

#### Tasks

1. `ChatCommandPalette.vue`: catalog/filtering/slash detection, shell `present` confirmation,
   unknown confirmation, Hanse-only degradation when stopped, `202`, error handling, keyboard/focus.
2. Port the remaining context/app menu surface not already covered in Stage 6 (app switch, project/
   handoff/IDE links, session actions that were not in the read-only rail).
3. Tests:
   - `test/ui/chat-commands.test.ts` (catalog/filter/slash detection/present/unknown/stopped/202/
     error/keyboard);
   - `test/ui/chat-app-menu.test.ts` (app switch flush + remount, links, focus);
   - E2E slash palette/filter/shell confirmation and app menu.

Acceptance: command catalog/filtering/confirmation and app/context menu parity pass, including
keyboard/focus and degraded states.

Gate: full repository gate block plus E2E; `git diff --check`. Commit checkpoint (owner only):
`feat(chat): port slash commands and app menu`.

### Stage 7C - Full parity audit and chat cutover

Goal: audit every event/part/behavior against the design and cut `/chat` over.

Depends on: Stage 7B.

#### Tasks

1. Run the parity audit against design §2, §4.5, and Stage 3-6 sub-gates:
   - every `HanseEvent` from design §4.5 is ported and tested;
   - every `PartType` plus the unknown reconcile path is ported and tested;
   - every behavior in §2 and §7 has a component/unit/E2E or recorded manual check.
2. Verify no duplicate DOM/listeners/sockets/workers/timers after 20 enter/leave cycles and
   app/session switches; verify back/forward/deep-link/refresh/auth-expiry/logout; mobile drawers;
   390/768/1024/1440 dark/light.
3. Measure the chat route chunk; entry budget unchanged; no eager Prism/xterm; skeleton/CLS no worse
   than the recorded legacy threshold.
4. Flip `chat.spa` to `true`. Keep `legacyRetired:false`. Update `docs/current-state.md` and the
   journal.
5. Freeze policy: after cutover, `renderChatPage` and `assets/chat.js` receive no new behavior; fixes
   land in Vue. The legacy page stays the rollback document and keeps one smoke/E2E test.
6. Tests:
   - `test/chat-parity.test.ts` (event/part coverage matrix from the inventory; fails on a missing
     row);
   - `test/ui/chat-runtime-resources.test.ts` (20 cycles: listener/socket/worker/timer counts return
     to baseline);
   - `test/ui/chat-auth.test.ts` (401 from reads/mutations, SSE probe, send probe, logout);
   - E2E `e2e/chat.spec.ts`/`e2e/spa-chat.spec.ts` complete matrix from design §6.3; rollback drill;
   - bundled transfer/CLS report.

Acceptance: every cutover-gate item passes; chat is SPA by default; legacy chat remains reachable
and frozen as the rollback document; operator rollback stays live until Stage 8 sign-off.

Gate:

```bash
npm run lint
npm run typecheck
npm run typecheck:ui
npm run typecheck:e2e
npm test
npm run build
npm run check:sensitive
npm run check:ui
npm run check:chat-worker
npm run test:e2e
git diff --check
```

Commit checkpoint (owner only): `feat(ui): cut chat over to the SPA`.

#### Legacy retention and rollback

Keep `renderChatPage`, `assets/chat.js`, all shared modules, and the `GET /chat` page branch until
Stage 9. Roll back with `?legacy=1`, `HANSE_UI_LEGACY=1`, or by removing `chat` from the allowlist
until Stage 8 sign-off.

---

## Stage 8 - Deployment-host operator verification gate (no cleanup)

Goal: deploy the post-cutover image and obtain explicit operator sign-off of the full chat/terminal
surface on the deployment host. This is an explicit sign-off, not a soak. No cleanup happens here.

Depends on: Stage 2 and Stage 7C complete; every local gate green on the image commit.

### Boundaries

In scope: local gate confirmation, image/build identity check, deploy handoff, deployment-host
checklist, live rollback confirmation, sign-off record.

Out of scope: any code change, any legacy deletion, any route-flag retirement, and any commit that
is not the owner-authorized deploy record.

### Preconditions

1. Both registry flags are `true`; both routes are SPA by default.
2. All local gates are green, including `npm run build` (which runs `build:ui`), `check:ui`,
   `check:chat-worker`, and `test:e2e`.
3. The image contains `assets/ui/*`, the UI manifest, the SPA entry, the chat/terminal route
   chunks, and the built Prism worker. A checkout/image without a UI build is **not deployable**.
4. The deploy target, command, and previous rollback image tag are known from
   `docs/deploy/README.md` if it exists; otherwise the owner/deploy agent supplies them now. Never
   invent a host, path, port, or credential.

### Tasks

1. Record the local gate result and the exact image identity (tag, digest, commit SHA) in the
   untracked deploy record with placeholders. Run `git diff --check`.
2. Hand off to the deploy agent/operator **only after** local gates pass. The handoff includes:
   image reference and digest, commit SHA, the requirement that `npm run build` ran, the previous
   image tag for rollback, and the instruction to preserve the deployment lock/quiescence procedure.
3. Deploy. Do not change chat/terminal runtime flags for the normal deploy; both routes must be SPA
   by default. Do not run cleanup in this stage.
4. Deployment-host checklist (minimum; use `<PROJECT_ID>`/`<SESSION_ID>` placeholders in tracked
   notes, real values only in untracked evidence):
   - **Chat:** open/deep-link/refresh/back-forward; sessions list/tree/search/new/delete/switch while
     streaming; streaming text/tool/bash/table/diff/write/read/OMO/handoff/notice; send/stop/queue/
     pending/retry/drafts; questions/permissions/saved/SSH approvals; attachments upload/drop/paste/
     inline/file/quota; slash commands; context/compact/plan/previews/restart; reconnect/visibility/
     auth expiry; mobile widths and dark/light.
   - **Terminal:** open/deep-link; stopped/running/error runtime; connect/input/output/copy/reconnect/
     close; resize at multiple widths; normal exit/failure; theme/reduced motion; auth expiry;
     mobile/desktop.
   - **Both:** first load and client navigation on the deployed image; SPA chunks present; no
     console/page errors; no duplicate panels/messages; no duplicate vendor CSS; one topbar action
     set; no default-IDE flash; 390/768/1024/1440 dark/light.
5. Confirm rollback is live on the deployment host:
   - `?legacy=1` on both routes renders the legacy document;
   - the documented `HANSE_UI_LEGACY=1` and `HANSE_UI_SPA_ROUTES` rollback paths are available and
     executable. If a restart drill would disrupt the operator, record explicit owner acceptance
     instead of performing it.
6. Obtain explicit operator sign-off: date, operator, image identity, checklist result, rollback
   availability, and any accepted issues (placeholders for host-specific values). Record it in
   journal 0039 and the untracked deploy record.
7. Stop. Do not create a cleanup commit. Stage 9 is blocked until the owner separately instructs
   cleanup.

### Acceptance criteria

- The deployed image serves both routes as SPA by default with all chunks present.
- The full operator checklist is signed off on the deployment host.
- No console/page errors, no duplicate DOM/SSE/WS/vendor CSS/topbar sets.
- Both runtime rollback paths remain live until sign-off.
- The sign-off record exists; no legacy code was deleted.

### Gate commands

Local gates must be green before the handoff (repeat the Stage 7C block plus `git diff --check`).
Deployment verification uses the deploy runbook and the checklist above; its evidence is untracked.

### Commit checkpoint

No code commit. If the owner authorizes the process exception, one docs-only deploy record commit
with placeholders may follow the code commit. The cleanup commit is not authorized by Stage 8.

### Legacy retention and rollback

Full legacy retention: renderers, scripts, shared modules, assets, and page-HTML tests stay. Runtime
rollback remains live. The pre-cutover image is also available as an image rollback.

---

## Stage 9 - Legacy cleanup and rollback retirement

Goal: delete only the legacy page implementation after Stage 8 sign-off and an **explicit owner
instruction**, and retire the runtime flags for the two routes. Not a contract change.

Depends on: Stage 8 sign-off recorded and explicit owner cleanup instruction recorded in journal
0039. If either is missing, stop; do not start this stage.

### Boundaries

In scope: deleting legacy page renderers/page clients/page-only helpers/tests/assets, setting
`legacyRetired:true`, static shell-only entry/error pages, retired-flag matrix, image-rollback
runbook and mandatory UI-build/deploy check.

Out of scope: `/api/apps/*` handlers, SSE, attachments, start, terminal proxy/upgrade, the six shared
modules, `app.js`/`app-content.js` needed by `/login`, database changes, and any new feature.

### Tasks

1. Set `legacyRetired: true` on both route definitions. Implement design §4.13 in
   `isSpaRoute`/`maybeServeSpa`:
   - `isSpaRoute` checks `legacyRetired` before `HANSE_UI_LEGACY` and the allowlist unless the
     caller explicitly passes `manifestValid:false`;
   - `maybeServeSpa` applies the `?legacy=1` early return only to non-retired routes;
   - a retired route never returns `undefined`; when `devUrl` is unset and the UI manifest is
     missing it returns the explicit `503` `text/html` "UI build missing" page
     (`contentScript:false`), otherwise the normal SPA document.
2. Implement the retired entry/error semantics inside `maybeServeSpa` **before** the manifest/503
   branch, and keep `humanFromCookie` before them:
   - `/chat` without `app` -> `302` to the first operator application;
   - zero applications -> `200` static shell-only no-apps entry page from `renderNoApps` with
     `contentScript:false` (no `app-content.js`, no chat client);
   - unknown chat app -> styled `404` via `renderNotFound(..., contentScript:false)`;
   - `/terminal` with missing/unknown `app`/`project` -> the same shell-only styled `404`.
3. Delete the legacy implementation only:
   - `src/http/chat.ts`: `renderChatPage`, `renderContextHandoffs`, `appOptions`,
     `renderPreviewRows`, `renderPreviewSection`, the `GET /chat` page branch, and every other
     chat-page-only helper found by the Stage 9 inventory. Keep all `/api/apps/*` handlers,
     `handleStart`, attachment upload/download, SSE, and `renderNoApps` as the static entry page.
   - `src/http/terminal.ts`: `renderTerminalPage` and any terminal-page-only helper extracted for it.
     Keep `proxyTerminalUpgrade` and the upgrade dispatch.
   - `src/http/handler.ts`: the legacy `GET /terminal` branch, the `renderTerminalPage` import, and
     the `/assets/chat.js` and `/assets/terminal.js` allowlist entries.
   - `assets/chat.js` and `assets/terminal.js`.
   - Legacy-only HTML tests: retire the page-rendering cases in `describe("chat page")` and
     `describe("chat previews rail")` in `test/chat-page.test.ts`, plus
     `describe("operator terminal page")` in `test/terminal-http.test.ts`. Keep
     `describe("abort route")`, `describe("paged message list route")`,
     `describe("read routes attach to the running agent")`, `describe("async chat send")`,
     `describe("start route")`, the shared-module asset/highlight-worker cases, the terminal layout
     styles, the WS proxy tests, and `test/vendor-xterm.test.ts`. Replace the retired page cases with
     SPA entry/error tests before deleting them.
   - Legacy-only CSS selectors only after proving nothing else uses them; the chat/terminal classes
     the Vue pages use stay.
4. Keep exactly:
   - all `/api/apps/*` chat handlers, SSE, attachment upload/download, start, and the terminal
     proxy/upgrade;
   - all six shared modules at their current paths;
   - `assets/chat-feed-store.js` (now the sole feed store);
   - `renderNoApps` as the static shell-only zero-application entry page and `renderNotFound` as the
     shared styled 404 with the new `contentScript?: boolean`;
   - `app.js`/`app-content.js` needed by `/login` or any remaining legacy page.
5. Remove or replace every chat/terminal `?legacy=1` fallback link:
   - chat/terminal error and terminal engine-unavailable states;
   - `NotImplementedPage`'s classic-interface link;
   - `renderSpaDocument`/`ui/main.ts` fallback links become route-aware
     (`legacyAvailable`/`fallbackHref`): retired routes emit Reload/Back, non-retired routes keep
     the shared fallback.
6. Add the retired-flag matrix test `test/retired-routes.test.ts` for both routes:
   `HANSE_UI_LEGACY`/`?legacy=1`/allowlist combinations from design §4.13 must return `200` SPA,
   never the legacy document or the JSON/terminal `404`; missing manifest -> `503` HTML;
   `HANSE_UI_DEV_URL` -> dev SPA; `manifestValid:false` -> `503` and no deleted branch. Add the
   entry/error matrix (no app 302, zero apps shell-only 200, unknown app 404, terminal missing/
   unknown 404) under the same flag combinations.
7. Extend `test/shared-routes.test.ts`, `test/ui/router-guard.test.ts`, and
   `test/ui/spa-routes.test.ts` for `legacyRetired:true` and ignored `?legacy=1`; update the boot
   fallback tests for Reload/Back.
8. Update docs and indexes:
   - `docs/current-state.md`: both routes are SPA; post-cleanup rollback is image rollback only;
   - `docs/deployment.md`: UI rendering modes, retired flags, mandatory UI build, image-rollback
     procedure, and first-load/client-navigation deploy check;
   - `docs/deploy/` runbook if it exists (untracked; never force-add);
   - `docs/design/README.md` and `docs/plans/README.md` status;
   - `docs/journal/0039-chat-terminal-migration.md` record and `docs/journal/README.md`.
9. Post-cleanup readiness: the image builds the UI, `assets/ui/*` and the SPA entry are present,
   both routes pass first load + client navigation, the retired-flag matrix returns SPA/503 (never a
   deleted-page 404), and a previous image is available for rollback. Failure means cleanup is not
   complete.

### Acceptance criteria

- No legacy chat/terminal renderer, page client, page-only helper, page-only test, or page-client
  asset remains.
- No API/service/SSE/WS/attachment/start contract was removed or changed.
- The six shared modules and the additive feed store remain at their current paths.
- `legacyRetired` precedence, `?legacy=1` ignoring, never-`undefined`, and the `503` missing-build
  page pass the matrix for both routes.
- Entry/error pages are static shell-only pages with no `app-content.js` and no chat/terminal client.
- All fallback links are route-aware; no `?legacy=1` link remains for chat/terminal.
- Full gates, E2E, visual QA, and sensitive scan are green; the deployed image check passes.

### Gate commands

```bash
npm run lint
npm run typecheck
npm run typecheck:ui
npm run typecheck:e2e
npm test
npm run build
npm run check:sensitive
npm run check:ui
npm run check:chat-worker
npm run test:e2e
git diff --check
```

### Commit checkpoint

One cleanup commit **only** with the explicit owner cleanup instruction, containing code + tests +
docs + record for this stage. Suggested message:
`refactor(ui): remove the legacy chat and terminal page clients`.
The pre-cleanup image is the rollback artifact.

### Legacy retention and rollback

After cleanup there is no runtime flag rollback for chat/terminal. The only rollback is an image
rollback to the last image containing the legacy pages, preceded by the mandatory UI-build check.
Never deploy a post-cleanup image that lacks `assets/ui/*`; it will serve the explicit 503 for
these routes and is a failed deploy.

---

## Stage record (every stage)

Each stage ends with a record before the next starts:

1. Append a dated section to `docs/journal/0039-chat-terminal-migration.md`: stage/sub-gate, commit
   SHA if any, files changed, gates run, E2E/visual/perf evidence location (untracked), deviations
   (including the C9 terminal retry bound and any S2 exception), open threads, next stage.
2. Update the status line of this plan and the `docs/plans/README.md` entry.
3. Update `docs/current-state.md` when a rendering mode, route flag, rollback contract, or operator
   behavior changes (Stages 2, 7C, 9).
4. Update `docs/design/README.md` when a design status changes.
5. Keep evidence in untracked `docs/deploy/` or the workspace; use placeholders.

## Traceability

Every design blocker/decision has a plan task and gate. "A" = design §1.5 amendment; "R" = review
round.

| Design item | Plan location | Evidence gate |
| --- | --- | --- |
| Q1 Option C, no legacy island end state | Stages 3-7, cross-stage invariant, Stage 9 deletion | `test/chat-parity.test.ts`, Stage 7C E2E, Stage 9 no-legacy grep |
| Q2 client-side navigation, no S4 exception | Stage 1 guard/SmartLink, Stage 2/3B route records, `e2e/*spa*` | router-guard tests, E2E client-nav tests |
| Q3 keep six shared modules | File manifest, Stage 3A copy-first, Stage 9 keep list | Stage 9 diff review + `test/vendor-xterm.test.ts`, shared-module tests |
| Q4 app switch `router.push` + keyed remount | Stage 3B route state, Stage 3C/4A draft flush | `test/ui/chat-route-state.test.ts`, E2E app switch |
| Q5 preserve `/chat` no-app 302 | Stage 1 legacy fallthrough, Stage 9 entry semantics | `test/retired-routes.test.ts`, entry/error matrix |
| Q6 no new dependency, Vite may bundle | Stage 0 worker smoke, Stage 2 loader, Stage 5B | `check:chat-worker`, `test/ui/terminal-loader.test.ts` |
| A1 `matchPage` matches chat/terminal | Stage 1 routes/tests | `test/shared-routes.test.ts` |
| A2 no default-enabled legacy island, replacement allowlist | Stage 1 no allowlist, Stage 2/3B full-set allowlist, Stage 7C cutover | E2E stage-specific allowlists, pre-cutover no-render tests |
| A3 vendored xterm CSS exception, one owner | Stage 1 shell inputs, Stage 2 `TerminalView` loader | `test/ui/terminal-loader.test.ts`, one-link E2E |
| A4 no S4 workspace exception | Stage 1 guard, Stage 2/3B records | router-guard/E2E full-load tests |
| A5 shared modules stay, feed store is additive | Stage 3A copy rule, Stage 9 keep list | freeze/drift tests, Stage 9 review |
| A6 S9/S12 rollback lifecycle narrowed | Stage 8 live rollback, Stage 9 `legacyRetired`/503 | retired-flag matrix, deploy check |
| A7 S10 scope narrows to chat/terminal | Cross-stage scope, Stage 9 leaves IDE/preview | file manifest, route tests |
| A8 S13 page-HTML test lifecycle | Stage 0 keeps page tests, Stage 9 retires only legacy page cases | Stage 9 test map |
| R1-B1 rollback vs cleanup | Stage 8 gate, Stage 9 retirement | `test/retired-routes.test.ts`, Stage 8 rollback drill |
| R1-B2 topbar ownership | Stage 1 persistent `TopbarActions`, main clears seed, Stage 2/3B fallback | `test/ui/topbar-actions.test.ts`, first-paint E2E |
| R1-B3 URL single owner | Stage 3B `useChatRouteState`, one watcher, router actions | `test/ui/chat-route-state.test.ts` |
| R1-B4 approved-design amendments | Stage 0 `spa-migration.md` amendment record | doc review at Stage 0 gate |
| R1-B5 Option C cost/stage size | Stage 0 inventory, Stage 3A/3B/3C/4A-C/5A-C/6A-B/7A-C sub-gates | per-sub-gate exits |
| R1-B6 highlight teardown | Stage 5B `disposeHighlightController`, C10 | `test/ui/chat-highlight-teardown.test.ts` |
| R1-B7 SSE/WS auth expiry | Stage 2 socket probe, Stage 3B stream probe | `test/ui/terminal-socket.test.ts`, `test/ui/chat-stream.test.ts` |
| R1-B8 `recordOperatorHost` | Stage 1 `maybeServeSpa` + `/api/ui/chat` guarded call | `test/ui-props-chat.test.ts` |
| R1-B9 shell gaps (bodyClass, vendor CSS, hints, focus) | Stage 1 `useWorkspaceShell`/`fetchChrome`/`focusMain`, Stage 2 loader | `test/ui/workspace-shell.test.ts`, `test/ui/useChrome.test.ts` |
| R2-B1 client router/allowlist path | Stage 1 boot `spaRoutes`/guard/SmartLink, Stage 2/3B records | boot/guard/SmartLink/direct-load tests |
| R2-B2 post-cleanup 404 | Stage 9 `legacyRetired`, ignored `?legacy=1`, never `undefined`, 503 | retired-flag matrix + entry/error matrix |
| R2-B3 Stage 3A legacy break | Stage 3A copy-first, no edit/import, freeze/drift | `test/chat-legacy-freeze.test.ts`, copy-import test |
| R2-B4 amendments incl. S10/S13 | Stage 0 record, Stage 9 test map | doc review + Stage 9 gate |
| R3-B1 static shell-only entry/error | Stage 9 `renderNoApps`/`renderNotFound` `contentScript:false` | entry/error matrix asserts no `app-content.js`/chat client |
| R3-B2 replacement allowlist / `SPA_E2E_ROUTE_IDS` | Stage 0 route-ids helper, Stage 2/3B/7C E2E | config assertion + E2E suites |
| R4-B1 topbar duplicate action set | Stage 1 main `replaceChildren` before mount, one seed | node-count/id test, first-paint E2E |
| R4-B2 `renderNotFound` contentScript | Stage 1 `shell()` forwarding, Stage 9 `contentScript?` | entry/error matrix |
| Round-5 note: forward `contentScript` through `shell()` | Stage 1 task, Stage 9 use | `test/ui/shell-scripts.test.ts` |
| Round-5 note: boot topbar seed for every SPA route | Stage 1 `renderSpaDocument` boot topbar | boot test + topbar test |
| Round-5 note: `humanFromCookie` before entry semantics | Stage 9 `maybeServeSpa` order | entry/error matrix auth cases |
| Round-5 note: 503 page `contentScript:false` | Stage 9 missing-build branch | `test/retired-routes.test.ts` |
| C3 single URL owner | Stage 3B/3C/4A | `test/ui/chat-route-state.test.ts` |
| C9 bounded terminal retries | Stage 2 socket, cross-stage deviation record | `test/ui/terminal-socket.test.ts` (exactly five) |
| C10 teardown | Stage 2 terminal, Stage 3B stream, Stage 5B highlight, Stage 7C cycles | resource-count tests |
| S9/S12 pre/post-cleanup | Stage 8/9, rollback rules | Stage 8 drill + Stage 9 matrix |

## Risks and mitigations

| Risk | Severity | Mitigation |
| --- | --- | --- |
| Chat regression across 14k legacy lines | High | Option C vertical slices; Stage 0 inventory; per-slice characterization; rollback every stage; Stage 8 operator gate. |
| Duplicate SSE/WS/DOM/listeners/workers | High | One owner per resource; keyed remount; `dispose()`; 20-cycle resource-count tests; fixture connection counts. |
| Fixture cannot drive real SSE/WS deterministically | High | Stage 0 hard gate: fake opencode/runner upstream through the real `createHttpServer`; no Docker/opencode. |
| Feed-store copy drifts from frozen legacy | Medium | Copy-first, no edit/import, freeze hash, characterization fixtures, Stage 9 sole-owner promotion. |
| Topbar first-paint flash or duplicate set | Medium | Boot seed for every SPA route; one pre-mount clear; persistent App-level component; node-count/CLS tests. |
| URL/router divergence | Medium | `route.query` sole source; one watcher; back/forward/session/app-switch tests; one navigation per action. |
| Allowlist replacement semantics silently disable SPA routes | High | `SPA_E2E_ROUTE_IDS`; full-set-plus-route values only; config/tests forbid bare `=chat`/`=terminal`. |
| xterm vendor globals/CSS duplication/worker URL under Vite | Medium | One `TerminalView` loader; no server CSS; built-worker smoke; one-link E2E. |
| Highlight worker/`readyTimer` leak or permanent disable | Medium | `disposeHighlightController` resets `stats.disabled` and generation; worker/timer count tests. |
| Post-cleanup flag reaches a deleted branch | High | `legacyRetired` precedence; ignore `?legacy=1`; never `undefined`; 503 HTML; matrix test. |
| Cleanup before verification | High | Stage 8 sign-off + explicit owner instruction are hard preconditions; no cleanup commit before. |
| Deployment input missing (host/command/rollback image) | Medium | Stage 8 precondition; use untracked `docs/deploy/README.md` or owner/deploy-agent input; never invent. |
| Test suite runtime growth | Medium | Component tests in existing projects; E2E separate job; no Docker in unit suite. |

## Open questions

Design §11.2 has **none**. Q1-Q6 are closed and this plan does not reopen them.

Operational input O1 (not a design fork): Stage 8 needs the deployment host command/runbook and the
previous rollback image tag. If `docs/deploy/README.md` exists it is authoritative; otherwise the
owner/deploy agent supplies them before the Stage 8 handoff. Until then, Stage 8 cannot start.

No other plan item is underspecified. If implementation exposes a genuinely new owner-level fork, it
must be added to design §11.2 and closed before the affected stage; it must not be smuggled into a
stage as an assumption.

## Final verification commands

```bash
npm run lint
npm run typecheck
npm run typecheck:ui
npm run typecheck:e2e
npm test
npm run build
npm run check:sensitive
npm run check:ui
npm run check:chat-worker
npm run test:e2e
git diff --check
```

Additional evidence required at the final gate:

- `CHAT_QA_MODE=legacy` and `CHAT_QA_MODE=spa` chat scenarios both pass, with screenshots and JSON
  reports in untracked `artifacts/chat/` or `docs/deploy/`.
- Terminal E2E + visual QA at 390/768/1024/1440 dark/light.
- Retired-flag and entry/error matrices pass for both routes (Stage 9).
- Chat/terminal chunk transfer, skeleton/CLS, and the chat route budget are recorded.
- No `v-html`, no SFC `<style>`, no `assets/chat.js`/`assets/terminal.js` edit before Stage 9, no
  legacy island on a default-enabled route.
- `git status --short` contains only the stage's intended files; no secret or host-specific
  artifact is tracked.

## Review history

- 2026-10-30 - plan revision 1 authored from the approved design (`oracle` round 5 PASS) at HEAD
  `0c290de`. Awaiting `momus` plan review. No implementation, route flag, legacy deletion, commit,
  or push has occurred.
- 2026-10-30 - **`momus` plan review: OKAY.** References and anchors verified; every stage has
  executable tests/E2E/visual-QA scenarios. Stage 8's deployment-host input is explicitly
  owner-supplied and does not block earlier stages. Plan approved; implementation starts at Stage 0.

