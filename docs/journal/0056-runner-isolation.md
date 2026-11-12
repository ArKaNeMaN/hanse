# 0056 - Runner and container isolation

> Stage 04 of the hardening audit. Design and plan: the local hardening ledger
> (`.omo/hardening/stages/04-runner-isolation.md` and `04-plan.md`, untracked).
> Owner decisions Q-04-1..Q-04-5 are recorded there. Status: implemented and locally verified;
> host rollout, Docker integration, and rollback drill are still pending.

## Context

The runner is root-equivalent through the Docker socket, and app containers share a Docker host with
the coordinator. The audit found gaps in build-context reading, bind-source ownership, name
uniqueness, image provenance, runner capabilities, resource limits, image-disk accounting, build
state, and mount-source replacement. This stage closes F-14..F-22 while keeping app-visible paths
and the launch spec hash stable.

## What changed

- **Configuration and protocol**: validated `HANSE_HOST_MOUNTS`, `HANSE_DOCKER_DATA_ROOT`,
  `HANSE_BUILD_NETWORK`, `HANSE_BUILD_PROXY`, app resource maxima, pull budget, and durable build
  records. `GET /v1/meta` is the authenticated compatibility handshake; `/healthz` is constant
  liveness and `/readyz` is an authenticated bounded Docker check. Runner API is `3`; a runner that
  cannot serve a compatible `/v1/meta` is refused at coordinator startup.
- **Build context**: one fd-anchored, no-follow walk. Symlinks, FIFOs, and root-identity changes
  fail closed; the tar is produced from the validated file descriptors. `FROM` is checked in every
  stage, including `COPY --from=<image>` and `RUN --mount=from=<image>`; unknown variables,
  `RUN --network=host`, and non-allowlisted external images are rejected. Builds use a dedicated
  `hanse-build` bridge, never `default`, with a fail-closed fallback to `none`.
- **Names and images**: app container/network names include a hash of the exact app id. Managed
  containers are adopted/stopped/removed only after label verification; a running pre-v2 name
  returns `migration_required`, and only stopped legacy containers are swept. Purge/GC are
  label-first. Image pull checks the Docker data-root statfs (fail closed when unavailable), tracks
  streaming progress against `HANSE_PULL_MAX_BYTES`, and removes an over-budget or size-unknown
  image. A reader-writer gate lets creates run beside builds while GC/purge is exclusive.
- **Runner container**: read-only rootfs, `cap_drop: ALL`, only `CHOWN` and `DAC_OVERRIDE`,
  `no-new-privileges`, a `/tmp` tmpfs, memory/PID/CPU limits, and app-level `MemorySwap = Memory`,
  `OomScoreAdj: 500`, and `Ulimits`. Resource requests above runner maxima return
  `400 resource_limit`; they are never clamped.
- **Build lifecycle**: bounded durable records (atomic `0600`, 128 KiB log tail, 200 files / seven
  days) under `HANSE_BUILD_RECORDS_DIR`, with `building -> interrupted` on restart and unknown/newer
  record versions skipped. Authenticated `POST /v1/images/builds/:id/cancel` aborts the request and
  marks `cancelled`; cancellation is best-effort and the build-id-unique tag is never adopted.
  One-shot `git`/`validation` containers are swept at startup and periodically; managed containers
  are never touched.
- **Mount sources**: attachments and managed git credentials moved to
  `<HANSE_HOST_MOUNTS>/<project>/<app>/{attachments,git}`. The coordinator mounts the root
  read-write and the runner read-only; app containers keep the old read-only leaf paths. The
  coordinator pre-creates both leaves, including an empty git leaf, so the read-only bind always
  shadows the legacy writable path. `managedGitDirectory` validates the mounts leaf; missing,
  symlinked, or non-directory sources return `mount_source_unsafe`. Git materialization separates
  the write root from the stable visible path, so the launch hash is unchanged.
- **Migration**: startup migration, after project/app discovery and before the HTTP server, copies
  both legacy trees into the mounts root. It copies to a verified temp tree (file count, bytes,
  SHA-256), publishes with rename, writes `state/hanse/runner-layout.json` (`0600`), and never
  deletes the legacy copy. Reruns are idempotent; a missing mounts leaf is re-copied from the
  preserved backup; differing old/new content fails startup. Deletion removes the mounts app/project
  directory with symlink/containment guards.

## Decisions and trade-offs

- **API 3 is a unit upgrade.** The coordinator and runner are deployed together; IDE updates remain
  independent. A pre-v3 runner is refused rather than silently used.
- **`DAC_OVERRIDE` is retained.** The runner runs as root and must read per-app `0600` uid-1000 state
  on read-only binds. `CHOWN` remains for Test-connection drafts; no other capability is added.
- **No socket proxy.** It is nearly the full Docker API and adds a failure surface; the runner is
  already root-equivalent on `control`. This remains a documented non-goal.
- **App-to-coordinator exposure accepted.** The app bridge can reach the coordinator with its MCP
  token, never the runner token or `control`; Stage 03 must close the human-only mutation gap.
- **Copy migration is not a rollback.** Post-migration writes live only in the mounts root. Rollback
  requires restoring the backup or a reverse copy; the legacy tree is intentionally preserved.
- **Supervisor mode keeps the legacy layout.** Without a runner or mounts root, attachments remain
  next to the app HOME; the isolation layout applies to runner deployments.

## Verification

- `npm run lint`, `npm run typecheck`, `npm run typecheck:ui`: clean.
- `npm run check:sensitive`: passed.
- `npm test`: 4,180 passed, 4 skipped (Docker-gated integration), 272 files passed / 4 skipped,
  1,077 s.
- `npm run build` and `npm run check:ui`: passed (86 SFCs, sentinel present).
- Focused Stage 04 suites: 383 passed + 1 skipped for mounts; 174 passed for the lifecycle/gate
  suites; 142/145 passed across the image guard/pull suites; all typecheck/biome checks clean.
- `npm run test:e2e`: 137 passed, 1 skipped (7.5 min). The earlier attempt was blocked only by a
  concurrent operator E2E run on `http://127.0.0.1:4310/healthz`; after it finished, the full
  Playwright matrix passed.

## Residual risks and gaps

- Migration assumes app containers are stopped. A running pre-migration container can keep writing
  the legacy tree while the copy runs; the upgrade drill therefore requires stopping apps first.
- The migration copy is verified against a pre-copy snapshot, but path-ancestor symlink races remain
  a theoretical residual; symlinks and non-regular entries inside the tree fail closed.
- A mounts volume lost after the marker is not automatically rebuilt if a destination exists but is
  corrupt; a wholly missing leaf is re-copied from the legacy backup. Backups must include both
  `agents/` and the mounts root.
- Docker integration (`HANSE_TEST_DOCKER=1`) and the host upgrade/rollback drill are pending because
  this environment has no Docker socket. The app-container bind-read-only smoke is skipped.
- Stage 01 preview isolation remains deferred (local direct-IP deployment, no domain). F-01/F-02/
  F-03 stay open; revisit with a second loopback/LAN IP or disable previews.
