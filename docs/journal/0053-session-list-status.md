# 0053 - Session list live agent status

> Stage 0045. Design: [`docs/design/session-list-status.md`](../design/session-list-status.md).
> Plan: [`docs/plans/0045-session-list-status.md`](../plans/0045-session-list-status.md).
> Owner authorized the full delivery cycle on 2026-11-11.

## Context

The chat sessions rail showed only a session title and an aggregate `N waiting` badge. The operator
asked for a live per-session agent status: nothing when idle, a status when the agent works, and the
waiting-for-operator badge must take precedence over the status.

The browser already kept a per-session status map fed by the app-scoped SSE `session.status` events,
but the rail did not receive it, and a fresh page load had no status for non-active sessions.

## What changed

- **Server** (`src/opencode/client.ts`, `src/http/chat.ts`): `GET /api/apps/:app/sessions` now starts
  a bounded 1.5 s `/session/status` read concurrently with the session list and merges an additive
  `status: {type}` per session. An unknown type, a malformed top-level body, or a failed read omits
  the field; an upstream entry absent from the active map is `idle`. Any upstream `status` key is
  stripped first, so a failed read cannot leak it. Only `type` is exposed. The existing
  `listSessionStatuses` behavior is preserved through a shared tolerant parser; the new
  `listSessionStatusesForList` throws on a malformed top-level body so the caller can omit rather
  than fabricate `idle`.
- **Client store** (`ui/stores/chat-session.ts`): `ChatSessionSummary.status?`; `setSessions` prunes
  statuses for removed sessions and seeds the response status only when the session has no entry
  (a live SSE transition wins over an older list snapshot); `clearAgentStatuses()` empties the map.
- **Page wiring** (`ui/pages/ChatPage.vue`): pass the map to the rail; on `onResync` (gap or new
  stream id) clear the map and refetch the session list; reconcile the active session from the
  authoritative `/turn` snapshot (`idle | busy | retry`, ignore `unknown`); reset the session status
  to `idle` on the intentional-abort early return.
- **Rail** (`ui/components/chat/ChatSessionsRail.vue`, `ChatSessionNode.vue`): the status map is
  passed through the node tree; each node renders `Working` for `busy`, `Retrying` for `retry`, and
  nothing for `idle`/unknown. The waiting badge wins. The indicator is an `aria-hidden` pulsing dot
  plus a text label, with no live region and no new focusable element.
- **Styles** (`src/http/styles.css`): `.session-item__status`/`.session-item__status-dot` inside the
  existing `@layer components`, with a `prefers-reduced-motion` rule.
- **Docs**: this record, `docs/current-state.md`, and the design/plan indexes.

## Decisions and rationale

- Variant B (server-merged status in the list) over a client-only badge: a fresh load needs correct
  first paint for non-active sessions, and the existing SSE alone has no snapshot for them.
- Waiting precedence: the waiting badge is itself a status and is more action-relevant than
  `Working`; it always wins.
- Own-session status only; no subtree aggregation. The requirement is per-session status, and a
  parent that spawns a subagent is normally busy while it waits on the call. Waiting still
  aggregates because it demands operator attention.
- Status-read failure and unrecognized types omit `status` (unknown), never `idle`.
- An individual malformed status entry is dropped and its row is reported `idle`. Accepted bounded
  degradation: it can hide a badge, but it never fabricates `Working`.
- No TTL cache in this stage; the read is concurrent and bounded at 1.5 s.

## Verification evidence

- `npm run lint` - pass (914 files, no fixes).
- `npm run typecheck` - pass.
- `npm run typecheck:ui` - pass.
- Targeted `vitest` (`client`, `chat-page`, `chat-stores`, `ui/chat-page`, `ui/chat-sessions`) -
  207 passed.
- `npm test` - 4028 passed, 1 skipped (269 passed / 1 skipped files).
- `npm run build` - pass; `ChatPage` chunk 76,750 B gzip (budget 256,000 B).
- `npm run check:ui` - pass (86 SFCs, sentinel present).
- `npm run check:sensitive` - pass.
- `npm run test:e2e` - 137 passed, 1 skipped (SPA chat/session-tree specs included).
- Dedicated `session-tree` chat-qa: **blocked, no visual PASS claimed**. The scenario is
  pre-existing-stale: it defaults to `legacy` mode (retired chat), uses `#session-list` selectors
  that do not exist in the SPA rail, and its waiting badges depend on legacy-only population (the
  SPA rail's waiting counts come from prompt SSE events the scenario never emits). The attempted
  changes were reverted; enabling that scenario is separate harness debt. The new indicator is
  covered by the jsdom rail tests, not a dedicated screenshot.

## Residual risks and accepted limits

- One extra upstream `/session/status` call per session-list load, concurrent with the list and
  bounded at 1.5 s; a failure degrades to no status. A short TTL cache is a follow-up if refetch
  traffic or upstream load becomes a problem.
- A session can start/stop between the list and status reads; the coarse badge can be briefly wrong
  until the next SSE event or list refetch.
- An individual malformed upstream entry makes that row report `idle` (badge hidden, never
  `Working`).
- Status is own-session only; a collapsed parent may show nothing while only a descendant works.
- No indicator-specific browser screenshot; the Playwright SPA suite and jsdom tests are the
  evidence.

## Follow-ups

- Fix or retire the legacy `session-tree` chat-qa scenario so chat stages have a runnable spa-mode
  browser gate.
- Optional status TTL cache.
- Optional subtree `busy`/`retry` aggregation if the operator wants collapsed-parent visibility.

## Commit

One coherent stage commit (code + tests + docs + this record). No push.
