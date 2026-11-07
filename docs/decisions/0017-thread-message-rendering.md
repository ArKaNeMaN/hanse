# 17. Thread message rendering and the agent-to-agent question ban

- Status: Accepted
- Date: 2026-11-07
- Design: [`docs/design/thread-chat-rendering.md`](../design/thread-chat-rendering.md)
- Plan: [`docs/plans/0035-thread-chat-rendering.md`](../plans/0035-thread-chat-rendering.md)
- Journal: [`docs/journal/0042-thread-chat-rendering.md`](../journal/0042-thread-chat-rendering.md)

## Context

Stage 0034 implemented agent-originated handoff threads but deliberately deferred chat projection and
target-session question behavior. Thread messages were injected as ordinary user turns, so the chat
rendered them like operator input. A target agent could also interject an interactive question that
the operator could not meaningfully answer between agents.

The rendering work must stay additive: one-shot handoff metadata, card DOM, projection, prompts, and
lifecycle remain byte-compatible, and the database stays at v22.

## Decision

1. **Additive thread metadata.** `HandoffMessageMeta` gains optional `mode: "thread"`, `kind`,
   `authorSide`, `messageId`, and `seq`. One-shot metadata never sets them and never carries a thread
   operator note.
2. **Thread-first server projection.** The live resolver queries `handoff_messages` by
   `delivery_message_id` before the unchanged one-shot query. History keeps the one-shot map and adds a
   `delivery_session_id` + page-id thread query, annotating with thread precedence. Author identity
   comes from `handoff_messages.author_app_id` with a participant fallback.
3. **One card, thread variant.** Reuse `HandoffCard`, selected by `handoff.mode === "thread"`. The
   variant adds a `Thread` badge, author, kind label, sequence, route, reply-only outcome, an
   accessible group label, and no operator-note block. The existing operator-bubble suppression for
   any handoff already covers it.
4. **First-line body extraction.** `handoffBodyFromText` enters the thread branch only when the first
   non-empty line is a thread start/message/reply marker. Start/reply drop the summary block; message
   returns the fenced content; missing marker/fence returns an empty body. The one-shot extraction
   path is unchanged, so a one-shot spec that quotes a marker stays one-shot.
5. **Target-root question auto-reject.** The dispatcher handles `question.asked` before its tool path,
   dedupes by `${app.id}:${request.key}`, resolves the observed session to its durable root, and
   rejects only a root that is the target of an `in_progress` thread. Source-first precedence wins an
   overlap. v2 rejects with the observed session id (subagent-safe); v1 uses the request id. 404/409
   and human-answer races are swallowed with no retry, and unresolved endpoint/root fails open.
6. **SSE and prompts visibility filter.** With a dispatcher present, `streamAppEvents` drops
   target-root `question.asked` frames and `handlePromptsList` drops matching v1/v2 questions. This is
   read-only hygiene; without a dispatcher both paths forward everything.
7. **Target-only prompt line.** The exact question-ban line is appended to thread start and follow-up
   prompts only. The source-facing reply prompt and all one-shot prompts are unchanged; permissions
   remain allowed.

## Consequences

- One-shot behavior is unchanged: the new metadata fields are absent, thread rows leave one-shot
  routing columns null, and the one-shot card branch keeps its DOM.
- No migration, schema bump, trigger, or index is added. Thread rows reuse
  `delivery_message_id`/`delivery_session_id`.
- Text parsing only affects the displayed body. Author, thread, kind, and sequence always come from
  server metadata, so hostile envelope text cannot change identity.
- Threads remain ordinary user turns, so the stage-0034 prompt-injection residual is unchanged.
- The guard is policy, not a hard security boundary; an agent can avoid the question tool or call the
  loopback directly. Suppression also depends on a live dispatcher.
- No thread-management UI/route, operator thread creation, session reuse, target-initiated messages,
  attachment path, or worktree isolation is added.

## Alternatives rejected

- **A new `ThreadMessageCard` component:** duplicates Markdown safety, disclosure, outcome, inbox, and
  accessibility behavior and drifts from the one-shot card.
- **Parsing author/thread identity from envelope text on the client:** attacker-controlled text cannot
  be authoritative.
- **A global `question` deny in the permission policy:** the policy is instance-wide and would break
  the operator's own questions.
- **Prompt-only question ban:** the model can still call the tool; the server auto-reject is the
  actual unblock.
- **Aborting the target turn on a question:** destroys useful work and has no thread failure state.
- **Per-thread agent/profile selection:** the client has no per-thread agent choice; a separate future
  design.
