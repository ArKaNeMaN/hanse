# syntax=docker/dockerfile:1.7

# Pinned toolchain versions. Bump these deliberately and re-run the container smoke test.
ARG NODE_VERSION=22
ARG CODE_SERVER_VERSION=4.141.0
ARG OPENCODE_VERSION=1.19.3
ARG OMO_VERSION=5.1.35
ARG CODEGRAPH_VERSION=1.6.2
ARG VSCODE_THEME_VERSION=6.3.5
ARG MISE_VERSION=2026.10.14
ARG UV_VERSION=0.9.5
ARG PYTHON_VERSION=3.12
ARG PHP_VERSION=8.3

# TypeScript and CSS output are architecture-independent, so build them on the host platform.
FROM --platform=$BUILDPLATFORM node:${NODE_VERSION}-bookworm-slim AS build
WORKDIR /app
COPY package.json package-lock.json ./
# The build stage only runs tsc and Tailwind; better-sqlite3 is compiled for the target in `deps`.
RUN npm ci --ignore-scripts --no-audit --no-fund
COPY tsconfig.json ./
COPY src ./src
COPY assets ./assets
RUN npm run build

# Production dependencies for the target architecture. better-sqlite3 is a native module, so this
# stage must run on the target platform (or under emulation) rather than on the build host.
FROM --platform=$TARGETPLATFORM node:${NODE_VERSION}-bookworm-slim AS deps
WORKDIR /app
COPY package.json package-lock.json ./
RUN apt-get update \
 && apt-get install -y --no-install-recommends python3 make g++ \
 && npm ci --omit=dev --no-audit --no-fund \
 && npm cache clean --force \
 && apt-get purge -y --auto-remove python3 make g++ \
 && rm -rf /var/lib/apt/lists/*

# opencode ships one self-contained binary per platform. The postinstall hardlinks the selected
# binary into bin/opencode.exe, so the optional per-platform packages can be dropped afterwards.
FROM --platform=$TARGETPLATFORM node:${NODE_VERSION}-bookworm-slim AS opencode
ARG OPENCODE_VERSION
RUN npm install -g --no-audit --no-fund opencode-ai@${OPENCODE_VERSION} \
 && rm -rf /usr/local/lib/node_modules/opencode-ai/node_modules/opencode-* \
 && npm cache clean --force \
 && opencode --version

# Baseline OMO build for managed opencode instances. Installed once into the image and referenced by
# HANSE_OMO_PLUGIN, so per-app caches do not have to download it on first start.
FROM --platform=$TARGETPLATFORM node:${NODE_VERSION}-bookworm-slim AS omo
ARG OMO_VERSION
RUN mkdir -p /opt/hanse/omo
WORKDIR /opt/hanse/omo
RUN npm init -y >/dev/null 2>&1 \
 && npm install --ignore-scripts --omit=dev --no-audit --no-fund oh-my-openagent@${OMO_VERSION} \
 && npm cache clean --force

FROM --platform=$TARGETPLATFORM node:${NODE_VERSION}-bookworm-slim AS codegraph
ARG CODEGRAPH_VERSION
RUN mkdir -p /opt/hanse/codegraph
WORKDIR /opt/hanse/codegraph
RUN npm init -y >/dev/null 2>&1 \
 && npm install --omit=dev --no-audit --no-fund @colbymchenry/codegraph@${CODEGRAPH_VERSION} \
 && npm cache clean --force

# The coordinator runs on Node 22 (matching .nvmrc and CI). The code-server base image bundles its
# own Node for the IDE; copying Node 22 keeps native module ABI and the project runtime aligned.
FROM --platform=$TARGETPLATFORM node:${NODE_VERSION}-bookworm-slim AS nodejs

# Extending the official code-server image gives us a maintained IDE with its native libraries,
# git, curl, ca-certificates, and dumb-init, instead of copying /usr/lib/code-server by hand.
FROM codercom/code-server:${CODE_SERVER_VERSION} AS runtime

ARG VERSION=0.1.0
ARG REVISION=unknown
ARG VSCODE_THEME_VERSION

LABEL org.opencontainers.image.title="hanse" \
      org.opencontainers.image.description="Self-hosted coordinator/workbench for projects of isolated opencode agent applications." \
      org.opencontainers.image.source="https://github.com/ArKaNeMaN/hanse" \
      org.opencontainers.image.url="https://github.com/ArKaNeMaN/hanse" \
      org.opencontainers.image.documentation="https://github.com/ArKaNeMaN/hanse/blob/main/docs/deployment.md" \
      org.opencontainers.image.version="${VERSION}" \
      org.opencontainers.image.revision="${REVISION}" \
      org.opencontainers.image.licenses="NOASSERTION"

USER root
ENV NODE_ENV=production \
    HOME=/home/coder \
    HANSE_OMO_PLUGIN=file:///opt/hanse/omo/node_modules/oh-my-openagent \
    HANSE_CODEGRAPH_BIN=/opt/hanse/codegraph/node_modules/.bin/codegraph

WORKDIR /app
COPY --from=nodejs /usr/local/bin/node /usr/local/bin/node
COPY --from=deps /app/node_modules ./node_modules
COPY --from=build /app/dist ./dist
COPY --from=build /app/assets ./assets
COPY package.json LICENSE ./
COPY extensions ./extensions
COPY shell/hanse-shell /usr/local/bin/hanse-shell
COPY omo/omo.jsonc /home/coder/.omo/omo.jsonc
COPY --from=opencode /usr/local/lib/node_modules/opencode-ai /usr/local/lib/node_modules/opencode-ai
COPY --from=omo /opt/hanse/omo /opt/hanse/omo
COPY --from=codegraph /opt/hanse/codegraph /opt/hanse/codegraph

RUN ln -sf ../lib/node_modules/opencode-ai/bin/opencode.exe /usr/local/bin/opencode \
 && chmod 0755 /usr/local/bin/hanse-shell \
 && code-server --install-extension /app/extensions/hanse-agent.vsix --extensions-dir /opt/hanse-ext --force \
 && code-server --install-extension GitHub.github-vscode-theme@${VSCODE_THEME_VERSION} --extensions-dir /opt/hanse-ext --force \
 && mkdir -p /home/coder/.config/code-server/User /data/workspace /data/state \
 && printf '%s' '{"workbench.colorTheme":"GitHub Dark Dimmed","workbench.startupEditor":"none","chat.commandCenter.enabled":false,"terminal.integrated.profiles.linux":{"hanse":{"path":"/usr/local/bin/hanse-shell"}},"terminal.integrated.defaultProfile.linux":"hanse"}' > /home/coder/.config/code-server/User/settings.json \
 && node --version \
 && opencode --version \
 && code-server --version \
 && chown -R coder:coder /home/coder /opt/hanse-ext /data /app/extensions

USER coder

EXPOSE 8787

HEALTHCHECK --interval=30s --timeout=5s --start-period=30s --retries=3 \
  CMD ["node", "-e", "fetch('http://127.0.0.1:8787/healthz').then((r) => process.exit(r.ok ? 0 : 1)).catch(() => process.exit(1))"]

ENTRYPOINT ["/usr/bin/dumb-init", "--"]
CMD ["node", "dist/index.js", "serve", "--workspace", "/data/workspace", "--hostname", "0.0.0.0", "--port", "8787"]

# ---------------------------------------------------------------------------
# Agent images
#
# The coordinator (runtime) and agents are split into separate images: agents never contain the
# coordinator source or /data/state, and the coordinator never contains application toolchains.
# ---------------------------------------------------------------------------

# Pinned single-binary tools, exposed as stages because COPY --from cannot interpolate an ARG in an
# external image reference with the Dockerfile frontend in use.
FROM ghcr.io/jdx/mise:${MISE_VERSION} AS mise
FROM ghcr.io/astral-sh/uv:${UV_VERSION} AS uv

# Python 3.12 (bookworm, matching agent-base) as a copyable, prebuilt toolchain.
FROM python:${PYTHON_VERSION}-slim-bookworm AS python-toolchain

# Python 3.12 (trixie) for agent-ide, which is based on the Debian 13 code-server image.
FROM python:${PYTHON_VERSION}-slim-trixie AS python-toolchain-trixie

# The agent runtime: Node 22, opencode, the Hanse CLI, mise, OMO, codegraph, git, OpenSSH client.
# No application toolchains and no /data/state. `hanse agent-host` is added in B0.4; the CMD is
# declared now so the image surface is stable, and the build only validates the CLI itself.
FROM --platform=$TARGETPLATFORM node:${NODE_VERSION}-bookworm-slim AS agent-base

ARG MISE_VERSION
ARG VERSION=0.1.0
ARG REVISION=unknown

LABEL org.opencontainers.image.title="hanse-agent-base" \
      org.opencontainers.image.description="Hanse agent base image: Node, opencode, Hanse CLI, mise, OMO, codegraph." \
      org.opencontainers.image.source="https://github.com/ArKaNeMaN/hanse" \
      org.opencontainers.image.url="https://github.com/ArKaNeMaN/hanse" \
      org.opencontainers.image.documentation="https://github.com/ArKaNeMaN/hanse/blob/main/docs/deployment.md" \
      org.opencontainers.image.version="${VERSION}" \
      org.opencontainers.image.revision="${REVISION}" \
      org.opencontainers.image.licenses="NOASSERTION"

ENV NODE_ENV=production \
    HOME=/home/agent \
    HANSE_OMO_PLUGIN=file:///opt/hanse/omo/node_modules/oh-my-openagent \
    HANSE_CODEGRAPH_BIN=/opt/hanse/codegraph/node_modules/.bin/codegraph

# `git` only recommends `ssh-client`; `--no-install-recommends` would omit it and break SSH remotes.
RUN apt-get update \
 && apt-get install -y --no-install-recommends \
      bash ca-certificates curl dumb-init git openssh-client xz-utils \
 && rm -rf /var/lib/apt/lists/* \
 && if getent passwd 1000 >/dev/null; then userdel -r "$(getent passwd 1000 | cut -d: -f1)" || true; fi \
 && if getent group 1000 >/dev/null; then groupdel "$(getent group 1000 | cut -d: -f1)" || true; fi \
 && groupadd --gid 1000 agent \
 && useradd --uid 1000 --gid agent --create-home --home-dir /home/agent --shell /bin/bash agent \
 && mkdir -p /data/workspace /data/agents /app \
 && chown -R agent:agent /home/agent /data/workspace /data/agents

WORKDIR /app
COPY --from=deps /app/node_modules ./node_modules
COPY --from=build /app/dist ./dist
COPY package.json LICENSE ./
COPY --from=opencode /usr/local/lib/node_modules/opencode-ai /usr/local/lib/node_modules/opencode-ai
COPY --from=omo /opt/hanse/omo /opt/hanse/omo
COPY --from=codegraph /opt/hanse/codegraph /opt/hanse/codegraph
COPY --from=mise /usr/local/bin/mise /usr/local/bin/mise
COPY shell/hanse-agent-entrypoint /usr/local/bin/hanse-agent-entrypoint

RUN ln -sf ../lib/node_modules/opencode-ai/bin/opencode.exe /usr/local/bin/opencode \
 && printf '%s\n' '#!/bin/sh' 'exec node /app/dist/index.js "$@"' > /usr/local/bin/hanse \
 && chmod 0755 /usr/local/bin/hanse /usr/local/bin/hanse-agent-entrypoint \
 && node --version \
 && opencode --version \
 && mise --version \
 && ssh -V \
 && hanse --help >/dev/null \
 && chown -R agent:agent /app /home/agent

USER 1000:1000
ENTRYPOINT ["/usr/bin/dumb-init", "--"]
CMD ["hanse", "agent-host"]

# Default application environment: Python 3.12, Node 22, PHP 8.3, uv, build-essential and common
# development libraries. Go, Rust, and Java are deliberately absent; projects install them per app
# with mise into a per-app MISE_DATA_DIR.
FROM agent-base AS agent-default

ARG PHP_VERSION
ARG UV_VERSION

LABEL org.opencontainers.image.title="hanse-agent-default" \
      org.opencontainers.image.description="Hanse default agent environment: Python, Node, PHP, uv, build tools."

USER root
RUN apt-get update \
 && apt-get install -y --no-install-recommends \
      build-essential pkg-config \
      libssl-dev libffi-dev zlib1g-dev libsqlite3-dev libpq-dev libxml2-dev \
      libonig-dev libicu-dev libzip-dev libpng-dev libjpeg-dev libfreetype6-dev \
      libbz2-dev libreadline-dev liblzma-dev libargon2-1 libsodium23 \
      jq ripgrep postgresql-client default-mysql-client redis-tools \
 && rm -rf /var/lib/apt/lists/*

COPY --from=python-toolchain /usr/local /usr/local
COPY scripts/install-php.sh /tmp/install-php.sh
RUN sh /tmp/install-php.sh bookworm "$PHP_VERSION" \
 && rm -f /tmp/install-php.sh
COPY --from=uv /uv /usr/local/bin/uv

RUN node --version \
 && python3 --version \
 && php -m >/dev/null \
 && uv --version \
 && cc --version >/dev/null \
 && mise --version \
 && chown -R agent:agent /home/agent

USER 1000:1000

# Operator IDE image: default toolchains plus code-server, the Hanse extension, the safe shell, and
# the GitHub theme. It contains no /data/state and is the only agent-family image allowed to hold the
# operator token (at runtime, injected by Compose).
FROM codercom/code-server:${CODE_SERVER_VERSION} AS agent-ide

ARG MISE_VERSION
ARG PHP_VERSION
ARG UV_VERSION
ARG VSCODE_THEME_VERSION
ARG VERSION=0.1.0
ARG REVISION=unknown

LABEL org.opencontainers.image.title="hanse-agent-ide" \
      org.opencontainers.image.description="Hanse IDE image: code-server with the default agent toolchains." \
      org.opencontainers.image.source="https://github.com/ArKaNeMaN/hanse" \
      org.opencontainers.image.url="https://github.com/ArKaNeMaN/hanse" \
      org.opencontainers.image.documentation="https://github.com/ArKaNeMaN/hanse/blob/main/docs/deployment.md" \
      org.opencontainers.image.version="${VERSION}" \
      org.opencontainers.image.revision="${REVISION}" \
      org.opencontainers.image.licenses="NOASSERTION"

ENV NODE_ENV=production \
    HOME=/home/coder \
    HANSE_OMO_PLUGIN=file:///opt/hanse/omo/node_modules/oh-my-openagent \
    HANSE_CODEGRAPH_BIN=/opt/hanse/codegraph/node_modules/.bin/codegraph

USER root
RUN apt-get update \
 && apt-get install -y --no-install-recommends \
      build-essential pkg-config git ca-certificates curl xz-utils \
      libssl-dev libffi-dev zlib1g-dev libsqlite3-dev libpq-dev libxml2-dev \
      libonig-dev libicu-dev libzip-dev libpng-dev libjpeg-dev libfreetype6-dev \
      libbz2-dev libreadline-dev liblzma-dev libargon2-1 libsodium23 \
      jq ripgrep postgresql-client default-mysql-client redis-tools \
 && rm -rf /var/lib/apt/lists/*

COPY scripts/install-php.sh /tmp/install-php.sh
RUN sh /tmp/install-php.sh trixie "$PHP_VERSION" \
 && rm -f /tmp/install-php.sh

WORKDIR /app
COPY --from=deps /app/node_modules ./node_modules
COPY --from=build /app/dist ./dist
COPY --from=build /app/assets ./assets
COPY package.json LICENSE ./
COPY --from=nodejs /usr/local/bin/node /usr/local/bin/node
COPY --from=opencode /usr/local/lib/node_modules/opencode-ai /usr/local/lib/node_modules/opencode-ai
COPY --from=omo /opt/hanse/omo /opt/hanse/omo
COPY --from=codegraph /opt/hanse/codegraph /opt/hanse/codegraph
COPY --from=python-toolchain-trixie /usr/local /usr/local
COPY --from=uv /uv /usr/local/bin/uv
COPY --from=mise /usr/local/bin/mise /usr/local/bin/mise
COPY extensions ./extensions
COPY shell/hanse-shell /usr/local/bin/hanse-shell
COPY shell/hanse-agent-entrypoint /usr/local/bin/hanse-agent-entrypoint
COPY omo/omo.jsonc /home/coder/.omo/omo.jsonc

RUN ln -sf ../lib/node_modules/opencode-ai/bin/opencode.exe /usr/local/bin/opencode \
 && printf '%s\n' '#!/bin/sh' 'exec node /app/dist/index.js "$@"' > /usr/local/bin/hanse \
 && chmod 0755 /usr/local/bin/hanse /usr/local/bin/hanse-shell /usr/local/bin/hanse-agent-entrypoint \
 && mkdir -p /home/coder/.config/code-server/User /home/coder/.local/share/code-server /data/workspace \
 && printf '%s' '{"workbench.colorTheme":"GitHub Dark Dimmed","workbench.startupEditor":"none","chat.commandCenter.enabled":false,"security.workspace.trust.enabled":true,"security.workspace.trust.startupPrompt":"never","security.workspace.trust.emptyWindow":false,"task.autoDetect":"off","extensions.autoCheckUpdates":false,"extensions.autoUpdate":false,"terminal.integrated.profiles.linux":{"hanse":{"path":"/usr/local/bin/hanse-shell"}},"terminal.integrated.defaultProfile.linux":"hanse"}' > /home/coder/.config/code-server/User/settings.json \
 && code-server --install-extension /app/extensions/hanse-agent.vsix --extensions-dir /opt/hanse-ext --force \
 && code-server --install-extension GitHub.github-vscode-theme@${VSCODE_THEME_VERSION} --extensions-dir /opt/hanse-ext --force \
 && node --version \
 && python3 --version \
 && php -m >/dev/null \
 && uv --version \
 && mise --version \
 && code-server --version \
 && chown -R coder:coder /home/coder /opt/hanse-ext /data/workspace /app /opt/hanse

USER 1000:1000

EXPOSE 8080

ENTRYPOINT ["/usr/bin/dumb-init", "--"]
CMD ["code-server", "--auth", "none", "--bind-addr", "0.0.0.0:8080", "--disable-telemetry", "--disable-update-check", "--extensions-dir", "/opt/hanse-ext", "--user-data-dir", "/home/coder/.config/code-server", "/data/workspace"]

# Narrow B1/B2 runner: the only process holding the Docker socket. It has no coordinator state and
# no application data; the Docker Engine API is the only capability it needs.
FROM --platform=$TARGETPLATFORM node:${NODE_VERSION}-bookworm-slim AS runner

ARG VERSION=0.1.0
ARG REVISION=unknown

LABEL org.opencontainers.image.title="hanse-runner" \
      org.opencontainers.image.description="Hanse container runner: validated Docker Engine control API." \
      org.opencontainers.image.source="https://github.com/ArKaNeMaN/hanse" \
      org.opencontainers.image.url="https://github.com/ArKaNeMaN/hanse" \
      org.opencontainers.image.documentation="https://github.com/ArKaNeMaN/hanse/blob/main/docs/deployment.md" \
      org.opencontainers.image.version="${VERSION}" \
      org.opencontainers.image.revision="${REVISION}" \
      org.opencontainers.image.licenses="NOASSERTION"

ENV NODE_ENV=production

RUN apt-get update \
 && apt-get install -y --no-install-recommends dumb-init ca-certificates \
 && rm -rf /var/lib/apt/lists/*

WORKDIR /app
COPY --from=deps /app/node_modules ./node_modules
COPY --from=build /app/dist ./dist
COPY package.json LICENSE ./

RUN printf '%s\n' '#!/bin/sh' 'exec node /app/dist/index.js "$@"' > /usr/local/bin/hanse \
 && chmod 0755 /usr/local/bin/hanse \
 && node --version \
 && hanse --help >/dev/null

USER root

ENTRYPOINT ["/usr/bin/dumb-init", "--"]
CMD ["hanse", "runner", "--hostname", "0.0.0.0", "--port", "8790"]
