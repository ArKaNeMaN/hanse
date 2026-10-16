# 4. Cross-application handoff via the coordinator queue

- Status: Accepted
- Date: 2026-10-16

## Context

An agent in application A sometimes needs a change in a sibling application B. MCP is a
request/response tool protocol, not a message bus, and opencode is an MCP client (not a server), so
agents cannot call each other directly.

## Decision

The coordinator owns a durable queue and a handoff ledger. Agents reach it through thin MCP tools
(`request_sibling_change`, `list_apps`, `handoff_status`). A handoff is a structured
spec/requirement and moves through `queued -> in_progress -> delivered/rejected`, optionally gated by
human approval. Delivering a handoff wakes the target application with a fresh, isolated session
seeded with the target's own contract plus the spec.

## Consequences

- Applications stay isolated; communication is structured and auditable.
- The coordinator (not an LLM) performs routing, so routing is deterministic.
- A durable queue is required (in-memory now; SQLite later).
