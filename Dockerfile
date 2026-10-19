# syntax=docker/dockerfile:1.7

# Pinned toolchain versions. Bump these deliberately and re-run the container smoke test.
ARG NODE_VERSION=22
ARG CODE_SERVER_VERSION=4.141.0
ARG OPENCODE_VERSION=1.19.3
ARG OMO_VERSION=5.1.35
ARG CODEGRAPH_VERSION=1.6.2
ARG VSCODE_THEME_VERSION=6.3.5

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
