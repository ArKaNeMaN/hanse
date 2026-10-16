# Hanse - Architecture Overview

> Status: accepted design (v2, post-review). Review: [`review-0001-oracle.md`](./review-0001-oracle.md).
> Delivery process: [`docs/process.md`](../process.md).

## 1. Context

Long-lived AI coding agents (`opencode`) work best isolated per application. But applications in one
project occasionally need each other. Today a developer moves requests between them by hand. Hanse is
a self-hosted **coordinator/workbench** that hosts **projects** of **applications**, runs one isolated
`opencode` instance per application, and lets applications exchange structured requests through the
coordinator.

## 2. Goals, non-goals, trust model

Goals:

- Host multiple projects, each with multiple applications, on one machine, reachable via a web UI.
- One isolated `opencode` instance per application; no shared working tree, session, or context.
- Structured, coordinator-mediated, auditable cross-application handoffs (specs/requirements).
- Deterministic concurrency control: one writer lane per application.
- Portable on-disk layout; runtime state outside managed repositories.

Non-goals (pre-alpha):

- Multi-tenant or multi-user; no RBAC.
- Distributed/cluster deployment; single node only.
- Being a general workflow engine; cloud sandboxes.

**Trust model (explicit):** single-owner, trusted repositories, single OS user. Isolation between
applications is **logical** (separate opencode state - XDG + DB), not OS-level. A malicious
application repository must be treated as capable of running arbitrary code on the host; untrusted
third-party applications and OS isolation (containers/users) are out of scope for pre-alpha.

## 3. Domain model

- **Project** - folder with `.hanse/project.yaml`; shared docs + application list.
- **Application** - a git repository with `.hanse/app.yaml`; carries its own `opencode` config;
  project-agnostic/portable.
- **Instance** - one running `opencode` server bound to a (project, application); identity is
  **per (project, app)**; carries isolated state.
- **Task** - a unit of work routed to an instance; maps to one `opencode` session.
- **Handoff** - a structured request from one application to a sibling, with a state machine (below).
- **Principal** - an actor (`human`, `agent`, `system`) with its own credential.
- **Approval** - a human gate for a cross-application write.

## 4. Concurrency model

The concurrency unit is the **application** (one writer lane per application). The real shared resource
is the git working tree, not opencode internals (instances have isolated DBs).

- Source of truth for mutual exclusion: **`flock`** on a per-application lockfile under the runtime
  root, held by the coordinator for the task duration (auto-released on process death - crash-safe, no
  heartbeat, no clock dependency).
- Defense in depth at the DB layer: a **partial unique index** on active tasks
  (`UNIQUE(app_id) WHERE state IN ('dispatched','running')`).
- Multiple coordinators on one node are serialized by `flock`. Multi-node is unsupported (documented).
- A lane is **never held while awaiting a sibling** (prevents A<->B deadlock); the wait-for graph is
  checked for cycles.

Worktrees are not used in the pre-alpha critical path (deferred, opt-in later).

## 5. Components

| Component | Responsibility | Stage |
| --- | --- | --- |
| Manifest schemas | `.hanse/project.yaml`, `.hanse/app.yaml` (zod) | 0 (done) |
| Vertical spike | prove opencode serve + overlay + session API + steer/events | 0.5 |
| State store | SQLite (WAL) under `XDG_STATE_HOME`: projects, apps, instances, tasks, handoffs, messages, principals, approvals, migrations, events | 1 |
| Registry | discover/validate projects and applications from manifests | 1 |
| CLI | `init`, `status` | 1 |
| Launcher | spawn/supervise `opencode serve`; isolated env; overlay | 2 |
| Queue + handoff | durable queue + handoff state machine | 3 |
| Writer lock | `flock` per application + active-task index | 3 |
| Identity | principals + per-instance identity + API/MCP authn | 4 |
| Coordinator MCP server | thin tools: `request_sibling_change`, `list_apps`, `handoff_status`, `deliver_handoff` | 5 |
| HTTP API + web UI | dashboard, approvals, queue, send message | 6 |
| Secrets | git credentials (ssh-agent / helper / brokered tokens) | 7 |
| Hardening | docs, release, security review | 8 |

## 6. Data model (SQLite, forward-only migrations)

Timestamps are UTC ISO-8601. All cross-table references use surrogate ids; natural keys are unique
columns.

- `schema_migrations(version INTEGER PK, name, checksum, applied_at)`
- `projects(id TEXT PK, name, base_branch, root_path, created_at, updated_at)`
- `apps(id TEXT PK, project_id FK projects, app_key, path, kind, contract, created_at)` -
  `UNIQUE(project_id, app_key)`
- `instances(id TEXT PK, app_id FK apps UNIQUE, endpoint, pid, boot_id, state, started_at, heartbeat_at, updated_at)`
- `tasks(id TEXT PK, app_id FK apps, handoff_id FK handoffs NULL, session_id, state, created_at, updated_at)`
  - `CREATE UNIQUE INDEX tasks_active_lane ON tasks(app_id) WHERE state IN ('dispatched','running')`
  - states: `pending, dispatched, running, done, failed, cancelled`
- `handoffs(id TEXT PK, project_id FK, from_app_id FK, to_app_id FK, state, summary, spec, approval_id FK NULL, idempotency_key UNIQUE, attempts, next_attempt_at, expires_at, target_task_id FK tasks NULL, result, error, created_at, updated_at)`
  - states: `queued, awaiting_approval, dispatching, in_progress, delivered, rejected, failed, expired, cancelled`
- `handoff_messages(id INTEGER PK AUTOINCREMENT, handoff_id FK, author_principal FK NULL, kind, body, created_at)`
- `principals(id TEXT PK, kind, name, secret_hash, created_at)`
- `approvals(id TEXT PK, handoff_id FK, state, requested_at, decided_at, decided_by FK principals NULL, reason)`
- `events(id INTEGER PK AUTOINCREMENT, scope, type, payload, created_at)` - telemetry/audit only

No `locks` table: mutual exclusion is `flock` (file), the invariant is the partial index.

## 7. Config injection

The coordinator composes a single `OPENCODE_CONFIG_CONTENT` overlay per instance. Precedence (low to
high): project shared config, application config, instance overrides, coordinator control entries. The
overlay is **self-contained** (full MCP definitions) so opencode v1 deep-merge vs v2 last-wins per name
does not change behavior. The coordinator's MCP server name (`hanse`) is **reserved**: manifests may
not define it.

## 8. Stage plan

- **Stage 0** Foundation (scaffold, schemas, docs) - done.
- **Stage 0.5** Vertical spike: spawn `opencode serve` with isolated XDG + `OPENCODE_DB`, inject the
  overlay, create and drive a session, verify no leakage, confirm steer/event capabilities.
- **Stage 1** State store + migrations + registry + runtime layout + CLI `init`/`status`.
- **Stage 2** Launcher: instance lifecycle, isolation env, overlay composition.
- **Stage 3** Durable queue + handoff state machine + `flock` writer lock.
- **Stage 4** Identity: principals + per-instance identity + authn.
- **Stage 5** Coordinator MCP server + handoff delivery + approval gate.
- **Stage 6** HTTP API + minimal web dashboard.
- **Stage 7** Secrets / git credentials.
- **Stage 8** Hardening, docs, release.

Each stage runs the feature pipeline and ends in one commit.

## 9. Open questions

- Exact opencode v1 HTTP endpoints for injecting a prompt into an existing session and an event
  stream (settle in Stage 0.5).
- Web UI auth mechanism (Stage 6/7); pre-alpha assumes a trusted network (VPN/reverse proxy).
