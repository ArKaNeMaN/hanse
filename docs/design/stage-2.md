# Stage 2 - Authenticated web UI

Status: complete. Stage 3 (chat workspace) is not part of this record.

## Scope

Stage 2 replaces the single daisyUI-era dashboard with a server-rendered product UI built from the
stage-1 contract in [`DESIGN.md`](../../DESIGN.md). No client framework, bundler, external font, CDN,
or new dependency was added.

| Surface | Route | Notes |
| --- | --- | --- |
| Login | `GET/POST /login` | Standalone `.cover` + `.login-plate`; no shell. |
| Sign out | `POST /logout` | Clears `hanse_token` and redirects to `/login`. |
| Fleet overview | `GET /` | Watch strip, project ledger, recent handoffs, waiting rail, runtime summary. |
| Projects index | `GET /projects` | Server-side `q` search over name and root path. |
| Project detail | `GET /projects/:id` | Applications, project handoffs, waiting rail, manifest, add-app and new-handoff dialogs. |
| Handoffs inbox | `GET /handoffs` | `filter=all/waiting/active/closed`, `q` search, inline decisions, review dialogs. |
| Decision | `POST /api/handoffs/:id/decision` | One form, `decision=approved/rejected`, optional `reason`, hidden `return_to`. |
| Legacy decisions | `POST /api/handoffs/:id/approve`, `/reject` | Kept for API and CLI compatibility; accepted `reason` and `return_to`. |
| Assets | `GET /assets/app.css`, `/assets/app.js`, `/assets/favicon.svg` | Strict allowlist; no auth. |
| Errors | any unknown browser GET | Styled HTML 404 inside the shell; page-level failures use `.error-state`. |

## Auth and redirects

- Every HTML page except `/login` and `/assets/*` requires a principal with `kind === "human"`.
- Unauthenticated HTML requests redirect `303` to `/login?next=<path>`. `next` and every `return_to`
  must be a local path starting with `/`, not `//`, not contain a backslash or control characters.
- `POST /login` authenticates with `authenticate(db, "Bearer <token>")`, rejects agent principals, and
  sets `hanse_token` (`HttpOnly`, `SameSite=Strict`, `Path=/`, `Max-Age=2592000`). Invalid credentials
  re-render the plate with `401`, an inline error, and no cookie.
- `/api/*` keeps its JSON auth responses for non-browser callers. Browser form submissions receive a
  `303` to a validated `return_to` with a `notice` and `tone` instead of JSON.
- The `/ide/*` proxy also requires a human principal and redirects to login with `next`.

## Implementation

- `src/http/ui.ts` owns escaping, the inline SVG sprite, status/runtime pills, relative and absolute
  time, route cards, handoff dialogs, page header, shell, login, toasts, and the safe-local-path
  validator.
- `src/http/dashboard.ts` builds one `SiteModel` from `getProjects()`, `listHandoffs(db)`, the
  `projects` registration time, and the `instances` table. It derives waiting/active/closed counts,
  running/stopped/failed counts, app labels, and last activity, then renders each page.
- `src/http/handler.ts` owns routing, auth, login/logout, the decision endpoint, browser form
  redirects, notices, and the static-asset allowlist. `src/http/server.ts` supplies `accept` and
  `content-type` to the handler and passes route parameters unchanged.
- `assets/app.js` is the only product JavaScript: drawer (scrim, Escape, focus return), native
  dialog open/close/backdrop, theme toggle, toast auto-dismiss, token visibility, and submit busy
  state. The only inline script is the tiny head theme initializer that prevents a flash.
- Every dynamic string passes through `escapeHtml`; ids are shown full in dialogs and sliced to eight
  characters in table rows.

## Responsive and accessibility

- Fixed 232px sidebar at >=1200, 212px at 1024-1199, off-canvas drawer below 1024. One scroll owner:
  `.page` (sidebar nav scrolls independently).
- Overview grid is 2fr/1fr at >=1280. Project detail uses a 320px rail at >=1280. Tables switch to
  `.table--stack` below 768 and all primary content stays within 390px.
- Handoff filters are links with `aria-current`; active state is a wash plus the brass diamond.
- Dialogs are native `<dialog>` elements with `aria-labelledby`, trapped focus, Escape, backdrop
  close, and a visible Cancel. The handoff decision form keeps Approve before Reject in DOM order so
  the non-destructive action is the form default.
- Every icon-only control has an `aria-label`. Status is always glyph + text + color. Login errors use
  `aria-invalid` and `aria-describedby`. The notice region is `aria-live`; error toasts use
  `role="alert"` and persist.

## Deviations and accepted debt

- Project detail keeps the rail below the main column until 1280 rather than 1024. At 1024-1279 the
  fixed 320px rail leaves the application table too narrow and forces paths to break every few
  characters; stacking there preserves the no-horizontal-scroll and legible-path rules. The rail is
  still full width below 1024 as specified.
- The handoff inbox table (`.table--inbox`) stacks through 1199 rather than only below 768. Six
  columns plus two inline decision buttons do not fit legibly below the full 1200px shell; the
  stacked form keeps id, route, state, summary, time, and actions readable. Every other table keeps
  the contract breakpoint at 768.
- Applications report `kind = "app"` when the project manifest has no kind. The demo manifest was
  re-registered without kind metadata, so a neutral app badge is shown instead of an empty cell.
- Login autofocuses the token field, so the focus-visible ring is visible on first paint. This is
  intentional for a single-field sign-in.
- Theme is two-state (dark default, light). A system-follow third state is not implemented.
- The chat page and `src/http/chat.ts` are untouched; chat entry links from applications work.

## Evidence

Captured with real Playwright Chromium against the seeded demo DB on `127.0.0.1:8791` and a separate empty
DB on `127.0.0.1:8794`:

- `docs/design/artifacts/stage2/{overview,projects,project,handoffs}-{390,768,1024,1440}-{dark,light}.png`
- `login-page-{390,1440}-{dark,light}.png`, `login-error-390-dark.png`
- `drawer-390-{dark,light}.png`
- `dialog-new-project-1440-{dark,light}.png`, `dialog-handoff-1440-{dark,light}.png`,
  `dialog-new-handoff-390-{dark,light}.png`, `dialog-decision-390-dark.png`
- `toast-success-1440-{dark,light}.png`, `toast-error-1440-{dark,light}.png`
- `empty-overview-1440-{dark,light}.png`, `empty-projects-1440-{dark,light}.png`,
  `empty-handoffs-1440-{dark,light}.png`
- `focus-1440-dark.png`, `notfound-1440-dark.png`, `overview-390-dark-end.png`,
  `handoffs-390-dark-end.png`, `handoffs-1440-dark-end.png`, `project-390-dark-end.png`,
  `project-1440-dark-end.png`, `handoffs-1200-dark.png`
- State variants: `project-empty-waiting-1440-dark.png` (zero pending), `project-no-apps-1440-dark.png`
  (new project with no applications).

## Verification

```text
npm run lint
npm run typecheck
npm test
npm run build
```

All four gates pass; the suite has 88 tests, including 31 HTTP tests covering auth, open-redirect
blocking, login/logout cookies, HTML pages, search and filters, decisions, browser form redirects,
escaping, 404s, and the asset allowlist.

## Stage 3 handoff

The chat page must reuse, not re-implement:

- `ui.ts`: `appShell`, `pageHeader`, `statusPill`, `runtimePill`, `routeCard`, `handoffDialog`,
  `emptyState`, `timeTag`, `timeAgo`, `escapeHtml`, `icon`, `iconSprite` (via the shell),
  `toastRegion`, `loginPage`, `safeLocalPath`, `ideBase`/`ideFolderUrl`.
- Shell classes: `.app-shell`, `.sidebar*`, `.shell-main`, `.topbar*`, `.breadcrumb`, `.page`,
  `.page-header*`, `.scrim`, `.nav-toggle`.
- Chat classes already present in `styles.css`: `.chat-shell`, `.chat-sessions`, `.chat-thread`,
  `.chat-thread__scroll`, `.chat-thread__inner`, `.chat-context`, `.chat-pane-head`, `.message`,
  `.message__meta`, `.message__body`, `.tool-call`, `.tool-call__path`, `.composer`,
  `.composer__row`, `.composer__hint`.
- `assets/app.js` unchanged for the global shell. Stage 3 owns session selection, composer behavior,
  SSE subscription, and the chat context toggle/drawer; keep `handleChat`, session endpoints, and
  SSE semantics intact.
