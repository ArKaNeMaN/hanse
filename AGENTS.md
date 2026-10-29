# AGENTS.md

Guidance for AI agents working in this repository (the `hanse` coordinator).

## Read this first

1. [`docs/current-state.md`](docs/current-state.md) - **what is implemented right now** (topology, auth,
   chat, handoffs, IDE, state layout, env vars, known limits). Start here.
2. [`docs/conventions.md`](docs/conventions.md) - on-disk `.hanse/` manifests.
3. [`docs/deployment.md`](docs/deployment.md) - how it is deployed and operated.
4. [`docs/journal/0001-core.md`](docs/journal/0001-core.md) - stage-by-stage history and decisions.
5. [`docs/process.md`](docs/process.md) - the delivery pipeline (gates, reviewers, artifacts).

> Local-only (optional): if `docs/deploy/` exists, read `docs/deploy/README.md` - it is git-ignored
> and holds the host deployment runbook plus the rule that every update is deployed there after the
> gates pass.

## What this repository is

A public, pre-alpha TypeScript/Node project: a self-hosted coordinator/workbench for projects of
isolated `opencode` agent applications. The core (store, registry, launcher, handoffs, auth, MCP, HTTP
UI, chat, IDE integration, Docker deployment) is implemented; see `docs/current-state.md` for the exact
scope and limitations.

## Build and verify

Requires Node.js >= 20.19.0.

```bash
npm install
npm run typecheck   # tsc --noEmit
npm run typecheck:ui # vue-tsc for ui/ and src/shared/routes.ts
npm test            # vitest (server + jsdom UI projects)
npm run lint        # biome
npm run build       # tsc + Tailwind CSS + Vite UI -> dist/, assets/app.css, assets/ui/
npm run check:ui    # no SFC <style>, built CSS contains the UI sentinel
npm run check:ui-dev # optional: start Vite and fetch the dev entry (not in CI)
```

All gates must pass before a change is considered done. The CSS is built by
`npm run build:css` (Tailwind CSS) into `assets/app.css`; the Vue client is built by
`npm run build:ui` (Vite) into `assets/ui/`. `assets/ui/` and `assets/app.css` are git-ignored.

## Browser testing (this application image)

`.hanse/Dockerfile` adds a headless Chromium, Debian 12 runtime libraries, and fonts for
functional/visual web UI checks. The image is application-local; `agent-default` is unchanged.
It is built on a human action (`hanse images build` or the app page Image panel), and the agent must
be restarted after the build to pick it up.

- `chromium` / `/usr/bin/chromium` is a wrapper that always passes
  `--no-sandbox --disable-dev-shm-usage`; the app container has no user namespaces and only a
  64 MiB `/dev/shm`. Do not remove those flags.
- The built-in Playwright MCP uses `/usr/bin/chromium` headless via `PLAYWRIGHT_MCP_*`; use the
  `playwright` skill for functional checks. `visual-qa`/`browser` can use the same binary with the
  owned/headless engine; the attached engine has no user browser in the app container.
- `PLAYWRIGHT_CHROMIUM=/usr/bin/chromium` lets `docs/design/*.mjs` reuse the baked browser.
- If the app still shows the default image card after adding `.hanse/Dockerfile`, use **Check for
  changes** on that card (or `hanse status`) to re-read the manifest and reveal the Build button. It
  updates the coordinator DB without a restart or a build.
- Write screenshots/traces to the workspace, not `/tmp`. Use a local test state and a test token;
  never use deployment secrets or real project data.

## Conventions

- TypeScript, ESM, `moduleResolution: NodeNext`. Relative imports use `.js` extensions.
- The Vue client lives in `ui/` with its own `tsconfig.ui.json` (`moduleResolution: Bundler`). It
  imports the pure `src/shared/routes.ts` only; do not add `node:*` imports there. No SFC `<style>`
  blocks or `v-html`; use the existing Tailwind classes and `DESIGN.md` tokens.
- Only routes whose registry `spa` flag is true are served by the Vite client; `/projects` is the
  current cutover. Every other route stays legacy; `/api/ui/*` and SPA documents are cookie-only.
  Legacy pages load `app.js` + `app-content.js`; SPA documents load only the shell `app.js`.
- Node-compatible only: do not use Bun or other runtime-specific APIs.
- `.hanse/project.yaml` and `.hanse/app.yaml` schemas (in `src/schema/`) are the source of truth;
  keep docs and code in sync.
- Runtime state lives outside managed repositories (under `XDG_STATE_HOME` / the `state` volume).
- Do not commit secrets.
- The app container is allow-all for tool file access except credentials. The credential deny list
  is `credentialDenyPatterns()` in `src/opencode/policy.ts` (provider `auth.json`, the managed git
  credential directory under `<HOME>/.config/hanse/git`, the per-app `mcp-token`, and the opencode
  server password). Any new sensitive file or directory mounted into an app container must be added
  there and covered by `test/permission-policy.test.ts`. This is a tool-level guardrail; the
  container mount list remains the hard boundary.
- Documentation is agent-first; human-facing docs are added only when explicitly needed.

## Sensitive data and deployment runbooks

Tracked files, commit messages, and checked-in artifacts must never contain deployment-host
specifics: hostnames or aliases, LAN/public IP addresses, ports, SSH users, absolute home or install
paths, backup/state/database paths, OS/package/container versions, disk usage, real project or
application names, project/session IDs, tokens, keys, or screenshots of real data. Use placeholders
such as `<deployment-host>`, `<LAN_HOST>`, `<INSTALL_DIR>`, `<BACKUP_DIR>`, `<PROJECT_ID>`, and
`<SESSION_ID>`. Do not name or alias the production host in tracked files, commit messages, or QA
artifacts.

Deployment runbooks, host inventories, deploy logs, and live QA evidence belong only in the
untracked, git-ignored `docs/deploy/` directory. Never force-add it or copy its contents into tracked
docs.

Run `npm run check:sensitive` before committing. It scans tracked text for private addresses, host
aliases, home paths, and credential-like literals; review binary artifacts manually because a
screenshot can leak the same data without matching text.

## Delivery pipeline

Multi-phase work follows the `feature-delivery` pipeline: design -> design review -> owner questions
-> plan -> plan review -> execute -> record -> commit. Bindings live in
[`docs/process.md`](docs/process.md). Do not start implementation before the gate is cleared.
