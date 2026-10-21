# Design - Git workbench

Status: approved (Oracle PASS-WITH-CHANGES); implemented and verified (2026-10-19).

## Context

The coordinator web UI has no application-scoped page. Applications appear in the project detail
table (`/projects/:id`) and in the chat workspace (`/chat?app=<key>&project=<id>`). The only git
operation in the product is the synchronous `git clone` used when adding an application
(`src/http/handler.ts:495`). There is no way to see a repository's branch, working-tree state, or to
fetch, update, switch branches, commit, or push from the UI.

The owner asked for a deliberately shallow git surface on the application page: status, fetch,
update/switch branch, commit, and push. The implementation approach was delegated. Visual design was
produced by the frontend/visual-engineering specialist.

## Decision

Add a dedicated, human-only **Application page** at
`GET /projects/:projectId/apps/:appKey`. The page is the home for application-scoped concerns; its
first panel is git. It is linked from the project application table and from the chat context rail.
The page is server-rendered inside the existing shell and hydrated by a dependency-free
`assets/git.js`.

Add a human-only JSON API under
`/api/projects/:projectId/apps/:appKey/git`:

| Method | Path | Purpose |
| --- | --- | --- |
| GET | `/git/status` | Branch, upstream, ahead/behind, changed files, remotes, last commit, local branches |
| POST | `/git/fetch` | `git fetch --all --prune` |
| POST | `/git/update` | `git pull --ff-only` on the current branch |
| POST | `/git/branches/switch` | Switch to an existing local branch |
| POST | `/git/commit` | Stage all changes and commit with a message |
| POST | `/git/push` | Push the current branch; set upstream when absent and `origin` exists |

All mutations accept JSON only and return the fresh status with the action result (or a success
result with `status: null` and a warning if the follow-up status read fails). All git commands run
asynchronously with argument arrays, timeouts, bounded output, and no shell.

**Repository-root rule:** this pass requires the application directory to be the repository toplevel
(`realpath(appDir) === realpath(toplevel)`). If the app is a subdirectory of a larger repository, the
page shows a "Not a repository root" state instead of operating on the parent repository. This avoids
committing or pushing sibling applications and project files from an application-scoped page.
Monorepo/path-scoped support requires a separate design.

## Scope

In scope:

- application page with app metadata and repository status;
- status: current branch or detached HEAD, unborn branch, upstream, ahead/behind, clean/dirty,
  staged/unstaged/untracked/conflicted files, remotes, last commit, local branches, in-progress git
  operation, commit-identity readiness;
- refresh, fetch, fast-forward update, local-branch switch, commit-all with a message, push;
- loading, empty, error, detached, unborn, no-upstream, no-remote, conflict, in-progress operation,
  non-git, not-a-repository-root, and outside-workspace states;
- human-only authorization, containment, per-repository serialization, request size cap, redaction of
  credentials embedded in remote URLs and git output;
- tests, docs, design-system contract updates.

## Non-goals

- diff viewer, per-file staging, hunk staging, conflict resolution UI;
- merge, rebase, cherry-pick, stash, reset, branch create/delete/rename, tags, submodules, remotes
  management, force-push;
- monorepo/path-scoped git operations (the app must be the repository root in this pass);
- credential management or wiring the encrypted credential store into git; superseded by stage
  `0010-git-credentials` ([`git-credentials.md`](./git-credentials.md)), which adds per-app
  SSH/HTTPS credentials in Settings, materializes them into the app HOME, and mounts the managed
  directory read-only into the workbench one-shot;
- background polling, auto-fetch, webhooks, or multi-repository views;
- server-side rendering of live git status (the page shell is server-rendered; status hydrates);
- no-JS git actions (a `<noscript>` fallback explains this).

## UI design

### Placement and navigation

A dedicated Application page is chosen over the project page and the chat context rail:

- the project page is project-scoped and already carries two tables, a waiting rail, and dialogs;
  putting per-application git actions in a table row makes the target repository ambiguous and hides
  mutating actions in a dense row;
- the chat context rail is 320px, drawer-hidden below 1360, and conversation-scoped; commit/push
  actions do not belong there and there is no room for a file list or commit message;
- a dedicated page gives the operator a stable deep link and a natural home for future
  application-scoped panels (runtime, logs, configuration).

Navigation changes:

- project application table: the application key becomes a link to the Application page; add a
  trailing chevron icon link with `aria-label="Open <app> application"`;
- chat context rail: add an "Application" ghost link in the Application section;
- chat breadcrumb: `Projects / <project> / <appKey> (link to Application page) / Chat` with Chat
  current;
- Application page breadcrumb: `Projects / <project> / <appKey>` with the app current;
- the Application page uses `active: "project"` and `activeProjectId` so the sidebar project stays
  highlighted.

### Page layout

Page header: overline "Application", title = application key, description "Repository state, branch,
and lightweight git actions for this application.", meta = project name, kind, path. Header actions:
"Open chat" (secondary) and "Open IDE" (secondary). The single primary action on the screen is
"Commit all" inside the Changes card.

Body: `workbench-grid workbench-grid--detail section`.

Main column (`stack`):

1. **Repository** card:
   - head: title "Repository"; right cluster: "Refreshed just now" mono caption and an icon-only
     refresh button (`aria-label="Refresh repository status"`);
   - body: overline "Current branch" with status pills on the right (Clean / Changes / Conflicts /
     Detached / In progress, ahead/behind badges), branch name in mono, upstream line;
   - action bar: Fetch, Update branch, Push, plus a hint line;
   - rule; **Switch branch** form: select of local branches and a Switch button. If only the current
     branch exists, show "Only local branch: <name>." instead of the form. If detached or unborn, the
     select uses a "Choose a branch" placeholder.
2. **Changes** card:
   - head: title "Changes"; right cluster: neutral mono badges for non-zero counts
     (`2 staged`, `1 unstaged`, `3 untracked`, `1 conflicted`);
   - body: file groups (Staged, Unstaged, Untracked, Conflicted), each an `<h3 class="overline">`
     heading with a count and a `<ul>` of files. Each row shows the path in mono and the porcelain
     change code (M/A/D/R/C/T/?/U) with a visually hidden full label. Renames render
     `old → new`. Conflicted groups use a danger glyph and text as well as color;
   - commit form: label "Commit message (required)", textarea (3 rows), hint "Commits all staged,
     unstaged, and untracked changes. Ignored files stay out.", and a primary "Commit all" button.
     `Ctrl/Cmd+Enter` submits. The form is hidden when the working tree is clean.
3. Clean state: Changes card shows an empty state "Working tree clean" / "No staged, unstaged,
   untracked, or conflicted files."

Rail (`rail-stack`):

1. **Application** card: runtime pill, kind badge, project link, path in mono.
2. **Remotes** card: name + redacted fetch URL per remote; empty state "No remotes configured."
3. **Last commit** card: subject, short hash in mono, author, relative time with an absolute
   `title`; empty state "No commits yet."

### Responsive behavior

- `>=1280`: two columns (main + 320px rail) via existing `workbench-grid--detail`.
- `768-1279`: single column; rail stacks below the main card stack.
- `<768`: single column; page header actions wrap; the git action bar wraps; the branch switch and
  commit footer stack vertically; file paths wrap (`overflow-wrap:anywhere`); no horizontal
  overflow. Touch targets follow the existing 44px phone rules.
- The page scrolls normally; the existing shell owns navigation and drawers.

### Client behavior and states

`assets/git.js` is a dependency-free IIFE using DOM APIs and `textContent` only, following
`assets/chat.js`:

- on load, fetch `/git/status`, replace the skeleton with the rendered state, and announce
  "Repository status loaded." in a dedicated `#git-live` polite live region;
- every action posts JSON, disables/serializes the panel, shows `aria-busy` and an outcome label
  ("Fetching", "Updating", "Pushing", "Committing", "Switching"), and re-renders from the status in
  the response; errors keep current data and show an inline error with `role="alert"`;
- the pressed button keeps focus (`aria-disabled` + `aria-busy`, guard re-entry); other controls are
  disabled; on commit success, focus moves to the Changes card title;
- Refresh and status load failures render an inline error state with Retry; fetch/update/push
  failures render an inline error in the Repository card; commit/switch failures render beside the
  form; errors are persistent until the next action or refresh;
- no full-page reload and no toast for routine success; the changed panel is the confirmation. No
  confirmation dialogs in this pass; the visible file groups and commit hint state what "Commit all"
  includes. This is accepted debt; a confirmation for untracked files can be added later;
- `401` from the JSON API navigates to `/login?next=<current local path>`; the HTML page itself
  redirects unauthenticated/agent principals to login as existing pages do. `409 busy` shows "Another
  git operation is already running for this application." A network error after Commit does not
  retry blindly; the client refetches status first so a successful commit is not repeated;
- a missing app renders the existing styled 404.

### Loading and exceptional states

- **Initial loading**: page header and rail Application card render immediately; Repository, Changes,
  Remotes, and Last commit cards render skeleton blocks with `aria-busy="true"` and a visually
  hidden "Loading repository status."
- **Non-git directory**: the main column shows an empty state "Not a git repository" / "This
  application path is not a git working tree. Git status and actions are unavailable." with an
  "Open IDE" action; the rail still shows the Application card.
- **Not a repository root**: empty state "Not a repository root" / "This application is inside a
  larger git repository. Git actions are only available when the application directory is the
  repository root." with the detected root and an "Open IDE" action.
- **Path outside workspace**: an error state "Repository path outside the workspace" / "Git actions
  are blocked because the registered path is outside the coordinator workspace." with the path and
  an "Open project" action. No retry.
- **Missing path**: empty state "Application path not found" / "The registered path does not exist.
  Restore it or update the application manifest." with an "Open project" action.
- **Detached HEAD**: branch shows "Detached HEAD" (cancelled status pill); upstream "No upstream";
  Update, Push, and Commit disabled with the hint "Detached HEAD. Switch to a branch before
  committing."; Refresh/Fetch/Switch remain available.
- **Unborn branch** (no commits yet): branch shows the configured branch name; "No commits yet" in
  the Last commit card; Update and Push disabled; Commit is allowed if there are changes and the
  identity is configured.
- **No upstream, `origin` exists**: Update disabled; Push enabled as "Push and set upstream"; hint
  "Pushes to `origin/<branch>` and sets the upstream."
- **No upstream, no `origin`**: Update and Push disabled; hint "Set an upstream branch in git to
  update or push."
- **No remote**: Fetch, Update, and Push disabled; hint "No remotes configured. Local commits still
  work." Commit still works.
- **Missing commit identity**: Commit disabled with the hint "Set `user.name` and `user.email` in the
  repository or host git config before committing."
- **Conflicts**: Conflicted group and a failed "Conflicts" status pill; Commit, Update, and Switch
  disabled; hint "Resolve conflicts in the IDE before committing."; link to IDE.
- **In-progress operation** (merge/rebase/cherry-pick/revert): "In progress" status pill; Commit,
  Update, and Switch disabled; hint "Finish or abort the operation in the IDE."
- **Git lock held** (`index.lock`): error "Repository is locked" / "Another git process is using this
  repository. Wait for it to finish or remove a stale lock."; retry available.
- **Busy**: one in-flight action at a time per repository; actions are serialized; a second attempt
  is rejected by the server with `409 busy`.
- **Large change sets**: no virtualization; all files render. `maxBuffer` is 8 MiB; exceeding it
  returns `output_too_large` rather than a generic failure.
- **No JavaScript**: `<noscript>` shows "Git actions need JavaScript. Use the IDE for repository
  operations." with an IDE link; the rest of the application page remains usable.

### Copy

| Context | Copy |
| --- | --- |
| Page description | Repository state, branch, and lightweight git actions for this application. |
| Status pills | Clean / Changes / Conflicts / Detached / In progress |
| Ahead/behind | `<n> ahead` / `<n> behind` |
| Upstream absent | No upstream |
| Branch switch label | Switch branch |
| Actions | Refresh / Fetch / Update branch / Push / Push and set upstream / Commit all |
| Commit hint | Commits all staged, unstaged, and untracked changes. Ignored files stay out. |
| Clean empty | Working tree clean / No staged, unstaged, untracked, or conflicted files. |
| No remotes | No remotes configured. |
| No commits | No commits yet. |
| Fetch success | Fetched all remotes. |
| Update success | Branch updated to `<short sha>`. |
| Push success | Pushed to `<upstream>`. |
| Commit success | Committed as `<short sha>`. |
| Switch success | Switched to `<branch>`. |
| Non-git | Not a git repository / This application path is not a git working tree. Git status and actions are unavailable. |
| Not a repository root | Not a repository root / This application is inside a larger git repository. Git actions are only available when the application directory is the repository root. |
| Outside workspace | Repository path outside the workspace / Git actions are blocked because the registered path is outside the coordinator workspace. |
| Missing path | Application path not found / The registered path does not exist. Restore it or update the application manifest. |
| Fetch/update/push failure | Action failed / <server message> |
| Update diverged | Update stopped / The branch has diverged from its upstream. Reconcile it in the IDE. |
| Update blocked by changes | Update stopped / Commit or discard the changes that would be overwritten, then update again. |
| Push rejected | Push rejected / The remote has commits you do not have. Fetch and update the branch, then try again. |
| Commit failure | Commit failed / <server message> |
| Commit identity missing | Set `user.name` and `user.email` in the repository or host git config before committing. |
| Switch failure | Could not switch branch / <server message> |
| Git locked | Repository is locked / Another git process is using this repository. Wait for it to finish or remove a stale lock. |
| Session expired | Session expired. Sign in again. |

### Accessibility

- `h1` from `pageHeader`; cards are `h2` with `aria-labelledby`; file groups use `h3`.
- Status is glyph + text + color; conflicts and in-progress operations are not conveyed by color
  alone.
- File rows expose the full change label to assistive technology; the one-letter code is visual only.
- Forms have visible labels; hints/errors are wired with `aria-describedby`; `aria-invalid` is set on
  validation failure.
- One polite `#git-live` region announces load and action results; errors use `role="alert"`; the
  whole panel is not a live region.
- Busy state uses `aria-busy`; the pressed action keeps focus; focus moves to a sensible heading
  after a control disappears.
- Icon-only refresh has an accessible name. Disabled actions have a visible reason.
- Loading skeleton is `aria-hidden`; `aria-busy` and text convey loading.
- Existing focus-visible rings, reduced-motion behavior, and 44px phone targets are preserved.
- Paths wrap instead of forcing horizontal scroll.

## Backend design

### Modules and service lifetime

- `src/git/service.ts` - `GitService`, `GitError`, the status parser, and output redaction.
- `src/http/git.ts` - `handleGit(deps, request)`: authentication, routing, JSON parsing, validation,
  error mapping.
- `src/http/application.ts` - `renderApplication(site, projectId, appKey, chrome)`: the server-
  rendered page shell and skeletons.
- `src/http/apps.ts` - shared `findApp(deps, projectId, appKey)` and `appDir(project, app)` helpers
  used by chat, dashboard, handler, application page, and `GitService`.
- `src/http/auth.ts` - shared `cookieToken`, `principalFrom`, `humanFrom`; use type-only imports (or a
  shared types module) to avoid a runtime cycle under `verbatimModuleSyntax`. `server.ts`'s
  cookie-only `isHumanAuthed` remains separate because `/ide` intentionally rejects bearer tokens;
  it reuses `cookieToken` from this module.
- `src/http/server.ts` - dispatch the git API to `handleGit` before the chat/handler split.
- `src/http/handler.ts` - Application page route, asset allowlist entry, shared auth imports.
- `src/http/ui.ts` - no changes expected beyond shared helper extraction.
- `assets/git.js` - client hydration and actions.
- `src/http/styles.css` - git panel classes using existing tokens.
- `DESIGN.md` - document the git panel components and status mapping.

`GitService` is constructed **once** in `serveCommand` and passed through `HttpDeps.git`; constructing
it per request would make its mutation lock a no-op. The service is testable by injecting a command
runner (default: `execFile`) and by exporting the status parser as a pure function. The mutation lock
is keyed by `realpath(toplevel)`, not app id, so two app keys resolving to the same repository still
serialize. A pre-existing `.git/index.lock` is detected and returned as `409 git_locked`; the
in-memory lock does not cover agents/IDE writing to the same repository.

### Repository resolution and containment

For a `(projectId, appKey)` pair:

1. find the project via `deps.getProjects()` and the app via `project.service.listApps()`;
2. resolve the app directory with the shared rule (absolute path stays absolute, relative path
   resolves against `project.rootPath`); `realpath` the app directory and `realpath` the workspace
   root; reject if the app directory is not the workspace root or below it;
3. run `git -C <appDir> rev-parse --is-inside-work-tree` and `git -C <appDir> rev-parse
   --show-toplevel`; reject non-worktrees;
4. `realpath` the discovered toplevel and re-check workspace containment; then require
   `realpath(toplevel) === realpath(appDir)` for this pass, otherwise return `state: "not_root"`;
5. reject missing paths with `state: "missing"`.

The page does not trust the client for paths: project id and app key are looked up server-side. The
resolved toplevel is used as `cwd` for all commands. `realpath`-then-exec is a TOCTOU window in a
workspace writable by agents; accepted for this trust model and recorded in the security section.

### Commands

All commands run with `cwd` at the repository toplevel, argument arrays, no shell:

| Operation | Command |
| --- | --- |
| status | `git -c core.quotePath=false status --porcelain=v2 --branch --untracked-files=all -z` |
| branches | `git for-each-ref --format=%(refname:short) refs/heads` |
| remotes | `git remote -v` |
| last commit | `git log -1 --format=%H%x00%h%x00%s%x00%an%x00%cI` |
| identity | `git var GIT_AUTHOR_IDENT` |
| fetch | `git fetch --all --prune` |
| update | `git pull --ff-only` |
| switch | `git switch -- <branch>` after live re-validation against local branches |
| commit | `git add -A` then `git commit -m <message>` (signing is detected and refused; see below) |
| push | `git push`, or `git push -u origin <branch>` when no upstream and `origin` exists |

Every invocation is prefixed with `git -c color.ui=false` so stderr cannot inject ANSI; the status
command also passes `-c core.quotePath=false`. Environment for every command:
`GIT_TERMINAL_PROMPT=0`, `GCM_INTERACTIVE=never`, `LC_ALL=C`, `LANG=C`, `GIT_EDITOR=:`,
`GIT_MERGE_AUTOEDIT=no`, `GIT_PAGER=cat`. Do not override `GIT_SSH_COMMAND` or `GIT_ASKPASS`;
credentials are injected by the deployment environment. `execFile` options: `timeout` (status 30s,
checkout/commit 30s, fetch/update 120s, push 180s), `maxBuffer` 8 MiB, `encoding: "utf8"`,
`killSignal: "SIGKILL"`.

Commit hardening:
- reject NUL and control characters (except newline/tab) in the commit message before `execFile`;
- detect `commit.gpgsign=true` (or `tag.gpgsign` not relevant) and refuse with "Commit signing is
  enabled; commit from the IDE." rather than silently bypassing signing or hanging on a pinentry;
- do not disable hooks; repository hooks run as the coordinator (trusted-repo assumption);
- a stale `index.lock` is reported as `git_locked`; the user can remove it in the IDE.

### Porcelain v2 status parser

`git status --porcelain=v2 --branch --untracked-files=all -z` is NUL-separated, including the
`# branch.*` header records. The parser splits on `\0` and consumes:

- `# branch.oid <sha>|(initial)`
- `# branch.head <branch>|(detached)`
- `# branch.upstream <upstream>`
- `# branch.ab +N -M`
- `1 XY sub mH mI mW hH hI <path>`
- `2 XY sub mH mI mW hH hI <Xscore> <path>` followed by a second NUL field `<origPath>`
- `u XY sub m1 m2 m3 mW h1 h2 h3 <path>`
- `? <path>`

Rules:

- header records are NUL-terminated when `-z` is used; do not split on newlines;
- `branch.oid` may be `(initial)`; `branch.head` may be `(detached)`;
- parse `branch.ab` only when an upstream exists; absent means `upstream: null`;
- for `1`/`2`, X is the index state and Y the worktree state; `.` means unchanged. Emit one
  `GitFile` with `group: "staged"` when X is not `.` and one with `group: "unstaged"` when Y is not
  `.` (so `MM` produces two entries with the same path); for `2`, preserve `oldPath`;
- `u` records are `group: "conflicted"`; preserve the XY pair for display/accessibility;
- `?` records are `group: "untracked"`;
- `clean` is `files.length === 0`;
- `git log -1` exit 128 with "does not have any commits yet" is `lastCommit: null`, not an error;
- an unborn branch is `branch.name` from `branch.head` with `branch.head: null`; `for-each-ref` may
  be empty, so the current branch is added to the UI branch list if absent;
- paths may contain spaces/newlines/non-ASCII; never parse paths by splitting on spaces.

### Status model

```ts
type GitRepoState = "ok" | "not_git" | "not_root" | "missing";
type GitOperation = "merge" | "rebase" | "cherry-pick" | "revert";
type FileGroup = "staged" | "unstaged" | "untracked" | "conflicted";

interface GitFile {
  path: string;
  oldPath?: string;
  code: string; // M, A, D, R, C, T, ?, U
  group: FileGroup;
}

interface GitStatus {
  state: GitRepoState;
  root?: string;
  message?: string;
  branch?: { name: string | null; detached: boolean; head: string | null };
  upstream?: { name: string; ahead: number; behind: number } | null;
  clean?: boolean;
  files?: GitFile[];
  branches?: string[];
  remotes?: Array<{ name: string; url: string }>;
  lastCommit?: { hash: string; shortHash: string; subject: string; author: string; committedAt: string } | null;
  operation?: GitOperation | null;
  conflicted?: boolean;
  identity?: { configured: boolean };
}
```

For `state !== "ok"`, repository fields are omitted and `message` explains the state. `operation` is
detected via `git rev-parse --git-path` + filesystem checks for `MERGE_HEAD`, `CHERRY_PICK_HEAD`,
`REVERT_HEAD`, `rebase-merge`, and `rebase-apply`.

### API response contract

- Success: `{ status: GitStatus | null, message: string, warning?: string }`, plus
  `{ commit: { hash, shortHash, subject } }` for commit.
- Error: `{ error: string, code: string }`.
- Status codes: `400` invalid JSON/input or wrong content type; `401` not signed in; `403` non-human
  or outside workspace; `404` project/app not found; `409` busy, git locked, no upstream, detached,
  conflicts, operation in progress, nothing to commit, branch no longer exists, not a repository,
  not a repository root, missing path, update diverged, update blocked by local changes; `413`
  request body too large; `502` remote network/auth failure; `500` unexpected local failure.
- Error codes: `invalid_input`, `outside_workspace`, `not_git`, `not_root`, `missing_path`, `busy`,
  `git_locked`, `no_upstream`, `detached`, `conflicts`, `operation_in_progress`, `nothing_to_commit`,
  `branch_not_found`, `diverged`, `worktree_dirty`, `push_rejected`, `auth_failed`, `timeout`,
  `output_too_large`, `git_failed`.
- POST requests must send `Content-Type: application/json` (optional charset); form-encoded requests
  are rejected. `readBody` is capped at 64 KiB and returns `413` above it.
- Body validation: `branch` must be a non-empty string present in the live local branch list, must not
  begin with `-`, and must not contain control characters; `message` must be trimmed, 1-4000
  characters, and free of NUL/control characters (newline/tab allowed).
- If an action succeeds but the follow-up status read fails, retry the status once, then return
  success with `status: null` and `warning: "Action completed; refresh status."`. For commit, include
  the commit hash from the commit output. Never return an error that invites a duplicate commit or
  push.

### Concurrency and failure handling

- `GitService` keeps a per-`realpath(toplevel)` mutation lock. Mutation endpoints return `409 busy`
  while a mutation runs; status reads are allowed. The lock is released in `finally`.
- A pre-existing `.git/index.lock` is detected before mutations and returned as `409 git_locked`.
- Commit and update refuse to run while the index has unmerged entries or a merge/rebase/cherry-pick/
  revert is in progress. Commit checks this before `git add -A`; otherwise staging conflicted files
  with markers would be possible. Return `409 conflicts` or `operation_in_progress`.
- Git non-zero exits are converted to `GitError` with a stable code, a redacted message, and the
  captured stderr (redacted before truncation to 4000 characters). Do not expose unbounded output.
- `ERR_CHILD_PROCESS_STDIO_MAXBUFFER` maps to `output_too_large`; `ETIMEDOUT`/`killed` maps to
  `timeout`.
- A failed `git add -A` aborts before commit; a failed commit leaves changes staged and reports that
  in the message. A commit-hook failure is distinguished from nothing-to-commit by the captured
  output and the post-command status.
- Missing git author identity is preflighted via `git var GIT_AUTHOR_IDENT`; the Commit button is
  disabled with actionable copy before the user types a message.
- Remote failure mapping: network/auth failures are `502 auth_failed`/`git_failed`;
  non-fast-forward push is `409 push_rejected`; ff-only divergence is `409 diverged`; local changes
  that would be overwritten are `409 worktree_dirty`.

### Security

- human-only page and API; agent principals are rejected with `403` by `handleGit` (use
  `principalFrom` + kind check, not `humanFrom`, so the response is 403 rather than 401). Existing
  HTML pages redirect agent principals to login, which is unchanged.
- path containment with `realpath`, workspace boundary, toplevel re-check, and the repository-root
  rule;
- no shell; argument arrays only; branch switch uses `git switch -- <branch>` and rejects leading
  dashes/control characters;
- JSON-only mutations and a 64 KiB body cap; existing `SameSite=Strict` cookie; no CSRF token
  introduced;
- timeouts and output caps prevent a hung or noisy git process from blocking the coordinator;
- redact all URL userinfo in remote URLs and git output (`scheme://...@`, including token-only and
  percent-encoded forms) before truncation; consider masking query-string tokens;
- commit message and branch are passed as arguments, never interpolated into a shell string;
- no credential store wiring in this stage; deployment credentials remain ambient;
- accepted risks: repository hooks execute as the coordinator; `fetch --all` contacts every
  configured remote with ambient credentials; agents/IDE can race the index outside the in-memory
  lock; `realpath`-then-exec is TOCTOU in a writable workspace.

## Alternatives considered

- **Git panel on the project page or chat rail**: rejected for ambiguity, footprint, and accidental
  action risk (see UI placement).
- **Server-rendered live status**: rejected because the page handler is synchronous and git reads are
  async; a skeleton plus hydration avoids blocking page render.
- **Synchronous `execFileSync`**: rejected because fetch/push can block the event loop; the existing
  add-app clone limitation is not a pattern to repeat.
- **Making the main handler async**: rejected as a wider refactor; a separate async `handleGit`
  module mirrors the existing `handleChat` split.
- **`simple-git` or another dependency**: rejected; argument-array `execFile` is sufficient and
  matches the project's no-dependency client/server style.
- **Commit selected files / diff viewer**: rejected for this pass; adds UI and state complexity.
- **Containing-repository behavior for subdirectory apps**: rejected for this pass; it would commit
  and push sibling apps/project files from an application-scoped page. See the repository-root rule.
- **Credential-store integration**: rejected for this pass; deployment credentials remain ambient and
  the existing encrypted store is left untouched.

## Impact

- New page and API surface; no database migration.
- No change to existing API response shapes.
- Small navigation changes on the project page and chat context rail.
- New asset `assets/git.js` added to the strict asset allowlist.
- `readBody` gains a 64 KiB cap and a 413 response; existing HTML/API callers are unaffected for
  normal form sizes.
- Design-system contract gains git panel classes and a status mapping.
- Deployment docs gain notes on ambient push credentials and git identity.

## Open questions

None. The owner delegated implementation decisions; the decisions above are recorded, including the
repository-root rule. Residual risks are explicitly accepted: "Commit all" can include untracked files
(visible in the panel, no confirmation dialog), push requires ambient credentials, and repository
hooks run as the coordinator.

## Review

Design review: `oracle`, 2026-10-19, **PASS-WITH-CHANGES**. Findings folded into this document:

- Required: `GitService` lifetime is long-lived and lock keyed by toplevel; `index.lock` handling.
- Required: push/no-upstream contradiction reconciled (Push and set upstream when `origin` exists).
- Required: containment re-checked after `--show-toplevel`; app must be the repository root.
- Required: porcelain-v2 parser fully specified (`-z`, headers, detached, unborn, `MM` entries).
- Required: in-progress merge/rebase/cherry-pick/revert states guarded.
- Required: error taxonomy refined; 409 for client-correctable states, 502 reserved for remote
  failures; update divergence and dirty-worktree codes added.
- Required: option-safe branch switch (`git switch -- <branch>`, reject leading dashes/control
  characters).
- Required: redact all URL userinfo, before truncation.
- Required: shared auth/app-resolution helpers; `handleGit` returns 403 for agents.
- Required: test seams, parser fixtures, real-git integration, post-action status contract.
- Required: commit hardening (`color.ui=false`, signing detection, control-character rejection,
  stale-lock copy).
- Recommended: application page in its own module; status-pill mapping in `DESIGN.md`; docs updates;
  request body cap; remote fetch URL/dedupe; output-overflow mapping; identity preflight; trust/ops
  notes; client 401/busy/network behavior; discriminated `not_git` shape.
