# 0060 - Skill sources UI

- Design: [`docs/design/skill-sources-ui.md`](../design/skill-sources-ui.md) (`oracle` round 2 PASS)
- Plan: [`docs/plans/0047-skill-sources-ui.md`](../plans/0047-skill-sources-ui.md) (`momus` OKAY)
- Backend context: [`docs/design/external-skill-sources.md`](../design/external-skill-sources.md)
- ADR: [`docs/decisions/0018-external-skill-sources.md`](../decisions/0018-external-skill-sources.md)
- Previous stage: journal 0044 (`8228a37`); settings-console layout: journal 0057

## Context

Journal 0044 shipped the external-source backend and deferred every UI surface. This stage adds the
operator UI with the owner-approved scope: a global Settings source manager, a read-only
source-skills drawer, and external read-only rows/filter/drawer in the Skills inventory. Fork-to-local,
the arbitrary local-file editor, and binary upload remain out of scope.

The work started in an isolated worktree because the main checkout had an unrelated legacy SSR
cutover in progress, then was rebased onto the two-pane settings console (`11e76eb`). The branch is
`feat/skill-sources-ui`.

## Design and review

The design fixes the information architecture before code:

- Source management is the `sources` section of the two-pane settings console: a rail item and a
  `#settings-sources` pane. Project/app pages show a "Skill sources are global" guard inside that
  pane. The canonical hash is `#settings-sources`; `#settings-skill-sources` remains an alias.
- The source list is a status-first six-column ledger at >=1024px and a labelled stacked card below
  1024px. Endpoint/error are secondary lines in the Source cell so the embedded console pane stays
  readable.
- Source detail is a native `<dialog>` drawer, not a route. External skill detail is also a drawer.
- The token is write-only: it is never rendered after save; Replace and Clear are explicit actions.
- Delete is a hard delete (`{hard:true}`) with typed-slug confirmation; Disable is the reversible
  action. The copy distinguishes source removal, cached snapshots, and local skills.
- Source mode pinning and snapshot retention are separate concepts in copy.
- External rows are excluded from "Inherited" and counted separately; they never link to
  `/skills/null` and never fall back to a "Global" origin badge.
- File preview is text-only with a 64 KiB cap; binary files show metadata only. The preview is
  keyed to the active snapshot and cannot accept a caller-supplied hash or filesystem path.

`oracle` round 1 requested changes. The main findings were: delete defaults to soft-disable unless
`hard:true`; disabling a pinned source left `mode=pinned` with no snapshot and broke re-enable;
external rows would duplicate Vue keys and crash `SmartLink` on `href=null`; snapshot/token times
and the file-preview contract were missing; warning data/text and filter counts were wrong; the
Settings hash link and source-skills query invalidation were underspecified. The revised design
folded all of them in, and `oracle` round 2 returned PASS. `momus` returned OKAY.

## Backend changes

- `ExternalSkillRecord`/`ExternalOrigin` carry `publishedAt`; `activeRecords()` joins
  `skill_source_snapshots.published_at`, and external inventory "Updated" uses that time.
- `SkillSourceView` carries `tokenUpdatedAt` from `skill_source_credentials.updated_at`; the token
  itself remains write-only.
- Soft-disabling and `update({enabled:false})` reset `mode='track'` and clear the ETag, so
  re-enabling a previously pinned source can publish again.
- `check` updates only `last_checked_at`; `last_success_at` now means a published snapshot.
- Duplicate slugs return 409 `slug_taken`; Replace token requires a non-empty string and clearing
  uses the dedicated clear action.
- Source warnings carry `sourceName`/`sourceSlug`; text handles conflict, quarantine, and stale.
  Quarantine uses the source id as root; stale carries `lastSuccessAt`.
- `previewFor`/`surfaceModel`/inventory props accept `SkillSource`; `/api/ui/skills` and `GET
  /api/skills` resolve through `deps.effectiveSkills ?? deps.skills`, while managed detail and
  mutations keep `deps.skills`.
- Inventory props add structured `origin` (including `publishedAt`), `external` filter/count,
  source-aware search, and `effective.fileCount` for the Files column. External rows are excluded
  from inherited counts.
- `GET /api/skill-sources/:id/files?snapshotId=&bucket=&name=&path=` returns bounded text or binary
  metadata. It verifies the snapshot is active, resolves the exact skill and path from that
  snapshot, reads only the matched CAS blob, caps text at 64 KiB, and returns 404 for a missing blob
  or mismatched snapshot/path.
- The Settings label map gains `sources`.
- E2E fixtures add a deterministic fake `skills-hub` (`e2e/support/skill-hub.ts`), seed a synced
  source/snapshot, and pass `skillSources`/`effectiveSkills` into `HttpDeps`.

## UI changes

- `SettingsSkillSourcesSection.vue`: query/empty/loading/error, ledger/stacked rows, status chips,
  stale/pinned badges, status-driven primary action, overflow actions, sync/check/pin/disable/
  enable, credential replace/clear, typed delete, force-sync confirmation, and the source drawer.
- `SkillSourceDialog.vue`, `SkillSourceTokenDialog.vue`, `SkillSourceDeleteDialog.vue`: native
  dialogs, empty-safe slug derivation, http opt-in, advanced fields, write-only token replacement,
  typed-slug hard delete.
- `SkillSourceDrawer.vue`: summary, error callout, credential state, actions, skills table,
  expandable file list, text/binary preview. Preview cache is cleared when the active snapshot
  changes.
- `ExternalSkillDrawer.vue`: read-only banner, source/revision, metadata, file list/preview,
  not-found/disabled state, and a link to source management.
- `SettingsPage.vue`: global section, global-only card at project/app scopes, synchronous skeleton,
  nav label, and `route.hash` activation.
- `SkillsPage.vue`: external row branch with `externalKey` keying, button instead of null
  `SmartLink`, Source/Read-only badges, Files column, External filter/count, and drawer trigger.
- `styles.css`/`DESIGN.md`: structural `skill-source-*`/`source-drawer` classes only, using the
  existing tokens; no new color, space, radius, shadow, or motion values.

## Settings-console integration

The first implementation targeted the earlier section-nav settings page. After `main` gained the
two-pane console (`2dc9604`), the branch was rebased and the UI was re-integrated rather than merged
mechanically:

- `ui/settings-view.ts` adds `sources` to `SettingsSectionId`/`SETTINGS_SECTIONS`, with an icon,
  description, rail summary, and canonical/legacy hash mapping.
- `SettingsPage.vue` renders the `#settings-sources` pane; the manager mounts only while the pane is
  active at global scope, so it does not fetch on the default Agent pane. Project/app scopes get the
  global-only guard.
- `SettingsSkillSourcesSection` accepts `showIntro=false` so the pane header owns the introduction;
  the ledger is six columns (Status, Source, Sync, Revision, Skills, Actions) with endpoint/error
  under the Source cell.
- `ExternalSkillDrawer` and the guard link use `/settings#settings-sources`; the old hash still maps
  to the same pane.
- E2E opens the `sources` rail item and asserts the console pane, canonical link, rail selection, and
  the old-hash alias.

## Verification

- `npm run typecheck`, `npm run typecheck:ui`, `npm run lint` (958 files): pass.
- Server suite: **197 files passed, 4 skipped; 3,570 tests passed, 4 skipped**.
- UI suite: **82 files, 661 tests passed**.
- `npm run build`, `npm run check:ui` (sentinel present), `npm run check:sensitive`: pass.
- Targeted E2E: `spa-skill-sources` 8/8; `spa-skill-sources + spa-settings + spa-skills` 16/16.
- Full `npm run test:e2e`: **144 passed, 1 skipped, with one unrelated chat-layout flake that passed on isolated rerun** (8.4m); effectively 145 E2E scenarios green.
- Headless Chromium artifacts: 24 screenshots at 390/1440 in dark/light under
  `docs/design/artifacts/skill-sources/`, covering the Settings list, source drawer, add dialog,
  external inventory/filter, and external skill drawer.
- E2E asserts the token sentinel is absent from `page.content()`, no `/skills/null` link exists, the
  external filter isolates the row, text preview renders, binary files show metadata only, and the
  typed delete posts `{hard:true}`.

## Deferred / open threads

- Fork-to-local (backend and UI).
- Arbitrary local-file text editor and binary upload UI.
- Per-source inventory filtering when multiple sources are common; snapshot history and sync
  attempt history are still API/UI gaps.
- The add-source dialog body scrolls on 390px; the token hint sits at the scroll boundary. The
  capture is not a failure, but a future dialog spacing pass could increase the mobile body height.
- `check` still does not persist a per-check error state; failures are surfaced as a toast/result
  rather than a row error. Last sync errors remain persistent.
