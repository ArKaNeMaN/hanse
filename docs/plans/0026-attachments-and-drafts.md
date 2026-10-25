# Plan 0026 - Chat attachments and message drafts

- Design: [`docs/design/attachments-and-drafts.md`](../design/attachments-and-drafts.md), revision 17,
  **design review PASS** (`oracle`, round 16, 2026-10-25).
- Verification (every stage): `npm run lint && npm run typecheck && npm test && npm run build`
  (plus `npm run check:sensitive` before commit).
- Commit policy: one coherent commit per stage (code + tests + docs), Conventional Commits, only on
  the owner's instruction.
- Owner decisions (2026-10-25): A/B/C sequencing; 32 MiB app SSE frame, 20 MiB inline PDF/video;
  last-write-wins drafts; 7-day empty-session sweep; download-only video; default quotas; runner-first
  with supervisor best-effort. No owner question remains open.
- Plan revision: 3; **plan review PASS** (`momus`, round 3, 2026-10-25).
- Status: **Stages A, B, and C implemented and verified** (2026-10-25).
- Record deliverables: `docs/current-state.md`, `docs/journal/0031-attachments-and-drafts.md`,
  `docs/design/README.md`, `docs/plans/README.md`.
- Non-gating design follow-ups are folded into the stage tasks below (blocking truncated identity,
  `pendingSends` mode, Dismiss/Retry delete, send atomicity, §7/D8/D7 wording, exact table names,
  fail-closed empty check, image advisory threshold, contract tests).

## Global invariants

- Attachments live under the per-app agents root, never under `coordinator.db`, the workspace root,
  or a managed repository.
- The app container mounts the per-app agents root at `<containerAgentsRoot>`; in runner mode this is
  `/data/agents/<sanitize(projectId)>/<sanitize(appKey)>`. The attachments subdirectory is a nested
  read-only bind; the coordinator keeps the rw view.
- The model-visible path is resolved by one `attachmentVisibleRoot(app)` (runner container path or
  supervisor host path); it is never hard-coded and never derived from `dirname(home)`.
- `messageID` semantics: async `202` returns the generated **user** `messageID`; blocking `200`
  returns assistant `messageID` + `userMessageID`.
- Every send (text-only included) creates a durable `pending_sends` row before dispatch; it blocks
  delete-if-empty/sweep until confirmed or dismissed.
- A `sent` attachment is never mutated in place. A redelivery creates a new delivery/part id; the old
  message/history stays unchanged.
- Human-only attachment/draft/pending/delete routes; agent principals get `403`; uploads reject a
  present cross-site `Origin` before the body is read.
- Forward-only migrations; timestamps UTC ISO-8601; Node >= 20; no Bun APIs.
- No attachment base64 reaches a client response or SSE payload. From Stage C the blocking route
  returns `{messageID, userMessageID, info, parts: projectedParts}` or
  `{messageID, userMessageID, info:null, truncated:true}`; Stage A keeps the current `{message}`
  blocking shape.

## Cross-cutting contracts

Reference: design §5-§7, §6.1-§6.10, §8-§9. **Plan/design precedence:** where this plan differs from
design revision 17, the plan follows the round-16 follow-ups and supersedes the stale design text:
`pendingSends.attachments:[{id,mode?}]` (design §6.4) and `userMessageID` in the truncated blocking
shape (design §6.8/D5/D10). Update the design lines when this plan is accepted.

- Storage: `<agentsHome>/<sanitize(projectId)>/<sanitize(appKey)>/attachments/<sessionId>/<id>-<safeName>`;
  temp `attachments/<sessionId>/.tmp/<id>.part`.
- Tables: v15 `message_drafts`, `session_state` (`last_activity_at`), `pending_sends`
  (`attachments_json: [{id, mode?}]`); v16 `app_attachments` (`uploading|available|missing`),
  `attachment_deliveries` (`sending|sent|unknown|failed`), plus the indexes in design §D3.
- Attachment lifecycle: `available` + no `sent`/`sending`/`unknown` = draft; any
  `sending`/`unknown` = in-flight; any `sent` = sent; `uploading` = reserved; `missing` = excluded.
  Precedence for the view: `missing > in_flight > sent > draft`.
- Projection: history `info.hanse.attachments` + short download URL; live typed `message.updated`
  top-level `attachments`; never nested `info.hanse` on the typed event; unknown `data:` URLs are
  replaced with empty/marker before bounding.
- Draft GET `pendingSends` shape: `[{id, messageID, text, attachments:[{id, mode?}], state,
  updatedAt}]`; `sending` is read-only, `failed` Restore/Retry, `unknown` Retry anyway.
- Caps: 64 KiB JSON default except draft/message routes 256 KiB and upload (streamed, 100 MiB/file;
  image upload 25 MiB; 2 concurrent uploads/app; 256 MiB global in-flight upload bytes);
  32 KiB operator text both routes; 32 MiB app SSE frame (process-global 32 MiB raw/96 MiB heap,
  8 browser streams/app); 48 MiB history page/per-message read (cap x4, 192 MiB budget, 2 s wait then
  `503 history_busy`); 8 MiB projected response; 40 MiB inline base64/message; 5 GiB/app quota;
  250 MiB/message; 10 attachments/message; 4 inline.
- Fail-closed: `delete-if-empty` treats any non-definitive upstream read (5xx/transport/timeout) as
  `503`, never as empty; `messages_too_large` means `has_messages`.

## Stage A - drafts, eager sessions, and text-only pending recovery

Boundaries: text-only chat; no attachment tables, no upload/download, no base64 projection.

Non-goals: attachments, inline media, extension changes, projection, app-stream budget changes.

Deliverables:

- Migration v15: `message_drafts` (PK `(app_id, session_id)`, text <= 32 KiB, `updated_at`),
  `session_state` (`has_messages`, `last_activity_at`, timestamps), `pending_sends`
  (`id`, `app_id`, `session_id`, `message_id` unique, `text`, `attachments_json` empty for text-only,
  `state` `sending|unknown|failed`, `error_code`, timestamps).
- `src/http/server.ts`: 256 KiB body cap for `PUT /sessions/:sid/draft` and
  `POST /sessions/:sid/messages`.
- `src/http/chat.ts`:
  - Dispatch draft GET/PUT/touch and delete-if-empty **before** the `handleChat` `manager.ensure`
    block (or use `endpointFor` inside the route) so a stopped app is not started by these routes.
  - `POST /sessions` body `{title?}` (bounded 1..120, single line, control chars stripped); text-only
    create-on-input **omits** the title so opencode's `ensureTitle` generates it; attachment-first
    sessions pass `Attachment`. The pre-existing-default-title PATCH is a Stage B task (below).
  - `POST /sessions` inserts `session_state(has_messages=0, last_activity_at=now)` immediately after
    the upstream create returns; if the insert fails, clean up or leave the session without a state
    row (idempotent on retry; no Draft label for a row-less pre-existing session).
  - `GET/PUT /sessions/:sid/draft` with the design §6.4/§6.5 contracts; PUT persists on 5xx/timeout/
    transport, rejects only a definite upstream 404/410; GET never checks upstream/upserts and updates
    `last_activity_at` only when a state row exists.
  - `PUT /draft`/`touch` upsert `session_state` with `has_messages=1` **only when the row is missing**
    (a pre-existing upstream session); an existing Hanse-created `has_messages=0` row is preserved so
    a first draft stays sweepable.
  - `POST /sessions/:sid/touch` (throttled client use); a reachable upstream upserts a missing row;
    an unavailable upstream updates an existing row only and never starts the app.
  - `POST /sessions/:sid/pending/:pendingID/retry` and `DELETE .../pending/:pendingID` with the
    design §6.6c/§6.6d contracts; Stage A guards/omits `attachment_deliveries` SQL.
  - `POST /sessions/:sid/delete-if-empty`: shared predicate (pending/row/draft; no attachment clauses
    yet), upstream `limit=1` via `endpointFor`, fail closed on 5xx/transport, `messages_too_large` =
    has_messages; validate the path session id with `^ses_[A-Za-z0-9]+$` and `resolveWithinRoot` for
    folder cleanup.
  - Send route: create the pending row and delete the draft row in **one SQLite transaction under
    the per-session lock**; Stage B adds the delivery inserts to the same transaction. Call
    `sendPrompt`/`sendPromptAsync` with the generated user `messageID`; never mark sent on 202.
  - `GET /sessions` augmentation: `draft: {hasText, attachmentCount: 0, emptyDraft, updatedAt}`.
  - Manual delete: upstream 404 is already-deleted; cleanup local rows; path validation.
  - Event-monitor hook: set `session_state.has_messages=1` on any user `message.updated`; on
    `session.error` start the bounded recheck for every `sending` row in the session (or mark all
    `unknown`); exclude `MessageAbortedError`; `armPendingConfirmation(appId)` from `ensure` success,
    monitor start/resume, and coordinator startup.
- `src/opencode/client.ts`: `createSession(endpoint, title?)`; `sendPrompt(..., messageID?)`;
  `deleteSession` throws `OpencodeHttpError`/returns the status so an upstream 404 can be treated as
  deleted; no projection changes in Stage A.
- `src/opencode/manager.ts`: expose `DEFAULT_MODEL`/effective model to the route;
  `armPendingConfirmation`; `monitorState(appId)`; startup transition `sending` -> `unknown` and
  schedule arming.
- New `src/chat/sweep.ts` (or an equivalent module) + coordinator maintenance timer/startup pass:
  7-day `last_activity_at`, no draft/pending (Stage B adds attachment clauses), upstream `limit=1`
  via `endpointFor`, deleting-marker skip, active-upload skip (Stage B), fail closed on 5xx/transport,
  stopped with the process.
- Pre-dispatch fallback app-event subscription keyed by the pending `messageID` whenever
  `monitorState(appId) != connected`; startup `sending` -> `unknown` transition plus the bounded
  read/backoff schedule.
- `assets/chat.js` / `assets/chat-core.js`: shared `ensureSessionShared` (one promise, no throw on
  concurrent calls); create on first non-empty non-slash input; debounced draft PUT/flush; restore on
  switch/reload; `pendingSends` array banners (sending read-only, failed Restore/Retry, unknown Retry
  anyway; each entry carries `attachments:[{id,mode?}]`); Dismiss/Retry completion calls
  delete-if-empty when empty; Draft rail label; `session.error`
  marks only the local acceptance row (`serverID === null`), not server-backed queued/active rows;
  empty-text send guard becomes `text.empty && no attachments`.
- Tests: migration v15; draft CRUD/caps/LWW; create-on-input + `session_state` row; shared ensure;
  pending insert/atomicity under the lock; event confirmation + final-404/5xx/startup +
  monitor-disabled fallback; retry/Dismiss (guards, recheck, force); Dismiss/Retry of the last
  failed/unknown pending row triggers `delete-if-empty` and the sweep unblocks; delete-if-empty (has
  messages, draft, pending, 5xx fail-closed, traversal); sweep 7-day + touch +
  deleting-marker/active-upload; rail label; client session.error local-only.

Acceptance criteria:

- A new text-only session is created on first input (with a `session_state` row), survives reload,
  and is auto-deleted when its draft is cleared with no messages; a session with history is never
  auto-deleted; the rail shows `Draft` (A13).
- A text-only send has a pending row; a 202-before-persist is later confirmed without a duplicate; a
  final 404 is `failed`/Retry; persistent 5xx is `unknown`/Retry anyway; Dismiss/Retry unblock
  delete-if-empty/sweep.
- Draft/touch/delete-if-empty do not start a stopped app; a 5xx during the empty check never deletes.
- Existing text-only clients/routes keep working; Stage A leaves the blocking response as the
  current `{message}` shape (the `{messageID, userMessageID, info, parts}` change is Stage C) and
  documents the async 202 user-id contract in A12.

QA scenarios:

- Type in a new chat, wait for the session id, reload, verify the draft; clear it; verify the
  upstream session is gone and the files/folder removed.
- Send a text-only prompt while the app is busy; verify the second message queues, the pending row
  confirms, and no draft is restored after reload.
- Force an app 5xx during confirmation; verify `unknown`, banner, Retry anyway, and no auto-delete.
- Restart the coordinator with a `sending` row and the app stopped, then start the app; verify the
  row becomes `unknown` and the schedule/event resolves it.
- Clear an existing session with history; verify the session remains.

Risks:

- Migration v15 on existing DBs; test upgrade from v14.
- The existing client queue behavior; the pending row must not 409 a second send.
- `endpointFor`/no-ensure dispatch order; verify with a stopped app.
- The event monitor is optional; the fallback subscription/backoff must cover.

## Stage B - attachments, file-only first

Boundaries: upload/download/storage, file-only delivery, cards, quota, deletion; no inline media,
no base64 projection, no app SSE budget/cap changes.

Non-goals: inline image/video/PDF, capability gating, history/SSE projection, extension media.

Deliverables:

- Migration v16: `app_attachments` and `attachment_deliveries` with design §D3 fields/indexes
  (including `temp_rel_path`, `declared_size`, `UNIQUE app_attachments(rel_path)`, `UNIQUE
  app_attachments(app_id, temp_rel_path) WHERE temp_rel_path IS NOT NULL`, `UNIQUE
  attachment_deliveries(app_id, part_id)`, `attachment_deliveries(app_id, message_id)`, and
  `attachment_deliveries(app_id, attachment_id)`).
- New `src/attachments/` service: path resolver (`attachmentVisibleRoot` via
  `resolveInstanceEnv`/`sanitizeAppKey`), MIME sniffing, safe name, quota sum/reservation, storage
  commit/reconcile, orphan sweep, attachment view (`AttachmentView`).
- `src/http/server.ts`: binary upload dispatch before `readBody`; auth + Origin before body; 100 MiB
  stream cap.
- Title safety: `src/opencode/client.ts` `isDefaultTitle`/`patchSessionTitle`; `src/http/chat.ts`
  performs the pre-dispatch `PATCH /session/{id}` for an attachment send on a default title, before
  the pending insert/draft delete; failure is `409 title_required` with no pending/draft mutation.
  Text-only create-on-input omits the title; attachment-first uses `Attachment`; default-looking
  operator titles are prefixed.
- `src/http/chat.ts`: `POST /api/apps/:app/attachments?project=<projectId>&session=<sid>` (pre-stream
  `uploading` row, quota, stream to
  temp, final+metadata transaction, 404 on vanished session); `PATCH/DELETE/GET
  /api/apps/:app/attachments/:id`;
  `GET /sessions/:sid/draft` returns draft attachments + `quota`; send body
  `{attachments:[{id,mode?}]}` with same-session lookup and file-only delivery; manifest synthetic
  text; `info.hanse.attachments` on history; sessions `draft.attachmentCount`; manual delete removes
  the session folder; delete-if-empty/sweep use the shared predicate and fail closed.
- `src/opencode/policy.ts`: add the attachments root as an explicit trusted extra root to both build
  and verify; `manager.ts` exposes path mode/container root and policy version; restart marker.
- `src/runner/server.ts` + `src/agent/spec.ts` + `src/runner/validate.ts`: nested
  `<hostAgentsRoot>/attachments:<containerAgentsRoot>/attachments:ro`; mount marker in
  `SpecHashInput`; coordinator pre-creates the dir (uid 1000) in `#ensureLocked`; `validate.ts`
  verifies the bind source.
- `src/attachments/` + `src/http/chat.ts`: same-session attachment lookup (DB query), not in the
  opencode HTTP client; `src/opencode/client.ts`: `GET /messages` post-parse `info.hanse.attachments`
  (no base64 projection yet); provider/capability helpers unused until C.
- `assets/chat.js` / `assets/chat-core.js` + `src/http/styles.css`/`assets/app.css`: attach button,
  hidden input, drag/drop, paste; upload progress/retry/remove; chips; file-only cards via
  `record.attachments`; visibility predicate
  (`recordNeedsNode` -> `recordHasVisiblePart`); file-only image thumbnail; download; title behavior;
  empty-text send with attachments; `sendPrompt` guard; `cloneMessage`/`mergeOptimisticRecord`/
  `buildSnapshotMessages`/`applyBufferedEvent` preserve `attachments`; Stage B leaves inline disabled.
- Tests: upload auth/Origin/413/429/507, temp/commit/reconcile (partial/commit-window/final/size),
  quota race, cross-app 404, session traversal, download containment/O_NOFOLLOW, same-session send,
  file-only card/visibility, delete cascade/sweep, policy/restart, read-only bind/spec hash, title
  patch/default/failure/manifest, cross-session send test. Add `docs/design/attachments-qa.mjs`
  (file-only scenarios) to the deliverables.

Acceptance criteria:

- A PDF/CSV/image (file-only) uploads, survives a restart, downloads, and is readable by the agent at
  the model-visible path; deleting the session/app removes the rows/files; deleting the app keeps
  the DB/source semantics.
- A file-only attachment-only message (no text) renders its strip and thumbnail; cross-session ids
  are 404; a missing file fails the send with `attachment_missing`.
- The policy allows `read`/`bash` on the attachments root after restart; the agent cannot modify the
  attachments dir in runner mode; supervisor mode is documented as weaker; a pre-existing default
  title is patched before an attachment send and a patch failure returns `409 title_required`
  without dispatching.
- No attachment base64 appears in Stage B history (file-only has no file part).

QA scenarios:

- Upload a PDF, send it with text and with empty text; reload; verify the cards, download, and the
  model can read the path via `bash`/`read`.
- Kill the coordinator during the stream and during commit; restart; verify partial temp is removed,
  commit-window/final file is handled per D2/D8.
- Upload during a clear/delete; verify the `uploading` row blocks and the final check cleans up.
- Try a cross-session attachment id, `%2F`/`..`/absolute/symlink session id; verify 404/400 and no
  filesystem escape.
- Stop the app; open a draft; verify no ensure side effect; upload/send still follow the lifecycle.

Risks:

- Binary body dispatch and auth/Origin before reading.
- The runner nested ro bind and spec hash; pre-create permissions.
- Quota/commit concurrency.
- The client's `record.attachments` merge/visibility; empty-text send.
- File-only images thumbnails vs download.

## Stage C - inline media and projection

Boundaries: image/PDF/video inline delivery, capability/context gating, inline budgets, per-attempt
deliveries, projected history/SSE, blocking response, legacy SSE, app-stream budget, extension.

Non-goals: video playback/Range, audio input, server-side media generation.

Design-review checkpoint: the **approved design revision 17 (oracle round-16 PASS) is the Stage C
design-review checkpoint**; this plan's Stage C is the plan-review input. No separate Stage C design
gate remains; do not start Stage C code until this plan passes `momus`.

Deliverables:

- `src/http/chat.ts` / `src/opencode/client.ts`:
  - `sendPrompt`/`sendPromptAsync` messageID split (async user id; blocking assistant id +
    `userMessageID`, with the assistant id from `lastAssistant`); blocking response projected to
    `{messageID, userMessageID, info, parts}` under 8 MiB; on overflow
    `{messageID, userMessageID, info:null, truncated:true}`.
  - Inline capability gate: `capabilities.input.{image,video,pdf}` + `capabilities.attachment` +
    context advisory (`attachment_context_large`; images 5,000 tokens each with `>= 20,000`
    threshold; PDF/video `base64/4` vs `limit.input`); effective model from `llm.model`/
    `DEFAULT_MODEL`.
  - `pending_sends.attachments_json` mode replay; force branch marks old deliveries failed, sent/other
    untouched; session.error/all-sending recheck + abort exclusion; Dismiss/Retry recheck/202.
  - Projected history reader: 48 MiB page/per-message, cap x4, 192 MiB budget, fallback `limit=1`,
    8 MiB projected response, `503 history_busy`.
  - `info.hanse.attachments` + short download URL; unknown `data:` removal.
- `src/opencode/events.ts`: attachment resolver before `boundPart`; top-level `attachments` on
  `message.updated`; 32 MiB app frame cap; process-global 32 MiB raw/96 MiB heap budget, 8 browser
  streams/app, internal monitor/fallback class, active-sender `streamID`, skip warning/omitted,
  chunk-efficient parser.
- `src/http/prompts.ts` / legacy `streamSessionEvents`: use the resolver/budget; legacy preserves the
  raw envelope while projecting; human-only; no `data:` payload.
- `src/opencode/manager.ts`/`context.ts`: confirmation hook/bounded read/active set; attachment
  resolver DB queries; capabilities; startup/recovery.
- `assets/chat.js`: live attachment cards, manifest/Read-text hiding, `record.attachments` merge,
  redelivery "Send again as file", `stream.warning`/omitted handling, eight-tab budget behavior.
- `extensions/hanse-agent/extension.js`: async + `limit=30` + attachments merge + manifest hide +
  file-only cards + bounded post-202 read/retry.
- Tests: capability/context matrix, 40 MiB inline budget (33.34 valid, 40 at budget, 40.01/63.33
  rejected), part-id uniqueness/retry/redelivery; retry/force replays `attachments_json` including
  each `mode`, old deliveries become `failed`, `sent`/other attempts untouched, new part id;
  projection (known/unknown/large data URLs), 48 MiB
  fallback/96 budget, 32/96 app stream + eight tabs, blocking shape/overflow (async user id vs
  blocking assistant id + `userMessageID`), legacy SSE no-data, session.error multi-pending/abort,
  startup partial/commit/final, active-upload reconcile skip, extension async + `limit=30` +
  attachments merge + manifest hide + file-only cards, browser QA (390/1440 dark/light), live
  vision/PDF/CSV smoke. Add RSS/heap tests for the 48/96/32 budgets to the Stage C tests.

Acceptance criteria:

- An image/PDF/video within the inline cap is delivered to a capable model; unsupported modalities
  fall back to file with a warning; the 20 MiB inline choice remains reachable; no valid message
  exceeds the 48 MiB read/32 MiB frame/40 MiB inline budget.
- History and all SSE payloads contain no attachment base64; a session with ten 5 MiB images opens
  via the paginated fallback; the blocking route returns the assistant parts or a safe truncated
  shape.
- Retry/redelivery preserve the per-send mode and never mutate a sent attachment; session.error/abort
  resolve all pending rows consistently; delete-if-empty/sweep unblock after Dismiss.
- The legacy SSE remains raw-envelope, human-only, no `data:`; the IDE extension works with media
  sessions at `limit=30`.
- All gates green; sensitive-data scan clean; browser/live evidence recorded.

QA scenarios:

- Send an image to a vision model and ask it to describe it; send a PDF inline and file-only; send a
  CSV and read it via `bash`; reload and verify history/projection.
- Force model capabilities false/unknown; verify file fallback and warnings.
- Send ten 5 MiB images across messages; verify the history fallback and no `messages_too_large` on
  the paginated route.
- Open eight tabs with a large inline send; verify the stream warning/skip and history recovery.
- Force an inline rejection (bad codec/capability), then redeliver with `mode=file`; verify the new
  delivery/part and the old message unchanged.
- Restart the coordinator/app during a pending send; verify event/recheck/startup resolution.
- Run the extension against a media session; verify async send, `limit=30`, cards, manifest hidden.

Risks:

- Memory (48 MiB x4, 32 MiB frames, 96 MiB app, 320 total); add RSS tests.
- The opencode extra synthetic Read-text and title generator; hide in the client, never in the prompt.
- Capability/context matrix and the image advisory threshold.
- Retry/redelivery/session.error state machine; add the explicit tests from design §9 and the
  plan review.
- The legacy SSE shape and the app-stream budget.

## Requirement coverage

Every acceptance bullet below maps to one of these rows; the stage tests are the verification.

| Requirement | Stage | Acceptance / test |
| --- | --- | --- |
| A1 picker/drag/paste | B (picker/drag/drop), C (paste) | selection/paste browser tests; attachments disabled during slash command |
| A2/A3 inline capability | C | capability matrix true/false/unknown; video/PDF only when `input.*` + `attachment`; warnings |
| A4/A5 storage/path | B | upload survives restart; model-visible path readable via `bash`/`read`; app deletion removes it |
| A6 delivery modes | B/C | draft/file/`.mode` override; PDF inline vs file; redelivery |
| A7 cards/thumbnails | B/C | file-only attachment-only message renders strip + image thumbnail; download |
| A8 no base64 | C | history/app SSE/legacy SSE/blocking tests assert no `data:` |
| A9 human/path/XSS | B/C | `403` agent principals, traversal/`%2F`/symlink tests, SVG/HTML served as attachment |
| A10 limits | B/C | `413/429/507`, per-app quota, 40 MiB budget, RSS/heap tests |
| A11 deletion | B | session delete removes rows/files; app/project cascade |
| A12 compatibility | A/B/C | async 202 user id; blocking shape change only in C; legacy SSE human-only; extension update |
| A13 rail Draft | A | `has_messages=0` + draft -> rail label after reload; never for pre-existing upserts |
| A14 sequencing | This plan | A/B/C independently green; C gate recorded |
| D1-D5 drafts | A | CRUD/caps/LWW/restore/flush (pagehide/visibility) |
| D6 flush | A | keepalive <=64 KiB + normal fetch fallback |
| D7 delete/send race | A/B | per-session lock; upload row; fail-closed empty |
| D8 rail distinction | A | empty draft vs history after reload |
| Q1 history <1 MiB | C | ten 5 MiB images, paginated fallback, projected <1 MiB |
| Q2 path read | B | `read`/`bash` on a file-only attachment |
| Q3 clear within 2 s | A/B | clear draft session, concurrent send/upload; no data loss |
| Q4 cross-app 404 | B | foreign attachment id -> 404, no bytes |
| Q5 restart | B/C | pending delivery reconciles; downloads/paths survive |
| Q6 429/Retry-After/no partial/heap | B | concurrent uploads; temp cleanup; RSS bound |
| Q7 frames | C | 31.9/32.1 MiB frame; 8 tabs; skip warning |

## Verification and evidence

Every stage: `npm run lint`, `npm run typecheck`, `npm test`, `npm run build`,
`npm run check:sensitive`. Stage B runs `node docs/design/attachments-qa.mjs` for file-only scenarios (upload, cards, download,
restart, deletion). Stage C runs it again with inline/capability/frame-budget scenarios plus the
live smoke; Stage B does not run the inline vision/PDF-inline smoke. Record
screenshots/traces under `docs/design/artifacts/attachments/` with placeholders only; no deployment
host data.

## Rollout and rollback

- Apply v15 before Stage A, v16 before Stage B; both are additive. Stage C adds no schema.
- A failed stage keeps the previous commit/image; the attachments root is inside the agents volume
  and is included in the backup. Deleting the app removes it; a rollback keeps it (the previous
  binary ignores the tables/files).
- Do not delete or rewrite the attachments root during rollback. The deployment lock applies to app
  deletion/start as usual.

## Review

Plan review round 1 (`momus`, 2026-10-25): **CHANGES REQUESTED**.

Folded into revision 2:

- **Blocker 1 title safety.** Stage B now owns `isDefaultTitle`/`patchSessionTitle`, the pre-dispatch
  PATCH, `409 title_required`, the text-only-omit/attachment-first policy, tests, and acceptance.
- **Blocker 2 Stage A lifecycle.** Added the `session_state` insert, the `src/chat/sweep.ts` maintenance
  timer/startup pass, the pre-dispatch fallback subscription, and tests/acceptance for monitor-disabled
  recovery, the rail label, and the sweep.
- **Blocker 3 round-16 follow-ups.** Added the truncated blocking `userMessageID`, the
  `pendingSends.attachments:[{id,mode?}]` shape, the send transaction under the per-session lock, exact
  table/index names, and the missing contract tests.
- **Majors.** Stage C gate is the round-16 design PASS; Stage B verification is file-only (inline smoke
  is Stage C); a requirement coverage matrix maps A/D/Q to stages and adds A1/A13/D6/D8/Q6, Q1/Q3, and
  A9 measurable cases.
- **Minors.** Corrected `src/agent/spec.ts`/`src/runner/validate.ts`; added the QA harness, CSS, and
  RSS/heap deliverables; scoped the blocking response change to Stage C.

Plan review round 2 (`momus`, 2026-10-25): **CHANGES REQUESTED**.

Folded into revision 3:

- **Blocker: upload route.** Adopted design §6.1's
  `POST /api/apps/:app/attachments?project=&session=`;
  `PATCH/DELETE/GET /api/apps/:app/attachments/:id`; `src/http/server.ts` pre-`readBody` dispatch
  handles the chosen route.
- **Round-16 tests.** Added explicit mode-replay (retry/force preserves each `mode`, old deliveries
  failed, `sent`/other attempts untouched, new part id) and Dismiss/Retry -> `delete-if-empty` /
  sweep-unblock tests.
- **Shape precedence.** Added the plan/design precedence note: `pendingSends.attachments` and
  `userMessageID` in the truncated blocking shape supersede the stale design lines.
- **Non-gating:** moved the dispatch instruction to `src/http/chat.ts`; defined the `session_state`
  post-create insert/cleanup boundary; moved the same-session lookup out of `src/opencode/client.ts`;
  added the 25 MiB image cap, 2 concurrent uploads/app, and 256 MiB global in-flight upload budget;
  recorded the round-16 PASS as the Stage C design checkpoint (design D11 updated).

Plan review round 3 (`momus`, 2026-10-25): **PASS**.

Non-gating follow-ups (folded into execution/record):

- Stage B live typed `attachments`: clarify history/optimistic-only vs the small typed-field addition
  in B; design D11 says B uses the typed field.
- `delete-if-empty` shorthand: "row" means `session_state.has_messages=1`, not row presence.
- Stage C legacy SSE attribution: `streamSessionEvents` is in `src/http/chat.ts`; `streamAppEvents`
  is in `src/http/prompts.ts`.
- State the pre-existing `session_state` upsert (`has_messages=1`) on first PUT/touch in Stage A.
- Add the image advisory `>= 20,000` threshold to the design/plan precedence note.
- Clarify paste staging (B upload vs C inline delivery).
- Name the docs/record deliverables (`docs/current-state.md`, journal, indexes) in the stage plan.
