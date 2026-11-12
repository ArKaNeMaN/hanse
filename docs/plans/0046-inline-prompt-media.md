# 0046 - Inline prompt media pass-through

> Status: implemented and verified (journal 0055); plan reviewed (`momus` rounds 1-2; round 2
> OKAY WITH FIXES, all findings folded).
> Design: [`docs/design/inline-prompt-media.md`](../design/inline-prompt-media.md) (Oracle rounds 1-2;
> round 2 PASS WITH FIXES, all findings folded).
> Owner decisions: the owner approved option 1 (honest fallback) plus option 2b (on-demand serving)
> on 2026-11-11. v1 is image-only; the design records why. No commit is authorized by this plan.

## Bindings (from `docs/process.md`)

- Design author: maintainers. Design reviewer: `oracle` (done: PASS WITH FIXES, folded).
- Plan author: maintainers. Plan reviewer: `momus` (pending).
- Design docs: `docs/design/` (index `docs/design/README.md`).
- Plans: `docs/plans/` (index `docs/plans/README.md`).
- Journal: `docs/journal/` (index `docs/journal/README.md`). Next entry: `0055`.
- Open questions: none; the owner decision and the image-only cut are recorded in the design.
- Language: English.
- Commit policy: one coherent stage commit (code + tests + docs + record) only on explicit owner
  instruction. This plan makes no commit.

## 1. Goal

A `file` part that `opencode` puts in a user turn (typically a tool-created subagent prompt) renders
as an image attachment card instead of a `file <name>` card with `No output`. The bytes are served
on demand from the persisted message part through a human-only same-origin route; nothing is copied
into Hanse storage, no quota is used, and no projector becomes asynchronous. Every non-qualifying
`file` part gets an honest fallback label.

## 2. Non-goals

- No import into `app_attachments` or `agent_media`, no new table or migration, no quota change.
- No non-image prompt files (PDF, video, arbitrary binary) in v1; they keep the fallback label.
- No Markdown images, remote image fetch, transcoding, thumbnails, or Range requests.
- No change to operator delivery-owned attachments, `show_image`, or the agent-media store.
- No settings toggle, no client retry loop, no decoded-byte cache.
- No async projector and no start-on-view behavior.

## 3. Invariants

- **I1**: No `data:` URL appears in a projected top-level `file` part, the synthetic event part, or
  the inline route response. Nested non-tool fields stay out of scope (chat-image-display R10).
- **I2**: History and live projections produce the same inline URL for the same part whenever the
  live part event is emitted. Ids come from the part fields, with the envelope properties as the
  fallback.
- **I3**: A delivery-owned file part is never converted to an inline URL and the route refuses it.
- **I4**: The projection is synchronous and performs no filesystem or network I/O. It only parses,
  estimates, and builds a URL.
- **I5**: The route is read-only: human principal only, `endpointFor` (never `ensure`), no
  filesystem path from the request, and no state written.
- **I6**: The route is accounted in the existing memory ceiling: it holds a `historyReadBudget`
  reservation of `MESSAGES_HISTORY_MAX_BYTES * 4` through the read, parse, and decode.
- **I7**: An image whose sniffed type is not PNG/JPEG/GIF/WebP is refused, never served as an
  attachment.
- **I8**: A non-qualifying part never renders `No output`; a failed image load never leaves a live
  Download link.
- **I9**: Internal readers (`defaultMessageProjector`, notification/context paths) keep the old
  strip behavior.

## 4. Phases

### Phase A - Shared inline-media module and history projection

Files: `src/attachments/inline-media.ts` (new), `src/attachments/projection.ts`,
`src/http/chat.ts`, `test/inline-media.test.ts` (new), `test/attachments-inline.test.ts`,
`test/chat-stage-c.test.ts`.

Steps:

- **A1.** Add `src/attachments/inline-media.ts`:
  - `inlineMediaRoute(target: { appKey: string; projectId: string }, ids: { sessionID: string; messageID: string; partID: string }): string` returning
    `/api/apps/<appKey>/sessions/<sessionId>/messages/<messageId>/parts/<partId>/inline?project=<projectId>`
    with `encodeURIComponent` on every segment.
  - `parseInlineDataUrl(value: unknown): { mime: string; base64: string; base64Length: number; size: number } | null`:
    accept only `^data:(image/(?:png|jpeg|gif|webp));base64,([A-Za-z0-9+/]*={0,2})$`, require a
    non-empty payload, `payload.length % 4 === 0`, and a valid padding count; compute
    `size = (length / 4) * 3 - padding` without decoding; return the base64 payload.
  - `decodeInlineDataUrl(parsed, maxBytes?: number): Buffer` using
    `Buffer.from(maxBytes === undefined ? parsed.base64 : parsed.base64.slice(0, Math.ceil(maxBytes / 3) * 4), "base64")`;
    a caller that passes `maxBytes` (HEAD) decodes only the sniff window (684 base64 chars for 512
    bytes).
  - `inlineImagePart(part, ids, target): Record<string, unknown> | null` implementing design D1:
    require a string `id`, non-empty session/message ids, `isInlineSafeMime(part.mime)`, a parsed
    data URL with `1 <= size <= INLINE_MAX_BYTES`; return the rewritten part with
    `filename: safeOriginalName(stringFilename) || "image"`, `url: inlineMediaRoute(...)`,
    `attachment: { id, size, mode: "inline", kind: "image", inline: true }`. Never throw on hostile
    input.
  - Export `INLINE_READ_BUDGET_WAIT_MS = 10_000` for the route.
- **A2.** `createMessageProjector` gains a session id argument (or an optional `sessionID` field on
  its target) and uses it for `inlineImagePart`. Three call sites in `src/http/chat.ts`
  (`readMessagesResponse`, the blocking response, `computeTurnSnapshot`) pass `sessionId`.
- **A3.** In the history projector's unknown file-part branch, use
  `{ sessionID: <projector arg>, messageID: message.info.id, partID: part.id }`, then order:
  1. delivery row -> existing `projectedFilePart`;
  2. `inlineImagePart` -> use it;
  3. `data:` or `file:` URL -> `url:""`, `truncated:true`;
  4. `http(s)`/other -> leave untouched (pre-existing).
- **A4.** Update the fixtures precisely:
  - `test/attachments-inline.test.ts:334-354`: the unknown part is a `data:image/png` with **no
    `mime`**, so it stays a fallback case (assert no top-level `data:`); add a separate eligible
    image part with `mime: "image/png"`, a part id, and the projector's session id, and assert the
    route URL, sanitized filename, size, and `attachment`.
  - `test/attachments-inline.test.ts` (the `defaultMessageProjector` case near `:425`) keeps the
    PDF strip.
  - `test/chat-stage-c.test.ts:582-615`: the PDF part is the non-image fallback (keep `url:""`,
    `truncated:true`); add a qualifying image part and assert the inline URL.
  - `test/agent-media-projection.test.ts:79`: keep it compiling (optional `sessionID`); add a
    projector call with a session id and a qualifying image.
  - Add over-cap, malformed, empty, missing ids, `file:` URL, and delivery-owned cases.

Acceptance:

- A conforming image part in history has the route URL, `attachment.id === part.id`, a sanitized
  display name, an estimated size, and no `data:` in its top-level `url`/`attachment`.
- A non-image, over-cap, malformed, empty, or id-less part keeps `url:""` + `truncated:true` (for
  data/file URLs).
- A delivery-owned part still projects to the attachment download URL.
- Internal readers still strip (the `defaultMessageProjector` test is unchanged).

### Phase B - Live projection, id fallback, no file-part cache

Files: `src/attachments/projection.ts`, `src/opencode/events.ts`,
`test/agent-media-projection.test.ts`, `test/inline-media.test.ts`.

Steps:

- **B1.** `EventAttachmentResolver.projectFilePart(part, sessionID?, messageID?)`: delivery row
  first; else `inlineImagePart`; else the current strip. Do not read or write the resolver's
  `parts` cache for `file` parts.
- **B2.** `EventProjector.partUpdated`: replace the current early id drops (`events.ts:1821-1829`)
  with this order:
  1. drop when `part.id` or `type` is missing;
  2. derive `sessionID = partSessionID ?? propertySessionID` and
     `messageID = partMessageID ?? propertyMessageID`;
  3. drop when a derived id is still missing;
  4. drop when both a part id and a property id are present and disagree (session and message);
  5. use the derived ids in the emitted event and pass them to
     `projectFilePart(part, sessionID, messageID)`.
- **B3.** `projectRawEnvelope`: pass `properties.sessionID`/`properties.messageID` (falling back to
  the part fields) to `projectFilePart`.
- **B4.** Tests: live emits the same URL as history for the same part; a part with ids only on the
  envelope synthesizes (both `partUpdated` and `projectRawEnvelope`); a part with no derivable ids
  is dropped by the typed `partUpdated` path only, while `projectRawEnvelope` forwards it with the
  url stripped and history uses the message envelope (documented); a first event with an empty URL
  followed by a data URL for the same part id synthesizes (no stale cache); a delivery-owned part
  still projects to the attachment URL.

Acceptance: B1-B4 pass; the live and history URLs are byte-identical; no top-level `data:` appears
in the emitted part.

### Phase C - Bounded read code and the inline route

Files: `src/opencode/client.ts`, `src/http/inline-media.ts` (new), `src/http/server.ts`,
`test/inline-media-http.test.ts` (new), `test/client.test.ts`.

Steps:

- **C1.** `OpencodeRequestOptions` gains `overflowCode?: string`; `readJson` throws
  `new OpencodeHttpError(path, 0, \`response body exceeded ${maxBytes} bytes\`, options?.overflowCode)`.
  `getMessage` passes it through; no default changes.
- **C2.** Add `src/http/inline-media.ts`:
  - route regex `^/api/apps/([^/]+)/sessions/([^/]+)/messages/([^/]+)/parts/([^/]+)/inline$`;
  - require `project` (`400 project_required`); `principalFrom` with `kind === "human"` (a
    non-human principal is `403`, mirroring `handleAgentMediaDownload`); `findApp`; reject a
    deleting app/project with `409 deletion_pending`;
  - resolve `deps.manager?.endpointFor?.(app.id)`; if undefined, `503 agent_stopped`; never
    `ensure`;
  - refuse `readDeliveryByPartId` with `404`;
  - acquire `historyReadBudget.acquire(MESSAGES_HISTORY_MAX_BYTES * 4, INLINE_READ_BUDGET_WAIT_MS)`;
    if undefined, `503 inline_busy` + `Retry-After: 1`; hold it through decode and response write;
  - `getMessage(endpoint, sessionId, messageId, { maxBytes: MESSAGES_HISTORY_MAX_BYTES, timeoutMs: MESSAGES_RESPONSE_TIMEOUT_MS, overflowCode: "messages_too_large" })`;
    map `messages_too_large` to `413`, upstream 404/410 to `404`, timeout/5xx/transport to `502`,
    any other upstream status to `502`;
  - find the part by id; require `type === "file"` and, when present, matching
    `sessionID`/`messageID`; parse with `parseInlineDataUrl`; reject empty/malformed `404`; reject
    `size > INLINE_MAX_BYTES` `413`;
  - `filename = safeOriginalName(typeof part.filename === "string" ? part.filename : "") || "image"`;
  - decode (`HEAD`: only the 512-byte sniff window via `decodeInlineDataUrl(parsed, 512)`); sniff
    `sniffMime(bytes.subarray(0, 512), filename)`; require an inline-safe image mime, else `415`;
    `Content-Type` is the sniffed mime, never the declared one;
  - headers: `content-length`, `content-disposition: inline; filename...`,
    `x-content-type-options: nosniff`, `cache-control: private, max-age=3600`;
  - `GET` writes the buffer; `HEAD` writes the headers from the estimate and ends;
  - JSON errors with `cache-control: no-store`; never echo an upstream body.
- **C3.** Wire the route in `src/http/server.ts` next to the attachment and agent-media downloads,
  before the chat router, for `GET`/`HEAD`; unknown methods `405`.

Acceptance: the HTTP tests cover 400 missing project, 401, 403 (agent principal), 404 unknown
app/session/message/part, 404 delivery-owned, 404 malformed/empty, 409 deletion, 413 per-part and
message overflow, 415 non-image, 502 timeout/5xx, 503 stopped, 503 budget busy with `Retry-After`,
200/HEAD headers, no `data:` in the body, sanitized `content-disposition`, and no path in the
payload. A stopped app is never started.

### Phase D - Client fallback and failed-download state

Files: `ui/components/chat/ChatMessage.vue`, `ui/components/chat/ChatAttachmentCard.vue`,
`test/ui/chat-message.test.ts`, `test/ui/chat-image-card.test.ts`; `test/chat-core.test.ts` only if
the normalizer changes (it does not).

Steps:

- **D1.** In `ChatMessage.vue` `detailsBody`, for a `file` part with no attachment view:
  `data.truncated === true` -> `Inline content is not available.`; otherwise `No preview`. Keep the
  existing key order for non-file parts.
- **D2.** In `ChatAttachmentCard.vue`, when `failed` is true, do not render the Download anchor;
  render `Unavailable` instead. Keep `Image unavailable` in the preview.
- **D3.** In `test/ui/chat-message.test.ts`: a truncated file part renders the inline label, not
  `No output`; a non-truncated file part renders `No preview`. In
  `test/ui/chat-image-card.test.ts`: an image error flips the card to
  `Image unavailable`/`Unavailable` and removes the download link; a normal image still renders,
  and the existing non-image Download assertion stays true.

Acceptance: D1-D3 pass; no `No output` for file parts.

### Phase E - Docs, record, and full verification

Files: `docs/current-state.md`, `docs/journal/0055-inline-prompt-media.md` (new),
`docs/journal/README.md`, `docs/design/inline-prompt-media.md` (status),
`docs/design/README.md`, `docs/plans/README.md`.

Steps:

- **E0.** Verify `docs/design/attachments-and-drafts.md` D5/M-E and
  `docs/design/chat-image-display.md` R2/R10 still carry the amendment from the design stage; no
  edit is expected, but drift must be caught before the record.
- **E1.** Update `docs/current-state.md` agent-image paragraph: the human-only inline route, image
  only, on-demand, no store/quota, no start-on-view, the 20 MiB/48 MiB caps, and the fallback label.
- **E2.** Write the journal entry: context, the design rounds, what was built, the accepted
  trade-offs (history-budget exclusivity, no client retry, browser cache vs deletion), the tests,
  and the explicit non-goals.
- **E3.** Update the design, plan, and journal indexes and mark the design/plan status.
- **E4.** Run the full gate set and record the evidence in the journal.

Verification commands (all must be green):

```bash
npm run lint
npm run typecheck
npm run typecheck:ui
npm test
npm run build
npm run check:sensitive
npm run test:e2e   # the chat card rendering changes; report any pre-existing failure separately
```

Acceptance: every command passes (or a pre-existing unrelated failure is identified with evidence);
the journal records the commands and results; no commit is made.

## 5. Risks and mitigations

| Risk | Mitigation |
| --- | --- |
| The route reads a 48 MiB message per image and holds the whole history budget. | Hold the reservation through decode; wait 10 s; document the rare hydration overlap; a dedicated inline budget is a follow-up. |
| A mislabeled payload (declared image, HTML bytes) shows a card then fails. | The route sniffs and returns `415`; the card shows `Image unavailable` and no Download. |
| An upstream part shape changes. | The parser is strict and falls back to the label; tests cover unknown shapes. |
| A delivery-owned part is served twice. | The projection checks the delivery row first; the route refuses a delivery-owned part. |
| The existing history test encodes the old universal strip. | Update it in Phase A and keep the internal-reader strip test. |
| A multi-part message exceeds 48 MiB. | Document the history-too-large behavior; Q6 test. |

## 6. Review

Plan review round 1 (`momus`) - CHANGES REQUESTED. Findings folded:

| # | Severity | Finding | Disposition |
| --- | --- | --- | --- |
| 1 | BLOCKER | `parseInlineDataUrl` did not retain the base64 payload, so the decoder and HEAD sniff were unimplementable. | Folded: A1 returns `base64` and `decodeInlineDataUrl` takes an optional `maxBytes`. |
| 2 | BLOCKER | B2's "after the existing equality check" kept the early id drops and failed the envelope-only case. | Folded: B2 now specifies the exact new order and cites `events.ts:1821-1829`. |
| 3 | MAJOR | B4's "no-id part is dropped" contradicted design D5's "forwarded stripped". | Folded: live drops an unaddressable part (pre-existing); history uses the message envelope; B4 states it. |
| 4 | MAJOR | A4 misdescribed the `attachments-inline` fixture (an unknown PNG without `mime`, not a PDF). | Folded: A4 names the real fixtures and expected outcomes. |
| 5 | MAJOR | The D3 UI test target did not exist. | Folded: `test/ui/chat-message.test.ts` and `test/ui/chat-image-card.test.ts`. |
| 6 | MAJOR | "human principal via `principalFrom`" conflicted with the 403-for-agent acceptance. | Folded: C2 uses `principalFrom` + `kind === "human"` -> 403. |
| 7 | MINOR | Optional `deps.manager`, `safeName` order, other upstream 4xx, hardcoded wait. | Folded in C2 (`?.`, filename before sniff, any other status -> 502, `INLINE_READ_BUDGET_WAIT_MS`). |
| 8 | MINOR | Phase E omitted the two already-amended design docs. | Folded: E0 verifies them; no edit expected. |
| 9 | MINOR | A3 did not name `messageID`; "no `data:` anywhere" over-claimed vs R3. | Folded: A3 names the ids; the acceptance scopes top-level `url`/`attachment`. |

Focused re-review (`momus`, round 2): OKAY WITH FIXES, no remaining BLOCKER/MAJOR. Residuals folded:

- design D5's stale "after the existing equality check" bullet now matches the derive-first order;
- the overflow code is `messages_too_large` in both the design and the plan;
- B4 now scopes the no-id drop to the typed `partUpdated` path and documents the raw-envelope strip.

Implementation may proceed.
