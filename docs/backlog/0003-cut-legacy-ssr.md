# 0003 - Cut the legacy SSR renderer and its rollback path

Status: done for all non-login routes (2026-11-08); the `/login` rollback and the shared error/login shell intentionally remain
Created: 2026-11-08
Priority: medium (removes a second UI implementation, its rollback surface, and the last per-request HTML rendering)

## Problem

Every product page is already a Vue SPA, but the coordinator still ships and can still serve the
old fully server-rendered UI. Two renderers, two client-script sets, shared props, extra tests, and
rollback flags have to be maintained for a path that is only a fallback.

## Clarification: the SPA is CSR, not SSR

The Vue app is client-rendered: the server sends a document, a boot JSON payload, and a shell, then
Vue mounts into `#main` and renders the page. There is no server-side Vue rendering and no
hydration. The only server-rendered pieces left on an SPA document are:

- the document shell: sidebar, topbar, breadcrumb, toast region;
- per-request chrome fragments from `GET /api/ui/chrome?path=`;
- the login plate, kept inside `#main` as a no-JS fallback before Vue replaces it.

"Legacy SSR" below means the separate old renderer that renders full pages with `app-content.js`,
not the SPA shell.

## Completed

The rollback was cut for every route except `/login`: those routes are `legacyRetired: true`, the
legacy page renderers and their client assets/tests were deleted, and `HANSE_UI_LEGACY`,
`?legacy=1`, and `HANSE_UI_SPA_ROUTES` now affect only `/login`. The remaining shell, error pages,
and login form are shared with the SPA or are the requested auth rollback.

## Current state

- SPA routes: `overview`, `projects`, `project`, `app`, `handoffs`, `ssh`, the three settings
  scopes, the five skills routes, `chat`, `terminal`, and `login`. Chat and terminal are
  `legacyRetired: true`; `login` is `public: true`.
- Every other route still falls back to the legacy renderer through `HANSE_UI_LEGACY=1`,
  `?legacy=1`, `HANSE_UI_SPA_ROUTES`, or a missing/invalid UI manifest (`ui.manifest_invalid`).
- Legacy renderers still exist for the application page, overview, projects, project, handoffs,
  SSH, settings, skills, not-found/error pages, and the chat no-apps state.
- Legacy clients still exist: `assets/git.js`, `images.js`, `ssh.js`, `settings.js`,
  `git-settings.js`, `handoff.js`, `skill-detail.js`, and `app-content.js`, plus their allowlist in
  `src/http/handler.ts`.
- Playwright still carries the `legacy` and `allowlist-empty` projects to exercise that path.

## Remaining work

1. **Decide shell ownership.** Recommended: move the sidebar, topbar, breadcrumb, toast region, and
   icon sprite into Vue and leave the server serving only the document plus boot/JSON endpoints.
   Then remove `GET /api/ui/chrome`, `ui/composables/useChrome.ts`, and the `chrome`/`topbar`/
   `spaRoutes` boot fields that exist only for the server shell. Alternative: keep a static server
   shell with no per-request data and document it as intentional; that still is not "no SSR", so
   the decision must be explicit.
2. **Move the remaining server-only states into Vue.** Chat with no applications currently uses
   `renderNoApps`; 404 and 500 use `renderNotFound`/`renderErrorPage`; a missing UI build uses
   `uiBuildMissing`. The client already has `RouteErrorPage` and `NotImplementedPage`; decide which
   of these become Vue routes and which become a static error document.
3. **Replace the login rollback.** The SPA login document keeps the old server-rendered plate as a
   no-JS fallback. Decide whether that stays as progressive enhancement or login becomes
   JS-required; then delete `loginPage`/`post /login` HTML branches if it goes.
4. **Delete legacy renderers.** Remove `renderApplication`, the page renderers in
   `dashboard.ts`, `settings.ts`, `skills.ts`, `ssh.ts`, and the legacy shell/login pieces in
   `ui.ts`. Keep the `src/http/props/*` assemblies that still back `/api/ui/*`.
5. **Delete legacy assets and their handler allowlist.** Remove the legacy-only clients above.
   Audit shared ones before deleting: `assets/markdown.js` and the `chat-*` assets are used by the
   Vue client.
6. **Remove the rollback machinery.** Drop `HANSE_UI_LEGACY`, `?legacy=1`, and
   `HANSE_UI_SPA_ROUTES`; drop the registry `spa`, `legacyRetired`, and `public` flags once every
   route is always SPA; remove the `legacyAvailable`/`fallbackHref` boot fields, the legacy
   dispatcher branches, and the "manifest missing means legacy" rule. Define what a missing UI build
   shows instead (static error, not a legacy page).
7. **Simplify the server page path.** `maybeServeSpa` becomes a static-document/SPA dispatcher:
   match a route, enforce the human cookie redirect, serve the document. The legacy `GET` fallback
   in `handler.ts` goes away.
8. **Trim the test matrix.** Delete the `legacy` and `allowlist-empty` Playwright projects and the
   legacy-only assertions and `?legacy=1` cases. Keep and extend the `spa` project; add coverage for
   the new static error/build-missing behavior.
9. **Update docs.** `docs/current-state.md`, `docs/deployment.md`, `README.md`, and `DESIGN.md` for
   the shell change; remove rollback instructions from the deployment guide.

## Non-goals

- Do not introduce SSR or hydration; the target is CSR plus a static document.
- Do not change the auth model: the session stays in the `HttpOnly; SameSite=Strict` cookie; no
  token moves to localStorage; SPA documents and `/api/ui/*` stay cookie-only.
- Do not change URLs, page data, copy, or test-facing ids unless a step above requires it.
- Do not delete shared props assemblies or shared assets that the Vue client uses.
- Do not change SSE, WebSocket terminal, or IDE proxy authentication.

## Acceptance criteria

- No runtime input can serve a full server-rendered legacy page.
- The legacy-only assets can be deleted without breaking any page or test.
- The server no longer renders page content; if a static shell remains, it is documented as static
  and contains no per-request data.
- A missing UI build, 404, 500, and chat-with-no-apps have defined SPA/static behavior.
- Cookie auth, `/api/ui/*`, SSE, terminal, and IDE still work unchanged.
- `lint`, `check:sensitive`, all typechecks, unit tests, `build`, `check:ui`, and the full E2E matrix
  pass without the `legacy` and `allowlist-empty` projects.

## Risks and ordering

- Moving chrome into Vue changes first paint, focus handling, and several E2E assertions; do it as
  its own stage with visual/E2E checks.
- Removing the no-JS login fallback changes the login contract; decide explicitly rather than as a
  side effect.
- `src/http/props/*` is shared by `/api/ui/*`; delete renderers, not assemblies.
- `AppIcon` currently depends on the server-provided SVG sprite; the shell change must keep or
  replace it.

## References

- `docs/current-state.md` - "UI rendering modes" and the auth section.
- `src/http/spa.ts` - dispatcher, boot document, public login document.
- `src/http/ui.ts` - server shell, login plate, icon sprite.
- `src/http/application.ts`, `dashboard.ts`, `settings.ts`, `skills.ts`, `ssh.ts`, `chat.ts` - legacy
  page renderers.
- `src/http/handler.ts` - legacy page fallback and asset allowlist.
- `playwright.config.ts`, `e2e/support/route-ids.ts` - legacy and allowlist test projects.
