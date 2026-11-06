# 0041 - Stage-1 handoff threads

Stage: `0034-handoff-threads`
Design: [`docs/design/handoff-threads.md`](../design/handoff-threads.md) (stage-1 reduced design,
`oracle` PASS; exact v22 SQL validated 41/41)
Plan: [`docs/plans/0034-handoff-threads.md`](../plans/0034-handoff-threads.md) (`momus` round 1 PASS)
ADR: [`docs/decisions/0016-thread-handoffs.md`](../decisions/0016-thread-handoffs.md)
Commit: `<commit-hash>` (placeholder; commit follows the stage record)

## What shipped

Stage 1 adds an explicit, agent-originated multi-turn handoff mode beside one-shot handoffs. A thread
is one `handoffs` header plus an ordered `handoff_messages` log. The source starts it with
`request_sibling_change(mode="thread")`, follows up with `send_handoff_message`, and the target answers
each inbound message with `deliver_handoff` + required `reply_to`. A thread ends only by idle TTL,
the 32-message cap, or a human operator cancel. Binding is observed from the exact managed MCP tool
part plus a coordinator nonce; delivery is a generic per-thread/per-destination queue with no retry.

### Owner decisions and scope reduction

The owner chose variant B, a first-class thread header with an ordered message log rather than a chain
of one-shot handoffs. Thread mode is an explicit source-agent opt-in; ordinary handoffs remain
one-shot. Approval exists only at thread start and uses the existing dispatch policy; a pair whose
reply policy is `approve` folds that gate into the start instead of per-message approval. Multiple
threads may share a target through the delivery queue. Titles use `[HO]`, and the summary survives
truncation. Same-application and cross-project threads stay out of scope.

After four design-review rounds the owner selected a compact stage 1: core start, ordered messages,
queued delivery, start approval, idle TTL, message cap, operator cancel, titles, observed binding,
quotas, public-read allowlist, and the agent-token gate. Deferred: clean close, per-message
retry/resend, relaunch/retarget/failThread, the shared-session operator path, target-initiated
messages, thread chat projection/client parser changes, and the one-shot envelope/security redesign.

## Per-phase implementation

### Phase A - schema, types, store helpers

- Migration v22 is additive: thread header fields (`mode`, `message_seq`, `message_count`,
  `last_message_at`, `thread_idle_expires_at`, `source_invoking_session_id`), 17
  `handoff_messages` columns, defensive backfill, 8 triggers, and 16 indexes. No rebuild; the runner
  is unchanged and `knownMax` derives from the last migration.
- Added `HandoffMode`, message state/kind/side types, `HandoffMessage`, `HandoffTransitionConflictError`,
  header/message transition tables, and mode-aware `expireDueHandoffs`/`failTimedOutHandoffs`.
- Added low-level thread store helpers: get/list/insert, message CAS transitions, and guarded counter
  allocation.

### Phase B - creation, append, reply, service, MCP

- Thread start is one `BEGIN IMMEDIATE` transaction: namespaced idempotency
  (`v1|<project>|<from>|<to>|thread|<key>` with a matching legacy raw-key fallback), header 1/1,
  initial request `seq=1` with the exact validated spec bytes, generated client id/nonce, policy
  decision, approval row in the same transaction, and atomic denial/rollback.
- `send_handoff_message` appends source follow-ups; `deliver_handoff` appends target replies with
  required `reply_to`, one reply per source, and cancelled-slot reuse. Rejected appends allocate no
  sequence or count.
- Service and MCP surfaces add `mode`, thread result fields, `send_handoff_message`, thread
  `deliver_handoff`, and an agent-safe `handoff_status` projection. One-shot input/output and stored
  key format stay unchanged.

### Phase C - observation, binding, dispatch, queue, titles

- Observation matches only `${COORDINATOR_MCP_NAME}_request_sibling_change`,
  `..._send_handoff_message`, and `..._deliver_handoff`, only exact completed tool parts.
- The async binder resolves the observed session to its durable root through a bounded, cycle-safe
  `listSessions()` parent walk (depth 8), validates nonce/message/app side/header state, records
  `source_invoking_session_id` and `source_session_title`, and CASes `binding -> queued`.
  Follow-up/reply binding failures cancel only that message; the initial request is the only thread
  `failed` start path.
- Thread-start dispatch claims without sending, creates a fresh target session, and in one transaction
  stores `target_session_id`, `target_session_title`, the initial `delivery_session_id`, `in_progress`,
  and a refreshed idle deadline. The generic queue claims queued messages with strict head-of-line and
  per-destination ordering, persists `delivery_message_id` before send, marks success `delivered`, and
  parks 404/transport/stale failures in `waiting_operator` with no retry.
- Envelopes use a fresh nonce fence and marker escaping; titles follow the `[HO]` truncation rules.
  Source follow-ups persist `delivery_session_id = target_session_id`; target replies persist
  `delivery_session_id = source_session_id`.

### Phase D - lifecycle, quotas, public read, security

- Idle expiry transitions `in_progress -> expired` and cancels remaining binding/queued/waiting
  messages with `thread_expired`; a dispatching message blocks expiry. Human operator cancel is
  atomic and soft. Terminal threads are garbage-collected after 30 days in batches of 100.
- DB-backed source-active, target-pending, app-rate, and failure-only security limits run inside the
  creation/append transactions. Mutating thread tools write count-only
  `handoff.thread.attempt` events `{appId, tool, outcome}`; `handoff_status` and one-shot writes none.
- `publicHandoffProjection` exposes exactly `id`, `state`, `summary`, `fromAppKey`, `toAppKey`,
  `createdAt`, `updatedAt`, `lastMessageAt`, `threadIdleExpiresAt`, `mode`, `messageCount`.
  `GET /api/handoffs` is human-only; `GET /api/projects` stays public but projects every handoff.
- A presented valid agent token is rejected on every non-MCP HTTP route and WebSocket upgrade, with
  exact `/internal/mcp` exempt. Invalid tokens do not trigger the gate. Thread errors persist fixed
  codes/safe messages and dispatcher logs avoid raw prompt/body/token-bearing URLs.

### Phase E - regressions and recording

- Added one-shot regression coverage for long summary/large spec/legacy idempotency keys, the exact
  one-shot `handoff_status` key set, byte-shaped one-shot `HandoffCard` metadata, one-shot
  dispatch/reply envelopes, thread messages remaining unannotated, and public read/agent-token
  hardening.
- Wrote this journal and ADR 0016; updated `docs/current-state.md`, the design/plan/journal indexes,
  and the plan status.

## Verification

Run on 2026-11-06:

```bash
npm run lint            # pass (782 files)
npm run typecheck       # pass
npm run typecheck:ui    # pass
npm test                # pass (232 files, 3446 tests)
npm run build           # pass
npm run check:ui        # pass (79 SFCs, sentinel present; ChatPage ~70.4 kB gzip)
npm run check:sensitive # pass
```

`test:e2e` was not run: the stage changes no UI source, rendered route, or client parser/type; titles
are data rendered by unchanged components. This matches plan section 10.

## Deviations from the plan

- Phase C also added binding-timeout cleanup and history-based binding reconcile. These implement D4
  and the §7.3 reconcile requirement rather than adding new scope.
- Thread start failures persist the fixed `start_failed` header error and message `error_code`; raw
  launch/send details stay in logs (which are themselves fixed to ids/codes only for thread paths).
- Policy-denied thread starts record attempt outcome `failure` under the "any rejection/failure" rule;
  queued/awaiting/existing starts record `ok`.
- The public-read and agent-token hardening intentionally change one-shot-visible behavior, as
  approved by D9; one-shot lifecycle, prompts, projection, dispatch/reply, and validation are otherwise
  unchanged.

## Accepted debt and residual risks

- Post-start prompt injection remains inherent; envelopes, caps, rate limits, and fenced untrusted
  content mitigate it. Thread messages are ordinary user turns, not a privileged role.
- Isolation is logical: a compromised app controls its event stream; the app token + exact observed
  part + nonce are the boundary. Two sessions of one app are not isolated.
- Cancel is soft; an in-flight turn is not aborted. Bodies are unencrypted at rest.
- A `waiting_operator` head blocks the thread until cancel or the 24 h idle TTL; there is no
  retry/relaunch.
- There is no thread chat projection/transcript and no client parser/type change.
- `handoff_status` is app-scoped, not session-scoped. Reconcile binding is exact-nonce and fail-closed.
- Lost-response duplicates remain possible unless the agent echoes the generated client id/key.
- DB rate limits assume a single-writer SQLite coordinator; a concurrent writer may see a stale count
  (cost control, not authorization). Thread-start dispatch also assumes one coordinator.
- One-shot error/note redaction and envelope/security redesign are not fixed here; pre-existing
  one-shot risks remain residual.
- The `handoffs_active_thread_pair` index is inert until a future shared-session path adds its guard.

## Follow-ups

- Deferred features: clean close/`close_handoff`, per-message retry/resend, relaunch/retarget/
  failThread, the shared-session operator path, target-initiated messages, thread chat transcript/UI,
  and a thread `HandoffCard`/client parser.
- The one-shot envelope/security redesign remains a separate future stage.
- Worktree isolation, cross-project threads, same-app handoffs, attachments, editing, deletion,
  branching/forking, per-thread model selection, and automatic session reuse remain out of scope.
