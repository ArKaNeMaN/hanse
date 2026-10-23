# Journal

Stage records and decision log. One entry per completed stage; link artifacts by path, do not restate
them.

- `0001-core.md` - stages 0 and 1 of the core coordinator (stage 1 done; spike deferred).
- `0002-web-redesign.md` - the from-scratch web UI redesign (The Chart Room), stages 2-3 and final QA.
- `0003-git-workbench.md` - the Application page, human-only git API, client panel, verification, and accepted debt.
- `0004-session-lifecycle.md` - lazy chat session creation on first send, human-only session deletion, and the draft state.
- `0005-interactive-prompts.md` - question/permission docks, v1+v2 prompts, Todo/Plan panel, saved permissions, and the permission guardrail.
- `0006-chat-ux-overhaul.md` - typed chat streaming, optimistic send/queue, status model, inline questions/Q&A, OMO cards, tool/table renderers, feed measure, browser QA harness, and accepted debt.
- `0007-web-tools-and-settings.md` - hierarchical settings and encrypted provider keys, DeepSeek/built-in web drivers, per-app OMO model profiles, restart workflow, security review, and accepted risks.
- `0008-chat-pagination.md` - 30-message session tail, cursor-based scroll-up history, overlap-aware snapshot merge, in-feed generation indicator, verification, and residual risks.
- `0009-packaging-and-publishing.md` - reproducible multi-arch image, Compose release/build/auth overlays, `/healthz`, CI container gate, GHCR publishing, and the public deployment guide.
- `0010-chat-diff-highlighting.md` - vendored Prism worker, lazy open-only syntax-highlighted `edit`/`apply_patch`/`write` diffs, server caps, CSS/theme, unit + browser QA, and accepted debt.
- `0011-ssh-host-access.md` - coordinator-held SSH hosts, per-app grants, idle approvals, keyless MCP exec/SFTP, host-key pinning, audit, and deploy notes.
- `0012-git-credentials.md` - per-app SSH/HTTPS credentials in hierarchical settings, encrypted storage, agent-readable materialization, read-only workbench reuse, draft Test connection, and deployment notes.
- `0013-ux-polish.md` - application-page hierarchy, compact settings, xterm terminal, truthful runtime/chat state, migration v10, browser QA, and accepted debt.
- `0014-settings-live-save.md` - server-rendered settings fragments, in-place section swaps that preserve open rows/drafts/focus/scroll, Git/provider saves, no-refresh browser QA, and accepted debt.
- `0015-project-and-application-deletion.md` - human-only app/project deletion, durable markers, runtime/network/image cleanup, manifest/state/DB removal, handoff/events audit, guarded source deletion, HTTP/UI, review fixes, and residual risks.
- `0016-runtime-state-reconciliation.md` - startup/periodic runner reconciliation for stale `running` rows, persisted not-running restarts, and neutral restart-failure copy.
- `0017-context-compaction.md` - server-side context usage accounting, provider limits, manual compaction, threshold auto-compaction, chat meter/rail, live settings, tests, browser QA, and the `sha-50acf4f` deploy.
- `0018-agent-skills.md` - global/project/application skill registry in the coordinator DB, tombstone resolution, deterministic per-instance materialization, collision warnings, restart hashing, human-only scope pages, deletion integration, and verification; implemented, verified, and deployed as `sha-33523f1`.
- `0019-deployment-safety.md` - deployment lock and quiescence, schema guard, readiness/version, async restart, MCP-token reconciliation, manager-owned image rollback, CI-gated publishing, full-SHA/revision identity, independent image tags, and accepted debt.
- `0020-skill-bundles.md` - modular `SKILL.md` + `references/*.md` bundles, structured metadata, transactional storage, backward-compatible materialization hash, inventory and side-by-side workspace, shared Markdown renderer, no-JS fallback, browser QA, and accepted debt.
- `0021-hanse-master.md` - the built-in master agent: reserved application identity, read-only app directory, allowlisted MCP tools, shared provisioning, confined workspace file tools, hidden operator surface, deletion guards, and accepted risks.
- `0022-master-skill-creation.md` - master-authored skill bundles at global/project/app scope, service-reused validation, global confirmation, target/deletion guards, atomic skill+audit transaction, content-free result, restart reporting, and accepted risks.
- `0023-master-skill-management.md` - full master skill management: list/read/update/enable-disable/override, global and replacement confirmations, atomic audit, content-free mutations, manual deletion/revert/rename, and accepted risks.
- `0024-app-skill-authoring.md` - app-scope create/list/get/update/enable/override tools over the app MCP surface, token-bound targets, readable-set and by-id authorization, content-free audit, manual restart, and accepted self-modification risk.
- `0025-slash-commands.md` - one opencode/Hanse command palette, v1 command proxy with detached 202 and SSE output, explicit template withholding and shell tri-state confirmation, six Hanse actions, 25 skipped TUI commands, browser QA, and the deferred live smoke.
- `0026-app-previews.md` - path-based app previews, app-scoped in-memory MCP registry, runner-only proxy with HTTP/WS hardening, chat tool-card and conditional rail UI, browser QA, verification, and the accepted same-origin demo risk.
- `0027-add-app-git-credentials.md` - add-app clone with global/project SSH and HTTPS credentials in an ephemeral `0700` directory, scheme-specific behavior and clear missing-key errors, minimal child env plus hardening, sanitized failures, cleanup/startup sweep, both provisioning entry points, and the accepted master authentication-oracle capability.
