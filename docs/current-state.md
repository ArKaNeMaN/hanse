# Hanse - Current State (read this first)

> Last updated: 2026-10-20. This is the canonical description of what is **implemented right now**.
> If this document and the code disagree, the code wins - update this document.
> History and rationale: `docs/design/overview.md`, `docs/plans/0001-core.md`,
> `docs/journal/0001-core.md`. Deployment: `docs/deployment.md`.

## What it is

A self-hosted coordinator/workbench. A **project** contains **applications**; each application runs an
isolated `opencode` agent; applications can hand structured requests (specs) to siblings through the
coordinator. The product surface is one web UI (dashboard + chat + handoffs) plus an embedded web IDE.

## Stack and repository

- Repository: `github.com/ArKaNeMaN/hanse` (branch `main`). Local checkout: `dev/hanse`.
- TypeScript, ESM, Node >= 20, npm.
- Build: `tsc` plus Tailwind CSS (`npm run build:css` -> `assets/app.css`). Tests: vitest. Lint/format:
  Biome. Schemas: zod. YAML: `yaml`. Database: `better-sqlite3`.
- Public OSS; license not chosen yet.

## Runtime topology (B1 core: runner + per-app containers)

Four multi-arch images are built from `Dockerfile`: `ghcr.io/arkaneman/hanse` (coordinator),
`hanse-agent-ide` (IDE), `hanse-runner` (runner), and `hanse-agent-default` (per-app agent).
Publish currently targets `linux/amd64`; arm64 is on-demand/backlog. Compose definitions live in
`compose.yaml`; `compose.build.yaml` adds a source build, and `compose.host-auth.yaml` mounts a host
`opencode` auth file.

- **`hanse`** (coordinator): runs `node dist/index.js serve --workspace /data/workspace`. Mounts
  `./workspace:/data/workspace`, `./state:/data/state`, and `./agents:/data/agents`; the host opencode
  auth file is optional. Talks to the runner at `http://runner:8790` with `HANSE_RUNTIME_TOKEN`.
  `HANSE_IDE=0` means it does **not** spawn code-server itself.
- **`hanse-ide`** (VS Code): runs `agent-ide` with code-server and the default toolchains. Mounts
  **only** `./workspace:/data/workspace` (no `state` or `agents`). Serves on `8080`, reachable only on
  the `front` network.
- **`hanse-runner`**: the only Docker socket holder. It runs on the internal `control` network, has
  no `/data/state`, and mounts the host agents volume read-only for per-app passwords. It validates
  runtime specs and creates one app container per application.
- **`hanse-app-<project>-<app>`** (dynamic): one `agent-default` container per app, on its own
  `hanse-app-*` bridge network. It mounts only the app directory and `/data/agents/<project>/<app>`;
  uid 1000, read-only root, `cap_drop: ALL`, no state, no Docker socket, no operator/runtime token.
  `opencode serve` listens on `0.0.0.0:4100` inside the app network.
- **Networks:** `front` contains the coordinator and IDE; `control` contains the coordinator and
  runner; each app container has its own network. App containers cannot reach the IDE or sibling apps.
- **Exposed port:** `${HANSE_BIND:-127.0.0.1}:${HANSE_PORT:-8787}` (loopback by default; set
  `HANSE_BIND=0.0.0.0` or a LAN IP to expose it). `/healthz` is an unauthenticated liveness endpoint.
  `/` and `/api/*` are our UI; `/ide/*` is reverse-proxied to `ide:8080` (HTTP and WebSocket), with
  `/ide` stripped and `?folder` confined to the workspace root. The coordinator is the single front
  door.

## Auth (one login)

- One operator token (`HANSE_OPERATOR_TOKEN`), stored hashed as a human principal named `operator`.
- Browser: `POST /login` sets the `hanse_token` cookie (`HttpOnly`, `SameSite=Strict`). Mutating
  endpoints and `/ide/*` require it.
- The IDE extension authenticates to the coordinator with the same token via `HANSE_API_BASE`
  (`http://hanse:8787`) and `HANSE_OPERATOR_TOKEN`.
- No separate IDE password; code-server runs with `--auth none` and is only reachable through the proxy.

## Web UI (stages 2-3)

- Shared server-rendered shell (`src/http/ui.ts`): fixed sidebar, top bar with breadcrumb and global
  IDE link, mobile drawer, sidebar theme toggle (dark default, `localStorage["hanse-theme"]`),
  sign-out, skip link, notice toasts, and the full status/icon/dialog primitive set.
- Authenticated pages: `/` fleet overview, `/projects`, `/projects/:id`,
  `/projects/:id/apps/:appKey`, `/settings`, `/projects/:id/settings`,
  `/projects/:id/apps/:appKey/settings`, `/handoffs`, and the `/chat?app=<key>&project=<id>`
  workspace.
  `/login` is a standalone cover/plate. All HTML pages except `/login` and `/assets/*` require a
  **human** principal; unauthenticated requests redirect to `/login?next=<validated local path>`.
- Browser forms post to the existing API endpoints and receive a 303 back to a validated `return_to`
  with a `notice`/`tone` toast. JSON API behavior is unchanged for non-browser callers.
- Handoff decisions use `POST /api/handoffs/:id/decision` (`decision=approved|rejected`, optional
  `reason`, `return_to`); the legacy `/approve` and `/reject` endpoints still work.
- Static assets are allowlisted: `/assets/app.css`, `/assets/app.js`, `/assets/chat.js`,
  `/assets/chat-core.js`, `/assets/chat-diff.js`, `/assets/chat-highlight.js`,
  `/assets/chat-highlight-worker.js`, `/assets/git.js`, `/assets/settings.js`,
  `/assets/vendor/prism/prism-1.30.0.min.js`, and `/assets/favicon.svg`.
- `assets/app.js` adds shell drawer, native-dialog, theme, toast, password-visibility, and
  submit-busy behavior. `assets/chat.js` is an ESM module that owns the chat workspace (sessions,
  messages, typed SSE, composer, queue, questions, OMO cards, safe markdown/tables, syntax-highlighted
  diffs/write content) and imports the pure helpers in `assets/chat-core.js`, `assets/chat-diff.js`,
  and the lazy worker controller in `assets/chat-highlight.js`. `assets/git.js` hydrates the
  application git panel. Pages remain server-rendered; no bundler or client framework is used.
- The chat workspace is the stage-3 three-pane surface: sessions rail, thread, and context rail.
  Below 1360 the context pane is a drawer; below 768 both rails are drawers. The thread is the only
  scroll owner. `session` is mirrored to the URL, and the optional `project` query disambiguates
  duplicate app keys across projects.

## Git workbench

- The Application page (`/projects/:projectId/apps/:appKey`) is human-only and server-rendered; the
  git panel is hydrated by `assets/git.js`. It is linked from the project application table, the chat
  context rail, and the chat breadcrumb.
- Human-only JSON API under `/api/projects/:projectId/apps/:appKey/git`:
  `GET /status`, `POST /fetch`, `/update`, `/push`, `/commit`, `/branches/switch`. Mutations are
  JSON-only and require the operator session; agent principals receive `403`.
- Status shows the current branch or detached HEAD, unborn branches, upstream ahead/behind, clean/
  dirty state, staged/unstaged/untracked/conflicted files, local branches, remotes, the last commit,
  in-progress operations, and commit-identity readiness.
- Actions: fetch all remotes; fast-forward update (`pull --ff-only`); switch a local branch; commit
  all tracked, unstaged, and untracked changes with a message; push (setting an upstream when absent
  and `origin` exists).
- The application directory must be the repository root and inside the workspace; git runs with
  argument arrays, timeouts, bounded output, and per-repository serialization.

## Agents and chat

- `opencode` (`opencode-ai@1.19.3`) is installed in the agent and IDE images.
- The coordinator asks the runner to **ensure one app container per (project, app)** lazily on first
  chat use. The runner creates the container, app network, app/agents bind mounts, and coordinator
  network alias. `opencode serve` listens on `0.0.0.0:4100` inside the app container, with isolated
  `XDG_*`, `OPENCODE_DB`, and `TMPDIR` under
  `/data/agents/<projectId>/<appKey>/{home,data,state,config,cache,tmp,mise}`. The app `auth.json`
  and opencode password live in that per-app state; model access works (verified with `deepseek`).
- Every managed instance also loads the image-baked OMO baseline
  (`oh-my-openagent@5.1.35`, `/opt/hanse/omo`) through `HANSE_OMO_PLUGIN`. The coordinator writes a
  per-app profile at `<app-home>/.omo/omo.jsonc` and pins OMO agents/categories to
  `deepseek/deepseek-flash`. Per-project/per-app MCP and plugin inheritance is not implemented yet.
- Every managed instance also gets the codegraph MCP server
  (`@colbymchenry/codegraph@1.6.2`, `/opt/hanse/codegraph`) through `HANSE_CODEGRAPH_BIN`. The
  application must be indexed with `codegraph init` (creates `.codegraph/`) before graph queries
  return data.
- Our chat UI (`/chat?app=<appKey>&project=<projectId>`) lists/filters sessions, streams assistant
  text and running tool output, renders tool calls (output/error/previews), reasoning, patches,
  syntax-highlighted `edit`/`apply_patch` diffs, `write` content, and completed `read` output
  (parsed path, line numbers, code, and status footer), GFM pipe tables, and OMO system cards, and
  sends prompts optimistically. Diff highlighting is lazy and open-only: a checked-in
  PrismJS 1.30.0 bundle runs in a module Web Worker with a 250 ms per-stream budget, 8/64 KiB
  language-aware stream caps, a 120k-node page budget, and plain fallback. Diffs are capped at
  64 KiB per file / 128 KiB total / 50 files / 2,000 rendered lines; highlighting is hunk-local and
  does not see code before a hunk. The optional `project` query is additive and disambiguates
  duplicate app keys. API:
  `GET/POST /api/apps/:app/sessions`, `DELETE /api/apps/:app/sessions/:sid`,
  `GET/POST /api/apps/:app/sessions/:sid/messages`; all accept `?project=<projectId>`.
  `GET .../messages` accepts optional `limit` (1..200) and `before` (an opaque upstream cursor);
  with `limit` it returns `{messages, nextCursor}` and the chat opens a 30-message tail. Without
  `limit` the legacy `{messages}` full-history response is unchanged.
  `POST .../messages?async=1` accepts `{text}` and returns `202 {accepted, messageID, sessionID}`
  without waiting for the turn; the blocking route without `async` keeps its `200 {message}`
  response. Async text is capped at 32 KiB; an older upstream without `prompt_async` returns
  `502 async_unavailable`, and the blocking route remains available.
- The app-level SSE (`GET /api/apps/:app/events`) carries typed frames
  (`stream.ready`, `message.updated`, `message.part.updated`, `message.part.delta`,
  `message.part.omitted`, `session.status`, `session.error`, `session.activity`, `todo.updated`,
  question/permission events, `stream.warning`) enveloped with `seq` and `streamID`. `stream.ready` starts at `seq: 0`;
  the client drops `seq <= lastSeq` per stream, hydrates on a new `streamID`, and schedules one
  reconcile on a gap or `frame_too_large`/`invalid_json`/`delta_too_large` warning. Caps: 8 MiB app
  SSE frame, 256 KiB typed event, 64 KiB delta/text snapshot/tool output/patch, 64 KiB per-file
  diff/write content/patch input, 128 KiB total diff per part, 50 file records, 1 KiB per path /
  16 KiB total paths, 8 KiB `truncated.fields`, and an 8 MiB `GET /messages` response
  (`502 messages_too_large` over cap; the client keeps its last feed and shows the too-large notice).
  `truncated.limit` distinguishes per-file/total/content/patch/output/files cuts.
- The feed is patched through keyed message/part nodes with one `requestAnimationFrame` flush:
  markdown re-renders at most every 50 ms while streaming (and once on seal/idle), running tool output
  at most every 100 ms (and once on completion), and the feed is never replaced on a token. Snapshot
  hydration seals completed messages, leaves only the last uncompleted assistant's text/reasoning
  unsealed, merges optimistic rows by server ID, and preserves open tool disclosures and scroll.
  The client loads a 30-message tail on open and prepends 30-message older pages when the thread is
  scrolled near the top; the scroll anchor is preserved and prepends never show the "New messages"
  affordance. Tail hydration merges by message ID and keeps loaded history; a provably disjoint tail
  (more than a page missed while disconnected) resets to a contiguous window. An older-page failure
  is terminal per kind (bad cursor, missing session, oversize) or retryable on the next top-scroll.
- A decorative in-feed generation row (`#chat-generating`) mirrors the active status label
  (`Sending`, `Thinking`, `Working`, `Running <tool>`, `Retrying`) and elapsed time inside the
  conversation. It is `aria-hidden` (the meta chip remains the live region) and honors
  `prefers-reduced-motion`.
- Send/queue behavior: a submitted prompt appears immediately as an optimistic operator row
  (`sending`, then `accepted` after the 202; `queued` while the agent is busy; `unknown` during the
  delivery-unknown grace). The queue strip above the prompt dock is derived from upstream history
  (last visible assistant `parentID`, `finish:"tool-calls"`/idle overrides, bare shells ignored), shows
  up to three one-line previews plus `+N more`, excludes the active head and OMO rows, and has no
  remove control. The status line appends `· N queued` only on the allowed labels.
- Status is derived from `session.status`, the latest part, and the queue:
  `Sending`, `Thinking`, `Working`, `Running <tool>`, `Waiting for you`, `Ready`, `Retrying`,
  `Paused`, with elapsed time that freezes while waiting and resets on `Ready`. Inline questions in
  the feed gate the composer and show `Waiting for you`; the top-bar/per-session counts include them.
- Upstream `session.error` is projected with a 2000-char first-line message (stack traces are
  dropped) and deduplicated per attempt (`session.status: busy` resets the dedupe). The client inserts
  an `Agent error` card into the feed, marks the active and queued prompts `Failed`, drops them from
  the queue, releases the composer, and settles the session to idle, so a failed turn never looks
  hung.
- The chat workspace renders GFM pipe tables (alignment, escaped pipes/code spans, 16-column and
  200-row caps, no raw HTML), one-line tool previews, a `todowrite` checklist, streamed bash output
  with a 64 KiB live-tail window and truncation notice, and collapsed `Thinking` reasoning. OMO
  internal/synthetic messages are classified client-side into system cards (markers and
  `<system-reminder>` tags hidden, long results collapsed) and are excluded from the queue; no
  server OMO field or persistence is added.
- Layout: at `>=1024` the feed and composer share one centered content box sized
  `min(100%, max(60ch, 75%))` with a `96rem` cap (about 75%, floor-driven ~87% at 1440, and 75% at
  1920); below 1024 both are 100%. The feed/composer share horizontal padding, tables/tool bodies use
  the full feed width, and assistant prose stays near a 68ch reading measure. There is no horizontal
  page overflow at 390.
- Sessions are created lazily: opening a chat or pressing "New session" only starts a draft, and the
  first message creates the upstream session. Deletion is human-only (`403` for agent principals),
  proxies opencode `DELETE /session/:id`, and the UI selects the next session or returns to the draft
  when the active one is removed.
- The chat workspace renders interactive opencode prompts above the composer:
  - **Questions** support one or many questions, options, multi-select, custom answers, review, and
    dismissal. Questions correlated to a `question` tool part render inline at that part (and become
    read-only Q&A cards after completion); uncorrelated questions stay in the dock. Empty answers are
    allowed after an explicit "Send without answering?" confirmation. Single-select questions in a
    multi-question block auto-advance with focus and one announcement; multi-select does not
    auto-advance, and a single-question block does not auto-submit. Custom-answer Enter submits the
    current step once.
  - **Permissions** show the type, patterns, bounded metadata, and `once`/`always`/`reject` with
    optional feedback. v1 `always` lasts for the app instance until restart; v2 `always` is a durable,
    project-scoped saved permission. A reject also rejects other pending permissions in the same
    session.
  - Prompt sources are v1 and v2 (`source` on every request/reply); v2 replies use the
    session-scoped upstream routes. `tooLarge` requests are dismiss-only.
  - The session **Plan** panel shows opencode's Todo list in the context rail (with a `Plan N/M`
    chip below 1360), updates on `todo.updated`, and is read-only. v2 saved permissions are listed
    and revocable in the context rail.
  - A top-bar stamp/count surfaces requests waiting in other sessions of the same app, with
    per-session flags in the sessions rail. Policy warnings from `/prompts` render as a banner/chip.
- API for prompts, Todo, and events (human-only; agent principals get `403`):
  `GET /api/apps/:app/prompts`, `POST /api/apps/:app/questions/:id/reply|reject`,
  `POST /api/apps/:app/permissions/:id/reply`,
  `GET/DELETE /api/apps/:app/permissions/saved[/:id]`,
  `GET /api/apps/:app/sessions/:sid/todo`, and the typed app-level SSE
  `GET /api/apps/:app/events`; all accept `?project=<projectId>`. The old raw
  `GET /api/apps/:app/sessions/:sid/events` remains for compatibility but is no longer used by the
  chat client. The typed app SSE keeps its heartbeat, backpressure, and `session.activity`
  compatibility frames for older clients.
- Every managed instance receives an explicit permission overlay (`OPENCODE_CONFIG_CONTENT`):
  `external_directory` is deny-all outside the app plus trusted runtime roots (tool-output, git repos
  cache, temp, per-instance config/cache skills, `~/.claude/skills`, `~/.agents/skills`, bundled
  plugin skills); `question`, `todowrite`, `todoread`, `webfetch`, `websearch`, and `.env`
  read/write are allowed; `.opencode` config/plugin edits are denied; `doom_loop` asks. The
  coordinator strips its own credentials (`HANSE_OPERATOR_TOKEN`, `OPENCODE_PERMISSION`, etc.) from
  the instance environment and sets `GIT_CEILING_DIRECTORIES` to the app's real parent so a nested
  app cannot inherit a wider parent worktree. Effective rulesets are verified after start with a
  **warning-only** result (no startup block). For built-in web drivers `webfetch`/`websearch` remain
  allowed; a managed search/fetch driver denies the corresponding built-in and allows
  `hanse_web_search`/`hanse_web_fetch`.

## Settings and web tools

- Human-only settings pages: `/settings`, `/projects/:id/settings`, and
  `/projects/:id/apps/:appKey/settings`. Values resolve global -> project -> application. Missing
  rows inherit; `null`/`cleared` is an explicit empty override. `llm.model` is a non-clearable scalar
  with default `deepseek/deepseek-flash`; `web.search` and `web.fetch` default to `{driver:"builtin"}`
  and are clearable.
- `settings` and `provider_keys` live in `coordinator.db` (migration v3). Provider API keys are
  entered in the settings UI, AES-256-GCM encrypted, and never returned. At instance start the
  coordinator reconciles the host `auth.json` with effective provider keys into the per-instance
  `auth.json` (mode 0600), scrubs inherited `OPENCODE_AUTH_CONTENT`/profile env, and removes stale
  entries.
- Web drivers are selectable per tool: `builtin` (OMO `websearch` MCP for search, opencode
  `webfetch` for fetch) and `deepseek` (standalone `/v1/tools/search` and `/v1/tools/fetch`). A
  managed driver disables the corresponding built-in: search adds `websearch` to the OMO profile's
  `disabled_mcps` and denies the permission; fetch denies `webfetch`. The `hanse_web` stdio MCP
  server is registered only when at least one managed tool is configured and exposes `search`/
  `fetch` (opencode names them `hanse_web_search`/`hanse_web_fetch`).
- The selected model is written to `OPENCODE_CONFIG_CONTENT.model` and to an app-specific OMO
  profile under `~/.omo/omo.jsonc`, selected with `OMO_PROFILE`. The profile pins every OMO
  agent/category and carries `disabled_mcps`; it is applied at instance start. A post-start `/agent`
  check records a warning when an agent reports a different model (for example through a project
  `.omo` layer).
- Settings never auto-restart an agent. Running instances record the effective settings/auth/profile
  hash and `appliedProfile`; the app, chat, and settings surfaces show "Restart required" and a
  restart action. Chat prompts carry the effective `llm.model`, so existing sessions switch model on
  the next message; OMO subagents use the profile and change only after a restart.
- CLI: `hanse web-mcp` runs the managed web tools MCP server (internal; spawned by opencode).
- API: `GET/POST /api/settings`, `POST /api/settings/provider`, and
  `POST /api/apps/:app/restart?project=<id>`; all human-only. Settings responses include effective
  values, sources, raw scoped rows, provider statuses (never key material), warnings, and pending
  restarts.

## Handoffs (agent-to-agent requests)

- Coordinator MCP server: `hanse mcp` (stdio, bound to one app via `HANSE_DB`, `HANSE_PROJECT_ID`,
  `HANSE_APP_KEY`). The per-app opencode overlay (`OPENCODE_CONFIG_CONTENT`) registers it; tools:
  `request_sibling_change` (non-blocking, returns a handoff id), `list_apps`, `handoff_status`,
  `deliver_handoff`.
- Handoffs are durable in SQLite with a state machine (`queued`, `awaiting_approval`, `dispatching`,
  `in_progress`, `delivered`, `rejected`, `failed`, `expired`, `cancelled`). The dashboard shows them and
  a human can approve/reject.
- **Not yet implemented:** automatically waking the target application's agent with the spec and the
  automatic `dispatching -> in_progress -> delivered` transition. There is no built-in dispatch loop;
  `deliver_handoff` is the callback that records a result.

## Web IDE

- Bundled first-party extension `extensions/hanse-agent` (packaged as `extensions/hanse-agent.vsix`,
  installed via `code-server --install-extension`): an activity-bar view with a webview chat that has a
  tab per application, backed by the coordinator API.
- GitHub Theme is installed and `workbench.colorTheme = "GitHub Dark Dimmed"` is the default.
- The IDE opens the specific project/application via `/ide/?folder=<absolute path>` (per-app and
  per-project links in the dashboard). `?folder` outside the workspace is rewritten to the workspace
  root.
- The terminal uses `shell/hanse-shell`, which sets `HOME` to the opened folder, so `cd` stays in the
  project/application.
- VS Code cannot place an extension view in the Secondary Side Bar programmatically; the
  `Hanse: Move Chat to Secondary Side Bar` command opens the move picker (the layout then persists).

## Operator terminal

- Human-only `/terminal?app=<app>&project=<project>` page, linked from the application page.
- The coordinator proxies the WebSocket at `/api/apps/<app>/terminal?project=<project>` to the
  runner's `/v1/apps/<appId>/exec` with the runtime bearer token; the operator cookie is never
  forwarded and no token appears in URLs or HTML.
- The runner opens a TTY exec in the managed app container as uid 1000 with a fixed
  `/bin/bash -l` (or `/bin/sh -l` fallback) and bridges WebSocket frames to the Docker exec stream.
  Only managed app containers resolved by `appId` are reachable.
- Closing or reloading the terminal closes only the exec stream; the app container keeps running.
- The terminal is a plain monospace console, not an xterm emulator. Resize is sent as a JSON control
  text frame and applied through Docker's `/exec/{id}/resize`.

## Data and state layout

Host `./state` is mounted at `/data/state` in `hanse` only:

- `hanse/coordinator.db` (+ `-wal`, `-shm`) - projects, apps, instances, tasks, handoffs, approvals,
  principals, events, secrets, settings, provider keys.
- `hanse/secret.key` - AES-256-GCM key for the credential store and provider keys (mode `0600`).

Host `./agents` is mounted at `/data/agents` read-write in `hanse` and read-only in `hanse-runner`:

- `<projectId>/<appKey>/{home,data,state,config,cache,tmp,mise}` - per-app HOME/XDG, opencode DB,
  scratch, and mise toolchains.
- The reconciled opencode `auth.json`, opencode Basic-auth password, and per-app MCP token live under
  that app's state (`0600`).
- The coordinator-generated OMO profile is `<app-home>/.omo/omo.jsonc`; OMO state is per app.
- Each app container sees only its own `/data/agents/<project>/<app>` root.
- The IDE never sees this volume.

## CLI

- `hanse init [dir]` - scaffold `.hanse/project.yaml`.
- `hanse status [dir]` - discover/register a project and print its apps.
- `hanse serve` - run the web UI/API (`--workspace`, `--hostname`, `--port`, `--state-home`); requires
  `HANSE_RUNTIME_TOKEN` and a reachable B1 runner (`HANSE_RUNNER_URL`).
- `hanse runner` - internal B1 container runner (`--hostname`, `--port`; default `0.0.0.0:8790`).
- `hanse agent-supervisor` / `hanse agent-host` - internal B0 compatibility commands, not used by the
  B1 Compose stack.
- `hanse mcp` - run the coordinator MCP server bound to an app (used by opencode).
- `hanse web-mcp` - run the managed web tools MCP server (internal; spawned by opencode when a
  DeepSeek web driver is configured).

## Environment variables

| Variable | Used by | Meaning |
| --- | --- | --- |
| `HANSE_OPERATOR_TOKEN` | serve, ide | operator token (UI login + extension API); never given to agents |
| `HANSE_RUNTIME_TOKEN` | serve, runner | shared coordinator/runner secret; app containers never receive the operator token |
| `HANSE_STATE_HOME` | serve | coordinator state root (default `~/.local/state`) |
| `HANSE_AGENTS_HOME` | serve | per-app agent state root (default `~/.local/state/hanse-agents`; Compose sets `/data/agents`) |
| `HANSE_RUNNER_URL` | serve | runner base URL (Compose: `http://runner:8790`) |
| `HANSE_HOST_WORKSPACE` / `HANSE_HOST_AGENTS` | serve, runner | absolute host paths used by the runner for app bind mounts |
| `HANSE_AGENT_API_BASE` | serve | coordinator URL passed to agents as the MCP API base (Compose: `http://hanse:8787`) |
| `HANSE_AGENT_IMAGE` | serve, runner | default per-app image; runner requires it to be in its allowlist |
| `HANSE_AUTH_FILE` | serve | host opencode `auth.json`; reconciled with provider-key settings into each app state |
| `HANSE_OMO_PLUGIN` | serve | comma-separated baseline plugin specs injected into every instance |
| `HANSE_CODEGRAPH_BIN` | serve | path to the codegraph CLI used for the baseline MCP server |
| `HANSE_IDE_URL` | dashboard | IDE link (set to `/ide/`) |
| `HANSE_IDE=0` | serve | do not spawn code-server in the coordinator |
| `HANSE_IDE_HOST` / `HANSE_IDE_PORT` | serve | proxy target for `/ide` (default `127.0.0.1:8080`) |
| `HANSE_IDE_BIN` | serve | code-server binary |
| `HANSE_ASSETS` | serve | directory for `app.css`, `app.js`, `chat.js`, `chat-core.js`, `chat-diff.js`, `chat-highlight.js`, `chat-highlight-worker.js`, `git.js`, `settings.js`, `vendor/prism/prism-1.30.0.min.js`, and `favicon.svg` |
| `HANSE_DB` / `HANSE_PROJECT_ID` / `HANSE_APP_KEY` | `hanse mcp` | MCP server binding |
| `HANSE_API_BASE` | extension | coordinator base URL (`http://hanse:8787`) |

`HANSE_WEB_CONFIG` and `HANSE_OPENCODE_AUTH_FILE` are internal `hanse_web` MCP variables set by the
coordinator; operators do not set them.

## Verification

`npm run lint && npm run typecheck && npm test && npm run build` (all green; 915 tests). B1 core
live smoke on `deployment-host`: coordinator/IDE/runner healthy, per-app `demo-app` container running,
`scripts/agent-runtime-probe.sh b1` passes, coordinator recreate reattaches the app network, and the
app agent has no `/data/state`, Docker socket, operator/runtime token, or sibling app access.
B1.4 terminal live smoke: `/terminal` returns `200`, direct runner exec, coordinator proxy, and the
LAN WebSocket each returned `B1_*_OK`, and closing the terminal left the app container running.
B1.6 `hanse-down.sh` live smoke: down removed the static stack and managed app/network; `compose up`
recreated the static services healthy, the app was lazily recreated, sessions returned `200`, and the
terminal page remained human-only (`303` anonymous, `200` authenticated). A subsequent
`up --remove-orphans` preserved the running app.
Chat browser
QA: `node docs/design/chat-qa.mjs` (deterministic fixtures; 3 scenarios, 81 assertions, 10
screenshots, zero console/page errors). Live smoke against a real deployment: 1
scenario, 2 assertions, streaming assistant text and a rendered markdown table, zero console/page
errors. Evidence: [`docs/design/artifacts/chat/`](design/artifacts/chat/README.md).

Settings stage verification:

- Temporary Playwright smoke of seed-generated settings pages at 1440 and 390 (dark): six pages,
  zero console/page errors, zero duplicate DOM ids; screenshots inspected.
- Built image `hanse:qa`, run as uid 1000 with a writable `/home/coder/.omo`, real
  `opencode-ai@1.19.3` + `oh-my-openagent@5.1.35`: the per-app OMO profile was written, `/agent`
  reported `deepseek/deepseek-flash` for the pinned agents, and a second run selected
  `deepseek/deepseek-v4-pro` with `/config` and `/agent` both reporting it (20 profile pins).
  Managed search registered `hanse_web`
  with `search` and removed OMO `websearch` from `/config`, permissions were `websearch: deny` and
  `hanse_web_search: allow`, and restart returned `{restarted:true}` then
  `{restarted:false,reason:"not_running"}`. The managed tool was listed through the real
  `hanse web-mcp`; no paid DeepSeek Search/Fetch call was made (driver tests use a local fake
  server).

## Known limitations and residual risks

- Single user; no RBAC or multi-tenant isolation.
- Trust model: trusted repositories; agents execute code.
- **B1 core runs each app in its own hardened container/network.** App containers have no
  `/data/state`, Docker socket, operator/runtime token, or sibling mounts. The runner is
  root-equivalent through the Docker socket and is trusted/operator-only; it is on the control
  network and holds no coordinator state. B1.5 git-in-runner is not yet complete; GitService remains
  the hardened coordinator implementation. The B1.4 operator terminal is human-only and scoped to
  managed app containers, but it is a line-oriented console rather than a full xterm (no alternate
  screen, mouse reporting, or full ANSI rendering). "Human-only" prompt routes remain a Hanse-route
  guarantee, not a hard
  boundary: an agent with `bash` can call the upstream prompt API directly, including a v2 `always`
  reply that creates a durable project-scoped saved permission.
- The permission overlay is a guardrail, not a sandbox. App-owned `opencode.json`/plugins can widen
  the final ruleset (the `.opencode` edit deny is bypassable with `bash`), verification is
  warning-only by owner decision, `bash` path checks are best-effort, symlinks/bind mounts can
  escape, and `.env`/network are intentionally allowed. B1 adds per-app containers and networks;
  upstream authentication remains a later hardening step.
- Cross-app handoff delivery to a live sibling session is not automatic (see above).
- The OMO baseline is image-wide; the selected model is applied through a per-app profile under the
  app's HOME. A project `.omo/omo.jsonc` layer can override profile pins; the post-start `/agent`
  check is warning-only.
- Settings live in the coordinator DB, not in the repository; they do not travel with a cloned
  project. Provider keys are encrypted at rest, but each app host can read its own `auth.json`
  (model credentials) under `/data/agents`; it cannot read the coordinator DB or `secret.key`.
  Ciphertext is not AAD-bound and key rotation is not implemented; clearing is logical
  (`secure_delete` plus a WAL checkpoint), and physical media/backups may retain old pages.
- Settings changes require an explicit restart to update the OMO profile, web tools, and the
  instance config; a restart interrupts an active turn. Chat prompts carry the effective model, so
  the main session adopts a model change on its next message without a restart; OMO subagents keep
  the profile from instance start.
- Built-in search requires the OMO baseline; without OMO the settings UI warns and no built-in
  search tool is available. Managed DeepSeek web tools depend on a usable provider key and on the
  external DeepSeek Search/Fetch API; there is no per-instance cost budget.
- Codegraph indexes are per application (`<app>/.codegraph/`) and are not built automatically;
  per-app HOME keeps the global codegraph state separate.
- No TLS; intended for a trusted LAN (VPN/reverse proxy for remote access).
- The writer lock is a single-node file lock (`O_EXCL` + pid liveness), not a distributed lock.
- `git clone` in the add-app endpoint is synchronous (`execFileSync`) and blocks the event loop.
- The git workbench requires the application directory to be its own repository root; applications
  inside a larger repository show a "Not a repository root" state.
- "Commit all" stages and commits untracked files (ignored files stay out); there is no per-file
  staging, diff viewer, or conflict-resolution UI.
- Git push/fetch use ambient host credentials (SSH/HTTPS); the encrypted credential store is not wired
  into git in this stage. Commit requires a configured `user.name`/`user.email`.
- Git actions run with a controlled child environment and command-line config that disables
  repository hooks, fsmonitor, credential helpers, ext protocols, submodule recursion, and
  repository SSH commands; remotes are validated (HTTPS/SSH/scp/file inside the app). The git child
  still runs as the coordinator uid and can use coordinator-provided credentials. A per-repository
  in-memory lock serializes UI actions but does not cover agents or the IDE writing to the same
  repository.
- The IDE chat can be moved to the right sidebar only by a one-time user action (VS Code limitation).
- Chat loads a 30-message tail and prepends older pages on scroll-up, but the loaded window is not
  virtualized; very large loaded windows remain the scaling limit. The idle `GET /messages` snapshot
  is capped at 8 MiB (`messages_too_large`); the running tool output shown live is capped to a 64 KiB
  tail and the full result appears only when the whole message snapshot fits the cap (no dedicated
  full-output fetch). Queued messages cannot be
  removed while the agent is busy (upstream `DELETE .../message/:mid` returns 409 `SessionBusyError`),
  the queue is not persisted/reorderable, and there is no client-side holding queue. OMO
  classification is client-only (no server persistence), and permissions always stay in the dock (no
  inline permission cards). Drawers close on Escape/scrim/close but do not trap focus. Markdown is a
  deliberate subset: tables are supported, but there are no images, embeds, or raw HTML, and there is
  no server-side markdown rendering.
