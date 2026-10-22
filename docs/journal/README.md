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
- `0018-agent-skills.md` - global/project/application skill registry in the coordinator DB, tombstone resolution, deterministic per-instance materialization, collision warnings, restart hashing, human-only scope pages, deletion integration, and verification; implemented and verified, not deployed.
- `0019-deployment-safety.md` - deployment lock and quiescence, schema guard, readiness/version, async restart, MCP-token reconciliation, manager-owned image rollback, CI-gated publishing, full-SHA/revision identity, independent image tags, and accepted debt.
