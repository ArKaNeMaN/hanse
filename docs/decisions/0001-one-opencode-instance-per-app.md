# 1. One opencode instance per application

- Status: Accepted
- Date: 2026-10-16

## Context

A project has several applications. Each application has its own opencode configuration (plugins, MCP
servers, skills). Applications must be isolated from each other.

## Decision

Run one `opencode` instance per application directory. Do not multiplex several applications through
a single opencode server.

## Consequences

- Each application gets its own state, working tree, session, and context.
- Isolation is explicit and easy to reason about.
- The coordinator manages N instances (N = number of applications) and must supervise them.
- Cross-application interaction must go through the coordinator, not shared opencode state.
