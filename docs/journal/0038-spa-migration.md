# 0038 - Incremental SPA migration: Phase 0 harness and Phase 1A infrastructure

Status: **in progress** - Phase 0 complete (2026-10-28); Phase 1A complete, flag off (2026-10-28);
Phase 1B complete, `/projects` cut over (2026-10-28); Phase 2 next.
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

## Next

Phase 2: migrate `/` (fleet overview) and `/projects/:id` (project detail), add their props and
`/api/ui/*` endpoints, the add-app/create-handoff/decision SPA branches, master variants, and the
SPA/legacy E2E plus rollback matrix. The `/projects/:id` → app-detail boundary stays a full document
load until Phase 7.

