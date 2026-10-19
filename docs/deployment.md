# Deployment and operations

> Current architecture and behavior: [`docs/current-state.md`](current-state.md). This file is about
> running `hanse` with Docker Compose, either from the published image or from source.

`hanse` is a single-operator, self-hosted workbench. It runs as two containers from one image:

- **`hanse`** - the coordinator: web UI, HTTP API, MCP servers, and the managed `opencode` instances.
- **`hanse-ide`** - code-server with the bundled Hanse Agent extension. It is not published directly;
  the coordinator proxies it at `/ide/` and enforces the operator login.

The coordinator is the only exposed port. Everything else stays on the Compose network.

## Requirements

- Docker Engine 24+ with Compose v2 (Docker Desktop works on macOS and Windows/WSL2).
- A Linux `amd64` or `arm64` host. The published image is multi-arch.
- About 2 GB of RAM for an idle instance, plus room for the projects and the agents you run.
- About 6 GB of disk for the image and volumes. The image is large because it bundles code-server,
  `opencode`, the OMO baseline, and CodeGraph.
- A model credential for `opencode`: enter a provider key in the settings UI, or reuse a host
  `opencode` login (see [Model credentials](#model-credentials)).

## Quick start (published image)

The image is published to GitHub Container Registry as
`ghcr.io/arkaneman/hanse` (`linux/amd64` and `linux/arm64`).

```bash
mkdir -p hanse && cd hanse
curl -fsSLO https://raw.githubusercontent.com/ArKaNeMaN/hanse/main/compose.yaml
curl -fsSLO https://raw.githubusercontent.com/ArKaNeMaN/hanse/main/.env.example
cp .env.example .env

# Generate a token, then replace the change-me placeholder in .env with it.
python3 -c 'import secrets; print(secrets.token_urlsafe(32))'

mkdir -p workspace state
docker compose pull
docker compose up -d
```

Open <http://127.0.0.1:8787> and sign in with the token from `.env`.

The containers run as uid/gid `1000`. If your user is not uid 1000 on the host, make the bind mounts
writable by that uid:

```bash
sudo chown -R 1000:1000 workspace state
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

## Model credentials

Two options, and they can be combined (provider keys set in the UI take precedence for their scope):

1. **Settings UI (recommended).** Add the provider key under **Settings -> Providers**. Keys are
   encrypted at rest in the coordinator state with `state/hanse/secret.key`; they are reconciled into
   each managed instance's `auth.json`.
2. **Host opencode login.** If `opencode` is already authenticated on the host, reuse its
   `auth.json` through the optional overlay:

   ```bash
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
| `HANSE_IMAGE` | `ghcr.io/arkaneman/hanse` | Image repository. Change it for a mirror or a fork. |
| `HANSE_TAG` | `latest` | Image tag. Pin a release or `sha-<short>` tag for reproducible deployments. |
| `HANSE_BIND` | `127.0.0.1` | Host address for port 8787. Set `0.0.0.0` (or a LAN IP) to expose it. |
| `HANSE_PORT` | `8787` | Host port mapped to the coordinator. |
| `HANSE_WORKSPACE` | `./workspace` | Host path for projects and applications. |
| `HANSE_STATE` | `./state` | Host path for coordinator state. Keep it private. |
| `HANSE_BUILD_IMAGE` | `hanse:dev` | Local image tag used by the source-build overlay. |
| `HANSE_HOST_AUTH_FILE` | - | Required only by `compose.host-auth.yaml`; path to a host `auth.json`. |

The coordinator also receives `HANSE_STATE_HOME=/data/state`, `HANSE_IDE_URL=/ide/`, and the proxy
target for the IDE service. These are internal to the Compose file and normally do not need to be
overridden.

### Volumes and permissions

- `./workspace` -> `/data/workspace`: projects and applications. Shared by the coordinator and the IDE.
- `./state` -> `/data/state`: the coordinator database (`coordinator.db` with WAL/SHM), the secret
  key, per-instance `opencode` state, and the reconciled `auth.json` files. Mounted into the
  coordinator only, never into the IDE.

The containers run as uid/gid 1000. Files created by another uid (for example by `sudo`) break
writes. Repair with `sudo chown -R 1000:1000 workspace state`.

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

Caddy handles the HTTP and WebSocket upgrade used by `/ide/` automatically. With nginx, set
`proxy_http_version 1.1` and forward the `Upgrade`/`Connection` headers for `/ide/`.

Security model, in short:

- One operator token, no user accounts or per-user isolation.
- Agents run as the same uid as the coordinator inside the `hanse` container. They can read the
  state directory, including the database and `secret.key`. Run only projects you trust, and use a
  dedicated host or VM.
- The login cookie is `HttpOnly` and `SameSite=Strict`; serve the UI over HTTPS when it is not on
  loopback.
- `no-new-privileges` is set on both services. Do not add host networking or privileged mode.
- Rotate the token by changing `HANSE_OPERATOR_TOKEN` in `.env` and running
  `docker compose up -d`. The coordinator re-upserts the operator principal on start.

## Updating and rollback

```bash
docker compose pull
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

## Build from source

```bash
git clone https://github.com/ArKaNeMaN/hanse.git
cd hanse
cp .env.example .env
# set HANSE_OPERATOR_TOKEN in .env
docker compose -f compose.yaml -f compose.build.yaml up -d --build
```

The source-build overlay tags the result as `hanse:dev` (override with `HANSE_BUILD_IMAGE`) so it does
not overwrite the published tag. The build needs network access and several GB of disk. It compiles
TypeScript and Tailwind, installs production dependencies for the target architecture, then installs
`opencode`, the OMO baseline, and CodeGraph.

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
| `CODE_SERVER_VERSION` | `4.141.0` | Base image tag for code-server. |
| `OPENCODE_VERSION` | `1.19.3` | `opencode-ai` package. |
| `OMO_VERSION` | `5.1.35` | `oh-my-openagent` baseline. |
| `CODEGRAPH_VERSION` | `1.6.2` | `@colbymchenry/codegraph`. |
| `VSCODE_THEME_VERSION` | `6.3.5` | GitHub theme installed into code-server. |
| `VERSION`, `REVISION` | `0.1.0`, `unknown` | OCI labels; the publish workflow sets them. |

The runtime image extends the official `codercom/code-server` image and adds a Node 22 binary for the
coordinator. code-server keeps its own bundled Node for the IDE. This keeps native modules aligned
with `.nvmrc` and CI while avoiding a hand-copied code-server installation.

### Multi-arch build

```bash
docker buildx build \
  --platform linux/amd64,linux/arm64 \
  -t ghcr.io/arkaneman/hanse:dev \
  --push .
```

Use `--load` instead of `--push` for a single-platform local image. The publish workflow builds both
architectures and pushes provenance and SBOM attestations.

## Health checks and logs

```bash
docker compose ps
curl -fsS http://127.0.0.1:8787/healthz   # {"status":"ok"}
curl -s -o /dev/null -w '%{http_code}\n' http://127.0.0.1:8787/          # 303 to /login
curl -s -o /dev/null -w '%{http_code}\n' http://127.0.0.1:8787/assets/app.css  # 200
docker compose logs -f --tail=100 hanse
docker compose logs -f --tail=100 ide
```

Both services define health checks. `hanse` is healthy when `/healthz` answers; `hanse-ide` is healthy
when code-server answers on port 8080. The IDE service waits for the coordinator to become healthy
before it starts.

## Backup and restore

Back up both volumes and the deployment files:

```bash
docker compose stop
files=(workspace state .env compose.yaml)
[ -f compose.override.yaml ] && files+=(compose.override.yaml)
tar czf "hanse-$(date +%F).tgz" "${files[@]}"
docker compose start
```

Stop the containers first so SQLite and the per-instance state are consistent. The backup contains:

- `workspace/` - the projects and applications (git repositories).
- `state/` - the coordinator DB, `secret.key`, and per-instance state. **Keep it private.** Losing
  `secret.key` makes encrypted provider keys undecryptable; restoring an older DB can restore
  revoked keys.
- `.env` and any Compose override files.

Restore:

```bash
docker compose down
mv state state.broken
mv workspace workspace.broken
tar xzf hanse-<date>.tgz
sudo chown -R 1000:1000 workspace state
docker compose up -d
```

## Git workbench credentials

The application page can fetch, update, commit, and push using the coordinator container's ambient
git configuration. Git is not wired to the encrypted provider-key store.

- **Commit identity**: set `user.name`/`user.email` in each repository or in the container's git
  config, or add `GIT_AUTHOR_NAME`, `GIT_AUTHOR_EMAIL`, `GIT_COMMITTER_NAME`, and
  `GIT_COMMITTER_EMAIL` to the `hanse` service. Without an identity the Commit action is disabled.
- **Push/fetch credentials**: mount an SSH key and `known_hosts`, or inject `GIT_ASKPASS` /
  `GIT_SSH_COMMAND`. Git runs with `GIT_TERMINAL_PROMPT=0`, so a missing credential fails instead of
  prompting.
- **Trusted remotes only**: `git fetch --all --prune` contacts every remote configured in the
  application repository. Repository hooks run as uid 1000 on commit/update.

## Troubleshooting

- **Permission denied under `/data/state` or `/data/workspace`**: the bind mounts are not writable by
  uid 1000. Run `sudo chown -R 1000:1000 workspace state`.
- **Port already allocated**: change `HANSE_PORT`, or stop the process using 8787.
- **`pull access denied` for GHCR**: the package is private or you are not signed in. Run
  `docker login ghcr.io`, or make the package public in its GitHub package settings.
- **`exec format error` / wrong architecture**: check `uname -m`. The published image supports
  `linux/amd64` and `linux/arm64`; use a matching host or build locally.
- **`auth.json` is read as a directory**: the host file did not exist when Docker created the bind
  mount. Create/authenticate the host file first, then recreate the container.
- **Container restart loop**: `docker compose logs --tail=50 hanse`. Permission errors and an
  unreadable `auth.json` are common causes.
- **IDE shows a blank page or disconnects**: check `docker compose logs ide`; make sure the coordinator
  can resolve the `ide` service and that a reverse proxy forwards WebSocket upgrades for `/ide/`.
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
- **Git push/fetch fails**: check ambient SSH/HTTPS credentials and host-key trust. Inspect the commit
  identity with `git -C /data/workspace/<project>/<app> var GIT_AUTHOR_IDENT`.
- **Application page says "Not a repository root"**: the app directory is inside a larger git
  repository. Move the repository root to the app directory or use the IDE.
- **Old containers after an upgrade**: `docker compose up -d --remove-orphans`.
- **Settings show "Restart required"**: settings never restart agents. Use the restart action; an
  active turn is interrupted and sessions are kept.

## Maintainers: publishing to GHCR

`.github/workflows/publish.yml` builds `linux/amd64` and `linux/arm64` and pushes to
`ghcr.io/<owner>/hanse` on every push to `main`, on `v*` tags, and on manual dispatch.

Tags produced:

- `main` and `sha-<short>` for branch builds.
- `latest` on the default branch.
- `0.1.0` and `0.1` for a `v0.1.0` tag.

The workflow uses `GITHUB_TOKEN` (`packages: write`), so no long-lived registry secret is needed.
GitHub Packages requires the image name to be lowercase; the workflow computes it from
`GITHUB_REPOSITORY`. The first publish may create a private package; the workflow tries to make it
public and ignores failure, so check **Package settings -> Change visibility** once if anonymous pulls
fail.

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
  [`docs/current-state.md`](current-state.md#known-limits-and-security-notes) for the full list.
- Agents share the coordinator uid inside the container and can read `state`; they are not a sandbox.
- Database migrations are forward-only.
- The image is large (code-server, `opencode`, OMO, and CodeGraph are bundled).
- `latest` moves with `main`; pin a tag for production.
