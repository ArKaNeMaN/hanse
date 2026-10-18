# 0003 - Git workbench

Status: implemented and verified (2026-10-19). Not committed; the owner did not ask for a commit.

## Context

The web UI had no application-scoped page and no way to inspect or act on an application repository.
The only git operation was the synchronous `git clone` used when adding an app. The owner asked for a
deliberately shallow git surface on the application page: status, fetch, update/switch branch, commit,
and push. Implementation decisions were delegated; visual design was produced by the frontend /
visual-engineering specialist.

Artifacts:

- Design: [`docs/design/git-workbench.md`](../design/git-workbench.md) (Oracle review:
  PASS-WITH-CHANGES, findings folded in).
- Plan: [`docs/plans/0002-git-workbench.md`](../plans/0002-git-workbench.md) (Momus review: OKAY).
- Design-system contract: `DESIGN.md` section 5.17 (Git panel).
- Visual evidence: [`docs/design/artifacts/git/`](../design/artifacts/git/README.md).

## What was built

- **Application page** at `GET /projects/:projectId/apps/:appKey`, human-only, server-rendered inside
  the shared shell and hydrated by `assets/git.js`. Linked from the project application table, the
  chat context rail, and the chat breadcrumb.
- **Human-only JSON API** under `/api/projects/:projectId/apps/:appKey/git`: `GET /status`,
  `POST /fetch`, `/update`, `/push`, `/commit`, `/branches/switch`. Mutations are JSON-only; agent
  principals get `403`; request bodies are capped at 64 KiB.
- **Git service** (`src/git/service.ts`): porcelain-v2 `-z` parser, repository resolution with
  `realpath` workspace containment and the repository-root rule, status model (branch/detached/unborn,
  upstream ahead-behind, file groups, remotes, last commit, in-progress operation, identity readiness),
  and fetch/update/switch/commit/push with argument arrays, timeouts, 8 MiB output cap, stable error
  taxonomy, URL-userinfo redaction, per-toplevel mutation lock, and `index.lock` detection.
- **Shared helpers**: `src/http/apps.ts` (`findApp`/`appDir`), `src/http/auth.ts`
  (`cookieToken`/`principalFrom`/`humanFrom`), used by the handler, chat, dashboard, server, page, and
  API.
- **Navigation**: project app rows link to the new page; chat context rail gains an Application link;
  chat breadcrumb becomes `Projects / project / app / Chat`.
- **Client**: `assets/git.js` renders loading, clean, dirty, conflict, detached, in-progress,
  no-remote, no-upstream, no-identity, not-git, not-root, missing, outside-workspace, load-error, and
  busy states; actions are serialized; status is refreshed after actions; 401 redirects to login.
- **CSS**: token-based `.git-*` classes in `src/http/styles.css`, responsive down to 390px.

## Decisions

- A dedicated Application page is used instead of a project-table panel or chat rail (space,
  ambiguity, and accidental-action risk).
- The application directory must be the repository root; subdirectory apps show "Not a repository
  root" instead of operating on the containing repository. This avoids committing/pushing sibling
  apps and project files from an app-scoped page.
- The git API is a separate async module dispatched before the chat/handler split; the page handler
  stays synchronous. One long-lived `GitService` owns the per-toplevel lock.
- Mutations are JSON-only on top of the `SameSite=Strict` cookie; no CSRF token was added.
- `commit all` stages tracked, unstaged, and untracked non-ignored changes. There is no confirmation
  dialog in this pass; the file groups and commit hint are the confirmation. This is accepted debt.
- Push uses ambient credentials. The encrypted credential store is not wired into git in this stage.
- Commit identity is preflighted with `git var GIT_AUTHOR_IDENT`; commit signing is detected and
  refused with actionable copy rather than silently bypassed.

## Verification

Exact gate results:

```text
npm run lint       Pass (Biome, 68 files)
npm run typecheck  Pass
npm test           Pass (21 files, 150 tests; 38 git service, 12 git HTTP, 3 application page)
npm run build      Pass (tsc + Tailwind CSS)
node --check assets/git.js  Pass
```

Real integration pass:

- local coordinator at `127.0.0.1:8799` with a temp workspace, a temp git repo, and a bare
  `file://` remote;
- authenticated page and API; status, fetch, commit, push, and branch switch exercised end-to-end;
- commit success, push success, and branch switch verified from the API and the browser.

Browser QA (Playwright Chromium, Playwright resolved from the npx cache; no product dependency):

- 390 dark, 768 light, and 1440 dark/light captures; no horizontal overflow (`0px` at 390 and 768);
  no page/console errors from the application (only expected 403/500 resource log entries for the
  mocked outside-workspace/load-error states);
- interaction pass: refresh, fetch, switch branch, commit all, push; busy state (`aria-busy`,
  "Fetching", spinner, other actions disabled) verified;
- deterministic state pass with `/git/status` route interception: dirty, conflicts, in-progress,
  detached, no-remote, no-upstream, no-identity, not-git, not-root, missing, outside-workspace,
  load-error. Evidence in `docs/design/artifacts/git/`.

## Deviations and accepted debt

- `GitBranch` is a string alias so the status model matches `branches?: string[]`.
- `statusFor(projectRoot, appPath)` maps resolution failures to `not_git`/`not_root`/`missing` states;
  `resolveRepository` still throws the required `GitError`s.
- Commit-signing refusal uses the `git_failed` code because the taxonomy has no dedicated signing
  code.
- `git_failed` maps to `502` for fetch/update/push and `500` for commit/switch; `timeout` and
  `output_too_large` map to `500`.
- Biome excludes `assets` and `src/http/styles.css`; `assets/git.js` is checked with `node --check`
  and exercised through Playwright, not Biome.
- No confirmation dialog for commit-all; no per-file staging, diff viewer, conflict resolution,
  merge/rebase, branch creation/deletion, credential store wiring, or background polling.
- The visual QA harness lives outside the repository; the checked-in evidence images are in
  `docs/design/artifacts/git/`.
- No commit was made.

## Next steps

- Wire the encrypted credential store into `GIT_ASKPASS`/credential helpers if push credentials should
  be managed by the coordinator.
- Add monorepo/path-scoped git support only with an explicit design.
- Revisit per-file staging, diff viewing, conflict resolution, and a commit-all confirmation for
  untracked files.
- Add a DOM test harness if `assets/git.js` grows further; today Playwright is the verification seam.
