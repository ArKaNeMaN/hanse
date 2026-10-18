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

## Troubleshooting

- **Container restart loop**: `docker logs hanse --tail 50`. A common cause is a permissions error
  (e.g. a root-owned path read by uid 1000).
- **IDE extension not visible**: it must be installed via `code-server --install-extension` (the image
  does this). In the browser, run `Developer: Reload Window`.
- **Agent fails to start**: check that `/run/hanse/auth.json` is mounted and readable; check code-server
  and opencode logs.
- **`git clone` fails on add-app**: the image installs `git` + `ca-certificates`; a TLS error means the
  CA bundle is missing.
- **Old containers**: `docker compose up -d --remove-orphans` removes the retired `ide` service variant.
