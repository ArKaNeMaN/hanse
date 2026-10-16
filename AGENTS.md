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

- [`docs/process.md`](docs/process.md) - the delivery pipeline (bindings, reviewers, paths, gates).
- [`docs/design/`](docs/design/) - design docs (index: `docs/design/README.md`).
- [`docs/architecture.md`](docs/architecture.md) - the coordinator architecture.
- [`docs/conventions.md`](docs/conventions.md) - on-disk `.hanse/` conventions.
- [`docs/decisions/`](docs/decisions/) - architecture decision records.
- [`docs/plans/`](docs/plans/) - per-stage implementation plans.
- [`docs/journal/`](docs/journal/) - stage records and decision log.

## Delivery pipeline

Multi-phase work follows the `feature-delivery` pipeline: design -> design review -> owner questions
-> plan -> plan review -> execute -> record -> commit. Bindings live in
[`docs/process.md`](docs/process.md). Do not start implementation before the gate is cleared.
