# Deployment and operations

> Current architecture and behavior: `docs/current-state.md`. This file is about running it.

## Prerequisites

- A Linux host reachable on the LAN (reference: `deployment-host`, LAN IP `<LAN_HOST>`).
- Docker + Docker Compose v2.
- A model credential for `opencode` on the host at `~/.local/share/opencode/auth.json` (it is mounted
  read-only into the coordinator and copied into each instance).
- SSH access to the host (deployment is done over SSH).

## What runs

`docker-compose.yml` defines two services from one image:

- `hanse` - coordinator (web UI, API, MCP, agents). Exposes `<LAN_HOST>:8787`. Mounts
  `./workspace`, `./state`, and the host `auth.json`.
- `hanse-ide` - code-server + the bundled extension. Mounts only `./workspace`. Not exposed; reached via
  the `hanse` proxy at `/ide/`.

Both run as uid 1000.

## Configuration (`.env`)

Create `.env` next to `docker-compose.yml`:

```env
HANSE_OPERATOR_TOKEN=<long random token>
```

- The token is the single login for the UI and the IDE (and the extension's API calls).
- `CODE_SERVER_PASSWORD` is no longer used (the IDE has no separate password).
- Never commit `.env`.

## Deploy / update

From the repository root (reference: local `dev/hanse` -> host `<INSTALL_DIR>`):

```bash
tar czf - --exclude=node_modules --exclude=.git --exclude=.omo --exclude=dist \
  --exclude='*.log' --exclude=state . \
  | ssh deployment-host 'tar xzf - -C <INSTALL_DIR>'

ssh deployment-host 'cd <INSTALL_DIR> && docker compose build && docker compose up -d --remove-orphans'
```

The image build installs `opencode-ai`, code-server (copied from `codercom/code-server`), git +
CA certificates, the bundled VSIX extension, and the GitHub theme. It needs network access.

## Ports and volumes

- Public: `<LAN_HOST>:8787` (LAN only). Everything else is internal to the compose network.
- `./workspace` -> `/data/workspace` (projects and applications; shared by both containers).
- `./state` -> `/data/state` (coordinator DB, secret key, per-instance opencode state; **coordinator
  only**).

## Health checks

```bash
docker compose ps
curl -s -o /dev/null -w '%{http_code}\n' -H "Cookie: hanse_token=$TOKEN" http://<LAN_HOST>:8787/
curl -s -o /dev/null -w '%{http_code}\n' http://<LAN_HOST>:8787/assets/app.css
curl -s -o /dev/null -w '%{http_code}\n' -H "Cookie: hanse_token=$TOKEN" 'http://<LAN_HOST>:8787/ide/?folder=/data/workspace/<project>'
```

## Backup

- Projects/apps: back up `<INSTALL_DIR>/workspace` (git repositories).
- Coordinator state: back up `<INSTALL_DIR>/state` (SQLite DB + secret key). Keep it private.

## Rotating the operator token

```bash
ssh deployment-host 'cd <INSTALL_DIR> && sed -i "s/^HANSE_OPERATOR_TOKEN=.*/HANSE_OPERATOR_TOKEN=<new>/" .env && docker compose up -d'
```

Restarting re-upserts the operator principal with the new token.

## Git workbench credentials

The application page can fetch, update, commit, and push with the `hanse` container's ambient git
configuration. This stage does not wire the coordinator's encrypted credential store into git.

- **Commit identity**: configure `user.name`/`user.email` in each repository or in the container's
  git config, or inject `GIT_AUTHOR_NAME`, `GIT_AUTHOR_EMAIL`, `GIT_COMMITTER_NAME`, and
  `GIT_COMMITTER_EMAIL` into the `hanse` service environment. Without an identity the Commit action
  is disabled with an explanatory hint.
- **Push/fetch credentials**: mount an SSH key (and `known_hosts`) into the container, or inject
  `GIT_ASKPASS` / `GIT_SSH_COMMAND`. Git runs with `GIT_TERMINAL_PROMPT=0`, so a missing credential
  fails fast instead of prompting.
- **Trusted remotes only**: `git fetch --all --prune` contacts every remote configured in the
  application repository. Repository hooks run as the coordinator uid on commit/update.

## Troubleshooting

- **Container restart loop**: `docker logs hanse --tail 50`. A common cause is a permissions error
  (e.g. a root-owned path read by uid 1000).
- **IDE extension not visible**: it must be installed via `code-server --install-extension` (the image
  does this). In the browser, run `Developer: Reload Window`.
- **Agent fails to start**: check that `/run/hanse/auth.json` is mounted and readable; check code-server
  and opencode logs.
- **`git clone` fails on add-app**: the image installs `git` + `ca-certificates`; a TLS error means the
  CA bundle is missing.
- **Git push/fetch fails in the application page**: check the container's ambient SSH/HTTPS
  credentials and host-key trust; `GIT_TERMINAL_PROMPT=0` means git will not prompt. Check commit
  identity with `git -C /data/workspace/<project>/<app> var GIT_AUTHOR_IDENT`.
- **Application page shows "Not a repository root"**: the application directory is inside a larger
  git repository. Move the repository root to the application directory or use the IDE for that
  repository.
- **Old containers**: `docker compose up -d --remove-orphans` removes the retired `ide` service variant.
