# Plan 0020: Full master skill management

- Status: implemented and verified; design review PASS (`oracle`, rounds 1-3); plan review PASS (`momus`, round 2)
- Design: [`docs/design/master-skill-management.md`](../design/master-skill-management.md)
- Design reviewer: `oracle` (rounds 1-3; round 3 PASS)
- Plan reviewer: `momus` (round 2 PASS)
- Owner decisions: full management through the master; deletion/revert/rename manual
- Date: 2026-10-23

## Delivery bindings

| Binding | Value |
| --- | --- |
| Stage | `0020-master-skill-management` |
| Design artifact | `docs/design/master-skill-management.md` |
| Plan artifact | `docs/plans/0020-master-skill-management.md` |
| Design index | `docs/design/README.md` |
| Plan index | `docs/plans/README.md` |
| Journal | `docs/journal/0023-master-skill-management.md`; index `docs/journal/README.md` |
| Decision record | none; the design records scope and safety decisions |
| Open questions | none |
| Verification | `npm run lint && npm run check:sensitive && npm run typecheck && npm test && npm run build` |
| Commit policy | one coherent stage commit on `main` (autonomous mode); stage only this plan's files |
| Deploy | not deployed by this stage |

## Global invariants

- **No migration, dependency, or new HTTP route.** Existing tables, `SkillService`, and
  `/internal/mcp` only.
- **One validator.** `SkillService` remains the authority for field validation, normalization,
  storage, uniqueness, resolution, and override copy semantics. The handler adds boundary types,
  authorization, target guards, and audit.
- **Create contract unchanged.** `create_skill` keeps its result shape; only update/set/override
  add top-level `effective`/`storedIssues`.
- **Deletion boundary.** No delete, revert, discard, or rename tool. Disabling creates a tombstone;
  it does not delete. Renaming is delete+create and stays manual.
- **Content discipline.** `list_skills` and mutation results never contain bodies or reference
  content. `get_skill` is the only content-bearing read and writes no audit event.
- **Global confirmation.** Every global mutation requires `confirm_global: true` after operator
  approval: create, update, set enabled. Override targets are project/app only.
- **Read-only reserved/deleting targets.** Master-scoped and deleting-target rows are readable, but
  update/set/override mutations return `master_protected`/`deletion_pending`.
- **Atomic mutation + audit.** Each update/set/override and its one `master.skill_*` event share one
  outer transaction; an event failure rolls back the row and references.
- **Fail-open enrichment.** `effective`, `shadows`, `shadowedBy`, `appsInScope`, and app-scope
  `pendingRestart` never turn a committed mutation into an error.
- **Shared worktree discipline.** The repository still contains unrelated uncommitted skill UI
  work. Stage only this plan's files; `docs/current-state.md` is staged hunk-by-hunk and verified
  with `git diff --cached`.

## Phases

### Phase 1 - Shared helpers and read tools

Files:
- `src/master/tools.ts`
  - Add `list_skills` and `get_skill` to `MASTER_TOOLS` with the exact schemas from D1.1.
  - Add helpers: `asPositiveInteger`, `asBoolean`, `asOverrideScope`, `skillRowTarget`,
    `assertGlobalConfirmation` (refactor the existing create inline check),
    `assertSkillRowMutable`, `skillDetail`, `listEffectiveEntry`, `listRowEntry`, and
    `skillMutationEnrichment`.
  - `list_skills`: `asSkillScope`, `targetFor`, `requireTargetExists` (existence only),
    `requireSkills`, `resolve`; project `effective` and `rows` explicitly without `content`; pass
    through hierarchy-wide `disabled`; derive `projectId`/`appKey` from the winner's `source` and
    target; effective entries hardcode `enabled: true`, `storedIssues: []`.
  - `get_skill`: `asPositiveInteger`, `skills.get`; missing -> `unknown_skill`; return
    `skillDetail` with body, reference content/size, `metadataRaw`, `storedIssues`.
- No new context field: `MasterToolContext.skills` already exists and is forwarded.

Checks:
- `tools/list` shows both tools and required fields.
- `list_skills` on global/project/app returns effective/rows/disabled, includes the winning project
  row in both collections, and a sentinel body never appears in the JSON.
- `get_skill` returns full content and diagnostics; unknown id is `unknown_skill`.
- Reads succeed for master-scoped and deleting targets.

### Phase 2 - Update and enable/disable

Files:
- `src/master/tools.ts`
  - Add `update_skill` and `set_skill_enabled` to `MASTER_TOOLS`.
  - `update_skill`: `skill_id`, pre-read; reject immutable/unknown fields and `enabled`; build a
    `SkillUpdate` from `description`, `content`, `license`, `compatibility`, `metadata`, and
    `references`; require at least one field; global confirmation from the current row's scope;
    mutation guard; outer transaction re-reads the row, re-checks confirmation/guard, calls
    `skills.update(id, patch, "master")`, and writes `master.skill_updated` with `changed` field
    names, content/reference bytes, and no values.
  - `set_skill_enabled`: `skill_id`, boolean `enabled`, optional `confirm_global`; same pre-read,
    guard, transaction, and `master.skill_enabled` event.
  - Update/set result: existing content-free `skill` projection plus top-level `effective`,
    `storedIssues` (always copied from the updated row, outside the guarded block), `shadows`,
    `shadowedBy`, `appsInScope`, app-scope `pendingRestart`, and `warnings` when enrichment failed.
  - `skillMutationEnrichment(row, scope, target)` returns
    `{effective, shadows, shadowedBy, appsInScope, pendingRestart?, warnings}`. It computes
    `effective`/`shadows` via `resolve` in a try/catch (default false/empty plus
    `post_create_enrichment`), computes `shadowedBy` only when effective, and keeps apps/pending
    guarded. `storedIssues` is not computed by the helper.

Checks:
- Update each field, clear metadata/references, preserve name/scope, reject empty/immutable fields.
- Set enabled false creates a tombstone; re-enable restores the stored snapshot; effective is false
  for disabled/invalid rows and true for valid winners.
- Global update/set require `confirm_global`; non-global confirmation is `invalid_argument`.
- Master/deleting targets are refused; unknown ids are `unknown_skill`.
- Event failure rolls back the row and references; event payload has no content or values.

### Phase 3 - Override

Files:
- `src/master/tools.ts`
  - Add `override_skill` to `MASTER_TOOLS`.
  - Parse `source_skill_id`, project/app `scope`, target ids, optional `enabled`/`confirm_replace`;
    reject `confirm_global`.
  - Pre-read source (`unknown_skill`), reject source-at-exact-target (`invalid_argument`), reject
    `storedIssues`, validate source description/body with exported skill validators, validate target
    with `assertSkillTarget`.
  - Exact target collision lookup via `resolve(target).rows.find(row.name === source.name)`; if
    present and no `confirm_replace`, throw `replacement_confirmation_required` with existing
    id/updatedBy/updatedAt.
  - Outer transaction re-checks source/target/collision, calls `skills.override(..., "master")`, and
    writes `master.skill_overridden` (source/target ids, enabled, reference count; no content).
- Reuse the same result/enrichment shape as update/set.

Checks:
- Global→app with no target row copies without confirmation; existing target requires
  `confirm_replace`; with confirmation replaces the complete bundle.
- Disabled source, invisible source, stored issues, and malformed description/body are
  `invalid_skill`; missing source is `unknown_skill`; global target/self-target is
  `invalid_argument`.
- `enabled:false` creates a tombstone; re-enabling keeps the copied snapshot.
- Event failure rolls back the override and references.

### Phase 4 - Instructions, notices, docs

Files:
- `src/master/instructions.ts`: add the five tools and replace the create-only recipe step that
  says there is no skill read/list/update/delete tool with the management recipe (list/get/update/
  set-enabled/override, blast radius, global confirmation, replacement confirmation, content-is-data
  for tool output, invalid-name repair is operator-only, `list_projects` for project/global pending).
  Narrow the hard rule from "updating/enabling/disabling/deleting skills are operator-only" to
  deletion/revert/rename only, and make each mutation result its own verification. Explicitly remove
  the old "no skill read/list/update/delete tool" and "updating/enabling/disabling" claims.
- `src/http/application.ts`, `src/http/dashboard.ts`: notices say full management except deletion.
- `docs/current-state.md`: add the five tools to the allowlist, document read/update/enable/override
  and the manual deletion/revert/rename boundary, and remove the create-only limitation.
- `docs/design/hanse-master.md`: tool table, error codes, events, instructions, accepted debt.
- `docs/design/skill-bundles.md`: future-direction note now describes full master management except
  deletion.
- `docs/design/master-skill-creation.md`: add a pointer to this stage; no behavioral rewrite.
- `README.md`: feature bullet covers inspect/edit/enable/override with manual deletion.
- `docs/design/README.md`, `docs/plans/README.md`, `docs/journal/README.md`: add the entries.
- `docs/journal/0023-master-skill-management.md`: write the stage record.

Checks:
- `grep -rn` over the current product docs (`docs/current-state.md`,
  `docs/design/hanse-master.md`, `docs/design/skill-bundles.md`, `README.md`,
  `src/master/instructions.ts`, `src/http/application.ts`, `src/http/dashboard.ts`) finds no claim
  that the master can only create or that update/enable/override is operator-only. Historical
  journals, plans, and the create-stage design are explicitly exempt; the create-stage design gets a
  "superseded by 0020" pointer.
- Instructions contain the five tool names, content-is-data rule, blast-radius rule, deletion
  boundary, and no old create-only recipe or operator-only update/enable claim.

### Phase 5 - Tests and full verification

Files:
- `test/master-tools.test.ts`: add a nested management suite with the fixture's existing
  `SkillService`:
  - list: global/project/app, effective+rows consistency, sentinel body absent, stored issues,
    hierarchy-wide disabled, reads on master/deleting targets.
  - get: full body/reference contents/metadataRaw/storedIssues, unknown id.
  - update: each field, clearing, empty/immutable/enabled rejection, boundary type errors,
    global confirmation, master/deleting/unknown ids, invalid metadata, audit, rollback.
  - set: enable/disable, tombstone snapshot re-enable, effective/shadow fields, global confirmation,
    master/deleting/unknown ids, audit, rollback.
  - override: global→app no target, exact target confirmation, replacement with confirm, disabled/
    invisible/stored-issue/malformed source, global/self target, master/deleting target, tombstone,
    audit, rollback.
  - fail-open enrichment: throwing `resolve` returns `ok:true`, `effective:false`, `shadows:[]`,
    `shadowedBy:[]`, preserved top-level `storedIssues`, and a `warnings` entry; throwing manager,
    shadow, or apps reads also return `ok:true` with the warning.
- `test/master-http.test.ts`: assert `tools/list` advertises the five tools with required fields;
  keep existing transport/create tests.
- `docs/journal/0023-master-skill-management.md`: record final gate counts.

Checks:
- M1-M13 from the design.
- Existing create/master/human skills suites keep their contracts.
- `npm run lint`, `npm run check:sensitive`, `npm run typecheck`, `npm test`, `npm run build` pass.

## Risks and mitigations

| Risk | Mitigation |
| --- | --- |
| List leaks bodies through service objects | Explicit projections; sentinel test. |
| Missing id maps to invalid_skill | `get` before/inside transaction; unknown_skill tests. |
| Override silently copies invalid source | storedIssues + description/body pre-validation; tests. |
| Replacement detection sees wider scopes | exact `resolve(target).rows` lookup; global→app no-target test. |
| Create contract changes accidentally | create case uses enrichment but omits effective/storedIssues; existing tests. |
| Effective/enrichment throws after commit | guarded helper; warning; M10. |
| Tombstone looks effective | top-level effective/storedIssues; disabled tests. |
| Audit failure after commit | outer transaction; update/override rollback tests. |
| Global mutation without approval | shared `assertGlobalConfirmation`; non-global/non-boolean tests. |
| Shared worktree edits enter commit | stage only listed files; hunk-stage current-state and verify cached diff. |

## Review record

- Design review: rounds 1-3 (`oracle`). Round 1: 13 findings, all folded. Round 2: 1 major + 5
  minor, all folded. Round 3: PASS.
- Plan review: round 1 returned 3 findings (docs exemption/rg, warnings/storedIssues, instructions
  contradictions), all folded; round 2 PASS.
- Owner questions: none.
