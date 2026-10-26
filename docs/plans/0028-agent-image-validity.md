# Plan 0028 - Agent image validity, rebuild, and restart

- Status: **implemented; automated gates and browser QA pass; live smoke pending**. Phases A-F are
  implemented and Phase G adds docs/config/record. The owner override of the missing Oracle PASS is
  recorded below and is not a plan gap.
- Design: [`docs/design/agent-image-validity.md`](../design/agent-image-validity.md) -
  **owner-accepted to proceed** after 12 design-review rounds. No Oracle PASS was issued; the owner
  explicitly overrode that gate on 2026-10-25 and chose to freeze the design and handle residual
  items as they arise.
- Design reviewer: `oracle`; plan reviewer: `momus`.
- Plan artifact: `docs/plans/0028-agent-image-validity.md`; plan index `docs/plans/README.md`.
- Journal to write after implementation: `docs/journal/0033-agent-image-validity.md`.
- Verification (every phase unless stated otherwise):
  `npm run lint && npm run typecheck && npm test && npm run build`; `npm run check:sensitive` before
  every commit.
- Commit policy: one coherent commit per completed phase/stage (code + tests + docs), Conventional
  Commits; the owner override of the missing Oracle PASS is recorded in the header and in the final
  journal.
- Design reference discrepancy: the design header names `docs/plans/agent-image-validity.md`; this
  plan is numbered `0028-agent-image-validity.md`. Phase G corrects the design link and status.

## Scope

Per-application agent image identity and validity:

- Applied-versus-target identity by Docker image ID; base drift by manifest digest. The two domains
  are never mixed and no coordinator-revision comparison is used (design D1, V14, V5).
- Optional `build.base` (`default | base`) plus Dockerfile final-stage root inference, base tracking
  (`default`, `base`, `explicit`, `unknown`), and `base_mismatch` configuration rejection (D2, V15).
- Build-spec hash version 2 and safe handling of legacy version-1 rows (D3, V16).
- Migration 18, durable build identity, adoption, lost-build handling, and GC protection of the
  in-flight target (D4, D9, D15).
- Shared state derivation and startability rules for `current`, `restart_required`,
  `rebuild_required`, `building`, `build_error`, `not_ready`, and `unknown` (D5, D12).
- Runner image inspection/identity, launch identity comparison, and the `HANSE_AGENT_BASE_IMAGE`
  configuration/allowlist (D2, D6, D11).
- Restart/start/rollback preflight that leaves a usable container untouched on image failure
  (D10).
- Chat warning/card UX, build-and-start and rebuild-and-restart orchestration, SSE reconnect, image
  refresh cadence, and application-page state rendering (D11, D12).
- `HANSE_AGENT_BASE_IMAGE` in Compose and `.env.example`; docs, browser QA, and live smoke (D2, G).

## Non-goals

- Automatic rebuilds, automatic restarts, or automatic container recreation while running.
- Blocking stale starts (owner decision: stale is startable and advisory).
- Coordinator revision tracking, tag-string comparison, or registry-side digest resolution.
- Cross-application bulk actions.
- Exotic Dockerfile semantics beyond final-stage `FROM`, alias, and ARG resolution; ambiguity is
  `unknown`.
- Changing image-build validation internals, the GC algorithm, GC candidate selection, or adding
  base/default images or build cache to the GC surface.
- Any new agent-accessible image build, inspect, or arbitrary-reference action.
- Host-specific deployment instructions, resource sizing, or recreation of deployment applications.
  That is outside this feature and belongs only in an untracked deployment runbook.

## Owner decisions (from design section 8)

| # | Decision |
| --- | --- |
| 1 | Running on a stale image is allowed; image state is advisory. |
| 2 | Default-image applications only need a restart; the default launch always uses the current image. |
| 3 | A running outdated agent gets a chat warning with an action; a custom rebuild is followed by an immediate restart when the user chose Rebuild & restart. |
| 4 | A custom image records its actual base (`agent-base` or `agent-default`) and compares that base's digest; no guessed fallback. |
| 5 | A Hanse update with unchanged relevant image digests does not mark agents outdated. |
| 6 | A custom application with no usable image gets a chat card with **Build and start**, waits on the same page, then connects the chat. |
| 7 | Base selection is the optional `build.base` field plus the Dockerfile final-`FROM` fallback; a contradictory declaration is a bounded configuration error. |
| 8 | `HANSE_AGENT_BASE_IMAGE` is repository code; deployment supplies its value. |

## Global invariants

- **Two identity domains.** Applied-versus-target compares Docker image IDs (container `Image`
  versus inspect `Id`). Base drift compares manifest digests from `RepoDigests`. `Config.Image`,
  tags, and image IDs never substitute for one another. A null/unknown identity never produces
  `restart_required`, `rebuild_required`, or `not_ready`.
- **Startability.** A build-configured app is blocked from a cold start only when `usableImageRef`
  is null; a prior usable image remains startable through `building` and `build_error`. A default
  app is never `not_ready`, `building`, `build_error`, or `rebuild_required` from an image-status
  value.
- **No coordinator-to-Docker path.** The coordinator resolves identities only through the
  authenticated runner inspect/build endpoints. The runner owns Docker inspection.
- **No automatic action.** Plain `POST /build` never restarts or starts. A stopped app is never
  started by a rebuild or restart route. Only the explicit Rebuild & restart restarts immediately.
- **One shared state result.** HTTP `GET /image`, both typed errors, the application page, and the
  chat use the same derived `state` and precedence. Raw image launch errors never reach the chat.
- **Durability over in-memory state.** `image_build_id`/`image_build_ref`/`image_build_started_at`
  survive coordinator restarts and drive adoption; `#active` is an optimization only.
- **Preserve unrelated launch state.** `applied_image_id` writes must not null
  `applied_settings_hash`/`applied_profile` on reconnect/resume paths.
- **Forward-only storage.** Migration 18 has no down migration; existing rows keep their data and
  legacy base/hash identity stays `unknown` until the next successful build.
- **No sensitive data.** No tracked file, test, screenshot, or commit message may contain a real
  hostname, address, install path, project/session ID, token, or real deployment name.

## Cross-cutting contracts (implement once, reuse)

### Migration 18 column list (exact)

`apps`:

- `build_configured INTEGER NOT NULL DEFAULT 0` (0/1; durable manifest flag)
- `image_base_ref TEXT` (NULL for legacy/no build)
- `image_base_kind TEXT` (NULL or `default|base|explicit|unknown`)
- `image_hash_version INTEGER NOT NULL DEFAULT 1` (>= 1)
- `image_build_id TEXT`, `image_build_ref TEXT`, `image_build_started_at TEXT` (ISO-8601)
- `image_build_rejected_ref TEXT`

`app_image_versions`:

- `base_ref TEXT`, `base_kind TEXT` (same enum), `hash_version INTEGER NOT NULL DEFAULT 1`

`instances`:

- `applied_image_id TEXT` (NULL means unknown; preserve on stop status without a container image)

No `apps.image_stale_reason`. The reason is derived from base drift, hash drift, and
`image_error`. Add CHECK constraints for the boolean/enum/version columns in the migration, following
the repository's existing migration style; legacy NULLs are valid.

### State derivation order (single implementation)

1. Not build-configured: default app. Running/starting with both IDs known and different =>
   `restart_required`; both known and equal => `current`; otherwise `unknown`. Stopped is never
   `restart_required`.
2. Build-configured with an active durable/observed build => `building`.
3. Build-configured with `image_status = error` or live inspection `status = error` => `build_error`.
4. Build-configured with `usableImageRef = null` => `not_ready`.
5. Base drift or comparable hash drift => `rebuild_required`.
6. Running/starting and both applied/target IDs known and different => `restart_required`.
7. Build-configured with an unknown comparable hash/base identity and no higher state => `unknown`.
8. Any other required identity unknown => `unknown`.
9. Otherwise `current`.

`usableImageRef` requires the app-scoped inspect to confirm the selected image is present and its
label/ID agrees with the version. Inspect unavailable/unknown keeps the ref and yields `unknown`;
inspect explicitly missing/contradictory sets `usableImageRef = null` and yields `not_ready`
(`image_missing`). `blocked = buildConfigured && usableImageRef === null && state ∈ {not_ready,
building, build_error}`. The chat card additionally requires `!running`.

Presentation precedence is `building > build_error > not_ready > rebuild_required > restart_required
> none` for warnings, and `building > build_error > not_ready` for the blocked card.

### Typed errors and shared view

- `ImageNotReadyError`: HTTP 409, code `image_not_ready`, fields `appId`, `imageStatus`,
  `buildConfigured`, derived `state`, bounded message.
- `DefaultImageUnavailableError`: HTTP 503, code `default_image_unavailable`, fields `appId`,
  derived `state`, bounded message; never a build action.
- Both take `state` from the injected `imageState(appId)` so the error and `GET /image` agree.
- `GET /image` view additions: `buildConfigured`, `state`, `running`, `usableImageRef`,
  `targetImageId`, `appliedImageId`, `hashVersion`, `currentBaseDigest`, `baseKind`, `baseRef`,
  `baseDigest`, `imageBuildId`, `buildId` (runner-latest diagnostic), `latestBuildImageId` (renamed
  legacy `imageId`), preserving `previousImageRef`/`previousImageBuiltAt`.
- The 409-attach predicate is exactly `imageBuildId !== null && state === "building"`.

### Cache and refresh

- Identity cache keyed by reference string: `{imageId, manifestDigest}`.
- Warm at startup for the default reference, configured base reference, and every recorded explicit
  `base_ref` after `registerProject` and after the deployment image pull.
- 60 s TTL per reference; invalidate after build, rollback, start, restart, explicit Check for
  changes, and `GET /image?refresh=1` (chat focus/visibility).
- No per-request Docker inspection. Unavailable/absent/no-`RepoDigests` => `unknown`, retried later,
  never treated as current.

## Phase A - Storage, schema, registry flag, and backfill

Boundaries: `src/store/migrations.ts`, `src/schema/app.ts`, `src/registry/index.ts`,
`src/coordinator/service.ts`, `src/coordinator/provision.ts`, and their tests. No runner, image
service, HTTP, or UI behavior.

Work:

1. Add migration 18 with the exact columns above. Forward-only; do not rewrite existing image rows.
2. `src/schema/app.ts`: make `build.base` optional with allowed values `default | base` and **no
   schema default**. Keep `dockerfile`/`args` semantics unchanged.
3. `src/registry/index.ts`:
   - Extend `RegisteredApp`, `AppBuildInspection`, `ExistingImageRow`, and `MergedImageMetadata`.
   - `AppBuildInspection` carries the manifest-derived `buildConfigured`, Dockerfile bytes (or a
     precomputed v1 hash input), and resolved base kind/ref fields; the resolver that fills the base
     fields lands in Phase C.
   - `selectExisting` includes `image_error`, `image_base_ref`, `image_base_kind`,
     `image_hash_version`, and `image_build_rejected_ref`.
   - `upsertApp` writes `build_configured` from the inspection and preserves `image_build_id`,
     `image_build_ref`, `image_build_started_at`, and `image_build_rejected_ref` on conflict.
     Registration never clears an in-flight build or a rejected marker.
   - `mergeImageMetadata` preserves the stored base fields/hash version and a persisted
     `build_error`/rejected marker; it never fills a null hash for a row with a non-null
     `image_ref`. The preservation branch returns every new field.
4. `src/coordinator/service.ts`: `listApps` selects and returns `buildConfigured` plus the new
   base/hash/build fields. Remove the `image_status`/`image_ref`/`image_hash` heuristic; no
   filesystem or `projects.root_path` access.
5. `src/coordinator/provision.ts`: write the same `build_configured` value in the provisioning
   transaction from the manifest inspection. Startup registration backfills existing rows through
   `upsertApp`.
6. Note the cross-phase boundary: `ImageService.check` and `ImageService.build` also write
   `build_configured`; those call sites are implemented in Phase C because that file is rewritten
   there. Phase A supplies the shared value and storage.
7. Tests:
   - `test/migrations.test.ts`: fresh database reaches 18; a v17 fixture upgrades; existing app,
     version, and instance rows survive; defaults are 0/NULL/1; enum/version constraints hold.
   - `test/schema.test.ts`: `build.base` optional, accepts `default`/`base`, rejects other values,
     and has no implicit default.
   - `test/registry.test.ts`: registration writes/preserves all new fields; an in-flight build and
     rejected marker survive merge/upsert; a null-hash row with `image_ref` stays null; legacy rows
     are not inferred from the current Dockerfile.
   - `test/service.test.ts`: `listApps` returns the durable flag and fields without filesystem
     access.

Acceptance: migration applies to a populated v17 database; every new field round-trips through
registration/`upsertApp`/`selectExisting`/`mergeImageMetadata`; no reader silently resets a build
field; `build_configured` is durable and not heuristic.

Dependencies: none. Parallelization: Phase B can run in parallel; both must land before Phase C
service integration.

Risks: field reset on merge/conflict; boolean representation; preserving a rejected build marker;
migration on a populated database. Mitigation: explicit preservation tests and a v17 upgrade fixture.

## Phase B - Runner identity, inspect route, launch identity, build records, GC

Boundaries: `src/runner/docker.ts`, `src/runner/images.ts`, `src/runner/image-gc.ts`,
`src/runner/server.ts`, `src/runner/validate.ts`, `src/agent/protocol.ts`,
`src/agent/supervisor.ts`, and runner tests. No coordinator image service or HTTP UI.

Work:

1. Docker types: `DockerImageInspect` gains `RepoDigests`; `DockerContainerInspect` gains top-level
   `Image`; `statusFromInspect` returns `imageId`; `RuntimeAppStatus.imageId` is optional;
   `stoppedStatus` and the supervisor return `imageId: null`.
2. Runner config: add optional `baseImage` from `HANSE_AGENT_BASE_IMAGE`; union it into
   `allowedImages` in `src/runner/validate.ts`. Normalize/validate it as an image reference (trim;
   reject empty/whitespace/NUL/control characters). `build.base=base` without this variable is a
   coordinator configuration error, never a silent default.
3. Build validation: accept the configured base reference and the configured default reference
   (including `defaultImageReference()` with `HANSE_AGENT_IMAGE_DIGEST`). Reject a base outside
   `allowedImages` with the existing bounded runner error.
4. Launch allowlist: accept `spec.image === config.defaultImage` in addition to `allowedImages`, so
   a digest-pinned default launches. Keep all other launch allowlist behavior.
5. Launch identity: when an existing container is not running and the spec hash matches, inspect the
   target reference and compare the inspect `Id` with the existing container's top-level `Image`.
   If different, stop/remove/recreate; if the target cannot be inspected, fail with the bounded
   image-unavailable error and do not start the old container. A running container is reused.
   Never add the image ID to `computeSpecHash`.
6. Add `GET /v1/images/inspect?ref=<reference>[&appId=<appId>]` behind the runtime token:
   reference validation, allowlist plus default/base, app-scoped built `hanse-app-*` refs only with
   a matching `hanse.app.id` label, 400 malformed / 403 disallowed, 200
   `{found:false, imageId:null, repoDigests:[], resolvedDigest:null}` when absent, otherwise
   `{found:true, imageId, repoDigests, resolvedDigest}`. Bound the body (8 KiB, at most 16 digest
   entries). `resolvedDigest` follows the D1 order: explicit `@sha256`, then exactly one distinct
   matching-repository `RepoDigests` entry, then null.
7. Build records: add `targetRef` to the build start result; add `specHashVersion`/`hashVersion`,
   base kind/ref, and the runner-resolved base digest to `RunnerImageRecord` and the build record;
   expose lookup by build ID as well as by app. Label the built image with `hanse.base.kind`,
   `hanse.base.ref`, `hanse.base.digest`, and `hanse.image.version`; labels are diagnostic only.
8. GC: add `ImageBuildService.protectedBuildTags()` (non-terminal builds only) and pass it as a
   provider into `ImageGcService` from `src/runner/server.ts`. The protected set unions in-flight
   build tags. Do **not** change `isManagedImage`, candidate selection, or any other GC surface.
9. Tests:
   - `test/docker-build.test.ts`/`test/runner-containers.test.ts`: `RepoDigests`/container `Image`
     parsing, status image ID, stopped/supervisor null.
   - `test/runner-validate.test.ts`: base/default allowlist, missing/invalid base, digest-pinned
     default launch acceptance, disallowed build base.
   - `test/runner-build.test.ts`: build record fields, `targetRef`, hash version, build-ID lookup,
     base digest resolution, inspect route bounds/validation/app-scoped label.
   - `test/runner-containers.test.ts`: stopped old image recreated; running reused; uninspectable
     target fails closed; digest-pinned default launch.
   - `test/image-gc.test.ts`: non-terminal build tag protected; base/default images and running
     containers unchanged; candidate selection unchanged.

Acceptance: runner can supply image IDs/digests without Docker passthrough; a repointed tag is not
launched on a stopped old container; an in-flight build target cannot be GC'd before adoption; the
base is allowlisted; digest-pinned default launches.

Dependencies: none for the runner. Shared enum/field names must match Phase A. Parallelization: run
in parallel with Phase A.

Risks: multi-arch/index digest confusion (resolve both sides by the same rule); allowlist bypass on
app-scoped built refs; GC behavior drift; launch recreation of a stopped container only. Mitigation:
focused runner tests and a strict "no GC algorithm change" review.

## Phase C - Coordinator image service, base resolution, hashes, state, adoption

Boundaries: `src/runtime/build-spec.ts`, a new pure base-resolution module in
`src/runtime/base-image.ts`, `src/registry/index.ts` (v2 comparison only), `src/images/client.ts`,
`src/images/service.ts`, both `ImageService` constructors in `src/cli/commands.ts`, and tests. No
manager/HTTP/UI behavior beyond exported contracts.

Work:

1. Build-spec hash v2 in `src/runtime/build-spec.ts`: version prefix/version field 2; hash exactly
   Dockerfile bytes, sorted build args, and base kind. Exclude base ref/tag/digest. Keep a v1
   recompute helper for legacy full-reference rows; a v1 hash is never compared with a v2 hash.
2. Base resolution in `src/runtime/base-image.ts` (pure):
   - optional explicit `build.base`;
   - `default` => `defaultImageReference()` including `HANSE_AGENT_IMAGE_DIGEST`;
   - `base` => `HANSE_AGENT_BASE_IMAGE`, missing value is a bounded configuration error;
   - otherwise resolve the final stage's single root external `FROM` through aliases and ARG values
     (manifest args over Dockerfile defaults; `${VAR}`, `$VAR`, `${VAR:-default}`; ignore
     `--platform`);
   - root consumes `${HANSE_BASE}` => `default`; literal root => `explicit`; unresolved/cyclic =>
     `unknown`; a manifest `HANSE_BASE` arg is a configuration error;
   - a set `build.base` whose resolved root ignores `${HANSE_BASE}` => `400` `base_mismatch`; check
     the resolved root, not the final-stage text.
3. Base reference/digest resolution: default/base/explicit ordering, explicit `@sha256` wins,
   otherwise exactly one distinct matching-repository `RepoDigests` digest, otherwise `unknown`.
   A local-only image without `RepoDigests` is `unknown`; a digest that is not `sha256:<64>` is not
   an identity.
4. `src/images/client.ts`: add inspect client, build lookup by ID, `targetRef`, `hashVersion`,
   base kind/ref/digest in build input/record parsing, and bounded transport errors. No raw runner
   body leaks.
5. `src/images/service.ts`:
   - base resolution and `build_configured` writers for `check` and `build`;
   - persist build start (`image_build_id`, `image_build_ref`, `image_build_started_at`,
     `image_status = building`) from the runner result; persist a pre-runner configuration failure
     as `image_status = error` + bounded `image_error` before throwing;
   - version-aware `mergeImageMetadata` comparison and v1 recompute rules;
   - target image ID from `app_image_versions.image_id` for the selected `apps.image_ref`, never the
     runner's latest record;
   - adoption: durable build-ID match with ref match => adopt; durable match with ref mismatch =>
     clear build fields, set `image_build_rejected_ref`, `image_status = error`, bounded "build
     target mismatch"; legacy branch => adopt on `image_ref` match or null `image_ref`; everything
     else => silent skip with no status/error/version/GC/marker write;
   - lost build: `building -> build_error` with the 60 s reachable grace / 30 min runner timeout
     from `image_build_started_at`; missing timestamp => first resolved status; clear build fields
     and keep the old image;
   - adoption pass over every app with a non-null `image_build_id`, bounded per-app failures;
   - startup cache warm; cache invalidation and TTL from the cross-cutting contract;
   - GC keep-set: `#protectedImageRefs` unions `apps.image_build_ref` while `image_build_id` is
     set. A mismatched/rejected target is never added. Candidate selection and `isManagedImage`
     stay unchanged;
   - rollback/snapshot/restore include `image_base_ref`, `image_base_kind`, `image_base_digest`,
     `image_hash_version`, and selected-version base fields; rejected marker cleared on a new build,
     valid adoption, or rollback;
   - one exported pure `deriveImageState` (or an equivalent single service function) covering all
     D5 states, `usableImageRef`, `targetImageId`, `appliedImageId`, `baseDrift`, `hashDrift`, and
     `blocked`;
   - typed errors and the shared state view from the cross-cutting contract.
6. `AppBuildInspection` receives the Dockerfile bytes/v1 hash input and resolved base kind/ref from
   this phase; registry v2-at-registration rules: new rows and rows with `image_ref = null` may get
   v2; a row with a non-null `image_ref` is never given a v2 hash at registration.
7. Wire both `ImageService` constructors to pass the base reference. Keep the constructor free of a
   manager dependency (no cycle); the CLI wiring order belongs to Phase D.
8. Tests:
   - `test/build-spec.test.ts`: v2 excludes tag/reference; tag/digest move with the same underlying
     image is not stale; real Dockerfile/args change is stale; v1/v2 never compared; v1 full
     reference reconstructs; digest-only v1 is unknown; null hash with `image_ref` is not filled.
   - new `test/base-image.test.ts`: absent/present `build.base`, `${HANSE_BASE}`, literal root,
     aliases, multistage, ARG precedence, unresolved variable/cycle, `--platform`, `base_mismatch`
     at the resolved root, `base` without env, manifest `HANSE_BASE` rejection.
   - `test/registry.test.ts`/`test/image-lifecycle.test.ts`: base kind/ref persistence, adoption
     cases and silent skip, rejected marker, lost build, terminal error clearing, target from the
     selected version, rollback/snapshot fields, v1 legacy rules.
   - `test/image-lifecycle.test.ts` and `test/service.test.ts`: state derivation table for every
     state, stopped never `restart_required`, default app never build states, selected-image
     missing/unknown, inspect unavailable, blocked predicate, cache TTL/invalidation, startup
     adoption pass.
   - `test/app-image-api.test.ts` schema-level view fields may be added here or in Phase E; do not
     claim the HTTP route until Phase E.

Acceptance: one state derivation produces every D5 state and presentation input; no false verdict
for unknown/legacy rows; base drift and hash drift are separate; adoption survives coordinator
restart; a mismatched ready record cannot be re-adopted; old image remains protected and startable.

Dependencies: Phase A storage and Phase B runner contract. Parallelization: hash/parser/base tests
can start after the schema shape is frozen; service integration waits for B. Phase D starts after C.

Risks: false `stale`/`current` from legacy rows; Dockerfile base parsing ambiguity; adoption races;
cache invalidation; rollback half-restore. Mitigation: table-driven tests, unknown-first behavior,
single state function, restore tests.

## Phase D - Runtime manager, applied identity, preflight, startup wiring

Boundaries: `src/opencode/manager.ts`, `src/cli/commands.ts` (`serveCommand` order and manager
options), manager/CLI tests. No HTTP routes or browser behavior.

Work:

1. `InstanceManagerOptions` gains the runner-backed image inspector
   (`inspectImage(ref, appId)`), build adopter (`resolveBuild`/`adoptBuild`), `imageState(appId)`,
   and `probeStatus` or an injected runtime-status function. Wire them from the CLI. The master's
   existing tools use the same manager and inherit the dependency.
2. `resolveAgentImage`: return the usable reference before rejecting a configuration error; reject
   only when `buildConfigured && image_ref === null`; use `defaultImageReference()` for a default
   app. Do not re-implement base/hash drift here.
3. Applied image ID writes:
   - destructive `ensure` through `#recordStatus`;
   - already-running reconnect and `resumeRunning` through a narrow
     `UPDATE instances SET applied_image_id = ?` that preserves `applied_settings_hash` and
     `applied_profile`;
   - `#recordStatusById` reconciler only for rows whose `COALESCE(runtime_state, state) <> 'stopped'`;
   - preserve the previous applied ID when a stop status has no container image.
4. `probeStatus(appId)`: one bounded probe for a persisted stopped row, persisting
   `instances.state`/`applied_image_id` from the returned status. `GET /image` calls it once in
   Phase E; the reconciler never probes stopped rows.
5. Start/restart preflight:
   - resolve build configuration, target reference, and target identity;
   - call the durable build adopter before target resolution; a build still `building` or not yet
     adopted is rejected with `image_not_ready` and the container is untouched;
   - default app: inspect the current default reference;
   - custom app: app-scoped inspect of the selected `apps.image_ref`; require the image to exist
     locally and carry the `hanse.app.id` label; when the version has `image_id`, require equality;
     a legacy ref without a version image ID is startable with an unknown restart verdict;
   - a rebuild-restart additionally asserts the adopted ref/image ID;
   - current build-configuration errors do not block a restart when a usable ref exists;
   - only after a passing preflight call `#stopLocked`/`#ensureLocked`;
   - image failures leave the container untouched; a non-image ensure failure after stop is a
     bounded start failure (honest, not an image claim).
6. Add async `manager.preflightRestart(app)` used by the settings restart route before any claim or
   `202`; `#restartLocked` re-checks the adopted ref. Start/ensure performs the same preflight.
7. Rollback: after `rollback()` re-read the selected row (never pass the pre-rollback authoritative
   snapshot to `#restartLocked`), run the same preflight against the post-rollback version before
   `#stopLocked`; on image failure restore the pre-rollback DB row, recompute `imageState(appId)`,
   patch the typed error's `state`/`imageStatus`, and rethrow through `rollbackImage` (not wrapped in
   `ImageRollbackIncompleteError`).
8. `#authoritativeApp` selects the selected version's `image_id` so the restart preflight compares
   without guessing. Image snapshot/restore carries base/hash fields.
9. `serveCommand` order: construct `ImageService` (and runner-backed inspector/adopter) before
   `InstanceManager`; register projects; warm the identity cache; run the adoption pass; only then
   create the HTTP server.
10. Tests:
    - `test/manager.test.ts`/`test/runtime-manager.test.ts`: usable-image rule, default resolver,
      applied-ID writes in both paths, settings preservation, reconciler excludes stopped rows,
      probe persistence, preflight rejection leaves container untouched, non-image failure wording,
      preflight before claim/202, rollback restore/recompute, master path.
    - `test/cli.test.ts`: construction order, cache warm + adoption pass before HTTP, master
      dependency wiring.

Acceptance: no start/restart/rollback stops a container when the target image is not ready; a stopped
row can be discovered by probe/ensure; reconnect/resume never clears launch settings; a coordinator
restart mid-build re-attaches and adopts.

Dependencies: Phase C. Parallelization: CLI wiring and tests can run alongside late Phase C tests
once the options interface is frozen. Phase E follows D.

Risks: applied settings hash/profile regression; lock/claim ordering; rollback restore leaving half
state; preflight race between final poll and restart. Mitigation: narrow updates, preflight before
stop/202, re-read post-rollback row, dedicated race tests.

## Phase E - HTTP/API contracts, start route, error mapping

Boundaries: `src/http/images.ts`, `src/http/chat.ts`, `src/http/prompts.ts`,
`src/http/commands.ts`, `src/http/context.ts`, `src/http/settings.ts`, `src/http/server.ts`,
`src/http/handoff.ts`, `src/http/errors.ts`, `src/master/tools.ts`,
`src/coordinator/dispatcher.ts`, and HTTP/dispatcher tests. No browser assets.

Work:

1. `GET /api/apps/:app/image`:
   - return the existing view plus every field from the cross-cutting contract;
   - rename legacy `imageId` to `latestBuildImageId`; keep `previousImageRef`/`previousImageBuiltAt`;
   - `?refresh=1` forces re-resolution instead of the 60 s cache;
   - for a persisted stopped row: call `probeStatus` once, persist, then derive/return the view;
   - rollback typed errors are mapped before `ImageRollbackIncompleteError`.
2. `POST /api/apps/:app/start`: new human-only (`principal.kind === "human"`), project-scoped route,
   same cross-site mutation check as chat mutations, body-limited, calls `manager.ensure`, returns
   the runtime state, and never restarts a running agent.
3. `POST /api/apps/:app/restart`: add the same cross-site check; run the synchronous preflight
   before the manager claim and before `?async=1` `202`. A preflight failure returns the typed error
   (not 202); a stopped app returns `restarted:false` without a claim; a running app proceeds.
4. Register start and restart dispatch in `src/http/server.ts` as explicit routes (not relying on
   the `/api/apps/` catch-all). Keep auth, project scoping, and bounded bodies.
5. `POST /api/apps/:app/build` response adds `targetRef`; semantics remain build-only. A
   `409 build_in_progress` is passed through with the existing bounded code.
6. Map `ImageNotReadyError` (409 `image_not_ready`) and `DefaultImageUnavailableError` (503
   `default_image_unavailable`) at every `ensure` site:
   - `src/http/chat.ts`: boot, message send, runtime ensure, `streamSessionEvents`, attachment
     upload;
   - `src/http/prompts.ts`: prompt submit and app-events SSE (bounded JSON 409/503);
   - `src/http/commands.ts`, `src/http/context.ts`;
   - `src/master/tools.ts`: bounded tool error, no new action;
   - `src/coordinator/dispatcher.ts`: bounded handoff failure, not a chat card;
   - `src/http/handoff.ts`: `relaunchReply` bounded operator error;
   - start/restart routes.
   Raw 502 launch text is never returned when a typed image error applies.
7. Tests:
   - `test/app-image-api.test.ts`: every view field, `imageBuildId` versus diagnostic `buildId`,
     `latestBuildImageId`, refresh behavior, stopped-row probe order, rollback typed mapping.
   - `test/settings-http.test.ts`: restart cross-site rejection, synchronous preflight before 202,
     stopped `restarted:false` without a claim, typed failure not 202, valid restart.
   - `test/chat-page.test.ts`: start route auth/human-only/scoping/cross-site, usable image while
     `building` or after `build_error` succeeds, no usable image 409, never restarts running.
   - `test/prompts-http.test.ts`, `test/commands.test.ts`, `test/context-http.test.ts`,
     `test/master-tools.test.ts`, `test/handoff-http.test.ts`,
     `test/handoff-dispatcher.test.ts`: typed image errors at each ensure site, no raw 502.
   - `test/http.test.ts`: explicit dispatch for start/restart.

Acceptance: one typed image failure everywhere; error `state` equals `GET /image`; start is
human-only and cross-site protected; restart preflight precedes 202/destructive work; build never
restarts.

Dependencies: Phase D. Parallelization: route tests can be written across files in parallel once the
view/error contract is frozen. Phase F follows E.

Risks: missed ensure site; 202 emitted after a preflight failure; stale state in the error; route
shadowed by the catch-all. Mitigation: an explicit site checklist, shared mapper, dispatch tests.

## Phase F - Chat warnings/cards, orchestration, application page

Boundaries: `assets/chat.js`, `assets/chat-core.js` (pure helpers), `assets/images.js`,
`src/http/chat.ts` (SSR gate containers only), `src/http/application.ts`,
`src/http/styles.css`, and tests/browser fixtures. No server image logic.

Work:

1. Chat boot gate:
   - fetch `GET /api/apps/:app/image` (or use the SSR snapshot) before `bootSessions`, `subscribe`,
     and `hydrate`;
   - blocked (`buildConfigured && usableImageRef === null && !running && state ∈ {not_ready,
     building, build_error}`) => render the card, suppress those three calls and the raw errors;
   - `unknown` is non-blocking; a failed fetch boots optimistically and a later `409` re-enters the
     card.
2. Use `src/http/chat.ts` to add hidden app-level gate/warning containers around the thread and
   keep the composer hidden/disabled only while blocked. Do not render image failures through
   `showSessionsError`/`showThreadError`.
3. Cards/warnings use D5/D12 precedence and exact bounded copy:
   - `not_ready` Build and start; `building` progress; `build_error` Retry build and start;
   - running warnings for `building`, `build_error`, running `not_ready` (Rebuild & restart), and
     `rebuild_required` (Rebuild & restart), `restart_required` (Restart);
   - stopped apps never show the `restart_required` warning; default-image apps show the separate
     no-build unavailable card with no build action.
4. Build and start: `POST /build`; on `409 build_in_progress`, re-fetch `GET /image` and attach only
   when `imageBuildId !== null && state === "building"`; otherwise show "another image build is
   running; retry" and do not poll as this app's build. Poll `GET /image` every 2 s bounded by the
   runner's 30 min timeout; on ready `POST /start`; then reset SSE `failures = 0`, call
   `reconnectStream()`, boot/hydrate, select the last session, reveal the composer, refresh image
   state. Record the build-and-start intent in `sessionStorage` for reload resume.
5. Rebuild & restart: same build/poll; on ready `POST /restart`; server preflights; on success
   reconnect; on `image_not_ready` refresh state and keep the old container. A build failure never
   stops anything.
6. Refresh: while running, refresh immediately on stopped -> running, then every 60 s and on
   `visibilitychange` to visible; no per-request Docker. Two tabs rely on the durable build ID and
   `ensure` attach; no client owns the build.
7. Application page: both the custom and default image panels get `data-image-url`; the SSR shell
   uses persisted `RegisteredApp` values as a placeholder only. `assets/images.js` fetches
   `GET /image` on load and renders the derived `state` (not raw `imageStatus`), base kind/ref, and
   rollback state; the default panel never shows build states.
8. Add pure helpers in `assets/chat-core.js` for testability: gate decision, warning selection,
   build-attach predicate, poll cadence, and state-to-copy mapping. `assets/chat.js` consumes them.
9. CSS for the card/banner at phone and desktop widths, light/dark; rebuild `assets/app.css` with
   `npm run build:css`.
10. Tests:
    - `test/chat-core.test.ts`: pure gate/warning precedence, attach predicate, poll bounds,
      reload intent.
    - `test/chat-page.test.ts`: gate containers SSR, composer gating, no raw 502 path, unknown
      boots, 409 re-entry.
    - `test/application-page.test.ts`: both panels carry `data-image-url`, placeholder values, no
      `renderApplication` signature change, and the panel markup/asset wiring; browser QA covers
      the `images.js` runtime state rendering so it does not key on raw `imageStatus` for the
      verdict.

Acceptance: a not-ready custom app never boots sessions or shows a raw launch error; a running
outdated app stays usable and warns with the right action; build/start/restart waiting and reconnect
work across reloads; the application page shows derived state on both panel types.

Dependencies: Phase E contract. Parallelization: application-page markup/JS can start once the
`GET /image` view fields are frozen; chat orchestration waits for the start route.

Risks: boot-order regressions; SSE paused after a stop/ensure restart; two-tab attach; composer
gating hiding a genuine runtime failure. Mitigation: pure helper tests, explicit `unknown`
non-blocking, browser QA.

## Phase G - Docs, deployment config, browser QA, live smoke, record

Boundaries: docs, `.env.example`, `compose.yaml`, `docs/design/chat-qa.mjs`, artifact notes, and the
journal. No new product behavior.

Work:

1. `compose.yaml`: add `HANSE_AGENT_BASE_IMAGE` to both the coordinator and runner environments.
   Default it to the `hanse-agent-base` repository at `${HANSE_AGENT_TAG:-${HANSE_TAG:-latest}}`.
   `.env.example`: document the variable as a full reference (repository + optional tag or
   `@sha256` digest), state that `build.base=base` requires it, and that deployment must pull the
   default and base images before recreating services. Do not add a separate base-tag variable.
2. `docs/current-state.md`: replace the single "base digest" description with the two identity
   domains, per-app base kind/ref, durable build identity/adoption, state model, startability, chat
   card/warning, start route, and migration 18.
3. `docs/conventions.md`: document optional `build.base` (`default | base`), the Dockerfile
   final-`FROM` fallback and `HANSE_BASE` ownership, `base_mismatch`, hash v2, and the identity
   domains.
4. `docs/deployment.md`: document `HANSE_AGENT_BASE_IMAGE`, pull-before-recreate, `unknown` on an
   absent image, schema 18 forward-only, and upgrade/rollback expectations from the rollout section.
5. Update `docs/design/agent-image-validity.md` status to implemented/verified, correct its plan
   link to `docs/plans/0028-agent-image-validity.md`, and update `docs/design/README.md` and
   `docs/plans/README.md`.
6. Write `docs/journal/0033-agent-image-validity.md` and add it to `docs/journal/README.md`:
   phases, decisions, residual risks (including the owner override of the missing Oracle PASS),
   migration/backfill evidence, browser QA, live-smoke result, accepted limits, and follow-ups.
7. Browser QA: extend `docs/design/chat-qa.mjs` with deterministic fixtures for `not_ready`,
   `building`, `build_error`, `current`, `restart_required`, and `rebuild_required`, plus the
   build/start/restart actions, the 409-another-build state, and both application image panels.
   Screenshots at phone/desktop and light/dark. Add exact `CHAT_QA_ONLY`-addressable scenario
   names: `image-not-ready`, `image-building`, `image-build-error`, `image-warning`,
   `image-actions`, and `image-panels`. Do not change existing scenario assertions. Run
   `npm run build` first, then
   `CHAT_QA_ONLY=image-not-ready,image-building,image-build-error,image-warning,image-actions,image-panels node docs/design/chat-qa.mjs`.
   The full harness has a known pre-existing `main` queue-strip assertion failure; record it as
   baseline, not as this feature.
8. Live smoke on a disposable test application (placeholder IDs only in tracked output): remove or
   rebuild the custom image and confirm card -> build -> start -> chat connection; on a running app
   with a changed base, confirm warning -> rebuild & restart -> sessions survive; on a default app,
   repoint the tag, restart, and confirm the new image ID. If no disposable app/token is available,
   record the blocker explicitly and do not claim live verification.
9. Run all gates and `npm run check:sensitive`; scan binary QA artifacts manually for leaked data.

Acceptance: docs match shipped behavior and contain no host specifics; Compose/env config is
complete; browser QA passes for the new scenarios with no console/page errors; live smoke is either
recorded as passed with placeholders or explicitly blocked; the plan/design/journal indexes are
consistent.

Dependencies: Phase F. Parallelization: docs can be drafted alongside F, but QA evidence and the
journal are written after F.

Risks: browser QA harness baseline failure; live environment unavailable; docs drift; accidental
host data in screenshots. Mitigation: focused scenario filter, explicit blocker recording, manual
artifact review, `check:sensitive`.

## Dependencies and parallelization summary

| Phase | Depends on | Can run in parallel with | Unlocks |
| --- | --- | --- | --- |
| A storage/registry | - | B | C storage/flag inputs |
| B runner identity | - | A | C runner contract |
| C image service | A, B | late A/B test fixes | D |
| D manager/runtime | C | CLI test prep | E |
| E HTTP/API | D | F markup prep | F |
| F chat/application | E | G docs drafting | G |
| G docs/QA/record | F | - | commit/record |

Do not merge a phase that leaves an ambiguous contract for the next. A and B can land as independent
commits; C must assume the exact field/route contracts in this plan.

## Residual design-review register (all 12 rounds)

Every item below is a resolved review finding that implementation must still honor or explicitly
accept. The number is the item number in design section 11. "Must cover" names the phase whose
acceptance/tests must prove it.

### Round 1

| # | Residual checkpoint | Disposition |
| --- | --- | --- |
| 1 | Separate image ID and manifest digest domains; never compare them | Must cover: A, B, C, D |
| 2 | Runner must expose image IDs and `RepoDigests` | Must cover: B |
| 3 | Authenticated runner inspect route | Must cover: B, C |
| 4 | Explicit digest preference; no-`RepoDigests` is unknown | Must cover: B, C |
| 5 | Default launch identity is guaranteed by the runner | Accepted risk: a running container stays on its old image until launch; must cover B, D |
| 6 | Optional `build.base` with Dockerfile fallback | Must cover: A, C |
| 7 | Base image allowlisted in runner code and Compose | Must cover: B, D |
| 8 | Hash v2 excludes the base reference | Must cover: C |
| 9 | Base metadata threaded through build/persistence | Must cover: A, C |
| 10 | Legacy rows never infer the base from the current Dockerfile | Accepted risk: legacy base stays unknown until the next build; must cover A, C |
| 11 | One startability rule for `error`/`building` with a prior image | Accepted risk: stale starts allowed by owner; must cover C, D |
| 12 | Full state table including running `building`/`not_ready` and `build_error` | Must cover: C, E, F |
| 13 | Default app is never `not_ready` from image status | Must cover: A, C |
| 14 | Runner restart does not leave `building` stuck with a prior image | Must cover: C |
| 15 | Restart preflight before destructive work | Must cover: D |
| 16 | `image_not_ready` mapped at every ensure site | Must cover: E |
| 17 | EventSource cannot read the typed body; boot gate first | Must cover: F |
| 18 | SSE reset/reconnect and periodic image refresh | Must cover: F |
| 19 | Durable build adoption across a coordinator restart | Must cover: C, D |
| 20 | Target ID from the selected version, not the runner's latest record | Must cover: C |
| 21 | `applied_image_id` has a runner/supervisor source | Must cover: B, D |
| 22 | New columns threaded through all reads/writes; GC scope fixed | Must cover: A, C |
| 23 | Start/restart cross-site protection and explicit dispatch | Must cover: E |
| 24 | Master tools unchanged except typed-error mapping | Must cover: D, E |
| 25 | Verification/impact gaps closed by tests | Must cover: G |

### Round 2

| # | Residual checkpoint | Disposition |
| --- | --- | --- |
| 1 | In-flight build target protected from GC | Must cover: B, C |
| 2 | Null-hash legacy row with `image_ref` is not falsely current | Accepted risk: hash drift unknown until the next build; must cover C |
| 3 | Final-stage alias inherits the root base kind; mismatch checks the root | Must cover: C |
| 4 | Explicit base references have a cached current-digest path | Must cover: C |
| 5 | Custom restart preflight uses app-scoped inspect and manager inspector injection | Must cover: D |
| 6 | Digest-pinned default can launch | Must cover: B, D |
| 7 | Start succeeds with a usable image during `building`/after `build_error` | Must cover: C, E |

### Round 3

| # | Residual checkpoint | Disposition |
| --- | --- | --- |
| 1 | Legacy null-hash/digest-only v1 rules never produce a false verdict | Accepted risk: digest-only v1 remains unknown; must cover C |
| 2 | Digest-pinned default reaches the runner through `defaultImageReference()` | Must cover: D |
| 3 | Durable-ID adoption asserts `image_build_ref`; terminal error clears fields | Must cover: C |
| 4 | Async restart preflight precedes claim and 202 | Must cover: E |
| 5 | `listApps`, `#authoritativeApp`, and supervisor status are threaded | Must cover: A, D |
| 6 | Runner in-memory build tags close the GC pre-persistence race | Must cover: B, C |

### Round 4

| # | Residual checkpoint | Disposition |
| --- | --- | --- |
| 1 | Adoption mismatch clears build fields, records rejected ref, keeps only the old image protected | Must cover: C |
| 2 | Digest-only legacy v1 is permanently unknown, never stale | Accepted risk: unknown until rebuild; must cover C |
| 3 | Build adopter injected into `InstanceManagerOptions` and CLI wiring | Must cover: D |
| 4 | `listApps` uses durable `build_configured` | Must cover: A |
| 5 | Runner protected-build-tag provider wired to GC route | Must cover: B |
| 6 | Application page derives state from `GET /image`; both panels fetch | Must cover: F |

### Round 5

| # | Residual checkpoint | Disposition |
| --- | --- | --- |
| 1 | Rejected ref is never re-adopted by either branch | Must cover: A, C |
| 2 | Startup adoption pass is wired to the startup call site | Must cover: C, D |
| 3 | `build_configured` writers: registration, check, build, provisioning | Must cover: A (registration/provisioning), C (check/build) |
| 4 | Unknown comparable hash/base yields `unknown`, never `current` | Must cover: C |
| 5 | ImageService is constructed before the manager or a standalone adopter is injected | Must cover: D |
| 6 | Application page default panel has `data-image-url`; SSR is a placeholder | Accepted risk: placeholder values may show briefly before the fetch; must cover F |
| 7 | `default_image_unavailable` typed mapping and no-build card | Must cover: E, F |

### Round 6

| # | Residual checkpoint | Disposition |
| --- | --- | --- |
| 1 | Registration preserves a rejected ref/build error | Must cover: A, C |
| 2 | Startup adoption pass runs before HTTP with bounded per-app failures | Must cover: D |
| 3 | `blocked` is the cold-start predicate; running `not_ready` is a warning | Must cover: C, F |
| 4 | Typed errors take `state` from the injected `imageState` | Must cover: D |

### Round 7

| # | Residual checkpoint | Disposition |
| --- | --- | --- |
| 1 | A ready-but-not-adopted record mutates nothing and is not GC-protected | Must cover: C |
| 2 | Plain build never restarts; only explicit Rebuild & restart restarts | Must cover: C, F |
| 3 | `build_error` includes live inspection error; pre-runner failure persists error | Must cover: C |

### Round 8

| # | Residual checkpoint | Disposition |
| --- | --- | --- |
| 1 | Registration does not clear a persisted `build_error`/mismatch | Must cover: A, C |
| 2 | Rollback verdict is qualified by matching hash/base vs different Dockerfile/base | Must cover: C |

### Round 9

| # | Residual checkpoint | Disposition |
| --- | --- | --- |
| 1 | Three adoption cases: durable match+ref match adopt; mismatch error; everything else silent skip | Must cover: C |
| 2 | Registration reads `image_error`/base/hash-version/rejected-ref for preservation | Must cover: A |
| 3 | Null version `image_id` is unknown; legacy-hash version with a known ID uses normal comparison | Must cover: C |
| 4 | Reconnect applied-ID write is narrow and preserves settings | Must cover: B, D |

### Round 10

| # | Residual checkpoint | Disposition |
| --- | --- | --- |
| 1 | Reconcile persists only applied ID/build fields, not base metadata | Must cover: C |
| 2 | v1 hash recompute has an input path (`AppBuildInspection` bytes/hash) | Accepted risk: unreconstructable v1 stays unknown; must cover A, C |
| 3 | Reconciler never probes stopped rows; probe is ensure/start or `GET /image` | Accepted risk: bounded latency for out-of-band changes; must cover D, E |
| 4 | Rollback uses the same preflight and restores the DB row on failure | Must cover: D |
| 5 | Session SSE, attachment upload, and handoff dispatch map typed errors | Must cover: E |

### Round 11

| # | Residual checkpoint | Disposition |
| --- | --- | --- |
| 1 | Stopped-row probe is `InstanceManager.probeStatus`, called once by `GET /image` | Must cover: D, E |
| 2 | Rollback typed error is rethrown through `rollbackImage` after the restore, not wrapped | Must cover: D, E |
| 3 | `409 build_in_progress` for another app does not attach/poll as this app | Must cover: F |
| 4 | `HandoffDispatcher.relaunchReply` and `http/handoff.ts` map typed failures | Must cover: E |

### Round 12

| # | Residual checkpoint | Disposition |
| --- | --- | --- |
| 1 | Durable `imageBuildId` and diagnostic `buildId`; exact attach predicate | Must cover: C, E, F |
| 2 | Locally missing/contradictory selected image is `not_ready`; inspect unavailable is `unknown` | Accepted risk: unknown never produces a false verdict; must cover C, F |
| 3 | Rollback error state recomputed after the pre-rollback row restore | Must cover: D, E |
| 4 | Stopped-row probe is in Impact/wiring (`http/images.ts` order) | Must cover: E |

## Verification matrix

| Check | Command / location | Phase | Evidence required |
| --- | --- | --- | --- |
| Lint | `npm run lint` | all | exit 0 |
| Types | `npm run typecheck` | all | exit 0 |
| Unit/integration | `npm test` | all | all tests pass, including the files below |
| Build | `npm run build` | all | `dist/` and `assets/app.css` produced |
| Sensitive data | `npm run check:sensitive` | all | exit 0; manual binary-artifact review |
| Migration/backfill | `test/migrations.test.ts`, `test/registry.test.ts`, `test/schema.test.ts`, `test/store.test.ts` | A | v17 -> 18 upgrade, defaults/constraints, field preservation, `build_configured` backfill and writers |
| Base parser/hash | `test/base-image.test.ts`, `test/build-spec.test.ts` | C | every D2/D3 case, alias/ARG/mismatch, v1/v2 separation, no false stale |
| State/service | `test/image-lifecycle.test.ts`, `test/service.test.ts`, `test/registry.test.ts` | C | every D5 state, unknown rules, adoption cases, lost build, target/rollback, cache |
| Runner identity | `test/runner-containers.test.ts`, `test/docker-build.test.ts`, `test/runner-build.test.ts`, `test/runner-validate.test.ts`, `test/image-gc.test.ts` | B | inspect/launch/allowlist/build record/GC protection |
| Manager/preflight | `test/manager.test.ts`, `test/runtime-manager.test.ts`, `test/cli.test.ts` | D | applied ID paths, preflight untouched container, rollback restore, startup order |
| HTTP contracts | `test/app-image-api.test.ts`, `test/settings-http.test.ts`, `test/chat-page.test.ts`, `test/prompts-http.test.ts`, `test/commands.test.ts`, `test/context-http.test.ts`, `test/master-tools.test.ts`, `test/handoff-http.test.ts`, `test/handoff-dispatcher.test.ts`, `test/http.test.ts` | E | view fields, start/restart auth/cross-site/preflight, typed mapping at every site |
| Chat/application UI | `test/chat-core.test.ts`, `test/chat-page.test.ts`, `test/application-page.test.ts`, asset tests | F | gate order/precedence, orchestration helpers, panel `data-image-url`, state rendering |
| Browser QA | `npm run build` then `CHAT_QA_ONLY=image-not-ready,image-building,image-build-error,image-warning,image-actions,image-panels node docs/design/chat-qa.mjs`; then full harness for baseline only | G | report/screenshots for six states and actions at phone/desktop, light/dark; zero console/page errors; known `main` baseline recorded |
| Live smoke | disposable test application with placeholder IDs | G | custom card/build/start/chat; running base change -> rebuild & restart with sessions preserved; default tag repoint -> new image ID; or explicit blocker |
| Deployment rollback | pre-upgrade DB backup + schema-guard check | G | v18 is forward-only; an older coordinator refuses schema 18; rollback restores the backup; no down migration |

## Rollout and rollback

1. **Pre-upgrade.** Back up the state volume/database. Pull the coordinator, runner,
   `agent-default`, and `agent-base` images before recreating services. Set
   `HANSE_AGENT_BASE_IMAGE` to the intended base reference (tag or `@sha256`); without it,
   `build.base=base` is a configuration error. The deployment supplies the value; repository code
   only defines the variable and its default.
2. **Schema.** Migration 18 runs at coordinator startup. The schema guard fails closed on a
   newer/unknown applied migration. There is no down migration.
3. **Existing rows.** Startup registration backfills `build_configured` for every registered app.
   Directly provisioned apps write it in the provisioning transaction. Legacy base kind/ref and
   v1 hash remain unknown; no app is marked stale from a fabricated identity. Existing `image_ref`
   and version rows are not rewritten.
4. **Behavior.** No agent is rebuilt, restarted, or recreated by the upgrade. A default app becomes
   `restart_required` only after a launch records an applied ID and a known target ID differs; a
   custom app becomes `restart_required` only after a successful build selects a new version and the
   running container still has the old applied ID. A plain image build never restarts.
5. **Identity cache.** Warm after the image pull. An unpulled/absent reference is `unknown` and
   retried; it is never treated as current. A default launch with an uninspectable target fails
   closed rather than starting an old image.
6. **Rollback.** Code rollback after migration 18 is not a simple tag revert: an older coordinator
   sees schema 18 as newer and refuses to start. Restore the pre-upgrade database backup (and the
   matching state) or ship a forward fix. Do not attempt a down migration or edit applied migration
   rows.
7. **Out of scope.** Host resource sizing and recreation of deployment applications are
   deployment-runbook concerns, not this feature. Do not encode them in tracked docs or tests;
   keep host specifics in the untracked deployment directory. This feature only requires the image
   pull-before-recreate and environment-variable notes above.

## Commit policy and stage boundaries

- One coherent commit per completed phase: A, B, C, D, E, F, G. Each commit includes its code,
  tests, and the docs it changes; Conventional Commits (`feat(images): ...`,
  `fix(images): ...`, `docs(images): ...`).
- A and B are independent commits but must both precede the C service integration.
- The final commit (G) includes the journal, index updates, browser QA evidence, and the live-smoke
  record (or explicit blocker). Do not claim implementation or verification in an earlier commit.
- The owner override is explicit: 12 review rounds returned CHANGES REQUESTED; the owner accepted
  the design and chose to proceed without an Oracle PASS. Residual risks are listed above and in the
  journal; they are not silently waived.
- Do not commit until the maintainer authorizes it, unless autonomous mode explicitly allows it.
  Never commit secrets, host details, real project/session IDs, or live QA screenshots of real data.

## Open decisions and assumptions

- **Open decisions: none.** The owner decisions in design section 8 settle every product fork this
  plan depends on.
- Assumption: `HANSE_AGENT_BASE_IMAGE` is a full image reference (repository plus optional tag or
  `@sha256`); no separate base-tag variable is added. Compose derives a default tag from
  `HANSE_AGENT_TAG`/`HANSE_TAG`.
- Assumption: migration 18 follows the repository's existing migration style with NULL-valid enum
  checks and integer boolean/version checks; no backfill of base kind or hash version.
- Assumption: the design's plan filename reference is corrected to `0028-agent-image-validity.md` in
  Phase G; this plan does not edit the design now.
- No other unresolved item was found in the design. If implementation discovers a contradiction, it
  stops and records it as an owner question rather than guessing.

## Plan review checklist

- Every design decision D1-D15 and requirements V1-V16 maps to a phase, a test, or an explicit
  accepted risk.
- Every residual item from all 12 review rounds is listed above with a phase or accepted-risk
  disposition.
- No phase claims implementation; status remains plan draft until `momus` reviews it.
- This plan artifact changes only this file and the plan index; source, tests, and other documents
  remain untouched until implementation starts.
