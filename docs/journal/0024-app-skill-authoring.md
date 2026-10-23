# 0024 - App-agent skill authoring

- Date: 2026-10-23
- Stage: `0022-app-skill-authoring`
- Status: implemented and verified; all five gates pass; committed as one coherent stage commit
  after explicit owner instruction.
- Design: [`docs/design/app-skill-authoring.md`](../design/app-skill-authoring.md)
- Plan: [`docs/plans/0022-app-skill-authoring.md`](../plans/0022-app-skill-authoring.md)

## Why

Ordinary applications could write files in their own workspace but could not maintain the
coordinator-managed skill bundles their own next session loads. Skill management was human-only, and
the master tools were reachable only by the reserved master token. An app told to "keep this
procedure as a skill" had to stop and ask the operator to leave chat and open the Skills page.

The owner approved full master tool parity minus scope choice: app agents create, list, read,
update, enable/disable, and override **at their own application scope only**. Deletion,
revert/discard, and rename remain operator-only.

## What changed

- **App MCP surface.** `create_skill`, `list_skills`, `get_skill`, `update_skill`,
  `set_skill_enabled`, and `override_skill` are advertised and dispatched on the production app MCP
  path (`/internal/mcp` via the remote bridge) in addition to the existing handoff and SSH tools.
  The direct-DB `hanse mcp` fallback stays handoff-only.
- **Token-bound target.** Every call derives `{projectId, appKey}` from the verified
  `AgentTokenIdentity`. No tool accepts `scope`, `project_id`, `app_key`, or `confirm_global`; a
  master identity is refused `master_protected`.
- **Shared implementation.** One `SkillService` and the same slug/frontmatter/metadata/reference/
  size/uniqueness validation as the human UI and master. The skill helpers are now shared:
  `src/skills/tool-errors.ts`, `tool-inputs.ts`, `tool-projection.ts`, `access.ts`,
  `tool-access.ts`, plus `src/store/events.ts` and `src/store/runtime-state.ts`.
- **Reads.** `list_skills` returns the effective set and rows defined at the caller's app scope with
  no body or reference content. `get_skill` returns a full bundle only when the row is effective for
  the caller or is the caller's own app row; disabled, invalid, or shadowed wider rows return
  `unknown_skill`. Reads stay available while the caller is deleting.
- **Writes.** `create_skill` creates an enabled bundle at the caller's app scope; same-scope
  duplicates return `skill_exists` with existing-row context; wider same-name rows are shadowed.
  `update_skill` edits description/body/license/compatibility/metadata/references by id and rejects
  name, scope, target, and enabled. `set_skill_enabled` toggles a tombstone. `override_skill` copies
  an enabled, valid, chain-visible source into the caller's app, with self-copy rejection and
  `confirm_replace: true` for an existing target row.
- **Authorization.** `get_skill` uses the readable set (effective rows plus the caller's own app
  rows). `update_skill`/`set_skill_enabled` mutate only `scope='app'` rows at the caller's own
  `(projectId, appKey)`. `override_skill` accepts only a visible source and writes only the caller's
  app. Sibling and other-project rows return `unknown_skill` on every path.
- **Mutation precedence.** Boundary identity/forbidden-key checks, then argument type/parse, then
  `assertSkillTarget` before any row load, then row authorization, then the transaction. Deletion
  therefore wins over row-level errors for well-formed arguments.
- **Audit.** Every successful mutation stores `updated_by = app:<projectId>:<appKey>` and one
  content-free `scope='app'` event (`app.skill_created`, `app.skill_updated`, `app.skill_enabled`,
  or `app.skill_overridden`) in the same outer transaction as the row and references. An event
  insert failure rolls the write back and returns `internal_error`. Payloads carry ids, field names,
  flags, counts, and byte sizes only.
- **Restart.** Mutations report `pendingRestart` from `InstanceManager.pendingRestart`. No tool
  starts, restarts, or self-restarts an agent. The running agent picks up the new set at its next
  start.
- **Docs.** `docs/current-state.md` now describes the app surface, token-bound target, readable
  set, content-free projections, actor/audit, and manual restart.

## Decisions

- **Parity minus scope.** The app surface is the six master tools without scope choice. Delete,
  revert/discard, and rename remain operator-only.
- **Name semantics unchanged.** Same-scope uniqueness and wider shadowing/override stay
  `SkillService` behavior. No new name policy was invented.
- **Manual restart.** A mutation reports `pendingRestart`; nothing restarts automatically and there
  is no self-restart path.
- **Self-modification is accepted, bounded to one app.** An app can already persist instructions via
  its repository `AGENTS.md` and `.opencode/skills`. DB skills are git-invisible but visible in the
  Skills inventory and audited. The app cannot write global/project/sibling rows and cannot delete.
- **Readable set is narrower than visibility for `get_skill`.** Effective rows plus the caller's own
  app rows. Disabled/invalid wider content is not directly readable; a valid enabled shadowed wider
  source remains copyable via `override_skill` and then readable as the app's own copy.
- **One connection.** `options.skills` must be the `SkillService` built over `options.db`; the audit
  transaction and the nested service transaction share the same connection.
- **No migration, dependency, route, or human-UI/API change.** The stage reuses `skills`,
  `skill_references`, `events`, and `/internal/mcp`.

## Verification

- `npm run lint` - clean (255 files).
- `npm run typecheck` - clean.
- `npm test` - 107 files, 1,844 tests passed.
- `npm run build` - clean (tsc + Tailwind).
- `npm run check:sensitive` - passed (the unrelated in-flight `0021-slash-commands` chat QA artifact
  was sanitized during the stage; this stage did not modify it).

Acceptance evidence:

| Check | Evidence |
| --- | --- |
| A1 | `test/mcp-http.test.ts` `advertises app skill tools only with a fully wired skills context`, `publishes the six app skill schemas exactly as designed`, `omits app skill tools from a direct or manager-only dispatch context` |
| A2 | `test/app-skill-tools.test.ts` `rejects forbidden target arguments on every app tool`; invalid reference path -> `invalid_skill` in the same suite |
| A3 | `creates a full bundle, records the app actor, and writes one event` |
| A4 | `rejects a same-scope duplicate with existing-row context`; `test/master-tools.test.ts` conflict regression stays green |
| A5 | `shadows wider same-name rows and reports the caller scope` |
| A6 | `reads effective global/project rows and the caller's own app rows`; `reads the caller's own tombstone and invalid row`; `hides sibling, other-project, disabled, invalid, and shadowed wider rows` |
| A7 | `updates every mutable field and rejects immutable or foreign rows` |
| A8 | `creates a tombstone that hides a wider name and restores it on enable` |
| A9 | `copies a visible global or project source into the caller's app scope`; `rejects a self-copy`; `requires replacement confirmation and then replaces the app row`; `rejects a disabled source before replacement confirmation`; `rejects invalid visible sources and hides sibling sources` |
| A10 | `rejects writes while the caller project is deleting`; `rejects writes while the caller app is deleting` (both include `override_skill`) |
| A11 | `writes exactly one content-free app event per successful mutation`; `rolls back the skill and references when the event insert fails` |
| A12 | `reports pendingRestart without starting or restarting the app` |
| A13 | `rejects malformed read ids without writing`; `rejects malformed write arguments without writing`; unavailable-path assertions in `test/mcp-http.test.ts` |
| A14 | `returns content-free mutation projections and content-free stored issues`; `returns a content-free override projection`; `lists only the caller's chain and never echoes skill bodies` |
| A15 | full suite, typecheck, build, sensitive check; schema/dependency/route unchanged; `test/skills-http.test.ts:265-287` still proves app-token `403 human_only` |
| A16 | `test/mcp-http.test.ts` `wires app skill tools end-to-end through the shared deps instances` (same `deps.skills` spy, `pendingRestart("p:a")`, master list unchanged) |
| A17 | inherited `test/master-http.test.ts:246-313` transport test remains green |

## Residual risks

- An app can author instructions its future self loads. This is accepted and bounded to one app; it
  is audited and visible in the Skills inventory, but it is not git-visible like a repository skill.
- An app can shadow or locally disable an operator-managed global/project skill for itself; a valid
  enabled shadowed wider source can be copied via `override_skill` and then read as its own copy.
- Mutation errors can reveal the **existence** of a chain-visible wider row (`invalid_argument` for
  a visible global/project row, `invalid_skill` for a visible disabled/invalid source). Content of
  disabled/invalid wider rows remains unavailable through `get_skill`; sibling/other-project rows
  remain `unknown_skill`.
- An app-scope row authored by the operator belongs to the app and can be updated, disabled, or
  replaced by the app after the normal replacement rules. Ownership is by target, not by author.
- `list_skills` is unpaginated and not size-bounded; no per-app quota or rate limit was added.
- There is no delete, revert/discard, or rename tool for app or master agents; the operator must use
  the Skills page.

## Open threads

- The working tree still contains uncommitted `0021-slash-commands` changes in shared docs/index
  files. They were excluded from this stage's commit.
- Committed as one coherent stage commit after explicit owner instruction; not pushed.
