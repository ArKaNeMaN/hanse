# syntax=docker/dockerfile:1
FROM codercom/code-server:latest AS ide
FROM node:22-bookworm-slim AS build
RUN apt-get update && apt-get install -y --no-install-recommends python3 make g++ && rm -rf /var/lib/apt/lists/*
WORKDIR /app
COPY package.json package-lock.json ./
RUN npm ci
COPY tsconfig.json ./
COPY src ./src
COPY assets ./assets
RUN npm run build && npm prune --omit=dev

# Baseline OMO build for managed opencode instances. Installed once into the image and referenced by
# HANSE_OMO_PLUGIN, so per-app caches do not have to download it on first start.
FROM node:22-bookworm-slim AS omo
RUN mkdir -p /opt/hanse/omo
WORKDIR /opt/hanse/omo
RUN npm init -y >/dev/null 2>&1 \
 && npm install --ignore-scripts --no-audit --no-fund oh-my-openagent@5.1.35

FROM node:22-bookworm-slim AS codegraph
RUN mkdir -p /opt/hanse/codegraph
WORKDIR /opt/hanse/codegraph
RUN npm init -y >/dev/null 2>&1 \
 && npm install --no-audit --no-fund @colbymchenry/codegraph@1.6.2

FROM node:22-bookworm-slim AS runtime
ENV NODE_ENV=production
WORKDIR /app
COPY --from=build /app/node_modules ./node_modules
COPY --from=build /app/dist ./dist
COPY package.json ./
COPY --from=build /app/assets ./assets
COPY extensions ./extensions
COPY --from=ide /usr/lib/code-server /usr/lib/code-server
RUN ln -sf /usr/lib/code-server/bin/code-server /usr/bin/code-server
COPY shell/hanse-shell /usr/local/bin/hanse-shell
RUN chmod 0755 /usr/local/bin/hanse-shell
COPY omo/omo.jsonc /home/node/.omo/omo.jsonc
RUN code-server --install-extension /app/extensions/hanse-agent.vsix --extensions-dir /opt/hanse-ext --force \
 && code-server --install-extension GitHub.github-vscode-theme --extensions-dir /opt/hanse-ext --force \
 && mkdir -p /home/node/.config/code-server/User \
 && printf '%s' '{"workbench.colorTheme":"GitHub Dark Dimmed","workbench.startupEditor":"none","chat.commandCenter.enabled":false,"terminal.integrated.profiles.linux":{"hanse":{"path":"/usr/local/bin/hanse-shell"}},"terminal.integrated.defaultProfile.linux":"hanse"}' > /home/node/.config/code-server/User/settings.json \
 && chown -R 1000:1000 /opt/hanse-ext /home/node/.config /home/node/.omo
RUN apt-get update && apt-get install -y --no-install-recommends git ca-certificates && rm -rf /var/lib/apt/lists/*
RUN npm i -g opencode-ai@1.19.3
COPY --from=omo /opt/hanse/omo /opt/hanse/omo
COPY --from=codegraph /opt/hanse/codegraph /opt/hanse/codegraph
ENV HANSE_OMO_PLUGIN=file:///opt/hanse/omo/node_modules/oh-my-openagent
ENV HANSE_CODEGRAPH_BIN=/opt/hanse/codegraph/node_modules/.bin/codegraph
EXPOSE 8787
CMD ["node", "dist/index.js", "serve", "--workspace", "/data/workspace", "--hostname", "0.0.0.0", "--port", "8787"]
