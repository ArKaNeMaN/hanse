# Plan 0004 - Interactive prompts, Todo panel, and permission policy

- Design: [`docs/design/interactive-prompts.md`](../design/interactive-prompts.md), design review
  folded in (`## Review`).
- Design reviewer: `oracle` - **PASS-WITH-CHANGES** (2026-10-19; all review and owner-decision
  findings folded into the design).
- Plan reviewer: `momus` - **OKAY** (2026-10-19; non-blocking notes folded in).
- Verification (every phase):
  `npm run lint && npm run typecheck && npm test && npm run build`.
- Commit policy: one coherent commit for the stage, only when the owner explicitly asks. The owner
  has not asked to commit.
- Binding profile: design docs `docs/design/` (index `README.md`), plans `docs/plans/` (index
  `README.md`), journal `docs/journal/` (index `README.md`), decisions `docs/decisions/`, open
  questions in this plan while open. Doc language: English.
- Owner decisions (closed): Hanse-route guarantee for R6; warning-only policy verification;
  `.opencode` config/plugin edit deny; v1+v2 prompt support with durable project-scoped saved
  permissions; empty answers with a "Send without answering?" confirmation; `GIT_CEILING_DIRECTORIES`;
  approved trusted external roots; explicit `always` scope and `*`; `.env` read+write; durable v2
  self-grant accepted as residual.

## Global invariants

- No new runtime or client dependencies; Node >= 20; ESM with `.js` relative imports.
- Existing routes, response shapes, and tests stay green unless a planned change is explicitly
  additive. The old raw session SSE route remains raw and keeps `principalFrom`.
- The new prompt/Todo/event routes are human-only: no principal -> `401`, agent principal -> `403`;
  auth is checked before app/runtime lookup. Mutating routes require JSON.
- `buildInstanceEnv` scrubs coordinator-only env (`HANSE_OPERATOR_TOKEN`, `OPENCODE_PERMISSION`,
  `HANSE_API_BASE`, `HANSE_AUTH_FILE`, `HANSE_DB`, `HANSE_STATE_HOME`) after every env spread.
- Permission verification is **warning-only** and never blocks startup (owner decision). A confirmed
  mismatch or a timeout is stored and exposed in `/prompts.warnings` and rendered in the UI.
- The permission overlay is explicit: external-directory deny + trusted allow roots; `.env`
  read+write allow; `.opencode` config/plugin edit deny in bare and `*/` forms; `question`,
  `todowrite`, `todoread`, `webfetch`, `websearch` allow; `doom_loop` ask. No `"permission": "allow"`
  shorthand and no top-level `"*": "allow"`.
- v1 and v2 prompts are both supported. Every prompt carries `source: "v1" | "v2"`; maps, drafts,
  and tombstones are keyed by `${source}:${id}`; replies require `source`.
- The server never forwards arbitrary client JSON upstream. IDs, answer shapes, label sizes, and
  reply enums are validated; pending questions are re-fetched before replying.
- All prompt/Todo/metadata text is rendered with `textContent`; no markdown or links from prompt
  data. The existing message markdown renderer is unchanged.
- No Todo writes, no plan-markdown browser, no VS Code extension changes, no hard isolation in this
  stage.
- The thread remains the only page scroll owner; dock and plan lists are capped, contained scroll
  regions.

## Phase 1 - Credential scrub, permission overlay, and instance verification

Boundaries: `src/opencode/instance.ts`, `src/opencode/launcher.ts`, `src/opencode/manager.ts`, and a
new `src/opencode/policy.ts`; no HTTP or UI.

Deliverables:

- `buildInstanceEnv` scrubs the coordinator-only env keys after `process.env`, `baseEnv`, and the
  isolated env have been spread. The coordinator MCP still receives `HANSE_DB`,
  `HANSE_PROJECT_ID`, and `HANSE_APP_KEY` through the explicit `mcp.hanse.environment` entry.
- `buildPermissionPolicy` / `resolvePermissionPaths`:
  - `external_directory`: `"*": "deny"` first, then trusted roots
    (`<XDG_DATA_HOME>/opencode/tool-output`, `<XDG_DATA_HOME>/opencode/repos`,
    `${os.tmpdir()}/opencode`, `<XDG_CONFIG_HOME>/opencode/skills`,
    `<XDG_CACHE_HOME>/opencode/skills`, `<HOME>/.claude/skills`, `<HOME>/.agents/skills`, and
    `<plugin-root>/skills` for `file://` baseline plugins).
  - `question`, `todowrite`, `todoread`, `webfetch`, `websearch`: `allow`.
  - `read`: only `*.env`, `*.env.*`, `*.env.example` allow rules (no `"*": "allow"`).
  - `edit`: allow `*.env`, `*.env.*`, `*.env.example` (read+write decision), then deny
    `opencode.json`, `opencode.jsonc`, `.opencode/opencode.json`, `.opencode/opencode.jsonc`,
    `.opencode/plugin/*`, `.opencode/plugins/*`, plus `*/`-prefixed variants for non-git/nested
    worktrees.
  - `doom_loop`: `ask`.
- `buildConfigOverlay` accepts `permission`; `buildInstanceEnv` sets `GIT_CEILING_DIRECTORIES` to
  the real parent of `appDir` and preserves existing `mcp`, `plugin`, and `instructions`.
- `InstanceManager.ensure` runs a best-effort post-start verification: `GET /agent` and `GET /path`
  with a short timeout and retry/backoff; evaluate the final ruleset of every non-hidden agent for
  external/sibling denial; for primary/`all` agents also check each trusted root, `question`, and
  `todowrite`; check `path.directory === appDir` and `path.worktree` is `appDir` or `/`; store
  `policyWarnings` on the entry. It never blocks startup. Add `InstanceManager.policyWarnings(appId): string[]` (or an
  equivalent accessor) so the HTTP layer can expose the warnings.

Acceptance criteria:

- `OPENCODE_CONFIG_CONTENT` has the exact permission keys/order, no shorthand, and preserves
  plugins/MCP/instructions.
- The child env contains none of the scrubbed keys, including when `baseEnv` tries to add them.
- `GIT_CEILING_DIRECTORIES` is the real parent of `appDir`; a temp nested-repo test proves git does
  not discover the parent, while an app that is its own repo root still resolves.
- `.opencode` edit denies match in three cases: app-as-worktree, non-git `worktree="/"`, and nested
  app with a wider worktree.
- A project-config allow or custom-agent allow produces a warning, not a startup failure; a
  verification timeout produces a warning.
- `GET /agent` verification covers every non-hidden agent and hidden-agent expectations.
- `policyWarnings(appId)` exposes stored/timeout warnings to the HTTP layer; the warning text names
  the offending agent/permission without metadata values.

Tests:

- `test/instance.test.ts`: policy builder exact shape/order, `*.env` read+edit rules, config/plugin
  edit denies, plugin roots, path variants.
- `test/launcher.test.ts`: env scrub after `baseEnv`, `OPENCODE_CONFIG_CONTENT`, ceiling.
- New `test/permission-policy.test.ts`: final-ruleset evaluator fixtures for external/sibling/trusted
  paths, OMO allow, project config allow, custom agent, hidden agents, warning-only behavior,
  `policyWarnings` accessor (mismatch and timeout).
- New temp-repo test for `GIT_CEILING_DIRECTORIES` using real `git`.

Risk: opencode path matching/worktree semantics differ by version. Mitigation: pin 1.19.3, test the
three worktree cases, and keep verification warnings visible.

## Phase 2 - Upstream client, SSE parser, and normalization

Boundaries: `src/opencode/client.ts`, new `src/opencode/events.ts`; no HTTP routes or UI.

Deliverables:

- Client functions: v1 `listQuestions`, `replyQuestion`, `rejectQuestion`, `listPermissions`,
  `replyPermission`, `listTodos`; v2 `listQuestionsV2`, `replyQuestionV2`, `rejectQuestionV2`,
  `listPermissionsV2`, `replyPermissionV2`, `listSavedPermissions`, `deleteSavedPermission`.
  V2 list calls pass `location: { directory: appDir }`; saved list omits `projectID`.
- Typed `OpencodeHttpError` with `status`; new reads use 5 s timeout and 1 MiB cap; replies use
  10 s. `sendPrompt` stays blocking and unchanged.
- `src/opencode/events.ts`: incremental SSE parser and projector.
  - v1 events: `question.asked/replied/rejected`, `permission.asked/replied`, `todo.updated`.
  - v2 events on `/event`: `question.v2.asked/replied/rejected`, `permission.v2.asked/replied`;
    normalize to Hanse names with `source: "v2"`, map `action/resources/save/source` to
    `permission/patterns/always/tool`, and key by `${source}:${id}`.
  - `session.activity` extraction from `properties.sessionID`, `properties.info.sessionID`,
    `properties.info.id`, `properties.part.sessionID`.
  - `stream.ready` only after the upstream response is open and the reader is attached; 15 s
    heartbeat; 1 MiB frame cap; `stream.warning` per dropped code; backpressure via `drain`.
- Normalization/caps: `tooLarge`, metadata depth/keys, 50 prompts per kind, 200 todos, 8 000
  characters per todo, 100 questions/options/labels, 2 000 per label, 4 000 per feedback, 200 header,
  10 000 question text. Never truncate a question/option list; mark `tooLarge`.

Acceptance criteria:

- The parser handles chunk splits, CRLF splits, UTF-8 splits, multi-line data, comments, malformed
  JSON, unknown events, and oversized frames without throwing.
- A v2 frame produces a normalized Hanse event with the correct `source` and fields; a v1 frame is
  unchanged; there is no cross-wiring.
- `session.activity` is emitted for the five documented payload shapes.
- `stream.ready` is emitted after upstream attach; closing the response aborts the upstream fetch.
- Todo unknown status/priority values normalize to `unknown`; caps are applied.

Tests:

- New `test/opencode-events.test.ts`: parser and projector fixtures for v1/v2, session.activity,
  dedupe/keying, caps.
- New `test/prompts-normalize.test.ts`: v2 field mapping, defaults, caps, `tooLarge`.
- Extend `test/client.test.ts` or `test/instance.test.ts` for typed errors/timeouts.

Risk: v2 event availability depends on the pinned opencode build. Mitigation: integration fixture
with a raw v2 frame from `/event`; fall back to a warning if a v2 list source is unavailable.

## Phase 3 - HTTP API and dispatch

Boundaries: new `src/http/prompts.ts`, `src/http/server.ts`; no UI.

Deliverables:

- `GET /api/apps/:app/prompts?project=` -> `{ questions, permissions, truncated, warnings? }`; calls
  four upstream lists with `Promise.allSettled`, merges v1/v2, adds per-source warnings, and includes
  policy warnings.
- `POST /api/apps/:app/questions/:requestId/reply` body `{ source, answers }`.
- `POST /api/apps/:app/questions/:requestId/reject` body `{ source }`.
- `POST /api/apps/:app/permissions/:requestId/reply` body `{ source, reply, message? }`.
- `GET /api/apps/:app/permissions/saved?project=` and
  `DELETE /api/apps/:app/permissions/saved/:savedId?project=`.
- `GET /api/apps/:app/sessions/:sid/todo?project=` -> `{ todos, truncated }`.
- `GET /api/apps/:app/events?project=` -> typed SSE, projected by `events.ts`.
- `server.ts`: dispatch the app SSE route before `isChat` and prompt/Todo routes to
  `handlePrompts` before `handleChat`; old session SSE remains raw.
- Auth order `401 -> 403 -> 503 -> 404`; JSON content type for POST; codes `prompt_expired`,
  `invalid_answers`, `invalid_permission_reply`, `invalid_source`, `session_not_found`,
  `prompts_unavailable`.
- Question validation: `answers.length === questions.length`; empty arrays accepted; non-empty arrays
  follow `custom`/`multiple` rules; labels non-empty, deduped; `tooLarge` requests are Dismiss-only;
  source must match a pending request; re-fetch pending questions before replying.
- Permission validation: source must match; `reply` enum; `message` max 4 000 and only with reject.

Acceptance criteria:

- Human cookie/bearer works; missing principal 401; agent principal 403 before any app/runtime
  lookup; unknown app 404; no runtime 503; upstream failure 502.
- v1 and v2 replies hit the correct upstream path; v2 uses the request's sessionID; saved
  list/revoke work; `source` mismatch is 400.
- The v2 saved-permission evaluation order is verified against a config deny (the expected
  allow/deny outcome is asserted, not assumed); the UI copy matches the verified behavior.
- Empty answers are accepted; non-empty rule violations are 400; `tooLarge` cannot send an
  unaligned answer.
- The app SSE route streams `stream.ready`, v1/v2 normalized frames, heartbeats, and warnings.

Tests:

- New `test/prompts-http.test.ts` with a fake opencode route table: v1/v2 lists, partial/all
  failures, replies/reject for both sources, saved list/revoke, saved-permission evaluation order
  against a config deny, validation, auth matrix, 415/413, 404/502, `source:id` keying.
- New `test/app-events.test.ts`: real Hanse HTTP server + fake upstream `/event`, v1 and v2 frames,
  `stream.ready` timing, heartbeat, abort, auth.
- Extend `test/chat-page.test.ts` for unchanged routes and the old raw SSE.

Risk: route ordering and the raw `ServerResponse` handling. Mitigation: explicit dispatch tests,
including a request that matches both `/api/apps/*` and the new route.

## Phase 4 - Prompt state, question dock, and permission dock (visual-engineering)

Boundaries: `assets/chat.js`, `src/http/chat.ts` markup, `src/http/styles.css`; no server routes.

Deliverables:

- Replace the per-session raw EventSource with one app-level typed stream; dispatch v1/v2 events.
  Use `session.activity` to debounce `loadMessages` for the active session, replacing the old raw
  session stream's reload role.
- Client state: prompt map keyed `${source}:${id}`, pending drafts, per-session pending-send map,
  hydration sequence, event log, tombstones for reply/reject/404/received events, per-session
  `todoEventSeq`.
- Hydration on boot and `stream.ready`: `/prompts`, active-session todo, saved permissions, and
  policy warnings; reconcile without resurrecting answered requests.
- Question dock: header/queue/collapse; tabs >=768 and stepper <768; options, multi-select, custom;
  Review for multi and single `multiple:true`; `Send without answering` confirmation; Dismiss
  confirmation; submitting/error/expired/answered-elsewhere states.
- Permission dock: risk chip, title, scope (`This request`, `Always grants`, v1 instance scope vs v2
  durable/project scope, `*` explanation, v2 cross-session auto-resolve warning), evidence by type,
  once/always/reject with feedback, inline always/deny confirmations, expired/error states.
- Composer/meta: `Waiting for you`, preserved draft, disabled send; per-session send completion
  must not clobber a different active session.
- Policy warning banner/chip, announcer, focus policy, keyboard map, 44 px mobile controls.

Acceptance criteria:

- A question from the active session appears within 1 s and can be answered while the message POST
  is pending; empty answers require confirmation; a v2 `multiple:false` custom answer sends exactly
  one label.
- A permission renders the correct type/patterns/metadata; v1 `always` says "app instance until
  restart"; v2 says "saved for this project until revoked"; `*` is explicit.
- A prompt from another session shows the rail flag and top-bar count; switching sessions shows that
  session's dock; drafts survive switching.
- A lost `*.replied` event cannot resurrect a card after a hydration; 404 becomes
  "Already answered or expired"; reconnect rehydrates.
- Live message updates still work after replacing the raw session SSE: `message.updated` and
  `message.part.updated` produce a debounced `loadMessages` for the active session.
- No focus steal when the composer has a draft; Escape cancels sub-steps; Ctrl/Cmd+Enter submits.
- New CSS uses only existing tokens; design-system contract updated in `DESIGN.md`.

Tests:

- Playwright/browser fixtures (route interception + stub EventSource) for the flows in the design's
  test strategy, including v1/v2 scope copy, empty-answer confirmation, cross-session prompts,
  reconnect/tombstone, `session.activity` -> message reload, XSS fixtures, 390/768/1440 dark/light.
- One live smoke with a real agent for `question` and `todowrite`.

Risk: this is the largest phase. Mitigation: land state/SSE first, then the docks, then visual QA;
keep the old session SSE route untouched.

## Phase 5 - Todo panel, saved permissions, and policy warnings

Boundaries: `assets/chat.js`, `src/http/chat.ts`, `src/http/styles.css`, `DESIGN.md`; no server
routes beyond Phase 3.

Deliverables:

- Context-rail `Plan` section after Application/before Handoffs: status glyph + text, priority meter,
  progress `completed / (pending + in_progress + completed)`, cancelled count, unknown values,
  0/0 state, empty/draft/loading/error/paused states, capped scroll. Preserve upstream order; only
  the first `in_progress` gets `aria-current="step"`.
- `Plan N/M` meta chip below 1360 that opens the context drawer scrolled/focused to Plan.
- Saved permissions section: action/resource/projectID, revoke with inline confirmation, refresh on
  `stream.ready`/after grant/revoke, badge/toast for a new saved grant.
- Policy warning banner/chip: render `warnings` from `/prompts`, dismissible, refreshed on hydration,
  text-only, `role="status"`.
- Design-system contract updates and Playwright captures at 390/768/1440 dark/light.

Acceptance criteria:

- `todo.updated` updates the active session's panel without replacing the list element; other
  sessions update only the cache; a session switch fetches that session's todo; a stale fetch is
  discarded.
- All statuses/priorities, including unknown, render; cancelled is excluded from the denominator;
  0/0 shows "No active steps"; long lists scroll inside the panel.
- Saved permissions list/revoke works; a new saved permission is visible without a reload; the
  projectID is shown.
- A policy warning is visible in the UI and disappears only after a clean `/prompts` refresh.

Tests:

- Browser fixtures for todo updates, session switching, unknown values, 0/0, long lists, saved
  permission list/revoke/badge, policy banner/chip.
- Visual QA at 390/768/1440 in dark/light; no horizontal overflow; keyboard reachable.

Risk: the context rail becomes crowded. Mitigation: capped sections, Plan sticky header, Saved
permissions hidden when empty.

## Phase 6 - Documentation, verification, and record

Deliverables:

- Update `docs/current-state.md`: new routes, human-only rule, v1/v2 prompts, Todo panel, saved
  permissions, warning-only policy, residual risks, no plan-file browser.
- Update `docs/design/README.md` if needed; the design doc is already indexed.
- Add `docs/decisions/0005-permission-policy-guardrail.md` (ADR): external-dir deny + trusted roots,
  warning-only verification, `.opencode` edit deny, Hanse-route guarantee, v2 saved-permission
  residual.
- Add `docs/journal/0005-interactive-prompts.md` and update `docs/journal/README.md`.
- Update `docs/plans/README.md` with this plan.
- Run the full verification matrix and record the evidence.

Acceptance criteria:

- All docs are consistent with the implemented behavior and owner decisions.
- The ADR records the residual risks and the hard-isolation follow-up.
- The journal links the design, plan, ADR, and verification evidence.
- `npm run lint`, `npm run typecheck`, `npm test`, and `npm run build` pass.

## Verification matrix

| Check | Command / evidence |
| --- | --- |
| Lint | `npm run lint` |
| Types | `npm run typecheck` |
| Unit/integration | `npm test` |
| Build + CSS | `npm run build` |
| Policy overlay | `buildInstanceEnv` unit tests; temp-repo ceiling test; live `/agent` + `/path` check |
| v1/v2 prompts | fake upstream + browser fixtures; one live agent question |
| Empty answers | browser fixture proving "Send without answering?" confirmation and `answers: [[]]` |
| Saved permissions | list/revoke/badge fixture + saved-permission evaluation-order test |
| Policy warnings | unit accessor + browser banner/chip fixture; timeout/mismatch warnings |
| Auth | route tests: missing 401, agent 403 before app/runtime lookup, human 200 |
| Todo | fake `todo.updated` + live `todowrite` |
| Permission policy | denied external read, `.env` read+write, network, `.opencode` edit deny warning |
| UI | external Playwright run at 390/768/1440 dark/light; keyboard/focus checks. The repo has no Playwright product dependency; use the optional resolver pattern from `docs/design/capture.mjs` or an externally installed Playwright, and record evidence in the journal. `npm test` is Vitest-only. |
| Docs | current-state, ADR, journal, indexes updated |

## Risks carried into execution

- opencode 1.19.3 path/worktree semantics and v2 event delivery may differ from fixtures; pin the
  version and keep the live smoke.
- Warning-only policy means a widened ruleset does not block the app; the warning must be visible.
- App-owned config/plugins and the unauthenticated loopback API remain residual bypasses; the ADR
  records them.
- v2 saved permissions are durable and can be created directly by an agent; treat Saved permissions
  as audit/revoke, not a boundary.
- The UI phase is large; land state/SSE before visual polish and keep the old session SSE route
  untouched.

## Review

Plan reviewer: `momus` - **OKAY** (2026-10-19). Non-blocking notes folded in:

1. Aligned `.env` read/edit patterns with the design (`*.env`, `*.env.*`, `*.env.example`) and made
   read+write explicit.
2. Added `session.activity` -> debounced `loadMessages` to Phase 4 deliverables, acceptance, and
   tests.
3. Named `InstanceManager.policyWarnings(appId)` as the Phase 1 -> Phase 3 handoff and added
   stored/timeout warning tests.
4. Added a saved-permission evaluation-order test against a config deny.
5. Added matrix rows for saved permissions, policy warnings, empty answers, and auth; named the
   external Playwright harness and noted that `npm test` is Vitest-only.

No blocking issues. Implementation may start.

## Execution record

Implemented 2026-10-19. All phases landed; see the stage record at
[`docs/journal/0005-interactive-prompts.md`](../journal/0005-interactive-prompts.md). Final gates:
`npm run lint`, `npm run typecheck`, `npm test` (27 files, 256 tests), and `npm run build` all pass.
External Playwright smoke at 1440/390 covers the question/permission docks, Plan, saved permissions,
policy warning, queue, empty-answer confirmation, v2 scope, and mobile touch sizing. No commit was
made; the owner has not asked to commit. Deployed to `deployment-host` (see `docs/deploy/deploy-log.md`).
