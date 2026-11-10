# 0050 - Telegram notifications

Status: **implemented and verified** (2026-11-10). Commit: this stage commit.
Design: [Telegram notifications](../design/telegram-notifications.md) (Oracle round 6 PASS WITH
FIXES; findings folded).
Plan: [0041 - Telegram notifications](../plans/0041-telegram-notifications.md) (`momus` OKAY WITH
FIXES; findings folded).
Baseline: commit `6aca092` plus the uncommitted zero-ssr working-tree changes; this stage is
additive.
Mode: **B** - additive schema v26 and a new settings/runtime surface.

## Scope

Add a coordinator-side notifier that sends Telegram messages when an agent turn completes and when
the agent is waiting for the operator: questions, permissions, SSH and handoff approvals, parked or
failed handoffs, parked thread messages, agent errors, and persisted session notices. Completion
messages carry the full final answer with Telegram rich formatting and a session/app/project link.
Settings are hierarchical (global -> project -> application), the bot token and proxy are encrypted
at rest, the public base URL is configurable, and HTTP(S)/SOCKS5 proxies are supported.

## What changed

- **Schema and storage (migration v26).** `notification_outbox` stores one row per Telegram chunk
  with `group_id`, `chunk_index`, `chunk_count`, a per-chunk dedupe key, attempts, and state
  (`pending|sending|sent|dead`). `notification_watermarks` tracks the last notified answer per
  session, `notification_meta` holds `first_sweep_at`, `notice_scan_at`, `enabled_at`, and
  `channel_enabled`, and `notification_channel_state` holds the last channel result. Session
  deletion removes its watermark.
- **Settings.** New keys `notifications.mode`, `notifications.telegram.enabled`,
  `notifications.telegram.chat_id`, `notifications.public_base_url`,
  `notifications.telegram.api_base_url`, and `notifications.include_answer`. The bot token and proxy
  URL live in `setting_secrets` (AES-256-GCM), resolve app > project > global with cleared
  tombstones, and are exposed only as status. `launchEffectiveSettings` omits the whole notification
  group, so a notification change never marks an agent restart-required. `POST
  /api/settings/telegram` handles set/clear/inherit and `POST /api/settings/telegram/test` sends a
  fixed test message with a 5 s-per-scope limit. The settings page gains a Notifications card with
  write-only secret forms and the unconfigured warning.
- **Event sources.** A module-level `notificationEvents` bus carries post-commit signals for SSH
  approvals, handoff approvals, parked replies, terminal handoff failures, delivered replies, and
  parked thread messages. The SSH service, coordinator service, thread service, and dispatcher emit
  only after their write commits; `handoffDispatcher.ready()` resolves after the startup reconcile.
- **Completion predicate and catch-up.** A debounced top-level check requires an idle session, a
  hydrated `manager.sessionActivity` with no active child or pending task, no active/queued prompt,
  no pending question/permission in the subtree, no in-flight one-shot handoff, no outstanding
  thread work, and no unbound handoff in the 60 s grace. `readTurnSnapshot` is shared with `/turn`
  and returns the last visible text answer, not a trailing tool-only message. The watermark rules
  make the first enable silent, notify a turn completed while the coordinator was down, and avoid
  replaying disabled-period notices. `ContextMonitor` emits a synthetic `stream.ready` on every
  successful attach/reconnect.
- **Attention rules.** Questions, permissions, SSH approvals, handoff approvals, parked/failed/
  terminal handoffs, parked thread messages, agent errors (aborts ignored), and notice candidates
  enqueue occurrence-aware groups under the same channel/mode gate. Thread-target questions are
  ignored; `mode=attention` suppresses completions and `off` suppresses everything.
- **Outbox sender.** Strict group order (chunk N only after N-1 is sent), a 1.1 s per-chat gap,
  per-row channel/mode/include-answer re-checks, 429 `retry_after`, exponential 5xx/network backoff
  up to eight attempts, rich format/limit fallback to a new plain suffix group, dead-lettering on
  401/403/non-format 400, payload clearing on sent/dead, seven-day pending expiry, 30-day pruning,
  and a 500-group cap. The sender runs inside `lifecycleActivity` and drains on shutdown.
- **Transport and formatting.** Direct `fetch` or `node:http(s)` through `HttpsProxyAgent`,
  `HttpProxyAgent`, or `SocksProxyAgent`; 15 s timeout, 1 MiB response cap, token/proxy redaction,
  and a one-slash `api_base_url` join. Rich messages use `rich_message.markdown` with code-point and
  UTF-8 byte budgets, fence-aware chunking, table/link protection, a 20-chunk cap, and a plain
  fallback at 4,000 characters. Plain messages disable link previews.
- **Lifecycle.** `serveCommand` constructs and starts the router and sender, composes
  `manager.onEvent`, waits for `handoffDispatcher.ready()` before the boot sweep, and wires the test
  transport. `runGracefulShutdown` closes the server first, then awaits `stopBackground` and
  subtracts its elapsed time from the drain grace.

## Verification

- `npm run lint` - pass (893 files).
- `npm run typecheck` - pass.
- `npm run typecheck:ui` - pass.
- `npm test` - 3,793 passed / 1 skipped in 262 files.
- `npm run build` - pass; Vite built the client in ~8 s.
- `npm run check:ui` - pass (85 SFCs, sentinel present; chat chunk 76,321 B gzip).
- `npm run check:sensitive` - pass.
- `npm run test:e2e` - 134 passed / 1 skipped (7.1 min).
- Targeted notification suites: store/migration, settings/secrets/HTTP/props, event bus and
  handoff/SSH emit points, predicate/catch-up, router attention, sender, transport/format/client,
  and graceful shutdown.

## Security review

A focused `security-engineer` review covered the secret routes, the proxy transport, the outbox
payload, link building, and shutdown ordering. Dispositions:

- **High, fixed: agent-writable notification routing could exfiltrate the bot token or content.**
  The master agent's `set_setting`/`inherit_setting` accepted `notifications.*` keys, so a
  prompt-injected master could point `api_base_url` at an attacker host (the bot token is in the
  request path) or set `chat_id`/`enabled` to redirect full answers. Notification routing settings
  are now human-only for writes; the master can still read them. The settings HTTP routes were
  already human-only.
- **Medium, mitigated: arbitrary `api_base_url`/`public_base_url`.** Both schemas now reject URL
  userinfo, so credentials cannot be stored/displayed/logged in a non-secret setting. Plain `http:`
  remains allowed for local Telegram-compatible gateways; it is now human-only and documented as a
  residual risk.
- **Low, fixed: fallback rows lost the `answer` marker.** A rich-to-plain fallback now carries
  `answer: true`, so turning `include_answer` off still dead-letters the pending full answer.
- **Low, fixed: retention maintenance ran only at startup.** The sender now runs the 7-day pending
  expiry, 30-day prune, and 500-group cap every ten minutes while idle.
- **Low, fixed: the general `/api/settings` POST lacked the Origin check.** It now applies
  `crossSiteMutation` like the Telegram routes; `SameSite=Strict` remains the primary guard.
- **Low, fixed: the test-endpoint rate-limit map was unbounded.** Expired entries are pruned on
  each call, bounding it to scopes used in the last five seconds.
- **Low, accepted: secret-store pragmas and WAL residue.** `secure_delete` is connection-global and
  the secret store checkpoints the WAL after each secret mutation; cleared outbox payloads can
  remain in WAL frames until the next checkpoint. This is a storage-hygiene trade-off, not a
  plaintext-secret exposure.
- **Shutdown:** no confirmed DB-write-after-close. `stop()` awaits the run loop, which awaits the
  in-flight send, and `closeDb` runs after `stopBackground` resolves. The in-flight send is not
  aborted, so shutdown can take up to the 15 s transport timeout; the generic drain-timeout path
  remains a pre-existing risk.

## Residual risks

- Send-only v1: one chat, no inbound quick replies/webhook, and no per-operator routing.
- Rich messages cannot disable Telegram link previews; plain fallback messages can.
- The full answer is stored in the outbox until it is sent/dead or expires after seven days.
- The completion predicate defers when the context tracker is not hydrated or the agent read fails;
  it never guesses a completion.
- Rich-format fallback and HTTP(S)/SOCKS5 proxy transports are unit-tested but still need an
  operator live smoke against a real bot, chat, and proxy after deployment.
- Notification routing settings are human-only, but a human can still point `api_base_url` at an
  internal host or a plain-`http` gateway and `public_base_url` at a phishing origin. Treat those
  values as security-sensitive operator input.
- Cleared outbox payloads can remain in SQLite WAL frames until the next checkpoint; the full answer
  is otherwise cleared on sent/dead and expires after seven days.
