# Design - Global custom model providers

Status: **approved** - round 1 review (`oracle`) CHANGES REQUESTED; round 2 PASS (2026-10-27),
eight minors folded into revision 3. Implementation permitted.
Scope: a coordinator-owned, global registry of OpenAI-compatible model providers, its
`OPENCODE_CONFIG_CONTENT` projection, the settings UI/API, and the provider-key integration.
Out of scope: implementation in this document; project/app-scoped provider definitions, model
auto-discovery, arbitrary npm adapters, and master-agent management.

## 1. Problem

Hanse can select any `provider/model` string and store an API key per provider id, but it cannot
describe a provider that is not known to `opencode`'s bundled catalog. A self-hosted
OpenAI-compatible gateway therefore requires a hand-written `opencode.json` in every application
repository. That is per-repository work, invisible to the settings UI, and easy to lose on a fresh
checkout.

The key store already handles the secret half: `provider_keys` is keyed by provider id, encrypted at
rest, and reconciled into each instance's `auth.json`. The missing half is a non-secret provider
definition: adapter, base URL, and model list. This stage adds that definition once, globally, and
projects it into every managed instance.

## 2. Requirements

| ID | Requirement |
| --- | --- |
| P1 | An operator can create, edit, and delete a global custom model provider with an id, a display name, a base URL, and a non-empty model list. |
| P2 | The provider id is the `opencode` provider id. It must match the id used by `provider_keys` and by the `llm.model` setting. |
| P3 | Every running and new application receives all validated custom providers as a `provider` block in `OPENCODE_CONFIG_CONTENT`, merged under Hanse's existing overlay keys (`model`, `mcp`, `plugin`, `instructions`, `permission`). |
| P4 | The API key is never written to the overlay. It continues to live in the encrypted `provider_keys` store and the per-instance `auth.json`. |
| P5 | A provider definition change marks every running application restart-required. No agent restarts silently. An empty registry does not change any existing settings hash or overlay. |
| P6 | Custom providers appear in the existing Providers (key) block even before `llm.model` references them, so the operator can add the key immediately. |
| P7 | `llm.model` remains a free-form `provider/model` string. The model input offers the custom provider/model pairs as suggestions, not as a closed enum. |
| P8 | Deleting a provider that any `llm.model` row references is refused with a clear `409 provider_in_use` response naming the references. |
| P9 | The feature adds no runtime dependency and stays within the existing Node/ESM/Tailwind/vanilla-JS stack. |
| P10 | Existing installations with no custom providers keep their current launch overlay, settings hash, and behavior. A project-level `opencode.json` provider with the same id is deep-merged per provider key; the overlay wins on `npm`, `name`, `options.baseURL`, and its `models` map is authoritative. Project model extras are not relied on, while other project keys survive. |

## 3. Verified upstream facts (opencode 1.19.3)

These facts are taken from the `opencode` 1.19.3 source/docs and were confirmed with the installed
binary:

- A config-defined provider uses `provider.<id> = { npm, name, options.baseURL, models }`; a custom
  provider needs at least one model.
- `auth.json` is read from `$XDG_DATA_HOME/opencode/auth.json`; an entry
  `{"<id>":{"type":"api","key":"..."}}` is used automatically for a provider that already exists in
  config or the bundled catalog. `options.apiKey` wins over the auth entry.
- `OPENCODE_CONFIG_CONTENT` is merged after the project `opencode.json` and wins on conflicting
  keys. It does not remove unrelated project keys.
- A local `opencode debug config` run on 1.19.3 with a project `opencode.json` provider and
  `OPENCODE_CONFIG_CONTENT` setting `provider.<id>.name` kept the project's `options.baseURL` and
  `models`. The provider object is deep-merged per key, not replaced as a whole. That run did not
  cover per-model-id merge; this design treats `models` as the overlay-defined map and does not rely
  on project extras. A project model may still merge, but a model Hanse selects must be in the
  overlay or a bundled provider.
- `@ai-sdk/openai-compatible` is bundled with 1.19.3; the app container does not install it.
- A missing `limit.context` becomes `0`, which disables opencode's overflow compaction.

## 4. Alternatives

| Alternative | Cost | Risk | Verdict |
| --- | --- | --- | --- |
| Do nothing; document the per-repository `opencode.json` workaround | None | Per-repository drift; no UI; no central validation; the public repository must not contain a LAN address | Rejected |
| A single `llm.providers` JSON setting in `settings` | Low | The settings row editor becomes a JSON editor; CRUD, uniqueness, and validation are reimplemented in the resolver; a nested list is hard to audit | Rejected |
| A global `model_providers` registry + overlay projection (this design) | Medium | One migration, one service, one HTTP/UI block, manager wiring | **Selected** |

The registry follows the existing shape of `provider_keys` (domain table, service, human-only API)
rather than turning the hierarchical `settings` value editor into a nested-object editor.

## 5. Decisions

### D1 - One global registry, no project/app scopes

The registry is global. The provider definition is an environment-level fact (a gateway URL and its
model list), not a portable repository fact. `llm.model` keeps its existing global -> project -> app
resolution, so an application can choose a different model from the same global provider.

A project/app override is deliberately deferred. Adding it later is a schema extension (scope
columns and a name-keyed resolver), not a rewrite of the overlay contract.

### D2 - Logical data model and validation

One row per provider:

| Field | Type | Rule |
| --- | --- | --- |
| `id` | text, primary key | 1-128 chars, `^[a-z0-9][a-z0-9._-]*$`, not `__proto__`/`constructor`/`prototype` |
| `name` | text | 1-128 chars, no control characters; defaults to `id` when blank |
| `npm` | text | fixed to `@ai-sdk/openai-compatible` in this stage |
| `base_url` | text | `http`/`https`, 1-2048 chars, no userinfo, no query, no fragment; normalized through `new URL()` and trailing path slashes trimmed |
| `models_json` | text | JSON array of 1-64 models, see below |
| `created_at`, `updated_at` | text | ISO timestamps |

A model entry:

| Field | Type | Rule |
| --- | --- | --- |
| `id` | text | 1-256 chars, `^[A-Za-z0-9@][A-Za-z0-9._:/@+-]*$`, not `__proto__`/`constructor`/`prototype`, unique within the provider |
| `name` | text, optional | 1-128 chars, no control characters, no `|` (the form line separator) |
| `limit.context` | integer | 1-10,000,000 |
| `limit.output` | integer | 1-10,000,000; no cross-field rule beyond both being positive |

The charset deliberately excludes whitespace, control characters, `|`, `"`, `<`, `&`, and `>`, so a
validated id is safe in the form line format, the JSON object, and HTML text without relying on
render-time escaping alone. The composed `llm.model` value `providerId + "/" + modelId` must also
fit the existing 256-character model-setting bound; a provider/model pair that cannot be selected
is rejected at write time.

`models_json` is validated on every write. Reads run one shared snapshot validator; invalid rows are
excluded from `list`, `overlay`, `hash`, and the provider-id callback. A manual DB edit cannot
prevent an app from starting. The physical DDL adds `CHECK(json_valid(models_json))` for parity with
`settings`; DDL and migration mechanics belong to `database-engineer`.

**Size caps.** The registry is capped at 32 providers. A create or update is rejected when the
final serialized `OPENCODE_CONFIG_CONTENT` would exceed 64 KiB of UTF-8 bytes, measured with
`Buffer.byteLength` and including the existing overlay keys; the provider projection alone is not
the budget. This keeps the single environment string well below the roughly 128 KiB per-string
Linux limit. The operator sees the limit in the error message.

**Id collision warnings.** The service exposes a non-blocking warning when an id matches a curated
set of common bundled provider ids, or when any `provider_keys` row across all scopes (or a
host-auth entry) already uses that id. The curated set is a constant: `openai`, `anthropic`,
`google`, `deepseek`, `openrouter`, `groq`, `mistral`, `xai`, `cerebras`, `github-copilot`,
`amazon-bedrock`, `azure`. The warning says that the overlay will replace that provider's adapter,
name, base URL, and models, and that an existing key will be sent to the new base URL. This is a
warning, not a block; an operator may intentionally override a bundled provider. Unknown bundled
ids cannot be detected without a full `models.dev` catalog, which is out of scope.

### D3 - Overlay projection

`OpencodeOverlay` gains an optional `provider` field. The service maps each validated provider row
to:

```json
{
  "npm": "@ai-sdk/openai-compatible",
  "name": "<display name>",
  "options": { "baseURL": "<base url>" },
  "models": {
    "<model id>": {
      "name": "<display name>",
      "limit": { "context": 1000000, "output": 64000 }
    }
  }
}
```

`limit` is always emitted. `tool_call`, `reasoning`, and `attachment` are not exposed in this stage;
opencode's default for a new config model is `tool_call: true`, which is required for an agent
provider. A provider with no models is rejected before it reaches the overlay.

The overlay remains the highest non-managed config layer. A project `opencode.json` provider with a
different id still applies. A same-id provider is deep-merged per key: the overlay wins on `npm`,
`name`, `options.baseURL`, and the model entries it defines; an unrelated project key inside that
provider survives. The overlay's model map is authoritative for Hanse-selected models. When the
registry is empty, the overlay has no `provider` key at all (not `provider: {}`), so the
`OPENCODE_CONFIG_CONTENT` bytes and spec hash stay unchanged.

The projection is added to both the runner spec path and the legacy `BuildOverlayOptions` /
`LaunchInput` path so the two helpers cannot drift.

### D4 - Service and API

One `ModelProviderService` owns the table:

- `snapshot(): ModelProviderSnapshot` - one validated read used by every consumer:
  `{ providers, overlay, hash }`.
- `list(): ModelProvider[]` - `snapshot().providers`.
- `get(id): ModelProvider | undefined`.
- `create(input, actor): ModelProvider` - validates, inserts, records `provider.created`.
- `update(id, input, actor): ModelProvider` - id is immutable; updates name/baseUrl/models, records
  `provider.updated`.
- `delete(id, actor): void` - refuses when referenced, deletes, records `provider.deleted`.
- `collisionWarnings(id, existingProviderIds): string[]` - the non-blocking D2 warnings.

`ModelProviderSnapshot.overlay` and `.hash` are both `undefined` exactly when `providers` is empty.
The hash covers only `{id, name, baseUrl, models}`, with models sorted by id; it excludes
`created_at`/`updated_at`, so a no-op update does not mark apps stale.

HTTP (human-only, same-origin; settings pages and JSON callers):

- `GET /api/settings/model-providers` -> `{ providers: ModelProvider[], warnings: Record<string, string[]> }`.
- `POST /api/settings/model-providers` with `action=create|update|delete`, `id`, `name`, `baseUrl`,
  and `models` (form: one line per model, `id | context | output | optional name`; JSON: the
  structured array). Browser form submissions use the existing settings fragment contract and
  refresh the `agent` section plus `restart`/`warnings`.
- The create/update JSON response includes `warnings` for the affected id. The HTML row shows the
  same warnings; they never block.
- The path is registered in `isSettingsRoute` before dispatch; the `GET` and `POST` branches are
  reachable through `handleSettings`.
- The new route calls `crossSiteMutation` before any mutation.

Errors: `400` validation, `404 provider_not_found`, `409 provider_exists`, `409 provider_in_use`
with the referencing `llm.model` scopes, `503 model_providers_not_configured`.

### D5 - Settings UI

On Global settings only, a **Custom model providers** block sits next to the existing Providers
(key) block:

- One row per provider: display name/id, base URL, model count, key status, collision warnings,
  edit form, delete action.
- An **Add custom provider** disclosure with id, name, base URL, and a models textarea.
- The models textarea uses one line per model: `id | context | output | optional display name`.
  A `|` in a model display name is rejected by validation.
- Delete asks for confirmation and is refused server-side when the provider is in use.
- Project and app settings show a short hint that custom providers are global, with a link to
  `/settings#custom-providers`; the key block remains scope-aware.
- The `llm.model` input gains a `<datalist>` of `<provider>/<model>` pairs from the global registry.
  Unknown values are still accepted.
- The Base URL hint states that the URL is resolved **inside the app container**: use the host's LAN
  address, not `127.0.0.1`/`localhost`, and not the coordinator service name. A loopback URL gets a
  non-blocking warning. A non-loopback plain-`http` URL also gets a warning: the provider key would
  travel in cleartext.

The block reuses the existing `providers`, `setting-row`, `provider-add`, and settings-fragment
primitives. No new client framework or bundler is introduced.

### D6 - Provider keys

`SettingsService` accepts an optional `providerIds` callback. `#providerIds` adds those ids to the
resolved status map. This makes a newly created custom provider appear in the existing Providers
block (with `Missing` status) before any model references it, and makes the missing-key warning
work for a selected custom provider. The callback reads the same validated snapshot as the overlay;
an invalid row never appears.

Keys remain scoped global/project/app and encrypted. The custom provider block never displays or
accepts a key; it links the operator to the existing key block. Registry-only ids add `missing`
entries; they do not add auth material because a `missing` id contributes no entry to
`mergedAuth` (`src/settings/service.ts:246-257`). Any id with a key row or host auth was already in
the set (`src/settings/service.ts:601-607`).

### D7 - Restart and settings hash

`settingsHashFor` gains an optional `providersHash` argument. The manager reads
`modelProviderService.snapshot()` once per operation and passes `snapshot.hash` to **both** the
launch call (`src/opencode/manager.ts:791`) and the pending-restart call
(`src/opencode/manager.ts:1173`). An empty registry yields `undefined`, so an installation with no
custom providers keeps its current hash. Adding, editing, or deleting a provider changes the hash,
which the existing pending-restart path reports as `settings_changed`; the operator restarts
explicitly.

`providersHash` is required for the two cases the existing status map cannot see: editing a
provider without changing its id, and deleting a provider whose `provider_keys` row still makes the
id appear in `resolved.providerKeys`. Both call sites must use it; updating only one makes apps
either report `settings_changed` forever or report no marker at all.

The manager reads one `snapshot()` per operation for both the overlay and the hash. Providers are
ordered by id in both, and models are ordered by id in the hash, so the bytes and the hash are
deterministic. The settings status map uses its own validated read; it is not required to be the
same transaction as the manager's launch snapshot. A model switch to a provider added after the last
restart is safe only after that restart; the pending-restart marker tells the operator to restart
first. No automatic restart is added.

### D8 - Delete guard

`delete` reads every `settings` row with `key = 'llm.model'`, parses `value_json`, skips `null`,
non-string values, and parse failures, and checks whether the resulting string starts with
`<id>/`. Any match refuses the delete and returns the project/app identifiers. The check and the
delete run in one synchronous transaction. This is conservative: it covers global, project, and
app rows, including rows that are currently shadowed by a narrower scope. The operator changes
those models first. Tombstone/invalid rows are ignored.

Provider keys are not deleted with the definition. They are independent scoped secrets; the
operator can clear them separately from the Providers block. Deleting and recreating the same id
reuses the retained key against the new base URL; the UI warns about this.

### D9 - Security

- `baseURL` and the model list are non-secret and are intentionally visible to the application
  through `OPENCODE_CONFIG_CONTENT`. The API key stays in `auth.json` (`0600`) and the encrypted
  `provider_keys` table.
- Only `http`/`https` URLs without userinfo/query/fragment are accepted. The overlay cannot point
  opencode at `file:`, `data:`, or a credential-bearing URL. Loopback URLs are accepted but warned.
- Only the bundled `@ai-sdk/openai-compatible` adapter is accepted. No runtime npm install and no
  arbitrary package supply chain.
- Provider ids and model ids use the D2 allowlists and reject `__proto__`/`constructor`/`prototype`.
  The overlay model record is built with `Object.fromEntries`/a null-prototype object.
- No server-side probe or model fetch is added. The coordinator does not make a request to the
  operator-supplied URL, so this stage adds no coordinator SSRF surface. The app container does make
  the request; the network-boundary warning covers that.
- The route is human-only, calls `crossSiteMutation` for mutations, and uses the existing
  `SameSite=Strict` cookie as a second layer. Agent principals receive `403`.
- Collision warnings cover the credential-redirection risk: an id that already has a key or host
  auth will send that existing key to the new base URL. The warning is non-blocking by owner
  decision.

## 6. Interfaces

```ts
export interface ModelProviderModel {
  id: string;
  name?: string;
  limit: { context: number; output: number };
}

export interface ModelProvider {
  id: string;
  name: string;
  baseUrl: string;
  models: ModelProviderModel[];
  createdAt: string;
  updatedAt: string;
}

export interface ModelProviderSnapshot {
  providers: ModelProvider[];
  overlay: Record<string, ProviderOverlay> | undefined;
  hash: string | undefined;
}

export interface ProviderOverlay {
  npm: "@ai-sdk/openai-compatible";
  name: string;
  options: { baseURL: string };
  models: Record<string, { name?: string; limit: { context: number; output: number } }>;
}

export interface ModelProviderInput {
  id: string;
  name?: string;
  baseUrl: string;
  models: ModelProviderModel[];
}
```

Wiring surfaces:

```ts
// src/opencode/instance.ts
export interface OpencodeOverlay {
  model?: string;
  provider?: Record<string, ProviderOverlay>;
  // ...
}
export interface BuildOverlayOptions {
  // ...
  providers?: Record<string, ProviderOverlay>;
}

// src/opencode/launcher.ts
export interface LaunchInput {
  // ...
  providers?: Record<string, ProviderOverlay>;
}

// src/opencode/manager.ts
export interface InstanceManagerOptions {
  // ...
  modelProviders?: ModelProviderSource;
}
export function settingsHashFor(
  snapshot: LaunchSettingsSnapshot,
  profile: string,
  skillsHash?: string,
  providersHash?: string,
): string;

// src/settings/service.ts
export interface SettingsServiceOptions {
  // ...
  providerIds?: () => readonly string[];
}
// The implementation stores this option in `#providerIdSource`; the class already has a private
// `#providerIds` method, and private names must remain unique.

// src/http/handler.ts
export interface HttpDeps {
  // ...
  modelProviders?: ModelProviderService; // CRUD/list; the manager uses ModelProviderSource
}
```

Construction order in `src/cli/commands.ts`: `ModelProviderService` is created first from the
database; `SettingsService` receives `providerIds: () => modelProviderService.list().map(p => p.id)`;
`InstanceManager` and `HttpDeps` receive the service itself. This avoids a service cycle: the
provider delete guard reads the `settings` table directly, not through `SettingsService`.

## 7. Non-goals

- Project/app-scoped provider definitions and provider inheritance.
- Auto-discovery of models from `/v1/models` or `/model/info`.
- Arbitrary npm adapters, custom headers, OAuth providers, or a per-provider `apiKey` field.
- Model capability flags beyond the opencode defaults (`tool_call: true`).
- Enabling/disabling a provider without deleting it.
- Master-agent provider management.
- A model picker that enumerates the bundled `models.dev` catalog.
- Per-model cost metadata in the UI.
- A complete bundled-provider registry for collision detection; only a curated warning set.

## 8. Rollout and backward compatibility

- A new migration creates the registry; existing tables and rows are untouched.
- An empty registry produces no `provider` overlay key and no settings-hash change.
- Existing `provider_keys` rows and host `auth.json` behavior are unchanged.
- Existing project `opencode.json` providers continue to merge; a same-id global provider overrides
  only the supplied keys (verified in §3).
- The new route is additive. Existing settings routes and their responses are unchanged.
- The settings page renders the custom block only on Global settings; project/app pages keep their
  current layout plus a hint.
- A downgrade to a coordinator without this stage makes an app's applied hash (which includes
  `providersHash`) differ from the older computation; running apps show `settings_changed` until
  their next restart. Documented, not migrated.
- A create/update is rejected when the provider projection would exceed 64 KiB or the registry
  would exceed 32 providers; existing providers remain readable.

## 9. Quality attributes

| Scenario | Mechanism |
| --- | --- |
| When a provider is created, every running app reports `Restart required` within one pending-restart query. | `snapshot().hash` is part of `settingsHashFor` at both call sites. |
| When an app starts after a provider is created, its `OPENCODE_CONFIG_CONTENT.provider` contains the definition and its `auth.json` contains the key. | Overlay projection + existing auth reconciliation. |
| When a provider is deleted while referenced, the request returns `409 provider_in_use` and no row is removed. | D8 parsed-JSON prefix scan. |
| When the registry is empty, an app's overlay and settings hash are byte-identical to the pre-stage behavior. | `undefined` overlay/hash for an empty list; no `provider` key. |
| When an id or model id contains a prototype key or a disallowed character, the request is rejected before any write. | D2 allowlist validation and explicit prototype-key rejection. |
| When a provider definition would exceed the overlay budget, the create/update is rejected and existing apps keep starting. | 32-provider / 64 KiB caps in D2/D4. |
| When an id shadows a keyed or bundled provider, the UI shows a non-blocking warning; the operator can proceed. | D2 collision warnings. |
| When the API key is absent, the settings page warns on the selected model and the key block shows `Missing`. | `#providerIds` includes registry ids; existing `modelProviderWarning`. |
| When a provider request is made by an agent principal, it receives `403`. | Existing settings authorization. |

## 10. Open questions

None. The owner accepted the five defaults on 2026-10-27: global-only, manual model list,
`@ai-sdk/openai-compatible` only, delete blocked while in use, and the settings section.

## 11. Review

### Round 1 (`oracle`, 2026-10-27): CHANGES REQUESTED

3 blockers, 6 majors, 6 minors.

**Blockers**

1. **Provider-level merge contract unverified.** The doc verified only top-level merge; P10
   asserted a same-id `provider.<id>` deep merge. This revision adds the `opencode debug config`
   evidence in §3 and narrows P10 to per-key merge with the overlay's model map authoritative.
2. **Model-id validation did not enforce the prototype-key guarantee.** D9 claimed prototype
   rejection while D2 allowed `__proto__`/`constructor`/`prototype` and unsafe characters. This
   revision adds the D2 model-id allowlist, explicit prototype rejection, a `|`-free model display
   name, and `Object.fromEntries`/null-prototype construction.
3. **Delete guard could not match `value_json` as written.** The revision parses the JSON string,
   skips null/non-string/parse failures, and runs the check and delete in one transaction.

**Majors**

1. **No cap on registry size or overlay size.** Added 32 providers / 64 KiB projection caps.
2. **Provider ids could shadow bundled or keyed providers.** Added non-blocking collision warnings
   against a curated bundled set and the effective provider-key map.
3. **The provider hash must be threaded through both launch and pending-restart.** D7 now names both
   call sites, one snapshot, `undefined` for empty, and excludes timestamps/model order.
4. **Invalid-row behavior was not consistent across consumers.** D2/D4 now define one validated
   snapshot used by `list`, `overlay`, `hash`, and `providerIds`; `hash` is `undefined` exactly when
   `overlay` is.
5. **`baseURL` is resolved inside the app container.** D9/D5 now document the network boundary and
   warn on loopback URLs.
6. **The new route did not actually enforce same-origin.** D4/D9 now call `crossSiteMutation` for
   the new mutation route.

**Minors**

1. **`launcher.ts` divergence.** The revision wires `LaunchInput.providers` through
   `buildConfigOverlay`; the manager path is still the production path.
2. **§6 omitted wiring surfaces.** The interfaces section now names `BuildOverlayOptions`,
   `LaunchInput`, `InstanceManagerOptions`, `SettingsServiceOptions`, and `HttpDeps`, plus the
   construction order.
3. **HTTP/fragment registration was missing.** D4 now registers `isSettingsRoute` and refreshes
   `agent`/`restart`/`warnings`.
4. **Form/validation details.** Added the `|`-free model name, strict nested validation, `new URL()`
   normalization, and the positive-only limit rule.
5. **Security hardening for keys and base URLs.** Added the non-loopback `http` warning and the
   delete/recreate key-reuse warning.
6. **Downgrade and DDL parity.** Added the downgrade restart note and `CHECK(json_valid(...))`.

### Round 2 (`oracle`, 2026-10-27): PASS

No round-1 blocker or major remained open, and revision 2 introduced no new blocker. Eight minors
were folded into revision 3:

1. The 64 KiB guard now measures UTF-8 bytes of the final `OPENCODE_CONFIG_CONTENT`, including the
   existing overlay keys, not the provider projection length.
2. Collision warnings use the union of `provider_keys` across all scopes plus host auth, and name
   the curated bundled-id constant.
3. The composed `llm.model` length is validated against the existing 256-character bound.
4. The plain-`http` non-loopback warning is now in D5/D9, matching the round-1 review mapping.
5. D4 now states the `isSettingsRoute` registration explicitly.
6. The `providerIds` option is stored in `#providerIdSource` to avoid the private-name collision.
7. P10/D3 now state that the overlay's `models` map is authoritative, matching §3.
8. D7 states provider/model ordering and the per-read snapshot boundary.

Verdict: **PASS**. Design review gate cleared.
