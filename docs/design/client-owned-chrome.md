# Design - Client-owned application chrome

Status: **approved** - Oracle round 7 PASS (2026-11-09); §10 auth-probe amendment Oracle PASS
(2026-11-09). Owner decisions closed; plan 0040 approved; implementation permitted.
Scope: remove the server-rendered chrome fragment contract from every SPA document: delete
`GET /api/ui/chrome`, replace the `chrome` payload's HTML strings with data, and render the sidebar,
breadcrumb, title, counters, theme toggle, drawer behavior, and sign-out in Vue.
Out of scope: the `/login` server-rendered form and its rollback, the legacy fallback/error documents
that still use `appShell()`, and the static icon sprite.

## 1. Problem

The Vue client renders page content, but the application frame is still server-rendered:

- `chromeFor()` builds `sidebarNav` and `breadcrumb` as HTML strings
  (`src/http/spa.ts:465-481`).
- `GET /api/ui/chrome` returns those strings as JSON (`src/http/spa.ts:1332-1347`).
- Every `/api/ui/*` page response already carries the same `chrome` payload
  (`src/http/spa.ts:1377-1663`), and the boot document carries it too.
- Pages call `applyChrome()` after a fetch (`ui/pages/ProjectPage.vue:112`,
  `HandoffsPage.vue:121`, `SettingsPage.vue:138`, `TerminalPage.vue:78`,
  `AppPage.vue:88,371`, `SkillDetailPage.vue:164`, `SshPage.vue:256`, `ChatPage.vue:967`).
- `useChrome.installChrome()` makes a second request on every client navigation and on
  `visibilitychange`, then injects the fragments with `innerHTML`
  (`ui/composables/useChrome.ts:31-45,181-226`).
- The SPA document is produced by `appShell()`, which renders the sidebar, breadcrumb, topbar
  container, toast region, and icon sprite (`src/http/ui.ts:532-570`).
- `assets/app.js` still loads on every SPA document and owns the drawer and theme behavior
  (`src/http/ui.ts:316`, `assets/app.js:1-94`).

The endpoint is therefore redundant, and the HTML-fragment contract is the remaining reason the
SPA frame depends on server rendering.

## 2. Owner decisions (closed)

1. **Depth B.** Remove the endpoint and the server-rendered HTML chrome for SPA documents; Vue owns
   the sidebar and breadcrumb. Do not keep the HTML-fragment path behind a flag.
2. **First paint A.** Keep a static server document shell with empty chrome containers and no
   per-request chrome HTML. Boot JSON stays in the document; it is data, not rendered UI. This is
   not SSR of the application chrome.
3. **Sidebar all Vue.** Vue renders the whole sidebar: navigation, project list, counters, active
   state, operator identity, theme toggle, and sign-out.
4. **Counters B.** Keep the current freshness behavior by refetching the active page query on
   `visibilitychange`; do not add a dedicated counters endpoint.
5. **Deploy A.** Hard cutover. No dual-format compatibility release; an old open tab reloads or
   shows the existing fallback. Rollback is an image rollback.
6. `/login` SSR and the legacy error/fallback documents are a separate follow-up.

## 3. Target contract

### 3.1 `ChromeData`

The route-dependent chrome becomes data only:

```ts
export interface ChromeData {
  readonly title: string;
  readonly active: NavActive;
  readonly activeProjectId?: string;
  readonly breadcrumb: readonly Crumb[];
  /** Non-master projects, already filtered; the client owns the top-6/active-pin rule. */
  readonly projects: readonly NavProject[];
  readonly masterHref: string;
  readonly pendingCount: number;
  readonly sshPendingCount: number;
  readonly settingsHref?: string;
  readonly skillsHref?: string;
}
```

`Crumb` is `{ label, href? }`; `NavProject` is `{ id, name, appCount }`; `NavActive` is the existing
union. `ChromeProps` and `ChromeData.chrome` are deleted; `chromeFor()` returns `ChromeData`.
The client renders every name/label through Vue interpolation and every href through an attribute
binding; no `v-html`. When `settingsHref`/`skillsHref` are absent, the client falls back to
`/settings`/`/skills`, matching `renderSidebarNavInner()`.

Operator identity is not route-dependent, so it moves to the boot payload instead of being repeated
in every page response:

```ts
export interface BootOperator {
  readonly name: string;
  readonly initials: string;
}

export interface BootPayload {
  // ...
  readonly routeKey: string; // normalized id + sorted params + sorted query
  readonly operator?: BootOperator; // absent on the public login document
}
```

`routeKey` is built by one pure helper shared by server and client (`src/shared/routes.ts`):
`routeKey(id, params, query)` returns a stable string. It distinguishes `/chat?app=a` from
`/chat?app=b`, and scoped settings/skills routes, which `PageMatch` alone cannot.

The canonical form is fixed so server and client cannot drift:

- sort param and query keys;
- take the last value for a repeated query key (matching the server's
  `Object.fromEntries(url.searchParams)` behavior), drop `null`/`undefined`, and keep an empty string;
- exclude the keys that do not affect chrome/page identity: `legacy` (rollback input), `notice`/`tone`
  (toast presentation), and `session` (chat selection; the chat title/breadcrumb do not depend on it);
- serialize the normalized sorted entries with `JSON.stringify` (or an equivalent stable encoding).

The excluded set is explicit so every included key changes either page data or chrome. A future query
key that is pure UI selection must be added to the excluded set rather than silently changing
`routeKey` without a `setChrome` call.

`renderSpaDocument()` computes the initials with the existing `initials()` helper; the client never
derives a display string from a name it did not receive.

### 3.2 Response shape

- Boot: `{ route, props, chrome: ChromeData, operator?, spaRoutes, topbar, notice?, legacyAvailable? }`.
- Every `/api/ui/*` page response: `{ ...props, chrome: ChromeData }`.
- `GET /api/ui/chrome` is removed from `UI_API_PATHS` and from the dispatcher; it returns the normal
  unknown-route response (`404`).
- No endpoint or response contains `sidebarNav`, `breadcrumb` HTML, or any other rendered markup.
- `GET /api/ui/auth` is a non-page, data-free probe endpoint added by §10; it is not part of the page
  response shape.

### 3.3 UI version gate (hard cutover)

A new client sends `X-Hanse-UI-Version: 2` on every `apiQuery`/`apiMutation` request and on the
SPA's direct draft `fetch()` calls in `ui/composables/useChatComposer.ts`; those direct calls also
send `X-Hanse-Client: spa`, so the central mutation gate covers them. The data-free `GET /api/ui/auth`
probe is explicitly exempt from the version header and the server-side gate (§10). `handleUiApi`/`handleAppUiApi` reject a missing or different
version with `409 { error: "UI reload required", code: "ui_reload_required" }` after auth and before
reading page data. The same version check applies to SPA mutations: a request carrying
`X-Hanse-Client: spa` must also carry `X-Hanse-UI-Version: 2`. The draft endpoints
(`PUT /api/apps/:app/sessions/:session/draft` and the delete-if-empty POST) require the version
header **regardless of `X-Hanse-Client`**, so an old tab's direct draft writes are rejected too, not
just the new client's `apiMutation` calls. The draft gate runs after the existing principal and
cross-site checks, preserves `401`/`403` for unauthenticated/unauthorized requests, and returns the
same `409 { error, code: "ui_reload_required" }` JSON with `Cache-Control: no-store` as the UI API.
The new client's direct draft fetches check `response.ok` and the `ui_reload_required` code; they do
not update `lastSaved` on a non-2xx response and route the code through the same guarded reload. The new client handles `ui_reload_required` with one guarded full-page reload
(the existing `PRELOAD_RELOAD_KEY` one-shot pattern in `ui/main.ts`); the old bundle cannot, so an old
Chat/Terminal tab may show its existing Retry-only error until the user reloads manually (accepted
legacy-client limitation). This is a version gate, not a dual-format response.

## 4. Server changes

### 4.1 Data assembly

- `chromeFor(site, match, hint)` returns `ChromeData` directly. It keeps `routeChrome()`,
  `scopedHrefs()`, and `skillsChromeHint()`.
- `projects` is `site.projects.filter((project) => !isMasterProject(project.id))` mapped to
  `{ id, name, appCount }`; `masterHref` is `masterChatHref()`.
- `pendingCount`/`sshPendingCount` keep their current values.
- `title`, `active`, `activeProjectId`, and `breadcrumb` keep their current derivation.

### 4.2 SPA document

Add `spaShell()` (in `src/http/spa.ts` or `src/http/ui.ts`) that calls `documentPage()` with a
**static** body. It must preserve the existing per-route shell options (`pageClass`, `bodyClass`,
`viewport`) and the hidden `#ui-fallback` wrapper:

```html
<a class="skip-link" href="#main">Skip to content</a>
<div class="sr-only" id="route-announcer" aria-live="polite" aria-atomic="true"></div>
<div class="app-shell" data-nav="closed" id="shell" data-nav-id="none">
  <aside class="sidebar" id="sidebar" aria-label="Primary"></aside>
  <div class="shell-main">
    <header class="topbar">
      <button class="btn btn-ghost btn-icon nav-toggle" type="button" data-nav-toggle
              aria-expanded="false" aria-controls="sidebar" aria-label="Open navigation">…menu icon…</button>
      <a class="topbar__brand" href="/">hanse</a>
      <nav class="breadcrumb" id="breadcrumb-host" aria-label="Breadcrumb" data-nav-id="none"></nav>
      <div class="topbar__actions"></div>
    </header>
    <main class="page ${pageClass}" id="main" tabindex="-1">
      <div class="page__body ${bodyClass}">…hidden #ui-fallback…</div>
    </main>
  </div>
  <div class="scrim" data-nav-close></div>
</div>
<div id="toast-region"></div>
```

- The sidebar is an empty container; Vue teleports the complete sidebar **children** into it (never a
  second `<aside id="sidebar">`).
- `#breadcrumb-host` is an empty static `<nav>`; Vue teleports the crumb content into it.
- The nav toggle and scrim stay as static shell controls (no per-request data); Vue owns their
  behavior so `app.js` is no longer needed on SPA documents.
- `#shell` starts with `data-nav-id="none"`; Vue updates `data-nav-id`/`data-project-id`.
- The static document `<title>` is `hanse`; Vue sets the route title on mount.
- `pageClass`/`bodyClass` are optional and must use the existing `pageClasses()` helper so an absent
  value never renders a literal `undefined` class.
- `documentPage()` gains a `shellScript?: boolean` option (default `true`). `renderSpaDocument()`
  passes `false`; the SPA login document and legacy/fallback documents keep `app.js`.
- The server topbar seed is removed from SPA documents: `.topbar__actions` starts empty and
  `TopbarActions.vue` fills it after mount. `renderChatTopbarActions()` and the `topbarActions`
  input become dead and are deleted; `clearTopbarActions()`/`ui/topbar.ts` are removed with them.

`appShell()` stays for the legacy/fallback documents only: `loginPage()`, `renderNotFound()`,
`renderErrorPage()`, `renderNoApps()`, `uiBuildMissing()`, and `retiredEntryPage()`. Those documents
are not SPA documents and are a separate SSR follow-up. `renderSpaDocument()` no longer calls
`appShell()`.

### 4.3 Dispatcher

- `maybeServeSpa()` computes `const chrome = chromeFor(site, match, hint)` and passes it to
  `renderSpaDocument({ chrome, operator: { name: principal.name, initials: initials(principal.name) }, ... })`.
- The `/api/ui/chrome` branch is deleted.
- Page endpoints replace `chromeFor(...).chrome` with `chromeFor(...)`.
- `handleUiApi`/`handleAppUiApi` keep cookie-only auth and `no-store`, and add the UI version gate.
- `renderLoginSpaDocument()` emits an empty `ChromeData` (title `Sign in`, `active: "none"`, empty
  breadcrumb/projects, zero counts, `masterHref`), a `routeKey` computed by the dispatcher from the
  **full** `/login` request query, and omits `operator`. `renderSpaDocument()` likewise receives and
  emits the `routeKey` computed from the full request.

## 5. Client changes

### 5.1 Stores

- `ui/stores/chrome.ts` holds the current `ChromeData`, the boot route/chrome (`routeKey`), optional
  `BootOperator`, `currentRouteKey`, `lastAnnouncedRouteKey`, and `visibilityRefreshing`.
  `setRouteKey(routeKey)` updates `currentRouteKey` only, non-announcing.
  `setChrome(chrome, routeKey)` replaces the route data, sets
  `document.title = `${title} - hanse``, and announces when the title changed **or the incoming
  `routeKey` differs from `lastAnnouncedRouteKey`**; it then sets `lastAnnouncedRouteKey = routeKey`.
  This keeps a same-title query-only navigation audible even though `installChrome` already advanced
  `currentRouteKey`. `installChrome` calls `setRouteKey` on every `router.afterEach`, and
  `usePageChrome` passes the current `routeKey` when it applies data/boot chrome. Boot initializes the store; page responses update the chrome data but do
  not carry `routeKey`. The store keeps the boot chrome so `usePageChrome` can re-apply it when
  returning to the boot route before a cached query carries chrome.
- `ui/stores/shell.ts` (or a composable) owns drawer state: `open`, `close`, `toggle`, Escape,
  resize, scrim click, and close-after-sidebar-navigation. It is the single owner of
  `#shell[data-nav]`, the nav toggle's `aria-expanded`/`aria-label`, and
  `#shell[data-nav-id]`/`data-project-id`. `BreadcrumbBar` does not write `#shell`. The chrome store
  exposes `visibilityRefreshing` so pages can suppress refreshing hints during a visibility-driven
  counter refresh.
- Theme state lives in a small composable or store: read the current
  `document.documentElement.dataset.theme`, toggle it, persist `localStorage["hanse-theme"]`, and
  update the toggle's label/icon. The inline theme boot script in `documentPage()` stays.

### 5.2 Components

- `ui/components/AppSidebar.vue` teleports **children** to `#sidebar` and renders:
  - the head (wordmark, kicker, close button);
  - the Workbench nav (Overview, Projects, Master, Handoffs + pending count, Skills with scoped
    href, Settings with scoped href, SSH + pending count);
  - the project list (top six non-master, active project pinned, app counts, active state);
  - the footer (operator initials/name, theme toggle, sign-out form).
  It uses `AppIcon`, `SmartLink` for internal links, `encodeURIComponent(project.id)` for project
  hrefs, the same class names, and binds `data-nav-id`/`data-project-id` on `#sidebar-nav`. Active
  state/`aria-current` comes from `ChromeData.active`/`activeProjectId`, not from `SmartLink`'s
  exact-route fallback.
- `ui/components/BreadcrumbBar.vue` teleports crumb content into `#breadcrumb-host`, uses
  `SmartLink` for internal hrefs, renders the current crumb as `aria-current="page"`, and updates
  only `#breadcrumb-host[data-nav-id]` from the store.
- `ui/App.vue` renders `AppSidebar`, `BreadcrumbBar`, `TopbarActions`, and `ToastHost` with
  `v-if="!standalone"` for the first two (the login document has no shell containers).
- `TopbarActions.vue` and `ToastHost.vue` keep their existing teleport targets.
- `AppIcon.vue` keeps using the static server sprite (`#i-*`). The sprite is static markup, not
  per-request chrome, and stays until the full static-document move.

### 5.3 Navigation, page chrome, and counters

- Add one shared `usePageChrome(query, boot)` composable with explicit precedence:
  1. `query.data.chrome` exists -> `setChrome(data.chrome, currentRouteKey)`, no refetch;
  2. no chrome and `currentRouteKey === boot.routeKey` -> `setChrome(boot.chrome, currentRouteKey)`;
  3. no chrome, `query.data !== undefined`, route differs, and the query is not already fetching ->
     force one refetch;
  4. `query.data === undefined` -> leave the query's normal initial fetch alone.
  This closes the navigate-away-and-back-within-`staleTime` hole without applying boot chrome to a
  different app/scope route and without an extra request when cached chrome is present. It registers
  the query's refresh with a unique token and unregisters only when that token is still current, so
  an old page unmount cannot clear a newer page's registration. Every page that owns a page query
  uses it: `OverviewPage`, `ProjectsPage`, `ProjectPage`, `AppPage`, `HandoffsPage`, `SettingsPage`,
  `SkillsPage`, `SkillDetailPage`, `SshPage`, `TerminalPage`, `ChatPage`.
- `useChrome.ts` loses `fetchChrome`, `applyChrome`'s `innerHTML`, and the chrome fetch in
  `installChrome`. `installChrome` keeps focus and drawer-close behavior, sets a provisional title
  from the matched route label through a separate non-announcing path, and updates the store's
  current `routeKey` on every navigation. `setChrome` announces when the title **or** routeKey
  changes.
- `installChrome` owns visibility refresh. On `visibilitychange` it sets
  `chromeStore.visibilityRefreshing = true` only when it actually starts a refresh, calls the
  registered primary-query refresh, skips when that query is already fetching, and clears the flag in
  `finally`. Pages use the flag to suppress their existing refreshing hints for this refresh.
  Disable Vue Query's default `refetchOnWindowFocus` for these page queries so a focus does not
  duplicate the registered refresh. Pages without a registered primary query (for example a disabled
  create-mode query) do not refresh; this is recorded as an accepted limit.
- Mutations keep their current behavior: after a successful mutation the page refetches its data and
  `usePageChrome` applies the new chrome. The direct keepalive draft save/delete fetches check the
  response as described in §3.3 before updating `lastSaved`.

### 5.4 Script split

- SPA documents load no `app.js` and no `app-content.js`; only the Vite entry and boot JSON.
- The legacy `/login` document, the SPA login document, and the legacy fallback/error documents keep
  `app.js` (the SPA login is out of scope and keeps its current script behavior); `app-content.js`
  remains legacy-only.
- `main.ts` no longer calls `clearTopbarActions()`; the static `.topbar__actions` starts empty and
  `TopbarActions` owns it.

## 6. First paint and accessibility

- The static shell reserves the sidebar width, topbar height, and page body, so filling the sidebar
  and breadcrumb after mount does not move the page content. The existing `#ui-fallback` reveal is
  unchanged.
- Focus moves to `#main` on navigation, the title is set from `ChromeData.title`, the route
  announcer is updated, and the active nav item and breadcrumb keep `aria-current="page"`.
- The mobile drawer keeps the same open/close/Escape/resize behavior, but its listeners are Vue-owned
  and delegated on `#shell`/`document` so the teleported close button and scrim are both covered.
- The theme toggle keeps `localStorage["hanse-theme"]` and the inline pre-paint script.

## 7. Compatibility and rollout

- This is an internal, unversioned `/api/ui/*` contract change. Hard cutover: no release serves both
  the HTML-fragment and data shapes.
- The `X-Hanse-UI-Version: 2` gate makes an old open tab fail cleanly on its next navigation,
  refetch, or SPA mutation. The new client handles `ui_reload_required` with one guarded full-page
  reload (reusing the `PRELOAD_RELOAD_KEY` one-shot sessionStorage guard and clearing it after a
  successful boot, so a persistent mismatch cannot reload forever). The old bundle cannot special-case
  it, so an old Chat/Terminal tab may show its existing Retry-only error until the user reloads
  manually; this is an accepted legacy-client limitation, not a half-render. A full document load
  from the previous bundle fails `readBoot()` and uses the existing fallback/reload path.
- Rollback is an image rollback, as with the other retired SPA routes.
- No database migration and no new runtime dependency.

## 8. Verification

- `rg "api/ui/chrome|sidebarNav|renderSidebarNavInner|renderBreadcrumbInner" src ui` returns only
  the legacy `appShell()` call sites and docs.
- `rg "applyChrome|innerHTML" ui` returns no chrome DOM injection.
- Unit: boot validation (`ChromeData`, optional operator, login boot), page-response chrome shape,
  `/api/ui/chrome` 404, UI version gate (missing/old header -> `409`, including SPA mutations), no
  `app.js` on SPA documents, legacy/login documents still load it.
- Auth probe: `/api/ui/auth` cookie -> `204` + `no-store`, no cookie -> `401`, human bearer ->
  `403`, agent token -> `403`, no version header -> `204`; chat/terminal probes treat `204` as alive,
  `401`/`403` as expired, and `404`/`409` as alive.
- Navigation: initial route -> navigate away -> navigate back within `staleTime` applies the boot
  chrome (no stale sidebar/title); cached data with chrome does not trigger an extra request;
  chat/terminal app switches and settings/skills scope switches do not apply another route's boot
  chrome, including when the destination fetch fails; same-title route changes are announced; a
  visibility refresh does not show a page refreshing hint; an old page unmount does not clear a newer
  page's refresh registration; a direct draft fetch carries both the version and SPA headers; a
  `ui_reload_required` 409 reloads at most once.
- `routeKey`: server boot and client navigation produce the same key for repeated params, arrays,
  `null`/empty values, and the excluded keys (`legacy`, `notice`, `tone`, `session`); login boot
  includes a `routeKey` computed from the full request query; a same-title query-only navigation
  announces once and a same-route refetch does not; a chat session switch does not change `routeKey`.
- Draft endpoints reject a request without `X-Hanse-UI-Version: 2` even when `X-Hanse-Client` is
  absent (old-tab direct draft writes), after auth, with the same 409 JSON; direct new-client draft
  fetches do not mark a rejected draft as saved.
- UI: sidebar/breadcrumb render from data, active/counters/scoped hrefs, theme toggle, drawer,
  sign-out, no `v-html`; `usePageChrome` immediate/cached and visibility refresh.
- E2E: deep link, refresh, client navigation, back/forward, chrome swap, counters after mutation,
  visibility refetch, no fallback flash, no console/page errors, mobile drawer, chat/terminal
  first-paint after mount, visual parity at 390/768/1440 dark/light.
- Existing fixtures/assertions to update: `test/ui-manifest.test.ts`, `test/ui/shell-scripts.test.ts`,
  `test/ui/boot.test.ts`, `test/ui/composables/useChrome.test.ts`, `test/ui-props-auth.test.ts`,
  `test/ui-props-chat.test.ts`, `test/ui-props-terminal.test.ts`, `test/application-api.test.ts`,
  `test/preview-http.test.ts`, `test/projects-spa-mutation.test.ts`, `test/settings-props.test.ts`,
  `test/skills-props.test.ts`, `test/ssh-props.test.ts`, `test/ui/chat-auth.test.ts`,
  `test/ui/chat-policy.test.ts`, `ui/pages/*.test.ts` boot fixtures, `ui/skills-fixtures.ts`,
  `test/ui/chat-support.ts`, `test/ui/terminal-page.test.ts`, `test/ui/topbar-actions.test.ts`,
  `test/chat-stage-a.test.ts`, `test/chat-page.test.ts`, `test/ui/chat-draft.test.ts`,
  `e2e/spa-*.spec.ts` chrome mocks, and `e2e/spa-chat.spec.ts` first-paint topbar assertions. The
  draft tests cover old-client rejection, new-client headers, and the non-2xx `lastSaved`/reload
  behavior.
- Full gates: `lint`, `typecheck`, `typecheck:ui`, `test`, `build`, `check:ui`, `check:sensitive`,
  `test:e2e`.

## 9. Non-goals

- `/login` SSR, its no-JS form, and the legacy `GET/POST /login` handlers.
- The legacy error/empty/build-missing documents and their `appShell()` chrome.
- A static `ui/index.html` or a separate boot endpoint.
- Moving the icon sprite into Vue.
- Deleting `assets/app.js`/`assets/app-content.js` while legacy login/fallback documents use them.
- Chat/terminal protocol, auth model, SSE, WebSocket, IDE, or preview changes, except the
  `/api/ui/auth` probe replacement in §10.

## 10. Amendment - auth probe replacement (2026-11-09)

The plan review found a hidden dependency: `/api/ui/chrome` is also the cookie-only session probe
used by the chat stream and terminal socket:

- `ui/chat/stream.ts:209` - `/api/ui/chrome?path=/chat`
- `ui/terminal/socket.ts:255` - `/api/ui/chrome?path=/terminal`

Both probes treat only `401`/`403` as auth expiry. Removing the endpoint would return `404`, which
they treat as "still alive", so an expired session would stop redirecting to `/login`. The unit tests
mock `fetch`, so this would be a silent production regression.

Add a dedicated, data-free probe instead of keeping the chrome endpoint:

- `GET /api/ui/auth` - cookie-only (`authorizeUiRead`), `204 No Content` when authorized (a no-body
  response, not `jsonResponse`), the existing `401`/`403` semantics otherwise, `Cache-Control:
  no-store` (including the agent-token `403`; add it if `agentForbidden()` does not set it).
- Add `/api/ui/auth` to `UI_API_PATHS` (or handle it before the membership check) and dispatch it
  immediately after `authorizeUiRead`, **before** the version gate and before
  `logUnknownRoutes`/`buildSite`, so a data-free probe does not build the site.
- It carries no data shape and is therefore **not** version-gated. A probe request without
  `X-Hanse-UI-Version: 2` gets `204`, not `409`. This preserves the new probe's auth-expiry
  detection; pre-cutover bundles still call the removed `/api/ui/chrome` and fall under §7's accepted
  old-tab limitation.
- Replace both probe URLs with `/api/ui/auth`; update the source comments, `test/ui/chat-auth.test.ts`,
  `test/ui/terminal-socket.test.ts`, and `e2e/terminal.spec.ts`.
- Add server tests: cookie -> `204` + `no-store`; no cookie -> `401`; human bearer -> `403`; agent
  token -> `403`; no `X-Hanse-UI-Version` -> `204` (not `409`). Probe tests assert `204` -> alive,
  `401`/`403` -> expired, and `404`/`409` -> alive (regression guard); the terminal harness default
  becomes `authStatus: 204`.
- The chat/terminal protocol, auth model, SSE, and WebSocket behavior are unchanged; only the
  probe endpoint moves.

This is a necessary consequence of deleting `/api/ui/chrome`, not a chat/terminal protocol change.
The verification `rg` check must confirm no `api/ui/chrome` reference remains in `src` or `ui`.

## 11. Review history

- Revision 1 - initial design; Oracle review returned CHANGES REQUESTED (hard-cutover old-tab
  half-render, page chrome not refreshed on navigation, login boot contract, static shell classes,
  `data-nav-id` contract, topbar first paint, broad visibility refetch, test plan gaps, plus minors).
- Revision 2 - adds the UI version gate, `usePageChrome` and per-page registration, optional operator
  and login boot data, `pageClass`/`bodyClass`/`viewport` in `spaShell`, explicit target-attribute
  ownership, removal of the server topbar seed, primary-query visibility refresh, the concrete test
  list, and the minor clarifications.
- Revision 3 - Oracle round 2 findings folded: boot-chrome fallback for boot-seeded cached data,
  token-safe refresh registration, visibility-refresh hint suppression, announce-only-on-title-change,
  single `#shell` attribute owner, explicit scoped-href fallbacks, mutation version gate, empty-safe
  shell classes, and the expanded test list.
- Revision 4 - Oracle round 3 findings folded: `routeKey` boot identity for query-scoped routes,
  undefined-data guard for the forced refetch, version headers on direct draft fetches, one
  `visibilityRefreshing` owner, guarded reload for `ui_reload_required`, route-change announcements
  for same-title navigations, and the added navigation/version tests.
- Revision 5 - Oracle round 4 findings folded: login boot `routeKey`, explicit `usePageChrome`
  precedence (no refetch when chrome is present), `X-Hanse-Client: spa` on direct draft fetches,
  consistent title-or-routeKey announcement, `setChrome(chrome, routeKey)` and `setRouteKey` ownership,
  and the canonical `routeKey` normalization rules.
- Revision 6 - Oracle round 5 findings folded: separate `currentRouteKey` and
  `lastAnnouncedRouteKey` so routeKey-change announcements survive `setRouteKey`, a path-based
  version gate for the draft endpoints (covering old-tab direct writes), and a full-request-query
  login boot `routeKey`.
- Revision 7 - Oracle round 6 findings folded: `session` excluded from `routeKey`, direct draft
  fetches check the 409/`lastSaved` behavior, the draft gate runs after auth with the UI-API error
  shape, the draft test files are listed, and the `setChrome` comparison wording is corrected.
- 2026-11-09 - Oracle round 7 **PASS**. No blocking findings; one non-blocking wording note in
  `§5.3` (the authoritative rule is in `§5.1`). Design approved; plan review is next.
- 2026-11-09 - Plan review found the chat/terminal auth probe dependency; §10 amendment added.
  Targeted Oracle review returned CHANGES REQUESTED (version-gate exemption unspecified, old-probe
  claim inaccurate, missing server tests, §9 non-goal wording). Revision 8 folds those findings;
  targeted Oracle re-review **PASS**. Plan 0040 approved by `momus` round 3 (minor notes folded in
  plan revision 4).
