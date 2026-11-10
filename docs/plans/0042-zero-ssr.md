# Plan 0042 - Zero SSR

Status: **implemented** - design approved (Oracle round 2 PASS WITH FIXES, findings folded); plan
`momus` OKAY (2026-11-10); targeted and UI gates green; full repository gate temporarily blocked by
unrelated concurrent notification-stage changes (journal 0049).
Design: [`docs/design/zero-ssr.md`](../design/zero-ssr.md).
Journal: [`docs/journal/0049-zero-ssr.md`](../journal/0049-zero-ssr.md).
Owner decisions: 1A (JS-required login, no no-JS), 2A (Vue 404; static 500/build-missing), 3A
(image-only rollback), chat-no-apps delegated (operator-visible apps only; master chat link), visual
parity plus small accessibility/clarity fixes.
Mode: **B** - intentional internal HTTP/boot contract change.
Baseline: commit `6aca092`; the working tree also contains the design doc, `AGENTS.md`, and the
backlog owner-decision note. Pre-existing untracked file: `recovered-plugin-draft-2026-11-04.txt`.
Baseline gates (journal 0048): lint, typecheck, typecheck:ui, 3,685 unit tests, build, check:ui,
check:sensitive, 130 E2E passed / 1 skipped.

## Goal

Remove every server-rendered page/chrome path and the last legacy UI implementation. `/login` becomes
a JS-required SPA document; unknown paths and missing resources get a Vue 404; 500 and missing-UI-build
are self-contained static HTML; chat with no operator apps is a Vue state; `app.js`/`app-content.js`
and the rollback flags are deleted.

## Non-goals

- No SSR/hydration, no separate boot endpoint, no prebuilt `ui/index.html`, no icon-sprite move.
- No auth/session model change: cookie, `POST /api/session`, `POST /logout`, and `next` validation
  stay.
- No database, SSE, WebSocket terminal, IDE, preview, or handoff changes.
- No redesign of login or the application shell; only 404/chat-no-apps and static failure pages.
- No no-JS support.

## Step 1 - Atomic contract cutover (server + client)

This step is one unit. The boot shape, server dispatch, and client router must change together; do
not run the full gates halfway.

### Server

Files: `src/shared/routes.ts`, `src/http/spa.ts`, `src/http/handler.ts`, `src/http/server.ts`,
`src/http/page-request.ts` (new), `src/http/static-error.ts` (new).

- `src/shared/routes.ts`:
  - add `RouteId = "not-found"` and a synthetic definition `{ path: "*", nav: "none", label: "Page
    not found", synthetic: true }`; `COMPILED` excludes `synthetic` definitions, so `matchPage()`
    stays undefined for unknown paths and `routeById("not-found")` works;
  - remove `spa`/`legacyRetired` from `RouteDefinition`; remove `isSpaRoute`, `isSpaPath`,
    `isLegacyRetired`, `isSpaPathIn`, `parseSpaAllowlist`, `SpaAllowlist`, `UiRouteEnv`,
    `SpaRouteOptions`;
  - keep `public` and `isPublicRoute()`; remove `legacy` from `EXCLUDED_ROUTE_KEYS`;
  - `routeChrome` handles `not-found` (title "Page not found", breadcrumb "Not found").
- `src/http/page-request.ts`: `isPagePath(pathname)` and `isHtmlPageRequest(request)`:
  - `GET`/`HEAD`;
  - known page (`matchPage(pathname) !== undefined`) bypasses the `Accept` check; unknown paths
    require HTML `Accept`;
  - reject `/api*`, `/assets*`, `/ide*`, `/preview*`, `/internal*`, `/healthz*`, `/readyz*`;
  - the static-file extension exclusion applies only to unmatched paths, so
    `/projects/<id>/apps/my.app` still reaches `AppPage`.
- `src/http/static-error.ts`: `staticErrorDocument()` / `staticErrorResponse()` with inline CSS,
  no external assets, `Cache-Control: no-store`, restrictive CSP (including `frame-ancestors
  'none'`), `X-Content-Type-Options: nosniff`, `Referrer-Policy: no-referrer`, generic copy only.
- `src/http/spa.ts`:
  - `maybeServeSpa()` uses `isHtmlPageRequest()`; checks agent tokens first;
  - UI availability = `uiDevUrl()` or a loaded manifest;
  - public `/login`: authenticated -> `302`; missing build -> static `503`; else empty login
    document;
  - non-public known page: missing build -> static `503` before the login redirect; then
    `humanFromCookie`; missing cookie -> `loginRedirect`;
  - unknown path: missing build -> static `404`; no cookie -> `loginRedirect`; else `serveNotFound`;
  - `serveNotFound()` serves status `404` SPA document with boot
    `route: { id: "not-found", params: {} }`, `override: "not-found"`, not-found chrome;
  - known `props === null` -> `serveNotFound()`;
  - chat no app: operator apps exist -> `302` first app; no operator apps -> `serveChatNoApps()`
    with `props: { noApps: true }`, `override: "chat-no-apps"`, chat chrome hint; if master exists,
    the page uses `boot.chrome.masterHref`;
  - remove `retired`, `spaRoutes`, `legacyAvailable`, `fallbackHref`, `pagePath()`,
    `logUnknownRoutes()`, `uiBuildMissing()`, `retiredEntryPage()`, `pageChrome()`;
  - add `pageRequestPath(request)` for `loginRedirect()`; it preserves path/query and does not
    special-case `legacy`;
  - `renderSpaDocument()` emits `override`, no `spaRoutes`/`legacyAvailable`;
  - `renderLoginSpaDocument()` emits an empty `<main id="main">`, a `<noscript>` notice, no
    `loginPlate`, no `spaRoutes`, and no `app.js`/`app-content.js`.
- `src/http/handler.ts`:
  - remove `GET /login` and the form `POST /login` branch; add `POST /login` -> `405`,
    `Allow: GET, HEAD`, static HTML for HTML `Accept`, JSON otherwise;
  - keep `POST /api/session`, `POST /logout`, `sessionLogin`;
  - replace the fallback `renderNotFound`/`renderErrorPage` with static 404/500.
- `src/http/server.ts`: wrap the `maybeServeSpa()` call in try/catch and write the static 500 for
  HTML page requests; use `isHtmlPageRequest()` in the promise catch to choose static HTML 500 vs the
  existing JSON 500.

### Client

Files: `ui/boot.ts`, `ui/main.ts`, `ui/router.ts`, `ui/App.vue`, `ui/components/SmartLink.vue`,
`ui/spa-routes.ts` (delete), `ui/pages/NotFoundPage.vue` (new),
`ui/pages/ChatNoAppsPage.vue` (new), `ui/pages/NotImplementedPage.vue` (delete),
`ui/pages/ChatPage.vue`, `ui/pages/RouteErrorPage.vue`, page components with `?legacy=1` links.

- `ui/boot.ts`: remove `spaRoutes`/`legacyAvailable`; add `override` validation, including
  `chat-no-apps` only with `route.id === "chat"`; allow `not-found` via `routeById`.
- `ui/main.ts`: remove `installSpaRoutes()` and `legacyFallbackAvailable()`; the runtime fallback
  always reloads the current URL.
- `ui/router.ts`: remove `legacyRetired` meta, `isLegacyRetired`, `?legacy` handling, and the
  installed-route check; rename the catch-all to `not-found`/`NotFoundPage.vue`; allow the catch-all
  for page-like unknown paths, but full-load non-page paths (`/api*`, `/assets*`, `/ide*`,
  `/preview*`, `/internal*`, health).
- `ui/spa-routes.ts`: delete; `SmartLink` uses `matchPage(pathname) !== undefined`.
- `ui/App.vue`: `bootOverride` initialised from `boot.override`, keyed to
  `window.location.pathname + search + hash`; skip the initial router navigation and clear only when
  `route.fullPath` differs from the boot URL. Render `NotFoundPage` for `not-found`,
  `ChatNoAppsPage` for `chat-no-apps`, otherwise `RouterView`; keep `RouteErrorPage` for captured
  render errors.
- `ui/pages/NotFoundPage.vue`: page header + empty state "Nothing is moored here" with "Open
  overview"/"Browse projects".
- `ui/pages/ChatNoAppsPage.vue`: page header + empty state "No applications yet", "Open projects",
  and "Open master chat" using the always-present `boot.chrome.masterHref`, matching the sidebar.
- `ui/pages/ChatPage.vue`: render `ChatNoAppsPage` when `boot.props.noApps === true` and no `app`
  query, so history navigation cannot mount an invalid chat.
- `ui/pages/RouteErrorPage.vue`: remove the classic-interface link and unused `boot` prop.
- Remove hardcoded `?legacy=1` error links from overview, projects, project, app, handoffs, ssh,
  settings, skills, skill detail.

### Tests in this step

Update/add: `test/shared-routes.test.ts`, `test/ui/boot.test.ts`, `test/ui/router-guard.test.ts`,
`test/ui/terminal-route.test.ts`, `test/ui/setup.ts`, `test/ui/spa-routes.test.ts` (delete),
`ui/components/SmartLink.test.ts`, `ui/composables/useChrome.test.ts`, `test/login-spa.test.ts`,
`test/retired-routes.test.ts`, `test/http.test.ts`, `test/ui/shell-scripts.test.ts`,
`test/ui-manifest.test.ts`, `test/ui-props-auth.test.ts`, `test/ui/chat-support.ts`,
`test/ui/terminal-page.test.ts`, `test/application-api.test.ts`, `test/settings-props.test.ts`,
`test/skills-props.test.ts`, `test/ssh-props.test.ts`, page tests that assert `?legacy=1` links.

Required cases:
- route registry: synthetic not-found excluded from `COMPILED`; `matchPage("/anything")` undefined;
  every non-synthetic route has a router record.
- boot override accepted/rejected; no `spaRoutes`/`legacyAvailable`.
- login: empty `#main`, no plate, no `app.js`/`app-content.js`; authenticated 302; missing build 503;
  `GET /login` with `Accept: */*` never redirect-loops; `POST /login` 405 with `Allow: GET, HEAD`
  for HTML/JSON.
- 404: unknown path with cookie -> 404 SPA + override; without cookie -> login redirect; missing
  resource -> 404 SPA; UI unavailable -> static 404; dotted app key still reaches `AppPage`.
- `isHtmlPageRequest` matrix: known/unknown/API/assets/IDE/preview/internal/health and
  missing/HTML/JSON `Accept`.
- static errors: 500/503/405/404 have no external assets, no error detail, CSP/no-store; HEAD
  status/headers pinned.
- chat no-apps: no operator apps -> chat SPA + override (master-only fixture); operator apps exist ->
  302 first app; unknown app -> 404 SPA.
- client: override survives initial navigation, clears on real route change; history back to the
  chat no-apps document renders `ChatNoAppsPage`; non-page router paths full-load; no legacy links.
- assets: no document references `app.js`/`app-content.js`.

Verification: `npm run lint`, `npm run typecheck`, `npm run typecheck:ui`, `npm test`, `npm run build`,
`npm run check:ui`, `npm run check:sensitive`.

Rollback: revert Step 1 files; no release rollback until the whole stage is committed.

## Step 2 - Delete the legacy surface and rollback machinery

Files: `src/http/ui.ts`, `src/http/dashboard.ts`, `src/http/chat.ts`, `src/http/spa.ts`,
`src/http/handler.ts`, `assets/app.js` (delete), `assets/app-content.js` (delete), `.env.example`,
`vitest.config.ts`, `playwright.config.ts`, `e2e/support/route-ids.ts` (delete), docs.

- `src/http/ui.ts`: remove `appShell()`, `loginPage()`, `loginPlate()`, `renderSidebarNavInner()`,
  `renderBreadcrumbInner()`, `sidebar()`, `navItem()`, `sidebarProjects()`, and other dead
  legacy-only helpers; keep `documentPage()`, `spaShell()`, `iconSprite()`, `toastRegion()`, and
  shared helpers used by props. Remove `scripts`/`contentScript`/`shellScript` options; every
  document loads no `app.js`/`app-content.js`. `spaShell` fallback always uses `href=""`.
- `src/http/dashboard.ts`: delete `shell()`, `navProjects()`, `renderNotFound()`,
  `renderErrorPage()`, and the unused `PageChrome` type.
- `src/http/chat.ts`: delete `renderNoApps()` and now-unused imports.
- `src/http/spa.ts`: delete `uiBuildMissing()`, `retiredEntryPage()`, `pageChrome()`, and the
  `PageChrome` type if unused.
- `src/http/handler.ts`: remove `app.js`/`app-content.js` from `ASSETS`.
- Delete `assets/app.js`, `assets/app-content.js`, `test/app-js-split.test.ts`,
  `e2e/support/route-ids.ts`; remove `HANSE_UI_LEGACY`/`HANSE_UI_SPA_ROUTES` from `.env.example`,
  `vitest.config.ts`, `playwright.config.ts`.
- Update `AGENTS.md`, `docs/current-state.md` (auth, UI rendering, script split, env vars, assets,
  chat no-apps, icon sprite), `docs/deployment.md`, `README.md`, `DESIGN.md`, and
  `docs/backlog/0003-cut-legacy-ssr.md` (close it).
- Update `test/ui/shell-scripts.test.ts` to keep only the static SPA shell/error tests;
  `test/ui-manifest.test.ts`, `test/ui-props-auth.test.ts`, `test/http.test.ts`, and the props tests
  for the removed env/route flags.

Verification: full gate set; `rg` checks:
- `rg -n "HANSE_UI_LEGACY|HANSE_UI_SPA_ROUTES|legacyAvailable|fallbackHref|app-content\\.js|assets/app\\.js|appShell|loginPage|loginPlate|renderNotFound|renderErrorPage|renderNoApps|uiBuildMissing|retiredEntryPage" src ui test e2e docs` should only show historical journal/design entries and the stage's own record.
- `rg -n "\\?legacy=1|legacy=1" ui src` empty.

Rollback: revert Step 2 files; Step 1 contract remains.

## Step 3 - E2E and final regression

Files: `e2e/auth.spec.ts`, `e2e/error.spec.ts`, `e2e/spa-chat.spec.ts`, `e2e/spa-terminal.spec.ts`,
`e2e/terminal.spec.ts`, `e2e/project-detail.spec.ts` (delete), other `e2e/*.spec.ts` with
`isSpaProject`/`?legacy` branches, `playwright.config.ts`.

- Add `auth.spec.ts` and `error.spec.ts` to the `spa` testMatch; update auth for JS login (remove the
  legacy `?legacy=1` test) and error for Vue 404.
- Move `project-detail.spec.ts`'s `#add-app`, `#new-handoff`, `.hanse/project.yaml`, and alpha/beta
  link assertions into `spa-project.spec.ts`, then delete `project-detail.spec.ts`.
- Remove `?legacy=1` cases and dead `isSpaProject`/`project.name === "spa"` branches.
- Add E2E: login, authenticated redirect, bad token; unknown path -> Vue 404; missing resource ->
  Vue 404; chat no-apps -> Vue state; no `app.js`/`app-content.js` request on any page; `?legacy=1`
  loads the SPA with no classic interface.
- Run the full `docs/process.md` gate set including `npm run test:e2e`.

Rollback: revert E2E/config files.

## Step 4 - Record

- Write `docs/journal/0049-zero-ssr.md` with baseline SHA, contract verdict, decisions, test
  evidence, accepted limits, and next steps.
- Update `docs/design/README.md`, `docs/plans/README.md`, `docs/journal/README.md`.
- Ensure `docs/current-state.md`, `docs/deployment.md`, `README.md`, `DESIGN.md`, `AGENTS.md`,
  `.env.example`, and the backlog reflect the final state.

## Step 5 - Commit

- One coherent commit (code + tests + docs + record) after all gates pass, only with explicit owner
  approval.
- Message style: `refactor(ui): remove the legacy SSR surface`.

## Acceptance criteria

- No runtime input serves a server-rendered page/chrome document or a legacy UI script.
- `/login` is JS-required; `POST /login` is 405; `POST /api/session` works; no no-JS fallback.
- Unknown paths and known missing resources return a Vue 404 when the UI is available; 500/503 are
  self-contained static HTML; missing build never falls back to legacy.
- Chat with no operator apps is a Vue state; master chat remains reachable.
- `app.js`/`app-content.js`, `HANSE_UI_LEGACY`, `HANSE_UI_SPA_ROUTES`, `?legacy=1`,
  `legacyAvailable`, `fallbackHref`, and `spaRoutes` are gone.
- Full gate set green, including E2E; `check:sensitive` clean.

## Risks and mitigations

- **Contract cutover size.** Step 1 is atomic; keep the server/client boot shape in one diff and run
  the full unit/typecheck gates immediately.
- **404 override lifecycle.** Key to the boot URL, skip initial navigation, clear on real route
  change; `ChatPage` handles `noApps`; tests cover initial/back/forward.
- **Known-page `Accept` and dotted app keys.** `matchPage()` wins over the extension heuristic;
  matrix tests include `Accept: */*` and `my.app`.
- **Master-app ambiguity.** "No applications" means operator-visible apps; master-only shows the
  no-apps page with a master link.
- **Top-level 500 coverage.** Wrap `maybeServeSpa()` synchronously; test a throwing prop builder.
- **Old cached login forms.** They receive 405; accepted hard cutover, image rollback is recovery.
- **Test/docs churn.** The plan names the fixtures and docs; update them in the same step as the
  contract.

## Review

Momus (2026-11-10): **OKAY**. All referenced existing files and symbols were verified against the
working tree, including the design doc, the route/spa/handler/server code, the UI router/boot/pages,
the listed tests and E2E specs, and baseline `6aca092`; only the new artifacts the plan creates are
absent. Each step has concrete files, required cases, verification commands, and rollback. No
blocking issues.
