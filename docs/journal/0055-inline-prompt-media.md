# 0055 - Inline prompt media pass-through

> Stage 0046. Design: [`docs/design/inline-prompt-media.md`](../design/inline-prompt-media.md).
> Plan: [`docs/plans/0046-inline-prompt-media.md`](../plans/0046-inline-prompt-media.md).
> Owner approved option 1 (honest fallback) plus option 2b (on-demand serving) and authorized the
> commit on 2026-11-12.

## Context

Opening a `look_at` subagent session showed its initial prompt image as a collapsed `file <name>`
card with `No output`. The bytes were not missing: `opencode` persists the image as a base64
`data:` URL inside the user message part, and Hanse deliberately blanks every unknown `data:` URL
before it reaches the browser. The client had no attachment view, so it fell through to the generic
file-detail body.

## What changed

- **Shared module** (`src/attachments/inline-media.ts`): strict base64 image data-URL parser and
  decoder, the same-origin route builder, the `inlineImagePart` rewrite (sanitized filename,
  estimated size, `attachment` metadata), and the 10 s budget wait constant.
- **Projection** (`src/attachments/projection.ts`, `src/opencode/events.ts`,
  `src/http/chat.ts`): history takes an explicit session id; a qualifying unknown image part is
  rewritten to the inline route instead of being blanked; the live resolver takes optional
  session/message ids, derives envelope ids in `partUpdated`, passes them in `projectRawEnvelope`,
  and no longer caches file-part projections. `file:` URLs are stripped with `data:` URLs; HTTP(S)
  URLs keep the pre-existing behavior. Delivery-owned parts still use the attachment route.
- **Route** (`src/http/inline-media.ts`, `src/http/server.ts`): human-only
  `GET|HEAD /api/apps/:app/sessions/:session/messages/:message/parts/:part/inline?project=<id>`.
  It resolves the app, refuses a deleting app/project (`409`), uses `endpointFor` and never
  `ensure`, refuses a delivery-owned part, holds a 192 MiB `historyReadBudget` reservation through
  read/parse/decode/write, reads one message with the 48 MiB cap and 30 s timeout, validates the
  part against the path, estimates the decoded size before allocating, sniffs the bytes, and serves
  only PNG/JPEG/GIF/WebP with `nosniff`, `content-disposition: inline`, and
  `private, max-age=3600`. Overflow maps to `413`, a non-image payload to `415`, upstream
  failure/transport to `502`, a stopped app to `503 agent_stopped`, and a budget timeout to
  `503 inline_busy` with `Retry-After`.
- **Bounded read** (`src/opencode/client.ts`): `OpencodeRequestOptions.overflowCode` is attached to
  a capped-read overflow; `getMessage` forwards it. Existing callers are unchanged.
- **Client** (`ui/components/chat/ChatMessage.vue`, `ChatAttachmentCard.vue`): a `file` part without
  an attachment view returns `Inline content is not available.` when `truncated` is set and
  `No preview` otherwise; a failed `<img>` removes the Download link and shows `Unavailable`.
- **Docs**: this record, `docs/current-state.md`, the design amendment to
  `attachments-and-drafts.md` D5/M-E and `chat-image-display.md` R2/R10, and the indexes.

## Decisions and trade-offs

- **Image-only v1.** Non-image prompt files (PDF, video, arbitrary binary) keep the honest fallback.
  This avoids turning an agent-controlled `data:` payload into a generic download surface.
- **No store copy.** Bytes are served from the persisted opencode part; no `app_attachments` /
  `agent_media` row, no quota, no sweep. A fresh URL `404`s after the session is deleted; a browser
  cache may outlive deletion until `max-age` expires.
- **Read-only route.** `endpointFor` only, never `ensure`; an `<img>` request cannot undo idle
  auto-stop. A stopped app returns `503 agent_stopped`.
- **Memory accounting.** The route holds the full history-slice reservation through the decode, so
  the decode peak is inside the accounted budget. An inline read can make a concurrent history page
  read wait up to its 2 s budget; this rare lazy-load/hydration overlap is accepted for v1, and a
  dedicated inline budget is a follow-up.
- **No client retry.** A `503 inline_busy` or `415` leaves the card in `Image unavailable`; a reload
  retries. The browser cache covers normal repeat views.
- **Parity.** History and live use one helper and the same URL. A part with no addressable ids is
  dropped by the typed `partUpdated` path (pre-existing); the raw envelope forwards it stripped.

## Verification

- `npm run lint`: the 23 changed files are clean. The repository-wide run reports 55 errors, all in
  the untracked, unrelated `docs/design/settings-redesign/` HTML files; no stage file is affected.
- `npm run typecheck`: clean.
- `npm run typecheck:ui`: clean.
- `npm test`: 4,070 passed, 1 skipped (272 files).
- `npm run build`: clean.
- `npm run check:sensitive`: passed.
- `npm run test:e2e`: 137 passed, 1 skipped.

Targeted coverage: 17 parser/decoder/helper tests, 14 HTTP route tests, live/history projection and
id-fallback tests, `getMessage` overflow-code tests, and the client fallback/failed-card tests.

## Deviations and gaps

- The route's real 30 s upstream timeout is not waited for in an HTTP test. A destroyed upstream
  socket exercises the status-0 -> `502` branch; `test/client.test.ts` separately proves a real
  timeout keeps `code` undefined.
- The budget-busy case is a focused direct-handler test with fake timers (acquire the full 192 MiB
  reservation, advance `INLINE_READ_BUDGET_WAIT_MS`); it releases the reservation in `finally`.
- 405 responses in `src/http/server.ts` also carry `cache-control: no-store`.
- Deferred: a dedicated inline read budget, a client retry for `503`, non-image prompt files, and a
  decoded-byte cache.

## Next steps

None required. The deployed coordinator picks the change up with the next image; the UI build is
part of the same image.
