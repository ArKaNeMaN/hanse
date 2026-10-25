# 0031 - Chat drafts, eager sessions, attachments, and inline media

- Date: 2026-10-25
- Status: Stages A, B, and C implemented and verified (2026-10-25).
- Design: `docs/design/attachments-and-drafts.md` (revision 17, design review PASS round 16)
- Plan: `docs/plans/0026-attachments-and-drafts.md` (plan review PASS, `momus` round 3)

## Stage A - drafts, eager sessions, text-only pending recovery

- Migration v15 adds `message_drafts`, `session_state`, and `pending_sends`.
- A session is created on the first non-empty, non-slash input (400 ms), without dispatching a
  prompt; drafts are LWW and survive reload. Clearing the last draft auto-deletes an empty
  Hanse-created session after a fail-closed empty check; sessions with history are kept. A daily
  sweep removes 7-day idle empty sessions without starting a stopped app.
- Every send creates a durable pending row before dispatch and deletes the draft in one locked
  transaction. Confirmation is event-first with a bounded 0/2/5/10/20/30 s read fallback; the client
  shows Sending/Failed/Unknown banners and polls while unresolved because the server schedule can
  resolve without an SSE event.
- `touch` protects an unflushed draft; a reachable pre-existing upstream session is upserted with
  `has_messages=1`, while an existing Hanse-created `has_messages=0` row is preserved.

## Stage B - file-only attachments

- Migration v16 adds `app_attachments` and `attachment_deliveries`.
- Raw streamed uploads (100 MiB/file, 25 MiB image, 5 GiB/app, 2 concurrent, 256 MiB global) are
  name/MIME sanitized and committed under the per-app agents root; downloads use `O_NOFOLLOW`,
  parent containment, and size verification. Deletion, app cascade, startup reconcile, orphan sweep,
  and daily maintenance are wired.
- Sends carry `{text?, attachments:[{id,mode?}]}`, create deliveries in the pending transaction, and
  add a hidden synthetic manifest with model-visible paths. Stage B is file-only: no file parts and
  no base64; history carries `info.hanse.attachments`. Attachment-first sessions use the neutral
  `Attachment` title; a default pre-existing title is PATCHed before dispatch or the send is
  `409 title_required`.
- The client has attach/drop/paste chips, progress/retry/remove, file-only cards, image thumbnails,
  and draft/rail integration. Attachment-only sending works through both Enter and the Send button
  (the composer no longer uses native `required`). Stage C adds the inline modes and live cards.
- Runner mode adds a nested read-only attachments bind (spec-hash marker) and the policy/manager use
  one model-visible root; supervisor mode is documented as weaker.

## Stage C - inline media and projection

- At send time the effective model catalogue gates image/video/PDF inline delivery on
  `capabilities.input.*` + `capabilities.attachment`; unknown/unsupported/oversize modes fall back
  to file with warnings, and a non-blocking context advisory is emitted. Inline has a 20 MiB/file
  and 40 MiB base64 budget, max four inline attachments, unique per-delivery `prt_att_*` ids, and
  `file://` model-visible URLs; no base64 is sent in the JSON.
- Known history/SSE file parts are projected to short download URLs, unknown `data:` URLs are
  stripped before bounding, and `info.hanse.attachments` carries all deliveries. The read path uses
  48 MiB caps, a 192 MiB heap-aware budget, an 8 MiB projected response, single-message fallback,
  and `503 history_busy`.
- The app SSE frame cap is 32 MiB with a 32 MiB raw/96 MiB heap budget and 8 browser streams per
  app; internal monitor/fallback streams are separate; the legacy session SSE is human-only and
  projected. The blocking route returns the assistant `messageID` + generated `userMessageID` and
  projected parts (safe truncated shape on overflow). The bundled IDE extension uses async sends,
  a 30-message tail, attachment merge, hidden manifest, file-only cards, and bounded post-202 reads.
- Client: Auto / Send to model / File only modes for image/video/PDF, warnings/downgrades, live
  inline cards, "Send again as file", stream warning/omitted hydration, and the 8-stream limit
  recovery. The inline flag is derived from the delivery `part_id`; inline cards are not duplicated
  in the file-only strip.

## Verification

- `npm run lint`, `npm run typecheck`, `npm run build`, `npm run check:sensitive` - green.
- `npm test` - 126 files / 2198 tests pass (with the agent-environment git variables unset; the
  unrelated git-service test is environment-sensitive).
- Stage A browser QA - 5/5 scenarios; stale-banner poll verified (5 s transition, reload matches).
- Stage B deterministic browser QA - 7 scenarios / 88 assertions / 19 screenshots.
- Stage C deterministic browser QA - 12 scenarios / 134 assertions / 24 screenshots, including
  inline delivery, downgrade, redelivery, stream recovery, and 8-stream limit; zero unexpected
  console/page errors. Evidence: `docs/design/artifacts/attachments/`.
- Independent Stage B security review - APPROVED WITH FINDINGS; the symlink sweep/download/root
  creation, retry missing-file, header fallback, and Unicode line-separator findings were fixed with
  tests. Accepted/pre-existing: sanitized app-key collision (`:` vs `-`), non-human send route
  defence-in-depth, and pre-body rejection draining. Known supervisor-mode immutability and
  app-key-collision limits are recorded in `docs/current-state.md`.
- Live model smoke (vision/PDF/CSV against a real capable model) and real-device QA were not run
  here: no isolated managed model/device was available. The deterministic browser harness and the
  server tests cover the capability gate, inline budget, projection, stream budgets, and UI; the
  live model smoke remains a deployment-stage verification item.
