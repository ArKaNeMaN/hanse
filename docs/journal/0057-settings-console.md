# 0057 - Settings console

> Stage: settings console redesign. Design:
> [`docs/design/settings-console.md`](../design/settings-console.md).
> No separate plan artifact: the owner iterated the design in-session and directed implementation.
> Status: implemented; owner review pending; no commit.

## Context

The settings page was a single scrolling document with a sticky scope/section bar, six stacked
section cards, and one collapsed row per setting. Every setting read like the same row, the scope
hierarchy was buried in `default`/`Inherited`/`Cleared` labels, and the mobile view was the desktop
layout squeezed into a narrow column. The owner approved a two-pane console: a scope ladder and
four-cell summary in the header, a sticky section rail, one focused pane, per-row G/P/A provenance,
and a deliberate mobile composition. The owner also asked to remove the redundant `Set here`
action and the per-setting `Restart required` warning.

## What changed

- **Page shell** (`ui/pages/SettingsPage.vue`): `useWorkspaceShell("page--settings-console")`, a
  fixed-height desktop page, a scope ladder with real counts, a four-cell summary, and a
  rail-plus-pane console. The six real sections are the only panes; the local exploration's
  `Advanced` demo section is not part of the product.
- **Derived data** (`ui/settings-view.ts`): pure helpers for the row trace, page summary, scope
  counts, section summaries, attention target, and hash-to-section mapping. The settings API shape
  is unchanged; the only server prop change is the action labels
  (`Save override`, `Use inherited`, `Clear at this scope`).
- **Rows** (`ui/components/SettingsRow.vue`): the summary now carries title + hint, effective value,
  source, and the G/P/A trace. The `Scope details` block and the row-level action column are gone.
  The editor keeps all field kinds and validation; `Use inherited` is shown only for a local set
  value. A small refresh glyph marks launch-effective rows that are set at the current scope while
  a restart is pending; per-setting restart prose is not rendered.
- **Restart section** (`ui/components/SettingsRestartSection.vue`): the outer card was removed so
  the pane owns the section header and `#settings-restart`; pending rows, restart action, and
  profile warnings are unchanged.
- **CSS** (`src/http/styles.css`): the desktop console is a fixed-height grid whose pane body is the
  only vertical scroll owner; below 900px the page scrolls, the rail becomes a sticky horizontal
  tab strip, the summary is 2x2, and rows/editors/actions stack. The single Global ladder node is
  compact.
- **Icons and lint** (`ui/components/AppIcon.vue`, `biome.json`): local `cpu`/`globe`/`bell`/`git`
  paths; the untracked local design-exploration HTML is excluded from the repository lint.
- **Docs/tests**: the settings paragraphs in `DESIGN.md` and `docs/current-state.md`; unit tests for
  the view helpers and the page/Telegram components; the settings E2E selectors and action labels.

## Decisions and trade-offs

- **Client-side derivation, no settings API change.** The page already exposes the per-row
  `scopeDetails`, `scoped`, `gitAuthScoped`, and restart list. `inherited` counts values resolved
  from a wider scope, not defaults; defaults are not labeled as inheritance.
- **Honest scope ladder.** Only scopes that are part of the target get counts. The Global page shows
  a single Global node; it does not invent Project/Application counts. The global row trace is a
  single current-scope step.
- **Restart marker is a hint.** It requires `restartRequired`, a launch-effective key, and a value
  set at the current scope. It does not claim that the marked row caused the pending restart; the
  Restart & pending pane remains authoritative.
- **One primary action.** `Save override` is the only primary in a row; `Clear at this scope` is a
  ghost tombstone; `Use inherited` is hidden when it would be a no-op.
- **Mobile is a separate composition.** The rail becomes tabs and the page scrolls; desktop keeps
  the fixed-height console and pane-body scroll.

## Verification

- `npm run lint`: pass (with the local design-exploration HTML excluded).
- `npm run typecheck`: pass.
- `npm run typecheck:ui`: pass.
- `npm run build`: pass.
- `npm run check:ui`: pass.
- `npm run check:sensitive`: pass.
- `npm run test:ui`: 631 passed (76 files).
- Settings server tests (`settings`, `settings-props`, `settings-http`, `settings-store`,
  `shared-routes`, `ui-props-auth`): 148 passed.
- `settings.spec.ts` + `spa-settings.spec.ts`: 9 passed, 1 legacy skip.
- Full `npm test` did not finish within a 15-minute timeout during this working session; it was not
  a reported failure. The complete UI project, settings server coverage, and settings E2E are green.

Measured on the deterministic fixture:

- Desktop: page `scrollHeight == clientHeight == 844`; console 1144; rail 272; pane 870; pane body
  `overflow-y: auto`.
- Mobile: document 390/390; page scrolls 1266 > 788; summary 2x2; no horizontal overflow.
- Global summary 1 set here / 0 inherited / 2 needs attention / 1 restart pending.
- Application summary 3 set here / 2 inherited / 2 needs attention / 1 restart pending.

Evidence: [`docs/design/artifacts/settings-console/`](../design/artifacts/settings-console/README.md).

## Deviations and gaps

- The scope block is a full-width band under the page header rather than the mockup's right-hand
  column; `Refresh` and `Skills` remain in the page header. This is an owner-review item.
- Global has only the Global trace/count; wider-scope counts exist only for scopes in the target.
- Provider, git, and Telegram secret forms keep their existing labels/layouts; only generic setting
  rows use the new action vocabulary.
- The local design-exploration mockups under `docs/design/settings-redesign/` are untracked; the
  evidence screenshots in `docs/design/artifacts/settings-console/` are the tracked record.
- No commit or deployment has been made. The working tree also contains unrelated
  runner/mounts changes from concurrent work; they were not touched or staged.
