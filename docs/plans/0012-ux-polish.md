# Plan 0012 - UX/UI polish pass

Status: **implemented, verified, and deployed as `sha-88faab7`.** Design:
[`docs/design/ux-polish.md`](../design/ux-polish.md). Design review: `oracle`, 2026-10-21,
**PASS-WITH-CHANGES** (findings folded). Plan review: `momus`, 2026-10-21, **PASS-WITH-CHANGES**
(findings folded). Owner is unavailable and delegated all decisions; no owner questions remain.

Project bindings: [`docs/process.md`](../process.md). Verification:
`npm run lint && npm run typecheck && npm test && npm run build`.

## 1. Goal

Bring the recently added surfaces to the existing Chart Room UX standard without a rebrand:

- Application page: git remains the main job; Image, SSH access, runtime, and pending restart stop
  competing above the fold.
- Settings at global/project/application scope: compact, hierarchical, progressively disclosed.
- Operator terminal: a real xterm.js terminal instead of a `<pre>` plus textarea.
- State indicators: one truthful runtime vocabulary and one source of truth for chat runtime,
  restart, pending settings, and image state.
- No new colors, sizes, spacing, radius, shadow, or motion values.

## 2. Baseline and integration

The work starts from `main` after `b844bc3` (SSH) and the merged `0010` git-credentials stage
(migration 8). `b844bc3` adds migration 9, so the new applied-runtime migration is **v10**. The
existing vendored xterm set is committed under `assets/vendor/xterm/` with checksums. The design
document is committed; its Oracle findings are folded.

## 3. Slices

One worktree, one writer for `src/http/styles.css` at a time. Each slice leaves the gates green.

### Slice A - State foundation

Files: `src/http/ui.ts`, `src/http/dashboard.ts` (runtime map/counts, pending reasons, all
`SiteModel` fixtures), `src/http/settings.ts` (restart route only), `src/opencode/manager.ts`,
`src/store/migrations.ts` (v10), `src/http/handler.ts` (`routeRuntimeStatus`), tests.

Changes:

1. `RuntimeState` becomes `starting | running | stopped | error`; `runtimePill` maps
   `starting -> dispatching/Starting`, `running -> in_progress/Running`,
   `stopped -> queued/Stopped`, `error -> failed/Error`.
2. `runtimeMap()` stores all four, normalizes legacy `failed` to `error`; `SiteModel` gets
   `startingCount`/`errorCount` (replace `failedCount`); overview renders four runtime rows.
3. `routeRuntimeStatus()` normalizes legacy `failed` and returns `imageRef` from
   `instances.image_ref`.
4. Restart route calls `manager.restartIfRunning(managedApp)`; catch errors as a 502/error notice;
   never call bare `stopApp`.
5. Migration v10 adds `instances.applied_settings_hash` and `applied_profile`. `#recordStatus`
   writes the launch values, `#recordStatusById` preserves them, reattach reads them. `pendingRestart`
   also reads a running/starting DB row when no in-memory entry exists; legacy NULL rows return
   `applied_state_unknown` and the UI shows `Restart required`, never `Applied`. Carry the reason
   list into `SiteModel` (parallel reasons map or value object) so the app page can distinguish
   known vs unknown.
6. Tests: runtime label/count matrix (`starting`, `running`, `stopped`, `error`, legacy `failed`),
   restart route calls `restartIfRunning`, migration v5->v10 plus fresh/latest counts (v9->v10,
   `runMigrations` 9->10 and v5->latest 4->5), detach/reattach/legacy pending. Update every
   `SiteModel` fixture that constructs `failedCount` (at least `test/application-ssh.test.ts`).

Exit: no page visual regression; runtime labels/counts and pending truth are correct; restart
actually restarts.

### Slice B - Application page

Depends on A. Files: `src/http/application.ts`, `assets/images.js`, `assets/app.js` (menu close),
`src/http/ui.ts` (`more` icon, `settingsHref`), `src/http/dashboard.ts`/`terminal.ts`/`ssh.ts`
(settingsHref callers), `src/http/styles.css`, tests `application-page`, `application-ssh`,
`app-image-api`, `http`. `src/http/chat.ts` is owned by Slice E.

Changes:

1. New hierarchy: page header -> two-cell state strip (Runtime | Settings) -> git workbench; rail is
   Image, SSH access, Remotes, Last commit. Remove the pending banner, the full-width Image/SSH
   cards, and the Application rail card.
2. Header: `Open chat` and `Terminal` secondary; `More actions` overflow contains `Open IDE in this
   folder` and `Application settings`; no header primary. Contextual sidebar Settings href.
3. Runtime cell: one pill and a `Restart agent` control only for running/starting, with a native
   confirmation dialog; Settings cell: `Restart required` (known or unknown), `Applied`, or
   `Unavailable` once per page.
4. Image rail card: six-state `.status` mapping with glyphs (`Not built`, `Building`, `Built`,
   `Out of date`, `Build failed`, `Default image`). Configured states get one refresh, one server-form
   build action, `Image details` (built, previous, previous built, logs), and confirmed rollback; the
   default state gets only `Default image`, the hint, and `Open application folder` (no
   build/refresh/logs/rollback). One live region, preserved scroll in logs, no log fetch on load,
   runtime `imageRef` comparison with `Restart the agent to use the new image.` (skip for default,
   missing `data-image-ref`, or no runtime `imageRef`), `<time>` semantics preserved.
5. SSH rail card: `#ssh-panel`/`#ssh-panel-title`, allowed-host count, pending approvals as a status
   stamp, existing Manage link; no forms.
6. Git workbench DOM/behaviour unchanged: ids, skeletons, actions, no-JS fallback.
7. Tests: new hierarchy/ids, exactly one pending statement, image status classes/glyph, logs inside
   disclosure, rollback dialog, SSH panel in rail, header overflow.

Exit: git is the first and dominant region; Image/SSH/runtime are compact and truthful; all image
and git tests updated and green.

### Slice C - Settings

Depends on B for shared CSS. Files: `src/http/settings.ts` (render helpers), `assets/settings.js`,
`src/http/styles.css`, tests `settings-http`, `git-settings-asset`.

Changes:

1. Sticky `settings-nav`: scope links (current is `aria-current`) and section anchors
   (`Agent`, `Web tools`, `Git`, `Restart`); contextual sidebar Settings href.
2. Four section cards; one `<details class="setting-row">` per setting with label, effective value,
   source, optional state, and chevron; editor, hints, inline error, own-scope prefill, and a
   `Scope details` definition list inside.
3. Action model: no resting setting submit buttons (pending-restart forms are the only always-visible
   submits, and only when an app is pending); one primary Save per open row; Inherit/Clear only where
   applicable, disabled with a visible reason when no-op; global hides Inherit; shared clear dialog
   for `/api/settings`/provider forms, copying `provider` for provider clears; Git clear is confirmed
   inside `git-settings.js`; Git forms stay JSON and JS-required with `<noscript>`.
4. `settings.js`: JSON submit via urlencoded body + `Accept: application/json`, submitter
   `action`, inline 4xx errors with `aria-invalid`/`aria-describedby` and preserved values, success
   redirect with notice + `#setting-<key>` hash, `data-no-busy` (script owns busy state), no double
   submit.
5. Providers as an `Agent` subsection with one `Change key` disclosure per provider and one closed
   `Add provider key`; warnings render in the owning row; one compact warnings block at top when
   needed; pending restart once in `#settings-restart`; OMO warnings below on app scope.
6. Preserve every endpoint/action and the merged Git credentials markup/data attributes/ids; no new
   settings keys.
7. Tests: four sections, one row per setting, no resting setting tables/forms (pending-restart forms
   excepted), source/prefill, disabled no-ops, clear dialog including provider `provider`, inline
   validation, unique ids; Git markup assertions live in `test/settings-http.test.ts` (render) while
   `test/git-settings-asset.test.ts` stays asset-only; browser height reduction target (>=55% at
   1440, >=60% at 390 on the app scope with rows closed).

Exit: settings are compact at rest, scoped editing is obvious, every action/endpoint unchanged.

### Slice D - Operator terminal

Depends on C for shared CSS. Files: `src/http/terminal.ts`, `assets/terminal.js`,
`src/http/ui.ts` (`styles` option), `src/http/handler.ts` (three vendor assets),
`src/runner/server.ts` (`LANG`), `src/http/styles.css`, tests `terminal-http`, `runner-exec`,
`http`, new `vendor-xterm`.

Changes:

1. Full-height terminal page: `.page--terminal` -> `.page__body--terminal` ->
   `#terminal.terminal-shell` with toolbar, banner, host, announcer; compact serif h1, runtime pill,
   connection pill, Copy/Reconnect/Close.
2. Vendored xterm 6.0.0 + fit addon 0.11.0 loaded with the xterm stylesheet before `app.css`; exact
   allowlist entries; checksum test mirroring Prism.
3. Theme from semantic tokens (dark/light, MutationObserver); fit on open/fonts/ResizeObserver/
   visualViewport, debounced; send resize only on change; binary input from `onData`/`onBinary` in
   UTF-8-safe chunks; text frames reserved for resize JSON; output written as `Uint8Array`; 5000-line
   scrollback; screenReaderMode.
4. Connection lifecycle: runtime preflight before connecting and on Reconnect; stopped/error renders
   the in-place empty state with Open chat/Reconnect; exponential 1/2/4/8/15s backoff for abnormal
   close; manual close flag and banner; 1011 failure; no retry on normal shell exit; `term.reset()`
   on reconnect, dispose and observer cleanup on unload.
5. Copy/paste: Ctrl+Shift+C/Cmd+C with selection, plain Ctrl+C sends SIGINT, toolbar Copy, clipboard
   API with `execCommand` fallback for insecure LAN HTTP; Ctrl+Shift+V/Cmd+V paste via xterm textarea
   fallback.
6. Runner `createExec` currently passes no env; add `TERM=xterm-256color`, `COLORTERM=truecolor`, and
   `LANG=C.UTF-8`, and assert all three in `test/runner-exec.test.ts`; terminal close never stops the
   container.
7. Tests: page ids/grid/asset order/allowlist, vendor checksums, runner env/protocol, terminal copy
   fallback and stopped preflight (asset/unit where possible).

Exit: a real terminal (ANSI, alternate screen, scrollback, resize, IME, copy/paste), honest states.

### Slice E - Chat state truth

Parallel with B/C/D after taking sole ownership of `src/http/chat.ts`. Files: `assets/chat.js`,
`src/http/chat.ts` (`data-runtime-url` and the contextual `settingsHref`), tests `chat-page`,
`chat-core` (if needed), browser fixtures.

Changes:

1. `#chat-shell` exposes `data-runtime-url`; `refreshRuntime()` polls the runtime endpoint on boot,
   stream ready, send accepted/failed, visibility, and every 10s visible; 401 redirects; failure keeps
   the last chip with `title="Runtime status unavailable"`.
2. Split `statusChip` into tool and runtime chips; runtime maps the four states + Unknown, never
   green Completed.
3. Remove `setRuntime` guesses from hydration/send/session creation/errors.
4. `Ready` precedence: waiting, sending, paused, retrying, running tool, thinking, working, queue/
   active prompt, idle, fallback. `Ready` cannot coexist with an active/queued prompt.
5. Connection lane single writer: boot/stream ready/error/pause; remove writes from hydration,
   session switch, new session, send, thread errors; remove per-session connection snapshots.
6. Tests: runtime chip from endpoint, oversized-session error leaves runtime unchanged, Ready
   precedence, connection lane untouched by hydration/session switch.

Exit: chat runtime, connection, and agent status are three separate truths.

### Slice F - Verification, docs, deploy

Files: `docs/design/ux-polish.md` (status/evidence), `docs/design/ux-qa.mjs` (browser harness),
`docs/design/artifacts/ux/README.md` + captures, `DESIGN.md`, `docs/current-state.md`,
`docs/journal/0013-ux-polish.md`, `docs/plans/README.md`, `docs/design/README.md`,
`docs/journal/README.md`, `docs/deploy/deploy-log.md` (git-ignored), `README.md` if needed.

Gates: `npm run lint`, `npm run typecheck`, `npm test`, `npm run build`. Browser QA at 390/768/1024/
1440, dark/light: application (default/configured image, pending/running/stopped/error), settings at
three scopes (closed/open rows, pending and no-pending submit counts, clear dialog, validation,
no-JS menu/Git notices), terminal (live via fake WS, stopped, reconnect, theme, 390 keyboard, Copy
fallback), chat runtime/connection/Ready scenarios. Include focus-visible, contrast, and
reduced-motion checks. Zero console/page errors. Capture evidence. Update DESIGN.md classes/status
mappings and current-state.

Then commit (Conventional Commits, one coherent UX stage), push, wait for the publish workflow,
deploy to `deployment-host` per `docs/deploy/host.md`, health-check, and append the deploy log. The merged SSH
and git-credentials stages deploy with the same image.

## 4. Acceptance criteria

- [ ] Application page: git workbench first/dominant at 1440 and 1024; state strip once; Image/SSH in
      rail; exactly one pending-restart statement; header has two labelled actions + overflow.
- [ ] Image: six labels, `.status` glyph+text, one live region, logs lazy and scroll-preserving,
      rollback confirmed, build never auto-restarts, runtime image mismatch hint.
- [ ] Settings: four sections, sticky scope/section nav, zero resting setting submit
      buttons/tables/inputs (pending-restart forms excepted), own-scope prefill, disabled no-ops with
      reasons, inline errors, Git credentials preserved, app-scope page >=55%/60% shorter at
      1440/390.
- [ ] Terminal: xterm renders ANSI/alternate screen/scrollback; fit/resize; binary input; copy/paste;
      reconnect/close/stopped states; theme follows toggle; no primary-content overflow at 390.
- [ ] State: `starting`/`error` never shown as Stopped; restart restarts; chat runtime comes from the
      endpoint; Ready precedence; connection lane only from SSE; pending restart truthful before and
      after reattach.
- [ ] All gates and browser QA green; docs and evidence committed; deployment-host healthy.

## 5. Merge rules

- `src/http/ui.ts`: A owns `RuntimeState`; B owns the `more` icon/`settingsHref`; D owns `styles`.
- `src/http/dashboard.ts`: A owns runtime map/counts and pending reasons; B owns the settings link.
- `src/http/settings.ts`: A owns the restart route; C owns render helpers.
- `src/http/handler.ts`: A owns the runtime endpoint; D owns the asset allowlist.
- `src/http/chat.ts`: E is the sole writer; B must not edit it.
- `src/http/styles.css`: append-only sections in B, C, D order; one writer at a time.
- Tests: each slice updates its own files; F runs the full suite and the no-JS/accessibility matrix.

## 6. Risks and rollback

- xterm bundle size and input throughput: vendored, capped, binary frames, scrollback 5000, write
  callback/backpressure; no new npm dependency at runtime.
- Migration v10: additive columns only; legacy rows show Restart required, not data loss; rollback
  code leaves unused columns.
- Settings rewrite touches the largest render file: preserve every endpoint/action and Git markup;
  run the full suite after each section; no API changes.
- Chat changes are client-side plus one data attribute; no SSE contract change.
- Deploy: image tag rollback and state/workspace backups per `deployment-host.md`; migration is forward-only, so
  code rollback keeps the new columns (safe).
- Accepted debt remains as listed in the design (no runtime SSE, ephemeral PTY, no terminal search/
  web-links, Git settings JS-required).

## 7. Plan review

Status: **PASS-WITH-CHANGES**, `momus`, 2026-10-21; implementation complete, see
[`docs/journal/0013-ux-polish.md`](../journal/0013-ux-polish.md). Folded findings: runner exec env is added, not
kept; Slice E is the sole writer of `src/http/chat.ts`; default-image controls are state-specific;
zero resting submits excludes pending-restart forms; Slice A updates all `SiteModel` fixtures and
migration counts; Git markup assertions move to `test/settings-http.test.ts`; provider clear carries
`provider`; pending reasons reach `SiteModel`; Slice F adds no-JS and accessibility checks.
