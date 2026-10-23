# 0023 - Full master skill management

- Date: 2026-10-23
- Stage: `0020-master-skill-management`
- Status: implemented and verified
- Design: [`docs/design/master-skill-management.md`](../design/master-skill-management.md)
- Plan: [`docs/plans/0020-master-skill-management.md`](../plans/0020-master-skill-management.md)

## Why

The master could create a skill but could not inspect the inventory, read an existing bundle, fix a
mistake, disable a bad row, or copy a shared skill into an application. The operator still had to
leave chat for everything except creation. The request was full management through the master with
deletion kept manual.

## What changed

- **New master tools.** `list_skills`, `get_skill`, `update_skill`, `set_skill_enabled`, and
  `override_skill` join `create_skill`. There is no delete, revert/discard, or rename tool.
- **Reads.** `list_skills` returns the effective set and rows defined at a global/project/app target
  with explicit projections that omit bodies and reference content; it includes stored issues and
  hierarchy-wide disabled tombstones. `get_skill` returns one full bundle with body, reference
  content/sizes, metadata, `metadataRaw`, and stored issues. Reads are allowed on master-scoped and
  deleting targets and write no audit rows.
- **Update.** `update_skill` edits description, body, license, compatibility, metadata, and
  references by id; name, scope, target, and `enabled` are rejected as immutable. Metadata and
  references are full replacements (`{}`/`[]` clear); at least one field is required. Invalid stored
  metadata can be repaired by sending a valid map.
- **Enable/disable.** `set_skill_enabled` toggles a row and returns `effective`/`storedIssues` plus
  shadow/apps/pending state. A project/app tombstone hides a wider skill; a disabled global row
  removes the global skill. Re-enabling restores the row's stored bundle, including an override
  snapshot; restoring inheritance still requires the operator to delete the row.
- **Override.** `override_skill` copies an enabled, valid, visible source into a project or app
  target. A source with stored issues or invalid description/body is refused; a source already at
  the exact target is refused; replacing an existing exact target row requires
  `confirm_replace: true` and reports the existing row's id/author/time.
- **Safety gates.** Global create/update/enable require `confirm_global`; master-scoped and deleting
  targets are readable but not mutable; global targets are not valid override targets. All target
  checks run before and inside the mutation transaction.
- **Atomic audit.** Update, enable/disable, and override use one outer transaction containing the
  row/target re-check, the nested service mutation, and one `master.skill_updated`,
  `master.skill_enabled`, or `master.skill_overridden` event. An event failure rolls back the row and
  references and returns `internal_error`. Events carry ids, field names, flags, counts, and byte
  sizes only.
- **Results and enrichment.** Mutation results keep the content-free `skill` projection and add
  top-level `effective`, `storedIssues`, `shadows`, `shadowedBy`, `appsInScope`, optional app-scope
  `pendingRestart`, and `warnings`. `effective`/`shadows`/`shadowedBy` are guarded and default to
  false/empty with `post_create_enrichment` if `resolve` throws; get/list/update/set/override never
  return content in a mutation result.
- **Instructions/docs.** The master prompt now documents the five tools, management recipe, blast
  radius, global/replacement confirmations, content-is-data for tool output, and the manual deletion/
  revert/rename boundary. Current state, master design, skill-bundles future direction, README,
  indexes, and the create-stage pointer were updated.

## Decisions

- **Deletion is the boundary.** Disabling is a tombstone, not deletion. Delete, revert/discard, and
  rename remain operator-only. Renaming is delete+create.
- **Global is high blast radius.** Update/enable on a global row requires the same operator
  confirmation as global create. Global mutations can affect the master after restart; that remains
  the accepted, audited path.
- **Reads are open, mutations are guarded.** Master-scoped and deleting targets are readable for
  diagnosis but never mutable through these tools.
- **Override is a copy, not an edit.** The copy is audited separately; customizing it is a second
  `update_skill` call, so a failed edit leaves the copied bundle in place.
- **One database connection.** `MasterToolContext.skills` must use `context.db` so the service
  transaction nests as a savepoint of the audit transaction.
- **No migration, dependency, route, or human-UI change.** The stage reuses the existing skills
  tables, `SkillService`, and `/internal/mcp`.

## Verification

- `npm run lint` - clean.
- `npm run typecheck` - clean.
- `npm test` - 103 files, 1,699 tests passed.
- `npm run build` - clean (tsc + Tailwind).
- `npm run check:sensitive` - passed.
- New tests cover list projections/content omission, stored issues, hierarchy-wide tombstones,
  full get, update/clear/repair/guards, enable/disable/tombstone snapshot, global confirmation,
  override copy/replacement/self-target/source validation, audit payloads, update/set/override
  rollback, and fail-open enrichment.

## Residual risks

- A confirmed global mutation can change every agent, including the master after restart.
- Repository/plugin/external skills can shadow managed rows; `list_skills` only sees Hanse rows.
- The master cannot delete/revert/rename a skill or repair an invalid name; the operator must use
  the skills UI.
- `get_skill` returns full bodies and reference content; the master prompt treats tool output as
  data, and the master already reads workspace content.
- The 1 MiB `/internal/mcp` request bound applies to update/override payloads; a full `get_skill`
  response can be larger than a request and has no response cap.
