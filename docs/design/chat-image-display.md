# Design - Chat image display and agent-sent images

Status: **implemented** - design review PASS (`oracle` round 6, after five revision rounds); plan
review PASS (`momus` round 2); implemented and verified (journal 0040).

Stage: `0033-chat-image-display`.

Scope: explicit, model-chosen image display in the chat workspace. An app agent calls a new
`show_image` MCP tool to publish one image (PNG/JPEG/GIF/WebP) from its application workspace,
runtime temp, or attachment root. Hanse stores the image in a per-app agent-media store, attaches
it to the assistant message, and renders it large inline. All chat images (operator and agent) open
in a lightbox. The UI also renders existing operator images large.

Out of scope: automatic mirroring of every opencode tool attachment; agent image generation; image
editing/annotation; video/PDF preview; markdown `![...]()` rendering; zoom/pan in the lightbox;
master-agent support; a settings toggle; image OCR or analysis; changes to the model context beyond
the explicit tool call.

## 1. Problem

The chat currently renders operator attachments as a compact 2.5 rem (40 px) thumbnail card. There
is no large image view and no lightbox. Agent turns cannot publish an image at all: opencode images
from tools live in `ToolPart.state.attachments` as `data:` URLs, Hanse projects only top-level
`file` parts, and the bounded typed event truncates nested strings to 8 KiB. An agent cannot show a
UI screenshot it just took, even when the operator needs to see it.

An earlier option - mirror every tool attachment into the chat - was rejected as noise. The model
must decide when an image is worth showing. The display must not depend on the model provider
supporting image input, because the default model may be text-only.

## 2. Requirements

| ID | Requirement |
| --- | --- |
| R1 | An app agent can explicitly publish one image from its app workspace, app runtime temp, or app attachment root through a coordinator MCP tool. |
| R2 | Only an explicit `show_image` call is an agent-initiated publication. Other tool attachments are never mirrored automatically. Amended by [`inline-prompt-media.md`](./inline-prompt-media.md): a user-turn image `file` part may render its own card and be served on demand from the persisted message part; nothing is copied into a Hanse store or attached to a different message, and nested tool attachments remain invisible. |
| R3 | The published image is durable per session and survives a coordinator restart, an app restart, and an app image change. |
| R4 | The image is attached to the assistant message that produced the tool call, in both live SSE and history reads, and is idempotent across reconnects and re-reads. |
| R5 | The model never needs to receive the image bytes; the tool returns only a small metadata envelope. |
| R6 | Every image in the chat (operator and agent) renders large inline and opens in a lightbox. |
| R7 | The lightbox is keyboard accessible: native dialog focus trap, Escape, focus return, and a visible close control. |
| R8 | Files outside the allowed roots, symlinks, non-regular files, non-image MIME, and oversized files are rejected. Credential paths are never readable through this tool. |
| R9 | A per-app quota bounds agent media; attached files and rows are cleaned with the session/app, a daily pass marks attached rows whose file is missing as `missing`, and it removes staged rows whose file is missing plus unreferenced files. A staged row has no session association; it is durable until attached, until the app is deleted, or until a future explicit maintenance action. |
| R10 | No host path is forwarded to the browser in the synthetic image part or the `show_image` tool part; the browser gets a same-origin download URL and metadata only. Nested tool-attachment `data:` URLs are stripped from live and history payloads as part of this stage. Other nested `data:` fields outside tool attachments remain a pre-existing, out-of-scope risk. [`inline-prompt-media.md`](./inline-prompt-media.md) adds a human-only on-demand route for a qualifying user-turn image `file` part; its response is bytes only and its projected part URL is same-origin. |
| R11 | Existing operator attachments keep their behavior; only their visual presentation changes. |
| R12 | Markdown images remain unsupported; the safe Markdown subset is unchanged. |
| R13 | The live and history projections normalize the `show_image` tool result through one shared envelope parser; a non-JSON, wrapped, or double-encoded result never crashes projection or publishes an image. |

### Quality-attribute scenarios

| ID | Scenario |
| --- | --- |
| Q1 | An agent calls `show_image` with `$TMPDIR/shot.png`; the image appears in the same assistant message live, and after a reload the same image appears exactly once. |
| Q2 | An agent calls `show_image` on a path outside its app roots, a symlink, or a 30 MiB file; the tool returns a stable `{ok:false, code}` envelope and no row/file is created. |
| Q3 | Five concurrent `show_image` calls on a 20 MiB file do not exceed the in-flight byte budget; excess calls return `image_busy`, and no partial file remains. |
| Q4 | A user and an agent image are rendered at 390 px and 1440 px; clicking either opens a lightbox, Escape closes it, and focus returns to the image button. |
| Q5 | A session with agent images is deleted; its rows and files are gone and the quota is released. |

## 3. Verified facts

### 3.1 opencode 1.19.3

- The `read` tool returns image/PDF bytes as `attachments` on its execute result: `{type:"file",
  mime, url:"data:<mime>;base64,..."}`. WebFetch does the same for image responses. MCP tools that
  return image content are converted by opencode into tool attachments. A Playwright-style
  screenshot MCP server therefore already produces a tool attachment.
- A tool result's attachments are persisted inside the tool part (`ToolPart.state.attachments`,
  `FilePart[]`); there is no top-level assistant `file` part for them. `message.part.updated`
  carries the whole part, and `GET /session/:id/message` returns the same part from the upstream
  store.
- Image attachments are normalized by opencode (typically <=5 MiB base64, <=2000x2000). A
  non-`data:` image URL is rejected by the normalizer; a `file://` URL is not the canonical
  transport.
- No built-in browser/screenshot tool exists. Screenshots come from an MCP server or from a file
  the agent reads.

### 3.2 Hanse today

- `src/opencode/events.ts:1795-1874` projects `message.part.updated`. Only `file` parts with an
  `attachment_deliveries` row are rewritten to a download URL; tool parts pass through the bounder.
- `boundPart`/`boundGeneric` (`src/opencode/events.ts:1035-1100`, `584-620`) recursively truncate
  strings, so a nested `state.attachments[*].url` data URL is cut to 8 KiB before it reaches the
  typed event. The raw upstream part is available in `partUpdated` before bounding.
- `src/attachments/projection.ts:36-46` strips every unknown top-level `data:` URL; `92-105`
  rewrites only delivery-owned file parts. Tool attachments are not projected.
- `src/attachments/views.ts:26-55` builds `AttachmentView` with `{id,name,mime,size,kind,mode,state,
  downloadURL,inline}`. `src/attachments/storage.ts:103-139` opens a stored file with `O_NOFOLLOW`
  and size verification.
- `src/mcp/protocol.ts`/`src/mcp/ssh-protocol.ts` expose text-only JSON envelopes. The coordinator
  MCP server is the `hanse` server; opencode presents its tools as `hanse_<name>`.
  `src/http/internal-mcp.ts` resolves the app from the bearer token; the request body cannot choose
  the app.
- `ui/components/chat/ChatAttachmentCard.vue` renders the only `<img>` in the client: a 40x40
  thumbnail using the full download URL. `src/http/styles.css:5917-5970` sets the small card grid.
- `ui/components/chat/ChatMessage.vue` renders a file part as an attachment card and file-only
  attachments as a strip; both paths use `ChatAttachmentCard`.
- `assets/markdown.js` has no image branch; `DESIGN.md:1091` records images as deliberately
  unsupported.
- Native `<dialog class="dialog">` + `showModal()` is the established modal primitive
  (`ui/components/SettingsConfirmDialog.vue`), with tokens `--radius-lg`, `--shadow-overlay`,
  `--scrim`, `--z-dialog`; no SFC `<style>` blocks are allowed.

## 4. Alternatives considered

| Alternative | Why not |
| --- | --- |
| Auto-project every `ToolPart.state.attachments` | Rejected by the owner as noise; every read/screenshot would appear, and tool attachments are often incidental. |
| Make `look_at` return the image | `look_at` is an analysis tool; it returns text. The image must be produced elsewhere (screenshot MCP or a file). |
| Add a top-level assistant `file` part by editing opencode | Not supported by the upstream processor; Hanse must not fork the agent runtime. |
| Return image content from the MCP tool | Simpler transport, but sends the image back into the model context and depends on provider image support. The default model may be text-only. |
| Let the agent emit Markdown `![...]()` | Markdown images are deliberately disabled for XSS/remote-image safety; enabling them is a separate security change. |
| Store agent images in the workspace | Pollutes the repository, can be committed, and is removed with source deletion. |
| Store agent images in coordinator state | The app cannot read them; the coordinator download route would still need a new store. |
| Reuse `app_attachments` delivery rows only | The delivery table is send-attempt state (`sending/sent/unknown/failed`) and requires a session at row insert time. A staged agent image has no known session/message yet. A separate table keeps semantics clear. |
| Use a text sentinel in the assistant reply | Fragile, model-visible, and easy to spoof; the tool result already carries a trusted id. |
| Resolve the tool call to a session from the MCP request | The MCP bridge has only the app token; it does not know the opencode session or message. Association must happen in Hanse's projection where both ids are present. |

## 5. Decisions

### D1 - Explicit `show_image` tool; no automatic ingestion

Add `show_image` to the non-master coordinator MCP surface. opencode exposes it as
`hanse_show_image`.

Input:

```json
{
  "path": "screenshots/ui.png",
  "caption": "Settings after the save"
}
```

- `path` is required, 1..2048 bytes, no NUL. Relative paths resolve against the application
  directory. Absolute paths are accepted only when they map into an allowed root (D3).
- `caption` is optional, 1..200 characters raw, sanitized to one line (strip C0/DEL/line
  separators, trim, collapse internal whitespace); empty or over-200 after sanitization is
  `invalid_caption`. It is plain text and is rendered escaped; it is never HTML.
- The tool returns a small JSON envelope, never image bytes:

```json
{ "ok": true, "id": "amed_...", "name": "ui.png", "mime": "image/png", "size": 123456 }
```

- Failures return `{ok:false, code, message}` with a stable code (D9). The tool never throws.
- The description tells the model to call it only when the operator should see an image, not for
  routine reading/analysis, and that the path must be inside the app workspace or runtime temp.
- Other tool attachments remain invisible. `read`/MCP screenshots are still available to the model;
  only `show_image` publishes to the operator.

### D2 - New `agent_media` store and migration v21

A new table keeps agent-published media out of the user-send delivery state machine.

Definitions used throughout: **`appRoot`** is the per-app agents state root,
`appStateRoot(agentsHome, projectId, appKey)` (not the managed application directory);
**`appDir`** is the canonical managed application directory from the registry. Agent media lives at
`<appRoot>/agent-media`; the allowed source roots are `appDir`, `<appRoot>/tmp`, and
`<appRoot>/attachments`.

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

- `id` is `amed_` + 16 random bytes (base64url), generated by the coordinator.
- `stored_name` is `<id>-<safeName>`; `rel_path` is `agent-media/<storedName>` relative to the app
  root.
- `state='staged'` means a **reservation**: the row exists, the final file may still be absent or
  temp-only while the copy runs, and the tool call may not have returned yet. A staged row with a
  matching final file is complete and awaiting attachment. `attached` means the row is bound to a
  `session_id`/`message_id`/`part_id`; `part_id` is the **tool part id**, not the synthetic
  `prt_amed_*` id. `missing` means an attached file failed verification and is excluded from quota.
- A staged row is durable: it is not expired by time. Attached media is removed when its session or
  app is deleted. A staged row has no session association, so session deletion cannot target it;
  it is removed by app deletion or an explicit future maintenance action. The 5 GiB quota bounds
  accumulated staged media; this closes the "valid image deleted before the operator opened the
  session" failure.
- Migration v21 is forward-only and adds only this table and its indexes. Existing rows are
  untouched.
- Agent media counts against the existing 5 GiB per-app attachment quota. `availableAttachmentBytes`
  and `reservedAttachmentBytes` include non-missing `agent_media.size`. This is an intentional
  shared disk budget.
- **Reserve before the full copy.** After `open`/`fstat`/MIME sniff, the tool inserts a `staged`
  row (with the sniffed MIME, declared size, and final `rel_path`) under the shared per-app
  upload/quota lock. It releases the lock, then copies bytes. The copy/rename verifies/updates the
  same row; a failure deletes it. This makes the quota reservation durable and closes the
  concurrent-copy overshoot.

### D3 - Path resolution and file admission

The tool accepts paths only under these roots:

- the application directory (the canonical `appDir` from the registry; relative paths resolve
  here);
- `<appRoot>/tmp` (the instance `TMPDIR`, where screenshots often land);
- `<appRoot>/attachments` (operator-uploaded files, read-only to the agent).

It never allows `<appRoot>/home`, `config`, `data`, `state`, `cache`, `mise`, `mcp-token`, provider
`auth.json`, the managed git credential directory, or the opencode password. This preserves the
credential deny list at the tool boundary, not only in the agent policy.

Resolution rules:

1. Reject empty paths, NUL, and any `..` segment.
2. A relative path is resolved against `appDir`.
3. Expand a literal leading `$TMPDIR/` to `<appRoot>/tmp/`; no other shell expansion is performed.
4. An absolute path that starts with the model-visible workspace root `/data/workspace/` is mapped
   to `<project.workspaceRoot>/<rest>`; the result must stay inside `appDir`.
5. An absolute path that starts with the model-visible agents root
   `/data/agents/<sanitizedProjectId>/<sanitizedAppKey>/` is mapped to
   `appStateRoot(agentsHome, projectId, appKey)/<rest>`; the result must stay inside
   `<appRoot>/tmp` or `<appRoot>/attachments`. Use `sanitizeAppKey` (never raw project/app names).
6. In supervisor mode (host paths are model-visible), an absolute path is accepted only when it is
   already inside one of the allowed host roots.
7. `realpath` the nearest existing ancestor, then `lstat` the file: it must be a regular file, not
   a symlink, and its real parent must stay inside the allowed root. Use `resolveWithinRoot`-style
   containment (no string-prefix checks).
8. `lstat` the resolved target, then open with `O_NOFOLLOW` and `fstat`; require a regular file
   and compare `dev`/`ino`/`size` between the `lstat` and `fstat` results (a regular-file swap
   between resolution and open is rejected).

Implementation must use the existing helpers (`appStateRoot`, `sanitizeAppKey`,
`resolveWithinRoot`, `project.workspaceRoot`, `agentsHome`). If `agentsHome` (the media store) or
the instance manager (needed for `pathMode`) is not configured, the tool is omitted from
`tools/list`; a direct call still returns a stable `image_unavailable` failure. Failure messages
never include a resolved host path.

Admission is image-only and bounded:

- Sniff at most the first 512 bytes with a **positional** read (`readSync(fd, buf, 0, 512, 0)` or
  `pread`) so the fd offset stays at 0. Only `image/png`, `image/jpeg`, `image/gif`, and
  `image/webp` are accepted. SVG/HTML/PDF/video are rejected with `image_unsupported`.
- Size must be 1..20 MiB (`MAX_AGENT_IMAGE_BYTES`); larger files return `image_too_large`.
- Empty files return `image_empty_file`.
- After open/`fstat`/sniff, reserve the `staged` row (sniffed MIME, declared size, final
  `rel_path`) under the **shared per-app upload/quota lock**. Release that lock before the full
  copy; a separate in-flight admission limiter enforces the concurrency caps. Copy from the
  already-verified fd with an explicit `start: 0` (`createReadStream("", { fd, start: 0 })` with
  `autoClose: false`, matching the existing download route, or a bounded positional read loop),
  never `copyFile(path)`, so a symlink
  swap after admission cannot redirect the read. Bound the copy to `MAX_AGENT_IMAGE_BYTES` and the
  fstat size; the final size must equal the reserved size exactly. The caller owns the fd and
  closes it in `finally`.
- Create `<appRoot>/agent-media` and `.tmp` with a safe helper: `lstat` any existing entry, reject a
  symlink or non-directory, create with mode `0700`, and verify containment with `realpath`. Open
  the temp file with `O_NOFOLLOW | O_CREAT | O_EXCL | O_WRONLY` (dirfd-relative if available), never
  a bare `writeFile` by path. Write to `.tmp/<id>.part`, fsync, **re-validate `agent-media` and
  `.tmp` with `lstat`/`realpath` immediately before the rename**, then rename (prefer a
  dirfd-relative rename) to `<appRoot>/agent-media/<storedName>`. The row already exists and is
  `staged`; after the rename verify the final size equals the reserved size, never update `size`,
  and bump `updated_at`. A mismatch deletes the row/temp/final and returns `image_size_mismatch`.
  On any other failure remove the temp and delete the row. A crash after the rename leaves a valid
  staged row with a matching final file; startup reconcile keeps it. A crash before the rename
  leaves a staged row with only a temp; startup reconcile removes both.
- The whole file is never buffered in the coordinator heap; the sniff reads a bounded head and the
  copy streams from the verified fd.
- A process-local admission allows 2 concurrent agent-image copies per app and **64 MiB of
  in-flight bytes globally** (not per app). Excess calls return `image_busy`. This limiter is
  separate from the upload limiter so a burst of agent images cannot starve operator uploads (or
  vice versa). The global byte budget plus the durable quota reservation bounds the total. The
  shared quota lock is held only for read/decide/insert; it is not held across the copy.

### D4 - Association in the live and history projections

Hanse binds the tool result to the assistant message where both the session and message ids are
known. A shared `parseShowImageEnvelope(value)` is the only parser used by live and history:

- accept a string or an object;
- unwrap the MCP `content[]` shape (`{content:[{type:"text",text:"..."}]}`), including a
  double-encoded JSON text;
- return `{ok:true,id}` only when the envelope is `{ok:true,id:"amed_..."}`;
- return `undefined` for invalid JSON, `ok:false`, a missing id, or an unexpected shape.

Live (`EventProjector.partUpdated`, raw part before bounding and independent of
`shouldForwardSnapshot`):

1. If `part.type === "tool"`, `part.tool` is `hanse_show_image` **or** `show_image`, and
   `state.status === "completed"`, parse the envelope.
2. If an id is present, call `agentMedia.attach(appId, id, sessionID, messageID, toolPartID)`.
   The result is `{status:"attached"|"missing"|"conflict"|"unknown", view?}`:
   - `conflict`: the row is bound to a different message/part; no view. Check this **before** the
     missing case, so a missing row cannot render in an unrelated message.
   - `missing`: the row is already marked missing and is bound identically (the schema enforces
     a non-null association for `missing`); return a view with `state:"missing"` and do not bind.
     This branch does not re-stat the file. An unbound/missing row is invalid data; treat it as
     `unknown`. The schema CHECKs make it unreachable; the defensive branch is kept for corrupted
     data and does not need a cleanup path.
   - `attached`: the row was newly bound (or already bound identically); set `state='attached'` if
     needed and return a view with `state:"sent"`.
   - `unknown`: no row; no view.
   The DB write is idempotent: null association fields are filled, an identical association is a
   no-op, and a different association never rebinds the row.
3. Emit the normal bounded tool-part event. If the result has a view (`attached` or `missing`) and
   this projector has not yet emitted this `(messageID, mediaId)`, emit a synthetic
   `message.part.updated` event with:
   - `partType: "file"`;
   - `partID: "prt_<mediaId>"` (stable, `prt_amed_...`, starts with `prt`);
   - `part: {id, sessionID, messageID, type:"file", mime, filename, url: encoded download URL,
     attachment:{id, size, mode:"inline", kind:"image", inline:true,
     state: view.state, origin:"agent", caption?}}`.
   The live synthetic part uses `view.state`, so a missing row renders the placeholder in live too.
   The per-projector seen set prevents repeated completed events from emitting duplicate synthetic
   parts; cap it at 1 000 entries and drop the oldest. Different browser streams may each emit one,
   but the client merges by part id.
4. The synthetic event is small and is not passed through `boundPart`; it contains no data URL and
   no host path. The URL is built with the same `encodeURIComponent` discipline as `downloadUrl`.
5. If the tool output is invalid, `ok:false`, or has no id, only the normal tool event is emitted.
   The tool card remains visible.

History (`createMessageProjector`):

1. Project parts as today.
2. For each completed `show_image` tool part, use the same envelope parser, call `attach`, and
   insert the same synthetic file part immediately after the tool part when the result has a view
   (`attached` or `missing`). A `missing` view is appended with `attachment.state = "missing"`; the
   existing card renders the placeholder. `conflict`/`unknown` are skipped. Deduplicate by the
   deterministic synthetic part id before inserting, so a repeated projection of the same message
   cannot append two cards.
3. The synthetic part id is deterministic, so a live-then-history merge replaces rather than
   duplicates. The tool part itself remains in history; the UI renders it as a compact action card.
4. Because staged rows do not expire, a tool call that completed while no browser stream was
   attached is still attached by the next history read. The image is durable across restarts and
   delayed reads.

**Nested tool-attachment data URLs.** Before live bounding and in history projection, a recursive
pass replaces every `data:` URL in `state.attachments[*].url` (tool parts) with `""` and a
`state.attachmentsTruncated` marker. The tool card does not render those attachments, and the
browser must not receive base64 from them. This closes the existing history leak and makes the
"other tool attachments are invisible" claim true for payloads, not only for rendering. Other
nested `data:` fields (`state.output`, `state.input`, metadata) are outside this stage's scope and
remain a pre-existing risk.

**Redact `show_image` paths.** The normal tool part for `show_image` may contain
`state.input.path`, which is a model-supplied path (and a host path in supervisor mode). Before
bounding/projection, remove `state.input.path` (or replace `state.input` with `{redacted:true}`), and
remove any echoed path from `state.title`/metadata; do not copy any path into `state.output`. The
compact tool card uses the sanitized name from the envelope; the synthetic part uses the download
URL. The test asserts the serialized tool part contains no path, not only `state.input.path`. This
makes the "no host path to the browser" claim true for the tool part as well.

**Construction, not one shared resolver.** There is no single resolver shared by live and history.
`streamAppEvents` constructs the live resolver; the history route and the blocking-send response
construct their own per target. `AgentMediaService` is cheap and stateless apart from the DB and
path roots; `attach` is a small idempotent DB write, so multiple streams/readers cannot produce
duplicate images. The deprecated legacy `streamSessionEvents` route (raw
`createRawEventStream`/`projectRawEnvelope`) receives the nested tool-attachment data-URL
stripping only. It does **not** emit agent-media synthetic parts; the SPA chat uses the typed app
stream. This compatibility limitation is recorded; the legacy route is a candidate for removal.

### D5 - Download route

Add human-only:

```text
GET|HEAD /api/apps/:app/agent-media/:id?project=<projectId>
```

- Resolve the app from the path/query exactly like the attachment route. The lookup includes
  `app_id`; a foreign id is `404`, not `403`.
- Require a human principal (cookie or bearer); agent tokens are `403`.
- Require `state='attached'` with a non-null session; staged media is not downloadable.
- Open the file with a dedicated `openAgentMediaFile` helper (`O_NOFOLLOW`, real-parent containment,
  `stat.size === row.size`). The existing `openAttachmentFile` hard-codes `attachmentsRoot`, so it
  cannot be reused unchanged. A mismatch marks the row `missing` and returns `404`.
- Stream exactly `row.size` bytes; do not rely on EOF. Send headers and end without a body for
  `HEAD`. Reuse `encodeContentDisposition` for the sanitized name.
- Response: `content-type` = the stored image MIME, `content-length`, `content-disposition: inline`,
  `x-content-type-options: nosniff`, and `cache-control: private, max-age=3600`. No Range support
  in v1.
- The route is same-origin with the SPA; the browser sends the cookie. `safeAttachmentUrl` already
  accepts this path.

### D6 - UI

`AttachmentView` gains optional `caption` (agent media only) and optional `origin: "agent"` for
styling/tests. Both the client `normalizeAttachment` and `attachmentViewFromFilePart` must preserve
them; the synthetic part explicitly sets `attachment.caption` and `attachment.origin = "agent"` so
the UI does not infer from the part-id prefix.

`ChatAttachmentCard`:

- For `kind === "image"` and `state !== "missing"`, render a large preview instead of the 40 px
  square:
  - a full-width `<button type="button" class="attachment-card__open">` wrapping the `<img>`;
  - `inline-size: 100%`, `block-size: auto`, `object-fit: contain`,
    `background: var(--wash-1)`, `max-block-size: min(70vh, 32rem)`;
  - `loading="lazy"`, `decoding="async"`;
  - the button's accessible name is `Open image: <name>`;
  - the image card switches the article grid to a single column
    (`grid-template-columns: minmax(0, 1fr)`; areas `preview`, `body`, `action`), so the existing
    2.5 rem preview column is not reused.
- The card body keeps the name, size/kind, optional caption, and the download link.
- Non-image attachments keep the compact icon card.
- An `<img @error>` flips a local `failed` flag and renders the missing/unavailable placeholder, so a
  later 404 does not leave a broken image.
- `data-kind`, `data-state`, `data-origin` (when agent) are exposed for tests and styling.
- The image button emits `open` with the attachment; `ChatMessage` and `ChatThread` forward it;
  `ChatPage` owns the lightbox state.

Message attachment strip:

- `.message__attachments` becomes a single-column stack (the owner chose a column). Images use the
  full feed measure; non-image cards are also stacked, which is acceptable.
- The composer chips stay icon chips; they are not image previews in this stage.

`ChatImageLightbox.vue`:

- Native `<dialog class="dialog lightbox">`; `showModal()` when opened, `close()` when closed.
- `@cancel.prevent` and `@close` emit `close`; a visible close button and a download link.
- A click on the dialog element itself (the backdrop) closes; clicks inside the panel do not.
- Focus moves to the close button on open; native dialog restores focus on close.
- `aria-labelledby` points at the image name; the image has the alt text.
- The image uses `max-inline-size: 100%`, `max-block-size: 80dvh`, `object-fit: contain`.
- No zoom/pan; the original file can be downloaded.
- One instance rendered by `ChatPage`; `chat-ui` or a page ref holds
  `{src,name,downloadURL,caption?}`.

`show_image` tool card:

- `ToolPart` recognizes the normalized `show_image` tool name.
- On success it renders a compact one-line action card (`Image shown` + name), never the raw JSON
  output.
- On failure it renders the normal error card with the bounded message.
- The synthetic image card follows the action card. This keeps the tool trace and avoids a JSON
  dump.

No SFC `<style>` blocks. All CSS goes to `src/http/styles.css`, using the existing tokens:
`--space-*`, `--radius-*`, `--surface-3`, `--line-strong`, `--shadow-overlay`, `--scrim`,
`--z-dialog`, `--text-*`. No new color, spacing, radius, or shadow token.

### D7 - Limits, quota, and retention

| Limit | Value | Behavior |
| --- | --- | --- |
| Agent image size | 20 MiB | `413`-equivalent `{ok:false,code:"image_too_large"}`; temp removed |
| Agent images per app | bounded by quota | shared 5 GiB attachment quota; `image_quota_exceeded` |
| Concurrent agent-image copies per app | 2 | `image_busy` |
| Global in-flight agent-image bytes | 64 MiB | `image_busy` |
| Caption | 200 chars raw | sanitize to one line; empty or over-200 after sanitization is `invalid_caption` (reject, never silently truncate) |
| Path | 2048 bytes | `invalid_path` |
| Staged row retention | none by time | durable until attached, until the app is deleted, or until a future explicit maintenance action; bounded by the 5 GiB quota |
| Orphan file TTL | 24 hours | daily sweep removes files without a row |
| Missing file | detected on download/reconcile | row `missing`, excluded from quota |
| Active copy protection | process-local id set | reconcile skips active ids; a 15-minute age floor is an extra guard |

Quota lock:

- Extract the existing per-app upload/quota `KeyedMutex` from `src/http/chat.ts` into a shared
  module and use the **same** lock for operator upload admission and `show_image` quota
  read/decide/insert. Hold it only for that critical section; release it before streaming the
  upload or copying the image. The separate process-local in-flight limiter enforces the 2 / 64
  MiB caps.

Retention:

- Attached media lives until the session or app is deleted.
- Staged media is durable. It is never deleted merely because the operator did not open the session
  within a time window. A future explicit maintenance action may prune long-staged media; this
  stage does not.
- `deleteSessionAgentMedia(db, appRoot, appId, sessionId)` selects the session rows, deletes them in
  the transaction, then removes the files best-effort. It is called from every session deletion
  path: `removeLocalSessionRows`, the pending-recovery delete, `#sweepOne` (the per-session empty
  sweep called by `#pass`), and `#sweepNoticeOrphan` (the "upstream session is gone" path).
  Centralize the local cleanup if a fifth site appears.
- App deletion cascades the rows via the FK; the existing app-state removal deletes
  `<appRoot>/agent-media`.
- Reconcile skips ids in a process-local active-copy set, and only touches staged rows older than a
  15-minute safety floor during the daily pass. The startup pass reconciles all reservations
  (after a crash there is no active set).
- For each staged row: final file with matching size -> keep; final file with a size mismatch ->
  remove the row and file (failed copy); only the deterministic temp file -> remove both; final
  missing -> remove the row and any temp.
- The daily pass also removes files under `agent-media/` without a row older than 24 hours and
  marks attached rows whose file is missing as `missing`; `missing` rows are excluded from quota.
- The startup pass must not apply a time-based staged deletion; there is none. It reconciles only
  broken reservations (temp-only, missing final, or final-size mismatch) and leaves valid staged
  rows untouched. The daily pass additionally runs the missing-file and orphan-file sweeps. A
  dedicated `reconcileAgentMedia({startup, activeIds, now})` implements this and is called from the
  existing maintenance entry point; it does not depend on the attachment early-return branch.

### D8 - Security

| Threat | Mitigation |
| --- | --- |
| Path traversal / symlink escape | `..` rejection, `realpath` of the nearest existing ancestor, `resolveWithinRoot` containment, `lstat`, `O_NOFOLLOW`, and a real-parent check. A symlink whose target stays inside the allowed root is not an escape and may be accepted; a symlink escape is rejected. The copy reads from the verified fd, never `copyFile(path)`, closing the final-component post-admission swap. A directory-component swap between resolution and open remains an accepted residual risk; `openat2(RESOLVE_BENEATH)`/dirfd containment is future hardening. |
| Credential exfiltration through the tool | Allowed roots are only the app directory, `<appRoot>/tmp`, and `<appRoot>/attachments`. `home`, `config`, provider `auth.json`, managed git credentials, MCP token, and the opencode password are outside the allowlist. Image-only MIME sniff is an additional gate. Failure messages never include a resolved host path. |
| Destination symlink planting | `ensureAgentMediaRoot`/`.tmp` reject symlinked/non-directory entries and create `0700`; temp files are opened with `O_NOFOLLOW|O_CREAT|O_EXCL`; containment is re-checked immediately before rename, and a dirfd-relative rename is preferred. A swap after that final check remains a residual risk, accepted with the app-writable store. |
| Cross-app access | The app comes only from the verified bearer token; every DB lookup includes `app_id`; foreign ids return `404`. |
| Stored XSS | Only png/jpeg/gif/webp; `image/svg+xml` and HTML are rejected; downloads use `nosniff` and `inline` only for the four safe image MIMEs. |
| Base64/host-path leakage | The tool returns metadata only; the synthetic part uses a same-origin download URL and sanitized name; nested tool-attachment `data:` URLs are stripped from live and history; the `show_image` input path is redacted; no host path from these fields reaches the browser. Other nested `data:` fields outside tool attachments remain a pre-existing, out-of-scope risk. |
| Resource exhaustion | 20 MiB per file, 2 concurrent per app, 64 MiB global in-flight, 5 GiB durable quota reservation, no whole-file heap buffering, orphan sweeps. |
| CSRF | The download route is a safe GET; the tool is agent-token-only; no new browser mutation route. |
| Message spoofing | The synthetic part is created by the server after parsing the trusted tool output and verifying the media row; the model cannot inject a URL. |
| Credential/log leakage | The tool result contains id/name/mime/size/caption only; logs never include paths or file bytes at info level. |
| Media self-tamper | Accepted residual risk: `<appRoot>/agent-media` is inside the app's writable agents bind, so the agent can read/tamper with its own published media. The download verifies size; the agent already controls its own output. Store outside the app-writable root is a future hardening option. |
| Hard links | Accepted residual risk: a hard link inside an allowed root is not detected by path allowlists. The MIME gate and the app's existing file access limit the impact; a hash check is a future hardening option. |

### D9 - Failure semantics

| Failure | Behavior |
| --- | --- |
| Path outside allowed roots | `{ok:false,code:"path_outside_app"}`; no row/file. |
| Symlink target outside a root | `path_outside_app` from containment; if the final open refuses a symlink/non-regular file, `image_unreadable`. |
| Symlink swap after admission | The verified fd is copied; the symlink target is never read. The call succeeds with the original file. |
| Unsupported MIME (including SVG/HTML/PDF) | `{ok:false,code:"image_unsupported"}`. |
| Empty/oversized file | `image_empty_file` / `image_too_large`. |
| Final size differs from the reservation | `image_size_mismatch`; row/temp/final removed. |
| Quota exceeded | `image_quota_exceeded`. |
| Busy | `image_busy`; caller may retry later. |
| Storage failure | `image_storage_error`; temp removed. |
| Tool succeeds, no browser stream | Row stays `staged`; history read attaches it later. Staged rows do not expire by time. |
| Tool succeeds, assistant message never persists | Staged row remains durable and counted against the quota; a future explicit maintenance action may prune it. |
| Association sees a different message for the same media | `conflict`: skip the synthetic part; log a warning. |
| Association sees a missing file | `missing`: emit a synthetic part with `attachment.state="missing"` in live and history; do not bind. |
| File disappears after attachment | Download marks `missing`; the card's `<img @error>` shows the placeholder; 404. |
| Session deleted | `deleteSessionAgentMedia` removes attached rows/files from every deletion path, including `#sweepOne` and `#sweepNoticeOrphan`; staged rows have no session association and are not targeted. A live attach racing the delete is an accepted residual race (bounded by quota, removed on app deletion). |
| Active copy during reconcile | The active-id set (and 15-minute age floor) skips the row/temp. |
| Concurrent operator upload + `show_image` | Both reserve under the shared per-app upload/quota lock; the second observes the first reservation. |
| Nested tool-attachment data URL | Replaced with `""` + `attachmentsTruncated` in live and history before the browser sees it. |
| `show_image` input path | Removed/replaced before bounding and projection; the tool part never carries the path. |
| History read while the app is stopped | Existing `agent_stopped` behavior; no new start. |

## 6. Interfaces

### 6.1 MCP tool

```json
{
  "name": "show_image",
  "description": "Show one image to the operator in this chat. Use only when the operator should see an image; do not call it for routine reading or analysis. The path must be a real file inside the application workspace or its runtime temp/attachments roots. Save screenshots there first; a tool attachment or a container /tmp path is not readable. A literal leading $TMPDIR/ is expanded to the app runtime temp directory; no other shell expansion is performed. Supports PNG, JPEG, GIF, and WebP up to 20 MiB. Returns a media id; the operator sees the image, not you.",
  "inputSchema": {
    "type": "object",
    "properties": {
      "path": {"type": "string", "minLength": 1, "maxLength": 2048},
      "caption": {"type": "string", "minLength": 1, "maxLength": 200}
    },
    "required": ["path"],
    "additionalProperties": false
  }
}
```

Success:

```json
{ "content": [{ "type": "text", "text": "{\"ok\":true,\"id\":\"amed_...\",\"name\":\"ui.png\",\"mime\":\"image/png\",\"size\":123456}" }] }
```

Failure uses the same text envelope with `{ok:false,code,message}`. The tool is listed for
non-master apps only when the media store (`agentsHome`) and the instance manager (for `pathMode`)
are configured; otherwise it is omitted from `tools/list` so the model does not call a dead tool.
It does not depend on image input capability.

### 6.2 Database

Migration v21 only: `agent_media` + indexes (D2). No changes to `app_attachments`,
`attachment_deliveries`, drafts, pending sends, or session state.

### 6.3 Download

`GET|HEAD /api/apps/:app/agent-media/:id?project=<projectId>` (D5). Human-only, same-origin,
`private` cache, no Range.

### 6.4 Synthetic part

```json
{
  "type": "message.part.updated",
  "sessionID": "ses_...",
  "messageID": "msg_...",
  "partID": "prt_amed_...",
  "partType": "file",
  "part": {
    "id": "prt_amed_...",
    "sessionID": "ses_...",
    "messageID": "msg_...",
    "type": "file",
    "mime": "image/png",
    "filename": "ui.png",
    "url": "/api/apps/<encoded app>/agent-media/amed_...?project=<encoded projectId>",
    "attachment": {
      "id": "amed_...",
      "size": 123456,
      "mode": "inline",
      "kind": "image",
      "inline": true,
      "state": "sent",
      "origin": "agent",
      "caption": "Settings after the save"
    }
  }
}
```

The example above shows an attached row (`state:"sent"`). A missing view uses
`"state":"missing"`; the live and history builders take the value from `view.state`.

### 6.5 UI contract

- `AttachmentView` adds `caption?: string` and `origin?: "agent"`.
- `ChatAttachmentCard` emits `open(attachment)` for image cards.
- `ChatImageLightbox` props: `open`, `image: {src,name,downloadURL,caption?}`; emits `close`.
- `ChatPage` renders one lightbox instance.

## 7. Testing

- `test/agent-media.test.ts` - path resolution (relative, `$TMPDIR/`, model-visible prefixes with
  sanitized app keys, supervisor paths, missing `agentsHome`, traversal, final-component symlink
  swap, non-regular), MIME sniff (four images, SVG/HTML/PDF rejected), size/empty, quota
  reservation after sniff/before copy, shared upload-vs-show_image lock, concurrency (two copies
  overlap), destination `agent-media`/`.tmp` symlink planting, staged/attached/missing, attach
  result (`attached`/`missing`/`conflict`/`unknown`), cleanup.
- `test/agent-media-mcp.test.ts` - `tools/list` includes `show_image`; success/failure envelopes;
  both `hanse_show_image` and `show_image`; app-token binding; no path/id in the result beyond
  metadata; no image bytes; omission/failure behavior when the store is unavailable.
- `test/agent-media-projection.test.ts` - live `partUpdated` emits the tool event plus the synthetic
  file part; history projector appends it; no data URL; stable part id; missing row emits a
  `state:"missing"` card in live and history; conflict/unknown skipped; repeated events emit once
  per projector; wrapped/double-encoded/invalid `state.output`; nested tool-attachment `data:` URLs
  stripped in live and history; `show_image` input path redacted; no-browser completion then
  delayed history read still attaches.
- `test/agent-media-http.test.ts` - download human-only, app-scoped, 404 cross-app, 404 staged,
  missing file 404 + row marked missing, headers, HEAD without a body, bounded stream, no Range.
- `test/agent-media-cleanup.test.ts` - every session deletion path including `#sweepNoticeOrphan`,
  app cascade, staged durability, sweep-during-copy active-id skip, startup-after-crash reconcile,
  orphan file sweep, missing-file reconciliation.
- `test/ui/chat-attachments.test.ts` - large image card, open event, caption, non-image unchanged,
  missing state.
- `test/ui/chat-lightbox.test.ts` - open/close, Escape, focus return, backdrop click, download link,
  accessible name.
- `test/ui/chat-message.test.ts` / `test/ui/chat-tools.test.ts` - `show_image` action card, hidden
  JSON, error card, synthetic file part rendering.
- `test/chat-stage-c.test.ts` and existing attachment/projection tests - no regression in
  `data:` stripping or the 8 MiB/32 MiB caps.
- Browser QA: extend `docs/design/chat-qa.mjs` (or a new `chat-images-qa.mjs`) with operator and
  agent images, column layout, lightbox at 390/1440 dark/light, Escape/focus, and no console/page
  errors. Write screenshots under `docs/design/artifacts/chat-images/`.
- E2E: `test:e2e` chat fixture with a synthetic assistant `show_image` part and an operator image.

Verification commands (every phase):

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

## 8. Delivery sequence

### Phase A - large images and lightbox (UI only)

- `AttachmentView.caption` / `origin` optional fields and normalization (no server dependency).
- `ChatAttachmentCard` large image layout + open button.
- `ChatImageLightbox.vue`, `ChatPage` lightbox state, event plumbing.
- CSS in `src/http/styles.css`.
- UI tests and browser QA; no migration, no MCP, no download route.
- Independently shippable and verifiable against existing operator attachments.

### Phase B - `show_image` MCP tool and agent media

- Migration v21 + `AgentMediaService` (path resolver, verified-fd storage, quota reservation,
  admission, attach, cleanup).
- `show_image` tool in `src/mcp/ssh-protocol.ts` (`tools/list` + `tools/call`), wired through
  `HttpDeps` (`db`, `agentsHome`, `getProjects`, `manager`).
- MCP service tests and storage/path tests.
- Shared `parseShowImageEnvelope`; live/history projection + synthetic part in
  `src/opencode/events.ts` and `src/attachments/projection.ts`.
- Nested tool-attachment `data:` URL stripping in live and history.
- Download route in `src/http/server.ts` + `handleAgentMediaDownload`.
- `deleteSessionAgentMedia` from every session deletion path; daily orphan/missing sweep; app
  cascade.
- `ToolPart` compact `show_image` card.
- Projection/HTTP/cleanup/UI tests, browser QA, E2E.

Phase A may land before Phase B; Phase B's UI relies on Phase A. The stage is complete when both
phases pass all gates.

## 9. Owner decisions

The owner delegated decisions on 2026-11-02. Recorded as resolved:

1. **Intent** - explicit `show_image` tool; the model decides. Auto-mirroring all tool attachments
   is rejected.
2. **Layout** - single column, full feed width, stacked images.
3. **Lightbox** - fit-to-screen plus download; no zoom/pan in v1.
4. **Size** - 20 MiB per agent image; shared 5 GiB per-app quota, reserved before the copy; 2
   concurrent copies per app and 64 MiB of in-flight bytes globally.
5. **Tool name** - `show_image` (exposed as `hanse_show_image`); both names are recognized in
   projection.
6. **Paths** - app directory, `<appRoot>/tmp`, `<appRoot>/attachments`; a literal `$TMPDIR/` prefix
   is expanded; container `/tmp` and tool attachments are not paths. Credentials are excluded.
7. **Master agent** - out of scope in this stage; the master MCP surface is a separate follow-up.
8. **Transport** - store-and-return-metadata (no image bytes in the model context).
9. **Retention** - staged rows never expire by time; they are durable until attached, until the
   app is deleted, or until a future explicit maintenance action. A staged row has no session
   association, so session deletion cannot target it.
10. **Caption** - reject an empty or over-200-character caption after single-line sanitization;
    never silently truncate.
11. **Payload hygiene** - nested tool-attachment `data:` URLs are stripped from live and history in
    this stage; the "no base64 from tool attachments" invariant applies to tool parts. Other nested
    `data:` fields are out of scope.
12. **Media location** - `<appRoot>/agent-media` inside the app-writable agents bind is accepted,
    with the residual self-tamper risk recorded; the destination itself is protected against
    symlink planting; moving it outside the app-writable root is future hardening.
13. **Path redaction** - `show_image` input/output paths are removed/replaced before projection; the
    tool part carries no host path.
14. **Shared quota lock** - operator uploads and `show_image` reserve under the same per-app
    upload/quota lock; the lock is released before the copy/stream.
15. **Association result** - `attach` returns `attached`/`missing`/`conflict`/`unknown`; missing
    emits a placeholder card; conflict/unknown skip.

There are no open questions for this stage.

## 10. Acceptance criteria

- An app agent calls `show_image` on a PNG in its workspace; the image appears exactly once in the
  assistant message live and after a reload.
- No other tool attachment appears automatically, and no nested tool-attachment `data:` URL appears
  in live or history payloads.
- The same file passes after a coordinator restart, an app restart, and a delayed history read with
  no browser attached during the turn.
- A path outside the allowed roots, an SVG, or a 30 MiB file returns a stable failure and creates no
  row/file. A final-component symlink swap after admission never reads the symlink target; the
  verified original fd is copied and the call succeeds.
- Operator and agent images render large in a single column; clicking either opens a lightbox;
  Escape closes it and focus returns to the trigger.
- No tool-attachment `data:` URL or `show_image` host path appears in the synthetic part, history
  payload, or download headers. Other nested `data:` fields are outside this acceptance.
- Attached session deletion removes the rows and files from every deletion path, including
  `#sweepNoticeOrphan`; the quota reflects the removal. Staged rows are removed only by app deletion
  or a future explicit maintenance action.
- All verification commands pass, including `npm run check:ui`.

## 11. Review

### Round 1 - `oracle` - FAIL (six blocking findings)

The design was reviewed against the code. Verdict: FAIL. The blocking findings and the revision-2
resolutions are:

1. **History sent full nested tool-attachment base64.** The projector only stripped top-level
   `part.url`; `state.attachments[*].url` in tool parts was untouched. Resolved by adding a
   recursive nested-data-URL strip to live and history projection (D4/D8/R10) and tests.
2. **`state.output` parsing assumed one shape.** Resolved by one shared
   `parseShowImageEnvelope(value)` that unwraps strings, objects, `content[].text`, and
   double-encoded JSON (D4/R13).
3. **Quota was checked before the copy and excluded agent media.** Resolved by extending quota
   queries and reserving a `staged` row before the copy under the per-app lock (D2/D3/D7).
4. **A 24 h staged TTL contradicted durability.** Resolved by making staged rows durable with no
   time-based expiry; the quota bounds accumulation and history attaches on the next read
   (D2/D7/D9). The no-browser/delayed-read scenario is now an acceptance test.
5. **`deleteSessionChatRows` cannot remove files, and call sites were incomplete.** Resolved by a
   dedicated `deleteSessionAgentMedia` called from every session deletion path (D7/D9).
6. **Symlink TOCTOU between admission and copy.** Resolved by copying from the verified fd, never
   `copyFile(path)`, and re-checking the final size (D3/D8).

Non-blocking findings folded in: sanitized path mapping with `appStateRoot`/`resolveWithinRoot`;
`$TMPDIR/` expansion and the container `/tmp` limitation; the live/history resolver construction
statement; duplicate synthetic-event guard; `attachment.state`/`origin`/`caption`; encoded URL;
HEAD/bounded download; schema CHECKs; cleanup call sites; startup-vs-daily sweep; UI grid and
lightbox details; jsdom-vs-browser QA; and the accepted media self-tamper/hard-link risks.

Phase A remains independently shippable and passed the review as a phase.

### Round 2 - `oracle` - FAIL (eight blocking findings)

The re-review accepted the direction and Phase A independence but found the following unresolved
contracts. Revision 3 resolves them:

1. **`attach` return contract contradicted missing rendering.** Resolved by an explicit
   `{status:"attached"|"missing"|"conflict"|"unknown", view?}` result; `attached` sets
   `state='attached'`; `missing` returns a `state:"missing"` view and is rendered in live and
   history; conflict/unknown skip. Tests updated.
2. **Reconcile could delete an in-flight copy.** Resolved by a process-local active-id set, a
   15-minute age floor on the daily pass, all-reservation reconcile at startup, and a final-size
   mismatch branch (remove row+file).
3. **The 5 GiB quota was split across two locks.** Resolved by extracting the existing per-app
   upload/quota `KeyedMutex` into a shared module and using it for both uploads and `show_image`
   admission; the lock is released before the copy/stream.
4. **The quota lock was held across the copy, contradicting 2 concurrent copies.** Resolved by
   limiting the lock to read/decide/insert and using the separate in-flight limiter for 2 copies /
   64 MiB.
5. **Reservation-before-copy text still described the old post-copy insert.** Resolved by inserting
   the staged row (with `rel_path`, sniffed MIME, declared size) before the copy, verifying metadata
   after rename, and removing the orphan claim; crash-after-rename keeps a valid staged row.
6. **Destination symlink planting.** Resolved by safe `ensureAgentMediaRoot`/`.tmp` checks and
   `O_NOFOLLOW|O_CREAT|O_EXCL` temp opens; tests plant symlinks at both levels.
7. **A session-cleanup path was missed.** Resolved by calling `deleteSessionAgentMedia` from
   `#sweepNoticeOrphan` in addition to `removeLocalSessionRows`, pending recovery, and the sweep
   `#pass`; centralized where possible.
8. **Reserve-before-reading contradicted MIME sniff and `mime NOT NULL`.** Resolved by stating the
   invariant as "reserve after open/fstat/sniff and before the full copy"; D2/D3/tests aligned.

Non-blocking findings folded into revision 3: R9 staged rows have no session association; the
tool-omission vs `image_unavailable` choice is explicit; `show_image` input path redaction; the
symlink-swap acceptance now asserts the target is never read; nested stripping is scoped to tool
attachments; parent-directory symlink swap is recorded as residual risk; failure-code mapping is
explicit; `appRoot` vs `appDir` is defined; live missing rendering is defined; `<img @error>` handles
a later 404; `check:ui` is in the verification list.

Phase A remains independently shippable and passes as a phase.

### Round 3 - `oracle` - FAIL (seven blocking findings)

The third review accepted round-2 findings #2, #3, #4, and #8 but found the following. Revision 4
resolves them:

1. **The staged-state definition still described post-copy semantics.** Resolved: `staged` is now a
   reservation whose final file may be absent/temp-only and whose tool call may not have returned;
   R9/D2/D7 and plan owner decision 9 now say a staged row has no session association.
2. **The live synthetic part hardcoded `state:"sent"`.** Resolved: live and history use
   `attachment.state = view.state`; a live missing-state test is added.
3. **Final-size handling contradicted the cleanup rules.** Resolved: never update `size`; require
   `finalStat.size === reservedSize`; a mismatch deletes row/temp/final and returns
   `image_size_mismatch`.
4. **The verified-fd copy could start at offset 512.** Resolved: sniff with a positional
   `readSync`/`pread`, copy with `start: 0`, and specify fd ownership (`autoClose:false`, close in
   `finally`); byte-identity test for >512 bytes.
5. **Destination rename re-check was absent from the plan.** Resolved: re-validate
   `agent-media`/`.tmp` immediately before rename, prefer a dirfd-relative rename, and test a
   directory swap after admission.
6. **The daily-sweep call site was mislabeled `#pass`.** Resolved: name `#sweepOne` explicitly
   (called by `#pass`) and test the empty-session sweep.
7. **The rollback plan contradicted the schema guard.** Resolved: v21 is a one-way door; rollback
   requires restoring the pre-deploy DB backup with the old image; the backup/roll-forward order is
   an explicit deploy gate.

Non-blocking findings folded into revision 4: conflict check before missing; missing attach does
not re-stat; `AttachmentView` is the single view shape; active-copy set exported; startup vs daily
agent-media reconcile split; caption raw-vs-sanitized aligned; bounded envelope recursion; redaction
helper in the module list; `normalizeToolName` named; handler and MCP wiring choices fixed;
destination-symlink and `#sweepOne` tests added; bounded download stream; per-projector seen-set cap.

Phase A remains independently shippable and passes as a phase.

### Round 4 - `oracle` - FAIL (four blocking findings)

The fourth review confirmed round-3 items 1-7 are resolved and Phase A remains independently
shippable, but found four new plan-level blockers. Revision 5 resolves them:

1. **`createReadStream(null, ...)` is not valid Node/TypeScript.** Resolved: use
   `createReadStream("", { fd, start: 0, autoClose: false })` (the existing download-route pattern)
   or the positional read loop.
2. **`resolveSource` did not return the path/name that §4.6 uses.** Resolved: return
   `{fd, size, mime, sourcePath, displayName}`; set `original_name = displayName = safeName` and
   return `name: safeName`.
3. **The plan dropped the same-inode/size verification.** Resolved: `lstat` + `open(O_NOFOLLOW)` +
   `fstat` compare `dev`/`ino`/`size`; add a regular-file swap test.
4. **The legacy raw stream was wired by name only.** Resolved: scope the deprecated
   `streamSessionEvents`/`createRawEventStream` route to nested-data-URL stripping only, with no
   agent-media synthetic parts; the SPA uses the typed app stream.

Non-blocking findings folded into revision 5: `appStateRoot` source file corrected to
`src/attachments/paths.ts`; `image_size_mismatch` added to the failure-code list; cleanup helper
name unified; remaining "or" choices resolved; agent-media download URL built by the service view
(not the attachment URL); missing rows are attached by schema; the synthetic example labels the
attached case; `attachmentViewFromFilePart` explicitly forwards caption/origin.

Phase A remains independently shippable and passes as a phase.

### Round 5 - `oracle` - FAIL (three blocking findings)

The fifth review confirmed round-4 items 1, 2, and 4 are substantively fixed, but found three
remaining plan/schema problems. Revision 6 resolves them:

1. **The plan's executable schema dropped the association CHECKs.** Resolved: copy the design's
   `staged = all-null` and `attached|missing = all-non-null` CHECKs verbatim; add a defensive
   `missing` with any null association -> `unknown` branch and a test.
2. **The resolver described two opens.** Resolved: one sequence `resolveWithinRoot` -> `lstat` ->
   `open(O_NOFOLLOW)` -> `fstat` (`dev`/`ino`/`size`) -> positional 512-byte read on that fd ->
   `sniffMime` -> return `{fd,size,mime,sourcePath,displayName}`; no second open.
3. **Server projection imported the browser `normalizeToolName`.** Resolved: add a server-local
   `normalizeToolName` in `src/agent-media/projection.ts`; never import `assets/chat-core.js` into
   server code.

Non-blocking findings folded into revision 6: `reconcileAgentMedia` is called at the top of
`runAttachmentMaintenance` before both early returns; `state.attachmentsTruncated` is set; the
agent view is built by `AgentMediaService.view`, not `attachmentView`; Phase A lists the full gate
set; `pathMode` is explicit in `AgentMediaTarget`; `openAgentMediaSource` returns `{fd,size}`;
`reconcileAgentMedia` takes `{db,agentsHome,startup,activeIds,now}`; caption is optional.

Phase A remains independently shippable and passes as a phase.

### Round 6 - `oracle` - PASS

The sixth review returned PASS: the three round-5 blocking findings are substantively resolved
(plan schema matches the design, one verified-fd resolver sequence, server-local
`normalizeToolName`), no new blocking contradiction was introduced, and Phase A remains
independently shippable.

Non-blocking findings were folded into revision 6 before the plan review: the live step now
requires `state.status === "completed"`; conflict wording is limited to bound rows; the unbound
missing test is defensive-only; the active-copy set is unioned into the maintenance entry point;
the lock extraction wording points at the existing `src/chat/locks.ts`; the admission limiter has a
named home; `ConfigError` maps to a fixed `path_outside_app` message; R9 matches D7; the
symlink-escape wording is precise; path redaction is asserted on the full serialized tool part; and
Phase A is a phase of the single stage commit.

Status: **approved** - design review PASS (round 6). Implementation is gated only by the plan
review.
