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
- Full project/application deletion from the UI or human-only API: exact-name confirmation, durable
  retry markers, container/network/image cleanup, app state and manifest removal, optional source-file
  deletion, and preserved SSH audit/global settings.
- One isolated `opencode` instance per application (own XDG state and DB; model auth copied in),
  hosted by a separate agent runtime container on the default toolchain image.
- Global/project/application settings in the coordinator DB, with an encrypted provider-key store, a
  selectable model that also applies to OMO agents/categories, and human-only settings pages.
- Optional per-tool web drivers: built-in OMO/opencode tools or the DeepSeek standalone Search/Fetch
  APIs, exposed through the managed `hanse_web` MCP server only when configured.
- Explicit "restart required" markers and a restart action; settings never restart agents silently.
- Integrated chat with agents: sessions, messages, SSE updates, tool-call/diff rendering.
- Application page with a lightweight git workbench: status, fetch, fast-forward update, local branch
  switch, commit, and push.
- Operator-defined SSH hosts with per-application allowlists, coordinator-held keys, idle-based
  approvals in chat, arbitrary `ssh_exec`, SFTP upload/download, host-key pinning, and audit.
- Optional per-app images from `.hanse/Dockerfile` (`ARG HANSE_BASE`), built on a human action,
  validated in a locked-down container, with status/logs, stale detection, two-version rollback, and
  explicit GC.
- Agent-driven handoffs via MCP tools (`request_sibling_change`, `list_apps`, `handoff_status`,
  `deliver_handoff`) with human approval in the dashboard.
- A single operator login for the UI and the web IDE (no separate IDE password).
- Embedded web IDE (code-server) at `/ide/`: opened in the selected project/application, GitHub Dark
  Dimmed theme, a bundled "Hanse Agent" chat extension with tabs per app, and a terminal rooted in the
  opened folder.
- Human-only operator terminal per application: a coordinator-proxied WebSocket/TTY exec in the
  managed app container, with no operator or runtime token exposed to the app.
- Docker Compose deployment from coordinator, IDE, runner, and agent images, intended for a trusted
  LAN. Published images are `linux/amd64`; arm64 is built on demand until it returns to the default
  publish matrix.

## Run it

The published images are `ghcr.io/arkaneman/hanse` (coordinator),
`ghcr.io/arkaneman/hanse-agent-ide` (IDE), `ghcr.io/arkaneman/hanse-runner` (runner), and
`ghcr.io/arkaneman/hanse-agent-default` (per-app agents), for `linux/amd64`:

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
docker pull "ghcr.io/arkaneman/hanse-agent-default:${HANSE_TAG:-latest}"
docker compose up -d
```

Open <http://127.0.0.1:8787> and sign in with the token. The coordinator binds loopback by default;
set `HANSE_BIND=0.0.0.0` to expose it on the LAN.

The full guide covers model credentials, LAN/TLS exposure, backups (including `agents`), upgrades,
source builds, image publishing, and troubleshooting: [`docs/deployment.md`](docs/deployment.md).

## Read first

- [`docs/current-state.md`](docs/current-state.md) - the canonical description of what is implemented now.
- [`docs/deployment.md`](docs/deployment.md) - how to run and operate it.
- [`docs/conventions.md`](docs/conventions.md) - the `.hanse/` project/application manifests.
- [`docs/journal/0001-core.md`](docs/journal/0001-core.md) - the stage-by-stage history and decisions.

## Development

Requires Node.js >= 20 (the image and CI use Node 22).

```bash
npm install
npm run typecheck
npm test
npm run lint
npm run build        # tsc + Tailwind CSS -> dist/ and assets/app.css
node dist/index.js --help
```

Build the image from source with the Compose overlay:

```bash
docker compose -f compose.yaml -f compose.build.yaml up -d --build
```

## License

Not yet chosen. See [`LICENSE`](LICENSE).
