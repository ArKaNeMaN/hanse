# Design review 0001 - Oracle

- Artifact reviewed: [`overview.md`](./overview.md)
- Reviewer: `oracle` (independent, via `docs/process.md`)
- Date: 2026-10-16
- Outcome: **passed with required corrections** (all folded into `overview.md` v2).

## Findings and resolutions

Severity: B = blocker, M = major, m = minor.

| ID | Sev | Finding | Resolution |
| --- | --- | --- | --- |
| B1 | B | `Instance` is in the domain model but absent from the schema/lifecycle; no addressing/liveness primitive; instance identity undefined (app vs project+app) | Added `instances` table; instance identity is **per (project, app)** |
| B2 | B | Writer lock used a DB-row lease as source of truth (racy on crash; heartbeats/clock) | Source of truth = `flock` lockfile per app; DB invariant = partial unique index on active tasks; no `locks` table |
| B3 | B | Concurrency unit contradictory (app lane vs worktree) | Locked to **per-app writer lane**; worktrees deferred (opt-in later) |
| B4 | B | Approval gate bypassable; no principal model; `from_app` spoofable | Principals (`human`/`agent`/`system`); approvals require a human principal; per-instance identity; auth stage moved before MCP |
| B5 | B | Trust boundary undefined; config overlay is an injection/RCE surface; XDG is logical not OS isolation | Declared **single-owner trusted repos**; reserved `hanse` MCP name; manifest validation; multi-tenant/OS isolation out of scope |
| M6 | M | Handoff state machine under-specified | Expanded states + columns (approval/failure/expiry/cancel, attempts, idempotency, target task, result/error) |
| M7 | M | Cross-handoff deadlock (A<->B) | Cycle detection on the wait-for graph; a lane is never held while awaiting a sibling |
| M8 | M | Handoff delivery coupled to launcher, which was sequenced after the queue | Launcher moved before queue/handoff |
| M9 | M | Steer/event-stream capability unverified | Vertical spike (Stage 0.5); callback tool is source of truth; non-blocking requests |
| M10 | M | Session topology is a one-way door | One durable operator session per (project, app) instance |
| M11 | M | Stage order buries the risk | Spike first; then store -> launcher -> queue/lock -> identity -> MCP -> HTTP -> secrets |
| M12 | M | Secrets can't be last (git creds needed at launcher) | Credential strategy defined by the launcher stage; encryption-at-rest later |
| m13 | m | Referencing inconsistent (ids vs keys) | Surrogate ids everywhere + unique natural keys + explicit FKs |
| m14 | m | SQLite multi-process ops unspecified | WAL + `busy_timeout` + `synchronous=NORMAL`; UTC ISO-8601 timestamps |
| m15 | m | Single `schema_version` row | `schema_migrations` table (version + name + checksum + applied_at) |
| m16 | m | `handoff_messages` lacked author/ordering | Added author principal + monotonic id + session link |
| m17 | m | `events` could become a second state source | Telemetry/audit only; rows are truth |
| m18 | m | Config-layering precedence undefined | Precedence fixed; overlays self-contained (v1/v2-safe) |

## Decisions locked before coding

1. Trust & isolation: single-owner, trusted repos; logical XDG isolation; OS isolation out of scope (documented).
2. Session topology: one durable operator session per (project, app) instance.
3. Concurrency + lock: per-app writer lane via `flock` + partial unique index on active tasks; worktrees deferred.
4. Delivery: `request_sibling_change` returns immediately (handoff_id); `deliver_handoff` callback is truth; idempotency on handoff_id.
5. State store: SQLite (`better-sqlite3`), surrogate ids, FKs, WAL, `schema_migrations`.

## Deferred / watch-outs

- Verify in the spike (Stage 0.5): injecting a prompt into an existing session (steer), and an event stream for liveness.
- The "steer" assumption invalidates the Stage 5 delivery model if false.
