# Probe - opencode slash-command surfaces at the pinned version

Environment: `opencode-ai@1.19.3`, installed from npm into a throwaway `<PROBE_DIR>`
(`npm install --prefix <PROBE_DIR> --no-save --no-audit --no-fund opencode-ai@1.19.3`);
`<PROBE_DIR>/node_modules/.bin/opencode --version` printed **`1.19.3`**. A synthetic app at
`<APP_DIR>` (`<PROBE_DIR>/app`) held only synthetic project commands
(`.opencode/command/probe-*.md`, names `probe-hello`, `probe-inline`, `probe-linestart`,
`probe-multi`, `probe-noplaceholder`, `probe-argshell`, `probe-slow`). `opencode serve` ran on
loopback port `<PORT>` with `HOME` and every `XDG_*` directory under `<PROBE_DIR>`; no operator
provider credential was configured in that HOME (the turns completed against the instance default
model, which is irrelevant to the route and field evidence below). The cwd check and the MCP check
used separate throwaway XDG/HOME sets. Every shell block was benign (write a marker inside
`<PROBE_DIR>`); no destructive command was run, and no probe server was left running. Bodies below
are redacted to status, field names, and JSON types; templates and prompts are summarized, never
reproduced.

## Matrix

| ID | Probe | Result |
| --- | --- | --- |
| P0-1 | `GET /command` (no query) | **200 `application/json`**, top-level array (10 entries: 9 commands + 1 built-in skill). Fields as described below. |
| P0-2 | `GET /command` cwd check | cwd `<APP_DIR>`: 200, includes `probe-hello` and the other project commands. Second server with cwd `<PROBE_DIR>`: 200, array of 3 (built-ins + built-in skill), `probe-hello` **absent**. The list is project/cwd-scoped. |
| P0-3 | `POST /session`, then `POST /session/<SESSION_ID>/command` | Session 200 (id `ses...`). Send 200 `{info, parts}`; `arguments` is a string; `messageID` is applied to the user message (and echoed as assistant `info.parentID`); the call **blocks until the turn completes**. |
| P0-4 | Client disconnect during a blocking command | No abort and no error route: the client socket was killed after ~2 s, while the turn continued, wrote its shell marker, and finished (`time.completed`, `finish:"stop"`). |
| P0-5 | `GET /api/command`; `POST /api/session/<SESSION_ID>/command` | List **present**: 200, but body is an **object** `{location, data}` (not an array); `data` is an array of length **0**, with or without `?location[directory]=<APP_DIR>`. Send **absent**: not in `/doc`; live POST (existing and missing session) returns 200 `text/html` SPA fallthrough, no `204`. |
| P0-6 | Missing session / unknown command | v1 missing session: **404** `{"name":"NotFoundError","data":{"message":"Session not found: <SESSION_ID>"}}`. v1 unknown command on an existing session: **500** `{"name":"UnknownError","data":{"message":"Unexpected server error. Check server logs for details.","ref":"err_<REDACTED>"}}`, and the session message count did not change (no turn). v2 send route absent, so its session/command validation does not exist. |
| P0-7 | MCP prompt serialization | 200; MCP entry `name: "probe:probe-mcp-prompt"`, `source: "mcp"`, `template` is a JSON **object `{}`** (not string/null/absent), `hints: ["$1"]`, description string; `agent`/`model`/`subtask` keys absent. |
| P0-8 | Shell grammar | Inline, line-start, and multiple blocks all ran. Argument-injected blocks ran through a `$ARGUMENTS` template **and** through a template with no placeholder (arguments appended). Details below. |
| P0-9 | Missing route / non-array / oversized | Missing route: 200 `text/html` SPA fallthrough (not 404/405). Non-array: `/api/command` object wrapper (P0-5). Oversized request: 2 MiB and 12 MiB `arguments` accepted with no 413; empty body 400 `BadRequest` `Payload`; wrong content type 415 `text/plain`. Oversized **list** body is server-generated and was not inducible. |
| P0-10 | `GET /doc` | 200 OpenAPI 3.1.0. Documents `GET /command` and `POST /session/{sessionID}/command`; documents `GET /api/command` but **no** `/api/session/{sessionID}/command`. |

## P0-1 - v1 list shape

`GET /command` (no query) returned 200 and a top-level JSON array. Observed fields:

- `name`: string.
- `description`: string (present on every entry in this probe).
- `source`: `"command"` for file/built-in commands, `"skill"` for the built-in skill; `"mcp"` in P0-7.
- `template`: **string** for commands and skills. (The MCP case is the non-string exception, P0-7.)
- `hints`: `string[]` on every entry. Empty `[]` for templates without placeholders;
  `["$ARGUMENTS"]` for templates containing `$ARGUMENTS`; `["$1"]` for the MCP prompt.
- `agent`, `model`, `subtask`: file commands carry these keys as JSON `null` when unset; built-in
  commands and the skill omit the keys; one built-in command had `subtask: true`. The synthetic app
  configured no non-null `agent`/`model`, so no non-null normalization sample exists.
- The list also contains upstream built-ins (`init`, `review`, one built-in skill) next to project
  commands; a `source`-filtered merge is required, not a "project commands only" assumption.

## P0-2 - cwd scoping

- cwd `<APP_DIR>`: 200 array containing `probe-hello` (and the other synthetic project commands).
- Second server, cwd `<PROBE_DIR>`: 200 array of 3 entries (built-in commands + built-in skill);
  `probe-hello` absent.

Conclusion: `GET /command` without a query is scoped by the server cwd, so the Hanse v1 call must
keep the instance cwd at the app directory and must not pass `directory`/`workspace`.

## P0-3 - send contract

- `POST /session` with `{}` returned 200 and a session object (`id` prefix `ses`, plus
  `slug`, `projectID`, `directory`, `path`, `cost`, `tokens`, `title`, `version`, `time`).
- `POST /session/<SESSION_ID>/command` with `{"command":"probe-hello","arguments":"PROBEARG","messageID":"msg_<REDACTED>"}`:
  - 200 `application/json`, body `{info, parts}`.
  - `arguments`: JSON **string** accepted; the command ran (marker/turn observed).
  - `messageID`: **applied**. The user message fetched from
    `GET /session/<SESSION_ID>/message` has `id` equal to the supplied `messageID`, and the
    assistant response's `info.parentID` equals it. The response `info.id` is the assistant's own
    id, so the supplied id is not echoed as `info.id`.
  - `info`: assistant message with `id`, `sessionID`, `role:"assistant"`,
    `time.created`/`time.completed`, `parentID`, `modelID`, `providerID`, `mode`, `agent`, `cost`,
    `tokens`, `finish`, and optionally `path`.
  - `parts`: array of part objects; observed `type` values `step-start`, `reasoning`, `tool`,
    `text`, `step-finish`.
- **Blocking**: the response arrived only after the turn finished (`time.completed` set,
  `finish:"stop"`). A `probe-slow` command with a `sleep 5` shell block returned after ~7.2 s with
  its marker already written. The route is blocking, not fire-and-forget.

## P0-4 - client disconnect

Started the blocking `probe-slow` command, then killed the client after ~2 s. The client observed a
dropped connection (no status). Upstream the turn **continued**: the shell marker was written, the
session gained a user message and a completed assistant message (`time.completed`, `finish:"stop"`).
Disconnecting the client does not abort the upstream turn in this probe.

## P0-5 - v2 surfaces

- `GET /api/command` (no query) and `GET /api/command?location[directory]=<APP_DIR>` both:
  - 200 `application/json`
  - body is an **object**, keys `{location, data}`
  - `data` is an array of length **0**
  - `location` is an object with keys `{directory, project}`
- `POST /api/session/<SESSION_ID>/command` (existing session and missing session, with
  `Accept: application/json`): **no route**. The response is 200 `text/html`, the web-UI SPA
  fallthrough, identical to an unknown API path (P0-9). There is no 204 and no turn.
- Because the send route is absent, the design's `text` semantics question (raw arguments vs
  `/name args`) is not applicable and was not probed.

## P0-6 - error behavior

| Request | Status | Body class | Turn started |
| --- | --- | --- | --- |
| `POST /session/<missing-ses>/command` | 404 | JSON `NotFoundError`, `data.message` names the session | no |
| `POST /session/<valid-ses>/command` with unknown command | **500** | JSON `UnknownError`, generic `Unexpected server error`, `data.ref` | **no** (message delta 0) |
| `POST /api/session/<sid>/command` | 200 | `text/html` SPA fallthrough (route absent) | no |

An unknown command is **500, not 404**. Phase 2 must not classify "unknown command" by 404. The
same server answers unknown routes with a 200 SPA page, so route absence must be judged from
`/doc` plus the fallthrough, not from a 404/405.

## P0-7 - MCP template serialization

A probe-only stdio MCP server (source not committed) answered `initialize`, `prompts/list`, and
`prompts/get`, and was registered in `<APP_DIR>/opencode.json`. `GET /command` then returned 11
entries including:

```
name:      "probe:probe-mcp-prompt"   (server-name:prompt-name)
source:    "mcp"
template:  {}                          (JSON object, empty)
hints:     ["$1"]
description: string
agent/model/subtask: absent
```

So an MCP prompt's template is a **non-string** JSON value (`{}`), confirming that the Hanse
boundary must treat any non-string/absent template as `shell: "unknown"`.

## P0-8 - shell grammar

Each template was a synthetic project command; each shell block wrote a unique marker.

| Case | Result |
| --- | --- |
| Inline ``prefix !`cmd` suffix`` | 200; marker written; the user text seen by the turn was `prefix  suffix` (block replaced). |
| Line-start ``!`cmd` `` block | 200; marker written. |
| Two blocks in one template | 200; **both** markers written. |
| `$ARGUMENTS` template, arguments contain ``!`cmd` `` | 200; marker written while the POST was still open (~2 s); user text `Probe pre  post`. |
| Template **without** a placeholder, same arguments | 200; marker written while the POST was still open (~2 s); user text `No placeholder shell\n\npre  post`, i.e. arguments were appended and then scanned. |

Conclusion: the exact pattern runs anywhere in the template; inline and line-start blocks both
execute; multiple blocks all execute; and an argument-injected block executes both through a
`$ARGUMENTS` template and through a template with no placeholder. The Hanse argument scan is
necessary for both template forms.

## P0-9 - route and body extremes

- Missing route `GET /commandz`: 200 `text/html` SPA fallthrough.
- Missing API route `POST /api/session/<SESSION_ID>/nope`: 200 `text/html` SPA fallthrough.
- Non-array body: the v2 list returns an object wrapper `{location, data}` (P0-5). The v1 list is an
  array. A v1 parser that requires an array correctly rejects the v2 shape.
- Empty body `{}` on the v1 send: 400 `{"name":"BadRequest","data":{"message":"Missing key\n  at [\"arguments\"]","kind":"Payload"}}`.
- Wrong content type (`application/x-www-form-urlencoded`): 415 `text/plain`,
  `Unsupported content-type: ...`.
- Oversized request: 2 MiB and 12 MiB `arguments` values were accepted by the HTTP/JSON layer (no
  413); with an unknown command the eventual response was the 500 `UnknownError`. No upstream
  request-size rejection was observed at 12 MiB.
- Oversized **list** body: not inducible from the outside (server-generated), so the Hanse 4 MiB
  list cap remains a client-side guard rather than a probed upstream limit.

## P0-10 - `/doc` path templates

`GET /doc` returned 200 `application/json`, OpenAPI 3.1.0. Command-related paths:

| Path | Method / operationId | Notes |
| --- | --- | --- |
| `/command` | GET / `command.list` | optional `directory`, `workspace` queries; 200 array of `Command`; 400 |
| `/session/{sessionID}/command` | POST / `session.command` | optional `directory`, `workspace`; body `{command, arguments, messageID?, agent?, model?, variant?, parts?}`; `command` + `arguments` required; `additionalProperties:false`; 200 `{info, parts}`; 400/404 |
| `/api/command` | GET / `v2.command.list` | optional `location` deepObject `{directory, workspace}`; 200 `{location, data}` of `CommandV2Info`; 400/401 |
| `/api/session/{sessionID}/command` | - | **absent** |

The v1 send request schema matches the design's `{command, arguments, messageID}` shape (the extra
optional fields are not needed by Hanse). The v2 send route is not in the document.

## Decision

Decision: v1

Justification by row:

- **P0-10** documents both v1 routes (`GET /command`, `POST /session/{sessionID}/command`) and only
  the v2 **list** route.
- **P0-1** confirms the v1 list is live: 200, top-level array, with `template: string`,
  `hints: string[]`, `source`, and nullable `agent`/`model`/`subtask`.
- **P0-3** confirms the v1 send is live: 200 `{info, parts}`, string `arguments`, applied
  `messageID`, and blocking-until-completion.
- **P0-5** confirms the v2 pair is **incomplete**: the list is present but returns an object wrapper
  with an empty `data` array, and the send route is absent (SPA fallthrough). A complete v1 pair is
  present, so v1 wins; v2 is not implemented.

Field-shape notes for phases 1-2 (not a branch change): `agent`/`model`/`subtask` may be JSON
`null` (file commands) or absent (built-ins/skill/MCP); an MCP template is `{}` (non-string);
an unknown command is **500**, not 404; and unknown routes fall through to a 200 SPA page.

Blocked rows: none. Partial evidence: P0-9's oversized **list** body is not inducible; P0-1 has no
non-null `agent`/`model` example because the synthetic app configured neither.
