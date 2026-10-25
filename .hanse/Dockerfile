# syntax=docker/dockerfile:1.7

# Browser-enabled application image for the Hanse repository itself. This is
# application-local on purpose: `agent-default` stays lean, and only this
# application gets the headless Chromium needed for functional and visual web
# UI checks. Rebuild the app image after changing this file.
ARG HANSE_BASE
FROM ${HANSE_BASE}

ARG PLAYWRIGHT_VERSION=1.64.0

USER root

# Debian 12 (bookworm) runtime libraries and fonts required by Playwright's
# Chromium. This is the `debian12-x64`/`debian12-arm64` dependency set from
# playwright-core. Fonts are not optional: without them screenshots render
# text as empty boxes.
RUN apt-get update \
 && DEBIAN_FRONTEND=noninteractive apt-get install -y --no-install-recommends \
      libasound2 libatk-bridge2.0-0 libatk1.0-0 libatspi2.0-0 \
      libcairo2 libcups2 libdbus-1-3 libdrm2 libgbm1 libglib2.0-0 \
      libnspr4 libnss3 libpango-1.0-0 libx11-6 libxcb1 \
      libxcomposite1 libxdamage1 libxext6 libxfixes3 libxkbcommon0 libxrandr2 \
      libfontconfig1 libfreetype6 fontconfig xfonts-scalable \
      fonts-noto-color-emoji fonts-unifont fonts-liberation \
      fonts-ipafont-gothic fonts-wqy-zenhei fonts-tlwg-loma-otf fonts-freefont-ttf \
      unzip sqlite3 \
 && rm -rf /var/lib/apt/lists/*

# Bake the full Chromium build (not the headless shell) into a fixed image path.
# `--no-shell` avoids the extra headless-shell copy; the browser is never
# downloaded at runtime. Keep PLAYWRIGHT_VERSION pinned so the browser revision
# is reproducible.
RUN mkdir -p /opt/hanse/ms-playwright \
 && PLAYWRIGHT_BROWSERS_PATH=/opt/hanse/ms-playwright \
    npx -y playwright@${PLAYWRIGHT_VERSION} install --no-shell --no-progress chromium \
 && CHROME_BIN="$(find /opt/hanse/ms-playwright -type f -path '*/chrome-linux*/chrome' | head -n 1)" \
 && test -n "${CHROME_BIN}" \
 && printf '%s\n' '#!/bin/sh' "exec \"${CHROME_BIN}\" --no-sandbox --disable-dev-shm-usage \"\$@\"" > /usr/bin/chromium \
 && chmod 0755 /usr/bin/chromium \
 && fc-cache -f \
 && chromium --version \
 && timeout 30 chromium --headless --disable-gpu --dump-dom about:blank >/dev/null 2>&1 \
 && fc-list | grep -q . \
 && rm -rf /root/.npm /home/agent/.npm

# The app container has no usable Chromium sandbox: user namespaces are blocked
# and `no-new-privileges` disables the setuid helper. The wrapper above injects
# --no-sandbox and --disable-dev-shm-usage (the container has only a 64 MiB
# /dev/shm). The built-in Playwright MCP is headed by default and expects the
# `chrome` channel, so point it at the baked Chromium and run headless.
# PLAYWRIGHT_CHROMIUM is also read by docs/design/*.mjs; CHROME_BIN and
# PUPPETEER_EXECUTABLE_PATH cover the common browser tools.
ENV PLAYWRIGHT_MCP_EXECUTABLE_PATH=/usr/bin/chromium \
    PLAYWRIGHT_MCP_HEADLESS=1 \
    PLAYWRIGHT_MCP_NO_SANDBOX=1 \
    PLAYWRIGHT_MCP_ISOLATED=1 \
    PLAYWRIGHT_CHROMIUM=/usr/bin/chromium \
    CHROME_BIN=/usr/bin/chromium \
    PUPPETEER_EXECUTABLE_PATH=/usr/bin/chromium

USER 1000:1000
