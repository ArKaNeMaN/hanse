# Design - Incremental SPA migration of the coordinator web UI

Status: **approved** - round 5 review (`oracle`) PASS (2026-10-28). Earlier rounds: CHANGES
REQUESTED in rounds 1-4; revisions 2-5 folded every finding. Implementation is permitted after the
plan review.
Scope: an incremental, route-by-route migration of the authenticated coordinator UI from
server-rendered HTML to a Vue 3 client application, without changing the coordinator's HTTP/JSON
contracts, authentication, database, runtime, or the chat/terminal/IDE/preview surfaces.
Out of scope: implementation in this document; migrating `/chat` and `/terminal`; rewriting the
agent runtime, runner, store, or MCP surface; server-side rendering of page content; a public
versioned API for third parties.

## 1. Problem

Every authenticated page is a full document rendered by a TypeScript template-literal renderer in
`src/http/*.ts` (17,806 lines across the HTTP layer). Navigation re-fetches the document, the shell,
and all page data; 57 forms post and redirect with `303` plus a `notice` query. The browser code is
hand-written: 27,466 lines across `assets/*.js`, including a 14,362-line chat client that is already
an SPA island (fetch + SSE + `history.replaceState`).

The operator experience is inconsistent: chat is instant, every other screen is a document load,
and new interactions require either another full renderer function or another hand-written DOM
script. The owner wants a Vue-based SPA, but the migration must be incremental: every stage must
ship a fully usable application, and each stage must be verifiable before the next one starts.

A big-bang rewrite is not acceptable. The coordinator has 2,657 tests pinning HTTP and service
behavior, five consumer surfaces (`/api/*` JSON, CLI, MCP, IDE extension, master agent), and a
pre-alpha deployment that must keep working between stages.

## 2. Requirements

| ID | Requirement |
| --- | --- |
| S1 | Migration is cut over per route. A route is either fully server-rendered or fully client-rendered; no route is half-migrated in a shipped stage. |
| S2 | Unmigrated routes keep their current behavior, HTML, scripts, and redirect semantics. |
| S3 | Exactly one shell implementation is visible to users. The sidebar, topbar, breadcrumb, page header, drawer, theme, and toasts do not fork into two drifting copies. |
| S4 | Navigation between migrated routes is client-side: no document reload, no white flash, history and scroll preserved. |
| S5 | Navigation across the migrated/legacy boundary is a normal full document load. This is explicit and accepted. |
| S6 | Every existing HTTP/JSON contract stays valid: `/api/*`, `/healthz`, `/readyz`, `/internal/mcp`, `/ide/*`, `/preview/*`, terminal WebSocket, chat SSE. CLI, MCP, IDE extension, and master agent are unaffected. |
| S7 | Authentication and CSRF posture: legacy pages keep their current behavior; the SPA document and the whole `/api/ui/*` surface are cookie-only (`hanse_token`, HttpOnly, SameSite=Strict) as an intentional hardening. Existing `Origin` checks on mutations remain; agent tokens are rejected outside `/internal/mcp`. |
| S8 | Visual parity with `DESIGN.md`: no new color, size, space, radius, shadow, or motion value; `assets/app.css` remains the single stylesheet. |
| S9 | Every migrated route can be rolled back to its legacy renderer without a rebuild, via environment variable and per-request override. |
| S10 | `/chat`, `/terminal`, `/ide`, and demo previews are untouched by this program. |
| S11 | No database migration and no new runtime dependency. Vue/Vite/test tooling are devDependencies; only built static assets are shipped. |
| S12 | A checkout without a UI build still starts and serves the entire legacy UI. A missing, invalid, or partial UI manifest is a logged fallback, never a broken page. |
| S13 | Verification is layered: API/service/contract tests stay green and unmodified; page-HTML tests are replaced at a route's cutover; every migrated route keeps a legacy rollback smoke test; UI component tests run in jsdom; Playwright E2E gates run against a deterministic fixture coordinator. |
| S14 | Accessibility parity: focus moves to the main landmark on route change, the title and `aria-current` update, a route announcer is present, dialogs keep focus trapping/restoration, and reduced motion is honored. |
| S15 | Page props and boot JSON never carry secrets. Settings props are masked exactly like the current HTML renderer; provider keys, tokens, passwords, and MCP credentials never enter boot JSON or `/api/ui/*`. |
| S16 | Authenticated `/projects` first load (HTML + `assets/app.css` + boot JSON + entry JS + first route chunk, gzip) is at most 200 KiB. Each subsequent route is a lazy chunk. |

## 3. Decisions

### 3.1 Architect decisions after round 1

The four questions raised by the design review are resolved as architecture decisions, not owner
forks; each follows from S1/S13/S15 and the existing code.

1. **Initial data delivery** - boot JSON carries the first page's props. The route component renders
   on mount without a second round trip. The measured cost is included in S16.
2. **Legacy islands** - none on SPA routes. `git.js`, `images.js`, `settings.js`, `git-settings.js`,
   `ssh.js`, and `skill-detail.js` are ported before their route's cutover. They remain loaded only
   on the legacy rollback page. The DOM ownership conflict is not accepted.
3. **Stage 0 gate** - the deterministic fixture coordinator is a hard gate. If the time box is
   exceeded, the initial flow set is reduced, but the deterministic server is not replaced by
   real-compose smoke plus component tests.
4. **SPA auth is cookie-only** - both the SPA document and every `/api/ui/*` endpoint use a new
   `humanFromCookie()` helper (cookie token -> `authenticate`), used by `maybeServeSpa`, boot props,
   and the props endpoints. `humanFrom()` is not cookie-only: it selects `Authorization: Bearer`
   before the cookie (`src/http/auth.ts:32-53`), so it is not used for the SPA surface. Agent tokens
   get `403`. Existing bearer-token human APIs (`/api/settings`, `/api/skills`, `/api/ssh/*`, git,
   images, chat) and legacy page behavior are unchanged. S7 records this intentional difference.
5. **Node floor** - Vite 7.3.7 requires `^20.19.0 || >=22.12.0`. This program updates
   `package.json` `engines`, `README.md`, `AGENTS.md`, and the relevant docs to `>=20.19.0` instead
   of pinning Vite 6 or silently claiming `>=20`.

### 3.2 Owner decisions (closed)

Collected on 2026-10-28, before the first design revision. There are no open questions.

1. **Framework** - Vue 3 + Vue Router + Pinia. Server data uses `@tanstack/vue-query`; Pinia is
   limited to boot/session, toasts, dialogs, and other client UI state.
2. **Chat and terminal** - decided after the app-detail stage. Default expectation is to keep them
   as legacy documents; migrating them requires a separate design and review.
3. **Test harness** - Playwright (`@playwright/test`) for E2E plus Vitest with jsdom and
   `@vue/test-utils` for component tests. Both are devDependencies.
4. **Turbo** - not used. The program goes directly to the SPA; full-page boundary loads are accepted.

Recorded in `docs/open-questions.md`.

## 4. Baseline evidence

Recorded before any production edit, at commit `af49aae5eb5302d41f47ee5bfb6237babd8db845`:

- Working tree clean (`git status --porcelain` empty).
- `npm run lint` - 332 files, no fixes, exit 0.
- `npm run typecheck` - exit 0.
- `npm test` - 135 files, 2657 tests passed, 205.85 s, exit 0.
- `npm run build` - `tsc` plus Tailwind, exit 0.
- `npm run check:sensitive` - exit 0.
- Node 22.23.4, npm 10.9.9.

The full log is kept outside the repository at
`/data/agents/8f3d6d8c-cf86-4512-bde0-5638f65a00b5/hanse/tmp/opencode/spa-baseline.log`.

## 5. Current state (verified facts)

- **Rendering**: plain TypeScript template literals. `documentPage()` and `appShell()` in
  `src/http/ui.ts` compose every authenticated page. There is no template engine, client framework,
  or client router. Only `assets/chat.js` calls `history.replaceState`.
- **Shell DOM**: `appShell()` renders
  `<main id="main" class="page"><header class="page-header">…</header><div class="page__body">…</div></main>`.
  `.page` is the scroll container (`overflow-y: auto`, `src/http/styles.css:907-910`).
- **Shell scripts are not shell-only**: `assets/app.js` binds non-delegated listeners to
  `[data-dialog-open]`, `[data-dialog-close]`, `dialog.dialog`, `details.menu`, `.segmented`,
  `.toast`, and `[data-password-toggle]` (`assets/app.js:63-207`), and a document-level submit
  handler that sets `data-submitting` and disables buttons (`:209-241`). Vue-rendered content
  appears after this script and would not be wired; Vue async forms would be left busy.
- **Markdown**: `assets/markdown.js` is a browser ESM DOM builder. It uses `textContent` and never
  assigns Markdown text through `innerHTML` (`assets/markdown.js:1-21`). There is no safe HTML-string
  output to feed `v-html`.
- **Routing**: one hand-written `route()` in `src/http/handler.ts` plus feature routers. `server.ts`
  calls `isSettingsRoute`/`isSkillsRoute`/`isSshRoute` before `handleRequest` (`src/http/server.ts:306-331`),
  so a page-dispatch branch only in `handler.route()` would miss those routes.
- **Forms**: 57 `<form>` elements across `dashboard.ts` (9), `settings.ts` (12), `ssh.ts` (11),
  `application.ts` (8), `skills.ts` (8), `ui.ts` (7), `chat.ts` (2).
- **Mutation responses are not uniform**:
  - `routeMutation` and `routeDecision` return `303` on success for every non-HTML caller
    (`src/http/handler.ts:428, 431-445, 649, 689, 748`). `Accept: application/json` is not enough to
    get `{ok:true}`.
  - Handoff policy/reply/cancel, settings save, provider save, model providers, git settings,
    restart, skills, images, git, deletion `DELETE`, and SSH JSON APIs already return JSON.
- **Assets**: an explicit allowlist in `src/http/handler.ts`; each request does a synchronous
  `readFileSync` under `HANSE_ASSETS ?? <cwd>/assets`; no hashing, ETag, or cache header. CSS is
  built by the Tailwind v4 CLI into `assets/app.css` (git-ignored). JS is served verbatim.
- **Build**: `tsc` emits `dist/`; browser assets stay in `assets/`; the Docker build stage copies
  `src` and `assets` (`Dockerfile:21-24`), and the runtime image copies `dist` and `assets`.
- **Test order**: CI runs `npm test` before `npm run build`
  (`.github/workflows/ci.yml:14-19`), but local and agent runs often build first. If legacy fallback
  depended on manifest presence, the same test suite would exercise different renderers.
- **Existing islands**: `git.js` (1,520 lines), `images.js` (539), `settings.js` (744),
  `git-settings.js` (331), `skill-detail.js` (1,529), and `ssh.js` (83) fetch JSON or HTML fragments
  and patch the DOM. Settings uses the `x-hanse-fragment: settings` partial-response mechanism.
- **Consumers of the HTTP contract**: `/api/*` JSON, `/internal/mcp`, the IDE extension
  (`HANSE_API_BASE`), the master agent, and the CLI. None consume the page HTML.

## 6. Architecture

### 6.1 Strangler with route-level cutover

Two renderers coexist in one coordinator process and one origin:

- **Legacy renderer** - the current `src/http/*` page functions. Extracted data assembly is shared;
  the HTML formatting is frozen at cutover and deleted in cleanup.
- **SPA renderer** - a new `src/http/spa.ts` that emits the server shell, boot props, and the Vite
  entry script.

A shared route manifest decides which renderer serves a page request. Deployment does not split;
the same image serves both. The migrated area grows route by route. At every point the application
is fully usable, and the program can stop after any stage.

Cutover is per route, never per component. A route is migrated only when every action, empty state,
error state, master variant, responsive layout, keyboard path, and legacy island behavior on that
route has a client implementation and has passed the stage gate.

### 6.2 Mount contract: Vue owns `<main>`

Vue mounts into the existing `<main id="main" class="page">` element, not into a second wrapper.
The SPA document renders:

```html
<aside class="sidebar">…server-rendered shell…</aside>
<div class="shell-main">
  <header class="topbar">…breadcrumb host…</header>
  <main class="page" id="main" tabindex="-1">
    <!-- initial skeleton or server-rendered header; Vue replaces this -->
  </main>
</div>
```

The Vue route component renders exactly the legacy layout inside `<main>`:

```html
<header class="page-header">…</header>
<div class="page__body">…</div>
```

Consequences:

- No extra wrapper, no double `.page__body`, no CSS layout change.
- The page header (title, description, meta, actions) is content and is owned by Vue, so it never
  goes stale after client navigation.
- The shell (sidebar, topbar, breadcrumb, drawer, theme, toasts, sign-out) stays server-rendered.
- `assets/app.js` shell behavior keeps working because the shell is parsed before the Vue module.
- The initial `<main>` contains a server-rendered skeleton and a `#ui-fallback` block that is
  **hidden by default**: a short "interface failed to load" message and a `?legacy=1` link. A CSS
  reveal (`visibility`/`opacity` after a 4 s delay) makes it visible only if the client has not
  mounted by then; a successful Vue mount replaces the whole `<main>`, so it never appears. No
  inline executable script is added. Stage 1 measures CLS, asserts the fallback is not visible on a
  successful load, and keeps visual parity.

`document.title`, the breadcrumb, active nav, scoped Settings/Skills hrefs, and chrome counters are
**server-rendered fragments** refreshed through `GET /api/ui/chrome?path=` (see §6.3). The client
does not reimplement `sidebarProjects()` truncation/order, `navItem()` markup, or breadcrumb labels.

### 6.3 Shared route manifest, dispatch, and chrome

`src/shared/routes.ts` is a pure, dependency-free module imported by both the server (tsc) and the
client (Vite). It must not import `node:*` (in particular not master helpers that pull `node:path`).
An import test enforces this.

It exports:

- route ids and page path patterns;
- `matchPage(pathname)` returning `{ id, params }` or `undefined`;
- `isSpaRoute(id)` / `isSpaPath(pathname)` applying the enablement flags;
- nav metadata (nav id, label, group) for the shell.

`matchPage` is page-only. It never matches `/api/*`, `/chat`, `/terminal`, `/ide`, `/preview`, or
`/assets/*`.

**Single page-dispatch point.** `createHttpServer` calls `maybeServeSpa(request, deps)` before the
feature routers and before `handleRequest`, for `GET`/`HEAD` requests whose `Accept` includes
`text/html` only. This is the one place that decides SPA vs legacy. It must not intercept API,
chat, terminal, IDE, preview, or asset requests. It performs the same agent-token rejection as
`handler.route()` before serving a page, so an agent token + HTML request still gets `403` instead
of a login redirect. A route-table test covers all 112 path literals and feature-router precedence.
The server's fixed header passthrough gains `x-hanse-client` (`src/http/server.ts:250-264`); without
it the four SPA mutation branches can never fire.

**Chrome fragment.** The server remains the only chrome renderer:

- `ui.ts` exports `renderSidebarNavInner(options)` and `renderBreadcrumbInner(options)` returning
  **inner** HTML; `appShell()` wraps each in exactly one `<nav id="sidebar-nav">` /
  `<nav id="breadcrumb-host">`. The fragment endpoint returns the same inner HTML, so a swap cannot
  nest a `<nav>` or duplicate `aria-label`.
- `GET /api/ui/chrome?path=<page path>` returns
  `{ sidebarNav: string, breadcrumb: string, title: string, active, pendingCount, sshPendingCount }`.
- Every `/api/ui/*` page response also includes `chrome`, so a client navigation needs one request,
  not two.
- The client replaces the inner HTML of `#sidebar-nav` and `#breadcrumb-host`, updates
  `document.title`, and re-applies the delegated `a[data-spa-link]` behavior. The sidebar footer
  (theme, sign-out) is outside the replaced node and keeps its listeners.
- The mobile-drawer close behavior is a delegated listener (or is re-bound after every swap), not a
  per-link listener captured at load. `app.js` currently binds `shell.querySelectorAll(".sidebar a[href]")`
  directly (`assets/app.js:47-54`); replacing the nav would otherwise leave the drawer open after a
  mobile navigation.
- Counters refresh on navigation, after a relevant mutation, and on visibility; a 30 s poll is
  allowed but not required.

The server shell emits `id="sidebar-nav"` on the nav container, `id="breadcrumb-host"` on the
breadcrumb container, and `data-nav-id`/`data-project-id` attributes for tests. These are inert
attributes on legacy pages.

**SmartLink** is the only internal link component. For an SPA path it renders `<RouterLink>`; for a
legacy path a plain `<a href>`. A shared `guardLink(event)` ignores modified clicks (ctrl/meta/
shift/alt), middle click, `target`, `download`, and hash-only links. The server shell's own links
are plain anchors; a delegated handler on `a[data-spa-link]` calls `router.push()` and uses the same
guard.

### 6.4 Build, assets, and development

**Pinned toolchain.** The repository currently documents Node >=20. Vite 7 raises the effective
floor to `>=20.19.0`; this program adopts and documents that patch-level floor. Current stable
(late 2026) Vite 8 / Vitest 5 / jsdom 30 require an even higher floor and Vitest 3 is incompatible
with Vite 8, so the program pins a coherent, lower-risk set:

| Package | Pin | Why |
| --- | --- | --- |
| `vue` | 3.5.x | current stable Vue 3 |
| `vue-router` | 4.x | matching Vue 3 router |
| `pinia` | 3.x | matching Vue 3 store |
| `@tanstack/vue-query` | 5.x | server cache/polling |
| `vite` | 7.x | Node >=20.19; Vitest 3 compatible |
| `@vitejs/plugin-vue` | 6.x | supports Vite 7 |
| `vitest` | 3.2.x | current repo line; `test.projects` available |
| `jsdom` | 26.x | Node >=20 compatible |
| `@vue/test-utils` | 2.5.x | Vue 3 component tests |
| `typescript` | 5.9.3 | required by `vue-tsc`; TS 7 has no JS compiler API |
| `vue-tsc` | 3.3.x | SFC template typecheck |
| `@playwright/test` | 1.64.1 | E2E; record the Chromium revision in CI |
| `@biomejs/biome` | 2.6.x | existing linter; Vue support experimental |

Vite 7.3.7 requires `^20.19.0 || >=22.12.0`, so the documented Node floor changes from `>=20` to
`>=20.19.0` in `package.json` `engines`, `README.md`, `AGENTS.md`, and `docs/current-state.md`.
That is a patch-level clarification, not a new major line. Do **not** take Vite 8 / Vitest 5 /
jsdom 30 in this program. Their upgrade is a separate stage with its own Node-floor change. Do not
bump `typescript` to 7.x while `vue-tsc` is in the install.

- **Source layout**: a new top-level `ui/` directory. It is outside `src/`, so the server
  `tsconfig.json` (`rootDir: src`, `include: ["src"]`) is untouched and never tries to emit Vue
  files. `src/shared/routes.ts` remains the only shared module; the UI tsconfig includes it
  explicitly.
- **Vite**: `root: "ui"`, `base: "/assets/ui/"`, `build.outDir: "../assets/ui"`,
  `build.assetsDir: ""`, `build.manifest: true`, `build.emptyOutDir: true`,
  `rollupOptions.input: "ui/main.ts"`, plugin `@vitejs/plugin-vue`. No `index.html` is generated;
  the coordinator owns the document. `server.fs.allow` includes the repository root so `ui/` can
  import `src/shared/routes.ts` in dev.
- **Manifest**: the server reads `assets/ui/.vite/manifest.json` once at startup, resolves the
  `main.ts` entry, and validates that every file it will serve exists and stays inside
  `assets/ui/`. Missing, invalid, partial, or traversal entries log `ui.manifest_invalid` and fall
  back to legacy for every route. Manifest `file` paths are relative to `outDir` and do not include
  `base`; the server prefixes `base`. `assets/ui/*` is served with
  `cache-control: public, max-age=31536000, immutable`. HTML is `no-store`.
- **Old chunks**: `emptyOutDir` deletes previous hashed chunks when an image is replaced. An open SPA
  tab whose lazy import 404s must not show a dead page. The entry listens for
  `vite:preloadError` and performs one full-page reload; a second failure shows the fallback. Old
  chunks are not promised to survive a deploy.
- **Development**: `HANSE_UI_DEV_URL=http://127.0.0.1:5173` makes the server emit
  `<devUrl>/assets/ui/@vite/client` and `<devUrl>/assets/ui/main.ts`. The page, cookies, and API
  calls remain on the coordinator origin. Vite's default `server.cors` allows localhost/127.0.0.1
  on any port; a non-localhost page host needs an explicit `server.cors.origin` and
  `server.allowedHosts`. HMR works cross-origin when the browser loads modules directly from 5173
  (the client derives the socket from `import.meta.url`); a proxy that rewrites the module origin
  needs `server.hmr.clientPort`/`protocol`/`host`. HTTPS app pages require HTTPS Vite or a tunnel.
- **Scripts**: `build:ui`, `dev:ui`, `dev:css`, `typecheck:ui` (`vue-tsc -p tsconfig.ui.json
  --noEmit`), `test:ui`, `test:e2e`. `npm run build` becomes `tsc && build:css && build:ui`.
- **Docker**: the build stage copies `ui/`, `vite.config.ts`, and `tsconfig.ui.json` in addition to
  `src`/`assets` (`Dockerfile:21-24`), and `npm run build` includes `build:ui`. The runtime image
  continues to copy `assets/`, which includes `assets/ui/`. `assets/ui/` is added to `.gitignore`.
  `src/http/handler.ts` `ASSETS` gains `/assets/app-content.js`.
- **Script load matrix**: `documentPage()`/`appShell()` gain an explicit `contentScript` option.
  Legacy pages and `/login` load `app.js` + `app-content.js`; SPA documents load only `app.js`.
  Tests assert the emitted script tags for legacy, SPA, and login documents.
- **Tailwind**: `src/http/styles.css` adds `@source "../../ui";` (relative to the stylesheet, not
  the repo root). A build assertion greps a sentinel class used only in a Vue component out of
  `assets/app.css`.
- **No SFC `<style>` blocks**: `ui/` uses the existing utility classes and `DESIGN.md` tokens only.
  A CI check rejects `<style` in `ui/**/*.vue`. This keeps `assets/app.css` the single stylesheet
  and prevents Vite CSS chunks and FOUC. The dynamic `documentPage()` styles list remains available
  for the existing vendor CSS on legacy pages.
- **Lint/typecheck**: Biome 2.6.x handles `.vue` only with
  `html.experimentalFullSupportEnabled: true` and `html.formatter.enabled: true`; it is still
  experimental. Stage 1 pins this configuration and runs it on the real SFCs. If it produces
  unstable output or misses template lint, the fallback is a scoped `eslint-plugin-vue` + Prettier
  configuration for `**/*.vue` only, with Biome's `files.includes` excluding `**/*.vue`. The
  repository-wide Biome gate stays in place for every other file.

### 6.5 Page data contracts and shared assembly

Page props are produced by a new `src/http/props/<route>.ts` module per route. It returns a typed
object; the legacy renderer formats it into HTML; the `/api/ui/*` endpoint returns it as JSON. This
extraction happens **before** the route is frozen, with characterization tests, so the two
renderers cannot drift.

| Endpoint | Props |
| --- | --- |
| `GET /api/ui/chrome?path=` | server-rendered sidebar nav + breadcrumb + title + counters |
| `GET /api/ui/overview` | fleet counts, project rows, recent handoffs |
| `GET /api/ui/projects` | project rows, search result, counts |
| `GET /api/ui/projects/:id` | project, apps, handoff policy, handoffs, deletion state, master flag |
| `GET /api/ui/apps/:app?project=` | app, runtime view, image view, git summary, SSH grants, master flag |
| `GET /api/ui/settings?scope=&project=&app=` | masked resolved settings, inheritance, providers, git credential status |
| `GET /api/ui/skills?scope=&project=&app=` | inventory rows, scope metadata |
| `GET /api/ui/skills/:id` | bundle source, references, metadata, issues, visibility |
| `GET /api/ui/handoffs` | rows, filters, policy summary |
| `GET /api/ui/ssh` | hosts, grants, approvals, audit page |

Rules:

- Cookie-only `humanFromCookie` auth (new helper); `humanFrom` accepts bearer and is not used here.
  Agent tokens receive `403`; no bearer-token path.
- The shape is page-specific and internal. It is not a public API and is not versioned.
- Props never include secrets. Masked values match the current page output. A test seeds sentinel
  provider keys, MCP tokens, git credentials, and settings secrets, then asserts they are absent
  from every `/api/ui/*` response and from the boot JSON.
- `Cache-Control: no-store` because the data is authenticated.
- Boot JSON is produced by one serializer that escapes `<` as `\u003c`; it is the only place that
  serializes props into the document.

### 6.6 Mutations and content negotiation

The existing mutation handlers remain the single implementation. The discriminator is explicit:

```
X-Hanse-Client: spa
Accept: application/json
```

`X-Hanse-Client` is mandatory for the SPA's success-JSON path. `Accept` alone is not a discriminator,
because existing non-browser callers already send JSON-ish `Accept` values and expect the current
redirects. The legacy `wantsHtml=false` path is untouched. The header must be added to
`server.ts`'s fixed passthrough (`src/http/server.ts:250-264`) and to `HttpRequest.headers`; the
matrix test runs through a real `createHttpServer`, not only a direct handler call.

Only four handlers need a new SPA success branch:

| Handler | Current non-HTML success | SPA branch |
| --- | --- | --- |
| `POST /api/projects` | `303 /` | `200 {ok:true, project}` |
| `POST /api/projects/:id/apps` | `303 /` | `200 {ok:true, app}` |
| `POST /api/handoffs` | `303 /` | `201/202 {ok:true, handoffId, status, state}` (see below) |
| `POST /api/handoffs/:id/decision` | `303 return_to` | `200 {ok:true, decision}` |

**Body encoding.** These four handlers parse `application/x-www-form-urlencoded` with `parseForm()`.
The SPA mutation helper sends form-encoded bodies for these four and JSON for the existing JSON APIs;
the contract matrix covers both the accepted and the rejected `Content-Type` combinations.

**Handoff-create semantics.** `POST /api/handoffs` splits `isSpaClient` from `browser`: the SPA branch
runs the same non-empty `summary` validation as the browser path and returns explicit results instead
of `303 /`. The service contract is `HandoffRequestStatus = "queued" | "awaiting_approval" |
"denied" | "existing"` and the result is `{handoffId, status, state}` (`src/coordinator/service.ts`).
The branch returns that shape. If the SPA needs the full row, the **server** calls `getHandoff()`
and adds it as a named `handoff` field; the SPA never calls a server function.

| `requestSiblingChange` status | Status |
| --- | --- |
| `queued` | `201 {ok:true, handoffId, status:"queued", state}` |
| `awaiting_approval` | `202 {ok:true, handoffId, status:"awaiting_approval", state}` |
| `denied` | `403 {error, code:"handoff_denied", status:"denied"}` |
| `existing` | `409 {error, code:"handoff_exists", handoffId, status:"existing", state}` |
| empty summary (before the service) | `400 {error, code:"summary_required"}` |

Everything else already returns JSON and is reused as-is: handoff reply/cancel/policy, settings save,
provider save, model providers, git settings, restart, skills, images, git, deletion `DELETE`, and
the `/api/ssh/*` + `/api/apps/:app/ssh/*` APIs. The design does not add parallel write paths for
those.

Rules:

- The SPA branch returns the same status codes and error envelope (`{error, code}`) as the existing
  JSON path.
- Mutation errors on the SPA branch are JSON; success is JSON. No `303` is returned when
  `X-Hanse-Client: spa` is present.
- The SPA mutation helper sends the header, parses JSON, maps `{error, code}` to a typed error, and
  pushes a toast. Optimistic updates only where the legacy UI already used them (settings save, git
  commit); everything else is server-confirmed.
- New SPA mutation branches enforce same-origin (`Origin` must be absent or match the request host)
  in addition to SameSite=Strict.
- Contract tests assert: with the header → JSON; without the header but with
  `Accept: application/json` → the current legacy response; browser form → `303` + `notice`.

### 6.7 Authentication, CSRF, XSS

- The SPA document is served only after `humanFromCookie`. This is intentionally stricter than the
  current HTML pages, which accept `humanFrom` (bearer or cookie). Unauthenticated GETs still
  redirect to `/login?next=<validated local path>`.
- Fetches use `credentials: "same-origin"`. A `401` triggers a redirect to the same login URL with
  the current path as `next`.
- Mutations keep `SameSite=Strict` plus the existing `Origin` rejection where present; the new SPA
  branches add the same-origin check described in §6.6.
- Vue escapes text by default. **No `v-html` anywhere in `ui/`.** Markdown rendering uses a
  `<SafeMarkdown>` component that clears the container and then calls the existing
  `renderMarkdown(container, text)` DOM builder in `onMounted`/`watch`; the renderer's
  `textContent`-only contract is the security boundary. A component test covers text changes
  without duplicate nodes.
- Boot JSON is data, not executable script; `<` is escaped. No inline executable script is added
  (the existing theme boot script remains).
- `/api/ui/*` and boot props are cookie-only; a bearer token cannot read them.

### 6.8 Failure modes and rollback

| Failure | Behavior |
| --- | --- |
| UI manifest missing/invalid/partial | Log once; serve legacy for every route. The app is fully usable. |
| Manifest entry points at a missing file | Detected at startup; treat the manifest as invalid. |
| Entry module 404 or JS exception before mount | Manifest validation rejects a missing entry; a pre-mount exception leaves the hidden `#ui-fallback` to reveal itself after the 4 s CSS delay with a `?legacy=1` link; the shell remains navigable. E2E injects a failing entry, waits for the reveal, and asserts the fallback; a successful mount asserts no fallback text. |
| Lazy chunk 404 after a deploy | `vite:preloadError` → one full reload; a second failure shows the fallback. |
| Page props 404/500 | Route-level error view with the server's message, retry, and a legacy link. |
| Session expired mid-SPA | Fetch wrapper redirects to `/login?next=`. |
| Route not migrated | Full document load; no client interception. |
| Emergency rollback | `HANSE_UI_LEGACY=1` (restart) or `?legacy=1` (single request). |
| Per-route rollback | Remove the route id from `HANSE_UI_SPA_ROUTES` (restart); the legacy renderer serves it. |

**Flag precedence** (highest first):

1. `HANSE_UI_LEGACY=1` - all routes legacy.
2. `?legacy=1` on a GET HTML page - this request legacy; the server strips the parameter before
   rendering, and SmartLink preserves the other query parameters but drops `legacy`.
3. `HANSE_UI_SPA_ROUTES` - **unset** means fall through to 4/5 (routes whose registry `spa` flag is
   true are enabled by default); **empty string** means all routes legacy; a **comma list** enables
   only the listed route ids. Unknown ids log `ui.unknown_route` and are ignored (fail closed for
   that id), never an error that takes the page down.
4. Manifest presence and validity.
5. The route's `spa: true` flag in the shared registry. Each cutover flips the flag to true; an
   operator can pin `HANSE_UI_SPA_ROUTES` to exclude it.

The legacy renderer for a migrated route is frozen after the stage gate and kept only as a rollback
path until cleanup. Post-gate fixes land in Vue only. Because the rollback page stays reachable, one
legacy smoke/E2E test per migrated route is retained until cleanup; it is not deleted with the
HTML-string tests.

### 6.9 Accessibility and UX invariants

- `appShell()` emits a visually hidden `#route-announcer` (`aria-live="polite"`).
- On every client navigation: focus `#main`, set `document.title`, update `aria-current` and the
  active nav mark through the chrome fragment, announce the title, and reset `.page.scrollTop` to 0.
- Vue Router `scrollBehavior` targets `.page` (the scroll container), not `window`; back/forward
  restores the saved position on that element.
- Dialogs use `<dialog>` with the same focus trap, Escape handling, and focus restoration as the
  current `app.js`; the Vue dialog composable is the single implementation inside migrated content.
- `app.js` is split into `app.js` (shell: mobile drawer, theme, nav) and `app-content.js`
  (dialogs, menus, segmented controls, password toggles, submit-busy, toast close/autodismiss).
  Legacy pages load both; SPA documents load only the shell script. Vue forms implement their own
  busy state and never rely on `data-submitting`. `/login` loads both scripts.
- **Toast ownership is single per mode.** On legacy pages the server renders the notice into
  `#toast-region` and `app-content.js` owns close/autodismiss. On SPA pages the server renders an
  empty `#toast-region`, boot props carry any initial notice, and a Vue `ToastHost` teleports into
  `#toast-region` and owns every toast (initial and mutation). `app.js` does not own toast
  behavior on SPA documents. A test asserts success and error toasts after client-side mutations.
- Keyboard paths, skip link, mobile drawer, and reduced-motion behavior are re-tested per stage.

### 6.10 Testing strategy and determinism

Layers, from cheapest to most expensive:

1. **Existing Vitest suite** (node): API/service/contract tests stay unmodified. Page-HTML tests for
   a route are retired at its cutover and replaced by component + E2E coverage; the legacy rollback
   smoke stays. The plan lists the exact files per stage.
2. **UI component tests** (Vitest, jsdom, `@vue/test-utils`): forms, error mapping, dialogs,
   SmartLink routing, store behavior, SafeMarkdown. Vitest `projects`:
   - `server` - `environment: "node"`, include `test/**/*.test.ts` and `test/**/*.test.mjs`,
     exclude `test/ui/**` and `test/fixtures/**`, `env: { HANSE_UI_LEGACY: "1" }`;
   - `ui` - `environment: "jsdom"`, include `ui/**/*.test.ts` and `test/ui/**/*.test.ts`,
     `setupFiles: ["test/ui/setup.ts"]`.

   The explicit server env makes the suite deterministic whether or not `assets/ui` was built.
3. **E2E** (`@playwright/test`): a deterministic fixture coordinator built from the real
   `HttpDeps` + `createHttpServer` with a temp SQLite DB, synthetic projects/apps, and the test
   operator token. Real services where they are cheap and deterministic: `SettingsService`,
   `SkillService`, and `GitService` against a fixture repository, plus real SSH host/grant CRUD with
   only `testHost`/network faked. Stub only Docker/runner/opencode, image builds, previews,
   deletion, the dispatcher, and the chat/SSE boundary. `npm run build:ui` runs before
   the E2E webServer. Each migrated route's spec runs in both legacy and SPA modes.
   Minimum set: login/logout; projects list/search/create; project detail add app/create handoff/
   delete; handoffs decide/reply/policy; SSH host create/test/re-pin/grant/approve/revoke; settings
   save in all three scopes with inheritance/provider/git credentials; skills create/override/
   disable/revert; app runtime/git/image/SSH/restart; boundary/back/forward/refresh/deep-link/
   session-expiry/logout; rollback; legacy `303` form path.
   **Non-reducible core** (cannot be removed by the Stage 0 time box): login/logout, one mutation,
   a chrome swap (sidebar + breadcrumb after client navigation), the SPA↔legacy boundary, rollback
   (`HANSE_UI_LEGACY=1` and `?legacy=1`), and a console/page-error check. Reducing anything beyond
   the core requires plan-review sign-off.
   Deletion E2E is a contract test: confirmation, 303/JSON, notice, and error mapping with a fake
   deletion service. The destructive cleanup remains covered by `deletion.test.ts` and a
   real-compose soak, not by the SPA harness.
4. **Visual QA**: the `visual-qa` checklist at 390/768/1440 and dark/light, with evidence outside
   tracked docs. Pixel parity is verified against the legacy page for each route before cutover.
5. **Contract tests**: existing `/api/*` tests, new `/api/ui/*` auth/shape/secret tests, and the
   `X-Hanse-Client` matrix. CLI, MCP, IDE, and master tests remain green and unmodified.

CI adds `npm run typecheck:ui`, includes the UI project in `npm test`, and runs a separate
`npm run test:e2e` job after `npm run build`. The E2E job uses a pinned Chromium (baked
`/usr/bin/chromium` or `npx playwright install --with-deps chromium`); Playwright's bundled browser
is preferred in CI, with the system Chromium as a documented local option.

## 7. Alternatives considered

| Alternative | Why rejected |
| --- | --- |
| Big-bang rewrite of all pages in Vue | Unverifiable, long-lived branch, no usable intermediate states, violates S1/S2. |
| Inertia.js | Replaces server HTML with page props and requires a client framework; every page is still rewritten. It is a final architecture, not a stepping stone. Owner rejected it. |
| Turbo Drive / htmx | Leaves the server-rendered architecture intact and does not produce a client app. Owner rejected it. |
| Hand-written router that swaps server HTML | Reimplements Turbo poorly, cannot carry client state, and creates a third rendering mode. |
| Iframe each legacy page inside a Vue shell | Duplicates chrome, breaks URL/deep-link semantics, focus, and accessibility. |
| Keep legacy island scripts inside a Vue route | Two DOM owners for one subtree; `git.js`/`images.js` bind to server-rendered nodes at load time and would silently do nothing. Rejected by §3.1. |
| Module federation / microfrontends | Overkill for a single-team pre-alpha product; adds runtime complexity without a migration benefit. |
| Rewrite chat together with the pages | 14,362 lines of working client code; high regression risk with no user-visible benefit at this stage. Deferred by owner decision. |

## 8. Route migration map and order

The order is by risk and dependency, not by navigation order. Simpler routes ship first; the app
detail monolith ships last.

| Stage | Route | Notes |
| --- | --- | --- |
| 0 | - | Harness, tooling spike, baseline. |
| 1 | `/projects` | SPA skeleton, shell/content JS split, chrome fragment, boot props, first route. |
| 2 | `/`, `/projects/:id` | Fleet overview, apps table, add app, handoffs, policy, deletion, master variant. |
| 3 | `/handoffs` | Small route; exercises decisions, reply actions, filters. |
| 4 | `/ssh` | Small route; reuses the existing `/api/ssh/*` JSON APIs, dialogs, test/re-pin. |
| 5 | `/settings`, `/projects/:id/settings`, `/projects/:id/apps/:app/settings` | Three scopes, inheritance, providers, git credentials. |
| 6 | `/skills`, `/projects/:id/skills`, `/projects/:id/apps/:app/skills`, `/skills/new`, `/skills/:id` | Inventory, create, workspace; port `skill-detail.js`. |
| 7 | `/projects/:id/apps/:app` | Internally 7a read + restart, 7b git, 7c image/SSH/delete; one cutover gate. Port `git.js`/`images.js`/`ssh.js`. |
| D1 | `/chat`, `/terminal` | Decision after Stage 7. Default: remain legacy documents. A separate design is required to migrate. |
| 8 | Cleanup | Delete legacy renderers/assets/tests for migrated routes; keep chat/terminal legacy code. |

`/login` stays server-rendered forever. `/ide/*` and `/preview/*` stay external documents. 404/error:
server 404 for unknown paths; client error views inside a matched SPA route.

## 9. Contract impact

- **Additive**: `/api/ui/*` endpoints; `X-Hanse-Client: spa` success branches on four handlers; the
  chrome fragment; the `app-content.js` asset.
- **Unchanged**: all existing response codes and bodies for existing callers; cookie name and
  attributes; `Origin` checks; `/internal/mcp`; chat SSE; terminal WebSocket; IDE/preview proxies;
  bearer-token human APIs.
- **Changed**: the HTML body of a migrated route is a shell plus empty `<main>` and boot JSON; Vue
  renders the header and body. This is the intended cutover and is reversible by flag.
- **Test churn**: HTML-string assertions for a migrated route are retired at its stage and replaced
  by component/E2E assertions; one legacy rollback smoke stays. API/service tests are never
  deleted.
- **Docs**: `docs/current-state.md` gains a "UI rendering modes" section in Stage 1 and is updated
  per stage; `DESIGN.md` is unchanged because the tokens and visual contract do not change.

## 10. Risks and mitigations

| Risk | Severity | Mitigation |
| --- | --- | --- |
| E2E fixture coordinator is more expensive than expected | High | Hard gate, 5-7 day time box; reduce only above the non-reducible core, never replace the deterministic server. |
| `app.js` split regresses legacy content behavior | High | Behavior-preserving split with characterization tests; legacy pages load both scripts; per-stage visual/E2E. |
| Content-negotiation regression breaks CLI/MCP/extension | High | Explicit `X-Hanse-Client` discriminator; `Accept` alone keeps the legacy path; contract matrix tests. |
| Two rendering modes hide a production-only bug | Medium | Rollback drill each stage; `?legacy=1`; mode switch tests; soak on the deployment host. |
| Chrome fragment drift or stale counters | Medium | Server renders one fragment; client swaps two containers; navigation/mutation/visibility refresh; E2E scoped links. |
| Tooling friction (Biome `.vue`, `vue-tsc`, Vitest projects) | Medium | Pinned versions; Stage 1 spike with exit criteria; scoped ESLint/Prettier fallback. |
| Tailwind misses classes from `ui/` | Medium | `@source "../../ui"`; sentinel class assertion in the build. |
| SFC `<style>` introduces a second stylesheet | Medium | CI rejects `<style>` in `ui/`; no CSS chunks; visual QA. |
| Bundle size regression | Medium | 200 KiB gzip measured budget for `/projects` first load; lazy route chunks. |
| Stage 7 git/image port introduces stale-state bugs | High | Port behavior, not structure; keep polling intervals and state vocabulary; fixture repo + image state matrix; 7a/7b/7c internal gates. |
| Accessibility regression | Medium | Route announcer, focus/title/aria, scroll container; visual-qa checklist; keyboard paths per stage. |
| Test suite runtime grows unmanageably | Medium | Component tests in the existing Vitest projects; E2E separate CI job; no real Docker in the unit suite. |
| An open tab breaks after a deploy (old chunks deleted) | Medium | `vite:preloadError` full reload; manifest validation; immutable hashed assets; no promise that old chunks survive. |
| Migration stalls mid-program | Low | Every stage is shippable and the program can stop after any stage; legacy routes remain whole. |
| `X-Hanse-Client` is dropped by the header passthrough | High | Add it to `server.ts`/`HttpRequest`; matrix test through `createHttpServer`. |
| Cookie-only auth silently accepts bearer | High | New `humanFromCookie` helper; bearer-rejection tests for `maybeServeSpa` and every `/api/ui/*`. |
| Form-encoded SPA mutations send JSON (or vice versa) | High | Per-endpoint encoding table; contract matrix covers accepted and rejected content types. |
| `maybeServeSpa` bypasses the agent-token guard | High | It performs the same rejection before serving a page; real-server test. |

## 11. Non-goals

- Server-side rendering of page content, no-JS support for SPA routes, or an SSR framework. The
  existing skills no-JS snapshot path is preserved only on the legacy rollback page; SPA routes
  require JavaScript.
- A public/versioned API, mobile app, or third-party client.
- Migrating the chat composer, SSE protocol, terminal, IDE, or preview proxy.
- Changing `DESIGN.md` tokens, the Tailwind visual language, or adding SFC `<style>` blocks.
- Database schema changes or new runtime dependencies.
- Vite 8 / Vitest 5 / jsdom 30 / TypeScript 7 upgrades in this program.
- Multi-user/rbac, offline support, service workers, or PWA behavior.

## 12. Open questions

None. The four owner decisions in §3.2 are closed; the four design-review questions in §3.1 are
resolved as architecture decisions. Stage D1 (chat/terminal) is a decision gate, not an open
question: it is answered after Stage 7 with measured boundary cost.

## 13. Verification

Every stage leaves the repository green:

```bash
npm run lint
npm run typecheck
npm run typecheck:ui
npm test                 # includes the jsdom UI project; server project forces HANSE_UI_LEGACY=1
npm run build            # includes build:ui
npm run check:sensitive
npm run test:e2e         # stage-specific flows, legacy + SPA modes
```

Plan 0031 additionally runs `typecheck:e2e` (Phase 0+) and `check:ui` (Phase 1A+); these are
plan-local gates added for this program, not new repository-wide process commands.

Plus, per stage:

- Manual feature matrix on the migrated route, including empty/error/master variants.
- Boundary matrix: SPA→legacy, legacy→SPA, refresh, deep link, back/forward, expired session,
  logout.
- Rollback drill: `HANSE_UI_LEGACY=1`, `?legacy=1`, and per-route removal, then restore.
- Legacy rollback smoke for the route.
- Visual QA at 390/768/1440, dark/light, keyboard focus, mobile drawers.
- `/projects` first-load transfer measured against S16.
- `npm install` under the documented Node floor (`>=20.19.0`) succeeds; `npm run build` works both
  with and without a prior `build:ui`.
- 48-hour soak on the deployment host before the next stage, when the process permits.

## 14. Review history

- 2026-10-28 - revision 1 authored; baseline `af49aae`; owner decisions closed.
- 2026-10-28 - round 1 `oracle` review: CHANGES REQUESTED (B1-B6, M1-M10, m1-m4). Findings folded
  into revision 2: Vue mounts into `<main>`; `app.js` split; explicit `X-Hanse-Client`; deterministic
  test mode; server-rendered chrome fragment; safer stage order with app detail last; `@source`
  path; no SFC `<style>`; SafeMarkdown; cookie-only `/api/ui/*`; Docker/manifest/preload fixes;
  props extraction before freeze; single page-dispatch point; flag precedence; pinned toolchain;
  route announcer/scroll and SmartLink guards.
- 2026-10-28 - round 2 `oracle` review: CHANGES REQUESTED (N1-N4 blockers, N5-N10 majors,
  N11-N14 minors). Findings folded into revision 3: `x-hanse-client` header passthrough; new
  cookie-only `humanFromCookie`; defined form encoding for the four SPA mutations and explicit
  handoff-create statuses; agent-token check in `maybeServeSpa`; delegated mobile-drawer close;
  single toast ownership per mode; real services in the E2E fixture; `app-content.js` load matrix;
  inner-HTML chrome fragment contract; SafeMarkdown clear; Node floor `>=20.19.0`; exact
  Playwright pin; open-questions record corrected.
- 2026-10-28 - round 3 `oracle` review: CHANGES REQUESTED (R1 blocker; R2-R3 majors; R4-R7
  minors). Findings folded into revision 4: handoff-create table rewritten around the real
  `queued`/`awaiting_approval`/`denied`/`existing` status and `{handoffId,status,state}` result;
  S7 amended for cookie-only SPA auth; server-rendered `#ui-fallback` for pre-mount failures; Node
  floor prose and Vite row corrected; design index and `docs/process.md` verification list updated;
  non-reducible Stage 0 core named; deletion E2E scoped as a contract test.
- 2026-10-28 - round 4 `oracle` review: CHANGES REQUESTED (R8 major: visible fallback flash;
  R9 minor: stale handoff summary row). Findings folded into revision 5: `#ui-fallback` is hidden
  by default and revealed only by a 4 s CSS delay if the client has not mounted; the handoff
  summary row now matches the detailed 201/202 contract; the full-row field is server-fetched and
  named explicitly.
- 2026-10-28 - round 5 `oracle` review: **PASS**. R8 (hidden fallback, no flash) and R9 (handoff
  summary row) resolved; no remaining blocker. Design approved.
- 2026-10-28 - revision 6: plan-review clarifications only - `HANSE_UI_SPA_ROUTES` unset/empty/list
  semantics, exact Vitest project globs, and the skills no-JS path scoped to the legacy rollback
  page. No architecture change; the round 5 PASS stands.
- 2026-10-28 - plan `0031-spa-migration.md` authored; plan review (`momus`) round 3 **PASS**.
  Implementation starts at Phase 0.

## 15. Amendments from the chat/terminal migration design (2026-10-30)

Approved design: [`chat-terminal-migration.md`](./chat-terminal-migration.md) §1.5. The following
items are recorded verbatim. They amend the invariants above for `/chat` and `/terminal` only; every
other invariant and wording stays unchanged.

1. **Route registry matching.** `matchPage` gains the `chat` and `terminal` ids and therefore matches
   `/chat` and `/terminal` as page routes. The old statement "never matches `/chat` or `/terminal`"
   is superseded. `/api/*`, `/ide`, `/preview`, `/assets/*`, and terminal upgrades remain unmatched.
   The client router records for both ids are **not** covered by this amendment; they are design work
   in §4.1/Stage 1-3B.
2. **No default-enabled legacy island.** A temporary legacy island is forbidden on a
   default-enabled SPA route. A test-only/internal allowlist containing the full default SPA set
   plus the route under test is used while a registry flag is still `false`; a bare `=chat` or
   `=terminal` is forbidden because it replaces the whole set. Any temporary scaffold is removed
   before that route's default cutover. Stage 9 is a real DOM/state migration, not an island kept
   alive.
3. **Vendored xterm CSS exception.** The terminal keeps the existing vendored xterm stylesheet as a
   same-origin asset. It is an explicit exception to "`assets/app.css` is the single stylesheet";
   the exception is limited to the terminal route and has exactly one loader owner (§4.7). Prism
   stays behind the existing worker; no new dependency is added. Q6 means "no new dependency", not
   "no Vite bundling": Vite may bundle the existing Prism worker/assets (§4.10, §11.1 Q6).
4. **S4 has no workspace exception.** Entering/leaving chat and terminal is client-side like any
   other migrated route. A future full-document boundary would be a new S4 amendment, not a
   per-route Q.
5. **Shared modules are not legacy scripts.** `assets/markdown.js`, `assets/chat-core.js`,
   `assets/chat-commands.js`, `assets/chat-diff.js`, `assets/chat-highlight.js`, and
   `assets/chat-highlight-worker.js` stay in place as shared libraries through this migration (§11.1
   Q3). Only `assets/chat.js` and `assets/terminal.js` are page clients to be deleted. The new
   `assets/chat-feed-store.js` copy is an additional UI-owned module, not a move of any of the six.
6. **S9/S12 rollback/checkout lifecycle narrowed after cleanup.** S9/S12 hold through the operator
   gate: the legacy document and runtime flags remain a valid rollback, and a checkout without a UI
   build can still serve legacy chat/terminal. Stage 9 deliberately retires that for these two
   routes: they become `legacyRetired`, so `HANSE_UI_LEGACY=1`, `?legacy=1`, and
   `HANSE_UI_SPA_ROUTES` removal are ignored for them and the SPA is served (or a 503 HTML when the
   UI manifest is missing) instead of `undefined`/JSON 404. Afterwards the invariant reads "image
   rollback + mandatory UI build/deploy check" (§4.13), not "flag rollback". This is an intentional
   post-cleanup contract change, not a regression.
7. **S10 scope narrowed.** S10's "`/chat`, `/terminal`, `/ide`, and demo previews are untouched by
   this program" is superseded for `/chat` and `/terminal` only. Both are explicitly in this
   program's scope; `/ide` and demo previews remain untouched (S6 still protects their contracts).
8. **S13 page-HTML test lifecycle changed for chat/terminal.** S13's "page-HTML tests are replaced at
   a route's cutover" is narrowed: for chat and terminal the legacy page-HTML tests keep guarding
   the rollback renderer through the Stage 8 operator gate and are deleted with the legacy renderer
   at Stage 9, not at cutover. Every other migrated route keeps the S13 behavior. The legacy
   rollback smoke test is likewise retired at Stage 9, when post-cleanup rollback becomes image
   rollback + the §4.13 deploy check.
