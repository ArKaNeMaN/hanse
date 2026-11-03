# 0040 - Chat image display and agent-sent images

Stage: `0033-chat-image-display`
Design: [`docs/design/chat-image-display.md`](../design/chat-image-display.md) (revision 6, `oracle`
round 6 PASS)
Plan: [`docs/plans/0033-chat-image-display.md`](../plans/0033-chat-image-display.md) (`momus`
round 2 PASS)

## What shipped

### Phase A - large images and lightbox

- `AttachmentView` (server and client) gained optional `caption` and `origin`.
- `ChatAttachmentCard` renders images as a full-width, single-column preview with an
  `Open image: <name>` button, caption, `data-origin`, and an `<img @error>` placeholder fallback.
- The message attachment strip is now a single column.
- New `ChatImageLightbox.vue` uses the native `<dialog>`/`showModal()` primitive with Escape,
  cancel, backdrop click, close button, download, and focus return.
- `ChatMessage`/`ChatThread`/`ChatPage` forward an `open-image` event; `ChatPage` owns one
  lightbox instance.

### Phase B - `show_image` MCP tool and durable agent media

- Migration v21 adds `agent_media` with staged/attached/missing states, staged-null and
  attached/missing-non-null association CHECKs, quota/session indexes, and a unique
  message/part binding.
- `src/agent-media/` adds the service, safe path/storage helpers, DB store, admission limiter,
  active-copy set, envelope parser/synthetic projection, and reconcile pass.
- The non-master `hanse` MCP surface exposes `show_image`; it is omitted when `agentsHome` or the
  manager is unavailable. The tool stores a metadata-only result; image bytes never enter the model
  context.
- Live and history projection attach the stored image to the assistant message as a synthetic
  `file` part after the tool part. The synthetic part is idempotent and carries no base64 or host
  path. Nested tool-attachment `data:` URLs are stripped; the `show_image` input path is redacted.
- `GET|HEAD /api/apps/:app/agent-media/:id` serves attached images to a human principal with
  `O_NOFOLLOW`, parent containment, size verification, `nosniff`, and a bounded stream.
- Session deletion removes agent media rows/files from `removeLocalSessionRows`,
  pending-recovery, `#sweepOne`, and `#sweepNoticeOrphan`; the daily/startup reconcile repairs
  broken reservations, skips active copies, marks missing attachments, and removes old orphans.
- Agent media counts against the existing 5 GiB attachment quota; uploads and `show_image` reserve
  under the same per-app `appQuotaLocks`.
- `ToolPart` renders `show_image` as a compact action card rather than raw JSON.

## Decisions and rationale

- Explicit model intent (`show_image`) rather than mirroring every tool attachment; the owner
  rejected automatic ingestion as noise.
- Store first, return metadata: avoids provider image-input dependence and keeps large base64 out
  of the model context.
- Staged rows are durable without a time TTL; the quota bounds accumulation and history attaches
  them when the operator opens the session.
- Images are stored under `<appRoot>/agent-media` in the app-writable agents bind. This is accepted
  with the residual self-tamper/directory-swap risk; the coordinator verifies size and uses
  `O_NOFOLLOW`, `O_EXCL`, and pre-rename revalidation.
- The lightbox is fit-to-screen only; no zoom/pan. Markdown images remain unsupported.
- The deprecated legacy session SSE route strips nested tool-attachment data URLs but does not emit
  agent-media synthetic parts; the SPA uses the typed app stream.

## Verification

- `npm run lint` - pass.
- `npm run typecheck` - pass.
- `npm run typecheck:ui` - pass.
- `npm test` - 3 319 tests pass; one pre-existing `test/ui/retired-routes.test.ts` suite still fails
  with `createHash is not a function` on clean `HEAD` (jsdom externalizes `node:crypto`). This is
  unrelated to the stage.
- `npm run build` - pass.
- `npm run check:ui` - pass (ChatPage chunk ~69.6 kB gzip).
- `npm run check:sensitive` - pass.
- `npm run test:e2e` - 216 passed, 3 skipped (full Chromium suite, including the
  inline-image/lightbox scenario).
- New tests: `test/agent-media.test.ts`, `test/agent-media-mcp.test.ts`,
  `test/agent-media-projection.test.ts`, `test/agent-media-http.test.ts`,
  `test/agent-media-cleanup.test.ts`, `test/ui/chat-image-card.test.ts`,
  `test/ui/chat-lightbox.test.ts`, plus the `show_image` tool-card test and the updated e2e
  scenario.

## Deviations from the plan

- The plan named a new `docs/design/chat-images-qa.mjs`. The implementation instead extended the
  real-browser `e2e/spa-chat.spec.ts` inline-image scenario (large card, open, lightbox, Escape),
  because that suite already runs the SPA against the deterministic fixture server and is part of
  the mandatory `npm run test:e2e` gate. A separate standalone QA script would duplicate the same
  assertions without new coverage.
- The E2E seed does not create an `agent_media` row; agent media is covered by
  `test/agent-media-mcp.test.ts`, `test/agent-media-projection.test.ts`,
  `test/agent-media-http.test.ts`, and `test/agent-media-cleanup.test.ts`. A live-agent screenshot
  smoke remains a deployment-host follow-up.

## Residual risks

- The app can tamper with its own published media; the download verifies size, not a hash.
- A destination directory swap after the final pre-rename check remains a residual TOCTOU risk.
- A 20 MiB compressed image can decode to a large browser bitmap; no pixel-dimension check.
- Hard links inside allowed roots are not detected.
- A live attach can race a session delete; the row is bounded by quota and removed on app deletion.
- Staged rows with no attached message consume quota until an explicit future prune.
- The master agent's MCP surface is out of scope; its chat uses the same UI but cannot call
  `show_image` yet.
- Browser QA on the deployment host and a final operator visual check remain follow-ups.

## Deployment

Migration v21 is a one-way door. Back up `state` before upgrade; rollback requires restoring the
pre-upgrade database backup together with the matching `agents` state and the old image. See
[`docs/deployment.md`](../deployment.md).
