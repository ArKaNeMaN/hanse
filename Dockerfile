# syntax=docker/dockerfile:1
FROM codercom/code-server:latest AS ide
FROM node:22-bookworm-slim AS build
RUN apt-get update && apt-get install -y --no-install-recommends python3 make g++ && rm -rf /var/lib/apt/lists/*
WORKDIR /app
COPY package.json package-lock.json ./
RUN npm ci
COPY tsconfig.json ./
COPY src ./src
RUN npm run build && npm prune --omit=dev

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
RUN apt-get update && apt-get install -y --no-install-recommends git ca-certificates && rm -rf /var/lib/apt/lists/*
RUN npm i -g opencode-ai@1.19.3
EXPOSE 8787
CMD ["node", "dist/index.js", "serve", "--workspace", "/data/workspace", "--hostname", "0.0.0.0", "--port", "8787"]
