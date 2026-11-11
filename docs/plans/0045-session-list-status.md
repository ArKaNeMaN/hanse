# 0045 - Session list live agent status

> Status: plan reviewed (`momus` OKAY WITH FIXES; findings folded).
> Design: [`docs/design/session-list-status.md`](../design/session-list-status.md).
> Owner decisions: `docs/design/session-list-status.md` section 9 (collected 2026-11-11).
> Full delivery cycle authorized by the owner on 2026-11-11.

## Bindings (from `docs/process.md`)

- Design author: maintainers. Design reviewer: `oracle` (done: PASS WITH FIXES, folded).
- Plan author: maintainers. Plan reviewer: `momus` (done: OKAY WITH FIXES, folded).
- Design docs: `docs/design/` (index `docs/design/README.md`).
- Plans: `docs/plans/` (index `docs/plans/README.md`).
- Journal: `docs/journal/` (index `docs/journal/README.md`). Next entry: `0053`.
- Open questions: none; the owner decisions are recorded in the design.
- Language: English.
- Commit policy: one coherent stage commit (code + tests + docs + record) on explicit owner
  instruction. The owner authorized the full cycle; no push is implied.

## 1. Goal

Add an additive, coarse per-session agent status to the per-app session list and render it in the
chat sessions rail: `Working` for `busy`, `Retrying` for `retry`, nothing for `idle`/unknown, with
the existing waiting-for-operator badge taking precedence.

## 2. Non-goals

See the design section 5. In short: no fine-grained `Thinking`/`Running <tool>` per row, no subtree
status aggregation, no fleet-wide list, no status TTL cache, no new route/table/SSE/dependency, no
status for stopped apps.

## 3. Invariants

- **I1**: A status-read failure, a malformed top-level status body, or an unrecognized upstream type
  never fabricates `idle` and never fails the session list. The list still returns 200 with the
  unchanged sessions and no `status` for the affected rows.
- **I2**: The waiting-for-operator badge always wins over the agent status.
- **I3**: `idle`, an absent entry, and an unknown status render nothing.
- **I4**: SSE is the live source. The list snapshot seeds only absent entries; on any stream resync
  (`gap` or a new `stream-id`) the client clears the map and refetches the list.
- **I5**: Only `{ type: "idle" | "busy" | "retry" }` is exposed; no upstream `message`/`next`/`action`,
  and no upstream `status` key survives.
- **I6**: No new route, table, migration, SSE stream, or dependency.
- **I7**: The active session's rail status is reconciled from the authoritative `/turn` snapshot.
- **I8**: Status is own-session only, never aggregated over the subtree.

## 4. Phases

### Phase A - Server status contract

Files: `src/opencode/client.ts`, `src/http/chat.ts`, `test/client.test.ts`,
`test/chat-page.test.ts`.

Steps:

- **A1.** In `src/opencode/client.ts`, extract the entry-parsing loop of `listSessionStatuses` into a
  shared helper that returns `OpencodeSessionStatusMap | null` (`null` = top-level body is not an
  object or is an array; individual malformed entries are dropped). Keep
  `listSessionStatuses` behavior identical (`null -> {}`).
- **A2.** Add `listSessionStatusesForList(endpoint)` using the shared helper, a dedicated
  `SESSION_LIST_STATUS_TIMEOUT_MS = 1_500` budget, the existing byte cap, and a thrown
  `OpencodeHttpError("/session/status", 0, "response body is not a session status map")` on `null`.
- **A3.** In `readSessionsResponse` (`src/http/chat.ts`), start
  `const statusesPromise = listSessionStatusesForList(endpoint).catch(() => undefined)` before
  awaiting `listSessions(endpoint)`, then await `statusesPromise` after the session list. A status
  rejection is swallowed and never becomes 502.
- **A4.** Build each row from a copy of the session with any upstream `status` removed first
  (`const base = { ...session }; delete base.status;`). Then add the computed `status` only when
  defined, then `draft`. This guarantees a failed or unknown read never leaks an upstream `status`.
  The computed status mapping is:
  - `statuses === undefined` -> omit `status`;
  - entry absent -> `{ type: "idle" }` (this includes an entry the shared helper dropped as
    malformed: the row is reported idle, never `Working`);
  - entry type `idle | busy | retry` -> `{ type }`;
  - any other type -> omit `status`.
- **A5.** Do not change `listSessions`, `listSessionsBounded`, the route regex, auth, or error
  mapping.

Acceptance:

- `GET /sessions` returns 200; a busy/retry/idle row carries the matching `status.type`; an absent
  upstream entry yields `{ "type": "idle" }`.
- A status read failure (transport/HTTP) still returns 200 with no `status` key on any row and the
  session list unchanged.
- A malformed top-level status body yields no `status`; a single malformed entry is dropped, the
  other statuses are returned, and the affected row reports `{ "type": "idle" }`.
- An unrecognized `type` omits `status` for that row.
- Only `type` appears in the payload; an upstream `status` field never survives, including on the
  failure branch.

Tests (`test/client.test.ts`, `test/chat-page.test.ts`):

- Tolerant reader: valid map; empty object; malformed top-level (throws); mixed good/bad entries
  (drops bad, keeps good).
- Sessions route: merge busy/retry/idle; absent entry -> idle; unknown type omitted; status read
  failure -> 200 with no `status`; only `{ type }` exposed.
- Upstream `/session` carries a `status` field while `/session/status` fails -> the response session
  has no `status` key.
- Update **both** exact upstream-call assertions:
  - `test/chat-page.test.ts` ~1405 (session-list read);
  - `test/chat-page.test.ts` ~2409-2413 (the "composes async=1..." list/message/send sequence).
  Because the two reads are concurrent, poll the fake server until both calls are recorded, then
  compare a sorted `method url` list (do not rely on arrival order).
- Make `emptyUpstream` (`test/chat-page.test.ts` ~1382-1392) answer `/session/status` with `{}`
  explicitly instead of `[]`.

### Phase B - Client store and page wiring

Files: `ui/stores/chat-session.ts`, `ui/pages/ChatPage.vue`, `test/chat-stores.test.ts`,
`test/ui/chat-page.test.ts`.

Steps:

- **B1.** `ChatSessionSummary` gains `status?: HanseSessionStatus`.
- **B2.** `setSessions` builds the next status map by:
  - keeping existing entries only for session ids still present in the list (prune);
  - seeding a response `status` only when the session has no kept entry;
  - never seeding a session whose `status` is absent.
  Assign the map once.
- **B3.** Add `clearAgentStatuses()` that sets an empty map. Do not touch waiting counts, the tree, or
  the selection.
- **B4.** In `ChatPage`, pass `sessionStore.statusBySession` to the rail (Phase C prop).
- **B5.** In `onResync`, call `sessionStore.clearAgentStatuses()` and `void sessionsQuery.refetch()`
  in addition to the existing warning/reconcile/turn refresh. This runs for both `gap` and new
  `stream-id` reasons (both lose stream continuity; the initial `stream-id` may cause one extra
  sessions fetch, which is accepted).
- **B6.** In the `turnProjection` watcher, when `routeState.session.value` is non-null and
  `projection.statusType` is `idle | busy | retry`, call `sessionStore.setAgentStatus(activeId,
  { type })` only if `agentStatusFor(activeId)?.type` differs. Ignore `null`/`unknown`.
- **B7.** In the `session.error` intentional-abort early return, when `event.sessionID` is a string,
  call `sessionStore.setAgentStatus(event.sessionID, { type: "idle" })`.

Acceptance:

- `setSessions` seeds an absent map entry from the response, preserves an existing entry, ignores a
  row without `status`, and drops entries for sessions no longer in the list.
- `clearAgentStatuses` empties only the status map.
- The active row's status follows the `/turn` snapshot type.
- The intentional-abort path clears the session's status.
- A `gap` or new `stream-id` resync clears the map and requests a sessions refetch.

Tests:

- Extend the existing store suite `test/chat-stores.test.ts` (do not create a duplicate store test
  file): seed from response; preserve existing; no seed when `status` is absent; prune removed;
  `clearAgentStatuses`.
- Add page-wiring cases in `test/ui/chat-page.test.ts`, using the existing `FakeEventSource` helpers
  (`chatEventSource()?.emit(...)`):
  - a synthetic `seq` gap and a new `stream-id` each clear the status map and issue a `GET /sessions`;
  - the active row follows `/turn` `busy`/`retry`/`idle` and ignores `unknown`;
  - the intentional `MessageAbortedError` early return clears the session status.

### Phase C - Rail rendering and styles

Files: `ui/components/chat/ChatSessionsRail.vue`, `ui/components/chat/ChatSessionNode.vue`,
`src/http/styles.css`, `test/ui/chat-support.ts`, `test/ui/chat-sessions.test.ts`.

Steps:

- **C1.** `ChatSessionsRail` gains `statusBySession: ReadonlyMap<string, HanseSessionStatus>` and
  passes it unchanged to each root `ChatSessionNode`.
- **C2.** `ChatSessionNode` gains `statusBySession: ReadonlyMap<string, HanseSessionStatus>` and
  computes `ownStatus = statusBySession.get(nodeId) ?? null`; it forwards the map in the recursive
  call. There is no separate `status` prop. Compute:
  `waiting -> null`; else `busy -> "Working"`; `retry -> "Retrying"`; else `null`.
  Render `session-item__meta` when `waiting > 0 || statusText !== null`; the waiting flag stays first
  (`v-if`), the status indicator is `v-else-if`.
- **C3.** Indicator: `<span class="session-item__status">` with an `aria-hidden` pulsing dot and the
  text label; no live region; no new focusable element.
- **C4.** In `src/http/styles.css`, inside the existing `@layer components` next to
  `.session-item__flag`/`.session-item__meta`, add `.session-item__status` (inline-flex, micro,
  readable token `--text-2` or `--warning`) and `.session-item__status-dot` (small round dot;
  animation reusing an existing pulse or a small local one). Add a `prefers-reduced-motion` rule that
  disables the animation.
- **C5.** `test/ui/chat-support.ts`: extend the fixture `sessions` type with
  `status?: { type: string }` (the handler already passes sessions through).
- **C6.** `test/ui/chat-sessions.test.ts`:
  - `busy -> "Working"`, `retry -> "Retrying"`, `idle`/absent -> no indicator;
  - a non-active waiting session with `busy` shows the waiting badge and not `Working`;
  - an active session with a waiting descendant shows the waiting badge (waiting still aggregates
    descendants on the active row);
  - the indicator adds no `role="status"` and no extra focusable element.
  - **Fixture trap:** the active session is reconciled from `/turn`; `defaultTurn` is idle. Assign
    `busy`/`retry` to non-active rows, or set the turn fixture too, when the assertion targets the
    active row.
- **C7 (corrected during execution - pre-existing blocker).** The deterministic `session-tree`
  chat-qa scenario is not usable for this stage: it defaults to `legacy` mode (retired chat), its
  `#session-list` selectors do not exist in the SPA rail, and its waiting badges depend on
  legacy-only population (the SPA rail's waiting counts come from prompt SSE events the scenario
  never emits). Enabling it is separate harness debt. Do not modify `docs/design/chat-qa.mjs` in this
  stage. Browser coverage for the rail comes from the Playwright `spa-chat` session-tree/chat specs;
  the new indicator itself is covered by the jsdom rail tests, not a dedicated screenshot. No visual
  PASS is claimed.

Acceptance:

- The rail shows `Working`/`Retrying` only for `busy`/`retry`; idle and unknown render nothing.
- The waiting badge always hides the status.
- The indicator is inside the existing meta row, does not shift the layout, is readable in both
  themes, and does not animate under reduced motion.
- The status text does not create a second focusable control or a live-region announcement.

### Phase D - Docs, browser evidence, gates

Steps:

- **D1.** Update `docs/current-state.md`:
  - the sessions-rail section: additive `status`, `Working`/`Retrying`, waiting precedence, idle
    hidden, reconnect refetch;
  - the `GET /sessions` contract note: only `{ type }`, absent on failure, 1.5 s bounded read;
  - the "Session lifecycle is not realtime in this stage" sentence: clarify that list membership is
    still refresh-triggered, while live agent status now comes from the list snapshot plus the
    existing SSE and is reconciled on resync.
- **D2.** Run the full verification set below and record results in the journal.
- **D3.** Browser evidence: `npm run test:e2e` (Playwright SPA chat/session-tree specs) is the
  browser gate and passes. The dedicated `session-tree` chat-qa scenario is blocked by pre-existing
  harness debt (legacy default mode, retired `#session-list` selectors, legacy-only waiting
  population), so no indicator-specific screenshot is produced and no visual PASS is claimed; record
  this blocker in the journal.

### Phase E - Record and commit

- **E1.** Write `docs/journal/0053-session-list-status.md` (context, what changed, decisions and why,
  artifacts, verification evidence, residual risks) and add it to `docs/journal/README.md`.
- **E2.** Ensure the design and plan index entries point to the completed status and journal.
- **E3.** Commit one coherent stage commit (code + tests + docs + record) with a Conventional Commit
  message, only this stage's files. Do not push unless asked.

## 5. Verification commands

```bash
npm run lint
npm run typecheck
npm run typecheck:ui
npx vitest run test/client.test.ts test/chat-page.test.ts test/chat-stores.test.ts test/ui/chat-page.test.ts test/ui/chat-sessions.test.ts
npm test
npm run build
npm run check:ui
npm run check:sensitive
npm run test:e2e
```

`npm run test:e2e` is required because this changes a rendered route. `npm run build` must run before
`npm run check:ui` so the built stylesheet contains the new class. The dedicated `session-tree`
chat-qa scenario is deferred as pre-existing harness debt (see C7/D3); no visual PASS is claimed.

## 6. Risks and rollback

- The only added upstream cost is one concurrent status read per session-list load, bounded at 1.5 s;
  a failure degrades to no status. No cache in this stage.
- The change is additive and has no schema or migration impact. Rollback is a normal revert of the
  stage commit; no data migration is needed.
- If the chat-qa harness cannot run in the environment, the jsdom and e2e suites still cover the
  behavior; the journal records the missing visual evidence.
- Accepted degradation: an individual malformed upstream status entry makes that row report idle
  (the badge can disappear) rather than losing the whole status map or fabricating `Working`.

## 7. Review

`momus` review (2026-11-11): **OKAY WITH FIXES**. Findings folded into this revision:

1. Upstream `status` leak on the failure branch -> A4 strips it before merging; added an explicit
   test.
2. Second exact-call assertion break + concurrent order -> both assertions named (~1405 and
   ~2409-2413); poll for both calls and compare sorted.
3. Rail/node recursion prop contradiction -> C1/C2 now pass the `statusBySession` map through the
   node; nodes compute their own status.
4. No page-level tests for B5/B6/B7 -> added named cases in `test/ui/chat-page.test.ts`.
5. Active-row fixture overwritten by `/turn` -> pinned non-active rows for status fixtures and added
   the active-row + descendant-waiting case; chat-qa rows are named.
6. Malformed individual entry -> idle not pinned -> accepted and documented; added a test.
7. `onResync` reason scope -> pinned to both `gap` and `stream-id`; added tests.
8. Store test file choice -> extend `test/chat-stores.test.ts` instead of a duplicate new file.
9. Docs update scope -> D1 now covers the realtime sentence and the bounded read.
10. Reduced-motion / no-focusable -> C6 adds DOM assertions and C4 the CSS rule.

### Execution correction (2026-11-11)

C7 was corrected during execution: the `session-tree` chat-qa scenario is pre-existing-stale
(legacy default mode, retired `#session-list` selectors, legacy-only waiting population). It was
reverted rather than partially repaired; browser coverage is the Playwright SPA chat/session-tree
suite, and the new indicator is covered by the jsdom rail tests. No visual PASS is claimed. No
design change or new review round is required.
