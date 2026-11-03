# Plan 0033 - Chat image display and agent-sent images

Status: **implemented** - design approved (`oracle` round 6 PASS); plan review PASS (`momus`
round 2); Phase A and Phase B implemented and verified (journal 0040). The stage commit follows the
process policy after the remaining gates.

## Bindings

- Stage: `0033-chat-image-display`
- Design: `docs/design/chat-image-display.md` (revision 6; `oracle` round 6 PASS)
- Design reviewer: `oracle`
- Plan reviewer: `momus`
- Open questions: `docs/open-questions.md` - stage `0033-chat-image-display` (resolved; no open
  items)
- Journal: `docs/journal/0040-chat-image-display.md` (new)
- Design index: `docs/design/README.md`
- Plan index: `docs/plans/README.md`
- Journal index: `docs/journal/README.md`
- Language: English (docs and code comments)
- Verification: `npm run lint`, `npm run typecheck`, `npm run typecheck:ui`, `npm test`,
  `npm run build`, `npm run check:ui`, `npm run check:sensitive`, `npm run test:e2e`
- Commit policy: one coherent stage commit (code + tests + docs + record) after all gates pass;
  autonomous mode permits the commit and push to `origin`.

## 1. Goal

Ship two independently verifiable phases:

- **Phase A (UI):** every chat image (operator attachments today, agent media after Phase B)
  renders large in a single column and opens in a native-dialog lightbox.
- **Phase B (agent media):** an app agent can call the new `show_image` MCP tool to publish one
  image from its app workspace/temp/attachments roots. Hanse stores it durably, attaches it to the
  assistant message in live and history, and serves it through a human-only download route.

Non-goals: automatic mirroring of every tool attachment; image generation/editing; video/PDF
preview; Markdown `![...]()` rendering; zoom/pan; master-agent support; a settings toggle; changes
to the model context beyond the explicit tool call.

## 2. Decisions carried from the design

1. `show_image` is the only agent image channel; the model decides.
2. Single-column, full-feed-width images; native `<dialog>` lightbox; fit-to-screen; no zoom.
3. 20 MiB per image; shared 5 GiB per-app quota; reserve a `staged` row after open/fstat/sniff and
   before the full copy; 2 concurrent copies per app; 64 MiB of in-flight bytes globally.
4. Staged media never expires by time; it is durable until attached, until the app is deleted, or
   until an explicit future maintenance action. Staged rows have no session association.
5. Caption is 1..200 characters raw, sanitized to one line; reject empty or over-200 after
   sanitization, never truncate.
6. Allowed paths: app directory, `<appRoot>/tmp`, `<appRoot>/attachments`; a literal `$TMPDIR/`
   prefix expands to `<appRoot>/tmp`; container `/tmp` and tool attachments are not paths;
   credential roots are excluded.
7. Nested tool-attachment `data:` URLs are stripped from live and history payloads in this stage.
8. `agent_media` lives in `<appRoot>/agent-media` inside the app-writable agents bind; the
   self-tamper risk is accepted and recorded.
9. The master agent is out of scope; `handleMasterRpc` is unchanged.

## 3. Invariants

- No `data:` URL from a tool attachment reaches the browser through the typed app stream, legacy
  stream, or history response.
- The synthetic image part contains only a same-origin download URL and metadata; no host path, no
  base64, no model-supplied URL.
- `agent_media.attach` is idempotent; a media row is bound to exactly one `(session_id, message_id,
  part_id)`.
- A media file is immutable after publication in the application sense: the coordinator never
  rewrites it; the download verifies its recorded size. The app-writable location is an accepted
  residual risk (design D8).
- Quota is reserved before a byte is copied and released by `missing`/deleted rows.
- The chat transcript remains upstream-owned; Hanse adds only `agent_media` and synthetic parts.
- Phase A must not depend on Phase B; Phase B's UI depends on Phase A.

## 4. Contracts

### 4.1 MCP tool `show_image`

Exposed by the `hanse` server to non-master app tokens; opencode presents it as
`hanse_show_image`. Use the approved model-facing description verbatim:

> Show one image to the operator in this chat. Use only when the operator should see an image; do
> not call it for routine reading or analysis. The path must be a real file inside the application
> workspace or its runtime temp/attachments roots. Save screenshots there first; a tool attachment
> or a container /tmp path is not readable. A literal leading $TMPDIR/ is expanded to the app
> runtime temp directory; no other shell expansion is performed. Supports PNG, JPEG, GIF, and WebP
> up to 20 MiB. Returns a media id; the operator sees the image, not you.

Input:

```json
{
  "path": "screenshots/ui.png",
  "caption": "Settings after the save"
}
```

- `path`: string, 1..2048 bytes, no NUL. Relative to `appDir`; `$TMPDIR/` prefix expands to
  `<appRoot>/tmp`; absolute model-visible paths are mapped per D3.
- `caption`: optional string, 1..200 characters raw, sanitized to one line (strip C0/DEL/line
  separators, trim, collapse internal whitespace to single spaces); empty or over-200 after
  sanitization is `invalid_caption`.
- Success result (text content JSON):
  `{ok:true,id,name,mime,size}`; never image bytes, never a host path.
- Failure result: `{ok:false,code,message}`. Codes: `image_unavailable`, `invalid_path`,
  `invalid_caption`, `path_outside_app`, `image_unreadable`, `image_unsupported`,
  `image_empty_file`, `image_too_large`, `image_size_mismatch`, `image_quota_exceeded`,
  `image_busy`, `image_storage_error`.
- When `agentsHome` or `manager` is missing, the tool is omitted from `tools/list`; a direct call
  still returns `image_unavailable` (no `pathMode` can be derived without the manager).

### 4.2 MCP dispatcher

`src/mcp/ssh-protocol.ts`:

- Add a single `SHOW_IMAGE_TOOL` record to the `tools/list` merge.
- In `tools/call`, handle `show_image` before the `!name.startsWith("ssh_")` fallback (the
  fallback currently sends unknown names to `handleRpc`).
- `AppSkillRpcOptions`/`handleRpcAsync` gains `agentsHome`, `getProjects`, and `workspaceRoot`; the
  handler constructs `AgentMediaService` from those options. Keep the master path unchanged.
- `src/http/internal-mcp.ts` passes the new options from `HttpDeps`.
- The tool resolves the app with `findApp(deps, agent.projectId, agent.appKey)` and
  `appDir(found.project, found.app)`; it never accepts an app id from arguments.

### 4.3 Database (migration v21)

Add exactly:

```sql
CREATE TABLE agent_media (
  id TEXT PRIMARY KEY,
  app_id TEXT NOT NULL REFERENCES apps(id) ON DELETE CASCADE,
  session_id TEXT,
  message_id TEXT,
  part_id TEXT,
  original_name TEXT NOT NULL,
  stored_name TEXT NOT NULL,
  rel_path TEXT NOT NULL,
  mime TEXT NOT NULL,
  size INTEGER NOT NULL CHECK (size >= 0),
  caption TEXT,
  state TEXT NOT NULL CHECK (state IN ('staged', 'attached', 'missing')),
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL,
  CHECK (length(id) BETWEEN 1 AND 64),
  CHECK (length(original_name) > 0),
  CHECK (length(mime) > 0),
  CHECK (caption IS NULL OR length(caption) <= 200),
  CHECK (
    state <> 'staged'
    OR (session_id IS NULL AND message_id IS NULL AND part_id IS NULL)
  ),
  CHECK (
    state NOT IN ('attached', 'missing')
    OR (session_id IS NOT NULL AND message_id IS NOT NULL AND part_id IS NOT NULL)
  ),
  UNIQUE (app_id, rel_path)
);
CREATE INDEX agent_media_app_state ON agent_media(app_id, state, created_at);
CREATE INDEX agent_media_app_session ON agent_media(app_id, session_id);
CREATE UNIQUE INDEX agent_media_message_part
  ON agent_media(app_id, message_id, part_id)
  WHERE message_id IS NOT NULL AND part_id IS NOT NULL;
```

- `part_id` is the opencode **tool part id**, not the synthetic `prt_amed_*` id.
- No changes to existing tables.
- Fresh DB and v20 -> v21 upgrade tests.

### 4.4 Source module layout

New `src/agent-media/`:

- `types.ts` - constants (`MAX_AGENT_IMAGE_BYTES = 20 MiB`,
  `MAX_CONCURRENT_AGENT_IMAGES_PER_APP = 2`, `MAX_GLOBAL_INFLIGHT_AGENT_IMAGE_BYTES = 64 MiB`,
  `MAX_AGENT_IMAGE_CAPTION = 200`, `MAX_AGENT_IMAGE_PATH = 2048`), `AgentMediaRow`, error codes,
  `AgentMediaTarget` (`appId`, `projectId`, `appKey`, `appDir`, `appRoot`,
  `project.workspaceRoot`, `pathMode: "runner" | "supervisor"`). Use the existing `AttachmentView`
  from `src/attachments/types.ts` as the one view shape; do not add a second `AgentMediaView`.
  Derive `pathMode` from `manager.attachmentsPathMode()` (`"host"` -> runner, `"container"` ->
  supervisor) and document the mapping.
- `paths.ts` - `agentMediaRoot(appRoot)`, `agentMediaTempPath`, `agentMediaFinalPath`,
  `agentMediaRelPath`, `ensureAgentMediaRoot`, `ensureAgentMediaTempDir`, `openAgentMediaFile`
  (O_NOFOLLOW, parent realpath, size check), `openAgentMediaSource(sourcePath)` returning
  `{fd, size}` after one lstat + O_NOFOLLOW open + fstat with matching `dev`/`ino`/`size`.
- `store.ts` - `insertStaged`, `attach`, `readAgentMedia`, `readSessionAgentMedia`, `markMissing`,
  `deleteAgentMediaRow`, `deleteSessionAgentMedia`, `listStagedAgentMedia`, `listAgentMediaRoots`.
- `service.ts` - `AgentMediaService` with `showImage({path,caption})`,
  `attach(appId, id, sessionId, messageId, partId)`, `view(row)`; `view` builds
  `/api/apps/<encoded appKey>/agent-media/<encoded id>?project=<encoded projectId>` (never the
  attachment URL).
- `reconcile.ts` - `reconcileAgentMedia({db, agentsHome, startup, activeIds, now})`; it no-ops
  when `agentsHome` is undefined. Cleanup is the shared `deleteSessionAgentMedia` from `store.ts`
  (no duplicate `cleanupSessionAgentMedia`). The daily maintenance calls `reconcileAgentMedia`.
- `active.ts` - the process-local active-copy id set **and** the `AgentMediaAdmission` limiter
  (2 per app, 64 MiB global), exported and passed to `reconcileAgentMedia`/`runAttachmentMaintenance`
  without overloading `activeUploadIds`.
- `projection.ts` - `parseShowImageEnvelope` (bounded recursion, max depth 4),
  `isShowImageTool`, `syntheticFilePart`, recursive `stripNestedToolDataUrls`,
  `redactShowImagePath`.
- `index.ts` - exports.

Use existing helpers:
- `appStateRoot` (`src/attachments/paths.ts`) and `sanitizeAppKey` (`src/opencode/instance.ts`)
- `resolveWithinRoot`, `isInside` (`src/runtime/app-path.ts`)
- `sniffMime`, `isInlineSafeMime` (`src/attachments/mime.ts`)
- `safeOriginalName`, `storedNameFor`, `encodeContentDisposition` (`src/attachments/names.ts`)
- `fsyncPath`, `fsyncDirectory`, `moveIntoPlace` (`src/attachments/storage.ts`); use these exact
  helpers, not a copy.

### 4.5 Path resolver

`resolveSource(target, inputPath)`:

1. Reject empty/`\0`/`..` segment.
2. If `inputPath` starts with `$TMPDIR/`, replace with `<appRoot>/tmp/`.
3. If relative, `path.resolve(appDir, inputPath)`.
4. If absolute and starts with `/data/workspace/`, map to
   `path.join(project.workspaceRoot, rest)` and require the result to stay inside `appDir`
   (`isInside`/`resolveWithinRoot`); reject otherwise.
5. If absolute and starts with `/data/agents/<sanitizedProject>/<sanitizedApp>/`, map to
   `path.join(appRoot, rest)` and require the result to stay inside `<appRoot>/tmp` or
   `<appRoot>/attachments`; reject `home`/`config`/`data`/`state`/`cache`/`mise` even if they are
   under `appRoot`.
6. In `pathMode === "supervisor"`, accept an absolute path only when it is already inside one of
   the allowed host roots. In `pathMode === "runner"`, reject host-absolute paths that are not one
   of the model-visible prefixes in steps 4-5.
7. Allowed roots: `appDir`, `<appRoot>/tmp`, `<appRoot>/attachments`.
8. `resolveWithinRoot({target, root, label})` for the selected root. Then one sequence:
   `lstat` the resolved target -> `open(O_NOFOLLOW)` -> `fstat` and require a regular file with the
   same `dev`/`ino`/`size` as the `lstat` result (a regular-file swap is rejected) -> read 512
   bytes **positionally** (`readSync(fd, buf, 0, 512, 0)`/`pread`) on **that same fd**, so the
   offset stays at 0 -> `sniffMime` -> require size 1..20 MiB and `kind === "image"` and
   `isInlineSafeMime(mime)`. Do not open the file twice.
9. Return `{fd, size, mime, sourcePath, displayName}`; `sourcePath` is the resolved source path,
   `displayName` is `safeOriginalName(path.basename(sourcePath))` (reject empty). The caller owns
   the fd, copies with an explicit `start: 0`, and closes it in `finally` (`autoClose: false`).

`agentsHome` undefined -> `image_unavailable`. Map `ConfigError`/`PATH_OUTSIDE_ROOT` to a fixed
`path_outside_app` message (do not forward `src/runtime/app-path.ts`'s resolved candidate text), and
never include a resolved host path in any failure message; assert this in
`test/agent-media-mcp.test.ts`.

### 4.6 Show-image transaction

1. Resolve/open/`fstat`/sniff the source (above), keeping the verified fd open and the
   `{fd, size, mime, sourcePath, displayName}` result. Define `reservedSize = source.size`.
2. `id = "amed_" + randomBytes(16).toString("base64url")`.
3. Use `displayName` (already `safeOriginalName(path.basename(sourcePath))`); reject empty.
4. `storedName = storedNameFor(id, displayName)`, `relPath = agentMediaRelPath(storedName)`,
   `tempPath = agentMediaTempPath(appRoot, id)`, `finalPath = agentMediaFinalPath(appRoot, storedName)`.
5. Run `ensureAgentMediaRoot(appRoot)` and `ensureAgentMediaTempDir(appRoot)`: `lstat` each existing
   entry, reject a symlink or non-directory, create with mode `0700`, and verify realpath
   containment. This is done before the reservation so a planted symlink fails early.
6. Under the **shared per-app upload/quota lock** (extracted from `src/http/chat.ts`):
   - check the process-local in-flight limiter (2 per app, 64 MiB global) and reserve bytes;
   - recompute `reservedAttachmentBytes(db, appId)` (now includes `agent_media`);
   - reject with `image_quota_exceeded` if `used + reservedSize > ATTACHMENT_QUOTA_BYTES`;
   - insert `agent_media` `state='staged'`, `size=reservedSize`, sniffed `mime`, names, `rel_path`,
     `caption`;
   - release the lock **before** the copy.
7. Add the id to the process-local active-copy set. Copy from the verified fd with an explicit
   `start: 0` (`createReadStream("", {fd, start: 0, autoClose: false})`, the existing
   download-route pattern, or a positional read loop) to `tempPath` opened with
   `O_NOFOLLOW|O_CREAT|O_EXCL|O_WRONLY`, bounded to `reservedSize` and
   `MAX_AGENT_IMAGE_BYTES`; `fsyncPath`; immediately re-validate `agent-media`/`.tmp` with
   `lstat`/`realpath`, then rename (dirfd-relative where available) to `finalPath`;
   `fsyncDirectory`.
8. Define `finalStat = lstatSync(finalPath)`; require a regular non-symlink with
   `finalStat.size === reservedSize`; never update `size`. A mismatch deletes the row/temp/final
   and returns `image_size_mismatch`. Bump `updated_at` and remove the id from the active set;
   release the in-flight reservation in `finally`.
9. On any failure: delete the row/temp/final best-effort and return the mapped code.
10. Return `{ok:true,id,name:displayName,mime,size:reservedSize}`.

The copy must not reopen by path. Use `createReadStream("", {fd, start: 0, autoClose: false})` to a
write stream or a positional read loop into `writeSync`; `copyFile` is forbidden. The quota lock is
not held across the copy, so two copies can overlap.

### 4.7 Association and synthetic part

`parseShowImageEnvelope(value)`:

- `string` -> trim, `JSON.parse`; if the result is a string, parse once more.
- `object` -> if it has `ok`/`id`, use it; if it has `content` array, join/scan text entries and
  parse their JSON; if it has `text`/`output`, parse those.
- Return `{ok:true,id}` only for `ok === true` and `id` matching `/^amed_[A-Za-z0-9_-]{10,64}$/`.
- Return `undefined` for `ok:false`, invalid JSON, missing id, or an array.

`isShowImageTool(tool)`:

- Add a **server-local** `normalizeToolName` in `src/agent-media/projection.ts` that strips a
  leading `hanse_`; compare the result to `show_image`. Do not import the browser asset
  `assets/chat-core.js` into server code.

`attach` (DB transaction) returns:

```ts
type AttachResult =
  | { status: "attached"; view: AttachmentView }
  | { status: "missing"; view: AttachmentView }
  | { status: "conflict" }
  | { status: "unknown" };
```

- Read by `(app_id, id)`; no row -> `unknown`.
- A **bound** row whose non-null association differs -> `{status:"conflict"}` and a bounded
  warning; check this before the missing case.
- `state === "missing"`: require an identical association (the schema enforces non-null, but add a
  defensive check); a missing row with any null association -> `unknown`, never a missing view.
  Otherwise -> `{status:"missing", view}`; do not bind or re-stat the file.
- All association fields null -> set them and `state='attached'` -> `{status:"attached", view}`.
- Already identical -> `{status:"attached", view}`.
- The view always includes `origin:"agent"` and, when present, `caption`; `state` is `"sent"` for
  attached and `"missing"` for a missing file.

Live emission in `EventProjector.partUpdated`:

1. Only when `state.status === "completed"`, parse `state.output` and call
   `attach(appId, mediaId, sessionID, messageID, toolPartID)` **before** `shouldForwardSnapshot`
   can suppress the event.
2. Redact `show_image` `state.input.path` and any echoed path in `state.title`/metadata; copy no
   path into output; strip nested tool-attachment `data:` URLs, replacing each with `""` and
   setting `state.attachmentsTruncated = true`; build the normal bounded event.
3. If the attach result has a view (`attached` or `missing`), build the synthetic part with
   `partID = "prt_" + mediaId`, `partType:"file"`, `attachment.state = view.state`,
   `origin:"agent"`, `caption`, and an encoded URL. `conflict`/`unknown` produce no synthetic part.
4. Emit the normal event(s) plus the synthetic once per `(messageID, mediaId)` per projector;
   cap the seen set at 1 000 entries and drop the oldest. If the normal event is omitted, still emit
   the synthetic.

History emission in `createMessageProjector`:

1. For every part, call `stripNestedToolDataUrls(part)` and redact the `show_image`
   `state.input.path` plus any echoed path in `state.title`/metadata before the file loop.
2. Iterate with a new array: for each `show_image` completed tool part, parse and call
   `attach(appId, mediaId, part.sessionID, message.info.id, part.id)`, then append the synthetic
   part after it when the result has a view (`attached` or `missing`).
3. Deduplicate by the deterministic synthetic part id before inserting, so repeated projection of
   the same message cannot append two cards.
4. Keep the existing delivery projection and `info.hanse.attachments`.
5. `conflict`/`unknown` rows are skipped; `missing` views render the placeholder.

`AttachmentView` (server + client) gains optional `caption` and `origin`. `AgentMediaService.view`
builds the agent view itself (agent-media download URL, `state`, `origin:"agent"`, optional
`caption`); the existing `attachmentView` is for `AttachmentRow` and is not used to fabricate agent
data.

### 4.8 Download route

`GET|HEAD /api/apps/:app/agent-media/:id?project=<projectId>` in `src/http/server.ts` before the
generic body reader, handled by `handleAgentMediaDownload` in the new `src/http/agent-media.ts`.

- `principalFrom`; require human (cookie or bearer); agent tokens `403`.
- `findApp`; `appStateRoot(deps.agentsHome, ...)`; if `agentsHome` undefined -> `503`.
- `readAgentMedia(db, appId, id)`; require `state='attached'` and `rel_path` non-null; else `404`.
- `openAgentMediaFile`; `O_NOFOLLOW`, real parent inside `<appRoot>/agent-media`,
  `stat.size === row.size`; mismatch -> `markMissing` + `404`.
- Headers: `content-type`, `content-length`, `content-disposition: inline` via
  `encodeContentDisposition`, `x-content-type-options: nosniff`,
  `cache-control: private, max-age=3600`.
- `HEAD`: headers + `end()`, no body.
- `GET`: stream exactly `size` bytes with `{start: 0, end: size - 1}`. No Range.
- Cross-app: lookup includes `app_id`; `404`.
- The route is same-origin; `safeAttachmentUrl` accepts it.

### 4.9 Cleanup

`deleteSessionAgentMedia(db, appRoot, appId, sessionId)`:

- Select `id, rel_path` for the session; delete the rows in a transaction.
- Best-effort `rmSync` each final file and its deterministic temp.
- Call from:
  - `removeLocalSessionRows` (`src/http/chat.ts:548-552`); this covers the manual/session-tree
    delete and the four callers of that helper.
  - pending recovery (`src/chat/pending.ts:358-362`)
  - daily sweep `#sweepOne` (`src/chat/sweep.ts:243-246`, called by `#pass`)
  - `#sweepNoticeOrphan` (`src/chat/sweep.ts:191-194`, the "upstream session is gone" path)
- App deletion already removes `<appRoot>`; the FK cascade removes rows. Test both.
- `reconcileAgentMedia({db, agentsHome, startup, activeIds, now})` owns staged/missing/orphan
  reconciliation and no-ops when `agentsHome` is undefined. Call it **after the `agentsHome`
  guard but before the `startup` early return** in `runAttachmentMaintenance`, so startup/daily
  reconciliation is never skipped. `startup` runs only broken-reservation reconciliation (all
  reservations, no active set after a crash); the daily pass also runs the missing/orphan sweeps
  with the active-copy set and a 15-minute age floor.
- Staged reconcile: final file with matching size -> keep; final size mismatch -> remove row+file;
  temp-only -> remove row+temp; missing final -> remove row+temp.
- Daily: remove files under each `<appRoot>/agent-media` without a row older than 24 h; mark
  attached rows whose file is missing as `missing`; remove staged rows whose file is missing; never
  delete a valid staged row by age.
- Export the active-copy set from `src/agent-media/active.ts`. `runAttachmentMaintenance` unions
  `options.activeIds` with this set (or takes a second `agentActiveIds` option) and passes the
  result to `reconcileAgentMedia`; do not overload the upload set's ids.

### 4.10 Quota

- `availableAttachmentBytes` and `reservedAttachmentBytes` add
  `COALESCE(SUM(size),0) FROM agent_media WHERE app_id=? AND state <> 'missing'`.
- `quotaPercent` uses the updated `availableAttachmentBytes`.
- The upload path (`src/http/chat.ts:1543-1544`, `1601-1604`) must include the same total.
- Move the `appUploadLocks` instance from `src/http/chat.ts` to the existing `src/chat/locks.ts`
  as exported `appQuotaLocks`; use the **same** lock for uploads and `show_image`
  read/decide/insert. Release it before the upload stream or image copy.
- The `show_image` transaction reserves a staged row (after sniff, before the full copy) under that
  shared lock.
- Global in-flight byte budget is process-local and separate from uploads; it is released in
  `finally`.

## 5. Phase A - large images and lightbox (UI only)

Boundary: no server, no migration, no MCP, no download route. It must work with existing operator
attachments and the future agent part.

Steps:

1. `src/attachments/types.ts`: add optional `caption?: string`, `origin?: "agent"` to
   `AttachmentView`.
2. `assets/chat-core.d.ts` + `assets/chat-core.js`: add the same optional fields; extend
   `normalizeAttachment` and, in `attachmentViewFromFilePart`, explicitly pass
   `caption: metadata.caption` and `origin: metadata.origin` into `normalizeAttachment` (extending
   the normalizer alone does not forward them).
3. `ui/components/chat/ChatAttachmentCard.vue`:
   - add `defineEmits<{ open: [attachment: AttachmentView] }>()`;
   - image branch with `<button class="attachment-card__open" :aria-label="...">` wrapping `<img>`;
   - `inline-size:100%; block-size:auto; object-fit:contain; max-block-size:...`;
   - caption row; `data-origin`; `<img @error>` flips a local failed flag to the missing
     placeholder;
   - non-image branch unchanged.
4. `ui/components/chat/ChatMessage.vue`: add `open-image` emit; forward from both
   `ChatAttachmentCard` usages (inline file part and strip).
5. `ui/components/chat/ChatThread.vue`: add `open-image` emit; forward from `ChatMessage`.
6. `ui/pages/ChatPage.vue`: add `lightbox` ref, `openImage(attachment)`, render
   `<ChatImageLightbox>` once; pass `@open-image` to `ChatThread`.
7. New `ui/components/chat/ChatImageLightbox.vue`:
   - native `<dialog class="dialog lightbox">`;
   - watch `open` -> `showModal()`/`close()`;
   - `@cancel.prevent="emit('close')"`, `@close="emit('close')"`;
   - close button + download link;
   - backdrop click on the dialog element closes;
   - focus the close button on open; native focus return;
   - image `max-inline-size:100%; max-block-size:80dvh; object-fit:contain`.
8. `src/http/styles.css`:
   - `.attachment-card--image` single-column grid;
   - `.attachment-card__open` reset button, full-width preview;
   - `.attachment-card__image` sizing;
   - `.attachment-card__caption`;
   - `.message__attachments { grid-template-columns: 1fr; }`;
   - `.lightbox` overrides `.dialog` width, frame/padding, image sizing, mobile, reduced motion;
   - use existing tokens only.
9. Tests:
   - `test/ui/chat-attachments.test.ts` - image card large/button/caption/non-image unchanged;
   - new `test/ui/chat-lightbox.test.ts` - open/close/cancel/backdrop/download/aria; **do not
     assert focus return in jsdom** (the stub does not implement it); focus return is browser-QA
     only;
   - update `test/ui/chat-message.test.ts` for the open event.
10. Browser QA: a focused scenario in the new `docs/design/chat-images-qa.mjs` with operator
    images at 390/1440 dark/light, open/close, Escape, focus return, no console/page errors;
    screenshots under `docs/design/artifacts/chat-images/`.

Acceptance:

- Operator images render large in one column and open in the lightbox.
- Non-image attachments are unchanged.
- Escape/close/backdrop work; focus returns to the image button.
- `npm run lint`, `npm run typecheck`, `npm run typecheck:ui`, `npm test`, `npm run build`,
  `npm run check:ui`, `npm run check:sensitive`, and `npm run test:e2e` pass (the rendered chat
  route changes).
- Phase A is a phase of this stage; do not commit it separately. The stage commit follows the
  process policy (one coherent commit after both phases and all gates).

## 6. Phase B - `show_image` MCP tool and agent media

Boundary: no changes to the master MCP surface; no automatic tool-attachment mirroring; no
Markdown images.

**Gate:** do not start Phase B until Phase A's acceptance criteria and full gate set are green.
Phase B's UI depends on Phase A's large-image card and lightbox.

Steps:

1. Migration v21 and `src/agent-media/types.ts`, `paths.ts`, `store.ts`, `service.ts`,
   `reconcile.ts`, `active.ts`, `projection.ts`, `index.ts` (D2-D4). Update the existing
   `test/migrations.test.ts` expectations from 20 to 21 (all hard-coded occurrences).
2. `src/attachments/types.ts` optional fields only; do **not** add caption/origin pass-through to
   `src/attachments/views.ts` (agent views are built by `AgentMediaService.view`).
3. `src/attachments/quota.ts` include `agent_media`; upload path totals; move the
   `appUploadLocks` instance to `src/chat/locks.ts` as exported `appQuotaLocks`.
4. MCP wiring:
   - add `show_image` to the non-master tool list in `src/mcp/ssh-protocol.ts`;
   - dispatch it before the unknown/`ssh_` fallback;
   - add `agentsHome`/`getProjects`/`workspaceRoot` to `AppSkillRpcOptions` and construct the
     `AgentMediaService` in the handler (one factory, not a second option shape);
   - pass them from `src/http/internal-mcp.ts`;
   - omit the tool when `agentsHome` or `manager` is undefined; a direct call still returns
     `image_unavailable`.
5. Projection:
   - `isShowImageTool`, `parseShowImageEnvelope` (bounded recursion), `syntheticFilePart`,
     `stripNestedToolDataUrls`, `redactShowImagePath` in `src/agent-media/projection.ts`;
   - `EventProjectorOptions.agentMedia` + attach/synthetic logic in
     `src/opencode/events.ts`; attach before the snapshot gate; per-projector seen set with a
     1 000-entry cap; synthetic `attachment.state = view.state`;
   - `ProjectionTarget.agentMedia` + history logic in `src/attachments/projection.ts`; append
     `attached`/`missing` views, skip `conflict`/`unknown`, dedupe by synthetic part id;
   - wire `streamAppEvents` (`src/http/prompts.ts`) with agent media;
     `streamSessionEvents`/`createRawEventStream` (`src/http/chat.ts`, `src/opencode/events.ts`)
     gets nested-data-URL stripping only, no synthetic agent-media parts; wire
     `createMessageProjector` in history (`:1943`) and blocking send (`:1265`).
6. Download route + handler in `src/http/server.ts` and `src/http/agent-media.ts` (new; HEAD,
   bounded `{start:0,end:size-1}` stream, dedicated opener).
7. Cleanup: `deleteSessionAgentMedia` + call sites including `#sweepOne` and
   `#sweepNoticeOrphan`; active-copy set; `runAttachmentMaintenance` calls
   `reconcileAgentMedia({db,agentsHome,startup,activeIds,now})`; app deletion test.
8. UI:
   - `ToolPart.vue` `show_image` compact card (success/failure), no raw JSON; use the existing
     client `normalizeToolName` from `assets/chat-core.js` on the tool name;
   - the synthetic file part already renders through Phase A's card;
   - caption/origin display.
9. Tests:
   - `test/agent-media.test.ts`
   - `test/agent-media-mcp.test.ts`
   - `test/agent-media-projection.test.ts`
   - `test/agent-media-http.test.ts`
   - `test/agent-media-cleanup.test.ts`
   - `test/ui/chat-tools.test.ts` / `chat-message.test.ts` for the `show_image` card and synthetic
     part
   - `test/ui/chat-attachments.test.ts` for agent caption/origin
10. Browser QA/E2E: a deterministic assistant message with a synthetic `agent-media` part plus an
    operator image; lightbox; no console errors. Add the UI fixture to the new
    `docs/design/chat-images-qa.mjs`. For `test:e2e`, seed a real `agent_media` row and file in
    `e2e/support/seed.ts`/`e2e/support/server.ts` (otherwise the test only exercises the UI).
11. Docs:
    - `docs/current-state.md`: schema `[1..21]`, `show_image`, agent media, large images/lightbox;
    - `docs/design/README.md` status;
    - `docs/plans/README.md` entry;
    - `docs/journal/0040-chat-image-display.md` + index;
    - `docs/deployment.md`: v21 is forward-only; restore the pre-upgrade DB backup with the old
      image for rollback;
    - `docs/open-questions.md` stage 0033 already records decisions.

Acceptance:

- An agent `show_image` call publishes one image; it appears exactly once live and after reload.
- No other tool attachment appears; no nested base64 in live/history.
- A no-browser turn, delayed history read, and coordinator/app restart preserve the image.
- Path/symlink/size/MIME/quota failures are stable and leave no row/file; a final-component
  symlink swap never reads the target and the original verified fd is copied.
- Session deletion removes rows/files from every path, including `#sweepNoticeOrphan`; quota
  reflects it. Staged rows have no session association and are removed only by app deletion or a
  future maintenance action.
- `show_image` card is compact; the image card is large and opens in the lightbox.
- All verification commands pass.

## 7. Test matrix (detail)

Server:

- Migration v21 fresh/upgrade; `agent_media` CHECKs.
- Path resolver: relative, `$TMPDIR/`, `/data/workspace/...`, sanitized `/data/agents/...`,
  supervisor host paths, traversal, symlink, non-regular, missing `agentsHome`, app-key with
  spaces/unicode.
- Source admission: png/jpeg/gif/webp accepted; SVG/HTML/PDF/bmp rejected; 0 byte; 20 MiB boundary;
  20 MiB + 1; byte-identity for a file >512 bytes (positional sniff, copy starts at 0); size
  mismatch after copy; fd copy (no `copyFile`); regular-file swap between `lstat` and `open`
  rejected by the `dev`/`ino`/`size` comparison.
- Transaction: reservation after sniff and before full copy; shared upload-vs-show_image quota
  lock; two copies overlap; quota full; global 64 MiB; failure cleanup; attach
  (`attached`/`missing`/`conflict`/`unknown`); a missing row with a null association returns
  `unknown` (defensive-only test via a store stub or `PRAGMA ignore_check_constraints=ON`, because
  the CHECKs forbid it); staged reconcile; active-copy skip; final-size mismatch branch; pre-planted symlinks
  at `agent-media` and `.tmp`; swap `agent-media` to a symlink after admission and assert the
  rename target is not redirected.
- MCP: tool list presence/absence; success/failure envelopes; both tool names; no bytes; no host
  path in message; direct call when the store is unavailable.
- Projection: live attaches + synthetic (`attached` and `missing`); history inserts after the tool
  part; conflict/unknown skipped; no duplicate per projector; wrapped/double-encoded/invalid
  output; nested `state.attachments` base64 stripped in live/history; the full serialized
  `show_image` tool part contains no host path (input/title/metadata); legacy raw stream strips
  nested data URLs but emits no synthetic agent-media parts; deterministic part id.
- HTTP: 401/403; human cookie/bearer; cross-app 404; staged 404; missing 404 + mark; HEAD; headers;
  bounded stream; no Range.
- Cleanup: all session deletion paths including `#sweepOne` and `#sweepNoticeOrphan`; app cascade;
  staged durability; sweep-during-copy; startup-after-crash; orphan files; missing files; quota
  release.

UI:

- Image card: large button, alt/aria, caption, origin, missing state, non-image unchanged.
- Lightbox: showModal, close button, cancel/Escape, backdrop, download link, mobile; focus return
  only in browser QA (jsdom does not implement it).
- Message/Thread/Page plumbing: open event reaches one lightbox.
- `ToolPart`: `show_image` compact card; success/failure; raw JSON hidden.
- `chat-core`: `caption`/`origin` preservation; URL safety.

Browser QA:

- Operator + agent images at 390/1440 dark/light; one column; lightbox open/close/Escape/focus;
  no horizontal overflow; no console/page errors; screenshots under
  `docs/design/artifacts/chat-images/`.

## 8. Failure and rollback

- Any Phase B failure leaves Phase A intact; the UI still renders operator images.
- Migration v21 is a **one-way door**. The schema guard (`SchemaTooNewError`,
  `src/store/database.ts:14-19`) makes an older binary exit `1` when it sees v21, so a failed Phase
  B deploy cannot be rolled back by swapping the image alone. The deploy gate is: take a pre-deploy
  DB backup, deploy forward, and if rollback is required restore that backup together with the old
  image. There is no in-place DB downgrade.
- A failed `show_image` returns a stable envelope and leaves no row/file/temp.
- A failed download marks `missing` and 404s; the UI shows the placeholder.
- If the media service is unavailable (`agentsHome` undefined), the tool is omitted and the chat
  continues normally.

## 9. Risks

- The app-writable `agent-media` location allows self-tamper; accepted and recorded. A destination
  directory swap after the final pre-rename re-check remains a residual risk; dirfd-relative rename
  is the preferred mitigation.
- A 20 MiB compressed image can decode to a very large bitmap in the browser; no pixel-dimension
  check in v1. Accepted residual risk; the browser is the operator's.
- Hard links inside allowed roots are not detected; accepted residual risk.
- Staged rows with no attached message consume quota until an explicit future prune; bounded by
  5 GiB.
- A live attach can race a session delete: `deleteSessionAgentMedia` may select the session rows
  before `attach` binds a staged row, leaving one attached row for a deleted session. This is an
  accepted residual race; it is bounded by quota and removed on app deletion. A future
  session-generation guard can close it.
- The legacy session SSE route is updated for stripping; if it remains unused, no behavior change.
- The chat QA suite on `main` has a pre-existing queue-strip failure; the new focused scenario must
  not depend on it.

## 10. Verification

```bash
npm run lint
npm run typecheck
npm run typecheck:ui
npm test
npm run build
npm run check:ui
npm run check:sensitive
npm run test:e2e
```

Run server tests with the repository's credential environment rules. Run browser QA with a local
test state and token; never use deployment secrets or real project data.

## 11. Plan review

### Round 1 - `momus` - FAIL (three blocking findings)

The plan review found the core contracts complete but three inconsistencies. Revision 2 of the
plan resolves them:

1. **Inconsistent `reconcileAgentMedia` signatures/placement.** Resolved: one signature
   `{db, agentsHome, startup, activeIds, now}`, no-op on undefined `agentsHome`, called after the
   `agentsHome` guard and before the `startup` return.
2. **`attach` signature mismatch.** Resolved: the plan uses the design's positional
   `attach(appId, id, sessionId, messageId, partId)` in `service.ts` and both projectors.
3. **Undefined transaction variables.** Resolved: define `reservedSize = source.size`,
   `tempPath`, `finalPath`, and `finalStat`; use `reservedSize` for quota/insert/copy and assert
   `finalStat.size === reservedSize`.

Non-blocking findings folded in: explicit mapped-root containment; title/metadata path redaction;
`manager`-absent tool omission; no `views.ts` pass-through; jsdom focus-return moved to browser QA;
migration test expectations; E2E seed row/file; deployment v21 note; concurrent attach/delete race
recorded; caption rule aligned; approved tool description copied; explicit Phase B gate.

### Round 2 - `momus` - PASS

The plan review passed: the three blocking findings are substantively resolved (single
`reconcileAgentMedia` signature, positional `attach`, defined transaction variables), Phase A is
independently verifiable, Phase B is explicitly gated on Phase A, and no new blocking contradiction
was found.

Non-blocking items to apply during implementation: align design D7's `reconcileAgentMedia`
signature with the full `{db,agentsHome,startup,activeIds,now}` form; clarify that `store.attach`
is the DB transaction and `service.attach` is the positional wrapper returning `AttachResult`;
state that live nested-data-URL stripping applies to every tool part; use
`part.sessionID ?? message.info.sessionID` in history; decide the final symlink-at-admission policy;
ensure the admission limiter is a module singleton; and make `SHOW_IMAGE_TOOL` conditional on
`agentsHome`/`manager`.
