# Design - Agent image validity, rebuild, and restart

Status: **implemented; automated gates and browser QA pass; live smoke pending** - Phases A-F are
implemented and Phase G adds docs/config/record. `npm run lint`, `npm run typecheck`, `npm test`
(with `HANSE_CREDENTIALS_DIR` unset), `npm run build`, and `npm run check:sensitive` pass. The
deterministic browser QA passes six image scenarios with 32 screenshots and zero console/page
errors; live smoke is pending because this environment has no disposable application. The owner
override of the missing Oracle PASS remains explicit: rounds 1 through 12 of design review
(`oracle`) returned CHANGES REQUESTED; all findings and resolutions are recorded in section 11. On
2026-10-25 the owner chose to freeze the design and proceed to the plan, handling residual items as
they arise. No Oracle PASS was issued; residual risks are tracked in
`docs/plans/0028-agent-image-validity.md`.
Scope: per-application agent image identity, base tracking for custom images (`agent-base` vs
`agent-default`), startup and on-demand reconcile, chat warnings for running outdated agents, the
chat "image not ready" state with a build-and-start action, and the rebuild/restart orchestration.
Out of scope: implementation in this document, image-build internals, and changes to build validation
or garbage collection. The new `HANSE_AGENT_BASE_IMAGE` variable is repository code (runner config,
allowlist, Compose); deployment only supplies its value.

## 1. Problem

An application agent runs an image, not the coordinator's code. After a Hanse deployment, an agent
container can keep running an older image while the coordinator has no durable notion of which image
it should be running. Four cases are currently invisible or misleading:

- A running application on the default image keeps using the old `agent-default` image until it is
  restarted. The coordinator records the image reference but not the image the container was launched
  with, so it cannot tell whether a restart would change anything.
- A custom application image may be built from `agent-base` or `agent-default`. The coordinator
  records a single "base digest" slot, cannot tell which base it was, and only notices a change when
  the build-spec hash changes - a comparison that also includes the base reference string, so a
  harmless tag move marks the image stale.
- A custom application with no built image makes the chat try to start the agent on open. The start
  fails in `resolveAgentImage`, and the chat shows the raw 502 message in the sessions and thread
  error states. The runtime chip still says "Stopped", the SSE retries and pauses, and there is no
  build action on the page.
- A running agent whose image was rebuilt keeps running the old container; the image card on the
  application page has a "restart to use the new image" notice, but the chat has no warning.

The coordinator must compare **the right identity in each domain** - Docker image ID for
applied-versus-target, manifest digest for base drift - and never the coordinator revision or a tag
string. If Hanse is updated but the relevant base image digests did not change, no agent is outdated.

## 2. Requirements

| ID | Requirement |
| --- | --- |
| V1 | Running on a stale image is allowed. A cold start is blocked only when the application is build-configured and has no usable built image reference (`apps.image_ref` is null). A prior usable image remains startable while a rebuild runs and after a rebuild fails. |
| V2 | Default-image applications track the image ID the container was launched with and the current `agent-default` image ID. A difference marks a **running** agent restart-required. Launching the default image always uses the current image, so only a restart is needed. |
| V3 | Custom images record their actual base: `default`, `base`, `explicit`, or `unknown`, with the base reference and the base manifest digest. The current digest of the matching base is compared. |
| V4 | A custom image whose base digest changed is rebuild-required. Dockerfile/build-arg staleness remains rebuild-required. After a rebuild, a running container on the old built image is restart-required. |
| V5 | No coordinator-revision comparison is used. If the relevant image digests did not change, a Hanse update does not mark any agent outdated, even when `HANSE_REVISION` or the image tag changed. |
| V6 | Unknown or unresolvable identities never produce a false outdated, restart, or not-ready verdict. They render as unknown and are retried on the next refresh. |
| V7 | A running outdated agent shows an app-level warning in the chat with an action: Restart for the default image, Rebuild & restart for a custom image. The chat remains usable while the warning is shown. |
| V8 | A custom application with no usable image and not running shows a clear app-level card in the chat instead of the raw launch error, with a "Build and start" action. |
| V9 | "Build and start" waits on the same chat page: build (or attach to an active build), poll image status, start the agent, then connect sessions/events and reveal the chat. A build or start failure is shown in the card with a retry. |
| V10 | "Rebuild & restart" builds, waits, and immediately restarts the running agent on the new image. A build failure keeps the old container and the chat usable. An image-caused restart failure keeps the old container and leaves the warning with a retry. |
| V11 | Image build and the new browser start action are human-only. The master agent's existing allowlisted `start_app`/`restart_app` tools remain the only agent-initiated start/restart path; no agent gains image build, image inspection, or arbitrary image references. |
| V12 | The chat page, the application page, and the HTTP error use one shared state result: `current`, `restart_required`, `rebuild_required`, `building`, `build_error`, `not_ready`, `unknown`. |
| V13 | Existing behavior is preserved: stale start, settings `pendingRestart`, image build/check/rollback, SSE, session persistence, and deletion. |
| V14 | Two identity domains, never mixed: applied-versus-target always compares Docker image IDs (container `Image` versus image inspect `Id`); base drift always compares manifest digests (`RepoDigests`). |
| V15 | `build.base` is optional and has no schema default. Resolution order: explicit `build.base`; else resolve the final stage to its root external `FROM` through stage aliases and ARG values; a root that consumes `${HANSE_BASE}` means `default`, a literal root means `explicit`, otherwise `unknown`. A configured `build.base` whose resolved root ignores `HANSE_BASE` is rejected as a configuration error. |
| V16 | The build-spec hash is version 2: Dockerfile bytes + sorted build args + base kind only. The base reference/tag/digest is excluded and compared separately. Stored version-1 hashes are never compared with version-2 hashes. |

## 3. Verified current behavior

- `apps` carries `image_ref`, `image_status`, `image_hash`, `image_base_digest`, `image_built_at`,
  and `image_error`; `app_image_versions` carries `image_ref`, `image_id`, `spec_hash`,
  `base_digest`, `built_at`. `instances` records `image_ref` but has no applied image ID. The latest
  migration is 17.
- `registerProject` recomputes the build spec and calls `mergeImageMetadata` at coordinator start.
  Applications with a changed Dockerfile, build args, or default reference string become `stale`.
  Applications without `.hanse/app.yaml` build config get a `missing` image status.
- `resolveAgentImage` allows `ready` and `stale`, and rejects `missing`, `building`, and `error` even
  when `image_ref` points at a usable prior image. A running container is reused before the image
  check.
- `computeBuildSpecHash` hashes the Dockerfile bytes, sorted build args, and
  `defaultImageReference()` (the `HANSE_AGENT_IMAGE` string plus an optional
  `HANSE_AGENT_IMAGE_DIGEST`). The digest env is supported by code but is not passed by
  `compose.yaml`. The current base digest is derived from that reference string, not inspected.
- `DockerImageInspect` has `Id`, `RepoTags`, and `Config`, but no `RepoDigests`.
  `DockerContainerInspect` has no top-level `Image`; `statusFromInspect` returns no image ID.
  `inspectImage` exists in `src/runner/docker.ts` but is internal; there is no runner HTTP route to
  resolve a digest and the coordinator never talks to Docker.
- `computeSpecHash` includes the image reference string, not the image ID, and the runner reuses an
  existing container when the spec hash matches. A stopped container on a repointed tag would
  therefore be started on the old image.
- `ImageService.build` always sends `this.#defaultImage` as the base and records
  `digestFromReference(this.#defaultImage)`. `#recordVersion` writes only `base_digest`; rollback and
  the manager image snapshot do not carry a base kind. `#applyRecord` records a lost build as `error`
  only when `image_ref` is null, and adopts a ready record only while `#active` is set or the status
  says `building`/the ref matches.
- `pendingRestart` is derived from `instances.applied_settings_hash` and `applied_profile`; it does
  not consider images. There is no stored `pending_restart` column.
- The chat SSR always renders the composer and thread; `GET /chat` does not start the agent. The
  client `bootSessions`, app-event `subscribe`, and `hydrate` calls reach `manager.ensure`. The
  sessions and thread error components display the raw 502 message. `subscribe` pauses after three
  failures and only reconnects when the user retries or `reconnectStream` is called explicitly.
- There is no HTTP start route. `POST /api/apps/:app/restart` is in `src/http/settings.ts` and returns
  `restarted:false` for a stopped application; it has no origin check. `POST /api/apps/:app/build`
  only builds and is human-only. `GET /api/apps/:app/image` returns the image status view and
  refreshes the persisted status.
- The master agent exposes `start_app` and `restart_app`; both call the manager directly.
- The runner config derives `allowedImages` from `HANSE_ALLOWED_AGENT_IMAGES` or
  `HANSE_AGENT_IMAGE`; `validateBuildRequest` rejects any other base. There is no
  `HANSE_AGENT_BASE_IMAGE` handling.
- GC already protects running containers and only considers managed app images; base images are
  outside `isManagedImage`.

## 4. Decisions

### D1 - Two identity domains

The coordinator resolves and compares two different values for two different questions. They are
never compared with each other.

| Question | Left side | Right side | Source | Never |
| --- | --- | --- | --- | --- |
| Is the running container on the target image? | applied image ID | target image ID | container `Image`; image inspect `Id`; `app_image_versions.image_id` | a manifest digest, a tag string, `Config.Image` |
| Did the base image drift? | stored base manifest digest | current base manifest digest | build-time `RepoDigests` resolution; current `RepoDigests` resolution | an image ID, a tag string |

- Applied image ID: the container's top-level `Image` field (Docker image ID). `Config.Image` holds
  the reference used at create time and is not an identity.
- Target image ID for a default application: the runner's `Id` for the current default reference.
- Target image ID for a custom application: `app_image_versions.image_id` for the selected
  `apps.image_ref`, never the runner's latest build record.
- Base manifest digest: resolved by the runner from the local image's `RepoDigests`, in this order:
  1. an explicit `@sha256:<64>` in the configured `HANSE_AGENT_IMAGE`/`HANSE_AGENT_BASE_IMAGE` (or in
     the recorded explicit base reference) wins;
  2. otherwise the `RepoDigests` entry whose repository matches the reference repository; exactly
     one distinct digest is required;
  3. otherwise `unknown`.
- A locally built or locally loaded image without `RepoDigests` yields `unknown`; it is not treated
  as always-current. A registry-less explicit base therefore has no base-drift verdict.
- All multi-arch/manifest-list caveats are avoided by resolving both sides with the same rule from
  the same local image; the design never compares an index digest to a platform image ID.
- An image ID or digest that does not match `sha256:<64>` is not an identity; it is `unknown`.
- A null applied image ID means unknown. It never produces `restart_required`.
- `HANSE_REVISION` is not consulted anywhere.

### D2 - Optional explicit base selection plus Dockerfile fallback

`build.base` becomes optional in `.hanse/app.yaml` (`"default" | "base"`, no default value). Its
absence is meaningful and enables the Dockerfile fallback.

The base is resolved once per inspection in this order:

1. **Explicit `build.base`**: `default` uses `HANSE_AGENT_IMAGE` (via `defaultImageReference()`,
   including `HANSE_AGENT_IMAGE_DIGEST`); `base` uses `HANSE_AGENT_BASE_IMAGE`. `base` without
   `HANSE_AGENT_BASE_IMAGE` is a configuration error, never a silent default.
2. Resolve the final stage to its single root external `FROM` by following stage aliases recursively
   and resolving ARG values (manifest `build.args` first, then Dockerfile defaults). Only the root is
   classified; a final stage that aliases another stage inherits that root's kind.
3. **Root consumes `${HANSE_BASE}`** (in `${HANSE_BASE}`, `${HANSE_BASE:-...}`, or an equivalent
   form that references the variable): kind `default`, base reference is the configured default
   reference.
4. **Root is a literal reference**: kind `explicit` with that resolved reference.
5. Otherwise: `unknown`; base-driven staleness is disabled until a successful build.

Dockerfile parsing rules:

- Only the final stage matters. `--platform=<...>` is ignored and does not affect the base identity,
  but it is not used to change the image reference.
- Global `ARG`s before the first `FROM` and per-stage `ARG` defaults are supported in `${VAR}`,
  `$VAR`, and `${VAR:-default}` forms.
- Manifest `build.args` take precedence over Dockerfile `ARG` defaults.
- `HANSE_BASE` is coordinator-owned; a manifest build arg named `HANSE_BASE` is a configuration
  error.
- If a variable in the final `FROM` cannot be resolved, or an alias chain is cyclic, the result is
  `unknown`; it is never guessed.
- If `build.base` is set but the resolved root `FROM` does not consume `${HANSE_BASE}`, the build
  configuration is rejected with a bounded configuration error (`400`, code `base_mismatch`). The
  check applies to the root after alias/ARG resolution, not to the final stage text. The coordinator
  never records a false `default`/`base` kind for such a Dockerfile. A final stage that aliases a
  stage whose root consumes `${HANSE_BASE}` is `default`; only a literal root is `explicit`.

The base comparison is by kind:

| base_kind | Current target |
| --- | --- |
| `default` | manifest digest of the current `HANSE_AGENT_IMAGE` reference |
| `base` | manifest digest of the current `HANSE_AGENT_BASE_IMAGE` reference |
| `explicit` | manifest digest of the recorded `base_ref`: a moving tag is resolved now; an explicit `@sha256` pin resolves to itself and never drifts |
| `unknown` | no base-driven verdict |

`HANSE_AGENT_BASE_IMAGE` is added to the runner configuration and the allowlist: it becomes a
`baseImage` field and is unioned into `allowedImages` in `src/runner/validate.ts`. It is also added
to the coordinator and runner environments in `compose.yaml` (and `.env.example`), and the
coordinator reads the same variable in its inspection/build path and `ImageService` constructors so
it can resolve kind `base` and the current base reference. `validateBuildRequest` therefore accepts
the base instead of returning a runner 400 on every base build. Explicit base references are already
constrained to this allowlist at build time; if a configuration change later removes one, base drift
for the old image is `unknown`, not an error. A base outside `allowedImages` is rejected by the
runner, both at build time and at the inspect route.

The build request's `baseImage` is the resolved reference for `default`, `base`, and `explicit`.
When the resolved kind is `unknown`, the request still sends the configured default reference as an
allowlisted placeholder for the `HANSE_BASE` argument (a complete Dockerfile may ignore it); the
request carries kind `unknown` and null base ref/digest, and the coordinator records the same, so
the placeholder is never persisted as a base. Base drift is disabled in that case. Only the
contradictory `build.base` case above is rejected; an unresolved literal `FROM` is allowed to build,
but it produces no base verdict.

The runner labels the built image with `hanse.base.kind`, `hanse.base.ref`, `hanse.base.digest`, and
`hanse.image.version`, and records the same values in the build record. The coordinator persists the
record values; labels are diagnostic, not authoritative.

### D3 - Build-spec hash version 2 and legacy v1 rows

Version 2 hashes exactly: the Dockerfile bytes, the sorted build args, and the base kind. The base
reference, tag, and digest do not participate; base drift is compared separately by manifest digest.

- `apps.image_hash_version` and `app_image_versions.hash_version` distinguish versions.
- New rows and new successful builds write version 2. Registration writes version 2 when it creates
  a row, or when the existing row has no built image (`image_ref` is null) and therefore no prior
  comparable hash. An existing row with a non-null `image_ref` is never given a v2 hash at
  registration; only its next successful build writes one.
- A stored version-1 hash is never compared with a version-2 hash.
- For a version-1 row, the coordinator may recompute the v1 hash using the legacy base reference
  recorded in `apps.image_base_digest`. The reconstruction is exact only when the stored value is a
  full reference. A digest-only value is not reconstructible because the historical non-digest
  reference and its tag were never stored; digest-only v1 rows therefore treat hash drift as
  `unknown` until the next build and are never marked `stale` from the hash. This prevents a false
  stale verdict.
- A row with a non-null `image_ref` and a null stored hash or hash version is not completed from the
  current inspection. Filling it would make hash drift comparable and falsely `current`. The hash and
  version stay unknown (hash drift unknown) until the next successful build. A null hash has no v1
  hash to reconstruct, so the v1 exception cannot apply.
- The next successful build writes the v2 hash and version 2.
- `mergeImageMetadata` uses the same version-aware comparison when it decides `stale` at
  registration: a legacy v1 row is not marked stale merely because the current inspection computes a
  v2 hash; the v1 hash is recomputed as above or the verdict is unknown.
- Consequence: changing only `HANSE_AGENT_TAG` or setting `HANSE_AGENT_IMAGE_DIGEST` to the same
  underlying image does not change the hash and does not mark an app stale. A genuinely different
  base manifest is caught by the base-digest comparison.

### D4 - Persistence and field threading

One migration (18) adds:

- `apps.build_configured INTEGER NOT NULL DEFAULT 0` - the durable manifest-derived flag used by
  `listApps` and the state service; registration/`upsertApp` writes it from the inspection (error or
  `dockerfile !== null`), and `ImageService.check`, `ImageService.build`, and direct provisioning
  write the same value. Startup registration backfills existing rows; a project provisioned without
  registration writes it in the provisioning transaction. It is never derived from the image-status
  heuristic.
- `apps.image_base_ref TEXT`, `apps.image_base_kind TEXT`
  (`default|base|explicit|unknown`; NULL for legacy/no build), `apps.image_hash_version INTEGER NOT
  NULL DEFAULT 1`.
- `apps.image_build_id TEXT` - the in-flight build identity. `apps.image_build_ref TEXT` - the
  target reference the runner returned for that build. `apps.image_build_started_at TEXT` - the
  bound for lost-build detection. `apps.image_build_rejected_ref TEXT` - a ready record that was
  rejected by the adoption assertion; it is skipped by both adoption branches until a new build
  starts, so the same mismatched record cannot be re-adopted on the next poll.
- `app_image_versions.base_ref TEXT`, `app_image_versions.base_kind TEXT`,
  `app_image_versions.hash_version INTEGER NOT NULL DEFAULT 1`.
- `instances.applied_image_id TEXT` - the image ID of the running container.

`apps.image_stale_reason` is deliberately not added; the reason is derived from the base comparison,
the hash comparison, and `image_error`, and a stored copy would be a second source of truth.

The new fields must be threaded through every read and write or coordinator startup silently resets
them. The implementation updates:

- `RegisteredApp`, `AppBuildInspection`, `ExistingImageRow`, `MergedImageMetadata`,
  `selectExisting`, and `upsertApp` in `src/registry/index.ts`. `AppBuildInspection` gains the
  Dockerfile bytes (or a precomputed v1 hash) and the resolved base kind/ref so the v1 recompute has
  an input path; `ExistingImageRow`/`selectExisting` include `image_error`, `image_base_ref`,
  `image_base_kind`, `image_hash_version`, and `image_build_rejected_ref`; the merge result returns
  them on the preservation branch. `upsertApp` preserves `image_build_id`, `image_build_ref`,
  `image_build_started_at`, and `image_build_rejected_ref` on conflict; registration never clears an
  in-flight build or a rejected record. A new build start, a valid adoption, or a rollback clears
  the rejected marker explicitly.
- `AppRow`, `AppImageVersionRow`, `#findApp`, every app `SELECT`/`UPDATE`, `#view`, `#recordVersion`,
  `#applyRecord`, `rollback`, `#previousVersion`, `#snapshotImageState`, and `#restoreImageState` in
  `src/images/service.ts`.
- A pre-runner build failure (invalid manifest/Dockerfile before the runner request) persists
  `image_status = error` and a bounded `image_error` before throwing. The shared state function also
  treats a live inspection error as `build_error`, so invalidating a Dockerfile after a successful
  build does not wait for a manual check.
- `#recordStatus` and `#recordStatusById` in `src/opencode/manager.ts` for `applied_image_id`, plus
  a narrow applied-ID update on the already-running reconnect branch and in `resumeRunning` that
  preserves `applied_settings_hash`/`applied_profile`; `#authoritativeApp` also selects
  `app_image_versions.image_id` for the selected ref so the restart preflight can compare it without
  guessing. The `ImageService` state function selects `instances.state`/`applied_image_id` for the
  `running`/`appliedImageId` view.
- `CoordinatorService.listApps()` in `src/coordinator/service.ts` selects `apps.build_configured` and
  the new base/hash/build fields. The value is written by registration (`upsertApp`) from the
  manifest inspection, not derived from the `image_status`/`image_ref`/`image_hash` heuristic, and
  `listApps` needs no filesystem access or `projects.root_path`.
- `RuntimeAppStatus.imageId` is optional; `src/agent/supervisor.ts` returns `null` for it, while the
  runner returns the container's image ID.

`mergeImageMetadata` preserves the stored base fields and hash version from the existing row. It
does not overwrite them with the current inspection: the inspection's base kind/reference describes
the next build, not the image that is currently selected. The build path uses the inspection to
resolve the base for a new build; only build adoption and rollback write base metadata. A legacy row
with a non-null `image_ref` and a null hash is not completed from the inspection; its hash/version
stay unknown until the next build. When `image_build_rejected_ref` is set - and for any persisted
build error until a new build start, a valid adoption, or a rollback - registration preserves
`image_status = "error"` and the bounded `image_error` instead of taking the `error -> stale` branch
or nulling the message, so a restart cannot downgrade the mismatch to `stale`/`current`. (Its
`image_status = 'missing'` for no-build apps is retained as a DB value, but state derivation keys on
`buildConfigured`, not on that status - see D5.)

The GC algorithm and its image classification are unchanged: base/default images are outside
`isManagedImage`, and running containers are already protected. The protected-ref set gains
`apps.image_build_ref` while a build is in flight, so the image GC cannot delete the target between
build completion and adoption. The plan must not add base/default images, build cache, or a broader
GC surface.

### D5 - State model and startability

The shared state result uses `image_status` values (`missing`, `building`, `ready`, `stale`,
`error`) as inputs but is not equal to them. `buildConfigured` comes from the manifest inspection.

Definitions:

- `usableImageRef` = `apps.image_ref` when non-null **and** the selected image is confirmed present
  by the app-scoped inspect. If the inspect reports the selected image missing or its label/ID
  contradicts the version, `usableImageRef` is null and the state is `not_ready` (reason
  `image_missing`, action Rebuild & restart) even though `apps.image_ref` is set; a running app keeps
  its chat and gets the warning. If the inspect is unavailable/unknown, keep the ref and state
  `unknown` (no false verdict). A build-configured app with a present reference remains startable
  regardless of `image_status` and a current manifest/Dockerfile configuration error; a configuration
  error affects the next build and the state explanation, not the start of an existing image.
  `resolveAgentImage` therefore returns the ref before rejecting a build-config error and rejects
  only when the app is build-configured and the ref is null.
- `appliedImageId` = `instances.applied_image_id`, considered only when the runtime is `running` or
  `starting`.
- `targetImageId` = the selected version's image ID for a custom app; the current default image ID
  for a default app.
- `baseDrift` = a custom app with a known base kind where both the stored and current manifest
  digests are valid and differ.
- `hashDrift` = a custom app whose stored hash is comparable to the current inspection hash (same
  version, or a legacy v1 recomputation) and differs.
- `blocked` = `buildConfigured && usableImageRef === null && state ∈ {not_ready, building,
  build_error}` - the cold-start predicate. The chat blocked card additionally requires `!running`;
  a running app with `blocked` true keeps the chat and gets the "Image missing; rebuild" warning,
  except that `building`/`build_error` use their own running warnings.

| State | Condition | Cold start | Chat presentation (running unless noted) |
| --- | --- | --- | --- |
| `current` | identities known and equal; no drift | allowed | none |
| `restart_required` | running/starting, both image IDs known and different | already running | warning: Restart (never for a stopped app) |
| `rebuild_required` | usable image, base or hash drift | allowed (stale) | running: warning Rebuild & restart; stopped: app page only |
| `building` | a durable or observed build is active | allowed if usable; blocked otherwise | running: "Rebuilding" warning; stopped+usable: none; stopped+no usable: progress card |
| `build_error` | the last build failed, or the build config is invalid (live inspection error) | allowed if usable; blocked otherwise | running: retry warning; stopped+no usable: error card; stopped+usable: app page only |
| `not_ready` | build-configured, no usable image (never built or selected image missing locally), no active or failed build | blocked | running: warning "Image missing; rebuild" + Rebuild & restart; stopped: error card Build and start (or Rebuild & restart for `image_missing`) |
| `unknown` | a required identity cannot be resolved and no higher state applies, including an unknown comparable hash/base drift | allowed if usable/default | none |

The derivation lives in one image-service function. The HTTP view, the typed error, the application
page, and the chat card consume that result. The image panel on the application page (both the
custom and the default panel) fetches `GET /api/apps/:app/image` on load; the SSR shell uses the
persisted `RegisteredApp` values as a placeholder and `assets/images.js` renders the derived `state`,
not raw `imageStatus`. The default panel gains `data-image-url` (today only the custom panel has it)
so a default app can show `restart_required`/`unknown`; it never shows build states. This gives
stopped build-configured apps the `rebuild_required`/`build_error` presentation D5 requires. The manager's start check uses the same
`buildConfigured && image_ref === null` rule and the runner's create result; it does not re-implement
base or hash drift.

Derivation order (first match wins):

1. If not `buildConfigured`: the app is a default-image app. If running, compare applied and target
   image IDs; differing known IDs are `restart_required`, otherwise `current`; an unknown ID is
   `unknown`. A stopped app is never `restart_required`; it is `current` when the target is known and
   `unknown` otherwise.
2. If build-configured and a build is active: `building`.
3. If build-configured and (`image_status = error` or the live inspection `status === "error"`):
   `build_error`.
4. If build-configured and `usableImageRef === null`: `not_ready`.
5. If `baseDrift === true || hashDrift === true`: `rebuild_required`.
6. If running/starting and applied/target are both known and differ: `restart_required`.
7. For a build-configured app, if a comparable hash or base identity is unknown (digest-only v1,
   unknown base kind/digest, or an unreconstructable hash), and no higher state applies: `unknown`.
8. If any other identity needed for the verdict is unknown: `unknown`.
9. Otherwise: `current`.

Presentation precedence is separate from derivation but uses the same state:

- Blocked card: `building` > `build_error` > `not_ready`.
- Running warning: `building` > `build_error` > `not_ready` (a running app with no durable usable
  reference) > `rebuild_required` > `restart_required` > none.
- `restart_required` requires `running|starting`; a stopped app with an old applied ID is never
  restart-required, so the UI cannot offer a no-op Restart.
- A default-image app is never `not_ready`, `building`, `build_error`, or `rebuild_required` from
  image-status values; only an unresolvable identity is `unknown`. A default image that cannot be
  pulled or started is a distinct runtime error/card (D11), not a build state.
- `build_error` with a usable image is startable and shows a warning only while running; a stopped
  app shows the failure on the application page.
- `image_status = stale` is not itself a verdict. When the comparable hash/base check is unknown
  (for example a legacy row with an unreconstructable v1 reference), the derived state is `unknown`,
  never `current`, until the identity is resolvable; both pages and the card use `state`, not
  `image_status`.

Transitions: `not_ready -> building` (action) `-> build_error` (failure) or `-> current |
rebuild_required | restart_required` (ready); `build_error -> building` (retry); `rebuild_required ->
building -> restart_required -> current` (rebuild then restart); `restart_required -> current` after
a restart launched the target image; `building -> build_error` on a lost build (D9). An `unknown`
state re-resolves on the next refresh.

### D6 - Default-image applications and launch identity

A default application has no build. Its applied image ID is recorded at launch from the container's
top-level `Image`; its target is the current default image's `Id`, resolved by the runner.

- A difference marks a running agent `restart_required`; the action is Restart, never Rebuild.
- A stopped app is never `restart_required`; its next launch uses the current target.
- Launch identity is guaranteed by the runner, not by a spec-hash change: when an existing container
  is not running and the spec hash matches, the runner inspects the target reference and compares
  its `Id` with the existing container's `Image`. If they differ, it stops, removes, and recreates
  the container; if the target cannot be inspected, it fails with a bounded image-unavailable error
  and does not start the old container. A running container is reused (stale remains advisory).
  Including the image ID in `computeSpecHash` is rejected because it would require the coordinator to
  resolve Docker identity before hashing, while the runner already inspects at launch.
- The applied-versus-target comparison uses image IDs on both sides. A container never reports a
  manifest digest.
- The coordinator's `resolveAgentImage` must use `defaultImageReference()` for a default app, not the
  raw `HANSE_AGENT_IMAGE` value, so a `HANSE_AGENT_IMAGE_DIGEST` pin reaches the runner. The applied
  and target comparisons use that same digest-bearing reference.
- The runner's launch allowlist must accept `spec.image === config.defaultImage` (the digest-bearing
  default reference from `defaultImageReference()`), not only `allowedImages` entries. Otherwise a
  deployment that pins `HANSE_AGENT_IMAGE_DIGEST` would fail every default-app launch. The build path
  already accepts this reference (`validateBuildRequest`); launch must match that rule.

### D7 - Custom applications, target identity, and rollback

At build completion the coordinator records the built image ref, the built image ID, the resolved
base ref/kind/digest, the spec hash, and the hash version. A running application is:

- `rebuild_required` if the current manifest digest of the matching base differs from the stored
  base digest, or the comparable build-spec hash says the Dockerfile/args changed;
- `restart_required` if the image is current but `instances.applied_image_id` differs from the
  selected version's image ID (for example after a build without a restart);
- `building` / `build_error` / `not_ready` per D5; a usable prior image remains startable.

The target image ID is always read from `app_image_versions.image_id WHERE image_ref =
apps.image_ref`. It is never taken from the runner's latest record, because rollback can select an
older ref while the runner's latest record still points at the newer build.

The version's base ref/kind/digest and spec hash come from the build record that produced it, never
from `#defaultImage` and never from a fallback to the current default reference. An unknown base is
stored as `null`/`unknown`, not as the default.

Rollback:

- `app_image_versions.base_ref` and `base_kind` travel with the version, so a rollback compares
  against the base that version was actually built on.
- The selected version's `image_id` becomes the target. If the selected version's comparable spec
  hash and base digest match the current inspection, a running container on the newer image reports
  `restart_required` and a container already on the older image reports `current`. If either differs,
  D5 step 5 applies first and the state is `rebuild_required`, not `restart_required`/`current`.
- A legacy version without `image_id` yields `targetImageId = null` (`unknown`): no false restart
  warning. A version with an incomparable legacy hash is recorded `ready` and its hash drift is
  unknown until rebuilt; base drift still applies when the base is known.
- Rollback restores `image_base_ref`, `image_base_kind`, `image_base_digest`, and
  `image_hash_version` together with the existing fields; the manager snapshot/restore includes them
  so a failed restart leaves no half-restored row.

The explicit **Rebuild & restart** action restarts a running agent immediately after the build. A
plain `POST /api/apps/:app/build` never restarts; a running app whose image changed stays
`restart_required` until an explicit restart. A stopped application is not started by the rebuild.

### D8 - Reconcile, refresh, and latency

- The coordinator never talks to Docker. It resolves identities through the authenticated runner
  inspect endpoint (D11).
- At coordinator startup, after `registerProject`, the coordinator resolves the default reference,
  the configured base reference, and every recorded explicit `base_ref` once and caches
  `{imageId, manifestDigest}` per reference. The cache is keyed by the reference string. It is
  populated after the deployment's image pull; a reference that was not pulled is `unknown` and is
  retried on the next refresh, never treated as current. An explicit `@sha256` pin resolves to
  itself and never drifts; an explicit moving tag is resolved and cached like any other reference.
- Cache invalidation: after build, rollback, start, and restart; on the explicit "Check for changes";
  on a 60 s TTL for each cached reference (default, base, and explicit); and on a forced refresh from
  the chat's focus/visibility handler (D11). There is no per-request Docker inspection.
- A startup/refresh failure (runner unavailable, image absent, no `RepoDigests`) yields `unknown`.
- Applying a new build is event-driven: the durable build identity (D9) is polled through the runner,
  not by scanning Docker.
- The reconcile computes the state and persists only durable inputs: applied image ID and build
  fields. It reads base identity for comparison but never persists base metadata; only build
  adoption and rollback write `image_base_ref`/`image_base_kind`/`image_base_digest`. It never starts
  agents and never mutates `pendingRestart`.
- Applied image ID latency: `#recordStatus` writes it on a destructive `ensure` (create/start).
  The already-running reconnect branch and `resumeRunning` do **not** call the full `#recordStatus`
  (that would null `applied_settings_hash`/`applied_profile` and break `pendingRestart`); they issue
  a narrow `UPDATE instances SET applied_image_id = ?` from the already-fetched `status.imageId`,
  preserving the settings fields. The 15 s status reconciler (`#recordStatusById`) is the fallback
  for out-of-band changes **of rows that are not stopped**: it queries only rows whose
  `COALESCE(runtime_state, state) <> 'stopped'`. A stopped→running out-of-band start is discovered
  on the next `ensure`/start or by a bounded `GET /image` probe for a stopped row. The probe owner
  is `InstanceManager.probeStatus(appId)` (or an injected runtime-status function on
  `ImageServiceOptions`); the image route calls it once only when the persisted row is stopped, and
  it persists `instances.state`/`applied_image_id` from the returned status. The reconciler alone is
  not a stopped-row detector. When a stop status has no container image, the previous applied ID is
  preserved, not nulled: it is ignored while stopped and overwritten on the next start. The chat and
  image view may therefore lag a running-row out-of-band change by at most one reconciler interval;
  explicit start/restart writes are immediate. A null applied ID is `unknown`, never
  `restart_required`. The `ImageService` state function reads `instances.state` and
  `instances.applied_image_id` for `running`/`appliedImageId`.
- `GET /api/apps/:app/runtime` stays unchanged; the chat owns a separate image refresh cadence
  (D12). The dedicated image endpoint remains authoritative.

### D9 - Durable build identity, adoption, and lost builds

The in-memory `#active` map is an optimization, not the source of truth.

- When a build starts, the runner returns `buildId` and `targetRef` (the deterministic app/build tag).
  The coordinator persists `apps.image_build_id`, `apps.image_build_ref`, and
  `apps.image_build_started_at`, and sets `image_status = building`. These fields survive a
  coordinator restart.
- The runner's build record carries `specHash` and `specHashVersion` (2) and the base kind/ref from
  the validated request, the base digest resolved by the runner at build start (or null when
  unresolvable), and `imageRef`/`imageId` when ready. `ImageBuildInput` and `RunnerImageRecord` gain
  `hashVersion`; it is available by build ID as well as by app.
- Adoption rule: a ready runner record is adopted when its `buildId` equals the durable
  `apps.image_build_id`, or (legacy rows only) when the record's ref equals `apps.image_ref` or
  `apps.image_ref` is null. A record whose ref equals `apps.image_build_rejected_ref` is never
  adopted by either branch. The runner's "latest record" is never adopted by itself.
- Adoption has exactly three cases:
  1. **Durable build ID matches** (`apps.image_build_id` non-null and equals `record.buildId`): if
     `record.imageRef === apps.image_build_ref`, adopt; if it differs, do not adopt, clear
     `image_build_id`/`image_build_ref`/`image_build_started_at`, set
     `image_build_rejected_ref` to the record's ref, set `image_status = error`, and mark
     `build_error` with a bounded "build target mismatch" message. Keep the old image and the old
     image's GC protection (running container or `apps.image_ref`), but not the mismatched target.
  2. **Legacy branch** (`image_build_id` is null): if `apps.image_ref` is non-null and
     `record.imageRef === apps.image_ref`, adopt; if `apps.image_ref` is null, adopt. Any other
     legacy record is not adopted.
  3. **Everything else** (build ID does not match, ref equals `image_build_rejected_ref`, or a
     non-matching legacy record): silently skip. Clear only the in-memory build state and return;
     do not write `image_status`/`image_error`, do not set a rejected marker, do not call
     `#recordVersion`, and do not add the ref to the GC keep set.
- A new build start clears the rejected marker; a valid adoption or rollback also clears it.
- A terminal runner build error clears `image_build_id`, `image_build_ref`, and
  `image_build_started_at` while preserving the old image. This is distinct from the lost-build
  transition and prevents a failed target from staying GC-protected forever.
- While a build is non-terminal, the runner also protects its own build tag in memory (D15), covering
  the interval before the coordinator persists `image_build_ref`.
- On adoption, write the app's and the version's base ref/kind/digest and hash version from the build
  record (never from the current inspection or `#defaultImage`), then clear the build fields and
  derive the state. This covers a coordinator restart between build completion and the first poll:
  startup reads the durable build ID and calls the runner's build lookup.
- The silent-skip case above keeps the persisted `build_error`/rejected marker, so a subsequent poll
  cannot silently turn the rejected record into a current image.
- If the app is running and the rebuild was initiated by "Rebuild & restart", the restart step
  re-reads the adopted ref and asserts it again before stopping the old container.
- If the coordinator itself restarts mid-build, the runner normally still has the record: the
  durable ID re-attaches (`building`), then adopts on completion.
- The `serveCommand` sequence is explicit: construct `ImageService` before `InstanceManager` (or
  inject a standalone adopter), register projects, warm the default/base/explicit identity cache,
  run the `ImageService` adoption pass, then create the HTTP server. The adoption pass iterates every
  app with a non-null `image_build_id` with bounded per-app failures, so one bad build does not abort
  startup. It calls the runner's build lookup, re-attaches
  a `building` record, adopts a `ready` record (or marks the rejected ref), applies the lost-build
  rule for a missing record, and clears terminal build fields. This runs without any page/chat poll,
  so a build that completed while the coordinator was down is not left `building` until someone opens
  the app. A new build cannot start for an app with a durable in-flight ID until this pass resolves
  it.
- If the runner restarted (record gone) while `image_status = building`, transition to `build_error`
  regardless of whether `image_ref` is set. The transition is bounded: when the runner is reachable
  and the recorded build ID has no record, wait a 60 s grace from `image_build_started_at`; when the
  runner is unreachable, wait the runner's 30 min build timeout from that timestamp. A row without a
  usable timestamp transitions on the first resolved status. Clear the build fields, keep the old
  image, and show the retry. This fixes the current behavior where a prior image leaves `building`
  stuck forever.

### D10 - Startability preflight and orchestration

Restart must not destroy a usable container when the target image is not ready.

- Before `#stopLocked`, resolve the build configuration, the target reference, and the target
  identity. A current build-configuration error does not block a restart when a usable reference
  exists; it is reported as `build_error` on the page. For a default app, inspect the default
  reference. For a custom app, inspect the selected `apps.image_ref` through the app-scoped runner
  inspect (D11): the image must exist locally and must carry the app's `hanse.app.id` label, and the
  returned image ID must match the selected version's `image_id` when that version has one. A legacy
  ref without a version image ID is still startable, with an `unknown` restart verdict. For a
  rebuild-restart, additionally verify that the adopted ref and image ID match the build that just
  completed. If the image is missing, the app-scoped inspect cannot confirm it, or the version
  identity contradicts the adopted build, reject the restart and leave the container untouched: a
  build-configured app returns the typed `image_not_ready` failure, and a default app returns the
  bounded `default_image_unavailable` failure.
- The manager receives an image inspector, a build adopter, and the shared state derivation through
  `InstanceManagerOptions` (`inspectImage(ref, appId)`, `resolveBuild(appId)`/`adoptBuild(buildId,
  appId)`, `imageState(appId)`), wired from the CLI to the runner-backed image client and the same
  `ImageService` constructed before the manager. Both typed errors take their `state` from
  `imageState(appId)`, so the error and `GET /image` cannot disagree. `ensure`/restart call the
  adopter before resolving the
  target; the master tools use the same manager and inherit the dependency. This is what makes the
  custom preflight and the D9 "not yet adopted" rejection possible without the coordinator talking to
  Docker. The CLI constructs the `ImageService` (and its runner-backed inspector/adopter) before
  `InstanceManager`, or injects a standalone adopter; there is no circular dependency because
  `ImageService` does not depend on the manager. The settings restart route awaits an async
  `manager.preflightRestart(app)` before `beginRestart`/`202`; the start route calls `ensure`, which
  performs the same preflight. Master tools use the same manager path. The design does not use a
  route-local `ImageService.status` call, so every entry path shares the injected adopter.
- Both start and restart resolve a durable `image_build_id` through the D9 adoption lookup before
  resolving the target. A restart whose build is still `building` or not yet adopted is rejected
  with `image_not_ready` and leaves the running container in place; this closes the race between the
  client's final poll and the restart, so a rebuild-restart cannot launch the pre-build image.
- The restart route performs the D10 preflight synchronously, before the manager claim and before
  the `?async=1` `202`; `#restartLocked` re-checks the adopted ref, but the user-visible
  `image_not_ready`/`default_image_unavailable` decision is returned before any 202 or destructive
  work. A stopped app is reported as `restarted:false` by the synchronous check without a claim.
- Rollback (`manager.rollbackImage` -> `#restartLocked`) re-reads the selected row after
  `rollback()` (the pre-rollback `authoritative` snapshot must not be passed to `#restartLocked`)
  and runs the same preflight against that post-rollback version before `#stopLocked`. If the
  selected image is missing or contradicts its version, the running container is untouched, the
  pre-rollback DB row is restored, and the typed `image_not_ready`/`default_image_unavailable` error
  is rethrown through `rollbackImage` (not wrapped in `ImageRollbackIncompleteError`) and mapped in
  `src/http/images.ts` before the rollback-incomplete handler. Because the row is restored before the
  throw, recompute `imageState(appId)` and patch the error's `state`/`imageStatus` from the restored
  row before rethrowing, so the error and `GET /image` agree.
- Only after a successful preflight does `#stopLocked` run, followed by `#ensureLocked`.
- If the preflight passes but `#ensureLocked` fails for a non-image reason, the old container is
  already gone; report a bounded start failure with a retry. The design does not claim otherwise.
- A stopped app: restart returns `restarted:false` and never starts it; the browser falls back to the
  start route.
- A build failure never stops or restarts anything; the old container and chat stay usable.

Client orchestration (the page is the requested place to wait):

```text
not_ready --Build and start--> building --ready--> start --> running --> reconnect/boot --> chat
                                   \--failure--> build_error --retry--> building
running + rebuild_required --Rebuild & restart--> building --ready--> assert ref --> restart --> running
```

- **Build and start**: `POST /api/apps/:app/build`; a `409 build_in_progress` re-fetches
  `GET /api/apps/:app/image` and attaches only when this app has `image_build_id`/state `building`;
  if another app is building, show a bounded "another image build is running; retry" state and do
  not poll as `building`. Poll `GET /image` (2 s interval, bounded by the runner's 30 min build
  timeout); on ready call `POST /start`; on success reconnect and boot.
- **Rebuild & restart**: same build/poll; on ready call `POST /api/apps/:app/restart`; the server
  preflights and asserts; on success reconnect; on `image_not_ready` refresh the state and keep the
  old container.
- A page reload during `building` resumes from the image status and durable build ID. When ready and
  the app is stopped, the card offers **Start** unless the same tab recorded the build-and-start
  intent in session storage.
- Client-side orchestration is chosen over a long-running server operation; builds already stream
  status and the page is the place to wait. A later combined endpoint can move the state server-side
  without changing the UI contract.

### D11 - API and error contracts

Coordinator routes:

- `GET /api/apps/:app/image` returns the existing view plus `buildConfigured`, `state`, `running`,
  `usableImageRef`, `targetImageId`, `appliedImageId`, `hashVersion`, `currentBaseDigest`,
  `baseKind`, `baseRef`, `baseDigest`, `imageBuildId` (durable `apps.image_build_id`), and `buildId`
  (runner's latest record, diagnostic). The legacy `imageId` is renamed `latestBuildImageId` as a
  diagnostic; neither `buildId` nor `latestBuildImageId` is used for state. The 409-attach predicate
  is exactly `imageBuildId !== null && state === "building"`. `previousImageRef` and
  `previousImageBuiltAt` stay. `?refresh=1` forces a re-resolution of the default/base identities
  instead of using the 60 s cache; the explicit check and the chat focus refresh use it.
- `POST /api/apps/:app/build` is unchanged semantically; its response adds `targetRef`. The
  coordinator persists it with `buildId`.
- `POST /api/apps/:app/start` is new: human-only (`principal.kind === "human"`), passes the same
  cross-site mutation check as the chat mutations, is project-scoped, calls `manager.ensure`, and
  returns the runtime state. It never restarts a running agent.
- `POST /api/apps/:app/restart` keeps its semantics (no-op for stopped) and gains the same
  cross-site mutation check as hardening. It runs the D10 preflight synchronously before the claim
  and before returning `202` on the `?async=1` path; a preflight failure returns the typed error
  before any 202, and a stopped app returns `restarted:false` without a claim.
- The start route is registered in the `src/http/server.ts` dispatch as well as in the chat handler's
  route matcher; the current `/api/apps/` catch-all is not sufficient as a stated contract.
- `GET /api/apps/:app/runtime` is unchanged.
- All routes keep principal checks, project scoping, and bounded error bodies.

One typed image failure is used everywhere:

`ImageNotReadyError`: HTTP 409, code `image_not_ready`, with `appId`, `imageStatus`, `buildConfigured`,
and the derived `state`, plus a bounded human message. It is returned by the start route and mapped
at every `ensure` call site: `src/http/chat.ts` (boot, message send, runtime ensure,
`streamSessionEvents`, attachment upload), `src/http/prompts.ts` (prompt submit, app-events SSE - as
a 409 JSON body that the client gate prevents from being needed), `src/http/commands.ts`,
`src/http/context.ts`, `src/master/tools.ts` (`start_app`/`restart_app`, as a bounded tool error),
`src/coordinator/dispatcher.ts` (handoff dispatch/reply/relaunch ensure -> a bounded handoff
failure, not the chat card), and `src/http/handoff.ts` (`relaunchReply` -> a bounded operator error).
The raw 502 launch message is never shown when this applies.

A default image that is absent locally is a separate typed failure:
`DefaultImageUnavailableError` - HTTP 503, code `default_image_unavailable`, with `appId`, derived
`state`, and a bounded message (no build action). It is not `image_not_ready` because no build is
configured. It is mapped at the same `ensure` sites and the start/restart routes; the chat renders
the no-build card (D12), not the build-and-start card.

Runner route:

- `GET /v1/images/inspect?ref=<reference>[&appId=<appId>]` behind the runtime token. The ref is
  length-bounded, rejects whitespace/NUL/control characters, and must be in `allowedImages ∪
  {defaultImage, baseImage}`. A built `hanse-app-*` ref is additionally accepted only when `appId` is
  present and the image carries a matching `hanse.app.id` label (reusing the `#isBuiltAppImage`
  check); this is what the custom restart preflight uses. A disallowed ref is 403; a malformed ref is
  400. A missing local image is a 200 `{found:false, imageId:null, repoDigests:[],
  resolvedDigest:null}`; otherwise it returns `{found:true, imageId, repoDigests, resolvedDigest}`.
  The body is bounded (8 KiB, at most 16 digest entries). `resolvedDigest` follows the D1 order.
  There is no arbitrary Docker API passthrough and no environment or path data.
- Extend the typed runner results: `DockerImageInspect` gains `RepoDigests`; `DockerContainerInspect`
  gains top-level `Image`; `statusFromInspect` gains `imageId`, and `RuntimeAppStatus` gains optional
  `imageId`. The supervisor's status returns `imageId: null`; `stoppedStatus` returns `imageId: null`.
  `DockerImageUsage` already has `RepoDigests` and is not the source.

### D12 - Chat presentation, boot gate, and SSE reconnect

The chat is bootstrapped in a fixed order on every page load and after every action:

1. Fetch `GET /api/apps/:app/image` (or read an SSR-embedded snapshot) before `bootSessions`,
   `subscribe`, and `hydrate`.
2. If the result is blocked (`not_ready`/`building`/`build_error` with `buildConfigured && !
   usableImageRef && !running`), render the blocked card and skip all three calls. `unknown` is
   non-blocking.
3. If the fetch itself fails, boot optimistically; a later `409 image_not_ready` from any call
   re-enters the blocked card and suppresses the raw error.

Blocked card (app-level, not per-session): the thread area shows the card, the composer is hidden or
disabled, and `showSessionsError`/`showThreadError` are not used for an image failure.
- `not_ready`: "Image not built" + **Build and start**.
- `building`: "Building image..." with progress, no duplicate action.
- `build_error`: "Image build failed: <bounded error>" + **Retry build and start**.

Running warning (app-level banner above the thread; chat usable):
- `building`: "Rebuilding image... chat stays available"; no duplicate action.
- `build_error`: "Rebuild failed" + **Retry rebuild & restart**; the old container is intact.
- `not_ready` while running (no durable usable reference): "Image missing; rebuild" + **Rebuild &
  restart**.
- `rebuild_required`: "Base image updated - rebuild required" (or "Image out of date" for a
  Dockerfile/args change) + **Rebuild & restart**.
- `restart_required`: "Agent image updated" + **Restart**.

Precedence is D5's. A stopped app never shows the warning for `restart_required`; it shows its image
state on the application page and, if it has a usable image, opens the chat on that image (stale
start is allowed). A default-image app that cannot start on the default image shows the separate
"Default agent image unavailable; pull it and restart the coordinator" card with no build action.

After a successful start or restart: clear the SSE failure counter, call `reconnectStream()`
(explicitly resetting `failures = 0` and the paused notice before re-subscribing), boot sessions if
not yet booted, hydrate, select the last session, reveal the composer, and refresh the image state.
A deliberate stop+ensure restart exceeds the three-failure pause threshold, so the explicit reconnect
is mandatory; the default "drop and reconnect" behavior does not cover it.

While running, refresh the image view immediately when the runtime poll observes stopped -> running,
then every 60 s and on `visibilitychange` to visible. This is what surfaces a deploy-induced
`restart_required` on a long-lived page; without it, the warning would require a reload.

Two tabs are supported: the durable build ID makes both observe `building`; one start/restart wins
and the other's `ensure` attaches to the running container. No client owns the build.

### D13 - Security

- Image build and the new browser start action are human-only. The browser restart route is
  human-principal behavior; both start and restart add the cross-site mutation check.
- The master agent's existing allowlisted `start_app` and `restart_app` tools remain and are the only
  agent-initiated path; they gain no image build/inspect action and map `image_not_ready` to a
  bounded tool error. The master MCP surface does not expand.
- The browser cannot supply a base reference, image tag, or build arg; the build resolves the base
  from the manifest and the configured environment.
- The runner inspect route is token-authenticated, allowlisted, ref-validated, and size-bounded; it
  reveals only an image ID and digests for already-approved references.
- Error bodies use the existing bounded image errors; no paths, credentials, environment values, or
  host specifics leak. The image card is rendered by the authenticated operator page and is not
  cross-origin embeddable.
- The existing build validation (no-network, read-only validation container, required
  CLI/opencode/git) is unchanged.

### D14 - Legacy rows and backfill

Existing custom images may have `image_base_digest` containing the default reference. The
coordinator does not infer the base from the current Dockerfile: the current file may differ from the
built file, and a legacy value is a reference, not proof of the actual `FROM`.

- Legacy rows without `image_base_kind` are `unknown` (no base verdict) until the next successful
  build.
- Any `image_base_digest` that does not match `sha256:<64>` is not a digest and yields no base
  verdict.
- A version-1 hash may be recomputed as in D3 only when the legacy reference can be reconstructed
  exactly; otherwise hash drift is unknown and the derived state is `unknown`, not `current`.
- A row with a non-null `image_ref` and a null stored hash is not filled from the current inspection;
  hash drift stays unknown until the next successful build (no false `current`). There is no v1 hash
  to reconstruct in this case.
- Existing `apps.image_ref` and `app_image_versions` are not rewritten. The next successful build
  fills base ref/kind/digest and writes hash version 2.
- A rolled-back version with a null `image_id` has no target image ID and is `unknown`, never
  falsely `restart_required`. A legacy-hash version with a known `image_id` uses the normal target
  comparison: `restart_required` when the running container is on another image, otherwise `unknown`
  (D5 step 7), never a false `current`.

### D15 - GC algorithm unchanged; in-flight build protected

The GC algorithm, its `isManagedImage` classification, and its candidate selection are out of scope
and unchanged. Base/default images are outside `isManagedImage`, so the app-image GC never collects
them, and running containers are already protected. The protected-ref set gains two sources:
`apps.image_build_ref` (while `image_build_id` is set) from the coordinator, and the runner's own
in-memory non-terminal build tags. The second closes the window between the runner creating the
target tag and the coordinator persisting `image_build_ref`; it is a read-only addition to the
protected set, not a candidate-selection change. `ImageBuildService` exposes
`protectedBuildTags()`; the runner's GC route passes a provider into `ImageGcService` (or persists
`targetRef` on `RunnerImageRecord`), and `src/runner/server.ts` wires the two services together. Do
not add base/default images, build cache, or any other image class to the GC surface.

## 5. Alternatives considered

- **Coordinator revision trigger**: rejected. It would restart agents for coordinator-only changes
  that do not affect the agent image, and a mutable tag could hide a real change.
- **Tag-string comparison**: rejected. Tags are mutable; `latest` and re-pushed tags break it.
- **One identity value for both questions**: rejected. A container reports an image ID and never a
  manifest digest; comparing them produces false verdicts. D1 keeps the domains separate.
- **Build-spec hash including the base reference**: rejected. It marks an app stale on a harmless tag
  move and violates V5. Hash v2 includes only the base kind; the digest is compared separately.
- **`build.base` with a schema default**: rejected. It makes "unset" and "explicit default"
  indistinguishable and disables the Dockerfile fallback.
- **Blocking stale starts**: rejected by the owner; stale remains startable and advisory.
- **Trusting the runner's latest record for the target image**: rejected. Rollback selects an older
  ref while the runner's latest record still points at the newer build.
- **Recreating a running container on `ensure` when the tag moved**: rejected. Stale is advisory
  while running; recreation happens on the next launch (a stopped container is compared and
  recreated if needed).
- **A server-side long-running build-and-start operation**: deferred. The client orchestrates the
  existing async build/status/start steps; the UI contract can survive a later move.
- **Reusing `pendingRestart` for images**: rejected. `pendingRestart` is a launch-settings hash; image
  drift has different states, actions, and a rebuild phase.

## 6. Impact

- Runner: `src/runner/docker.ts` (typed `RepoDigests`, container `Image`), `src/runner/server.ts`
  (status image ID, launch identity comparison, inspect route including app-scoped built refs, GC
  route wiring), `src/runner/images.ts` (base kind/ref/digest, spec hash/version, `targetRef` in the
  start result, `protectedBuildTags()`, base allowlist), `src/runner/image-gc.ts` (protected-build-tag
  provider; candidate selection unchanged), `src/runner/validate.ts` (`HANSE_AGENT_BASE_IMAGE` in
  config and `allowedImages`, and `spec.image === config.defaultImage` accepted for a digest-pinned
  default launch).
- Coordinator image path: `src/images/service.ts` (base resolution and threading, hash v2/legacy,
  durable build fields, target image ID, lost-build rule, rollback/snapshot fields, state view, build
  adoption lookup), `src/images/client.ts` (build input/result and record fields, inspect and
  build-lookup client).
- Registry and hash: `src/registry/index.ts` (base inspection/merge, new fields, v1 comparison),
  `src/coordinator/service.ts` (`listApps` field mapping and `buildConfigured`),
  `src/coordinator/provision.ts` (persist `build_configured` on direct provisioning),
  `src/runtime/build-spec.ts` (hash version 2, base reference helper).
- Runtime: `src/agent/protocol.ts` (optional `imageId`), `src/agent/supervisor.ts` (returns
  `imageId: null`), `src/opencode/manager.ts` (usable-image rule, default resolver, restart
  preflight, `probeStatus(appId)`, image inspector option, applied ID writes in both status paths,
  selected-version `image_id` read, image snapshot/restore fields).
- HTTP: `src/http/chat.ts` (start route, origin checks, shared cross-site helper,
  `ImageNotReadyError` mapping), `src/http/prompts.ts`, `src/http/commands.ts`,
  `src/http/context.ts` (error mapping), `src/http/images.ts` (view fields, rollback typed-error
  mapping, stopped-row probe call order: stopped -> `probeStatus` -> persist -> `images.status`),
  `src/http/handoff.ts` (`relaunchReply` typed mapping),
  `src/http/settings.ts` (restart origin check, synchronous preflight/stopped/202 behavior),
  `src/http/server.ts` (start dispatch), `src/http/application.ts` (custom and default panel
  `data-image-url`, base/identity display; no `renderApplication` signature change).
- Master: `src/master/tools.ts` (map `image_not_ready`; no new actions).
- Handoffs: `src/coordinator/dispatcher.ts` (map `image_not_ready`/`default_image_unavailable` to a
  bounded handoff failure; no new agent-facing image action).
- Wiring: `src/cli/commands.ts` (both `ImageService` constructors pass the base reference; the
  `serveCommand` constructs `ImageService` before `InstanceManager`, warms the identity cache, runs
  the adoption pass before `createHttpServer`, and wires the runner-backed inspector, build adopter,
  and `imageState` into `InstanceManagerOptions`).
- Schema and storage: `src/schema/app.ts` (optional `build.base`), `src/store/migrations.ts`
  (migration 18).
- UI: `assets/chat.js` (bootstrap gate, cards/warnings and precedence, reconnect/reset, image
  refresh), `assets/images.js` (initial `GET /image` state fetch and render, base kind/identity
  display, rollback state).
- Deployment/repo config: `compose.yaml` (coordinator and runner `HANSE_AGENT_BASE_IMAGE`),
  `.env.example`.
- Docs: `docs/current-state.md`, `docs/conventions.md` (`.hanse/app.yaml` schema and identity
  domains), `docs/deployment.md` (base image variable and pull-before-recreate), and this design.
- GC algorithm/candidate selection is deliberately unchanged; the protected-ref set adds
  `apps.image_build_ref` (D15).

## 7. Non-goals

- Automatic rebuilds or restarts; all actions remain explicit.
- Blocking stale images.
- Coordinator revision tracking.
- Cross-application bulk actions.
- Registry-side digest resolution over the network; the runner inspects local/pulled images.
- Exotic Dockerfile semantics beyond the final-stage `FROM`/alias/ARG resolution; ambiguous cases are
  `unknown`.
- Changing image build validation or GC.
- A new agent-accessible image action.

## 8. Owner questions (resolved)

1. **Stale start**: allowed; the image state is advisory.
2. **Default image**: restart only; the default launch is always the current image.
3. **Running outdated agents**: chat warning with an action; rebuild then immediately restart.
4. **Custom base**: track the actual base (`agent-base` or `agent-default`) separately and compare the
   digest of that base.
5. **Hanse update without base image changes**: do not mark agents outdated; compare images, not the
   coordinator revision.
6. **Custom image not ready**: chat error card with **Build and start**, wait on the same page, then
   connect the chat.
7. **Base selection mechanism**: delegated; use the optional explicit `build.base` field and the
   Dockerfile final-`FROM` fallback, with a configuration error on a contradictory declaration.
8. **Base image variable**: repository code, not only deployment; the deployment supplies its value.

## 9. Risks

| Risk | Mitigation |
| --- | --- |
| Mutable tags or local-only images defeat digest comparison | Resolve via the runner; `unknown` when unresolvable or `RepoDigests` is absent; never compare tags; never treat unknown as current. |
| Comparing an image ID with a manifest digest | D1 fixes the two domains; tests assert the separation; `Config.Image` is never used as identity. |
| A tag move marks an app stale | Hash v2 excludes the base reference; only a changed base manifest digest triggers rebuild. |
| A default tag move starts the old image | The runner compares the stopped container's image ID with the inspected target and recreates; a running container is left alone until launch. |
| A build takes minutes and the operator leaves the page | Build continues in the runner; the durable build ID resumes the wait on return; the action is restarted from the card. |
| Coordinator restart between build completion and first poll | Durable `image_build_id`/`image_build_ref`; startup adoption by build ID; assert the ref before restart. |
| Runner restart loses an in-flight build with a prior image | Bounded `building -> build_error` regardless of `image_ref`; prior image stays startable; retry. |
| A failed rebuild-restart kills the running container | Preflight before `#stopLocked`; image-caused failures leave the container intact. A non-image ensure failure is reported honestly as a start failure. |
| Rollback shows a false restart warning | Target ID comes from the selected version, with `base_kind`/`base_ref` on the version. |
| Legacy base metadata is guessed | No inference from the current Dockerfile; `unknown` until the next successful build; non-digest values are not digests. |
| Base parsing misidentifies a multi-stage/ARG base | Optional `build.base`; parse only the final stage with alias/ARG resolution; `unknown` on ambiguity; reject a contradictory declaration. |
| `HANSE_AGENT_BASE_IMAGE` is not configured or allowlisted | Repo code adds it to the runner config/allowlist and both Compose services; `build.base=base` without it is a clear config error. |
| A raw 502 still reaches the chat | One typed error mapped at every `ensure` site; client bootstrap gate; raw image failures suppressed. |
| The SSE pauses instead of reconnecting after a restart | Explicit `reconnectStream()` with `failures = 0` after every successful start/restart. |
| A long-lived page never notices a deploy | Image refresh every 60 s while running, on visibility/focus, and after stopped -> running. |
| Image inspection is expensive | Cache by reference with a 60 s TTL and event invalidation; no per-request Docker inspection. |
| The default image tag is not pulled | The deployment pulls before recreation; the cache is populated after the pull; an absent image is `unknown` (no false warning) and the launch fails closed. |
| The card hides a genuine runtime failure | Only block on image-not-ready when not running; running agents keep the chat and get a warning. |
| Existing chat tests assume the composer always renders | Add explicit blocked/unknown fixtures; keep the ready path unchanged. |

## 10. Verification

- Gates: `npm run lint`, `npm run typecheck`, `npm test`, `npm run build`, `npm run check:sensitive`.
- Identity domains: applied image ID vs manifest digest are never compared; a container `Config.Image`
  is not used as an identity; an `unknown` applied/target ID never yields `restart_required`.
- Base resolution: `build.base` absent/present; `${HANSE_BASE}`; literal final `FROM`; multi-stage
  aliases, including a final stage that aliases a `${HANSE_BASE}` root => `default` and a literal
  root => `explicit`; ARG precedence (manifest over Dockerfile); unresolved variable; `--platform`;
  a contradictory `build.base` is rejected at the resolved root; `base` without
  `HANSE_AGENT_BASE_IMAGE` is a config error; a base outside `allowedImages` is rejected by the
  runner.
- Hash: same digest with a changed tag or `HANSE_AGENT_IMAGE_DIGEST` => **no** outdated; a real
  Dockerfile/args change => stale for v2 and full-reference v1 rows; a digest-only v1 row is
  `unknown` (never `stale`); a v2 write follows the next successful build; a v1/v2 mismatch is not
  compared; a legacy row with `image_ref` and a null hash is not filled from the inspection and stays
  `unknown` (not `current`); `AppBuildInspection` carries the Dockerfile bytes (or a precomputed v1
  hash) needed for the full-reference v1 recompute.
- Base drift: default vs base vs explicit; an explicit digest pin never drifts; a moving tag resolves
  to the current digest; absent `RepoDigests` => unknown; a changed base digest => rebuild_required.
- Build-configured flag: registration/`upsertApp`, `ImageService.check`, `ImageService.build`, and
  direct provisioning write the same value; a build added by "Check for changes" or a freshly
  provisioned clone shows the custom panel without a coordinator restart; existing rows are
  backfilled at startup registration.
- Build/restart distinction: a plain `POST /build` never restarts; a running app on the new image is
  `restart_required` until an explicit restart; the explicit Rebuild & restart restarts immediately.
- Invalid config: a manifest/Dockerfile made invalid after a successful build yields `build_error`
  from `GET /image` without a manual check; a pre-runner build failure persists `image_status =
  error`/`image_error` before throwing.
- State: `current`, `restart_required`, `rebuild_required`, `building` (with and without a usable
  image), `build_error`, `not_ready`, `unknown`; a stopped app is never `restart_required`; a default
  app is never `not_ready` from image status; precedence matches D5; `listApps` reads the durable
  `build_configured` flag and the state service uses it for blocking; a custom app with an unknown
  comparable hash/base identity is `unknown`, never `current`.
- Default launch: a stopped container on an old image ID is recreated on a repointed tag; a running
  container is reused; an absent target fails closed; a digest-pinned `HANSE_AGENT_IMAGE_DIGEST`
  launches (the coordinator uses `defaultImageReference()` and the runner accepts `spec.image ===
  config.defaultImage`).
- Applied state: `#recordStatus` and `#recordStatusById` write `applied_image_id`; the reconnect path
  and `resumeRunning` write it through a narrow update that preserves the settings hash/profile; the
  15 s reconciler is the bounded fallback; null is `unknown`; the ImageService state function reads
  `instances.state`/`applied_image_id`.
- Build durability: build start persists ID/ref/timestamp; coordinator restart mid-build re-attaches
  and adopts; coordinator restart after completion adopts by build ID and asserts the ref; legacy
  adoption asserts against `image_ref`, not the absent `image_build_ref`; a terminal build error
  clears the build fields; a durable-ref mismatch clears the build fields, records
  `image_build_rejected_ref`, yields `build_error`, and the mismatched target is not GC-protected; a
  second status poll after the mismatch does not re-adopt the rejected record; a skipped ready record
  leaves `image_status = error`, writes no version row, and is absent from the GC keep set; a
  coordinator restart/registration followed by two `GET /image` polls keeps the rejected marker and
  `state = build_error` (including the bounded mismatch message) and does not adopt/record a
  version/protect the target; a new build start clears the rejected marker; the `serveCommand` startup adoption pass
  resolves a build
  that completed while the coordinator was down, before the HTTP server is created, with no
  page/chat request and bounded per-app failures; a runner restart mid-build with a prior image =>
  `building -> build_error` after the grace/timeout and the prior image remains startable.
- Target/rollback: the target is the selected version's `image_id`, not the runner's latest record;
  rollback to an older version with a matching hash/base makes a running new-image container
  `restart_required` and an old-image container `current`; rollback to a version built from a
  different Dockerfile/base is `rebuild_required`; rollback to a version with a null `image_id` is
  `unknown`, while a legacy-hash version with a known `image_id` is `restart_required` when running
  on another image and otherwise `unknown`; base fields restore with the version.
- Restart preflight: a missing/unresolvable target leaves the running container untouched and returns
  409 `image_not_ready`; for a custom app the app-scoped inspect confirms the selected ref and the
  `hanse.app.id` label before stop; start/restart call the injected build adopter before target
  resolution, and a durable build that is not yet adopted is rejected; the CLI constructs the
  adopter/ImageService before the manager (or injects a standalone adopter); the async settings route
  awaits `manager.preflightRestart` before claim/202; a successful preflight then stop/ensure; a
  non-image ensure failure reports a start failure.
- Rollback preflight: a rollback to a missing/contradictory selected version leaves the running
  container untouched, restores the pre-rollback DB row, re-reads the post-rollback row, and rethrows
  the typed `image_not_ready`/`default_image_unavailable` through `rollbackImage`; after the restore
  the error's `state`/`imageStatus` are recomputed from the restored row so the error and
  `GET /image` agree; `http/images.ts` maps it before `ImageRollbackIncompleteError`; a valid
  rollback proceeds to stop/ensure.
- Stopped-row state: the reconciler does not probe stopped rows; a stopped→running out-of-band start
  is discovered by an ensure/start or the `InstanceManager.probeStatus` probe called once from
  `GET /image` for a persisted stopped row.
- Build attach: a `409 build_in_progress` for another app does not attach/poll as this app's
  `building`; the predicate is `imageBuildId !== null && state === "building"`, otherwise the client
  shows the bounded "another build is running" state and retries.
- Selected image missing locally: a build-configured app whose selected `apps.image_ref` is absent (or
  whose label/ID contradicts the version) has `usableImageRef = null` and state `not_ready`
  (`image_missing`), with Rebuild & restart as the action; a running app keeps the chat. An inspect
  that is unavailable/unknown keeps the ref and yields `unknown`, never a false missing verdict.
- Handoff relaunch: `HandoffDispatcher.relaunchReply`/`http/handoff.ts` map typed image failures to a
  bounded operator error, not a raw 502.
- HTTP: `GET /image` fields; build returns `targetRef`; start is human-only and rejects cross-site
  requests; restart rejects cross-site requests; start/restart are dispatched from `server.ts`; start
  with no usable image returns the typed 409, while start with a usable image while a rebuild is
  `building` or after a failed build succeeds; a sync restart of a stopped app returns
  `restarted:false`; an async restart performs the preflight before its `202`, returns a preflight
  failure as the typed error (not a 202) and a stopped app as `restarted:false` without a claim; the
  chat's async action handles both; the error is auth/scoped/bounded.
- Error mapping: `image_not_ready` and `default_image_unavailable` are mapped at every `ensure` site
  in chat (including `streamSessionEvents` and attachment upload), prompts, commands, context, master
  tools, handoff dispatch, and the start/restart routes; the typed error's `state` equals
  `GET /image`'s `state` (both from the injected `imageState`); no raw 502 text reaches the UI; the
  app-events SSE response is a bounded 409/503 JSON body; the chat shows the no-build card for the
  default-image case; handoff dispatch records a bounded handoff failure.
- Runner inspect: token required; a disallowed ref is 403; a malformed ref is 400; a missing image is
  `found:false`; the body is bounded; the resolution order is explicit digest, then matching
  `RepoDigests`, then unknown; a built `hanse-app-*` ref is accepted only with a matching `appId`
  and label, and is rejected otherwise.
- Chat client: the image fetch precedes `bootSessions`/`subscribe`/`hydrate`; a blocked app performs
  none of the three and shows no raw 502; `unknown` boots; a later 409 re-enters the card; the
  composer is hidden/disabled only while blocked; `build_error` while running keeps the chat usable.
- Application page: the initial shell uses the persisted values as a placeholder; both the custom
  and default panels carry `data-image-url`; `assets/images.js` fetches `GET /image` on load and
  renders the derived `state`, including stopped `rebuild_required`/`build_error` for custom apps and
  `restart_required`/`unknown` for default apps, not raw `imageStatus`; no `renderApplication`
  signature change is required.
- SSE: after a successful start/restart, `failures` is reset and `reconnectStream()` restores the
  stream; a long stop/ensure restart does not end in the paused state.
- Refresh: a running app that becomes outdated after a deploy shows the warning within one refresh
  cycle (60 s) or on focus, without a reload.
- GC: no `isManagedImage`/candidate-selection change; a base image and a running container are not
  collected; an in-flight `apps.image_build_ref` is protected between completion and adoption; a
  GC issued during an active build, before `image_build_ref` is persisted, does not delete the
  target because the runner's `protectedBuildTags()` provider unions its non-terminal build tags.
- Browser QA: extend `docs/design/chat-qa.mjs` with fixtures for not-ready/building/build-error/
  current/restart-required/rebuild-required and the build/start/restart actions; screenshots at phone
  and desktop, light and dark.
- Live: on a test application, remove/rebuild the custom image and confirm the card, build, start,
  and chat connection; on a running application with a new base, confirm the warning and
  rebuild+restart; confirm sessions and state survive the restart; on a default app, repoint the tag,
  restart, and confirm the container runs the new image ID.

## 11. Design review

**Owner decision (2026-10-25):** after 12 review rounds, freeze the design and proceed to the plan;
resolve any residual items during implementation as they arise. This is an explicit owner override
of the missing Oracle PASS, recorded here and in the plan's risks.



Round 1 (`oracle`) returned **CHANGES REQUESTED** on the points below. They were resolved in the
first revision. Round 2 (`oracle`) then returned **CHANGES REQUESTED** on seven new points, also
resolved. Round 3 (`oracle`) returned **CHANGES REQUESTED** on six residual points, also resolved.
Round 4 (`oracle`) returned **CHANGES REQUESTED** on six points, also resolved. Round 5 (`oracle`)
returned **CHANGES REQUESTED** on seven points, also resolved. Round 6 (`oracle`) returned
**CHANGES REQUESTED** on four points, also resolved. Round 7 (`oracle`) returned **CHANGES
REQUESTED** on three points, also resolved. Round 8 (`oracle`) returned **CHANGES REQUESTED** on
two points, also resolved. Round 9 (`oracle`) returned **CHANGES REQUESTED** on four points, also
resolved. Round 10 (`oracle`) returned **CHANGES REQUESTED** on five points, also resolved. Round 11
(`oracle`) returned **CHANGES REQUESTED** on four points, also resolved. Round 12 (`oracle`) returned
**CHANGES REQUESTED** on the four points recorded after the round-11 table; those corrections are
applied, and the design is frozen for the owner's decision on a round-13 review versus proceeding to
the plan.

| # | Review item | Resolution in this document |
| --- | --- | --- |
| 1 | Digest identity domains contradicted each other | D1 and V14 define image ID for applied-vs-target and manifest digest for base drift; D5/D6 use image IDs; no cross-domain comparison. |
| 2 | The runner cannot supply image IDs or `RepoDigests` | D11 extends `DockerImageInspect`/`DockerContainerInspect`, `statusFromInspect`, `RuntimeAppStatus`, and adds the inspect route; Impact lists `runner/docker.ts` and `runner/server.ts`. |
| 3 | No runner route resolves a base/default digest | D11 adds authenticated `GET /v1/images/inspect`, allowlisting, validation, bounds, and the resolution order; D8 uses it and forbids coordinator-to-Docker. |
| 4 | Explicit digest preference and no-`RepoDigests` case undefined | D1 defines the order (explicit `@sha256`, matching `RepoDigests`, unknown) and states a local-only image is unknown, not current. |
| 5 | Default launch identity is not guaranteed | D6 makes the runner compare the stopped container's image ID with the inspected target and recreate; the spec-hash alternative is rejected with a reason; Verification covers it. |
| 6 | `build.base` default disables the fallback | V15/D2 make it optional with the full resolution order, ARG scope, alias handling, and rejection of a contradictory declaration. |
| 7 | Base image must be allowlisted in code | D2/D13 add `HANSE_AGENT_BASE_IMAGE` to `runner/validate.ts`, `allowedImages`, the build validation, and both Compose services; Impact and Risks updated. |
| 8 | Build hash includes the base reference | D3 defines hash v2 (Dockerfile, args, base kind), excludes the reference, and adds the v1 recompute/rewrite rule and the no-outdated test. |
| 9 | Base metadata not threaded through build/persistence | D4/D7/D9 thread base kind/ref/digest through `ImageBuildInput`, build records, versions, rollback, and the manager snapshot; Impact lists the files. |
| 10 | Legacy backfill inferred the base from the current Dockerfile | D14 drops inference: legacy rows are `unknown`, non-`sha256:<64>` values are not digests, and only a successful build fills the fields. |
| 11 | V1 and D4 contradicted on `error`/`building` with a prior image | V1 and D5 use the single rule: block only when build-configured and `image_ref` is null; a prior usable image stays startable during/after a failed rebuild. |
| 12 | State table missed running+building/not_ready and `build_error` | D5 adds `build_error`, the running/stopped presentations, derivation order, and precedence (blocked `building > build_error > not_ready`; warning `building > build_error > not_ready > rebuild_required > restart_required`); stopped apps are never `restart_required`. |
| 13 | A stopped app without a build becomes `not_ready` | D5 keys derivation on `buildConfigured`; a default app is never `not_ready`/`building`/`build_error`. |
| 14 | Runner restart leaves `building` stuck with a prior image | D9 transitions to `build_error` regardless of `image_ref`, with a 60 s reachable grace / 30 min timeout from `image_build_started_at`. |
| 15 | No restart preflight | D10 resolves and validates the target before `#stopLocked`; image-caused failures keep the container; the non-image caveat is stated honestly. |
| 16 | `image_not_ready` mapped only on the new route | D11 defines one typed 409 error and maps every `ensure` site in chat, prompts, commands, context, master tools, and start; Impact adds those files. |
| 17 | EventSource cannot read the typed body | D12 makes the client fetch `GET /image` before `bootSessions`/`subscribe`/`hydrate`, gates all three, treats `unknown` as non-blocking, and re-enters on a later 409. |
| 18 | SSE pauses after a restart and the page never refreshes | D12 explicitly resets `failures` and calls `reconnectStream()` after success, and refreshes the image on stopped->running, every 60 s, and on focus/visibility. |
| 19 | Build adoption is lost across a coordinator restart | D9 persists build ID/ref/started-at, adopts by build ID even with no `#active`, asserts the ref, and covers startup adoption. |
| 20 | Target ID used the runner's latest record, breaking rollback | D7 reads `app_image_versions.image_id` for `apps.image_ref`; version rows carry `base_kind`/`base_ref`; `GET /image` exposes `targetImageId`, `buildConfigured`, `running`, `usableImageRef`. |
| 21 | `applied_image_id` has no source | D11 adds `imageId` to `RuntimeAppStatus`/`statusFromInspect`/`stoppedStatus`; D8 writes it in both status paths and the reconnect path; null is unknown; latency is stated. |
| 22 | New columns were not threaded and GC was ambiguous | D4 lists migration 18 fields and every registry/service/manager read-write; D15 keeps the GC algorithm/classification unchanged and adds the in-flight build ref to the protected set. |
| 23 | D10 claimed cross-site protection the restart route lacks | D11/D13 add the origin check to start and restart and register the start route in `server.ts`; D10 no longer claims parity. |
| 24 | V11 contradicted the master tools | V11/D13 restate: build and the new browser start are human-only; the master's existing allowlisted `start_app`/`restart_app` remain and map `image_not_ready`; no new agent actions. |
| 25 | Verification and Impact gaps | Section 10 adds the eight required tests plus the state/inspect/preflight cases; Impact adds `runner/validate.ts`, `runner/images.ts`, `http/prompts.ts`, `http/commands.ts`, `http/context.ts`, `master/tools.ts`, `agent/protocol.ts`, `http/server.ts`, the CLI constructors, `compose.yaml`, and docs; D8 and Risks state the pull-then-resolve cache rule. |

### Round 2

| # | Review item | Resolution in this document |
| --- | --- | --- |
| 1 | GC could delete the in-flight build target; D15 said GC needed no change | D4 and D15 keep the GC algorithm/classification unchanged but union `apps.image_build_ref` into the protected-ref set; Verification covers the in-flight ref. |
| 2 | A legacy row with `image_ref` and a null hash was filled from the inspection, yielding a false `current` | D3, D4, and D14 forbid filling the hash for a non-null `image_ref` unless the v1 reconstruction is provably exact; hash drift stays `unknown`. |
| 3 | A final stage aliasing a `${HANSE_BASE}` stage had no base kind; `base_mismatch` checked the wrong text | D2 resolves the root after alias/ARG expansion, classifies only the root, applies `base_mismatch` to the root, and tests the alias pattern. |
| 4 | Explicit base refs had no defined current-digest path/cache | D8 caches each recorded explicit `base_ref` by reference with the same 60 s TTL and refresh invalidation; a digest pin resolves to itself. |
| 5 | Custom restart preflight could not verify the selected image; the manager had no inspector | D10 adds an app-scoped inspect for the selected `apps.image_ref`, requires the `hanse.app.id` label and version ID agreement, and injects `inspectImage(ref, appId)` through `InstanceManagerOptions` wired from the CLI; D11 allows app-scoped built refs; Impact updated. |
| 6 | A digest-pinned default image could not launch because only `allowedImages` was checked | D6 and Impact require the runner launch allowlist to accept `spec.image === config.defaultImage`; Verification covers the digest env. |
| 7 | The start verification contradicted the usable-image rule | Section 10 now tests 409 only when no usable image exists, and successful start while building or after a failed build when a usable image exists. |

### Round 3

| # | Review item | Resolution in this document |
| --- | --- | --- |
| 1 | Legacy null-hash/v1 rules could still produce a false verdict | D3 scopes v2-at-registration to new rows or rows with `image_ref` null; a non-null `image_ref` with a null hash stays unknown with no v1 exception; v1 digest reconstruction requires the full non-digest reference including its tag. D14 and Verification match. |
| 2 | Digest-pinned default launch was not wired through the coordinator | D6 requires `resolveAgentImage` to use `defaultImageReference()` so the digest pin reaches the runner; the runner accepts `spec.image === config.defaultImage`; Impact lists the manager. |
| 3 | D9 legacy adoption assertion and build-field cleanup were wrong | D9 asserts against `image_build_ref` only for durable-ID adoption, uses `image_ref` for the legacy branch, and clears the build fields on a terminal runner error. |
| 4 | Async restart bypassed the preflight contract | D10/D11 run the preflight synchronously before the claim and before the `?async=1` `202`; a stopped app returns `restarted:false` without a claim; the client handles both. |
| 5 | Impact/threading omitted `listApps`, `#authoritativeApp`, and the supervisor status | D4/Impact add `CoordinatorService.listApps`, the selected-version `image_id` read, and `RuntimeAppStatus.imageId` as optional with `src/agent/supervisor.ts` returning null. |
| 6 | GC still had a pre-persistence race | D15 adds the runner's in-memory non-terminal build tags to the protected set; Verification adds a GC-during-active-build case. |

### Round 4

| # | Review item | Resolution in this document |
| --- | --- | --- |
| 1 | D9 mismatch left the build active and GC-protected | D9 clears `image_build_id`/`image_build_ref`/`image_build_started_at`, sets `image_status = error`, and keeps only the old image protected; Verification covers the mismatch state and GC. |
| 2 | Digest-only legacy v1 reconstruction was undecidable | D3 makes digest-only v1 rows permanently `unknown` for hash drift (never `stale`); the full-reference v1 case remains exact; `specHashVersion` is added to `ImageBuildInput`/`RunnerImageRecord` and the build record. |
| 3 | D10's D9-adoption dependency was not wired | D10 injects a build adopter (`resolveBuild`/`adoptBuild`) into `InstanceManagerOptions`, wired from the CLI; the master tools inherit it; `src/http/settings.ts` is listed for the synchronous preflight/202 behavior. |
| 4 | D4's `listApps` `buildConfigured` source was undecided | D4 adds durable `apps.build_configured` (written by registration from the manifest inspection); `listApps` selects it and needs no filesystem/root-path access. |
| 5 | D15's runner-side protected tags were missing from Impact/wiring | D15 defines `ImageBuildService.protectedBuildTags()` and an `ImageGcService` provider wired in `src/runner/server.ts`; Impact lists `src/runner/image-gc.ts` and the GC route. |
| 6 | The application page had no source for the shared state | D5 has the page fetch `GET /image` on load and `assets/images.js` render `state` (SSR uses persisted values as a placeholder); the round-5 correction removes the `renderApplication` claim and adds the default-panel fetch. |

### Round 5

| # | Review item | Resolution in this document |
| --- | --- | --- |
| 1 | D9 mismatch was re-adopted on the next poll | D4 adds `apps.image_build_rejected_ref`; both adoption branches skip it; D9 records it on mismatch and clears it on a new build/valid adoption/rollback; Verification covers a second poll. |
| 2 | D9 startup adoption was asserted but not wired | D9 adds the `ImageService` startup adoption pass over `image_build_id` (reattach/adopt/lost build/clear), and Impact/Verification include it. |
| 3 | `build_configured` was written only by registration | D4 requires registration/`upsertApp`, `ImageService.check`, `ImageService.build`, and direct provisioning to write it, with startup registration as backfill; Impact adds `src/coordinator/provision.ts`; Verification covers Check-for-changes and a provisioned clone. |
| 4 | D5/D14/V6 disagreed on unknown hash/base state | D5 step 7 returns `unknown` when a comparable hash/base identity is unknown for a build-configured app, removes the `current or unknown` wording, and D14/Verification align. |
| 5 | D10 wiring was incomplete/inverted | D10 constructs the adopter/`ImageService` before the manager (or injects a standalone adopter), adds async `manager.preflightRestart` before claim/202, and clarifies start/ensure; Impact/Verification cover the order and async path. |
| 6 | The application-page source contradicted SSR and the default panel had none | D5 keeps the on-load fetch, removes the `renderApplication` shared-state claim from Impact, and adds `data-image-url`/state rendering to the default panel; Verification covers it. |
| 7 | `default_image_unavailable` had no typed mapping | D11 defines `DefaultImageUnavailableError` (503, `default_image_unavailable`) mapped at the same ensure/start/restart sites; D12/Verification cover the no-build card and mapping. |

### Round 6

| # | Review item | Resolution in this document |
| --- | --- | --- |
| 1 | `image_build_rejected_ref` was not preserved by registration | D4 includes it in `ExistingImageRow`/`selectExisting` and the `upsertApp` conflict-preserve set; registration/startup never clears it; Verification covers mismatch -> restart/registration -> two polls. |
| 2 | The startup adoption pass was not wired to a startup call site | D9 specifies the `serveCommand` order (ImageService before manager, register, warm cache, adoption pass, then HTTP), with bounded per-app failures; Impact/Verification name the call site. |
| 3 | D5's `blocked` contradicted the running `not_ready` warning | D5 makes `blocked` the cold-start predicate and requires `!running` for the chat card; the `not_ready` row and D12 now say running = warning "Image missing; rebuild", stopped = Build and start card. |
| 4 | Typed errors promised a derived state the manager could not produce | D10 injects `imageState(appId)` from the same ImageService; both typed errors take `state` from it, so the error and `GET /image` agree; Impact/Verification updated. |

### Round 7

| # | Review item | Resolution in this document |
| --- | --- | --- |
| 1 | A ready-but-not-adopted record still mutated status/versions and became GC-protected | D9 says a non-adopted ready record clears only in-memory state and returns: no `image_status`/`image_error` write, no `#recordVersion`, no GC keep set; Verification covers two polls, status, versions, and GC. |
| 2 | D7's auto-restart sentence contradicted `restart_required` and D5/D10 | D7 scopes the immediate restart to the explicit Rebuild & restart; a plain `POST /build` never restarts and leaves a running app `restart_required`; Verification covers the distinction. |
| 3 | `build_error` was broader than its derivation | D5 step 3 also keys the live `inspection.status === "error"`; pre-runner build failures persist `image_status = error`/`image_error`; Verification covers an invalid manifest/Dockerfile after a successful build. |

### Round 8

| # | Review item | Resolution in this document |
| --- | --- | --- |
| 1 | Registration cleared a persisted `build_error` after a mismatch | D4 requires `mergeImageMetadata`/registration to preserve `image_status = "error"` and the bounded `image_error` when `image_build_rejected_ref` is set (and for a persisted build error until a new build/valid adoption/rollback); Verification covers restart/registration + two polls -> `build_error`. |
| 2 | D7/Verification claimed rollback `restart_required`/`current` even when the selected version differs from the current inspection | D7 and Verification qualify the verdict: matching hash/base => `restart_required`/`current`; a different Dockerfile/base => D5 step 5 `rebuild_required`; a rollback test covers both. |

### Round 9

| # | Review item | Resolution in this document |
| --- | --- | --- |
| 1 | D9 adoption mismatch contradicted its no-write rule | D9 now specifies three cases: durable match + ref match => adopt; durable match + ref mismatch => error/rejected; everything else, including a null `image_build_id` with a non-matching legacy record, => silent skip with no status/error/version/GC/marker write. |
| 2 | Registration could not read `image_error`/base/hash-version for its preservation rule | D4 adds `image_error`, `image_base_ref`, `image_base_kind`, `image_hash_version`, and `image_build_rejected_ref` to `ExistingImageRow`/`selectExisting`; the merge result returns them on the preservation branch. |
| 3 | D14/Verification misstated the legacy rollback target | D14/Verification now distinguish a null `image_id` (unknown) from a legacy-hash version with a known `image_id` (normal target comparison: restart_required when running on another image, otherwise unknown). |
| 4 | The reconnect `applied_image_id` write had no mechanism and was misdescribed | D8/D4/Verification replace the full `#recordStatus` claim with a narrow applied-ID update (preserving settings hash/profile) on the reconnect branch/`resumeRunning`, and name the `instances.state`/`applied_image_id` read in the state function. |

### Round 10

| # | Review item | Resolution in this document |
| --- | --- | --- |
| 1 | D8 still persisted base metadata during reconcile | D8 now persists only applied image ID/build fields; base identity is read-only for comparison. |
| 2 | V1 hash recomputation had no input path | D4 adds Dockerfile bytes (or a precomputed v1 hash) and base kind/ref to `AppBuildInspection`; Verification names the input path. |
| 3 | The reconciler is not a stopped→running detector | D8 narrows the guarantee: the reconciler probes only non-stopped rows; stopped→running is found by ensure/start or a bounded `GET /image` probe; Verification covers it. |
| 4 | Rollback restarts bypassed the D10 preflight | D10 runs the same preflight against the post-rollback selected version before `#stopLocked`, restores the DB row on failure, and maps the typed error; Verification covers it. |
| 5 | "Every ensure call site" omitted session SSE, attachment upload, and handoff dispatch | D11/Impact add `streamSessionEvents`, attachment upload, and `src/coordinator/dispatcher.ts` (bounded handoff failure); Verification covers the mapping. |

### Round 11

| # | Review item | Resolution in this document |
| --- | --- | --- |
| 1 | D8 stopped-row probe was unwired | D8 assigns the probe to `InstanceManager.probeStatus(appId)` (or an injected runtime-status function), called once from `GET /image` for a persisted stopped row and persisting state/applied ID; Verification covers it. |
| 2 | Rollback preflight lost its typed error and inspected the pre-rollback row | D10 re-reads the selected row after `rollback()`, rethrows typed errors through `rollbackImage`, maps them in `http/images.ts`, and restores the DB row on failure; Impact/Verification updated. |
| 3 | `409 build_in_progress` was treated as this app's build | D10 re-fetches `GET /image`; it attaches only when this app has a durable build/state `building`, otherwise shows the bounded "another build is running" state; Verification covers it. |
| 4 | D11 missed `HandoffDispatcher.relaunchReply` | D11/Impact add the dispatcher and `src/http/handoff.ts` (`relaunchReply` -> bounded operator error); Verification covers it. |

### Round 12

| # | Review item | Resolution in this document |
| --- | --- | --- |
| 1 | The 409-attach predicate had no durable ID in the view | D11 adds `imageBuildId` (durable) and defines `buildId` as the runner's latest diagnostic; the predicate is `imageBuildId !== null && state === "building"`; Impact/Verification updated. |
| 2 | A locally missing/contradictory selected image was not representable in the shared state | D5 makes `usableImageRef` require a confirmed-present selected image; missing/label/ID mismatch => `not_ready` (`image_missing`, Rebuild & restart); inspect unavailable => `unknown`. D12/Verification cover the running/stopped presentations. |
| 3 | Rollback's typed error state was computed before the pre-rollback row restore | D10 recomputes `imageState(appId)` after `#restoreImageState` and patches the error's state/imageStatus before rethrowing; Verification asserts error and `GET /image` agree. |
| 4 | The D8 stopped-row probe was missing from Impact | Impact adds `InstanceManager.probeStatus(appId)` and `src/http/images.ts` (stopped -> probe -> persist -> `images.status`); Verification covers the order. |
