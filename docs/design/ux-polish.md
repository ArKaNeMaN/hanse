# Design - UX/UI polish pass

Status: **design review PASS-WITH-CHANGES; findings folded; ready for plan review.** This document is
a contract for implementation. It does not authorize code changes before plan review clears (see
[`docs/process.md`](../process.md)).

Date: 2026-10-21.

Scope: the application page, hierarchical settings at every scope, the per-application operator
terminal, runtime/chat state truthfulness, and the small design-system extensions those require.

Out of scope: a new visual identity, a shell redesign, new product features, new settings keys, new
chat capabilities, and changes to the embedded IDE's appearance.

Visual authority: [`DESIGN.md`](../../DESIGN.md) ("The Chart Room"). This pass keeps the ink/steel/brass
palette, serif ledger titles, humanist sans, mono machine data, hairlines, radius scale, and motion
rules. It changes **hierarchy, disclosure, and state truth**, not the brand.

Binding for this design:

| Binding | Value |
| --- | --- |
| Design reviewer | `oracle` |
| Plan reviewer | `momus` |
| Implementation gates | `npm run lint`, `npm run typecheck`, `npm test`, `npm run build` |
| Browser gate | real Playwright Chromium at 390 / 768 / 1024 / 1440, dark and light |
| Evidence | `docs/design/artifacts/ux/` |
| Language | English |

---

## 0. Decisions at a glance

| Area | Decision |
| --- | --- |
| Application page order | Page header -> **state strip** -> git workbench. The Image card moves into the git rail. Git is the first and largest job. |
| Application header | Two labelled secondary actions (`Open chat`, `Terminal`) plus one ghost overflow menu (`Open IDE in this folder`, `Application settings`). No header primary; `Commit all` remains the page's only brass action. |
| Pending restart | Stated **once per page**, in the state strip's Settings cell. The full-width banner and the rail badge are removed. Restart is one control in the Runtime cell, confirmed when the agent is running. |
| Image | One rail card with a `.status` pill, one refresh, one build action, an `Image details` disclosure (ref, built, rollback, build logs), and a confirmed rollback. Build never auto-restarts. Rollback is explicitly "Roll back and restart". |
| Settings IA | Sticky scope/section navigation, four job-based sections (Agent, Web tools, Git, Restart), and one collapsed **setting row** per setting. Scope tables and editors are inside the row disclosure. |
| Settings actions | At rest: zero submit buttons. One primary `Save` per open row; `Inherit` and `Clear` are secondary in the open row and disabled (with a visible reason) when they are no-ops. Global scope hides `Inherit`. |
| Settings validation | Non-Git forms post via `settings.js` with `Accept: application/json`; errors render inline in the row and keep values/focus. No-JS falls back to the current redirect + toast. Git credential forms are JS-required (existing JSON contract) and carry a `<noscript>` notice. |
| Terminal | Full-height page on vendored xterm.js 6.0.0 + `@xterm/addon-fit` 0.11.0. Binary input frames, text control frames, `TERM=xterm-256color`, 5000-line scrollback, fit/resize, copy/paste, reconnect backoff, close reasons, stopped-agent state. No tabs, splits, search, or persistence. |
| Runtime state | One vocabulary: `starting`, `running`, `stopped`, `error`. `error` no longer renders as Stopped; `starting` no longer renders as Stopped; error counts become real. |
| Restart route | Calls `manager.restartIfRunning()`, never bare `stopApp()`. Reports restart failure instead of claiming success. |
| Chat runtime | `/api/apps/:app/runtime` is the only source for both runtime chips. Hydration, sending, and errors no longer guess runtime state. |
| Chat Ready | Queue/active-prompt/running-tool checks outrank `idle`; `Ready` can no longer coexist with an active or queued prompt. |
| Chat connection lane | SSE lifecycle is its only writer. Hydration, session switch, and send no longer set `Live`/`Reconnecting`/`Ready`. |
| Pending restart persistence | Applied settings hash and profile flag are persisted on `instances`; reattach reads them instead of recording the current hash as applied. |
| New design tokens | **None.** New classes compose existing tokens only. |

---

## 1. Design thesis and principles

**Thesis.** The Chart Room does not need a new face; it needs better bearing. The page's main job
should own the fold, every state should be stated once and truthfully, and configuration should
reveal itself when the operator asks for it rather than occupying the page by default.

### P1 - One job above the fold

The application page is a git workbench. Repository, changes, remotes, and last commit stay first.
Image, runtime, and settings become compact supporting surfaces. No secondary card may push the main
job below the fold.

### P2 - State is stated once, in one vocabulary

Runtime, image, settings-pending, and chat connection are different things. Each gets one location
on a page and one label set. Duplicate banners, badges, and guessed chips are removed. A state that
the server cannot prove is shown as unknown or unavailable, never as a confident green.

### P3 - Progressive disclosure over always-open forms

Settings expose the effective value and its source at rest. Editing, scope history, inherited rows,
and destructive actions appear only when the row is opened. The same rule applies to image logs and
build details.

### P4 - Real tools behave like real tools

The terminal is a terminal: alternate screen, ANSI, scrollback, resize, IME, copy/paste, and clear
connection states. "Advanced" features may be omitted, but the basic contract may not be faked with
a `<pre>` and a textarea.

Non-negotiable existing behaviour: no visual rebrand; the shell, type scale, chart ground, hairline
material, and status-glyph rule stay. No new color, size, spacing, radius, shadow, or motion value.

---

## 2. Application page

### 2.1 New hierarchy

The page is rendered top to bottom as:

```text
page-header            overline, serif app key, one-line description, project/kind/path meta, actions
state-strip            Runtime | Settings                          (one row, two cells)
workbench-grid--detail
  main column          Repository card
                       Changes card
  rail (320px)         Image card
                       SSH access card
                       Remotes card
                       Last commit card
noscript               unchanged git fallback
```

Rules:

- The pending banner, the standalone full-width Image card, the full-width SSH access card, and the
  Application rail card are removed.
- The git workbench remains the widest and tallest region at every breakpoint. `Repository` and
  `Changes` keep their current internal design, actions, skeletons, and `assets/git.js` contract.
- The rail is supporting information only: Image (actionable), SSH access (allowed hosts and pending
  approvals plus the existing `/ssh?project=&app=` Manage link), Remotes, Last commit. No identity
  repetition (project, kind, path live in the page header meta).
- `#ssh-panel` and `#ssh-panel-title` stay on the compact rail card so the SSH feature tests and
  deep links keep working; the card keeps the `sshHostsByApp` / `sshPendingByApp` counts and renders
  no new controls beyond the Manage link.
- At `< 1280px` the rail stacks after the main git column; the page remains one column. At `>= 1280px`
  it is the existing 320px rail. The Image and SSH cards are therefore below git on tablet/phone,
  which is correct for secondary surfaces.

### 2.2 Page header and action model

Page header content:

- Overline: `Application`.
- Title: the application key (serif `h1`).
- Description: `Repository state and lightweight git actions for this application.`
- Meta: project name, kind, application path in mono. `pageHeader.meta` takes escaped plain strings,
  so the project link stays in the breadcrumb and is not duplicated inside the meta row.
- Breadcrumb: `Projects / <project> / <appKey>`, unchanged.

Action model:

| Slot | Control | Variant | Notes |
| --- | --- | --- | --- |
| 1 | `Open chat` (message icon) | `.btn.btn-secondary` | Primary destination for agent work; not duplicated elsewhere on the page. |
| 2 | `Terminal` (terminal icon) | `.btn.btn-secondary` | Operator shell. |
| 3 | Overflow (`More actions`, ellipsis icon) | `.btn.btn-ghost.btn-icon` inside `<details class="menu">` | Contains two links: `Open IDE in this folder` and `Application settings`. |

- No header primary. The page's single brass action is `Commit all` inside the Changes card, matching
  the git workbench contract. This preserves one accent per screen.
- The old `Open IDE` button is not repeated as a label; the overflow item names the folder-specific
  action so it is distinguishable from the generic IDE icon in the top bar.
- The old `Settings` button is removed from the header and the rail; the overflow item is the only
  Application settings entry on the page. The contextual sidebar Settings link (Section 3.2) is the
  second route and is navigation, not a page action.
- The menu is a native `<details>` disclosure containing ordinary links. It does not use
  `role="menu"` or roving tabindex, because it is a short link list, not an application menu.
  `assets/app.js` gains one small handler for `details.menu`: outside click and Escape close the open
  menu and return focus to its summary; without JS the links remain reachable by opening the
  disclosure.
- At `< 480px` the existing `.page-header__actions` rule makes the labelled buttons share the row;
  `.page-header__actions .menu { flex: none; }` keeps the overflow icon at its 44px target. No
  wrapping to a second action line.

### 2.3 State strip

A new two-cell strip sits directly below the page header and above the git workbench. It replaces
three separate surfaces: the pending banner, the rail Application card, and the hidden runtime.

```html
<section class="state-strip" id="app-state" aria-label="Application state">
  <div class="state-strip__cell" id="runtime-state">
    <span class="state-strip__label">Runtime</span>
    <div class="state-strip__value"><!-- runtimePill(runtime) --></div>
    <div class="state-strip__actions" id="runtime-actions">
      <!-- one restart form, only when running/starting -->
    </div>
  </div>
  <div class="state-strip__cell" id="settings-state">
    <span class="state-strip__label">Settings</span>
    <div class="state-strip__value"><!-- Applied / Restart required --></div>
    <div class="state-strip__actions"><!-- link to settings; no second restart --></div>
  </div>
</section>
```

**Runtime cell.** Shows exactly one runtime pill from Section 5.1. When the state is `running` or
`starting`, it also shows one `Restart agent` secondary button. That button opens the confirmation
dialog `#app-restart-dialog`; the dialog's form posts to the existing restart route. When the state
is `stopped` or `error`, no restart button is shown: `restartIfRunning()` cannot start a stopped
agent, and offering a button that lies is worse than offering none.

**Settings cell.** Four states:

| Condition | Label | Supporting copy | Action |
| --- | --- | --- | --- |
| `site.pendingRestart` is true (known reason) | `.status data-state="awaiting_approval"` **Restart required** | `The agent is running with older settings.` | None here; the restart control is in the Runtime cell. |
| `site.pendingRestart` is true (`applied_state_unknown`) | `.status data-state="awaiting_approval"` **Restart required** | `The coordinator cannot confirm which settings this running agent loaded.` | None here; the restart control is in the Runtime cell. |
| Not pending, manager configured | `.status data-state="delivered"` **Applied** | `Settings match the running agent.` | `Review settings` link. |
| Manager not configured | `.status data-state="cancelled"` **Unavailable** | `The agent runtime is not configured.` | `Review settings` link. |

This is the only pending-restart statement on the application page. The restart button is the only
restart control. The rail and banner duplicates are deleted.

**Confirmation dialog.** `#app-restart-dialog` uses the native `.dialog` primitive:

- Title: `Restart <appKey>?`
- Body: `An active turn will be interrupted. Sessions are kept.`
- Cancel: `.btn.btn-ghost` `Cancel`.
- Confirm: `.btn.btn-primary` `Restart agent` (submit to the existing
  `/api/apps/<appKey>/restart?project=<projectId>` with `return_to`).
- Focus returns to the trigger on close (native dialog behaviour plus the existing `app.js` helper).

### 2.4 Image card (rail)

The Image card is one bounded object in the rail. It has three server-rendered states: configured
build, default image, and build error. It is hydrated by `assets/images.js`.

```html
<section class="card" id="image-panel"
         data-project-id="..." data-app-key="..."
         data-status="ready|missing|building|stale|error|default"
         data-image-ref="sha256:..."
         data-image-url="/api/apps/<app>/image?project=<p>"
         data-logs-url="/api/apps/<app>/image/logs?project=<p>"
         data-runtime-url="/api/apps/<app>/runtime?project=<p>">
  <div class="card__head">
    <h2 class="card__title" id="image-title">Image</h2>
    <div class="cluster">
      <span class="status" id="image-status" data-status="ready" data-state="delivered">[check] Built</span>
      <button class="btn btn-ghost btn-icon btn-sm" id="image-refresh"
              type="button" aria-label="Refresh image status" title="Refresh image status">[refresh]</button>
    </div>
  </div>
  <div class="card__body stack--tight">
    <p class="sr-only" id="image-live" role="status" aria-live="polite" aria-atomic="true"></p>
    <div class="cluster">
      <form method="post" action="<buildHref>">
        <input type="hidden" name="return_to" value="<appHref>" />
        <button class="btn btn-secondary btn-sm" type="submit" id="image-build">
          [layers]<span class="btn__label">Rebuild image</span>
        </button>
      </form>
    </div>
    <p class="mono" id="image-ref">sha256:...</p>
    <p class="small" id="image-hint">The image matches the current Dockerfile and default base.</p>
    <p class="small" id="image-notice" hidden>Restart the agent to use the new image.</p>
    <p class="field-error" id="image-error" role="alert" hidden></p>

    <details class="disclosure" id="image-details">
      <summary>Image details</summary>
      <div class="stack--tight">
        <div class="summary-row"><span class="overline">Built</span>
          <span id="image-built" data-built-at="..."><time ...>...</time></span></div>
        <div class="summary-row"><span class="overline">Previous</span>
          <span class="mono" id="image-rollback-ref">sha256:...</span></div>
        <div class="summary-row"><span class="overline">Previous built</span>
          <span id="image-rollback-built" data-built-at="...">...</span></div>
        <form method="post" action="<rollbackHref>" id="image-rollback-form" hidden>
          <input type="hidden" name="return_to" value="<appHref>" />
          <button class="btn btn-secondary btn-sm" type="button" id="image-rollback"
                  data-dialog-open="image-rollback-dialog">
            [refresh]Roll back
          </button>
        </form>
        <details class="disclosure" id="image-logs-details">
          <summary>Build logs</summary>
          <pre class="mono image-logs" id="image-logs">No build logs yet.</pre>
        </details>
      </div>
    </details>
  </div>
</section>
```

**Status mapping.** Image status uses `.status` (glyph + text + semantic ink), never `.badge`.
`#image-status` carries both `data-status` (the raw server state, retained for tests and hydration)
and `data-state` (the semantic pillar below). `Ready` is removed from the image vocabulary so it
cannot collide with chat's agent `Ready`.

| Image state | Label | `data-state` | Glyph |
| --- | --- | --- | --- |
| `missing` | **Not built** | `queued` | clock |
| `building` | **Building** | `in_progress` | activity/loader |
| `ready` | **Built** | `delivered` | check |
| `stale` | **Out of date** | `expired` | hourglass |
| `error` | **Build failed** | `failed` | alert-triangle |
| `default` | **Default image** | `cancelled` | layers |

**Default-image state.** The card is not a dead end:

- Head status: `Default image` (layers glyph, steel ink).
- Body: `This application uses the shared default agent image.` and
  `Add .hanse/Dockerfile to build a custom image for this application.`
- One action: `Open application folder` (ghost, external icon) linking to the folder-specific IDE
  URL. No build, logs, rollback, or refresh controls are rendered.
- The existing `#image-panel`, `#image-status` with `data-status="default"` (and
  `data-state="cancelled"` on the pill), and `#image-ref` (`Default agent image`) stay so hydration
  and tests can distinguish the state.

**Build / rebuild semantics.**

- `Build image`, `Rebuild image`, and `Retry build` are one server form, never a client fetch. The
  button is `.btn.btn-secondary.btn-sm`; `Commit all` remains the only primary.
- While `building`: the build button is `disabled` and `aria-busy="true"` with label `Building…`;
  rollback is disabled; the logs disclosure opens automatically and polls every 3s.
- Build never restarts the agent and never claims to. `images.js` fetches the runtime endpoint on
  load and after every build/rollback. When the runtime is `running`/`starting`, it compares the
  runtime's `imageRef` (added to `/api/apps/:app/runtime`) with the card's `data-image-ref`. If they
  differ, it shows: `Restart the agent to use the new image.` with no extra restart control (the
  Runtime cell owns it). If the card is the default image, `data-image-ref` is absent, or the
  runtime endpoint has no `imageRef` (legacy instance), the comparison and hint are skipped rather
  than guessed.
- A build error keeps the previous image and renders `#image-error` as `.field-error` with
  `role="alert"`. No `.small` error text.

**Rollback semantics.** Rollback is destructive to the running image choice, so it is confirmed:

- `#image-rollback-form` remains in the card so `images.js` can hide/show it from the rollback ref.
  Its `#image-rollback` button is `type="button"` and only opens `#image-rollback-dialog`.
- `#image-rollback-dialog` contains its own `<form method="post" action="<rollbackHref>">` with
  the same `return_to`; only that dialog form submits the rollback. The dialog cancel button is
  `type="button"` and closes it.
- Dialog title: `Roll back image?`
- Body: `This replaces the current image with <previous ref> and restarts the agent. An active turn
  will be interrupted.`
- Confirm label: `Roll back and restart`; Cancel: `Cancel`.
- If runtime is `stopped`, body says `This replaces the current image with <previous ref>.` and the
  confirm label is `Roll back image`; the server's `restartIfRunning()` returns false and does not
  start it.
- The server renders `#image-rollback-dialog` even when no previous image exists, with
  `#image-rollback-dialog-ref` and a confirm button whose label is client-updatable. The trigger
  form is hidden when there is no previous image, so the dialog is unreachable in that state.
- The server keeps its current scheduling of `restartIfRunning()` after the rollback response. The
  asymmetry with build is intentional and is stated in the dialog, not hidden.

**Logs and live regions.**

- Exactly one polite live region in the card: `#image-live`. The status pill is not a live region;
  `pre#image-logs` loses `aria-live`.
- Logs live in the closed `Image details > Build logs` disclosure. `images.js` fetches logs when the
  disclosure opens and, while building, when it polls. It does not fetch logs on every page load.
- Log update preserves scroll: if the operator was at the bottom, keep them at the bottom after an
  update; otherwise keep the current `scrollTop`. Never replace `textContent` on every poll when the
  text is unchanged.
- `#image-notice` is written only by `images.js` after a build/rollback comparison; it is hidden by
  default and is not a live region. `images.js` also updates `#image-panel.dataset.imageRef` from
  the status response so the next runtime comparison uses the new reference.
- One refresh button (`#image-refresh`) refreshes status and, if the logs disclosure is open, logs.
  `#image-logs-refresh` is removed.
- `timeTag()` semantics are kept for built timestamps; hydration updates `datetime` and `title`, not
  just text.

**Hydration contract.**

- `images.js` updates `.btn__label` inside `#image-build`; it never assigns `button.textContent`,
  which previously dropped the server icon.
- `#image-status` is updated with `className = "status"` and `dataset.state`, plus text and glyph
  preservation; hydration must not strip the glyph. The server renders the glyph; the client swaps
  only the `<use href>` target (`#i-check`, `#i-clock`, ...) and label text.
- Optional elements are optional per state. The script requires `#image-panel`, `#image-status`, and
  `#image-ref`, but must not return early or throw when `#image-built`, `#image-logs`, or
  `#image-rollback-form` is absent (default-image and missing-image states).
- The client uses the same six-state table as the server (Section 7 copy deck).
- Polling runs only while `building`; otherwise it stops.
- A 401 redirects to `/login?next=...` as today.

### 2.5 SSH access card (rail)

The merged SSH feature keeps its application page entry as one compact rail card rather than a
full-width block above the workbench:

- Keeps `#ssh-panel` and `#ssh-panel-title`; head title `SSH access`, trailing ghost `Manage` link to
  the existing `/ssh?project=<id>&app=<key>` route.
- Body: `<n> allowed hosts` and, when non-zero, a `.status data-state="awaiting_approval"` stamp with
  the clock/stamp glyph and `<m> pending approvals`; zero pending is plain `No pending approvals.`
  in `.small`.
- Uses `site.sshHostsByApp` / `site.sshPendingByApp`; no new route or data.
- No forms, no host list, no approval actions on the application page; those stay on `/ssh`.
- On `< 1280` it stacks with the rest of the rail after the git workbench.

### 2.6 Git workbench preservation

The git workbench is unchanged in behaviour and keeps its DOM contract:

- `#git-panel`, `data-project-id`, `data-app-key`, `data-api-base`.
- `#git-live`, `#git-refreshed`, `#git-refresh`, `#git-repository-body`, `#git-changes-body`,
  `#git-remotes-body`, `#git-last-commit-body`, `#changes-title`, `#git-change-counts`.
- `#repository-card`, `#repository-title`, `#changes-card`, and the Remotes/Last commit cards.
- Fetch, update, switch, commit, push, branch switch, remotes, last commit, file groups, skeletons,
  busy states, errors, no-JS fallback, and all copy from
  [`git-workbench.md`](./git-workbench.md).

Only the surrounding composition changes: `Repository` and `Changes` sit in the main column; Remotes
and Last commit move below the Image card in the rail; the Application rail card is deleted.

### 2.7 Pending restart, once

- The full-width `#settings-pending` banner is removed.
- The rail `Restart required` badge is removed.
- The state strip's Settings cell is the single occurrence.
- The restart button is the Runtime cell's single control.
- The settings page (Section 3.9) has its own pending section because it is a different route; that
  is not duplication across one page.
- The project application table keeps its per-row `Restart required` badge because each row is a
  different application; it links to that application's settings page as today.

### 2.8 Empty and default states

| Surface | State | Rendering |
| --- | --- | --- |
| Image | default image | Compact rail card with `Default image`, one sentence, `Open application folder`. |
| Image | missing | `Not built`, build action, no logs/rollback. |
| Image | no logs | `No build logs yet.` inside the open disclosure. |
| Runtime | stopped | `Stopped` pill, no restart action. |
| Runtime | error | `Error` pill with alert glyph, no restart action (restart cannot start it). |
| Settings | manager absent | `Unavailable` pill, `Review settings` link. |
| SSH | no pending approvals | allowed-host count plus `No pending approvals.`; no stamp. |
| SSH | pending approvals | `.status data-state="awaiting_approval"` stamp with the count and Manage link. |
| Git | any | Existing git empty/error states from `git-workbench.md`, unchanged. |

### 2.9 Responsive behaviour

| Width | Behaviour |
| --- | --- |
| `>= 1280` | Header actions inline. State strip two columns. Main git column + 320px rail (Image, SSH access, Remotes, Last commit). |
| `1024-1279` | Header actions inline. State strip two columns. Git and rail in one column; Image follows Changes, then SSH access, then Remotes, then Last commit. |
| `768-1023` | Same single column. Header actions remain one row; two labelled buttons plus the overflow icon. No horizontal overflow. |
| `< 768` | Page gutters `--gutter-sm`; state strip becomes two stacked cells separated by a hairline; labelled actions share the full-width action row; all controls resolve to 44px; image refs/paths wrap (`overflow-wrap: anywhere`). |
| `< 480` | The two labelled header actions flex-grow; overflow stays icon-sized. No action wraps to a second line. |

Scroll ownership is unchanged: `.page` is the only vertical scroll container; the new strip and rail
do not create nested page scrollers.

### 2.10 DOM ids and test impact

Kept (required by `git.js` / `images.js` / tests):

`#git-panel`, `#git-live`, `#git-refreshed`, `#git-refresh`, `#git-repository-body`,
`#git-changes-body`, `#git-remotes-body`, `#git-last-commit-body`, `#changes-title`,
`#git-change-counts`, `#repository-card`, `#repository-title`, `#changes-card`, `#remotes-title`,
`#last-commit-title`, `#image-panel`, `#image-status`, `#image-live`, `#image-ref`, `#image-built`,
`#image-rollback-ref`, `#image-rollback-built`, `#image-rollback-form`, `#image-error`,
`#image-hint`, `#image-logs`, `#image-build`, `#image-refresh`, `#ssh-panel`, `#ssh-panel-title`.

New:

`#app-state`, `#runtime-state`, `#runtime-actions`, `#runtime-restart` (form),
`#settings-state`, `#app-restart-dialog`, `#image-details`, `#image-logs-details`,
`#image-rollback-dialog`, `#image-rollback-dialog-ref`, `#image-notice`.

Removed:

`#settings-pending` (banner), `#image-logs-refresh`, the rail Application card and its
`#application-card-title`, `#image-title` stays on the rail card head.

Test updates:

- `test/application-page.test.ts`
  - Replace the `id="settings-pending"` banner assertions with `id="app-state"`,
    `id="runtime-state"`, `id="settings-state"`, and one restart form.
  - Remove assertions for `>Application</h2>` and `Application settings` as a body link; assert the
    overflow menu contains `Application settings` and `Open IDE in this folder`.
  - Keep all git and image id assertions. Assert `#image-status` has class `status` (not `badge`) and
    a glyph, and that `#image-logs` is inside `#image-details`.
  - Assert exactly one `Restart required` occurrence when pending.
- `test/app-image-api.test.ts`: no API change; keep.
- `test/application-ssh.test.ts`: assert `#ssh-panel` is in the rail, keeps the allowed/pending counts
  and the Manage link, and is not a full-width block above the workbench.
- `test/terminal-http.test.ts`: page ids change as specified in Section 4.7.

---

## 3. Settings

### 3.1 Information architecture

All three scopes render the same page skeleton. Only the scope navigation and the applicable rows
change.

```text
page-header              overline, title, description (no repeated scope/model meta)
settings-nav (sticky)    scope links | section jump links
warnings                 only when resolved.warnings is non-empty (compact, one block)
#settings-agent card     Model row
                         Providers subsection (provider rows + Add provider key)
#settings-web card       Web search row
                         Web fetch row
#settings-git card       User name row
                         User email row
                         SSH credential row
                         HTTPS credential row
#settings-restart card   Restart & pending
                         OMO profile warnings (app scope only)
```

- No per-setting cards. Four section cards replace seven setting cards plus a providers card plus a
  pending card.
- No top scope card. Scope and section navigation share one sticky bar.
- No repeated effective-value badge + line + table. The row summary carries label, effective value,
  and source in one line; scope history is one disclosure inside the row.
- The `meta` line is removed from the page header (`model <value>` and the scope label were
  repetition).

### 3.2 Scope and section navigation

```html
<nav class="settings-nav" aria-label="Settings">
  <div class="settings-nav__scopes" role="group" aria-label="Settings scope">
    <a class="settings-nav__link" href="/settings" aria-current="page">Global</a>
    <a class="settings-nav__link" href="/projects/p1/settings">Project</a>
    <a class="settings-nav__link" href="/projects/p1/apps/web/settings">Application</a>
  </div>
  <div class="settings-nav__sections" aria-label="Settings sections">
    <a class="settings-nav__link" href="#settings-agent">Agent</a>
    <a class="settings-nav__link" href="#settings-web">Web tools</a>
    <a class="settings-nav__link" href="#settings-git">Git</a>
    <a class="settings-nav__link" href="#settings-restart">Restart</a>
  </div>
</nav>
```

- The current scope is a `<span aria-current="page">`, not a link to itself; other applicable scopes
  are links. Global shows only `Global` (the scope group is hidden when there is one scope).
- Project shows `Global` + `Project`. Application shows all three. The operator can move sideways
  and downward, not only upward.
- The bar is `position: sticky; inset-block-start: 0; z-index: var(--z-sticky)`, opaque `--canvas`,
  bottom hairline. It sticks under the top bar because `.page` is the scroll owner.
- The sidebar Settings entry becomes contextual. `ShellOptions` gains `settingsHref?: string`
  (default `/settings`). Project pages pass `/projects/<id>/settings`; application, chat, and terminal
  pages pass the application settings path; settings pages pass their own path. `active: "settings"`
  remains only on settings routes. The label stays `Settings`.
- The breadcrumb stays; at `< 640px` it is hidden, but the sticky nav still names the current scope,
  so context is not lost.

### 3.3 Compact setting row

One `<details class="setting-row">` per setting. Closed is the default. Native `<details>` keeps the
page working without JavaScript.

```html
<details class="setting-row" id="setting-llm-model">
  <summary class="setting-row__summary">
    <span class="setting-row__title">Model</span>
    <span class="setting-row__effective">
      <span class="mono">anthropic/claude-sonnet</span>
      <span class="setting-row__source">from Project</span>
    </span>
    <span class="setting-row__state"><!-- optional status pill for Cleared/Error --></span>
    <span class="setting-row__chevron">[chevron-down]</span>
  </summary>
  <div class="setting-row__body">
    <p class="hint">Selected model applies to new sessions and OMO agents; existing sessions may
      keep their model.</p>
    <p class="field-error" data-settings-error role="alert" hidden></p>
    <form class="setting-row__form" method="post" action="/api/settings" data-settings-form>
      <!-- hiddenTarget(scope,target,returnTo#setting-llm-model) -->
      <input type="hidden" name="key" value="llm.model" />
      <div class="field">
        <label class="label" for="model-value">Model</label>
        <input class="input" id="model-value" name="value" type="text"
               placeholder="Inherited: anthropic/claude-sonnet" required autocomplete="off" />
      </div>
      <div class="setting-row__actions">
        <button class="btn btn-primary btn-sm" type="submit" name="action" value="set">Save</button>
        <!-- Inherit: hidden at global; disabled with a reason when already absent -->
      </div>
    </form>
    <details class="scope-details">
      <summary>Scope details</summary>
      <dl class="scope-list"><!-- one row per applicable scope --></dl>
    </details>
  </div>
</details>
```

Row rules:

- Summary is one line at desktop: title, effective value in mono, source, optional state pill, chevron.
  At `< 768` it becomes a two-line block: title + source on line one, effective value on line two.
- `min-block-size: var(--space-10)` at desktop, 44px at `< 768` (existing touch rule).
- The row is separated by a hairline, not a card. Section cards own the outer border.
- Only the summary is visible at rest. No inputs, no submit buttons, no scope tables, no provider
  forms.
- Opening a row reveals: hint, inline error slot, the current editor, and `Scope details`.
- Closing a row discards unsaved input (native details). This is accepted: settings are explicit,
  not drafts.
- `summary` contains no interactive elements. Buttons live in the body.
- The chevron is a 12px icon, rotated 180deg when open, `--dur-micro` transform only. Reduced motion
  makes the rotation immediate.

### 3.4 Scope details

Replace the seven always-visible 3-column tables with one compact definition list per row, inside
the row's `Scope details` disclosure. At global scope the disclosure is omitted (one scope = no
history worth showing).

```html
<dl class="scope-list">
  <div class="scope-list__row">
    <dt>Global</dt>
    <dd><span class="mono">x</span><span class="scope-list__state">Set</span></dd>
  </div>
  <div class="scope-list__row">
    <dt>Project</dt>
    <dd><span class="scope-list__state">Inherited</span></dd>
  </div>
</dl>
```

- States: `Set`, `Cleared`, `Inherited`. Values are mono; state is plain caption text, not a pill.
- Only applicable scopes render (global, global+project, global+project+app).
- The row summary's source line already answers the common question. The disclosure answers "which
  scope set this and what does each scope hold?".
- `scope-list` rows are 24px (`var(--space-6)`) with 8px gaps, no table header.

### 3.5 Action model and no-op rules

At rest, a row exposes no action button. Open, it exposes one primary `Save` and, where applicable,
secondary `Inherit` and `Clear`. There is no overflow menu inside a setting row: the collapsed row
is the overflow. The only always-visible submit forms on a settings page are the pending-restart
forms (and only when an app is pending); with no pending apps, the resting page has zero submit
buttons.

`Save` is the only primary in an open row. `Clear` uses `.btn.btn-danger.btn-sm` only when it creates
or represents a tombstone; `Inherit` uses `.btn.btn-secondary.btn-sm`. `Cancel` is not a button;
closing the summary discards.

| Key type | Scope | Save | Inherit | Clear |
| --- | --- | --- | --- | --- |
| `llm.model` | global | `Set model` -> `Save` | Hidden | Hidden (not clearable) |
| `llm.model` | project/app | `Save` | Disabled when current scope state is `absent`; enabled when `set` | Hidden |
| `web.search`, `web.fetch` | global | `Save` | Hidden | Enabled unless current scope is already `cleared`; copy warns it disables everywhere |
| `web.search`, `web.fetch` | project/app | `Save` | Disabled when current scope is `absent`; enabled when `set` or `cleared` | Enabled unless current scope is already `cleared` |
| `git.user.name`, `git.user.email` | global | `Save` | Hidden | Hidden |
| `git.user.name`, `git.user.email` | project/app | `Save` | Disabled when `absent`; enabled otherwise | Hidden |
| Provider key | global | `Set key` -> `Save` | Hidden | Enabled unless `status.state === "cleared" && status.source === "global"` |
| Provider key | project/app | `Save` | Enabled only when `status.source === current scope`; disabled otherwise | Enabled unless already cleared at this scope |
| Git SSH/HTTPS credential | global | `Set credential` -> `Save` | Hidden | Enabled unless `gitAuthScoped[kind].global === "cleared"` |
| Git SSH/HTTPS credential | project/app | `Save` | Enabled when `gitAuthScoped[kind][scope] !== "absent"`; disabled otherwise | Enabled unless already `cleared` at this scope |

Disabled controls carry a visible reason in the row body, not only a `title`:

- Inherit disabled: `Already inherited from <source>.`
- Clear disabled: `Already cleared at this scope.`
- Global Clear: `Clearing here disables this setting for every application.`

`Clear` never deletes a wider value; it writes a tombstone at this scope, as today. `Inherit` removes
this scope's row, as today. No server action or endpoint changes.

**Clear confirmation.** `Clear` is a tombstone, not a cosmetic reset, so it is confirmed:

- One shared `#settings-clear-dialog` per settings page is used for `/api/settings` and
  `/api/settings/provider` forms. `settings.js` intercepts a submit whose submitter has
  `data-confirm-clear` and opens the dialog instead of posting.
- The dialog contains its own `<form method="post">`; on open, `settings.js` copies the source
  form's hidden fields (`scope`, `projectId`, `appKey`, `return_to`, `key`) and sets
  `action=clear`. The confirm button submits that dialog form directly (no `requestSubmit` loop,
  no double interception), then the normal server redirect/toast applies.
- Dialog title: `Clear <setting> at this scope?`
- Body: `Wider scopes will no longer apply. The setting stays disabled until you set it again.`
- Provider body: `Wider keys and host auth will be suppressed for this application.`
- Confirm: `.btn.btn-danger` `Clear setting`; Cancel: `.btn.btn-ghost` `Cancel`.
- Without JavaScript the clear posts directly (degraded); this is accepted debt.
- Git credential Clear is **excluded** from the shared dialog because `git-settings.js` posts JSON
  immediately: that script adds a native confirmation before sending `action=clear` (same pattern as
  the SSH page's `data-ssh-confirm`). The Git section renders a `<noscript>` notice: `Git credential
  changes require JavaScript.` Git credential forms are therefore JS-required; all other settings
  forms keep the redirect/toast fallback.

`Inherit` is not confirmed: it only removes the current scope's row and is undone by `Set`.

### 3.6 Prefill, override, and validation

**Prefill is own-scope only.** This is the rule that fixes accidental overrides.

| Editor | Prefill when this scope has a value | Prefill when this scope inherits |
| --- | --- | --- |
| Model | The own-scope value. | Empty input; placeholder `Inherited: <effective>`; required. |
| Web search/fetch driver | The own-scope driver and its fields. | A disabled placeholder option `Choose a driver`; no driver fields until chosen. A banner inside the body reads `This scope inherits <driver> from <source>. Saving creates an override.` |
| Git user name/email | The own-scope value. | Empty input; placeholder `Inherited: <effective>`. |
| Provider key | Never prefilled; keys are never returned. Status line shows effective source. | Same. |
| Git credentials | Never prefilled; secrets are never returned. Status line/scope list shows source. | Same. |

- Effective value and source are always visible in the collapsed summary, so an empty editor never
  hides the current state.
- Server implementation: `webControls` and `driverFields` receive the own-scope value from
  `resolved.scoped[<scope>:web.search|web.fetch]`, not `resolved.effective.web.*`. Model and
  identity editors read their own-scope value from `resolved.scoped` the same way.
- Web driver fields use the existing `data-settings-driver` / `data-driver-fields` toggle. When the
  driver placeholder is selected, all per-driver groups are hidden and `required` fields are
  inactive.

**Validation and error placement.**

- Every non-Git settings form gets `data-settings-form`, `data-no-busy`, a `[data-settings-error]`
  slot in its row body, and `data-success-notice` (`Settings saved.` for `/api/settings`,
  `Provider key updated.` for `/api/settings/provider`). `data-no-busy` disables the shared
  `assets/app.js` submit handler so it cannot leave a stale spinner after a rejected JSON submit;
  `settings.js` owns `aria-busy` and re-enables the form in `finally`.
- `assets/settings.js` intercepts submit:
  1. Set the row's error slot hidden, clear `aria-invalid`.
  2. Build the body with the submitting button included:
     `new URLSearchParams(new FormData(form, event.submitter))`. `FormData` does not include a
     submitter's `name=action` on its own, and the server needs `action=set|clear|inherit`.
     Send it urlencoded: `Content-Type: application/x-www-form-urlencoded` and
     `Accept: application/json`. The server's `parseForm` and `parseObjectBody` already accept this
     shape; all existing actions, fields, and endpoints are unchanged. (Do not send `FormData`
     directly: that is `multipart/form-data`, which `parseForm` does not parse.)
  3. On `4xx`: read `{ error }`, write it into `[data-settings-error]` as `.field-error` with
     `role="alert"`, add `aria-invalid="true"` and `aria-describedby` to the first editable control,
     focus it, and keep every submitted value in place.
  4. On success: navigate to `return_to` with the form's success notice inserted before any hash,
     matching the server's `withNotice()` rule; `return_to` includes `#setting-<key>` so the page
     returns to the row. No double submit.
  5. Re-enable the form after failure.
- Git credential forms keep their existing `assets/git-settings.js` JSON path and inline
  `[data-git-error]`; the row wrapper must not interfere. `data-git-test` stays. They also carry
  `data-no-busy` (the script already owns `setBusy`) and are not `data-settings-form`.
- Without JavaScript the non-Git forms still submit normally; errors use the current redirect +
  toast and lose values. Git credential forms are JS-required and carry the `<noscript>` notice
  above. This is the only degraded path and is listed as accepted debt.

### 3.7 Providers

Providers are a subsection of `Agent`, not a standalone card.

- Section head: `Providers` with mono count.
- One row per provider: provider id in mono, status text (`Set at Global`, `Cleared at Project`,
  `Host auth (api)`, `Missing`, `Error: ...`), source, and a `Change key` disclosure.
- Open row: one password input (`autocomplete="new-password"`, blank), `Save`, `Clear`, `Inherit`
  with the no-op rules above. The key is never shown.
- `Add provider key` is one closed disclosure at the end of the subsection: provider id + key +
  `Save`. It is not an always-visible form.
- A provider that the effective model or a web tool references but has no key shows `.status
  data-state="failed"` or `cancelled` with the reason in the row, replacing the top warning where
  the warning belongs to that provider.
- The section keeps `id="providers"` and `id="providers-title"` for tests.

### 3.8 Git credential section (preserved)

The merged Git credentials work (stage 0010, migration 8) is preserved exactly at the protocol level:

- Endpoint: `POST /api/settings/git` with JSON body, `kind` `ssh|https`, actions `set|clear|inherit`.
- Assets: `assets/git-settings.js`; `data-git-auth`, `data-git-test`, `data-git-error`,
  `data-git-test-result`, `data-git-test-summary`, `data-git-test-warnings`, `data-git-test-error`.
- IDs: `#git-ssh-public-key`, `#git-ssh-fingerprint`, `#git-https-allowed-hosts`,
  `#git-https-username-value`, `#git-ssh-private-key`, `#git-ssh-known-hosts`, `#git-https-hosts`,
  `#git-https-username`, `#git-https-token`, `#git-ssh-test-remote`, `#git-https-test-remote`.
- Test connection remains app-scope only; wider scopes keep the existing "run it from an
  application settings page" affordance.
- Security notes and the local-only validation sentence stay, moved into the open Git section body.
- Only presentation changes: identity rows use the setting-row pattern; SSH/HTTPS rows use the same
  pattern with a `.status` pill summarizing state, scope details collapsed, credential metadata
  (public key/fingerprint/allowed hosts/known_hosts) inside the open row, and the form below it.
- Scope state uses `gitAuthScoped[kind]`; no new server data is required.

### 3.9 Warnings, pending restart, and profile warnings

- `resolved.warnings` renders as one compact block immediately below the sticky nav, before the
  sections, only when non-empty: alert glyph + each message as `.field-error` with `role="alert"`.
  It is not a full card.
- Model/provider/web-tool warnings render inside their owning row (above the editor), not in a
  separate top card.
- Pending restart renders once in `#settings-restart` as a compact list:
  - Each row: app key link, `Restart required` status, human reason (`Settings changed`,
    `Agent profile not applied`, `Applied state unknown`), and one `Restart agent` form posting to
    the existing route with this page as `return_to`.
  - Empty: `No running agents are waiting for a restart.`
  - Hint: `Settings changes apply only on an explicit restart. A restart interrupts an active turn;
    sessions are kept.`
- OMO profile warnings stay in `#settings-restart` on app settings, below pending.
- The page does not show a pending banner elsewhere.

### 3.10 Quantified vertical-space reduction

Measured from the current render contract (table header 32px, rows 40px; seven scoped tables):

| Scope | Current scope-table area (desktop) | New visible scope area (desktop) | Reduction |
| --- | --- | --- | --- |
| Global | ~500px | 0px of tables; rows carry the value/source | ~44% shorter section stack (7 x 40px rows replace 7 cards + tables) |
| Project | ~780px | 0px of tables; 7 x 40px rows | >= 64% |
| Application | ~1060px | 0px of tables; 7 x 40px rows | >= 74% |

| Scope | Current scope-table area (390px) | New visible scope area (390px) | Reduction |
| --- | --- | --- | --- |
| Global | ~740px | 7 x 44px rows = 308px | >= 58% |
| Project | ~1490px | 308px | >= 79% |
| Application | ~2200px | 308px | >= 86% |

Additional default-view reduction:

- Always-visible settings forms: 8 -> 0 at rest (one per open row).
- Submit buttons: 26 -> 0 at rest when no app is pending (one primary per open row; pending-restart
  forms are the only exception).
- Text/password inputs: ~20 -> 0 at rest.
- Scope tables: 7 -> 0 at rest.
- Setting cards: 7 + providers + pending -> 4 section cards + 1 pending section.

Acceptance target for the browser gate: the app-scope settings page is at least **55% shorter** at
1440 and at least **60% shorter** at 390 than the pre-change page with the same data, measured from
the top of `.page__body` to the bottom of `#settings-restart` with all rows closed.

### 3.11 Responsive behaviour

| Width | Behaviour |
| --- | --- |
| `>= 1024` | Sticky nav: scopes left, sections right on one line. Row summary is one line. Section cards use full content width. |
| `768-1023` | Sticky nav wraps to two lines if needed. Row summary remains one line; effective value truncates with ellipsis, source stays visible. |
| `< 768` | Sticky nav is two rows: scope links (44px targets) and a horizontally scrollable section strip (no primary-content overflow). Row summary is two lines. Open editors are one column; action buttons wrap; all controls 44px. |
| `< 480` | Scope links become a three-item segmented row (`Global`, `Project`, `App`) if all three apply, otherwise two. Section strip scrolls horizontally. |

No horizontal scroll of primary content at 390. The only horizontal scroller is the section strip,
which is a navigation control.

### 3.12 DOM, JS, and test impact

Kept: `#setting-llm-model`, `#setting-web-search`, `#setting-web-fetch`, `#git-identity-name`,
`#git-identity-email`, `#git-ssh`, `#git-https`, `#providers`, `#providers-title`, `#git`,
`#git-title`, `#restart-pending`, `#restart-pending-title`, all Git credential ids and data
attributes, `data-settings-driver`, `data-driver-fields`, `hiddenTarget` field names
(`scope`, `projectId`, `appKey`, `return_to`).

New: `#settings-agent`, `#settings-web`, `#settings-git`, `#settings-restart`,
`#settings-clear-dialog`, `.settings-nav`, `.setting-row`, `.scope-list`, `data-settings-form`,
`[data-settings-error]`, `data-settings-inherit`, `data-confirm-clear`, `data-success-notice`.

Removed: per-setting `.card` wrappers, `#settings-scope-title`, the top Scope card, the top
Warnings card, and the seven `.table` scope tables from the resting DOM (they are replaced by
`.scope-list` inside disclosures).

Test updates:

- `test/settings-http.test.ts`
  - Assert the four section headings (`Agent`, `Web tools`, `Git`, `Restart & pending`) and one
    `details.setting-row` per setting.
  - Assert the seven scope tables are gone; assert `.scope-list` rows inside `details`.
  - Assert `disabled` on `Inherit`/`Clear` no-ops and `hidden`/absent Inherit at global.
  - Assert inputs are blank for inherited web/model values and the placeholder names the effective
    value.
  - Keep the unique-id assertion; add `data-settings-form` count.
- `test/git-settings-asset.test.ts`: assert the Git markup still contains `data-git-auth`,
  `data-git-test`, and every credential id inside the row disclosures.
- `test/git-auth-store.test.ts` / `test/git-credentials.test.ts`: no change.
- No endpoint or action tests change except the restart route (Section 5.2).

---

## 4. Operator terminal

### 4.1 Page shape

The terminal is a full-height route, like chat. It has no page header block, chart ground, or card
frame.

```text
.page--terminal
  .page__body.page__body--terminal
    #terminal.terminal-shell
      .terminal-toolbar        h1 appKey + "Operator terminal" | runtime pill | connection pill | Copy | Reconnect | Close
      .terminal-banner         in-flow, only on closed/reconnect/stopped states
      .terminal-host           xterm canvas, fills remaining height
      .terminal-announcer      visually hidden polite status
```

- `renderTerminalPage()` renders `#terminal.terminal-shell` as the only child of the page body and
  passes `pageClass: "page--terminal"` and `bodyClass: "page__body--terminal"`.
- `.page--terminal`: `display: grid; grid-template-rows: minmax(0, 1fr); overflow: hidden;
  background-image: none;`
- `.page__body--terminal`: `display: grid; grid-template-rows: minmax(0, 1fr); padding: 0;
  max-inline-size: none; margin-inline: 0; block-size: 100%; min-block-size: 0;`
- `.terminal-shell`: `display: grid; grid-template-rows: auto auto minmax(0, 1fr);
  block-size: 100%; min-block-size: 0; background: var(--inset);`
- `.terminal-banner[hidden]` uses `display: none` so its auto row collapses; the host always wins
  the `minmax(0, 1fr)` row.
- `.terminal-host`: `min-block-size: 0; overflow: hidden;` and hosts the xterm element.
- `.terminal-toolbar`: `min-block-size: var(--space-12)` (48px), `--surface-1`, bottom hairline,
  inline padding `--gutter-sm`/`--gutter` by breakpoint. It is the page's `h1` region; the title uses
  the serif display family at `--text-h2` (a full `--text-h1` block would waste terminal height).
- The runtime pill is the corrected server-rendered runtime pill (Section 5.1). The connection pill
  is client-owned (`#terminal-status`).
- Actions: `Copy` (ghost icon+label, enabled when selection exists), `Reconnect` (secondary),
  `Close` (ghost). At `< 640px` labels become visually hidden, icons remain, all controls 44px, and
  the toolbar wraps to two rows: title + connection pill on the first, runtime pill + actions on the
  second. The title truncates with ellipsis; the toolbar never forces horizontal overflow.
- A `.terminal-banner` sits between toolbar and host only when the connection is not live; it is
  in-flow so it never covers output. It uses surface 2 + hairline, never a colored side stripe.

### 4.2 xterm integration

Load order on the terminal page (all `defer`):

1. `/assets/app.js` (already in `documentPage`).
2. `/assets/vendor/xterm/xterm-6.0.0.js` (UMD global `Terminal`).
3. `/assets/vendor/xterm/addon-fit-0.11.0.js` (UMD global `FitAddon.FitAddon`).
4. `/assets/terminal.js`.

Stylesheet order:

1. `/assets/vendor/xterm/xterm-6.0.0.css`.
2. `/assets/app.css` (loads last so hanse tokens/overrides win).

`documentPage()` / `appShell()` gain `styles?: string[]`; the terminal page passes the xterm
stylesheet. This is the only shell API addition.

Terminal construction:

```js
const fit = new FitAddon.FitAddon();
const term = new Terminal({
  fontFamily: monoToken,
  fontSize: pxFromRemToken("--text-mono"),
  lineHeight: 1.5,
  letterSpacing: 0,
  cursorBlink: !prefersReducedMotion,
  cursorStyle: "bar",
  scrollback: 5000,
  screenReaderMode: true,
  allowTransparency: false,
  convertEol: false,
  allowProposedApi: false,
  theme: readTerminalTheme(),
});
term.loadAddon(fit);
term.open(host);
fit.fit();
```

- `readTerminalTheme()` reads computed CSS custom properties from `document.documentElement` and
  returns the token values, so light/dark stay in sync with the rest of the product. It is called at
  init and again when `data-theme` changes (MutationObserver on `<html>`); then `term.options.theme`
  is replaced.
- No new colors. ANSI 16 mapping:

| ANSI / xterm key | Token |
| --- | --- |
| black / background | `--text-2` / `--inset` |
| red | `--status-failed` |
| green | `--status-delivered` |
| yellow | `--status-awaiting` |
| blue | `--status-dispatching` |
| magenta | `--status-expired` |
| cyan | `--status-in-progress` |
| white | `--text-1` |
| bright black | `--text-3` |
| bright red | `--danger` |
| bright green | `--success` |
| bright yellow | `--warning` |
| bright blue | `--info` |
| bright magenta | `--brass` |
| bright cyan | `--status-in-progress` |
| bright white | `--text-1` |
| cursor | `--brass` |
| cursorAccent | `--inset` |
| selectionBackground | `--selection` |
| selectionForeground | `--text-1` |
| foreground | `--text-1` |

All entries are theme-aware semantic tokens; no raw primitive that changes meaning between dark and
light (`--paper-50`, `--ink-*`) is used for terminal text. The same table is re-read when
`[data-theme]` changes.

- `fontSize` derives from `--text-mono` (0.75rem -> 12px at the default root), never a literal.
- `screenReaderMode: true` is deliberate: it gives xterm a live row for assistive technology. The
  toolbar connection pill is the single polite live region for connection changes; xterm owns output
  announcements.
- Under `prefers-reduced-motion: reduce`, `cursorBlink` is false and no transform animations are
  added.

### 4.3 Connection lifecycle and status

Before opening a WebSocket, `terminal.js` fetches `data-runtime-url`
(`/api/apps/<appKey>/runtime?project=<projectId>`). If the reported state is `stopped` or `error`,
it renders the stopped empty state and does not open a socket. A runner HTTP 409 on the upgrade is
not observable to the browser (it surfaces as a generic `1006`), so the runtime endpoint is the only
reliable preflight; `Reconnect` repeats it.

One WebSocket per page. The status pill (`#terminal-status`) has these states:

| State | Label | Tone | Behaviour |
| --- | --- | --- | --- |
| `connecting` | `Connecting` | `.status data-state="queued"` | Initial; no banner. |
| `live` | `Live` | `.status data-state="in_progress"` | Socket open; input enabled. |
| `reconnecting` | `Reconnecting in Ns` | `.status data-state="dispatching"` | Banner with countdown; input disabled. |
| `paused` | `Paused` | `.status data-state="cancelled"` | Manual close of the retry loop; `Reconnect` available. |
| `stopped` | `Agent stopped` | `.status data-state="queued"` | Runtime endpoint says not running; no socket. |
| `closed` | `Terminal closed` / `Shell exited` | `.status data-state="cancelled"` | Close code 1000/1001 from the runner; no auto-retry. `Terminal closed` is shown only when the local manual-close flag is set. |
| `failed` | `Connection failed` | `.status data-state="failed"` | Close 1011 or repeated abnormal closes. |

Backoff:

- Abnormal close (`1006`, network error, no close frame): retry after 1s, 2s, 4s, 8s, 15s, then stay
  at 15s. Show the countdown. `Reconnect` retries immediately and resets the schedule.
- Normal shell exit (`1000` / `1001`) does not auto-retry; the banner says
  `Shell exited. Reconnect to start a new shell.`
- Runner exec failure (`1011`) retries with the same backoff and shows `Connection failed.`.
- Manual `Close` sets a local `closedByOperator` flag, sends `1000` with reason
  `closed by operator`, stops the retry loop, and leaves scrollback readable. The close handler
  renders `Terminal closed. The application keeps running.` instead of `Shell exited.` Closing never
  stops the container.
- On any close, `terminal.js` fetches `/api/apps/:app/runtime` once. If the state is `stopped` or
  `error`, it switches to the stopped state instead of blaming the network.
- On reconnect, `term.reset()` then `fit()`; a new shell must not inherit stale scrollback from the
  dead PTY. Manual close does not reset (the operator can read it).

### 4.4 Fit and resize

- `FitAddon.fit()` on: socket open, `ResizeObserver` on `.terminal-host`, window resize,
  `visualViewport.resize`, `document.fonts.ready`, and after the toolbar/banner changes height.
- Debounce with `requestAnimationFrame`; send a resize control only when `term.cols`/`term.rows`
  changed.
- Control frame: text JSON `{"type":"resize","cols":N,"rows":M}`. Clamp 1..1000; the runner already
  validates this and rejects anything else.
- Initial size is sent on open after `fit()`, so the PTY starts at the real viewport instead of the
  Docker default.
- Mobile keyboard: `visualViewport` resize triggers fit; tapping the terminal calls `term.focus()`;
  the hidden xterm textarea handles IME and autocorrect is disabled by xterm. `fontSize` stays
  12px; no zoom control in this pass.

### 4.5 Input, copy, and paste

- Output: binary frames are passed to `term.write(new Uint8Array(event.data))` unchanged. Do not
  text-decode in the client; xterm handles split UTF-8 and escape sequences correctly.
- Input: `term.onData(data)` encodes to UTF-8 and sends **binary** frames. `term.onBinary(data)`
  is also wired: each code unit is sent as one raw byte for the legacy/mouse sequences xterm emits
  through that event. This removes the protocol collision where pasted text shaped like
  `{"type":"resize",...}` could be interpreted as a control message. Text frames are reserved for
  controls.
- Large paste: chunk encoded input into 16 KiB binary frames so a paste cannot exceed the runner's
  1 MiB WebSocket message cap. Split on a UTF-8 boundary (never between a leading byte and its
  continuation bytes) so multibyte characters survive.
- Copy:
  - `Ctrl+Shift+C` and `Cmd+C` copy the current selection when one exists. `Cmd+C` with no selection
    falls through to the browser.
  - Plain `Ctrl+C` always sends `\x03` (SIGINT); it is never intercepted for copy.
  - The `Copy` toolbar button copies the selection; it is disabled when the selection is empty.
  - `navigator.clipboard` requires a secure context; on plain-HTTP LAN deployments use the
    hidden-textarea + `document.execCommand("copy")` fallback, and disable the Copy button with
    `title="Copy is unavailable in this browser"` when neither path exists. Never fail silently.
  - After copy, announce `Copied selection.` in a visually hidden polite status node
    (`#terminal-announcer`), not a toast.
- Paste:
  - `Ctrl+Shift+V` and `Cmd+V` paste clipboard text through `term.paste(text)` when the Clipboard
    API is available; otherwise the native xterm textarea and the browser context-menu paste remain
    the fallback path.
  - The browser context menu paste and xterm's own textarea paste also work.
  - Do not paste on plain `Ctrl+V` (keep it available for shell/readline needs on platforms where
    the browser delivers it); the explicit shortcut is the contract.
- `attachCustomKeyEventHandler` returns false only for the shortcuts above, so xterm continues to
  handle arrows, function keys, Alt/Meta sequences, and IME.

### 4.6 Stopped-agent behaviour

There is no "start agent" endpoint today. The terminal must not fake one.

- The server renders `data-runtime-state` and `data-runtime-url` on `#terminal`.
- If the state is `stopped` or `error`, the host is replaced by an in-place empty state:
  - Mark: terminal icon plate.
  - Title: `Agent is not running`.
  - Body: `The terminal attaches to the running application container. Open chat to start the
    agent, then reconnect.`
  - Actions: `Open chat` (secondary, links to the chat workspace) and `Reconnect` (ghost).
- `Reconnect` re-fetches runtime; if still stopped, the state stays. If the operator started the
  agent from chat, the next `Reconnect` opens the socket.
- A WebSocket HTTP rejection (runner 409 `app is not running`) is mapped to the same state; it is not
  shown as a generic network error.

### 4.7 Server and runner changes

- `renderTerminalPage()`:
  - New toolbar markup, `#terminal-host`, `#terminal-banner`, `#terminal-announcer`,
    `#terminal-status`, `#terminal-copy`, `#terminal-reconnect`, `#terminal-close`.
  - Remove `#terminal-output` and `#terminal-input`.
  - `#terminal` keeps `data-terminal-ws`, `data-app-key`, `data-project-id`; adds
    `data-runtime-state`.
  - Scripts: the two vendor scripts before `terminal.js`.
  - Styles: the xterm stylesheet.
- `assets/terminal.js` is rewritten as the xterm controller. No framework, no dependency beyond the
  vendored UMD globals.
- `src/http/handler.ts` asset allowlist gains exactly:
  - `/assets/vendor/xterm/xterm-6.0.0.css` -> `text/css; charset=utf-8`
  - `/assets/vendor/xterm/xterm-6.0.0.js` -> `text/javascript; charset=utf-8`
  - `/assets/vendor/xterm/addon-fit-0.11.0.js` -> `text/javascript; charset=utf-8`
- `src/runner/server.ts` currently passes no env to `createExec`; add
  `env: { TERM: "xterm-256color", COLORTERM: "truecolor", LANG: "C.UTF-8" }`. The runner exec test
  must assert all three values.
  The container already starts in the app working directory, so no `workingDir` is added.
- Protocol stays: binary output frames; binary input; text resize JSON; close 1000 exec ended /
  1011 exec failed; message cap 1 MiB; closing the socket only closes the exec.

### 4.8 Accessibility and mobile acceptance

- Toolbar h1 names the page; the terminal host is labelled by xterm's screen-reader mode.
- Connection changes are announced once by `#terminal-status` (`role="status" aria-live="polite"`)
  and visually shown by the pill; output is owned by xterm.
- Every toolbar control has a visible label at desktop and an `aria-label` at phone width.
- Focus starts in the terminal after a successful connection; `Close` returns focus to `Reconnect`.
- The terminal is reachable by keyboard: Tab reaches toolbar controls, then the terminal textarea.
- 44px touch targets at `< 768`; no hover-only affordance.
- Reduced motion disables cursor blink and uses immediate state changes.
- At 390 the toolbar uses two rows (title + connection pill, then runtime pill + icon actions); the
  terminal uses the full remaining viewport; opening the soft keyboard refits without horizontal
  overflow.
- Contrast is inherited from tokens; ANSI bright colors are checked against `--inset` at
  implementation time and adjusted only by choosing another existing token.

### 4.9 Out of scope (terminal)

No tabs, split panes, session persistence, tmux/screen, shell selection, font-size controls, search
addon, web-links addon, image/sixel protocols, copy-on-select, or scrollback export. Reconnect starts
a new shell; it does not reattach an old PTY. Closing does not stop the application.

---

## 5. State model fixes

### 5.1 Runtime vocabulary and mapping

The manager/runtime vocabulary is `starting | running | stopped | error`. The UI must use it
verbatim; `failed` is not a runtime state.

`RuntimeState` becomes `"starting" | "running" | "stopped" | "error"`.

| Stored state | UI label | `.status data-state` | Glyph | Count field |
| --- | --- | --- | --- | --- |
| `starting` | **Starting** | `dispatching` | loader | `startingCount` |
| `running` | **Running** | `in_progress` | activity | `runningCount` |
| `stopped` | **Stopped** | `queued` | clock | `stoppedCount` |
| `error` (legacy `failed`) | **Error** | `failed` | alert-triangle | `errorCount` |
| absent / unknown on a server page | **Stopped** | `queued` | clock | `stoppedCount` |
| unknown in client code | **Unknown** | `cancelled` | slash | - |

Required changes:

- `src/http/ui.ts`: `RuntimeState` union and `runtimePill` mapping above.
- `src/http/dashboard.ts` `runtimeMap()`: map all four stored values; normalize legacy `failed` to
  `error`; anything else to `stopped`.
- `src/http/handler.ts` `routeRuntimeStatus()`: normalize legacy `failed` to `error` and expose
  `imageRef` from `instances.image_ref` (the image card's restart hint and the chat chip both read
  this route).
- `SiteModel`: replace `failedCount` with `errorCount`; add `startingCount`.
- `renderOverview` runtime card: four rows (`Starting`, `Running`, `Stopped`, `Error`). The project
  table and application/terminal/chat pages use the same pill mapping.
- Tests that seed `instances.state` add `starting` and `error` cases and assert labels and counts.

### 5.2 Restart route

Current bug: `POST /api/apps/:app/restart` calls `manager.stopApp()` and reports "Agent restarted."
The app/settings pages stop the agent; chat may restart it later through `ensure()`.

Required behaviour:

```
found = findApp(...)
if missing -> existing 404
if manager missing -> existing 503
try:
  restarted = await manager.restartIfRunning(toManagedApp(found))
catch error:
  browser -> redirectNotice(returnTo, "Restart failed. The agent is stopped; check the runtime log and retry.", "error")
  json -> 502 { error: "restart failed" }
browser:
  restarted -> "Agent restarted."
  else -> "Agent is not running; settings apply on next start."
json:
  { restarted: true } / { restarted: false, reason: "not_running" }
```

- `restartIfRunning()` already stops then `ensure()`s, and returns false when the agent is not
  running. It must not be changed to start stopped agents.
- The app page restart form is confirmed (Section 2.3). The settings pending and chat pending forms
  keep their existing direct submit; their copy already says an active turn is interrupted.
- `test/settings-http.test.ts` restart tests assert `restartIfRunning` is called and `stopApp` is
  not.

### 5.3 Chat runtime chip source of truth

Current bug: `setRuntime("running")` on hydration/send, `"error"` on thread errors, and the runtime
chip never reads `/api/apps/:app/runtime`.

Required behaviour:

- `src/http/chat.ts` adds
  `data-runtime-url="/api/apps/<appKey>/runtime?project=<projectId>"` to `#chat-shell`. One URL
  updates both chips; do not duplicate it on each chip.
- `assets/chat.js` gets `refreshRuntime()`:
  - `GET` the URL with same-origin credentials and `cache: "no-store"`.
  - Map the response `state` through `runtimeChip()` and replace both chips.
  - Split the current `statusChip` into `toolStatusChip` (tool rows; unknown -> neutral `Unknown`)
    and `runtimeChip` (starting -> dispatching `Starting`, running -> in_progress `Running`,
    stopped -> queued `Stopped`, error/legacy failed -> failed `Error`, unknown -> cancelled
    `Unknown`). `runtimeChip` never falls back to green `Completed`.
  - On 401, use the existing login redirect.
  - On network/JSON failure, keep the last chip and set `title="Runtime status unavailable"`; never
    convert an unknown result into green.
- Call `refreshRuntime()`:
  - once on boot,
  - when the SSE stream becomes ready,
  - after a send is accepted,
  - after a send failure,
  - on `visibilitychange` to visible,
  - every 10s while the document is visible (clear the interval when hidden).
- Remove all `setRuntime("running")`, `setRuntime("error")`, and other guesses from hydration,
  session creation, send, and `showThreadError`.
- The server-rendered pill remains the initial paint; the poll corrects it.

### 5.4 Agent status (`Ready`) precedence

Current bug: `if (session.status === "idle") return "Ready"` runs before running-tool, queue, and
active-prompt checks, so `Ready` can coexist with an active or queued prompt.

Required precedence in `activeStatusLabel()` (first match wins):

| # | Condition | Label |
| --- | --- | --- |
| 1 | A question/permission is pending in the active session | `Waiting for you` |
| 2 | An acceptance POST is in flight and the newest row is not accepted | `Sending` |
| 3 | Connection paused **and** the turn is active | `Paused` |
| 4 | `session.status` is `retry` | `Retrying` |
| 5 | A running tool part exists | `Running <tool>` |
| 6 | The last assistant has unsealed reasoning | `Thinking` |
| 7 | `session.status` is `busy` | `Working` if unsealed text, else `Thinking` |
| 8 | Queue length > 0 **or** `activePromptID !== null` | `Working` |
| 9 | `session.status` is `idle` | `Ready` |
| 10 | No status yet | `Ready` |

Implementation detail: move the idle check below the queue/active-prompt check; do not return early
on `idle` while a running tool exists. The existing queue suffix rules are unchanged and still apply
to `Thinking`, `Working`, `Running <tool>`, `Retrying`, and `Ready`.

### 5.5 Connection lane

Current bug: hydration (`setLive("Live")`), session switch (`setLive("Ready")`), send success, and
thread errors write the `.chat-live` connection lane. It must reflect only the app-scoped SSE
connection.

Required:

- Rename `setLive` to `setConnection(label, state)` and restrict its callers to:
  - boot before the stream opens: `Starting agent...` (state `starting`);
  - EventSource `onopen` / stream-ready: `Live` (state `live`);
  - EventSource `onerror`: `Reconnecting` (state `reconnecting`);
  - explicit pause/resume and retry control: `Paused` / `Connecting`.
- Remove these specific writes:
  - `hydrateMessages`: `setLive("Live", "live")` after the initial hydration.
  - `hydrateMessages` silent-error branch: `setLive("Reconnecting", "reconnecting")`.
  - `resetSession` / new-session path: `setLive("Ready", "idle")`.
  - `showThreadError`: `setLive("Paused", "paused")`.
  - send success: `setLive("Live", "live")`.
  - session switch / history loading: `setLive("Loading messages", "reconnecting")`; render the
    loading state in the feed (history row/skeleton), not in the connection lane.
  - `savedStoreFor`: the `connection: "live"` field is deleted from per-session snapshots.
- `setConnection` remains in boot (`Starting agent...`), stream-ready (`Live`), stream error
  (`Reconnecting`), and the explicit pause/resume controls (`Paused` / `Connecting`).
- `showThreadError` still renders the in-feed error state and `role="alert"` content; it no longer
  changes runtime or connection. A messages-API failure while SSE is live is a data error, not a
  dropped connection.
- The connection lane is app-scoped, not session-scoped. Remove `connection` from the per-session
  `sessionRuntime` snapshots (`savedStoreFor`, `saveCurrentRuntime`, `adoptRuntime`). Switching
  sessions does not touch the lane; it stays `Live` if the shared stream is live.
- Session switch may show `Loading messages` as a feed state, not as the connection lane.
- The runtime chip and the connection lane remain separate: runtime is Section 5.3; connection is
  this section; agent status is Section 5.4.

### 5.6 Image label collision and restart semantics

- Image `ready` is renamed **Built** in UI and client tables. `Ready` is reserved for chat's agent
  status. Runtime uses `Running`.
- Build and rollback are different by design:
  - **Build** never restarts. It can finish long after the operator left; restarting then would
    interrupt a turn without a contemporaneous confirmation. When a build completes while the agent
    is running and its `imageRef` differs from the new app image ref, the card says
    `Restart the agent to use the new image.`
  - **Rollback** changes the active image immediately and is confirmed as
    `Roll back and restart`; the server schedules `restartIfRunning()` after the rollback response.
    If the agent is stopped, no restart occurs.
- This asymmetry is covered by copy in the rollback dialog and the image hint, so it is not a
  surprise. It is not accepted debt; it is the policy.

### 5.7 Pending restart persistence

Current bug: `InstanceManager.detach()` clears `#running`; on the next `ensure()` reattach it creates
a new entry with `settingsHash: this.#currentSettingsHash(app)`, recording the **current** settings
as applied. Pending restart is therefore lost across coordinator restarts.

Required:

1. Migration **v10** (`applied-runtime-state`) adds (v8 is git credentials, v9 is SSH hosts):
   - `ALTER TABLE instances ADD COLUMN applied_settings_hash TEXT;`
   - `ALTER TABLE instances ADD COLUMN applied_profile INTEGER;`
2. `#recordStatus()` persists `applied_settings_hash` and `applied_profile` from the launch that
   actually started the container. `#recordStatusById()` preserves both columns when only state
   changes.
3. The reattach branch in `ensure()` reads the persisted values from `instances` and uses them for
   the new `Entry`. It must **not** call `#currentSettingsHash()` as the applied value.
4. `pendingRestart()` compares the current settings/profile preview against the entry's persisted
   applied values. If there is no in-memory entry, it queries the `instances` row for a
   `running`/`starting` state and compares the persisted columns; a running-but-unattached agent is
   therefore still reported before the first `ensure()`.
5. Legacy rows with `NULL` applied hash/profile (pre-v10) return
   `{pending: true, reasons: ["applied_state_unknown"]}` for a running/starting agent. The UI renders
   `Restart required` with copy `The coordinator cannot confirm which settings this running agent
   loaded.` and never shows a confident `Applied`. A restart records both columns and clears the
   unknown state. This is the accepted one-time upgrade path.
6. Test: start → change a setting → `detach()` → page/site build reports pending before `ensure()`
   → `ensure()` reattach reports pending → restart → false; and a legacy NULL row reports
   `applied_state_unknown`.
7. `SiteModel.pendingRestart` must carry the reason list (or add a parallel
   `pendingRestartReasons: Map<string, string[]>`) so the application state strip can choose the
   known versus `applied_state_unknown` copy. Update `buildSite`, the project table/app page, and
   their fixtures together.

### 5.8 In-scope vs accepted debt

In scope:

- Runtime four-state mapping and counts.
- Restart route using `restartIfRunning`.
- Chat runtime endpoint polling.
- `Ready` precedence.
- Connection lane single writer.
- Image label collision and image restart hint.
- Applied-hash persistence.

Accepted debt:

- Runtime polling can lag up to 10s; there is no runtime SSE.
- Pre-v10 running instances report `applied_state_unknown` and `Restart required` until the next
  restart; the UI never claims Applied for them.
- Chat connection lane is app-scoped, so it does not represent a per-session stream.
- The image "restart to apply" hint depends on the runtime endpoint exposing `imageRef`; legacy
  instances without it skip the hint rather than guess.

---

## 6. Design-system additions

No new tokens. Every added class composes existing color, type, space, radius, motion, and status
tokens. These classes must be added to `DESIGN.md` (Section 5) and `src/http/styles.css` before use.

### 6.1 Application page

- `.state-strip`: 2-column grid, `border-block: 1px solid var(--line)`, no surface fill.
- `.state-strip__cell`: `padding: var(--space-3) var(--space-4)`, `min-inline-size: 0`.
- `.state-strip__cell + .state-strip__cell`: `border-inline-start: 1px solid var(--line)`.
- `.state-strip__label`: `--text-overline`, uppercase, `--text-3`.
- `.state-strip__value`: flex cluster, `margin-block-start: var(--space-1)`.
- `.state-strip__actions`: flex cluster, `margin-block-start: var(--space-2)`, wraps.
- Below 768: one column; the separator becomes `border-block-start`.
- `.menu`: inline-block `<details>`; `position: relative`; `.menu > summary` is an icon button
  (list-style removed).
- `.menu__panel`: absolute, `inset-block-start: calc(100% + var(--space-1))`, inline-end 0,
  `inline-size: max-content`, `max-inline-size: var(--chat-context)`, `--surface-3`,
  `1px --line-strong`, `--radius-md`, `--shadow-overlay`, `padding: var(--space-1)`,
  `z-index: var(--z-sticky)`.
- `.menu__item`: block link, `padding: var(--space-2) var(--space-3)`, `--text-sm`, hover
  `--wash-1`, `--radius-sm`.
- `.disclosure`: `<details>` with a `--space-8` summary row, `--text-sm`, `--text-2`, chevron that
  rotates when open. Used by Image details / Build logs and Settings scope details.

### 6.2 Settings

- `.settings-nav`: sticky, opaque `--canvas`, bottom hairline, `padding-block: var(--space-2)`,
  flex row with `justify-content: space-between`, `gap: var(--space-3)`, `z-index: var(--z-sticky)`.
- `.settings-nav__scopes`: flex, `gap: var(--space-1)`; current item is `--wash-2` with a check
  glyph, not a colored edge. 32px desktop, 44px phone.
- `.settings-nav__sections`: flex, horizontally scrollable at narrow widths,
  `scrollbar-gutter: stable`; links are `--text-caption`, `--text-3`, hover `--text-1`.
- `.settings-nav__link[aria-current="page"]`: `--text-1`, `--wash-2`.
- `.settings-section`: existing `.card` + `.card__head` + `.card__body--flush`; no new surface.
- `.setting-row`: `border-block-end: 1px solid var(--line)`; last child none.
- `.setting-row__summary`: grid `minmax(0, 1fr) auto`, `min-block-size: var(--space-10)`,
  `padding-block: var(--space-2)`, cursor pointer, hover `--wash-1`, focus-visible ring.
- `.setting-row__title`: `--text-h3` (sans 600), `--text-1`.
- `.setting-row__effective`: flex column at phone, row at desktop, `gap: var(--space-2)`;
  value `.mono`, source `--text-caption` `--text-3`.
- `.setting-row__state`: optional `.status` pill.
- `.setting-row__chevron`: 12px icon, `--text-3`, rotate 180deg when `[open]`.
- `.setting-row__body`: `padding: 0 0 var(--space-4)`, stack gap `--space-3`.
- `.setting-row__form`: stack gap `--space-3`.
- `.setting-row__actions`: flex wrap, `gap: var(--space-2)`, `justify-content: flex-end`.
- `.scope-details` / `.scope-list`: reuse `.disclosure`; `.scope-list` is a grid of
  `grid-template-columns: 7rem minmax(0, 1fr)` (the existing documented stack label column, not a
  new value), rows `min-block-size: var(--space-6)`, `dt` caption `--text-3`, `dd` mono value +
  caption state.
- `.settings-warning`: a hairline block with alert glyph and `.field-error` list; no card.

### 6.3 Terminal

- `.page--terminal`, `.page__body--terminal`: full-height grid as in Section 4.1.
- `.terminal-toolbar`, `.terminal-toolbar__title`, `.terminal-toolbar__meta`,
  `.terminal-toolbar__status`, `.terminal-toolbar__actions`.
- `.terminal-host`: `min-block-size: 0`, `background: var(--inset)`, padding
  `var(--space-2) var(--space-3)`; xterm fills it.
- `.terminal-banner`: in-flow, surface 2, hairline, `padding: var(--space-2) var(--space-4)`,
  flex wrap.
- `.terminal-empty`: reuse `.empty-state` inside the host; no new visual language.

### 6.4 Icons

Add one icon to `ui.ts`: `more` (three horizontal dots) for the application overflow. All other
icons already exist (`copy`, `terminal`, `chevron-down`, `refresh`, `external`, `settings`, `layers`,
`alert-triangle`, `check`, `clock`, `hourglass`, `slash`, `activity`).

### 6.5 Shell API

- `documentPage` / `ShellOptions`: add `styles?: string[]` for the xterm stylesheet.
- `ShellOptions`: add `settingsHref?: string` for the contextual sidebar Settings link.
- `assets/app.js`: add one `details.menu` helper (outside-click and Escape close the open menu and
  return focus to its summary). It is shared shell behaviour, not a client framework.
- No new tokens, no new radii, no shadows beyond `--shadow-overlay`, no motion beyond the existing
  micro/standard timings.

---

## 7. Copy deck

### 7.1 Application page

| Context | Copy |
| --- | --- |
| Description | Repository state and lightweight git actions for this application. |
| Header actions | `Open chat` / `Terminal` / `More actions` |
| Overflow items | `Open IDE in this folder` / `Application settings` |
| State strip labels | `Runtime` / `Settings` |
| Runtime pills | `Starting` / `Running` / `Stopped` / `Error` |
| Settings applied | `Applied` / `Settings match the running agent.` / `Review settings` |
| Settings pending | `Restart required` / `The agent is running with older settings.` |
| Settings pending unknown | `Restart required` / `The coordinator cannot confirm which settings this running agent loaded.` |
| Settings unavailable | `Unavailable` / `The agent runtime is not configured.` |
| Restart button | `Restart agent` |
| Restart dialog title | `Restart <app>?` |
| Restart dialog body | `An active turn will be interrupted. Sessions are kept.` |
| Restart dialog confirm | `Restart agent` |
| Restart success | `Agent restarted.` |
| Restart not running | `Agent is not running; settings apply on next start.` |
| Restart failure | `Restart failed. The agent is stopped; check the runtime log and retry.` |
| Image statuses | `Not built` / `Building` / `Built` / `Out of date` / `Build failed` / `Default image` |
| Image hints | `No app image has been built. Build it before starting the agent.` / `The runner is building this image. The previous image remains in use.` / `The image matches the current Dockerfile and default base.` / `The Dockerfile or default base changed. The running agent keeps the old image until you rebuild and restart.` / `The last build failed. The previous image is kept.` / `This application uses the shared default agent image.` |
| Image actions | `Build image` / `Rebuild image` / `Retry build` / `Building…` / `Roll back` / `Refresh image` |
| Image details | `Image details` / `Build logs` / `No build logs yet.` |
| Image default next step | `Add .hanse/Dockerfile to build a custom image for this application.` / `Open application folder` |
| Image build complete while running | `Restart the agent to use the new image.` |
| Rollback dialog | `Roll back image?` / `This replaces the current image with <ref> and restarts the agent. An active turn will be interrupted.` / `Roll back and restart` / `Cancel` |
| Rollback stopped | `This replaces the current image with <ref>.` / `Roll back image` |
| Image errors | `Could not refresh image status.` / `Could not refresh build logs.` |

### 7.2 Settings

| Context | Copy |
| --- | --- |
| Nav scopes | `Global` / `Project` / `Application` |
| Nav sections | `Agent` / `Web tools` / `Git` / `Restart` |
| Source line | `from Global` / `from Project` / `from Application` / `default` / `Cleared at Project` |
| Row action affordance | `Change` (inside summary) |
| Actions | `Save` / `Inherit` / `Clear` / `Set model` / `Set key` / `Set credential` / `Test connection` |
| Inherit disabled | `Already inherited from <source>.` |
| Clear disabled | `Already cleared at this scope.` |
| Global clear warning | `Clearing here disables this setting for every application.` |
| Clear dialog | `Clear <setting> at this scope?` / `Wider scopes will no longer apply. The setting stays disabled until you set it again.` / `Clear setting` / `Cancel` |
| Inherited web tool | `This scope inherits <driver> from <source>. Saving creates an override.` |
| Model hint | `Selected model applies to new sessions and OMO agents; existing sessions may keep their model.` |
| Providers hint | `Keys are encrypted at rest and never shown again. A cleared key suppresses wider scopes and host auth.` |
| Add provider | `Add provider key` |
| Scope details | `Scope details` / `Set` / `Cleared` / `Inherited` |
| Pending heading | `Restart & pending` |
| Pending empty | `No running agents are waiting for a restart.` |
| Pending hint | `Settings changes apply only on an explicit restart. A restart interrupts an active turn; sessions are kept.` |
| Pending reason | `Settings changed` / `Agent profile not applied` / `Applied state unknown` |
| Validation fallback | server message, unchanged; rendered inline in the row |
| No-JS remark | existing toast + redirect (degraded) |

### 7.3 Terminal

| Context | Copy |
| --- | --- |
| Toolbar title | `<app> / Operator terminal` |
| Connection statuses | `Connecting` / `Live` / `Reconnecting in Ns` / `Paused` / `Agent stopped` / `Shell exited` / `Connection failed` |
| Actions | `Copy` / `Reconnect` / `Close` |
| Toolbar note | `Closing this terminal does not stop the application.` |
| Closed banner | `Terminal closed. The application keeps running.` |
| Shell exit banner | `Shell exited. Reconnect to start a new shell.` |
| Reconnect banner | `Connection failed. Reconnecting in Ns.` |
| Stopped empty state | `Agent is not running` / `The terminal attaches to the running application container. Open chat to start the agent, then reconnect.` / `Open chat` / `Reconnect` |
| Copy announcement | `Copied selection.` |

### 7.4 Chat state

| Context | Copy |
| --- | --- |
| Runtime chips | `Starting` / `Running` / `Stopped` / `Error` / `Unknown` |
| Connection lane | `Starting agent...` / `Live` / `Reconnecting` / `Paused` |
| Agent status | unchanged (`Ready`, `Thinking`, `Working`, `Running <tool>`, `Waiting for you`, `Sending`, `Retrying`) |
| Runtime unavailable title | `Runtime status unavailable` (tooltip only) |

---

## 8. Accessibility and responsive acceptance criteria

Every item is PASS/FAIL in the browser gate; no item is satisfied by code inspection alone.

### 8.1 Accessibility

- [ ] Every new control is keyboard reachable in DOM order; `<details>` summaries toggle with Enter
      and Space; Escape closes the overflow menu and dialogs.
- [ ] The application overflow menu links are reachable without JavaScript (details open) and close
      on outside click/Escape when JavaScript is present.
- [ ] The restart and rollback dialogs trap focus natively, start focus on Cancel or the first
      control, and return focus to the trigger.
- [ ] `:focus-visible` rings are present on summaries, row actions, toolbar buttons, and terminal
      toolbar controls; no outline removal.
- [ ] All status is glyph + text + color. Runtime `starting/running/stopped/error`, image states, and
      pending state are distinguishable in grayscale.
- [ ] Image has exactly one polite live region (`#image-live`); logs are not a live region.
- [ ] Terminal connection changes are announced once; xterm screen-reader mode is enabled.
- [ ] Settings disabled actions expose a visible reason in the row body, not only `title`.
- [ ] Inputs keep visible labels, `aria-invalid` on failure, and `aria-describedby` to the inline
      error after a rejected settings submit.
- [ ] Touch targets are 44px at `< 768` for summaries, buttons, scope links, and terminal controls.
- [ ] Reduced motion: no chevron rotation animation is required, cursor blink is off, no entrance
      animations.
- [ ] Contrast: runtime/image/settings pills and inline errors meet 4.5:1 text / 3:1 large text and
      control edges in dark and light.

### 8.2 Responsive

- [ ] 390, 768, 1024, 1440: no horizontal scroll of primary content on application, settings, or
      terminal pages.
- [ ] 390: application header keeps two labelled actions + overflow on one row; state strip stacks;
      image card is full width; settings rows are two-line summaries; terminal toolbar is one row
      with icon actions; opening the soft keyboard refits the terminal.
- [ ] 768: application header does not wrap; state strip two columns; settings sticky nav does not
      cover focused rows.
- [ ] 1024: sidebar breakpoint; application rail stacks below git; image remains after git; settings
      nav stays readable.
- [ ] 1440: application retains the 320px rail; git is the dominant column; settings rows are one
      line and the sticky nav does not overlap the section headings.
- [ ] Long content: 120-character path, 40-character app key, long image ref, long provider id,
      long SSH fingerprint all wrap or truncate with a `title`/mono, never overflow.
- [ ] Dark and light: identical hierarchy; no token-only surface disappears; terminal theme updates
      when the theme changes.

---

## 9. Implementation slices, ownership, and sequencing

One worktree. One agent per slice. `src/http/styles.css` is written by one slice at a time; do not
run two CSS-touching slices in parallel.

### Slice A - State foundation (no visual changes except runtime labels)

Files: `src/http/ui.ts` (RuntimeState/runtimePill), `src/http/dashboard.ts` (runtimeMap, counts,
pending reasons, SiteModel fixtures), `src/http/settings.ts` (restart route only),
`src/opencode/manager.ts` (persisted applied hash), `src/store/migrations.ts` (v10),
`src/http/handler.ts` (runtime endpoint `imageRef`), tests `test/runtime-manager.test.ts`,
`test/migrations.test.ts` (fresh/latest counts and versions), `test/settings-http.test.ts`,
`test/manager.test.ts`, and every `SiteModel` fixture that constructs `failedCount`
(`test/application-ssh.test.ts`, `test/application-page.test.ts` if present).

Exit: `starting/error` render and count correctly; restart route uses `restartIfRunning`; pending
survives detach/reattach; all existing pages still build.

### Slice B - Application page

Depends on A. Files: `src/http/application.ts`, `assets/images.js`, `assets/app.js` (menu close),
`src/http/ui.ts` (`more` icon, `settingsHref` shell option), and the `settingsHref` callers in
`src/http/dashboard.ts`, `src/http/terminal.ts`, `src/http/ssh.ts`; `src/http/styles.css` (state
strip, menu, image section); tests `test/application-page.test.ts`, `test/app-image-api.test.ts`,
`test/application-ssh.test.ts`, `test/http.test.ts` (if shell API is touched). `src/http/chat.ts` is
owned by Slice E.

Exit: new hierarchy, single pending surface, image rail card (configured states show build/refresh/
details; the default state shows only `Default image`, the hint, and `Open application folder`),
confirmed rollback, single live region, preserved git ids.

### Slice C - Settings

Depends on B for `styles.css` and `ui.ts` (sidebar href). Files: `src/http/settings.ts` (render
helpers), `assets/settings.js`, `src/http/styles.css` (settings sections), tests
`test/settings-http.test.ts` (render + Git markup), `test/git-settings-asset.test.ts` (asset only).

Exit: IA, sticky nav, setting rows, no-op rules, own-scope prefill, inline errors, quantified height
reduction, Git credentials preserved.

### Slice D - Terminal

Depends on C for `styles.css` and `handler.ts` allowlist coordination. Files: `src/http/terminal.ts`,
`assets/terminal.js`, `src/http/ui.ts` (`styles` option), `src/http/handler.ts` (three vendor
assets), `src/runner/server.ts` (add `TERM`, `COLORTERM`, `LANG`; the current exec has no env),
`src/http/styles.css` (terminal section), tests `test/terminal-http.test.ts`,
`test/runner-exec.test.ts`, `test/http.test.ts`, new `test/vendor-xterm.test.ts`.

Exit: xterm page, full-height layout, fit/resize, binary input, copy/paste, reconnect/close/stopped
states, asset allowlist and checksums, `TERM`/`COLORTERM`/`LANG` env.

### Slice E - Chat state truth

Parallel with B/C/D after taking sole ownership of `src/http/chat.ts`. Files: `assets/chat.js`,
`src/http/chat.ts` (`data-runtime-url` and the contextual `settingsHref`), tests
`test/chat-page.test.ts`, `test/chat-core.test.ts` (if applicable), plus the browser fixtures.

Exit: runtime endpoint polling, Ready precedence, connection lane single writer, `Unknown` fallback.

### Slice F - Verification and evidence

After A-E. Files: `docs/design/ux-polish.md` (status/evidence updates), `docs/design/ux-qa.mjs` (new
browser harness), `docs/design/artifacts/ux/README.md` + captures. No product code unless a gate
finds a defect (then fix in the owning slice).

Exit: all gates green; browser matrix captured; acceptance checklists PASS.

### Merge-conflict rules

- `src/http/ui.ts`: A owns `RuntimeState`; B owns the `more` icon/`settingsHref`; D owns `styles`.
  Apply in that order.
- `src/http/handler.ts`: A owns the runtime endpoint; D owns the asset allowlist. Apply A then D.
- `src/http/styles.css`: append-only sections in the order B (application), C (settings), D
  (terminal). Rebase each slice on the previous.
- `src/http/settings.ts`: A owns the restart route; C owns render helpers. Apply A then C.
- `src/http/chat.ts`: E is the only writer; B must not edit it.
- Tests: each slice updates its own test file; Slice F runs the full suite and the no-JS/accessibility
  matrix.

---

## 10. Verification plan

### 10.1 Gates

```bash
npm run lint
npm run typecheck
npm test
npm run build
```

All four must pass before a slice is considered done.

### 10.2 Automated tests

| Area | Test |
| --- | --- |
| Runtime mapping | Seed `instances.state` with `starting`, `running`, `stopped`, `error`, `failed`; assert pills, labels, counts (`startingCount`, `runningCount`, `stoppedCount`, `errorCount`). |
| Restart | Fake manager records `restartIfRunning`; assert `stopApp` is not called; assert success/not-running/failure messages. |
| Pending persistence | Start, change a setting, `detach()`, `ensure()`; `pendingRestart()` is true; restart clears it. |
| Application page | New ids, no banner, one `Restart required`, image status uses `.status` + glyph, one live region, `#image-logs` inside `#image-details`, `#image-build` has `.btn__label` and an icon. |
| Image client | Static assertions: no `#image-logs-refresh`, no `textContent = meta.action`, poll only while building, single live region. |
| Settings | Sticky nav present, four sections, one `details.setting-row` per setting, no resting scope tables, no resting submit buttons, no-op `disabled`/hidden states, own-scope prefill, `data-settings-form` count, unique ids. |
| Git credentials | All ids/data attributes preserved; Test connection only at app scope; no secret echoed. |
| Terminal page | xterm stylesheet and both vendor scripts linked before `terminal.js`; `#terminal-host`, no `#terminal-input`; `data-runtime-state`; vendor allowlist returns 200/JS/CSS; unknown vendor path 404. |
| Terminal runner | `createExec` options include `env.TERM === "xterm-256color"`; binary client input reaches `stream.write`; resize text is parsed; non-resize text is input. |
| Vendor integrity | `test/vendor-xterm.test.ts` checks `SHA256SUMS`, `VERSION`, file sizes, and allowlist paths. |
| Chat | `data-runtime-url` rendered; static assertions that hydration/session switch do not call `setRuntime`/`setConnection`; `statusChip` unknown = `Unknown`; runtime chip uses endpoint URL. |

### 10.3 Browser QA matrix

Run with real Playwright Chromium (the existing `docs/design/capture.mjs` pattern), at
**390 / 768 / 1024 / 1440**, dark and light. Store in `docs/design/artifacts/ux/`.

Application page scenarios:

1. Default image, runtime running, settings applied.
2. Configured image missing, runtime stopped.
3. Building with logs open.
4. Built but runtime on an older image (`Restart the agent to use the new image.`).
5. Build failed with error.
6. Stale image.
7. Pending restart (one statement; restart dialog).
8. Runtime starting and runtime error.
9. Header at 390: two labelled actions + overflow; no wrap/overflow.
10. Image details/rollback dialog; scroll preservation in logs.

Settings scenarios:

1. Global with one provider and no warnings.
2. Project with warnings and a pending app.
3. App with three providers, SSH/HTTPS set, pending restart, profile warning.
4. Open each row type; check actions, no-op disabled reasons, own-scope prefill.
5. Submit an invalid model; check inline error, preserved values, focus.
6. Submit a valid change; check success, return to the row hash, toast.
7. Sticky nav at 390/768; no overlap.
8. Measure page height closed; compare with the pre-change capture (targets in Section 3.10).

Terminal scenarios:

1. Live shell with a stub WS server; ANSI colors, alternate screen (`less`/`vim`-like escape
   fixture), resize, 5000-line scrollback.
2. Copy selection and paste multiline; no resize-collision.
3. Network drop → backoff banner → auto reconnect.
4. Shell exit (`exit`) → `Shell exited`, no auto-retry.
5. Manual Close → `Terminal closed`, app keeps running.
6. Stopped agent → empty state; `Open chat` and `Reconnect`.
7. 390 with soft keyboard; no horizontal overflow; 44px targets.
8. Light/dark theme switch while live; terminal theme updates.

Chat scenarios (fixture-driven):

1. `session.status = idle` with an active prompt → must not show `Ready`.
2. `idle` with queue > 0 → `Working` / queue suffix.
3. Running tool while status idle → `Running <tool>`.
4. Runtime endpoint returns `stopped` → chip `Stopped`; hydration does not turn it green.
5. Session switch while SSE live → connection stays `Live`.
6. Messages API failure while SSE live → error feed, connection not `Paused`.
7. Runtime endpoint 500 → last chip kept, `Runtime status unavailable` title.

### 10.4 Visual and accessibility checks

- No horizontal scroll (`document.scrollingElement.scrollWidth === clientWidth`) on primary content.
- No duplicate ids on any page.
- Focus-visible screenshots for row summaries, menu, dialog, terminal toolbar.
- Contrast sampling for `.status` variants against `--inset`/`--surface-1` in both themes.
- Reduced-motion pass: no chevron rotation, no cursor blink, no skeleton animation.
- Console: zero errors and zero page errors in every scenario.
- Network: no unexpected requests (image logs only when open/building; runtime poll at 10s).

---

## 11. Accepted debt and non-goals

### 11.1 Accepted debt

| Item | Why accepted | Exit |
| --- | --- | --- |
| Settings forms without JavaScript still lose values on validation and use the redirect toast | The page remains functional; the inline path is the product path. | Revisit if no-JS usage is real. |
| Runtime polling can lag up to 10s | The runtime endpoint is a cheap DB read; no runtime event stream exists. | Add SSE only if agents change state often enough to matter. |
| Pre-v10 running instances report applied state unknown once | The applied hash was never persisted before this pass. | One-time; the UI shows Restart required until the next restart, then new instances are correct. |
| Chat connection lane is app-scoped, not per-session | Chat uses one app-scoped SSE stream. | Revisit only if per-session streams are introduced. |
| Image "restart to apply" hint requires `runtime.imageRef` | Legacy instance rows may not have it. | Backfill/migrate or omit the hint; never guess. |
| Terminal reconnect starts a new shell | PTYs are ephemeral Docker execs. | Add a persistent session multiplexer only as a separate feature. |
| No terminal search/web-links addon | Not vendored; not required for terminal correctness. | Add only with a separate allowlist/licence review. |
| Sticky settings nav duplicates the section headings in the tab order | It is navigation; skip-link remains first. | Revisit if tab order testing finds it costly. |

### 11.2 Non-goals

- No visual rebrand, new palette, new font, new radius, new shadow, or new motion token.
- No shell/sidebar layout redesign beyond the contextual Settings href.
- No new settings keys, scopes, endpoints, or storage semantics.
- No settings autosave or draft persistence.
- No agent start endpoint; chat remains the way to start a stopped agent.
- No image auto-build, build queue, or auto-restart after build.
- No terminal tabs, split panes, tmux, persistent sessions, or file transfer.
- No chat feature work beyond state truth and the runtime chip.
- No changes to the embedded IDE.

---

## 12. Design review record

Oracle review, 2026-10-21: **PASS-WITH-CHANGES**. Findings folded into this document:

- applied-runtime migration renumbered to **v10** (v8 git credentials, v9 SSH hosts).
- SSH access card placed in the application rail; `#ssh-panel` preserved.
- terminal wrapper/grid made explicit (`page` -> `page__body` -> `#terminal.terminal-shell`).
- stopped-agent state uses a runtime preflight, not the unobservable 409.
- clipboard fallback for insecure LAN HTTP.
- pending restart is truthful before reattach (`applied_state_unknown`).
- settings/Git form busy and clear-confirmation coordination with `assets/app.js`.
- Git Clear confirmation and JS-required `<noscript>`; shared clear dialog limited to non-Git forms.
- xterm `onBinary` handled; `LANG` added while preserving `TERM`/`COLORTERM`.
- `details.menu` Escape/outside-click handler specified in `assets/app.js`.
- light-theme ANSI mapping uses theme-aware semantic tokens (`--text-1`, not `--paper-50`).

---

## 13. Review checklist for implementation

- [ ] The application page keeps git as the main job and removes the Image/SSH blocks from above it.
- [ ] Every owner complaint has an explicit decision, not an option.
- [ ] All state bugs are addressed with exact mappings, call sites, and tests.
- [ ] Settings keeps every server action/endpoint and the merged Git credentials section.
- [ ] No new token is introduced; every new class composes named tokens.
- [ ] DOM id changes are exhaustive and the affected tests are named.
- [ ] Terminal asset loading, allowlist, `TERM`/`COLORTERM`/`LANG`, protocol, and out-of-scope list
      are exact.
- [ ] Implementation slices have file ownership and a conflict-free sequence.
- [ ] Verification covers 390/768/1024/1440, dark/light, and the state/edge scenarios.
- [ ] Accepted debt is explicit and small.
