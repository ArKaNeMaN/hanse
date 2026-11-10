# Design - Zero SSR: static document, JS-required login, Vue 404, static failures

Status: **approved** - owner decisions closed 2026-11-10; Oracle round 2 PASS WITH FIXES
(2026-11-10); remaining findings folded; implementation planning permitted.
Scope: remove the last server-rendered page content and the last legacy UI path: the `/login` server
plate and form, `appShell()` error/fallback pages, `app.js`/`app-content.js`, and the
`HANSE_UI_LEGACY` / `?legacy=1` / `HANSE_UI_SPA_ROUTES` rollback machinery.
Predecessor: [Client-owned application chrome](./client-owned-chrome.md) (implemented, journal 0048).

## 1. Problem

After journal 0048 the SPA owns the application chrome, but the coordinator still has a second UI
path:

- `/login` serves a server-rendered login plate inside the SPA document (`renderLoginSpaDocument`,
  `src/http/spa.ts:599-643`); `GET /login` and `POST /login` in `src/http/handler.ts:1009-1035` still
  render `loginPage()`.
- `renderNotFound()`, `renderErrorPage()`, `renderNoApps()`, and `uiBuildMissing()` still render
  full documents through `appShell()` (`src/http/dashboard.ts:260-344`, `src/http/chat.ts:218-241`,
  `src/http/spa.ts:1159-1187`).
- Unknown paths never boot Vue: `maybeServeSpa()` returns `undefined` when `matchPage()` is
  undefined (`src/http/spa.ts:990-993`), so the legacy 404 renderer handles them.
- A page-render failure in the SPA path reaches the server's JSON 500 catch
  (`src/http/server.ts:534-549`); only the handler fallback has an HTML 500
  (`src/http/handler.ts:1247-1258`).
- Missing UI build falls back to the legacy login page (`src/http/spa.ts:1016-1018`) instead of a
  clear failure; retired routes get the `appShell()` 503 (`:1045-1047`).
- `assets/app.js` and `assets/app-content.js` exist only for the legacy login/error documents; the
  SPA login document still loads `app.js`.
- The rollback flags still affect `/login`; every other route is already `legacyRetired` and ignores
  them. `?legacy=1` is the login rollback input.

The target is a single UI implementation: a static document shell plus the Vue client. The server
may still carry boot JSON, but it renders no page or chrome markup per request.

## 2. Owner decisions (closed 2026-11-10)

1. **No-JS is unsupported as a system requirement.** Login becomes JS-required. The server-rendered
   login plate, the HTML form `POST /login`, and the no-JS fallback are removed. `POST /api/session`
   is the only login mutation. A `<noscript>` notice is informational only.
2. **Error policy A.** `404` is a Vue route when the UI is available. `500` and missing-UI-build are
   self-contained static HTML documents, independent of `app.css`, `app.js`, and Vue.
3. **Rollback policy A.** Rollback is image-only. Remove `HANSE_UI_LEGACY`, `?legacy=1`, and
   `HANSE_UI_SPA_ROUTES`; remove the registry `spa`/`legacyRetired` rollback flags. The `public`
   route flag stays because it is auth policy, not rollback.
4. **Chat with zero applications** is decided here: the server keeps the existing redirect when
   applications exist but no app is selected; when there are no applications at all, it serves the
   chat SPA document with a `chat-no-apps` boot override and Vue renders the empty state.
5. **Visual.** Keep the current login/error visual language. No redesign. Small accessibility and
   clarity improvements are allowed where they do not expand scope.

## 3. Target architecture

### 3.1 One document shell

`spaShell()` becomes the only shell for authenticated pages. `documentPage()` remains the common
HTML frame but loses the legacy script switches:

- no `app.js` or `app-content.js` on any document;
- no `loginPage()` / `appShell()` callers;
- keep the inline theme bootstrap, `app.css`, the server-owned icon sprite, the Vite module script,
  and the boot JSON;
- `#ui-fallback` stays as a static boot-failure notice, but always links to the current page with
  `href=""` ("Reload the page"); the classic-interface link and `fallbackHref` are removed.

"Static document" means **no per-request page/chrome markup**. The following are explicit, allowed
per-request document inputs: the boot JSON data block, the build asset URLs, the inline theme
bootstrap, the `<title>`, and the `pageClass`/`bodyClass`/`viewport` attributes. The icon sprite is
constant markup, not per-request data. Boot JSON is data, not rendered UI; a separate
`/api/ui/boot` endpoint or a prebuilt `ui/index.html` is out of scope.

### 3.2 Route registry and boot

The shared registry becomes the single page manifest:

- add `RouteId = "not-found"` and a synthetic `not-found` definition with `path: "*"`, `nav: "none"`,
  `label: "Page not found"`, `synthetic: true`; `COMPILED` excludes synthetic definitions, so
  `matchPage("/anything")` stays undefined while `routeById("not-found")` works;
- remove `spa` and `legacyRetired` from `RouteDefinition`, and remove `isSpaRoute`, `isSpaPath`,
  `isLegacyRetired`, `isSpaPathIn`, `parseSpaAllowlist`, `SpaAllowlist`, `UiRouteEnv`, and
  `SpaRouteOptions`;
- keep `public` for `/login` and `isPublicRoute()`;
- remove `spaRoutes` from the boot payload. The Vue router table plus `matchPage()` are the source of
  truth; `ui/spa-routes.ts`, `installSpaRoutes()`, and `installedSpaRoutes()` are deleted;
- `SmartLink` decides RouterLink vs plain anchor with `matchPage(pathname) !== undefined`;
- `BootPayload` removes `spaRoutes` and `legacyAvailable`, and adds
  `override?: "not-found" | "chat-no-apps"`. `readBoot()` validates the override string and the
  combination (`not-found` with `route.id === "not-found"` or any real route; `chat-no-apps` only
  with `route.id === "chat"`), and no longer checks allowlist membership.

`?legacy=1` is removed from the router guard and the `routeKey()` excluded keys. `pagePath()` is
replaced by a small `pageRequestPath(request)` used by `loginRedirect()`; it preserves the path and
query (including a stale `legacy` parameter) and does not special-case rollback. Old links with
`?legacy=1` simply load the SPA; the parameter is ignored.

### 3.3 Login

`GET /login` remains the browser entry point, served by `maybeServeSpa()` in this order:

- agent token -> `403`;
- authenticated human cookie -> `302` to the validated `next`;
- missing UI build -> static `503` (no legacy login fallback);
- otherwise -> `200` static login document with an empty `<main id="main">`, boot JSON
  `{ route: login, props: { next }, chrome: minimal, routeKey, topbar }`, and a `<noscript>` notice.

`/login` is a known page path, so it bypasses the HTML `Accept` check; only unknown paths require
HTML `Accept`. The missing-build precedence is: authenticated `/login` -> `302`; unauthenticated
`/login` -> static `503`; authenticated known page -> static `503`; unauthenticated known page ->
static `503` (the login page itself is unavailable); unknown path -> static `404`.

`LoginPage.vue` is unchanged in behavior: it posts JSON to `POST /api/session`, validates `next`
locally, and performs a full-document navigation. `POST /api/session`, the `hanse_token` cookie,
`POST /logout`, and `safeLocalPath()` stay unchanged.

`POST /login` is removed as a form endpoint. It returns `405 Method Not Allowed` with
`Allow: GET, HEAD`; HTML `Accept` gets the self-contained static notice ("Sign-in changed; open the
sign-in page"), other `Accept` values get JSON `{ error: "Method not allowed" }`.
`loginPage()` and `loginPlate()` are deleted. The login document keeps the existing cover classes and
Vue `LoginPage.vue` visual.

### 3.4 404

`404` is a Vue page whenever the UI is available:

- **Unknown path.** `maybeServeSpa()` handles HTML page requests that are not API/asset/IDE/preview/
  internal/health paths. Agent tokens get `403`. Without a UI build it serves the static `404`
  document (UI availability wins, so an unauthenticated request does not redirect to a login page
  that is itself unavailable). With a UI build and a human cookie it serves the SPA document with
  `404` status, boot `route: { id: "not-found", params: {} }`, `override: "not-found"`, and a
  not-found chrome (title "Page not found", breadcrumb "Not found", normal sidebar/counters).
  Without a cookie it keeps the existing login redirect.
- **Known route with missing resource.** When `pagePropsFor()` returns `null` (missing project, app,
  session, skill, etc.), serve the same `404` SPA document with `override: "not-found"` instead of
  `renderNotFound()`. The URL stays the requested one; the boot override tells Vue to render the
  not-found page.
- **Client rendering.** `App.vue` keeps a `bootOverride` ref initialised from `boot.override`. The
  override is keyed to the boot URL (`window.location.pathname + search + hash`) and is cleared only
  when `route.fullPath` differs from that URL; the initial router navigation must not clear it. It renders
  `NotFoundPage.vue` for `not-found`, `ChatNoAppsPage.vue` for `chat-no-apps`, and otherwise the
  normal `RouterView`. The catch-all route becomes `/:pathMatch(.*)*` name `not-found`, component
  `NotFoundPage.vue`. The router guard allows the catch-all for page-like unknown paths, but still
  full-loads non-page paths (`/api*`, `/assets/*`, `/ide*`, `/preview*`, `/internal/*`, health).
  `NotImplementedPage.vue` is deleted.
- **Back/forward limitation.** A known missing resource initially gets the unified 404 document. If
  the user later returns to that URL through client-side history after the override cleared, the
  real page component may show its own "not found" card instead of `NotFoundPage`. This is accepted:
  the server cannot re-supply page props without a full document load, and the page-level error is
  safe. A full reload restores the unified 404. Tests pin this behavior.
- **Visual.** `NotFoundPage.vue` uses the existing page/empty-state classes: "Nothing is moored
  here", with "Open overview" and "Browse projects" actions.

`renderNotFound()` is deleted. `RouteErrorPage.vue` stays for client render errors but loses the
classic-interface link; it offers Reload and Open overview.

### 3.5 Chat with zero applications

Remove `renderNoApps()` and the chat/terminal `retiredEntryPage()` pre-rendering.

- "No applications" means **no operator-visible applications** (`operatorProjects(site)`); the
  reserved master app does not count. This keeps the no-apps state meaningful in a normal deployment.
- `/chat` with no `app` and at least one operator application keeps the existing `302` redirect to
  the first app.
- `/chat` with no `app` and no operator applications serves the chat SPA document with
  `props: { noApps: true }`, `override: "chat-no-apps"`, and a chat chrome hint
  (`title: "Chat"`, breadcrumb `Workbench / Chat`). No `ChatProps` are fabricated. The page also
  offers an "Open master chat" action using `boot.chrome.masterHref`, matching the sidebar's
  always-present master link; the master chat remains reachable.
- `/chat?app=...` or `/terminal?app=...` with an unknown app now reaches `pagePropsFor()` returning
  `null` and therefore the Vue 404 path above.
- `ChatNoAppsPage.vue` renders a page header plus the existing empty-state card: "No applications
  yet", "Add an application to a project before opening a chat.", and an "Open projects" link.
  `ChatPage.vue` also renders `ChatNoAppsPage` when `boot.props.noApps === true` and the route has
  no `app` query, so client-side back/forward to the `/chat` document cannot mount an invalid
  `ChatPage`. `workspaceShellFor()` is untouched for real chat props.

### 3.6 Static failure documents

Add `src/http/static-error.ts`:

```ts
staticErrorDocument({ status, title, message, action? }): string
staticErrorResponse({ status, title, message, action?, headers? }): HttpResponse
```

The document is fully self-contained:

- inline CSS only, system font stack, dark/light via `prefers-color-scheme`;
- no `app.css`, no icon sprite, no scripts, no external requests;
- `Cache-Control: no-store`;
- `Content-Security-Policy: default-src 'none'; style-src 'unsafe-inline'; base-uri 'none';
  form-action 'none'; frame-ancestors 'none'`;
- `X-Content-Type-Options: nosniff`, `Referrer-Policy: no-referrer`;
- generic copy only; never reflect an error message, stack, path, or token.

Use it for:

- `500` page requests (uncaught page dispatch / prop assembly / handler fallback);
- `503` known pages when no UI manifest and no dev URL exist (including `/login`);
- `404` when the UI is unavailable;
- `405` for the removed `POST /login`.

Add a shared `isHtmlPageRequest(request)` helper (new `src/http/page-request.ts` or equivalent):
`GET`/`HEAD`, and either the path is a known page (`matchPage(path) !== undefined`) or the request
`Accept` contains HTML. The path must not be `/api*`, `/assets*`, `/ide*`, `/preview*`, `/internal*`,
`/healthz*`, or `/readyz*`. The static-file extension exclusion applies only to unmatched paths, so
`/projects/<id>/apps/my.app` still reaches `AppPage`. `server.ts` uses it in its catch to choose
static HTML 500 vs the existing JSON 500; `handler.ts` uses it in the fallback 404/500 branch;
`maybeServeSpa()` uses it at the top. A path matrix test covers known pages, dotted app keys,
unknown paths, API/assets/IDE/preview/internal/health, and missing/HTML/JSON `Accept`.

### 3.7 Removed legacy surface

Delete:

- `assets/app.js`, `assets/app-content.js`, their `ASSETS` entries, and `test/app-js-split.test.ts`;
- `loginPage()`, `loginPlate()`, `appShell()`, `renderSidebarNavInner()`, `renderBreadcrumbInner()`,
  `sidebar()`, and the legacy-only shell/content helpers in `src/http/ui.ts`;
- `renderNotFound()`, `renderErrorPage()` and the `dashboard.ts` shell helper;
- `renderNoApps()` in `src/http/chat.ts`;
- `uiBuildMissing()` and `retiredEntryPage()` in `src/http/spa.ts`;
- `ui/spa-routes.ts` and the `spaRoutes` boot field;
- `HANSE_UI_LEGACY`, `HANSE_UI_SPA_ROUTES`, `?legacy=1`, `legacyAvailable`, `fallbackHref`, and the
  page-level "Use the classic interface" links.

Keep: `app.css`, the chat/markdown/vendor assets, `favicon.svg`, `iconSprite()`, `app.css` classes,
the `login-plate` classes used by Vue `LoginPage.vue`, and the `/api/ui/*` props assemblies.

## 4. Contract changes

| Request | Before | After |
|---|---|---|
| `GET /login` | SPA document with server login plate; legacy fallback if flags/manifest | SPA document with empty `#main`; 302 if authenticated; static 503 if UI build missing |
| `POST /login` | form login, server-rendered error page | `405` + `Allow: GET, HEAD`; static notice for HTML, JSON otherwise; use `POST /api/session` |
| `POST /api/session` | JSON login | unchanged |
| `POST /logout` | clear cookie, redirect | unchanged |
| Unknown HTML path | server 404 `appShell()` or login redirect | Vue 404 SPA document (404) when UI available; login redirect when unauthenticated; static 404 when UI unavailable |
| Known route, missing resource | server 404 `appShell()` | Vue 404 SPA document (404) with `override: "not-found"` |
| Page dispatch failure | JSON 500 | static HTML 500 for page requests; JSON 500 for API |
| Missing UI build, known page | legacy login fallback for `/login`; `appShell()` 503 otherwise | static HTML 503 for every known page; authenticated `/login` still redirects to `next` |
| `/chat` with no operator apps | server `appShell()` no-apps page | chat SPA document + Vue `ChatNoAppsPage` (master chat link when present) |
| `/chat` no app, apps exist | 302 to first app | unchanged |
| `?legacy=1` | login rollback / ignored elsewhere | ignored; no special handling |
| `HANSE_UI_LEGACY`, `HANSE_UI_SPA_ROUTES` | login rollback inputs | removed |
| Boot payload | `spaRoutes`, `legacyAvailable` | `override?`; no route allowlist, no legacy availability |

Status codes: 404/405/500/503 responses keep `Cache-Control: no-store`. API responses keep their
existing JSON shapes.

## 5. Server changes

- `src/http/spa.ts`:
  - `maybeServeSpa()` uses `isHtmlPageRequest()`; checks agent tokens first; for public login checks
    the authenticated redirect before UI availability; for non-public known pages checks UI
    availability before the login redirect (a missing build returns 503, not a redirect to a 503
    login page); handles unknown paths with the 404 Vue document;
  - removes `retired`, `spaRoutes`, `legacyAvailable`, `fallbackHref`, `pagePath()`, and
    `logUnknownRoutes()`;
  - adds `serveNotFound()`, `serveChatNoApps()`, and `pageRequestPath()` (for `loginRedirect()`);
  - `renderSpaDocument()` emits `override` and no `spaRoutes`/`legacyAvailable`;
  - `renderLoginSpaDocument()` emits an empty `#main`, no `loginPlate`, no `spaRoutes`;
  - removes `uiBuildMissing()` and `retiredEntryPage()`;
  - `chromeFor()` handles the synthetic `not-found` route.
- `src/http/handler.ts`:
  - remove the `GET /login` legacy branch and the `POST /login` form branch; add the `405` notice
    (`Allow: GET, HEAD`, static HTML for HTML `Accept`, JSON otherwise);
  - keep `POST /api/session`, `POST /logout`, and `sessionLogin`;
  - replace the fallback `renderNotFound`/`renderErrorPage` with static 404/500;
  - remove `app.js`/`app-content.js` from `ASSETS`; remove the legacy `pageChrome` helper.
- `src/http/server.ts`: use `isHtmlPageRequest()` in the catch to return static HTML 500 for page
  requests; keep JSON 500 for API. Wrap the `maybeServeSpa()` call in a try/catch that writes the
  static 500 immediately, so a synchronous page-dispatch failure cannot escape the request listener.
- `src/http/ui.ts`: remove legacy shell/login/error helpers and the `scripts`/`contentScript`/
  `shellScript` options; keep `documentPage()`, `spaShell()`, `iconSprite()`, and shared helpers used
  by props (`ideBase`, `ideFolderUrl`, `initials`, `absoluteTime`, `safeLocalPath`).
- `src/http/dashboard.ts`: delete `shell()`, `navProjects()`, `renderNotFound()`,
  `renderErrorPage()`, and the now-unused `PageChrome` type if no other caller remains.
- `src/http/chat.ts`: delete `renderNoApps()` and its now-unused `navProjects()`/`emptyState` imports
  if no other caller remains.
- `src/http/static-error.ts` (new): self-contained static documents.
- `src/http/page-request.ts` (new): `isPagePath()` / `isHtmlPageRequest()`.

## 6. Client changes

- `ui/boot.ts`: remove `spaRoutes`/`legacyAvailable`; add `override` validation, including the
  override/route combination.
- `ui/main.ts`: remove `installSpaRoutes()` and `legacyFallbackAvailable()`; the runtime fallback
  always reloads the current URL.
- `ui/router.ts`: remove `legacyRetired` meta, `isLegacyRetired`, `?legacy` handling, and the
  installed-route check; allow the `not-found` catch-all for page-like unknown paths; rename it from
  `not-implemented`; keep full-document loads for non-page paths.
- `ui/spa-routes.ts`: delete.
- `ui/components/SmartLink.vue`: use `matchPage()` instead of the installed set.
- `ui/App.vue`: render `NotFoundPage`/`ChatNoAppsPage` from `boot.override`; key the override to the
  boot URL, clear it only when `route.fullPath` differs, and skip the initial router navigation; keep
  `RouteErrorPage` for captured render errors.
- `ui/pages/NotFoundPage.vue` (new): the 404 page; `ui/pages/NotImplementedPage.vue` deleted.
- `ui/pages/ChatNoAppsPage.vue` (new): the zero-apps chat state.
- `ui/pages/ChatPage.vue`: render `ChatNoAppsPage` when `boot.props.noApps === true` and no `app`
  query, so history navigation cannot mount an invalid chat.
- `ui/pages/RouteErrorPage.vue`: remove the classic-interface link and the now-unused `boot` prop.
- `ui/pages/*.vue`: remove the hardcoded `?legacy=1` error links (overview, projects, project, app,
  handoffs, ssh, settings, skills, skill detail).
- `ui/pages/LoginPage.vue`: unchanged behavior; the server plate behind it is removed.

## 7. Tests and verification

Unit/integration:

- route registry: no `spa`/`legacyRetired`; `public` login; synthetic `not-found` excluded from
  `COMPILED`; `matchPage("/anything")` undefined; `routeById("not-found")` works; every
  non-synthetic `ROUTES` id has a router record.
- boot: `override` accepted/rejected, including override/route combinations;
  `spaRoutes`/`legacyAvailable` absent; `not-found` boot.
- login: `/login` document has empty `#main`, no plate, no `app.js`/`app-content.js`, boot `next`;
  authenticated 302; missing build 503; `POST /login` 405 with `Allow: GET, HEAD` (HTML and JSON
  variants); `/api/session` still works; `GET /login` with `Accept: */*` never redirect-loops.
- 404: unknown path with cookie -> 404 SPA document + `override`; without cookie -> login redirect;
  known missing resource -> 404 SPA document; UI unavailable -> static 404; dotted app key
  (`my.app`) still reaches `AppPage`; `isHtmlPageRequest` matrix covers known/unknown/API/assets/IDE/
  preview/internal/health and missing/HTML/JSON `Accept`.
- static errors: 500/503/405/404 bodies contain no external assets, no error detail, CSP (including
  `frame-ancestors`)/no-store; HEAD status/headers are pinned.
- chat no-apps: no operator apps -> chat SPA document + `override` (including a master-only
  fixture); operator apps exist -> 302 first app; unknown app -> 404 SPA document.
- client: `NotFoundPage`/`ChatNoAppsPage` render from boot override; the override survives the
  initial router navigation and clears on a real route change; back/forward to the chat no-apps
  document renders `ChatNoAppsPage`, not `ChatPage`; SmartLink uses `matchPage`; router allows the
  catch-all for page-like unknown paths but full-loads non-page paths; no legacy links.
- assets: `app.js`/`app-content.js` are not served and not referenced by any document.

Update/delete the existing suites listed in the inventory: `test/http.test.ts`,
`test/login-spa.test.ts`, `test/retired-routes.test.ts`, `test/ui/shell-scripts.test.ts`,
`test/ui-manifest.test.ts`, `test/ui-props-auth.test.ts`, `test/shared-routes.test.ts`,
`test/ui/router-guard.test.ts`, `test/ui/terminal-route.test.ts`, `test/ui/boot.test.ts`,
`test/app-js-split.test.ts` (delete), `test/ui/setup.ts`, `test/ui/spa-routes.test.ts` (delete),
`test/ui/chat-support.ts`, `test/ui/terminal-page.test.ts`, `ui/components/SmartLink.test.ts`,
`ui/composables/useChrome.test.ts`, `test/application-api.test.ts`, `test/settings-props.test.ts`,
`test/skills-props.test.ts`, `test/ssh-props.test.ts`, and the page tests that assert `?legacy=1`
links. Add the new cases above.

E2E/browser:

- login (JS-required), authenticated redirect, bad token;
- unknown path -> Vue 404; known missing resource -> Vue 404;
- chat with zero applications -> Vue no-apps state;
- no `app.js`/`app-content.js` request on any page;
- `?legacy=1` loads the SPA, no classic interface;
- add the currently orphaned `e2e/auth.spec.ts` and `e2e/error.spec.ts` to the SPA project and
  update them for JS login and Vue 404; move `e2e/project-detail.spec.ts`'s `#add-app`,
  `#new-handoff`, manifest, and alpha/beta assertions into `spa-project.spec.ts` before deleting
  `project-detail.spec.ts`; delete `e2e/support/route-ids.ts`; remove `HANSE_UI_LEGACY`/
  `HANSE_UI_SPA_ROUTES` from `playwright.config.ts` and `vitest.config.ts`; prune dead
  `isSpaProject`/`project.name === "spa"` branches.

Verification: the full `docs/process.md` gate set, including `npm run test:e2e`, plus
`npm run check:ui` and `npm run check:sensitive`.

## 8. Security

- Auth model unchanged: `hanse_token` is HttpOnly/SameSite=Strict; login remains
  `POST /api/session` with same-origin validation; `next` keeps `safeLocalPath()`.
- No token, error message, stack, path, or secret enters a static error page or 404 boot.
- Static error documents are self-contained with a restrictive CSP and `no-store`.
- Removing the no-JS login is an explicit system requirement; `<noscript>` is informational.
- The 404 Vue document is served only to authenticated humans when the UI is available; unauthenticated
  unknown paths keep the login redirect.
- The UI version gate for `/api/ui/*` and SPA mutations remains unchanged.

## 9. Alternatives considered

- **Keep a static no-JS login form.** Rejected by owner decision 1; also requires per-request `next`
  injection or a compromised redirect.
- **Keep `appShell()` error pages.** Rejected by owner decision 2; it preserves a second UI and
  depends on `app.css`/`app.js`, which is exactly what is unavailable in a UI-build failure.
- **Serve unknown paths with a client catch-all only.** Rejected: the server never boots Vue for
  unknown paths, so the catch-all is unreachable.
- **Move boot JSON to `/api/ui/boot` and serve a prebuilt `ui/index.html`.** Deferred: it adds a
  round trip and a second boot path without removing any server-rendered UI. Boot JSON is data, not
  SSR; this design documents that explicitly.
- **A separate `/chat/no-apps` route.** Rejected: it changes URLs and adds a route; the boot override
  renders the same state at `/chat`.
- **Client-side 404 for known missing resources only.** Rejected as inconsistent; the same
  `not-found` boot covers unknown paths and missing resources.

## 10. Non-goals

- No SSR or hydration.
- No auth/session model change; no cookie or token migration.
- No database, SSE, WebSocket terminal, IDE proxy, preview, or handoff changes.
- No redesign of login or the application shell; only the 404/chat-no-apps pages and the static
  failure documents are new surfaces.
- No separate boot endpoint, `ui/index.html`, or icon-sprite move.
- No no-JS support.

## 11. Risks and mitigations

- **Boot override staleness / initial navigation.** `App.vue` keys the override to the boot URL,
  skips the initial router navigation, and clears only on a real route change; `ChatPage` also
  handles `noApps` for history navigation. Tests cover initial mount, navigate-away-and-back, and
  history back.
- **Known-page `Accept` and dotted app keys.** Known page paths bypass the `Accept` gate, and
  `matchPage()` wins over the extension heuristic; tests include `Accept: */*` and `my.app`.
- **Synthetic `not-found` route.** `COMPILED` excludes `synthetic: true` definitions; `matchPage()`
  stays undefined for unknown paths, while `routeById("not-found")` works. Unit tests pin this.
- **Top-level 500 coverage.** The `maybeServeSpa()` call is wrapped in a try/catch that writes the
  static 500 immediately; tests throw from a prop builder and assert static HTML 500.
- **Static 503 for `/login`.** A missing UI build now locks the UI until redeploy; this is the
  intended hard failure and replaces a silent legacy fallback.
- **Old cached login forms.** They receive 405; accepted hard cutover, image rollback is the recovery.
- **`app.js` removal from the SPA login.** The document's inline theme bootstrap and Vue `LoginPage`
  cover the behavior; browser QA checks theme and password toggle.
- **Chat no-apps and the master app.** "No applications" means operator-visible apps; a master-only
  deployment shows `ChatNoAppsPage` with the always-present "Open master chat" link, matching the
  sidebar. Tests use a master-only fixture.
- **Back/forward to a known missing resource.** Client-side history may show the page's own
  "not found" card after the override clears; a full reload restores the unified 404. This is
  documented and tested.
- **Docs drift.** Update `current-state`, `deployment`, `README`, `DESIGN`, `AGENTS`, `.env.example`,
  the design/plan/journal indexes, and the backlog in the same stage.

## 12. Open questions

None. Owner decisions 1A/2A/3A are closed; chat-no-apps is decided as operator-visible applications
only, with the always-present master chat link; visual polish is limited to parity plus small
accessibility/clarity fixes.

## 13. Review

Oracle round 1 (2026-11-10): **PASS WITH FIXES**. Findings folded: known-page `Accept` and dotted
app-key precedence; boot override initial-navigation/history safety; `GET /login` non-HTML `Accept`;
master-app definition for chat no-apps; synthetic `not-found` unmatchable; static-document wording;
missing-build precedence matrix; router guard non-page full-loads; `pagePath()` replacement; 405
details; `spaShell` fallback href; test and docs inventory.

Oracle round 2 (2026-11-10): **PASS WITH FIXES**. Remaining findings folded: the master-chat action
now uses the sidebar's always-present `masterHref` (no new availability flag); `project-detail` E2E
assertions move into `spa-project` before deletion. Design approved for planning.
