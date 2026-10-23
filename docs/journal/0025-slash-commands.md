# 0025 - opencode slash commands in the chat composer

- Date: 2026-10-23
- Stage: `0021-slash-commands`
- Status: implemented and verified; commit pending explicit owner authorization
- Design: [`docs/design/slash-commands.md`](../design/slash-commands.md)
- Plan: [`docs/plans/0021-slash-commands.md`](../plans/0021-slash-commands.md)
- Probe: [`docs/design/artifacts/slash-commands/probe.md`](../design/artifacts/slash-commands/probe.md)

## Why

The chat could send text and render the agent's work, but an operator had to remember opencode's
slash commands and could not invoke them from the web UI. The request was one palette with
suggestions, built as a thin layer over opencode rather than a second implementation of every
command, so custom commands and MCP prompts stay compatible and the maintenance surface stays small.
A small Hanse-local registry was added only for actions the web UI already owns.

## What changed

### Phase 0 probe

The pinned `opencode-ai@1.19.3` was probed in an isolated synthetic app (evidence:
`docs/design/artifacts/slash-commands/probe.md`). The decision was **v1**:

- `GET /command` returns a top-level array and is project-scoped by the server working directory;
  the command list includes `template`, `hints`, `source`, and optional `agent`/`model`/`subtask`.
- `POST /session/{sid}/command` blocks until the turn completes, returns `{info, parts}`, and
  applies the supplied `messageID` to the created user message.
- A client disconnect does not abort the turn; the server continues and completes it.
- A missing session returns `404 NotFoundError`; an unknown command returns `500 UnknownError` and
  starts no turn.
- The v2 list route exists but its send route is absent; v2 was not used.
- MCP prompts serialize `template` as a JSON object, so the shell state is `unknown`.
- Shell blocks match anywhere in the template and argument-injected blocks run after `$ARGUMENTS`
  substitution; the confirmation gate scans both the template and the arguments.

### Server

- **opencode client.** `src/opencode/client.ts` gained `OpencodeCommand`, `listCommands`
  (`GET /command`, no directory query, 4 MiB/10 s), and `runSessionCommand`
  (`POST /session/{sid}/command`, 30 min default, drains at most 1 MiB).
- **Pure command model.** `src/opencode/commands.ts` owns the six-entry Hanse registry, the
  `none|present|unknown` shell state, the explicit upstream whitelist (never retains `template`),
  merge/collision policy, `resolveCommandToken`, warnings, the 500-per-list and 1 MiB merged caps,
  and `upstreamCommandSupport() === "v1"`.
- **HTTP contract.** `src/http/commands.ts` exposes `GET /api/apps/:app/commands` and
  `POST /api/apps/:app/sessions/:sid/commands`. Both are human-only; the POST is JSON-only, rejects a
  cross-site `Origin`, checks deletion markers before any runtime branch, validates the name and the
  32 KiB argument string, and forwards exactly `{command, arguments, messageID}` upstream.
  A `present`/`unknown` shell command requires `confirmShell:true`; unknown commands never dispatch a
  Hanse action. Execution is detached: the route waits 750 ms for an immediate post-dispatch failure,
  then returns `202 {accepted, sessionID, name, messageID}`; later output arrives over the existing
  app SSE and later failures are logged only. The GET uses a 5 s endpoint-keyed display-summary
  cache and never starts a stopped app; the POST always fetches a fresh list and retries a name miss
  once. Errors use fixed messages and never return or log an upstream body, template, prompt, or
  `OpencodeHttpError` text.
- **Dispatch and logging.** `src/http/server.ts` routes both paths before the `isChat` catch-all.
  `HttpDeps` gained an optional logger and the CLI wires `createLogger()`; `commands.list`,
  `commands.list.shadowed`, and the `commands.send.*` lifecycle events log ids, names, status/code,
  counts, byte lengths, duration, and `messageID` only.

### Client

- **Pure helpers.** `assets/chat-commands.js` parses the composer draft, matches canonical names and
  Hanse aliases, filters/groups, builds command lines, applies the shell-confirmation and
  pending-question policy, and owns the six-action fallback map. It is plain ESM with JSDoc and is
  importable by Vitest.
- **Palette.** `src/http/chat.ts` adds the in-flow palette/listbox above the composer, the Commands
  button, the reusable confirm dialog, and `data-ide-url`/`data-app-url`/`data-master` on the chat
  shell. The textarea is a combobox; rows are listbox options with text badges and text-only content.
  Typing `/` at the start or clicking Commands opens it; Arrow/Home/End skip disabled rows;
  Enter/Tab insert `/name ` and never execute; Escape closes; the existing Enter-to-send path is
  unchanged when the palette is closed.
- **Send path.** `assets/chat.js` fetches and caches the catalog for 30 s, refetches after
  `stream.ready` or `command_not_found`, and integrates one early branch in `sendPrompt` after the
  acceptance guards and before the language prompt lock. Server commands are confirmed for a
  `present`/`unknown` shell, sent with one optimistic row, rekeyed by the 202 `messageID`, retried
  once on a stale-list `400 shell_confirmation_required` without a second row, rolled back on
  pre-dispatch failures, and reconciled through the existing unknown-acceptance path after a
  post-dispatch failure.
- **Actions.** `/new` starts a draft, `/help` opens the palette with an optional filter, `/editor`
  (`/ide`) opens the IDE with a same-tab popup fallback, `/compact` reuses the context reason and
  confirm flow, `/diff` opens the application page `Changes` (`#changes-title`) in a new tab, and
  `/restart` confirms and posts the existing async restart route. `/editor` and `/diff` are disabled
  for the master; `/model` and `/stop` are deferred; 25 TUI-local commands are skipped.
- **Styling.** `src/http/styles.css` adds only in-flow palette, badge, disabled-row, confirm-dialog,
  touch-row, and reduced-motion rules using the existing chart-room tokens; the chat feed is not
  restyled.

## Decisions

- The six Hanse actions are `new`, `help`, `editor`/`ide`, `compact`, `diff`, and `restart`;
  `/sessions` and 24 other TUI-local commands are skipped, and `/model`/`stop` are deferred.
- Upstream commands win name and alias collisions; shadowed Hanse rows are hidden with a warning and
  a direct-typed shadow hint.
- A `template` is never sent to the browser or stored in the summary cache; the palette displays only
  metadata. The expanded prompt still appears in the transcript after execution because opencode
  owns message content; that is existing behavior, not a new disclosure.
- `shell: "present"` and `"unknown"` both require an explicit confirmation; unknown is not treated as
  safe. `confirmShell` is an accident/UX guard, not a security boundary; human-only auth plus operator
  trust are the real boundary.
- The GET summary cache is display-only and may be up to 5 s stale; the POST re-reads the fresh list
  and is authoritative.
- `/diff` is the worktree-wide application `Changes` view, not a session-scoped aggregate; a session
  aggregate remains future work.
- No database migration, no new dependency, no client framework or bundler, and no feature flag.

## Verification

- New focused tests: `test/commands-registry.test.ts` (27), `test/slash-commands.test.ts` (41),
  `test/chat-commands.test.ts` (37), and the expanded `test/chat-page.test.ts` (53).
- Full suite: `npm test` passed with **107 files / 1,844 tests**.
- `npm run typecheck`, `npm run lint`, `npm run build`, and `npm run check:sensitive` passed.
- `node docs/design/chat-qa.mjs` passed: **22 scenarios, 429 assertions, 45 screenshots, zero
  console/page errors**, including `commands-palette`, `commands-shell-confirm`,
  `commands-shell-unknown`, `commands-stale-400`, `commands-unknown-literal`, `commands-master`,
  `commands-popup`, and `commands-widths` at 390/768/1440 dark and light.
- Live real-agent smoke was **not run**: no coordinator URL, operator token, test app, or session is
  available in this environment. No live result is claimed.

## Residual risks

- A coordinator restart after a 202 loses the background wait; the transcript/SSE remain
  authoritative and the accepted-row path marks an absent message unknown rather than dropping it.
- The 30 min coordinator wait cap stops waiting; the probe showed a disconnected client does not
  abort the upstream turn, so the turn can continue. A future opencode version that cancels on
  disconnect would make the cap a hard kill.
- Shell detection is the upstream regex over the template plus the same scan over the arguments. An
  upstream grammar change is a real risk; the phase-0 probe pins 1.19.3 and the fallback is
  `unknown` (confirmation required).
- MCP prompts and a future v2 shape have no inspectable string template; they are `unknown` and
  require confirmation. The v2 adapter remains a documented contingency, not implemented.
- `GET /commands` can serve a 5 s-stale display list; `POST` never does. A UI that shows a stale
  command and then posts it can get `command_not_found` and must refetch (the client does).
- The palette depends on the v1 route pair at the pinned opencode version; upgrading the pin requires
  re-running the probe before changing the adapter.
- The worktree also contained the app-skill-authoring stage's changes while this stage was verified;
  the full gates and QA were run with those changes present.

## Open threads

- Live real-agent smoke on a test application, including a project command, shell confirmation,
  argument injection, the six Hanse actions, agent-principal 403, stopped-app degradation, and the
  master disables.
- A later stage may add `/model`, `/stop`, or a session-scoped diff; none is part of this stage.
- Commit is pending explicit owner authorization; no commit was made.
