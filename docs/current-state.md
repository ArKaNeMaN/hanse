# Hanse - Current State (read this first)

> Last updated: 2026-10-18. This is the canonical description of what is **implemented right now**.
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

## Runtime topology (two containers, one exposed port)

Both containers use the same image (`hanse:0.1.0`, built from `Dockerfile`).

- **`hanse`** (coordinator): runs `node dist/index.js serve --workspace /data/workspace`. Mounts
  `./workspace:/data/workspace`, `./state:/data/state`, and the host opencode auth file read-only.
  Runs as uid 1000. `HANSE_IDE=0` means it does **not** spawn code-server itself.
- **`hanse-ide`** (VS Code): runs bundled code-server. Mounts **only** `./workspace:/data/workspace`
  (no `state` - `/data/state` does not exist there). Serves on `8080`, reachable only on the compose
  network.
- **Exposed port:** `<LAN_HOST>:8787` (LAN only). `/` and `/api/*` are our UI; `/ide/*` is
  reverse-proxied to `ide:8080` (HTTP and WebSocket), with `/ide` stripped and `?folder` confined to the
  workspace root. The coordinator is the single front door.

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
  `/projects/:id/apps/:appKey`, `/handoffs`, and the `/chat?app=<key>&project=<id>` workspace.
  `/login` is a standalone cover/plate. All HTML pages except `/login` and `/assets/*` require a
  **human** principal; unauthenticated requests redirect to `/login?next=<validated local path>`.
- Browser forms post to the existing API endpoints and receive a 303 back to a validated `return_to`
  with a `notice`/`tone` toast. JSON API behavior is unchanged for non-browser callers.
- Handoff decisions use `POST /api/handoffs/:id/decision` (`decision=approved|rejected`, optional
  `reason`, `return_to`); the legacy `/approve` and `/reject` endpoints still work.
- Static assets are allowlisted: `/assets/app.css`, `/assets/app.js`, `/assets/chat.js`,
  `/assets/git.js`, `/assets/favicon.svg`.
- `assets/app.js` adds shell drawer, native-dialog, theme, toast, password-visibility, and
  submit-busy behavior. `assets/chat.js` owns the chat workspace (sessions, messages, SSE, composer,
  drawers, safe markdown rendering). `assets/git.js` hydrates the application git panel. Pages remain
  server-rendered; no bundler or client framework is used.
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

- `opencode` (`opencode-ai@1.19.3`) is installed in the image.
- The coordinator runs **one `opencode serve` per (project, app)**, lazily on first chat use, on
  `127.0.0.1:4100+`, with isolated `XDG_*` and `OPENCODE_DB` under the project runtime root. The host
  `auth.json` is copied into each instance's data dir; model access works (verified with `deepseek`).
- Our chat UI (`/chat?app=<appKey>&project=<projectId>`) lists/filters sessions, renders text with a
  safe markdown subset, tool calls (output/error), reasoning, and patches, and sends prompts. The
  optional `project` query is additive and disambiguates duplicate app keys. API:
  `GET/POST /api/apps/:app/sessions`, `GET/POST /api/apps/:app/sessions/:sid/messages`, SSE
  `GET /api/apps/:app/sessions/:sid/events`; all accept `?project=<projectId>`.

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

## Data and state layout

Host `./state` is mounted at `/data/state` in `hanse` only:

- `hanse/coordinator.db` (+ `-wal`, `-shm`) - projects, apps, instances, tasks, handoffs, approvals,
  principals, events, secrets.
- `hanse/secret.key` - AES-256-GCM key for the credential store (mode `0600`).
- `hanse/projects/<projectId>/apps/<appKey>/{data,state,config,cache}` - per-instance opencode state
  (`state/opencode.db`).

The IDE container keeps its extensions at `/opt/hanse-ext` and settings at
`/home/node/.config/code-server`; it does not see `state`.

## CLI

- `hanse init [dir]` - scaffold `.hanse/project.yaml`.
- `hanse status [dir]` - discover/register a project and print its apps.
- `hanse serve` - run the web UI/API (`--workspace`, `--hostname`, `--port`, `--state-home`).
- `hanse mcp` - run the coordinator MCP server bound to an app (used by opencode).

## Environment variables

| Variable | Used by | Meaning |
| --- | --- | --- |
| `HANSE_OPERATOR_TOKEN` | serve, ide | operator token (UI login + extension API) |
| `HANSE_STATE_HOME` | serve | state root (default `~/.local/state`) |
| `HANSE_AUTH_FILE` | serve | path to opencode `auth.json` copied into instances |
| `HANSE_IDE_URL` | dashboard | IDE link (set to `/ide/`) |
| `HANSE_IDE=0` | serve | do not spawn code-server in the coordinator |
| `HANSE_IDE_HOST` / `HANSE_IDE_PORT` | serve | proxy target for `/ide` (default `127.0.0.1:8080`) |
| `HANSE_IDE_BIN` | serve | code-server binary |
| `HANSE_ASSETS` | serve | directory for `app.css`, `app.js`, `chat.js`, `git.js`, and `favicon.svg` |
| `HANSE_DB` / `HANSE_PROJECT_ID` / `HANSE_APP_KEY` | `hanse mcp` | MCP server binding |
| `HANSE_API_BASE` | extension | coordinator base URL (`http://hanse:8787`) |

## Verification

`npm run lint && npm run typecheck && npm test && npm run build` (all green; 150 tests).

## Known limitations and residual risks

- Single user; no RBAC or multi-tenant isolation.
- Trust model: trusted repositories; agents execute code.
- **Agents run in the `hanse` container as the same uid as the coordinator, so they can read
  `/data/state` (DB, `secret.key`).** The IDE is isolated, agents are not.
- Cross-app handoff delivery to a live sibling session is not automatic (see above).
- No TLS; intended for a trusted LAN (VPN/reverse proxy for remote access).
- The writer lock is a single-node file lock (`O_EXCL` + pid liveness), not a distributed lock.
- `git clone` in the add-app endpoint is synchronous (`execFileSync`) and blocks the event loop.
- The git workbench requires the application directory to be its own repository root; applications
  inside a larger repository show a "Not a repository root" state.
- "Commit all" stages and commits untracked files (ignored files stay out); there is no per-file
  staging, diff viewer, or conflict-resolution UI.
- Git push/fetch use ambient host credentials (SSH/HTTPS); the encrypted credential store is not wired
  into git in this stage. Commit requires a configured `user.name`/`user.email`.
- Git actions run repository hooks as the coordinator uid; the trust model remains trusted
  repositories. A per-repository in-memory lock serializes UI actions but does not cover agents or the
  IDE writing to the same repository.
- The IDE chat can be moved to the right sidebar only by a one-time user action (VS Code limitation).
- Chat messages render every item in a session (no virtualization); very large sessions are the
  scaling limit. Drawers close on Escape/scrim/close but do not trap focus. Markdown is a deliberate
  subset: no tables, images, embeds, or raw HTML.
