# 0049 - Zero SSR

Status: **implemented**; stage-targeted verification green. The full repository gate is temporarily
red because unrelated notification-stage changes are present in the same working tree.
Design: [Zero SSR](../design/zero-ssr.md) (Oracle round 2 PASS WITH FIXES; findings folded).
Plan: [0042 - Zero SSR](../plans/0042-zero-ssr.md) (`momus` OKAY).
Baseline: commit `6aca092`.
Mode: **B** - intentional internal HTTP/boot contract change.

## Scope

Remove the last server-rendered page/chrome path: the `/login` server plate and form,
`appShell()` error/login documents, `app.js`/`app-content.js`, and the
`HANSE_UI_LEGACY`/`?legacy=1`/`HANSE_UI_SPA_ROUTES` rollback machinery. Login becomes JS-required;
unknown/missing resources become a Vue 404; 500 and missing-UI-build become self-contained static
HTML; chat with no operator apps becomes a Vue state.

## What changed

- **Route registry.** Added the synthetic `not-found` route id (excluded from `COMPILED`), removed
  the `spa`/`legacyRetired` flags and their helpers, kept `public` for `/login`, removed `legacy`
  from `routeKey` exclusions, and added `isPagePath()` with known-page precedence over the static
  extension heuristic.
- **Static document.** `documentPage()` no longer emits `app.js` or `app-content.js`; the login
  document is an empty `<main>` plus a `<noscript>` notice. `spaShell()` fallback is a static
  reload link (`href=""`). The icon sprite, `app.css`, module entry, and boot JSON remain.
- **Login.** `GET /login` is served by `maybeServeSpa()` with an authenticated redirect, static 503
  on a missing UI build, and a JS-required login document. `POST /login` returns 405
  (`Allow: GET, HEAD`); `POST /api/session`, `POST /logout`, and cookie auth are unchanged.
- **404.** Unknown page-like paths and known missing resources serve a 404 SPA document with
  `override: "not-found"`; `NotFoundPage.vue` renders the unified page. `App.vue` keys the override
  to the boot URL, skips the initial navigation, and clears it on a real route change. A
  client-side history return to a known missing resource may show the page's own not-found card;
  a full reload restores the unified 404.
- **Static failures.** New `static-error.ts` serves self-contained 404/405/500/503 documents with
  inline CSS, no external assets, `no-store`, CSP (including `frame-ancestors 'none'`), nosniff, and
  no-referrer. `server.ts` catches synchronous page-dispatch failures and the promise chain returns
  static HTML 500 for page requests; API failures stay JSON.
- **Chat no-apps.** `renderNoApps()` is deleted. `/chat` with no app redirects to the first operator
  app; with no operator apps it serves a chat SPA document with `override: "chat-no-apps"`.
  `ChatNoAppsPage.vue` shows "No applications yet" and the always-present master-chat link.
  `ChatPage.vue` also handles `noApps` for history navigation.
- **Client routing.** `ui/spa-routes.ts` and the installed-route set are deleted; `SmartLink` uses
  `matchPage()`. The router guard allows the catch-all for page-like unknown paths but full-loads
  non-page paths. `?legacy=1` is a normal ignored query parameter.
- **Deletion.** Removed `appShell()`, `loginPage()`, `loginPlate()`, `renderNotFound()`,
  `renderErrorPage()`, `renderNoApps()`, `uiBuildMissing()`, `retiredEntryPage()`, `pageChrome()`,
  the legacy shell helpers, `assets/app.js`, `assets/app-content.js`, their allowlist entries,
  `test/app-js-split.test.ts`, and `e2e/support/route-ids.ts`.
- **Docs/config.** Updated `AGENTS.md`, `.env.example`, `docs/current-state.md`,
  `docs/deployment.md`, `README.md`, `DESIGN.md`, the backlog, and the design/plan indexes. Removed
  `HANSE_UI_LEGACY` from `vitest.config.ts` and `HANSE_UI_LEGACY`/`HANSE_UI_SPA_ROUTES` from
  `playwright.config.ts`.

## Verification

Stage-targeted and UI gates:

- `npm run lint` - pass (883 files).
- `npm run typecheck` - pass.
- `npm run typecheck:ui` - pass.
- Targeted zero-SSR suites - 175 passed (routes, boot, router guard, terminal route, login, retired
  routes, HTTP login/404/assets, UI auth, shell scripts, manifest, SmartLink, useChrome, skills/app/
  settings/ssh props).
- `npx vitest run --project ui` - 74 files, 595 tests passed.
- `npm run build` - pass; 297 modules, Vite ~10 s. Warning: `NotFoundPage.vue` is both statically
  imported by `App.vue` and dynamically by the router; harmless.
- `npm run check:ui` - pass (84 SFCs, sentinel present; chat chunk 82,498 B gzip).
- `npm run check:sensitive` - pass.
- `npm run test:e2e` - 133 passed / 1 skipped / 1 failed. The only failure is
  `e2e/settings.spec.ts:101` (provider-key toast stayed empty), which passes when run alone and is
  outside this stage's changed surface. Auth, Vue 404, chat no-apps, fallback, terminal, and context
  rail E2E all pass.

Full server suite: 174 files passed / 8 failed; 3,102 tests passed / 11 failed. All 11 failures are
in the concurrently modified notification/migration-v26 surface (`commands`, `deploy-http`,
`http` readiness, `migrate-cli`, `settings-props` notifications, `settings-store` v3,
`skills-store` v13, `store` v13). They are not caused by this stage; the same working tree contains
unrelated uncommitted changes (migration v26, Telegram settings, coordinator/chat/settings edits)
that must land or be reverted before the repository-wide gate can be green.

## Contract verdict

Intentional internal cutover. `/login` is now a static SPA document; `POST /login` is 405;
`POST /api/session` is the only login mutation. Unknown/missing page resources are Vue 404s when the
UI is available; 500/503 are static and independent of the build. The cookie-only auth model,
`/api/ui/*`, SSE, terminal, IDE, and preview contracts are unchanged.

## Accepted limits

- Client-side history back to a known missing resource can show the page's own not-found card after
  the boot override clears; a full reload restores `NotFoundPage`.
- Old cached `POST /login` forms receive 405; image rollback is the recovery.
- No-JS is unsupported as a system requirement; `<noscript>` is informational.
- The static 500/503 pages intentionally do not load `app.css`, the icon sprite, or Vue.
- `e2e/settings.spec.ts:101` is flaky in the full matrix and is outside this stage.

## Next

- Land or isolate the concurrent notification-stage changes, then rerun the full server suite and
  E2E matrix.
- Commit this stage only after explicit owner approval, staging only the zero-SSR files; do not
  include the concurrent notification changes.
