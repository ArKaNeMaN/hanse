# Design - Chat session tree

Status: **implemented and verified** (2026-10-25); design review rounds 1-2 **CHANGES
REQUESTED**, findings folded; round 3 **PASS**. Plan: `docs/plans/0027-chat-session-tree.md` (plan
review PASS); journal: `docs/journal/0032-chat-session-tree.md`.

Scope: the chat sessions rail (`assets/chat.js`, `assets/chat-core.js`, `src/http/styles.css`), the
sessions DELETE path and session-list accessibility markup (`src/http/chat.ts`), a small server-side
subtree helper (`src/chat/session-tree.ts`), the `OpencodeSession` type (`src/opencode/client.ts`),
tests, and the session-tree documentation. Out of scope: realtime session lifecycle events, polling,
session rename, database/schema changes, and handoff-reply grouping.

## 1. Problem

The sessions rail is flat. `opencode` subagent sessions contain a `parentID`, but the rail renders
every session as an independent row (`assets/chat.js:3448-3528`). Operators therefore see a long
list in which a parent and its subagents are only distinguishable by a title, and the title is
truncated by the narrow rail (`src/http/styles.css:3511-3520`). A growing number of subagent
sessions makes the rail hard to scan and makes it easy to open the wrong session.

The data needed for a tree is already present:

- `GET /api/apps/:appKey/sessions` proxies `opencode` `GET /session` and returns each session object
  as-is (`src/http/chat.ts:2400-2418`), so `parentID` reaches the browser.
- The context monitor already reads `session.parentID` from the same list
  (`src/opencode/context.ts:528-539`) and uses it to exclude child sessions from auto-compaction
  (`context.ts:1423`). The field is authoritative, not a title convention.
- `opencode` is the source of truth for session metadata and its session list is capped at 100
  sessions (`opencode` v1.19.3, pinned in `Dockerfile:6`; upstream
  `packages/opencode/src/session/session.ts:995-1001`). Roots are ordered by `time_updated desc`;
  grouping preserves that order for roots and siblings.
- Hanse still stores session-scoped chat state: `session_state`, drafts, attachments, deliveries,
  and pending sends are deleted by `deleteSessionChatRows` (`src/chat/state.ts:528-551`). The DELETE
  route currently clears only the requested id (`src/http/chat.ts:2424-2447`), so a cascading
  upstream parent delete can leave child drafts/attachments/pending rows behind once children are
  selectable. This design fixes that cleanup.

Realtime is deliberately deferred to a later stage. The existing app-level SSE already receives all
sessions' events, but session lifecycle events are projected as `session.activity` with cause
`unknown` (`src/opencode/events.ts:1478-1479`, `1937-1940`) and the client drops them for non-current
sessions (`assets/chat.js:7225-7231`). That gap is recorded here but not changed in this stage.

## 2. Requirements

| ID | Requirement |
| --- | --- |
| R1 | A session with child sessions gets an expand/collapse control in the sessions rail; a leaf row keeps the current shape. |
| R2 | Expanded children render directly below their parent, visually indented; nesting is supported to at least five levels including the root. |
| R3 | Expansion state is UI state and survives list refreshes; a refresh must not silently collapse an expanded branch. |
| R4 | The active session's ancestor chain is expanded automatically, including on a `?session=<child>` deep link. |
| R5 | A child whose parent is absent from the loaded list (deleted, outside the 100-session cap, or otherwise missing) remains reachable as a root. |
| R6 | Malformed links (self-parent, cycle, duplicate id) never hang the renderer or hide sessions. |
| R7 | The default selection is a root session, never a child picked only because it is first in upstream order. |
| R8 | Search, the active highlight, draft/waiting flags, delete, and session selection keep working with the tree. |
| R9 | Deleting a session removes its whole subtree from the client and keeps the active selection valid. |
| R10 | The API stays flat and backward compatible; the IDE extension's "latest session" behavior is unchanged. |
| R11 | Realtime behaviour is unchanged in this stage: child sessions appear on the existing refresh triggers (boot, focus, visibility, selection, send, idle/reconnect). |
| R12 | No schema, migration, manifest, settings, dependency, or API-shape change. |
| R13 | A parent delete also clears Hanse session-scoped chat state (drafts, attachments, deliveries, pending sends, `session_state`, session folder) for its descendants, best effort under the upstream 100-session window. |

## 3. Current facts

- The chat page is server-rendered markup plus a native ESM client. The sessions rail shell is
  `src/http/chat.ts:370-395`; the list is `#session-list` with `aria-live="polite"` (line 383). A
  dedicated live region already exists at `#chat-announcer` (line 590), and `announce()` is
  `assets/chat.js:1540`.
- `renderSessions()` filters only by the search needle, then renders every session in array order:
  a row wrapper, a `<button class="session-item">` (title + id/time/flags), and a sibling delete
  button (`assets/chat.js:3448-3528`). The list is replaced with `replaceChildren` (line 3528).
- The re-render guard is `sessionsSignatureValue()` (`assets/chat.js:2046-2070`). It includes ids,
  labels, prompt counts, draft state, runtime, deleting, and creating; it does **not** include
  `parentID` or expansion state. `renderSessions()` returns early when the signature is unchanged
  (`assets/chat.js:3450-3452`).
- `bootSessions()` and `refreshSessions()` fall back to `sessions[0]` when no session is selected or
  the current one disappears (`assets/chat.js:10154-10181`, `10550-10576`). With child sessions in
  the array this can select a child.
- Delete currently confirms one label, removes only the clicked id from the local array, and does
  not refetch when the deleted session was not active (`assets/chat.js:10505-10547`). The server
  DELETE route likewise clears local rows only for the requested id
  (`src/http/chat.ts:2424-2447`); `removeLocalSessionRows` covers `deleteSessionChatRows` and the
  session folder (`src/http/chat.ts:861-866`, `src/chat/state.ts:528-551`).
- Upstream `opencode` `Session.remove` deletes child sessions recursively (`opencode` v1.19.3,
  `packages/opencode/src/session/session.ts:606-626`). The client therefore mirrors the subtree.
- Prompts are keyed by request (`assets/chat.js:1502-1508`). `clearSessionPrompts(id)`
  (`assets/chat.js:6497-6512`) already clears `prompts`, `promptDrafts`, `promptErrors`, and
  `promptBusy` and refreshes the dock/inline/queue/composer on error/abort paths
  (`assets/chat.js:3930`, `6574`, `6594`, `7113`). A deleted subagent with an open question or
  permission will never receive its reply event; the subtree delete must reuse this cleanup for
  every collected id.
- `listSessionsBounded` (`src/opencode/client.ts:227-241`) is the timeout/byte-capped sibling of
  `listSessions`; the DELETE cleanup uses the bounded variant.
- The rail is `16rem` wide (`src/http/styles.css:135`); the mobile drawer uses the same variable
  (`styles.css:6685`). The title is single-line with ellipsis (`styles.css:3511-3520`).
- The IDE extension consumes the same flat endpoint and treats `sessions[0]` as the latest session
  (`extensions/hanse-agent/extension.js:656-674`). It must not be affected by a server-side reorder
  or filter.
- `OpencodeSession` is `{ id; title?; [key: string]: unknown }` (`src/opencode/client.ts:8-12`), so
  `parentID` is currently untyped.
- Child statuses already arrive over SSE and are cached per session in `sessionRuntime`
  (`assets/chat.js:6779-6801`), but the rail does not render them. This stage does not add status
  rendering.
- The app-level SSE is one upstream `/event` per browser (`src/http/prompts.ts:655-793`); no new
  stream is needed because no realtime work is included.

## 4. Decisions

### D1 - Group on the client; keep the API flat (R10, R12)

Build the tree in the browser from the existing flat list. Do not nest or filter the response on the
server. The `parentID` is already present, the list is bounded, and the IDE extension shares the
endpoint. This also avoids a schema or API-shape change. The server gains only the DELETE-time
subtree cleanup in D9; it does not build or return a tree.

### D2 - `parentID` is the only authoritative parent link (R5, R6)

Use `session.parentID` for grouping. Titles (including opencode's `Child session`/`@agent subagent`
conventions) are display hints only. Build a map of id to session and a map of parent id to child
ids, preserving the upstream order for roots and siblings.

- A missing, empty, non-string, self-referential, or unknown parent makes the session a root.
- After the initial grouping, walk from the roots and mark reachable nodes. Any node not reached is
  part of a cycle; promote its first occurrence in upstream order to a root and walk it. Never
  recurse without a visited set.
- Duplicate ids: keep the first occurrence and ignore later duplicates.
- The upstream list is capped at 100; R5's orphan rule is the expected behaviour for a child whose
  parent falls outside that window.

### D3 - Disclosure rows, not an ARIA tree (R1, R2, R12)

Each node renders as:

```
<div class="session-node" data-depth="N" style="--session-depth:N">
  <div class="session-row">
    <button class="session-chevron" type="button"
            aria-expanded="true|false"
            aria-controls="session-children-<render-key>"
            aria-label="Subagent sessions for <title>">…</button>
    <button class="session-item">… existing row content …</button>
    <button class="session-delete">…</button>
  </div>
  <div class="session-children" id="session-children-<render-key>"
       role="group" aria-label="Subagent sessions of <title>">
    … child nodes …
  </div>
</div>
```

- The chevron is a sibling of the session button; a button is never nested inside another button.
- A leaf gets a same-width spacer so titles stay aligned.
- The chevron toggles the branch; the session button selects the session; delete stays a sibling.
- `aria-expanded` and `aria-controls` describe the branch. The accessible name is state-neutral
  ("Subagent sessions for <title>"); `aria-expanded` conveys open/closed. During search,
  forced-open chevrons use `aria-disabled="true"` plus a click guard instead of the `disabled`
  property, so they remain focusable and announce their state.
- Use a render-local key (for example a monotonically assigned index) for DOM ids rather than the
  raw session id, so unusual id characters cannot produce a broken `aria-controls` value.
- Do not use `role="tree"`/`treeitem` without roving-tabindex and arrow-key behaviour; the
  disclosure pattern is the honest contract for this stage.
- Depth is visual only. The renderer clamps the indent at five visual levels (10px per level) but
  continues to nest deeper data under the fifth level rather than dropping it.

### D4 - Expansion state lives outside the DOM and is part of the render signature (R3, R4)

Keep an `expandedSessions` `Set` keyed by session id. Render the full visible subtree and set
`hidden` on each collapsed branch's children container; toggling flips `hidden` and `aria-expanded`
without a full re-render. Any later `renderSessions()` reads the Set and reapplies the state.

- Add `parentID` and the sorted expanded ids to `sessionsSignatureValue()`. A chevron toggle
  mutates the Set, flips the DOM directly, and refreshes the cached `sessionsSignature` with
  `sessionsSignatureValue()` so a later render does not treat the toggle as a data change. Any
  out-of-band Set mutation (`selectSession` ancestor expansion, subtree-delete pruning) calls
  `renderSessions()` or clears the cached signature.
- Default: roots and children collapsed.
- On boot, on every `selectSession(id)`, and after every `sessions = ...` assignment in
  `refreshSessions()`/`bootSessions()`, add every ancestor of the active id to the Set
  (cycle-safe) so the active branch stays visible, including a `?session=<child>` deep link and a
  jump from the queue. A 100-session window shift that makes the parent appear must not re-nest the
  active child under a collapsed parent.
- Manual collapse of an ancestor of the active session is allowed; the thread stays selected and
  the chain is re-expanded by the next refresh or selection. The manual collapse therefore holds
  only until that next refresh/selection. This is an accepted state.
- This stage does not persist expansion across page reloads. A reload reopens only the active
  branch. Persistence is a future decision.
- After every `replaceChildren`, capture the focused control before the replace and restore focus
  with `focus({preventScroll: true})` to the remembered `data-session-id` plus control
  (`session-chevron`, `session-item`, or `session-delete`) when it still exists. If the control was
  a now-`aria-disabled` chevron, focus the row's `.session-item` instead. If the focused row was
  deleted, focus the newly selected row's `.session-item`, else `#session-search`. Only the explicit
  boot/deep-link/selection `scrollIntoView({block: "nearest"})` call scrolls the rail.

### D5 - Default selection is the first root (R7)

Add a helper that returns the first root id from the tree (or the first session if the tree is
empty due to malformed data). `bootSessions()` and `refreshSessions()` use it instead of
`sessions[0]`. A requested `?session=<id>` still wins, even when it is a child; the ancestor
expansion in D4 makes it visible and `scrollIntoView` brings it into view. When the active session
disappears, select the first root, or start a draft when no sessions remain.

### D6 - Keep upstream order; do not reorder by subtree activity (R8)

In this stage, roots and siblings keep the upstream order (`time_updated desc` per the pinned
opencode version). Do not compute a subtree maximum. Reordering roots by descendant activity changes
the rail's order for reasons unrelated to the visible row and can make rows jump; it is a separate
UX decision.

### D7 - Search shows matches plus their ancestors (R8)

When the search needle is non-empty:

- A node is visible if it matches, or if any descendant matches.
- Ancestors of a match are visible and forced open, regardless of the Set.
- A matched parent whose children do not match shows no chevron (there are no visible children).
- Forced-open ancestor chevrons use `aria-disabled="true"` and a click guard while the needle is
  non-empty, so a toggle cannot hide a match; they stay focusable and their `aria-expanded` stays
  `true`.
- When the needle is cleared, the Set's saved expansion state applies again; forced-open state is
  derived from the needle and never written into the Set.
- If no node is visible, show the existing `No sessions match this filter.` message.

### D8 - Aggregate waiting counts on parents (R8)

Each leaf shows its own waiting count from `promptCountForSession(id)`. A parent shows one aggregate
count over its whole subtree (including its own), excluding the active session. The aggregate is
visible while collapsed, so a question or permission raised by a hidden subagent is not silently
lost. Do not render two waiting flags on the same row. The top-bar `input needed` count remains
unchanged and continues to count every session.

Status dots for running/idle child sessions are **not** added here; `sessionRuntime` already has the
data but realtime/status rendering is stage 2.

### D9 - Delete mirrors the upstream subtree, in the client and on the server (R9, R13)

Client (`removeSession(id)`):

- Build `buildSessionTree(sessions)` from the **full** array, independent of the search needle and
  `expandedSessions`, and collect `subtreeIds` (the target plus every descendant) with a visited
  set.
- The confirmation for a parent says that its subagent sessions will also be deleted. The count is
  the loaded subtree ("at least N"): descendants outside the upstream 100-session window are still
  deleted by the cascade.
- On success, filter every collected id out of `sessions`; remove every collected id from
  `expandedSessions`; clear the per-session local maps (`sessionRuntime`, acceptance, context,
  failed, deleting, queue promotion/abort/draft/context timers) for every collected id; call
  `clearSessionPrompts(id)` (or a batch variant of it) for every collected id so `prompts`,
  `promptDrafts`, `promptErrors`, and `promptBusy` are all cleared and the dock/inline/queue/composer
  refresh once.
- If the active session was in the subtree, select the first root from the remaining tree with
  `skipFlush: true`, or start a draft when none remain; otherwise re-render. Keep `skipFlush: true`
  so `flushDraftForSwitch` never PUTs a draft for the deleted id.
- After the local cleanup and selection, call `refreshSessions()` to reconcile. Upstream `remove`
  swallows child errors; a refresh surfaces any child that survived as an orphan root instead of
  leaving a stale hidden row. It also keeps the 100-session window honest.

Server (`DELETE /api/apps/:app/sessions/:sid` in `src/http/chat.ts`):

- Before deleting upstream, call `listSessionsBounded` (not the unbounded `listSessions`) and
  collect the requested id plus its descendants with a small server helper
  (`src/chat/session-tree.ts`, `collectSessionSubtreeIDs`). Treat a non-array body, timeout, or
  oversize response as a failure and fall back to `[sessionId]`; the upstream delete still cascades.
- After the upstream delete, call the existing `removeLocalSessionRows` for every collected id and
  run the existing handoff bookkeeping for every collected id. Wrap each id's cleanup in its own
  try/catch so one SQL failure cannot turn a successful upstream delete into a `500` or roll back
  the other ids' cleanup; a failed cleanup is best effort. This clears child drafts, attachments,
  deliveries, pending sends, `session_state`, and session folders.
- The cleanup is best effort under the upstream 100-session window; a descendant outside the window
  may still leave local rows. A concurrent child draft PUT can recreate a row after cleanup because
  the child lock is not taken; this is accepted best-effort (do not take descendant locks, to avoid
  lock-order risk).

### D10 - Widen the rail and add a full-title tooltip (R1, R8)

Raise `--chat-sessions` from `16rem` to `17rem` (`src/http/styles.css:135`). On the mobile drawer,
add `max-inline-size: calc(100vw - 2rem)` so the wider rail never covers the whole phone viewport
(`styles.css:6685`). Add a `title` attribute with the full session label to the session button (and
title span), so a truncated title is readable on hover. Add `flex-wrap: wrap` and
`min-inline-size: 0` to `.session-item__meta` (`styles.css:3522-3528`) so a parent waiting
aggregate cannot overflow the 320px drawer. Indentation is 10px per visual level, clamped at five
levels. A compact `agent` badge is **not** added; the owner chose the wider rail plus tooltip.
`17rem` is the largest widening that keeps both 1440 layout budgets: the feed/scroll ratio stays
inside 0.78-0.82 and the feed/content ratio inside 0.85-0.89. An `18rem` rail pushes them to about
84% and 91%, outside the established feed measure.

### D11 - Type the passthrough fields (R10, R12)

Add `parentID?: string` and an optional bounded `time` shape to `OpencodeSession` in
`src/opencode/client.ts`. These are additive type declarations for fields that already pass through;
no runtime request or response changes. Do not add an unused `agent` field.

### D12 - No realtime in this stage (R11)

Do not add lifecycle event types, polling, or a second SSE subscription. Child sessions still appear
when the existing refresh triggers run. The design records the realtime gap (section 1) so the next
stage can add typed `session.created/updated/deleted` events without re-deriving it.

## 5. Alternatives considered

- **Server-side nested response.** Rejected: the browser can group a bounded flat list for free, the
  API is shared with the IDE extension, and nesting would be a contract change without a schema
  benefit.
- **Filter children out of the list with `roots=true`.** Rejected: it hides the sessions the tree is
  supposed to show, requires a second request for children, and changes the shared endpoint's
  behaviour.
- **`<details>`/`<summary>` for each row.** Rejected: the row is already an interactive button and
  the delete control is a sibling; nesting interactive controls in `summary` creates ambiguous
  activation and focus behaviour. An explicit chevron with `aria-expanded` is simpler.
- **`role="tree"`.** Deferred: correct tree semantics require roving-tabindex and arrow-key
  navigation. A partially implemented tree role is worse than a disclosure list.
- **Reorder roots by latest descendant.** Deferred: it changes the rail's order and causes jumps;
  it is an owner decision, not a requirement of grouping.
- **Accept the server-side child-row leak.** Rejected: children are selectable, so a child draft or
  attachment is reachable; the DELETE route must clean the whole subtree.
- **Poll or subscribe for realtime now.** Deferred to the realtime stage; this stage does not change
  the wire protocol.

## 6. Impact

- `assets/chat-core.js`: new pure `buildSessionTree()`, `firstRootId()`, `ancestorIds()`, and
  `collectSubtreeIds()` helpers.
- `assets/chat.js`: `renderSessions()` recursion, chevron handling, expansion Set, active-ancestor
  expansion, focus/scroll restoration, first-root selection, search visibility, parent wait
  aggregation, subtree delete, prompt cleanup, signature update.
- `src/http/styles.css`: `.session-node`, `.session-children`, `.session-chevron`, indentation,
  collapsed/expanded icon state, hover/focus treatment, rail width, mobile drawer max width.
  `assets/app.css` is rebuilt by `npm run build:css`.
- `src/http/chat.ts`: remove `aria-live` from `#session-list` (use `#chat-announcer`), extend the
  DELETE route with the subtree cleanup.
- `src/chat/session-tree.ts`: new server helper `collectSessionSubtreeIDs`.
- `src/opencode/client.ts`: additive `parentID`/`time` type fields only.
- `test/chat-core.test.ts`, `test/session-tree.test.ts`, `test/chat-page.test.ts`: tree helper
  tests and the DELETE-route integration/expectation update.
- `docs/design/chat-qa.mjs`: deterministic session-tree browser scenario.
- `docs/current-state.md`: document the tree, the delete cleanup, and the deferred realtime
  behaviour.
- No schema, migration, manifest, settings, dependency, or API-shape change.

## 7. Risks and mitigations

- **Re-render loses expansion or focus.** Include expansion in the signature, refresh the cached
  signature on a chevron toggle, and restore focus by `data-session-id` plus control after every
  render.
- **Grouping moves the active row out of view.** `scrollIntoView({block: "nearest"})` the active row
  after boot, deep link, and selection.
- **Narrow rail plus indentation truncates titles further.** Widen to `17rem`, clamp indentation at
  five levels, and add a full-title tooltip; do not rely on titles for identity.
- **Orphans and cycles hide sessions or hang the renderer.** Treat unknown parents as roots, promote
  the first node of a cycle to a root, and use a visited set during rendering.
- **Deleting a parent leaves stale client state or server rows.** Collect the full subtree, clear
  prompts and per-session maps, call `refreshSessions()`, and clean descendant rows/folders on the
  server. The server cleanup is best effort under the 100-session window and isolates per-id
  failures.
- **The DELETE-time list slows or pins the per-session lock.** Use `listSessionsBounded`, treat
  timeout/oversize/non-array as a fallback to `[sessionId]`, and never let cleanup failure turn a
  successful delete into a `500`.
- **A collapsed parent hides a waiting child.** Aggregate the subtree waiting count on the parent;
  the top-bar count remains a second safety net.
- **The first upstream row is a child.** Choose the first root for the default selection; keep an
  explicit requested session even when it is a child.
- **The shared endpoint changes the IDE extension.** Keep the API flat and the order unchanged; all
  grouping and first-root selection are web-rail-only.
- **`hidden` is overridden by a flex rule.** Add `.session-children[hidden]{display:none}` explicitly
  (the codebase already uses this pattern, e.g. `src/http/styles.css:3633-3636`).
- **The live region announces the whole tree on every refresh.** Remove `aria-live` from
  `#session-list`; use `#chat-announcer` for expand/collapse and count changes only.
- **The active row is hidden by collapsing its ancestor.** Accepted: the thread stays selected, and
  the next selection re-expands the chain.

## 8. Owner decisions (closed 2026-10-25)

| ID | Decision |
| --- | --- |
| Q1 | Collapsed by default; auto-expand the active branch; no persistence across reloads. |
| Q2 | Keep the upstream order for roots and siblings; no subtree-activity reorder. |
| Q3 | Parent shows one aggregate waiting count over its subtree; children show their own. |
| Q4 | Delete the whole subtree, warn with the child count, and select the first root if the active session was deleted. |
| Q5 | Search shows matches plus their ancestors; unrelated descendants stay hidden. |
| Q6 | Widen the rail to `17rem` (the largest width that preserves the 1440 feed budgets) and add a full-title tooltip. |

## 9. Verification

- Unit tests for `buildSessionTree()`, `firstRootId()`, `ancestorIds()`, and `collectSubtreeIds()`:
  flat list, multi-level nesting, missing parent, self-parent, two-node cycle, duplicate id, empty
  list, stable sibling order, leading-child default, truncated-window orphan, subtree collection
  under a cycle.
- Unit tests for the server `collectSessionSubtreeIDs()` with the same malformed and multi-level
  cases, and a route test for R13: seed parent+child drafts/attachments/`session_state`/folders and
  a handoff row; assert child and parent rows/folders are gone, an unrelated session is untouched,
  a non-array list still deletes, and the handoff receives `source_session_deleted_at`.
- Update `test/chat-page.test.ts:880`, which asserts the exact upstream call list; the DELETE path
  now performs a GET before the DELETE.
- Existing chat tests remain green.
- `npm run lint`, `npm run typecheck`, `npm test`, `npm run build`, `npm run check:sensitive`.
- Browser QA: extend `docs/design/chat-qa.mjs` (its `/sessions` interception is at lines 612-614)
  with parent + children + grandchild + orphan; expand/collapse; deep link to a grandchild;
  first-root default; search with ancestors; parent waiting aggregate; delete a parent; 390, 1440,
  and 320 widths; keyboard focus after a refresh; `aria-expanded`/`aria-controls` assertions; a
  delete-session route mock that accepts the confirm dialog, returns 200, and drops the subtree
  from the fixture before the post-delete refresh.
- Manual check with a disposable app: spawn a subagent, verify the child is grouped under its parent
  after the next refresh (not realtime in this stage), verify an orphan renders as a root, confirm
  the pinned opencode version really cascades the parent delete (if it does not, guard the server
  cleanup with a post-delete existence check), and verify a parent delete removes the child's
  draft/attachment rows.

## 10. Design review

- Round 1 (`oracle`, 2026-10-25): **CHANGES REQUESTED**. Findings folded: expansion in the render
  signature (D4); full-array subtree collection independent of the filter (D9); prompt cleanup on
  subtree delete (D9); server-side child-row/folder cleanup and corrected DB wording (R13, D9,
  section 1); live-region and chevron a11y (D3, D4, D7, section 6); `[hidden]` CSS, rail width, and
  mobile drawer (D10, section 6); focus/scroll restoration (D4, D5); committed browser QA (section
  9). Non-blocking notes folded: 100-session cap (R5, D2), `agent` dropped from D11, parent shows
  one aggregate waiting flag (D8), active-ancestor collapse accepted (D4), citation re-anchoring.
- Round 2 (`oracle`, 2026-10-25): **CHANGES REQUESTED**. Findings folded: bounded/failure-isolated
  server listing and per-id cleanup (D9); a route integration test for R13 and the
  `test/chat-page.test.ts:880` expectation (section 9); state-neutral chevron name plus
  `aria-disabled`/focus fallback (D3, D4, D7); active-ancestor re-expansion after refresh (D4);
  reuse of `clearSessionPrompts` (section 3, D9). Non-blocking notes folded: cascade confirmation
  in the manual check, helper parity, QA dialog/DELETE mock/320px/aria assertions, focus fallback
  and `preventScroll`, `skipFlush`, meta wrapping, concurrent draft race accepted.
- Round 3 (`oracle`, 2026-10-25): **PASS**. Non-blocking notes folded: per-id try/catch instead of
  an optional single transaction (D9); manual collapse duration clarified (D4); confirmation count
  is the loaded subtree / "at least N" (D9).
- Implementation note (2026-10-25): shipped at `17rem`, not the approved `18rem`. The 18rem rail
  pushed the 1440 feed/scroll ratio to 84% and the feed/content ratio to 91%, outside the existing
  0.78-0.82 / 0.85-0.89 chat QA budgets. 17rem keeps both budgets and still widens the rail; the
  deviation and measured evidence are recorded in journal 0032.
