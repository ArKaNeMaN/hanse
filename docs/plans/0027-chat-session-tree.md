# Plan 0027 - Chat session tree

- Design: [`docs/design/chat-session-tree.md`](../design/chat-session-tree.md), **design review PASS**
  (`oracle`, round 3, 2026-10-25).
- Design reviewer: `oracle`; plan reviewer: `momus`.
- Owner decisions: closed 2026-10-25; see `docs/open-questions.md`, stage `0027-chat-session-tree`.
- Verification (every phase): `npm run lint && npm run typecheck && npm test && npm run build`;
  `npm run check:sensitive` before commit; browser QA `node docs/design/chat-qa.mjs`.
- Commit policy: one coherent stage commit (code + tests + docs + journal) only on the owner's
  explicit instruction, Conventional Commits.
- Plan review: **PASS** (`momus`, 2026-10-25).
- Status: **implemented and verified** (2026-10-25); stage committed.
- Record: `docs/journal/0032-chat-session-tree.md`.
- Record deliverables: `docs/current-state.md`, `docs/journal/0032-chat-session-tree.md`,
  `docs/design/README.md`, `docs/plans/README.md`.
- Non-goals: realtime session lifecycle updates, polling, session rename, database/schema changes,
  handoff-reply grouping, a per-session status dot, an `agent` badge.

## Global invariants

- `GET /api/apps/:appKey/sessions` stays flat, keeps every upstream field, and keeps its response
  shape. The tree is built in the browser only.
- `parentID` is the only authoritative parent link; titles are display hints. A missing/blank/
  non-string/self/unknown parent makes the session a root. Cycles are promoted at the first
  unreachable node in upstream order; duplicate ids keep the first occurrence.
- Roots and siblings keep the upstream order; no subtree-activity reordering.
- Expansion is a UI `Set`; roots are collapsed by default; the active session's ancestor chain is
  expanded on boot, on `selectSession()`, and after every `sessions` assignment in
  `refreshSessions()`/`bootSessions()`. Manual collapse of an active ancestor holds only until the
  next refresh or selection. No `sessionStorage`/`localStorage` persistence in this stage.
- `#session-list` is no longer an `aria-live` region; `#chat-announcer`/`announce()` is the only
  live feedback for expand/collapse and counts. List refreshes are not announced.
- The DELETE response stays `200 {deleted:true}`. The route remains human-only and app-scoped. The
  server cleanup is best effort and never turns a successful upstream delete into a `500`.
- The DELETE path uses `listSessionsBounded` with the existing timeout/byte cap; a non-array body,
  timeout, or oversize response falls back to `[sessionId]`.
- No realtime event, polling, or second SSE subscription is added.
- No schema, migration, manifest, settings, or dependency change. Type additions to
  `OpencodeSession` are additive only.
- No test is deleted, skipped, or weakened. The existing exact-call DELETE test is updated, not
  removed.

## Cross-cutting contracts

### Tree helpers

`assets/chat-core.js` (pure browser ESM; no DOM, timers, storage, or Node APIs):

```js
buildSessionTree(sessions) -> {
  nodes: Map<string, session>,          // first occurrence per valid string id
  childrenByParent: Map<string, string[]>,
  roots: string[]                       // upstream order, cycle-safe
}
firstRootId(tree) -> string | null
ancestorIds(tree, id) -> string[]       // root -> immediate parent; [] when not found
collectSubtreeIds(tree, id) -> string[] // id first, then descendants; cycle-safe
```

- Invalid ids (not a non-empty string) are skipped.
- `parentID` must be a non-empty string and must exist in `nodes`; otherwise the node is a root.
- Self-parent is a root. After grouping, walk from roots; promote the first unvisited node in
  upstream order to a root and walk it until every node is visited.
- `childrenByParent` arrays preserve upstream order.

`src/chat/session-tree.ts` (server, pure, type-only `OpencodeSession` import):

```ts
collectSessionSubtreeIDs(sessions: OpencodeSession[], rootID: string): string[]
```

- Same id/parent/cycle rules; always includes `rootID` first even when it is absent from the list.
- Returns `[rootID]` when the list is empty or malformed.
- No DB, locks, or I/O.

### DOM and ARIA contract

```
<div class="session-node" data-session-id="<id>" data-depth="<n>"
     style="--session-depth:<min(n,5)>">
  <div class="session-row">
    <button class="session-chevron" type="button"
            aria-expanded="true|false"
            aria-controls="session-children-<render-key>"
            aria-label="Subagent sessions for <title>">…</button>
    <span class="session-chevron__spacer" aria-hidden="true"></span>  <!-- leaves only -->
    <button class="session-item" …>…</button>
    <button class="session-delete" …>…</button>
  </div>
  <div class="session-children" id="session-children-<render-key>"
       role="group" aria-label="Subagent sessions of <title>">
    …
  </div>
</div>
```

- `render-key` is a per-render incrementing integer, not the raw session id.
- Chevron icon: `chevron-right` when collapsed, `chevron-down` when expanded (both already exist in
  `iconNode`; `assets/chat.js:7822` uses the same pair). A leaf gets the inert spacer.
- During a non-empty search, forced-open ancestors have `aria-expanded="true"`,
  `aria-disabled="true"`, and a click guard; they stay focusable. `aria-label` is state-neutral.
- The chevron is a sibling of the session button; no nested buttons.
- `title` on the session button and title span carries the full label.

### Client state and refresh contract

- `expandedSessions: Set<string>` is render state outside the DOM.
- `sessionsSignatureValue()` includes `parentID`, the sorted expanded ids, and the existing fields
  (ids, labels, prompt counts, draft, runtime, deleting, creating, needle, sessionId).
- A chevron toggle mutates the Set, flips `hidden`/`aria-expanded`/icon directly, and refreshes the
  cached `sessionsSignature` with `sessionsSignatureValue()` so a later render does not treat the
  toggle as a data change. Any out-of-band Set mutation (ancestor expansion, subtree pruning) clears
  the cached signature or calls `renderSessions()`.
- `renderSessions()` captures the focused control before `replaceChildren` and restores it with
  `focus({preventScroll: true})` by `data-session-id` + control class. If the control was a
  now-`aria-disabled` chevron, focus the row's `.session-item`; if the focused row was deleted, focus
  the newly selected row's `.session-item`, else `#session-search`.
- Only the explicit boot/deep-link/selection path calls
  `scrollIntoView({block: "nearest"})` on the active row.
- Waiting counts are computed in one post-order pass over the full tree, excluding the active
  session: every visible node renders its subtree total (a leaf's total is its own count). Never
  render two waiting flags on one row. `#chat-input-needed` keeps its existing global count.
- Search visibility: a node is visible if it matches or any descendant matches. Only visible
  children render; a node with no visible children shows no chevron. Forced-open is derived from
  the needle and never written into the Set.
- Delete uses `collectSubtreeIds()` over the full `sessions` array (not the filtered tree). On
  success it removes the subtree, prunes `expandedSessions`, clears the per-session maps, calls a
  batch `clearSessionPrompts(ids)` (clear all prompts/drafts/errors/busy, then refresh dock/inline/
  queue/composer once), and keeps `skipFlush: true` for the replacement selection/draft.
- After local delete cleanup: if the active id was in the subtree, `selectSession(firstRoot,
  {focus:false, skipFlush:true})` (its trailing `refreshSessions()` reconciles); otherwise
  `renderSessions()` then `refreshSessions()`. If no sessions remain,
  `startDraft({focus:false, skipFlush:true})` then `refreshSessions()`.

### Server DELETE contract (`src/http/chat.ts`)

1. Inside the existing `sessionLocks.run(...)`:
   - `let ids = [sessionId];`
   - `try { const listed = await listSessionsBounded(endpoint); if (Array.isArray(listed)) ids =
     collectSessionSubtreeIDs(listed, sessionId); } catch { ids = [sessionId]; }`
2. `await deleteSession(endpoint, sessionId)` with the existing `isSessionGone` tolerance.
3. For each id: `try { removeLocalSessionRows(deps, found, id); } catch { /* best effort */ }`.
4. For each id: `try { markHandoffsDeleted(deps, id); } catch { /* best effort */ }` where
   `markHandoffsDeleted` is the existing `UPDATE handoffs SET source_session_deleted_at = ...`
   statement factored into a small local helper.
5. Return `json(200, { deleted: true })` unchanged.

- The list call is inside the lock, bounded, and occurs before the upstream delete.
- A failed list, non-array body, timeout, or oversize response falls back to the single id; the
  upstream cascade still deletes descendants.
- The 100-session window is a documented best-effort limit; descendants outside the window may
  leave local rows behind.
- No descendant session locks are taken (avoids lock-order risk); a concurrent child draft PUT may
  recreate a row after cleanup and is accepted as best effort.

### CSS contract

- `--chat-sessions: 17rem` (`src/http/styles.css:135`). This is the largest widening that keeps
  the 1440 feed/scroll ratio inside 0.78-0.82 and the feed/content ratio inside 0.85-0.89; `18rem`
  pushes them to about 84% and 91%.
- Mobile drawer (`@media (max-width: 767px) .chat-shell--workspace .chat-sessions`) gets
  `max-inline-size: calc(100vw - 2rem)`.
- `.session-node`: `display:flex; flex-direction:column; min-inline-size:0;`.
- `.session-row`: `padding-inline-start: calc(var(--session-depth, 0) * 10px);`.
- `.session-children`: `display:flex; flex-direction:column; gap: var(--space-1);
  min-inline-size:0;` and `.session-children[hidden]{display:none;}` (the codebase already uses
  explicit `[hidden]` rules, e.g. `styles.css:3633-3636`).
- `.session-chevron`: 1.5rem (24px) box, inline-flex center, existing `--text-3`/hover/focus tokens,
  no layout shift; `.session-chevron__spacer` is the same 1.5rem with `flex: 0 0 auto`.
- `.session-chevron[aria-disabled="true"] { opacity: .35; cursor: default; }`.
- `.session-item__meta { flex-wrap: wrap; min-inline-size: 0; }` so the parent aggregate cannot
  overflow a 320px drawer.
- No new colors or tokens; no connector lines in this stage.

## Phase 0 - Baseline

Boundaries: no product files.

Work:

1. Run `npm run lint`, `npm run typecheck`, `npm test`, `npm run build`; record the starting counts.
2. Run `npm run check:sensitive`; record that the tree is clean.
3. Confirm the current `/sessions` fixture and DELETE exact-call test (`test/chat-page.test.ts:880`)
   so Phase 3 updates rather than removes them.

Acceptance: baseline gates are green; no product file changed.

## Phase 1 - Pure tree helpers and tests

Boundaries: `assets/chat-core.js`, `src/chat/session-tree.ts`, `test/chat-core.test.ts`,
`test/session-tree.test.ts`. No DOM render, CSS, routes, or type changes.

Work:

1. Add `buildSessionTree`, `firstRootId`, `ancestorIds`, and `collectSubtreeIds` to
   `assets/chat-core.js` with the cross-cutting contract above. JSDoc the session shape
   (`id: string`, `parentID?: string`, `title?: string`, `time?: {created?, updated?}`).
2. Add `src/chat/session-tree.ts` exporting `collectSessionSubtreeIDs`. Import `OpencodeSession`
   with `import type` so the module stays runtime-dependency-free.
3. Add `test/chat-core.test.ts` cases:
   - flat list, stable order;
   - three-level chain and sibling order;
   - missing parent -> root;
   - empty/blank/non-string parentID -> root;
   - self-parent -> root;
   - two-node and three-node cycle -> all nodes reachable, first promoted, no duplication;
   - duplicate id -> first occurrence, root/child grouping stable;
   - `firstRootId` with roots and with a cycle-only list;
   - `ancestorIds` root/child/deep/unknown;
   - `collectSubtreeIds` leaf, deep chain, cycle, missing id.
4. Add `test/session-tree.test.ts` with the same structural cases for
   `collectSessionSubtreeIDs`, plus an empty list and a root absent from the list.
5. Run `npm run lint`, `npm run typecheck`, `npm test`.

Acceptance: helper tests pass; no product behavior changes yet; helper exports are importable by
both chat.js and Vitest.

Risks: duplicate/cycle handling must not drop nodes; keep both helpers' case tables in parity.

## Phase 2 - Sessions rail rendering, expansion, search, delete, CSS

Boundaries: `assets/chat.js`, `src/http/chat.ts` (only remove `aria-live` from `#session-list`),
`src/http/styles.css`. No server DELETE cleanup yet.

Work:

1. `src/http/chat.ts`: remove `aria-live="polite"` from `#session-list` (line 383); keep
   `#chat-announcer` (line 590). Do not change the skeleton/empty markup.
2. `assets/chat.js` state:
   - add `expandedSessions = new Set()` and a render-local `sessionTree` built from `sessions`;
   - add `activeChainExpanded()`/`expandActiveAncestors()` using `buildSessionTree`/`ancestorIds`;
   - call it after `sessions = ...` in `bootSessions()`/`refreshSessions()` and at the start of
     `selectSession()`.
3. `sessionsSignatureValue()`: include `parentID` and sorted expanded ids. Keep the existing
   needle/sessionId and data fields.
4. `renderSessions()`:
   - build the tree once; compute the visible set (match + ancestors) and forced-open state;
   - early-return on the signature; capture focus before `replaceChildren`;
   - recursively render `.session-node`/`.session-row`/`.session-children` per the DOM contract;
   - show the chevron only when there are visible children; use the leaf spacer otherwise;
   - set `title` to `sessionLabel(session)` on the row button and title span;
   - render one waiting total per node (post-order subtree total, excluding `sessionId`);
   - restore focus and, only on the reveal path, `scrollIntoView` the active row;
   - keep the existing empty/error/search-miss messages.
5. Chevron handler:
   - add/remove the id in `expandedSessions`, swap `hidden`, `aria-expanded`, and the
     `chevron-right`/`chevron-down` icon, refresh `sessionsSignature`; `announce("Subagent sessions
     expanded.")` / `collapsed.` Do not call `renderSessions()` on a plain toggle;
   - ignore the click when `aria-disabled="true"` (search forced-open).
6. Search handler (`#session-search`): re-render through the signature (needle is included); keep
   the current `No sessions match this filter.` message.
7. First-root selection:
   - `bootSessions()`: requested `?session=` wins; else current valid id; else `firstRootId(tree)`;
   - `refreshSessions()`: when `sessionId === null` or missing, use `firstRootId(tree)`; replace
     the `sessions[0]` fallbacks in both functions;
   - `removeSession()`: compute the full tree and `collectSubtreeIds()`, confirm with the child
     count ("at least N"), remove the subtree, prune `expandedSessions`, clear the per-session maps,
     call the batch `clearSessionPrompts(ids)`, and use the replacement selection described in the
     cross-cutting contract.
8. `clearSessionPrompts`: accept `string | string[]`; collect ids once, delete prompts/drafts/
   errors/busy for all, then run the dock/inline/queue/composer refresh once.
9. CSS per the cross-cutting contract. Rebuild with `npm run build:css`.
10. Run `npm run lint`, `npm run typecheck`, `npm test`. Manual fixture check: expand/collapse,
    deep link to a grandchild, search ancestors, parent waiting, delete parent, focus after a
    refresh.

Acceptance: tree renders and survives refreshes; the active branch is visible; search, flags,
delete, and selection work; no realtime behavior is added; desktop 1440 and mobile drawer 390/320
look usable.

Risks: signature/toggle cache, focus loss, forced-open + active collapse, 17rem rail layout. Fix in
this phase before the server work.

## Phase 3 - Server DELETE subtree cleanup and tests

Boundaries: `src/http/chat.ts`, `src/chat/session-tree.ts` (already added), tests. No schema or API
shape change.

Work:

1. `src/http/chat.ts`: import `listSessionsBounded` and `collectSessionSubtreeIDs`.
2. Add a local `markHandoffsDeleted(deps, sessionId)` helper containing the existing UPDATE
   statement; the current single call becomes one use.
3. In the DELETE branch (inside `sessionLocks.run`), implement the cross-cutting server contract:
   bounded list -> `Array.isArray` check -> `collectSessionSubtreeIDs`; fallback `[sessionId]` on
   any failure; upstream delete with `isSessionGone` tolerance; per-id `removeLocalSessionRows` and
   per-id handoff update in independent try/catch blocks; return the existing 200 body.
4. Tests (`test/chat-page.test.ts`):
   - update the exact-call test at line 880 to expect `GET /session` then
     `DELETE /session/ses_1` (the fake body `"true"` exercises the non-array fallback);
   - add an R13 test: set `f.deps.agentsHome` to a temp directory; seed parent+child drafts,
     attachments, deliveries, pending sends, `session_state`, and session folders; seed a handoff
     row with the parent as source (use the `test/deletion.test.ts` pattern); upstream
     `GET /session` returns parent+child+unrelated; assert parent and child rows/folders are gone,
     the unrelated session is untouched, and `source_session_deleted_at` is set;
   - add a non-array list case proving the DELETE still succeeds and only the requested id is
     cleaned;
   - add a listing-failure case proving the DELETE still succeeds after the fallback.
5. Run `npm run lint`, `npm run typecheck`, `npm test`.

Acceptance: R13 is covered; the DELETE response shape and human-only guard are unchanged; a
successful upstream delete is never converted to a 500 by cleanup; existing chat tests pass after
the call-list update.

Risks: lock hold time, non-array/throwing list, per-id cleanup isolation, folder containment. Do not
take descendant locks.

## Phase 4 - Type and documentation updates

Boundaries: `src/opencode/client.ts`, `docs/current-state.md`. No behavior change.

Work:

1. `OpencodeSession`: add `parentID?: string` and the bounded optional `time?: { created?:
   number; updated?: number }`. Keep the index signature. Do not add `agent`.
2. `docs/current-state.md` in the "Agents and chat" section: note the sessions rail groups
   `parentID` children under their parent, is 17rem wide, expands the active branch, aggregates
   child waiting counts, cleans the whole subtree on delete, and still relies on the existing
   refresh triggers (no lifecycle SSE yet).
3. `docs/design/README.md`: keep the approved status; `docs/plans/README.md`: add the plan entry.
4. Run `npm run typecheck`.

Acceptance: typecheck green; docs match the shipped behavior; no stale "flat list" claim.

## Phase 5 - Browser QA scenario

Boundaries: `docs/design/chat-qa.mjs` (and any fixture helpers in that file). No product code.

Work:

1. Add a deterministic `sessionTreeFixture()` with: parent, two children, one grandchild, one leaf,
   one orphan whose `parentID` is absent from the list, and an unrelated root.
2. Extend the route mock:
   - `DELETE /api/apps/:app/sessions/:id` returns `200 {deleted:true}` and removes the id plus its
     loaded descendants from the fixture before the next `GET /sessions`;
   - unhandled routes keep the existing `json(route, {})` fallback.
3. Add a `CHAT_QA_ONLY` (comma-separated scenario names) filter to the runner so the new
   scenario can run alone; with the variable unset, every scenario runs exactly as today. Do not
   change existing scenario assertions.
4. Add `scenarioSessionTree(browser, target)` and register it:
   - accept `window.confirm` with `page.on("dialog", d => d.accept())`;
   - assert the parent has a chevron, children are hidden initially, expand/collapse works, and the
     icon/`aria-expanded` swap;
   - assert the grandchild nests at depth 2 and the orphan renders as a root;
   - navigate with `?session=<grandchild>` and assert ancestors expand and the active row is
     visible;
   - with no `?session=`, assert the active session is a root (first-root selection);
   - search a child title, assert ancestors are visible/forced open (`aria-disabled`), siblings
     hidden, then clear and assert the saved expansion returns;
   - emit a `question.asked` for a hidden child and assert the collapsed parent shows the aggregate
     wait flag while the child is collapsed;
   - delete the parent, accept the dialog, assert the subtree disappears, the first root is
     selected, and the post-delete refresh does not resurrect the rows;
   - assert `aria-controls` targets exist, keyboard focus survives a refresh, and capture 320, 390,
     and 1440 widths (dark/light as the harness supports).
5. Run `npm run build` first (the harness self-starts `dist/index.js`), then
   `CHAT_QA_ONLY=session-tree node docs/design/chat-qa.mjs`; record the report path and failures.

Acceptance: the new scenario passes with no console/page errors; screenshots/report are written
under the harness's artifact directory. Existing scenarios are not modified. Baseline note: the
`main` scenario currently fails its queue-strip assertion on clean HEAD (`queue strip shows 2 rows
(1)`), reproduced independently in a detached HEAD worktree; this stage does not fix or change that
unrelated baseline failure.

Risks: the fake event source shape for `question.asked`, dialog handling, and the DELETE fixture
ordering. If the harness cannot model a case without product changes, record the limitation and
cover it in the manual check instead.

## Phase 6 - Verification, record, and handoff

Boundaries: verification and docs only.

Work:

1. Run the full gate:
   `npm run lint && npm run typecheck && env -u HANSE_CREDENTIALS_DIR npm test && npm run build && npm run check:sensitive`.
   Plain `npm test` in this agent container has a pre-existing `HANSE_CREDENTIALS_DIR`-sensitive
   git-service assertion; the unset run is the code gate.
2. Run `CHAT_QA_ONLY=session-tree node docs/design/chat-qa.mjs` after the final code change. The
   full harness has a pre-existing `main` queue-strip failure reproduced on clean HEAD; existing
   scenarios are unchanged.
3. Manual disposable-app check if one is available (no production data): spawn a subagent, verify
   the child is grouped after the next refresh, verify an orphan renders as a root, and verify a
   child draft/attachment is removed with the parent. If none is available, record that the
   deterministic QA and the R13 route test cover the tree/cleanup, and that the pinned upstream
   cascade citation remains source-level.
4. Write `docs/journal/0032-chat-session-tree.md`: context, what shipped, decisions and why,
   artifacts, verification evidence, accepted limits (100-session window, no realtime, manual
   collapse duration, concurrent draft race), and the next realtime stage.
5. Update `docs/journal/README.md`, `docs/design/README.md`, and `docs/plans/README.md` statuses.
6. Report "ready to commit"; do not commit until the owner explicitly asks.

Acceptance: every gate is green; the journal and indexes are written; the final report names the
verification evidence and the deferred realtime work.

## Verification summary

| Check | Command | Evidence |
| --- | --- | --- |
| Lint | `npm run lint` | exit 0 |
| Types | `npm run typecheck` | exit 0 |
| Unit/integration | `env -u HANSE_CREDENTIALS_DIR npm test` | 127 files, 2235 tests pass, including new helper/R13 tests |
| Build | `npm run build` | `dist/` and `assets/app.css` produced |
| Sensitive | `npm run check:sensitive` | exit 0 |
| Browser | `CHAT_QA_ONLY=session-tree node docs/design/chat-qa.mjs` | PASS: 1 scenario, 68 assertions, 8 screenshots, zero console/page errors |
| Baseline | `node docs/design/chat-qa.mjs` | pre-existing `main` queue-strip failure (2 vs 1) reproduced on clean HEAD; existing scenarios unchanged |
| Manual | disposable app | not run in this session (no disposable app/token); deterministic QA + R13 route test cover the tree and cleanup |

## Open questions

None. Owner decisions are recorded in `docs/open-questions.md` stage `0027-chat-session-tree`.
