# Plan 0029 - Global custom model providers

Status: **approved** - plan review round 1 (`momus`) CHANGES REQUESTED; round 2 PASS
(2026-10-27), five minors folded into revision 3. Implementation permitted.
Design: [Global custom model providers](../design/custom-model-providers.md) (approved, `oracle`
round 2 PASS).
Owner decisions: [open questions](../open-questions.md), 2026-10-27.
Scope: a global registry of OpenAI-compatible model providers, its `OPENCODE_CONFIG_CONTENT`
projection, restart hashing, the settings API/UI, and the in-use delete guard.
Non-goals: project/app-scoped provider definitions, model auto-discovery, arbitrary npm adapters,
custom headers, provider enable/disable, master-agent management, and a full bundled-provider
catalog.

## Bindings

- Design author: maintainer; design reviewer: `oracle` (round 2 PASS).
- Plan author: maintainer; plan reviewer: `momus`.
- Design index: `docs/design/README.md`; plan index: `docs/plans/README.md`; journal index:
  `docs/journal/README.md`; open questions: `docs/open-questions.md`.
- Language: English for docs and code comments.
- Verification: `npm run lint`, `npm run typecheck`, `npm test`, `npm run build`, and
  `npm run check:sensitive`.
- Commit policy: one coherent stage commit; the owner authorized commit and push. The working tree
  already contains an unrelated agent-readiness change (`AgentStartingError`, `waitForReady`,
  `isOpenCodeReady`) in `src/cli/commands.ts`, `src/opencode/manager.ts`,
  `docs/current-state.md`, and tests. Do not include it: stage only this stage's hunks.

## Phase A - Registry storage and service

### Boundaries

In scope: migration v19, the `model_providers` table, the new `src/model-providers/` module, its
unit tests, and migration/version test updates. No overlay, HTTP, or UI changes.
Out of scope: manager wiring and the settings page.

### Invariants

- Provider ids are lowercase `^[a-z0-9][a-z0-9._-]*$`, 1-128 chars, and never
  `__proto__`/`constructor`/`prototype`.
- Provider names are 1-128 chars, contain no control characters, and default to `id` when blank.
- Model ids are `^[A-Za-z0-9@][A-Za-z0-9._:/@+-]*$`, 1-256 chars, unique per provider, never a
  prototype key. Model display names contain no control characters and no `|`.
- The composed `providerId/modelId` is <= 256 chars, matching `llm.model`.
- `baseUrl` is `http`/`https`, no userinfo/query/fragment, normalized with `new URL()` and trailing
  path slashes removed.
- One provider has 1-64 models; the registry has at most 32 providers.
- The provider projection is at most 48 KiB UTF-8 as an early guard; the manager and launcher
  enforce the hard 64 KiB final overlay limit (Phase B). The 48 KiB cap leaves at least 16 KiB for
  the existing overlay keys.
- `snapshot()` is the single validated read. Invalid stored rows are excluded from `list`,
  `overlay`, `hash`, and the provider-id callback.
- `overlay` and `hash` are both `undefined` exactly when the provider list is empty.
- Provider keys stay in `provider_keys`; this module never reads or writes them. The all-scope
  provider-key id source for collision warnings lives in `SettingsService` (Phase C).

### Work

1. `src/store/migrations.ts`: add migration **v19** `custom-model-providers`:

   ```sql
   CREATE TABLE model_providers (
     id TEXT PRIMARY KEY,
     name TEXT NOT NULL,
     npm TEXT NOT NULL CHECK (npm = '@ai-sdk/openai-compatible'),
     base_url TEXT NOT NULL,
     models_json TEXT NOT NULL CHECK (json_valid(models_json)),
     created_at TEXT NOT NULL,
     updated_at TEXT NOT NULL,
     CHECK (length(id) BETWEEN 1 AND 128),
     CHECK (length(name) BETWEEN 1 AND 128),
     CHECK (length(base_url) BETWEEN 1 AND 2048)
   );
   ```

   No foreign key: provider keys are independent scoped rows and survive a provider delete. The
   service enforces the charset, model shape, and size caps; the DB checks are the last line.

2. `src/model-providers/types.ts`:
   - `ModelProviderModel { id; name?; limit: { context; output } }`
   - `ModelProvider { id; name; baseUrl; models; createdAt; updatedAt }`
   - `ModelProviderInput { id; name?; baseUrl; models }`
   - `ModelProviderSnapshot { providers; overlay?: Record<string, ProviderOverlay>; hash?: string }`
   - `ProviderOverlay` from the design §6.
   - Error classes: `ModelProviderValidationError` (400), `ModelProviderConflictError` (409
     `provider_exists`), `ModelProviderNotFoundError` (404 `provider_not_found`), and
     `ModelProviderInUseError` (409 `provider_in_use`, with `references`).

3. `src/model-providers/validation.ts`:
   - Constants: `PROVIDER_NPM`, `MAX_PROVIDERS=32`, `MAX_PROVIDER_MODELS=64`,
     `MAX_PROVIDER_PROJECTION_BYTES=48*1024`, `MAX_MODEL_ID=256`, `MAX_PROVIDER_ID=128`.
   - `KNOWN_BUNDLED_PROVIDER_IDS` (the curated set from the design).
   - `validateInput(input, existingCount, projectionBytesAfter)` and the field validators,
     including the provider-name default-to-id rule.
   - `parseModelLines(text)` for the form: one line per model, `id | context | output | name?`.
   - `providerProjectionBytes(providers)` using `Buffer.byteLength(JSON.stringify({ provider }))`.
   - `toOverlay(providers)`, `hashProviders(providers)` (models sorted by id; timestamps excluded).
   - `collisionWarnings(id, existingProviderIds): string[]`.
   - `providerBaseUrlWarnings(baseUrl): string[]` (loopback and non-loopback plain `http`).

4. `src/model-providers/service.ts`:
   - `ModelProviderService({ db, now? })`.
   - `snapshot()`: `SELECT ... ORDER BY id`; parse+validate each row into a valid list; invalid rows
     are skipped; return `{ providers, overlay, hash }` with empty -> `undefined` overlay/hash.
   - `list()`, `get(id)`, `create(input, actor)`, `update(id, input, actor)`, `delete(id, actor)`.
   - `create`/`update` validate, enforce the 32-provider and 48 KiB projection caps, write, and
     `recordEvent(db, "global", "provider.created"|"provider.updated", {id})` in one transaction.
   - `delete`: parse every `settings` row with `key='llm.model'`; `JSON.parse(value_json)`; skip
     null/non-string/parse failures; prefix `${id}/`; collect `{scope, projectId, appKey}`; throw
     `ModelProviderInUseError` if any; otherwise delete + `recordEvent` in one transaction.
   - `collisionWarnings` delegates to validation with the caller's id set.

5. `src/model-providers/index.ts`: export types, validation constants, and the service.

6. Tests:
   - New `test/model-providers.test.ts`: CRUD, duplicate id, not found, validation (provider name
     default-to-id and no control characters, id/model regexes, prototype keys, `|` names, base URL
     schemes/userinfo/query/fragment/trailing slash, model limits, duplicate models, composed
     length, 32-provider cap, 48 KiB cap), base-URL warnings, empty snapshot, overlay shape, hash
     stability (edit/timestamp/model order), invalid stored row filtering, delete guard at
     global/project/app scopes, parse-error/null skipping, collision warnings, and event rows.
   - `test/migrations.test.ts`: version 19, versions list `[1..19]`, `model_providers` columns and
     `json_valid` constraint, a v18->v19 upgrade with no other schema change. Bump the two
     future-version inserts (`:357`, `:388`) from 19 to 20 and `known`/`knownMax` (`:366`, `:413`)
     from 18 to 19; bump the applied-count assertions (`:57`, `:532`, `:576`, `:726`, `:1012`) to
     19 and `max.version` (`:469`, `:546`, `:692`, `:839`, `:1116`) to 19; change the v17 upgrade
     count at `:1112` from 1 to 2 because v18 and v19 both apply; update
     `test/http.test.ts:800`'s `schemaVersion` to 19.
   - `test/settings-store.test.ts`: `runMigrations` returns 19.

### Acceptance criteria

- A fresh database migrates to 19 exactly once; a v18 database gains only `model_providers`.
- The service passes the CRUD/validation/delete-guard matrix.
- An empty service returns `{providers: [], overlay: undefined, hash: undefined}`.
- An invalid stored row is excluded from every consumer.
- No new dependency; no key material in the provider table.

### Verification

```bash
npx vitest run test/model-providers.test.ts test/migrations.test.ts test/settings-store.test.ts
npm run typecheck
```

## Phase B - Overlay and restart hashing

### Boundaries

In scope: the overlay type/builder, manager/launcher projection, the settings-hash argument, and
the final overlay byte guard. No HTTP/UI yet.
Out of scope: constructing the service in `serve`, the settings page, and the key-list callback.

### Invariants

- An empty registry adds no `provider` key and changes no existing hash or `OPENCODE_CONFIG_CONTENT`
  bytes.
- `provider` is a plain object of validated `ProviderOverlay` entries; no key or header material.
- The manager uses one `snapshot()` per launch for both overlay and hash.
- `settingsHashFor` receives the provider hash at both call sites: `#ensureLocked` and
  `#pendingRestartFor`.
- The final serialized overlay is <= 64 KiB UTF-8; exceeding it fails the start with a clear
  `provider_overlay_too_large` error instead of an opaque runtime rejection.

### Work

1. `src/opencode/instance.ts`:
   - Add `provider?: Record<string, ProviderOverlay>` to `OpencodeOverlay`.
   - Add `providers?: Record<string, ProviderOverlay>` to `BuildOverlayOptions`.
   - In `buildConfigOverlay`, set `overlay.provider` only when the map has entries.
   - Add `assertOverlayBytes(overlay, limit=64*1024)` using `Buffer.byteLength(JSON.stringify(...))`;
     `serializeConfigOverlay` calls it.

2. `src/opencode/launcher.ts`:
   - Add `providers?: Record<string, ProviderOverlay>` to `LaunchInput`; pass it to
     `buildConfigOverlay`. Call `assertOverlayBytes(overlay)` in `buildInstanceEnv` before
     serializing the env. This keeps the legacy helper consistent and gives it the same hard guard;
     the manager remains the production path.

3. `src/opencode/manager.ts`:
   - Add `modelProviders?: ModelProviderSource` to `InstanceManagerOptions`, where
     `ModelProviderSource` is `{ snapshot(): ModelProviderSnapshot }`.
   - In `#ensureLocked`, after the settings snapshot:
     `const providerSnapshot = this.#options.modelProviders?.snapshot();` Pass
     `providerSnapshot?.overlay` to `buildConfigOverlay` and `providerSnapshot?.hash` as the fourth
     `settingsHashFor` argument. Call `assertOverlayBytes(overlay)` before serializing the env.
   - In `#pendingRestartFor`, pass `this.#options.modelProviders?.snapshot().hash` as the fourth
     argument.
   - Do not change the existing settings hashing semantics for an empty registry.

4. Tests:
   - `test/instance.test.ts`: provider overlay present; empty map -> no `provider`; serialization
     size guard.
   - `test/manager.test.ts`: add an optional `modelProviders` fixture parameter; assert the runner
     spec's `OPENCODE_CONFIG_CONTENT` contains the provider; assert an empty registry keeps the old
     hash; assert an edit changes the applied/pending hash at both the launch and persisted-row
     paths; assert the projection is absent from auth.json; assert an over-budget final overlay
     fails the start with a clear error.
   - `test/launcher.test.ts` or the existing launcher test: `LaunchInput.providers` reaches
     `OPENCODE_CONFIG_CONTENT`; the launcher applies the same 64 KiB guard.
   - Manual P10 verification (development-only, not a CI test): run inside the agent/default image
     or this app container, where `opencode` 1.19.3 is installed; use a temporary directory outside
     the repository. The project `opencode.json` defines the same id with **different** `npm`,
     `name`, `options.baseURL`, and `models`, plus an extra `options.headers` key. Run
     `opencode debug config` with the generated overlay and confirm the overlay's
     `npm`/`name`/`baseURL`/models win while the extra header survives. If the header does not
     survive, record the actual merge result and narrow P10 accordingly in the journal.

### Acceptance criteria

- A configured provider reaches the runner spec and the legacy launcher env.
- Empty registry: no `provider` key, byte-identical overlay, unchanged hash.
- Both restart paths detect an edit/delete.
- No key appears in the overlay or spec env.

### Verification

```bash
npx vitest run test/instance.test.ts test/manager.test.ts test/launcher.test.ts
npm run typecheck
```

## Phase C - Settings HTTP and UI

### Boundaries

In scope: `SettingsService` provider-id source, `HttpDeps.modelProviders`, the new route, the Global
settings block, the `llm.model` datalist, the key-status integration, and the client confirm.
Out of scope: project/app provider definitions, auto-discovery, and any new client framework.

### Invariants

- The new route is human-only, calls `crossSiteMutation` on POST, and is registered in
  `isSettingsRoute`.
- `GET /api/settings/model-providers` and the page share the same validated provider list and
  warning computation.
- Creating a provider makes its id appear in the existing Providers key block with `Missing`
  status, without changing auth material for a registry-only id.
- The custom block is rendered on Global settings only; project/app pages get a hint and the
  datalist.
- A browser form save returns the existing settings fragment payload with `agent`, `restart`, and
  `warnings`.
- Provider keys are never displayed or accepted by the custom block.

### Work

1. `src/settings/service.ts`:
   - Add `providerIds?: () => readonly string[]` to `SettingsServiceOptions`; store it in
     `#providerIdSource` (the private `#providerIds` method already exists).
   - In `#providerIds`, add the callback's ids after provider rows and host auth.
   - Add `allProviderIds(): string[]`: `SELECT DISTINCT provider FROM provider_keys` across every
     scope plus the host-auth keys, sorted. This is the single source for collision warnings; it
     lives in `SettingsService` so the model-providers module keeps its no-key-access invariant.

2. `src/http/handler.ts`: add `modelProviders?: ModelProviderService` to `HttpDeps`. The manager
   uses the narrower `ModelProviderSource`; the HTTP layer needs `list` and CRUD.

3. `src/http/settings.ts`:
   - `isSettingsRoute`: include `"/api/settings/model-providers"` for GET and POST.
   - `handleSettings`: return `503 model_providers_not_configured` when `deps.modelProviders` is
     absent; branch before the provider-key route.
     - GET: return `{providers, warnings}`; `warnings` combines the curated collision set with
       `deps.settings.allProviderIds()` (all scopes plus host auth). Include the per-provider base
       URL warnings.
     - POST: `crossSiteMutation`; parse `action` (`create`/`update`/`delete`), `id`, `name`,
       `baseUrl`, `models` (string -> `parseModelLines`, array -> structured), and the delete flag.
       Map errors to `400`/`404`/`409`; return the fragment (`["agent","restart","warnings"]`),
       redirect+notice, or JSON with `{ok, providers, warnings}`. The warnings include collision,
       base URL, and delete/recreate key-reuse messages. On create/update, if
       `allProviderIds()` contains the id and a `provider_keys` row exists (including a cleared
       row), add the key-reuse warning: the retained key will be sent to the new base URL.
   - `settingsSections`: read `deps.modelProviders?.list() ?? []`; pass the model list to
     `modelControls` for the datalist; compute collision/loopback/plain-http warnings from
     `deps.settings.allProviderIds()`; render `customProvidersSection` inside the `agent` block on
     Global settings, or a hint on project/app settings. The GET and page warning shape is
     `Record<string, string[]>`, keyed by provider id.
   - `customProvidersSection`: reuse `providers`/`setting-row`/`provider-add`; one row per provider
     with edit + delete, key status/link, collision and base-URL warnings, and an add disclosure.
   - `formatModelsText` for the textarea.
   - `modelControls`: add `<datalist>` options `${provider.id}/${model.id}` and a `list` attribute
     only when the list is non-empty.
   - Errors: `ModelProviderValidationError` -> 400; conflict -> 409 `provider_exists`; in-use -> 409
     `provider_in_use` with `references`; not found -> 404; no service -> 503.

4. `src/cli/commands.ts`:
   - Construct `const modelProviders = new ModelProviderService({ db })` before `SettingsService`.
   - Pass `providerIds: () => modelProviders.list().map((p) => p.id)` to `SettingsService`.
   - Pass `modelProviders` to `InstanceManager` and `createHttpServer`'s `HttpDeps`.
   - Keep the unrelated `waitForReady` hunks untouched.

5. `assets/settings.js`:
   - Handle a `data-confirm` attribute on a submitter before the fragment submit; on cancel,
     `preventDefault()` and return.

6. Tests:
   - `test/settings-http.test.ts`: extend `fixture()` with a `ModelProviderService`, `providerIds`,
     and `deps.modelProviders`. Add tests for: page block global vs project/app hint; create
     (form+fragment), update, delete; validation 400; duplicate 409; in-use 409 with references;
     agent token 403; cross-site 403; GET JSON; datalist; missing key status; a collision warning
     for a project-scoped or app-scoped key (proves `allProviderIds` covers all scopes); loopback
     and non-loopback plain-`http` warnings; delete/recreate key-reuse warning; 503 when the service
     is absent; and a sentinel key that must not appear in the custom block or the JSON response.
   - `test/settings-store.test.ts`: `providerIds` adds ids to `resolved.providerKeys` as `missing`;
     `allProviderIds` returns global, project, app, and host-auth ids.
   - `test/settings-asset.test.ts`: `data-confirm` path.
   - `test/settings-http.test.ts` no-JS redirect fallback for the new route.

### Acceptance criteria

- An operator can create a provider from `/settings`, add its key in the existing Providers block,
  and see the model suggestion in `llm.model`.
- The provider definition survives a page reload and a fragment swap.
- Project/app pages show the hint and the datalist; they do not offer a provider definition form.
- Delete is refused while `llm.model` references the provider and names the references.
- Agent principals get 403; cross-site mutations get 403.
- No key is rendered in HTML or JSON.

### Verification

```bash
npx vitest run test/settings-http.test.ts test/settings-store.test.ts test/settings-asset.test.ts
npm run typecheck
```

## Phase D - Docs, record, gates, commit

### Boundaries

In scope: docs, indexes, the journal record, the dependency diff check, the gates, and the commit.
Out of scope: product-code changes beyond Phases A-C.

### Invariants

- Docs match the shipped behavior; no real host, LAN address, or secret enters a tracked file.
- The commit contains only this stage's files; the unrelated readiness change stays unstaged.

### Tests

- `git diff --quiet HEAD -- package.json package-lock.json` (P9: no new dependency in the commit;
  run after staging).
- The manual P10 `opencode debug config` check from Phase B is recorded in the journal.
- After staging, inspect `git diff --cached --name-only` and the shared-file hunks. If feasible,
  verify the staged tree in a temporary worktree; otherwise record the dirty-worktree gate caveat
  in the journal.
- The full suite and build from the gates below.

### Work

- `docs/current-state.md`: Settings section (global custom providers, overlay, keys, restart, delete
  guard, caps), data layout (`model_providers`), migration `[1..19]`, known limitations
  (global-only, manual models, no discovery, curated collision warnings, 32/64 KiB caps, project
  `opencode.json` precedence).
- `docs/deployment.md`: a "Custom model providers" subsection under model credentials: add the
  provider in Global settings, use the API root as `baseURL`, use the host LAN address (not
  `127.0.0.1`/`localhost`), add the key, select `provider/model`, restart. Use `<LAN_HOST>`
  placeholders only; no real host data.
- `README.md`: one feature bullet.
- `docs/design/README.md`: status approved; implementation verified.
- `docs/plans/README.md`: add 0029.
- `docs/journal/0035-custom-model-providers.md` and `docs/journal/README.md`: stage record with
  design rounds, decisions, implementation, verification, residual risks, the manual P10 evidence,
  and commit/push status.
- Do not modify `docs/process.md` or the unrelated readiness docs.

### Gates

```bash
npm run lint
npm run typecheck
npm test
npm run build
npm run check:sensitive
git diff --quiet HEAD -- package.json package-lock.json
```

Fix all failures caused by this stage. Do not fix unrelated pre-existing failures.

### Commit and push

- Inspect `git status`, `git diff`, and the staged diff.
- Stage only this stage's files. For `src/cli/commands.ts`, `src/opencode/manager.ts`, and
  `docs/current-state.md`, use `git add -p` (or apply a split patch) and verify the staged diff
  contains **no** `AgentStartingError`/`waitForReady`/`isOpenCodeReady` hunks.
- Do not stage `src/http/errors.ts`, `src/opencode/client.ts`, `test/chat-page.test.ts`,
  `test/client.test.ts`, or `test/runtime-manager.test.ts` (the unrelated readiness change).
- Commit: `feat(settings): add global custom model providers`.
- Push the current branch (`main`) to `origin`; report the remote result.

### Acceptance criteria

- All five gates are green.
- The docs and indexes are consistent with the implemented behavior.
- The commit contains exactly the stage files, with no unrelated readiness hunks.
- The push succeeds.

## Test matrix

| Requirement | Tests |
| --- | --- |
| P1 create/edit/delete | `model-providers.test.ts`, `settings-http.test.ts` |
| P2 id matches key/model | `model-providers.test.ts`, `settings-http.test.ts` |
| P3 overlay in every app | `instance.test.ts`, `manager.test.ts`, launcher test |
| P4 key never in overlay | `instance.test.ts`, `manager.test.ts` (auth absent from overlay) |
| P5 restart hash, empty no-op | `manager.test.ts` (both call sites), `instance.test.ts` |
| P6 key block shows new provider | `settings-store.test.ts`, `settings-http.test.ts` |
| P7 datalist, free text | `settings-http.test.ts` |
| P8 in-use delete guard | `model-providers.test.ts`, `settings-http.test.ts` |
| P9 no new dependency | `git diff --quiet HEAD -- package.json package-lock.json` after staging |
| P10 empty registry byte-identical, project merge | `instance.test.ts`, `manager.test.ts`, plus the manual `opencode debug config` check in Phase B |

## Rollout

Forward-only migration; no data backfill. An empty registry is a no-op. The new route is additive.
A downgrade requires a restart because the applied hash includes the provider hash. No automatic
restart is introduced. The settings page is the only new operator surface.

## Risks and mitigations

- **Pre-existing working-tree changes**: stage selectively and verify the staged diff; do not commit
  the readiness feature.
- **Migration version assertions**: update every hard-coded 18 in tests; the new max is 19.
- **Overlay size**: 48 KiB provider projection (leaves 16 KiB for existing keys) + 64 KiB final
  guard in both the manager and the launcher; the service rejects at create time, the manager and
  launcher reject at launch as a backstop.
- **Collision warnings**: `SettingsService.allProviderIds()` covers all key scopes plus host auth;
  `providerIds` is only the registry-id callback for the key block. The page and GET share the same
  warning computation.
- **Hash drift**: one `snapshot()` per operation; both call sites; empty -> `undefined`; timestamps
  excluded; models sorted.
- **Secret leakage**: keys stay in `auth.json`/`provider_keys`; the overlay and API responses contain
  only id/name/baseUrl/models.
- **UI fragment**: the new block lives in the `agent` section; the POST refreshes `agent`,
  `restart`, and `warnings`; the client delete uses `data-confirm`.
- **Collision warnings**: curated bundled ids + effective key statuses in `set`/`host`; unknown
  bundled ids are a documented limitation.

## Review

### Round 1 (`momus`, 2026-10-27): CHANGES REQUESTED

No hard blockers; three majors and five minors were folded into revision 2:

1. **Collision warnings did not cover all scopes.** The plan now adds
   `SettingsService.allProviderIds()` (all `provider_keys` scopes plus host auth) and uses it for
   the page and GET; the model-providers module keeps its no-key-access invariant.
2. **The size cap was not the final-overlay budget.** The plan now states the 48 KiB provider
   projection as an early guard leaving 16 KiB for existing keys, and enforces the hard 64 KiB
   final guard in both the manager and the launcher.
3. **P10's project merge was untested.** Added the manual `opencode debug config` check with a
   same-id project provider and an extra `options.headers` key, recorded in the journal; the test
   matrix now maps the Hanse-owned part separately.
4. Migration tests now bump future version 19 to 20 and `knownMax` 18 to 19.
5. The loopback, plain-`http`, and delete/recreate key-reuse warnings now have a defined producer
   and tests.
6. The 503 error and `HttpDeps` type are explicit.
7. Provider-name validation/default-to-id is in Phase A and its tests.
8. Phase D has Boundaries/Invariants/Tests, and P9 is a dependency-diff command, not a prose check.

### Round 2 (`momus`, 2026-10-27): PASS

No blockers or majors; five minors folded into revision 3:

1. `HttpDeps` uses the concrete `ModelProviderService` (the manager keeps the narrower
   `ModelProviderSource`); the design §6 snippet now matches.
2. The migration-test inventory now lists the exact assertion line numbers and the `1 -> 2`
   upgrade-count change.
3. P9 is checked against `HEAD` after staging, and the staged-tree verification caveat is recorded.
4. The delete/recreate key-reuse warning has a producer rule and a warning shape.
5. The manual P10 check names its environment and distinct project-side values.

Verdict: **PASS**. Plan review gate cleared; implementation permitted.
