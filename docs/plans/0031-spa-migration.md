# Plan 0031 - Incremental SPA migration

Status: **in progress** - plan review (`momus`) round 3 PASS (2026-10-28); Phase 0 complete
(journal 0038); Phase 1A complete (2026-10-28; all gates green, no route cut over); Phase 1B
complete (2026-10-28; `/projects` is the first cutover, all gates green); Phase 2A complete
(2026-10-29; overview/project props and `/api/ui/*` endpoints); Phase 2B complete (2026-10-29;
`/` cut over); Phase 2C complete (2026-10-29; `/projects/:id` cut over, Phase 2 complete - `/`,
`/projects`, and `/projects/:id` are SPA, app detail and every later route stay legacy); Phase 3B
complete (2026-10-29; `/handoffs` cut over, Phase 3 complete - `/`, `/projects`, `/projects/:id`,
and `/handoffs` are SPA); Phase 4B complete (2026-10-29; `/ssh` cut over, Phase 4 complete - `/`,
`/projects`, `/projects/:id`, `/handoffs`, and `/ssh` are SPA, settings/skills/app detail and every
later route stay legacy); Phase 5B complete (2026-10-29; the three settings scopes cut over, Phase 5
complete - `/`, `/projects`, `/projects/:id`, `/handoffs`, `/ssh`, and settings are SPA); Phase 6B
complete (2026-10-29; the five skills routes cut over, Phase 6 complete - skills are SPA; app
detail, chat, and terminal stay legacy); Phase 7A complete (2026-10-29; the read-only
application-detail SPA shell and restart are previewable with `HANSE_UI_SPA_ROUTES=app`; the
registry keeps `app` legacy); Phase 7B complete (2026-10-29; the git workbench status/refresh,
fetch/update/push/commit-all/branch-switch flow and remotes are ported onto the existing git JSON
handlers; the registry kept `app` legacy). Phase 7C complete (2026-10-29; image build/rollback/
check/logs/poll, app-scoped SSH allowlist/grant/revoke/approve/reject/audit, and exact-name deletion
are ported; `app` is now `spa: true`, and only chat/terminal remain legacy). Gate D1 revised (2026-10-29): migrate chat/terminal in a separate
design/plan cycle, then operator verification before Phase 8 cleanup.
Design: [Incremental SPA migration](../design/spa-migration.md) (approved, `oracle` round 5 PASS;
flag/test-glob/no-JS clarifications recorded in revision 6).
Owner decisions: [open questions](../open-questions.md), 2026-10-28.
Scope: a route-by-route strangler migration of the authenticated coordinator UI to a Vue 3 SPA,
with server-rendered chrome, client-owned `<main>`, cookie-only page props, deterministic E2E gates,
and per-route rollback.
Non-goals: migrating `/chat` or `/terminal`; changing `DESIGN.md`; database or runtime changes;
server-side rendering of page content; Vite 8 / Vitest 5 / jsdom 30 / TypeScript 7 upgrades.

## Bindings

- Design author: maintainer; design reviewer: `oracle` (round 5 PASS).
- Plan author: maintainer; plan reviewer: `momus`.
- Design index: `docs/design/README.md`; plan index: `docs/plans/README.md`; journal index:
  `docs/journal/README.md`; open questions: `docs/open-questions.md`.
- Language: English for docs, code comments, and notices.
- Verification: `npm run lint`, `npm run typecheck`, `npm run typecheck:ui`,
  `npm run typecheck:e2e`, `npm test`, `npm run build`, `npm run check:sensitive`,
  `npm run check:ui`, and `npm run test:e2e` for a changed route.
  `typecheck:e2e` (Phase 0+) and `check:ui` (Phase 1A+) are **plan-local** gates: `docs/process.md`
  lists the repository-wide gates, and this plan adds these two for the program. Phase 0 has no UI
  project, so `typecheck:ui` starts in Phase 1A.
- Commit policy: one coherent stage commit only when the owner explicitly authorizes it. Autonomous
  mode follows `docs/process.md`; checkpoints in this plan are not commits unless the owner has
  authorized them.
- Target: Node `>=20.19.0`; no new runtime dependency; no database migration.
- Phase 0 time box: 5-7 days. If exceeded, reduce only the E2E flow set above the non-reducible
  core; do not replace the deterministic fixture.

## Owner and architect decisions (closed)

1. **Framework** - Vue 3 + Vue Router + Pinia; `@tanstack/vue-query` for server data. Pinia is
   limited to boot/session, toasts, dialogs, and client UI state.
2. **Chat and terminal** - decided after the app-detail stage (Stage 7). Default: keep both as
   legacy documents. A separate design is required to migrate them.
3. **Test harness** - Playwright 1.64.1 for E2E plus Vitest with jsdom and `@vue/test-utils`.
4. **Turbo / Inertia** - rejected; go directly to the Vue SPA.
5. **SPA auth** - cookie-only for the SPA document and `/api/ui/*`; legacy pages unchanged.
6. **Initial data** - boot JSON carries the first page's props; measured against S16.
7. **Legacy islands** - none on SPA routes; all island behavior is ported before cutover.
8. **Stage 0 gate** - deterministic fixture coordinator is a hard gate; only the flow set above the
   non-reducible core may be reduced.
9. **Node floor** - Vite 7 raises the documented floor to `>=20.19.0`.

## Cross-phase invariants

- **S1/S2** - cutover per route; unmigrated routes keep their current HTML/scripts/redirects.
- **S3** - one shell renderer: server-rendered sidebar/topbar/breadcrumb/page header ownership is
  explicitly defined; no second chrome implementation.
- **S4/S5** - client navigation inside migrated routes; full document load at the boundary.
- **S6/S7** - existing `/api/*`, CLI, MCP, IDE extension, master, chat SSE, terminal WebSocket, and
  proxy contracts unchanged; SPA document and `/api/ui/*` are cookie-only, agent tokens 403.
- **S8** - `assets/app.css` remains the only stylesheet; no color/size/space/radius/shadow/motion
  value outside `DESIGN.md`; no `<style>` in `ui/`.
- **S9** - every migrated route has `HANSE_UI_LEGACY=1`, `?legacy=1`, and per-route rollback.
- **S10** - `/chat`, `/terminal`, `/ide`, `/preview` untouched.
- **S11** - no DB migration; Vue/Vite/test tooling are devDependencies; only built static assets
  ship.
- **S12** - no UI build ⇒ full legacy UI; missing/invalid/partial manifest ⇒ legacy + log.
- **S13** - API/service tests unchanged; per-route HTML tests retire at cutover; one legacy rollback
  smoke remains per migrated route; UI component tests in jsdom; E2E gates.
- **S14** - route announcer, focus, title, `aria-current`, `.page` scroll reset, dialog focus,
  SmartLink modifiers, reduced motion.
- **S15** - no secrets in boot or `/api/ui/*`; masked settings equal the current HTML; sentinel
  secret test.
- **S16** - `/projects` first load ≤ 200 KiB gzip including HTML, CSS, boot, entry, first chunk.

## Route ids and enablement

`src/shared/routes.ts` is the single source of truth. The registry defines:

| id | path pattern | nav | cutover |
| --- | --- | --- | --- |
| `projects` | `/projects` | projects | 1B |
| `overview` | `/` | overview | 2 |
| `project` | `/projects/:id` | project | 2 |
| `handoffs` | `/handoffs` | handoffs | 3 |
| `ssh` | `/ssh` | ssh | 4 |
| `settings-global` | `/settings` | settings | 5 |
| `settings-project` | `/projects/:id/settings` | settings | 5 |
| `settings-app` | `/projects/:id/apps/:app/settings` | settings | 5 |
| `skills-global` | `/skills` | skills | 6 |
| `skills-project` | `/projects/:id/skills` | skills | 6 |
| `skills-app` | `/projects/:id/apps/:app/skills` | skills | 6 |
| `skills-new` | `/skills/new` | skills | 6 |
| `skills-detail` | `/skills/:id` | skills | 6 |
| `app` | `/projects/:id/apps/:app` | project | 7 |

`/skills/new` must match before `/skills/:id`. `matchPage` is page-only and never matches `/api/*`,
`/chat`, `/terminal`, `/ide`, `/preview`, or `/assets/*`.

**Enablement semantics** (design §6.8):

- `HANSE_UI_SPA_ROUTES` **unset** → routes with registry `spa: true` are enabled by default.
- `HANSE_UI_SPA_ROUTES=""` → all routes legacy.
- `HANSE_UI_SPA_ROUTES="projects,overview"` → only those ids; unknown ids log and are ignored.
- `HANSE_UI_LEGACY=1` > `?legacy=1` > the allowlist > manifest validity > registry `spa`.

Each cutover flips the route's registry `spa` to `true`; a rollback pins the env var to a list that
excludes it, or to the empty string. A startup test asserts the default/empty/list behavior.

## Phase 0 - Harness and tooling spike

### Boundaries

In scope: Playwright harness, deterministic fixture coordinator, Vitest jsdom project, baseline
characterization, test scripts, CI E2E job, `tsconfig.e2e.json`.
Out of scope: SPA code, Vue dependencies, `app.js` split, any route cutover.

### Invariants

- The fixture uses the real `HttpDeps` + `createHttpServer`, a temp SQLite DB, synthetic
  projects/apps, and the test operator token. No deployment secrets, real projects, or real data.
- Real services where cheap: `SettingsService`, `SkillService`, `GitService` with a fixture repo,
  and SSH host/grant CRUD with `testHost`/network faked.
- Stubs only: Docker/runner/opencode, image builds, previews, deletion, dispatcher, chat/SSE.
- The server Vitest project runs with `HANSE_UI_LEGACY=1`.
- The non-reducible E2E core is login/logout, one mutation, a chrome swap (when SPA exists), the
  SPA↔legacy boundary (when SPA exists), rollback, and a console/page-error check. Stage 0 covers
  login/logout, one mutation, and console/page errors.

### Work

1. Add `@playwright/test@1.64.1` and `jsdom@26.1.0` as **root** devDependencies. Do **not** add
   `@vue/test-utils` yet (it pulls Vue peers; Phase 1A adds it with Vue). Add scripts `test:e2e`
   (`npm run build && playwright test`), `test:ui`, and `typecheck:e2e`.
2. `vitest.config.ts`: two projects.
   - `server`: `environment: "node"`, include `test/**/*.test.ts` and `test/**/*.test.mjs`, exclude
     `test/ui/**` and `test/fixtures/**`, `env: { HANSE_UI_LEGACY: "1" }`.
   - `ui`: `environment: "jsdom"`, include `ui/**/*.test.ts` and `test/ui/**/*.test.ts`,
     `setupFiles: ["test/ui/setup.ts"]`.
   Keep the existing 15 s test timeout. Add `test/ui/smoke.test.ts` (asserts `document` exists) so
   the UI project is never empty.
3. Create `test/ui/setup.ts` with jsdom gaps used later (`matchMedia`, `ResizeObserver`,
   `HTMLDialogElement.showModal` if missing). Tests that need jsdom under `test/ui/**` run in the
   `ui` project.
4. Create `e2e/support/seed.ts`: temp DB, migrations, two synthetic projects/apps, a
   `test-operator-token` operator row, fixture git repo, SSH host/grant rows, settings/skills rows.
   The token is an obvious test literal, not a credential.
5. Create `e2e/support/server.ts`: build `HttpDeps` from the seed, real services, stub boundaries,
   and start `createHttpServer` on `HANSE_E2E_PORT` (default `4310`). It reads `HANSE_E2E_MODE`
   (`spa` or `legacy`) and `HANSE_UI_SPA_ROUTES`/`HANSE_UI_LEGACY` from env. It never prints a
   secret or an ephemeral port; the port and token are fixed in the Playwright config/env.
6. Create `playwright.config.ts`:
   - three `webServer` entries: SPA mode on `4310` (`HANSE_E2E_MODE=spa`), legacy mode on `4311`
     (`HANSE_E2E_MODE=legacy`, `HANSE_UI_LEGACY=1`), and empty-allowlist mode on `4312`
     (`HANSE_E2E_MODE=spa`, `HANSE_UI_SPA_ROUTES=""`); all use `e2e/support/server.ts`, the same
     fixed `HANSE_E2E_TOKEN=test-operator-token`, and separate temp DBs recreated on start. The DB
     path is `mkdtemp` per server process; no shared file.
   - three projects: `spa` (`4310`), `legacy` (`4311`), `allowlist-empty` (`4312`);
     `dependencies`/`testMatch` route specs appropriately. Per-route exclusion
     (`HANSE_UI_SPA_ROUTES` without `projects`) is covered by the startup flag-precedence test, not
     by a fourth browser project. WebServer command: `node --import tsx e2e/support/server.ts`.
   - `workers: 1`, `fullyParallel: false` (shared fixture); `reuseExistingServer: false` (or only
     with `HANSE_E2E_REUSE=1` and a fresh DB). The server recreates its temp DB on start.
   - `use.launchOptions.executablePath` from `PLAYWRIGHT_CHROMIUM` (local baked Chromium); bundled
     Chromium in CI; `args: ["--no-sandbox", "--disable-dev-shm-usage"]`.
7. Write the Stage 0 E2E specs: `e2e/auth.spec.ts`, `e2e/projects.spec.ts`,
   `e2e/project-detail.spec.ts`, `e2e/app.spec.ts`, `e2e/handoffs.spec.ts`,
   `e2e/settings.spec.ts`, `e2e/skills.spec.ts`, `e2e/ssh.spec.ts`, `e2e/error.spec.ts`.
   Each runs in the `legacy` project in Stage 0. The `spa`/`allowlist-empty` projects use
   `e2e/spa-placeholder.spec.ts` with `test.skip()` until 1B so Playwright never has an empty
   project. The named "one mutation" is the legacy `POST /api/projects` create-project form.
8. Add a CI `e2e` job after `verify`: `npm ci`, Playwright browser install (or baked Chromium in a
   matching image), `npm run test:e2e` (the script runs `npm run build` first; do not build twice).
   Add `npm run typecheck:e2e` to the `verify` job and a Node 20.19/22 install matrix
   (`npm ci` + `npm run build`) to prove the documented floor.
9. `tsconfig.e2e.json`: `noEmit`, `module: "ESNext"`, `moduleResolution: "Bundler"`,
   `target: "ES2022"`, `types: ["node"]`, include `e2e/**/*.ts` and `playwright.config.ts`.
   `npm run typecheck:e2e` uses it. (`moduleResolution: "Bundler"` is invalid with the root
   `module: "NodeNext"`, so this project must set its own `module`.)
10. Record the baseline (commit SHA, gate output, E2E report, route inventory) in **untracked**
    `docs/deploy/` or the workspace; use placeholders, never host paths.

### Acceptance criteria

- `npm run lint`, `npm run typecheck`, `npm run typecheck:e2e`, `npm test`, `npm run build`,
  `npm run check:sensitive` green.
- `npm run test:e2e` green against the current legacy app; the core flows run.
- The fixture asserts one mutation and a `303` + notice, and fails on console/page errors.
- No production behavior changes; the diff is tests, config, scripts, CI, and docs only.
- `npm test` is green both with and without `assets/ui`.

### Verification

```bash
npm run lint
npm run typecheck
npm run typecheck:e2e
npm test
npm run build
npm run check:sensitive
npm run test:e2e
git status --short   # only tests/config/scripts/CI/docs
```

### Rollback

Delete `e2e/`, `playwright.config.ts`, `tsconfig.e2e.json`, `test/ui/setup.ts`, the new
devDependencies, scripts, and CI job. Production code is untouched.

### Test changes

New tests only. Existing tests remain unmodified except the Vitest project configuration. No
page-HTML test is retired.

## Phase 1A - SPA infrastructure, flag off

### Boundaries

In scope: `app.js` split, cookie-only helper, `x-hanse-client` passthrough, shared route manifest,
projects props extraction, chrome fragment, `/api/ui/projects`, `/api/ui/chrome`, `spa.ts`, Vite/
Vue scaffolding, build/asset pipeline, Tailwind source, Docker/CI/docs, Node floor.
Out of scope: enabling any route, migrating `/projects`, removing any legacy renderer.

### Invariants

- Legacy pages load `app.js` + `app-content.js`; `/login` loads both; SPA documents load only
  `app.js`. `documentPage()`/`appShell()` gain `contentScript`.
- `humanFromCookie()` is cookie-only; `humanFrom()` remains for legacy pages and bearer APIs.
- `x-hanse-client` reaches `HttpRequest.headers` through `createHttpServer`.
- `src/shared/routes.ts` has no `node:*` imports; `matchPage` is page-only.
- `maybeServeSpa` is the single page-dispatch point, runs before feature routers and
  `handleRequest`, performs the agent-token rejection, and is a no-op when no route is enabled.
- Manifest validation fails closed to legacy. `#ui-fallback` is hidden by default and reveals only
  after the 4 s CSS delay; a successful mount replaces `<main>`.
- No SFC `<style>`; `@source "../../ui"`; sentinel class assertion.

### Status codes

| Case | Response |
| --- | --- |
| `/api/ui/*` with no/expired human cookie | `401 {error:"sign in required", code:"unauthenticated"}` |
| `/api/ui/*` with a human bearer token and no cookie | `403 {error:"cookie sign-in required", code:"cookie_required"}` — detected by a present `Authorization` header; `humanFromCookie` is cookie-only |
| `/api/ui/*` or a page with an agent token | `403 {error:"agent tokens may only call the MCP endpoint"}` |
| SPA document with a human bearer and no cookie | `302 /login?next=<local path>` (page auth is cookie-only) |
| SPA mutation with unsupported `Content-Type` | `415 {error:"unsupported content type", code:"content_type"}` |
| SPA mutation with an invalid form body | `400 {error, code}` from the existing validator |
| SPA mutation with a **present** cross-site/mismatched `Origin` | `403 {error:"cross-site request rejected", code:"origin"}`; an absent `Origin` is allowed |
| Unknown `HANSE_UI_SPA_ROUTES` id | log `ui.unknown_route`; treat that id as legacy |
| Missing/invalid/partial UI manifest | log `ui.manifest_invalid`; all routes legacy |

### Work

1. **`assets/app.js` split.** Move dialogs, menus, segmented controls, toast close/autodismiss,
   password toggles, and submit-busy to `assets/app-content.js`. Keep drawer, theme, nav, and
   `[data-nav-close]` in `app.js`. Keep the existing `data-no-busy` opt-out (it already exists at
   `assets/app.js:212`). Add `/assets/app-content.js` to the `ASSETS` allowlist. Add
   `contentScript?: boolean` to `documentPage`/`appShell` (default `true`); `loginPage` keeps both;
   `spa.ts` passes `false`. Tests live in `test/ui/app-js-split.test.ts` (jsdom) and
   `test/ui/shell-scripts.test.ts` (script-tag matrix for legacy, SPA, login).
2. **`src/http/auth.ts`.** Add `humanFromCookie(deps, request)` using `cookieToken` ->
   `authenticate` and requiring `kind === "human"`. Tests: cookie human accepted; bearer human
   rejected; agent cookie rejected; malformed cookie rejected.
3. **`src/http/server.ts`.** Add `x-hanse-client` to the fixed header passthrough. The contract
   test lands in Phase 1B through `createHttpServer`.
4. **`src/shared/routes.ts`.** Add the route ids/paths from the table above, `matchPage`,
   `isSpaRoute`, `isSpaPath`, and nav metadata. Add a purity test (no `node:` imports) and
   route-table tests covering the 112 path literals and feature-router precedence.
5. **Props extraction.** Add `src/http/props/projects.ts`; `renderProjects` and the future endpoint
   call it. Characterization tests pin the current project list/search/create page data. Keep the
   legacy HTML test as the rollback smoke.
6. **Chrome fragments.** Add `renderSidebarNavInner`/`renderBreadcrumbInner`; `appShell` wraps each
   in exactly one `<nav id="sidebar-nav">`/`<nav id="breadcrumb-host">`; add `#route-announcer`,
   `data-nav-id`, `data-project-id`. Tests assert one nav and no duplicate `aria-label`.
7. **`/api/ui/projects` + `/api/ui/chrome`.** Cookie-only, `no-store`, page props plus `chrome`.
   Use the status table above. Check in this order: agent token → agent-specific 403; then
   `Authorization` present with no cookie → `403 cookie_required`; then no credentials →
   `401 unauthenticated`. Add a
   route-table-driven secret sentinel test that seeds provider keys, MCP tokens, git credentials,
   and settings secrets and asserts they are absent from every `/api/ui/*` response and boot.
8. **`src/http/spa.ts`.** Manifest loader/validator, boot serializer (`<` → `\u003c`),
   `renderSpaDocument`, `maybeServeSpa`, flag precedence, agent-token rejection, `#ui-fallback`,
   `vite:preloadError` handling, and the `HANSE_UI_DEV_URL` branch that emits the Vite client/entry
   URLs. Tests: missing/invalid/partial manifest, unknown route id, flag precedence
   (unset/empty/list), agent token 403, cookie-only auth, no-SPA default, dev-URL emission.
9. **`ui/` scaffold.** Add **root** `package.json` devDependencies (`vue`, `vue-router`, `pinia`,
   `@tanstack/vue-query`, `vite`, `@vitejs/plugin-vue`, `vue-tsc`, `@vue/test-utils`), `vite.config.ts`,
   `tsconfig.ui.json`, `ui/main.ts`, `ui/router.ts`, `ui/boot.ts`, `SmartLink.vue`, `ToastHost.vue`,
   a minimal `ui/pages/ProjectsPage.vue` placeholder, and `ui/components/` primitives. No route is
   enabled by default yet; the dev smoke is the only override.
10. **Build/tooling.** Add `build:ui`, `dev:ui`, `dev:css`, `typecheck:ui`, `test:ui`, `check:ui`.
    `build:ui` uses Vite; `dev:ui` uses `HANSE_UI_DEV_URL=http://127.0.0.1:5173`, Vite
    `server.cors` for the localhost coordinator, `server.allowedHosts`, and `base: "/assets/ui/"`.
    `spa.ts`/`renderSpaDocument` emit the `@vite/client` and `main.ts` module URLs from
    `HANSE_UI_DEV_URL`; add a unit test for that branch. Add a `dev:ui` smoke that runs the
    coordinator with `HANSE_UI_SPA_ROUTES=projects` (dev-only; the default stays legacy), opens
    `/projects`, and asserts the Vite module and HMR client load. `check:ui` is
    `scripts/check-ui.mjs`: fail on `<style` in
    `ui/**/*.vue`; assert the sentinel class `hanse-ui-sentinel` (used only in a Vue component) is
    present in built `assets/app.css`. Update `npm run build` to `tsc && build:css && build:ui`.
    Add `assets/ui/` to `.gitignore`.
11. **Tooling spike exit.** Run `npm run lint` (Biome `.vue` with
    `html.experimentalFullSupportEnabled`/`html.formatter.enabled`), `npm run typecheck:ui`,
    `npm run build:ui`, `npm run check:ui`, `npm run test:ui`, and a Docker `runtime` build. Pass
    criteria: all exit 0, at least one SFC and one component test are processed, and a second
    `biome check`/format run leaves the tree unchanged (that is the "unstable output" trigger).
    If Biome's `.vue` support fails or is non-idempotent, switch to scoped `eslint-plugin-vue` +
    Prettier for `**/*.vue` only, exclude `**/*.vue` in Biome `files.includes`, re-run, and record
    the decision. Do not cut over `/projects` before this passes.
12. **Deploy/docs.** Update Docker (`COPY ui`, `vite.config.ts`, `tsconfig.ui.json`), CI
    (`typecheck:ui`, `typecheck:e2e`, UI project in `npm test`, `check:ui`), `package.json`
    `engines`, `README.md`, `AGENTS.md`, `docs/current-state.md`, `.env.example`, and
    `docs/deployment.md` with `HANSE_UI_LEGACY`, `HANSE_UI_SPA_ROUTES`, and `HANSE_UI_DEV_URL`.

### Acceptance criteria

- All gates green; existing tests unmodified; no route served by SPA by default.
- `npm run build` produces `assets/ui/.vite/manifest.json`; the server validates it and falls back
  to legacy when it is missing/invalid.
- `npm run dev:ui` + coordinator serves HMR modules on the coordinator shell; no cookie split.
- `/api/ui/projects` is cookie-only; bearer human token is rejected; agent token is 403.
- The sentinel class is present in `assets/app.css`; no SFC `<style>` exists.
- The `dev:ui` smoke and the status-code matrix pass.

### Verification

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
node --version   # >=20.19.0
```

### Rollback

Keep all registry `spa` flags false; `HANSE_UI_SPA_ROUTES=""` serves all legacy. The `app.js` split
is behavior-preserving and covered by tests. Revert the phase by removing the new modules/assets and
the build step.

### Test changes

New: `test/shared-routes.test.ts`, `test/projects-props.test.ts`, `test/ui-props-auth.test.ts`,
`test/ui-manifest.test.ts`, `test/ui/shell-scripts.test.ts`, `test/ui/app-js-split.test.ts`,
`test/ui/*.test.ts`. Existing tests stay unmodified; the legacy project-page HTML test remains.

## Phase 1B - `/projects` cutover

### Boundaries

In scope: the first migrated route, client router, boot props, chrome swap, create-project
mutation, rollback flag, E2E legacy+SPA modes, `/projects` first-load budget.
Out of scope: `/`, `/projects/:id`, and every later route; chat/terminal.

### Invariants

- `/projects` is fully client-rendered; the legacy renderer is frozen and reachable only through a
  rollback flag/HTTP override.
- Vue mounts into `<main id="main">` and renders `<header class="page-header">` + `.page__body`,
  matching the legacy DOM.
- Chrome is swapped from the server fragment; the client does not reimplement sidebar order/counts/
  breadcrumb labels.
- `POST /api/projects` accepts form-encoded bodies from the SPA and returns
  `200 {ok:true, project}` only when `X-Hanse-Client: spa`; `Accept` alone keeps the legacy `303`.
- A create-project success navigates to the still-legacy `/projects/:id` with a full document load.
- `vite:preloadError` reloads once; `#ui-fallback` stays hidden on success.

### Work

1. `ui/` app: `main.ts` reads `#hanse-boot`, installs Pinia/Vue Router/vue-query, mounts into
   `#main`; `router.ts` maps enabled routes; `useChrome` swaps `#sidebar-nav` and
   `#breadcrumb-host`; `SmartLink` chooses `RouterLink` vs `<a>`.
2. `ProjectsPage.vue`: search, table, empty state, project links, create-project dialog, loading/
   error states, master exclusions, responsive layout.
3. `POST /api/projects` SPA branch: form-encoded, `X-Hanse-Client`, same-origin,
   `200 {ok:true, project}`; legacy 303 preserved; contract matrix through `createHttpServer`
   (header present/absent, form/JSON, cross-origin).
4. `apiMutation` helper: form vs JSON per endpoint, typed errors, toasts via `ToastHost`; initial
   notice from boot.
5. Chrome fragment refresh after create and on navigation/visibility; delegated drawer close;
   active nav/aria; focus/title/announcer/scroll.
6. `#ui-fallback` CSS; `vite:preloadError`; 401 redirect; route error view.
7. Tailwind sentinel assertion and `assets/ui` manifest validation in the real server.
8. E2E: `/projects` legacy and SPA; search; create; project link boundary; refresh/deep link;
   back/forward; chrome swap; mobile drawer; rollback (`HANSE_UI_LEGACY=1`, `HANSE_UI_SPA_ROUTES=""`,
   and `?legacy=1`); failing entry fallback (Playwright `page.route` intercepts the entry module and
   returns a 500 or a throwing module, no production test hook); no console/page errors; legacy 303
   form path.
9. Measure `/projects` first-load transfer with Playwright/CDP `Network.loadingFinished`
   `encodedDataLength` for the document, `assets/app.css`, entry JS, and first route chunk; assert
   ≤ 204,800 bytes and record the number. Measure CLS with an init-script `PerformanceObserver`
   (layout-shift, excluding recent input) and assert ≤ 0.1.

### Acceptance criteria

- Every `/projects` feature works; the SPA and legacy pages are visually equivalent.
- Deep link, refresh, back/forward, and the boundary to `/projects/:id` work.
- `HANSE_UI_LEGACY=1`, `HANSE_UI_SPA_ROUTES=""`, and `?legacy=1` serve the legacy page; pinning the
  allowlist to exclude `projects` serves it after restart.
- `POST /api/projects` with the SPA header returns `200 {ok:true, project}`; without it returns the
  existing 303.
- `/projects` first load ≤ 200 KiB gzip; CLS ≤ 0.1.
- No fallback flash, no console/page errors.

### Completion record (2026-10-28)

`/projects` is the first cutover. The registry keeps `spa: true` for `projects` only; `/`,
`/projects/:id`, and every later route remain legacy.

- **Page.** `ui/pages/ProjectsPage.vue` renders the legacy header, six-column `table--stack` ledger,
  search toolbar, both empty states, deletion status, time tags, and the native `#new-project`
  dialog. It reads boot props immediately, then uses Vue Query keyed on `?q=` with
  placeholder/previous data, a non-blocking refetch indicator, and an inline error state with Retry
  and `?legacy=1`. Create success performs a full document load to the legacy project detail with
  `notice=Project+created.&tone=success`; failures keep the dialog open and raise an error toast.
- **Client plumbing.** `ui/api.ts` provides `apiQuery`/`apiMutation` (`X-Hanse-Client: spa`,
  form/JSON bodies, typed `ApiError`, 401 login redirect). `useChrome` swaps both chrome fragments,
  sets the title, focuses `#main`, resets `.page`, announces, closes the mobile drawer, and refreshes
  chrome on visibility. `App.vue` adds a route error view with reload and `?legacy=1`.
- **Server fixes found during the gate.** Vite-built assets under `/assets/ui/*` were not served by
  the coordinator; `handler.ts` now serves them with immutable caching and path-traversal rejection.
  S16 was measured from browser transfer bytes, so `server.ts` now gzip-compresses compressible
  responses when the client offers gzip. Both are additive and do not change route flags or the
  mutation contract.
- **Tests.** New/updated component tests cover `ProjectsPage` (initial rows/counts, search, both
  empty states, loading/error, create success/failure, boundary links), `apiQuery`/`apiMutation`
  (headers, bodies, error envelope, 401), and `useChrome` (swap, title, focus/scroll, drawer,
  visibility, initial no-double-fetch). `projects.spec.ts` runs in all three E2E projects and asserts
  the SPA `200` JSON vs legacy `303`; `spa-projects.spec.ts` covers deep link, refresh,
  back/forward, chrome swap, the legacy detail boundary, `?legacy=1`, the legacy/empty-allowlist
  rollback servers, a failing entry fallback, no fallback flash, no console/page errors, transfer,
  and CLS.
- **Measured.** First load: document 4,638 + CSS 27,635 + entry 98,834 + route chunk 8,821 =
  **139,928 bytes** (limit 204,800). **CLS 0.0** (limit 0.1). Visual parity: computed styles and
  the `main` element structure match the legacy page at 390/768/1440, dark and light, with no
  horizontal overflow.

### Verification

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

### Rollback

`HANSE_UI_LEGACY=1` (global), `HANSE_UI_SPA_ROUTES=""` (all legacy), or
`HANSE_UI_SPA_ROUTES` set to the remaining ids; restart. The legacy renderer remains.

### Test changes

Keep `test/http.test.ts` `renders the projects index and filters by query` as the legacy rollback
smoke. Add component tests for `ProjectsPage`, `SmartLink`, `useChrome`, `ToastHost`, and the create
dialog; add the `/projects` E2E spec in both modes. No API/service test is deleted.

## Phase 2 - `/` and `/projects/:id`

### Boundaries

In scope: fleet overview, project detail, project/app creation, handoff creation, handoff
decisions, policy editor, deletion, master variants.
Out of scope: app detail, chat, settings, skills, SSH.

### Invariants

- `POST /api/projects/:id/apps`, `POST /api/handoffs`, and
  `POST /api/handoffs/:id/decision` gain SPA success branches with form-encoded bodies:
  - add app → `200 {ok:true, app}`;
  - decision → `200 {ok:true, decision}`;
  - handoff create → `queued` 201, `awaiting_approval` 202, `denied` 403, `existing` 409,
    empty summary 400, each with `{handoffId,status,state}` where the design specifies it.
- The legacy `303` path is unchanged; `Accept` alone is not enough.
- Project/app deletion uses the real confirmation contract; E2E with the fake deletion service is
  a contract test, not a destructive-flow test.
- The master project/app variants are read-only and use the same components with a master flag.
- The `/projects/:id` → `/projects/:id/apps/:app` boundary is a full document load until Phase 7.

### Work

1. Props: `src/http/props/overview.ts`, `src/http/props/project.ts`; legacy renderers consume them.
2. Endpoints: `/api/ui/overview`, `/api/ui/projects/:id`; cookie-only; `no-store`; chrome.
3. Pages: `OverviewPage.vue`, `ProjectPage.vue` with apps table, add-app dialog (path/remote clone),
   new-handoff dialog, policy editor, delete dialogs, decision/reply actions, master variant.
4. SPA branches: add app, create handoff, decision; contract matrix for form/JSON, content-type,
   cross-origin, and the legacy 303 path.
5. Chrome: scoped settings/skills hrefs, project sidebar list, counts after mutations.
6. E2E: overview; create project; add app by path; add app by clone against a fixture remote;
   create/approve/reject/relaunch/cancel handoff; policy save/delete; exact-name project/app delete
   contract; master read-only; boundary.
7. Visual QA at 390/768/1440, dark/light.

### Acceptance criteria

- The full project lifecycle works from the SPA; notices/errors match the legacy behavior.
- The legacy form path still returns `303` + notice; CLI/MCP/extension tests unchanged.
- Master variants expose no mutating action.
- Rollback and boundary matrices pass.

### Completion record - Phase 2B (2026-10-29)

Phase 2A (props/endpoints) landed before this record. Phase 2B cuts over the fleet overview only:
the registry now has `spa: true` for `overview` and `projects`; `project` and every later route stay
`spa: false`, and `/projects/:id` remains a legacy document.

- **Page.** `ui/pages/OverviewPage.vue` renders the legacy header, four-cell `watch-strip`, project
  ledger, recent-handoffs card, waiting-for-approval `route-card`s, runtime summary, both empty
  states, and the new-project action only when projects exist. It reads boot props immediately and
  uses Vue Query keyed on the overview endpoint with a non-blocking refresh indicator and an inline
  error state with Retry and `?legacy=1`. Project links are `SmartLink`s; the detail route is not an
  SPA path, so it renders a plain anchor and crosses the boundary with a full document load.
- **Shared components.** `ui/components/NewProjectDialog.vue` is the single native `#new-project`
  dialog used by both `OverviewPage` and `ProjectsPage`; it keeps the legacy labels/hint, required
  input, pending state, error toast, `apiMutation` form request with `X-Hanse-Client: spa`, and the
  full-document navigation to `/projects/:id?notice=Project+created.&tone=success`.
  `StatusPill`, `RouteText`, and `RouteCard` plus `ui/status.ts` mirror the legacy
  status/reply/runtime vocabulary without importing server code.
- **Navigation.** `ui/router.ts` registers `/` with a lazy `OverviewPage`. `ProjectsPage` and
  `OverviewPage` only trust boot props when `boot.route.id` matches their route, so a client
  navigation fetches that route's `/api/ui/*` props instead of rendering the previous page's data.
- **Tests.** New `OverviewPage` component tests cover boot rendering, the empty state, shared-dialog
  creation, cross-route boot fetch, and the legacy boundary link. `e2e/overview.spec.ts` runs in
  `spa`, `legacy`, and `allowlist-empty` and covers counts, ledger, recent handoffs, waiting cards,
  runtime, create-project, and the project-detail boundary. `e2e/spa-overview.spec.ts` covers deep
  link, refresh, client navigation to `/projects`, chrome swap/title/active nav, `?legacy=1`, the
  rollback servers, no fallback flash, no console/page errors, and records the first-load transfer.
  `test/shared-routes.test.ts` updates its deliberate Phase 1B cutover assertions to include
  `overview`.
- **Measured.** Overview first load: document 4,930 + CSS 27,635 + entry 98,982 + route chunk 5,099 =
  **136,646 bytes** (recorded, no hard budget because S16 remains `/projects`). `/projects` first
  load stayed at **134,719 bytes** with CLS 0.0.
- **Not done.** `ProjectPage.vue`, add-app/new-handoff/policy/delete/project actions, and the
  `project` registry flag are Phase 2C.

### Completion record - Phase 2C (2026-10-29)

Phase 2C finishes Phase 2: the registry has `spa: true` for `overview`, `projects`, and `project`;
`app` and every later route stay `spa: false`. `/projects/:id` is client-rendered, and the
project-to-application hop remains a full document load.

- **Page.** `ui/pages/ProjectPage.vue` reproduces the legacy project header (Project overline,
  name/description, root/base/application/waiting meta, Settings, Open IDE, New handoff), the
  four-cell watch strip, applications table (kind, path, runtime, pending-restart link, chat/IDE/app
  links, add app), handoffs table with review dialogs, waiting route cards, manifest, handoff-policy
  editor, and the danger zone. The reserved master project renders the read-only master header and
  card (runtime/kind strip, chat/settings/skills links) with no mutating controls. Application,
  settings, skills, chat, and IDE links are plain anchors; project/overview/projects links use
  `SmartLink`.
- **Actions.** `AddAppDialog`, `NewHandoffDialog`, `HandoffReviewDialog`, `ProjectPolicyCard`, and
  `ProjectDeleteDialog` use the existing handlers: form-encoded add-app (`200 {ok:true, app}`),
  handoff create (`201` queued / `202` awaiting / `403` denied / `409` existing / `400`
  summary-required), decision (`200 {ok:true, decision}`), reply relaunch/retry/cancel, cancel,
  policy save/delete, and project deletion with exact-name confirmation. Every successful mutation
  refetches `/api/ui/projects/:id` and applies its chrome fragment; failures keep the dialog open
  and raise an error toast. No backend route flag or legacy HTML/API semantics changed.
- **Boot/query.** The page trusts boot props only when the boot route id is `project` and its id
  matches the current route; client navigation fetches `/api/ui/projects/:id` with Vue Query.
  Loading, generic error, 404 ("Project not found"), Retry, and `?legacy=1` states are covered.
- **Tests.** New `ProjectPage` component tests (17) cover normal/master rendering, apps/handoffs/
  policy/manifest/danger zone, empty states, cross-route boot fetch, loading/404/error/retry, the
  legacy app boundary, and add-app/create-handoff/decision/relaunch/policy/delete success and
  failure paths. `e2e/project.spec.ts` runs in `spa` and covers render, add app by path and by
  clone (deterministic git daemon), queued/awaiting handoffs, approve/reject, relaunch/retry/cancel,
  policy save/delete, the exact-name deletion contract with a fake deletion service, and the master
  read-only variant. `e2e/spa-project.spec.ts` covers deep link, refresh, client navigation from
  overview and projects, chrome swap/title/history, `?legacy=1`, both rollback servers, the
  app-detail full-document boundary, no fallback flash, no console/page errors, and the transfer
  measurement. The legacy `project-detail.spec.ts` remains the rollback smoke. Existing HTML tests
  were retained rather than retired (the task prohibited test deletion); all remain green.
- **Measured.** `/projects/:id` first load: document 5,610 + CSS 27,635 + entry 99,746 + route chunk
  12,947 = **145,938 bytes** (recorded; S16 remains the `/projects` budget). `/projects` stayed at
  **135,505 bytes** with CLS 0.0.
- **Visual QA.** SPA vs legacy project pages were compared at 390/768/1440 in dark and light:
  matching `h1`, watch-strip labels, table count, `#main` scroll width, and no horizontal overflow in
  either mode. Screenshots are in the untracked workspace evidence directory (`phase2c-visual/`). The
  only structural deltas are the hidden boot marker (`#hanse-boot`), the Vue sentinel, and the
  per-server temp workspace path text.
- **Accepted parity delta.** Handoff spec/result/operator-note text in the SPA review dialog renders as
  pre-wrapped plain text (no `v-html`); the legacy page hydrates those fields as Markdown through
  `handoff.js`. The shared `SafeMarkdown` component lands with the Phase 3 handoff-inbox port.
- **Gaps.** None of the plan-required flows are missing. The fixture adds a fake deletion service
  (contract-only, never destructive) and a fake dispatcher for reply actions; Docker/opencode were
  not used.

### Verification

Same gate commands + the Phase 2 E2E specs (SPA and legacy projects).

### Rollback

Pin `HANSE_UI_SPA_ROUTES` to exclude `overview`/`project`, or set `HANSE_UI_LEGACY=1`; legacy pages
stay.

### Test changes

Keep `renders the fleet overview for a human` as the legacy overview smoke and `renders project
detail with apps, dialogs, and the manifest` as the legacy project-detail smoke. Retire
`marks a deleting project as incomplete...` and `marks a deleting application row...` after the
component/E2E replacement. Keep `test/dashboard-runtime.test.ts` mapping tests; retire only
`renders one runtime row per state` after the component test covers it. Move the
`test/handoff-ui.test.ts` `renders the policy card...` retirement here (it renders the project
page). Keep all API/service tests.

## Phase 3 - `/handoffs`

### Boundaries

In scope: handoff inbox, filters, decisions, reply/relaunch/cancel, project policy links.
Out of scope: browser-side handoff creation (shipped in Phase 2).

### Invariants

- The page reuses the existing handoff policy/reply/cancel JSON APIs; no parallel write path.
- Approval/rejection preserves the `approval_kind` and `reason` semantics and the current
  human-only checks.
- Links to `/projects/:id` are client-side after the Phase 2 cutover; the chat/terminal links remain
  full loads.

### Work

1. `src/http/props/handoffs.ts`; `/api/ui/handoffs`; legacy `renderHandoffs` consumes it.
2. `HandoffsPage.vue`: rows, filters, inline approve/reject, review dialog, reply/cancel, project
   links, empty/error states.
3. Reuse `/api/handoffs/:id/decision`, `/reply/*`, `/cancel`; SPA header for the decision branch.
4. E2E: approve, reject, relaunch, deliver, cancel, policy link, filters, 303 legacy path.

### Acceptance criteria

- Every decision/reply path works; legacy behavior is unchanged.
- The rollback flag serves the legacy inbox.

### Verification

Gate commands + the handoffs E2E spec (SPA and legacy).

### Rollback

Pin `HANSE_UI_SPA_ROUTES` to exclude `handoffs` or set `HANSE_UI_LEGACY=1`.

### Test changes

Keep `test/handoff-http.test.ts` API tests. Keep `renders all nine handoff states with filters and
dialogs` as the legacy smoke; retire `filters handoffs by group and search` and
`test/handoff-ui.test.ts` `loads the hydrator...` after the component/E2E replacement. Keep
`serves the handoff Markdown hydrator` while `handoff.js` is still in the allowlist.

### Completion record - Phase 3B (2026-10-29)

Phase 3B finishes Phase 3: the registry has `spa: true` for `overview`, `projects`, `project`, and
`handoffs`; `ssh`, settings, skills, app detail, chat, and terminal stay `spa: false`.

- **Page.** `ui/pages/HandoffsPage.vue` reproduces the legacy Handoffs header (Workbench overline,
  title, description, total/waiting/active/replies counts), segmented All/Waiting/Active/Closed/
  Replies filters with `aria-current="page"` and counts, the `#handoff-search` form with the hidden
  filter and clear-search link, the Id/Route/State/Summary/Updated/Actions table, `StatusPill`/
  `RouteText`/time tags, inline approve/reject for dispatch and reply approvals, and the shared
  `HandoffReviewDialog` for review and reply actions. Inline decisions use `apiMutation` with
  `decision`, `approval_kind`, and `return_to`; success refreshes props plus chrome and shows a
  toast, failure shows an error toast, and both buttons disable while pending. Review uses
  `row.dialog`, reopens after a refresh, and refetches on `changed`. Empty state, loading, generic
  error, 404, Retry, and `?legacy=1` match the other SPA pages.
- **Boot/query.** The page trusts boot props only when `boot.route.id === "handoffs"` and the
  boot filter/query equal the current route; otherwise it fetches
  `/api/ui/handoffs?filter=&q=` with Vue Query. Filter links and the search form use `router.push`,
  so the URL is the source of truth for filter/query.
- **SafeMarkdown.** `ui/components/SafeMarkdown.vue` clears its container and calls the existing
  `renderMarkdown(container, text)` DOM builder in `onMounted`/`watch`. The review dialog now renders
  specification, result, and operator note through it; the legacy `handoff.js` path is unchanged.
  No `v-html` and no SFC `<style>` were added.
- **Tests.** `SafeMarkdown` component tests cover initial render, text replacement, and no duplicate
  nodes. `HandoffsPage` tests cover boot rendering, filters/search, inline approve/reject success and
  failure (including the pending state), the review dialog with safe Markdown, empty/loading/404/
  generic error/Retry, the project `SmartLink`, and no `<style>`. `handoffs.spec.ts` now runs in
  `spa`, `legacy`, and `allowlist-empty` and covers the boot marker, filters/search, inline
  approve/reject, review/relaunch/retry/cancel, safe Markdown, and the legacy `303` path.
  `spa-handoffs.spec.ts` covers deep links and filter query, refresh, back/forward, chrome/title/
  active nav from the overview, `?legacy=1`, both rollback servers, no fallback flash, no console
  errors, safe Markdown, and client-side project navigation from the empty state. `shared-routes`
  assertions now include `handoffs`. The plan's suggested retirements
  (`filters handoffs by group and search`, `loads the hydrator...`) were not applied because the
  task requires keeping existing tests; the legacy smoke and `test/handoff-http.test.ts` remain.
- **Fixture.** The E2E seed adds three inbox-owned reply/cancel rows with older timestamps and pins
  the long-lived approval summary above them so the existing overview recent-handoffs assertions
  stay stable after the inbox spec mutates its rows.
- **Measured.** No new transfer budget was assigned for `/handoffs`; `/projects` remains the S16
  budget route. The E2E suite is green in all three modes.
- **Visual QA.** The SPA and legacy inbox share the same header, segmented control, toolbar, table,
  and dialog classes from `src/http/ui.ts`. Browser measurements at 390/768/1440 matched the
  `h1`, counts, filter labels, row count, toolbar/segmented/search/table boxes, zero document/page
  overflow, and zero dialog overflow; safe Markdown rendered the same heading/strong/code nodes once.
  The only structural deltas are the hidden boot marker and the Vue sentinel.

## Phase 4 - `/ssh`

### Boundaries

In scope: hosts, test/re-pin, grants, approvals, audit.
Out of scope: app-scoped SSH panel (Phase 7).

### Invariants

- Reuse `/api/ssh/*` and `/api/apps/:app/ssh/*`; no new SSH write path.
- The private key remains write-only; the page never renders it.
- Test connection and pinning keep the current error/warning semantics.

### Work

1. `src/http/props/ssh.ts`; `/api/ui/ssh`; legacy `src/http/ssh.ts` `renderPage` consumes it.
2. `SshPage.vue`: hosts table, add/edit/delete dialogs, Test, re-pin, grants, approvals, audit.
3. E2E: host create/edit/delete; test success/failure; re-pin; grant/revoke; approve/reject; audit
   rows; 303 legacy path.

### Acceptance criteria

- Every SSH action works; no secret is rendered; legacy behavior unchanged.
- Rollback serves the legacy SSH page.

### Verification

Gate commands + the SSH E2E spec (SPA and legacy).

### Rollback

Pin `HANSE_UI_SPA_ROUTES` to exclude `ssh` or set `HANSE_UI_LEGACY=1`.

### Test changes

Keep `test/ssh-http.test.ts` `is human-only, renders the page, and never returns key material` as
the legacy smoke and `serves host, grant, approval, audit, and count routes` as API coverage. Keep
`test/application-ssh.test.ts` (app-page SSH panel) until Phase 7. Add component/E2E tests for the
SSH page.

### Completion record - Phase 4B (2026-10-29)

Phase 4B finishes Phase 4: the registry has `spa: true` for `overview`, `projects`, `project`,
`handoffs`, and `ssh`; settings, skills, app detail, chat, and terminal stay `spa: false`.

- **Page.** `ui/pages/SshPage.vue` reproduces the legacy Access header, title/description, scope
  counts, section nav, `?target=<project>:<app>` picker, four-cell watch strip, host cards with
  pin/approval state and host-key details, the per-application allowlist and grants table, pending
  approve/reject cards, and the read-only audit table. `SshHostDialog.vue` provides add/edit/delete
  with the legacy connection, key, access-policy, host-key, and danger-zone fields. The private key
  is read from the form element at submit time, never stored in boot/props, and cleared on close;
  only the derived public key, fingerprint, and key type are rendered.
- **Actions.** Test connection, Prepare re-pin, and Re-pin call the existing
  `/api/ssh/hosts/:id/test` and `/re-pin` JSON handlers. Add/update/delete use `/api/ssh/hosts`
  (`POST`/`PATCH`/`DELETE`); `apiMutation` gained an explicit method override with the default still
  `POST`. Allowlist save and grant revoke use the project SSH API; approve/reject use the app
  approvals decision API. Every successful action refetches `/api/ui/ssh` and applies its chrome
  fragment; failures keep the dialog open and raise an error toast. No parallel write path or
  backend route flag changed.
- **Boot/query.** Boot props are trusted only when `boot.route.id === "ssh"` and the selected
  target matches the route; otherwise the page fetches `/api/ui/ssh?target=...` with Vue Query.
  Scope changes use `router.push`, refresh/history work, and `?legacy=1` plus both rollback servers
  still serve the legacy document.
- **Tests.** `SshPage` component tests cover boot scoped/unscoped rendering, scope navigation,
  cross-route boot fetch, empty/loading/error/retry, add/edit/delete, test success/failure,
  prepare/re-pin, allowlist/revoke, approve/reject, no secret key in output, and no `<style>`.
  `ssh.spec.ts` runs in `spa`, `legacy`, and `allowlist-empty` and covers the boot marker,
  scope/target queries, hosts/grants/approvals/audit, create/edit/delete, test success/failure,
  re-pin, grant/revoke, approve/reject, the legacy `303` path, and absent key material.
  `spa-ssh.spec.ts` covers deep links, target queries, refresh, back/forward, chrome/title/active
  nav, `?legacy=1`, both rollback servers, no fallback flash, and console/page errors.
  `shared-routes` and the SSH boot assertion now expect `spa: true`.
- **Fixture.** The deterministic seed adds two pending approvals for the alpha grant flow (approval
  supersedes the other pending request for the same app/host, so the tests reject before approving).
  `e2e/support/server.ts` wraps `testHost` with a deterministic transport: an address starting with
  `fail.` times out; every other host authenticates and pins `SHA256:e2e-fixture-fingerprint`;
  Prepare re-pin records the pending observation and the real service performs the re-pin. No
  network or real key is used.
- **Visual QA.** Browser measurements at 1440 and 390 showed matching watch strip, host card,
  access/grants, approvals, and audit-table boxes, with zero document/page horizontal overflow. The
  SPA header is full-bleed like the other SPA pages and adds scope counts, so its outer width and
  height differ from the legacy header; body sections match. The only structural deltas are the
  hidden boot marker, the Vue sentinel, and the unmounted edit dialog before it is opened.
- **Not done.** No transfer budget was assigned for `/ssh`; settings, skills, app detail, chat, and
  terminal remain legacy for later phases.

### Verification

Same gate commands + the SSH E2E specs (SPA, legacy, empty allowlist).

## Phase 5 - `/settings` (three scopes)

### Boundaries

In scope: `settings-global`, `settings-project`, `settings-app`; inheritance; provider keys; model
providers; git credentials and Test connection; restart-required.
Out of scope: skills, app detail.

### Invariants

- Reuse `POST /api/settings`, `/api/settings/provider`, `/api/settings/model-providers`,
  `/api/settings/git`, and restart; no parallel write path.
- Masked values match the current HTML; no secret in props or boot.
- The inherited/overridden/cleared semantics and the explicit restart behavior are preserved.

### Work

1. `src/http/props/settings.ts`; `/api/ui/settings`; legacy settings renderer consumes it.
2. `SettingsPage.vue` with the three scopes, inheritance controls, provider/model provider forms,
   git credentials, Test connection, restart banner.
3. E2E: save/clear/inherit in all scopes; provider add/clear; model provider CRUD; git credential
   save/test; restart-required; 303 legacy path.

### Acceptance criteria

- Every setting saves with the same validation and restart semantics.
- No secret appears in page props, boot, or the E2E report.
- Rollback serves the legacy settings pages.

### Verification

Gate commands + the settings E2E spec (SPA and legacy).

### Rollback

Pin `HANSE_UI_SPA_ROUTES` to exclude the three settings ids or set `HANSE_UI_LEGACY=1`.

### Test changes

Keep all `test/settings-http.test.ts` API/fragment/auth/secret tests, including the
`describe("settings pages and pending state")` HTML assertions, as legacy rollback coverage until
cleanup. Keep `test/settings-store.test.ts`. Keep `test/settings-asset.test.ts` until cleanup because
the legacy rollback page still loads `settings.js`; add component/E2E tests for the Vue page.

### Completion record - Phase 5B (2026-10-29)

Phase 5B finishes Phase 5: the registry has `spa: true` for `overview`, `projects`, `project`,
`handoffs`, `ssh`, `settings-global`, `settings-project`, and `settings-app`; `skills-*`, `app`,
chat, and terminal stay `spa: false`.

- **Page.** `ui/pages/SettingsPage.vue` reproduces the legacy settings header, Global/Project/App
  scope navigation, a target picker built from `SettingsProps.scope.projects`, the
  Agent/Web tools/Context/Git/Restart section nav, warnings, restart-required banner, and the
  native clear dialog. `SettingsRow.vue` renders model, web-driver, context enable/threshold, and
  git identity controls with effective value/source, own state (Set/Inherited/Default/Cleared),
  hints, warnings, scope details, action availability/reasons, and Save/Inherit/Clear semantics.
  `SettingsProviderSection.vue`, `SettingsModelProviderSection.vue`, `SettingsGitSection.vue`, and
  `SettingsRestartSection.vue` own the provider key, custom-model-provider, git SSH/HTTPS, and
  restart flows.
- **Actions.** Settings Save/Inherit/Clear use the existing `POST /api/settings` JSON handler;
  provider rows use `/api/settings/provider`; model providers use
  `/api/settings/model-providers` (create/update/delete); git credentials use
  `/api/settings/git` and the app-scoped `/api/projects/:id/apps/:app/git/test`; restart uses the
  existing `/api/apps/:app/restart?project=` endpoint. Every success refetches
  `/api/ui/settings?scope=&project=&app=` and applies its chrome fragment; failures raise error
  toasts and keep the entered values. No parallel write path and no other backend route flag or
  legacy HTML/API contract changed.
- **Masking.** Provider key inputs are write-only and read from the form element at submit time.
  The git SSH private key, known_hosts, and HTTPS token are never stored in reactive state; they
  are read at submit/test time and cleared after success. Props, boot JSON, toasts, and the DOM
  contain only the literal `Not shown` marker and public metadata (SSH public key, fingerprint,
  known-host presence, HTTPS allowed hosts/username). Component and E2E tests assert synthetic
  sentinels never appear in `page.content()`.
- **Boot/query.** Boot props are trusted only when `boot.route.id` is one of the three settings
  ids and `props.scope.href` matches the current route; otherwise the page fetches
  `/api/ui/settings?scope=&project=&app=` with Vue Query. Scope and target changes use
  `router.push`, so refresh, deep links, back/forward, `?legacy=1`, and both rollback servers keep
  working. Loading, generic error with Retry, and 404 states are covered.
- **Routing/chrome.** `src/shared/routes.ts` flips the three settings ids to `spa: true`;
  `ui/router.ts` registers `/settings`, `/projects/:id/settings`, and
  `/projects/:id/apps/:app/settings` before the generic project route. Chrome, title, breadcrumb,
  `data-nav-id="settings"`, and scoped settings/skills links come from the shared `chromeFor`.
- **Tests.** New `SettingsPage` component tests (15) cover global/project/app boot,
  inheritance/override/cleared rows, scope switching, setting save/error, inherit/clear, provider
  key masking, model-provider update/delete/create, git save/test without secret text, restart,
  cross-route boot fetch, loading, 404, generic error/Retry, and no `<style>`. `settings.spec.ts`
  now runs in `spa`, `legacy`, and `allowlist-empty` and covers the boot marker, three scopes,
  save/inherit/clear, provider/model-provider masking and CRUD, git credential masking and Test
  connection, restart, the legacy `303`, and absent sentinel secrets. `spa-settings.spec.ts` covers
  deep links, refresh, target navigation, back/forward, chrome/title/active nav, `?legacy=1`, both
  rollback servers, no fallback flash, and console/page errors. `shared-routes` now expects the
  three settings routes to be SPA.
- **Fixture.** `e2e/support/seed.ts` adds a global `deepseek` provider key, one custom
  `e2e-llm` model provider, and app-scoped SSH/HTTPS git credentials with synthetic sentinel
  values. `e2e/support/server.ts` supplies a deterministic git `testConnection`, a mutable
  alpha pending-restart flag with `preflightRestart`/`beginRestart`, and the model-provider service.
- **Gate fix.** `ui/components/SshHostDialog.vue` used a private-range placeholder, which the
  required `check:sensitive` gate flags; it now uses the TEST-NET-3 placeholder `203.0.113.10`.
  Behavior is unchanged.
- **Gate results.** `lint` 584 files exit 0 (18 pre-existing warnings); `typecheck`,
  `typecheck:ui`, `typecheck:e2e` exit 0; `test` 158 files / 2873 tests; `build` exit 0
  (`SettingsPage-*.js` 55.3 kB / 13.1 kB gzip); `check:sensitive` pass; `check:ui` 29 SFCs;
  `test:e2e` 101 passed, 1 skipped (settings SPA 5 + SPA-only 4, legacy 6, allowlist-empty 6).
- **Not done.** No transfer budget for settings; `/projects` remains the S16 route. Skills, app
  detail, chat, and terminal remain legacy for Phases 6/7/D1.

## Phase 6 - `/skills` (five routes)

### Boundaries

In scope: `skills-global`, `skills-project`, `skills-app`, `skills-new`, `skills-detail`; inventory,
create, detail/workspace, override, disable, revert, restart.
Out of scope: app detail, chat.

### Invariants

- Reuse `/api/skills*`; no parallel write path.
- SafeMarkdown clears before re-render; no `v-html`.
- Scope visibility, collision warnings, disabled/invalid states keep their current semantics.
- The existing no-JS snapshot fallback remains on the **legacy rollback page only**; SPA routes
  require JavaScript, per design §11.
- `skill-detail.js` is ported; it is not loaded on SPA routes.

### Work

1. `src/http/props/skills.ts`; `/api/ui/skills`, `/api/ui/skills/:id`; legacy renderers consume it.
2. `SkillsInventoryPage.vue`, `SkillCreatePage.vue`, `SkillWorkspacePage.vue`: source/preview tabs,
   references/metadata editing, validation, override/disable/revert, restart.
3. Port the workspace behavior from `skill-detail.js`; use `SafeMarkdown`.
4. E2E: inventory scopes; create; edit; invalid metadata; override; disable; revert; restart;
   mobile/narrow layout; 303 legacy path.

### Acceptance criteria

- Every skill operation works; SafeMarkdown has no duplicate nodes; no `v-html`.
- The legacy no-JS snapshot test still passes on the legacy rollback page.
- Rollback serves the legacy skills pages.

### Verification

Gate commands + the skills E2E spec (SPA and legacy).

### Rollback

Pin `HANSE_UI_SPA_ROUTES` to exclude the five skills ids or set `HANSE_UI_LEGACY=1`.

### Test changes

Keep `test/skills-http.test.ts` route/auth/API tests. Keep `renders the editable workspace...` as
the legacy smoke. Retire the redundant inventory/workspace HTML assertions after component/E2E
replacement, but keep the no-JS snapshot tests (`preserves the hidden bundle snapshot...`,
`preserves invalid metadata...`, `preserves an invalid stored reference...`) until Phase 8 because
they cover the legacy rollback page. Keep `test/skills-asset.test.ts` until cleanup.

### Completion record - Phase 6B (2026-10-29)

Phase 6B finishes Phase 6: the registry has `spa: true` for `overview`, `projects`, `project`,
`handoffs`, `ssh`, the three settings scopes, and `skills-global`, `skills-project`, `skills-app`,
`skills-new`, and `skills-detail`; `app`, chat, and terminal stay `spa: false`. The five skills
routes are client-rendered; `/projects/:id/apps/:app` remains a full document load.

- **Pages.** `ui/pages/SkillsPage.vue` covers the global/project/application inventory and
  `/skills/new`. Inventory reproduces the legacy header, scope nav, counts, All/Defined/Inherited/
  Disabled/Invalid filters, search form, inventory table with origin/state/references/updated and
  effective-source links, empty/search/filter states, collision and restart rails, and the summary.
  The create page uses the same bundle editor with name/description/enabled, details, custom
  metadata, references, source/preview tabs, generated frontmatter with Copy, and local validation
  before the existing `POST /api/skills` create handler. `ui/pages/SkillDetailPage.vue` reproduces
  the workspace: state badge and scope note, restart banner, collisions, issues with repair anchors,
  editable details/metadata/references/source, frontmatter copy, preview via `SafeMarkdown`,
  override/disable/revert and source/effective links, danger-zone delete/revert with exact-name
  confirmation, and read-only inherited/shadowed/hidden/invalid states. No SFC `<style>` or
  `v-html` was added.
- **Actions.** Create/update/override/disable/revert/delete use the existing `/api/skills*`
  handlers through `apiMutation` (JSON bodies and the SPA header); restart reuses
  `/api/apps/:app/restart?project=`. Success refreshes the page props and chrome, raises a toast,
  and removes the cached inventory so a client navigation back does not render the pre-write boot
  snapshot. Failures keep the form open and raise an error toast. No parallel write path exists.
- **Boot/query.** Inventory trusts boot props only when the boot route id matches and
  scope/filter/search match the URL; create trusts `skills-new` props only for the matching context
  and otherwise fetches the scope's inventory props to build the form; detail trusts `skills-detail`
  only for the matching id, otherwise fetches `/api/ui/skills/:id?from=`. A per-document mutation
  marker prevents stale boot props from being reused after a write.
- **Chrome.** `chromeFor` gained an optional scope hint so the new/detail pages get the context
  project/app sidebar skills href, breadcrumb, and skill title instead of the unscoped global link.
  `/skills/new` is registered before `/skills/:id`; skills routes precede the generic project route.
- **Tests.** New `SkillsPage` (10) and `SkillDetailPage` (9) component tests cover boot/scoped
  rendering, filters/search, create success/error/local validation, cross-route fetch, source/
  references/metadata/issues, safe Markdown once, override/disable/revert, save/discard, danger
  delete, restart, 404/loading/error/retry, no `<style>`, and no secrets. `e2e/skills.spec.ts` runs
  in `spa`, `legacy`, and `allowlist-empty` and covers the boot marker, inventory/filters/search,
  create, detail, override/disable/revert at application scope, the legacy 303 path, and secret
  absence. `e2e/spa-skills.spec.ts` covers deep links, refresh, history, client scope navigation,
  chrome/title/active nav, `?legacy=1`, both rollback servers, no fallback flash, and console/page
  errors. `shared-routes` and `skills-props` cutover assertions were updated.
- **Gate results.** `lint` 596 files exit 0 (18 pre-existing warnings); `typecheck`,
  `typecheck:ui`, and `typecheck:e2e` exit 0; `test` 161 files / 2906 tests; `build` exit 0
  (`SkillsPage` 18.8 kB, `SkillDetailPage` 16.1 kB); `check:sensitive` pass; `check:ui` 33 SFCs;
  `test:e2e` 122 passed, 1 skipped (pre-existing).
- **Not done.** No transfer budget was assigned for skills; `/projects` remains the S16 route.
  Application detail, chat, and terminal remain legacy.

## Phase 7 - Application detail (7A/7B/7C, one cutover)

### Boundaries

In scope: `/projects/:id/apps/:app` (`app`); runtime, image panel, git workbench, SSH panel,
restart, delete, chat/terminal/IDE links.
Out of scope: chat, terminal, settings, skills (already migrated).
Internal order: 7A read-only panels + restart, 7B git mutations, 7C image/SSH/delete. One cutover
gate after 7C.

### Invariants

- No legacy island scripts on the SPA route; `git.js`, `images.js`, and `ssh.js` behavior is ported
  before cutover.
- Runtime vocabulary (`starting/running/stopped/error`) and image state vocabulary are preserved.
- Polling intervals: runtime/image as today; git refresh on demand; no extra polling storms.
- The app page's delete flow uses the exact-name confirmation and the existing deletion contract.
- The SPA route can be enabled in E2E before the formal cutover via
  `HANSE_UI_SPA_ROUTES=app` (or the full migrated list) without changing the default. Add an
  `app-preview` webServer/project on `4313` with `HANSE_E2E_MODE=spa`, `HANSE_UI_SPA_ROUTES=app`,
  and its own `mkdtemp` DB for 7A/7B/7C; the registry `spa` flag stays false until 7C. The project
  runs `e2e/app.spec.ts` (SPA assertions) and a placeholder until 7A.

### Work

1. **7A read + restart.** Props/aggregate `/api/ui/apps/:app`; page shell, runtime strip, image/git/
   SSH read panels, restart; no mutations beyond restart. Exit: component tests for the state
   matrix, legacy smoke green, SPA route loads under the E2E allowlist, no console/page errors.
2. **7B git.** Port `git.js` status/fetch/update/push/commit/branch switch/test into hooks/components;
   keep the existing JSON contracts. Exit: fixture-repo E2E for clean/dirty/detached/conflicted/
   upstream states, every action, error mapping; SPA route under the E2E allowlist.
3. **7C image/SSH/delete.** Port `images.js` (build/rollback/check/logs/poll) and the app SSH
   panel; port delete with exact-name confirmation. Exit: image state matrix, polling assertions,
   SSH grant/audit, delete contract; then flip the registry `spa` flag for `app`.
4. Cutover `/projects/:id/apps/:app`; remove `git.js`/`images.js`/`ssh.js` from the SPA document.
5. E2E legacy + SPA: runtime, restart, image build/rollback/check, git actions, SSH grants, delete,
   chat/terminal/IDE links; rollback; visual QA at all widths.

### Completion record - Phase 7A (2026-10-29)

Phase 7A adds the read-only application-detail shell and restart. `src/shared/routes.ts` still has
`spa: false` for `app` and every later route; the page is reachable only through
`HANSE_UI_SPA_ROUTES=app`, `?legacy=1` still serves the legacy document, and Phase 7 is **not**
complete.

- **Backend prerequisite.** `d519ae2` supplied `src/http/props/app.ts` and
  `GET /api/ui/apps/:app?project=`; the UI consumes that contract without changing route flags,
  legacy HTML, or API semantics.
- **Page.** `ui/pages/AppPage.vue` renders the application header and project/app identity, chat/
  terminal/settings/skills/IDE links, the Runtime/Settings state strip, the read-only image rail
  (`AppImagePanel.vue`), the Repository/Changes workbench and Last commit (`AppGitPanel.vue`), the
  app-scoped grants/approvals/audit read panels (`AppSshPanel.vue`), and the read-only master
  variant. Delete controls stay out of 7A; a pending deletion only shows the read-only banner.
- **Reads/polling.** Boot props are trusted only for `route.id === "app"` with matching project and
  application; otherwise the page fetches `/api/ui/apps/:app?project=`. The endpoint is also
  refetched on mount and on manual refresh because boot props carry `git.summary.loaded=false`.
  Runtime polls every 10 s, and image status polls every 3 s only while building. No legacy island
  scripts load on the SPA route.
- **Restart.** The state-strip control opens a confirmation dialog and reuses
  `/api/apps/:app/restart?project=` with same-origin credentials and a JSON body. Success refreshes
  props/runtime and raises a toast; failure keeps the page intact and raises an error toast. No
  git, image, SSH, or delete mutation exists in 7A.
- **Routing/E2E.** `ui/router.ts` registers `/projects/:id/apps/:app` for the preview while the
  registry stays false. `playwright.config.ts` adds the `app-preview` project and a fourth
  `webServer` on `4313` (`HANSE_E2E_MODE=spa`, `HANSE_UI_SPA_ROUTES=app`, own `mkdtemp` DB).
  `e2e/spa-app.spec.ts` covers deep link/refresh, runtime/image/git/SSH read panels, restart
  success and error, missing legacy scripts, `?legacy=1`, the legacy/empty-allowlist servers, no
  fallback flash, and console/page errors. `e2e/app.spec.ts` stays the legacy rollback smoke.
- **Tests/gates.** New `AppPage` component tests (29) cover runtime/settings matrices, image states,
  git states, SSH panels, boot/cross-route fetching, restart success/error, 404/loading/error/retry,
  master, deletion-banner-only, no `<style>`, and no legacy scripts. `lint` 608 files exit 0 (18
  pre-existing warnings); `typecheck`, `typecheck:ui`, `typecheck:e2e` exit 0; `test` 164 files /
  2952 tests; `build` exit 0 (`AppPage` 36.3 kB / 9.9 kB gzip); `check:sensitive` and `check:ui`
  (39 SFCs) pass; `test:e2e` 128 passed, 1 skipped.
- **Not done.** 7B git actions, 7C image/SSH/delete actions and the registry cutover, legacy-script
  removal, and the full visual-QA/transfer budget remain. Application detail is still legacy by
  default.

### Completion record - Phase 7B (2026-10-29)

Phase 7B ports the application git workbench into the SPA preview. `src/shared/routes.ts` still has
`spa: false` for `app`; the page is reachable only with `HANSE_UI_SPA_ROUTES=app`, and Phase 7 is
**not** complete.

- **Contract/hook.** `ui/git-types.ts` mirrors the existing `GitStatus`/`GitActionResult` JSON
  contract and the legacy presentation rules (`controlState`, action hints, labels, fallback
  messages, and the full error-code copy). `ui/composables/useAppGit.ts` owns one status read on
  entry, on-demand refresh, one mutation at a time, status consumption from the action response,
  commit-message and current-branch validation, notices/error toasts, and a props/chrome refresh on
  success. No polling was added and no parallel write path exists.
- **UI.** `AppGitPanel.vue` renders the Repository/Changes cards with branch/upstream/HEAD, the
  status pill, fetch/update/push, the disabled reasons, success/warning/error notices, branch
  switch, file groups, and the commit-all form. `AppGitRemotes.vue` restores the rail Remotes card.
  `AppPage.vue` wires the workbench, keeps the live last commit, and refreshes app props/chrome after
  a successful action. The SPA route still loads no `git.js`, `images.js`, or `ssh.js`.
- **Test connection.** The legacy workbench never had a Test connection control; the app settings
  page owns it and it already reuses `/git/test` in `SettingsGitSection.vue`. 7B leaves that contract
  unchanged and covers it through the existing settings component and three-mode E2E specs rather
  than adding a second credential-entry surface to the application page.
- **E2E fixture.** The alpha fixture repository now has a deterministic local bare `origin` and an
  upstream `main`, plus a `feature` branch. The app-preview server publishes its repo map under a
  per-port temp file so `e2e/spa-app.spec.ts` can prepare clean, dirty, detached, conflicted, ahead,
  behind, and diverged states with local git only. The spec covers state rendering, on-demand
  refresh, commit-all, fetch/update/push/switch, commit validation, current-branch warnings, disabled
  states, and the push-rejected/diverged/status-load error mappings. The registry flag stays false.
- **Tests/gates.** New `AppGitPanel` component tests (8) cover the state/control matrices, busy
  labels, notices, load failures, and non-git states; `AppPage` tests grew to 36 with commit,
  fetch/update/push, switch, error mapping, validation, busy, and status-retry coverage. `lint` 612
  files exit 0 (18 pre-existing warnings); `typecheck`, `typecheck:ui`, `typecheck:e2e` exit 0;
  `test` 165 files / 2967 tests; `build` exit 0 (`AppPage` 59.1 kB / 16.79 kB gzip);
  `check:sensitive` and `check:ui` (40 SFCs) pass; `test:e2e` 134 passed, 1 skipped.
- **Not done.** 7C image/SSH/delete actions, the one registry cutover, legacy-script removal, and
  the full visual-QA pass remain. Application detail is still legacy by default.


### Completion record - Phase 7C (2026-10-29)

Phase 7C finishes Phase 7 and cuts over application detail. The registry has `spa: true` for every
page route including `app`; only `/chat` and `/terminal` remain legacy documents.

- **Image rail.** `ui/composables/useAppImage.ts` ports `assets/images.js`: one status read on entry
  and on manual refresh, a 3 s status/log poll only while `building`, build/rollback/check through
  the existing `/api/apps/:app/{build,image/rollback,image/check,image/logs}` handlers, and the
  legacy state matrix (current, restart_required, rebuild_required, building, build_error,
  not_ready, unknown, plus the default-image current/restart/unknown states). `AppImagePanel.vue`
  renders the status pill, action label/disabled reason, drift/blocked/usable/rollback badges, base
  and hash details, build logs, restart notice, rollback confirmation dialog, and busy/error states.
  Props/chrome are refreshed after every successful action; errors become toasts with the server
  message.
- **App SSH.** `AppSshPanel.vue` keeps the read tables and adds the allowlist editor
  (`GET /api/ssh/hosts` plus `GET/POST /api/projects/:id/apps/:app/ssh`), grant revoke
  (`POST .../ssh/grants/:id/revoke`), approval approve/reject
  (`POST /api/apps/:app/ssh/approvals/:id/decision`), and an on-demand audit read
  (`GET /api/apps/:app/ssh/audit`). Every action is busy-disabled, emits one refresh, and surfaces
  server errors as toasts. No private key, token, or secret is read or rendered.
- **Delete.** `AppDeleteDialog.vue` reproduces the exact-name confirmation, the `deleteFiles`
  checkbox, `return_to`, retry title/label, and the project-deletion retry variant from
  `src/http/deletion.ts`. It reuses `POST /api/projects/:id/apps/:app/delete` (or the project delete
  action when the project is marked), then navigates to the project page or `/projects` and raises
  the legacy success/warning message. The E2E fake deletion validates the contract without deleting
  fixture data.
- **Cutover.** `src/shared/routes.ts` flips `app` to `spa: true`; `AppPage.vue` is the default
  `/projects/:id/apps/:app` renderer. Project links inside the git workbench use `SmartLink`; chat,
  terminal, settings, skills, and IDE remain plain full-document links. The SPA document loads only
  `app.js`; the legacy rollback page still loads `git.js`, `images.js`, and `ssh.js`. The temporary
  `app-preview` webServer/project on 4313 was retired; app E2E now runs against the default `spa`
  server on 4310, and the fixture prepares image/SSH state on beta/gamma without touching the alpha
  rows used by the SSH console spec.
- **Tests.** New `AppImagePanel` (15), `AppSshPanel` (7), and `AppDeleteDialog` (6) component tests
  cover the state matrix, busy/disabled reasons, logs, exact-name confirmation, all SSH mutations,
  error toasts, no `<style>`, and no key/script text. `AppPage` tests grew to 40 with image
  build/rollback/check/busy/error and delete retry coverage. `spa-app.spec.ts` adds custom-image
  build/poll/log/rollback, default check, stale drift, SSH grant/revoke/approve/reject/audit, and
  exact-name delete flows on the default SPA server; the legacy `app.spec.ts` still runs on the
  legacy and empty-allowlist servers and `?legacy=1` keeps the island-script smoke.
- **Verification.** See the journal 0038 Phase 7C entry for the exact gate output. Visual geometry
  was checked at 390/768/1440 in dark and light with zero document/page horizontal overflow.
- **Not done.** No transfer budget was assigned for application detail; `/projects` remains the S16
  route. Chat/terminal migration and Phase 8 cleanup are out of scope; Gate D1 still owns that
  decision.

### Acceptance criteria

- Every app-page action works without legacy island scripts.
- The state vocabulary, polling, and error messages match the legacy page.
- The legacy rollback page still loads the old scripts and passes its smoke.
- The SPA route passes the full state matrix and has no console/page errors.

### Verification

Gate commands + the app-detail E2E spec (legacy and SPA) + fixture-repo git tests + image state
matrix.

### Rollback

Pin `HANSE_UI_SPA_ROUTES` to exclude `app` or set `HANSE_UI_LEGACY=1`; the legacy renderer and its
scripts remain until Phase 8.

### Test changes

Keep `test/application-page.test.ts` `renders the new hierarchy with the state strip before the git
workbench` and `keeps the git workbench contract and noscript fallback` as the legacy smoke (the
latter is the only explicit assertion of the legacy page's `/assets/git.js`,
`/assets/images.js`, and noscript fallback). Retire the remaining image/runtime/git HTML assertions
after the component tests replace them. Keep the 404/auth tests. Keep
`test/application-ssh.test.ts` until Phase 8 if the legacy page still renders the panel; otherwise
retire it with the legacy renderer. Keep `test/git-settings-asset.test.ts` while any legacy page
loads the asset.

## Gate D1 - Chat and terminal decision

> Revised 2026-10-29: the owner chose to migrate both `/chat` and `/terminal` before legacy cleanup.
> This requires a new design, Oracle review, and plan; plan 0031 does not implement it.

After Phase 7, record:

- The number of `/chat` and `/terminal` page requests from the coordinator/proxy access log over a
  7-day soak window (or a documented equivalent if logs are unavailable).
- Operator feedback on boundary loads.
- A scoped `chat.js` mount estimate (lifecycle, SSE teardown, URL sync, DOM ownership).

Default: keep `/chat` and `/terminal` as legacy documents. Migrating either requires a new design
and a new Oracle review; it is not part of this plan. Record the decision in the journal and
`docs/open-questions.md`.

## Phase 8 - Cleanup

### Boundaries

In scope: delete legacy renderers, assets, and tests for migrated routes; remove the migration
flags; update docs and indexes; final regression.
Out of scope: chat/terminal legacy code (kept), new behavior.

### Invariants

- `/chat`, `/terminal`, `/login`, and the existing `app.js`/`app-content.js` remain as needed.
- No dead imports; the route registry matches the actual SPA routes.
- API/service tests remain; old page-HTML tests and retired assets are gone.
- `docs/current-state.md` describes the final rendering modes and the cookie-only SPA auth.

### Work

1. Delete legacy page renderers/HTML formatting for migrated routes; keep their props modules.
2. Delete retired page-scoped enhancer scripts (`git.js`, `images.js`, `settings.js`,
   `git-settings.js`, `skill-detail.js`, `ssh.js`) if no legacy page still loads them; keep
   `handoff.js`/`markdown.js` if chat/terminal need them.
3. Remove `assets/app-content.js` only if no legacy page needs it; chat/terminal/login still do.
4. Remove `HANSE_UI_SPA_ROUTES`/`?legacy=1` per-route machinery only after the rollback window is
   closed; keep `HANSE_UI_LEGACY=1` only if a documented operational need remains.
5. Remove dead HTML-string tests and asset tests; keep one legacy smoke only if a legacy route
   remains.
6. Update `docs/current-state.md`, `docs/design/README.md`, `docs/plans/README.md`,
   `docs/journal/`, `docs/deployment.md`, and `DESIGN.md` if any note is stale.
7. Final gates: full suite, build, E2E, visual QA, perf, sensitive.

### Acceptance criteria

- No legacy renderer for a migrated route remains; no dead asset/test remains.
- Chat/terminal/login still work; their scripts are intact.
- Full gates green; final E2E green; visual QA PASS.
- `docs/current-state.md` is accurate.

### Verification

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

### Rollback

Git revert of the cleanup commit; the pre-cleanup image is the rollback.

## Record (every phase)

Each phase ends with a record before the next phase starts:

1. Append a dated section to `docs/journal/0038-spa-migration.md` and add/update its entry in
   `docs/journal/README.md`: phase, commit SHA if any, files changed, gates run, E2E/visual evidence
   location, deviations, open threads, next phase.
2. Update the status line in `docs/plans/0031-spa-migration.md` and the entry in
   `docs/plans/README.md`.
3. Update `docs/current-state.md` when the rendering mode, auth surface, flags, or Node floor
   changes.
4. Update `docs/design/README.md` if the design status changes.
5. Keep evidence (screenshots, JSON reports, transfer numbers) in untracked `docs/deploy/` or the
   workspace; use placeholders for host-specific values.

## Test retirement map

| Phase | Route | Retire at cutover | Keep |
| --- | --- | --- | --- |
| 1B | `projects` | none | `test/http.test.ts` `renders the projects index and filters by query` as legacy smoke |
| 2 | `overview`, `project` | `test/http.test.ts` `marks a deleting project as incomplete...`, `marks a deleting application row...`; `test/dashboard-runtime.test.ts` `renders one runtime row per state`; `test/handoff-ui.test.ts` `renders the policy card...` | `test/http.test.ts` `renders the fleet overview for a human` and `renders project detail with apps, dialogs, and the manifest` as legacy smokes; runtime mapping tests; 404/notice/escape tests |
| 3 | `handoffs` | `test/http.test.ts` `filters handoffs by group and search`; `test/handoff-ui.test.ts` `loads the hydrator...` | `renders all nine handoff states with filters and dialogs` as legacy smoke; `test/handoff-http.test.ts`; `serves the handoff Markdown hydrator` while the asset remains |
| 4 | `ssh` | none (single page-render test is the legacy smoke) | `test/ssh-http.test.ts` `is human-only, renders the page...` and `serves host, grant, approval, audit, and count routes`; `test/application-ssh.test.ts` until Phase 7 |
| 5 | `settings-*` | none at cutover; the `test/settings-http.test.ts` `describe("settings pages and pending state")` HTML assertions stay as legacy rollback coverage until cleanup | `test/settings-http.test.ts` API/fragment/auth/secret tests, `test/settings-store.test.ts`; `test/settings-asset.test.ts` until cleanup |
| 6 | `skills-*` | `test/skills-http.test.ts`: `renders one inventory table with scope nav, search, filters, and no editor`; `renders the winning row's Updated value for inherited inventory rows`; `merges an effective wider row and an invalid scoped row into Invalid local override`; `shows an invalid-name tombstone as Invalid here, not Disabled here`; `supports search, filter-empty, and all-empty states`; `renders the restart rail when running apps are stale`; `surfaces repository and plugin collision warnings on the application page`; `selects D5 states from the viewing context`; `offers delete and re-create for an invalid-name row`; `shows field hints, a linked field guide, and a stack gap before the danger zone`; `renders metadata, license, compatibility, and reference controls disabled and unnamed` | `renders the editable workspace with details, bundle form, source, preview, and danger zone` as legacy smoke; route/auth/API tests; the three no-JS snapshot tests until Phase 8; `test/skills-asset.test.ts` until cleanup |
| 7 | `app` | `test/application-page.test.ts`: `renders the default image rail card without build controls`; `renders a configured missing image with a status pill, build label, and closed details`; `adds data-image-url and base placeholder rows to the custom panel`; `renders a building image with a disabled busy build action`; `renders a build error as a field error with the failed status`; `shows the rollback trigger and dialog only when a previous image exists`; `labels rollback as a restart while the runtime is active`; `shows exactly one pending statement and the restart dialog while running`; `renders the unknown pending copy when applied state cannot be confirmed`; `renders Applied when a manager is configured...`; `renders Saved when the agent is stopped...`; `renders Unavailable when the runtime is not configured`; `omits the restart control for stopped and error runtimes`; `keeps the rail as Image, SSH access, Remotes, and Last commit` | `renders the new hierarchy with the state strip before the git workbench` and `keeps the git workbench contract and noscript fallback` as legacy smokes; 404/auth tests; `test/application-ssh.test.ts` and `test/git-settings-asset.test.ts` until cleanup where still loaded |
| 8 | all | all retired legacy HTML/asset tests | API/service/UI/E2E tests |

No API or service test is deleted to make a gate pass. If a retired test is still the only coverage
of a behavior, replace it with a component or E2E test first.

## Verification matrix

For every phase:

1. `npm run lint`
2. `npm run typecheck`
3. `npm run typecheck:ui`
4. `npm run typecheck:e2e`
5. `npm test`
6. `npm run build`
7. `npm run check:sensitive`
8. `npm run check:ui`
9. `npm run test:e2e` (SPA + legacy for the changed route)
10. CI Node 20.19/22 install matrix: `npm ci` + `npm run build`; local `node --version` sanity
    `>=20.19.0`
11. `docker build --target runtime -f Dockerfile .` when the Dockerfile/assets change
12. Manual feature matrix: every action, empty/error/master variant.
13. Boundary matrix: SPA→legacy, legacy→SPA, refresh, deep link, back/forward, expired session,
    logout.
14. Rollback drill: `HANSE_UI_LEGACY=1`, `HANSE_UI_SPA_ROUTES=""`, per-route exclusion,
    `?legacy=1`.
15. Visual QA: 390/768/1440, dark/light, keyboard focus, mobile drawer.
16. 48-hour soak on the deployment host before the next phase, when the process permits.

## Risks and mitigations

| Risk | Mitigation |
| --- | --- |
| Phase 0 tooling/fixture overruns | 5-7 day time box; reduce only above the non-reducible core; never replace the deterministic fixture. |
| Vitest project globs collect fixtures or split app.js tests wrongly | Exact includes/excludes in Phase 0; `test/ui/**` runs in jsdom; `test/**/*.test.{ts,mjs}` in node. |
| Playwright fixture port/token races | Fixed ports/token, three webServers (SPA/legacy/empty-allowlist) plus `app-preview` in Phase 7, `workers: 1`, separate `mkdtemp` DBs. |
| `app.js` split regresses legacy behavior | Characterization tests for drawer/theme/dialog/menu/segmented/password/toast/submit; legacy pages load both scripts. |
| Chrome fragment swap loses listeners/focus | Delegated drawer close; focus/aria tests; chrome swap E2E. |
| Mutation contract regression | `X-Hanse-Client` matrix through `createHttpServer`; form encoding per endpoint; legacy 303 preserved. |
| E2E SPA mode silently tests legacy | `test:e2e` runs `npm run build`; `webServer` uses the built manifest; a test asserts the SPA marker/route. |
| Stage 7 git/image port is too large | 7A/7B/7C exit criteria; pre-cutover route enablement via the allowlist; fixture repo and state matrix. |
| Node floor breaks a user install | Update `engines`, README, AGENTS, current-state; install-matrix check in the gates. |
| Open SPA tab after deploy | `vite:preloadError` reload; manifest validation; immutable hashed assets; no promise old chunks survive. |
| Test suite runtime grows | Component tests in the existing Vitest projects; E2E separate CI job; no Docker in the unit suite. |

## Rollback and flags

Precedence: `HANSE_UI_LEGACY=1` > `?legacy=1` > `HANSE_UI_SPA_ROUTES` > manifest validity > route
registry `spa: true`.

- `HANSE_UI_LEGACY=1`: all routes legacy; restart.
- `?legacy=1`: one HTML request; stripped before render; SmartLink preserves other query parameters.
- `HANSE_UI_SPA_ROUTES`: unset = registry defaults; empty = all legacy; list = only those ids;
  unknown ids log and are ignored.
- Missing/invalid/partial manifest: legacy + `ui.manifest_invalid`.
- `vite:preloadError`: one full reload; second failure shows `#ui-fallback`.
- `#ui-fallback`: hidden by default; CSS reveal after 4 s; removed by a successful mount.

## Review history

- 2026-10-28 - plan revision 1 authored; design approved (`oracle` round 5 PASS).
- 2026-10-28 - plan review round 1 (`momus`): CHANGES REQUESTED (3 blockers, 9 majors, 10 minors,
  3 design clarifications). Revision 2 folds them:
  - Vitest include/exclude globs and the jsdom test location;
  - fixed Playwright ports/token, two webServers, `workers: 1`, build-before-E2E;
  - flag unset/empty/list semantics and the route-id table;
  - exact test-retirement names, contract status codes, `check:ui`/spike criteria, S16/CLS/D1
    measurement methods, Phase 7 substage exits, per-phase records, `dev:ui` details, no-JS scope,
    and the remaining minors.
- 2026-10-28 - plan review round 2 (`momus`): CHANGES REQUESTED (2 blockers: `tsconfig.e2e`
  missing a compatible `module`; `dev:ui` smoke opened a route that Phase 1A leaves legacy;
  partial majors: empty-allowlist E2E mode, overview smoke contradiction, bearer/Origin status
  wording, spike criteria, pre-cutover app allowlist, journal index/process gates; minors).
  Revision 3 fixes: `module: "ESNext"` for e2e typecheck; `HANSE_UI_SPA_ROUTES=projects` for the
  dev-only smoke plus `HANSE_UI_DEV_URL` emission; a third `allowlist-empty` webServer/project;
  overview smoke kept; policy-card retirement moved to Phase 2; exact Phase 6/7 `it` names;
  bearer detection (`403 cookie_required`) and absent-Origin allowance; spike idempotence and
  `test:ui`; `app-preview` webServer; journal index; plan-local gate note; CI double-build removed;
  named mutation and SPA human-bearer status.
- 2026-10-28 - plan review round 3 (`momus`): **PASS**, no blockers. Revision 4 folds the minors:
  keep `keeps the git workbench contract and noscript fallback` as a legacy smoke; correct the
  Phase 5 settings HTML-test wording; align the risk table with three servers plus `app-preview`;
  clarify the dev-only allowlist override; state `HANSE_E2E_MODE=spa`/DB paths for 4312/4313;
  run `typecheck:e2e` in CI and add a Node 20.19/22 install matrix; order agent-token rejection
  before the human-bearer 403. Plan approved; implementation starts at Phase 0.
