# 16. Stage-1 handoff threads

- Status: Accepted
- Date: 2026-11-06
- Design: [`docs/design/handoff-threads.md`](../design/handoff-threads.md)
- Plan: [`docs/plans/0034-handoff-threads.md`](../plans/0034-handoff-threads.md)
- Journal: [`docs/journal/0041-handoff-threads.md`](../journal/0041-handoff-threads.md)

## Context

Session-bound handoffs (ADR 0015) carry exactly one request and one reply. The `handoff_messages`
table was reserved for a future threaded mode but had no production writer. The owner wants sibling
agents to hold an explicit, agent-originated multi-turn discussion without turning every follow-up
into a new handoff with a fresh target, approval, and context loss.

The approved reduced design keeps one `handoffs` row as the thread header and an ordered message log,
rather than adding a second dispatch path or a chain of one-shot handoffs. Stage 1 deliberately omits
clean close, retry, relaunch, retarget, shared-session operator paths, and thread UI so those edge
cases do not contradict the core queue and state machines.

## Decision

1. **Variant B: one header plus a log.** `handoffs.mode` is `one_shot` or `thread`; a thread uses
   `handoff_messages` as its ordered `request`/`message`/`reply` log. The header carries message
   counters, idle expiry, source invocation identity, and mode.
2. **Explicit agent opt-in.** `request_sibling_change(mode="thread")` starts a thread. Omitting the
   argument keeps the existing one-shot lifecycle, prompts, projection, dispatch/reply, validation,
   and API. Operator-created handoffs remain one-shot.
3. **Start-only approval.** The thread start uses the existing dispatch policy. An `approve` dispatch
   mode or a `reply_mode="approve"` pair requests one dispatch approval at start; after start, agent
   messages are autonomous. There is no per-message approval and no thread reply approval row.
4. **Observed binding.** The coordinator observes the exact managed MCP tool name, exact completed
   tool part, and a coordinator nonce, then resolves the durable session root through a bounded,
   cycle-safe `listSessions()` parent walk. The app token and observed event are the authority, not
   agent-supplied session ids.
5. **Generic queue, no retry.** A thread start creates a fresh target without sending. The initial
   request and later messages are normal queue rows with strict per-thread head-of-line ordering and
   one dispatching message per destination. Transport/session failure or stale dispatch parks the
   message in `waiting_operator`; it is never retried or requeued.
6. **Bounded lifecycle.** A thread ends only by the 24 h idle TTL, the 32-message cap (further appends
   reject; the thread stays open), or a human operator cancel. Cancel is soft and atomic; an in-flight
   transport is not aborted.
7. **Security hardening.** Public handoff JSON uses one allowlist; `GET /api/handoffs` is human-only;
   a valid agent token is rejected on every non-MCP route and WebSocket upgrade; thread error writers
   store only fixed codes/safe messages.
8. **Deferred features.** `close_handoff`, per-message retry/resend, relaunch/retarget/failThread, the
   shared-session operator path, target-initiated messages, thread chat projection/client parser, and
   the one-shot envelope/security redesign are out of scope for stage 1.

## Consequences

- One shared aggregate preserves foreign keys, deletion cascade, and one-shot compatibility; thread
  rows leave the one-shot routing columns null, so one-shot projection/`HandoffCard` remains unchanged.
- The coordinator gains a generic thread queue and binder in the existing dispatcher; no new service
  or SSE connection is introduced.
- Thread messages are ordinary user turns. Post-start prompt injection remains inherently possible;
  the envelope, caps, rate limits, and explicit untrusted-content instructions mitigate it.
- Isolation remains logical. A compromised app controls its own event stream; two sessions of one app
  are not a security boundary.
- A `waiting_operator` head blocks until cancel or idle TTL because there is no retry/relaunch.
- Bodies are unencrypted at rest, cancel does not abort an in-flight turn, and there is no thread
  transcript/UI in this stage.
- Public read and agent-token hardening intentionally change one-shot-visible behavior; the approved
  design accepts those two exceptions.

## Alternatives rejected

- **A chain of one-shot handoffs:** every turn increments depth, creates a target, and needs approval;
  context and ordering are lost.
- **A separate `handoff_threads` table:** duplicates routing/security fields or adds a nullable FK and
  a second dispatch path.
- **Direct initial-prompt send:** creates a second delivery path unlike every later message.
- **Per-message approval:** stalls autonomy; the reply gate is folded into the start instead.
- **Agent-supplied target session:** the per-app MCP server cannot prove session ownership.
- **Auto-recreate a missing session:** loses context and surprises the operator; stage 1 parks instead.
- **Trust envelope text for operator notes:** forgeable; trust comes only from DB provenance.
