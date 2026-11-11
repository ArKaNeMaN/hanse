# Session list live agent status

> Status: design reviewed (`oracle` PASS WITH FIXES; findings folded). Plan:
> `docs/plans/0045-session-list-status.md`. Owner asked for the full delivery cycle on 2026-11-11.

## 1. Context

The chat workspace lists sessions in the sessions rail (`ui/components/chat/ChatSessionsRail.vue` ->
`ui/components/chat/ChatSessionNode.vue`). A row currently shows only the session title and an
aggregate `N waiting` badge for pending questions/permissions. It does not show whether the agent is
currently working.

The chat thread already shows live turn status (`Thinking`, `Working`, `Running <tool>`, `Retrying`)
derived from the active session's server turn snapshot plus live parts. The rail does not receive
that status, even though the browser already keeps a per-session status map
(`ui/stores/chat-session.ts` `statusBySession`) fed by the app-scoped SSE `session.status` events for
every session of the app (`ui/chat/state-actions.ts`).

The owner wants every active-session row to show a live status, hide it when idle, and let the
existing "waiting for operator" badge take precedence over the status.

## 2. Decision

Extend the existing per-app session list response with an additive, coarse agent status and render it
in the rail.

### Server

In `readSessionsResponse` (`src/http/chat.ts`), start `listSessionStatusesForList(endpoint)` and
`listSessions(endpoint)` concurrently. The status read has its own short budget (1.5 s) and is
swallowed per-promise, so a status failure can never turn the session list into a 502.

`listSessionStatusesForList` is a new tolerant reader in `src/opencode/client.ts`:

- a **malformed top-level body** (not an object or an array) is an error, so the caller can omit the
  field instead of fabricating idle;
- **individual malformed entries** are dropped, like the existing `listSessionStatuses`. A session
  whose entry is dropped is treated as absent, so its row reports idle. This bounded degradation can
  hide an active row's badge, but it never fabricates `Working`;
- a valid empty object means "no active sessions".

Merge `status` onto each session, after the `...session` spread so a hypothetical upstream `status`
cannot leak through:

- upstream entry present with a known type -> `{ type }` (`idle | busy | retry`);
- upstream entry present with an unrecognized type -> omit `status` for that row (unknown, not idle);
- upstream entry absent -> `{ type: "idle" }` (upstream `GET /session/status` lists only active
  sessions);
- the status read failed -> omit `status` for every row.

Only `type` is projected; upstream `message`/`next`/`action` are dropped.

No status cache is added in this stage. The status read is concurrent and bounded at 1.5 s. A short
TTL cache is a follow-up if list refetch traffic or upstream load becomes a problem.

### Client

`ChatSessionSummary` gains `status?: HanseSessionStatus`. `setSessions`:

- prunes `statusBySession` entries whose session is no longer in the list;
- seeds an entry from the response only when the session has no entry yet, so a fresher SSE
  transition is never overwritten by an older list snapshot;
- never seeds a row whose `status` field is absent (unknown).

A new `clearAgentStatuses()` empties the map.

**Reconnect rule.** A missed `session.status idle` must not leave a row `Working` forever.
`seed-if-absent` alone trusts the first SSE value. On `onResync` (gap or reconnect, where the stream
may have lost frames), `ChatPage` clears `statusBySession` and refetches the session list, which
re-seeds the current statuses. The stream is not stateful and does not replay missed events, so this
is the authoritative resync point.

**Active-session reconcile.** When the active session's turn snapshot changes, `ChatPage` writes
`{ type }` into `statusBySession` for that session when the snapshot type is `idle | busy | retry`
(ignoring `unknown`), only if it differs from the current entry. The turn snapshot is the
authoritative status for the active session, so the rail and the thread cannot drift after a missed
event.

**Error branch.** The intentional-abort early return in `ChatPage.handleEvent` currently bypasses
`session.setAgentStatus(idle)`. Add that reset for `event.sessionID` in the branch so the rail clears
there too.

The existing app-scoped SSE `session.status` path remains the live update source; no new subscription
is added.

### UI

The rail receives `statusBySession` and passes each node its own status. `ChatSessionNode` renders, in
`session-item__meta`:

1. the existing waiting badge when `waitingTotals > 0` (highest precedence);
2. otherwise a status indicator: `busy -> "Working"`, `retry -> "Retrying"`;
3. otherwise nothing (`idle`, absent, or unknown).

The indicator is a small pulsing dot (`aria-hidden`) plus the text label, styled next to the existing
`session-item__flag`, inside the existing `@layer components`. The label is the accessible signal; no
live region is added. Use a readable token (`--text-2` or `--warning`, not `--text-3`). Add a
`prefers-reduced-motion` rule for the dot. The status text joins the session button's accessible
name ("Title Working"); this is intentional and acceptable.

## 3. API contract

`GET /api/apps/:app/sessions?project=<id>` (human-only, unchanged route and auth):

```json
{
  "sessions": [
    {
      "id": "ses_...",
      "title": "...",
      "parentID": "ses_...",
      "time": { "created": 0, "updated": 0 },
      "draft": { "hasText": false, "attachmentCount": 0, "emptyDraft": false, "updatedAt": null },
      "status": { "type": "busy" }
    }
  ]
}
```

- `status` is optional and additive; older clients ignore it.
- `status.type` is one of `idle | busy | retry`.
- Known idle session (absent from the upstream active map) -> `{ "type": "idle" }`.
- Unknown upstream type, malformed top-level body, or network/HTTP failure -> `status` is absent.
  The list still returns 200 with the unchanged sessions.
- A row whose individual upstream entry was malformed is treated as absent -> `{ "type": "idle" }`.
  This can hide an active row's badge but never fabricates `Working`.
- `status` is placed after the session spread; only `type` is exposed. Any upstream `status` key is
  stripped first, so a failed read cannot leak it.

## 4. Precedence and aggregation

Per row, highest first:

1. **Waiting for operator** - the existing aggregate `waitingTotals` badge. It already covers the
   node's own pending prompts plus descendants' pending prompts.
2. **Agent status** - the node's own `statusBySession` entry.
3. **Nothing** - idle or unknown.

The existing rail deliberately excludes the active session from `waitingTotals` because its waiting
state is rendered in the composer dock. This stage keeps that behavior: the active row shows its
agent status (reconciled from `/turn`) and does not duplicate the waiting badge. The owner delegated
this edge case and chose the smaller change.

**Status is own-session only; it is not aggregated over the subtree.** The owner's requirement is
"current status for each active session", and a parent that spawns a subagent is normally itself
busy while it waits on that tool call. A collapsed parent may therefore show nothing while only a
descendant works; the waiting badge still aggregates because it demands operator attention.
Aggregating `busy`/`retry` over the subtree is an explicit non-goal and a possible follow-up.

## 5. Non-goals

- No fine-grained per-session `Thinking` / `Working` / `Running <tool>` labels. Those need the
  active session's live parts (unsealed text/reasoning and running tools), which exist only for the
  session currently open in the thread. Non-active rows cannot derive them from the coarse status map.
- No subtree aggregation of `busy`/`retry` (own-session only; waiting still aggregates).
- No fleet-wide or cross-app session list. There is no global session endpoint; this stage is the
  per-app chat rail only.
- No status TTL cache in this stage (the read is concurrent and bounded at 1.5 s).
- No new route, SSE stream, table, migration, or persistence.
- No change to how pending questions/permissions are tracked, counted, or displayed.
- No status for stopped apps: `GET /sessions` already returns `503 agent_stopped` when no endpoint is
  attached.

## 6. Alternatives considered

- **Client-only from the existing SSE map.** Rejected: after a reload, non-active sessions have no
  status until their next SSE event; only the active session has a snapshot (`/turn`). The first
  paint would be wrong.
- **Reuse `session_resume`.** Rejected: it stores only `busy`/`retry`, never idle, and exists for
  interruption/resume semantics, not as a complete per-session status cache.
- **Call `GET .../turn` per row.** Rejected: one expensive request per row with history projection.
- **A dedicated status endpoint.** Rejected: one more route for a single small additive field.
- **Always overwrite statuses from the list snapshot.** Rejected: a list response can be older than
  an SSE transition that arrived after the request started. Seed-if-absent plus a reconnect refresh
  is correct without timestamps.

## 7. Impact

- `src/opencode/client.ts` - tolerant 1.5 s session-status reader for the list (shared parsing with
  the existing reader).
- `src/http/chat.ts` - concurrent status read and merge in `readSessionsResponse`.
- `ui/stores/chat-session.ts` - `status` on `ChatSessionSummary`, seed-if-absent, prune,
  `clearAgentStatuses`.
- `ui/pages/ChatPage.vue` - pass the status map to the rail; clear + refetch sessions on `onResync`;
  reconcile the active session from the turn snapshot; reset the map in the intentional-abort branch.
- `ui/components/chat/ChatSessionsRail.vue` - new prop, forward to nodes (including recursion).
- `ui/components/chat/ChatSessionNode.vue` - precedence computation and indicator markup.
- `src/http/styles.css` - indicator style, readable token, reduced-motion rule.
- `test/client.test.ts` - tolerant reader: malformed top-level throws, bad entries dropped, empty map.
- `test/chat-page.test.ts` - status merge, idle default, unknown type omitted, read-failure fallback;
  update the existing exact upstream-call assertion and the `emptyUpstream` `/session/status` reply.
- `test/ui/chat-support.ts` - fixture `sessions` type gains `status?`.
- `test/ui/chat-sessions.test.ts` - status rendering, waiting precedence, store seed/prune behavior.
- `docs/current-state.md` - current behavior note.

## 8. Risks

- **Tail latency.** The status read is bounded at 1.5 s and is swallowed on failure; the sessions
  response never waits for the 5 s default. A cold load can still take up to ~1.5 s longer if the
  upstream status endpoint is slow. A TTL cache is a follow-up.
- **Snapshot/SSE race.** Seed-if-absent avoids regressing a live transition with an older list
  snapshot; `onResync` clears and refetches after a gap/reconnect so a missed idle cannot stick.
- **Cross-call race.** A session can start/stop between the session list and status reads; the coarse
  status can be briefly wrong until the next SSE event or list refetch. Accepted.
- **Malformed upstream body.** A malformed top-level body omits status instead of fabricating idle;
  individual bad entries are dropped without losing the rest of the map.
- **No sensitive data.** Only the coarse `type` is returned. The list route is already human-only and
  app-scoped.

## 9. Owner decisions

Collected 2026-11-11 (chat):

1. Variant B (status in the session list, server-merged) is approved.
2. The waiting-for-operator badge overrides the agent status.
3. Active-session waiting behavior is delegated; the smaller change (existing active-session
   exclusion) is used.
4. Status-read failure behavior is delegated; the status is omitted (unknown).
5. Extra retry detail (attempt/message tooltip) is not required and is skipped.
6. The full delivery cycle is authorized: design, design review, plan, plan review, implementation,
   record, commit.

## 10. Open questions

None.

## 11. Review

`oracle` review (2026-11-11): **PASS WITH FIXES**. Findings folded into this revision:

1. Malformed 200 fabricating idle -> added `listSessionStatusesForList` (top-level malformed is an
   error, bad entries dropped). §2/§3/§8.
2. Unrecognized type mapping to idle -> now omits `status`. §2/§3.
3. Stale status after reconnect -> `onResync` clears and refetches; seed-if-absent plus prune. §2.
4. Active session vs `/turn` divergence -> reconcile `statusBySession` from the turn snapshot. §2.
5. `session.error` early return skips the map -> explicit idle reset. §2.
6. Subtree status aggregation -> documented as an explicit non-goal; own-session only. §4/§5.
7. Tail latency -> 1.5 s status budget, per-promise catch, no TTL cache in this stage. §2/§5/§8.
8. Merge ordering -> `status` after `...session`. §2/§3.
9. Existing test breakage -> listed in Impact. §7.
10. UI fixture and store tests -> listed in Impact. §7.
11. Prune on list replace -> seed path prunes removed sessions. §2.
12. Indicator details -> `aria-hidden` dot, text label, readable token, reduced-motion, layer
    placement. §2/§7.
