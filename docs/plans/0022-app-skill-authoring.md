# Plan 0022 - App-agent skill authoring

Status: implemented and verified (journal 0024); all five gates pass; committed as one coherent
stage commit after explicit owner instruction.
Design: [`docs/design/app-skill-authoring.md`](../design/app-skill-authoring.md).
Stage: `0022-app-skill-authoring`; journal: `0024-app-skill-authoring`.

## Bindings

| Binding | Value |
| --- | --- |
| Stage | `0022-app-skill-authoring` |
| Design artifact | `docs/design/app-skill-authoring.md` |
| Plan artifact | `docs/plans/0022-app-skill-authoring.md` |
| Design reviewer | `oracle` (rounds 1-3; round 3 PASS) |
| Plan reviewer | `momus` |
| Design index | `docs/design/README.md` |
| Plans index | `docs/plans/README.md` |
| Journal | `docs/journal/0024-app-skill-authoring.md`; index `docs/journal/README.md` |
| Decision record | none; the design and the owner decisions below record the contract |
| Open questions | none (design §12) |
| Verification | `npm run lint`, `npm run typecheck`, `npm test`, `npm run build`, `npm run check:sensitive` |
| Commit policy | one coherent stage commit only on owner instruction; this plan does not authorize a commit |
| Deploy | not deployed by this stage |

## Owner decisions

Approved 2026-10-23:

1. **Full master tool parity minus scope choice.** The app surface is exactly `create_skill`,
   `list_skills`, `get_skill`, `update_skill`, `set_skill_enabled`, and `override_skill`. Delete,
   revert/discard, and rename stay operator-only.
2. **Token-bound target.** The target is always `{projectId, appKey}` from the verified token. No
   tool accepts `scope`, `project_id`, `app_key`, or `confirm_global`.
3. **Name and hierarchy semantics unchanged.** A same-scope duplicate returns `skill_exists`; wider
   same-name rows may be shadowed or overridden at the app's own level. No new uniqueness rule.
4. **Restart is manual.** Mutations report `pendingRestart`; nothing restarts automatically and
   there is no self-restart tool.

`docs/open-questions.md` is intentionally not modified in this stage because it currently carries
the unrelated in-flight `0021-slash-commands` stage. The decisions are recorded here and in design
§12.

## Requirements traceability

| Requirement | Topic | Plan phase | Acceptance |
| --- | --- | --- | --- |
| AS1 | Token-bound target | 2, 3, 4, 5 | A1, A2, A16 |
| AS2 | Exactly six app tools | 2 | A1 |
| AS3 | Service validation and one shared implementation | 1, 2, 4, 5 | A2, A4 |
| AS4 | No scope/target/global-confirmation arguments | 2 | A2 |
| AS5 | Same-scope create conflict | 4 | A4 |
| AS6 | Shadowing and override semantics unchanged | 4, 5 | A5, A9 |
| AS7 | `get_skill` readable set and by-id write rules | 3, 4, 5 | A6, A7, A8, A9 |
| AS8 | Override source visibility and self-copy | 5 | A9 |
| AS9 | Deletion guard before row inspection | 4, 5 | A10 |
| AS10 | App actor and one atomic audit event | 1, 4, 5 | A3, A11 |
| AS11 | `pendingRestart` report | 1, 4, 5 | A12 |
| AS12 | No start/restart path | 2, 4, 5 | A12 |
| AS13 | Existing service and transport bounds | 5 | A17 |
| AS14 | No migration, dependency, or route | 6 | A15 |
| AS15 | Human `/api/skills*` auth unchanged | 6 | A15 |
| AS16 | Content discipline | 1, 3, 4, 5 | A14 |

The design's requirement table ends at AS16. The brief's "AS1-AS17" is covered by AS1-AS16 plus A17,
the transport acceptance check added in design review round 2 (R2-3). No AS17 requirement is
invented here.

## Invariants

- **Token-bound target.** Every app skill call derives `{projectId, appKey}` from the verified
  `AgentTokenIdentity`; no handler reads a target from `args`.
- **One service, one connection.** The app context uses `deps.skills`, constructed over `deps.db`.
  The handler never constructs a `SkillService`; the outer audit transaction and the service's
  nested transaction must share the same better-sqlite3 connection.
- **No scope/global writes.** All writes are at the caller's own `scope = 'app'` target. Global and
  project rows are read-only for the app.
- **Hierarchy unchanged.** Same-scope uniqueness, wider shadowing, invalid-row handling, and
  override semantics remain `SkillService` behavior.
- **No delete/revert/rename.** Disabling is a tombstone, not deletion. Name, scope, and target are
  immutable on update.
- **No restart.** No tool calls `ensure` or `restartIfRunning`; only `pendingRestart` is read.
- **No migration/dependency/route.** The stage reuses `skills`, `skill_references`, `events`, and
  `/internal/mcp`.
- **Human routes unchanged.** `/api/skills*` keeps its human-principal and same-origin checks; app
  tokens still receive `403 human_only`.
- **Content-free audit.** Events carry actor, identifiers, field names, counts, and byte sizes only.
  Mutation and list projections carry no body; only `get_skill` returns content.
- **Acyclic module graph.** Cross-layer edges that could cycle are `import type`; `access.ts` has no
  runtime dependency on the service or master modules.
- **`get_skill` readable set.** Effective rows for the caller plus the caller's own app rows.
  Disabled, invalid, or shadowed wider rows return `unknown_skill`.
- **Mutation precedence.** Boundary identity and forbidden-key checks run first; argument
  type/parse checks run next; the target guard then runs before any row load or by-id inspection;
  row authorization follows; the transaction re-runs the guard and authorization. Deletion therefore
  wins over row-level errors for well-formed arguments, while malformed arguments are
  `invalid_argument` before the guard. Reads bypass the guard.
- **Atomic write and event.** Each mutation's target re-check, skill write, and exactly one event
  insert share one outer transaction; a failed insert rolls back the row and references.

## Phase 1 - Shared extraction only (behavior-preserving)

### Boundaries / non-goals

- No app tool is advertised or dispatched in this phase.
- No migration, dependency, route, schema, materialization, hash, or validation change.
- No master behavior, result shape, or error code change. This is move-and-rewire only.

### Files changed

New:

- `src/skills/tool-errors.ts`
- `src/skills/tool-inputs.ts`
- `src/skills/tool-projection.ts`
- `src/skills/access.ts`
- `src/skills/tool-access.ts`
- `src/store/events.ts`
- `src/store/runtime-state.ts`

Modified:

- `src/master/tools.ts` (imports replace local copies; call sites updated)
- `src/skills/service.ts` (uses shared visibility predicate)
- `test/skills-store.test.ts` (shared predicate unit tests)

### Work

1. **`src/skills/access.ts`** - neutral predicates, `import type` from `./types.js` only:
   - `skillVisibleAt(row: SkillRow, target: SkillTarget): boolean` using `target.projectId ?? ""`
     and `target.appKey ?? ""`; global is visible everywhere, project only in its project, app only
     in its own app.
   - `isOwnAppSkillRow(row, target): boolean` - `scope === "app"` and both target fields match.
   - `skillRowTarget(row): SkillTarget` - `{}` / `{projectId}` / `{projectId, appKey}`.
   - `isSameSkillTarget(row, scope: "project" | "app", target): boolean`.
2. **`src/skills/tool-errors.ts`**:
   - `class SkillToolError extends Error` with `readonly code: string`.
   - `unknownSkillError(id: number): SkillToolError` with code `unknown_skill`.
   - `toSkillFailure(error: unknown): { ok: false; code: string; message: string }`, mapping
     `SkillToolError` to its code, `SkillValidationError` to `invalid_skill` (prefix `field` when
     present), `SkillConflictError` to `skill_exists`, and only anything else to `internal_error`
     with a 300-character message cap. Import `SkillConflictError` from `./service.js` and
     `SkillValidationError` from `./validation.js`. The edge is one-way: `service.ts` does not
     import `tool-errors.ts`.
3. **`src/skills/tool-inputs.ts`** - move `asString` (`src/master/tools.ts:331-336`),
   `asOptionalStringOrNull` (`:503-511`), `asOptionalMetadata` (`:513-526`),
   `asOptionalReferences` (`:528-553`), `skillInputFromArgs` (`:555-578`), `asPositiveInteger`
   (`:758-763`), `asBoolean` (`:765-770`), and `skillUpdatePatchFromArgs` (`:909-942`). Replace
   every `MasterToolError` with `SkillToolError`; keep the same messages and codes. Keep
   `asOptionalString` (`:338-343`) in `src/master/tools.ts` for settings target parsing.
4. **`src/skills/tool-projection.ts`**:
   - Export `interface SkillToolContext { db: SqliteDatabase; skills?: SkillService; manager?:
     InstanceManager }` using `import type` for the service and manager.
   - Move `skillSummary` (`:610-630`), `skillDetail` (`:793-805`), `listEffectiveEntry`
     (`:807-825`), `listRowEntry` (`:827-845`), `shadowedByScopes` (`:632-682`), `appsInScope`
     (`:684-714`), `pendingRestart` (`:392-397`), and `skillMutationEnrichment` (`:847-907`).
   - `skillMutationEnrichment(context: SkillToolContext, skills: SkillService, row, target,
     includeState)` keeps the current fail-open behavior and warning
     `post_create_enrichment`.
   - `appsInScope` imports `runtimeState` from `../store/runtime-state.js`; there is no private copy.
5. **`src/skills/tool-access.ts`** - shared guards that throw `SkillToolError`:
   - `assertSkillTarget(db, scope, target)` in the design order: project exists
     (`unknown_project`), not reserved master project (`master_protected`), not deleting
     (`deletion_pending`); for app scope then app exists (`unknown_app`), not reserved master app
     (`master_protected`), not deleting (`deletion_pending`). Global returns immediately. The old
     helper's separate app-master check is redundant after the master-project check and cannot fire
     for a non-master project, so this reordering changes no reachable behavior; a master project is
     refused before deletion. Use private `projectRow`/`appRow` SQL readers in this module; the
     master keeps its own readers for non-skill tools.
   - `assertOwnAppSkillRow(row, target)` - return when `isOwnAppSkillRow`; throw `invalid_argument`
     with override guidance when `skillVisibleAt` is true (visible global/project row); otherwise
     throw `unknown_skill`.
   - `assertSkillReadable(skills, row, target)` - return for an own app row; otherwise require
     `skillVisibleAt(row, target)` and `skills.resolve(target).effective` to contain `row.id`; else
     `unknown_skill`.
    - `assertOverridableSource(row)` - move the current stored-issues check; call
      `validateSkillDescription`/`validateSkillContent` and rethrow any `SkillValidationError` as
      `SkillToolError("invalid_skill", field-prefixed message)` so the shared guard always throws the
      same class/code. Keep the master behavior unchanged: it does not check `enabled` or name
      validity. The app-only `assertAppOverrideSource` (Phase 5) adds those checks before
      replacement confirmation.
   - `skillConflictError(skills, scope, target, name)` - move the existing exact-scope lookup and
     message; return a `SkillToolError` with `skill_exists` and existing id/updatedBy/updatedAt
     when found.
   - `replacementConfirmationError(row)` - move the master message and return
     `replacement_confirmation_required`.
6. **`src/store/events.ts`** - move `recordEvent` (`src/master/tools.ts:399-408`) as
   `recordEvent(db, scope: string, type: string, payload: Record<string, unknown>)`; keep the 8 KiB
   payload truncation and insert `(scope, type, payload, created_at)`.
7. **`src/store/runtime-state.ts`** - move `runtimeState` (`src/master/tools.ts:360-366`) and export
   it.
8. **`src/skills/service.ts`** - delete private `sourceVisibleAt` (`:247-255`), import
   `skillVisibleAt`, and replace the override check with
   `skillVisibleAt(source, { projectId: location.projectId, appKey: location.appKey })`.
9. **`src/master/tools.ts`** - delete the moved definitions and import them from the new modules.
   - `MasterToolContext` becomes `extends SkillToolContext` and adds `workspaceRoot: string`,
     `settings?: SettingsService`, `deletion?: DeletionService`.
   - Replace every `recordEvent(context.db, "master.…", payload)` with
     `recordEvent(context.db, "master", "master.…", payload)`. This includes the ternary call site
     `recordEvent(context.db, cleared ? "master.setting_cleared" : "master.setting_changed", ...)`.
   - Add `SkillToolError` to `lifecycleError` before the `SkillValidationError`/`SkillConflictError`
     branches, returning `new MasterToolError(error.code, error.message)`.
   - Keep `assertSkillRowMutable` as a thin wrapper over shared `assertSkillTarget`; keep
     `assertGlobalConfirmation`, `asSkillScope`, `asOverrideScope`, `targetFor`,
     `requireTargetExists`, `projectRow`, `appRow`, `lookupApp`, and all non-skill tools local.
   - Use shared `unknownSkillError` and `replacementConfirmationError` so the messages do not fork.

### Acceptance criteria

- Existing master create/management behavior and codes are unchanged: A4 (master portion), A15
  regression portion.
- One authoritative target guard: `rg "function assertSkillTarget" src` finds only
  `src/skills/tool-access.ts`; `rg "sourceVisibleAt" src` returns nothing.
- No app tool appears in any tool list yet.

### Tests

- Extend `test/skills-store.test.ts` with the `describe("shared skill access predicates")` unit
  suite for `skillVisibleAt`, `isOwnAppSkillRow`, `skillRowTarget`, and `isSameSkillTarget` across
  global, project, caller-app, sibling-app, and other-project rows. This pins the extraction without
  a database or service.
- Run the existing `test/master-tools.test.ts`, `test/master-http.test.ts`,
  `test/skills-store.test.ts`, and `test/manager.test.ts` suites; the only test edit in this phase is
  the new predicate suite.
- Add no new master behavior test; the extraction is proven by those suites plus the predicate
  unit tests.

### Exit check

`npm run typecheck` and the four suites above pass; the scoped diff for the extraction files
contains moves, import rewiring, `recordEvent` call-site updates, and the `skillVisibleAt`
substitution only (unrelated `0021-slash-commands` changes are excluded).

## Phase 2 - App tool surface and dispatch

### Boundaries / non-goals

- No read or write handler logic yet; those land in Phases 3-5.
- No new HTTP route, token format, or master branch change.
- The direct-DB `hanse mcp` fallback (`src/mcp/server.ts`, `src/cli/commands.ts:813-822`) stays
  handoff-only.

### Files changed

- New: `src/skills/app-tools.ts`
- Modified: `src/mcp/ssh-protocol.ts`, `src/http/internal-mcp.ts`
- Tests: `test/mcp-http.test.ts`

### Work

1. **`src/skills/app-tools.ts`**:
   - Export `APP_SKILL_TOOLS` with the six schemas in design §5.2 order (`create_skill`,
     `list_skills`, `get_skill`, `update_skill`, `set_skill_enabled`, `override_skill`), copied
     verbatim (do not re-author descriptions), including the empty `list_skills` `inputSchema`;
     export `APP_SKILL_TOOL_NAMES` as a `ReadonlySet<string>`, and `isAppSkillToolName(name)`.
   - Export `type AppSkillToolContext = SkillToolContext`.
   - Export `async function callAppSkillTool(context, agent, name, args): Promise<unknown>`.
     Phase 2 establishes the boundary:
     - reject a master identity (`isMasterAppId(agent.appId)`) with `master_protected`;
     - reject an inconsistent identity (`` agent.appId !== `${agent.projectId}:${agent.appKey}` ``)
       with `internal_error`;
     - reject `scope`, `project_id`, `app_key`, and `confirm_global` on every tool with
       `invalid_argument` before any database work;
     - compute `const target = { projectId: agent.projectId, appKey: agent.appKey }`;
      - require `context.skills` (`unavailable` if absent) and a known tool name
        (`internal_error` otherwise; the dispatcher only routes known names, so this is a
        programming-error guard, not a model-facing code);
     - dispatch through a `switch` whose read/write cases are added by Phases 3-5. Until a case is
       added, the `default` throws `SkillToolError("internal_error", "app skill tool not
       implemented")`; no fake success is returned. This placeholder is removed by Phase 5 and is
       never asserted as product behavior.
     - wrap the whole body in `try/catch` and return `toSkillFailure(error)` so validation,
       conflict, and skill errors keep their codes and only unexpected failures become
       `internal_error`.
2. **`src/mcp/ssh-protocol.ts`**:
   - Export `interface AppSkillRpcOptions { db?: SqliteDatabase; skills?: SkillService;
     manager?: InstanceManager }` (type-only imports).
   - Add the optional fifth parameter `options: AppSkillRpcOptions = {}` to `handleRpcAsync`; all
     existing four-argument callers remain valid.
   - `tools/list`: return `[...TOOLS, ...SSH_TOOLS, ...APP_SKILL_TOOLS]` only when both
     `options.skills` and `options.db` are present; otherwise return `[...TOOLS, ...SSH_TOOLS]`.
   - Routing order exactly as design D8: no id -> `undefined`; `tools/list`; non-`tools/call` ->
     `handleRpc`; `tools/call` whose name is in `APP_SKILL_TOOL_NAMES` -> app skill path; other
     non-`ssh_` names -> `handleRpc`; `ssh_` names -> SSH.
   - App path: missing `skills` or `db` returns a successful text result
     `{ ok: false, code: "unavailable", message: "skills are not configured" }`; otherwise build the
     context `{ db, skills, manager? }` and call `callAppSkillTool`. Normalize non-object
     `params.arguments` to `{}`. Add a `try/catch` around the app-skill branch (wrapping the whole
     dispatcher body is also acceptable) that returns `textResult(toSkillFailure(error))`; this is a
     last resort because `callAppSkillTool` already maps its own failures.
3. **`src/http/internal-mcp.ts`** - on the non-master branch, pass the fifth argument
   `{ db: deps.db, ...(deps.skills === undefined ? {} : { skills: deps.skills }),
   ...(deps.manager === undefined ? {} : { manager: deps.manager }) }`. Do not change the master
   branch or construct a `SkillService`.

### Acceptance criteria

- A1: app token `tools/list` contains `TOOLS`, `SSH_TOOLS`, and the six `APP_SKILL_TOOLS`; a context
  without `skills`/`db` omits the six; the master list is unchanged.
- A13 (advertisement portion): missing service omits the six and a direct call returns
  `unavailable`.
- Routing preserves handoff and SSH behavior for existing names.

### Tests

- Extend `test/mcp-http.test.ts`'s fixture/deps to optionally provide `skills` (a
  `SkillService({ db })`) and a stub `manager`.
- Add A1: app token `tools/list` contains all three groups; a deps object without `skills` omits
  the six and a `create_skill` call returns `unavailable`; a direct four-argument
  `handleRpcAsync(service, ssh, agent, tools/list)` (or a call with only `manager` supplied) also
  omits the six, proving the default-options boundary.
- Keep the existing handoff, SSH, 401/204/400, and human-only tests green.

### Exit check

`test/mcp-http.test.ts` and the existing SSH/handoff suites pass; the six tools are advertised with
their exact schemas; no handler writes yet.

## Phase 3 - Read tools

### Boundaries / non-goals

- No mutation, target guard on reads, event, or restart behavior.
- Reads remain available while the caller's project/app is deleting.

### Files changed

- `src/skills/app-tools.ts`
- New: `test/app-skill-tools.test.ts`
- `test/mcp-http.test.ts` (dispatch smoke, if not covered by A1)

### Work

1. Add private `requireAppSkills(context)` returning `context.skills` or throwing
   `SkillToolError("unavailable", "skills are not configured")`.
2. Add `listSkills(context, target)`:
   - it takes no per-call arguments; the forbidden target keys were already rejected by the
     boundary, and other unknown keys are ignored;
   - `const resolved = skills.resolve(target)`;
   - return `{ ok: true, scope: "app", target, effective:
     resolved.effective.map((entry) => listEffectiveEntry(entry, target)), rows:
     resolved.rows.map(listRowEntry), disabled: resolved.disabled }`.
   - No target guard; no body or reference content in the projection.
3. Add `getSkill(context, target, args)`:
   - `const id = asPositiveInteger(args.skill_id, "skill_id")`;
   - `const row = skills.get(id)`; missing -> `unknownSkillError(id)`;
   - `assertSkillReadable(skills, row, target)`;
   - return `{ ok: true, skill: skillDetail(row) }`.
   - No target guard; only `get_skill` returns `content`, reference `content`, `metadataRaw`, and
     `storedIssues`.
4. Wire the `list_skills` and `get_skill` cases in `callAppSkillTool`.

### Acceptance criteria

- A6: effective global/project rows and the caller's own app row (including its tombstone/invalid
  row) are readable; sibling-app ids, other-project ids, and non-effective wider rows (disabled,
  invalid, or shadowed) return `unknown_skill`, not `internal_error`, with no body.
- A14 (read portion): `list_skills` contains no body sentinel; `get_skill` contains the body.
- A13 (malformed read ids): non-positive/non-integer ids return `invalid_argument`.

### Tests

- Create `test/app-skill-tools.test.ts` with an in-memory migrated DB, projects `p`/`q`, apps
  `p:a`, `p:b`, `q:c`, a `SkillService({ db })`, and a stub manager. Add a `call(agent, name, args)`
  helper over `callAppSkillTool` and a `expectFailure(result, code)` helper.
- Seed global, project, caller app, sibling app, other-project, disabled, invalid, and shadowed rows.
- Add the read suite: effective global/project, own tombstone/invalid, sibling/other-project
  unknown, disabled/invalid/shadowed wider unknown, list projection content-free, `get_skill` full
  body and `storedIssues`.
- Add A13 read-id boundary cases.

### Exit check

Read tests pass, no writes occur in the read suite, and the existing suites stay green.

## Phase 4 - Write tools: create, update, set enabled

### Boundaries / non-goals

- No override tool yet.
- No delete, revert, rename, scope change, or enabled flag on create.
- No restart call.

### Files changed

- `src/skills/app-tools.ts`
- `test/app-skill-tools.test.ts`

### Work

1. **Create**:
   - Build `SkillInput` with shared `skillInputFromArgs` (it rejects `enabled`); then
     `assertSkillTarget(db, "app", target)`.
   - In one `db.transaction`: re-run `assertSkillTarget`; call
     `skills.create("app", target, input, actor)`; insert one `app.skill_created` event with
     `actor`, `skillId`, `scope`, `projectId`, `appKey`, `name`, `referenceCount`, `contentBytes`,
     `referenceBytes`; return the row.
   - Catch `SkillConflictError` outside the transaction and throw
     `skillConflictError(skills, "app", target, name)` so `skill_exists` carries existing-row
     context; otherwise rethrow for `toSkillFailure`.
   - Return `{ ok: true, skill: skillSummary(row), ...skillMutationEnrichment(context, skills, row,
     target, false) }` (create omits `effective`/`storedIssues`, like the master).
2. **Update**:
   - Reject `name`, `enabled`, and the global four; parse `skill_id` and
     `skillUpdatePatchFromArgs`; reject an empty patch with `invalid_argument`; then
     `assertSkillTarget`.
   - Load the row, `unknown_skill` if missing, then `assertOwnAppSkillRow(row, target)` so a visible
     global/project row is `invalid_argument` and a sibling row is `unknown_skill`.
   - In one transaction: re-run the target guard, re-load, re-check ownership, call
     `skills.update(id, patch, actor)`, and insert one `app.skill_updated` event with `actor`,
     identifiers, `changed: Object.keys(patch)`, `contentBytes`, `referenceCount`, and
     `referenceBytes`.
   - Return the content-free summary plus enrichment with `includeState = true`.
3. **Set enabled**:
   - Reject every content and immutable field plus the global four; parse `skill_id` and
     `enabled`; then `assertSkillTarget`.
   - Load, `unknown_skill`, `assertOwnAppSkillRow`.
   - In one transaction: re-check, call `skills.update(id, { enabled }, actor)`, and insert one
     `app.skill_enabled` event with `actor`, identifiers, and `enabled`.
   - Return the content-free summary plus enrichment with `includeState = true`.
4. Define one shared actor helper `appActor(agent)` returning `app:${agent.projectId}:${agent.appKey}`
   and use it for `updated_by` and every event.
5. Wire `create_skill`, `update_skill`, and `set_skill_enabled` in `callAppSkillTool`.

### Acceptance criteria

- A2: no schema/handler accepts `scope`/`project_id`/`app_key`/`confirm_global`; supplying any
  returns `invalid_argument` and creates no row; a service `SkillValidationError` (for example an
  invalid reference path) returns `invalid_skill`, never `internal_error`.
- A3: create persists every bundle field through `skills.get`, sets
  `updated_by = app:<projectId>:<appKey>`, and writes one `app.skill_created` event.
- A4: app duplicate returns `skill_exists` (not `internal_error`) with existing
  id/updatedBy/updatedAt and creates no second row; the master conflict regression stays green.
- A5: an app create shadows same-name global/project rows, reports `shadows` wide-to-narrow,
  `shadowedBy: []`, and caller `appsInScope`.
- A7: update changes each mutable field; global/project -> `invalid_argument`, sibling ->
  `unknown_skill`; rows are unchanged on rejection.
- A8: disable creates a tombstone that hides a wider same-name row; global/sibling ids are
  `invalid_argument`/`unknown_skill` and unchanged.
- A10 (create/update/set): with `projects.deleting = 1` or `apps.deleting = 1` and well-formed
  arguments, these mutations return `deletion_pending` before row inspection, including when naming
  a global/sibling row.
- A11 (these mutations): exactly one `scope='app'` event with no body/description/reference
  content/metadata values; a forced event insert failure rolls back the row and references.
- A13 (malformed write arguments): with a live (non-deleting) caller, malformed ids/flags return
  `invalid_argument` and write nothing.
- A14 (these mutations): the `skill` projection omits body/reference content, `metadataRaw`, and
  `storedIssues`; top-level `storedIssues` may carry content-free issue entries.

### Tests

- Extend `test/app-skill-tools.test.ts` with the create/update/set suites:
  - create full bundle and actor/event; duplicate with context; wider shadowing;
  - update each field, clear metadata/references, reject empty/immutable/enabled/global/sibling;
  - set enabled true/false, tombstone hiding a wider row, reject global/sibling/content fields;
  - target guard for deleting project and app, including a global/sibling id;
  - event payload and rollback (`DROP TABLE events`, assert no row and no `skill_references`);
  - malformed argument cases.
- Re-run the existing master create/management suite as the A4/A15 regression.

### Exit check

Create/update/set tests pass; the only remaining app tool without a handler is `override_skill`;
the existing suites stay green.

## Phase 5 - Override, audit, restart reporting, transport

### Boundaries / non-goals

- No delete/revert/rename, no target scope choice, no automatic restart, no self-restart.
- No new HTTP route, quota, pagination, or rate limit.

### Files changed

- `src/skills/app-tools.ts`
- `test/app-skill-tools.test.ts`
- `test/mcp-http.test.ts` (A16 wiring if not added in Phase 2)

### Work

1. **Override**:
   - Reject the global four, plus content/name fields and `skill_id`; parse `source_skill_id`
     (positive integer), optional `enabled`, and optional `confirm_replace` (default false;
     non-boolean -> `invalid_argument`); then `assertSkillTarget(db, "app", target)`.
   - Load the source (`unknown_skill` if missing). Check in this exact order:
      `skillVisibleAt(source, target)` -> `unknown_skill`; `isSameSkillTarget(source, "app",
      target)` -> `invalid_argument` self-copy; `assertOverridableSource(source)` ->
      `invalid_skill`; app-only `assertAppOverrideSource(source)` -> `invalid_skill` for a disabled
      source or invalid name (so a disabled source with a same-name target row never reaches
      replacement confirmation); exact target row from `skills.resolve(target).rows` with the same
      name and no `confirm_replace` -> `replacementConfirmationError`.
    - In one transaction: re-run the target guard; re-load the source; repeat visibility, self-copy,
      source validation, app-only source enabled/name validation, and replacement confirmation; call
      `skills.override(sourceId, "app", target, enabled, actor)`; insert one
      `app.skill_overridden` event with `actor`, `sourceSkillId`, `skillId`, `scope`, `projectId`,
      `appKey`, `name`, `enabled`, `referenceCount`.
    - Define private `assertAppOverrideSource(source)` in `src/skills/app-tools.ts`: throw
      `SkillToolError("invalid_skill", ...)` when `!source.enabled` or `!isSkillName(source.name)`.
      It is app-only, so the master's `assertOverridableSource` behavior is unchanged.
   - Return the content-free summary plus enrichment with `includeState = true`.
   - Wire `override_skill`, removing the Phase 2 placeholder.
2. **Audit**:
   - Verify the four event payloads against design D5's table exactly. Every payload includes the
     actor; none includes body, description, reference content, or metadata values.
   - Confirm every mutation writes exactly one event and every read writes none.
   - Confirm the event insert is inside the same outer transaction as the service call; a forced
     `events` insert failure maps to `internal_error` and rolls back the row and references.
3. **Restart reporting**:
   - App mutations call `skillMutationEnrichment`, which reads
     `` context.manager?.pendingRestart(`${row.projectId}:${row.appKey}`) ``; fail-open with
     `warnings:["post_create_enrichment"]`.
   - Assert no `ensure` or `restartIfRunning` call exists in the app path; only `pendingRestart` is
     used. No start/restart tool is advertised.
4. **Transport**:
   - Do not add a per-app quota. The service limits and the 1 MiB `/internal/mcp` bound stand.
   - A17 is satisfied by citing the inherited master transport test at
     `test/master-http.test.ts:246-313` (same route, same 1 MiB bound, 413 before dispatch, no
     extra row). Do not duplicate the 1 MiB assertion in a second test.

### Acceptance criteria

- A9: override copies a visible global/project source into the caller's app; self-copy is
  `invalid_argument`; an exact target row without `confirm_replace` is
  `replacement_confirmation_required` with the pass-`confirm_replace: true` message; a
  disabled/invalid/stored-issue visible source is `invalid_skill`; an invisible sibling source with
  stored issues is `unknown_skill` (visibility checked before source validation).
- A10 (override): a deleting caller with well-formed arguments returns `deletion_pending` before
  source/row inspection.
- A11 (all mutations): content-free one-event audit and rollback.
- A12: a stub manager returning `{pending:true,reasons:["settings_changed"]}` is reported; the
  manager's `ensure`/`restartIfRunning` spies are never called.
- A13 (complete): missing context omits the tools and returns `unavailable`; with a live caller,
  malformed arguments write nothing.
- A14 (complete): no sentinel body in mutations/list; mutation `skill` omits `storedIssues`;
  top-level update/set/override `storedIssues` are content-free; `list_skills.rows` carries the
  content-free stored issue entries; `get_skill` returns body and reference contents.
- A17: inherited transport test cited and green.

### Tests

- Extend `test/app-skill-tools.test.ts` with the override suite: global/project copy; self-copy;
  replacement confirmation; disabled/invalid/stored-issue source (including a disabled source with
  an existing same-name app row and no `confirm_replace`, which must return `invalid_skill`, not
  `replacement_confirmation_required`); invisible sibling source with stored issues; confirm
  replacement; deleting caller target guard.
- Add the A11 rollback for override and assert exactly one event per successful mutation.
- Add A12: manager stub with a `pendingRestart` spy and `ensure`/`restartIfRunning` spies that throw
  or record; assert `pendingRestart` is observed and the other two are not.
- Re-run `test/master-http.test.ts:246-313` for A17 and `test/manager.test.ts:815-981` as the
  restart-hash regression.
- Add A16 in `test/mcp-http.test.ts` if not already present:
  - wire `deps.db`, a real `SkillService` over that db, and a manager stub;
  - a non-master token `tools/call` `create_skill` succeeds end-to-end;
  - a spy on `skills.create` proves the same `deps.skills` instance reached the handler;
  - the manager stub's `pendingRestart` observed `p:a`;
  - a master token `tools/list` still equals `MASTER_TOOLS`.

### Exit check

All app tool tests pass, A1-A14 and A16 are covered, the inherited A17 test is cited/green, and the
only manager methods used by app tools are `pendingRestart`.

## Phase 6 - Docs and full gates

### Boundaries / non-goals

- Docs and verification only; no behavior, test, schema, dependency, or route changes.
- Do not modify `docs/open-questions.md`, `docs/design/slash-commands.md`, or any stage
  `0021-slash-commands` content.

### Files changed

- `docs/current-state.md`
- `docs/journal/0024-app-skill-authoring.md` (new at execution)
- `docs/plans/README.md`, `docs/journal/README.md` (stage entries)
- `docs/design/README.md` (existing app-skill status line only, if recording)

### Work

1. **`docs/current-state.md`** - add one bullet at the end of `## Agent skills`, before
   `## Master agent`, stating truthfully:
   - ordinary app agents can create/list/get/update/enable-disable/override their own app-scope
     skills through the production app MCP surface (`/internal/mcp` via the remote bridge);
   - the six tool names and the token-bound target; no `scope`/`project_id`/`app_key`/
     `confirm_global`;
   - `list_skills` and mutations are content-free, `get_skill` is body-bearing and limited to
     effective rows plus the caller's own app rows;
   - same-scope duplicates conflict, wider same-name rows are shadowed/overridable;
   - delete/revert/rename remain operator-only;
   - every mutation audits `scope='app'` with actor `app:<projectId>:<appKey>`, reports
     `pendingRestart`, and never restarts automatically;
   - human `/api/skills*` authorization is unchanged and app tokens still receive
     `403 human_only`.
   Do not change the existing human-API bullet; it remains true.
2. **`docs/journal/0024-app-skill-authoring.md`** - record the stage: design/plan links, shipped
   files, the A1-A17 evidence table, gate command results, assumptions, and residual accepted risk
   (D9). Do not include host-specific or real project/app data.
3. **Indexes**:
   - Add the 0022 plan entry to `docs/plans/README.md` and the 0024 journal entry to
     `docs/journal/README.md`.
   - `docs/design/README.md` already carries the app-skill entry; update only its status text if
     recording. Do not stage it while the 0021 changes are uncommitted.
   - The repository still contains uncommitted `0021-slash-commands` changes in these files. Leave
     them untouched and never stage `docs/open-questions.md`. **Defer all index staging until 0021
     is committed.** If staging before then is unavoidable, use line-level `git add -p` (split/edit)
     or `git apply --cached` so only this stage's lines are staged, and verify `git diff --cached`
     contains no 0021 line.
4. **Constraint checks**:
   - Confirm `src/store/migrations.ts` is unchanged; the schema remains `[1..13]`.
   - Confirm `package.json`/`package-lock.json` dependencies are unchanged.
   - Confirm `src/http/server.ts` has no new route; only `/internal/mcp` behavior changed in
     `src/http/internal-mcp.ts`.
   - Confirm the direct-DB `src/mcp/server.ts` path is unchanged.
5. **Gates** - run the full verification block below. If an unrelated `0021-slash-commands` edit
   fails a gate, report the failing files and do not modify them.
6. **Record evidence** - put the final gate results and A1-A17 mapping in the journal. Stop at the
   review/execute gate; do not commit.

### Acceptance criteria

- A15: schema version, dependencies, and routes unchanged; master/human/materialization/hash/
  restart suites green; `test/skills-http.test.ts:265-287` still proves app-token
  `403 human_only`.
- Docs describe the implemented surface truthfully and do not claim app delete/revert/rename or
  automatic restart.
- No stage `0021-slash-commands` file or index line is included in this stage's **staged** changes.

### Tests

- Run the full suite and all gates; no new tests in this phase.

### Exit check

All verification commands pass; the journal contains the evidence; the **staged** diff contains only
this stage's hunks, while the unrelated 0021 changes remain unstaged and untouched.

## Test plan

Order: add each phase's tests with that phase (or immediately before its handler), observe the
expected failure on the pre-phase tree, then implement. A1/A13 fail before Phase 2 because the app
surface is absent; A2-A14 fail before their phase because the handler is unimplemented or the row
is absent; A15-A17 are regression or cited checks that stay green before and after.

### New: `test/app-skill-tools.test.ts`

Local fixture (do not add a shared helper file):

- `openDatabase(":memory:")`, `runMigrations`, insert projects `p` and `q` and apps `p:a`, `p:b`,
  `q:c`; return `{ db, skills: new SkillService({ db }), manager }`.
- `agent(projectId, appKey)` returns
  `` { appId: `${projectId}:${appKey}`, projectId, appKey } ``.
- `call(agent, name, args)` calls `callAppSkillTool({ db, skills, manager }, agent, name, args)`.
- `expectFailure(result, code)` asserts `{ ok: false, code }` (the handler maps, it does not throw).
- Seed rows with `skills.create(...)` and direct SQL for invalid metadata/name tombstones.
- Manager stub:
  ```ts
  const pending: string[] = [];
  const restartCalls: string[] = [];
  const ensureCalls: string[] = [];
  const manager = {
    pendingRestart: (appId: string) => {
      pending.push(appId);
      return { pending: true, reasons: ["settings_changed"] };
    },
    ensure: async (app: { id: string }) => {
      ensureCalls.push(app.id);
    },
    restartIfRunning: async (app: { id: string }) => {
      restartCalls.push(app.id);
      return true;
    },
  } as unknown as InstanceManager;
  ```

Coverage:

- A1 schemas: deep-equal each of the six `APP_SKILL_TOOLS` objects to design §5.2 (name, description,
  inputSchema), not just names/required fields; no `scope`/`project_id`/`app_key`/`confirm_global`.
- A2: forbidden arguments on every tool; `enabled` on create; invalid reference path ->
  `invalid_skill`.
- A3: full bundle round-trip, actor, one `app.skill_created` event.
- A4: duplicate -> `skill_exists` with existing context and no second row.
- A5: global/project shadowing; `shadows` wide-to-narrow, `shadowedBy: []`, caller
  `appsInScope`.
- A6: readable set: effective global/project, own app tombstone/invalid; sibling/other-project and
  disabled/invalid/shadowed wider -> `unknown_skill`.
- A7/A8: every mutable update field; enable/disable tombstone; global/project/sibling rejection and
  unchanged rows.
- A9: override copy, self-copy, replacement confirmation, disabled/invalid/stored-issue source,
  invisible sibling source with stored issues.
- A10: deleting project and app for create/update/set/override with well-formed arguments, including
  a global/sibling id; reads still work.
- A11: exactly one event per mutation; payload keys from design D5; no sentinel content; rollback
  by `DROP TABLE events`.
- A12: `pendingRestart` reported; `ensureCalls` and `restartCalls` stay empty.
- A13: no skills context -> `unavailable`; with a live caller, malformed ids/flags ->
  `invalid_argument`, no writes.
- A14: sentinel body absent from create/update/set/override/list; mutation `skill` omits
  `storedIssues`; top-level `storedIssues` content-free; list rows carry issue entries; `get_skill`
  returns body/reference contents.

### Extend: `test/mcp-http.test.ts`

- Add optional `skills` and `manager` to `deps`/fixture; keep the existing handoff and 401/204/400
  tests unchanged.
- A1: app token `tools/list` includes `TOOLS` + `SSH_TOOLS` + six app tools; a deps object without
  `skills` omits the six; a direct `create_skill` call returns `unavailable`.
- A16: a real `handleInternalMcp` request with `deps.db`, a `SkillService` over that db, and a
  manager stub:
  - app token `create_skill` succeeds;
  - a spy on `skills.create` proves the same instance;
  - the manager stub observes `pendingRestart("p:a")`;
  - master token `tools/list` still equals `MASTER_TOOLS` (add `ensureMasterAgent` to the fixture
    only for this test; create the fixture `workspace` directory first with
    `mkdirSync(workspace, { recursive: true })`, because `ensureMasterAgent` requires it).
- Routing regression: an `ssh_` name still goes to the SSH path and a handoff name still goes to
  `handleRpc`.

### Extend: `test/skills-store.test.ts` (Phase 1)

Add the small unit `describe("shared skill access predicates")` for `skillVisibleAt`,
`isOwnAppSkillRow`, `skillRowTarget`, and `isSameSkillTarget` across global, project, caller-app,
sibling-app, and other-project rows. This pins the extraction without a database or service.

### Regression-only (no edits)

- `test/master-tools.test.ts` - the existing create/management cases (`:361`, `:391`, `:469`,
  `:521`, `:594`, `:783`, `:819`, `:964-1840`) are the Phase 1/A4/A15 regression. Only add a test if
  one of those fails for a reason not already asserted; do not duplicate them.
- `test/master-http.test.ts` - cite `:246-313` as the inherited A17 transport test; no duplicate.
- `test/skills-http.test.ts` - cite `:265-287` for the A15 `403 human_only` assertion; no edit.
- `test/manager.test.ts` - cite `:815-981` for `pendingRestart` truthfulness with skill hashes; no
  edit. The app test only proves the stub is forwarded and no restart method is called.

### Acceptance coverage

| Check | Where |
| --- | --- |
| A1 | `test/mcp-http.test.ts`, `test/app-skill-tools.test.ts` schemas |
| A2 | `test/app-skill-tools.test.ts` boundary suite |
| A3 | `test/app-skill-tools.test.ts` create suite |
| A4 | `test/app-skill-tools.test.ts` duplicate; `test/master-tools.test.ts:594` |
| A5 | `test/app-skill-tools.test.ts` shadowing |
| A6 | `test/app-skill-tools.test.ts` read suite |
| A7 | `test/app-skill-tools.test.ts` update suite |
| A8 | `test/app-skill-tools.test.ts` set-enabled suite |
| A9 | `test/app-skill-tools.test.ts` override suite |
| A10 | `test/app-skill-tools.test.ts` deletion suite |
| A11 | `test/app-skill-tools.test.ts` event/rollback suite |
| A12 | `test/app-skill-tools.test.ts` manager spies; `test/manager.test.ts:815-981` |
| A13 | `test/app-skill-tools.test.ts`; `test/mcp-http.test.ts` unavailable |
| A14 | `test/app-skill-tools.test.ts` projection assertions |
| A15 | `test/skills-http.test.ts:265-287`; `test/master-tools.test.ts`; schema/dependency/route diff |
| A16 | `test/mcp-http.test.ts` end-to-end wiring |
| A17 | `test/master-http.test.ts:246-313` (inherited, cited) |

## Risks and mitigations

| Risk | Mitigation |
| --- | --- |
| Import cycle from shared skill modules | `access.ts` type-imports only; all cross-layer type edges use `import type`; typecheck and the module graph are reviewed in Phase 1. |
| Shared DB connection breaks audit atomicity | Forward `deps.db` and `deps.skills` together; never construct a service in the handler; A16 asserts instance identity via a spy. |
| Event consumer compatibility | No production reader exists; `scope='app'`/`app.skill_*` rows are additive; existing master/deletion filters stay untouched. |
| Master regression from extraction | Phase 1 is move-and-rewire only; run the full master/skills suites; `lifecycleError` maps `SkillToolError` to the same codes. |
| Deletion race between guard and write | Guard before and inside the synchronous transaction; no `await` inside; deletion cannot commit between them in one Node process. |
| `get_skill` exposes wider non-effective rows | Readable set is own app row or chain-visible **and** present in `resolve(target).effective`; tests cover disabled/invalid/shadowed wider rows. |
| Mutation errors reveal that a chain-visible wider row exists | Accepted per design §9: `update_skill`/`set_skill_enabled` on a visible wider row return `invalid_argument`, and `override_skill` on a visible disabled/invalid source returns `invalid_skill`; sibling/other-project rows stay `unknown_skill`, and no body/content is exposed. |
| Test fixture complexity | Reuse the master-tools in-memory DB pattern; seed only the rows each assertion needs; no new shared helper file. |
| Accidentally adding delete/revert/rename | Tool lists omit them; `update_skill` rejects name changes; A2/A7 enforce it. |
| Accidentally adding restart | No `ensure`/`restartIfRunning` calls in the app path; only `pendingRestart` is read; A12 spies enforce it. |
| Stage `0021-slash-commands` leaks into this stage | Do not edit its files or index lines; stage this stage's hunks only; inspect `git diff --cached` before any owner-authorized commit. |

## Non-goals

- Deleting, reverting/discarding, renaming, or moving a skill; any deletion of an app-created
  tombstone.
- Writing global or project skills, or any sibling application's skills.
- Automatic restarts, self-restart, or a start/restart tool on the app surface.
- Changing the name, shadowing, override, uniqueness, or resolution rules.
- Changing human `/api/skills*` authorization, the human UI, or the 4 MiB human body limit.
- Changing `SkillService` validation, materialization, hashing, collision scanning, or deletion.
- A new HTTP route, a second registry, a schema migration, an npm dependency, per-app quotas, rate
  limits, pagination, bulk import/export, assignment, or version history.
- Extending the direct-DB `hanse mcp` fallback; managed apps use the remote bridge.

## Verification

Run exactly:

```bash
npm run lint
npm run typecheck
npm test
npm run build
npm run check:sensitive
```

Definition of Done:

- [x] A1-A17 are mapped to passing evidence as in the acceptance coverage table.
- [x] The six tools are advertised only by a fully wired non-master context and only written at the
      caller's app target.
- [x] No app tool accepts a target/scope argument; forbidden arguments are `invalid_argument` and
      write nothing.
- [x] `get_skill` is limited to effective rows plus the caller's own app rows; mutation/list
      projections are content-free.
- [x] Every mutation writes one content-free `scope='app'` event with actor
      `app:<projectId>:<appKey>` in the same transaction as the skill write; a failed event insert
      rolls back.
- [x] `pendingRestart` is reported and no start/restart method is called.
- [x] No migration, dependency, route, delete/revert/rename, automatic restart, quota, or
      pagination was added.
- [x] Human `/api/skills*` auth and the master surface are unchanged.
- [x] `docs/current-state.md` is updated truthfully and the journal `0024` records the evidence.
- [x] All five verification commands pass.
- [x] No stage `0021-slash-commands` file or line is included.
- [x] Committed as one coherent stage commit after explicit owner instruction; no stage 0021 file or
      line was included.

## Review

Plan review (momus): **PASS** with non-blocking clarifications; no blockers. The findings were folded
into this revision:

| Finding | Resolution |
| --- | --- |
| Phase 6 staging/exit check was not executable while `0021-slash-commands` is uncommitted; "stage only that hunk" would include adjacent 0021 lines and the "working diff" exit check could not pass. | Defer index staging until 0021 is committed, or use line-level staging; never stage `docs/open-questions.md`; the exit check now targets the **staged** diff and leaves 0021 changes unstaged. |
| A9: a disabled visible source with a same-name target row could return `replacement_confirmation_required` before the service's `invalid_skill`. | Added app-only `assertAppOverrideSource` (`!source.enabled` or invalid name -> `invalid_skill`) before replacement confirmation; master behavior is unchanged. |
| Dispatcher outer catch was described as "keep" but none exists. | Phase 2 now adds a last-resort `try/catch` around the app-skill branch; `callAppSkillTool` still maps its own failures. |
| A13/A10 precedence was ambiguous for malformed arguments on a deleting caller. | Invariants now fix the order: identity/forbidden keys -> argument type/parse -> target guard -> row load/ownership -> transaction. A13 tests use a live caller; A10 uses well-formed arguments. |
| A1 could be satisfied by checking only names/required fields. | A1 now deep-equals all six tool definitions to design §5.2. |
| A17 cited `test/master-http.test.ts:246-309`, which excludes the no-extra-row assertion. | Corrected to `:246-313`. |
| A16's `ensureMasterAgent` fixture needs the workspace directory to exist. | Test plan now creates the fixture workspace with `mkdirSync(..., { recursive: true })`. |
| Phase 1 said the suites run "unchanged" while adding a predicate suite, and its exit check used an unscoped `git diff`. | Wording tightened: only the predicate suite is added; the exit check is scoped to the extraction files and excludes 0021. |
| `recordEvent` call-site rewrite did not mention the master ternary call. | Phase 1 now names the `cleared ? "master.setting_cleared" : "master.setting_changed"` call site. |
