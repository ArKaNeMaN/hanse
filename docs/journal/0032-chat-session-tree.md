# Journal 0032 - Chat session tree

Status: **implemented and verified** (2026-10-25); design review PASS (`oracle`, round 3); plan
review PASS (`momus`); stage committed.
Design: [`docs/design/chat-session-tree.md`](../design/chat-session-tree.md).
Plan: [`docs/plans/0027-chat-session-tree.md`](../plans/0027-chat-session-tree.md).
Owner decisions: [`docs/open-questions.md`](../open-questions.md), stage `0027-chat-session-tree`.

## Context

The chat sessions rail rendered every `opencode` session as a flat row. Subagent sessions already
carry `parentID` and were returned by the unchanged flat `GET /api/apps/:appKey/sessions`, but the
rail ignored the link, so a parent and its subagents were distinguishable only by a truncated title.
The stage was scoped to the tree only; realtime session lifecycle updates were explicitly deferred.

## What shipped

- **Pure tree helpers** in `assets/chat-core.js`: `buildSessionTree`, `firstRootId`, `ancestorIds`,
  and `collectSubtreeIds`. They preserve upstream root/sibling order, treat missing/blank/non-string/
  self/unknown parents as roots, promote the first unreachable node of a cycle, and keep the first
  occurrence of a duplicate id.
- **Server subtree helper** in `src/chat/session-tree.ts`: `collectSessionSubtreeIDs`, the same
  parent/cycle rules, root-first and cycle-safe, with no DB or I/O dependency.
- **Chat rail tree** in `assets/chat.js`:
  - disclosure rows with a separate chevron sibling, a leaf spacer, `aria-expanded`/`aria-controls`,
    a state-neutral accessible name, and `aria-disabled` click guards while search forces a branch
    open;
  - five visual levels at 10px indentation, clamped but not truncated in data;
  - `expandedSessions` render state, active-ancestor expansion on boot/refresh/selection, a default
    selection of the first root, and deep-link expansion;
  - search shows matches plus their ancestor chain; forced-open state is derived from the needle and
    never written into the Set;
  - one aggregate waiting count per node over the full subtree, excluding the active session, so a
    hidden child question or permission remains visible on a collapsed parent;
  - subtree delete from the full session array, `clearSessionPrompts(ids)` batch cleanup, `skipFlush`
    selection, and a post-delete `refreshSessions()` reconcile;
  - focus restoration with `preventScroll` and active-row `scrollIntoView` only on explicit reveal
    paths;
  - the `#session-list` `aria-live` region was removed; `#chat-announcer` remains the live feedback.
- **CSS** in `src/http/styles.css`: tree node/row/children/chevron styles, explicit
  `.session-children[hidden]`, 17rem rail (the largest widening that preserves both 1440 feed
  budgets), mobile drawer `max-inline-size`, and wrapping session meta.
- **Server DELETE cleanup** in `src/http/chat.ts`: bounded `listSessionsBounded` before the delete,
  `Array.isArray`/failure fallback to the requested id, `collectSessionSubtreeIDs`, per-id
  `removeLocalSessionRows` and handoff bookkeeping isolated in try/catch blocks, unchanged
  `200 {deleted:true}`.
- **Type/docs**: additive `OpencodeSession.parentID`/`time` fields; `docs/current-state.md` records
  the 17rem grouped rail, aggregate waiting, subtree delete, and the deferred realtime behavior.
- **QA**: a deterministic `session-tree` scenario in `docs/design/chat-qa.mjs` and an opt-in
  `CHAT_QA_ONLY` scenario filter. The scenario covers initial collapse, expand/collapse, depth 2,
  orphan/leaf roots, grandchild deep link, ancestor search, forced-open ARIA, clearing search,
  aggregate waiting on a collapsed parent, 1440/390/320 captures, focus restoration after a refresh,
  and parent subtree delete with no post-delete resurrection.

## Decisions

- **17rem, not 18rem.** The owner chose a wider rail plus a full-title tooltip. An 18rem rail pushed
  the 1440 feed/scroll ratio to 84% and the feed/content ratio to 91%, outside the existing chat QA
  budgets (0.78-0.82 / 0.85-0.89). 17rem is the largest widening that keeps both budgets and still
  adds title room; the tooltip covers the remaining truncation.
- **Keep the API flat.** Grouping is web-rail-only; the IDE extension's `sessions[0]` latest-session
  behavior is unchanged.
- **Upstream order, collapsed default, no persistence.** Roots and siblings stay in upstream order.
  The active ancestor chain auto-expands; manual collapse of an active ancestor holds only until the
  next refresh/selection.
- **Matches plus ancestors for search.** Unrelated descendants stay hidden; forced-open ancestors
  cannot be collapsed while the filter is active.
- **Subtree delete is mirrored only locally.** The client removes the loaded subtree and cleans the
  prompts/maps it owns; the server independently collects and cleans the loaded upstream subtree.
  Both are best effort under the 100-session window.

## Verification

- `npm run lint` - pass (312 files, no fixes).
- `npm run typecheck` - pass.
- `env -u HANSE_CREDENTIALS_DIR npm test` - **127 files, 2235 tests passed**, including the new
  helper tests (158 chat-core, 11 session-tree) and the R13 DELETE route tests (parent+child drafts,
  attachments, deliveries, pending sends, `session_state`, folders, handoff; unrelated session
  preserved; non-array and listing-failure fallbacks).
  - Plain `npm test` in this agent container fails one pre-existing `git-service` assertion because
    `HANSE_CREDENTIALS_DIR` is set and the test expects the credential-less `ssh` wrapper. Unsetting
    that ambient variable proves the code; the failure is environmental, not a stage regression.
- `npm run build` - pass (`dist/` and `assets/app.css`).
- `npm run check:sensitive` - pass.
- `CHAT_QA_ONLY=session-tree node docs/design/chat-qa.mjs` - **PASS: 1 scenario, 68 assertions,
  8 screenshots, zero console/page errors**. Report copy:
  `docs/design/artifacts/chat/session-tree-report.json`.
- Visual inspection of the eight captures: nesting/chevrons, active highlight, search ancestors,
  collapsed-parent wait flag, 390/320 drawer layouts, and the after-delete tree all render without
  overflow or clipping; titles fit at the tested widths. The waiting capture intentionally hides the
  active grandchild under a collapsed parent (thread header still names it); see accepted limits.
- Baseline note: the full `node docs/design/chat-qa.mjs` currently stops at the unrelated `main`
  queue-strip assertion (`queue strip shows 2 rows (1)`). The same failure was reproduced on a clean
  detached HEAD worktree; existing scenarios were not modified.
- The manual disposable-app cascade check was not run in this session (no disposable app/token). The
  pinned opencode 1.19.3 source cites the recursive session delete; the server route test covers the
  local cleanup contract.

## Accepted limits and follow-ups

- The upstream session list is capped at 100. A descendant outside the window may leave local rows
  after a parent delete; the refresh surfaces surviving children as orphan roots.
- Realtime is not implemented: child sessions appear on the existing refresh triggers (boot, focus,
  visibility, selection, send, idle/reconnect). The next stage is typed
  `session.created/updated/deleted` (or `sessions.changed`) events plus a debounced
  `refreshSessions()`; child status dots can reuse `sessionRuntime`.
- A collapsed ancestor of the active session has no active-descendant cue in the rail; the thread
  header still names the active session. A subtle parent dot/border is future polish, not a bug in
  this stage. The QA fixture's `ses_child1`/`ses_child2` share the first eight displayed characters;
  that duplicate label is a fixture artifact, not a product id collision.
- A concurrent child draft PUT can recreate a row after subtree cleanup because descendant locks are
  not taken; accepted best-effort to avoid lock-order risk.
- Child status dots, an `agent` badge, expansion persistence, and subtree-activity reordering remain
  future polish.
- The full chat QA harness still has the pre-existing `main` queue-strip failure noted above.

## Artifacts

- Design: `docs/design/chat-session-tree.md`; index `docs/design/README.md`.
- Plan: `docs/plans/0027-chat-session-tree.md`; index `docs/plans/README.md`.
- QA: `docs/design/chat-qa.mjs`; report copy `docs/design/artifacts/chat/session-tree-report.json`;
  screenshots `docs/design/artifacts/chat/session-tree-*.png`.
- State: `docs/current-state.md`.
- This record; index `docs/journal/README.md`.
