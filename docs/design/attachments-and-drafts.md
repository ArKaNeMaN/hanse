# Design - Chat attachments and message drafts

Status: **approved** - design review PASS (`oracle`, round 16, 2026-10-25). Revision 17 is the
reviewed design. Non-gating follow-ups are listed in the round-16 section; owner defaults 5-7
(video preview, quota defaults, supervisor mode) must be confirmed before the plan. Implementation is
not permitted until the plan review passes.

Scope: file attachments in the chat workspace (images, video, PDF, and arbitrary files), durable
per-session attachment storage, inline-to-model delivery only when the selected model declares the
modality, file-only delivery with a model-readable path, server-side message drafts, eager session
creation on first input/attachment, and deletion of an empty draft session when the draft is cleared.

Out of scope: implementation in this document; audio input; image generation; video playback/Range
requests; IDE-side attachment browsing; multi-user ownership; object storage; per-connection draft
merge; transcription; OCR.

## 1. Problem

The chat is text-only. An operator who wants an agent to inspect a screenshot, a design, a PDF, a
dataset, or a log file must upload it through SSH or place it in the repository, then describe the
path. That is slow, leaves repository noise, and does not let the model actually see an image.

The operator also loses typed text when switching sessions or reloading. The current "new session"
is a client-only draft that disappears; a session is created only when the first message is sent
(`ensureSession`), so there is nothing durable to attach a draft to.

The owner wants:

- images, and video where the model definitely supports video input, delivered to the model as input;
- every other file stored in that session's folder, with a link/path in the request so the agent can
  use it through scripts and tools;
- a per-attachment choice for PDFs (send the file to the model vs keep it as a file), because some
  jobs need the raw file (for example, testing a parser);
- message drafts that survive reloads and session switches;
- a session created as soon as the operator types into an empty chat or attaches a file, without
  starting an agent turn;
- the session deleted again if the operator clears all text and all attachments, but never deleted
  when it already has message history.

## 2. Requirements

| ID | Requirement |
| --- | --- |
| A1 | The composer accepts multiple files from a picker, drag and drop, and clipboard images, except while a slash command is active (v1 restriction). |
| A2 | An image is delivered to the model as an image input only when the selected model declares `capabilities.input.image`; otherwise it is stored and linked as a file. |
| A3 | A video is delivered to the model only when the selected model declares `capabilities.input.video` and the file is within the inline cap; otherwise it is stored and linked. |
| A4 | Every attachment is stored durably per session and survives a coordinator restart, an app container restart, and an app image change. |
| A5 | Every stored attachment is readable by the agent through its normal tools/scripts at a stable absolute path. |
| A6 | PDF-like documents have a per-attachment delivery mode (`auto`, `inline`, `file`); arbitrary non-media files are always `file` mode. `file` never sends the bytes to the model, only the path. |
| A7 | Every attachment, including a file-only attachment, has a visible message card with a name and a download; images have a thumbnail. |
| A8 | The coordinator never forwards attachment base64 through **any** message-history or SSE payload: the app SSE, the legacy session SSE, and the history routes. The history/projected-response caps continue to hold; the app SSE frame cap is raised to 32 MiB by D5. |
| A9 | Attachment routes and draft routes are human-only; agent principals receive `403`. Path traversal, cross-app access, symlinks, and stored XSS are blocked. |
| A10 | Per-file, per-message, per-app, inline-byte, and concurrency limits bound disk and memory use. |
| A11 | Deleting a session deletes its attachments, deliveries, and draft; deleting an app or project already removes the app runtime root. |
| A12 | Existing text-only clients and routes remain compatible, except the legacy session SSE route becoming human-only, the blocking message response changing to `{messageID, userMessageID, info, parts}` (and a 32 KiB text cap), the draft/message body cap rising to 256 KiB, and the bundled IDE extension being updated to async + `limit=30` + the `attachments` merge, hiding the `attachment-manifest` marker and rendering file-only attachment cards (documented in D5/D9/D11). |
| A13 | A session with a draft and no messages is distinguishable in the sessions rail after reload. |
| A14 | The implementation is sequenced so drafts, file-only attachments, and inline media can ship and be verified as separate stages (see D11). |
| D1 | Draft text and draft attachments persist server-side per session. |
| D2 | Typing a non-empty message or choosing the first attachment in an empty chat creates the session immediately, without sending a prompt. |
| D3 | If a session has no messages and the draft becomes empty (no text, no attachments), the session is deleted. |
| D4 | If a session has messages, clearing the draft never deletes the session. |
| D5 | Drafts restore on reload and when switching back to a session. |
| D6 | Draft writes are debounced and flushed when the page is hidden or unloaded. |
| D7 | Auto-deletion is checked server-side and is race-safe against a concurrent send, upload, and draft write. |
| D8 | The sessions rail can distinguish a draft session from a session with history. |

### Quality-attribute scenarios

| ID | Scenario |
| --- | --- |
| Q1 | When a session contains ten 5 MiB images (the normalized history is far above 8 MiB), the paginated history route still returns a projected page below 1 MiB using the per-message fallback; the legacy full-history route may return `messages_too_large`. |
| Q2 | When a file-only attachment is sent, the agent can read it through `read` and `bash` within the same turn using the path in the message. |
| Q3 | When a draft session is cleared, the upstream session and its files are gone within 2 s; when the same request is made for a session with one message, the session is not deleted, and a concurrent send/upload never loses data. |
| Q4 | When an attachment ID belonging to another app is requested, the response is `404` and no bytes are returned. |
| Q5 | When the coordinator and app restart, stored attachments remain downloadable, pending deliveries reconcile, and the next prompt still resolves their paths. |
| Q6 | When concurrent uploads exceed the in-flight budget, the excess requests receive `429` with `Retry-After`; no partial files remain and the coordinator's heap does not exceed the streamed byte budget. |
| Q7 | When a message contains inline media within the 20 MiB inline cap (including an image when opencode's resizer is unavailable), every live part event stays below the 32 MiB frame cap; excess-budget connections get the skip warning, not a closed stream. |

## 3. Verified upstream facts

### 3.1 opencode 1.19.3 (tag `v1.19.3`, commit `e3c4eb2`)

- Prompt routes: `POST /session/{sessionID}/message` (blocking) and
  `POST /session/{sessionID}/prompt_async`. The async handler forks the prompt and returns `204`
  immediately; the user message may not be persisted yet when the response arrives.
- `GET /session/{sessionID}/message/{messageID}` returns one stored message with its parts. This is
  the confirmation/reconciliation read used by this design.
- The body is JSON with a `parts` array; `parts` is the only required field. `model`, `messageID`,
  `noReply`, `system`, `format`, and `variant` are optional. `messageID` is accepted by both routes.
- The v1 `Part` union contains `text`, `subtask`, `reasoning`, `file`, `tool`, `step-start`,
  `step-finish`, `snapshot`, `patch`, `agent`, `retry`, and `compaction`. **There is no `image` part
  type in 1.19.3.**
- `FilePartInput` is `{ id?, type: "file", mime: string, filename?: string, url: string,
  source? }`. The `id` must start with `prt`; a supplied id is preserved and is the part table's
  primary key, so it must be unique per attempt.
- Images are `FilePart` values whose `mime` starts with `image/`. `Image.normalize` requires a
  `data:` base64 URL; a non-data URL (including `http(s)`) fails. Defaults: auto-resize to
  `2000x2000`, max `5 MiB` of base64 payload, configurable through `attachment.image`.
- A `file:` URL is resolved by the opencode server: `fileURLToPath`, then the file is read. For
  `text/plain`, opencode invokes its Read tool (about 50 KiB / 2000 lines); for other binary types it
  reads the whole file and replaces the part with a `data:<mime>;base64,...` part before saving.
  The saved part keeps the supplied part id. Image normalization rewrites the URL again and keeps
  the id.
- A bare filesystem path is not a URL and fails `new URL(...)`.
- Video and PDF pass the schema as `FilePart` values. Capability gating uses
  `model.capabilities.input.{image,video,pdf}`; when the model does not support the modality,
  opencode replaces the part with an error text in the provider request. Video/PDF are not
  normalized, so their saved base64 equals the whole file.
- Capability data is available from `GET /config/providers` in the configured provider catalog:
  each model entry carries `capabilities.input.{text,audio,image,video,pdf}`,
  `capabilities.attachment`, and `limit.{context,input,output}`. The catalog also has a `default`
  provider/model map.
- There is **no upload endpoint**. The Files API is read-only (`GET /file`, `GET /file/content`,
  `GET /file/status`). Files must be inlined into the JSON prompt, either as a data URL or as a
  server-local `file:` URL.
- Inline media is **stored in the user message as base64 data URLs** (the `file:` URL is replaced
  before persistence; normalization rewrites the URL again). A 5 MiB image adds roughly 6.7 MiB of
  base64 to the message history. Video/PDF base64 is the full file size.

### 3.2 Hanse today

- `src/http/server.ts` reads every request body into a UTF-8 string before routing, with a default
  cap of 64 KiB (`MAX_BODY_BYTES`). Only `/api/skills` (4 MiB) and `/internal/mcp` (1 MiB) are
  exempt. There is no binary body path and no multipart parser.
- `src/http/chat.ts` caps async message text at 32 KiB; the blocking route has no per-message cap
  beyond the global 64 KiB body cap.
- `src/opencode/client.ts` reads a message list with an 8 MiB raw response cap
  (`MESSAGES_RESPONSE_MAX_BYTES`), returning `502 messages_too_large` above it. The cap applies to
  the raw upstream body **before** any parsing or projection.
- `src/opencode/events.ts` bounds every part string to 8 KiB (`MAX_PART_STRING_BYTES`) and a typed
  event to 256 KiB. The app stream parser also drops raw upstream frames above 8 MiB
  (`APP_STREAM_MAX_FRAME_BYTES`) **before** JSON parsing/projection.
- The app container mounts the per-app runtime root
  (`<hostAgents>/<projectId>/<appKey>`) at `/data/agents/<projectId>/<appKey>` read-write, and the
  app directory at `/data/workspace/<project>/<app>`. The coordinator mounts the agents root
  read-write at `/data/agents` and runs as uid 1000 in the Compose deployment; the app container
  also runs as uid 1000. The supported Compose invariant is `HANSE_AGENTS_HOME=/data/agents`.
- `src/opencode/policy.ts` starts `external_directory` with deny-all and allows trusted runtime
  roots (tool output, git cache, temp, skill roots). The app's attachments root is not trusted
  today. The policy overlay is built at launch and verified after start; a running agent keeps the
  old policy until restart.
- The chat client creates the upstream session only on send (`ensureSession`); "New session" is a
  client-only draft (`startDraft`, `sessionId = null`). Draft text exists only in the textarea.
- `DELETE /api/apps/:app/sessions/:sid` proxies opencode's session delete and then updates handoff
  bookkeeping. There is no empty-session check and no attachment cleanup.
- The legacy session SSE route (`/api/apps/:app/sessions/:sid/events`) is a raw upstream proxy; the
  app SSE route (`/api/apps/:app/events`) is projected and human-only.
- Migration v14 is the current schema head; v15 is the next version.
- The sessions list has no message count; the rail cannot distinguish an empty draft session from a
  session with history without local state.

## 4. Alternatives considered

| Alternative | Why not |
| --- | --- |
| **Do nothing**; users keep using SSH/IDE/repository files | Does not meet A2/A3 (the model cannot see an image), leaves repository noise, and does not give the agent a per-session folder. |
| **Inline every file as base64 in the prompt JSON** | The global body cap is 64 KiB; a 5 MiB image is already 6.7 MiB. It also buffers everything in the coordinator, has no durable file for scripts, and breaks the history caps. |
| **Store all files, send `file://` for every file** | Non-media binaries are not useful model inputs and can be rejected by the provider; text files hit opencode's Read cap; arbitrary binaries would be base64'd into the prompt and history. |
| **Store in the app directory (workspace)** | Visible in the IDE and directly readable, but pollutes the repository working tree, can be committed by accident, and is removed with source deletion. |
| **Store in coordinator state** | The app container does not mount it; the agent cannot read the files. |
| **Multipart upload (`busboy`)** | Adds a dependency and a parser for no functional gain; one raw-binary request per file is simpler, streams to a temp file, and keeps JSON routes unchanged. |
| **Client-side localStorage drafts** | Does not survive another device/browser, cannot own server-side draft attachments, and gets out of sync with an eagerly created session. |
| **Create a session on "New session" click** | Creates empty sessions for every click. The owner wants creation on first input/attachment. |
| **Projection after the existing 8 MiB reads** | The blocker found in round 1: the raw body/frame is rejected before projection. Revision 2 adds a bounded projected read path and a per-message fallback. |
| **Raise the raw history cap to hundreds of MiB and project in memory** | Unbounded coordinator memory and OOM risk; a session with many images grows without limit. The per-message fallback bounds each raw read. |
| **Always inline video/PDF** | The API does not guarantee the modality; without a capability check the model receives an error replacement or a provider failure. The owner asked for "only when it definitely supports it". |
| **Always inline PDF** | The owner explicitly wants a file mode for parser/testing jobs. A per-attachment choice covers both. |
| **One attachment row with one part id** | Cannot represent retries/unknown outcomes; a retry would overwrite the correlation and break projection. Revision 2 uses per-attempt delivery rows. |
| **Derive file-only cards from the manifest text only** | The feed cannot render a card/download from free text. Revision 2 projects a per-message attachment list from the DB. |

## 5. Decisions

### D1 - Store attachments in the per-app runtime root, read-only to the agent

Local (coordinator/host) path (use `resolveInstanceEnv`/`sanitizeAppKey`, not the raw app key):

```
<agentsHome>/<sanitize(projectId)>/<sanitize(appKey)>/attachments/<sessionId>/<attachmentId>-<safeName>
```

Model-visible path: a single `attachmentVisibleRoot(app)` resolver:

- **runner mode (Compose/Runner):** `/data/agents/<sanitize(projectId)>/<sanitize(appKey)>/attachments`
  (the app container bind-mounts `<hostAgents>/<sanitize(projectId)>/<sanitize(appKey)>` at
  `/data/agents/<sanitize(projectId)>/<sanitize(appKey)>`);
- **supervisor mode:** `<agentsHome>/<sanitize(projectId)>/<sanitize(appKey)>/attachments` (the
  coordinator and the agent process share the host filesystem).

`sanitize` is `src/opencode/instance.ts:sanitizeAppKey`; the resolver must reuse
`resolveInstanceEnv` or the same sanitizer, because the app directory basename may contain spaces or
non-ASCII.

The supported Compose invariant is `HANSE_AGENTS_HOME=/data/agents`; the runner's container root is
fixed. The resolver must not assume `resolveInstanceEnv` equals the container path; it derives the
mode from the manager's `hostPaths`/runtime configuration.

Why the agents root:

- it is already mounted into the app container and is excluded from the workspace, git, and the IDE;
- it survives container recreation, image rebuilds, and coordinator restarts;
- it is included in the existing `agents` backup;
- app/project deletion already removes the per-app agents directory;
- the coordinator already writes per-app auth/profile/skills files there, so write access and uid
  alignment are established.

The runner adds a **nested read-only bind** for the attachments directory:
`<hostAgentsRoot>/attachments:<containerAgentsRoot>/attachments:ro` (after the parent rw bind). The
agent can read the files but cannot modify or delete them; derived files go to the app directory or
`TMPDIR`. This makes the "sent attachment is immutable" invariant enforceable at the filesystem
level in **runner mode**. The coordinator keeps its rw view of the agents root. The mount marker is
part of the spec hash (like `appDirReadOnly`) so the container is recreated on the next explicit
restart. The
**coordinator** creates `<appRoot>/attachments` (uid 1000, mode 0700) in `#ensureLocked` next to the
existing app-root/HOME mkdirs; the runner only verifies the bind source exists and fails the create
with a clear error if it does not (the runner's host-agents mount is read-only). In supervisor mode
there is no container mount; the agent shares the host filesystem and the permission policy is the
only control (see §10.7).

The policy root is the **same** `attachmentVisibleRoot(app)` used for the manifest; it is passed
into `resolvePermissionPaths` as an explicit extra root (or a `resolvePermissionPaths` option) for
**both** the policy build and the verification call. The manager exposes its path mode and container
agents root to the route layer so the resolver has one stated source; do not derive the root from
`dirname(home)`. Because the overlay is applied at launch, a running agent needs a restart to allow
the `read` tool on the new root; the policy version is included in the settings hash so the existing
"Restart required" marker appears.

Trade-off: the IDE does not see these files. That is accepted; the operator can download them
through the chat.

### D2 - Streamed raw-binary upload, one file per request

`POST /api/apps/:app/attachments?project=<projectId>&session=<sessionId>` with the raw file bytes as
the body. No multipart parser is added.

- The filename is carried in a standard
  `Content-Disposition: attachment; filename*=UTF-8''<percent-encoded>` header, with a plain
  `filename="..."` fallback. The client's `Content-Type` is advisory; the server sniffs the signature
  from the first bytes.
- The upload route is special-cased before the generic `readBody`. It authenticates from the
  cookie/bearer **and** rejects a present cross-site `Origin` **before** the body is read, so an
  unauthenticated or cross-site client cannot make the coordinator write a large file.
- The session id is validated with a Hanse allowlist (`^ses_[A-Za-z0-9]+$`; upstream only requires
  `startsWith("ses")`) and is never used as a raw path segment. The session is checked upstream
  (`GET /session/{id}`) under the per-session lock before any row or folder is created. The path is
  built with `resolveWithinRoot` and the target folder is `lstat`-checked (no symlink).
- **Reserve before streaming.** Under the per-session lock, the route inserts an
  `app_attachments` row with a new id, `state='uploading'`, a `temp_rel_path`
  (`attachments/<sessionId>/.tmp/<id>.part`), and the declared size, then reserves quota under the
  per-app lock. If the session or quota check fails, no stream starts. Because the row exists for the
  whole stream, `delete-if-empty` and the sweep treat the session as non-empty (B-1 fix).
- The binary reader then streams the body to the reserved temp path, counting bytes and sniffing the
  MIME. It never buffers the whole file in the coordinator heap. The per-file cap and in-flight byte
  budget are enforced during the stream; `Content-Length` over the cap is rejected before reading.
  On abort/oversize, the row and temp are removed.
- **Final commit** (per-session lock): re-check the session; write the sniffed `mime`, actual
  `size`, `stored_name`, `rel_path`, and `kind` to the row **while it is still `uploading`**; fsync
  the temp; rename the temp to the final path; then set `state='available'` and clear
  `temp_rel_path` in the same transaction; fsync the session directory after the rename. If the
  session disappeared during the stream, remove the temp and the row and return `404 session_not_found`.
  On startup, an `uploading` row is promoted only when the **final** file exists and its commit
  metadata (`stored_name`, `rel_path`, `mime`, `size`) is non-null and matches `stat(final).size`.
  A **temp-only** row is removed with its temp; a partial stream-phase temp is never promoted. If
  the commit window is recovered, the temp may be renamed only when all four metadata fields are
  already written and `stat(temp).size === size`; otherwise remove it. The 15-minute rule applies
  only to the daily maintenance pass. The reconcile never trusts `declared_size` (a chunked upload
  reserves the per-file cap).
- The response is `201 {attachment: {...}}`; the body is small metadata, never the file.
- Uploading does not require a model or a running turn, but it uses the same `manager.ensure` path as
  the rest of the chat so the app is reachable and the session can be verified. An app that cannot
  start returns the existing lifecycle error.

### D3 - Metadata in the coordinator database

Five tables are added in migrations v15/v16; the physical DDL is owned by `database-engineer`.

`app_attachments` (file metadata; logical):

| Field | Meaning |
| --- | --- |
| `id` | Random URL-safe attachment id (primary key). |
| `app_id` | Owning app; `ON DELETE CASCADE`. |
| `session_id` | Upstream opencode session id (not an FK; sessions are upstream). |
| `original_name` | Display name, UTF-8, no path separators, single line. |
| `stored_name` | `<id>-<safeName>` on disk, total length capped to the filesystem limit; `NULL` until the commit phase. |
| `rel_path` | Path relative to the app attachments root; generated, never accepted from a client; `NULL` until the commit phase. |
| `temp_rel_path` | Reserved temp path for an `uploading` row; `NULL` afterwards. |
| `mime` | Sniffed MIME; `NULL` until the commit phase. |
| `size` | Actual bytes on disk; `NULL` until the commit phase (the reservation is in `declared_size`). |
| `declared_size` | Upload reservation; `NULL` for an `available` row. |
| `kind` | `image` (png/jpeg/gif/webp only), `video`, `pdf`, or `file`; `NULL` until the commit phase. |
| `mode` | `auto`, `inline`, or `file` (delivery choice; default `auto`). |
| `state` | File lifecycle: `uploading`, `available`, or `missing`. Draft/sent/in-flight is derived from deliveries, not stored here. |
| `created_at`, `updated_at` | ISO timestamps. |

`attachment_deliveries` (one row per send attempt and attachment; logical):

| Field | Meaning |
| --- | --- |
| `id` | Random URL-safe delivery id (primary key). |
| `attachment_id` | Owning attachment; `ON DELETE CASCADE`. |
| `app_id`, `session_id` | Denormalized for indexed lookup and deletion. |
| `part_id` | `prt...` id for an inline delivery; `NULL` for a file-only delivery. Unique when present. |
| `message_id` | The coordinator-generated upstream message id for this attempt. |
| `state` | `sending`, `sent`, `unknown`, or `failed`. |
| `error_code` | Bounded reason when failed/unknown; nullable. |
| `created_at`, `updated_at` | ISO timestamps. |

`pending_sends` (one row per in-flight send, including text-only; logical):

| Field | Meaning |
| --- | --- |
| `id` | Random URL-safe pending id (primary key). |
| `app_id`, `session_id` | Owning app/session. |
| `message_id` | Coordinator-generated upstream message id; unique. |
| `text` | The operator text that was dispatched (max 32 KiB), for durable restore. |
| `attachments_json` | The dispatched attachment refs `[{id, mode?}]`; `mode` is the per-send override and is replayed on retry. |
| `state` | `sending`, `unknown`, or `failed` (a confirmed send deletes the row). |
| `error_code` | Bounded reason when failed/unknown; nullable. |
| `created_at`, `updated_at` | ISO timestamps. |

`message_drafts` (logical):

| Field | Meaning |
| --- | --- |
| `app_id` | Owning app; `ON DELETE CASCADE`. |
| `session_id` | Upstream opencode session id. |
| `text` | Draft text (UTF-8, max 32 KiB). |
| `updated_at` | ISO timestamp. |

Primary key `(app_id, session_id)`.

`session_state` (logical):

| Field | Meaning |
| --- | --- |
| `app_id` | Owning app; `ON DELETE CASCADE`. |
| `session_id` | Upstream opencode session id. |
| `has_messages` | `0` for a Hanse-created empty session, `1` once a user message is confirmed or when a pre-existing session is first touched/upserted. A missing row means unknown (no `Draft` label). |
| `last_activity_at` | Updated on draft GET (only when the row exists), draft PUT, `touch`, upload commit, send dispatch, and confirmation; the sweep uses it. |
| `created_at`, `updated_at` | ISO timestamps. |

Primary key `(app_id, session_id)`. Sessions without a row (pre-existing history) are treated as
`has_messages = unknown`; on first PUT/touch they are upserted with `has_messages=1`, so they are
never labeled `Draft` and never auto-deleted (accepted conservative behavior).

Invariants:

- an attachment row always belongs to exactly one app and one session;
- `rel_path` is generated by the coordinator and is unique;
- `part_id` is unique per delivery; a retry creates a new delivery with a new part id and a new
  `message_id`;
- an `available` attachment with no non-failed delivery is a draft; any `sending`/`unknown`
  delivery makes it in flight; any `sent` delivery makes it sent; a `missing` row is excluded from
  prompts and quota;
- a `pending_sends` row is created for **every** send (text-only or with attachments) before the
  upstream call and is deleted only on confirmation; `failed`/`unknown` rows remain as recoverable
  content;
- `session_state.has_messages` is set to `1` only after a user message is observed upstream;
- `last_activity_at` is updated on draft GET/PUT, `touch`, upload commit, send dispatch, and
  confirmation, and is the sweep's age signal;
- the filesystem copy is read-only to the agent and is verified (size, MIME) on send and download;
- absence of a `message_drafts` row means an empty draft;
- deleting an app cascades all five tables; deleting a session removes its rows, deliveries,
  pending sends, state, draft, and folder in one app-level operation;
- no row stores a host path, a data URL, or file bytes.

**AttachmentView** (one shared shape for §6.1, the draft GET, history `info.hanse.attachments`, and the typed event): `{id, name, mime, size, kind, mode, state, downloadURL, inline}` where `state` is derived with precedence `missing > in_flight > sent > draft` and `inline` is the effective delivery at the last send (false for a fresh draft; the UI shows the current mode until a new resolution). `kind=image` is only png/jpeg/gif/webp; SVG/HTML map to `file`.

Indexes required by the plan: unique `deliveries(app_id, part_id)`; unique
`pending_sends(app_id, message_id)` (multiple pending rows per session are allowed);
`pending_sends(app_id, session_id, state)`; `deliveries(app_id, message_id)`;
`attachment_deliveries(app_id, attachment_id)`; `deliveries(app_id, session_id,
state)`; `attachments(app_id, session_id)`; `attachments(app_id, state)`; `UNIQUE
attachments(rel_path)`; `UNIQUE attachments(app_id, temp_rel_path) WHERE temp_rel_path IS NOT NULL`;
`session_state(app_id, has_messages, last_activity_at)`. `message_drafts` is keyed by its primary
key `(app_id, session_id)`; no extra index is required.

### D4 - Prompt assembly: capability-gated inline media, synthetic manifest, per-attachment mode

The coordinator resolves each attachment's effective delivery at send time, because the effective
model and its capabilities can change before the send.

| Kind | `auto` behavior | `inline` override | `file` override |
| --- | --- | --- | --- |
| image (png/jpeg/gif/webp) | inline only when `capabilities.input.image` **and** `capabilities.attachment` are true, size <= inline cap | same; otherwise warn and file | file |
| video | inline only when `capabilities.input.video` **and** `capabilities.attachment` are true, size <= inline cap | same; otherwise warn and file | file |
| pdf | inline only when `capabilities.input.pdf` **and** `capabilities.attachment` are true, size <= inline cap | same; otherwise warn and file | file |
| other | file | not offered (mode forced to file) | file |

- If `llm.model` is unset, the effective model is the manager's `DEFAULT_MODEL`/effective `llm.model`
  (the same value used at launch), not `/config/providers.default` (which is a per-provider map). If the catalog is unavailable, the send retries once; if it is
  still unknown, every inline mode falls back to `file` with a visible warning (A2/A3 require a
  confirmed capability).
- **Context fit (honest boundary).** Modality support is necessary but not sufficient, but the
  coordinator cannot tokenize a PDF/video. The resolver therefore uses modality + `attachment` +
  the per-file/inline caps as the gate, and emits a **non-blocking advisory**
  `attachment_context_large` when the inline base64 exceeds 50% of `limit.input * 4` (or 25% of
  `limit.context * 4` when `limit.input` is absent) for PDF/video, or when the summed image estimate
  (5,000 tokens each, at most 4) exceeds 20,000 tokens. It does not silently downgrade a size the
  owner chose to allow; if the
  provider rejects the context, the pending/retry path surfaces it. Images use a 5,000-token
  advisory estimate for the same warning; they are not blocked by it.
- Inline media is sent as a `FilePart` with a unique per-attempt id
  (`prt_att_<attachmentId>_<deliveryId>`), `mime`, `filename`, and a `file://` URL produced with
  `pathToFileURL` over the model-visible path. Opencode reads the file inside the app container and
  performs its own image normalization. The coordinator never base64-encodes the file into the JSON
  request.
- Every attachment, inline or file-only, is listed in a **separate synthetic text part** with
  `synthetic: true` and `metadata: { "hanse": "attachment-manifest" }`:

  ```
  Attached files (use these paths with your tools; "inline" files were also sent to you):
  - <model-visible-root>/attachments/ses_x/att_01-report.pdf (application/pdf, 2.1 MB, inline)
  - <model-visible-root>/attachments/ses_x/att_02-data.csv (text/csv, 40 KB, file)
  ```

  The model sees it; the chat client hides it (a `text` part with the `attachment-manifest` marker).
  The operator's own text remains a normal, visible text part. In supervisor mode the manifest
  contains the host agents path; that is runtime context only, never a tracked file.
- **Title safety (blocker fix).** `POST /api/apps/:app/sessions` accepts an optional bounded,
  sanitized `{title}` (single line, 1..120 chars, control chars removed). For **text-only**
  create-on-input the client omits `title` and lets opencode's own `ensureTitle` generate it from the
  first prompt; for an **attachment-first** session it passes the neutral `Attachment` title. For a
  pre-existing session whose title is still opencode's default (`New session - <ISO>`,
  `isDefaultTitle`), an attachment send calls `PATCH /session/{id} {title}` **before dispatch** and
  fails the send with `409 title_required` if that fails. There is no best-effort title update after
  the prompt. A default-looking operator title is prefixed. The manifest is `synthetic` but not
  `ignored`, and opencode's title generator includes synthetic text (`prompt.ts:200-240`;
  `message-v2.ts:216`), so hiding it in the Hanse feed is not the control.
- A message may have empty operator text if at least one attachment exists; the manifest plus the
  file parts are the remaining parts. A message with neither text nor attachments is rejected as
  before.
- The existing 32 KiB text cap applies to the operator text on both routes; the manifest has its own
  bounded size (at most the inline/file attachment limit, one line each, filenames sanitized).
- The manifest path is the **model-visible** container/host path, never the coordinator-local path.
- If a file is missing or its size no longer matches at send time, the send fails with
  `409 attachment_missing` before any prompt is dispatched; it never creates a partial prompt.
- If an inline image is rejected by opencode (unsupported codec, malformed data), the error path
  marks the pending/delivery (`turn_failed`/`unknown`) and returns the attachment to a retryable
  state. The operator can **redeliver the stored attachment with `mode=file`**: a new delivery
  (new part id) is created for a new message; the old message and its file part are unchanged. A
  `sent` attachment is never mutated in place.

### D5 - Projected read path: base64 never reaches the client

Opencode persists inline media as base64. Hanse must project it **before** the response/frame caps,
not after. Revision 4 keeps the revision-3 read strategy but bounds memory by bytes rather than by a
connection count.

#### History

- `listMessages`/`listMessagePage` accept a `MessageProjector` and return projected messages. The
  projector:
  - rewrites a file part whose `part_id` matches an `attachment_deliveries` row to
    `{type:"file", mime, filename, url: "<download-route>", attachment: {id, size, mode, kind}}`,
    dropping the data URL;
  - replaces **every** other file part with a `data:` URL (any length) with an empty URL and a
    truncated marker, so no base64 prefix reaches the client;
  - adds `info.hanse.attachments` for the message (all deliveries with this `message_id`), so
    file-only attachments have a card/download even though they have no file part.
- Raw-read strategy:
  1. try the requested page with a **48 MiB** raw cap;
  2. on `messages_too_large`, fall back to **single-message pages** (`limit=1`) with a **48 MiB**
     per-message cap, project each message, and accumulate the requested page;
  3. if a single message still exceeds 48 MiB, return `messages_too_large` for that page (the send
     path's 40 MiB base64 budget plus overhead makes this impossible for valid messages).
- The projected response is capped at the existing **8 MiB**; the browser uses the 30-message
  paginated route. The legacy full-history route uses the same reader and may return
  `messages_too_large` for a very large session; that is an accepted compatibility limit.
- A **heap-aware budget** admits history reads: a read reserves `cap * 4` (chunks, concatenation,
  decoded string, and parsed object; the current `readCapped` peak) from
  `HISTORY_READ_BUDGET_BYTES` (192 MiB equivalent). A per-read cap is 48 MiB, so one full 48 MiB
  read consumes the budget and smaller reads wait. A read waits up to 2 s for budget, then returns
  `503 history_busy`. The fallback loop has a
  wall-clock deadline and yields the budget between single-message reads. This is an explicit heap
  bound, not a connection count. If the **projected** paged response still exceeds 8 MiB, return
  `messages_too_large` for that page; the client shows its existing too-large notice.
- All internal callers (context monitor, dispatcher) use the same projected reader with a default
  projector that strips data URLs and the 48 MiB buffer/budget (not the old 8 MiB raw cap); they do
  not need attachment download metadata. This keeps their caps from regressing after media is added.
- The attachment resolver is backed by the DB (delivery by part id / message id) using the indexes
  in D3; no in-memory index is required for correctness.
- The **blocking** message route returns the **assistant** message (`lastAssistant`), not the user's
  attachment parts. It does not take a `HISTORY_READ_BUDGET_BYTES` reservation around the turn (that
  would block every history read for the turn's duration). After the turn it reads the final
  response with a dedicated single-flight slot (<=8 MiB raw, 32 MiB heap, counted in the 320 MiB
  ceiling; 8 MiB raw x 4 = 32 MiB heap) and returns
  `{messageID, userMessageID, info, parts: projectedParts}` (the projected assistant parts).
  On overflow it returns `{messageID, info: null, truncated: true}`; there is no 202 fallback before
  dispatch.

#### App SSE

- The app SSE projector accepts an attachment resolver before its string bounding (`boundPart`) and
  rewrites known file parts to the short download URL. For **every** unknown file part with a
  `data:` URL, it replaces the URL with an empty string and a truncated marker before bounding; the
  existing 8 KiB bound is not allowed to leave a `data:` prefix in the payload.
- **Frame-cap alignment:** the owner chose to raise `APP_STREAM_MAX_FRAME_BYTES` to **32 MiB**,
  and the inline budgets are set so a valid part's base64 fits under it: images and PDF/video are
  capped at **20 MiB raw** (<=26.7 MiB base64; images may normalize smaller, but the budget assumes
  the raw bound). A part event therefore never exceeds the raw frame cap before projection. Tests
  drive frames just below and above the cap.
- **Stream budget:** the app stream is bounded by a **process-global**
  `APP_STREAM_FRAME_BUDGET_BYTES` (32 MiB of in-flight **raw** frame bytes, charged at 3x => 96 MiB
  heap) and a per-app browser cap of 8 (`MAX_APP_STREAMS`). The context monitor and per-send
  fallback subscriptions are a separate internal class: they consume the byte budget but do not
  consume the 8 browser slots; there is one shared internal subscription per app, keyed by pending
  messageIDs, so concurrent sends do not multiply it. The legacy session SSE is client-facing and
  counts against the browser cap (D5.3).
  Admission is **per chunk/partial frame** inside the parser (not after a whole frame is buffered):
  a partial frame reserves its current bytes, the reservation is released after projection, and the
  process-wide sum must stay under the budget. A frame that would exceed it is **skipped for that
  connection** (`stream.warning`, and `message.part.omitted` when the part identity is salvageable)
  and the client hydrates the part from history; the stream stays open. A mid-frame skip can carry
  only the warning, so omitted-part identity is best-effort. The active sender's connection is identified by the
  `streamID`/`connectionID` registered by the send route (`streamID` in the message body or
  `X-Hanse-Stream` header) and is admitted first; an unknown/foreign/stale `streamID` grants no
  priority (never a 4xx). The **accounted read-budget ceiling** is **320 MiB** (192 MiB history +
  96 MiB app + 32 MiB blocking = 320); actual RSS can exceed it by the projected response/SSE
  buffers. A ninth **browser** stream for one app is refused with `429 stream_limit`; internal
  streams are not refused by the slot cap. The SSE parser must be chunk-efficient (a chunk list/
  rope, one byte-length accounting per push), not the current `this.buffer += text` plus
  `Buffer.byteLength` on every push.
- The typed `message.updated` event carries a top-level `attachments` array (resolved from
  `attachment_deliveries` by `message_id`), not a nested `info.hanse` field, because the existing
  typed event is flattened. The client maps it to `MessageRecord.attachments` (D7).

#### Legacy session SSE

- The raw `/api/apps/:app/sessions/:sid/events` proxy is routed through the same projector and
  attachment resolver, and requires a human principal. It preserves the raw opencode event envelope
  while projecting file parts (it does not switch to the typed app-event shape), counts against the
  per-app browser-stream cap (it is client-facing, not part of the internal monitor/fallback class),
  uses the same 32 MiB frame cap, and must not forward a `data:` URL. A test
  asserts no `data:` payload reaches this route. Agent clients that used this route get `403`; this
  is an intentional compatibility break documented in D9.

### D6 - Server-side drafts, eager session creation, and confirmation-based lifecycle

The state machine adds a real but empty session:

```
no-session  --first non-empty input or first attachment-->  empty-session (session_state.has_messages=0)
empty-session --user message confirmed--> active-session (has_messages=1)
empty-session --draft cleared + no messages--> no-session (session deleted)
active-session --draft cleared--> active-session (session kept, draft row deleted)
```

Rules:

1. **Create on first input/attachment.** The client shares one in-flight `ensureSession()` promise
   (the current implementation throws on a concurrent call; that guard is replaced). A debounced
   input handler (about 400 ms) and the first attachment both await it. After creation, the session
   id is reflected in the URL, the sessions rail, and the composer state; `session_state` is inserted
   with `has_messages=0` and `last_activity_at=now`. For a pre-existing session with no state row,
   the first PUT/touch upserts one with `has_messages=1` (never sweepable) after an upstream
   existence check; GET never checks upstream and never upserts. Only an
   upstream-missing session returns 404/410; PUT/touch still persist the draft and `last_activity_at`
   on 5xx/timeout/transport/unreachable (the sweep cannot run while the app is stopped) instead of
   losing text; only a definite upstream 404/410 rejects. Operations that need upstream state (send,
   delete-if-empty, upload final commit) return 503. If no session exists yet and `POST /sessions`
   fails, the draft is client-only until the debounce retries; no server draft exists. No prompt/turn
   is started. A draft that is
   still only a slash-command token (`/^\/(?!\/)\S*$/`) does not create a session or a persisted
   draft; a later argument (`/help x`) is treated as normal input. Attachments are not offered
   while the slash palette is active in v1.
2. **Draft write and touch.** The client PUTs `{text}` to the session draft route, debounced about
   500 ms, and flushes on `pagehide`/`visibilitychange` with a keepalive fetch when the payload is
   under the browser's ~64 KiB keepalive limit; larger drafts use the normal fetch while the page is
   alive (and accept the `pagehide` loss). Empty text removes the row. The route is human-only, rejects a cross-site `Origin`, takes the per-session lock, and
   updates `session_state.last_activity_at`. To close the unflushed-typing window before the 500 ms
   debounce, the client also sends a throttled `POST .../sessions/:sid/touch` on focus and on the
   first keystroke after a period of inactivity; touch updates only `last_activity_at`.
3. **Draft restore.** Selecting a session flushes the outgoing draft, then loads the target draft
   and its draft attachments. A `sending` pending row is shown as a read-only "Sending..." banner
   (its text is not written back into the composer); a `failed` pending row offers Restore/Retry;
   an `unknown` pending row offers "Retry anyway". The draft composer itself never repopulates
   already-dispatched text.
4. **Send (every send creates a pending row).** The title PATCH (when needed) runs **before** the
   pending-row insert and draft delete; a title failure leaves the draft/pending untouched and
   returns `409 title_required`. The message route takes the per-session lock,
   validates the draft attachment ids, creates one `pending_sends` row per send with the generated
   `messageID` and the sent text/attachment refs `[{id, mode?}]` (multiple pending rows per session
   are allowed; each confirms by its own `messageID`), creates the per-attachment
   `attachment_deliveries` rows, **deletes the draft row**, and calls opencode with that `messageID`
   on both routes. The composer is already cleared optimistically; the pending row is the durable
   record, so a reload cannot restore and resend the same text. It does not mark deliveries `sent`
   on the 202. On a definite pre-dispatch failure, the pending row and deliveries become `failed`
   and the client restores the draft from the pending row; on an unknown outcome they stay
   `unknown` with the same read-only banner.
5. **Confirmation (event-first, no full-base64 polling).** The coordinator's existing per-app event
   monitor observes `message.updated` for user messages. A send registers its `messageID`; when the
   monitor sees that user message (or a `message.part.updated` for it), the pending row is deleted,
   deliveries become `sent`, `session_state.has_messages=1`, and `last_activity_at` is updated. If
   the monitor is unavailable (context monitors disabled), the coordinator opens one short-lived
   app event subscription for the pending message; it does **not** poll the full message endpoint.
   The event monitor also sets `session_state.has_messages=1` for any user message on a known
   session, not only for rows in `pending_sends`, so an external client's message clears the rail's
   `Draft` label. On `session.error`, start the bounded recheck for **every** `sending` row in the
   session (or mark all of them `unknown` and recheck each); do not attribute the session-scoped
   error to one row. Mark the pending rows and their `message_id` deliveries `unknown` consistently;
   a later `message.updated`/part for a `messageID` always wins (delete pending, deliveries `sent`).
   Exclude intentional abort errors (`name === "MessageAbortedError"`, matching the client's
   `isIntentionalAbortEvent`) from this transition. A retry of an `unknown` row runs the
   recheck. A dispatch-time grace timer transitions a `sending` row with no monitor
   event to the bounded read schedule/`unknown`, so a silently dead monitor cannot leave it
   `sending` forever. On startup, a `sending` row older than the grace is transitioned to `unknown`
   in the DB; an explicit `armPendingConfirmation(appId)` call from `manager.ensure` success, the
   monitor start/resume, and coordinator startup starts the bounded schedule. `endpointFor` stays a
   pure getter.
   The fallback subscription is opened **before** dispatch whenever `monitorState(appId)` is not
   `connected` (disabled, disconnected, or still starting/connecting after `ensure`), so no event
   window is missed. For startup/crash recovery and any `unknown` row,
   the coordinator runs a **bounded backoff read schedule** of
   `GET /session/{sid}/message/{messageID}` (48 MiB cap): for example 0/2/5/10/20/30 s, then stop;
   it is not a 1 s polling loop. A definite 404 on the final attempt means the message was never
   persisted: mark the pending row **and its `attachment_deliveries`** `failed` (absent) and enable
   Retry. A 5xx/transport/timeout
   keeps it `unknown` and never `failed`, with "Retry anyway" as the explicit escape hatch. The
   confirmation read reserves `cap x 4` from `HISTORY_READ_BUDGET_BYTES`; on refusal it defers to the
   next attempt. Before "Retry anyway", the coordinator runs the same schedule once and, if the old
   message appears, confirms it instead of retrying. The **only** new-`messageID` paths are the
   explicit retry endpoint (definite 404, or `{force:true}` after persistent 5xx) and the user's
   explicit retry action; there is no automatic resend. A 404 also
   re-checks `GET /session/{sid}`: if the session is gone, clean local rows/files and return to
   `no-session` (no Retry). The client warns that a very late persistence could still duplicate. If
   the recheck ends in persistent 5xx/transport, the row stays `unknown` and the explicit action is
   still available. A retry dismisses the failed/unknown pending row. If the app is unavailable,
   confirmation defers until it is reachable (`endpointFor`); it never starts a stopped app.
6. **Clear.** When the text is empty, no attachments remain, and no pending send is
   `sending`/`unknown`/`failed`, the client calls `POST .../sessions/:sid/delete-if-empty`
   (debounced about 1 s). The server takes the per-session lock and uses the **shared lifecycle
   predicate**: block when any `uploading` row, draft attachment (`available` with no
   `sent`/`sending`/`unknown` delivery), in-flight attachment (any `sending`/`unknown` delivery), or
   `pending_sends` row exists; also block when `session_state.has_messages=1`. Then check the draft
   row is empty and the upstream message list is empty using `listMessagePage(limit=1)`; a
   `messages_too_large` from that check is treated as `has_messages` (never delete). Only then does
   it delete the session, its rows/deliveries/pending/draft/state, and its folder. If the session
   has messages, it returns `{deleted:false, reason:"has_messages"}` without a full history read. If
   the session is already gone upstream, it cleans local rows/files. The route resolves the
   endpoint with `endpointFor` and never calls `ensure`: clearing a draft must not start a stopped
   agent. If the app is not running, it returns `503 agent_unavailable` and the client retries on
   the next chat activity.
7. **Locks and order.** A per-session in-memory mutex covers only the short critical sections and
   is released before dispatch. `GET /draft` takes the lock but performs no upstream check and no
   upsert; it updates `last_activity_at` only when a state row already exists. Every other writer
   attempts the **upstream** re-check: a definite 404/410 rejects, while 5xx/timeout/transport
   persists. It serializes:
   pending/delivery insert, draft delete, state read/write, delete-if-empty, manual delete, draft
   GET/PUT, `touch`, attachment PATCH/DELETE, the sweep, and the upload row-insert/final commit. The
   lock is **released before the upstream prompt dispatch** and re-acquired for the sent/failed
   bookkeeping; it is not held across a blocking assistant turn. The `deleteSession` call and the
   `listMessagePage(limit=1)` emptiness check used under the lock are bounded with a short timeout.
   A per-app upload lock serializes quota accounting. The long upload stream is outside the session
   lock; the `uploading` row makes it visible to the delete/sweep predicates. Lock order is always
   **app ensure -> per-session -> per-app quota**; no path takes the quota lock before the session
   lock. After acquiring the session lock, every writer re-checks that the **upstream** session
   still exists and returns `404`/`410` instead of recreating state for a swept session; existing
   sessions without a state row are upserted, not rejected.
8. **Manual delete.** The existing `DELETE` route validates the path session id with the Hanse
  allowlist and builds the folder with `resolveWithinRoot` **before** the upstream call; it then
  deletes the session, and removes the session's deliveries, pending sends, attachment rows, folder,
  draft, and state. An upstream 404 is treated as already-deleted so local cleanup still runs; an
  invalid/escaping id is `400`/`404` with no upstream call and no local cleanup.
   The same validation applies to `delete-if-empty` and the sweep folder removal. A filesystem failure after a successful upstream
   delete is logged and repaired by the orphan sweep.
9. **Empty-draft sweep (owner decision).** A daily sweep deletes a session only when all of these
   hold: `session_state.has_messages=0`; no draft text; no attachments (including `uploading`
   rows); no `pending_sends` row; no `sending`/`unknown` delivery; `last_activity_at` older than
   **7 days**; and an upstream `listMessagePage(limit=1)` is empty using `endpointFor` (never
   `ensure`). The sweep runs only while the app is reachable, takes the per-session lock, skips apps
   with `deleting` markers, and skips any attachment temp path referenced by an `uploading` row.
   Immediately before the upstream delete it re-checks the empty message list **and** the last
   activity; a `messages_too_large` from the check is treated as `has_messages` (skip, never delete).
   Any queued `touch`/draft PUT re-checks the **upstream** session after acquiring the lock and
   returns 404/410 only when it is gone; a pre-existing session with no state row is upserted, not
   rejected. It is best-effort and idempotent. Sessions with any
   draft/pending/failed content are never swept. A cross-client text-only message protects the
   session only if it exists before the final check; the tiny check-to-delete window is an accepted
   residual race, documented rather than claimed away.
10. **"Not started" means no turn.** Creating a session does not call a prompt; the agent container
    may already be running because the chat page opens the app SSE route, but no model request starts
    until Send. If the agent is stopped, `POST /sessions` still ensures it, as today.

### D7 - UI

Composer:

- an attach button, a hidden multi-file input, drag/drop on the composer, and clipboard-image paste;
- attachment chips with name, size, kind icon, upload progress, remove, and a mode control
  (`Auto` / `Send to model` / `File only`) for image, video, and PDF; other files show `File only`
  as a static badge;
- Send is disabled while an upload is running and while the app is not reachable; a chip upload
  failure offers Retry/Remove and blocks Send until resolved;
- the composer remains editable while the agent is busy (existing behavior); drafts are per session;
- attachments are disabled while the slash palette/command is active in v1.

Message feed:

- an optimistic operator row shows local previews (object URLs for images) and the same cards;
- inline `file` parts render as attachment cards: an `<img>` thumbnail for png/jpeg/gif/webp
  through the download route, and a name/size/kind/download card otherwise;
- **client data path:** `MessageRecord` gains an `attachments` array. `buildSnapshotMessages`
  copies it from `info.hanse.attachments`; the typed `message.updated` handler (including the
  buffered pre-202 path) merges the event's top-level `attachments`; `rekeyOptimistic`/`applySnapshot`
  preserve it. File-only attachments render as a compact strip under the message parts; inline
  attachments already render from their projected `file` parts, so the strip filters to file-only and
  de-duplicates by attachment id. The user-feed visibility gate is `recordNeedsNode` →
  `recordHasVisiblePart`; `hasVisiblePart` in `chat-core` is assistant-only. `insertOptimisticMessage`
  stores the local attachments; `cloneMessage`, `mergeOptimisticRecord`, `buildSnapshotMessages`, and
  `applyBufferedEvent` preserve `attachments`; the `sendPrompt` empty-text guard allows empty text
  when attachments exist. History snapshots read `info.hanse.attachments`; the live typed event is
  flat (`attachments`); the client never reads a nested `info.hanse` on the typed event.
- A sent/inline file card offers `Send again as file`, which calls the send route with
  `{attachments:[{id, mode:'file'}]}` (or the retry endpoint) and shows the duplicate warning.
- On live `session.error`, the client marks only the **local** acceptance row (`serverID === null`)
  as failed; it does **not** mark server-backed rows (queued or active), which are resolved by
  `pendingSends`, and it refetches `GET /draft`. A later snapshot/confirmation clears any local
  failed marker.
- **visibility:** a record with a non-empty `attachments` array is a feed node even when every part
  is hidden. `recordNeedsNode`/`hasVisiblePart` treat attachments as content; `insertOptimisticMessage`
  accepts the local attachment list and stores it on the record. A file-only attachment-only message
  must render its strip; a file-only `kind=image` uses the same thumbnail.
- the synthetic `attachment-manifest` text part and opencode's extra synthetic `Called the Read
  tool...` text (added for `file:` inline parts) are hidden from the feed (marker-aware rule, not
  only the current `partIgnored` check);
- unknown/legacy file parts fall back to the existing collapsed `file` detail rendering;
- no data URL is ever placed in the DOM or in message history payloads.

Draft/rail:

- `session_state.has_messages=0` plus a draft (text or attachments) labels the session `Draft` in
  the rail and the active composer header, with a subtle dot;
- a session with messages keeps its upstream title and shows the dot only when a draft exists;
- **title:** a text-only create-on-input omits `title` so opencode's `ensureTitle` generates it; an
  attachment-first session sets the neutral `Attachment` title. A pre-existing default title is
  patched before an attachment send and the send fails `409 title_required` if the patch fails. The
  manifest is never the title source;
- switching sessions flushes the previous draft and restores the target;
- each recoverable `pendingSends` entry (failed/unknown) is shown as a restore/retry banner; "Retry" sends a
  new message with a new `messageID` only after the old attempt is `failed`, and "Dismiss" clears
  the pending row; "Retry anyway" is the explicit escape hatch for a long `unknown`;
- clearing the draft in a draft session returns to the `New session` empty state after the server
  confirms the delete;
- the empty state explains that the first message starts the agent.

Accessibility/mobile: keyboard-operable attach control, `aria-label`s, progress with `aria-valuenow`,
`prefers-reduced-motion` respected, and no horizontal overflow at 390 px. Image thumbnails stream
the original in v1; a resized thumbnail route is a later optimization (documented, not a blocker).

### D8 - Limits, quotas, and retention

Constants (not user settings in v1):

| Limit | Value | Behavior |
| --- | --- | --- |
| Per-file upload cap | 100 MiB (streamed) | `413 file_too_large`; temp removed |
| Image upload cap | 25 MiB upload; **20 MiB inline** | inline base64 <=26.7 MiB < 32 MiB frame; opencode normally normalizes to <=5 MiB |
| Inline image/PDF/video cap | 20 MiB raw | larger files fall back to `file` mode with a warning |
| Inline attachments per message | 4 | `400 too_many_inline_attachments` (no silent downgrade) |
| Inline base64 budget per message | **40 MiB, the binding constraint** | `409 inline_budget_exceeded`; user switches one to file |
| Attachments per message | 10 | `400 too_many_attachments` |
| Attachment bytes per message | 250 MiB | `400 message_attachments_too_large` |
| Per-app attachment quota | 5 GiB (sum of `available` rows; `missing` excluded) | warning at 80%; `507 attachment_quota_exceeded` at 100% |
| Draft text | 32 KiB UTF-8 | `400 draft_too_large` |
| Filename | 255 bytes original; stored name capped to the filesystem limit | `400 invalid_filename` |
| Upload concurrency per app | 2 | `429 upload_busy` + `Retry-After` |
| Global in-flight upload bytes | 256 MiB (streamed/disk, not heap) | `429 upload_busy` |
| History raw page/per-message cap | 48 MiB each | `messages_too_large` above; projected response <=8 MiB |
| History global read budget | 192 MiB equivalent (cap × 4) | heap-aware semaphore; wait up to 2 s, then `503 history_busy` |
| App SSE frame cap | 32 MiB | raised from 8 MiB to fit a 20 MiB inline PDF/video after base64 |
| App stream budget | 32 MiB raw (96 MiB heap) global + 8 browser streams per app | monitor/legacy/fallback are a separate internal class; excess frames skipped with `stream.warning` + `message.part.omitted`; 9th browser stream `429 stream_limit`; total heap ceiling 320 MiB (see D5) |
| Blocking response read | dedicated <=8 MiB raw (32 MiB heap at 4x), single-flight | counted in the 320 MiB ceiling; no history reservation around the turn; the projected response buffer is not included in the 320 read-budget ceiling (label it read-budget, not hard RSS) |
| Download | no Range in v1 | video/other files download fully; image thumbnails only |

**Inline budget arithmetic (binding).** The 20 MiB per-file cap is only reachable with few/non-PDF
attachments. Per-kind base64 estimate:

- PDF/video: `ceil(size / 3) * 4` bytes.
- image: `ceil(size / 3) * 4` (the raw base64 upper bound). Opencode *usually* normalizes to
  <=5 MiB, but the budget must assume the resizer can be unavailable or reconfigured, so it uses
  the raw bound.

Examples:

| Combination | Base64 | Result |
| --- | --- | --- |
| 1 x 20 MiB PDF + 1 x 5 MiB image | 26.67 + 6.67 = 33.34 MiB | valid (<=40) |
| 2 x 15 MiB PDFs | 40 MiB | valid (at the budget) |
| 2 x 20 MiB PDFs + 2 x 5 MiB images | 53.33 + 10 = 63.33 MiB | **invalid**, `409 inline_budget_exceeded` |

A valid message's base64 is <=40 MiB; with JSON/text/manifest overhead it stays under the 48 MiB
per-message read cap. Each part is <=26.67 MiB, under the 32 MiB frame cap.

Retention: sent and draft attachments live until their session is deleted; app/project deletion
removes the whole agents root. Orphan reconciliation at startup (and once a day):

- files under any session's `attachments/<session>/.tmp/` older than 1 hour are removed, **except**
  paths referenced by an `uploading` row;
- files without a DB row older than 24 hours under an app's attachments root are removed;
- rows whose file is missing are marked `missing` and excluded from prompts and quota;
- draft rows for sessions no longer present upstream are removed when the app is reachable (best
  effort; skipped while the app is stopped).

The 7-day empty-session sweep is in D6.9; it requires a last-activity timestamp, an upstream empty
check, no pending/draft/attachment content, and the per-session lock. A coordinator maintenance
timer (alongside the dispatcher, stopped with the process) runs the daily sweep/orphan pass and also
reconciles every `uploading` row at startup and older-than-15-minute rows on the daily pass
(**available** only if the final file exists and commit metadata matches; a temp-only row without
complete metadata/size match is removed with its temp; a complete commit-window temp may be renamed);
the daily pass skips any row in the in-memory active-upload set, while startup reconciles all rows. When the app is reachable, the orphan sweep also removes attachment/delivery/
pending/state rows and files for sessions absent from the upstream session list (best effort). If the
session-list read fails or is truncated (2 MiB cap), the pass aborts and retries later; it never
treats an unreadable list as an empty one. Before removing a candidate, the pass takes the
per-session lock, re-checks `GET /session/{id}`, and skips on 5xx/transport/any ambiguity; it only
removes rows older than the pass's list snapshot (using `updated_at` for `message_drafts`), passes an
explicit limit to the session list, and treats a full page as truncated (skip the pass).

Quota is recomputed from the DB inside the per-app upload lock, so two concurrent uploads cannot
both pass the last free space. `missing` rows do not consume quota; `uploading` rows reserve the
smaller of the declared size and the per-file cap. A chunked upload without `Content-Length`
reserves the per-file cap; the **actual** size is re-checked at commit under the app lock (a lying
`Content-Length` cannot exceed the quota).

The 32 KiB draft/message text plus JSON escaping can exceed the 64 KiB generic body cap and reach
~192 KiB in the worst case; the draft and message routes use a **256 KiB** body cap (or validate the
decoded text) so the documented `400` is reachable. The upload response/draft GET include a top-level
`quota: {percent}`; the UI warns at 80%.

Migrations: **v15** adds `message_drafts`, `session_state`, and `pending_sends` (Stage A); **v16**
adds `app_attachments` and `attachment_deliveries` (Stage B). Stage C adds no schema. If the stages
ship together, both migrations may be applied in one release; they remain separate files so Stage A
can ship alone.

### D9 - Security

| Threat | Mitigation |
| --- | --- |
| Path traversal via `session` or filenames | Session id checked against a Hanse allowlist (`^ses_[A-Za-z0-9]+$`; upstream only requires `startsWith("ses")`) and verified upstream; attachment ids and `rel_path` generated server-side; no client path is accepted; `resolveWithinRoot` and `lstat` before `mkdir`/write; download/prompt use the DB path only. |
| Cross-app access | Attachment/delivery lookup includes `app_id`; a foreign id returns `404`, not `403`. |
| Symlink/TOCTOU | Download opens with `O_NOFOLLOW`, checks the parent realpath containment, and verifies size; a mismatch is `missing`/`404`. The attachments directory is read-only to the agent in runner mode; in supervisor mode the agent is trusted and the files are writable (immutability is runner-only, owner question 7). |
| Stored XSS via SVG/HTML | SVG/HTML are always `file` mode, served as `attachment`, `X-Content-Type-Options: nosniff`; thumbnails are limited to png/jpeg/gif/webp; no inline HTML rendering. |
| CSRF | Human-only routes; a present cross-site `Origin` is rejected; the `hanse_token` cookie remains `SameSite=Strict`; one shared Origin check is used by all attachment/draft mutations. |
| Agent principal abuse | All attachment/draft/delete-if-empty/pending routes require a human principal; agent tokens get `403`; the legacy session SSE route is human-only. |
| Base64 leakage | History projector drops every file `data:` URL; app SSE and legacy SSE replace unknown `data:` URLs with empty/marker before bounding; the blocking send response is projected; tests assert no `data:` payload on history, app SSE, legacy SSE, and blocking responses. |
| Manifest title leak | The title is set **in the `POST /session` create call** (or a pre-dispatch `PATCH /session/{id}` for a pre-existing default title) from operator text or a neutral `Attachment` title; the send fails `409 title_required` if that update fails. A default-looking title is prefixed so `ensureTitle` cannot run later. A supervisor host path cannot reach the title because the manifest is never the title source. |
| Memory/disk exhaustion | Streamed upload to a temp file with a pre-stream `uploading` row; per-file cap; per-app upload concurrency; app quota; 192 MiB heap-aware history budget; 48 MiB read caps; 32 MiB raw (96 MiB heap) app-stream budget incl. monitor/legacy/fallback; 8 browser streams; large-frame skip; `ENOSPC` mapped to `507` with the temp removed; startup `uploading` reconciliation. |
| Secret leakage | No coordinator-local paths, data URLs, or file contents in logs/responses; filenames are not logged at info; the download route is not public; the manifest is hidden from the Hanse UI and kept out of the session title. |
| Header/manifest injection via filenames | Original names are NFC-normalized, control characters and CR/LF removed, capped, quoted in the manifest, and never placed raw into a response header; `filename*` is RFC 5987 encoded. |
| Prompt injection via file content | Accepted: the agent already reads untrusted repository files. The manifest labels attachments as data and does not execute them. |
| Delete/send/upload/sweep race | Per-session mutex for send, confirmation, delete-if-empty, manual delete, draft PUT, sweep, upload commit; per-app upload lock for quota; lock order `ensure -> session -> quota`; final session existence re-check after the stream; active-upload set for `.tmp` sweeps and the daily `uploading` reconcile. `.tmp` and unsent draft attachments are readable by the agent in runner mode (accepted: the agent is trusted with the operator's files); excluding `.tmp` is optional hardening. |
| Multi-tab draft deletion | Last write wins is the owner decision. Auto-delete re-checks the DB, pending sends, and upstream messages under the per-session lock; a tab that has typed but not flushed its draft can still lose that draft if another tab clears the session. Accepted residual risk. |
| Legacy SSE principal change | The legacy session SSE route becomes human-only; agent clients that used it get `403`. This is an intentional compatibility break (A12) and must be in the release note. |

### D10 - Failure semantics

| Failure | Behavior |
| --- | --- |
| Upload oversized / quota / busy | `413` / `507` / `429`; the chip shows the reason and remains removable; the temp file is removed. |
| Upload interrupted | Temp file removed; no row; the chip offers Retry. |
| Capability endpoint unavailable | The send retries once; if still unknown, inline modes fall back to `file` with a warning. |
| Inline image rejected by opencode (async) | The `202` has already returned; opencode emits `session.error`; every `sending` pending row in the session and its `message_id` deliveries become `unknown`; the bounded recheck resolves them (a definite 404 -> `failed`, a found message -> `sent`). A failed/unknown attachment can be redelivered with `mode=file` (new delivery/part; old message unchanged). |
| Attachment file missing at send | `409 attachment_missing`; no prompt dispatched; the row is marked `missing`. |
| Async prompt accepted (`204`) but not yet persisted | `pending_sends` stays `sending`; the event monitor confirms the user `messageID`; no full-base64 polling. |
| Confirmation reads a definite 404 on the final attempt | The pending row and its deliveries become `failed` (never persisted); auto-delete and the sweep stay blocked until dismissal; Retry is enabled with a new `messageID`. |
| Confirmation keeps failing with 5xx/transport/timeout | The pending row becomes `unknown` after the grace window; auto-delete and the sweep stay blocked; the client shows the read-only banner and an explicit "Retry anyway" (recheck; new `messageID` after user confirmation). |
| 5xx or transport failure after dispatch | `unknown`, never `failed`; the reconciler/event monitor may still confirm; no **automatic** retry (the explicit action is available). |
| Delivery confirmed | `pending_sends` deleted; deliveries `sent`; `session_state.has_messages=1`; `last_activity_at` updated; the card appears in history and live via the typed `attachments` field. |
| Send failed before dispatch | Pending and deliveries `failed`; attachments are drafts again; no message; the text/attachments are preserved in the pending row. |
| Clear while create/send/upload in flight | The clear request waits on the per-session lock and uses the shared predicate (uploading row, draft/in-flight attachment, pending send); it never deletes a session with a pending send, delivery, or upload. A queued touch/PUT re-checks the state row and returns 404/410 after a sweep. |
| Session already deleted upstream | Local rows/files/draft/state are cleaned; the client returns to `no-session`. |
| History page over the raw cap | Per-message fallback; if a single message is over 48 MiB, `messages_too_large` for that page. |
| History budget exhausted | Wait up to 2 s for budget, then `503 history_busy`; not an OOM. |
| SSE frame over 32 MiB / stream budget | The inline budgets prevent it for valid parts; an oversized legacy frame or excess-budget frame is skipped with `stream.warning` + `message.part.omitted` and recovers from history; the stream stays open. |
| Unknown `data:` URL in a file part | Replaced with an empty URL and a truncated marker on every history/SSE path; never forwarded. |
| Blocking send with a large inline file | The route reads the assistant response with a dedicated <=8 MiB slot counted in the 320 MiB ceiling and returns `{messageID, info, parts: projectedParts}`; on overflow it returns `{messageID, info:null, truncated:true}`. It never returns a user file part or data URL. |
| Empty-session sweep | Requires last activity >7 days, no draft/pending/attachments, an upstream empty check, and no active temp upload; otherwise skip. |
| Projection resolver unavailable | The default projector still strips data URLs; the message loads with a placeholder card/truncated part. |

### D11 - Delivery sequence

The stage is large; the implementation is split into three independently verifiable slices. The
design gate covers the whole, but each slice has its own plan phase and verification.

1. **Stage A - drafts and eager session lifecycle (text only).** Migration v15:
   `message_drafts`, `session_state` (with `last_activity_at`), `pending_sends`. Create-on-typing,
   shared ensure promise, pending send + event-based confirmation, durable draft/restore, the
   text-only `pendingSends` read-only/restore/dismiss banner, `POST .../pending/:id/retry` and
   `DELETE .../pending/:id`, delete-if-empty, 7-day sweep, rail `Draft` label, per-session locks.
   No attachments, no base64 projection. **This stage is independently shippable** because
   `pending_sends` covers text-only sends and the recovery endpoints prevent a failed/unknown row
   from blocking delete-if-empty/sweep; it fixes the data-loss class before media exists. Stage A's shared predicate uses only the
   text/pending clauses; the `uploading`/`app_attachments`/`attachment_deliveries` clauses are
   added in Stage B, and the Stage A retry/Dismiss endpoints guard or omit the delivery SQL.
2. **Stage B - attachments, file-only first.** Migration v16: `app_attachments`,
   `attachment_deliveries`. Upload/download, quota, session folder, model-visible path, synthetic
   manifest, file-only cards via `info.hanse.attachments`, deletion/cascade, read-only mount,
   policy root, title safety. Inline mode is disabled; every attachment is `file`. Stage B uses the
   existing history read plus the typed `attachments` field (no base64) for live file-only cards;
   the base64 projection/caps remain in Stage C.
3. **Stage C - inline media.** Capability gating for image/video/PDF, inline budgets, per-attempt
   deliveries/part ids, projected history/SSE, legacy session SSE projection, 32 MiB frame + stream
   budget, blocking response projection, unknown `data:` removal, frame-cap tests, and the bundled
   IDE extension update (async + `limit=30` + `attachments` merge + a bounded post-202 read/retry +
   hiding the manifest marker + file-only attachment cards). **Stage C's design-review checkpoint is
   the round-16 design review PASS**; the plan review covers its execution detail. The remaining risk
   lives here.

The A/B/C sequence is the owner decision. Migrations are separate (`v15`, `v16`) so Stage A can
ship alone; Stage C adds no schema.

## 6. Interfaces

All new attachment/draft routes accept the existing optional `?project=<projectId>` and are
human-only; the existing message-send route keeps its current principal rules (A12). The dispatcher
routes draft GET/PUT/touch and delete-if-empty **before** the generic `manager.ensure` block (or uses
`endpointFor` inside the route), so opening a stopped app is not a side effect of those routes. Errors use the
existing `{error, code}` shape with real status codes. Mutations reject a present cross-site
`Origin` through one shared helper.

### 6.0 `POST /api/apps/:app/sessions`

- Body `{title?: string}`; `title` is optional, single line, 1..120 chars, control characters
  removed. The client passes the first operator line or `Attachment`. If the client omits `title`,
  the server leaves it unset (opencode's own title generation remains for text-only sessions); an
  attachment send on a default-titled session performs the pre-dispatch patch below.
- The existing empty-body `{}` call remains valid; a later attachment send on a default-titled
  session performs a pre-dispatch `PATCH /session/{id} {title}` and fails `409 title_required` if
  that update fails.

### 6.1 `POST /api/apps/:app/attachments`

- Query: `project?`, `session` (required, validated upstream).
- Headers: `Content-Disposition` with `filename*` (and fallback `filename`); body is streamed raw
  bytes; `Content-Type` is advisory.
- `201`:

  ```json
  {
    "attachment": {
      "id": "att_...",
      "name": "design.png",
      "mime": "image/png",
      "size": 123456,
      "kind": "image",
      "mode": "auto",
      "state": "draft",
      "downloadURL": "/api/apps/<app>/attachments/att_...?project=<projectId>",
      "inline": false
    },
    "quota": { "percent": 42 }
  }
  ```

- Errors: `400 invalid_filename|empty_file|invalid_session`, `404 app_not_found`,
  `404 session_not_found`, `409 deletion_pending`, `413 file_too_large`, `429 upload_busy`,
  `507 attachment_quota_exceeded|attachment_storage_full`, `503 agent_unavailable`.

### 6.2 `PATCH /api/apps/:app/attachments/:id`

- Body `{mode: "auto"|"inline"|"file"}`; only an `available` attachment with no `sent`/`sending`/`unknown` delivery is mutable.
- `200` returns the attachment view; `400 invalid_mode|mode_not_supported`,
  `404 attachment_not_found`, `409 delivery_in_flight|attachment_sent|attachment_unknown`.

### 6.3 `DELETE /api/apps/:app/attachments/:id`

- Deletes an `available` attachment with no `sent`/`sending`/`unknown` delivery (and any failed
  deliveries) and its file; an attachment with a `sending`/`sent`/`unknown` delivery is `409`;
  an `uploading` attachment is `409 attachment_uploading` (upload cancellation is out of scope).
- `200 {deleted:true}`; `404` for a foreign/unknown id. The DELETE takes the per-session lock and
  rejects an in-flight delivery.

### 6.4 `GET /api/apps/:app/sessions/:sid/draft`

- `200 {text, attachments: [attachmentView...], pendingSends: [{id, messageID, text, attachmentIDs, state, updatedAt}], quota: {percent}, updatedAt: string|null}` for any well-formed session id; `404 app_not_found` only.
- The GET performs no upstream check and no upsert; it runs a conditional `UPDATE session_state SET last_activity_at` that affects a row only when it exists.
- Only draft attachments (`available` with no `sent`/`sending`/`unknown` delivery; failed
  deliveries allowed) are returned. The GET updates `session_state.last_activity_at` best-effort.
- Each `pendingSends` entry includes its text for `sending`, `failed`, and `unknown` states;
  `sending` is a read-only "Sending: ..." banner with resend disabled, `failed` offers Restore/
  Retry, and `unknown` offers "Retry anyway".
- Missing row = empty draft.
- Does not require the app to be running (metadata read only).

### 6.5 `PUT /api/apps/:app/sessions/:sid/draft`

- Body `{text: string}`; max 32 KiB; takes the per-session lock.
- `200 {text, updatedAt}`; empty text removes the row. PUT always persists; a definite upstream
  `404/410` returns that status, while 5xx/timeout/transport still persist and return 200.
- `400 draft_too_large|invalid_json`, `404 app_not_found|session_not_found`, `410 session_gone`.

### 6.6 `POST /api/apps/:app/sessions/:sid/delete-if-empty`

- Takes the per-session lock; resolves with `endpointFor` (never `ensure`).
- Deletes only if the draft is empty, no `uploading` row, no draft attachment (`available` with no
  `sent`/`sending`/`unknown` delivery), **no in-flight attachment (any `sending`/`unknown`
  delivery)**, no `pending_sends` row, `session_state.has_messages != 1`, and
  `listMessagePage(limit=1)` is empty (a `messages_too_large` check means `has_messages`).
- `200 {deleted:true, upstream:true|false}` or
  `200 {deleted:false, reason:"has_messages"|"has_draft"|"in_flight"|"uploading"|"pending"}`.
- `404 app_not_found`, `409 deletion_pending`, `503 agent_unavailable` (the client retries on the next chat activity).

### 6.6b `POST /api/apps/:app/sessions/:sid/touch`

- Human-only; updates `session_state.last_activity_at` (no other effect). Used by the client on
  focus and the first keystroke after inactivity to protect an unflushed draft from the sweep.
- `200 {touched:true}` for any well-formed session id. When the app is unavailable, touch still
  updates `last_activity_at` for an existing state row (no upstream check); with no state row it
  returns 200 without writing. A pre-existing session with no state row is upserted only when the
  app is reachable. `404` only on a definite upstream `404/410`, `404 app_not_found` otherwise.

### 6.6d `POST /api/apps/:app/sessions/:sid/pending/:pendingID/retry`

- Human-only. Lookup is `(app_id, session_id, pendingID)`; a foreign/unknown id is `404`.
- Snapshot the pending row under the per-session lock, **release the lock**, then run the bounded
  `GET /session/{sid}/message/{messageID}` schedule (up to 0/2/5/10/20/30 s). Do not hold the lock
  across the schedule. Re-acquire, re-read the row/messageID/state, then apply one transaction.
- `sending` is `409 pending_in_flight`; only `unknown`/`failed` rows are retryable. If the message is
  found: confirm it (`200 {retried:false, confirmed:true}`). If the schedule ends in a definite
  404: mark the old
  `attachment_deliveries` where `message_id = pending.message_id` and state in `sending`/`unknown`
  `failed`, delete the old pending row, create the new pending/deliveries and dispatch with a new
  `messageID` (`200 {retried:true, messageID}`). On a 404 re-check `GET /session/{sid}`; if the
  session is gone, clean local rows/files and return `404 session_not_found` (no dispatch). The
  retry replays the pending row's `attachments_json` including each `mode` override. If
  5xx/transport persists after the schedule: `409 still_unknown` unless the body has `{force:true}`
  and the re-read state is `unknown`, which dispatches with a new `messageID` and the duplicate-risk
  warning. In the force branch, the same transaction marks the old pending row's
  `attachment_deliveries` (`message_id = old messageID`, state in `sending`/`unknown`) `failed`
  before creating the new pending/deliveries; `sent` and other attempts are untouched. A `failed` row
  retries after one confirming read (no `force` needed).
- A request may return `202 {rechecking:true}` after a short in-request deadline; the rest of the
  schedule continues in the background and resolves the row.

### 6.6c `DELETE /api/apps/:app/sessions/:sid/pending/:pendingID`

- Human-only; takes the per-session lock.
- Dismisses the identified `failed`/`unknown` `pending_sends` row (the "Dismiss" action). A
  `sending` row is `409 pending_in_flight`; a foreign id or a row whose `session_id` differs is
  `404`. Lookup is `(app_id, session_id, pendingID)`; the delivery update is scoped by `app_id,
  session_id, message_id`. For an `unknown` row it runs the bounded recheck (outside the lock, then
  re-acquires): found -> `{dismissed:false, confirmed:true}`;
  definite 404 -> dismiss; 5xx/transport -> `409 still_unknown` unless `{force:true}`, with the
  duplicate warning. A `failed` row is rechecked before dismissal. On a 404 re-check `GET
  /session/{sid}` and clean local rows/files if gone. In the dismiss transaction, mark only
  `attachment_deliveries` where `message_id = pending.message_id` and state in `sending`/`unknown`
  as `failed`; never touch `sent` deliveries or another attempt's deliveries. A short request
  deadline returns `202 {rechecking:true}`; the rest of the schedule continues in the background.
- `200 {dismissed:true}`; `404` when no pending row exists.

### 6.7 `GET /api/apps/:app/attachments/:id`

- Human-only download; looks up `(app_id, id)`, streams the file from the app's attachments root.
- `Content-Type` from the stored sniffed MIME; `Content-Disposition: inline` only for png/jpeg/
  gif/webp (SVG/HTML are `attachment`),
  `attachment` otherwise; `X-Content-Type-Options: nosniff`; `Cache-Control: private, max-age=3600`.
- `404` for unknown/foreign/`missing`; no Range support in v1.

### 6.8 Message send body

`POST /api/apps/:app/sessions/:sid/messages?async=1` (and the blocking form):

```json
{ "text": "optional text", "attachments": [{ "id": "att_...", "mode": "auto" }, { "id": "att_..." }], "streamID": "optional app-SSE stream id" }
```

- `text` may be empty iff `attachments` is non-empty. `streamID` is optional; the server uses it to prioritize the sender's app SSE in the stream budget.
- Both routes generate a `messageID`, create a `pending_sends` row and per-attachment deliveries,
  pass the `messageID` to opencode, and apply the same 32 KiB text cap.
- The coordinator adds the synthetic manifest part and returns
  `202 {accepted, messageID, sessionID, warnings?}` (async) or
  `200 {messageID, userMessageID, info, parts: projectedParts, warnings?}` (blocking). `messageID` is
  the assistant message id; `userMessageID` is the generated user message id used for pending
  correlation. The async `202` keeps `messageID` = the generated **user** message id
  (`{accepted, messageID, sessionID}`), so existing clients and the optimistic rekey keep working.
  The projected assistant
  parts are included under the 8 MiB dedicated cap; on overflow the response is
  `{messageID, info:null, truncated:true}`. The blocking route never returns a user attachment
  part or a data URL. `warnings` reports inline-to-file downgrades
  (`attachment_inline_unsupported`, `attachment_inline_too_large`, `attachment_capability_unknown`,
  `attachment_context_large`).
- A draft attachment may omit `mode`; `mode` on a draft is treated as the per-delivery override and
  does not change the row's stored mode. The client never supplies parts or paths. The send lookup is `(app_id, session_id, attachment_id)`:
  an id from another session is `404 attachment_not_found` and creates no delivery. A draft
  attachment id may be sent normally; a **sent** attachment id is accepted only with an explicit
  `{mode}` override (redelivery), same session only. Redelivery creates
  a new delivery/part id for a new message and leaves the old message/history unchanged; PATCH
  remains draft-only. A sent id without `mode` is `409 attachment_sent`.
- `400 empty_message|too_many_attachments|too_many_inline_attachments|message_attachments_too_large|invalid_attachment_item`,
  `404 attachment_not_found`, `409 attachment_missing|attachment_sent|attachment_in_flight|attachment_uploading|title_required|inline_budget_exceeded`.
- A request without `attachments` is byte-for-byte compatible with today's `{text}` request.

### 6.9 Sessions list augmentation

`GET /api/apps/:app/sessions` keeps `{sessions}` and adds an optional per-session
`draft: {hasText, attachmentCount, emptyDraft, updatedAt}`. `emptyDraft` is true when
`session_state.has_messages=0` and a draft exists. Old clients ignore it. One query per table per
chunk of returned session ids (e.g. 500 ids per `IN` list, under SQLite's bound-parameter limit).
`attachmentCount` counts draft attachments (`available` with no `sent`/`sending`/`unknown` delivery;
`failed` deliveries allowed).

### 6.10 Prompt wire contract (opencode)

For a message with text `Look` and two attachments (one inline image, one file-only CSV), the
coordinator sends:

```json
{
  "messageID": "msg_...",
  "parts": [
    {
      "type": "text",
      "text": "Look"
    },
    {
      "type": "text",
      "synthetic": true,
      "metadata": { "hanse": "attachment-manifest" },
      "text": "Attached files (use these paths with your tools; \"inline\" files were also sent to you):\n- <model-visible-root>/attachments/ses_x/att_01-design.png (image/png, 120 KB, inline)\n- <model-visible-root>/attachments/ses_x/att_02-data.csv (text/csv, 40 KB, file)"
    },
    {
      "id": "prt_att_01_<deliveryId>",
      "type": "file",
      "mime": "image/png",
      "filename": "design.png",
      "url": "file://<model-visible-root>/attachments/ses_x/att_01-design.png"
    }
  ],
  "model": { "providerID": "provider", "modelID": "model" }
}
```

`messageID` and `model` are optional in opencode; Hanse supplies both. `file://` URLs are produced
with `pathToFileURL` (correct percent-encoding for spaces/non-ASCII).

## 7. Data model and migration

**v15 (Stage A):** `message_drafts`, `session_state` (with `last_activity_at`), `pending_sends`.
**v16 (Stage B):** `app_attachments`, `attachment_deliveries`. Stage C adds no schema. The DDL,
indexes, checks, and expand/contract details are deferred to `database-engineer`; the logical
constraints and required indexes are in D3. Migrations are forward-only and additive; no existing
table is rewritten. If the stages ship together, both migrations may be applied in one release, but
they remain separate files so Stage A can ship alone.

Deletion integration:

- `DELETE /api/apps/:app/sessions/:sid`: upstream delete, then delete pending sends, deliveries,
  attachment rows, draft, and session state, then remove the session folder; filesystem failure is
  logged and repaired by the sweep.
- App/project deletion: the existing flow removes the app agents directory; the DB rows cascade from
  `apps`. The file removal stays inside the existing deletion guard and does not run before the
  container/network/image cleanup succeeds.
- `message_drafts`, `session_state`, `pending_sends`, `app_attachments`, and
  `attachment_deliveries` are included in the deployment backup through `coordinator.db`; the files
  are included through the `agents` volume.
- Startup reconciliation settles every `uploading` row (`available` if the final file exists,
  otherwise remove the row and temp); the daily pass uses the 15-minute age and re-runs the pending-send confirmation
  for `sending`/`unknown` rows.

## 8. Client lifecycle details

- `ensureSession` becomes `ensureSessionShared`: one cached promise; send, input debounce, and the
  attachment picker all await it. A rejected promise is cleared so a later retry can create a
  session; the cache is also cleared on `startDraft`/session delete.
- `selectSession` flushes the outgoing draft before switching; it loads the target draft after the
  message tail so the composer does not flicker, and always restores the target's server draft.
- `startDraft` remains for "no session"; the first input in that state calls the shared ensure and
  then persists the draft. A slash-command-only token is excluded.
- Auto-delete is triggered by: text becomes empty + no chips (1 s debounce), last chip removed, and
  a pagehide flush that observes an empty draft. It is skipped while `acceptanceInFlight`,
  `acceptanceUnknown`, uploading, or a delivery is `sending`/`unknown`.
- The sessions rail signature includes `draft.hasText`/`attachmentCount`/`emptyDraft` so the
  dot/label updates without a full message reload.
- The composer keeps its existing "queue while busy" behavior; attachment uploads are independent of
  the agent turn.
- On live `session.error`, the client marks only the **local** acceptance row (`serverID === null`)
  as failed; it does **not** mark server-backed rows (queued or active), which are resolved by
  `pendingSends`, and it refetches `GET /draft`. A later snapshot/confirmation clears any local
  failed marker. History
  snapshots read `info.hanse.attachments`; the live typed `message.updated` event uses its top-level
  `attachments`; the client never reads a nested `info.hanse` on the typed event. The
  `pendingSend` banner layers on the existing `acceptanceInFlight`/`acceptanceUnknown` recovery UI;
  it replaces the text-restore path, not the composer's acceptance state. A chip whose upload is
  still `uploading` cannot be removed until it lands (the server returns `409`).
- The draft row is deleted at dispatch; a reload during a send shows a read-only "Sending..."
  banner from `pending_sends`, never the sent text in the composer. A `failed` send restores from the
  pending row; an `unknown` send offers "Retry anyway". "Dismiss" clears the pending row; "Retry" is
  enabled only for `failed`.
- The session title is chosen at create from the first operator line or `Attachment`; a pre-existing
  default title is patched before an attachment send and the send fails `409 title_required` if the
  patch fails.

## 9. Testing

- Unit: stored-name sanitization/length; MIME sniffing; mode resolver matrix (image/video/pdf ×
  true/false/unknown × size × attachment capability × context fit); manifest/part builder;
  per-attempt part ids; inline budget arithmetic (33.34 valid, 40 at budget, 63.33 rejected, 40.01 -> 409);
  projection of known inline parts, file-only `info.hanse.attachments`, and unknown large data URLs
  (empty URL, no `data:`); raw-read fallback (page over 48 MiB -> single-message pages); heap-aware
  history budget; app-stream budget; quota sum excluding missing; draft/pending/delivery state
  machine; the exact predicates (available + no sent/sending/unknown = draft; failed allowed;
  sending/unknown = in-flight; sent = sent); delete-if-empty conditions; session-id validation;
  title selection at creation; context advisory.
- HTTP: upload auth before body/Origin/`413`/`429`/`507`; pre-stream `uploading` row + startup
  reconcile; streamed temp cleanup; cross-app download `404`; session-id traversal; draft CRUD/cap/
  lock; draft GET `pendingSends`; delete-if-empty with/without messages, with `sending`/`failed`
  pending sends, with a `sending` delivery and no pending row, and with a concurrent upload/sweep;
  pending dismiss; send with empty text, invalid/foreign/missing attachments, capability downgrade
  warnings, `attachment_context_large`, and the legacy `{text}` body; both routes carry a messageID;
  the blocking response is projected (no data URL, under the response cap); a pre-existing
  default title + attachment send (patch success/failure).
- Confirmation: async text 202 before persistence then event `message.updated` confirms; async
  attachment 202; a schedule that ends without a definite answer -> `unknown` (not `failed`); 5xx/transport -> `unknown`;
  a blocking 500-after-save -> immediate `unknown` that a later `message.updated` may confirm; a message persisting after the backoff schedule; a
  definite 404 on the final attempt -> `failed` (not `unknown`); a retry
  re-reads the old `messageID` and does not duplicate on a definite 404; monitor-disabled/
  disconnected opens the fallback subscription before dispatch; startup/crash recovery uses the
  bounded backoff schedule (not a 1 s loop).
- Retry/Dismiss: retry `sending` -> 409; retry definite 404 -> new messageID + old deliveries failed;
  retry persistent 5xx -> 409 still_unknown / `{force:true}` -> dispatch; the force branch marks old
  deliveries failed and leaves `sent`/other attempts untouched; Dismiss unknown found -> confirmed;
  Dismiss 5xx -> 409; Dismiss never marks `sent`/another attempt's deliveries.
- Client: empty-text attachment-only optimistic + reload renders the file-only strip; per-route
  `%2F`/`..`/absolute/symlink session-id traversal is rejected before upstream/local cleanup;
  startup partial-temp is removed; final file + matching commit metadata is available.
- `session.error`: multi-pending session -> all sending rows rechecked/unknown; later
  `message.updated` wins; intentional abort does not fail the pending row; startup `sending` ->
  unknown + arm on `ensure`.
- Redelivery: a sent attachment id without `mode` -> 409; with `mode=file` -> new delivery/part, old
  message/history unchanged.
- Sweep: 7-day last-activity check; cross-client text-only message before/after the check; crash
  before confirmation; unflushed draft + touch; active slow upload (temp not removed); app stopped
  (`endpointFor`, no `ensure`); deletion marker; `messages_too_large` skip.
- Client: attach/paste/drop, progress/retry/remove, mode control, upload-blocked send, optimistic
  cards, inline thumbnail, file-only strip via `record.attachments`, snapshot/live/buffered merge
  and de-dupe, hidden manifest, reload-during-send shows only the read-only `pendingSends` banners,
  draft restore from `failed`, create-on-first-input, clear-deletes vs history-keeps, rail `Draft`
  label, title safety in supervisor mode, eight-tab large-frame skip.
- Integration: a fake opencode server asserts the exact `parts` JSON (user text, synthetic manifest,
  `prt` ids, `file://` paths, model), capability gating, the event-based confirmation, and the
  projected blocking response; a fake >48 MiB history proves the fallback; a fake SSE frame at
  31.9/32.1 MiB and an eight-tab budget test prove the skip behavior; the attachment view is
  identical across upload, draft, history, and typed event.
- Browser QA: `docs/design/attachments-qa.mjs` with deterministic fixtures at 390/1440 and
  dark/light: inline image, PDF file mode, capability fallback, file-only card, large history
  hydration, draft restore from a failed send, clear-deletes, existing-session clear.
- Live smoke: a real app with a vision model receives an image and describes it; a PDF is sent
  inline and as file-only; a CSV path is read by `bash`; reload does not hit `messages_too_large`;
  a coordinator restart reconciles a pending delivery and keeps downloads working; a text-only
  async send followed by a reload/other-tab clear does not lose the session.
- Gates: `npm run lint`, `npm run typecheck`, `npm test`, `npm run build`,
  `npm run check:sensitive`.

## 10. Owner decisions and remaining questions

Resolved by the owner on 2026-10-25:

1. **Stage sequencing:** A/B/C in order (drafts -> file-only attachments -> inline media).
2. **Inline PDF/video cap:** raise the app SSE frame cap (now 32 MiB) and allow up to 20 MiB raw
   inline PDF/video, rather than the 4 MiB conservative cap.
3. **Multi-tab drafts:** last write wins is accepted for v1.
4. **Abandoned empty sessions:** daily sweep of empty, content-free, Hanse-created sessions older
   than 7 days.

Resolved by the owner on 2026-10-25:

5. **Video preview:** download only; no Range/player in v1.
6. **Quota defaults:** keep 5 GiB per app, 100 MiB per file, 20 MiB inline PDF/video, 4 inline
   attachments per message, 40 MiB inline base64 per message.
7. **Supervisor mode:** runner-first, supervisor best-effort; the model-visible manifest may contain a
   host agents path (hidden from the UI) and immutability is weaker there.

No owner question remains open.

## 11. Review

### Round 1 (`oracle`, 2026-10-25): CHANGES REQUESTED

Addressed across revisions 2-4:

- **B1 (history projection after the 8 MiB cap).** D5 uses a projected reader with a 48 MiB page/per-
  message fallback, a 192 MiB-equivalent heap budget, and an 8 MiB projected response; all internal callers use
  the projected reader.
- **B2 (SSE projection after the frame cap).** D5 raises the app SSE frame cap to 32 MiB and aligns
  inline budgets: images normalize to <=5 MiB base64; PDF/video inline <=20 MiB raw
  (<=26.7 MiB base64). Tests drive frames below/above the cap.
- **B3 (wrong visible paths).** D1 defines `attachmentVisibleRoot(app)` for runner and supervisor
  modes; all examples use the full `<project>/<app>` path; §3.2 states the actual mount.
- **B4 (session id as a path segment).** D2 validates a Hanse allowlist and checks the session
  exists under the lock; path building uses containment checks.
- **B5 (async accepted before persistence).** D3 adds `pending_sends`; D6.4-D6.6 keep a pending row
  for every send (text or attachment) until event-based confirmation; delete-if-empty and the sweep
  block on it.
- **B6 (one row cannot represent retries).** D3 adds `attachment_deliveries` with a unique
  per-attempt part id and message id; retries create new rows and both project correctly.
- **B7 (file-only cards and rail label).** D5 adds `info.hanse.attachments` and a typed top-level
  `attachments` field; D7 adds `MessageRecord.attachments` and the snapshot/live merge; D3 adds
  `session_state` for the rail.
- **B8 (raw session SSE bypass).** D5 projects the legacy session SSE route and makes it human-only.
- **M1 (policy build/verify/restart).** D1 derives the trusted root from `home` for both calls and
  includes a policy version in the restart hash.
- **M2 (upload/draft races).** D6.7 adds per-session locks (including confirmation and sweep) and
  the upload final-commit rule; D8 adds the orphan sweep and active-upload set.
- **M3 (inline budgets).** D8 defines the 40 MiB binding budget and the per-kind estimator.
- **M4 (immutability).** D1 adds a nested read-only attachments bind; D9 verifies size on download.
- **M5 (100 MiB heap buffer).** D2 streams to a temp file; D8's budget is disk/streamed, not heap.
- **M6 (reconciliation).** D6.5 uses event-based confirmation; §6.8 supplies a messageID on both
  routes; the blocking response is projected.
- **M7 (manifest display/path).** D4 sends a separate synthetic manifest part; D4/D7 set the title
  from operator text so the manifest cannot become the title.
- **M8 (attachment capability/default model).** D4 requires `capabilities.attachment` plus the
  modality and resolves `/config/providers.default`.
- **M9 (missing tests).** §9 adds cap, race, pending, sweep, confirmation, merge, title, and
  blocking-response tests.

### Round 2 (`oracle`, 2026-10-25): CHANGES REQUESTED

Resolved in revision 4:

- **N1 (text-only 202 data loss).** `pending_sends` is created for every send before dispatch; the
  server draft/pending row is the durable record; delete-if-empty and the sweep block on it.
- **N2 (full-base64 confirmation polling).** Confirmation is event-first via the per-app event
  monitor (or one short-lived subscription); at most one bounded 48 MiB per-message read is used for
  startup/crash recovery; 5xx/transport is `unknown`, never `failed`.
- **N3 (sweep content deletion).** The sweep requires `last_activity_at` older than 7 days, no
  draft/pending/attachments, no in-flight delivery, an upstream empty `limit=1` check via
  `endpointFor`, and skips active temp uploads.
- **M-A (history memory).** 48 MiB read caps + a 192 MiB-equivalent heap budget replace the
  connection-count semaphore; the fallback has a deadline.
- **M-B (SSE frame cost).** 32 MiB frame + 8-stream/128 MiB per-app budget; the parser must be
  chunk-efficient.
- **M-C (client merge).** `MessageRecord.attachments`, snapshot copy, live merge, de-dupe; the
  typed event carries a top-level `attachments` field.
- **M-D (manifest title leak).** Hanse sets the title from operator text/neutral; the manifest is
  not a UI or title value.
- **M-E (unknown data URL).** Every unknown file `data:` URL is replaced with an empty URL and a
  marker before history/SSE bounding.
- **M-F (blocking response base64).** The blocking response is projected or reduced to
  `{messageID, info}`.
- **M-G (definitive absence/retry).** Retry uses a new `messageID`; unknown sends are not retried
  automatically; "Retry anyway" is explicit.
- **M-H (lock order).** Confirmation and sweep are under the per-session lock; order is
  `ensure -> session -> quota`.
- **M-I (budget arithmetic).** D8 states the 40 MiB budget is binding and defines the per-kind
  estimator; the 63.33 MiB combination is invalid.
- **M-J (Stage C gate).** D11 requires a Stage C design-review checkpoint.

### Round 3 (`oracle`, 2026-10-25): CHANGES REQUESTED

Resolved in revision 5:

- **Title safety (blocker).** The title is set in the `POST /session` create call from the first
  operator line or a neutral `Attachment` title; a default-looking title is prefixed so
  `ensureTitle` cannot run later. The best-effort title update is removed.
- **Lifecycle predicates (blocker).** D2/§6.1 use `available`; §6.4 returns draft attachments
  (`available` with no `sent`/`sending`/`unknown`; failed allowed); §6.6 blocks on any draft or
  in-flight attachment; PATCH/DELETE use the same predicate.
- **Sweep races (major).** A throttled `POST .../touch` covers unflushed typing; the sweep re-checks
  last activity and upstream emptiness immediately before delete; `messages_too_large` is
  `has_messages`; the residual check-to-delete window is documented.
- **Retry/recovery (major).** The fallback subscription opens before dispatch; one bounded
  per-message read is mandatory for `unknown`/startup; "Retry anyway" re-reads the old `messageID`
  before creating a new one.
- **Heap budgets (major).** History reserves `cap × 3` from a 192 MiB-equivalent budget; the app
  stream budget includes the context monitor; `history_busy` waits up to 2 s then 503; the blocking
  upstream read uses the 48 MiB cap; tests cover RSS.
- **Model-context fit (major).** The inline resolver emits a non-blocking
  `attachment_context_large` advisory when `limit.input` is known; it does not silently downgrade a
  size the owner chose to allow.
- **Tests (major).** §9 adds lifecycle predicates, title-at-creation, unflushed typing, external
  message, retry recheck, heap/RSS, model-context, blocking cap, buffered-event merge, and upload
  crash recovery.
- Minors: `uploading` startup reconciliation; `sending` pending text read-only; buffered-event
  `attachments` merge; thumbnail note; chunked upload reservation.

### Round 4 (`oracle`, 2026-10-25): CHANGES REQUESTED

Resolved in revision 6:

- **In-flight upload lifecycle (blocker).** The `uploading` row (with `temp_rel_path` and
  `declared_size`) is inserted **before** the stream under the per-session lock; quota is reserved
  from it; delete-if-empty and the sweep block on it; startup reconciles from the temp path.
- **§6.6 predicate (blocker).** One shared predicate blocks on `uploading`, draft (available with no
  sent/sending/unknown), in-flight (any sending/unknown), and pending; §6.4/§6.6/PATCH/DELETE/
  quota/sweep use it.
- **Title residual (major).** `POST /sessions` accepts a bounded title; a pre-existing default title
  is patched before an attachment send and the send fails `409 title_required` if the patch fails;
  no best-effort update remains.
- **Retry snapshot (major).** A bounded backoff read schedule (0/2/5/10/20/30s) replaces the single
  snapshot; only a definite 404 on the last attempt allows a new `messageID`; 5xx/transport keeps
  `unknown`; "Retry anyway" rechecks and warns about a late persist.
- **Draft reload (major).** The draft row is deleted at dispatch; a reload shows a read-only
  `pendingSends` banner; failed sends restore from the pending row; no resend of sent text.
- **Sweep locks (major).** `touch`/draft GET/PUT/PATCH/DELETE are under the per-session lock and
  re-check the state row after the sweep; queued writers get 404/410.
- **Context fit (major).** The `base64/4` gate is replaced with a non-blocking
  `attachment_context_large` advisory; the owner's 20 MiB inline choice remains reachable.
- **PATCH/DELETE lock + quota (major).** Both are under the per-session lock; the upload row exists
  before the stream, so quota is reserved and a send cannot race a delete.
- **Stream budget (major).** Large frames are skipped per connection (`stream.warning` +
  `message.part.omitted`) instead of closing the stream; the budget includes monitor, legacy, and
  fallback; the sender is prioritized.
- **Minors:** `AttachmentView` shared shape; `pendingSend` read-only; §9 predicate wording; §6.3
  `unknown`; `attachment_context_large`; temp path aligned; external `has_messages`; unique indexes;
  Hanse allowlist wording; manual-delete 404 cleanup; supervisor immutability limitation; 192 MiB
  review text; title cap.

### Round 5 (`oracle`, 2026-10-25): CHANGES REQUESTED (no blockers)

Resolved in revision 7:

- **M-1 pre-existing state row.** D6.1/D6.7 upsert `session_state` for an existing upstream session
  on first draft GET/PUT/touch; only an upstream-missing session returns 404/410. GET/PUT/touch are
  exempt from the state-row existence rule.
- **M-2 context table.** Removed "context estimate fits" from the D4 decision table; the gate is
  modality + `capabilities.attachment` + per-file caps; the estimate is only the non-blocking
  `attachment_context_large` advisory.
- **M-3 commit order.** D2 renames the temp first, then updates the row in one transaction; the
  startup reconcile branch is live; a vanished row unlinks the temp and returns 409.
- **M-4 retry labels.** A definite 404 on the final attempt marks `failed` (absent) and enables
  Retry; 5xx/transport/timeout stays `unknown` with "Retry anyway".
- **M-5 lock scope.** The per-session lock covers only the short pending/delivery/draft/state
  critical sections; it is released before the upstream prompt dispatch and re-acquired for
  bookkeeping. `deleteSession` and the `limit=1` emptiness check are bounded.
- **M-6 stream admission.** Per-frame in-flight accounting, release after projection, 8-stream/128
  MiB cap, sender priority via the registered stream id, skip-not-close, 320 MiB combined ceiling.
- **M-7 image bound.** Inline images are capped at 20 MiB raw (<=26.7 MiB base64), so Q7 holds even
  if the resizer is unavailable; the 25 MiB upload cap remains for file-only images.
- **Minors:** one `AttachmentView` shape in §6.1; `pendingSend` contradiction removed; D9
  runner-only read-only hedge; spec-hash mount marker + uid-1000 mkdir; actual-size quota re-check;
  `uploading` reason/enum; upload-remove disabled; single pending partial index + failed-row
  replacement; blocking read budget; title unset for old clients; unique indexes; client
  `pendingSend` layers on the existing acceptance UI.

### Round 6 (`oracle`, 2026-10-25): CHANGES REQUESTED (no blockers)

Resolved in revision 8:

- **M-1 state-row rule.** One rule: writers re-check the **upstream** session under the lock;
  pre-existing sessions are upserted with `has_messages=1`; GET returns DB metadata without upsert;
  PUT/touch return 503 when the app is unavailable; 404/410 only for an upstream-missing session.
- **M-2 upload commit/reconcile.** The commit writes actual `size`/`mime`/`stored_name`/`rel_path`
  while `uploading`, fsyncs, renames, then marks `available`; startup reconcile verifies the final
  file against the recorded metadata and never trusts `declared_size` for chunked uploads.
- **M-3 stream budget.** 64 MiB raw / 128 MiB heap / 320 MiB total; per-chunk admission; 9th stream
  `429 stream_limit`; sender prioritized via `streamID` in §6.8.
- **M-4 image estimator.** Image base64 uses the raw upper bound `ceil(size/3)*4`; the 20 MiB inline
  choice remains; the 40 MiB budget is binding.
- **M-5 sanitized paths.** D1 uses `resolveInstanceEnv`/`sanitizeAppKey` for `<project>` and `<app>`.
- **Minors:** upload DELETE 409; §6.8 errors; one blocking shape; retry-5xx path; external
  deletion cleanup; Stage A predicate; `too_many_inline` 400; 128 KiB draft/message body cap;
  `AttachmentView.inline`; manual DELETE 404; deferred startup confirmation; A12 exception; A6
  wording; title patch order; `.tmp` visibility; quota warning; context threshold.

### Round 7 (`oracle`, 2026-10-25): CHANGES REQUESTED (no blockers)

Resolved in revision 9:

- **F1 session-not-found status.** §6.1 uses `404 session_not_found`; `409` is reserved for local
  state conflicts.
- **F2 GET/writer rule.** `GET /draft` takes the lock but performs no upstream check and no upsert;
  it updates `last_activity_at` only when a state row exists. The upstream re-check applies to
  PUT/touch/upload/send/delete only.
- **F3 draft persistence on app outage.** PUT/touch persist the draft and `last_activity_at` even
  when the app is unavailable (the sweep cannot run while stopped); only upstream-dependent
  operations return 503.
- **F4 runner pre-create.** The **coordinator** creates `<appRoot>/attachments` (uid 1000) in
  `#ensureLocked`; the runner verifies the bind source and fails clearly if missing.
- **F5 policy-root source.** The policy root is the same `attachmentVisibleRoot(app)`, passed as an
  explicit extra root to both build and verify; the manager exposes path mode/container root; no
  `dirname(home)` derivation.
- **F6 app-stream scope/arithmetic.** 40 MiB raw (120 MiB heap) **process-global** + 8 browser
  streams per app; monitor/legacy/fallback are a separate internal class; 9th browser stream 429;
  unknown streamID grants no priority; total 320 MiB.
- **Minors:** §6.1 `inline:false` for a draft; §6.4/§6.5 statuses; async inline rejection wording;
  confirmation 404 re-checks session; confirmation read budget; index split; context image wording;
  §9 vectors; blocking budget path `202`; A12 response-shape exception; maintenance timer; directory
  fsync/temp clear; 256 KiB body cap; pre-existing `has_messages=1`; `quotaPercent`.

### Round 8 (`oracle`, 2026-10-25): CHANGES REQUESTED (no blockers)

Resolved in revision 10:

- **M1 send 404.** `attachment_not_found` is `404` in §6.8; a session vanishing mid-stream returns
  `404 session_not_found` after temp/row cleanup.
- **M2 GET contract.** §6.4 is `200` for any well-formed session id (`404 app_not_found` only); no
  upstream check/upsert; a conditional `UPDATE` touches `last_activity_at` only when the state row
  exists; D6.1/D3 aligned.
- **M3 outage persistence.** PUT/touch always persist and return 200; only a definite upstream
  404/410 rejects; 5xx/timeout/transport/unreachable still persist; §6.5's 503 removed; the
  no-row+unreachable case writes the draft only.
- **M4 blocking route.** No history reservation around a turn; the route returns the assistant
  message, reads the final response with a dedicated <=8 MiB single-flight slot (32 MiB heap,
  counted in 320 MiB), and returns `{messageID, info:null, truncated:true}` on overflow; no 202
  fallback.
- **M5 IDE extension.** The bundled extension is updated to async + `limit=30` + the `attachments`
  merge in Stage C; A12/D11 record it.
- **Minors:** `quota: {percent}` top-level; one shared internal fallback subscription per app;
  best-effort omitted identity; "next explicit restart" spec hash; §6 preamble scope; Stage B typed
  attachments for live file-only cards; orphan pass abort on an unreadable session list;
  create-on-input outage is client-only; send replaces prior failed pending rows.

### Round 9 (`oracle`, 2026-10-25): CHANGES REQUESTED (no blockers)

Resolved in revision 11:

- **Major 1 blocking contract.** The blocking route returns `{messageID, info, parts: projectedParts}`
  under the 8 MiB slot (or `{messageID, info:null, truncated:true}` on overflow), not metadata-only
  and not the full user message.
- **Major 2 delivery resolution.** A definite 404 and a Dismiss mark the associated
  `attachment_deliveries` `failed` in the same transaction, so the attachments return to retryable
  drafts; D6.5/§6.6c/D10 updated.
- **Major 3 retry-5xx.** Automatic retry only on a definite 404; the explicit "Retry anyway" may
  create a new `messageID` after the schedule even on persistent 5xx, with the duplicate warning.
- **Major 4 pending queue.** Multiple `pending_sends` per session are allowed (unique per
  `messageID`); the draft GET returns `pendingSends`; `pending_in_flight` is removed; the existing
  queue can send while busy.
- **Major 5 memory.** 192 MiB history + 96 MiB app (32 MiB raw) + 32 MiB blocking = 320; D9's
  stale 128 MiB replaced.
- **Major 6 orphan race.** The orphan pass takes the per-session lock, re-checks `GET /session/{id}`,
  skips on 5xx/ambiguity, removes only rows older than its list snapshot, and paginates or skips a
  truncated list.
- **Major 7 inline rejection.** A `session.error` tied to a `sending` pending row marks the pending
  row and its deliveries `failed`; a dispatch-time grace timer prevents a silently dead monitor from
  leaving `sending` forever.
- **Minors:** draft-GET quota; GET/writer prose; status lists; D3 GET `last_activity_at`; A12 caps;
  text-only title generation; info.hanse data path; keepalive cap; extension post-202 retry; tests;
  orphan list pagination; supervisor-mode wording; upload Origin before body.

### Round 10 (`oracle`, 2026-10-25): CHANGES REQUESTED (no blockers)

Resolved in revision 12:

- **Major 1 pending DTO identity.** `pendingSends` includes `id` and `messageID` (§6.4); Dismiss is
  keyed by `id`.
- **Major 2 retry endpoint.** §6.6d `POST .../pending/:pendingID/retry` runs the bounded recheck,
  confirms on a hit, dispatches a new `messageID` on a definite 404, and requires `{force:true}` on
  persistent 5xx with the duplicate warning.
- **Major 3 session.error correlation.** Only the oldest `sending` row is targeted, marked `unknown`
  with `turn_failed`; a later `message.updated`/part always wins; retry of `turn_failed` rechecks.
- **Major 4 startup grace.** Startup transitions `sending` older than the grace to `unknown` in the
  DB; the bounded schedule is armed on the next `endpointFor`/`ensure`.
- **Major 5 Dismiss downgrade.** Dismiss of an `unknown` row rechecks first, never downgrades a
  `sent` delivery, and marks only `sending`/`unknown` deliveries failed.
- **Major 6 4x read.** History reserves `cap * 4`; the blocking slot is 32 MiB; 192 + 96 + 32 = 320.
- **Minors:** orphan pagination + `updated_at`; `message_drafts` age; duplicate index removed;
  `attachment_id` index; D6.1 fragment; retry wording; safe-image list; route-before-ensure.

### Round 11 (`oracle`, 2026-10-25): CHANGES REQUESTED (no blockers)

Resolved in revision 13:

- **Major 1 retry/Dismiss delivery disposition.** The retry endpoint marks old deliveries for the
  pending row's `message_id` failed before creating the new attempt; Dismiss scopes the update to
  the pending row's `message_id`; both leave `sent`/another attempt untouched.
- **Major 2 session.error correlation.** On `session.error` every `sending` row in the session is
  rechecked/unknown (no "oldest" guess); a later `message.updated` wins; intentional aborts are
  excluded; D10 uses the same state.
- **Major 3 synchronous recheck under lock.** The retry/Dismiss routes snapshot under the lock,
  release it for the schedule, re-acquire and re-validate; a short request deadline returns
  `202 {rechecking:true}`.
- **Major 4 Dismiss-5xx.** Dismiss of `unknown` dismisses only on a definite 404 or `{force:true}`;
  persistent 5xx/transport returns `409 still_unknown`; `failed` rows recheck.
- **Major 5 retry guards.** Retry rejects `sending` with 409, looks up `(app_id, session_id,
  pendingID)`, cleans local state on a session-gone 404, and uses `{force:true}` only for unknown.
- **Major 6 redelivery interface.** The send body is `attachments: [{id, mode?}]`; a sent id without
  `mode` is 409; with `mode` it creates a new delivery/part and leaves the old message unchanged.
- **Minors:** `drafts` duplicate index removed; `touch` in `last_activity_at`; startup reconciles
  every `uploading` row; no automatic resend; explicit `armPendingConfirmation`; monitor
  `starting`/`connecting`; `info.hanse` wording; legacy SSE counts in the browser cap; read-budget
  vs RSS label; extension manifest/card update; retry/Dismiss/session.error/startup/redelivery
  tests.

### Round 12 (`oracle`, 2026-10-25): CHANGES REQUESTED (no blockers)

Resolved in revision 14:

- **Major 1 cross-session lookup.** Send lookup is `(app_id, session_id, attachment_id)`; a foreign
  session id is `404` and creates no delivery; redelivery is same-session only.
- **Major 2 client session.error queue.** Live `session.error` fails only the active/local acceptance
  row; server-backed queued rows are resolved by `pendingSends`; the client refetches `GET /draft`.
- **Minors folded:** pending/retry state guards, force-only-unknown, AttachmentView precedence,
  draft `mode` override, abort `MessageAbortedError`, read-budget label, SVG kind, chunked §6.9
  query, Dismiss 202/deadline, final-attempt 404 wording, startup arm callers, `monitorState`,
  legacy SSE browser cap.

### Round 13 (`oracle`, 2026-10-25): CHANGES REQUESTED (no blockers)

Resolved in revision 15:

- **Major 1 client A7 visibility.** D7 adds the attachments visibility predicate:
  `recordNeedsNode`/`hasVisiblePart` treat a non-empty `attachments` array as content;
  `insertOptimisticMessage` stores local attachments; a file-only attachment-only message renders
  its strip and an image thumbnail.
- **Major 2 force-retry deliveries.** The force branch marks the old pending row's
  `attachment_deliveries` (`message_id = old messageID`, state `sending`/`unknown`) `failed` in the
  same transaction as the new pending/deliveries.
- **Major 3 session-key/path scoping.** Dismiss lookup is `(app_id, session_id, pendingID)` and
  scoped updates; manual delete/delete-if-empty validate the path session id and use
  `resolveWithinRoot` before any upstream call/local cleanup.
- **Minors:** §9 final-404 vs unknown; legacy SSE counted in the browser cap; duplicate `drafts`
  index removed; §6.9 chunking; Dismiss 202/deadline; final-attempt 404 wording; local-only
  session.error; A6/A8 wording; supervisor manifest visibility; effective model source; internal
  callers' 48 MiB reader; startup reconcile metadata; file-only image thumbnail; redelivery UI;
  tests.

### Round 14 (`oracle`, 2026-10-25): CHANGES REQUESTED (no blockers)

Resolved in revision 16:

- **Major 1 partial-temp startup.** D2 now promotes an `uploading` row only when the final file exists
  and its commit metadata matches; a temp-only row (stream-phase partial or commit-window without
  metadata/size match) is removed. D8 aligned; tests added for partial temp, commit-window, final
  file, and size mismatch.
- **Major 2 Stage A recovery.** Stage A now includes the text-only `pendingSends` banner,
  `POST .../pending/:id/retry` and `DELETE .../pending/:id`, with delete-if-empty/sweep unblock
  tests. The stage remains independently shippable.
- **Minors:** §9 final-404 wording; §6.9 chunking + draft `attachmentCount`; redelivery card action;
  D7 helper names (`recordNeedsNode`/`recordHasVisiblePart`) and clone/merge/snapshot/buffered
  preservation; empty-text send guard; legacy SSE raw-envelope shape; blocking `userMessageID`;
  force-branch/traversal/partial-temp/empty-text tests.

### Round 15 (`oracle`, 2026-10-25): CHANGES REQUESTED (no blockers)

Resolved in revision 17:

- **Major 1 async messageID.** The async `202` keeps `messageID` = the generated user id; the
  blocking `200` returns assistant `messageID` + `userMessageID`; D5/A12/§9 updated.
- **Major 2 per-send mode.** `pending_sends.attachments_json` stores `[{id, mode?}]`; the retry
  replays the mode override; D3/D6.4/§6.6d updated.
- **Major 3 active-upload reconcile.** The daily `uploading` reconcile skips the in-memory
  active-upload set; startup still reconciles all; D8/D9 updated.
- **Minors:** D5 shape alignment; D8/§7 commit-window wording; extra synthetic `Called the Read
  tool...` text hidden; title behavior unified (text-only omit, attachment-first Attachment, default
  PATCH); Stage A delivery SQL guard; Dismiss/Retry re-triggers delete-if-empty; blocking-500 vs
  later `message.updated`; D10 pending preservation; D7 visibility/part shape; legacy SSE 32 MiB;
  tests.

### Round 16 (`oracle`, 2026-10-25): PASS

The design gate passes. Non-gating plan follow-ups:

- Blocking truncated response should include `userMessageID` and define the assistant-id source.
- `pendingSends` should expose `attachments: [{id, mode?}]` so Restore keeps a per-send mode.
- Dismiss/Retry should re-trigger `delete-if-empty` when the draft/pending content is gone.
- Send dispatch should be one SQLite transaction under the per-session lock.
- §7/D8/D7 summaries should match D2/D5 (commit-window, legacy SSE class, helper names).
- D3 index/table shorthand should use exact names.
- `delete-if-empty` must fail closed on 5xx/transport/timeout.
- The image context advisory threshold (`at most 4 x 5,000` vs `exceeds 20,000`) is unreachable.
- Add explicit tests for async/blocking ids, mode replay, active-upload skip, Dismiss/Retry delete,
  legacy SSE `data:` absence.

Falsifiers that would change this design:

- If a 32 MiB frame plus the 32 MiB raw global budget is too costly in a multi-app deployment,
  lower the inline cap or synthesize coordinator-side attachment events.
- If the app event monitor cannot observe a user message reliably even with the pre-dispatch
  subscription, the bounded backoff read must become the primary confirmation signal.
- If a nested read-only bind for `attachments` is not supported by the runner's container creation
  path, D1 falls back to size/MIME verification on send/download and drops the immutability claim.
- If `GET /config/providers` does not expose `capabilities.attachment` for the configured models,
  the inline gate uses only `capabilities.input.<modality>` and the doc must say so.
