# Web UI - cohesive workbench

> Status: proposed design. This is a large, security-sensitive expansion (model credentials + agent
> execution + embedding third-party UIs). Build proceeds only after the owner accepts the risk.

## Goal

One cohesive web UI: project/app registry, project creation, agent chat, feature-request visualization,
and a web IDE - **without separate logins** and without hopping between sites.

## Auth: one login

- The coordinator is the single front door. The browser signs in once (operator token -> `hanse_token`
  cookie, `HttpOnly`, `SameSite=Strict`).
- Every embedded surface (chat, code-server, optionally opencode web) sits **behind** the coordinator's
  operator session. Upstream services run on `127.0.0.1` inside the container and are never exposed
  directly; the coordinator injects their credentials.
- No second password prompt anywhere.

## Chat: our own UI over the opencode API (preferred)

The user wants handoffs/feature requests integrated next to the conversation, so we build our own chat
view over opencode's HTTP API (already confirmed in the spike):

- `GET  /session` - list sessions
- `POST /session` - create a session (`{title}`)
- `GET  /session/{id}/message` - message history (`{info, parts}[]`)
- `POST /session/{id}/message` - send a prompt (`{parts:[{type:"text",text}]}`), returns the assistant
  message
- `POST /session/{id}/prompt_async` - non-blocking prompt
- `GET  /event` - SSE event stream (for streaming/tool updates)

The coordinator proxies these under `/api/apps/:app/...`, authenticated by the operator session, and
renders a chat page with a **handoff panel** beside it (the feature-request graph/ledger). This is the
only way to fully integrate our features; opencode's own UI cannot show our handoffs.

## Embedding code-server / opencode web

Sub-path hosting breaks UIs that assume they are served at `/` (absolute asset/API paths, WebSocket).
Two viable approaches:

1. **Subdomain routing (recommended for embeds).** A reverse proxy (Caddy) in front:
   - `hanse.<ip>.nip.io` -> coordinator (our UI)
   - `ide.<ip>.nip.io` -> code-server
   - `agent-<app>.<ip>.nip.io` -> opencode web for that app
   All under a shared cookie domain, so one login; our UI embeds them in `<iframe>`.
   `nip.io` resolves `*.198.51.100.10.nip.io` to the IP without local DNS, which keeps LAN setup simple.
2. **Own UI only (no iframe).** For chat we build our own view (above). For the IDE we either accept an
   iframe via subdomains or keep code-server at a separate port temporarily (not cohesive).

## Phased plan

- **W1** Single auth everywhere + own chat UI (session list, message thread, prompt) + handoff panel on
  the same page.
- **W2** Streaming via SSE, tool-call/diff rendering, richer feature-request visualization (graph of
  handoffs, statuses, approvals).
- **W3** Embed code-server under a subdomain with shared SSO; optionally embed opencode web per app.

## Required integration (risky)

- Install `opencode` in the image (`npm i -g opencode-ai`).
- Mount the owner's model credentials read-only (`~/.local/share/opencode/auth.json`) and copy them into
  each isolated instance's data dir at launch.
- Launch `opencode serve` per app on `127.0.0.1`, set `OPENCODE_SERVER_PASSWORD`, isolate XDG/DB, inject
  `OPENCODE_CONFIG_CONTENT`.
- The agent executes code in the workspace under the owner's credentials.

## Risks and mitigations

- Credentials in the container: mount read-only, copy into isolated instance dirs, never log them.
- Agent execution: single-owner trusted model; document that the agent can run commands in the workspace.
- Exposure: upstream bind to `127.0.0.1`; public surface is the coordinator on a LAN IP; one auth.
- Proxy fragility: prefer subdomain routing over sub-path rewriting; verify WebSocket upgrades.
