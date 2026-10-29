# Deployment and operations

> Current architecture and behavior: [`docs/current-state.md`](current-state.md). This file is about
> running `hanse` with Docker Compose, either from the published image or from source.

`hanse` is a single-operator, self-hosted workbench. It runs three static containers plus one
container per application:

- **`hanse`** - the coordinator: web UI, HTTP API, MCP servers, and the runtime client.
- **`hanse-ide`** - code-server with the default toolchains and the bundled Hanse Agent extension.
  It is not published directly; the coordinator proxies it at `/ide/` and enforces the operator login.
- **`hanse-runner`** - the container runner: it owns the Docker socket, validates runtime specs, and
  creates one app container per application on an isolated app network.
- **`hanse-app-<project>-<app>`** - the per-app runtime, created lazily on first chat/use from the
  default agent image. It mounts only that app's directory and `/data/agents/<project>/<app>`.

Only the coordinator publishes a host port. The IDE is on the `front` network, the runner is on the
`control` network, and app containers live on their own `hanse-app-*` networks; app containers cannot
reach the IDE. The human-only operator terminal is proxied by the coordinator to the runner and needs
no extra published port.

## Requirements

- Docker Engine 24+ with Compose v2 (Docker Desktop works on macOS and Windows/WSL2). The runner
  needs the Docker socket; a rootful daemon is required for the default B1 Compose stack.
- A Linux `amd64` host. The default publish workflow builds `linux/amd64`; arm64 is on-demand until
  it returns to the default matrix.
- 2 CPU cores minimum; 4+ recommended for several apps or image builds.
- About 2 GB of RAM for an idle coordinator/IDE/runner, plus up to 2 GB per app container (the
  default cap). 4 GB is the minimum for the stack and one app; 8-16 GB is recommended for several.
  Raise `HANSE_APP_MEMORY_MB`/`HANSE_APP_CPUS` only with matching host capacity (set them in the
  coordinator environment, for example with a Compose override).
- Absolute host paths for the workspace and agents volumes, because the runner passes them to the
  Docker daemon as bind sources.
- About 7-8 GB for the five images, plus roughly 1-2 GB per app in the `agents` volume, the
  workspace/state volumes, and room for custom images, rollbacks, and build cache. Allow 20 GB free
  minimum and 40+ GB on SSD recommended. The images bundle code-server, the toolchains, `opencode`,
  the OMO baseline, and CodeGraph.
- A model credential for `opencode`: enter a provider key in the settings UI, or reuse a host
  `opencode` login (see [Model credentials](#model-credentials)).

## Quick start (published image)

The images are published to GitHub Container Registry as
`ghcr.io/arkaneman/hanse` (coordinator), `ghcr.io/arkaneman/hanse-agent-base`,
`ghcr.io/arkaneman/hanse-agent-default` (per-app agents), `ghcr.io/arkaneman/hanse-agent-ide` (IDE),
and `ghcr.io/arkaneman/hanse-runner` (runner), all for `linux/amd64`.

```bash
mkdir -p hanse && cd hanse
curl -fsSLO https://raw.githubusercontent.com/ArKaNeMaN/hanse/main/compose.yaml
curl -fsSLO https://raw.githubusercontent.com/ArKaNeMaN/hanse/main/.env.example
cp .env.example .env

# Generate the operator and internal runtime tokens.
TOKEN=$(python3 -c 'import secrets; print(secrets.token_urlsafe(32))')
RUNTIME_TOKEN=$(python3 -c 'import secrets; print(secrets.token_urlsafe(32))')
sed -i.bak "s|^HANSE_OPERATOR_TOKEN=.*|HANSE_OPERATOR_TOKEN=$TOKEN|; s|^HANSE_RUNTIME_TOKEN=.*|HANSE_RUNTIME_TOKEN=$RUNTIME_TOKEN|" .env && rm -f .env.bak
echo "operator token: $TOKEN"

mkdir -p workspace state agents
ROOT=$(pwd)
sed -i.bak "s|^# HANSE_HOST_WORKSPACE=.*|HANSE_HOST_WORKSPACE=$ROOT/workspace|; s|^# HANSE_HOST_AGENTS=.*|HANSE_HOST_AGENTS=$ROOT/agents|" .env && rm -f .env.bak
sudo chown -R 1000:1000 workspace state agents
docker compose pull

# The per-app agent and shared base images are not Compose services. Source .env so the explicit
# pulls use the same repository and tag resolution as Compose (HANSE_AGENT_TAG, then HANSE_TAG).
set -a; . ./.env; set +a
docker pull "${HANSE_AGENT_IMAGE:-ghcr.io/arkaneman/hanse-agent-default}:${HANSE_AGENT_TAG:-${HANSE_TAG:-latest}}"
docker pull "${HANSE_AGENT_BASE_IMAGE:-ghcr.io/arkaneman/hanse-agent-base:${HANSE_AGENT_TAG:-${HANSE_TAG:-latest}}}"
docker compose up -d
```

`docker compose pull` pulls the coordinator, IDE, and runner images. The per-app agent and shared
base images are not Compose services, so pull them explicitly as above; the runner creates app
containers from the local agent image and builds custom images from the local base image.

Open <http://127.0.0.1:8787> and sign in with the token from `.env`.

The containers run as uid/gid `1000`. If your user is not uid 1000 on the host, make the bind mounts
writable by that uid:

```bash
sudo chown -R 1000:1000 workspace state agents
```

If the GHCR package is private in your fork, authenticate first:
`echo "$GITHUB_TOKEN" | docker login ghcr.io -u <user> --password-stdin`.

### First project

1. Open **Projects -> New project**. The UI creates a slugged folder with `.hanse/project.yaml` under
   `/data/workspace`.
2. Open the project and use **Add application** to create an app directory, or provide a git remote
   to clone.
3. Open **Settings** to choose the model and, if you are not reusing host auth, add the provider key.
4. Open the app's **Chat** page to start a session, or **IDE** to edit the workspace at `/ide/`.

The equivalent CLI scaffold, if you prefer a terminal:

```bash
docker compose exec hanse node dist/index.js init /data/workspace/demo
docker compose restart hanse
```

The workspace is scanned for `.hanse/project.yaml` on startup. See
[`docs/conventions.md`](conventions.md) for the manifest schemas.

## Per-app images (B2)

An application can opt into a full image environment with `.hanse/app.yaml`:

```yaml
name: web
build:
  dockerfile: Dockerfile
  args:
    NODE_VERSION: "22"
```

The Dockerfile must keep the Hanse runtime contract. With no `build.base`, its final-stage root
`FROM` decides the base: a root that consumes `${HANSE_BASE}` is `default`, a literal root is
`explicit`, and an unresolved or ambiguous root is `unknown`. Set `build.base: default` or
`build.base: base` to choose explicitly; `base` requires `HANSE_AGENT_BASE_IMAGE`, and a
contradictory declaration is rejected with `400 base_mismatch`.

```dockerfile
ARG HANSE_BASE
FROM ${HANSE_BASE}
USER root
RUN apt-get update && apt-get install -y --no-install-recommends <packages> && rm -rf /var/lib/apt/lists/*
USER 1000
```

Builds are explicit: open the application page and use **Build image**, or run
`hanse images build --app <key>`. The runner tars a contained app context, builds with `HANSE_BASE`
set to the resolved base reference (the configured default reference for `default`,
`HANSE_AGENT_BASE_IMAGE` for `base`, or the literal reference for `explicit`; an `unknown` base uses
the default reference only as a placeholder and records no base), and validates the result in a
no-network/read-only one-shot container. The app image must contain the Hanse entrypoint, `opencode`,
the Hanse MCP CLI, and `git`; image-declared volumes are rejected. A failed build or validation keeps
the previous image and container.

The build-spec hash is version 2: Dockerfile bytes, sorted build args, and the resolved base kind.
The base reference/tag/digest is excluded, so a harmless tag move does not mark an app stale; stored
version-1 hashes are never compared with version 2. Image identity is split into two domains that are
never compared: applied-versus-target uses Docker image IDs, and base drift uses manifest digests.
A running app on an older image is `restart_required`; a changed Dockerfile/args or base digest is
`rebuild_required`; a running stale app keeps working and warns in chat. An absent or unpulled image
is `unknown`, never current. Starting a build-configured app is blocked only when it has no usable
image; a prior usable image stays startable during a rebuild or after a failed build. A plain build
never restarts an app; only the explicit Rebuild & restart does.

The application page shows the derived image state, base kind/reference, build logs, and a rollback
action. Only the current and previous image versions are retained; explicit GC protects
current/rollback/running images, the in-flight build target while a build is recorded, and the
runner's own non-terminal build tags, and only removes Hanse app images. `GET /api/images/usage`
reports filesystem/Docker usage and warns at 75% used / critical at 85%; crossing the threshold never
deletes anything automatically. The runner mounts the host workspace read-only for build contexts and
validation, and never receives `/data/state`.

## Model credentials

Two options, and they can be combined (provider keys set in the UI take precedence for their scope):

1. **Settings UI (recommended).** Add the provider key under **Settings -> Providers**. Keys are
   encrypted at rest in the coordinator state with `state/hanse/secret.key`; they are reconciled into
   each managed instance's `auth.json`.
2. **Host opencode login.** If `opencode` is already authenticated on the host, reuse its
   `auth.json` through the optional overlay. Download the overlay next to `compose.yaml` if you
   started from the quick start:

   ```bash
   curl -fsSLO https://raw.githubusercontent.com/ArKaNeMaN/hanse/main/compose.host-auth.yaml
   HANSE_HOST_AUTH_FILE="$HOME/.local/share/opencode/auth.json" \
     docker compose -f compose.yaml -f compose.host-auth.yaml up -d
   ```

   The file is mounted read-only and copied into each instance. It must exist before `up`; Docker
   creates a directory when a bind-mount source is missing, and the coordinator cannot read that as a
   file.

After changing a model or provider setting, the settings page marks what needs a restart. Settings
never restart agents silently; use the restart action on the app, chat, or settings page.

### Custom model providers

If the provider is not in `opencode`'s bundled catalog, register it once for all applications:

1. Open **Settings -> Custom model providers -> Add custom provider**.
2. Enter a provider id (for example `llm-lan`), a display name, and the base URL of the
   OpenAI-compatible API root (usually ending in `/v1`). The base URL is resolved **inside the app
   container**: use the host's LAN address, not `127.0.0.1` or `localhost`.
3. Add one model per line: `model-id | context | output | optional name`, where `context` and
   `output` are the model's token limits.
4. Save, add the API key under **Settings -> Providers** for the same id, set `llm.model` to
   `<provider-id>/<model-id>`, and restart the application.

The provider definition is global and non-secret; API keys remain encrypted and scoped. A provider
referenced by any `llm.model` row cannot be deleted until those models change. The registry is
capped at 32 providers and the launch overlay at 64 KiB; a definition change applies on the next
restart. Model listing is manual in this stage.

## Configuration

Compose reads `.env` in the directory containing `compose.yaml`.

| Variable | Default | Purpose |
| --- | --- | --- |
| `HANSE_OPERATOR_TOKEN` | **required** | The single operator login for the UI, IDE, and extension API. Use a long random value. |
| `HANSE_RUNTIME_TOKEN` | **required** | Shared secret between the coordinator and the internal runner. Not exposed publicly. Use a second long random value. |
| `HANSE_IMAGE` | `ghcr.io/arkaneman/hanse` | Coordinator image repository. Change it for a mirror or a fork. |
| `HANSE_TAG` | `latest` | Coordinator image tag. Pin a release, `sha-<full>`, or `sha-<short>` tag for reproducible deployments; also the fallback for the agent, IDE, and runner tags. |
| `HANSE_AGENT_IMAGE` | `ghcr.io/arkaneman/hanse-agent-default` | Per-app agent image repository. |
| `HANSE_AGENT_BASE_IMAGE` | `ghcr.io/arkaneman/hanse-agent-base:<HANSE_AGENT_TAG>` | Full reference (repository plus optional tag or `@sha256`) of the shared base image. `build.base: base` requires it; the runner allowlists it for builds and inspection. |
| `HANSE_AGENT_TAG` | `HANSE_TAG` | Per-app agent image tag; also the fallback for the IDE and runner tags. |
| `HANSE_IDE_IMAGE` | `ghcr.io/arkaneman/hanse-agent-ide` | IDE image repository. |
| `HANSE_IDE_TAG` | `HANSE_AGENT_TAG`, then `HANSE_TAG` | IDE image tag. Overrides only the IDE. |
| `HANSE_RUNNER_IMAGE` | `ghcr.io/arkaneman/hanse-runner` | Runner image repository. |
| `HANSE_RUNNER_TAG` | `HANSE_AGENT_TAG`, then `HANSE_TAG` | Runner image tag. Overrides only the runner. |
| `HANSE_DEPLOY_LOCK_FILE` | `/data/state/hanse/deploy.lock` in Compose | Absolute path of the external deployment lock read by the coordinator. The orchestrator writes and removes it; the coordinator only reads. |
| `HANSE_REVISION` | image-provided | Full commit revision baked into the image and reported by `GET /readyz`. Not an operator setting; a source build without `REVISION` reports `unknown`. |
| `HANSE_BIND` | `127.0.0.1` | Host address for port 8787. Set `0.0.0.0` (or a LAN IP) to expose it. |
| `HANSE_PORT` | `8787` | Host port mapped to the coordinator. |
| `HANSE_WORKSPACE` | `./workspace` | Host path for projects and applications. |
| `HANSE_STATE` | `./state` | Host path for coordinator state. Keep it private. |
| `HANSE_AGENTS` | `./agents` | Host path for per-app HOME, XDG, mise, opencode auth/password, and MCP tokens. |
| `HANSE_HOST_WORKSPACE` | **required** | Absolute host path corresponding to `/data/workspace`. |
| `HANSE_HOST_AGENTS` | **required** | Absolute host path corresponding to `/data/agents`. |
| `HANSE_HOST_RUNNER_TMP` | `/var/lib/hanse/tmp` | Absolute writable host path for ephemeral Test-connection credential dirs. Mounted into the runner at the same absolute path; must not overlap the workspace or agents roots. Do not place it on a shared or backed-up volume. |
| `HANSE_BUILD_IMAGE` | `hanse:dev` | Local coordinator tag used by the source-build overlay. |
| `HANSE_IDE_BUILD_IMAGE` | `hanse-agent-ide:dev` | Local IDE tag used by the source-build overlay. |
| `HANSE_RUNNER_BUILD_IMAGE` | `hanse-runner:dev` | Local runner tag used by the source-build overlay. |
| `HANSE_HOST_AUTH_FILE` | - | Required only by `compose.host-auth.yaml`; path to a host `auth.json`. |
| `HANSE_UI_LEGACY` | unset | `1` forces every page to the legacy renderer; takes precedence over the allowlist and registry flags. Restart required. |
| `HANSE_UI_SPA_ROUTES` | unset | Comma-separated route ids served by the SPA. Unset uses the registry flags; an empty string disables every SPA route. Restart required. |
| `HANSE_UI_DEV_URL` | unset | Development only: Vite origin (for example `http://127.0.0.1:5173`). The coordinator emits Vite client/entry module URLs instead of the built manifest. |

`HANSE_IMAGE`, `HANSE_AGENT_IMAGE`, `HANSE_IDE_IMAGE`, and `HANSE_RUNNER_IMAGE` are repository values,
not full references or digests: Compose always appends `:${tag}`. A full reference or digest in one of
those variables produces a double-tagged, invalid reference. `HANSE_AGENT_BASE_IMAGE` is the
exception: it is a complete reference and Compose does not append a tag, so a `@sha256` pin or a
custom tag is used as written. Its Compose default is the published `hanse-agent-base` repository at
`HANSE_AGENT_TAG`, then `HANSE_TAG`. Deployment must pull the resolved default and base images before
recreating services; an image that was not pulled is `unknown`, never current.

The coordinator also receives `HANSE_STATE_HOME=/data/state`, `HANSE_AGENTS_HOME=/data/agents`,
`HANSE_RUNNER_URL=http://runner:8790`, `HANSE_AGENT_API_BASE=http://hanse:8787`, `HANSE_IDE_URL=/ide/`,
and the proxy target for the IDE service. These are internal to the Compose file and normally do not
need to be overridden.

### UI rendering modes and rollback

The authenticated UI has two renderers in one coordinator: the existing server-rendered documents and
the incremental Vue client under `ui/` (built into `assets/ui/`). `/projects` is the only registry
route with `spa: true`; every other route (including `/projects/:id`) serves the legacy UI.

- **Global rollback:** `HANSE_UI_LEGACY=1` serves every page from the legacy renderer. Restart the
  coordinator after changing it.
- **Per-route rollback:** `HANSE_UI_SPA_ROUTES` is a comma-separated list of route ids. An empty
  string disables every SPA route; unset falls back to the registry flags. Unknown ids log
  `ui.unknown_route` and are ignored. Restart after changing it.
- **Single request:** append `?legacy=1` to any page URL. Other query parameters are preserved.
- A missing, invalid, or partial `assets/ui/.vite/manifest.json` logs `ui.manifest_invalid` once and
  serves legacy for every route, so a checkout without a UI build still works.
- **Development:** run `npm run dev:ui`, then start the coordinator with
  `HANSE_UI_DEV_URL=http://127.0.0.1:5173`. The document, cookies, and `/api/ui/*` stay on the
  coordinator origin; the browser loads modules from Vite. HMR works cross-origin for localhost. A
  non-localhost page host needs Vite `server.cors.origin`/`server.allowedHosts` adjustments.

### Volumes and permissions

- `./workspace` -> `/data/workspace`: projects and applications. Shared by the coordinator and IDE;
  mounted read-only into the runner at the absolute host path so it can tar build contexts and run
  image validation without touching coordinator state. Per-app containers receive only their own app
  directory as a bind mount.
- `./state` -> `/data/state`: the coordinator database (`coordinator.db` with WAL/SHM) and the secret
  key. Mounted into the coordinator only, never into the IDE, runner, or app containers.
- `./agents` -> `/data/agents`: per-app agent HOME/XDG state, mise data, opencode auth/password, MCP
  tokens, and the materialized git identity/credential files under
  `home/.config/hanse/git/`. Mounted read-write into the coordinator and read-only into the runner;
  each app container gets only its own `/data/agents/<project>/<app>` root. **Back it up and keep it
  private** because it contains model and git credentials.
- `HANSE_HOST_RUNNER_TMP` -> the same absolute path in the runner: writable host space for ephemeral
  Test-connection credential directories. The runner creates a `0700` `git-test-<uuid>` directory,
  mounts it read-only into the one-shot container, and deletes it in `finally`; a startup sweep
  removes stale `git-test-*` directories. It is not a credential store and must not overlap
  `HANSE_HOST_WORKSPACE`/`HANSE_HOST_AGENTS`.

The old `HANSE_HOST_GIT_DIR` -> `/run/hanse/git` mount and the credential/config `HANSE_GIT_*`
variables were removed. Remove them from an existing `.env`; Compose no longer passes them and there
is no fallback.

The containers run as uid/gid 1000. Files created by another uid (for example by `sudo`) break
writes. Repair with `sudo chown -R 1000:1000 workspace state agents`.

## Network exposure and security

The default `HANSE_BIND=127.0.0.1` is intentional: only the local host can reach the UI. For a
trusted LAN, either use an SSH tunnel or set a bound address:

```bash
# SSH tunnel from your workstation
ssh -L 8787:127.0.0.1:8787 user@server

# or listen on the LAN
HANSE_BIND=0.0.0.0 docker compose up -d
```

For anything beyond a trusted LAN, terminate TLS in a reverse proxy and keep the coordinator on
loopback. Caddy example:

```caddyfile
hanse.example.com {
    reverse_proxy 127.0.0.1:8787
}
```

Caddy handles the HTTP and WebSocket upgrade used by `/ide/` and the operator terminal automatically.
With nginx, set `proxy_http_version 1.1` and forward the `Upgrade`/`Connection` headers for `/ide/`
and `/api/apps/*/terminal`; the terminal WebSocket is proxied through the coordinator.

Security model, in short:

- One operator token, no user accounts or per-user isolation.
- Each app runs in its own hardened container as uid 1000 with a read-only root, `cap_drop: ALL`,
  `no-new-privileges`, and only its app directory and app agents root mounted. App containers have no
  `/data/state`, no Docker socket, and no operator/runtime token. Each app has its own bridge network;
  sibling app containers are not reachable by name.
- The runner is the only socket holder. It is root-equivalent by capability, so it runs on the internal
  `control` network only, has no coordinator state, and receives the host agents volume read-only for
  per-app credentials. The coordinator calls it with `HANSE_RUNTIME_TOKEN`.
- The IDE has only the workspace volume, not coordinator state or the agents volume. It receives the
  operator token because it is operator-trusted; agents never do.
- The login cookie is `HttpOnly` and `SameSite=Strict`; serve the UI over HTTPS when it is not on
  loopback.
- `no-new-privileges` is set on all static services; app containers additionally drop all capabilities
  and use a read-only root. Do not add host networking or privileged mode.
- Rotate `HANSE_OPERATOR_TOKEN`/`HANSE_RUNTIME_TOKEN` in `.env` and run `docker compose up -d`; the
  coordinator re-upserts the operator principal on start.

## Updating and rollback

```bash
set -a; . ./.env; set +a
docker compose pull
docker pull "${HANSE_AGENT_IMAGE:-ghcr.io/arkaneman/hanse-agent-default}:${HANSE_AGENT_TAG:-${HANSE_TAG:-latest}}"
docker pull "${HANSE_AGENT_BASE_IMAGE:-ghcr.io/arkaneman/hanse-agent-base:${HANSE_AGENT_TAG:-${HANSE_TAG:-latest}}}"
docker compose up -d --remove-orphans
docker compose ps
curl -fsS http://127.0.0.1:8787/healthz
curl -fsS http://127.0.0.1:8787/readyz
```

Pull the default and base images before recreating services. The identity cache is warmed after the
pull; a reference that is absent locally is `unknown` (never treated as current) and retried on the
next refresh. A default launch whose target cannot be inspected fails closed instead of starting the
old image. A custom app that declares `build.base: base` fails its next build if
`HANSE_AGENT_BASE_IMAGE` is unset.

`latest` tracks `main`. For a reproducible deployment, pin each image tag to a release or a
`sha-<short>`/`sha-<full>` tag produced by the publish workflow. `HANSE_TAG` pins the coordinator and
is the fallback for the other images; `HANSE_AGENT_TAG` pins the per-app agent and is the fallback for
the IDE and runner; `HANSE_IDE_TAG` and `HANSE_RUNNER_TAG` override only their own service.
`HANSE_AGENT_BASE_IMAGE` takes a full reference, so pin it with a tag or `@sha256` digest directly.

The store uses forward-only migrations. Rolling the image back after a migration may fail because
the older binary may not understand the newer schema, and a newer-than-code schema now exits before
listening. Back up `state` before an upgrade; restoring that backup is the reliable rollback path.

**Migration 18 (agent image validity) is forward-only.** After it runs, an older coordinator refuses
the schema (the schema guard treats it as newer) and cannot be used as a rollback. Restore the
pre-upgrade database backup (with the matching state) or ship a forward fix; there is no down
migration. Existing rows keep their data: startup registration backfills `build_configured`, while
legacy base kind/ref and v1 hashes stay `unknown` and no app is marked stale from a fabricated
identity. No agent is rebuilt, restarted, or recreated by the upgrade.

On the first start after this upgrade, each application's managed skills are materialized before
`opencode serve`. If an instance already has entries outside the effective set in its Hanse-owned
`config/opencode/skills` or `config/opencode/skill` roots, the first apply moves them to
`config/opencode/skills-replaced/` instead of deleting them; review that directory after the
upgrade. Skill changes, like settings changes, apply only on an explicit agent restart and are
never hot-reloaded.

```bash
# Pin each image independently without rebuilding. Omit a line to keep its normal fallback.
HANSE_TAG=sha-<previous-coordinator> \
HANSE_AGENT_TAG=sha-<previous-agent> \
HANSE_IDE_TAG=sha-<previous-ide> \
HANSE_RUNNER_TAG=sha-<previous-runner> \
docker compose up -d
```

## Deployment lock and release identity

The coordinator reads (never writes) an advisory deployment lock at `HANSE_DEPLOY_LOCK_FILE`,
default `/data/state/hanse/deploy.lock` inside the coordinator state volume. While it is active,
coordinator actions that could destroy or replace a managed app fail with
`409 deployment_in_progress`: creating, recreating, stopping, or deleting an app container, image
build/rollback, and app/project deletion. A running app with a usable password, reconciled MCP token,
and endpoint still reconnects and serves chat; requests that would fall through to a recreate are
rejected. The lock is an operational contract, not a security boundary.

The external orchestrator contracts are:

1. Write the lock atomically before changing images or stopping containers.
2. Poll `GET /readyz` until it reports `deploying: true` and `inFlightLifecycle: 0` on **two
   consecutive polls at least two seconds apart**. Only then switch images or restart services.
3. Heartbeat every 60 seconds. A lock whose `updatedAt` is older than 300 seconds, or whose
   `expiresAt` has passed, is inactive. `expiresAt` slides from the last heartbeat and is clamped to
   `updatedAt + 2 hours`, so a long pull stays locked while heartbeats continue.
4. Remove the lock on success and on failure.

A malformed lock is treated as active until its file mtime is older than 300 seconds, then inactive.
`ENOENT` is inactive; any other read/stat/permission error is treated as active (fail closed) and
must be repaired or removed by the operator.

The lock file lives under `state/hanse/` but is **not** part of the database backup. A restore that
replaces the whole `state/` directory can remove or replace it. During a deploy, do not delete the
lock without rewriting it: restore only the coordinator database and other non-lock state, or rewrite
the lock atomically before continuing.

`hanse images` (the CLI) honors the lock but runs in a separate process and is **not** counted in
`inFlightLifecycle`. Do not run `hanse images build`, rollback, or GC during a deploy; use the
coordinator routes, which are counted and rejected by the lock.

### Image tags and digests

| Deployment | Repository variable | Tag variable | Fallback |
| --- | --- | --- | --- |
| Coordinator | `HANSE_IMAGE` | `HANSE_TAG` | `latest` |
| Per-app agent | `HANSE_AGENT_IMAGE` | `HANSE_AGENT_TAG` | `HANSE_TAG` |
| Shared base | `HANSE_AGENT_BASE_IMAGE` (full reference) | - | `hanse-agent-base:<HANSE_AGENT_TAG>` |
| IDE | `HANSE_IDE_IMAGE` | `HANSE_IDE_TAG` | `HANSE_AGENT_TAG`, then `HANSE_TAG` |
| Runner | `HANSE_RUNNER_IMAGE` | `HANSE_RUNNER_TAG` | `HANSE_AGENT_TAG`, then `HANSE_TAG` |

The publish workflow also produces `hanse-agent-base`; it is the base layer for `agent-default` and
is not a Compose service. A custom image records its actual base kind and reference, and drift is
compared by that base's manifest digest, never by a tag string or the coordinator revision. Tags are
mutable. For a deploy, use the `sha-<full>` tag, verify that the OCI
`org.opencontainers.image.revision` label and the runtime `HANSE_REVISION` value (`GET /readyz`)
match the commit, and pin the digest recorded in the `image-digests` workflow artifact. The artifact
lists all five image references with their manifest digests.

Automation can restart an app asynchronously with `POST /api/apps/:app/restart?async=1` (returns
`202` after the claim) and poll `GET /api/apps/:app/runtime` for `restarting`. The claim is in
memory: if the coordinator exits before the restart finishes, the app can remain stopped with no
surviving marker, so the caller must treat a stopped app after a `202` as a failure and retry (or use
the synchronous restart route when it needs a completion signal).

## Disk usage and app image GC

Use the authenticated coordinator endpoints to inspect disk/image usage and to run garbage
collection explicitly:

```bash
curl -fsS -H "Authorization: Bearer $HANSE_OPERATOR_TOKEN" \
  http://127.0.0.1:8787/api/images/usage
curl -fsS -X POST -H "Authorization: Bearer $HANSE_OPERATOR_TOKEN" \
  http://127.0.0.1:8787/api/images/gc
```

The usage report covers the host workspace filesystem (`statfs`) and Docker image/build-cache totals
(`docker system df`). `level` is `ok` below 75% used, `warning` from 75%, and `critical` from 85%;
crossing a threshold only warns, it never deletes. GC is explicit, runs one at a time, and protects
the current and rollback app images plus every image used by a running/starting instance or Docker
container. It removes only Hanse app images (`hanse-app-*` / the `hanse.app.id` label), leaves
unrelated images and images with shared unrelated tags alone, and prunes build cache through Docker's
build-cache prune API. A Docker error stops the run. Builds and rollbacks are never automatic.

## Build from source

```bash
git clone https://github.com/ArKaNeMaN/hanse.git
cd hanse
cp .env.example .env
# set HANSE_OPERATOR_TOKEN and HANSE_RUNTIME_TOKEN in .env
docker compose -f compose.yaml -f compose.build.yaml up -d --build
```

The source-build overlay builds and tags the coordinator, IDE, and runner images as `hanse:dev`,
`hanse-agent-ide:dev`, and `hanse-runner:dev` (override with `HANSE_BUILD_IMAGE`,
`HANSE_IDE_BUILD_IMAGE`, and `HANSE_RUNNER_BUILD_IMAGE`) so it does not overwrite the published tags.
The per-app agent image is not a Compose service and the overlay does not build it; build it
explicitly when you need a local default agent image:

```bash
docker build --target agent-default -t hanse-agent-default:dev .
```

The build needs network access and several GB of disk. It compiles TypeScript, Tailwind, and the Vite
client, installs production dependencies for the target architecture, then installs `opencode`, the
OMO baseline, CodeGraph, Python, PHP, and the code-server IDE layer. Source development needs Node
`>=20.19.0` (Vite 7); the runtime images use Node 22. PHP 8.3 and its extensions come from prebuilt
[`packages.sury.org`](https://packages.sury.org/php/) Debian packages rather than compiling
extensions from source.

Run the repository gates before building:

```bash
npm ci
npm run lint
npm run typecheck
npm run typecheck:ui
npm test
npm run build
npm run check:ui
```

### Image build arguments

| Argument | Default | Contents |
| --- | --- | --- |
| `NODE_VERSION` | `22` | Node.js for the coordinator and build stages. |
| `PHP_VERSION` | `8.3` | PHP CLI and extension package version from Sury. |
| `CODE_SERVER_VERSION` | `4.141.0` | Base image tag for code-server. |
| `OPENCODE_VERSION` | `1.19.3` | `opencode-ai` package. |
| `OMO_VERSION` | `5.1.35` | `oh-my-openagent` baseline. |
| `CODEGRAPH_VERSION` | `1.6.2` | `@colbymchenry/codegraph`. |
| `VSCODE_THEME_VERSION` | `6.3.5` | GitHub theme installed into code-server. |
| `VERSION`, `REVISION` | `0.1.0`, `unknown` | OCI labels; the publish workflow sets them. |

The runtime image extends the official `codercom/code-server` image and adds a Node 22 binary for the
coordinator. code-server keeps its own bundled Node for the IDE. The runner image is a small Node
image with only the control API and Docker client; it has no coordinator state. This keeps native
modules aligned with `.nvmrc` and CI while avoiding a hand-copied code-server installation.

### Multi-arch build

```bash
for target in runtime:hanse agent-base:hanse-agent-base agent-default:hanse-agent-default agent-ide:hanse-agent-ide runner:hanse-runner; do
  build_target=${target%%:*}
  image=${target#*:}
  docker buildx build \
    --platform linux/amd64,linux/arm64 \
    --target "$build_target" \
    -t "ghcr.io/arkaneman/$image:dev" \
    --push .
done
```

Use `--load` instead of `--push` for a single-platform local image. The publish workflow builds all
five images for `linux/amd64` by default and pushes provenance and SBOM attestations; arm64 is only
produced by an explicit manual-dispatch override or a local build like the one above.

## Operator terminal

Every application page links to `/terminal?app=<app>&project=<project>`. It is a human-only,
line-oriented console in the managed app container, not a second IDE terminal:

- The coordinator proxies the WebSocket at `/api/apps/<app>/terminal?project=<project>` to the
  runner's `/v1/apps/<appId>/exec` with the internal runtime token. The operator cookie is never
  forwarded to the app container, and no token appears in URLs or HTML.
- The runner opens a TTY exec as uid 1000 in the managed app container with a fixed login shell.
  Closing or reloading the page closes only that exec stream; the app container keeps running.
- Resize is applied through Docker's exec resize call. Alternate-screen applications, mouse reporting,
  and full ANSI/xterm rendering are not supported; use the IDE terminal for those.
- The terminal requires a running managed app container. If the app has not been started, open its
  chat first; the terminal does not start or restart the app.

## Health checks and logs

```bash
docker compose ps
curl -fsS http://127.0.0.1:8787/healthz   # {"status":"ok"}
curl -fsS http://127.0.0.1:8787/readyz    # version, revision, schema, deploy state
curl -s -o /dev/null -w '%{http_code}\n' http://127.0.0.1:8787/          # 303 to /login
curl -s -o /dev/null -w '%{http_code}\n' http://127.0.0.1:8787/assets/app.css  # 200
docker compose logs -f --tail=100 hanse
docker compose logs -f --tail=100 ide
docker compose logs -f --tail=100 runner
```

All three static services define health checks. `hanse` is healthy when `/healthz` answers;
`hanse-ide` is healthy when code-server answers on port 8080; `hanse-runner` is healthy when its
`/healthz` answers on port 8790. The coordinator waits for the runner; the IDE waits for the
coordinator. Check per-app containers with
`docker ps --filter label=hanse.managed=true`.

`GET /healthz` remains exactly `{"status":"ok"}`. The separate unauthenticated `GET /readyz` returns
`status`, `version`, `revision`, `schemaVersion`, `deploying`, and `inFlightLifecycle` with
`Cache-Control: no-store`; it performs only database reads and returns `503`
`{"status":"error","error":"database_unavailable"}` if the schema query fails. Because it uses the
synchronous database handle with `busy_timeout=5000`, a concurrent restore can delay it up to five
seconds; the 50 ms p99 is a target, not a gate.

## Backup and restore

Stop app containers first, then back up all three volumes and the deployment files:

```bash
docker compose exec -T runner node -e 'fetch("http://127.0.0.1:8790/v1/stop-all",{method:"POST",headers:{authorization:"Bearer "+process.env.HANSE_RUNTIME_TOKEN}}).then(async r=>{if(!r.ok)process.exit(1)})' || true
docker compose stop
files=(workspace state agents .env compose.yaml)
[ -f compose.override.yaml ] && files+=(compose.override.yaml)
tar czf "hanse-$(date +%F).tgz" "${files[@]}"
docker compose start
```

`hanse-down.sh` stops managed app containers through the runner before stopping the static stack, so
SQLite and per-app state are consistent. `docker compose stop` alone does not stop dynamic app
containers. The backup contains:

- `workspace/` - the projects and applications (git repositories).
- `state/` - the coordinator DB and `secret.key`. **Keep it private.** Losing `secret.key` makes
  encrypted provider keys and git credentials undecryptable; restoring an older DB can restore
  revoked keys.
- `agents/` - per-app HOME/XDG/mise state, opencode auth/password, MCP tokens, and materialized git
  credential files. **Keep it private**; it contains model and git credentials. The runner reads this
  volume read-only for each app's password and git credential directory; app containers see only
  their own app root.
- `.env` and any Compose override files.

Restore:

```bash
docker compose down
mv state state.broken
mv workspace workspace.broken
mv agents agents.broken
tar xzf hanse-<date>.tgz
sudo chown -R 1000:1000 workspace state agents
docker compose up -d
```

`state/hanse/deploy.lock` is not database state. A whole-`state/` restore can remove or replace it.
Never remove the lock during a deploy without rewriting it: restore only the coordinator database and
other non-lock state, or rewrite the lock atomically before the orchestrator continues.

## Git credentials

Git identity and fetch/push credentials are first-class settings, not deployment environment
variables. Configure them in the web UI under **Settings -> Git** at the global, project, or
application scope; the design and threat model are in
[`docs/design/git-credentials.md`](design/git-credentials.md).

- **Identity**: set `git.user.name` and `git.user.email`. Missing rows inherit; clear at a narrower
  scope to suppress a wider value. Without an effective (or repository-local) identity the Commit
  action is disabled.
- **SSH (recommended)**: paste an unencrypted private key and, optionally, a `known_hosts` file. The
  page shows the derived public key and `SHA256:` fingerprint for a deploy-key entry. With
  `known_hosts`, host checking is strict; without it, SSH uses `accept-new` and the UI shows a TOFU
  warning. Passphrase-protected keys are rejected in v1. Use a per-repository deploy key, read-only
  unless push is required.
- **HTTPS**: provide one or more allowed hosts, a username, and a token/PAT. The askpass helper
  releases the token only for an exact host match and only over `https://`; a changed remote or a
  non-allowlisted host fails closed. Use a fine-grained token with the smallest permissions and an
  expiry.
- **Apply**: Git settings apply on an explicit agent restart (the settings page shows "Restart
  required"). Fetch/push from the workbench before the restart use the previously materialized files.
  The web IDE terminal does not receive these credentials.
- **Test connection** is available on the application settings page. It runs the draft values through
  the runner's network-enabled one-shot sandbox (`git ls-remote`), defaults to `origin`, and does not
  save settings or write the app's managed directory. It requires a running app.
- **Image prerequisite**: SSH needs `git` and `openssh-client` in the app image. `agent-default` and
  images built from `ARG HANSE_BASE` on the current base include them; a custom image that does not
  inherit the base must install `openssh-client`. The coordinator/runtime image also needs
  `ssh-keygen` for save validation.
- **Materialized files**: each app gets `<agents>/<project>/<app>/home/.config/hanse/git/` (`config`,
  `ssh`, `askpass`, plus optional `id`, `known_hosts`, `token`, `username`, `https_hosts`). The agent
  can read its own credentials by design; scope keys and tokens accordingly.
- **Add-app clone**: when an application is added from a remote, the coordinator clones it with
  the target project's effective `global` + `project` git credential (never `app` scope, which does
  not exist yet). SSH remotes require an SSH credential and fail with a clear "no SSH git credential
  is configured for this project" message; HTTPS remotes use the token when configured and
  otherwise clone public repositories normally; `git://` is unchanged. The credential is written to
  a short-lived `0700` directory under the coordinator temp root, with the same wrapper/askpass and
  child-env allowlist as fetch/push, and removed after the clone. Every branch uses the git env
  allowlist with an empty `HOME` and does not spread `process.env`; a plain clone writes no
  credential files. Remotes containing `?` or `#` are rejected as potentially credential-bearing.
  A missing or unreadable credential fails before any clone. There is no ambient fallback.
- **No ambient credential**: there is no runner/global git credential fallback and no custom CA
  setting. A private CA belongs in the app image trust store. Local status/switch/commit work without
  a network credential; fetch/update/push fail with a clear configuration message.
- **Trusted remotes only**: repository hooks are disabled by command-line config in the one-shot
  container, but `git fetch --all --prune` still contacts every remote configured in the application
  repository. Agents run repository code under the trusted-repository model.

## SSH host access

The coordinator can hold operator SSH hosts and expose them to selected applications through the
`hanse` MCP server. The private keys stay in `state/hanse/coordinator.db` (AES-256-GCM); they are
never mounted into app containers, and the `hanse mcp` shim only forwards tool calls.

- Open `/ssh` (operator login) and add a host: name, address, port, user, private key, optional
  remote root, and whether the app must ask for approval. The page shows the derived client public
  key so it can be installed in the remote `authorized_keys`.
- Use **Test** to authenticate and pin the host key. A changed host key fails closed; use **Test &
  prepare re-pin**, compare the old/new fingerprints, and submit the new fingerprint. Changing the
  address or port clears the pin and requires a fresh test.
- On the same page, select project/application and check the allowed hosts. A host with approval
  enabled asks the operator on first use; the request appears in the chat workspace (5-second
  polling) and on `/ssh`. Approving creates an idle grant (30 min idle, 8 h maximum); the next calls
  reuse it until it expires or is revoked. Rejecting starts a 60-second cooldown.
- The agent gets `ssh_list_hosts`, `ssh_exec`, `ssh_upload`, and `ssh_download`. Commands are
  non-interactive and arbitrary as the SSH user; use a least-privilege deploy user. Upload/download
  are capped at 50 MiB, use SFTP, and are confined to the app directory and the host's remote root.
- **Do not target the coordinator host** or any host that can read `/data/state` or the Docker socket
  with a key that the agent can use: an SSH shell there is equivalent to coordinator/host access.
- Every operation, host change, test, re-pin, grant revoke, and approval decision is in the SSH audit
  table. `ssh_audit` is readable from `/ssh`; it is not exposed to agents.
- No new environment variables are required. The coordinator image includes `ssh-keygen` for key
  validation; the `ssh2` npm package is used for connections.
- **Restart each existing app after upgrading** so it refreshes `tools/list` and picks up the 600 s
  `hanse` MCP timeout. No app image rebuild is needed.

## Troubleshooting

- **Permission denied under `/data/state`, `/data/workspace`, or `/data/agents`**: the bind mounts
  are not writable by uid 1000. Run `sudo chown -R 1000:1000 workspace state agents`.
- **Port already allocated**: change `HANSE_PORT`, or stop the process using 8787.
- **`pull access denied` for GHCR**: the package is private or you are not signed in. Run
  `docker login ghcr.io`, or make the package public in its GitHub package settings.
- **`exec format error` / wrong architecture**: check `uname -m`. The published images currently
  support `linux/amd64`; build locally for another architecture.
- **`auth.json` is read as a directory**: the host file did not exist when Docker created the bind
  mount. Create/authenticate the host file first, then recreate the container.
- **Container restart loop**: `docker compose logs --tail=50 hanse`. Permission errors and an
  unreadable `auth.json` are common causes.
- **IDE shows a blank page or disconnects**: check `docker compose logs ide`; make sure the coordinator
  can resolve the `ide` service and that a reverse proxy forwards WebSocket upgrades for `/ide/`.
- **Operator terminal does not connect**: confirm the app is running, open it from the application
  page while signed in, and check `docker compose logs hanse runner`. A reverse proxy must forward
  WebSocket upgrades for `/api/apps/*/terminal`, not only `/ide/`.
- **Agent fails to start**: confirm a provider key or host `auth.json` is configured, then inspect the
  instance logs from the app page. `HANSE_AUTH_FILE` is only set by the host-auth overlay.
- **`Agent error: Model not found`**: the selected `llm.model` is not an ID the provider exposes (for
  example `deepseek/deepseek_flash` instead of `deepseek/deepseek-flash`). Fix the setting at the
  narrowest scope; the next message uses it without a restart.
- **`omo_profile_write_failed` / `omo_profile_unavailable`**: `/home/coder/.omo` and its `omo.jsonc`
  must be writable by uid 1000 and contain valid JSON. The image prepares this directory; overriding
  the user or home directory can break it.
- **Built-in search warning**: built-in search depends on the OMO baseline. Without OMO, select the
  DeepSeek web driver or leave search disabled.
- **CodeGraph MCP missing**: the image sets `HANSE_CODEGRAPH_BIN`. Queries return no data until the
  application repository is indexed with `codegraph init`.
- **`git clone` fails with a TLS error**: the image includes `git` and CA certificates; a corporate
  proxy may need its CA mounted into the container.
- **SSH add-app clone fails**: configure an SSH credential at the target project (or global) scope
  in Settings -> Git, using a deploy key for that repository. The clone runs synchronously in the
  coordinator container, so it needs `git`, `openssh-client`, and a writable/executable temp root;
  a `noexec` `/tmp` mount cannot run the wrapper. A missing key now reports "no SSH git credential
  is configured for this project" and a wrong key reports git's sanitized
  `Permission denied (publickey)` instead of a bare command failure. Stale `hanse-git-clone-*`
  directories are swept at `serve` startup (default one hour); inspect them only if a crash leaves
  a directory behind.
- **Git push/fetch fails**: configure SSH or HTTPS in Settings -> Git at the app/project/global
  scope (or use Test connection on the app page), confirm a restart was applied, and check host-key
  trust and the token's repository/permissions. Inspect `docker compose logs runner`; there is no
  `HANSE_GIT_*`/`HANSE_HOST_GIT_DIR` environment to check. Confirm the app image provides
  `openssh-client` for SSH. Check the effective commit identity with
  `docker compose exec <app-container> git -C <app-dir> var GIT_AUTHOR_IDENT`.
- **Application page says "Not a repository root"**: the app directory is inside a larger git
  repository. Move the repository root to the app directory or use the IDE.
- **Old containers after an upgrade**: `docker compose up -d --remove-orphans`.
- **Settings show "Restart required"**: settings never restart agents. Use the restart action; an
  active turn is interrupted and sessions are kept.
- **SSH tools missing after upgrade**: restart the application so opencode refreshes `tools/list`
  and the 600 s MCP timeout. No new agent image is required.
- **SSH host key mismatch**: the host key changed. Use Test & prepare re-pin, compare the old/new
  fingerprints, then submit the new fingerprint; never disable host-key checking.
- **SSH approval not shown in chat**: open `/ssh`; approvals are app-scoped and also listed there.
  The chat polls every 5 seconds while open.
- **SSH key validation fails**: the coordinator image must have `/usr/bin/ssh-keygen`; check
  `docker compose exec hanse which ssh-keygen`. Passphrase-protected keys are rejected in v1.

## Maintainers: publishing to GHCR

`.github/workflows/publish.yml` builds all five images (`hanse`, `hanse-agent-base`,
`hanse-agent-default`, `hanse-agent-ide`, and `hanse-runner`) for `linux/amd64` by default (arm64
via manual dispatch) and pushes to `ghcr.io/<owner>/...` on every push to `main`, on `v*` tags, and
on manual dispatch.

The workflow is gated: `verify` runs lint, the sensitive-data check, typecheck, tests, and the build;
`docker-verify` builds every target without pushing; only then does the `publish` matrix push. After
a partial or complete publish, `verify-images` retries manifest inspection for propagation, checks
all five `sha-<full>` tags, extracts each digest with `docker buildx imagetools inspect`, and uploads
`digests.txt` as the `image-digests` artifact. A missing tag or digest fails that run.

Tags produced:

- `main`, `sha-<short>`, and `sha-<full>` for branch builds.
- `latest` on the default branch.
- `0.1.0` and `0.1` for a `v0.1.0` tag.

The workflow uses `GITHUB_TOKEN` (`packages: write`), so no long-lived registry secret is needed.
GitHub Packages requires the image name to be lowercase; the workflow computes it from
`GITHUB_REPOSITORY`.

Package visibility is a one-time package setting, not a workflow permission. After the first publish,
check **Package settings -> Change visibility** and make the package public if anonymous pulls fail.
A package linked to a public repository may already be public; verify with
`docker pull ghcr.io/<owner>/hanse:latest` without logging in.

Local publish:

```bash
echo "$GITHUB_TOKEN" | docker login ghcr.io -u <user> --password-stdin
VERSION=$(node -p 'require("./package.json").version')
REVISION=$(git rev-parse HEAD)
docker buildx build \
  --platform linux/amd64 \
  --target runtime \
  --build-arg VERSION="$VERSION" \
  --build-arg REVISION="$REVISION" \
  -t ghcr.io/arkaneman/hanse:dev \
  --push .
```

The `Dockerfile` pins every external component. To upgrade one, bump the matching `ARG`, rebuild,
and run the container smoke test against `/healthz`, `/readyz`, `/login`, the assets, and `/ide/`.

## Known limits

- Pre-alpha, single operator, trusted-LAN threat model. See
  [`docs/current-state.md`](current-state.md#known-limitations-and-residual-risks) for the full list.
- Agents share the coordinator uid inside the container and can read `state`; they are not a sandbox.
- Database migrations are forward-only.
- The deployment lock is advisory and single-host. It cannot stop a runner call that already
  outlived a coordinator timeout, and the CLI image commands are outside the quiescence counter.
- An async restart claim is in memory; a coordinator exit after `202` can leave the app stopped.
- The image is large (code-server, `opencode`, OMO, and CodeGraph are bundled).
- `latest` moves with `main`; pin a tag for production.
