# Plan 0040 - Client-owned application chrome

Status: **approved** - Momus round 3 PASS; minor notes folded in revision 4; design §10 amendment
Oracle PASS. Implementation permitted.
Design: [`docs/design/client-owned-chrome.md`](../design/client-owned-chrome.md) (approved,
Oracle round 7 PASS; §10 auth-probe amendment pending targeted review).
Owner decisions: depth B (remove endpoint + SPA server HTML chrome), first paint A (static shell),
sidebar all Vue, counters B (visibility refetch), deploy A (hard cutover); `/login` SSR out of scope.
Mode: **B** - intentional internal `/api/ui/*` contract change.
Baseline: commit `8748ae6`; the only pre-existing untracked file is
`recovered-plugin-draft-2026-11-04.txt` (the design/plan docs are this stage's artifacts). Baseline
gates green: lint, typecheck, typecheck:ui, 3,637 tests, build, check:ui, check:sensitive, 130 E2E
passed / 1 skipped.

## Goal

Remove `GET /api/ui/chrome` and every server-rendered chrome HTML fragment from SPA documents.
`ChromeData` becomes data-only; Vue renders the sidebar, breadcrumb, title, counters, theme, drawer,
and sign-out. No release serves both the old HTML-fragment and the new data shape.

## Non-goals

- `/login` SSR, its no-JS form, and the legacy `GET/POST /login` handlers.
- The legacy `appShell()` fallback/error documents.
- A static `ui/index.html`, a separate boot endpoint, or moving the icon sprite into Vue.
- Chat/terminal protocol, auth, SSE, WebSocket, IDE, preview, or database changes. The only probe
  change is the `/api/ui/chrome` -> `/api/ui/auth` replacement in design §10.

## Steps

Each step is a logical transformation with a reviewable diff. Step 2 is deliberately one large
unit: the server data shape, static document, Vue chrome, and their tests cannot be half-applied
without leaving the tree red. Run the listed verification after each step; revert a failing step.

### Step 1 - Shared route identity

Files: `src/shared/routes.ts`, `test/shared-routes.test.ts`.

- Add pure `routeKey(id, params, query)` with the approved canonical form: sorted keys, last value
  for repeated query keys, drop `null`/`undefined`, keep empty strings, exclude `legacy`, `notice`,
  `tone`, and `session`, stable serialization.
- Add unit tests for params, repeated values, arrays, null/empty, excluded keys, and stability.

Verification: `npx vitest run test/shared-routes.test.ts`, `npm run typecheck`, `npm run lint`.

Rollback: revert the two files; no production behavior changes.

### Step 2 - Contract, static shell, auth probe, and client cutover

This is the single intentional contract/document cutover. It must be applied as one unit.

Server:

- `src/http/spa.ts`: replace `ChromeProps`/`ChromeData.chrome` with data-only `ChromeData`; make
  `chromeFor()` return it; filter non-master projects; add `masterHref`; keep title/breadcrumb/
  scoped hrefs/counters.
- Add `BootPayload.routeKey` and optional `BootPayload.operator`; `renderSpaDocument()` and
  `renderLoginSpaDocument()` emit them (login uses empty `ChromeData` and the full-request
  `routeKey`).
- Page endpoints return `{ ...props, chrome: ChromeData }`.
- Delete the `/api/ui/chrome` branch and its `UI_API_PATHS` entry.
- Add `GET /api/ui/auth`: cookie-only, `204` when authorized (a no-body response helper, not
  `jsonResponse`), existing `401`/`403` otherwise, `Cache-Control: no-store` (including the
  agent-token `403`; add it if `agentForbidden()` does not set it), not version-gated (design §10).
  Handle it before the `UI_API_PATHS` membership check (or add it to that set) and immediately after
  `authorizeUiRead`, before `logUnknownRoutes`/`buildSite`, so the dispatcher reaches it without
  building the site; explicitly exempt it from the Step 3 version gate. Test it with a raw request
  that does **not** send `X-Hanse-UI-Version`.
- Add `spaShell()` with empty `#sidebar`/`#breadcrumb-host`/`.topbar__actions` containers, static
  nav toggle/scrim, `pageClass`/`bodyClass`/`viewport` (via `pageClasses()`), skip link,
  route announcer, hidden `#ui-fallback`, and `#toast-region`.
- Add `documentPage({ shellScript })`; SPA documents pass `false`; SPA login and legacy/fallback
  documents keep `app.js`.
- Remove the server chat topbar seed, `renderChatTopbarActions`, `topbarActions` input,
  `clearTopbarActions`, and `ui/topbar.ts`; keep `BootTopbar` data for `TopbarActions.vue` first
  paint after mount.
- Keep `appShell()` for `loginPage`, `renderNotFound`, `renderErrorPage`, `renderNoApps`,
  `uiBuildMissing`, `retiredEntryPage`; `renderSpaDocument()` no longer calls it.
- Remove `renderSidebarNavInner`/`renderBreadcrumbInner` from the SPA path; they remain only for
  `appShell()`.

Client:

- `ui/boot.ts`: validate `ChromeData`, `routeKey`, and optional operator.
- `ui/stores/chrome.ts`: current/boot chrome, `currentRouteKey`, `lastAnnouncedRouteKey`,
  `visibilityRefreshing`; `setChrome(chrome, routeKey)`, `setRouteKey(routeKey)`; title/route
  announcement rule from the design.
- `ui/stores/shell.ts` (or a composable): drawer state, theme state, `#shell[data-nav]`,
  toggle `aria-expanded`/`aria-label`, `#shell[data-nav-id]`/`data-project-id`, and
  `visibilityRefreshing` consumption.
- `ui/components/AppSidebar.vue`, `BreadcrumbBar.vue`, and the theme/drawer pieces: render from
  `ChromeData`; teleport children only; bind `data-nav-id`/`data-project-id` on `#sidebar-nav`;
  `BreadcrumbBar` updates only `#breadcrumb-host[data-nav-id]`; use `encodeURIComponent` for project
  hrefs; fall back to `/settings`/`/skills`.
- `ui/composables/usePageChrome.ts`: four-branch precedence from the design (cached chrome, boot
  chrome, one refetch, normal fetch), token-safe refresh registration.
- `ui/App.vue`: render sidebar/breadcrumb with `v-if="!standalone"`; keep `TopbarActions` and
  `ToastHost`.
- `ui/main.ts` and `ui/composables/useChrome.ts`: remove `fetchChrome`/`applyChrome` innerHTML;
  install focus/drawer/title/routeKey behavior; on `visibilitychange` set
  `visibilityRefreshing` only when actually starting a refresh, call the registered primary query,
  skip while fetching, clear in `finally`; pages suppress refreshing hints while the flag is set.
  Configure the page queries with `refetchOnWindowFocus: false` (via `usePageChrome`/the pages) so a
  focus does not duplicate the registered visibility refresh; add that assertion to
  `ui/composables/useChrome.test.ts` (or a new `ui/composables/usePageChrome.test.ts`).
- Every page with a page query uses `usePageChrome`: overview, projects, project, app, handoffs,
  settings, skills, skill detail, ssh, terminal, chat.
- Remove `applyChrome` calls and the old chrome watchers.
- `ui/chat/stream.ts` and `ui/terminal/socket.ts`: replace the `/api/ui/chrome?path=...` auth probe
  with `/api/ui/auth` and update the source comments; the probe treats `204` as alive, `401`/`403`
  as expired, and `404`/`409` as alive (regression guard).

Tests:

- Update boot/page-response/chrome fixtures and assertions in `test/ui-manifest.test.ts`,
  `test/ui/shell-scripts.test.ts`, `test/ui/boot.test.ts`, `ui/composables/useChrome.test.ts`,
  `test/ui-props-auth.test.ts`, `test/ui-props-chat.test.ts`, `test/ui-props-terminal.test.ts`,
  `test/application-api.test.ts`, `test/preview-http.test.ts`,
  `test/projects-spa-mutation.test.ts`, `test/settings-props.test.ts`, `test/skills-props.test.ts`,
  `test/ssh-props.test.ts`, `test/ui/chat-auth.test.ts`, `test/ui/chat-policy.test.ts`,
  `test/ui/terminal-socket.test.ts`, `ui/pages/*.test.ts`, `ui/skills-fixtures.ts`,
  `test/ui/chat-support.ts`, `test/ui/terminal-page.test.ts`, `test/ui/topbar-actions.test.ts`.
- Add assertions for `/api/ui/chrome` 404; `/api/ui/auth` cookie -> `204` + `no-store`, no cookie ->
  `401`, human bearer -> `403`, agent token -> `403`, no version header -> `204` (not `409`);
  data-only boot/page chrome; login boot; routeKey normalization; cached-chrome no-refetch;
  boot-chrome return; token-safe registration; same-title route announcements; focus does not issue
  a second refresh; no `app.js` on SPA documents; and legacy/login documents keeping it.
- Update `test/ui/chat-auth.test.ts`, `test/ui/terminal-socket.test.ts`, and `e2e/terminal.spec.ts`
  for the new auth probe; assert `204` -> alive, `401`/`403` -> expired, `404`/`409` -> alive; rename
  the terminal harness default to `authStatus: 204`.

Verification: `npm run lint`, `npm run typecheck`, `npm run typecheck:ui`, `npm test`,
`npm run build`, `npm run check:ui`, `npm run check:sensitive`,
`npx vitest run test/ui-manifest.test.ts test/ui/shell-scripts.test.ts test/ui/boot.test.ts ui/composables/useChrome.test.ts test/ui/chat-auth.test.ts test/ui/terminal-socket.test.ts`,
and `rg -n "api/ui/chrome|sidebarNav|renderSidebarNavInner|renderBreadcrumbInner" src ui` (only
legacy `appShell()` call sites in `src/http/ui.ts` may remain; docs are outside this command).

Rollback: `git checkout --` the step's files; image rollback is the release rollback.

### Step 3 - UI version gate, SPA mutations, and draft writes

Files: `ui/api.ts`, `src/http/spa.ts`, `src/http/handler.ts`, `src/http/chat.ts`,
`ui/composables/useChatComposer.ts`, `ui/main.ts`, `ui/api.test.ts`,
`test/ui/chat-draft.test.ts`, `test/chat-stage-a.test.ts`, `test/chat-page.test.ts`,
`test/projects-spa-mutation.test.ts`, `test/ui-props-auth.test.ts`.

- Send `X-Hanse-UI-Version: 2` on `apiQuery`/`apiMutation` and on direct draft fetches (with
  `X-Hanse-Client: spa`).
- Reject missing/different versions on `handleUiApi`/`handleAppUiApi` (except the data-free
  `/api/ui/auth` probe) and in `guardSpaMutation`/the `isSpaMutation` mutation branches in
  `src/http/handler.ts`, after auth/origin, returning
  `409 { error, code: "ui_reload_required" }` with `no-store`.
- Gate the draft `PUT` and delete-if-empty `POST` after auth/cross-site/human-only checks; preserve
  401/403 and the existing JSON error shape.
- New client handles `ui_reload_required` with one guarded reload; clear `PRELOAD_RELOAD_KEY` after
  a successful boot; direct draft fetches check `response.ok`, do not update `lastSaved` on non-2xx,
  and use the same guard. Extract the reload-guard helpers (`PRELOAD_RELOAD_KEY`,
  `alreadyReloaded`/`markReloaded`/clear) into `ui/api.ts` (or a small shared module) and have
  `ui/main.ts` use them, so `ui/api.test.ts` can exercise boot clearing without importing the entry
  module. Add `ui/api.test.ts` assertions: a `409 ui_reload_required` triggers exactly one reload; a
  second 409 does not reload again; the guard is cleared after a successful boot.

Verification: `npx vitest run ui/api.test.ts test/ui/chat-draft.test.ts test/chat-stage-a.test.ts test/chat-page.test.ts test/projects-spa-mutation.test.ts test/ui-props-auth.test.ts`,
then the full gate set.

Rollback: revert the step's files; the data-only chrome cutover remains.

### Step 4 - E2E and final regression

Files: `e2e/spa-*.spec.ts`, `e2e/terminal.spec.ts`, `e2e/support/*` as needed.

- Update chrome mocks/selectors: no `/api/ui/chrome`, client-rendered sidebar/breadcrumb, no
  server topbar seed, no `app.js` on SPA documents, same-title route announcements, visibility
  refresh, draft headers, and the `/api/ui/auth` probe.
- Run the full gate set including `npm run test:e2e`.

### Step 5 - Record

- Write `docs/journal/0048-client-owned-chrome.md` with baseline SHA, contract verdict, test list,
  verification evidence, and accepted limits.
- Update `docs/design/README.md`, `docs/plans/README.md`, and `docs/journal/README.md`.
- Update `docs/current-state.md` (including the `/api/ui/chrome?path=/terminal` probe description at
  line 324) and `README.md` where they describe server-rendered chrome or `/api/ui/chrome`.

### Step 6 - Commit

- One coherent commit (code + tests + docs + record) after all gates pass, authorized by the owner.
- Message style: `refactor(ui): move application chrome into the SPA client`.

## Acceptance criteria

- `GET /api/ui/chrome` returns 404; no `/api/ui/*` response or SPA document contains `sidebarNav` or
  breadcrumb HTML; `rg "api/ui/chrome" src ui` is empty.
- `GET /api/ui/auth` returns 204/401/403 with `no-store` without any version header; chat/terminal
  probes use it; it is exempt from the UI version gate.
- SPA documents contain no `app.js`; legacy/login/fallback documents keep it.
- Vue renders sidebar, breadcrumb, title, counters, theme, drawer, and sign-out from data.
- No page gains a request on navigation; visibility refresh uses the registered primary query and
  does not show a refreshing hint.
- Old tabs fail cleanly on navigation/refetch/mutation via `ui_reload_required`; no half-render;
  a `ui_reload_required` 409 reloads at most once and the guard clears after a successful boot.
- All gates pass, including the full E2E matrix.

## Risks and mitigations

- **Wrong chrome on query-scoped routes:** `routeKey` includes app/project/scope but excludes
  `session`; tests cover app/scope switches and failed fetches.
- **Stale boot chrome:** `usePageChrome` falls back to boot chrome only when the routeKey matches and
  no cached chrome exists; tests cover navigate-away/back within `staleTime`.
- **Auth probe regression:** the `/api/ui/auth` replacement is tested in unit and terminal E2E.
- **Drawer/theme regressions:** static toggle/scrim plus delegated Vue listeners; visual/E2E checks.
- **Chat/terminal layout:** `spaShell` preserves `pageClass`, `bodyClass`, and `viewport`.
- **Open tabs after deploy:** version gate + guarded reload; accepted old Chat/Terminal retry-only
  limitation.
- **Test churn:** the plan lists the exact fixtures; update them in the same step as the contract.
