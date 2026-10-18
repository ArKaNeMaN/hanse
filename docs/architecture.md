# Architecture

> **Superseded.** See [`docs/current-state.md`](current-state.md) for what is implemented now. This file
> is the early Stage 0 design notes.

`hanse` is a coordinator/workbench. It hosts **projects**, each containing **applications**. Each
application runs as its own isolated `opencode` agent instance, and applications exchange structured
requests through the coordinator.

## Model

- **Project** - a folder with `.hanse/project.yaml`. Holds shared documentation and a list of
  applications.
- **Application** - a git repository with `.hanse/app.yaml`. It carries its own `opencode` config
  (`opencode.json`, `.opencode/`, `AGENTS.md`) and is project-agnostic: it can move between projects
  by moving the folder.
- **Instance** - one running `opencode` server for one application, with isolated state.

## Isolation

Every application instance is isolated:

- separate `XDG_DATA_HOME`, `XDG_STATE_HOME`, `XDG_CONFIG_HOME`, `XDG_CACHE_HOME`, and `OPENCODE_DB`
  (see ADR 0003);
- separate working tree / git worktree;
- separate session and context.

Agents never share a working tree, a session, or a context window. They communicate only through the
coordinator, as structured specs and requirements - like two independent teams exchanging tickets.

## Config injection

The coordinator injects its own config (the coordinator MCP server and project-shared instructions)
into each instance through `OPENCODE_CONFIG_CONTENT`, the highest non-managed opencode config layer.
It never writes coordinator-specific config into a managed repository (see ADR 0002).

## Cross-application handoff

A handoff is a structured request from one application to a sibling application. The coordinator owns
a queue and a handoff ledger, and exposes them to agents as three thin MCP tools:

- `request_sibling_change` - enqueue a request for a sibling application;
- `list_apps` - list the applications in the project;
- `handoff_status` - look up a handoff by id.

A handoff moves through `queued -> in_progress -> delivered/rejected`. Cross-application writes can be
gated behind human approval. Delivering a request wakes the target application by creating a fresh
session seeded with that application's own contract plus the request spec (see ADR 0004).

## Concurrency

- One writer lane per application, held by the coordinator.
- Read-only fan-out (for example project Q&A) is allowed without the writer lock.
- The user's own messages enter through the same queue, so they are serialized with agent work.

## Runtime state

Queue, locks, handoffs, worktrees, and logs live **outside** the managed repositories, under
`XDG_STATE_HOME`, keyed by the stable project id from `.hanse/project.yaml`.

## opencode version

The design targets opencode **v1**. Known v2 deltas to handle later: `OPENCODE_CONFIG_DIR` changes
from additive to replacing the global config dir, and `mcp` merge changes from deep-merge to
last-definition-wins per server name.
