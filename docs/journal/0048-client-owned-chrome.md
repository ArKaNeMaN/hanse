# 0048 - Client-owned application chrome

Status: **implemented and verified** (2026-11-09). No commit yet.
Design: [Client-owned application chrome](../design/client-owned-chrome.md) (Oracle round 7 PASS;
§10 auth-probe amendment PASS).
Plan: [0040 - Client-owned application chrome](../plans/0040-client-owned-chrome.md) (`momus` PASS).
Baseline: commit `8748ae6`; pre-existing untracked `recovered-plugin-draft-2026-11-04.txt`.
Mode: **B** - intentional internal `/api/ui/*` contract change.

## Scope

Remove the server-rendered chrome fragment contract from every SPA document: delete
`GET /api/ui/chrome`, replace the `chrome` payload's HTML strings with data, and render the sidebar,
breadcrumb, title, counters, theme, drawer, and sign-out in Vue. `/login` SSR and the legacy
`appShell()` fallback/error documents remain out of scope.

## What changed

- **Data contract.** `ChromeData` is data-only (`title`, `active`, `activeProjectId`, `breadcrumb`,
  non-master `projects`, `masterHref`, counters, scoped settings/skills hrefs). `ChromeProps` and
  `ChromeData.chrome` are deleted. Boot JSON carries `ChromeData`, `routeKey`, and optional
  `operator`; every `/api/ui/*` page response carries `{ ...props, chrome: ChromeData }`.
- **Server document.** `spaShell()` emits a static shell with empty `#sidebar`,
  `#breadcrumb-host`, and `.topbar__actions`, static nav toggle/scrim, skip link, route announcer,
  hidden `#ui-fallback`, `#toast-region`, and `pageClass`/`bodyClass`/`viewport`. Authenticated SPA
  documents omit `app.js` and `app-content.js`; legacy/login/fallback documents keep them.
  `renderSpaDocument()` no longer calls `appShell()`. The server chat topbar seed,
  `renderChatTopbarActions`, `topbarActions`, `clearTopbarActions`, and `ui/topbar.ts` are removed.
- **Client chrome.** `ui/stores/chrome.ts` owns `ChromeData`, `currentRouteKey`,
  `lastAnnouncedRouteKey`, operator, and visibility refresh; `ui/stores/shell.ts` owns the drawer and
  `#shell` attributes; `ui/stores/theme.ts` owns the theme. `AppSidebar.vue` and `BreadcrumbBar.vue`
  render the chrome from data, using `SmartLink`, encoded project hrefs, scoped/fallback
  settings/skills links, operator identity, theme, and sign-out. `usePageChrome` applies cached
  chrome, the boot chrome for the boot route, one refetch when data exists without chrome, and leaves
  undefined data to the normal fetch. All page queries use it, set `refetchOnWindowFocus: false`, and
  suppress refreshing hints while a visibility refresh is in flight.
- **Auth probe.** `GET /api/ui/chrome` was also the chat/terminal cookie-only session probe. A new
  data-free `GET /api/ui/auth` returns `204`/`401`/`403` with `no-store`, is not version-gated, and is
  used by `ui/chat/stream.ts` and `ui/terminal/socket.ts`.
- **Hard cutover.** `GET /api/ui/chrome` returns `404`. `/api/ui/*` page endpoints and SPA mutations
  require `X-Hanse-UI-Version: 2`; draft `PUT`/delete-if-empty `POST` require it regardless of
  `X-Hanse-Client`. A missing/different version returns
  `409 { error, code: "ui_reload_required" }` with `no-store`. The client sends the header on
  `apiQuery`/`apiMutation` and direct draft fetches, and uses one guarded reload for
  `ui_reload_required`; the guard clears after a successful boot. `src/http/server.ts` forwards the
  header through the `HttpRequest` allowlist.

## Verification

Baseline and implementation gates:

- `npm run lint` - 862 files, clean.
- `npm run typecheck` - pass.
- `npm run typecheck:ui` - pass.
- `npm test` - 253 files passed / 1 skipped; 3,685 tests passed / 1 skipped.
- `npm run build` - pass; Vite built in ~7.5 s.
- `npm run check:ui` - pass (82 SFCs, sentinel present; chat chunk ~82 kB gzip).
- `npm run check:sensitive` - pass.
- `npm run test:e2e` - 130 passed / 1 skipped, 0 failed.
- Targeted Step 2/3/4 suites: chrome/boot/probe/draft/version tests all pass.
- `rg -n "api/ui/chrome" src ui` - empty; the only remaining reference is the 404 regression test
  under `test/`.
- `rg -n "sidebarNav|renderSidebarNavInner|renderBreadcrumbInner" src ui` - only the legacy
  `appShell()` internals in `src/http/ui.ts` remain.

## Contract verdict

The change is intentional and internal: `/api/ui/chrome` is removed, `ChromeData` is data-only, and
old clients fail cleanly through `ui_reload_required` rather than receiving a half-rendered chrome.
The cookie-only auth posture is unchanged; the new `/api/ui/auth` probe is data-free and exempt from
the version gate.

## Accepted limits

- A pre-cutover Chat/Terminal tab still calls the removed `/api/ui/chrome`; it falls under the
  accepted old-tab limitation and may show its existing Retry-only error until manually reloaded.
- `/login` keeps its server-rendered form fallback and the SPA login document keeps `app.js`.
- The legacy `appShell()` error/empty/build-missing documents still use server-rendered chrome.
- The icon sprite remains static server markup; there is no `ui/index.html` or separate boot endpoint.
- `assets/app.js`/`app-content.js` remain for legacy login/fallback documents.

## Next

- Remove the remaining SSR surfaces: `/login`, the legacy `appShell()` fallback/error pages, and the
  server-owned icon sprite; optionally replace the document with a static `ui/index.html`.
- Delete `assets/app.js`/`app-content.js` once legacy login/fallback no longer need them.
