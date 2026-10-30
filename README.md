# hanse

[![CI](https://github.com/ArKaNeMaN/hanse/actions/workflows/ci.yml/badge.svg)](https://github.com/ArKaNeMaN/hanse/actions/workflows/ci.yml)
[![Container](https://img.shields.io/badge/container-ghcr.io%2Farkaneman%2Fhanse-blue)](https://github.com/ArKaNeMaN/hanse/pkgs/container/hanse)

> **Status: pre-alpha, functional core.** A self-hosted coordinator/workbench for projects of
> isolated `opencode` agent applications, with a web UI, integrated agent chat, cross-application
> handoffs, and an embedded web IDE.

`hanse` hosts **projects**, each containing **applications**. Every application runs as an isolated
[`opencode`](https://opencode.ai) agent instance, and applications can hand structured requests (specs
and requirements) to each other through the coordinator - like independent teams exchanging tickets.

## Features

- Project/application registry, and creating projects and adding applications from the UI (by path or
  `git clone`).
- Built-in **master agent** for operating Hanse itself: create projects and applications; create,
  inspect, update, enable/disable, and override global/project/application skill bundles; write
  application `AGENTS.md` contracts; change non-secret settings; and start/restart agents from a
  dedicated chat, with workspace-confined file tools, an allowlisted MCP surface, and an isolated
  read-only app directory. Skill deletion, revert, and rename stay manual.
- Full project/application deletion from the UI or human-only API: exact-name confirmation, durable
  retry markers, container/network/image cleanup, app state and manifest removal, optional source-file
  deletion, and preserved SSH audit/global settings.
- One isolated `opencode` instance per application (own XDG state and DB; model auth copied in),
  hosted by a separate agent runtime container on the default toolchain image.
- Global/project/application settings in the coordinator DB, with an encrypted provider-key store, a
  selectable model that also applies to OMO agents/categories, and human-only settings pages.
- Global custom model providers: a coordinator-owned OpenAI-compatible provider registry projected
  into every application's `opencode` config, with encrypted provider keys, restart semantics, and a
  settings UI.
- Global/project/application agent skill bundles in the coordinator DB: a generated `SKILL.md`
  plus `references/*.md`, structured metadata, an inventory and dedicated source/preview workspace,
  deterministic materialization into each isolated instance, collision warnings, explicit restart
  semantics, and deletion integration.
- Optional per-tool web drivers: built-in OMO/opencode tools or the DeepSeek standalone Search/Fetch
  APIs, exposed through the managed `hanse_web` MCP server only when configured.
- Explicit "restart required" markers and a restart action; settings never restart agents silently.
- Integrated chat with agents: sessions, messages, SSE updates, tool-call/diff rendering.
- Demo app previews: an agent exposes a service running in its app container at `/preview/...`, with
  an MCP tool, a chat tool-card link, and a conditional context-rail list (runner mode; same-origin
  demo risk accepted).
- Session context usage meter, manual compaction, and opt-in threshold-based auto-compaction with
  hierarchical settings and a server-side per-session context monitor.
- Application page with a lightweight git workbench: status, fetch, fast-forward update, local branch
  switch, commit, and push.
- Operator-defined SSH hosts with per-application allowlists, coordinator-held keys, idle-based
  approvals in chat, arbitrary `ssh_exec`, SFTP upload/download, host-key pinning, and audit.
- Optional per-app images from `.hanse/Dockerfile` (`ARG HANSE_BASE`), built on a human action,
  validated in a locked-down container, with status/logs, stale detection, two-version rollback, and
  explicit GC.
- Session-bound, autonomous agent handoffs via MCP tools (`request_sibling_change`, `list_apps`,
  `handoff_status`, `deliver_handoff`): the coordinator starts a fresh target session, routes the reply
  back into the source session, parks replies whose source session is gone for an operator relaunch,
  and enforces directed project policy with `auto`/`approve`/`deny` dispatch and reply approval.
- A single operator login for the UI and the web IDE (no separate IDE password).
- Embedded web IDE (code-server) at `/ide/`: opened in the selected project/application, GitHub Dark
  Dimmed theme, a bundled "Hanse Agent" chat extension with tabs per app, and a terminal rooted in the
  opened folder.
- Human-only operator terminal per application: a coordinator-proxied WebSocket/TTY exec in the
  managed app container, with no operator or runtime token exposed to the app.
- Docker Compose deployment from coordinator, IDE, runner, agent-base, and agent-default images,
  intended for a trusted LAN. Published images are `linux/amd64`; arm64 is built on demand until it
  returns to the default publish matrix.

## System requirements

Hanse runs as a Docker Compose stack. The coordinator, IDE, and runner are always up; each
application adds one agent container when it is used.

| Requirement | Minimum | Recommended |
| --- | --- | --- |
| Host OS / architecture | Linux `x86_64` (`linux/amd64`) | Linux `x86_64` |
| Container runtime | Docker Engine 24+ with Compose v2, rootful daemon | Current Docker Engine + Compose plugin |
| CPU | 2 cores | 4+ cores |
| RAM | 4 GB | 8-16 GB |
| Free disk | 20 GB | 40+ GB on SSD |
| Client | A current browser with WebSocket support | Same |

- **Network:** outbound HTTPS to GHCR, the model provider, and git remotes; outbound SSH for
  operator-defined SSH hosts. Inbound TCP 8787 only if the UI is exposed; use a TLS reverse proxy
  beyond a trusted LAN.
- **Model access:** a provider API key or a host `opencode` login.

**Sizing.** The minimum in the table assumes the default 2 GB app cap and covers the idle
coordinator/IDE/runner plus one small app. Each app container is capped at 2 GB of RAM and 2 CPUs by
default (`HANSE_APP_MEMORY_MB`, `HANSE_APP_CPUS`); raise the host budget by the same amount if you
raise the cap. Apps often idle below the cap, but plan for it when several are active. For 1-3 apps
at the default cap, use 4 cores / 8 GB / 40 GB free. For 5+ apps or frequent builds, use 8 cores /
16 GB / 80 GB free. The five images take roughly 7-8 GB, and
the `agents` volume grows by roughly 1-2 GB per app as toolchains and caches are installed; custom
images and the Docker build cache add more. Keep well below the thresholds: Hanse warns at 75% used
and reports critical at 85%, so target at least 30% free.

The published images are `linux/amd64`. On arm64 hosts, build them locally. Docker Desktop on macOS
or Windows/WSL2 works, including for evaluation; Linux `amd64` is the production target. No GPU is
required for the default setup: model inference runs at the configured provider.

Rootless Docker is not supported by the default stack: the runner needs the Docker socket from a
rootful daemon. Bind mounts run as uid/gid 1000, so `workspace`, `state`, and `agents` must be
writable by that uid (`sudo chown -R 1000:1000 workspace state agents`).

Only the coordinator publishes a port (`127.0.0.1:8787` by default). The IDE, previews, and app
terminals are proxied through it. Set `HANSE_BIND=0.0.0.0` only on a trusted LAN; terminate TLS in a
reverse proxy for anything beyond that.

Development without Docker needs Node.js >= 20.19.0 (CI and the images use Node 22) and npm.

The full deployment guide, including LAN/TLS exposure, backups, and upgrades, is in
[`docs/deployment.md`](docs/deployment.md).

## Run it

The published images are `ghcr.io/arkaneman/hanse` (coordinator),
`ghcr.io/arkaneman/hanse-agent-base` (shared agent base),
`ghcr.io/arkaneman/hanse-agent-default` (per-app agents), `ghcr.io/arkaneman/hanse-agent-ide` (IDE),
and `ghcr.io/arkaneman/hanse-runner` (runner), for `linux/amd64`:

```bash
mkdir -p hanse && cd hanse
curl -fsSLO https://raw.githubusercontent.com/ArKaNeMaN/hanse/main/compose.yaml
curl -fsSLO https://raw.githubusercontent.com/ArKaNeMaN/hanse/main/.env.example
cp .env.example .env
TOKEN=$(python3 -c 'import secrets; print(secrets.token_urlsafe(32))')
RUNTIME_TOKEN=$(python3 -c 'import secrets; print(secrets.token_urlsafe(32))')
sed -i.bak "s|^HANSE_OPERATOR_TOKEN=.*|HANSE_OPERATOR_TOKEN=$TOKEN|; s|^HANSE_RUNTIME_TOKEN=.*|HANSE_RUNTIME_TOKEN=$RUNTIME_TOKEN|" .env && rm -f .env.bak
echo "operator token: $TOKEN"
mkdir -p workspace state agents
ROOT=$(pwd)
sed -i.bak "s|^# HANSE_HOST_WORKSPACE=.*|HANSE_HOST_WORKSPACE=$ROOT/workspace|; s|^# HANSE_HOST_AGENTS=.*|HANSE_HOST_AGENTS=$ROOT/agents|" .env && rm -f .env.bak
sudo chown -R 1000:1000 workspace state agents
docker compose pull
set -a; . ./.env; set +a
docker pull "${HANSE_AGENT_IMAGE:-ghcr.io/arkaneman/hanse-agent-default}:${HANSE_AGENT_TAG:-${HANSE_TAG:-latest}}"
docker compose up -d
```

Open <http://127.0.0.1:8787> and sign in with the token. The coordinator binds loopback by default;
set `HANSE_BIND=0.0.0.0` to expose it on the LAN.

`GET /healthz` is the liveness check. For deployment automation, `GET /readyz` reports the version,
image revision, schema version, deployment-lock state, and in-flight lifecycle count.

The full guide covers model credentials, LAN/TLS exposure, backups (including `agents`), upgrades,
source builds, image publishing, and troubleshooting: [`docs/deployment.md`](docs/deployment.md).

## Read first

- [`docs/current-state.md`](docs/current-state.md) - the canonical description of what is implemented now.
- [`docs/deployment.md`](docs/deployment.md) - how to run and operate it.
- [`docs/conventions.md`](docs/conventions.md) - the `.hanse/` project/application manifests.
- [`docs/journal/0001-core.md`](docs/journal/0001-core.md) - the stage-by-stage history and decisions.

## Development

Requires Node.js >= 20.19.0 (the image and CI use Node 22).

```bash
npm install
npm run typecheck
npm test
npm run lint
npm run build        # tsc + Tailwind CSS + Vite UI -> dist/, assets/app.css, assets/ui/
node dist/index.js --help
```

`/` (fleet overview), `/projects`, `/projects/:id`, `/projects/:id/apps/:app`, `/handoffs`, `/ssh`,
the three settings scopes, the five skills routes, `/terminal`, and `/chat` are served by the
Vue/Vite client, which lives under `ui/` and builds into `assets/ui/`. Chat and terminal keep the
frozen legacy documents as their rollback path. The coordinator chooses the renderer through the
shared registry and `HANSE_UI_SPA_ROUTES`; `HANSE_UI_LEGACY=1` (or `?legacy=1` on a page) forces the
legacy renderer. Run the client dev server with `npm run dev:ui` and the coordinator with
`HANSE_UI_DEV_URL=http://127.0.0.1:5173` to load Vite modules from the dev server;
`npm run check:ui-dev` is an optional Vite-entry smoke that is not part of CI. See
[`docs/deployment.md`](docs/deployment.md) and [`docs/current-state.md`](docs/current-state.md).

Build the image from source with the Compose overlay:

```bash
docker compose -f compose.yaml -f compose.build.yaml up -d --build
```

## License

Not yet chosen. See [`LICENSE`](LICENSE).
