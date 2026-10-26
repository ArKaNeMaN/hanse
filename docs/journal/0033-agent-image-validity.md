# Journal 0033 - Agent image validity, rebuild, and restart

Status: **implemented; automated gates and browser QA pass; live smoke pending**. Phases A-F are
implemented and Phase G adds deployment config, docs, this record, and the browser QA. `npm run lint`,
`npm run typecheck`, `npm test`, `npm run build`, and `npm run check:sensitive` pass; the full test
suite needs `HANSE_CREDENTIALS_DIR` unset in this app container (ambient git-credential
materialization), see Verification. The deterministic browser QA passes six image scenarios with 32
screenshots and zero console/page errors. Live smoke on a disposable application is pending (no
disposable app/token/runner in this environment), so the stage is not claimed as deployed.
Design: [`docs/design/agent-image-validity.md`](../design/agent-image-validity.md) - owner-accepted
after 12 review rounds without an Oracle PASS (explicit owner override, below).
Plan: [`docs/plans/0028-agent-image-validity.md`](../plans/0028-agent-image-validity.md) - plan review
PASS (`momus`).
Owner decisions: design section 8 and the plan's owner-decision table.

## Context

An application agent runs an image, not the coordinator's code. Before this stage the coordinator
recorded an image reference and a single "base digest" slot, but not the image the container was
launched with, the actual base of a custom image, or a durable in-flight build. A Hanse update could
therefore leave a running agent on an older image with no truthful state; a custom app with no image
failed its chat cold start and showed a raw launch error; and a harmless base-tag move could mark an
image stale. The stage introduces two identity domains and one shared image state, and makes image
identity, adoption, preflight, and presentation explicit.

## What shipped

### Phase A - Storage, schema, registry flag, backfill

- Migration 18 adds the durable fields listed below. It is forward-only and does not rewrite existing
  image or version rows.
- `.hanse/app.yaml` accepts optional `build.base` (`default | base`) with no schema default;
  `dockerfile` and `args` semantics are unchanged.
- The registry carries `build_configured`, base kind/ref, hash version, durable build identity, and
  the rejected-build marker through `RegisteredApp`, `AppBuildInspection`, `ExistingImageRow`,
  `MergedImageMetadata`, `selectExisting`, `upsertApp`, and `mergeImageMetadata`. Registration never
  clears an in-flight build or a rejected marker.
- `CoordinatorService.listApps` reads the durable flag and fields without filesystem access;
  provisioning writes the same flag in its transaction. Startup registration backfills existing rows.

### Phase B - Runner identity, inspect, launch, build records, GC

- Typed Docker inspection now exposes `RepoDigests` and the container's top-level `Image`;
  `statusFromInspect`/`RuntimeAppStatus` carry an optional `imageId` (supervisor and stopped status
  return null).
- The runner accepts `HANSE_AGENT_BASE_IMAGE` as `baseImage`, unions it into `allowedImages`, accepts
  the digest-pinned default reference at launch, and otherwise keeps the existing allowlist.
- A stopped container whose spec hash matches is recreated when the inspected target image ID
  differs; a running container is reused. An uninspectable target fails closed instead of starting
  the old container.
- Authenticated `GET /v1/images/inspect` resolves `{found, imageId, repoDigests, resolvedDigest}` for
  allowed references (app-scoped `hanse-app-*` refs only with a matching `hanse.app.id` label), with
  bounded input and body. Build records carry `targetRef`, hash version, base kind/ref/digest, and
  build-ID lookup.
- GC candidate selection and `isManagedImage` are unchanged; the protected set gains the coordinator's
  in-flight `image_build_ref` and the runner's own non-terminal build tags.

### Phase C - Image service, base resolution, hash v2, state, adoption

- The build-spec hash is version 2: Dockerfile bytes, sorted build args, and the resolved base kind.
  The base reference/tag/digest is excluded; a v1 hash is never compared with a v2 hash. A legacy v1
  row is recomputed only when its historical full reference is reconstructable; digest-only and
  null-hash rows stay unknown instead of becoming falsely current.
- Base resolution is a pure module: explicit `build.base`, then the final-stage root external `FROM`
  through aliases and ARG values. A root consuming `${HANSE_BASE}` is `default`, a literal root is
  `explicit`, an unresolved/cyclic root is `unknown`, and a contradictory `build.base` is rejected as
  `400 base_mismatch`. `base` without `HANSE_AGENT_BASE_IMAGE` is a configuration error; a manifest
  `HANSE_BASE` arg is rejected.
- One `deriveImageState` produces `current`, `restart_required`, `rebuild_required`, `building`,
  `build_error`, `not_ready`, and `unknown`, plus `usableImageRef`, drift, and `blocked`.
- Durable build start writes `image_build_id`/`image_build_ref`/`image_build_started_at`. Adoption is
  by build ID with a ref assertion or the legacy ref rule; a mismatch clears the build fields,
  records `image_build_rejected_ref`, sets a bounded `build_error`, and keeps the old image. A lost
  build transitions after the reachable grace / runner timeout. A startup adoption pass resolves
  builds that completed while the coordinator was down.
- The target image ID comes from the selected `app_image_versions` row, never the runner's latest
  record. Rollback/snapshot/restore carry the base and hash fields. Cache entries are keyed by
  reference with a 60 s TTL and event invalidation; an absent/unpulled image is `unknown`.
- Typed errors `ImageNotReadyError` (409 `image_not_ready`) and `DefaultImageUnavailableError`
  (503 `default_image_unavailable`) take their `state` from the same derivation as `GET /image`.

### Phase D - Manager, applied identity, preflight, startup wiring

- `InstanceManagerOptions` receives the runner-backed inspector, build adopter, and `imageState`.
  `resolveAgentImage` returns a usable reference before rejecting a build-configuration error.
- `applied_image_id` is written by destructive `ensure`, the reconciler (non-stopped rows only), and
  a narrow reconnect/`resumeRunning` update that preserves `applied_settings_hash` and
  `applied_profile`. A stopped-row probe is available for `GET /image`.
- Start/restart/rollback preflight resolves the adopted build and target identity before
  `#stopLocked`. A build still `building` or not yet adopted is rejected with `image_not_ready`; an
  image-caused failure leaves the running container untouched. A non-image `ensure` failure after
  stop is reported honestly as a start failure.
- `serveCommand` constructs `ImageService` before `InstanceManager`, registers projects, warms the
  identity cache, runs the adoption pass, and only then creates the HTTP server.

### Phase E - HTTP/API contracts, start route, error mapping

- `GET /api/apps/:app/image` exposes `buildConfigured`, `state`, `running`, `usableImageRef`,
  `targetImageId`, `appliedImageId`, `hashVersion`, `currentBaseDigest`, `baseKind`, `baseRef`,
  `baseDigest`, `imageBuildId` (durable), `buildId` (diagnostic), and `latestBuildImageId`; it keeps
  `previousImageRef`/`previousImageBuiltAt` and honors `?refresh=1`. A persisted stopped row is
  probed once.
- New human-only, project-scoped, cross-site-protected `POST /api/apps/:app/start` calls
  `manager.ensure` and never restarts a running agent.
- `POST /api/apps/:app/restart` runs the synchronous preflight before its claim and before an
  `?async=1` `202`; preflight failures return the typed error, a stopped app returns
  `restarted:false`, and a build response adds `targetRef`.
- Both typed image errors are mapped at every `ensure` site (chat, prompts, commands, context, master
  tools, handoff dispatch/relaunch, start/restart), so a raw launch error does not reach the UI.

### Phase F - Chat warnings/cards, orchestration, application page

- The chat fetches the image view before `bootSessions`/`subscribe`/`hydrate`. A blocked custom app
  shows the app-level card with **Build and start** (or **Retry build and start**); `unknown` boots
  optimistically, and a later typed 409 re-enters the card.
- Running warnings follow `building > build_error > not_ready > rebuild_required > restart_required`;
  a stopped app never shows `restart_required`. Running stale apps keep a usable chat.
- **Build and start** builds or attaches to the durable build, polls the image view, starts the agent,
  resets the SSE failure counter, reconnects, boots/hydrates, and records the intent for reload
  resume. **Rebuild & restart** does the same and then restarts only after the build is ready. A
  `409 build_in_progress` for another app does not attach/poll as this app's build.
- Image state refreshes on a stopped->running transition, every 60 s while running, and on
  visibility. Both application image panels fetch `GET /image` and render the derived `state`, base
  kind/reference, and rollback state instead of the raw `imageStatus`.

### Phase G - Docs, deployment config, record

- `compose.yaml` passes `HANSE_AGENT_BASE_IMAGE` to both the coordinator and runner. The Compose
  default is the published `hanse-agent-base` repository at
  `${HANSE_AGENT_TAG:-${HANSE_TAG:-latest}}`; the variable itself is a full reference, so an
  operator-provided tag or `@sha256` is used as written. No separate base-tag variable was added.
- `.env.example`, `docs/current-state.md`, `docs/conventions.md`, `docs/deployment.md`, the design
  status/plan link, and both indexes describe the shipped behavior.
- Deterministic browser QA now passes all six image scenarios (not-ready, building, build-error,
  warning, actions, panels) with 32 screenshots at desktop/phone and light/dark and zero console
  errors. Live smoke remains pending because this environment has no disposable app/token/runner.

## Migration 18 and backfill

`apps` gains `build_configured` (0/1, durable), `image_base_ref`, `image_base_kind`
(`default|base|explicit|unknown`), `image_hash_version` (>= 1), `image_build_id`,
`image_build_ref`, `image_build_started_at`, and `image_build_rejected_ref`.
`app_image_versions` gains `base_ref`, `base_kind`, and `hash_version`; `instances` gains
`applied_image_id`. Legacy NULLs are valid, and the migration adds CHECK constraints in the existing
style.

Startup registration backfills `build_configured` for registered apps; direct provisioning writes it
in the provisioning transaction; image check/build write the same value. Existing `image_ref` and
version rows are not rewritten. Legacy base kind/ref and v1 hash stay `unknown` until the next
successful build; the stage does not infer a base from the current Dockerfile. There is no down
migration.

## Decisions

- **Two identity domains, no coordinator revision.** Applied-versus-target uses Docker image IDs;
  base drift uses manifest digests. Tags, `Config.Image`, and the coordinator revision never
  substitute for either. A Hanse update with unchanged relevant digests marks no agent outdated.
- **Stale starts are allowed.** Image state is advisory; a build-configured app is blocked only when
  it has no usable image. Default-image apps are restart-only.
- **Durable build identity over in-memory state.** A build ID re-attaches after a coordinator restart,
  and a mismatch is rejected rather than silently adopted.
- **One shared state.** `GET /image`, typed errors, chat, and the application page consume the same
  derivation, so they cannot disagree.
- **No automatic action.** A plain build never restarts or starts; only an explicit Rebuild &
  restart restarts, and no response auto-recreates a running container.
- **Owner override of the missing Oracle PASS.** Rounds 1-12 of design review returned CHANGES
  REQUESTED; all findings were resolved in section 11, but no Oracle PASS was issued. On 2026-10-25
  the owner explicitly chose to freeze the design and proceed, handling residual items as they arise.
  This override is recorded here, in the design header, and in the plan; it is not a silent waiver.

## Accepted limits and residual risks

- Legacy v1/base identity stays `unknown` until the next successful build; a digest-only or
  unreconstructable v1 hash never produces a stale or current verdict.
- An unavailable/absent inspect or an image without `RepoDigests` is `unknown`, retried later, and
  never treated as current. An unknown identity never produces a false outdated/restart/not-ready
  verdict.
- Stale starts are intentionally advisory. A running container is not recreated until launch, so an
  outdated agent can keep running until an explicit restart.
- Dockerfile base parsing covers only the final stage, aliases, and ARG forms described in the design.
  Unresolved variables, cycles, and exotic syntax are `unknown`; `--platform` is ignored for identity.
- A non-image `ensure` failure after a passing preflight can still lose the old container; it is
  reported as a start failure, not an image failure.
- The 15 s reconciler does not probe stopped rows; an out-of-band stopped->running change is found on
  the next ensure/start or the bounded `GET /image` probe.
- Base/default images and build cache remain outside GC candidate selection; only the in-flight build
  target is added to the protected set.
- Browser QA for `not_ready`/`building`/`build_error`/warning/actions/panels passed. Live smoke on a
  disposable application is **pending** (no disposable app/token/runner); no live pass is claimed.

## Verification

- `npm run lint` - **pass** (Biome, 317 files).
- `npm run typecheck` - **pass**.
- `npm test` - **pass**: 129 files, **2474 tests**. Run with
  `env -u HANSE_CREDENTIALS_DIR npm test`; in this app container the ambient credentials directory
  otherwise makes the pre-existing `test/git-service.test.ts` fixed-environment case fail. That is
  environment provisioning, not this stage.
- `npm run build` - **pass**: `tsc` and Tailwind CSS -> `assets/app.css`.
- `npm run check:sensitive` - **pass**.
- Browser QA - **pass**: `CHAT_QA_ONLY=image-not-ready,image-building,image-build-error,image-warning,image-actions,image-panels node docs/design/chat-qa.mjs`; 6 scenarios, 32 screenshots,
  0 console/page errors; report `docs/design/artifacts/chat/report.json`.
- Live smoke - **not run**: no disposable application/token/runner in this environment; recorded as
  a blocker, not claimed.

## Artifacts

- Design: `docs/design/agent-image-validity.md`; index `docs/design/README.md`.
- Plan: `docs/plans/0028-agent-image-validity.md`; index `docs/plans/README.md`.
- Config: `compose.yaml`, `.env.example`.
- State/deployment/conventions: `docs/current-state.md`, `docs/deployment.md`, `docs/conventions.md`.
- This record; index `docs/journal/README.md`.
- Browser QA report `docs/design/artifacts/chat/report.json`; screenshots
  `docs/design/artifacts/chat/image-*.png`.
