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
- About 2 GB of RAM for an idle coordinator/IDE/runner, plus room for the per-app containers.
- Absolute host paths for the workspace and agents volumes, because the runner passes them to the
  Docker daemon as bind sources.
- About 8 GB of disk for the coordinator, IDE, and agent images plus the volumes. The images bundle
  code-server, the toolchains, `opencode`, the OMO baseline, and CodeGraph.
- A model credential for `opencode`: enter a provider key in the settings UI, or reuse a host
  `opencode` login (see [Model credentials](#model-credentials)).

## Quick start (published image)

The images are published to GitHub Container Registry as
`ghcr.io/arkaneman/hanse`, `ghcr.io/arkaneman/hanse-agent-ide`, and
`ghcr.io/arkaneman/hanse-agent-default` (`linux/amd64`).

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
docker pull "ghcr.io/arkaneman/hanse-agent-default:${HANSE_TAG:-latest}"
docker compose up -d
```

`docker compose pull` pulls the coordinator, IDE, and runner images. The per-app agent image is not a
Compose service, so pull it explicitly; the runner creates app containers from that local image.

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

The Dockerfile must start from the default agent image so it keeps the Hanse runtime contract:

```dockerfile
ARG HANSE_BASE
FROM ${HANSE_BASE}
USER root
RUN apt-get update && apt-get install -y --no-install-recommends <packages> && rm -rf /var/lib/apt/lists/*
USER 1000
```

Builds are explicit: open the application page and use **Build image**, or run
`hanse images build --app <key>`. The runner tars a contained app context, builds with
`HANSE_BASE=<HANSE_AGENT_IMAGE>`, and validates the result in a no-network/read-only one-shot
container. The app image must contain the Hanse entrypoint, `opencode`, the Hanse MCP CLI, and
`git`; image-declared volumes are rejected. A failed build or validation keeps the previous image
and container. The app is marked `stale` when its Dockerfile or default base changes; it keeps
running the last ready image until rebuilt. Starting an app whose image is `missing`, `building`, or
`error` is refused.

The application page shows image status, build logs, and a rollback action. Only the current and
previous image versions are retained; explicit GC protects current/rollback/running images and only
removes Hanse app images. `GET /api/images/usage` reports filesystem/Docker usage and warns at 75%
used / critical at 85%; crossing the threshold never deletes anything automatically. The runner
mounts the host workspace read-only for build contexts and validation, and never receives
`/data/state`.

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

## Configuration

Compose reads `.env` in the directory containing `compose.yaml`.

| Variable | Default | Purpose |
| --- | --- | --- |
| `HANSE_OPERATOR_TOKEN` | **required** | The single operator login for the UI, IDE, and extension API. Use a long random value. |
| `HANSE_RUNTIME_TOKEN` | **required** | Shared secret between the coordinator and the internal runner. Not exposed publicly. Use a second long random value. |
| `HANSE_IMAGE` | `ghcr.io/arkaneman/hanse` | Coordinator image repository. Change it for a mirror or a fork. |
| `HANSE_TAG` | `latest` | Coordinator image tag. Pin a release or `sha-<short>` tag for reproducible deployments. |
| `HANSE_AGENT_IMAGE` | `ghcr.io/arkaneman/hanse-agent-default` | Per-app agent image repository. |
| `HANSE_IDE_IMAGE` | `ghcr.io/arkaneman/hanse-agent-ide` | IDE image repository. |
| `HANSE_RUNNER_IMAGE` | `ghcr.io/arkaneman/hanse-runner` | Runner image repository. |
| `HANSE_AGENT_TAG` | `HANSE_TAG` | Agent, IDE, and runner image tag; defaults to the coordinator tag. |
| `HANSE_BIND` | `127.0.0.1` | Host address for port 8787. Set `0.0.0.0` (or a LAN IP) to expose it. |
| `HANSE_PORT` | `8787` | Host port mapped to the coordinator. |
| `HANSE_WORKSPACE` | `./workspace` | Host path for projects and applications. |
| `HANSE_STATE` | `./state` | Host path for coordinator state. Keep it private. |
| `HANSE_AGENTS` | `./agents` | Host path for per-app HOME, XDG, mise, opencode auth/password, and MCP tokens. |
| `HANSE_HOST_WORKSPACE` | **required** | Absolute host path corresponding to `/data/workspace`. |
| `HANSE_HOST_AGENTS` | **required** | Absolute host path corresponding to `/data/agents`. |
| `HANSE_HOST_GIT_DIR` | `/var/lib/hanse/git` | Absolute host directory mounted read-only into the runner and one-shot git containers as `/run/hanse/git`. May be empty; local git operations still work. |
| `HANSE_GIT_TOKEN` | - | HTTPS git token used only by runner one-shot git containers. Never passed to app containers. |
| `HANSE_GIT_SSH_KEY`, `HANSE_GIT_KNOWN_HOSTS` | - | SSH key and known-hosts paths (inside `HANSE_HOST_GIT_DIR` to be visible in the sandbox). |
| `HANSE_GIT_SSH_COMMAND`, `HANSE_GIT_ASKPASS`, `HANSE_GIT_SSL_CAINFO`, `HANSE_GIT_AUTHOR_*`, `HANSE_GIT_COMMITTER_*` | - | Optional fixed git configuration/identity for runner-executed git. |
| `HANSE_BUILD_IMAGE` | `hanse:dev` | Local coordinator tag used by the source-build overlay. |
| `HANSE_AGENT_BUILD_IMAGE` | `hanse-agent-default:dev` | Local agent tag used by the source-build overlay. |
| `HANSE_IDE_BUILD_IMAGE` | `hanse-agent-ide:dev` | Local IDE tag used by the source-build overlay. |
| `HANSE_RUNNER_BUILD_IMAGE` | `hanse-runner:dev` | Local runner tag used by the source-build overlay. |
| `HANSE_HOST_AUTH_FILE` | - | Required only by `compose.host-auth.yaml`; path to a host `auth.json`. |

The coordinator also receives `HANSE_STATE_HOME=/data/state`, `HANSE_AGENTS_HOME=/data/agents`,
`HANSE_RUNNER_URL=http://runner:8790`, `HANSE_AGENT_API_BASE=http://hanse:8787`, `HANSE_IDE_URL=/ide/`,
and the proxy target for the IDE service. These are internal to the Compose file and normally do not
need to be overridden.

### Volumes and permissions

- `./workspace` -> `/data/workspace`: projects and applications. Shared by the coordinator and IDE;
  mounted read-only into the runner at the absolute host path so it can tar build contexts and run
  image validation without touching coordinator state. Per-app containers receive only their own app
  directory as a bind mount.
- `./state` -> `/data/state`: the coordinator database (`coordinator.db` with WAL/SHM) and the secret
  key. Mounted into the coordinator only, never into the IDE, runner, or app containers.
- `./agents` -> `/data/agents`: per-app agent HOME/XDG state, mise data, opencode auth/password, and
  MCP tokens. Mounted read-write into the coordinator and read-only into the runner; each app
  container gets only its own `/data/agents/<project>/<app>` root. **Back it up and keep it private**
  because it contains model credentials.
- `HANSE_HOST_GIT_DIR` -> `/run/hanse/git` in the runner: read-only git credentials/config.
  The runner mounts the same host directory into one-shot git containers at `/run/hanse/git`; app
  containers never see it.

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
docker compose pull
docker pull "ghcr.io/arkaneman/hanse-agent-default:${HANSE_TAG:-latest}"
docker compose up -d --remove-orphans
docker compose ps
curl -fsS http://127.0.0.1:8787/healthz
```

`latest` tracks `main`. For a reproducible deployment, set `HANSE_TAG` to a release tag or a
`sha-<short>` tag produced by the publish workflow.

The store uses forward-only migrations. Rolling the image back after a migration may fail because
the older binary may not understand the newer schema. Back up `state` before an upgrade; restoring
that backup is the reliable rollback path.

```bash
# Pin a previous image without rebuilding
HANSE_TAG=sha-<previous> docker compose up -d
```

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

The source-build overlay tags the results as `hanse:dev`, `hanse-agent-default:dev`,
`hanse-agent-ide:dev`, and `hanse-runner:dev` (override with `HANSE_BUILD_IMAGE`,
`HANSE_AGENT_BUILD_IMAGE`, `HANSE_IDE_BUILD_IMAGE`, and `HANSE_RUNNER_BUILD_IMAGE`) so it does not
overwrite the published tags. The build needs network access
and several GB of disk. It compiles TypeScript and Tailwind, installs production dependencies for the
target architecture, then installs `opencode`, the OMO baseline, CodeGraph, Python, PHP, and the
code-server IDE layer. PHP 8.3 and its extensions come from prebuilt
[`packages.sury.org`](https://packages.sury.org/php/) Debian packages rather than compiling
extensions from source.

Run the repository gates before building:

```bash
npm ci
npm run lint
npm run typecheck
npm test
npm run build
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
for target in runtime:hanse agent-default:hanse-agent-default agent-ide:hanse-agent-ide runner:hanse-runner; do
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
three images for both architectures and pushes provenance and SBOM attestations.

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
  encrypted provider keys undecryptable; restoring an older DB can restore revoked keys.
- `agents/` - per-app HOME/XDG/mise state, opencode auth/password, and MCP tokens. **Keep it
  private**; it contains model credentials. The runner reads this volume read-only for each app's
  password; app containers see only their own app root.
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

## Git workbench credentials

The application page can fetch, update, commit, and push. B1.5 runs each operation in a one-shot
container from the app image, so repository-controlled hooks, fsmonitor, SSH commands, and credential
helpers never run in the coordinator. Git is not wired to the encrypted provider-key store.

- **Commit identity**: set `HANSE_GIT_AUTHOR_NAME`/`HANSE_GIT_AUTHOR_EMAIL` and
  `HANSE_GIT_COMMITTER_NAME`/`HANSE_GIT_COMMITTER_EMAIL` in `.env`, or set `user.name`/`user.email`
  in each repository. Without an identity the Commit action is disabled.
- **Push/fetch credentials**: set `HANSE_GIT_TOKEN` for HTTPS, or put an SSH key and `known_hosts`
  under `HANSE_HOST_GIT_DIR` and set `HANSE_GIT_SSH_KEY`/`HANSE_GIT_KNOWN_HOSTS` to their paths inside
  that directory. `HANSE_GIT_SSH_COMMAND`, `HANSE_GIT_ASKPASS`, and `HANSE_GIT_SSL_CAINFO` are also
  supported. The values are passed only to the runner's one-shot git container, never to the app.
- **Trusted remotes only**: `git fetch --all --prune` contacts every remote configured in the
  application repository. Repository hooks are disabled by command-line config; git runs as uid 1000
  in the one-shot container with the app directory writable.

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
- **Git push/fetch fails**: check `HANSE_GIT_TOKEN` or the `HANSE_GIT_SSH_*` files under
  `HANSE_HOST_GIT_DIR`, plus host-key trust, and inspect `docker compose logs runner`. The app
  container does not receive these credentials. Check the commit identity with
  `docker compose exec hanse git -C /data/workspace/<project>/<app> var GIT_AUTHOR_IDENT` (local
  workbench operations use the runner, not the coordinator's ambient git config).
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

`.github/workflows/publish.yml` builds `linux/amd64` by default (arm64 via manual dispatch) and pushes to
`ghcr.io/<owner>/hanse` on every push to `main`, on `v*` tags, and on manual dispatch.

Tags produced:

- `main` and `sha-<short>` for branch builds.
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
docker buildx build \
  --platform linux/amd64,linux/arm64 \
  -t ghcr.io/arkaneman/hanse:dev \
  --push .
```

The `Dockerfile` pins every external component. To upgrade one, bump the matching `ARG`, rebuild,
and run the container smoke test against `/healthz`, `/login`, the assets, and `/ide/`.

## Known limits

- Pre-alpha, single operator, trusted-LAN threat model. See
  [`docs/current-state.md`](current-state.md#known-limitations-and-residual-risks) for the full list.
- Agents share the coordinator uid inside the container and can read `state`; they are not a sandbox.
- Database migrations are forward-only.
- The image is large (code-server, `opencode`, OMO, and CodeGraph are bundled).
- `latest` moves with `main`; pin a tag for production.
