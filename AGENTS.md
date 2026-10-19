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

Requires Node.js >= 20.

```bash
npm install
npm run typecheck   # tsc --noEmit
npm test            # vitest
npm run lint        # biome
npm run build       # tsc + Tailwind CSS -> dist/ and assets/app.css
```

All gates must pass before a change is considered done. The CSS is built by
`npm run build:css` (Tailwind CSS) into `assets/app.css`.

## Conventions

- TypeScript, ESM, `moduleResolution: NodeNext`. Relative imports use `.js` extensions.
- Node-compatible only: do not use Bun or other runtime-specific APIs.
- `.hanse/project.yaml` and `.hanse/app.yaml` schemas (in `src/schema/`) are the source of truth;
  keep docs and code in sync.
- Runtime state lives outside managed repositories (under `XDG_STATE_HOME` / the `state` volume).
- Do not commit secrets.
- Documentation is agent-first; human-facing docs are added only when explicitly needed.

## Delivery pipeline

Multi-phase work follows the `feature-delivery` pipeline: design -> design review -> owner questions
-> plan -> plan review -> execute -> record -> commit. Bindings live in
[`docs/process.md`](docs/process.md). Do not start implementation before the gate is cleared.
