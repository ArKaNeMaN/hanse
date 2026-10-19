# Design - Interactive prompts, plan/Todo panel, and app-scoped permission policy

Status: implemented and verified (2026-10-19); see
[`docs/journal/0005-interactive-prompts.md`](../journal/0005-interactive-prompts.md). The design was
approved with changes (Oracle PASS-WITH-CHANGES after two review rounds; Momus plan review OKAY),
and all owner decisions are closed.

## Summary

opencode 1.19.3 can block an agent turn on a `question` tool call or a permission request. Hanse's
Web UI currently receives the upstream SSE stream but discards every event payload, so those prompts
are invisible and the agent waits forever. The session Todo list (the plan the TUI shows in its
sidebar) is also invisible. In addition, the instance config overlay does not set permissions, so
OMO's global `external_directory: "allow"` leaves agents able to read outside their application
directory.

This design adds:

1. a human-only, app-scoped prompt API and a typed app-level SSE stream;
2. interactive question and permission docks above the composer;
3. a read-only Plan (Todo) panel in the context rail, with a compact chip below 1360;
4. an explicit permission overlay that denies paths outside the app directory, while allowing
   questions, Todo tools, network, and `.env`, and preserving the trusted directories needed by
   skills and tool-output truncation;
5. `GIT_CEILING_DIRECTORIES` per instance so a nested app directory cannot silently widen the
   opencode worktree to a parent repository.

The permission policy is a guardrail, not a sandbox. Prompt control is enforced at the Hanse API;
the coordinator strips its own credentials from the instance environment. Because the loopback
opencode API is unauthenticated and the agent runs as the same uid, this is not a hard boundary
against a determined agent: the agent can still read `/proc/<coordinator-pid>/environ`, mounted
files, or the coordinator DB, and can call the upstream API directly. Both v1 and v2 prompt events
are supported. Policy verification surfaces warnings; by owner decision it does **not** block
startup.

## Context and scope

### Current behaviour

- `src/opencode/client.ts:30-62` only lists/creates/deletes sessions and reads/sends messages.
- `src/http/chat.ts:312-372` proxies upstream `GET /event` byte-for-byte.
- `assets/chat.js:712-735` opens an `EventSource` and uses `onmessage = () => scheduleReload()`, so
  `question.*`, `permission.*`, and `todo.updated` payloads are ignored.
- `POST /api/apps/:app/sessions/:sid/messages` awaits `sendPrompt` (`src/http/chat.ts:456-464`),
  which is a blocking opencode request. While a prompt is pending, the composer stays "Working" and
  the user has no control.
- `src/opencode/instance.ts:85-113` builds an overlay with plugins, MCP servers, and instructions
  only. OMO 5.1.35 sets global `external_directory: "allow"` in its config hook, so the effective
  policy permits access outside the app directory.
- The session Todo list is available upstream as `GET /session/{id}/todo` and `todo.updated`, but
  Hanse neither reads nor renders it.

### Requirements

- R1: A question from an agent must be visible and answerable without a page reload, including
  multi-question, multi-select, and custom-answer requests.
- R2: Pending questions and permissions must be recoverable after page load, session switch, or SSE
  reconnect.
- R3: A permission request must show its type, patterns, and bounded metadata, and support
  `once`/`always`/`reject` with optional feedback.
- R4: Paths outside the app directory must be denied, not asked. Questions, Todo tools, network, and
  `.env` must be allowed. Trusted runtime directories needed by skills, references, and truncation
  must keep working.
- R5: The active session's Todo list must be visible and update live.
- R6: Hanse's prompt/Todo/event routes must be human-only; agent principals receive `403`. The
  coordinator must not expose its own credentials to the instance environment. A hard boundary
  against the unauthenticated loopback opencode API and a same-uid agent is out of scope and is
  called out as an owner decision.
- R7: The Web UI only. The VS Code extension is out of scope.

## Goals and non-goals

### Goals

- G1: Within 1 s of `question.asked`, the dock shows the request; answering it lets the blocked turn
  continue.
- G2: On page load or SSE reconnect, all pending questions/permissions for the app are restored,
  including requests from non-active sessions.
- G3: A permission request renders type, patterns, and bounded metadata, and replies using
  `once`/`always`/`reject` plus optional feedback.
- G4: The effective ruleset for managed instances has `external_directory` deny with the trusted
  allowlist, and allows `question`, `todowrite`, `todoread`, `webfetch`, `websearch`, and `.env`.
- G5: Within 1 s of `todo.updated`, the active session's Plan panel updates; `GET .../todo` restores
  it after a reconnect.
- G6: The prompt dock remains interactive while the originating message POST is pending.
- G7: Agent principals receive `403` on the new prompt/Todo/event routes. The pre-existing raw
  session SSE route keeps its current principal model for compatibility.
- G8: `npm run lint`, `npm run typecheck`, `npm test`, and `npm run build` stay green.

### Non-goals

- NG1: No plan-markdown browser. "Plan" means the session Todo list, not `.omo/plans/*.md` or
  `.opencode/plans/*.md`.
- NG2: No Todo writes, reordering, or checking items from the UI. The panel is read-only.
- NG3: No durable prompt inbox, SQLite prompt registry, or audit trail.
- NG4: No plan-mode feature. `plan_enter`/`plan_exit` stay at opencode defaults (deny); native
  build/plan agent switching is not added.
- NG5: No cross-application prompt inbox. The indicator covers the current app instance only.
- NG6: No VS Code extension changes.
- NG7: No new UI framework, bundler, or runtime dependency.
- NG8: No claim that the permission policy is a sandbox.
- NG9: No hard isolation or upstream authentication. If the owner requires the agent to be unable
  to call the loopback opencode API or to read coordinator credentials, that needs a separate
  isolation design (separate uid/container, authenticated upstream, or a proxy the agent cannot
  reach).

## Design

### 1. Architecture overview

```
browser (chat.js)
  |  GET /api/apps/:app/prompts            (human)
  |  POST .../questions/:id/reply|reject   (human)
  |  POST .../permissions/:id/reply        (human)
  |  GET .../sessions/:sid/todo            (human)
  |  GET .../events (typed SSE)            (human)
  v
Hanse HTTP (src/http/prompts.ts)
  |  listQuestions / replyQuestion / rejectQuestion
  |  listPermissions / replyPermission
  |  listTodos
  |  /event parser + projector (src/opencode/events.ts)
  v
opencode serve (127.0.0.1:4100+)
```

Decisions:

- **Server-side SSE parsing.** A new app-scoped stream parses upstream `/event` and emits a small
  typed vocabulary. The existing session SSE route remains raw for compatibility.
- **Client-owned prompt state.** The server stays stateless. The browser hydrates from the list
  endpoints and applies SSE events. A bounded event log covers hydration races.
- **App-scoped prompts, session-scoped Todo.** Upstream prompt lists span all sessions of one
  instance; upstream Todo is per session.
- **Human-only control.** Prompt/Todo/event routes reject agent principals with `403`. The
  coordinator strips `HANSE_OPERATOR_TOKEN`, `OPENCODE_PERMISSION`, and other coordinator secrets
  from the child environment. This is a Hanse-route guarantee, not a boundary against the
  unauthenticated loopback opencode API.
- **Blocking send stays.** `sendPrompt` remains blocking; the dock uses independent requests and
  must not share the composer's `sending` lock.
- **Current-app indicator.** The top-bar count covers only the current app instance.
- **Verify-and-warn policy check.** After an instance starts, the effective `/agent` ruleset of
  every non-hidden agent is checked. A confirmed mismatch is logged and exposed as a warning in
  `/prompts`; the app remains available (owner decision). The policy is best-effort, not fail-closed.
- **v1 and v2 prompts.** Both v1 and v2 question/permission events are surfaced. The normalized
  request carries `source: "v1" | "v2"`; replies use the matching upstream endpoint (v2 replies are
  session-scoped and `always` is durable/project-scoped).

### 2. Upstream contract (verified against opencode-ai 1.19.3)

| Surface | Contract |
| --- | --- |
| `GET /question` | `QuestionRequest[]` |
| `POST /question/{requestID}/reply` | `{ answers: string[][] }` -> `boolean` |
| `POST /question/{requestID}/reject` | -> `boolean` |
| `GET /permission` | `PermissionRequest[]` |
| `POST /permission/{requestID}/reply` | `{ reply: "once"\|"always"\|"reject", message?: string }` -> `boolean` |
| `GET /session/{sessionID}/todo` | `Todo[]` |
| `GET /event` | SSE frames `data: {"id":"evt_...","type":"...","properties":{...}}` |

QuestionRequest: `{ id: "que_...", sessionID, questions: [{ header, question, options: [{label,
description}], multiple?, custom? }], tool? }`. `custom` defaults to true.

PermissionRequest: `{ id: "per_...", sessionID, permission, patterns: string[], metadata: object,
always: string[], tool? }`. `always` is the exact pattern set an `always` reply grants.

Todo: `{ content, status: string, priority: string }`. The known values are `pending`,
`in_progress`, `completed`, `cancelled` and `high`, `medium`, `low`; upstream does not enforce the
unions, so unknown values render as `Unknown`/neutral.

Events used: `question.asked`, `question.replied`, `question.rejected`, `permission.asked`,
`permission.replied`, `todo.updated`, plus the v2 variants below. Unknown events with a session ID
become `session.activity`.

**v2 prompts are supported in this stage.** They use a separate pending map and a separate API
surface; reply through v1 would 404. `/event` carries v2 events with `properties` because
`EventV2Bridge` projects `event.data` into the legacy envelope, so one upstream SSE stream is
enough.

| v2 surface | Contract |
| --- | --- |
| `GET /api/question/request` | `{ location, data: QuestionV2Request[] }` |
| `POST /api/session/{sessionID}/question/{requestID}/reply` | `{ answers: string[][] }` |
| `POST /api/session/{sessionID}/question/{requestID}/reject` | - |
| `GET /api/permission/request` | `{ location, data: PermissionV2Request[] }` |
| `POST /api/session/{sessionID}/permission/{requestID}/reply` | `{ reply: "once"|"always"|"reject", message? }` |
| `GET /api/permission/saved` | `{ data: PermissionSavedInfo[] }` |
| `DELETE /api/permission/saved/{id}` | revoke a saved permission |

V2 question fields match v1 (`id`, `sessionID`, `questions`, `tool`). V2 permission fields are
`{ id, sessionID, action, resources, save?, metadata?, source? }`; normalize `action` -> `permission`,
`resources` -> `patterns`, `save` -> `always`, and `source` -> `tool`. V2 `always` writes a durable,
project-scoped saved permission (`PermissionSaved`) and can be revoked; it can auto-resolve matching
pending requests across sessions, not only the originating session. V2 `reject` still cascades to
pending permissions in the same session.

V2 list calls pass `location: { directory: appDir }` (the server's default is the process cwd, but
being explicit keeps the query stable). `GET /api/permission/saved` is called without `projectID`
because Hanse runs one opencode instance per app; the upstream `projectID` is displayed in the Saved
permissions row rather than forwarded as Hanse's project id. Saved permissions are a separate
durable store, not rules appended to the config ruleset; the implementation must verify their
evaluation order against config denies and the UI copy must say they can override the policy, not
that they are "appended".

Normalized Hanse prompts carry `source: "v1" | "v2"`. Events keep the Hanse names
(`question.asked`, `permission.asked`, etc.) with `request.source` set; the raw v2 event names are an
implementation detail of the parser. Maps, drafts, and tombstones are keyed by `${source}:${id}` so a
v1/v2 ID collision cannot cross-wire a reply.

Metadata availability is narrower than a generic "show everything" UI implies. Verified in 1.19.3:
`edit` has `filepath` and `diff`; `read` metadata is `{}` (the path is in `patterns`); `bash` has
`command` (no cwd); `webfetch` has `url`/`format`/`timeout` (no method); `external_directory` has
`filepath`/`parentDir`; `doom_loop` has `tool`/`input` (no count). The dock renders the fields that
exist and never promises missing ones.

### 3. Hanse HTTP API

All routes are under `/api/apps/:app`, accept the existing optional `?project=<projectId>`, and are
human-only. Authentication pattern: `principalFrom`; missing principal -> `401`; principal exists but
is not human -> `403`. This matches session deletion (`src/http/chat.ts:409-418`). The order is
`401 -> 403 -> 503 -> 404`: an agent must not be able to probe app existence or runtime availability.

| Method | Path | Body / query | Success | Errors |
| --- | --- | --- | --- | --- |
| GET | `/api/apps/:app/prompts` | `?project=` | `{ questions, permissions, truncated, warnings? }` | 401, 403, 404, 502, 503 |
| POST | `/api/apps/:app/questions/:requestId/reply` | `{ source: "v1"\|"v2", answers: string[][] }` | `{ ok: true }` | 400, 404, 502 |
| POST | `/api/apps/:app/questions/:requestId/reject` | `{ source }` | `{ ok: true }` | 400, 404, 502 |
| POST | `/api/apps/:app/permissions/:requestId/reply` | `{ source, reply, message? }` | `{ ok: true }` | 400, 404, 502 |
| GET | `/api/apps/:app/permissions/saved` | `?project=` | `{ permissions }` | 401, 403, 404, 502 |
| DELETE | `/api/apps/:app/permissions/saved/:savedId` | `?project=` | `{ ok: true }` | 401, 403, 404, 502 |
| GET | `/api/apps/:app/sessions/:sid/todo` | `?project=` | `{ todos, truncated }` | 401, 403, 404, 502, 503 |
| GET | `/api/apps/:app/events` | `?project=` | `text/event-stream` | 401, 403, 404, 502, 503 |

Common behaviour:

- Resolve the app with `findApp(deps, projectParam(request), appKey)`; unknown app -> `404`.
- `deps.manager === undefined` -> `503 { error: "agent runtime is not configured" }`.
- Instance start failure or an upstream failure -> `502`.
- POST bodies must be `content-type: application/json`; otherwise `415`. Malformed JSON -> `400`.
- Error bodies remain `{ error }`; a `code` field is additive (`prompt_expired`,
  `invalid_answers`, `invalid_permission_reply`, `session_not_found`, `prompts_unavailable`,
  `invalid_source`). A policy mismatch is a warning, not an HTTP error (owner decision).
- The new routes are dispatched from `src/http/server.ts` **before** the `isChat` catch-all. The app
  SSE route needs the raw `ServerResponse` and is special-cased like `streamSessionEvents`; the
  prompt/Todo routes are routed to `handlePrompts` before `handleChat` (which would otherwise 404).
- `src/opencode/client.ts` gains a typed `OpencodeHttpError` carrying `status` so the routes can
  distinguish upstream `404` (`prompt_expired`) from `502`.

`GET /prompts` calls the v1 question/permission lists and the v2 question/permission lists with
`Promise.allSettled`. Each successful source contributes to the merged arrays; each failed source
adds a warning. If all four fail, return `502`; otherwise return the available arrays plus
`warnings`. Warnings also carry runtime policy warnings. `source` is required on replies and must
match the pending request; an unknown/mismatched source is `400 invalid_source`. V2 replies use the
request's `sessionID` to build the session-scoped upstream path.

`GET /permissions/saved` and `DELETE /permissions/saved/:savedId` expose v2 durable saved
permissions. They are human-only. The UI shows them with the action/resource and a revoke action;
saved permissions can override the policy and must be visible to the operator.

Question reply validation (upstream does not validate):

1. Parse `answers` as `string[][]`; max 100 questions, 100 labels per question, 2,000 characters per
   label, 32 KB serialized total.
2. Re-fetch `listQuestions`; if the request is absent -> `404 prompt_expired`.
3. `answers.length` must equal `request.questions.length`.
4. Structural validation: `answers.length` must equal `questions.length`; each inner array may be
   empty (upstream uses `answers: [[]]` for "Unanswered") and no more than 100 labels.
5. If an answer array is non-empty: `custom === false` requires every label to be an option label;
   `multiple === false` requires exactly one label (an option or a custom answer; a custom answer
   replaces the selected option); `multiple === true` allows one or more labels, and a non-option
   label is accepted only when `custom === true`. Labels must be non-empty after trimming.
6. Deduplicate while preserving order, then forward `{ answers }`; map upstream 404 to
   `prompt_expired`, other failures to `502`.

Empty arrays are a supported outcome with confirmation: the dock asks "Send without answering?"
before submitting a question with no selected/custom answer. This matches upstream `Unanswered`
and the owner decision. A no-options/`custom:false` question can only be sent empty or dismissed.

Do not truncate a question, header, description, or option list. Cap header at 200 characters,
question text at 10,000, option label at 2,000, and option description at 4,000. If a request
exceeds the caps, set `tooLarge: true` (plus a bounded `tooLargeReason`) on the normalized request,
render a non-answerable card with `Dismiss` only (a >100-question request cannot send an aligned
empty answer), and show a warning; never return a truncated request whose answers would no longer
align. A question with `options: []` and `custom: false` can be sent empty (with the confirmation)
or dismissed.

Permission reply validation: `reply` must be `once|always|reject`; `message` is optional, max 4,000
characters, and only valid with `reject`.

### 4. App event stream

`GET /api/apps/:app/events?project=` returns `text/event-stream` with default SSE `message` frames
(no `event:` name, so `EventSource.onmessage` works):

```text
retry: 3000

data: {"type":"stream.ready"}

data: {"type":"question.asked","request":{...}}

data: {"type":"todo.updated","sessionID":"ses_...","todos":[...],"truncated":false}

: ping
```

Event vocabulary:

| Type | Payload |
| --- | --- |
| `stream.ready` | none; triggers hydration |
| `question.asked` | `{ request }` with `request.source` |
| `question.replied` | `{ sessionID, requestID, source }` |
| `question.rejected` | `{ sessionID, requestID, source }` |
| `permission.asked` | `{ request }` with `request.source` |
| `permission.replied` | `{ sessionID, requestID, reply, source }` |
| `todo.updated` | `{ sessionID, todos, truncated }` |
| `session.activity` | `{ sessionID }`; used only to debounce message reloads |
| `stream.warning` | `{ code, message? }` |

Parser rules: incremental `TextDecoder({stream:true})`; support `\n\n` and `\r\n\r\n` split across
chunks; concatenate multi-line `data:`; ignore comments/`id:`/`event:`/`retry:`; forward known v1
and v2 types. Normalize `question.v2.asked`/`permission.v2.asked` to the Hanse `question.asked`/
`permission.asked` events with `request.source = "v2"` and the v2 permission mapping
(`action`/`resources`/`save` -> `permission`/`patterns`/`always`). Normalize v2 replied/rejected
events with `source: "v2"`. Derive `session.activity` from unknown events when a session ID is
present; drop frames over 1 MiB and emit one warning per code; abort upstream on response close;
heartbeat every 15 s. Headers include `cache-control: no-cache, no-transform` and
`x-accel-buffering: no`.

`session.activity` extraction must cover the v1 payload shapes, not only `properties.sessionID`:
`properties.sessionID` (`session.status`, `session.idle`), `properties.info.sessionID`
(`message.updated`, `message.part.updated`), `properties.info.id` (`session.updated`), and
`properties.part.sessionID`. Otherwise live message reloads silently stop when the new stream
replaces the raw session stream.

Emit `stream.ready` only after the upstream `/event` response is open and the reader is attached.
This closes the gap between the client's hydration and the upstream subscription. If `response.write`
returns `false`, pause the upstream reader until `drain` to avoid unbounded buffering.

The existing raw `GET /api/apps/:app/sessions/:sid/events` route is unchanged; the new client no
longer uses it. It keeps `principalFrom` for compatibility; G7 applies only to the new routes.

### 5. Web UI

#### Placement

- **Question and permission docks:** thread footer, directly above the composer. In-flow, so they
  never cover messages and the thread remains the only page scroll owner. On mobile the dock body is
  capped (`min(50dvh, 22rem)`) and scrolls inside; the composer keeps its draft.
- **Plan (Todo):** context-rail section after Application and before Handoffs, matching the TUI
  sidebar. Below 1360, where the rail is a drawer, a compact `Plan 2/5` chip in the thread meta strip
  opens the drawer scrolled and focused to the Plan section. At >=1360 the section is visible and
  defaults expanded.
- **Global input indicator:** top-bar stamp with a count of pending requests in other sessions of
  the current app. Per-session stamp flags live in the sessions rail. Clicking the top-bar control
  opens a non-modal queue popover (bottom sheet below 640) that navigates to the blocked session.

The inline plan strip from the frontend exploration is rejected; the context rail is the TUI-parity
home, and the meta chip keeps it reachable when the rail becomes a drawer.

#### Policy warnings

`GET /prompts` returns `warnings` (policy mismatch, verification timeout, degraded source). Render
them as a dismissible `.policy-warning` banner above the thread/composer and a compact warning chip
in the top bar after dismissal. Hydrate warnings with prompts on boot and `stream.ready`; clear a
warning only when a refreshed `GET /prompts` no longer returns it. Warnings are text only (no
metadata values) and use `role="status"` (not an alert loop). This is the visible control for the
owner's warning-only policy decision.

#### Question dock

- One card per request. Header: `QUESTION`, `Question N of M`, queue count, collapse toggle.
- One question per view. Tabs on >=768 (`role=tablist`, answered tabs show a check, final
  `Review · N left`), stepper on <768. Multi-question requests get a Review step; a single question
  submits directly only when `multiple !== true`. A single multi-select question still uses a
  submit/Review step.
- Options are native radio/checkbox rows with label + description. Multi-select uses checkboxes.
  `custom` adds an `Other` row with a text input; `custom:false` removes it. Answers are sent in
  question order as `string[][]`. Every answerable question is answered by default; if one or more
  are unanswered, the primary action becomes `Send without answering` and opens a confirmation
  before sending empty arrays. A question with no options and `custom:false` offers `Send without
  answering` (with confirmation) and `Dismiss`. A request marked `tooLarge` offers `Dismiss` only,
  because its answer array cannot be aligned safely.
- `Dismiss` opens an inline confirmation and calls `reject`; it never silently hides the request.
- While submitting, controls are disabled and labelled `Sending answer…`; errors preserve answers
  and offer `Try again`; a 404 becomes the expired state.

#### Permission dock

- Header: `PERMISSION` plus a risk chip: word + 3-tick meter + glyph, never color alone.
- Title is outcome-shaped (`Allow the agent to run this command?`, etc.).
- Scope shows `This request:` and, when present, `Always grants:` using the event's `always`
  patterns. The scope sentence depends on the source:
  - v1: `For this app instance until restart.`
  - v2: `Saved for this project until revoked.` and a link/action to the Saved permissions section.
    The confirmation also says that v2 `always` may resolve matching pending permissions in other
    sessions of the same instance.
  If `always` is empty, `Always allow` is hidden with a reason. If the patterns are `["*"]`, say
  explicitly that it grants the **tool permission for all requests**. It does not bypass a separate
  `external_directory` check: for edit/read/write/apply_patch/glob/grep, paths outside the app still
  hit the external-directory policy. For bash, `always` is a set of parsed command globs, not paths
  or URLs.
- Evidence by type, using only fields the event provides: bash `command` (no cwd); edit
  `filepath` + compact diff (`+`/`-` prefixes); read path from `patterns` (no line range);
  webfetch `url` (no method); external_directory `filepath`/`parentDir` + warning; doom_loop
  `tool`/`input` (no count); custom tool name + collapsed JSON args. Missing fields are omitted,
  not invented. All text is inserted with `textContent`.
- Actions: `Deny` (danger ghost) at the start, `Always allow` and `Allow once` at the end. `Always`
  and `Deny` expand inline confirmations; deny accepts optional feedback. The order never changes by
  risk.
- A `reject` also rejects other pending permissions in the same session upstream. The card says so
  before the decision. Feedback applies only to the originating request; cascaded rejects carry no
  feedback. `always` is different: a v1 grant is instance-wide until restart; a v2 grant is durable
  and project-scoped (and can be revoked). Approved/saved rules are appended after the config
  ruleset, so a narrow deny can be overridden by a broad `always` on the same tool. The
  confirmation names the scope and the exact grant.

#### Plan (Todo) panel

- Read-only ordered list from `GET .../todo`, updated by `todo.updated`.
- Status glyph + text: pending = clock/`Pending`; in_progress = activity/`Now`; completed =
  check/`Done`; cancelled = slash/`Dropped`; unknown values render a neutral `Unknown`. Preserve
  upstream order. Only the first `in_progress` item gets `aria-current="step"`.
- Priority: 3-tick meter (high/medium/low/unknown) with a title and visually hidden label. Unknown
  values render neutral.
- Progress: `completed / (pending + in_progress + completed)`; cancelled is excluded from the
  denominator and shown as `· N cancelled`. If the denominator is 0, show `No active steps`, not
  `All steps complete`. Text is accessible; the meter is `aria-hidden`.
- Fetch on every session switch (and on boot/`stream.ready`); guard a stale response for the
  previous session.
- Empty: `No plan yet`; draft/no session: `Send a message to start a session.`; all done: `All steps
  complete`; paused stream: `Not updating`.
- The list is capped at `14rem` with its own scroll inside the context rail; content wraps and is
  never truncated.

#### Saved permissions (v2)

- A context-rail section listing durable v2 saved permissions: action, resource, upstream
  `projectID`, and a revoke action (`DELETE /permissions/saved/:id`).
- Human-only; a revoke is confirmed inline. The section is hidden when empty.
- Each saved permission is a policy override; show a warning that it applies to the project until
  revoked. This is the management surface for v2 `Always allow`.
- Refresh the list on `stream.ready` and after any v2 `always` or revoke; show a small badge/toast
  when a new saved permission appears, because an agent can create one directly through the
  upstream API.

#### Blocking send and sessions

- Replace the global `sending` boolean with a per-session pending-send map. The composer is busy only
  for the active session's own send.
- The dock is independent of the send lock and stays interactive while the originating POST is
  pending.
- The meta strip shows `Waiting for you` (stamp glyph) instead of `Working` while a prompt is
  pending. The composer keeps the draft, disables send, and shows
  `Answer the request above to continue.`
- Switching sessions keeps the old POST alive, updates rail flags, and renders the active session's
  oldest pending request. Draft answers are cached by request id.
- Refactor every `sending` call site (`sendPrompt`, `removeSession`, new-session buttons,
  `ensureSession`, `renderSessions`). A pending send in session A must not block creating/deleting in
  session B, and `sendPrompt` completion must call `loadMessages` for the session that was sent, not
  the currently active one.

#### Reconnect, expiry, and races

- On boot and on `stream.ready`, fetch `/prompts` and the active session's todo. On reconnect, also
  reload messages silently. Guard both with a hydration sequence so an older response cannot
  overwrite a newer one.
- Keep a bounded prompt event log (last 100 events, monotonic sequence) and replay events that
  arrived during a hydration fetch. If the oldest retained sequence is newer than the hydration
  start (overflow), discard the replay and re-fetch instead.
- Keep a per-tab resolved-request set (request ID -> timestamp, pruned after 10 minutes) and apply
  it after every hydration. Record a tombstone for **every terminal outcome**: successful
  reply/reject, a 404 (already answered/expired), and a received `question.replied`,
  `question.rejected`, or `permission.replied`. This prevents an in-flight hydration response from
  resurrecting a request that was resolved locally while the event was lost. Remove a tombstone if a
  fresh `question.asked`/`permission.asked` for the same ID arrives. If a stalled hydration outlives
  the TTL, keep the tombstone until that hydration generation is superseded or a fresh list confirms
  the request is gone. Cross-tab caveat: tombstones are per-tab, so a lost event plus an in-flight
  hydration in another tab can resurrect until a stale reply 404s.
- A reply 404 -> `Already answered or expired` and remove the card. A
  `question.replied`/`permission.replied` event for an open card -> `Answered elsewhere` and exit.
- Instance restart loses pending prompts and `always` approvals; todos persist and recover via GET.
- SSE failures do not expire cards. After three errors the existing `Paused` state appears; Retry
  reconnects and hydrates.
- If a prompt list fetch fails while the stream is live, keep the last known cards and show
  `Not updating` rather than clearing them.

#### Accessibility and copy

- Dock `role="region"` + labelled heading; question `<fieldset>`/`<legend>`; native inputs; tabs with
  roving tabindex; one polite announcer for arrival/submit/answered-elsewhere/plan summary; errors
  with `role="alert"`.
- No focus stealing when the composer has a non-empty draft; otherwise focus the dock's first
  control. On success/expiry/dismiss, return focus to the composer; on session switch, focus the dock
  heading or composer.
- Escape cancels inline sub-steps and closes the queue/drawers; it never rejects a request. `Ctrl`/
  `Cmd+Enter` submits the current valid step. 44 px controls below 768; reduced-motion mode uses
  opacity only.
- Copy is terse and outcome-oriented (for example `Allow once`, `Always allow`, `Deny request`,
  `Sending answer…`, `Request expired`).

### 6. Permission policy

#### Overlay

Add a `permission` field to `BuildOverlayOptions`/`OpencodeOverlay` and build it in
`buildInstanceEnv`. Do not use the `"permission": "allow"` shorthand and do not add a top-level
`"*": "allow"`; opencode defaults already allow tools, and an explicit `*` would override OMO's
intentional denies.

`buildInstanceEnv` starts from `process.env`. Strip `HANSE_OPERATOR_TOKEN`, `OPENCODE_PERMISSION`,
`HANSE_API_BASE`, `HANSE_AUTH_FILE`, `HANSE_DB`, `HANSE_STATE_HOME`, and any other coordinator-only
secret **after** the `input.baseEnv` spread, so an embedding/test env cannot reintroduce them. The
coordinator MCP server still receives its own `HANSE_DB`, `HANSE_PROJECT_ID`, and `HANSE_APP_KEY`
through the explicit `mcp.hanse.environment` entry; it does not need the parent process environment.
`OPENCODE_PERMISSION` is applied after `OPENCODE_CONFIG_CONTENT` by opencode and would silently
re-enable external access if inherited.

This scrub does not stop a same-uid agent from reading the coordinator's `/proc/<pid>/environ`,
mounted deployment files, or the coordinator DB. The Hanse-route guarantee is not a same-uid
boundary; hard isolation (separate uid/container, authenticated upstream, or a proxy the agent
cannot reach) is a separate stage (owner decision 1).

```ts
const external: Record<string, "allow" | "deny"> = { "*": "deny" };
for (const root of allowRoots) {
  external[path.posix.join(root.replaceAll("\\", "/"), "*")] = "allow";
}
return {
  external_directory: external,
  question: "allow",
  todowrite: "allow",
  todoread: "allow",
  webfetch: "allow",
  websearch: "allow",
  read: {
    "*.env": "allow",
    "*.env.*": "allow",
    "*.env.example": "allow",
  },
  edit: {
    "*.env": "allow",
    "*.env.*": "allow",
    "*.env.example": "allow",
    "opencode.json": "deny",
    "opencode.jsonc": "deny",
    "*/opencode.json": "deny",
    "*/opencode.jsonc": "deny",
    ".opencode/opencode.json": "deny",
    ".opencode/opencode.jsonc": "deny",
    "*/.opencode/opencode.json": "deny",
    "*/.opencode/opencode.jsonc": "deny",
    ".opencode/plugin/*": "deny",
    ".opencode/plugins/*": "deny",
    "*/.opencode/plugin/*": "deny",
    "*/.opencode/plugins/*": "deny",
  },
  doom_loop: "ask",
};
```

Order is load-bearing: `"*": "deny"` is inserted first, then every allow root. opencode evaluates
permission rules in insertion order and the last match wins, so the later allows must follow the
deny.

The `read` object deliberately has no `"*": "allow"`: opencode's defaults already allow reads, and
adding a user-level `*` allow would also override a project/OMO read deny for every path. Only the
`.env` allows are appended, because the owner explicitly wants `.env` always readable. All other
read denies keep their order before the `.env` allows.

The `edit` object explicitly allows `.env`/`.env.*` before the config/plugin denies; this makes the
owner's read+write decision explicit and also overrides a project-level `.env` edit deny. It does not
overlap the denied config/plugin paths.

The `edit` deny rules are duplicated in bare and `*/`-prefixed forms because opencode asks with a
**worktree-relative** path. When `worktree === appDir`, the bare form matches. When the app is
non-git (`worktree="/"`) or the ceiling fails and the worktree is a parent, the relative path
includes the app prefix, so `*/opencode.json` and `*/.opencode/...` match it. Test all three cases:
app-as-worktree, non-git app, and nested app.

#### Trusted external roots

| Purpose | Pattern |
| --- | --- |
| opencode tool-output truncation | `<XDG_DATA_HOME>/opencode/tool-output/*` |
| git reference cache | `<XDG_DATA_HOME>/opencode/repos/*` |
| temp files | `${os.tmpdir()}/opencode/*` |
| per-instance config skills | `<XDG_CONFIG_HOME>/opencode/skills/*` |
| downloaded skill cache | `<XDG_CACHE_HOME>/opencode/skills/*` |
| user Claude skills | `<HOME>/.claude/skills/*` |
| user Agents skills | `<HOME>/.agents/skills/*` |
| bundled plugin skills | `<plugin-root>/skills/*` for each `file://` baseline plugin |

The plugin skill root is derived from `baselinePlugins`: parse `file://` URLs (URL-decode the
pathname), skip non-`file://` specs, and append `skills`. If the directory does not exist the rule is
harmless. Local references and arbitrary `skills.paths` outside these roots are denied; this is a
documented limitation.

**App-owned config and plugins are a residual bypass.** A project `opencode.json` or plugin can
add an allow rule that survives the deep merge (an earlier specific key can remain in the ruleset
after the overlay's `"*": "deny"`), or modify config at runtime; the app directory is agent-writable,
so the agent can write those files. Verification runs at startup only, and the owner chose
warning-only, so a later runtime change is not detected. The overlay adds `edit` deny rules for the app root
`opencode.json`/`opencode.jsonc`, `.opencode/opencode.json*`, and `.opencode/plugin*`/
`.opencode/plugins/*` (owner decision). This is defense-in-depth, not a boundary: `bash` can write
the same files regardless of the `edit` permission. The verification warning is the honest signal;
do not describe the policy as a sandbox.

#### Worktree boundary

Set `GIT_CEILING_DIRECTORIES` to the real parent directory of the app dir
(`path.dirname(realpathSync(appDir))` when the directory exists, otherwise `path.dirname(path.resolve(appDir))`).
This prevents git from discovering a parent repository when the app directory is nested, so
opencode's `ctx.worktree` cannot widen `external_directory` to sibling applications. If the app is
its own repo root, git still finds `appDir/.git`. Agents' git commands inherit the ceiling; this is an
intentional behaviour change.

Caveats: the agent can `env -u GIT_CEILING_DIRECTORIES git ...` and rediscover the parent; a cached
project row may keep an old wider worktree after a restart; and symlinked app dirs need the realpath
above. Verification must check `/path` and emit a `policyWarnings` entry for a confirmed wider
worktree; by owner decision it does not block startup. Non-git dirs get `worktree="/"`, which is safe
only because opencode's `containsPath` special-cases `/`.

#### OMO interaction

OMO sets global `external_directory: "allow"` in its config hook, then spreads existing config, so
the Hanse overlay object wins. OMO also enables `question` for Sisyphus; the explicit `question:
"allow"` matches it. OMO's experimental task system is off by default, so Sisyphus uses native
`todowrite`/`todoread`; if it is enabled later, OMO's deny is overridden by this policy and the native
Todo path is used.

#### Runtime verification

- Unit: parse `OPENCODE_CONFIG_CONTENT`; assert the exact keys, ordering, no shorthand,
  `GIT_CEILING_DIRECTORIES`, and preserved MCP/plugin/instructions.
- On instance start: `GET /agent` and `GET /path` with a short timeout and retry/backoff; evaluate
  the **final** ruleset of **every non-hidden agent** with last-match semantics for a sample external
  path and a sibling-app path; for primary/`all` agents also check each trusted root, `question`
  allowed, and `todowrite` not denied. Subagents are checked for external-directory denial only,
  because their narrower capabilities are intentional. Confirm `path.directory === appDir` and
  `path.worktree` is `appDir` or `/`. Hidden system agents (`compaction`, `title`, `summary`) are
  checked against their intentional deny profiles, not the primary-agent profile. Include a
  custom-agent fixture: a project-defined agent with `external_directory: "allow"` appended last
  must be caught.
- Warning-only lifecycle (owner decision): `InstanceManager.ensure` verifies after launch and stores
  `policyWarnings` on the entry; a confirmed mismatch is logged and exposed in `/prompts`, but the
  instance remains available. A verification timeout is also a warning (`policy_unverified`). There
  is no `policy_unavailable` HTTP error and no startup block. Recovery is a config/plugin fix plus a
  restart. Include a project-config allow, a custom-agent allow, and a host `OPENCODE_PERMISSION`
  in the test fixtures; the warning must name the offending agent/permission without logging
  metadata values.
- Live check: read `/etc/hostname` (expect denial), read an app-local `.env` (expect success),
  `todowrite` (expect Todo update), `question` (expect dock).

### 7. Failure modes and concurrency

| Scenario | Behaviour |
| --- | --- |
| Blocking send + question | Message POST stays pending; SSE delivers the question; the separate reply POST resolves it. Node's event loop is not blocked. |
| Multiple pending prompts | All are rendered; maps are keyed by request ID; each is independently addressable. |
| Multiple tabs | Each tab hydrates independently. A reply in one tab emits `*.replied`; other tabs remove the card. A stale reply gets 404 and is treated as expired. |
| SSE reconnect | `stream.ready` triggers hydration of prompts and todo plus a silent message reload. |
| Frame loss / parse error | The server drops malformed/oversized frames and may emit `stream.warning`; hydration is authoritative. |
| Instance restart | Pending v1/v2 prompts are lost; v1 `always` approvals are lost, v2 saved permissions persist. The UI clears pending cards on hydration; Todos persist and recover. |
| Reply 404 | Map to `prompt_expired`; remove the card; show a notice; never retry. |
| Reply 5xx/timeout | Keep the card, re-enable controls, show an inline error with Retry. |
| Reply succeeds, SSE lost | Remove locally, record a short-lived resolved-request tombstone, and schedule a hydration; the tombstone prevents resurrection and is applied after the snapshot. |
| Hydration/event race | Guard hydrations with a sequence; replay buffered events with a sequence greater than the hydration start; if the log overflowed, re-fetch. |
| Todo event/fetch race | Discard a fetch started before a newer `todo.updated` event; full snapshots make last-writer-wins safe. |
| Todo event for another session | Ignore for the panel; only update the cache. |
| Permission `reject` | Rejects the request and other pending permissions in the same session upstream; the UI warns before confirming. |
| Permission `always` (v1) | Grants the request for the **whole app instance until restart** (not just the session) and auto-resolves matching pending requests in the same session. Many tools (edit/write/apply_patch/read/glob/grep/webfetch/websearch/task) request `always: ["*"]`, which grants that tool permission for all requests; it does **not** bypass a separate `external_directory` check for outside paths. Bash uses parsed command globs. Approved rules are appended after config rules and can override a narrower deny for the same tool. |
| Permission `always` (v2) | Writes a durable, project-scoped saved permission from the request's `save` patterns, auto-resolves matching pending requests across sessions, and persists across restarts until revoked in Saved permissions. It can override the policy for those action/resource pairs. |
| Deleted/unknown session | Render the prompt with a short session ID; disable `Open` if the session is gone; a reply may 404. |
| Stream paused | Keep cards interactive; show `Not updating`; Retry hydrates. |
| Policy mismatch | `ensure` logs `policy.warning`, stores the warning, and the app stays available; `/prompts` exposes it. Recovery is a config/plugin fix plus restart (no hot reload). |
| Policy verification timeout | Instance starts with a `policy_unverified` warning; `/prompts` exposes it. |

Client sequence guards: extend the existing `loadSequence`/`renderSequence` with `promptEventSeq`,
`promptEventLog`, `promptHydrationSeq`, and a **per-session** `todoEventSeq` (an event for another
session must not bump the active session's sequence).

### 8. Security

- Prompt control is human-only at the Hanse route layer. An agent principal gets `403`; no MCP or
  agent-facing endpoint exposes replies. The coordinator must strip `HANSE_OPERATOR_TOKEN` from the
  instance environment: today `buildInstanceEnv` spreads `process.env`, so the agent's shell/MCP can
  otherwise read the operator token and call the human route. The upstream `opencode serve` on
  127.0.0.1 is also unauthenticated, so the agent can call `/question/{id}/reply` or
  `/permission/{id}/reply` directly with `bash`. Both are **residual bypasses**: this is not a hard
  boundary against a same-uid agent. A hard boundary needs a separate isolation design (separate
  uid/container, authenticated upstream, or a proxy the agent cannot reach). The design must not
  claim R6 is met as a security boundary.
- The cookie is `HttpOnly; SameSite=Strict`; there is no `Secure` flag because the deployment is
  HTTP on a trusted LAN. New mutating routes require JSON, which blocks simple cross-site form posts
  and forces a CORS preflight the server does not allow. There is no Origin/Host check and no CSRF
  token; a same-site subdomain or a same-origin XSS could still POST. That is accepted for the
  current trusted-LAN model and documented as residual risk.
- Prompt content is untrusted agent output. Build DOM with `textContent`; do not reuse the markdown
  renderer for question text, options, metadata, or todos; never create links from metadata. Strip
  control characters; cap depth/keys/sizes server-side and client-side.
- IDs, answer counts, label sizes, and reply enums are validated before forwarding. Never forward
  arbitrary JSON upstream. Re-fetch pending questions before replying and map a vanished request to
  `prompt_expired`.
- The permission policy is explicitly not a sandbox: bash matches parsed commands, symlinks/bind
  mounts can escape, `external_directory` depends on the worktree, `OPENCODE_PERMISSION` and
  app-owned config/plugins can widen the ruleset, and agents share the coordinator uid. `.env` and
  network access are intentionally allowed and can exfiltrate secrets. v1 approved rules are
  appended after config rules; v2 saved permissions are a separate durable store. Both can override
  a narrower deny for the same action/resource, and the v2 evaluation order must be verified in
  tests. On a mismatch the design only warns (owner decision), so a widened ruleset does not block
  startup.
- v2 `Always allow` creates a durable, project-scoped saved permission that can override the
  policy. The Saved permissions section is the only revocation surface; it is human-only and
  confirmed. Treat a v2 `Always allow` as a policy change, not a session convenience.
- **Durable v2 self-grant:** because the upstream API is unauthenticated, an agent with `bash` can
  call the v2 permission reply directly and grant itself a durable saved permission that survives
  restarts and auto-resolves future requests. This is materially stronger than the accepted
  transient loopback bypass. The owner accepted it as residual; the Saved permissions list/revoke
  is an audit/cleanup surface, not a boundary. A hard boundary requires the separate isolation
  stage.
- The `edit` deny for `.opencode` config/plugins is defense-in-depth; `bash` can bypass it. The
  bare + `*/` patterns cover worktree-relative matching, but a hostile agent can still write the
  files with a shell command.

Limits: 50 prompts per kind, 200 todos, 8,000 characters per todo item, 100 questions/options/labels,
2,000 characters per label, 4,000 characters per feedback, 1 MiB per SSE frame, existing 64 KB body
cap. Oversized single requests are marked `tooLarge` and can be dismissed, never truncated.

### 9. Alternatives considered

| Decision | Alternatives | Verdict |
| --- | --- | --- |
| SSE parsing | Browser-side raw parsing; two streams; do nothing | Server-side typed multiplexer: one validation point, bounded payloads, testable, stable browser contract. |
| Prompt state | Server-owned in-memory registry; SQLite registry; do nothing | Client-owned, stateless server: upstream is authoritative; multi-tab converges via events; no reconciliation. |
| Route shape | Session-scoped prompts; global prompts | App-scoped prompts because upstream lists span sessions; session-scoped todo because upstream todo is per session. |
| Todo updates | Polling; server cache; do nothing | GET + `todo.updated` SSE; polling only as a fallback if the stream is paused. |
| UI placement | Modal dialogs; dock below composer; Todo in a thread strip | In-flow docks above the composer; Todo in the context rail with a meta chip below 1360. |
| v2 prompts | v1-only; support v1+v2 | Both: v2 has separate pending maps and durable `always`, so replies use session-scoped v2 routes and saved permissions are managed in the context rail. |
| Policy failure | Warn only; fail closed | Warn only (owner decision): verification surfaces a warning and never blocks startup. |
| Prompt control | Hanse routes only; hard isolation | Hanse routes only in this stage; hard isolation is a separate design because the loopback API is unauthenticated and credentials are inherited. |

### 10. Test strategy

| Layer | Coverage |
| --- | --- |
| SSE parser unit | chunk splits, CRLF splits, UTF-8 splits, multi-line data, comments, malformed JSON, v1/v2 events on `/event`, 1 MiB cap, `session.activity` for `session.status`, `session.idle`, `message.updated`, `message.part.updated`, `session.updated`. |
| Normalization unit | `custom` default true, `multiple` default false, v2 `action/resources/save` mapping, metadata caps, todo unknown status/priority, item/prompt caps, `tooLarge` requests. |
| Policy unit | exact overlay keys/order, no shorthand, `.env` read allows without a `read "*"`, `.opencode` edit denies in bare and `*/` forms (app-as-worktree, non-git, nested), `doom_loop` ask, plugin skill roots with `file://` decoding, `GIT_CEILING_DIRECTORIES`, child env without `HANSE_OPERATOR_TOKEN`/`OPENCODE_PERMISSION` (scrubbed after `baseEnv`), final-ruleset evaluation for external/sibling/trusted paths, every non-hidden agent, custom-agent allow caught, hidden-agent expectations, warning-only behavior. |
| HTTP integration | fake opencode route table: v1 and v2 lists with `location: {directory: appDir}`, partial failure, all fail, question reply/reject for both sources, permission reply for both sources, saved-permission list/revoke, `source:id` keying, validation (single-select custom, empty answers with confirmation, oversized request/`tooLarge`, empty labels), 404 mapping, project disambiguation, auth matrix (401/403/human), 415/413, policy warning, v2 `source -> tool` mapping. |
| SSE integration | real Hanse HTTP server + fake upstream `/event`: headers, `stream.ready` after upstream attach, normalized v1 and v2 frames, heartbeat, backpressure, abort, auth. |
| Regression | existing chat routes and assets unchanged; old session SSE still raw; stale-send cross-session guard; cached-worktree repair; tombstone on 404/dismiss/reject and received events; tombstone TTL/cross-tab; per-session `todoEventSeq`. |
| Browser QA | single/multi/custom/dismiss questions, empty-answer confirmation, single `multiple:true`, permission once/always/reject + feedback, v1 instance scope vs v2 durable project scope/cross-session auto-resolve, saved-permission list/revoke/badge, `always: ["*"]` copy and external-directory caveat, policy warning banner + top-bar chip, 404 answered-elsewhere, two tabs, blocking send, reconnect/hydration tombstone, todo live update, unknown todo values, 0/0 progress, XSS fixtures, 390/768/1440 dark/light, keyboard and focus. |
| Live smoke | policy `/agent` + `/path`, denied external read, `.env` read, network, `todowrite`, v1 and v2 `question`, v2 saved permission list/revoke; real temp-repo `GIT_CEILING_DIRECTORIES` test. |

Fake upstream: extend `test/chat-page.test.ts:112-140` with a route table and assert method, URL, and
exact JSON body for replies. Browser tests use route interception and a stub `EventSource`; one real
agent test covers the actual `question`/`todowrite` path.

### 11. Rollout and compatibility

- Additive routes; no DB migration and no schema change.
- Restarting the coordinator (`manager.stopAll()`) relaunches instances with the new overlay and
  `GIT_CEILING_DIRECTORIES`; there is no hot reload.
- A pre-existing opencode project row may cache a wider worktree. The rollout check must verify
  `/path`; if a wider worktree survives the restart, refresh/clear the project row and surface a
  warning until it is corrected.
- Existing session/message/SSE routes and response shapes are unchanged. The old session SSE route
  remains raw.
- Rollback: revert the image and restart. Pending prompts are lost; todos persist. Removing the
  `permission` block is an emergency security downgrade and must be recorded.
- Update `docs/current-state.md`, add an ADR for the permission policy after approval, and add a stage
  journal entry.

## Owner decisions (closed)

The owner answered all design forks on 2026-10-19:

1. **R6 scope:** Hanse-route guarantee. Strip coordinator credentials, keep prompt/Todo/event routes
   human-only, and disclose the residual same-uid/loopback bypass. Hard isolation is a separate
   stage.
2. **Policy mismatch:** warning only. Verification logs and exposes warnings; it does not block
   startup or return `policy_unavailable`.
3. **App-owned config/plugins:** deny `edit` on the app-root `opencode.json`/`opencode.jsonc`,
   `.opencode/opencode.json*`, and `.opencode/plugin*`/`.opencode/plugins/*`. `bash` can bypass this;
   it is defense-in-depth, not a boundary.
4. **v2 prompts:** support them now, including v2 list/reply and durable project-scoped `always` with
   a Saved permissions list/revoke surface.
5. **Empty answers:** allow sending `answers: [[]]`, but ask the user to confirm "Send without
   answering?" before doing so. No-options/`custom:false` requests can be sent empty or dismissed.
6. **Nested worktree:** set `GIT_CEILING_DIRECTORIES`; verify `/path` and warn if the worktree is
   wider. A cached wider worktree is repaired during rollout.
7. **Trusted external roots:** approved as listed in §6.
8. **`always` scope:** show the scope and the literal `*`. v1 is instance-wide until restart; v2 is
   durable/project-scoped and revocable.
9. **`.env`:** read+write allowed.
10. **Durable v2 self-grant:** accepted as residual. v2 `Always allow` may be created by an agent
    through the unauthenticated upstream API and persists across restarts; Saved permissions is an
    audit/revoke surface, not a boundary. Hard isolation is a separate stage.

Decisions taken without an owner question: `doom_loop` stays `ask`; the Todo panel is labelled
`Plan` and lives in the context rail (TUI parity) with a meta chip below 1360.

No open owner questions remain for this stage.

## Review

Oracle review (2026-10-19): **PASS-WITH-CHANGES**. Blocking findings folded into this revision:

- B1: `buildInstanceEnv` inherited `HANSE_OPERATOR_TOKEN` and other coordinator secrets; the
  loopback opencode API is unauthenticated. Fixed by credential scrubbing, rewording R6/G7 as a
  Hanse-route guarantee, and making hard isolation an explicit owner question.
- B2: `OPENCODE_PERMISSION` and app-owned config/plugins can widen the policy; verification only
  warned. Fixed by stripping `OPENCODE_PERMISSION`, verifying every non-hidden agent with
  last-match semantics, adding `.opencode` edit denies, and documenting the residual bypass. Per
  owner decision the verification remains warning-only.
- B3: `always` was described as session-scoped; it is instance-wide until restart (v1), and
  `always: ["*"]` grants the whole tool. Copy and failure table corrected.
- B4: v2 prompt events were not answerable through v1. They are now supported natively: normalized
  to Hanse events with `source: "v2"`, replied through session-scoped v2 routes, with durable saved
  permissions listed and revocable.
- B5: a lost `*.replied` event plus an in-flight hydration could resurrect a card. Added resolved
  request tombstones and hydration sequence guards.
- B6: question validation contradicted the upstream single-select custom contract and could
  deadlock on empty-option questions. Validation and the non-answerable state are corrected.

Non-blocking findings were also folded in: `session.activity` extraction paths, `stream.ready`
timing, event-log overflow, per-session send guards, `server.ts` dispatch, auth ordering, cached
worktree on restart, metadata availability, unknown Todo values, Todo fetch on session switch, 0/0
progress, single `multiple:true`, 404 copy, reject cascade feedback, `always: ["*"]` copy, risk
mapping, `aria-current`, CSRF residual, typed upstream errors, and the additional tests.

Oracle re-review (2026-10-19): **PASS-WITH-CHANGES**. B4 resolved; B1/B2/B3/B5/B6 materially
improved but not yet plan-ready. Remaining findings folded into this revision:

- B1: disclose `/proc/<pid>/environ`, mounted files/DB, and non-HANSE inherited secrets as residual;
  scrub after `baseEnv`. Done.
- B2: define the verification lifecycle; per the owner decision it is **warning-only** (no startup
  block, no `policy_unavailable`), verify every non-hidden agent, remove the `read "*": "allow"`
  override, and deny `edit` on app-owned config/plugins. Done; the `bash` bypass is documented.
- B3: correct `always: ["*"]` copy: it grants the tool permission for all requests, not all paths;
  `external_directory` still applies for edit/read/write/glob/grep; bash uses command globs. v2
  durable/project scope and the Saved permissions surface are included. Done.
- B5: record tombstones for 404/dismiss/reject and received events; TTL/generation guard; per-tab
  cross-tab caveat; per-session `todoEventSeq`. Done.
- B6: empty answers are allowed with an explicit "Send without answering?" confirmation; `tooLarge`
  requests are dismissible/send-empty; header/question/description caps and empty-label rejection are
  defined. Done.
- Tests added for the warning-only policy, all-agent verification, empty-answer confirmation,
  v1/v2 prompts, saved-permission revoke, tombstones, cached worktree, and the `always` copy.

Oracle delta review (2026-10-19, after owner decisions): **PASS-WITH-CHANGES**. Findings folded in:

- Worktree-relative `.opencode` edit deny: added bare + `*/` variants and tests for app-as-worktree,
  non-git, and nested apps.
- Durable v2 self-grant via the unauthenticated upstream: disclosed in §8 and explicitly accepted by
  the owner as residual; Saved permissions is an audit/revoke surface, not a boundary.
- Warning-only policy: added the visible `.policy-warning` banner and top-bar chip, hydrated with
  prompts.
- Empty-answer/`tooLarge` contradiction: no-options/`custom:false` can send-empty with confirmation
  or dismiss; `tooLarge` is Dismiss-only.
- v2 scoping and keying: pass `location: {directory: appDir}`, show the upstream `projectID`, key
  maps/tombstones/drafts by `${source}:${id}`, add `source` to replied/rejected payloads, map
  `source -> tool`, and warn about v2 cross-session auto-resolve.
- Saved permissions: separate durable store (not "appended"), refresh on `stream.ready`/after grant,
  badge for new grants, verify override order in tests.

All owner decisions are recorded; no open questions remain. If a hard R6 boundary is later required,
it is a separate isolation stage.

## Document history

- 2026-10-19: initial design proposal assembled from the architecture and frontend design tracks.
- 2026-10-19: Oracle design review (PASS-WITH-CHANGES); blocking and non-blocking findings folded
  in.
- 2026-10-19: Oracle re-review (PASS-WITH-CHANGES); remaining lifecycle, `read "*"`, `always` copy,
  tombstone, and answer-contract findings folded in.
- 2026-10-19: owner decisions recorded: Hanse-route guarantee, warning-only policy, `.opencode`
  edit deny, v1+v2 prompt support with saved permissions, empty answers with confirmation,
  `GIT_CEILING_DIRECTORIES`, trusted roots, explicit `always` scope, `.env` read+write.
- 2026-10-19: Oracle delta review (PASS-WITH-CHANGES); worktree-relative edit deny, durable v2
  self-grant disclosure, policy-warning UI, empty/`tooLarge` rules, v2 scoping/keying, and saved
  permission semantics folded in; owner accepted the durable self-grant residual.
- 2026-10-19: implemented and verified; gates green (254 tests), browser smoke at 1440/390, stage
  recorded in journal 0005 and ADR 0005. Not committed (owner decision pending).
