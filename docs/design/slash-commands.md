# Design - opencode slash commands in the Hanse web chat

Status: approved for planning - oracle round 2 **PASS** (2026-10-23), after round 1 **FAIL**; plan
pending. This revision resolves the round-2 minor findings (§18). This document is the design
artifact only: no production code, plan, tests, or commit.
Plan reviewer: `momus` after the design gate. Verification for the eventual implementation is
`npm run lint && npm run typecheck && npm test && npm run build` (`docs/process.md:34-43`).

Scope: a thin proxy for opencode's own server commands plus a small Hanse-native command registry,
merged into one slash-command palette in the chat composer.

Out of scope: implementation. No command authoring, no per-command UI, no template expansion, no
argument expansion/splitting/quoting/interpolation/reinterpretation in Hanse, and no shell execution
in Hanse. The only read of the arguments string is the shell-pattern safety scan (§6.4).

## 1. Context

### 1.1 The chat surface today

- The chat page is server-rendered HTML plus one vanilla ESM module, with no framework and no
  bundler: `moduleScripts: ["/assets/chat.js"]` (`src/http/chat.ts:408`), and `chat.js` imports
  only local ESM helpers (`assets/chat.js:1-29`).
- The composer markup is `src/http/chat.ts:298-314`; the client caches the composer, prompt, send
  button, and error nodes at `assets/chat.js:92-95`; Enter-to-send and form submit are wired at
  `assets/chat.js:7675-7689`. The Enter handler is unconditional: when the palette is closed it
  must keep submitting, and when the palette is open it must insert instead (see §7.3).
- The only browser send path is `sendPrompt` (`assets/chat.js:7383-7529`): it **trims the draft at
  the start** (`assets/chat.js:7390`) and posts the trimmed text as `{text}` to
  `POST /api/apps/:app/sessions/:sid/messages?async=1` (`src/http/chat.ts:633-698`, body at
  `assets/chat.js:7441`), and that route calls opencode's `prompt_async` with
  `{parts:[{type:"text",text}], messageID, model}` (`src/opencode/client.ts:348-368`). The text is
  forwarded verbatim after that trim; nothing in the client or route splits a leading `/`.
- `sendPrompt` blocks while a question or permission is pending: `activePromptEntries().length > 0`
  (`assets/chat.js:1036-1038`, lock at `assets/chat.js:7386-7389`). A slash command must not bypass
  that lock (see §7.3).
- The blocking message route still exists (`src/http/chat.ts:700-708`, `src/opencode/client.ts:332-346`)
  but the browser does not use it.
- The model is injected server-side from the effective settings (`src/http/chat.ts:92-106`) and used
  at `src/http/chat.ts:657` and `:706`; the browser cannot set it.
- Assistant output arrives over the typed app SSE `GET /api/apps/:app/events`
  (`src/http/prompts.ts:650-779`), not over the POST response. Frames are `{type,seq,streamID}`,
  app-scoped, with all sessions multiplexed; the client filters by `sessionID`.
- The endpoint and Basic authorization come from `manager.ensure` (`src/opencode/manager.ts:731-737`)
  and the process-local authorization registry (`src/opencode/endpoint-auth.ts:18-33`). The transport
  helpers are typed and private `call()` and `requestResponse()` (`src/opencode/client.ts:169-179`,
  `:435-463`).
- `opencode serve` runs with `cwd: spec.appDir` (`src/agent/host.ts:295-299`), so the instance already
  resolves the project's commands. A host `directory` query must not be passed.
- Existing actions that a slash command could reuse: manual compaction (`src/http/context.ts:15-16`,
  `:55-59`; client `compactContext` at `assets/chat.js:1840`), the context confirmation
  (`openContextConfirm` at `assets/chat.js:1549`; it returns silently when the compact button is
  disabled) and its reason helper (`contextCompactReasonFor` at `assets/chat.js:1573`), restart as a
  form POST (`src/http/chat.ts:339-342`) or an async JSON POST returning `202`
  (`src/http/settings.ts:714-730`), the IDE folder URL (`src/http/ui.ts:235-236`; chat rail link at
  `src/http/chat.ts:328-333`), the shell theme toggle (`src/http/ui.ts:458-462`), the application page
  (`src/http/chat.ts:215`) with a worktree `Changes` section
  (`src/http/application.ts:458-460`), and "New session" / `startDraft` (`assets/chat.js:7203`).
- The `#chat-shell` element already carries the app/project/runtime data attributes
  (`src/http/chat.ts:410`). Phase 2 adds `data-ide-url`, `data-app-url`, and `data-master` there.
- There is no abort endpoint in the Hanse client, no session undo/redo, no share/export, no agent
  selection, no MCP toggle, and no model catalog exposed to the UI (`src/opencode/client.ts` has no
  such functions; the only model input is the effective setting above).

### 1.2 What opencode exposes

The empirical probe was run against opencode **1.18.35**; the repository pin is **1.19.3**
(`Dockerfile:6,42`). Only 1.18.35 was runtime-probed. The 1.19.3 statements below are either
source-read at tag `v1.19.3` or marked **verify in phase 1**; they are not a claim that 1.19.3 was
executed in this design.

opencode v1:

- `GET /command` returns `Command[]`, where
  `Command = {name, description?, agent?, model?, source?: "command"|"mcp"|"skill", template,
  subtask?, hints: string[]}`. The API accepts optional `directory`/`workspace` queries; Hanse
  passes neither (§5.2, §6.4).
- `POST /session/{sessionID}/command` accepts
  `{command, arguments, agent?, model?, messageID?, variant?, parts?: file[]}` and returns
  `200 {info: AssistantMessage, parts: Part[]}`. It can block until the turn completes.
- `/api/command` also exists in 1.18.35 with a richer `CommandV2Info`; `/api/session/{id}/command`
  does not exist in 1.18.35.
- The v1 list already includes custom `.opencode/command(s)/**/*.md` commands, JSON `command`
  entries, MCP prompts, and skills (`source: "skill"`). Custom command templates support
  `$ARGUMENTS`, `$1..$N`, and `` !`shell` `` blocks executed server-side outside the agent
  permission flow.
- **Shell grammar.** `SessionPrompt.command` substitutes `$ARGUMENTS`/`$1..$N` first (and appends
  `arguments` when the template has no placeholder), then matches the exact upstream pattern
  ``/!`([^`]+)`/g`` **anywhere** in the resulting template and runs each block. The pattern is not
  anchored to a line start. Because substitution/append happens first, an `arguments` value can
  inject a shell block even into a template that has no `$ARGUMENTS`.
  Source-read at `v1.19.3` (`packages/opencode/src/session/prompt.ts`); the same pattern exists in
  1.18.35.
- **MCP templates.** An MCP prompt's `template` is a Promise in the command registry, so a JSON list
  cannot supply a string template. Whatever the HTTP serialization produces (`{}`, `null`, or an
  absent field), Hanse treats a non-string template as `shell: "unknown"` (§5.2, §6.3).

opencode 2.1.4 (for contrast only):

- `GET /api/command` returns only `{name, description?}`.
- `POST /api/session/{id}/command` takes `{name, text, files?, agents?, skills?, delivery?}` and
  returns `204`. The v2 route group is marked experimental.

The 30 client-local slash commands at `v1.19.3` are enumerated in §9.1; `/share` is keybind-only
there and is not a slash command.

### 1.3 The gap

Typing `/init`, `/review`, or a project's own `.opencode/command/*.md` command today sends the
literal text to the agent. The project's command system is invisible in the Hanse UI, and Hanse's own
small actions (new session, compact, restart, IDE) are only reachable through separate buttons and
rails.

### 1.4 Verified versus unknown

| Fact | State |
| --- | --- |
| The browser send path is the async message route; text is trimmed, then not parsed | Verified in `assets/chat.js:7383-7529`, `src/http/chat.ts:633-698` |
| Assistant output is the app SSE, not the POST body | Verified in `src/http/prompts.ts:650-779` |
| The model is server-injected and the browser cannot set it | Verified in `src/http/chat.ts:92-106`, `:657`, `:706` |
| `opencode serve` cwd is the app directory | Verified in `src/agent/host.ts:295-299` |
| A pending question/permission blocks `sendPrompt` | Verified in `assets/chat.js:1036-1038`, `:7386-7389` |
| v1 `GET /command` / `POST /session/{id}/command` shapes | Probed on 1.18.35 only |
| The shell pattern is ``/!`([^`]+)`/g``, applied after substitution/append, anywhere in the template | Source-read at `v1.19.3`; matches 1.18.35 behavior; probe in phase 1 |
| The 30-command TUI-local slash set | Source-read at `v1.19.3` (`packages/tui/src`); not runtime-probed |
| MCP prompt `template` is a Promise | Source-read at `v1.19.3`; verify the HTTP serialization in phase 1 |
| The pinned 1.19.3 has both v1 routes with the same shapes | **Verify in phase 1** |
| `arguments` is a string and `messageID` is honored | **Verify in phase 1** |
| The v1 command route blocks until the turn completes | **Verify in phase 1** |
| A client disconnect aborts the turn | **Verify in phase 1** |
| 1.19.3 exposes the experimental v2 command pair | **Verify in phase 1** |

## 2. Goal and non-goals

### Goals

- G1: One palette in the chat composer lists opencode server commands and Hanse-native commands in
  a single searchable list, with no per-command UI.
- G2: A selected opencode command is executed by opencode with the same name and raw argument
  string; Hanse does not reinterpret the template.
- G3: A selected Hanse command runs an existing Hanse action (new session, help, IDE, compact,
  restart, diff) with the existing confirmation behavior where destructive.
- G4: The wire contract is explicit, bounded, human-only, and never exposes command templates.
- G5: Ordinary messages, unknown slash text, the existing chat SSE, the session model, and the IDE
  extension keep working unchanged.
- G6: The stage is small and maintenance-light: one new registry, one list route, one send route,
  one palette, and a small action map.

### Non-goals

- NG1: Template expansion, `$ARGUMENTS`/`$1..$N` handling, argument expansion, splitting, quoting,
  interpolation, or reinterpretation, or shell execution in Hanse. The arguments string is **not**
  parsed into a meaning; the only read is the shell-pattern safety scan (§6.4), which detects and
  gates a block but never executes, rewrites, or reinterprets the arguments. Recognizing the leading
  `/name` token and keeping the remainder as one raw string is command recognition, not argument
  splitting.
- NG2: Command authoring, editing, deleting, or a command file browser.
- NG3: A separate UI, dialog, or form per command.
- NG4: Adopting the experimental v2 command API as the primary path, or building a general runtime
  version adapter. The only permitted v2 work is the contingency recorded in §6.6 and §17 when the
  pinned v1 pair is absent and the v2 pair exists.
- NG5: `/sessions` as a command. The sessions rail already owns listing, filtering, switching,
  creating, and deleting sessions (owner decision).
- NG6: `/model` and `/stop` in this stage.
- NG7: Command history, favorites, pinning, or recently-used ordering persisted across reloads.
- NG8: A database migration, an audit table, or durable command state.
- NG9: A new dependency, UI framework, or bundler.
- NG10: File attachments (`parts`) or agent/model/variant overrides.
- NG11: Changing the chat SSE vocabulary, the message pagination contract, or the model injection
  path.
- NG12: Session rename, timeline jump, fork, undo/redo, timestamps/thinking toggles, copy, or
  export commands. These are examples of the TUI-only skips; §9.3 lists the full 25-command skip
  set.

## 3. Requirements

| ID | Requirement |
| --- | --- |
| R1 | The composer palette shows all valid opencode server commands and the Hanse commands, grouped by source, filtered by name/description. |
| R2 | Selecting an opencode command sends its exact name and the raw argument text; Hanse never expands the template or runs a shell block itself. |
| R3 | Hanse commands reuse existing client behavior: `/new` starts a draft, `/editor` opens the IDE, `/compact` uses the existing confirmation and compact POST, `/restart` uses one reusable confirmation and the async restart POST, `/diff` opens the application page Changes, `/help` opens the palette. A command whose template **or arguments** contain a shell block, or whose template is not inspectable (`shell: "unknown"`), requires an explicit confirmation before it is sent. |
| R4 | `GET /commands` returns display metadata only (never `template`), bounded per command and per response, with the merged-response cap actually enforced. |
| R5 | Both routes are human-only; the POST is JSON-only and rejects a present cross-site `Origin`. Agent principals receive `403`. |
| R6 | The send route prevalidates the command name, generates a `messageID`, dispatches the blocking upstream call, returns `202 {accepted, messageID}` after a bounded early-failure window, and delivers output over the existing app SSE. Any failure observed within that window after the upstream request is dispatched is `outcome: "unknown"`, returns a fixed message plus the generated `messageID`, and never restores the draft; a failure after the 202 is logged and reconciled over SSE. |
| R7 | A normal message, an unknown slash text (including `//foo`), and a bare `/` still use the existing text send path; the text sent is the existing trimmed text; the chat SSE and model behavior are unchanged. |
| R8 | The implementation targets opencode v1 only; a missing or changed upstream route never breaks the palette. Source selection is by presence: a present v1 pair -> v1; a v1 pair absent (including partial) with the v2 pair present -> the §6.6 contingency; neither pair present -> Hanse-only commands with a warning. A present v1 pair is never degraded by the v2 rule. |
| R9 | No database migration, no new dependency, no framework, no bundler, and no per-command server handler. |
| R10 | The eventual implementation leaves `npm run lint`, `npm run typecheck`, `npm test`, and `npm run build` green, with unit, HTTP, browser, and live coverage. |

## 4. Decision

**D1 - One palette, two providers, server-merged metadata.** `GET /commands` returns one array with
`source: "opencode"|"hanse"`. The client renders one listbox. The client owns the action map for
Hanse entries; the server owns the display metadata, the collision policy, and the template
whitelist. A client-only registry would split the policy across two languages and require two
fetches; a server-owned action bus would create a generic command execution surface. See §8 and §15.

**D2 - Thin proxy, no reinterpretation.** The POST forwards `{command: name, arguments}` verbatim to
v1 `POST /session/{sid}/command`. Hanse never expands `$ARGUMENTS`, `$1..$N`, or `` !`shell` ``
blocks. opencode owns command semantics; duplicating them would drift and add a shell-execution
surface to Hanse. The command's own `agent`/`model` metadata and the project's command definitions
are applied upstream. See §6.4.

**D3 - Detached `202` with prevalidation and SSE output.** The route validates the name against a
fresh command list, checks the fresh shell classification and the arguments, generates a
`messageID`, starts the blocking upstream call in the background, waits up to 750 ms for an
immediate failure, then returns `202 {accepted:true, sessionID, name, messageID}`. Output arrives
over the existing app SSE. Every failure observed in the early window after dispatch is
`outcome: "unknown"` (§5.6); a later failure is logged and reconciled over SSE; the blocking
alternative is rejected in §15.

**D4 - Scope: six actions, 25 TUI-local skips, two deferrals.** Implement five TUI-local commands:
`/new` (alias `/clear`), `/help`, `/editor` (alias `/ide`), `/compact`, and `/diff`; plus the
Hanse-native `/restart`. Defer `/model` and `/stop` (neither is part of the 30 TUI-local set). Skip
the other 25 TUI-local commands; they duplicate existing Hanse surfaces or are TUI-only. See §9.

**D5 - Never return `template`.** The DTO is built by an explicit whitelist, not by spreading the
upstream object. It carries a derived tri-state `shell: "none" | "present" | "unknown"` instead.
Rationale: the template can be large, contains the project's internal instructions and shell blocks,
and the palette only needs display metadata. `present` and `unknown` both require confirmation. The
expanded prompt still appears in the transcript after execution because opencode owns message
content; that is existing chat behavior, not a new disclosure.

**D6 - Upstream wins name collisions.** If an opencode command has the same name as a Hanse command,
the opencode entry is shown and the Hanse entry is hidden with a `command_shadowed` warning. This
preserves the "proxy opencode commands as-is" principle and never silently changes what a project
command does. A project can rename its command to reclaim the Hanse action. The same resolution
applies to a directly typed token, not only to a palette row. See §10.

**D7 - The client parses the composer; the server receives structured fields.** The client recognizes
a leading `/`, resolves aliases, and treats an unknown slash as ordinary text with a non-blocking
hint. There is no `//` escape: `//foo` is an unknown slash and is sent verbatim as `//foo` (§7.3,
§17 item 3). The server never parses slash text. A known Hanse action is executed client-side; a known
opencode command is posted. See §7.3.

**D8 - Reuse existing actions; add only one reusable confirmation dialog.** `/new` calls
`startDraft` (`assets/chat.js:7203`); `/editor` opens `ideFolderUrl` (`src/http/ui.ts:235-236`);
`/diff` opens the application page Changes (`src/http/chat.ts:215`,
`src/http/application.ts:458-460`); `/compact` uses `contextCompactReasonFor`
(`assets/chat.js:1573`) and then the existing `openContextConfirm` (`assets/chat.js:1549`) and
`compactContext` (`assets/chat.js:1840`); `/restart` uses one chat-level confirm dialog and the
existing async restart route (`src/http/settings.ts:714-730`); `/help` opens the palette. The same
dialog also gates a command with `shell: "present"` or `"unknown"`. No per-command UI. The `/diff`
and `/editor` palette entries are not offered for the master (§7.4).

**D9 - Human-only, JSON-only, and shell-confirmed.** Both routes require a human principal; an agent
principal gets `403` before app probing. The POST requires `content-type: application/json` and
rejects a present cross-site `Origin`. Command templates can execute shell blocks server-side
outside the agent permission flow, so the route must not be agent-callable, and a command with
`shell: "present"` or `"unknown"` is rejected unless the request carries `confirmShell:true` after
an explicit UI confirmation. **`confirmShell` is an accident/UX guard, not proof of human
confirmation**: a scripted or compromised client can set it. The real boundary is human-only auth
plus operator trust in the project's command files; the server check remains defense-in-depth. The
app's opencode server is password-protected, not unauthenticated: the agent host injects
`OPENCODE_SERVER_PASSWORD` (`src/agent/host.ts:135-144`) and the coordinator uses Basic auth
(`src/opencode/endpoint-auth.ts:18-33`). An agent with `bash` runs in the same container and uid, can
read that password from its environment, and can call the loopback API directly. The Hanse route is
therefore not a boundary against the agent; see §11.

**D10 - v1-only now, with an isolated upstream module and a phase-1 probe.** The pin is one version
controlled by the image (`Dockerfile:6,42`). The primary path is v1. The §17 item 7 version-strategy
decision defines the contingency consistently with §5.2, §6.5, and §6.6:
- v1 pair present -> v1.
- v1 pair absent, v2 pair present -> the v2 adapter in §6.6.
- neither pair -> Hanse-only commands with a warning.
- partial v1 pair (only one route) -> treat the v1 pair as absent and try v2; otherwise Hanse-only.
Keep `listCommands` and `runSessionCommand` in `src/opencode/client.ts` so the contingency is
localized. If the 1.19.3 probe finds a different field shape, the whitelist handles the difference
when possible; otherwise the source degrades (to Hanse-only or `unavailable`, per §6.5) with a
warning. A field-shape difference does not by itself force a full degrade.

## 5. Wire contract

### 5.1 Routes

All routes are under `/api/apps/:app` and accept the existing optional `?project=<PROJECT_ID>`
disambiguator. Authentication order: `401` missing principal, `403` non-human (and cross-site), `405`
wrong method, then app/session resolution. A `GET` is best-effort; a `POST` is an explicit action.

| Method | Path | Purpose | Success |
| --- | --- | --- | --- |
| GET | `/api/apps/:app/commands` | Merged command list | `200 {commands, sources, warnings}` |
| POST | `/api/apps/:app/sessions/:sid/commands` | Execute one opencode command | `202 {accepted, sessionID, name, messageID}` |

The GET is app-scoped because the command list is per instance/project, not per session. The POST is
session-scoped because the command runs in a session, matching the existing `/messages` and
`/compact` route shapes (`src/http/chat.ts:537`, `src/http/context.ts:15-16`).

### 5.2 `GET /api/apps/:app/commands`

The route:

1. Resolves the app with `findApp(deps, projectParam(request), appKey)`
   (`src/http/apps.ts:14-29`; same pattern as `src/http/context.ts:89-92`). Unknown app -> `404
   unknown_app`. **Before any manager, `stopped`, or `unconfigured` branch**, check the durable
   deletion markers: if `found.app.deleting === true` or `found.project.deleting === true`
   (`src/registry/index.ts:27`; project marker as in `src/http/handler.ts:675-677`), return `409
   deletion_pending` and do not fetch or return a command list. This check comes first because a
   deleting app may have no manager (`unconfigured`) or no running instance (`stopped`), so a later
   `DeletionPendingError` from `manager.ensure` (`src/opencode/manager.ts:65-73`) would never be
   reached; the explicit marker check closes that gap.
2. If `deps.manager` is undefined, skip the upstream entirely and return the Hanse-only list with
   `sources.opencode = "unconfigured"` and the warning `agent_runtime_unconfigured`. If the manager
   exists but `deps.manager.isRunning(app.id)` is false (`src/opencode/manager.ts:799-801`), return
   Hanse-only with `sources.opencode = "stopped"` and `agent_stopped`; it does **not** start a
    stopped app just to list commands, mirroring the no-start invariant of the context GET
    (`src/http/context.ts:94-109`). If it is running, call `manager.ensure` (idempotent) and fetch
   `GET /command` with a bounded timeout. If `ensure` reports a stopped instance, use `stopped`; any
   other `ensure`/list failure uses `unavailable` with `commands_unavailable`; a
   `DeletionPendingError` maps to `409 deletion_pending`.
3. Merges Hanse registry entries with the opencode entries, applies the collision policy, and
   whitelists the DTO fields.
4. Enforces the merged response cap: after building the whitelisted list, drop trailing opencode
   entries until the serialized response is at most 1 MiB; if any were dropped, add **one**
   `command_cap_reached` summary warning for the merged cap. Hanse entries are never dropped.
   `command_dropped` is not used for this cap; it is reserved for invalid/duplicate entries and the
   500-per-list cap. Log the dropped count; warnings remain capped at 20.
5. Returns `200` even when the upstream is unavailable; the `sources` and `warnings` fields report
   the degradation. Only an unknown/deleting app is a non-200.

```json
{
  "commands": [
    {
      "name": "new",
      "source": "hanse",
      "action": "new",
      "description": "Start a new session",
      "aliases": ["clear"],
      "hints": [],
      "shell": "none",
      "available": true
    },
    {
      "name": "init",
      "source": "opencode",
      "origin": "command",
      "description": "Create or update AGENTS.md",
      "agent": "build",
      "model": "deepseek/deepseek-flash",
      "subtask": false,
      "hints": ["[description]"],
      "shell": "none",
      "available": true
    }
  ],
  "sources": { "hanse": "ok", "opencode": "ok" },
  "warnings": []
}
```

Fields:

| Field | Applies to | Meaning |
| --- | --- | --- |
| `name` | both | Canonical token without the leading slash; exact-match key for send. |
| `source` | both | `opencode` or `hanse`. Only `opencode` entries can be posted. |
| `action` | hanse | `new`, `help`, `editor`, `compact`, `restart`, `diff`. Unknown actions are shown disabled. |
| `aliases` | hanse | Additional tokens; never posted, always mapped to the canonical action. |
| `origin` | opencode | `command`, `mcp`, or `skill`; display badge only. |
| `description` | both | Bounded to 500 characters, control characters stripped. |
| `agent`, `model`, `subtask` | opencode | Display metadata only; not used by the send route. |
| `hints` | both | Argument hints; at most 10 entries, 200 characters each. |
| `shell` | both | `none`, `present`, or `unknown`. `present` means the v1 template associated with this entry matches the upstream shell pattern anywhere; `none` means a string template has no match; `unknown` means the template is absent or is not a string (MCP Promise, v2 reduced shape). Hanse commands are always `none`. `present` and `unknown` both require confirmation on send. This GET value is display metadata only; the POST re-derives it from a fresh list (see §5.3). |
| `available` | both | `false` disables the row; defaults to `true`. Used for the master's `/editor` and `/diff`. |
| `unavailableReason` | both | Bounded reason shown when `available` is `false`; never a template. |
| `template` | neither | **Never returned.** Omitted from the DTO; the whitelist is explicit, not a spread. |

`sources`:

- `hanse: "ok"` always (the registry is static and in-process).
- `opencode: "ok" | "stopped" | "unconfigured" | "unavailable"`.
  - `stopped`: the app is known and the manager exists, but it has no running instance. Hanse
    commands still work, and the client refetches after `stream.ready` (the SSE route ensures the
    app; `src/http/prompts.ts:650-779`).
  - `unconfigured`: `deps.manager` is undefined, so there is no agent runtime to query. This is
    distinct from `stopped` and gets a different message.
  - `unavailable`: the instance is running but `ensure` failed, or `GET /command` failed, timed
    out, was over the cap, or returned a non-array. Hanse commands still work.

`warnings` is an array of `{code, message?, command?}`, capped at 20, with codes
`agent_stopped`, `agent_runtime_unconfigured`, `commands_unavailable`, `command_shadowed`,
`command_dropped`, and `command_cap_reached`. Warnings are display data, not HTTP errors.
`command_cap_reached` is the single summary warning for the merged 1 MiB response cap.
`command_dropped` covers an invalid or duplicate upstream entry and entries beyond the 500-per-list
cap; it is never used for the merged 1 MiB cap.

Response headers include `cache-control: no-store`.

### 5.3 `POST /api/apps/:app/sessions/:sid/commands`

Request:

```json
{ "name": "review", "arguments": "src/http", "confirmShell": false }
```

- `name`: required, canonical opencode command name (not a Hanse action, not an alias).
- `arguments`: optional string, default `""`, forwarded verbatim. It is the raw text after the
  command name, including newlines.
- `confirmShell`: optional boolean, default `false`. The client sets it to `true` only after the
  operator confirms a command whose `shell` is `present` or `unknown`. It is a Hanse-side
  accident/UX gate, never forwarded upstream, and never proof of human confirmation (§11).

The route:

1. Resolves the app with `findApp(deps, projectParam(request), appKey)`; unknown -> `404
   unknown_app`. **Before any manager branch**, check `found.app.deleting === true` or
   `found.project.deleting === true` (`src/registry/index.ts:27`) and return `409 deletion_pending`;
   otherwise a deleting app with no runtime would reach the `unconfigured`/`agent_unavailable`
   branch instead. A later `DeletionPendingError` raised by `manager.ensure` below still maps to
   `409 deletion_pending`; the explicit marker check is the earlier, complete gate. The session id
   is taken from the path and is **not prevalidated**; a missing session is classified like any
   post-dispatch failure in step 9.
2. Parses JSON; malformed -> `400 invalid_json`; non-JSON content type -> `415
   unsupported_media_type`.
3. Validates `name` shape (`^[A-Za-z0-9][A-Za-z0-9._:/-]{0,127}$`, no whitespace/control chars) and
   `arguments` UTF-8 size (<= 32 KiB). Empty/missing name -> `400 empty_command`; bad shape ->
   `400 invalid_command`; oversized arguments -> `400 command_too_large`.
4. Calls `manager.ensure` (explicit action, like chat send). Failure -> `502 agent_unavailable` or a
   mapped lifecycle error; `409 deletion_pending`; `503 agent_runtime_unconfigured` if the runtime is
   not configured.
5. Fetches a **fresh** opencode command list on every POST (10 s timeout, 4 MiB cap). **The 5 s
   summary cache is not consulted here**; it exists only for GET display metadata. If the list is
   unavailable -> `502 commands_unavailable` and no dispatch. If the name is absent from the first
   fresh list, fetch once more (fresh) before `404 command_not_found`; a cache is never a fallback.
6. Derives the shell classification from the **fresh** entry and the arguments:
   - `detectShell(entry.template)`: a string matching the exact upstream pattern anywhere ->
     `present`; a string with no match -> `none`; absent or non-string -> `unknown`.
   - `containsShellBlock(arguments)` with the same pattern: a match makes the effective
     classification `present`, because upstream substitutes `$ARGUMENTS`/`$1..$N` (and appends
     arguments when there is no placeholder) before executing blocks.
   - If the effective classification is `present` or `unknown` and the body does not carry
     `confirmShell:true` -> `400 shell_confirmation_required`; no dispatch. `unknown` requires the
     same confirmation as `present`; this is precautionary, not a safety claim.
7. Generates `messageID = "msg_" + randomUUID().replaceAll("-", "")`, the same format as the chat
   async send (`src/http/chat.ts:649`).
8. Marks `dispatchStarted = true` and starts the upstream `POST /session/{sid}/command` with
   `{command: name, arguments, messageID}` and a 30 min background timeout.
9. Waits up to 750 ms for an immediate failure. **Any** failure observed within that window after
   the upstream request is dispatched is `502 command_failed` with `outcome: "unknown"`, a fixed
   message, the generated `messageID`, `sessionID`, and `name`. This includes a transport failure
   (status 0), an upstream
   404, and a 5xx; the client cannot prove the request did not run, so it must not be treated as
   `not_sent`. Never return or log the upstream body or `error.message`; they can contain the
   expanded template, prompt, or shell output (§5.6, §11, §13).
10. Otherwise returns `202`.

Success:

```json
{
  "accepted": true,
  "sessionID": "ses_...",
  "name": "review",
  "messageID": "msg_..."
}
```

The 202 means **accepted for dispatch**, not completed. The command's turn output, including the
expanded user message and assistant parts, arrives over `GET /api/apps/:app/events`
(`src/http/prompts.ts:650-779`). The client keys its optimistic row by `messageID`.

The route never returns the upstream `{info, parts}` body, the template, the expanded prompt, or an
upstream error body.

### 5.4 Caps

| Item | Cap |
| --- | --- |
| Request body | Existing global 64 KiB (`src/http/server.ts:26`, `:33-41`) |
| Command arguments | 32 KiB raw UTF-8 (same as the async message cap, `src/http/chat.ts:646-648`); JSON escaping may hit the 64 KiB body cap first -> 413 |
| Command name | 128 characters, shape as above |
| Upstream command list | 4 MiB / 10 s |
| Commands per list | 500; extras dropped with `command_dropped` |
| Description | 500 characters |
| Hints | 10 entries, 200 characters each |
| Merged response | 1 MiB, **enforced** by dropping trailing opencode entries and, when entries are dropped, adding one `command_cap_reached` summary; Hanse entries are never dropped |
| Early-failure window | 750 ms |
| Background command | 30 min, then abort and log `commands.send.timeout` (see §12) |
| Server summary cache | 5 s per endpoint, **GET display metadata only**; never consulted by POST, never contains templates |
| Client list cache | 30 s; invalidated on a new `streamID`, `command_not_found`, or app change |

### 5.5 Caching

- The server caches only the whitelisted summaries (name, description, origin, agent, model, hints,
  `shell`, `available`, `unavailableReason`) for 5 s per endpoint and serves them only to GET. It
  never caches templates. POST always fetches a fresh list; a POST name miss triggers one more
  fresh fetch before `command_not_found`.
- The client caches the merged list for 30 s. It refetches on first palette open, after a new
  `streamID` (reconnect or instance restart), and after `404 command_not_found`. A refetch preserves
  the open palette, the filter, and the active row when possible.
- The GET is `no-store`; there is no shared HTTP cache.

### 5.6 Error mapping

Error bodies remain `{error, code}`, with `outcome` additive for a dispatch result. **Fixed
messages:** every code maps to a fixed, user-safe message. Never return `OpencodeHttpError.message`
or `bodyExcerpt`; they can contain the template, the expanded prompt, or shell output. Logs carry
code/status/byte counts/durations only (§13).

| Status | Code | Outcome | When |
| --- | --- | --- | --- |
| 400 | `invalid_json` | `not_sent` | Malformed JSON body |
| 400 | `empty_command` | `not_sent` | Missing/empty name |
| 400 | `invalid_command` | `not_sent` | Name fails the shape check |
| 400 | `command_too_large` | `not_sent` | Arguments exceed 32 KiB |
| 400 | `shell_confirmation_required` | `not_sent` | Effective shell is `present` or `unknown` and `confirmShell` is not `true` |
| 401 | `sign_in_required` | `not_sent` | No principal |
| 403 | `human_only` | `not_sent` | Principal is not human |
| 403 | `cross_site` | `not_sent` | A present `Origin` does not match `Host` |
| 404 | `unknown_app` | `not_sent` | App not found (with `?project=`, the wrong project) |
| 404 | `command_not_found` | `not_sent` | Name absent from the fresh opencode list |
| 405 | `method_not_allowed` | `not_sent` | Wrong method |
| 409 | `deletion_pending` | `not_sent` | App has a durable deletion marker |
| 413 | `payload_too_large` | `not_sent` | Global body cap |
| 415 | `unsupported_media_type` | `not_sent` | POST body is not JSON |
| 502 | `agent_unavailable` | `not_sent` | Instance start/lifecycle failure before dispatch |
| 502 | `commands_unavailable` | `not_sent` | Upstream command list unavailable, or the send route is known absent from the phase-1 capability flag, before dispatch |
| 502 | `command_failed` | `unknown` | Any upstream failure observed within the early window after the request is dispatched, including status 0, 404, and 5xx; later failures are logged, not returned |
| 503 | `agent_runtime_unconfigured` | `not_sent` | `deps.manager` is undefined (POST only; the GET degrades to Hanse-only) |

There is deliberately **no `session_not_found` code on this route**: the session id is not
prevalidated, and a post-dispatch upstream 404 is `502 command_failed` with `outcome: "unknown"`
until a phase-1 probe proves an unambiguous, non-executing session check. A `502 command_failed`
response includes the fixed message, the generated `messageID`, the `sessionID`, and the `name`; the
client must not restore the draft. A transport failure after the 202 is logged, never returned; the
SSE transcript is authoritative.

## 6. Upstream API and version adapter

### 6.1 v1 contract used

| Surface | Request | Response |
| --- | --- | --- |
| `GET /command` | no query; the server cwd is the app directory (`src/agent/host.ts:295-299`) | `Command[]` |
| `POST /session/{sessionID}/command` | `{command, arguments, messageID}` | `200 {info, parts}` (potentially blocking) |

`Command`: `{name, description?, agent?, model?, source?: "command"|"mcp"|"skill", template,
subtask?, hints: string[]}`. `template` is a string for custom commands, but an MCP prompt supplies a
Promise, so the HTTP JSON may omit it or produce a non-string (§1.2). `model` is normalized to a
display string if it is a string or a `{providerID, modelID}` object; otherwise omitted. `source`
defaults to `"command"` for display.

Shell semantics: after `$ARGUMENTS`/`$1..$N` substitution (and argument append when there is no
placeholder), the upstream matches
``/!`([^`]+)`/g`` anywhere in the template and runs each block. A line that starts (after optional
whitespace) with `!` followed by a backtick is a **subset** of this grammar and may be used only as
a diagnostic signal; it is not the detector.

### 6.2 Version matrix

| Surface | 1.18.35 (probed) | 1.19.3 (pin; verify) | 2.1.4 (contrast) |
| --- | --- | --- | --- |
| `GET /command` | present, `Command[]` | **verify** | absent; `GET /api/command` returns `{name, description?}` only |
| `POST /session/{id}/command` | present, body above, `200`, blocking | **verify** | absent |
| `GET /api/command` | present, richer `CommandV2Info` | **verify** | present |
| `POST /api/session/{id}/command` | absent | **verify** | present, `{name, text, files?, agents?, skills?, delivery?}`, `204`, experimental |

The v1 list is the only pair that is complete in 1.18.35. `/api/command` is not used without a
matching v2 send route. At 1.19.3 the v2 list type may include a string `template`; the §6.6
contingency still treats the shell as unknown, because the reduced v2 contract cannot prove the
absence of a shell block. The 2.1.4 contrast is the reduced list shape.

### 6.3 Client functions

Add to `src/opencode/client.ts`, reusing the private `getJson`, `requestResponse`, and `readCapped`
helpers (`src/opencode/client.ts:169-179`, `:435-484`):

```ts
export interface OpencodeCommand {
  name: string;
  description?: string;
  agent?: string;
  model?: string | { providerID: string; modelID: string };
  source?: "command" | "mcp" | "skill";
  /**
   * Optional on purpose: MCP prompts expose a Promise and the v2 reduced shape omits it.
   * The runtime whitelist treats any non-string value as absent and derives shell "unknown".
   */
  template?: string;
  subtask?: boolean;
  hints?: string[];
}

export function listCommands(endpoint: string, options?: OpencodeRequestOptions):
  Promise<OpencodeCommand[]>;

export function runSessionCommand(
  endpoint: string,
  sessionId: string,
  name: string,
  args: string,
  messageID: string,
  options?: { signal?: AbortSignal; timeoutMs?: number },
): Promise<void>;
```

Add to `src/opencode/commands.ts`:

```ts
type ShellPresence = "none" | "present" | "unknown";
function containsShellBlock(text: string): boolean; // exact /!`([^`]+)`/g, non-global copy
function detectShell(template: unknown): ShellPresence; // non-string -> "unknown"
```

`containsShellBlock` must use a non-global copy of the pattern (or reset `lastIndex`) so repeated
calls are deterministic. `detectShell` returns `unknown` for any non-string or absent template,
including an MCP Promise that serialized as `{}` and a v2 entry with no template. It never treats a
line-start match as the only signal; the exact upstream pattern is the gate.

`listCommands` uses a 4 MiB cap and a 10 s timeout, validates that the body is an array, and never
logs templates. `runSessionCommand` posts the exact body, uses a 30 min default timeout, and drains
at most 1 MiB of the response; the body is not needed, and an oversized response is not an error
because the turn already ran. `OpencodeHttpError` already carries `status` and `code`
(`src/opencode/client.ts:123-137`) and is used for mapping, but its `message`/`bodyExcerpt` are
never returned to the client (§11).

### 6.4 Forwarding rules

- Forward `command` exactly as selected; do not lowercase, trim, or expand it.
- Forward `arguments` exactly as typed; do not split, shell-quote, interpolate, or parse `$`.
- Forward the server-generated `messageID`.
- **Scan `arguments` for the shell pattern before dispatch.** If it matches, treat the effective
  shell classification as `present` and require `confirmShell:true`. This is necessary because the
  upstream substitutes `$ARGUMENTS`/`$1..$N` (and appends arguments when there is no placeholder)
  before it executes shell blocks.
- Do **not** forward `confirmShell`; it is a Hanse-side gate only.
- Do **not** forward `agent`, `model`, `variant`, or `parts`. The command's own metadata and the
  project's definitions apply upstream; Hanse has no attachment UI and does not expose variants.
- Do **not** pass a `directory` or `workspace` query. The instance already resolves the project
  commands from `spec.appDir`.
- The POST accepts only `source: "opencode"` names. Hanse action names are never sent upstream; a
  stale client that posts `help` gets `404 command_not_found`.

### 6.5 Capability probe and fallback

Phase 1 runs `opencode serve` at the pinned 1.19.3 and checks `/doc` plus live requests for:

1. `GET /command` shape, including `template` (string vs Promise/non-string for MCP), `hints`, and
   `source`.
2. `GET /command` **with no `directory`/`workspace` query** (the exact Hanse v1 call, §6.4): verify
   it returns the app's project commands, not a global/default list; record what happens if the
   instance cwd is not the app dir. The Hanse v1 call never passes a host directory; the v2
   `location[directory]` form is probed separately in item 8.
3. `POST /session/{sid}/command` body type for `arguments`, whether `messageID` is honored, and
   whether the response blocks.
4. Whether a client disconnect aborts the turn.
5. Whether `GET /api/command` and `POST /api/session/{sid}/command` exist and are non-blocking.
6. A missing session and an unknown command: record the exact status/body and whether any turn
   starts. Do not assume a 404 means "session missing".
7. Shell grammar: an inline block such as ``prefix !`cmd` ``, a line-start block, and an
   argument-injected block through a `$ARGUMENTS` template.
8. For v2: the `GET /api/command` query form (`location[directory]` vs none) and whether the send
   `text` is the raw arguments or the full `/name args`.

Fallback, regardless of the probe result:

- v1 pair present -> use v1.
- v1 pair absent and v2 pair present -> §6.6 adapter.
- Neither pair present -> Hanse-only commands plus a warning. Do not bump or downgrade the pin
  inside this stage.
- Partial v1 pair (one route missing) -> treat the v1 pair as absent and try v2; otherwise
  Hanse-only.
- If the v1 pair exists but a field shape differs, the whitelist handles the difference or the
  source degrades.
- If the v2 adapter's list route fails, `sources.opencode = "unavailable"`. If the v2 send route is
  known absent, POST `502 commands_unavailable` before dispatch; an unexpected send failure after
  dispatch is `502 command_failed` with `outcome:"unknown"`.

### 6.6 v2 contingency (only when the v1 pair is absent and the v2 pair is present)

This is the §17 item 7 owner decision, not the primary path. It is implemented only if phase 1 finds both
v1 command routes absent (404/405) and both v2 command routes present. If both pairs are present,
v1 wins.

- **List.** `GET /api/command`. Probe no query and `?location[directory]=<appDir>`; use the form
  that returns the app's list. The `WorkspaceRoutingQuery` is the likely `location[directory]` form;
  if the instance cwd already scopes the list, do not add a query. The adapter accepts the reduced
  shape `{name, description?}` (the 2.1.4 contrast). Map fields as follows:
  - `origin`: `"command"` (the v2 list has no `source`; no MCP/Skill badge is claimed).
  - `hints`: `[]` (the reduced shape has none).
  - `agent`, `model`: use them only if present and display-safe; otherwise omit.
  - `shell`: `"unknown"` for every v2 command. The adapter does not use a v2 template field as a
    safety signal in this stage; even if the pinned shape exposes one, the reduced contingency
    cannot prove the absence of a shell block.
- **Send.** `POST /api/session/{id}/command` with `{name, text}` and no `messageID` (v2 does not
  accept one). Define `text` as the **raw argument text only**, not `/name args`; `name` carries the
  command. Phase 1 verifies this by running a command with a known argument and inspecting the
  expanded prompt. If v2 expects the full `/name args`, adapt only inside `runSessionCommandV2` and
  record the probe result; the Hanse wire contract does not change. The upstream returns `204`.
- **Confirmation.** Every v2 command is `shell: "unknown"`, so the client shows the precautionary
  confirmation and sends `confirmShell:true`. This is not a safety claim; the v2 list cannot prove
  the absence of a shell block.
- **Response and reconciliation.** The Hanse POST still returns its own `202` after dispatch; the v2
  upstream call is non-blocking. Because v2 returns `204` and does not echo a message ID, the
  Hanse-generated `messageID` is for logs only; the client does **not** rekey an optimistic row by
  it and hydrates from the next snapshot/SSE (the existing "messageID ignored" fallback in §7.5).
  The transcript is authoritative.
- **Timeout.** The 30 min background cap applies to the v1 blocking route; the v2 call returns
  immediately after acceptance, so only the Hanse early window matters.

## 7. Client architecture and UX

### 7.1 Modules and state

- `assets/chat-commands.js` (new): pure helpers, unit-testable with no DOM:
  `parseComposerCommand(text)`, `matchCommand(commands, token)`, `filterCommands(commands, query)`,
  `groupCommands(commands)`, `commandLine(name, args)`, and
  `shellRequiresConfirmation(shell)`.
- `assets/chat.js`: the palette DOM, fetch/cache, keyboard handling, the action map, and the send
  integration. It keeps the existing no-bundler ESM structure (`src/http/chat.ts:408`).
- State: `commands`, `commandsStatus`, `commandsFetchedAt`, `commandsShadowed`, `paletteOpen`,
  `paletteFilter`, `paletteActive`, and `paletteRows`. The palette is not persisted.
- **Integration point (one chosen design).** Do not extract a shared `submitTurn`. Add one early
  branch inside `sendPrompt` (`assets/chat.js:7383`) that calls `dispatchComposerDraft()`. The branch
  is **not above the guards**: it sits after the existing `acceptanceInFlight()`/`acceptanceUnknown()`
  guard (`assets/chat.js:7385-7389`), and `dispatchComposerDraft()` re-checks those guards first,
  then applies the action-aware pending-lock policy from §7.3: server commands and `/new`,
  `/compact`, `/restart` return blocked with the existing focus-and-message behavior; `/help`,
  `/editor`, `/diff` proceed. The ordinary text path keeps its unconditional
  `activePromptEntries()` block unchanged. If the branch returns `"handled"`, `sendPrompt` returns;
  otherwise the existing text path runs unchanged, including the existing trimmed `text` and
  acceptance plumbing. The command branch reuses the existing `acceptanceFor`, `rekeyAcceptanceRow`,
  `removeAcceptanceRow`, and unknown-acceptance helpers rather than duplicating them. This is the
  smallest change to the most load-bearing path.

### 7.2 Palette

- Placement: an in-flow listbox directly above the composer, after the prompt dock and queue strip,
  inside the thread section. It is not a modal and does not trap focus. It scrolls internally with
  a `min(50dvh, 24rem)` cap; the thread remains the only page scroll owner.
- Trigger: typing `/` when the composer is empty (or when the selection covers the whole draft), or
  pressing the new single "Commands" icon button in the composer row. The button exists for touch
  and discoverability; it is not a per-command UI.
- Rows: `/name` in mono, description, argument hints, and badges `Hanse`, `MCP`, `Skill`, `Shell`,
  or `Shell unknown`. A `Shell` or `Shell unknown` row also says that an explicit confirmation is
  required before it runs. A shadowed Hanse entry is hidden; the palette shows the
  `command_shadowed` footer hint instead of a Hanse row. A row with `available: false` is disabled,
  stays visible, and shows its `unavailableReason`; it carries `aria-disabled="true"` (and
  `aria-selected="false"`), and Enter/Tab does not activate it. The master's `/editor` and `/diff`
  use this. Group headers `Hanse` and `Application commands`. Hanse entries appear in registry
  order; opencode entries are sorted by name. Render at most 200 rows; if more match, show
  "Refine your search".
- Keyboard: `ArrowDown`/`ArrowUp` move, `Home`/`End` jump, `Enter` or `Tab` inserts the canonical
  `/name ` into the composer and closes the palette, `Escape` closes and returns focus to the
  composer. Arrow/Home/End navigation **skips disabled rows**; Enter/Tab does not activate a
  disabled row (it stays in the palette). Selection never executes. Execution is the normal composer
  submit, so `/restart` and `/compact` cannot run from a stray Enter in the palette.
- **Keydown precedence.** The existing Enter handler (`assets/chat.js:7675-7689`) is unconditional;
  phase 2 checks `paletteOpen` first. When the palette is open: `Enter` and `Tab` insert the active
  row and do **not** submit (a disabled active row is not inserted); `ArrowDown`/`ArrowUp`/`Home`/`End`
  move and skip disabled rows; `Escape` closes; all other keys keep editing. When the palette is
  closed: `Enter` submits as today, `Shift+Enter` inserts a newline. A form submit while the palette
  is open also inserts the active row and does not execute, so a click on Send cannot bypass the
  insert-only rule.
- Filter: case-insensitive substring over name, aliases, and description. The submitted token must
  match exactly (case-sensitive); the palette always inserts the canonical name.
- Empty states: no application commands -> "No application commands"; `unavailable` -> "Application
  commands are unavailable; Hanse commands still work"; `stopped` -> "Application commands load when
  the agent starts"; `unconfigured` -> "No agent runtime is configured; Hanse commands still work";
  no matches -> "No matching commands".
- The palette rebuilds on filter changes only; it does not replace the feed.

### 7.3 Composer parsing and submit

`sendPrompt` (`assets/chat.js:7383-7529`) gets one early branch (§7.1), placed after the acceptance
guards and before the text path; it cannot start a command while a text send is in flight or a
pending prompt blocks that command class. The parser uses the **trimmed** draft, matching the
existing send (`assets/chat.js:7390`):

```text
raw = promptEl.value
trimmed = raw.trim()
if trimmed.length === 0: focus; return
if not trimmed.startsWith("/"): sendText(trimmed)          // existing trimmed send
match = /^\/([^\s]+)(?:\s+([\s\S]*))?$/.exec(trimmed)
if match is null: sendText(trimmed) + unknown hint         // a bare "/"
token = match[1]; args = match[2] ?? ""
```

There is **no `//` escape**. `//foo` matches with token `/foo`, which is not a command name; it is
sent verbatim as `//foo` with the same unknown-command hint. This preserves today's text exactly and
cannot turn `//help` into `/help` or accidentally execute a command.

Resolution order:

1. Look up `token` in the current merged list, by canonical name or Hanse alias, exactly and
   case-sensitively.
2. If the entry is `source: "opencode"` -> `sendServerCommand(entry.name, args, entry.shell)`.
3. If the entry is `source: "hanse"` and `available` is not `false` and its `action` is known -> run
   the client action. If `available` is `false` -> show `unavailableReason` and do not execute or
   send the text.
4. If the list is unavailable, fall back to the client `HANSE_ACTIONS` map for canonical names and
   aliases; this keeps all six Hanse commands working without a fetch. The fallback also checks the
   master flag and disables `/editor` and `/diff` there.
5. Otherwise -> send the trimmed text literally and show a non-blocking hint "Unknown command; sent
   as a message." This preserves today's behavior (`src/http/chat.ts:642-657`) and avoids blocking a
   legitimate message that starts with `/`.

**Case, whitespace, and aliases.** Command names and aliases are exact and case-sensitive for
execution. `/Help` is unknown and is sent literally; the palette filter is case-insensitive. Leading
and trailing whitespace is ignored for recognition because the draft is trimmed, exactly as the
existing send trims. A non-command message is sent as the trimmed text, never the untrimmed draft.
Multi-line arguments after the command token are preserved.

**Direct-typed shadowing.** A directly typed token resolves through the same merged list as the
palette. If an opencode command shadows a Hanse name or alias, the opencode entry wins for that
token. The palette shows the `command_shadowed` footer hint; a directly typed token shows the same
message through a non-blocking `showToast`. For example, if an opencode `help` exists, typing
`/help` posts the opencode command and never opens the Hanse palette; the hint explains why. When
the list is unavailable, the fallback map is used and shadow information is unavailable; that is
the documented degradation.

**`sendServerCommand(entry.name, args, shell)`**:

- `shell` is `"present"` or `"unknown"` -> open the reusable confirm dialog ("Run `/name`? This
  command contains shell blocks, or its shell usage cannot be verified, and it runs on the server
  outside the agent permission flow."), and only on confirmation posts with `confirmShell:true`.
  A cancelled confirmation restores the draft and sends nothing.
- `shell` is `"none"` -> post without the extra confirmation.
- If the server answers `400 shell_confirmation_required` (a stale list or an argument-injected
  block), the client shows the confirmation once and retries with `confirmShell:true`; a second 400
  is shown as an error, not looped. When the 400 follows a POST that already inserted the optimistic
  row, the retry **reuses that same row and its acceptance state**: it is not removed and reinserted,
  and no second row is created. The retry goes through the same normal POST/202 flow, so it receives
  a fresh server-generated `messageID` and rekeys the existing row with it. A confirmation taken
  before the first POST (the known `present`/`unknown` path) still results in exactly one row.
- The optimistic row and 202/unknown handling are in §7.5.

**Pending-question lock.** When `activePromptEntries().length > 0` for the active session:
- Server commands and the session actions `/new`, `/compact`, and `/restart` are **blocked**. The
  client focuses the pending request and shows "Answer the pending request first." This prevents a
  command from silently bypassing the existing lock at `assets/chat.js:7386-7389`.
- Navigation actions `/help`, `/editor`, and `/diff` remain available; they do not send a turn or
  mutate session state.
- The existing New session **button** is unchanged; only the `/new` command path is stricter.
- A normal text message keeps the existing block-and-focus behavior.

Hanse actions that take no arguments reject extra text with an inline hint; `/help` accepts one
optional command name used as the filter.

### 7.4 Hanse actions

| Action | Behavior |
| --- | --- |
| `new` | Blocked while a pending question/permission exists (§7.3). Otherwise `startDraft({focus:true})` (`assets/chat.js:7203`). Does not abort an active turn; the old session stays in the rail, matching the New session button. |
| `help` | Opens the palette with no filter (or filtered to the optional name) and focuses it. No separate help page. Available during a pending question. |
| `editor` | Opens `data-ide-url` in a new tab. The server adds `data-ide-url="${ideFolderUrl(folder)}"` and `data-app-url="${appHref}"` to `#chat-shell` (`src/http/chat.ts:410`), built by `src/http/ui.ts:235-236` and `src/http/chat.ts:215`; if `window.open` returns null, navigate the current tab with `location.assign` and show "Opened in this tab because the popup was blocked." The command is not offered for the master (`available:false`, "The master workspace is coordinator-managed; the existing IDE link is unchanged.") because the master workspace is coordinator-managed and its app directory is read-only inside the container. The existing operator topbar/rail IDE link is unchanged and out of scope for this stage; only the palette command entry is disabled, and the reason does not imply the link is blocked. |
| `diff` | Opens the application page Changes in a new tab: `${data-app-url}#changes-title`, using the `appHref` value (`src/http/chat.ts:215`). The section is `id="changes-card"` and the heading is `id="changes-title"` (`src/http/application.ts:458-460`); the heading is the stable anchor. It shows the **worktree**, not a session-only diff; the inline feed diffs remain the per-edit view. Popup fallback as for `editor`. Disabled for the master with `available:false` ("The master has no worktree view."), because the master application page renders `master-panel`, not `changes-card`. |
| `compact` | Blocked while a pending question/permission exists. Requires a selected session; in a draft, use `contextCompactReasonFor(null)` ("Start a session to compact."). Read `contextCompactReasonFor(currentSnapshot)` (`assets/chat.js:1573`) first: if it returns a reason, show that exact reason via `showToast(reason, "error")` and do **not** open the context confirm. The toast primitive only styles the existing `success` and `error` tones (`assets/chat.js:1099-1119`; `src/http/styles.css:1963-1985`); a `warning` tone would render with the success check icon, so this stage reuses `error` for blocked-action feedback rather than adding a tone. The reason text is unchanged. If the reason is null: `setContext(true,false)` (`assets/chat.js:7555`), `openContextConfirm()`, then verify it actually opened. `openContextConfirm` returns no status (`undefined`) and returns silently when the button is disabled (`assets/chat.js:1549-1553`), so re-read `contextCompactReasonFor(currentSnapshot)`; if that now returns a reason, show that exact reason, and if the confirm is still hidden/disabled, show the fixed "Compaction is unavailable." instead of returning silently. Focus the existing confirm button when it is open. The actual POST remains `compactContext` (`assets/chat.js:1840`). |
| `restart` | Blocked while a pending question/permission exists. Opens one reusable chat confirm dialog: "Restart `<app>`? An active turn will be interrupted." On confirm, calls `POST /api/apps/:app/restart?project=<PROJECT_ID>&async=1` with JSON. Show "Restarting…" and rely on the existing runtime polling. `409 restart_in_progress` -> "A restart is already in progress." |

The confirm dialog is one component reused for destructive Hanse actions (`/restart`, and `/stop` if
it is added later) and for a `shell: "present"`/`"unknown"` command. It uses the existing dialog
primitive with `role="dialog"`, `aria-modal="true"`, a labelled title, a focus trap, Escape to
close, and focus restoration to the composer (or the triggering row). It is not a per-command form.

### 7.5 Detached acceptance and SSE

- For an opencode command, the client confirms a `present`/`unknown` shell first (no session is
  created if the operator cancels), then creates the session lazily exactly like `sendPrompt`
  (`ensureSession`, `assets/chat.js:7252`), inserts one optimistic row showing `/name args`, and
  posts `{name, arguments, confirmShell}`. A cancelled confirmation restores the draft and sends
  nothing. **Stale-list exception:** if the POST returns `400 shell_confirmation_required`, the row
  already exists; the single confirm-and-retry path in §7.3 reuses that row, never inserting a
  second one, and the retry's 202 rekeys the same row with its newly generated `messageID`.
- On `202`, rekey the row by the returned `messageID`; the existing acceptance plumbing does this
  for text sends (`assets/chat.js:7438-7460`). The upstream user message carries the same ID and the
  expanded prompt; when the snapshot/event arrives, the optimistic row is reconciled and the feed
  shows what the agent actually received. The client does not try to render the template itself.
  If the phase-1 probe shows that the command route ignores `messageID`, do not insert an optimistic
  command row; hydrate after the next event/snapshot instead (a small, local fallback).
- **Pre-dispatch vs post-dispatch.** A pre-dispatch error (validation, `405`, `404 unknown_app`,
  `409 deletion_pending`, `404 command_not_found`, `415`, `502 commands_unavailable`, `503`) removes
  the optimistic row and restores the draft, like a failed text send. A `400
  shell_confirmation_required` instead follows the §7.3 confirm-and-retry path (one retry, then an
  error). A post-dispatch failure (`502 command_failed` with `outcome:"unknown"`) does **not**
  restore the draft: rekey the row to the returned `messageID` if present, enter the existing
  unknown-acceptance state, and hydrate (`assets/chat.js:7480-7514`). The server's fixed message is
  shown; the upstream body never is.
- After a 202, the SSE is the only output path. `session.error`, `session.status`, and message parts
  behave as they do for text prompts. There is no second output channel and no command-specific
  event.
- **Optimistic row cleanup after a coordinator restart.** On 202 the row enters the acceptance state
  with `serverID = messageID`. If a later `stream.ready`/reconnect hydration does not contain that
  ID, reuse the unknown-acceptance path: start the existing 5 s grace
  (`UNKNOWN_ACCEPTANCE_GRACE_MS`, `assets/chat.js:30`), then mark the row `optimistic:"unknown"` and
  show "Delivery unknown; checking…" with the existing Check again/Remove controls
  (`assets/chat.js:7480-7514`). Do not auto-drop it: a successful later snapshot resolves it, and the
  operator can Remove it explicitly. This ties the accepted-row case to the existing
  unknown-acceptance/hydration behavior instead of inventing a second timer.
- A transport failure before any response shows "Delivery unknown; refreshing…" and hydrates the
  transcript; the command is not retried automatically. The server's `messageID` is known only when
  a response arrives (202 or 502 `command_failed`), so a command sent by a connection that died
  before any response cannot be deduplicated client-side. This is the same class as the existing
  unknown-acceptance flow
  (`assets/chat.js:7480-7514`), with the difference that the ID is server-generated.
- The composer's existing acceptance lock serializes sends; the early command branch re-checks
  `acceptanceInFlight()`/`acceptanceUnknown()` before dispatch, so a command cannot start while a
  text send is in flight or in the unknown state. opencode itself joins or queues a session run, so
  there is no Hanse-side in-flight command map or rate limit; the upstream run queue is the
  concurrency control.

### 7.6 Accessibility

- The composer textarea keeps its editing behavior but gets `role="combobox"`,
  `aria-autocomplete="list"`, `aria-haspopup="listbox"`, `aria-controls="chat-command-palette"`, and
  a toggled `aria-expanded`/`aria-activedescendant` while the palette is open. A native textarea role
  does not support combobox attributes, so the role must be set explicitly; focus stays in the
  composer. The listbox is `role="listbox"`, rows are `role="option"` with `aria-selected`, groups
  use `role="group"` with labels. A row with `available:false` adds `aria-disabled="true"` and stays
  in the DOM with its reason; Arrow/Home/End navigation skips `aria-disabled` rows and Enter/Tab
  does not activate them.
- Announce the result count and "No matching commands" through the existing `#chat-announcer`
  (`src/http/chat.ts:422`).
- Escape closes the palette and never executes a command. Enter in the palette inserts; Enter in the
  composer submits. The two actions are deliberately distinct.
- The confirm dialog uses `role="dialog"`, `aria-modal="true"`, a labelled title, a focus trap,
  Escape to close, and focus restoration to the composer (or the triggering row).
- A blocked popup falls back to same-tab navigation with a notice (§7.4).
- 44 px touch rows below 768; reduced-motion mode uses opacity only; the palette opens in-flow and
  never covers the draft.
- The `Shell` and `Shell unknown` badges are text plus an accessible description, not color alone.

### 7.7 Degradation

- `GET /commands` failure at page load: the palette uses the client `HANSE_ACTIONS` fallback for
  Hanse rows and shows "Application commands are unavailable; Hanse commands still work." The
  fallback map carries the canonical name, aliases, action id, a one-line description, and the
  master availability for each of the six Hanse commands; it is used only when the list fetch fails.
- `stopped`: Hanse rows only; show "Application commands load when the agent starts"; refetch after
  `stream.ready`.
- `unconfigured`: Hanse rows only; show "No agent runtime is configured; Hanse commands still work."
- Upstream list over cap or malformed: `unavailable` with a warning; never a partial list whose
  names could be wrong.
- No commands at all (a bare project): the palette shows the Hanse group and "No application
  commands".

## 8. Hanse-local command registry

### 8.1 Location and shape

- `src/opencode/commands.ts` (new, pure): `HanseCommand` metadata, the static registry, the merge,
  the merged-response cap, the whitelist, the shell detector, and the name sanitizer.
- `src/http/commands.ts` (new): `isCommandsRoute` and `handleCommands`, mirroring
  `src/http/context.ts`.
- `src/opencode/client.ts`: `OpencodeCommand`, `listCommands`, `runSessionCommand` (and the §6.6 v2
  adapter only if needed).
- `src/http/server.ts`: register the route before the `isChat` catch-all
  (`src/http/server.ts:185-212`), the same way the context route is registered.

```ts
type HanseCommandAction = "new" | "help" | "editor" | "compact" | "restart" | "diff";

type ShellPresence = "none" | "present" | "unknown";

interface HanseCommand {
  name: string;
  aliases: string[];
  action: HanseCommandAction;
  description: string;
  hints: string[];
}

function detectShell(template: unknown): ShellPresence;
function containsShellBlock(text: string): boolean;
```

The registry has six entries: `new` (alias `clear`), `help`, `editor` (alias `ide`), `compact`,
`restart`, and `diff`. It is static, has no project bindings, and is not stored in the database. The
server adds `available`/`unavailableReason` for the master: `/editor` and `/diff` are disabled
there; the other four remain available.

### 8.2 Action map

The client's `HANSE_ACTIONS` maps each action id to an existing client function (§7.4). The server
returns the action id for display and forward compatibility; the client ignores an unknown action
and shows the row disabled ("Not available in this build"). A Hanse row is never posted to the
server; the server's POST prevalidation only accepts opencode names. The fallback action map also
checks the master flag for `/editor` and `/diff`.

### 8.3 Why server-merged metadata plus a client action map

- One `GET` and one render path, so the palette, the collision policy, and the template whitelist
  live in one place.
- The actions are browser actions: starting a draft, opening a URL, opening the context rail,
  showing a dialog, calling the existing restart route. A server-side generic "run Hanse command"
  endpoint would duplicate the browser's state and create a second, broader execution surface.
- A client-only registry would make the browser the authority for all display metadata,
  descriptions, collision handling, and the template whitelist. That is harder to test, easier to
  drift, and requires two fetches for one list. The small client action map is only the execution
  source, not a second registry.

## 9. Per-command verdict table

### 9.1 The 30 client-local TUI commands in opencode v1.19.3

Source-read at tag `v1.19.3` from `packages/tui/src`: `app.tsx`, `component/prompt/index.tsx`,
`feature-plugins/system/diff-viewer.tsx`, and `routes/session/index.tsx`. `/share` is keybind-only and
is not in this set.

| Command | What it does in the TUI | Hanse equivalent | Decision | Rationale |
| --- | --- | --- | --- | --- |
| `/sessions` (resume, continue) | List/switch sessions | Sessions rail | Skip | Owner decision; the rail already lists, filters, switches, creates, and deletes sessions. A command adds no capability. |
| `/new` (clear) | Start a new session | `startDraft`; New session buttons | Implement | Zero new server surface; canonical `/new`, alias `/clear`; does not abort the active turn, same as the buttons. Blocked while a question/permission is pending. |
| `/workspaces` | Experimental workspace switching | None | Skip | Hanse isolation is one project/app per container; there is no workspace to switch. |
| `/models` (mo) | Pick the session model | `llm.model` setting; no browser catalog | Skip | Different scope and persistence; the browser cannot set the model (`src/http/chat.ts:92-106`). `/model` is separately deferred in §9.2. |
| `/agents` | Switch the active agent | None | Skip | Hanse does not expose agent selection; prompts use the instance default. |
| `/mcps` | List/toggle MCP servers | None | Skip | No MCP status/toggle surface; MCP is launch configuration. |
| `/variants` | Pick a model variant | None | Skip | No variant concept is exposed. |
| `/connect` | Provider login | Settings provider keys | Skip | Authentication is an admin/settings action, not a chat command. |
| `/org` (orgs, switch-org) | Switch organization | None | Skip | Not applicable to a single-operator self-hosted instance. |
| `/status` | Show provider/model/status | Thread meta, context rail, runtime pill | Skip | Status is already always visible; a command duplicates it. |
| `/update` | Self-update opencode | Deployment image update | Skip | opencode is pinned in the image (`Dockerfile:6,42`); self-update is not a chat action. |
| `/debug` | Debug/event inspector | None | Skip | No debug surface; raw events are not a product feature. |
| `/themes` | Pick a TUI theme | Shell dark/light toggle | Skip | The shell toggle already exists (`src/http/ui.ts:458-462`); a multi-theme picker is a separate design. |
| `/help` | Show help/commands | The merged palette and shortcuts | Implement | Uses the same palette; no separate help page; an optional argument filters it. Available during a pending question. |
| `/exit` (quit, q) | Exit the TUI | Close/navigate the browser | Skip | There is no process to exit; the agent keeps running. |
| `/editor` | Open the editor | IDE link (`ideFolderUrl`) | Implement | Canonical `/editor`, alias `/ide`; opens the existing IDE folder URL in a new tab with a same-tab fallback. Disabled for the master. |
| `/skills` | List agent skills | Managed skills pages | Skip | Hanse skills are DB-backed bundles with a dedicated page; a chat command would be only a deep link. |
| `/warp` | Experimental worktree | Git workbench | Skip | Hanse's git workbench is status/fetch/update/commit/push, not worktree creation. |
| `/move` | Move a session | None | Skip | TUI-only session move; Hanse sessions are scoped to one app. |
| `/diff` | Show the session diff | Application page `Changes` (`#changes-title`); inline tool diffs | Implement | Owner decision. Opens the application page Changes heading anchor in a new tab. That view is worktree-wide (`src/http/application.ts:458-460`), not session-only; inline feed diffs remain the per-edit view. Disabled for the master. |
| `/rename` | Rename the session | None | Skip | No session rename API/UI in Hanse; the rail shows the title. Would need an upstream call and inline edit. |
| `/timeline` | Jump to a message | Feed scroll/pagination | Skip | The feed already supports scroll and history pagination; a jump-to-message dialog is TUI-only. |
| `/fork` | Fork a session | None | Skip | No fork/session-graph UI; needs product design and an upstream fork route. |
| `/compact` (summarize) | Summarize the session | Existing context confirmation + `POST .../compact` | Implement | Reuses `contextCompactReasonFor`, `openContextConfirm`, and `compactContext` (`assets/chat.js:1573`, `:1549`, `:1840`); requires a selected session; surfaces the exact disabled reason instead of a silent no-op. |
| `/undo` | Undo a message/change | None | Skip | Hanse has no session revert/undo surface; destructive history semantics need a verified upstream route and UX. |
| `/redo` | Redo an undone change | None | Skip | Same as `/undo`. |
| `/timestamps` (toggle-timestamps) | Toggle message timestamps | Feed timestamps | Skip | Hanse renders message timestamps in the feed; there is no per-session toggle. |
| `/thinking` (toggle-thinking) | Toggle thinking/reasoning | Reasoning parts in the feed | Skip | The feed already renders reasoning parts; there is no toggle. |
| `/copy` | Copy the last response | Browser selection | Skip | Browser selection and the existing copy affordances cover it; no session-wide copy. |
| `/export` | Export the session | None | Skip | No export format or download route; a separate feature. |

`/init` and `/review` are **server** commands, not client-local; they and any project command appear
automatically through the proxy.

### 9.2 Hanse-native candidates

| Command | What it does | Hanse equivalent | Decision | Rationale |
| --- | --- | --- | --- | --- |
| `/restart` | Restart the app agent | Existing restart form / async route | Implement | One reusable confirm, then `POST .../restart?async=1` (`src/http/settings.ts:714-730`); warns that an active turn is interrupted. Blocked while a question/permission is pending. |
| `/stop` | Abort the active turn | None; no abort in the client | Defer | Needs a verified upstream abort route and policy. Add it only after the phase-1 probe. |
| `/model` | Change the session/app model | `llm.model` setting | Defer | Needs a model catalog endpoint and a settings write; the browser cannot set the model today, and mid-session changes have OMO/restart semantics. |

`/help`, `/new`, `/editor`, `/compact`, and `/diff` are in the TUI table above; they are not
duplicated here. `/restart` is Hanse-native and is not part of the 30.

### 9.3 Scope recommendation

Implement: `/new` (alias `/clear`), `/help`, `/editor` (alias `/ide`), `/compact`, `/restart`, and
`/diff`. Of these, five are TUI-local (`new`, `help`, `editor`, `compact`, `diff`) and `/restart` is
Hanse-native: six actions total. Defer: `/model`, `/stop` (neither is in the 30-command TUI-local
set). Skip: the other 25 TUI-local commands. Everything deferred or skipped is a non-goal, not
hidden scope.

## 10. Merge and collision policy

- **Order.** `commands[]` is Hanse registry order first, then opencode commands sorted by name. The
  client groups by `source`; it does not rely on array order for grouping.
- **Names.** Exact, case-sensitive matching for execution. The palette filter is case-insensitive,
  but selecting a row always inserts the canonical name. A custom command name is not lowercased.
- **Aliases.** Hanse aliases are additional match keys only. They are never posted. If an alias
  collides with an opencode name, the opencode name wins for that token and the alias is removed from
  the Hanse entry's `aliases` (with a `command_shadowed` warning); the canonical Hanse name remains
  available if it does not also collide.
- **Collisions.** If an opencode command has the same canonical name as a Hanse command, the
  opencode entry is kept and the Hanse entry is dropped. The response includes
  `{code:"command_shadowed", command: name}` and the server logs the collision. The palette shows a
  footer warning. This is deliberately not silent.
- **Direct-typed tokens.** The client resolves a typed token through the same merged list, so a
  shadowed name or alias behaves exactly as its palette row: the opencode command wins and the same
  hint is shown. Typing `/help` when an opencode `help` exists posts the opencode command; it does
  not open the Hanse palette. When the list is unavailable, the fallback map is used and shadow
  information is unavailable (documented degradation).
- **Invalid upstream names.** A name that fails the shape check is dropped with
  `{code:"command_dropped"}`; the rest of the list is kept. A non-array body, or an entry that is not
  an object or lacks a usable `name`, makes the whole source `unavailable` rather than producing a
  partial, potentially wrong list.
- **Deduplication.** An opencode list with duplicate names keeps the first entry and drops the rest
  with `command_dropped`.
- **Templates.** Never merged, never returned, never cached in the client.
- **Merged cap.** After the whitelist, drop trailing opencode entries until the serialized response
  is at most 1 MiB; if any were dropped, add **one** `command_cap_reached` summary warning; keep
  every Hanse entry. `command_dropped` is not used for this cap: it is only for an invalid name
  (above), a duplicate name (below), or an entry beyond the 500-per-list cap. This is the
  enforcement of the §5.4 cap, not a best-effort claim.

## 11. Security

- **Human-only.** Both routes call `principalFrom`; missing -> `401`, non-human -> `403` before app
  resolution (`src/http/auth.ts:32-56`; pattern at `src/http/context.ts:67-78`). This is stricter
  than the existing chat send route, which only restricts session deletion
  (`src/http/chat.ts:548-549`), because a command template can execute shell server-side.
- **CSRF.** The POST requires `application/json`; a simple cross-site form cannot send it. If an
  `Origin` header is present and its host differs from `Host`, return `403 cross_site`. The cookie is
  `HttpOnly; SameSite=Strict` (`src/http/handler.ts:558`); there is no CSRF token, and the deployment
  is trusted-LAN HTTP. This is defense-in-depth, not a same-origin XSS boundary. `HttpRequest`
  already carries `origin` and `host` (`src/http/server.ts:150-151`).
- **Template withholding.** The DTO is a whitelist. Do not spread the upstream `Command` object;
  a future upstream field must not leak by accident. `template` may contain internal instructions,
  shell blocks, and large text; the palette does not need it.
- **Shell blocks.** Custom command templates can contain `` !`shell` `` blocks executed server-side
  outside the agent permission flow. The detector is the exact upstream pattern
  ``/!`([^`]+)`/g`` **anywhere** in the template; a line-start match is only a diagnostic subset.
  The server also scans `arguments` because substitution/append precedes execution, so an argument
  can inject a block. The palette marks such commands with a `Shell` badge (or `Shell unknown`) and an
  accessible description: "Runs shell commands outside the agent permission flow." The client
  requires an explicit confirmation, and the POST enforces it with `confirmShell:true`
  (`400 shell_confirmation_required` otherwise). **`confirmShell` is not proof of user
  confirmation**: a scripted or compromised client can set it. It is an accident/UX guard. The real
  boundary is human-only auth plus operator trust in the project's command files; the server check
  remains defense-in-depth. `shell: "unknown"` (MCP Promise, non-string template, v2 reduced shape)
  requires the same confirmation; that is precautionary, not a safety claim. The agent can write
  `.opencode/command/**` files via `bash`, so this warning matters. Changing the permission overlay
  to deny agent edits to those paths is future hardening, not part of this stage.
- **Untrusted display data.** Command names, descriptions, hints, and origins come from project
  files, MCP prompts, and skills. Insert them with `textContent`, never `innerHTML`. Strip control
  characters, cap lengths, and never create links from descriptions or hints.
- **Arguments are data.** The arguments string is forwarded as a JSON field. Hanse does not
  interpolate it into a shell, path, or template; opencode's own expansion is the intended behavior.
  The client never renders arguments with `innerHTML`. The server does scan the arguments for the
  shell pattern for the confirmation gate (§6.4); that is a detection read, not execution.
- **Loopback access.** The app's opencode server is not unauthenticated: the agent host injects
  `OPENCODE_SERVER_PASSWORD` into the server environment (`src/agent/host.ts:135-144`) and the
  coordinator attaches Basic auth (`src/opencode/endpoint-auth.ts:18-33`). But the agent runs in the
  same container and uid as the server, so a `bash` tool can read that password from its environment
  and call `POST /session/{sid}/command` directly, bypassing the human-only Hanse route. This is
  same-tenant secret access, not an open endpoint; the Hanse route is not a hard boundary, and a hard
  boundary needs the separate isolation design. The same applies to the prompt and permission routes.
- **Cross-app isolation.** Every lookup goes through `findApp` plus the optional project query; the
  command list and send are scoped to one app instance. There is no cross-app command list or
  execution.
- **Rate/DoS bounds.** The upstream list is capped at 4 MiB/10 s, the merged response is capped and
  **enforced** at 1 MiB, and the arguments at 32 KiB. The server summary cache is 5 s, GET-only, and
  never contains templates. There is no Hanse-side in-flight counter; opencode owns session-run
  queueing.
- **Error bodies.** Never return or log `OpencodeHttpError.message`, `bodyExcerpt`, or an upstream
  response body. They can contain the expanded prompt, template content, or shell output. Return the
  fixed per-code messages (§5.6) and log code/status/bytes/duration only.
- **Logging.** Never log arguments, templates, expanded prompts, or upstream bodies. Log names, byte
  counts, status codes, durations, and fixed error codes.

## 12. Failure modes and error mapping

| Scenario | Behavior |
| --- | --- |
| `GET /command` 404/405 | `sources.opencode = "unavailable"`; Hanse-only; warning; no 502. |
| `GET /command` 5xx/timeout/over cap | Same as above. |
| App stopped | `sources.opencode = "stopped"`; Hanse-only; `agent_stopped`; the client refetches after `stream.ready`. |
| No runtime configured | `sources.opencode = "unconfigured"`; Hanse-only; `agent_runtime_unconfigured`; the UI says no runtime is configured. |
| `manager.ensure` fails on GET | Hanse-only plus `sources.opencode = "unavailable"` (or `stopped` for a stopped instance) and a warning; the app's runtime pill already shows the failure. |
| `manager.ensure` fails on POST | `502 agent_unavailable` (or the mapped lifecycle error) with `outcome:"not_sent"`. |
| Missing session | Not prevalidated; a post-dispatch upstream 404 is `502 command_failed` with `outcome:"unknown"` and the `messageID`; the phase-1 probe records the real status. |
| Unknown command | Prevalidation against the fresh list -> `404 command_not_found`; the client refetches. |
| Arguments > 32 KiB | `400 command_too_large`; no dispatch. |
| Shell present/unknown, no confirmation | `400 shell_confirmation_required`; the client shows the confirmation and retries once with `confirmShell:true`; a second 400 is an error. |
| Invalid JSON / non-JSON | `400 invalid_json` / `415 unsupported_media_type`. |
| Agent principal | `403 human_only`; no app existence probing. |
| Cross-site `Origin` | `403 cross_site`. |
| App deleting | `409 deletion_pending`, checked from `found.app.deleting`/`found.project.deleting` before any manager, `stopped`, or `unconfigured` branch; no dispatch. |
| Upstream fails < 750 ms after dispatch | `502 command_failed`, `outcome:"unknown"`, fixed message + `messageID`; no draft restore; client keeps the optimistic row and hydrates. |
| Upstream fails > 750 ms | 202 already returned; log `commands.send.failed`; `session.error` appears if opencode emits one; no automatic retry. |
| Background timeout (30 min) | Abort the upstream fetch, log `commands.send.timeout` with the `messageID`, and do not reverse the 202. The client gets no separate timeout notice; the accepted-row cleanup (§7.5) marks it unknown if the message never arrives. If phase 1 shows that aborting the fetch cancels the turn, a command exceeding 30 min is killed; this is accepted for an interactive palette and the constant can be raised later. |
| Coordinator restarts after 202 | The background request is lost; opencode may or may not have started/completed the turn. The transcript and session list are authoritative. The optimistic row is marked unknown after the 5 s accepted-absence grace and can be resolved or removed (§7.5); no recovery marker. |
| SSE disconnected | Output is missed until reconnect; `stream.ready` hydration reloads messages. No command-specific state. |
| Duplicate submit | The composer acceptance lock serializes sends; opencode joins/queues the session run. No Hanse-side counter is added. |
| Project command shadows a Hanse command | Upstream wins; `command_shadowed` warning; Hanse action hidden; a directly typed token behaves the same. |
| Command disappears between list and send | Fresh POST list; if absent -> `404 command_not_found`; otherwise the early window classifies any post-dispatch failure as unknown. |
| `template` contains a shell block | `shell:"present"`; `Shell` badge and warning; explicit confirmation; the POST requires `confirmShell:true`; opencode executes it, not Hanse. |
| `arguments` inject a shell block | The server scan makes the effective classification `present`; `400 shell_confirmation_required` without `confirmShell`; the client re-prompts and retries once. |
| Unknown shell (MCP/non-string/v2) | `shell:"unknown"`; `Shell unknown` badge; the same confirmation is required; precautionary, not a safety claim. |
| Command has shell but the client omits `confirmShell` | `400 shell_confirmation_required`; no dispatch; the client re-prompts. |
| Master app | Commands list/send work like any app; `/restart` is allowed with confirmation. `/editor` is disabled because the master workspace is coordinator-managed; `/diff` is disabled because the master application page renders `master-panel`, not `changes-card`. |
| v2-only upstream | §6.6 adapter; list/send work with `shell:"unknown"` for every v2 command; a list failure degrades to `sources.opencode = "unavailable"`, a known-absent send route returns `502 commands_unavailable` before dispatch, and an unexpected send failure after dispatch is `502 command_failed`/unknown. |
| Merged cap overflow | Drop trailing opencode entries and, if any were dropped, add one `command_cap_reached` summary; `command_dropped` stays reserved for invalid/duplicate entries and the 500-per-list cap; Hanse entries stay; the response stays <= 1 MiB. |
| Popup blocked for `/editor` or `/diff` | Same-tab navigation with a notice. |

## 13. Observability

- `commands.list`: app id, source status, command count, warning codes, duration, dropped count. No
  descriptions or templates.
- `commands.send.accepted`: app id, session id, command name, `messageID`, argument byte length,
  prevalidation duration, early-window result. No argument text.
- `commands.send.rejected`: the same plus status/code and phase (`validate`, `prevalidate`,
  `dispatch`).
- `commands.send.early_failed`: status/code and duration.
- `commands.send.failed` / `commands.send.timeout`: status/code, duration, `messageID`. These are the
  only visible record of a post-202 failure; the transcript may also show `session.error`.
- `commands.list.shadowed`: the shadowed name and source. This is a configuration warning, not an
  error.
- No metrics endpoint, no database audit, and no command history are added. The chat transcript is
  the user-visible record; logs are the operator record.
- **Never log** arguments, templates, expanded prompts, shell output, `OpencodeHttpError.message`, or
  `bodyExcerpt`. Log fixed codes, status, byte counts, durations, and `messageID`.

## 14. Testing strategy

| Layer | Coverage |
| --- | --- |
| Pure registry/merge | Hanse registry shape; upstream whitelist (no `template`); description/hint caps; control-character stripping; `shell` tri-state; **inline shell block not at line start**, multiple blocks, and repeated `detectShell` calls (no `lastIndex` leak); non-string/absent template -> `unknown`; `containsShellBlock(arguments)`; name shape and dropping; duplicate names; collision warning; alias shadowing; direct-typed shadow resolution; group/order; 500-per-list extras -> `command_dropped` and merged 1 MiB cap -> one `command_cap_reached` summary (`command_dropped` not used for the merged cap) with Hanse entries preserved. |
| Client parser (new `test/chat-commands.test.ts`) | `/name`, `/name args`, multi-line args, aliases, exact case sensitivity, leading whitespace, trimmed normal text, `//foo` sent verbatim as `//foo` + hint, bare `/`, unknown slash -> literal + hint, empty name, no-command fallback, palette filter, direct-typed shadow. |
| HTTP integration (new `test/slash-commands.test.ts`, using `fakeOpencodeHandler` in `test/chat-page.test.ts:187-208`) | GET auth matrix (401/403/human), project disambiguation, 404 unknown app, `DeletionPendingError` and explicit `found.app.deleting`/`found.project.deleting` -> 409 before any `stopped`/`unconfigured` branch, `stopped` vs `unconfigured`, upstream 404/5xx/over-cap -> `unavailable`, merged list, no template in the response, `shell` tri-state, GET summary cache TTL, **POST fresh-list TOCTOU** (template changes between cached GET and POST), **argument-injected shell block**, **non-string/MCP template -> unknown + confirm**, POST auth/JSON/Origin, empty/invalid/oversize, `shell_confirmation_required`, unknown command, missing session -> `502 command_failed`/unknown, 202 body, `messageID` forwarded, **post-dispatch failure after a shell block -> 502 + outcome unknown + messageID + no upstream body**, background timeout aborts/logs without reversing the 202, fixed error message/no template leak, v2 adapter list/send/`204`/`text` mapping, merged cap, no Hanse action dispatch. |
| Client unit | `assets/chat-commands.js` helpers with no DOM; existing `test/chat-core.test.ts` style; pending-question lock (server commands, `/new`, `/compact`, `/restart` blocked; `/help`, `/editor`, `/diff` allowed); **a command cannot start while a text send is in flight (`acceptanceInFlight()`) or in the unknown state (`acceptanceUnknown()`), and a mutating/server command cannot start while a prompt is pending — the navigation actions stay available**; compact disabled reason surfaces a toast and does not open the confirm; **`/compact` whose confirm remains hidden/disabled shows the re-read reason or "Compaction is unavailable." instead of returning silently**; **stale-list 400 then 202: exactly one optimistic row, reused and rekeyed by the retry's `messageID`, never a second row**; master `/editor`/`/diff` disabled; accepted-row 5 s absence -> unknown; popup-blocked fallback. |
| Browser QA (`docs/design/chat-qa.mjs`) | Palette open via `/` and the button, filter, keyboard, insert-vs-submit precedence, disabled-row `aria-disabled` and navigation skipping, Hanse actions (`/new`, `/help`, `/editor`, `/diff`, `/compact` confirm, `/restart` confirm), server command POST body, shell confirmation, shell unknown confirmation, optimistic row/rekey, stale-list 400 then 202 single-row retry, unknown slash literal + hint, `//foo` literal + hint, trimmed send, not-running/unconfigured degradation, direct-typed shadow, master-disabled actions, popup-blocked fallback, 390/768/1440 dark/light, focus/announcer/combobox roles, no console errors. |
| Regression | Existing text send, async 202, SSE, queue, pagination, compact, restart, IDE link, theme toggle, and session rail unchanged. Existing `test/chat-page.test.ts` and `test/context-http.test.ts` stay green. |
| Live smoke | On a real managed agent at the pinned version: create a custom `.opencode/command/hello.md`, confirm it appears with no template in the JSON, run `/hello <arg>` and see the expanded prompt + response over SSE; add an inline shell-block command and an argument-injected command and confirm the confirmation gate; run `/help`, `/new`, `/editor`, `/diff`, `/compact`, `/restart`; confirm an agent principal gets 403; confirm a stopped app lists Hanse-only and refetches after start; confirm the master disables `/editor` and `/diff`. |
| Phase-1 probe | `opencode serve` + `/doc` on 1.19.3 for the v1/v2 surfaces, **`GET /command` with no `directory`/`workspace` query returning the app's project commands (record the cwd-not-app-dir case)**, `arguments` type, `messageID`, blocking, disconnect behavior, missing session, unknown command, MCP non-string template, shell grammar (inline/line-start/argument-injected), v2 `location[directory]` query, and v2 `text` semantics; record the result in the plan/journal. |

Mutation sanity: break the whitelist (add `template`), the collision rule, the early-window unknown
mapping, the shell detector (line-start only), and the POST fresh-list rule one at a time; the
corresponding tests must go red.

## 15. Alternatives considered

| Decision | Alternative | Verdict |
| --- | --- | --- |
| Execution | **Blocking** `POST /commands` awaits the upstream command and returns `200 {info, parts}`. | Rejected. It blocks for the whole turn, duplicates the SSE output path, risks proxy/timeouts, holds the composer, and forces the client to merge returned parts with streamed parts. It also diverges from the chat's existing `202` send. |
| Execution | **Detached `202` + prevalidation + early window** (recommended). | Matches the chat UX and keeps SSE as the single output path. Residual early failures are bounded by prevalidation, the 750 ms window, the post-dispatch `outcome:"unknown"` rule, logs, and `session.error`; they are documented, not hidden. |
| Registry | **Client-only** list, merged in the browser. | Rejected. Two fetches, two sources of truth, collision policy in two languages, and no single whitelist. |
| Registry | **Server-merged metadata + client action map** (recommended). | One list, one policy, one whitelist; the client owns the browser actions. |
| Registry | Server executes Hanse actions through a generic `POST /commands` bus. | Rejected. It duplicates browser state and creates a broader execution surface for actions that are already local UI behavior. |
| Version | **Full runtime adapter** choosing v1/v2 per instance. | Rejected as the primary design: one pinned version, v2 experimental, two response shapes, and unverified 1.19.3 behavior. The only v2 work allowed is the §6.6 contingency if the v1 pair is absent. |
| Version | **v1-only with isolated client functions and a phase-1 probe** (recommended as the primary path). | Least code and risk; the §6.6 contingency localizes a v2 adapter if the v1 pair is absent. |
| Version | **Hanse-only when v2 is the only pair.** | Rejected: it contradicts the owner decision that the v2 adapter is the contingency. The adapter is the specified fallback; Hanse-only is only for "neither pair". |
| Parsing | Server parses slash text. | Rejected. The composer and aliases are client state; the server should receive structured `{name, arguments}` and never parse slash text. |
| Parsing | Require `//` for a literal leading slash. | Rejected for backward compatibility. An unknown slash is sent literally with a hint; `//` is not required and is not implemented as an escape. |
| Parsing | Optional `//` escape. | Rejected. It would turn `//foo` into `/foo`, changing today's text; `//foo` is an unknown slash and is sent verbatim. |
| Shell | Line-start-only detector. | Rejected. It misses inline blocks and argument-injected blocks; the exact upstream pattern is required. |
| Shell | Send without confirmation when the template is unknown. | Rejected. `unknown` requires the same confirmation as `present`; the confirmation is precautionary, not a safety claim. |
| Cache | POST uses the 5 s summary cache for `shell`. | Rejected. It is a TOCTOU window; POST fetches fresh, the cache serves GET display metadata only. |
| UI | Modal command dialog or per-command forms. | Rejected. One in-flow listbox above the composer preserves focus, avoids a focus trap, and matches the prompt dock pattern. |
| UI | Execute on palette selection. | Rejected. Insert-then-submit is one rule and prevents an accidental `/restart` or `/compact`. |
| Optimistic | No optimistic row; rely on SSE. | Rejected. The user sees nothing while opencode expands the template; a transient `/name args` row reuses the existing acceptance plumbing. |
| Cache | Server caches full command objects including templates. | Rejected. Templates are never cached or returned; only 5 s summaries are cached. |
| Collision | Hanse wins its reserved names. | Rejected. It would silently replace a project's `/help` or `/new` command. Upstream wins; the collision is warned, including for directly typed tokens. |
| Timeout | No cap on the background command. | Rejected. It leaks a fetch indefinitely; 30 min is a bounded interactive cap, with the abort semantics documented in §12. |
| Scope | Implement all 30 TUI commands or all Hanse candidates. | Rejected. Most duplicate existing surfaces or need product work (`/model`, `/stop`); a six-action stage is small and testable. |

## 16. Rollout and verification

1. **Phase 1 - probe and gate.** Run the pinned 1.19.3 `opencode serve` and record: the v1/v2
   command surfaces, **the no-query `GET /command` result (app project commands, not a global list;
   record the instance-cwd-not-app-dir case)**, `arguments` type, `messageID`, blocking, disconnect
   behavior, missing session, unknown command, MCP non-string template, the exact shell grammar
   (inline/line-start/argument-injected), the v2 `location[directory]` query, and the v2 `text`
   semantics. If the v1 pair is missing, follow §6.5/§6.6 (v2 contingency or Hanse-only), not an
   improvised fallback.
2. **Phase 2 - implement.** Add the client functions, the pure registry/merge/detector, the merged
   cap, the HTTP routes, the route dispatch before `isChat`, the `data-ide-url`/`data-app-url`/
   `data-master` attributes, the palette, the parser, the keydown precedence, the acceptance-guard
   placement before the command branch, the pending lock, the six actions, the master disables, and
   the confirm dialog. No migration. `/diff` uses the existing `#changes-title` heading anchor, so no
   application-page markup change is required; if a section anchor is preferred instead, add
   `id="changes"` and update the application-page test and `assets/git.js` anchor in the same change.
3. **Phase 3 - verify.** Run the unit/HTTP/client/browser/live tests from §14, then the four project
   gates. Re-read the diff for scope: no template expansion, no per-command handler, no new
   dependency, no unrelated chat changes.
4. **Phase 4 - record.** After the design and plan gates and the owner's answers, update
   `docs/current-state.md`, the design index status, and the journal. Those are explicitly **not**
   part of this document.
5. **Deployment smoke.** On a test application, confirm a project command appears without its
   template, runs, and streams; confirm Hanse actions; confirm a stopped app and an unconfigured
   runtime degrade with different messages; confirm an agent principal is rejected; confirm the
   master disables `/editor` and `/diff`. No feature flag is planned for this pre-alpha stage.

Rollback: the feature is additive. If it must be withdrawn, remove the palette trigger and the two
routes; ordinary text send is untouched. No data migration means no data rollback.

## 17. Resolved design decisions

### Resolved design decisions

These are owner answers for this stage. They are decisions, not questions:

1. **Scope.** Implement the five TUI-local commands (`/new` with alias `/clear`, `/help`, `/editor`
   with alias `/ide`, `/compact`, `/diff`) plus the Hanse-native `/restart`; defer `/model` and
   `/stop`; skip `/sessions` and the other 24 TUI-local commands (25 TUI-local skips total).
2. **Editor naming.** Canonical `/editor`, alias `/ide`.
3. **Unknown leading slash.** Send an unknown `/text` literally as today, with a non-blocking
   "unknown command" hint. `//` is not required as an escape and is not implemented as one; `//foo`
   is an unknown slash and is sent verbatim as `//foo`.
4. **Collision.** opencode/upstream wins; the Hanse entry is hidden with a `command_shadowed`
   warning. The same applies to a directly typed token.
5. **Busy session.** Let the upstream command route queue/join an active turn, subject to the
   phase-1 probe. There is no Hanse-side `409 session_busy`.
6. **`/new` during an active turn.** No abort and no extra confirmation; same behavior as the
   existing New session button. The `/new` command is blocked only while a question/permission is
   pending (§7.3).
7. **Version strategy.** v1-only in this stage. Phase 1 probes the pinned 1.19.3. If the v1 pair is
   missing but the v2 pair exists, the design's contingency is the §6.6 v2 adapter (list
   `{name, description?}` or the pinned shape; send `{name, text}`; `204`). If neither pair exists,
   ship Hanse-only commands plus a warning and do not bump or downgrade the pin inside this stage.
8. **Shell confirmation.** Server-enforced `confirmShell:true` is final. A command with
   `shell:"present"` or `shell:"unknown"` requires it; an argument-injected block is scanned the same
   way. `confirmShell` is an accident/UX guard, not proof of human confirmation. Do not change the
   agent permission overlay for `.opencode/command(s)/**` in this stage; treat that as future
   hardening, not an open question.
9. **`/diff` semantics.** The command opens the application page `Changes` (`#changes-title`) in a
   new tab; that view is worktree-wide. Inline feed diffs remain the per-edit view. A
   session-scoped aggregate is deferred because it needs a verified upstream route or a new
   client-side patch log. The master has no worktree page, so `/diff` is disabled there (§7.4).

No owner questions remain for this stage; the same decisions are recorded in
[`docs/open-questions.md`](../open-questions.md).

## 18. Design review

### Round 1 (oracle, 2026-10-23): FAIL

The independent design review judged the architecture sound and the issues fixable. It failed the
planning artifact as written. This section records each finding and its resolution in this revision.
No finding was deferred to an owner decision; the remaining open items are phase-1 verification
probes, not design gaps. This design revision did not edit `docs/open-questions.md`; the
orchestrator updated that owner-decision record separately to the verified 30-command inventory.

| ID | Severity | Finding | Resolution |
| --- | --- | --- | --- |
| B1 | Blocker | The shell detector was described as a line-start check only. | The detector now uses the exact upstream pattern ``/!`([^`]+)`/g`` anywhere in the template; the line-start form is only a diagnostic subset. The argument string is scanned with the same pattern. Added to §1.2, §5.3, §6.1, §6.4, §8.1, §11, and §14 (inline-block and repeated-call unit tests; phase-1 probe). |
| B2 | Blocker | Argument-injected shell blocks were not gated. | POST derives the effective shell from the fresh template **and** `arguments`; either block requires `confirmShell:true`. Added the argument-injection HTTP test and phase-1 probe (§5.3, §6.4, §12, §14). |
| M3 | Major | 5 s summary cache TOCTOU. | POST always fetches a fresh list and ignores the cache; the 5 s cache is GET display metadata only. Added the "template changes between cached GET and POST" test (§5.3, §5.5, §14). |
| M4 | Major | Unknown `hasShell` was treated as safe. | Replaced `hasShell` with `shell: "none" \| "present" \| "unknown"`; `unknown` requires the same confirmation as `present`; the design states the precautionary confirmation is not a safety claim. Added a non-string/MCP-template test (§5.2, §5.6, §6.3, §11, §14). |
| M5 | Major | Post-dispatch failures were not all classified unknown, and a pre-202 mapped error restored the draft. | Added the dispatch boundary: every failure observed in the early window after the upstream request is dispatched is `502 command_failed` with `outcome:"unknown"`, a fixed message, and `messageID`; later failures are logged for SSE reconciliation; no draft restore. Pre-dispatch errors restore. Added the "shell block then fail" test (§5.3, §5.6, §7.5, §12, §14). |
| M6 | Major | v2 contingency contradicted itself (`unavailable`/no adapter vs adapter). | Added §6.6 with the full contingency and aligned §5.2, §6.5, §12, §15, and §17 item 7. The owner decision that the v2 adapter is the contingency is kept. |
| M7 | Major | The TUI table was incomplete and all counts were wrong. | Expanded §9.1 to all 30 verified commands; added the ten missing rows; updated D4, NG5/NG6, §9.3, §17 item 1, §15, and every count (30 TUI-local, 5 implemented, 25 skipped, 6 actions, 2 deferred). |
| M8 | Major | Pending-question composer lock could be bypassed. | §7.3 now blocks server commands and `/new`, `/compact`, `/restart` while `activePromptEntries().length > 0`; `/help`, `/editor`, `/diff` remain available. Added a client test. |
| M9 | Major | `confirmShell` was described as if it proved user confirmation. | §11/D9 now state it is an accident/UX guard, not a security boundary; human-only auth plus operator trust are the real boundary. The server check stays. |
| M10 | Major | Upstream error statuses were unverified and a 404 was assumed to mean "session missing". | Added phase-1 probes for a missing session and an unknown command; removed `session_not_found` from this route; ambiguous post-dispatch failures map to `502 command_failed`/unknown. Added tests (§5.3, §5.6, §6.5, §12, §14). |
| M11 | Major | The 1 MiB merged-response cap was not enforced. | §5.2/§10 now drop trailing opencode entries and add one `command_cap_reached` summary until the response is <= 1 MiB; Hanse entries are never dropped. `command_dropped` is reserved for invalid/duplicate entries and the 500-per-list cap (standardized in round 2). Added a test. |
| M12 | Major | The textarea combobox and confirm-dialog accessibility were unspecified. | §7.6 now uses `role="combobox"`, `aria-autocomplete="list"`, `aria-expanded`, `aria-controls`, `aria-activedescendant`, keeps focus in the composer, and specifies the dialog's `role`, `aria-modal`, focus trap, Escape, and focus restoration. |
| M13 | Major | `/compact` was a silent no-op when the compact button was disabled. | §7.4 reads `contextCompactReasonFor` first and surfaces the exact reason via a toast; it opens the confirm only when the reason is null. Added a test. |
| M14 | Major | `/diff` (and `/editor`) on the master were unspecified. | §7.4/§12 disable both for the master with `available:false` and a reason; the existing topbar/rail links are unchanged. Added tests. |
| M15 | Major | Directly typed shadowed names did not get the palette's hint/behavior. | §7.3/§10 resolve typed tokens through the same merged list; the opencode entry wins and the same `command_shadowed` hint is shown. Added a test. |
| M16 | Major | Error bodies could leak templates/prompts/shell output. | §5.6/§11/§13 use fixed per-code messages and forbid returning/logging `OpencodeHttpError.message`, `bodyExcerpt`, or upstream bodies. Added a leak test. |
| M17 | Major | The composer integration point was left as "one branch or extract a shared submitTurn". | Chose one early branch inside `sendPrompt` (no `submitTurn` extraction) and specified keydown precedence: palette open -> Enter/Tab insert, never submit; palette closed -> Enter submits; form submit while open inserts. §7.1-§7.3. |
| M18 | Major | Optimistic-row cleanup after a post-202 coordinator restart was unspecified. | §7.5 extends the existing unknown-acceptance path: after a 5 s accepted-absence grace, mark the row unknown and expose Check again/Remove; never auto-drop; a later snapshot resolves it. §12 updated. |
| M19 | Major | 30-minute timeout semantics were unspecified. | §5.4/§12 now state: abort, log `commands.send.timeout`, no 202 reversal, no separate client notice; the accepted-row cleanup marks it unknown. If the probe shows abort cancels the turn, a >30 min command is killed, accepted for an interactive palette. |
| M20 | Major | `OpencodeCommand.template` was required. | §6.3 makes it `template?: string`, runtime-guarded; a non-string/absent template yields `shell:"unknown"` in the whitelist (§5.2). |
| M21 | Major | Stale `src/http/server.ts:28,31-37` cap reference. | Corrected to `src/http/server.ts:26` and `:33-41` in §5.4. |
| M22 | Major | `sources.opencode = not_running` conflated stopped with no runtime. | Replaced with `stopped` and `unconfigured` plus distinct warnings/messages (§5.2, §7.7, §12). |
| M23 | Major | `DeletionPendingError` after `findApp` was not mapped. | §5.2/§5.3 map it from `manager.ensure` after `findApp` to `409 deletion_pending`. |
| M24 | Major | Popup-blocked `/editor`/`/diff` had no fallback. | §7.4 specifies same-tab `location.assign` plus a notice. |
| M25 | Major | The send path's trimming was not preserved precisely. | §7.3 sends the existing trimmed text for non-command messages, uses the trimmed draft for recognition, preserves multi-line args, and specifies case-sensitive exact names/aliases. Added trim/case/alias tests. |
| M26 | Major | `//` behavior was contradictory. | Dropped the escape: `//foo` is an unknown slash, sent verbatim as `//foo` with the hint; today's text behavior is preserved. §7.3/§15/§17 item 3 and tests updated. |
| m1 | Minor | "20 client-local" and derived counts were stale. | Updated to 30/5/25/6/2 throughout (§4, §9, §15, §17). |
| m2 | Minor | "open question"/"question 7" references were stale. | §17 now contains only resolved decisions and says no owner questions remain; no "question 7" references remain. |
| m3 | Minor | No design-review record. | This §18 records the round-1 verdict, every finding, and the resolution. |
| m4 | Minor | Scope/non-goals/requirements/table/caps/error table drift. | Re-scanned and reconciled: NG4/NG5/NG6, R3/R6/R7/R8, D4/D5/D9/D10, §5.4/§5.6, §9, §12, §15, and §17. |
| m5 | Minor | The index status was stale. | For round 1 the index said "revised after design review; awaiting round 2"; it now reads "approved (oracle PASS after 2 rounds); plan pending". |

### Round 2 (oracle, 2026-10-23): PASS

The independent design review passed. **No BLOCKER or MAJOR finding remained**; the fourteen
MINOR/NOTE items below are resolved by content in this revision, not only by this section. The design
is approved for planning, subject only to the phase-1 verification probes listed below.

| # | Finding | Resolution |
| --- | --- | --- |
| 1 | R8 "otherwise" implied a present v1 pair could degrade. | R8 is now presence-ordered: v1 pair present -> v1; v1 pair absent (including partial) + v2 present -> §6.6; neither -> Hanse-only with a warning. A present v1 pair is never degraded. |
| 2 | NG1 said "no argument parsing" while the POST scans arguments. | NG1 and the out-of-scope line now forbid argument expansion/splitting/quoting/interpolation/reinterpretation and explicitly carve out the shell-pattern safety scan as the only read; no-template-expansion and no-shell-execution remain. |
| 3 | Cap-drop warning codes were inconsistent. | `command_cap_reached` is the single summary for the 1 MiB merged cap; `command_dropped` is only for invalid/duplicate entries and the 500-per-list cap. Aligned §5.2, §5.4, §10 (and M11), and §12. |
| 4 | `showToast(reason, "warning")` has no styled tone. | `/compact` blocked feedback uses the existing `error` tone (the primitive only styles `success`/`error`; `warning` would show a success check icon); no new tone is added and the exact reason text is unchanged. §7.4. |
| 5 | The early branch could bypass the acceptance/pending guards. | §7.1/§7.3 place the branch after the acceptance guards and have `dispatchComposerDraft()` re-check acceptance plus the action-aware pending lock; the text path is unchanged. Added client/browser tests for the in-flight and pending cases. |
| 6 | Deletion markers were not checked before the `stopped`/`unconfigured` early returns. | §5.2 and §5.3 step 1 now check `found.app.deleting`/`found.project.deleting` first and map to `409 deletion_pending`, before any manager/`stopped`/`unconfigured` branch; §12 aligned. |
| 7 | `/compact` could still silently no-op after the reason check. | §7.4 re-reads `contextCompactReasonFor` after `openContextConfirm()` (which returns no status) and shows that reason or "Compaction is unavailable." when the confirm stays hidden/disabled. |
| 8 | Disabled palette rows lacked the ARIA disabled contract. | §7.2/§7.6 add `aria-disabled="true"` to disabled options, keep them visible with the reason, and specify that Arrow/Home/End skip them and Enter/Tab does not activate them. |
| 9 | The master `/editor` reason implied the IDE link was blocked. | §7.4 now says only the palette command is not offered because the master workspace is coordinator-managed; the existing operator IDE link is unchanged and out of scope for this stage. |
| 10 | Phase 1 did not explicitly verify `GET /command` without `directory`. | §6.5 item 2, §14, and §16 phase 1 add the no-query call, verify it returns the app's project commands (not a global/default list), and record the cwd-not-app-dir outcome; the "do not pass a host directory" rule is kept. |
| 11 | The 400 confirmation retry could insert a second optimistic row. | §7.3/§7.5 specify that a stale-list 400 retry reuses the already-inserted row and the same 202/`messageID` rekey flow; it never inserts a second row. Added a stale-list-400-then-202 test. |
| 12 | NG12's parenthetical read as the full 25 skips. | NG12 now calls the listed commands examples of the TUI-only skips and references §9.3 for the full 25-command set. |
| 13 | D10 implied an automatic full degrade on any field-shape difference. | D10 now states the whitelist handles a field-shape difference when possible; otherwise the source degrades (Hanse-only or `unavailable`, per §6.5), consistent with §6.5. |
| 14 | §18's "open-questions.md was not modified" was false at the repo level. | §18 now says this design revision did not edit it and that the orchestrator updated the owner-decision record separately to the verified 30-command inventory. |

### Phase-1 verification items carried forward

These are probes, not deferred design findings: v1/v2 route presence and shapes, `arguments` type,
`messageID` honoring, blocking, disconnect/abort behavior, missing-session and unknown-command
statuses, MCP template serialization, the exact shell grammar (inline/line-start/argument-injected),
the v2 `location[directory]` query, and the v2 `text` semantics. Only 1.18.35 was runtime-probed;
the 1.19.3 statements are source-read or marked verify.
