# 0028 - Session-bound handoffs

- Date: 2026-10-23
- Status: implemented, repository gates green; deployment pending.

## What changed

- Migration v14 adds source/target session ids, the orthogonal reply state, lineage/depth, policy
  snapshots, dispatch/reply deadlines, approval kinds, and the `handoff_policies` table.
- `request_sibling_change` is bound to the invoking opencode session from the projected app event
  stream. The coordinator creates a fresh target session, sends a dispatch envelope, and records the
  target session.
- `deliver_handoff` accepts an outcome and is scoped to the target application. The coordinator routes
  the reply into the source session through `prompt_async` as a clearly marked untrusted user message.
- The coordinator dispatcher ticks every 5 s, serializes one active handoff per target application,
  starts stopped targets, enforces binding/dispatch/run deadlines and an 8-hop chain limit, and parks
  replies whose source session is gone.
- The operator can relaunch a parked reply in a new source-app session with a note, retry delivery,
  cancel the reply, or cancel the handoff.
- Directed handoff policy (project default plus `*` pair rules) selects `auto`, `approve`, or `deny`
  for dispatch and `auto` or `approve` for reply delivery. The project page has the editor; the
  handoff inbox has a `Replies` filter and reply-aware approvals.
- The local handoff MCP server remains the agent surface; the coordinator MCP endpoint, status
  scoping, and delivery authorization were tightened.

## Verification

- `npm run typecheck`.
- `npm test` (1987 tests, including new dispatcher, policy, handoff HTTP, and handoff UI suites).
- `npm run lint`, `npm run build`, and `npm run check:sensitive`.

## Known limits

- One reply per handoff; no multi-turn negotiation or target-to-source questions.
- Handoff dispatch is serialized per target app, but human chat sessions share the worktree and there
  is no worktree isolation.
- Cancellation is soft: there is no opencode abort wrapper.
- Source binding depends on the context-monitor event stream; if context monitors are unavailable,
  agent-created handoffs stay unbound and fail at the binding deadline.
- Reply delivery is a user-role message, not an assistant/tool result; the envelope is the trust
  boundary for the source agent.
