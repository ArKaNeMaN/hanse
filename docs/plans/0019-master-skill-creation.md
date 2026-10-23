# Plan 0019: Master-authored skills

- Status: implemented and verified; design review PASS (`oracle`, rounds 1-3); plan review PASS (`momus`)
- Design: [`docs/design/master-skill-creation.md`](../design/master-skill-creation.md)
- Design reviewer: `oracle` (rounds 1-3; round 3 left no blockers/majors, three documentation clarifications folded)
- Plan reviewer: `momus` (round 2 PASS)
- Owner decisions: autonomous mode; no open questions
- Date: 2026-10-23

## Delivery bindings

| Binding | Value |
| --- | --- |
| Stage | `0019-master-skill-creation` |
| Design artifact | `docs/design/master-skill-creation.md` |
| Plan artifact | `docs/plans/0019-master-skill-creation.md` |
| Design index | `docs/design/README.md` |
| Plan index | `docs/plans/README.md` |
| Journal | `docs/journal/0022-master-skill-creation.md`; index `docs/journal/README.md` |
| Decision record | none; the design records the confirmation and transaction decisions |
| Open questions | none |
| Verification | `npm run lint && npm run check:sensitive && npm run typecheck && npm test && npm run build` |
| Commit policy | one coherent stage commit on `main` (autonomous mode); stage only this plan's files |
| Deploy | not deployed by this stage |

## Global invariants

- **No migration, no dependency, no new route.** Existing tables, skills service, and
  `/internal/mcp` only.
- **One validator.** `SkillService.create` remains the sole authority for bundle validation,
  normalization, uniqueness, and storage. The master handler adds only boundary/type checks and
  target authorization.
- **Create only.** No master update/delete/override/disable/read/list skill tools.
- **No bundle body in events.** The event excludes `content`, reference content, description, and
  metadata values. The result uses D5's projection: it includes `description` and `metadata`, and
  excludes `content`, reference content, `metadataRaw`, and `storedIssues`.
- **Fail closed for mutation + audit.** The target re-check, `skills.create`, and
  `master.skill_created` share one outer transaction; an audit failure rolls back the skill and
  references.
- **Fail open for enrichment.** `shadows`, `shadowedBy`, `appsInScope`, and app-scope
  `pendingRestart` never turn a committed create into an error.
- **No automatic restart.** The tool reports state; the operator/master restarts explicitly.
- **Human surface unchanged.** Skills pages, API auth/origin/validation, materialization, hashing,
  and deletion remain as-is.
- **Shared worktree discipline.** The repository currently contains unrelated uncommitted skill UI
  work, including a hunk in `docs/current-state.md`. This stage edits only its listed files and
  stages/commits only its own hunks. It never reverts, formats, or includes the other work.
  `docs/current-state.md` must be staged with `git add -p` (or a hunk patch), then verified with
  `git diff --cached -- docs/current-state.md`; it is never added wholesale. Every other listed
  file is checked with `git status --short` before staging, and any unexpected dirty file is
  inspected before adding.

## Phases

### Phase 1 - Master tool surface and service wiring

Files:
- `src/master/tools.ts`
  - Add `skills?: SkillService` to `MasterToolContext`.
  - Add `create_skill` to `MASTER_TOOLS` with `scope`, `confirm_global`, `project_id`, `app_key`,
    `name`, `description`, `content`, `license`, `compatibility`, `metadata`, and `references`;
    required: `scope`, `name`, `description`, `content`.
  - Add the `create_skill` switch case and helpers:
    - `requireSkills` -> `unavailable`.
    - Scope enum validation; `confirmation_required` for absent/false global confirmation;
      `invalid_argument` for non-boolean confirmation, confirmation on non-global scope, `enabled`,
      or malformed field types.
    - `targetFor(args, scope)` then `assertSkillTarget` in this exact order: project exists
      (`unknown_project`), master project/app refused (`master_protected`), project not deleting
      (`deletion_pending`), app exists (`unknown_app`), app not deleting (`deletion_pending`).
      Run it before and inside the transaction. A missing app under a deleting project therefore
      reports `deletion_pending`, not `unknown_app`.
    - Build a `SkillInput` from the explicit allowlist; pass `license`/`compatibility` as
      string-or-null, `metadata` as a plain object, `references` as an array of objects with string
      `path`/`content`; never pass `enabled`.
    - One outer `db.transaction`: re-run `assertSkillTarget`, call
      `skills.create(scope, target, input, "master")`, insert `master.skill_created` from the stored
      row (`skillId`, `scope`, `projectId`, `appKey`, `name`, `referenceCount`, `contentBytes`,
      `referenceBytes`).
    - On `SkillConflictError`, look up the exact-scope row via `skills.resolve(target).rows` and
      return `skill_exists` with `id`, `updatedBy`, `updatedAt`; fall back to a generic message.
    - Build the result with an explicit projection (no content), `shadows` from
      `resolve(target).effective`, `shadowedBy` from a conservative narrower-scope query
      (`["project","app"]` filtered, excluding deleting targets, including disabled/invalid rows),
      `appsInScope` (`total`/`running`, excluding deleting targets), and app-scope
      `pendingRestart`; wrap each enrichment in try/catch and append
      `warnings:["post_create_enrichment"]` on failure.
  - Extend `lifecycleError` with `SkillValidationError` -> `invalid_skill` (field-prefixed) and a
    fallback `SkillConflictError` -> `skill_exists`.
- `src/http/internal-mcp.ts`: forward `deps.skills` into the master context exactly like the other
  optional services.

Checks:
- `tools/list` advertises the tool and its schema.
- A valid global (with confirmation), project, and app create stores the full bundle through
  `SkillService.get`.
- Missing/invalid scope, `enabled`, malformed confirmation, unknown/master/deleting targets, and
  missing service fail with the listed codes and create no row.
- The result includes `description`, `license`, `compatibility`, `metadata`, references with sizes,
  timestamps, `enabled`, and `updatedBy`, and contains no `content`, reference content,
  `metadataRaw`, or `storedIssues`; the event contains no content/description/metadata values;
  create + event roll back together when the event insert fails.

### Phase 2 - Failure-path and projection tests

Files:
- `test/master-tools.test.ts`
  - Add `skills: new SkillService({ db })` to the fixture.
  - Add tests for: tool advertisement/schema; scope/enabled/confirmation rejection; global/project/
    app creation with `license`/`compatibility`/metadata/references round-trip; the full positive
    result projection (description, metadata, references with `size`, timestamps, `enabled`,
    `updatedBy`) and content omission; unknown/master/deleting targets including a missing app under
    a deleting project (`deletion_pending`); duplicate with existing-row context; wider shadowing and
    narrower `shadowedBy` (multiple projects deduped/ordered `["project","app"]`, disabled tombstone
    included, deleting project/app excluded); `appsInScope` excluding deleting apps/projects and
    counting `starting` as running; app-scope `pendingRestart`; event payload, trimmed byte counts,
    and absence of description/metadata values; event-write rollback (drop `events`) including
    `skill_references`; missing service; invalid reference mapping.
  - Add the fail-open test: a manager whose `pendingRestart` throws, a wrapper `skills` whose
    `resolve` throws, and a fixture with `instances` dropped; each returns `ok:true` with a warning
    and false/empty enrichment.
- `test/master-http.test.ts`
  - Add `skills` to the fixture `HttpDeps`.
  - Keep the existing exact event-sequence test untouched; the new tests use separate fixtures.

Checks:
- A1-A10 and A13 from the design pass.
- Existing master-tools/master-http tests remain green.

### Phase 3 - Instructions, notices, and docs

Files:
- `src/master/instructions.ts`: add `hanse_create_skill` to the tool list; add the create recipe
  (scope/confirmation, slug, body-only content, canonical references, limits, always enabled,
  conflict/shadowing, no read/update/delete, no auto restart, app pending vs `hanse_list_projects`,
  global affects the master, report `shadows`/`shadowedBy`, result is the record); add the
  `create_skill` exception to the "verify with get_app/read_file" hard rule; narrow the
  operator-only rule to updating/enabling/disabling/deleting skills.
- `src/http/application.ts`, `src/http/dashboard.ts`: change "skill editing" notices to
  "skill updating/deletion" and mention chat creation.
- `docs/design/hanse-master.md`: add the tool to the table, correct the context contract, add
  `confirmation_required`/`invalid_skill`/`skill_exists`/`master_protected` to the code list, add
  the event type, narrow the instruction claim, remove the deferred note, and update accepted debt.
- `docs/design/skill-bundles.md`: reconcile the future-agent section with the master create-only
  surface; the human HTTP API stays human-only.
- `docs/current-state.md`: add the tool to the master allowlist, document create-only/confirmation/
  audit/restart behavior, remove the old "skill editing" limitation. Edit only the master section;
  stage this file hunk-by-hunk and verify the cached diff excludes the unrelated skill-UI hunk.
- `docs/design/README.md`, `docs/plans/README.md`, `docs/journal/README.md`: add the new entries.
- `README.md`: extend the master feature bullet.
- `docs/journal/0022-master-skill-creation.md`: write the stage record.

Checks:
- `rg` finds no remaining tracked claim that master skill creation is deferred or that all skill
  editing is operator-only.
- The docs describe the exact tool/result/error/pending behavior and limitations.

### Phase 4 - Transport boundary and full verification

Files:
- `test/master-http.test.ts`: add A11 using `createHttpServer`:
  - a maximum valid bundle (~0.92 MiB after `JSON.stringify`) at app scope returns 200 and creates
    the row;
  - a >1 MiB JSON-RPC body returns `413 payload_too_large` and creates no additional row.
- `docs/journal/0022-master-skill-creation.md`: record final gate counts and any residual risk.

Checks:
- Phase 1-3 checks pass.
- `npm run lint`, `npm run check:sensitive`, `npm run typecheck`, `npm test`, and `npm run build`
  pass. If the shared worktree's unrelated skill UI edits fail a gate, report the failure and the
  affected files instead of modifying them.

## Risks and mitigations

| Risk | Mitigation |
| --- | --- |
| Handler falls through to global/app on a missing/invalid scope | Explicit enum check before target work; A2. |
| `enabled:false` creates a tombstone | Reject the argument; A2. |
| Global skill is used for self-persistence | `confirm_global` after operator approval; documented accepted risk; audit. |
| Target deleted between check and insert | Guard before and inside the synchronous transaction; deletion removes scoped rows after commit. |
| Audit failure after commit | Create + event in one outer transaction; A9. |
| Enrichment failure masks success | Guarded enrichment with warnings; A13. |
| Result leaks bundle content | Explicit projection; A7. |
| 1 MiB transport rejects a valid max bundle | Bound documented for `JSON.stringify`; A11 boundary test; no limit change. |
| Collision with repo/plugin skills | Documented limitation; master directs operator to the app Skills page. |
| Unrelated shared-worktree edits enter the commit | Stage only the files listed in this plan; stage `docs/current-state.md` with `git add -p`; verify `git diff --cached` and `git status --short` before commit. |

## Review record

- Design review: rounds 1-3 (`oracle`). Round 1: 15 findings, all folded. Round 2: 6 findings, all
  folded. Round 3: no blockers/majors; three documentation clarifications folded.
- Plan review: round 1 returned three findings (shared-worktree staging, result/event wording, test
  specificity), all folded; round 2 PASS.
- Owner questions: none.
