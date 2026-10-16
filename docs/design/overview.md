# Hanse - Architecture Overview

> Status: accepted design (pre-alpha). Delivery process: [`docs/process.md`](../process.md).

## 1. Context

Long-lived AI coding agents (`opencode`) work best isolated per application. But applications in one
project occasionally need each other. Today a developer moves requests between them by hand. Hanse is
a self-hosted **coordinator/workbench** that hosts **projects** of **applications**, runs one isolated
`opencode` instance per application, and lets applications exchange structured requests through the
coordinator.

## 2. Goals and non-goals

Goals:

- Host multiple projects, each with multiple applications, on one machine (home server), reachable
  24/7 via a web UI.
- One isolated `opencode` instance per application; no shared working tree, session, or context.
- Structured, coordinator-mediated, auditable cross-application handoffs (specs/requirements).
- Deterministic concurrency control: one writer lane per application; read-only fan-out allowed.
- Portable on-disk layout; runtime state kept outside managed repositories.

Non-goals (pre-alpha):

- Multi-tenant or multi-user; no RBAC.
- Distributed/cluster deployment; single node only.
- Being a general workflow engine.
- Cloud sandboxes.

## 3. Domain model

- **Project** - folder with `.hanse/project.yaml`; holds shared docs and an application list.
- **Application** - a git repository with `.hanse/app.yaml`; carries its own `opencode` config;
  project-agnostic and portable.
- **Instance** - one running `opencode` server bound to an application directory, with isolated state.
- **Task** - a unit of work routed to an application; maps to an `opencode` session.
- **Handoff** - a structured request from one application to a sibling, with a lifecycle
  `queued -> in_progress -> delivered/rejected`.
- **Lock** - a per-application writer lease held by the coordinator.
- **Approval** - a human gate for a cross-application write.

## 4. Components

| Component | Responsibility | Stage |
| --- | --- | --- |
| Manifest schemas | `.hanse/project.yaml`, `.hanse/app.yaml` (zod) | 0 (done) |
| State store | durable SQLite under `XDG_STATE_HOME` (projects, apps, tasks, handoffs, locks, approvals, events) | 1 |
| Registry | discover/validate projects and applications from manifests | 1 |
| Runtime layout | per-instance dirs, stable project-id keying | 1 |
| Queue + handoff | durable queue and handoff state machine | 2 |
| Writer lock | cross-process per-application lease | 2 |
| Per-app runtime | spawn/supervise `opencode serve`; isolated env; overlay | 3 |
| Coordinator MCP server | thin tools: `request_sibling_change`, `list_apps`, `handoff_status` | 4 |
| HTTP API + web UI | dashboard, approvals, queue view, send message | 5 |
| Secrets | git credentials (SSH/tokens), encrypted at rest | 6 |
| Hardening | docs, release, security review | 7 |

## 5. Data model (SQLite)

- `projects(id TEXT PK, name, base_branch, root_path, created_at)`
- `apps(id INTEGER PK, project_id, app_key, path, kind, contract)`
- `tasks(id TEXT PK, project_id, app_key, session_id, state, worktree, created_at, updated_at)`
- `handoffs(id TEXT PK, project_id, from_app, to_app, state, summary, spec, approval_id, created_at, updated_at)`
- `handoff_messages(id INTEGER PK, handoff_id, kind, body, created_at)`
- `approvals(id TEXT PK, handoff_id, state, requested_at, decided_at, decided_by)`
- `locks(app_id UNIQUE, owner, acquired_at, heartbeat_at)`
- `events(id INTEGER PK, scope, type, payload, created_at)`

Schema is versioned with a `schema_version` row; migrations are forward-only.

## 6. Key decisions

- One `opencode` instance per application - ADR 0001.
- Config injected via `OPENCODE_CONFIG_CONTENT` - ADR 0002.
- Per-instance state isolation via XDG - ADR 0003.
- Cross-application handoff via coordinator queue - ADR 0004.
- SQLite for coordinator state (single node, transactional, queryable).
- Node built-in `node:http` for the API; server-rendered HTML for the pre-alpha UI (no SPA yet).
- HTTP API is local by default; remote access is expected to be gated by a reverse proxy or VPN.

## 7. Stage plan

- **Stage 0** Foundation (scaffold, schemas, docs) - done.
- **Stage 1** State store + registry + runtime layout + CLI `init`/`status`.
- **Stage 2** Durable queue + handoff state machine + cross-process writer lock.
- **Stage 3** Per-application runtime: launcher, isolation env, overlay, lifecycle.
- **Stage 4** Coordinator MCP server + handoff delivery + approval gate.
- **Stage 5** HTTP API + minimal web dashboard.
- **Stage 6** Secrets / git credentials.
- **Stage 7** Hardening, documentation, first release.

Each stage runs the feature pipeline and ends in one commit.

## 8. Open questions

- SQLite driver: `better-sqlite3` (mature, native) vs `node:sqlite` (built-in, experimental in Node
  22). Decision: `better-sqlite3` for maturity; revisit when `node:sqlite` stabilizes.
- Web UI auth: deferred to Stage 6/7; pre-alpha assumes a trusted network (VPN/reverse proxy).
