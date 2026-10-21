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
- [SSH host access](./ssh-host-access.md) - global operator-defined SSH hosts, per-app grants,
  coordinator-side exec/SFTP through a keyless MCP bridge, idle-based approvals in chat, and
  automatic host-key pinning.
- [Chat pagination and generation indicator](./chat-pagination.md) - 30-message session tail,
  cursor-based scroll-up history, overlap-aware snapshot merge, and the in-feed generation row.
- [Architecture overview](./overview.md) - the coordinator architecture and stage plan.
- [Agent runtime isolation and per-app toolchains](./agent-runtime.md) - staged B0/B1/B2 runtime split, layered agent images, per-app containers, app image builds, and deployment constraints. Status: proposed, revised after design review.

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

## Chat QA

`node docs/design/chat-qa.mjs` is the phase-6 browser gate for the chat UX overhaul. It self-starts
a throwaway server (or targets `CHAT_QA_URL`/`CHAT_QA_TOKEN`), intercepts `/api/apps/**` with
deterministic fixtures, and writes screenshots plus `report.json` to
[`artifacts/chat/`](./artifacts/chat/README.md). It exits 1 on any failed assertion, console error,
or page error. `--live` runs a real managed-agent smoke when `CHAT_QA_URL`, `CHAT_QA_TOKEN`, and
`CHAT_QA_LIVE_SESSION` are present.

Both scripts resolve an installed Playwright module and Chromium build; they add no Playwright
dependency to the product.
