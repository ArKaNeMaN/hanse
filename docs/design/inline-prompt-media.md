# Design - Inline prompt media pass-through

Status: **implemented and verified** (journal 0055) - design review round 1 CHANGES REQUESTED,
round 2 PASS WITH FIXES; all findings folded.

Stage: `0046-inline-prompt-media`.

Scope: render a `file` part that `opencode` places in a user turn (typically the synthetic prompt a
tool creates for a `multimodal-looker` subagent) and serve its bytes on demand from the persisted
message part. v1 is limited to the four inline-safe image MIMEs. The operator gets the normal
attachment card (image preview, sanitized filename, size, Download).

Out of scope: importing prompt media into `app_attachments` or `agent_media`; quota accounting;
non-image prompt files (PDF, video, arbitrary binary); transcoding, thumbnails, or range requests;
Markdown `![...]()`; remote image URLs; a settings toggle; operator delivery-owned attachments
(their projection and download route are unchanged); `show_image` (unchanged).

Amends two existing rules:
- [`attachments-and-drafts.md`](./attachments-and-drafts.md) D5/M-E: "replace **every** other file
  part with a data URL" gains the inline-image exception defined here.
- [`chat-image-display.md`](./chat-image-display.md) R2/R10: tool/prompt attachments are still not
  mirrored into a store, but a user-turn image `file` part may be served on demand from the message
  part. See D10.

## 1. Problem

A `look_at`-style tool starts a subagent with a user message that carries the prompt text plus one
or more parts shaped as:

```json
{"type":"file","mime":"image/png","filename":"shot.png","url":"data:image/png;base64,..."}
```

Hanse enforces "no `data:` URL reaches the browser" (`attachments-and-drafts.md` D5/M-E). An
unknown `data:` part is rewritten to `url:""` with `truncated:true`
(`src/attachments/projection.ts:118-127`, `:226-232`). The client builds an attachment view only
when the part has `attachment.id` and a safe URL (`assets/chat-core.js:489-499`), so the part falls
back to the collapsed `file` detail (`ui/components/chat/ChatMessage.vue:228-242`), whose body is
`No output` (`:115-123`). The operator sees a file card with no content even though the bytes are
still in the opencode store.

The card is not a missing-file case: the part is intact. It is a projection case.

## 2. Requirements

| ID | Requirement |
| --- | --- |
| R1 | An unknown `file` part whose declared MIME is one of `image/png`, `image/jpeg`, `image/gif`, or `image/webp`, whose `url` is a strict base64 `data:` URL, whose decoded size is at most 20 MiB, and whose part/session/message ids are known renders as an image attachment card with sanitized name, MIME, size, and Download. |
| R2 | The bytes are read from the persisted message part on demand. Nothing is copied into `app_attachments` or `agent_media`; no quota is consumed. |
| R3 | No `data:` URL appears in a projected top-level `file` part, the synthetic event part, or the inline route response. Nested non-tool fields (for example `state.output`, `state.input`, metadata, `part.source`) remain out of scope, matching `chat-image-display.md` R10. |
| R4 | History and live projections produce the same card and URL for the same part whenever the live part event is emitted; the URL is derived from one id source (part fields with envelope-property fallback). No asynchronous projection is introduced. |
| R5 | Only `file` parts are considered. Operator delivery-owned file parts keep their current projection, and the inline route refuses them. |
| R6 | The route serves only a human principal, resolves the app from a required `project` query, validates app, session, message, and part, and never reads a filesystem path from the input. |
| R7 | The route serves only the four inline-safe image MIMEs; a payload whose sniffed type is anything else is refused, never offered as a generic download. |
| R8 | A part that does not qualify (missing id/session/message, non-image MIME, non-base64 URL, over the cap) keeps the existing projection and renders an honest fallback label in the client (in history, and in live whenever the part event is addressable), never `No output`. If the whole message exceeds the read cap, the page shows the existing history-too-large notice instead of a card. |
| R9 | A fresh inline URL returns `404` after its session is deleted; no Hanse-side state has to be cleaned. A browser-cached response may outlive deletion until `max-age` expires. |
| R10 | The route is bounded by the existing history read budget, returns stable error codes, and never leaks an upstream body or a host path. |
| R11 | The `attachments-and-drafts.md` D5/M-E and `chat-image-display.md` R2/R10 wording is amended precisely: user-turn image `file` parts may render a card and be served on demand from the message part; nested tool attachments remain invisible; `show_image` is unchanged. |

### Quality-attribute scenarios

| ID | Scenario |
| --- | --- |
| Q1 | A subagent prompt carries a 2 MiB PNG; the card shows the image in history and live, and Download returns the same bytes. |
| Q2 | A 30 MiB prompt image is projected without a URL (no card request) and the card shows the fallback label; a direct route call reads the message, rejects before decoding, and returns `413`. |
| Q3 | A part id from another app, session, message, or a delivery-owned part is requested; the route returns `404` and leaks nothing. |
| Q4 | Twenty image cards load lazily; reads queue on the history budget and each renders. If the budget wait expires, the excess gets `503 inline_busy` with `Retry-After` and the card shows `Image unavailable`; a reload retries. |
| Q5 | The session is deleted; the cards disappear and a fresh URL returns `404`. |
| Q6 | A message with two 20 MiB images exceeds the 48 MiB history cap; the page shows the history-too-large notice, no card and no crash. |

## 3. Verified facts

### 3.1 opencode data

- The `look_at` tool creates a subagent session whose first user message has a synthetic text part
  and one `file` part per input file, with the image in a `data:` URL. The part carries `id`, `mime`,
  `filename`, `sessionID`, and `messageID`; it has no Hanse `attachment` metadata and no delivery
  row.
- `GET /session/:id/message/:messageId` returns that message and is wrapped by `getMessage`
  (`src/opencode/client.ts:568`). Its default cap is 8 MiB and its default timeout is 5 s;
  `MESSAGES_HISTORY_MAX_BYTES` is 48 MiB and `MESSAGES_RESPONSE_TIMEOUT_MS` is 30 s
  (`:201`, `:204`).
- `readJson` throws `OpencodeHttpError` with status `0` and no code on a capped-read overflow
  (`src/opencode/client.ts:901-910`).
- `withHistoryBudget` (`:589-604`) accounts `maxBytes * 4` against
  `HISTORY_READ_BUDGET_BYTES`; `getMessage` does not use it.

### 3.2 Hanse today

- `createMessageProjector` (`src/attachments/projection.ts:93-179`) rewrites delivery-owned file
  parts and blanks every other `data:` URL.
- `createEventAttachmentResolver.projectFilePart` (`:194-249`) does the same for live events and
  the raw-envelope stream (`src/opencode/events.ts:2190-2215`); its cache is keyed by part id
  (`:209`, `:233`).
- `EventProjector.partUpdated` reads ids from the part and drops the event when either is missing
  (`src/opencode/events.ts:1815-1828`), even when `properties.sessionID`/`messageID` carry them.
- `isInlineSafeMime` (`src/attachments/mime.ts:81`) allows PNG, JPEG, GIF, WebP. `sniffMime`
  (`:32`) is available and always returns a value.
- `INLINE_MAX_BYTES` is 20 MiB (`src/attachments/inline.ts:5`); the send path never inlines more
  than that per attachment and never more than 40 MiB of base64 per message.
- `safeOriginalName` (`src/attachments/names.ts:24`) produces a single-line, separator-free name;
  `encodeContentDisposition` (`:80`) never places a raw name in a header.
- `readDeliveryByPartId` (`src/attachments/store.ts:145`) identifies delivery-owned parts.
- `handleAttachmentDownload` (`src/http/chat.ts:1687`) and `handleAgentMediaDownload`
  (`src/http/agent-media.ts:63`) are the download-route precedents: human principal, same-origin
  cookie, `nosniff`, `content-disposition`, `private, max-age=3600`, no Range.
- Read-only chat routes use `withReadEndpoint` (`src/http/chat.ts:1881`) and `endpointFor`, never
  starting a stopped agent; `readFailureResponse` maps `AgentStoppedError` to `503 agent_stopped`
  and transport failures to `502 agent_unavailable` (`:1869-1875`).
- The client card (`ui/components/chat/ChatAttachmentCard.vue`) already renders `<img loading="lazy">`
  from `downloadURL`, sets `failed` on `@error`, and keeps a Download link afterwards.
- The chat fallback (`ChatMessage.vue:115-123`) ignores `truncated`, so it says `No output`.

## 4. Alternatives considered

| Alternative | Why not |
| --- | --- |
| Import unknown `data:` parts into `agent_media` | Costs a write path on history reads, idempotency and temp-file races, quota accounting, an origin/label change, and an async projector or a second import queue. Deferred. |
| Return the `data:` URL to the client | Violates R3 and the payload cap; base64 in the DOM is the exact thing the projector exists to prevent. |
| Serve the original workspace path | Hanse never forwards host paths; the file may have changed or vanished, and it can be outside the app root. |
| Client-side fetch of the message and decode | The client cannot read opencode directly and would need a new authenticated JSON endpoint that returns base64, which is worse than a binary route. |
| Cache decoded bytes in the coordinator | Tempting for repeat views, but adds memory pinning, eviction, and invalidation. The browser cache covers reloads; deferred. |
| Allow every MIME kind as a download | Expands an agent-controlled `data:` payload into an arbitrary file-download surface. v1 stays image-only; non-images keep the fallback label. |
| Synthesize only for subagent sessions | The same shape can appear in any user turn created by a tool; restricting by ancestry adds a lookup without a benefit. |
| Start the agent on an image GET | An `<img>` request must not undo idle auto-stop; the route follows the read-only chat pattern and returns `503 agent_stopped` instead. |

## 5. Decisions

### D1 - Project the part, do not copy it

For an unknown `file` part (no delivery row) with a known `id`, session id, and message id, all of:

- declared `mime` is one of the four inline-safe image types;
- `url` is non-empty `data:<mime>;base64,<strict base64>` with length divisible by four;
- the decoded size estimated from the base64 length is between 1 byte and `INLINE_MAX_BYTES`
  (20 MiB),

rewrite the part to:

```ts
{
  ...part,
  filename: safeOriginalName(part.filename) || "image",
  url: inlineMediaUrl(target, { sessionID, messageID, partID }),
  attachment: { id: partID, size: estimatedSize, mode: "inline", kind: "image", inline: true },
}
```

`mime` and `kind: "image"` are explicit so the client card and the MIME badge agree. Guard a
non-string or empty `filename` before calling `safeOriginalName`. Every other file part keeps
today's treatment: any `data:` URL and any `file:` URL is replaced with `""` and `truncated:true`;
an `http(s)` or other non-data URL is left untouched (pre-existing behavior).

### D2 - One route, on demand, from the message part

`GET|HEAD /api/apps/:appKey/sessions/:sessionId/messages/:messageId/parts/:partId/inline?project=<projectId>`

The `project` query is required. The handler:

1. authenticates a human principal and resolves the app;
2. rejects a deleting app/project with `409 deletion_pending`;
3. resolves the endpoint with `endpointFor` and returns `503 agent_stopped` when the app is stopped
   (it never starts the app);
4. refuses a delivery-owned part (`readDeliveryByPartId`) with `404`;
5. acquires `maxBytes * 4` from `historyReadBudget` (10 s wait) and holds it through step 9, then
   reads one message with `getMessage` at `maxBytes = MESSAGES_HISTORY_MAX_BYTES` and the 30 s
   response timeout, so the raw read, JSON parse, and decode are all inside one accounted
   reservation;
6. finds the part by id and validates it is a `file` part of that message/session;
7. parses the data URL, estimates the decoded size before allocating, and rejects `> 20 MiB`;
8. decodes, sniffs the MIME, and refuses a non-image payload;
9. writes the bytes (or only the headers for `HEAD`).

The route is wired in `src/http/server.ts` next to the attachment and agent-media downloads because
it returns a raw `ServerResponse`, not the buffered `HttpResponse` the chat router returns.

### D3 - Human-only, id-bound, no paths

`principalFrom` must resolve a human principal (cookie or bearer, matching the download routes).
The app, session, message, and part all come from the path; the handler validates the part is in the
message it read for that session and app. Nothing in the request selects a filesystem path.

### D4 - Sniffed MIME is authoritative; v1 is image-only

The decoded bytes are sniffed with `sniffMime(head, safeName)`. The sniffed MIME must be one of the
four inline-safe image types; otherwise the route returns `415 inline_media_unsupported`. The
declared MIME is display-only and never becomes a header value. `x-content-type-options: nosniff` is
always set.

### D5 - Synchronous projection, shared helper, no file-part cache

The URL is computable from ids alone. Both projectors call one helper in
`src/attachments/inline-media.ts`.

- `createMessageProjector` receives the session id explicitly (a new argument; it must not depend on
  `message.info.sessionID` being present).
- `EventProjector.partUpdated` falls back to `properties.sessionID`/`properties.messageID` when the
  part omits them (before the missing-id check, rejecting only a present/present conflict) and
  passes the ids to `projectFilePart(part, sessionID, messageID)`.
- `projectRawEnvelope` passes the envelope ids the same way.
- `createEventAttachmentResolver` does not read or write its per-part cache for `file` parts, so a
  first stripped observation can never mask a later projectable one. The cache remains for other
  part types.

If no session or message id can be derived, the live part event is dropped (pre-existing behavior);
history uses the message envelope and renders the fallback. `partUpdated` derives the ids before
the missing-id check, so an envelope-only part is not dropped.

### D6 - Bounds

- decoded part cap: 20 MiB (`INLINE_MAX_BYTES`); above it, `413 inline_media_too_large`, and the
  projection does not synthesize;
- one-message read cap: 48 MiB (`MESSAGES_HISTORY_MAX_BYTES`); a larger message maps the capped-read
  overflow to `413 inline_media_too_large` (a new `messages_too_large` code on the bounded read) and
  the history page shows its existing too-large notice;
- memory: the handler reserves `maxBytes * 4` from `historyReadBudget` for the read, parse, and
  decode, with a 10 s wait; the excess gets `503 inline_busy` with `Retry-After: 1`. Because the
  reservation is the full history slice, an inline read can make a concurrent history page read
  wait up to its 2 s budget (`503 history_busy`); this rare lazy-load/hydration overlap is accepted
  for v1, and a dedicated inline budget is a follow-up;
- no Range; `HEAD` decodes only the sniff window (first 512 bytes), never the full payload, and
  returns the same headers without a body;
- `cache-control: private, max-age=3600`.

### D7 - Honest fallback instead of `No output`

For a `file` part with no attachment view, the client body becomes:

- `Inline content is not available.` when `data.truncated === true`;
- `No preview` otherwise.

`ChatAttachmentCard` also stops offering Download after `<img>` fails, showing `Unavailable`
instead. This is the fallback for R8, for a route `404`, and for a route `415`.

### D8 - Errors

| Status | Code | When |
| --- | --- | --- |
| 400 | `project_required` | missing `project` query |
| 401 | `sign_in_required` | no principal |
| 403 | `human_only` | non-human principal |
| 404 | `inline_media_not_found` | unknown app/session/message/part, delivery-owned part, not a file part, not a base64 data URL, empty payload |
| 409 | `deletion_pending` | app or project is being deleted (matches chat reads) |
| 413 | `inline_media_too_large` | decoded part over 20 MiB, or the message read overflowed 48 MiB |
| 415 | `inline_media_unsupported` | sniffed MIME is not one of the four safe image types |
| 502 | `agent_unavailable` | transport failure or a failed message read |
| 503 | `agent_stopped` | the app is not running (read-only route; no start) |
| 503 | `inline_busy` | the history budget wait expired; includes `Retry-After` |

Error bodies are JSON with `cache-control: no-store`; upstream bodies are never echoed. An upstream
`getMessage` `404`/`410` maps to `404 inline_media_not_found`; a timeout, `5xx`, or transport
failure maps to `502 agent_unavailable`.

### D9 - Deletion, cache, and durability

Nothing is stored, so there is nothing to sweep. Deleting the session (the subtree delete already
handles subagent sessions) removes the parts upstream; a fresh inline URL then returns `404`.
`private, max-age=3600` may serve a cached image after deletion until it expires, the same
trade-off as an operator attachment; Q5 tests a fresh request.

### D10 - Invariant amendment

`chat-image-display.md` R2 said "Other tool attachments are never mirrored automatically." That
stays true: nothing is copied into a Hanse store, attached to a different message, or published
through `show_image`. This stage adds: a user-turn
`file` part whose declared MIME is an inline-safe image may render a card and its bytes may be
served on demand from the persisted message part; nested tool attachments remain invisible;
`show_image` is unchanged. `attachments-and-drafts.md` D5/M-E gains the same exception, so the two
documents and the code agree.

### D11 - Bounded single-message read

`getMessage` gains an optional `overflowCode` option threaded to `readJson`. The route owns the
history-budget reservation around the read and the decode (D2 step 5), so `getMessage` keeps its
existing budget behavior and other callers are unchanged. `readJson` attaches the code to the
status-`0` overflow error, so the route can map it to `413` instead of confusing it with a timeout.

## 6. Impact

| Area | Change |
| --- | --- |
| `src/attachments/inline-media.ts` | New: URL builder, path parser, strict data-URL header parser and decoder, size estimate, limits. |
| `src/attachments/projection.ts` | Synthesize the inline image view in the history projector; add the session id argument; skip the file-part cache. |
| `src/opencode/events.ts` | Pass envelope ids to `projectFilePart`; keep the stripped fallback. |
| `src/opencode/client.ts` | Add the `overflowCode` option to the bounded read; no default changes. |
| `src/http/inline-media.ts` | New: human-only handler with auth, deletion guard, endpoint read, id validation, strict parse, sniff, caps, budget, HEAD. |
| `src/http/server.ts` | Route the new path before the chat router. |
| `src/http/chat.ts` | Export or reuse the read-failure/stopped helpers as needed. |
| `ui/components/chat/ChatMessage.vue` | Fallback label for unrenderable `file` parts. |
| `ui/components/chat/ChatAttachmentCard.vue` | No Download link after a failed image load. |
| Tests | Unit: parsers/URL, history projection, live resolver and id fallback, bounded read code, route (auth, project requirement, id binding, delivery-owned, MIME, strict base64, caps, HEAD, budget/busy, deletion), client fallback and failed-download state, multi-part history-too-large. |
| Docs | This doc, `attachments-and-drafts.md` D5, `chat-image-display.md` R2/R10, `docs/current-state.md`, a journal entry, and the design/plan indexes. |

## 7. Review

### Round 1 (`oracle`, independent design review) - CHANGES REQUESTED

| # | Severity | Finding | Disposition |
| --- | --- | --- | --- |
| 1 | BLOCKER | The design contradicted `attachments-and-drafts.md` D5/M-E without amending it. | Folded: R11 and D10 amend D5/M-E and `chat-image-display.md`; the old test splits into conforming and non-conforming cases. |
| 2 | BLOCKER | R3 over-claimed "no `data:` URL anywhere". | Folded: R3 is scoped to the projected top-level file part, the synthetic part, and the route response; nested fields inherit the existing R10 caveat. |
| 3 | BLOCKER | R4/R8 parity breaks when a part omits ids; `partUpdated` drops the event. | Folded: D5 uses envelope ids as the fallback and forwards a stripped part instead of synthesizing; tests cover the id fallback. |
| 4 | BLOCKER | The 413-for-message-overflow branch is not implementable with the current `readJson` error. | Folded: D11 adds `overflowCode`; D6/D8 map `messages_too_large` to 413. |
| 5 | MAJOR | `ensure` on a GET starts a stopped app and defeats idle auto-stop. | Folded: D2 uses `endpointFor` and returns `503 agent_stopped`; the start behavior is removed. |
| 6 | MAJOR | The route's memory was outside the documented budget. | Folded: D2/D6 reserve `maxBytes * 4` from `historyReadBudget`; the separate count limiter is cut. |
| 7 | MAJOR | All-MIME and delivery-owned parts become downloads. | Folded: v1 is image-only; the route refuses delivery-owned and non-image payloads. |
| 8 | MAJOR | Base64 parsing was too lenient. | Folded: D1 requires a strict base64 payload and length divisibility; D2 estimates the size before decoding. |
| 9 | MAJOR | Untrusted filename/MIME reached headers and the DOM. | Folded: D1 applies `safeOriginalName`; D4 uses only the sniffed MIME in headers. |
| 10 | MAJOR | Missing upstream-failure error rows; conflated codes. | Folded: D8 adds `agent_stopped`, `agent_unavailable`, `inline_busy` with `Retry-After`, and `415`. |
| 11 | MAJOR | The live resolver could cache a stale stripped file part. | Folded: D5 disables the cache for file parts. |
| 12 | MAJOR | Q4's 20-image case fails permanently after 503. | Folded: Q4 documents queueing on the budget, the 10 s wait, and the reload path; the card shows `Image unavailable` after a failed load. |
| 13 | MAJOR | A multi-part prompt over 48 MiB cannot render any card. | Folded: R8/Q6 state the history-too-large behavior; D6 documents it. |
| 14 | MINOR | Constant name mismatch; non-data URL wording; Q2 wording; `getMessage` timeout; cache vs deletion; required `project`; MIME display mismatch; HEAD decode; `truncated` field name; internal projector note; missing impact entries. | Folded across D1, D2, D6, D8, D9, R9, Q2, and §6. |

### Round 2 (`oracle`, focused re-review) - PASS WITH FIXES

No remaining BLOCKERs. Residual MAJORs folded:

| # | Finding | Disposition |
| --- | --- | --- |
| 15 | The history-budget reservation was released before the decode, so the decode peak was outside the budget and two decodes could overlap. | Folded: D2 owns the reservation through decode; D6 documents the history-starvation trade-off. |
| 16 | The amended `chat-image-display.md` R2 said a part may render a card and then "nothing is published". | Folded: R2 and D10 now distinguish `show_image` publication from automatic rendering of a user-turn part. |
| 17 | D1 left non-data file URLs untouched, contradicting "Hanse never forwards host paths". | Folded: a `file:` URL is stripped like a data URL; `http(s)` stays pre-existing. |
| 18 | `HEAD` cannot produce a sniffed `content-type` without decoding. | Folded: D6 decodes only the 512-byte sniff window. |

Plan must not miss: guard non-string `filename`; reject empty base64; map upstream 404/410 to 404;
test the overflow code, timeout/5xx, no file-part cache, delivery-owned 404, required `project`, and
the `Retry-After` path.

Verdict: **PASS WITH FIXES** - all findings folded; implementation may proceed.
