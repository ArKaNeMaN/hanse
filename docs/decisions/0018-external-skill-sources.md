# 18. External skill sources

- Status: Accepted
- Date: 2026-11-07
- Stage: `0037-external-skill-sources`
- Design: [`docs/design/external-skill-sources.md`](../design/external-skill-sources.md)
- Plan: [`docs/plans/0037-external-skill-sources.md`](../plans/0037-external-skill-sources.md)

## Context

Managed skills live in the coordinator DB and are materialized into every application's isolated
`opencode` config root. Sharing a skill across applications means creating it globally or
duplicating it. The operator runs a self-hosted `skills-hub` instance on the LAN and wants it to be
a source of skills, with local managed skills still able to override it.

The hub is a distribution service, not a catalog repository: its public client contract is an HTTP
manifest plus per-file downloads. Its source of truth is one git working tree per bucket, but git is
an implementation detail and the hub has no clone/pull API.

## Decision

1. **External sources are a provider layer, not `skills` rows and not a new scope.** A
   `CompositeSkillSource` merges managed rows with the active external layer. Local managed skills
   always win: `app > project > global > external sources` by priority, then slug. A disabled managed
   row is a tombstone over external skills. Agent MCP tools continue to see managed skills only.
2. **Content-addressed cache + thin DB index + per-app materialization.** External bytes live once
   under `<state>/hanse/skill-sources/`; the DB stores source configuration, a bounded per-skill
   index, and immutable snapshot metadata. Each app receives a materialized copy. No shared
   `skills.paths` mount and no `opencode` config changes.
3. **The first adapter is a `skills-hub` HTTP client.** It uses `GET /api/v1/manifest` and per-file
   downloads with a Bearer token, ETag/304, immutable snapshots, atomic publication, deletion
   guards, per-skill quarantine, pinning, and background sync. Tokens are sealed with the coordinator
   key and are write-only.
4. **Arbitrary files are bytes.** Local skills gain `skill_files` with `sha256`/`size`;
   `skill_references` remains as a legacy projection and is dual-written for one release.
   `references` is a partial replacement of only that projection; `files` is a full replacement.
   `override` copies the full file set, and an idempotent startup reconcile merges rolled-back legacy
   edits.
5. **External `SKILL.md` is verbatim; managed `SKILL.md` is synthesized.** The effective hash keeps
   the exact legacy projection for managed-only reference-only installs; any external winner or
   non-legacy local file uses the versioned exact-byte projection. A launch-scoped `SkillCapture`
   freezes the resolved view, managed bytes, external descriptors, and hash for probe/apply.
6. **Migration v24 is additive.** It adds `skill_files`, the source tables, fork provenance, and
   `instances.applied_skills_hash`; it does not change the `scope` CHECK and does not drop
   `skill_references`.

## Consequences

Positive: the hub is updated once and reaches every app; hub downtime leaves the last-known-good
snapshot effective; local overrides keep their existing precedence; arbitrary text/binary skill
files are supported; bytes are deduplicated at rest; restart detection is content-based.

Costs and limits: a source is another network dependency and operator surface; immutable snapshots,
CAS, GC, and credential sealing add code; external content is operator-trusted prompt content.
Deferred: the Vue source-management page and external inventory drawer (the API is human-only and
available now), binary upload UI, git-backed sources, project/app-scoped sources, per-app source
opt-out, historical revision fetch, and an approval queue.

## Alternatives

- **Import hub skills into `skills`/`skill_references`.** Rejected: sync fights local edits, deletion
  and override become ambiguous, provenance is lost, and arbitrary files do not fit.
- **Point `opencode` at a shared `skills.paths` cache.** Rejected: it bypasses the hash, tombstone,
  collision, and per-app isolation model, and a writable shared tree lets one app contaminate all.
- **Mirror the hub's bucket git repositories.** Rejected: the hub is push-only and git layout is an
  internal implementation detail; the manifest/file protocol is the public contract.
- **Store all external bytes in SQLite.** Rejected: DB bloat, no content-addressed dedupe, expensive
  writes, and poor fit for arbitrary binary files.
