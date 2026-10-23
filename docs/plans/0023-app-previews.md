# Plan 0023 - App previews (demo)

Status: **implemented; automated verification passed; local runner-backed smoke passed** (journal
0026); deployment Vite/Next smoke pending; no commit yet. Plan review PASS (`momus`, 2026-10-23). Design:
[`docs/design/app-previews.md`](../design/app-previews.md) (approved, `oracle` PASS after three
rounds). Stage: `0023-app-previews`; journal: `docs/journal/0026-app-previews.md`.

## Bindings

| Binding | Value |
| --- | --- |
| Stage | `0023-app-previews` |
| Design artifact | `docs/design/app-previews.md` |
| Plan artifact | `docs/plans/0023-app-previews.md` |
| Design reviewer | `oracle` (rounds 1-3; round 3 PASS) |
| Plan reviewer | `momus` |
| Design index | `docs/design/README.md` |
| Plans index | `docs/plans/README.md` |
| Journal | `docs/journal/0026-app-previews.md`; index `docs/journal/README.md` |
| Decision record | none; the design and the owner decisions below record the contract |
| Open questions | none (design §12) |
| Verification | `npm run lint`, `npm run typecheck`, `npm test`, `npm run build`, `npm run check:sensitive` |
| Commit policy | one coherent stage commit only on explicit owner instruction; this plan does not authorize a commit |
| Deploy | not deployed by this stage |

## Owner decisions

Approved 2026-10-23, before the design review:

1. **Routing** - path-based preview on the coordinator; no wildcard subdomain, no host-port
   publishing, no separate preview origin. Demo-only.
2. **Same-origin risk** - accepted for the MVP, with the mandatory guards in design D8 and the
   persistent demo warning. The residual risk is documented.
3. **TTL** - delegated to the architect: 2 hours absolute, lazy pruning, explicit close, and
   lifecycle clearing; no idle refresh, no background timer.
4. **Limit** - 8 previews per application.
5. **Operator close** - allowed from the chat context rail, in addition to the agent's
   `preview_close`.
6. **Scope** - previews are app-scoped, not session-scoped.
7. **Runtime mode** - previews are enabled only in runner mode; supervisor mode returns
   `preview_unavailable`.

## Requirements traceability

| Requirement | Topic | Plan phase | Acceptance |
| --- | --- | --- | --- |
| AP1 | Token-bound `preview_open` over MCP | 1, 2 | A1, A2, A13 |
| AP2 | App-scoped in-memory registry, max 8, upsert | 1 | A1, A3 |
| AP3 | `preview_close` / `preview_list` | 1, 2 | A3 |
| AP4 | Human-only list/close API | 3 | A4 |
| AP5 | Path proxy, full-path forwarding, cookie auth | 4 | A5, A6, A8 |
| AP6 | Streaming and WebSocket | 4 | A6 |
| AP7 | Credential and header hygiene | 4 | A7 |
| AP8 | Base-path contract, no HTML rewriting | 2, 4, 5 | A8 |
| AP9 | 2h TTL, lifecycle clearing | 1, 3 | A9 |
| AP10 | Port policy, runner-only, app container target | 1, 2 | A1, A10 |
| AP11 | Tool card action and conditional rail block | 5 | A11 |
| AP12 | Demo warning, explicit open | 5 | A12 |
| AP13 | Master excluded, agent restart for new tools | 2, 6 | A13 |
| AP14 | No migration/dependency/runner change | all | A14 |
| AP15 | Verification green | 6 | A15 |

## Invariants

- **Token-bound target.** `preview_open`/`preview_close`/`preview_list` derive the app from the
  verified `AgentTokenIdentity`; no tool accepts an app, project, host, network, or target.
- **Runner-only.** The preview service exists only when `HANSE_RUNNER_URL`/`deps.runner` is
  configured. Supervisor mode returns `preview_unavailable`, registers no `/preview` proxy/upgrade
  route, and the list/close API returns `503`.
- **App container target.** The target host is `appContainerName(appId)`
  (`src/runner/names.ts:28-30`); the coordinator is attached to the app network by the runner
  (`src/runner/server.ts:1387-1389`). The tool accepts only a port.
- **In-memory only.** No SQLite table, no file, no background timer. `list`/`get`/`open` prune
  expired records lazily. Max 8 per app; 2h absolute TTL; upsert by key.
- **Full-path forwarding.** The proxy forwards the original `/preview/...` path and query
  unchanged; the app is mounted at `base_path`. It never strips the preview prefix.
- **No credential forwarding.** Request `cookie`, `authorization`, `proxy-authorization` are
  stripped. Response `set-cookie`, `clear-site-data`, `service-worker-allowed`, HSTS, `alt-svc`,
  `report-to`, `reporting-endpoints`, `nel`, `www-authenticate` are dropped on HTTP and on the WS 101.
- **WS 101 is bounded and allowlisted.** Buffer the upstream handshake to `\r\n\r\n` with a 64 KiB
  cap; on overflow or non-101, send 502 and never pipe unfiltered bytes. Preserve only `connection`,
  `upgrade`, `sec-websocket-accept`, `sec-websocket-protocol`, `sec-websocket-extensions`.
- **No HTML rewriting.** No HTML/CSS/JS rewriting or base injection; the agent configures Vite
  `base` or Next `basePath`/`trailingSlash: true`.
- **UI is conditional and app-scoped.** The rail wrapper is always rendered as a JS mount point but
  `hidden` when empty; the heading, divider, and rows are not visible when there are no previews. The
  block shows the current app's previews across sessions.
- **Master excluded.** `handleMasterRpc` is untouched; the master allowlist never includes preview
  tools.
- **No new dependency/migration/Docker change.** No `package.json` change, no migration, no runner or
  Docker container creation change.
- **No commit.** The plan does not authorize a commit; the owner must instruct one after verification.

## File map

New:

- `src/preview/types.ts` - `PreviewRecord`, `PreviewView`, `PreviewOpenInput`, `PreviewFailure`,
  `PreviewCleanup` (the manager-facing interface).
- `src/preview/service.ts` - `PreviewService` registry, validation, TTL, operator-host memory.
- `src/mcp/preview-protocol.ts` - `PREVIEW_TOOLS`, `isPreviewToolName`, `callPreviewTool`.
- `src/http/previews.ts` - `isPreviewsRoute`, `handlePreviews`.
- `src/http/preview-proxy.ts` - `proxyPreviewHttp`, `proxyPreviewUpgrade`, header filters,
  `Location` rewrite, error pages.
- `test/preview-service.test.ts`
- `test/preview-mcp.test.ts`
- `test/preview-http.test.ts`
- `test/preview-proxy.test.ts`
- `docs/journal/0026-app-previews.md` (Phase 6)

Modified:

- `src/http/handler.ts` - `HttpDeps.previews?: PreviewService`.
- `src/http/internal-mcp.ts` - pass `previews` into `handleRpcAsync`.
- `src/mcp/ssh-protocol.ts` - advertise/dispatch preview tools.
- `src/http/server.ts` - early proxy/upgrade routes, API dispatch, chat operator-host capture.
- `src/http/chat.ts` - server-render the rail block and pass the preview list.
- `src/opencode/manager.ts` - optional preview cleanup on lifecycle paths.
- `src/cli/commands.ts` - construct/pass the preview service when the runner is configured.
- `assets/chat.js` - static preview card, rail refresh/close, tool maps.
- `src/http/styles.css` - new rail/card classes; `npm run build:css` updates `assets/app.css`.
- `DESIGN.md` - §5.16 new class names.
- `docs/current-state.md`, `docs/design/README.md`, `docs/plans/README.md`,
  `docs/journal/README.md`, `README.md` - feature/docs/index entries.
- `test/chat-page.test.ts`, `test/manager.test.ts` - UI/lifecycle coverage.

No change: `src/runner/**`, `src/agent/spec.ts`, `src/store/migrations.ts`, `package.json`,
`compose.yaml`, `.hanse/app.yaml` schema.

## Phase 1 - Preview service and types

### Boundaries / non-goals

- No MCP, HTTP, proxy, manager, or UI integration.
- No database, file, timer, dependency, or schema change.
- The service is pure in-memory logic; it does not import `src/http`, `src/opencode`, or
  `src/runner`. It may import the pure `appContainerName`? No: the MCP layer supplies `targetHost`.

### Work

1. **`src/preview/types.ts`**
   - `PreviewOpenInput` = `{ appId, projectId, appKey, key, name, port, targetHost }`.
   - `PreviewRecord` = input + `{ createdAt: number; expiresAt: number }`.
   - `PreviewView` = `{ key, name, port, url, basePath, basePathWithoutTrailingSlash, createdAt,
     expiresAt }` with ISO timestamps.
   - `PreviewCleanup` = `{ clearApp(appId: string): void }`.
   - `PreviewFailureCode` = `preview_invalid_key` | `preview_invalid_name` |
     `preview_invalid_port` | `preview_reserved_port` | `preview_limit` |
     `preview_app_not_running` | `preview_unavailable` | `preview_internal_error`.
   - `PreviewFailure` carries `code` and `message`; use a `PreviewError extends Error`.
2. **`src/preview/service.ts`**
   - Constructor `{ now?: () => number; maxPerApp?: number; ttlMs?: number }`; defaults `Date.now`,
     8, `2 * 60 * 60 * 1000`.
   - `open(input): PreviewRecord`:
     - validate `key` `/^[a-z0-9][a-z0-9-]{0,31}$/`;
     - validate `name` 1..64 printable ASCII `0x20..0x7e`;
     - validate `port` integer `1024..65535` and `!== 4100`;
     - validate `targetHost` non-empty, no `/`, whitespace, or `:` (container name);
     - prune the app; if the key exists, update name/port/targetHost and refresh `expiresAt`;
     - if new and the app has 8, throw `preview_limit`;
     - store and return the record.
   - `get(appId, key)`: prune app; return record or `undefined`.
   - `list(appId)`: prune; newest first (createdAt desc, key tie-breaker); return records.
   - `close(appId, key)`: prune; delete; return boolean.
   - `clearApp(appId)`: delete all previews and the operator-host entry; idempotent.
   - `recordOperatorHost(appId, host)`: normalize with `new URL('http://' + host)`; store raw host
     and hostname (strip IPv6 brackets, strip port, lowercase); ignore invalid/empty; latest wins.
   - `operatorHost(appId)`: return `{ host, hostname } | undefined`.
   - `clearAll()` for tests.
   - `toView(record)`: build `url`/`basePath` with `encodeURIComponent(projectId/appKey/key)`; the
     base path ends with `/`; the no-slash form is the same without the last `/`.
3. **`test/preview-service.test.ts`** (see Tests).

### Acceptance criteria

- A1 (service part): valid open returns a record with the correct URL/base paths/expiry.
- A2: max 8; the 9th distinct key fails with `preview_limit`; upsert does not consume a slot.
- A3 (service part): close/list/clear behave; `closed:false` is representable by the caller.
- A9: lazy expiry with an injected clock; expired records disappear on the next access.
- A10: port/key/name/target validation, including 4100 and <1024.
- A14: no new imports outside `src/preview/`.

### Tests

- Valid open; URL encoding of project/app/key; two base spellings.
- Key: too long, uppercase, slash, leading hyphen, empty -> `preview_invalid_key`.
- Name: empty, 65 chars, newline, DEL/control -> `preview_invalid_name`.
- Port: 1023, 0, 65536, 4100 -> `preview_reserved_port`/`preview_invalid_port`.
- Target: empty, slash, whitespace, colon -> `preview_invalid_port`/`preview_internal_error`.
- Max 8; upsert at 8; 9th distinct fails.
- TTL with a fake clock; list/get/open prune; no timer.
- Clear by app; operator-host per app, latest wins, invalid ignored, clear removes.
- Newest-first ordering and key tie-break.

## Phase 2 - MCP tools

### Boundaries / non-goals

- No HTTP/UI/proxy changes.
- No master tool; no new MCP server; no new dependency.
- No tool accepts a target; the agent token is the only identity input.

### Work

1. **`src/mcp/preview-protocol.ts`**
   - `PREVIEW_TOOLS`: `preview_open` (`key`, `name`, `port` required; full JSON schema with pattern,
     min/max, integer bounds), `preview_close` (`key` required), `preview_list` (no properties).
   - `isPreviewToolName(name)` for the three names.
   - `PreviewToolContext` = `{ previews?: PreviewService; manager?: InstanceManager }`.
   - `callPreviewTool(context, agent, name, args)`:
     - if `previews` or `manager` is absent -> `{ok:false, code:"preview_unavailable"}`;
     - `preview_open`: require `manager.isRunning(agent.appId)`; target
       `appContainerName(agent.appId)`; call `previews.open`; re-check `isRunning` after insert;
       if stopped, `previews.close` and return `preview_app_not_running`; return
       `{ok:true, preview:{key,name,port,url,base_path,base_path_without_trailing_slash,
       operator_host, operator_hostname, expires_at}}`;
     - `preview_close`: close; `{ok:true, closed}`;
     - `preview_list`: `{ok:true, previews:[...]}`;
     - map `PreviewError` to `{ok:false, code, message}`; unexpected -> `preview_internal_error`.
   - Reuse `textResult` from `ssh-protocol.ts` (export it or move it to a small shared helper).
2. **`src/mcp/ssh-protocol.ts`**
   - Extend `AppSkillRpcOptions` with `previews?: PreviewService`.
   - In `tools/list`, include `PREVIEW_TOOLS` when `options.previews` is defined.
   - In `tools/call`, dispatch preview names **before** app-skill and `ssh_` handling; if
     `options.previews` is undefined, return `preview_unavailable` (do not fall through).
3. **`src/http/internal-mcp.ts`**
   - Pass `previews: deps.previews` into `handleRpcAsync` options. Do not touch the master branch.
4. **`src/http/handler.ts`**
   - Add `previews?: PreviewService` to `HttpDeps`.
5. **`test/preview-mcp.test.ts`** (see Tests).

### Acceptance criteria

- A1: an app token can open/list/close only its own app's previews; no target argument.
- A2/A3: max/upsert/close/list through the MCP envelope.
- A10: `preview_open` rejects non-running apps and supervisor mode; port 4100 rejected.
- A13: `tools/list` includes preview tools only when configured; the master list does not.
- A14: no master branch change, no new dependency.

### Tests

- `tools/list` with/without `previews`; master list unchanged; exact tool names/schemas.
- Open success; result shape; URL/base paths/operator host.
- Non-running app; supervisor/unconfigured -> `preview_unavailable`.
- Port 4100/1023/65536; invalid key/name.
- Max 8/upsert.
- Cross-app isolation: app A cannot list/close app B's key (the key lookup is app-scoped).
- Post-insert race: `isRunning` false after open -> record removed and `preview_app_not_running`.
- `preview_close` idempotent `closed:false`.
- `preview_list` newest first.

## Phase 3 - Human API, operator host, lifecycle wiring

### Boundaries / non-goals

- No proxy route yet.
- No UI yet.
- No DB migration.
- No change to existing human routes' auth behavior.

### Work

1. **`src/http/previews.ts`**
   - `isPreviewsRoute(method, path)`:
     - `GET /api/apps/:app/previews`;
     - `POST /api/apps/:app/previews/:key/close`.
   - `handlePreviews(deps, request)`:
     - `humanFrom`; missing -> `401`;
     - `deps.previews` absent -> `503 {code:"preview_unavailable"}`;
     - require `project` query -> `400 {code:"project_required"}`;
     - `findApp(deps, projectId, appKey)` -> `404 {code:"unknown_app"}`;
     - list: `{previews: views}`;
     - close: decode key; reject a cross-site `Origin` (compare `Origin` host to `Host`, absent
       allowed, literal `null` rejected) -> `403`; `{ok:true, closed:boolean}`;
     - use `no-store` on JSON.
   - Add a tiny local `sameOrigin` helper; do not refactor deletion/skills in this stage.
2. **`src/http/server.ts`**
   - Import `isPreviewsRoute`/`handlePreviews`; dispatch before `isChat` (the `isChat` catch-all
     would otherwise 404).
   - Pass the result through the existing response writer.
3. **`src/http/chat.ts`**
   - `handleChat`: for a human `GET /chat`, after `findApp`, call
     `deps.previews?.recordOperatorHost(found.app.id, request.host)`.
   - Do **not** change the rail markup in this phase; Phase 5 (visual-engineering) owns the
     server-rendered block, its wrapper/hidden contract, and its CSS.
4. **`src/opencode/manager.ts`**
   - `InstanceManagerOptions` add `previews?: PreviewCleanup` (type-only import from
     `src/preview/types.ts`).
   - Clear in:
     - `#stopLocked` after a successful `runtime.delete` (covers `stopApp`,
       `stopForDeletion`, `restartIfRunning`, `#restartLocked`);
     - `#forgetRunning` (covers out-of-band reconcile and restart-not-running);
     - `#ensureLocked` before both `runtime.delete` branches (container recreation).
   - `clearApp` is idempotent; double calls are harmless.
5. **`src/cli/commands.ts`**
   - Construct `const previews = runnerUrl ? new PreviewService() : undefined;` before the manager.
   - Pass `previews` to `InstanceManager` options and `createHttpServer` deps.
   - No change when the runner is absent.
6. **Tests** (see Tests).

### Acceptance criteria

- A4: human-only list/close; required project; agent token rejected; 503 when absent; Origin check.
- A9: stop/restart/delete/reconcile/ensure-recreate clear previews.
- A9/A11 (server part): operator host is captured on a human GET of the chat page; the rail block
  is Phase 5's responsibility.
- A14: no migration.

### Tests

- List: human cookie/bearer; no project -> 400; duplicate app key across projects -> only the
  requested project; unknown app -> 404; service absent -> 503.
- Close: human-only; 404/closed:false; cross-site Origin -> 403; same-origin/absent allowed.
- Operator host: human GET records; non-human does not; latest wins; per app; null before a load;
  stop/deletion clears.
- Lifecycle: manager fake records `clearApp` calls for stop, stopForDeletion, restart, reconcile,
  `#ensureLocked`; no clear on a failed delete (if the implementation chooses post-delete clearing).
- Chat capture: a human `GET /chat` records the host; the rail markup stays untouched in this phase
  (Phase 5 tests the SSR block).

## Phase 4 - Proxy HTTP and WebSocket

### Boundaries / non-goals

- No host-port publishing, subdomain, or Docker change.
- No HTML rewriting.
- No new dependency; use `node:http`/`node:net`.
- No generic proxy for `/api`.

### Work

1. **`src/http/preview-proxy.ts`**
   - `basePathFor(preview)` with trailing slash; `basePathWithoutSlash`.
   - `filterRequestHeaders(headers)`: copy all except `cookie`, `authorization`,
     `proxy-authorization`, and hop-by-hop (`connection`, `keep-alive`, `proxy-authenticate`, `te`,
     `trailer`, `transfer-encoding`, `upgrade`); keep `host`; add `x-forwarded-host` (original
     host), `x-forwarded-prefix` (base path with slash), `x-forwarded-proto` (incoming or `http`).
   - `filterResponseHeaders(headers)`: drop `set-cookie`, `clear-site-data`, `service-worker-allowed`,
     `strict-transport-security`, `alt-svc`, `report-to`, `reporting-endpoints`, `nel`,
     `www-authenticate`, and hop-by-hop. Keep per-document headers.
   - `rewriteLocation(location, basePath)`: parse path/query/fragment; prefix only a single-slash
     path that is not exactly the base and does not start with base + `/` for either spelling;
     preserve query/fragment; leave `//`, relative, absolute.
   - `proxyPreviewHttp(deps, request, response, preview, resolveTarget?)`:
     - target `http://<host>:<port>` with the original `request.url` path+query;
     - stream `request.pipe(upstream)` and `upstreamResponse.pipe(response)`;
     - handle `upstream.on("upgrade")` (an app 101 on a normal request) by destroying and sending
       502 if headers are not sent; never forward the 101;
     - upstream error -> 502 HTML page if headers not sent; end otherwise.
   - `proxyPreviewUpgrade(deps, request, socket, head, preview, resolveTarget?)`:
     - connect `net.connect(port, host)`;
     - write the request line with the original path/query (full path, no strip), filtered raw
       headers (credentials removed, Host kept, handshake headers kept), then `head`;
     - buffer the upstream response until `\r\n\r\n` with a 64 KiB cap; on overflow -> 502 handshake
       and destroy; never pipe unfiltered;
     - parse the status; non-101 -> 502 handshake and destroy;
     - parse headers, lowercase names, reject obs-fold/CRLF, allowlist `connection`, `upgrade`,
       `sec-websocket-accept`, `sec-websocket-protocol`, `sec-websocket-extensions`, regenerate;
     - write the filtered 101, pipe the remainder, then both directions; destroy on errors.
   - `previewNotFoundPage()` / `previewUnavailablePage()`: minimal standalone HTML with the design
     copy; no scripts, no coordinator shell.
   - `resolveTarget` seam defaults to `{ host: preview.targetHost, port: preview.port }`; tests
     inject a fake.
2. **`src/http/server.ts`**
   - Early `/preview/...` branch **before** `readBody`:
     - parse `/^\/preview\/([^/]+)\/([^/]+)\/([^/]+)(\/.*)?$/`; decode segments safely;
     - `isHumanCookie`; GET/HEAD -> 302 `/login?next=...`; other methods -> 401 JSON;
     - `deps.previews` absent -> 404/503? Use 404 page (route not registered) or 503; the design
       says no proxy route in supervisor mode, so the request falls through; guard anyway with 404.
     - `findApp`; `previews.get(app.id, key)`; project/app match; 404 page;
     - trailing-slash 302 (preserve query);
     - `proxyPreviewHttp`.
   - Upgrade listener **before** the `/ide` fallback:
     - parse the preview path; auth -> 401 handshake; resolve -> 404 handshake; Origin host=Host
       (absent allowed, `null` rejected) -> 403; `proxyPreviewUpgrade`.
   - Do not change the existing `/ide`/terminal behavior.
3. **`test/preview-proxy.test.ts`** (see Tests).

### Acceptance criteria

- A5: early route; full path/query forwarded; trailing slash; auth; 404.
- A6: streaming body/response; WS upgrade.
- A7: credentials stripped; origin-wide headers dropped; Location rules; 101 allowlist/cap.
- A8: no path stripping; the upstream sees the full `/preview/...` path.
- A12: no auto-open; the proxy does not redirect to the app automatically.
- A15: tests and gates.

### Tests

- Routing: `/preview/p/a/k` 302 to `/preview/p/a/k/?q=1`; full path sees `/preview/p/a/k/assets/x.js`.
- Auth: GET/HEAD 302 login; POST 401 JSON; agent token not accepted.
- 404/expired; app not running/upstream refused 502; upstream 500 passthrough.
- Streaming: upstream writes two chunks with a delay; assertion sees both without buffering.
- Request headers: cookie/auth/proxy-auth/hop-by-hop absent; Host kept; X-Forwarded-* present.
- Response headers: all drop-list names dropped; CSP/XFO kept.
- Location: single-slash prefixed; query/fragment preserved; base-with/without-slash not
  double-prefixed; sibling `.../<k2>` not mistaken; `//`/absolute untouched.
- HTTP 101 on a normal request -> 502, no forward.
- WS: 401/404/403 order; `Origin: null`/mismatch rejected; absent allowed; credentials stripped;
  full path; `head` forwarded; 101 allowlist preserves five headers and drops all others; >64 KiB
  header block -> 502 and no unfiltered bytes; non-101/refused -> 502; obs-fold/CRLF rejected.
- `resolveTarget` seam: a fake host/port is used in tests; production uses `appContainerName`.

## Phase 5 - Chat UI (visual-engineering)

### Boundaries / non-goals

- No new design system, color, font, radius, shadow, or motion token.
- No React/bundler; server-rendered chat + vanilla ESM.
- No preview UI on the application page.
- No HTML rewriting; the UI uses the server-returned `preview.url`.

### Work

Delegate to a `visual-engineering` agent with the `frontend` skill, implementing design §8
exactly. The agent must read `DESIGN.md`, `src/http/chat.ts`, `assets/chat.js`,
`src/http/styles.css`, `src/http/ui.ts`, and the design doc. Required changes:

1. **`src/http/chat.ts`** - server-render the `Previews` block from design §8.11:
   - wrapper `#chat-previews` always present, `hidden` only when the list is empty;
   - heading `Previews`, count `N active`, demo hint, `<ul role="list">` rows;
   - name link with `target="_blank" rel="noopener noreferrer"` and sr-only new-tab suffix;
   - close button (human-only, `hidden` until JS hydrates, accessible label);
   - no block, heading, or divider when empty.
2. **`assets/chat.js`**:
   - static preview card for `hanse_preview_open`/`preview_open` with `data-message-id`,
     `data-part-id`, `data-part-type`, `data-tool-key`, `data-preview-key`;
   - dedicated `createPartNode`/`updatePartNode`/`updatePreviewCard`; do not route the static card
     through `updateToolPart`;
   - action only on `completed` + parsed `{ok:true,preview:{key,name,url}}`; validate `url` starts
     with `/preview/` and resolves same-origin; never `javascript:`/cross-origin;
   - `Closed` state when the key leaves the list; preserve/move focus to the `tabindex="-1"` status
     text;
   - rail refresh after a preview tool part completes and on a visibility-aware low-frequency poll;
     `GET /api/apps/:app/previews?project=`; close POST; `#chat-announcer`; no upstream probing;
   - add `eye` to `toolGlyph` and the preview lines to `toolPreview` for both spellings.
3. **CSS** - add the new classes from design §8.11 to `src/http/styles.css`, then `npm run build:css`
   to regenerate `assets/app.css`. Update `DESIGN.md` §5.16 with the class names.
4. **Browser QA** - add `docs/design/preview-qa.mjs` (or extend `chat-qa.mjs`) with the deterministic
   fixture and assertions from design §8.13, screenshots to `artifacts/previews/`, and a
   `report.json`; exit non-zero on failure.

### Acceptance criteria

- A11: tool card action and conditional rail block; multiple previews; close; empty block absent.
- A12: persistent demo hint; no auto-open; `noopener`.
- A8 (UI): only the server-returned URL is used.
- A15: browser QA and build.

### Tests

- `test/chat-page.test.ts`: SSR wrapper/hidden, rows, links/`rel`, escaped names, no-JS close
  hidden, static card data attributes, action gating, `preview.url` validation, operator-host
  capture.
- `docs/design/preview-qa.mjs`: empty/1/3/8, long name, close last, close error/404/`closed:false`,
  tool card completed/running/error/unparseable, keyboard/focus, 390/768/1440 dark/light, no console
  or page errors.

## Phase 6 - Documentation, verification, record

### Work

1. **Docs**
   - `docs/current-state.md`: add an "App previews (demo)" section (runner-only, MCP tools, path
     route, TTL/limit/lifecycle, same-origin accepted risk, base-path limitations).
   - `docs/design/README.md`: status approved (oracle PASS after 3 rounds).
   - `docs/plans/README.md`: plan entry.
   - `README.md`: one feature bullet.
   - `docs/journal/0026-app-previews.md` and `docs/journal/README.md`: stage record.
   - `docs/open-questions.md`: already records the owner decisions; no change needed unless the plan
     adds a decision.
2. **Verification**
   - `npm run lint`
   - `npm run typecheck`
   - `npm test`
   - `npm run build`
   - `npm run check:sensitive`
3. **Manual smoke**
   - On a runner-backed deployment, create a disposable app with a Vite/Next fixture, start the dev
     server on `0.0.0.0:<port>` under the returned base, open the preview from the tool card and the
     rail, verify 0/1/8 previews, close, expiry (fake clock or short TTL in a test build), and app
     restart clearing. Record evidence only in the untracked `docs/deploy/` area; no host specifics
     in tracked files.
4. **Record**
   - Write the journal entry; update the indexes.
5. **Commit**
   - Do not commit. Report "ready to commit" and wait for explicit owner instruction.

### Acceptance criteria

- A13: existing agents see the tools after restart; docs say so.
- A15: all verification commands green.
- Record exists and indexes updated.

## Risks and mitigations

| Risk | Mitigation |
| --- | --- |
| Same-origin preview app can call coordinator APIs with the operator session. | Accepted by the owner; D8 guards, explicit click, persistent demo hint, no credential forwarding, `Set-Cookie`/`Clear-Site-Data`/`Service-Worker-Allowed` dropped, `noopener`. Documented as not a security boundary. |
| The agent misconfigures Vite/Next base path. | Tool returns both base spellings, `operator_host(hostname)`, and the per-framework contract; 404/502 pages are explicit; manual smoke covers Vite and Next. |
| `operator_host` is null (operator has not loaded chat). | Per-framework permissive/wildcard fallback documented; idempotent `preview_open` can be called again after the chat page loads. |
| Next `trailingSlash` mismatch causes a loop. | Contract requires `trailingSlash: true`; proxy 302 and `Location` rule handle both spellings. |
| WS 101 header block flood / filter bypass. | 64 KiB cap, 101 allowlist, non-101 502, parsed header regeneration, obs-fold/CRLF rejection; tests. |
| Coordinator restart loses previews. | Documented; agent reopens; no DB by design. |
| Front proxy rewrites Host. | Documented deployment assumption; preserve Host. |
| No proxy timeout/connection cap. | Accepted demo residual; route is human-authenticated; Node/browser defaults. |
| UI static card breaks message reconciliation. | Identity attributes + dedicated create/update branch; chat-page tests and browser QA. |
| Runner-only means local supervisor dev cannot test. | Unit/proxy fixtures plus a runner-backed manual smoke; supervisor returns `preview_unavailable`. |

## Out of scope

Design §11: host ports, wildcard subdomains, separate origin, cross-app networking, non-HTTP
protocols beyond WebSocket, persistence, HTML rewriting, app authentication, sandboxed iframe,
per-app opt-in/RBAC/audit, port 4100, master tools, application-page preview UI, supervisor mode.

## Verification commands

```bash
npm run lint
npm run typecheck
npm test
npm run build
npm run check:sensitive
```

## Plan review

### `momus`, 2026-10-23 - **PASS**

The plan is executable and its references check out: `docs/design/app-previews.md` exists and
contains the cited §8.11, §8.13, and §12 sections; `src/runner/names.ts:28-30` defines
`appContainerName`; `src/runner/server.ts:1387-1389` is the app-network attach; and every modified
file exists. New files are listed, internal symbols (`textResult`, `handleRpcAsync`,
`AgentTokenIdentity.appId`, `isRunning`, `humanFrom`, `findApp`, the chat UI hooks) are present, and
each phase has concrete work, acceptance criteria, and test/QA scenarios plus the Phase 6
verification commands and manual smoke. No blocking gaps found.

Implementation is unblocked. The gate evidence is: design review PASS (round 3), owner decisions
recorded, plan review PASS. No commit is authorized by this plan.
