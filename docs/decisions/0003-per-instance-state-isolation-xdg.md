# 3. Per-instance state isolation via XDG

- Status: Accepted
- Date: 2026-10-16

## Context

opencode stores its state in a single global SQLite database by default. Several instances sharing
one database cause lock contention and races.

## Decision

Isolate each application instance with its own `XDG_DATA_HOME`, `XDG_STATE_HOME`, `XDG_CONFIG_HOME`,
`XDG_CACHE_HOME`, and `OPENCODE_DB`, under the coordinator runtime root keyed by the stable project
id.

## Consequences

- No shared database between instances; no cross-instance lock races.
- State is machine-local and lives outside the managed repositories.
- Moving a project does not move runtime state; the coordinator re-associates or resets it by the
  stable project id.
