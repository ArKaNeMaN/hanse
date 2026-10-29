# 0038 - Incremental SPA migration: Phase 0 harness and Phase 1A infrastructure

Status: **in progress** - Phase 0 complete (2026-10-28); Phase 1A complete, flag off (2026-10-28);
Phase 1B complete, `/projects` cut over (2026-10-28); Phase 2 complete, `/` and `/projects/:id`
cut over (2026-10-29); Phase 3 complete, `/handoffs` cut over (2026-10-29); Phase 4 (`/ssh`) next.
Design: [Incremental SPA migration](../design/spa-migration.md) (approved, `oracle` round 5 PASS).
Plan: [0031 - Incremental SPA migration](../plans/0031-spa-migration.md) (`momus` round 3 PASS).
Owner decisions: [open questions](../open-questions.md), 2026-10-28.

## Scope

This stage starts the route-by-route migration from server-rendered HTML to a Vue 3 client. Phase 0
builds the safety net only: a deterministic coordinator fixture, Playwright E2E, a jsdom Vitest
project, and CI wiring. It deliberately does not add Vue, Vite, `assets/ui`, a route cutover, or any
production behavior change.

## Baseline

- Commit `af49aae`; clean tree; Node 22.23.4.
- `lint` (332 files), `typecheck`, `build`, `check:sensitive`: green.
- `npm test`: 135 files / 2657 tests green (205.85 s).

## Phase 0 implementation

- **Tooling.** `@playwright/test@1.64.1` and `jsdom@26.1.0` are root devDependencies.
  `npm run test:e2e` runs `npm run build && playwright test`; `test:ui` runs the Vitest `ui`
  project; `typecheck:e2e` uses `tsconfig.e2e.json` (`module: ESNext`, `moduleResolution: Bundler`,
  `target: ES2022`, `types: ["node"]`).
- **Vitest projects.** `server` runs `test/**/*.test.ts` + `test/**/*.test.mjs` with
  `HANSE_UI_LEGACY=1`, excluding `test/ui/**` and `test/fixtures/**`; `ui` runs
  `ui/**/*.test.ts` + `test/ui/**/*.test.ts` under jsdom with `test/ui/setup.ts`. `extends: true`
  preserves the repository's 15 s timeout.
- **Fixture server.** `e2e/support/seed.ts` creates a temp workspace, SQLite DB, two synthetic
  projects, three fixture git repos (one commit each), a `test-operator-token` human, three settings
  rows, two skill bundles, one SSH host/grant/audit row, and one handoff. `e2e/support/server.ts`
  builds the real `HttpDeps` + `createHttpServer`; `GitService`, `SettingsService`, `SkillService`,
  and SSH host/grant CRUD are real; the manager/opencode boundary and image status/logs are
  read-only stubs.
- **Playwright.** Three fixed servers/projects: SPA `4310`, legacy `4311` (`HANSE_UI_LEGACY=1`),
  empty-allowlist `4312` (`HANSE_UI_SPA_ROUTES=""`); `workers: 1`, `fullyParallel: false`,
  `reuseExistingServer` only with `HANSE_E2E_REUSE=1`; system Chromium via
  `PLAYWRIGHT_CHROMIUM`, bundled Chromium in CI, with `--no-sandbox --disable-dev-shm-usage`.
- **Specs (legacy mode).** `auth`, `projects` (including the one Phase 0 mutation, create project
  with a `303` + notice), `project-detail`, `app`, `handoffs`, `settings` (including a real form
  save), `skills`, `ssh`, `error`; SPA/empty-allowlist run a skipped placeholder until Phase 1B.
- **CI.** `verify` also runs `typecheck:e2e`; a separate `e2e` job installs Chromium and runs
  `npm run test:e2e`; a Node 20.19/22 `npm ci` + `npm run build` matrix proves the documented floor.

## Verification

| Command | Result |
| --- | --- |
| `npm run lint` | 349 files, exit 0 |
| `npm run typecheck` | exit 0 |
| `npm run typecheck:e2e` | exit 0 |
| `npm test` | 136 files / 2658 tests, exit 0 |
| `npm run build` | exit 0 |
| `npm run check:sensitive` | exit 0 |
| `npm run test:e2e` | 12 passed / 2 skipped, 25.5 s, exit 0 |

Commands ran with `NODE_ENV=development` and `PLAYWRIGHT_CHROMIUM=/usr/bin/chromium` in this
sandbox; the session shell exports `NODE_ENV=production`, which makes npm prune devDependencies.

## Deviations and accepted limits

- Deletion, previews, the handoff dispatcher, and chat/SSE are intentionally **unconfigured** in the
  fixture; their routes keep the existing `503` contract. Phase 0 specs do not call them. Phase 2
  adds the fake deletion service for the deletion contract test; later phases add the other
  boundaries as their flows are exercised.
- The image service is a read-only stub (`status`/`logs`) because the app page needs a stable image
  view. Build/rollback/check remain unconfigured until Phase 7.
- The styled-404 spec ignores only the expected `status of 404` resource console line; any other
  console/page error still fails the spec.
- No `src/**` or `assets/**` change; the diff is tests, config, scripts, CI, dependencies, and docs.
- No commit.

## Phase 1A implementation (infrastructure, flag off)

Phase 1A adds the SPA infrastructure without enabling a route. Every registry `spa` flag remains
`false`; the production default is the legacy renderer.

- **Shell/content split.** `assets/app.js` keeps the drawer, theme, and nav; `assets/app-content.js`
  owns dialogs, menus, segmented controls, toast close/autodismiss, password visibility, and
  submit-busy. Legacy pages and `/login` load both in order; SPA documents load only `app.js`.
- **Auth and request plumbing.** `humanFromCookie()` accepts only a human session cookie;
  `humanFrom()` still serves legacy pages and bearer APIs. `createHttpServer` passes
  `x-hanse-client` through `HttpRequest`.
- **Shared route registry.** `src/shared/routes.ts` is pure and covers the 14 page ids, `matchPage`
  precedence (`/skills/new` before `/skills/:id`), `isSpaRoute` precedence (`HANSE_UI_LEGACY` >
  manifest validity > `HANSE_UI_SPA_ROUTES` > registry flag), and `isSpaPath`.
- **Props and chrome.** `src/http/props/projects.ts` is shared by the legacy `renderProjects` and
  `GET /api/ui/projects`. `renderSidebarNavInner`/`renderBreadcrumbInner` produce the chrome
  fragments; the shell gains `#sidebar-nav`, `#breadcrumb-host`, `#route-announcer`, `data-nav-id`,
  and `data-project-id`.
- **SPA dispatcher.** `src/http/spa.ts` validates `assets/ui/.vite/manifest.json` (entry, imports,
  files, CSS), fails closed to legacy, serializes boot JSON with `<` escaped, supports
  `HANSE_UI_DEV_URL` module URLs, and serves cookie-only `/api/ui/projects` + `/api/ui/chrome` with
  `no-store`, 401/403 status parity, and agent-token rejection.
- **Vue/Vite scaffold.** `ui/` contains boot parsing/validation, Vue Router + Pinia + Vue Query,
  `SmartLink`, `ToastHost`, chrome refresh, preload-error handling, and a `/projects` placeholder.
  No route is cut over; the placeholder is only for the dev smoke.
- **Build/tooling.** `build:ui` (Vite), `dev:ui`, `dev:css`, `typecheck:ui`, `test:ui`, `check:ui`,
  and optional `check:ui-dev`; `build` is `tsc && build:css && build:ui`. Tailwind scans `ui/`;
  `#ui-fallback` reveals after 4 s; `hanse-ui-sentinel` guards the built CSS. Docker, CI (E2E and
  Node 20.19/22 matrix), `.env.example`, and docs are updated; Node floor is `>=20.19.0`.

## Phase 1A verification

| Command | Result |
| --- | --- |
| `npm run lint` | 526 files, exit 0 (18 pre-existing QA warnings) |
| `npm run typecheck` | exit 0 |
| `npm run typecheck:ui` | exit 0 |
| `npm run typecheck:e2e` | exit 0 |
| `npm test` | 145 files / 2733 tests, exit 0 (independent rerun) |
| `npm run build` | exit 0; `assets/ui/.vite/manifest.json` entry `main.ts` (independent rerun) |
| `npm run check:sensitive` | exit 0 |
| `npm run check:ui` | exit 0 (5 SFCs, sentinel present) |
| `npm run check:ui-dev` | exit 0 (`GET /assets/ui/main.ts` -> 200) |
| `npm run test:e2e` | 12 passed / 2 skipped, exit 0 (legacy + placeholders; independent rerun) |

The independent post-implementation review found and fixed a latent `chromeFor` bug: a
`skills-detail` id must not become a project id in scoped Settings/Skills links. A regression test
was added to `test/ui-props-auth.test.ts`. The Vue placeholder now keeps its props type local so
`ui/` imports only the pure shared route module.

After that review, `test/ui-props-auth.test.ts` (19), `test/shared-routes.test.ts` (12),
`test/projects-props.test.ts` (5), and the three UI component files (9) passed; `build:css`,
`build:ui`, and `check:ui` also passed. The sandbox then exhausted its process/thread limit during
repeated suites; the deployment handoff raised the limit and cleared the zombie processes, after
which the full gate reran green: `lint`, both typechecks plus `typecheck:e2e`, `test`
(145 files / 2733 tests), `build`, `check:sensitive`, `check:ui`, and `test:e2e` (12 passed /
2 skipped). No commit was made.

## Phase 1B implementation (`/projects` cutover)

The first route is fully client-rendered. `projects` stays the only `spa: true` registry flag;
`/`, `/projects/:id`, and every later route remain legacy, and the backend mutation contract was not
changed.

- **Page.** `ui/pages/ProjectsPage.vue` reproduces the legacy header (Workbench overline, title,
  description, counts, header action only when `projectCount > 0`), `.page__body`, search toolbar,
  six-column `table.table--stack` ledger, both empty states, deletion status, `<time>` tags, and the
  native `#new-project` dialog. Boot props render immediately; Vue Query is keyed on `?q=` with
  placeholder/previous data, `staleTime`, a non-blocking refetch indicator, and an inline error state
  with Retry and `?legacy=1`. Search pushes `/projects?q=`; route changes (including history) refetch.
  Create success full-loads `/projects/:id?notice=Project+created.&tone=success` (the detail page is
  still legacy, so its server notice renders); failures keep the dialog open and raise an error
  toast. No `<style>`, no `v-html`; icons use the server sprite.
- **Client plumbing.** `ui/api.ts` has framework-free `apiQuery`/`apiMutation` with same-origin
  credentials, `X-Hanse-Client: spa`, form vs JSON bodies, typed `ApiError`, and a 401 redirect to
  `/login?next=<current local path>`. `useChrome` swaps `#sidebar-nav`/`#breadcrumb-host`, sets the
  title, focuses `#main`, resets `.page` scroll, announces, closes the mobile drawer, refreshes chrome
  on visibility, and skips the initial route to avoid a double fetch. `App.vue` adds a route error
  view with reload and a legacy link.
- **Server fixes found by the gate.** `/assets/ui/*` was not served at all, so every SPA document
  fell back after 4 s. `handler.ts` now serves the Vite output with immutable caching and
  path-traversal rejection. S16 is measured from browser transfer bytes, and the coordinator did not
  compress; `server.ts` now gzip-encodes compressible responses when the client offers gzip (bodies
  over 1 KiB). Neither change touches route flags or the mutation handler.
- **Tests.** `ProjectsPage` (9), `api` (6), and `useChrome` (4) component tests are new or rewritten;
  existing `SmartLink`/`ToastHost` tests stay green. `projects.spec.ts` runs in the `spa`, `legacy`,
  and `allowlist-empty` projects and asserts the mode-specific document marker plus SPA `200` JSON
  vs legacy `303`. `spa-projects.spec.ts` covers deep link, refresh, back/forward, chrome swap, the
  project-detail boundary, `?legacy=1`, the legacy/empty-allowlist rollback servers, a failing entry
  fallback, no fallback flash, no console/page errors, transfer, and CLS. The skipped placeholder
  spec was removed.
- **Visual parity.** Computed styles for the header, toolbar, card, table, and row cells and the
  `main` element structure match the legacy page at 390/768/1440 in dark and light; no horizontal
  overflow.

## Phase 1B verification

Commands ran with `NODE_ENV=development` and `PLAYWRIGHT_CHROMIUM=/usr/bin/chromium`.

| Command | Result |
| --- | --- |
| `npm run lint` | 534 files, exit 0 (18 pre-existing warnings) |
| `npm run typecheck` | exit 0 |
| `npm run typecheck:ui` | exit 0 |
| `npm run typecheck:e2e` | exit 0 |
| `npm test` | 148 files / 2758 tests, exit 0 |
| `npm run build` | exit 0; entry `main-CpLYRRzu.js`, route `ProjectsPage-81obvjoX.js` |
| `npm run check:sensitive` | exit 0 |
| `npm run check:ui` | exit 0 (7 SFCs, sentinel present) |
| `npm run test:e2e` | 26 passed, exit 0 (spa 10, legacy 13, allowlist-empty 3) |

Measured on the deterministic fixture: `/projects` first load = document 4,638 + CSS 27,635 +
entry 98,834 + route chunk 8,821 = **139,928 bytes** (limit 204,800); **CLS 0.0** (limit 0.1).

## Phase 2B implementation (`/` cutover)

The fleet overview is the second client-rendered route. The registry now has `spa: true` for
`overview` and `projects`; `project` and every later route stay `spa: false`, so `/projects/:id`
remains a legacy document. Phase 2A props/endpoints were already in place.

- **Page.** `ui/pages/OverviewPage.vue` reproduces the legacy header (Workbench overline, fleet
  title/description/counts, header action only when projects exist), the four-cell `watch-strip`,
  project ledger with `SmartLink`s to the legacy detail route, recent handoffs, waiting-for-approval
  `route-card`s, the runtime summary, both empty states, and the new-project dialog. Boot props
  render immediately; Vue Query uses `/api/ui/overview` with a non-blocking refresh indicator and an
  inline error state with Retry and `?legacy=1`. No `<style>`, no `v-html`; icons use the server
  sprite.
- **Shared client pieces.** `NewProjectDialog.vue` is now the single native `#new-project` dialog for
  both `OverviewPage` and `ProjectsPage` (legacy labels/hint, required input, pending state, error
  toast, `apiMutation` form post with `X-Hanse-Client: spa`, full-document success navigation).
  `StatusPill`, `RouteText`, `RouteCard`, and `ui/status.ts` mirror the legacy status/reply/runtime
  vocabulary without importing server code. `ProjectsPage` and `OverviewPage` only trust boot props
  when `boot.route.id` matches their route, so client navigation fetches the destination route's
  props instead of rendering the previous page's data.
- **Routing.** `/` is registered in `ui/router.ts` with a lazy `OverviewPage`; `SmartLink` now keeps
  the overview-to-projects hop client-side while project links stay plain anchors.
- **Tests.** New `OverviewPage` component tests (5) cover boot rendering, the empty state, the shared
  dialog, cross-route boot fetch, and the legacy boundary. `e2e/overview.spec.ts` runs in `spa`,
  `legacy`, and `allowlist-empty` (counts, ledger, recent handoffs, waiting cards, runtime,
  create-project, detail boundary). `e2e/spa-overview.spec.ts` covers deep link, refresh, client
  navigation to `/projects`, chrome swap/title/active nav, `?legacy=1`, rollback servers, no fallback
  flash, no console/page errors, and an annotated transfer measurement. The Phase 1B route-table
  assertions were updated to include `overview`; no other test was weakened.

## Phase 2B verification

Commands ran with `NODE_ENV=development` and `PLAYWRIGHT_CHROMIUM=/usr/bin/chromium`.

| Command | Result |
| --- | --- |
| `npm run lint` | 547 files, exit 0 (18 pre-existing warnings) |
| `npm run typecheck` | exit 0 |
| `npm run typecheck:ui` | exit 0 |
| `npm run typecheck:e2e` | exit 0 |
| `npm test` | 150 files / 2787 tests, exit 0 |
| `npm run build` | exit 0; entry `main-7vauEzKX.js`, overview `OverviewPage-Ce6EL7yb.js`, projects `ProjectsPage-DTVqYcEq.js` |
| `npm run check:sensitive` | exit 0 |
| `npm run check:ui` | exit 0 (12 SFCs, sentinel present) |
| `npm run test:e2e` | 40 passed, exit 0 (spa 18, legacy 16, allowlist-empty 6) |

Measured on the deterministic fixture: `/` first load = document 4,930 + CSS 27,635 + entry 98,982
+ overview chunk 5,099 = **136,646 bytes** (recorded; S16 remains the `/projects` budget). `/projects`
first load stayed at **134,719 bytes**; CLS 0.0.

Visual parity: normalized `#main` structure and key computed styles/layout boxes for the header,
watch strip, workbench grid, cards, tables, route cards, runtime rows, and empty state match the
legacy page at 390/768/1440 in dark and light. The only structural deltas were the hidden
`hanse-ui-sentinel` element and the per-server temp workspace path text.

## Phase 2C implementation (`/projects/:id` cutover)

Phase 2C completes Phase 2. The registry has `spa: true` for `overview`, `projects`, and `project`;
`app` and every later route stay `spa: false`, so the project-to-application hop remains a full
document load. The legacy renderer and all non-SPA API/redirect behavior are unchanged.

- **Page.** `ui/pages/ProjectPage.vue` renders the legacy project header (Project overline,
  name/description, root/base/application/waiting meta, Settings, Open IDE, New handoff), four-cell
  watch strip, applications table, handoffs table, waiting route cards, manifest, policy card, and
  danger zone. The reserved master project renders the read-only master header/card with
  chat/settings/skills links and no mutating controls. Application/settings/skills/chat/IDE links
  are plain anchors; `SmartLink` now client-navigates overview/projects/project links.
- **Components.** `AddAppDialog`, `NewHandoffDialog`, `HandoffReviewDialog`, `ProjectPolicyCard`, and
  `ProjectDeleteDialog` sit next to the page. They use `apiMutation` with form bodies and
  `X-Hanse-Client: spa`, keep failures open with an error toast, and refetch
  `/api/ui/projects/:id` (then apply its chrome fragment) on success. The decision/reply/cancel/
  policy/deletion handlers are reused as-is; no parallel write path was added.
- **Boot/query.** Boot props are trusted only when `boot.route.id === "project"` and the id matches
  the current route. Client navigation fetches `/api/ui/projects/:id` via Vue Query. Loading,
  generic error, 404, Retry, and `?legacy=1` are covered.
- **Fixture.** The deterministic seed now includes the reserved master project, a bare git remote
  served by a loopback `git daemon` (for add-app clone), two reply-waiting handoffs, a cancellable
  handoff, and a contract-only fake deletion service plus a fake reply dispatcher in
  `e2e/support/server.ts`. No Docker or opencode is used.
- **Tests.** `ProjectPage` component tests cover normal/master, all cards, empty states, cross-route
  boot fetch, 404/error/retry, the legacy app boundary, and add-app/create-handoff/decision/
  relaunch/policy/delete success and failure paths. `e2e/project.spec.ts` (spa) covers the render,
  clone/path add, queued/awaiting handoffs, approve/reject, relaunch/retry/cancel, policy, deletion
  contract, and master read-only. `e2e/spa-project.spec.ts` covers deep link, refresh, client
  navigation from overview/projects, chrome/history, `?legacy=1`, both rollback servers, the app
  boundary, no fallback flash/errors, and transfer. `project-detail.spec.ts` stays the legacy
  rollback smoke. Existing HTML tests were kept (the task prohibited deleting tests).

- **Accepted parity delta.** Handoff spec/result/operator-note text in the SPA review dialog renders as
  pre-wrapped plain text (no `v-html`); the legacy page hydrates those fields as Markdown through
  `handoff.js`. The shared `SafeMarkdown` component lands with the Phase 3 handoff-inbox port.
## Phase 2C verification

Commands ran with `NODE_ENV=development` and `PLAYWRIGHT_CHROMIUM=/usr/bin/chromium`.

| Command | Result |
| --- | --- |
| `npm run lint` | 557 files, exit 0 (18 pre-existing warnings) |
| `npm run typecheck` | exit 0 |
| `npm run typecheck:ui` | exit 0 |
| `npm run typecheck:e2e` | exit 0 |
| `npm test` | 151 files / 2804 tests, exit 0 |
| `npm run build` | exit 0; entry `main-BhPRc5y4.js`, project `ProjectPage-CA_eCmK1.js` |
| `npm run check:sensitive` | exit 0 |
| `npm run check:ui` | exit 0 (18 SFCs, sentinel present) |
| `npm run test:e2e` | 54 passed, exit 0 (spa 32, legacy 17, allowlist-empty 5) |

Measured on the deterministic fixture: `/projects/:id` first load = document 5,610 + CSS 27,635 +
entry 99,746 + project chunk 12,947 = **145,938 bytes** (recorded; S16 remains the `/projects`
budget). `/projects` stayed at **135,505 bytes** with CLS 0.0.

Visual QA compared the SPA and legacy project pages at 390/768/1440 in dark and light: matching
`h1`, watch-strip labels, table count, `#main` scroll width, and no horizontal overflow. Screenshots
live in the untracked workspace evidence directory (`phase2c-visual/`). Structural deltas: the hidden
`#hanse-boot` marker, the Vue sentinel, and per-server temp path text.

## Phase 3B implementation - `/handoffs` cutover (2026-10-29)

Phase 3B finishes Phase 3: `overview`, `projects`, `project`, and `handoffs` are the only registry
routes with `spa: true`. SSH, settings, skills, app detail, chat, and terminal stay legacy.

- **SafeMarkdown.** `ui/components/SafeMarkdown.vue` clears its container and calls the existing
  `assets/markdown.js` `renderMarkdown(container, text)` DOM builder from `onMounted` and a `watch`
  on `text`. `assets/markdown.d.ts` types the browser module for `vue-tsc`; `tsconfig.ui.json`
  includes it. `HandoffReviewDialog` now renders specification, result, and operator note through
  `SafeMarkdown` with the legacy `prose handoff-md` classes. The legacy `handoff.js` hydration path
  is unchanged; there is no `v-html` and no SFC `<style>`.
- **Inbox page.** `ui/pages/HandoffsPage.vue` mirrors `renderHandoffs`: Workbench header with
  total/waiting/active/replies counts, segmented filters with explicit `aria-current="page"` and
  counts, `#handoff-search` with the hidden filter and clear-search link, the inbox table with
  `StatusPill`/`RouteText`/time tags, inline approve/reject for dispatch and reply approvals, and
  the shared review dialog. Inline decisions use `apiMutation` with `decision`, `approval_kind`, and
  `return_to`; success refreshes props plus chrome and toasts, failure toasts the typed error, and
  both buttons disable while pending. Review opens `row.dialog`; `changed` refetches. Empty state,
  loading, 404, generic error, Retry, and `?legacy=1` follow the other SPA pages. Boot props are
  trusted only when the route id and filter/query match; otherwise the page fetches
  `/api/ui/handoffs?filter=&q=`. Filters and search use `router.push`.
- **Routing.** `src/shared/routes.ts` flips only `handoffs` to `spa: true`; `ui/router.ts` registers
  `/handoffs`. `SmartLink` now lets an explicit `aria-current` override its exact-active fallback so
  the segmented control can mark the query-specific filter. Chrome, title, and active nav swap
  through the existing shell path.
- **Tests.** New `SafeMarkdown.test.ts` covers initial render, text replacement, and no duplicate
  nodes. New `HandoffsPage.test.ts` covers the boot table/counts/filters, filter and search
  navigation, inline approve/reject success and failure with pending state, the review dialog with
  safe Markdown, empty/loading/404/generic error/Retry, the project `SmartLink`, and no `<style>`.
  `shared-routes.test.ts` updates its deliberate cutover list. `handoffs.spec.ts` now runs in `spa`,
  `legacy`, and `allowlist-empty` and covers the `#hanse-boot` mode marker, filters/search, inline
  approve/reject, review/relaunch/retry/cancel, safe Markdown, and the legacy `303` path.
  `spa-handoffs.spec.ts` covers deep link and filter query, refresh, back/forward, chrome/title/
  active nav from the overview, `?legacy=1`, both rollback servers, no fallback flash/console
  errors, safe Markdown, and project-link client navigation from an intercepted empty state.
  The plan's suggested retirements were not applied because the task requires keeping existing
  tests; the legacy smoke and `test/handoff-http.test.ts` remain.
- **Fixture.** `e2e/support/seed.ts` adds three inbox-owned reply/cancel rows with old timestamps for
  deterministic relaunch/retry/cancel coverage and pins the long-lived approval summary above them
  so the overview's existing recent-handoffs assertions survive the inbox spec's mutations.
- **Gaps.** `/handoffs` has no first-load transfer budget (S16 stays `/projects`). The E2E fixture
  still stubs the dispatcher and never starts Docker/opencode. Project navigation coverage uses an
  intercepted empty state because the legacy inbox has no per-row project link; row session links
  stay plain anchors.

### Phase 3B verification

Commands ran with `NODE_ENV=development` and `PLAYWRIGHT_CHROMIUM=/usr/bin/chromium`.

| Command | Result |
| --- | --- |
| `npm run lint` | 565 files, exit 0 (18 pre-existing warnings) |
| `npm run typecheck` | exit 0 |
| `npm run typecheck:ui` | exit 0 |
| `npm run typecheck:e2e` | exit 0 |
| `npm test` | 154 files / 2827 tests, exit 0 |
| `npm run build` | exit 0; handoffs chunk `HandoffsPage-DJVAEaSh.js`, review dialog `HandoffReviewDialog-tdv4V2rx.js` |
| `npm run check:sensitive` | exit 0 |
| `npm run check:ui` | exit 0 (20 SFCs, sentinel present) |
| `npm run test:e2e` | 67 passed, exit 0 (spa 40, legacy 18, allowlist-empty 9) |

Visual note: the SPA and legacy inbox reuse the same `page-header`, `toolbar`, `segmented`, `table`,
`status`, and dialog primitives. Browser measurements at 390/768/1440 matched legacy for the `h1`,
counts, filter labels, row count, toolbar/segmented/search/table boxes, `document`/`.page` overflow
(0), and dialog overflow (0); the SafeMarkdown container rendered the same `h4`/`strong`/`code`
nodes exactly once after hydration. Structural deltas remain the hidden `#hanse-boot` marker and the
Vue sentinel; no SFC `<style>` exists. Screenshots were captured to the untracked workspace
evidence directory but are not checked in.

## Phase 4B implementation - `/ssh` cutover (2026-10-29)

Phase 4B finishes Phase 4: `overview`, `projects`, `project`, `handoffs`, and `ssh` are the only
registry routes with `spa: true`. Settings, skills, app detail, chat, and terminal stay legacy.

- **Page.** `ui/pages/SshPage.vue` mirrors `renderPage`: the Access header with scope counts, the
  SSH section nav, the `?target=<project>:<app>` picker, the four-cell watch strip, host cards with
  pin/approval state and host-key details, the per-application allowlist and grants table, pending
  approve/reject cards, and the read-only audit table. Boot props are trusted only when
  `boot.route.id === "ssh"` and the selected target matches the route; otherwise the page fetches
  `/api/ui/ssh?target=...` with Vue Query. Scope changes use `router.push`; loading, generic error,
  Retry, `?legacy=1`, empty states, and the rollback servers match the other SPA pages.
- **Host dialogs.** `ui/components/SshHostDialog.vue` carries the legacy connection, private-key,
  access-policy, host-key, and danger-zone fields for add/edit/delete. The private key is read from
  the form element at submit time, never enters page props or boot JSON, and is cleared on close;
  only the derived public key, fingerprint, and key type are rendered. Add/update/delete call the
  existing `/api/ssh/hosts` JSON handlers (`POST`/`PATCH`/`DELETE`); `apiMutation` gained an explicit
  method override and keeps `POST` as the default.
- **Actions.** Test connection, Prepare re-pin, and Re-pin use `/api/ssh/hosts/:id/test` and
  `/re-pin`; allowlist save and grant revoke use the project SSH API; approve/reject use the app
  approvals decision API. Success refreshes `/api/ui/ssh` and its chrome fragment; failure keeps the
  dialog open and raises an error toast. No parallel write path and no other backend route flag
  changed.
- **Routing.** `src/shared/routes.ts` flips only `ssh` to `spa: true`; `ui/router.ts` registers
  `/ssh`. `SmartLink` stays out of the section nav (plain hash anchors); the scope picker navigates
  through the router. Chrome, title, breadcrumb, and `data-nav-id="ssh"` swap through the existing
  shell path.
- **Tests.** New `SshPage` component tests cover boot scoped/unscoped rendering, scope navigation,
  cross-route boot fetch, empty/loading/error/retry, add/edit/delete, test success/failure,
  prepare/re-pin, allowlist/revoke, approve/reject, no secret key in output, and no `<style>`.
  `e2e/ssh.spec.ts` now runs in `spa`, `legacy`, and `allowlist-empty` and covers the boot marker,
  scope/target queries, hosts/grants/approvals/audit, create/edit/delete, test success/failure,
  re-pin, grant/revoke, approve/reject, the legacy `303` path, and absent key material.
  `e2e/spa-ssh.spec.ts` covers deep links, target queries, refresh, back/forward, chrome/title/
  active nav, `?legacy=1`, both rollback servers, no fallback flash, and console/page errors.
  `shared-routes` and the SSH boot assertion now expect `spa: true`; the legacy SSH smoke and API
  tests remain.
- **Fixture.** `e2e/support/seed.ts` adds two pending approvals (approval supersedes the other
  pending request for the same app/host, so the test rejects before approving).
  `e2e/support/server.ts` wraps `testHost`: an address starting with `fail.` times out; every other
  host authenticates and pins `SHA256:e2e-fixture-fingerprint`; Prepare re-pin records the pending
  observation and the real service performs the re-pin. No network or real key is used.
- **Visual QA.** Browser measurements at 1440 and 390 matched the watch strip, host card, access/
  grants, approvals, and audit-table boxes, with zero document/page horizontal overflow. The SPA
  header is full-bleed like the other SPA pages and adds scope counts, so its outer width/height
  differ from the legacy header; body sections match. Structural deltas are the hidden
  `#hanse-boot` marker, the Vue sentinel, and the edit dialog not being mounted until opened.

### Phase 4B verification

Commands ran with `NODE_ENV=development` and `PLAYWRIGHT_CHROMIUM=/usr/bin/chromium`.

| Command | Result |
| --- | --- |
| `npm run lint` | 572 files, exit 0 (18 pre-existing warnings) |
| `npm run typecheck` | exit 0 |
| `npm run typecheck:ui` | exit 0 |
| `npm run typecheck:e2e` | exit 0 |
| `npm test` | 156 files / 2849 tests, exit 0 |
| `npm run build` | exit 0; SSH chunk `SshPage-CoaV1D0T.js` (41.8 kB) |
| `npm run check:sensitive` | exit 0 |
| `npm run check:ui` | exit 0 (22 SFCs, sentinel present) |
| `npm run test:e2e` | 82 passed, exit 0 (spa 48, legacy 21, allowlist-empty 13) |

No transfer budget was assigned for `/ssh`; `/projects` remains the S16 budget route.

## Phase 5B implementation - settings scopes cutover (2026-10-29)

Phase 5B finishes Phase 5: `overview`, `projects`, `project`, `handoffs`, `ssh`,
`settings-global`, `settings-project`, and `settings-app` are the only registry routes with
`spa: true`. Skills, app detail, chat, and terminal stay legacy.

- **Page.** `ui/pages/SettingsPage.vue` mirrors the legacy settings header, Global/Project/App
  scope navigation, a target picker built from `SettingsProps.scope.projects`, the
  Agent/Web tools/Context/Git/Restart sections, warnings, the restart-required banner, and the
  clear dialog. `SettingsRow.vue` covers model, web-driver, context enable/threshold, and git
  identity rows with effective/source text, own state (Set/Inherited/Default/Cleared), hints,
  warnings, scope details, action availability/reasons, and Save/Inherit/Clear. The provider,
  custom-model-provider, git credential, and restart sections are separate small components.
- **Actions.** Save/inherit/clear reuse `POST /api/settings`; provider keys use
  `/api/settings/provider`; model providers use `/api/settings/model-providers`; git credentials
  use `/api/settings/git` plus the app-scoped
  `/api/projects/:id/apps/:app/git/test`; restart reuses `/api/apps/:app/restart?project=`.
  Success refetches `/api/ui/settings?scope=&project=&app=` and applies its chrome fragment;
  failures raise error toasts. No parallel write path or legacy contract changed.
- **Masking.** Provider keys, git SSH private keys, known_hosts, and HTTPS tokens are read from
  the form element at submit/test time, never kept in reactive state, and cleared after success.
  Props, boot, toasts, and the DOM carry only `Not shown` and public metadata (SSH public key,
  fingerprint, known-host presence, HTTPS hosts/username). Sentinels are asserted absent in the
  component and E2E tests.
- **Boot/query/routing.** Boot props are trusted only when the boot route id is a settings id and
  `scope.href` matches the current route; otherwise Vue Query fetches the endpoint. Scope/target
  changes use `router.push`. `src/shared/routes.ts` flips the three settings ids to `spa: true`;
  `ui/router.ts` registers the three paths before the generic project route. Chrome, title,
  breadcrumb, `data-nav-id="settings"`, and scoped settings/skills links come from `chromeFor`.
- **Tests.** New `SettingsPage` component tests (15) and updated `shared-routes` cutover
  assertions. `settings.spec.ts` runs in `spa`, `legacy`, and `allowlist-empty` (boot marker,
  three scopes, save/inherit/clear, provider/model-provider masking and CRUD, git masking and Test
  connection, restart, legacy 303, no sentinel text). `spa-settings.spec.ts` covers deep links,
  refresh, target navigation, back/forward, chrome/title/active nav, `?legacy=1`, both rollback
  servers, no fallback flash, and console/page errors.
- **Fixture.** The seed adds a global `deepseek` provider key, one `e2e-llm` custom model provider,
  app-scoped SSH/HTTPS git credentials with synthetic sentinels, and a mutable alpha pending
  restart. The server supplies deterministic git `testConnection` and
  `preflightRestart`/`beginRestart`.
- **Gate fix.** `ui/components/SshHostDialog.vue` used a private-range placeholder that
  `check:sensitive` flags; it now uses the TEST-NET-3 placeholder `203.0.113.10`. Behavior is
  unchanged.

### Phase 5B verification

Commands ran with `NODE_ENV=development` and `PLAYWRIGHT_CHROMIUM=/usr/bin/chromium`.

| Command | Result |
| --- | --- |
| `npm run lint` | 584 files, exit 0 (18 pre-existing warnings) |
| `npm run typecheck` | exit 0 |
| `npm run typecheck:ui` | exit 0 |
| `npm run typecheck:e2e` | exit 0 |
| `npm test` | 158 files / 2873 tests, exit 0 |
| `npm run build` | exit 0; settings chunk 55.3 kB / 13.1 kB gzip |
| `npm run check:sensitive` | exit 0 |
| `npm run check:ui` | exit 0 (29 SFCs, sentinel present) |
| `npm run test:e2e` | 101 passed, 1 skipped, exit 0 |

No transfer budget was assigned for settings; `/projects` remains the S16 budget route.

## Phase 6B implementation - skills routes cutover (2026-10-29)

Phase 6B finishes Phase 6: `overview`, `projects`, `project`, `handoffs`, `ssh`, the three settings
scopes, and the five skills routes (`skills-global`, `skills-project`, `skills-app`, `skills-new`,
`skills-detail`) are the only registry routes with `spa: true`. Application detail, chat, and
terminal stay legacy.

- **Pages.** `ui/pages/SkillsPage.vue` replaces the inventory and create renderers with Vue: scope
  navigation, counts, All/Defined/Inherited/Disabled/Invalid filters, search, the inventory table
  (origin, state, references, updated, effective-source link), empty/search/filter states,
  collision/restart rails, and the scoped new-skill form. `ui/pages/SkillDetailPage.vue` renders the
  workspace: state/visibility, restart banner, collisions, issues with repair anchors, details and
  custom metadata, references, source/preview tabs, generated frontmatter with Copy, danger-zone
  delete/revert, and override/disable/revert plus source/effective links. `SkillBundleEditor.vue`
  ports the metadata/reference/source behavior from `assets/skill-detail.js`; `SafeMarkdown` owns
  every Markdown preview, clears before re-render, and no `v-html` or SFC `<style>` was added.
- **Actions.** Create/update/override/disable/revert/delete reuse the existing `/api/skills*`
  handlers through `apiMutation`; restart reuses `/api/apps/:app/restart?project=`. Successes
  refresh props/chrome and remove the cached inventory so a client navigation back does not show the
  pre-write boot snapshot; failures keep the form open and raise an error toast. Local validation
  mirrors the server limits for name, description, content, metadata JSON, and reference paths/
  aggregate. The legacy `303` form path and `skill-detail.js` remain for the rollback pages only.
- **Boot/query/chrome.** Inventory trusts boot props only when route/scope/filter/search match;
  create trusts `skills-new` only for its context and otherwise fetches the scope inventory; detail
  trusts only the matching id and otherwise fetches `/api/ui/skills/:id?from=`. A per-document write
  marker prevents boot reuse after mutations. `chromeFor` gained a scope hint so new/detail pages
  get the context project/app skills href, breadcrumb, and skill title. `/skills/new` is registered
  before `/skills/:id`.
- **Tests.** New component tests (10 inventory/create + 9 detail) cover boot/scoped rendering,
  filters/search, create success/duplicate/local validation, cross-route fetch, source/references/
  metadata/issues, safe Markdown once, override/disable/revert, save/discard, danger delete,
  restart, 404/loading/error/retry, no `<style>`, and no secrets. `skills.spec.ts` runs in `spa`,
  `legacy`, and `allowlist-empty` (boot marker, inventory, filters/search, create, detail,
  override/disable/revert at application scope, legacy 303, secret absence).
  `spa-skills.spec.ts` covers deep links, refresh, back/forward, client scope navigation,
  chrome/title/active nav, `?legacy=1`, both rollback servers, no fallback flash, and console/page
  errors. `shared-routes`/`skills-props` cutover assertions and the detail chrome title were updated.

### Phase 6B verification

Commands ran with `NODE_ENV=development` and `PLAYWRIGHT_CHROMIUM=/usr/bin/chromium`.

| Command | Result |
| --- | --- |
| `npm run lint` | 596 files, exit 0 (18 pre-existing warnings) |
| `npm run typecheck` | exit 0 |
| `npm run typecheck:ui` | exit 0 |
| `npm run typecheck:e2e` | exit 0 |
| `npm test` | 161 files / 2906 tests, exit 0 |
| `npm run build` | exit 0; `SkillsPage` 18.8 kB, `SkillDetailPage` 16.1 kB |
| `npm run check:sensitive` | exit 0 |
| `npm run check:ui` | exit 0 (33 SFCs, sentinel present) |
| `npm run test:e2e` | 122 passed, 1 skipped (pre-existing), exit 0 |

No transfer budget was assigned for skills; `/projects` remains the S16 budget route. Visual QA was
limited to the automated E2E and component evidence: the SPA and legacy pages share the same
`src/http/styles.css` classes, the same scope/table/card markup vocabulary, and SafeMarkdown renders
through the same DOM builder. Screenshots/parity captures were not added to tracked docs.

## Phase 7A implementation - application-detail read shell + restart (2026-10-29)

Phase 7A adds the read-only application-detail SPA shell and restart. The registry still has
`spa: false` for `app` (and every later route); the page is reachable only through
`HANSE_UI_SPA_ROUTES=app` and `?legacy=1` still serves the legacy document. Phase 7 is not complete.

- **Page/components.** `ui/pages/AppPage.vue` renders the application header/identity and
  chat/terminal/settings/skills/IDE links, the Runtime/Settings state strip, the image rail, the
  Repository/Changes workbench plus Last commit, the app-scoped SSH grants/approvals/audit panels,
  and the read-only master variant. `AppImagePanel.vue`, `AppGitPanel.vue`, `AppSshPanel.vue`,
  `AppStateStrip.vue`, and `AppRestartDialog.vue` hold the read panels and confirmation dialog.
  Delete controls are intentionally absent; a pending deletion renders only its read-only banner.
- **Data/polling.** Boot props are trusted only for `route.id === "app"` with matching project and
  application; otherwise the page fetches `/api/ui/apps/:app?project=`. The endpoint is refetched on
  mount/manual refresh because boot props carry `git.summary.loaded=false`. Runtime polls every 10 s;
  image status polls every 3 s only while building. The SPA route loads no `git.js`, `images.js`, or
  `ssh.js`.
- **Restart only.** The state-strip control opens a native confirmation dialog and reuses
  `/api/apps/:app/restart?project=` with same-origin credentials and a JSON body. Success refreshes
  props/runtime and raises a toast; failure keeps the page and raises an error toast. No git, image,
  SSH, or delete mutation exists in 7A.
- **Routing/E2E.** `ui/router.ts` registers `/projects/:id/apps/:app` for the preview; the registry
  flag stays false. `playwright.config.ts` adds the `app-preview` project and a fourth `webServer` on
  `4313` (`HANSE_E2E_MODE=spa`, `HANSE_UI_SPA_ROUTES=app`, own `mkdtemp` DB).
  `e2e/spa-app.spec.ts` covers deep link/refresh, runtime/image/git/SSH read panels, restart success
  and the intentional-503 error path, absent legacy scripts, `?legacy=1`, the legacy/empty-allowlist
  servers, no fallback flash, and console/page errors. `e2e/app.spec.ts` remains the legacy smoke.
- **Tests.** New `AppPage` component tests (29) cover runtime/settings matrices, image states, git
  states, SSH panels, boot/cross-route fetching, restart success/error, 404/loading/error/retry,
  master, deletion-banner-only, no `<style>`, and no legacy scripts. All existing tests remain.

### Phase 7A verification

Commands ran with `NODE_ENV=development` and `PLAYWRIGHT_CHROMIUM=/usr/bin/chromium`.

| Command | Result |
| --- | --- |
| `npm run lint` | 608 files, exit 0 (18 pre-existing warnings) |
| `npm run typecheck` | exit 0 |
| `npm run typecheck:ui` | exit 0 |
| `npm run typecheck:e2e` | exit 0 |
| `npm test` | 164 files / 2952 tests, exit 0 |
| `npm run build` | exit 0; `AppPage` 36.3 kB / 9.9 kB gzip |
| `npm run check:sensitive` | exit 0 |
| `npm run check:ui` | exit 0 (39 SFCs, sentinel present) |
| `npm run test:e2e` | 128 passed, 1 skipped, exit 0 |

No transfer budget was assigned for the app preview; `/projects` remains the S16 route. The
deliberate restart-failure E2E injects a 503, so that one test asserts app-level error handling
without claiming a clean browser console; the read/success tests assert no console or page errors.

## Phase 7B implementation - git workbench (2026-10-29)

Phase 7B ports the application git workbench into the SPA preview. `src/shared/routes.ts` still has
`spa: false` for `app` (and every later route); the page is reachable only through
`HANSE_UI_SPA_ROUTES=app`, `?legacy=1` still serves the legacy document, and Phase 7 is **not**
complete.

- **Contract/rules.** `ui/git-types.ts` mirrors the existing `GitStatus`/`GitActionResult` JSON
  contract and the legacy presentation rules: `controlState`, action hints, push/action labels,
  fallback messages, non-ok repository states, file-status text, and the full error-code title/copy
  mapping from `git.js`.
- **State/actions.** `ui/composables/useAppGit.ts` owns the workbench state. It reads
  `/git/status` once on route entry, on manual refresh, and after an action only when the response
  carries no status - no new polling. Fetch, update, push, commit-all, and branch switch reuse
  `/api/projects/:id/apps/:app/git/{fetch,update,push,commit,branches/switch}`. Commit validates a
  trimmed message and control characters client-side; switch warns on an empty choice or the current
  branch. Success updates the returned status, clears the commit draft, raises the legacy notice and
  a toast, and asks `AppPage` to refresh props/chrome. Failures keep the page intact and map the
  coordinator code to the legacy title/message plus a toast.
- **UI.** `AppGitPanel.vue` now renders branch/upstream/HEAD, the clean/dirty/detached/conflicted/
  operation pill, fetch/update/push with busy labels and disabled reasons, notices, the branch
  switch form, file groups, and the commit-all form with its inline error. `AppGitRemotes.vue`
  restores the rail Remotes card. `AppPage.vue` keeps the live last commit and passes the workbench
  state through. The SPA route still loads no `git.js`, `images.js`, or `ssh.js`.
- **Test connection.** The legacy workbench never had a Test connection control; it belongs to the
  application settings page and already reuses `/git/test` through `SettingsGitSection.vue`. 7B
  leaves that contract unchanged and keeps its existing component/three-mode E2E coverage rather
  than adding a second credential-entry surface to the application page.
- **E2E fixture.** The alpha fixture repository gains a deterministic local bare `origin`, an
  upstream `main`, and a `feature` branch. The app-preview server publishes its repo map under a
  per-port temp file so `e2e/spa-app.spec.ts` prepares clean, dirty, detached, conflicted, ahead,
  behind, and diverged states with local git only. The spec covers the state matrix, on-demand
  refresh, commit-all, fetch/update/push/switch, commit validation, current-branch warnings, disabled
  states, and the push-rejected/diverged/status-load error mappings. The registry flag stays false.
- **Tests.** New `AppGitPanel` component tests (8) cover state/control matrices, busy labels,
  notices, load failures, and non-git states. `AppPage` tests grew to 36 with commit,
  fetch/update/push, switch, error mapping, validation, busy, and status-retry coverage.

### Phase 7B verification

Commands ran with `NODE_ENV=development` and `PLAYWRIGHT_CHROMIUM=/usr/bin/chromium`.

| Command | Result |
| --- | --- |
| `npm run lint` | 612 files, exit 0 (18 pre-existing warnings) |
| `npm run typecheck` | exit 0 |
| `npm run typecheck:ui` | exit 0 |
| `npm run typecheck:e2e` | exit 0 |
| `npm test` | 165 files / 2967 tests, exit 0 |
| `npm run build` | exit 0; `AppPage` 59.1 kB / 16.79 kB gzip |
| `npm run check:sensitive` | exit 0 |
| `npm run check:ui` | exit 0 (40 SFCs, sentinel present) |
| `npm run test:e2e` | 134 passed, 1 skipped, exit 0 |

No transfer budget was re-assigned for the app preview; `/projects` remains the S16 route.

## Next

Phase 7C: port `images.js` (build/rollback/check/logs/poll), the app SSH panel, and delete with the
exact-name confirmation; then perform the single application-detail cutover and remove the legacy
island scripts from the SPA document. The `app` registry flag stays false until that cutover.


## Phase 7C implementation - image, SSH, delete, and cutover (2026-10-29)

Phase 7C finishes Phase 7. `src/shared/routes.ts` flips `app` to `spa: true`, so every page route is
client-rendered except `/chat` and `/terminal`. The legacy application document remains reachable
through `HANSE_UI_LEGACY=1`, `?legacy=1`, or a `HANSE_UI_SPA_ROUTES` allowlist and still loads
`/assets/git.js`, `/assets/images.js`, and `/assets/ssh.js`.

- **Image rail.** `ui/composables/useAppImage.ts` ports `assets/images.js`: one status read on entry
  and on manual refresh, a 3 s status/log poll only while building, and build/rollback/check/logs
  through the existing `/api/apps/:app/{build,image/rollback,image/check,image/logs}` handlers.
  `ui/components/AppImagePanel.vue` renders the legacy state vocabulary (current, restart_required,
  rebuild_required, building, build_error, not_ready, unknown, plus default-image
  current/restart/unknown), the build label/disabled reason, drift/blocked/usable/rollback badges,
  base/hash/built details, logs, the restart notice, and the rollback confirmation dialog. Action
  success refreshes props/chrome; failures raise the server message as an error toast.
- **App-scoped SSH.** `ui/components/AppSshPanel.vue` keeps the read tables and adds the allowlist
  editor (`GET /api/ssh/hosts` for the full host list plus `GET/POST
  /api/projects/:id/apps/:app/ssh`), grant revoke, approval approve/reject, and an on-demand audit
  read. Each action is busy-disabled and emits one props/chrome refresh; errors become toasts. No
  private key, provider key, git token, or MCP token is read, stored, or rendered.
- **Deletion.** `ui/components/AppDeleteDialog.vue` reproduces the exact-name confirmation,
  `deleteFiles`, `return_to`, retry labels, and project-deletion retry variant from
  `src/http/deletion.ts`. It reuses the existing `POST .../delete` handler and navigates to the
  project page or `/projects` on success with the legacy success/warning message.
- **Cutover.** `AppPage.vue` is the default `/projects/:id/apps/:app` renderer. ProjectPage app links
  and the git workbench project link use `SmartLink`; chat, terminal, settings, skills, and IDE stay
  full documents. The SPA document loads only `app.js`. The temporary `app-preview` server/project on
  4313 was retired: app E2E now runs on the default `spa` server on 4310, and the fixture uses beta
  and gamma for image/SSH state so the alpha rows owned by the SSH console spec stay stable.
- **Tests.** New `AppImagePanel` (15), `AppSshPanel` (7), and `AppDeleteDialog` (6) component tests
  cover the state matrix, busy/disabled reasons, logs, exact-name confirmation, all SSH mutations,
  error toasts, no `<style>`, and no key/script text. `AppPage` tests grew to 40 with image
  build/rollback/check/busy/error and delete retry coverage. `ProjectPage` tests assert client-side
  application links. `spa-app.spec.ts` adds custom-image build/poll/log/rollback, default check,
  stale drift, SSH grant/revoke/approve/reject/audit, and exact-name delete flows; the legacy
  `app.spec.ts` still runs on the legacy and empty-allowlist servers and `?legacy=1` keeps the
  island-script smoke.

### Phase 7C verification

Commands ran with `NODE_ENV=development` and `PLAYWRIGHT_CHROMIUM=/usr/bin/chromium`.

| Command | Result |
| --- | --- |
| `npm run lint` | 617 files, exit 0 (18 pre-existing warnings) |
| `npm run typecheck` | exit 0 |
| `npm run typecheck:ui` | exit 0 |
| `npm run typecheck:e2e` | exit 0 |
| `npm test` | 168 files / 2999 tests, exit 0 |
| `npm run build` | exit 0; `AppPage` 77.56 kB / 22.03 kB gzip |
| `npm run check:sensitive` | exit 0 |
| `npm run check:ui` | exit 0 (41 SFCs, sentinel present) |
| `npm run test:e2e` | 139 passed, 1 skipped, exit 0 |

No transfer budget was assigned for application detail; `/projects` remains the S16 route. Visual
geometry was checked on the beta fixture at 390/768/1440 in dark and light: zero document and
`.page` horizontal overflow, and the image, SSH, and danger-zone cards were visible at every size.
Screenshots are untracked workspace evidence. Chat and terminal migration and Phase 8 cleanup were
not started.

## Next

Gate D1: record the `/chat` and `/terminal` request soak and operator feedback, then decide whether
either remains a legacy document. Phase 8 cleanup is out of scope until that decision.
## Gate D1 - chat and terminal (2026-10-29)

Phase 7 is complete and all migrated routes are SPA; only `/chat` and `/terminal` remain legacy.
The D1 default is to keep both as legacy documents. No migration is included in plan 0031.

Evidence available in this workspace is insufficient for the full gate as written: there is no
retained 7-day access-log extract and no operator feedback. The design records the existing chat
client at 14,362 lines, so a separate design, mount estimate, and Oracle review would be required
before any migration. Phase 8 cleanup is deferred until a rollback soak; the legacy renderers,
scripts, `HANSE_UI_LEGACY=1`, and `?legacy=1` remain available in the meantime.
