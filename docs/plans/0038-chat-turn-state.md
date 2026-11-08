# Plan 0038 - Truthful chat turn state

Status: **implemented and verified** (journal 0045) - `momus` plan review OKAY (2026-11-08); R1-R10
are folded. All phases and gates passed.

Design: [`docs/design/chat-turn-state.md`](../design/chat-turn-state.md) - Round 2 `oracle`
**PASS WITH FIXES**; all findings (B1-B4, S1-S19, N1-N10) are folded and the design-review gate is
cleared.

## Process binding

| Binding | Value |
| --- | --- |
| Design reviewer | `oracle` (done: Round 2 PASS WITH FIXES) |
| Plan reviewer | `momus` (done: OKAY; R1-R10 folded) |
| Design doc | `docs/design/chat-turn-state.md` |
| Design index | `docs/design/README.md` |
| Plan doc | `docs/plans/0038-chat-turn-state.md` |
| Plan index | `docs/plans/README.md` |
| Journal | `docs/journal/` + `docs/journal/README.md` |
| Open questions | `docs/open-questions.md` (stage 0038 resolved) |
| Language | English (docs, code, comments) |
| Commit policy | One coherent stage commit, only on explicit owner instruction |

### Owner decisions (closed 2026-11-08)

1. Idle + queue renders `Ready · N queued`; the queue strip is removed; the count opens a modal;
   active labels append `· N queued` using the display count.
2. Restore the legacy busy labels (`Working`, `Thinking`, `Running <tool>`, `Retrying`);
   `Waiting for you`/`Paused` stay in their approved surfaces.
3. Server-computed turn snapshot (Option B).
4. Hydration on ready/reconnect/visibility/status/send/idle and every reconcile.
5. Multi-tab consistency is best-effort.
6. Keep the existing label vocabulary.

### Invariants

The plan implements design invariants T1-T16; no phase may weaken one to make a test pass.

| Phase | Owned invariants |
| --- | --- |
| A | T9, T11, T13, T14, T16 |
| B | T1-T7, T12, T15 |
| C | T8, T10 |
| D | all (verification) |

### Non-goals

- No app SSE event-set change, no database schema, no persisted turn state.
- No change to opencode behavior or the `/event` projection.
- No visual redesign beyond the truthful labels and the queue modal.
- No changes to handoffs, attachments, previews, terminal, or the retired legacy renderer beyond the
  exclusions needed for the queue predicate.
- No commit without explicit owner instruction.

### Contract freeze

`TurnSnapshot` (design §4.1) and `GET /api/apps/:app/sessions/:sid/turn` are frozen before Phase A
and B start. Phase B may use a fixture/mock of the snapshot; Phase A must satisfy the same fixture.
This lets A and B proceed in parallel after A1 defines the types. The fixture lives in
`test/fixtures/chat-turn.ts` (or an equivalent shared module) and is imported by both the server
`deriveTurn` tests and the client turn tests.

---

## Phase A - Server turn engine and route

**Goal:** the coordinator computes one authoritative turn snapshot and serves it read-only without
starting an agent.

**Files:** `src/chat/turn.ts` (new), `src/opencode/client.ts`, `src/http/chat.ts`,
`src/http/handler.ts` (only if the route needs a dispatch touch), `test/chat-turn.test.ts` (new),
`test/chat-page.test.ts`, `test/chat-stage-b.test.ts`, `test/chat-stage-c.test.ts`.

**Work items**

A1. `src/chat/turn.ts`: the `TurnSnapshot` type and pure `deriveTurn(messages, status, options)`.
Define `options` explicitly: `{ isSubagent: boolean; settling: boolean; queuedTruncated: boolean }`
(the route supplies `isSubagent`; the derivation supplies the other two).
- Boundary: last visible assistant (non-empty non-synthetic text; tool/reasoning/patch/file/subtask)
  or its normal-user `parentID`.
- Pending: user rows after the boundary, excluding handoff, hidden synthetic, OMO internal/synthetic,
  and the resume prompt; excluding a resume prompt also consumes the immediately preceding pending
  user row.
- Empty rows: no non-hidden part and no attachment metadata/file part; an attachment-only row counts.
- `turnContinues` and `runningPromptID` per T13; `activePromptID` per the design.
- `queuedTruncated` when the page budget is exhausted before the boundary; `settling` per T14.
- Subagent: `options.isSubagent` + an absent status-map entry yields `unknown`, never idle.
- `revision` is a stable hash of status + turnContinues + active + running + queued + truncated.

A2. `src/opencode/client.ts`: a strict status read used by `/turn` that distinguishes a malformed
200 body (error) from a valid empty map; an explicit small `maxBytes` for the turn tail.

A3. `src/http/chat.ts`: `turnMatch = /^\/api\/apps\/([^/]+)\/sessions\/([^/]+)\/turn$/`, handled
before `ensure`; human-only; `?project`; the T9 matrix (401/403, 405, 404 `unknown_app` /
`session_not_found`, 409 `deletion_pending`, 503 `agent_stopped`, 503 `history_busy`, 502
`turn_unavailable` / `messages_too_large`). Use `findApp`, `withReadEndpoint`, `listMessagePage` with
the page budget, the **same `createMessageProjector` target as `/messages`** (so file-mode
attachment-only sends carry their `info.hanse.attachments` metadata), then `projectHandoffMessages`,
then `deriveTurn`. Resolve `isSubagent` from the session's `parentID` via a bounded
`listSessionsBounded` read (or a documented signal) and pass it in `options`.
Read order: status -> history -> status; retry once when the status changed between reads; set
`settling: true` when idle is still inconsistent after the retry. The cache stores the **derived
snapshot**, not the intermediate status reads, so both status reads are fresh.

A4. Per-session single-flight cache keyed by `appId + sessionId + endpoint`, TTL ~250-500 ms,
invalidated on an accepted send (202/200) inside the existing send path. No `observedAt`.

A5. Tests: the `deriveTurn` matrix (normal, busy pre-first-part, busy multi-step, queued, aborted,
tool-calls, idle override, handoff, OMO variants, resume/failed-resume, attachment-only, bare shells,
>tail/truncated, malformed map, subagent absent, status/history race/settling) and the route matrix,
including a route-level attachment-only send (projector present), a subagent session absent from
`/session/status`, `history_busy`, session 404, and the fake-upstream status/history race.

**Acceptance criteria**

- `GET .../turn` never starts a stopped app and returns the T9 status codes.
- A normal completed turn returns `idle`, `queuedPromptIDs: []`, `runningPromptID: null`.
- A busy pre-first-part turn returns `busy`, `turnContinues: false`, `runningPromptID: <head>`, and
  the display count excludes it.
- A handoff session does not list handoff rows as queued.
- A file-mode attachment-only send is counted, not treated as empty.
- A subagent session absent from `/session/status` returns `unknown`, not idle.
- A >tail queue returns `queuedTruncated: true` and the correct bounded count.
- A malformed upstream status map returns 502, not idle.
- No DB or SSE event-set change.

**Verification:** `npx vitest run test/chat-turn.test.ts test/chat-page.test.ts
test/chat-stage-b.test.ts test/chat-stage-c.test.ts`, `npm run typecheck`, `npm run lint`.

---

## Phase B - Client state model and selector

**Goal:** the SPA renders the server snapshot; no local row can create or hide the turn row; the label
is truthful and the queue count follows T13.

**Files:** `ui/chat/turn-state.ts` (new), `ui/stores/chat-feed.ts`, `ui/stores/chat-session.ts`,
`ui/chat/state-actions.ts`, `ui/chat/event-reducer.ts`, `assets/chat-core.js`, `ui/pages/ChatPage.vue`,
`ui/composables/useChatStream.ts`, `ui/composables/useChatComposer.ts`, `ui/chat/session-storage.ts`,
`ui/chat/queue.ts`, plus tests.

**Work items**

B1. `turn` slice + fetch/coalescing client: `status`, `turnContinues`, `runningPromptID`,
`activePromptID`, `queuedPromptIDs`, `queuedTruncated`, `settling`, `turnRevision`, `source`,
`requestEpoch`, `liveRevision`, `stale`. Fetch on session open, `stream.ready`, reconnect/gap,
visibility (page-level, even while the SSE is live), every reconcile, every status transition,
`session.error` (both paths), pause/limit, 202 acceptance, and dialog open.

B2. One `turn/apply` projection: feed status (`setAgentStatus`/`currentStatusType`), `thread.queue` /
`activePromptID`, and every server-backed row's `optimistic` presentation (`queued` for
`queuedPromptIDs` except `runningPromptID`; `accepted` otherwise). Remove the internal `deriveQueue`
use from `applySnapshot`/`rekeyOptimistic`/`recomputeQueue` for the row/queue path; keep `settleIdle`
for sealing only. The pure `deriveQueue` remains for parity tests until the follow-up cleanup.

B3. `origin:"server"|"local"` tagging; local rows never enter the backlog, the count, or the
`Queued` chip. Implement the disjoint-tail reset (shared-ID/non-empty check,
`position:"replace", keepOptimistic:"transient"`, cursor reset).

B4. Nullable `generationLabel()` with the full legacy inputs (`statusType`, `unsealedText`,
`unsealedReasoning`, `runningTool`, `sending`, `unknown`, `queuedCount`, `settling`). Implement the
T13 display count and the `Ready · N queued` / `N+` suffix; remove the queue fallback from the row;
`Ready` alone returns null; busy with no unsealed parts returns `Thinking`; `Waiting for you` and
`Paused` never create the row (D7).

B5. Hydration precedence `abort-settle > sse > snapshot`: `requestEpoch` + session + `liveRevision`
guard; the abort settle bumps `liveRevision` at start and end; a late snapshot busy never re-shows the
row after an abort settle. Client failure behavior T15 (502/503 keep + stale + bounded retry; 409
hide; 404 session-gone; `unknown` keep phase).

B6. Stream identity: the adapter remains the sole dedupe/gap owner; remove the dead reducer
duplicate/gap filtering and the `currentStreamID: null`/empty-map context; keep the mirrored identity
for diagnostics. Add adapter unit coverage: duplicate drop, gap detection, `stream.ready`, reconnect,
and the store identity mirror in `test/ui/chat-stream.test.ts`.

B7. Remove the queue-promotion block and its `sessionStorage` mirror; keep the unrelated image
intent. Retire the queue-block cases in `test/ui/chat-session-storage.test.ts` (keep image intent) and
rewrite the abort-suppression case in `test/ui/chat-queue.test.ts`. Implement the bounded
`sending -> unknown` transition (none exists today), keep the late-202 rekey and `pendingSends`
seeding. Name the client hash `turnRevision`.

B8. Tests: unit `deriveTurn` parity, selector matrix (including D7 waiting/paused row absence), B4
count cases, origin/local exclusion, tail/disjoint reset, hydration epoch/out-of-order/session-switch/
late-busy, error/pause/visibility, failure/stale, outbox idle/hung/late-202/reload, adapter identity.

**Acceptance criteria**

- With the server snapshot available, the row and count are exactly the design matrix; a local row
  changes neither.
- A busy pre-first-part turn shows `Thinking`, no suffix, no `Queued` chip.
- An idle completed turn shows no row; an idle queued turn shows `Ready · N queued`.
- A mid-stream gap or a missed idle recovers through `refreshTurn`; a late busy after abort does not
  re-show the row.
- No `deriveQueue` call drives the row, count, or `Queued` chip.
- The promotion block is absent; no `sessionStorage` queue key remains; the queue-block tests are
  retired and the abort-suppression case is rewritten.
- The outbox has a bounded `sending -> unknown` transition.

**Verification:** `npx vitest run test/chat-core.test.ts test/ui/chat-page.test.ts
test/ui/chat-queue.test.ts test/ui/chat-stream.test.ts test/ui/chat-session-storage.test.ts`,
`npm run typecheck:ui`, `npm run lint`.

---

## Phase C - UI surfaces and accessibility

**Goal:** remove the strip, add the turn-status live region and queue button, and make the dialog a
real modal.

**Files:** `ui/pages/ChatPage.vue`, `ui/components/chat/ChatThread.vue`,
`ui/components/chat/ChatGeneratingRow.vue`, `ui/components/chat/ChatQueueDialog.vue`,
`ui/components/chat/ChatQueueStrip.vue` (delete), `assets/app.css`, UI tests, `docs/design/chat-qa.mjs`.

**Work items**

C1. Remove the `ChatQueueStrip` usage and the `queue-strip` slot; delete the component and CSS if
unused elsewhere.

C2. Add the thread turn-status live region: label text + a `· N queued` button with a stable
accessible name and `aria-controls`; the generation row mirrors the label; announce once per
phase/label change; `Ready · N queued` / `N+`.

C3. Upgrade `ChatQueueDialog.vue` to a real modal (`<dialog>` or inert background): focus on open,
trap, Escape/backdrop close, return focus with a fallback when the count disappears, `role="dialog"`
with `aria-modal`, empty/failed states; the running row is marked active; rows come from
`queuedPromptIDs`.

C4. Tests: jsdom for the live region, button, focus, empty/failed, no strip; browser QA in SPA mode
with `data-chat-*` selectors and a deterministic gap/reconnect hook; reduced motion unaffected.

**Acceptance criteria**

- The strip is gone; the count button and the modal are the only queue surfaces.
- A single idle pending prompt shows `Ready · 1 queued` and the modal lists it.
- A running prompt is marked active, never queued.
- Keyboard: the count is reachable, the dialog traps and restores focus.
- The live region announces a phase change once, not per token; no double announcement with the
  dock/meta.

**Verification:** `npx vitest run test/ui/chat-cards.test.ts test/ui/chat-queue.test.ts`, `npm run
build:css`, `npm run build:ui`, `npm run check:ui`, `node docs/design/chat-qa.mjs` in SPA mode.

---

## Phase D - Verification, docs, and record

**Goal:** prove the class is closed and leave the stage recorded.

**Work items**

D1. Full gates, in order:
```bash
npm run lint
npm run typecheck
npm run typecheck:ui
npm run typecheck:e2e
npm test
npm run build
npm run check:ui
npm run check:sensitive
npm run test:e2e
```
D2. E2E matrix (`e2e/spa-chat.spec.ts`): normal finish, queued prompt, Stop, mid-stream gap,
reconnect, reload, session switch, OMO/synthetic, resume failure, attachment-only, >tail queue,
queue modal, two tabs, `session.error`, pause/limit, visibility-while-live, busy pre-first-part, busy
multi-step, hydration race, waiting/paused; rewrite the existing queue/Stop case to the new
turn-status surface (the file is SPA, not legacy).
D3. Browser QA (`docs/design/chat-qa.mjs`): SPA mode, `data-chat-*` selectors, the normal/queued/
abort/reload/dialog/gap scenarios; use the exact `CHAT_QA_ONLY` set (or fix the documented
pre-existing queue-strip assertion in `docs/design/README.md:149-152`) so the gate is reproducible;
capture screenshots and the report.
D4. Docs: update `docs/current-state.md` (SSE/status/turn, route, row, queue modal, supersessions),
`docs/design/README.md`, `docs/plans/README.md`, `docs/journal/README.md`, and the stage journal.
D5. Record: context, what was done, the supersessions (chat-mobile-polish §D6, chat-pagination §D7
Ready/announcement), the T14 race decision, test evidence, open threads, next steps.

**Acceptance criteria**

- Every gate is green; no pre-existing failure is silently attributed to this stage.
- The phase test matrix (unit, route, adapter, jsdom, e2e, QA) covers every design §9 row; the plan's
  test map names the owning test for each row, and the pre-existing QA failure is either fixed or
  explicitly excluded.
- `current-state.md` matches the implementation; the three supersessions are recorded.
- The journal entry and all indexes are current.
- No commit unless the owner explicitly authorizes it.

---

## Risks and mitigations

| Risk | Mitigation |
| --- | --- |
| Chat feed blast radius | Contract freeze, matrix tests first, full e2e/browser QA. |
| Server history read cost | Single-flight cache, explicit small `maxBytes`, page budget, history budget, QA measurement. |
| Predicate duplication (server vs `chat-core.js`) | Shared fixtures + a parity test covering OMO, resume, attachment-only, tool-calls, aborted assistants. |
| Status/history race | T14 status -> history -> status, one retry, `settling` suppression, fake-upstream test. |
| Malformed upstream status | Strict read returns 502, never idle. |
| Subagent status absence | `unknown`, not idle; documented limit; fixture. |
| Multi-tab divergence | Best-effort, stated; hydration on transitions/visibility. |
| Modal UX regression | Focus/escape/fallback tests and browser QA. |
| Retiring the promotion block | Owner-approved `Ready · N queued` semantics; recorded in the journal. |

## Parallelization

After A1 freezes the `TurnSnapshot` type and fixture, Phase B can start against the fixture while
Phase A finishes the route and cache. Phase C depends on B's selector and count contract. Phase D
depends on A-C. No phase may merge a partial contract.

## Deviations

Any deviation from this plan is surfaced to the owner before implementation; a material scope change
returns to the design.

## Plan review

### `momus` (2026-11-08) - **OKAY**

Verdict: approved to implement after the SHOULD FIX items below are folded; no BLOCKER. R1-R10 are
folded into the phases above.

| ID | Severity | Finding | Resolution |
| --- | --- | --- | --- |
| R1 | SHOULD FIX | `/turn` did not name the history projector; file-mode attachment-only sends have only the synthetic manifest and no `info.hanse.attachments`, so `deriveTurn` would drop them. | A3 now reuses the `/messages` `createMessageProjector` target; A5 adds a route-level attachment-only test. |
| R2 | SHOULD FIX | Subagent status was not derivable: absent status = idle vs subagent = unknown, with no session-parent input. | A1 defines the `options` (`isSubagent`, `settling`, `queuedTruncated`); A3 resolves `parentID` via a bounded `listSessionsBounded` read; A5 adds the subagent route test. |
| R3 | SHOULD FIX | T14's status -> history -> status read had no owning work item and the cache could collapse it. | A3 owns the read order, the one retry, `settling`, and caches the derived snapshot rather than the status reads. |
| R4 | SHOULD FIX | Phase A named a nonexistent `test/chat-http.test.ts`. | Phase A verification now names `test/chat-page.test.ts`, `test/chat-stage-b.test.ts`, `test/chat-stage-c.test.ts`. |
| R5 | SHOULD FIX | The removed queue block left its tests behind. | B7 retires the queue-block cases and rewrites the abort-suppression case; B verification includes `test/ui/chat-session-storage.test.ts` and `test/ui/chat-queue.test.ts`. |
| R6 | SHOULD FIX | "Keep the send timeout" was false; no `sending -> unknown` timeout exists. | B7 now implements the bounded transition; B8 asserts the hung-send case. |
| R7 | SHOULD FIX | Adapter tests were missing. | B6/B8 and Phase B verification add `test/ui/chat-stream.test.ts` (duplicate, gap, `stream.ready`, reconnect, identity mirror). |
| R8 | SHOULD FIX | Phase C ran `check:ui` after only `build:css`. | Phase C now runs `npm run build:ui` before `check:ui`. |
| R9 | SHOULD FIX | D claimed the e2e/QA covered all of design §9 while D2/D3 omitted rows. | D2/D3 extend the matrix; D acceptance now requires a test map and handles the documented pre-existing QA failure. |
| R10 | SHOULD FIX | "Each phase names its invariants" was not met. | The Invariants table now maps A/B/C/D to their T-IDs. |

No BLOCKER findings. The plan may proceed after R1-R10 were folded (done in this revision).
