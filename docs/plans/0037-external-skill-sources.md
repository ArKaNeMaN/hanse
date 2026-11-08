# Plan - External skill sources (skills hub)

Stage: `0037-external-skill-sources`.
Design: [`docs/design/external-skill-sources.md`](../design/external-skill-sources.md).
Status: **implemented** - backend/API and tests complete (journal 0044). The Vue source-management
page, external inventory drawer, arbitrary-file text editor, and binary upload UI are deferred
follow-ups; the human source API is available now.

## Bindings

- Design reviewer: `oracle`.
- Plan reviewer: `momus`.
- Design index: `docs/design/README.md`.
- Plan index: `docs/plans/README.md`.
- Journal: `docs/journal/0044-external-skill-sources.md`; index `docs/journal/README.md`.
- Decision record: `docs/decisions/0018-external-skill-sources.md`.
- Open questions: `docs/open-questions.md` (resolved for this stage).
- Language: English.
- Commit policy: one coherent stage commit, only on explicit owner instruction. The owner has
  explicitly asked for a commit when the stage is ready.

## Owner decisions carried into this plan

1. Storage: content-addressed cache plus a thin DB index; external bytes never enter `skills`;
   each app receives a materialized copy.
2. Mixing: `app > project > global > external sources`; local managed skills always win.
3. Corrupt active cache: fail closed; the source can be disabled to start without it; a forced sync
   repairs a corrupt blob.
4. Local arbitrary files: `skill_files` plus the text/base64 API land in this stage; the Vue editor
   starts with text files; binary upload UI is a follow-up.
5. Deletion guard: full successful manifest only; `max(3, ceil(previous_count * 0.20))` or an empty
   set for a previously non-empty source requires `force`; `force` bypasses the guard and ETag but
   not validation.
6. Source position: fixed below global; no per-source position setting.
7. Pinning: `mode='pinned'` keeps the active snapshot frozen; sync checks but does not publish.
8. Token rotation: write-only replace or clear; invalidates the ETag.
9. Hash compatibility: legacy managed-only hash and empty-set `undefined`; v2 exact-byte
   projection only when an external winner or a non-legacy managed file exists.
10. Launch freeze: `SkillCapture` carries managed bundles plus external descriptors; snapshot/index
    rows and blobs survive a source hard delete for the retention floor.
11. Contract split: `SkillService` for managed CRUD and agent/master tools; `CompositeSkillSource`
    for human reads and the manager; agent MCP sees managed skills only.
12. Sync-fatal vs per-skill quarantine: exact duplicate `(bucket,name)`, bucket-set mismatch,
    malformed manifest, auth/HTTP failure, file fetch/hash failure are fatal; invalid name,
    frontmatter, unsafe path, oversize, case-insensitive duplicate are quarantined.

## Invariants

1. External bytes live once in the CAS under `<XDG_STATE_HOME>/hanse/skill-sources/`; each app gets
   a materialized copy.
2. Local managed skills always win; a disabled managed row is a tombstone over every external layer.
3. A published snapshot is immutable and atomic. Resolution and materialization observe one
   captured generation.
4. Deletion only comes from a fully successful full manifest; a timeout/404/empty response never
   deletes.
5. External `SKILL.md` is verbatim; managed `SKILL.md` is synthesized.
6. The effective hash is exact materialized content when the composite mode applies; managed-only
   legacy installs keep the legacy hash.
7. Sources are global and operator-only; agent MCP tools cannot read or mutate a source or token.
8. App isolation is preserved: no shared writable skill mount, no `skills.paths`.

## Phase 0 - Decisions and guardrails

Work:

- Confirm the decisions above and the non-goals.
- Write the ADR skeleton with status `Proposed`; finalize at record time.
- Record the sensitive-data rule: no hub URL, token, hostname, or deployment path in tracked files.

Exit: no open owner question; the plan carries every decision.

## Phase 1 - Migration, types, local files, reconcile

Files:

- `src/store/migrations.ts` - migration 24:
  - `skill_files(skill_id, path, content BLOB, encoding, executable, sha256, size, updated_at)`
    with FK `skill_id` -> `skills(id)` `ON DELETE CASCADE`, PK `(skill_id, path)`.
  - `skills.origin`, `forked_from_source_id`, `forked_from_name`, `forked_from_revision`.
  - `skill_sources` (`id` random UUID, never reused; `disabled_at`), `skill_source_credentials`
    (cascade), `skill_source_snapshots` (no FK on `source_id`), `skill_source_skills` (no FK on
    `source_id`; cascade only on `snapshot_id`).
  - `instances.applied_skills_hash`.
  - Backfill `skill_references` into `skill_files` with `CAST(content AS BLOB)` and `encoding='utf8'`.
- `src/store/reconcile-skill-files.ts` (new) - idempotent `reconcileSkillFiles(db)`: fills
  `sha256`/`size`, merges legacy reference rows that differ, never deletes arbitrary files.
- `src/store/index.ts` - export the reconcile and a shared `openCoordinatorDatabase(stateHome)` helper
  that runs migrations + reconcile.
- `src/cli/commands.ts` (and the internal MCP command) - use `openCoordinatorDatabase` so every
  process that reads skills reconciles.
- `src/skills/types.ts`:
  - `SkillFile`, `SkillFileInput`, nullable `EffectiveSkill.id`/`source`, `mode`, `origin`,
    `externalKey`, `shadowedExternal`, `fileCount`, `SkillCapture`, `ExternalBundleDescriptor`,
    provenance on `SkillRow`/`SkillSummary`/`SkillDetail`, `files` on inputs/detail.
  - `SkillSource.capture(target)` plus optional capture params on resolve/preview/hash/probe/apply.
- `src/skills/tool-projection.ts` - explicit nullable `id`/`source` handling; master/app tools stay
  managed-only.
- `src/skills/validation.ts` - generic file path validation (relative POSIX, NFC, depth, segment,
  total length, case/prefix collisions, reserved `SKILL.md`), text/binary limits, file input
  validation; keep legacy reference validators.
- `src/skills/service.ts`:
  - Read `skill_files` first; fall back to `skill_references` when a skill has no file rows.
  - `create`/`update`/`override` write `skill_files`, dual-write legacy references for legacy paths,
    and `override` copies the full source file set. `references` is a partial replacement of only
    the legacy projection set (rows represented in `skill_references`); `files` is a full
    replacement; a normal UI save preserves arbitrary/binary/over-limit reference-shaped files.
  - `#storedIssues` validates file paths and sizes; legacy issues remain.
  - Phase-1 `capture(target)` is **managed-only**: the full managed resolved view (scope/effective/
    rows/disabled/warnings), managed bundles with bytes, `external: []`, and the managed hash.
    `resolve`/`preview`/`hash`/`probe`/`apply` accept an optional capture. The full composite
    capture (external descriptors + winner projections + hash) is Phase 4. Collision scanning uses
    effective + disabled.
- Tests and fixtures:
  - `test/migrations.test.ts` - v24 columns/tables, backfill, `runMigrations` twice is a no-op.
  - `test/settings-store.test.ts:45` - expected migration count 23 -> 24.
  - `test/store.test.ts:53` - exact applied-version array `[1..23]` -> `[1..24]` and title.
  - `test/migrations.test.ts:64` - exact `versions.map` array `[1..23]` -> `[1..24]`; update the
    file's other hardcoded `23` migration assertions.
  - `test/commands.test.ts:135/145` - future fixture 24 -> 25 and expected version 23 -> 24.
  - `test/http.test.ts:932` - `/readyz` schemaVersion 23 -> 24.
  - `test/manager.test.ts` `FakeSkills` - implement `capture`.
  - `test/skills-store.test.ts` - file round-trip (text/binary), legacy fallback, override copy,
    hash switch on first non-legacy file, reconcile after simulated rollback, legacy hash stability.
  - `test/skills-store.test.ts` - provenance fields and `files` in detail.
  - `ui/skills-fixtures.ts` and page tests - nullable `primaryId`/`href` fixtures (Phase 5 consumer).

Acceptance: design A1, A16, A22; every schema-version fixture is updated in the same phase; legacy
tests still pass.

## Phase 2 - Materializer v2

Files:

- `src/skills/materialize.ts`:
  - `writeAtomicBytes` for binary content and `fchmod` for `executable`.
  - Per-skill sibling staging directory, write all files, fsync file and directory, rename old
    aside, rename staging in, remove old; `SKILL.md` last.
  - Managed mode: `skill_files` or legacy references; synthesize `SKILL.md`.
  - External mode: verbatim files, exactly one top-level `SKILL.md`.
  - Preserve the marker, `skills-replaced/`, and legacy `skill/` cleanup.
- Tests:
  - `test/skills-store.test.ts` - text/binary materialization, nested paths, external verbatim,
    `SKILL.md` last, crash/partial recovery, first-deploy preservation, symlink/escape rejection.
  - `test/skills-store.test.ts` - probe staging is removed; probe/apply bytes equal.

Acceptance: design A7, A8, A16.

## Phase 3 - CAS, provider, sync engine, source service

New module `src/skill-sources/`:

- `types.ts` - `SkillSourceConfig`, `SkillSourceView`, `SkillSnapshot`, `SkillProvider`,
  `ExternalSkillRecord`, `SourceState`, errors.
- `validation.ts` - source input, endpoint, slug, bucket, priority/interval, token, path, manifest
  schema validation, size caps, URL/DNS checks.
- `cas.ts` - content-addressed store: `put`, `verify`, `read`, `repair`, blob GC, snapshot manifest
  write/fsync/rename, staging/trash.
- `hub-client.ts` - `HanseHubProvider`: Bearer auth, `If-None-Match`, no redirects, timeout,
  streaming caps, manifest/file fetch, path encoding, 304/401/429/5xx handling.
- `sync.ts` - one-sync orchestration: conditional GET, manifest validation, sync-fatal vs
  quarantine, CAS writes, snapshot publish transaction, deletion guard, pin, repair, state machine.
- `service.ts` - `SkillSourceService`: CRUD, sealed credentials, sync/check/pin/unpin, status,
  active records, background loop, single-flight, GC, retention.
- `index.ts` - exports.
- Tests: `test/skill-sources.test.ts` with a local mock HTTP hub:
  - 200/304/401/429/500/timeout/redirect/malformed/wrong schema/bucket mismatch.
  - partial file failure, hash mismatch, size cap, duplicate exact/case-insensitive name.
  - empty/removal guard, force, pin/unpin, revision-only reuse, quarantine.
  - corrupt blob repair, GC retention, single-flight, atomic publish.

Acceptance: design A2-A5, A10, A18-A21.

## Phase 4 - Composite source, capture, manager, CLI

Files:

- `src/skills/composite.ts` or `src/skill-sources/composite.ts`:
  - `CompositeSkillSource implements SkillSource` and owns the **full** capture: one read
    transaction over managed rows + `skill_files` + active external snapshot/index rows; it
    computes `resolved`, derives `managed`/`external` from the same winner list, and the hash.
  - local-wins resolution, external conflicts, quarantine/stale warnings, external effective rows.
  - Update `test/manager.test.ts` `FakeSkills.capture` to return a managed-only capture for tests.
- `src/opencode/manager.ts`:
  - `capture` once per launch; pass to `probe`/`apply`; use `capture.hash` for `settingsHashFor`.
  - write `instances.applied_skills_hash`; implement the exact `pendingRestart` algorithm:
    unknown only when `applied_profile` is absent or both applied hashes are absent; NULL
    `applied_skills_hash` skips the skills comparison and uses the combined settings hash;
    non-NULL isolates non-skills settings with `settingsHashFor(..., appliedSkillsHash, ...)` and
    reports `skills_changed` only when the non-skills projection matches.
  - add `skills_changed` to `settingsRestartReason()` and the settings UI reason map.
- `src/cli/commands.ts`:
  - construct `SkillSourceService` and `CompositeSkillSource`; pass the composite to the manager and
    human read paths; start/stop the sync loop; call `reconcileSkillFiles`.
- `src/http/handler.ts` / `spa.ts`:
  - `effectiveSkills`, `skillSources` deps; read paths use `effectiveSkills`.
- Tests:
  - `test/manager.test.ts` - capture consistency, hash compatibility, `skills_changed`, NULL
    applied hash, source hard delete during launch.
  - `test/skills-store.test.ts` or new `test/skill-composite.test.ts` - precedence matrix, two
    sources, shadowed external, tombstone, quarantine fallback.

Acceptance: design A6, A9, A12, A15, A20.

## Phase 5 - HTTP API and UI

Files:

- `src/http/skill-sources.ts` - human-only routes from design §6.4, CSRF, JSON errors, no secrets.
- `src/http/server.ts` - dispatch for `/api/skill-sources*` and the external drawer/preview; raise
  the `/api/skills` POST limit to 16 MiB so an 8 MiB bundle (base64 + JSON) is accepted. Update the
  existing `test/skills-http.test.ts` "accepts a 4 MiB skills body and rejects one above the bound"
  test: keep a `>4 MiB` accepted case and change the rejected payload to `>16 MiB` (e.g. 17 MiB);
  keep the `/api/settings` 70 KiB 413 assertion. The old 4 MiB limit is insufficient.
- `src/http/props/skills.ts` - nullable `id`/`primaryId`/`href`/scopes, `mode`/`externalKey`,
  external inventory rows, warning text for new codes, fork provenance.
- `src/http/skills.ts` - read paths use `effectiveSkills`; external rows read-only; fork action.
- `src/http/spa.ts` - source props and external drawer data.
- `ui/skills-types.ts` - mirror the props changes, including the three new warning codes.
- `ui/pages/SkillsPage.vue` / `SkillDetailPage.vue` - external badge, read-only drawer, drawer
  trigger when `href` is null (never `/skills/null`), fork action, nullable ids.
- `ui/components/SkillBundleEditor.vue` - add a text `files` editor (add/edit/remove arbitrary text
  paths) alongside the existing references editor; binary upload UI remains a follow-up. Preserve
  non-reference files on a normal save (D6).
- `src/http/props/settings.ts` + `ui/pages/SettingsPage.vue` - global "Skill sources" section:
  source list, create/edit, token, sync/check/pin, status, errors, quarantine, bytes; no new SPA
  route.
- Tests:
  - `test/skills-http.test.ts` - external rows, read-only, fork (including target name conflict,
    A17), warning codes, the updated 16 MiB body-bound test (accepted `>4 MiB`, rejected `>16 MiB`),
    and the retained `/api/settings` 70 KiB 413 assertion.
  - `test/skills-props.test.ts` - nullable ids/scopes, external inventory.
  - `test/skill-sources-http.test.ts` (new) - CRUD, token write-only, sync/check/pin, auth/CSRF,
    redaction, force-join (A21).
  - `test/skill-sources.test.ts` - A3 repeated identical content reuses the snapshot row without a
    duplicate; A10 missing/corrupt active snapshot fails closed and disable-to-start works; A18
    each quarantine trigger; orphaned `syncing` startup recovery.
  - `npm run typecheck:ui`, `npm run test:e2e` for the skills/settings route.

Acceptance: design A11, A14, A17, A19.

## Phase 6 - Hardening, docs, record, commit

Work:

- Security hardening: URL/DNS checks, no redirects with token, log/error redaction, response caps,
  disk/free-space caps, GC, retention, symlink/path tests.
- Confirm source hard delete removes the source row (credentials cascade, fork provenance SET NULL),
  marks its snapshots `superseded`, and keeps snapshot/index rows and blobs for the retention floor;
  disable clears active/pinned pointers and sets `disabled_at`; re-enable syncs; GC treats a
  snapshot as active only while an enabled, non-deleted source references it and deletes only
  unreferenced blobs.
- Docs: `docs/current-state.md` skills section **and schema-version list `[1..24]`**,
  `docs/conventions.md` if runtime layout is described, design status + review record,
  `docs/decisions/0018-external-skill-sources.md`, `docs/journal/0044-external-skill-sources.md`,
  index updates, open questions. Update every schema-version fixture in the same commit.
- Verification: run every command below; fix regressions; run `check:sensitive`.
- Commit: one coherent commit `feat(skills): add external skill sources` (or repo-appropriate
  Conventional Commit) including code, tests, docs, and record. No hub URL/token/host in tracked
  files.

## Test matrix

| Area | Tests |
|---|---|
| Migration/backfill | v23 -> v24, columns/tables, references -> skill_files, digest backfill, twice no-op |
| Local files | text/binary, nested, limits, traversal, symlink, case/prefix collision, legacy fallback, override copy, `references` partial update preserves binary/over-limit reference-shaped files, occupied-path `file_path_conflict` |
| Materializer | staging/swap, SKILL.md last, verbatim external, first deploy, probe/apply parity |
| Hub client | 200/304/401/429/500/timeout/redirect/malformed, auth header, ETag, caps |
| Sync | snapshot publish, 304 no-op, A3 identical-content repeat reuses the row, revision-only reuse, deletion guard/force, A18 each quarantine trigger, pin, GC, blob repair, single-flight, A21 force-join, hard-delete retention, disable/re-enable aging, A10 missing/corrupt snapshot fail-closed + disable-to-start, orphaned `syncing` recovery |
| Resolution | local-wins matrix, two sources, shadowed external, tombstone, quarantined fallback |
| Hash/restart | legacy stability, first file/external switch, revision-only no restart, capture consistency (effective+disabled collisions, shadowed winner), NULL applied hash, `skills_changed` vs `settings_changed` |
| API/UI | source CRUD/token/sync/check/pin, external read-only drawer, nullable href/primaryId, A17 fork + target conflict, warning text, settings sources props, CSRF/auth, 413 oversized files body |
| Security | token redaction, insecure HTTP flag, link-local rejection, path/SSRF tests |

## Rollout and backward compatibility

- Migration 24 is additive; `skill_references` is kept and dual-written.
- No-source installs keep the legacy hash and are not marked restart-required on upgrade.
- Adding the first external winner or the first non-legacy managed file changes the hash once.
- A source is disabled by default; no network fetch occurs until the operator creates and enables
  one.
- A source hard delete retains snapshot/index rows and blobs for the retention floor so in-flight
  launches do not break.
- If the UI phase has to be split, the API and materialization still deliver the feature; record the
  UI remainder as a follow-up stage. Do not silently drop it.

## Risks and mitigations

| Risk | Mitigation |
|---|---|
| Large surface / regressions | Phase boundaries; existing skill tests must stay green; add new tests per phase |
| Snapshot/hash mismatch | Single capture per launch; probe/apply use captured bundles; tests for publish/managed edit/hard delete between probe and apply |
| Migration rollback data loss | Dual-write + idempotent `reconcileSkillFiles`; rollback -> re-upgrade test |
| Hub unavailable | LKG snapshot; non-blocking sync; app starts with managed skills |
| Malicious paths/content | Strict path validation, symlink refusal, size caps, quarantine, credential deny list |
| Token leakage | Sealed at rest, write-only API, redaction, no redirects, HTTP opt-in |
| Disk growth | CAS dedupe, per-source/skill/snapshot caps, retention floor, GC |

## Verification commands

```bash
npm run lint
npm run typecheck
npm run typecheck:ui
npm test
npm run build
npm run check:sensitive
npm run test:e2e
```

## Exit criteria

- All design acceptance criteria A1-A22 are covered by tests or explicit manual evidence.
- The plan's phases are complete; no phase is silently skipped or absorbed.
- The stage record and indexes are written; the commit contains only the stage's files.
