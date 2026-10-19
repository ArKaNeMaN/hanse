# Web tools and hierarchical settings

- Status: implemented and verified (journal 0007); commit/deployment pending
- Date: 2026-10-19
- Stage: `0006-web-tools-and-settings`
- Owners: Hanse maintainers
- Design reviewer: `oracle`
- Plan reviewer: `momus`

## Delivery bindings

| Binding | Value |
| --- | --- |
| Design docs | `docs/design/`; index `docs/design/README.md` |
| Plans | `docs/plans/`; index `docs/plans/README.md` |
| Journal | `docs/journal/`; index `docs/journal/README.md` |
| Decision records | `docs/decisions/NNNN-<slug>.md` |
| Open questions | `docs/open-questions.md` while open; then the plan header and stage record |
| Documentation language | English |
| Verification | `npm run lint && npm run typecheck && npm test && npm run build` |
| Commit policy | One coherent stage commit, only on explicit owner instruction |

## 1. Context

Hanse runs one isolated `opencode` instance per application. Today the coordinator injects a fixed
configuration overlay through `OPENCODE_CONFIG_CONTENT` (`src/opencode/instance.ts`) and copies the
host opencode `auth.json` into each instance. There is no operator-editable settings surface: the
schema has no settings table, the web UI has no settings page, and model selection is fixed by the
image-baked OMO config (`omo/omo.jsonc`, `deepseek/deepseek-flash`).

The owner wants:

- optional common `web_search` / `web_fetch` tools with pluggable drivers, starting with DeepSeek;
- no tool exposure when a tool is explicitly disabled or has no usable driver/credential;
- global -> project -> application settings with per-setting override/append semantics and explicit
  empty overrides;
- a model setting, initially a string, used as the main model and by OMO subagents;
- provider API keys configured in the settings UI;
- built-in web tools as one of the driver choices;
- an explicit restart action and a visible "settings changed, restart required" marker.

The DeepSeek API exposes standalone Search and Fetch endpoints. They are model-agnostic and suit the
driver design:

- `POST https://api.deepseek.com/v1/tools/search` with `{ query, count?, need_content? }`;
- `POST https://api.deepseek.com/v1/tools/fetch` with `{ url }`;
- Bearer authentication; per-request pricing and rate limits apply.

The existing built-ins are:

- opencode 1.19.3 `webfetch` (native, permission-gated);
- opencode 1.19.3 `websearch` (native, gated to the `opencode`/`opencode-go` provider unless the
  Exa/Parallel flags are enabled; not generally available under a DeepSeek provider);
- OMO's `websearch` MCP server (Exa by default), enabled by the OMO baseline.

Therefore `builtin` search means the OMO `websearch` MCP, and `builtin` fetch means opencode's
`webfetch`. If `HANSE_OMO_PLUGIN` is unset, `builtin` search has no tool; the settings UI warns.
The default driver for both tools is `builtin`, preserving current behavior. "Not configured" in the
owner requirement means an explicit `null`, not the absence of a row.

## 2. Goals

- R1: persist settings in the coordinator SQLite database at global, project, and application scope.
- R2: resolve settings with a deterministic hierarchy, per-key `replace`/`append` merge, and explicit
  empty overrides (`null` / `cleared`).
- R3: store model-provider API keys in the settings UI, encrypted at rest, and make them available
  to opencode and to managed web drivers without exposing them through the settings API.
- R4: expose common search/fetch tools backed by a driver registry; implement the DeepSeek driver
  against the standalone Search/Fetch APIs.
- R5: offer the existing built-in web tools as a `builtin` driver option, with driver-specific fields
  (none for built-in; provider and request options for DeepSeek).
- R6: do not expose a web tool when it is explicitly `null`, when its managed driver has no usable
  credential, or when its configured built-in backend is unavailable.
- R7: apply one selected model to new sessions and to every OMO agent/category, per app. Existing
  sessions may retain their session model; see §10.3.
- R8: apply settings only on an explicit restart; show which running agents have unapplied settings.
- R9: keep all settings reads and writes human-only and consistent with the existing UI/auth idioms.

## 3. Non-goals

- A model picker backed by provider discovery (the model remains a string in this stage).
- Additional web drivers beyond built-in and DeepSeek.
- Per-tool caching, result persistence, or a web history UI.
- Per-instance isolation of all OMO state; this design isolates only the OMO **config selection**
  needed for per-app model/disabled-MCP values.
- Changing the existing handoff MCP server into an asynchronous server.
- Multi-user or RBAC semantics; the existing single-operator trust model remains.
- Hard isolation of secrets from agents running as the same uid. This is a known trust-model limit.
- Key rotation, AAD binding of provider ciphertext, and per-instance cost budgets. Documented as
  residual risks; see §13.

## 4. Current state and constraints

- Settings storage: none. `src/store/migrations.ts` has migrations v1 (core) and v2 (`secrets`).
- Config injection: `buildConfigOverlay()` writes `plugin`, `mcp`, `instructions`, `permission`.
  `LaunchInput` carries no model, provider credentials, or web-tool configuration.
- Model: `omo/omo.jsonc` pins 10 OMO agents and 8 categories to `deepseek/deepseek-flash`; the main
  `sisyphus` agent is not pinned. `~/.omo` is image-wide and shared by all instances.
- OMO precedence (source-inspected against OMO 5.1.35 and opencode 1.19.3; live smoke required):
  - OMO's config hook regenerates built-in agents and filters `agent.<builtin>` overrides from
    opencode config.
  - A top-level opencode `model` controls `sisyphus` and `atlas`, but not most other subagents
    when OMO's fallback chain is available, and not category models.
  - A later opencode plugin can rewrite `config.agent.<builtin>.model`, but cannot rewrite OMO
    category model pins.
  - OMO profiles (`profiles.<name>` + `OMO_PROFILE`) are the supported per-instance mechanism that
    can override agent and category model pins and carry `disabled_mcps`. `disabled_mcps` is unioned
    with the base config by OMO 5.1.35 `mergeConfigs`; because it is a union, a profile cannot
    re-enable an MCP disabled by the base.
  - OMO also reads project `.omo/omo.jsonc` layers from the app cwd toward `$HOME`; those layers can
    override the coordinator profile.
  - OMO 5.1.35's `dist/oh-my-opencode.schema.json` is stale (it lacks `profiles`/`[opencode]`) while
    the runtime accepts them; editors may warn.
- Web built-ins: the permission overlay currently allows `webfetch` and `websearch`. OMO's
  `websearch` MCP is controlled by the OMO `[opencode].disabled_mcps` array.
- Auth: opencode reads `auth.json` from `$XDG_DATA_HOME/opencode/auth.json`. Entries are
  `{ "<provider>": { "type": "api", "key": "..." } }` (OAuth and well-known entries also exist).
  opencode 1.19.3 `Auth.all()` prefers the `OPENCODE_AUTH_CONTENT` environment variable over the
  file, so the coordinator must scrub or override it.
- Session model: opencode chooses `input.model ?? agent.model ?? session.model ?? default`. A
  restarted instance can keep an existing session's model. The model setting is deterministic for
  new sessions and for OMO agents whose profiles pin the model.
- Secrets: `src/secrets` provides AES-256-GCM `loadOrCreateKey`, `seal`, `open`; the key lives at
  `<state>/hanse/secret.key`. The store is not wired into `serve` yet.
- Concurrency: `InstanceManager.ensure()` is called from chat/prompt HTTP handlers and currently has
  no per-app single-flight or profile-write lock. The coordinator is a single `serve` process per
  state directory in the supported deployment.
- Constraints: Node >= 20, ESM/NodeNext, TypeScript, SQLite via better-sqlite3, no new runtime
  dependencies unless justified, docs and code comments in English.

## 5. Alternatives considered

### 5.1 Where to store settings

| Option | Pros | Cons |
| --- | --- | --- |
| Coordinator SQLite (chosen) | One source, WebUI-first, no repo writes, transactional updates | Does not travel with a cloned project |
| `.hanse` project/app manifests | Portable with the repository, reviewable in git | Writes user settings into repos; global scope still needs another store; schema churn |
| A separate JSON config file | Simple to inspect | Concurrency, migration, and per-scope merge logic reinvented; secrets need separate handling |

The owner chose SQLite. Project/app settings are keyed by stable coordinator ids. Export/import to
manifests can be added later without changing the resolver.

### 5.2 Web tool transport

| Option | Pros | Cons |
| --- | --- | --- |
| Separate `hanse_web` stdio MCP server (chosen) | Async from day one; conditional registration; exact separation from handoffs; independent tests | One extra process when a managed driver is enabled |
| Extend the existing `hanse` MCP server | One process; reuses binding | Requires an async rewrite of a stable synchronous server; couples handoffs to network I/O |
| opencode plugin / custom tool | Exact unprefixed tool names; no extra process | No supported per-instance config channel; secrets/config access is awkward; harder to test and version |

The separate server is registered only when at least one of search/fetch uses the managed DeepSeek
driver. If both use `builtin` or `null`, no extra process exists.

### 5.3 Model propagation

| Option | Pros | Cons |
| --- | --- | --- |
| Top-level `model` + `agent` overrides in `OPENCODE_CONFIG_CONTENT` | Simple | OMO rewrites built-in agents and filters overrides; category pins remain |
| Remove OMO model pins and rely on inheritance | Simple config | Non-deterministic: most agents use OMO fallback chains; categories use built-in defaults |
| Per-app OMO profiles + `OMO_PROFILE` (chosen) | Supported, deterministic, per-app, no HOME change | Requires serialized writes to the shared image-managed `~/.omo/omo.jsonc`; restart needed |
| Per-instance HOME | Isolates all OMO state | Changes HOME for git and other tools; larger blast radius |

The profile approach is the smallest supported mechanism that satisfies "main + all OMO subagents".

### 5.4 Provider-key injection

| Option | Pros | Cons |
| --- | --- | --- |
| Write a reconciled per-instance `auth.json` (chosen) | Standard opencode path; no secret in the overlay; atomic 0600 write; survives without new dependencies | Per-instance file must be kept in sync; stale entries must be removed on inherit/clear |
| `OPENCODE_AUTH_CONTENT` env | No file write | Secret lands in the opencode process environment and `/proc/<pid>/environ`; can silently override the file |
| Provider keys inside `OPENCODE_CONFIG_CONTENT` | Simple | Secret is in the agent-visible overlay and process environment; rejected |

`OPENCODE_AUTH_CONTENT` is scrubbed from the instance environment so it cannot override the
reconciled file.

## 6. Decision: architecture overview

```
Web UI / JSON API
      |
      v
SettingsService (SQLite)  ---> ProviderKeyStore (AES-GCM)
      |                              |
      | effective snapshot           | decrypted keys (internal only)
      v                              v
InstanceManager ---> launcher ---> auth.json + OPENCODE_CONFIG_CONTENT + OMO profile
   (single-flight)                   |
      |                              +--> opencode instance
      |
      +--> hanse_web MCP (when a managed web driver is enabled)
```

- Settings are resolved per application: `global -> project -> app`.
- `ensure()` takes one effective-settings snapshot, applies it, and records the hash of that same
  snapshot. A per-app in-flight promise prevents double launches.
- The manager reconciles the per-instance auth file and OMO profile before spawn. OMO profile writes
  are serialized by a process-local async mutex and written atomically.
- The `hanse_web` MCP server is registered only for managed web tools; built-ins remain in place
  for `builtin` drivers.
- Settings changes do not touch running instances. The manager compares the current effective
  settings hash with the hash recorded at start and exposes `pendingRestart`.

## 7. Settings model

### 7.1 Physical schema (SQLite migration v3)

```sql
CREATE TABLE settings (
  scope TEXT NOT NULL CHECK (scope IN ('global', 'project', 'app')),
  project_id TEXT NOT NULL DEFAULT '',
  app_key TEXT NOT NULL DEFAULT '',
  key TEXT NOT NULL CHECK (length(key) > 0),
  value_json TEXT NOT NULL CHECK (json_valid(value_json)),
  updated_at TEXT NOT NULL,
  updated_by TEXT,
  PRIMARY KEY (scope, project_id, app_key, key),
  CHECK (
    (scope = 'global' AND project_id = '' AND app_key = '') OR
    (scope = 'project' AND project_id <> '' AND app_key = '') OR
    (scope = 'app' AND project_id <> '' AND app_key <> '')
  )
);

CREATE TABLE provider_keys (
  scope TEXT NOT NULL CHECK (scope IN ('global', 'project', 'app')),
  project_id TEXT NOT NULL DEFAULT '',
  app_key TEXT NOT NULL DEFAULT '',
  provider TEXT NOT NULL CHECK (length(provider) > 0),
  cipher TEXT,
  nonce TEXT,
  cleared INTEGER NOT NULL DEFAULT 0 CHECK (cleared IN (0, 1)),
  updated_at TEXT NOT NULL,
  updated_by TEXT,
  PRIMARY KEY (scope, project_id, app_key, provider),
  CHECK (
    (scope = 'global' AND project_id = '' AND app_key = '') OR
    (scope = 'project' AND project_id <> '' AND app_key = '') OR
    (scope = 'app' AND project_id <> '' AND app_key <> '')
  ),
  CHECK (
    (cleared = 0 AND cipher IS NOT NULL AND nonce IS NOT NULL) OR
    (cleared = 1 AND cipher IS NULL AND nonce IS NULL)
  )
);
```

Both tables are additive; no existing rows are touched. `value_json` stores JSON, including the
literal `null`; `provider_keys.cleared = 1` with null `cipher`/`nonce` is the tombstone for an
explicit empty override. The tombstone nulls the ciphertext; the store enables `secure_delete` and
checkpoints the WAL after provider-key mutations, which removes the previous page in normal
operation, but physical media and backups may still retain old pages. No foreign keys are added
because global rows have no project/app and the coordinator validates targets before writing;
project/app cleanup can remove rows in a future deletion path. The primary-key prefix serves resolver
queries; no extra indexes are needed at this scale.

### 7.2 Three-state semantics

For each key at each scope:

| Row state | Meaning |
| --- | --- |
| absent | inherit from the next wider scope |
| `value_json = "null"` / `cleared = 1` | explicit empty override; inheritance stops at this scope |
| value / `cleared = 0` | apply this value |

`Inherit` deletes the row. `Clear/Disable` writes the empty state. A more specific scope can set a
value again after a wider clear.

`llm.model` is **not clearable**: it has a default and is always present. The API rejects
`action=clear` for it with `400`; the UI offers only `Inherit` and `Set`. `web.search` and
`web.fetch` are clearable; `Clear` means the tool is disabled at that scope and inheritance stops.

### 7.3 Key registry and merge strategies

| Key | Type | Merge | Clearable | Default |
| --- | --- | --- | --- | --- |
| `llm.model` | `provider/model` string | `replace` | no | `deepseek/deepseek-flash` |
| `web.search` | driver config or `null` | `replace` | yes | `{ "driver": "builtin" }` |
| `web.fetch` | driver config or `null` | `replace` | yes | `{ "driver": "builtin" }` |

The registry is a typed table in code; each entry has a zod schema, a `merge` strategy, and a
`clearable` flag. `replace` is used by all v1 keys.

`append` is supported for future list-valued keys and has defined semantics: absent = inherit; the
nearest wider `null` clears the accumulated list and stops inheritance; an array contributes its
items after the inherited (or empty, if cleared) list. A `null` at a narrower scope clears again.
It is tested even though no v1 key uses it. The resolver validates stored values on read; an invalid
stored value is skipped and reported in `warnings[]`, and the effective value falls back to the wider
scope/default. The raw scoped rows are returned alongside the effective values so the UI can show
whether a narrow row is absent, cleared, or set.

### 7.4 Resolver contract

```ts
type SettingsScope = "global" | "project" | "app";

interface SettingsTarget {
  projectId?: string;
  appKey?: string;
}

interface EffectiveValue<T> {
  value: T | null;
  state: "set" | "cleared" | "default";
  source: SettingsScope | "default"; // narrowest contributor
  sources: Array<SettingsScope | "default">; // all contributors; one for replace/default
}

interface ScopedValue<T> {
  state: "absent" | "cleared" | "set";
  value: T | null;
}

interface EffectiveSettings {
  llm: { model: EffectiveValue<string> };
  web: {
    search: EffectiveValue<WebToolConfig>;
    fetch: EffectiveValue<WebToolConfig>;
  };
}

interface PendingRestart {
  appId: string;
  appKey: string;
  projectId: string;
  reasons: string[];
}

interface ResolvedSettings {
  effective: EffectiveSettings;
  scoped: Record<string, ScopedValue<unknown>>;
  providerKeys: Record<string, ProviderKeyStatus>;
  warnings: string[];
}

interface SettingsResponse extends ResolvedSettings {
  pendingRestart: PendingRestart[];
}
```

Validation rules: `projectId` is required for `project`/`app`, `appKey` is required only for `app`,
and `appKey` without `projectId` is rejected. The resolver walks scopes from wide to narrow.
For `replace` (all v1 keys), `source` is the narrowest row and `sources` has one entry. For a future
`append` key, `source` is the narrowest contributor and `sources` lists every contributing scope in
wide-to-narrow order, so the UI can render "Project + Application" instead of pretending a single
scope owns the combined value. A default or cleared result has one source entry.

### 7.5 API

All settings routes are human-only. API requests from agent principals receive `403`; HTML pages
redirect unauthenticated humans to login. All mutations are POST (the existing `SameSite=Strict`
cookie is the CSRF control). `return_to` goes through `safeLocalPath`.

- `GET /api/settings?scope=global|project|app&project=<id>&app=<key>` returns `SettingsResponse`
  (`ResolvedSettings` plus pending-restart state; never provider key material).
- `POST /api/settings` accepts `application/json` or form fields:
  `{ scope, projectId?, appKey?, key, action: "set"|"clear"|"inherit", value? }`.
  JSON bodies are capped by the existing 64 KiB server limit, parsed with a strict schema, and
  arrays/prototype keys are rejected.
- `POST /api/settings/provider` accepts:
  `{ scope, projectId?, appKey?, provider, action: "set"|"clear"|"inherit", key? }`.
- `POST /api/apps/:app/restart?project=<id>` is a dedicated asynchronous route dispatched before
  the chat route; it stops the running instance and returns a notice. It is not handled by
  `handleChat` or the synchronous `handleRequest`. Restarting a stopped instance returns
  `200 { restarted: false, reason: "not_running" }` with a notice; the settings apply on the next
  start. The endpoint is idempotent for the UI restart button.

Action/value combinations are explicit: `set` requires a valid value; `clear` requires no value and
is rejected for non-clearable keys; `inherit` requires no value. Provider `set` requires a non-empty
key; `clear` writes a tombstone; `inherit` deletes the row. Inputs are bounded: model <= 256 chars,
provider id <= 128, key <= 4096, search `count` 1-20, timeouts 1-60 s, fetch content cap 1 KiB-1 MiB.

## 8. Provider credentials

### 8.1 Storage and resolution

Provider keys are stored in `provider_keys` encrypted with the existing AES-256-GCM helpers. The
coordinator loads or creates `<state>/hanse/secret.key` at `serve` startup and passes the key to the
settings service. If the key cannot be loaded/created, `serve` fails with a clear error (the feature
is unavailable rather than silently degraded). The API and UI never return key material; they return:

```ts
type ProviderKeyStatus =
  | { state: "set"; source: SettingsScope }
  | { state: "cleared"; source: SettingsScope }
  | { state: "missing" }
  | { state: "host"; source: "host-auth"; authType: "api" | "oauth" | "wellknown" }
  | { state: "error"; message: string };
```

Resolution is `global -> project -> app`. A set key wins; a cleared key suppresses both wider scopes
and the host auth file for that provider; no row at any scope falls back to the host
`HANSE_AUTH_FILE` entry. Decryption failure produces `state: "error"` and no key is injected; it does
not silently fall back to the host key. The web driver requires `type:"api"`; a host OAuth/well-known
entry is reported as `host` but is not usable by the DeepSeek web driver.

### 8.2 Auth injection

At instance start the coordinator **always reconciles** the per-instance auth file:

1. `SettingsService.snapshot()` reads the host `HANSE_AUTH_FILE` once; an invalid file is treated as
   `{}` with a warning. The service is the sole host-auth reader, so the hash and the written file
   come from the same snapshot.
2. The service applies effective provider keys: set/overwrite
   `auth[provider] = { type: "api", key }`; cleared entries are deleted. The host entry is preserved
   only when no scope yields an effective settings key for that provider. If a wider settings scope
   sets a key and a narrower scope is absent, that wider key is applied (the app-level "inherit"
   does not fall back to the host).
3. The launcher writes the merged result to `$XDG_DATA_HOME/opencode/auth.json` atomically (temp
   file + rename) with mode `0600`, creating the data directory with `0700`; it does not re-read or
   re-merge host auth. If the merged result is empty, the file is removed so a revoked key cannot
   persist from a previous run. The old `authSource` copy path is removed.

The launcher explicitly removes inherited `OPENCODE_AUTH_CONTENT`, `OMO_PROFILE`, `OCX_PROFILE`, and
`OPENCODE_CONFIG_DIR` from the instance environment, then sets `OMO_PROFILE` only when a profile is
applied. This prevents environment overrides from bypassing the reconciled auth/config.

The DeepSeek web driver reads the provider key from the same per-instance auth file. A driver config
names its provider (`deepseek` by default), so model and web search can share one key without
duplicating the secret in settings. The per-instance auth file contains all host providers (existing
behavior) and is readable by the agent under the same-uid trust model.

## 9. Web tools

### 9.1 Tool configuration

```ts
type WebToolConfig =
  | { driver: "builtin" }
  | {
      driver: "deepseek";
      options: {
        provider: string;
        count?: number;
        needContent?: boolean;
        timeoutMs?: number;
        maxContentChars?: number;
      };
    };
```

`builtin` has no options and is the default. `null` disables the tool at that scope. The driver
registry validates the options with a strict schema and provides UI field descriptors. The DeepSeek
driver receives an injectable `baseUrl` and `fetch` implementation for tests; production defaults to
`https://api.deepseek.com` and global `fetch`.

### 9.2 Built-in driver policy

| Effective search | OMO `websearch` MCP | Hanse search tool | `websearch` permission |
| --- | --- | --- | --- |
| `builtin` | enabled (requires OMO) | none | allow |
| `deepseek` | disabled via OMO `[opencode].disabled_mcps` | `hanse_web_search` | deny |
| `null` | disabled | none | deny |

| Effective fetch | opencode `webfetch` | Hanse fetch tool |
| --- | --- | --- |
| `builtin` | allow | none |
| `deepseek` | deny | `hanse_web_fetch` |
| `null` | deny | none |

`builtin` search depends on the OMO baseline. If `HANSE_OMO_PLUGIN` is unset, the settings UI and the
runtime warning report that built-in search is unavailable. The default is `builtin` to preserve
current behavior; `null` is the explicit "disabled" state.

The OMO profile includes `disabled_mcps: ["websearch"]` when search is `deepseek` or `null`. The
coordinator computes the final disabled-MCP list from the base config and the desired policy. OMO
5.1.35 unions `disabled_mcps`, so a base config that already disables `websearch` cannot be
re-enabled for `builtin`; this is documented and warned. The current base does not disable it.

### 9.3 Driver contract

```ts
interface WebDriver {
  readonly id: string;
  search(input: WebSearchInput, signal: AbortSignal): Promise<WebSearchOutput>;
  fetch(input: WebFetchInput, signal: AbortSignal): Promise<WebFetchOutput>;
}

interface WebDriverDefinition<O> {
  id: "builtin" | "deepseek";
  label: string;
  managed: boolean;
  optionsSchema: z.ZodType<O>;
  fields: DriverField[];
  create?(options: O, ctx: WebDriverContext): WebDriver;
}
```

The DeepSeek driver uses the standalone endpoints, Bearer auth, `AbortSignal.timeout`, bounded
response sizes, and normalized results:

```ts
interface WebSearchResult {
  title: string;
  url: string;
  snippet?: string;
  content?: string;
  siteName?: string;
  publishedAt?: string;
}
```

Tool output is JSON text. Search results include the query and the normalized result list; fetch
returns `{ url, title?, content }`. Results are labelled untrusted in the tool description and
capped by `maxContentChars`. The tool input bounds query length (<= 2048) and result count (<= 20).
Errors are reported as MCP tool errors with a safe message; API keys, request headers, and full
response bodies never appear in errors or logs.

### 9.4 `hanse_web` MCP server

- New CLI command: `hanse web-mcp` (also reachable as `node dist/index.js web-mcp`).
- Registered in the overlay only when at least one of search/fetch is `deepseek`.
- Server name: `hanse_web`; tools: `search` and `fetch`, exposed by opencode as
  `hanse_web_search` / `hanse_web_fetch` (opencode prefixes MCP tools with the sanitized server name;
  the actual names are asserted against the installed version in tests).
- Environment:
  - `HANSE_WEB_CONFIG`: JSON `{ "search"?: DeepSeekOptions, "fetch"?: DeepSeekOptions }`, only
    managed tools, no secrets;
  - `HANSE_OPENCODE_AUTH_FILE`: path to the per-instance auth file.
- `tools/list` re-checks the provider credential on every call and returns only managed tools whose
  driver config is valid and whose credential is available. `tools/call` re-checks the credential;
  unknown or disabled tools return a JSON-RPC error; credential/driver failures return a result with
  `isError: true` and a safe message.
- The server uses an asynchronous line-delimited JSON-RPC loop and handles interleaved requests and
  notifications; it does not share the handoff server's synchronous loop.
- If a managed driver is configured but no credential is available, the server may be registered
  with an empty tool list; the settings UI reports the missing credential. Future optimization:
  omit the server entirely when no tool can be served.

## 10. Model and OMO profiles

### 10.1 OpenCode overlay

The overlay gains only the top-level model:

```ts
interface OpencodeOverlay {
  model?: string;
  mcp?: Record<string, McpLocalServer>;
  // ... existing fields
}
```

`model` is the effective `llm.model`, always present (default `deepseek/deepseek-flash`). It controls
the main agent and opencode-native agents for new sessions. OMO agent/category models are handled by
the profile in §10.2; no `agent` override map is emitted (OMO filters those for built-ins and would
conflict with the profile).

### 10.2 Per-app OMO profile

Because OMO regenerates built-in agents and resolves category models internally, the coordinator
writes an OMO profile per app and selects it with `OMO_PROFILE`:

```jsonc
{
  "profiles": {
    "hanse-app-<hash>": {
      "[opencode]": {
        "disabled_mcps": ["websearch"],
        "agents": {
          "sisyphus": { "model": "<selected>" },
          "hephaestus": { "model": "<selected>" },
          "oracle": { "model": "<selected>" },
          "librarian": { "model": "<selected>" },
          "explore": { "model": "<selected>" },
          "multimodal-looker": { "model": "<selected>" },
          "prometheus": { "model": "<selected>" },
          "metis": { "model": "<selected>" },
          "momus": { "model": "<selected>" },
          "atlas": { "model": "<selected>" },
          "sisyphus-junior": { "model": "<selected>" }
        },
        "categories": {
          "visual-engineering": { "model": "<selected>" },
          "artistry": { "model": "<selected>" },
          "ultrabrain": { "model": "<selected>" },
          "deep-low": { "model": "<selected>" },
          "deep-high": { "model": "<selected>" },
          "quick": { "model": "<selected>" },
          "unspecified-low": { "model": "<selected>" },
          "unspecified-high": { "model": "<selected>" },
          "writing": { "model": "<selected>" }
        }
      }
    }
  }
}
```

Profile storage and safety:

- The config path is `os.homedir()/.omo/omo.jsonc` (the image path is `/home/node/.omo/omo.jsonc`);
  an injectable path is provided on `OmoProfileStore` for tests. There is no `HANSE_OMO_CONFIG`
  environment variable: OMO 5.1.35 does not support an arbitrary config path, so writing elsewhere
  would silently fail.
- The profile name is per app: `hanse-app-<sha256(projectId + ":" + appKey)[:16]>`. Stale profiles
  from deleted apps remain until cleanup; this is harmless but documented.
- Agent and category names are derived from the base `[opencode].agents`/`categories` objects, plus
  a version-pinned required set (`sisyphus`, `deep-high`) for OMO 5.1.35. The generator validates
  the resulting names against the base and the pinned set; a future OMO version requires updating
  the pinned set. Do not invent names outside the verified set.
- The profile copies the base entries and sets `model`; it preserves other keys such as reasoning
  settings. `disabled_mcps` is computed from the base plus the desired web policy.
- Writes are serialized by a process-local async mutex and use temp-file + atomic rename. A single
  `serve` process per state dir is assumed; multiple coordinators writing the same OMO file are not
  supported and are documented as a risk. OMO's own startup migrations may also rewrite the file;
  the coordinator writes the profile before spawn and serializes its own writes.
- The managed file is expected to be JSON-compatible (the repo file is valid JSON). If `JSON.parse`
  fails (for example, comments were added), the coordinator logs a warning and launches without
  `OMO_PROFILE`; it does not rewrite the file. A future version may add a JSONC parser.
- If the file or directory is missing or not writable, the coordinator records a warning and
  launches without `OMO_PROFILE`; the base pins apply. The settings UI shows the warning. The
  running settings hash records `profileApplied: false` so the degraded state is visible.
- Project `.omo/omo.jsonc` layers from the app cwd toward `$HOME` can override the profile. This is
  OMO behavior; the coordinator uses an app-specific profile name and verifies the effective agent
  models after start via `GET /agent` (warning-only, like policy verification). A live smoke covers
  the main/agent propagation; category propagation is verified by a prompt-level smoke.
- OMO 5.1.35's editor schema is stale; the design notes this for operators.

### 10.3 Defaults, validation, and sessions

- Default model: `deepseek/deepseek-flash`, matching the current image baseline.
- `llm.model` is not clearable. The model string must match `^[^/\s]+/\S+$` and be <= 256 chars;
  the provider is the part before the first `/`.
- Availability and authentication are not validated by the settings API in this stage. A missing
  provider key produces a UI warning; an unavailable model fails when opencode uses it.
- The selected model applies to new sessions and to OMO agents/categories through the profile.
  Existing opencode sessions may retain their stored session model; the settings UI states this and
  the restart action does not rewrite existing sessions. A future stage can add a "new session"
  convenience or session-model migration.

## 11. Instance lifecycle and restart

### 11.1 Effective settings hash

`SettingsService.effectiveHash(target)` returns a stable hash over the effective snapshot:

- the effective model;
- the effective search/fetch driver configs and derived permission values;
- the effective provider-key state and a monotonic version or ciphertext hash (not the plaintext);
- a hash of the merged auth file content (including host auth entries);
- a hash of the desired OMO profile content and the derived `disabled_mcps`;
- the resolved defaults.

`InstanceManager.ensure()` takes a single snapshot, applies it, and records the hash of that same
snapshot in the running entry, plus an `appliedProfile` flag. `pendingRestart(appId)` returns true
when `!appliedProfile || runningHash !== currentEffectiveHash`; the entry exposes reasons such as
`settings_changed`, `auth_changed`, `profile_changed`, or `profile_not_applied`. `appliedProfile` is
runtime state, not part of the deterministic settings hash: keeping it out of the hash prevents an
unwritable profile from comparing equal and hiding a degraded instance. The hash is deterministic
(fixed key order) and never contains secret material.

`ensure()` uses a per-app in-flight promise: concurrent callers for the same app wait for the same
launch. Running state is checked with both `exitCode === null` and `signalCode === null`.

### 11.2 Restart

- Saving settings never kills a running turn.
- The app page, chat context, and settings page show "Settings changed — restart the agent to
  apply" when `pendingRestart` is true. The marker is computed on render; no live SSE update is
  required in this stage. The settings page also lists affected running apps.
- `POST /api/apps/:app/restart?project=<id>` (human-only) is an asynchronous route dispatched before
  the chat route. It participates in the same per-app lock as `ensure()`: if an `ensure()` is in
  flight, the restart waits for it (or invalidates its epoch) and then stops the launched instance,
  so a pre-save launch cannot return "stopped" and then start with the old snapshot. It stops the
  instance: SIGTERM, wait a bounded timeout, then SIGKILL if needed; it awaits exit, removes the
  running entry, and records the instance as stopped. Sessions live in the per-instance opencode DB,
  so they survive. The next message starts a new process with the new overlay, auth file, and OMO
  profile.
- Restarting a stopped instance returns `200 { restarted: false, reason: "not_running" }` with a
  notice. Project/global changes mark every affected running app as pending because the hash
  comparison is per app.
- The restart action is explicit; there is no auto-restart while a session is busy. The UI warns
  that an active turn will be interrupted.

### 11.3 Settings pages

- `/settings` — global.
- `/projects/:id/settings` — project.
- `/projects/:id/apps/:appKey/settings` — app.

Each page uses the existing `appShell` and `pageHeader` primitives and adds a Settings entry to the
sidebar. Each setting shows its effective value, source, raw scoped state, and a control:
`Inherit` / `Set` / `Clear`. `Clear` is rendered only for clearable keys. Provider keys show
`configured` / `inherited` / `cleared` / `missing` / `host auth` / `error` and never return the key.
Driver selects reveal per-driver fields; built-in has none. A small `assets/settings.js` toggles the
visible driver field group; it is added to the asset allowlist and the Tailwind build. Settings
responses and pages send `Cache-Control: no-store`; provider-key inputs use
`autocomplete="new-password"`; provider ids and messages are HTML-escaped.

Project and application pages link to their settings scope and show the pending-restart marker.
`DashboardDeps`/`HttpDeps` gain a settings/pending callback so server-rendered pages can compute the
marker without duplicating resolver logic.

## 12. Failure modes

| Failure | Behavior |
| --- | --- |
| Invalid stored setting | Resolver skips it, adds a warning, falls back to the wider scope/default. |
| Unknown driver id | Settings write rejected; stored invalid value skipped on read. |
| Missing provider key | Managed tool omitted from `tools/list`; settings UI warns. |
| Corrupt cipher / undecryptable key | Status `error`; no key injected; UI warning; no silent host fallback. |
| Invalid `secret.key` at startup | `serve` fails closed with a clear error. |
| `OPENCODE_AUTH_CONTENT` inherited | Scrubbed; reconciled auth file is authoritative. |
| Host auth invalid/unreadable | Treated as `{}` with a warning; effective settings keys still apply. |
| Provider key removed (inherit) | Next launch reconciles; the stale per-instance auth file is removed/rewritten. |
| OMO config not writable / parse failure | Warning; launch without `OMO_PROFILE`; base pins apply; hash records `profileApplied: false`. |
| OMO migration/profile write race | Coordinator writes before spawn and serializes its writes; OMO's own migration is documented as a residual risk. |
| Project `.omo` layer overrides profile | Allowed by OMO; post-start `/agent` verification warns on model mismatch. |
| DeepSeek 401/403 | Tool returns a safe auth error; key never logged. |
| DeepSeek 429/5xx/timeout | Tool returns a safe retryable error; no automatic retry in v1. |
| Instance busy during restart | Operator requested it; SIGTERM/timeout/SIGKILL; the turn is interrupted; UI warns. |
| Restart when not running | Defined no-op/`409`; settings apply on the next start. |
| Coordinator crash leaves orphan processes | In-memory `#running` is lost; DB rows may say running. Documented residual risk. |

## 13. Security and trust

- Settings routes are human-only. API agent principals receive `403`; HTML unauthenticated humans
  are redirected to login.
- Provider keys are encrypted at rest, never returned by the API, never written to logs, and never
  placed in `OPENCODE_CONFIG_CONTENT`. They are written to the per-instance `auth.json` with mode
  `0600` using an atomic temp-file + rename; the data directory is `0700`.
- Agents run as the same uid as the coordinator and can read their `auth.json`, `/data/state`, and
  `/proc/<pid>/environ`; the per-instance auth file also contains all host providers. This design
  does not change that trust model.
- AES-GCM currently has no AAD binding to scope/provider; an attacker with database write access
  could swap ciphertexts. Key rotation and restoring a DB without `secret.key` are not addressed.
  These are documented residual risks.
- Web content is untrusted. Tool descriptions label it; output is size-capped; the model is told not
  to follow instructions from fetched content.
- The driver validates URLs (http/https, no embedded credentials, bounded length). DeepSeek fetches
  the URL server-side; future local drivers must add private-address/redirect protections.
- Tool inputs, settings values, and provider statuses are escaped in server-rendered HTML;
  `return_to` uses `safeLocalPath`. CSRF uses the existing `SameSite=Strict` cookie plus POST-only
  mutations.
- OMO config and auth writes are atomic and restricted to coordinator-controlled paths. Project
  `.omo` layers are trusted app content under the existing trust model.
- DeepSeek is per-request priced; the tool enforces count/timeout/content caps. A per-instance cost
  budget is not implemented in this stage.

## 14. Testing

Acceptance criteria are given/when/then and include the injection points needed to avoid touching
real home/state directories:

- `test/settings.test.ts` — given global/project/app rows, when resolved, then the narrowest value
  wins; `null` clears; `append` concatenates or clears and reports all contributing `sources`;
  `llm.model` rejects clear; invalid stored values produce warnings and fall back.
- `test/settings-store.test.ts` — migration v3, CRUD, uniqueness, CHECK constraints, encrypted
  provider-key round-trip, tombstone clears ciphertext.
- `test/auth-inject.test.ts` — host auth + set/clear/inherit; global-set/app-inherit uses the wider
  settings key, not the host; stale file removal; mode `0600`; invalid host JSON; corrupt cipher;
  `OPENCODE_AUTH_CONTENT` scrub.
- `test/omo-profile.test.ts` — profile generation from base + pinned names; a pinned OMO 5.1.35
  assertion that `disabled_mcps` is unioned and that managed search disables OMO `websearch`;
  built-in search without OMO warns; JSON parse failure fallback; unwritable file fallback;
  concurrent read-modify-write; `OMO_PROFILE`/`OCX_PROFILE`/`OPENCODE_CONFIG_DIR` scrub.
- `test/manager.test.ts` — single-flight `ensure`; restart awaits/invalidates an in-flight
  `ensure`; `signalCode`; stop/restart timeout; pending hash including auth/profile content and
  `appliedProfile`; stopped-instance `200 {restarted:false}`.
- `test/web-deepseek.test.ts` — request shape, auth header, baseUrl injection, normalization, caps,
  401/429/timeout, provider validation, no key leakage.
- `test/web-mcp.test.ts` — `tools/list` visibility, credential re-check, unknown/disabled JSON-RPC
  errors, `isError` driver failures, interleaved requests.
- `test/instance.test.ts` / `test/launcher.test.ts` — overlay `model`, conditional `hanse_web` MCP,
  permission combinations, `OMO_PROFILE`, auth merge.
- `test/settings-http.test.ts` — human-only API/HTML behavior, JSON/form parsing, three-state
  actions, provider keys never returned, `pendingRestart[]` shape, restart route, restart of a
  stopped instance returns `200 {restarted:false}`, asset allowlist.
- `test/permission-policy.test.ts` — built-in/managed permission combinations and exact key order.
- Live smoke: run inside the built image as uid 1000 with a writable `/home/node/.omo`, start a real
  opencode 1.19.3 + OMO 5.1.35 instance with a selected non-default model; assert the profile file
  was written, `GET /agent` reports the selected model for the pinned agents, and a prompt-level
  category delegation uses it. With managed search, assert OMO `websearch` is absent and
  `hanse_web_search` is exposed; with built-in search and OMO absent, assert the warning. A real
  DeepSeek web call is optional and depends on a key; deterministic driver tests use a local fake
  HTTP server.
- Verification gate: `npm run lint && npm run typecheck && npm test && npm run build`.

## 15. Rollout and compatibility

- Migration v3 is additive; existing databases upgrade in place. No data backfill.
- Defaults preserve current behavior: `builtin` web drivers keep the existing built-in tools and
  permissions; the default model matches the current OMO pin.
- Existing deployments without settings rows and without provider keys keep using the host
  `auth.json` and the image OMO config.
- The OMO profile file is regenerated at instance start; a new image can change the base config
  without invalidating app profiles.
- Existing sessions may retain their session model; the setting applies to new sessions and to OMO
  agents. The UI states this.
- Rollback: revert the code, drop `settings` and `provider_keys`, and **delete the
  `schema_migrations` row for version 3**; otherwise the reverted-to new code will think v3 is
  applied and never recreate the tables. Running instances must be restarted to return to the old
  overlay.

## 16. Open questions

None. Owner decisions are recorded in `docs/open-questions.md`:

1. Settings live in the coordinator DB.
2. Web tools use a separate `hanse_web` MCP server.
3. Model-provider keys are edited in settings and stored encrypted.
4. Built-in web tools are a `builtin` driver option; managed drivers disable the corresponding
   built-in.
5. Driver fields are per-driver; built-in has none.
6. Settings apply on an explicit restart, with a pending marker.
7. `llm.model` is a scalar with a default and is not clearable; the explicit-empty requirement
   applies to the web tool settings. The UI offers Inherit/Set, and the API rejects Clear.

## 17. Design review

### Round 1 (`oracle`)

The round-1 review did not emit a final verdict: the session hit its output length limit mid-review.
Its last explicit triage was **"Blockers (must fix before plan)"**. The design was revised as
follows:

| Finding | Disposition |
| --- | --- |
| B1 `llm.model` clear semantics | `llm.model` is non-clearable; API rejects clear; UI shows Inherit/Set only. |
| B2 OMO shared-profile serialization + `ensure()` race | Added per-app single-flight and a serialized OMO profile mutex; hash from one snapshot. |
| B3 `HANSE_OMO_CONFIG` path mismatch | Removed the env variable; path is `os.homedir()/.omo/omo.jsonc` with an injectable test path. |
| B4 Stale per-instance `auth.json` on inherit/removal | Auth is always reconciled; empty merged result removes the file; tests added. |
| B5 Restart route swallowed by chat | Restart is a dedicated async route before chat dispatch. |
| B6 `signalCode` / no per-app stop | Running check uses both exit and signal; added bounded stop/remove. |
| B7 `OPENCODE_AUTH_CONTENT` precedence | Added to the scrub list; profile/config env is set deterministically. |
| S1 provider-key tombstone schema | Nullable cipher/nonce, cleared check, ciphertext cleared on tombstone. |
| S2 pending hash gaps | Hash now includes auth content, profile content/applied flag, monotonic key versions. |
| S3 pending marker data path | `DashboardDeps`/`HttpDeps` gain settings/pending callback. |
| S4 existing sessions | Claim narrowed; existing-session limitation documented and surfaced in the UI. |
| S5 JSONC parsing | JSON-compatible managed file; parse failure warns and falls back. |
| S6 hardcoded OMO lists | Names derived from base + a version-pinned required set, validated. |
| S7 project `.omo` layers | Documented; app-specific profile name + post-start `/agent` warning. |
| S8 OMO migration race | Coordinator serializes its writes and writes before spawn; residual risk documented. |
| S9 auth file mode | Atomic write + `chmod 0600`; data dir `0700`. |
| S10 auth failure/status | Added `error` state, host auth type, fail-closed key startup. |
| S11 API JSON/form | JSON/form contract, 64 KiB cap, strict schema, 400s. |
| S12 human-only HTML/API | 403 for API, login redirect for HTML, explicit human check. |
| S13 UI assets/warnings/scoped rows | Added `settings.js` allowlist, scoped rows, warnings, clearable-only Clear. |
| S14 restart busy/timeout | Bounded SIGTERM/SIGKILL stop and defined not-running behavior. |
| S15 input bounds/action rules | Explicit bounds and action/value combinations. |
| S16 append YAGNI/ambiguity | Kept because the owner requested type-based merge; semantics defined and tested. |
| S17 agent overlay redundancy | Removed `agent` overrides; profile handles OMO agents. |
| S18 builtin provenance/default | Defined builtin search as OMO MCP; warns when OMO is absent; default documented. |
| S19 web error semantics | Credential re-check; JSON-RPC for unknown/disabled; `isError` for driver failures. |
| S20 web bounds/baseUrl/provider | Exact bounds, injectable baseUrl/fetch, provider validation. |
| S21 testability | Added given/when/then, injection points, concurrency/live smoke. |
| S22 rollback v3 row | Documented deleting the `schema_migrations` v3 row. |
| S23 schema hardening | Added key/provider checks, `json_valid`, tombstone check. |
| S24 env scrubbing | `OPENCODE_AUTH_CONTENT`, `OMO_PROFILE`, `OCX_PROFILE`, `OPENCODE_CONFIG_DIR`. |
| S25 base-disabled websearch | Computed final disabled list; union limitation documented. |

Unverified assumptions from round 1 remain to be closed by the round-2 review and live smoke: no live
opencode+OMO instance was run; DeepSeek endpoints were not called live; the container's `HOME`/uid
and `~/.omo` writability are assumed; OMO profile behavior with project layers/migrations is
source-inspected only; native opencode `websearch` gating is source-inspected; `disabled_mcps` union
is version-specific (5.1.35) and needs a pinned test.

### Round 2 (`oracle`)

Verdict: **APPROVE WITH CHANGES**, no blocking findings. The remaining pre-plan changes were folded
as follows:

| Finding | Disposition |
| --- | --- |
| `profileApplied` inside `effectiveHash` could hide a degraded instance | `effectiveHash` now hashes the desired profile content only; `appliedProfile` is running-entry state and makes `pendingRestart` true when false. |
| `ResolvedSettings` lacked pending state | Added `pendingRestart: PendingRestart[]` and the HTTP/UI tests. |
| Restart vs in-flight `ensure()` race | Restart participates in the per-app lock, awaits/invalidates the in-flight launch, then stops. |
| `llm.model` non-clearable not in owner decisions | Recorded as owner decision 7 and in `docs/open-questions.md`; the empty-override requirement is scoped to web tools. |
| `disabled_mcps` union/native gating had no pinned test | Added a pinned OMO 5.1.35 assertion and live-smoke assertions for managed/builtin search. |
| Live smoke did not pin the image/uid/OMO path | Live smoke now runs in the built image as uid 1000 with a writable `/home/node/.omo` and asserts the profile file. |
| Restart not-running behavior left to implementation | Chosen `200 {restarted:false, reason:"not_running"}` and tested. |
| Auth reconcile wording could ignore a wider settings key | Clarified host fallback only when no scope yields an effective key; added global-set/app-inherit test. |
| `append` source ambiguous across scopes | Added `sources[]`; `source` is the narrowest contributor. |

Design review gate: **passed** (approve with changes, all findings folded).

## 18. References

- `docs/current-state.md`
- `docs/conventions.md`
- `docs/process.md`
- `docs/decisions/0002-config-injection-via-OPENCODE_CONFIG_CONTENT.md`
- `docs/decisions/0005-permission-policy-guardrail.md`
- `src/opencode/instance.ts`, `src/opencode/launcher.ts`, `src/opencode/manager.ts`,
  `src/opencode/policy.ts`
- `src/mcp/protocol.ts`, `src/mcp/server.ts`
- `src/store/migrations.ts`, `src/store/database.ts`, `src/secrets/`
- `src/http/handler.ts`, `src/http/server.ts`, `src/http/chat.ts`, `src/http/ui.ts`,
  `src/http/dashboard.ts`
- `omo/omo.jsonc`, `Dockerfile`
- DeepSeek Search/Fetch API reference (standalone `/v1/tools/search`, `/v1/tools/fetch`)
- OMO 5.1.35 source/tarball: config profiles, `OMO_PROFILE`, `disabled_mcps` merge, project `.omo`
  layers
- opencode 1.19.3 source: config merge order, plugin/config hooks, auth (`auth.json`,
  `OPENCODE_AUTH_CONTENT`), session/agent model selection, MCP tool naming
