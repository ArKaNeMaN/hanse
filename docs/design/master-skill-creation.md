# Design - Master-authored skills

Status: **approved** - design review rounds 1-3 (`oracle`); rounds 1 and 2 returned CHANGES
REQUESTED, round 3 left no blockers or majors and three documentation clarifications, which are
folded in. Implementation permitted.
Scope: add one master-agent tool that creates a complete, enabled agent skill bundle at global,
project, or application scope, reusing the existing `SkillService` registry, validation, hierarchy,
and restart semantics.
Out of scope: updating, deleting, enabling/disabling, overriding, copying, reading, or listing
skills from the master; creating skills inside the reserved master project/application; automatic
agent restarts; skill import/export; any database migration or npm dependency.

## 1. Problem

The master agent can create projects, add applications, write their `AGENTS.md`, change non-secret
settings, and start/restart agents. Skill management is the remaining configuration surface that is
still operator-only, and the master prompt explicitly says so. An operator who asks the master to
"set up this agent with a release-checklist skill" must still leave the chat and open the skills UI.

The skills stage already models a skill as a DB-backed bundle with hierarchical resolution and makes
the human API/UI the authoritative creation path. This stage exposes the create half of that path to
the master without duplicating validation or granting raw filesystem/database access.

## 2. Requirements

| ID | Requirement |
| --- | --- |
| MS1 | The master exposes one `create_skill` tool that creates an enabled skill at `global`, `project`, or `app` scope. |
| MS2 | The tool accepts the full bundle: `name`, `description`, `content`, optional `license`, `compatibility`, `metadata`, and `references` (`path` + `content`). |
| MS3 | Creation is performed by `SkillService.create`; the tool adds no independent slug, frontmatter, metadata, reference, size, or uniqueness rules. |
| MS4 | Project and application targets must exist and must not be pending deletion. Global scope accepts no target ids. |
| MS5 | The reserved master project/app is never a creation target (`master_protected`). |
| MS6 | Global creation requires `confirm_global: true` after the master has asked the operator; it is the only scope that can affect the master itself. Missing/false confirmation is `confirmation_required`; a non-boolean value or `confirm_global` on a non-global scope is `invalid_argument`. |
| MS7 | A same-name row at the same target scope fails with `skill_exists` and identifies the existing row; a narrower row with a wider skill's name is allowed and shadows it, as in the human hierarchy. The result also reports narrower same-name scopes that may override the new row. |
| MS8 | The tool never restarts an agent. Its result reports `appsInScope: {total, running}`, `shadows` (all wider same-name scopes in the target hierarchy, as returned by `resolve`), `shadowedBy` (narrower same-name scopes that may override or hide the new row), and, for app scope, the target's `pendingRestart` state. |
| MS9 | A successful creation and its `master.skill_created` event commit in one database transaction. If the audit insert fails, the skill insert rolls back and the tool reports `internal_error`. |
| MS10 | The event contains identifiers, name, reference count, and stored byte sizes; no skill body, description, reference content, or metadata value is recorded. |
| MS11 | The change adds no migration, no dependency, and no new HTTP route. The existing `/internal/mcp` body limit remains 1 MiB, which is sufficient for the maximum valid bundle as sent by the master's `JSON.stringify`-based MCP client. A hypothetical client that encodes every non-ASCII character as `\uXXXX` can exceed the transport limit; that is a transport-level 413, not a bundle-validation rule. |
| MS12 | Master instructions advertise the tool, state its scope/format/confirmation rules, and no longer claim that all skill editing is operator-only; updating, enabling/disabling, and deleting remain operator-only. |
| MS13 | Human skills routes, authorization, validation, resolution, materialization, and restart hashing are unchanged. |
| MS14 | The operator-facing master notices and all tracked docs describe the new capability truthfully, including its limitations. |
| MS15 | A response never echoes `content`, reference content, `metadataRaw`, or `storedIssues`. |
| MS16 | A post-commit result-enrichment failure (`shadows`, `shadowedBy`, `appsInScope`, or app-scope `pendingRestart`) does not turn a committed skill into a tool error; it returns `ok:true` with a warning and a false/empty enrichment value. |

## 3. Verified facts

- `SkillService.create(scope, target, input, actor)` is the authoritative creation path
  (`src/skills/service.ts`). It validates the scope/target shape, name, description, content,
  optional fields, reference paths/content/counts/aggregate, uniqueness, and writes the skill and
  references in one transaction. It does not check that the project/app exists and has no principal
  concept; `actor` is stored in `updated_by`.
- `SkillInput` is the structured bundle shape: `{name, description, content, enabled?, license?,
  compatibility?, metadata?, references?}`. The service generates `SKILL.md`; the master must not
  submit raw Markdown with frontmatter. `enabled` defaults to `true`.
- The human HTTP layer additionally enforces human-only auth, same-origin mutations, target
  existence, body parsing (`bundle`, JSON-string metadata/references), action dispatch, and response
  mapping. None of that is inherited by a direct service call.
- `SkillConflictError` (`code = "skill_exists"`) is thrown by `create` on a duplicate
  `(scope, project_id, app_key, name)`; `SkillValidationError` (`code = "VALIDATION"`, optional
  `field`) covers field failures.
- Scope keys are global `("", "")`, project `(projectId, "")`, app `(projectId, appKey)`.
  Resolution is global -> project -> app by name; the narrowest valid enabled row wins.
- A skill mutation changes the effective hash only when it changes the effective set; the manager's
  `pendingRestart` derives `settings_changed` from the composite hash. Mutations never restart.
- `MasterToolContext` currently carries `db`, `workspaceRoot`, optional `settings`, `manager`, and
  `deletion`; `HttpDeps.skills` exists but is not forwarded to the master.
- `MASTER_TOOLS` is the allowlist and `callMasterTool`'s switch is the dispatch; both must change.
  Input schemas are declarative only and are not enforced automatically.
- Master errors are returned as a successful JSON-RPC result containing
  `{ok:false, code, message}` text. `lifecycleError` maps domain errors; it does not know the two
  skill errors yet.
- The master prompt currently lists 12 tools and states that skill editing is operator-only.
- `skills` has no foreign key to `projects`/`apps`; a target can be deleted concurrently with a
  direct create. The coordinator is a single Node process and better-sqlite3 is synchronous, so an
  in-transaction re-check is race-safe for coordinator-driven deletions. Nested better-sqlite3
  transactions use savepoints; an exception after the inner create rolls the whole outer transaction
  back (verified locally).
- Maximum valid bundle size: 48,000 body characters; at most 20 references totaling 192,000
  characters; metadata JSON at most 16,384 characters. With the master's `JSON.stringify`-based MCP
  client, the worst-case envelope is: `content` 48,000 control characters x 6 bytes = 288,000;
  references 192,000 three-byte UTF-8 characters = 576,000; metadata ~16,384 three-byte characters
  = ~49,000; description/license/compatibility plus JSON-RPC envelope ~6,000; total ~919,000 bytes,
  about 129 KiB below the 1 MiB `/internal/mcp` limit. A client that escapes every non-ASCII
  character as `\uXXXX` can exceed 1 MiB on references alone; that is outside the supported
  transport profile and is rejected by the server before tool dispatch.

## 4. Decisions

### D1 - One create-only tool with an explicit scope and a global confirmation

A single tool is consistent with `set_setting`'s scope model and avoids three near-identical tools:

```json
{
  "name": "create_skill",
  "description": "Create an enabled skill bundle at global, project, or application scope. Global scope requires confirm_global after operator approval. A same-name skill at the same scope is rejected; a narrower same-name skill shadows a wider one. Creating a skill never restarts agents.",
  "inputSchema": {
    "type": "object",
    "properties": {
      "scope": { "type": "string", "enum": ["global", "project", "app"] },
      "confirm_global": { "type": "boolean" },
      "project_id": { "type": "string" },
      "app_key": { "type": "string" },
      "name": { "type": "string" },
      "description": { "type": "string" },
      "content": { "type": "string" },
      "license": { "type": ["string", "null"] },
      "compatibility": { "type": ["string", "null"] },
      "metadata": { "type": "object", "additionalProperties": { "type": "string" } },
      "references": {
        "type": "array",
        "items": {
          "type": "object",
          "properties": { "path": { "type": "string" }, "content": { "type": "string" } },
          "required": ["path", "content"]
        }
      }
    },
    "required": ["scope", "name", "description", "content"]
  }
}
```

`scope` is required and is validated in the handler against the three-value enum before any target
work. Omitted, non-string, or unknown scope returns `invalid_argument` and creates nothing; it must
never fall through to `global` or `app`. `project_id` is required for `project`/`app`; `app_key` is
required for `app`; the existing `targetFor` helper enforces that shape. For global scope,
`confirm_global` must be exactly boolean `true` after the operator has approved; a missing or
non-boolean value is `confirmation_required` for `false`/absent and `invalid_argument` for any other
type. `confirm_global` on a non-global scope is `invalid_argument`. The tool always creates an
enabled skill; an `enabled` argument is rejected as `invalid_argument` rather than passed through,
because a `false` value would create a tombstone that hides an operator-managed wider skill.

Alternatives rejected: three scope-specific tools (duplicated schema and dispatch), raw `SKILL.md`
input (bypasses generated frontmatter and the structured source of truth), direct filesystem writes
(bypasses DB, hash, and materialization), accepting `enabled` (silent tombstone creation), and
calling the human HTTP API internally (cookie/origin semantics and double parsing for no benefit).

### D2 - Reuse the skill service and its validators

The handler builds a `SkillInput` from an explicit field allowlist and calls
`SkillService.create(scope, target, input, "master")`. It performs only boundary checks that
TypeScript and safe dispatch need: `name`/`description`/`content` are non-empty strings; optional
`metadata` is a plain object; optional `references` is an array of objects with string `path` and
`content`; `license`/`compatibility` are string or null; `enabled` is rejected. The service remains
the sole authority for slug rules, lengths, metadata keys and values, reference paths/content/
counts/aggregate, uniqueness, and normalization. Errors map to:

| Failure | Master code |
| --- | --- |
| missing, `false`, or non-boolean `confirm_global` for global scope | `confirmation_required` except a non-boolean value, which is `invalid_argument` |
| `SkillValidationError` | `invalid_skill`, message prefixed with `field` when present |
| `SkillConflictError` | `skill_exists` (with existing row context) |
| missing skill service | `unavailable` |
| malformed boundary argument (`scope`, ids, `enabled`, field types) | `invalid_argument` |

This keeps one validation implementation and makes the human UI and the master produce identical
stored bundles for identical input.

### D3 - Target guards, an in-transaction re-check, and the global self-modification risk

`create_skill` validates the target shape first (`targetFor`), then, for non-global scopes:

1. the project row must exist (`unknown_project`);
2. if the project is the reserved master project, refuse (`master_protected`); for app scope, also
   refuse `isMasterApp` (`master_protected`);
3. the project must not be deleting (`deletion_pending`);
4. for app scope, the app row must exist (`unknown_app`) and must not be deleting
   (`deletion_pending`).

The same guard runs again inside the creation transaction immediately before `skills.create`. Since
the callback is synchronous and better-sqlite3 serializes writes, a deletion cannot commit between
that re-check and the insert. If deletion runs after the commit, the existing deletion service
removes the app/project-scoped skill rows, so no orphan survives. A deletion that is already in the
`stopForDeletion` window before `apps.deleting` is set can still let a row be created, but the
subsequent deletion removes it; no compensating delete is needed.

Global creation is different: it can affect every application, including the master, so refusing the
master's own project/app does **not** close self-persistence. The read-only master directory blocks
raw files, not global configuration. Global scope is therefore an explicit operator decision: the
tool requires `confirm_global: true`, the master instructions require it to ask the operator first,
and the event audits the result. This is an accepted, documented risk, not a claim that self-
modification is impossible. Global skills apply to the master on its next start like any other
global setting.

### D4 - Same-scope uniqueness, wider shadowing, conflict context

The service's unique key is per scope. A second `create_skill` with the same name at the same target
returns `skill_exists`. On conflict, the handler looks up the existing row at that exact scope via
`skills.resolve(target).rows` and includes its `id`, `updatedBy`, and `updatedAt` in the message;
no content is returned. The message tells the model to choose a different name or ask the operator
to edit the existing skill; there is no rename/update/delete tool. If the lookup fails, a generic
conflict message is used.

Creating the same name at a narrower scope succeeds and shadows the wider skill, matching hierarchy
semantics; the tool reports the wider same-name scopes in `shadows` as `resolve()` returns them,
including wider rows that are disabled or invalid. It also reports `shadowedBy`:

- global create checks same-name rows at project and app scope in any project;
- project create checks same-name rows at app scope in that project;
- app create always returns `[]`;
- rows in a project or app with `deleting = 1` are excluded;
- disabled tombstones are included because they hide the wider skill; rows with stored issues are
  also included conservatively even though resolution may skip them;
- the value is deduplicated and ordered `["project","app"]` filtered by the target scope.

`shadowedBy` is therefore a conservative scope-level warning, not a per-app effective-winner
calculation. Both `shadowedBy` and the global conflict lookup scan by `name`; the only relevant
indexes are the unique `(scope, project_id, app_key, name)` and `(project_id, app_key)`, so this is
an O(rows) scan. That is acceptable for an infrequent administrative mutation on a small table and
adds no index or migration.

The tool does not expose `override`: override copies an existing bundle and requires reading the
source, while `create` with full content is sufficient to define a narrower version. Reading,
updating, deleting, and copying skills are deferred.

### D5 - Result reports effect without content; enrichment cannot mask success

A successful call returns an explicit projection:

```json
{
  "ok": true,
  "skill": {
    "id": 12,
    "scope": "app",
    "projectId": "atlas",
    "appKey": "reviewer",
    "name": "release-checklist",
    "description": "...",
    "license": null,
    "compatibility": null,
    "metadata": {},
    "enabled": true,
    "references": [{ "path": "references/guide.md", "size": 412 }],
    "createdAt": "...",
    "updatedAt": "...",
    "updatedBy": "master"
  },
  "shadows": ["global"],
  "shadowedBy": [],
  "appsInScope": { "total": 1, "running": 0 },
  "pendingRestart": { "pending": false, "reasons": [] }
}
```

`skill.content`, reference contents, `metadataRaw`, and `storedIssues` are never included; `size` is
the UTF-8 byte length. For app scope, `shadowedBy` is always `[]`; a project-scope example would
show `shadowedBy: ["app"]` when an app row exists. `shadows` comes from the post-create
`resolve(target)` effective winner and lists all wider same-name rows at the target hierarchy,
including disabled or invalid ones (`[]` for global). `appsInScope` excludes applications and
projects with `deleting = 1`; `total`
counts all remaining apps in the target scope (all apps for global, project apps for project, one for
app) and `running` counts those whose runtime state is `running` or `starting`. `pendingRestart` is
present only for app scope (the existing helper returns a false result when no manager is
configured). Global and project creation do not compute pending state for every app; the
instructions direct the master to `hanse_list_projects` to see per-app `pendingRestart`.

The base `skill` projection is built from the returned row and cannot fail. `shadows`,
`shadowedBy`, `appsInScope`, and app-scope `pendingRestart` are enrichment: if any lookup throws,
the tool still returns `ok:true` with `shadows: []`, `shadowedBy: []`,
`appsInScope: {total: 0, running: 0}`, and/or `pendingRestart: {pending: false, reasons: []}` plus
`warnings: ["post_create_enrichment"]`. A post-commit read failure never turns a committed create
into an error.

### D6 - Create and audit commit atomically

After validation, the handler wraps the target re-check, `skills.create`, and the single
`master.skill_created` event in one `context.db.transaction(...)` call. `SkillService.create` uses a
nested transaction (savepoint), so an event-insert failure rolls back the skill row and references as
well; the tool returns `internal_error` and no skill exists. This is a fail-closed audit policy: a
successful mutation is always represented by a `master.skill_created` event.

The event payload is built from the stored row, not the raw arguments:

```json
{
  "type": "master.skill_created",
  "payload": {
    "skillId": 12,
    "scope": "app",
    "projectId": "atlas",
    "appKey": "reviewer",
    "name": "release-checklist",
    "referenceCount": 1,
    "contentBytes": 9123,
    "referenceBytes": 412
  }
}
```

No body, description, reference content, or metadata value is recorded. `contentBytes` and
`referenceBytes` reflect trimmed/normalized stored values. `updated_by = "master"` identifies the
master principal, not the human chat session; the event has no actor column, matching existing
master conventions.

### D7 - Forward the existing service, do not construct a second registry

`MasterToolContext` gains `skills?: SkillService`; `/internal/mcp` forwards `deps.skills` exactly as
it forwards settings/manager/deletion. Production already constructs one `SkillService` and passes it
to both HTTP and the manager, so the master sees the same database, clock, and validation instance.
If the service is absent, `create_skill` returns `unavailable` rather than silently constructing an
unconfigured registry.

`lifecycleError` gains `SkillValidationError` and a fallback `SkillConflictError` mapping. The
conflict case is normally intercepted in the handler to add existing-row context. No other master
tool changes behavior.

### D8 - Instructions, notices, and docs change with the surface

`MASTER_INSTRUCTIONS` changes:

- add `hanse_create_skill` to the tool list;
- add a recipe describing the required scope, the `confirm_global` rule, the lowercase-hyphen slug,
  the body-only `content` (no frontmatter), canonical `references/<slug>.md` paths, and the limits;
- state that the tool always creates enabled skills, `skill_exists` means choose another name or ask
  the operator, and `shadows` must be reported;
- state that app scope reports `pendingRestart`, while global/project scope requires
  `hanse_list_projects` to find pending apps; creation never restarts;
- state that global scope affects every application, including the master, so the operator must
  approve it first;
- state that there is no skill read/list/update/delete tool and the create result is the record;
  `hanse_get_app`/`hanse_read_file` are not the verification path for skills, and the existing
  "verify a mutation with `hanse_get_app`/`hanse_read_file`" rule gets an explicit skill-create
  exception;
- report both `shadows` and `shadowedBy`; `shadowedBy` is scope-level only;
- narrow the operator-only rule to "updating, enabling/disabling, or deleting skills".

Operator-facing master notices in `src/http/application.ts` and `src/http/dashboard.ts` change from
"skill editing" to "skill updating/deletion", and mention that creation is available in chat.
`docs/design/hanse-master.md` (tool table, tool context, error-code list, events, instructions,
deferred note, accepted debt), `docs/design/skill-bundles.md` (the "all skill management human-only"
and "future agent backdoor" statements are reconciled with the master-only, target-guarded,
audited create surface; the human HTTP API stays human-only), `docs/current-state.md` (tool
allowlist, master limitations), `docs/design/README.md`, `docs/plans/README.md`,
`docs/journal/README.md`, and the `README.md` feature bullet are updated.

### D9 - Verification and acceptance

The stage ships with tests for every fail-closed path:

| ID | Check |
| --- | --- |
| A1 | `tools/list` contains `create_skill`; the schema exposes `scope` and `confirm_global`. |
| A2 | Missing/invalid scope, `enabled: false`, non-boolean `confirm_global`, and `confirm_global` on a non-global scope are rejected and create no row. |
| A3 | Global without `confirm_global: true` or with `false` returns `confirmation_required` and creates no row; with `true`, creates. |
| A4 | Global, project, and app creation persist name/description/body/license/compatibility/metadata/references through `SkillService.get`. |
| A5 | Unknown project/app, master project/app, and deleting project/app return their exact codes and create no row. |
| A6 | A same-scope duplicate returns `skill_exists` with the existing id/updatedBy/updatedAt; a narrower same-name create returns `shadows` containing the wider scope; a global create with an existing project row of the same name returns `shadowedBy: ["project"]` and `shadows: []`; a disabled project tombstone still yields `shadowedBy: ["project"]`; a row in a deleting project is excluded. |
| A7 | The result has no `content`, reference content, `metadataRaw`, or `storedIssues`; `appsInScope` excludes deleting apps/projects; app-scope `pendingRestart` is truthful. |
| A8 | The event payload has identifiers, reference count, and stored byte sizes but not the body/description/reference/metadata values. |
| A9 | If `events` cannot be written, the transaction rolls back: the tool returns `internal_error`, `skills` has no new row, and `skill_references` has no new rows. |
| A10 | A missing `skills` service returns `unavailable`; a missing project/app returns `unknown_project`/`unknown_app`; an invalid reference path returns `invalid_skill` with the field. |
| A11 | A maximum valid escaping-heavy bundle (~0.92 MiB) built with `JSON.stringify` is accepted by a real `createHttpServer` `/internal/mcp` request; a >1 MiB body returns `413 payload_too_large` and creates no row. |
| A12 | Existing master tool tests, including the exact event sequence for project/app/file operations, still pass. |
| A13 | A throwing `manager.pendingRestart`, a throwing `skills.resolve`, and a missing `instances` table each leave the create successful with `ok:true`, a `post_create_enrichment` warning, and false/empty enrichment values. |

## 5. Security analysis

- **Authorization.** Only the master token reaches `create_skill`: the master branch in
  `/internal/mcp`, the `isMasterAppId` selection, the JSON-RPC allowlist, and the repeated identity
  check in `callMasterTool`. Human and ordinary app tokens are unchanged.
- **Prompt injection / self-modification.** Skill content is instructions for agents. The master can
  already write operator application `AGENTS.md` files, change global settings, and create agents;
  app/project/global creation is the same class of capability. The master's own project/app is
  refused, but global scope remains an explicit, operator-confirmed, audited path that affects the
  master on restart. This is an accepted risk, not a blocked path.
- **Path traversal.** The tool never touches the filesystem. The service validates every reference
  path against `references/<slug>.md`; the materializer adds realpath/containment defenses later.
- **Resource bounds.** Service limits (48k body, 20 references, 192k aggregate, 16k metadata) bound
  the transaction. The 1 MiB `/internal/mcp` transport bound is sufficient for the maximum valid
  bundle sent by the master's `JSON.stringify`-based client; a hypothetical fully `\uXXXX`-escaped
  encoding can exceed it and receives a transport-level 413. No limit increase is introduced.
- **Secrets.** The tool accepts no secrets. Skill bodies are not written to events or logs; audit
  records sizes and identifiers only.
- **Destructive actions.** Creation only; no update/delete/override. Same-scope collision is an
  error with existing-row context, so the tool cannot silently replace an operator-managed skill.
  Wider shadowing is explicit hierarchy behavior and is reported.
- **Deletion race.** Target deletion is checked before and inside the creation transaction; writes
  are serialized in the coordinator process. A later deletion removes the created rows through the
  existing deletion service.
- **Collision limitation.** Repository, plugin, and external skill roots can shadow the managed
  skill; Hanse only hashes managed rows, so the result cannot guarantee the agent will load this
  bundle. The instructions tell the master to point the operator at the app Skills page; collision
  scanning is not added to the master tool because it needs per-app materialization context.

## 6. Non-goals

- Master-side update/delete/override/disable/revert, skill reading/listing, or skill import/export.
- Creating skills for the reserved master project/app.
- Automatic restarts or background application.
- Changes to skill storage, materialization, collisions, hashing, human UI/API, or deletion.
- Schema migrations, new tables, new npm dependencies, or a new HTTP endpoint.

## 7. Open questions

None. The user request fixes the capability (create at all three hierarchy levels); existing skill
semantics fix the payload, validation, hierarchy, and restart behavior; the security boundary above
fixes the self-target refusal and the global confirmation requirement.
