# Design - App-agent skill authoring

Status: **approved** - design-review rounds 1-3 (oracle); round 3 returned PASS with non-blocking
wording clarifications, all folded in.

Scope: expose the existing skill registry to ordinary (non-master) application agents through the
production app MCP surface, so an app can create, inspect, update, enable/disable, and override
skills **at its own application scope only**, reusing `SkillService`, the existing hierarchy,
validation, materialization, and restart semantics. The target is always derived from the verified
agent token; no tool accepts a scope or target.

Out of scope: global/project skill mutations from an app, any mutation of a sibling application's
rows, delete/revert/discard/rename, changing the name/shadowing/override rules, automatic or
self-restart, a new HTTP route, a second skill registry, a schema migration, a new dependency, and
changes to human `/api/skills*` authorization. The direct-DB `hanse mcp` fallback
(`src/cli/commands.ts:813-822`, `src/mcp/server.ts:6-27`) remains handoff-only; every managed
application uses the remote bridge (`src/opencode/manager.ts:648-655`,
`src/cli/commands.ts:800-811`), which is the surface this stage extends.

## 1. Problem

An ordinary app agent can already write files in its own workspace, but it cannot maintain the
coordinator-managed skill bundles that its own next session loads. Skill management is a
configuration surface still closed to apps: the human API requires a human principal
(`src/http/skills.ts:2620-2631`), and the master tools are dispatched only for the reserved master
token (`src/http/internal-mcp.ts:47-59`). An app told "keep this procedure as a skill" must stop and
ask the operator to leave chat and open the Skills page.

The skill registry already models a bundle, validates it, resolves the global -> project -> app
hierarchy, materializes it into each isolated instance, and reports restart state. This stage
exposes the app-scope half of that registry through the app MCP server without duplicating
validation or granting target choice. The capability is owner-approved; this document fixes the
contract, the authorization boundary, and the dispatch extraction.

## 2. Requirements

| ID | Requirement |
| --- | --- |
| AS1 | Every app skill tool is bound to the calling application's verified `(projectId, appKey)`; the tools derive the target from the token and accept no target override. |
| AS2 | The app surface adds exactly `create_skill`, `list_skills`, `get_skill`, `update_skill`, `set_skill_enabled`, and `override_skill`; deletion, revert/discard, and rename remain operator-only. |
| AS3 | Bundle and patch validation is delegated to `SkillService` and the exported skill validators; the tools add only boundary type checks and share one implementation with the master tools. |
| AS4 | No app skill tool accepts `scope`, `project_id`, `app_key`, or `confirm_global`; supplying any is `invalid_argument` and performs no write. |
| AS5 | A same-name create at the caller's application scope returns `skill_exists` with existing-row context; no new uniqueness policy is introduced. |
| AS6 | Name resolution is unchanged: a wider global/project same-name row is shadowed by the caller's app row, and `override_skill` copies a visible wider source into the caller's app scope. |
| AS7 | `get_skill` reads only rows that are effective for the caller or rows at the caller's own app scope (so the app can inspect its own tombstone/invalid row); wider global/project rows that are not effective (disabled, invalid, or shadowed) return `unknown_skill`. `update_skill` and `set_skill_enabled` mutate only rows with `scope='app'` and the caller's `(projectId, appKey)`; `override_skill` writes only that target. |
| AS8 | `override_skill` accepts a source only when it is visible in the caller's chain (in practice global or the caller's project); an app-scope source at the caller's target is a self-copy and is rejected; sibling-app and other-project sources return `unknown_skill` and write nothing. |
| AS9 | The target guard for every mutation runs before row inspection, so a caller project or app pending deletion returns `deletion_pending` even when the requested row is global or a sibling row; the reserved master target is refused as `master_protected`; reads remain available. |
| AS10 | Every mutation stores the actor `app:<projectId>:<appKey>` in `updated_by` and writes exactly one compact `scope='app'` audit event in the mutation transaction. |
| AS11 | An app-scope mutation reports `pendingRestart` for the caller from the manager's applied-hash comparison; enrichment failure is fail-open. |
| AS12 | No skill tool starts or restarts any agent, including the caller; there is no self-restart path. |
| AS13 | The existing service limits are the per-bundle bound, and the existing 1 MiB `/internal/mcp` limit is the transport bound (an escaped request that exceeds it receives 413 before dispatch); no per-app quota, bulk operation, or new rate limit is added. |
| AS14 | The stage adds no database migration, no npm dependency, no HTTP route, and no change to materialization, hashing, or the hierarchy. |
| AS15 | Human `/api/skills*` authorization (human principal plus same-origin mutation) and the human UI are unchanged; app tokens still receive `403 human_only` there. |
| AS16 | Mutation results and `list_skills` never echo `content` or reference `content`; a mutation's `skill` projection never echoes `metadataRaw` or `storedIssues` (update/set/override may return the content-free top-level issue-entry list, as the master does); only `get_skill` returns a body. |

## 3. Verified facts

- `/internal/mcp` verifies the bearer token, then branches on `isMasterAppId(agent.appId)`; the
  master branch calls `handleMasterRpc`, and every other app builds
  `new CoordinatorService(deps.db, agent.projectId)` and calls `handleRpcAsync`
  (`src/http/internal-mcp.ts:32-37`, `:47-59`, `:65-70`).
- The master context receives `deps.skills` only inside the master branch; today
  `handleRpcAsync` receives neither `skills` nor `manager`
  (`src/http/internal-mcp.ts:48-59`, `:65-70`).
- `handleRpcAsync(service, ssh, agent, request)` advertises `[...TOOLS, ...SSH_TOOLS]` and routes
  every non-`ssh_` call to `handleRpc`
  (`src/mcp/ssh-protocol.ts:111-116`, `:121-135`). `TOOLS` contains only the four handoff tools
  (`src/mcp/protocol.ts:20-56`), and `handleRpc` advertises only `TOOLS`
  (`src/mcp/protocol.ts:128-135`).
- `HttpDeps` already carries optional `manager`, `settings`, `ssh`, and `skills`
  (`src/http/handler.ts:49-69`, `skills` at `:57`). Production constructs one `SkillService` and
  passes the same instance to the manager and the HTTP server
  (`src/cli/commands.ts:647-658`, `:707-716`).
- Managed instances always receive `HANSE_MCP_API_BASE` and `HANSE_AGENT_TOKEN_FILE` and register
  the `hanse` MCP server in their overlay (`src/opencode/manager.ts:648-668`,
  `src/opencode/instance.ts:26`, `:128-136`); the stdio bridge posts each line to `/internal/mcp`
  (`src/mcp/remote.ts:62-72`). The direct-DB `runMcpServer` path is only the env-less fallback
  (`src/cli/commands.ts:813-822`).
- `verifyAgentToken` resolves the identity by joining `agent_tokens` to `apps`, so a revoked or
  deleted app cannot authenticate; the identity is exactly `{appId, projectId, appKey}`
  (`src/mcp/agent-tokens.ts:7-12`, `:106-122`). The token file is written atomically with mode
  `0600` (`src/mcp/agent-tokens.ts:137-150`).
- `SkillService.get(id)` returns the full row, including body, reference contents, `metadataRaw`,
  and `storedIssues` (`src/skills/service.ts:278-283`). `create`, `update`, and `override` own all
  slug/frontmatter/metadata/reference/size/uniqueness validation and run in transactions
  (`src/skills/service.ts:285-333`, `:335-377`, `:379-440`, `:274-276`).
- `SkillService.resolve(target)` returns `{scope, effective, rows, disabled, warnings}` for a
  global/project/app chain; `rows` are only the target-scope definitions, while `effective` includes
  wider scopes and `disabled` includes hierarchy-wide tombstones
  (`src/skills/service.ts:447-456`, `:524-617`).
- `sourceVisibleAt` is a private service helper: global is visible everywhere, project only in its
  project, app only in its own app (`src/skills/service.ts:247-255`). It is not exported today; this
  stage replaces it with the shared `skillVisibleAt` (D2).
- Scope keys are global `("", "")`, project `(projectId, "")`, app `(projectId, appKey)`;
  the unique key is `(scope, project_id, app_key, name)`
  (`src/skills/service.ts:171-195`, `src/store/migrations.ts:389-415`).
- `SkillInput` and `SkillUpdate` are the structured bundle shapes; `SkillUpdate` has no name/scope/
  target fields (`src/skills/types.ts:67-88`). The `skillSummary` projection omits `content` and
  reference content; the `SkillSummary` type itself includes `content`
  (`src/skills/types.ts:96-113`).
- `SkillValidationError` carries an optional `field` and maps to `invalid_skill`; the service throws
  `SkillConflictError` (code `skill_exists`) on a same-scope duplicate
  (`src/skills/validation.ts:4-13`, `src/skills/service.ts:52-59`, `:327-331`).
- Limits are: name 64, description 1024, content 48000, license 256, compatibility 512, 32 metadata
  entries (key 64, value 1024, JSON 16384), 20 references (slug 64, path 78, content 48000,
  aggregate 192000) (`src/skills/validation.ts:19-34`).
- The master skill tools already implement boundary parsing, content-free summaries, conflict
  context, target guards, enrichment, and audit. The relevant helpers live in
  `src/master/tools.ts`: `skillInputFromArgs` `:555-578`, `assertSkillTarget` `:581-608`,
  `skillSummary` `:610-630`, `shadowedByScopes` `:632-682`, `appsInScope` `:684-714`,
  `skillConflictError` `:716-738`, `skillDetail` `:793-805`, `skillMutationEnrichment` `:847-907`,
  `skillUpdatePatchFromArgs` `:909-942`, `assertOverridableSource` `:955-964`,
  `isSameSkillTarget` `:966-972`, and `lifecycleError` `:1030-1065`.
- The master mutation handlers are `create_skill` `:1239-1278`, `list_skills` `:1279-1292`,
  `get_skill` `:1294-1302`, `update_skill` `:1303-1356`, `set_skill_enabled` `:1357-1409`, and
  `override_skill` `:1410-1479` (`src/master/tools.ts`). `MASTER_TOOLS` is the master allowlist
  (`:92-323`); the master `tools/list` returns it unchanged (`src/mcp/master.ts:38-40`).
- Master event recording writes `scope='master'` and truncates payloads over 8 KiB
  (`src/master/tools.ts:399-408`). The `events` table has only `id, scope, type, payload,
  created_at` (`src/store/migrations.ts:102-108`).
- There is no production reader of `events` rows: the only inserts are the master helper and the
  two deletion events (`src/master/tools.ts:405-407`, `src/coordinator/deletion.ts:1037`, `:1081`),
  and tests query them directly (for example `test/master-tools.test.ts:259`, `:797`, `:1210`,
  `:1539`). Changing the app event scope/type therefore cannot break a production consumer.
- Human skill routes require a human principal and same-origin mutations
  (`src/http/skills.ts:2616-2631`); app tokens are rejected with `403 human_only` (verified by
  `test/skills-http.test.ts:265-287`, assertion at `:284`).
- The manager probes the effective set into a private staging root before teardown and applies it
  after teardown (`src/opencode/manager.ts:536-554`, `:566-575`). `pendingRestart` returns false for
  a stopped app and otherwise compares the applied hash, which includes the skills hash
  (`src/opencode/manager.ts:803-857`, `:889-899`).
- `/internal/mcp` accepts up to 1 MiB; `/api/skills*` accepts up to 4 MiB
  (`src/http/server.ts:29-31`, `:186`, `:223`). The service limits, not the transport, bound a
  bundle. A maximum valid bundle under the supported `JSON.stringify` profile fits under 1 MiB; a
  client that escapes every non-ASCII character as `\uXXXX` can exceed 1 MiB and receives a
  transport-level 413 before dispatch, exactly as documented by the master design.
- The reserved ids are `hanse-master` / `master`, with `isMasterProject`, `isMasterApp`, and
  `isMasterAppId` predicates (`src/master/constants.ts:3-8`, `:19-32`).

## 4. Decisions

### D1 - Six app-scope tools with no scope argument (AS1, AS2, AS4)

The app surface is exactly the master skill surface minus scope choice. The six tools are named
identically to the master tools because the two surfaces are selected by token identity before
dispatch (`src/http/internal-mcp.ts:47-70`); there is no shared registry and no ambiguity.

The app versions drop `scope`, `confirm_global`, `project_id`, and `app_key`. `create_skill` always
targets the caller's app and always creates an enabled bundle. `list_skills` and `get_skill` need no
target at all. `override_skill` targets the caller's app and keeps `confirm_replace` for parity: an
app-scope row may have been authored by the operator, so replacement stays an explicit second
signal. A missing/false `confirm_replace` returns `replacement_confirmation_required` with the same
pass-`confirm_replace: true` message as the master, and that code is added to the app failure
taxonomy in §5.4.

Rejected alternatives: exposing the master tools with a forced `scope: "app"` (the argument exists,
so a model can try `global`, and the handler must grow confirmation/target branches that cannot
succeed); six differently named tools (duplicated schemas and dispatch for no benefit); direct
filesystem writes (bypasses the DB, hash, materialization, and audit); calling the human HTTP API
internally (human-only auth, origin semantics, and double parsing for no gain).

### D2 - Reuse `SkillService` and extract the master skill helpers (AS3)

The app handlers call `skills.create/update/override/get/resolve` exactly as the master does, with
the app target and the app actor. They perform only boundary checks that TypeScript and safe
dispatch require; slug, frontmatter generation, description/content/license/compatibility/metadata,
reference paths and aggregate, uniqueness, and normalization remain in the skills service.

To avoid a second copy of the master logic, the skill-specific helpers are extracted into neutral
modules under `src/skills/`:

| New module | Contents |
| --- | --- |
| `src/skills/tool-errors.ts` | `SkillToolError` (`code`, `message`) and `toSkillFailure(error)` returning `{ok:false, code, message}`. `toSkillFailure` is the single normal-error mapper: `SkillValidationError` -> `invalid_skill` (field-prefixed), `SkillConflictError` -> `skill_exists`, `SkillToolError` -> its own code, and only an unexpected error -> `internal_error`. The create handler catches `SkillConflictError` before the mapper so it can add existing-row context. `MasterToolError` stays in `src/master/tools.ts`; `lifecycleError` maps `SkillToolError` to a `MasterToolError` with the same code. |
| `src/skills/tool-inputs.ts` | `asString`, `asOptionalStringOrNull`, `asOptionalMetadata`, `asOptionalReferences`, `asPositiveInteger`, `asBoolean`, `skillInputFromArgs` (rejects `enabled`), and `skillUpdatePatchFromArgs`. These are moved from `src/master/tools.ts:331-336`, `:503-578`, `:758-770`, and `:909-942`; `asOptionalString` (`:338-343`) stays master-specific for settings target parsing. |
| `src/skills/tool-projection.ts` | `SkillToolContext` (`db`, optional `skills`, optional `manager`), `skillSummary`, `skillDetail`, `listEffectiveEntry`, `listRowEntry`, `skillMutationEnrichment`, `shadowedByScopes`, `appsInScope`, and `pendingRestart`. Moved from `src/master/tools.ts:392-397`, `:610-630`, `:632-714`, `:793-907`. `appsInScope` imports the shared `runtimeState` helper below; it does not keep a private copy. |
| `src/skills/access.ts` | Neutral, runtime-dependency-free predicates: `skillVisibleAt(row, target)`, `isOwnAppSkillRow(row, target)`, `skillRowTarget(row)`, and `isSameSkillTarget(row, scope, target)`. It imports only types from `./types.js` (`import type`) and has no dependency on `SkillService`, `MasterToolError`, or the app handler. |
| `src/skills/tool-access.ts` | Shared guards that throw `SkillToolError`: `assertSkillTarget(db, scope, target)` (global/project/app existence, reserved-master refusal, deletion guard), `assertOwnAppSkillRow(row, target)`, `assertSkillReadable(skills, row, target)` (effective-for-caller or own app row), `assertOverridableSource(source)`, and `skillConflictError(skills, scope, target, name)`. It imports `access.ts`, `tool-errors.ts`, the pure `isMasterProject`/`isMasterApp` predicates from `src/master/constants.ts`, and type-only skill types. |
| `src/skills/app-tools.ts` | `APP_SKILL_TOOLS`, `APP_SKILL_TOOL_NAMES`, `isAppSkillToolName`, `AppSkillToolContext`, and `callAppSkillTool`. |
| `src/store/events.ts` | `recordEvent(db, scope, type, payload)` extracted from `src/master/tools.ts:399-408`, including the 8 KiB truncation; the master passes `"master"`, the app passes `"app"`. |
| `src/store/runtime-state.ts` | `runtimeState(db, appId)` extracted from the master helper (`src/master/tools.ts:360-366`); used by `appsInScope` and by the master's `list_projects`/`get_app`, so no copy remains. |

`SkillService` imports `skillVisibleAt` from `src/skills/access.ts` for `override` and deletes its
private `sourceVisibleAt`; `access.ts` only type-imports `skill/types.ts`, so the
`service.ts -> access.ts` edge is acyclic. `src/master/tools.ts` imports the shared
`assertSkillTarget`, `skillRowTarget`, `isSameSkillTarget`, `assertOverridableSource`,
`skillConflictError`, `runtimeState`, `recordEvent`, and the moved input/projection helpers, and
deletes its local copies. `lifecycleError` gains a `SkillToolError` mapping to `MasterToolError`,
so a shared guard's `deletion_pending`/`master_protected`/`unknown_project` code reaches the master
unchanged. Every cross-layer type edge (`SkillService`, `SqliteDatabase`, `InstanceManager`,
`AgentTokenIdentity`) uses `import type`, keeping the runtime graph acyclic.

What stays master-specific in `src/master/tools.ts`: `MasterToolContext` / `MasterToolError`,
`MASTER_TOOLS` and `MASTER_TOOL_NAMES`, `targetFor` / `requireTargetExists` (global/project/app
target parsing), `asOptionalString` (settings target parsing, calling the shared `asString`),
`projectRow`/`appRow` for the non-skill tools, `requireSettings` / `requireManager` /
`requireSkills`, the master skill input schemas with their `scope` and `confirm_global` fields,
`asSkillScope` / `asOverrideScope`, `assertGlobalConfirmation`, `assertSkillRowMutable` (a thin
wrapper over the shared `assertSkillTarget`), `lifecycleError`, and every non-skill tool
(`list_projects`, settings, app lifecycle, provisioning, file tools). `MasterToolContext` becomes
`SkillToolContext & { workspaceRoot; settings?; deletion? }`.

The app handler never constructs a second `SkillService`, never writes files, and never calls the
human HTTP layer. If the context has no `skills` service, the tools are not advertised and a direct
call returns `unavailable`.

Rejected alternatives: duplicate validation in `src/mcp/ssh-protocol.ts` (drifts from the human and
master paths); keep all helpers in `src/master/tools.ts` and import them from an app module (makes
the app depend on the master allowlist and context); keep the service's private `sourceVisibleAt`
and a master-local `assertSkillTarget` (three authorization paths that can drift).

### D3 - Fixed app target and strict by-id authorization (AS5, AS7, AS8, AS9)

The token is the only source of the target:

```ts
const target = { projectId: agent.projectId, appKey: agent.appKey };
```

No handler reads `args.project_id`, `args.app_key`, `args.scope`, or `args.confirm_global`; the
boundary parser rejects those keys before any work. `callAppSkillTool` also rejects a master identity
(`isMasterAppId(agent.appId)` -> `master_protected`) and an inconsistent identity
(`agent.appId !== `${agent.projectId}:${agent.appKey}`` -> `internal_error`) as defense in depth,
even though `/internal/mcp` already selected the master branch first.

The by-id rules are:

| Tool | Read/mutate rule | Out-of-scope result |
| --- | --- | --- |
| `get_skill` | Row must be readable by the caller: either `isOwnAppSkillRow(row, target)` (so the app can inspect its own tombstone or invalid row), or `skillVisibleAt(row, target)` **and** the row id is in `skills.resolve(target).effective`. | `unknown_skill` for sibling/other-project rows and for any wider global/project row that is not effective (disabled, invalid, or shadowed). |
| `update_skill`, `set_skill_enabled` | Row must be visible **and** `isOwnAppSkillRow(row, target)`: `scope='app'`, same project, same app. | Invisible -> `unknown_skill`; visible global/project -> `invalid_argument` with a message to override the source instead. |
| `override_skill` | `assertSkillTarget` first; then source load; then `skillVisibleAt`; then self-copy check; then `assertOverridableSource`. Target is fixed to the caller's app. | Invisible source -> `unknown_skill` (even if it has stored issues); self-copy -> `invalid_argument`; disabled/invalid/stored-issue source -> `invalid_skill`. |
| `list_skills`, `create_skill` | No by-id row; target fixed; create uses the caller's app. | Not applicable. |

Ownership is by scope and target, not by `updated_by`. An app-scope row authored by the operator
belongs to that application and may be updated, disabled, or replaced by the app after the normal
confirmation/replacement rules. Authorship is not an authorization boundary (the operator can
already delete the row); the audit event records the app actor.

`override_skill` uses chain visibility, not effective-only readability: a valid enabled wider source
that is shadowed can be copied into the app's own scope, after which the app reads its own copy.
Disabled and invalid wider sources remain rejected, so this does not expose tombstoned or invalid
wider rows; it is the existing override semantics, not a `get_skill` bypass.

**Ordering.** For every mutation, `assertSkillTarget(db, "app", target)` runs first, before any row
load or by-id inspection. A deleting caller project/app therefore returns `deletion_pending` even
when the requested row is global, invalid, or from a sibling app; the caller's own deletion state is
not sensitive to that caller. The same guard runs again inside the transaction. Reads
(`list_skills`, `get_skill`) bypass the target guard and remain available while the caller is
deleting, matching the master's read-only behavior on deleting targets.

Each by-id mutation loads the row before the transaction for authorization and again inside the
transaction; a row that disappeared returns `unknown_skill` and writes nothing. `override_skill`
re-loads the source inside the transaction for the same reason. The shared target guard checks that
the project exists (`unknown_project`), is not the reserved master project
(`master_protected`), and is not deleting (`deletion_pending`), then that the app exists
(`unknown_app`), is not the master app (`master_protected`), and is not deleting
(`deletion_pending`). These target errors are defense in depth because a live token was already
joined to an existing app; they close a deletion race and a forged in-process identity.

The create handler explicitly catches `SkillConflictError` and calls
`skillConflictError(skills, "app", target, name)` so the `skill_exists` message carries the existing
row's id/updatedBy/updatedAt. The generic `toSkillFailure` mapping is not used for that path.

Rejected alternatives: authorizing by `updated_by` (operator-seeded app rows would become
unmaintainable and the check is not a security boundary because the app can override the row
anyway); returning `forbidden` for out-of-scope ids (a new code in the app taxonomy and an
existence oracle); treating visible global/project rows as writable (global/project escalation);
allowing a source from a sibling app (cross-app injection).

### D4 - Name, shadowing, and override semantics are unchanged (AS5, AS6)

The service's unique key and hierarchy remain authoritative. A same-name create at the caller's app
scope returns `skill_exists` with the existing row's id, `updatedBy`, and `updatedAt`; the message
tells the model to choose another name or edit the existing row. A same-name wider row is allowed
and shadowed at app scope; the result reports `shadows` from the post-commit effective winner.
`shadowedBy` stays `[]` for app scope because there is no narrower scope; it is retained in the
projection for shape parity with the master.

`override_skill` is the only cross-scope write: it copies a visible enabled source (global or the
caller's project; an app-scope source at the target is a self-copy and is rejected) into the
caller's app scope. The check order is target guard, source load, `skillVisibleAt`, self-copy check,
then `assertOverridableSource`; an invisible sibling source therefore returns `unknown_skill` even
when it has stored issues, before any source validation runs. After the copy the app can
`update_skill` the new row; source and copy are separate audited mutations. A source with stored
issues, a disabled source, or a source whose description/content fails the exported validators
returns `invalid_skill` and writes nothing. A source already at the caller's app is a self-copy and
returns `invalid_argument`. Replacement of an exact target row requires `confirm_replace`; without
it the tool returns `replacement_confirmation_required` (master parity) naming the existing row and
telling the model to pass `confirm_replace: true`, and writes nothing.

No new uniqueness policy, index, preference rule, or "reject when wider exists" rule is introduced.
Rejecting a create because a wider same-name row exists would let an operator's project row block
the app's own authoring, which contradicts the hierarchy. Renaming remains impossible (delete +
create, operator-only); an app-scope row with the stored issue `invalid_skill_name` cannot be
repaired in place, so the operator must delete it.

Rejected alternatives: add a per-app namespace or suffix (changes the stored names and the
materialized `SKILL.md`); reject app shadows (breaks the existing hierarchy and the operator's
override workflow); allow `override_skill` to target global/project (scope escalation).

### D5 - App-scoped actor and compact atomic audit (AS10, AS11)

Every mutation uses actor `app:<projectId>:<appKey>`, for example `app:atlas:reviewer`. The service
stores it in `updated_by`; the value distinguishes an app-authored row from the human operator name
and from `master`. `updated_by` is a single last-writer column, so a later app edit replaces the
previous author string; the event history preserves the sequence of app mutations.

Each mutation runs as one outer `db.transaction` containing the target re-check, the nested
`SkillService` call, and exactly one event insert. `SkillService` uses a nested transaction
(savepoint), so an event failure rolls back the row and its references; the tool returns
`internal_error` and no row exists. Reads write no events.

The audit-atomicity claim has one hard wiring invariant: `context.skills` must be the same
`SkillService` instance constructed over `context.db`. Production satisfies it by constructing one
service (`src/cli/commands.ts:647`) and passing it to both the manager and `createHttpServer`
(`:648-658`, `:707-716`); `handleInternalMcp` forwards `deps.db` and that same `deps.skills`.
`handleRpcAsync` must pass both together. If a caller supplies a service built on a different
database, its nested transaction is not a savepoint of the outer one, so the audit rollback claim
does not hold; the wiring test asserts instance identity rather than attempting a runtime database
identity check.

Events use `scope = 'app'` and types `app.skill_created`, `app.skill_updated`, `app.skill_enabled`,
and `app.skill_overridden`. The payload carries the actor plus identifiers and stored sizes, never
the body, description, reference content, or metadata values:

| Event | Payload |
| --- | --- |
| `app.skill_created` | `actor`, `skillId`, `scope`, `projectId`, `appKey`, `name`, `referenceCount`, `contentBytes`, `referenceBytes` |
| `app.skill_updated` | `actor`, same identifiers, `changed` (field names only), `contentBytes`, `referenceCount`, `referenceBytes` |
| `app.skill_enabled` | `actor`, same identifiers, `enabled` |
| `app.skill_overridden` | `actor`, `sourceSkillId`, `skillId`, `scope`, `projectId`, `appKey`, `name`, `enabled`, `referenceCount` |

`scope` is the literal `'app'`; `projectId`/`appKey` in the payload identify which app. The existing
`events` schema has no actor column (`src/store/migrations.ts:102-108`), so the actor is part of the
payload. No production code reads `events` (`src/master/tools.ts:405-407`,
`src/coordinator/deletion.ts:1037`, `:1081` are the only inserts; tests query by type/scope), so the
new scope/type pair cannot break a consumer. The 8 KiB payload truncation is preserved by
`src/store/events.ts`.

Rejected alternatives: reuse `scope='master'` (wrong principal and would pollute master queries);
omit the actor (the actor column does not exist and events are the only audit trail); use no event
(app mutations would be invisible in the audit history); include the body or a diff (leaks content
and inflates the table).

### D6 - Report restart, never perform it (AS11, AS12)

After a committed mutation the handler calls `manager.pendingRestart(agent.appId)` and includes the
result. The manager returns false for a stopped app and otherwise compares the applied hash with the
current settings+skills hash (`src/opencode/manager.ts:803-857`, `:889-899`). The value is therefore
truthful: a mutation that changes the effective set of a running app reports pending; a mutation
that does not (for example enabling an invalid-name row that cannot win) reports false; a stopped
app reports false because its next start computes the current hash from the DB.

The app tools contain no start/restart call and no self-restart path. The manager is used only for
`pendingRestart`; the existing master `start_app`/`restart_app` tools are not advertised on the app
surface, and their `assertNotMaster` guard already refuses the master itself
(`src/master/tools.ts:990-997`). The app may ask the operator to restart; the operator UI or the
master can do it. The next start probes and applies the new effective set exactly as today
(`src/opencode/manager.ts:536-575`); the running agent's context does not change until then.

Rejected alternatives: restart automatically after a mutation (changes the existing "restarts are
never automatic" contract and can loop with the agent); add a self-restart tool (explicitly
forbidden; the master cannot restart itself either); compute an optimistic pending value instead of
asking the manager (would lie for invalid/stopped rows).

### D7 - Bounded surface, no migration/dependency/route, human auth unchanged (AS13, AS14, AS15, AS16)

The change reuses the existing `skills`, `skill_references`, and `events` tables and the existing
`/internal/mcp` route. It adds no schema version, no npm package, no HTTP handler, and no change to
`src/skills/materialize.ts`, `src/skills/service.ts` hashing, or the scope hierarchy. The human
routes keep their human-principal and same-origin checks (`src/http/skills.ts:2616-2631`); app
tokens continue to receive `403 human_only`.

The response projections mirror the master:

- `list_skills` returns `{ok, scope:"app", target, effective, rows, disabled}` with no body or
  reference content; `rows` and `effective` carry the same fields as the master projection,
  including metadata and content-free stored issue entries.
- `create_skill`, `update_skill`, `set_skill_enabled`, and `override_skill` return
  `{ok:true, skill: skillSummary, ...enrichment}`. `skillSummary` has no `content`, reference
  content, `metadataRaw`, or `storedIssues`. Create keeps the master's create shape (no `effective`/
  `storedIssues`); update/set/override add `effective` and `storedIssues` like the master.
- `get_skill` is the only content-bearing read: `{ok:true, skill:{...summary, content, metadataRaw,
  references:[{path, content, size}], storedIssues}}`, limited to the caller's readable set
  (effective rows plus its own app rows).
- `appsInScope` and `shadowedBy` are retained for parity, not omitted. For app scope,
  `appsInScope` is `{total:1, running:0|1}` (the caller; total is 0 only in a deleting state that
  mutations reject) and `shadowedBy` is always `[]`. Retaining them keeps one projection contract
  for master and app tests.
- `shadows`, `shadowedBy`, `appsInScope`, and `pendingRestart` are post-commit enrichment and remain
  fail-open: any failure leaves `ok:true`, a false/empty value, and
  `warnings:["post_create_enrichment"]`. A committed mutation is never reported as an error because
  a read failed.

The service limits (`src/skills/validation.ts:19-34`) are the real per-bundle bound. The 1 MiB
`/internal/mcp` limit (`src/http/server.ts:29-31`, `:186`, `:223`) is a transport bound: a maximum
bundle under the supported `JSON.stringify` profile fits, while a client that escapes every
non-ASCII character as `\uXXXX` can exceed it and receives `413 payload_too_large` before dispatch.
`get_skill` can return a full bundle, and `list_skills` returns the caller's chain only. No per-app
quota, pagination, bulk import/export, or rate limit is introduced.

Rejected alternatives: a new `/api/app-skills` route (duplicates auth and transport); a migration
for per-app quotas or event actors (unnecessary for the capability); a second registry or a
materialization change (diverges from the human and master paths); omitting `appsInScope`/
`shadowedBy` (forks the projection and the tests).

### D8 - Dispatch through the existing app MCP server (AS1, AS2, AS4)

`handleRpcAsync` gains an optional fifth argument so existing four-argument callers and tests remain
valid:

```ts
export interface AppSkillRpcOptions {
  db?: SqliteDatabase;
  skills?: SkillService;
  manager?: InstanceManager;
}
handleRpcAsync(service, ssh, agent, request, options: AppSkillRpcOptions = {})
```

`src/http/internal-mcp.ts` passes
`{ db: deps.db, ...(deps.skills === undefined ? {} : { skills: deps.skills }), ...(deps.manager ===
undefined ? {} : { manager: deps.manager }) }` on the non-master branch. The master branch is
unchanged.

Routing inside `handleRpcAsync`, in this order:

1. A message without an id returns `undefined` (unchanged).
2. `tools/list` returns `[...TOOLS, ...SSH_TOOLS, ...APP_SKILL_TOOLS]` when both `options.skills` and
   `options.db` are present; otherwise it returns `[...TOOLS, ...SSH_TOOLS]`. The tools are not
   advertised by a partially wired context.
3. A non-`tools/call` method goes to `handleRpc` (unchanged; this covers `initialize`).
4. A `tools/call` whose name is in `APP_SKILL_TOOL_NAMES` goes to `callAppSkillTool`. If `skills` or
   `db` is missing, it returns a successful text result
   `{ok:false, code:"unavailable", message:"skills are not configured"}`. Otherwise
   `callAppSkillTool` runs and maps its own synchronous failures through `toSkillFailure` before
   returning to the dispatcher: `SkillValidationError` -> `invalid_skill` (field-prefixed),
   `SkillConflictError` -> `skill_exists` (the create handler catches it first and adds existing-row
   context; the fallback has a generic message), `SkillToolError` -> its own code (including
   `replacement_confirmation_required`), and only an unexpected error -> `internal_error`. The
   outer dispatcher's generic catch is a last resort for an unexpected throw or a bug; it must never
   classify a validation, conflict, or skill error as `internal_error`. Tool failures are text
   results, not JSON-RPC errors, matching the master and SSH surfaces.
5. A name that does not start with `ssh_` goes to `handleRpc` (unchanged handoff path).
6. An `ssh_` name goes to the SSH path (unchanged).

`APP_SKILL_TOOLS` names do not collide with `TOOLS` or `SSH_TOOLS`; the two skill surfaces are
separated by the identity branch in `src/http/internal-mcp.ts`, so the same tool names on master and
app are intentional and safe. `callAppSkillTool(context, agent, name, args): Promise<unknown>` is
async for the dispatcher, but its body performs all database work synchronously; it receives the
verified `AgentTokenIdentity`, not a target argument. `AppSkillToolContext` is an alias of
`SkillToolContext` with nothing added.

The dispatcher never constructs a `SkillService`: `options.skills` must be the same instance
constructed over `options.db` (D5), and `src/http/internal-mcp.ts` forwards both `deps.db` and
`deps.skills`. The app handler, not JSON Schema, is the authoritative argument boundary: the
schemas permit additional properties, and `callAppSkillTool` rejects `scope`, `project_id`,
`app_key`, and `confirm_global` plus the tool-specific immutable fields with `invalid_argument`
before any work.

Rejected alternatives: a new `/internal/app-skills` endpoint (a new route and a second token check);
a second branch in `handleInternalMcp` before `handleRpcAsync` (duplicates context construction and
bypasses the existing notification/list handling); reusing `handleMasterRpc` with a filtered tool
list (would require the master context and would expose master-only tools if the filter drifts).

### D9 - Accepted risk: app-authored instructions and operator-skill shadowing

**Accepted risk.** An application can already persist instructions for its own future sessions by
writing files in its repository, including `AGENTS.md` and `.opencode/skills`. This stage adds a
second, coordinator-managed persistence path. DB skills are git-invisible, but they are visible in
the operator Skills inventory (scope, origin, state, source) and every mutation is audited. The
blast radius is one application: the app cannot write global/project/sibling rows, cannot delete,
and cannot restart itself. An app can shadow an operator-managed global/project skill for itself by
creating or overriding a same-name app row; that is the existing hierarchy doing its job, it affects
only that app, and the operator can see and remove the row. This is accepted, not a claim that app
self-modification is impossible.

## 5. Tool surface

### 5.1 Tool summary

| Tool | Arguments | Result |
| --- | --- | --- |
| `create_skill` | name, description, content, optional license/compatibility/metadata/references | Content-free `skill` + enrichment |
| `list_skills` | none | Effective/rows/disabled for the caller's app, no content |
| `get_skill` | `skill_id` | Full bundle, including content and issues |
| `update_skill` | `skill_id` + mutable fields | Content-free `skill` + enrichment |
| `set_skill_enabled` | `skill_id`, `enabled` | Content-free `skill` + enrichment |
| `override_skill` | `source_skill_id`, optional `enabled`, `confirm_replace` | Content-free `skill` + enrichment |

### 5.2 Exact schemas

```json
{
  "name": "create_skill",
  "description": "Create an enabled skill bundle at this application's own scope. The target is this application; no scope or target arguments are accepted. A same-name skill at this scope is rejected; a same-name skill at a wider scope is shadowed. Creating a skill never restarts the agent; the result reports pendingRestart.",
  "inputSchema": {
    "type": "object",
    "properties": {
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
    "required": ["name", "description", "content"]
  }
}
```

```json
{
  "name": "list_skills",
  "description": "List the effective skill set and the rows defined at this application's own scope. Returns no skill bodies or reference contents.",
  "inputSchema": { "type": "object", "properties": {} }
}
```

```json
{
  "name": "get_skill",
  "description": "Read one skill by id when it is effective for this application or belongs to this application's own scope. Disabled, invalid, or shadowed global/project rows are not readable. Returns the body, reference contents, metadata, raw invalid metadata, and stored issues.",
  "inputSchema": {
    "type": "object",
    "properties": { "skill_id": { "type": "integer", "minimum": 1 } },
    "required": ["skill_id"]
  }
}
```

```json
{
  "name": "update_skill",
  "description": "Update the description, body, license, compatibility, metadata, or references of a skill owned by this application. Name, scope, target, and enabled are immutable. Global, project, and sibling-application rows are not writable; override a wider source instead.",
  "inputSchema": {
    "type": "object",
    "properties": {
      "skill_id": { "type": "integer", "minimum": 1 },
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
    "required": ["skill_id"]
  }
}
```

```json
{
  "name": "set_skill_enabled",
  "description": "Enable or disable one skill owned by this application. A disabled skill is a tombstone, not a deletion; it hides a wider same-name skill for this application.",
  "inputSchema": {
    "type": "object",
    "properties": {
      "skill_id": { "type": "integer", "minimum": 1 },
      "enabled": { "type": "boolean" }
    },
    "required": ["skill_id", "enabled"]
  }
}
```

```json
{
  "name": "override_skill",
  "description": "Copy an enabled skill that is visible in this application's chain (global or this application's project) into this application's own scope. The target is always this application; a source already at this target is rejected as a self-copy. Replacing an existing local row with the same name requires confirm_replace.",
  "inputSchema": {
    "type": "object",
    "properties": {
      "source_skill_id": { "type": "integer", "minimum": 1 },
      "enabled": { "type": "boolean" },
      "confirm_replace": { "type": "boolean" }
    },
    "required": ["source_skill_id"]
  }
}
```

`update_skill` requires at least one mutable field; that is a handler check because JSON Schema
cannot express it cleanly. `create_skill` rejects `enabled` (it always creates enabled).
`update_skill` rejects `name`, `enabled`, `scope`, `project_id`, and `app_key`.
`set_skill_enabled` rejects every content field. Every tool rejects `scope`, `project_id`,
`app_key`, and `confirm_global` when present; `override_skill` rejects `scope`, `project_id`,
`app_key`, and `confirm_global`, and accepts only `enabled` and `confirm_replace` as its flags. The
JSON Schemas
leave additional properties permitted; the handler boundary is authoritative and returns
`invalid_argument` for these keys before any write.

### 5.3 Result projection

`skillSummary(row)` is the master projection (`src/master/tools.ts:610-630`): `id`, `scope`,
`projectId`, `appKey`, `name`, `description`, `license`, `compatibility`, `metadata`, `enabled`,
`references:[{path, size}]`, `createdAt`, `updatedAt`, `updatedBy`. It never includes `content`,
reference content, `metadataRaw`, or `storedIssues`.

A mutation result is:

```json
{
  "ok": true,
  "skill": { "id": 12, "scope": "app", "projectId": "atlas", "appKey": "reviewer", "name": "release-checklist", "description": "...", "license": null, "compatibility": null, "metadata": {}, "enabled": true, "references": [{ "path": "references/guide.md", "size": 412 }], "createdAt": "...", "updatedAt": "...", "updatedBy": "app:atlas:reviewer" },
  "effective": true,
  "storedIssues": [],
  "shadows": ["global", "project"],
  "shadowedBy": [],
  "appsInScope": { "total": 1, "running": 1 },
  "pendingRestart": { "pending": true, "reasons": ["settings_changed"] }
}
```

`create_skill` omits `effective` and `storedIssues` (the created row is enabled and valid by
construction), matching the master create result. `update_skill`, `set_skill_enabled`, and
`override_skill` include them. `shadows` comes from the post-commit `resolve(target).effective`
winner; it is `[]` for a disabled or invalid row. `shadowedBy` is always `[]` at app scope.
`appsInScope` counts the caller (deleting rows excluded); `running` is 1 when the runtime state is
`running` or `starting`. `pendingRestart` is computed for every app-scope mutation; it is false for
a stopped app. Any enrichment failure leaves `ok:true`, a false/empty value, and
`warnings:["post_create_enrichment"]`.

`list_skills` returns:

```json
{
  "ok": true,
  "scope": "app",
  "target": { "projectId": "atlas", "appKey": "reviewer" },
  "effective": [],
  "rows": [],
  "disabled": []
}
```

with the same entry shapes as the master (`src/master/tools.ts:807-845`). `effective` entries carry
`source`/`shadows` and no content; `rows` carry the target-scope metadata and content-free stored
issue entries;
`disabled` is the service's hierarchy-wide tombstone list. `get_skill` returns
`{ok:true, skill:{...skillSummary, content, metadataRaw, references:[{path, content, size}],
storedIssues}}`.

### 5.4 Failure codes

| Code | Condition |
| --- | --- |
| `invalid_argument` | malformed or missing field, wrong type, non-positive id, non-boolean flag, empty update patch, immutable field, forbidden scope/target/confirmation argument, source already at the caller's app, visible global/project row passed to `update_skill`/`set_skill_enabled`, `enabled` on create |
| `replacement_confirmation_required` | `override_skill` would replace an exact target row and `confirm_replace` is missing or false; the message names the existing row and tells the model to pass `confirm_replace: true` (master parity, `src/master/tools.ts:948-953`) |
| `skill_exists` | `create_skill` same-scope duplicate; the message includes the existing id/updatedBy/updatedAt and no content |
| `invalid_skill` | `SkillValidationError` from create/update/override, field-prefixed when present; visible disabled/stored-issue/invalid source |
| `unknown_skill` | id missing; a sibling-app/other-project row; or, for `get_skill`, a wider global/project row that is not effective (disabled, invalid, or shadowed). `update_skill`/`set_skill_enabled` on a visible global/project row return `invalid_argument`; `override_skill` on a visible disabled/invalid source returns `invalid_skill` |
| `master_protected` | forged master identity or reserved master target (defense in depth; the HTTP branch normally prevents this) |
| `deletion_pending` | the caller's project or app is pending deletion during a mutation; the target guard runs before row inspection, so this wins over row errors |
| `unknown_project` / `unknown_app` | defense-in-depth target guard when the token's project/app row no longer exists (normally prevented by token verification) |
| `unavailable` | the app MCP context has no skills service (or no database); the tools are not advertised in this state |
| `internal_error` | only an unexpected/unmapped failure, including an audit insert failure (the transaction rolls back); validation, conflict, and skill errors map to their own codes before this |

## 6. Authorization and scope binding

The security boundary is the verified token plus the fixed target, not a model-supplied argument.
`verifyAgentToken` joins the token hash to an active `agent_tokens` row and its `apps` row, yielding
`{appId, projectId, appKey}` (`src/mcp/agent-tokens.ts:106-122`). `/internal/mcp` selects the master
branch first and only then builds the ordinary-app context
(`src/http/internal-mcp.ts:32-70`). `callAppSkillTool` uses `agent.projectId`/`agent.appKey`
directly; there is no code path that reads a target from `args`.

The chain-visible predicate used by the `get_skill` readable check and by override sources is:

```ts
row.scope === "global" ||
(row.scope === "project" && row.projectId === agent.projectId) ||
(row.scope === "app" && row.projectId === agent.projectId && row.appKey === agent.appKey)
```

The `get_skill` readable predicate is narrower than chain visibility: a row is readable when it is
the caller's own app-scope row (`isOwnAppSkillRow`) or when it is chain-visible **and** its id
appears in `skills.resolve(target).effective`. Global/project rows that are disabled, invalid, or
shadowed are not effective, so `get_skill` returns `unknown_skill` for them. A disabled wider row
that is the effective tombstone/stop appears in `list_skills.disabled`; a disabled wider row
shadowed by a narrower enabled winner may not be listed, and an invalid or shadowed wider row is
outside the app's inventory view. An own app-scope tombstone or invalid row remains readable so the app can
inspect its own state. This avoids the false claim that every chain row is already materialized into
the app's environment.

The writable predicate is the app clause alone. A sibling's app row is neither readable nor
writable. An effective global/project row is readable but not writable; `override_skill` is the
supported way to customize it, and it accepts any valid enabled chain-visible wider source,
including one that `get_skill` does not expose because it is shadowed.

For every mutation the target guard runs before and inside one synchronous `db.transaction`, before
any row load. Because the coordinator is a single Node process and better-sqlite3 is synchronous, a
deletion cannot commit between the in-transaction guard and the service write. The transaction
contains no `await`, so the whole mutation is atomic with respect to other coordinator writes.
`SkillService`'s own nested transaction is a savepoint of that outer transaction only when the
service and the outer transaction share the same connection (D5), so the audit insert and the
row/references commit or roll back together.

Error behavior is deliberate:

- Invisible sibling/other-project rows return `unknown_skill` for reads and writes, so an app
  cannot use sequential ids to discover their existence or bodies; disabled/invalid global/project
  rows also return `unknown_skill` for `get_skill`.
- A visible global/project row passed to `update_skill`/`set_skill_enabled` returns
  `invalid_argument` with the override guidance; the row is unchanged.
- A self-copy in `override_skill` returns `invalid_argument`; visibility is checked before source
  validation, so an invisible sibling source with stored issues returns `unknown_skill`.
- A mutation on a deleting project/app returns `deletion_pending` before any row inspection; reads
  still work.
- A missing skills service returns `unavailable`; the tool list omits the six tools in that state.

## 7. Audit and actor model

The actor is `app:<projectId>:<appKey>`. It is passed as the actor argument to
`SkillService.create/update/override` and stored in `skills.updated_by` (the service's only actor
field; `src/skills/service.ts:285-333`, `:335-377`, `:379-440`). The result's `updatedBy` exposes
the actor string, not a human name.

Every successful mutation writes exactly one event through `recordEvent` with `scope='app'` and one
of the four types in D5. The event is inserted in the same outer transaction as the skill write; a
failed insert rolls the write back and returns `internal_error`. This holds only when
`options.skills` is the service constructed over `options.db` (D5); the event insert and the nested
service transaction must use one connection. Reads write no events. Failed attempts (validation,
authorization, conflict, deletion) write no events, matching the master's success-only audit
policy.

The payload contains identifiers, field names, counts, and stored byte sizes, never the body,
description, reference content, or metadata values. The `events` table has no actor column
(`src/store/migrations.ts:102-108`), so `actor` is included in the payload. Because no production
code selects `events`, the new `scope='app'`/`app.skill_*` rows are additive audit records; existing
master and deletion tests keep their own scope/type filters.

## 8. Restart and materialization semantics

A mutation never restarts an agent. The response reports `pendingRestart` from
`InstanceManager.pendingRestart(agent.appId)`, which compares the stored applied hash with the
current settings+skills hash (`src/opencode/manager.ts:803-857`, `:889-899`). For a running app
whose effective set changed, `pending` is true with `settings_changed`; for a stopped app it is
false, and the next start computes the current hash and materializes the new set. For a row that is
disabled or invalid and therefore cannot win, the hash may not change and `pending` is false; the
report is truthful rather than optimistic.

The next start follows the existing order: probe into a coordinator-private staging root before
teardown, then apply after `runtime.delete` and before `runtime.ensure`
(`src/opencode/manager.ts:536-575`). `rebuildSkills` and `buildSkillDocument` are unchanged
(`src/skills/materialize.ts:203-342`), and the effective hash is unchanged
(`src/skills/service.ts:221-245`). The running agent's current context does not change; the app must
ask the operator (or the master) to restart it, or the operator uses the Skills page restart rail.
The app has no start/restart tool and cannot self-restart; the existing `assertNotMaster` guard on
the master's lifecycle tools continues to refuse the master itself
(`src/master/tools.ts:990-997`).

## 9. Security analysis

- **Prompt injection / self-modification.** An app can author content that its future self loads.
  This is not a new class of capability: the app can already write its repository `AGENTS.md` and
  `.opencode/skills`. DB skills are git-invisible but visible in the Skills inventory and audited;
  the blast radius is one app. See D9.
- **IDOR.** `get_skill` returns `unknown_skill` for rows outside the readable set (effective rows
  plus the caller's own app rows). The by-id mutation tools return `unknown_skill` for
  sibling/other-project rows, but they intentionally return `invalid_argument` (a visible
  global/project row passed to `update_skill`/`set_skill_enabled`) or `invalid_skill` (a visible
  disabled/invalid source passed to `override_skill`; a visible valid source is copied
  successfully). Sequential ids can therefore reveal the **existence** of a chain-visible wider
  row, though not its body: those rows are operator-visible global/project configuration, and the
  guarantee here is content confidentiality for **disabled or invalid** wider rows that `get_skill`
  hides, not an existence-hiding guarantee. Sibling and other-project rows remain `unknown_skill` on
  every path. A valid enabled wider source, including a shadowed one, can be
  copied via `override_skill` into the app's own scope and then read; that is the intended override
  path (D3), not a `get_skill` bypass, and it is not a confidentiality boundary for valid wider
  content. `list_skills` returns only the caller's chain.
- **Sibling escalation.** A sibling app row is not chain-visible and cannot be read, updated,
  disabled, or used as an override source. The target of every write is fixed to the caller's
  `(projectId, appKey)`; there is no target argument to tamper with.
- **Global/project escalation.** No app tool accepts `scope`, `project_id`, `app_key`, or
  `confirm_global`, and no write path targets global/project. Global/project rows are read-only for
  the app; `override_skill` copies a visible source into the app's own scope, leaving the source
  unchanged.
- **Operator-skill shadowing.** An app can override a global/project skill into its own scope or
  disable its own row, hiding the wider skill for itself. This is the existing hierarchy; other apps
  and the source row are unaffected. The operator inventory shows the override/tombstone and its
  origin, so the change is visible and reversible.
- **Token file writability.** The token file lives under the app's isolated agents directory
  (`<agents>/<project>/<app>/mcp-token`; `src/opencode/manager.ts:528`) and is mode `0600`
  (`src/mcp/agent-tokens.ts:137-150`). The app runs in its own container and can read or overwrite
  its own token; it cannot read a sibling's. A corrupted file only breaks that app's MCP access and
  is repaired by token reconciliation on restart. This stage adds no new credential and no broader
  token scope.
- **Audit gaps.** Every successful mutation is audited in-transaction with the actor and
  content-free sizes. Reads and failed attempts are not audited, matching the master. `updated_by`
  is last-writer-only, so a later app edit replaces the previous author string; the event history
  preserves the sequence of mutations.
- **Resource exhaustion.** The service limits (48k body, 20 references, 192k aggregate, 16k
  metadata) bound each write; the 1 MiB `/internal/mcp` limit is the transport bound, and a
  pathological fully `\uXXXX`-escaped request receives 413 before dispatch. There is no bulk
  operation and no new quota. `list_skills` is scope-bounded by the caller's chain, not
  size-bounded: a large chain can produce a large response, matching the master's unpaginated list.
  No new rate limit is introduced; this stage accepts the same response-size behavior as the
  existing human/master list.
- **Deletion race.** The target guard runs before and inside the synchronous transaction; a later
  deletion removes the app-scoped rows through the existing deletion service. Reads remain
  available during deletion, so an app can still diagnose its own row while the operator removes it.
- **Content leakage.** Mutation `skill` projections omit `storedIssues`, `metadataRaw`, and all
  body/reference content; update/set/override may add the top-level, content-free `storedIssues`
  issue entries, as the master does. `list_skills.rows` deliberately carries the content-free
  stored issue entries (master parity); no implementer should strip them. `get_skill` is
  intentionally content-bearing but is limited to the readable set: rows effective for the caller
  plus the caller's own app rows. Disabled, invalid, or shadowed global/project rows are not
  effective, so `get_skill` returns `unknown_skill` for them; a disabled wider row that is the
  effective tombstone/stop appears in `list_skills.disabled` (a disabled wider row shadowed by a
  narrower enabled winner may not), while an invalid or shadowed wider row is outside the app's
  inventory view.

## 10. Verification and acceptance

New-behavior checks fail on the current tree (the app surface has no skill tools) and pass after
the change. Regression or cited checks (the existing master conflict behavior in A4, the inherited
master transport test cited by A17, and the repo-wide checks in A15) stay green before and after;
they prove the new surface did not change existing behavior.

| ID | Check |
| --- | --- |
| A1 | Before: a non-master `tools/list` contains only `TOOLS` + `SSH_TOOLS`. After: it contains the six `APP_SKILL_TOOLS` names and the master list is unchanged; a context without `skills`/`db` still omits them. |
| A2 | Before: a `tools/call` named `create_skill` returns an unknown-tool error on the app surface. After: the schemas contain no `scope`/`project_id`/`app_key`/`confirm_global`; supplying any returns `invalid_argument` and creates no row; a service `SkillValidationError` (for example an invalid reference path) returns `invalid_skill`, never `internal_error`. |
| A3 | Before: no app-authored row exists. After: `create_skill` persists name/description/body/license/compatibility/metadata/references through `skills.get`, sets `updated_by = app:<projectId>:<appKey>`, and writes one `app.skill_created` event. |
| A4 | Before and after: the existing master same-scope conflict still returns `skill_exists` with existing-row context. New: an app duplicate returns `skill_exists` (not `internal_error`) with the existing id/updatedBy/updatedAt and creates no second row; the create handler explicitly catches `SkillConflictError` and uses the shared conflict helper. |
| A5 | Before: no app shadowing path exists. After: with a global and a project row of the same name, an app create wins in `resolve`, reports `shadows: ["global","project"]` (wide to narrow, as `resolve` returns it), `shadowedBy: []`, and `appsInScope` for the caller. |
| A6 | Before: `get_skill` is unknown on the app surface. After: it returns effective global/project rows and the caller's own app row (including its tombstone/invalid row); a sibling-app id, another project's id, and any wider global/project row that is not effective (disabled, invalid, or shadowed) return `unknown_skill` (not `internal_error`) with no body. |
| A7 | Before: no app update path exists. After: `update_skill` changes each mutable field on the caller's row; global, project, and sibling ids return `invalid_argument`/`unknown_skill` (not `internal_error`) and leave the rows byte-identical. |
| A8 | Before: no app enable/disable path exists. After: `set_skill_enabled(false)` creates a tombstone that hides a wider same-name row for the caller; a global or sibling id is rejected as `invalid_argument`/`unknown_skill` (not `internal_error`) and unchanged. |
| A9 | Before: no app override path exists. After: `override_skill` copies a global/project source into the caller's app; a self-copy returns `invalid_argument`; an exact target row without `confirm_replace` returns `replacement_confirmation_required` with the pass-`confirm_replace` message; a disabled/invalid/stored-issue visible source returns `invalid_skill`; an invisible sibling source returns `unknown_skill` even when it has stored issues (visibility is checked before source validation). |
| A10 | Before: no deletion guard exists on app skill writes. After: with `projects.deleting = 1` or `apps.deleting = 1`, every mutation returns `deletion_pending` before row inspection and writes nothing, including a mutation that names a global row or a sibling row (it does not return `invalid_argument`/`unknown_skill` first); `list_skills`/`get_skill` still work. |
| A11 | Before: no app skill events exist. After: each mutation writes exactly one `scope='app'` event with the actor/ids/sizes and no body/description/reference/metadata value; with the service built over the same `db` as the outer transaction, a forced event insert failure rolls back the row and references and returns `internal_error`. |
| A12 | Before: no app pending-restart report exists. After: a stub manager returning `{pending:true,reasons:["settings_changed"]}` makes the mutation result report it, and the manager's `ensure`/`restartIfRunning` spies are never called. |
| A13 | Before: any skill name on the app surface is an unknown tool. After: a context without `skills` does not advertise the six tools and a direct call returns `unavailable`; malformed ids/flags return `invalid_argument` and write nothing. |
| A14 | Before: no app skill projection exists. After: mutation and list responses contain a sentinel body nowhere (no `content`, reference `content`, or `metadataRaw`); the mutation `skill` projection omits `storedIssues` (update/set/override may add the content-free top-level issue entries); `list_skills.rows` carries content-free stored issue entries; `get_skill` returns the body and reference contents. |
| A15 | Before and after: the schema version is unchanged, `package.json` dependencies are unchanged, no new route is registered, master/human/materialization/hash/restart tests stay green, and the human `/api/skills*` route still returns `403 human_only` for an app token (`test/skills-http.test.ts:265-287`). |
| A16 | Before: `/internal/mcp` from a non-master app token advertises no skill tools. After: a real `handleInternalMcp` request (through `createHttpServer` or the handler) with `deps.db`, `deps.skills`, and `deps.manager` wired advertises and successfully calls a mutating skill tool (for example `create_skill`) end-to-end; the test asserts that the same `deps.skills` instance reaches the handler, that a stub `deps.manager.pendingRestart` is observed (manager forwarding), and that the master `tools/list` is unchanged. |
| A17 | Before: no app transport check exists. After: a maximum valid bundle through an app skill tool is accepted; a request body larger than the 1 MiB `/internal/mcp` bound returns `413 payload_too_large` before dispatch and creates no row (or the inherited master transport test is cited as covering the same route). |

## 11. Non-goals

- Deleting, reverting/discarding, renaming, or moving a skill; any app-created tombstone deletion.
- Writing global or project skills, or any sibling application's skills.
- Automatic restarts, self-restart, or a start/restart tool on the app surface.
- Changing the name, shadowing, override, uniqueness, or resolution rules.
- Changing human `/api/skills*` authorization, the human UI, or the 4 MiB human body limit.
- Changing `SkillService` validation, materialization, hashing, collision scanning, or deletion.
- A new HTTP route, a second registry, a schema migration, an npm dependency, per-app quotas, rate
  limits, pagination, bulk import/export, assignment, or version history.
- Extending the direct-DB `hanse mcp` fallback; managed apps use the remote bridge.

## 12. Open questions

None. The owner decisions close the four forks that would otherwise remain:

1. The app surface is the six master tools minus scope choice; deletion, revert/discard, and rename
   stay operator-only.
2. The target is always `{projectId, appKey}` from the verified token; no tool accepts `scope`,
   `project_id`, `app_key`, or `confirm_global`.
3. Name and hierarchy semantics are unchanged: same-scope duplicates conflict, wider same-name rows
   are shadowed or overridden with the existing `override_skill`, and no new uniqueness policy is
   invented.
4. Restart is manual: mutations report `pendingRestart`, nothing restarts automatically, and there
   is no self-restart tool.

## 13. Design review

Round 1 (`oracle`) returned `CHANGES REQUESTED`: no blockers, 7 major and 4 minor findings, plus
editorial nits. This revision resolves every finding; no finding was left open and no scope,
migration, dependency, or route was added.

| ID | Severity | Finding | Resolution | Changed in |
| --- | --- | --- | --- | --- |
| R1-1 | major | D8's generic error handling could surface validation/conflict errors as `internal_error`, contradicting D2's `toSkillFailure`. | Made the mapping explicit: `SkillValidationError` -> `invalid_skill`, `SkillConflictError` -> `skill_exists` (create catches it first for existing-row context), `SkillToolError` -> its code, only unexpected -> `internal_error`; the outer dispatcher catch is a last resort. Added assertions to A2/A4/A6. | D2 (`tool-errors.ts`), D8 step 4, §5.4, A2, A4, A6 |
| R1-2 | major | The audit-atomicity claim did not state that `options.skills` must be the same `SkillService` instance over `options.db`. | Stated the invariant in D5, §6, §7, and D8; production wiring cited; added A16 (end-to-end wiring and instance identity) and kept the A11 rollback test. | D5, D8, §6, §7, A11, A16 |
| R1-3 | major | AS9/A10 vs D3 did not specify whether `deletion_pending` wins over row-level `invalid_argument`/`unknown_skill`. | Stated that `assertSkillTarget` runs before any row load/inspection for every mutation, so the caller's deletion state wins; added the global-row-while-deleting case to A10. Reads stay available. | AS9, D3 (`Ordering`), §6, A10 |
| R1-4 | major | §9 said list rows never include `storedIssues`, contradicting D7/§5.3. | Split the statement: mutation `skill` projection omits issue entries; `list_skills.rows` carries content-free stored issue entries (master parity); `get_skill` carries them too. | §9 (`Content leakage`); §5.3 already stated the list-row behavior and was preserved |
| R1-5 | major | `skillVisibleAt` and the target guard duplicated service/master logic, risking drift. | Added `src/skills/access.ts` for neutral predicates and `src/skills/tool-access.ts` for shared throwing guards; `SkillService` now imports `skillVisibleAt` instead of keeping private `sourceVisibleAt`; master imports the shared `assertSkillTarget`/`skillRowTarget`/`isSameSkillTarget` and maps `SkillToolError` in `lifecycleError`; `runtimeState` moved to `src/store/runtime-state.ts` to remove the last duplicate. Module graph documented as acyclic. | D2 (module table and text) |
| R1-6 | major | Verification missed end-to-end `/internal/mcp` wiring. | Added A16 covering a real non-master `handleInternalMcp` request that advertises and calls a skill tool with `deps.db`/`deps.skills`/`deps.manager`, asserts the same service instance, and confirms the master list is unchanged. | §10 A16 |
| R1-7 | major | The `get_skill` content-leak justification was false: disabled/invalid global/project rows are not in the effective set. | Adopted the preferred policy: `get_skill` may read effective rows plus the caller's own app rows (so it can inspect its own tombstone/invalid row); disabled/invalid (and otherwise non-effective) global/project rows return `unknown_skill`. Updated the schema description, AS7, D3, D7, §6, §9, and A6. | AS7, D3, §5.2, D7, §6, §9, A6 |
| R1-8 | minor | The `override_skill` description said a source "at this application" was allowed, but self-copy is rejected. | Changed the description to "global or this application's project" and noted the self-copy rejection; aligned AS8, D4, and A9. | AS8, D4, §5.2, A9 |
| R1-9 | minor | `assertOverridableSource` is not a visibility check, and its ordering was unspecified. | Documented the order: target guard -> source load -> `skillVisibleAt` -> self-copy -> `assertOverridableSource`; an invisible sibling source with stored issues returns `unknown_skill` before validation. Added the ordering to A9. | D3, D4, A9 |
| R1-10 | minor | `confirm_replace` used `invalid_argument`, while the master returns `replacement_confirmation_required` (`src/master/tools.ts:948-953`). | Kept `replacement_confirmation_required` for parity, added it to the failure-code table with the pass-`confirm_replace: true` message, and updated D1/D4/A9. | D1, D4, §5.4, A9 |
| R1-11 | minor | The 1 MiB transport claim overstated the per-bundle bound. | Reworded: service limits are the per-bundle bound; the 1 MiB `/internal/mcp` limit is a transport bound; a fully `\uXXXX`-escaped request can exceed it and receives 413 before dispatch. | AS13, §3, D7, §9 |
| N1 | nit | "Each check fails on the current tree" is false for regression checks. | Reworded the §10 introduction: new-behavior checks fail before; the existing master conflict portion of A4 and the repo-wide checks in A15 stay green. | §10 introduction, A4, A15 |
| N2 | nit | The human-only `403` citation was wrong. | Corrected it to `test/skills-http.test.ts:265-287` (assertion at `:284`). | §3, A15 |
| N3 | nit | The problem statement overclaimed that skills were the only configuration surface closed to apps. | Reworded to "Skill management is a configuration surface still closed to apps". | §1 |
| N4 | nit | The create handler's conflict catch was implicit. | Stated that the create handler explicitly catches `SkillConflictError` and uses the shared `skillConflictError` for existing-row context; added it to A4. | D3, D4, A4 |
| N5 | nit | JSON Schema permits additional properties, so target/scope rejection must be at the handler boundary. | Stated explicitly in D8 and §5.2 that the handler, not JSON Schema, is authoritative and rejects `scope`/`project_id`/`app_key`/`confirm_global` (and immutable fields) before any work. | D8, §5.2 |

Round 2 (`oracle`) re-checked the round-1 resolutions. All R1 and N items were accepted as resolved;
the re-review raised one new major about the IDOR/existence claim and several minors/nits introduced
by the narrower `get_skill` policy. They are resolved here.

| ID | Severity | Finding | Resolution | Changed in |
| --- | --- | --- | --- | --- |
| R2-1 | major | §9 claimed sequential ids reveal neither existence nor content of disabled/invalid global/project rows, but `update_skill`/`set_skill_enabled` on a visible wider row return `invalid_argument` and `override_skill` on a visible disabled/invalid source returns `invalid_skill`, so existence is observable. | Narrowed the guarantee to content confidentiality for disabled/invalid wider rows; valid enabled wider rows (including shadowed ones) remain copyable/readable via `override_skill`; explicitly accepts existence disclosure via mutation errors; sibling/other-project rows remain `unknown_skill` on every path. No behavior change. | §9 (`IDOR`) |
| R2-2 | minor | A16 asserted `deps.skills` forwarding but not `deps.manager`. | A16 now requires a stub `deps.manager.pendingRestart` to be observed. | §10 A16 |
| R2-3 | minor | AS13 had no acceptance check. | Added A17 (maximum valid bundle accepted; >1 MiB request returns 413 before dispatch and writes nothing). | §10 A17 |
| R2-4 | minor | A14 said list rows "may" carry stored issue entries while §9 says they deliberately do. | A14 now says `list_skills.rows` carries content-free stored issue entries. | §10 A14 |
| R2-5 | minor | "`list_skills` is bounded by the caller's chain" conflated scope bounding with size bounding. | Clarified that `list_skills` is scope-bounded, not size-bounded; the stage accepts the same unpaginated response-size behavior as the master/human list. | §9 (`Resource exhaustion`) |
| R2-6 | minor | A valid, enabled, shadowed wider source can be copied via `override_skill` and then read, so `get_skill` is not a confidentiality boundary for valid wider content. | Stated this explicitly in §9 instead of implying `get_skill` hides it from every path. | §9 (`IDOR`) |
| R2-7 | nit | §6 said the chain-visible predicate is "used for mutations", while mutations use the own-app predicate. | Reworded to "used by the `get_skill` readable check and by override sources". | §6 |
| R2-8 | nit | §9 said "both mutation-by-id tools" but there are three (`update_skill`, `set_skill_enabled`, `override_skill`). | Replaced with the named tools and the exact error each returns. | §9 (`IDOR`) |
| R2-9 | nit | D2's moved-input range included `asOptionalString`, which stays master-specific. | Corrected the range to `:331-336` and noted `asOptionalString` stays in the master. | D2 (`tool-inputs.ts`) |

Round 3 (`oracle`) returned **PASS**. All R2 items were confirmed resolved. The remaining findings
were three non-blocking minor wording/precision clarifications (the confidentiality summary phrase,
§6's "reads and writes" wording, and the disabled-wider inventory claim) and six nits (A16's
"mutating" wording, "visible" in `invalid_skill`, "stored issue entries" terminology, the
`SkillSummary` wording, A17's regression classification, and the exhaustive error list). All are
folded in; they change no behavior, scope, requirement, or acceptance check.

No finding was deliberately left unaddressed. The only judgement call was R1-7, where the preferred
narrower policy was adopted rather than the documented-risk alternative; R2-1/R2-6 document its
residual limits.
