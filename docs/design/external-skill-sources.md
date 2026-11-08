# Design - External skill sources (skills hub)

Status: **approved** - `oracle` round 6 **PASS** (2026-11-07), revision 6. Backend/API implemented
(journal 0044); Vue source page, external inventory drawer, arbitrary-file text editor, and binary
upload UI deferred.
Scope: a global, operator-managed registry of external skill sources, a first adapter for the
`skills-hub` HTTP manifest protocol, a content-addressed cache with immutable snapshots, a thin
coordinator-DB index, composite resolution that keeps local managed skills authoritative, per-app
materialization of external skill bytes, and arbitrary per-skill files.
Out of scope: implementation in this document; git-backed sources; project/app-scoped sources;
agent-authored sources; hot reload; hub-side changes; a multi-coordinator deployment; an approval
queue for changed external content.

Owner decisions already taken:

- Storage/caching: **variant B** - content-addressed cache plus a thin DB index; per-app
  materialization; no import of external bytes into `skills`.
- Mixing: **variant A** - local managed skills always win:
  `app > project > global > external sources (by priority)`.

## 1. Problem

Hanse stores managed skills in the coordinator DB and materializes them into each isolated
application's `opencode` config root. Sharing a skill between applications therefore means creating
it at global scope or duplicating it per project/application. The owner now runs a self-hosted
`skills-hub` instance on the LAN with the base role skills, and wants Hanse to consume it as a
source so a skill is updated once in the hub and reaches every application, while local managed
skills remain a valid override.

The hub is not a catalog repository: it is an HTTP distribution service backed by one git working
tree per bucket. Its public client contract is a manifest plus per-file downloads. Consuming it as
a Hanse skill source is therefore a new provider layer, not a repository import.

## 2. Requirements

| ID | Requirement |
| --- | --- |
| ES1 | An operator can create, edit, enable/disable, and delete a global external skill source. A source has a kind, display name, base URL, bucket list, priority, sync interval, stale threshold, and an optional pinned snapshot. |
| ES2 | A source credential is write-only: stored sealed at rest, never returned by an API, never logged, and never placed in a URL. |
| ES3 | Sync is pull-only. Hanse never writes to the hub and never requires the hub to push. |
| ES4 | A sync publishes immutable snapshots atomically. Resolution and materialization observe exactly one active snapshot per source. |
| ES5 | Deletion is derived only from a fully successful full manifest. A timeout, a non-200 response, a missing bucket, or a partial file fetch never deletes a skill. |
| ES6 | Local managed skills always win: `app > project > global > external sources ordered by priority, then slug`. A disabled managed row is a tombstone that hides external skills too. |
| ES7 | External `SKILL.md` bytes are materialized verbatim. Managed `SKILL.md` remains synthesized. |
| ES8 | A skill bundle may contain arbitrary relative files, not only `SKILL.md` plus `references/*.md`. Binary files are allowed. |
| ES9 | The shared source of truth for external bytes lives once in a content-addressed cache under coordinator state. The coordinator DB stores source configuration and a bounded index, never external file bytes. Each application receives its own materialized copy. |
| ES10 | Hanse does not point `opencode` at a shared writable path and does not add a shared mount. |
| ES11 | Hub downtime or a failed sync never blocks an application start. The last known good snapshot remains effective. |
| ES12 | A missing or corrupt active snapshot fails materialization closed; the operator can disable the source to start without it. Hanse never silently starts with a partially materialized external set. A per-skill quarantine is an explicit, warned degraded state, not a partial materialization. |
| ES13 | A change to the effective materialized bytes marks every affected application restart-required. Hanse never restarts an agent silently. |
| ES14 | The external composite hash is versioned and derived from the exact materialized bytes (including the synthesized or verbatim `SKILL.md` digest). Managed-only installations keep the legacy hash. The hash excludes revision, ETag, timestamps, sync state, and source identity. |
| ES15 | Sources are global and operator-only. No agent MCP tool can create, edit, trigger, or read a source or its token. Agent MCP tools continue to see managed skills only. |
| ES16 | The feature adds no runtime dependency and stays on Node 20.19 / TypeScript ESM / SQLite / Vue 3. |
| ES17 | Existing installations with no active external source keep their current resolution, materialization, hash, and restart behavior. Adding the first external winner changes the effective hash exactly once. |
| ES18 | Arbitrary local skill files are stored in a new `skill_files` table. `skill_references` remains readable and is dual-written for one release; it is not dropped in this stage. |
| ES19 | The UI exposes source state, revision, last success, errors, skill count, bytes, sync/check/pin actions, and external read-only badges. |
| ES20 | The design is provider-agnostic: the sync engine consumes a normalized snapshot. `skills-hub` is the first adapter, not a core dependency. |

## 3. Verified facts

### 3.1 Hub public client contract

- `GET /api/v1/manifest?buckets=a,b` returns `schemaVersion: 1`, `generatedAt`, and buckets with
  `slug`, `name`, `revision`, and skills. A skill has `name`, `description`, optional free-form
  `version`, `contentHash`, and `files: [{path, sha256, size}]`.
- `GET /api/v1/skills/:bucket/:name/files/*path` returns the exact file bytes, content type, and a
  strong `ETag: "sha256:<hex>"`.
- `GET /api/v1/buckets` returns accessible buckets with `revision` and `skillCount`.
- Authentication is `Authorization: Bearer <token>`; a missing or invalid token is a
  `401 application/problem+json`. The manifest supports `If-None-Match` and answers `304`.
- The hub is push-only: it has no clone/fetch/pull endpoint and no revision-addressed manifest.
- The hub's `version` is a free-form frontmatter string, not semver. The live instance currently
  sets no `version` on any skill, so `contentHash` and per-file `sha256` are the update signals.
- The hub permits arbitrary nested files in a skill directory. The live instance currently uses
  only `SKILL.md` and `references/*.md`, so arbitrary-file support is forward-looking but required.

### 3.2 Live instance observation

- The operator-provided instance is reachable over the LAN and reports `0.0.5` on `/health`.
- One bucket, `default`, revision `925cb7afebf1`, 14 skills.
- Manifest ETag and `If-None-Match` -> `304` work.
- Every skill resolves to `SKILL.md` plus zero or more `references/*.md`; two skills are new
  relative to the local set (`examples-to-rules`, `wsl-windows-interop`).
- The token used for verification is operator-provided, read-only in this work, and is not recorded
  in this document or in the repository.

### 3.3 Current Hanse behavior

- `SkillService implements SkillSource`; `resolve`, `preview`, `hash`, `probe`, and `apply` are
  synchronous and read the coordinator DB.
- Precedence is `SCOPE_RANK = { global: 0, project: 1, app: 2 }`; the narrowest valid enabled row
  wins; a disabled narrower row is a tombstone.
- `rebuildSkills()` writes to `<XDG_CONFIG_HOME>/opencode/skills/<name>/SKILL.md` and
  `references/`, removes stale entries, preserves the first deploy, and writes `SKILL.md` last.
- `settingsHashFor()` includes the effective skills hash, which drives `pendingRestart`. Changes
  only mark an app restart-required; no auto-restart exists.
- `skills` has no provenance columns. `skill_references` is restricted to a flat
  `references/<slug>.md` path, Markdown only.
- `OpencodeOverlay` has no `skills` field. `opencode` 1.19.x supports `skills.paths`, but Hanse
  does not use it and this design does not add it.
- Migration 23 is the current schema head; migrations are forward-only, versioned, and each runs in
  one transaction with `foreign_keys = ON`.

## 4. Decisions

### D1 - External skills are a provider layer, not `skills` rows

External skills are not inserted into `skills` and do not get a new `scope`. The existing scope
CHECK, unique key, tombstone logic, and managed CRUD stay unchanged. A composite `SkillSource`
merges the managed layers with the active external layer.

Why: importing external skills into `skills` makes hub updates fight local edits, makes deletion and
override ambiguous, and cannot represent provenance or immutable snapshots cleanly.

### D2 - Local wins, sources sit below global

Resolution order, narrowest to widest:

1. `app` managed rows.
2. `project` managed rows.
3. `global` managed rows.
4. external source with the lowest `priority` value.
5. the next source, and so on.

A disabled managed row at any scope is a tombstone and hides all wider layers, including every
external source. Managed rows with stored issues are skipped, preserving current fallback. A
quarantined external skill is absent at its layer and resolution continues wider with a warning.

Why: enabling a source must not silently change the behavior of existing applications. A hub that
should replace current global skills is adopted explicitly: the operator deletes or tombstones the
local rows, and the UI shows which local rows shadow hub skills.

### D3 - Content-addressed cache + thin DB index + per-app materialization

External bytes live under `<XDG_STATE_HOME>/hanse/skill-sources/` in a content-addressed store.
The coordinator DB stores source configuration, credentials, immutable snapshot metadata, and a
bounded per-skill index (`files_json`). It never stores external file bytes.

`SkillSourceService` owns sync and the cache. `ExternalSkillSource` reads the active snapshot index
synchronously. `CompositeSkillSource` implements the existing `SkillSource` contract and merges the
managed and external layers. `rebuildSkills()` remains the only writer into each application's
`$XDG_CONFIG_HOME/opencode/skills`.

Why: resolution and restart hashing are synchronous hot paths. A disk-only resolver would make every
status request depend on file I/O; a DB-only store would duplicate bytes and lose content
addressing.

### D4 - No `skills.paths` and no shared mount

Hanse does not add a `skills` field to `OpencodeOverlay` and does not mount a shared cache into app
containers. Apps receive copies through the existing materializer.

Why: a shared writable mount weakens per-app isolation, bypasses the effective hash and tombstone
logic, and lets one application contaminate every other. A read-only shared mount would still
bypass collision and restart accounting.

### D5 - External `SKILL.md` is verbatim; managed `SKILL.md` is synthesized

Managed bundles keep `buildSkillDocument()`. External bundles are written byte-for-byte from the
verified cache, including `SKILL.md`. Sync validates the external frontmatter (`name`,
`description`, and `name` equals the manifest name) but never rewrites it.

Why: rewriting external frontmatter would change the hub's `contentHash`, discard arbitrary
frontmatter, and make byte-level verification meaningless.

### D6 - Arbitrary files are bytes, stored once for local and per snapshot for external

Local skills gain
`skill_files(skill_id, path, content BLOB, encoding, executable, sha256, size)`. `sha256` and
`size` are computed on write so the effective hash never re-reads BLOBs on the hot path. External
skills use the snapshot `files_json` plus the CAS. `SKILL.md` is reserved at the top level:

- managed: exactly one synthesized top-level `SKILL.md`, never present in `skill_files`;
- external: exactly one top-level `SKILL.md`, included in the file list and written last.

`skill_files` is canonical for new code. `SkillService.create`, `update`, and `override` dual-write
the legacy `skill_references` rows for files whose path matches `references/<slug>.md`, whose bytes
are valid UTF-8 text, and whose text fits the legacy limits. `override` copies the full source
`skill_files` set (except the synthesized `SKILL.md`) and then dual-writes legacy references, so
arbitrary and binary files survive an override. Arbitrary and binary files exist only in
`skill_files`. Reads prefer `skill_files`; a skill with no `skill_files` rows falls back to
`skill_references` for rollback compatibility.

An idempotent `reconcileSkillFiles(db)` runs after `runMigrations` in every process that opens the
coordinator DB and can read skills (`serve` and the internal MCP command; centralize this in a
shared `openCoordinatorDatabase()` helper so no entry point forgets it). It compares each legacy
`skill_references` row with its `skill_files` row by content hash and upserts the `skill_files` row
when missing or different, then fills any missing `sha256`/`size`. This handles both the v24
backfill and a rollback -> re-upgrade cycle where the old image edited only `skill_references`. It
never deletes arbitrary files. `skill_files` carries `updated_at` for diagnostics. This makes a
rollback image see post-upgrade text edits and deletions, and a later re-upgrade sees the old
image's text edits; new arbitrary files remain invisible to the old image, which is documented and
expected. A deletion made only in a rolled-back image is intentionally not propagated and is
recorded as an accepted limitation (resurrection is safer than deleting arbitrary files).

The API accepts `files: [{ path, text?, base64?, executable? }]` with exactly one of `text` or
`base64`, or the legacy `references: [{ path, content }]`; the two forms are mutually exclusive in
one payload. `files` is a full replacement of the entire local file set. `references` is a
**partial replacement of only the legacy projection set**: the `references/<slug>.md` paths that
are represented in `skill_references` and pass the legacy UTF-8/limit rules. It adds, updates, and
deletes only `skill_files` rows in that set; every other `skill_files` row — including binary or
over-limit files whose path happens to start with `references/` — is preserved. An ordinary UI save
therefore cannot silently drop arbitrary or binary files. Adding a `references` path that is
already occupied by a non-projection `skill_files` row (for example a binary
`references/x.md`) is rejected with `file_path_conflict`; it never overwrites the existing file.
Responses expose `files` with `encoding` and either `text` or `base64`, plus the legacy
`references` projection for compatibility. A16 covers this preservation precisely.

Path rules apply at sync, at write, and again at materialize: relative POSIX paths only; reject
absolute paths, drive letters, backslashes, empty/`.`/`..` segments, control characters, trailing
slashes, non-NFC paths, depth > 16, segment > 255 bytes, total > 1024 bytes; reject case-insensitive
duplicates and prefix conflicts (`a` and `a/b`); reject symlinks. Limits: `SKILL.md` 48 KiB, other
files 1 MiB each, 100 files and 8 MiB per bundle. Binary content is allowed. The legacy
`skill_references` limits remain only for the legacy projection.

The materializer builds each skill in a sibling staging directory, writes every file, fsyncs the
files and the directory, then swaps it into place (rename the old directory aside, rename staging
in, delete the old). `SKILL.md` is written last inside staging. A crash cannot leave a discoverable
partial skill. The marker, `skills-replaced/` first-deploy preservation, and the legacy `skill/`
alias cleanup are preserved.

### D7 - Sync lifecycle, snapshots, deletion guards, pinning

Triggers:

1. Coordinator startup: load the active snapshot index from the DB immediately; schedule a
   staggered non-blocking sync (0-30 s). Never await it during startup.
2. Periodic: per-source interval, default 15 minutes, with jitter and exponential backoff capped at
   1 hour. A single `setInterval(...).unref()` loop with per-source single-flight is sufficient.
3. Manual: "Sync now" / "Check for updates".
4. Application start: never fetch synchronously. Use the current active snapshot. An optional
   async freshness check may run; the resulting hash change only marks the app restart-required.

One sync:

1. Conditional `GET /api/v1/manifest` with the stored ETag, only when URL, bucket list, mode, and
   token are unchanged. A token change invalidates the ETag. On `304`, update
   `last_checked_at`/`last_success_at`; change no snapshot. If the active snapshot is missing or
   fails integrity, ignore `304` and force a full GET.
2. On `200`, validate the manifest envelope: `schemaVersion === 1`, the exact requested/returned
   bucket set, no missing requested bucket, manifest counts/sizes within caps, and no duplicate
   exact `(bucket, name)`. A **sync-fatal** failure rejects the whole sync and keeps the last known
   good snapshot: HTTP/auth error, non-200/304, malformed JSON, wrong schema version, bucket-set
   mismatch, missing requested bucket, duplicate exact `(bucket, name)`, manifest cap breach, file
   fetch/hash failure, or CAS write failure.
3. A **per-skill** failure quarantines only that skill: invalid Hanse name, missing or invalid
   `SKILL.md` frontmatter, frontmatter name not equal to the manifest name, unsafe path, oversized
   file, or a case-insensitive duplicate against another skill (the later skill in canonical name
   order is quarantined). The snapshot still publishes the remaining skills and the source becomes
   `degraded`. A quarantined skill is recorded with `state='quarantined'`, an error code, and a
   warning; it is not a deletion and does not trip the deletion guard.
4. Fetch missing blobs into staging, enforcing caps while streaming and verifying `sha256` and size.
   Reuse existing blobs only after verifying them. A corrupt blob is moved to `trash/blobs/` under
   the source lock, re-fetched to a temporary file, verified, and atomically renamed into the CAS.
   A valid blob is never overwritten.
5. Write the normalized snapshot manifest, fsync the file and its parent directory, then publish in
   one DB transaction: insert the snapshot and index rows, mark the previous snapshot `superseded`,
   update the source's active snapshot, revision, ETag, and success timestamps.
6. On any failure before publish, keep the previous active snapshot, record the error, delete
   staging, and leave CAS orphan cleanup to the GC.

**Snapshot identity.** `skill_sources.id` is a random UUID generated at create and never reused; a
re-created source gets a new id, so retained snapshots cannot be resurrected by id reuse.
`manifest_sha256` is computed over a canonical content projection: bucket slugs/names, skill
names/descriptions/versions, and file path/sha256/size. It excludes `generatedAt`, bucket
`revision`, skill `contentHash` as a separate field, and the response `etag`.
`id = sha256(source_id + "\0" + manifest_sha256)` hex, so two sources with identical content cannot
collide and the cache path stays per source. A repeat sync with the same source and content reuses
the existing snapshot row: if it is `superseded`, mark it `active` again; never insert a duplicate.
The latest `revision` and `etag` live on the source row; the snapshot row keeps the values observed
when it was first published as display metadata. A revision-only bump therefore reuses the same
snapshot and does not change the effective hash.

**Deletion guard.** Deletion is applied only from a fully successful `200` manifest. The guard trips
when the new snapshot would remove more than `max(3, ceil(previous_count * 0.20))` skills, or when a
previously non-empty source returns zero skills. A missing requested bucket is a sync-fatal
manifest error, not a deletion. On a guard trip, keep the last known good snapshot, record
`deletion_guard`, and require an explicit `force=1`. `force` bypasses the deletion guard and the
ETag (forcing a full GET) but never bypasses manifest validation or file verification. The first
sync has no previous snapshot and therefore no guard.

**Pinning.** `mode='pinned'` freezes the currently active snapshot: sync still fetches the manifest
and records `last_checked_at`/`last_error`, but it publishes no new active snapshot while pinned.
`active_snapshot_id` remains the pinned snapshot; `pinned_snapshot_id` records it. `unpin` restores
`mode='track'` and triggers a sync. The hub cannot serve arbitrary revisions; Hanse does not pretend
otherwise. A pinned snapshot and its blobs are retained until unpinned or deleted.

**Disable.** Disabling a source sets `enabled=0`, clears `active_snapshot_id` and
`pinned_snapshot_id`, sets a `disabled_at` timestamp, and leaves its cache/snapshot rows for the
retention floor. Re-enabling sets `enabled=1`, clears `disabled_at`, and triggers a sync; if the
retained snapshot is still on disk it is reused, otherwise the next successful sync rebuilds it. A
disabled source contributes no external layer.

**Retention.** A snapshot is **active** only while an enabled, non-deleted source row references it
through `active_snapshot_id` or `pinned_snapshot_id`; `state='active'` alone is not sufficient.
Disabled sources have no active/pinned pointer (see Disable), so their snapshots age out after the
floor. GC deletes snapshots that are not active, not pinned, not in-flight, and older than the
retention floor (24 hours), then deletes blobs referenced by no retained snapshot; if a captured
launch still needs a blob, its snapshot is retained by the floor. A source hard delete marks its
snapshots `superseded` and retains its cache **and its snapshot/index rows** for the same floor so a
captured launch can still materialize; after the floor they become eligible.

The source row delete does not delete snapshot rows. `skill_source_snapshots.source_id` and
`skill_source_skills.source_id` are denormalized **with no foreign key at all** (not a non-cascading
FK, which `foreign_keys=ON` would enforce); only `skill_source_skills.snapshot_id` references
`skill_source_snapshots(id)` `ON DELETE CASCADE`. `skill_source_credentials.source_id` cascades on
source delete, and `skills.forked_from_source_id` is `ON DELETE SET NULL`.

### D8 - Legacy-compatible managed hash, exact-byte composite hash, launch capture

`SkillSource.hash()` keeps its existing contract: `string | undefined`, with `undefined` exactly
when the effective set is empty.

- **Legacy-compatible managed set:** use the existing legacy `effectiveHash` projection unchanged
  (name, description, content, non-empty license/compatibility/metadata, path-sorted reference
  paths and contents) only when there is **no external winner** and every managed winner's files
  are exactly the dual-written legacy references (every `skill_files.path` matches
  `references/<slug>.md`, `encoding='utf8'`, `executable=0`, and the set equals the legacy
  `skill_references` rows). No-source, reference-only installations therefore keep their exact
  current hash and do not restart on upgrade.
- **Any external winner, or any managed winner with a non-legacy file:** compute
  `hashValue({ version: 2, skills: [...] })` where each winner is represented by `{ name, files:
  [{ path, sha256, size }] }` for **both** modes. `SKILL.md` is the digest of the exact synthesized
  (`buildSkillDocument`) or verbatim bytes; `executable` is included in the managed file digest
  projection. Sort by name, then path. `mode`, source id/slug, priority, bucket, revision, ETag,
  `generatedAt`, `last_success_at`, sync state, and quarantine state are excluded. Adding the first
  arbitrary local file or the first external winner changes the hash once; removing the last one
  returns to the legacy hash and changes it once.
- **Empty set:** `undefined` in both modes. A revision-only change does not restart. Two external
  sources swapping identical bytes do not restart.

**Launch capture.** The `SkillSource` contract gains an explicit launch-scoped capture. It freezes
the **complete** effective generation, managed and external, not only snapshot ids:

```ts
export interface SkillCapture {
  readonly hash: string | undefined;
  readonly capturedAt: string;
  /** Full resolved view for the target: scope, effective winners, rows, disabled, warnings. */
  readonly resolved: ResolvedSkills;
  readonly managed: readonly EffectiveBundle[];      // managed rows + file bytes and digests
  readonly external: readonly ExternalBundleDescriptor[];
}

export interface ExternalBundleDescriptor {
  sourceId: string;
  sourceName: string;
  bucket: string;
  revision: string;
  snapshotId: string;
  name: string;
  description: string;
  files: readonly { path: string; sha256: string; size: number }[];
}

capture(target: SkillTarget): SkillCapture;
resolve(target, capture?: SkillCapture): ResolvedSkills;
preview(target, options, capture?: SkillCapture): SkillPreview;
hash(target, capture?: SkillCapture): string | undefined;
probe(target, xdgConfigHome, options, capture?: SkillCapture): SkillMaterializeResult;
apply(target, xdgConfigHome, options, capture?: SkillCapture): SkillMaterializeResult;
```

`capture()` reads managed rows, the full `skill_files` rows (bytes and digests), and the active
external snapshot/index rows in one SQLite read transaction. It computes the full `ResolvedSkills`
(scope, effective winners, rows, disabled tombstones, warnings) once, then derives `managed` and
`external` **as projections of the same `resolved.effective` winner list**, and computes the hash
from that same list. `resolve(target, capture)` returns `capture.resolved`; `preview` uses it and
scans collisions from `capture.resolved.effective` **and** `capture.resolved.disabled`;
`probe`/`apply` materialize the captured managed bundles, resolve external file bytes through the
captured snapshot ids, and derive collision warnings from the same effective+disabled pair. The
captured managed bundles carry the bytes needed to materialize; external descriptors carry digests
resolved through the CAS. The manager calls `capture()` once per launch, passes the same capture to
`probe` and `apply`, and uses `capture.hash` for `settingsHashFor` and
`instances.applied_skills_hash`. A managed edit, a publish, or a source hard delete between probe
and apply cannot change the captured generation, collision warnings, or the hash, and the retention
floor keeps those snapshot/index rows and blobs alive. `pendingRestart` calls `hash()` without a
capture to compare the current generation with the applied one.

`instances.applied_skills_hash` distinguishes `skills_changed` from `settings_changed`. The
algorithm is explicit:

- Unknown state only when `applied_profile` is absent, or when **both**
  `applied_settings_hash` and `applied_skills_hash` are absent.
- If `applied_skills_hash` is NULL (an install upgraded from before v24), skip the skills
  comparison and compare the combined `settingsHashFor(..., currentSkillsHash, ...)` with
  `applied_settings_hash`. This is the only check; it preserves the no-restart-on-upgrade behavior
  for no-source legacy installs.
- If `applied_skills_hash` is present, compute
  `settingsHashFor(..., appliedSkillsHash, ...)` (the non-skills settings projection with the
  applied skills hash) and compare it with `applied_settings_hash`. If it differs, report
  `settings_changed`. Report `skills_changed` only when the non-skills projection matches and
  `applied_skills_hash !== currentSkillsHash`. Never report both for a skills-only change.

Add `skills_changed` to `settingsRestartReason()` and the settings UI reason map. This keeps
`settingsHashFor` embedding the skills hash for compatibility while separating the reasons
correctly.

### D9 - Credentials are sealed JSON, not settings and not env

`skill_source_credentials(source_id, cipher, nonce, meta_json, created_at, updated_at, updated_by)`
stores a sealed JSON object, using the existing AES-256-GCM `seal()`/`open()` helpers and the
coordinator `secret.key`. The first adapter seals `{ "token": "..." }`. The API accepts a token
write-only and returns only `token_set: true`. `Authorization` headers, query strings, and error
bodies are redacted from logs and events.

Why: `setting_secrets` already proves the pattern; a dedicated table keeps source rows non-secret
and lets future providers seal different credential shapes. The coordinator DB and `secret.key` are
outside every app mount.

### D10 - Additive migration, no dropped tables, dual-write transition

Migration 24 adds `skill_files`, the source tables, provenance columns on `skills`, and
`instances.applied_skills_hash`. It creates `skill_sources` before adding the
`forked_from_source_id` reference, backfills `skill_references` into `skill_files` with
`CAST(content AS BLOB)` and `encoding='utf8'`, and computes `sha256`/`size` in an idempotent
application-level backfill after the migration (SQL cannot compute SHA-256). No `scope` CHECK
change.

`skill_files` is canonical for new code; `skill_references` is dual-written for the transition as
described in D6. `skill_references` is not dropped in this stage. A rollback image therefore sees
post-upgrade text edits and deletions; it does not see new arbitrary files, which is documented and
expected. Do not remove the legacy table until a later release has proven zero references.

### D11 - Conflict, fork, and deletion policy

| Situation | Result |
| --- | --- |
| Same name in a managed row and a source | Managed row wins; UI shows "shadowed by local" |
| Two sources, same name | Lower `priority` wins; tie-break `slug`; loser is marked shadowed |
| Hub deletes a skill | It disappears from the next published snapshot; a local row, if present, becomes the winner |
| Local override of a hub skill | Create a managed row at any scope; because sources are below global, it always wins |
| Global kill switch | A disabled global managed row hides the hub skill for every app |
| Edit a hub skill | "Fork to local": create a managed row with `origin='forked'` and `forked_from_*` provenance |
| Source disabled/deleted | Its layer disappears; managed skills remain; the cache is retained briefly for re-enable |

### D12 - Offline and degraded behavior

With an active snapshot, hub downtime only makes the source `stale`; apps keep working and no hash
changes. With no snapshot, external skills are absent, apps start with managed skills, and the UI
shows `never_synced`. A missing or corrupt active snapshot fails materialization closed; the
operator can disable the source to start without it. Hanse never starts with a partial external set.

## 5. Data model

Logical model only; physical DDL and migration mechanics live in the plan.

### 5.1 Tables

| Table / column | Purpose |
| --- | --- |
| `skill_files(skill_id, path, content BLOB, encoding, executable, sha256, size, updated_at)` | Generic local file tree. FK `skill_id` -> `skills(id)` `ON DELETE CASCADE`; PK `(skill_id, path)`; `sha256`/`size` computed on write; `updated_at` supports the startup reconcile. |
| `skills.origin` | `local` or `forked`; default `local`. |
| `skills.forked_from_source_id`, `forked_from_name`, `forked_from_revision` | Provenance for forks only; nullable. `forked_from_source_id` references `skill_sources(id)` `ON DELETE SET NULL`. |
| `skill_sources` | `id` (random UUID, never reused), `slug` (unique), `name`, `kind`, `endpoint`, `config_json`, `priority`, `enabled`, `mode` (`track`/`pinned`), `sync_interval_sec`, `stale_after_sec`, `request_timeout_ms`, `active_snapshot_id`, `pinned_snapshot_id`, `disabled_at`, `last_attempt_at`, `last_success_at`, `last_checked_at`, `last_error_code`, `last_error_message`, `etag`, `revision`, `state` (`never_synced`/`syncing`/`ready`/`degraded`/`error`/`disabled`), timestamps, `updated_by`. |
| `skill_source_credentials` | `source_id` PK -> `skill_sources(id)` `ON DELETE CASCADE`, `cipher`, `nonce`, `meta_json`, timestamps, `updated_by`. |
| `skill_source_snapshots` | `id = sha256(source_id + "\0" + manifest_sha256)`, `source_id` denormalized **with no FK** (snapshots outlive a source for the retention floor), `revision`, `etag`, `manifest_sha256`, `bucket_set_json`, `skill_count`, `total_bytes`, `state` (`active`/`superseded`/`failed`), `fetched_at`, `published_at`, error fields. Index `(source_id, published_at)`. |
| `skill_source_skills` | `snapshot_id` -> `skill_source_snapshots(id)` `ON DELETE CASCADE`; `source_id` denormalized **with no FK**, indexed; `bucket`, `name`, `description`, `version`, `content_hash`, `skill_md_sha256`, `files_json`, `file_count`, `total_bytes`, `state` (`ok`/`quarantined`), error fields. PK `(snapshot_id, bucket, name)`; index `(snapshot_id, name)`. |
| `instances.applied_skills_hash` | Last composite hash applied to the instance, for a precise `skills_changed` reason. |

`files_json` is a bounded array of `{path, sha256, size}`. External bytes are not in the DB.

### 5.2 Cache layout

```text
<XDG_STATE_HOME>/hanse/skill-sources/
  blobs/sha256/<first2>/<hex>
  snapshots/<source-id>/<snapshot-id>/manifest.json
  tmp/<source-id>/<sync-id>/
  trash/
```

`blobs` are immutable. `snapshots` are immutable once published. `tmp` and `trash` are cleaned on
startup and after a publish. A snapshot manifest is the normalized provider snapshot, not the raw
hub JSON.

## 6. Interfaces

### 6.1 Skill types

```ts
export interface SkillFile {
  path: string;
  content: Uint8Array;
  sha256: string;
  size: number;
  executable?: boolean;
}

export interface SkillFileInput {
  path: string;
  text?: string;
  base64?: string;
  executable?: boolean;
}

export type SkillBundleMode = "managed" | "external";

export interface ExternalOrigin {
  sourceId: string;
  sourceName: string;
  bucket: string;
  revision: string;
  snapshotId: string;
}

export interface EffectiveBundle extends Omit<EffectiveSkill, "references"> {
  references: SkillReference[];
  /** Authoritative for external bundles; managed bundles synthesize SKILL.md. */
  files?: SkillFile[];
  mode: SkillBundleMode;
  origin: ExternalOrigin | null;
}

// Existing types change:
//   EffectiveSkill.id: number -> number | null
//   EffectiveSkill.source: SkillScope -> SkillScope | null
//   EffectiveSkill.shadows stays SkillScope[]; shadowedExternal: boolean is added
//   EffectiveSkill.mode: "managed" | "external"
//   EffectiveSkill.origin: ExternalOrigin | null
//   EffectiveSkill.externalKey: string | null  // `${sourceId}:${bucket}:${name}`
//   EffectiveSkill.fileCount: number
```

`SkillRow`, `SkillSummary`, and `SkillDetail` gain `origin: "local" | "forked"`,
`forkedFromSourceId`, `forkedFromName`, and `forkedFromRevision`. `SkillInput`/`SkillUpdate` gain
`files?: SkillFileInput[]` (full replacement; mutually exclusive with `references` in one payload).
`SkillDetail` gains `files` with `encoding` and `text` or `base64`. External effective entries have
`id: null`, `source: null`, and a stable `externalKey`. The inventory remains keyed by name.

Consumer migration is explicit:

- `src/http/props/skills.ts`: `SkillsInventoryRowProps` gains `mode`, `externalKey`, nullable
  `id`, `primaryId`, `href`, `scope`/`originScope`, and `fileCount`; `buildInventoryRows` branches
  on `mode` before computing `primaryId`/`href` (external rows get `primaryId=null` and a drawer
  command, never `/skills/null`); `warningText` gains the three new warning codes;
  `SkillWorkspaceProps` carries the fork provenance and a nullable managed id.
- `ui/skills-types.ts` and `ui/pages/SkillsPage.vue` / `SkillDetailPage.vue` /
  `SkillBundleEditor.vue`: nullable ids/`primaryId`/`href`, `mode`/`externalKey` badges, a
  read-only external drawer/panel, and the three new `SkillWarningProps.code` values. External
  rows open that drawer, not the numeric-id detail route. `SkillsPage.vue` uses a button/drawer
  trigger when `href` is null instead of binding `:to="row.href"`.
- `src/http/props/settings.ts` and `ui/pages/SettingsPage.vue`: add the global "Skill sources"
  section props and component (no new SPA route), plus `skills_changed` in the restart-reason map.
- `src/skills/tool-projection.ts`: make the nullable fields explicit; master/app tools only receive
  `SkillService` (managed) so external values do not reach agent MCP.
- `src/shared/routes.ts` and `ui/router.ts` need no new SPA route for external detail or sources;
  `src/http/spa.ts` gains the source props and the external drawer data endpoint if needed.

### 6.2 Provider adapter and sync engine

```ts
export interface SkillSnapshot {
  revision: string;
  etag: string | null;
  buckets: Array<{ slug: string; name: string }>;
  skills: Array<{
    bucket: string;
    name: string;
    description: string;
    version: string | null;
    contentHash: string;
    skillMdSha256: string;
    files: Array<{ path: string; sha256: string; size: number }>;
  }>;
}

export interface SkillProvider {
  readonly kind: string;
  fetchManifest(input: ProviderInput): Promise<SkillManifestResult>;
  fetchFile(input: ProviderFileInput): Promise<Uint8Array>;
}
```

`SkillProvider` is the seam. `HanseHubProvider` implements the hub contract. The sync engine owns
validation, CAS writes, snapshot publish, deletion guards, GC, and the source state machine; it does
not know hub-specific JSON beyond what the provider returns.

### 6.3 Source service and contract split

`SkillSourceService` exposes:

- `list()`, `get(id)`, `create()`, `update()`, `remove(id, { hard })`
- `setSecret(id, token)`, `clearSecret(id)`
- `sync(id, { force })`, `check(id)`, `pin(id)`, `unpin(id)`
- `status(id)`, `skills(id)`
- `activeRecords()` for the composite resolver
- `capture(target)` support data (active snapshot ids + index rows in one read transaction)
- `start()`, `stop()` for the background loop

The injection split is explicit:

- `SkillService` remains the managed CRUD store and the source used by the master/agent MCP tools.
- `CompositeSkillSource` implements `SkillSource` only, wraps `SkillService` + `SkillSourceService`,
  and is injected into `InstanceManager` and the human read paths.
- `HttpDeps` gains `effectiveSkills?: SkillSource` and `skillSources?: SkillSourceService`;
  `deps.skills` stays `SkillService` for managed mutations and master tools.
- `GET /api/skills`, `/api/ui/skills`, and the app skill workspace read `effectiveSkills` when
  present, otherwise `deps.skills`. External rows are read-only there.
- The master agent sees managed skills only; external skills are human/UI-only and materialized into
  agents. This preserves ES15.

`SkillService` exposes `capture(target)`/`resolve`/`preview`/`hash`/`probe`/`apply` with the
optional capture. `CompositeSkillSource.capture(target)` runs one SQLite read transaction over
managed rows, `skill_files`, and active external snapshot/index rows, and returns the full
`SkillCapture`: `resolved` (scope, effective winners, rows, disabled, warnings), managed bundles
with bytes, external descriptors, and hash. `managed`/`external` are projections of the same
`resolved.effective` winner list, and the hash uses that same list. `resolve`/`preview` can
return/use the captured resolved view; `probe`/`apply` use the captured bundles and scan collisions
from `resolved.effective` + `resolved.disabled`; a source hard delete cannot break them because
snapshot/index rows and blobs are retained for the floor.

`reconcileSkillFiles(db)` is an exported idempotent startup routine: it fills missing
`sha256`/`size`, merges legacy `skill_references` rows that differ from `skill_files` (rollback ->
re-upgrade), and never deletes arbitrary files. It runs after `runMigrations` and is safe to run on
every start.

The service is constructed once in `serveCommand` with the DB, `secret.key`, and the coordinator
state root. `CompositeSkillSource` is constructed there as well.

### 6.4 HTTP API

All routes are human-only and reject cross-site mutations like the existing settings/skills routes.

| Method and path | Purpose |
| --- | --- |
| `GET /api/skill-sources` | List sources with state, revision, counts, last success/error; no secrets |
| `POST /api/skill-sources` | Create a source; validate kind, endpoint, slug, buckets |
| `POST /api/skill-sources/:id` | Update mutable fields; invalidate ETag on endpoint/bucket/token change |
| `POST /api/skill-sources/:id/delete` | Soft-disable by default; explicit hard delete removes the source row, cascades its credential row, sets `forked_from_source_id` to NULL on forks, and marks its snapshots `superseded`. It never deletes `skill_source_snapshots` or `skill_source_skills`; those rows and their blobs are retained until the retention floor so a captured launch can still materialize. |
| `POST /api/skill-sources/:id/secret` | Write-only token replace; invalidates the ETag |
| `POST /api/skill-sources/:id/secret/clear` | Clear the token and invalidate the ETag |
| `POST /api/skill-sources/:id/sync` | `202`; joins an in-flight sync; accepts `force=1` |
| `POST /api/skill-sources/:id/check` | Fetch the manifest, report drift, publish nothing |
| `POST /api/skill-sources/:id/pin` / `unpin` | Freeze/unfreeze the cached snapshot |
| `GET /api/skill-sources/:id/skills` | Per-skill status, hashes, files, quarantine, shadowing |
| `GET /api/skill-sources/:id/skills/:bucket/:name` | External skill detail keyed by `(sourceId, bucket, name)` |
| `GET /api/skill-sources/:id/files?bucket=&name=&path=...` | Bounded text/base64 preview from the active snapshot |
| `POST /api/skills` with `action=fork` | Fork an external skill into a managed row at a target scope |

`GET /api/skills` and `GET /api/ui/skills` gain `mode`, `origin`, `externalKey`, `editable`, and
nullable `id`/`source` on effective rows. External rows are read-only in the existing skill
workspace; the only mutation is "Fork to local". The fork action parses the external `SKILL.md`
frontmatter (reusing the existing `yaml` dependency), extracts the body, copies every other file
into `skill_files`, sets `origin='forked'` plus `forked_from_*`, and rejects a name conflict at the
target scope.

### 6.5 UI

A "Skill sources" section on the global settings page (or a dedicated page linked from it) shows:
name, kind, endpoint (host only in the list), buckets, priority, enabled, mode, state, revision,
last success/check, skill count, bytes, and last error. Actions: create/edit, set token, sync,
check for updates, pin/unpin, disable/delete, view skills.

The existing skill inventory gains a source badge, `mode`/`origin` columns, and a read-only
external mode. External rows use `externalKey` and open a read-only external drawer/panel on the
inventory or sources page; they have no managed `id` and no numeric-id detail route. The managed
detail page shows the provenance cluster only for forked rows and the existing read-only state
(`form === null` / `editable === false`) is reused. A "Fork to local" action opens the normal create
form pre-filled from the parsed external frontmatter and files.

## 7. Sync state machine

`enabled=0` is a terminal configuration state and is projected as `disabled`. Operational states:

```text
never_synced -> syncing -> ready
                    \-> degraded   (some skills quarantined or deletion guard tripped)
                    \-> error      (fetch/validate/publish failed; LKG retained)
ready/degraded/error -> syncing -> ...
```

`mode='pinned'` is orthogonal: sync may still fetch and record `last_checked_at`, but it does not
publish a new active snapshot. `stale` is derived from `last_success_at` and `stale_after_sec`; it
is not stored. On coordinator crash during a sync, startup reconciliation converts an orphaned
`syncing` state to `error` and cleans staging.

Per-source single-flight. A manual sync while one is running joins it; if the joined request asks
for `force` and the in-flight one did not, the force request waits for the current sync and then
starts its own. A publish is one DB transaction. The GC never deletes a snapshot that is active
(referenced by an enabled, non-deleted source's `active_snapshot_id` or `pinned_snapshot_id`),
pinned, in-flight, or younger than the retention floor.

## 8. Resolution

For a target `(projectId?, appKey?)`:

1. Load managed rows visible at the target and the active external snapshots.
2. For each name, scan `app`, `project`, `global`, then sources by `priority` asc, `slug` asc,
   buckets in configured order.
3. The first layer with a row/skill either wins (enabled, valid) or is a tombstone (disabled managed
   row) and stops the scan. A managed row with stored issues is skipped. A quarantined external
   skill is skipped with a warning.
4. The winner is projected as an `EffectiveSkill` with `mode`, `origin`, `externalKey`,
   `shadows`, `shadowedExternal`, and a file count. A managed winner has `mode='managed'`,
   `source` = its scope, `id` = its row id, and `shadowedExternal=true` when a same-name external
   skill was hidden. An external winner has `mode='external'`, `id=null`, `source=null`, and a
   stable `externalKey`.
5. Two sources with the same name: the loser is listed as shadowed with a
   `skill_source_conflict` warning. A quarantined external skill is absent and produces a
   `skill_source_quarantined` warning. A stale source produces a `skill_source_stale` warning.
   `SkillWarningCode` is extended with those three codes.

`preview()` returns managed collisions plus external conflicts and stale-source warnings. `hash()`
uses only the winners. `probe()`/`apply()` materialize only the winners.

## 9. Materialization

The materializer receives a mode:

- `managed`: existing behavior; synthesize `SKILL.md` from fields, write `skill_files` (or the
  legacy references fallback), `SKILL.md` last.
- `external`: write each file from the CAS-verified bundle verbatim, including `SKILL.md`, last.

Validation runs again at materialize time: name, path grammar, size caps, ownership, no symlinks,
no path escape. Each skill is staged in a sibling temporary directory, fsynced, then swapped by
rename. `probe()` stages under a private temporary root and removes it before returning; `apply()`
writes after the old container is gone, preserving the existing probe/apply ordering.

## 10. Hash and restart

`SkillSource.hash()` keeps `string | undefined`, with `undefined` exactly when the effective set is
empty.

- **Legacy-compatible managed set:** the exact legacy `effectiveHash` projection only when there is
  no external winner and every managed winner's `skill_files` set is exactly the dual-written
  legacy references. No-source, reference-only installations do not restart on upgrade.
- **Any external winner, or any non-legacy managed file:** `hashValue({ version: 2, skills })`,
  where every winner is `{ name, files: [{ path, sha256, size }] }`. For managed winners `files`
  is the exact `buildSkillDocument()` `SKILL.md` digest plus `skill_files` digests and `executable`;
  for external winners it is the verified snapshot file list including `SKILL.md`. Sort by name,
  then path. `mode`, source identity, revision, ETag, timestamps, sync state, and quarantine state
  are excluded. Adding the first arbitrary local file or external winner changes the hash once;
  removing the last one returns to the legacy hash and changes it once.
- **Empty set:** `undefined`.

`settingsHashFor()` embeds the skills hash when defined. `#pendingRestartFor` reports
`skills_changed` when `applied_skills_hash` differs from the current hash. Migration 24 adds
`applied_skills_hash` NULL; a NULL value is **not** `applied_state_unknown` when
`applied_settings_hash` matches the current legacy settings hash, so upgrade does not restart
no-source installs. Only when both applied hashes are absent is the state unknown. The manager
obtains one `SkillCapture` per launch, passes it to `probe` and `apply`, and uses `capture.hash` for
`settingsHashFor` and `applied_skills_hash`. `pendingRestart` computes the current hash without a
capture.

## 11. Security and failure modes

| Risk | Mitigation |
| --- | --- |
| SSRF or redirect abuse | Sources are operator-only; allow only `http`/`https`; disallow redirects; strip `Authorization` on any redirect; validate the URL shape; resolve the host and reject link-local/metadata addresses before connecting; timeouts and streaming response caps. `http` with a token requires the explicit `allowInsecureHttp` source flag; otherwise the create/update is rejected. The design records the residual DNS-rebinding window for operator-trusted sources. |
| Token leakage | Sealed at rest with `secret.key`; never returned; redact `Authorization`, query strings, and error bodies; never put the token in a URL; do not follow redirects with it. Plain HTTP is opt-in and flagged in the UI. |
| Prompt injection / hub compromise | The hub is operator-trusted, but external content is prompt content. Keep the credential deny list and container mounts as the hard boundary; show a trust warning; optional pinning; per-skill quarantine; a future approval queue for changed content. |
| Malicious paths / symlinks | Strict path grammar; NFC/case/prefix checks; `assertInsideRoot`; `O_NOFOLLOW`; never create symlinks; reject symlink entries; staging + rename. |
| Disk exhaustion | Caps per file/skill/snapshot/source/global; streaming `Content-Length` enforcement; free-space reserve; abort to LKG; GC unreferenced blobs and superseded snapshots; never GC active/pinned/in-flight. |
| Mass deletion from a bad/empty manifest | Full-manifest-only deletion; bucket-set equality; empty guard; removal threshold requiring `force`. |
| Hub outage / stale cache | LKG snapshot; `stale` banner; never block app start; sync state not in the effective hash. |
| Cache corruption / bitrot | Immutable blobs; SHA-256 verification on write and at probe; fail closed; "Resync" action. |
| Lying ETag / 304 | Periodic forced full GET; ignore 304 when the active snapshot is missing/corrupt; validate every 200. |
| Clock skew | Never order by `generatedAt` or hub timestamps; use content hashes; revision is display metadata only. |
| Concurrent sync/publish/GC | Per-source single-flight; one publish transaction; synchronous apply; retention floor; no delete of active/pinned/in-flight. |
| SQLite single-writer / multi-coordinator | The design assumes one coordinator. A future multi-coordinator deployment needs a DB lease; in-process single-flight is not enough. |
| Backup/restore mismatch | Back up the DB and cache together or treat the cache as rebuildable. A pinned snapshot is not a backup if the hub has moved on. |
| Hub `version` misuse | Free-form; never parse as semver, never use for ordering. |

## 12. Non-goals

- Git-backed sources or cloning the hub's bucket repositories.
- Project/app-scoped source definitions.
- Agent-authored or agent-triggered source management.
- Hot reload of skills into a running `opencode` process.
- A revision-addressed fetch or true historical pinning; the hub API cannot serve it.
- An approval queue for changed external content.
- Per-app source opt-out (future blast-radius control).
- Dropping `skill_references` in this stage.
- Binary upload UI for local skills; the API supports base64, the UI starts with text files.
- Multi-coordinator coordination.

## 13. Acceptance criteria

| ID | Criterion |
| --- | --- |
| A1 | `runMigrations` twice is a no-op with a stable checksum; migration 24 is additive, backfills `skill_references` into `skill_files` with text encoding, and leaves existing rows, scopes, and references readable. The application-level digest backfill computes `sha256`/`size` idempotently. |
| A2 | A source can be created, edited, disabled, deleted, pinned/unpinned, and given or cleared a write-only token; the token is never returned, logged, or placed in a URL. |
| A3 | A sync against a mock hub publishes an immutable snapshot; a 304 performs no snapshot change; a changed manifest publishes a new snapshot; a repeat of identical content reuses the existing snapshot row without a duplicate insert. |
| A4 | A failed sync, a 401, a timeout, a partial file, a malformed manifest, a missing bucket, or a file hash mismatch keeps the last known good snapshot and records an error. |
| A5 | A full successful manifest that removes a skill removes it from the next snapshot. The guard trips when removals exceed `max(3, ceil(previous_count * 0.20))` or a previously non-empty source returns zero; `force=1` bypasses the guard and ETag but not validation. |
| A6 | Resolution is `app > project > global > sources by priority`; a disabled managed row hides the source skill; two sources tie-break by priority and slug; a managed row with stored issues is skipped; a quarantined external skill is absent with a warning. |
| A7 | External `SKILL.md` is materialized verbatim; managed `SKILL.md` is synthesized; an external skill with arbitrary nested and binary files materializes byte-for-byte. |
| A8 | Path traversal, absolute paths, symlinks, case-insensitive duplicates, prefix conflicts, and over-limit files are rejected at sync, write, and materialize. |
| A9 | With no external winner and only legacy references the hash equals the legacy hash; with any external winner or any non-legacy managed file it is the versioned exact-byte composite; a revision/ETag-only change does not restart; an external source swap with identical bytes does not restart; the empty set is `undefined`. |
| A10 | Hub downtime with a cached snapshot does not block app start; no cache means external skills are absent and the app still starts; a missing/corrupt snapshot fails closed with a clear error and a disable-source path; a corrupt blob is repairable by a forced sync without disabling the source. |
| A11 | The API and UI expose source state, revision, counts, bytes, last success/error, sync/check/pin actions, and external read-only badges; external rows cannot be edited in place, have `href`/`primaryId` null, and open a read-only drawer keyed by `(sourceId, bucket, name)` instead of `/skills/null`. |
| A12 | Upgrade with no sources does not mark any running app restart-required; existing resolution, materialization, and hash behavior are preserved; adding the first external winner or the first arbitrary managed file changes the hash once. `skills_changed` is reported only when the non-skills settings projection is unchanged. |
| A13 | `npm run lint`, `typecheck`, `typecheck:ui`, `test`, `build`, and `check:sensitive` pass. |
| A14 | No tracked file contains a hub URL, token, hostname, or deployment path; documentation uses placeholders. |
| A15 | `capture()` freezes the full resolved view (scope/effective/rows/disabled/warnings), projects `managed`/`external` from the same effective winner list, and carries managed file bytes plus external descriptors; a managed edit, a publish, or a source hard delete between capture and apply cannot change the materialized generation, collision warnings (`effective` + `disabled`), or the recorded `applied_skills_hash`; resolve/preview/probe/apply/settings hash use the same capture. A shadowed-winner capture test proves the projection. |
| A16 | Local `skill_files` round-trip text and binary files, materialize them byte-for-byte, include them in the hash when non-legacy, dual-write legacy references, survive `override`, preserve every `skill_files` row outside the legacy `skill_references` projection (including binary/over-limit `references/*` files) on an ordinary `references` update, reject a `references` add at a path occupied by a non-projection file with `file_path_conflict`, and survive a rollback-image read of text edits/deletions and a rollback -> re-upgrade reconcile. |
| A17 | Forking an external skill parses its `SKILL.md` frontmatter, extracts the body, copies arbitrary files, records `origin='forked'` and `forked_from_*`, and rejects a target name conflict. |
| A18 | A single invalid external skill name, frontmatter, unsafe path, oversize file, or case-insensitive duplicate is quarantined without aborting the source or the app; only the defined manifest-level failures abort the whole sync. |
| A19 | `http` with a token is rejected unless `allowInsecureHttp` is set; link-local/metadata addresses are rejected; the token is absent from logs, events, errors, and URLs. |
| A20 | A snapshot is active only while an enabled, non-deleted source references it; GC retains active/pinned snapshots, snapshots younger than the floor, and blobs referenced by any retained snapshot, and deletes unreferenced blobs. A source hard delete removes the source row (credentials cascade, fork provenance SET NULL), marks its snapshots `superseded`, and never deletes snapshot/index rows, so an in-flight captured launch still materializes. Disabled sources have no active/pinned pointer and age out after the floor; re-enable triggers a sync. `source_id` columns on snapshots/index have no FK. |
| A21 | Single-flight sync joins correctly, a `force` request waits for an in-flight sync, and publish is atomic (a crash cannot expose a partially published snapshot). |
| A22 | A revision-only manifest change reuses the snapshot (same canonical content hash) and inserts no duplicate; a rollback -> re-upgrade startup reconcile merges text-reference edits made by the old image. |

## 14. Open questions and owner decisions

Owner decisions closed before this design:

- Q1 storage/caching: variant B.
- Q2 precedence: local wins.

Autonomous decisions recorded under the owner's delegation; the owner may revise them:

- Q3 corrupt active cache: fail closed; the source can be disabled to start without it. A corrupt
  blob is repaired by a forced sync without disabling the source.
- Q4 local arbitrary-file UI: `skill_files` storage and the text/base64 API land in this stage; the
  existing Vue editor starts with text files; a binary upload UI is a follow-up.
- Q5 deletion guard: a fully successful manifest is required; the guard trips above
  `max(3, ceil(previous_count * 0.20))` removals or on an empty set for a previously non-empty
  source; `force=1` bypasses the guard and ETag but not validation.
- Q6 source position: fixed below global; no per-source position setting in this stage.
- Q7 pinning: `mode='pinned'` keeps the active snapshot frozen; sync checks but does not publish;
  `unpin` resumes tracking. No historical revision fetch.
- Q8 token rotation: write-only replace or clear; invalidates the ETag; the next sync uses the new
  token; no token version history.
- Q9 approval queue: deferred.
- Q10 per-app source opt-out: deferred.
- Q11 hash compatibility: keep the legacy managed-only hash and `undefined` for an empty set; use
  the versioned exact-byte composite only when at least one external winner exists.
- Q12 launch consistency: add `SkillCapture` to `SkillSource` and thread it through
  `probe`/`apply`/`hash`/`settingsHashFor`.
- Q13 contract split: keep `SkillService` for managed CRUD and master tools; add
  `CompositeSkillSource` for human read paths and the manager; external skills are not exposed to
  agent MCP.
- Q14 external identity: `EffectiveSkill.id` and `source` become nullable; `mode`, `origin`, and
  `externalKey` carry external provenance; no negative ids.
- Q15 local file migration: `skill_files` canonical with `sha256`/`size`; `skill_references`
  dual-written for one release.
- Q16 external names and content: validate Hanse's name contract; quarantine a bad skill instead of
  aborting the source or app; enumerate sync-fatal vs per-skill failures.
- Q17 transport: `http` with a token requires `allowInsecureHttp`; link-local/metadata addresses are
  rejected; the residual DNS-rebinding window is accepted for operator-trusted sources.
- Q18 managed-only hash: the legacy projection applies only when every managed winner's files are
  exactly the dual-written legacy references; any non-legacy file switches the effective set to the
  v2 exact-byte projection.
- Q19 upgrade restart: a NULL `applied_skills_hash` is not `applied_state_unknown` when
  `applied_settings_hash` matches the current legacy settings hash.
- Q20 launch freeze: `SkillCapture` includes managed bundles and external descriptors; snapshot/
  index rows and blobs survive a source hard delete for the retention floor.
- Q21 file preservation: `override` copies the full source file set; an idempotent startup reconcile
  merges legacy reference edits after a rollback -> re-upgrade.
- Q22 snapshot identity: `manifest_sha256` excludes revision/ETag/generatedAt, so a revision-only
  change reuses the snapshot. Sync-fatal vs per-skill quarantine is enumerated explicitly.

No open question remains for the implementation plan. The plan must carry these decisions.

## 15. Design review record

Round 1 (`oracle`, 2026-11-07): **CHANGES REQUESTED**. Findings folded into revision 2:

- **B1 hash contract** - kept `hash(): string | undefined` and the legacy managed-only hash; the
  versioned exact-byte composite applies only when at least one external winner exists; ES17/A12
  now match the contract and no-source installs keep their hash.
- **B2 launch capture** - added `SkillCapture` to the `SkillSource` contract and threaded it through
  `capture`/`resolve`/`preview`/`hash`/`probe`/`apply`; one read transaction captures active
  snapshot ids and the hash; `settingsHashFor` and `applied_skills_hash` use the captured hash.
- **B3 effective-row types** - `EffectiveSkill.id` and `source` become nullable; `mode`, `origin`,
  `externalKey`, `shadowedExternal`, and `fileCount` carry external provenance; external detail is
  keyed by `(sourceId, bucket, name)`; no negative ids.
- **B4 contract split** - `SkillService` remains the managed CRUD store and master-tool source;
  `CompositeSkillSource` implements `SkillSource` for human reads and the manager; `HttpDeps` gains
  `effectiveSkills` and `skillSources`; agent MCP sees managed skills only.
- **M1 digests** - `skill_files` gains `sha256`/`size`; managed hashing uses the exact synthesized
  `SKILL.md` bytes plus file digests and `executable`, with an application-level backfill.
- **M2 rollback** - `skill_files` is canonical and `skill_references` is dual-written for one
  release; the rollback AC covers post-upgrade text edits and deletions.
- **M3 snapshots/pin** - snapshot id is `sha256(source_id + "\0" + manifest_sha256)`; repeat
  identical content reuses the row; `mode='pinned'` keeps the active snapshot frozen and sync only
  checks; GC retention is defined.
- **M4 local files/fork** - added `SkillFileInput`, `SkillInput.files`/`SkillUpdate.files`, the
  text/base64 API, and the fork algorithm (frontmatter parse, body extraction, file copy,
  provenance, conflict).
- **M5 names/quarantine** - external names are validated against `isSkillName`; per-skill invalid
  name/frontmatter/path/size is quarantined; manifest-level failures abort the sync.
- **M6 blob repair** - a corrupt blob is moved aside under the source lock, re-fetched, verified,
  and atomically renamed into the CAS; a forced sync repairs it without disabling the source.
- **Minors** - concrete deletion threshold and `force` scope; `allowInsecureHttp` and resolved-IP
  checks; defined `mode` and FK actions; extended `SkillWarningCode`; reworded A1; added ACs for
  capture, atomicity, GC, local files, fork, quarantine, redaction, and SSRF; clarified ES9 and
  external frontmatter extraction.

Round 2 (`oracle`, 2026-11-07): **CHANGES REQUESTED**. Findings folded into revision 3:

- **Managed-only hash vs arbitrary files** - the legacy projection now applies only when every
  managed winner's files are exactly the dual-written legacy references; any non-legacy file uses
  the v2 exact-byte projection. A16/A9 cover the first arbitrary file.
- **NULL `applied_skills_hash`** - a NULL value is not `applied_state_unknown` when
  `applied_settings_hash` matches the current legacy settings hash; upgrade does not restart
  no-source installs (A12/Q19).
- **Capture completeness** - `SkillCapture` now carries managed bundles plus external descriptors;
  probe/apply materialize from the capture; snapshot/index rows and blobs survive a source hard
  delete for the retention floor (A15/A20/Q20).
- **Override file loss** - `override` copies the full source file set and dual-writes legacy
  references (A16/Q21).
- **Consumer migration** - explicit props/UI/tool-projection/routes changes, nullable id/source,
  external drawer, fork provenance, and warning-text wiring are listed in §6.1/§6.5.
- **Rollback and backfill hook** - added idempotent `reconcileSkillFiles(db)` after
  `runMigrations`; it merges legacy reference edits after rollback -> re-upgrade and fills missing
  digests (A22/Q21).
- **Snapshot identity vs revision-only bumps** - `manifest_sha256` excludes revision/ETag/
  `generatedAt`, so a revision-only change reuses the snapshot (A22/Q22).
- **Sync-fatal vs quarantine** - enumerated the two sets explicitly; case-insensitive duplicate and
  unsafe path are per-skill quarantine, exact duplicate/bucket-set/manifest failures are fatal
  (A18/Q22).

Round 3 (`oracle`, 2026-11-07): **CHANGES REQUESTED**. Findings folded into revision 4:

- **Hard delete vs retention** - the API row now says hard delete removes only the source config row;
  snapshot/index rows and blobs are retained for the retention floor (A20).
- **`skills_changed` algorithm** - specified the NULL `applied_skills_hash` fallback (skip the skills
  comparison, use the combined settings hash), the non-skills settings projection with the applied
  skills hash, and suppression of `skills_changed` when non-skills settings changed; added the
  `settingsRestartReason`/UI reason map (A12).
- **Normal `references` update** - `references` is now a partial replacement of only `references/*`
  entries; `files` is the full replacement; a normal UI save preserves arbitrary/binary files (A16).
- **External-row navigation** - `id`/`primaryId`/`href` are nullable; external rows use a drawer
  command, never `/skills/null`; warning-code union and settings sources props/UI added to the
  consumer list (A11).
- **Capture bytes** - `SkillCapture.managed` carries file bytes and digests; `capture()` reads the
  full `skill_files` rows, not only digests; external bytes remain in the CAS (A15).
- **Reconcile placement** - run after `runMigrations` via a shared `openCoordinatorDatabase()`
  helper in every process that reads skills; a rollback-only deletion is an accepted, documented
  limitation.

Round 4 (`oracle`, 2026-11-07): **CHANGES REQUESTED**. Findings folded into revision 5:

- **`references` partial replacement scope** - the deletion set is now the legacy projection set
  represented in `skill_references` (valid UTF-8, legacy limits), not every path under
  `references/`; binary/over-limit reference-shaped files created via `files` are preserved (A16).
- **GC after hard delete** - "active" is defined as referenced by a live source's
  `active_snapshot_id`/`pinned_snapshot_id`; hard delete marks the source's snapshots `superseded`,
  cascades the credential row, SET NULLs fork provenance, and retains snapshot/index rows and blobs
  for the floor (A20).
- **Capture completeness** - `SkillCapture` now carries the full `ResolvedSkills` view plus managed
  bundles with bytes and external descriptors; `resolve`/`preview`/`probe`/`apply` use it and
  derive collision warnings from the captured disabled set (A15).

Round 5 (`oracle`, 2026-11-07): **CHANGES REQUESTED**. Findings folded into revision 6:

- **Collision scanning** - preview/probe/apply now scan from `capture.resolved.effective` **and**
  `capture.resolved.disabled`, not disabled alone; A15 adds a shadowed-winner case.
- **FK clarity** - `skill_source_snapshots.source_id` and `skill_source_skills.source_id` are
  explicitly **no FK**; only `skill_source_skills.snapshot_id` cascades.
- **A16 binary references** - A16 now preserves every `skill_files` row outside the legacy
  `skill_references` projection, including binary/over-limit `references/*`; a `references` add at
  an occupied non-projection path is `file_path_conflict`.
- **Capture projections** - `managed`/`external` are projections of the same
  `resolved.effective` winner list, and the hash uses that list; A15 covers shadowing.
- **Source identity / live / disable** - source ids are random UUIDs never reused; "live" means an
  enabled, non-deleted source; disable clears active/pinned pointers and sets `disabled_at`,
  re-enable triggers a sync; GC blob rule is reference-based; A20 updated.

Round 6 (`oracle`, 2026-11-07): **PASS**. All five round-5 majors are closed; no new blocker,
correctness, data-loss, or implementability issue. Non-blocking wording folded: the Disable
paragraph now states `enabled=0` explicitly, and §7 uses "enabled, non-deleted source" instead of
the "live source" shorthand.
