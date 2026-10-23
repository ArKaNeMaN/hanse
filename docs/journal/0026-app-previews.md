# 0026 - App previews (demo)

Design: [`docs/design/app-previews.md`](../design/app-previews.md). Plan:
[`docs/plans/0023-app-previews.md`](../plans/0023-app-previews.md). Stage: `0023-app-previews`.

## Context

An app agent could write and run code but had no supported way to show the operator the result. The
goal was a demo loop: the agent starts a service in its own container, declares a preview over MCP,
and the operator opens it from the chat tool card or the context rail without deploying outside
Hanse. The owner chose path-based routing, accepted the same-origin risk for the MVP, and delegated
the TTL. The design and plan went through the full gate: design review (`oracle`, three rounds; round
3 PASS) and plan review (`momus` PASS).

## What was implemented

- **Preview registry** (`src/preview/`): app-scoped, in-memory, max 8 per app, 2-hour absolute TTL
  with lazy pruning, upsert by key, explicit close, operator-host memory, and a `PreviewCleanup`
  interface for the manager. No DB, file, timer, or dependency.
- **MCP tools** (`src/mcp/preview-protocol.ts`): `preview_open`, `preview_close`, `preview_list` on
  the non-master `hanse` surface. Calls are bound to the verified agent token; the only target input
  is a port; the target host is `appContainerName(appId)`; supervisor mode returns
  `preview_unavailable`. A post-insert `isRunning` re-check closes the open/stop race.
- **Human API** (`src/http/previews.ts`): `GET /api/apps/:app/previews?project=...` and
  `POST /api/apps/:app/previews/:key/close?project=...`; human-only, required project, Origin check
  on close, `404`/`503` mapping.
- **Proxy** (`src/http/preview-proxy.ts`, `src/http/server.ts`): early `/preview/...` HTTP branch
  before `readBody` and a matching upgrade branch. Full-path forwarding, streaming, HTTP/WS,
  credential stripping, origin-wide response-header filtering, `Location` rewriting at a segment
  boundary, a 64 KiB/allowlist WS 101 filter with non-101/overflow 502s, and the preview-only
  `Origin` host = `Host` check.
- **Lifecycle** (`src/opencode/manager.ts`, `src/cli/commands.ts`): `PreviewService` is constructed
  only in runner mode and shared by MCP, HTTP, and the manager; stop, stopForDeletion, restart,
  reconcile, and container recreation clear the app's previews.
- **Chat UI** (`src/http/chat.ts`, `assets/chat.js`, `src/http/styles.css`, `DESIGN.md`): a
  conditional context-rail `Previews` block (wrapper always present, `hidden` only when empty), a
  static `hanse_preview_open` card with an always-visible action only on a completed success
  result, same-origin URL validation, `Closed` state/focus handling, rail refresh/close, and the
  persistent demo hint. UI design was produced and implemented by the visual-engineering agent.
- **Verification and evidence**: unit/MCP/API/proxy/manager/chat tests, a deterministic
  `docs/design/preview-qa.mjs` browser harness (31/31 scenarios, 22 screenshots), and the design
  review/plan review records.

## Decisions and why

- **Path-based proxy, not host ports/subdomains.** The coordinator already proxies `/ide` and is
  attached to every app network; this avoided wildcard DNS/TLS, host-port allocation, and a second
  front door. The owner accepted the same-origin risk for the demo.
- **Full-path forwarding.** The first design stripped the preview prefix while requiring the app to
  be mounted at that base; round 1 flagged the contradiction. Forwarding the original path lets
  Vite `base` and Next `basePath` work. The tool returns both base spellings, and Next must use
  `trailingSlash: true` to avoid the proxy/Next redirect loop.
- **Runner-only.** The first port policy excluded only 4100; in supervisor mode ports 4101-4199 are
  other apps' control ports on a shared host. Round 2 made previews runner-only and set the target
  host to `appContainerName`, removing the shared-loopback ambiguity.
- **In-memory, lazy TTL.** Previews are ephemeral demo state; no migration, timer, or persistence.
  A coordinator restart loses them; the agent reopens.
- **No HTML rewriting.** The agent configures the framework base; the proxy forwards the full path.
  A root-absolute asset URL that ignores the base remains a documented limitation.
- **Same-origin guards.** Credentials are not forwarded; `Set-Cookie`, `Clear-Site-Data`,
  `Service-Worker-Allowed`, HSTS, `Alt-Svc`, `Report-To`, `Reporting-Endpoints`, `NEL`, and
  `WWW-Authenticate` are dropped; the WS 101 is allowlisted; links use `noopener`; the UI carries a
  persistent demo warning. The residual same-origin API/cookie/logout access is accepted.

## Verification

All commands were run from the repository root after the last change:

- `npm run typecheck` - pass.
- `npm run lint` - pass (266 files).
- `npm test` - 111 files / 1947 tests pass.
- `npm run build` - pass (`tsc` + Tailwind CSS).
- `npm run check:sensitive` - pass.
- `node docs/design/preview-qa.mjs` - PASS (31/31 scenarios, 22 screenshots) ->
  `docs/design/artifacts/previews/report.json`.

New targeted suites: `test/preview-service.test.ts`, `test/preview-mcp.test.ts`,
`test/preview-http.test.ts`, `test/preview-proxy.test.ts`; extended `test/chat-page.test.ts` and
`test/manager.test.ts`.

### Manual runner-backed smoke (local)

A disposable local B1 runner stack was used with a current-source coordinator image, a synthetic
project/app, and a stand-in app container on the runner's app network carrying the runner's expected
name and labels. The pre-existing local agent image's `opencode` entrypoint fails with `EACCES` on
the agents mount in that fixture, so the smoke used a minimal Node HTTP/WS service inside the
stand-in container to isolate the preview path; this is a local fixture limitation, not a feature or
app-image change.

Verified over the real runner-created app network:

- `preview_open` through `/internal/mcp` returned the preview URL.
- An authenticated HTTP request returned `200`; the upstream saw the full `/preview/...` path and
  query, while `cookie`/`authorization` were absent and `X-Forwarded-Prefix`/`X-Forwarded-Host` were
  present.
- A request without the operator cookie redirected to login; an unknown key returned `404`;
  `preview_close` returned `{ok:true,closed:true}` and the next request returned `404`.
- A raw WebSocket handshake received `101` with `sec-websocket-accept` preserved and
  `set-cookie`/`clear-site-data`/`www-authenticate` dropped; echo worked.

The local smoke stack was removed after the run. A deployment-host smoke with a real Vite/Next app
remains.

## Deviations and notes

- The plan originally assigned both operator-host capture and rail rendering to Phase 3. Execution
  split them: Phase 3 added `recordOperatorHost`; Phase 5 (visual-engineering) owned the rail markup
  and CSS. The plan text was updated accordingly.
- The `#ensureLocked` lifecycle test starts the app, detaches, sets the fake runtime's endpoint to
  `null` (state still `running`), then calls `ensure`; this forces the destructive recreation branch
  that the plan intended to cover. A plain detach+ensure would reconnect in place.
- The UI uses `--space-2` (8px) bottom padding for `.tool-call__note` instead of the design's
  literal 10px, to stay within existing spacing tokens.
- The `preview_close` card shows `Closed <key>` because the close tool input carries only `key`.
- `previewUnavailablePage` is not imported into `server.ts`; it is used by the proxy's HTTP 502 path
  and would be an unused import there.
- The proxy 302s only the bare preview base (no remainder) to the trailing-slash URL; proxied
  subpaths must keep their own slashes.
- The QA harness runs a self-started synthetic chat shell and mirrors the backend 404/502 pages; the
  real SSR renderer is covered by `test/chat-page.test.ts`.

## Accepted risks and residual limitations

- The previewed app runs in the operator's Hanse origin. It can call same-origin APIs, write a
  non-HttpOnly `hanse_token` directly, or call `/logout`; `Set-Cookie` dropping only covers the
  response path. This is the owner-accepted demo risk and is not a security boundary.
- Runner mode only; supervisor mode has no previews. Existing agents must be restarted to see the
  new tools (no image rebuild).
- No persistence across coordinator restart; no idle TTL refresh; no host ports, subdomains,
  sandboxed iframe, per-app auth, audit table, or HTML rewriting.
- No proxy-specific timeout or connection cap; the route is human-authenticated and relies on
  Node/browser defaults.
- `operator_host` is app-visible host guidance; it is not a credential and is accepted as a demo
  residual.
- A front reverse proxy must preserve the original `Host` for the WebSocket `Origin` check.

## Next steps

- Owner review and, if authorized, one coherent stage commit (code + tests + docs + evidence).
- A local runner-backed proxy smoke passed. A deployment-host smoke with a real Vite/Next app
  remains: start the app under the returned base, open from the tool card and rail, verify 0/1/8
  previews, operator close, expiry, and restart clearing. Record host-specific evidence only in the
  untracked `docs/deploy/` area.
- Not deployed by this stage; no commit was made.
