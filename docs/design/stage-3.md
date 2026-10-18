# Stage 3 - Chat workspace

Status: complete. Stage 4 (final integration) is not part of this record.

## Scope

Stage 3 replaces the legacy single-column chat page with a full-height three-pane workspace built on
the stage-1 chat primitives and the stage-2 shell. No client framework, bundler, external font, CDN,
or new dependency was added. The session/message/SSE API response shapes are unchanged.

Routes:

| Route | Behavior |
| --- | --- |
| `GET /chat?app=<appKey>&project=<projectId>` | Human-only workspace; `project` is optional and disambiguates duplicate app keys. Missing app redirects to the first app with both params. No apps renders a shell empty state. Unknown app renders the styled HTML 404 in the shell. |
| `GET /api/apps/:app/sessions?project=<id>` | Existing shape; `project` is additive. |
| `POST /api/apps/:app/sessions?project=<id>` | Existing shape; creates a session. |
| `GET /api/apps/:app/sessions/:sid/messages?project=<id>` | Existing shape. |
| `POST /api/apps/:app/sessions/:sid/messages?project=<id>` | Existing `{ text }` shape. |
| `GET /api/apps/:app/sessions/:sid/events?project=<id>` | Existing SSE semantics; `project` selects the app. |
| `GET /assets/chat.js` | Added to the strict asset allowlist. |

## Layout and shell

- `appShell` gained additive `pageClass`, `bodyClass`, and `scripts` options. The chat page uses
  `page--chat`, `page__body--chat`, and `/assets/chat.js`; an empty header is omitted.
- `>=1360`: sessions 256px / thread `minmax(0,1fr)` / context 320px.
- `1024-1359` and `768-1023`: sessions static, context a right-side drawer opened from the top bar.
- `<768`: one column; sessions and context are full-height drawers. Sessions open from the pane head,
  context from the top-bar toggle. Scrim, Escape, close buttons, and focus return are wired.
- `.page--chat` does not scroll and has no chart ground; `.chat-thread__scroll` is the only vertical
  scroll owner. The composer is the last grid row and never scrolls away.
- Top bar: context toggle (below 1360) and the app IDE link. The pane head holds the grouped app
  selector, new-session action, sessions toggle (`<768`), and runtime pill.
- The thread meta strip holds the session title, mono short id, live status, message count, working
  indicator, and stream retry. The page has a visually hidden `h1` because the design intentionally
  omits a page header.

## Client behavior

`assets/chat.js` is dependency-free and uses DOM APIs/`textContent` only (no `innerHTML` for chat
content):

- Loads sessions, selects a valid `?session=`, otherwise the first session, and auto-creates one if
  the list is empty. Missing sessions mirror the selected id into the URL with `history.replaceState`.
- Session search filters by title or id; new sessions are selected immediately and clear the filter.
- Switching sessions closes the sessions drawer, reloads messages, reopens SSE, updates the URL, and
  focuses the composer.
- Sends on Enter and Ctrl/Cmd+Enter; Shift+Enter inserts a newline. The composer auto-resizes, shows
  `aria-busy` plus a spinner while sending, restores the draft and shows an inline error on failure.
- SSE events debounce a silent message reload. Reloads preserve scroll unless the reader is at the
  bottom; new messages show a floating "New messages" button. Three consecutive stream errors stop
  the stream, show `Paused`, and expose Retry.
- Message parts: safe markdown-lite text, tool calls (auto-open on error), collapsed reasoning and
  patches, and skipped unknown/step parts. Status is glyph + text + color.
- Empty thread, skeleton loading, compact sessions error, thread error with Retry, and a
  "Starting agent..." state are all implemented.

## Markdown safety

The renderer builds DOM nodes: paragraphs, headings (`h3`-`h5`), unordered/ordered lists,
blockquotes, fenced and inline code, strong/em, http(s) markdown and bare links, horizontal rules,
and line breaks. Link protocols are restricted to `http:`/`https:`; raw HTML, images, tables, and
embeds are not rendered. Tool output is always `textContent` inside `<pre>`.

## Visual QA

Reference routing note: the frontend skill's `design/README.md`, `layout-skill.md`,
`stylegallery.md`, `interaction-skill.md`, `perfection/README.md`, and `designpowers/` files are not
installed on this host. The existing `DESIGN.md` remained the binding visual contract; this is a
documented skipped-lane gap, not a silent one.

Two QA tracks were exercised:

1. **Real agent (primary end-to-end):** server on `127.0.0.1:8792` against the seeded DB with
   `HANSE_AUTH_FILE=<HOME>/.local/share/opencode/auth.json`, `opencode 1.18.35`. Login cookie
   `demo-token`; `/chat?app=storefront&project=1111...`; session auto-created, SSE reached `Live`,
   prompt "Reply with the single word OK." returned `OK`. No page or console errors.
2. **Deterministic fixtures (layout/state matrix):** Playwright route interception for sessions,
   messages, POST, errors, delays, plus a fake `EventSource`. 27 captures cover every viewport/theme
   and the loading, empty, error, drawer, search, focus, new-message, and send-error states.

Independent oracle subagents are not available in this session, so the dual-oracle gate was not
run; the evidence below is first-party Playwright plus read-tool inspection of every capture.

Automated checks:

- No horizontal overflow at 390/768/1024/1440, including both chat drawers.
- Interaction script: initial session, switch, new session, search, Enter/Shift+Enter/Ctrl+Enter,
  theme persistence, drawer Escape/focus return, session-switch drawer close, SSE pause/retry, error
  retry. All passed with zero unexpected console/page errors.
- Screenshots inspected with the read tool; two defects were found and fixed: the page body was
  shrink-wrapped (centered 335px content) and the thread viewport lacked `min-inline-size:0`, both
  causing right-edge clipping at 390. The composer textarea also needed an explicit `flex:1`/auto
  width. Final 390 captures have no clipping.

Evidence under `docs/design/artifacts/stage3/`:

- `chat-{390,768,1024,1440}-{dark,light}.png`
- `real-agent-messages-{1440-dark,1440-light,390-dark}.png`
- `chat-empty-{1440,390}-dark.png`, `chat-loading-{1440,390}-dark.png`,
  `chat-error-{1440,390}-dark.png`
- `chat-sessions-drawer-390-{dark,light}.png`
- `chat-context-drawer-{1024-dark,1024-light,768-dark,390-dark}.png`
- `chat-session-search-390-dark.png`, `chat-composer-focus-{1440,390}-dark.png`
- `chat-new-messages-{1440,390}-dark.png`, `chat-send-error-1440-dark.png`,
  `chat-working-1440-dark.png`

## Gates

```text
npm run lint       Pass (Biome, 60 files)
npm run typecheck  Pass
npm test           Pass (18 files, 97 tests; 9 chat page tests)
npm run build      Pass (tsc + Tailwind CSS)
```

## Deviations and accepted debt

- The context toggle lives in the top bar (as the pane-head note allows); there is no duplicate
  pane-head context toggle. Sessions toggle stays in the pane head below 768.
- New session is available both in the sessions head and the thread pane head.
- Session/context drawers close with Escape/scrim/close and return focus, but do not trap focus.
- Every message in a session renders; there is no virtual list.
- Chat markdown is a safe subset (no tables/images/embeds/raw HTML).
- Session and message timestamps are derived from opencode fields when present and omitted when not.
- The chat page keeps a hidden `h1` while omitting the visual page header.
- The stage-3 reference lanes were unavailable on this host; see the routing note above.

## Final integration QA

A separate 24-check Playwright pass ran against a copy of the seeded database and the real local
agent, covering the anonymous login/error flow, project creation, add-app, handoff creation, approve
with reason, inline reject, styled 404, mobile layout, and the live chat workspace.

Follow-ups fixed during that pass:

- Mobile `.watch-strip--4` is a 2x2 grid at phone width instead of four stacked rows.
- The new-handoff dialog defaults `from` and `to` to different applications when the project has more
  than one.
- Mobile table action cells are end-aligned (`.table__actions`), so chevrons/Review no longer sit at
  the left edge of a stacked row.
- The application runtime chip in the chat context pane mirrors the thread runtime state, including
  the error state.
- Overlapping silent message reloads are sequence-guarded; open tool/reasoning/patch disclosures
  survive an SSE re-render.

Evidence: `docs/design/artifacts/final/` (`overview-390-dark`, `handoffs-390-dark`,
`new-handoff-dialog-390-dark`, `chat-1440-dark`). The audit reported no horizontal overflow and no
unlabeled controls or unnamed icon buttons at 390/768/1024/1440; the live chat loaded one session and
two messages from the real agent.

## Stage 4 handoff

- Keep `handleChat` API branches, response shapes, and SSE streaming semantics; `project` is additive
  only.
- Reuse `buildSite`/`findApp` conventions for any new project-scoped chat surface. Every chat link and
  client URL must carry `project` when known.
- Reuse `assets/chat.js` behavior and the stage-3 CSS block rather than re-implementing sessions,
  markdown, drawers, or SSE.
- The global shell stays `assets/app.js`; the chat composer is marked `data-no-busy` so the shell
  busy handler does not double-disable it.
- If adding virtualization or focus trapping to drawers, pin the current scroll/focus behavior with
  tests first.
