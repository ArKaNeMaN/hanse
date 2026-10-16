# hanse

> **Status: pre-alpha.** This repository is the initial foundation: schemas, documentation, and a
> skeleton. The coordinator and web UI are not implemented yet.

`hanse` is a self-hosted **coordinator/workbench** for running multiple **projects**, each made of
multiple **applications**. Every application runs as an isolated
[`opencode`](https://opencode.ai) agent instance, and applications can hand structured requests
(specs and requirements) to each other **through the coordinator** - like two independent teams
exchanging tickets.

## Why

Long-lived AI coding agents work best when they are isolated per application. But applications in a
project occasionally need each other: a feature in one app requires a change in a sibling app.
`hanse` keeps every application isolated while giving them a single, structured way to exchange
requests without sharing a working tree, a session, or a context window.

## Core ideas

- **Projects and applications** are described on disk by portable `.hanse/` manifests.
- **One isolated opencode instance per application** (separate state, working tree, and context).
- **Cross-application handoff through the coordinator**, exposed to agents as thin MCP tools, not as
  raw MCP transport.
- **Concurrency control**: one writer lane per application; read-only fan-out allowed.
- **Runtime state lives outside the managed repositories.**

See [`docs/architecture.md`](docs/architecture.md) and [`docs/conventions.md`](docs/conventions.md).

## Status

**0.1.0 (pre-alpha).** The coordinator core is implemented (stages 0-7): manifest schemas, SQLite
state store, project/application registry, per-application launcher, durable handoff state machine
and writer lock, principals/authn + approvals, coordinator MCP tools, HTTP API + dashboard, and an
encrypted secret store. See [`docs/releases/0.1.0.md`](docs/releases/0.1.0.md).

Not yet wired into the CLI entrypoint: the HTTP server and the MCP server. The live `opencode`
delivery spike is still pending.

## Development

Requires Node.js >= 20.

```bash
npm install
npm run typecheck
npm test
npm run lint
npm run build
node dist/index.js --help
```

## License

Not yet chosen. See [`LICENSE`](LICENSE).
