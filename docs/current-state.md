# Hanse - Current State (read this first)

> Last updated: 2026-10-28. This is the canonical description of what is **implemented right now**.
> If this document and the code disagree, the code wins - update this document.
> History and rationale: `docs/design/overview.md`, `docs/plans/0001-core.md`,
> `docs/journal/0001-core.md`. Deployment: `docs/deployment.md`.

## What it is

A self-hosted coordinator/workbench. A **project** contains **applications**; each application runs an
isolated `opencode` agent; applications can hand structured requests (specs) to siblings through the
coordinator. The product surface is one web UI (dashboard + chat + handoffs) plus an embedded web IDE.

## Stack and repository

- Repository: `github.com/ArKaNeMaN/hanse` (branch `main`). Local checkout: `dev/hanse`.
- TypeScript, ESM, Node >= 20.19.0, npm.
- Build: `tsc`, Tailwind CSS (`npm run build:css` -> `assets/app.css`), and Vite
  (`npm run build:ui` -> `assets/ui/`). Tests: vitest (server + jsdom UI projects). Lint/format:
  Biome. Schemas: zod. YAML: `yaml`. Database: `better-sqlite3`.
- Public OSS; license not chosen yet.

## Runtime topology (B2: runner + per-app images)

Five images are built from `Dockerfile`: `ghcr.io/arkaneman/hanse` (coordinator),
`ghcr.io/arkaneman/hanse-agent-base` (shared agent base), `ghcr.io/arkaneman/hanse-agent-default`
(per-app agent), `ghcr.io/arkaneman/hanse-agent-ide` (IDE), and `ghcr.io/arkaneman/hanse-runner`
(runner). Publish currently targets `linux/amd64`; arm64 is on-demand/backlog. Compose definitions
live in `compose.yaml`; `compose.build.yaml` adds a source build, and `compose.host-auth.yaml` mounts
a host `opencode` auth file.

- **`hanse`** (coordinator): runs `node dist/index.js serve --workspace /data/workspace`. Mounts
  `./workspace:/data/workspace`, `./state:/data/state`, and `./agents:/data/agents`; the host opencode
  auth file is optional. Talks to the runner at `http://runner:8790` with `HANSE_RUNTIME_TOKEN`.
  `HANSE_IDE=0` means it does **not** spawn code-server itself.
- **`hanse-ide`** (VS Code): runs `agent-ide` with code-server and the default toolchains. Mounts
  **only** `./workspace:/data/workspace` (no `state` or `agents`). Serves on `8080`, reachable only on
  the `front` network.
- **`hanse-runner`**: the only Docker socket holder. It runs on the internal `control` network, has
  no `/data/state`, and mounts the host workspace and agents volumes read-only (workspace for
  build-context tar/validation, agents for per-app passwords). It validates runtime specs, builds
  app images, and creates one app container per application.
- **`hanse-app-<project>-<app>`** (dynamic): one `agent-default` container per app, on its own
  `hanse-app-*` bridge network. It mounts only the app directory and `/data/agents/<project>/<app>`;
  uid 1000, read-only root, `cap_drop: ALL`, no state, no Docker socket, no operator/runtime token.
  `opencode serve` listens on `0.0.0.0:4100` inside the app network.
- **Networks:** `front` contains the coordinator and IDE; `control` contains the coordinator and
  runner; each app container has its own network. App containers cannot reach the IDE or sibling apps.
- **Exposed port:** `${HANSE_BIND:-127.0.0.1}:${HANSE_PORT:-8787}` (loopback by default; set
  `HANSE_BIND=0.0.0.0` or a LAN IP to expose it). `/healthz` is an unauthenticated constant liveness
  endpoint; the separate unauthenticated `/readyz` reports version, revision, schema version,
  deployment-lock state, and in-flight lifecycle count. `/` and `/api/*` are our UI; `/ide/*` is
  reverse-proxied to `ide:8080` (HTTP and WebSocket), with `/ide` stripped and `?folder` confined to
  the workspace root. The coordinator is the single front door.

## Deployment safety and readiness

- **Deployment lock.** The coordinator reads an advisory JSON lock at `HANSE_DEPLOY_LOCK_FILE`
  (default `<state>/hanse/deploy.lock`) and never writes it; the external orchestrator owns it. While
  active, operations that could delete, stop, recreate, build over, or roll back a managed app throw
  `DeploymentInProgressError` and map to `409 deployment_in_progress` with `Retry-After: 30`. A
  running app with a working password, reconciled MCP token, and endpoint still reconnects and serves
  chat. The guard runs once at operation entry; a started destructive operation completes rather than
  rechecking mid-operation. `ENOENT` is inactive, other read/stat errors fail closed, and a malformed
  lock is active until its file mtime is older than 300 seconds.
- **Quiescence handshake.** The orchestrator writes the lock, then polls `GET /readyz` until
  `deploying: true` and `inFlightLifecycle: 0` on two consecutive polls at least two seconds apart,
  then switches images, heartbeats every 60 seconds, and removes the lock. A lock older than 300
  seconds at the heartbeat or past `expiresAt` is stale; `expiresAt` slides from the last heartbeat
  and is clamped to `updatedAt + 2 hours`. The lock is not part of the database backup: a whole
  `state/` restore must restore only the DB/non-lock state or rewrite the lock before continuing.
  `hanse images` honors the lock but runs outside the process counter and must not run during a
  deploy.
- **Readiness.** `GET /readyz` is synchronous, unauthenticated, non-mutating, and returns
  `{status,version,revision,schemaVersion,deploying,inFlightLifecycle}` with
  `Cache-Control: no-store`; `revision` comes from image-provided `HANSE_REVISION` (`unknown` when
  absent), and a schema-query failure returns `503 {"status":"error","error":"database_unavailable"}`.
  It never calls the manager or runtime. The existing synchronous database handle inherits
  `busy_timeout=5000`, so a concurrent restore can delay it up to five seconds.
- **Schema guard.** Starting against a database whose applied migration is newer than the binary, or
  whose applied version is unknown, exits `1` before listening and before any partial migration.
  An applied checksum that differs from the code logs `schema_checksum_mismatch` with the version and
  continues; the operator should investigate a possible edited or corrupted migration.
- **Async restart.** `POST /api/apps/:app/restart?async=1` claims synchronously and returns
  `202 {accepted:true,appId}` without waiting; a duplicate claim returns `409 restart_in_progress`.
  Sync, async, and image-rollback restarts share one per-app claim. `GET /api/apps/:app/runtime`
  exposes `restarting`. The claim is in memory: if the coordinator exits after `202`, the app can
  remain stopped with no surviving marker, and the caller must retry or use the sync route.
- **MCP-token reconciliation.** A running app whose token row is missing or rotated reconciles the
  token in place and reconnects without `runtime.delete`/`runtime.ensure`; the container identity and
  start time are unchanged. Mint and file write are compensated on failure, an old in-flight token
  gets `401`, and the next request re-reads the new file. A running app's reconciliation failure
  returns `500 agent_token_reconcile_failed` (or `409 deployment_in_progress` under a lock) instead
  of recreating the container. The DB/file invariant is eventual, not crash-safe: a crash between the
  DB commit and the file rename leaves a mismatch that the next startup/`ensure` repairs.
- **Release identity.** Publish is gated by a `verify` job and a non-pushing `docker-verify` matrix
  for all five targets; `publish` needs both. Images carry both `sha-<short>` and `sha-<full>` tags,
  the full commit in the OCI revision label, and the full commit in `HANSE_REVISION`. `verify-images`
  checks all five full-SHA manifests after the matrix, records digests, and uploads the
  `image-digests` artifact. Tags are mutable; the orchestrator pins digests. IDE, runner, and agent
  tags are independently overridable with backward-compatible fallbacks.

## Per-app images (B2)

- `.hanse/app.yaml` may declare `build.dockerfile` (default `Dockerfile`), `build.args`, and an
  optional `build.base` (`default | base`, no schema default). Without `build.base`, the coordinator
  resolves the Dockerfile's final-stage root `FROM` through stage aliases and build args: a root that
  consumes `${HANSE_BASE}` is `default`, a literal root is `explicit`, and an unresolved or ambiguous
  root is `unknown`. A configured `build.base` whose resolved root ignores `${HANSE_BASE}` is
  rejected as `base_mismatch` (`400`); `HANSE_BASE` is coordinator-owned and may not be set as a
  manifest build arg. `base` resolves to `HANSE_AGENT_BASE_IMAGE`, and a missing value is a
  configuration error rather than a silent default.
- Two identity domains are never mixed. Applied-versus-target compares Docker image IDs (container
  `Image` versus inspect `Id`); base drift compares manifest digests from `RepoDigests`. There is no
  coordinator-revision comparison: a Hanse update with unchanged relevant digests marks no agent
  outdated. An unresolvable identity is `unknown` and never produces a false `current`,
  `restart_required`, `rebuild_required`, or `not_ready`.
- The build-spec hash is version 2: Dockerfile bytes, sorted build args, and the resolved base kind.
  The base reference/tag/digest is excluded and compared separately, so a harmless tag move does not
  mark an app stale. A stored version-1 hash is never compared with version 2; a legacy v1 row is
  recomputed only when its historical full reference is reconstructable, and otherwise hash drift
  stays `unknown` until the next successful build.
- The registry reads `.hanse/app.yaml` directly, records image status/ref, base kind/ref/digest,
  hash version, built-at, and error, and persists durable `build_configured` from the manifest
  inspection (registration, provisioning, image check, and build all write the same value). Invalid
  manifests or Dockerfile paths mark the app image `error` without failing the whole project.
- A human action (`POST /api/apps/:app/build`, the app page Image panel, or `hanse images build`)
  asks the runner to build. The runner tars a contained app context (no symlinks, `.git`, state,
  agents, or caches) and builds from the resolved base; no build runs at deploy time and nothing
  auto-builds on file edits.
- Every built image is validated in a no-network, read-only, cap-drop one-shot container. It must
  provide the Hanse entrypoint, `opencode`, the `hanse agent-host`/MCP CLI, and `git`; image-declared
  volumes are rejected. A failed validation/build keeps the previous image and container and marks
  the app `error`.
- Build identity is durable. A build start persists `image_build_id`, `image_build_ref`, and
  `image_build_started_at`. A ready runner build is adopted only by durable build ID with a ref
  assertion, or by the legacy `image_ref` rule; a target mismatch clears the build fields, records
  `image_build_rejected_ref`, and keeps the old image. A lost build becomes `build_error` after the
  reachable grace / runner timeout, and a new build, valid adoption, or rollback clears the rejected
  marker. At startup the identity cache is warmed and the adoption pass runs before the status
  reconciler and before the HTTP server; `ImageService` is constructed before `InstanceManager`.
- The state model shared by `GET /api/apps/:app/image`, the typed errors, the chat, and the
  application page is `current`, `restart_required`, `rebuild_required`, `building`, `build_error`,
  `not_ready`, and `unknown`. Running on a stale image is allowed; a build-configured app is blocked
  from a cold start only when it has no usable image, and a prior usable image stays startable during
  a rebuild or after a build failure. Default-image apps are restart-only and are never
  `not_ready`/`building`/`build_error`/`rebuild_required` from image state.
- `GET /api/apps/:app/image` returns the derived `state`, `buildConfigured`, `running`,
  `usableImageRef`, `targetImageId`, `appliedImageId`, `hashVersion`, `currentBaseDigest`,
  `baseKind`/`baseRef`, `imageBuildId` (durable) plus the diagnostic `buildId` and
  `latestBuildImageId`, and honors `?refresh=1`. The new human-only `POST /api/apps/:app/start`
  starts a stopped app without restarting a running one; `POST /api/apps/:app/restart` runs the image
  preflight synchronously before its claim and before a `202`. A missing usable image returns typed
  `409 image_not_ready`; a default image that is absent locally returns typed
  `503 default_image_unavailable`, mapped at every `ensure` site so no raw launch error reaches the
  UI.
- The chat fetches the image view before booting sessions/events: a blocked custom app shows
  **Build and start** (or **Retry build and start**) and waits on the same page, while a running
  outdated app keeps the chat and shows a **Restart** / **Rebuild & restart** warning. A successful
  build-and-start or rebuild-and-restart reconnects the stream; image state refreshes on a
  stopped->running transition, every 60 s while running, and on visibility. The application page
  renders the same derived `state` on both image panels, not the raw `imageStatus`.
- Migration 18 adds the durable fields (`apps.build_configured`, `image_base_ref`,
  `image_base_kind`, `image_hash_version`, `image_build_*`, `image_build_rejected_ref`;
  `app_image_versions.base_ref`, `base_kind`, `hash_version`; `instances.applied_image_id`). It is
  forward-only; existing rows keep their data and legacy base/hash identity stays `unknown` until
  the next successful build.
- The app container uses `apps.image_ref` when a build is configured. The coordinator keeps the
  current and previous image versions; the app page can roll back, and an explicit GC protects
  current/rollback/running images, the in-flight build target while `image_build_id` is set, and the
  runner's own non-terminal build tags. It only removes `hanse-app-*`/Hanse-labelled images.
- This repository's own application ships `.hanse/Dockerfile` with a headless Chromium, Debian 12
  runtime libraries, fonts, and a Playwright MCP environment for functional/visual web UI checks.
  It is application-local; `agent-default` and the other application images are unchanged.
- The image panel exposes a human-only **Check for changes** action for apps on the default image. It
  re-reads the live manifest/Dockerfile and persists the merged image metadata
  (missing/stale/error) without a build, so a newly added `.hanse/Dockerfile` appears without a
  coordinator restart. Builds and restarts remain explicit.

## App image usage and GC (B2.5b)

The runner exposes two runtime-token endpoints; the coordinator wraps them as human-only
`GET /api/images/usage` and `POST /api/images/gc`.

- `GET /v1/images/usage` returns the `HANSE_HOST_WORKSPACE` filesystem total/used/free/percent from
  `statfs`, plus Docker image/build-cache totals from `GET /system/df`. `level` is `ok` below 75%
  used, `warning` from 75%, and `critical` from 85%. Docker/statfs failures are reported as bounded
  errors with partial data. The threshold is advisory: **crossing it never deletes anything**.
- `POST /v1/images/gc` is explicit and serialized (a concurrent call returns `409`). The coordinator
  sends the durable keep set (`apps.image_ref`, `app_image_versions.image_ref`, `instances.image_ref`
  for `running`/`starting`, and `apps.image_build_ref` while `image_build_id` is set); the runner
  additionally protects every image referenced by a Docker container and its own non-terminal build
  tags, closing the window before the coordinator persists `image_build_ref`. A rejected/mismatched
  target is not protected. GC removes only `hanse-app-*` tags or images labelled `hanse.app.id`,
  skips images that also carry unrelated tags, and prunes build cache only through the Docker
  build-cache prune API. A Docker error stops the run (fail closed).

## Project and application deletion

Deletion is a human-only, server-confirmed destructive flow on the project and application pages
(`Danger zone`) with a native dialog. Mutations go to
`POST /api/projects/:id/delete` and `POST /api/projects/:id/apps/:appKey/delete`; JSON callers may
use `DELETE /api/projects/:id?confirm=...` and
`DELETE /api/projects/:id/apps/:appKey?confirm=...`. The exact project name or app key must be typed
and is re-validated server-side. Browser callers get a `303` plus notice; JSON gets
`200 {deleted,kind,projectId,appKey?,warnings}`; errors map `400` confirmation, `401`/`403` auth,
`404` unknown, `409` (`deletion_in_progress`, `deletion_incomplete`, `build_in_progress`,
`state_path_collision`, `shared_app_dir`, `shared_project_root`, `unsafe_*`), `502` runtime/runner
failure, and `503` when no runner-backed deletion service is configured. A present cross-site
`Origin` is rejected; `hanse_token` remains `SameSite=Strict`.

- The flow stops the managed container, removes its app network (only when the managed labels match),
  purges the app's `hanse.app.id`-labelled images, and removes the per-app agents directory
  (opencode DB/sessions, auth, password, MCP token, OMO profile, materialized git credentials,
  cache/tmp/mise). A project deletes all its apps, the project rows, project/app-scoped settings,
  provider keys, git credentials, and handoffs; handoff approvals/messages cascade and app-scoped
  policy rules are removed. Each deletion writes an `events` row (`app.deleted`/`project.deleted`).
- Source files are kept by default; `Delete files too` explicitly removes the app/project directory
  after the registry cleanup. Source deletion re-checks the live registry, refuses roots, symlink
  components, sibling apps/projects and shared directories, and is warning-only if it cannot
  proceed.
- SSH audit rows, global settings/provider keys, SSH host definitions, and other projects are
  preserved. Handoffs that reference a deleted app/project are deleted (their history is replaced by
  the `events` audit row). A shared project root is refused when its manifest belongs to the target
  (`409 shared_project_root`); a manifest that belongs to another project at the same root is
  preserved.
- Migration v11 adds durable `apps.deleting`/`projects.deleting` markers. A partially failed
  deletion leaves `Deletion incomplete`, blocks start/chat/terminal (`409 deletion_pending`), and is
  completed by a retry; it cannot be cancelled. A successful deletion removes the row and its marker.
  Deletion requires a reachable runner (Q4); a runtime failure aborts before any durable marker.
  Image-purge skips (in-use/shared tag/limit/timeout/truncated) are returned as `warnings`; the
  existing image GC remains available.

## Auth (one login)

- One operator token (`HANSE_OPERATOR_TOKEN`), stored hashed as a human principal named `operator`.
- Browser: `POST /login` sets the `hanse_token` cookie (`HttpOnly`, `SameSite=Strict`). Mutating
  endpoints and `/ide/*` require it.
- The IDE extension authenticates to the coordinator with the same token via `HANSE_API_BASE`
  (`http://hanse:8787`) and `HANSE_OPERATOR_TOKEN`.
- No separate IDE password; code-server runs with `--auth none` and is only reachable through the proxy.

## Web UI (stages 2-3)

- Shared server-rendered shell (`src/http/ui.ts`): fixed sidebar, top bar with breadcrumb and global
  IDE link, mobile drawer, sidebar theme toggle (dark default, `localStorage["hanse-theme"]`),
  sign-out, skip link, notice toasts, and the full status/icon/dialog primitive set.
- Authenticated pages: `/` fleet overview, `/projects`, `/projects/:id`,
  `/projects/:id/apps/:appKey`, `/settings`, `/projects/:id/settings`,
  `/projects/:id/apps/:appKey/settings`, `/skills`, `/projects/:id/skills`,
  `/projects/:id/apps/:appKey/skills`, `/handoffs`, and the
  `/chat?app=<key>&project=<id>` workspace.
  `/login` is a standalone cover/plate. All HTML pages except `/login` and `/assets/*` require a
  **human** principal; unauthenticated requests redirect to `/login?next=<validated local path>`.
- Browser forms post to the existing API endpoints and receive a 303 back to a validated `return_to`
  with a `notice`/`tone` toast. JSON API behavior is unchanged for non-browser callers.
- Handoff decisions use `POST /api/handoffs/:id/decision` (`decision=approved|rejected`, optional
  `approval_kind=dispatch|reply`, `reason`, `return_to`); the legacy `/approve` and `/reject` endpoints
  still work. Reply relaunch/retry/cancel and the project policy editor use
  `POST /api/handoffs/:id/reply/*`, `POST /api/handoffs/:id/cancel`, and
  `POST /api/projects/:id/handoff-policy*` (all human-only).
- Static assets are allowlisted: `/assets/app.css`, `/assets/app.js`, `/assets/chat.js`,
  `/assets/chat-core.js`, `/assets/chat-commands.js`, `/assets/chat-diff.js`, `/assets/chat-highlight.js`,
  `/assets/chat-highlight-worker.js`, `/assets/git.js`, `/assets/git-settings.js`,
  `/assets/handoff.js`, `/assets/settings.js`, `/assets/skill-detail.js`, `/assets/markdown.js`,
  `/assets/vendor/prism/prism-1.30.0.min.js`,
  `/assets/vendor/xterm/xterm-6.0.0.js`, `/assets/vendor/xterm/xterm-6.0.0.css`,
  `/assets/vendor/xterm/addon-fit-0.11.0.js`,
  `/assets/vendor/xterm/addon-unicode11-0.9.0.js`,
  `/assets/vendor/xterm/addon-unicode-graphemes-0.4.0.js`, and `/assets/favicon.svg`.
- `assets/app.js` owns shell behavior (drawer, theme, nav); `assets/app-content.js` owns dialogs,
  menus, segmented controls, toast close/autodismiss, password visibility, and submit-busy behavior.
  Legacy pages load both; SPA documents load only `app.js`. `assets/chat.js` is an ESM module that owns the chat workspace (sessions,
  messages, typed SSE, composer, queue, questions, OMO cards, safe markdown/tables, syntax-highlighted
  diffs/write content) and imports the pure helpers in `assets/chat-core.js`,
  `assets/chat-commands.js`, `assets/chat-diff.js`, and the lazy worker controller in
  `assets/chat-highlight.js`. `assets/git.js` hydrates the
  application git panel. All routes except `/` and `/projects` remain server-rendered by default;
  the Vue/Vite client has cut those two routes over and is scaffolded for later routes (see
  **UI rendering modes**).
- The chat workspace is the stage-3 three-pane surface: sessions rail, thread, and context rail.
  Below 1360 the context pane is a drawer; below 768 both rails are drawers. The thread is the only
  scroll owner. `session` is mirrored to the URL, and the optional `project` query disambiguates
  duplicate app keys across projects.

## UI rendering modes (Phase 2B)

- `/` (fleet overview) and `/projects` are SPA routes: the shared registry
  (`src/shared/routes.ts`) has `spa: true` for `overview` and `projects` and `spa: false` for every
  other page. `/projects/:id` and every later route stay legacy documents. The page dispatcher is
  the only place that chooses a renderer:
  `HANSE_UI_LEGACY=1` > `?legacy=1` > `HANSE_UI_SPA_ROUTES` > the registry flag. A missing, invalid,
  or partial `assets/ui/.vite/manifest.json` also falls back to legacy and logs
  `ui.manifest_invalid`.
- The Vue 3 + Vue Router + Pinia + Vue Query client lives in `ui/`, builds into `assets/ui/`
  (`npm run build:ui`), and mounts into the existing server shell `<main id="main">` (no second
  wrapper). Server-rendered chrome is refreshed through `GET /api/ui/chrome?path=`, and page data
  comes from boot JSON plus per-route `/api/ui/*` endpoints. `/projects` renders the legacy header,
  six-column ledger, search, empty states, deletion status, and create dialog in Vue. `/` renders
  the legacy header, four-cell watch strip, project ledger, recent handoffs, waiting route cards,
  runtime rail, and empty state; project links cross a full document boundary to the legacy detail
  page, while the overview-to-`/projects` link stays client-side. The native new-project dialog is a
  shared Vue component used by both pages.
- Built client assets are served from `/assets/ui/*` with immutable caching; compressible responses
  are gzip-encoded when the client offers it (first loads measure ~137 KiB for `/projects` and
  ~133 KiB for `/` on the deterministic fixture).
- SPA documents and `/api/ui/*` are cookie-only. `/api/ui/*` returns `401` without a human cookie,
  `403 cookie_required` for a human bearer without a cookie, and `403` for agent tokens; responses are
  `no-store`.
- Script split: legacy pages and `/login` load `app.js` + `app-content.js`; SPA documents load only
  the shell `app.js`. SPA toasts are owned by the Vue `ToastHost`, not `app-content.js`. SPA
  mutations send `X-Hanse-Client: spa`; `POST /api/projects` then answers `200 {ok:true, project}`,
  while the legacy form path keeps its `303` + notice.
- `#ui-fallback` stays hidden, then reveals after 4 s only if the client did not mount;
  `vite:preloadError` reloads once and then renders a safe `?legacy=1` fallback.

## Git workbench

- The Application page (`/projects/:projectId/apps/:appKey`) is human-only and server-rendered; the
  git panel is hydrated by `assets/git.js`. The page header has `Open chat`, `Terminal`, and a
  `More actions` disclosure (`Open IDE in this folder`, `Application settings`); a two-cell state
  strip (`Runtime`, `Settings`) precedes the git workbench. Repository and Changes occupy the main
  column; the rail holds Image, SSH access, Remotes, and Last commit. The page's only brass action is
  `Commit all`. It is linked from the project application table, the chat context rail, and the chat
  breadcrumb.
- Runtime state uses one vocabulary from the runner: `starting`, `running`, `stopped`, `error`
  (legacy `failed` normalizes to `error`). The overview shows all four counts; the app, chat, and
  terminal surfaces use the same pill mapping. `POST /api/apps/:app/restart` calls
  `restartIfRunning()` (stop plus ensure) and reports a failure instead of claiming success. Applied
  settings/profile hashes are persisted on `instances` (migration v10); a running agent whose launch
  state cannot be confirmed shows `Applied state unknown` and `Restart required`, never `Applied`.
- The coordinator reconciles persisted `running`/`starting` rows with the runner at startup and
  every 15 seconds. Out-of-band stops become `stopped`/`error`; a restart that finds a stopped agent
  persists `stopped` before showing `Agent is not running; settings apply on next start.`; a status
  transport failure leaves the last known state unchanged. This prevents stale `Restart required`
  markers after a deployment or coordinator restart.
- A fresh start or reconnect only returns its endpoint after opencode answers `GET /agent` (bounded
  poll, 30 s). A container that is running but not HTTP-ready is therefore never handed to chat; if
  the deadline expires the API returns `503` `agent_starting` with `Retry-After: 5` instead of a raw
  `fetch failed`.
- Human-only JSON API under `/api/projects/:projectId/apps/:appKey/git`:
  `GET /status`, `POST /fetch`, `/update`, `/push`, `/commit`, `/branches/switch`. Mutations are
  JSON-only and require the operator session; agent principals receive `403`.
- Status shows the current branch or detached HEAD, unborn branches, upstream ahead/behind, clean/
  dirty state, staged/unstaged/untracked/conflicted files, local branches, remotes, the last commit,
  in-progress operations, and commit-identity readiness.
- Actions: fetch all remotes; fast-forward update (`pull --ff-only`); switch a local branch; commit
  all tracked, unstaged, and untracked changes with a message; push (setting an upstream when absent
  and `origin` exists).
- The application directory must be the repository root and inside the workspace. In B1 the
  coordinator delegates every operation to the runner (`POST /v1/apps/:appId/git`); the runner
  validates the fixed operation set and executes it in a one-shot container from the app image
  (uid 1000, the app directory rw, and the application's managed credential directory
  `<app>/home/.config/hanse/git` read-only at `/run/hanse/git/app`; `--network none` for local
  operations and the app network for fetch/update/push/test). Repository hooks, fsmonitor, SSH
  commands, ext protocols, and credential helpers therefore never run in the coordinator.
- Git identity (`git.user.name`/`git.user.email`) and per-scope SSH/HTTPS credentials are configured
  in Settings -> Git and materialized into the application HOME; see
  [`docs/design/git-credentials.md`](design/git-credentials.md). Fetch/push use the effective
  credential, not a runner environment variable.
- Adding an application from a remote (`remote` on the project page or the master `add_app` tool)
  clones synchronously with the target project's effective `global` + `project` git credential
  (never `app` scope). The coordinator writes the credential into a short-lived `0700` directory
  under its temp root, uses the same SSH wrapper/HTTPS askpass, host allowlist, and child-env
  allowlist as fetch/push, and removes the directory in `finally`; stale `hanse-git-clone-*`
  directories are swept at startup (skipping registered dirs, other uids, symlinks, and the
  workspace). SSH remotes require an SSH credential (clear failure otherwise), HTTPS remotes use the
  token when configured and otherwise clone publicly, and `git://` is unchanged. Every branch uses
  the git env allowlist with an empty `HOME` and never spreads `process.env`; plain clones write no
  credential files. Remotes with `?`/`#` are rejected. Clone stderr is sanitized on both branches
  (secrets, userinfo, and control characters removed, capped at 300 characters) and surfaced in the
  `clone_failed` message.
- `POST /api/projects/:projectId/apps/:appKey/git/test` tests **draft** SSH/HTTPS values in the same
  runner one-shot sandbox (`git ls-remote`) without saving settings or touching the managed directory.
  It is app-page-only, supports an optional remote (defaults to `origin`), and returns ref counts plus
  redacted warnings. A stopped app is `409 not_running`; a container or managed directory that predates
  the feature is `409 restart_required`.

## SSH host access

- Global operator-defined hosts live in `ssh_hosts` with an AES-256-GCM-sealed private key in
  `ssh_host_credentials`; the private key is never materialized into the app container, its HOME,
  the runtime spec, `OPENCODE_CONFIG_CONTENT`, logs, or tool results.
- Access is strictly per application through `app_ssh_hosts` (no project inheritance). The app token
  selects the app; every call re-checks the allowlist. Hosts are added on the `/ssh` page with a
  write-only key, a Test connection (which pins the host key after successful authentication), and
  an optional "ask for approval" switch.
- The `hanse` MCP server exposes `ssh_list_hosts`, `ssh_exec`, `ssh_upload`, and `ssh_download`.
  Commands are arbitrary and non-interactive; upload/download use SFTP with a 50 MiB cap, a 300 s
  transfer deadline, local dirfd-relative path confinement, remote `remote_root`/`realpath`
  checks, and atomic writes.
- `require_approval` hosts need an idle-based `(app, host)` grant (30 min idle, 8 h absolute). The
  first request appears as an app-scoped card in the chat workspace, which polls the approval API
  every 5 s; the operator can approve or reject there or on `/ssh`. Pending approvals expire after
  5 minutes; a tool waits 30 s, then returns `ssh_approval_pending`.
- Host keys are pinned automatically on the first authenticated connection (TOFU); a mismatch fails
  closed, records `host_key_mismatch_at`, and requires an explicit Test + re-pin. The pending
  observation lasts 10 minutes. Changing `address`/`port` clears the pin.
- Every operation is audited in `ssh_audit` (pre-insert, `finally`, orphan `interrupted` on startup);
  host CRUD, test, re-pin, grant revocation, and approval decisions are audited too. Audit rows
  survive host/app deletion.
- Human-only API/UI: `/ssh`, `/api/ssh/hosts`, `/api/ssh/approvals/count`,
  `/api/projects/:projectId/apps/:appKey/ssh`, `.../grants/:id/revoke`,
  `/api/apps/:app/ssh/approvals`, `.../decision`, and `/api/apps/:app/ssh/audit`; agent tokens get
  `403`. The only agent-facing route remains `/internal/mcp`.
- The `hanse` MCP entry carries `timeout: 600000`; existing agents must be restarted (no image
  rebuild) to see the tools and the timeout.
- Migration v8 (`setting_secrets`, drop legacy `secrets`) and migration v9 (SSH tables) apply in
  order; migrations v10 (applied settings/profile state), v11 (deletion markers), v12 (skills),
  v13 (skill bundles), v14 (session-bound handoffs, reply routing, and handoff policy), and v15
  (chat drafts, session state, and pending sends) and v16 (file-only attachments and deliveries)
  follow. The current schema versions are `[1..20]` (v17 adds handoff message-id lookup indexes;
  v18 adds agent image validity; v19 adds the global custom model provider registry; v20 adds the
  process-rule hash, runtime epoch/exit fields, and the session resume/notice tables).
- Live on `deployment-host` (`sha-e2d89a2`): a temporary SSH target pinned and authenticated, an approval was
  approved, `echo QA_OK` and a 65 s `sleep` succeeded, upload/download round-tripped, a real
  `opencode` turn called `hanse_ssh_exec` and received the result after 65 s, and audit rows survived
  host deletion.

## Agents and chat

- `opencode` (`opencode-ai@1.19.3`) is installed in the agent and IDE images.
- The coordinator asks the runner to **ensure one app container per (project, app)** lazily on first
  chat use. The runner creates the container, app network, app/agents bind mounts, and coordinator
  network alias. `opencode serve` listens on `0.0.0.0:4100` inside the app container, with isolated
  `XDG_*`, `OPENCODE_DB`, and `TMPDIR` under
  `/data/agents/<projectId>/<appKey>/{home,data,state,config,cache,tmp,mise}`. The app `auth.json`
  and opencode password live in that per-app state; model access works (verified with `deepseek`).
- Every managed instance also loads the image-baked OMO baseline
  (`oh-my-openagent@5.1.35`, `/opt/hanse/omo`) through `HANSE_OMO_PLUGIN`. The coordinator writes a
  per-app profile at `<app-home>/.omo/omo.jsonc` and pins OMO agents/categories to
  `deepseek/deepseek-flash`. Per-project/per-app MCP and plugin inheritance is not implemented yet.
- Every managed instance also gets the codegraph MCP server
  (`@colbymchenry/codegraph@1.6.2`, `/opt/hanse/codegraph`) through `HANSE_CODEGRAPH_BIN`. The
  application must be indexed with `codegraph init` (creates `.codegraph/`) before graph queries
  return data.
- Every managed instance gets a coordinator-owned process-safety instruction at
  `<app state>/hanse/agent-process-rules.md`, appended to `OPENCODE_CONFIG_CONTENT.instructions`.
  The file tells the agent never to signal/kill the opencode server or its process group, and to
  inspect it only through a disposable separate instance. A sidecar
  `agent-process-rules.applied.md` plus `instances.applied_rule_hash` preserve the content actually
  applied by the last explicit start; a missing/mismatched sidecar restores the current rule and
  keeps the app `Restart required`. The file is agent-writable and the instruction is a guardrail,
  not a sandbox.
- The permission overlay adds deny-only `bash` patterns for `pkill *opencode*`,
  `killall *opencode*`, and `kill` against PID 1/the process group (including `kill 0`); there is
  no broad `kill *` deny and no `bash` catch-all. `ATTACHMENTS_POLICY_VERSION` is 3. `/agent`
  verification requires every non-hidden agent, including subagents, to resolve all probes to
  `deny`; warnings are visible through the existing policy path but are warning-only. Wrappers,
  scripts, app-owned config/plugins, v1 `always` approvals, and v2 saved allows can widen the final
  ruleset.
- The coordinator records the runtime epoch (`started_at`, `restart_count`) and the last exit/OOM/
  stop-intent fields on `instances`. A busy/retry session is tracked in `session_resume`; terminal
  idle/error is confirmed after 5 s with `GET /session/status` and a live runtime status probe.
  Completed tails clear the marker; an unfinished tail with a changed/failed epoch is preserved as
  shutdown-induced. Detection never starts an app.
- Process interruptions are persisted in `session_notices` (latest 50 per session, deduped by
  epoch/cycle) and rendered inside the ordinary chat log as full-width break rows interleaved by
  timestamp with messages. `GET /api/apps/:app/sessions/:sid/notices?limit=&before=` is DB-only and
  works while the app is stopped; `notice.created` is an app-SSE frame. Operator restart/stop,
  external restart/stop, deployment, crashes, and child aborts are distinguished; a completed tail
  produces no interruption notice.
- Auto-resume applies only to top-level sessions with an interrupted busy/retry cycle, an
  unfinished tail, no newer user turn, and a 30-minute TTL. It requires an already-running/ready
  runtime, never calls `ensure`, and makes one automatic attempt (with one provably-not-sent
  dispatch retry). It sends one synthetic continuation prompt with
  `metadata.hanse="agent-resume"`; the client hides that part and shows a `resume_started` notice.
  There is no manual Resume route and no child auto-resume. A stopped app is never auto-started;
  the operator starts it and sends a normal message. Lease expiry first re-checks the session tail:
  a finished resumed turn settles as `completed` (`resume_completed`) and a newer user turn as
  `superseded`; only a genuinely unconfirmed outcome leaves an `ambiguous` notice, shown as
  "Agent resume unconfirmed". The client shows the persisted state.
- Chat read routes (`/sessions`, `/messages`, app SSE, `/prompts`, `/saved-permissions`, `/todo`,
  `/context`) never start a stopped app. They return `503 {error:"agent is stopped",
  code:"agent_stopped"}` when no attached endpoint exists; the client renders a stopped shell with
  notices and an explicit Start action, and keeps a cached feed on reload. Sending a message and the
  explicit Start action remain the only starters.
- Stage 0030 is deployed to `<deployment-host>` as `25e5c81`; readiness reported schema version
  20, migration 18 -> 20, restored running apps, and a passed disposable process-protection smoke.
- Our chat UI (`/chat?app=<appKey>&project=<projectId>`) lists/filters sessions, streams assistant
  text and running tool output, renders tool calls (output/error/previews), reasoning, patches,
  syntax-highlighted `edit`/`apply_patch` diffs, `write` content, and completed `read` output
  (parsed path, line numbers, code, and status footer), GFM pipe tables, and OMO system cards, and
  sends prompts optimistically. Built-in coordinator tools are rendered from their JSON results:
  normalized `hanse_*` names and glyphs, SSH exec (host, command, exit code, stdout/stderr),
  transfers, host lists, handoff requests/status/replies, skill lists/mutations, previews, managed
  web search/fetch, and master tools; unknown JSON falls back to pretty-printed JSON instead of a
  raw one-line string. Handoff-dispatcher messages are annotated by the coordinator
  (`info.hanse.handoff`) and render as a sender-agent card with the request/reply body as safe
  Markdown; they are excluded from the operator queue. Diff highlighting is lazy and open-only: a checked-in
  PrismJS 1.30.0 bundle runs in a module Web Worker with a 250 ms per-stream budget, 8/64 KiB
  language-aware stream caps, a 120k-node page budget, and plain fallback. Diffs are capped at
  64 KiB per file / 128 KiB total / 50 files / 2,000 rendered lines; highlighting is hunk-local and
  does not see code before a hunk. The optional `project` query is additive and disambiguates
  duplicate app keys. API:
  `GET/POST /api/apps/:app/sessions`, `DELETE /api/apps/:app/sessions/:sid`,
  `GET/POST /api/apps/:app/sessions/:sid/messages`,
  `GET .../sessions/:sid/notices`, `GET/PUT .../sessions/:sid/draft`,
  `POST .../sessions/:sid/touch`, `POST .../sessions/:sid/delete-if-empty`,
  `POST .../sessions/:sid/pending/:pid/retry`, `DELETE .../sessions/:sid/pending/:pid`,
  `POST /api/apps/:app/attachments`, and `GET/PATCH/DELETE /api/apps/:app/attachments/:id`;
  all accept `?project=<projectId>`.
  `GET .../messages` accepts optional `limit` (1..200) and `before` (an opaque upstream cursor);
  with `limit` it returns `{messages, nextCursor}` and the chat opens a 30-message tail. Without
  `limit` the legacy `{messages}` full-history response is unchanged.
  `POST .../messages?async=1` accepts `{text?, attachments?}` and returns
  `202 {accepted, messageID, sessionID, warnings?}` without waiting for the turn. The blocking route
  returns `200 {messageID, userMessageID, info, parts}` (assistant `messageID` + generated user
  `userMessageID`), with projected parts under 8 MiB or `{messageID, userMessageID, info:null,
  truncated:true}` on overflow. Async text is capped at 32 KiB; an older upstream without
  `prompt_async` returns `502 async_unavailable`, and the blocking route remains available.
- The sessions rail (17rem wide) groups `opencode` subagent sessions by their authoritative
  `parentID` under the parent row, built client-side from the unchanged flat session list. Children
  are reached with a disclosure chevron (collapsed by default, multi-level nesting) and the active
  session's ancestor branch is expanded automatically, including `?session=<child>` deep links. A
  collapsed parent shows one aggregate waiting count over its own and its descendants' sessions;
  children keep their own counts. Deleting a parent removes the whole subtree and clears Hanse
  session-scoped chat state (drafts, attachments, deliveries, pending sends, `session_state`, and
  the session folder) for its descendants, best effort under opencode's 100-session window.
  Session lifecycle is not realtime in this stage: child sessions appear on the existing refresh
  triggers (boot, focus, visibility, selection, send, idle/reconnect).
- Session switching is optimistic and cancelable: the rail, title, URL, and message skeleton switch
  immediately, the previous draft is flushed in the background, the in-flight message/history read is
  aborted, and a selection generation makes the last click win. `GET /sessions`, `GET /messages`,
  `GET .../todo`, `/prompts`, `/saved-permissions`, and `/context` attach to an already running agent
  through `endpointFor` and never start a stopped one; a missing endpoint returns `agent_stopped`
  and the client shows the persisted notices plus a Start shell.
- The chat composer has one slash-command palette (`/` at the start or the `Commands` button). It
  merges opencode's v1 `GET /command` catalog with six Hanse actions; custom
  `.opencode/command(s)`, JSON commands, MCP prompts, and skills appear automatically.
  `GET /api/apps/:app/commands` returns display metadata only (never `template`): name, description,
  origin, hints, agent/model/subtask, a `none|present|unknown` shell flag, and availability.
  `POST /api/apps/:app/sessions/:sid/commands` forwards the exact name and raw argument string to
  `POST /session/:sid/command`, requires `confirmShell` for `present`/`unknown` (including blocks
  injected through arguments), and returns `202 {accepted, sessionID, name, messageID}` after a
  750 ms early-failure window; output arrives over the app SSE and post-dispatch failures are
  `command_failed`/unknown. Hanse actions are `/new`, `/help`, `/editor` (`/ide`), `/compact`,
  `/diff`, and `/restart`; `/model` and `/stop` are deferred and 25 TUI-local commands are skipped.
  `/diff` opens the application page `Changes` in a new tab (worktree-wide, not session-scoped);
  `/editor` and `/diff` are disabled for the master. Both routes are human-only; POST is JSON-only
  and rejects a cross-site `Origin`; GET degrades to Hanse-only while the app is stopped or the
  runtime is unconfigured. Hanse never expands templates, parses arguments, or executes shell blocks.
- Context usage is tracked server-side per running application by a background monitor that
  subscribes to opencode's `/event` stream and keeps per-session prompt tokens, model, status, and
  compaction state in memory (no DB row). Usage is `tokens.input + cache.read + cache.write` from the
  latest non-summary assistant step (`step-finish` authoritative, finished `message.updated`
  fallback). `GET /api/apps/:app/sessions/:sid/context` returns the context snapshot;
  `POST /api/apps/:app/sessions/:sid/compact` starts opencode 1.19.3 `summarize` with the last-used
  session model (effective `llm.model` only when hydration finds no assistant usage) and
  `auto:false`, returning `202`. Both routes are human-only. A missing model limit degrades to a
  token count. Auto-compaction is off by default, 80% when enabled, idle-only, top-level-only, with
  hysteresis, an ineffective latch, and a failure cooldown. opencode's built-in overflow compaction
  remains enabled. The chat thread meta has a context chip and the context rail has a meter,
  auto-compaction state, and `Compact now`; the coordinator keeps one extra opencode SSE connection
  per running app. After each `step-finish` the monitor fans the refreshed snapshot out to open
  browser streams as a `context.updated` frame, so the chip and meter move during a busy turn
  without an extra request per step; the HTTP snapshot remains the initial/fallback source.
  Sessions are hydrated lazily, and a coordinator restart resumes monitors for still-running
  instances.
- The app-level SSE (`GET /api/apps/:app/events`) carries typed frames
  (`stream.ready`, `message.updated`, `message.part.updated`, `message.part.delta`,
  `message.part.omitted`, `session.status`, `session.error`, `session.compacted`,
  `context.updated`, `session.activity`, `todo.updated`, `notice.created`, question/permission
  events, `stream.warning`) enveloped with `seq` and `streamID`. `stream.ready` starts at `seq: 0`;
  the client drops `seq <= lastSeq` per stream, hydrates on a new `streamID`, and schedules one
  reconcile on a gap or `frame_too_large`/`invalid_json`/`delta_too_large` warning. Caps: 8 MiB app
  SSE frame, 256 KiB typed event, 64 KiB delta/text snapshot/tool output/patch, 64 KiB per-file
  diff/write content/patch input, 128 KiB total diff per part, 50 file records, 1 KiB per path /
  16 KiB total paths, 8 KiB `truncated.fields`, and an 8 MiB `GET /messages` response
  (`502 messages_too_large` over cap; the client keeps its last feed and shows the too-large notice).
  `truncated.limit` distinguishes per-file/total/content/patch/output/files cuts.
- The feed is patched through keyed message/part nodes with one `requestAnimationFrame` flush:
  markdown re-renders at most every 50 ms while streaming (and once on seal/idle), running tool output
  at most every 100 ms (and once on completion), and the feed is never replaced on a token. Snapshot
  hydration seals completed messages, leaves only the last uncompleted assistant's text/reasoning
  unsealed, merges optimistic rows by server ID, and preserves open tool disclosures and scroll.
  The client loads a 30-message tail on open and prepends 30-message older pages when the thread is
  scrolled near the top; the scroll anchor is preserved and prepends never show the "New messages"
  affordance. Tail hydration merges by message ID and keeps loaded history; a provably disjoint tail
  (more than a page missed while disconnected) resets to a contiguous window. An older-page failure
  is terminal per kind (bad cursor, missing session, oversize) or retryable on the next top-scroll.
- A decorative in-feed generation row (`#chat-generating`) mirrors the active status label
  (`Sending`, `Thinking`, `Working`, `Running <tool>`, `Retrying`) and elapsed time inside the
  conversation. It is `aria-hidden` (the meta chip remains the live region) and honors
  `prefers-reduced-motion`.
- Send/queue behavior: a submitted prompt appears immediately as an optimistic operator row
  (`sending`, then `accepted` after the 202; `queued` while the agent is busy; `unknown` during the
  delivery-unknown grace). The queue strip above the prompt dock is derived from upstream history
  (last visible assistant `parentID`, `finish:"tool-calls"`/idle overrides, bare shells ignored), shows
  up to three one-line previews plus `+N more`, excludes the active head and OMO rows, and has no
  remove control. The status line appends `· N queued` only on the allowed labels.
- Status is derived from `session.status`, the latest part, and the queue:
  `Sending`, `Thinking`, `Working`, `Running <tool>`, `Waiting for you`, `Ready`, `Retrying`,
  `Paused`, with elapsed time that freezes while waiting and resets on `Ready`. Inline questions in
  the feed gate the composer and show `Waiting for you`; the top-bar/per-session counts include them.
- Upstream `session.error` is projected with a 2000-char first-line message (stack traces are
  dropped) and deduplicated per attempt (`session.status: busy` resets the dedupe). The client inserts
  an `Agent error` card into the feed, marks the active and queued prompts `Failed`, drops them from
  the queue, releases the composer, and settles the session to idle, so a failed turn never looks
  hung. A `MessageAbortedError` during an intentional Stop is the exception: it settles as `Stopped.`
  without the error card/toast, failed prompts, or queue drop (0025).
- The chat workspace renders GFM pipe tables (alignment, escaped pipes/code spans, 16-column and
  200-row caps, no raw HTML), one-line tool previews, a `todowrite` checklist, streamed bash output
  with a 64 KiB live-tail window and truncation notice, and collapsed `Thinking` reasoning. OMO
  internal/synthetic messages are classified client-side into system cards (markers and
  `<system-reminder>` tags hidden, long results collapsed) and are excluded from the queue; no
  server OMO field or persistence is added.
- Layout: at `>=1024` the feed and composer share one centered content box sized
  `min(100%, max(60ch, 75%))` with a `96rem` cap (about 75%, floor-driven ~87% at 1440, and 75% at
  1920); below 1024 both are 100%. The feed/composer share horizontal padding, tables/tool bodies use
  the full feed width, and assistant prose stays near a 68ch reading measure. There is no horizontal
  page overflow at 390.
- Mobile chat polish (0025): the chat page alone sets `interactive-widget=resizes-content`; a
  `visualViewport` inset drives `--chat-keyboard-inset` on the chat shell, and a scale guard avoids
  treating pinch zoom as a keyboard. Coarse-pointer textareas use 16px, plain Enter inserts a newline,
  and tapping Send no longer moves focus out of the composer. The primary button is the sole
  `composerAction` renderer: it becomes Stop when the composer is empty and `session.status` is
  `busy`/`retry`, and Send otherwise.
- Stop/interrupt: `POST /api/apps/:app/sessions/:sid/abort?project=<id>` is human-only, resolves the
  running endpoint with `manager.endpointFor` (never `ensure`), and maps not-running/deletion/upstream
  failures to `503`/`409`/`502`. An intentional `MessageAbortedError` is suppressed (no Agent error
  card, toast, failed prompts, or queue drop); prompt docks are cleared/reconciled, and unanswered
  queued prompts remain queued behind a per-session block (mirrored to `sessionStorage`) so an idle
  session does not show a phantom `Working` turn. Context snapshots seed `session.status` after a
  reload; a real `idle → busy|retry` transition clears the block.
- Background stream recovery (0030): hidden-tab SSE errors do not consume the three-strike `Paused`
  budget; returning from hidden/bfcache, or going online, replaces a missing/`CLOSED` source (and a
  `CONNECTING` source after 5 s or any source after 10 s hidden) and hydrates prompts plus the last
  message page. Stale source handlers are detached before the replacement.
- Plan rail: the Plan section, its divider, and the `Plan N/M` chip are hidden until the active
  session renders at least one Todo; cached Todos survive a failed refresh (“Not updating”), and the
  Saved-permissions divider follows its section.
- Feed motion and reasoning: near-bottom following uses a 32px threshold and a cancellable rAF ease
  (instant on initial load/session switch and reduced motion); programmatic anchor/instant writes do
  not count as user intent, and history pagination is skipped while a smooth follow is active.
  Reasoning deltas use the server-provided `partType` (an unknown-type early delta is dropped rather
  than rendered as text), and an in-progress reasoning block shows a live elapsed value frozen at
  completion. The request elapsed timer starts only from the assistant `time.created` (activation is
  the fallback), so a page reload never starts it from page-open time.
- Policy diagnostics: `/prompts` filters `policy_unverified:` warnings (verification failure/timeout)
  from the chat banner while keeping real policy findings; the manager logs the stripped diagnostic
  once per start.
- Sessions are created lazily, but eagerly on the first non-empty, non-slash composer input (400 ms
  debounce; no prompt is dispatched), so a text draft survives reload as a real upstream session.
  Migration v15 adds `message_drafts`, `session_state`, and `pending_sends`. The human-only draft
  API is `GET/PUT /api/apps/:app/sessions/:sid/draft`, `POST .../touch`,
  `POST .../delete-if-empty`, `POST .../pending/:pid/retry`, and `DELETE .../pending/:pid`; it
  persists LWW drafts (32 KiB text; 256 KiB HTTP body cap), adds `draft {hasText, attachmentCount,
  emptyDraft, updatedAt}` to `GET /sessions`, and never starts a stopped app for metadata
  operations. A reachable upstream session with no state row is upserted with `has_messages=1` on a
  first PUT/touch; an existing Hanse-created `has_messages=0` row is preserved.
- Clearing the last draft auto-deletes an empty Hanse-created session after a ~1 s debounce; the
  server re-checks `session_state`, draft/pending rows, and a one-message upstream page, and fails
  closed on 5xx/transport. Sessions with history are never auto-deleted. A daily sweep removes
  empty Hanse-created sessions after 7 days of inactivity, using the same fail-closed check and
  never starting a stopped app. `touch` protects an unflushed draft from the sweep.
- Every send creates a durable `pending_sends` row before dispatch and deletes the draft in the
  same transaction under a per-session lock. A 202 is confirmed by the user-message event or a
  bounded 0/2/5/10/20/30 s read schedule; `session.error` (except `MessageAbortedError`) marks every
  `sending` row in that session `unknown`; a final definite 404 becomes `failed`; 5xx/transport
  remains `unknown`. Failed rows offer Restore/Retry, unknown rows offer Retry anyway/Dismiss, and
  only explicit Retry can dispatch a new message (force requires a duplicate-risk confirmation).
  When the context monitor is not connected, one shared per-app `/event` fallback subscription is
  opened before dispatch. The session rail shows `Draft` (or a dot for a session with history).
  A client `session.error` marks only the local unsent acceptance row failed, not server-backed
  queued/active rows.
- File-only attachments (Stage B of plan 0026) live under
  `<agentsHome>/<sanitize(project)>/<sanitize(appKey)>/attachments/<session>/<id>-<safeName>` and are
  streamed through `POST /api/apps/:app/attachments` (raw body, `Content-Disposition` filename,
  100 MiB/file, 25 MiB image, 5 GiB/app, 2 concurrent, 256 MiB global in-flight). Files are
  sniffed, name-sanitized, committed to `app_attachments`, downloaded with `O_NOFOLLOW` + size
  verification, and removed with the session/app. The model-visible path is
  `/data/agents/<project>/<app>/attachments/...` in runner mode (nested read-only bind, policy
  trusted root, spec-hash marker) and the host agents path in supervisor mode (weaker: the agent
  shares the host filesystem). Uploads/reconciles are crash-safe: startup settles `uploading`
  rows, `.tmp`/orphan files are swept, and missing files become `missing` and are excluded from
  prompts/quota.
- The chat composer has an attach button, hidden file input, drag/drop, and paste staging; chips show
  progress/retry/remove and a file-only/Auto mode control. Draft GET returns attachments + quota;
  sessions list `draft.attachmentCount`; sends accept `{text?, attachments:[{id,mode?}]}` (empty text
  allowed iff attachments; max 10, 250 MiB), create `attachment_deliveries` in the same transaction
  as the pending row/draft delete, and add a hidden synthetic `attachment-manifest` text part with
  the model-visible path. A pre-existing default title is PATCHed before an attachment send;
  failure is `409 title_required` with no pending/draft mutation, and attachment-first sessions use
  the neutral `Attachment` title.
- Inline media (Stage C): at send time the coordinator resolves the effective model's
  `capabilities.input.{image,video,pdf}` + `capabilities.attachment`; supported image/PDF/video under
  20 MiB is sent as a `FilePart` with a unique `prt_att_<attachmentId>_<deliveryId>`, MIME,
  filename, and `file://` model-visible URL (never base64 in the JSON). Inline mode has 4 attachments
  and a 40 MiB raw-base64 budget; unsupported/unknown/oversize modes fall back to file with
  `attachment_inline_unsupported`/`attachment_capability_unknown`/`attachment_inline_too_large`,
  and a non-blocking `attachment_context_large` advisory. File-only kinds stay file. History and
  the app stream project known file parts to short download URLs and strip every unknown `data:`
  URL; `info.hanse.attachments` carries all deliveries. History reads use 48 MiB page/per-message
  caps, a 192 MiB heap-aware budget (2 s wait, then `503 history_busy`), single-message fallback,
  and an 8 MiB projected response. The app SSE frame cap is 32 MiB with a 32 MiB raw/96 MiB heap
  budget and 8 browser streams/app (`429 stream_limit`); internal monitor/fallback streams are a
  separate class, and an active sender's `streamID` is prioritized. The legacy session SSE is
  human-only, projected, and never forwards a `data:` URL. The bundled IDE extension uses
  `?async=1`, a 30-message tail, merges attachments, hides the manifest, renders file-only cards,
  and bounds post-202 reads.
- Deletion is human-only (`403` for agent principals), proxies opencode `DELETE /session/:id`, and
  the UI selects the next session or returns to the draft when the active one is removed.
- The chat workspace renders interactive opencode prompts above the composer:
  - **Questions** support one or many questions, options, multi-select, custom answers, review, and
    dismissal. Questions correlated to a `question` tool part render inline at that part (and become
    read-only Q&A cards after completion); uncorrelated questions stay in the dock. Empty answers are
    allowed after an explicit "Send without answering?" confirmation. Single-select questions in a
    multi-question block auto-advance with focus and one announcement; multi-select does not
    auto-advance, and a single-question block does not auto-submit. Custom-answer Enter submits the
    current step once.
  - **Permissions** show the type, patterns, bounded metadata, and `once`/`always`/`reject` with
    optional feedback. v1 `always` lasts for the app instance until restart; v2 `always` is a durable,
    project-scoped saved permission. A reject also rejects other pending permissions in the same
    session.
  - Prompt sources are v1 and v2 (`source` on every request/reply); v2 replies use the
    session-scoped upstream routes. `tooLarge` requests are dismiss-only.
  - The session **Plan** panel shows opencode's Todo list in the context rail (with a `Plan N/M`
    chip below 1360), updates on `todo.updated`, and is read-only. It is hidden until the session
    renders its first Todo. v2 saved permissions are listed and revocable in the context rail.
  - A top-bar stamp/count surfaces requests waiting in other sessions of the same app, with
    per-session flags in the sessions rail. Policy warnings from `/prompts` render as a banner/chip;
    `policy_unverified:` verification diagnostics are filtered out (0025).
- API for prompts, Todo, and events (human-only; agent principals get `403`):
  `GET /api/apps/:app/prompts`, `POST /api/apps/:app/questions/:id/reply|reject`,
  `POST /api/apps/:app/permissions/:id/reply`,
  `GET/DELETE /api/apps/:app/permissions/saved[/:id]`,
  `GET /api/apps/:app/sessions/:sid/todo`, `POST /api/apps/:app/sessions/:sid/abort`, and the typed
  app-level SSE `GET /api/apps/:app/events`; all accept `?project=<projectId>`. The old raw
  `GET /api/apps/:app/sessions/:sid/events` remains for compatibility but is no longer used by the
  chat client. The typed app SSE keeps its heartbeat, backpressure, and `session.activity`
  compatibility frames for older clients.
- Every managed instance receives an explicit permission overlay (`OPENCODE_CONFIG_CONTENT`):
  `external_directory` is allow-all, with explicit denies for the credentials mounted into the app
  container (provider `auth.json`, the managed git credential directory, the per-app MCP token, and
  the opencode server password); trusted runtime roots (tool-output, git repos cache, temp,
  per-instance config/cache skills, `~/.claude/skills`, `~/.agents/skills`, bundled plugin skills)
  are still listed as allows for compatibility; `question`, `todowrite`, `todoread`, `webfetch`,
  `websearch`, and `.env` read/write are allowed; `.opencode` config/plugin edits are denied;
  `doom_loop` asks. The
  coordinator strips its own credentials (`HANSE_OPERATOR_TOKEN`, `OPENCODE_PERMISSION`, etc.) from
  the instance environment and sets `GIT_CEILING_DIRECTORIES` to the app's real parent so a nested
  app cannot inherit a wider parent worktree. Effective rulesets are verified after start with a
  **warning-only** result (no startup block). For built-in web drivers `webfetch`/`websearch` remain
  allowed; a managed search/fetch driver denies the corresponding built-in and allows
  `hanse_web_search`/`hanse_web_fetch`.

## App previews (demo)

- An app agent can expose an HTTP service running inside its own container to the operator with
  `preview_open`/`preview_close`/`preview_list` on the `hanse` MCP surface. The tools are app-token
  bound; the only target input is a port. `preview_open` requires the app to be running, accepts
  `key` (lowercase slug), `name`, and `port` (`1024..65535`, not `4100`), and returns the URL plus
  `base_path`/`base_path_without_trailing_slash` and `operator_host`/`operator_hostname`.
- Previews are app-scoped and in memory: max 8 per app, 2-hour absolute TTL with lazy pruning,
  upsert by key, explicit close, and no persistence across a coordinator restart. Stop, restart,
  deletion, out-of-band reconcile, and container recreation clear the app's previews.
- The operator opens `/preview/<projectId>/<appKey>/<key>/...`; the route is cookie-only (like
  `/ide`), forwards the full path and query unchanged, and proxies HTTP and WebSocket to the app
  container on its own network. The proxy streams both directions, strips `cookie`/`authorization`
  upstream, drops origin-wide response headers (`set-cookie`, `clear-site-data`,
  `service-worker-allowed`, HSTS, `alt-svc`, `report-to`, `reporting-endpoints`, `nel`,
  `www-authenticate`), and uses a 64 KiB/allowlist filter on the WebSocket 101. The WebSocket
  upgrade also checks `Origin` host = `Host` (absent allowed).
- The app must serve under the returned base: Vite `base = base_path`; Next
  `basePath = base_path_without_trailing_slash` plus `trailingSlash: true`, with
  `allowedHosts`/`allowedDevOrigins` from `operator_hostname`. The proxy does not rewrite
  HTML/CSS/JS.
- The chat tool card gets an always-visible `Open preview` action on a completed success result, and
  the context rail renders a `Previews` block only while the app has active previews. The operator
  can close a preview from the rail; the block and divider disappear when the list empties.
- Demo-only: previews are served from the coordinator origin, so the previewed app shares the
  operator's session. This is an accepted residual risk for the MVP, not a security boundary. The UI
  carries a persistent demo warning and links use `noopener`.
- Runner-mode only: `HANSE_RUNNER_URL` must be configured. In supervisor mode the MCP tools return
  `preview_unavailable`, the list/close API returns `503`, and no preview UI is shown.
- Human-only API: `GET /api/apps/:app/previews?project=...` and
  `POST /api/apps/:app/previews/:key/close?project=...`.
- Tests: `test/preview-service.test.ts`, `test/preview-mcp.test.ts`, `test/preview-http.test.ts`,
  `test/preview-proxy.test.ts`, `test/chat-page.test.ts`, and `test/manager.test.ts`; browser
  evidence is in `docs/design/artifacts/previews/`.

## Settings and web tools

- Human-only settings pages: `/settings`, `/projects/:id/settings`, and
  `/projects/:id/apps/:appKey/settings`. Values resolve global -> project -> application. Missing
  rows inherit; `null`/`cleared` is an explicit empty override. `llm.model` is a non-clearable scalar
  with default `deepseek/deepseek-flash`; `web.search` and `web.fetch` default to `{driver:"builtin"}`
  and are clearable. `context.auto_compact.enabled` (default `false`) and
  `context.auto_compact.percent` (default `80`, integer 1..99) are non-clearable live settings.
  `git.user.name`/`git.user.email` are clearable strings (default `null`).
  Every page uses a sticky scope/section nav, five section cards (Agent, Web tools, Context, Git,
  Restart & pending), and one collapsed setting row per setting. Rows show effective value and source
  at rest; editor, scope history (`Scope details`), warnings, and actions are disclosed on demand.
  Saves are live: all settings mutations from `settings.js`/`git-settings.js` request
  `x-hanse-fragment: settings`, and the server returns only the affected section HTML plus the
  warnings/restart state. The client swaps those sections in place, restoring open rows, other-row
  drafts, focus, scroll, and the URL hash, so a successful save does not reload the page. Context
  settings are excluded from the launch settings hash, so changing them never marks a running agent
  restart-required. Non-Git
  forms still fall back to redirect + toast without JS; Git credential forms remain JSON-only and
  JS-required.
- `settings` and `provider_keys` live in `coordinator.db` (migration v3). Provider API keys are
  entered in the settings UI, AES-256-GCM encrypted, and never returned. At instance start the
  coordinator reconciles the host `auth.json` with effective provider keys into the per-instance
  `auth.json` (mode 0600), scrubs inherited `OPENCODE_AUTH_CONTENT`/profile env, and removes stale
  entries.
- Custom model providers live in the global `model_providers` table (migration v19). An operator
  adds an OpenAI-compatible provider under Settings -> Custom model providers with an id, display
  name, base URL, and 1-64 models (`context`/`output` limits). The coordinator projects every
  validated provider into `OPENCODE_CONFIG_CONTENT.provider` with the bundled
  `@ai-sdk/openai-compatible` adapter; the API key stays in `provider_keys`/`auth.json`.
  `llm.model` remains a free-form `provider/model` string with a datalist of custom models. The
  registry is capped at 32 providers, the provider projection at 48 KiB, and the final overlay at
  64 KiB. Adding or editing a provider marks running apps restart-required; a new provider id appears
  in the Providers key block with `Missing`. Deleting a provider referenced by any `llm.model` row
  returns `409 provider_in_use`. Warnings cover common bundled ids, existing key rows/host auth,
  loopback base URLs, and non-loopback plain-`http` URLs. Project/app provider definitions, model
  auto-discovery, arbitrary npm adapters, custom headers, and provider enable/disable are not
  implemented.
- Git credentials live in `setting_secrets` (migration v8), AES-256-GCM encrypted with the same
  `secret.key`. One SSH credential (`privateKey` plus optional `knownHosts`) and one HTTPS credential
  (`hosts`, `username`, `token`) may be set per scope; a narrower scope replaces the whole credential
  object. `POST /api/settings/git` handles set/clear/inherit, returns status metadata only (public
  key/fingerprint/hosts/username, never the private key, token, or known-hosts body), and `GET
  /api/settings` and the settings pages expose the same status-only view. `cleared` is a tombstone
  that stops inheritance. The legacy `secrets` table and its unused helper were dropped.
- On instance start the coordinator materializes the effective identity and credentials into
  `<app>/home/.config/hanse/git/` (`config`, `ssh`, `askpass`, and, when configured, `id`,
  `known_hosts`, `token`, `username`, `https_hosts`; dirs 0700, secrets 0600, wrappers 0700). The app
  env contains paths only (`GIT_CONFIG_GLOBAL`, `GIT_SSH_COMMAND`, `GIT_ASKPASS`,
  `GIT_ASKPASS_REQUIRE=force`, `HANSE_CREDENTIALS_DIR`). A settings change is applied on an explicit
  agent restart; the existing `pendingRestart` marker covers secret-only changes because
  `settingsHashFor` includes `gitAuthHash`.
- Web drivers are selectable per tool: `builtin` (OMO `websearch` MCP for search, opencode
  `webfetch` for fetch) and `deepseek` (standalone `/v1/tools/search` and `/v1/tools/fetch`). A
  managed driver disables the corresponding built-in: search adds `websearch` to the OMO profile's
  `disabled_mcps` and denies the permission; fetch denies `webfetch`. The `hanse_web` stdio MCP
  server is registered only when at least one managed tool is configured and exposes `search`/
  `fetch` (opencode names them `hanse_web_search`/`hanse_web_fetch`).
- The selected model is written to `OPENCODE_CONFIG_CONTENT.model` and to an app-specific OMO
  profile under `~/.omo/omo.jsonc`, selected with `OMO_PROFILE`. The profile pins every OMO
  agent/category and carries `disabled_mcps`; it is applied at instance start. A post-start `/agent`
  check records a warning when an agent reports a different model (for example through a project
  `.omo` layer).
- Settings never auto-restart an agent. Running instances record the effective settings/auth/profile
  hash and `appliedProfile`; the app, chat, and settings surfaces show "Restart required" and a
  restart action. Chat prompts carry the effective `llm.model`, so existing sessions switch model on
  the next message; OMO subagents use the profile and change only after a restart.
- CLI: `hanse web-mcp` runs the managed web tools MCP server (internal; spawned by opencode).
- API: `GET/POST /api/settings`, `POST /api/settings/provider`,
  `GET/POST /api/settings/model-providers`, and
  `POST /api/apps/:app/restart?project=<id>`; all human-only. Settings responses include effective
  values, sources, raw scoped rows, provider statuses (never key material), warnings, and pending
  restarts.

## Agent skills

- Human-only inventory pages `/skills`, `/projects/:id/skills`, and
  `/projects/:id/apps/:appKey/skills`, plus the dedicated `GET /skills/new` and `GET /skills/:id`
  workspace. The JSON API is `GET /api/skills?project=&app=`, `GET /api/skills/:id`,
  `POST /api/skills` (`create`/`override`), `POST /api/skills/:id`
  (`update`/`discard`/legacy `delete`), `POST /api/skills/:id/delete`, and
  `DELETE /api/skills/:id`. Agent principals receive `403`; every mutation rejects a cross-site
  `Origin`; `return_to` and `from` are validated local scope paths.
- Skills live in the coordinator DB tables `skills` and `skill_references` (migration v13), not in
  `.hanse/` manifests or repositories. `skills` rows are keyed by
  `(scope, project_id, app_key, name)` with empty strings for wider scopes, and add nullable
  `license`/`compatibility` plus a `metadata_json` string map. `skill_references` stores a canonical
  `references/<slug>.md` path and content with `ON DELETE CASCADE`. App deletion removes app-scope
  rows, project deletion removes all rows for the project, and global rows (`project_id = ''`)
  survive.
- A skill is a bundle: a generated `SKILL.md` plus zero or more flat `references/<slug>.md` files.
  The slug is 1-64 lowercase-hyphen characters, the full path 15-78, with at most 20 references,
  48,000 characters each and 192,000 aggregate. The body is 48,000 characters; `description` may
  contain newlines; metadata is a string-to-string map with the known family keys and preserved
  custom keys. The generated frontmatter emits `name`, description, optional `license`/
  `compatibility`, then metadata in deterministic order with JSON-quoted scalars.
- Effective resolution runs global -> project -> application by name, and the narrowest **valid**
  row wins. An invalid-name row is not a resolution candidate but remains in the inventory for
  repair; invalid metadata, invalid references, or invalid bundle bounds make the row ineligible,
  so a wider valid row can win. A disabled narrower row is a tombstone that hides an inherited
  skill; a narrower enabled row re-enables it. Invalid rows stay visible as `Invalid here`, or as
  `Invalid local override` when a wider valid row is effective; the workspace shows the issues and
  the appropriate repair mode. `SkillWarning` remains limited to collision/resolution conditions;
  stored-row issues are `SkillStoredIssue` entries.
- Each instance receives
  `<agents>/<project>/<app>/config/opencode/skills/<name>/SKILL.md` plus
  `<name>/references/<slug>.md` files. The legacy `config/opencode/skill/` alias is emptied, the
  whole effective bundle is rebuilt from the DB (references first, `SKILL.md` last), unexpected
  entries are removed without following symlinks, and the `cache/opencode/skills` root is untouched.
  Repository `.opencode/skills` is never modified.
- The first apply for an instance moves pre-existing entries outside the effective set in the
  Hanse-owned roots to `config/opencode/skills-replaced/` and writes
  `.hanse-skills-initialized`; later applies remove unexpected entries. `skills-replaced/` is not
  cleaned up automatically.
- Start order is `probe` (a coordinator-private temporary directory outside the agent-writable
  tree) before any teardown, then `apply` after `runtime.delete` and before `runtime.ensure`. A
  probe failure leaves a running container untouched; a post-teardown apply failure persists the
  instance as `error`. Materialization failures surface as `skills_materialize_failed`. The manager
  refuses to start an application whose sanitized state segment collides with a sibling, so two
  apps cannot share a skills root.
- The effective hash includes `name`, `description`, `content`, and, only when non-empty,
  `license`, `compatibility`, `metadata`, and path-sorted `references`. A legacy single-file skill
  with no new fields keeps its pre-v13 hash and generated `SKILL.md` bytes, so upgrading does not
  mark agents restart-required. Adding or changing an effective bundle marks affected running apps
  `Restart required`; a shadowed or disabled row does not. Restarts are never automatic.
- `/api/skills*` routes accept up to 4 MiB request bodies, while the general server bound stays
  64 KiB. The extra room covers the bundle form and worst-case percent-encoding; per-field and
  per-bundle limits are enforced by the service.
- Collision scanning covers the app repository `.opencode/skill` and `.opencode/skills`,
  `<HOME>/.claude/skills`, `<HOME>/.agents/skills`, `<XDG_CACHE_HOME>/opencode/skills`, and
  `file://` baseline plugin `<root>/skills`, excluding the Hanse-owned config roots. Results are
  structured `skill_collision`/`skill_disabled_elsewhere` warnings, bounded to 20 with a
  `truncated` count. There is no precedence guarantee against those non-managed roots; the managed
  skill is still written.
- The inventory is server-rendered with scope navigation, search, `All`/`Defined here`/`Inherited`/
  `Disabled`/`Invalid` filters, one row per name, collision/issue indicators, and a restart rail.
  Inline editors and the old fragment contract are gone. The dedicated workspace shows the scope
  chain, metadata groups, references, and side-by-side source/preview at >=1024; below that it uses
  Source/Preview tabs and a file selector. Every Details field has a one-line hint and linked error
  description; a collapsible field guide gives short examples. The bundle form and danger zone use
  the normal stack gap. Save/discard are explicit, references and metadata are
  edited in the bundle form, and delete/override/disable/revert remain normal human-only forms.
  Without JavaScript metadata/license/compatibility/reference controls are disabled and unnamed,
  all file editors are stacked, and a hidden bundle snapshot preserves the bundle; the preview
  states that it requires JavaScript. `assets/markdown.js` is the shared safe renderer used by chat
  and the skill preview; `assets/skill-detail.js` drives the workspace. `assets/skills.js` and the
  old dialog editor are removed.
- Ordinary application agents can maintain their own app-scope skill bundles through the production
  app MCP surface (`/internal/mcp`, via the remote bridge): `create_skill`, `list_skills`,
  `get_skill`, `update_skill`, `set_skill_enabled`, and `override_skill`. The target is always the
  verified token's `(projectId, appKey)`; no tool accepts `scope`, `project_id`, `app_key`, or
  `confirm_global`, and sibling/global/project writes are refused. List and mutation results are
  content-free; `get_skill` returns a body only for effective rows or the caller's own app rows.
  Same-scope duplicates conflict, wider same-name rows are shadowed/overridable, and
  delete/revert/rename remain operator-only. Every mutation stores
  `updated_by = app:<projectId>:<appKey>` and one content-free `scope='app'` event, reports
  `pendingRestart`, and never restarts an agent. Human `/api/skills*` authorization is unchanged.

## Master agent

- One built-in master agent runs as the reserved project `hanse-master` and application `master`
  (`hanse-master:master`), created idempotently at coordinator start after project discovery. Its
  app directory is `<workspace>/.hanse-master`; its state is `<agents>/hanse-master/master`. It starts
  lazily on first chat use like any application.
- The reserved rows use the same runtime, settings, skills, OMO, context, token, and restart
  machinery as an application. `kind = 'master'` is display-only; the reserved ids are authoritative
  for dispatch, hiding, deletion refusal, and provisioning guards.
- The master app directory is mounted **read-only** inside its agent container through a new
  `appDirReadOnly` runtime-spec field (B1 runner bind `:ro`); its state directory stays read-write.
  The coordinator owns and rewrites `<workspace>/.hanse-master/AGENTS.md` on every start and passes it
  through the opencode `instructions` overlay. Git credentials are not materialized for the master;
  model-provider auth is, as for every agent.
- `/internal/mcp` dispatches a separate allowlist when the presented token resolves to
  `hanse-master:master`: `list_projects`, `get_app`, `get_settings`, `set_setting`,
  `inherit_setting`, `create_skill`, `list_skills`, `get_skill`, `update_skill`,
  `set_skill_enabled`, `override_skill`, `create_project`, `add_app`, `start_app`, `restart_app`,
  `list_dir`, `read_file`, `write_file`. SSH and handoff tools are rejected as `unknown_tool`; there
  is no fall-through. Failures return `{ok:false, code, message}` text content.
- Workspace file tools are workspace-relative and confined with realpath/symlink checks,
  `O_NOFOLLOW`, regular-file checks, 256 KiB read/write caps, 500-entry listings, UTF-8/NUL checks,
  and denials for `.git`, `.hanse/project.yaml`, `.hanse/app.yaml`, and the master `AGENTS.md`.
  Writes are atomic and recorded as `events` rows with `scope = 'master'` (path and size, never
  content).
- Project and application creation share `src/coordinator/provision.ts` with the web forms: reserved
  directory/id refusal, single-segment project directories, `isValidAppId` app keys, strict
  containment, symlink-safe manifest writes, YAML-serialized names, validated clone remotes
  (`http(s)`, `ssh`, `git`, scp-like; no local/file/userinfo/query/fragment), and clone-failure
  cleanup.
- Settings writes accept only the seven registry keys (no provider keys or git credentials), validate
  the target scope, and report pending restarts. `start_app` and `restart_app` refuse the master
  itself; a stopped app is not started by `restart_app`.
- `create_skill` creates an enabled bundle at global, project, or app scope through
  `SkillService.create`, with actor `master`. It accepts the same structured fields as the human
  form and reuses every service validation. Global scope requires `confirm_global: true` after the
  operator approves. Project/app targets must be registered and not deleting; the reserved master
  project/app is refused. A same-scope duplicate returns `skill_exists` with the existing row
  context; a narrower same-name row shadows a wider one. The create and its
  `master.skill_created` event commit in one transaction (audit failure rolls back the skill). The
  result reports `shadows`, `shadowedBy`, `appsInScope {total, running}`, and app-scope
  `pendingRestart`; it never echoes the body or reference contents. Creating a skill never restarts
  an agent.
- `list_skills` returns the effective set and rows defined at a global/project/app target without
  bodies or reference content; `get_skill` returns one full bundle including `metadataRaw` and
  `storedIssues`. `update_skill` edits description/body/license/compatibility/metadata/references by
  id and cannot rename or re-scope; `set_skill_enabled` toggles a tombstone;
  `override_skill` copies an enabled source into a project/app and requires `confirm_replace` when
  the exact target row exists. Global update/enable mutations require `confirm_global`. Master-app
  and deleting-target rows are readable but not mutable. Update/enable/override and their
  `master.skill_updated`/`master.skill_enabled`/`master.skill_overridden` events commit atomically;
  results report `effective`, `storedIssues`, shadowing, `appsInScope`, and app-scope
  `pendingRestart`, never content. Deleting, reverting/discarding, and renaming skills remain
  operator-only.
- UI: a **Master** navigation entry opens its chat. The master is hidden from the overview ledger,
  project index, sidebar project lists, `/api/projects`, and chat's default selection. Direct
  project/app/settings/skills URLs still resolve with a reduced master page (no git workbench or
  `/assets/git.js`, no image panel, no manifest card, no add-app/new-handoff controls, no danger
  zone). Settings and skills scope pickers intentionally list the master so it can be configured.
- Deletion is refused at the service and HTTP layers (`409 master_protected`) even when deletion is
  unconfigured. A discovered project may not use the reserved id, and no project or app may point at
  the reserved directory.
- `POST /internal/mcp` accepts up to 1 MiB so a maximum `write_file` fits; all other routes keep
  their existing limits. The stage adds no migration and no dependency.

## Handoffs (agent-to-agent requests)

- Coordinator MCP server: `hanse mcp` (stdio, bound to one app via `HANSE_DB`, `HANSE_PROJECT_ID`,
  `HANSE_APP_KEY`) or its remote bridge to `/internal/mcp`. The per-app opencode overlay
  (`OPENCODE_CONFIG_CONTENT`) registers it; tools: `request_sibling_change` (non-blocking),
  `list_apps`, `handoff_status`, `deliver_handoff`.
- A handoff is **session-bound**. The coordinator observes the app's existing `/event` stream through
  the context monitor and binds an agent request to the `sessionID` that invoked
  `request_sibling_change`; the agent cannot spoof this. The request then creates a fresh target session,
  sends a dispatch envelope (handoff id, source/target, summary, spec, reply protocol), and records the
  target session id.
- `deliver_handoff` is the target agent's reply callback (`outcome`: `completed`, `blocked`, or
  `failed`; free-text `result`) and is idempotent. The coordinator stores the result and, by default,
  injects a clearly marked `[Hanse handoff reply]` user message into the source session via
  `prompt_async`; the source agent continues in a new turn. The envelope marks the reply as untrusted
  sibling content.
- If the source session was deleted, or the handoff was created by the operator, the reply is kept with
  `reply_state = waiting_operator`. The operator can relaunch it in a new source-app session with an
  optional note, retry delivery to the known source session, cancel the reply, or cancel the handoff.
  A relaunch injects the original request, the target reply, and the note.
- Dispatch is durable and serialized per target application: at most one handoff is actively
  dispatching/running per target app; the rest wait in `queued`. The dispatcher runs inside the
  coordinator (5 s tick), starts a stopped target app, creates a session titled after the handoff, and
  enforces a 5-minute dispatch-start deadline, a 2-hour run deadline, a 10-minute source-binding
  deadline, and an 8-hop chain depth limit.
- Policy lives in the `handoff_policies` table (project default plus directed pair rules with `*`
  wildcards). Dispatch modes are `auto`, `approve`, and `deny`; reply modes are `auto` and `approve`.
  Precedence is exact pair > one wildcard > project default > built-in `auto/auto`. A rule always wins
  over the agent's `requires_approval` flag, which can only raise a request to approval; `deny` always
  wins. The policy is snapshotted on the handoff. The project page has the policy editor.
- `request_sibling_change` returns `{handoffId, status, state}` immediately (`queued`,
  `awaiting_approval`, or `denied`). A denied request is stored as `rejected` for audit.
  `handoff_status` is scoped to the calling application (source or target); `deliver_handoff` is accepted
  only from the target application.
- Handoff state machine: `queued`, `awaiting_approval`, `dispatching`, `in_progress`, `delivered`,
  `rejected`, `failed`, `expired`, `cancelled`. Reply routing is orthogonal: `none`, `pending`,
  `awaiting_approval`, `delivered`, `waiting_operator`, `failed`, `cancelled`.
- The dispatcher reuses the existing per-app context-monitor stream rather than opening a second SSE
  connection. If context monitors are disabled, source-session binding is unavailable and agent-created
  handoffs stay unbound (and are failed by the binding deadline).
- Operator UI: `/handoffs` has `All`/`Waiting`/`Active`/`Closed`/`Replies` filters, inline approvals,
  and a detail dialog with source/target session links, policy, outcome, reply state, and the
  relaunch/retry/cancel actions. The review/detail dialog is wide and renders the spec, result, and
  operator note as safe Markdown through the shared browser renderer. Project pages have a
  **Handoff policy** card.
- Human-only API: `POST /api/handoffs/:id/decision` (optional `approval_kind=dispatch|reply`),
  `POST /api/handoffs/:id/reply/relaunch|deliver|cancel`, `POST /api/handoffs/:id/cancel`,
  `POST /api/projects/:id/handoff-policy`, `POST /api/projects/:id/handoff-policy/delete`, and
  `GET /api/projects/:id/handoff-policy`. Agent tokens get `403` outside `/internal/mcp`.
- Not implemented: multi-turn negotiation (one reply per handoff), cross-project handoffs, worktree
  isolation between concurrent target sessions, automatic routing of the target's interactive
  questions, failure/rejection notifications back into the source session (the operator sees failed
  or rejected handoffs), and hard cancellation (there is no abort wrapper for an opencode turn; cancel
  is soft).

## Web IDE

- Bundled first-party extension `extensions/hanse-agent` (packaged as `extensions/hanse-agent.vsix`,
  installed via `code-server --install-extension`): an activity-bar view with a webview chat that has a
  tab per application, backed by the coordinator API.
- GitHub Theme is installed and `workbench.colorTheme = "GitHub Dark Dimmed"` is the default.
- The IDE opens the specific project/application via `/ide/?folder=<absolute path>` (per-app and
  per-project links in the dashboard). `?folder` outside the workspace is rewritten to the workspace
  root.
- The terminal uses `shell/hanse-shell`, which sets `HOME` to the opened folder, so `cd` stays in the
  project/application.
- VS Code cannot place an extension view in the Secondary Side Bar programmatically; the
  `Hanse: Move Chat to Secondary Side Bar` command opens the move picker (the layout then persists).

## Operator terminal

- Human-only `/terminal?app=<app>&project=<project>` page, linked from the application page.
- The coordinator proxies the WebSocket at `/api/apps/<app>/terminal?project=<project>` to the
  runner's `/v1/apps/<appId>/exec` with the runtime bearer token; the operator cookie is never
  forwarded and no token appears in URLs or HTML.
- The runner opens a TTY exec in the managed app container as uid 1000 with a fixed
  `/bin/bash -l` (or `/bin/sh -l` fallback) and bridges WebSocket frames to the Docker exec stream.
  Only managed app containers resolved by `appId` are reachable.
- Closing or reloading the terminal closes only the exec stream; the app container keeps running.
- The page is a full-height xterm.js 6.0.0 terminal (vendored, fit addon) with ANSI/alternate-screen
  rendering, a 1.0 line height, 5000-line scrollback with the viewport scrollbar hidden, Unicode 15
  grapheme-cluster widths (Unicode11 + graphemes addons), a light/dark theme from the design tokens,
  copy/paste, and FitAddon/ResizeObserver sizing. Output is binary frames; keyboard/paste input is sent as binary
  UTF-8 frames, while resize is a JSON control text frame applied through Docker's
  `/exec/{id}/resize`. The runner sets `TERM=xterm-256color`, `COLORTERM=truecolor`, and
  `LANG=C.UTF-8` for the exec.
- The client preflights `/api/apps/:app/runtime` before connecting and on Reconnect. A stopped/error
  agent renders an in-place `Agent is not running` state with Open chat/Reconnect; a runner 409 is not
  observable to the browser. Abnormal closes retry with 1/2/4/8/15s backoff; a normal shell exit does
  not auto-retry; manual Close keeps scrollback and never stops the container. Reconnect starts a new
  shell (the PTY is ephemeral), not a reattach to the old one.

## Data and state layout

Host `./state` is mounted at `/data/state` in `hanse` only:

- `hanse/coordinator.db` (+ `-wal`, `-shm`) - projects, apps, instances, tasks, handoffs, handoff
  policies, approvals, principals, events, settings, skills, provider keys, custom model providers
  (`model_providers`), and encrypted git credentials (`setting_secrets`).
- `hanse/secret.key` - AES-256-GCM key for the credential store and provider keys (mode `0600`).

Host `./agents` is mounted at `/data/agents` read-write in `hanse` and read-only in `hanse-runner`:

- `<projectId>/<appKey>/{home,data,state,config,cache,tmp,mise}` - per-app HOME/XDG, opencode DB,
  scratch, and mise toolchains.
- `<projectId>/<appKey>/config/opencode/skills/<name>/SKILL.md` - coordinator-materialized managed
  skills, rebuilt at each agent start. `config/opencode/skill/` (legacy alias),
  `config/opencode/.hanse-skills-initialized`, and `config/opencode/skills-replaced/` are also
  Hanse-owned per-instance state.
- `<projectId>/<appKey>/home/.config/hanse/git/` - coordinator-materialized git identity and
  credential files (`config`, `ssh`, `askpass`, and optional `id`, `known_hosts`, `token`, `username`,
  `https_hosts`). The app container can read this directory by design; the runner mounts it read-only
  into one-shot git containers.
- The reconciled opencode `auth.json`, opencode Basic-auth password, and per-app MCP token live under
  that app's state (`0600`).
- `<workspace>/.hanse-master/AGENTS.md` - the coordinator-owned master instructions. The directory is
  the master application's mount and is read-only inside that agent container; the coordinator
  rewrites the file on every start.
- The coordinator-generated OMO profile is `<app-home>/.omo/omo.jsonc`; OMO state is per app.
- Each app container sees only its own `/data/agents/<project>/<app>` root.
- The IDE never sees this volume.

## CLI

- `hanse init [dir]` - scaffold `.hanse/project.yaml`.
- `hanse status [dir]` - discover/register a project and print its apps.
- `hanse serve` - run the web UI/API (`--workspace`, `--hostname`, `--port`, `--state-home`); requires
  `HANSE_RUNTIME_TOKEN` and a reachable B1 runner (`HANSE_RUNNER_URL`).
- `hanse runner` - internal B1 container runner (`--hostname`, `--port`; default `0.0.0.0:8790`).
- `hanse agent-supervisor` / `hanse agent-host` - internal B0 compatibility commands, not used by the
  B1 Compose stack.
- `hanse mcp` - run the coordinator MCP server bound to an app (used by opencode).
- `hanse web-mcp` - run the managed web tools MCP server (internal; spawned by opencode when a
  DeepSeek web driver is configured).

## Environment variables

| Variable | Used by | Meaning |
| --- | --- | --- |
| `HANSE_OPERATOR_TOKEN` | serve, ide | operator token (UI login + extension API); never given to agents |
| `HANSE_RUNTIME_TOKEN` | serve, runner | shared coordinator/runner secret; app containers never receive the operator token |
| `HANSE_STATE_HOME` | serve | coordinator state root (default `~/.local/state`) |
| `HANSE_AGENTS_HOME` | serve | per-app agent state root (default `~/.local/state/hanse-agents`; Compose sets `/data/agents`) |
| `HANSE_RUNNER_URL` | serve | runner base URL (Compose: `http://runner:8790`) |
| `HANSE_HOST_WORKSPACE` / `HANSE_HOST_AGENTS` | serve, runner | absolute host paths used by the runner for app bind mounts |
| `HANSE_HOST_RUNNER_TMP` | runner | absolute writable host path for ephemeral Test-connection credential dirs, mounted at the same path; must not overlap workspace/agents (default `/var/lib/hanse/tmp`) |
| `HANSE_AGENT_API_BASE` | serve | coordinator URL passed to agents as the MCP API base (Compose: `http://hanse:8787`) |
| `HANSE_AGENT_IMAGE` | serve, runner | default per-app image; runner requires it to be in its allowlist |
| `HANSE_AGENT_BASE_IMAGE` | serve, runner | full reference (repository plus optional tag or `@sha256`) of the shared base image; `build.base=base` requires it, and the runner allowlists it for builds and inspection |
| `HANSE_TAG` / `HANSE_AGENT_TAG` | Compose | coordinator and per-app agent image tags; `HANSE_TAG` is the fallback for all, `HANSE_AGENT_TAG` for IDE/runner |
| `HANSE_IDE_TAG` / `HANSE_RUNNER_TAG` | Compose | independent IDE and runner image tags; fall back to `HANSE_AGENT_TAG`, then `HANSE_TAG` |
| `HANSE_DEPLOY_LOCK_FILE` | serve | absolute path of the external deployment lock (default `<state>/hanse/deploy.lock`) |
| `HANSE_REVISION` | serve, image | image-provided full commit revision reported by `/readyz`; not an operator setting |
| `HANSE_AUTH_FILE` | serve | host opencode `auth.json`; reconciled with provider-key settings into each app state |
| `HANSE_OMO_PLUGIN` | serve | comma-separated baseline plugin specs injected into every instance |
| `HANSE_CODEGRAPH_BIN` | serve | path to the codegraph CLI used for the baseline MCP server |
| `HANSE_IDE_URL` | dashboard | IDE link (set to `/ide/`) |
| `HANSE_IDE=0` | serve | do not spawn code-server in the coordinator |
| `HANSE_IDE_HOST` / `HANSE_IDE_PORT` | serve | proxy target for `/ide` (default `127.0.0.1:8080`) |
| `HANSE_IDE_BIN` | serve | code-server binary |
| `HANSE_ASSETS` | serve | directory for `app.css`, `app.js`, `app-content.js`, the built client assets under `assets/ui/`, `chat.js`, `chat-core.js`, `chat-diff.js`, `chat-highlight.js`, `chat-highlight-worker.js`, `git.js`, `git-settings.js`, `handoff.js`, `settings.js`, `skill-detail.js`, `markdown.js`, `vendor/prism/prism-1.30.0.min.js`, and `favicon.svg` |
| `HANSE_UI_LEGACY` | serve | `1` forces every page to the legacy renderer (restart required); `?legacy=1` forces one request |
| `HANSE_UI_SPA_ROUTES` | serve | comma-separated route ids to serve as SPA; unset uses the registry flags, empty string disables all SPA routes |
| `HANSE_UI_DEV_URL` | serve, dev | Vite dev origin (for example `http://127.0.0.1:5173`); the server emits `<url>/assets/ui/@vite/client` and `<url>/assets/ui/main.ts` instead of the built manifest |
| `HANSE_DB` / `HANSE_PROJECT_ID` / `HANSE_APP_KEY` | `hanse mcp` | MCP server binding |
| `HANSE_API_BASE` | extension | coordinator base URL (`http://hanse:8787`) |

`HANSE_HOST_GIT_DIR` and the credential/config `HANSE_GIT_*` variables (`HANSE_GIT_TOKEN`,
`HANSE_GIT_SSH_KEY`, `HANSE_GIT_KNOWN_HOSTS`, `HANSE_GIT_SSH_COMMAND`, `HANSE_GIT_ASKPASS`,
`HANSE_GIT_SSL_CAINFO`, `HANSE_GIT_AUTHOR_*`, `HANSE_GIT_COMMITTER_*`) were removed with no fallback;
Compose no longer passes them and the coordinator no longer reads them. The four non-secret sandbox
operation variables (`HANSE_GIT_OP`, `HANSE_GIT_APP_DIR`, `HANSE_GIT_BRANCH`, `HANSE_GIT_MESSAGE`)
remain internal to the git one-shot.

`HANSE_WEB_CONFIG` and `HANSE_OPENCODE_AUTH_FILE` are internal `hanse_web` MCP variables set by the
coordinator; operators do not set them.

## Verification

`npm run lint && npm run typecheck && npm run typecheck:ui && npm test && npm run build &&
npm run check:ui` (all green; 2758 tests in 148 files; the suite includes the jsdom UI project).
The UX polish pass deployed as `sha-88faab7`; the settings live-save follow-up deployed as
`sha-d2fcc3b`; the runtime-state reconciliation fix deployed as coordinator `sha-98033f5` on
2026-10-21. The project/application deletion stage is verified by the four gates; it has not been
deployed or live-smoked from this checkout. The global custom model provider stage is verified by
the four gates plus `npm run check:sensitive`; its live LiteLLM smoke remains pending. The context
usage/compaction stage is verified by the four gates and the deterministic chat QA bridge (14
scenarios, zero console/page errors, context screenshots under `docs/design/artifacts/chat/`). The
context stage is deployed as coordinator
`sha-50acf4f` (journal 0017). The managed agent skills stage is verified by the four gates and
`node docs/design/skills-qa.mjs` (PASS, 49 assertions, zero console/page errors; report and
screenshots under `docs/design/artifacts/skills/`). An empirical `opencode debug skill` run against
a materialized root listed the managed names and descriptions (local 1.18.35; deployment pins
1.19.3). The skills stage is deployed as coordinator/agent/ide/runner `sha-33523f1` (2026-10-22,
journal 0018): migration v12 applied, `demo-app` materialized an empty set, a temporary global skill
was created, listed by `opencode debug skill`, then deleted and removed after restart, and the B1/B2
probes passed. The skill bundles stage is verified by the four gates,
`node docs/design/skills-qa.mjs` (12 scenarios, 505 assertions, 29 screenshots), and a real
`opencode debug skill` bundle load; it has not been deployed from this checkout.
B1 core live smoke on `deployment-host`: coordinator/IDE/runner healthy, per-app `demo-app` container running,
`scripts/agent-runtime-probe.sh b1` passes, coordinator recreate reattaches the app network, and the
app agent has no `/data/state`, Docker socket, operator/runtime token, or sibling app access.
B2 live smoke on `deployment-host`: built a test app from `ARG HANSE_BASE` with an extra `jq` package; the
builder reached `ready`, image validation passed, the app container used the built `image_ref`, a
rebuild produced a second version, rollback switched back and restarted the agent, and
`scripts/agent-runtime-probe.sh b2` plus `GET /api/images/usage` passed. The settings live-save
follow-up was deployed on 2026-10-21 as `sha-d2fcc3b`: all four images use the same tag, the static
services are healthy, the settings page serves the fragment wrapper and both updated scripts,
`demo-app` is attached on the new agent image, and B1/B2 probes pass. The new coordinator
(`sha-98033f5`, agent images unchanged on `sha-d2fcc3b`) reconciled a stale running row on startup
and reflected an external `docker stop` within 15 seconds; no `Restart required` marker survived,
the app restarted, sessions returned `200`, and B1/B2 passed. The test app is
`b2-smoke/apps/web` in the host workspace; its image is `stale` until rebuilt against the current
default base.
B1.4 terminal live smoke: `/terminal` returns `200`, direct runner exec, coordinator proxy, and the
LAN WebSocket each returned `B1_*_OK`, and closing the terminal left the app container running.
B1.6 `hanse-down.sh` live smoke: down removed the static stack and managed app/network; `compose up`
recreated the static services healthy, the app was lazily recreated, sessions returned `200`, and the
terminal page remained human-only (`303` anonymous, `200` authenticated). A subsequent
`up --remove-orphans` preserved the running app.
B1.5 live smoke: git status and fetch returned `200` through the coordinator/runner one-shot sandbox
(`demo-app`, public GitHub remote), no `hanse-git-*` container remained, the app container had no
`HANSE_GIT_*` environment, and the terminal WebSocket still returned `B1_LAN_OK`. The `b1` probe
passed again after the deploy.
Git credential live smoke on `sha-e2d89a2`: migrations `[1..9]` applied, `setting_secrets` exists,
the legacy `secrets` table is absent, and the SSH tables remain. `demo-app` was lazily started with the
managed directory `<app>/home/.config/hanse/git/{config,ssh,askpass}`; its environment contains only
the path variables and no `HANSE_GIT_*`. Authenticated `git/status` and `git/fetch` returned `200`
for the public HTTPS remote and left no one-shot container. Test connection rejected an invalid draft
key with `400 invalid_git_credential`, accepted a valid draft key far enough to reach GitHub, then
reported the TOFU warning and `502 auth_failed` without leaking the key; `HANSE_HOST_RUNNER_TMP` was
clean afterward. The app settings page exposed **Test connection**, and the `b1` probe passed. No
operator PAT/deploy key was available, so a successful credential-backed push and successful SSH
Test remain covered by tests rather than live smoke.
Chat browser
QA: `node docs/design/chat-qa.mjs` (deterministic fixtures; 3 scenarios, 81 assertions, 10
screenshots, zero console/page errors). Live smoke against a real deployment: 1
scenario, 2 assertions, streaming assistant text and a rendered markdown table, zero console/page
errors. Evidence: [`docs/design/artifacts/chat/`](design/artifacts/chat/README.md).

Settings stage verification:

- Temporary Playwright smoke of seed-generated settings pages at 1440 and 390 (dark): six pages,
  zero console/page errors, zero duplicate DOM ids; screenshots inspected.
- Built image `hanse:qa`, run as uid 1000 with a writable `/home/coder/.omo`, real
  `opencode-ai@1.19.3` + `oh-my-openagent@5.1.35`: the per-app OMO profile was written, `/agent`
  reported `deepseek/deepseek-flash` for the pinned agents, and a second run selected
  `deepseek/deepseek-v4-pro` with `/config` and `/agent` both reporting it (20 profile pins).
  Managed search registered `hanse_web`
  with `search` and removed OMO `websearch` from `/config`, permissions were `websearch: deny` and
  `hanse_web_search: allow`, and restart returned `{restarted:true}` then
  `{restarted:false,reason:"not_running"}`. The managed tool was listed through the real
  `hanse web-mcp`; no paid DeepSeek Search/Fetch call was made (driver tests use a local fake
  server).

## Known limitations and residual risks

- Deletion is irreversible and a partially failed deletion cannot be cancelled: the app/project stays
  `Deletion incomplete` and start/chat/terminal remain blocked until a retry completes. Source-file
  deletion is opt-in and best-effort with warnings; image-purge skips are warnings, and the global
  image GC remains the fallback. The deletion mutex is in-process/single-node, there is no CLI delete
  command, and the runner must be reachable.

- App state paths, including attachment roots, use a sanitized `<project>/<app>` segment
  (`[^A-Za-z0-9._-]` -> `-`). Two app keys that sanitize to the same segment (for example `web:api`
  and `web-api`) would share a state/attachment root; provisioning and deletion already fail closed
  on this collision, but the attachment paths themselves are not independently disambiguated.
- Inline media is delivered as file parts to capable models; there is no video playback/Range
  support, no audio input, and no server-side media generation. SVG/HTML are always file-only and
  never thumbnailed/rendered inline. Supervisor mode is weaker than runner mode for attachment
  immutability because the agent shares the host filesystem.
- Inline media is verified with deterministic server/browser fixtures; a live vision/PDF/CSV smoke
  against a real capable model (and real-device QA) remains a deployment-stage verification item.
- Context accounting is in memory and lazily rehydrated; there is no historical usage chart, no
  per-message cost/billing UI, and child/subagent sessions are excluded from auto-compaction. Hanse
  keeps opencode's built-in auto-compaction, which may compact before the configured threshold for
  models with a smaller usable window. The background monitor adds one opencode SSE connection per
  running application.
- The deployment lock is advisory, not a security boundary and not distributed. A runner call that
  already outlived a coordinator timeout is outside what the counter can see, and the `hanse images`
  CLI is outside the quiescence counter; the orchestrator must also wait for runner health and must
  not run CLI image commands during a deploy. A whole-`state/` restore can remove or replace
  `deploy.lock`; restore only DB/non-lock state or rewrite the lock before continuing.
- An async restart's claim is in memory. If the coordinator exits after returning `202`, the app may
  remain stopped and the caller must retry; use the sync route when a completion signal is required.
- MCP-token reconciliation is eventual, not crash-safe across SQLite and the filesystem. A crash
  between the DB commit and the file rename is repaired by the next startup/`ensure`; until then an
  old token gets `401`, and no container is recreated.
- A checksum mismatch is a startup warning, not a gate: it is logged with the version and startup
  continues, so a deliberately edited migration is visible in logs but not blocked. A newer or
  unknown applied migration still exits before listening.
- `/readyz` uses the synchronous database handle with `busy_timeout=5000`, so a concurrent restore
  can delay it up to five seconds; the 50 ms p99 is a target, not a gate.
- Single user; no RBAC or multi-tenant isolation.
- Trust model: trusted repositories; agents execute code.
- **B2 runs each app in its own hardened container/network and optional per-app image.** App
  containers have no `/data/state`, Docker socket, operator/runtime token, or sibling mounts. The
  runner is root-equivalent through the Docker socket and is trusted/operator-only; it is on the
  control network, has no coordinator state, and mounts workspace/agents read-only for build context
  and per-app passwords. B1.5 git runs in a no-secret one-shot container from the app image; the
  coordinator keeps only the human-only UI/API and a runner client. The B1.4 operator terminal is
  human-only and scoped to managed app containers; it now uses a real xterm.js renderer (ANSI,
  alternate screen, 5000-line scrollback, Unicode 15 grapheme widths, resize, IME, copy/paste).
  Reconnect starts a new ephemeral shell; there is no search/web-links addon or persistent session
  multiplexer. The Unicode 15 graphemes addon is experimental upstream; the stable Unicode 11
  provider is the fallback, and the terminal enables the proposed unicode API for both. "Human-only" prompt
  routes remain a Hanse-route guarantee, not a hard boundary: an agent with `bash` can call the
  upstream prompt API directly, including a v2 `always` reply that creates a durable project-scoped
  saved permission.
- B2 image builds are explicit and local to the runner; there is no auto-build on file edits and no
  remote build farm. Builds can use network access to install OS packages. The previous image/container
  is kept on failure, and image GC is explicit rather than automatic at the 85% warning threshold.
  Custom images must include the Hanse agent contract (entrypoint, `opencode`, MCP CLI, git) or
  validation rejects them.
- The permission overlay is a guardrail, not a sandbox. App-owned `opencode.json`/plugins can widen
  the final ruleset (the `.opencode` edit deny is bypassable with `bash`), verification is
  warning-only by owner decision, `bash` path checks are best-effort, symlinks/bind mounts can
  escape, and `.env`/network are intentionally allowed. B1 adds per-app containers and networks;
  upstream authentication remains a later hardening step.
- Cross-app handoff delivery is automatic but policy-gated: the target runs in a fresh session and its
  reply wakes the source session; strict pairs require operator approval, and replies with no live
  source session wait for an operator relaunch.
- SSH host keys are coordinator-held; the agent can run arbitrary commands as the configured SSH
  user on an approved host. The remote user's privileges are the real boundary; use least-privilege
  deploy users. Do not grant SSH to the coordinator host or a host that can read coordinator state
  or the Docker socket.
- SSH host-key pinning is TOFU on first use. After the pin, a mismatch fails closed; re-pin is an
  explicit human Test + re-pin action. A load-balanced address with multiple host keys is not
  supported in v1.
- SSH approval is app-scoped, not chat-session-scoped (the MCP call carries no opencode session id).
  v1 uses 5-second polling rather than a coordinator-originated SSE frame.
- SSH grants are not killed in flight on revoke or allowlist removal; new calls fail, a running
  command continues until its timeout. There is no recursive transfer, jump host, agent forwarding,
  password auth, or passphrase-protected key support.
- The SSH feature protects operator host keys and provides an audited managed path; it is not a
  network egress control. The app can create its own keys and connect directly.
- The OMO baseline is image-wide; the selected model is applied through a per-app profile under the
  app's HOME. A project `.omo/omo.jsonc` layer can override profile pins; the post-start `/agent`
  check is warning-only.
- Settings live in the coordinator DB, not in the repository; they do not travel with a cloned
  project. Provider keys are encrypted at rest, but each app host can read its own `auth.json`
  (model credentials) under `/data/agents`; it cannot read the coordinator DB or `secret.key`.
  Ciphertext is not AAD-bound and key rotation is not implemented; clearing is logical
  (`secure_delete` plus a WAL checkpoint), and physical media/backups may retain old pages.
- Settings changes require an explicit restart to update the OMO profile, web tools, and the
  instance config; a restart interrupts an active turn. Chat prompts carry the effective model, so
  the main session adopts a model change on its next message without a restart; OMO subagents keep
  the profile from instance start.
- Custom model providers are global-only, manually listed, and restricted to the bundled
  `@ai-sdk/openai-compatible` adapter. There is no model auto-discovery, per-project provider
  definition, custom header, OAuth provider support, or provider enable/disable. The collision
  warning uses a curated bundled-id set, so an uncommon built-in id can be overridden without a
  warning. Provider definitions are non-secret and every app can read the base URL and model list in
  `OPENCODE_CONFIG_CONTENT`; keys remain encrypted. Deleting and recreating an id reuses its retained
  key against the new base URL. The registry is capped at 32 providers and the final overlay at
  64 KiB; a downgrade to a coordinator without v19 requires a restart.
- Skills only establish precedence among Hanse-managed rows. Repository `.opencode/skill(s)`,
  plugin, `~/.claude/skills`, `~/.agents/skills`, and cache roots are scanned and warned, but Hanse
  cannot override them, and duplicate winner selection across those roots is not a stable opencode
  contract.
- Skills are single-file `SKILL.md` only: no bundles, scripts, binary assets, URL imports, per-agent
  allowlist, or version history/rollback. They are plaintext operator instructions, not a secret
  store.
- Skills are never hot-reloaded; a running agent picks up a changed set only after an explicit
  restart. `pendingRestart` hashes the effective set per query, and first-deploy
  `skills-replaced/` directories are not cleaned up automatically.
- Built-in search requires the OMO baseline; without OMO the settings UI warns and no built-in
  search tool is available. Managed DeepSeek web tools depend on a usable provider key and on the
  external DeepSeek Search/Fetch API; there is no per-instance cost budget.
- Codegraph indexes are per application (`<app>/.codegraph/`) and are not built automatically;
  per-app HOME keeps the global codegraph state separate.
- No TLS; intended for a trusted LAN (VPN/reverse proxy for remote access).
- The master agent has no deletion, file removal/move, git, image-build, skill delete/revert/rename
  or provider-key/git-credential tool; skill creation, listing, reading, update, enable/disable, and
  override are available through the master skill tools, while deletion/revert/rename remain
  operator-only. Manifest changes are limited to the provisioning tools; renaming
  projects, removing apps, and changing base branches remain UI/manifest jobs. A changed master
  `AGENTS.md` needs an explicit master restart because instructions are not part of the settings
  hash. The master reads text files only, can read workspace content that itself contains secrets,
  and can send what it reads to its configured model provider and web tools; its SSH/handoff tools
  are denied, no git credentials are materialized, and it has no state volume or Docker socket. The
  B0 compatibility host does not enforce the read-only app directory.
- The writer lock is a single-node file lock (`O_EXCL` + pid liveness), not a distributed lock.
- `git clone` in the add-app endpoint is synchronous (`execFileSync`) and blocks the event loop.
  It uses the target project's global/project credential; an SSH remote without one fails with a
  clear message, an HTTPS remote without one clones publicly, and there is no ambient fallback. A
  crash can leave a `0700` credential directory in the coordinator temp root until the startup
  sweep, and a `noexec` temp root cannot run the SSH wrapper/askpass.
- The git workbench requires the application directory to be its own repository root; applications
  inside a larger repository show a "Not a repository root" state.
- "Commit all" stages and commits untracked files (ignored files stay out); there is no per-file
  staging, diff viewer, or conflict-resolution UI.
- Git actions require the app container to be running; a stopped app has no mounted git workbench.
- Git fetch/push credentials are per-application, encrypted in `setting_secrets`, and materialized
  into the app HOME before start. The **agent can read its own credentials** (accepted Variant A);
  scope each SSH deploy key to one repository and each HTTPS token to the minimum permissions and an
  expiry. There is no ambient `HANSE_GIT_*`/`HANSE_HOST_GIT_DIR` fallback. Without a credential, local
  status/switch/commit still work and fetch/update/push fail with a credential error. Commit requires
  an effective `git.user.name`/`git.user.email` or a repository-local identity.
- Git settings apply on the next agent restart. Fetch/push from the workbench before that restart use
  the previously materialized files. Passphrase-protected SSH keys are rejected in v1; HTTPS hosts
  must be allowlisted exactly; without `known_hosts` SSH uses `accept-new` with a TOFU warning and a
  learned host key lasts only until the next materialization. Custom CA (`HANSE_GIT_SSL_CAINFO`) is
  not supported; use the app image trust store. The web IDE terminal does not receive these
  credentials.
- The one-shot git helper runs with the same controlled child environment and fixed command-line
  config as B0.6: repository hooks, fsmonitor, credential helpers, ext protocols, submodule
  recursion, and repository SSH commands are disabled, and remotes are validated (HTTPS/SSH/scp/file
  inside the app). The helper ships in the app image, so the app image must match the coordinator's
  `git-op` command (agent-default does). A per-repository in-memory lock in the coordinator
  serializes UI actions but does not cover agents or the IDE writing to the same repository.
- The IDE chat can be moved to the right sidebar only by a one-time user action (VS Code limitation).
- App previews are demo-only and same-origin: the previewed app runs in the operator's Hanse origin
  and can call same-origin APIs; `Set-Cookie` responses are dropped, but direct cookie writes and
  `/logout` remain possible. Previews are runner-mode only, in-memory (lost on coordinator restart),
  2 hours/max 8, and the agent must configure the framework base path. Host ports, subdomains,
  sandboxing, and per-app authentication are not implemented.
- Settings without JavaScript submit non-Git forms and fall back to the redirect/toast path; inline
  errors and preserved values need the script. Git credential forms are JSON-only and require JS.
- Applied settings/profile hashes were not persisted before migration v10. A running instance from an
  older deployment shows `Applied state unknown` and `Restart required` until it is restarted; the UI
  does not guess that the current settings are applied.
- Chat runtime chips poll `/api/apps/:app/runtime` every 10s while visible, so an externally stopped
  container can take up to 10s to appear; there is no runtime SSE. Runtime `Running` means the
  container is up, not that a turn is active.
- Chat loads a 30-message tail and prepends older pages on scroll-up, but the loaded window is not
  virtualized; very large loaded windows remain the scaling limit. The idle `GET /messages` snapshot
  is capped at 8 MiB (`messages_too_large`); the running tool output shown live is capped to a 64 KiB
  tail and the full result appears only when the whole message snapshot fits the cap (no dedicated
  full-output fetch). Queued messages cannot be
  removed while the agent is busy (upstream `DELETE .../message/:mid` returns 409 `SessionBusyError`),
  the queue is not persisted/reorderable, and there is no client-side holding queue. OMO
  classification is client-only (no server persistence), and permissions always stay in the dock (no
  inline permission cards). Drawers close on Escape/scrim/close but do not trap focus. Markdown is a
  deliberate subset: tables are supported, but there are no images, embeds, or raw HTML, and there is
  no server-side markdown rendering.
