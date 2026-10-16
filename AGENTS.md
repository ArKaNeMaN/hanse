# AGENTS.md

Guidance for AI agents working in this repository (the `hanse` coordinator).

## What this repository is

A public, pre-alpha TypeScript/Node project: a self-hosted coordinator/workbench for projects of
isolated `opencode` agent applications. It is a skeleton; most of the coordinator is not built yet.

## Build and verify

Requires Node.js >= 20.

```bash
npm install
npm run typecheck   # tsc --noEmit
npm test            # vitest
npm run lint        # biome
npm run build       # tsc -> dist
```

All four gates must pass before a change is considered done.

## Conventions

- TypeScript, ESM, `moduleResolution: NodeNext`. Relative imports use `.js` extensions.
- Node-compatible only: do not use Bun or other runtime-specific APIs.
- `.hanse/project.yaml` and `.hanse/app.yaml` schemas (in `src/schema/`) are the source of truth;
  keep docs and code in sync.
- Do not commit secrets.
- Documentation is agent-first; human-facing docs are added only when explicitly needed.

## Docs

- [`docs/architecture.md`](docs/architecture.md) - the coordinator architecture.
- [`docs/conventions.md`](docs/conventions.md) - on-disk `.hanse/` conventions.
- [`docs/decisions/`](docs/decisions/) - architecture decision records.
