# Design - App previews (demo)

Status: **implemented; automated verification passed; local runner-backed smoke passed** (journal
0026); deployment Vite/Next smoke pending; no commit yet. Design review round 3 returned PASS (`oracle`, 2026-10-23); plan review
returned PASS (`momus`, 2026-10-23). This document records the approved design contract; the plan
and implementation evidence live in
[`docs/plans/0023-app-previews.md`](../plans/0023-app-previews.md) and
[`docs/journal/0026-app-previews.md`](../journal/0026-app-previews.md). Verification:
`npm run lint && npm run typecheck && npm test && npm run build` plus
`npm run check:sensitive` (`docs/process.md:34-43`).

Scope: let an application agent expose an HTTP service that is already running **inside its own app
container** to the operator, through a path-based reverse proxy on the coordinator. The agent
declares a preview with a key, a display name, and a container port over the existing `hanse` MCP
surface. The operator sees a button in the chat tool card and an app-scoped block in the chat
context rail. The feature is intentionally demo-only: one application container, ephemeral routes,
no persistence, no separate origin.

Out of scope: publishing host ports; wildcard subdomains or a separate preview origin; exposing
services from two different applications to each other; non-HTTP protocols other than WebSocket;
persistence across a coordinator restart; HTML/CSS/JS rewriting; authenticating the previewed app;
per-app opt-in or multi-user authorization; previews of the opencode control port; master-agent
tools; a database migration; a new dependency; any change to the runner or to Docker container
creation.

## 1. Problem

An application agent can write and run code, but the operator can only look at the repository, the
chat, and the IDE. There is no supported way for the agent to say "I started the app on port 3000;
look at it", and no way for the operator to open that service without deploying it somewhere
outside Hanse. The existing `/ide` route proves the coordinator can reverse-proxy HTTP and WebSocket
traffic to a container on a private network, and the coordinator is already attached to every app
network, so a path-based preview is a small extension of an existing mechanism rather than a new
ingress subsystem.

The product value is a demo loop: agent builds a UI, opens a preview, operator clicks, sees the
result, and asks for the next change. The same mechanism later supports a front-end and back-end
that run as two services inside one application container, but it does not solve cross-application
networking and does not claim to be a production ingress.

## 2. Requirements

| ID | Requirement |
| --- | --- |
| AP1 | An ordinary (non-master) app agent can open a preview with `preview_open({key, name, port})` over the existing `hanse` MCP surface. The target application is derived from the verified agent token; no tool argument can select another app, project, host, or network. |
| AP2 | A preview is app-scoped, ephemeral, and in memory: at most 8 per app, keyed by a caller-chosen slug unique within the app. A repeated `preview_open` with the same key updates the name/port and refreshes the expiry (idempotent upsert). |
| AP3 | `preview_close({key})` removes one preview; `preview_list()` returns the caller's active previews. Closing a preview removes the operator-facing route only; it does not stop the agent's service. |
| AP4 | A human-only API lists previews for the chat rail and lets the operator close one. The list is available at `GET /api/apps/:app/previews?project=...`; close is a human-only mutation. |
| AP5 | The operator reaches a preview at `/preview/<projectId>/<appKey>/<key>/...`. The route authenticates the operator with the existing `hanse_token` cookie (same as `/ide`), proxies HTTP and WebSocket to the app container on the declared port, and forwards the original path and query **unchanged**. The app is mounted at `base_path` and receives the full `/preview/...` path. |
| AP6 | The proxy streams request and response bodies (no 64 KiB dispatcher buffer), preserves SSE/chunked responses, and supports WebSocket upgrades. |
| AP7 | The proxy never forwards the operator's `cookie` or `authorization` to the app. It drops origin-wide response headers from the app (`set-cookie`, `clear-site-data`, `service-worker-allowed`, HSTS, `alt-svc`, `report-to`, `reporting-endpoints`, `nel`, `www-authenticate`) and rewrites a single-slash root-relative `Location` to the preview base path. |
| AP8 | The agent serves the app under the returned `base_path`; the proxy forwards the full `/preview/...` path unchanged, so the app's router must accept that base. The proxy performs no HTML/CSS/JS rewriting; a root-absolute asset URL that ignores the base path is an accepted limitation. |
| AP9 | Previews expire after 2 hours absolute, are pruned lazily on any registry access, and are cleared immediately when the app stops, restarts, is reconciled as stopped, or is deleted. A coordinator restart loses every preview; the agent can reopen. |
| AP10 | `port` must be an integer in `1024..65535` and must not be `4100` (the opencode control port). The app must be running. The feature is enabled only in runner mode (`HANSE_RUNNER_URL`); in supervisor mode `preview_open` returns `preview_unavailable`, the `/preview` proxy and upgrade routes are not registered, and the list/close API routes are registered but return `503 preview_unavailable`. |
| AP11 | The chat tool card for `preview_open` shows an "Open preview" action only when the tool call is completed and its JSON result is a success. The right context rail shows a "Previews" block with one action per active preview; the block and its divider are absent when the list is empty. |
| AP12 | The UI carries a persistent, non-alarmist demo warning: previews run inside the operator's Hanse origin. The operator must click to open; no preview is auto-opened. |
| AP13 | The master agent receives no preview tools. Existing app agents see the new tools after a restart (the MCP `tools/list` is read at agent start); no image rebuild is required. |
| AP14 | No database migration, no new npm dependency, no runner change, and no change to Docker container creation. Existing `HttpDeps` consumers and tests remain valid when the preview service is absent. |
| AP15 | The stage leaves `npm run lint`, `npm run typecheck`, `npm test`, and `npm run build` green. |

## 3. Verified facts

- `/internal/mcp` verifies the bearer token, branches on the reserved master identity, and for a
  normal app constructs `new CoordinatorService(deps.db, agent.projectId)` and calls
  `handleRpcAsync` (`src/http/internal-mcp.ts:28-80`). The agent identity is
  `{appId, projectId, appKey}` (`src/mcp/agent-tokens.ts:7-12`, `:106-122`).
- `handleRpcAsync` advertises `[...TOOLS, ...SSH_TOOLS, ...APP_SKILL_TOOLS]` on `tools/list` and
  routes known app-skill tools before the `ssh_` prefix check
  (`src/mcp/ssh-protocol.ts:123-143`, `:145-205`). The master branch uses `handleMasterRpc` and its
  own allowlist (`src/http/internal-mcp.ts:47-59`, `src/mcp/master.ts:38-40`).
- `HttpDeps` already carries optional `manager`, `settings`, `ssh`, `skills`, runner, images,
  deletion, and logger dependencies (`src/http/handler.ts:50-69`). Production constructs one
  instance of each and passes it to the manager and the HTTP server (`src/cli/commands.ts:647-716`).
- `createHttpServer` handles `/ide` and `/ide/*` **before** `readBody`, then buffers every other
  request through `readBody` with a 64 KiB default cap
  (`src/http/server.ts:119-134`, `:24-41`, `:50-78`). The upgrade listener accepts only
  `/api/apps/:app/terminal` and `/ide*`; every other upgrade is destroyed
  (`src/http/server.ts:235-260`).
- `proxyHttp` copies all request headers, including `cookie` and `authorization`, to the upstream,
  copies all upstream response headers, strips the `/ide` prefix, and pipes both directions
  (`src/http/server.ts:80-117`). This is acceptable for the trusted IDE and is the exact behavior a
  preview proxy must not copy.
- `isHumanCookie` is the cookie-only human check used by `/ide` and the terminal upgrade
  (`src/http/auth.ts:55-68`); the cookie is `hanse_token`, `Path=/`, `HttpOnly`, `SameSite=Strict`,
  no `Secure` (`src/http/handler.ts:545-563`).
- The coordinator persists the app runtime endpoint in `instances.endpoint`
  (`src/store/migrations.ts:32-42`); `statusFromInspect` builds `http://<containerName>:4100` in
  runner mode (`src/runner/server.ts:302-321`). The preview feature does **not** use the persisted
  endpoint for targeting (it uses `appContainerName(appId)` and is runner-mode only), but this fact
  proves reachability: the coordinator already joins every app network with alias `hanse`
  (`src/runner/server.ts:1387-1389`), so `<containerName>:<previewPort>` is reachable without Docker
  changes. `appContainerName`/`appNetworkName` are pure helpers (`src/runner/names.ts:22-30`).
- `InstanceManager.isRunning` is the in-memory running check (`src/opencode/manager.ts:799-801`);
  `stopApp`, `stopForDeletion`, `#stopLocked`, `restartIfRunning`, `#restartLocked`,
  `#forgetRunning`, `#reconcileStatuses`, and `#ensureLocked`'s `runtime.delete`/recreate path are
  the lifecycle paths that must clear previews (`src/opencode/manager.ts:902-981`, `:1046-1130`,
  `:1408-1450`, `:556-564`).
- The chat page is server-rendered HTML with one vanilla ESM module
  (`src/http/chat.ts:200-410`); the context rail is the `<aside class="chat-context">` markup at
  `src/http/chat.ts:327-402`, and `handleChat` renders it at `:527-557`. The client's tool renderer is
  `updateToolPart` (`assets/chat.js:2781`), with `toolPreview` (`:2018`), `toolOutputText` (`:2118`),
  `ensureToolBody` (`:2580`), and `updateToolPart`'s `bodyKind` branch. The chat shell already
  carries app/project/runtime data attributes (`src/http/chat.ts:408-412`).
- `findApp` resolves an app by project id and app key from the live registry
  (`src/http/apps.ts:14-31`); `toManagedApp` maps it to the manager shape (`:47-62`).
- The app container is created with a read-only root, `cap_drop: ALL`,
  `no-new-privileges:true`, uid `1000:1000`, only the app directory and per-app agents root
  bind-mounted, its own bridge network, and no `ExposedPorts`/`PortBindings`
  (`src/runner/server.ts:708-742`, `src/runner/docker.ts:817-868`). This stage does not change that
  envelope.
- No security headers are emitted by the coordinator and no CSP/XFO/HSTS/COOP/COEP exists in
  `src/` or `assets/`; the `/ide` proxy forwards upstream headers verbatim
  (`src/http/server.ts:103-107`). A preview response therefore starts from a header-free coordinator
  baseline.

## 4. Decisions

### D1 - Path-based coordinator proxy, not host ports or a preview origin

Chosen: `/preview/<projectId>/<appKey>/<key>/...` is an early branch in `createHttpServer`, like
`/ide` (`src/http/server.ts:119-132`), with a matching branch in the upgrade listener
(`:235-260`). The target is the app container on its per-app network and the declared port; the
original path is forwarded unchanged so the app can be mounted at the preview base.

Rejected alternatives:

- **Host-published ports through the runner.** The runner is the only Docker socket holder, so this
  would mean adding `ExposedPorts`/`PortBindings`, a new spec field, validation, collision policy,
  and spec-hash semantics to `src/runner/server.ts`, `src/runner/docker.ts`, `src/agent/spec.ts`,
  and `src/runner/validate.ts`. It also breaks the documented "no published ports" invariant
  (`docs/design/agent-runtime.md:206-211`, `:291-300`), the single-front-door property, and the
  trusted-LAN/tunnel deployment model. It is the right tool for non-HTTP protocols, not for a
  "look at this UI" demo.
- **A separate preview origin (wildcard subdomain).** It would remove the same-origin risk and the
  base-path constraint, but it adds wildcard DNS and wildcard TLS to every deployment. The owner
  explicitly rejected that operational cost for this stage.
- **Do nothing.** The agent must deploy outside Hanse or ask the operator to run the app locally;
  the demo loop stays broken.

### D2 - In-memory, app-scoped registry with lazy expiry

New `PreviewService` keyed by `appId` and then by `key`. A record holds `projectId`, `appKey`, `key`,
`name`, `port`, `targetHost`, `createdAt`, and `expiresAt`. `targetHost` is the app container name
(`appContainerName(appId)`), fixed for the app's lifetime; a restart clears the record, so a stale
host cannot survive. The service has no database, no file, and no timer: `list`, `get`, and `open`
prune
expired records before acting, and the max-8 bound applies after pruning. A 2-hour absolute TTL is
enough for a demo session and bounds memory without a background sweep. A `dispose`/`clearAll` hook
is provided for tests and coordinator shutdown.

Rejected alternatives: a SQLite table (persistence is a non-goal and would add a migration); a
per-session registry (the operator expects the preview to survive chat-session switches, and the
feature is app-scoped by requirement AP2); a background TTL timer (lazy pruning is simpler and
deterministic in tests).

### D3 - Target resolution is server-derived; the tool supplies only a port

`preview_open` does **not** accept a host, URL, container name, or network. It accepts a port. The
coordinator derives the target host from the verified agent identity: `appContainerName(appId)`
(`src/runner/names.ts:28-30`), which is the app's own container on its per-app network. The tool
cannot choose a host, and the host is not read from a caller-controlled field.

The feature is enabled **only in runner mode**, when the coordinator is wired to the runner
(`HANSE_RUNNER_URL` / `deps.runner`). In supervisor mode `preview_open` returns
`preview_unavailable` and no preview route is registered. This removes the shared-host/loopback
ambiguity: in runner mode the target host is the app's own container, so the proxy cannot reach
another app, the supervisor host, or metadata. The supervisor fallback remains a local development
mode without previews in this stage.

Port policy: integer `1024..65535`, except `4100` (the opencode control port, which has its own basic
auth and must not be exposed through the preview surface). Ports below 1024 are rejected with a clear
message even though the app's uid 1000 cannot bind them. The `4101..4199` supervisor pool is not in
scope because supervisor mode is disabled for this feature.

### D4 - MCP tools are additive and app-token bound

Add `preview_open`, `preview_close`, and `preview_list` to the non-master MCP surface. They are
advertised in `tools/list` only when `options.previews` is configured, and dispatched before the
`ssh_` prefix fallback. They use the same `textResult` JSON envelope as the SSH and app-skill tools
(`src/mcp/ssh-protocol.ts:50-52`). The master branch never receives them.

The tool descriptions carry the operational contract. Call `preview_open` first to obtain the base
paths, start the service under them, bind it to `0.0.0.0`, and call `preview_open` again with the
same key to refresh the name/port after the service is listening. `preview_open` is idempotent per
key. Per framework:

- **Vite:** `base = base_path` (with trailing slash); `server.allowedHosts: true` or
  `operator_hostname`.
- **Next:** `basePath = base_path_without_trailing_slash`; `trailingSlash: true`;
  `allowedDevOrigins: [operator_hostname]` or the framework's supported wildcard.
- **Generic:** serve under `base_path` with relative asset URLs; a root-absolute `/assets/...`
  remains unsupported.

When `operator_host` is `null` (the operator has not loaded the chat page in this coordinator
process), the agent must use the framework's permissive dev-origin setting or ask the operator; the
preview may still work for Vite with `allowedHosts: true`, but Next's dev asset check may block it.
The tool description states this limitation.

When previews are not configured (supervisor mode), the MCP layer intercepts the three preview tool
names and returns `{ok:false, code:"preview_unavailable"}`; it must not fall through to the generic
unknown-tool path. The master branch still has its own allowlist and never sees these tools.

### D5 - The proxy is a hardened stream, not a copy of `proxyHttp`

New `proxyPreviewHttp`/`proxyPreviewUpgrade` functions (likely
`src/http/preview-proxy.ts`) reuse the stream shape of `proxyHttp` but apply the following contract:

- **Request headers.** Copy the request headers except `cookie`, `authorization`,
  `proxy-authorization`, and hop-by-hop headers (`connection`, `keep-alive`, `proxy-authenticate`,
  `te`, `trailer`, `transfer-encoding`, `upgrade`). Keep the original `Host` so the app sees the
  public host, and add `X-Forwarded-Host` (the original `Host`), `X-Forwarded-Prefix` (the base path
  **with** the trailing slash), and `X-Forwarded-Proto` (from the incoming `x-forwarded-proto` when
  present, else `http`). Keep `origin`/`referer`; the app's dev server may check them.
- **Body and response.** Stream both directions with `request.pipe(upstream)` and
  `upstreamResponse.pipe(response)`. No 64 KiB cap, no buffering, no content-length assumptions. The
  early route runs before `readBody`, exactly like `/ide`.
- **Path.** Forward the original path and query **unchanged**. The app is mounted at `base_path`, so
  it must receive the full `/preview/...` path; the proxy does not strip the prefix. The route
  segments are parsed only to resolve the preview record.
- **Response headers.** Drop origin-wide headers from the app: `set-cookie`, `clear-site-data`,
  `service-worker-allowed`, `strict-transport-security`, `alt-svc`, `report-to`,
  `reporting-endpoints`, `nel`, `www-authenticate`, and hop-by-hop headers. Leave per-document
  headers (CSP, `x-frame-options`, COOP/COEP/CORP, `permissions-policy`) alone; they only affect the
  previewed document. This asymmetry is deliberate: the app must not be able to overwrite or clear
  the operator session, widen a service-worker scope, or trigger a credential prompt on the
  coordinator origin, but it may constrain its own document.
- **Location.** Parse the `Location` value as a path plus optional query/fragment. If it starts with
  a single `/` but not `//`, and the path is not exactly the base and does not start with the base
  plus `/` (for both base spellings, requiring a **segment boundary**), prefix **only the path
  component** with the base; preserve the query and fragment unchanged. Leave protocol-relative
  (`//host/...`), relative, and absolute locations untouched. This means `Location` equal to the
  base with or without a slash is not double-prefixed, and a sibling path such as
  `/preview/<p>/<a>/<k2>` is not mistaken for the base. Absolute locations that point at the
  container URL are left as the app sent them; an unreachable target is accepted app behavior.
- **Trailing slash.** `/preview/<project>/<app>/<key>` redirects (302) to the same URL with a
  trailing slash, preserving the query. The base path always ends with `/`, and the app receives it.
- **Errors.** Unknown/expired preview -> 404 HTML page. App not running or upstream connection
  refused -> 502 HTML page with a "start the service" hint. If an upstream HTTP response is a `101`
  on a normal (non-upgrade) request, destroy the request and return 502; never forward a `101`
  through the normal response path. Upstream error after headers are sent -> end the response; do not
  try to write a second status. No proxy-specific timeout or connection cap in the MVP; Node's server
  defaults and the browser govern long-lived streams. This is an accepted demo residual (the route is
  human-authenticated).
- **WebSocket.** The upgrade branch checks auth, then preview resolution, then Origin, then
  connects: missing/invalid auth -> 401 handshake and destroy; unknown/expired preview -> 404
  handshake and destroy; if `Origin` is present and its host does not equal `Host` (or is the literal
  `null`), -> 403 handshake and destroy; an absent `Origin` is allowed for non-browser clients. It
  strips credential headers (`cookie`, `authorization`, `proxy-authorization`), keeps `Host` and the
  handshake headers, forwards the full path (no prefix strip), connects to the target host/port with
  `net.connect`, and replays the request line and remaining raw headers. After the request headers,
  it writes the client `head` buffer to the upstream, matching `/ide`
  (`src/http/server.ts:252-254`).

  The upstream **response** handshake is buffered until `\r\n\r\n`, with a **64 KiB cap**. If the
  delimiter is not found within the cap, the proxy sends a 502 handshake (or destroys both sockets)
  and **never pipes unfiltered bytes**. The header block is parsed, header names are lowercased, the
  name/value pairs are filtered against an **allowlist**, obs-fold/CRLF continuations are rejected,
  and the headers are regenerated from the parsed name/value pairs. Forward only `connection`,
  `upgrade`, `sec-websocket-accept`, `sec-websocket-protocol`, and `sec-websocket-extensions`; every
  other upstream header is dropped, including all origin-wide and session headers (`set-cookie`,
  `clear-site-data`, `service-worker-allowed`, HSTS, `alt-svc`, `report-to`,
  `reporting-endpoints`, `nel`, `www-authenticate`). If the upstream status is not 101, the proxy
  sends a 502 handshake and destroys both sockets; it does not forward a non-101 response. After the
  filtered 101, the remaining bytes are piped both ways. This is a preview-only hardening; the
  existing `/ide` and terminal upgrades are unchanged.

### D6 - Base-path contract, no HTML rewriting

The tool returns `base_path` with a trailing slash (`/preview/<projectId>/<appKey>/<key>/`) and
`base_path_without_trailing_slash`. The proxy forwards the full path unchanged, so the app's router
sees the base prefix and serves its assets under it; this is why the proxy no longer strips the
prefix. The per-framework contract is:

- **Vite:** `base = base_path` (trailing slash required); `server.allowedHosts: true` or
  `operator_hostname`.
- **Next:** `basePath = base_path_without_trailing_slash` (Next rejects a trailing slash) and
  `trailingSlash: true` (so Next accepts the proxy's trailing-slash URL and does not redirect back
  to the no-slash form); set `allowedDevOrigins` to `operator_hostname` (or the supported wildcard)
  so Next's dev asset check allows the coordinator origin.
- **Generic:** serve under `base_path` with relative asset URLs.

The proxy's trailing-slash 302 and the `Location` rewrite treat both base spellings as already
prefixed, so Next's default canonicalization cannot create a redirect loop when `trailingSlash:
true` is set. The proxy does not rewrite HTML, CSS, JS, or `index.html`; an app that ignores its base
and emits a root-absolute `/assets/...` reference will hit the coordinator and return 404 or
coordinator content. If `operator_host` is null, the agent uses the framework's permissive dev-origin
setting or asks the operator; this is stated in the tool description and in the docs.

### D7 - Operator UI: tool card action plus a conditional rail block

The chat tool card for `hanse_preview_open` (and the unprefixed `preview_open` fallback) renders an
"Open preview" action only when the part is completed and the JSON output is a success. The right
context rail renders a "Previews" section with one row per active preview, app-scoped, newest first;
the section and its divider are absent when there are no previews. The operator can close a preview
from the rail. The rail refreshes after a preview tool part completes and on a low-frequency
visibility-aware poll; no new SSE frame is required. The exact markup, copy, states, accessibility,
responsive behavior, and browser QA are specified in §8.

### D8 - Same-origin risk is accepted for the MVP, with mandatory guards

A path-based preview is served from the coordinator's origin. The previewed app's JavaScript can
therefore call same-origin coordinator APIs with the operator's cookie; `HttpOnly` does not help, and
most mutating endpoints rely on `SameSite=Strict` rather than an Origin check. The owner explicitly
accepted this residual risk for a demo feature. The following guards are mandatory, not optional:
never forward the operator cookie/authorization to the app; drop `set-cookie`, `clear-site-data`,
`service-worker-allowed`, HSTS, `alt-svc`, `report-to`, `reporting-endpoints`, `nel`, and
`www-authenticate` from app responses; `rel="noopener noreferrer"` on every preview link; no
auto-open; a persistent demo warning in the rail and on the tool card; human-only auth on the
preview route and the list/close API. The residual risk (same-origin API calls, `window.open` to
coordinator pages, access to coordinator `localStorage`, the app's ability to write a non-HttpOnly `hanse_token` cookie directly or call
`/logout` from its own JavaScript, and the operator-facing host value returned as `operator_host`
guidance) is documented and accepted;
dropping `Set-Cookie` only blocks the response-header path, not direct cookie writes. It cannot be
removed without a separate origin or a sandboxed iframe, which are non-goals for this stage. This
feature must not be described as a security boundary in docs or UI.

### D9 - No database, no dependency, no runner change

The stage adds one in-memory service, one MCP protocol module, one HTTP API module, one proxy module,
and chat UI changes. The service lives in a neutral `src/preview/` module with no HTTP or manager
imports; `InstanceManager` depends on its interface, not the other way around. It adds no migration,
no npm dependency, and no Docker/runner/agent-spec changes. Existing agents need a restart to see the
new tools; no image rebuild is needed. Existing tests that build `HttpDeps` without the preview
service keep compiling because the dependency is optional and the routes return 503/404 only when it
is absent.

## 5. Interfaces

### 5.1 MCP tools

```jsonc
// preview_open
{
  "key": "web",          // 1..32 lowercase slug: [a-z0-9][a-z0-9-]{0,31}; unique per app
  "name": "Storefront",   // 1..64 printable ASCII (0x20-0x7E), no control/format characters
  "port": 3000            // integer 1024..65535, not 4100
}
// result (text content is JSON)
{
  "ok": true,
  "preview": {
    "key": "web",
    "name": "Storefront",
    "port": 3000,
    "url": "/preview/<projectId>/<appKey>/web/",
    "base_path": "/preview/<projectId>/<appKey>/web/",
    "base_path_without_trailing_slash": "/preview/<projectId>/<appKey>/web",
    "operator_host": "192.0.2.10:8787", // null when the operator has not loaded this app's chat
    "operator_hostname": "192.0.2.10",  // normalized: port and IPv6 brackets stripped
    "expires_at": "2026-10-23T18:00:00.000Z"
  }
}

// preview_close
{ "key": "web" }
// result
{ "ok": true, "closed": true }

// preview_list
{}
// result
{ "ok": true, "previews": [ { "key": "web", "name": "Storefront", "port": 3000, "url": "...", "expires_at": "..." } ] }
```

Exact input schemas: `preview_open` requires `key`, `name`, and `port` with the constraints above;
`preview_close` requires `key`; `preview_list` takes no arguments. The JSON schema carries
`required`, the key `pattern`, the name `minLength`/`maxLength`, and the port integer bounds, and the
handler re-validates all three at the boundary.

The result carries two base spellings for framework configuration: `base_path` ends with `/` (Vite
`base`, relative-asset apps) and `base_path_without_trailing_slash` is the same path without it
(Next `basePath`). `operator_host` is the `Host` header from the most recent human chat page for the
app, captured in memory; `operator_hostname` is the same value normalized for framework allowlists
(port and IPv6 brackets stripped); both are `null` when unknown. They are guidance for framework
dev-origin allowlists, never authorization inputs. `operator_host` is app-visible host information;
this is an accepted demo residual (D8).

Failures use the existing `{ok:false, code, message}` text envelope. Codes:
`preview_invalid_key`, `preview_invalid_name`, `preview_invalid_port`, `preview_reserved_port`,
`preview_limit`, `preview_app_not_running`, `preview_unavailable`, `preview_internal_error`.
`preview_close` is idempotent: an unknown/expired key returns `{ok:true, closed:false}`. When the
preview service or the manager is not configured (supervisor mode or an embed without a runtime),
the MCP layer still recognizes the three names and returns
`{ok:false, code:"preview_unavailable"}`; it does not fall through to the generic unknown-tool path.

### 5.2 Human-only HTTP API

- `GET /api/apps/:app/previews?project=<projectId>` -> `200 {previews:[...]}`. Human-only; app-scoped;
  newest first; expired records pruned before the response.
- `POST /api/apps/:app/previews/:key/close?project=<projectId>` -> `200 {ok:true, closed:boolean}`.
  Human-only; idempotent. A cross-site `Origin`, when present, is rejected with the same
  `Origin`/`Host` comparison used by deletion and skill mutations (`src/http/deletion.ts:129-148`,
  `src/skills.ts:509-529`).
- `project` is **required** on both routes. A missing project returns `400 {code:"project_required"}`
  rather than calling `findApp` with an undefined project, which would pick the first app with the
  same key across projects. An unknown project/app returns `404 {code:"unknown_app"}`. Missing human
  principal returns `401`. A preview service that is not configured returns
  `503 {code:"preview_unavailable"}`.

### 5.3 Proxy route

- `GET/HEAD /preview/<projectId>/<appKey>/<key>` -> `302` to the trailing-slash URL.
- `ANY /preview/<projectId>/<appKey>/<key>/<rest>?<query>` -> proxy.
- Auth: `isHumanCookie`; GET/HEAD without a cookie -> `302 /login?next=...`; other methods without a
  cookie -> `401` JSON `{error:"sign in required", code:"preview_auth_required"}`. This differs from
  `/ide`'s unconditional redirect because a dev server's `fetch`/form POST should not receive an HTML
  login page.
- Resolution: decode the three segments, `findApp(deps, projectId, appKey)`, then
  `previews.get(app.id, key)`. If either is missing, or the record's project/app do not match the
  resolved app, return a 404 HTML page. This double check prevents a stale registry entry from
  crossing an app identity.
- Target: `http://<preview.targetHost>:<preview.port>`, with the original path and query forwarded
  unchanged. `targetHost` is `appContainerName(appId)`, derived from the verified app identity; the
  feature is runner-mode only. The app is responsible for its own routing under the base path.

### 5.4 Pages and status codes

| Condition | Response |
| --- | --- |
| No cookie on GET/HEAD | 302 to `/login?next=<preview path+query>` |
| No cookie on other methods | 401 JSON `preview_auth_required` |
| Unknown/expired preview or app | 404 HTML "Preview not found or expired" |
| HTTP app not running / upstream refused | 502 HTML "Preview unavailable; the service may have stopped" |
| HTTP upstream status | Passed through unchanged (3xx, 4xx, 5xx) |
| HTTP upstream returns `101` on a normal request | 502; destroy; never forward the `101` |
| Body larger than 64 KiB | Streamed; no 413 from the coordinator |
| WebSocket upgrade without cookie | 401 handshake, then destroy |
| WebSocket upgrade for an unknown preview | 404 handshake, then destroy |
| WebSocket upgrade with a mismatched `Origin` host (or `Origin: null`) | 403 handshake, then destroy |
| WebSocket upstream non-101 or connection refused | 502 handshake, then destroy |

The table covers the `/preview` proxy and upgrade routes only. The human list/close API statuses are
in §5.2, including `400 project_required`, `403` for a cross-site close, and
`503 preview_unavailable` when the service is not configured.

## 6. Lifecycle and failure modes

- **Open.** `preview_open` validates the key/name/port, checks that the runner is configured,
  checks `manager.isRunning(appId)`, derives `appContainerName(appId)`, prunes expired records,
  enforces the max-8 bound, upserts the record, and returns the URL/base path. After the insert it
  re-checks `manager.isRunning(appId)`; if the app stopped in the race, it removes the record and
  returns `preview_app_not_running`. The service does not probe the port; the agent is instructed to
  call after the service is listening, and to call again (idempotent) to refresh. A not-yet-listening
  service is a 502 on first click, not an open failure. In supervisor mode the tool returns
  `preview_unavailable` before any record is created.
- **Operator host.** `handleChat`, after `humanFrom` and `findApp`, calls
  `PreviewService.recordOperatorHost(app.id, request.host)` for a human `GET /chat`;
  `preview_open` returns `operator_host` and the normalized `operator_hostname`. It is used only for
  framework dev-origin allowlists and is never an authorization input. The latest chat page load
  overwrites it per app; `clearApp` on stop/deletion removes the entry; it is lost on a coordinator
  restart, and `null` means the agent falls back to the framework's permissive dev-origin setting or
  asks the operator. The app agent can see this host value; that is an accepted demo residual (D8).
- **List.** `preview_list` and the human API return the caller's/app's records after pruning.
- **Close.** Agent or operator removes the record. The service is untouched; the agent stops it if
  desired.
- **Expiry.** 2 hours absolute. Any `get`/`list`/`open` prunes. The proxy returns 404 for an expired
  key; the rail poll removes the row.
- **App stop/restart.** `InstanceManager` clears the app's previews in `stopApp`,
  `stopForDeletion`, `#stopLocked`, `restartIfRunning`, `#restartLocked`, `#forgetRunning`, the
  out-of-band-stop branch of `#reconcileStatuses`, and `#ensureLocked` before its
  `runtime.delete`/recreate path. A restart is a new container; old previews cannot survive. The
  manager receives the `PreviewService` as an optional dependency, and clears it at those points; the
  HTTP/MCP surfaces share the same instance. The service lives in a neutral `src/preview/` module
  with no HTTP or manager imports, so the manager depends on the interface without a layering cycle.
- **Deletion.** `stopForDeletion` clears the previews; the app rows and routes disappear with the
  app.
- **Coordinator restart.** In-memory registry is lost. The agent must call `preview_open` again; the
  rail is empty until then. This is documented, not repaired. The running check is
  `manager.isRunning`; after a restart `resumeRunning` repopulates it for resumable apps. If the app
  is running but the in-memory map is not populated, `preview_open` returns
  `preview_app_not_running`; start or restart the app and retry. This is a documented limitation, not
  a silent success.
- **App image rollback / settings restart.** Same as restart: previews are cleared.
- **MCP transport failure.** The agent sees the normal MCP transport error; the registry is
  unchanged.
- **Registry full.** The 9th distinct key returns `preview_limit`; the agent must `preview_close`
  another key. Re-opening an existing key is upsert and does not count as a new entry.
- **Upstream down.** The record remains until close/TTL; the operator sees a 502 page. The rail does
  not poll the service, so it keeps the button. This is intentional: the service may come back.

## 7. Threat model (STRIDE-lite)

**Assets.** The operator session (`hanse_token`), the coordinator APIs and UI origin, the app
container and its source, the host. **Actors.** The operator; the app agent and the code it writes;
a malicious page on another origin; a prompt-injected agent. **Trust boundaries.** Browser ->
coordinator (cookie auth); coordinator proxy -> app container (no credentials); app container ->
host (Docker envelope).

| Threat | Disposition |
| --- | --- |
| **Spoofing / privilege escalation** - previewed app JS calls same-origin coordinator APIs with the operator cookie. | Accepted for the MVP (D8). Guards: explicit click, demo warning, no auto-open, `noopener`, no credential forwarding. Residual: same-origin API calls, `window.open`, coordinator `localStorage`. Documented, not claimed as secure. |
| **Session fixation / cookie overwrite** - app sends `Set-Cookie: hanse_token=...` or `Clear-Site-Data`. | Mitigated: all app `set-cookie` and `clear-site-data` response headers are dropped on both HTTP and the WebSocket 101. Residual: same-origin JS can still write a non-HttpOnly `hanse_token` cookie directly or call `/logout`; accepted in D8. |
| **Service-worker scope escalation** - app sends `Service-Worker-Allowed: /`. | Mitigated: header dropped on both HTTP and the 101; a worker can still register under the preview path only. |
| **Origin-wide transport headers** - HSTS/Alt-Svc/Report-To/Reporting-Endpoints/NEL from the app. | Mitigated: dropped on both HTTP and the 101. |
| **Credential prompt / phishing** - app sends `WWW-Authenticate`. | Mitigated: dropped from HTTP responses and the 101. |
| **CSRF from the preview app** - same-origin `POST /api/...`. | Accepted residual (D8); same-origin makes Origin checks ineffective. Not fixable without a separate origin/sandbox. |
| **SSRF** - tool supplies a host/URL. | Mitigated by construction: the tool accepts only a port; the host is `appContainerName(appId)`; the port range excludes 4100. The feature is runner-mode only, so the host is the app's own container and another app, the host, or metadata is unreachable. Supervisor mode is disabled for previews (`preview_unavailable`), removing the shared-loopback ambiguity. |
| **Cross-app access** - open/list/close another app's preview. | Mitigated: MCP identity is the app token; the registry is keyed by `appId`; the HTTP API resolves the app and re-checks project/app; the tool accepts no target. |
| **Credential leakage to the app** | Mitigated: request `cookie`/`authorization`/`proxy-authorization` are stripped before the upstream; no header logging. |
| **Open redirect / path confusion** | The proxy prefixes only a single-slash root-relative `Location`; protocol-relative (`//host/...`), relative, and absolute locations are untouched. The preview URL is not a token and carries no secret. The app can navigate its own tab; accepted. |
| **Denial of service** | Max 8 records per app; lazy pruning; in-memory only. The proxy streams; there is no coordinator body cap. No proxy-specific timeout or connection cap in the MVP; the route is human-authenticated and Node/browser defaults apply. This is an accepted demo residual. |
| **WebSocket hijacking** | The handshake requires the `hanse_token` cookie, and the preview upgrade additionally requires the `Origin` host to equal `Host` when `Origin` is present (403 otherwise); absent Origin is allowed for non-browser clients. The upstream 101 response headers are filtered. `SameSite=Strict` remains defense in depth. |
| **XSS in the coordinator UI** | The preview is a separate top-level document; the coordinator does not embed app HTML in the chat page. The rail/tool card render only the agent-supplied `name`/`key`, escaped like every other server-rendered string, and the link href must be a same-origin path starting with `/preview/`; `javascript:` and cross-origin URLs are rejected. |
| **Master/tool-surface abuse** | The master branch has its own allowlist and never sees preview tools. |
| **Stale route after restart** | Previews are cleared on stop/restart/reconcile/ensure-recreate; the coordinator restart loses them; the proxy double-checks the app identity. |

## 8. UI/UX

Binding contract: [`DESIGN.md`](../../DESIGN.md) The Chart Room. No new color, type, space, radius,
shadow, or motion token. New classes compose existing tokens only; every new class is named in
§8.11 and must be added to `DESIGN.md` §5.16 before implementation.

### 8.1 Placement and hierarchy

Rail order at >= 1360 (top to bottom):

```text
Application
Previews            <- conditional; absent when empty
Context             (usage meter + compaction)
Plan
Saved permissions   <- existing conditional section
Handoffs
Shortcuts
```

Previews sits **above Context usage**, directly after Application. The rail reads identity ->
actions -> session telemetry -> references: Previews is app-scoped and action-bearing (it opens app
surfaces), so it belongs in the Application band, while Context and Plan are session telemetry. The
cost is that the first open moves Context down by at most the block's capped height; accepted because
the block is bounded (14rem, §8.3) and the operator just caused it. When the block is absent there is
no reserved gap, so Context returns to its normal position.

Below 1360 the context pane is the existing right drawer; the block is unchanged inside it. Below 768
both rails are full-height drawers; the block sits near the top of the drawer body (Application is
about 120px tall, so it is visible without scrolling), and opening the drawer does not auto-scroll to
it. The tool card (§8.6) remains the always-visible path, so the drawer is never the only way to open
a preview.

### 8.2 Empty state

There is no empty state, heading, or hint. The block **must not render**. Markup is a single hidden
wrapper that owns both the divider and the section:

```html
<div class="chat-context__group" id="chat-previews" hidden> ... <hr class="rule" /> + <section> ... </div>
```

The `<hr class="rule">` lives inside the wrapper, so hiding the wrapper removes divider and section
together; there is no code path that hides the section alone. The server **always renders the
wrapper** so JS has a stable mount point, and sets `hidden` only when the list is empty; when
previews exist at load the wrapper is rendered without `hidden`, so a no-JS page still shows the
links. JS keeps the same wrapper and, when the list empties (last close, expiry, or a list refresh
returning zero), sets `hidden`, clears the `<ul>`, and updates nothing else. The sketch above shows
the empty wrapper; with rows the `hidden` attribute is omitted. QA asserts no visible rule sits where
the block was (§9).

### 8.3 Preview row anatomy

A `<ul>` of **ruled ledger rows**, not cards: with up to 8 entries, per-row cards would be card soup.
Each row is two lines plus trailing actions.

- **Name** (primary): `--text-sm`, weight 500, `--text-1`, one line, ellipsis. Full value in `title`
  and in the link's accessible name (ellipsis is visual only).
- **Key** (secondary): `--text-mono-sm`, `--text-3`, second line, one line, ellipsis, `title` holds
  the full key. It disambiguates duplicate names.
- **Port: not shown.** It is container-internal; the operator only ever reaches the same-origin
  path, so a port would invite a connection that cannot work. The tool card also omits it.
- **Actions:** the name block is the open link; a close icon button is the only other control
  (§8.4, §8.5).

Ordering: **newest first**. A newly opened preview is inserted at the top; existing rows keep relative
order. Recency is the only useful order for ephemeral entries and it is what the operator just acted
on. Key is the tie-breaker for deterministic tests. Rows are keyed by `data-preview-key` and patched
in place, never rebuilt wholesale while a close button holds focus.

Height and overflow: `max-block-size: 14rem`, `overflow: auto`, `overscroll-behavior: contain` (the
Plan list precedent), plus the global thin scrollbar. One or two rows are plain; six to eight rows
scroll inside the rail with the header count (`8 active`) telling the operator there is more. The
rail body and the page never scroll horizontally.

### 8.4 Open action

Use a **link on the name block**, not a button:

```html
<a class="chat-preview__link" href="<PREVIEW_URL>" target="_blank" rel="noopener noreferrer">
  <span class="chat-preview__name">Storefront</span>
  <span class="chat-preview__key mono">storefront</span>
  [external icon]
  <span class="sr-only">(opens in a new tab)</span>
</a>
```

`<PREVIEW_URL>` is always the server-returned `preview.url` (from the tool result or the list API),
resolved same-origin; the client never constructs the path. Navigation is what it does, so it is an
`<a>`; the new tab keeps the chat draft, scroll, and stream alive. The trailing `external` glyph
(existing icon) marks the new tab, and the `sr-only` suffix names it for assistive tech. No "Open"
label: at 320px each row already carries a close control, and the rail's Handoffs/Application blocks
establish text-link rows.

The **whole row is not clickable**: the close button is a sibling, and wrapping the row in a link
would nest interactive elements and create an ambiguous hit target. `:focus-visible` uses the
standard 2px `--focus` ring at 2px offset, radius `--radius-sm`, on both the link and the close
button. DOM order is link then close per row.

### 8.5 Operator close

`btn btn-ghost btn-icon btn-sm` with the `x` icon, trailing, vertically centred,
`aria-label="Close preview <name>"`. Desktop 32px; below 768 the global button rule makes it 44px. It
is a plain button, not a menu or disclosure.

**No confirmation.** Closing is reversible at zero cost: the dev server keeps running and the agent
can call `preview_open` again. A modal for a side-effect-free, instantly re-creatable object would
violate the system's modal discipline; dialogs are reserved for semantic/destructive actions like
handoff approval.

In flight: `aria-busy="true"` and `disabled` on the close button; spinner only past ~1s (swap the `x`
for `.spinner`). The row and its link stay live; a click during close is harmless.

Success: remove the row immediately (no exit animation), patch the count, announce
`Preview closed: <name>.` via the existing `#chat-announcer`. If it was the last row, hide the wrapper
(§8.2) and then move focus to the next row's close button, else the previous row's close button, else
`#context-usage-title` (already `tabindex="-1"`, the next rail section). Never throw focus into the
thread.

`404` or `{ok:true, closed:false}` on close means it is already gone: remove the row silently, no
error. Other failures: re-enable
the button and append
`<p class="field-error chat-preview__error" role="alert">Could not close preview. Try again.</p>`
under the row (spans both columns). The row remains because the server still lists it. Retry is the
same button; the message clears on the next successful attempt or a list update. Inline, not a
toast: the failing object is on screen and toasts are for off-screen outcomes.

### 8.6 Tool-card button

Special-case `hanse_preview_open` (and bare `preview_open` when no server prefix is present) with the
same kind of exception `todowrite` and `question` already have: render a **static card**
(`article.tool-call.tool-call--preview`), not a `<details>`. The action is **always visible**, in the
card head/body, never inside `<summary>`: a button nested in `<summary>` is a nested interactive
whose activation can also toggle the disclosure, and an action hidden until expansion fails
discovery.

Show: `eye` glyph, mono tool name (`hanse_preview_open`), preview name, existing `toolStatusChip` in
the head; body row of mono key + `Open preview` (`btn btn-secondary btn-sm`, `external` icon,
`target="_blank" rel="noopener noreferrer"`) + the demo hint (§8.8).

The static card must keep the renderer's part-identity attributes: `data-message-id`, `data-part-id`,
`data-part-type`, and `data-tool-key`, in addition to `data-preview-key`. Add a dedicated
`createPartNode`/`updatePartNode` branch and an `updatePreviewCard` function; do **not** route the
static card through `updateToolPart`, which requires a `<summary>` and returns early when absent.
Without the identity attributes, `syncPartOrder` ignores the card and message reconciliation can
duplicate or reorder it.

Render the button **only** when `state.status === "completed"` and `state.output` parses as
`{ ok: true, preview: { key, name, url } }` with string `key`/`url`. Never while `pending`/`running`,
never on `error`, never for missing, non-JSON, `{ok:false}`, or partially-shaped output. Require
`preview.url` to start with `/preview/`, resolve it with `new URL(url, location.origin)`, and reject
anything cross-origin or non-prefixed; `javascript:` and cross-origin hrefs must never be rendered.
All strings go through `textContent`. Unparseable output falls back to the existing generic `pre`
body with no action. Normalize the tool name (strip a leading `hanse_`) before the
`toolGlyph`/`toolPreview` maps, or add both spellings, so the glyph and preview text work for
`hanse_preview_open` and `preview_open`.

The action is a live view of the list: when the key leaves the active previews (closed here, in
another session, or expired), remove the button and show `.caption` "Closed" so the feed never holds
a dead link. `updatePreviewCard` preserves focus when the focused element is inside the card (the
Open link); if that element is removed because the key left, move focus to the card's status text
(carrying `tabindex="-1"`) instead of dropping focus to `body`. The raw JSON is not shown for a successful open, matching the
structured-tool precedent.
`hanse_preview_close` stays a normal `.tool-call` disclosure with no button; add
`preview_open`/`preview_close` -> `eye` in `toolGlyph` and the preview lines from §8.9 to
`toolPreview`.

### 8.7 States

| State | Rail | Tool card | Retry |
| --- | --- | --- | --- |
| Ready | Row present, link + close | Static card, `Completed`, `Open preview` | n/a |
| Opening / registering | **No row**; the list is server-confirmed | `Running` chip, no button | n/a |
| Upstream 502 on click | Unchanged; **invisible in the rail** (navigation is a new tab) | Unchanged | 502 page offers `Reload` |
| Not found / expired (404) | Row may persist until the next list update; disappears then | `Closed` once the list drops the key | 404 page has no action |
| Limit reached (8) | No row (no success) | Normal error card, auto-open, no button | Re-run via the agent |
| Close in flight | Row stays, close busy/disabled | Unchanged | n/a |
| Close failed | Row stays, inline alert | Unchanged | Same button |
| Closed last | Wrapper hidden; no heading, no divider | `Closed` | n/a |

No upstream probing and no rail spinners: the rail reflects server-confirmed state only. A 502 or
404 that happens after the click is not observable in the rail because the response renders in the
new tab. The rail refreshes its list from the coordinator API after a preview tool part completes
and on a low-frequency visibility-aware poll, so an expiry or a close in another session eventually
removes the row; that is a cheap in-memory list call, not a probe of the dev server.

### 8.8 Demo warning

One `.hint` line, directly under the heading and above the list, plus the same sentence under the
tool card's action:

> Demo only. Preview pages share the coordinator's origin and session.

`--text-3`, no glyph, no status color, one instance per surface, **not dismissible**. The risk is
permanent for the feature; dismissal would hide it from the operator who needs it. Reject the `Demo`
badge + tooltip: a badge is not focusable, so its tooltip is unreachable by keyboard and touch, and
`DESIGN.md` treats tooltips as an enhancement. Reject a first-open inline notice for the rail: it
disappears, leaving the index unmarked.

### 8.9 Copy deck

| Surface | Copy |
| --- | --- |
| Rail heading | `Previews` |
| Rail count | `1 active` / `8 active` |
| Demo hint (rail and card) | `Demo only. Preview pages share the coordinator's origin and session.` |
| Open link suffix (sr-only) | `(opens in a new tab)` |
| Close accessible name | `Close preview <name>` |
| Close failure | `Could not close preview. Try again.` |
| Announcer, open | `Preview opened: <name>.` |
| Announcer, close | `Preview closed: <name>.` |
| Card action | `Open preview` |
| Card preview while running | `Opening preview…` |
| Card preview when completed | `<name>` |
| Card preview for close | `Closing <name>…` / `Closed <name>` |
| Card after the key leaves the list | `Closed` |
| 404 title / body | `Preview not found` / `This preview has expired or was closed. Open it again from the agent's message.` |
| 502 title / body / action | `Preview unavailable` / `The dev server is not responding. Start it in the agent, then reload.` / `Reload` |

There is no empty-state copy. No exclamation marks, no emoji.

### 8.10 Accessibility

- Landmark: the existing `<aside class="chat-context" aria-label="Context">`. The block is a
  `<section aria-labelledby="context-previews-title">` with `<h2 class="overline">Previews</h2>`.
- List semantics: `<ul>` + `<li>`. Because the list uses `list-style: none`, add `role="list"` to
  preserve list semantics in Safari/VoiceOver (same treatment for `.chat-previews`).
- Names: the link's accessible name is the full preview name plus `(opens in a new tab)`; the close
  button's name is `Close preview <name>`. Icon-only controls carry no visible text, so both labels
  are mandatory.
- Live regions: reuse the single `#chat-announcer` (polite, atomic) for one-shot open/close
  announcements. Do **not** put `aria-live` on the `<ul>` or the count; that would re-announce the
  list on every update.
- Focus: after close, next close button -> previous close button -> `#context-usage-title`. Keyboard
  order is heading, row link, close, next row link, close, then the Context section.
- Contrast: name `--text-1`, key `--text-3`, hint `--text-3`; all system-checked pairs, no new greys.
  The warning must not use `--danger`.
- Reduced motion: no new animation. Hover is the existing 110ms wash; row removal is instant.
- Progressive enhancement: the page is server-rendered; the close button is rendered `hidden` and JS
  removes `hidden` during hydration, so a no-JS page has working links and no dead control. Add
  `.chat-preview__close[hidden] { display: none; }` because `.btn` sets `display: inline-flex`.

### 8.11 Markup and classes sketch

```html
<div class="chat-context__group" id="chat-previews">  <!-- add hidden only when the list is empty -->
  <hr class="rule" />
  <section class="chat-context__section" aria-labelledby="context-previews-title">
    <div class="cluster summary-row">
      <h2 class="overline" id="context-previews-title">Previews</h2>
      <span class="caption" id="chat-previews-count">2 active</span>
    </div>
    <p class="hint">Demo only. Preview pages share the coordinator's origin and session.</p>
    <ul class="chat-previews" id="chat-previews-list" role="list">
      <li class="chat-preview" data-preview-key="storefront">
        <a class="chat-preview__link" href="<PREVIEW_URL>" target="_blank" rel="noopener noreferrer">
          <span class="chat-preview__name">Storefront</span>
          <span class="chat-preview__key mono">storefront</span>
          [external icon]
          <span class="sr-only">(opens in a new tab)</span>
        </a>
        <button class="btn btn-ghost btn-icon btn-sm chat-preview__close" type="button"
                aria-label="Close preview Storefront" hidden>[x icon]</button>
      </li>
    </ul>
  </section>
</div>
```

Tool card for a completed, parseable open:

```html
<article class="tool-call tool-call--preview"
         data-message-id="<MESSAGE_ID>" data-part-id="<PART_ID>"
         data-part-type="tool" data-tool-key="<TOOL_KEY>"
         data-preview-key="storefront">
  <div class="tool-call__head">
    [eye icon]
    <span class="mono">hanse_preview_open</span>
    <span class="tool-call__path" title="Storefront">Storefront</span>
    <span class="status" data-state="delivered">[check] Completed</span>
  </div>
  <div class="tool-call__preview">
    <span class="chat-preview__key mono">storefront</span>
    <a class="btn btn-secondary btn-sm" href="<PREVIEW_URL>" target="_blank" rel="noopener noreferrer">[external icon]Open preview</a>
  </div>
  <p class="hint tool-call__note">Demo only. Preview pages share the coordinator's origin and session.</p>
</article>
```

The four `data-*` identity attributes are mandatory. A dedicated `createPartNode`/`updatePartNode`
branch owns this static card and must not call `updateToolPart` (which expects a `<summary>`); the
card is still part of the normal message/part ordering and reconciliation.

New classes, each one line:

- `.chat-context__group` - flex-column wrapper that owns the preceding rule; `[hidden] { display: none; }`.
- `.chat-previews` - list reset; `max-block-size: 14rem`, `overflow: auto`, `overscroll-behavior: contain`.
- `.chat-preview` - row grid `minmax(0,1fr) auto`, centred, `border-block-end: 1px var(--line)`, last
  child no border, 4px block padding.
- `.chat-preview__link` - two-column/two-row grid, `min-inline-size: 0`, `min-block-size: 2rem`
  (2.75rem below 768), 4px inline padding, `--radius-sm`, hover `--wash-1`.
- `.chat-preview__name` - `--text-sm`, 500, `--text-1`, single-line ellipsis.
- `.chat-preview__key` - `--text-mono-sm`, `--text-3`, single-line ellipsis.
- `.chat-preview__close` - `align-self: center; flex: none;` and the `[hidden]` rule above.
- `.chat-preview__error` - `grid-column: 1 / -1;` (error color comes from `.field-error`).
- `.tool-call--preview` - the `.tool-call` surface without disclosure behavior.
- `.tool-call__head` - static clone of `.tool-call summary` (flex, 32px min, 12px padding, 8px gap).
- `.tool-call__preview` - wrapping flex action row with 12px inline padding; the key flexes and
  ellipsizes.
- `.tool-call__note` - `.hint` with 12px inline padding and 10px bottom padding.

### 8.12 Responsive behavior

| Width | Behavior |
| --- | --- |
| 1440 | Three panes; block in the 320px rail. Eight rows scroll inside 14rem; count shows the total. |
| 1024-1359 | Context is the right drawer; block identical, rail body scrolls independently, no page scroll. |
| 768-1023 | Same drawer; row targets stay 32px until 768. Long names and keys ellipsize, no horizontal overflow. |
| 390 | Both rails are drawers at `--pane-drawer-w`; 44px row targets; the list keeps its 14rem cap and scrolls internally (`overscroll-behavior: contain` stops the drawer from dragging). The tool card fits: the key shrinks and ellipsizes, the button keeps `white-space: nowrap`, and nothing exceeds the feed width. |

### 8.13 Browser QA and evidence

Extend the deterministic fixture style of [`chat-qa.mjs`](./chat-qa.mjs) (route interception of
`/api/apps/**`, fake `EventSource`, JSON report, non-zero exit on failure) with a previews fixture.
Screenshots to `artifacts/previews/`:

- `previews-{1440,390}-{dark,light}`, `previews-empty-{1440,390}`,
  `previews-8-1440-{dark,light}`, `previews-long-name-390-dark`,
  `previews-close-error-1440-dark`, `previews-close-busy-1440-dark`,
  `preview-card-{completed,running,error,unparseable}-1440-dark`,
  `preview-404-1440-dark`, `preview-502-1440-dark`.

Assertions:

1. Empty (server render and after JS refresh): `#chat-previews` has no layout box, no `Previews`
   heading is visible, and the visible `.rule` count beside Handoffs is unchanged (no orphan
   divider).
2. 1/3/8 previews: count text matches row count; with 8, the list's `scrollHeight > clientHeight` and
   `clientHeight <= 14rem`; `scrollWidth === clientWidth` on the rail body and the document.
3. Long 40-char name and a 32-char key (the key maximum): link `scrollWidth <= clientWidth`, `title`
   equals the full string, no page overflow.
4. Close last: click, row leaves, wrapper hidden, `#chat-previews hr` is not rendered, focus is on
   `#context-usage-title`, announcer text is `Preview closed: <name>.`
5. Close `500`: inline alert visible, row remains, button re-enabled, no toast. Close `404`: row
   removed, no alert.
6. Tool card: `completed` + `{ok:true,preview}` shows the button; `running`, `error`, `"not json"`,
   `{ok:false}`, and a missing `preview.url` show no button and raise no console error.
7. Keyboard: Tab order heading -> link -> close -> next row; focus-visible ring captured on both;
   Enter on close follows the focus rule.
8. No console or page errors across every state; run 390 and 1440 in both themes.
9. No-JS SSR: with previews, the wrapper is present and not hidden, rows and links are visible, and
   the close button is hidden; when empty, the wrapper is hidden.
10. `preview.url` validation: a cross-origin or `javascript:` fixture URL is not rendered as an
    `href`; no console error.
11. Close `{ok:true, closed:false}` removes the row exactly like a 404.
12. Card focus: when the key leaves the list and the Open link is removed while focused, focus moves
    to the card's `tabindex="-1"` status text, not to `body`.

### 8.14 Resolved UI choices

The visual-engineering pass left three defaults; the architect adopts them for this stage:

1. **Rail position** - above Context usage, per the banding in §8.1. Moving it below Context is a
   one-entry reorder if the owner later values a stable meter more than the app-group semantics.
2. **Warning form** - one `.hint` line on both surfaces. A `Demo` badge plus tooltip is weaker for
   keyboard and touch and is rejected.
3. **Port visibility** - hidden everywhere in the UI. If the operator later wants it for debugging,
   add it only to the card body, never to the rail row.

## 9. Testing and QA

- **Unit (`test/preview-service.test.ts`).** Key/name/port validation; 4100 rejection; max 8;
  upsert; lazy expiry with an injected clock; clear by app; target host is `appContainerName(appId)`
  and never caller-supplied; close idempotence; `closed:false` for an unknown key.
- **MCP (`test/preview-mcp.test.ts` or `test/mcp-http.test.ts`).** `tools/list` includes the three
  tools only when configured; the master list does not; calls are scoped to the agent's app;
  `preview_open` rejects a non-running app; supervisor mode returns `preview_unavailable` instead of
  falling through to unknown-tool; `preview_close`/`preview_list` round-trip; full input-schema
  validation; error codes; `operator_host`/`operator_hostname` are null when unknown and reflect the
  latest human chat-page host per app.
- **Human API (`test/preview-http.test.ts`).** Human-only list/close; agent token rejected;
  `project` is required (`400 project_required`); an app key that exists in two projects resolves
  only with the project; unknown app 404; missing service 503; close idempotence; Origin rejection
  on a cross-site close.
- **Proxy (`test/preview-proxy.test.ts`).** Early route before `readBody`; **full path and query
  forwarded unchanged** (the upstream sees `/preview/.../assets/...`, not `/assets/...`); the proxy
  takes a `resolveTarget` seam so tests inject a fake host/port while production uses
  `appContainerName`;
  trailing-slash 302 with query preserved; no-cookie 302/401; unknown/expired 404; upstream status
  passthrough; upstream refusal 502; cookie/authorization/proxy-authorization not forwarded; the
  original `Host` is kept and `X-Forwarded-Host`/`X-Forwarded-Prefix`/`X-Forwarded-Proto` are added;
  `set-cookie`/`clear-site-data`/`service-worker-allowed`/`www-authenticate`/`reporting-endpoints`/
  HSTS/Alt-Svc/Report-To/NEL dropped; a single-slash `Location` prefixed with query/fragment
  preserved, `//host/...` and absolute locations left untouched, a base-without-slash `Location`
  not double-prefixed, and a sibling `.../<k2>` not mistaken for the base; a streaming response is
  not buffered (a small upstream that writes two chunks with a delay); an upstream `101` on a normal
  HTTP request produces 502 and is never forwarded; WebSocket upgrade auth, credential stripping,
  full path, and the Origin check (mismatch 403, `Origin: null` 403, absent Origin allowed);
  **101 response headers filtered** (`set-cookie`/`clear-site-data`/`www-authenticate`/HSTS/Alt-Svc/
  Report-To/Reporting-Endpoints/NEL removed; `connection`/`upgrade`/`sec-websocket-accept`/
  `sec-websocket-protocol`/`sec-websocket-extensions` preserved; obs-fold/CRLF rejected); a
  non-101 upstream response, an upstream connection refusal, and a >64 KiB header block each produce
  a 502 and never pipe unfiltered bytes; the client `head` buffer is forwarded.
- **Lifecycle (`test/manager.test.ts` and/or `test/preview-service.test.ts`).** A stop, restart,
  deletion, out-of-band reconcile, and `#ensureLocked` recreate each clear the app's previews; an
  open/stop race leaves no record (the post-insert re-check removes it).
- **Chat page (`test/chat-page.test.ts`).** The wrapper is always rendered; hidden only when empty;
  present with one/multiple previews; correct links/`rel`; escaped names; the close button is hidden
  for no-JS; the static tool card carries `data-message-id`/`data-part-id`/`data-part-type`/
  `data-tool-key`; the card gets an action only for a completed success result and never for a
  cross-origin/`javascript:` URL; a human `GET /chat` records `operator_host`/`operator_hostname`
  per app, the latest load wins, a non-human request records nothing, and the value is null before
  any chat load. Stop/deletion clears the host entry alongside the previews.
- **Browser QA.** Extend the existing Playwright-style harness (`docs/design/chat-qa.mjs`) or add a
  small `docs/design/preview-qa.mjs` covering: empty rail, 1/3/8 previews, long name, close-last
  removes the section and divider, no-JS SSR, `preview.url` validation, `closed:false`, tool card
  action only on success, card focus after the key leaves the list (`tabindex="-1"` status text),
  keyboard focus, 390/768/1440 dark/light, no console/page errors. The exact assertions come from
  §8.13.
- **Verification.** `npm run lint`, `npm run typecheck`, `npm test`, `npm run build`.

## 10. Rollout and compatibility

- Additive MCP tools and additive routes; no schema change and no migration.
- The feature is runner-mode only. The preview service is constructed only when `HANSE_RUNNER_URL`
  is configured; supervisor mode returns `preview_unavailable`, registers no `/preview` proxy or
  upgrade route, and the list/close API routes return `503 preview_unavailable`. This is the
  production topology; the local supervisor fallback remains preview-free in this stage.
- The coordinator must be restarted to load the new code; existing agents must be restarted to see
  the new tools (MCP `tools/list` is read at agent start). No image rebuild.
- The chat assets are served from `assets/`; the CSS build (`npm run build:css` / `npm run build`)
  must include the new classes.
- `docs/current-state.md` gains an "App previews (demo)" section; `docs/design/README.md` and
  `docs/plans/README.md` gain index entries; the stage journal records the accepted same-origin risk
  and the base-path limitation.
- The preview Origin check assumes the front reverse proxy preserves the original `Host` header. If it
  rewrites `Host`, a legitimate same-origin WebSocket handshake can be rejected; configure the front
  proxy to preserve `Host` (or add an explicit allowed-origin setting in a later stage).
- No deployment-specific values are added to tracked files. No host ports, DNS, or TLS changes.

## 11. Non-goals

- No host port publishing, no wildcard subdomain, no separate preview origin, no TLS/DNS work.
- No cross-application networking; front and back apps in separate containers remain isolated.
- No non-HTTP protocols other than WebSocket; no arbitrary TCP tunnel.
- No persistence across a coordinator restart; no SQLite table.
- No HTML/CSS/JS rewriting and no transparent base-path injection.
- No authentication of the previewed app; it runs inside the operator's Hanse session. The proxy
  drops `Set-Cookie` from app responses, but same-origin app JavaScript can still write a
  non-HttpOnly `hanse_token` cookie directly or call `/logout`; same-origin `localStorage` is also
  shared with the coordinator. These are accepted limitations of the demo (D8).
- No supervisor-mode previews; the feature is unavailable when the coordinator is not wired to the
  runner.
- No sandboxed iframe, CSP sandbox, or per-preview capability token in this stage.
- No per-app opt-in flag, RBAC, multi-user, or audit table.
- No preview of port 4100 or any opencode control endpoint.
- No master-agent preview tools.
- No preview UI on the application page; the chat rail and tool card are the only surfaces in this
  stage.

## 12. Owner decisions and open questions

Resolved by the owner on 2026-10-23, before the plan:

1. **Routing** - path-based, demo-only; wildcard/subdomain and host-port publishing are rejected for
   this stage.
2. **Same-origin risk** - accepted for the MVP, with the mandatory guards in D8 and the demo warning
   in the UI. The residual risk is documented.
3. **TTL** - delegated to the architect. Decision: 2 hours absolute, lazy pruning, explicit close,
   and lifecycle clearing; no idle refresh, no background timer.
4. **Limit** - 8 previews per app.
5. **Operator close** - allowed from the rail, in addition to the agent's `preview_close`.
6. **Scope** - previews are app-scoped, not session-scoped; they remain visible across chat sessions
   of the same app.

7. **Runtime mode** - previews are enabled only in runner mode; supervisor mode returns
   `preview_unavailable` for this stage.

No open questions remain for this stage. Round 1 of the design review returned FAIL with four
blocking findings; all are folded in below. Re-review is pending before the plan is written.

## 13. Design review

### Round 1 - `oracle`, 2026-10-23 - **FAIL**

The review confirmed that the architecture fits the existing coordinator/MCP/proxy model, that the
shared service path is viable, that runner target resolution is correct, that cookie-only auth
follows the `/ide` precedent, and that the UI insertion points are feasible. It raised four blocking
findings and eighteen non-blocking findings.

**Blocking findings and resolution:**

| ID | Finding | Resolution |
| --- | --- | --- |
| B1 | The design stripped the preview prefix while requiring the app to be mounted at that base; Next `basePath` would 404 and Vite could redirect-loop. | Chosen full-path forwarding: the proxy forwards the original `/preview/...` path unchanged and the app serves under `base_path`. AP5, AP8, D1, D4, D5, D6, §5.3, §6, and the tool description now agree. |
| B2 | The WebSocket branch replayed the upstream 101 handshake raw, bypassing the response-header drop list. | The 101 response is buffered up to 64 KiB and filtered for origin-wide/session headers; handshake headers are preserved. A regression test is required. |
| B3 | The port policy excluded only 4100, but supervisor mode allocates 4101-4199 to other apps' control ports on a shared host. | The feature is runner-mode only; supervisor mode returns `preview_unavailable` and registers no route. The target host is `appContainerName(appId)`, not a loopback endpoint. |
| B4 | The static tool card markup omitted `data-message-id`/`data-part-id`/`data-part-type`/`data-tool-key`, so the chat renderer could not order or update it. | The card keeps all four identity attributes and gets a dedicated `createPartNode`/`updatePartNode` + `updatePreviewCard` branch; it is not routed through `updateToolPart`. |

**Non-blocking findings folded in:**

- N1 `Host` was both stripped and kept -> keep the original `Host`; `X-Forwarded-*` added.
- N2 Vite `allowedHosts` was not derivable -> the tool description now says `server.allowedHosts:
  true` or the coordinator host.
- N3 lifecycle missed `#ensureLocked` recreation and had an open/stop race -> clear before
  `runtime.delete`; re-check `isRunning` after insert.
- N4 "the app cannot set cookies" was false -> document direct same-origin cookie writes and
  `/logout` as accepted residual; `Set-Cookie` dropping only covers the response-header path.
- N5 `preview.url` was not validated -> require a `/preview/` same-origin path; reject
  `javascript:`/cross-origin.
- N6 drop list missed `WWW-Authenticate`/`Reporting-Endpoints` -> added to HTTP and 101 filtering.
- N7 protocol-relative `Location` was underspecified -> prefix only a single-slash root-relative
  path; leave `//host/...` untouched.
- N8 `closed:false` disagreed with the UI -> defined as a remove-row success.
- N9 `project` query was optional and could resolve the wrong app -> required; `400
  project_required`.
- N10 SSR/`hidden` was ambiguous -> always render the wrapper; `hidden` only when empty.
- N11 D8 required a first-open warning while §8.8 rejected it -> D8 now requires the persistent hint
  only.
- N12 tool-name prefix was not handled in glyph/preview maps -> normalize `hanse_` or add both
  spellings.
- N13 MCP schemas and the unconfigured dispatch were unspecified -> exact schemas; preview names
  return `preview_unavailable` even when the service is absent; `name` is printable ASCII.
- N14 a WebSocket Origin allowlist was omitted -> preview-only `Origin` host = `Host` check.
- N15 no proxy timeout/connection cap -> documented as an accepted demo residual.
- N16 tests missed several guards -> expanded in §9.
- N17 `PreviewService` module boundary was undefined -> `src/preview/`, no HTTP/manager imports.
- N18 IPv6 target parsing -> removed by using `appContainerName(appId)`; no host string
  concatenation.

**Round 1 outcome:** revisions applied; round 2 re-review pending. The plan gate remains closed.

### Round 2 - `oracle`, 2026-10-23 - **FAIL**

Round 2 confirmed B1's core, B2's normal 101 path, B3, and B4 resolved. It raised two new residual
blockers (B5, B6) and seventeen non-blocking findings (N19-N35).

**Blocking findings and resolution:**

| ID | Finding | Resolution |
| --- | --- | --- |
| B5 | Full-path forwarding still conflicted with Next `basePath`: the single trailing-slash `base_path` is rejected by Next, Next's default `trailingSlash: false` canonicalizes back to no slash, and the proxy's 302 creates a loop; Next `allowedDevOrigins` was not covered. | Added a per-framework base contract: Vite `base = base_path`; Next `basePath = base_path_without_trailing_slash` + `trailingSlash: true` + `allowedDevOrigins`; generic relative assets. The tool result now carries both base spellings and `operator_host`; the `Location` rewrite treats both spellings as already prefixed; proxy tests cover Vite, Next, and a base-without-slash `Location`. |
| B6 | The 64 KiB WS 101 buffer cap had no overflow behavior, so a long header block could bypass the filter; 101 header preservation was not an explicit allowlist, non-101 responses were unspecified, and the check order was ambiguous. | The WS branch now specifies: auth 401 -> preview 404 -> Origin 403 -> connect; write the client `head`; buffer the upstream handshake to `\r\n\r\n` with a 64 KiB cap; on overflow send a 502 and **never pipe unfiltered bytes**; use a five-header 101 allowlist; on any non-101 upstream status send a 502 and destroy. Tests cover the cap, non-101, all dropped headers, `Origin: null`, and absent Origin. |

**Non-blocking findings folded in:**

- N19 `Location` equal to the base without a slash was double-prefixed -> compare both spellings.
- N20 Next `allowedDevOrigins` was missing -> per-framework contract plus `operator_host`.
- N21 `base_path` trailing slash vs Next `basePath` -> both spellings returned.
- N22 WS header allowlist/non-101/origin order -> specified in D5.
- N23 §5.4 status table incomplete -> added the WS 403 row and a note that API statuses are in §5.2.
- N24 "no preview route" vs API 503 -> clarified: proxy/upgrade routes absent; list/close API
  returns 503.
- N25 the 120-char key QA fixture violated the 32-char limit -> fixture changed to a 32-char key.
- N26 static-card focus preservation was unspecified -> `updatePreviewCard` preserves or moves focus
  explicitly.
- N27 proxy tests need a target seam -> `resolveTarget` injection specified.
- N28 `isRunning` after a coordinator restart -> documented `resumeRunning` behavior and the
  `preview_app_not_running` retry.
- N29 WS client `head` bytes -> forwarded after the request headers.
- N30 front-proxy `Host` rewriting -> deployment assumption documented.
- N31 `X-Forwarded-Prefix` value -> defined as the base path with trailing slash.
- N32 absolute `Location` left untouched -> accepted and documented.
- N33 101 filter tests only covered two headers -> expanded to the full drop list.
- N34 no absent/`null` Origin tests -> added.
- N35 manager absent with previews configured -> `preview_unavailable` specified.

**Round 2 outcome:** revisions applied; round 3 re-review pending. The plan gate remains closed.

### Round 3 - `oracle`, 2026-10-23 - **PASS**

Round 3 confirmed B5 and B6 resolved: the Vite/Next base contract is coherent, `operator_host` is
captured from the human chat page and is nullable/guidance-only, the trailing-slash 302 plus Next
`trailingSlash: true` is loop-free, and the WS 101 path has an explicit order, cap-overflow behavior,
five-header allowlist, non-101 rejection, and `head` forwarding. No blocking findings remain.

The review left eleven non-blocking findings (N36-N46), all folded into the design or the plan:

- N36 `operator_host` capture contract -> `PreviewService.recordOperatorHost(appId, request.host)`
  after `humanFrom`/`findApp`; tests for string/null/latest-wins/per-app.
- N37 `operator_host` is `Host:port` -> added normalized `operator_hostname` (port and IPv6 brackets
  stripped) and switched the framework guidance to it.
- N38 §5.4 "upstream status" vs D5 WS non-101 -> scoped the row to "HTTP upstream status" and added
  the WS non-101/refused 502 row.
- N39 card focus target may not be focusable -> the status text carries `tabindex="-1"`; browser QA
  assertion added.
- N40 `Location` sibling false positive -> segment-boundary rule; `.../<k2>` is not treated as the
  base.
- N41 `Location` query/fragment -> prefix only the path; preserve query/fragment; test added.
- N42 missing tests -> added operator-host, base-without-slash `Location`, protocol/extensions
  preservation, HTTP HSTS/Alt-Svc/Report-To/NEL, and absolute `Location` cases.
- N43 HTTP path with an upstream 101 -> 502 and destroy; never forwarded; test added.
- N44 WS allowlist raw-line risk -> parse, lowercase, allowlist, reject obs-fold/CRLF, regenerate;
  test added.
- N45 `operator_host` cleanup -> cleared with `clearApp` on stop/deletion.
- N46 `operator_host` is app-visible -> documented as an accepted demo residual; only the normalized
  hostname is needed for allowlists.

**Round 3 outcome:** design approved; the plan gate is open. The implementation plan follows.
