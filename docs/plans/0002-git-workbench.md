# Plan 0002 - Git workbench

- Design: [`docs/design/git-workbench.md`](../design/git-workbench.md), review folded in
  (`## Review`).
- Design reviewer: `oracle` - **PASS-WITH-CHANGES** (2026-10-19; changes folded into the design).
- Verification (every phase): `npm run lint && npm run typecheck && npm test && npm run build`.
- Commit policy: one coherent commit for the stage, only when the owner explicitly asks. The owner
  has not asked to commit.
- Owner questions: none open. The owner delegated implementation decisions. Recorded decisions:
  repository-root rule (an app must be its own repo root), no confirmation dialogs in this pass,
  ambient git credentials, and no credential-store wiring.
- Binding profile: design docs `docs/design/` (index `README.md`), plans `docs/plans/` (index
  `README.md`), journal `docs/journal/` (index `README.md`), decisions `docs/decisions/`, open
  questions in this plan and `docs/open-questions.md` while open. Doc language: English.
- Plan review: Momus - **OKAY** (2026-10-19; no blocking issues).

## Global invariants

- No new runtime or client dependencies; Node >= 20; ESM with `.js` relative imports.
- Existing route/response shapes and existing tests stay green unless a planned navigation assertion
  changes.
- Git is human-only. Agent principals receive JSON `403` from the API; HTML pages keep the existing
  redirect-to-login behavior.
- No shell. Every git command uses an argument array. Branch switch uses `git switch -- <branch>`;
  leading-dash/control-character branch names are rejected.
- The application directory must be the repository root (`realpath(appDir) ===
  realpath(toplevel)`) and inside `workspaceRoot`. Containment is re-checked after
  `git rev-parse --show-toplevel`.
- One long-lived `GitService` per server, a mutation lock keyed by `realpath(toplevel)`, and
  `index.lock` detection.
- No credential handling in this stage. Ambient `GIT_ASKPASS`/`GIT_SSH_COMMAND` remain the
  deployment's responsibility.
- Timeouts and bounded output on every command; redact all URL userinfo before truncation.
- The page is server-rendered; `assets/git.js` hydrates it with DOM APIs and `textContent` only.
- No commits unless the owner explicitly asks.

## Phase 1 - Shared helpers and GitService status

Boundaries: pure/shared code and read-only git status. No HTTP routes, no page, no client JS.

Non-goals: mutations, UI, docs beyond code comments.

Deliverables:

- `src/http/apps.ts` - `findApp(deps, projectId, appKey)` and `appDir(project, app)`, extracted from
  `src/http/chat.ts:106-127` and `src/http/dashboard.ts:286-291`; update chat/dashboard/handler call
  sites without behavior change.
- `src/http/auth.ts` - `cookieToken`, `principalFrom`, `humanFrom`, extracted from
  `src/http/handler.ts:128-151` and `src/http/chat.ts:57-74`; `server.ts` reuses `cookieToken` for
  its cookie-only `/ide` auth. Use type-only imports or a shared types module to avoid a runtime
  cycle.
- `src/git/service.ts` - `GitService`, `GitError`, `parsePorcelainV2`, `resolveRepository`, output
  redaction, injectable command runner, status read.
- `GitStatus` model with `ok | not_git | not_root | missing`, branch/upstream/files/branches/
  remotes/lastCommit/operation/conflicted/identity.
- `HttpDeps.git` is not added yet; the service is constructed in tests directly.

Acceptance criteria:

- parser fixtures cover clean, dirty, `MM`, staged-only, unstaged-only, rename/copy, conflict `u`,
  detached, unborn, no upstream, paths with spaces/newlines/non-ASCII, and multiple remotes;
- `git log -1` in an empty repo yields `lastCommit: null`, not an error;
- `not_git`, `not_root`, `missing`, and `outside_workspace` are distinguishable;
- remote URLs with token-only, `user:password`, and percent-encoded userinfo are redacted;
- no shell is used; commands use argument arrays.

Tests:

- `test/git-service.test.ts` parser unit fixtures and real-git temp-repo status tests;
- `test/http.test.ts` / `test/chat-page.test.ts` unchanged behavior after the helper extraction.

Risk: parser edge cases. Mitigation: pure parser seam plus `-z` fixtures.

## Phase 2 - GitService mutations

Boundaries: fetch, update, switch, commit, push; lock and error taxonomy. No HTTP/UI.

Deliverables:

- `fetch`, `update` (`pull --ff-only`), `switch` (`git switch --`), `commit` (`add -A` +
  `commit -m`), `push` (with `-u origin <branch>` when no upstream and `origin` exists).
- per-`realpath(toplevel)` mutation lock; `index.lock` detection; in-progress operation detection
  (`MERGE_HEAD`, `CHERRY_PICK_HEAD`, `REVERT_HEAD`, `rebase-merge`, `rebase-apply`).
- conflict guard before `add -A`; nothing-to-commit vs hook failure; commit identity preflight;
  signing detection/refusal; 409/502 error mapping; timeout/output-overflow mapping.
- post-action status retry-once, then success + `status: null` + warning; commit result includes the
  commit hash.

Acceptance criteria:

- fast-forward update succeeds; diverged update returns `diverged`; dirty overwrite returns
  `worktree_dirty`;
- push to a local bare remote succeeds; no-upstream + `origin` sets upstream; rejected push returns
  `push_rejected`;
- commit stages tracked and untracked non-ignored changes and leaves ignored files alone; failed
  commit leaves changes staged and reports it;
- switch rejects unknown/leading-dash/control-character branches; conflicted/in-progress states block
  commit/update/switch;
- two concurrent mutations on the same toplevel: one succeeds, one gets `busy`;
- a pre-existing `index.lock` returns `git_locked`.

Tests:

- `test/git-service.test.ts` with a temp workspace and a bare `file://` remote: fetch/update/push,
  divergence, conflicts, switch, commit, lock, not-root, outside, missing, timeout via an injected
  runner, output overflow;
- no test relies on network access.

Risk: ambient git identity/credentials are absent in CI. Mitigation: configure identity in the temp
repo; use `file://` remotes; inject the command runner for failure cases.

## Phase 3 - HTTP API and dispatch

Boundaries: JSON API and server wiring. No page UI, no client JS.

Deliverables:

- `src/http/git.ts` - `handleGit(deps, request)` for `/api/projects/:projectId/apps/:appKey/git/*`.
- `src/http/server.ts` - git API dispatch before chat/handler; `readBody` cap 64 KiB with `413`.
- `src/http/handler.ts` - `HttpDeps.git`, `git` wiring in `serveCommand`; asset allowlist entry for
  `/assets/git.js` can land in phase 4.
- JSON-only content type, body validation, human-only 403, error mapping, `status`/`warning` contract.
- `src/cli/commands.ts` - construct one `GitService` and pass it to `createHttpServer`.

Acceptance criteria:

- GET status returns the model; POST actions return the fresh status or the documented `null` +
  warning result;
- unauth `401`; agent `403`; outside workspace `403`; missing project/app `404`; invalid JSON/wrong
  content type `400`; oversized body `413`; busy/locked/conflicted/detached/no-upstream/diverged/
  nothing-to-commit `409`; remote failures `502`;
- no existing API/auth behavior changes.

Tests:

- `test/git-http.test.ts` fixture: DB + temp repo + human/agent tokens; status, auth matrix,
  content-type, body cap, validation, error mapping, busy, success;
- existing `test/http.test.ts` remains green.

Risk: async dispatch ordering. Mitigation: match `/api/projects/.../apps/.../git` before the generic
handler; add a dispatch regression test.

## Phase 4 - Application page and navigation

Boundaries: server-rendered page, route, links, asset allowlist. No client actions yet.

Deliverables:

- `src/http/application.ts` - `renderApplication(site, projectId, appKey, chrome)` with page header,
  Repository/Changes cards and skeletons, Application/Remotes/Last commit rail, `<noscript>`,
  `data-project-id`/`data-app-key`, `#git-live`, and `scripts: ["/assets/git.js"]`.
- `src/http/handler.ts` - `GET /projects/:projectId/apps/:appKey` route; add `/assets/git.js` to
  `ASSETS`.
- `src/http/dashboard.ts` - project app key link + trailing "open application" icon link.
- `src/http/chat.ts` - context rail "Application" link and breadcrumb `... / <app> (link) / Chat`.
- design-system status-pill mapping prepared for phase 5.

Acceptance criteria:

- human GET renders the page shell, app metadata, skeletons, scripts, and noscript fallback; unknown
  project/app returns the styled 404; unauth redirects to login; agent redirects to login;
- project and chat links point to the new page with encoded ids/keys;
- existing page tests pass with the added links.

Tests:

- `test/application-page.test.ts`: render, 404, auth, links, script/data attributes, noscript;
- `test/http.test.ts` project-page assertions for the new link;
- `test/chat-page.test.ts` breadcrumb/context-link assertions.

Risk: template size and escaping. Mitigation: reuse `escapeHtml` and existing primitives; test
dynamic project/app names with HTML-sensitive characters.

## Phase 5 - Client panel, CSS, and visual QA

Boundaries: `assets/git.js`, git CSS, DESIGN.md contract, visual QA. No backend behavior changes.

Deliverables:

- `assets/git.js` - load status, render all states, actions with busy states, branch switch, commit
  form, accessibility live region/focus, 401/busy/network handling.
- `src/http/styles.css` - `.git-*` classes using existing tokens; responsive stacking; path wrapping.
- `DESIGN.md` - git panel component and status mapping (Clean/Changes/Conflicts/Detached/In progress).
- Visual QA evidence under `docs/design/artifacts/git/`: 390/768/1440 dark/light for loading, clean,
  dirty, conflict, error, non-git, and busy states, plus no-JS fallback.
- Interaction QA: refresh, fetch, update, push, switch, commit, error paths, focus return, no
  horizontal overflow.

Acceptance criteria:

- all states in the design are reachable and render correctly in both themes;
- the pressed action keeps focus; actions are serialized; commit success moves focus sensibly;
- no full-page reload; no raw HTML injection; `textContent` only;
- no horizontal overflow at 390/768/1440; 44px phone targets; keyboard operable;
- the JS-disabled page explains the limitation and keeps chat/IDE links usable.

Tests:

- `npm run build` (Tailwind) and the full gate;
- Playwright/visual QA against a seeded fixture server; screenshots inspected;
- no DOM unit harness is added (no new dependency); the client is exercised through Playwright.

Risk: client-only hydration and no DOM test harness. Mitigation: deterministic fixture routes and
Playwright captures; document accepted debt.

## Phase 6 - Documentation and stage record

Boundaries: docs and record only.

Deliverables:

- update `docs/current-state.md` (page, API, asset, known limits: ambient credentials, repo-root
  rule, commit-all, no conflict resolution);
- update `README.md` feature list;
- update `docs/deployment.md` (git identity and push credentials/SSH host-key behavior);
- update `docs/security/review.md` (human-only git API, containment, hooks/ambient credentials
  accepted risks);
- update `docs/design/README.md`, `docs/plans/README.md`, `docs/journal/README.md`;
- write `docs/journal/0003-git-workbench.md` with context, decisions, artifacts, verification, open
  threads;
- fill the plan review section after Momus.

Acceptance criteria:

- docs match the implemented routes, commands, states, and limitations;
- indexes link the design, plan, and journal;
- the verification gate is green and the record includes the evidence.

## Verification matrix

| Phase | Commands |
| --- | --- |
| 1 | `npm run lint && npm run typecheck && npm test` |
| 2 | `npm run lint && npm run typecheck && npm test` |
| 3 | `npm run lint && npm run typecheck && npm test` |
| 4 | `npm run lint && npm run typecheck && npm test` |
| 5 | `npm run lint && npm run typecheck && npm test && npm run build` + Playwright QA |
| 6 | `npm run lint && npm run typecheck && npm test && npm run build` |

## Risks carried into execution

- Ambient credentials: push/fetch depend on host SSH/HTTPS credentials; first-run host-key
  verification or a passphrase can fail or hang until timeout.
- No git identity in the container: commit is disabled until `user.name`/`user.email` are configured.
- Trusted-repo assumption: hooks run as the coordinator; `fetch --all` contacts every remote; agents
  can race the index; the in-memory lock is not a repository lock.
- Timeouts/SIGKILL can leave `index.lock` and ambiguous commit/push outcomes; the client refetches
  before retrying.
- Large repositories: 8 MiB output cap, 30s status timeout, no virtualization; overflow has a defined
  error.
- Staleness: no polling; status can be stale while agents write; commit-all may include changes the
  human did not intend.
- Containment TOCTOU: the workspace is writable by agents; a path can change between `realpath` and
  `execFile`.

## Review

Plan review: Momus - **OKAY** (2026-10-19). No blocking issues. Verified references: `src/http/chat.ts:106-127`
(`appDir`/`findApp`), `src/http/dashboard.ts:286-291` (`appFolder`), `src/http/handler.ts:128-151`
(auth helpers), `src/http/chat.ts:57-74` (auth helpers), and the supporting design/security/deployment
docs. Each phase has executable tests and acceptance criteria; phase 5 has Playwright viewports and
state coverage; the verification matrix gives runnable commands.
