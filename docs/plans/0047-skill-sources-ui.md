# Plan 0047 - Skill sources UI

Status: **implemented** - design `oracle` round 2 **PASS**; plan `momus` **OKAY**; all gates and headless QA green (journal 0060).

Design: [`docs/design/skill-sources-ui.md`](../design/skill-sources-ui.md)
Backend: [`docs/design/external-skill-sources.md`](../design/external-skill-sources.md),
[`docs/current-state.md`](../current-state.md)
Journal: to be written as `docs/journal/0060-skill-sources-ui.md`

## 1. Scope

Implement the deferred UI for external skill sources:

1. Global settings console > Skill sources pane: list, create/edit, write-only token replace/clear, sync,
   check, pin/unpin, disable/enable, delete, status/error, and a source-skills drawer.
2. External read-only rows in the Skills inventory: structured origin, Source badge, External
   filter/count, source-aware search, and a read-only skill drawer.
3. A bounded, text-only file-preview endpoint for the source/external drawers.
4. The backend contract fixes required to make the UI truthful: effective-skills read path,
   snapshot publication time, token update time, warning data/text, hard-delete semantics,
   pinned-disable recovery, duplicate-slug mapping, replace-token validation, and check semantics.

Non-goals: fork-to-local, editing external skills, arbitrary-file/binary upload UI, git-backed
sources, new SPA routes, schema changes, sync/materialization algorithm changes.

## 2. Owner decisions

- Scope is Settings manager + external inventory rows (owner selected "Also external rows in
  Skills").
- Delete is a hard delete from the UI (`{hard:true}`); Disable is the reversible action.
- External rows are excluded from "Inherited" counts/filter and counted separately.
- File preview is text-only with binary metadata; no binary/base64 download.
- Create uses "Add and sync"; the source remains if the first sync fails.
- Fork-to-local stays deferred; the read-only drawer links to source management.

## 3. Ordered work

### Phase 0 - baseline

1. `npm install` (worktree uses a symlinked `node_modules`), then run the existing gates on the
   untouched branch: `npm run typecheck`, `typecheck:ui`, `lint`, `test`. Record any pre-existing
   failures; do not fix unrelated failures.

### Phase 1 - backend contract fixes

Files: `src/skill-sources/types.ts`, `service.ts`, `composite.ts`, `src/skills/types.ts`,
`src/http/skill-sources.ts`, `src/http/props/skills.ts`, `src/http/skills.ts`, `src/http/spa.ts`.

1. **Snapshot publication time**
   - Add `publishedAt: string | null` to `ExternalSkillRecord` and `ExternalOrigin`.
   - Join `skill_source_snapshots.published_at` in `activeRecords()`.
   - In `CompositeSkillSource.#externalBundle`, set `origin.publishedAt` and use
     `record.publishedAt ?? new Date().toISOString()` for `updatedAt`; never use request time when
     a publication time exists.

2. **Credential update time**
   - Add `tokenUpdatedAt: string | null` to `SkillSourceView`.
   - In `SkillSourceService.#view`, read `skill_source_credentials.updated_at` (or the equivalent
     existing column) for the source and return it; never return the token.
   - Add it to the server/client source view types.

3. **Pinned disable recovery**
   - In soft delete and in `update({enabled:false})`, set `mode='track'` when clearing
     `active_snapshot_id`/`pinned_snapshot_id`.
   - Add a regression test: create -> sync -> pin -> disable -> enable -> sync publishes/resolves.
   - Hide Pin in the UI when `activeSnapshotId === null`.

4. **Check semantics**
   - `#touchChecked` updates only `last_checked_at`.
   - `last_success_at` changes only on a published snapshot (`#markSuccess`).
   - Add a test proving check does not advance last success.

5. **Duplicate slug / token replace**
   - Before insert, check `SELECT id FROM skill_sources WHERE slug = ?`; throw
     `SkillSourceError("slug_taken", ...)`; map to HTTP 409 with `code: "slug_taken"`.
   - In `handleSkillSources`, require a non-empty string token for the `secret` action and
     `/secret` path; return 400 `VALIDATION` field `token` otherwise.
   - Clearing is only `clear-secret` / `secret/clear`.

6. **Warning data and text**
   - Add optional `sourceName`/`sourceSlug` to `SkillWarning`; set them in
     `SkillSourceService.warnings()`:
     - stale: `name` omitted, `sourceName`/`sourceSlug` = source, `lastSuccessAt` in the message.
     - quarantined: `name` = skill, `sourceName`/`sourceSlug` = source, `root` = sourceId.
     - conflict: `name` = skill, `sourceName` = winning source name.
   - `warningText` handles `skill_source_conflict`, `skill_source_quarantined`,
     `skill_source_stale`; the generic fallback remains only for disabled-elsewhere.
   - `SkillWarningProps` carries `sourceName`/`sourceSlug`.
   - Add `skill_source_conflict` to the per-row collision list for managed rows.
   - Add `invalid_skill_file` to `issueAnchor` if an anchor exists; the UI type union includes it.

7. **Effective-skills read path**
   - In `src/http/spa.ts`, add `effectiveSkillsFor(deps): SkillSource | undefined` returning
     `deps.effectiveSkills ?? deps.skills` (or a fresh managed service fallback).
   - Use it for `/api/ui/skills` inventory. Keep managed `skillsServiceFor` for
     `/api/ui/skills/:id`, create/update/delete.
   - In `src/http/skills.ts`, use the effective source for `GET /api/skills` resolution/preview;
     keep managed service for POST/DELETE and detail.
   - Widen `SkillsInventoryBuildInput.skills`, `previewFor`, and `surfaceModel` to `SkillSource`;
     keep detail builders on `SkillService`.

8. **Inventory props**
   - Add structured `origin` to `SkillsInventoryRowProps`:
     `{sourceId, sourceName, bucket, revision, snapshotId, publishedAt}` or null.
   - Set it from `EffectiveSkill.origin` in the external branch; keep `originText` for
     compatibility.
   - Add `external` to `InventoryFilter`; `counts.external`; exclude external from
     `counts.inherited`; `filter=inherited` excludes `mode==="external"`.
   - `filterOptions` adds External with the current href.
   - Search matches name, description, external source name, and bucket.
   - Use `effective.fileCount` for all rows and label the column "Files" in the UI.
   - Client mirror `ui/skills-types.ts`: nullable `id/primaryId/scope/originScope/href`, add
     `mode/externalKey/fileCount/origin`, new filter/warning/issue unions.

9. **File preview endpoint**
   - Route: `GET /api/skill-sources/:id/files?snapshotId=&bucket=&name=&path=`.
   - Extend `isSkillSourcesRoute`.
   - Require human principal and same-origin rules as the rest of the source API.
   - Validate `snapshotId === source.activeSnapshotId`; look up `sources.skills(id)`, find the
     exact `(bucket, name)`, then the exact file path; never accept a caller-supplied sha or
     filesystem path.
   - Read the CAS blob via `sources.readFiles([file])`.
   - Cap text at 64 KiB. Decode as fatal UTF-8; reject NUL/control-heavy content as binary.
   - Response: `{path, size, sha256, encoding:"text"|"binary", text?}`; binary has no content.
   - Missing source/skill/file -> 404; invalid query -> 400; missing blob -> 404 with a clear code;
     `cache-control: no-store`.
   - Tests: text, binary, cap, snapshot mismatch, wrong path, missing blob.

### Phase 2 - UI

Files: `ui/skill-sources-types.ts`, new components under `ui/components/`, `ui/pages/SettingsPage.vue`,
`ui/pages/SkillsPage.vue`, `ui/settings-types.ts`, `ui/skills-types.ts`, `ui/skills-fixtures.ts`,
`src/http/props/settings.ts`, `src/styles`/`src/http/styles.css`, `DESIGN.md`.

1. **Source types/client**
   - `ui/skill-sources-types.ts`: `SkillSourceView`, `SnapshotSkill`, `SyncResult`, `CheckResult`,
     `SourceFilePreview`, `SkillSourceState`.
   - Use `apiQuery`/`apiMutation`; no token in URLs; invalidate `["skill-sources"]` and
     `["skill-source-skills", id]` after every mutation.
   - Use `markSkillsMutated()` after a sync with `changed: true`.

2. **Settings section in the two-pane console**
   - Add `sources` to `SettingsSectionId`/`SETTINGS_SECTIONS` in `ui/settings-view.ts`, so it gets
     a rail item, icon, description, and `#settings-sources` pane; add the `sources` label to
     `SETTINGS_SECTION_KEYS`, `labels.sections`, and the client mirror.
   - Mount `SettingsSkillSourcesSection` when the `sources` pane is active at global scope; at
     project/app scopes render the "Skill sources are global" guard with a link.
   - Map the canonical `#settings-sources` hash and the legacy `#settings-skill-sources` alias in
     `sectionForHash`; the console already handles rail selection and hash changes.
   - Add `SettingsSkillSourcesSection.vue`: query, empty/loading/error, list, actions, dialogs,
     drawer.

3. **Source list**
   - Ledger table at >=1024; stacked rows below. Columns: status, source, endpoint host, sync,
     revision, skills/bytes, error, actions.
   - Status chip mapping per design §6; stale and pinned badges; pinned is a mode badge.
   - Status-driven primary action precedence: error Retry, disabled Enable, syncing disabled,
     degraded Review skills, pinned Unpin, else Sync now.
   - Overflow: check, pin/unpin (only with active snapshot), disable/enable, edit, delete, force
     sync only for `deletion_guard`.
   - Row title opens the source drawer; `View skills` also opens it.

4. **Dialogs**
   - Add source: name, slug (auto-derived, empty-safe for non-ASCII), endpoint, buckets (empty =
     all), token, allow-insecure-HTTP, advanced disclosure. Primary "Add and sync".
   - Edit: name, endpoint, buckets, priority, intervals; no slug, no token, no enabled.
   - Replace token: non-empty password; clear DOM after submit.
   - Clear token: confirm, no token input.
   - Disable/enable: confirm disable; enable triggers sync.
   - Delete: typed slug, 6 consequences bullets, `{hard:true}`, danger button disabled until match.
   - Use native `<dialog>` with unique `aria-labelledby` ids; focus return; busy disables actions.

5. **Source drawer**
   - Summary grid, error callout, credential row (`tokenSet`, `tokenUpdatedAt`), actions, skills
     table, file list/preview.
   - File rows are buttons with `aria-expanded`; selecting a file calls the preview endpoint with
     `snapshotId`; text renders in `<pre>`, binary shows metadata.
   - Empty skills state distinguishes never-synced, disabled, and empty active snapshot.

6. **External inventory**
   - `SkillsPage.vue`: key `externalKey ?? String(id)`; external name is a button; no `SmartLink`
     with null; origin badge `Source` + `sourceName · bucket`; read-only state badge; Files column
     from `fileCount`; action `View` opens `ExternalSkillDrawer`.
   - Add `External` filter and counts; search already source-aware from Phase 1.
   - `ExternalSkillDrawer.vue`: read-only banner, source/revision, description, file list/preview,
     `Manage source` link to `/settings#settings-sources`, not-found/disabled state.
   - Add external fixtures to `ui/skills-fixtures.ts` (including `id: null`, `href: null`,
     `origin.publishedAt`) and update `ui/pages/SkillsPage.test.ts`.

7. **Styles**
   - Reuse existing primitives. Add only structural classes using existing tokens; add them to
     `src/http/styles.css` and the relevant `DESIGN.md` section. No SFC `<style>`, no `v-html`.
   - Ensure status not color-only; focus-visible; 44px touch targets; table stack; drawer full width
     below 768; no horizontal page scroll.

### Phase 3 - tests

1. Backend unit/props tests:
   - `test/skill-sources.test.ts`: pinned disable/enable, check semantics, publishedAt, tokenUpdatedAt,
     warning source fields, duplicate slug, secret validation.
   - `test/skill-sources-http.test.ts`: file preview (text/binary/cap/snapshot mismatch/missing),
     hard delete vs soft disable, duplicate slug 409, replace-token 400.
   - `test/skills-props.test.ts`: external origin/publishedAt, external filter/count, inherited
     exclusion, search, warning text, managed fileCount, external row shape.
   - `test/skills-http.test.ts` / `test/ui-props-auth.test.ts`: effective read path and auth.
2. UI component tests:
   - `ui/components/SettingsSkillSourcesSection.test.ts`: list states, create/edit, token, delete,
     sync/check, drawer.
   - `ui/components/SkillSourceDrawer.test.ts`: file preview, empty/error.
   - `ui/components/ExternalSkillDrawer.test.ts`: text/binary, not-found.
   - `ui/pages/SkillsPage.test.ts`: external row key, no null link, badge, filter, drawer trigger.
   - `ui/pages/SettingsPage.test.ts`: section nav, global guard, hash deep link.
3. E2E:
   - Add `e2e/support/skill-hub.ts` with a deterministic fake hub (or `fetchImpl`) and seed a source
     + active snapshot.
   - Wire `skillSources` and `effectiveSkills` into `e2e/support/server.ts` `HttpDeps`.
   - Add `e2e/spa-skill-sources.spec.ts`: create/sync/check/pin/disable/enable/delete; token
     sentinel absent from DOM; external row/filter/drawer; no `/skills/null`; direct settings hash.
   - Screenshots at 390/1440, light/dark, under `docs/design/artifacts/skill-sources/`.

### Phase 4 - record and commit

1. Run all gates: `npm run typecheck`, `typecheck:ui`, `lint`, `test`, `build`, `check:sensitive`,
   `test:e2e`.
2. Write `docs/journal/0060-skill-sources-ui.md`; update `docs/journal/README.md`,
   `docs/design/README.md`, `docs/plans/README.md`, `docs/current-state.md`, and the decision
   record if needed.
3. Commit on `feat/skill-sources-ui`; do not merge into `main` while another stage is active.
   Report the branch/commit and the exact verification evidence.

## 4. Verification matrix

| Gate | Command | Expected |
| --- | --- | --- |
| Types | `npm run typecheck` | pass |
| UI types | `npm run typecheck:ui` | pass |
| Lint | `npm run lint` | pass |
| Unit | `npm test` | pass |
| Build | `npm run build` | pass |
| Sensitive | `npm run check:sensitive` | pass |
| E2E | `npm run test:e2e` | pass |
| Headless visual | Playwright Chromium script | screenshots + no console errors |

## 5. Risks / rollback

- The backend changes touch read-path resolution and source lifecycle; keep them additive and
  covered by tests. Rollback is by reverting the branch.
- Do not change snapshot/materialization semantics or the DB schema.
- Do not expose tokens in DOM, URLs, logs, toasts, or errors.
- Do not commit `node_modules` or generated `assets/` output.

## 6. Definition of done

- [ ] Source CRUD/token/sync/check/pin/disable/enable/delete work from Settings.
- [ ] Source status/revision/counts/error/stale/token-updated are truthful.
- [ ] External rows render with source badge, External filter, source-aware search, and drawer.
- [ ] No `/skills/null`, duplicate-key, "Global" external badge, or null `SmartLink`.
- [ ] Pinned disable/re-enable regression test passes; hard delete removes the source.
- [ ] File preview is bounded/read-only/snapshot-consistent.
- [ ] All gates and headless visual QA pass.
- [ ] Journal, indexes, and current-state are updated; branch commit is created.
