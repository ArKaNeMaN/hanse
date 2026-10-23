# 0022 - Master-authored skills

- Date: 2026-10-23
- Stage: `0019-master-skill-creation`
- Status: implemented and verified
- Design: [`docs/design/master-skill-creation.md`](../design/master-skill-creation.md)
- Plan: [`docs/plans/0019-master-skill-creation.md`](../plans/0019-master-skill-creation.md)

## Why

The master agent could create projects, add applications, write their `AGENTS.md`, change settings,
and start/restart agents, but skill creation still required leaving chat for the skills UI. The
skills registry already had a complete bundle model and authoritative validation, so the remaining
work was to expose one narrow, audited create path without giving the master raw database or
filesystem access.

## What changed

- **New master tool.** `create_skill` creates an enabled bundle at `global`, `project`, or `app`
  scope. Its arguments are `scope`, `name`, `description`, `content`, optional `confirm_global`,
  `project_id`/`app_key`, `license`, `compatibility`, `metadata`, and `references`. `scope` is
  required and validated against the enum before any target work; `enabled` is rejected.
- **Service reuse.** The handler builds a `SkillInput` from an explicit allowlist and calls
  `SkillService.create(..., "master")`. Slug, description, body, metadata, reference path/content/
  count/aggregate, uniqueness, and normalization rules are unchanged and owned by the skills
  service. `SkillValidationError` maps to `invalid_skill` (with the field), `SkillConflictError` to
  `skill_exists` with the existing row's id/updatedBy/updatedAt.
- **Target guards.** Project/app targets must exist; the reserved master project/app is refused as
  `master_protected`; deleting projects/apps are refused as `deletion_pending`. The guard runs both
  before and inside the write transaction. Global scope requires `confirm_global: true` after
  operator approval; missing/false confirmation is `confirmation_required`, non-boolean values and
  non-global confirmation are `invalid_argument`.
- **Atomic mutation and audit.** One outer better-sqlite3 transaction contains the target re-check,
  the nested `SkillService.create`, and the `master.skill_created` event. An event-insert failure
  rolls back the skill and its references and returns `internal_error`. The event stores ids, name,
  reference count, and stored byte sizes only.
- **Content-free result.** The result contains `id`, scope/target ids, name, description, license,
  compatibility, metadata, enabled, reference paths with UTF-8 sizes, timestamps, and updatedBy. It
  never contains `content`, reference content, `metadataRaw`, or `storedIssues`. It also reports
  `shadows`, `shadowedBy`, `appsInScope {total, running}`, and app-scope `pendingRestart`.
- **Fail-open enrichment.** `shadows`, `shadowedBy`, `appsInScope`, and app-scope `pendingRestart`
  are computed after the commit and wrapped individually; a failure returns `ok:true` with
  `warnings: ["post_create_enrichment"]` and a false/empty value.
- **Instructions and UI copy.** The master prompt advertises `hanse_create_skill`, explains the
  required scope/confirmation, body-only content, slug/reference formats and limits, conflict and
  shadow semantics, restart reporting, the lack of read/update/delete tools, and the global
  self-impact. The operator-only rule now covers updating/enabling/disabling/deleting, not creation.
  The master application/dashboard notices say the same.
- **Docs.** The master design, skill-bundles future-direction note, current-state, README, design/
  plan indexes, and the journal index were updated.

## Decisions

- **Create only.** The master gets no read/list/update/delete/override/disable/revert tool. A
  narrower same-name create shadows a wider skill; conflict context lets the model stop instead of
  retrying blindly.
- **Global confirmation is a real gate, not a claim of safety.** App/project self-targeting is
  refused, but global skills affect every app including the master. `confirm_global` requires the
  operator's explicit approval in chat; the remaining self-modification risk is accepted and
  audited.
- **Audit is part of the mutation.** A success without an event is not allowed; the transaction
  rolls back if the event cannot be written.
- **No migration, dependency, new route, or skill-code change.** The existing `skills` and
  `skill_references` tables, `SkillService`, `/internal/mcp`, and the 1 MiB internal transport bound
  are reused. The maximum valid bundle is ~0.92 MiB with the master's `JSON.stringify` client.
- **Collisions remain a known limitation.** Repository, plugin, and external skill roots can still
  shadow a managed skill; the master directs the operator to the app Skills page rather than
  performing collision scanning without per-app materialization context.

## Verification

- `npm run lint` - clean.
- `npm run typecheck` - clean.
- `npm test` - 103 files, 1,682 tests passed. One unrelated `permission-policy` case flaked once
  in a parallel run, then passed alone and in the full rerun.
- `npm run build` - clean (tsc + Tailwind).
- `npm run check:sensitive` - passed.
- New tests cover the tool schema, scope/enabled/confirmation rejection, global/project/app bundle
  round-trip, target/master/deletion guards, conflict context, wider/narrower shadowing, app counts
  and pending restart, compact events, event-write rollback, unavailable/validation failures,
  fail-open enrichment, and the 1 MiB transport boundary through a real HTTP server.

## Residual risks

- A confirmed global skill can change every agent, including the master after restart. This is the
  explicit operator-approved path, not a sandbox escape.
- External/repository/plugin skills can shadow the managed bundle; no collision scan runs in the
  master tool.
- The master cannot inspect or repair a skill after creation; the operator must use the skills UI.
- A hypothetical MCP client that encodes all non-ASCII as `\uXXXX` can exceed the 1 MiB internal
  transport limit; the supported master client uses `JSON.stringify`.
