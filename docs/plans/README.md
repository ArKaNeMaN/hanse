# Plans

- [0001 - Core coordinator](./0001-core.md) - stages 0.5-8 (state, launcher, queue/lock, identity, MCP, HTTP, secrets, hardening).
- [0002 - Git workbench](./0002-git-workbench.md) - application page, git status/fetch/update/switch/commit/push, client panel, tests, docs.
- [0003 - OMO baseline and isolation](./0003-opencode-baseline-and-isolation.md) - discussion draft: OMO baseline, project/app MCP/plugin config, confinement questions.
- [0004 - Interactive prompts](./0004-interactive-prompts.md) - question/permission docks (v1+v2), Todo panel, saved permissions, permission policy, tests, rollout.
- [0005 - Chat UX overhaul](./0005-chat-ux-overhaul.md) - typed streaming, optimistic send and upstream queueing, status model, inline questions/Q&A, OMO system cards, tool renderers, tables, feed measure, QA, deploy. Status: complete (QA evidence in journal 0006); deployment pending.
- [0006 - Web tools and hierarchical settings](./0006-web-tools-and-settings.md) - global/project/app settings, encrypted provider keys, model + OMO profiles, builtin/DeepSeek web drivers, per-app web MCP, explicit restart. Status: implemented and verified (journal 0007); commit/deployment pending.
- [0007 - Chat session pagination and in-thread generation indicator](./0007-chat-pagination.md) - 30-message tail on open, cursor-based scroll-up history, overlap-aware snapshot merge, in-feed generation row. Status: implemented and verified (journal 0008); commit pending.
