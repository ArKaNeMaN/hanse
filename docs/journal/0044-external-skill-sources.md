# 0044 - External skill sources

- Stage: `0037-external-skill-sources`
- Design: [`docs/design/external-skill-sources.md`](../design/external-skill-sources.md)
  (`oracle` round 6 PASS after five revision rounds)
- Plan: [`docs/plans/0037-external-skill-sources.md`](../plans/0037-external-skill-sources.md)
  (`momus` round 3 PASS)
- Decision: [`docs/decisions/0018-external-skill-sources.md`](../decisions/0018-external-skill-sources.md)

## Context

The operator runs a self-hosted `skills-hub` instance on the LAN and wants it to be an additional
source of skills shared by every application, while local managed skills remain authoritative. The
hub exposes an HTTP manifest plus per-file downloads; git is internal to the hub. The existing skill
registry already has scopes, tombstones, deterministic materialization, and restart hashing, but no
external source, no arbitrary files, and no provenance.

## Implemented

- Migration v24: `skill_files`, `skill_sources`, `skill_source_credentials`,
  `skill_source_snapshots`, `skill_source_skills`, `skills.origin`/forked provenance, and
  `instances.applied_skills_hash`. It backfills legacy references into `skill_files` and does not
  change the `scope` CHECK.
- Local arbitrary files: `files` create/update payloads (`text` or `base64`, `executable`), full
  replacement, `references` as a partial replacement of the legacy projection, full-file `override`
  copy, byte-level materialization, and an idempotent `reconcileSkillFiles` startup merge.
- Materializer v2: sibling staging directory, fsync, atomic swap, `SKILL.md` last, verbatim external
  bundles, synthesized managed bundles, preserved marker/`skills-replaced/`/legacy alias behavior.
- `src/skill-sources/`: content-addressed cache, `skills-hub` HTTP adapter, source sync with
  ETag/304, immutable snapshots, deletion guard, per-skill quarantine, pinning, background loop,
  sealed write-only credentials, retention/GC, and policy-restricted source management.
- `CompositeSkillSource`: local-wins precedence, external conflict/quarantine/stale warnings,
  launch capture, exact-byte composite hash, legacy managed-only hash compatibility, and per-app
  materialization.
- Manager/CLI: one capture per launch, `applied_skills_hash`, `skills_changed` vs `settings_changed`,
  `openCoordinatorDatabase` (migrations + reconcile), source-loop start/stop, and coordinator
  wiring.
- Human-only `/api/skill-sources*` API: source CRUD, token set/clear, sync/check, pin/unpin,
  enable/disable, delete, skill listing. The Vue source page and external inventory drawer are a
  follow-up; the API is usable now.

## Verification

- `npm run typecheck`, `npm run typecheck:ui`, `npm run lint`: pass.
- Server suite: `174` files, `3096` tests pass.
- New tests: `test/skill-sources.test.ts` (sync/304/quarantine/deletion guard/pin/local-wins/blob
  repair), `test/skill-sources-http.test.ts` (human-only CRUD, write-only token, cross-site, sync
  failure mapping), `test/skill-files.test.ts` (arbitrary files, partial references update,
  override, reconcile, legacy/composite hash).
- Live smoke against the operator's hub (URL and token kept out of tracked files): one snapshot with
  14 skills, revision `925cb7afebf1`, 661,268 bytes, active records for all 14 skills, and
  `developer` files `SKILL.md` plus three references.
- `npm run build`, `check:sensitive`, and `test:e2e` are part of the stage gate; see the commit
  record for the final results.

## Deferred / open threads

- Vue source-management page (global settings section) and external rows/drawer in the skills
  inventory. The human API is available; the inventory still shows managed rows only.
- Local arbitrary-file text editor and binary upload UI (the text/base64 API and byte-level
  materialization are implemented; the existing Vue editor still edits only the legacy references).
- Git-backed sources, project/app-scoped sources, per-app source opt-out, historical revision fetch
  (pin only freezes the cached snapshot), and an approval queue.
- The hub itself must be reachable and the operator must keep its token available for sync.

## Rollout notes

- No-source, reference-only installs keep the legacy managed hash and are not marked
  restart-required by the upgrade.
- Adding the first external winner or the first non-legacy local file changes the effective hash
  once.
- Source hard delete keeps snapshot/index rows and blobs for the 24-hour retention floor; a pinned
  snapshot is not a backup.
