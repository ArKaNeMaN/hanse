# Contributing

Thanks for your interest in `hanse`.

## Development setup

Requires Node.js >= 20.

```bash
npm install
npm run typecheck
npm test
npm run lint
npm run build
```

## Guidelines

- Keep the code TypeScript, ESM, and Node-compatible (no runtime-specific APIs beyond Node).
- Use `.js` extensions in relative imports (NodeNext resolution).
- The `.hanse/` schemas are the single source of truth for on-disk manifests; keep code and docs in
  sync.
- Ship changes with tests and keep the quality gates green (`lint`, `typecheck`, `test`, `build`).
- Documentation is agent-first; see [`AGENTS.md`](AGENTS.md).

## Pull requests

- Keep changes focused and describe the motivation.
- Ensure CI passes.
