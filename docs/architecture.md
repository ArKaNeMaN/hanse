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

- separate `XDG_DATA_HOME`, `XDG_STATE_HOME`, `XDG_CONFIG_HOME`, `XDG_CACHE_HOME`, `OPENCODE_DB`,
  and `TMPDIR` (per-instance scratch under `/tmp/hanse/<project-id>/<app-key>`) (see ADR 0003);
- separate working tree / git worktree;
- separate session and context.

Agents never share a working tree, a session, or a context window. They communicate only through the
coordinator, as structured specs and requirements - like two independent teams exchanging tickets.

## Config injection

The coordinator injects its own config (the coordinator MCP server and project-shared instructions)
into each instance through `OPENCODE_CONFIG_CONTENT`, the highest non-managed opencode config layer.
It never writes coordinator-specific config into a managed repository (see ADR 0002).

## Cross-application handoff

A handoff is a structured, session-bound request from one application to a sibling application. The
coordinator owns a durable queue and a handoff ledger, and exposes thin MCP tools:

- `request_sibling_change` - enqueue a request for a sibling application;
- `list_apps` - list the applications in the project;
- `handoff_status` - look up a handoff the caller sent or received;
- `deliver_handoff` - the target's reply callback.

The coordinator binds an agent-created request to the invoking opencode session by observing the app's
projected `/event` stream. It creates a fresh target session, sends the spec and reply protocol, and
routes the target's reply back into the source session as a clearly marked, untrusted user message.
Replies whose source session is gone are kept for an explicit operator relaunch (see ADR 0015).

Dispatch is durable and serialized per target application: one active handoff per target app, with the
rest queued. The target app is started if needed. Source binding, dispatch start, and the run itself
have deadlines, and a chain-depth limit stops autonomous ping-pong.

Handoff policy is operator-owned coordinator state, not a repository manifest. A project default and
directed pair rules select `auto`, `approve`, or `deny` for dispatch and `auto` or `approve` for reply
delivery. Policy is snapshotted on the handoff; `requires_approval` from an agent can raise but
never lower it.

## Concurrency

- Handoff dispatch holds one writer lane per target application; other handoffs for that application
  wait in `queued`.
- Human chat sessions and handoff sessions share the application worktree; there is no general writer
  lock or worktree isolation yet.
- The user's own messages enter the same opencode session queue, so they are serialized with agent work.

## Runtime state

Queue, locks, handoffs, worktrees, and logs live **outside** the managed repositories, under
`XDG_STATE_HOME`, keyed by the stable project id from `.hanse/project.yaml`.

## opencode version

The design targets opencode **v1**. Known v2 deltas to handle later: `OPENCODE_CONFIG_DIR` changes
from additive to replacing the global config dir, and `mcp` merge changes from deep-merge to
last-definition-wins per server name.
