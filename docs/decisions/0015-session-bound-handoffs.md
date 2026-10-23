# 15. Session-bound handoffs with autonomous reply routing

- Status: Accepted
- Date: 2026-10-23

## Context

Handoffs were durable records with an optional approval flag, but no transport: an approved handoff
stopped at `dispatching`, the target agent was never woken, and `deliver_handoff` only stored a result.
There was no link between a handoff and either opencode session, and the only approval signal was a
per-request flag chosen by the caller.

The operator wants sibling agents to communicate without a human in the loop, while retaining strict
approval for selected projects or directed pairs. A request must return to the session that created it;
if that session is gone, the reply must wait for an explicit operator action rather than being lost.

## Decision

1. **Bind to sessions at the edges.** The coordinator derives the source session from the app's existing
   projected `/event` stream: the completed `request_sibling_change` tool part carries the handoff id and
   the `sessionID`. This is an observed fact, not an agent-supplied argument. The target session is the
   fresh session the coordinator creates for the handoff.
2. **One reply per handoff.** `deliver_handoff` carries an outcome (`completed`, `blocked`, `failed`) and
   a result. The coordinator injects the reply into the source session as a new user turn, marked as
   untrusted sibling content. There is no multi-turn negotiation in this version.
3. **Reply routing is orthogonal to request state.** Request lifecycle and reply delivery have separate
   state machines, so a delivered handoff can still have a pending, approved, waiting, or failed reply.
4. **Park, do not drop.** If the source session is deleted or the handoff was operator-created, the
   reply is stored with `reply_state = waiting_operator`. The operator can relaunch it in a new
   source-app session with a note, retry delivery, cancel the reply, or cancel the handoff.
5. **Durable, per-target serialization.** The coordinator dispatcher claims queued/approved handoffs,
   runs at most one active dispatch/run per target application, starts a stopped target, and uses deadlines
   for source binding, dispatch start, and the run. An 8-hop chain depth limit stops autonomous
   ping-pong.
6. **Policy is operator-owned DB state.** `handoff_policies` stores a project default and directed pair
   rules (`*` wildcards). Dispatch is `auto`, `approve`, or `deny`; reply delivery is `auto` or
   `approve`. Exact pair > one wildcard > project default > built-in `auto/auto`. The policy is
   snapshotted on the handoff. An agent's `requires_approval` flag can raise a request to approval but
   never lower a policy; `deny` always wins.
7. **Caller scoping.** `handoff_status` is limited to the caller's sent/received handoffs;
   `deliver_handoff` is accepted only from the target application.

## Consequences

- The coordinator now has a long-lived dispatcher and a durable queue in the existing `handoffs` table;
  there is no new service and no new SSE connection (the context monitor already provides the stream).
- The source agent sees replies as user messages. The UI marks the envelope, and the model is instructed
  to treat it as untrusted. This is a deliberate cross-application prompt-injection surface; strict
  reply approval is the operator control for untrusted pairs.
- A handoff target session shares the target worktree with human chat sessions. Serialization is per
  handoff only; worktree isolation remains future work.
- Cancellation is soft: there is no opencode abort wrapper, so cancelling stops routing but cannot stop
  an in-flight target turn.
- `handoff_messages` and `tasks` remain schema placeholders. One reply per handoff needs neither; a
  future threaded mode would use `handoff_messages`.

## Alternatives considered

- **Agent-supplied session id**: simple, but agents may not know their session and could spoof another
  session. Kept only as an unbound test path, not the production binding.
- **MCP server receives the session id**: the stdio MCP server is per-app, not per-session, and the MCP
  request carries no opencode session context.
- **Blocking wait for the reply**: would keep the source turn open for minutes, consume a tool call, and
  complicate timeouts. The async user-turn model matches the existing chat transport.
- **Policy in `.hanse/project.yaml`**: versioned with the repository, but repository files are writable
  by agents and the policy is a security boundary. Operator-owned DB state is safer.
