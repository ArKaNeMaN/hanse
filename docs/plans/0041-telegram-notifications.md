# Plan 0041 - Telegram notifications

Status: **plan review OKAY WITH FIXES, findings folded** (2026-11-10). Design:
[Telegram notifications](../design/telegram-notifications.md) (revision 7; `oracle` round 6
**PASS WITH FIXES**, findings folded). Owner decisions: design section 12; no open questions remain
for this stage.

Scope: a coordinator-side Telegram notifier for (a) top-level turn completion when no subagent is
running and no handoff reply is in flight, and (b) attention events (questions, permissions, SSH
approvals, handoff approvals/failures, parked thread messages, unexpected agent stop/error). The
completion message contains the full final assistant answer with Telegram rich formatting. Every
message links to the session, or to the app/project when no session exists. Quick replies are out of
scope.

Non-goals: inbound Telegram commands/quick replies; webhooks; per-project chats/forum topics;
notification history in the web UI; file/photo delivery from the agent; multi-user subscriptions;
email/Slack/push transports; changing handoff reply routing; changing agent launch settings.

## Bindings

- Design author: maintainer; design reviewer: `oracle` (round 6 PASS WITH FIXES).
- Plan author: maintainer; plan reviewer: `momus`.
- Design index: `docs/design/README.md`; plan index: `docs/plans/README.md`; journal index:
  `docs/journal/README.md`; open questions: `docs/open-questions.md`.
- Language: English for docs, code comments, copy, and notices.
- Verification: `npm run lint`, `npm run typecheck`, `npm run typecheck:ui`, `npm test`,
  `npm run build`, `npm run check:ui`, `npm run check:sensitive`, and `npm run test:e2e` (the
  settings page is a rendered route; run the full E2E matrix).
- Commit policy: one coherent stage commit after all gates pass. The owner's "full cycle" instruction
  (2026-11-10) authorizes this stage's commit. Do not push or deploy without a separate instruction.
- New runtime dependencies: `https-proxy-agent`, `http-proxy-agent`, `socks-proxy-agent`.
- Migration: v26 (current latest is v25).

## Owner decisions (closed)

Recorded in design section 12: turn-idle completion with no running subagent and no in-flight
handoff reply; one chat for now via the settings hierarchy; public base URL as a setting; all
interruption events plus completion; full answer with rich formatting; proxy required; full cycle
authorized. No open questions.

---

## Phase 0 - Baseline probes and contract confirmation

### Boundaries

In scope: read-only inspection, a throwaway SQLite database, a local HTTP fixture, and a fake
Telegram transport. Out of scope: production code changes, production state, deployment secrets,
real project data, real bot tokens.

### Invariants

- Probes are read-only or use a disposable state; no production app/token/data is touched.
- Recorded evidence is redacted of host-specific values.
- A failed probe blocks the phase and becomes a plan deviation, not a silent workaround.

### Work

1. **Migration probe.** Apply the exact v26 SQL (design §8.1) to a temporary `better-sqlite3`
   database; assert the tables, CHECKs, unique `(group_id, chunk_index)`, FKs, and indexes.
2. **Binding probe.** Reproduce the one-shot and thread unbound windows with the real dispatcher
   paths: one-shot `createHandoff` → `bindSourceSession` (`source_session_id = invoking`), thread
   `createThreadInternal` → initial binding (`source_session_id = root`,
   `source_invoking_session_id = invoker`). Record which columns are NULL at each step and confirm
   the 60 s unbound defer and the `handoffDispatcher.ready()` barrier are necessary.
3. **Tracker probe.** With auto-compaction off and no `/context` call, confirm
   `ContextTracker.hasActiveChildren`/`hasPendingTask` return `false` before hydration. Probe the
   existing `monitor.snapshot`, `#refreshParents`, and `setSessionParents` primitives and record how
   the new `manager.sessionActivity` will hydrate; the new API itself is validated in Phase D.
4. **Bot API probe.** Probe the raw Bot API contract with a local fake HTTP endpoint and record the
   exact JSON bodies for `sendRichMessage` and `sendMessage` plus the 400/404 fallback; do not use a
   real token. The new client is validated in Phase E.
5. **Turn-tail probe.** Confirm `readTurnTail`/`deriveTurn` boundary and exclusions, and that the
   answer extraction can use the same message list (handoff/OMO/resume/synthetic rows).

### Acceptance criteria

- The v26 probe passes and fails on a duplicate `(group_id, chunk_index)` or an invalid state.
- The binding probe records both NULL columns in the unbound window and the exact binding values.
- The tracker probe proves `known=false` before hydration and `known=true` after the new API.
- The fake Bot API probe records the rich request, the 400/404 fallback, and the plain request.
- The turn-tail probe records the boundary for a trailing tool-only assistant and a resume row.

### Verification

Temporary probes only; record redacted evidence in the journal. No product gates.

---

## Phase A - Migration v26 and stores

### Boundaries

In scope: `src/store/migrations.ts` v26, `src/store/notifications.ts` (new; row/SQL helpers only),
`src/notifications/outbox.ts` (new; durable queue helpers), `src/chat/state.ts`
(`deleteSessionChatRows` watermark cleanup), and the store helpers for outbox, watermarks, meta, and
channel state.
Out of scope: router/sender loop, settings, HTTP, UI, and transport.

### Invariants

- v26 is append-only after v25; the migration is additive and forward-only.
- `notification_outbox` has one row per Telegram chunk, `format` (`rich|plain`), `error_code`,
  `state IN (pending,sending,sent,dead)`, and a unique `dedupe_key`.
- `UNIQUE (group_id, chunk_index)` exists; `app_id` and `project_id` cascade on delete.
- `payload_json` is valid JSON and at most 1 MiB by BLOB length.
- `notification_watermarks` is keyed `(app_id, session_id)` and cascades with the app.
- `notification_meta` is keyed by `key`; `notification_channel_state` is keyed by `channel`.
- The store exposes: insert group (transaction), claim next eligible chunk, mark sent/dead,
  reset `sending` on boot, prune sent/dead, cap whole groups, clear expired payloads, read/write
  watermark, read/write meta, read/write channel state.
- Claim order is strict: every earlier chunk of the same group must be `sent`.

### Work

1. Append migration v26 with the design §8.1 SQL.
2. Add `src/store/notifications.ts` with typed rows and the row/SQL helpers; add
   `src/notifications/outbox.ts` for the claim/retry/prune/group-dead queue helpers.
3. Extend `deleteSessionChatRows` in `src/chat/state.ts` to delete the session's
   `notification_watermarks` row; export from the store barrel if that is the convention.
4. Tests: `test/migrations.test.ts` v25→v26; `test/notification-store.test.ts` for claim order,
   reset, prune, cap, payload clearing, FK cascade, watermark/meta/channel state, and the unique
   `(group_id, chunk_index)`.

### Acceptance criteria

- The migration probe (Phase 0) is reproduced as a test.
- The claim never returns chunk N while an earlier chunk of the group is not `sent`.
- A dead chunk blocks the group; the group-dead helper marks remaining non-sent chunks dead.
- The cap deletes whole groups only and never a group with a `sending`/`sent` chunk.
- A 7-day pending expiry clears the payload and closes the group.
- FK cascade removes app/project rows and watermarks; `deleteSessionChatRows` removes the session's
  watermark.

### Verification

`npm run typecheck && npm run lint && npx vitest run test/migrations.test.ts test/notification-store.test.ts`.

---

## Phase B - Settings, secrets, HTTP, and the settings UI

### Boundaries

In scope: `src/settings/{registry,types,service,telegram}.ts`, `src/master/tools.ts`,
`src/http/settings.ts`, `src/http/props/settings.ts`, `src/http/server.ts` dispatch,
`ui/settings-types.ts`, `ui/pages/SettingsPage.vue`, and a new
`ui/components/SettingsTelegramSection.vue`.
Out of scope: the notifier runtime, transport, and the outbox worker.

### Invariants

- New non-secret keys: `notifications.mode`, `notifications.telegram.enabled`,
  `notifications.telegram.chat_id`, `notifications.public_base_url`,
  `notifications.telegram.api_base_url`, `notifications.include_answer`.
- New secrets in `setting_secrets`: `notifications.telegram.bot_token`,
  `notifications.telegram.proxy_url`. They are status-only in `ResolvedSettings.telegram`; plaintext
  is only returned by `SettingsService.telegramConfig(target)`.
- `launchEffectiveSettings` changes to `Omit<EffectiveSettings, "context" | "notifications">` and
  keeps returning `{ llm, web, git }`; a hash test proves each notification key does not change the
  agent launch hash.
- `resolve()` and `snapshot()` both include the notification group; the secret resolution follows
  app > project > global with cleared tombstones (the `GitAuthStore`/`ProviderKeyStore` pattern).
- Validation trims and never echoes the submitted secret; errors carry only the field and reason.
- `isSettingsRoute` matches both new POST paths; both call `crossSiteMutation` first.
- `/api/settings` and `/api/ui/settings` never contain the token/proxy; master `get_settings` sees
  status only; master `get_setting` maps the new keys; `SETTINGS_SECTION_KEYS` includes
  `notifications`.
- The settings section renders at every scope; secret inputs are write-only with `Not shown`.
- The test endpoint is limited to one call per 5 s per scope.

### Work

1. Add the key definitions/schemas and the `SettingsKey`/`EffectiveSettings` entries.
2. Add `NotificationSecretStore` (or a generic wrapper over `setting_secrets`) and the
   `telegramConfig(target)`/set/clear/inherit methods; add `SecretStatus` and
   `ResolvedSettings.telegram`.
3. Update `launchEffectiveSettings` and the settings hash test.
4. Add `POST /api/settings/telegram` and `POST /api/settings/telegram/test`; update
   `isSettingsRoute`; call `crossSiteMutation`; add the test endpoint using a transport seam and the
   5 s-per-scope limit.
5. Add the settings props/rows/labels, `SETTINGS_SECTION_KEYS`, and the UI section/nav.
6. Add master `effectiveValue` mappings.
7. Tests: settings resolution/inheritance/validation/redaction, launch-hash exclusion, route
   auth/JSON/CSRF/status masking, test endpoint success/failure, props never contain secrets,
   jsdom section rendering/set/clear/inherit/test/warning.

### Acceptance criteria

- Each notification key resolves global/project/app and can be cleared/inherited.
- The launch hash is unchanged for every notification key and changes for provider/git secrets.
- `/api/settings` and `/api/ui/settings` contain only `{state, source}` status, never the token or
  proxy; master `get_settings` does the same.
- `POST /api/settings/telegram` rejects a cross-site Origin with 403 and a non-JSON body with
  `400 invalid_request` (matching the existing settings route convention and design §7.3).
- `POST /api/settings/telegram/test` sends through the configured transport, is limited to one call
  per 5 s per scope, and returns a sanitized error on failure.
- The settings page renders the Notifications section at all scopes and warns when enabled but
  unconfigured.

### Verification

`npm run typecheck && npm run typecheck:ui && npm run lint && npx vitest run test/settings.test.ts test/settings-http.test.ts test/settings-props.test.ts ui/pages/SettingsPage.test.ts` (plus the new route tests).

---

## Phase C - Notification event bus and non-agent sources

### Boundaries

In scope: `src/notifications/events.ts` (new), `src/ssh/service.ts`, `src/coordinator/approval.ts`,
`src/coordinator/thread.ts`, `src/coordinator/service.ts`, `src/coordinator/dispatcher.ts`, and the
notice source wiring.
Out of scope: the router rules, outbox, transport, and completion predicate.

### Invariants

- `notificationEvents` is a module-level bus like `processEvents`: `subscribe`, `emit`, `reset`;
  listeners are isolated with try/catch; every signal carries `transitionAt`.
- Emit **after** the outer transaction commits. `requestApproval` commits its own transaction, so
  the caller emits after it returns; `insertThreadApproval` runs inside `createThreadInternal`'s
  transaction, so the emit happens after `run.immediate()` returns.
- SSH: emit `ssh_approval` after `SshStore.createPending` returns a new pending row (not for an
  existing row); include `appId`, `hostId`, `approvalId`, `commandPreview`, `expiresAt`.
- Handoff approval: emit `handoff_approval` for dispatch/reply/thread start with `handoffId`,
  `approvalKind`, `approvalId`, `requestedAt`.
- Handoff reply: emit `handoff_waiting_operator`/`handoff_failed` after the transition helper
  commits; emit `handoff_reply_delivered` after `markReplyDelivered` commits.
- Terminal handoff: emit `handoff_failed` when a waiting source handoff becomes
  `failed|rejected|expired`; one-shot `#failUnboundHandoffs` and thread
  `#failTimedOutBindings`/`#failThreadStart` emit after the transition.
- Thread message: emit `thread_message_waiting` when a message becomes `waiting_operator`.
- The existing handoff reply routing is unchanged: `source_session_id` remains the invoking session
  for one-shot handoffs; no reply target changes.

### Work

1. Add the bus and the signal types.
2. Wire the SSH emit after `createPending`.
3. Wire the handoff approval emits at the three creation sites, after commit.
4. Centralize the reply/thread-message transition helper and emit `waiting_operator`/`failed`/
   `delivered` after commit.
5. Wire the terminal-failure emits in `#failUnboundHandoffs`, `#failTimedOutBindings`, and
   `#failThreadStart`.
6. Add a `handoffDispatcher.ready()` promise resolved in `finally` after the startup unbound/binding
   reconcile; expose it to the notifier.
7. Tests: bus isolation, post-commit emission, one-shot subagent reply routing regression, thread
   approval after commit, ready() on success/failure, each failure path's emit.

### Acceptance criteria

- No signal is emitted before its transaction commits (a rolled-back transaction produces none).
- A subagent one-shot handoff reply still lands in the invoking session.
- `ready()` resolves on success and on a throwing reconcile.
- Every `waiting_operator`/`failed`/`delivered` transition emits exactly one signal with
  `transitionAt`.
- The SSH approval signal is emitted only for a newly created pending row.

### Verification

`npm run typecheck && npm run lint && npx vitest run test/notification-events.test.ts test/handoff.test.ts test/handoff-thread.test.ts test/handoff-dispatcher.test.ts test/ssh-service.test.ts test/ssh-approvals.test.ts`.

---

## Phase D - Completion predicate, catch-up, and answer extraction

### Boundaries

In scope: `src/notifications/router.ts` (predicate part), `src/notifications/catch-up.ts` (new),
`src/chat/turn.ts` (shared snapshot/answer helper), `src/opencode/manager.ts` (sessionActivity),
`src/opencode/context.ts` (subtree activity + hydration), and `src/http/chat.ts` (reuse the helper).
Out of scope: the sender, transport, and UI.

### Invariants

- `readTurnSnapshot(endpoint, S, { isSubagent: false, projector })` is the single read used by the
  predicate and the answer: status -> history -> status, page back to the boundary, `deriveTurn`
  with `{ isSubagent, settling, queuedTruncated }`, and return
  `{ snapshot, messages, answerMessageId, answerText }`. The helper takes the
  `MessageProjector`/handoff-projection deps so `/turn` and the notifier share one implementation.
- `answerMessageId` is the last assistant with visible text within the current turn, using the same
  boundary/exclusions as `deriveTurn`; a trailing tool-only assistant is not the answer.
- The check is debounced `NOTIFY_SETTLE_MS = 2500` from the last idle and re-scheduled by a child
  going idle, a pending prompt being answered, `handoff_reply_delivered`, and the 60 s sweep.
- The predicate checks, in order: top-level session; idle; `manager.sessionActivity` with
  `known=true`, `activeChildren=false`, `pendingTask=false`; `!queuedTruncated && !settling` and no
  active/queued prompt; no pending question/permission in the subtree (fail closed); no in-flight
  one-shot handoff (subtree SQL, `mode='one_shot'`); no outstanding thread work
  (`mode='thread'`, non-terminal header states, source/reply states); no unbound handoff in the 60 s
  grace (any non-terminal handoff in the app with `source_session_id IS NULL AND
  source_invoking_session_id IS NULL` and `created_at > now - 60s`); dedupe/watermark.
- `manager.sessionActivity(appId, S)` hydrates the tracker before returning (`known`), walking the
  whole subtree; it never starts the agent.
- The subtree JSON is validated and capped at 500 ids; invalid/oversized defers.
- `history_busy`/`messages_too_large` defers; it never completes.
- The watermark rule: first enable initializes to the predicate's answer/occurrence id without
  notifying; later, a differing answer id enqueues; a new session (created after
  `first_sweep_at`) enqueues its first completed turn; a pre-marker session initializes silently;
  a missing `time.created` initializes silently; a dedupe skip advances the watermark.
- `catch-up.ts` runs on boot and on `stream.ready`, after `handoffDispatcher.ready()`, and applies
  the same predicate. It scans `session_notices` only for the four attention kinds and
  `created_at > max(notice_scan_at, enabled_at)` (and within 7 days).
- Channel/mode gating: completion only when `mode === "all"` and `enabled`; attention only when
  `mode !== "off"` and `enabled`; while disabled, advance the completion watermark and
  `notice_scan_at`; on a real enable transition set `enabled_at`; persist `channel_enabled`.
- `ContextMonitor` emits a synthetic `stream.ready` on every successful attach/reconnect.

### Work

1. Extract `readTurnSnapshot`/`readFinalAnswer` into `src/chat/turn.ts` (or a sibling module) and
   reuse it in the `/turn` route.
2. Add `manager.sessionActivity` + `ContextTracker` subtree activity + hydration.
3. Add the synthetic `stream.ready` in `ContextMonitor`.
4. Implement the predicate and the subtree SQL (`json_each(:subtreeJson)`).
5. Implement `catch-up.ts` with the watermark/meta rules and the notice scan.
6. Add the channel/mode gate and the watermark/dedupe-skip path.
7. Tests: the full predicate matrix, watermark first-enable/downtime/new-session/tool-only,
   hydration with auto-compaction off, subtree SQL empty/large, unbound grace, catch-up order,
   notice scan marker, channel/mode gates.

### Acceptance criteria

- A normal finished turn with no blockers enqueues exactly one completion group.
- A running child, pending child prompt, queued prompt, in-flight one-shot handoff, outstanding
  thread message, or unbound handoff in the grace suppresses the completion.
- A turn with a trailing tool-only assistant sends the last text answer, not the tool-only message.
- A tool-only turn after a text turn sends a distinct `Done`.
- A first enable does not notify historical turns; a turn completed while the coordinator was down
  notifies on boot; a re-enable does not replay disabled-period notices.
- `mode=attention` suppresses `turn_completed`; `mode=all` sends it; `off` sends nothing.
- A missing/hydration-unknown tracker defers, never completes.

### Verification

`npm run typecheck && npm run lint && npx vitest run test/notification-predicate.test.ts test/notification-catch-up.test.ts test/chat-turn.test.ts`.

---

## Phase E - Telegram transport, formatter, and client

### Boundaries

In scope: `src/notifications/telegram/transport.ts`, `client.ts`, `format.ts`, and the package
dependencies.
Out of scope: the outbox sender and router.

### Invariants

- `TelegramTransport.call(method, body, signal)` supports direct `fetch` and proxied
  `node:http(s).request` with `HttpsProxyAgent`, `HttpProxyAgent`, or `SocksProxyAgent`.
- Target/proxy matrix: `https:` target + `http(s)` proxy -> `node:https` + `HttpsProxyAgent`;
  `http:` target + `http(s)` proxy -> `node:http` + `HttpProxyAgent`; SOCKS5 -> the matching
  `node:http(s)` + `SocksProxyAgent`.
- `apiBaseUrl` comes from `notifications.telegram.api_base_url`; a path is joined with one slash.
- 15 s timeout, 1 MiB response cap, `AbortSignal`, redacted errors; the token is never logged.
- `sendRichMessage` uses `rich_message: { markdown }`; a rich 400 format/limit or 404 re-chunks the
  remaining suffix into a new plain group (4000-char rows, link on the last, original rows N..end
  dead); a non-format 400 dead-letters.
- `sendMessage` plain chunks set `link_preview_options: { is_disabled: true }`; 4096 limit, budget
  4000.
- The formatter counts rich code points and UTF-8 bytes (split near 32768), plain code points and
  UTF-16 units (use the larger), tracks code fences, never splits links/table rows, handles an
  oversized table row by forcing plain text and repeating the header, and caps a rich group at 20
  chunks (fallback plain groups exempt).
- Message bodies follow design §5.3; the link is the session/app/project fallback; labels have no
  emoji; error text is sanitized.

### Work

1. Add the three proxy dependencies.
2. Implement the transport matrix and the direct fetch path.
3. Implement `sendRichMessage`/`sendMessage` with error mapping and redaction.
4. Implement the formatter/chunker and the plain suffix re-chunker.
5. Tests: direct/proxy matrix (fake request), scheme validation, 429/400/401/403/404/5xx mapping,
   timeout/abort, redaction, rich/plain bodies, code fences, tables, emoji, 500 blocks/21 columns,
   oversized row, 20-chunk cap, middle-chunk 400 suffix, second fallback group id, link previews.

### Acceptance criteria

- Every proxy scheme produces the expected agent/request type.
- A rich 400 on a middle chunk preserves the suffix, links the last plain chunk, and does not resend
  earlier chunks.
- A 429, 5xx, 401/403, and non-format 400 map to the documented states.
- The formatter never exceeds the documented budgets and never splits a link or table row.
- The token/proxy never appears in an error, log, or message.

### Verification

`npm run typecheck && npm run lint && npx vitest run test/telegram-transport.test.ts test/telegram-format.test.ts`.

---

## Phase F - Router, sender, and lifecycle wiring

### Boundaries

In scope: `src/notifications/router.ts` (attention rules + enqueue), `src/notifications/outbox.ts`
(claim/retry/prune/group-dead + sender loop), `src/cli/commands.ts`, `src/coordinator/shutdown.ts`,
and the test endpoint wiring.
Out of scope: new product surfaces beyond the settings section.

### Invariants

- The router composes with the existing `InstanceManager.onEvent` (handoff dispatcher + notifier) and
  subscribes to `notificationEvents` and per-app notices; it starts after
  `handoffDispatcher.start()` and waits for `dispatcher.ready()` before the boot sweep.
- Attention rules: question, permission, SSH, handoff approval, parked/failed/terminal handoff,
  parked thread message, agent error (ignore aborts), notices (reason matrix), boot notice scan.
  Thread-target questions are ignored.
- Dedupe keys are occurrence-aware (approval id, transitionAt, notice id, answer id/time bucket);
  every kind uses `<base>:<chunkIndex>`.
- The sender claims one eligible chunk at a time in strict group order, resolves settings by row
  scope, re-checks channel/mode/`include_answer` per row, sends with a 1.1 s per-chat gap, handles
  429/5xx/4xx as designed, clears payloads on sent/dead, prunes/caps whole groups, and writes
  `notification_channel_state`.
- Drain: the sender stops claiming when draining; each in-flight send is wrapped in
  `lifecycleActivity.begin("telegram_notify")`.
- Shutdown: close the server first, then await `stopBackground` (sender stop resolves the backoff
  sleep and awaits the current send, bounded by 10 s), then `awaitQuiescence` with the elapsed stop
  time subtracted, checkpoint, close DB. No DB write after close.
- `POST /api/settings/telegram/test` uses the same transport/client and returns a sanitized result.

### Work

1. Implement the router attention rules and enqueue.
2. Implement the sender loop in `src/notifications/outbox.ts` (the queue helpers are added in
   Phase A).
3. Wire construction/start/stop in `serveCommand`; compose `onEvent`; add `stopBackground` await in
   `runGracefulShutdown`.
4. Wire the test endpoint to the transport.
5. Tests: router attention matrix, dedupe/transitionAt, sender strict order/retry/429/5xx/plain
   fallback/dead-letter/cap/payload clearing, drain, clean-SIGTERM duplicate caveat, restart reset,
   channel state, test endpoint.

### Acceptance criteria

- Every attention source produces one deduped message group; a repeat after recovery is a new
  occurrence.
- The sender never sends chunk N before chunk N-1 is `sent`; a dead chunk closes the group.
- A disabled/mismatched row is dead-lettered, not sent on re-enable.
- Drain waits for the in-flight send; SIGTERM leaves no DB write after close and at most one
  duplicate if the grace expires.
- The test endpoint sends a fixed message and surfaces a sanitized failure.

### Verification

`npm run typecheck && npm run lint && npx vitest run test/notification-router.test.ts test/notification-sender.test.ts test/graceful-shutdown.test.ts`.

---

## Phase G - Full verification and E2E

### Boundaries

In scope: the full gate run, the settings-page E2E (the route is rendered), and the browser QA for
the Notifications section. Out of scope: a live Telegram smoke with a real token (the operator
performs it after deployment; use a fake transport in tests).

### Work

1. Run the full gates: `npm run lint`, `npm run typecheck`, `npm run typecheck:ui`, `npm test`,
   `npm run build`, `npm run check:ui`, `npm run check:sensitive`, `npm run test:e2e`.
2. Add the settings Notifications E2E scenario (route interception, save/clear/inherit/test/warning,
   secret never in the DOM/props).
3. Browser QA at 390/768/1440, dark/light, keyboard/focus, no console/page errors.
4. Record redacted evidence in the journal.

### Acceptance criteria

- All gates pass; any pre-existing failure is documented and not attributed to this stage.
- The E2E scenario proves the section renders, saves, tests, and never exposes the secret.
- Browser QA has zero console/page errors and no visual regressions.

### Verification

The full gate list above.

---

## Phase H - Documentation, record, and commit

### Boundaries

In scope: `docs/current-state.md`, the design/plan/journal indexes, `docs/open-questions.md`, the
stage journal, and the commit. Out of scope: deployment and push.

### Work

1. Update `docs/current-state.md` with the notifier, settings keys, outbox, proxy, and limits.
2. Update `docs/design/README.md`, `docs/plans/README.md`, and `docs/journal/README.md`.
3. Write `docs/journal/0049-telegram-notifications.md` (context, what was done, decisions, evidence,
   limits, follow-ups: quick replies, per-project chats, live smoke).
4. Add the stage entry to `docs/open-questions.md` (already recorded; confirm no open items).
5. Run `npm run check:sensitive`; review the diff for host-specific data and secrets.
6. Commit one coherent stage commit (code + tests + docs + record) after all gates pass. Do not push
   or deploy.

### Acceptance criteria

- The docs match the implemented behavior; the journal links the design/plan and records the gates.
- The indexes are updated.
- The commit contains only this stage's files and no secrets/host-specific data.
- No push/deploy without a separate owner instruction.

### Verification

`npm run check:sensitive`; `git status`/`git diff --stat`; the full gate list already green.

---

## Risks and rollback

- **Rich messages are new.** The plain suffix fallback covers an older Bot API server and parse/limit
  failures; a live smoke is an operator follow-up.
- **Tracker hydration.** `sessionActivity` must hydrate; the test with auto-compaction off is the
  guard. If hydration is unavailable, completion defers (safe, not silent).
- **Unbound handoffs.** The 60 s grace is a bounded trade-off; `dispatcher.ready()` closes the boot
  ordering, and the dispatcher failure paths emit `handoff_failed`.
- **Full-answer at rest.** Payloads are cleared on sent/dead and after 7 days; `include_answer=false`
  is the off switch.
- **Proxy.** The three proxy dependencies are pure JS and Node 20 compatible; a live proxy smoke is an
  operator follow-up.
- **Rollback.** Disable `notifications.telegram.enabled` (or `mode=off`) to stop delivery without a
  restart; the outbox is additive and can be left in place. The schema migration is forward-only;
  a rollback requires a DB backup restore, as with every migration.
- **Operator live smoke (after deployment).** Configure the token/chat/public URL, press Send test,
  open the session link, disable and re-enable, and repeat with the proxy. This is a human step, not
  a gate.
- **Security review.** The new secret routes and the proxy transport are security-relevant; record a
  `security-engineer` review of the token/proxy redaction, CSRF, and outbound URL handling, or an
  explicit owner acceptance of design §10.
