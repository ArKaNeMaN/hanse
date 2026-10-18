# 0002 - Web UI redesign (The Chart Room)

Status: complete. Supersedes the daisyUI-era dashboard described in the earlier core journal. The
canonical runtime description remains [`docs/current-state.md`](../current-state.md); the visual
contract is [`DESIGN.md`](../../DESIGN.md).

## What changed

- From-scratch visual system: ink/steel/brass "chart room", serif ledger titles, humanist UI sans,
  mono machine data, a 32px chart ground, and the plotted handoff route as the signature object.
- Shared server-rendered shell with fixed sidebar, top bar/breadcrumb, mobile drawer, theme toggle,
  sign-out, toast region, and the full primitive set. No client framework or new runtime dependency.
- Authenticated pages: fleet overview, projects index, project detail, handoffs inbox, and a three-pane
  chat workspace. The HTML UI now requires a human operator session; the login plate validates the
  token instead of accepting any cookie value.
- Real forms and dialogs for project creation, adding applications, creating handoffs, and approving
  or rejecting with an audit reason. Browser form posts redirect with a notice; JSON API callers keep
  their response shapes.
- Chat: session search/create/switch, safe markdown-lite, tool calls and reasoning/patch disclosures,
  SSE live/reconnecting/paused states, scroll preservation, new-message affordance, composer keyboard
  handling, and a context rail with application data and handoffs.
- Project-scoped chat URLs (`?app=&project=`) disambiguate apps with the same key across projects; the
  query is additive on the API/SSE endpoints.

## Artifacts

- Design contract: [`DESIGN.md`](../../DESIGN.md)
- Primitive showcase: [`docs/design/showcase.html`](./showcase.html)
- Stage records: [`stage-2.md`](./stage-2.md), [`stage-3.md`](./stage-3.md)
- Evidence: `docs/design/artifacts/` including `final/`

## Verification

`npm run lint`, `npm run typecheck`, `npm test` (97 tests), and `npm run build` are green. Final
Playwright QA covered 390/768/1024/1440 in dark and light, the anonymous login/error path, the
create/add/approve/reject flows, dialogs and drawers, and a real local opencode chat session.

## Remaining visual debt

- Chat drawers close with Escape/scrim/close and return focus but do not trap focus.
- Chat has no message virtualization; very large sessions re-render the thread on SSE events.
- The markdown renderer is a deliberate safe subset (no tables, images, embeds, or raw HTML).
- System fonts only (offline/LAN constraint); the display serif varies by OS.
- The embedded code-server IDE is intentionally not themed by hanse.

## Deployment - 2026-10-19

- Host: `deployment-host` (`<LAN_HOST>:8787`), deployed over SSH with the documented tar + compose path.
- New image: `hanse:0.1.0` = `sha256:c68e7cb2294f9fe648e17442e2e1344215f1a41a2e2f11cf284a4bf683ec3edc`.
- Previous image: `sha256:65242ca9dd35fa3ce072a3e367809c74ca2191d746d0595ff2897286f5c507af`,
  tagged `hanse:rollback-2026-10-19-pre-chartroom`.
- Pre-deploy backup: `<BACKUP_DIR>/pre-chartroom-2026-10-19/{state.tgz,workspace.tgz,env}`.
- Health: `/`, `/projects`, `/handoffs`, `/chat`, `/assets/{app.css,app.js,chat.js,favicon.svg}`,
  `/api/projects` = 200 with the operator cookie; anonymous `/` = 303 to `/login?next=%2F`;
  `/ide/` = 200 after the code-server redirect; logs show `hanse serving 1 project(s)` with no errors.
- Verified the image contains `Fleet overview`, `chat-shell`, and `assets/chat.js`; a real chat session
  started against the existing `demo-app` application (`opencode 1.19.3`) and the overview reported
  `Agents running 1`.
