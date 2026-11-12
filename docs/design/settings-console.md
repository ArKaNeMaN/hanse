# Settings console

Status: implemented; owner review pending; no commit.
Implementation: `ui/pages/SettingsPage.vue`, `ui/settings-view.ts`,
`ui/components/SettingsRow.vue`, `src/http/styles.css`.

## Context

The settings page was a single scrolling document: a sticky scope/section bar, six stacked section
cards, and one collapsed row per setting. The owner found it too flat, with every setting reading
like the same row and the scope/inheritance model buried in `default`/`Inherited`/`Cleared` labels.
The approved direction is a two-pane console: a scope ladder and summary in the header, a sticky
section rail, one focused pane, and an explicit G/P/A trace per row.

## Direction

- Two-pane console: left rail (Agent, Web tools, Context, Notifications, Git, Restart & pending) and
  one focused pane. Only the pane body scrolls on desktop; the page itself does not.
- Scope ladder in the header: Global -> Project -> Application for the current target, real
  set-value counts, current node with the brass rim/wash. Global shows only Global; no invented
  Project/Application counts. The current target picker remains the only way to choose a project or
  application.
- Four-cell summary: set here, inherited, needs attention, restart pending. Needs-attention and
  restart links select the owning pane.
- Row summary: title + hint, effective value, provenance, and a G/P/A trace; the row is the edit
  affordance. The editor keeps the existing field kinds and validation.
- Actions: `Save override` (primary), `Use inherited` (only for a local set value), and
  `Clear at this scope` (ghost; tombstone). No `Set here` action.
- Restart is stated once, in the summary and the Restart & pending pane. A subtle refresh glyph on
  a row is only a hint, not a per-setting warning.
- Mobile: the page scrolls as one document, the rail becomes a sticky horizontal tab strip, the
  summary is 2x2, rows and editors stack, and long row hints stay hidden until the row is open.

## Data mapping

All derived data is computed from the existing `SettingsProps`; the API shape is unchanged. The
only server change is the action label strings.

- **Trace** (`ui/settings-view.ts`): project/application pages use `row.scopeDetails` (global through
  the current scope). A set/cleared/absent state maps to filled/cleared/hollow; the winning step is
  `row.effective.source`. The global page has no wider scopes, so it synthesizes one current-scope
  step from `row.own.state` instead of inventing Project or Application values.
- **Summary** (`pageSummary`): counts the 13 registry values, the two git credentials, and the two
  telegram secrets. `set here` is a current-scope set; `inherited` is an absent current scope
  resolved from a wider scope (defaults are not counted as inherited); `attention` is the
  deduplicated warning/error set; `restart pending` is the pending list, or one when only
  `restartRequired` is set. Dynamic providers and custom model providers are counted in their own
  sections, not in these four cells.
- **Scope counts** (`scopeCounts`): set values per applicable scope from `scoped`, `gitAuthScoped`,
  and telegram secrets whose effective source is that scope. Scopes outside the target return
  `null`, so the ladder hides the count rather than fabricating one.
- **Restart marker** (`showsRestartMarker`): `restartRequired` plus a launch-effective key set at the
  current scope. The launch-affecting keys are `llm.model`, `web.search`, `web.fetch`,
  `git.user.name`, and `git.user.email`; changing a wider scope, or a pending restart caused by
  another change, does not mark an inherited/default row.

## Layout and responsive

- Desktop: `useWorkspaceShell` adds `.page--settings-console`; the body is
  `.page__body--settings-console`. The page is a fixed-height grid; the console is a rail-plus-pane
  grid; `.settings-pane__head` is fixed and `.settings-pane__body` is the only vertical scroll.
  The summary strip sits between the header and the console.
- A single Global ladder node is compact (20rem), not a full-width bar. The app scope uses the
  available width for the three nodes.
- At <=900px the page returns to normal document flow; the rail is sticky at the top of the page,
  the summary becomes 2x2, and the pane body no longer scrolls independently. The section rail
  auto-scrolls the active tab into view.
- All classes use existing color, type, space, radius, and motion tokens. No SFC `<style>` and no
  `v-html`.

## Behavior preserved

Scope resolution and the target picker; generic row set/inherit/clear; clear confirmation; provider
keys; custom model providers; git identity and SSH/HTTPS credentials; Telegram rows, secrets, and
test message; restart; toasts; loading, error, and not-found states; dirty tracking; and the
write-only secret handling. The fake `Advanced` section from the local design exploration is not
part of the product.

## Evidence

- `docs/design/artifacts/settings-console/desktop-web.png` - application scope, Web tools, 1440x900.
- `docs/design/artifacts/settings-console/mobile-web.png` - application scope, Web tools, 390x844.
- Captured from `e2e/support/server.ts` with synthetic fixture data; no real project data.

Measured on the fixture:

- Desktop: page `scrollHeight == clientHeight == 844`; console width 1144; rail 272; pane 870;
  pane body `overflow-y: auto`.
- Mobile: document width `390 == 390`; page scrolls (`1266 > 788`); summary 2x2; no horizontal
  overflow.
- Global summary: 1 set here / 0 inherited / 2 needs attention / 1 restart pending.
- Application summary: 3 set here / 2 inherited / 2 needs attention / 1 restart pending.
- The restart marker appears only on a launch-effective row set at the current scope (fixture:
  git user name), not on inherited/default web rows.

## Verification

- `npm run lint`, `npm run typecheck`, `npm run typecheck:ui`, `npm run build`, `npm run check:ui`,
  `npm run check:sensitive`: pass.
- `npm run test:ui`: 631 passed (76 files).
- Settings server tests (`settings`, `settings-props`, `settings-http`, `settings-store`,
  `shared-routes`, `ui-props-auth`): 148 passed.
- `settings.spec.ts` + `spa-settings.spec.ts`: 9 passed, 1 legacy skip.
- Full `npm test` did not finish within a 15-minute timeout during this working session; it was not
  a reported failure. The targeted server and complete UI/E2E coverage for the change are green.

## Residual risks and gaps

- The scope block is a full-width band under the page header rather than the mockup's right-hand
  column, because `Refresh` and `Skills` remain in the page header. This is an owner-review item.
- The row trace on the global page is necessarily a single Global step; broader counts only exist
  on scopes that are part of the target.
- `inherited` excludes defaults by design, so the Global summary can show 0 inherited even when
  defaulted values are effective.
- The restart marker is a hint, not proof that the marked setting caused the pending restart; the
  Restart & pending pane remains the authoritative list.
- Provider, git, and Telegram secret forms keep their existing labels and layouts; only the generic
  setting rows use the compact action vocabulary.
- No commit or deployment has been made.
