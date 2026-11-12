# Design docs

- [Design system contract](../../DESIGN.md) - The Chart Room: atmosphere, tokens, typography,
  shell grammar, components, motion, accessibility, and accepted debt.
- [Primitive showcase](./showcase.html) - every primitive and state rendered from the real built
  stylesheet, dark and light, phone to desktop.
- [Stage 2 record](./stage-2.md) - the authenticated product screens, routes, decisions, evidence,
  and the stage-3 handoff.
- [Stage 3 record](./stage-3.md) - the three-pane chat workspace, real-agent and fixture evidence,
  decisions, accepted debt, and the stage-4 handoff.
- [Git workbench](./git-workbench.md) - the application page and human-only git status/actions
  design.
- [Git credentials](./git-credentials.md) - per-app SSH/HTTPS credentials in hierarchical settings,
  encrypted at rest and materialized into the agent HOME, with a read-only workbench mount and Test
  connection.
- [Interactive prompts](./interactive-prompts.md) - question/permission docks, the session Todo
  panel, and the app-scoped permission policy.
- [Chat UX overhaul](./chat-ux-overhaul.md) - streaming assistant text and tool output, optimistic
  send and upstream queueing, truthful agent status, inline question/Q&A cards with auto-advance,
  OMO system cards, markdown tables, and the feed measure.
- [Chat diff highlighting](./chat-diff-highlighting.md) - lazy module-worker Prism highlighting for
  tool diffs and `write` content, the unified-diff parser, language resolver, budgets, and DOM safety.
- [Chat UX QA harness](./chat-qa.mjs) and [artifacts](./artifacts/chat/README.md) - deterministic
  browser scenarios (streaming, queue/send, inline questions, OMO, tools, tables, width), JSON
  reports, screenshots, and the `--live` real-agent mode.
- [Web tools and hierarchical settings](./web-tools-and-settings.md) - global/project/app settings,
  encrypted model-provider keys, builtin/DeepSeek web drivers, per-app OMO model profiles, and the
  explicit restart workflow.
- [UX/UI polish](./ux-polish.md) - application-page hierarchy (git first, compact Image/SSH/runtime),
  compact hierarchical settings, the xterm operator terminal, and truthful runtime/chat state.
- [SSH host access](./ssh-host-access.md) - global operator-defined SSH hosts, per-app grants,
  coordinator-side exec/SFTP through a keyless MCP bridge, idle-based approvals in chat, and
  automatic host-key pinning.
- [Project and application deletion](./project-and-application-deletion.md) - human-only destructive
  flow, durable deletion markers, runtime/network/image cleanup, app state and manifest removal,
  handoff/event retention, path guards, and retry semantics.
- [Chat pagination and generation indicator](./chat-pagination.md) - 30-message session tail,
  cursor-based scroll-up history, overlap-aware snapshot merge, and the in-feed generation row.
- [Chat notice grouping](./chat-notice-grouping.md) - groups contiguous interruption/resume notice
  dividers by cause, a detailed collapsed caption (counts, subagents, restarts, kind breakdown, time
  range), and hides leading notices while an older message chunk is not loaded. Status: design
  review cleared (Oracle Round 3 findings folded); plan `momus` OKAY; implemented and verified
  (journal 0047).
- [Truthful chat turn state](./chat-turn-state.md) - a server-computed turn snapshot
  (`status`, `turnContinues`, running/queued prompts), the read-only `GET .../turn` hydration route,
  a status-driven generation row with `Ready · N queued`, the queue modal replacing the strip, and the
  retirement of the client queue-promotion block. Status: design `oracle` Round 2 PASS WITH FIXES
  (findings folded); plan `momus` OKAY; implemented and verified (journal 0045).
- [Mobile chat polish and turn control](./chat-mobile-polish.md) - touch composer focus/viewport,
  coarse-pointer Enter, Stop/abort, queue-state guarding, policy diagnostic filtering, plan
  visibility, smooth autoscroll, reasoning type/timer, elapsed seed, and background stream recovery.
  Status: implemented; automated gates green; browser QA blocked by host Chromium libs; device QA
  pending; stream recovery follow-up in journal 0030.
- [Context usage and compaction](./context-compaction.md) - server-side per-session context
  accounting, provider context limits, manual compaction, threshold-based auto-compaction, and
  per-step live snapshots on the app event stream.
  Status: approved (oracle PASS); revision 4 implemented (journal 0034).
- [Chat attachments and message drafts](./attachments-and-drafts.md) - per-session attachment
  storage, inline image/video/PDF delivery gated by model capabilities, file-only paths for the
  agent, history/SSE base64 projection, server-side message drafts, eager empty-session creation,
  and delete-if-empty semantics. Status: implemented/verified - design review PASS (round 16); Stages A/B/C complete (2198 tests, Stage A/B/C browser QA, security findings fixed).
- [Composer draft retention until send response](./local-draft-recovery.md) - minimal client-only fix:
  keep the composer text and sent attachment chips until the send response; clear on success, keep on
  failed/unknown, preserve a newer draft typed during the request. No local storage, attempt id, or
  migration. Status: accepted (owner chose it after six reviews of larger designs).
- [Chat image display and agent-sent images](./chat-image-display.md) - an explicit `show_image`
  MCP tool (the model decides), a durable per-app `agent_media` store, live/history synthetic
  file-part projection, a human-only download route, large inline image cards, and a native
  `<dialog>` lightbox. Status: approved (`oracle` round 6 PASS after five revision rounds);
  implemented and verified (journal 0040); one pre-existing jsdom suite failure remains.
- [Inline prompt media pass-through](./inline-prompt-media.md) - unknown image `file` parts from
  tool-created user turns (subagent prompts) stay visible as attachment cards, served on demand
  from the persisted message part through a human-only same-origin route, with no store copy, quota,
  or async projection. Status: design review PASS WITH FIXES (Oracle rounds 1-2, findings folded);
  implemented and verified (journal 0055).
- [Handoff threads](./handoff-threads.md) - stage-1 agent-originated multi-turn handoffs: one
  `handoffs` header plus an ordered `handoff_messages` log, start-only approval, exact observed
  binding, a per-thread/per-destination queue with no retry, idle TTL/message cap/operator cancel,
  quotas and attempt events, the public handoff allowlist, and the agent-token gate. Deferred:
  close/retry/relaunch/retarget, shared-session operator paths, target-initiated messages, and thread
  UI/projection. Status: approved (`oracle` PASS); implemented and verified (journal 0041).
- [Thread chat rendering](./thread-chat-rendering.md) - additive thread chat projection and the
  `HandoffCard` thread variant, first-line thread body extraction, the target-session question guard,
  SSE/prompts visibility filtering, and the target-only prompt line. Status: approved (`oracle`
  PASS); plan PASS (`momus`); implemented and verified (journal 0042); commit `<commit-hash>`.
- [Cross-project handoffs](./cross-project-handoffs.md) - source-owned outbound grants in a separate
  `handoff_grants` table (default-deny, `auto/auto` default, no deny rows), optional `to_project`
  admission, `remoteApps` discovery, one-shot/thread coverage with no reverse reply grant, builtin/
  master exclusion, insert-only snapshot semantics, read-only inbound visibility, public/human
  projection split, and deletion/audit. Status: design `oracle` PASS WITH FIXES (findings folded);
  plan `momus` OKAY WITH FIXES (findings folded); implemented and verified (journal 0052).
- [Chat session tree](./chat-session-tree.md) - group `opencode` subagent sessions under their
  parent in the chat rail with disclosure chevrons, multi-level nesting, active-ancestor expansion,
  orphan/cycle handling, subtree delete cleanup, and a deferred realtime follow-up. Status:
  implemented and verified (journal 0032); design review PASS (`oracle` round 3).
- [Session list live agent status](./session-list-status.md) - an additive per-session coarse status
  (`idle | busy | retry`) in `GET /sessions`, seeded into the existing SSE status map, and a rail
  indicator (`Working` / `Retrying`) that is hidden when idle and overridden by the waiting badge.
  Status: design `oracle` PASS WITH FIXES (findings folded); plan `momus` OKAY WITH FIXES
  (findings folded); implemented and verified (journal 0053).
- [Slash commands](./slash-commands.md) - a thin opencode server-command proxy and a small
  Hanse-native command registry merged into one chat palette, with the wire contract, collision
  policy, detached execution, and security analysis. Status: approved (oracle PASS after 2 rounds);
  plan reviewed (momus PASS); implemented and verified (journal 0025); commit pending.
- [App-agent skill authoring](./app-skill-authoring.md) - app-scope create/list/get/update/enable/override tools over the existing app MCP surface, token-bound targets, by-id authorization, content-free audit, manual restart, and accepted self-modification risk. Status: approved (oracle PASS after three rounds); plan reviewed (momus PASS); implemented and verified (journal 0024); all five gates pass; committed.
- [App previews (demo)](./app-previews.md) - path-based reverse proxy for an app's in-container HTTP service, app-scoped ephemeral previews opened over MCP, a chat tool-card action and conditional context-rail block, hardened stream/header handling, and an accepted same-origin risk. Status: approved (oracle PASS after three rounds); plan reviewed (momus PASS); implemented; automated verification passed; local runner-backed smoke passed (journal 0026); deployment Vite/Next smoke pending; no commit yet.
- [Managed agent skills](./agent-skills.md) - global/project/application skill registry, deterministic per-instance materialization into `opencode`'s config skill roots, restart semantics, human-only API, and scope-aware Web UI. Status: approved (oracle PASS after seven rounds).
- [Skill bundles and the skill workspace](./skill-bundles.md) - `references/*.md` bundles, structured frontmatter metadata, a dedicated side-by-side source/preview workspace, inventory-only list pages, and a backward-compatible materialization hash. Status: approved (oracle PASS after five rounds); plan reviewed (momus PASS); implemented and verified (journal 0020).
- [External skill sources](./external-skill-sources.md) - a global operator-managed source registry, a `skills-hub` HTTP manifest adapter, a content-addressed cache with immutable snapshots, composite local-wins resolution, per-app materialization, and arbitrary per-skill files. Status: approved (`oracle` round 6 PASS); plan `momus` round 3 PASS; implemented (backend/API; source UI, external inventory drawer, and arbitrary-file text editor deferred, journal 0044).
- [Hanse master agent](./hanse-master.md) - a built-in assistant for operating Hanse: reserved application identity, read-only app directory, allowlisted MCP tools, shared provisioning, confined workspace files, and a reduced operator surface. Status: approved (oracle, three rounds; final delta cleared); implemented and verified (journal 0021).
- [Master-authored skills](./master-skill-creation.md) - create-only skill bundles from the master at global/project/app scope: service-reused validation, target guards, global confirmation, atomic skill+audit transaction, content-free result, and explicit restart reporting. Status: approved (oracle, three rounds); plan reviewed (momus PASS); implemented and verified (journal 0022); extended by master-skill-management.
- [Full master skill management](./master-skill-management.md) - master list/read/update/enable-disable/override skill tools, global and replacement confirmations, read-only reserved/deleting targets, atomic audit, content-free mutations, and manual deletion/revert/rename. Status: approved (oracle, three rounds); plan reviewed (momus PASS); implemented and verified (journal 0023).
- [Deployment safety and release identity](./deployment-safety.md) - external deployment lock, schema guard, readiness/version, async restart, MCP-token reconciliation, CI-gated publishes, full-SHA/revision identity, and independent image tags. Status: approved (oracle PASS); plan reviewed (momus PASS); implemented and verified (journal 0019).
- [Agent image validity](./agent-image-validity.md) - per-application image identity by Docker image ID, base tracking by manifest digest (`agent-base` vs `agent-default`), optional `build.base` with final-`FROM` fallback, migration 18, durable build adoption, restart/rollback preflight, chat warnings and the not-ready build-and-start card, shared image state, runner inspect/identity, `HANSE_AGENT_BASE_IMAGE`, docs and QA. Status: implemented; full lint/typecheck/test/build/sensitive gates pass (tests with `HANSE_CREDENTIALS_DIR` unset); browser QA PASS (6 scenarios, 32 screenshots, 0 console/page errors); live smoke pending; design owner-accepted after 12 rounds without an Oracle PASS (owner override).
- [Global custom model providers](./custom-model-providers.md) - a global OpenAI-compatible provider
  registry projected into `OPENCODE_CONFIG_CONTENT.provider`, with encrypted provider keys, a
  settings UI/API, restart hashing, and an in-use delete guard. Status: approved (oracle round 2
  PASS; momus round 2 PASS); implemented and verified (journal 0035).
- [Incremental SPA migration](./spa-migration.md) - a strangler-fig migration to a Vue 3 client,
  server-rendered chrome with a client-owned `<main>`, a shared route manifest, cookie-only
  `/api/ui/*` props, `X-Hanse-Client` mutation branches, deterministic E2E fixtures, and per-route
  rollback. Status: approved (`oracle` round 5 PASS, 2026-10-28); plan 0031 approved (`momus`
  round 3 PASS); Phases 0-7 complete; `/`, `/projects`, `/projects/:id`, `/handoffs`, `/ssh`, settings, skills,
  and application detail are cut over. D1 was revised: chat and terminal are scheduled for a
  separate design/plan migration, then operator verification and Phase 8 cleanup.
- [Client-owned application chrome](./client-owned-chrome.md) - removing the server-rendered chrome
  fragment contract from SPA documents: data-only `ChromeData`, a static document shell, Vue-rendered
  sidebar/breadcrumb/theme/drawer/sign-out, `usePageChrome`, the `/api/ui/auth` probe, and the
  `X-Hanse-UI-Version` hard-cutover gate. Status: approved (Oracle round 7 PASS; §10 amendment PASS);
  plan 0040 approved (`momus` PASS); implemented and verified (journal 0048).
- [Zero SSR](./zero-ssr.md) - removing the last server-rendered page/chrome path: JS-required login,
  Vue 404 for unknown/missing resources, self-contained static 500/503, Vue chat-no-apps, deletion of
  `app.js`/`app-content.js` and the `HANSE_UI_LEGACY`/`?legacy=1`/`HANSE_UI_SPA_ROUTES` rollback
  machinery. Status: approved (Oracle round 2 PASS WITH FIXES, findings folded); plan 0042 approved
  (`momus` OKAY); implemented; targeted and UI gates green, full repository gate blocked by unrelated
  concurrent notification-stage changes (journal 0049).
- [Idle agent maintenance](./idle-agent-maintenance.md) - a durable per-app activity clock, a
  maintenance scheduler (auto-stop after two days, conditional auto-update after three hours), a
  runner-side streaming image pull with an exact allowlist, a serialized mutation mutex, and a
  fail-closed disk guard, an active-terminal veto, and a **Rebuild only** chat action. Status: design
  approved (Oracle round 6 PASS WITH FIXES); plan 0043 `momus` OKAY; implemented and verified
  (journal 0051).
- [Chat and terminal SPA migration](./chat-terminal-migration.md) - migrating `/chat` and
  `/terminal` to the Vue client before legacy cleanup: the SSE/WebSocket lifecycle inventory,
  the Vue/legacy island trade-off, a recommended hybrid incremental port (terminal first, chat in
  vertical slices), an explicit event-reducer/state-to-slice inventory, workspace shell/route props,
  the six shared-module keep list, boot-carried `spaRoutes`/client route records, copy-first feed
  store, post-cleanup `legacyRetired` rollback semantics, and the deployment-host operator
  verification gate that must precede deleting the legacy renderers. Status: approved (`oracle` round 5 PASS; owner decisions Q1-Q6 closed).
- [Architecture overview](./overview.md) - the coordinator architecture and stage plan.
- [Agent runtime isolation and per-app toolchains](./agent-runtime.md) - staged B0/B1/B2 runtime split, layered agent images, per-app containers, app image builds, and deployment constraints. Status: proposed, revised after design review.
- [Agent process protection and interrupted-turn recovery](./agent-process-protection.md) - safe-test instructions, narrow bash self-kill denies, runtime-epoch stop detection, persisted system notices, subagent parent signals, and recency-guarded top-level session resume. Status: deployed (design `oracle` round 10 PASS; journal 0037; commit `25e5c81`).
- [Agent process lifecycle and status tracking](./agent-process-status.md) - durable current process state and history, a human-only read API and an always-on process SSE, and distinct starting/stopping/error surfaces in chat, the application page, and the overview. Status: design `oracle` round 3 PASS; plan `momus` round 2 OKAY; implemented and verified (journal 0043).
- [Telegram notifications](./telegram-notifications.md) - a coordinator-side notifier for turn completion (no running subagents, no in-flight handoff reply), interactive prompts, SSH and handoff approvals, and agent interruption; full-answer rich messages, a durable outbox, hierarchical settings with encrypted bot token/proxy, a configurable public base URL, and session links. Status: design review `oracle` round 6 PASS WITH FIXES (findings folded); plan `momus` OKAY WITH FIXES (findings folded); implemented and verified (journal 0050).

## Run the showcase

From the repository root:

```bash
npm run build:css
npm run design:showcase
# open http://localhost:4173/docs/design/showcase.html
```

Query parameters:

- `?theme=dark` or `?theme=light` - pin a theme.
- `?capture=1` - document-flow mode so a full-page screenshot includes every specimen.
- `?focus=1` - focus the project-name input for focus-visible evidence.

## Evidence

`node docs/design/capture.mjs` writes real Playwright Chromium screenshots to
[`artifacts/`](./artifacts/):

- `showcase-{390,768,1440}-{dark,light}.png`
- `shell-{1440,390}-{dark,light}.png` and `shell-390-drawer-dark.png`
- `focus-visible-1440-dark.png`
- `dialog-1440-{dark,light}.png`, `toast-1440-{dark,light}.png`, `tooltip-1440-dark.png`
- `git/` - Application page and git panel captures at 390/768/1440 plus deterministic state
  captures (see [`artifacts/git/README.md`](./artifacts/git/README.md)).
- `ux/` - UX polish captures for the application page, settings, and terminal at 390/768/1024/1440,
  dark and light, plus `report.json` (see [`artifacts/ux/README.md`](./artifacts/ux/README.md)).
- `skills/` - managed skill inventory, workspace, create, repair, inherited, and no-JavaScript
  captures at 390/768/1024/1440, dark and light, plus `report.json` (see
  [`artifacts/skills/README.md`](./artifacts/skills/README.md)).
- `previews/` - deterministic app-preview chat states (empty, 1/3/8, tool card, close/error, 404/502,
  long name, 390/1440, dark/light) plus `report.json`; run `node docs/design/preview-qa.mjs`.

## Chat QA

The deterministic harness is SPA-only. Targeted runs use
`CHAT_QA_ONLY=<name> node docs/design/chat-qa.mjs`, for example
`CHAT_QA_ONLY=turn-status node docs/design/chat-qa.mjs`. The full deterministic run still stops at
the pre-existing `main` feed/composer width assertion (`501` vs `568`), whose legacy selectors and
measurements predate the SPA chat cutover; targeted SPA scenarios are the usable path and do not
attribute that failure to a single stage.

`node docs/design/chat-qa.mjs` is the phase-6 browser gate for the chat UX overhaul. It self-starts
a throwaway server (or targets `CHAT_QA_URL`/`CHAT_QA_TOKEN`), intercepts `/api/apps/**` with
deterministic fixtures, and writes screenshots plus `report.json` to
[`artifacts/chat/`](./artifacts/chat/README.md). It exits 1 on any failed assertion, console error,
or page error. `--live` runs a real managed-agent smoke when `CHAT_QA_URL`, `CHAT_QA_TOKEN`, and
`CHAT_QA_LIVE_SESSION` are present.

`node docs/design/ux-qa.mjs` is the UX polish browser gate. It targets `UX_QA_URL`/`UX_QA_TOKEN`
with the seeded fixture described in [`artifacts/ux/README.md`](./artifacts/ux/README.md) and writes
the same kind of report and screenshots.

`node docs/design/skills-qa.mjs` is the browser gate for the skill bundles and workspace. It
self-starts the throwaway fixture in [`skills-qa-server.mts`](./skills-qa-server.mts) with the
repository's local `tsx`, seeds a temporary SQLite database with synthetic global/project/application
skills (including inherited, disabled, and invalid-metadata rows), and writes screenshots plus
`report.json` to [`artifacts/skills/`](./artifacts/skills/README.md). It covers inventory,
side-by-side and narrow workspace layouts, save/discard, JSON 400 focus, reference and metadata
editing, invalid-metadata repair, inherited override/disable/revert, create 409/422, the no-JS
stacked-editor and snapshot round-trip, and the shared safe Markdown renderer. It exits 1 on any
failed assertion, missing screenshot, unexpected console error, or page error.

All scripts resolve an installed Playwright module and Chromium build; they add no Playwright
dependency to the product.
