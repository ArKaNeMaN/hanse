# 0018 - Managed agent skills (global, project, application)

Status: implemented and verified; not deployed.

- Design: [`docs/design/agent-skills.md`](../design/agent-skills.md) (oracle round 7 PASS)
- Plan: [`docs/plans/0015-agent-skills.md`](../plans/0015-agent-skills.md) (momus round 2 PASS)
- ADR: [`docs/decisions/0011-managed-agent-skills.md`](../decisions/0011-managed-agent-skills.md)
- Verification report: [`docs/design/artifacts/skills/report.json`](../design/artifacts/skills/report.json)

## Problem

Operators had no way to define an Agent Skill once and give it to every isolated agent instance, or
to vary a skill by project or application. Skills had to be edited inside each app container or
committed into every repository. That broke the settings hierarchy, could not be audited, and was
lost when an app moved to a new image or a fresh agents root. opencode loads skills from its config
root once at process start, so Hanse needed a coordinator-owned registry with deterministic
materialization and explicit restart behavior.

## What was built

- **Data layer.** `src/store/migrations.ts` adds migration v12: a `skills` table keyed by
  `(scope, project_id, app_key, name)` with empty strings for wider scopes, DB `CHECK` constraints
  for scope shape, name syntax, description (1..1024), content (1..48000), `enabled`, a unique
  name per scope, the `skills_scope(project_id, app_key)` index, and no foreign key.
  `src/skills/service.ts` implements CRUD, create conflict (`409 skill_exists`), override,
  tombstone-aware resolution, hashing, preview, probe, and apply. `src/skills/validation.ts` owns
  the shared validators, and `src/skills/materialize.ts` owns the rebuild.
- **Resolution.** Effective skills resolve global -> project -> application by name; the narrowest
  row wins. A disabled narrower row is a tombstone that hides an inherited skill, and a narrower
  enabled row re-enables it. `EffectiveSkill` carries the winning row id, source scope, and shadowed
  scopes. An invalid stored name is excluded from every path (`resolve`, `hash`, `preview`,
  `probe`, `apply`) and reported as `invalid_skill_name`.
- **Materialization.** Each instance gets
  `<agents>/<project>/<app>/config/opencode/skills/<name>/SKILL.md`, with frontmatter generated from
  the row and the description encoded as a JSON string literal. The legacy `skill/` alias is
  emptied, every effective `<name>/` subtree is rebuilt without following symlinks, unexpected
  entries are removed, and the cache root is untouched. A first apply moves pre-existing entries
  outside the effective set to `config/opencode/skills-replaced/`, writes
  `.hanse-skills-initialized`, and reports `preserved`. Repository `.opencode/skills` is never
  modified.
- **Runtime.** `src/opencode/manager.ts` probes into a coordinator-private temporary directory
  outside the agent-writable tree before any teardown, then applies after `runtime.delete` and
  before `runtime.ensure`. A probe failure leaves a running
  container untouched; a post-teardown apply failure persists the instance as `error`. Skills join
  `settingsHashFor(snapshot, profile, skillsHash?)` only when the effective set is non-empty, so a
  zero-skill install keeps its previous hash. Effective-set changes mark affected apps restart
  required; restarts are never automatic.
- **Collision detection.** `src/skills/collisions.ts` scans repository `.opencode/skill(s)`, the
  per-instance `.claude` and `.agents` roots, the cache skills root, and `file://` plugin
  `<root>/skills`, excluding Hanse-owned config roots. It emits `skill_collision` and
  `skill_disabled_elsewhere` warnings, bounded to 20 with a `truncated` count.
- **Deletion.** `src/coordinator/deletion.ts` deletes app-scope rows in `#deleteAppRows` and all
  rows for a project in `#deleteProjectRows`, in the same transactions as settings and provider
  keys. Global rows (`project_id = ''`) survive.
- **HTTP and UI.** `src/http/skills.ts` adds `/skills`, `/projects/:id/skills`, and
  `/projects/:id/apps/:appKey/skills`, plus `/api/skills` CRUD. All routes are human-only; agent
  principals get `403`, mutations reject a cross-site `Origin`, and `return_to` is validated.
  Fragment saves (`x-hanse-fragment: skills`) return `{ok, surface, counts}` and are applied in
  place by `assets/skills.js`. `src/http/ui.ts` adds the scope-aware `Skills` nav item, and
  `src/http/handler.ts` allowlists `/assets/skills.js`. `src/cli/commands.ts` wires the service,
  agents root, and baseline plugins into the manager and HTTP deps.

## Verification

- `npm run lint`, `npm run typecheck`, `npm test`, and `npm run build` pass. The suite is 1480 tests
  in 94 files.
- New coverage: `test/skills-store.test.ts` (resolution, tombstones, validation edge cases,
  probe/apply hash equality, idempotent apply, first-apply preservation, planted nested files and
  symlinks, collision bounds, forged invalid-name rows, migration v12), `test/skills-http.test.ts`
  (routes, auth, origin, `return_to`, all three pages, API and fragment envelope, conflicts,
  escaping, repository/plugin warnings, dispatch order), `test/skills-asset.test.ts`, plus manager,
  deletion, migration, store, and HTTP additions.
- `node docs/design/skills-qa.mjs` reports PASS with 49 assertions and zero console/page errors.
  It captures global, project, and application pages at 1440 and 390 dark, the dialog at 1440 and
  390, and the editor at 1440. Screenshots and `report.json` are in
  `docs/design/artifacts/skills/`.
- Empirical `opencode debug skill` against a materialized root listed the managed names and
  descriptions (local 1.18.35; the deployment pins 1.19.3).
- Review gates: design review `oracle` completed seven rounds and passed; plan review `momus`
  completed two rounds and passed. Owner decisions were resolved autonomously and are recorded in
  design section 8.

## Deviations

The implementation follows the approved ordering, hash contract, collision roots, deletion
predicates, and HTTP/UI contract. A post-implementation security review added three hardening
changes:

- `probe` stages in a coordinator-private `mkdtemp` directory outside the agent-writable tree. The
  design's original `opencode/.hanse-skills-probe` could be raced by a running agent with a symlink
  swap, allowing a coordinator-user write outside the application root.
- `InstanceManager.ensure` refuses an application whose sanitized state segment
  (`sanitizeAppKey(projectId)/sanitizeAppKey(appKey)`) collides with a sibling, matching the
  deletion guard; otherwise two apps would share one skills root and effective set.
- `/api/skills*` routes accept up to 512 KiB request bodies while the general bound stays 64 KiB.
  This keeps a 48,000-character non-ASCII skill deliverable through a URL-encoded form; per-field
  limits are unchanged.

The security review found no XSS, SQL injection, auth bypass, CSRF, or redirect issue, and XSS,
SQL, auth, Origin, `return_to`, and path-segment checks were verified clean. No runtime dependency
was added and the repository `.opencode` model is unchanged.

## Accepted debt / residual risks

- Managed precedence is guaranteed only among Hanse rows. A same-named repository, plugin,
  `~/.claude`, `~/.agents`, or cache skill can still shadow a managed skill; Hanse detects and warns
  but does not override it, and opencode does not define a stable duplicate winner across roots.
- Single-file `SKILL.md` only. There are no bundles, scripts, binary assets, URL imports, per-agent
  allowlists, pagination, or skill version history/rollback.
- No hot reload. A running agent keeps its loaded set until an explicit restart.
- Skills are plaintext operator instructions in the coordinator DB, not a secret store.
- `pendingRestart` hashes the effective content per query, and first-deploy `skills-replaced/`
  directories can accumulate entries; neither is optimized or cleaned automatically.
- A coordinator DB restore older than the agents volume can leave materialized files loaded in a
  running container until the next start; this is the same restart boundary as any skill change.

## Next steps

Commit the stage. Deployment is separate and has not been performed from this checkout.
