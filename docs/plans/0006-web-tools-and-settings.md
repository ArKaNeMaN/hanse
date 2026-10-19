# Plan 0006: Web tools and hierarchical settings

- Status: implemented and verified (journal 0007); commit/deployment pending
- Design: [`docs/design/web-tools-and-settings.md`](../design/web-tools-and-settings.md)
- Design review: `oracle` round 2 — APPROVE WITH CHANGES, findings folded
- Plan reviewer: `momus`
- Owner decisions: [`docs/open-questions.md`](../open-questions.md)
- Date: 2026-10-19

## Delivery bindings

| Binding | Value |
| --- | --- |
| Stage | `0006-web-tools-and-settings` |
| Design artifact | `docs/design/web-tools-and-settings.md` |
| Plan artifact | `docs/plans/0006-web-tools-and-settings.md` |
| Design index | `docs/design/README.md` |
| Plan index | `docs/plans/README.md` |
| Journal | `docs/journal/0007-web-tools-and-settings.md`; index `docs/journal/README.md` |
| Decision records | `docs/decisions/0006-hierarchical-settings.md`, `docs/decisions/0007-web-tool-drivers.md` |
| Open questions | `docs/open-questions.md` (no open items; 7 resolved decisions) |
| Verification | `npm run lint && npm run typecheck && npm test && npm run build` |
| Live smoke | Built image, uid 1000, writable `/home/node/.omo`, real opencode + OMO |
| Commit policy | One coherent stage commit only on explicit owner instruction |

## Owner decisions carried into this plan

1. Settings live in the coordinator SQLite DB.
2. Web tools use a separate `hanse_web` stdio MCP server.
3. Model-provider keys are edited in settings and stored encrypted.
4. Built-in web tools are a `builtin` driver option; managed drivers disable the corresponding
   built-in.
5. Driver fields are per-driver (builtin none, DeepSeek provider + request options).
6. Settings apply only on an explicit restart, with a pending marker.
7. `llm.model` is a scalar with a default and is not clearable; search/fetch are clearable.

## Global invariants

- Settings reads/writes are human-only. Agent principals receive `403`; HTML humans are redirected
  to login.
- Provider key material never appears in `settings` JSON, `OPENCODE_CONFIG_CONTENT`, HTTP responses,
  logs, or test snapshots. Only status/fingerprint data crosses the API boundary.
- Defaults preserve current behavior: `builtin` for search/fetch and
  `deepseek/deepseek-flash` for the model.
- Existing 396 tests stay green; no test is deleted, skipped, or weakened to pass.
- One `serve` process per state directory is supported. Multi-coordinator OMO writes are out of
  scope and documented.
- No auto-restart. Settings changes are applied only by the explicit restart endpoint or the next
  start after the instance is stopped.
- OMO config is written only through `OmoProfileStore` with an injectable path; tests must never
  write the real `~/.omo/omo.jsonc`.
- The `hanse_web` MCP server is registered only when at least one managed driver is active.
- Node 20+, ESM/NodeNext, no new runtime dependency unless a plan deviation justifies it.

## Execution order and parallelization

1. **Phase 1 — Settings and provider-key foundation.** No HTTP/opencode/web-driver behavior.
2. **Phase 2 — Web engine, DeepSeek driver, `hanse_web` MCP.** Independent of the opencode manager;
   consumes Phase 1's `WebToolConfig`/driver registry interfaces.
3. **Phase 3 — OpenCode auth, model overlay, OMO profiles, manager lifecycle.** Depends on Phases 1
   and 2.
4. **Phase 4 — HTTP/UI settings, pending marker, restart.** Depends on Phases 1 and 3.
5. **Phase 5 — Integration, live smoke, docs, record.** Depends on all phases.

Phase 1 owns and **freezes** `src/web/types.ts` (and `src/settings/types.ts`) when it completes.
Phase 2 imports those files and must not edit them; after that gate the remaining write scopes are
disjoint (`src/settings`+`src/store` vs `src/web`+`src/cli`). Phase 3 must not start until the Phase 2
web config builder exists. Phase 4 must not start until the manager's `pendingRestart`/`stopApp` API
exists.

## Test infrastructure and injection points

- `SettingsService` constructor: `{ db, secretKey, hostAuthFile?, now? }`.
- `OmoProfileStore` constructor: `{ path, pinnedAgents?, pinnedCategories? }`.
- `InstanceManager` options: `settings`, `omoProfiles`, `stopTimeoutMs`, plus the existing
  `launch`/`verify` injectables.
- `DeepSeekDriver`: injectable `baseUrl` and `fetch`.
- `runWebMcpServer`: injectable `readAuth`/`now` if needed for deterministic tests.
- Tests use `mkdtempSync` for auth/profile/state paths; no test reads or writes the real HOME.
- HTTP tests use the existing in-memory/temp DB + `createHttpServer` idioms.

## Phase 1 — Settings and provider-key foundation

### Boundaries / non-goals

- No HTTP routes, UI, opencode overlay, OMO profile, or web driver implementation.
- No migrations to existing rows; v3 is additive.
- Percentage/format migrations are out of scope.

### Files

- `src/store/migrations.ts` — migration v3 (`settings`, `provider_keys`).
- `src/settings/types.ts` — scopes, targets, effective/scoped values, statuses, snapshot types.
- `src/settings/registry.ts` — key definitions, schemas, `merge`, `clearable`, defaults.
- `src/settings/provider-keys.ts` — AES-GCM provider key storage/resolution.
- `src/settings/service.ts` — resolve/read/write, host-auth status, merged-auth snapshot, hash.
- `src/settings/hash.ts` — deterministic stable stringify/hash.
- `src/settings/index.ts` — exports.
- `src/web/types.ts` — `WebToolConfig`, driver interfaces (shared with Phase 2).
- `test/settings.test.ts`, `test/settings-store.test.ts`.

### Decision-complete interfaces

```ts
type SettingsScope = "global" | "project" | "app";

interface SettingsTarget {
  projectId?: string;
  appKey?: string;
}

interface LaunchSettingsSnapshot {
  resolved: ResolvedSettings;
  mergedAuth: Record<string, unknown>;
  authHash: string;
  providerKeys: Map<string, { state: "set"; key: string } | { state: "cleared" }>;
}

class SettingsService {
  constructor(options: {
    db: SqliteDatabase;
    secretKey: Buffer;
    hostAuthFile?: string;
    now?: () => Date;
  });

  resolve(target: SettingsTarget): ResolvedSettings; // settings only, no runtime pending
  snapshot(target: SettingsTarget): LaunchSettingsSnapshot;
  effectiveHash(target: SettingsTarget): string; // settings + auth; no profile/pending

  set(scope: SettingsScope, target: SettingsTarget, key: string, value: unknown, actor: string): void;
  clear(scope: SettingsScope, target: SettingsTarget, key: string, actor: string): void;
  inherit(scope: SettingsScope, target: SettingsTarget, key: string): void;

  setProviderKey(scope: SettingsScope, target: SettingsTarget, provider: string, key: string, actor: string): void;
  clearProviderKey(scope: SettingsScope, target: SettingsTarget, provider: string, actor: string): void;
  inheritProviderKey(scope: SettingsScope, target: SettingsTarget, provider: string): void;
}
```

`resolve` validates targets (`project` requires projectId, `app` requires both; appKey without
projectId is rejected) and returns settings only; `SettingsResponse = ResolvedSettings &
{ pendingRestart: PendingRestart[] }` is the HTTP shape, with pending merged from the manager.
`snapshot` is the sole host-auth reader and merges effective provider keys exactly as the launcher
will write them. `effectiveHash` hashes the settings + auth snapshot only (never `appliedProfile`,
profile content, or secret plaintext); the manager combines it with
`OmoProfileStore.preview().contentHash` and `appliedProfile` to form the running hash compared by
`pendingRestart`.

### Implementation steps

1. Add migration v3 with the exact DDL from the design: `settings` with `json_valid`/key checks;
   `provider_keys` with nullable cipher/nonce, `cleared` 0/1 check, and the tombstone check.
2. Implement the key registry for `llm.model`, `web.search`, `web.fetch`; `llm.model` is
   `clearable: false`; web keys default to `{ driver: "builtin" }` and are clearable.
3. Implement `replace` and `append` resolution, raw `scoped` rows, `sources[]`, `warnings[]`, and
   invalid-row fallback.
4. Implement provider-key storage: seal on set, null out cipher/nonce on clear, delete on inherit,
   decrypt on resolve; statuses `set`, `cleared`, `missing`, `host` (with `authType`), `error`.
5. Implement host auth reading (JSON object; invalid → `{}` + warning) and merged-auth snapshot;
   empty merged auth is represented as `{}` for the launcher to unlink.
6. Implement deterministic hash helpers; no plaintext secrets in hash inputs or outputs.
7. Add tests.

### Acceptance criteria

- Given a fresh DB, when `runMigrations` runs twice, then it applies once and the two tables and
  checks exist; a second run returns 0.
- Given global/project/app rows, when resolved, then the narrowest value wins; `null` clears and
  stops inheritance; a wider clear can be re-set at a narrower scope.
- Given an `append` test key, when two scopes contribute, then values concatenate and `sources`
  lists both scopes; `null` at the narrowest scope yields cleared.
- Given `key=llm.model`, when `clear` is called, then it throws/returns a validation error; a raw
  `null` row is skipped with a warning and the default applies.
- Given a provider key set/cleared/inherited, then cipher/nonce are sealed, nulled, or deleted;
  host fallback is used only when no scope yields an effective settings key.
- Given corrupt ciphertext, then the status is `error` and no key is returned.
- Given an invalid stored JSON/schema value, then resolution emits a warning and falls back.

### Tests

- `test/settings-store.test.ts`: migration v3, PK/CHECK constraints, CRUD, uniqueness, tombstone
  cipher nulling, encryption round-trip.
- `test/settings.test.ts`: replace/append/clear/default matrix, `sources`, invalid values,
  `llm.model` no-clear, provider statuses, merged auth, hash stability/secret absence.

### Risks / verification

- Risk: `json_valid` availability in better-sqlite3. Verify with a migration test on the bundled
  SQLite; if unavailable, replace with an application-level JSON check and record the deviation.
- Risk: provider key status can leak a message containing key material. Redact and test with a
  sentinel key.
- Verification: `npx vitest run test/settings.test.ts test/settings-store.test.ts`, `npm run
  typecheck`, `npm run lint`.

## Phase 2 — Web engine, DeepSeek driver, `hanse_web` MCP

### Boundaries / non-goals

- No settings HTTP/UI and no opencode manager wiring.
- No additional providers; no caching, persistence, or retry scheduler.
- No remote MCP transport; the server is local stdio only.

### Files

- `src/web/registry.ts` — `builtin` and `deepseek` driver definitions, option schemas, UI fields.
- `src/web/types.ts` — **read-only after Phase 1**; Phase 2 imports the frozen driver/tool types.
- `src/web/drivers/deepseek.ts` — standalone Search/Fetch client.
- `src/web/config.ts` — build the managed `HANSE_WEB_CONFIG` and conditional MCP entry data.
- `src/web/mcp.ts` / `src/web/server.ts` — async JSON-RPC loop, tools/list, tools/call.
- `src/cli/cli.ts`, `src/cli/commands.ts` — `web-mcp` command.
- `test/web-deepseek.test.ts`, `test/web-mcp.test.ts`.

### Decision-complete interfaces

```ts
interface WebDriverDefinition<O> {
  id: "builtin" | "deepseek";
  label: string;
  managed: boolean;
  optionsSchema: z.ZodType<O>;
  fields: DriverField[];
  create?(options: O, ctx: { fetch: typeof fetch; baseUrl: string }): WebDriver;
}

interface WebMcpConfig {
  search?: DeepSeekOptions;
  fetch?: DeepSeekOptions;
}

// HANSE_WEB_CONFIG serializes WebMcpConfig as bare per-tool options; the server only accepts the
// managed DeepSeek driver, so no driver wrapper is stored in the env var.
function buildWebMcpConfig(web: EffectiveSettings["web"]): WebMcpConfig | undefined;
function runWebMcpServer(config: WebMcpConfig, authFile: string): Promise<void>;
```

The `web-mcp` command reads `HANSE_WEB_CONFIG` and `HANSE_OPENCODE_AUTH_FILE`; missing/invalid
config exits `2` with a stderr message. The server exposes tools `search` and `fetch`; opencode
prefixes them with `hanse_web_`.

### Implementation steps

1. Implement the driver registry and strict DeepSeek options schema (`provider`, `count` 1-20,
   `needContent`, `timeoutMs` 1000-60000, `maxContentChars` 1024-1048576). Enforce search query
   length <= 2048.
2. Implement `DeepSeekDriver`: `POST /v1/tools/search` and `/v1/tools/fetch`, Bearer auth,
   `AbortSignal.timeout`, bounded response reads, normalized result, safe errors. Validate fetch
   URLs: http/https only, no embedded credentials, bounded length (<= 8192).
3. Implement credential lookup from the per-instance auth file; require `type:"api"`.
4. Implement `buildWebMcpConfig`: include only `deepseek` tools; return `undefined` when none.
5. Implement the async line-delimited JSON-RPC loop: initialize, tools/list, tools/call,
   notifications, parse errors, interleaved requests. Unknown/disabled tools → JSON-RPC error;
   credential/driver failures → `isError` result with safe text.
6. Add the `web-mcp` CLI command and help text.
7. Add tests with a local fake HTTP server and a temp auth file.

### Acceptance criteria

- Given a search request, then the driver sends the exact `{query, count, need_content}` body and
  Bearer header; response results are normalized.
- Given a query longer than 2048 or a fetch URL that is not http/https, contains credentials, or is
  longer than 8192, then it is rejected before any request is sent.
- Given a fetch request, then `{url}` is sent and `{title, content}` is returned; content is capped.
- Given 401/403/429/5xx/timeout, then the tool returns a safe error; no key/header/body leaks.
- Given `builtin` or no managed tool, then `buildWebMcpConfig` returns `undefined`.
- Given a managed tool with no valid credential, then `tools/list` omits it and `tools/call`
  returns an `isError` result; unknown/disabled tools return JSON-RPC errors.
- Given two interleaved tool calls, then responses are matched by JSON-RPC id and neither blocks
  the other.
- Given missing/invalid `HANSE_WEB_CONFIG`, then `web-mcp` exits 2 without writing to stdout.

### Tests

- `test/web-deepseek.test.ts`: request shape, auth, baseUrl injection, normalization, caps, query
  and URL bounds/validation, error classes, no leakage, provider validation.
- `test/web-mcp.test.ts`: tools/list visibility, credential re-check, JSON-RPC vs `isError`,
  interleaved requests/notifications, config validation.

### Risks / verification

- Risk: DeepSeek endpoint/schema drift. The driver tests pin the documented shape; a live call is
  optional in Phase 5.
- Risk: opencode's exact MCP tool prefix. Phase 5 live smoke asserts `hanse_web_search`; unit tests
  assert the server's `search`/`fetch` names.
- Verification: `npx vitest run test/web-deepseek.test.ts test/web-mcp.test.ts`, typecheck, lint.

## Phase 3 — OpenCode auth, model overlay, OMO profiles, manager lifecycle

### Boundaries / non-goals

- No settings pages/API.
- No full OMO state isolation; only config profile selection.
- No model picker/provider discovery.

### Files

- `src/opencode/instance.ts` — overlay `model`, extra MCP servers, web permission inputs.
- `src/opencode/auth.ts` — serialize the merged auth snapshot, atomic write/unlink; the host auth
  read/merge lives only in `SettingsService.snapshot`.
- `src/opencode/omo-profile.ts` — per-app profile generation, lock, preview/apply.
- `src/opencode/launcher.ts` — auth write, `OMO_PROFILE`, env scrub, web MCP env.
- `src/opencode/manager.ts` — snapshot, single-flight ensure, stop/restart, pending hash.
- `src/opencode/policy.ts` — web permission options and env scrub list.
- `test/instance.test.ts`, `test/launcher.test.ts`, `test/auth-inject.test.ts`,
  `test/omo-profile.test.ts`, `test/manager.test.ts`, `test/permission-policy.test.ts`.

### Decision-complete interfaces

```ts
interface LaunchInput {
  // existing fields...
  model?: string;
  auth?: Record<string, unknown>;       // merged auth; empty object means unlink
  omoProfile?: string;                  // set only when applied
  mcpServers?: Record<string, McpLocalServer>;
  web?: EffectiveSettings["web"];       // permission decisions
}

class OmoProfileStore {
  constructor(options: { path: string; pinnedAgents?: string[]; pinnedCategories?: string[] });
  ensure(input: { appId: string; model: string; disableWebsearch: boolean }):
    Promise<{ name?: string; applied: boolean; contentHash: string; warning?: string }>;
  preview(input: { appId: string; model: string; disableWebsearch: boolean }):
    { name: string; applied: boolean; contentHash: string; warning?: string };
}

class InstanceManager {
  pendingRestart(appId: string): { pending: boolean; reasons: string[] };
  isRunning(appId: string): boolean;
  async stopApp(appId: string): Promise<boolean>;
  // ensure() keeps its signature but becomes single-flight per app
}
```

`buildConfigOverlay` adds `model` and merges `mcpServers` before the coordinator/codegraph entries
(coordinator names win). `buildPermissionPolicy` accepts `{ webfetch, websearch, managedSearch,
managedFetch }` and emits `webfetch`, `websearch`, and, when managed, `hanse_web_search`/
`hanse_web_fetch` allow entries.

### Implementation steps

1. Extend `OpencodeOverlay`/`BuildOverlayOptions`/`LaunchInput` with `model` and extra MCP servers;
   do not emit an `agent` map.
2. Implement `src/opencode/auth.ts`: serialize the `mergedAuth` snapshot, atomic write with
   `0600`/dir `0700`, unlink on empty. It must not re-read host auth or re-merge keys; remove the
   old `authSource` copy path from `launchInstance`.
3. Implement `OmoProfileStore`: default path `os.homedir()/.omo/omo.jsonc`, injectable path;
   JSON-compatible base; derive agent/category names from base + pinned 5.1.35 set; generate the
   per-app profile; compute `disabled_mcps`; serialize writes with an async mutex; atomic rename;
   preview for hashing; parse/write failure returns `applied:false` + warning.
4. Extend `buildInstanceEnv`: write `OPENCODE_CONFIG_CONTENT` with `model`/MCP entries; scrub
   `OPENCODE_AUTH_CONTENT`, `OMO_PROFILE`, `OCX_PROFILE`, `OPENCODE_CONFIG_DIR`; set `OMO_PROFILE`
   only when applied; add the `hanse_web` MCP environment (`HANSE_WEB_CONFIG`,
   `HANSE_OPENCODE_AUTH_FILE`).
5. Extend `InstanceManager.ensure`: per-app in-flight promise; snapshot settings; ensure profile;
   compute hash; launch; record `appliedProfile`; verify. Add `signalCode` handling, `isRunning`,
   `stopApp` with SIGTERM/timeout/SIGKILL, and `pendingRestart` with reasons.
6. Wire restart to the same per-app lock (await/invalidate in-flight `ensure` before stopping).
7. Update permission policy and exact-key tests.
8. Add tests.

### Acceptance criteria

- Given a selected model, then the overlay contains `model` and the instance env sets
  `OMO_PROFILE` to the per-app profile; the profile contains all pinned agents/categories and the
  final `disabled_mcps`.
- Given a profile write/parse failure, then the launch omits `OMO_PROFILE`, records a warning, and
  `pendingRestart` reports `profile_not_applied` until the condition is resolved.
- Given two concurrent `ensure()` calls for one app, then one process launches and both callers get
  the same endpoint.
- Given a running child with `signalCode` set, then `isRunning` is false and `pendingRestart` is
  false.
- Given a restart during an in-flight `ensure`, then restart waits/invalidate the launch and does
  not leave a new old-settings instance.
- Given host auth + set/clear/inherit, then the auth file contains the correct merged entries, has
  mode `0600`, and is removed when empty.
- Given `OPENCODE_AUTH_CONTENT`/`OMO_PROFILE`/`OCX_PROFILE`/`OPENCODE_CONFIG_DIR` in the parent env,
  then none reaches the instance except the coordinator-set `OMO_PROFILE`.
- Given managed search, then `websearch` permission is `deny`, OMO profile `disabled_mcps` contains
  `websearch`, and `hanse_web` is registered; given builtin, `websearch` is `allow` and no
  `hanse_web` entry exists.
- Given `llm.model` changed, then `pendingRestart` is true with `settings_changed`; a restart applies
  the new overlay/profile.
- Given built-in search without the OMO baseline, then a warning is emitted; given a base
  `disabled_mcps` that already contains `websearch`, then built-in cannot re-enable it and a warning
  is emitted.

### Tests

- `test/instance.test.ts`: overlay model, extra MCP, no agent map.
- `test/launcher.test.ts`: env scrub, OMO_PROFILE, auth write, `hanse_web` env.
- `test/auth-inject.test.ts`: host/set/clear/inherit, global-set/app-inherit, stale removal, mode.
- `test/omo-profile.test.ts`: generation, pinned names, union, built-in-search-without-OMO warning,
  base-disabled-websearch warning, fallback, concurrency, preview.
- `test/manager.test.ts`: single-flight, signalCode, stop timeout, restart race, pending reasons.
- `test/permission-policy.test.ts`: all search/fetch combinations and exact key order.

### Risks / verification

- Risk: OMO 5.1.35 profile merge semantics. The pinned unit test asserts the expected merge and the
  Phase 5 live smoke verifies `/agent`.
- Risk: project `.omo` layers override the profile. The manager records a warning from `/agent`
  verification; the live smoke includes the case.
- Verification: targeted vitest suites, typecheck, lint.

## Phase 4 — HTTP/UI settings, pending marker, restart

### Boundaries / non-goals

- No new auth system; reuse `principalFrom`/`humanFrom` and `safeLocalPath`.
- No client-side framework; server-rendered forms plus a small `settings.js` toggle.
- No secret value is ever rendered or returned.

### Files

- `src/http/settings.ts` — pages, API, provider forms, restart route.
- `src/http/server.ts` — dispatch settings/restart before chat.
- `src/http/handler.ts` — `HttpDeps.settings`, asset allowlist, shared helpers.
- `src/http/dashboard.ts` — `pendingRestart` in `SiteModel`/`DashboardDeps`, links/badges.
- `src/http/application.ts` — settings link and pending banner.
- `src/http/chat.ts` — pending marker in the context rail.
- `src/http/ui.ts` — `ShellOptions.active: "settings"`, sidebar entry, form helpers if needed.
- `src/cli/commands.ts` — construct `SettingsService`/`OmoProfileStore`, pass to manager/HTTP.
- `assets/settings.js` — driver field toggling.
- `test/settings-http.test.ts`, `test/http.test.ts`, `test/application-page.test.ts`,
  `test/chat-page.test.ts`.

### Decision-complete routes and behavior

- `GET /settings`, `/projects/:id/settings`, `/projects/:id/apps/:appKey/settings` — HTML.
- `GET /api/settings?scope=...&project=...&app=...` — JSON `ResolvedSettings`.
- `POST /api/settings` — form/JSON, actions `set|clear|inherit`, strict validation.
- `POST /api/settings/provider` — form/JSON, actions `set|clear|inherit`, key never returned.
- `POST /api/apps/:app/restart?project=...` — async; `200 {restarted:true}` when stopped;
  `200 {restarted:false, reason:"not_running"}` when not running.
- Human-only: API agent → `403`, unauthenticated API → `401`, HTML unauthenticated → login redirect.
- Settings responses/pages set `Cache-Control: no-store`; provider input uses
  `autocomplete="new-password"`.

### Implementation steps

1. Wire `SettingsService` and `OmoProfileStore` in `serveCommand`; load `secretKeyPath` and fail
   closed with a clear stderr error if it cannot be loaded/created or has the wrong length.
2. Add `HttpDeps.settings`; add `pendingRestart` callback to `DashboardDeps`; extend `SiteModel`.
3. Add the settings route dispatch before `isChat`; keep `handleRequest` sync and make only the
   settings/restart handler async.
4. Render global/project/app pages with scoped rows, effective/source badges, warnings, three-state
   controls, provider statuses, model input, web driver select/fields.
5. Add `settings.js` and the asset allowlist; extend the Tailwind build if new classes are used.
6. Add links from project/application pages and the sidebar; add pending banners on app/chat pages
   and a restart button.
7. Add tests.

### Acceptance criteria

- Given an unauthenticated HTML request, then redirect to login; given an agent API request, then
  403; given an agent HTML request, then no access.
- Given a set/clear/inherit form, then the DB row is written/deleted and the page shows the new
  effective value/source; Clear is not offered for `llm.model`.
- Given a provider key form, then the key is stored encrypted and never echoed; status shows
  configured/inherited/cleared/missing/host/error.
- Given a selected model whose provider has no settings key and no host auth, then the settings UI
  shows a provider warning, and the existing-session model limitation is stated.
- Given `secretKeyPath` cannot be loaded/created, then `serve` fails closed with a clear error and
  does not start the HTTP server.
- Given a DeepSeek driver selection, then only its fields are visible/submitted; builtin submits no
  options.
- Given pending settings, then the app/chat/settings surfaces show the marker and the restart button;
  a stopped restart returns `{restarted:false}` with a notice.
- Given a malformed JSON/form body, then `400`; given an oversized body, then the existing `413`.
- Given `/assets/settings.js`, then it is served from the allowlist; the CSS build contains the
  settings classes.

### Tests

- `test/settings-http.test.ts`: auth, GET/POST JSON+form, three-state, provider status, missing
  model-provider warning, existing-session limitation, pending shape, restart route, no-store,
  escaping, input bounds/array-key rejection.
- `test/commands.test.ts`: `serve` fails closed when `secretKeyPath` cannot be loaded/created.
- `test/http.test.ts`: nav/route dispatch, asset allowlist, 404 behavior.
- `test/application-page.test.ts`, `test/chat-page.test.ts`: settings link, pending marker,
  restart button, no key leakage.

### Risks / verification

- Risk: restart dispatch being swallowed by `isChat`; test the exact route.
- Risk: no-JS driver fields; the server must ignore hidden fields and validate the selected driver.
- Verification: targeted vitest suites, typecheck, lint, `npm run build:css`.

## Phase 5 — Integration, live smoke, docs, record

### Boundaries / non-goals

- No new features beyond the design.
- No commit until the owner explicitly authorizes it.

### Steps

1. Run `npm run lint && npm run typecheck && npm test && npm run build` until green.
2. Build the image/container environment and run the live smoke in the built image as uid 1000 (for
   example the compose service or `docker run --user 1000`), with a writable `/home/node/.omo`:
   - start an instance with a non-default selected model;
   - assert the profile file is written, `/agent` reports the model for pinned agents, a
     prompt-level category delegation uses it;
   - managed search: OMO `websearch` absent, `hanse_web_search` exposed;
   - builtin search without OMO: warning;
   - an app with a project `.omo/omo.jsonc` layer that overrides a pinned model: `/agent` warning.
3. Write ADR `0006-hierarchical-settings.md` (scope/merge/tombstone/host-auth decisions) and ADR
   `0007-web-tool-drivers.md` (transport/driver/builtin policy).
4. Update `docs/current-state.md`, `docs/conventions.md`, `docs/deployment.md`, `docs/design/README.md`,
   `docs/plans/README.md`, `docs/journal/README.md`. Document rollback: drop `settings` and
   `provider_keys`, and delete the `schema_migrations` row for version 3.
5. Write `docs/journal/0007-web-tools-and-settings.md` with context, decisions, artifacts, evidence,
   residual risks, and next steps.
6. Report the diff summary and verification evidence. Do not commit unless the owner asks.

### Exit criteria

- All four verification commands are green.
- The live smoke evidence is recorded with the exact environment and assertions.
- The two ADRs, journal, and indexes are consistent with the code.
- The working tree contains only the stage's files.
- A final "ready to commit" report is delivered; no commit is made without explicit authorization.

## Open questions

None. The seven owner decisions are recorded in `docs/open-questions.md`; the design review gate is
passed (round 2: approve with changes, findings folded). Any new fork discovered during execution
must be surfaced as a plan deviation or a new owner question; it must not be guessed silently.

## Plan review

`momus` verdict: **PASS WITH CHANGES**, no blocking findings. All findings are folded:

| Finding | Disposition |
| --- | --- |
| Auth read/merge twice | `SettingsService.snapshot` is the sole host-auth reader; `auth.ts` only serializes/writes/unlinks; the old `authSource` copy path is removed. |
| `HANSE_WEB_CONFIG` shape mismatch | `WebMcpConfig` is bare `{search?: DeepSeekOptions, fetch?: DeepSeekOptions}`, matching the design; a contract test is required. |
| Phase 1/2 shared `src/web/types.ts` | Phase 1 owns and freezes it; Phase 2 imports it and must not edit it. |
| Missing input bounds/URL validation | Added query <= 2048, URL http/https/no-credentials/<= 8192, model <= 256, provider <= 128, key <= 4096, and array/prototype-key rejection to the phases and tests. |
| Design should-fixes missing from plan | Added built-in-search-without-OMO and base-disabled-websearch warnings, model-provider-key UI warning, existing-session limitation, and the project `.omo` live-smoke case. |
| `secretKeyPath` fail-closed | Added to Phase 4 wiring, acceptance criteria, and `test/commands.test.ts`. |
| `ResolvedSettings`/pending ownership | `resolve()` returns settings only; `SettingsResponse` adds runtime `pendingRestart[]`, merged by HTTP. |
| Rollback v3 row | Phase 5 docs now explicitly record dropping the tables and deleting the `schema_migrations` v3 row. |

Plan review gate: **passed**.

## Verification appendix

```bash
npm run lint
npm run typecheck
npm test
npm run build
```

Targeted commands used during phases:

```bash
npx vitest run test/settings.test.ts test/settings-store.test.ts
npx vitest run test/web-deepseek.test.ts test/web-mcp.test.ts
npx vitest run test/instance.test.ts test/launcher.test.ts test/auth-inject.test.ts
npx vitest run test/omo-profile.test.ts test/manager.test.ts test/permission-policy.test.ts
npx vitest run test/settings-http.test.ts test/http.test.ts test/application-page.test.ts test/chat-page.test.ts
```
