# Plan 0005 - Chat UX overhaul

- Status: **complete** (phases 1-7 implemented, verified, and deployed to `deployment-host`). QA evidence:
  [`docs/journal/0006-chat-ux-overhaul.md`](../journal/0006-chat-ux-overhaul.md) and
  [`docs/design/artifacts/chat/`](../design/artifacts/chat/README.md).
- Plan review: `momus` history is recorded in §11; execution proceeded after the design gates closed.
- Design: [`docs/design/chat-ux-overhaul.md`](../design/chat-ux-overhaul.md).
- Design review: `oracle` **PASS WITH CHANGES**; all revisions are applied in the design,
  including the two re-review majors (§6.3, §7.2, §8.2-§8.4, §13 R15). No other design-review
  verdict applies.
- Plan reviewer: `momus` (review history in §11; no separate verdict was appended to this file).
- Owner decisions (closed):
  - **OD1 - live tool output:** 64 KiB live window with a truncation notice; the full tool output is
    obtained only from the idle `GET /messages` snapshot when the whole message response fits the
    8 MiB cap. No dedicated full-output fetch in this stage (design §16.1).
  - **OD2 - uncorrelated questions:** requests without a valid `tool` reference keep the existing
    dock; no synthesized feed card (design §16.2).
  - Closed implementation-shape decisions from the design: one-line queue strip (D11), 96rem feed cap
    (D7), collapsed `Thinking` (D8).
- Artifacts and indexes: design index `docs/design/README.md`; plan index `docs/plans/README.md`;
  journal index `docs/journal/README.md`; decisions `docs/decisions/` (none required by this stage);
  open questions are closed in this plan (design §16).
- Documentation language: English.
- Verification (every phase exit and stage completion):
  `npm run lint && npm run typecheck && npm test && npm run build`.
- Required manual browser QA before merge/stage completion:
  `node docs/design/chat-qa.mjs` (Playwright resolved the same way as `docs/design/capture.mjs`; no
  product dependency). Missing Playwright is a blocked QA gate, not a skip.
- Commit policy: **do not commit** as part of this plan. One coherent commit only if the owner
  explicitly asks. Deployment to `deployment-host` is authorized separately and is Phase 7; deployment does not
  imply a commit.

## 1. Scope and non-goals

Scope: the chat workspace and the Hanse app event/send APIs that feed it, exactly as bounded by the
design's implementation surface (§11.5). Preserve the existing raw session SSE, blocking
`/messages`, prompt/permission/Todo/saved-permission/policy/session behavior, and the no-framework,
no-bundler, no-new-dependency constraints (design §11.3, §15.2).

Non-goals: design §15.2 applies verbatim. In addition, this plan adds no database table, no
migration, no durable queue, no server-side OMO classification, no virtualization, no innerHTML, and
no change to the VS Code extension.

## 2. Global invariants

1. **Additive contracts.** Existing clients keep working: blocking `POST /messages` without
   `async=1` still returns `{message}`; the raw per-session SSE route is unchanged; old app-stream
   clients still receive `session.activity` for `message.updated`/`session.status`.
2. **No new runtime dependency and no build step.** `assets/chat.js` and `assets/chat-core.js` are
   browser ESM served by the existing asset allowlist; CSS remains `src/http/styles.css` built by the
   Tailwind CLI.
3. **No new persistence.** Questions/answers come from message parts; queue, optimistic rows, status,
   OMO classification, drafts, and scroll are client state (D10). No SQLite migration.
4. **Server owns normalization and bounds.** The app stream is the single validation/caps point
   (§6.4). The browser never parses upstream SSE.
5. **Sequence discipline.** `stream.ready` is `seq: 0`; every other emitted event increments `seq`
   once; `streamID` is per HTTP connection and never reused; heartbeats carry no `seq` (§6.1, §6.5).
6. **Content safety.** Agent/question/tool content is untrusted. DOM is built with `textContent` and
   the safe markdown DOM; no `innerHTML`, no raw HTML, no images, no `javascript:` links.
7. **Single scroll owner.** `.chat-thread__scroll` remains the only page scroll; streaming uses
   manual anchoring and never drags a reader who is away from the bottom (§10.2).
8. **No silent fallbacks.** A missing `prompt_async` is `502 async_unavailable`; an unknown send
   outcome is reconciled, never auto-retried; a queue cannot be removed while busy; a truncated live
   tool view never claims the full output is available.
9. **Existing tests are not weakened.** Changed expectations (for example `stream.ready` gaining
   `seq`/`streamID`) are updated deliberately with new assertions, never deleted or relaxed.

## 3. Requirements traceability

Requirement prose is not restated; this table binds each design ID to the plan phase(s) and the
verification layer. Design section references are to `docs/design/chat-ux-overhaul.md`.

| ID  | Design reference                         | Plan phase(s) | Primary verification                     |
| --- | ---------------------------------------- | ------------- | ---------------------------------------- |
| R1  | §9.6, §9.7, §13 R1                       | P5b           | `chat-core` + browser keyboard fixtures  |
| R2  | §7.2, §8.2, §13 R2                       | P4, P5a       | browser optimistic/rekey fixtures        |
| R3  | §9.5, §13 R3                             | P4, P5a       | browser status matrix + unit derivation  |
| R4  | §9.4, §13 R4                             | P5c           | browser tool/reasoning fixture           |
| R5  | §6.3, §8.2, §13 R5                       | P1, P4        | unit snapshot policy + browser streaming |
| R6  | §9.6, §13 R6                             | P5b           | unit correlation + browser Q&A fixture   |
| R7  | §6.4, §9.4, §13 R7                       | P1, P5c       | unit >1 MiB bash + browser streaming     |
| R8  | §9.4, §13 R8                             | P5c           | browser preview/checklist fixtures       |
| R9  | §9.3, §13 R9                             | P3, P5c       | unit table parser + browser table fixture |
| R10 | §9.1, §13 R10                            | P5c           | browser layout ratios 1024/1440/1920     |
| R11 | §9.2, §10.1-§10.2, §13 R11               | P4, P5c       | browser scroll/open-state fixture        |
| R12 | §11.3, §13 R12                           | P1-P5         | full existing suite + regression matrix  |
| R13 | §6.4, §6.5, §8.2, §13 R13                | P1, P2, P4    | unit caps/seq + HTTP cap + browser races |
| R14 | §10.3, §13 R14                           | P4, P5c       | browser a11y/reduced-motion fixtures     |
| R15 | §7.2, §8.2, §9.9, §13 R15                | P2, P3, P5a   | `deriveQueue` cases + browser queue      |
| R16 | §9.6, §9.7, §13 R16                      | P5b           | browser auto-advance/focus fixtures      |
| R17 | §9.10, §13 R17                           | P3, P5b       | `classifyOmo` cases + browser OMO cards  |
| OD1 | §16.1, §6.4, §9.4                        | P1, P5c       | unit caps + browser truncation copy      |
| OD2 | §16.2, §9.6                              | P5b           | browser dock-only question fixture       |
| RR1 | §6.3, §8.2 inv. 13, §13 R15              | P1, P3, P5a   | `deriveQueue` turn-state cases + browser |
| RR2 | §7.2, §8.2 inv. 5/16, §8.3-§8.4          | P3, P4, P5a   | unit snapshot merge + browser races      |

RR1 = re-review major "queue turn-state (`finish`/`turnContinues`/`activePromptID`)". RR2 =
re-review major "hydration snapshot apply + optimistic/unknown merge with 5 s grace".

## 4. Phase dependencies and parallelization

| Phase | Depends on | Can parallelize with | Owns (write area) | Exit gate |
| --- | --- | --- | --- | --- |
| P1 Server stream contract | design §6 | P2, early P3 | `src/opencode/events.ts`, `src/http/prompts.ts` | targeted unit + app-events green |
| P2 Async send + bounded messages | design §7, P1 envelope contract | P1, P3 | `src/opencode/client.ts`, `src/http/chat.ts` (server route only) | targeted client/HTTP green |
| P3 Client core pure helpers | P1 event fields frozen | P1/P2 | new `assets/chat-core.js`, new `test/chat-core.test.ts` | `chat-core` unit suite green |
| P4 Client streaming/store/status | P1, P2, P3 | none on `chat.js` | `assets/chat.js`, `src/http/ui.ts`, `src/http/handler.ts`, `src/http/chat.ts` (script/markup) | full Vitest + manual streaming smoke |
| P5 Send/queue/questions/OMO/tools/CSS | P4 | 5c CSS may follow 5a markup freeze | `assets/chat.js`, `assets/chat-core.js`, `src/http/styles.css`, `src/http/chat.ts` | full Vitest + build + manual visual QA |
| P6 Browser QA harness + live smoke + docs | P5 | none | new `docs/design/chat-qa.mjs`, docs/indexes/journal | `chat-qa.mjs` zero errors + all gates |
| P7 Deploy to deployment-host | P6 + owner authorization | none | host only; local `docs/deploy/deploy-log.md` (git-ignored) | health checks + deploy log entry |

P1 and P2 are file-disjoint and can run concurrently once the envelope/wire shape is agreed. P3 can
start against the frozen event field contract while P1/P2 finish. P4 must wait for all three. P5a ->
P5b runs serially in `assets/chat.js`; P5c CSS can start after P5a freezes the class/markup contract
and must not edit `chat.js` concurrently with P5b. P2 and P5 both touch `src/http/chat.ts` at
different times: P2 owns the API route, P5 owns page markup. See §9 for the lane recommendation.

## 5. Phases

### Phase 1 - Server stream contract (events, projector, caps, envelope)

**Boundaries / non-goals:** upstream parsing/projection, caps, prompt/todo budgets, and the SSE
envelope only. No browser code, no send route, no CSS. Do not forward `message.part.removed` or
`message.removed` as invented payloads; they remain `session.activity` with `cause:"removed"`.

**Files:** `src/opencode/events.ts`, `src/http/prompts.ts`.

**Tasks:**

1. Add and export constants in `events.ts`: `APP_STREAM_MAX_FRAME_BYTES` (8 MiB),
   `MAX_TYPED_EVENT_BYTES` (256 KiB), `MAX_DELTA_BYTES` (64 KiB), `MAX_TEXT_SNAPSHOT_BYTES`
   (64 KiB), `MAX_PART_EVENT_BYTES` (256 KiB), `MAX_TOOL_OUTPUT_BYTES` (64 KiB),
   `MAX_PATCH_BYTES` (64 KiB), `MAX_PART_STRING_BYTES` (8 KiB), `MAX_PART_ARRAY_ITEMS` (200),
   `MAX_STATUS_MESSAGE` (2,000 chars), `MAX_STATUS_ACTION_BYTES` (2 KiB),
   `MAX_MESSAGE_INFO_BYTES` (8 KiB), `IDENTITY_SALVAGE_PREFIX_BYTES` (64 KiB), and a bounded
   per-connection map limit (5,000 part IDs). Keep `MAX_SSE_FRAME_BYTES` (1 MiB) for other SSE use.
2. Extend the projected event union with `message.updated`, `message.part.updated`,
   `message.part.delta`, `message.part.omitted`, and `session.status` exactly as §6.2. Add
   `PartType`, `Truncation`, and the optional `sessionID`/`code` additions to `stream.warning`
   (`frame_too_large | invalid_json | delta_too_large`) and the additive
   `session.activity.cause` (`"message" | "status" | "removed" | "unknown"`). Keep `HanseEvent` as the
   projected payload union; add `EnvelopedHanseEvent = HanseEvent & { seq: number; streamID: string }`
   for the wire form. `stream.ready` remains the `{type:"stream.ready"}` payload and is emitted with
   `seq:0`.
3. Implement `EventProjector.project` mappings per §6.3:
   - `message.updated`: valid `info.id` + `info.role` only; copy `id`, `role`, bounded `parentID`
     (200 chars), `finish` (32 chars), and `time.created`/`time.completed`; enforce
     `MAX_MESSAGE_INFO_BYTES` on the derived fields (fall back to activity if exceeded); emit a
     compatibility `session.activity` with `cause:"message"`. Invalid identity -> activity.
   - `message.part.updated`: require `part.id`, `part.type`, `part.sessionID`, `part.messageID`;
     emit the part and remember `partID -> partType` in the bounded map. Missing/mismatched
     identity -> activity. Do **not** emit activity for valid part updates.
   - `message.part.delta`: only `field === "text"`, non-empty string delta, and identity fields;
     attach `partType` when the map knows the part; drop other fields. Never emit activity for a
     valid delta.
   - `session.status`: rebuild only `type`, `attempt`, `message`, `next`, `action`; bound
     `message`/`action`; emit `session.status` plus a compatibility `session.activity` with
     `cause:"status"` (old tabs reload at status granularity).
   - `session.idle`: normalize to `session.status {type:"idle"}`; drop a consecutive duplicate idle
     for the same session.
   - `message.part.removed`/`message.removed`/unknown: `session.activity` with
     `cause:"removed"`/`"unknown"` when a session ID is available.
   - Keep envelope-ID dedupe and the prompt `askedKeys` behavior unchanged.
4. Implement part bounding/truncation per §6.4:
   - copy identity/control fields first (`id`, `sessionID`, `messageID`, `callID`, `type`, `tool`,
     `title`, `state.status`, `state.title`, `state.time`, text `synthetic`, text `ignored`);
   - `state.input`/`state.metadata` with per-string 8 KiB and per-array 200 caps; preserve question
     `state.input.questions` under the existing prompt caps (100 questions/options, 200/10,000/2,000/
     4,000 char fields) and `state.metadata.answers` (100 x 100 strings, 2,000 chars each) and
     `state.metadata.todos`;
   - running `state.metadata.output`: keep the **last** 64 KiB; completed `state.output`: keep the
     **first** 64 KiB; `patch`/`text`: first 64 KiB; large other strings: first 8 KiB; arrays:
     first 200;
   - fill `truncated.fields` (dotted paths) and `truncated.omittedBytes`;
   - if the serialized event is still over 256 KiB, emit `message.part.omitted` with
     `reason:"too_large"` and no part.
5. Implement snapshot forwarding per §6.3:
   - text/reasoning: per-part `sawDelta`; first snapshot + completion snapshot if deltas were seen;
     otherwise throttle snapshots to one per 100 ms plus completion; omit snapshots over 64 KiB;
   - tool/other: forward status transitions and the first running snapshot; while running, at most
     one snapshot per part per 100 ms (last write wins); completion/error never throttled;
   - throttle/sawDelta maps are per connection and bounded to 5,000 part IDs.
6. Implement delta limits: drop a >64 KiB delta, emit one `stream.warning
   {code:"delta_too_large", sessionID}` per session, and mark the client for reconcile.
7. Implement parser identity salvage:
   - `SseParser` retains the first 64 KiB of a dropped frame and exposes it (for example
     `SseWarning.prefix`) with the `frame_too_large` warning;
   - `createEventStream` attempts a bounded identity scan of that prefix for `sessionID`,
     `messageID`, and `partID`; if all three are valid, emit a synthetic `message.part.omitted`
     with `reason:"too_large"` and suppress the generic warning for that frame;
   - otherwise emit one `stream.warning {code:"frame_too_large", sessionID?}`; dedupe warnings by
     `code + sessionID` (not by code alone), so a second session is not suppressed. If the prefix
     yields only a session ID, include it in the warning; never invent one.
8. Implement prompt/todo frame budgets after existing normalization:
   - `question.asked` over 256 KiB: keep identity/source/tool, set `tooLarge:true`, bounded
     `tooLargeReason`, add a bounded `summary` (first header/question, 500 chars), drop `questions`;
   - `permission.asked` over 256 KiB: keep identity/source/tool/permission, set `tooLarge:true`,
     bounded `tooLargeReason` and `summary`, drop `patterns`, `always`, `metadata`;
   - `todo.updated` over 256 KiB: drop trailing items until it fits, set `truncated:true`; keep the
     existing 200-item/8,000-char caps first;
   - measure with `Buffer.byteLength(JSON.stringify(event), "utf8")`; never emit an over-budget typed
     event. Represent the additive `tooLarge`/`tooLargeReason`/`summary` fields on the projected
     `question.asked`/`permission.asked` event types in `events.ts` (for example an intersection with
     the normalized request); `src/opencode/prompts.ts` normalization is not changed in this phase.
9. Update `streamAppEvents` in `src/http/prompts.ts`:
   - allocate one `streamID = crypto.randomUUID()` per connection; create an `emit` helper that adds
     `streamID` and assigns `seq` (0 only for `stream.ready`, `1..N` for every other event) before
     serialization; warnings get sequence numbers too; heartbeats remain `: ping` with no sequence;
   - pass `maxFrameBytes: APP_STREAM_MAX_FRAME_BYTES` to `createEventStream`;
   - keep `stream.ready` emission inside `onAttached`, after the upstream reader is attached; keep
     headers, backpressure (`drain`), abort, and 401/403/404/502/503 behavior unchanged;
   - keep `streamID` stable for the connection and never reuse it.
10. Update existing unit tests for the additive fields (`session.activity.cause`, envelope) rather
    than weakening them; add the cases in design §14.1/§14.2.

**Acceptance criteria:**

- `stream.ready` is `{type:"stream.ready", seq:0, streamID}`; every subsequent frame has the same
  `streamID` and a strictly increasing `seq`; two connections have different `streamID`s; heartbeats
  have no `seq`.
- `message.updated` carries bounded `parentID`/`finish`/`time` and a compatibility
  `session.activity {cause:"message"}`; invalid identity falls back to activity.
- Valid `message.part.updated`/`message.part.delta` never emit `session.activity` (no token reload
  storm); deltas only for `field:"text"`.
- A >1 MiB running bash `state.metadata.output` reaches the projector (8 MiB parser cap), is capped
  to the last 64 KiB, and emits `truncated.fields` including `state.metadata.output`; it is not
  dropped as a 1 MiB frame.
- A >8 MiB frame with salvageable identity emits `message.part.omitted {reason:"too_large"}`;
  without all three IDs it emits exactly one `frame_too_large` warning (with `sessionID` when
  available); a second session's warning is not suppressed.
- A part still over 256 KiB after caps emits `message.part.omitted`; text snapshots over 64 KiB are
  omitted; a >64 KiB delta is dropped with one `delta_too_large` warning.
- `question.asked`/`permission.asked`/`todo.updated` over 256 KiB take their bounded `tooLarge`/
  `truncated` forms and remain renderable; no typed event exceeds 256 KiB.
- `session.idle` normalizes to `session.status {type:"idle"}` and consecutive duplicate idle frames
  for one session are dropped.
- Existing parser/projector tests still pass with the additive expectations.

**Tests (extend, do not replace):**

- `test/opencode-events.test.ts`: every mapping above, identity validation, `parentID`/`finish`/time,
  activity compatibility/cause, delta field/identity/partType, all caps and truncation paths,
  snapshot policy (`sawDelta`, no-delta throttle, completion), prompt/todo budgets at
  under/at/over 256 KiB, idle dedupe, bounded status, removed/unknown fallbacks, salvage/warning
  dedupe.
- `test/app-events.test.ts`: `stream.ready` shape/seq/streamID, per-event sequence, heartbeat no
  seq, activity compatibility frames, >1 MiB bash snapshot, >8 MiB omitted/warning behavior,
  prompt/todo budget frames, backpressure/abort unchanged.

**Risks:** parser memory at 8 MiB per open stream; salvage can miss identity when `part.id` follows a
large output (documented as best-effort); caps interacting with the 256 KiB budget. Mitigation:
bounded maps, fixed per-frame cap (not cumulative), boundary tests, and omission as the explicit
failure.

**Verification / exit condition:**
`npx vitest run test/opencode-events.test.ts test/app-events.test.ts`, `npm run typecheck`,
`npm run lint` green.

### Phase 2 - Async send and bounded messages reader

**Boundaries / non-goals:** `sendPromptAsync`, the additive `?async=1` route, and the capped
`listMessages` path. Do not change blocking `sendPrompt`, raw session SSE, prompt routes, or page
markup.

**Files:** `src/opencode/client.ts`, `src/http/chat.ts` (server route only). No change to
`src/http/server.ts`: the existing 64 KiB `MAX_BODY_BYTES` stays.

**Tasks:**

1. `src/opencode/client.ts`:
   - add `MESSAGES_RESPONSE_MAX_BYTES = 8 * 1024 * 1024` and
     `MESSAGES_RESPONSE_TIMEOUT_MS = 30_000`;
   - add optional `code` to `OpencodeHttpError` (for `messages_too_large`) without changing existing
     constructor callers;
   - implement `sendPromptAsync(endpoint, sessionId, text, messageID, options?)` with `sendVoid` on
     `POST /session/:id/prompt_async`, body
     `{"parts":[{"type":"text","text":text}],"messageID":messageID}`, 10 s timeout, no JSON parse;
   - implement `listMessages` with `requestResponse` + `readCapped` using
     `MESSAGES_RESPONSE_MAX_BYTES` and `MESSAGES_RESPONSE_TIMEOUT_MS`, then `JSON.parse`; on cap
     overflow throw `OpencodeHttpError` with `code:"messages_too_large"`; keep `sendPrompt` exactly
     as-is.
2. `src/http/chat.ts` `POST .../messages`:
   - read `request.query.async === "1"`; when false, preserve the blocking path and `{message}`
     response byte-for-byte;
   - when true: parse `{text}` (invalid JSON -> 400 `invalid_json`), reject empty/whitespace-only text
     with 400 `empty_message`, reject `Buffer.byteLength(text,"utf8") > 32*1024` with 400
     `message_too_large`; generate `messageID = "msg_" + randomUUID().replaceAll("-","")`; call
     `sendPromptAsync`; return 202 `{accepted:true, messageID, sessionID}` only after upstream 204;
   - error mapping: upstream 404 -> 404 `session_not_found`; upstream 405 -> 502
     `async_unavailable` (not_sent); upstream other 4xx/5xx -> 502 `agent_unavailable` with
     `outcome:"not_sent"`; transport error/timeout after the call may have been sent -> 502
     `agent_unavailable`, `outcome:"unknown"`, `messageID`, `sessionID`; instance start failure ->
     502 `agent_unavailable`, `outcome:"not_sent"`; unknown app -> the existing 404 with an additive
     `code:"unknown_app"`; no manager -> existing 503; missing principal -> existing 401;
   - never synthesize 409; a busy session is a normal 202; do not pre-check `session.status` and do
     not fall back to the blocking route.
3. `src/http/chat.ts` `GET .../messages`: catch `messages_too_large` and return 502
   `{error:"session too large to refresh", code:"messages_too_large"}` with no partial JSON; other
   failures keep the existing 502 shape.
4. Keep `src/http/server.ts` `MAX_BODY_BYTES = 64 KiB`; verify the 32 KiB UTF-8 text boundary plus
   JSON overhead. Do not add a new route.
5. Add tests per design §14.2.

**Acceptance criteria:**

- `POST .../messages?async=1&project=p1` with `{text:"hello"}` returns 202 with
  `accepted:true`, a `messageID` matching `^msg_[0-9a-f]{32}$`, and the session ID; upstream receives
  exactly the `{parts, messageID}` body on `/session/:sid/prompt_async`; upstream 204 is accepted
  without JSON parsing.
- Empty and whitespace-only text -> 400 `empty_message`; 32 KiB UTF-8 exactly succeeds; a multibyte
  string just over 32 KiB -> 400 `message_too_large`; a JSON body just over the 64 KiB server cap ->
  413 `payload_too_large`.
- A busy session still returns 202 and never 409; the route does not pre-check busy state.
- Upstream 404 -> 404 `session_not_found`; upstream 405 -> 502 `async_unavailable`; upstream 5xx ->
  502 `agent_unavailable` `outcome:"not_sent"`; a timeout/transport failure -> 502 with
  `outcome:"unknown"`, `messageID`, `sessionID`; start failure -> 502 `not_sent`; no manager -> 503;
  no principal -> 401; unknown app -> 404 `unknown_app`.
- Blocking `POST` without `async=1` is unchanged (200 `{message}`; same upstream body).
- `GET /messages` with a large-but-valid response under 8 MiB completes through the 30 s capped
  reader (not the 5 s default); over 8 MiB returns 502 `messages_too_large` with no partial JSON.
- `?async=1` composes with `?project=`; sessions/messages list routes are unaffected.

**Tests (extend):**

- `test/client.test.ts`: `sendPromptAsync` exact body/path/204, 404/5xx/405/timeout mapping, no JSON
  parse, 10 s option; `listMessages` cap/timeout behavior and `messages_too_large` code; `sendPrompt`
  unchanged.
- `test/chat-page.test.ts`: full async matrix above, busy 202, no 409, unknown outcome, blocking
  regression, 413 boundary, `GET /messages` cap path, project flag.

**Risks:** the 64 KiB body cap and JSON escaping at the 32 KiB text boundary; timeout ambiguity
(`unknown` vs `not_sent`); accidental behavioral change to the blocking route. Mitigation: boundary
tests, a single parsed body, and keep the blocking branch byte-for-byte.

**Verification / exit condition:**
`npx vitest run test/client.test.ts test/chat-page.test.ts`, `npm run typecheck`,
`npm run lint` green.

### Phase 3 - Client core pure helpers

**Boundaries / non-goals:** pure ESM helpers with no DOM, network, EventSource, storage, or timers.
`assets/chat.js` is not edited in this phase except for a later import in P4.

**Files:** new `assets/chat-core.js`; new `test/chat-core.test.ts`.

**Tasks:**

1. Create `assets/chat-core.js` as browser ESM (no Node APIs) exporting:
   - `deriveQueue(store, { sessionStatusType })` -> `{ activeID, queuedIDs, turnContinues,
     nextActivePromptID }`;
   - `classifyOmo(message)` -> `OmoSystemMeta | null`;
   - `applySnapshot(currentStore, snapshotMessages, options)` -> `{ store, contentDiscarded,
     turnChanged }`;
   - `rekeyOptimistic(store, { tempID, serverID, bufferedEvents })` -> `{ store, consumed }`;
   - `parseMarkdownTable(lines, startIndex)` -> a plain descriptor
     `{ headers:[{text,align}], rows:string[][], truncated:boolean, nextIndex } | null`;
   - `deriveStatus(state)` if the status precedence can be expressed without connection timers;
     otherwise P4 owns the timer-dependent wiring and the pure label/queue-suffix selection lives
     here. Also export pure `sealSnapshot`/`deriveOptimisticState` helpers as needed. Keep DOM out.
2. Define the plain store/record shapes from design §8.1 in the module (JSDoc is enough; no
   TypeScript in `assets/`). `MessageRecord` and `PartRecord` carry `version`, `partOrder`, `parts`,
   `optimistic`, `system`, `needsReconcile`; the store carries `sessionID`, `generation`,
   `turnGeneration`, `order`, `messages`, `activePromptID`, `queue`, `openParts`,
   `lastSeqByStream`, `currentStreamID`, `pendingDeltas`, `agentStatus`, `connection`.
3. Implement `deriveQueue` exactly per §8.2 invariant 13 and RR1:
   - define a visible part as a renderable part (`text` not ignored and non-empty, `tool`,
     `reasoning`, `patch`, `file`, `subtask`; not `step-start`/`step-finish`/`retry`/`compaction`/
     `snapshot`/`agent`);
   - find the last assistant with a visible part; ignore bare shells;
   - mark operator rows up to and including a valid `parentID` as processed; if `parentID` is absent
     or does not match an operator row, use the assistant's feed position as the boundary;
   - pending = operator rows after the boundary (or all operator rows if no visible assistant);
   - skip OMO system rows and rows whose classification is pending; include optimistic
     `sending`/`unknown` rows;
   - `turnContinues = lastVisible !== null && (lastVisible.time.completed == null ||
     lastVisible.finish === "tool-calls")`, forced false when `sessionStatusType === "idle"`;
   - if `turnContinues`, `queuedIDs = pending`, `activeID = null`, `nextActivePromptID = null`;
     otherwise `activeID = activePromptID if still pending, else first pending`, `queuedIDs` = the
     rest, and adopt a derived head only when no tracked ID exists; clear a tracked ID when it leaves
     pending;
   - `queue` never includes `activeID`; `optimistic` is presentation only (`sending` before 202,
     `queued` in `queuedIDs`, `accepted` when active/consumed, `unknown` while unresolved).
4. Implement `classifyOmo` exactly per §9.10 and §4.1:
   - `role === "user"`, at least one text part, and every text part is `synthetic === true` or
     contains `<!-- OMO_INTERNAL_INITIATOR -->`;
   - strip both internal markers with OMO's newline-aware regexes; unwrap all
     `<system-reminder>`/`</system-reminder>` tags case-insensitively; exclude `ignored:true` parts
     from the rendered body but include them in classification;
   - extract header lines with the OMO rule; treat a leading `BOULDER COMPLETE...` line as a title;
   - map the first recognized header to the design's kind/tone table; unknown synthetic-only text
     -> `System`/`neutral`; `title = headers.join(" · ")` bounded to 240 chars or the kind; body =
     remaining text, trimmed, omitted when empty.
5. Implement `applySnapshot` per §8.2 invariants 1/3/5/13 and RR2:
   - rebuild `order`/`messages`/`parts` atomically; increment `generation`; preserve `openParts` by
     part ID; clear `needsReconcile`;
   - seal text/reasoning parts of completed messages; leave only the last uncompleted assistant's
     text/reasoning parts unsealed; if there is no running tool and the last assistant is complete,
     seal all parts;
   - merge local optimistic rows by server message ID: adopt a server row when present (derive
     accepted/queued later), keep the local row when absent, never duplicate; never clear an
     in-flight/`unknown` acceptance;
   - clear `pendingDeltas` for parts replaced by the snapshot; preserve content for parts not present
     only as provisional local rows;
   - classify OMO from complete snapshots, recompute the queue, and return `turnChanged` when the
     captured turn generation differs from the current one.
6. Implement `rekeyOptimistic` per §7.2 step 6 and invariant 12: move the local row to the server ID
   in one mutation, keep its feed position/placeholder part ID until the upstream text part arrives,
   apply only buffered events for the server ID, merge with an existing server row without
   duplicating, and report `consumed` when the row is already covered by an assistant `parentID`.
7. Implement `parseMarkdownTable` exactly per §9.3: delimiter `^:?-+:?$` (one or more dashes), equal
   header/delimiter cell counts, escaped pipes and pipes inside backtick code spans, optional
   leading/trailing pipes, one-column/one-dash when both lines carry pipes, alignment from colons,
   body padding/extra-cell discard, at most 16 columns (else `null`), at most 200 body rows
   (`truncated:true`), 2,000 characters per cell. A prose line containing `|` followed by a
   delimiter-looking line with mismatched counts is not a table.
8. Add `test/chat-core.test.ts` importing the ESM module directly. Cover every case in design §14.1
   and the RR1/RR2/OD-specific cases listed in §6 below. No DOM is imported or required.

**Acceptance criteria:**

- `deriveQueue` passes: parentID boundary, combined reply clearing both, consume race leaving later
  rows queued, bare shell clearing nothing, no-visible-assistant head, completed assistant with
  `finish:"tool-calls"` + new prompt queued, retry, aborted assistant with idle override, completed
  previous assistant + new prompt active, streaming assistant + queued prompts, OMO exclusion,
  optimistic sending/unknown inclusion, reload reconstruction, and `activePromptID` persistence/
  clearing (RR1).
- `classifyOmo` passes every marker/header/synthetic-only/multi-part-later-part/ignored/false-positive
  case with the exact kind/tone/title/body; queue exclusion is observable via `deriveQueue`.
- `applySnapshot` passes snapshot sealing (completed messages, last uncompleted assistant), no delta
  duplication after a snapshot (including delta-before-snapshot overlap), snapshot-only growth,
  completion snapshot, optimistic merge by server ID, and never clearing in-flight/unknown
  acceptance (RR2).
- `rekeyOptimistic` passes pre-202 buffered events, no second user row, and no duplicate text.
- `parseMarkdownTable` passes escaped pipes, code spans, ragged rows, one-column/one-dash,
  prose-pipe + delimiter false positive, alignment, and caps.
- The module has no `window`/`document`/`fetch`/`EventSource`/timer references and imports cleanly in
  Vitest.

**Tests:** new `test/chat-core.test.ts` (part of `npm test`). Include explicit fixtures for:
combined reply + parentID = last queued prompt; consume race; bare shell; completed
assistant + `finish:"tool-calls"`; retry; aborted + idle; completed previous + new prompt; streaming
+ queued; delta-before-snapshot; snapshot-only growth; completion snapshot; unknown present/absent;
pre-202 rekey; table edge cases.

**Risks:** the queue is a heuristic over upstream history; `parentID` can be absent/ambiguous and
`finish` can drift. Mitigation: the snapshot/feed-position fallback, idle override, and fixtures for
every documented race; if real snapshots contradict the heuristic, stop and amend the design rather
than weaken the boundary. OMO/table grammar drift is pinned by fixtures.

**Verification / exit condition:** `npx vitest run test/chat-core.test.ts` and `npm run lint` green.

### Phase 4 - Client streaming, store, status, and hydration wiring

**Boundaries / non-goals:** convert the chat client to ESM, wire the keyed store/SSE/hydration/
status/scroll/sessions signature, and emit the module script. No send/queue UI (P5a), no inline
questions/OMO cards (P5b), no new tool/table CSS (P5c).

**Files:** `assets/chat.js`, `src/http/ui.ts`, `src/http/chat.ts` (script + status markup),
`src/http/handler.ts` (asset allowlist).

**Tasks:**

1. `src/http/ui.ts`: add an additive module-script option to `documentPage`/`appShell` (for example
   `moduleScripts?: string[]`) that renders `<script type="module" src="..."></script>`; keep the
   existing deferred `/assets/app.js` and all other pages unchanged. `renderChatPage` in
   `src/http/chat.ts` switches from `scripts: ["/assets/chat.js"]` to the module form.
2. `src/http/handler.ts`: add `/assets/chat-core.js` to the `ASSETS` allowlist with
   `text/javascript; charset=utf-8`.
3. `assets/chat.js`: convert the IIFE to an ESM module with
   `import { applySnapshot, classifyOmo, deriveQueue, parseMarkdownTable, rekeyOptimistic } from
   "./chat-core.js";` and a `main()`/guard so a page without `#chat-shell` is a no-op. Do not add a
   global.
4. Implement the store and DOM patch layer:
   - one active `ThreadStore` per the §8.1 shape; a small `sessionRuntime` map for other sessions;
   - keyed `messageNodes`/`partNodes` maps and `data-message-id`/`data-part-id`/`data-part-type`;
   - `applySnapshot`/`patchMessage`/`patchPart`/`flush` via one `requestAnimationFrame`; no full
     `replaceChildren` except empty/error/session switch;
   - preserve `openParts` in state (not by querying the DOM); restore `details.open` by part key;
     when a part's type changes (for example a provisional text part becomes reasoning), replace
     that part's DOM node and re-apply its open state;
   - one rAF flush; markdown at most every 50 ms while streaming and once on seal/idle; running tool
     output at most every 100 ms and once on completion; no render when the part version/text is
     unchanged; skip DOM work while `document.hidden` and flush once on `visibilitychange`;
   - a message shell is stored but not rendered until it has a visible part; a first visible part
     inserts it at the feed end; snapshot order is authoritative, live messages append, live parts
     append in first-seen order, and a later snapshot replaces positions only on idle/reconnect;
   - render each non-`ignored` text part as its own body in part order; `ignored` text is not
     rendered but remains available to OMO classification.
5. Implement the SSE envelope handling:
   - `stream.ready`: reset the current stream if `streamID` is new, set connection live, hydrate
     messages + prompts + todo; `seq:0` is always accepted;
   - drop `seq <= lastSeq` for the current `streamID`; a new `streamID` resets `lastSeq` and triggers
     hydration; a gap schedules one 500 ms reconcile plus the idle reconcile;
   - `stream.warning` (`frame_too_large`/`invalid_json`/`delta_too_large`) marks the active session
     for reconcile and uses the existing quiet warning channel; never a modal;
   - `message.updated` upserts a shell/metadata; `message.part.updated` replaces a part snapshot
     (or appends in first-seen order), sets `partial` when `truncated` is present, and clears that
     part's pending deltas so a snapshot already containing them is not appended twice;
     `message.part.delta` buffers per part and applies once per frame, skipping sealed parts, and
     creates a provisional `text` part when the part is missing (never a second part for an existing
     ID); `message.part.omitted` marks `partial` and schedules reconcile; deltas that arrive after a
     snapshot was generated but before it is applied are dropped, and the next
     snapshot/completion/idle reconcile recovers them;
     `session.status` updates the agent status; `session.activity` with `cause:"removed"`/`"unknown"`
     (or no cause, for an older server) schedules one reconcile; `cause:"message"`/`"status"` is
     ignored because the typed events handle it; an unknown part type marks the message
     `needsReconcile`, renders a neutral placeholder, and schedules one reconcile (never a loop);
     `todo.updated` keeps the Plan panel live and renders `truncated:true` as "List truncated" per
     §6.4. Keep the existing prompt/Todo/saved-permission/policy-warning hydration and rendering
     paths wired; only their trigger points change.
6. Implement hydration per §8.3 and RR2:
   - capture `startSeq`, `turnGeneration`, and acceptance state; set `hydrating`; buffer typed
     message/status events capped at 200 events or 256 KiB;
   - `GET /messages`; if a newer hydration started, discard; **always apply** the snapshot even for
     `sending`/`unknown` or a changed turn generation;
   - merge optimistic rows by server ID; discard buffered content events (never replay them); replay
     only the last buffered `session.status` per session with `seq > startSeq`;
   - if the event log overflowed, discard and re-fetch once;
   - if `turnGeneration !== turnGen`, schedule one follow-up GET after the turn settles; do not
     discard the applied history;
   - if content was discarded, schedule one early 500 ms reconcile in addition to the idle reconcile;
   - apply snapshot sealing, re-derive status, recompute queue, reclassify OMO, re-correlate inline
     questions, refresh the sessions signature, and restore scroll.
7. Implement the send-acceptance bookkeeping needed by P5a but without the send UI yet:
   - per-session acceptance chain/slot; `pre202` buffer for user events; `unknown` grace state with
     `UNKNOWN_ACCEPTANCE_GRACE_MS = 5000`;
   - expose `Check again` (one GET) and `Remove` (local row/gate only) after the grace; never
     auto-retry.
8. Implement idle reconcile per §8.4: stop elapsed, seal, final markdown/tool render, 200 ms
   debounced `GET /messages`, always apply/merge, follow-up when the turn changed, preserve open
   parts/scroll, recompute queue/questions/OMO/sessions signature.
9. Implement status/elapsed per §9.5: `Sending`, `Thinking`, `Working`, `Running <tool>`,
   `Waiting for you`, `Ready`, `Retrying`, `Paused`;    queue suffix `· N queued` on the allowed labels
   only; elapsed starts on acceptance/busy, is hidden below 1 s, ticks once per second, formats
   `Ns` then `Nm SSs`, freezes while waiting, and resets on `Ready`; only the elapsed text node
   updates; status is never derived from a blocking POST. Add the split label/elapsed/queue-suffix
   nodes to the `src/http/chat.ts` meta markup (or create them client-side if absent; the static page
   test in P6 asserts their presence).
10. Implement the sessions-rail signature: `sessionId`, search needle, ordered `{id,title}`,
    per-session prompt counts/flags (including inline correlated questions), runtime, and
    deleting/creating state. Selection/search repaint even when the list is otherwise unchanged;
    token ticks never call `renderSessions`.
11. Implement scroll and a11y wiring: `overflow-anchor:none` (CSS in P5c if not already), capture the
    first visible message/part + offset before an update and restore it, pin to bottom only when at
    bottom, `New messages` only when `order` grows away from the bottom, reset on session switch;
    `#chat-messages` becomes `role="log" aria-live="off"` (remove `aria-relevant`); `aria-busy` only
    during initial load; `#chat-announcer` for message-level events only, debounced 300 ms.

**Acceptance criteria:**

- The chat script is a module; `/assets/chat-core.js` is allowlisted; no IIFE/global remains; the
  page has no innerHTML usage (static test).
- Typed events patch keyed nodes; streaming a long reply does not replace the feed; open tool
  disclosures, selection, and focus survive updates; a reader away from the bottom stays anchored.
- Reconnect (`stream.ready` with a new `streamID`) hydrates and does not duplicate text; a seq gap
  produces exactly one reconcile; warnings use the quiet channel.
- Hydration always applies the snapshot and merges optimistic rows by server ID; a send that starts
  during hydration or the idle reconcile is preserved; a turn change schedules one follow-up GET; no
  deadlock and no duplicate user row.
- An `unknown` acceptance remains visible, every snapshot is applied, and after 5 s of confirmed
  absence the UI offers `Check again`/`Remove`; a later appearance resolves by ID (RR2).
- Status follows the §9.5 precedence, shows elapsed, and appends `· N queued` only where allowed;
  `Waiting for you` and the working label are never both live.
- The sessions rail repaints selection/search and prompt/runtime/deleting/creating changes but not
  token ticks.
- Manual browser smoke (dev server, existing seeded app): stream text, reconnect mid-stream, scroll
  up during streaming, switch sessions, and confirm no console/page errors. The deterministic
  version of this matrix is completed in P6.

**Tests:** `npm test` for the pure helpers and existing suites; `npm run typecheck`; `npm run build`;
manual Chromium smoke. The P6 `chat-qa.mjs` suite is the stage gate for streaming/reconnect/hydration
races/status/scroll/sessions/a11y.

**Risks:** DOM patching regressions and hydration races. Mitigation: single rAF flush, keyed nodes,
generation/sequence guards, always-apply snapshots, and the P6 fixture matrix. Old app-stream clients
must still get `session.activity`; the P1 compatibility tests guard this.

**Verification / exit condition:** `npm run lint && npm run typecheck && npm test && npm run build`
green plus the manual smoke.

### Phase 5 - Send/queue/optimistic, questions/OMO, tools/markdown/CSS

Phase 5 is split into three ordered subphases. Only one agent edits `assets/chat.js` at a time.
P5c CSS may start after P5a freezes the class/markup contract; it must not edit `chat.js` while P5b
runs.

#### 5a - Send, queue strip, optimistic rows, and status suffix

**Boundaries:** composer send flow, acceptance chain, optimistic record/presentation, queue
derivation wiring, queue strip, and status suffix. No inline questions/OMO cards (5b), no new tool/
table renderers (5c).

**Files:** `assets/chat.js`, `assets/chat-core.js` (only if a pure helper needs an additive
parameter), `src/http/chat.ts` (queue-strip markup), `src/http/styles.css` (queue-strip classes may
move to 5c; keep 5a to behavior/markup).

**Tasks:**

1. Replace the blocking send flow (`sendPrompt`, `pendingSends`, `hasActiveSend`) with:
   - trim; block only for a pending question/permission in the active session, an in-flight
     acceptance POST, or an unresolved `unknown` outcome (not for `session.status === "busy"`);
   - insert an optimistic user message keyed `local_<uuid>` with one text part and
     `optimistic:"sending"` before any network call, positioned before assistant rows for its turn;
   - a per-session short acceptance chain that serializes `?async=1` POSTs (ordering only, no
     holding queue, no persistence); `ensureSession` for a draft adopts the optimistic row into the
     new session and keeps its chain position;
   - `POST .../messages?async=1` with `{text}`; on 202 rekey to the returned `messageID` in one
     mutation, keep the local part ID provisional until the upstream text part arrives, set
     `activePromptID` when the row is the active head, and release the slot; the first upstream text
     part replaces the placeholder in the same DOM position and adopts its part ID, further user text
     parts append, and a delta for a user part is ignored while the placeholder exists; no second
     copy of the prompt is rendered;
   - on `not_sent` remove the row, release the slot, restore the draft only if the composer is still
     empty, show the inline error, and continue the chain;
   - on `unknown` rekey to the returned `messageID`, set `optimistic:"unknown"`, show
     "Delivery unknown; checking…", hold the session gate, merge every snapshot by ID, and after the
     5 s grace expose `Check again`/`Remove`; no auto-retry;
   - if the HTTP response is lost with no 202 and no error body, keep the `local_...` row, reconcile,
     and match a recent user message with identical text in the same session before offering an
     explicit retry; never auto-retry;
   - pre-202 buffered user events are applied on rekey; no second row;
   - refresh the sessions list once after 202 and once on idle using the signature guard.
2. Render the queue strip from `deriveQueue` (recompute only on message insert/role boundary/
   assistant arrival, snapshot replacement, optimistic rekey, or session switch; never on a text
   delta):
   - markup in `src/http/chat.ts` above the prompt dock (`.chat-queue-strip`) with a count chip,
     an ordered preview list, and per-row state; the strip is hidden when empty;
   - add the grid row: `grid-template-rows: auto auto auto minmax(0,1fr) auto auto auto` with
     queue = row 5, dock = row 6, composer = row 7 (update the existing explicit `grid-row` pins);
   - show up to three one-line previews plus `+N more`, horizontal scroll inside the strip on
     mobile, no page overflow; count chip is the live region, previews are not;
   - count excludes the active head; rows show `Sending…`/`Queued`/`Delivery unknown`; no remove
     control, no operator avatars/bubbles/internal markers;
   - clear only via the `parentID` boundary recompute; a bare shell or an earlier `parentID` leaves
     later rows queued.
3. Wire the queue states into optimistic presentation (`sending`, `queued`, `accepted`, `unknown`)
   and the status suffix (`· N queued`) exactly per §9.5/§9.8; the head is never counted or shown in
   the strip.
4. Add the `messages_too_large` client notice: keep the last loaded feed and show "Session too large
   to refresh; showing the last loaded state." (thread error on first load); no retry loop; a manual
   Retry may run once.

**Acceptance criteria (R2, R15, OD1/OD2 where applicable):**

- A submitted row is visible before the async POST resolves; after 202 and the first
  `message.updated` there is exactly one user row with the server ID and no visual re-mount.
- Busy sends return 202 and become queued rows (not 409); two sends are accepted in order; a combined
  reply with `parentID` = the second prompt clears both; a reply whose `parentID` stops earlier
  leaves later rows queued; a bare shell clears nothing; a completed assistant with
  `finish:"tool-calls"` + a new prompt queues it; an aborted assistant with an idle session makes the
  next prompt the head; a completed previous assistant + new prompt makes it the head; a streaming
  assistant + queued prompts shows all pending rows in the strip.
- The active head is excluded from the strip and the count; `· N queued` appears on the allowed
  labels only; `Sending` is only for an in-flight acceptance POST.
- On `not_sent` the row disappears and the draft is restored when the composer is empty; on
  `unknown` the row persists, the gate is held, every snapshot is applied, and `Check again`/
  `Remove` appear after 5 s with no auto-retry or duplicate send.
- Reload/reconnect reconstructs the queue from history; a paused stream keeps the last derived queue
  and `Retry` hydrates; a truncated idle snapshot keeps the last feed with the too-large notice.
- OMO system rows are never in the queue.

**Tests:** `test/chat-core.test.ts` covers the queue cases; browser fixtures in P6 cover the send/
busy/combined/consume-race/bare-shell/finish-tool-calls/aborted-idle/reload/unknown matrix.

**Risks:** send-order races and queue drift on lost events. Mitigation: per-session chain, 202
rekey, snapshot/idle recompute, and no client-side holding queue.

#### 5b - Inline questions, Enter/auto-advance, and OMO system cards

**Boundaries:** question cards in the feed, correlation/state precedence, keyboard behavior,
`allPendingForSession` split, OMO classification/cards, and queue exclusion. No send/queue changes
beyond consuming the existing gate; no tool/table/CSS work beyond new component classes (5c).

**Files:** `assets/chat.js`, `assets/chat-core.js` (classifier already in P3), `src/http/styles.css`
(shared classes may be added in 5c).

**Tasks:**

1. Correlation: `questionKey = ${source}:${request.id}` for reply/tombstone;
   `correlationKey = ${source}:${sessionID}:${messageID}:${callID}` for the render key. A valid tool
   ref requires non-empty `tool.messageID` and `tool.callID`.
2. Render any question with a valid tool ref inline at its `question` tool part; if the part is not
   seen, render a `preparing` placeholder at the feed end and move the same node when the part
   arrives; if the part is missing/omitted after hydration, keep it as `part-unavailable` with
   request-backed controls. Never move a correlated request to the dock and never create a second
   card. Questions without a valid tool ref keep the existing dock; permissions always stay in the
   dock.
3. Implement the card states and precedence per §9.6: `answered`/`dismissed`/`expired` >
   `tooLarge` > `part-unavailable` > `preparing` > `pending`; `stale` is a modifier. `tooLarge` is
   dismiss-only with the bounded summary/reason; `answered` reads
   `state.metadata.answers` (fallback `state.output`) and pairs with `state.input.questions[i]`;
   mismatched arrays show `state.output` + "Answer detail unavailable"; never shift answers. A
   permission with `tooLarge:true` stays in the dock as deny-only ("Details too large to review
   safely"); it offers no allow/always action.
4. Split pending sets: `allPendingForSession` (inline + dock questions + permissions) drives the
   composer gate, `Waiting for you`, per-session flags, active counts, Escape, and Ctrl/Cmd+Enter;
   `dockRenderEntries` (uncorrelated questions + permissions) drives `renderPromptDock`;
   `focusRequest()` targets the oldest inline card, then the dock, then the composer. Top-bar
   "needs input" counts remain filtered to other sessions.
5. Refactor `buildQuestionDock`/`buildQuestionField`/`renderTabs`/`syncQuestionChrome`/
   `focusOption` to accept a scope root and id prefix; share one implementation between the dock and
   inline card. Patch option/checkbox changes in place (preserve focus and the custom draft); ids are
   unique per request; tabs use roving tabindex with unique `aria-controls`; the dock keeps fixed
   ids.
6. Implement Enter and auto-advance per R1/R16 and §9.6/§9.7:
   - custom-input Enter (no Shift, not composing) triggers the current step's primary action exactly
     once: Next / Review / Send answer; multi-select includes the custom answer; an open
     confirmation makes Enter a no-op; no newline is inserted;
   - multi-question single-select selection advances immediately to the next question or Review;
     focus moves to the next question's first input/tab, or its heading, or the Review primary;
     announce `Question N of M`/`Review` once per action via `#chat-announcer`;
   - multi-select never auto-advances; a single-question block never auto-submits; skip
     auto-advance while composing or a confirmation is open; selecting while editing from Review
     advances forward from that question;
   - Ctrl/Cmd+Enter triggers the primary action from anywhere in the card; Escape cancels an inline
     confirmation/step first, then closes queue/drawers, and never rejects.
7. Question reply races: `question.replied` carries no answers. A local submit shows its draft
   answers optimistically; another tab/early event shows "Answered elsewhere" without values;
   authoritative answers come only from the completed part (or GET). A reply 404 becomes
   "Already answered or expired"; a `question.rejected` tombstone without answers becomes read-only
   "Dismissed"; a missing request after hydration becomes "Request no longer pending".
8. Render OMO system cards from `classifyOmo` per §9.10:
   - classification waits for a complete text snapshot (or idle), not a delta; live multi-part rows
     buffer for a 100 ms quiet period then classify; if the first text snapshot is omitted by the
     64 KiB cap, classify at the idle reconcile; reclassify in place if a later part changes the
     result; optimistic local rows are always operator rows;
   - system rows use `.message--system`/`.omo-card` with `OMO`, kind, tone, title, timestamp, no
     operator avatar/bubble; body is safe markdown (tables allowed), markers and
     `<system-reminder>` tags hidden; long results collapse in `<details>` using the §9.10
     thresholds and one-line preview; short reminders inline;
   - system rows never enter the queue, never count in `N queued`, and get no live-region
     announcement; their `<details>` summary is keyboard-operable.
9. Preserve focus/draft: card patches keep focus and custom drafts; on success/expiry/dismiss move
   focus to the composer only when focus was inside the removed card; never steal focus when the
   composer has a draft; placeholder -> part movement preserves focus/draft.

**Acceptance criteria (R1, R6, R16, R17):**

- A question appears at its `question` tool part, is answerable, becomes a read-only Q&A card with
  the submitted answers in the same position, and reloads from history with no new table.
- A correlated inline question (not in the dock) still disables send, shows `Waiting for you`,
  increments counts, responds to Escape/Ctrl-Cmd+Enter, and receives focus when appropriate.
- Enter advances/submits once, includes the multi-select custom answer, never inserts a newline, and
  does nothing while a confirmation is open; a 3-question block advances focus/announcement Q1->Q2,
  Q2->Q3, Q3->Review; multi-select stays; a single-question block does not auto-submit.
- `question.replied` never supplies answer values; two-tab/local-draft/delayed-part behavior matches
  §9.6.
- Every OMO fixture renders `OMO` + kind + tone + title + safe body, hides markers/system-reminder
  tags, excludes operator styling and queue membership, and collapses long results; a later-part
  marker reclassifies in place.
- The dock still renders uncorrelated questions and all permissions; no request has two controls.

**Tests:** `test/chat-core.test.ts` for classifier/queue exclusion; P6 browser fixtures for pending/
part-unavailable/answered/dismissed/expired/tooLarge/dock-only, two-tab/delayed-part, inline gate,
Enter/auto-advance/focus, OMO markers/headers/multipart/long-result/queue exclusion.

**Risks:** focus/draft loss from card patches; correlation mistakes creating duplicates; OMO header
drift. Mitigation: in-place patches with focus capture/restore, one shared card implementation,
correlation-key keying, strict OMO parity + fixtures.

#### 5c - Tool renderers, markdown tables, layout, and CSS

**Boundaries:** tool/part renderers, markdown tables, new classes/tokens, feed/composer measure,
responsive/reduced-motion. No server routes and no send/queue/question behavior beyond presentation.

**Files:** `assets/chat.js`, `assets/chat-core.js` (table parser already in P3),
`src/http/styles.css`, `src/http/chat.ts` (markup hooks), `src/http/ui.ts` only if a missing icon is
required.

**Tasks:**

1. Implement tool rendering per §9.4:
   - one `.tool-call` disclosure; summary = glyph, mono tool name, one-line preview, status chip,
     optional elapsed; `openParts` restores open state; errors auto-open on first render and stay
     open unless the user closes them;
   - previews (first line, whitespace-collapsed, max 120 chars, `title` full value, never output):
     bash command; read/ write/ edit path; grep pattern + `in <path>`; glob pattern; webfetch URL;
     websearch query; task description/agent; todowrite `N of M done` (+ `· K now`); question
     `Question · N waiting`/`Answered`; generic `state.title`/`part.title`/first scalar input/tool
     name;
   - bash: while running render `state.metadata.output` (tail) in `.tool-call__output`, or
     "Waiting for output…"; on completion use `state.output`, then `metadata.output`, then "No
     output"; follow the bottom only when the `<pre>` is within 24 px of the bottom; show
     `Running` + elapsed;
   - todowrite: read-only checklist from `state.input.todos` while running and
     `state.metadata.todos` when completed; statuses Pending/Now/Done/Dropped/Unknown; only the
     first in-progress item gets `aria-current="step"`; reuse the 3-tick priority meter with a
     visually hidden label;
   - question delegates to 5b; patch/file/subtask generic `<pre>`; read/write/edit/grep/glob/
     webfetch/websearch/generic preview + best available output/error; step-start/step-finish/retry/
     compaction/snapshot/agent hidden (retry is represented by status);
   - reasoning summary label is `Thinking`, collapsed by default, body in `<pre>`, no preview;
   - truncation notice `.tool-call__truncated`: live "Output truncated for live view; the full result
     may load when the turn ends."; ended + still truncated "Output truncated at 64 KiB."; idle
     snapshot over 8 MiB "Full output unavailable; session snapshot exceeds 8 MiB."
2. Add GFM tables to the existing DOM-only markdown renderer using `parseMarkdownTable`:
   - table starts only when a header line and matching delimiter line are valid; body rows padded/
     extra cells discarded; alignment via `data-align` (left/center/right), not inline styles;
   - cells use `renderInline` (code/strong/em/links); no block content/images/raw HTML; cells capped
     at 2,000 chars; header count from the delimiter; up to 16 columns (otherwise paragraphs), up to
     200 rows with `.message__table-note` "Table truncated to 200 rows.";
   - build `<div class="message__table-wrap" tabindex="0" role="region" aria-label="Table">` with
     `<table class="message__table"><thead><tr><th scope="col" data-align=...>`; no innerHTML;
   - streaming tables re-render at the markdown throttle and once on completion/idle; a table is not
     rendered until the delimiter row exists.
3. Update `renderMarkdown`/`startsBlock` so table detection does not swallow paragraphs, and keep all
   existing block/inline behavior (headings, lists, blockquote, fenced/inline code, strong/em,
   http(s) links, rules).
4. CSS/layout per §9.1 and §11:
   - add `--chat-feed-ratio: 75%`, `--chat-feed-min: 60ch`, `--chat-feed-max: 96rem`; at `>=1024`
     `.chat-thread__inner`, `.composer__row`, `.composer__hint` use
     `inline-size: min(100%, max(var(--chat-feed-min), var(--chat-feed-ratio)))`,
     `max-inline-size: var(--chat-feed-max)`, centered; below 1024 use `100%`/`none`;
   - share horizontal padding (`--space-6` at >=768, `--space-4` below) between
     `.chat-thread__scroll` and `.composer`; below 768 composer horizontal `--space-4` with existing
     vertical padding;
   - `.message__body` `max-inline-size: 100%`; assistant prose children (`p`, `ul`, `ol`,
     `blockquote`, `h3`-`h5`) capped at `--reading-measure` (68ch); tables/`pre`/tool bodies use full
     feed width; user bodies `min(100%, 68ch)`; dock stays 76ch; inline question cards 76ch;
   - add all new classes from §11.1 (optimistic, table wrap/table/note, tool truncated/output,
     tool-todo, chat-question/answers/state, chat-working label/elapsed/queued, queue strip,
     message--system, omo-card family); reuse existing primitives; no new color/motion/radius/spacing
     tokens;
   - responsive: queue strip row above dock (row 5), dock row 6, composer row 7; mobile preview list
     scrolls horizontally, table wrapper scrolls, no page overflow; 44 px controls below 768;
   - `prefers-reduced-motion`: no new animation/caret/pulse/typewriter; existing spinner allowed;
   - `overflow-anchor:none` on the scroll container; 2 px focus rings; touch targets.
5. Static safety: no `innerHTML` in `assets/chat.js`; all agent/question/tool text via
   `textContent`/safe markdown; metadata never becomes links.

**Acceptance criteria (R4, R7, R8, R9, R10, R11, R14, OD1):**

- Running bash shows partial output and final output; a >1 MiB running snapshot is accepted by the
  8 MiB parser, capped to the 64 KiB live window, rendered, and flagged; the collapsed summary shows
  the command; the truncation notice appears and never promises the full result unconditionally.
- `todowrite` renders a checklist with statuses/counts; previews are one line for bash/read/write/
  edit/grep/glob/webfetch/websearch/generic; tool errors auto-open.
- A GFM table with alignment renders at 390/768/1440/1920, does not overflow the page, and
  `<script>`/raw HTML cell content is text; escaped pipes/code spans/ragged rows/one-column/
  one-dash/prose-pipe false positive match the parser.
- At 1024/1359 (context closed) and 1440/1920 (sessions+context open) the padded content-box ratio is
  ~75%, ~87% (60ch floor), ~75%; below 1024 it is 100%; the 96rem cap applies; feed and composer
  share one content box; no horizontal page overflow at 390.
- Streaming does not replace the feed; open disclosures/selection/focus survive; scrolled-up readers
  stay anchored; `New messages` only for new messages.
- `#chat-messages` is `role="log" aria-live="off"`; streaming is not announced; status and queue
  count announce once; reduced motion removes non-essential motion; no innerHTML.

**Tests:** `test/chat-core.test.ts` for tables; P6 browser fixtures for tool previews/bash/todowrite/
tables/layout/scroll/a11y; manual visual QA at 390/768/1024/1440/1920 dark/light with no horizontal
overflow. P6 re-runs the automated matrix.

**Risks:** 1360-1440 width tightness (60ch floor), table parser safety, tool-output scroll behavior,
CSS grid row regressions. Mitigation: ratio assertions at the documented layout states, parser
fixtures, explicit grid-row pins, and the no-overflow gate.

### Phase 6 - Browser QA harness, live agent smoke, and docs

**Boundaries:** QA script and documentation only. No product behavior changes except fixes proven by a
failing fixture; such fixes return to the owning phase's files with a regression test.

**Files:** new `docs/design/chat-qa.mjs`; `docs/current-state.md`; `docs/design/README.md`;
`docs/plans/README.md`; `docs/journal/0006-chat-ux-overhaul.md`; `docs/journal/README.md`.

**Tasks:**

1. Add `docs/design/chat-qa.mjs`:
   - resolve Playwright/Chromium with the same optional-install resolver pattern as
     `docs/design/capture.mjs` (local `node_modules`, npx cache, optional global, `PLAYWRIGHT_CHROMIUM`
     override); no product dependency;
   - require `CHAT_QA_URL` (default `http://127.0.0.1:8792`) and `CHAT_QA_TOKEN`; fail with
     instructions when missing (blocked gate, not skip);
   - deterministic fixtures: route-intercept sessions/messages/prompts/todo/saved and inject a stub
     `EventSource` via `addInitScript`; run the design §14.3 matrix at 390/768/1024/1440/1920, dark
     and light where surfaces differ;
   - cover layout, streaming (delta-before-snapshot, snapshot-only, completion), scroll, sessions
     rail, keyboard/Enter/auto-advance, tool previews, tables, questions/races/gate, status, queue,
     OMO, reconnect, hydration races, unknown acceptance, snapshot sealing, and a11y/reduced motion;
   - assert zero page/console errors for the R1/R15/R16/R17 fixtures; assert no horizontal page
     overflow; write a JSON report and screenshots to `docs/design/artifacts/chat/`;
   - `--live` mode (no interception) runs the eight real-agent scenarios in design §14.4 against a
     managed 1.19.3 app: streaming/table, bash loop, todowrite, question/auto-advance, queued sends
     and combined reply, OMO fixture/real event, retry, reload mid-turn/while queued. Missing live
     credentials fail the gate.
2. Run the script and fix only reproducible defects; each fix gets a fixture and is re-run.
3. Update `docs/current-state.md`: async send flag/202, typed stream/seq/caps, streaming/queue/status,
   inline questions/OMO/tables, layout, asset allowlist, limits (`messages_too_large`, 8 MiB/256 KiB/
   64 KiB caps), no virtualization, no queue removal, no server OMO persistence, no DB migration.
4. Update indexes: `docs/plans/README.md` entry for 0005; `docs/design/README.md` if the design
   status/index text needs the final review result; `docs/journal/README.md` entry for 0006.
5. Add `docs/journal/0006-chat-ux-overhaul.md`: design/plan links, phases, decisions, evidence
   (commands, counts, screenshots/report paths), accepted debt, and the deploy note. Do not restate
   the design.
6. Run the full gates and both QA modes.

**Acceptance criteria:**

- `node docs/design/chat-qa.mjs` resolves Playwright and reports zero page/console errors for the
  R1/R15/R16/R17 fixture set; the full matrix passes; screenshots/report exist.
- `node docs/design/chat-qa.mjs --live` passes all eight real-agent scenarios (or is explicitly
  reported as blocked with the missing prerequisite; a silent skip is not acceptable).
- Every R1-R17 row in §6 has its listed evidence.
- Docs match the implemented routes/behavior/limits; indexes link the plan/design/journal.
- `npm run lint && npm run typecheck && npm test && npm run build` green.

**Risks:** Playwright resolution/fixture drift and live-agent nondeterminism. Mitigation: explicit
resolver and blocked-gate failure; deterministic route/EventSource fixtures separate from `--live`;
pin the agent contract in fixtures.

### Phase 7 - Deploy to `deployment-host` (owner-authorized)

**Boundaries:** deployment only. Do not commit. Do not edit product code during deploy; any defect
returns to the owning phase and the gates re-run. Local `docs/deploy/` is git-ignored and must not be
delivered.

**Tasks:**

1. Confirm owner authorization for this deployment (stage completion). Commit only if separately and
   explicitly authorized.
2. Run local gates: `npm run lint && npm run typecheck && npm test && npm run build`; run
   `node docs/design/chat-qa.mjs` (and `--live` when a local agent is available).
3. Inspect `git status`/diff; the deploy sends the working tree, so uncommitted changes go to the
   host. Ensure no secrets or local-only files are included.
4. Back up `state`, `workspace`, and `.env` on `deployment-host` to
   `<BACKUP_DIR>/<timestamp>-pre-chat-ux/` with `state.tgz`, `workspace.tgz`, `env` (see
   `docs/deploy/host.md` §4).
5. Tag the current image `hanse:rollback-<timestamp>-pre-chat-ux`.
6. Deliver the tree excluding `node_modules`, `.git`, `.omo`, `dist`, `*.log`, `state`, `.env`, and
   `docs/deploy` (the safe tar from `docs/deploy/host.md`).
7. On the host: `docker compose build && docker compose up -d --remove-orphans`.
8. Health checks: `/`, `/projects`, `/handoffs`, `/chat`, `/api/projects`, `/assets/app.css`,
   `/assets/app.js`, `/assets/chat.js`, `/assets/chat-core.js`, `/assets/favicon.svg` with the
   operator cookie; anonymous `/` -> 303 `/login?next=%2F`; `/ide/` -> 200 after redirect;
   `docker compose ps` both Up; logs `hanse serving N project(s)` with no errors. Open the chat at a
   real app and verify Live/typing/send/queue/question where reproducible.
9. Append a `docs/deploy/deploy-log.md` entry: change, image/ID, previous image, rollback tag, backup
   path, health result, extra checks, outcome.

**Rollback:** see §7. The primary rollback is the previous image tag; `state`/`workspace` restore is
only for data corruption (not expected; no schema migration, no new table, no durable chat state).

## 6. Test matrix

Cells name the primary level; every row must be red-first or fixture-proven where applicable. Unit =
Vitest; HTTP = Vitest through `handleChat`/`handleRequest`/the real server; Browser = `chat-qa.mjs`
fixtures; Live = real managed opencode 1.19.3.

| ID | Unit | HTTP | Browser | Live |
| --- | --- | --- | --- | --- |
| R1 | — | — | custom-input Enter, multi-select custom, confirmation no-op, next-step/final-step | question with multi-select/auto-advance |
| R2 | queue rekey/merge; optimistic records | 202/rekey contract | row before POST, 202 rekey, not_sent removal, unknown grace | send + queued send |
| R3 | status derivation (if pure) | — | Sending/Thinking/Working/Running/Waiting/Ready/Retrying/Paused + elapsed + `· N queued` | mid-turn status |
| R4 | — | — | reasoning summary `Thinking`, collapsed/expand | — |
| R5 | delta/snapshot policy; pendingDeltas | — | incremental text, reconnect/no duplicates, final markdown | 500-token stream |
| R6 | correlation/answered pairing | — | inline pending, answered Q&A, reload history, part-unavailable | question answer + reload |
| R7 | >1 MiB bash, tail/head caps | app-events large frame | bash partial/final/truncated | bash loop |
| R8 | preview rules (if extracted) | — | every preview, todowrite checklist, error auto-open | todowrite |
| R9 | `parseMarkdownTable` | — | table matrix + no overflow + XSS-as-text | table reply |
| R10 | — | — | 1024/1440/1920 ratios, 100% below 1024, 96rem cap, shared box | — |
| R11 | snapshot sealing/openParts | — | keyed patch, scrolled-up anchor, New messages, session switch | reload mid-turn |
| R12 | existing suite | blocking route/raw SSE/regression | all existing chat states | existing chat smoke |
| R13 | caps/seq/gap/salvage | app-events seq/warnings; messages cap | gap one reconcile, omitted/partial, no delta duplication | >8 MiB behavior if reproducible |
| R14 | — | static page (`aria-live=off`, nodes, module, no innerHTML) | token/status/queue announcements, focus, reduced motion | — |
| R15 | `deriveQueue` (all cases) | busy 202/no 409 | queue strip matrix, reload/reconnect, unknown, no remove | two queued sends + combined reply |
| R16 | — | — | Q1->Q2->Review focus/announcement, multi-select stays, single no auto-submit | multi-question |
| R17 | `classifyOmo` all fixtures | — | OMO cards, markers hidden, long collapse, queue exclusion, mobile/keyboard | real OMO event/fixture |
| OD1 | 64 KiB live caps + 8 MiB message cap tests | `GET /messages` cap | truncation notices + "Full output unavailable" | large output |
| OD2 | — | — | dock-only uncorrelated question; no feed duplicate | — |
| RR1 | queue cases with `finish`/tool-calls/idle override/activePromptID | `message.updated` forwards `finish`/`parentID` | completed tool-calls + new prompt queued; aborted idle; combined/consume race; head not in strip | queued sends across a tool gap |
| RR2 | snapshot apply/merge, unknown grace, follow-up | — | event during GET, send during hydration/idle, absent unknown -> 5 s -> Check again/Remove, later appearance resolves | reload while queued/mid-turn |

Additional required cases for the two re-review majors:

- **RR1:** `deriveQueue` asserts `turnContinues=true` for an uncompleted assistant and for a completed
  assistant with `finish:"tool-calls"`; idle overrides to false; `activePromptID` is the accepted head
  and is never in `queue`; a bare shell does not change the boundary; a combined reply with
  `parentID` = the last queued prompt clears both; a consume race leaves later rows queued.
- **RR2:** `applySnapshot` always applies even with `sending`/`unknown`; optimistic rows merge by
  server ID; an absent unknown row starts the 5 s grace and exposes `Check again`/`Remove`; a later
  appearance resolves automatically; a turn-generation change schedules one follow-up GET and never
  discards the applied history; buffered content is discarded (not replayed) and an early 500 ms
  reconcile runs.

Owner-decision cases:

- **OD1:** a running bash snapshot with >64 KiB output is tail-capped and flagged; idle full output
  appears only when the message response fits 8 MiB; over the cap the client keeps the last feed with
  the "Session too large to refresh" notice; no dedicated full-output request is made.
- **OD2:** a question without `tool` renders in the dock only; a question with a valid `tool` renders
  inline only; neither creates a duplicate.

## 7. Rollback plan

- **No DB migration.** This stage adds no table, column, index, or durable chat state. State restore
  is not expected.
- **Primary rollback:** retag the previous image and recreate without rebuilding:

  ```bash
  ssh deployment-host 'cd <INSTALL_DIR> && docker tag hanse:rollback-<timestamp>-pre-chat-ux hanse:0.1.0'
  ssh deployment-host 'cd <INSTALL_DIR> && docker compose up -d --force-recreate --no-build'
  ```

  Re-run the Phase 7 health checks. Keep the rollback tag until the next successful deploy.
- **Source rollback:** the host has no git; the previous image is the code artifact. If a source
  rollback is needed, redeploy the pre-deploy tree from a local archive taken before delivery.
- **State/workspace:** restore only if a data problem is observed (none expected). The restore
  procedure is `docs/deploy/host.md` §5: stop containers, move the broken `state`/`workspace` aside,
  restore the pre-deploy `state.tgz`/`workspace.tgz`, then start. Never restore state for a code-only
  failure.
- **Client state:** optimistic rows, queue, drafts, OMO classification, and scroll are in-memory;
  reload reconstructs authoritative history. No client rollback step is required.

## 8. What must not change

- Blocking `POST /api/apps/:app/sessions/:sid/messages` without `async=1`: same request body, 200
  `{message}` response, and upstream `/session/:sid/message` call.
- The raw per-session SSE route and its principal model; the app SSE keeps its headers, heartbeat,
  default `message` frames, backpressure, and 401/403/404/502/503 behavior (new fields/types are
  additive).
- Question/permission reply/reject routes, validation, v1/v2 `source` handling, saved permissions,
  policy warnings, session create/delete/switch, drafts, and the Plan/Todo panel.
- Auth and human-only routes; no new auth rule and no secret exposure.
- No new runtime/client dependency, bundler, framework, CSS build change, or database migration.
- No `innerHTML`/raw HTML in chat rendering; no new OMO server field, classification, or persistence.
- No Hanse-side holding queue, queue persistence/reordering/removal, or 409-on-busy send.
- No virtualization, images/embeds, message editing/deletion/reactions/attachments, or VS Code
  extension changes.
- Existing tests are not deleted or weakened; changed event expectations are updated deliberately.

## 9. Execution order and parallelization recommendation

One agent per lane; stop and hand off rather than editing another lane's files.

| Lane | Agent focus | Files | Phases | May run with |
| --- | --- | --- | --- | --- |
| S | Server stream/events | `src/opencode/events.ts`, `src/http/prompts.ts` | P1 | A, early C |
| A | Async API/client | `src/opencode/client.ts`, `src/http/chat.ts` (API route) | P2 | S, early C |
| C | Client core | `assets/chat-core.js`, `test/chat-core.test.ts` | P3 | S, A |
| W | Client wiring | `assets/chat.js`, `src/http/ui.ts`, `src/http/handler.ts`, `src/http/chat.ts` (script/status markup) | P4 | none (after S/A/C) |
| U | UI behavior/CSS | `assets/chat.js`, `assets/chat-core.js`, `src/http/styles.css`, `src/http/chat.ts` (markup) | P5a -> P5b -> P5c | P5c CSS after P5a freeze; no concurrent `chat.js` |
| Q | QA/docs | `docs/design/chat-qa.mjs`, docs/indexes/journal | P6 | none (after U) |
| D | Deploy | host + local `docs/deploy/deploy-log.md` | P7 | none (after Q + authorization) |

Recommended order: **S + A in parallel -> C in parallel with their tail -> W -> P5a -> (P5b and
P5c-CSS in parallel after the P5a markup freeze) -> Q -> D**. If only one agent is available:
S -> A -> C -> W -> 5a -> 5b -> 5c -> Q -> D.

Conflict rules:

- `src/http/chat.ts` is touched by A (API route), W (script/status markup), and U (queue-strip
  markup). Never run A and U concurrently; W must finish before U's markup edits.
- `assets/chat.js` is owned by W through P4, then U; never run U subphases concurrently with each
  other or with W.
- `assets/chat-core.js` is created in C and only additively touched by U; coordinate before editing.
- `src/http/styles.css` is owned by U/P5c; no other lane edits it.
- Docs are owned by Q; P1/P2 may update only their existing test files, not docs.

## 10. Assumptions recorded for execution

These are implementation decisions consistent with the design; if any proves inconsistent with the
design or current code, stop and amend the plan/design rather than inventing behavior.

1. The wire form is `HanseEvent & {seq, streamID}`; the projector keeps returning payloads, and
   `streamAppEvents` envelopes them. `stream.ready` uses `seq:0`.
2. `?async=1` is the only async form (`async=1`); no other truthy values are treated as async.
3. Async text is rejected when empty or whitespace-only (`empty_message`); the blocking route keeps
   its existing empty check until a separate change.
4. The 32 KiB limit is measured in UTF-8 bytes; the existing 64 KiB HTTP body cap stays.
5. `messages_too_large` is carried as an additive `OpencodeHttpError.code` and mapped to 502 by the
   route; timeouts are not treated as too-large.
6. A "visible part" for queue boundaries is the renderable set listed in Phase 3; bare shells are
   ignored.
7. OMO classification is client-only and re-runs on snapshot replacement; no server field is added.
8. `Check again` performs exactly one GET; `Remove` clears only the local row/gate. No auto-retry.
9. The queue strip has no remove control and is never persisted.
10. No commit is made by this plan; deployment is the separately authorized Phase 7.

## 11. Plan review

Plan reviewer: `momus` (review history; no separate verdict was appended to this file). The
implementation and phase-6 browser QA are recorded in
[`docs/journal/0006-chat-ux-overhaul.md`](../journal/0006-chat-ux-overhaul.md). Deployment is Phase 7
and remains owner-authorized; no commit was made.
